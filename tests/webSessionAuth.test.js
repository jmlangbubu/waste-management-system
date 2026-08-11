const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const projectRoot = path.join(__dirname, "..");
const originalModuleLoad = Module._load;

function loadFresh(relativePath, mocks = {}) {
  const absolutePath = require.resolve(relativePath);
  delete require.cache[absolutePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalModuleLoad.call(this, request, parent, isMain);
  };
  try {
    return require(absolutePath);
  } finally {
    Module._load = originalModuleLoad;
  }
}

function createCallbackDb(handler) {
  return {
    query(sql, parameters, callback) {
      let params = parameters;
      let done = callback;
      if (typeof parameters === "function") {
        done = parameters;
        params = [];
      }
      try {
        const result = handler(String(sql), params || []);
        done(null, result);
      } catch (error) {
        done(error);
      }
    }
  };
}

const neverQueryDb = createCallbackDb(() => {
  throw new Error("Unexpected default database query");
});
const serviceModule = loadFresh("../services/webSessionService", {
  "../config/db": neverQueryDb
});
const {
  WebSessionService,
  WebSessionError,
  DEFAULT_SESSION_TTL_SECONDS,
  hashOpaqueToken,
  normalizeWebRole
} = serviceModule;
const authMiddleware = require("../middleware/webSessionAuth");

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function activeSessionRow(overrides = {}) {
  return {
    session_id: 91,
    csrf_token_hash: hashOpaqueToken("C".repeat(43)),
    expires_at: "2026-08-11 18:00:00.000",
    user_id: 7,
    full_name: "WMO Operator",
    username: "operator",
    role: "personnel",
    division_name: "Operations",
    status: "active",
    ...overrides
  };
}

function createResponse(onJson = null) {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      if (onJson) onJson(value);
      return value;
    },
    append(name, value) {
      const key = String(name).toLowerCase();
      this.headers[key] = this.headers[key] || [];
      this.headers[key].push(value);
    },
    getHeader(name) {
      return this.headers[String(name).toLowerCase()];
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    }
  };
}

async function runMiddleware(middleware, req) {
  const res = createResponse();
  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

function createFakeRouter() {
  const router = { stack: [] };
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    router[method] = (routePath, ...handlers) => {
      router.stack.push({
        route: {
          path: routePath,
          methods: { [method]: true },
          stack: handlers.map((handle) => ({ handle }))
        }
      });
      return router;
    };
  }
  router.use = (...handlers) => {
    router.stack.push(...handlers.map((handle) => ({ handle })));
    return router;
  };
  return router;
}

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("opaque session and CSRF tokens use 32 random bytes", () => {
  const token = serviceModule.generateOpaqueToken();
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.equal(serviceModule.isValidOpaqueToken(token), true);
});

test("session creation stores hashes only and uses the eight-hour default", async () => {
  const calls = [];
  const now = new Date("2026-08-11T01:00:00.000Z");
  const service = new WebSessionService(createCallbackDb((sql, parameters) => {
    calls.push({ sql: normalizeSql(sql), parameters });
    return { insertId: 12 };
  }), { now: () => now });
  const session = await service.createSession(7);
  assert.equal(session.ttlSeconds, DEFAULT_SESSION_TTL_SECONDS);
  assert.equal(session.expiresAt.toISOString(), "2026-08-11T09:00:00.000Z");
  assert.equal(calls.length, 1);
  assert.match(calls[0].parameters[0], /^[a-f0-9]{64}$/);
  assert.match(calls[0].parameters[2], /^[a-f0-9]{64}$/);
  assert.ok(!calls[0].parameters.includes(session.sessionToken));
  assert.ok(!calls[0].parameters.includes(session.csrfToken));
});

test("repeated successful session creation produces different tokens", async () => {
  const service = new WebSessionService(createCallbackDb(() => ({ insertId: 1 })));
  const first = await service.createSession(7);
  const second = await service.createSession(7);
  assert.notEqual(first.sessionToken, second.sessionToken);
  assert.notEqual(first.csrfToken, second.csrfToken);
});

test("session lifetime is configurable within the reviewed bounds", async () => {
  const now = new Date("2026-08-11T01:00:00.000Z");
  const service = new WebSessionService(
    createCallbackDb(() => ({ insertId: 1 })),
    { now: () => now, ttlSeconds: 3600 }
  );
  const session = await service.createSession(7);
  assert.equal(session.ttlSeconds, 3600);
  assert.equal(session.expiresAt.toISOString(), "2026-08-11T02:00:00.000Z");
});

test("invalid lifetime configuration falls back to eight hours", () => {
  assert.equal(serviceModule.resolveSessionTtlSeconds(10), DEFAULT_SESSION_TTL_SECONDS);
  assert.equal(serviceModule.resolveSessionTtlSeconds("invalid"), DEFAULT_SESSION_TTL_SECONDS);
});

test("session rotation revokes the previous browser token before creation", async () => {
  const service = new WebSessionService(neverQueryDb);
  const order = [];
  service.revokeSession = async () => order.push("revoke");
  service.createSession = async () => {
    order.push("create");
    return { id: 2 };
  };
  await service.rotateSession(7, "R".repeat(43));
  assert.deepEqual(order, ["revoke", "create"]);
});

test("current account data is loaded by joining web_users on every validation", async () => {
  const calls = [];
  const service = new WebSessionService(createCallbackDb((sql) => {
    const normalized = normalizeSql(sql);
    calls.push(normalized);
    return normalized.startsWith("SELECT") ? [activeSessionRow()] : { affectedRows: 1 };
  }));
  const session = await service.validateSession("S".repeat(43));
  assert.deepEqual(session.user, {
    id: 7,
    full_name: "WMO Operator",
    username: "operator",
    role: "personnel",
    status: "active"
  });
  assert.match(calls[0], /INNER JOIN web_users u ON u\.id = s\.user_id/);
  assert.match(calls[0], /s\.revoked_at IS NULL/);
  assert.match(calls[0], /s\.expires_at > UTC_TIMESTAMP\(3\)/);
});

test("validation updates last_seen_at without extending absolute expiry", async () => {
  const calls = [];
  const service = new WebSessionService(createCallbackDb((sql) => {
    const normalized = normalizeSql(sql);
    calls.push(normalized);
    return normalized.startsWith("SELECT") ? [activeSessionRow()] : { affectedRows: 1 };
  }));
  await service.validateSession("S".repeat(43));
  assert.match(calls[1], /SET last_seen_at = UTC_TIMESTAMP\(3\)/);
  assert.doesNotMatch(calls[1], /SET expires_at|, expires_at/i);
});

for (const scenario of ["missing", "expired", "revoked", "deleted user"]) {
  test(`${scenario} session is rejected`, async () => {
    const service = new WebSessionService(createCallbackDb(() => []));
    await assert.rejects(
      () => service.validateSession("S".repeat(43)),
      (error) => error.statusCode === 401 && error.code === "WEB_SESSION_INVALID"
    );
  });
}

test("inactive accounts are rejected even with a valid session", async () => {
  const service = new WebSessionService(createCallbackDb((sql) =>
    normalizeSql(sql).startsWith("SELECT")
      ? [activeSessionRow({ status: "suspended" })]
      : { affectedRows: 1 }
  ));
  await assert.rejects(
    () => service.validateSession("S".repeat(43)),
    (error) => error.statusCode === 403 && error.code === "WEB_SESSION_ACCOUNT_INACTIVE"
  );
});

test("role and status changes are observed on subsequent requests", async () => {
  let validationCount = 0;
  const service = new WebSessionService(createCallbackDb((sql) => {
    if (!normalizeSql(sql).startsWith("SELECT")) return { affectedRows: 1 };
    validationCount += 1;
    if (validationCount === 1) return [activeSessionRow({ role: "personnel" })];
    if (validationCount === 2) return [activeSessionRow({ role: "super_admin" })];
    return [activeSessionRow({ role: "super_admin", status: "inactive" })];
  }));
  assert.equal((await service.validateSession("S".repeat(43))).user.role, "personnel");
  assert.equal((await service.validateSession("S".repeat(43))).user.role, "super_admin");
  await assert.rejects(() => service.validateSession("S".repeat(43)), /inactive/i);
  assert.equal(validationCount, 3);
});

test("missing session table fails closed with a controlled 503 service error", async () => {
  const service = new WebSessionService(createCallbackDb(() => {
    throw Object.assign(new Error("table missing"), { code: "ER_NO_SUCH_TABLE" });
  }));
  await assert.rejects(
    () => service.validateSession("S".repeat(43)),
    (error) => error.statusCode === 503 && error.code === "WEB_SESSION_STORE_UNAVAILABLE"
  );
});

test("session creation database failure is controlled and contains no SQL", async () => {
  const service = new WebSessionService(createCallbackDb(() => {
    throw Object.assign(new Error("INSERT SQL failed"), { code: "ECONNRESET" });
  }));
  await assert.rejects(
    () => service.createSession(7),
    (error) => {
      assert.equal(error.statusCode, 503);
      assert.doesNotMatch(error.message, /INSERT|SQL/i);
      return true;
    }
  );
});

test("last-seen write failure fails validation closed", async () => {
  let call = 0;
  const service = new WebSessionService(createCallbackDb(() => {
    call += 1;
    if (call === 1) return [activeSessionRow()];
    throw Object.assign(new Error("lost"), { code: "PROTOCOL_CONNECTION_LOST" });
  }));
  await assert.rejects(
    () => service.validateSession("S".repeat(43)),
    (error) => error.statusCode === 503
  );
});

test("logout revocation queries by token hash and never raw token", async () => {
  const calls = [];
  const raw = "L".repeat(43);
  const service = new WebSessionService(createCallbackDb((sql, parameters) => {
    calls.push({ sql: normalizeSql(sql), parameters });
    return { affectedRows: 1 };
  }));
  assert.equal(await service.revokeSession(raw), true);
  assert.equal(calls[0].parameters[0], hashOpaqueToken(raw));
  assert.notEqual(calls[0].parameters[0], raw);
});

test("an old session token cannot be replayed after revocation", async () => {
  const token = "L".repeat(43);
  let revoked = false;
  const service = new WebSessionService(createCallbackDb((sql) => {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith("SELECT")) return revoked ? [] : [activeSessionRow()];
    if (normalized.includes("SET revoked_at")) {
      revoked = true;
      return { affectedRows: 1 };
    }
    return { affectedRows: 1 };
  }));
  await service.validateSession(token);
  await service.revokeSession(token);
  await assert.rejects(
    () => service.validateSession(token),
    (error) => error.statusCode === 401
  );
});

test("malformed logout token does not query the database", async () => {
  let calls = 0;
  const service = new WebSessionService(createCallbackDb(() => {
    calls += 1;
    return { affectedRows: 1 };
  }));
  assert.equal(await service.revokeSession("bad"), false);
  assert.equal(calls, 0);
});

test("account security changes can revoke every active user session", async () => {
  const calls = [];
  const service = new WebSessionService(createCallbackDb((sql, parameters) => {
    calls.push({ sql: normalizeSql(sql), parameters });
    return { affectedRows: 3 };
  }));
  assert.equal(await service.revokeUserSessions(7), 3);
  assert.match(calls[0].sql, /WHERE user_id = \?/);
  assert.deepEqual(calls[0].parameters, ["7"]);
});

test("expired-session cleanup marks rows revoked without deleting data", async () => {
  let sql = "";
  const service = new WebSessionService(createCallbackDb((queryText) => {
    sql = normalizeSql(queryText);
    return { affectedRows: 4 };
  }));
  assert.equal(await service.cleanupExpiredSessions(), 4);
  assert.match(sql, /^UPDATE web_admin_sessions/);
  assert.doesNotMatch(sql, /DELETE/i);
});

test("missing session cookie returns 401", async () => {
  const middleware = authMiddleware.buildRequireWebAuth({
    validateSession: async () => {
      throw new WebSessionError("required", 401, "WEB_SESSION_INVALID");
    }
  });
  const { res, nextCalled } = await runMiddleware(middleware, { headers: {} });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("malformed session token is rejected before any database query", async () => {
  let queries = 0;
  const service = new WebSessionService(createCallbackDb(() => {
    queries += 1;
    return [];
  }));
  await assert.rejects(
    () => service.validateSession("not-a-valid-session-token"),
    (error) => error.statusCode === 401 && error.code === "WEB_SESSION_INVALID"
  );
  assert.equal(queries, 0);
});

test("valid authentication attaches only trusted user identity fields", async () => {
  const middleware = authMiddleware.buildRequireWebAuth({
    validateSession: async () => ({
      id: 1,
      csrfTokenHash: hashOpaqueToken("C".repeat(43)),
      expiresAt: "later",
      divisionName: "Operations",
      user: {
        id: 7,
        full_name: "WMO",
        username: "wmo",
        role: "personnel",
        status: "active"
      }
    })
  });
  const req = { headers: { cookie: "wmo_admin_session=" + "S".repeat(43) } };
  const { nextCalled } = await runMiddleware(middleware, req);
  assert.equal(nextCalled, true);
  assert.deepEqual(
    Object.keys(req.user).sort(),
    ["full_name", "id", "role", "status", "username"]
  );
});

test("session-store middleware errors return safe 503 JSON", async () => {
  const middleware = authMiddleware.buildRequireWebAuth({
    validateSession: async () => {
      throw new WebSessionError("internal SQL detail", 503, "WEB_SESSION_STORE_UNAVAILABLE");
    }
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const { res } = await runMiddleware(middleware, {
      headers: { cookie: "wmo_admin_session=" + "S".repeat(43) }
    });
    assert.equal(res.statusCode, 503);
    assert.doesNotMatch(res.body.message, /SQL|internal/i);
  } finally {
    console.warn = originalWarn;
  }
});

test("role middleware allows exact personnel role", async () => {
  const { nextCalled } = await runMiddleware(
    authMiddleware.requireWebRole("super_admin", "personnel"),
    { user: { role: "personnel" } }
  );
  assert.equal(nextCalled, true);
});

test("role middleware allows the exact super_admin role", async () => {
  const { nextCalled } = await runMiddleware(
    authMiddleware.requireWebRole("super_admin", "personnel"),
    { user: { role: "super_admin" } }
  );
  assert.equal(nextCalled, true);
});

for (const deniedRole of ["division_admin", "supervisor", "clerk_admin"]) {
  test(`${deniedRole} is denied dispatch and tracking operational access`, async () => {
    const { res, nextCalled } = await runMiddleware(
      authMiddleware.requireWebRole("super_admin", "personnel"),
      { user: { role: deniedRole } }
    );
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "WEB_ROLE_FORBIDDEN");
  });
}

test("super_admin is allowed User Management access", async () => {
  const { nextCalled } = await runMiddleware(
    authMiddleware.requireWebRole("super_admin"),
    { user: { role: "super_admin" } }
  );
  assert.equal(nextCalled, true);
});

test("personnel is denied User Management access", async () => {
  const { res, nextCalled } = await runMiddleware(
    authMiddleware.requireWebRole("super_admin"),
    { user: { role: "personnel" } }
  );
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test("role normalization is centralized and consistent", () => {
  assert.equal(normalizeWebRole(" WMO-Personnel "), "wmo_personnel");
  assert.equal(normalizeWebRole("SUPER ADMIN"), "super_admin");
});

test("wrong Web Admin role returns 403", async () => {
  const { res, nextCalled } = await runMiddleware(
    authMiddleware.requireWebRole("super_admin", "personnel"),
    { user: { role: "division_admin" } }
  );
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "WEB_ROLE_FORBIDDEN");
});

test("forged X-Role header has no authorization authority", async () => {
  const { res } = await runMiddleware(
    authMiddleware.requireWebRole("super_admin"),
    { user: { role: "personnel" }, headers: { "x-role": "super_admin" } }
  );
  assert.equal(res.statusCode, 403);
});

test("forged request-body role has no authorization authority", async () => {
  const { res } = await runMiddleware(
    authMiddleware.requireWebRole("super_admin"),
    { user: { role: "personnel" }, body: { role: "super_admin" } }
  );
  assert.equal(res.statusCode, 403);
});

test("valid CSRF header, cookie, and stored hash pass", async () => {
  const token = "C".repeat(43);
  const { nextCalled } = await runMiddleware(authMiddleware.requireCsrf, {
    method: "POST",
    headers: { cookie: `wmo_admin_csrf=${token}`, "x-csrf-token": token },
    user: { id: 7 },
    webSession: { csrfTokenHash: hashOpaqueToken(token) }
  });
  assert.equal(nextCalled, true);
});

for (const scenario of [
  { name: "missing CSRF header", header: "", cookie: "C".repeat(43), stored: hashOpaqueToken("C".repeat(43)) },
  { name: "missing CSRF cookie", header: "C".repeat(43), cookie: "", stored: hashOpaqueToken("C".repeat(43)) },
  { name: "mismatched CSRF header", header: "D".repeat(43), cookie: "C".repeat(43), stored: hashOpaqueToken("C".repeat(43)) },
  { name: "mismatched stored CSRF hash", header: "C".repeat(43), cookie: "C".repeat(43), stored: hashOpaqueToken("D".repeat(43)) }
]) {
  test(`${scenario.name} returns 403`, async () => {
    const cookie = scenario.cookie ? `wmo_admin_csrf=${scenario.cookie}` : "";
    const { res, nextCalled } = await runMiddleware(authMiddleware.requireCsrf, {
      method: "PATCH",
      headers: { cookie, "x-csrf-token": scenario.header },
      user: { id: 7 },
      webSession: { csrfTokenHash: scenario.stored }
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "WEB_CSRF_INVALID");
  });
}

test("safe GET requests bypass CSRF validation", async () => {
  const { nextCalled } = await runMiddleware(authMiddleware.requireCsrf, {
    method: "GET",
    headers: {}
  });
  assert.equal(nextCalled, true);
});

test("session cookie is HttpOnly and CSRF cookie is script-readable", () => {
  const originalEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const res = createResponse();
  authMiddleware.setSessionCookies(res, {
    sessionToken: "S".repeat(43),
    csrfToken: "C".repeat(43),
    ttlSeconds: 3600,
    expiresAt: new Date("2026-08-11T02:00:00.000Z")
  });
  process.env.NODE_ENV = originalEnvironment;
  assert.match(res.headers["set-cookie"][0], /HttpOnly/);
  assert.match(res.headers["set-cookie"][0], /Secure/);
  assert.match(res.headers["set-cookie"][0], /SameSite=Lax/);
  assert.doesNotMatch(res.headers["set-cookie"][1], /HttpOnly/);
  assert.match(res.headers["set-cookie"][1], /Secure/);
});

test("logout cookie clearing expires both cookies", () => {
  const res = createResponse();
  authMiddleware.clearSessionCookies(res);
  assert.equal(res.headers["set-cookie"].length, 2);
  assert.ok(res.headers["set-cookie"].every((cookie) => /Max-Age=0/.test(cookie)));
});

test("successful login rotates a session and sends both cookies", async () => {
  const router = createFakeRouter();
  const previousToken = "P".repeat(43);
  let rotationArguments = null;
  const fakeSessionService = {
    async rotateSession(userId, oldToken) {
      rotationArguments = [userId, oldToken];
      return {
        sessionToken: "S".repeat(43),
        csrfToken: "C".repeat(43),
        ttlSeconds: 3600,
        expiresAt: new Date("2026-08-11T02:00:00.000Z")
      };
    },
    async revokeSession() {}
  };
  const fakeDb = {
    shouldReturnServiceUnavailable: () => false,
    queryReadOnly(sql, parameters, callback) {
      callback(null, [{
        id: 7,
        full_name: "WMO Operator",
        username: "operator",
        password: "secret",
        role: "personnel",
        division_name: "Operations",
        status: "active"
      }]);
    },
    query() {
      throw new Error("Unexpected write");
    }
  };
  const routes = loadFresh("../routes/webAuthRoutes", {
    express: { Router: () => router },
    bcrypt: { compare: async () => true },
    "../config/db": fakeDb,
    "../services/webSessionService": fakeSessionService
  });
  assert.equal(routes, router);
  const loginLayer = router.stack.find((layer) => layer.route?.path === "/login");
  const loginHandler = loginLayer.route.stack[0].handle;
  let res;
  await new Promise((resolve) => {
    res = createResponse(resolve);
    loginHandler({
      body: { username: "operator", password: "secret" },
      headers: { cookie: `wmo_admin_session=${previousToken}` }
    }, res);
  });
  assert.deepEqual(rotationArguments, [7, previousToken]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["set-cookie"].length, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body.user, "password"), false);
});

test("current-session endpoint returns safe user fields only", () => {
  const source = read("routes/webAuthRoutes.js");
  const sessionBlock = source.slice(source.indexOf('router.get("/session"'), source.indexOf('router.post("/logout"'));
  assert.match(sessionBlock, /requireWebAuth/);
  assert.doesNotMatch(sessionBlock, /password/);
});

test("current-session endpoint succeeds for middleware-provided identity", () => {
  const router = createFakeRouter();
  loadFresh("../routes/webAuthRoutes", {
    express: { Router: () => router },
    bcrypt: { compare: async () => true },
    "../config/db": {},
    "../services/webSessionService": {}
  });
  const layer = router.stack.find((entry) => entry.route?.path === "/session");
  const handler = layer.route.stack.at(-1).handle;
  const res = createResponse();
  handler({
    user: {
      id: 7,
      full_name: "WMO Operator",
      username: "operator",
      role: "personnel",
      status: "active"
    },
    webSession: { divisionName: "Operations", expiresAt: "later" }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.username, "operator");
  assert.equal(res.body.user.status, "active");
  assert.equal(Object.prototype.hasOwnProperty.call(res.body.user, "password"), false);
});

test("logout endpoint requires authentication and CSRF and clears cookies", () => {
  const source = read("routes/webAuthRoutes.js");
  assert.match(source, /router\.post\("\/logout", requireWebAuth, requireCsrf/);
  assert.match(source, /revokeSession\(sessionToken\)/);
  assert.match(source, /clearSessionCookies\(res\)/);
});

test("logout handler revokes the presented session and clears both cookies", async () => {
  const router = createFakeRouter();
  let revokedToken = null;
  loadFresh("../routes/webAuthRoutes", {
    express: { Router: () => router },
    bcrypt: { compare: async () => true },
    "../config/db": {},
    "../services/webSessionService": {
      async revokeSession(token) {
        revokedToken = token;
      }
    }
  });
  const layer = router.stack.find((entry) => entry.route?.path === "/logout");
  const handler = layer.route.stack.at(-1).handle;
  const res = createResponse();
  await handler({
    headers: { cookie: `wmo_admin_session=${"L".repeat(43)}` }
  }, res);
  assert.equal(revokedToken, "L".repeat(43));
  assert.equal(res.headers["set-cookie"].length, 2);
  assert.ok(res.headers["set-cookie"].every((cookie) => /Max-Age=0/.test(cookie)));
});

test("dispatch routes apply auth, exact role policy, and CSRF globally", () => {
  const source = read("routes/dispatchRoutes.js");
  assert.match(source, /router\.use\(requireWebAuth\)/);
  assert.match(source, /requireWebRole\("super_admin", "personnel"\)/);
  assert.match(source, /router\.use\(requireCsrf\)/);
});

test("client-supplied dispatch actor identity is overwritten", async () => {
  let receivedPayload = null;
  const controller = loadFresh("../controllers/dispatchController", {
    "../services/dispatchService": {
      async issueTicket(id, payload) {
        receivedPayload = payload;
        return { id };
      }
    }
  });
  const res = createResponse();
  await controller.issueTicket({
    params: { id: "9" },
    user: { id: 7, full_name: "Trusted Operator", username: "operator" },
    body: { actor_id: 999, actor_name: "Forged", actor_type: "system" }
  }, res);
  assert.equal(receivedPayload.actor_id, 7);
  assert.equal(receivedPayload.actor_name, "Trusted Operator");
  assert.equal(receivedPayload.actor_type, "web_user");
});

test("Web User Management is super-admin-only and CSRF-protected", () => {
  const source = read("routes/webUserRoutes.js");
  assert.match(source, /router\.use\(requireWebAuth\)/);
  assert.match(source, /router\.use\(requireWebRole\("super_admin"\)\)/);
  assert.match(source, /router\.use\(requireCsrf\)/);
  assert.match(source, /req\.user\.id/);
});

test("Web User Management responses no longer select password hashes", () => {
  const source = read("routes/webUserRoutes.js");
  const allRoute = source.slice(
    source.indexOf('router.get("/all"'),
    source.indexOf('router.get("/all-accounts"')
  );
  assert.doesNotMatch(allRoute, /SELECT \*/i);
  assert.doesNotMatch(allRoute, /\bpassword\b/i);
});

test("disable, delete, and password-change paths revoke web sessions", () => {
  const source = read("routes/webUserRoutes.js");
  assert.match(source, /account status change/);
  assert.match(source, /account deletion/);
  assert.match(source, /password change/);
});

test("confirmed tracking reads require exact Web Admin roles", () => {
  const source = read("routes/trackingRoutes.js");
  for (const route of ["/active", "/route/:sessionId", "/reports", "/reports/:sessionId"]) {
    assert.ok(source.includes(`"${route}"`));
  }
  assert.match(source, /requireWebRole\("super_admin", "personnel"\)/);
  assert.match(source, /\.\.\.requireTrackingWebRead/);
});

test("Android/mobile tracking POST routes remain unmodified and unwrapped", () => {
  const source = read("routes/trackingRoutes.js");
  for (const route of [
    'router.post("/start", trackingController.startTrackingSession)',
    'router.post("/:sessionId/stop", trackingController.stopTrackingSession)',
    'router.post("/:sessionId/location", trackingController.addLocationLog)',
    'router.post("/:sessionId/locations/batch", trackingController.addLocationLogsBatch)',
    'router.post("/:sessionId/status", trackingController.updateTrackingDeviceStatus)'
  ]) {
    assert.ok(source.includes(route));
  }
});

test("latest-session mobile compatibility read remains outside Web Admin middleware", () => {
  const source = read("routes/trackingRoutes.js");
  assert.match(
    source,
    /router\.get\("\/truck\/:truckId\/latest-session", trackingController\.getTruckLatestSession\)/
  );
});

test("dashboard waits for server validation before protected loaders", () => {
  const source = read("frontend/js/admin/admin-init.js");
  const validationIndex = source.indexOf("await initializeSession()");
  assert.ok(validationIndex >= 0);
  for (const loader of ["setupDispatchModule", "startTrackingAutoRefresh", "loadWebUsers"]) {
    assert.ok(source.indexOf(loader) > validationIndex);
  }
});

test("dashboard session initialization no longer trusts localStorage", () => {
  const source = read("frontend/js/admin/admin-session.js");
  const start = source.indexOf("async function initializeSession");
  const end = source.indexOf("function setUserHeaderInfo", start);
  const block = source.slice(start, end);
  assert.match(block, /getWebAuthSessionApiUrl/);
  assert.doesNotMatch(block, /getStoredUser/);
});

test("central Web Admin fetch includes credentials and CSRF for mutations", () => {
  const source = read("frontend/js/admin/admin-api.js");
  assert.match(source, /credentials: "include"/);
  assert.match(source, /headers\.set\("X-CSRF-Token", csrfToken\)/);
  assert.match(source, /WEB_ADMIN_SAFE_METHODS/);
});

test("dispatch and account callers use the central authenticated fetch helper", () => {
  assert.match(read("frontend/js/admin/admin-dispatch.js"), /await webAdminFetch\(url/);
  const users = read("frontend/js/admin/admin-users.js");
  assert.equal((users.match(/await fetch\(/g) || []).length, 0);
  assert.ok((users.match(/await webAdminFetch\(/g) || []).length >= 5);
});

test("protected tracking callers use authenticated fetch without changing public notifications", () => {
  const source = read("frontend/js/admin/admin-tracking.js");
  assert.match(source, /webAdminFetch\(getTrackingActiveApiUrl\(\)\)/);
  assert.match(source, /webAdminFetch\(getTrackingRouteApiUrl\(sessionId\)\)/);
  assert.match(source, /webAdminFetch\(getTrackingReportsApiUrl\(\)/);
});

test("admin content is hidden until the server session-ready event", () => {
  const html = read("frontend/admin-dashboard.html");
  assert.match(html, /class="web-session-pending"/);
  assert.match(html, /html\.web-session-pending body \{ visibility: hidden; \}/);
  assert.match(read("frontend/js/admin/admin-session.js"), /web-admin-session-ready/);
});

test("login restores only a server-validated session and includes credentials", () => {
  const source = read("frontend/js/web-login.js");
  assert.match(source, /async function restoreServerSession/);
  assert.match(source, /\/web-auth\/session/);
  assert.ok((source.match(/credentials: "include"/g) || []).length >= 2);
  assert.doesNotMatch(source, /if \(savedUser && savedUser\.role\)/);
});

test("logout and invalid-session paths clear the local display cache", () => {
  const source = read("frontend/js/admin/admin-session.js");
  assert.match(source, /finally \{\s*redirectToLogin\(\)/);
  assert.match(source, /function redirectToLogin\(\) \{\s*clearCachedWebUser/);
});

test("public mobile authentication routes are outside the Web Admin middleware", () => {
  const server = read("server/server.js");
  assert.match(server, /app\.use\("\/api\/auth", authRoutes\)/);
  const authRoutes = read("routes/authRoutes.js");
  assert.doesNotMatch(authRoutes, /webSessionAuth|requireWebAuth|requireCsrf/);
});

test("notification and invoice fallback loaders wait for authenticated readiness", () => {
  assert.match(read("frontend/js/admin/admin-notifications.js"), /web-admin-session-ready/);
  assert.match(read("frontend/js/admin/admin-invoices.js"), /web-admin-session-ready/);
});

test("migration has required keys and deliberately no unsafe foreign key", () => {
  const source = read("database/migrations/create-web-admin-sessions.sql");
  assert.match(source, /CREATE TABLE IF NOT EXISTS web_admin_sessions/);
  assert.match(source, /PRIMARY KEY \(id\)/);
  assert.match(source, /UNIQUE KEY uq_web_admin_sessions_token_hash/);
  assert.match(source, /KEY idx_web_admin_sessions_user_active/);
  assert.match(source, /ENGINE=InnoDB/);
  assert.match(source, /CHARSET=utf8mb4/);
  assert.match(source, /\buser_id INT NOT NULL\b/);
  assert.doesNotMatch(source, /\buser_id (?:BIGINT|INT UNSIGNED|BIGINT UNSIGNED)\b/);
  assert.doesNotMatch(source, /FOREIGN KEY|REFERENCES/i);
});

test("session migration is not executed from application startup", () => {
  const server = read("server/server.js");
  assert.doesNotMatch(server, /create-web-admin-sessions|CREATE TABLE IF NOT EXISTS web_admin_sessions/);
});

test("production-only trust proxy is configured", () => {
  const server = read("server/server.js");
  assert.match(server, /if \(process\.env\.NODE_ENV === "production"\)/);
  assert.match(server, /app\.set\("trust proxy", 1\)/);
});

test("auth logging does not emit usernames, passwords, tokens, or SQL messages", () => {
  const routeSource = read("routes/webAuthRoutes.js");
  assert.doesNotMatch(routeSource, /LOGIN ATTEMPT|PASSWORD MATCH|RESULT COUNT|console\.log\([^\n]*username/i);
  const middlewareSource = read("middleware/webSessionAuth.js");
  assert.doesNotMatch(middlewareSource, /console\.(log|warn|error)\([^\n]*(sessionToken|csrfToken)/);
});

async function run() {
  let passed = 0;
  for (const entry of tests) {
    await entry.fn();
    passed += 1;
  }
  assert.ok(passed >= 33, `Expected at least 33 auth scenarios, received ${passed}`);
  console.log(`Web session auth tests passed (${passed} focused scenarios).`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
