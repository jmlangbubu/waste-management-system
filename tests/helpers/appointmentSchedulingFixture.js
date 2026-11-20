"use strict";
const { AppointmentSchedulingService } = require("../../services/appointmentSchedulingService");
const now = () => new Date("2026-11-20T02:00:00Z");
const citizen = { full_name: "Synthetic Citizen", barangay: "Apopong", email: "synthetic@example.invalid",
  contact_number: "09123456789", purpose: "Accreditation", preferred_date: "2026-11-23 10:00:00", notes: "" };
const actor = { id: 8, role: "clerk_admin", full_name: "Authenticated Clerk" };
const requestKey = suffix => `synthetic-request-key-${suffix}`;

// Independent synthetic DDL evidence: legacy column shapes from Q4 plus the commented
// future draft. Literal defaults below are test choices, NOT recovered production defaults.
function reviewedSchema() {
  const schema = "fixture_wmo";
  const definitions = {
    appointments: [
      ["id", "int", false, null, "auto_increment"], ["appointment_code", "varchar(30)", true],
      ["full_name", "varchar(150)", false], ["barangay", "varchar(150)", false], ["contact_number", "varchar(50)", false],
      ["email", "varchar(255)", true], ["purpose", "varchar(100)", false], ["preferred_date", "datetime", true], ["notes", "text", true],
      ["status", "varchar(50)", false, "pending"], ["assigned_to", "varchar(255)", true], ["assigned_personnel_id", "int", true],
      ["assigned_personnel_name", "varchar(150)", true], ["assigned_at", "timestamp", true],
      ["created_at", "timestamp", false, "CURRENT_TIMESTAMP", "DEFAULT_GENERATED"], ["updated_at", "timestamp", true, null, "on update CURRENT_TIMESTAMP"],
      ["orientation_token", "varchar(100)", true], ["orientation_qr_status", "varchar(30)", true, "not_generated"], ["orientation_completed", "tinyint(1)", false, "0"],
      ["orientation_status", "varchar(50)", true, "approved"], ["orientation_started_at", "datetime", true], ["orientation_completed_at", "datetime", true],
      ["orientation_score", "int", true], ["appointment_revision", "bigint unsigned", false, "0"]
    ],
    notifications: [
      ["id", "int", false, null, "auto_increment"], ["type", "varchar(50)", true], ["title", "varchar(255)", true], ["message", "text", true],
      ["isRead", "tinyint(1)", true, "0"], ["createdAt", "timestamp", false, "CURRENT_TIMESTAMP", "DEFAULT_GENERATED"],
      ["status", "varchar(80)", true], ["reference_id", "varchar(120)", true]
    ],
    appointment_reservations: [["service_key", "varchar(32)", false, null, "", "ascii"], ["appointment_date", "date", false], ["appointment_time", "time", false], ["appointment_id", "int", false]],
    appointment_booking_requests: [["request_hash", "char(64)", false, null, "", "ascii"], ["payload_hash", "char(64)", false, null, "", "ascii"], ["appointment_id", "int", true], ["appointment_code", "varchar(30)", true]],
    appointment_feature_state: [["feature_key", "varchar(32)", false, null, "", "ascii"], ["schema_version", "int", false], ["backfill_complete", "tinyint", false, "0"]]
  };
  const columns = Object.entries(definitions).flatMap(([table, entries]) => entries.map(([name, type, nullable, value = null, extra = "", charset = "utf8mb4"], ordinal) => {
    const dataType = type.match(/^\w+/)[0], size = type.match(/\((\d+)\)/);
    const numeric = ["int", "bigint", "tinyint"].includes(dataType), string = ["varchar", "char", "text"].includes(dataType);
    return { TABLE_CATALOG: "def", TABLE_SCHEMA: schema, TABLE_NAME: table, COLUMN_NAME: name, ORDINAL_POSITION: ordinal + 1,
      DATA_TYPE: dataType, COLUMN_TYPE: type, IS_NULLABLE: nullable ? "YES" : "NO", COLUMN_DEFAULT: value, EXTRA: extra,
      CHARACTER_MAXIMUM_LENGTH: string ? dataType === "text" ? 65535 : Number(size[1]) : null,
      CHARACTER_OCTET_LENGTH: string ? dataType === "text" ? 65535 : Number(size[1]) * (charset === "ascii" ? 1 : 4) : null,
      NUMERIC_PRECISION: numeric ? dataType === "int" ? 10 : dataType === "tinyint" ? 3 : 20 : null, NUMERIC_SCALE: numeric ? 0 : null,
      DATETIME_PRECISION: ["datetime", "timestamp", "time"].includes(dataType) ? 0 : null,
      CHARACTER_SET_NAME: string ? charset : null, COLLATION_NAME: string ? charset === "ascii" ? "ascii_bin" : "utf8mb4_general_ci" : null,
      GENERATION_EXPRESSION: "", COLUMN_KEY: "", COLUMN_COMMENT: "synthetic metadata" };
  }));
  const metadata = { schema,
    tables: Object.keys(definitions).map(TABLE_NAME => ({ TABLE_CATALOG: "def", TABLE_SCHEMA: schema, TABLE_NAME, TABLE_TYPE: "BASE TABLE", ENGINE: "InnoDB", TABLE_COLLATION: "utf8mb4_general_ci" })),
    columns, indexes: [], foreignKeys: [], marker: [{ feature_key: "service_slots", schema_version: 1, backfill_complete: 1 }] };
  addIndex(metadata, "appointments", "PRIMARY", ["id"]); addIndex(metadata, "appointments", "appointment_code", ["appointment_code"]);
  addIndex(metadata, "notifications", "PRIMARY", ["id"]);
  addIndex(metadata, "appointment_reservations", "PRIMARY", ["service_key", "appointment_date", "appointment_time"]);
  addIndex(metadata, "appointment_reservations", "reservation_appointment", ["appointment_id"]);
  addIndex(metadata, "appointment_booking_requests", "PRIMARY", ["request_hash"]);
  addIndex(metadata, "appointment_booking_requests", "request_appointment", ["appointment_id"]);
  addIndex(metadata, "appointment_feature_state", "PRIMARY", ["feature_key"]);
  for (const table of ["appointment_reservations", "appointment_booking_requests"]) metadata.foreignKeys.push({
    CONSTRAINT_CATALOG: "def", CONSTRAINT_SCHEMA: schema, CONSTRAINT_NAME: `${table}_appointment_fk`, TABLE_SCHEMA: schema, TABLE_NAME: table,
    COLUMN_NAME: "appointment_id", ORDINAL_POSITION: 1, POSITION_IN_UNIQUE_CONSTRAINT: 1,
    REFERENCED_TABLE_SCHEMA: schema, REFERENCED_TABLE_NAME: "appointments", REFERENCED_COLUMN_NAME: "id", UPDATE_RULE: "RESTRICT", DELETE_RULE: "RESTRICT"
  });
  return metadata;
}
function addIndex(metadata, table, name, columns, { unique = true, visible = "YES" } = {}) {
  metadata.indexes.push(...columns.map((COLUMN_NAME, i) => ({ TABLE_CATALOG: "def", TABLE_SCHEMA: metadata.schema, TABLE_NAME: table,
    INDEX_SCHEMA: metadata.schema, INDEX_NAME: name, NON_UNIQUE: unique ? 0 : 1, SEQ_IN_INDEX: i + 1, COLUMN_NAME,
    SUB_PART: null, EXPRESSION: null, INDEX_TYPE: "BTREE", IS_VISIBLE: visible, COLLATION: "A", CARDINALITY: 0, INDEX_COMMENT: "" })));
}

// Explicitly a transaction MODEL, not MySQL. Serializing model transactions exercises
// stale-snapshot/retry/rollback outcomes but does not prove InnoDB locking or SQL compatibility.
function fixture(options = {}) {
  let state = { next: 1, appointments: [], slots: [], requests: [], notifications: [] };
  let tail = Promise.resolve();
  const calls = [], connections = [], leases = [], idle = [];
  const metadata = options.metadata || reviewedSchema();
  const metrics = { acquisitionAttempts: 0, metadataQueries: 0 };
  const queryContexts = [], metadataCalls = [];
  const injectedError = (value, phase) => value instanceof Error ? value : new Error(`Synthetic ${phase} failure`);
  const duplicate = () => Object.assign(new Error("Synthetic duplicate"), { code: "ER_DUP_ENTRY" });
  const execute = (sql, values, connection) => {
    sql = sql.replace(/\s+/g, " ").trim(); calls.push(sql);
    queryContexts.push({ connectionId: connection?.id ?? null, sql });
    const data = connection?.transaction || state;
    if (connection && /^(INSERT|UPDATE|DELETE) /.test(sql)) connection.businessSqlAttempts++;
    if (options.failSql && sql.includes(options.failSql)) throw options.businessError || new Error("Synthetic write failure");
    const kind = sql === "SELECT DATABASE() AS schema_name" ? "identity"
      : sql.includes("FROM information_schema.TABLES") ? "tables"
      : sql.includes("FROM information_schema.COLUMNS") ? "columns"
      : sql.includes("FROM information_schema.STATISTICS") ? "indexes"
      : sql.includes("FROM information_schema.KEY_COLUMN_USAGE") ? "foreignKeys"
      : sql.startsWith("SELECT feature_key,") ? "marker" : null;
    if (kind) {
      metrics.metadataQueries++; if (connection) connection.metadataQueries++;
      metadataCalls.push({ connectionId: connection?.id ?? null, kind, sql, values: [...values] });
      if (options.metadataError && (!options.metadataErrorKind || options.metadataErrorKind === kind)) throw injectedError(options.metadataError, "metadata access");
      if (kind === "identity") return [{ schema_name: Object.hasOwn(options, "schemaIdentity") ? options.schemaIdentity : metadata.schema }];
      if (kind === "tables") return structuredClone(metadata.tables.map(row => options.engine ? { ...row, ENGINE: options.engine } : row));
      if (kind === "columns") return structuredClone(metadata.columns);
      if (kind === "indexes") return structuredClone(options.missingUnique ? [] : metadata.indexes);
      if (kind === "foreignKeys") return structuredClone(metadata.foreignKeys);
    }
    if (kind === "marker" || sql.startsWith("SELECT schema_version")) {
      if (options.missingState) throw Object.assign(new Error("Missing readiness table"), { code: "ER_NO_SUCH_TABLE" });
      const locked = sql.endsWith("FOR SHARE");
      let rows = structuredClone(options.missingMarker ? [] : metadata.marker);
      if (options.duplicateMarker && rows.length) rows.push({ ...rows[0] });
      for (const row of rows) {
        if (locked && Object.hasOwn(options, "transactionSchemaVersion")) row.schema_version = options.transactionSchemaVersion;
        else if (Object.hasOwn(options, "schemaVersion")) row.schema_version = options.schemaVersion;
        if (options.unready || locked && options.unreadyInTransaction) row.backfill_complete = 0;
      }
      return locked ? rows.map(({ schema_version, backfill_complete }) => ({ schema_version, backfill_complete })) : rows;
    }
    if (sql === "SELECT @@session.time_zone AS timezone") {
      connection.timezoneReadAttempts++; connection.events.push("timezone_read");
      if (options.timezoneReadError) throw injectedError(options.timezoneReadError, "timezone read");
      return [{ timezone: Object.hasOwn(options, "timezoneReadValue") ? options.timezoneReadValue : connection.timezone }];
    }
    if (sql === "SET time_zone = '+08:00'") {
      connection.timezoneSetAttempts++; connection.events.push("timezone_set");
      // A failed acknowledgement can follow an actual session change.
      connection.timezone = "+08:00";
      if (options.timezoneSetError) throw injectedError(options.timezoneSetError, "timezone set");
      connection.timezoneSetAcknowledgements++; return {};
    }
    if (sql === "SET time_zone = ?") {
      connection.timezoneRestoreAttempts++; connection.events.push("timezone_restore");
      if (options.restoreError) throw injectedError(options.restoreError, "timezone restore");
      connection.timezone = values[0]; connection.timezoneRestoreAcknowledgements++;
      connection.events.push("timezone_restored"); return {};
    }
    if (sql.startsWith("INSERT INTO appointment_booking_requests")) {
      if (data.requests.some(row => row.hash === values[0])) throw duplicate();
      data.requests.push({ hash: values[0], payload_hash: values[1] }); return { affectedRows: 1 };
    }
    if (sql.startsWith("SELECT payload_hash")) return data.requests.filter(row => row.hash === values[0]);
    if (sql.startsWith("INSERT INTO appointments")) {
      const id = data.next++;
      data.appointments.push({ id, full_name: values[0], barangay: values[1], contact_number: values[2], email: values[3],
        purpose: values[4], preferred_date: values[5], slot_schedule: values[5], status: "pending", appointment_revision: 0 });
      return { insertId: id, affectedRows: 1 };
    }
    if (sql.startsWith("INSERT INTO appointment_reservations")) {
      if (data.slots.some(row => row.service_key === values[0] && row.slot_date === values[1] && row.slot_time === values[2].slice(0, 5))) throw duplicate();
      data.slots.push({ service_key: values[0], slot_date: values[1], slot_time: values[2].slice(0, 5), appointment_id: values[3] }); return { affectedRows: 1 };
    }
    if (sql.startsWith("UPDATE appointments SET appointment_code")) {
      data.appointments.find(row => row.id === values[1]).appointment_code = values[0]; return { affectedRows: 1 };
    }
    if (sql.startsWith("INSERT INTO notifications")) { data.notifications.push(values); return { affectedRows: 1 }; }
    if (sql.startsWith("UPDATE appointment_booking_requests")) {
      Object.assign(data.requests.find(row => row.hash === values[2]), { appointment_id: values[0], appointment_code: values[1] }); return { affectedRows: 1 };
    }
    if (sql.includes("FROM appointment_reservations WHERE service_key")) return data.slots.filter(row => row.service_key === values[0] && row.slot_date === values[1]).map(row => ({ time: row.slot_time }));
    if (sql.startsWith("SELECT") && sql.includes("FROM appointment_reservations WHERE appointment_id")) return data.slots.filter(row => row.appointment_id === Number(values[0]));
    if (sql.includes("FROM appointments WHERE id")) return data.appointments.filter(row => row.id === Number(values[0])).map(row => ({ ...row }));
    if (sql.startsWith("UPDATE appointment_reservations")) {
      const slot = data.slots.find(row => row.appointment_id === Number(values[3]));
      if (data.slots.some(row => row !== slot && row.service_key === values[0] && row.slot_date === values[1] && row.slot_time === values[2].slice(0, 5))) throw duplicate();
      Object.assign(slot, { service_key: values[0], slot_date: values[1], slot_time: values[2].slice(0, 5) }); return { affectedRows: 1 };
    }
    if (sql.startsWith("DELETE FROM appointment_reservations")) { data.slots = data.slots.filter(row => row.appointment_id !== Number(values[0])); return { affectedRows: 1 }; }
    if (sql.startsWith("UPDATE appointments SET status")) {
      const row = data.appointments.find(row => row.id === Number(values.at(-3)));
      if (row.status !== values.at(-2) || row.slot_schedule !== values.at(-1)) return { affectedRows: 0 };
      let index = 0;
      for (const set of sql.split(" SET ")[1].split(" WHERE ")[0].split(", ")) {
        const field = set.match(/^(\w+) = \?$/)?.[1];
        if (field) { row[field] = values[index++]; if (field === "preferred_date") row.slot_schedule = row[field]; }
        else if (set === "appointment_revision = appointment_revision + 1") row.appointment_revision++;
        else if (set === "assigned_at = NOW()") row.assigned_at = options.databaseNow || "2026-11-20 10:00:00";
        else if (set === "updated_at = NOW()") row.updated_at = "2026-11-20 10:00:00";
        else if (set === "orientation_status = 'approved'") row.orientation_status = "approved";
        else if (set === "orientation_qr_status = 'generated'") row.orientation_qr_status = "generated";
        else throw new Error(`Unhandled MODEL assignment: ${set}`);
      }
      return { affectedRows: 1 };
    }
    throw new Error(`Unhandled MODEL SQL: ${sql}`);
  };
  const callbackQuery = connection => (sql, values, callback) => {
    if (typeof values === "function") { callback = values; values = []; }
    try { callback(null, execute(sql, values || [], connection)); } catch (error) { callback(error); }
  };
  const db = { query: callbackQuery(null), getConnection(callback) {
    metrics.acquisitionAttempts++;
    if (options.acquireError) return callback(injectedError(options.acquireError, "connection acquisition"));
    let connection = options.reuseConnections ? idle.shift() : null;
    if (!connection) {
      connection = { id: connections.length + 1, timezone: options.originalTimezone || "SYSTEM", transaction: null, unlock: null,
      poolState: "new", released: false, destroyed: false, events: [], checkoutCount: 0, metadataQueries: 0,
      timezoneReadAttempts: 0, timezoneSetAttempts: 0, timezoneSetAcknowledgements: 0,
      timezoneRestoreAttempts: 0, timezoneRestoreAcknowledgements: 0, businessSqlAttempts: 0,
      beginAttempts: 0, beginAcknowledgements: 0, rollbackAttempts: 0, rollbackAcknowledgements: 0,
      commitAttempts: 0, commitAcknowledgements: 0, committed: false, transactionUnresolved: false,
      releaseCount: 0, destroyCount: 0, unresolvedAtCleanup: false,
      beginTransaction(done) {
        this.beginAttempts++; this.events.push("begin");
        const previous = tail; tail = new Promise(resolve => { this.unlock = resolve; });
        previous.then(() => {
          this.transaction = structuredClone(state); this.transactionUnresolved = true; this.committed = false;
          // Model a BEGIN that reached the server but whose acknowledgement failed.
          if (options.beginError) return done(injectedError(options.beginError, "begin"));
          this.beginAcknowledgements++; this.events.push("begun"); done();
        });
      },
      commit(done) {
        this.commitAttempts++; this.events.push("commit");
        const failure = options.commitError || options.commitUncertain;
        if (!failure || options.commitPersisted !== false) {
          state = this.transaction; this.transaction = null; this.transactionUnresolved = false; this.committed = true;
        }
        if (failure) {
          options.commitUncertain = false; options.commitError = null;
          return done(failure instanceof Error ? failure : new Error("Synthetic lost commit acknowledgement"));
        }
        this.commitAcknowledgements++; this.events.push("committed");
        done();
      },
      rollback(done) {
        this.rollbackAttempts++; this.events.push("rollback");
        if (options.rollbackError) return done(injectedError(options.rollbackError, "rollback"));
        this.transaction = null; this.transactionUnresolved = false;
        this.rollbackAcknowledgements++; this.events.push("rolled_back"); done();
      },
      release() {
        this.releaseCount++; this.events.push("release"); this.unresolvedAtCleanup = this.transactionUnresolved;
        if (options.releaseError) { this.poolState = "release_failed"; throw injectedError(options.releaseError, "release"); }
        this.released = true; this.poolState = "idle"; this.unlock?.();
        if (options.reuseConnections) idle.push(this);
      },
      destroy() {
        this.destroyCount++; this.events.push("destroy"); this.unresolvedAtCleanup = this.transactionUnresolved;
        if (options.destroyError) { this.poolState = "destroy_failed"; throw injectedError(options.destroyError, "destroy"); }
        this.destroyed = true; this.poolState = "destroyed";
        // Confirmed close drops uncommitted model work; it is NOT a ROLLBACK acknowledgement.
        this.transaction = null; this.transactionUnresolved = false; this.unlock?.();
      }
      };
      connection.query = callbackQuery(connection); connections.push(connection);
    }
    connection.released = false; connection.poolState = "leased"; connection.checkoutCount++;
    leases.push(connection); callback(null, connection);
  } };
  const service = new AppointmentSchedulingService(db, { enabled: () => options.enabled !== false, now });
  return { service, db, calls, connections, leases, metrics, metadata, metadataCalls, queryContexts, get state() { return state; }, expected(id) {
    const row = state.appointments.find(row => row.id === id);
    return { expected_status: row.status, expected_schedule: row.slot_schedule, expected_revision: row.appointment_revision };
  } };
}


module.exports = { fixture, citizen, actor, requestKey, reviewedSchema, addIndex };
