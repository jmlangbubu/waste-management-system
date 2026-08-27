const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const projectRoot = path.join(__dirname, "..");
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
const dispatchModule = require("../services/dispatchService");
const {
  DispatchService,
  normalizeEndDispatchReason,
  durationSecondsBetween
} = dispatchModule;
Module._load = originalModuleLoad;

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function createClosurePool(initialStatus = "in_progress") {
  const state = {
    ticket: {
      id: 91,
      ticket_number: "DPT-2026-0091",
      status: initialStatus,
      actual_start_at: "2026-08-12 08:00:00"
    },
    events: [],
    calls: [],
    commits: 0,
    rollbacks: 0
  };
  const connection = {
    async beginTransaction() {},
    async commit() { state.commits += 1; },
    async rollback() { state.rollbacks += 1; },
    release() {},
    async query(sql, parameters = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      state.calls.push({ sql: normalized, parameters });
      if (normalized.startsWith("SELECT * FROM dispatch_tickets")) {
        return [[{ ...state.ticket }]];
      }
      if (normalized.startsWith("SELECT id FROM dispatch_events")) {
        return [[...state.events.map((event) => ({ id: event.id }))]];
      }
      if (normalized.startsWith("SELECT tracking_session_id")) {
        return [[{ tracking_session_id: 501 }]];
      }
      if (normalized.startsWith("UPDATE dispatch_tickets")) {
        state.ticket.status = "cancelled";
        state.ticket.actual_end_at = "2026-08-12 11:00:00";
        state.ticket.cancelled_at = "2026-08-12 11:00:00";
        state.ticket.cancellation_reason = parameters[0];
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith("INSERT INTO dispatch_events")) {
        state.events.push({
          id: state.events.length + 1,
          event_type: parameters[3],
          tracking_session_id: parameters[2],
          actor_id: parameters[7],
          actor_name: parameters[8],
          details: JSON.parse(parameters[12]),
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

async function testActiveDispatchCanBeClosedEarlyIdempotently() {
  const { state, pool } = createClosurePool();
  const service = new DispatchService(pool);
  service.getTicketDetails = async () => ({
    ticket: { ...state.ticket },
    stops: [{ id: 1 }, { id: 2 }],
    tracking_sessions: [{ tracking_session_id: 501 }]
  });
  const payload = {
    reason_code: "mechanical_issue",
    actor_type: "web_user",
    actor_id: 7,
    actor_name: "Trusted WMO Operator"
  };

  const result = await service.endDispatch(91, payload);
  assert.equal(result.ticket.status, "cancelled");
  assert.equal(result.ticket.cancellation_reason, "Mechanical issue");
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].event_type, "dispatch_closed_early");
  assert.equal(state.events[0].tracking_session_id, 501);
  assert.equal(state.events[0].actor_id, 7);
  assert.equal(state.events[0].actor_name, "Trusted WMO Operator");
  assert.equal(state.events[0].idempotency_key, "dispatch-closed-early:91");
  assert.equal(state.commits, 1);

  await service.endDispatch(91, payload);
  assert.equal(state.events.length, 1, "repeated closure must not duplicate its audit event");
  assert.equal(state.commits, 2);

  const sql = state.calls.map((call) => call.sql).join("\n");
  assert.doesNotMatch(sql, /DELETE FROM dispatch_tickets/i);
  assert.doesNotMatch(sql, /DELETE FROM dispatch_route_stops/i);
  assert.doesNotMatch(sql, /DELETE FROM dispatch_tracking_sessions/i);
  assert.doesNotMatch(sql, /UPDATE truck_tracking_sessions/i);
  assert.doesNotMatch(sql, /UPDATE truck_location_logs/i);
}

function testClosureReasonValidation() {
  assert.throws(
    () => normalizeEndDispatchReason({}),
    (error) => error.code === "DISPATCH_END_REASON_REQUIRED"
  );
  assert.throws(
    () => normalizeEndDispatchReason({ reason_code: "other" }),
    (error) => error.code === "DISPATCH_END_OTHER_REASON_REQUIRED"
  );
  assert.deepEqual(
    normalizeEndDispatchReason({
      reason_code: "other",
      other_reason: "Road access became unsafe"
    }),
    {
      reason_code: "other",
      reason_label: "Other",
      reason: "Other: Road access became unsafe",
      other_reason: "Road access became unsafe"
    }
  );
}

async function testCompletedDispatchCannotBeClosedEarly() {
  const { state, pool } = createClosurePool("completed");
  const service = new DispatchService(pool);
  await assert.rejects(
    () => service.endDispatch(91, {
      reason_code: "returned_early",
      actor_id: 7,
      actor_name: "Operator"
    }),
    (error) => error.code === "DISPATCH_ALREADY_COMPLETED"
  );
  assert.equal(state.ticket.status, "completed");
  assert.equal(state.events.length, 0);
  assert.equal(state.rollbacks, 1);
}

async function testReportListIsTicketCenteredAndExcludesActiveDispatches() {
  let reportSql = "";
  const service = new DispatchService({
    async query(sql) {
      reportSql = String(sql).replace(/\s+/g, " ").trim();
      return [[{
        id: 91,
        ticket_number: "DPT-2026-0091",
        status: "closed_early"
      }]];
    }
  });
  const rows = await service.getReports({});
  assert.equal(rows[0].ticket_number, "DPT-2026-0091");
  assert.match(reportSql, /dt\.status IN \('completed', 'cancelled'\)/);
  assert.doesNotMatch(reportSql, /dt\.status IN \('dispatched', 'in_progress'/);
  assert.match(reportSql, /dispatch_closed_early/);
  assert.match(reportSql, /dispatch_day_end_incomplete/);
  assert.match(reportSql, /dispatch_forced_day_rollover/);
  assert.match(reportSql, /primary_link\.tracking_session_id/);
  assert.match(
    reportSql,
    /FROM dispatch_route_stops GROUP BY dispatch_ticket_id \) stop_summary ON stop_summary\.dispatch_ticket_id = dt\.id/
  );
  assert.match(reportSql, /COALESCE\(stop_summary\.total_stops, 0\) AS total_stops/);
  assert.doesNotMatch(reportSql, /LEFT JOIN dispatch_route_stops drs/);
  assert.doesNotMatch(reportSql, /GROUP BY dt\.id/);
  assert.match(reportSql, /ORDER BY COALESCE\(dt\.actual_end_at/);
}

async function captureReportQuery(filters = {}, rows = []) {
  let reportSql = "";
  let reportParameters = null;
  const service = new DispatchService({
    async query(sql, parameters) {
      reportSql = String(sql).replace(/\s+/g, " ").trim();
      reportParameters = parameters;
      return [rows];
    }
  });
  const result = await service.getReports(filters);
  return { reportSql, reportParameters, result };
}

async function testReportListPreservesTerminalStatusFilters() {
  const completedRow = { id: 1, status: "completed" };
  const completed = await captureReportQuery(
    { status: "completed" },
    [completedRow]
  );
  assert.match(completed.reportSql, /dt\.status = 'completed'/);
  assert.deepEqual(completed.reportParameters, []);
  assert.deepEqual(completed.result, [completedRow]);

  const closedEarlyRow = { id: 2, status: "closed_early", stored_status: "cancelled" };
  const closedEarly = await captureReportQuery(
    { status: "closed_early" },
    [closedEarlyRow]
  );
  assert.match(closedEarly.reportSql, /closure_event\.id IS NOT NULL/);
  assert.deepEqual(closedEarly.reportParameters, []);
  assert.deepEqual(closedEarly.result, [closedEarlyRow]);

  const dayEndRow = {
    id: 4,
    status: "day_end_incomplete",
    stored_status: "cancelled"
  };
  const dayEnd = await captureReportQuery(
    { status: "day_end_incomplete" },
    [dayEndRow]
  );
  assert.match(dayEnd.reportSql, /day_end_event\.id IS NOT NULL/);
  assert.match(dayEnd.reportSql, /WHEN day_end_event\.id IS NOT NULL THEN 'day_end_incomplete'/);
  assert.deepEqual(dayEnd.reportParameters, []);
  assert.deepEqual(dayEnd.result, [dayEndRow]);

  const cancelledRow = { id: 3, status: "cancelled" };
  const cancelled = await captureReportQuery(
    { status: "cancelled" },
    [cancelledRow]
  );
  assert.match(
    cancelled.reportSql,
    /dt\.status = 'cancelled' AND closure_event\.id IS NULL AND day_end_event\.id IS NULL/
  );
  assert.deepEqual(cancelled.reportParameters, []);
  assert.deepEqual(cancelled.result, [cancelledRow]);
}

async function testReportListPreservesDateAndTruckFilters() {
  const query = await captureReportQuery({
    date_from: "2026-08-01",
    date_to: "2026-08-31",
    truck: "TRUCK-7"
  });
  assert.match(query.reportSql, /dt\.dispatch_date >= \?/);
  assert.match(query.reportSql, /dt\.dispatch_date <= \?/);
  assert.match(query.reportSql, /\(dt\.truck_id = \? OR dt\.truck_name_snapshot LIKE \?\)/);
  assert.deepEqual(query.reportParameters, [
    "2026-08-01",
    "2026-08-31",
    "TRUCK-7",
    "%TRUCK-7%"
  ]);
}

async function testReportListReturnsSuccessfulEmptyResult() {
  const query = await captureReportQuery();
  assert.deepEqual(query.result, []);
}

async function testReportDetailsUseOnlyPersistedTripData() {
  const service = new DispatchService({
    async query(sql) {
      assert.match(sql, /FROM truck_location_logs/);
      return [[]];
    }
  });
  service.getTicketDetails = async () => ({
    ticket: {
      id: 91,
      ticket_number: "DPT-2026-0091",
      status: "cancelled",
      actual_start_at: "2026-08-12 08:00:00",
      actual_end_at: "2026-08-12 11:00:00",
      cancellation_reason: "Mechanical issue"
    },
    stops: [
      {
        id: 1,
        stop_order: 1,
        location_name: "Pioneer Avenue",
        stop_status: "completed",
        stop_duration_seconds: 1800
      },
      { id: 2, stop_order: 2, location_name: "Pendatun Avenue", stop_status: "on_the_way" }
    ],
    tracking_sessions: [{ tracking_session_id: 501, session_distance_km: 19.8 }],
    progress: { total_stops: 2, completed_stops: 1 },
    events: [{
      id: 1,
      event_type: "dispatch_closed_early",
      event_at: "2026-08-12 11:00:00",
      actor_id: 7,
      actor_name: "Trusted WMO Operator",
      details: JSON.stringify({ reason: "Mechanical issue" })
    }]
  });

  const report = await service.getReportDetails(91);
  assert.equal(report.ticket.report_status, "closed_early");
  assert.equal(report.ticket.closure_reason, "Mechanical issue");
  assert.equal(report.ticket.closed_by_name, "Trusted WMO Operator");
  assert.equal(report.metrics.dispatch_duration_seconds, 10800);
  assert.equal(report.metrics.actual_distance_km, null, "distance needs actual GPS rows");
  assert.equal(report.metrics.destination_count, 2);
  assert.equal(report.metrics.completed_stops, 1);
  assert.equal(report.metrics.skipped_stops, 0);
  assert.equal(report.metrics.total_stop_duration_seconds, 1800);
  assert.equal(report.metrics.returned_to_wmo_at, null, "return must not be invented");
  assert.equal(report.planned_route_snapshot, null, "legacy reports must not fabricate a planned route");
  assert.deepEqual(report.events.map((event) => event.event_type), ["dispatch_closed_early"]);
  assert.equal(report.stops[1].stop_status, "on_the_way");
  assert.equal(durationSecondsBetween("bad", "also bad"), null);
}

async function testCompletedReportDetailsPreservePersistedOperationalHistory() {
  const routeLogs = [
    {
      id: 1,
      latitude: 6.1060875,
      longitude: 125.1816406,
      accuracy: 8,
      recorded_at: "2026-08-12 08:00:00"
    },
    {
      id: 2,
      latitude: 6.112,
      longitude: 125.19,
      accuracy: 10,
      recorded_at: "2026-08-12 12:00:00"
    }
  ];
  const service = new DispatchService({
    async query(sql, parameters) {
      assert.match(sql, /FROM truck_location_logs/);
      assert.match(sql, /ORDER BY recorded_at ASC, id ASC/);
      assert.deepEqual(parameters, [501]);
      return [routeLogs];
    }
  });
  service.getTicketDetails = async () => ({
    ticket: {
      id: 92,
      ticket_number: "DPT-2026-0092",
      status: "completed",
      actual_start_at: "2026-08-12 08:00:00",
      actual_end_at: "2026-08-12 16:30:00"
    },
    stops: [
      {
        id: 11,
        stop_order: 1,
        location_name: "Pioneer Avenue",
        stop_status: "completed",
        actual_arrival_at: "2026-08-12 12:00:00",
        actual_departure_at: "2026-08-12 12:30:00",
        stop_duration_seconds: 1800
      },
      {
        id: 12,
        stop_order: 2,
        location_name: "Pendatun Avenue",
        stop_status: "skipped",
        skip_reason: "Road blocked",
        actual_arrival_at: null,
        actual_departure_at: null,
        stop_duration_seconds: null
      }
    ],
    tracking_sessions: [{ tracking_session_id: 501, session_distance_km: 24.7 }],
    progress: { total_stops: 2, completed_stops: 1, skipped_stops: 1 },
    events: [
      {
        id: 1,
        event_type: "returned_to_wmo",
        event_at: "2026-08-12 16:30:00"
      },
      {
        id: 2,
        event_type: "dispatch_completed",
        event_at: "2026-08-12 16:30:00"
      }
    ]
  });

  const report = await service.getReportDetails(92);
  assert.equal(report.ticket.report_status, "completed");
  assert.equal(report.ticket.ended_at, "2026-08-12 16:30:00");
  assert.equal(report.ticket.returned_to_wmo_at, "2026-08-12 16:30:00");
  assert.equal(report.metrics.dispatch_duration_seconds, 30600);
  assert.equal(report.metrics.actual_distance_km, 24.7);
  assert.equal(report.metrics.actual_gps_point_count, 2);
  assert.equal(report.metrics.destination_count, 2);
  assert.equal(report.metrics.completed_stops, 1);
  assert.equal(report.metrics.skipped_stops, 1);
  assert.equal(report.metrics.total_stop_duration_seconds, 1800);
  assert.equal(report.metrics.returned_to_wmo_at, "2026-08-12 16:30:00");
  assert.deepEqual(report.route_logs, routeLogs);
  assert.equal(report.stops[0].actual_arrival_at, "2026-08-12 12:00:00");
  assert.equal(report.stops[0].actual_departure_at, "2026-08-12 12:30:00");
  assert.equal(report.stops[0].stop_duration_seconds, 1800);
  assert.equal(report.stops[1].skip_reason, "Road blocked");
  assert.equal(report.planned_route_snapshot, null);
}

async function testControllerUsesServerSessionActor() {
  const original = dispatchModule.endDispatch;
  let received = null;
  dispatchModule.endDispatch = async (id, payload) => {
    received = { id, payload };
    return { ticket: { id: Number(id), status: "cancelled" } };
  };
  delete require.cache[require.resolve("../controllers/dispatchController")];
  const controller = require("../controllers/dispatchController");
  const response = {
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; }
  };
  try {
    await controller.endDispatch({
      params: { id: "91" },
      user: { id: 7, full_name: "Trusted WMO Operator" },
      body: {
        reason_code: "mechanical_issue",
        actor_id: 999,
        actor_name: "Forged Actor"
      }
    }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(received.payload.actor_id, 7);
    assert.equal(received.payload.actor_name, "Trusted WMO Operator");
    assert.equal(received.payload.actor_type, "web_user");
  } finally {
    dispatchModule.endDispatch = original;
  }
}

async function testControllerReturnsSuccessfulEmptyReportList() {
  const original = dispatchModule.getReports;
  dispatchModule.getReports = async () => [];
  delete require.cache[require.resolve("../controllers/dispatchController")];
  const controller = require("../controllers/dispatchController");
  const response = {
    statusCode: 500,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; }
  };
  try {
    await controller.getReports({ query: {} }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { success: true, data: [] });
  } finally {
    dispatchModule.getReports = original;
  }
}

function testRouteSecurityAndFrontendLifecycle() {
  const routes = read("routes/dispatchRoutes.js");
  assert.match(routes, /router\.use\(requireWebAuth\)/);
  assert.match(routes, /requireWebRole\("super_admin", "personnel"\)/);
  assert.match(routes, /router\.use\(requireCsrf\)/);
  assert.match(routes, /router\.post\("\/tickets\/:id\/end", dispatchController\.endDispatch\)/);
  assert.match(routes, /router\.get\("\/reports\/:ticketId", dispatchController\.getReport\)/);

  const service = read("services/dispatchService.js");
  assert.match(service, /WHERE dt\.status IN \('dispatched', 'in_progress', 'returning_to_wmo'\)/);
  assert.match(service, /event_type: "dispatch_closed_early"/);
  assert.doesNotMatch(service, /24\s*\*\s*60\s*\*\s*60[\s\S]*UPDATE dispatch_tickets/);

  const frontend = read("frontend/js/admin/admin-dispatch.js");
  const submitBlock = frontend.slice(
    frontend.indexOf("async function submitDispatchEnd"),
    frontend.indexOf("async function performDispatchAction")
  );
  assert.match(frontend, /Active for over 24 hours/);
  assert.match(frontend, /data-dispatch-action="dismiss-stale"/);
  assert.doesNotMatch(frontend, /data-dispatch-action="keep-active"/);
  assert.match(frontend, /No dispatch reports found\./);
  assert.match(frontend, /Detailed trip events are not recorded for this dispatch\./);
  assert.match(frontend, /No GPS trail recorded\./);
  assert.match(frontend, /Original assigned road route was not recorded for this dispatch\./);
  assert.match(frontend, /Dark green: actual GPS trail/);
  assert.match(frontend, /Blue: persisted assigned route/);
  assert.doesNotMatch(frontend, /Assigned route between persisted dispatch waypoints/);
  assert.match(frontend, /const dayEndIncomplete = status === "day_end_incomplete"/);
  assert.match(frontend, /dayEndIncomplete \? "Day-End Reason" : "Closed Early"/);
  assert.match(frontend, /dispatch_forced_day_rollover: "Forced Day Rollover"/);
  assert.match(frontend, /Total Stop Time/);
  assert.match(frontend, /Returned to WMO/);
  assert.doesNotMatch(submitBlock, /force-stop|stopTracking|Stop Truck/);
  assert.doesNotMatch(submitBlock, /returned_to_wmo|dispatch_completed/);
}

async function run() {
  testClosureReasonValidation();
  await testActiveDispatchCanBeClosedEarlyIdempotently();
  await testCompletedDispatchCannotBeClosedEarly();
  await testReportListIsTicketCenteredAndExcludesActiveDispatches();
  await testReportListPreservesTerminalStatusFilters();
  await testReportListPreservesDateAndTruckFilters();
  await testReportListReturnsSuccessfulEmptyResult();
  await testReportDetailsUseOnlyPersistedTripData();
  await testCompletedReportDetailsPreservePersistedOperationalHistory();
  await testControllerUsesServerSessionActor();
  await testControllerReturnsSuccessfulEmptyReportList();
  testRouteSecurityAndFrontendLifecycle();
  console.log("Dispatch close and reports tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
