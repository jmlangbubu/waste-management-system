"use strict";

// No driver import, connection, credentials, environment loading or SQL on import.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const policy = require("../../services/appointmentPolicy");
const { AppointmentSchedulingService } = require("../../services/appointmentSchedulingService");
const AUTH = "I_AUTHORIZE_LOCAL_MIGRATION_DRY_RUN";
const PROFILE = "synthetic-legacy-v1-not-production-clone";
const OLD = ["appointments", "notifications", "orientation_quiz_results"];
const NEW = ["appointment_feature_state", "appointment_reservations", "appointment_booking_requests"];
const ACTIVE = new Set(["pending", "approved", "rescheduled"]), TERMINAL = new Set(["completed", "rejected", "cancelled"]);
const clone = value => structuredClone(value);
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const digest = value => crypto.createHash("sha256").update(stable(value)).digest("hex");
const failure = code => Object.assign(new Error(code), { code });
const need = (condition, code) => { if (!condition) throw failure(code); };

const DDL = Object.freeze([
  "CREATE TABLE appointment_feature_state (feature_key VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, schema_version INT NOT NULL, backfill_complete TINYINT NOT NULL DEFAULT 0) ENGINE=InnoDB",
  "INSERT INTO appointment_feature_state (feature_key, schema_version, backfill_complete) VALUES ('service_slots', 1, 0)",
  "ALTER TABLE appointments ADD COLUMN appointment_revision BIGINT UNSIGNED NOT NULL DEFAULT 0",
  "CREATE TABLE appointment_reservations (service_key VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, appointment_date DATE NOT NULL, appointment_time TIME NOT NULL, appointment_id INT NOT NULL, PRIMARY KEY (service_key, appointment_date, appointment_time), UNIQUE KEY reservation_appointment (appointment_id), FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE RESTRICT ON UPDATE RESTRICT) ENGINE=InnoDB",
  "CREATE TABLE appointment_booking_requests (request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, appointment_id INT NULL DEFAULT NULL, appointment_code VARCHAR(30) NULL DEFAULT NULL, UNIQUE KEY request_appointment (appointment_id), FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE RESTRICT ON UPDATE RESTRICT) ENGINE=InnoDB"
]);
function legacyFixtureStatements() {
  const sql = fs.readFileSync(path.join(__dirname, "../fixtures/appointmentMigrationLegacy.schema.sql"), "utf8").replace(/^\s*--.*$/gm, "");
  const statements = sql.split(";").map(s => s.trim()).filter(Boolean);
  need(statements.length === 3 && statements.every(s => /^CREATE TABLE /.test(s) && /ENGINE=InnoDB/.test(s)), "FIXTURE_INVALID");
  need(!/\b(?:DROP|TRUNCATE|USE|CREATE DATABASE)\b/i.test(sql), "FIXTURE_INVALID");
  return statements; // Never executed by this module.
}
function validateTarget(env) {
  need(env.WMO_APPOINTMENT_MIGRATION_EXECUTE === AUTH && env.WMO_APPOINTMENT_MIGRATION_PROFILE === PROFILE, "MIGRATION_EXECUTION_REFUSED");
  need(!["DATABASE_URL", "MYSQL_URL", "RESEND_API_KEY", "MYSQL_PWD", "WMO_APPOINTMENT_MYSQL_EXECUTE"].some(k => Object.hasOwn(env, k)), "INHERITED_CONFIGURATION_REFUSED");
  const database = env.WMO_APPOINTMENT_MIGRATION_DATABASE, port = Number(env.WMO_APPOINTMENT_MIGRATION_PORT);
  need(env.WMO_APPOINTMENT_MIGRATION_HOST === "127.0.0.1" && Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 3306 && port !== 33308 &&
    /^wmo_appointment_staging_[a-z0-9_]{1,32}$/.test(database || "") && database !== "wmo_appointment_staging_20261122_8ac4ef3e" &&
    env.WMO_APPOINTMENT_MIGRATION_CONFIRM_EMPTY === database && env.WMO_APPOINTMENT_MIGRATION_USER === "wmo_appt_migration" &&
    env.WMO_APPOINTMENT_MIGRATION_OBSERVER_USER === "wmo_appt_migration_observer" &&
    !!env.WMO_APPOINTMENT_MIGRATION_PASSWORD && !!env.WMO_APPOINTMENT_MIGRATION_OBSERVER_PASSWORD, "MIGRATION_TARGET_REFUSED");
  return { database, port, host: "127.0.0.1", user: env.WMO_APPOINTMENT_MIGRATION_USER, password: env.WMO_APPOINTMENT_MIGRATION_PASSWORD,
    observerUser: env.WMO_APPOINTMENT_MIGRATION_OBSERVER_USER, observerPassword: env.WMO_APPOINTMENT_MIGRATION_OBSERVER_PASSWORD };
}
function synthetic(variant = "original") {
  need(["original", "reconciled", "completed-pair"].includes(variant), "UNKNOWN_SYNTHETIC_VARIANT");
  const definitions = [
    [1001, "Accreditation", "approved", "2026-10-27 10:00:00"], [1002, "Accreditation", "rescheduled", "2026-10-27 10:00:00"],
    [1003, "SWM Orientation & Clearance", "pending", "2026-10-08 15:00:00"],
    [1004, "SWM Orientation & Clearance", "pending", "2026-11-06 09:00:00"], [1005, "SWM Orientation & Clearance", "pending", "2026-11-06 09:00:00"],
    [1006, "SWM Orientation & Clearance", "pending", "2026-12-01 09:00:00"],
    [1007, "SWM Orientation & Clearance", "completed", "2026-10-08 15:00:00"], [1008, "SWM Orientation & Clearance", "completed", "2026-10-07 11:00:00"],
    [1009, "Others", "pending", "2026-12-01 10:00:00"], [1010, "Others", "pending", "2026-12-01 11:00:00"], [1011, "Others", "pending", "2026-12-01 13:00:00"]
  ];
  const appointments = definitions.map(([id, purpose, status, preferred_date]) => ({ id, appointment_code: `SYNTH-APT-${id}`,
    full_name: `Synthetic Citizen ${id}`, barangay: "Synthetic Barangay", contact_number: "09000000000", email: `synthetic${id}@example.invalid`, purpose, status, preferred_date,
    notes: "Synthetic migration fixture only", assigned_to: [1001, 1002, 1007, 1008].includes(id) ? "Synthetic Accepting Staff" : null,
    assigned_personnel_id: null, assigned_personnel_name: null, assigned_at: [1001, 1002, 1007, 1008].includes(id) ? "2026-10-01 01:00:00" : null,
    created_at: "2026-10-01 00:00:00", updated_at: "2026-10-01 01:00:00", orientation_token: status === "completed" ? `ORI-SYNTHETIC-${id}` : null,
    orientation_qr_status: status === "completed" ? "generated" : "not_generated", orientation_completed: status === "completed" ? 1 : 0,
    orientation_status: status === "completed" ? "completed_orientation" : "approved", orientation_started_at: status === "completed" ? "2026-10-01 08:00:00" : null,
    orientation_completed_at: status === "completed" ? "2026-10-01 09:00:00" : null, orientation_score: status === "completed" ? 9 : null }));
  // A separate hypothetical fixture, not a recommendation about real records.
  if (variant === "reconciled") { appointments.find(r => r.id === 1002).preferred_date = "2026-10-27 11:00:00"; appointments.find(r => r.id === 1005).preferred_date = "2026-11-06 10:00:00"; }
  const selected = variant === "completed-pair" ? appointments.filter(r => [1003, 1007].includes(r.id)) : appointments;
  return { appointments: selected, notifications: [{ id: 5001, type: "appointment", title: "Synthetic legacy notification", message: "Synthetic historical message",
    isRead: 1, createdAt: "2026-10-01 00:00:00", status: null, reference_id: null }],
  quiz: [1007, 1008].filter(id => selected.some(r => r.id === id)).map((appointment_id, i) => ({ id: 6001 + i, appointment_id })),
  reservations: [], requests: [], marker: null };
}
function protectedData(snapshot) {
  return { appointments: snapshot.appointments.map(({ appointment_revision, ...row }) => row), notifications: snapshot.notifications, quiz: snapshot.quiz };
}
function plan(snapshot, asOf = "2026-11-22 12:00:00") {
  const errors = [], required = [], groups = new Map(), ids = new Set(), byId = new Map();
  for (const row of snapshot.appointments) {
    const id = Number(row.id), status = String(row.status || "pending").trim().toLowerCase() || "pending";
    if (!Number.isInteger(id) || id < 1 || id > 2147483647 || ids.has(id)) { errors.push({ code: "INVALID_OR_DUPLICATE_ID" }); continue; }
    ids.add(id); byId.set(id, row);
    if (!ACTIVE.has(status) && !TERMINAL.has(status)) { errors.push({ code: "UNCLASSIFIED_STATUS", syntheticId: id }); continue; }
    let slot;
    try { slot = policy.schedule(row.purpose, row.preferred_date, new Date("1970-01-01T00:00:00Z")); }
    catch (_) { errors.push({ code: "INVALID_SERVICE_OR_SCHEDULE", syntheticId: id }); continue; }
    if (ACTIVE.has(status)) required.push({ service_key: slot.key, appointment_date: slot.date, appointment_time: slot.time + ":00", appointment_id: id });
  }
  const desired = new Map(required.map(r => [r.appointment_id, r])), linked = new Set();
  for (const hold of snapshot.reservations) {
    const id = Number(hold.appointment_id), row = byId.get(id);
    if (!row || linked.has(id)) { errors.push({ code: "INVALID_RESERVATION_LINK", syntheticId: id }); continue; } linked.add(id);
    let slot; try { slot = policy.schedule(row.purpose, row.preferred_date, new Date("1970-01-01T00:00:00Z")); } catch (_) { continue; }
    if (hold.service_key !== slot.key || hold.appointment_date !== slot.date || hold.appointment_time !== slot.time + ":00" || ["rejected", "cancelled"].includes(String(row.status).trim().toLowerCase())) {
      errors.push({ code: "RESERVATION_MISMATCH", syntheticId: id }); continue;
    }
    desired.set(id, clone(hold)); // Preserve existing completed/no-show holds; never release or invent one.
  }
  for (const row of desired.values()) {
    const key = [row.service_key, row.appointment_date, row.appointment_time].join("|");
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row.appointment_id);
  }
  const conflicts = [...groups.entries()].filter(([, claimants]) => claimants.length > 1).map(([key, claimants]) => {
    const [service_key, appointment_date, appointment_time] = key.split("|");
    return { service_key, appointment_date, appointment_time, count: claimants.length, syntheticIds: claimants.sort((a, b) => a - b) };
  }).sort((a, b) => stable(a).localeCompare(stable(b)));
  if (snapshot.requests.length) errors.push({ code: "UNEXPECTED_HISTORICAL_REQUEST_HASHES" });
  return { ok: errors.length === 0 && conflicts.length === 0, errors, conflicts, required, expected: [...desired.values()].sort((a, b) => a.appointment_id - b.appointment_id),
    counts: { appointments: snapshot.appointments.length, active: required.length, conflictGroups: conflicts.length,
      involved: conflicts.reduce((n, c) => n + c.count, 0), maxClaimants: Math.max(0, ...conflicts.map(c => c.count)),
      futureConflicts: conflicts.filter(c => `${c.appointment_date} ${c.appointment_time}` > asOf).length } };
}
function verify(before, after, expected) {
  need(digest(protectedData(before)) === digest(protectedData(after)), "LEGACY_DATA_CHANGED");
  need(after.requests.length === 0, "FABRICATED_REQUEST_HASHES");
  need(digest([...after.reservations].sort((a, b) => a.appointment_id - b.appointment_id)) === digest(expected.expected), "RESERVATION_RECONCILIATION_FAILED");
  need(plan(after).ok && after.appointments.every(r => Number(r.appointment_revision) === 0), "INCONSISTENT_BACKFILL");
}

// Common workflow. SQL adapter is private; offline adapter contains only cloned synthetic data.
async function workflow(io, baseline, options = {}) {
  const journal = [], result = { ready: false, journal, evidence: io.kind };
  try {
    const initial = await io.capture(); need(digest(protectedData(initial)) === digest(protectedData(baseline)), "LEGACY_DATA_CHANGED");
    const initialPlan = plan(initial); result.analysis = initialPlan;
    need(initialPlan.errors.length === 0, "UNCLASSIFIED_LEGACY_RECORDS");
    if (await io.phase() === "legacy") {
      for (let i = 0; i < DDL.length; i++) {
        journal.push({ ddl: i + 1, outcome: "attempted" });
        await io.ddl(i, DDL[i]); journal.at(-1).outcome = "acknowledged";
        if (options.failAfterDdl === i + 1) throw failure("INJECTED_DDL_PARTIAL");
      }
    } else need(await io.phase() === "complete", "PARTIAL_MIGRATION_REFUSED");
    await io.schema();
    let current = await io.capture(), proposal = plan(current); result.analysis = proposal;
    if (!proposal.ok) return { ...result, code: "CONFLICTS_UNRESOLVED", readiness: current.marker };
    if (current.reservations.length) {
      verify(baseline, current, proposal); return { ...result, code: "VERIFIED_ONLY_NO_REPLAY", ready: Number(current.marker) === 1, readiness: current.marker };
    }
    need(Number(current.marker) === 0, "UNEXPECTED_READINESS");
    await io.transaction("backfill", async tx => {
      const locked = await tx.capture(); need(digest(protectedData(locked)) === digest(protectedData(baseline)), "WRITER_INTERFERENCE");
      need(locked.reservations.length === 0 && Number(locked.marker) === 0, "SNAPSHOT_CHANGED");
      let n = 0; for (const row of proposal.expected) { await tx.insert(row); if (++n === options.failAfterInsert) throw failure("INJECTED_WRITE_FAILURE"); }
    }, options);
    journal.push({ backfill: "commit acknowledged", readiness: 0 });
    // A physically separate observer validates committed state before any attestation.
    const observed = await io.capture(true); verify(baseline, observed, proposal); await io.schema();
    if (options.interfere) await io.interfere();
    if (options.attest) {
      await io.transaction("attest", async tx => {
        const locked = await tx.capture(); need(digest(locked) === digest(observed), "WRITER_INTERFERENCE");
        verify(baseline, locked, proposal); await tx.marker(1);
        await tx.applicationReady(); // Actual scheduling-service validator; uncommitted marker only.
      }, options);
      result.ready = true;
    }
    result.code = result.ready ? "VERIFIED_AND_ATTESTED" : "VERIFIED_UNREADY";
    result.readiness = (await io.capture(true)).marker;
    need(!result.ready || Number(result.readiness) === 1, "ATTESTATION_UNCONFIRMED"); return result;
  } catch (e) {
    const code = typeof e?.code === "string" && /^[A-Z_]+$/.test(e.code) ? e.code : "MIGRATION_OPERATION_FAILED";
    // DDL may already be committed. Never DROP/rebuild/replay or claim DDL rollback.
    if (code === "ATTEST_COMMIT_UNCERTAIN") { try { await io.invalidate(); } catch (_) { return { ...result, code, readiness: "UNKNOWN", manualReview: true }; } }
    let marker = "UNKNOWN"; try { marker = (await io.capture(true)).marker; } catch (_) { /* Preserve uncertainty. */ }
    return { ...result, ready: false, code, readiness: marker, manualReview: true };
  }
}
function createOfflineModel(variant = "original", faults = {}) {
  let state = synthetic(variant), ddlCount = 0; const baseline = clone(state), events = [];
  const io = { kind: "OFFLINE_MODEL_NOT_MYSQL", async capture() { return clone(state); }, async phase() { return ddlCount === 0 ? "legacy" : ddlCount === DDL.length ? "complete" : "partial"; },
    async ddl(index) { need(index === ddlCount, "PARTIAL_MIGRATION_REFUSED"); ddlCount++; events.push("ddl"); if (index === 1) state.marker = 0; if (index === 2) state.appointments.forEach(r => { r.appointment_revision = 0; }); },
    async schema() { need(ddlCount === DDL.length && !faults.schema && !faults.unknownDefaults && !faults.triggers, "SCHEMA_PROFILE_UNVERIFIED"); },
    async transaction(phase, work, options) {
      const next = clone(state), tx = { async capture() { return clone(next); }, async insert(row) { next.reservations.push(clone(row)); },
        async marker(value) { next.marker = value; }, async applicationReady() { need(!faults.applicationSchema, "APPLICATION_SCHEMA_REJECTED"); } };
      try { await work(tx); } catch (e) { events.push("rollback"); if (faults.rollback) throw failure("ROLLBACK_UNCERTAIN"); throw e; }
      state = next; events.push("commit"); if (options.loseCommitAck === phase) throw failure(phase === "attest" ? "ATTEST_COMMIT_UNCERTAIN" : "BACKFILL_COMMIT_UNCERTAIN");
    }, async interfere() { state.appointments[0].notes = "Synthetic concurrent writer interference"; },
    async invalidate() { if (faults.invalidate) throw failure("INVALIDATION_UNCERTAIN"); state.marker = 0; } };
  return { run: options => workflow(io, baseline, options), snapshot: () => clone(state), events,
    seedExistingHold(id) { const row = state.appointments.find(r => r.id === id), slot = policy.schedule(row.purpose, row.preferred_date, new Date("1970-01-01T00:00:00Z"));
      state.reservations.push({ service_key: slot.key, appointment_date: slot.date, appointment_time: slot.time + ":00", appointment_id: id }); },
    mutateSynthetic(change) { change(state); } };
}

function fixtureColumns() {
  return Object.fromEntries(legacyFixtureStatements().map(sql => {
    const table = sql.match(/^CREATE TABLE (\w+)/)[1], columns = [];
    for (const line of sql.split("\n")) {
      const m = line.trim().match(/^(\w+) (INT|VARCHAR\(\d+\)|TEXT|DATETIME|TIMESTAMP|TINYINT)(?=\s|,)(.*)/i);
      if (!m) continue;
      const value = m[3].match(/\bDEFAULT (NULL|'[^']*'|CURRENT_TIMESTAMP|-?\d+)/i)?.[1];
      columns.push({ name: m[1], type: m[2].toLowerCase(), nullable: !/NOT NULL/i.test(m[3]),
        default: value == null || value.toUpperCase() === "NULL" ? null : value.replace(/^'|'$/g, ""), auto: /AUTO_INCREMENT/i.test(m[3]), update: /ON UPDATE/i.test(m[3]) });
    }
    return [table, columns];
  }));
}
function checkLegacyMetadata(meta) {
  const normalize = type => String(type).toLowerCase().replace(/^(int|tinyint)\(\d+\)/, "$1").replace(/^(datetime|timestamp)\(0\)$/, "$1");
  const defaultValue = value => value == null ? null : String(value).toLowerCase().replace(/current_timestamp\(0?\)/, "current_timestamp");
  for (const [table, expected] of Object.entries(fixtureColumns())) {
    const actual = meta.columns.filter(c => c.TABLE_NAME === table && c.COLUMN_NAME !== "appointment_revision");
    need(actual.length === expected.length, "LEGACY_SCHEMA_PROFILE_MISMATCH");
    for (const spec of expected) {
      const row = actual.find(c => c.COLUMN_NAME === spec.name);
      need(row && normalize(row.COLUMN_TYPE) === spec.type && (row.IS_NULLABLE === "YES") === spec.nullable && row.GENERATION_EXPRESSION === "" &&
        defaultValue(row.COLUMN_DEFAULT) === defaultValue(spec.default) && /auto_increment/i.test(row.EXTRA) === spec.auto && /on update/i.test(row.EXTRA) === spec.update,
      "LEGACY_SCHEMA_PROFILE_MISMATCH");
      const extra = row.EXTRA.toLowerCase().replace(/auto_increment|default_generated|on update current_timestamp(?:\(0?\))?/g, "").trim();
      need(extra === "" && (!/default_generated/i.test(row.EXTRA) || defaultValue(spec.default) === "current_timestamp"), "LEGACY_SCHEMA_PROFILE_MISMATCH");
    }
  }
  need(meta.tables.every(t => t.ENGINE === "InnoDB") && meta.triggers.length === 0, "SCHEMA_PROFILE_UNVERIFIED");
  const quiz = meta.foreignKeys.filter(f => OLD.includes(f.TABLE_NAME));
  need(quiz.length === 1 && quiz[0].TABLE_NAME === "orientation_quiz_results" && quiz[0].COLUMN_NAME === "appointment_id" && quiz[0].REFERENCED_TABLE_NAME === "appointments" && quiz[0].REFERENCED_COLUMN_NAME === "id" &&
    quiz[0].DELETE_RULE === "RESTRICT" && quiz[0].UPDATE_RULE === "RESTRICT", "QUIZ_RELATIONSHIP_UNVERIFIED");
}
function checkIndexes(meta, complete) {
  const wanted = { appointments: [["id"], ["appointment_code"]], notifications: [["id"]], orientation_quiz_results: [["id"]],
    ...complete ? { appointment_feature_state: [["feature_key"]], appointment_reservations: [["service_key", "appointment_date", "appointment_time"], ["appointment_id"]],
      appointment_booking_requests: [["request_hash"], ["appointment_id"]] } : {} };
  const groups = new Map();
  for (const row of meta.indexes) { const key = row.TABLE_NAME + "/" + row.INDEX_NAME; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
  for (const [table, keys] of Object.entries(wanted)) {
    const unique = [...groups.values()].filter(rows => rows[0].TABLE_NAME === table && Number(rows[0].NON_UNIQUE) === 0);
    need(unique.length === keys.length, "UNEXPECTED_UNIQUE_INDEX");
    for (const key of keys) need(unique.some(rows => {
      rows.sort((a, b) => a.SEQ_IN_INDEX - b.SEQ_IN_INDEX);
      const primary = key.length === 1 && ["id", "request_hash", "feature_key"].includes(key[0]);
      return (!primary || rows[0].INDEX_NAME === "PRIMARY") && stable(rows.map(r => r.COLUMN_NAME)) === stable(key) && rows.every((r, i) => Number(r.SEQ_IN_INDEX) === i + 1 && r.SUB_PART === null && r.EXPRESSION === null && r.INDEX_TYPE === "BTREE" && r.IS_VISIBLE === "YES");
    }), "REQUIRED_UNIQUE_INDEX_MISSING");
  }
}
function checkNewColumns(meta) {
  const definitions = {
    appointment_feature_state: [["feature_key", "varchar(32)", false, null, true], ["schema_version", "int", false, null], ["backfill_complete", "tinyint", false, "0"]],
    appointment_reservations: [["service_key", "varchar(32)", false, null, true], ["appointment_date", "date", false, null], ["appointment_time", "time", false, null], ["appointment_id", "int", false, null]],
    appointment_booking_requests: [["request_hash", "char(64)", false, null, true], ["payload_hash", "char(64)", false, null, true], ["appointment_id", "int", true, null], ["appointment_code", "varchar(30)", true, null]]
  };
  const revision = meta.columns.find(c => c.TABLE_NAME === "appointments" && c.COLUMN_NAME === "appointment_revision");
  need(revision && revision.COLUMN_TYPE.toLowerCase() === "bigint unsigned" && revision.IS_NULLABLE === "NO" && String(revision.COLUMN_DEFAULT) === "0" && revision.EXTRA === "" && revision.GENERATION_EXPRESSION === "", "REVISION_COLUMN_INVALID");
  for (const [table, specs] of Object.entries(definitions)) {
    const columns = meta.columns.filter(c => c.TABLE_NAME === table); need(columns.length === specs.length, "NEW_COLUMNS_INVALID");
    for (const [name, type, nullable, value, ascii] of specs) {
      const c = columns.find(r => r.COLUMN_NAME === name), normalized = c?.COLUMN_TYPE.toLowerCase().replace(/^(int|tinyint)\(\d+\)/, "$1").replace(/^time\(0\)$/, "time");
      need(c && normalized === type && (c.IS_NULLABLE === "YES") === nullable && (c.COLUMN_DEFAULT === null ? null : String(c.COLUMN_DEFAULT)) === value && c.EXTRA === "" && c.GENERATION_EXPRESSION === "" &&
        (!ascii || c.CHARACTER_SET_NAME === "ascii" && c.COLLATION_NAME === "ascii_bin") && (type !== "time" || Number(c.DATETIME_PRECISION) === 0), "NEW_COLUMNS_INVALID");
    }
  }
}
async function openStaging(variant = "original") {
  const target = validateTarget(process.env); // Refuses before even loading a driver.
  const seed = synthetic(variant), mysql = require("mysql2/promise");
  const config = { host: target.host, port: target.port, database: target.database, connectionLimit: 3, connectTimeout: 3000,
    multipleStatements: false, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true };
  const pool = mysql.createPool({ ...config, user: target.user, password: target.password });
  const observer = mysql.createPool({ ...config, connectionLimit: 1, user: target.observerUser, password: target.observerPassword });
  const active = new Set(); let closed = false, baselineMeta;
  const q = async (connection, sql, values = []) => (await connection.query({ sql, timeout: 5000 }, values))[0];
  async function metadata() {
    return {
      tables: await q(pool, "SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME", [target.database]),
      columns: await q(pool, "SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,GENERATION_EXPRESSION,CHARACTER_SET_NAME,COLLATION_NAME,DATETIME_PRECISION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,ORDINAL_POSITION", [target.database]),
      indexes: await q(pool, "SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,EXPRESSION,INDEX_TYPE,IS_VISIBLE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX", [target.database]),
      foreignKeys: await q(pool, `SELECT k.TABLE_NAME,k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_SCHEMA,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.DELETE_RULE,r.UPDATE_RULE
        FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME
        WHERE k.TABLE_SCHEMA=? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION`, [target.database]),
      triggers: await q(pool, "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? ORDER BY TRIGGER_NAME", [target.database])
    };
  }
  function oldMetadata(meta) {
    return Object.fromEntries(Object.entries(meta).map(([name, rows]) => [name, name === "triggers" ? rows : rows.filter(r => OLD.includes(r.TABLE_NAME) && r.COLUMN_NAME !== "appointment_revision")]));
  }
  async function phase() {
    const meta = await metadata(), names = meta.tables.map(t => t.TABLE_NAME).sort();
    const revision = meta.columns.some(c => c.TABLE_NAME === "appointments" && c.COLUMN_NAME === "appointment_revision");
    if (stable(names) === stable([...OLD].sort()) && !revision) return "legacy";
    return stable(names) === stable([...OLD, ...NEW].sort()) && revision ? "complete" : "partial";
  }
  async function read(connection, lock = false) {
    const meta = await metadata(), names = new Set(meta.tables.map(t => t.TABLE_NAME)), data = {};
    for (const [field, table, order] of [["appointments", "appointments", "id"], ["notifications", "notifications", "id"], ["quiz", "orientation_quiz_results", "id"],
      ["reservations", "appointment_reservations", "appointment_id"], ["requests", "appointment_booking_requests", "request_hash"]]) {
      data[field] = names.has(table) ? await q(connection, `SELECT * FROM ${table} ORDER BY ${order}${lock ? " FOR UPDATE" : ""}`) : [];
    }
    const rows = names.has("appointment_feature_state") ? await q(connection, `SELECT feature_key,schema_version,backfill_complete FROM appointment_feature_state${lock ? " FOR UPDATE" : ""}`) : [];
    need(rows.length <= 1 && (!rows.length || rows[0].feature_key === "service_slots" && Number(rows[0].schema_version) === 1), "UNEXPECTED_READINESS");
    data.marker = rows.length ? Number(rows[0].backfill_complete) : null; return data;
  }
  async function transaction(kind, work, options = {}) {
    const c = await pool.getConnection(); active.add(c); let begun = false, committing = false, reusable = false;
    try {
      await c.beginTransaction(); begun = true;
      const result = await work({ capture: () => read(c, true), insert: r => q(c, "INSERT INTO appointment_reservations (service_key,appointment_date,appointment_time,appointment_id) VALUES (?,?,?,?)", [r.service_key, r.appointment_date, r.appointment_time, r.appointment_id]),
        async marker(value) { const changed = await q(c, "UPDATE appointment_feature_state SET backfill_complete=? WHERE feature_key='service_slots' AND schema_version=1 AND backfill_complete=0", [value]); need(changed.affectedRows === 1, "READINESS_CHANGED"); },
        // The production validator uses callbacks; forward to the SAME leased promise connection.
        applicationReady: () => new AppointmentSchedulingService(pool, { enabled: () => true }).ready({
          query(sql, values, done) { c.query(sql, values).then(([rows]) => done(null, rows), done); }
        }) }, c);
      committing = true; await c.commit();
      if (options.loseCommitAck === kind) throw failure(kind === "attest" ? "ATTEST_COMMIT_UNCERTAIN" : "BACKFILL_COMMIT_UNCERTAIN");
      reusable = true; return result;
    } catch (e) {
      if (committing) throw failure(kind === "attest" ? "ATTEST_COMMIT_UNCERTAIN" : "BACKFILL_COMMIT_UNCERTAIN");
      if (begun) { try { await c.rollback(); reusable = true; } catch (_) { throw failure("ROLLBACK_UNCERTAIN"); } }
      throw e;
    } finally { active.delete(c); if (reusable) c.release(); else c.destroy(); }
  }
  async function capture() {
    const c = await observer.getConnection(); active.add(c); let reusable = false;
    try { await c.beginTransaction(); const result = await read(c); await c.commit(); reusable = true; return result; }
    finally { active.delete(c); if (reusable) c.release(); else c.destroy(); }
  }
  async function close() { if (closed) return; closed = true; for (const c of active) c.destroy(); active.clear(); await Promise.all([pool.end(), observer.end()]); }
  try {
    for (const db of [pool, observer]) {
      const [identity] = await q(db, "SELECT DATABASE() AS db,VERSION() AS version,@@transaction_isolation AS iso,@@session.time_zone AS tz,@@system_time_zone AS system_tz");
      need(identity.db === target.database && /^9\.7\.2(?:[-.]|$)/.test(identity.version) && identity.iso === "REPEATABLE-READ" &&
        (identity.tz === "+00:00" || identity.tz === "SYSTEM" && identity.system_tz === "UTC"), "STAGING_IDENTITY_REFUSED");
    }
    const [visibility] = await q(pool, `SELECT COUNT(*) AS n FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA=? AND PRIVILEGE_TYPE='TRIGGER'
      AND GRANTEE=CONCAT(QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',1)),'@',QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',-1)))`, [target.database]);
    need(Number(visibility.n) >= 1, "TRIGGER_METADATA_VISIBILITY_REQUIRED");
    need(await phase() === "legacy", "FRESH_LEGACY_DATABASE_REQUIRED");
    baselineMeta = await metadata(); checkLegacyMetadata(baselineMeta); checkIndexes(baselineMeta, false);
    need(baselineMeta.foreignKeys.every(f => f.REFERENCED_TABLE_SCHEMA === target.database), "CROSS_SCHEMA_RELATIONSHIP_REFUSED");
    for (const table of OLD) { const [row] = await q(pool, `SELECT COUNT(*) AS n FROM ${table}`); need(Number(row.n) === 0, "NONEMPTY_DATABASE_REFUSED"); }
    // Only generated-in-code synthetic rows are ever loaded. No external data import API.
    await transaction("seed", async (_, c) => {
      // Use the leased transaction for all seed INSERTs; no schema-changing statements here.
      for (const [field, table] of [["appointments", "appointments"], ["notifications", "notifications"], ["quiz", "orientation_quiz_results"]])
        for (const row of seed[field]) { const keys = Object.keys(row); await q(c, `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, keys.map(k => row[k])); }
    });
    const baseline = await capture();
    need(digest(protectedData(baseline)) === digest(protectedData(seed)), "SYNTHETIC_SEED_VERIFICATION_FAILED");
    const io = { kind: "REAL_MYSQL_SYNTHETIC_STAGING", capture, phase,
      ddl: (_, sql) => q(pool, sql), transaction,
      async schema() {
        const meta = await metadata(); need(await phase() === "complete", "PARTIAL_MIGRATION_REFUSED");
        checkLegacyMetadata(meta); checkIndexes(meta, true); checkNewColumns(meta); need(digest(oldMetadata(meta)) === digest(oldMetadata(baselineMeta)), "LEGACY_METADATA_CHANGED");
        const links = meta.foreignKeys.filter(f => NEW.includes(f.TABLE_NAME));
        need(links.length === 2 && ["appointment_reservations", "appointment_booking_requests"].every(table => links.filter(f => f.TABLE_NAME === table).length === 1) && links.every(f => f.COLUMN_NAME === "appointment_id" && f.REFERENCED_TABLE_SCHEMA === target.database && f.REFERENCED_TABLE_NAME === "appointments" && f.REFERENCED_COLUMN_NAME === "id" &&
          ["RESTRICT", "NO ACTION"].includes(f.DELETE_RULE) && ["RESTRICT", "NO ACTION"].includes(f.UPDATE_RULE)), "NEW_FOREIGN_KEYS_INVALID");
      },
      async interfere() { await q(pool, "UPDATE appointments SET notes='Synthetic concurrent writer interference' WHERE id=?", [seed.appointments[0].id]); },
      async invalidate() { await q(pool, "UPDATE appointment_feature_state SET backfill_complete=0 WHERE feature_key='service_slots'"); const state = await capture(); need(state.marker === 0, "INVALIDATION_UNCERTAIN"); } };
    return { run: options => workflow(io, baseline, options), snapshot: capture, close, baseline: clone(baseline) };
  } catch (e) { await close(); throw failure(typeof e?.code === "string" && /^[A-Z_]+$/.test(e.code) ? e.code : "STAGING_PREPARATION_FAILED"); }
}

module.exports = { AUTH, PROFILE, DDL, validateTarget, legacyFixtureStatements, fixtureColumns, checkLegacyMetadata, checkIndexes, checkNewColumns,
  synthetic, protectedData, plan, verify, createOfflineModel, openStaging };
