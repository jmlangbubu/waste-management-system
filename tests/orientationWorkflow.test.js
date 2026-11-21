const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const originalLoad = Module._load;
const routes = [];
const record = {
  id: 17,
  purpose: "SWM Orientation & Clearance",
  preferred_date: "2026-09-27",
  created_at: "2026-09-26 14:00:00",
  status: "approved",
  orientation_status: "pending_orientation",
  orientation_score: null,
  orientation_started_at: null,
  orientation_completed_at: null,
  orientation_completed: 0,
  orientation_token: "ORI-test"
};
let role = "personnel";
let updates = 0;
let databaseToday = "2026-09-27";
let databaseNow = "2026-09-27 02:00:00";
let reconciliationSql = "";
let schedulingEnabled = true;
let applicationInstants = ["2026-09-27T02:00:00Z"];
let clockReads = 0;
const queryCalls = [];
// Only the route VM sees this clock. Node's global Date and the host timezone stay intact.
class ApplicationDate extends Date {
  constructor(...args) {
    if (args.length) super(...args);
    else super(applicationInstants[Math.min(clockReads++, applicationInstants.length - 1)]);
  }
  static now() { return Date.parse(applicationInstants[Math.min(clockReads, applicationInstants.length - 1)]); }
}
function boundValue(sql, params, fragment) {
  const position = sql.indexOf(fragment);
  assert.notEqual(position, -1, `Missing SQL binding: ${fragment}`);
  return params[(sql.slice(0, position).match(/\?/g) || []).length];
}

function reset(state = "pending_orientation") {
  applicationInstants = ["2026-09-27T02:00:00Z"];
  clockReads = 0; schedulingEnabled = true;
  databaseToday = "2026-09-27"; databaseNow = "2026-09-27 02:00:00";
  queryCalls.length = 0; reconciliationSql = "";
  Object.assign(record, {
    status: "approved", purpose: "SWM Orientation & Clearance", preferred_date: "2026-09-27",
    orientation_status: state, orientation_score: null,
    orientation_started_at: null, orientation_completed_at: null,
    orientation_completed: 0, appointment_revision: 0, updated_at: databaseNow
  });
  role = "personnel";
  updates = 0;
}

const db = {
  query(sql, params, callback) {
    if (typeof params === "function") { callback = params; params = []; }
    params = Array.from(params);
    queryCalls.push({ sql, params });
    assert.equal(params.length, (sql.match(/\?/g) || []).length, "SQL placeholder count");
    if (/^\s*SELECT/i.test(sql)) {
      if (sql.includes("preferred_date >= ?") || sql.includes("preferred_date < ?")) {
        const active = sql.includes("preferred_date >= ?");
        const today = boundValue(sql, params, active ? "preferred_date >= ?" : "preferred_date < ?");
        assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
        const status = String(record.status || "pending").trim().toLowerCase() || "pending";
        const orientation = String(record.orientation_status || "").trim().toLowerCase();
        const terminal = record.purpose === "SWM Orientation & Clearance" &&
          (["completed_orientation", "completed", "no_show", "no-show", "noshow", "incomplete_orientation", "incomplete"].includes(orientation) ||
           record.orientation_completed === 1 || record.orientation_completed_at != null);
        const included = active
          ? ["pending", "approved", "rescheduled"].includes(status) && record.preferred_date >= today && !terminal
          : ["rejected", "cancelled", "completed"].includes(status) || terminal ||
            ["approved", "rescheduled"].includes(status) && record.preferred_date < today &&
            !(record.purpose === "SWM Orientation & Clearance" && ["failed_orientation", "ready_for_retake"].includes(orientation));
        const row = { ...record };
        if (!active && terminal) row.status = ["no_show", "no-show", "noshow"].includes(orientation) ? "no_show"
          : ["incomplete_orientation", "incomplete"].includes(orientation) ? "incomplete" : "completed";
        return callback(null, included ? [row] : []);
      }
      if (sql.includes("WHERE purpose = 'SWM Orientation & Clearance'")) {
        return callback(null, [{ ...record }]);
      }
      return callback(null, sql.includes("orientation_token = ?")
        ? (params[0] === record.orientation_token ? [{ ...record }] : [])
        : (Number(params[0]) === record.id ? [{ ...record }] : []));
    }
    if (!/^\s*UPDATE appointments/i.test(sql)) throw new Error(`Unexpected query: ${sql}`);
    if (sql.includes("orientation_status = 'no_show'")) {
      reconciliationSql = sql;
      const today = boundValue(sql, params, "preferred_date < ?");
      assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
      const eligible = boundValue(sql, params, "WHERE purpose = ?") === record.purpose && String(record.status).trim().toLowerCase() === "approved" &&
        record.preferred_date < today && record.orientation_started_at == null &&
        record.orientation_completed_at == null && !record.orientation_completed &&
        (String(record.orientation_status || "").trim().toLowerCase() || "approved") === "approved";
      if (eligible) {
        record.orientation_status = "no_show";
        updates += 1; record.appointment_revision++; record.updated_at = databaseNow;
      }
      return callback(null, { affectedRows: eligible ? 1 : 0 });
    }
    let eligible = false;
    if (sql.includes("orientation_token = ?")) {
      eligible = boundValue(sql, params, "WHERE orientation_token = ?") === record.orientation_token &&
        boundValue(sql, params, "purpose = ?") === record.purpose && record.status === "approved" &&
        ["approved", "pending_orientation", "ready_for_retake"].includes(record.orientation_status);
    } else {
      eligible = Number(boundValue(sql, params, "WHERE id = ?")) === record.id && boundValue(sql, params, "purpose = ?") === record.purpose &&
        record.status === "approved";
      if (sql.includes("orientation_status = 'ready_for_retake'")) {
        eligible &&= record.orientation_status === "failed_orientation";
      } else {
        eligible &&= record.orientation_status === boundValue(sql, params, "COALESCE(orientation_status, 'approved') = ?");
      }
    }
    if (!eligible) return callback(null, { affectedRows: 0 });
    updates += 1; record.appointment_revision++; record.updated_at = databaseNow;
    if (sql.includes("orientation_status = 'ready_for_retake'")) {
      record.orientation_status = "ready_for_retake";
    } else if (sql.includes("orientation_status = 'incomplete_orientation'")) {
      record.orientation_status = "incomplete_orientation";
      record.orientation_completed = 0;
      record.orientation_completed_at = boundValue(sql, params, "orientation_completed_at = ?");
    } else if (sql.includes("orientation_status = 'completed_orientation'")) {
      record.status = "completed";
      record.orientation_status = "completed_orientation";
      record.orientation_score = boundValue(sql, params, "orientation_score = ?");
      record.orientation_completed = 1;
      record.orientation_completed_at = boundValue(sql, params, "orientation_completed_at = ?");
    } else if (sql.includes("orientation_status = 'failed_orientation'")) {
      record.orientation_status = "failed_orientation";
      record.orientation_score = boundValue(sql, params, "orientation_score = ?");
      record.orientation_completed = 0;
      record.orientation_completed_at = null;
    } else if (sql.includes("orientation_status = 'pending_orientation'")) {
      record.orientation_status = "pending_orientation";
      if (record.orientation_started_at == null) record.orientation_started_at = boundValue(sql, params, "orientation_started_at = COALESCE(orientation_started_at, ?)");
    }
    return callback(null, { affectedRows: 1 });
  }
};

Module._load = function mockedLoad(request, parent, isMain) {
  const parentPath = parent?.filename.replace(/\\/g, "/") || "";
  if (request === "express" && parentPath.endsWith("routes/appointmentRoutes.js")) {
    return { Router: () => Object.fromEntries(["get", "post", "put", "delete"].map((method) => [
      method, (path, ...handlers) => routes.push({ method, path, handlers: handlers.flat() })
    ])) };
  }
  if (request === "../config/db" && parentPath.endsWith("routes/appointmentRoutes.js")) return db;
  if (request === "resend" && parentPath.endsWith("routes/appointmentRoutes.js")) {
    return { Resend: class Resend {} };
  }
  if (request === "qrcode" && parentPath.endsWith("routes/appointmentRoutes.js")) return {};
  // This suite models an enabled, verified deployment. Real scheduling/readiness
  // behavior and maintenance denial are exercised by appointmentScheduling/Security.
  if (request === "../services/appointmentSchedulingService" && parentPath.endsWith("routes/appointmentRoutes.js")) {
    return { AppointmentSchedulingService: class {
      enabled() { return schedulingEnabled; }
      async ready() { if (!schedulingEnabled) throw Object.assign(new Error("Synthetic maintenance"), { statusCode: 503 }); }
    } };
  }
  if (request === "../services/webSessionService" && parentPath.endsWith("middleware/webSessionAuth.js")) {
    return {
      validateSession: async (token) => {
        if (token !== "valid") throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
        return { id: 1, user: { id: 2, role }, csrfTokenHash: "hash:csrf" };
      },
      hashOpaqueToken: (value) => `hash:${value}`,
      normalizeWebRole: (value) => String(value || "").toLowerCase()
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
try {
  const routeFile = path.resolve(__dirname, "../routes/appointmentRoutes.js");
  vm.runInNewContext(fs.readFileSync(routeFile, "utf8"), {
    require: Module.createRequire(routeFile), module: { exports: {} }, console,
    Date: ApplicationDate, process: { env: {} }, Buffer
  }, { filename: routeFile });
} finally { Module._load = originalLoad; }

async function invoke(method, path, options = {}) {
  const route = routes.find((entry) => entry.method === method && entry.path === path);
  assert.ok(route, `Route ${method} ${path} exists`);
  if (path === "/active" || path === "/history" || path === "/orientation" || path === "/:id/generate-orientation-qr") role = "super_admin";
  const req = {
    method: method.toUpperCase(),
    params: { id: String(record.id), token: record.orientation_token },
    body: options.body || {},
    headers: {
      cookie: `${options.auth === false ? "" : "wmo_admin_session=valid; "}wmo_admin_csrf=csrf`,
      "x-csrf-token": options.csrf === false ? "bad" : "csrf"
    }
  };
  const res = {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  for (const handler of route.handlers) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return res;
}

test("failed score is stored without completion or certificate eligibility", async () => {
  reset();
  const res = await invoke("put", "/orientation/complete/:token", { body: { score: 7 } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.passed, false);
  assert.equal(res.body.certificate_eligible, false);
  assert.equal(record.orientation_status, "failed_orientation");
  assert.equal(record.orientation_score, 7);
  assert.equal(record.status, "approved");
  assert.equal(record.orientation_completed_at, null);
});

test("failed orientation cannot submit again until WMO allows a retake", async () => {
  reset("failed_orientation");
  assert.equal((await invoke("put", "/orientation/complete/:token", { body: { score: 10 } })).statusCode, 409);
  assert.equal((await invoke("put", "/orientation/start/:token")).statusCode, 409);
  assert.equal(record.orientation_status, "failed_orientation");
});

test("repeating the same failed submission is safe and does not overwrite the attempt", async () => {
  reset("failed_orientation");
  record.orientation_score = 3;
  const result = await invoke("put", "/orientation/complete/:token", { body: { score: 3 } });
  assert.equal(result.body.passed, false);
  assert.equal(result.body.changed, false);
  assert.equal(updates, 0);
});

test("Allow Retake preserves failed score, permits one new attempt, and is idempotent", async () => {
  reset("failed_orientation");
  record.orientation_score = 3;
  const first = await invoke("post", "/orientation/:id/allow-retake");
  const second = await invoke("post", "/orientation/:id/allow-retake");
  assert.equal(first.body.orientation_status, "ready_for_retake");
  assert.equal(second.body.changed, false);
  assert.equal(record.orientation_score, 3);
  assert.equal(updates, 1);
  assert.equal((await invoke("put", "/orientation/start/:token")).statusCode, 200);
  assert.equal(record.orientation_status, "pending_orientation");
});

test("Completed and Incomplete orientations cannot be reopened", async () => {
  for (const state of ["completed_orientation", "incomplete_orientation"]) {
    reset(state);
    assert.equal((await invoke("post", "/orientation/:id/allow-retake")).statusCode, 409);
    assert.equal(updates, 0);
  }
});

test("Mark as Incomplete is terminal, idempotent, and preserves last score", async () => {
  reset("failed_orientation");
  record.orientation_score = 2;
  const first = await invoke("post", "/orientation/:id/mark-incomplete");
  const second = await invoke("post", "/orientation/:id/mark-incomplete");
  assert.equal(first.body.orientation_status, "incomplete_orientation");
  assert.equal(second.body.changed, false);
  assert.equal(record.orientation_score, 2);
  assert.equal(record.orientation_completed, 0);
  assert.ok(record.orientation_completed_at);
  assert.equal(updates, 1);
});

test("Completed orientation cannot be marked incomplete", async () => {
  reset("completed_orientation");
  assert.equal((await invoke("post", "/orientation/:id/mark-incomplete")).statusCode, 409);
  assert.equal(updates, 0);
});

test("passing Android score completes once, with preserved score and timestamp", async () => {
  reset();
  const first = await invoke("put", "/orientation/complete/:token", { body: { score: 8 } });
  const second = await invoke("put", "/orientation/complete/:token", { body: { score: 8 } });
  assert.equal(first.body.passed, true);
  assert.equal(first.body.certificate_eligible, true);
  assert.equal(second.body.changed, false);
  assert.equal(record.orientation_status, "completed_orientation");
  assert.equal(record.orientation_score, 8);
  assert.ok(record.orientation_completed_at);
  assert.equal(updates, 1);
});

test("web quiz uses its existing 4-of-5 threshold; invalid scores are rejected", async () => {
  const answers = require("../utils/orientationWorkflow").WEB_ORIENTATION_ANSWERS;
  reset();
  assert.equal((await invoke("put", "/orientation/complete/:token", {
    body: { score: 3, total_questions: 5, answers: [...answers.slice(0, 3), null, null] }
  })).body.passed, false);
  reset();
  assert.equal((await invoke("put", "/orientation/complete/:token", {
    body: { score: 4, total_questions: 5, answers: [...answers.slice(0, 4), null] }
  })).body.passed, true);
  reset();
  assert.equal((await invoke("put", "/orientation/complete/:token", {
    body: { score: 4, total_questions: 5, answers: [null, null, null, null, null] }
  })).statusCode, 400);
  assert.equal((await invoke("put", "/orientation/complete/:token", { body: { score: null } })).statusCode, 400);
});

test("WMO mutations require authentication, correct role, and CSRF", async () => {
  reset("failed_orientation");
  for (const action of ["/orientation/:id/allow-retake", "/orientation/:id/mark-incomplete"]) {
    assert.equal((await invoke("post", action, { auth: false })).statusCode, 401);
    role = "citizen";
    assert.equal((await invoke("post", action)).statusCode, 403);
    role = "personnel";
    assert.equal((await invoke("post", action, { csrf: false })).statusCode, 403);
  }
  assert.equal(updates, 0);
});

test("appointment History distinguishes incomplete and excludes still-active failed retakes", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/appointmentRoutes.js"), "utf8");
  const historyQuery = source.split('router.get("/history"')[1].split('router.get("/orientation"')[0];
  assert.match(historyQuery, /THEN 'incomplete'/);
  assert.match(historyQuery, /'failed_orientation', 'ready_for_retake'/);
  assert.match(historyQuery, /'completed_orientation'/);
  assert.match(historyQuery, /THEN 'no_show'/);
});

test("past calendar date reconciles only approved never-started Orientation and is idempotent", async () => {
  reset("approved");
  record.preferred_date = "2026-09-26";
  record.created_at = "2026-09-26 23:59:00";
  const first = await invoke("get", "/orientation");
  assert.equal(first.statusCode, 200);
  assert.equal(record.orientation_status, "no_show");
  assert.equal(updates, 1);
  await invoke("get", "/orientation");
  assert.equal(updates, 1);
  assert.match(reconciliationSql, /preferred_date\s*<\s*\?/);
  assert.deepEqual(queryCalls.find(call => call.sql === reconciliationSql).params, ["SWM Orientation & Clearance", "2026-09-27"]);
  assert.doesNotMatch(reconciliationSql, /CURDATE\(\)/);
  assert.match(reconciliationSql, /orientation_started_at IS NULL/);
  assert.match(reconciliationSql, /orientation_completed_at IS NULL/);
  assert.match(reconciliationSql, /COALESCE\(orientation_completed, 0\) = 0/);
  assert.match(reconciliationSql, /orientation_status.*'approved'/s);
  assert.doesNotMatch(reconciliationSql, /created_at|INTERVAL\s+24\s+HOUR/i);
  assert.equal((await invoke("put", "/orientation/start/:token")).statusCode, 409);
});

test("same-day and future scheduled Orientation do not expire, regardless of approval time", async () => {
  for (const preferredDate of ["2026-09-27", "2026-09-28"]) {
    reset("approved");
    record.preferred_date = preferredDate;
    record.created_at = "2026-09-26 00:01:00";
    await invoke("get", "/orientation");
    assert.equal(record.orientation_status, "approved");
    assert.equal(updates, 0);
  }
});

test("started, failed, ready, completed and incomplete records never become no-show", async () => {
  const states = ["pending_orientation", "failed_orientation", "ready_for_retake", "completed_orientation", "incomplete_orientation", "no_show"];
  for (const state of states) {
    reset(state);
    record.preferred_date = "2026-09-26";
    await invoke("get", "/orientation");
    assert.equal(record.orientation_status, state);
    assert.equal(updates, 0);
  }
  reset("approved");
  record.preferred_date = "2026-09-26";
  record.orientation_started_at = "2026-09-26 09:00:00";
  await invoke("get", "/orientation");
  assert.equal(record.orientation_status, "approved");
  assert.equal(updates, 0);
});

test("only approved SWM records without completion evidence are eligible", async () => {
  const exclusions = [
    { status: "pending" },
    { purpose: "Accreditation" },
    { orientation_completed: 1 },
    { orientation_completed_at: "2026-09-26 10:00:00" }
  ];
  for (const exclusion of exclusions) {
    reset("approved");
    record.preferred_date = "2026-09-26";
    Object.assign(record, exclusion);
    await invoke("get", "/orientation");
    assert.equal(record.orientation_status, "approved");
    assert.equal(updates, 0);
  }
});

test("token verification and start reconcile overdue never-started records before acting", async () => {
  reset("approved");
  record.preferred_date = "2026-09-26";
  const verification = await invoke("get", "/orientation/verify/:token");
  assert.equal(verification.body.data.orientation_status, "no_show");
  assert.equal(verification.body.data.can_take_quiz, false);
  assert.equal((await invoke("put", "/orientation/start/:token")).statusCode, 409);
  assert.equal(updates, 1);
});

test("overdue QR and WMO actions cannot revive a reconciled no-show", async () => {
  reset("approved");
  record.preferred_date = "2026-09-26";
  assert.equal((await invoke("post", "/:id/generate-orientation-qr")).statusCode, 409);
  assert.equal(record.orientation_status, "no_show");
  assert.equal((await invoke("post", "/orientation/:id/mark-incomplete")).statusCode, 409);
  assert.equal(updates, 1);
});

test("server Web answer key stays aligned with the existing five-question exam", () => {
  const source = fs.readFileSync(path.join(__dirname, "../frontend/js/orientation-quiz.js"), "utf8");
  const context = { document: { addEventListener() {} } };
  vm.createContext(context);
  vm.runInContext(source, context);
  const webAnswers = Array.from(vm.runInContext("quizQuestions.map((question) => question.answer)", context));
  assert.deepEqual(webAnswers, require("../utils/orientationWorkflow").WEB_ORIENTATION_ANSWERS);
});

const philippineBoundaries = [
  { instant: "2026-11-20T15:59:59Z", timestamp: "2026-11-20 23:59:59", today: "2026-11-20" },
  { instant: "2026-11-20T16:00:00Z", timestamp: "2026-11-21 00:00:00", today: "2026-11-21" },
  { instant: "2026-11-20T16:00:01Z", timestamp: "2026-11-21 00:00:01", today: "2026-11-21" }
];
function r3State(state, boundary) {
  reset(state);
  applicationInstants = [boundary.instant];
  // Independent UTC database-session clock: this must not drive calendar predicates.
  databaseToday = boundary.instant.slice(0, 10);
  databaseNow = boundary.instant.replace("T", " ").slice(0, 19);
  record.preferred_date = `${boundary.today} 09:00:00`;
}
for (const boundary of philippineBoundaries) {
  test(`R3 Philippine calendar membership and no-show at ${boundary.instant}`, async () => {
    for (const preferred of ["2026-11-19 23:59:59", "2026-11-20 23:59:59", "2026-11-21 00:00:00", "2026-11-22 09:00:00"]) {
      r3State("approved", boundary); record.preferred_date = preferred;
      const past = preferred < boundary.today;
      const active = await invoke("get", "/active");
      assert.equal(active.statusCode, 200);
      assert.equal(active.body.appointments.length, past ? 0 : 1);
      assert.equal(record.orientation_status, past ? "no_show" : "approved");
      assert.equal(record.appointment_revision, past ? 1 : 0);
      assert.equal(clockReads, 1);
      const history = await invoke("get", "/history");
      assert.equal(history.body.history.length, past ? 1 : 0);
      if (past) assert.equal(history.body.history[0].status, "no_show");
      assert.equal(record.appointment_revision, past ? 1 : 0, "reconciliation is idempotent");
      assert.equal(updates, past ? 1 : 0);
      assert.equal(clockReads, 2, "each request has its own snapshot");
      for (const call of queryCalls) {
        assert.doesNotMatch(call.sql, /CURDATE\(\)|2026-11-/);
        assert.deepEqual(call.params, /^\s*UPDATE/.test(call.sql)
          ? ["SWM Orientation & Clearance", boundary.today] : [boundary.today]);
      }
    }
  });

  test(`R3 orientation DATETIME bindings use Manila with UTC SQL session at ${boundary.instant}`, async () => {
    r3State("approved", boundary);
    const start = await invoke("put", "/orientation/start/:token", { auth: false, csrf: false });
    assert.equal(start.statusCode, 200); assert.equal(record.orientation_started_at, boundary.timestamp);
    assert.equal(record.updated_at, databaseNow); assert.equal(clockReads, 1);
    const startWrite = queryCalls.find(call => call.sql.includes("orientation_started_at = COALESCE"));
    assert.deepEqual(startWrite.params, [boundary.timestamp, "ORI-test", "SWM Orientation & Clearance"]);
    assert.match(startWrite.sql, /COALESCE\(orientation_started_at, \?\)/);
    assert.match(startWrite.sql, /updated_at = NOW\(\)/);

    r3State("failed_orientation", boundary); record.orientation_score = 2;
    const incomplete = await invoke("post", "/orientation/:id/mark-incomplete");
    assert.equal(incomplete.statusCode, 200); assert.equal(record.orientation_completed_at, boundary.timestamp);
    assert.equal(record.orientation_completed, 0); assert.equal(record.orientation_score, 2);
    assert.equal(record.updated_at, databaseNow); assert.equal(clockReads, 1);
    const incompleteWrite = queryCalls.find(call => call.sql.includes("orientation_completed_at = ?"));
    assert.deepEqual(incompleteWrite.params, [boundary.timestamp, 17, "SWM Orientation & Clearance", "failed_orientation"]);
    assert.match(incompleteWrite.sql, /updated_at = NOW\(\)/);

    r3State("pending_orientation", boundary);
    const passed = await invoke("put", "/orientation/complete/:token", { auth: false, csrf: false, body: { score: 8 } });
    assert.equal(passed.body.certificate_eligible, true); assert.equal(passed.body.score, 8);
    assert.equal(record.status, "completed"); assert.equal(record.orientation_completed_at, boundary.timestamp);
    assert.equal(record.orientation_completed, 1); assert.equal(record.updated_at, databaseNow); assert.equal(clockReads, 1);
    const passWrite = queryCalls.find(call => call.sql.includes("orientation_completed_at = ?"));
    assert.deepEqual(passWrite.params, [boundary.timestamp, 8, 17, "SWM Orientation & Clearance", "pending_orientation"]);
    assert.match(passWrite.sql, /updated_at = NOW\(\)/);

    r3State("pending_orientation", boundary);
    const failed = await invoke("put", "/orientation/complete/:token", { auth: false, csrf: false, body: { score: 3 } });
    assert.equal(failed.body.certificate_eligible, false); assert.equal(failed.body.score, 3);
    assert.equal(record.orientation_completed_at, null); assert.equal(record.orientation_completed, 0);
    const failWrite = queryCalls.find(call => call.sql.includes("orientation_status = 'failed_orientation'"));
    assert.match(failWrite.sql, /orientation_completed_at = NULL/);
    assert.deepEqual(failWrite.params, [3, 17, "SWM Orientation & Clearance", "pending_orientation"]);
    assert.equal(record.updated_at, databaseNow); assert.equal(clockReads, 1);
    assert.doesNotMatch(failWrite.sql, /2026-11-/);
  });
}

for (const url of ["/active", "/history"]) {
  test(`R3 ${url} reuses one request date across midnight and refreshes it next request`, async () => {
    r3State("approved", philippineBoundaries[0]);
    record.preferred_date = "2026-11-20 10:00:00";
    applicationInstants = philippineBoundaries.map(boundary => boundary.instant);
    const first = await invoke("get", url);
    assert.equal(first.body[url === "/active" ? "appointments" : "history"].length, url === "/active" ? 1 : 0);
    assert.equal(record.orientation_status, "approved"); assert.equal(clockReads, 1);
    assert.deepEqual(queryCalls.map(call => call.params.at(-1)), ["2026-11-20", "2026-11-20"]);
    queryCalls.length = 0;
    const second = await invoke("get", url);
    assert.equal(second.body[url === "/active" ? "appointments" : "history"].length, url === "/active" ? 0 : 1);
    assert.equal(record.orientation_status, "no_show"); assert.equal(clockReads, 2);
    assert.equal(record.appointment_revision, 1);
    assert.deepEqual(queryCalls.map(call => call.params.at(-1)), ["2026-11-21", "2026-11-21"]);
  });
}

test("R3 calendar decisions are independent of simulated SQL session date", async () => {
  for (const sqlDate of ["2026-11-20", "2026-11-21", "2026-11-22"]) {
    r3State("approved", philippineBoundaries[1]); databaseToday = sqlDate; databaseNow = `${sqlDate} 00:00:00`;
    const result = await invoke("get", "/active");
    assert.equal(result.body.appointments.length, 1); assert.equal(record.orientation_status, "approved");
    assert.equal(updates, 0); assert.equal(record.appointment_revision, 0);
    assert.deepEqual(queryCalls.map(call => call.params.at(-1)), ["2026-11-21", "2026-11-21"]);
  }
});

test("R3 maintenance filters use Manila without reconciliation and orientation writes stay denied", async () => {
  for (const url of ["/active", "/history"]) {
    r3State("approved", philippineBoundaries[1]); schedulingEnabled = false;
    record.preferred_date = "2026-11-20 23:59:59";
    const result = await invoke("get", url);
    assert.equal(result.body[url === "/active" ? "appointments" : "history"].length, url === "/active" ? 0 : 1);
    assert.equal(queryCalls.length, 1); assert.match(queryCalls[0].sql, /^\s*SELECT/);
    assert.deepEqual(queryCalls[0].params, ["2026-11-21"]);
    assert.equal(record.orientation_status, "approved"); assert.equal(record.appointment_revision, 0); assert.equal(updates, 0);
    assert.equal(clockReads, 1);
  }
  for (const [method, url] of [["put", "/orientation/start/:token"], ["put", "/orientation/complete/:token"], ["post", "/orientation/:id/mark-incomplete"]]) {
    r3State("pending_orientation", philippineBoundaries[1]); schedulingEnabled = false;
    assert.equal((await invoke(method, url, { body: { score: 8 } })).statusCode, 503);
    assert.equal(queryCalls.length, 0); assert.equal(clockReads, 0); assert.equal(updates, 0);
  }
});

test("R3 repeated starts preserve COALESCE timestamp while retaining existing revision behavior", async () => {
  r3State("approved", philippineBoundaries[1]);
  applicationInstants = [philippineBoundaries[1].instant, philippineBoundaries[2].instant];
  assert.equal((await invoke("put", "/orientation/start/:token")).statusCode, 200);
  assert.equal((await invoke("put", "/orientation/start/:token")).statusCode, 200);
  assert.equal(record.orientation_started_at, "2026-11-21 00:00:00");
  assert.equal(record.appointment_revision, 2); assert.equal(updates, 2);
  assert.deepEqual(queryCalls.filter(call => call.sql.includes("orientation_started_at = COALESCE")).map(call => call.params[0]),
    ["2026-11-21 00:00:00", "2026-11-21 00:00:01"]);
});

for (const outcome of ["passed", "failed", "incomplete"]) {
  test(`R3 idempotent ${outcome} completion retains timestamp, score and revision`, async () => {
    r3State(outcome === "incomplete" ? "failed_orientation" : "pending_orientation", philippineBoundaries[1]);
    record.orientation_score = outcome === "incomplete" ? 2 : null;
    applicationInstants = [philippineBoundaries[1].instant, philippineBoundaries[2].instant];
    const method = outcome === "incomplete" ? "post" : "put";
    const url = outcome === "incomplete" ? "/orientation/:id/mark-incomplete" : "/orientation/complete/:token";
    const body = { score: outcome === "passed" ? 8 : 3 };
    assert.equal((await invoke(method, url, { body })).body.changed, true);
    const before = { timestamp: record.orientation_completed_at, score: record.orientation_score, revision: record.appointment_revision };
    assert.equal((await invoke(method, url, { body })).body.changed, false);
    assert.deepEqual({ timestamp: record.orientation_completed_at, score: record.orientation_score, revision: record.appointment_revision }, before);
    assert.equal(before.timestamp, outcome === "failed" ? null : "2026-11-21 00:00:00");
    assert.equal(queryCalls.filter(call => /^\s*UPDATE/.test(call.sql) && !call.sql.includes("orientation_status = 'no_show'")).length, 1);
    assert.equal(updates, 1);
  });
}

test("R3 preserves unrelated NOW, token generation and global timezone conventions", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/appointmentRoutes.js"), "utf8");
  assert.equal((source.match(/updated_at = NOW\(\)/g) || []).length, 7);
  assert.equal((source.match(/NOW\(\)/g) || []).length, 7);
  assert.match(source, /orientation_completed_at = NULL/);
  assert.match(source, /ORI-\$\{appointmentId\}-\$\{Date\.now\(\)\}/);
  assert.doesNotMatch(source, /CURDATE\(\)|CONVERT_TZ|SET\s+(?:SESSION\s+)?time_zone|process\.env\.TZ/);
});
