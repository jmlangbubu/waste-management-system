"use strict";

const crypto = require("crypto");
const policy = require("./appointmentPolicy");
const query = (db, sql, values = []) => new Promise((resolve, reject) =>
  db.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows)));
const invoke = (db, method) => new Promise((resolve, reject) => db[method](error => error ? reject(error) : resolve()));
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const conflict = () => policy.fail(409, "SLOT_UNAVAILABLE", "This time slot is no longer available. Please select another time.");
const unavailable = () => policy.fail(503, "APPOINTMENT_SCHEDULING_UNAVAILABLE", "Appointment scheduling is under maintenance or its reservation infrastructure is unverified. No successful change is confirmed; retry or contact WMO.");
const normalizedStatus = row => String(row.status || "pending").trim().toLowerCase() || "pending";
const cleanupDiagnostic = stage => {
  // Fixed labels only: driver errors can contain SQL, credentials or citizen data.
  try { console.warn("Appointment transaction safety", { stage }); } catch (_) { /* Diagnostics must not replace the operation's outcome. */ }
};

const schemaTables = ["appointments", "notifications", "appointment_reservations", "appointment_booking_requests", "appointment_feature_state"];
const varchar = (minLength, nullable = false, options = {}) => ({ type: "varchar", minLength, nullable, ...options });
const intColumn = (type = "int", nullable = false, options = {}) => ({ type, nullable, ...options });
const temporal = (type, nullable = false, options = {}) => ({ type, nullable, ...options });
const requiredColumns = {
  appointments: {
    id: intColumn("int", false, { autoIncrement: true }), appointment_code: varchar(30, true, { length: 30, defaultKind: "null" }),
    full_name: varchar(150), barangay: varchar(100), contact_number: varchar(11), email: varchar(254, true), purpose: varchar(100),
    preferred_date: temporal("datetime", true, { defaultKind: "null" }), notes: { type: "text", minLength: 2000, nullable: true },
    status: varchar(50), assigned_to: varchar(255, true, { defaultKind: "null" }),
    assigned_personnel_id: intColumn("int", true, { defaultKind: "null" }), assigned_personnel_name: varchar(150, true, { defaultKind: "null" }),
    assigned_at: temporal("timestamp", true, { defaultKind: "null" }), created_at: temporal("timestamp", false, { defaultKind: "timestamp" }),
    updated_at: temporal("timestamp", true, { defaultKind: "null", onUpdate: true }), orientation_token: varchar(100, true, { defaultKind: "null" }),
    orientation_qr_status: varchar(30, true), orientation_completed: intColumn("tinyint", false, { defaultKind: "zero" }),
    orientation_status: varchar(50, true, { defaultKind: "orientation" }),
    orientation_started_at: temporal("datetime", true, { defaultKind: "null" }), orientation_completed_at: temporal("datetime", true, { defaultKind: "null" }),
    orientation_score: intColumn("int", true, { defaultKind: "null" }),
    appointment_revision: intColumn("bigint", false, { unsigned: true, defaultKind: "zero" })
  },
  notifications: {
    id: intColumn("int", false, { autoIncrement: true }), type: varchar(50, true), title: varchar(255, true),
    message: { type: "text", minLength: 512, nullable: true }, isRead: intColumn("tinyint", true, { defaultKind: "zero" }),
    createdAt: temporal("timestamp", false, { defaultKind: "timestamp" }), status: varchar(80, true, { defaultKind: "null" }),
    reference_id: varchar(120, true, { defaultKind: "null" })
  },
  appointment_reservations: {
    service_key: varchar(32, false, { length: 32, ascii: true }), appointment_date: temporal("date"), appointment_time: temporal("time"), appointment_id: intColumn()
  },
  appointment_booking_requests: {
    request_hash: { type: "char", length: 64, nullable: false, ascii: true }, payload_hash: { type: "char", length: 64, nullable: false, ascii: true },
    appointment_id: intColumn("int", true, { defaultKind: "null" }), appointment_code: varchar(30, true, { length: 30, defaultKind: "null" })
  },
  appointment_feature_state: {
    feature_key: varchar(32, false, { length: 32, ascii: true }), schema_version: intColumn(), backfill_complete: intColumn("tinyint", false, { defaultKind: "zero" })
  }
};
const suppliedColumns = {
  appointments: new Set(["full_name", "barangay", "contact_number", "email", "purpose", "preferred_date", "notes", "status", "orientation_token", "orientation_qr_status", "orientation_completed", "created_at", "updated_at"]),
  notifications: new Set(["type", "title", "message"]),
  appointment_reservations: new Set(["service_key", "appointment_date", "appointment_time", "appointment_id"]),
  appointment_booking_requests: new Set(["request_hash", "payload_hash"]),
  appointment_feature_state: new Set(["feature_key", "schema_version", "backfill_complete"])
};
const ensure = condition => { if (!condition) throw unavailable(); };
const metadataInteger = value => typeof value === "number" && Number.isSafeInteger(value) ? value
  : typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : NaN;
const zeroDefault = value => value === 0 || value === "0";
const timestampDefault = value => typeof value === "string" && /^current_timestamp(?:\(0?\))?$/i.test(value);
function validateColumn(row, spec) {
  ensure(row.DATA_TYPE === spec.type && row.IS_NULLABLE === (spec.nullable ? "YES" : "NO"));
  const extra = row.EXTRA.toLowerCase(), type = row.COLUMN_TYPE.toLowerCase();
  ensure(row.GENERATION_EXPRESSION === "");
  if (["int", "bigint", "tinyint"].includes(spec.type)) {
    ensure(new RegExp(`^${spec.type}(?:\\(\\d+\\))?${spec.unsigned ? " unsigned" : ""}$`).test(type));
    ensure(metadataInteger(row.NUMERIC_PRECISION) === (spec.type === "bigint" ? spec.unsigned ? 20 : 19 : spec.type === "int" ? 10 : 3));
    ensure(metadataInteger(row.NUMERIC_SCALE) === 0);
  } else if (["varchar", "char", "text"].includes(spec.type)) {
    const length = metadataInteger(row.CHARACTER_MAXIMUM_LENGTH);
    ensure(Number.isFinite(length) && length >= (spec.minLength || spec.length));
    if (spec.type === "text") ensure(type === "text");
    else ensure(type === `${spec.type}(${length})`);
    if (spec.length) ensure(length === spec.length);
    ensure(typeof row.CHARACTER_SET_NAME === "string" && typeof row.COLLATION_NAME === "string");
    if (spec.ascii) ensure(row.CHARACTER_SET_NAME === "ascii" && row.COLLATION_NAME === "ascii_bin");
  } else {
    ensure(type === spec.type || spec.type !== "date" && type === `${spec.type}(0)`);
    if (spec.type !== "date") ensure(metadataInteger(row.DATETIME_PRECISION) === 0);
  }
  if (spec.autoIncrement) ensure(extra === "auto_increment" && row.COLUMN_DEFAULT === null);
  else if (["timestamp", "datetime"].includes(spec.type)) ensure(spec.onUpdate
    ? /^(?:default_generated)?(?: ?on update current_timestamp(?:\(0?\))?)?$/.test(extra)
    : /^(?:default_generated)?$/.test(extra));
  else ensure(extra === "");
  if (extra.includes("default_generated")) ensure(timestampDefault(row.COLUMN_DEFAULT));
  if (spec.defaultKind === "null") ensure(row.COLUMN_DEFAULT === null);
  if (spec.defaultKind === "zero") ensure(zeroDefault(row.COLUMN_DEFAULT));
  if (spec.defaultKind === "timestamp") ensure(timestampDefault(row.COLUMN_DEFAULT));
  if (spec.defaultKind === "orientation") ensure(row.COLUMN_DEFAULT === null || typeof row.COLUMN_DEFAULT === "string" && ["", "approved"].includes(row.COLUMN_DEFAULT.trim().toLowerCase()));
}
function canOmit(row) {
  const extra = row.EXTRA.toLowerCase(), value = row.COLUMN_DEFAULT;
  if (extra === "auto_increment") return row.IS_NULLABLE === "NO" && value === null && row.GENERATION_EXPRESSION === ""
    && ["int", "bigint", "tinyint", "smallint", "mediumint"].includes(row.DATA_TYPE)
    && new RegExp(`^${row.DATA_TYPE}(?:\\(\\d+\\))?(?: unsigned)?$`).test(row.COLUMN_TYPE.toLowerCase())
    && metadataInteger(row.NUMERIC_SCALE) === 0;
  // Unknown expression defaults/generated extensions need separate review, not an optimistic pass.
  if (row.GENERATION_EXPRESSION !== "" || /(?:virtual|stored) generated/.test(extra)) return false;
  if (/default_generated/.test(extra)) return ["timestamp", "datetime"].includes(row.DATA_TYPE) && timestampDefault(value);
  if (value === null) return row.IS_NULLABLE === "YES";
  if (["varchar", "char", "text"].includes(row.DATA_TYPE)) return typeof value === "string" && [...value].length <= metadataInteger(row.CHARACTER_MAXIMUM_LENGTH);
  if (["int", "bigint", "tinyint", "smallint", "mediumint"].includes(row.DATA_TYPE)) {
    const literal = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" && /^-?\d+$/.test(value) ? value : null;
    if (literal === null) return false;
    const bits = { tinyint: 8n, smallint: 16n, mediumint: 24n, int: 32n, bigint: 64n }[row.DATA_TYPE];
    const unsigned = / unsigned$/.test(row.COLUMN_TYPE.toLowerCase()), number = BigInt(literal);
    const minimum = unsigned ? 0n : -(1n << (bits - 1n));
    const maximum = (1n << (unsigned ? bits : bits - 1n)) - 1n;
    return number >= minimum && number <= maximum;
  }
  if (row.DATA_TYPE === "decimal") return typeof value === "number" && Number.isFinite(value) || typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value);
  return ["timestamp", "datetime"].includes(row.DATA_TYPE) && timestampDefault(value);
}
function validateSchema(schema, tables, columns, indexes, foreignKeys) {
  for (const rows of [tables, columns, indexes, foreignKeys]) ensure(Array.isArray(rows));
  ensure(tables.length === schemaTables.length);
  for (const name of schemaTables) ensure(tables.filter(row => row.TABLE_SCHEMA === schema && row.TABLE_NAME === name && row.TABLE_TYPE === "BASE TABLE" && row.ENGINE === "InnoDB").length === 1);
  const byTable = new Map(schemaTables.map(name => [name, new Map()]));
  const columnNames = new Map(schemaTables.map(name => [name, new Set()]));
  const fields = ["TABLE_SCHEMA", "TABLE_NAME", "COLUMN_NAME", "DATA_TYPE", "COLUMN_TYPE", "IS_NULLABLE", "COLUMN_DEFAULT", "EXTRA", "CHARACTER_MAXIMUM_LENGTH", "NUMERIC_PRECISION", "NUMERIC_SCALE", "DATETIME_PRECISION", "CHARACTER_SET_NAME", "COLLATION_NAME", "GENERATION_EXPRESSION"];
  for (const row of columns) {
    ensure(fields.every(field => Object.hasOwn(row, field) && row[field] !== undefined));
    ensure(row.TABLE_SCHEMA === schema && byTable.has(row.TABLE_NAME) && typeof row.COLUMN_NAME === "string" && row.COLUMN_NAME.length > 0);
    ensure(typeof row.EXTRA === "string" && typeof row.DATA_TYPE === "string" && row.DATA_TYPE.length > 0 && typeof row.COLUMN_TYPE === "string" && row.COLUMN_TYPE.length > 0 && typeof row.GENERATION_EXPRESSION === "string");
    ensure(row.IS_NULLABLE === "YES" || row.IS_NULLABLE === "NO");
    ensure(row.COLUMN_DEFAULT === null || typeof row.COLUMN_DEFAULT === "string" || typeof row.COLUMN_DEFAULT === "number");
    const table = byTable.get(row.TABLE_NAME);
    const names = columnNames.get(row.TABLE_NAME);
    ensure(!names.has(row.COLUMN_NAME.toLowerCase())); names.add(row.COLUMN_NAME.toLowerCase());
    table.set(row.COLUMN_NAME, row);
  }
  for (const name of schemaTables) {
    const table = byTable.get(name);
    ensure([...table.values()].filter(row => row.EXTRA.toLowerCase() === "auto_increment").length <= 1);
    for (const [column, spec] of Object.entries(requiredColumns[name])) { ensure(table.has(column)); validateColumn(table.get(column), spec); }
    for (const row of table.values()) if (!suppliedColumns[name].has(row.COLUMN_NAME)) ensure(canOmit(row));
  }
  const groups = new Map();
  for (const row of indexes) {
    ensure(row.TABLE_SCHEMA === schema && byTable.has(row.TABLE_NAME) && typeof row.INDEX_NAME === "string" && row.INDEX_NAME.length > 0);
    ensure(["NON_UNIQUE", "SEQ_IN_INDEX", "COLUMN_NAME", "SUB_PART", "EXPRESSION", "INDEX_TYPE", "IS_VISIBLE"].every(field => Object.hasOwn(row, field) && row[field] !== undefined));
    ensure([0, 1].includes(metadataInteger(row.NON_UNIQUE)) && metadataInteger(row.SEQ_IN_INDEX) > 0);
    ensure(row.IS_VISIBLE === "YES" || row.IS_VISIBLE === "NO");
    ensure(["BTREE", "FULLTEXT", "RTREE"].includes(row.INDEX_TYPE));
    ensure(row.EXPRESSION === null ? byTable.get(row.TABLE_NAME).has(row.COLUMN_NAME) : row.COLUMN_NAME === null && typeof row.EXPRESSION === "string" && row.EXPRESSION.length > 0);
    if (row.SUB_PART !== null) ensure(metadataInteger(row.SUB_PART) > 0 && metadataInteger(row.SUB_PART) <= metadataInteger(byTable.get(row.TABLE_NAME).get(row.COLUMN_NAME)?.CHARACTER_MAXIMUM_LENGTH));
    const key = `${row.TABLE_NAME}/${row.INDEX_NAME.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const keys = [...groups.values()].map(rows => {
    rows.sort((a, b) => metadataInteger(a.SEQ_IN_INDEX) - metadataInteger(b.SEQ_IN_INDEX));
    ensure(rows.every((row, i) => metadataInteger(row.SEQ_IN_INDEX) === i + 1 && row.INDEX_NAME === rows[0].INDEX_NAME && metadataInteger(row.NON_UNIQUE) === metadataInteger(rows[0].NON_UNIQUE) && row.INDEX_TYPE === rows[0].INDEX_TYPE));
    if (metadataInteger(rows[0].NON_UNIQUE) === 0) ensure(rows[0].INDEX_TYPE === "BTREE");
    return { table: rows[0].TABLE_NAME, primary: rows[0].INDEX_NAME === "PRIMARY", unique: metadataInteger(rows[0].NON_UNIQUE) === 0,
      full: rows.every(row => row.SUB_PART === null && row.EXPRESSION === null), columns: rows.map(row => row.COLUMN_NAME), rows };
  });
  const acceptedUnique = {
    appointments: [["id"], ["appointment_code"]], notifications: [["id"]],
    appointment_reservations: [["service_key", "appointment_date", "appointment_time"], ["appointment_id"]],
    appointment_booking_requests: [["request_hash"], ["appointment_id"]], appointment_feature_state: [["feature_key"]]
  };
  for (const [table, required] of Object.entries(acceptedUnique)) for (const names of required) {
    const primary = table === "appointments" && names[0] === "id" || table === "notifications" || table === "appointment_feature_state" || table === "appointment_booking_requests" && names[0] === "request_hash";
    ensure(keys.some(key => key.table === table && key.unique && key.full && (!primary || key.primary) && JSON.stringify(key.columns) === JSON.stringify(names)));
  }
  for (const key of keys.filter(key => key.unique)) {
    const full = key.rows.filter(row => row.SUB_PART === null && row.EXPRESSION === null).map(row => row.COLUMN_NAME);
    // This service only INSERTs notification type/title/message; it never updates
    // notifications. An omitted literal-NULL part cannot conflict in a full key.
    // Re-audit this exception if those writes change; it does not cover other tables.
    const nullNotificationKey = key.table === "notifications" && key.full && full.some(name => {
      const column = byTable.get(key.table).get(name);
      return !suppliedColumns.notifications.has(name) && column.IS_NULLABLE === "YES" && column.COLUMN_DEFAULT === null
        && column.EXTRA === "" && column.GENERATION_EXPRESSION === "";
    });
    // A full existing unique determinant makes an extra unique index redundant, even
    // with other parts or a different order. Nullable unique determinants remain safe.
    ensure(nullNotificationKey || acceptedUnique[key.table].some(names => names.every(name => full.includes(name))) || full.some(name => byTable.get(key.table).get(name).EXTRA.toLowerCase() === "auto_increment" && !suppliedColumns[key.table].has(name)));
  }
  const relationships = new Map(), linked = new Set();
  for (const row of foreignKeys) {
    ensure(row.CONSTRAINT_SCHEMA === schema && row.TABLE_SCHEMA === schema && ["appointment_reservations", "appointment_booking_requests"].includes(row.TABLE_NAME));
    ensure(typeof row.CONSTRAINT_NAME === "string" && row.CONSTRAINT_NAME.length > 0);
    if (!relationships.has(row.CONSTRAINT_NAME.toLowerCase())) relationships.set(row.CONSTRAINT_NAME.toLowerCase(), []);
    relationships.get(row.CONSTRAINT_NAME.toLowerCase()).push(row);
  }
  for (const rows of relationships.values()) {
    ensure(rows.length === 1);
    const row = rows[0];
    ensure(row.COLUMN_NAME === "appointment_id" && metadataInteger(row.ORDINAL_POSITION) === 1 && metadataInteger(row.POSITION_IN_UNIQUE_CONSTRAINT) === 1);
    ensure(row.REFERENCED_TABLE_SCHEMA === schema && row.REFERENCED_TABLE_NAME === "appointments" && row.REFERENCED_COLUMN_NAME === "id");
    ensure(["RESTRICT", "NO ACTION"].includes(row.UPDATE_RULE) && ["RESTRICT", "NO ACTION"].includes(row.DELETE_RULE));
    linked.add(row.TABLE_NAME);
  }
  ensure(linked.size === 2);
}

class AppointmentSchedulingService {
  constructor(db, { enabled = () => process.env.APPOINTMENT_RESERVATIONS_ENABLED === "true", now = () => new Date() } = {}) {
    this.db = db; this.enabled = enabled; this.now = now;
  }
  async ready(connection) {
    if (!this.enabled()) throw unavailable();
    if (!connection) return this.withReadyConnection(async () => {});
    try {
      ensure(connection !== this.db);
      const identity = await query(connection, "SELECT DATABASE() AS schema_name");
      ensure(Array.isArray(identity) && identity.length === 1 && typeof identity[0].schema_name === "string" && identity[0].schema_name.length > 0);
      const schema = identity[0].schema_name;
      const tables = await query(connection, `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, ENGINE FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('appointments', 'notifications', 'appointment_reservations', 'appointment_booking_requests', 'appointment_feature_state')`, [schema]);
      const columns = await query(connection, `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
        EXTRA, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, DATETIME_PRECISION, CHARACTER_SET_NAME, COLLATION_NAME, GENERATION_EXPRESSION
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('appointments', 'notifications', 'appointment_reservations', 'appointment_booking_requests', 'appointment_feature_state')`, [schema]);
      const indexes = await query(connection, `SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART, EXPRESSION, INDEX_TYPE, IS_VISIBLE
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('appointments', 'notifications', 'appointment_reservations', 'appointment_booking_requests', 'appointment_feature_state')`, [schema]);
      const links = await query(connection, `SELECT k.CONSTRAINT_SCHEMA, k.CONSTRAINT_NAME, k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION,
        k.POSITION_IN_UNIQUE_CONSTRAINT, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE
        FROM information_schema.KEY_COLUMN_USAGE k LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME IN ('appointment_reservations', 'appointment_booking_requests') AND k.REFERENCED_TABLE_NAME IS NOT NULL`, [schema]);
      validateSchema(schema, tables, columns, indexes, links);
      const rows = await query(connection, "SELECT feature_key, schema_version, backfill_complete FROM appointment_feature_state WHERE feature_key = 'service_slots'");
      ensure(Array.isArray(rows) && rows.length === 1 && rows[0].feature_key === "service_slots" && [1, "1"].includes(rows[0].schema_version) && [1, "1"].includes(rows[0].backfill_complete));
    } catch (_) { throw unavailable(); }
  }
  async withReadyConnection(operation) {
    if (!this.enabled()) throw unavailable();
    let connection;
    try { connection = await new Promise((resolve, reject) => this.db.getConnection((error, db) => error ? reject(error) : resolve(db))); }
    catch (_) { throw unavailable(); }
    let reusable = false;
    try {
      await this.ready(connection);
      const result = await operation(connection);
      reusable = true;
      return result;
    } finally {
      const disposition = reusable ? "release" : "destroy";
      try { connection[disposition](); } catch (_) { cleanupDiagnostic(`${disposition}_failed`); }
    }
  }
  async transaction(operation) {
    // An off flag cannot prove that this database was never activated. Every writer
    // requires the same schema/backfill protocol; there is no legacy write fallback.
    if (!this.enabled()) throw unavailable();
    const connection = await new Promise((resolve, reject) => this.db.getConnection((error, db) => error ? reject(error) : resolve(db)));
    let previousTimezone;
    const lifecycle = { setup: "pending", begin: "pending", operation: "pending",
      commit: "pending", rollback: "pending", restore: "pending", unsafe: false };
    try {
      await this.ready(connection);
      // SQL appointment strings are explicitly Philippine wall time; never depend on the host timezone.
      lifecycle.setup = "attempted";
      previousTimezone = (await query(connection, "SELECT @@session.time_zone AS timezone"))[0]?.timezone;
      if (typeof previousTimezone !== "string" || !previousTimezone) throw unavailable();
      await query(connection, "SET time_zone = '+08:00'");
      lifecycle.setup = "acknowledged";
      lifecycle.begin = "attempted";
      await invoke(connection, "beginTransaction");
      lifecycle.begin = "acknowledged";
      const state = await query(connection, "SELECT schema_version, backfill_complete FROM appointment_feature_state WHERE feature_key = 'service_slots' FOR SHARE");
      if (!Array.isArray(state) || state.length !== 1 || ![1, "1"].includes(state[0].schema_version) || ![1, "1"].includes(state[0].backfill_complete)) throw unavailable();
      lifecycle.operation = "in_progress";
      const result = await operation(connection);
      lifecycle.operation = "completed";
      lifecycle.commit = "attempted";
      try {
        await invoke(connection, "commit");
        lifecycle.commit = "acknowledged";
      } catch (_) {
        // ROLLBACK cannot establish whether a COMMIT with a lost acknowledgement persisted.
        lifecycle.unsafe = true;
        cleanupDiagnostic("commit_unconfirmed");
        throw policy.fail(503, "APPOINTMENT_UNAVAILABLE", "Appointment operation could not be confirmed. Recover the original booking request, or refresh the appointment before retrying.");
      }
      return result;
    } catch (error) {
      if (error?.fatal) lifecycle.unsafe = true;
      if (lifecycle.begin === "acknowledged" && lifecycle.commit === "pending") {
        lifecycle.rollback = "attempted";
        try {
          await invoke(connection, "rollback");
          lifecycle.rollback = "acknowledged";
        } catch (_) {
          lifecycle.unsafe = true;
          cleanupDiagnostic("rollback_failed");
        }
      }
      throw error;
    } finally {
      const resolved = lifecycle.commit === "acknowledged" || lifecycle.rollback === "acknowledged";
      if (resolved && !lifecycle.unsafe && lifecycle.setup === "acknowledged") {
        lifecycle.restore = "attempted";
        try {
          await query(connection, "SET time_zone = ?", [previousTimezone]);
          lifecycle.restore = "acknowledged";
        } catch (_) {
          lifecycle.unsafe = true;
          cleanupDiagnostic("timezone_restore_failed");
        }
      }
      const reusable = resolved && !lifecycle.unsafe && lifecycle.restore === "acknowledged";
      const disposition = reusable ? "release" : "destroy";
      // Exactly one terminal method attempt. Never fall back from a failed destroy to release,
      // or let cleanup replace a business error / acknowledged committed success.
      try { connection[disposition](); } catch (_) { cleanupDiagnostic(`${disposition}_failed`); }
      // No cleanup deadline is approved. A callback that never settles can still stall here;
      // adding a deadline requires a separate cancellation/disposal policy, not a release race.
    }
  }
  async availability(service, date) {
    const key = policy.serviceKey(service); policy.validateDate(date);
    return this.withReadyConnection(async connection => {
      const rows = await query(connection, `SELECT TIME_FORMAT(appointment_time, '%H:%i') AS time
        FROM appointment_reservations WHERE service_key = ? AND appointment_date = ?`, [key, date]);
      const occupied = new Set(rows.map(row => row.time)), now = policy.manilaNow(this.now());
      return { success: true, service, date, timezone: "Asia/Manila", slots: policy.TIMES.map(time => ({ time,
        status: `${date} ${time}:00` <= now ? "past" : occupied.has(time) ? "occupied" : "available" })) };
    });
  }
  async book(body, requestKey, { recoveryOnly = false } = {}) {
    // Validation is independent of infrastructure. The durable key is not a citizen identifier.
    if (typeof requestKey !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(requestKey)) {
      throw policy.fail(400, "IDEMPOTENCY_KEY_REQUIRED", "A booking request identifier is required. Refresh the booking form.");
    }
    // Normalize without rejecting elapsed time until AFTER a durable retry lookup.
    const data = policy.booking(body, new Date("1970-01-01T00:00:00Z"));
    const requestHash = hash(requestKey), payloadHash = hash(JSON.stringify(data));
    return this.transaction(async connection => {
      const recover = async () => {
        const requests = await query(connection, `SELECT payload_hash, appointment_id, appointment_code
          FROM appointment_booking_requests WHERE request_hash = ? FOR UPDATE`, [requestHash]);
        if (!requests.length) throw policy.fail(404, "BOOKING_NOT_FOUND", "No confirmed booking was found for this request yet. Retry recovery or contact WMO. Recovery does not create a new appointment.");
        if (requests[0].payload_hash !== payloadHash) {
          throw policy.fail(409, "IDEMPOTENCY_CONFLICT", "This request identifier belongs to different booking details. Restore the original details and retry recovery.");
        }
        if (!requests[0].appointment_id || !requests[0].appointment_code) throw unavailable();
        return { success: true, message: "Original appointment reference recovered", id: requests[0].appointment_id,
          appointment_code: requests[0].appointment_code, idempotent: true };
      };
      // Recovery is lookup-only even if the original POST never reached the server.
      // Possession of a key alone reveals no PII; the normalized payload must match.
      if (recoveryOnly) return recover();
      try {
        await query(connection, "INSERT INTO appointment_booking_requests (request_hash, payload_hash) VALUES (?, ?)", [requestHash, payloadHash]);
      } catch (error) {
        if (error.code !== "ER_DUP_ENTRY") throw error;
        return recover();
      }
      policy.schedule(data.purpose, data.slot.sql, this.now());
      const inserted = await query(connection, `INSERT INTO appointments
        (full_name, barangay, contact_number, email, purpose, preferred_date, notes, status,
         orientation_token, orientation_qr_status, orientation_completed, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 'not_generated', 0, NOW(), NOW())`,
      [data.full_name, data.barangay, data.contact_number, data.email, data.purpose, data.slot.sql, data.notes || null]);
      const id = inserted.insertId, code = `APT-${String(id).padStart(6, "0")}`;
      try {
        await query(connection, `INSERT INTO appointment_reservations
          (service_key, appointment_date, appointment_time, appointment_id) VALUES (?, ?, ?, ?)`,
        [data.slot.key, data.slot.date, `${data.slot.time}:00`, id]);
      } catch (error) { if (error.code === "ER_DUP_ENTRY") throw conflict(); throw error; }
      const updated = await query(connection, "UPDATE appointments SET appointment_code = ? WHERE id = ?", [code, id]);
      if (updated.affectedRows !== 1) throw unavailable();
      await query(connection, `INSERT INTO notifications (type, title, message) VALUES (?, ?, ?)`,
        ["appointment", "New Appointment Request", `New appointment from ${data.full_name} (${data.barangay}) for ${data.purpose}`]);
      await query(connection, "UPDATE appointment_booking_requests SET appointment_id = ?, appointment_code = ? WHERE request_hash = ?", [id, code, requestHash]);
      return { success: true, message: "Appointment request submitted successfully", id, appointment_code: code };
    });
  }
  async change(id, action, actor, body = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw policy.fail(400, "INVALID_BODY", "A valid appointment request is required");
    if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw policy.fail(400, "INVALID_ID", "Valid appointment ID is required");
    if (!["accept", "reject", "reschedule", "cancel"].includes(action)) throw policy.fail(400, "INVALID_ACTION", "Invalid appointment action");
    const name = String(actor?.full_name || actor?.username || "").trim();
    if (!actor?.id || !name) throw policy.fail(401, "STAFF_REQUIRED", "Authenticated staff identity is required");
    if (body.expected_status === undefined || typeof body.expected_schedule !== "string") {
      throw policy.fail(409, "REFRESH_REQUIRED", "Refresh the appointment before taking action.");
    }
    return this.transaction(async connection => {
      const rows = await query(connection, `SELECT *, DATE_FORMAT(preferred_date, '%Y-%m-%d %H:%i:%s') AS slot_schedule
        FROM appointments WHERE id = ? FOR UPDATE`, [id]);
      if (!rows.length) throw policy.fail(404, "NOT_FOUND", "Appointment not found");
      const row = rows[0], status = normalizedStatus(row);
      if (status !== body.expected_status || row.slot_schedule !== body.expected_schedule ||
        !Number.isSafeInteger(body.expected_revision) || body.expected_revision !== Number(row.appointment_revision)) {
        throw policy.fail(409, "STALE_APPOINTMENT", "Appointment changed. Refresh before trying again.");
      }
      const allowed = action === "cancel" ? ["pending", "approved", "rescheduled"]
        : action === "reschedule" ? ["pending", "approved", "rescheduled"] : ["pending", "rescheduled"];
      if (!allowed.includes(status)) throw policy.fail(409, "INVALID_TRANSITION", "This appointment cannot be changed from its current status.");
      // Do not erase orientation evidence while processing ordinary scheduling actions.
      if (row.purpose === "SWM Orientation & Clearance" && ["accept", "reschedule"].includes(action) &&
        (row.orientation_started_at || row.orientation_completed_at || row.orientation_score != null ||
        Number(row.orientation_completed) === 1 || !["", "approved"].includes(String(row.orientation_status || "").trim().toLowerCase()))) {
        throw policy.fail(409, "ORIENTATION_REVIEW_REQUIRED", "Existing orientation progress requires WMO review. This appointment was not rescheduled or restarted; its schedule and orientation evidence are unchanged.");
      }
      const target = action === "reschedule" ? policy.schedule(row.purpose, body.new_date, this.now()) : null;
      if (target && target.sql === row.slot_schedule) throw policy.fail(409, "UNCHANGED_SCHEDULE", "Select a different date or time.");
      const slots = await query(connection, `SELECT *, DATE_FORMAT(appointment_date, '%Y-%m-%d') AS slot_date,
        TIME_FORMAT(appointment_time, '%H:%i') AS slot_time FROM appointment_reservations WHERE appointment_id = ? FOR UPDATE`, [id]);
      if (slots.length !== 1) throw unavailable();
      const existing = policy.schedule(row.purpose, row.slot_schedule, new Date("1970-01-01T00:00:00Z"));
      if (slots[0].service_key !== existing.key || slots[0].slot_date !== existing.date || slots[0].slot_time !== existing.time) throw unavailable();
      if (action === "reschedule") {
        // Updating a unique key acquires the destination without releasing the source on failure.
        try {
          await query(connection, `UPDATE appointment_reservations SET service_key = ?, appointment_date = ?, appointment_time = ?
            WHERE appointment_id = ?`, [target.key, target.date, `${target.time}:00`, id]);
        } catch (error) { if (error.code === "ER_DUP_ENTRY") throw conflict(); throw error; }
      } else if (["reject", "cancel"].includes(action)) await query(connection, "DELETE FROM appointment_reservations WHERE appointment_id = ?", [id]);
      const next = { accept: "approved", reject: "rejected", reschedule: "rescheduled", cancel: "cancelled" }[action];
      const orientation = action === "accept" && row.purpose === "SWM Orientation & Clearance";
      const token = orientation ? row.orientation_token || `ORI-${id}-${this.now().getTime()}` : null;
      // assigned_to/assigned_at now retain the latest actual approval. A later
      // reschedule, rejection or cancellation must not masquerade as acceptance.
      const sets = ["status = ?", "updated_at = NOW()"], values = [next];
      if (action === "accept") { sets.push("assigned_to = ?", "assigned_at = NOW()"); values.push(name); }
      if (target) { sets.push("preferred_date = ?"); values.push(target.sql); }
      if (orientation) { sets.push("orientation_token = ?", "orientation_qr_status = 'generated'", "orientation_status = 'approved'"); values.push(token); }
      sets.push("appointment_revision = appointment_revision + 1");
      values.push(id, row.status, row.slot_schedule);
      const result = await query(connection, `UPDATE appointments SET ${sets.join(", ")}
        WHERE id = ? AND status <=> ? AND preferred_date <=> ?`, values);
      if (result.affectedRows !== 1) throw policy.fail(409, "STALE_APPOINTMENT", "Appointment state changed; refresh and retry.");
      return { success: true, message: action === "accept" ? "Appointment accepted successfully" : action === "reject" ? "Appointment rejected successfully"
        : action === "reschedule" ? "Appointment successfully rescheduled" : "Appointment cancelled successfully",
        data: { id: Number(id), status: next, assigned_to: action === "accept" ? name : row.assigned_to ?? null,
          action_by: name, ...(target ? { new_date: target.sql } : {}),
          ...(action === "accept" || action === "reject" ? { orientation_token: token, orientation_qr_status: orientation ? "generated" : null } : {}) },
        previous: row };
    });
  }
}
module.exports = { AppointmentSchedulingService, query };
