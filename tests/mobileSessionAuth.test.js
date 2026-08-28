const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");

const dbModulePath = require.resolve("../config/db");
require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: {
    query() {
      throw new Error("The default database must not be used by focused tests.");
    }
  }
};

function createExpressTestDouble() {
  return {
    Router() {
      const router = {
        stack: [],
        use(...handlers) {
          this.stack.push({ handlers });
          return this;
        },
        get(routePath, ...handlers) {
          this.stack.push({
            route: {
              path: routePath,
              methods: { get: true },
              stack: handlers.map((handle) => ({ handle }))
            }
          });
          return this;
        },
        post(routePath, ...handlers) {
          this.stack.push({
            route: {
              path: routePath,
              methods: { post: true },
              stack: handlers.map((handle) => ({ handle }))
            }
          });
          return this;
        }
      };
      return router;
    }
  };
}

const originalModuleLoad = Module._load;
Module._load = function loadWithExpressTestDouble(request, parent, isMain) {
  if (request === "express") return createExpressTestDouble();
  return originalModuleLoad.call(this, request, parent, isMain);
};
const {
  MobileSessionService,
  DEFAULT_SESSION_TTL_SECONDS,
  TOKEN_BYTES,
  hashOpaqueToken,
  isValidOpaqueToken
} = require("../services/mobileSessionService");
const {
  buildRequireMobileSession
} = require("../middleware/mobileSessionAuth");
const {
  createMobileAuthRouter
} = require("../routes/mobileAuthRoutes");
Module._load = originalModuleLoad;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function parseMysqlUtc(value) {
  return new Date(String(value).replace(" ", "T") + "Z");
}

class MemoryMobileSessionDatabase {
  constructor(now = new Date("2026-08-28T00:00:00.000Z")) {
    this.now = now;
    this.users = new Map([
      [
        7,
        {
          id: 7,
          full_name: "Mobile User",
          username: "mobile.user",
          role: "enforcer",
          mobile_role: "enforcer",
          status: "active"
        }
      ]
    ]);
    this.sessions = [];
    this.nextId = 1;
    this.queries = [];
    this.lastSeenWrites = 0;
  }

  query(sql, parameters, callback) {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    const params = Array.isArray(parameters) ? parameters : [];
    this.queries.push({ sql: normalized, parameters: params });

    if (normalized.startsWith("INSERT INTO mobile_user_sessions")) {
      const tokenHash = params[0];
      if (this.sessions.some((session) => session.session_token_hash === tokenHash)) {
        const error = new Error("duplicate token hash");
        error.code = "ER_DUP_ENTRY";
        callback(error);
        return;
      }
      const session = {
        id: this.nextId++,
        session_token_hash: tokenHash,
        user_id: params[1],
        device_id: params[2],
        created_at: parseMysqlUtc(params[3]),
        last_seen_at: parseMysqlUtc(params[4]),
        expires_at: parseMysqlUtc(params[5]),
        revoked_at: null
      };
      this.sessions.push(session);
      callback(null, { insertId: session.id, affectedRows: 1 });
      return;
    }

    if (normalized.startsWith("SELECT") && normalized.includes("mobile_user_sessions")) {
      const tokenHash = params[0];
      const session = this.sessions.find(
        (candidate) =>
          candidate.session_token_hash === tokenHash &&
          candidate.revoked_at === null &&
          candidate.expires_at.getTime() > this.now.getTime()
      );
      const user = session ? this.users.get(session.user_id) : null;
      callback(
        null,
        session && user
          ? [
              {
                session_id: session.id,
                device_id: session.device_id,
                expires_at: session.expires_at,
                last_seen_at: session.last_seen_at,
                should_refresh_last_seen:
                  session.last_seen_at.getTime() <=
                  this.now.getTime() - 10 * 60 * 1000
                    ? 1
                    : 0,
                user_id: user.id,
                full_name: user.full_name,
                username: user.username,
                role: user.role,
                mobile_role: user.mobile_role,
                status: user.status
              }
            ]
          : []
      );
      return;
    }

    if (normalized.includes("SET last_seen_at = UTC_TIMESTAMP(3)")) {
      const session = this.sessions.find((candidate) => candidate.id === params[0]);
      const threshold = this.now.getTime() - 10 * 60 * 1000;
      if (
        session &&
        session.revoked_at === null &&
        session.expires_at.getTime() > this.now.getTime() &&
        session.last_seen_at.getTime() <= threshold
      ) {
        session.last_seen_at = new Date(this.now);
        this.lastSeenWrites += 1;
        callback(null, { affectedRows: 1 });
      } else {
        callback(null, { affectedRows: 0 });
      }
      return;
    }

    if (normalized.includes("SET revoked_at = COALESCE")) {
      const session = this.sessions.find(
        (candidate) =>
          candidate.session_token_hash === params[0] &&
          candidate.revoked_at === null
      );
      if (session) {
        session.revoked_at = new Date(this.now);
        callback(null, { affectedRows: 1 });
      } else {
        callback(null, { affectedRows: 0 });
      }
      return;
    }

    callback(new Error(`Unexpected SQL in mobile session test: ${normalized}`));
  }
}

function createService(database, tokenFactory) {
  return new MobileSessionService(database, {
    now: () => new Date(database.now),
    tokenFactory
  });
}

function responseStub(resolve) {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    json(body) {
      this.body = body;
      resolve(this);
      return this;
    }
  };
}

function runMiddleware(middleware, req = {}) {
  return new Promise((resolve, reject) => {
    const res = responseStub(resolve);
    Promise.resolve(
      middleware(
        { headers: {}, body: {}, query: {}, ...req },
        res,
        () => resolve({ nextCalled: true, req, res })
      )
    ).catch(reject);
  });
}

function runRoute(router, method, routePath, req = {}) {
  const layer = router.stack.find(
    (candidate) =>
      candidate.route &&
      candidate.route.path === routePath &&
      candidate.route.methods[method.toLowerCase()]
  );
  assert.ok(layer, `Expected ${method} ${routePath}`);

  return new Promise((resolve, reject) => {
    const request = {
      method,
      headers: {},
      body: {},
      query: {},
      ...req
    };
    const res = responseStub(resolve);
    let index = 0;
    const next = (error) => {
      if (error) {
        reject(error);
        return;
      }
      const routeLayer = layer.route.stack[index++];
      if (!routeLayer) {
        reject(new Error(`Route ${method} ${routePath} did not send a response.`));
        return;
      }
      try {
        Promise.resolve(routeLayer.handle(request, res, next)).catch(reject);
      } catch (routeError) {
        reject(routeError);
      }
    };
    next();
  });
}

test("login session creation returns a 256-bit opaque token and stores only its hash", async () => {
  const database = new MemoryMobileSessionDatabase();
  const service = createService(database);
  const session = await service.createMobileSession(7, "device-7");

  assert.equal(TOKEN_BYTES, 32);
  assert.equal(isValidOpaqueToken(session.token), true);
  assert.equal(session.token.length, 43);
  assert.equal(database.sessions.length, 1);
  assert.equal(database.sessions[0].session_token_hash, hashOpaqueToken(session.token));
  assert.notEqual(database.sessions[0].session_token_hash, session.token);
  assert.equal(database.sessions[0].session_token_hash.length, 64);
  assert.equal(database.sessions[0].device_id, "device-7");
  assert.equal(
    session.expiresAt.getTime() - database.now.getTime(),
    DEFAULT_SESSION_TTL_SECONDS * 1000
  );
});

test("independent sessions receive distinct URL-safe tokens and hashes", async () => {
  const database = new MemoryMobileSessionDatabase();
  const service = createService(database);
  const tokens = [];
  for (let index = 0; index < 8; index += 1) {
    tokens.push((await service.createMobileSession(7)).token);
  }
  assert.equal(new Set(tokens).size, tokens.length);
  assert.equal(
    new Set(database.sessions.map((session) => session.session_token_hash)).size,
    tokens.length
  );
  assert.ok(tokens.every(isValidOpaqueToken));
});

test("a duplicate token hash is discarded and regenerated before response", async () => {
  const database = new MemoryMobileSessionDatabase();
  const tokens = ["A".repeat(43), "B".repeat(43)];
  database.sessions.push({
    id: 99,
    session_token_hash: hashOpaqueToken(tokens[0]),
    user_id: 7,
    device_id: null,
    created_at: database.now,
    last_seen_at: database.now,
    expires_at: new Date(database.now.getTime() + 60_000),
    revoked_at: null
  });
  const service = createService(database, () => tokens.shift());
  const session = await service.createMobileSession(7);
  assert.equal(session.token, "B".repeat(43));
  assert.equal(database.sessions.at(-1).session_token_hash, hashOpaqueToken(session.token));
});

test("a valid bearer token authenticates the database user", async () => {
  const database = new MemoryMobileSessionDatabase();
  const service = createService(database);
  const created = await service.createMobileSession(7);
  const authenticated = await service.authenticateMobileSession(created.token);
  assert.equal(authenticated.user.id, 7);
  assert.equal(authenticated.user.username, "mobile.user");
  assert.equal(authenticated.user.role, "enforcer");
});

test("missing and malformed bearer headers are rejected before service lookup", async () => {
  let calls = 0;
  const middleware = buildRequireMobileSession({
    async authenticateMobileSession() {
      calls += 1;
    }
  });
  const missing = await runMiddleware(middleware, { headers: {} });
  const malformed = await runMiddleware(middleware, {
    headers: { authorization: "Basic abc" }
  });
  const malformedToken = await runMiddleware(middleware, {
    headers: { authorization: "Bearer abc" }
  });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.body.code, "MOBILE_SESSION_REQUIRED");
  assert.equal(malformed.statusCode, 401);
  assert.equal(malformed.body.code, "MOBILE_SESSION_MALFORMED");
  assert.equal(malformedToken.statusCode, 401);
  assert.equal(malformedToken.body.code, "MOBILE_SESSION_MALFORMED");
  assert.equal(calls, 0);
});

test("random, expired, and revoked tokens are rejected", async () => {
  const database = new MemoryMobileSessionDatabase();
  const service = createService(database);
  const middleware = buildRequireMobileSession(service);
  const unknown = await runMiddleware(middleware, {
    headers: { authorization: `Bearer ${"Z".repeat(43)}` }
  });
  assert.equal(unknown.statusCode, 401);

  const expired = await service.createMobileSession(7);
  database.sessions.at(-1).expires_at = new Date(database.now.getTime() - 1);
  const expiredResponse = await runMiddleware(middleware, {
    headers: { authorization: `Bearer ${expired.token}` }
  });
  assert.equal(expiredResponse.statusCode, 401);

  const revoked = await service.createMobileSession(7);
  await service.revokeMobileSession(revoked.token);
  const revokedResponse = await runMiddleware(middleware, {
    headers: { authorization: `Bearer ${revoked.token}` }
  });
  assert.equal(revokedResponse.statusCode, 401);
});

test("inactive users are rejected with the existing forbidden convention", async () => {
  const database = new MemoryMobileSessionDatabase();
  const service = createService(database);
  const created = await service.createMobileSession(7);
  database.users.get(7).status = "inactive";
  const response = await runMiddleware(buildRequireMobileSession(service), {
    headers: { authorization: `Bearer ${created.token}` }
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, "MOBILE_SESSION_ACCOUNT_INACTIVE");
});

test("a deleted user can no longer authenticate an otherwise active session", async () => {
  const database = new MemoryMobileSessionDatabase();
  const service = createService(database);
  const created = await service.createMobileSession(7);
  database.users.delete(7);
  await assert.rejects(
    () => service.authenticateMobileSession(created.token),
    (error) => error.statusCode === 401 && error.code === "MOBILE_SESSION_INVALID"
  );
});

test("mobile me returns only the authenticated safe identity and ignores impersonation input", async () => {
  const database = new MemoryMobileSessionDatabase();
  const service = createService(database);
  const created = await service.createMobileSession(7);
  const router = createMobileAuthRouter(service);
  const response = await runRoute(router, "GET", "/me", {
    headers: { authorization: `Bearer ${created.token}` },
    body: { user_id: 999 },
    query: { user_id: "999" }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.body.user).sort(), [
    "full_name",
    "id",
    "mobile_role",
    "role",
    "status",
    "username"
  ]);
  assert.equal(response.body.user.id, 7);
  assert.equal(response.body.user.password, undefined);
});

test("logout revokes only the presented session, is repeat-safe, and leaves a second session valid", async () => {
  const database = new MemoryMobileSessionDatabase();
  const service = createService(database);
  const first = await service.createMobileSession(7, "phone-one");
  const second = await service.createMobileSession(7, "phone-two");
  const router = createMobileAuthRouter(service);
  const request = { headers: { authorization: `Bearer ${first.token}` } };

  const firstLogout = await runRoute(router, "POST", "/logout", request);
  const repeatedLogout = await runRoute(router, "POST", "/logout", request);
  assert.equal(firstLogout.statusCode, 200);
  assert.equal(repeatedLogout.statusCode, 200);
  await assert.rejects(
    () => service.authenticateMobileSession(first.token),
    (error) => error.statusCode === 401
  );
  const stillValid = await service.authenticateMobileSession(second.token);
  assert.equal(stillValid.user.id, 7);
});

test("last_seen writes are skipped until the ten-minute throttle elapses", async () => {
  const database = new MemoryMobileSessionDatabase();
  const service = createService(database);
  const created = await service.createMobileSession(7);
  await service.authenticateMobileSession(created.token);
  assert.equal(database.lastSeenWrites, 0);

  database.now = new Date(database.now.getTime() + 9 * 60 * 1000);
  await service.authenticateMobileSession(created.token);
  assert.equal(database.lastSeenWrites, 0);

  database.now = new Date(database.now.getTime() + 2 * 60 * 1000);
  await service.authenticateMobileSession(created.token);
  assert.equal(database.lastSeenWrites, 1);
  assert.match(
    database.queries.at(-1).sql,
    /INTERVAL 10 MINUTE/
  );
});

test("login response keeps the existing contract and adds mobile_session after secure creation", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "routes", "authRoutes.js"),
    "utf8"
  );
  assert.match(source, /success:\s*true,\s*message:\s*"Login successful",\s*user:\s*responseUser,/);
  assert.match(source, /mobile_session:\s*\{\s*token:\s*mobileSession\.token,/);
  assert.match(source, /await mobileSessionService\.createMobileSession/);
  assert.ok(
    source.indexOf("await mobileSessionService.createMobileSession") <
      source.indexOf("mobile_session:")
  );
  assert.doesNotMatch(source, /console\.log\([^\n]*(req\.body|password|LOGIN DB USER|LOGIN RESPONSE USER)/i);
});

test("mobile session schema is pre-existing and is not created by application startup", () => {
  const serviceSource = fs.readFileSync(
    path.join(__dirname, "..", "services", "mobileSessionService.js"),
    "utf8"
  );
  const serverSource = fs.readFileSync(
    path.join(__dirname, "..", "server", "server.js"),
    "utf8"
  );
  assert.doesNotMatch(serviceSource, /CREATE TABLE|ALTER TABLE/);
  assert.doesNotMatch(serverSource, /CREATE TABLE mobile_user_sessions/);
});

async function run() {
  for (const entry of tests) {
    await entry.fn();
    console.log(`PASS ${entry.name}`);
  }
  console.log(`Mobile session auth tests passed (${tests.length} focused scenarios).`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
