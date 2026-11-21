const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Real session/role/CSRF middleware and route registrations; no packages, DB or providers.
function harness({ service, legacy = false, sendEmail, selectRows, clock } = {}) {
  const state = { role: "super_admin", expired: false, calls: [], queries: [], queryCalls: [], routes: [], middleware: [] };
  const digest = value => crypto.createHash("sha256").update(value).digest("hex");
  const session = {
    hashOpaqueToken: digest, normalizeWebRole: value => String(value || "").trim().toLowerCase(),
    async validateSession(token) {
      if (token !== "valid-session" || state.expired) throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
      return { id: 1, user: { id: 7, full_name: "Verified Staff", role: state.role }, csrfTokenHash: digest("valid-csrf") };
    }
  };
  const db = { query(sql, params, done) {
    if (typeof params === "function") { done = params; params = []; }
    state.queries.push(sql);
    state.queryCalls.push({ sql, params });
    if (/^\s*UPDATE/.test(sql)) return done(null, { affectedRows: 0 });
    if (selectRows) return done(null, selectRows(sql, params));
    // The fake respects SELECT projection: public tracking never asks for a token.
    done(null, [{ id: 1, appointment_code: "APT-000001", full_name: "Synthetic Citizen", status: "pending", assigned_to: "Verified Staff" }]);
  } };
  const original = Module._load;
  const authFile = require.resolve("../middleware/webSessionAuth");
  const routeFile = require.resolve(legacy ? "../routes/webUserRoutes" : "../routes/appointmentRoutes");
  delete require.cache[authFile]; delete require.cache[routeFile];
  Module._load = function (name, parent, isMain) {
    if (parent?.filename === authFile && name === "../services/webSessionService") return session;
    if (parent?.filename === routeFile) {
      if (name === "../config/db") return db;
      if (name === "express") return { Router: () => ({
        ...Object.fromEntries(["get", "put", "post", "delete"].map(method => [method,
          (url, ...handlers) => state.routes.push({ method, url, handlers: handlers.flat(Infinity) })])),
        use: (...handlers) => state.middleware.push(...handlers.flat(Infinity))
      }) };
      if (name === "bcrypt") return {};
      if (name === "../services/enforcerTeamService") return { createEnforcerTeamService: () => ({}) };
      if (name === "../services/enforcerAorService") return { createEnforcerAorService: () => ({}) };
      if (name === "../services/webSessionService") return session;
      if (name === "resend") return { Resend: class { constructor() { this.emails = { send: sendEmail || (async () => { throw new Error("Provider forbidden"); }) }; } } };
      if (name === "qrcode") return { toBuffer: async () => Buffer.from("synthetic PNG") };
      if (name === "../services/appointmentSchedulingService") return { AppointmentSchedulingService: class {
        constructor() { if (service) return service; }
        enabled() { return false; }
        async ready() {}
        async book(body, key, options) { state.calls.push({ action: "book", body, key, options }); return { success: true, id: 1, appointment_code: "APT-000001" }; }
        async availability(service, date) { state.calls.push({ action: "availability" }); return { success: true, service, date, slots: [] }; }
        async change(id, action, actor, body) {
          state.calls.push({ action, actor, body });
          return { success: true, data: { id: Number(id), status: action === "accept" ? "approved" : "cancelled", assigned_to: actor.full_name } };
        }
      } };
    }
    return original.call(this, name, parent, isMain);
  };
  try {
    if (clock) vm.runInNewContext(fs.readFileSync(routeFile, "utf8"), {
      require: Module.createRequire(routeFile), module: { exports: {} }, console,
      Date: clock.Date, process: { env: {} }, Buffer
    }, { filename: routeFile });
    else require(routeFile);
  } finally { Module._load = original; }
  return { state, async request(method, url, { auth = true, csrf = "valid-csrf", body = {}, params = {}, headers = {} } = {}) {
    const route = state.routes.find(row => row.method === method && row.url === url);
    assert.ok(route, `${method} ${url}`);
    const req = { method: method.toUpperCase(), params: { id: "1", ...params }, body,
      ip: "synthetic", path: url, query: { service: "Accreditation", date: "2099-01-01" },
      headers: { cookie: `${auth ? "wmo_admin_session=valid-session; " : ""}wmo_admin_csrf=valid-csrf`,
        ...(csrf ? { "x-csrf-token": csrf } : {}), "idempotency-key": "synthetic-request-key-123", ...headers } };
    const res = { statusCode: 200, headers: {}, status(value) { this.statusCode = value; return this; },
      set(name, value) { this.headers[name] = value; }, setHeader(name, value) { this.headers[name] = value; },
      json(value) { this.body = value; return this; }, send(value) { this.body = value; return this; } };
    for (const handler of [...state.middleware, ...route.handlers]) {
      let next = false; await handler(req, res, () => { next = true; }); if (!next) break;
    }
    return res;
  } };
}
const reads = ["/", "/active", "/history", "/orientation", "/:id/orientation-qr-image"];
const writes = [["put", "/:id/decision"], ["put", "/:id/reschedule"], ["put", "/:id/cancel"], ["post", "/:id/generate-orientation-qr"]];
test("all protected appointment reads/mutations deny missing and expired sessions before business work", async () => {
  for (const [method, url] of [...reads.map(url => ["get", url]), ...writes]) for (const expired of [false, true]) {
    const h = harness(); h.state.expired = expired;
    const result = await h.request(method, url, { auth: expired });
    assert.equal(result.statusCode, 401); assert.equal(h.state.queries.length, 0); assert.equal(h.state.calls.length, 0);
  }
});
test("Personnel, Supervisor, Division Admin, invented Head Admin and unknown roles get no general management access", async () => {
  for (const role of ["personnel", "supervisor", "division_admin", "head_admin", "admin", "unknown"]) {
    const h = harness(); h.state.role = role;
    for (const [method, url] of writes) assert.equal((await h.request(method, url)).statusCode, 403);
    assert.equal(h.state.queries.length, 0); assert.equal(h.state.calls.length, 0);
  }
});
test("Admin and Clerk staff mutations reject absent/mismatched CSRF before business work", async () => {
  for (const role of ["super_admin", "clerk_admin"]) for (const csrf of [null, "wrong-csrf"]) {
    const h = harness(); h.state.role = role;
    for (const [method, url] of writes) assert.equal((await h.request(method, url, { csrf })).statusCode, 403);
    assert.equal(h.state.calls.length, 0); assert.equal(h.state.queries.length, 0);
  }
});
test("approved staff use session attribution and cannot invoke cancel through the decision endpoint", async () => {
  for (const role of ["super_admin", "clerk_admin"]) {
    const h = harness(); h.state.role = role;
    const result = await h.request("put", "/:id/decision", { body: { action: "accept", personnel_name: "FORGED" } });
    assert.equal(result.statusCode, 200); assert.equal(result.body.data.assigned_to, "Verified Staff");
    assert.equal(h.state.calls[0].actor.id, 7);
    assert.equal((await h.request("put", "/:id/decision", { body: { action: "cancel" } })).statusCode, 400);
  }
});
test("public booking/tracking remain session-free; tracking requires contact and never selects tokens", async () => {
  const h = harness();
  assert.equal((await h.request("post", "/", { auth: false, csrf: null })).statusCode, 200);
  assert.equal((await h.request("post", "/check-status", { auth: false, csrf: null, body: { appointment_code: "APT-000001" } })).statusCode, 400);
  const result = await h.request("post", "/check-status", { auth: false, csrf: null, body: { appointment_code: "APT-000001", contact: "synthetic@example.invalid" } });
  assert.equal(result.statusCode, 200); assert.equal(result.headers["Cache-Control"], "no-store");
  assert.ok(h.state.queries.some(sql => sql.includes("email = ?") && sql.includes("contact_number = ?")));
  assert.ok(h.state.queries.every(sql => !sql.includes("orientation_token")));
});
test("staff lists do not project bearer tokens and have no-store responses", async () => {
  const h = harness(); h.state.role = "clerk_admin";
  for (const url of ["/active", "/history", "/orientation"]) {
    const result = await h.request("get", url, { csrf: null });
    assert.equal(result.statusCode, 200); assert.equal(result.headers["Cache-Control"], "no-store");
  }
  assert.ok(h.state.queries.filter(sql => /^\s*SELECT/.test(sql)).every(sql => !sql.includes("orientation_token")));
});
test("legacy decisions share management service and retain users.manage rather than expanding User Management", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/webUserRoutes.js"), "utf8");
  assert.match(source, /router.use\(requireWebCapability\("users.manage"\)\)/);
  assert.match(source, /router.use\(requireCsrf\)/);
  assert.match(source, /router.put\("\/appointments\/:id\/decision", requireWebCapability\("appointments.manage"\)/);
  assert.match(source, /appointmentScheduling.change\(req.params.id, action, req.user, req.body\)/);
  const { hasWebCapability } = require("../config/webRoleCapabilities");
  assert.equal(hasWebCapability("clerk_admin", "appointments.manage"), true);
  assert.equal(hasWebCapability("clerk_admin", "users.manage"), false);
});

function staffUi() {
  const calls = [], toasts = [];
  const node = () => ({ value: "", textContent: "", innerText: "Save Reschedule", disabled: false,
    classList: { add() {}, remove() {}, contains() { return false; } }, addEventListener() {}, dispatchEvent() {} });
  const nodes = Object.fromEntries(["rescheduleAppointmentDate", "rescheduleAppointmentTime", "rescheduleAvailabilityStatus",
    "rescheduleAppointmentModal", "confirmRescheduleAppointmentBtn"].map(id => [id, node()]));
  nodes.rescheduleAppointmentTime.options = ["", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"].map(value => ({ value }));
  const context = { window: { addEventListener() {}, confirm: () => true },
    document: { getElementById: id => nodes[id] || null, addEventListener() {} },
    allAppointments: [{ id: 17, purpose: "Accreditation", status: "pending", slot_schedule: "2099-01-01 10:00:00", appointment_revision: 2 }],
    selectedRescheduleAppointmentId: null, currentUser: { fullName: "Untrusted browser display", username: "display" },
    getAppApiBase: () => "/api", getAppointmentDecisionApiUrl: id => `/api/appointments/${id}/decision`,
    getCancelAppointmentUrl: id => `/api/appointments/${id}/cancel`, getRescheduleAppointmentUrl: id => `/api/appointments/${id}/reschedule`,
    showToast: (...args) => toasts.push(args), confirm: () => true, console: { log() {}, error() {} }, setTimeout() {},
    Event: class { constructor(type) { this.type = type; } },
    webAdminFetch: async (url, options) => {
      calls.push({ url, options });
      let data = { success: true };
      if (url.includes("/availability?")) {
        const query = new URL(url, "https://offline.invalid").searchParams;
        data = { success: true, service: query.get("service"), date: query.get("date"), slots: ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"]
          .map(time => ({ time, status: time === "10:00" ? "occupied" : "available" })) };
      }
      return { ok: true, json: async () => data, text: async () => JSON.stringify(data) };
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../frontend/js/appointment-slots.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../frontend/js/admin/admin-appointments.js"), "utf8"), context);
  context.loadAppointments = async () => {}; context.loadNotifications = async () => {};
  return { context, calls, nodes, toasts };
}
test("real staff decision/cancel UI uses authenticated wrapper and sends state/revision instead of client actor", async () => {
  const h = staffUi();
  await h.context.handleAppointmentDecision(17, "accept");
  await h.context.handleCancel(17);
  assert.equal(h.calls.length, 2);
  for (const call of h.calls) {
    const body = JSON.parse(call.options.body);
    assert.equal(body.expected_status, "pending");
    assert.equal(body.expected_schedule, "2099-01-01 10:00:00");
    assert.equal(body.expected_revision, 2);
    assert.equal(Object.hasOwn(body, "personnel_name"), false);
  }
});
test("real staff reschedule UI requests selected service availability and blocks occupied choices", async () => {
  const h = staffUi(); h.context.handleReschedule(17);
  h.nodes.rescheduleAppointmentDate.value = "2099-01-02";
  await h.nodes.rescheduleAppointmentDate.onchange();
  assert.match(h.calls[0].url, /service=Accreditation&date=2099-01-02/);
  assert.equal(h.nodes.rescheduleAppointmentTime.options.find(option => option.value === "10:00").disabled, true);
  h.nodes.rescheduleAppointmentTime.value = "10:00";
  await h.context.confirmRescheduleAppointment();
  assert.equal(h.calls.length, 1, "occupied choice must not enqueue a mutation");
  h.nodes.rescheduleAppointmentTime.value = "11:00";
  await h.context.confirmRescheduleAppointment();
  assert.equal(h.calls.length, 2);
  const body = JSON.parse(h.calls[1].options.body);
  assert.equal(body.new_date, "2099-01-02 11:00:00");
  assert.equal(body.expected_revision, 2);
  assert.equal(Object.hasOwn(body, "personnel_name"), false);
});

test("legacy blank and case-varied pending snapshots match backend normalization without reopening terminal statuses", async () => {
  for (const status of [null, "", "   ", "PeNdInG", " pending ", "pending", "cancelled", "rejected", "completed"]) {
    const h = staffUi(); h.context.allAppointments[0].status = status;
    const expected = h.context.appointmentExpectedState(17);
    assert.equal(expected.expected_status, String(status || "pending").trim().toLowerCase() || "pending");
  }
});

test("actual legacy list handler chains deny unauthorized roles and return no-store for both lists", async () => {
  const h = harness({ legacy: true });
  for (const url of ["/appointments/active", "/appointments/history"]) {
    assert.equal((await h.request("get", url, { auth: false })).statusCode, 401);
    h.state.role = "clerk_admin";
    assert.equal((await h.request("get", url)).statusCode, 403);
    h.state.role = "super_admin";
    const response = await h.request("get", url);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["Cache-Control"], "no-store");
  }
});

for (const { url, envelope, tail } of [
  { url: "/appointments/active", envelope: "appointments",
    tail: "WHERE status IS NULL OR TRIM(status) = '' OR LOWER(status) = 'pending' ORDER BY preferred_date ASC, id DESC" },
  { url: "/appointments/history", envelope: "history",
    tail: "WHERE LOWER(status) IN ('approved', 'rejected') ORDER BY updated_at DESC, id DESC" }
]) {
  test(`legacy ${url} reads contact_number while retaining its contact response and filters`, async () => {
    for (const enabled of [false, true]) {
      let readinessChecks = 0;
      const service = { enabled: () => enabled, async ready() { readinessChecks++; } };
      const stored = { id: 17, contact_number: "09000000000", status: envelope === "history" ? "approved" : "pending" };
      const h = harness({ legacy: true, service, selectRows(sql) {
        // Capture the real handler's SQL against the reviewed schema; no database is loaded.
        assert.match(sql, /^\s*SELECT\b/);
        assert.match(sql, /\bcontact_number\s+AS\s+contact\s*,/i);
        assert.doesNotMatch(sql, /(?:SELECT|,)\s*contact\s*(?:,|FROM)/i);
        assert.equal(sql.slice(sql.indexOf("WHERE")).replace(/\s+/g, " ").trim(), tail);
        assert.equal(/\bappointment_revision\b/.test(sql), enabled);
        return [{ id: stored.id, contact: stored.contact_number, status: stored.status,
          ...(enabled ? { appointment_revision: 0 } : {}) }];
      } });
      assert.equal((await h.request("get", url, { auth: false })).statusCode, 401);
      h.state.role = "clerk_admin";
      assert.equal((await h.request("get", url)).statusCode, 403);
      assert.equal(h.state.queries.length, 0, "users.manage is required before any SQL");
      h.state.role = "super_admin";
      const response = await h.request("get", url, { csrf: null });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["Cache-Control"], "no-store");
      assert.deepEqual(Object.keys(response.body).sort(), [envelope, "success"].sort());
      assert.equal(response.body.success, true);
      assert.equal(response.body[envelope][0].contact, stored.contact_number);
      assert.equal(Object.hasOwn(response.body[envelope][0], "contact_number"), false);
      assert.equal(Object.hasOwn(response.body[envelope][0], "appointment_revision"), enabled);
      assert.equal(readinessChecks, enabled ? 1 : 0);
      assert.equal(h.state.queries.length, 1);
    }
  });
}

test("public tracker keeps contact as its request field for both email and phone matching", async () => {
  for (const contact of ["synthetic@example.invalid", "09000000000"]) {
    const h = harness();
    const response = await h.request("post", "/check-status", { auth: false, csrf: null,
      body: { appointment_code: " APT-000001 ", contact: ` ${contact} ` } });
    assert.equal(response.statusCode, 200);
    assert.equal(h.state.queryCalls.length, 1);
    const { sql, params } = h.state.queryCalls[0];
    assert.match(sql, /WHERE appointment_code = \?\s+AND \(\s*email = \?\s+OR contact_number = \?\s*\)/);
    assert.deepEqual(params, ["APT-000001", contact, contact]);
    assert.doesNotMatch(sql, /orientation_token/);
  }
  const h = harness();
  const renamedField = await h.request("post", "/check-status", { auth: false, csrf: null,
    body: { appointment_code: "APT-000001", contact_number: "09000000000" } });
  assert.equal(renamedField.statusCode, 400, "contact_number must not replace the public contact request field");
  assert.equal(h.state.queryCalls.length, 0);
});

test("reservation migration draft remains entirely commented and unready", () => {
  const draft = fs.readFileSync(path.join(__dirname, "../database/migrations/20261120_appointment_service_slots.DRAFT.sql"), "utf8");
  assert.ok(draft.split(/\r?\n/).filter(line => line.trim()).every(line => /^\s*--/.test(line)),
    "every nonblank draft line must remain a SQL comment");
  assert.doesNotMatch(draft, /<EXACT_APPOINTMENTS_ID_TYPE>/);
  assert.match(draft, /appointment_revision BIGINT UNSIGNED NOT NULL DEFAULT 0/);
  assert.match(draft, /backfill_complete TINYINT NOT NULL DEFAULT 0/);
  assert.match(draft, /VALUES \('service_slots', 1, 0\)/);
  assert.doesNotMatch(draft, /VALUES \('service_slots', 1, 1\)/);
  assert.match(draft, /9\.7\.2/);
});

test("draft child foreign keys match signed INT with insertion-safe nullability and retained uniqueness", () => {
  // Text inspection only: the commented definitions are never sent to a SQL executor.
  const draft = fs.readFileSync(path.join(__dirname, "../database/migrations/20261120_appointment_service_slots.DRAFT.sql"), "utf8");
  const definition = name => {
    const match = draft.match(new RegExp(`CREATE TABLE ${name} \\([\\s\\S]*?\\) ENGINE=InnoDB;`));
    assert.ok(match, name);
    return match[0];
  };
  const reservations = definition("appointment_reservations");
  const requests = definition("appointment_booking_requests");
  assert.match(reservations, /appointment_id INT NOT NULL,/);
  assert.match(requests, /appointment_id INT NULL,/);
  for (const table of [reservations, requests]) {
    assert.doesNotMatch(table, /appointment_id[^\r\n]*(?:UNSIGNED|AUTO_INCREMENT)/i);
    assert.match(table, /FOREIGN KEY \(appointment_id\) REFERENCES appointments\(id\) ON DELETE RESTRICT ON UPDATE RESTRICT/);
  }
  assert.match(reservations, /PRIMARY KEY \(service_key, appointment_date, appointment_time\)/);
  assert.match(reservations, /UNIQUE KEY reservation_appointment \(appointment_id\)/);
  assert.match(requests, /request_hash CHAR\(64\) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY/);
  assert.match(requests, /payload_hash CHAR\(64\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/);
  assert.match(requests, /appointment_code VARCHAR\(30\) NULL,/);
  assert.match(requests, /UNIQUE KEY request_appointment \(appointment_id\)/);
  assert.equal((draft.match(/ENGINE=InnoDB;/g) || []).length, 3);
  assert.doesNotMatch(draft, /ALTER TABLE appointments[^\r\n]*(?:MODIFY|CHANGE|DROP)/i);
});

test("protected mutation routes use real scheduling guards and never send email for blocked reschedules", async () => {
  const { fixture, citizen, actor, requestKey } = require("./helpers/appointmentSchedulingFixture");
  const f = fixture(); const { id } = await f.service.book({ ...citizen, purpose: "SWM Orientation & Clearance" }, requestKey("email-block"));
  await f.service.change(id, "accept", actor, f.expected(id));
  f.state.appointments[0].orientation_status = "failed_orientation";
  f.state.appointments[0].orientation_score = 2;
  let emails = 0;
  const h = harness({ service: f.service, sendEmail: async () => { emails++; return { data: { id: "synthetic-id" } }; } });
  const before = structuredClone(f.state);
  const response = await h.request("put", "/:id/reschedule", { params: { id: String(id) }, body: { ...f.expected(id), new_date: "2026-11-24 11:00:00" } });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, "ORIENTATION_REVIEW_REQUIRED");
  assert.deepEqual(f.state, before);
  assert.equal(emails, 0);
  f.state.appointments[0].orientation_status = "approved";
  f.state.appointments[0].orientation_score = null;
  const allowed = await h.request("put", "/:id/reschedule", { params: { id: String(id) }, body: { ...f.expected(id), new_date: "2026-11-24 11:00:00" } });
  assert.equal(allowed.statusCode, 200);
  assert.equal(emails, 1);
  assert.equal(f.state.appointments[0].status, "rescheduled");
});
test("maintenance guards cover QR, quiz, retake, incomplete and legacy decisions without any mutation", async () => {
  const { fixture, citizen, actor, requestKey } = require("./helpers/appointmentSchedulingFixture");
  const options = {}, f = fixture(options);
  const { id } = await f.service.book(citizen, requestKey("maintenance-route"));
  options.enabled = false;
  const before = structuredClone(f.state);
  const h = harness({ service: f.service });
  for (const [method, url] of [...writes, ["put", "/orientation/start/:token"], ["put", "/orientation/complete/:token"],
    ["post", "/orientation/:id/allow-retake"], ["post", "/orientation/:id/mark-incomplete"]]) {
    const response = await h.request(method, url, { params: { id: String(id) }, body: { action: "accept", ...f.expected(id) } });
    assert.equal(response.statusCode, 503, url);
  }
  const read = await h.request("get", "/orientation");
  assert.equal(read.statusCode, 200);
  assert.equal(h.state.queries.some(sql => /^\s*UPDATE/.test(sql)), false, "maintenance reads do not reconcile no-shows");
  const legacy = harness({ service: f.service, legacy: true });
  const response = await legacy.request("put", "/appointments/:id/decision", { params: { id: String(id) }, body: { action: "reject", ...f.expected(id) } });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(f.state, before);
});
test("public booking route forwards lookup-only recovery and preserves its strict key/payload contract", async () => {
  const { fixture, citizen, requestKey } = require("./helpers/appointmentSchedulingFixture");
  const f = fixture(), key = requestKey("route-recovery");
  const h = harness({ service: f.service });
  const options = { auth: false, csrf: null, body: citizen, headers: { "idempotency-key": key } };
  const created = await h.request("post", "/", options);
  assert.equal(created.statusCode, 200);
  const before = structuredClone(f.state);
  f.service.now = () => new Date("2026-11-24T00:00:00Z");
  const recoveryHeaders = { "idempotency-key": key, "idempotency-recovery": "true" };
  const recovered = await h.request("post", "/", { ...options, headers: recoveryHeaders });
  assert.equal(recovered.body.appointment_code, created.body.appointment_code);
  assert.equal(recovered.headers["Cache-Control"], "no-store");
  const changed = await h.request("post", "/", { ...options, body: { ...citizen, full_name: "Different" }, headers: recoveryHeaders });
  assert.equal(changed.statusCode, 409);
  const missing = await h.request("post", "/", { ...options, headers: { ...recoveryHeaders, "idempotency-key": requestKey("missing-route") } });
  assert.equal(missing.statusCode, 404);
  const invalid = await h.request("post", "/", { ...options, headers: { ...recoveryHeaders, "idempotency-recovery": "false" } });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(f.state, before);
});
test("appointment history presentation retains the latest real approver after another staff member acts", async () => {
  const { fixture, citizen, requestKey } = require("./helpers/appointmentSchedulingFixture");
  const f = fixture(), { id } = await f.service.book(citizen, requestKey("report-actor"));
  const first = { id: 11, full_name: "Staff A" }, later = { id: 12, full_name: "Staff B" };
  const h = staffUi(), c = h.context;
  h.nodes.appointmentHistoryTableBody = { innerHTML: "" };
  c.appointmentHistorySearchQuery = "";
  c.ensureAppointmentHistorySearchBar = () => {};
  c.updateAppointmentHistorySearchMeta = () => {};
  c.escapeHtml = value => String(value);
  c.formatDateTimeDisplay = c.formatDate = value => String(value || "");
  const check = name => {
    c.renderAppointmentHistory([f.state.appointments[0]]);
    assert.ok(h.nodes.appointmentHistoryTableBody.innerHTML.includes(`<td>${name}</td>`));
  };
  await f.service.change(id, "accept", first, f.expected(id)); check("Staff A");
  await f.service.change(id, "reschedule", later, { ...f.expected(id), new_date: "2026-11-24 11:00:00" }); check("Staff A");
  await f.service.change(id, "accept", later, f.expected(id)); check("Staff B");
  await f.service.change(id, "cancel", first, f.expected(id)); check("Staff B");
});

test("R2 actual route handlers deny incompatible metadata before reads, mutations or email", async () => {
  const { fixture, citizen, requestKey } = require("./helpers/appointmentSchedulingFixture");
  for (const defect of ["revision", "prefix", "foreign-key", "metadata-access"]) {
    const f = fixture(defect === "metadata-access" ? { metadataError: new Error("PRIVATE_SCHEMA driver error") } : {});
    if (defect === "revision") f.metadata.columns = f.metadata.columns.filter(row => row.COLUMN_NAME !== "appointment_revision");
    if (defect === "prefix") f.metadata.indexes.find(row => row.TABLE_NAME === "appointment_booking_requests" && row.INDEX_NAME === "PRIMARY").SUB_PART = 8;
    if (defect === "foreign-key") f.metadata.foreignKeys[0].DELETE_RULE = "CASCADE";
    let emails = 0;
    const h = harness({ service: f.service, sendEmail: async () => { emails++; } });
    assert.equal((await h.request("get", "/active", { auth: false })).statusCode, 401);
    assert.equal(f.metrics.acquisitionAttempts, 0, "authorization still precedes metadata inspection");
    const staffBody = { action: "accept", expected_status: "pending", expected_schedule: citizen.preferred_date,
      expected_revision: 0, new_date: "2026-11-24 11:00:00" };
    // Existing QR image retrieval is an authorized maintenance read with no reservation
    // dependency. Exercise the routes that already require reservation readiness.
    for (const [method, url] of [...["/", "/active", "/history", "/orientation"].map(url => ["get", url]), ...writes,
      ["put", "/orientation/start/:token"], ["put", "/orientation/complete/:token"]]) {
      const response = await h.request(method, url, { body: staffBody, params: { token: "synthetic-token" } });
      assert.equal(response.statusCode, 503, `${defect}: ${url}`);
      assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE_SCHEMA|information_schema|COLUMN_TYPE|CASCADE/);
    }
    for (const [url, body] of [["/", citizen], ["/", { ...citizen }]]) {
      const response = await h.request("post", url, { auth: false, csrf: null, body,
        headers: { "idempotency-key": requestKey("r2-route"), ...(body === citizen ? {} : { "idempotency-recovery": "true" }) } });
      assert.equal(response.statusCode, 503);
    }
    assert.equal((await h.request("get", "/availability", { auth: false, csrf: null })).statusCode, 503);
    const legacy = harness({ service: f.service, legacy: true });
    for (const url of ["/appointments/active", "/appointments/history"]) assert.equal((await legacy.request("get", url)).statusCode, 503);
    assert.equal((await legacy.request("put", "/appointments/:id/decision", { body: staffBody })).statusCode, 503);
    assert.equal(h.state.queries.length, 0); assert.equal(legacy.state.queries.length, 0);
    assert.equal(emails, 0); assert.equal(f.state.appointments.length, 0);
    assert.equal(f.calls.some(sql => /^(INSERT|UPDATE|DELETE) /.test(sql)), false);
    assert.ok(f.connections.every(c => c.destroyCount === 1 && c.releaseCount === 0 && c.beginAttempts === 0));
  }
});

test("R2 request-level costs expose repeated existing readiness guards", async t => {
  const { fixture, citizen } = require("./helpers/appointmentSchedulingFixture");
  const measurements = [];
  for (const [method, url, leases] of [["post", "/", 1], ["get", "/availability", 1], ["get", "/active", 2], ["get", "/orientation", 1]]) {
    const f = fixture(), h = harness({ service: f.service });
    const response = await h.request(method, url, { body: citizen });
    assert.equal(response.statusCode, 200, url);
    assert.equal(f.metrics.acquisitionAttempts, leases); assert.equal(f.metrics.metadataQueries, leases * 6);
    assert.ok(f.connections.every(c => c.releaseCount === 1 && c.destroyCount === 0));
    measurements.push({ method, url, sequentialLeases: leases, metadataQueries: f.metrics.metadataQueries });
  }
  t.diagnostic(JSON.stringify({ syntheticRequestCosts: measurements, realDatabaseLatencyMeasured: false }));
});

function isolatedRouteClock(...instants) {
  let reads = 0;
  return { get reads() { return reads; }, Date: class extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super(instants[Math.min(reads++, instants.length - 1)]);
    }
    static now() { return Date.parse(instants[Math.min(reads, instants.length - 1)]); }
  } };
}

test("R3 existing session, capability and CSRF guards precede clock capture", async () => {
  const nativeDate = Date;
  for (const scenario of [
    { method: "get", url: "/active", options: { auth: false }, status: 401 },
    { method: "get", url: "/history", expired: true, status: 401 },
    { method: "get", url: "/active", role: "unknown", status: 403 },
    { method: "post", url: "/orientation/:id/mark-incomplete", options: { auth: false }, status: 401 },
    { method: "post", url: "/orientation/:id/mark-incomplete", options: { csrf: null }, status: 403 },
    { method: "post", url: "/orientation/:id/mark-incomplete", role: "clerk_admin", status: 403 }
  ]) {
    const clock = isolatedRouteClock("2026-11-20T16:00:00Z"); let readiness = 0;
    const h = harness({ clock, service: { enabled: () => true, async ready() { readiness++; } } });
    h.state.expired = !!scenario.expired; if (scenario.role) h.state.role = scenario.role;
    assert.equal((await h.request(scenario.method, scenario.url, scenario.options)).statusCode, scenario.status);
    assert.equal(clock.reads, 0); assert.equal(readiness, 0); assert.equal(h.state.queries.length, 0);
  }
  assert.equal(Date, nativeDate, "isolated VM clock never replaces the global Date");
});

test("R3 R2 schema denial still occurs before clock capture or route SQL", async () => {
  const { fixture } = require("./helpers/appointmentSchedulingFixture");
  for (const [method, url] of [["get", "/active"], ["get", "/history"], ["put", "/orientation/start/:token"], ["post", "/orientation/:id/mark-incomplete"]]) {
    const f = fixture({ unready: true }), clock = isolatedRouteClock("2026-11-20T16:00:00Z");
    const h = harness({ service: f.service, clock });
    assert.equal((await h.request(method, url)).statusCode, 503);
    assert.equal(clock.reads, 0); assert.equal(h.state.queries.length, 0);
    assert.equal(f.metrics.acquisitionAttempts, 1);
    assert.equal(f.connections[0].beginAttempts, 0); assert.equal(f.connections[0].destroyCount, 1);
  }
});

test("R3 actual maintenance guards retain parameterized Manila reads and deny writes", async () => {
  const { fixture } = require("./helpers/appointmentSchedulingFixture");
  const f = fixture({ enabled: false });
  const clock = isolatedRouteClock("2026-11-20T16:00:00Z", "2026-11-20T16:00:01Z");
  const h = harness({ service: f.service, clock, selectRows: () => [] });
  for (const [url, envelope] of [["/active", "appointments"], ["/history", "history"]]) {
    const response = await h.request("get", url);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(response.body).sort(), [envelope, "success"].sort());
    const call = h.state.queryCalls.at(-1);
    assert.deepEqual(Array.from(call.params), ["2026-11-21"]);
    assert.match(call.sql, /preferred_date (?:>=|<) \?/);
    assert.doesNotMatch(call.sql, /CURDATE\(\)|2026-11-21/);
  }
  assert.equal(clock.reads, 2); assert.equal(h.state.queries.length, 2);
  for (const [method, url] of [["put", "/orientation/start/:token"], ["put", "/orientation/complete/:token"], ["post", "/orientation/:id/mark-incomplete"]]) {
    assert.equal((await h.request(method, url, { body: { score: 8 } })).statusCode, 503);
  }
  assert.equal(clock.reads, 2); assert.equal(h.state.queries.length, 2);
  assert.ok(h.state.queries.every(sql => /^\s*SELECT/.test(sql)));
  assert.equal(f.metrics.acquisitionAttempts, 0); assert.equal(f.calls.length, 0);
});

test("R3 invalid application clock fails safely before calendar SQL", async () => {
  for (const url of ["/active", "/history"]) {
    const clock = isolatedRouteClock("not-an-instant"), h = harness({ clock });
    const response = await h.request("get", url);
    assert.equal(response.statusCode, 503); assert.equal(response.body.code, "APPOINTMENT_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(response.body), /clock|RangeError|not-an-instant/i);
    assert.equal(clock.reads, 1); assert.equal(h.state.queries.length, 0);
  }
});
