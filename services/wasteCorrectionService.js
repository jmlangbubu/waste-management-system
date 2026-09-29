const CATEGORY_FIELDS = Object.freeze([
  "biodegradable_subtotal",
  "recyclable_subtotal",
  "residual_subtotal",
  "special_subtotal"
]);
const SNAPSHOT_FIELDS = Object.freeze([...CATEGORY_FIELDS, "grand_total"]);
const ACTIVE_STATUSES = Object.freeze(["pending", "approved"]);
const REQUEST_STATUSES = new Set(["pending", "approved", "rejected", "applied", "cancelled"]);
const MAX_CENTS = 9999999999;
const { hasWebCapability } = require("../config/webRoleCapabilities");

class WasteCorrectionError extends Error {
  constructor(message, statusCode = 400, code = "WASTE_CORRECTION_INVALID") {
    super(message);
    this.name = "WasteCorrectionError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new WasteCorrectionError(`${label} must be a positive integer.`);
  }
  return id;
}

function actorIdentity(actor) {
  return {
    id: positiveId(actor?.id, "Authenticated user ID"),
    role: String(actor?.role || "").trim().toLowerCase().replace(/[\s-]+/g, "_")
  };
}

function requireActorCapability(actor, capability) {
  const identity = actorIdentity(actor);
  if (!hasWebCapability(identity.role, capability)) {
    throw new WasteCorrectionError("This Web Admin account is not authorized for this operation.", 403, "WEB_CAPABILITY_FORBIDDEN");
  }
  return identity;
}

function requiredText(value, label, maxLength = 1000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new WasteCorrectionError(`${label} is required.`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new WasteCorrectionError(`${label} must be ${maxLength} characters or fewer.`);
  }
  return text;
}

function amountToCents(value, label) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new WasteCorrectionError(`${label} must be a non-negative amount with at most two decimals.`);
  }
  const text = String(value);
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(text)) {
    throw new WasteCorrectionError(`${label} must be a non-negative amount with at most two decimals.`);
  }
  const [whole, fractional = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fractional.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) {
    throw new WasteCorrectionError(`${label} exceeds the supported amount.`);
  }
  return cents;
}

function centsToAmount(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function snapshotFromRecord(row) {
  const snapshot = {};
  for (const field of SNAPSHOT_FIELDS) {
    snapshot[field] = centsToAmount(amountToCents(row[field], field));
  }
  return snapshot;
}

function parseSnapshot(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new WasteCorrectionError("Stored correction snapshot is invalid.", 500, "WASTE_CORRECTION_SNAPSHOT_INVALID");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join("|") !== [...SNAPSHOT_FIELDS].sort().join("|")) {
    throw new WasteCorrectionError("Stored correction snapshot is invalid.", 500, "WASTE_CORRECTION_SNAPSHOT_INVALID");
  }
  try {
    const normalized = {};
    for (const field of SNAPSHOT_FIELDS) {
      normalized[field] = centsToAmount(amountToCents(parsed[field], field));
    }
    // Historical originals may have an inconsistent stored total. It remains
    // evidence in the old snapshot; approved new totals are checked on apply.
    return normalized;
  } catch (error) {
    if (error instanceof WasteCorrectionError && error.statusCode === 500) throw error;
    throw new WasteCorrectionError("Stored correction snapshot is invalid.", 500, "WASTE_CORRECTION_SNAPSHOT_INVALID");
  }
}

function proposedSnapshot(original, proposedChanges) {
  if (!proposedChanges || typeof proposedChanges !== "object" || Array.isArray(proposedChanges)) {
    throw new WasteCorrectionError("proposedChanges must contain allowed waste subtotals.");
  }
  const fields = Object.keys(proposedChanges);
  if (!fields.length || fields.some((field) => !CATEGORY_FIELDS.includes(field))) {
    throw new WasteCorrectionError("proposedChanges contains no valid changes or an unsupported field.");
  }
  const proposed = { ...original };
  for (const field of fields) {
    proposed[field] = centsToAmount(amountToCents(proposedChanges[field], field));
  }
  if (CATEGORY_FIELDS.every((field) => proposed[field] === original[field])) {
    throw new WasteCorrectionError("At least one waste subtotal must change.");
  }
  const totalCents = CATEGORY_FIELDS.reduce((sum, field) => sum + amountToCents(proposed[field], field), 0);
  if (totalCents > MAX_CENTS) {
    throw new WasteCorrectionError("Corrected grand total exceeds the supported amount.");
  }
  proposed.grand_total = centsToAmount(totalCents);
  return proposed;
}

function snapshotsEqual(left, right) {
  return SNAPSHOT_FIELDS.every((field) => left[field] === right[field]);
}

function parseRequestRow(row) {
  return {
    ...row,
    original_values: parseSnapshot(row.original_values),
    proposed_values: parseSnapshot(row.proposed_values)
  };
}

class WasteCorrectionService {
  constructor(database) {
    this.db = database || require("../config/dbPromise");
  }

  async withTransaction(callback) {
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();
      const result = await callback(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error("Waste correction rollback failed:", rollbackError);
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async request(recordIdValue, actor, body = {}) {
    const recordId = positiveId(recordIdValue, "Waste record ID");
    const requester = requireActorCapability(actor, "waste.correction.request");
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        ["grand_total", "validation_status", "barangay_name"].some((field) =>
          Object.prototype.hasOwnProperty.call(body, field))) {
      throw new WasteCorrectionError("Request contains an unsupported official field.");
    }
    const reason = requiredText(body.reason, "Correction reason");
    return this.withTransaction(async (connection) => {
      // Every request for this record locks the same parent row before checking
      // active requests, serializing competing request submissions.
      const [records] = await connection.query(
        `SELECT id, validation_status, ${SNAPSHOT_FIELDS.join(", ")}
         FROM validated_waste_records WHERE id = ? LIMIT 1 FOR UPDATE`,
        [recordId]
      );
      const record = records[0];
      if (!record) throw new WasteCorrectionError("Validated waste record not found.", 404);
      if (String(record.validation_status || "").trim().toLowerCase() !== "validated") {
        throw new WasteCorrectionError("Only validated waste records may be corrected.", 409);
      }
      const [active] = await connection.query(
        `SELECT id FROM waste_record_correction_requests
         WHERE waste_record_id = ? AND status IN (?, ?) LIMIT 1`,
        [recordId, ...ACTIVE_STATUSES]
      );
      if (active.length) {
        throw new WasteCorrectionError("An active correction request already exists for this record.", 409, "WASTE_CORRECTION_ACTIVE");
      }
      const original = snapshotFromRecord(record);
      const proposed = proposedSnapshot(original, body.proposedChanges);
      const [result] = await connection.query(
        `INSERT INTO waste_record_correction_requests
         (waste_record_id, requested_by_user_id, requested_by_role, reason,
          original_values, proposed_values, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        [recordId, requester.id, requester.role, reason, JSON.stringify(original), JSON.stringify(proposed)]
      );
      return { id: result.insertId, waste_record_id: recordId, status: "pending", original_values: original, proposed_values: proposed };
    });
  }

  async review(requestIdValue, actor, body = {}) {
    const requestId = positiveId(requestIdValue, "Correction request ID");
    const reviewer = requireActorCapability(actor, "waste.correction.review");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new WasteCorrectionError("Review decision is required.");
    }
    if (!new Set(["approve", "reject"]).has(body.decision)) {
      throw new WasteCorrectionError("Decision must be approve or reject.");
    }
    const decisionReason = body.decision === "reject"
      ? requiredText(body.decisionReason, "Rejection reason")
      : body.decisionReason == null || body.decisionReason === ""
        ? null
        : requiredText(body.decisionReason, "Decision reason");
    return this.withTransaction(async (connection) => {
      const [rows] = await connection.query(
        "SELECT id, requested_by_user_id, status FROM waste_record_correction_requests WHERE id = ? LIMIT 1 FOR UPDATE",
        [requestId]
      );
      const request = rows[0];
      if (!request) throw new WasteCorrectionError("Correction request not found.", 404);
      if (Number(request.requested_by_user_id) === reviewer.id) {
        throw new WasteCorrectionError("The requester cannot review their own correction.", 403, "WASTE_CORRECTION_SELF_REVIEW");
      }
      if (request.status !== "pending") {
        throw new WasteCorrectionError("Only pending requests may be reviewed.", 409);
      }
      const status = body.decision === "approve" ? "approved" : "rejected";
      await connection.query(
        `UPDATE waste_record_correction_requests
         SET status = ?, reviewed_by_user_id = ?, reviewed_by_role = ?,
             decision_reason = ?, reviewed_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [status, reviewer.id, reviewer.role, decisionReason, requestId]
      );
      return { id: requestId, status };
    });
  }

  async cancel(requestIdValue, actor, body = {}) {
    const requestId = positiveId(requestIdValue, "Correction request ID");
    const canceller = requireActorCapability(actor, "waste.correction.request");
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "reason")) {
      throw new WasteCorrectionError("Cancellation accepts only a reason.");
    }
    const reason = requiredText(body.reason, "Cancellation reason");
    return this.withTransaction(async (connection) => {
      const [rows] = await connection.query(
        `SELECT id, requested_by_user_id, status
         FROM waste_record_correction_requests WHERE id = ? LIMIT 1 FOR UPDATE`,
        [requestId]
      );
      const request = rows[0];
      if (!request) throw new WasteCorrectionError("Correction request not found.", 404);
      if (canceller.role !== "super_admin" && Number(request.requested_by_user_id) !== canceller.id) {
        throw new WasteCorrectionError("Only the original requester or Super Admin may cancel this request.", 403);
      }
      if (!ACTIVE_STATUSES.includes(request.status)) {
        throw new WasteCorrectionError("Only pending or approved requests may be cancelled.", 409);
      }
      await connection.query(
        `UPDATE waste_record_correction_requests
         SET status = 'cancelled', cancelled_by_user_id = ?, cancelled_by_role = ?,
             cancel_reason = ?, cancelled_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [canceller.id, canceller.role, reason, requestId]
      );
      return { id: requestId, status: "cancelled" };
    });
  }

  async apply(requestIdValue, actor, body = {}) {
    const requestId = positiveId(requestIdValue, "Correction request ID");
    const applier = requireActorCapability(actor, "waste.correction.apply");
    if (body && Object.keys(body).length) {
      throw new WasteCorrectionError("Apply does not accept replacement values or actor fields.");
    }
    return this.withTransaction(async (connection) => {
      const [references] = await connection.query(
        "SELECT waste_record_id FROM waste_record_correction_requests WHERE id = ? LIMIT 1",
        [requestId]
      );
      if (!references[0]) throw new WasteCorrectionError("Correction request not found.", 404);
      const recordId = positiveId(references[0].waste_record_id, "Waste record ID");
      // Lock record before request, matching request creation's lock order.
      const [records] = await connection.query(
        `SELECT id, validation_status, ${SNAPSHOT_FIELDS.join(", ")}
         FROM validated_waste_records WHERE id = ? LIMIT 1 FOR UPDATE`,
        [recordId]
      );
      if (!records[0]) throw new WasteCorrectionError("Validated waste record not found.", 404);
      const [requests] = await connection.query(
        "SELECT * FROM waste_record_correction_requests WHERE id = ? LIMIT 1 FOR UPDATE",
        [requestId]
      );
      const request = requests[0];
      if (!request || Number(request.waste_record_id) !== recordId || request.status !== "approved") {
        throw new WasteCorrectionError("Only an approved, unapplied correction may be applied.", 409);
      }
      if (String(records[0].validation_status || "").trim().toLowerCase() !== "validated") {
        throw new WasteCorrectionError("Waste record is no longer validated.", 409);
      }
      const current = snapshotFromRecord(records[0]);
      const original = parseSnapshot(request.original_values);
      if (!snapshotsEqual(current, original)) {
        throw new WasteCorrectionError("Waste record changed since the correction was requested.", 409, "WASTE_CORRECTION_STALE");
      }
      const approved = parseSnapshot(request.proposed_values);
      const finalValues = proposedSnapshot(original, Object.fromEntries(
        CATEGORY_FIELDS.map((field) => [field, approved[field]])
      ));
      if (!snapshotsEqual(approved, finalValues)) {
        throw new WasteCorrectionError("Approved correction payload is invalid.", 409);
      }
      await connection.query(
        `UPDATE validated_waste_records SET
          biodegradable_subtotal = ?, recyclable_subtotal = ?,
          residual_subtotal = ?, special_subtotal = ?, grand_total = ?
         WHERE id = ?`,
        [...SNAPSHOT_FIELDS.map((field) => finalValues[field]), recordId]
      );
      await connection.query(
        `INSERT INTO waste_record_correction_audit
         (waste_record_id, correction_request_id, old_values, new_values, reason,
          requested_by_user_id, approved_by_user_id, applied_by_user_id,
          requested_by_role, approved_by_role, applied_by_role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [recordId, requestId, JSON.stringify(current), JSON.stringify(finalValues), request.reason,
          request.requested_by_user_id, request.reviewed_by_user_id, applier.id,
          request.requested_by_role, request.reviewed_by_role, applier.role]
      );
      await connection.query(
        `UPDATE waste_record_correction_requests
         SET status = 'applied', applied_by_user_id = ?, applied_by_role = ?,
             applied_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
        [applier.id, applier.role, requestId]
      );
      return { id: requestId, waste_record_id: recordId, status: "applied", applied_values: finalValues };
    });
  }

  async list(options = {}, actor) {
    requireActorCapability(actor, "waste.correction.view");
    const conditions = [];
    const params = [];
    if (options.status != null && options.status !== "") {
      if (!REQUEST_STATUSES.has(options.status)) throw new WasteCorrectionError("Invalid correction status filter.");
      conditions.push("c.status = ?");
      params.push(options.status);
    }
    if (options.recordId != null && options.recordId !== "") {
      conditions.push("c.waste_record_id = ?");
      params.push(positiveId(options.recordId, "Waste record ID"));
    }
    const [rows] = await this.db.query(
      `SELECT c.*, w.barangay_name, w.establishment_name,
              requester.full_name AS requested_by_name,
              reviewer.full_name AS reviewed_by_name,
              applier.full_name AS applied_by_name,
              canceller.full_name AS cancelled_by_name
       FROM waste_record_correction_requests c
       JOIN validated_waste_records w ON w.id = c.waste_record_id
       LEFT JOIN web_users requester ON requester.id = c.requested_by_user_id
       LEFT JOIN web_users reviewer ON reviewer.id = c.reviewed_by_user_id
       LEFT JOIN web_users applier ON applier.id = c.applied_by_user_id
       LEFT JOIN web_users canceller ON canceller.id = c.cancelled_by_user_id
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY c.created_at DESC, c.id DESC ${options.recordId ? "" : "LIMIT 100"}`,
      params
    );
    return rows.map(parseRequestRow);
  }

  async history(recordIdValue, actor) {
    requireActorCapability(actor, "waste.correction.view");
    const recordId = positiveId(recordIdValue, "Waste record ID");
    const [rows] = await this.db.query(
      `SELECT a.*, requester.full_name AS requested_by_name,
              reviewer.full_name AS approved_by_name,
              applier.full_name AS applied_by_name
       FROM waste_record_correction_audit a
       LEFT JOIN web_users requester ON requester.id = a.requested_by_user_id
       LEFT JOIN web_users reviewer ON reviewer.id = a.approved_by_user_id
       LEFT JOIN web_users applier ON applier.id = a.applied_by_user_id
       WHERE a.waste_record_id = ? ORDER BY a.created_at DESC, a.id DESC`,
      [recordId]
    );
    return rows.map((row) => ({
      ...row,
      old_values: parseSnapshot(row.old_values),
      new_values: parseSnapshot(row.new_values)
    }));
  }
}

module.exports = {
  WasteCorrectionService,
  WasteCorrectionError,
  CATEGORY_FIELDS,
  SNAPSHOT_FIELDS,
  amountToCents,
  proposedSnapshot,
  snapshotFromRecord
};
