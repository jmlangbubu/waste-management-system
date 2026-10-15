const db = require("../config/dbPromise");
const {
  VehicleIssueTriageError,
  evaluateTriage,
  getAssistantSchema
} = require("../utils/vehicleIssueTriageRules");
const {
  storeVehicleIssueImage,
  deleteStoredVehicleIssueImage,
  VehicleIssueUploadError
} = require("../middleware/vehicleIssueUpload");

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const NON_TERMINAL_TICKET_STATUSES = Object.freeze([
  "prepared",
  "dispatched",
  "in_progress",
  "returning_to_wmo"
]);
const REPORT_STATUSES = new Set(["submitted", "under_review", "resolved"]);
const SEVERITIES = new Set(["low", "moderate", "critical"]);
const RESOLUTION_ACTIONS = new Set([
  "continue_operation",
  "set_for_maintenance",
  "set_out_of_service"
]);

class VehicleIssueError extends Error {
  constructor(
    message,
    statusCode = 400,
    code = "VEHICLE_ISSUE_ERROR",
    cause = null
  ) {
    super(message);
    this.name = "VehicleIssueError";
    this.statusCode = statusCode;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase();
}

function isEligibleEnforcer(user = {}) {
  return (
    normalizeRole(user.status) === "active" &&
    [user.mobile_role, user.role].some(
      (value) => normalizeRole(value) === "enforcer"
    )
  );
}

function requireEligibleEnforcer(user = {}) {
  const id = Number(user.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new VehicleIssueError(
      "Mobile authentication is required.",
      401,
      "MOBILE_SESSION_REQUIRED"
    );
  }
  if (!isEligibleEnforcer(user)) {
    throw new VehicleIssueError(
      "Only an active Enforcer may report a vehicle issue.",
      403,
      "VEHICLE_ISSUE_ENFORCER_REQUIRED"
    );
  }
  return id;
}

function requireWebActor(actor = {}) {
  const id = Number(actor.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new VehicleIssueError(
      "Web Admin authentication is required.",
      401,
      "WEB_SESSION_REQUIRED"
    );
  }
  return id;
}

function positiveId(value, label = "vehicle issue report id") {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new VehicleIssueError(
      `${label} must be a positive integer`,
      400,
      "VEHICLE_ISSUE_ID_INVALID"
    );
  }
  return id;
}

function cleanText(value, label, maxLength, options = {}) {
  if (value === undefined || value === null) {
    if (options.required) {
      throw new VehicleIssueError(
        `${label} is required`,
        400,
        options.code || "VEHICLE_ISSUE_FIELD_REQUIRED"
      );
    }
    return null;
  }
  if (!["string", "number"].includes(typeof value)) {
    throw new VehicleIssueError(
      `${label} must be text`,
      400,
      options.code || "VEHICLE_ISSUE_FIELD_INVALID"
    );
  }
  const text = String(value).trim();
  if (!text && options.required) {
    throw new VehicleIssueError(
      `${label} is required`,
      400,
      options.code || "VEHICLE_ISSUE_FIELD_REQUIRED"
    );
  }
  if (text.length > maxLength) {
    throw new VehicleIssueError(
      `${label} must not exceed ${maxLength} characters`,
      400,
      options.code || "VEHICLE_ISSUE_FIELD_TOO_LONG"
    );
  }
  return text || null;
}

function validateClientRequestId(value) {
  if (typeof value !== "string" || !CLIENT_REQUEST_ID_PATTERN.test(value.trim())) {
    throw new VehicleIssueError(
      "client_request_id must be a stable opaque identifier between 8 and 160 characters",
      400,
      "VEHICLE_ISSUE_CLIENT_REQUEST_ID_INVALID"
    );
  }
  return value.trim();
}

function sqlDateTime(date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function normalizeLocation(payload = {}) {
  const keys = [
    "latitude",
    "longitude",
    "accuracy_meters",
    "location_recorded_at"
  ];
  const provided = keys.filter(
    (key) => payload[key] !== undefined && payload[key] !== null && payload[key] !== ""
  );
  if (!provided.length) {
    return {
      latitude: null,
      longitude: null,
      accuracy_meters: null,
      location_recorded_at: null
    };
  }
  if (provided.length !== keys.length) {
    throw new VehicleIssueError(
      "latitude, longitude, accuracy_meters, and location_recorded_at must be provided together",
      400,
      "VEHICLE_ISSUE_LOCATION_INCOMPLETE"
    );
  }
  const latitude = Number(payload.latitude);
  const longitude = Number(payload.longitude);
  const accuracy = Number(payload.accuracy_meters);
  const recordedAt = new Date(payload.location_recorded_at);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new VehicleIssueError(
      "latitude must be between -90 and 90",
      400,
      "VEHICLE_ISSUE_LATITUDE_INVALID"
    );
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new VehicleIssueError(
      "longitude must be between -180 and 180",
      400,
      "VEHICLE_ISSUE_LONGITUDE_INVALID"
    );
  }
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 10000) {
    throw new VehicleIssueError(
      "accuracy_meters must be between 0 and 10000",
      400,
      "VEHICLE_ISSUE_ACCURACY_INVALID"
    );
  }
  if (Number.isNaN(recordedAt.getTime())) {
    throw new VehicleIssueError(
      "location_recorded_at must be a valid timestamp",
      400,
      "VEHICLE_ISSUE_LOCATION_TIME_INVALID"
    );
  }
  return {
    latitude,
    longitude,
    accuracy_meters: accuracy,
    location_recorded_at: sqlDateTime(recordedAt)
  };
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (error) {
    return {};
  }
}

function mapReport(row = {}) {
  return {
    id: Number(row.id),
    client_request_id: row.client_request_id,
    fleet_truck_id: Number(row.fleet_truck_id),
    truck_code_snapshot: row.truck_code_snapshot,
    truck_name_snapshot: row.truck_name_snapshot,
    current_fleet_condition: row.current_fleet_condition || null,
    current_condition_reason: row.current_condition_reason || null,
    reported_by_user_id: Number(row.reported_by_user_id),
    reported_by_name_snapshot: row.reported_by_name_snapshot,
    dispatch_plan_id: Number(row.dispatch_plan_id),
    dispatch_ticket_id: Number(row.dispatch_ticket_id),
    tracking_session_id: Number(row.tracking_session_id),
    issue_category: row.issue_category,
    description: row.description,
    assistant_answers: parseJsonObject(row.assistant_answers),
    assistant_ruleset_version: row.assistant_ruleset_version,
    severity: row.severity,
    possible_concern: row.possible_concern,
    recommended_action: row.recommended_action,
    latitude: row.latitude === null || row.latitude === undefined
      ? null
      : Number(row.latitude),
    longitude: row.longitude === null || row.longitude === undefined
      ? null
      : Number(row.longitude),
    accuracy_meters: row.accuracy_meters === null || row.accuracy_meters === undefined
      ? null
      : Number(row.accuracy_meters),
    location_recorded_at: row.location_recorded_at || null,
    image_url: row.image_url || null,
    report_status: row.report_status,
    reviewed_by_web_user_id: row.reviewed_by_web_user_id === null || row.reviewed_by_web_user_id === undefined
      ? null
      : Number(row.reviewed_by_web_user_id),
    reviewed_by_name: row.reviewed_by_name || null,
    reviewed_at: row.reviewed_at || null,
    resolution_action: row.resolution_action || null,
    resolution_notes: row.resolution_notes || null,
    resolved_by_web_user_id: row.resolved_by_web_user_id === null || row.resolved_by_web_user_id === undefined
      ? null
      : Number(row.resolved_by_web_user_id),
    resolved_by_name: row.resolved_by_name || null,
    resolved_at: row.resolved_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

function sameNullableNumber(left, right) {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return Number(left) === Number(right);
}

function normalizedTime(value) {
  if (!value) return null;
  const parsed = value instanceof Date
    ? value
    : new Date(
      String(value).includes("T")
        ? String(value)
        : `${String(value).replace(" ", "T")}Z`
    );
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function assignmentFromStoredReport(report) {
  return {
    fleet_truck_id: report.fleet_truck_id,
    dispatch_plan_id: report.dispatch_plan_id,
    dispatch_ticket_id: report.dispatch_ticket_id,
    tracking_session_id: report.tracking_session_id
  };
}

function sameCreateContext(row, assignment, input) {
  return (
    Number(row.reported_by_user_id) === Number(input.reporterId) &&
    Number(row.fleet_truck_id) === Number(assignment.fleet_truck_id) &&
    Number(row.dispatch_plan_id) === Number(assignment.dispatch_plan_id) &&
    Number(row.dispatch_ticket_id) === Number(assignment.dispatch_ticket_id) &&
    Number(row.tracking_session_id) === Number(assignment.tracking_session_id) &&
    row.issue_category === input.triage.category &&
    row.description === input.description &&
    JSON.stringify(parseJsonObject(row.assistant_answers)) ===
      JSON.stringify(input.triage.normalized_answers) &&
    sameNullableNumber(row.latitude, input.location.latitude) &&
    sameNullableNumber(row.longitude, input.location.longitude) &&
    sameNullableNumber(row.accuracy_meters, input.location.accuracy_meters) &&
    normalizedTime(row.location_recorded_at) ===
      normalizedTime(input.location.location_recorded_at)
  );
}

function normalizeKnownError(error) {
  if (
    error instanceof VehicleIssueError ||
    error instanceof VehicleIssueTriageError ||
    error instanceof VehicleIssueUploadError
  ) {
    return error;
  }
  return new VehicleIssueError(
    "Vehicle issue data is temporarily unavailable",
    503,
    "VEHICLE_ISSUE_DATABASE_UNAVAILABLE",
    error
  );
}

class VehicleIssueService {
  constructor(options = {}) {
    this.db = options.db || db;
    this.storeImage = options.storeImage || storeVehicleIssueImage;
    this.deleteImage = options.deleteImage || deleteStoredVehicleIssueImage;
  }

  getAssistantSchema(user = {}) {
    requireEligibleEnforcer(user);
    return getAssistantSchema();
  }

  async loadCurrentAssignment(executor, reporterId, options = {}) {
    const lock = options.forUpdate ? " FOR UPDATE" : "";
    const placeholders = NON_TERMINAL_TICKET_STATUSES.map(() => "?").join(", ");
    const [rows] = await executor.query(
      `
        SELECT
          dp.id AS dispatch_plan_id,
          dp.fleet_truck_id,
          ft.truck_code,
          ft.truck_name,
          dt.id AS dispatch_ticket_id,
          dt.status AS dispatch_ticket_status,
          tts.id AS tracking_session_id,
          tts.session_status AS tracking_session_status
        FROM dispatch_plans dp
        INNER JOIN fleet_trucks ft
          ON ft.id = dp.fleet_truck_id
        INNER JOIN dispatch_tickets dt
          ON dt.id = dp.activated_dispatch_ticket_id
        INNER JOIN truck_tracking_sessions tts
          ON tts.id = dp.activated_tracking_session_id
        INNER JOIN dispatch_tracking_sessions dts
          ON dts.dispatch_ticket_id = dt.id
         AND dts.tracking_session_id = tts.id
         AND dts.unlinked_at IS NULL
         AND dts.is_primary = 1
        WHERE dp.assigned_enforcer_user_id = ?
          AND dp.status = 'activated'
          AND dt.status IN (${placeholders})
          AND tts.session_status = 'active'
        ORDER BY dp.activated_at DESC, dp.id DESC
        LIMIT 1${lock}
      `,
      [reporterId, ...NON_TERMINAL_TICKET_STATUSES]
    );
    if (!rows.length) {
      throw new VehicleIssueError(
        "A current activated dispatch assignment is required to report a vehicle issue.",
        403,
        "VEHICLE_ISSUE_CURRENT_ASSIGNMENT_REQUIRED"
      );
    }
    return rows[0];
  }

  async findByClientRequestId(executor, clientRequestId, options = {}) {
    const [rows] = await executor.query(
      `
        SELECT *
        FROM vehicle_issue_reports
        WHERE client_request_id = ?
        LIMIT 1${options.forUpdate ? " FOR UPDATE" : ""}
      `,
      [clientRequestId]
    );
    return rows[0] || null;
  }

  assertIdempotentMatch(existing, assignment, input) {
    if (Number(existing.reported_by_user_id) !== Number(input.reporterId)) {
      throw new VehicleIssueError(
        "client_request_id is already associated with another reporter",
        409,
        "VEHICLE_ISSUE_IDEMPOTENCY_CONFLICT"
      );
    }
    if (!sameCreateContext(existing, assignment, input)) {
      throw new VehicleIssueError(
        "client_request_id cannot be reused for different report data or assignment context",
        409,
        "VEHICLE_ISSUE_IDEMPOTENCY_CONFLICT"
      );
    }
    return { report: mapReport(existing), idempotent: true };
  }

  normalizeCreateInput(payload, user) {
    const reporterId = requireEligibleEnforcer(user);
    const clientRequestId = validateClientRequestId(payload.client_request_id);
    const description = cleanText(payload.description, "description", 1000, {
      required: true,
      code: "VEHICLE_ISSUE_DESCRIPTION_REQUIRED"
    });
    let triage;
    try {
      triage = evaluateTriage(payload.issue_category, payload.assistant_answers);
    } catch (error) {
      throw normalizeKnownError(error);
    }
    return {
      reporterId,
      reporterName: cleanText(
        user.full_name || user.username || "Mobile Enforcer",
        "reporter name",
        255,
        { required: true }
      ),
      clientRequestId,
      description,
      triage,
      location: normalizeLocation(payload)
    };
  }

  async createReport(payload = {}, user = {}, file = null) {
    let input;
    let storedImage = null;
    let connection = null;
    try {
      input = this.normalizeCreateInput(payload, user);
      const initialExisting = await this.findByClientRequestId(
        this.db,
        input.clientRequestId
      );
      if (initialExisting) {
        return this.assertIdempotentMatch(
          initialExisting,
          assignmentFromStoredReport(initialExisting),
          input
        );
      }
      await this.loadCurrentAssignment(this.db, input.reporterId);

      storedImage = file ? await this.storeImage(file) : null;
      connection = await this.db.getConnection();
      await connection.beginTransaction();
      const assignment = await this.loadCurrentAssignment(connection, input.reporterId, {
        forUpdate: true
      });
      const existing = await this.findByClientRequestId(
        connection,
        input.clientRequestId,
        { forUpdate: true }
      );
      if (existing) {
        await connection.rollback();
        await this.deleteImage(storedImage);
        storedImage = null;
        return this.assertIdempotentMatch(existing, assignment, input);
      }

      const [result] = await connection.query(
        `
          INSERT INTO vehicle_issue_reports (
            client_request_id,
            fleet_truck_id,
            truck_code_snapshot,
            truck_name_snapshot,
            reported_by_user_id,
            reported_by_name_snapshot,
            dispatch_plan_id,
            dispatch_ticket_id,
            tracking_session_id,
            issue_category,
            description,
            assistant_answers,
            assistant_ruleset_version,
            severity,
            possible_concern,
            recommended_action,
            latitude,
            longitude,
            accuracy_meters,
            location_recorded_at,
            image_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          input.clientRequestId,
          assignment.fleet_truck_id,
          assignment.truck_code,
          assignment.truck_name,
          input.reporterId,
          input.reporterName,
          assignment.dispatch_plan_id,
          assignment.dispatch_ticket_id,
          assignment.tracking_session_id,
          input.triage.category,
          input.description,
          JSON.stringify(input.triage.normalized_answers),
          input.triage.ruleset_version,
          input.triage.severity,
          input.triage.possible_concern,
          input.triage.recommended_action,
          input.location.latitude,
          input.location.longitude,
          input.location.accuracy_meters,
          input.location.location_recorded_at,
          storedImage?.url || null
        ]
      );
      await connection.commit();
      const report = mapReport({
        id: result.insertId,
        client_request_id: input.clientRequestId,
        fleet_truck_id: assignment.fleet_truck_id,
        truck_code_snapshot: assignment.truck_code,
        truck_name_snapshot: assignment.truck_name,
        reported_by_user_id: input.reporterId,
        reported_by_name_snapshot: input.reporterName,
        dispatch_plan_id: assignment.dispatch_plan_id,
        dispatch_ticket_id: assignment.dispatch_ticket_id,
        tracking_session_id: assignment.tracking_session_id,
        issue_category: input.triage.category,
        description: input.description,
        assistant_answers: input.triage.normalized_answers,
        assistant_ruleset_version: input.triage.ruleset_version,
        severity: input.triage.severity,
        possible_concern: input.triage.possible_concern,
        recommended_action: input.triage.recommended_action,
        ...input.location,
        image_url: storedImage?.url || null,
        report_status: "submitted"
      });
      const notification = await this.createWmoNotification(report);
      return { report, idempotent: false, notification };
    } catch (error) {
      if (connection) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          // Preserve the original failure.
        }
      }
      if (storedImage) await this.deleteImage(storedImage);
      if (error?.code === "ER_DUP_ENTRY" && input) {
        try {
          const existing = await this.findByClientRequestId(
            this.db,
            input.clientRequestId
          );
          if (existing) {
            return this.assertIdempotentMatch(
              existing,
              assignmentFromStoredReport(existing),
              input
            );
          }
        } catch (conflictError) {
          throw normalizeKnownError(conflictError);
        }
      }
      throw normalizeKnownError(error);
    } finally {
      connection?.release?.();
    }
  }

  async createWmoNotification(report) {
    const title = "Vehicle Issue Reported";
    const message = `Truck ${report.truck_code_snapshot} reported a ${report.severity} ${report.issue_category} vehicle issue.`;
    try {
      const [result] = await this.db.query(
        `
          INSERT INTO notifications (
            type,
            title,
            message,
            status,
            reference_id,
            isRead
          ) VALUES (?, ?, ?, ?, ?, 0)
        `,
        [
          "vehicle_issue_reported",
          title,
          message,
          report.severity,
          String(report.id)
        ]
      );
      return {
        id: result.insertId || null,
        type: "vehicle_issue_reported",
        title,
        message,
        status: report.severity,
        reference_id: report.id,
        createdAt: new Date().toISOString()
      };
    } catch (error) {
      console.warn(
        "[VehicleIssue] WMO notification creation failed:",
        error?.code || "UNKNOWN_NOTIFICATION_ERROR"
      );
      return null;
    }
  }

  async listReports(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.report_status !== undefined && filters.report_status !== "") {
      const status = String(filters.report_status).trim().toLowerCase();
      if (!REPORT_STATUSES.has(status)) {
        throw new VehicleIssueError(
          "report_status is invalid",
          400,
          "VEHICLE_ISSUE_STATUS_INVALID"
        );
      }
      clauses.push("vir.report_status = ?");
      params.push(status);
    }
    if (filters.severity !== undefined && filters.severity !== "") {
      const severity = String(filters.severity).trim().toLowerCase();
      if (!SEVERITIES.has(severity)) {
        throw new VehicleIssueError(
          "severity is invalid",
          400,
          "VEHICLE_ISSUE_SEVERITY_INVALID"
        );
      }
      clauses.push("vir.severity = ?");
      params.push(severity);
    }
    if (filters.fleet_truck_id !== undefined && filters.fleet_truck_id !== "") {
      clauses.push("vir.fleet_truck_id = ?");
      params.push(positiveId(filters.fleet_truck_id, "fleet_truck_id"));
    }
    const requestedLimit = Number(filters.limit || 100);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 200)
      : 100;
    const [rows] = await this.db.query(
      `
        SELECT
          vir.*,
          ft.fleet_condition AS current_fleet_condition,
          ft.condition_reason AS current_condition_reason
        FROM vehicle_issue_reports vir
        INNER JOIN fleet_trucks ft ON ft.id = vir.fleet_truck_id
        ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY vir.created_at DESC, vir.id DESC
        LIMIT ?
      `,
      [...params, limit]
    );
    return rows.map(mapReport);
  }

  async getReport(reportId) {
    const id = positiveId(reportId);
    const [rows] = await this.db.query(
      `
        SELECT
          vir.*,
          ft.fleet_condition AS current_fleet_condition,
          ft.condition_reason AS current_condition_reason,
          reviewer.full_name AS reviewed_by_name,
          resolver.full_name AS resolved_by_name
        FROM vehicle_issue_reports vir
        INNER JOIN fleet_trucks ft ON ft.id = vir.fleet_truck_id
        LEFT JOIN web_users reviewer ON reviewer.id = vir.reviewed_by_web_user_id
        LEFT JOIN web_users resolver ON resolver.id = vir.resolved_by_web_user_id
        WHERE vir.id = ?
        LIMIT 1
      `,
      [id]
    );
    if (!rows.length) {
      throw new VehicleIssueError(
        "Vehicle issue report not found",
        404,
        "VEHICLE_ISSUE_NOT_FOUND"
      );
    }
    return mapReport(rows[0]);
  }

  async reviewReport(reportId, actor = {}) {
    const id = positiveId(reportId);
    const actorId = requireWebActor(actor);
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query(
        "SELECT * FROM vehicle_issue_reports WHERE id = ? LIMIT 1 FOR UPDATE",
        [id]
      );
      if (!rows.length) {
        throw new VehicleIssueError(
          "Vehicle issue report not found",
          404,
          "VEHICLE_ISSUE_NOT_FOUND"
        );
      }
      const report = rows[0];
      if (report.report_status === "resolved") {
        throw new VehicleIssueError(
          "A resolved vehicle issue cannot be reopened for review",
          409,
          "VEHICLE_ISSUE_ALREADY_RESOLVED"
        );
      }
      if (report.report_status === "submitted") {
        await connection.query(
          `
            UPDATE vehicle_issue_reports
            SET report_status = 'under_review',
                reviewed_by_web_user_id = ?,
                reviewed_at = NOW(3)
            WHERE id = ?
          `,
          [actorId, id]
        );
      }
      await connection.commit();
      return this.getReport(id);
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        // Preserve the original failure.
      }
      throw normalizeKnownError(error);
    } finally {
      connection.release();
    }
  }

  normalizeResolution(payload = {}) {
    const action = String(payload.resolution_action || "").trim().toLowerCase();
    if (!RESOLUTION_ACTIONS.has(action)) {
      throw new VehicleIssueError(
        "resolution_action is invalid",
        400,
        "VEHICLE_ISSUE_RESOLUTION_ACTION_INVALID"
      );
    }
    const requiresConditionReason = action !== "continue_operation";
    const notes = cleanText(
      payload.resolution_notes,
      "resolution_notes",
      requiresConditionReason ? 500 : 1000,
      {
        required: requiresConditionReason,
        code: requiresConditionReason
          ? "VEHICLE_ISSUE_RESOLUTION_NOTES_REQUIRED"
          : "VEHICLE_ISSUE_RESOLUTION_NOTES_INVALID"
      }
    );
    return { action, notes };
  }

  async resolveReport(reportId, payload = {}, actor = {}) {
    const id = positiveId(reportId);
    const actorId = requireWebActor(actor);
    const resolution = this.normalizeResolution(payload);
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query(
        "SELECT * FROM vehicle_issue_reports WHERE id = ? LIMIT 1 FOR UPDATE",
        [id]
      );
      if (!rows.length) {
        throw new VehicleIssueError(
          "Vehicle issue report not found",
          404,
          "VEHICLE_ISSUE_NOT_FOUND"
        );
      }
      const report = rows[0];
      const [truckRows] = await connection.query(
        "SELECT id, fleet_condition, condition_reason FROM fleet_trucks WHERE id = ? LIMIT 1 FOR UPDATE",
        [report.fleet_truck_id]
      );
      if (!truckRows.length) {
        throw new VehicleIssueError(
          "The linked Fleet truck no longer exists",
          409,
          "VEHICLE_ISSUE_FLEET_TRUCK_MISSING"
        );
      }
      if (report.report_status === "resolved") {
        const sameResolution =
          report.resolution_action === resolution.action &&
          (report.resolution_notes || null) === (resolution.notes || null);
        if (!sameResolution) {
          throw new VehicleIssueError(
            "The vehicle issue has already been resolved differently",
            409,
            "VEHICLE_ISSUE_RESOLUTION_CONFLICT"
          );
        }
        await connection.commit();
        return { report: await this.getReport(id), idempotent: true };
      }

      const fleetCondition = {
        set_for_maintenance: "for_maintenance",
        set_out_of_service: "out_of_service"
      }[resolution.action];
      if (fleetCondition) {
        await connection.query(
          `
            UPDATE fleet_trucks
            SET fleet_condition = ?,
                condition_reason = ?,
                condition_updated_by_web_user_id = ?,
                condition_updated_at = NOW(3)
            WHERE id = ?
          `,
          [fleetCondition, resolution.notes, actorId, report.fleet_truck_id]
        );
      }
      await connection.query(
        `
          UPDATE vehicle_issue_reports
          SET report_status = 'resolved',
              reviewed_by_web_user_id = COALESCE(reviewed_by_web_user_id, ?),
              reviewed_at = COALESCE(reviewed_at, NOW(3)),
              resolution_action = ?,
              resolution_notes = ?,
              resolved_by_web_user_id = ?,
              resolved_at = NOW(3)
          WHERE id = ?
        `,
        [actorId, resolution.action, resolution.notes, actorId, id]
      );
      await connection.commit();
      return { report: await this.getReport(id), idempotent: false };
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        // Preserve the original failure.
      }
      throw normalizeKnownError(error);
    } finally {
      connection.release();
    }
  }
}

const vehicleIssueService = new VehicleIssueService();

module.exports = vehicleIssueService;
module.exports.VehicleIssueService = VehicleIssueService;
module.exports.VehicleIssueError = VehicleIssueError;
module.exports.NON_TERMINAL_TICKET_STATUSES = NON_TERMINAL_TICKET_STATUSES;
module.exports.REPORT_STATUSES = REPORT_STATUSES;
module.exports.SEVERITIES = SEVERITIES;
module.exports.RESOLUTION_ACTIONS = RESOLUTION_ACTIONS;
module.exports.isEligibleEnforcer = isEligibleEnforcer;
module.exports.requireEligibleEnforcer = requireEligibleEnforcer;
module.exports.normalizeLocation = normalizeLocation;
module.exports.mapReport = mapReport;
