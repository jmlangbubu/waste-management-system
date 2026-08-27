const assert = require("node:assert/strict");
const Module = require("node:module");

const originalModuleLoad = Module._load;
Module._load = function loadWithMockedDispatchPool(request, parent, isMain) {
  if (
    request === "../config/dbPromise" &&
    parent?.filename.replace(/\\/g, "/").endsWith("services/dispatchService.js")
  ) {
    return {};
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
const { DispatchService } = require("../services/dispatchService");
Module._load = originalModuleLoad;

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function createPool(options = {}) {
  const state = {
    ticket: {
      id: 91,
      status: options.status || "in_progress",
      actual_end_at: null,
      completed_at: null,
      cancelled_at: null,
      cancellation_reason: null
    },
    stops: options.stops || [
      { id: 11, stop_order: 1, stop_status: "completed" },
      { id: 12, stop_order: 2, stop_status: "on_the_way" }
    ],
    events: options.events ? [...options.events] : [],
    commits: 0,
    rollbacks: 0
  };

  const connection = {
    async beginTransaction() {},
    async commit() { state.commits += 1; },
    async rollback() { state.rollbacks += 1; },
    release() {},
    async query(sql, parameters = []) {
      const normalized = normalizeSql(sql);
      if (normalized.includes("FROM dispatch_tracking_sessions dts") && normalized.includes("FOR UPDATE")) {
        return [[{
          id: 301,
          dispatch_ticket_id: 91,
          tracking_session_id: 58,
          dispatch_status: state.ticket.status,
          enforcer_id: 7,
          enforcer_name: "Field Enforcer"
        }]];
      }
      if (normalized.startsWith("SELECT id, stop_order, stop_status")) {
        return [[...state.stops.filter((stop) =>
          !["completed", "skipped"].includes(stop.stop_status))]];
      }
      if (normalized.startsWith("SELECT id FROM dispatch_route_stops")) {
        const remaining = state.stops.find((stop) =>
          !["completed", "skipped"].includes(stop.stop_status));
        return [[...(remaining ? [{ id: remaining.id }] : [])]];
      }
      if (normalized.startsWith("SELECT status FROM dispatch_tickets")) {
        return [[{ status: state.ticket.status }]];
      }
      if (normalized.startsWith("SELECT id FROM dispatch_events")) {
        const event = state.events.find((item) => item.idempotency_key === parameters[0]);
        return [[...(event ? [{ id: event.id }] : [])]];
      }
      if (normalized.includes("SET status = 'returning_to_wmo'")) {
        state.ticket.status = "returning_to_wmo";
        return [{ affectedRows: 1 }];
      }
      if (normalized.includes("SET status = 'completed'")) {
        state.ticket.status = "completed";
        state.ticket.actual_end_at = parameters[0];
        state.ticket.completed_at = parameters[1];
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
        state.events.push({
          id: state.events.length + 1,
          dispatch_ticket_id: parameters[0],
          tracking_session_id: parameters[2],
          event_type: parameters[3],
          event_at: parameters[4],
          actor_name: parameters[8],
          latitude: parameters[9],
          longitude: parameters[10],
          details: parameters[12] ? JSON.parse(parameters[12]) : null,
          idempotency_key: parameters[13]
        });
        return [{ insertId: state.events.length }];
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    }
  };
  return {
    state,
    pool: { async getConnection() { return connection; } }
  };
}

const END_EVIDENCE = Object.freeze({
  operation_intent: "end_operations",
  action_id: "END-58-20260827",
  recorded_at: "2026-08-27 16:55:00",
  latitude: 6.1060875,
  longitude: 125.1816406,
  accuracy: 8,
  distanceFromWmoMeters: 0
});

async function testUnfinishedEndOperationsProjectsDayEndIncomplete() {
  const { state, pool } = createPool();
  const service = new DispatchService(pool);
  const first = await service.finalizeMobileTrackingEnd(58, END_EVIDENCE);
  const repeated = await service.finalizeMobileTrackingEnd(58, END_EVIDENCE);

  assert.equal(first.outcome, "day_end_incomplete");
  assert.equal(repeated.outcome, "already_terminal");
  assert.equal(state.ticket.status, "cancelled");
  assert.equal(state.ticket.actual_end_at, END_EVIDENCE.recorded_at);
  assert.equal(state.ticket.cancelled_at, END_EVIDENCE.recorded_at);
  assert.equal(state.events.filter((event) =>
    event.event_type === "dispatch_day_end_incomplete").length, 1);
  assert.equal(state.events.filter((event) =>
    event.event_type === "dispatch_closed_early").length, 0);
  assert.equal(state.events.filter((event) =>
    event.event_type === "dispatch_completed").length, 0);
  assert.equal(state.events.find((event) =>
    event.event_type === "dispatch_day_end_incomplete").details.unfinished_stop_count, 1);
  assert.equal(state.events.find((event) =>
    event.event_type === "dispatch_day_end_incomplete").event_at, END_EVIDENCE.recorded_at);
}

async function testAllTerminalExplicitReturnUsesCompletedLifecycle() {
  const { state, pool } = createPool({
    stops: [
      { id: 11, stop_order: 1, stop_status: "completed" },
      { id: 12, stop_order: 2, stop_status: "skipped" }
    ]
  });
  const service = new DispatchService(pool);
  const result = await service.finalizeMobileTrackingEnd(58, END_EVIDENCE);

  assert.equal(result.outcome, "completed");
  assert.equal(state.ticket.status, "completed");
  assert.equal(state.events.filter((event) => event.event_type === "returned_to_wmo").length, 1);
  assert.equal(state.events.filter((event) => event.event_type === "dispatch_completed").length, 1);
  assert.equal(state.events.filter((event) => event.event_type.includes("day_end")).length, 0);
}

async function testForcedRolloverNeverFabricatesReturnOrCompletion() {
  const { state, pool } = createPool();
  const service = new DispatchService(pool);
  const result = await service.finalizeMobileTrackingEnd(58, {
    operation_intent: "forced_day_rollover",
    action_id: "ROLLOVER-58-20260828",
    recorded_at: "2026-08-28 00:00:00",
    latitude: null,
    longitude: null,
    accuracy: null
  });

  assert.equal(result.outcome, "day_end_incomplete");
  assert.equal(state.ticket.status, "cancelled");
  assert.equal(state.events.filter((event) =>
    event.event_type === "dispatch_forced_day_rollover").length, 1);
  assert.equal(state.events.some((event) => event.event_type === "returned_to_wmo"), false);
  assert.equal(state.events.some((event) => event.event_type === "dispatch_completed"), false);
  const event = state.events[0];
  assert.equal(event.latitude, null);
  assert.equal(event.longitude, null);
}

async function testTerminalTicketsAreNeverOverwritten() {
  for (const fixture of [
    { status: "completed", event: "dispatch_completed" },
    { status: "cancelled", event: "dispatch_closed_early" }
  ]) {
    const { state, pool } = createPool({
      status: fixture.status,
      events: [{ id: 1, event_type: fixture.event, idempotency_key: fixture.event }]
    });
    const service = new DispatchService(pool);
    const result = await service.finalizeMobileTrackingEnd(58, END_EVIDENCE);
    assert.equal(result.outcome, "already_terminal");
    assert.equal(state.ticket.status, fixture.status);
    assert.deepEqual(state.events.map((event) => event.event_type), [fixture.event]);
  }
}

async function testLunchReturnWithoutIntentDoesNothing() {
  const { state, pool } = createPool();
  const service = new DispatchService(pool);
  const result = await service.finalizeMobileTrackingEnd(58, {});
  assert.equal(result.outcome, "no_lifecycle_intent");
  assert.equal(state.ticket.status, "in_progress");
  assert.equal(state.events.length, 0);
  assert.equal(state.commits, 0);
}

async function testPreparedLinkedTicketIsNotChanged() {
  const { state, pool } = createPool({ status: "prepared" });
  const service = new DispatchService(pool);
  const result = await service.finalizeMobileTrackingEnd(58, END_EVIDENCE);
  assert.equal(result.outcome, "dispatch_not_active");
  assert.equal(state.ticket.status, "prepared");
  assert.equal(state.events.length, 0);
}

async function testTerminalStopsAtMidnightAreNotFalselyCompletedOrCancelled() {
  const { state, pool } = createPool({
    stops: [{ id: 11, stop_order: 1, stop_status: "completed" }]
  });
  const service = new DispatchService(pool);
  const result = await service.finalizeMobileTrackingEnd(58, {
    operation_intent: "forced_day_rollover",
    action_id: "ROLLOVER-58-20260828",
    recorded_at: "2026-08-28 00:00:00"
  });
  assert.equal(result.outcome, "awaiting_verified_final_return");
  assert.equal(state.ticket.status, "in_progress");
  assert.equal(state.events.length, 0);
}

async function run() {
  await testUnfinishedEndOperationsProjectsDayEndIncomplete();
  await testAllTerminalExplicitReturnUsesCompletedLifecycle();
  await testForcedRolloverNeverFabricatesReturnOrCompletion();
  await testTerminalTicketsAreNeverOverwritten();
  await testLunchReturnWithoutIntentDoesNothing();
  await testPreparedLinkedTicketIsNotChanged();
  await testTerminalStopsAtMidnightAreNotFalselyCompletedOrCancelled();
  console.log("Dispatch end-operations tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
