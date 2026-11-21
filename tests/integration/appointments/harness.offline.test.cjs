"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
// Guard even the parent test process before loading new code. Restore around each test.
const loaded = (() => {
  const guard = traps();
  try { return ["environment", "schema", "runtime", "control", "assertions"].map(name => require(`./helpers/${name}.cjs`)); }
  finally { guard.restore(); assert.ok(Object.values(guard).every(n => n === 0), "Import attempted a prohibited effect"); }
})();
const [environment, schema, runtime, control, invariants] = loaded;
const parentGuards = new Map();
const expectedInterceptions = new Map();
test.beforeEach(context => { parentGuards.set(context.fullName, traps()); });
test.afterEach(context => {
  const guard = parentGuards.get(context.fullName), expected = expectedInterceptions.get(context.fullName);
  guard.restore(); parentGuards.delete(context.fullName); expectedInterceptions.delete(context.fullName);
  if (expected) assert.deepEqual({ ...guard }, expected); else noEffects(guard);
});
const RUN = "11111111-1111-4111-8111-111111111111";
const SCHEMA = `wmo_synthetic_${RUN.replace(/-/g, "")}`;
const clone = value => structuredClone(value);
function pair(stage = "runtime-identity") {
  // Fabricated evidence for pure validation tests, NOT a verified image/server or usable credentials.
  const c = { authorization: { approved: true, phase: "4B", scope: stage, runId: RUN }, runId: RUN,
    containerId: "a".repeat(64), networkId: "b".repeat(64), volumeName: `wmo_appointments_${RUN.replace(/-/g, "")}_data`,
    labels: { "wmo.test.purpose": environment.PURPOSE, "wmo.test.run": RUN },
    image: { reference: environment.IMAGE, digest: `sha256:${"c".repeat(64)}`, verified: true },
    schema: SCHEMA, serverUuid: "22222222-2222-4222-8222-222222222222", sourceCommit: environment.BASELINE,
    endpoint: { host: "127.0.0.1", port: 33307, containerPort: 3306, protocol: "tcp" },
    fixtureFingerprint: schema.fixtureFingerprint(), permittedSchemas: [SCHEMA],
    credentials: { origin: "new-disposable-only", testOnly: true, schema: SCHEMA, scopeVerified: true,
      applicationAccount: "wmo_test_app", setupAccount: "wmo_test_setup", observerAccount: "wmo_test_observer" } };
  const o = { runId: RUN, containerId: c.containerId, networkId: c.networkId, volumeName: c.volumeName, labels: clone(c.labels),
    imageReference: c.image.reference, imageDigest: c.image.digest, networkDedicated: true, networkInternal: true,
    bindings: [clone(c.endpoint)], endpoint: clone(c.endpoint), serverUuid: c.serverUuid, selectedSchema: SCHEMA,
    permittedSchemas: [SCHEMA], credentialScopeVerified: true, schemaEmpty: stage === "provisioning-identity" };
  if (stage === "runtime-identity") o.marker = { runId: RUN, schema: SCHEMA, syntheticOnly: true, fingerprint: c.fixtureFingerprint,
    sourceCommit: environment.BASELINE, reconciled: true };
  return { c, o };
}
function resources(c) { return [["container", c.containerId], ["network", c.networkId], ["volume", c.volumeName]]
  .map(([kind, id]) => ({ kind, id, labels: clone(c.labels) })); }
function refused(operation, code) {
  assert.throws(operation, error => error instanceof environment.SafetyError && (!code || error.code === code) &&
    !/password|railway\.app|citizen@|SECRET_CANARY|ORI-secret|mysql:\/\//i.test(error.message));
}

function traps() {
  const Module = require("node:module"), net = require("node:net"), tls = require("node:tls"), http = require("node:http"),
    https = require("node:https"), dns = require("node:dns"), dgram = require("node:dgram"), cp = require("node:child_process"), fs = require("node:fs");
  const counts = { network: 0, server: 0, subprocess: 0, forbiddenModule: 0, filesystemWrite: 0, environmentFile: 0 };
  const restorers = [];
  const patch = (object, key, value) => {
    const original = Object.getOwnPropertyDescriptor(object, key);
    restorers.push(() => original ? Object.defineProperty(object, key, original) : delete object[key]);
    Object.defineProperty(object, key, { value, writable: true, configurable: true, enumerable: original?.enumerable ?? true });
  };
  const deny = kind => () => { counts[kind]++; throw Object.assign(new Error("OFFLINE_INTERCEPTION"), { code: "OFFLINE_INTERCEPTION" }); };
  patch(net.Socket.prototype, "connect", deny("network")); patch(net, "connect", deny("network")); patch(net, "createConnection", deny("network"));
  patch(net.Server.prototype, "listen", deny("server")); patch(tls, "connect", deny("network"));
  for (const api of [http, https]) { patch(api, "request", deny("network")); patch(api, "get", deny("network")); patch(api, "createServer", deny("server")); }
  patch(globalThis, "fetch", deny("network")); patch(dgram, "createSocket", deny("network"));
  for (const key of ["lookup", "resolve", "resolve4", "resolve6", "reverse"]) { patch(dns, key, deny("network")); if (dns.promises[key]) patch(dns.promises, key, deny("network")); }
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) patch(cp, key, deny("subprocess"));
  for (const key of ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "rm", "rmSync",
    "unlink", "unlinkSync", "rmdir", "rmdirSync", "rename", "renameSync", "copyFile", "copyFileSync", "truncate", "truncateSync", "createWriteStream"]) {
    if (typeof fs[key] === "function") patch(fs, key, deny("filesystemWrite"));
    if (typeof fs.promises[key] === "function") patch(fs.promises, key, deny("filesystemWrite"));
  }
  const read = fs.readFileSync;
  patch(fs, "readFileSync", function(file, ...args) {
    if (typeof file === "string" && /(?:^|[/\\])\.env(?:\.|$)/i.test(file)) return deny("environmentFile")();
    return read.call(this, file, ...args);
  });
  const load = Module._load;
  patch(Module, "_load", function(name, parent, isMain) {
    if (/^(?:mysql2(?:\/|$)|dotenv(?:\/|$))/.test(name)) return deny("forbiddenModule")();
    let resolved = name;
    if (!name.startsWith("node:")) { try { resolved = Module._resolveFilename(name, parent); } catch (_) { /* Normal loader handles missing files. */ } }
    if (/(?:^|[/\\])(?:config[/\\]db(?:Promise)?(?:\.js)?|server[/\\]server(?:\.js)?|routes[/\\].*)$/.test(resolved)) return deny("forbiddenModule")();
    return load.call(this, name, parent, isMain);
  });
  Object.defineProperty(counts, "restore", { value: () => { while (restorers.length) restorers.pop()(); } });
  return counts;
}
function child(body) {
  const script = `"use strict"; const assert=require('node:assert/strict'); const counters=(${traps.toString()})();\n(async()=>{${body}\n})().catch(()=>{process.stderr.write('OFFLINE_CHILD_FAILED');process.exitCode=1;});`;
  const r = spawnSync(process.execPath, ["-e", script], { cwd: __dirname, env: environment.buildChildEnvironment(process.env),
    encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.ifError(r.error); assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const noEffects = counts => assert.ok(Object.values(counts).every(n => n === 0), JSON.stringify(counts));

test("imports and self-check run behind network, server, module, write and subprocess traps", () => {
  const report = child(`
    for(const name of ['environment','schema','runtime','control','assertions']) require('./helpers/'+name+'.cjs');
    const launcher=require('./run.cjs'); let out='',err='';
    const code=await launcher.main(['--self-check'],{stdout:{write:s=>out+=s},stderr:{write:s=>err+=s}});
    assert.equal(code,0);assert.match(out,/8 checks/);assert.equal(err,'');
    console.log(JSON.stringify({code,counters}));`);
  assert.equal(report.code, 0); noEffects(report.counters);
});
test("interception negative controls block unsafe behavior before any external operation", context => {
  // This file already runs in an isolated Node test worker. No nested process is
  // necessary to exercise the installed denial functions; no Docker command is used.
  expectedInterceptions.set(context.fullName, { network: 1, server: 0, subprocess: 1, forbiddenModule: 1, filesystemWrite: 1, environmentFile: 0 });
  assert.throws(() => require("mysql2"), { code: "OFFLINE_INTERCEPTION" });
  assert.throws(() => require("node:net").createConnection(), { code: "OFFLINE_INTERCEPTION" });
  assert.throws(() => require("node:child_process").spawn(process.execPath, []), { code: "OFFLINE_INTERCEPTION" });
  assert.throws(() => fs.writeFileSync("forbidden", "x"), { code: "OFFLINE_INTERCEPTION" });
});
test("default, unsupported and bypass launcher arguments refuse without side effects", () => {
  const report = child(`
    const launcher=require('./run.cjs'); const codes=[];
    for(const args of [[],['--integration'],['--provision'],['--unsafe'],['--force'],['--self-check','--integration'],['--self-check','SECRET_CANARY']]){
      let out='',err='';codes.push(await launcher.main(args,{stdout:{write:s=>out+=s},stderr:{write:s=>err+=s}}));
      assert.equal(out,'');assert.match(err,/PHASE4A_MODE_REFUSED/);assert.ok(!err.includes('SECRET_CANARY'));
    }
    console.log(JSON.stringify({codes,counters}));`);
  assert.deepEqual(report.codes, Array(7).fill(2)); noEffects(report.counters);
});
test("pure identity acceptance remains offline and cannot activate a runtime", () => {
  for (const stage of ["provisioning-identity", "runtime-identity"]) {
    const { c, o } = pair(stage), before = JSON.stringify({ c, o });
    const result = stage === "provisioning-identity" ? environment.verifyProvisioningIdentity(c, o) : environment.verifyRuntimeIdentity(c, o);
    assert.equal(result.writeAccess, false); assert.equal(result.independentlyObservedHere, false); assert.ok(Object.isFrozen(result));
    assert.equal(JSON.stringify({ c, o }), before);
    refused(() => runtime.createDeferredRuntime().activate(result), "PHASE4A_RUNTIME_DISABLED");
  }
});
test("every required configuration identity field is necessary", async t => {
  for (const key of Object.keys(pair().c)) await t.test(key, () => {
    const { c, o } = pair(); delete c[key]; refused(() => environment.verifyRuntimeIdentity(c, o));
  });
});
test("production-like URLs, DNS names, public and ambiguous bindings are refused", async t => {
  for (const host of ["localhost", "mysql.railway.app", "https://127.0.0.1", "mysql://SECRET_CANARY@127.0.0.1", "0.0.0.0", "10.0.0.1", "::1", "127.0.0.2"]) {
    await t.test(`host-${host.startsWith("mysql:") ? "credential-url" : host}`, () => {
      const { c, o } = pair(); c.endpoint.host = host; refused(() => environment.verifyRuntimeIdentity(c, o), "ENDPOINT_INVALID");
    });
  }
  for (const change of [o => { o.endpoint.host = "10.0.0.1"; }, o => { o.endpoint.port++; }, o => { o.bindings.push({ ...o.endpoint, containerPort: 33060 }); },
    o => { o.bindings[0].host = "0.0.0.0"; }, o => { o.networkInternal = false; }, o => { o.networkDedicated = false; }]) {
    const { c, o } = pair(); change(o); refused(() => environment.verifyRuntimeIdentity(c, o));
  }
});
test("observed identity and marker mismatches fail closed with sanitized diagnostics", async t => {
  const variants = {
    container: o => { o.containerId = "d".repeat(64); }, run: o => { o.runId = "33333333-3333-4333-8333-333333333333"; },
    label: o => { o.labels["wmo.test.run"] = "SECRET_CANARY"; }, image: o => { o.imageDigest = `sha256:${"d".repeat(64)}`; },
    server: o => { o.serverUuid = "33333333-3333-4333-8333-333333333333"; }, missing_server: o => { delete o.serverUuid; },
    schema: o => { o.selectedSchema = "railway"; }, network: o => { o.networkId = "d".repeat(64); },
    fingerprint: o => { o.marker.fingerprint = `sha256:${"d".repeat(64)}`; }, missing_fingerprint: o => { delete o.marker.fingerprint; },
    marker_run: o => { o.marker.runId = "SECRET_CANARY"; }, marker_schema: o => { o.marker.schema = "railway"; },
    nonsynthetic: o => { o.marker.syntheticOnly = false; }, unreconciled: o => { o.marker.reconciled = false; },
    missing_marker: o => { delete o.marker; }, wrong_commit: o => { o.marker.sourceCommit = "0".repeat(40); }
  };
  for (const [name, change] of Object.entries(variants)) await t.test(name, () => {
    const { c, o } = pair(); change(o); refused(() => environment.verifyRuntimeIdentity(c, o));
  });
});
test("authorization, image verification and credential scope cannot be bypassed", () => {
  for (const change of [c => { c.authorization.approved = false; }, c => { c.authorization.phase = "4A"; },
    c => { c.authorization.runId = "SECRET_CANARY"; }, c => { c.force = true; }, c => { c.image.verified = false; },
    c => { c.image.reference = "mariadb:latest"; }, c => { c.credentials.testOnly = false; },
    c => { c.credentials.origin = "production"; }, c => { c.credentials.setupAccount = c.credentials.applicationAccount; },
    c => { c.credentials.password = "SECRET_CANARY"; }, c => { c.permittedSchemas.push("railway"); }]) {
    const { c, o } = pair(); change(c); refused(() => environment.verifyRuntimeIdentity(c, o));
  }
  const { c, o } = pair("provisioning-identity"); o.schemaEmpty = false; refused(() => environment.verifyProvisioningIdentity(c, o));
});
test("accessor-bearing identity inputs cannot leak their errors or execute getters", () => {
  const { c, o } = pair(); let reads = 0;
  Object.defineProperty(c, "schema", { get() { reads++; throw new Error("SECRET_CANARY"); }, enumerable: true });
  refused(() => environment.verifyRuntimeIdentity(c, o)); assert.equal(reads, 0);
  const other = pair();
  other.c.runId = { toString() { reads++; throw new Error("SECRET_CANARY"); } };
  refused(() => environment.verifyRuntimeIdentity(other.c, other.o)); assert.equal(reads, 0);
  refused(() => environment.planOwnedTeardown(c, resources(other.c))); assert.equal(reads, 0);
});
test("child environments use only explicit OS plumbing and fixed offline values", () => {
  const source = { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", PATH: "SECRET_CANARY", NODE_OPTIONS: "SECRET_CANARY", NODE_PATH: "SECRET_CANARY", TZ: "America/New_York" };
  for (const key of ["DATABASE_URL", "RAILWAY_TOKEN", "RENDER_API_KEY", "RESEND_API_KEY"]) Object.defineProperty(source, key, { get() { throw new Error("Must not read production values"); }, enumerable: true });
  assert.deepEqual(environment.buildChildEnvironment(source), { NODE_ENV: "test", TZ: "UTC", WMO_APPOINTMENT_HARNESS_PHASE: "4A", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" });
  refused(() => environment.buildChildEnvironment({ TEMP: "unsafe\nvalue" }), "CHILD_ENV_INVALID");
});
test("owned teardown plans are immutable data and reject unowned or extra resources", () => {
  const { c } = pair(); const plan = environment.planOwnedTeardown(c, resources(c));
  assert.equal(plan.executable, false); assert.equal(plan.requiresSeparateAuthorization, true); assert.ok(Object.isFrozen(plan.resources));
  for (const change of [r => { r[0].id = "d".repeat(64); }, r => { r[1].labels["wmo.test.run"] = "other"; },
    r => { r.push(clone(r[0])); }, r => { r[2] = clone(r[1]); }, r => { r[2].kind = "worktree"; }]) {
    const rs = resources(c); change(rs); refused(() => environment.planOwnedTeardown(c, rs), "OWNERSHIP_INVALID");
  }
});
test("FIX ownership rejects three coerced duplicate kinds", () => {
  const { c } = pair();
  const observations = [0, 1, 2].map(() => ({ kind: ["container"], id: c.containerId, labels: clone(c.labels) }));
  refused(() => environment.planOwnedTeardown(c, observations), "OWNERSHIP_INVALID");
});
test("FIX ownership kinds must be primitive enum strings", async t => {
  const variants = {
    array: () => ["network"], object: () => ({}), boxed_string: () => new String("network"), symbol: () => Symbol("network"),
    number: () => 1, boolean: () => true, null: () => null, undefined: () => undefined, bigint: () => 1n, function: () => () => "network"
  };
  for (const [name, value] of Object.entries(variants)) await t.test(name, () => {
    const { c } = pair(), observations = resources(c); observations[1].kind = value();
    refused(() => environment.planOwnedTeardown(c, observations));
  });
});
test("FIX ownership requires a complete exact observation set", async t => {
  const variants = {
    duplicate_string: r => { r[1] = clone(r[0]); }, missing_network: r => { r.splice(1, 1); }, missing_volume: r => { r.pop(); },
    unknown_kind: r => { r[2].kind = "database"; }, additional_resource: r => { r.push({ ...clone(r[0]), kind: "database" }); },
    container_id: r => { r[0].id = "d".repeat(64); }, network_id: r => { r[1].id = "d".repeat(64); }, volume_id: r => { r[2].id += "_other"; },
    purpose_label: r => { r[1].labels["wmo.test.purpose"] = "other-purpose"; }, run_label: r => { r[2].labels["wmo.test.run"] = "other-run"; }
  };
  for (const [name, change] of Object.entries(variants)) await t.test(name, () => {
    const { c } = pair(), observations = resources(c); change(observations);
    refused(() => environment.planOwnedTeardown(c, observations), "OWNERSHIP_INVALID");
  });
  await t.test("correct_observations", () => {
    const { c } = pair(), observations = resources(c), before = JSON.stringify(observations);
    const plan = environment.planOwnedTeardown(c, observations);
    assert.deepEqual(plan.resources, [{ kind: "container", id: c.containerId }, { kind: "network", id: c.networkId }, { kind: "volume", id: c.volumeName }]);
    assert.equal(plan.executable, false); assert.equal(plan.requiresSeparateAuthorization, true);
    assert.equal(JSON.stringify(observations), before);
  });
});
test("FIX malformed resource collections and identities always refuse", () => {
  for (const value of [null, undefined, {}, "container", [], [null, {}, {}], new Array(3), Symbol("resources")]) {
    const { c } = pair(); refused(() => environment.planOwnedTeardown(c, value));
  }
  for (const value of [null, undefined, {}, [], "identity", new String("identity")]) {
    refused(() => environment.verifyRuntimeIdentity(value, {}));
    refused(() => environment.verifyProvisioningIdentity(value, {}));
  }
});
test("FIX identity canaries never escape as caller error objects", () => {
  const canary = "DIAGNOSTIC_PRIVATE_CANARY", supplied = new environment.SafetyError(canary);
  supplied.stack = `private stack ${canary}`; supplied.cause = { privateData: canary };
  const input = new Proxy({}, { getPrototypeOf() { throw supplied; } });
  for (const operation of [() => environment.verifyRuntimeIdentity(input, {}), () => environment.verifyProvisioningIdentity(input, {}),
    () => environment.planOwnedTeardown(input, [])]) {
    let outward;
    try { operation(); } catch (error) { outward = error; }
    assert.ok(outward instanceof environment.SafetyError); assert.notEqual(outward, supplied);
    assert.ok(["IDENTITY_INVALID", "OWNERSHIP_INVALID"].includes(outward.code));
    assert.ok(!`${outward.message}\n${outward.stack}\n${JSON.stringify(outward)}`.includes(canary));
    assert.equal(Object.hasOwn(outward, "cause"), false);
  }
});
test("FIX caught diagnostic normalization handles ordinary, coded and hostile errors", async t => {
  const canary = "DIAGNOSTIC_PRIVATE_CANARY";
  const errors = {
    ordinary: () => new Error(canary),
    known_safety_code: () => new environment.SafetyError("SCHEMA_INVALID"),
    known_ordinary_code: () => Object.assign(new Error(canary), { code: "ENDPOINT_INVALID" }),
    accessor_code: () => { const error = new environment.SafetyError("IDENTITY_INVALID"); Object.defineProperty(error, "code", { get() { throw new Error(canary); } }); return error; },
    hostile_error_proxy: () => new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(canary); }, getPrototypeOf() { throw new Error(canary); } })
  };
  for (const target of ["runtime", "provisioning", "teardown"]) for (const [kind, makeError] of Object.entries(errors)) await t.test(`${target}_${kind}`, () => {
    const supplied = makeError();
    if (kind !== "hostile_error_proxy") { supplied.message = canary; supplied.stack = `private stack ${canary}`; supplied.privateData = canary; supplied.cause = { privateData: canary }; }
    const input = new Proxy({}, { getPrototypeOf() { throw supplied; } });
    const operation = target === "runtime" ? () => environment.verifyRuntimeIdentity(input, {})
      : target === "provisioning" ? () => environment.verifyProvisioningIdentity(input, {}) : () => environment.planOwnedTeardown(input, []);
    let outward;
    try { operation(); } catch (error) { outward = error; }
    assert.ok(outward instanceof environment.SafetyError); assert.notEqual(outward, supplied);
    const expected = kind === "known_safety_code" ? "SCHEMA_INVALID" : kind === "known_ordinary_code" ? "ENDPOINT_INVALID"
      : target === "teardown" ? "OWNERSHIP_INVALID" : "IDENTITY_INVALID";
    assert.equal(outward.code, expected);
    assert.ok(!`${outward.message}\n${outward.stack}\n${JSON.stringify(outward)}`.includes(canary));
    assert.equal(Object.hasOwn(outward, "cause"), false); assert.equal(Object.hasOwn(outward, "privateData"), false);
    const safeEvidence = invariants.createOfflineEvidence({ ...evidence(), outcome: "refused", failureClassification: "environment" });
    assert.ok(!JSON.stringify({ code: outward.code, message: outward.message, evidence: safeEvidence }).includes(canary));
  });
});
test("FIX documented identity rejection codes remain stable", async t => {
  const variants = {
    IDENTITY_INVALID: c => { c.runId = ""; }, SCHEMA_INVALID: c => { c.schema = "railway"; },
    FIXTURE_INVALID: c => { delete c.fixtureFingerprint; }, ENDPOINT_INVALID: c => { c.endpoint.host = "localhost"; },
    AUTHORIZATION_REQUIRED: c => { c.authorization.approved = false; }, IMAGE_UNVERIFIED: c => { c.image.verified = false; },
    CREDENTIAL_SCOPE_INVALID: c => { c.credentials.origin = "production"; }
  };
  for (const [code, change] of Object.entries(variants)) await t.test(code, () => {
    const { c, o } = pair(); change(c); refused(() => environment.verifyRuntimeIdentity(c, o), code);
  });
});
test("Compose has zero services and an intentionally absent verified digest", () => {
  const text = fs.readFileSync(path.join(__dirname, "compose.yaml"), "utf8");
  assert.equal(environment.assertInertCompose(text).services, 0);
  assert.match(text, /verified_manifest_digest: null/); assert.match(text, /mysql:9\.7\.2-oraclelinux9/);
  refused(() => environment.assertInertCompose(text.replace("services: {}", "services:\n  mysql:\n    image: mysql:latest")), "COMPOSE_NOT_INERT");
  refused(() => environment.assertInertCompose(`${text}\nservices: {}\n`), "COMPOSE_NOT_INERT");
});
test("independent synthetic schema covers all required tables, fields, keys and unready defaults", () => {
  const f = schema.fixtureSpecification();
  assert.deepEqual(Object.keys(f.tables), ["appointments", "notifications", "appointment_reservations", "appointment_booking_requests", "appointment_feature_state"]);
  assert.equal(Object.values(f.tables).reduce((n, t) => n + Object.keys(t.columns).length, 0), 43);
  assert.ok(Object.values(f.tables).every(t => t.engine === "InnoDB"));
  assert.equal(f.tables.appointments.columns.id.type, "int"); assert.equal(f.tables.appointments.columns.id.autoIncrement, true);
  assert.equal(f.tables.appointments.columns.appointment_revision.type, "bigint unsigned");
  assert.equal(f.tables.appointments.columns.orientation_started_at.type, "datetime");
  assert.equal(f.tables.appointments.columns.orientation_completed_at.default, null);
  assert.deepEqual(f.tables.appointment_reservations.indexes[0].columns, ["service_key", "appointment_date", "appointment_time"]);
  for (const table of ["appointment_reservations", "appointment_booking_requests"]) {
    assert.equal(f.tables[table].columns.appointment_id.type, "int");
    assert.equal(f.tables[table].foreignKeys[0].onDelete, "RESTRICT"); assert.equal(f.tables[table].foreignKeys[0].onUpdate, "RESTRICT");
  }
  assert.equal(f.tables.appointment_booking_requests.columns.appointment_id.nullable, true);
  assert.equal(f.tables.appointment_reservations.columns.appointment_id.nullable, false);
  assert.equal(f.tables.appointment_booking_requests.columns.request_hash.collation, "ascii_bin");
  assert.equal(f.tables.notifications.columns.isRead.default, 0);
  assert.equal(f.tables.notifications.columns.createdAt.default, "CURRENT_TIMESTAMP");
  assert.deepEqual(f.marker, { feature_key: "service_slots", schema_version: 1, backfill_complete: 0 });
  assert.equal(Object.keys(f.services).length, 4); assert.deepEqual(f.times, ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"]);
  assert.match(f.citizen.full_name, /^Synthetic/); assert.match(f.citizen.email, /@example\.invalid$/); assert.match(f.citizen.contact_number, /^0\d{10}$/);
  assert.match(f.identifiers.orientationToken, /^ORI-synthetic-/); assert.match(f.identifiers.requestKey, /^synthetic-/);
  assert.equal(f.executable, false); assert.ok(Object.isFrozen(f.tables)); assert.equal(f.fingerprint, schema.fixtureFingerprint());
});
test("fixture DDL is qualified inert data, never an executable migration or activation", () => {
  const ddl = schema.fixtureDdl(SCHEMA), text = ddl.statements.join("\n");
  assert.equal(ddl.executable, false); assert.equal(ddl.statements.length, 6);
  assert.equal(ddl.statements.filter(s => s.startsWith(`CREATE TABLE \`${SCHEMA}\`.`)).length, 5);
  assert.doesNotMatch(text, /\b(?:ALTER|DROP|GRANT|CREATE DATABASE|CREATE USER)\b/);
  assert.match(ddl.statements.at(-1), /VALUES \('service_slots', 1, 0\);$/);
  for (const name of ["railway", "test", "mysql", `${SCHEMA}; DROP TABLE x`]) refused(() => schema.fixtureDdl(name), "SCHEMA_INVALID");
});
test("real R2 validator reaches the unready marker using only a trapped metadata model", () => {
  const service = path.resolve(__dirname, "../../../services/appointmentSchedulingService.js");
  const report = child(`
    const m=require('./helpers/schema.cjs').fixtureMetadata(${JSON.stringify(SCHEMA)});
    const {AppointmentSchedulingService}=require(${JSON.stringify(service)});
    let queries=0,released=0,destroyed=0;
    const c={query(sql,values,done){queries++;let rows;
      if(sql==='SELECT DATABASE() AS schema_name')rows=[{schema_name:m.schema}];
      else if(sql.includes('information_schema.TABLES'))rows=m.tables;
      else if(sql.includes('information_schema.COLUMNS'))rows=m.columns;
      else if(sql.includes('information_schema.STATISTICS'))rows=m.indexes;
      else if(sql.includes('information_schema.KEY_COLUMN_USAGE'))rows=m.foreignKeys;
      else if(sql.startsWith('SELECT feature_key,'))rows=m.marker;
      else throw new Error('Unexpected model operation');done(null,rows);},release(){released++;},destroy(){destroyed++;}};
    const service=new AppointmentSchedulingService({getConnection:done=>done(null,c)},{enabled:()=>true});
    await assert.rejects(service.ready(),{statusCode:503});assert.equal(queries,6);assert.equal(m.marker[0].backfill_complete,0);
    console.log(JSON.stringify({queries,released,destroyed,counters}));`);
  assert.equal(report.queries, 6); assert.equal(report.released, 0); assert.equal(report.destroyed, 1); noEffects(report.counters);
});
test("runtime hooks are deferred, never invoked, and every activation path refuses", () => {
  let calls = 0;
  const deferred = runtime.createDeferredRuntime(Object.fromEntries(["poolFactory", "observerFactory", "serviceFactory", "routeLoader", "clock", "sessionService"].map(k => [k, () => { calls++; throw new Error("SECRET_CANARY"); }])));
  assert.equal(deferred.describe().suppliedBoundaries.length, 6);
  for (const name of ["activate", "connect", "loadRoutes", "executeFixtures"]) refused(() => deferred[name](), "PHASE4A_RUNTIME_DISABLED");
  assert.equal(deferred.dispose().externalCleanupPerformed, false); assert.equal(calls, 0);
  refused(() => runtime.createDeferredRuntime({ unsafe: true }), "RUNTIME_CONTRACT_INVALID");
  refused(() => runtime.createDeferredRuntime(null), "RUNTIME_CONTRACT_INVALID");
});
test("email/SMS/analytics/HTTP/socket guards record only blocked counts", () => {
  const guards = runtime.createProviderGuards();
  for (const [kind, method] of [["email", "send"], ["sms", "send"], ["analytics", "track"], ["http", "request"], ["socket", "emit"]]) {
    refused(() => guards[kind][method]({ secret: "SECRET_CANARY" }), "OUTBOUND_PROVIDER_BLOCKED");
  }
  assert.deepEqual(guards.counts(), { email: 1, sms: 1, analytics: 1, http: 1, socket: 1 });
  assert.ok(!JSON.stringify(guards.counts()).includes("SECRET_CANARY"));
});
test("barriers pause until explicit release and remain independent", async () => {
  await control.withControls(async controls => {
    const a = controls.barrier("first"), b = controls.barrier("second"); let progressed = false;
    const pa = a.wait().then(() => { progressed = true; }); const pb = b.wait();
    await a.reached(); await b.reached(); assert.equal(progressed, false);
    b.release(); await pb; assert.equal(progressed, false); a.release(); await pa;
    assert.equal(progressed, true); assert.equal(a.release(), false); assert.equal(controls.inspect().pending, 0);
  });
});
test("barrier observers record deterministic participant arrivals", async () => {
  await control.withControls(async controls => {
    const b = controls.barrier("two-participants"), reached = b.reached(2);
    const waits = [b.wait(), b.wait()]; await reached; assert.equal(b.inspect().arrivals, 2);
    b.release(); await Promise.all(waits); assert.equal(b.inspect().observers, 0);
  });
});
test("FIX rejected wait creates no arrival or reached notification", async () => {
  await control.withControls(async controls => {
    const barrier = controls.barrier("invalid-arrival"), before = barrier.inspect();
    refused(() => barrier.wait({ signal: {} }), "CONTROL_INVALID");
    assert.deepEqual(barrier.inspect(), before);
    let observed = false;
    const observation = barrier.reached().then(() => { observed = true; return "arrived"; }, error => error.code);
    await Promise.resolve();
    assert.equal(observed, false); assert.equal(barrier.inspect().observers, 1); assert.equal(barrier.inspect().arrivals, 0);
    const legitimate = barrier.wait();
    assert.equal(barrier.inspect().arrivals, 1); assert.equal(barrier.inspect().pending, 1);
    assert.equal(await observation, "arrived");
    assert.equal(barrier.release(), true); await legitimate;
    assert.equal(controls.inspect().pending, 0);
  });
});
test("FIX invalid wait options preserve existing participants atomically", async t => {
  const variants = {
    invalid_signal: () => ({ signal: {} }), false_signal: () => ({ signal: false }), fake_signal: () => ({ signal: Object.create(AbortSignal.prototype) }),
    zero_timeout: () => ({ timeoutMs: 0 }), infinite_timeout: () => ({ timeoutMs: Infinity }), unknown_option: () => ({ unsafe: true }),
    null_options: () => null, array_options: () => [], string_options: () => "options",
    signal_accessor: () => Object.defineProperty({}, "signal", { enumerable: true, get() { throw new Error("DIAGNOSTIC_PRIVATE_CANARY"); } }),
    timeout_accessor: () => Object.defineProperty({}, "timeoutMs", { enumerable: true, get() { throw new Error("DIAGNOSTIC_PRIVATE_CANARY"); } })
  };
  for (const [name, options] of Object.entries(variants)) await t.test(name, async () => {
    await control.withControls(async controls => {
      const barrier = controls.barrier("existing-participant"), legitimate = barrier.wait(), before = barrier.inspect();
      refused(() => barrier.wait(options()));
      assert.deepEqual(barrier.inspect(), before);
      barrier.release(); await legitimate; assert.equal(controls.inspect().pending, 0);
      refused(() => barrier.wait(options()));
    });
  });
});
test("FIX pre-aborted requests are not admitted and do not cancel other participants", async () => {
  await control.withControls(async controls => {
    const barrier = controls.barrier("aborted-before-arrival");
    const existing = barrier.wait().then(() => "released", error => error.code), before = barrier.inspect();
    const abort = new AbortController(); abort.abort();
    await assert.rejects(barrier.wait({ signal: abort.signal }), { code: "BARRIER_CANCELLED" });
    assert.deepEqual(barrier.inspect(), before);
    const observer = barrier.reached(2).then(() => "arrived", error => error.code);
    const next = barrier.wait(); assert.equal(await observer, "arrived");
    barrier.release(); assert.equal(await existing, "released"); await next;
    assert.equal(controls.inspect().pending, 0);
  });
});
test("cancel, failure and abort reject participants safely and clear waits", async () => {
  for (const how of ["cancel", "fail", "abort"]) await control.withControls(async controls => {
    const b = controls.barrier("cancel-case"), abort = new AbortController();
    const pending = assert.rejects(b.wait({ signal: abort.signal }), { code: how === "fail" ? "BARRIER_FAILED" : "BARRIER_CANCELLED" });
    if (how === "abort") abort.abort(new Error("SECRET_CANARY")); else b[how](new Error("SECRET_CANARY"));
    await pending; await assert.rejects(b.wait(), error => !error.message.includes("SECRET_CANARY"));
    assert.equal(b.inspect().pending, 0);
  });
});
test("bounded timeout propagates to waiters and observers without hanging", async () => {
  await control.withControls(async controls => {
    const b = controls.barrier("timeout-case");
    const waiting = assert.rejects(b.wait({ timeoutMs: 10 }), { code: "BARRIER_TIMEOUT" });
    const observer = assert.rejects(b.reached(2), { code: "BARRIER_TIMEOUT" });
    await Promise.all([waiting, observer]); assert.equal(controls.inspect().pending, 0);
  });
  for (const timeoutMs of [0, -1, 5001, Infinity]) refused(() => control.createControls({ timeoutMs }), "CONTROL_TIMEOUT_INVALID");
});
test("scope failure always disposes barriers and does not swallow the primary error", async () => {
  let retained, rejected;
  await assert.rejects(control.withControls(async controls => {
    retained = controls; rejected = assert.rejects(controls.barrier("unfinished").wait(), { code: "BARRIER_CANCELLED" });
    throw new Error("expected-offline-failure");
  }), /expected-offline-failure/);
  await rejected; assert.equal(retained.inspect().disposed, true); assert.equal(retained.inspect().pending, 0);
  retained.dispose(); refused(() => retained.barrier("late"), "CONTROL_INVALID");
});
test("fault points are local one-shot before/after adapter controls", () => {
  const faults = control.createFaultPoints([{ point: "commit", when: "after" }, { point: "rollback", when: "before", times: 2 }]);
  faults.hit("commit", "before"); refused(() => faults.hit("commit", "after"), "ADAPTER_FAULT"); faults.hit("commit", "after");
  refused(() => faults.hit("rollback", "before"), "ADAPTER_FAULT"); refused(() => faults.hit("rollback", "before"), "ADAPTER_FAULT");
  assert.equal(faults.remaining(), 0); assert.equal(control.createFaultPoints().remaining(), 0);
  refused(() => control.createFaultPoints([{ point: "production-url", when: "before" }]), "FAULT_PLAN_INVALID");
});

const empty = () => ({ appointments: [], reservations: [], requests: [], notifications: [] });
function booking(id = 17, purpose = "Accreditation", hash = "a") {
  const code = `APT-${String(id).padStart(6, "0")}`, state = empty();
  state.appointments.push({ id, purpose, appointment_code: code, preferred_date: "2026-11-23 10:00:00", status: "pending", appointment_revision: 0, assigned_to: null, assigned_at: null });
  state.reservations.push({ appointment_id: id, service_key: schema.SERVICES[purpose], appointment_date: "2026-11-23", appointment_time: "10:00:00" });
  state.requests.push({ request_hash: hash.repeat(64), payload_hash: "c".repeat(64), appointment_id: id, appointment_code: code });
  state.notifications.push({ id, type: "appointment" }); return state;
}
test("snapshot invariants admit one citizen per service slot and different services at the same time", () => {
  const a = booking(), b = booking(18, "Others", "b");
  assert.equal(invariants.assertBookingDelta(empty(), a, 1), true);
  const both = Object.fromEntries(Object.keys(a).map(k => [k, [...a[k], ...b[k]]]));
  assert.equal(invariants.assertBookingDelta(empty(), both, 2), true);
});
test("invariant negative controls detect capacity, orphans, duplicate keys and broken request linkage", () => {
  const variants = [s => s.reservations.push({ ...s.reservations[0] }), s => { s.reservations[0].appointment_id = 999; },
    s => { s.reservations[0].appointment_time = "12:00:00"; }, s => { s.reservations[0].appointment_date = "2026-02-30"; },
    s => { s.reservations[0].service_key = "orientation"; }, s => { s.requests[0].appointment_id = 999; },
    s => s.requests.push({ ...s.requests[0] }), s => { s.requests[0].appointment_code = "APT-999999"; },
    s => { s.appointments[0].status = "cancelled"; }, s => { s.appointments[0].appointment_revision = -1; }, s => { s.reservations = []; }];
  for (const change of variants) { const s = booking(); change(s); refused(() => invariants.assertReservationIntegrity(s)); }
  const a = booking(), b = booking(18, "Accreditation", "b");
  refused(() => invariants.assertReservationIntegrity(Object.fromEntries(Object.keys(a).map(k => [k, [...a[k], ...b[k]]]))), "INVARIANT_CAPACITY");
});
test("notification atomicity is checked independently of a success-shaped booking", () => {
  const after = booking(); after.notifications = [];
  refused(() => invariants.assertBookingDelta(empty(), after, 1), "INVARIANT_NOTIFICATION_ATOMICITY");
});
test("revision, release, acceptance preservation and failed-reschedule snapshots are enforced", () => {
  for (const action of ["accept", "reject", "cancel", "reschedule"]) {
    const before = booking(), after = clone(before); after.appointments[0].appointment_revision++;
    after.appointments[0].status = ({ accept: "approved", reject: "rejected", cancel: "cancelled", reschedule: "rescheduled" })[action];
    if (["reject", "cancel"].includes(action)) after.reservations = [];
    if (action === "reschedule") { after.appointments[0].preferred_date = "2026-11-23 11:00:00"; after.reservations[0].appointment_time = "11:00:00"; }
    assert.equal(invariants.assertChange(before, after, { appointmentId: 17, action, succeeded: true }), true);
    after.appointments[0].appointment_revision++;
    refused(() => invariants.assertChange(before, after, { appointmentId: 17, action, succeeded: true }), "INVARIANT_REVISION");
  }
  const before = booking();
  assert.equal(invariants.assertChange(before, clone(before), { appointmentId: 17, action: "reschedule", succeeded: false }), true);
  const corrupted = clone(before); corrupted.appointments[0].assigned_to = "forged";
  refused(() => invariants.assertChange(before, corrupted, { appointmentId: 17, action: "reschedule", succeeded: false }), "INVARIANT_FAILED_RESCHEDULE_PRESERVATION");
});
test("uncertain-result recovery must preserve state and the original durable-key linkage", () => {
  const before = booking(), options = { requestHash: "a".repeat(64), appointmentId: 17, appointmentCode: "APT-000017" };
  assert.equal(invariants.assertRecoveryUnchanged(before, clone(before), options), true);
  const duplicate = clone(before); duplicate.notifications.push({ id: 18, type: "appointment" });
  refused(() => invariants.assertRecoveryUnchanged(before, duplicate, options), "INVARIANT_RECOVERY_MUTATION");
});
test("independent Philippine oracle detects UTC substitution at all three fixed instants", () => {
  for (const [instant, timestamp] of [["2026-11-20T15:59:59Z", "2026-11-20 23:59:59"], ["2026-11-20T16:00:00Z", "2026-11-21 00:00:00"], ["2026-11-20T16:00:01Z", "2026-11-21 00:00:01"]]) {
    assert.equal(invariants.assertPhilippineSnapshot(instant, { timestamp, date: timestamp.slice(0, 10) }), true);
    const wrong = instant.replace("T", " ").slice(0, 19);
    refused(() => invariants.assertPhilippineSnapshot(instant, { timestamp: wrong, date: wrong.slice(0, 10) }), "INVARIANT_PHILIPPINE_TIME");
  }
});
test("terminal disposition rejects unsafe release, fallback cleanup and unconfirmed success", () => {
  const safe = { setup: "acknowledged", commit: "acknowledged", restore: "acknowledged", unsafe: false, releaseAttempts: 1, destroyAttempts: 0, outcome: "success" };
  assert.equal(invariants.assertTerminalDisposition(safe), true);
  for (const commit of ["attempted", "pending"]) assert.equal(invariants.assertTerminalDisposition({ commit, unsafe: true, releaseAttempts: 0, destroyAttempts: 1, outcome: "unconfirmed" }), true);
  refused(() => invariants.assertTerminalDisposition({ ...safe, unsafe: true }), "INVARIANT_TERMINAL_DISPOSITION");
  refused(() => invariants.assertTerminalDisposition({ ...safe, destroyAttempts: 1 }), "INVARIANT_TERMINAL_DISPOSITION");
  refused(() => invariants.assertTerminalDisposition({ ...safe, commit: "attempted", rollback: "acknowledged", outcome: "unconfirmed" }), "INVARIANT_TERMINAL_DISPOSITION");
  assert.equal(invariants.assertTerminalDisposition({ ...safe, commit: "pending", rollback: "acknowledged", outcome: "failure" }), true);
  assert.equal(invariants.assertTerminalDisposition({ ...safe, restore: "attempted", unsafe: true, releaseAttempts: 0, destroyAttempts: 1 }), true);
  refused(() => invariants.assertTerminalDisposition({ commit: "attempted", unsafe: true, releaseAttempts: 0, destroyAttempts: 1, outcome: "success" }), "INVARIANT_UNCONFIRMED_SUCCESS");
});
function evidence() { return { testId: "P4A.evidence", sourceCommit: environment.BASELINE, reportedEngineVersion: null, fixtureVariant: "golden-unready", runId: RUN,
  outcome: "pass", counts: { modelQueries: 0, databaseQueries: 0, leases: 0, releaseAttempts: 0, destroyAttempts: 0 }, checks: ["capacity", "request-links"], failureClassification: "none", cleanup: "not-needed" }; }
test("evidence is explicitly synthetic, immutable and never reports database verification", () => {
  const input = evidence(), output = invariants.createOfflineEvidence(input); input.checks.push("release");
  assert.equal(output.evidenceClass, "offline-model"); assert.equal(output.persistence.durableVerified, false);
  assert.equal(output.engine.connected, false); assert.equal(output.engine.versionVerified, false); assert.equal(output.counts.databaseQueries, 0);
  assert.equal(output.persistence.checks.length, 2); assert.ok(Object.isFrozen(output.counts));
});
test("evidence rejects secrets, URLs, arbitrary diagnostics and invented database results", () => {
  for (const change of [e => { e.password = "SECRET_CANARY"; }, e => { e.testId = "ORI-secret"; }, e => { e.fixtureVariant = "citizen@example.invalid"; },
    e => { e.failureClassification = "mysql://SECRET_CANARY@railway.app"; }, e => { e.reportedEngineVersion = "server SECRET_CANARY"; },
    e => { e.counts.databaseQueries = 1; }, e => { e.counts.cookie = "SECRET_CANARY"; }, e => { e.checks.push("https://invalid/?token=ORI-secret"); }]) {
    const e = evidence(); change(e); refused(() => invariants.createOfflineEvidence(e), "EVIDENCE_INVALID");
  }
  let reads = 0; const input = evidence();
  Object.defineProperty(input.counts, "modelQueries", { get() { reads++; return "SECRET_CANARY"; }, enumerable: true });
  refused(() => invariants.createOfflineEvidence(input), "EVIDENCE_INVALID"); assert.equal(reads, 0);
});
