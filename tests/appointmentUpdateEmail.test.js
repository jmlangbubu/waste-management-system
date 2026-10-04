const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const { inspect } = require("node:util");
const vm = require("node:vm");
const {
  buildAppointmentUpdateEmail,
  buildAppointmentStatusUrl,
  formatAppointmentEmailDate
} = require("../utils/appointmentUpdateEmail");

const officialOrigin = "https://wastegensan.com";
const sample = {
  fullName: "Fictional Citizen",
  appointmentCode: "APT-000017",
  purpose: "SWM Orientation & Clearance",
  oldDate: "2026-10-06 09:30:00",
  newDate: "2026-10-07 14:30:00",
  status: "rescheduled",
  updateReason: "Fictional office schedule adjustment"
};

function linksIn(html) {
  return Array.from(html.matchAll(/\bhref="([^"]+)"/g), (match) =>
    new URL(match[1].replace(/&amp;/g, "&")));
}

function assertCodeOnlyStatusUrl(value, reference = sample.appointmentCode) {
  const url = new URL(value);
  assert.equal(url.origin, officialOrigin);
  assert.equal(url.pathname, "/");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.deepEqual(Array.from(url.searchParams.keys()), ["appointment_code"]);
  assert.equal(url.searchParams.get("appointment_code"), reference);
  assert.equal(url.hash, "#appointmentStatusSection");
}

test("appointment update keeps the reference in HTML text and uses the approved subject", () => {
  const email = buildAppointmentUpdateEmail(sample);
  assert.equal(email.subject, `WMO Appointment Update – ${sample.appointmentCode}`);
  assert.doesNotMatch(email.subject, /Fictional Citizen|@/);
  assert.match(email.html, /Appointment Update/);
  assert.match(email.html, /Reference Code/i);
  assert.match(email.html, /APT-000017/);
  assert.match(email.text, /APT-000017/);
  assert.match(email.html.replace(/<[^>]+>/g, " "), /Dear Fictional Citizen,/);
});

test("updated schedule, service, and readable status are included", () => {
  const email = buildAppointmentUpdateEmail(sample);
  assert.match(email.html, /Updated Schedule/);
  assert.match(email.html, /October 07, 2026, 2:30 PM/);
  assert.match(email.text, /October 07, 2026, 2:30 PM/);
  assert.match(email.html, /SWM Orientation &amp; Clearance/);
  assert.match(email.html, /Rescheduled/);
});

test("a real previous schedule and update reason appear when supplied", () => {
  const email = buildAppointmentUpdateEmail(sample);
  assert.match(email.html, /Previous Schedule/);
  assert.match(email.html, /October 06, 2026, 9:30 AM/);
  assert.match(email.text, /October 06, 2026, 9:30 AM/);
  assert.match(email.html, /Reason for Update/);
  assert.match(email.html, /Fictional office schedule adjustment/);
});

test("missing optional rows are omitted without null, undefined, or fake values", () => {
  for (const absent of [null, undefined, "null", "undefined", "", "  "]) {
    const email = buildAppointmentUpdateEmail({ ...sample, oldDate: absent, updateReason: absent });
    assert.doesNotMatch(email.html, /Previous Schedule|Reason for Update/);
    assert.doesNotMatch(email.text, /Previous Schedule|Reason for Update/);
    assert.doesNotMatch(email.html, /\b(?:null|undefined)\b/i);
    assert.doesNotMatch(email.text, /\b(?:null|undefined)\b/i);
    assert.doesNotMatch(email.html, />\s*-\s*</);
    const missingFields = buildAppointmentUpdateEmail(Object.fromEntries(
      Object.keys(sample).map((field) => [field, absent])));
    for (const content of [missingFields.subject, missingFields.html, missingFields.text]) {
      assert.doesNotMatch(content, /\b(?:null|undefined)\b/i);
    }
    assert.doesNotMatch(missingFields.html, />\s*-\s*</);
  }
});

test("primary CTA and clickable fallback use the official HTTPS status flow", () => {
  const email = buildAppointmentUpdateEmail(sample);
  assert.match(email.html, /Check Appointment Status/);
  assert.match(email.html, /If the button does not work, use this link:/);
  assert.match(email.html, /<a href="[^"]+"[^>]*>Open the WMO Appointment Status page<\/a>/);
  assert.doesNotMatch(email.html, />https:\/\/wastegensan\.com\/\?appointment_code=/);
  const links = linksIn(email.html);
  assert.equal(links.length, 2, "CTA and fallback are real links");
  assert.equal(links[0].href, links[1].href, "fallback preserves the exact CTA destination");
  for (const url of links) assertCodeOnlyStatusUrl(url.href);
  assert.ok(email.text.includes(buildAppointmentStatusUrl(sample.appointmentCode)));
});

test("status URLs allow only valid references and ignore injected destinations and private data", () => {
  assertCodeOnlyStatusUrl(buildAppointmentStatusUrl(sample.appointmentCode));
  for (const invalid of ['APT-17 & "sample"', "APT-000017&contact=private", "<script>alert(1)</script>"]) {
    const url = new URL(buildAppointmentStatusUrl(invalid));
    assert.equal(url.origin, officialOrigin);
    assert.equal(url.pathname, "/");
    assert.equal(url.search, "");
    assert.equal(url.hash, "#appointmentStatusSection");
  }
  const envNames = [
    "APPOINTMENT_STATUS_URL", "LANDING_APPOINTMENT_STATUS_URL",
    "PUBLIC_FRONTEND_URL", "FRONTEND_URL"
  ];
  const saved = envNames.map((name) => [name, process.env[name]]);
  try {
    for (const name of envNames) process.env[name] = "https://external.invalid/admin?contact=private";
    const email = buildAppointmentUpdateEmail({
      ...sample,
      statusUrl: "javascript:alert(1)",
      email: "fictional@example.invalid",
      contact: "09999999999"
    });
    for (const url of linksIn(email.html)) assertCodeOnlyStatusUrl(url.href);
    assert.doesNotMatch(email.html, /external\.invalid|fictional@example\.invalid|09999999999|javascript:/);
    assert.doesNotMatch(email.text, /external\.invalid|fictional@example\.invalid|09999999999/);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("separate official logo and header assets replace old branding without local paths", () => {
  const { html } = buildAppointmentUpdateEmail(sample);
  assert.match(html, /https:\/\/wastegensan\.com\/images\/wmo-logo-new\.png/);
  assert.match(html, /<img\b[^>]*src="https:\/\/wastegensan\.com\/images\/wmo-logo-new\.png"[^>]*alt="[^"]+"/i);
  assert.match(html, /https:\/\/wastegensan\.com\/images\/wmo-appointment-update-header\.png/);
  assert.doesNotMatch(html, /logo\.jpg|localhost|127\.0\.0\.1|file:\/\/|[A-Z]:\\/i);
  assert.doesNotMatch(html, /(?:src|background)="\/images\//i);
});

test("email remains useful without images and contains no executable JavaScript", () => {
  const email = buildAppointmentUpdateEmail(sample);
  assert.match(email.html, /<table\b/i);
  assert.match(email.html, /max-width:\s*(?:6[0-7]\d|680)px/i);
  assert.match(email.html, /Your appointment schedule has been updated/);
  assert.match(email.html, /This is an automated appointment update email\./);
  assert.match(email.text, /Keep your reference code|keep your reference code/i);
  assert.doesNotMatch(email.html, /<script\b|javascript:|\bon(?:load|error|click)\s*=/i);
});

test("dynamic appointment text is escaped before insertion into HTML", () => {
  const email = buildAppointmentUpdateEmail({
    ...sample,
    appointmentCode: "APT-<b>17</b>",
    fullName: '<script>alert("name")</script>',
    purpose: '<img src=x onerror="alert(1)"> & service',
    status: "<span>rescheduled</span>",
    updateReason: "<b>Reason</b> & 'sample'"
  });
  assert.match(email.html, /&lt;script&gt;alert\(&quot;name&quot;\)&lt;\/script&gt;/);
  assert.match(email.html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; service/);
  assert.match(email.html, /&lt;b&gt;Reason&lt;\/b&gt; &amp; &#39;sample&#39;/);
  assert.match(email.html, /APT-&lt;b&gt;17&lt;\/b&gt;/);
  assert.match(email.html, /&lt;span&gt;rescheduled&lt;\/span&gt;/);
  assert.doesNotMatch(email.html, /<script>|<img src=x|<b>Reason<\/b>/);
});

test("schedule formatting preserves local calendar SQL semantics and supports Date objects", () => {
  assert.equal(formatAppointmentEmailDate(sample.newDate), "October 07, 2026, 2:30 PM");
  assert.equal(formatAppointmentEmailDate("2026-10-07"), "October 07, 2026");
  assert.equal(formatAppointmentEmailDate(new Date(2026, 9, 7, 14, 30)),
    "October 07, 2026, 2:30 PM");
});

const routes = [];
let scenario;
const fixture = {
  id: 17,
  appointment_code: sample.appointmentCode,
  status: "approved",
  preferred_date: sample.oldDate,
  email: "fictional@example.invalid",
  full_name: sample.fullName,
  barangay: "Fictional Barangay",
  purpose: sample.purpose
};

function resetScenario(options = {}) {
  scenario = {
    record: { ...fixture },
    sqlCalls: [],
    messages: [],
    events: [],
    mailResult: { data: { id: "mock-email-id" }, error: null },
    ...options
  };
}

const fakeDb = {
  query(sql, parameters, callback) {
    scenario.sqlCalls.push({ sql: String(sql), parameters });
    if (/^\s*SELECT/i.test(sql)) {
      scenario.events.push("select");
      return callback(scenario.selectError || null, scenario.record ? [{ ...scenario.record }] : []);
    }
    assert.match(sql, /^\s*UPDATE appointments/i);
    scenario.events.push("update");
    return callback(scenario.updateError || null, { affectedRows: 1 });
  }
};
const originalLoad = Module._load;
const routeFile = path.join(__dirname, "../routes/appointmentRoutes.js");
delete require.cache[require.resolve(routeFile)];
Module._load = function loadWithMocks(request, parent, isMain) {
  const parentFile = parent?.filename.replace(/\\/g, "/") || "";
  if (parentFile.endsWith("routes/appointmentRoutes.js")) {
    if (request === "express") {
      return { Router: () => Object.fromEntries(["get", "post", "put", "delete"].map((method) => [
        method, (routePath, ...handlers) => routes.push({ method, path: routePath, handlers: handlers.flat() })
      ])) };
    }
    if (request === "../config/db") return fakeDb;
    if (request === "resend") {
      return { Resend: class Resend {
        constructor() {
          this.emails = { send: async (message) => {
            scenario.events.push("email");
            scenario.messages.push(message);
            if (scenario.mailError) throw scenario.mailError;
            return scenario.mailResult;
          } };
        }
      } };
    }
    if (request === "../middleware/webSessionAuth") {
      const next = (_req, _res, done) => done();
      return { requireWebAuth: next, requireWebRole: () => next, requireCsrf: next };
    }
    if (request === "qrcode") return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};
try { require(routeFile); } finally { Module._load = originalLoad; }

function invokeReschedule(overrides = {}) {
  const route = routes.find((entry) => entry.method === "put" && entry.path === "/:id/reschedule");
  assert.ok(route, "existing reschedule route remains registered");
  assert.equal(route.handlers.length, 1, "existing reschedule handler chain remains unchanged");
  const request = {
    params: { id: "17" },
    body: { new_date: sample.newDate, personnel_name: "  Fictional WMO Staff  " },
    ...overrides
  };
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) {
        scenario.events.push("response");
        resolve({ statusCode: this.statusCode, body });
        return this;
      }
    };
    try { route.handlers[0](request, response); } catch (error) { reject(error); }
  });
}

function assertSuccess(result) {
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    success: true,
    message: "Appointment successfully rescheduled",
    data: { id: 17, status: "rescheduled", new_date: sample.newDate, assigned_to: "Fictional WMO Staff" }
  });
}

async function invokeRescheduleWithLogs(options = {}) {
  resetScenario(options);
  const logs = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  for (const level of Object.keys(saved)) {
    console[level] = (...args) => logs.push({ level, args });
  }
  try {
    return { result: await invokeReschedule(), logs };
  } finally {
    Object.assign(console, saved);
  }
}

function logText(logs) {
  return logs.map(({ level, args }) => `${level} ${args.map((value) =>
    typeof value === "string" ? value : inspect(value, { depth: null })).join(" ")}`).join("\n");
}

function assertMailAttemptSucceeded(result) {
  assertSuccess(result);
  assert.deepEqual(scenario.events, ["select", "update", "email", "response"]);
  assert.equal(scenario.sqlCalls.length, 2);
  assert.equal(scenario.messages.length, 1);
}

function assertNoPrivateLogs(logs, extra = []) {
  const output = logText(logs);
  for (const value of [fixture.email, fixture.full_name, ...extra]) {
    assert.ok(!output.includes(value), "reschedule email logs must omit private data");
  }
}

function assertNoAcceptanceLog(logs) {
  assert.equal(logs.filter(({ level }) => level === "log").length, 0);
  assert.doesNotMatch(logText(logs), /\b(?:accepted|sent)\b/i);
}

test("rescheduling preserves SQL, parameters, response, recipient, and DB-before-email ordering", async () => {
  resetScenario();
  const result = await invokeReschedule();
  assertSuccess(result);
  assert.deepEqual(scenario.events, ["select", "update", "email", "response"]);
  assert.deepEqual(scenario.sqlCalls[0].parameters, ["17"]);
  assert.match(scenario.sqlCalls[0].sql, /preferred_date[\s\S]*email[\s\S]*full_name[\s\S]*barangay[\s\S]*purpose/);
  assert.match(scenario.sqlCalls[0].sql, /WHERE id = \?\s+LIMIT 1/);
  assert.deepEqual(scenario.sqlCalls[1].parameters, [sample.newDate, "Fictional WMO Staff", "17"]);
  assert.match(scenario.sqlCalls[1].sql.replace(/\s+/g, " ").trim(),
    /^UPDATE appointments SET preferred_date = \?, status = 'rescheduled', assigned_to = \?, assigned_at = NOW\(\), updated_at = NOW\(\) WHERE id = \?$/);
  assert.equal(scenario.messages.length, 1);
  const message = scenario.messages[0];
  assert.equal(message.from, "WMO System <noreply@wastegensan.com>");
  assert.equal(message.to, fixture.email);
  assert.deepEqual(message, {
    from: "WMO System <noreply@wastegensan.com>",
    to: fixture.email,
    ...buildAppointmentUpdateEmail({
      fullName: fixture.full_name,
      oldDate: fixture.preferred_date,
      newDate: sample.newDate,
      purpose: fixture.purpose,
      appointmentCode: fixture.appointment_code,
      status: "rescheduled"
    })
  });
  assert.equal(message.subject, `WMO Appointment Update – ${sample.appointmentCode}`);
  assert.match(message.html, /October 06, 2026, 9:30 AM/);
  assert.match(message.html, /October 07, 2026, 2:30 PM/);
  assert.doesNotMatch(message.html, /Reason for Update/);
  for (const url of linksIn(message.html)) assertCodeOnlyStatusUrl(url.href);
});

test("terminal rejection and required input validation still prevent updates and emails", async () => {
  for (const status of ["rejected", "cancelled", "completed"]) {
    resetScenario({ record: { ...fixture, status } });
    const result = await invokeReschedule();
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.message, "Cannot reschedule rejected, cancelled, or completed appointments");
    assert.deepEqual(scenario.events, ["select", "response"]);
    assert.equal(scenario.messages.length, 0);
  }
  for (const overrides of [
    { params: { id: "" } },
    { body: { personnel_name: "Fictional WMO Staff" } },
    { body: { new_date: sample.newDate, personnel_name: "  " } }
  ]) {
    resetScenario();
    const result = await invokeReschedule(overrides);
    assert.equal(result.statusCode, 400);
    assert.equal(scenario.sqlCalls.length, 0);
    assert.equal(scenario.messages.length, 0);
  }
});

test("database failures and a missing appointment do not send an update email", async () => {
  for (const [options, statusCode] of [
    [{ selectError: new Error("mock lookup failure") }, 500],
    [{ record: null }, 404],
    [{ updateError: new Error("mock update failure") }, 500]
  ]) {
    resetScenario(options);
    const result = await invokeReschedule();
    assert.equal(result.statusCode, statusCode);
    assert.equal(result.body.success, false);
    assert.equal(scenario.messages.length, 0);
  }
});

test("mail delivery failure and absent recipient still preserve the successful update response", async () => {
  resetScenario({ mailError: new Error("mock mail failure") });
  assertSuccess(await invokeReschedule());
  assert.deepEqual(scenario.events, ["select", "update", "email", "response"]);
  resetScenario({ record: { ...fixture, email: null } });
  assertSuccess(await invokeReschedule());
  assert.deepEqual(scenario.events, ["select", "update", "response"]);
  assert.equal(scenario.messages.length, 0);
});

test("a returned Resend email ID logs acceptance without claiming delivery or logging the recipient", async () => {
  const { result, logs } = await invokeRescheduleWithLogs();
  assertMailAttemptSucceeded(result);
  assert.deepEqual(logs.map(({ level }) => level), ["log"]);
  assert.match(logText(logs), /accepted.*Resend/i);
  assert.match(logText(logs), /mock-email-id/);
  assert.doesNotMatch(logText(logs), /\b(?:delivered|sent)\b/i);
  assertNoPrivateLogs(logs);
});

test("a returned Resend error preserves DB success and never logs acceptance", async () => {
  const { result, logs } = await invokeRescheduleWithLogs({
    mailResult: { data: null, error: { message: "mock error" } }
  });
  assertMailAttemptSucceeded(result);
  assert.deepEqual(logs.map(({ level }) => level), ["error"]);
  assert.match(logText(logs), /rejected|error/i);
  assertNoAcceptanceLog(logs);
  assertNoPrivateLogs(logs);
});

test("a thrown Resend exception preserves DB success and logs only a safe failure", async () => {
  const { result, logs } = await invokeRescheduleWithLogs({ mailError: new Error("mock exception") });
  assertMailAttemptSucceeded(result);
  assert.deepEqual(logs.map(({ level }) => level), ["error"]);
  assert.match(logText(logs), /exception/i);
  assertNoAcceptanceLog(logs);
  assertNoPrivateLogs(logs);
});

test("empty and no-ID Resend results warn without retries or false acceptance", async () => {
  for (const mailResult of [undefined, null, {}, { data: null, error: null },
    { data: {}, error: null }, { data: { id: "" }, error: null }]) {
    const { result, logs } = await invokeRescheduleWithLogs({ mailResult });
    assertMailAttemptSucceeded(result);
    assert.deepEqual(logs.map(({ level }) => level), ["warn"]);
    assert.match(logText(logs), /no email ID|unexpected|incomplete/i);
    assertNoAcceptanceLog(logs);
    assertNoPrivateLogs(logs);
  }
});

test("a returned error takes priority over an accompanying Resend email ID", async () => {
  const { result, logs } = await invokeRescheduleWithLogs({
    mailResult: { data: { id: "mock-email-id" }, error: { message: "mock error" } }
  });
  assertMailAttemptSucceeded(result);
  assert.deepEqual(logs.map(({ level }) => level), ["error"]);
  assertNoAcceptanceLog(logs);
  assert.doesNotMatch(logText(logs), /mock-email-id/);
  assertNoPrivateLogs(logs);
});

test("Resend result and exception logs omit private fields, credentials, and unsafe email IDs", async () => {
  const privateValues = ["09123456789", "re_mock_private_api_key_DO_NOT_LOG",
    "mock-private-password", "private-provider-detail"];
  const privateFields = {
    recipient: fixture.email, fullName: fixture.full_name, phone: privateValues[0],
    apiKey: privateValues[1], credentials: { password: privateValues[2] },
    privateDetails: privateValues[3]
  };
  const privateMessage = [fixture.email, fixture.full_name, ...privateValues].join(" ");
  const exception = Object.assign(new Error(privateMessage), privateFields, {
    name: privateMessage, stack: privateMessage
  });
  const cases = [
    [{ mailResult: { data: { id: "mock-email-id", ...privateFields }, error: null } }, "log"],
    [{ mailResult: { data: null, error: { message: privateMessage, name: privateMessage,
      statusCode: privateMessage, ...privateFields } } }, "error"],
    [{ mailError: exception }, "error"],
    [{ mailResult: { data: privateFields, error: null } }, "warn"],
    [{ mailResult: { data: { id: fixture.email, ...privateFields }, error: null } }, "warn"]
  ];
  for (const [options, expectedLevel] of cases) {
    const { result, logs } = await invokeRescheduleWithLogs(options);
    assertMailAttemptSucceeded(result);
    assert.deepEqual(logs.map(({ level }) => level), [expectedLevel]);
    assertNoPrivateLogs(logs, privateValues);
    if (expectedLevel !== "log") assertNoAcceptanceLog(logs);
  }
});

test("the public status page prefills only the reference and leaves verification user-driven", () => {
  const landing = fs.readFileSync(path.join(__dirname, "../frontend/js/landing.js"), "utf8");
  function loadPrefill(search, existingReference = "") {
    const referenceInput = { value: existingReference };
    const contactInput = { value: "" };
    let scrolls = 0;
    let submissions = 0;
    let requests = 0;
    const nodes = {
      statusAppointmentCode: referenceInput,
      statusContact: contactInput,
      appointmentStatusSection: { scrollIntoView() { scrolls += 1; } },
      statusForm: { submit() { submissions += 1; } }
    };
    const context = {
      window: { location: { search } },
      URLSearchParams,
      document: { addEventListener() {}, getElementById: (id) => nodes[id] || null },
      fetch() { requests += 1; throw new Error("Prefill must not request private appointment data"); }
    };
    vm.createContext(context);
    vm.runInContext(landing, context);
    context.prefillAppointmentStatusReference();
    return { referenceInput, contactInput, scrolls, submissions, requests };
  }
  const normal = loadPrefill("?appointment_code=APT-000017&contact=private%40example.invalid");
  assert.equal(normal.referenceInput.value, sample.appointmentCode);
  assert.equal(normal.contactInput.value, "");
  assert.equal(normal.scrolls, 1);
  assert.equal(normal.submissions, 0);
  assert.equal(normal.requests, 0);
  const existing = loadPrefill("?appointment_code=APT-000017", "APT-000099");
  assert.equal(existing.referenceInput.value, "APT-000099");
  assert.equal(existing.scrolls, 0);
  for (const search of ["", "?appointment_code=%3Cimg%20src%3Dx%3E", "?appointment_code=APT-17"]) {
    const invalid = loadPrefill(search);
    assert.equal(invalid.referenceInput.value, "");
    assert.equal(invalid.contactInput.value, "");
    assert.equal(invalid.scrolls, 0);
    assert.equal(invalid.submissions, 0);
    assert.equal(invalid.requests, 0);
  }
});
