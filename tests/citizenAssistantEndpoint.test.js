const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");
const {
  CitizenAssistantError,
  createCitizenAssistantService
} = require("../services/citizenAssistantService");
const { createCitizenAssistantRouter } = require("../routes/citizenAssistantRoutes");
const { buildRequireMobileSession } = require("../middleware/mobileSessionAuth");

const columns = [
  "barangay_name", "entry_type", "validation_status", "grand_total",
  "biodegradable_subtotal", "recyclable_subtotal", "residual_subtotal", "special_subtotal"
];

function fakeDatabase({ user = { id: 7, role: "citizen", status: "active", barangay: "Brgy. Bula" },
  fields = columns, totals = { recordCount: 2, totalKg: "12.50", biodegradableKg: "4.00",
    recyclableKg: "3.50", residualKg: "4.00", specialKg: "1.00" } } = {}) {
  const queries = [];
  return {
    queries,
    queryReadOnly(sql, parameters, callback) {
      queries.push({ sql, parameters });
      if (/FROM users\b/.test(sql)) return callback(null, user ? [user] : []);
      if (/^SHOW COLUMNS FROM validated_waste_records$/.test(sql)) {
        return callback(null, fields.map((Field) => ({ Field })));
      }
      if (/FROM validated_waste_records\b/.test(sql)) return callback(null, [totals]);
      return callback(new Error("Unexpected SQL"));
    }
  };
}

const staticCases = [
  ["How do I segregate plastic bottles?", "WASTE_SEGREGATION", "en"],
  ["Saan ko itatapon ang plastic bottle?", "WASTE_SEGREGATION", "fil"],
  ["Asa nako ibutang ang plastic bottle?", "WASTE_SEGREGATION", "ceb"],
  ["Paano mag report ng complaint?", "COMPLAINT_HELP", "fil"],
  ["Unsaon pag report ug complaint?", "COMPLAINT_HELP", "ceb"],
  ["Paano gamitin ang Waste Scan?", "WASTE_SCAN_HELP", "fil"],
  ["What can you do?", "GENERAL_HELP", "en"],
  ["Paano gamitin ang app?", "GENERAL_HELP", "fil"],
  ["Unsaon paggamit sa app?", "GENERAL_HELP", "ceb"],
  ["What is the mayor's phone number?", "UNKNOWN", "en"]
];

for (const [message, intent, language] of staticCases) {
  test(`safe static answer: ${message}`, async () => {
    const database = fakeDatabase();
    const response = await createCitizenAssistantService(database).ask({ message, userId: 7 });
    assert.equal(response.success, true);
    assert.equal(response.intent, intent);
    assert.equal(response.language, language);
    assert.ok(response.answer);
    assert.equal(database.queries.length, 1);
    assert.deepEqual(database.queries[0].parameters, [7]);
    assert.ok(!/phone number|\d{7,}/i.test(response.answer));
  });
}

const totalCases = [
  ["How much waste has my barangay recorded?", "en", null],
  ["Ilang kilo na ang basura sa barangay namin?", "fil", null],
  ["Pila na ka kilo ang basura sa among barangay?", "ceb", null],
  ["Pila ang total recyclable waste sa barangay namin?", "mixed", "Recyclable"]
];

for (const [message, language, category] of totalCases) {
  test(`trusted total: ${message}`, async () => {
    const database = fakeDatabase();
    const response = await createCitizenAssistantService(database).ask({ message, userId: 7 });
    assert.equal(response.intent, "BARANGAY_WASTE_TOTAL");
    assert.equal(response.language, language);
    assert.equal(response.category || null, category);
    assert.deepEqual(response.data, {
      barangay: "Brgy. Bula", recordCount: 2, totalKg: 12.5,
      biodegradableKg: 4, recyclableKg: 3.5, residualKg: 4, specialKg: 1
    });
    assert.match(response.answer, category ? /3\.50 kg/ : /12\.50 kg/);
    assert.equal(database.queries.length, 3);
    assert.deepEqual(database.queries[0].parameters, [7]);
    assert.deepEqual(database.queries[2].parameters, ["bula"]);
    assert.match(database.queries[2].sql, /FROM validated_waste_records/);
    assert.doesNotMatch(database.queries[2].sql, /pending_waste_records/);
    assert.match(database.queries[2].sql, /validation_status/);
    assert.match(database.queries[2].sql, /entry_type/);
    assert.match(database.queries[2].sql, /SUM\(COALESCE\(grand_total, 0\)\)/);
  });
}

test("no validated records gives a localized answer without fake totals", async () => {
  for (const [message, phrase] of [
    [totalCases[0][0], "No validated waste records"],
    [totalCases[1][0], "Walang nahanap"],
    [totalCases[2][0], "Walay nakit-an"]
  ]) {
    const response = await createCitizenAssistantService(fakeDatabase({ totals: { recordCount: 0 } }))
      .ask({ message, userId: 7 });
    assert.match(response.answer, new RegExp(phrase));
    assert.deepEqual(response.data, { barangay: "Brgy. Bula", recordCount: 0 });
  }
});

test("missing category column never fabricates a requested category total", async () => {
  const database = fakeDatabase({
    fields: ["barangay_name", "grand_total"],
    totals: { recordCount: 2, totalKg: "12.50" }
  });
  const response = await createCitizenAssistantService(database)
    .ask({ message: totalCases[3][0], userId: 7 });
  assert.equal(response.data.recyclableKg, undefined);
  assert.doesNotMatch(response.answer, /12\.50/);
  assert.doesNotMatch(database.queries[2].sql, /recyclable_subtotal/);
});

test("legacy category-only schema calculates grand total from all four stored subtotals", async () => {
  const database = fakeDatabase({
    fields: ["barangay_name", "biodegradable_subtotal", "recyclable_subtotal", "residual_subtotal", "special_subtotal"],
    totals: { recordCount: 2, totalKg: "12.50", biodegradableKg: "4.00",
      recyclableKg: "3.50", residualKg: "4.00", specialKg: "1.00" }
  });
  const response = await createCitizenAssistantService(database)
    .ask({ message: totalCases[0][0], userId: 7 });
  assert.equal(response.data.totalKg, 12.5);
  assert.match(database.queries[2].sql, /COALESCE\(biodegradable_subtotal, 0\) \+ COALESCE\(recyclable_subtotal, 0\)/);
  assert.doesNotMatch(database.queries[2].sql, /validation_status/);
});

test("missing barangay column and non-citizen account are rejected safely", async () => {
  await assert.rejects(
    createCitizenAssistantService(fakeDatabase({ fields: ["grand_total"] }))
      .ask({ message: totalCases[0][0], userId: 7 }),
    (error) => error instanceof CitizenAssistantError && error.statusCode === 503
  );
  await assert.rejects(
    createCitizenAssistantService(fakeDatabase({ user: { id: 7, role: "enforcer", status: "active", barangay: "Bula" } }))
      .ask({ message: totalCases[0][0], userId: 7 }),
    (error) => error instanceof CitizenAssistantError && error.statusCode === 403
  );
});

test("segregation example follows repository plastic-bottle condition rule", async () => {
  const service = createCitizenAssistantService(fakeDatabase());
  const clean = await service.ask({ message: "Saan ko itatapon ang plastic bottle?", userId: 7 });
  assert.match(clean.answer, /malinis/);
  const dirty = await service.ask({ message: "Saan ko itatapon ang dirty plastic bottle?", userId: 7 });
  assert.doesNotMatch(dirty.answer, /Maaaring recyclable ang malinis/);
});

test("unsupported official data is never mistaken for a waste total or bin question", async () => {
  const service = createCitizenAssistantService(fakeDatabase());
  for (const message of ["How much is the waste budget?", "Where is the mayor's office?"]) {
    const response = await service.ask({ message, userId: 7 });
    assert.equal(response.intent, "UNKNOWN");
    assert.doesNotMatch(response.answer, /\d/);
  }
});

test("nonexistent citizen and missing stored barangay fail safely", async () => {
  await assert.rejects(
    createCitizenAssistantService(fakeDatabase({ user: null })).ask({ message: totalCases[0][0], userId: 7 }),
    (error) => error instanceof CitizenAssistantError && error.statusCode === 404
  );
  await assert.rejects(
    createCitizenAssistantService(fakeDatabase({ user: { id: 7, role: "citizen", status: "active", barangay: "" } }))
      .ask({ message: totalCases[0][0], userId: 7 }),
    (error) => error instanceof CitizenAssistantError && error.statusCode === 422
  );
  const nullBarangayDatabase = fakeDatabase({
    user: { id: 7, role: "citizen", status: "active", barangay: null }
  });
  await assert.rejects(
    createCitizenAssistantService(nullBarangayDatabase)
      .ask({ message: totalCases[0][0], userId: 7 }),
    (error) => error instanceof CitizenAssistantError
      && error.statusCode === 422
      && error.code === "ASSISTANT_BARANGAY_REQUIRED"
  );
  assert.equal(nullBarangayDatabase.queries.length, 1);
});

async function withTestServer(assistantService, callback) {
  const app = express();
  app.use(express.json());
  app.use("/api/citizen-assistant", createCitizenAssistantRouter({
    assistantService,
    authenticate(req, res, next) { req.mobileUser = { id: 7 }; next(); }
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/citizen-assistant/ask`;
  try { await callback(url); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("POST route validates message, user ID, session binding, and safe 404", async () => {
  await withTestServer(createCitizenAssistantService(fakeDatabase({ user: null })), async (url) => {
    async function post(body) {
      const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    }
    assert.equal((await post({ userId: 7 })).status, 400);
    assert.equal((await post({ message: "help" })).status, 400);
    assert.equal((await post({ userId: true, message: "help" })).status, 400);
    assert.equal((await post({ userId: 8, message: "help" })).status, 403);
    const missingUser = await post({ userId: 7, message: "How much waste has my barangay recorded?" });
    assert.equal(missingUser.status, 404);
    assert.equal(missingUser.body.code, "ASSISTANT_USER_NOT_FOUND");
    assert.equal(missingUser.body.stack, undefined);
  });
});

test("POST route returns a trusted answer and no-store header", async () => {
  await withTestServer(createCitizenAssistantService(fakeDatabase()), async (url) => {
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: 7, message: totalCases[3][0], barangay: "wrong-client-value" })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.data.barangay, "Brgy. Bula");
    assert.equal(body.data.recyclableKg, 3.5);
  });
});

async function withDashboardServer(database, callback) {
  const app = express();
  const authenticate = buildRequireMobileSession({
    async authenticateMobileSession(token) {
      if (token === "e".repeat(43)) {
        throw { statusCode: 401, code: "MOBILE_SESSION_INVALID", message: "Mobile authentication is required." };
      }
      return { id: 1, user: { id: 7 }, deviceId: "test", expiresAt: "2099-01-01" };
    }
  });
  app.use("/api/citizen-assistant", createCitizenAssistantRouter({
    assistantService: createCitizenAssistantService(database), authenticate
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/citizen-assistant/dashboard-summary`;
  try { await callback(url); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("dashboard summary requires a valid mobile Bearer session", async () => {
  const database = fakeDatabase();
  await withDashboardServer(database, async (url) => {
    const missing = await fetch(url);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).code, "MOBILE_SESSION_REQUIRED");
    const expired = await fetch(url, { headers: { Authorization: `Bearer ${"e".repeat(43)}` } });
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).code, "MOBILE_SESSION_INVALID");
  });
  assert.equal(database.queries.length, 0);
});

test("dashboard summary uses only the authenticated citizen's barangay and validated records", async () => {
  const database = fakeDatabase();
  await withDashboardServer(database, async (url) => {
    const response = await fetch(`${url}?barangay=Wrong&userId=999`, {
      headers: { Authorization: `Bearer ${"v".repeat(43)}` }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual((await response.json()).data, {
      barangay: "Brgy. Bula", recordCount: 2, totalKg: 12.5,
      biodegradableKg: 4, recyclableKg: 3.5, residualKg: 4, specialKg: 1
    });
  });
  assert.deepEqual(database.queries[0].parameters, [7]);
  assert.deepEqual(database.queries[2].parameters, ["bula"]);
  assert.match(database.queries[2].sql, /FROM validated_waste_records/);
  assert.match(database.queries[2].sql, /validation_status/);
  assert.match(database.queries[2].sql, /LOWER\(TRIM\(entry_type\)\) = 'barangay'/);
  assert.doesNotMatch(database.queries[2].sql, /pending_waste_records/);
});

test("dashboard summary distinguishes zero validated records from missing barangay or columns", async () => {
  await withDashboardServer(fakeDatabase({ totals: { recordCount: 0 } }), async (url) => {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${"v".repeat(43)}` } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, {
      barangay: "Brgy. Bula", recordCount: 0, totalKg: 0,
      biodegradableKg: 0, recyclableKg: 0, residualKg: 0, specialKg: 0
    });
  });
  await withDashboardServer(fakeDatabase({ user: { id: 7, role: "citizen", status: "active", barangay: null } }), async (url) => {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${"v".repeat(43)}` } });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, "ASSISTANT_BARANGAY_REQUIRED");
  });
  await withDashboardServer(fakeDatabase({ fields: ["barangay_name", "grand_total"], totals: { recordCount: 1, totalKg: 2 } }), async (url) => {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${"v".repeat(43)}` } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "DASHBOARD_TOTALS_UNAVAILABLE");
  });
});
