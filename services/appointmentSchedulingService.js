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

class AppointmentSchedulingService {
  constructor(db, { enabled = () => process.env.APPOINTMENT_RESERVATIONS_ENABLED === "true", now = () => new Date() } = {}) {
    this.db = db; this.enabled = enabled; this.now = now;
  }
  async ready(db = this.db) {
    if (!this.enabled()) throw unavailable();
    // No runtime DDL or automatic backfill. An operator must explicitly attest rollout readiness.
    const rows = await query(db, "SELECT schema_version, backfill_complete FROM appointment_feature_state WHERE feature_key = 'service_slots'");
    if (rows.length !== 1 || Number(rows[0].schema_version) !== 1 || Number(rows[0].backfill_complete) !== 1) throw unavailable();
    const tables = await query(db, `SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('appointments', 'appointment_reservations', 'appointment_booking_requests', 'appointment_feature_state', 'notifications')`);
    if (tables.length !== 5 || tables.some(row => row.ENGINE !== "InnoDB")) throw unavailable();
    for (const [table, required] of [["appointment_reservations", ["service_key", "appointment_date", "appointment_time"]],
      ["appointment_reservations", ["appointment_id"]], ["appointment_booking_requests", ["request_hash"]]]) {
      const indexes = await query(db, `SHOW INDEX FROM ${table}`);
      const groups = new Map();
      for (const row of indexes) if (Number(row.Non_unique) === 0) {
        if (!groups.has(row.Key_name)) groups.set(row.Key_name, []);
        groups.get(row.Key_name)[Number(row.Seq_in_index) - 1] = row.Column_name;
      }
      if (![...groups.values()].some(columns => JSON.stringify(columns) === JSON.stringify(required))) throw unavailable();
    }
    const columns = await query(db, "SHOW COLUMNS FROM appointments LIKE 'appointment_revision'");
    if (columns.length !== 1 || !/^bigint/i.test(columns[0].Type) || columns[0].Null !== "NO") throw unavailable();
    const dateColumns = await query(db, "SHOW COLUMNS FROM appointments LIKE 'preferred_date'");
    if (dateColumns.length !== 1 || !/^datetime\b/i.test(dateColumns[0].Type)) throw unavailable();
    const links = await query(db, `SELECT TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('appointment_reservations', 'appointment_booking_requests')
      AND COLUMN_NAME = 'appointment_id' AND REFERENCED_TABLE_NAME = 'appointments' AND REFERENCED_COLUMN_NAME = 'id'`);
    if (new Set(links.map(row => row.TABLE_NAME)).size !== 2) throw unavailable();
  }
  async transaction(operation) {
    // An off flag cannot prove that this database was never activated. Every writer
    // requires the same schema/backfill protocol; there is no legacy write fallback.
    await this.ready();
    const connection = await new Promise((resolve, reject) => this.db.getConnection((error, db) => error ? reject(error) : resolve(db)));
    let previousTimezone;
    const lifecycle = { setup: "pending", begin: "pending", operation: "pending",
      commit: "pending", rollback: "pending", restore: "pending", unsafe: false };
    try {
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
      if (state.length !== 1 || Number(state[0].schema_version) !== 1 || Number(state[0].backfill_complete) !== 1) throw unavailable();
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
    await this.ready();
    const rows = await query(this.db, `SELECT TIME_FORMAT(appointment_time, '%H:%i') AS time
      FROM appointment_reservations WHERE service_key = ? AND appointment_date = ?`, [key, date]);
    const occupied = new Set(rows.map(row => row.time)), now = policy.manilaNow(this.now());
    return { success: true, service, date, timezone: "Asia/Manila", slots: policy.TIMES.map(time => ({ time,
      status: `${date} ${time}:00` <= now ? "past" : occupied.has(time) ? "occupied" : "available" })) };
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
