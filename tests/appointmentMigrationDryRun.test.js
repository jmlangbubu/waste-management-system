"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const migration = require("./helpers/appointmentMigrationDryRun");
const copy = value => structuredClone(value);

test("import/refusal: driver and SQL remain unavailable without distinct local authorization", async () => {
  assert.throws(() => migration.validateTarget({}), { code: "MIGRATION_EXECUTION_REFUSED" });
  if (process.env.WMO_APPOINTMENT_MIGRATION_EXECUTE !== migration.AUTH)
    await assert.rejects(migration.openStaging(), { code: "MIGRATION_EXECUTION_REFUSED" });
});

test("import/refusal: instrumented default path performs zero driver, network, process, write or key-generation operations", async () => {
  const Module = require("node:module"), fs = require("node:fs"), net = require("node:net"), child = require("node:child_process"), crypto = require("node:crypto");
  const undo = [], attempted = [];
  const block = (object, key) => { const original = object[key]; object[key] = () => { attempted.push(key); throw new Error("FORBIDDEN_OFFLINE_EFFECT"); }; undo.push(() => { object[key] = original; }); };
  const load = Module._load;
  Module._load = function (request, ...args) {
    if (/mysql2|dotenv|(?:^|[\\/])config[\\/]|resend/i.test(request)) { attempted.push("driver/config import"); throw new Error("FORBIDDEN_OFFLINE_IMPORT"); }
    return load.call(this, request, ...args);
  };
  undo.push(() => { Module._load = load; });
  for (const key of ["writeFile", "writeFileSync", "appendFileSync", "unlinkSync", "mkdirSync"]) block(fs, key);
  for (const key of ["connect", "createConnection"]) block(net, key);
  for (const key of ["spawn", "exec", "execFile", "spawnSync", "execSync"]) block(child, key);
  for (const key of ["generateKeyPair", "generateKeyPairSync", "randomBytes"]) block(crypto, key);
  try {
    const modulePath = require.resolve("./helpers/appointmentMigrationDryRun"); delete require.cache[modulePath];
    const fresh = require(modulePath);
    if (process.env.WMO_APPOINTMENT_MIGRATION_EXECUTE !== migration.AUTH)
      await assert.rejects(fresh.openStaging(), { code: "MIGRATION_EXECUTION_REFUSED" });
    assert.deepEqual(attempted, []);
  } finally { undo.reverse().forEach(restore => restore()); }
});
test("target: rejects production, inherited credentials, reused populated staging and ambiguous targets", () => {
  const env = { WMO_APPOINTMENT_MIGRATION_EXECUTE: migration.AUTH, WMO_APPOINTMENT_MIGRATION_PROFILE: migration.PROFILE,
    WMO_APPOINTMENT_MIGRATION_HOST: "127.0.0.1", WMO_APPOINTMENT_MIGRATION_PORT: "33309", WMO_APPOINTMENT_MIGRATION_DATABASE: "wmo_appointment_staging_offline_migration",
    WMO_APPOINTMENT_MIGRATION_CONFIRM_EMPTY: "wmo_appointment_staging_offline_migration", WMO_APPOINTMENT_MIGRATION_USER: "wmo_appt_migration",
    WMO_APPOINTMENT_MIGRATION_PASSWORD: "synthetic-never-connected", WMO_APPOINTMENT_MIGRATION_OBSERVER_USER: "wmo_appt_migration_observer", WMO_APPOINTMENT_MIGRATION_OBSERVER_PASSWORD: "synthetic-never-connected" };
  assert.equal(migration.validateTarget(env).port, 33309);
  for (const change of [{ DATABASE_URL: "forbidden" }, { MYSQL_URL: "forbidden" }, { MYSQL_PWD: "forbidden" }, { RESEND_API_KEY: "forbidden" },
    { WMO_APPOINTMENT_MYSQL_EXECUTE: "forbidden" }, { WMO_APPOINTMENT_MIGRATION_PROFILE: "production" },
    { WMO_APPOINTMENT_MIGRATION_HOST: "localhost" }, { WMO_APPOINTMENT_MIGRATION_HOST: "remote.invalid" }, { WMO_APPOINTMENT_MIGRATION_PORT: "33308" },
    { WMO_APPOINTMENT_MIGRATION_PORT: "3306" }, { WMO_APPOINTMENT_MIGRATION_PORT: "NaN" }, { WMO_APPOINTMENT_MIGRATION_CONFIRM_EMPTY: "different" },
    { WMO_APPOINTMENT_MIGRATION_DATABASE: "railway" }, { WMO_APPOINTMENT_MIGRATION_DATABASE: "wmo_appointment_staging_x;DROP" },
    { WMO_APPOINTMENT_MIGRATION_DATABASE: "wmo_appointment_staging_20261122_8ac4ef3e", WMO_APPOINTMENT_MIGRATION_CONFIRM_EMPTY: "wmo_appointment_staging_20261122_8ac4ef3e" },
    { WMO_APPOINTMENT_MIGRATION_USER: "root" }, { WMO_APPOINTMENT_MIGRATION_PASSWORD: "" }, { WMO_APPOINTMENT_MIGRATION_OBSERVER_PASSWORD: "" }])
    assert.throws(() => migration.validateTarget({ ...env, ...change }));
});
test("fixture: exactly three additive-safe legacy tables; defaults and quiz shape explicitly synthetic", () => {
  const sql = migration.legacyFixtureStatements().join(";"), columns = migration.fixtureColumns();
  assert.equal(columns.appointments.length, 23); assert.equal(columns.notifications.length, 8); assert.equal(columns.orientation_quiz_results.length, 2);
  assert.match(sql, /REFERENCES appointments\(id\) ON DELETE RESTRICT ON UPDATE RESTRICT/);
  assert.doesNotMatch(sql, /appointment_revision|CREATE TABLE appointment_reservations|INSERT INTO/);
  assert.equal(migration.DDL.length, 5); assert.match(migration.DDL[2], /^ALTER TABLE appointments ADD COLUMN appointment_revision BIGINT UNSIGNED NOT NULL DEFAULT 0$/);
  assert.ok(migration.DDL.every(s => !/DROP|RENAME|TRUNCATE|ALTER TABLE.*(?:MODIFY|CHANGE|DROP)/.test(s)));
});
test("metadata: real schema checkers reject wrong defaults, generated fields, FK actions, types and indexes", () => {
  const source = require("./helpers/appointmentSchedulingFixture").reviewedSchema();
  const meta = { tables: [...source.tables, { TABLE_NAME: "orientation_quiz_results", ENGINE: "InnoDB" }], columns: copy(source.columns), indexes: copy(source.indexes),
    foreignKeys: [...copy(source.foreignKeys), { TABLE_NAME: "orientation_quiz_results", COLUMN_NAME: "appointment_id", REFERENCED_TABLE_NAME: "appointments", REFERENCED_COLUMN_NAME: "id", DELETE_RULE: "RESTRICT", UPDATE_RULE: "RESTRICT" }], triggers: [] };
  for (const c of migration.fixtureColumns().orientation_quiz_results) meta.columns.push({ TABLE_NAME: "orientation_quiz_results", COLUMN_NAME: c.name, COLUMN_TYPE: c.type,
    IS_NULLABLE: c.nullable ? "YES" : "NO", COLUMN_DEFAULT: c.default, EXTRA: c.auto ? "auto_increment" : "", GENERATION_EXPRESSION: "" });
  meta.indexes.push({ ...copy(source.indexes[0]), TABLE_NAME: "orientation_quiz_results", INDEX_NAME: "PRIMARY", COLUMN_NAME: "id" });
  const check = value => { migration.checkLegacyMetadata(value); migration.checkIndexes(value, true); migration.checkNewColumns(value); };
  check(meta);
  const column = (value, table, name) => value.columns.find(c => c.TABLE_NAME === table && c.COLUMN_NAME === name);
  for (const mutate of [
    value => { column(value, "notifications", "isRead").COLUMN_DEFAULT = "1"; },
    value => { column(value, "appointments", "notes").GENERATION_EXPRESSION = "'synthetic expression'"; },
    value => { column(value, "appointments", "contact_number").IS_NULLABLE = "YES"; },
    value => { column(value, "appointments", "preferred_date").COLUMN_TYPE = "datetime(6)"; },
    value => { column(value, "appointments", "notes").EXTRA = "INVISIBLE"; },
    value => { value.foreignKeys.find(f => f.TABLE_NAME === "orientation_quiz_results").DELETE_RULE = "CASCADE"; },
    value => { value.foreignKeys.push({ ...copy(value.foreignKeys[0]), TABLE_NAME: "appointments" }); },
    value => { value.triggers.push({ TRIGGER_NAME: "synthetic_unverified_trigger" }); },
    value => { column(value, "appointment_reservations", "appointment_id").COLUMN_TYPE = "int unsigned"; },
    value => { column(value, "appointment_booking_requests", "appointment_id").IS_NULLABLE = "NO"; },
    value => { column(value, "appointment_booking_requests", "request_hash").CHARACTER_SET_NAME = "utf8mb4"; },
    value => { column(value, "appointments", "appointment_revision").COLUMN_DEFAULT = "1"; },
    value => { value.indexes.find(i => i.TABLE_NAME === "appointments" && i.INDEX_NAME === "PRIMARY").INDEX_NAME = "id_unique"; },
    value => { value.indexes.find(i => i.TABLE_NAME === "appointment_booking_requests" && i.COLUMN_NAME === "request_hash").SUB_PART = 32; },
    value => { value.indexes.push({ ...copy(source.indexes[0]), INDEX_NAME: "unexpected_contact_unique", COLUMN_NAME: "contact_number" }); }
  ]) { const changed = copy(meta); mutate(changed); assert.throws(() => check(changed)); }
});
test("A: original eleven match aggregate service/status totals and exactly two historical active conflicts", async () => {
  const original = migration.synthetic(), result = migration.plan(original);
  const counts = {};
  for (const row of original.appointments) { const key = row.purpose + "/" + row.status; counts[key] = (counts[key] || 0) + 1; }
  assert.deepEqual(counts, { "Accreditation/approved": 1, "Accreditation/rescheduled": 1, "SWM Orientation & Clearance/pending": 4, "SWM Orientation & Clearance/completed": 2, "Others/pending": 3 });
  assert.deepEqual(result.counts, { appointments: 11, active: 9, conflictGroups: 2, involved: 4, maxClaimants: 2, futureConflicts: 0 });
  assert.deepEqual(result.conflicts.map(c => [c.service_key, c.appointment_date, c.appointment_time]).sort(), [
    ["accreditation", "2026-10-27", "10:00:00"], ["orientation", "2026-11-06", "09:00:00"]]);
  const model = migration.createOfflineModel(), report = await model.run({ attest: true });
  assert.equal(report.code, "CONFLICTS_UNRESOLVED"); assert.equal(report.ready, false); assert.equal(report.readiness, 0);
  assert.equal(model.snapshot().reservations.length, 0); assert.deepEqual(migration.protectedData(model.snapshot()), migration.protectedData(original));
});
test("B: active plus completed historical row preserves both; no invented terminal reservation", async () => {
  const model = migration.createOfflineModel("completed-pair"), before = model.snapshot(), report = await model.run({ attest: true });
  assert.equal(report.ready, true); assert.equal(model.snapshot().reservations.length, 1); assert.equal(model.snapshot().reservations[0].appointment_id, 1003);
  assert.deepEqual(migration.protectedData(model.snapshot()), migration.protectedData(before));
});
test("B: an existing completed hold is never silently deleted to accommodate another claimant", async () => {
  const model = migration.createOfflineModel("completed-pair"); model.seedExistingHold(1007);
  const report = await model.run({ attest: true }); assert.equal(report.code, "CONFLICTS_UNRESOLVED"); assert.equal(report.ready, false);
  assert.equal(model.snapshot().reservations.length, 1); assert.equal(model.snapshot().reservations[0].appointment_id, 1007); assert.equal(model.snapshot().marker, 0);
});
test("C: conflict diagnostics are deterministic and contain no synthetic personal fields or tokens", async () => {
  const model = migration.createOfflineModel(), first = await model.run({ attest: true }), second = await model.run({ attest: true });
  assert.deepEqual(first.analysis, second.analysis); assert.equal(second.ready, false);
  // Only the sanitized analysis is reportable. Internal plans contain synthetic IDs, never PII.
  assert.doesNotMatch(JSON.stringify(first.analysis), /Synthetic Citizen|09000000000|@example|ORI-SYNTHETIC|Synthetic Accepting|Synthetic migration fixture/);
});
test("D: hypothetical reconciliation is a separate fixture and changes no statuses, IDs or evidence", () => {
  const original = migration.synthetic(), preserved = copy(original), reconciled = migration.synthetic("reconciled");
  assert.equal(migration.plan(reconciled).ok, true); assert.deepEqual(original, preserved);
  assert.deepEqual(original.appointments.map(r => [r.id, r.status]), reconciled.appointments.map(r => [r.id, r.status]));
  assert.equal(reconciled.appointments.filter((r, i) => r.preferred_date !== original.appointments[i].preferred_date).length, 2);
});
test("E: all nine active records, including historical dates, receive one reservation; request hashes remain empty", async () => {
  const model = migration.createOfflineModel("reconciled"), report = await model.run({ attest: true }), state = model.snapshot();
  assert.equal(report.code, "VERIFIED_AND_ATTESTED"); assert.equal(report.ready, true); assert.equal(state.marker, 1);
  assert.equal(state.reservations.length, 9); assert.equal(new Set(state.reservations.map(r => r.appointment_id)).size, 9);
  assert.equal(new Set(state.reservations.map(r => [r.service_key, r.appointment_date, r.appointment_time].join("|"))).size, 9);
  assert.equal(state.requests.length, 0); assert.ok(state.reservations.some(r => r.appointment_date === "2026-10-08"));
});
for (const after of [1, 2, 3, 4, 5]) test("F: acknowledged DDL step " + after + " survives failure; partial replay is refused", async () => {
  const model = migration.createOfflineModel("reconciled"), baseline = model.snapshot(), report = await model.run({ attest: true, failAfterDdl: after });
  assert.equal(report.code, "INJECTED_DDL_PARTIAL"); assert.equal(report.ready, false); assert.notEqual(model.snapshot().marker, 1);
  assert.deepEqual(migration.protectedData(model.snapshot()), migration.protectedData(baseline));
  assert.equal(model.events.filter(e => e === "ddl").length, after);
  if (after < 5) { assert.equal((await model.run({ attest: true })).code, "PARTIAL_MIGRATION_REFUSED"); assert.equal(model.events.filter(e => e === "ddl").length, after); }
});
test("F: partial reservation failure rolls back DML only; DDL and unready marker remain", async () => {
  const model = migration.createOfflineModel("reconciled"), report = await model.run({ attest: true, failAfterInsert: 3 });
  assert.equal(report.code, "INJECTED_WRITE_FAILURE"); assert.equal(model.snapshot().marker, 0); assert.equal(model.snapshot().reservations.length, 0);
  assert.equal(model.events.filter(e => e === "ddl").length, 5); assert.ok(model.events.includes("rollback"));
});
test("F: an unacknowledged rollback is reported as uncertain and never ready", async () => {
  const model = migration.createOfflineModel("reconciled", { rollback: true }), report = await model.run({ attest: true, failAfterInsert: 3 });
  assert.equal(report.code, "ROLLBACK_UNCERTAIN"); assert.equal(report.ready, false); assert.equal(report.manualReview, true);
  assert.equal(model.snapshot().marker, 0); assert.ok(model.events.includes("rollback")); assert.ok(!model.events.includes("commit"));
});
test("F: backfill commit uncertainty preserves possible writes and never attests or blindly replays", async () => {
  const model = migration.createOfflineModel("reconciled"), report = await model.run({ attest: true, loseCommitAck: "backfill" });
  assert.equal(report.code, "BACKFILL_COMMIT_UNCERTAIN"); assert.equal(report.ready, false); assert.equal(model.snapshot().marker, 0); assert.equal(model.snapshot().reservations.length, 9);
  const second = await model.run({ attest: true }); assert.equal(second.code, "VERIFIED_ONLY_NO_REPLAY"); assert.equal(second.ready, false); assert.equal(model.snapshot().marker, 0);
});
test("F: uncertain attestation is invalidated; unconfirmed invalidation reports UNKNOWN", async () => {
  for (const invalidate of [false, true]) {
    const model = migration.createOfflineModel("reconciled", { invalidate }), report = await model.run({ attest: true, loseCommitAck: "attest" });
    assert.equal(report.code, "ATTEST_COMMIT_UNCERTAIN"); assert.equal(report.ready, false); assert.equal(report.readiness, invalidate ? "UNKNOWN" : 0);
  }
});
test("F: schema/default/trigger/application validation failures never yield readiness success", async () => {
  for (const flag of ["schema", "unknownDefaults", "triggers", "applicationSchema"]) {
    const model = migration.createOfflineModel("reconciled", { [flag]: true }), report = await model.run({ attest: true });
    assert.equal(report.ready, false); assert.equal(model.snapshot().marker, 0);
  }
});
test("G: a repeat is verify-only and cannot promote readiness or add reservations", async () => {
  const model = migration.createOfflineModel("reconciled"); assert.equal((await model.run()).ready, false);
  const before = model.snapshot(), repeated = await model.run({ attest: true });
  assert.equal(repeated.code, "VERIFIED_ONLY_NO_REPLAY"); assert.equal(repeated.ready, false); assert.deepEqual(model.snapshot(), before);
});
test("H: writer interference after observer verification blocks attestation", async () => {
  const model = migration.createOfflineModel("reconciled"), report = await model.run({ attest: true, interfere: true });
  assert.equal(report.code, "WRITER_INTERFERENCE"); assert.equal(report.ready, false); assert.equal(model.snapshot().marker, 0);
});
test("I: references, quiz links, orientation evidence, notifications and staff attribution are unchanged", async () => {
  const model = migration.createOfflineModel("reconciled"), before = model.snapshot(); await model.run({ attest: true });
  assert.deepEqual(migration.protectedData(model.snapshot()), migration.protectedData(before));
});
for (const [label, mutate] of [
  ["status", s => { s.appointments[0].status = "accepted"; }], ["service", s => { s.appointments[0].purpose = "accreditation"; }],
  ["time", s => { s.appointments[0].preferred_date = "2026-10-27 12:00:00"; }], ["date", s => { s.appointments[0].preferred_date = "2026-02-30 10:00:00"; }],
  ["missing schedule", s => { s.appointments[0].preferred_date = null; }], ["duplicate ID", s => { s.appointments[1].id = s.appointments[0].id; }],
  ["duplicate link", s => { const p = migration.plan(s).required[0]; s.reservations.push(p, copy(p)); }], ["fake request", s => { s.requests.push({ request_hash: "synthetic-fabrication" }); }]
]) test("unknown/invalid " + label + " fails closed", () => { const state = migration.synthetic("reconciled"); mutate(state); assert.equal(migration.plan(state).ok, false); });
test("normalization follows JS trim/lowercase and never excludes past active rows", () => {
  const state = migration.synthetic("reconciled"); state.appointments[0].status = "\tAPPROVED\r\n"; state.appointments[1].status = null;
  assert.equal(migration.plan(state).required.length, 9); assert.equal(migration.plan(state).ok, true);
});

const cases = {
  A: { variant: "original", options: { attest: true }, code: "CONFLICTS_UNRESOLVED", reservations: 0 },
  B: { variant: "completed-pair", options: { attest: true }, code: "VERIFIED_AND_ATTESTED", reservations: 1 },
  C: { variant: "original", options: {}, code: "CONFLICTS_UNRESOLVED", reservations: 0 },
  D: { variant: "reconciled", options: {}, code: "VERIFIED_UNREADY", reservations: 9 },
  E: { variant: "reconciled", options: { attest: true }, code: "VERIFIED_AND_ATTESTED", reservations: 9 },
  F_DDL: { variant: "reconciled", options: { attest: true, failAfterDdl: 3 }, code: "INJECTED_DDL_PARTIAL", reservations: 0 },
  F_WRITE: { variant: "reconciled", options: { attest: true, failAfterInsert: 3 }, code: "INJECTED_WRITE_FAILURE", reservations: 0 },
  F_UNCERTAIN: { variant: "reconciled", options: { attest: true, loseCommitAck: "backfill" }, code: "BACKFILL_COMMIT_UNCERTAIN", reservations: 9 },
  F_ATTEST: { variant: "reconciled", options: { attest: true, loseCommitAck: "attest" }, code: "ATTEST_COMMIT_UNCERTAIN", reservations: 9 },
  G: { variant: "reconciled", options: {}, code: "VERIFIED_UNREADY", reservations: 9 },
  H: { variant: "reconciled", options: { attest: true, interfere: true }, code: "WRITER_INTERFERENCE", reservations: 9 },
  I: { variant: "reconciled", options: { attest: true }, code: "VERIFIED_AND_ATTESTED", reservations: 9 }
};
const requested = process.env.WMO_APPOINTMENT_MIGRATION_EXECUTE === migration.AUTH;
test("real execution case selection refuses omissions and unknown cases", () => {
  if (requested) assert.ok(Object.hasOwn(cases, process.env.WMO_APPOINTMENT_MIGRATION_CASE), "Choose exactly one case and a fresh empty legacy database");
});
for (const [name, spec] of Object.entries(cases)) test("REAL MYSQL migration " + name + " (fresh independent database)", {
  skip: !requested || process.env.WMO_APPOINTMENT_MIGRATION_CASE !== name, timeout: 60000
}, async () => {
  const context = await migration.openStaging(spec.variant);
  try {
    const report = await context.run(spec.options), state = await context.snapshot(); assert.equal(report.code, spec.code);
    assert.equal(state.reservations.length, spec.reservations); assert.equal(state.requests.length, 0);
    if (name === "A" || name === "C") assert.equal(report.analysis.counts.conflictGroups, 2);
    if (name === "G") { const repeated = await context.run({ attest: true }); assert.equal(repeated.code, "VERIFIED_ONLY_NO_REPLAY"); assert.equal(repeated.ready, false); assert.deepEqual(await context.snapshot(), state); }
    if (name !== "H") assert.deepEqual(migration.protectedData(state), migration.protectedData(context.baseline));
    assert.equal(state.marker, ["B", "E", "I"].includes(name) ? 1 : 0);
    // No stdout snapshots: report codes/counts only; all data is synthetic.
  } finally { await context.close(); }
});
