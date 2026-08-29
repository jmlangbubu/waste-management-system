const db = require("../config/dbPromise");

const PLAN_STATUSES = new Set(["planned", "activated", "cancelled"]);
const ACTIVE_PLAN_STATUSES = Object.freeze(["planned", "activated"]);
const ELIGIBLE_MOBILE_ROLE = "enforcer";
const DEFAULT_GEOFENCE_RADIUS_METERS = 100;
const MAX_STOP_SIGNATURE_LENGTH = 4096;

class DispatchPlanServiceError extends Error {
  constructor(message, statusCode = 400, code = "DISPATCH_PLAN_ERROR", cause = null) {
    super(message);
    this.name = "DispatchPlanServiceError";
    this.statusCode = statusCode;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function firstField(payload, keys) {
  for (const key of keys) {
    if (own(payload, key)) return { present: true, value: payload[key] };
  }
  return { present: false, value: undefined };
}

function cleanText(value, label, maxLength, options = {}) {
  if (value === undefined || value === null) {
    if (options.required) {
      throw new DispatchPlanServiceError(
        `${label} is required`,
        400,
        options.code || "DISPATCH_PLAN_INPUT_INVALID"
      );
    }
    return null;
  }
  if (!['string', 'number'].includes(typeof value)) {
    throw new DispatchPlanServiceError(
      `${label} must be text`,
      400,
      options.code || "DISPATCH_PLAN_INPUT_INVALID"
    );
  }
  const text = String(value).trim();
  if (!text) {
    if (options.required) {
      throw new DispatchPlanServiceError(
        `${label} is required`,
        400,
        options.code || "DISPATCH_PLAN_INPUT_INVALID"
      );
    }
    return null;
  }
  if (text.length > maxLength) {
    throw new DispatchPlanServiceError(
      `${label} must not exceed ${maxLength} characters`,
      400,
      options.code || "DISPATCH_PLAN_INPUT_INVALID"
    );
  }
  return text;
}

function requiredId(value, label, code = "DISPATCH_PLAN_ID_INVALID") {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new DispatchPlanServiceError(
      `${label} must be a positive integer`,
      400,
      code
    );
  }
  return id;
}

function authenticatedActorId(actor = {}) {
  const id = Number(actor.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new DispatchPlanServiceError(
      "Web Admin authentication is required.",
      401,
      "WEB_SESSION_REQUIRED"
    );
  }
  return id;
}

function validCalendarDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function currentManilaDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts
      .filter((part) => ["year", "month", "day"].includes(part.type))
      .map((part) => [part.type, part.value])
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function operationalDate(value, now = new Date(), options = {}) {
  const text = String(value ?? "").trim();
  if (!validCalendarDate(text)) {
    throw new DispatchPlanServiceError(
      "operational_date must be a valid date in YYYY-MM-DD format",
      400,
      "DISPATCH_PLAN_OPERATIONAL_DATE_INVALID"
    );
  }
  if (!options.allowPast && text < currentManilaDate(now)) {
    throw new DispatchPlanServiceError(
      "operational_date cannot be in the past in Asia/Manila",
      400,
      "DISPATCH_PLAN_OPERATIONAL_DATE_PAST"
    );
  }
  return text;
}

function formatDateInManila(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}.${values.fractionalSecond}`;
}

function optionalManilaDateTime(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) {
    const formatted = formatDateInManila(value);
    if (formatted) return formatted;
  }

  const text = String(value).trim();
  const localMatch = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
  );
  if (localMatch) {
    const [, yearText, monthText, dayText, hourText, minuteText, secondText = "00", fraction = ""] = localMatch;
    const dateText = `${yearText}-${monthText}-${dayText}`;
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    if (
      validCalendarDate(dateText) &&
      hour >= 0 && hour <= 23 &&
      minute >= 0 && minute <= 59 &&
      second >= 0 && second <= 59
    ) {
      return `${dateText} ${hourText}:${minuteText}:${secondText}.${fraction.padEnd(3, "0") || "000"}`;
    }
  } else if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const formatted = formatDateInManila(text);
    if (formatted) return formatted;
  }

  throw new DispatchPlanServiceError(
    `${label} must be a valid Asia/Manila date and time`,
    400,
    "DISPATCH_PLAN_DATETIME_INVALID"
  );
}

function manilaDateTimeMilliseconds(value) {
  if (!value) return null;
  return Date.parse(`${String(value).replace(" ", "T")}+08:00`);
}

function validateSchedule(scheduledStart, expectedReturn, stops = []) {
  const scheduledStartMs = manilaDateTimeMilliseconds(scheduledStart);
  const expectedReturnMs = manilaDateTimeMilliseconds(expectedReturn);
  if (
    scheduledStartMs !== null &&
    expectedReturnMs !== null &&
    expectedReturnMs <= scheduledStartMs
  ) {
    throw new DispatchPlanServiceError(
      "expected_return must be later than scheduled_start",
      400,
      "DISPATCH_PLAN_SCHEDULE_INVALID"
    );
  }

  let prior = scheduledStartMs;
  for (const stop of stops) {
    const arrival = manilaDateTimeMilliseconds(stop.expected_arrival_at);
    if (arrival === null) continue;
    if (prior !== null && arrival < prior) {
      throw new DispatchPlanServiceError(
        `expected_arrival for stop ${stop.stop_order} is earlier than the preceding schedule`,
        400,
        "DISPATCH_PLAN_SCHEDULE_INVALID"
      );
    }
    if (expectedReturnMs !== null && arrival > expectedReturnMs) {
      throw new DispatchPlanServiceError(
        `expected_arrival for stop ${stop.stop_order} is later than expected_return`,
        400,
        "DISPATCH_PLAN_SCHEDULE_INVALID"
      );
    }
    prior = arrival;
  }
}

function normalizeStops(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DispatchPlanServiceError(
      "At least one ordered destination stop is required",
      400,
      "DISPATCH_PLAN_STOPS_REQUIRED"
    );
  }
  const orders = new Set();
  const destinations = new Set();
  const stops = value.map((stop = {}) => {
    const stopOrder = Number(stop.stop_order ?? stop.stopOrder);
    if (!Number.isInteger(stopOrder) || stopOrder <= 0 || stopOrder > 65535) {
      throw new DispatchPlanServiceError(
        "Each stop_order must be an integer between 1 and 65535",
        400,
        "DISPATCH_PLAN_STOP_ORDER_INVALID"
      );
    }
    if (orders.has(stopOrder)) {
      throw new DispatchPlanServiceError(
        `Duplicate stop_order: ${stopOrder}`,
        400,
        "DISPATCH_PLAN_STOP_ORDER_DUPLICATE"
      );
    }
    orders.add(stopOrder);

    const destinationId = requiredId(
      stop.destination_id ?? stop.destinationId,
      `destination_id for stop ${stopOrder}`,
      "DISPATCH_PLAN_DESTINATION_ID_INVALID"
    );
    if (destinations.has(destinationId)) {
      throw new DispatchPlanServiceError(
        `Destination ${destinationId} is already included in this plan`,
        400,
        "DISPATCH_PLAN_DESTINATION_DUPLICATE"
      );
    }
    destinations.add(destinationId);

    return {
      stop_order: stopOrder,
      destination_id: destinationId,
      expected_arrival_at: optionalManilaDateTime(
        stop.expected_arrival ?? stop.expected_arrival_at ?? stop.expectedArrival,
        `expected_arrival for stop ${stopOrder}`
      )
    };
  });
  return stops.sort((left, right) => left.stop_order - right.stop_order);
}

function normalizePlanInput(payload = {}, now = new Date(), current = null) {
  const creating = !current;
  const dateField = firstField(payload, ["operational_date", "operationalDate"]);
  const truckField = firstField(payload, ["fleet_truck_id", "fleetTruckId"]);
  const enforcerField = firstField(payload, [
    "assigned_enforcer_user_id",
    "assignedEnforcerUserId"
  ]);
  const routeField = firstField(payload, ["route_name", "routeName"]);
  const descriptionField = firstField(payload, [
    "description",
    "route_description",
    "routeDescription"
  ]);
  const scheduledField = firstField(payload, [
    "scheduled_start",
    "scheduled_start_at",
    "scheduledStart"
  ]);
  const returnField = firstField(payload, [
    "expected_return",
    "expected_return_at",
    "expectedReturn"
  ]);
  const notesField = firstField(payload, ["notes"]);
  const stopsField = firstField(payload, ["stops"]);

  const normalized = {
    operational_date: operationalDate(
      dateField.present ? dateField.value : current?.operational_date,
      now
    ),
    fleet_truck_id: requiredId(
      truckField.present ? truckField.value : current?.fleet_truck_id,
      "fleet_truck_id",
      "DISPATCH_PLAN_FLEET_TRUCK_ID_INVALID"
    ),
    assigned_enforcer_user_id: requiredId(
      enforcerField.present ? enforcerField.value : current?.assigned_enforcer_user_id,
      "assigned_enforcer_user_id",
      "DISPATCH_PLAN_ENFORCER_ID_INVALID"
    ),
    route_name: routeField.present
      ? cleanText(routeField.value, "route_name", 180) || "Planned Route"
      : current?.route_name || "Planned Route",
    route_description: descriptionField.present
      ? cleanText(descriptionField.value, "description", 5000)
      : current?.route_description || null,
    scheduled_start_at: scheduledField.present
      ? optionalManilaDateTime(scheduledField.value, "scheduled_start")
      : current?.scheduled_start_at || null,
    expected_return_at: returnField.present
      ? optionalManilaDateTime(returnField.value, "expected_return")
      : current?.expected_return_at || null,
    notes: notesField.present
      ? cleanText(notesField.value, "notes", 5000)
      : current?.notes || null,
    stops: stopsField.present ? normalizeStops(stopsField.value) : null
  };

  if (creating && !stopsField.present) {
    throw new DispatchPlanServiceError(
      "At least one ordered destination stop is required",
      400,
      "DISPATCH_PLAN_STOPS_REQUIRED"
    );
  }
  validateSchedule(
    normalized.scheduled_start_at,
    normalized.expected_return_at,
    normalized.stops || []
  );
  return normalized;
}

function normalizeStatusFilter(value) {
  if (value === undefined || value === null || value === "") return null;
  const status = String(value).trim().toLowerCase();
  if (!PLAN_STATUSES.has(status)) {
    throw new DispatchPlanServiceError(
      "status must be planned, activated, or cancelled",
      400,
      "DISPATCH_PLAN_STATUS_INVALID"
    );
  }
  return status;
}

function normalizePlanError(error) {
  if (error instanceof DispatchPlanServiceError) return error;
  if (error?.code === "ER_DUP_ENTRY" || Number(error?.errno) === 1062) {
    const detail = String(error.sqlMessage || error.message || "");
    if (/uq_dispatch_plans_truck_day|conflict_truck_id/i.test(detail)) {
      return new DispatchPlanServiceError(
        "This truck already has a non-cancelled plan for the operational date",
        409,
        "DISPATCH_PLAN_TRUCK_CONFLICT",
        error
      );
    }
    if (/uq_dispatch_plans_enforcer_day|conflict_enforcer_user_id/i.test(detail)) {
      return new DispatchPlanServiceError(
        "This enforcer already has a non-cancelled plan for the operational date",
        409,
        "DISPATCH_PLAN_ENFORCER_CONFLICT",
        error
      );
    }
  }
  return new DispatchPlanServiceError(
    "Dispatch planning data is temporarily unavailable",
    500,
    "DISPATCH_PLAN_DATABASE_ERROR",
    error
  );
}

function planStopSignature(stops = []) {
  const signature = `v1|${stops.map((stop) => (
    `${stop.stop_order}:${Number(stop.latitude).toFixed(6)},${Number(stop.longitude).toFixed(6)}`
  )).join("|")}`;
  if (signature.length > MAX_STOP_SIGNATURE_LENGTH) {
    throw new DispatchPlanServiceError(
      "The ordered stop signature exceeds the approved schema limit",
      400,
      "DISPATCH_PLAN_STOP_SIGNATURE_TOO_LONG"
    );
  }
  return signature;
}

function normalizePlanRow(row = {}) {
  return {
    id: Number(row.id),
    operational_date: row.operational_date,
    status: row.status,
    fleet_truck_id: Number(row.fleet_truck_id),
    truck_code_snapshot: row.truck_code_snapshot,
    truck_name_snapshot: row.truck_name_snapshot,
    assigned_enforcer_user_id: Number(row.assigned_enforcer_user_id),
    assigned_enforcer_name_snapshot: row.assigned_enforcer_name_snapshot,
    route_name: row.route_name,
    description: row.description ?? row.route_description ?? null,
    scheduled_start: row.scheduled_start ?? row.scheduled_start_at ?? null,
    expected_return: row.expected_return ?? row.expected_return_at ?? null,
    notes: row.notes || null,
    stop_count: Number(row.stop_count || 0),
    revision: Number(row.revision || 1),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    cancelled_at: row.cancelled_at || null,
    cancellation_reason: row.cancellation_reason || null
  };
}

function normalizeStopRow(row = {}) {
  return {
    id: Number(row.id),
    stop_order: Number(row.stop_order),
    destination_id: row.destination_id === null ? null : Number(row.destination_id),
    location_name_snapshot: row.location_name_snapshot,
    address_reference_snapshot: row.address_reference_snapshot || null,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    geofence_radius_meters: Number(row.geofence_radius_meters),
    expected_arrival: row.expected_arrival ?? row.expected_arrival_at ?? null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

function storedJsonValue(value) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

class DispatchPlanService {
  constructor(pool = db, options = {}) {
    this.db = pool;
    this.now = typeof options.now === "function" ? options.now : () => new Date();
  }

  async query(sql, parameters = []) {
    try {
      return await this.db.query(sql, parameters);
    } catch (error) {
      throw normalizePlanError(error);
    }
  }

  async withTransaction(work) {
    let connection;
    let began = false;
    try {
      connection = await this.db.getConnection();
      await connection.beginTransaction();
      began = true;
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      if (connection && began) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          console.warn(
            "[DispatchPlanning] Transaction rollback warning:",
            rollbackError.code || "ROLLBACK_FAILED"
          );
        }
      }
      throw normalizePlanError(error);
    } finally {
      if (connection) connection.release();
    }
  }

  async loadTruck(connection, truckId) {
    const [rows] = await connection.query(
      `
        SELECT id, truck_code, truck_name, plate_number, fleet_condition
        FROM fleet_trucks
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [truckId]
    );
    if (!rows.length) {
      throw new DispatchPlanServiceError(
        "Fleet truck not found",
        404,
        "DISPATCH_PLAN_TRUCK_NOT_FOUND"
      );
    }
    const truck = rows[0];
    if (String(truck.fleet_condition).toLowerCase() !== "available") {
      throw new DispatchPlanServiceError(
        "The selected fleet truck is not available for planning",
        409,
        "DISPATCH_PLAN_TRUCK_UNAVAILABLE"
      );
    }
    return truck;
  }

  async loadEnforcer(connection, enforcerId) {
    const [rows] = await connection.query(
      `
        SELECT id, full_name, username, role, mobile_role, status
        FROM users
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [enforcerId]
    );
    if (!rows.length) {
      throw new DispatchPlanServiceError(
        "Mobile enforcer not found",
        404,
        "DISPATCH_PLAN_ENFORCER_NOT_FOUND"
      );
    }
    const enforcer = rows[0];
    if (String(enforcer.status || "").trim().toLowerCase() !== "active") {
      throw new DispatchPlanServiceError(
        "The selected mobile enforcer account is inactive",
        409,
        "DISPATCH_PLAN_ENFORCER_INACTIVE"
      );
    }
    const roles = [enforcer.role, enforcer.mobile_role]
      .map((value) => String(value || "").trim().toLowerCase());
    if (!roles.includes(ELIGIBLE_MOBILE_ROLE)) {
      throw new DispatchPlanServiceError(
        "The selected mobile account is not an eligible enforcer",
        409,
        "DISPATCH_PLAN_ENFORCER_ROLE_INELIGIBLE"
      );
    }
    return enforcer;
  }

  async assertNoConflicts(
    connection,
    date,
    fleetTruckId,
    enforcerId,
    excludePlanId = null
  ) {
    const exclusion = excludePlanId ? "AND id <> ?" : "";
    const truckParameters = [date, fleetTruckId, ...ACTIVE_PLAN_STATUSES];
    const enforcerParameters = [date, enforcerId, ...ACTIVE_PLAN_STATUSES];
    if (excludePlanId) {
      truckParameters.push(excludePlanId);
      enforcerParameters.push(excludePlanId);
    }

    const [truckRows] = await connection.query(
      `
        SELECT id
        FROM dispatch_plans
        WHERE operational_date = ?
          AND fleet_truck_id = ?
          AND status IN (?, ?)
          ${exclusion}
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE
      `,
      truckParameters
    );
    if (truckRows.length) {
      throw new DispatchPlanServiceError(
        "This truck already has a non-cancelled plan for the operational date",
        409,
        "DISPATCH_PLAN_TRUCK_CONFLICT"
      );
    }

    const [enforcerRows] = await connection.query(
      `
        SELECT id
        FROM dispatch_plans
        WHERE operational_date = ?
          AND assigned_enforcer_user_id = ?
          AND status IN (?, ?)
          ${exclusion}
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE
      `,
      enforcerParameters
    );
    if (enforcerRows.length) {
      throw new DispatchPlanServiceError(
        "This enforcer already has a non-cancelled plan for the operational date",
        409,
        "DISPATCH_PLAN_ENFORCER_CONFLICT"
      );
    }
  }

  async snapshotStops(connection, stops) {
    const destinationIds = stops.map((stop) => stop.destination_id);
    const [rows] = await connection.query(
      `
        SELECT
          id,
          name,
          barangay,
          display_label,
          latitude,
          longitude,
          is_verified,
          is_active
        FROM gensan_dispatch_destinations
        WHERE id IN (${destinationIds.map(() => "?").join(", ")})
          AND is_verified = 1
          AND is_active = 1
        FOR UPDATE
      `,
      destinationIds
    );
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    return stops.map((stop) => {
      const destination = byId.get(stop.destination_id);
      if (!destination) {
        throw new DispatchPlanServiceError(
          `Verified active destination ${stop.destination_id} was not found`,
          404,
          "DISPATCH_PLAN_DESTINATION_NOT_FOUND"
        );
      }
      const latitude = Number(destination.latitude);
      const longitude = Number(destination.longitude);
      if (
        !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      ) {
        throw new DispatchPlanServiceError(
          `Destination ${stop.destination_id} has invalid catalog coordinates`,
          409,
          "DISPATCH_PLAN_DESTINATION_INVALID"
        );
      }
      const locationName = String(
        destination.display_label || destination.name || ""
      ).trim();
      if (!locationName || locationName.length > 180) {
        throw new DispatchPlanServiceError(
          `Destination ${stop.destination_id} cannot fit the approved plan snapshot schema`,
          409,
          "DISPATCH_PLAN_DESTINATION_INVALID"
        );
      }
      return {
        ...stop,
        location_name_snapshot: locationName,
        address_reference_snapshot:
          String(destination.barangay || "").trim() || null,
        latitude,
        longitude,
        geofence_radius_meters: DEFAULT_GEOFENCE_RADIUS_METERS
      };
    });
  }

  async insertStops(connection, planId, stops) {
    for (const stop of stops) {
      await connection.query(
        `
          INSERT INTO dispatch_plan_stops (
            dispatch_plan_id,
            stop_order,
            destination_id,
            location_name_snapshot,
            address_reference_snapshot,
            latitude,
            longitude,
            geofence_radius_meters,
            expected_arrival_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          planId,
          stop.stop_order,
          stop.destination_id,
          stop.location_name_snapshot,
          stop.address_reference_snapshot,
          stop.latitude,
          stop.longitude,
          stop.geofence_radius_meters,
          stop.expected_arrival_at
        ]
      );
    }
  }

  async getPlanForUpdate(connection, planId) {
    const [rows] = await connection.query(
      `
        SELECT
          id,
          DATE_FORMAT(operational_date, '%Y-%m-%d') AS operational_date,
          fleet_truck_id,
          truck_code_snapshot,
          truck_name_snapshot,
          assigned_enforcer_user_id,
          assigned_enforcer_name_snapshot,
          route_name,
          route_description,
          planned_route_snapshot,
          stop_signature,
          DATE_FORMAT(scheduled_start_at, '%Y-%m-%d %H:%i:%s') AS scheduled_start_at,
          DATE_FORMAT(expected_return_at, '%Y-%m-%d %H:%i:%s') AS expected_return_at,
          status,
          notes,
          revision
        FROM dispatch_plans
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [planId]
    );
    if (!rows.length) {
      throw new DispatchPlanServiceError(
        "Dispatch plan not found",
        404,
        "DISPATCH_PLAN_NOT_FOUND"
      );
    }
    return rows[0];
  }

  assertPlanned(plan) {
    if (String(plan.status).toLowerCase() !== "planned") {
      throw new DispatchPlanServiceError(
        "Only a planned dispatch plan may be changed",
        409,
        "DISPATCH_PLAN_IMMUTABLE"
      );
    }
  }

  async listPlans(filters = {}) {
    const clauses = [];
    const parameters = [];
    if (filters.operational_date || filters.operationalDate) {
      clauses.push("dp.operational_date = ?");
      parameters.push(operationalDate(
        filters.operational_date || filters.operationalDate,
        this.now(),
        { allowPast: true }
      ));
    }
    const status = normalizeStatusFilter(filters.status);
    if (status) {
      clauses.push("dp.status = ?");
      parameters.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const [rows] = await this.query(
      `
        SELECT
          dp.id,
          DATE_FORMAT(dp.operational_date, '%Y-%m-%d') AS operational_date,
          dp.status,
          dp.fleet_truck_id,
          dp.truck_code_snapshot,
          dp.truck_name_snapshot,
          dp.assigned_enforcer_user_id,
          dp.assigned_enforcer_name_snapshot,
          dp.route_name,
          dp.route_description AS description,
          DATE_FORMAT(dp.scheduled_start_at, '%Y-%m-%d %H:%i:%s') AS scheduled_start,
          DATE_FORMAT(dp.expected_return_at, '%Y-%m-%d %H:%i:%s') AS expected_return,
          dp.notes,
          dp.revision,
          DATE_FORMAT(dp.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
          DATE_FORMAT(dp.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at,
          DATE_FORMAT(dp.cancelled_at, '%Y-%m-%d %H:%i:%s') AS cancelled_at,
          dp.cancellation_reason,
          COALESCE(stop_summary.stop_count, 0) AS stop_count
        FROM dispatch_plans dp
        LEFT JOIN (
          SELECT dispatch_plan_id, COUNT(*) AS stop_count
          FROM dispatch_plan_stops
          GROUP BY dispatch_plan_id
        ) stop_summary
          ON stop_summary.dispatch_plan_id = dp.id
        ${where}
        ORDER BY dp.operational_date ASC, dp.id ASC
      `,
      parameters
    );
    return rows.map(normalizePlanRow);
  }

  async getPlan(planId) {
    const id = requiredId(planId, "dispatch plan id");
    const [[planRows], [stopRows]] = await Promise.all([
      this.query(
        `
          SELECT
            dp.id,
            DATE_FORMAT(dp.operational_date, '%Y-%m-%d') AS operational_date,
            dp.status,
            dp.fleet_truck_id,
            dp.truck_code_snapshot,
            dp.truck_name_snapshot,
            dp.assigned_enforcer_user_id,
            dp.assigned_enforcer_name_snapshot,
            dp.route_name,
            dp.route_description AS description,
            DATE_FORMAT(dp.scheduled_start_at, '%Y-%m-%d %H:%i:%s') AS scheduled_start,
            DATE_FORMAT(dp.expected_return_at, '%Y-%m-%d %H:%i:%s') AS expected_return,
            dp.notes,
            dp.revision,
            DATE_FORMAT(dp.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
            DATE_FORMAT(dp.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at,
            DATE_FORMAT(dp.cancelled_at, '%Y-%m-%d %H:%i:%s') AS cancelled_at,
            dp.cancellation_reason,
            (SELECT COUNT(*) FROM dispatch_plan_stops count_stops
              WHERE count_stops.dispatch_plan_id = dp.id) AS stop_count
          FROM dispatch_plans dp
          WHERE dp.id = ?
          LIMIT 1
        `,
        [id]
      ),
      this.query(
        `
          SELECT
            id,
            stop_order,
            destination_id,
            location_name_snapshot,
            address_reference_snapshot,
            latitude,
            longitude,
            geofence_radius_meters,
            DATE_FORMAT(expected_arrival_at, '%Y-%m-%d %H:%i:%s') AS expected_arrival,
            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
            DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
          FROM dispatch_plan_stops
          WHERE dispatch_plan_id = ?
          ORDER BY stop_order ASC, id ASC
        `,
        [id]
      )
    ]);
    if (!planRows.length) {
      throw new DispatchPlanServiceError(
        "Dispatch plan not found",
        404,
        "DISPATCH_PLAN_NOT_FOUND"
      );
    }
    return {
      ...normalizePlanRow(planRows[0]),
      stops: stopRows.map(normalizeStopRow)
    };
  }

  async createPlan(payload = {}, actor = {}) {
    const actorId = authenticatedActorId(actor);
    const input = normalizePlanInput(payload, this.now());
    const planId = await this.withTransaction(async (connection) => {
      const truck = await this.loadTruck(connection, input.fleet_truck_id);
      const enforcer = await this.loadEnforcer(
        connection,
        input.assigned_enforcer_user_id
      );
      await this.assertNoConflicts(
        connection,
        input.operational_date,
        input.fleet_truck_id,
        input.assigned_enforcer_user_id
      );
      const stops = await this.snapshotStops(connection, input.stops);
      const stopSignature = planStopSignature(stops);
      const enforcerName = String(enforcer.full_name || enforcer.username || "").trim();
      const [result] = await connection.query(
        `
          INSERT INTO dispatch_plans (
            operational_date,
            fleet_truck_id,
            truck_code_snapshot,
            truck_name_snapshot,
            assigned_enforcer_user_id,
            assigned_enforcer_name_snapshot,
            route_name,
            route_description,
            planned_route_snapshot,
            stop_signature,
            scheduled_start_at,
            expected_return_at,
            status,
            notes,
            revision,
            created_by_web_user_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'planned', ?, 1, ?)
        `,
        [
          input.operational_date,
          input.fleet_truck_id,
          String(truck.truck_code),
          String(truck.truck_name),
          input.assigned_enforcer_user_id,
          enforcerName,
          input.route_name,
          input.route_description,
          stopSignature,
          input.scheduled_start_at,
          input.expected_return_at,
          input.notes,
          actorId
        ]
      );
      await this.insertStops(connection, result.insertId, stops);
      return result.insertId;
    });
    return this.getPlan(planId);
  }

  async updatePlan(planId, payload = {}, actor = {}) {
    const id = requiredId(planId, "dispatch plan id");
    const actorId = authenticatedActorId(actor);
    await this.withTransaction(async (connection) => {
      const current = await this.getPlanForUpdate(connection, id);
      this.assertPlanned(current);
      const input = normalizePlanInput(payload, this.now(), current);
      if (!input.stops) {
        const [existingStops] = await connection.query(
          `
            SELECT
              stop_order,
              DATE_FORMAT(expected_arrival_at, '%Y-%m-%d %H:%i:%s')
                AS expected_arrival_at
            FROM dispatch_plan_stops
            WHERE dispatch_plan_id = ?
            ORDER BY stop_order ASC, id ASC
          `,
          [id]
        );
        validateSchedule(
          input.scheduled_start_at,
          input.expected_return_at,
          existingStops
        );
      }
      const truck = await this.loadTruck(connection, input.fleet_truck_id);
      const enforcer = await this.loadEnforcer(
        connection,
        input.assigned_enforcer_user_id
      );
      await this.assertNoConflicts(
        connection,
        input.operational_date,
        input.fleet_truck_id,
        input.assigned_enforcer_user_id,
        id
      );

      let stopSignature = current.stop_signature;
      let stops = null;
      if (input.stops) {
        stops = await this.snapshotStops(connection, input.stops);
        stopSignature = planStopSignature(stops);
      }
      const enforcerName = String(enforcer.full_name || enforcer.username || "").trim();
      const invalidatesRouteSnapshot = Boolean(stops) ||
        Number(current.fleet_truck_id) !== input.fleet_truck_id;
      await connection.query(
        `
          UPDATE dispatch_plans
          SET operational_date = ?,
              fleet_truck_id = ?,
              truck_code_snapshot = ?,
              truck_name_snapshot = ?,
              assigned_enforcer_user_id = ?,
              assigned_enforcer_name_snapshot = ?,
              route_name = ?,
              route_description = ?,
              planned_route_snapshot = ?,
              stop_signature = ?,
              scheduled_start_at = ?,
              expected_return_at = ?,
              notes = ?,
              revision = revision + 1,
              updated_by_web_user_id = ?
          WHERE id = ?
            AND status = 'planned'
        `,
        [
          input.operational_date,
          input.fleet_truck_id,
          String(truck.truck_code),
          String(truck.truck_name),
          input.assigned_enforcer_user_id,
          enforcerName,
          input.route_name,
          input.route_description,
          invalidatesRouteSnapshot
            ? null
            : storedJsonValue(current.planned_route_snapshot),
          stopSignature,
          input.scheduled_start_at,
          input.expected_return_at,
          input.notes,
          actorId,
          id
        ]
      );
      if (stops) {
        await connection.query(
          "DELETE FROM dispatch_plan_stops WHERE dispatch_plan_id = ?",
          [id]
        );
        await this.insertStops(connection, id, stops);
      }
    });
    return this.getPlan(id);
  }

  async cancelPlan(planId, payload = {}, actor = {}) {
    const id = requiredId(planId, "dispatch plan id");
    const actorId = authenticatedActorId(actor);
    const reason = cleanText(
      payload.reason ?? payload.cancellation_reason,
      "cancellation_reason",
      1000,
      { required: true, code: "DISPATCH_PLAN_CANCELLATION_REASON_REQUIRED" }
    );
    await this.withTransaction(async (connection) => {
      const current = await this.getPlanForUpdate(connection, id);
      this.assertPlanned(current);
      await connection.query(
        `
          UPDATE dispatch_plans
          SET status = 'cancelled',
              cancelled_at = NOW(3),
              cancelled_by_web_user_id = ?,
              cancellation_reason = ?,
              updated_by_web_user_id = ?,
              revision = revision + 1
          WHERE id = ?
            AND status = 'planned'
        `,
        [actorId, reason, actorId, id]
      );
    });
    return this.getPlan(id);
  }

  async getPlanningOptions(filters = {}) {
    const date = operationalDate(
      filters.operational_date || filters.operationalDate,
      this.now()
    );
    const [[truckRows], [enforcerRows]] = await Promise.all([
      this.query(
        `
          SELECT ft.id, ft.truck_code, ft.truck_name, ft.plate_number
          FROM fleet_trucks ft
          WHERE ft.fleet_condition = 'available'
            AND NOT EXISTS (
              SELECT 1
              FROM dispatch_plans dp
              WHERE dp.fleet_truck_id = ft.id
                AND dp.operational_date = ?
                AND dp.status IN ('planned', 'activated')
            )
          ORDER BY ft.truck_name ASC, ft.truck_code ASC, ft.id ASC
        `,
        [date]
      ),
      this.query(
        `
          SELECT
            u.id,
            COALESCE(NULLIF(TRIM(u.full_name), ''), u.username) AS display_name,
            'enforcer' AS mobile_role
          FROM users u
          WHERE LOWER(TRIM(COALESCE(u.status, ''))) = 'active'
            AND (
              LOWER(TRIM(COALESCE(u.mobile_role, ''))) = 'enforcer'
              OR LOWER(TRIM(COALESCE(u.role, ''))) = 'enforcer'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM dispatch_plans dp
              WHERE dp.assigned_enforcer_user_id = u.id
                AND dp.operational_date = ?
                AND dp.status IN ('planned', 'activated')
            )
          ORDER BY display_name ASC, u.id ASC
        `,
        [date]
      )
    ]);
    return {
      operational_date: date,
      fleet_trucks: truckRows.map((row) => ({
        id: Number(row.id),
        truck_code: row.truck_code,
        truck_name: row.truck_name,
        plate_number: row.plate_number || null
      })),
      enforcers: enforcerRows.map((row) => ({
        id: Number(row.id),
        display_name: row.display_name,
        mobile_role: ELIGIBLE_MOBILE_ROLE
      })),
      destination_catalog: {
        endpoint: "/api/dispatch/destinations",
        verified_only: true,
        active_only: true,
        required_type_values: ["road_segment", "barangay_hall"]
      }
    };
  }
}

const dispatchPlanService = new DispatchPlanService();

module.exports = dispatchPlanService;
module.exports.DispatchPlanService = DispatchPlanService;
module.exports.DispatchPlanServiceError = DispatchPlanServiceError;
module.exports.PLAN_STATUSES = PLAN_STATUSES;
module.exports.ACTIVE_PLAN_STATUSES = ACTIVE_PLAN_STATUSES;
module.exports.ELIGIBLE_MOBILE_ROLE = ELIGIBLE_MOBILE_ROLE;
module.exports.DEFAULT_GEOFENCE_RADIUS_METERS = DEFAULT_GEOFENCE_RADIUS_METERS;
module.exports.currentManilaDate = currentManilaDate;
module.exports.operationalDate = operationalDate;
module.exports.optionalManilaDateTime = optionalManilaDateTime;
module.exports.normalizeStops = normalizeStops;
module.exports.normalizePlanInput = normalizePlanInput;
module.exports.normalizePlanError = normalizePlanError;
module.exports.planStopSignature = planStopSignature;
