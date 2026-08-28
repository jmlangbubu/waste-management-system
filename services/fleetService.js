const db = require("../config/dbPromise");
const { formatManilaDateTime } = require("../utils/gpsValidation");

const FLEET_CONDITIONS = new Set([
  "available",
  "for_maintenance",
  "out_of_service"
]);

const OPERATIONAL_STATES = Object.freeze({
  returning_to_wmo: "Returning to WMO",
  active_dispatch: "Active / On Dispatch",
  tracking_awaiting_dispatch: "Tracking Active / Awaiting Dispatch",
  planned: "Planned",
  off_duty: "Off Duty"
});

class FleetServiceError extends Error {
  constructor(message, statusCode = 400, code = "FLEET_ERROR", cause = null) {
    super(message);
    this.name = "FleetServiceError";
    this.statusCode = statusCode;
    this.code = code;
    this.cause = cause;
  }
}

function cleanText(value, label, maxLength, options = {}) {
  if (value === undefined || value === null) {
    if (options.required) {
      throw new FleetServiceError(`${label} is required`, 400, options.code);
    }
    return null;
  }

  if (!["string", "number"].includes(typeof value)) {
    throw new FleetServiceError(`${label} must be text`, 400, options.code);
  }

  const text = String(value).trim();
  if (!text) {
    if (options.required) {
      throw new FleetServiceError(`${label} is required`, 400, options.code);
    }
    return null;
  }
  if (text.length > maxLength) {
    throw new FleetServiceError(
      `${label} must not exceed ${maxLength} characters`,
      400,
      options.code
    );
  }
  return text;
}

function requiredId(value, label = "fleet truck id") {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new FleetServiceError(
      `${label} must be a positive integer`,
      400,
      "FLEET_TRUCK_ID_INVALID"
    );
  }
  return id;
}

function authenticatedActorId(actor = {}) {
  const id = Number(actor.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new FleetServiceError(
      "Web Admin authentication is required.",
      401,
      "WEB_SESSION_REQUIRED"
    );
  }
  return id;
}

function normalizeFleetCondition(value, fallback = "available") {
  const condition = String(value ?? fallback).trim().toLowerCase();
  if (!FLEET_CONDITIONS.has(condition)) {
    throw new FleetServiceError(
      "fleet_condition must be available, for_maintenance, or out_of_service",
      400,
      "FLEET_CONDITION_INVALID"
    );
  }
  return condition;
}

function normalizeConditionReason(value, condition) {
  if (condition === "available") return null;
  const reason = cleanText(value, "condition_reason", 500, {
    required: true,
    code: "FLEET_CONDITION_REASON_REQUIRED"
  });
  return reason;
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

function duplicateFleetError(error) {
  const detail = String(error?.sqlMessage || error?.message || "");
  if (/plate_number|uq_fleet_trucks_plate_number/i.test(detail)) {
    return new FleetServiceError(
      "A fleet truck with this plate number already exists",
      409,
      "FLEET_PLATE_DUPLICATE",
      error
    );
  }
  return new FleetServiceError(
    "A fleet truck with this truck code already exists",
    409,
    "FLEET_TRUCK_CODE_DUPLICATE",
    error
  );
}

function normalizeFleetError(error) {
  if (error instanceof FleetServiceError) return error;
  if (error?.code === "ER_DUP_ENTRY" || Number(error?.errno) === 1062) {
    return duplicateFleetError(error);
  }
  return new FleetServiceError(
    "Fleet data is temporarily unavailable",
    503,
    "FLEET_DATABASE_UNAVAILABLE",
    error
  );
}

function firstByTruckCode(rows = []) {
  const byTruckCode = new Map();
  for (const row of rows) {
    const truckCode = String(row.truck_id ?? row.truck_code ?? "").trim();
    if (truckCode && !byTruckCode.has(truckCode)) {
      byTruckCode.set(truckCode, row);
    }
  }
  return byTruckCode;
}

function firstByFleetTruckId(rows = []) {
  const byFleetTruckId = new Map();
  for (const row of rows) {
    const fleetTruckId = Number(row.fleet_truck_id);
    if (Number.isInteger(fleetTruckId) && !byFleetTruckId.has(fleetTruckId)) {
      byFleetTruckId.set(fleetTruckId, row);
    }
  }
  return byFleetTruckId;
}

function baseFleetTruck(row = {}) {
  return {
    id: Number(row.id),
    truck_code: String(row.truck_code || "").trim(),
    truck_name: String(row.truck_name || "").trim(),
    plate_number: row.plate_number || null,
    fleet_condition: row.fleet_condition,
    condition_reason: row.condition_reason || null,
    condition_updated_at: row.condition_updated_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

function deriveFleetTruck(row, dispatch, tracking, plan) {
  const truck = baseFleetTruck(row);
  let operationalStateKey = "off_duty";
  let operationalDate = null;
  let currentAssignment = null;

  if (dispatch?.status === "returning_to_wmo") {
    operationalStateKey = "returning_to_wmo";
  } else if (dispatch) {
    operationalStateKey = "active_dispatch";
  } else if (tracking) {
    operationalStateKey = "tracking_awaiting_dispatch";
  } else if (plan) {
    operationalStateKey = "planned";
    operationalDate = plan.operational_date || null;
  }

  if (dispatch) {
    currentAssignment = {
      type: "dispatch",
      dispatch_ticket_id: Number(dispatch.id),
      ticket_number: dispatch.ticket_number || null,
      dispatch_status: dispatch.status,
      route_name: dispatch.route_name || null,
      assigned_personnel_name: dispatch.assigned_personnel_name || null
    };
  } else if (tracking) {
    currentAssignment = {
      type: "tracking",
      tracking_session_id: Number(tracking.id),
      enforcer_name: tracking.enforcer_name || null,
      started_at: tracking.started_at || null
    };
  } else if (plan) {
    currentAssignment = {
      type: "plan",
      dispatch_plan_id: Number(plan.id),
      operational_date: plan.operational_date || null,
      plan_status: plan.status,
      route_name: plan.route_name || null,
      assigned_enforcer_name: plan.assigned_enforcer_name_snapshot || null
    };
  }

  const assignable =
    truck.fleet_condition === "available" &&
    !dispatch &&
    !tracking &&
    !plan;

  return {
    ...truck,
    operational_state_key: operationalStateKey,
    operational_state: operationalStateKey === "planned" && operationalDate
      ? `Planned for ${operationalDate}`
      : OPERATIONAL_STATES[operationalStateKey],
    operational_date: operationalDate,
    assignable,
    active_tracking_session_id: tracking ? Number(tracking.id) : null,
    active_dispatch_ticket_id: dispatch ? Number(dispatch.id) : null,
    gps_status: tracking?.gps_status || null,
    current_assignment: currentAssignment
  };
}

class FleetService {
  constructor(pool = db, options = {}) {
    this.db = pool;
    this.now = typeof options.now === "function" ? options.now : () => new Date();
  }

  async query(sql, parameters = []) {
    try {
      return await this.db.query(sql, parameters);
    } catch (error) {
      throw normalizeFleetError(error);
    }
  }

  async listTrucks() {
    const [fleetRowsResult] = await this.query(
      `
        SELECT
          id,
          truck_code,
          truck_name,
          plate_number,
          fleet_condition,
          condition_reason,
          DATE_FORMAT(condition_updated_at, '%Y-%m-%d %H:%i:%s')
            AS condition_updated_at,
          DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
          DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
        FROM fleet_trucks
        ORDER BY truck_name ASC, truck_code ASC, id ASC
      `
    );
    const fleetRows = fleetRowsResult || [];
    if (!fleetRows.length) return [];

    const now = this.now();
    const manilaNow = formatManilaDateTime(now.getTime());
    const operationalDate = currentManilaDate(now);
    const [[dispatchRows], [trackingRows], [planRows]] = await Promise.all([
      this.query(
        `
          SELECT
            id,
            ticket_number,
            truck_id,
            status,
            route_name,
            assigned_personnel_name,
            DATE_FORMAT(actual_start_at, '%Y-%m-%d %H:%i:%s') AS actual_start_at
          FROM dispatch_tickets
          WHERE status IN ('dispatched', 'in_progress', 'returning_to_wmo')
          ORDER BY
            CASE WHEN status = 'returning_to_wmo' THEN 0 ELSE 1 END,
            updated_at DESC,
            id DESC
        `
      ),
      this.query(
        `
          SELECT
            tts.id,
            tts.truck_id,
            tts.enforcer_name,
            DATE_FORMAT(tts.started_at, '%Y-%m-%d %H:%i:%s') AS started_at,
            CASE
              WHEN LOWER(COALESCE(tll.status, tts.last_device_status, ''))
                IN ('gps_off', 'tracking_off', 'permission_missing')
                THEN 'offline'
              WHEN tll.last_updated_at IS NULL
                THEN 'offline'
              WHEN tll.last_updated_at >= DATE_SUB(?, INTERVAL 60 SECOND)
                THEN 'online'
              WHEN tll.last_updated_at >= DATE_SUB(?, INTERVAL 5 MINUTE)
                THEN 'stale'
              ELSE 'offline'
            END AS gps_status
          FROM truck_tracking_sessions tts
          LEFT JOIN truck_last_locations tll
            ON tll.session_id = tts.id
          WHERE tts.session_status = 'active'
          ORDER BY tts.started_at DESC, tts.id DESC
        `,
        [manilaNow, manilaNow]
      ),
      this.query(
        `
          SELECT
            id,
            fleet_truck_id,
            truck_code_snapshot AS truck_code,
            DATE_FORMAT(operational_date, '%Y-%m-%d') AS operational_date,
            status,
            route_name,
            assigned_enforcer_name_snapshot
          FROM dispatch_plans
          WHERE status IN ('planned', 'activated')
            AND operational_date >= ?
          ORDER BY operational_date ASC, id ASC
        `,
        [operationalDate]
      )
    ]);

    const dispatchByTruck = firstByTruckCode(dispatchRows);
    const trackingByTruck = firstByTruckCode(trackingRows);
    const planByFleetTruckId = firstByFleetTruckId(planRows);

    return fleetRows.map((row) => {
      const truckCode = String(row.truck_code || "").trim();
      return deriveFleetTruck(
        row,
        dispatchByTruck.get(truckCode),
        trackingByTruck.get(truckCode),
        planByFleetTruckId.get(Number(row.id))
      );
    });
  }

  async getSummary() {
    const trucks = await this.listTrucks();
    const summary = {
      total: trucks.length,
      available: 0,
      for_maintenance: 0,
      out_of_service: 0,
      active: 0,
      returning: 0,
      tracking_awaiting_dispatch: 0,
      planned: 0,
      off_duty: 0
    };

    for (const truck of trucks) {
      if (FLEET_CONDITIONS.has(truck.fleet_condition)) {
        summary[truck.fleet_condition] += 1;
      }
      if (truck.operational_state_key === "returning_to_wmo") {
        summary.returning += 1;
      } else if (truck.operational_state_key === "active_dispatch") {
        summary.active += 1;
      } else if (truck.operational_state_key === "tracking_awaiting_dispatch") {
        summary.tracking_awaiting_dispatch += 1;
      } else if (truck.operational_state_key === "planned") {
        summary.planned += 1;
      } else {
        summary.off_duty += 1;
      }
    }
    return summary;
  }

  async createTruck(payload = {}, actor = {}) {
    const actorId = authenticatedActorId(actor);
    const truckCode = cleanText(payload.truck_code, "truck_code", 100, {
      required: true,
      code: "FLEET_TRUCK_CODE_REQUIRED"
    });
    const truckName = cleanText(payload.truck_name, "truck_name", 150, {
      required: true,
      code: "FLEET_TRUCK_NAME_REQUIRED"
    });
    const plateNumber = cleanText(payload.plate_number, "plate_number", 50);
    const fleetCondition = normalizeFleetCondition(payload.fleet_condition);
    const conditionReason = normalizeConditionReason(
      payload.condition_reason,
      fleetCondition
    );

    const [duplicates] = await this.query(
      `
        SELECT id, truck_code, plate_number
        FROM fleet_trucks
        WHERE truck_code = ?
          OR (? IS NOT NULL AND plate_number = ?)
        LIMIT 1
      `,
      [truckCode, plateNumber, plateNumber]
    );
    if (duplicates.length) {
      if (plateNumber && duplicates[0].plate_number === plateNumber) {
        throw new FleetServiceError(
          "A fleet truck with this plate number already exists",
          409,
          "FLEET_PLATE_DUPLICATE"
        );
      }
      throw new FleetServiceError(
        "A fleet truck with this truck code already exists",
        409,
        "FLEET_TRUCK_CODE_DUPLICATE"
      );
    }

    const [result] = await this.query(
      `
        INSERT INTO fleet_trucks (
          truck_code,
          truck_name,
          plate_number,
          fleet_condition,
          condition_reason,
          condition_updated_by_web_user_id,
          condition_updated_at,
          created_by_web_user_id
        )
        VALUES (?, ?, ?, ?, ?, ?, NOW(3), ?)
      `,
      [
        truckCode,
        truckName,
        plateNumber,
        fleetCondition,
        conditionReason,
        actorId,
        actorId
      ]
    );

    return baseFleetTruck({
      id: result.insertId,
      truck_code: truckCode,
      truck_name: truckName,
      plate_number: plateNumber,
      fleet_condition: fleetCondition,
      condition_reason: conditionReason
    });
  }

  async updateCondition(truckId, payload = {}, actor = {}) {
    const id = requiredId(truckId);
    const actorId = authenticatedActorId(actor);
    const fleetCondition = normalizeFleetCondition(payload.fleet_condition, null);
    const conditionReason = normalizeConditionReason(
      payload.condition_reason,
      fleetCondition
    );

    const [rows] = await this.query(
      `
        SELECT
          id,
          truck_code,
          truck_name,
          plate_number,
          fleet_condition,
          condition_reason
        FROM fleet_trucks
        WHERE id = ?
        LIMIT 1
      `,
      [id]
    );
    if (!rows.length) {
      throw new FleetServiceError(
        "Fleet truck not found",
        404,
        "FLEET_TRUCK_NOT_FOUND"
      );
    }

    await this.query(
      `
        UPDATE fleet_trucks
        SET fleet_condition = ?,
            condition_reason = ?,
            condition_updated_by_web_user_id = ?,
            condition_updated_at = NOW(3)
        WHERE id = ?
      `,
      [fleetCondition, conditionReason, actorId, id]
    );

    return baseFleetTruck({
      ...rows[0],
      fleet_condition: fleetCondition,
      condition_reason: conditionReason,
      condition_updated_at: formatManilaDateTime(this.now().getTime())
    });
  }
}

const fleetService = new FleetService();

module.exports = fleetService;
module.exports.FleetService = FleetService;
module.exports.FleetServiceError = FleetServiceError;
module.exports.FLEET_CONDITIONS = FLEET_CONDITIONS;
module.exports.OPERATIONAL_STATES = OPERATIONAL_STATES;
module.exports.currentManilaDate = currentManilaDate;
module.exports.deriveFleetTruck = deriveFleetTruck;
module.exports.normalizeFleetCondition = normalizeFleetCondition;
module.exports.normalizeFleetError = normalizeFleetError;
