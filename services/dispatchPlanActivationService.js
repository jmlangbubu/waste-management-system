const db = require("../config/dbPromise");
const dispatchServiceModule = require("./dispatchService");
const trackingServiceModule = require("./trackingService");
const {
  currentManilaDate,
  planStopSignature
} = require("./dispatchPlanService");

const { DispatchService, NON_TERMINAL_TICKET_STATUSES } = dispatchServiceModule;
const {
  TrackingStartEligibilityError
} = trackingServiceModule;

const MANILA_TIME_ZONE = "Asia/Manila";
const ACTION_ID_MAX_LENGTH = 160;
const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const ENFORCER_ROLE = "enforcer";

class MobileDispatchPlanError extends Error {
  constructor(
    message,
    statusCode = 400,
    code = "DISPATCH_PLAN_ACTIVATION_ERROR",
    cause = null
  ) {
    super(message);
    this.name = "MobileDispatchPlanError";
    this.statusCode = statusCode;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function positiveId(value, label = "dispatch plan id") {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new MobileDispatchPlanError(
      `${label} must be a positive integer`,
      400,
      "DISPATCH_PLAN_ID_INVALID"
    );
  }
  return id;
}

function normalizedRole(value) {
  return String(value || "").trim().toLowerCase();
}

function isEligibleEnforcer(user = {}) {
  return (
    normalizedRole(user.status) === "active" &&
    [user.mobile_role, user.role].some(
      (value) => normalizedRole(value) === ENFORCER_ROLE
    )
  );
}

function requireEligibleMobileUser(user = {}) {
  const id = Number(user.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new MobileDispatchPlanError(
      "Mobile authentication is required.",
      401,
      "MOBILE_SESSION_REQUIRED"
    );
  }
  if (!isEligibleEnforcer(user)) {
    throw new MobileDispatchPlanError(
      "This mobile account is not authorized to activate dispatch plans.",
      403,
      "DISPATCH_PLAN_ENFORCER_REQUIRED"
    );
  }
  return id;
}

function validateActivationActionId(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new MobileDispatchPlanError(
      "activation_action_id is required",
      400,
      "DISPATCH_PLAN_ACTIVATION_ACTION_REQUIRED"
    );
  }
  if (typeof value !== "string") {
    throw new MobileDispatchPlanError(
      "activation_action_id must be a stable opaque text identifier",
      400,
      "DISPATCH_PLAN_ACTIVATION_ACTION_INVALID"
    );
  }
  const actionId = value.trim();
  if (
    actionId.length > ACTION_ID_MAX_LENGTH ||
    !ACTION_ID_PATTERN.test(actionId)
  ) {
    throw new MobileDispatchPlanError(
      "activation_action_id has an invalid format",
      400,
      "DISPATCH_PLAN_ACTIVATION_ACTION_INVALID"
    );
  }
  return actionId;
}

function manilaDateTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MANILA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function nextCalendarDate(dateText) {
  const [year, month, day] = dateText.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

function safeDisplayName(user = {}) {
  return String(user.full_name || user.username || "Mobile Enforcer")
    .trim()
    .slice(0, 150) || "Mobile Enforcer";
}

function assignmentActivationState(plan, today) {
  if (plan.operational_date !== today) {
    return {
      can_activate: false,
      activation_reason_code: "DISPATCH_PLAN_OPERATIONAL_DATE_NOT_TODAY"
    };
  }
  if (plan.status === "activated") {
    return {
      can_activate: false,
      activation_reason_code: "DISPATCH_PLAN_ALREADY_ACTIVATED"
    };
  }
  if (plan.status !== "planned") {
    return {
      can_activate: false,
      activation_reason_code: "DISPATCH_PLAN_IMMUTABLE"
    };
  }
  if (!plan.scheduled_start_at) {
    return {
      can_activate: false,
      activation_reason_code: "DISPATCH_PLAN_SCHEDULE_REQUIRED"
    };
  }
  if (Number(plan.stop_count || 0) < 1) {
    return {
      can_activate: false,
      activation_reason_code: "DISPATCH_PLAN_STOPS_REQUIRED"
    };
  }
  if (normalizedRole(plan.fleet_condition) !== "available") {
    return {
      can_activate: false,
      activation_reason_code: "DISPATCH_PLAN_TRUCK_UNAVAILABLE"
    };
  }
  if (String(plan.truck_code || "") !== String(plan.truck_code_snapshot || "")) {
    return {
      can_activate: false,
      activation_reason_code: "DISPATCH_PLAN_TRUCK_SNAPSHOT_MISMATCH"
    };
  }
  if (Number(plan.has_active_truck_session || 0) === 1) {
    return {
      can_activate: false,
      activation_reason_code: "DISPATCH_TRUCK_ALREADY_TRACKING"
    };
  }
  if (Number(plan.has_active_enforcer_session || 0) === 1) {
    return {
      can_activate: false,
      activation_reason_code: "DISPATCH_PLAN_ENFORCER_OPERATION_CONFLICT"
    };
  }
  if (Number(plan.has_truck_ticket_conflict || 0) === 1) {
    return {
      can_activate: false,
      activation_reason_code: "DISPATCH_TRUCK_ALREADY_ASSIGNED"
    };
  }
  if (Number(plan.has_enforcer_ticket_conflict || 0) === 1) {
    return {
      can_activate: false,
      activation_reason_code: "DISPATCH_PLAN_ENFORCER_OPERATION_CONFLICT"
    };
  }
  return { can_activate: true, activation_reason_code: null };
}

function normalizeAssignment(plan, stops, today) {
  if (!plan) return null;
  return {
    id: Number(plan.id),
    status: plan.status,
    operational_date: plan.operational_date,
    truck: {
      fleet_truck_id: Number(plan.fleet_truck_id),
      truck_code: plan.truck_code_snapshot,
      truck_name: plan.truck_name_snapshot
    },
    route_name: plan.route_name,
    route_description: plan.route_description || null,
    scheduled_start: plan.scheduled_start_at || null,
    expected_return: plan.expected_return_at || null,
    stops,
    ...assignmentActivationState(plan, today),
    linked_dispatch_ticket_id: plan.activated_dispatch_ticket_id === null
      ? null
      : Number(plan.activated_dispatch_ticket_id),
    linked_tracking_session_id: plan.activated_tracking_session_id === null
      ? null
      : Number(plan.activated_tracking_session_id)
  };
}

function knownOperationalError(error) {
  return Boolean(
    error &&
    Number.isInteger(Number(error.statusCode)) &&
    typeof error.code === "string" &&
    error.code
  );
}

function normalizeActivationError(error) {
  if (error instanceof MobileDispatchPlanError) return error;
  if (error instanceof TrackingStartEligibilityError) return error;
  if (knownOperationalError(error)) return error;

  const detail = `${error?.code || ""} ${error?.sqlMessage || ""} ${error?.message || ""}`;
  if (
    error?.code === "ER_DUP_ENTRY" &&
    /uq_dispatch_plans_activation_action|activation_action_id/i.test(detail)
  ) {
    return new MobileDispatchPlanError(
      "activation_action_id is already associated with another dispatch plan",
      409,
      "DISPATCH_PLAN_ACTIVATION_ACTION_CONFLICT",
      error
    );
  }
  return new MobileDispatchPlanError(
    "Dispatch plan activation is temporarily unavailable",
    503,
    "DISPATCH_PLAN_ACTIVATION_UNAVAILABLE",
    error
  );
}

class DispatchPlanActivationService {
  constructor(pool = db, options = {}) {
    this.db = pool;
    this.now = typeof options.now === "function" ? options.now : () => new Date();
    this.dispatchService = options.dispatchService || new DispatchService(pool, {
      now: this.now
    });
    this.trackingService = options.trackingService || trackingServiceModule;
    this.failureInjector = typeof options.failureInjector === "function"
      ? options.failureInjector
      : null;
    this.notifyTrackingStarted = options.notifyTrackingStarted || (async (session) => (
      this.trackingService.createGpsTrackingNotification("on", {
        truck_id: session.truck_id,
        enforcer_id: session.enforcer_id,
        enforcer_name: session.enforcer_name,
        session_id: session.id
      })
    ));
  }

  async checkpoint(name, context = {}) {
    if (this.failureInjector) {
      await this.failureInjector(name, context);
    }
  }

  async query(sql, parameters = []) {
    try {
      return await this.db.query(sql, parameters);
    } catch (error) {
      throw normalizeActivationError(error);
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
            "[MobileDispatchPlan] Transaction rollback warning:",
            rollbackError.code || rollbackError.message
          );
        }
      }
      throw normalizeActivationError(error);
    } finally {
      if (connection) connection.release();
    }
  }

  async listAssignments(mobileUser = {}) {
    const userId = requireEligibleMobileUser(mobileUser);
    const now = this.now();
    const today = currentManilaDate(now);
    const tomorrow = nextCalendarDate(today);
    const statuses = [...NON_TERMINAL_TICKET_STATUSES];
    const statusPlaceholders = statuses.map(() => "?").join(", ");
    const [rows] = await this.query(
      `
        SELECT
          dp.id,
          DATE_FORMAT(dp.operational_date, '%Y-%m-%d') AS operational_date,
          dp.status,
          dp.fleet_truck_id,
          dp.truck_code_snapshot,
          dp.truck_name_snapshot,
          dp.route_name,
          dp.route_description,
          DATE_FORMAT(dp.scheduled_start_at, '%Y-%m-%d %H:%i:%s') AS scheduled_start_at,
          DATE_FORMAT(dp.expected_return_at, '%Y-%m-%d %H:%i:%s') AS expected_return_at,
          dp.activated_dispatch_ticket_id,
          dp.activated_tracking_session_id,
          ft.truck_code,
          ft.fleet_condition,
          (SELECT COUNT(*) FROM dispatch_plan_stops dps_count
            WHERE dps_count.dispatch_plan_id = dp.id) AS stop_count,
          EXISTS(
            SELECT 1 FROM truck_tracking_sessions tts_truck
            WHERE CONVERT(tts_truck.truck_id USING utf8mb4)
                    COLLATE utf8mb4_unicode_ci = dp.truck_code_snapshot
              AND tts_truck.session_status = 'active'
          ) AS has_active_truck_session,
          EXISTS(
            SELECT 1 FROM truck_tracking_sessions tts_enforcer
            WHERE tts_enforcer.enforcer_id = dp.assigned_enforcer_user_id
              AND tts_enforcer.session_status = 'active'
          ) AS has_active_enforcer_session,
          EXISTS(
            SELECT 1 FROM dispatch_tickets dt_truck
            WHERE CONVERT(dt_truck.truck_id USING utf8mb4)
                    COLLATE utf8mb4_unicode_ci = dp.truck_code_snapshot
              AND dt_truck.status IN (${statusPlaceholders})
          ) AS has_truck_ticket_conflict,
          EXISTS(
            SELECT 1 FROM dispatch_tickets dt_enforcer
            WHERE dt_enforcer.assigned_personnel_id = dp.assigned_enforcer_user_id
              AND dt_enforcer.status IN (${statusPlaceholders})
          ) AS has_enforcer_ticket_conflict
        FROM dispatch_plans dp
        INNER JOIN fleet_trucks ft ON ft.id = dp.fleet_truck_id
        WHERE dp.assigned_enforcer_user_id = ?
          AND dp.operational_date IN (?, ?)
        ORDER BY
          dp.operational_date ASC,
          CASE dp.status
            WHEN 'activated' THEN 0
            WHEN 'planned' THEN 1
            ELSE 2
          END ASC,
          dp.id DESC
      `,
      [...statuses, ...statuses, userId, today, tomorrow]
    );

    const selected = new Map();
    for (const row of rows) {
      if (!selected.has(row.operational_date)) {
        selected.set(row.operational_date, row);
      }
    }

    const selectedPlans = [...selected.values()];
    const stopsByPlan = new Map();
    if (selectedPlans.length) {
      const ids = selectedPlans.map((plan) => Number(plan.id));
      const [stopRows] = await this.query(
        `
          SELECT
            dispatch_plan_id,
            stop_order,
            location_name_snapshot,
            address_reference_snapshot,
            latitude,
            longitude,
            geofence_radius_meters,
            DATE_FORMAT(expected_arrival_at, '%Y-%m-%d %H:%i:%s') AS expected_arrival
          FROM dispatch_plan_stops
          WHERE dispatch_plan_id IN (${ids.map(() => "?").join(", ")})
          ORDER BY dispatch_plan_id ASC, stop_order ASC, id ASC
        `,
        ids
      );
      for (const stop of stopRows) {
        const planId = Number(stop.dispatch_plan_id);
        if (!stopsByPlan.has(planId)) stopsByPlan.set(planId, []);
        stopsByPlan.get(planId).push({
          stop_order: Number(stop.stop_order),
          location_name: stop.location_name_snapshot,
          address_reference: stop.address_reference_snapshot || null,
          latitude: Number(stop.latitude),
          longitude: Number(stop.longitude),
          geofence_radius_meters: Number(stop.geofence_radius_meters),
          expected_arrival: stop.expected_arrival || null
        });
      }
    }

    const assignmentFor = (date) => {
      const plan = selected.get(date);
      return normalizeAssignment(
        plan,
        plan ? stopsByPlan.get(Number(plan.id)) || [] : [],
        today
      );
    };

    return {
      server_date: today,
      server_time: manilaDateTime(now),
      time_zone: MANILA_TIME_ZONE,
      today_assignment: assignmentFor(today),
      tomorrow_assignment: assignmentFor(tomorrow)
    };
  }

  async loadPlanForUpdate(connection, planId) {
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
          activation_action_id,
          activated_dispatch_ticket_id,
          activated_tracking_session_id,
          DATE_FORMAT(activated_at, '%Y-%m-%d %H:%i:%s') AS activated_at,
          revision
        FROM dispatch_plans
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [planId]
    );
    if (!rows.length) {
      throw new MobileDispatchPlanError(
        "Dispatch plan not found",
        404,
        "DISPATCH_PLAN_NOT_FOUND"
      );
    }
    return rows[0];
  }

  async loadActivationResult(connection, planId, alreadyActivated) {
    const [rows] = await connection.query(
      `
        SELECT
          dp.id AS plan_id,
          dp.status AS plan_status,
          DATE_FORMAT(dp.operational_date, '%Y-%m-%d') AS operational_date,
          DATE_FORMAT(dp.activated_at, '%Y-%m-%d %H:%i:%s') AS activated_at,
          dp.fleet_truck_id,
          dp.truck_code_snapshot,
          dp.truck_name_snapshot,
          dt.id AS ticket_id,
          dt.ticket_number,
          dt.status AS ticket_status,
          tts.id AS session_id,
          tts.session_status,
          DATE_FORMAT(tts.started_at, '%Y-%m-%d %H:%i:%s') AS started_at
        FROM dispatch_plans dp
        INNER JOIN dispatch_tickets dt
          ON dt.id = dp.activated_dispatch_ticket_id
        INNER JOIN truck_tracking_sessions tts
          ON tts.id = dp.activated_tracking_session_id
        INNER JOIN dispatch_tracking_sessions dts
          ON dts.dispatch_ticket_id = dt.id
         AND dts.tracking_session_id = tts.id
         AND dts.unlinked_at IS NULL
        WHERE dp.id = ?
          AND dp.status = 'activated'
        LIMIT 1
      `,
      [planId]
    );
    if (!rows.length) {
      throw new MobileDispatchPlanError(
        "The activated dispatch plan has inconsistent operational links",
        409,
        "DISPATCH_PLAN_ACTIVATION_INCONSISTENT"
      );
    }
    const row = rows[0];
    const [stopRows] = await connection.query(
      `
        SELECT
          stop_order,
          location_name,
          address_reference,
          latitude,
          longitude,
          geofence_radius_meters,
          DATE_FORMAT(expected_arrival_at, '%Y-%m-%d %H:%i:%s') AS expected_arrival,
          stop_status
        FROM dispatch_route_stops
        WHERE dispatch_ticket_id = ?
        ORDER BY stop_order ASC, id ASC
      `,
      [row.ticket_id]
    );
    return {
      already_activated: alreadyActivated === true,
      plan: {
        id: Number(row.plan_id),
        status: row.plan_status,
        operational_date: row.operational_date,
        activated_at: row.activated_at
      },
      dispatch_ticket: {
        id: Number(row.ticket_id),
        ticket_number: row.ticket_number,
        status: row.ticket_status
      },
      tracking_session: {
        id: Number(row.session_id),
        session_status: row.session_status,
        started_at: row.started_at
      },
      truck: {
        fleet_truck_id: Number(row.fleet_truck_id),
        truck_id: row.truck_code_snapshot,
        truck_name: row.truck_name_snapshot
      },
      stops: stopRows.map((stop) => ({
        stop_order: Number(stop.stop_order),
        location_name: stop.location_name,
        address_reference: stop.address_reference || null,
        latitude: Number(stop.latitude),
        longitude: Number(stop.longitude),
        geofence_radius_meters: Number(stop.geofence_radius_meters),
        expected_arrival: stop.expected_arrival || null,
        stop_status: stop.stop_status
      }))
    };
  }

  async assertNoOperationalConflicts(connection, plan) {
    const [truckSessions] = await connection.query(
      `
        SELECT id FROM truck_tracking_sessions
        WHERE truck_id = ? AND session_status = 'active'
        ORDER BY id ASC LIMIT 1 FOR UPDATE
      `,
      [plan.truck_code_snapshot]
    );
    if (truckSessions.length) {
      throw new MobileDispatchPlanError(
        "The planned truck already has an active tracking session",
        409,
        "DISPATCH_TRUCK_ALREADY_TRACKING"
      );
    }

    const [enforcerSessions] = await connection.query(
      `
        SELECT id FROM truck_tracking_sessions
        WHERE enforcer_id = ? AND session_status = 'active'
        ORDER BY id ASC LIMIT 1 FOR UPDATE
      `,
      [plan.assigned_enforcer_user_id]
    );
    if (enforcerSessions.length) {
      throw new MobileDispatchPlanError(
        "The assigned enforcer already has an active tracking session",
        409,
        "DISPATCH_PLAN_ENFORCER_OPERATION_CONFLICT"
      );
    }

    const statuses = [...NON_TERMINAL_TICKET_STATUSES];
    const placeholders = statuses.map(() => "?").join(", ");
    const [truckTickets] = await connection.query(
      `
        SELECT id FROM dispatch_tickets
        WHERE truck_id = ? AND status IN (${placeholders})
        ORDER BY id ASC LIMIT 1 FOR UPDATE
      `,
      [plan.truck_code_snapshot, ...statuses]
    );
    if (truckTickets.length) {
      throw new MobileDispatchPlanError(
        "The planned truck already has a nonterminal dispatch ticket",
        409,
        "DISPATCH_TRUCK_ALREADY_ASSIGNED"
      );
    }

    const [enforcerTickets] = await connection.query(
      `
        SELECT id FROM dispatch_tickets
        WHERE assigned_personnel_id = ? AND status IN (${placeholders})
        ORDER BY id ASC LIMIT 1 FOR UPDATE
      `,
      [plan.assigned_enforcer_user_id, ...statuses]
    );
    if (enforcerTickets.length) {
      throw new MobileDispatchPlanError(
        "The assigned enforcer already has a nonterminal dispatch ticket",
        409,
        "DISPATCH_PLAN_ENFORCER_OPERATION_CONFLICT"
      );
    }
  }

  async activatePlan(planIdValue, payload = {}, mobileUser = {}, mobileSession = {}) {
    const planId = positiveId(planIdValue);
    const userId = requireEligibleMobileUser(mobileUser);
    const actionId = validateActivationActionId(payload.activation_action_id);
    const receivedAt = this.now();
    const today = currentManilaDate(receivedAt);
    const startedAt = manilaDateTime(receivedAt);

    const transactionResult = await this.withTransaction(async (connection) => {
      const plan = await this.loadPlanForUpdate(connection, planId);

      if (Number(plan.assigned_enforcer_user_id) !== userId) {
        throw new MobileDispatchPlanError(
          "This dispatch plan is assigned to another enforcer",
          403,
          "DISPATCH_PLAN_NOT_ASSIGNED_TO_USER"
        );
      }

      if (plan.status === "activated") {
        if (
          plan.activation_action_id === actionId &&
          plan.activated_dispatch_ticket_id &&
          plan.activated_tracking_session_id
        ) {
          return {
            data: await this.loadActivationResult(connection, planId, true),
            notificationSession: null
          };
        }
        const [conflictingActionRows] = await connection.query(
          `
            SELECT id FROM dispatch_plans
            WHERE activation_action_id = ? AND id <> ?
            LIMIT 1 FOR UPDATE
          `,
          [actionId, planId]
        );
        if (conflictingActionRows.length) {
          throw new MobileDispatchPlanError(
            "activation_action_id is already associated with another dispatch plan",
            409,
            "DISPATCH_PLAN_ACTIVATION_ACTION_CONFLICT"
          );
        }
        throw new MobileDispatchPlanError(
          "This dispatch plan has already been activated",
          409,
          "DISPATCH_PLAN_ALREADY_ACTIVATED"
        );
      }

      if (plan.status !== "planned") {
        throw new MobileDispatchPlanError(
          "Only a planned dispatch plan may be activated",
          409,
          "DISPATCH_PLAN_IMMUTABLE"
        );
      }
      if (plan.operational_date !== today) {
        throw new MobileDispatchPlanError(
          "The dispatch plan can be activated only on its Asia/Manila operational date",
          409,
          "DISPATCH_PLAN_OPERATIONAL_DATE_NOT_TODAY"
        );
      }
      if (
        plan.activation_action_id ||
        plan.activated_dispatch_ticket_id ||
        plan.activated_tracking_session_id
      ) {
        throw new MobileDispatchPlanError(
          "The planned dispatch has inconsistent activation links",
          409,
          "DISPATCH_PLAN_ACTIVATION_INCONSISTENT"
        );
      }

      const [actionRows] = await connection.query(
        `
          SELECT id FROM dispatch_plans
          WHERE activation_action_id = ? AND id <> ?
          LIMIT 1 FOR UPDATE
        `,
        [actionId, planId]
      );
      if (actionRows.length) {
        throw new MobileDispatchPlanError(
          "activation_action_id is already associated with another dispatch plan",
          409,
          "DISPATCH_PLAN_ACTIVATION_ACTION_CONFLICT"
        );
      }

      const [userRows] = await connection.query(
        `
          SELECT id, full_name, username, role, mobile_role, status
          FROM users WHERE id = ? LIMIT 1 FOR UPDATE
        `,
        [userId]
      );
      if (!userRows.length || normalizedRole(userRows[0].status) !== "active") {
        throw new MobileDispatchPlanError(
          "The assigned mobile account is inactive or unavailable",
          403,
          "MOBILE_SESSION_ACCOUNT_INACTIVE"
        );
      }
      if (!isEligibleEnforcer(userRows[0])) {
        throw new MobileDispatchPlanError(
          "The assigned mobile account is not an eligible enforcer",
          403,
          "DISPATCH_PLAN_ENFORCER_REQUIRED"
        );
      }

      const [truckRows] = await connection.query(
        `
          SELECT id, truck_code, truck_name, fleet_condition
          FROM fleet_trucks WHERE id = ? LIMIT 1 FOR UPDATE
        `,
        [plan.fleet_truck_id]
      );
      if (!truckRows.length) {
        throw new MobileDispatchPlanError(
          "The fleet truck assigned to this plan was not found",
          409,
          "FLEET_TRUCK_NOT_FOUND"
        );
      }
      const truck = truckRows[0];
      if (normalizedRole(truck.fleet_condition) !== "available") {
        throw new MobileDispatchPlanError(
          "The fleet truck is not available for dispatch",
          409,
          "DISPATCH_PLAN_TRUCK_UNAVAILABLE"
        );
      }
      if (String(truck.truck_code) !== String(plan.truck_code_snapshot)) {
        throw new MobileDispatchPlanError(
          "The plan truck snapshot no longer matches the fleet master record",
          409,
          "DISPATCH_PLAN_TRUCK_SNAPSHOT_MISMATCH"
        );
      }
      if (!plan.scheduled_start_at) {
        throw new MobileDispatchPlanError(
          "The plan requires a scheduled start before activation",
          409,
          "DISPATCH_PLAN_SCHEDULE_REQUIRED"
        );
      }

      const [planStops] = await connection.query(
        `
          SELECT
            id,
            stop_order,
            location_name_snapshot,
            address_reference_snapshot,
            latitude,
            longitude,
            geofence_radius_meters,
            DATE_FORMAT(expected_arrival_at, '%Y-%m-%d %H:%i:%s') AS expected_arrival_at
          FROM dispatch_plan_stops
          WHERE dispatch_plan_id = ?
          ORDER BY stop_order ASC, id ASC
          FOR UPDATE
        `,
        [planId]
      );
      if (!planStops.length) {
        throw new MobileDispatchPlanError(
          "At least one stored plan stop is required for activation",
          409,
          "DISPATCH_PLAN_STOPS_REQUIRED"
        );
      }
      if (planStopSignature(planStops) !== plan.stop_signature) {
        throw new MobileDispatchPlanError(
          "The stored plan stops no longer match the approved stop signature",
          409,
          "DISPATCH_PLAN_STOP_SIGNATURE_MISMATCH"
        );
      }

      await this.assertNoOperationalConflicts(connection, plan);
      const startLocation = this.trackingService.validateNewTrackingStartLocation(
        payload,
        receivedAt.getTime()
      );
      const dispatchYear = Number(today.slice(0, 4));
      const ticketNumber = await this.dispatchService.generateTicketNumber(
        connection,
        dispatchYear
      );
      const enforcerName = String(
        plan.assigned_enforcer_name_snapshot || safeDisplayName(userRows[0])
      ).trim().slice(0, 150) || safeDisplayName(userRows[0]);
      const actor = {
        actor_type: "mobile_enforcer",
        actor_id: userId,
        actor_name: enforcerName
      };
      const operationalStops = planStops.map((stop) => ({
        stop_order: Number(stop.stop_order),
        location_name: stop.location_name_snapshot,
        address_reference: stop.address_reference_snapshot || null,
        latitude: Number(stop.latitude),
        longitude: Number(stop.longitude),
        geofence_radius_meters: Number(stop.geofence_radius_meters),
        expected_arrival_at: stop.expected_arrival_at || null
      }));

      const ticketId = await this.dispatchService.insertPreparedTicketInTransaction(
        connection,
        {
          ticket_number: ticketNumber,
          truck_id: plan.truck_code_snapshot,
          truck_name_snapshot: plan.truck_name_snapshot,
          assigned_personnel_id: userId,
          assigned_personnel_name: enforcerName,
          dispatch_date: plan.operational_date,
          scheduled_start_at: plan.scheduled_start_at,
          expected_return_at: plan.expected_return_at,
          route_name: plan.route_name,
          route_description: plan.route_description,
          notes: plan.notes,
          created_by_user_id: null,
          created_by_name: enforcerName,
          stops: operationalStops
        },
        {
          eventAt: startedAt,
          eventSource: "mobile",
          actorType: actor.actor_type,
          actorId: actor.actor_id,
          actorName: actor.actor_name,
          details: { dispatch_plan_id: planId },
          afterTicketInsert: (createdTicketId) => this.checkpoint(
            "ticket_creation",
            { planId, ticketId: createdTicketId }
          ),
          afterStopsInsert: (createdTicketId) => this.checkpoint(
            "stop_copy",
            { planId, ticketId: createdTicketId }
          ),
          afterPreparedEvent: (createdTicketId) => this.checkpoint(
            "event_creation",
            { planId, ticketId: createdTicketId }
          )
        }
      );

      await this.dispatchService.issueTicketInTransaction(
        connection,
        { id: ticketId },
        { eventAt: startedAt, eventSource: "mobile", actor }
      );

      const trackingSession = await this.trackingService.createTrackingSessionWithConnection(
        connection,
        {
          truck_id: plan.truck_code_snapshot,
          enforcer_id: userId,
          enforcer_name: enforcerName,
          device_id: mobileSession.deviceId || null,
          started_at: startedAt,
          shift_end_time: plan.expected_return_at || startedAt,
          start_location: startLocation
        }
      );
      await this.checkpoint("tracking_session_creation", {
        planId,
        ticketId,
        trackingSessionId: trackingSession.id
      });

      await this.trackingService.upsertLastLocationWithConnection(connection, {
        truck_id: plan.truck_code_snapshot,
        session_id: trackingSession.id,
        latitude: startLocation.latitude,
        longitude: startLocation.longitude,
        speed: null,
        accuracy: startLocation.accuracy,
        heading: null,
        altitude: null,
        recorded_at: startLocation.recorded_at,
        status: "active"
      });
      await this.checkpoint("last_location_insertion", {
        planId,
        ticketId,
        trackingSessionId: trackingSession.id
      });

      await this.dispatchService.linkTrackingSessionRecordInTransaction(
        connection,
        ticketId,
        trackingSession.id,
        "mobile_plan_activation"
      );
      await this.checkpoint("ticket_session_linkage", {
        planId,
        ticketId,
        trackingSessionId: trackingSession.id
      });

      await this.dispatchService.startLinkedDispatchInTransaction(
        connection,
        { id: ticketId },
        trackingSession,
        "mobile_plan_activation",
        actor,
        { eventSource: "mobile" }
      );
      await this.checkpoint("ticket_in_progress", {
        planId,
        ticketId,
        trackingSessionId: trackingSession.id
      });

      const [activationUpdate] = await connection.query(
        `
          UPDATE dispatch_plans
          SET status = 'activated',
              activation_action_id = ?,
              activated_dispatch_ticket_id = ?,
              activated_tracking_session_id = ?,
              activated_at = ?,
              revision = revision + 1,
              updated_at = NOW(3)
          WHERE id = ? AND status = 'planned'
        `,
        [actionId, ticketId, trackingSession.id, startedAt, planId]
      );
      if (Number(activationUpdate.affectedRows) !== 1) {
        throw new MobileDispatchPlanError(
          "The dispatch plan changed before activation could complete",
          409,
          "DISPATCH_PLAN_ACTIVATION_CONFLICT"
        );
      }
      await this.checkpoint("plan_activation_update", {
        planId,
        ticketId,
        trackingSessionId: trackingSession.id
      });

      return {
        data: await this.loadActivationResult(connection, planId, false),
        notificationSession: trackingSession
      };
    });

    let notification = null;
    if (transactionResult.notificationSession) {
      try {
        notification = await this.notifyTrackingStarted(
          transactionResult.notificationSession
        );
      } catch (error) {
        console.warn(
          "[MobileDispatchPlan] Post-commit notification warning:",
          error?.code || error?.message || "NOTIFICATION_FAILED"
        );
      }
    }
    return { data: transactionResult.data, notification };
  }
}

const dispatchPlanActivationService = new DispatchPlanActivationService();

module.exports = dispatchPlanActivationService;
module.exports.DispatchPlanActivationService = DispatchPlanActivationService;
module.exports.MobileDispatchPlanError = MobileDispatchPlanError;
module.exports.MANILA_TIME_ZONE = MANILA_TIME_ZONE;
module.exports.ACTION_ID_MAX_LENGTH = ACTION_ID_MAX_LENGTH;
module.exports.ACTION_ID_PATTERN = ACTION_ID_PATTERN;
module.exports.isEligibleEnforcer = isEligibleEnforcer;
module.exports.requireEligibleMobileUser = requireEligibleMobileUser;
module.exports.validateActivationActionId = validateActivationActionId;
module.exports.manilaDateTime = manilaDateTime;
module.exports.nextCalendarDate = nextCalendarDate;
module.exports.assignmentActivationState = assignmentActivationState;
module.exports.normalizeActivationError = normalizeActivationError;
