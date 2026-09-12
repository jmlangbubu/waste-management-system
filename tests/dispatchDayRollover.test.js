const assert = require("node:assert/strict");
const Module = require("node:module");

const originalModuleLoad = Module._load;
Module._load = function loadWithMockedPools(request, parent, isMain) {
  if (
    request === "../config/dbPromise" &&
    parent?.filename.replace(/\\/g, "/").includes("/services/")
  ) {
    return {};
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
const { DispatchService } = require("../services/dispatchService");
const { DispatchMonitorService } = require("../services/dispatchMonitorService");
const {
  assignmentActivationState
} = require("../services/dispatchPlanActivationService");
const { deriveFleetTruck } = require("../services/fleetService");
Module._load = originalModuleLoad;

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function createRolloverPool(options = {}) {
  const state = {
    session: {
      id: 58,
      truck_id: "TRUCK-9",
      enforcer_id: 13,
      enforcer_name: "Test Enforcer",
      session_status: "active",
      started_at: options.startedAt || "2026-09-12 08:00:00",
      ended_at: null,
      shift_end_time: "2026-09-13 00:00:00",
      effective_shift_end_time: "2026-09-13 00:00:00",
      last_updated_at: "2026-09-12 22:00:00",
      last_device_status: "active",
      last_location_status: "active",
      location_last_updated: "2026-09-12 22:00:00",
      dispatch_date: options.operationalDate || "2026-09-12"
    },
    ticket: {
      id: 91,
      status: options.ticketStatus || "in_progress",
      actual_end_at: null,
      cancelled_at: null,
      cancellation_reason: null
    },
    stops: options.stops || [
      { id: 11, stop_order: 1, stop_status: "completed" },
      { id: 12, stop_order: 2, stop_status: "on_the_way" },
      { id: 13, stop_order: 3, stop_status: "skipped" }
    ],
    lastLocationStatus: "active",
    events: [],
    commits: 0,
    rollbacks: 0
  };
  let transactionSnapshot = null;

  const connection = {
    async beginTransaction() {
      transactionSnapshot = JSON.parse(JSON.stringify({
        session: state.session,
        ticket: state.ticket,
        stops: state.stops,
        lastLocationStatus: state.lastLocationStatus,
        events: state.events
      }));
    },
    async commit() { state.commits += 1; },
    async rollback() {
      state.rollbacks += 1;
      Object.assign(state.session, transactionSnapshot.session);
      Object.assign(state.ticket, transactionSnapshot.ticket);
      state.stops.splice(0, state.stops.length, ...transactionSnapshot.stops);
      state.lastLocationStatus = transactionSnapshot.lastLocationStatus;
      state.events.splice(0, state.events.length, ...transactionSnapshot.events);
    },
    release() {},
    async query(sql, parameters = []) {
      const normalized = normalizeSql(sql);

      if (
        normalized.includes("FROM truck_tracking_sessions tts") &&
        normalized.includes("LEFT JOIN dispatch_tracking_sessions dts") &&
        normalized.includes("WHERE tts.id = ?")
      ) {
        return [[{ ...state.session }]];
      }
      if (
        normalized.includes("FROM dispatch_tracking_sessions dts") &&
        normalized.includes("INNER JOIN truck_tracking_sessions tts")
      ) {
        return [[{
          id: 301,
          dispatch_ticket_id: state.ticket.id,
          tracking_session_id: state.session.id,
          dispatch_status: state.ticket.status,
          enforcer_id: state.session.enforcer_id,
          enforcer_name: state.session.enforcer_name
        }]];
      }
      if (normalized.startsWith("SELECT id, stop_order, stop_status")) {
        return [[...state.stops.filter((stop) =>
          !["completed", "skipped"].includes(stop.stop_status))]];
      }
      if (normalized.startsWith("SELECT id FROM dispatch_events")) {
        const existing = state.events.find((event) =>
          event.idempotency_key === parameters[0]);
        return [[...(existing ? [{ id: existing.id }] : [])]];
      }
      if (normalized.startsWith("UPDATE truck_tracking_sessions")) {
        if (state.session.session_status !== "active") {
          return [{ affectedRows: 0 }];
        }
        state.session.session_status = "auto_stopped";
        state.session.ended_at = parameters[0];
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith("UPDATE truck_last_locations")) {
        state.lastLocationStatus = parameters[0];
        return [{ affectedRows: 1 }];
      }
      if (normalized.includes("SET status = 'cancelled'")) {
        state.ticket.status = "cancelled";
        state.ticket.actual_end_at = parameters[0];
        state.ticket.cancelled_at = parameters[1];
        state.ticket.cancellation_reason = parameters[2];
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith("INSERT INTO dispatch_events")) {
        if (options.failEventInsert) {
          throw new Error("Synthetic event insert failure");
        }
        state.events.push({
          id: state.events.length + 1,
          event_type: parameters[3],
          event_at: parameters[4],
          event_source: parameters[5],
          actor_type: parameters[6],
          latitude: parameters[9],
          longitude: parameters[10],
          details: parameters[12] ? JSON.parse(parameters[12]) : null,
          idempotency_key: parameters[13]
        });
        return [{ insertId: state.events.length }];
      }
      throw new Error(`Unexpected transaction SQL: ${normalized}`);
    }
  };

  const pool = {
    async query(sql, parameters = []) {
      const normalized = normalizeSql(sql);
      if (
        normalized.includes("SELECT tts.id AS tracking_session_id") &&
        normalized.includes("tts.session_status = 'active'")
      ) {
        const currentDate = parameters[0];
        const stale = state.session.session_status === "active" &&
          state.session.dispatch_date < currentDate;
        return [[...(stale
          ? [{ tracking_session_id: state.session.id }]
          : [])]];
      }
      throw new Error(`Unexpected pool SQL: ${normalized}`);
    },
    async getConnection() {
      return connection;
    }
  };

  return { pool, state };
}

async function testPreviousDayOperationRollsOverAtomically() {
  const { pool, state } = createRolloverPool();
  const service = new DispatchService(pool, {
    now: () => new Date("2026-09-13T00:15:00+08:00")
  });
  const originalStops = JSON.parse(JSON.stringify(state.stops));

  const result = await service.reconcileStaleActiveOperations();

  assert.equal(result.checked_count, 1);
  assert.equal(result.reconciled_count, 1);
  assert.equal(state.session.session_status, "auto_stopped");
  assert.equal(state.session.ended_at, "2026-09-13 00:00:00");
  assert.equal(state.ticket.status, "cancelled");
  assert.equal(state.ticket.actual_end_at, "2026-09-13 00:00:00");
  assert.deepEqual(state.stops, originalStops);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].event_type, "dispatch_forced_day_rollover");
  assert.equal(state.events[0].event_at, "2026-09-13 00:00:00");
  assert.equal(state.events[0].event_source, "system");
  assert.equal(state.events[0].actor_type, "system");
  assert.equal(state.events[0].latitude, null);
  assert.equal(state.events[0].longitude, null);
  assert.equal(state.events.some((event) =>
    event.event_type === "dispatch_completed"), false);
  assert.equal(state.commits, 1);
  assert.equal(state.rollbacks, 0);
}

async function testCurrentDayOperationIsUntouched() {
  const { pool, state } = createRolloverPool({
    operationalDate: "2026-09-13",
    startedAt: "2026-09-13 08:00:00"
  });
  const service = new DispatchService(pool, {
    now: () => new Date("2026-09-13T12:00:00+08:00")
  });

  const result = await service.reconcileStaleActiveOperations();

  assert.equal(result.checked_count, 0);
  assert.equal(result.reconciled_count, 0);
  assert.equal(state.session.session_status, "active");
  assert.equal(state.ticket.status, "in_progress");
  assert.equal(state.commits, 0);
}

async function testTerminalStopsWithoutVerifiedReturnCancelAtMidnight() {
  const { pool, state } = createRolloverPool({
    stops: [
      { id: 11, stop_order: 1, stop_status: "completed" },
      { id: 12, stop_order: 2, stop_status: "skipped" }
    ]
  });
  const service = new DispatchService(pool, {
    now: () => new Date("2026-09-13T00:15:00+08:00")
  });

  const result = await service.reconcileStaleActiveOperations();

  assert.equal(result.reconciled_count, 1);
  assert.equal(state.session.session_status, "auto_stopped");
  assert.equal(state.ticket.status, "cancelled");
  assert.equal(state.events[0].event_type, "dispatch_forced_day_rollover");
  assert.equal(state.events[0].details.unfinished_stop_count, 0);
  assert.equal(state.events.some((event) =>
    event.event_type === "dispatch_completed"), false);
}

async function testRolloverTransactionDoesNotLeavePartialTerminalState() {
  const { pool, state } = createRolloverPool({ failEventInsert: true });
  const service = new DispatchService(pool, {
    now: () => new Date("2026-09-13T00:15:00+08:00")
  });

  await assert.rejects(() => service.reconcileStaleActiveOperations());

  assert.equal(state.session.session_status, "active");
  assert.equal(state.session.ended_at, null);
  assert.equal(state.ticket.status, "in_progress");
  assert.equal(state.events.length, 0);
  assert.equal(state.commits, 0);
  assert.equal(state.rollbacks, 1);
}

async function testRolloverReleasesActivationAndFleetActiveGates() {
  const { pool, state } = createRolloverPool();
  const service = new DispatchService(pool, {
    now: () => new Date("2026-09-13T00:15:00+08:00")
  });

  await service.reconcileStaleActiveOperations();

  const activeSessionConflict = state.session.session_status === "active";
  const activeTicketConflict = [
    "prepared",
    "dispatched",
    "in_progress",
    "returning_to_wmo"
  ].includes(state.ticket.status);
  const activation = assignmentActivationState({
    operational_date: "2026-09-13",
    status: "planned",
    stop_count: 1,
    fleet_condition: "available",
    truck_code: "TRUCK-9",
    truck_code_snapshot: "TRUCK-9",
    has_active_truck_session: Number(activeSessionConflict),
    has_active_enforcer_session: Number(activeSessionConflict),
    has_truck_ticket_conflict: Number(activeTicketConflict),
    has_enforcer_ticket_conflict: Number(activeTicketConflict)
  }, "2026-09-13");
  const fleetTruck = deriveFleetTruck({
    id: 9,
    truck_code: "TRUCK-9",
    truck_name: "Truck 9",
    fleet_condition: "available"
  }, null, activeSessionConflict ? state.session : null, {
    id: 902,
    operational_date: "2026-09-13",
    status: "planned",
    route_name: "Current-day route"
  });

  assert.deepEqual(activation, {
    can_activate: true,
    activation_reason_code: null
  });
  assert.equal(fleetTruck.operational_state_key, "planned");
  assert.equal(fleetTruck.active_tracking_session_id, null);
}

async function testRolloverIsIdempotentAcrossMonitorRestarts() {
  const { pool, state } = createRolloverPool();
  const firstService = new DispatchService(pool, {
    now: () => new Date("2026-09-13T00:15:00+08:00")
  });
  const restartedService = new DispatchService(pool, {
    now: () => new Date("2026-09-13T01:30:00+08:00")
  });

  await firstService.reconcileStaleActiveOperations();
  const endedAt = state.session.ended_at;
  const repeated = await restartedService.reconcileStaleActiveOperations();

  assert.equal(repeated.checked_count, 0);
  assert.equal(repeated.reconciled_count, 0);
  assert.equal(state.session.ended_at, endedAt);
  assert.equal(state.events.length, 1);
}

async function testExistingMonitorOwnsRolloverScheduling() {
  const calls = [];
  const monitor = new DispatchMonitorService(
    { async query() { calls.push("relations"); return [[]]; } },
    {
      async reconcileStaleActiveOperations() {
        calls.push("rollover");
        return { reconciled_count: 0 };
      }
    }
  );
  monitor.started = true;
  monitor.scheduleNextRun = () => {};

  await monitor.runCycle();

  assert.deepEqual(calls, ["rollover", "relations"]);
  assert.equal(monitor.running, false);
}

async function run() {
  await testPreviousDayOperationRollsOverAtomically();
  await testCurrentDayOperationIsUntouched();
  await testTerminalStopsWithoutVerifiedReturnCancelAtMidnight();
  await testRolloverTransactionDoesNotLeavePartialTerminalState();
  await testRolloverReleasesActivationAndFleetActiveGates();
  await testRolloverIsIdempotentAcrossMonitorRestarts();
  await testExistingMonitorOwnsRolloverScheduling();
  console.log("Dispatch operational-day rollover tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
