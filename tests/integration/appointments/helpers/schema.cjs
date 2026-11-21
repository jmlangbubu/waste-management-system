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
