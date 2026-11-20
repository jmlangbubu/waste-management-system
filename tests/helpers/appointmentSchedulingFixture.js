"use strict";
const { AppointmentSchedulingService } = require("../../services/appointmentSchedulingService");
const now = () => new Date("2026-11-20T02:00:00Z");
const citizen = { full_name: "Synthetic Citizen", barangay: "Apopong", email: "synthetic@example.invalid",
  contact_number: "09123456789", purpose: "Accreditation", preferred_date: "2026-11-23 10:00:00", notes: "" };
const actor = { id: 8, role: "clerk_admin", full_name: "Authenticated Clerk" };
const requestKey = suffix => `synthetic-request-key-${suffix}`;

// Explicitly a transaction MODEL, not MySQL. Serializing model transactions exercises
// stale-snapshot/retry/rollback outcomes but does not prove InnoDB locking or SQL compatibility.
function fixture(options = {}) {
  let state = { next: 1, appointments: [], slots: [], requests: [], notifications: [] };
  let tail = Promise.resolve();
  const calls = [], connections = [], leases = [], idle = [];
  const metrics = { acquisitionAttempts: 0 };
  const injectedError = (value, phase) => value instanceof Error ? value : new Error(`Synthetic ${phase} failure`);
  const duplicate = () => Object.assign(new Error("Synthetic duplicate"), { code: "ER_DUP_ENTRY" });
  const execute = (sql, values, connection) => {
    sql = sql.replace(/\s+/g, " ").trim(); calls.push(sql);
    const data = connection?.transaction || state;
    if (connection && /^(INSERT|UPDATE|DELETE) /.test(sql)) connection.businessSqlAttempts++;
    if (options.failSql && sql.includes(options.failSql)) throw options.businessError || new Error("Synthetic write failure");
    if (sql.startsWith("SELECT schema_version")) {
      if (options.missingState) throw Object.assign(new Error("Missing readiness table"), { code: "ER_NO_SUCH_TABLE" });
      const locked = sql.endsWith("FOR SHARE");
      return [{ schema_version: (locked && options.transactionSchemaVersion) || options.schemaVersion || 1,
        backfill_complete: options.unready || (locked && options.unreadyInTransaction) ? 0 : 1 }];
    }
    if (sql.startsWith("SELECT TABLE_NAME, ENGINE")) return ["appointments", "appointment_reservations", "appointment_booking_requests", "appointment_feature_state", "notifications"].map(TABLE_NAME => ({ TABLE_NAME, ENGINE: "InnoDB" }));
    if (sql.startsWith("SELECT ENGINE")) return [{ ENGINE: options.engine || "InnoDB" }];
    if (sql.startsWith("SELECT TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE")) return ["appointment_reservations", "appointment_booking_requests"].map(TABLE_NAME => ({ TABLE_NAME }));
    if (sql.startsWith("SHOW INDEX")) {
      if (options.missingUnique) return [];
      const keys = sql.endsWith("appointment_reservations") ? [["service_key", "appointment_date", "appointment_time"], ["appointment_id"]] : [["request_hash"]];
      return keys.flatMap((key, i) => key.map((Column_name, j) => ({ Non_unique: 0, Key_name: `key${i}`, Seq_in_index: j + 1, Column_name })));
    }
    if (sql.startsWith("SHOW COLUMNS")) return [{ Type: sql.includes("'preferred_date'") ? "datetime" : "bigint unsigned", Null: "NO" }];
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
      poolState: "new", released: false, destroyed: false, events: [], checkoutCount: 0,
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
  return { service, db, calls, connections, leases, metrics, get state() { return state; }, expected(id) {
    const row = state.appointments.find(row => row.id === id);
    return { expected_status: row.status, expected_schedule: row.slot_schedule, expected_revision: row.appointment_revision };
  } };
}


module.exports = { fixture, citizen, actor, requestKey };
