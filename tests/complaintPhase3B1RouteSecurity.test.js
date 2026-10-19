const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

// Offline only: real router source, web guards and session validation; no real
// dependency loading, environment, DB, filesystem writes, timers or listeners.
// The registration/HEAD dispatcher below models Express, not an HTTP integration.
const root = path.join(__dirname, "..");
const maintenancePath = "/maintenance/check-overdue-accepted";
const sessionToken = "S".repeat(43);
const csrfToken = "C".repeat(43);
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

function loadSource(relative, dependencies, extras = {}) {
  const context = vm.createContext({
    module: { exports: {} }, Buffer, console: { warn() {}, error() {}, log() {} },
    process: { env: Object.freeze({}) },
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unmocked dependency: ${name}`);
      return dependencies[name];
    },
    ...extras
  });
  vm.runInContext(read(relative), context, { filename: relative });
  return { exports: context.module.exports, context };
}

function harness() {
  const state = { workerCalls: 0, targetQueries: [], sessionQueries: [],
    forbiddenCalls: [], session: "valid", role: "super_admin", active: true,
    workerError: false, targetError: false, calls: [], mapCalls: 0, mapError: false };
  const forbidden = label => () => {
    state.forbiddenCalls.push(label);
    throw new Error(`Forbidden offline side effect: ${label}`);
  };
  const sessionDb = { query(sql, params, callback) {
    state.sessionQueries.push(sql);
    if (/SELECT/.test(sql)) {
      assert.match(sql, /INNER JOIN web_users/);
      assert.match(sql, /revoked_at IS NULL/);
      assert.match(sql, /expires_at > UTC_TIMESTAMP/);
      return callback(null, state.session === "valid" ? [{ session_id: 8,
        csrf_token_hash: hash(csrfToken), expires_at: "2099-01-01",
        user_id: 7, role: state.role, status: state.active ? "active" : "inactive" }] : []);
    }
    // Existing authentication bookkeeping is not complaint business SQL.
    assert.match(sql, /UPDATE web_admin_sessions\s+SET last_seen_at/);
    callback(null, { affectedRows: 1 });
  } };
  const sessionService = loadSource("services/webSessionService.js", {
    crypto, "../config/db": sessionDb
  }).exports;
  const webAuth = loadSource("middleware/webSessionAuth.js", {
    crypto, "../services/webSessionService": sessionService,
    "../config/webRoleCapabilities": require("../config/webRoleCapabilities")
  }).exports;
  const mobileGuard = forbidden("mobile guard on secured route");
  const complaintAuth = loadSource("middleware/complaintAuth.js", {
    "./webSessionAuth": webAuth,
    "./mobileSessionAuth": { requireMobileSession: mobileGuard }
  }).exports;
  const routes = [];
  const router = {};
  for (const method of ["get", "post", "put", "patch", "delete", "head", "all", "use"]) {
    router[method] = (routePath, ...handlers) => {
      routes.push({ method: method.toUpperCase(), path: routePath, handlers });
      return router;
    };
  }
  const db = { query(sql, params, callback) {
    assert.match(sql, /FROM complaint_notifications cn/);
    assert.match(sql, /INNER JOIN complaints c/);
    state.targetQueries.push({ sql, params });
    if (state.targetError) return callback(Object.assign(new Error("Synthetic lookup failure"), { code: "MOCK" }));
    callback(null, [{ id: 1, complaint_id: 11, target_type: "barangay",
      target_name: "Synthetic Barangay", status: "forwarded", assigned_barangay: "Synthetic Barangay" }]);
  } };
  const multer = () => ({ single: () => forbidden("upload") });
  multer.memoryStorage = () => ({});
  const loaded = loadSource("routes/complaintRoutes.js", {
    express: { Router: () => router }, path,
    fs: { existsSync: () => true, mkdirSync: forbidden("mkdir"), writeFile: forbidden("file write") },
    multer, cloudinary: { v2: { config: forbidden("cloud config") } },
    "../config/db": db,
    "../services/complaintWorkflowService": { ComplaintWorkflowService: class {} },
    "../middleware/complaintAuth": complaintAuth,
    "../middleware/webSessionAuth": webAuth,
    "../services/barangayBoundaryService": {},
    "../services/complaintMapDestinationService": { async resolveComplaintMapDestination(database, id) {
      assert.equal(database, db); assert.equal(id, "11"); state.mapCalls++;
      if (state.mapError) throw new Error("Synthetic internal error must not be exposed");
      return { success: true, complaint_id: 11, destination: null, label: "Needs Admin Confirmation" };
    } },
    "../controllers/notificationController": { createCitizenNotificationRecord: forbidden("notification") }
  }, { __dirname: path.join(root, "routes"),
    setTimeout: forbidden("timer"), setInterval: forbidden("interval"),
    clearTimeout: forbidden("clear timer"),
    mockWorker: async app => {
      state.workerCalls++;
      assert.equal(app.synthetic, true);
      if (state.workerError) throw new Error("Synthetic worker failure");
      return { processed: 2, synthetic: true };
    }
  });
  // Replace only the worker binding inside this isolated VM. The existing
  // maintenance HTTP handler and debug-target handler themselves run unchanged.
  vm.runInContext("markOverdueAcceptedComplaints = mockWorker", loaded.context);

  function matchingRoutes(method, url) {
    return routes.filter(route => {
      if (!(route.method === method || route.method === "ALL"
        || (method === "HEAD" && route.method === "GET"))) return false;
      const parts = route.path.split("/"), actual = url.split("/");
      return parts.length === actual.length && parts.every((part, i) => part.startsWith(":") || part === actual[i]);
    });
  }
  async function request(method, url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.signedIn !== false) headers.cookie = `wmo_admin_session=${sessionToken}`;
    if (options.csrf !== false) {
      headers.cookie = (headers.cookie ? headers.cookie + "; " : "") + `wmo_admin_csrf=${csrfToken}`;
      headers["x-csrf-token"] = options.csrf === "invalid" ? "wrong-synthetic-token" : csrfToken;
    }
    const req = { method, headers, params: { id: "11" }, body: options.body || {},
      query: { role: "super_admin" }, app: { synthetic: true } };
    const res = { statusCode: 200, headers: {}, body: undefined,
      set(key, value) { this.headers[key] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; } };
    const matches = matchingRoutes(method, url);
    assert.ok(matches.length, "Expected a registered route");
    async function run(handlers, i = 0) {
      if (i === handlers.length) return;
      let continuation;
      state.calls.push(handlers[i].name || "anonymous");
      await handlers[i](req, res, () => { continuation = run(handlers, i + 1); });
      await continuation;
    }
    await run(matches[0].handlers);
    assert.deepEqual(state.forbiddenCalls, []);
    return res;
  }
  return { state, routes, request, matchingRoutes, webAuth, mobileGuard };
}

for (const method of ["GET", "HEAD"]) {
  test(`${method} maintenance is 405, Allow POST, no auth/worker/preparation/SQL`, async () => {
    const h = harness();
    const res = await h.request(method, maintenancePath, { signedIn: false, csrf: false });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.Allow, "POST");
    assert.deepEqual(res.body, { success: false, message: "Method not allowed. Use POST." });
    assert.equal(h.state.workerCalls, 0);
    assert.deepEqual(h.state.targetQueries, []);
    assert.deepEqual(h.state.sessionQueries, []);
  });
}

test("actual registration order prevents GET/HEAD reaching a maintenance worker or generic route", () => {
  const h = harness();
  for (const method of ["GET", "HEAD"]) {
    const routes = h.matchingRoutes(method, maintenancePath);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].path, maintenancePath);
    assert.equal(routes[0].handlers.length, 1);
  }
  assert.ok(h.routes.findIndex(r => r.path === "/:id/notification-targets")
    < h.routes.findIndex(r => r.path === "/:id"));
  const post = h.routes.find(r => r.path === maintenancePath && r.method === "POST");
  assert.equal(post.handlers.length, 4);
  assert.equal(post.handlers[0], h.webAuth.requireWebAuth);
  assert.equal(post.handlers[1].name, "requireWebRoleMiddleware");
  assert.equal(post.handlers[2], h.webAuth.requireCsrf);
  assert.equal(post.handlers[3].name, "handleManualOverdueAcceptedCheck");
});

for (const scenario of [
  { name: "missing session", options: { signedIn: false }, status: 401 },
  { name: "expired/revoked session", session: "expired", status: 401 },
  { name: "inactive account", active: false, status: 403 },
  ...["barangay", "citizen", "personnel", "admin", "enforcer", "division_admin"].map(role => ({ name: role, role, status: 403 })),
  { name: "missing CSRF", options: { csrf: false }, status: 403 },
  { name: "invalid CSRF", options: { csrf: "invalid" }, status: 403 },
  { name: "spoofed identity without session", options: { signedIn: false,
    headers: { "x-role": "super_admin", authorization: "Bearer synthetic" },
    body: { role: "super_admin", user_id: 7, username: "admin" } }, status: 401 }
]) {
  test(`POST maintenance denies ${scenario.name} before any business handler/SQL`, async () => {
    const h = harness();
    if (scenario.role) h.state.role = scenario.role;
    if (scenario.session) h.state.session = scenario.session;
    if (scenario.active === false) h.state.active = false;
    const res = await h.request("POST", maintenancePath, scenario.options);
    assert.equal(res.statusCode, scenario.status);
    assert.equal(res.body.success, false);
    assert.equal(h.state.workerCalls, 0);
    assert.deepEqual(h.state.targetQueries, []);
    assert.ok(!h.state.calls.includes("handleManualOverdueAcceptedCheck"));
    if (scenario.role) assert.ok(!h.state.calls.includes("requireCsrf"));
  });
}

test("POST active super_admin with CSRF reaches original handler once with unchanged payload", async () => {
  const h = harness();
  const res = await h.request("POST", maintenancePath);
  assert.equal(res.statusCode, 200);
  assert.equal(h.state.workerCalls, 1);
  assert.equal(h.state.sessionQueries.length, 2);
  assert.deepEqual(res.body, { success: true, checked: true, processed: 2, synthetic: true,
    note: "Accepted complaints older than 24 hours are marked as accepted_overdue, not rejected. Zero-date DATETIME values are handled safely." });
  assert.deepEqual(h.state.calls.slice(0, 4), ["requireWebAuthMiddleware", "requireWebRoleMiddleware", "requireCsrf", "handleManualOverdueAcceptedCheck"]);
});

test("POST authorized worker failure retains existing failure response", async () => {
  const h = harness(); h.state.workerError = true;
  const res = await h.request("POST", maintenancePath);
  assert.equal(h.state.workerCalls, 1);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { success: false, checked: false,
    message: "Failed to check overdue accepted complaints.", error: "Synthetic worker failure" });
});

for (const role of [null, "barangay", "citizen", "personnel", "admin", "enforcer"]) {
  test(`notification-target GET denies ${role || "missing session"} before target SQL/output`, async () => {
    const h = harness(); if (role) h.state.role = role;
    const res = await h.request("GET", "/11/notification-targets", { signedIn: Boolean(role), csrf: false });
    assert.equal(res.statusCode, role ? 403 : 401);
    assert.equal(h.state.targetQueries.length, 0);
    assert.equal(h.state.workerCalls, 0);
    assert.equal(res.body.targets, undefined);
    assert.equal(res.body.complaint_id, undefined);
  });
}

test("notification-target GET Admin keeps response fields and needs no mutation CSRF", async () => {
  const h = harness();
  const res = await h.request("GET", "/11/notification-targets", { csrf: false });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, complaint_id: "11", targets: [{ id: 1,
    complaint_id: 11, target_type: "barangay", target_name: "Synthetic Barangay",
    status: "forwarded", assigned_barangay: "Synthetic Barangay" }] });
  assert.deepEqual([...h.state.targetQueries[0].params], ["11"]);
  assert.equal(h.state.targetQueries.length, 1);
  assert.equal(h.state.workerCalls, 0);
  const route = h.routes.find(r => r.path === "/:id/notification-targets");
  assert.equal(route.handlers.length, 3);
  assert.equal(route.handlers[0], h.webAuth.requireWebAuth);
  assert.ok(!route.handlers.includes(h.webAuth.requireCsrf));
});

test("notification-target lookup errors preserve existing failure shape", async () => {
  const h = harness(); h.state.targetError = true;
  const res = await h.request("GET", "/11/notification-targets", { csrf: false });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { success: false, message: "Failed to load complaint notification targets.",
    error: "Synthetic lookup failure", code: "MOCK" });
});

test("neighboring routes keep their Phase 1 guards and do not collide", () => {
  const h = harness();
  for (const [method, url, routePath] of [["GET", "/history/resolved", "/history/resolved"],
    ["GET", "/11", "/:id"], ["GET", "/assignment-options", "/assignment-options"],
    ["POST", "/11/validate-forward", "/:id/validate-forward"],
    ["PUT", "/11/wmo-resolve", "/:id/wmo-resolve"]]) {
    const route = h.matchingRoutes(method, url)[0];
    assert.equal(route.path, routePath);
    if (routePath !== "/:id") {
      assert.equal(route.handlers[0], h.webAuth.requireWebAuth);
      assert.equal(route.handlers[2], h.webAuth.requireCsrf);
    }
  }
  for (const routePath of ["/:id/accept", "/:id/cannot-accept", "/:id/resolve"]) {
    assert.equal(h.routes.find(r => r.path === routePath).handlers[0], h.mobileGuard);
  }
  assert.equal(h.routes.find(r => r.method === "POST" && r.path === "/").handlers.length, 2);
  assert.equal(h.routes.find(r => r.path === "/nearby-barangays").handlers.length, 1);
  assert.equal(h.routes.filter(r => r.method === "USE").length, 0);
  assert.deepEqual(h.state.forbiddenCalls, []);
});

for (const scenario of [
  { name: "missing session", options: { signedIn: false }, status: 401 },
  { name: "expired session", session: "expired", status: 401 },
  { name: "inactive account", active: false, status: 403 },
  ...["barangay", "citizen", "personnel", "enforcer", "division_admin"].map(role => ({ name: role, role, status: 403 }))
]) {
  test(`map destination denies ${scenario.name} before lookup`, async () => {
    const h = harness();
    if (scenario.role) h.state.role = scenario.role;
    if (scenario.session) h.state.session = scenario.session;
    if (scenario.active === false) h.state.active = false;
    const res = await h.request("GET", "/11/map-destination", scenario.options);
    assert.equal(res.statusCode, scenario.status); assert.equal(h.state.mapCalls, 0);
  });
}
test("map destination is read-only Admin GET with no-store and safe unavailable response", async () => {
  const h = harness();
  const res = await h.request("GET", "/11/map-destination", { csrf: false });
  assert.equal(res.statusCode, 200); assert.equal(h.state.mapCalls, 1);
  assert.equal(res.headers["Cache-Control"], "no-store");
  h.state.mapError = true;
  const failed = await h.request("GET", "/11/map-destination", { csrf: false });
  assert.equal(failed.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(failed.body), /Synthetic internal error/);
  assert.deepEqual(h.state.targetQueries, []); assert.equal(h.state.workerCalls, 0);
});
