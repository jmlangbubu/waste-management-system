"use strict";
// Offline: production modules run with in-memory DB/provider/filesystem stubs.
// HTTP integration uses loopback only. No live credentials or Android files.
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createRequire } = require("node:module"), { EventEmitter } = require("node:events");
const { databasePolicy, guardDatabase, schemaQueryAllowed } = require("../config/stagingSafety");
const railway = require("../config/railwayStaging");
const { isWasteScanOnly } = require("../config/startupMode");
const policy = require("../middleware/stagingApiPolicy");
const { assertStagingCloudRun } = require("../config/stagingCloudRun");
const { prepareRuntimeCredentials } = require("../services/railwayCallerBootstrap");
const { createStagingAbuseControls } = require("../middleware/stagingAbuseLimits");
const root = path.resolve(__dirname, ".."), plain = value => JSON.parse(JSON.stringify(value));
const TOKEN = "a".repeat(43), secret = "synthetic-private-material-never-valid";
const audience = "https://gemini-waste-classifier-staging-2lzk3t3i7q-uc.a.run.app";
const taggedEndpoint = "https://a9-43847bc---gemini-waste-classifier-staging-2lzk3t3i7q-uc.a.run.app/classify-waste";
const caller = "wmo-render-staging-caller@gen-lang-client-0282087033.iam.gserviceaccount.com";
const credentials = JSON.stringify({ type: "service_account", client_email: caller, private_key: secret });
const valid = extra => ({ WMO_DEPLOYMENT_MODE: "staging", STAGING_WASTE_SCAN_ONLY: "true",
  STAGING_DATABASE_ISOLATION_CONFIRMED: "true", STAGING_ALLOW_SCHEMA_CHANGES: "false",
  STAGING_DATABASE_TRANSPORT: "railway_private", RAILWAY_PROJECT_ID: railway.PROJECT_ID,
  RAILWAY_ENVIRONMENT_ID: railway.ENVIRONMENT_ID, RAILWAY_SERVICE_ID: "11111111-1111-1111-1111-111111111111",
  STAGING_DATABASE_URL: "mysql://wmo_staging_app:synthetic-pass@mysql.railway.internal:3306/railway",
  CLOUD_RUN_AUTH_MODE: "iam", CLOUD_RUN_AUDIENCE: audience, GEMINI_CLASSIFIER_URL: audience + "/classify-waste",
  CLOUD_RUN_CALLER_CREDENTIALS_FILE: path.resolve(require("node:os").tmpdir(), "synthetic-caller.json"), ...extra });
const cloudOptions = { readFile: () => credentials, parseKey: () => ({ asymmetricKeyType: "rsa" }) };
const quiet = { log() {}, warn() {}, error() {} };
function load(file, env, stubs = {}) {
  const filename = path.join(root, file), module = { exports: {} }, realRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, exports: module.exports, __dirname: path.dirname(filename),
    process: { env, nextTick: process.nextTick, on() {}, exit() {} }, console: quiet, Buffer, URL, AbortController,
    setTimeout, clearTimeout, setImmediate, clearImmediate,
    require: id => Object.hasOwn(stubs, id) ? stubs[id] : realRequire(id) }, { filename });
  return module.exports;
}
function response() {
  return { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = plain(body); return this; } };
}

test("valid isolated Railway configuration selects only STAGING_DATABASE_URL and disables DDL", () => {
  const env = valid(), p = databasePolicy(env);
  assert.equal(p.uri, env.STAGING_DATABASE_URL); assert.equal(p.schemaChanges, false);
  assert.equal(isWasteScanOnly(env), true); assert.deepEqual(railway.privateDatabaseOptions(p, env), { ssl: false });
});
for (const [key, value] of Object.entries({ RAILWAY_PROJECT_ID: "production", RAILWAY_ENVIRONMENT_ID: "production",
  RAILWAY_SERVICE_ID: "f72af026-d49f-4833-b126-72de120962a5", STAGING_WASTE_SCAN_ONLY: "false",
  STAGING_DATABASE_ISOLATION_CONFIRMED: "false", STAGING_ALLOW_SCHEMA_CHANGES: "true",
  STAGING_DATABASE_TRANSPORT: "external_tls", NODE_TLS_REJECT_UNAUTHORIZED: "0" })) {
  test(`staging rejects unreviewed ${key}`, () => assert.throws(() => databasePolicy(valid({ [key]: value }))));
}
for (const key of ["STAGING_DATABASE_URL", "RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_ID",
  "STAGING_WASTE_SCAN_ONLY", "STAGING_DATABASE_ISOLATION_CONFIRMED", "STAGING_ALLOW_SCHEMA_CHANGES", "STAGING_DATABASE_TRANSPORT"]) {
  test(`staging fails closed when ${key} is missing`, () => {
    const env = valid(); delete env[key]; assert.throws(() => isWasteScanOnly(env));
  });
}
for (const url of ["mysql://root:password@mysql.railway.internal/railway",
  "mysql://wmo_staging_app:password@production.invalid/railway",
  "mysql://wmo_staging_app:password@mysql.railway.internal/production",
  "mysql://wmo_staging_app@mysql.railway.internal/railway",
  "mysql://wmo_staging_app:password@mysql.railway.internal:3307/railway",
  "mysql://wmo_staging_app:password@mysql.railway.internal/railway?multipleStatements=true",
  "mysql://wmo_staging_app:password@mysql.railway.internal/railway#override", "not-a-url"]) {
  test(`rejects unsafe database URL variant ${url.indexOf("?") >= 0 ? "query" : url.split("@").at(-1)}`, () => {
    assert.throws(() => databasePolicy(valid({ STAGING_DATABASE_URL: url })), error => !error.message.includes("password"));
  });
}
test("staging forbids every production DATABASE_URL reference, including empty and same-host aliases", () => {
  for (const value of ["", "mysql://root:secret@production.invalid/railway", valid().STAGING_DATABASE_URL])
    assert.throws(() => databasePolicy(valid({ DATABASE_URL: value })));
});
test("the reviewed Railway staging environment cannot start with a missing or non-staging mode", () => {
  for (const mode of [undefined, "production", "development", "test", "Staging"])
    assert.throws(() => isWasteScanOnly(valid({ WMO_DEPLOYMENT_MODE: mode })));
});
test("invalid staging startup stops before loading Express, databases, routes or listeners", () => {
  for (const extra of [{ STAGING_DATABASE_URL: undefined }, { RAILWAY_PROJECT_ID: "wrong" }, { STAGING_WASTE_SCAN_ONLY: undefined }]) {
    const env = valid(extra);
    assert.throws(() => load("server/server.js", env, {
      dotenv: { config() {} }, "../config/startupMode": { isWasteScanOnly: () => isWasteScanOnly(env) },
      express() { assert.fail("Invalid startup loaded Express"); },
      "../config/db": new Proxy({}, { get() { assert.fail("Invalid startup loaded DB"); } })
    }));
  }
});
test("non-staging pool configuration and DDL behavior remain unchanged", () => {
  for (const mode of [undefined, "production", "development", "test"]) {
    const env = { WMO_DEPLOYMENT_MODE: mode, DATABASE_URL: "original-value", STAGING_WASTE_SCAN_ONLY: "true" };
    assert.deepEqual(databasePolicy(env), { uri: "original-value", schemaChanges: true, staging: false });
    assert.equal(isWasteScanOnly(env), false);
    const db = { query: () => 42 }; assert.equal(guardDatabase(db, databasePolicy(env)), db); assert.equal(db.query("CREATE TABLE original"), 42);
  }
});
for (const sql of ["CREATE TABLE x (id INT)", "/* prefix */ ALTER TABLE users ADD x INT", "DROP TABLE users",
  "TRUNCATE TABLE users", "RENAME TABLE users TO x", "GRANT ALL ON *.* TO x", "CALL create_schema()",
  "PREPARE x FROM 'ALTER TABLE users ADD x INT'", "EXECUTE x", "SET sql_mode = 'NO_BACKSLASH_ESCAPES'",
  "SELECT 1; ALTER TABLE users ADD x INT", "/*!50000 CREATE TABLE x (id INT) */",
  "SELECT 1 /*!; ALTER TABLE users ADD x INT */", "SELECT * FROM users INTO OUTFILE '/tmp/x'"]) {
  test(`DDL and administrative SQL blocked: ${sql.split(" ").slice(0, 3).join(" ")}`, async () => {
    assert.equal(schemaQueryAllowed(sql), false);
    let calls = 0;
    const db = guardDatabase({ query() { calls++; }, execute() { calls++; } }, databasePolicy(valid()));
    for (const method of ["query", "execute"]) {
      const err = await new Promise(resolve => db[method]({ sql }, [], resolve));
      assert.equal(err.code, "STAGING_SCHEMA_CHANGES_DISABLED");
      assert.throws(() => db[method](sql), { code: "STAGING_SCHEMA_CHANGES_DISABLED" });
    }
    const promised = guardDatabase({ query() { calls++; }, execute() { calls++; } }, databasePolicy(valid()), true);
    await assert.rejects(promised.query(sql), { code: "STAGING_SCHEMA_CHANGES_DISABLED" });
    await assert.rejects(promised.execute(sql), { code: "STAGING_SCHEMA_CHANGES_DISABLED" });
    assert.equal(calls, 0);
  });
}
test("guard covers checked-out connections and callback-to-promise adapters", async () => {
  const conn = { query() { assert.fail("DDL reached driver"); } };
  const pool = guardDatabase({ getConnection(cb) { cb(null, conn); }, promise: () => ({ execute() { assert.fail("DDL reached driver"); } }) }, databasePolicy(valid()));
  const checked = await new Promise(resolve => pool.getConnection((e, c) => resolve(c)));
  assert.throws(() => checked.query("ALTER TABLE x ADD y INT"), { code: "STAGING_SCHEMA_CHANGES_DISABLED" });
  await assert.rejects(pool.promise().execute("CREATE TABLE x (y INT)"), { code: "STAGING_SCHEMA_CHANGES_DISABLED" });
  const promised = guardDatabase({ getConnection: async () => ({ query() { assert.fail("DDL reached driver"); } }) }, databasePolicy(valid()), true);
  await assert.rejects((await promised.getConnection()).query("DROP TABLE x"), { code: "STAGING_SCHEMA_CHANGES_DISABLED" });
});
test("DML and read-only inspection succeed; legitimate DB errors preserve codes without secrets", async () => {
  for (const sql of ["SELECT 1", "SHOW COLUMNS FROM users", "INSERT INTO scan_history VALUES (?)", "UPDATE mobile_user_sessions SET revoked_at = ?", "DELETE FROM mobile_user_sessions WHERE id = ?"])
    assert.equal(schemaQueryAllowed(sql), true);
  const error = Object.assign(new Error("mysql://root:private-password@private-host"), { code: "ER_TABLEACCESS_DENIED_ERROR", errno: 1142, sql: "private SQL" });
  const db = guardDatabase({ query(_s, cb) { cb(error); } }, databasePolicy(valid()));
  const safe = await new Promise(resolve => db.query("SELECT 1", resolve));
  assert.equal(safe.code, error.code); assert.equal(safe.errno, 1142);
  assert.equal(safe.sql, undefined); assert.doesNotMatch(safe.message, /password|private-host/);
});

for (const sql of [
  "SELECT 1 INTO/**/OUTFILE '/tmp/not-created'",
  "select 1 into /* gap */ outFILE '/tmp/not-created'",
  "SELECT 1 INTO\n\tDUMPFILE '/tmp/not-created'",
  "SELECT 1 INTO-- gap\nOUTFILE '/tmp/not-created'",
  "SELECT 1 INTO# gap\nOUTFILE '/tmp/not-created'",
  "SELECT LOAD_FILE/**/('/tmp/not-read')",
  "SELECT LoAd_FiLe /* gap */ ('/tmp/not-read')",
  "SELECT /* 'quoted comment' */ 1 INTO/**/OUTFILE '/tmp/not-created'",
  "SELECT /* ' */ 1 INTO/**/OUTFILE '/tmp/not-created'",
  "SELECT /* \" */ LOAD_FILE/**/('/tmp/not-read')"
]) {
  test(`P3 blocks normalized file operation ${JSON.stringify(sql)}`, async () => {
    assert.equal(schemaQueryAllowed(sql), false);
    let calls = 0;
    const db = guardDatabase({ query() { calls++; }, execute() { calls++; } }, databasePolicy(valid()));
    const error = await new Promise(resolve => db.query(sql, [], resolve));
    assert.equal(error.code, "STAGING_SCHEMA_CHANGES_DISABLED"); assert.equal(calls, 0);
  });
}
for (const sql of [
  "SELECT 'INTO OUTFILE' AS explanation",
  "SELECT 'LOAD_FILE(' AS explanation",
  "SELECT 'INTO/**/OUTFILE' AS explanation",
  "SELECT 'a\\\' INTO OUTFILE' AS explanation",
  "SELECT 'a'' INTO OUTFILE' AS explanation",
  "SELECT \"LOAD_FILE('/tmp/example')\" AS explanation",
  "SELECT 1 /* INTO OUTFILE '/tmp/example'; DROP TABLE users */",
  "SELECT '-- not a comment; INTO OUTFILE' AS explanation",
  "INSERT INTO scan_history (explanation) VALUES (?)",
  "UPDATE mobile_user_sessions SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP(3)) WHERE session_token_hash = ?"
]) {
  test(`P3 preserves allowed SQL and inert text ${JSON.stringify(sql)}`, () => {
    assert.equal(schemaQueryAllowed(sql), true);
  });
}

test("exact scan-only allowlist and canonical target policy deny every other public surface", () => {
  const allowed = ["GET /health", "POST /api/auth/login", "GET /api/auth/mobile/me", "POST /api/auth/mobile/logout", "POST /api/waste/analyze"];
  for (const target of allowed) { const [method, url] = target.split(" "); assert.equal(policy.allowedRequest(method, url), true); }
  for (const url of ["/", "/index.html", "/runtime-config.js", "/uploads/complaints/private.jpg", "/uploads/waste-scans/private.jpg",
    "/api/complaints", "/api/appointments", "/api/web-users", "/api/fleet", "/api/debug/uploads", "/api/auth/register",
    "/api/waste/history", "/api/waste/recognize-crops", "/socket.io/?transport=polling", "/api/waste/analyze/",
    "/API/waste/analyze", "/api//waste/analyze", "/api/waste/%61nalyze", "/api/waste/analyze;extra", "/api/waste/../waste/analyze"])
    for (const method of ["GET", "POST", "HEAD", "OPTIONS"]) assert.equal(policy.allowedRequest(method, url), false, method + " " + url);
});
test("upgrade and malformed-request responses disclose no internals", () => {
  let wire; policy.denyUpgrade({}, { end: value => { wire = value; } }); assert.match(wire, /^HTTP\/1.1 404/);
  for (const [type, status] of [["entity.too.large", 413], ["entity.parse.failed", 400], [undefined, 500]]) {
    const res = response(); policy.stagingError({ type, message: secret }, {}, res, () => assert.fail());
    assert.equal(res.statusCode, status); assert.ok(!JSON.stringify(res.body).includes(secret));
  }
});

for (const file of ["config/db.js", "config/dbPromise.js"]) {
  test(`${file} validates isolation before creating a pool and preserves production options`, () => {
    const created = [], fakePool = () => ({ getConnection(cb) { cb(null, { release() {} }); } });
    const mysql = { createPool(options) { created.push(plain(options)); return fakePool(); } };
    const stubs = { mysql2: mysql, "mysql2/promise": mysql, dotenv: { config() {} },
      "./stagingSafety": { databasePolicy: () => databasePolicy(env), guardDatabase }, "./railwayStaging": { privateDatabaseOptions: p => railway.privateDatabaseOptions(p, env) } };
    let env = valid(); load(file, env, stubs);
    assert.equal(created[0].uri, env.STAGING_DATABASE_URL); assert.equal(created[0].ssl, false); assert.equal(created[0].multipleStatements, false);
    env = valid({ DATABASE_URL: "production-secret" }); assert.throws(() => load(file, env, stubs)); assert.equal(created.length, 1);
    env = { DATABASE_URL: "original-production-uri" }; load(file, env, stubs);
    assert.equal(created[1].uri, env.DATABASE_URL); assert.equal(created[1].ssl, undefined); assert.equal(created[1].multipleStatements, undefined);
  });
}
test("tagged staging startup accepts the approved destination with canonical audience", () => {
  assert.doesNotThrow(() => assertStagingCloudRun(valid({ GEMINI_CLASSIFIER_URL: taggedEndpoint }), cloudOptions));
});

test("startup URL policy rejects unreviewed identities and destinations before credential access", () => {
  const variants = [
    { RAILWAY_PROJECT_ID: "wrong" }, { RAILWAY_ENVIRONMENT_ID: "wrong" }, { RAILWAY_SERVICE_ID: "f72af026-d49f-4833-b126-72de120962a5" },
    { RAILWAY_SERVICE_ID: undefined }, { STAGING_WASTE_SCAN_ONLY: "false" }, { STAGING_ALLOW_SCHEMA_CHANGES: "true" },
    { STAGING_DATABASE_TRANSPORT: "external_tls" }, { STAGING_DATABASE_ISOLATION_CONFIRMED: "false" }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { CLOUD_RUN_AUDIENCE: new URL(taggedEndpoint).origin }, { CLOUD_RUN_AUDIENCE: "https://gemini-waste-classifier-staging-other.run.app" },
    { GEMINI_CLASSIFIER_URL: taggedEndpoint.replace("a9-43847bc---", "other-tag---") },
    { GEMINI_CLASSIFIER_URL: taggedEndpoint.replace("staging-2lzk", "production-2lzk") },
    { GEMINI_CLASSIFIER_URL: taggedEndpoint + "?override=1" }, { GEMINI_CLASSIFIER_URL: taggedEndpoint + "#override" },
    { GEMINI_CLASSIFIER_URL: taggedEndpoint.replace("https:", "http:") },
    { GEMINI_CLASSIFIER_URL: taggedEndpoint.replace("/classify-waste", "/discover-objects") },
    { GEMINI_CLASSIFIER_URL: taggedEndpoint.replace(".app/", ".app:443/") },
    { GEMINI_CLASSIFIER_URL: "not a URL" }, { CLOUD_RUN_GEMINI_CLASSIFIER_URL: audience + "/classify-waste" },
    { CLOUD_RUN_GEMINI_CLASSIFIER_URL: "" }
  ];
  for (const patch of variants) {
    let reads = 0;
    assert.throws(() => assertStagingCloudRun(valid({ GEMINI_CLASSIFIER_URL: taggedEndpoint, ...patch }), {
      ...cloudOptions, readFile() { reads++; return credentials; }
    }), { code: "STAGING_CLOUD_RUN_CONFIGURATION_INVALID" });
    assert.equal(reads, 0, JSON.stringify(patch));
  }
});

test("startup preserves approved canonical compatibility and validates both URL aliases", () => {
  for (const destination of [audience + "/classify-waste", taggedEndpoint]) {
    for (const aliases of [{ GEMINI_CLASSIFIER_URL: destination },
      { GEMINI_CLASSIFIER_URL: undefined, CLOUD_RUN_GEMINI_CLASSIFIER_URL: destination },
      { GEMINI_CLASSIFIER_URL: destination, CLOUD_RUN_GEMINI_CLASSIFIER_URL: destination }])
      assert.doesNotThrow(() => assertStagingCloudRun(valid(aliases), cloudOptions));
  }
  assert.throws(() => assertStagingCloudRun(valid({ WMO_CLASSIFY_OBJECT_PROPOSALS_ENABLED: "true",
    CLASSIFY_OBJECT_PROPOSALS_SHARED_TOKEN: "s".repeat(32) }), cloudOptions));
});

test("IAM staging validates caller, endpoint and credentials without acquiring a token", () => {
  assert.doesNotThrow(() => assertStagingCloudRun(valid(), cloudOptions));
  assert.doesNotThrow(() => assertStagingCloudRun({ WMO_DEPLOYMENT_MODE: "production" }));
  for (const extra of [{ CLOUD_RUN_AUTH_MODE: undefined }, { CLOUD_RUN_AUTH_MODE: "public" }, { CLOUD_RUN_AUDIENCE: "https://production.run.app" },
    { GEMINI_CLASSIFIER_URL: "https://production.run.app/classify-waste" }, { GEMINI_CLASSIFIER_URL: audience + "/discover-objects" },
    { GEMINI_CLASSIFIER_URL: audience + "/classify-waste?token=hidden" }, { CLOUD_RUN_CALLER_CREDENTIALS_FILE: "relative.json" },
    { CLOUD_RUN_CALLER_CREDENTIALS_FILE: path.join(root, "caller.json") }, { CLOUD_RUN_CALLER_CREDENTIALS_JSON: credentials },
    { CLOUD_RUN_GEMINI_CLASSIFIER_URL: "https://production.run.app/classify-waste" }])
    assert.throws(() => assertStagingCloudRun(valid(extra), cloudOptions), { code: "STAGING_CLOUD_RUN_CONFIGURATION_INVALID" });
  for (const raw of ["{", "{}", credentials.replace(caller, "other@project.iam.gserviceaccount.com")])
    assert.throws(() => assertStagingCloudRun(valid(), { ...cloudOptions, readFile: () => raw }));
  assert.throws(() => assertStagingCloudRun(valid(), { ...cloudOptions, parseKey() { throw new Error(secret); } }), error => !error.message.includes(secret));
});
test("feature OFF remains the default; only explicit proposal ON requires its own staging token", () => {
  for (const value of [undefined, "false", "TRUE", "1", "true "])
    assert.doesNotThrow(() => assertStagingCloudRun(valid({ WMO_CLASSIFY_OBJECT_PROPOSALS_ENABLED: value }), cloudOptions));
  assert.throws(() => assertStagingCloudRun(valid({ GEMINI_CLASSIFIER_URL: taggedEndpoint, WMO_CLASSIFY_OBJECT_PROPOSALS_ENABLED: "true" }), cloudOptions));
  assert.doesNotThrow(() => assertStagingCloudRun(valid({ GEMINI_CLASSIFIER_URL: taggedEndpoint, WMO_CLASSIFY_OBJECT_PROPOSALS_ENABLED: "true", CLASSIFY_OBJECT_PROPOSALS_SHARED_TOKEN: "s".repeat(32) }), cloudOptions));
  assert.throws(() => assertStagingCloudRun(valid({ GEMINI_CLASSIFIER_URL: taggedEndpoint, WMO_CLASSIFY_OBJECT_PROPOSALS_ENABLED: "true", CLASSIFY_OBJECT_PROPOSALS_SHARED_TOKEN: "s".repeat(32), WHOLE_IMAGE_DISCOVERY_ENABLED: "true" }), cloudOptions));
});
function bootstrapFixture(extra = {}, failing = "") {
  const events = {}, calls = [], env = valid({ CLOUD_RUN_CALLER_CREDENTIALS_FILE: undefined, CLOUD_RUN_CALLER_CREDENTIALS_JSON: credentials, ...extra });
  delete env.CLOUD_RUN_CALLER_CREDENTIALS_FILE;
  const temp = path.resolve(require("node:os").tmpdir()), dir = path.join(temp, "synthetic-staging-directory");
  const filesystem = {
    realpathSync: p => p, mkdtempSync(p) { calls.push(["directory", p]); return dir; },
    chmodSync(p, mode) { calls.push(["chmod", mode]); }, statSync: () => ({ mode: failing === "permissions" ? 0o755 : 0o700 }),
    openSync(p, flags, mode) { calls.push(["open", flags, mode]); return 17; }, fstatSync: () => ({ mode: 0o600 }),
    writeFileSync(fd, raw) { if (failing === "write") throw Error(secret); calls.push(["write", fd, raw]); },
    fsyncSync() {}, closeSync() { calls.push(["close"]); }, unlinkSync() { calls.push(["unlink"]); }, rmdirSync() { calls.push(["rmdir"]); }
  };
  const runtime = { once(name, fn) { events[name] = fn; }, exit(code) { calls.push(["exit", code]); } };
  return { env, calls, events, options: { env, filesystem, runtime, platform: "linux", temporaryRoot: temp } };
}
test("Linux JSON bootstrap uses a private external temporary file, removes env JSON, and cleans up", () => {
  const f = bootstrapFixture(), handle = prepareRuntimeCredentials(f.options);
  assert.equal(f.env.CLOUD_RUN_CALLER_CREDENTIALS_JSON, undefined);
  assert.equal(f.calls.find(c => c[0] === "chmod")[1], 0o700);
  assert.deepEqual(f.calls.find(c => c[0] === "open"), ["open", "wx", 0o600]);
  assert.ok(!f.env.CLOUD_RUN_CALLER_CREDENTIALS_FILE.startsWith(root));
  assert.equal(f.calls.filter(c => c[0] === "write").length, 1);
  handle.cleanup(); f.events.exit(); assert.equal(f.calls.filter(c => c[0] === "unlink").length, 1);
  assert.equal(f.calls.filter(c => c[0] === "rmdir").length, 1);
  const terminated = bootstrapFixture(); prepareRuntimeCredentials(terminated.options); terminated.events.SIGTERM();
  assert.deepEqual(terminated.calls.at(-1), ["exit", 143]);
});
test("bootstrap refuses wrong caller, platform, permissions and partial writes without leaking secrets", () => {
  for (const kind of ["caller", "platform", "permissions", "write", "production"]) {
    const f = bootstrapFixture(kind === "caller" ? { CLOUD_RUN_CALLER_CREDENTIALS_JSON: credentials.replace(caller, "other@project.iam.gserviceaccount.com") }
      : kind === "production" ? { WMO_DEPLOYMENT_MODE: "production" } : {}, kind);
    if (kind === "platform") f.options.platform = "win32";
    assert.throws(() => prepareRuntimeCredentials(f.options), error => error.code === "STAGING_CALLER_BOOTSTRAP_UNAVAILABLE" && !error.message.includes(secret));
    assert.equal(f.env.CLOUD_RUN_CALLER_CREDENTIALS_JSON, undefined);
    if (kind === "write") assert.ok(f.calls.some(c => c[0] === "unlink"));
  }
  assert.doesNotThrow(() => prepareRuntimeCredentials({ env: {} }));
});
test("staging throttles login and limits analysis concurrency without provider calls", () => {
  let now = 1; const controls = createStagingAbuseControls({ now: () => now, limits: { loginIp: 1 } });
  const req = { method: "POST", path: "/api/auth/login", socket: { remoteAddress: "127.0.0.1" }, ip: "127.0.0.1" };
  controls.loginIp(req, response(), () => {}); const res = response(); controls.loginIp(req, res, () => assert.fail());
  assert.equal(res.statusCode, 429); assert.ok(res.headers["Retry-After"]);
  const first = controls.acquire(42); assert.equal(controls.acquire(42).denied, true);
  first.release(); assert.equal(controls.snapshot().active, 0); now += 3600001; assert.equal(controls.snapshot().admitted, 0);
});

function deferredAnalysis() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function lifecycleFixture(limits = {}) {
  const timers = new Set();
  const controls = createStagingAbuseControls({ limits, setTimer(fn) {
    const timer = { fn, unref() {} }; timers.add(timer); return timer;
  }, clearTimer(timer) { timers.delete(timer); } });
  function start(user = 42, work = deferredAnalysis()) {
    const req = Object.assign(new EventEmitter(), { method: "POST", path: "/api/waste/analyze", mobileUser: { id: user } });
    const res = Object.assign(new EventEmitter(), response(), { destroy() { this.destroyed = true; this.emit("close"); } });
    const json = res.json; res.json = function(body) { json.call(this, body); this.headersSent = true; this.writableFinished = true; this.emit("finish"); return this; };
    let task;
    controls.analysis(req, res, () => {
      // Exercise the old lifecycle for red evidence, rather than failing merely
      // because the corrected promise-registration API does not exist yet.
      task = req.stagingAnalysisScope.run ? req.stagingAnalysisScope.run(() => work.promise) : work.promise;
    });
    return { req, res, work, get task() { return task; } };
  }
  return { controls, timers, start };
}
test("P2 disconnect holds a permit until work settles and blocks replacement", async () => {
  const f = lifecycleFixture({ activeGlobal: 1 }), first = f.start();
  first.res.emit("close");
  assert.equal(f.controls.snapshot().active, 1);
  assert.equal(f.controls.acquire(42).denied, true);
  assert.equal(f.controls.acquire(43).denied, true);
  first.work.resolve("done"); assert.equal(await first.task, "done");
  assert.equal(f.controls.snapshot().active, 0);
  const replacement = f.controls.acquire(42); assert.equal(replacement.denied, undefined); replacement.release();
  assert.equal(first.req.listenerCount("aborted"), 0); assert.equal(first.res.listenerCount("close"), 0);
  assert.equal(f.timers.size, 0);
});
test("P2 rejection releases exactly once even after disconnect and repeated response events", async () => {
  const f = lifecycleFixture(), first = f.start(); first.req.emit("aborted"); first.res.emit("close");
  assert.equal(f.controls.snapshot().active, 1);
  first.work.reject(new Error("synthetic failure")); await assert.rejects(first.task, /synthetic failure/);
  first.res.emit("finish"); first.res.emit("close"); first.req.emit("aborted");
  assert.equal(f.controls.snapshot().active, 0);
  const replacement = f.controls.acquire(42); replacement.release(); replacement.release(); assert.equal(f.controls.snapshot().active, 0);
});
test("P2 bounded timeout ends the response without freeing pending work", async () => {
  const f = lifecycleFixture({ activeGlobal: 1 }), first = f.start();
  [...f.timers][0].fn();
  assert.equal(first.res.statusCode, 504); assert.equal(first.res.body.code, "STAGING_ANALYSIS_TIMEOUT");
  assert.equal(f.controls.snapshot().active, 1); assert.equal(f.controls.acquire(43).denied, true);
  first.work.resolve("late completion"); await first.task;
  assert.equal(f.controls.snapshot().active, 0); assert.equal(f.timers.size, 0);
});
test("P2 timeout followed by provider rejection releases after rejection", async () => {
  const f = lifecycleFixture(), first = f.start(); [...f.timers][0].fn();
  assert.equal(f.controls.snapshot().active, 1);
  first.work.reject(new Error("bounded provider timeout")); await assert.rejects(first.task, /bounded provider timeout/);
  assert.equal(f.controls.snapshot().active, 0); assert.equal(f.timers.size, 0);
});
test("P2 simultaneous disconnects preserve the global in-flight limit", async () => {
  const f = lifecycleFixture(), a = f.start(42), b = f.start(43);
  a.req.emit("aborted"); b.res.emit("close"); a.res.emit("close"); b.req.emit("aborted");
  assert.equal(f.controls.snapshot().active, 2); assert.equal(f.controls.acquire(44).denied, true);
  a.work.resolve("first complete"); await a.task; assert.equal(f.controls.snapshot().active, 1);
  const replacement = f.controls.acquire(44); assert.equal(replacement.denied, undefined);
  assert.equal(f.controls.snapshot().active, 2); assert.equal(f.controls.acquire(45).denied, true);
  b.work.reject(new Error("second failed")); await assert.rejects(b.task, /second failed/);
  assert.equal(f.controls.snapshot().active, 1); replacement.release(); assert.equal(f.controls.snapshot().active, 0);
});
test("P2 normal task settlement frees capacity before a later response finish", async () => {
  const f = lifecycleFixture(), first = f.start(); first.work.resolve("complete"); await first.task;
  assert.equal(f.controls.snapshot().active, 0); first.res.emit("finish"); first.res.emit("close");
  assert.equal(f.controls.snapshot().active, 0); assert.equal(f.timers.size, 0);
});
test("P2 response finish alone cannot free pending provider work", async () => {
  const f = lifecycleFixture(), first = f.start(); first.res.emit("finish");
  assert.equal(f.controls.snapshot().active, 1); first.work.resolve("done"); await first.task;
  assert.equal(f.controls.snapshot().active, 0);
});
test("P2 parser rejection and synchronous dispatch error do not leak unused slots", () => {
  const f = lifecycleFixture();
  const req = Object.assign(new EventEmitter(), { method: "POST", path: "/api/waste/analyze", mobileUser: { id: 42 } });
  const res = Object.assign(new EventEmitter(), response());
  f.controls.analysis(req, res, () => res.emit("finish")); assert.equal(f.controls.snapshot().active, 0);
  assert.throws(() => f.controls.analysis(req, res, () => { throw new Error("dispatch failure"); }), /dispatch failure/);
  assert.equal(f.controls.snapshot().active, 0); assert.equal(f.timers.size, 0);
});
test("P2 synchronous task failure releases and prevents a second task under the same permit", async () => {
  const f = lifecycleFixture();
  const req = Object.assign(new EventEmitter(), { method: "POST", path: "/api/waste/analyze", mobileUser: { id: 42 } });
  const res = Object.assign(new EventEmitter(), response());
  f.controls.analysis(req, res, () => {});
  await assert.rejects(req.stagingAnalysisScope.run(() => { throw new Error("synchronous task failure"); }), /synchronous task failure/);
  assert.equal(f.controls.snapshot().active, 0);
  await assert.rejects(req.stagingAnalysisScope.run(() => assert.fail("second task started")), /scope is closed/);
  res.emit("finish"); assert.equal(f.controls.snapshot().active, 0); assert.equal(f.timers.size, 0);
});
test("P2 timeout before task registration prevents late work and releases unused capacity", async () => {
  const f = lifecycleFixture();
  const req = Object.assign(new EventEmitter(), { method: "POST", path: "/api/waste/analyze", mobileUser: { id: 42 } });
  const res = Object.assign(new EventEmitter(), response()); let calls = 0;
  f.controls.analysis(req, res, () => {}); [...f.timers][0].fn();
  assert.equal(res.statusCode, 504); assert.equal(f.controls.snapshot().active, 0);
  await assert.rejects(req.stagingAnalysisScope.run(() => { calls++; }), /scope is closed/);
  assert.equal(calls, 0); assert.equal(f.timers.size, 0);
});

async function httpFixture(t, { staging = true, historyError = false, columnError = false, loginColumnError = false, role = "Citizen", analysisWork, controls: injectedControls } = {}) {
  const express = require("express"), http = require("node:http"), effects = { providers: 0, images: 0, ddl: 0, tables: [], modules: [], scheduler: 0, socket: 0, auth: 0 };
  const env = staging ? valid({ PORT: "0" }) : { PORT: "0" };
  let revoked = false;
  const sessionService = {
    isValidOpaqueToken: value => /^[A-Za-z0-9_-]{43}$/.test(value),
    async authenticateMobileSession(token) {
      effects.auth++;
      if (token !== TOKEN || revoked) throw Object.assign(new Error("Invalid session"), { statusCode: 401, code: "MOBILE_SESSION_INVALID" });
      return { id: 7, expiresAt: "2099-01-01", user: { id: 42, role, mobile_role: role, status: "active", username: "synthetic-citizen" } };
    },
    async createMobileSession() { return { token: TOKEN, expiresAt: new Date("2099-01-01") }; },
    async revokeMobileSession() { revoked = true; }
  };
  const auth = load("middleware/mobileSessionAuth.js", env, { "../services/mobileSessionService": sessionService });
  const db = { shouldReturnServiceUnavailable: () => false, healthCheck: cb => cb(null),
    queryReadOnly(sql, cb) { effects.tables.push(sql); cb(columnError ? new Error("private schema error") : null, ["analysis_source"].map(Field => ({ Field }))); },
    query(sql, values, cb) {
      if (typeof values === "function") { cb = values; values = []; }
      effects.tables.push(sql);
      if (/\b(CREATE|ALTER)\b/i.test(sql)) { effects.ddl++; return cb(new Error("unexpected DDL")); }
      if (/SHOW COLUMNS FROM users/.test(sql)) return cb(null, ["email", "email_verified", "email_verified_at", "profile_image_url", "profile_avatar_key", "profile_updated_at"].map(Field => ({ Field })));
      if (/FROM users/.test(sql)) return cb(loginColumnError ? Object.assign(new Error("private missing column"), { code: "ER_BAD_FIELD_ERROR" }) : null,
        [{ id: 42, full_name: "Synthetic Citizen", username: "synthetic-citizen", password: "offline-hash", role, status: "active", email: "", email_verified: 1 }]);
      if (/INSERT INTO scan_history/.test(sql)) return cb(historyError ? new Error("private insert error") : null, { insertId: 17 });
      assert.fail("Unexpected SQL: " + sql);
    }
  };
  const fakeFs = { existsSync: () => true, readdirSync: () => [], mkdirSync() { assert.fail("Unexpected directory write"); }, writeFileSync() { effects.images++; } };
  const mobileRoutes = load("routes/mobileAuthRoutes.js", env, { "../services/mobileSessionService": sessionService, "../middleware/mobileSessionAuth": auth });
  const authRoutes = load("routes/authRoutes.js", env, { "../config/db": db, bcrypt: { compare: async () => true }, fs: fakeFs,
    "../services/mobileSessionService": sessionService, "./mobileAuthRoutes": mobileRoutes, "./passwordResetRoutes": express.Router(),
    ...(staging ? {} : { nodemailer: {}, resend: {} }) });
  const analysis = { category: "Recyclable", itemName: "Plastic bottle", confidence: 0.9, detectedItems: [] };
  const wasteRoutes = load("routes/wasteRoutes.js", env, { "../config/db": db, fs: fakeFs, "../middleware/mobileSessionAuth": auth,
    "../services/wasteAnalysisService": { async analyzeWaste(input) { effects.providers++; effects.analysisInput = input; if (analysisWork) await analysisWork.promise; return analysis; }, buildScanSummary: () => ({ totalItems: 0 }) },
    "../controllers/wasteController": new Proxy({}, { get: () => (_req, res) => res.json({ success: true }) }),
    "../controllers/wasteCorrectionController": new Proxy({}, { get: () => (_req, res) => res.json({ success: true }) }),
    "../middleware/webSessionAuth": { requireWebCapability: () => (_req, _res, next) => next(), requireCsrf: (_req, _res, next) => next() } });
  let server;
  const stubs = { dotenv: { config() {} }, "../config/startupMode": { isWasteScanOnly: () => isWasteScanOnly(env) },
    "../services/railwayCallerBootstrap": { prepareRuntimeCredentials() {} }, "../config/stagingCloudRun": { assertStagingCloudRun: () => assertStagingCloudRun(env, cloudOptions) },
    "../config/db": db, "../routes/wasteRoutes": wasteRoutes, "../routes/authRoutes": authRoutes, "../middleware/mobileSessionAuth": auth,
    fs: fakeFs, http: { createServer(app) {
      server = http.createServer(app); const listen = server.listen.bind(server);
      server.listen = (_port, _host, cb) => listen(0, "127.0.0.1", cb); return server;
    } },
    "socket.io": { Server: class extends EventEmitter { constructor() { super(); effects.socket++; this.engine = { clientsCount: 0 }; } } },
    "../services/dispatchMonitorService": { start() { effects.scheduler++; } } };
  if (injectedControls) stubs["../middleware/stagingAbuseLimits"] = { createStagingAbuseControls: () => injectedControls };
  for (const name of ["webAuthRoutes", "webUserRoutes", "appointmentRoutes", "trackingRoutes", "dispatchRoutes", "mobileDispatchPlanRoutes", "dispatchPlanRoutes",
    "fleetRoutes", "vehicleIssueRoutes", "notificationRoutes", "complaintRoutes", "certificateRoutes", "invoiceRoutes"])
    Object.defineProperty(stubs, "../routes/" + name, { get() { effects.modules.push(name); const router = express.Router(); router.get("/", (_req, res) => res.json({ success: true })); return router; }, enumerable: true });
  stubs["../routes/citizenAssistantRoutes"] = { createCitizenAssistantRouter: () => express.Router() };
  stubs["../routes/appVersionRoutes"] = { createAppVersionRouter: () => express.Router() };
  load("server/server.js", env, stubs);
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  if (!server.listening) await new Promise(resolve => server.once("listening", resolve));
  async function request(method, url, body, token, signal) {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port: server.address().port, method, path: url, signal,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}), "X-Wmo-Scan-Capability": "waste-scan-independent-category-v2" } }, res => {
        let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode, text, headers: res.headers, body: text ? JSON.parse(text) : null }));
      }); req.on("error", reject); req.end(data);
    });
  }
  return { request, effects };
}
async function waitForAnalysis(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "analysis lifecycle did not reach the expected state");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
test("P2 HTTP disconnect cannot admit a replacement until the real route task settles", async t => {
  const lifecycle = lifecycleFixture({ activeGlobal: 1 }), work = deferredAnalysis(), closed = deferredAnalysis();
  const analysis = lifecycle.controls.analysis;
  lifecycle.controls.analysis = (req, res, next) => { res.once("close", closed.resolve); return analysis(req, res, next); };
  const f = await httpFixture(t, { analysisWork: work, controls: lifecycle.controls });
  const controller = new AbortController();
  const pending = f.request("POST", "/api/waste/analyze", { image: "offline" }, TOKEN, controller.signal).catch(error => error);
  try {
    await waitForAnalysis(() => f.effects.providers === 1); controller.abort(); await pending; await closed.promise;
    assert.equal(lifecycle.controls.snapshot().active, 1);
    assert.equal((await f.request("POST", "/api/waste/analyze", { image: "offline" }, TOKEN)).status, 429);
    assert.equal(f.effects.providers, 1);
    work.resolve(); await waitForAnalysis(() => lifecycle.controls.snapshot().active === 0);
    assert.equal((await f.request("POST", "/api/waste/analyze", { image: "offline" }, TOKEN)).status, 200);
    assert.equal(f.effects.providers, 2); assert.equal(lifecycle.controls.snapshot().active, 0);
  } finally { work.resolve(); }
});
test("P2 HTTP timeout retains the permit until the route's provider promise settles", async t => {
  const lifecycle = lifecycleFixture({ activeGlobal: 1 }), work = deferredAnalysis();
  const f = await httpFixture(t, { analysisWork: work, controls: lifecycle.controls });
  const pending = f.request("POST", "/api/waste/analyze", { image: "offline" }, TOKEN);
  try {
    await waitForAnalysis(() => f.effects.providers === 1); [...lifecycle.timers][0].fn();
    assert.equal((await pending).status, 504); assert.equal(lifecycle.controls.snapshot().active, 1);
    assert.equal((await f.request("POST", "/api/waste/analyze", { image: "offline" }, TOKEN)).status, 429);
    work.resolve(); await waitForAnalysis(() => lifecycle.controls.snapshot().active === 0);
    assert.equal((await f.request("POST", "/api/waste/analyze", { image: "offline" }, TOKEN)).status, 200);
    assert.equal(f.effects.providers, 2); assert.equal(lifecycle.controls.snapshot().active, 0); assert.equal(lifecycle.timers.size, 0);
  } finally { work.resolve(); }
});
test("real HTTP staging health, login, session check, authenticated analyze and logout succeed", async t => {
  const f = await httpFixture(t);
  assert.deepEqual(f.effects.tables, [], "staging startup performs no schema inspection or writes");
  assert.equal((await f.request("GET", "/health")).status, 200);
  const login = await f.request("POST", "/api/auth/login", { username: "synthetic-citizen", password: "offline-password" });
  assert.equal(login.status, 200); assert.equal(login.body.mobile_session.token, TOKEN); assert.equal(f.effects.ddl, 0);
  assert.equal((await f.request("GET", "/api/auth/mobile/me", undefined, TOKEN)).status, 200);
  const scan = await f.request("POST", "/api/waste/analyze", { image: "c3ludGhldGlj" }, TOKEN);
  assert.equal(scan.status, 200); assert.equal(scan.body.result.id, 17); assert.equal(scan.body.result.imageUrl, null);
  assert.equal(f.effects.providers, 1); assert.equal(f.effects.analysisInput.independentCategoryV2, true);
  assert.equal(f.effects.analysisInput.principal, 42); assert.equal(f.effects.images, 0);
  assert.equal(f.effects.socket, 0); assert.equal(f.effects.scheduler, 0); assert.deepEqual(f.effects.modules, []);
  assert.equal((await f.request("POST", "/api/auth/mobile/logout", {}, TOKEN)).status, 200);
  assert.equal((await f.request("POST", "/api/waste/analyze", { image: "c3ludGhldGlj" }, TOKEN)).status, 401);
  assert.equal(f.effects.providers, 1);
});
test("unauthenticated and malformed-token analyze fail before payload parsing or provider work", async t => {
  const f = await httpFixture(t);
  for (const token of [undefined, "malformed", "b".repeat(43)]) {
    const scan = await f.request("POST", "/api/waste/analyze", "{invalid-json", token);
    assert.equal(scan.status, 401);
  }
  assert.equal(f.effects.providers, 0); assert.equal(f.effects.images, 0);
  const malformed = await f.request("POST", "/api/waste/analyze", "{invalid-json", TOKEN);
  assert.equal(malformed.status, 400); assert.doesNotMatch(malformed.text, /SyntaxError|stack|private/);
});
test("authenticated HTTP staging still denies unrelated APIs and every static/upload surface", async t => {
  const f = await httpFixture(t);
  for (const url of ["/api/complaints", "/api/appointments", "/api/web-users", "/api/auth/register", "/api/auth/profile/42", "/api/waste/history",
    "/api/waste/recognize-crops", "/api/debug/uploads", "/uploads/complaints/private.jpg", "/uploads/waste-scans/private.jpg", "/runtime-config.js", "/index.html", "/socket.io/?transport=polling"])
    for (const method of ["GET", "POST"]) {
      const res = await f.request(method, url, "{invalid-json", TOKEN);
      assert.equal(res.status, 404, method + " " + url); assert.equal(res.headers["cache-control"], "no-store");
    }
  assert.equal(f.effects.auth, 0); assert.equal(f.effects.providers, 0);
});
test("staging rejects non-citizen login and sessions", async t => {
  const f = await httpFixture(t, { role: "super_admin" });
  assert.equal((await f.request("POST", "/api/auth/login", { username: "admin", password: "offline" })).status, 403);
  assert.equal((await f.request("POST", "/api/waste/analyze", { image: "offline" }, TOKEN)).status, 403);
  assert.equal(f.effects.providers, 0);
});
for (const options of [{ historyError: true }, { columnError: true }, { loginColumnError: true }]) {
  test(`staging exposes legitimate database failure safely: ${Object.keys(options)[0]}`, async t => {
    const f = await httpFixture(t, options), login = options.loginColumnError;
    const res = await f.request("POST", login ? "/api/auth/login" : "/api/waste/analyze", login ? { username: "citizen", password: "offline" } : { image: "offline" }, TOKEN);
    assert.equal(res.status, login ? 500 : 503); assert.equal(res.body.success, false); assert.doesNotMatch(res.text, /private|password|stack/); assert.equal(f.effects.ddl, 0);
  });
}
test("HTTP non-staging retains the general app, realtime, schedulers and legacy analyze without auth", async t => {
  const f = await httpFixture(t, { staging: false, historyError: true });
  assert.equal((await f.request("GET", "/api/test")).status, 200);
  assert.equal((await f.request("GET", "/api/complaints")).status, 200);
  const scan = await f.request("POST", "/api/waste/analyze", { image: "c3ludGhldGlj" });
  assert.equal(scan.status, 200); assert.equal(scan.body.result.id, 0); assert.match(scan.body.result.analysisSource, /_db_save_failed$/);
  assert.equal(f.effects.socket, 1); assert.equal(f.effects.scheduler, 1); assert.ok(f.effects.modules.includes("complaintRoutes"));
});

function realStartupBootstrapFixture(extra = {}) {
  const f = bootstrapFixture(extra), order = [], effects = { credentialReads: 0, tokenRequests: 0, databaseInitializations: 0, appInitializations: 0 };
  const sdk = {};
  Object.defineProperty(sdk, "google-auth-library", { get() { effects.tokenRequests++; throw Error("Startup must not request a token"); } });
  const auth = load("services/cloudRunAuth.js", f.env, sdk);
  const bootstrap = load("services/railwayCallerBootstrap.js", f.env, { "./cloudRunAuth": {
    ...auth,
    validateCloudRunTarget(endpoint, env) { order.push("validate-url"); return auth.validateCloudRunTarget(endpoint, env); },
    parseCallerCredentials(raw, env) { order.push("parse-credentials"); return auth.parseCallerCredentials(raw, env); }
  } });
  const cloud = load("config/stagingCloudRun.js", f.env, { "../services/cloudRunAuth": auth });
  const reachedApp = new Error("Reached application initialization after security preflight");
  const stubs = {
    dotenv: { config() {} },
    "../config/startupMode": { isWasteScanOnly: () => isWasteScanOnly(f.env) },
    "../services/railwayCallerBootstrap": { prepareRuntimeCredentials: () => bootstrap.prepareRuntimeCredentials(f.options) },
    "../config/stagingCloudRun": { assertStagingCloudRun: () => cloud.assertStagingCloudRun(f.env, {
      ...cloudOptions, readFile() { effects.credentialReads++; order.push("read-credentials"); return credentials; }
    }) }
  };
  Object.defineProperty(stubs, "../middleware/stagingApiPolicy", { get() { effects.appInitializations++; throw reachedApp; } });
  for (const name of ["../config/db", "../config/dbPromise"]) {
    Object.defineProperty(stubs, name, { get() { effects.databaseInitializations++; throw Error("Invalid startup initialized a database"); } });
  }
  return { ...f, effects, order, reachedApp, run: () => load("server/server.js", f.env, stubs) };
}

test("P2 real startup rejects invalid classifier URLs before credential operations", () => {
  for (const extra of [
    { GEMINI_CLASSIFIER_URL: "https://unapproved.invalid/classify-waste" },
    { GEMINI_CLASSIFIER_URL: taggedEndpoint.replace("a9-43847bc---", "wrong-tag---") },
    { GEMINI_CLASSIFIER_URL: taggedEndpoint + "?override=1" },
    { CLOUD_RUN_AUDIENCE: "https://unapproved.run.app" },
    { RAILWAY_PROJECT_ID: "wrong" }, { RAILWAY_ENVIRONMENT_ID: "wrong" }
  ]) {
    const f = realStartupBootstrapFixture(extra);
    assert.throws(f.run, error => error !== f.reachedApp && !error.message.includes(secret));
    assert.deepEqual(f.calls, [], "Invalid startup performed credential filesystem operations");
    assert.deepEqual(f.effects, { credentialReads: 0, tokenRequests: 0, databaseInitializations: 0, appInitializations: 0 });
    assert.ok(!f.order.includes("parse-credentials"));
  }
});

test("P2 real startup rejects conflicting classifier aliases before credential operations", () => {
  for (const fallback of [audience + "/classify-waste", "", "not-a-url"]) {
    const f = realStartupBootstrapFixture({ GEMINI_CLASSIFIER_URL: taggedEndpoint, CLOUD_RUN_GEMINI_CLASSIFIER_URL: fallback });
    assert.throws(f.run, error => error !== f.reachedApp && !error.message.includes(secret));
    assert.deepEqual(f.calls, [], "Conflicting aliases triggered credential filesystem operations");
    assert.deepEqual(f.effects, { credentialReads: 0, tokenRequests: 0, databaseInitializations: 0, appInitializations: 0 });
    assert.ok(!f.order.includes("parse-credentials"));
  }
});

test("P2 real startup validates the approved URL before private bootstrap and preserves cleanup", () => {
  for (const destination of [audience + "/classify-waste", taggedEndpoint]) {
    const f = realStartupBootstrapFixture({ GEMINI_CLASSIFIER_URL: destination, CLOUD_RUN_GEMINI_CLASSIFIER_URL: destination });
    assert.throws(f.run, error => error === f.reachedApp);
    assert.deepEqual(f.order, ["validate-url", "parse-credentials", "read-credentials"]);
    assert.equal(f.calls.filter(c => c[0] === "write").length, 1);
    assert.equal(f.calls.find(c => c[0] === "chmod")[1], 0o700);
    assert.deepEqual(f.calls.find(c => c[0] === "open"), ["open", "wx", 0o600]);
    assert.deepEqual(f.effects, { credentialReads: 1, tokenRequests: 0, databaseInitializations: 0, appInitializations: 1 });
    f.events.exit();
    assert.equal(f.calls.filter(c => c[0] === "unlink").length, 1);
    assert.equal(f.calls.filter(c => c[0] === "rmdir").length, 1);
  }
});
