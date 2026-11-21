"use strict";

const crypto = require("node:crypto");
const { BASELINE, SafetyError } = require("./environment.cjs");
const SERVICES = Object.freeze({ "SWM Orientation & Clearance": "orientation", Accreditation: "accreditation",
  "IEC Resource Speaker": "iec_resource_speaker", Others: "others" });
const TIMES = Object.freeze(["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"]);
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
// Independently authored synthetic definitions. No production validator or pool is imported.
const col = (type, nullable = false, options = {}) => ({ type, nullable, default: null, ...options });
const text = (length, nullable = false, options) => col(`varchar(${length})`, nullable, options);
const ascii = (type, nullable = false) => col(type, nullable, { charset: "ascii", collation: "ascii_bin" });
const primary = (...columns) => ({ name: "PRIMARY", unique: true, columns });
const unique = (name, ...columns) => ({ name, unique: true, columns });
const link = name => ({ name, column: "appointment_id", targetTable: "appointments", targetColumn: "id", onUpdate: "RESTRICT", onDelete: "RESTRICT" });
const TABLES = freeze({
  appointments: { engine: "InnoDB", columns: {
    id: col("int", false, { autoIncrement: true }), appointment_code: text(30, true),
    full_name: text(150), barangay: text(150), contact_number: text(50), email: text(255, true),
    purpose: text(100), preferred_date: col("datetime", true), notes: col("text", true),
    status: text(50, false, { default: "pending" }), assigned_to: text(255, true), assigned_personnel_id: col("int", true),
    assigned_personnel_name: text(150, true), assigned_at: col("timestamp", true),
    created_at: col("timestamp", false, { default: "CURRENT_TIMESTAMP" }),
    updated_at: col("timestamp", true, { onUpdate: true }), orientation_token: text(100, true),
    orientation_qr_status: text(30, true, { default: "not_generated" }), orientation_completed: col("tinyint", false, { default: 0 }),
    orientation_status: text(50, true, { default: "approved" }), orientation_started_at: col("datetime", true),
    orientation_completed_at: col("datetime", true), orientation_score: col("int", true),
    appointment_revision: col("bigint unsigned", false, { default: 0 })
  }, indexes: [primary("id"), unique("appointment_code", "appointment_code")], foreignKeys: [] },
  notifications: { engine: "InnoDB", columns: {
    id: col("int", false, { autoIncrement: true }), type: text(50, true), title: text(255, true), message: col("text", true),
    isRead: col("tinyint", true, { default: 0 }), createdAt: col("timestamp", false, { default: "CURRENT_TIMESTAMP" }),
    status: text(80, true), reference_id: text(120, true)
  }, indexes: [primary("id")], foreignKeys: [] },
  appointment_reservations: { engine: "InnoDB", columns: {
    service_key: ascii("varchar(32)"), appointment_date: col("date"), appointment_time: col("time"), appointment_id: col("int")
  }, indexes: [primary("service_key", "appointment_date", "appointment_time"), unique("reservation_appointment", "appointment_id")],
  foreignKeys: [link("fixture_reservation_appointment_fk")] },
  appointment_booking_requests: { engine: "InnoDB", columns: {
    request_hash: ascii("char(64)"), payload_hash: ascii("char(64)"), appointment_id: col("int", true), appointment_code: text(30, true)
  }, indexes: [primary("request_hash"), unique("request_appointment", "appointment_id")], foreignKeys: [link("fixture_request_appointment_fk")] },
  appointment_feature_state: { engine: "InnoDB", columns: {
    feature_key: ascii("varchar(32)"), schema_version: col("int"), backfill_complete: col("tinyint", false, { default: 0 })
  }, indexes: [primary("feature_key")], foreignKeys: [] }
});
const MARKER = freeze({ feature_key: "service_slots", schema_version: 1, backfill_complete: 0 });
const CITIZEN = freeze({ full_name: "Synthetic Citizen 0001", barangay: "Synthetic Barangay", contact_number: "09000000001",
  email: "citizen0001@example.invalid", purpose: "Accreditation", preferred_date: "2026-11-23 10:00:00", notes: "Synthetic fixture only" });
const IDENTIFIERS = freeze({ orientationToken: "ORI-synthetic-fixture-only-0001", requestKey: "synthetic-appointment-request-0001",
  staff: { id: 7, role: "clerk_admin", full_name: "Synthetic Staff 0001" } });
function schemaName(name) {
  if (typeof name !== "string" || !/^wmo_synthetic_[0-9a-f]{32}$/.test(name)) throw new SafetyError("SCHEMA_INVALID");
  return name;
}
function statements(name) {
  schemaName(name);
  const qualify = table => `\`${name}\`.\`${table}\``;
  const result = Object.entries(TABLES).map(([table, spec]) => {
    const parts = Object.entries(spec.columns).map(([column, c]) => {
      let sql = `\`${column}\` ${c.type.toUpperCase()}`;
      if (c.charset) sql += ` CHARACTER SET ${c.charset} COLLATE ${c.collation}`;
      sql += c.nullable ? " NULL" : " NOT NULL";
      if (c.autoIncrement) sql += " AUTO_INCREMENT";
      else if (c.default === "CURRENT_TIMESTAMP") sql += " DEFAULT CURRENT_TIMESTAMP";
      else if (c.default !== null) sql += typeof c.default === "number" ? ` DEFAULT ${c.default}` : ` DEFAULT '${c.default}'`;
      else if (c.nullable && c.type !== "text") sql += " DEFAULT NULL";
      if (c.onUpdate) sql += " ON UPDATE CURRENT_TIMESTAMP";
      return sql;
    });
    for (const index of spec.indexes) parts.push(`${index.name === "PRIMARY" ? "PRIMARY KEY" : `UNIQUE KEY \`${index.name}\``} (${index.columns.map(c => `\`${c}\``).join(", ")})`);
    for (const fk of spec.foreignKeys) parts.push(`CONSTRAINT \`${fk.name}\` FOREIGN KEY (\`${fk.column}\`) REFERENCES ${qualify(fk.targetTable)} (\`${fk.targetColumn}\`) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`);
    return `CREATE TABLE ${qualify(table)} (\n  ${parts.join(",\n  ")}\n) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;`;
  });
  result.push(`INSERT INTO ${qualify("appointment_feature_state")} (feature_key, schema_version, backfill_complete) VALUES ('service_slots', 1, 0);`);
  return result;
}
function fixtureFingerprint() {
  const canonical = { sourceCommit: BASELINE, tables: TABLES, services: SERVICES, times: TIMES, marker: MARKER, citizen: CITIZEN, identifiers: IDENTIFIERS,
    statements: statements(`wmo_synthetic_${"0".repeat(32)}`) };
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}
function fixtureSpecification() {
  return freeze({ classification: "synthetic-offline-specification", executable: false, sourceCommit: BASELINE,
    tables: TABLES, marker: MARKER, services: SERVICES, times: TIMES, citizen: CITIZEN, identifiers: IDENTIFIERS, fingerprint: fixtureFingerprint() });
}
function fixtureDdl(name) {
  return freeze({ classification: "inert-synthetic-fixture-data", executable: false, requiresSeparateAuthorization: true,
    schema: schemaName(name), statements: statements(name), marker: MARKER, fingerprint: fixtureFingerprint() });
}
function fixtureMetadata(name) {
  schemaName(name);
  const metadata = { schema: name, tables: [], columns: [], indexes: [], foreignKeys: [], marker: [{ ...MARKER }] };
  for (const [table, spec] of Object.entries(TABLES)) {
    metadata.tables.push({ TABLE_SCHEMA: name, TABLE_NAME: table, TABLE_TYPE: "BASE TABLE", ENGINE: spec.engine });
    for (const [column, c] of Object.entries(spec.columns)) {
      const type = c.type.split(/[ (]/)[0], size = c.type.match(/\((\d+)\)/), string = ["varchar", "char", "text"].includes(type);
      const numeric = ["int", "tinyint", "bigint"].includes(type), temporal = ["time", "datetime", "timestamp"].includes(type);
      metadata.columns.push({ TABLE_SCHEMA: name, TABLE_NAME: table, COLUMN_NAME: column, DATA_TYPE: type, COLUMN_TYPE: c.type,
        IS_NULLABLE: c.nullable ? "YES" : "NO", COLUMN_DEFAULT: c.default === null ? null : String(c.default),
        EXTRA: c.autoIncrement ? "auto_increment" : c.onUpdate ? "on update CURRENT_TIMESTAMP" : c.default === "CURRENT_TIMESTAMP" ? "DEFAULT_GENERATED" : "",
        CHARACTER_MAXIMUM_LENGTH: string ? type === "text" ? 65535 : Number(size[1]) : null,
        NUMERIC_PRECISION: numeric ? type === "int" ? 10 : type === "tinyint" ? 3 : c.type.includes("unsigned") ? 20 : 19 : null,
        NUMERIC_SCALE: numeric ? 0 : null, DATETIME_PRECISION: temporal ? 0 : null,
        CHARACTER_SET_NAME: string ? c.charset || "utf8mb4" : null,
        COLLATION_NAME: string ? c.collation || "utf8mb4_general_ci" : null, GENERATION_EXPRESSION: "" });
    }
    for (const index of spec.indexes) index.columns.forEach((column, i) => metadata.indexes.push({ TABLE_SCHEMA: name, TABLE_NAME: table,
      INDEX_NAME: index.name, NON_UNIQUE: 0, SEQ_IN_INDEX: i + 1, COLUMN_NAME: column, SUB_PART: null, EXPRESSION: null, INDEX_TYPE: "BTREE", IS_VISIBLE: "YES" }));
    for (const fk of spec.foreignKeys) metadata.foreignKeys.push({ CONSTRAINT_SCHEMA: name, CONSTRAINT_NAME: fk.name, TABLE_SCHEMA: name, TABLE_NAME: table,
      COLUMN_NAME: fk.column, ORDINAL_POSITION: 1, POSITION_IN_UNIQUE_CONSTRAINT: 1, REFERENCED_TABLE_SCHEMA: name,
      REFERENCED_TABLE_NAME: fk.targetTable, REFERENCED_COLUMN_NAME: fk.targetColumn, UPDATE_RULE: fk.onUpdate, DELETE_RULE: fk.onDelete });
  }
  return metadata;
}
module.exports = { SERVICES, TIMES, fixtureSpecification, fixtureDdl, fixtureMetadata, fixtureFingerprint };
// Versioned Phase 4B profile. The Phase 4A TABLES, DDL and fingerprint above remain unchanged.
const p4b = require("./environment.cjs");
const IDENTITY_COLUMNS = freeze({
  run_id: ascii("char(36)"), schema_name: ascii("varchar(64)"), application_commit: ascii("char(40)"),
  harness_commit: ascii("char(40)"), fixture_profile: ascii("varchar(32)"), fixture_fingerprint: ascii("char(71)"),
  synthetic_only: col("tinyint", false, { default: 1 }), reconciled: col("tinyint", false, { default: 0 })
});
const CANONICAL_SQL_SCHEMA = "wmo_synthetic_" + "0".repeat(32);
const BINDING_POLICY = freeze({
  canonicalSqlSchema: CANONICAL_SQL_SCHEMA,
  identityParameterSlots: ["runId", "schema", "harnessCommit", "fixtureFingerprint"],
  staticApplicationCommit: BASELINE,
  normalization: "explicit-template-bindings-only-no-value-based-replacement"
});
const quoted = name => String.fromCharCode(96) + name + String.fromCharCode(96);
const slot = name => freeze({ dynamicBinding: name });
function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
function provisioningSnapshot() {
  const requestHash = crypto.createHash("sha256").update(IDENTIFIERS.requestKey).digest("hex");
  return freeze({
    appointments: [{ id: 17, purpose: "Accreditation", appointment_code: "APT-000017", preferred_date: CITIZEN.preferred_date,
      status: "pending", appointment_revision: 0, assigned_to: null, assigned_at: null }],
    reservations: [{ appointment_id: 17, service_key: "accreditation", appointment_date: "2026-11-23", appointment_time: "10:00:00" }],
    requests: [{ request_hash: requestHash, payload_hash: crypto.createHash("sha256").update("synthetic-payload-v1").digest("hex"),
      appointment_id: 17, appointment_code: "APT-000017" }],
    notifications: [{ id: 17, type: "appointment" }]
  });
}
function boundIdentity(bindings, reconciled = 0) {
  return freeze({ run_id: bindings.runId, schema_name: bindings.identitySchema, application_commit: bindings.applicationCommit,
    harness_commit: bindings.harnessCommit, fixture_profile: p4b.PHASE4B_PROFILE, fixture_fingerprint: bindings.fingerprint,
    synthetic_only: 1, reconciled });
}
function buildMetadata(name) {
  const m = fixtureMetadata(name);
  m.tables.push({ TABLE_SCHEMA: name, TABLE_NAME: "appointment_harness_identity", TABLE_TYPE: "BASE TABLE", ENGINE: "InnoDB" });
  for (const [column, spec] of Object.entries(IDENTITY_COLUMNS)) {
    const string = spec.type.startsWith("char") || spec.type.startsWith("varchar"), match = spec.type.match(/\((\d+)\)/);
    m.columns.push({ TABLE_SCHEMA: name, TABLE_NAME: "appointment_harness_identity", COLUMN_NAME: column,
      DATA_TYPE: spec.type.split("(")[0], COLUMN_TYPE: spec.type, IS_NULLABLE: "NO",
      COLUMN_DEFAULT: spec.default === null ? null : String(spec.default), EXTRA: "", CHARACTER_MAXIMUM_LENGTH: string ? Number(match[1]) : null,
      NUMERIC_PRECISION: string ? null : 3, NUMERIC_SCALE: string ? null : 0, DATETIME_PRECISION: null,
      CHARACTER_SET_NAME: string ? "ascii" : null, COLLATION_NAME: string ? "ascii_bin" : null, GENERATION_EXPRESSION: "" });
  }
  for (const [index, column] of [["PRIMARY", "run_id"], ["harness_schema", "schema_name"]]) m.indexes.push({
    TABLE_SCHEMA: name, TABLE_NAME: "appointment_harness_identity", INDEX_NAME: index, NON_UNIQUE: 0, SEQ_IN_INDEX: 1,
    COLUMN_NAME: column, SUB_PART: null, EXPRESSION: null, INDEX_TYPE: "BTREE", IS_VISIBLE: "YES" });
  return freeze(m);
}
function buildAttestation(bindings) {
  const prefix = quoted(bindings.sqlSchema) + ".";
  // Inert protocol only. A native implementation still requires locked reconciliation,
  // one affected row per update and acknowledged COMMIT. Never included in setup.
  return freeze({ executable: false, requiresSeparateAuthorization: true, requiresFreshReconciliation: true,
    updates: [
      { sql: "UPDATE " + prefix + quoted("appointment_harness_identity") + " SET reconciled = 1 WHERE run_id = ? AND fixture_fingerprint = ? AND reconciled = 0;",
        parameters: [bindings.runId, bindings.fingerprint] },
      { sql: "UPDATE " + prefix + quoted("appointment_feature_state") + " SET backfill_complete = 1 WHERE feature_key = ? AND schema_version = 1 AND backfill_complete = 0;",
        parameters: ["service_slots"] }
    ] });
}
function buildProvisioningContract(bindings) {
  const prefix = quoted(bindings.sqlSchema) + ".", snapshot = provisioningSnapshot(), row = boundIdentity(bindings);
  const columnSql = Object.entries(IDENTITY_COLUMNS).map(([name, spec]) => quoted(name) + " " + spec.type.toUpperCase() +
    (spec.charset ? " CHARACTER SET ascii COLLATE ascii_bin" : "") + " NOT NULL" + (spec.default !== null ? " DEFAULT " + spec.default : ""));
  columnSql.push("PRIMARY KEY (" + quoted("run_id") + ")", "UNIQUE KEY " + quoted("harness_schema") + " (" + quoted("schema_name") + ")");
  const ddl = statements(bindings.sqlSchema).map(sql => ({ sql, parameters: [] }));
  ddl.push({ sql: "CREATE TABLE " + prefix + quoted("appointment_harness_identity") + " (" + columnSql.join(", ") + ") ENGINE=InnoDB;", parameters: [] });
  const markerColumns = Object.keys(row);
  const seed = [
    { sql: "INSERT INTO " + prefix + quoted("appointment_harness_identity") + " (" + markerColumns.map(quoted).join(", ") + ") VALUES (" + markerColumns.map(() => "?").join(", ") + ");", parameters: Object.values(row) },
    { sql: "INSERT INTO " + prefix + quoted("appointments") + " (id, appointment_code, full_name, barangay, contact_number, email, purpose, preferred_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);",
      parameters: [17, "APT-000017", CITIZEN.full_name, CITIZEN.barangay, CITIZEN.contact_number, CITIZEN.email, CITIZEN.purpose, CITIZEN.preferred_date, CITIZEN.notes] },
    { sql: "INSERT INTO " + prefix + quoted("appointment_reservations") + " (service_key, appointment_date, appointment_time, appointment_id) VALUES (?, ?, ?, ?);",
      parameters: ["accreditation", "2026-11-23", "10:00:00", 17] },
    { sql: "INSERT INTO " + prefix + quoted("appointment_booking_requests") + " (request_hash, payload_hash, appointment_id, appointment_code) VALUES (?, ?, ?, ?);",
      parameters: Object.values(snapshot.requests[0]) },
    { sql: "INSERT INTO " + prefix + quoted("notifications") + " (id, type, title, message) VALUES (?, ?, ?, ?);",
      parameters: [17, "appointment", "Synthetic appointment", "Synthetic fixture only"] }
  ];
  return freeze({ profile: p4b.PHASE4B_PROFILE, phase4AFingerprint: fixtureFingerprint(), bindingPolicy: BINDING_POLICY,
    identityDefinition: { engine: "InnoDB", columns: IDENTITY_COLUMNS, primary: ["run_id"], unique: ["schema_name"] },
    applicationTables: Object.keys(TABLES), controlTable: "appointment_harness_identity", ddl, seed, marker: MARKER,
    identity: row, expectedSnapshot: snapshot, expectedMetadata: buildMetadata(bindings.sqlSchema),
    syntheticActor: IDENTIFIERS.staff, clock: "2026-11-21T00:00:00Z", attestation: buildAttestation(bindings) });
}
function canonicalProvisioningContract() {
  // Only these known identity bindings are placeholders. Static values are never normalized
  // by comparing them with an actual run ID/schema/commit: coincidentally equal seed values remain hashed.
  return buildProvisioningContract({ sqlSchema: CANONICAL_SQL_SCHEMA, identitySchema: slot("schema"), runId: slot("runId"),
    applicationCommit: BASELINE, harnessCommit: slot("harnessCommit"), fingerprint: slot("fixtureFingerprint") });
}
function provisioningFingerprint() {
  return "sha256:" + crypto.createHash("sha256").update(canonicalJson(canonicalProvisioningContract())).digest("hex");
}
function profileConfiguration(input) {
  const c = p4b.validatePhase4BConfiguration(input);
  p4b.p4bCheck(c.fixture.fingerprint === provisioningFingerprint(), "P4B_FIXTURE_INVALID");
  return c;
}
function actualBindings(c) {
  return { sqlSchema: c.schema, identitySchema: c.schema, runId: c.runId, applicationCommit: c.source.applicationCommit,
    harnessCommit: c.source.harnessCommit, fingerprint: c.fixture.fingerprint };
}
function instantiatedProfile(c) {
  return freeze({ ...buildProvisioningContract(actualBindings(c)), fingerprint: c.fixture.fingerprint, executable: false,
    requiresSeparateAuthorization: true, productionSchemaVerified: false, realMysqlVerified: false });
}
function provisioningProfile(input) { return instantiatedProfile(profileConfiguration(input)); }
function validateInstantiatedProvisioningProfile(input, supplied) {
  try {
    const c = profileConfiguration(input), actual = p4b.p4bData(supplied);
    p4b.p4bCheck(p4b.same(actual, instantiatedProfile(c)), "P4B_FIXTURE_INVALID");
    return freeze({ matchesCanonicalTemplate: true, dynamicBindingsMatch: true, writeAccess: false, independentlyObservedHere: false });
  } catch (_) { throw p4b.p4bError(null, "P4B_FIXTURE_INVALID"); }
}
function identityRow(input, reconciled = 0) {
  const c = profileConfiguration(input);
  p4b.p4bCheck([0, 1].includes(reconciled), "P4B_FIXTURE_INVALID");
  return boundIdentity(actualBindings(c), reconciled);
}
function provisioningMetadata(input) { return buildMetadata(profileConfiguration(input).schema); }
function attestationStatements(input) { return buildAttestation(actualBindings(profileConfiguration(input))); }
Object.assign(module.exports, { provisioningFingerprint, provisioningSnapshot, identityRow, provisioningProfile, provisioningMetadata, attestationStatements,
  canonicalProvisioningContract, validateInstantiatedProvisioningProfile });
