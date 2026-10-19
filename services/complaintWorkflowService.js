const { resolveStrictBarangay } = require("./barangayBoundaryService");

const REQUIRED_COLUMNS = ["assignment_confirmed_by", "assignment_confirmed_at", "assignment_confirmation_reason",
  "barangay_decline_reason", "barangay_declined_by", "barangay_declined_at", "handling_owner", "wmo_resolved_by"];
const MAX_REASON_LENGTH = 2000;
const key = (value) => String(value || "").trim().toLowerCase().replace(/^(barangay|brgy\.?)\s*/i, "").replace(/[\s.-]/g, "");
function failure(statusCode, code, message) { return Object.assign(new Error(message), { statusCode, code }); }
function canonicalBarangay(value, rows) {
  const matches = [...new Set((rows || []).map((row) => String(row.barangay_name || "").trim()).filter(Boolean))]
    .filter((name) => key(name) === key(value));
  return matches.length === 1 ? matches[0] : "";
}
function query(db, sql, values = []) {
  return new Promise((resolve, reject) => db.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows)));
}
function call(connection, method) { return new Promise((resolve, reject) => connection[method]((error) => error ? reject(error) : resolve())); }
function connectionFor(db) { return new Promise((resolve, reject) => db.getConnection((error, connection) => error ? reject(error) : resolve(connection))); }
function id(value) { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw failure(400, "INVALID_ID", "Invalid complaint ID."); return number; }
function reason(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > MAX_REASON_LENGTH) {
    throw failure(400, "REASON_REQUIRED", `A reason of 1–${MAX_REASON_LENGTH} characters is required.`);
  }
  return value.trim();
}

class ComplaintWorkflowService {
  constructor(db) { this.db = db; }
  async checkSchema(db = this.db) {
    const columns = await query(db, "SHOW COLUMNS FROM complaints");
    if (REQUIRED_COLUMNS.some((name) => !columns.some((column) => column.Field === name))) {
      throw failure(503, "COMPLAINT_FEATURE_UNAVAILABLE", "Complaint workflow migration has not been applied. No action was saved.");
    }
  }
  async activeBarangays(db = this.db) {
    return query(db, "SELECT barangay_name, polygon_json FROM barangay_boundaries WHERE status = 'active'");
  }
  async barangayActor(userId) {
    const rows = await query(this.db, "SELECT id, role, mobile_role, status, barangay, assigned_source_name FROM users WHERE id = ? LIMIT 1", [id(userId)]);
    const user = rows[0];
    if (!user || user.role !== "barangay" || String(user.status).toLowerCase() !== "active"
      || (user.mobile_role && String(user.mobile_role).trim().toLowerCase() !== "barangay")) {
      throw failure(403, "BARANGAY_FORBIDDEN", "An active Barangay account is required.");
    }
    const names = await this.activeBarangays();
    const values = [user.barangay, user.assigned_source_name].filter((value) => String(value || "").trim());
    const canonical = values.map((value) => canonicalBarangay(value, names));
    if (!canonical.length || canonical.some((value) => !value || value !== canonical[0])) {
      throw failure(403, "BARANGAY_ASSIGNMENT_UNVERIFIED", "The account assignment needs Admin verification.");
    }
    return { id: user.id, kind: "barangay", barangay: canonical[0] };
  }
  async transact(complaintId, operation) {
    const complaintKey = id(complaintId);
    await this.checkSchema();
    const connection = await connectionFor(this.db);
    try {
      await call(connection, "beginTransaction");
      const rows = await query(connection, "SELECT * FROM complaints WHERE id = ? FOR UPDATE", [complaintKey]);
      if (!rows.length) throw failure(404, "COMPLAINT_NOT_FOUND", "Complaint not found.");
      const result = await operation(connection, rows[0]);
      await call(connection, "commit");
      return result;
    } catch (error) {
      try { await call(connection, "rollback"); } catch (_) { /* Preserve original error, never claim success. */ }
      throw error;
    } finally { connection.release(); }
  }
  async notice(connection, complaintId, targetType, targetName, type) {
    await query(connection, `INSERT INTO complaint_notifications
      (complaint_id, target_type, target_name, notification_type, title, message, is_read)
      VALUES (?, ?, ?, ?, ?, ?, 0)`, [complaintId, targetType, targetName, type,
      type === "barangay_cannot_accept" ? "Complaint requires WMO handling" : "Complaint workflow update",
      `Complaint #${complaintId} requires review in the protected complaint workflow.`]);
  }
  async update(connection, sql, values) {
    const result = await query(connection, sql, values);
    if (!result || result.affectedRows !== 1) throw failure(409, "STALE_COMPLAINT", "Complaint state changed; no successful action was recorded.");
  }
  async verifyRecipient(connection, complaint, actor) {
    if (actor.kind !== "barangay" || key(actor.barangay) !== key(complaint.assigned_barangay)) {
      throw failure(403, "WRONG_BARANGAY", "This complaint is not assigned to your barangay.");
    }
    const targets = await query(connection, "SELECT DISTINCT target_name FROM complaint_notifications WHERE complaint_id = ? AND target_type = 'barangay'", [complaint.id]);
    if (!complaint.assignment_confirmed_at || targets.length !== 1 || key(targets[0].target_name) !== key(complaint.assigned_barangay)) {
      throw failure(409, "ASSIGNMENT_REVIEW_REQUIRED", "Legacy or conflicting assignment requires Admin correction.");
    }
  }
  async forward(complaintId, actor, body = {}) {
    if (actor.kind !== "admin") throw failure(403, "ADMIN_REQUIRED", "Admin authorization is required.");
    const supplied = [body.selected_barangay, body.target_barangays, body.selected_barangays, body.forwarding_barangays].filter((value) => value !== undefined);
    const targets = supplied.flatMap((value) => Array.isArray(value) ? value : [value]);
    if (!targets.length || targets.some((value) => typeof value !== "string" || !value.trim())
      || new Set(targets.map(key)).size !== 1 || supplied.some((value) => Array.isArray(value) && value.length !== 1)) {
      throw failure(400, "ONE_BARANGAY_REQUIRED", "Explicitly confirm exactly one active barangay.");
    }
    if (body.confirm_assignment !== true) throw failure(400, "CONFIRMATION_REQUIRED", "Admin assignment confirmation is required.");
    return this.transact(complaintId, async (connection, complaint) => {
      const boundaries = await this.activeBarangays(connection);
      const target = canonicalBarangay(targets[0], boundaries);
      if (!target) throw failure(400, "UNKNOWN_BARANGAY", "Choose one real active barangay.");
      if (complaint.status === "forwarded" && complaint.assignment_confirmed_at
        && complaint.assignment_confirmed_by === actor.id && key(complaint.assigned_barangay) === key(target)) {
        const existing = await query(connection, "SELECT DISTINCT target_name FROM complaint_notifications WHERE complaint_id = ? AND target_type = 'barangay'", [complaint.id]);
        if (existing.length !== 1 || key(existing[0].target_name) !== key(target)) {
          throw failure(409, "ASSIGNMENT_REVIEW_REQUIRED", "Conflicting forwarding history requires Admin correction.");
        }
        return { success: true, complaint_id: complaint.id, status: "forwarded", assigned_barangay: target, idempotent: true };
      }
      if (complaint.status !== "pending") throw failure(409, "STALE_COMPLAINT", "Only pending complaints can be validated and forwarded.");
      const geographic = resolveStrictBarangay({ lat: complaint.latitude, lng: complaint.longitude }, boundaries);
      // Boundary provenance is not attested by the current schema: Admin confirmation is always recorded.
      if (body.use_gps_match === true && (!geographic.barangay || geographic.barangay !== target || geographic.barangay !== targets[0])) {
        throw failure(409, "GPS_ASSIGNMENT_REVIEW_REQUIRED", "No unchanged unique active polygon match. Admin review is required; nothing was forwarded.");
      }
      const confirmationReason = body.use_gps_match === true
        ? "Admin confirmed forwarding to the unique active polygon match for the stored citizen GPS coordinates. Polygon provenance has not been independently verified."
        : reason(body.assignment_confirmation_reason);
      const notices = await query(connection, "SELECT DISTINCT target_name FROM complaint_notifications WHERE complaint_id = ? AND target_type = 'barangay'", [complaint.id]);
      if (notices.length) throw failure(409, "LEGACY_TARGETS_PRESENT", "Existing forwarding targets require Admin correction; no history was changed.");
      await this.update(connection, `UPDATE complaints SET status = 'forwarded', assigned_barangay = ?,
        assignment_method = 'admin_confirmed', validated_by = ?, validated_at = NOW(),
        assignment_confirmed_by = ?, assignment_confirmed_at = NOW(), assignment_confirmation_reason = ?, handling_owner = 'barangay'
        WHERE id = ? AND status = 'pending'`, [target, actor.id, actor.id, confirmationReason, complaint.id]);
      await this.notice(connection, complaint.id, "barangay", target, "forwarded");
      return { success: true, complaint_id: complaint.id, status: "forwarded", assigned_barangay: target,
        forwarded_to_barangays: [target], notification_targets_created: 1, assignment_method: "admin_confirmed",
        geographic_candidate: geographic.barangay || null, assignment_confirmed: true, handling_owner: "barangay" };
    });
  }
  async decide(complaintId, actor, decision, body = {}) {
    if (!["accept", "cannot_accept"].includes(decision)) throw failure(400, "INVALID_DECISION", "Invalid decision.");
    const declineReason = decision === "cannot_accept" ? reason(body.reason) : null;
    return this.transact(complaintId, async (connection, complaint) => {
      await this.verifyRecipient(connection, complaint, actor);
      const sameAccept = decision === "accept" && complaint.status === "in_progress" && complaint.handling_owner === "barangay"
        && complaint.accepted_by === actor.id;
      const sameDecline = decision === "cannot_accept" && complaint.status === "wmo_handling"
        && complaint.barangay_declined_by === actor.id && complaint.barangay_decline_reason === declineReason;
      if (sameAccept || sameDecline) return { success: true, complaint_id: complaint.id, status: complaint.status,
        assigned_barangay: complaint.assigned_barangay, handling_owner: complaint.handling_owner, idempotent: true };
      if (complaint.status !== "forwarded" || complaint.barangay_declined_at || complaint.accepted_at) {
        throw failure(409, "DECISION_CONFLICT", "A decision has already been recorded. No changes were saved.");
      }
      if (decision === "accept") {
        await this.update(connection, `UPDATE complaints SET status = 'in_progress', handling_owner = 'barangay',
          accepted_by = ?, accepted_at = NOW(), in_progress_at = NOW() WHERE id = ? AND status = 'forwarded'`, [actor.id, complaint.id]);
      } else {
        await this.update(connection, `UPDATE complaints SET status = 'wmo_handling', handling_owner = 'wmo',
          barangay_decline_reason = ?, barangay_declined_by = ?, barangay_declined_at = NOW()
          WHERE id = ? AND status = 'forwarded'`, [declineReason, actor.id, complaint.id]);
      }
      await this.notice(connection, complaint.id, "wmo", "WMO", decision === "accept" ? "barangay_accepted" : "barangay_cannot_accept");
      return { success: true, complaint_id: complaint.id, status: decision === "accept" ? "in_progress" : "wmo_handling",
        assigned_barangay: complaint.assigned_barangay, handling_owner: decision === "accept" ? "barangay" : "wmo" };
    });
  }
  async resolve(complaintId, actor, body, saveEvidence) {
    const report = reason(body.resolution_report);
    const coordinate = (value, limit) => {
      if (value === undefined || value === null || value === "") return null;
      if ((typeof value !== "number" && typeof value !== "string") || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > limit) {
        throw failure(400, "INVALID_RESOLVER_COORDINATES", "Invalid resolution GPS coordinates.");
      }
      return Number(value);
    };
    const latitude = coordinate(body.resolver_latitude, 90), longitude = coordinate(body.resolver_longitude, 180);
    return this.transact(complaintId, async (connection, complaint) => {
      if (actor.kind === "admin") {
        if (complaint.status !== "wmo_handling" || complaint.handling_owner !== "wmo") {
          throw failure(409, "WMO_OWNERSHIP_REQUIRED", "Only a WMO-owned declined complaint can be resolved by Admin.");
        }
      } else {
        await this.verifyRecipient(connection, complaint, actor);
        if (complaint.status !== "in_progress" || complaint.handling_owner !== "barangay" || !complaint.accepted_at) {
          throw failure(409, "ACCEPT_REQUIRED", "Explicitly accept this complaint before submitting resolution.");
        }
      }
      const imageUrl = await saveEvidence();
      if (!imageUrl) throw failure(400, "EVIDENCE_REQUIRED", "Resolution photo evidence is required.");
      await this.update(connection, `UPDATE complaints SET status = 'resolved', resolution_report = ?, resolution_evidence_url = ?,
        resolved_at = NOW(), resolved_by = ?, wmo_resolved_by = ?, handled_by_barangay_name = ?,
        resolver_latitude = COALESCE(?, resolver_latitude), resolver_longitude = COALESCE(?, resolver_longitude) WHERE id = ?`,
      [report, imageUrl, actor.kind === "barangay" ? actor.id : null, actor.kind === "admin" ? actor.id : null,
        actor.kind === "admin" ? "WMO" : actor.barangay, latitude, longitude, complaint.id]);
      await this.notice(connection, complaint.id, "wmo", "WMO", "complaint_resolved");
      return { success: true, complaint_id: complaint.id, status: "resolved", assigned_barangay: complaint.assigned_barangay,
        handling_owner: complaint.handling_owner, evidence_url: imageUrl };
    });
  }
}
module.exports = { ComplaintWorkflowService, REQUIRED_COLUMNS, MAX_REASON_LENGTH, canonicalBarangay, key, query, failure };
