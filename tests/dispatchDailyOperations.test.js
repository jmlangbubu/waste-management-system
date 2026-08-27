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
  combineDailyOperationalRows,
  dailyInterval,
  dailyRouteMetrics,
  dailyStopMetrics,
  manilaDayWindow,
  mergedIntervalSeconds
} = dispatchModule;
Module._load = originalModuleLoad;
const {
  dispatchDailyDistance,
  dispatchDailyRouteGroups
} = require("../frontend/js/admin/admin-dispatch");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function testExactManilaBoundariesIndependentOfServerTimezone() {
  const window = manilaDayWindow("2026-08-27", new Date("2026-08-27T23:00:00Z"));
  assert.deepEqual(
    { date: window.date, start: window.start, end: window.end },
    {
      date: "2026-08-27",
      start: "2026-08-27 00:00:00",
      end: "2026-08-28 00:00:00"
    }
  );
  assert.equal(window.start_ms, Date.parse("2026-08-26T16:00:00Z"));
  assert.equal(window.end_ms, Date.parse("2026-08-27T16:00:00Z"));
  assert.equal(manilaDayWindow(null, new Date("2026-08-27T17:00:00Z")).date, "2026-08-28");

  assert.ok(dailyInterval(
    "2026-08-27 23:59:50",
    "2026-08-27 23:59:59",
    window
  ));
  assert.equal(dailyInterval(
    "2026-08-28 00:00:10",
    "2026-08-28 00:01:00",
    window
  ), null);
}

function testCrossMidnightAndOverlappingSessionDuration() {
  const august27 = manilaDayWindow("2026-08-27");
  const august28 = manilaDayWindow("2026-08-28");
  const sessionStart = "2026-08-27 23:00:00";
  const sessionEnd = "2026-08-28 01:00:00";
  assert.equal(
    mergedIntervalSeconds([dailyInterval(sessionStart, sessionEnd, august27)]),
    3600
  );
  assert.equal(
    mergedIntervalSeconds([dailyInterval(sessionStart, sessionEnd, august28)]),
    3600
  );
  assert.equal(mergedIntervalSeconds([
    dailyInterval("2026-08-27 08:00:00", "2026-08-27 10:00:00", august27),
    dailyInterval("2026-08-27 09:00:00", "2026-08-27 11:00:00", august27)
  ]), 10800, "overlapping anomalous sessions must be unioned, not double-counted");
}

function testDistanceScalesAndNeverBridgesSessions() {
  const points = [];
  for (let index = 0; index < 1001; index += 1) {
    points.push({
      id: index + 1,
      session_id: 10,
      latitude: 6.1 + index * 0.000001,
      longitude: 125.18,
      recorded_at: `2026-08-27 ${String(Math.floor(index / 3600)).padStart(2, "0")}:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`
    });
  }
  points.push({
    id: 2001,
    session_id: 11,
    latitude: 7.0,
    longitude: 126.0,
    recorded_at: "2026-08-27 12:00:00"
  });
  points.push({
    id: 2002,
    session_id: 11,
    latitude: 7.0001,
    longitude: 126.0,
    recorded_at: "2026-08-27 12:00:10"
  });
  const metrics = dailyRouteMetrics(points);
  assert.equal(metrics.actual_gps_point_count, 1003);
  assert.ok(metrics.actual_distance_km > 0.1 && metrics.actual_distance_km < 0.2);

  const isolated = dailyRouteMetrics([
    points[0],
    { ...points.at(-2), id: 2, session_id: 11 }
  ]);
  assert.equal(isolated.actual_distance_km, 0, "a large inter-session jump is not distance");
}

function testStopOccurrenceAndMidnightDwellSplit() {
  const stop = {
    id: 1,
    stop_status: "completed",
    actual_arrival_at: "2026-08-27 23:50:00",
    actual_departure_at: "2026-08-28 00:10:00",
    completed_at: "2026-08-28 00:10:00",
    stop_duration_seconds: 1200
  };
  const first = dailyStopMetrics([stop], manilaDayWindow("2026-08-27"));
  const second = dailyStopMetrics([stop], manilaDayWindow("2026-08-28"));
  assert.equal(first.completed_stop_count, 1, "completed stop belongs to arrival date");
  assert.equal(second.completed_stop_count, 0);
  assert.equal(first.total_stop_duration_seconds, 600);
  assert.equal(second.total_stop_duration_seconds, 600);

  const skipped = dailyStopMetrics([{
    stop_status: "skipped",
    skipped_at: "2026-08-28 00:00:10",
    stop_duration_seconds: null
  }], manilaDayWindow("2026-08-28"));
  assert.equal(skipped.skipped_stop_count, 1);
}

function testDailyGroupingCombinesSameTruckOnly() {
  const window = manilaDayWindow("2026-08-27");
  const rows = combineDailyOperationalRows(
    [
      { id: 1, truck_id: "TRUCK-9", enforcer_name: "Ana", started_at: "2026-08-27 08:00:00", ended_at: "2026-08-27 10:00:00" },
      { id: 2, truck_id: "TRUCK-9", enforcer_name: "Ben", started_at: "2026-08-27 13:00:00", ended_at: "2026-08-27 14:00:00" },
      { id: 3, truck_id: "TRUCK-10", enforcer_name: null, started_at: "2026-08-27 09:00:00", ended_at: "2026-08-27 09:30:00" }
    ],
    [
      { id: 101, truck_id: "TRUCK-9", truck_name_snapshot: "Truck 9", status: "completed", completed_stop_count: 2, skipped_stop_count: 0, total_stop_duration_seconds: 300 },
      { id: 102, truck_id: "TRUCK-9", truck_name_snapshot: "Truck 9", status: "closed_early", completed_stop_count: 1, skipped_stop_count: 1, total_stop_duration_seconds: 120 },
      { id: 103, truck_id: "TRUCK-11", truck_name_snapshot: "Truck 11", status: "cancelled", completed_stop_count: 0, skipped_stop_count: 0, total_stop_duration_seconds: 0 }
    ],
    [{ truck_id: "TRUCK-9", actual_gps_point_count: 15, actual_distance_km: 4.25 }],
    window,
    "2026-08-27 15:00:00"
  );
  assert.equal(rows.length, 3, "tracking-only and dispatch-without-GPS trucks remain reportable");
  const truck9 = rows.find((row) => row.truck_id === "TRUCK-9");
  assert.equal(truck9.dispatch_count, 2);
  assert.equal(truck9.completed_stop_count, 3);
  assert.equal(truck9.skipped_stop_count, 1);
  assert.equal(truck9.tracking_duration_seconds, 10800);
  assert.equal(truck9.actual_distance_km, 4.25);
  assert.match(truck9.personnel, /Ana/);
  assert.match(truck9.personnel, /Ben/);
  assert.equal(rows.find((row) => row.truck_id === "TRUCK-11").actual_distance_km, null);
}

function projectionPool(overrides = {}) {
  const calls = [];
  const pool = {
    calls,
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes("FROM truck_tracking_sessions tts")) {
        return [overrides.sessions || []];
      }
      if (sql.includes("FROM dispatch_tickets dt")) {
        return [overrides.dispatches || []];
      }
      if (sql.includes("WITH daily_points AS")) {
        return [overrides.metrics || []];
      }
      if (sql.includes("FROM truck_location_logs") && sql.includes("DATE_FORMAT(recorded_at")) {
        return [overrides.points || []];
      }
      if (sql.includes("FROM dispatch_route_stops")) return [overrides.stops || []];
      if (sql.includes("FROM dispatch_events")) return [overrides.events || []];
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  return pool;
}

async function testListUsesSummaryQueriesAndExactBoundaries() {
  const pool = projectionPool({
    sessions: [{ id: 58, truck_id: "TRUCK-9", enforcer_name: "Ana", started_at: "2026-08-27 23:00:00", ended_at: "2026-08-28 01:00:00" }],
    dispatches: [{ id: 7, truck_id: "TRUCK-9", truck_name_snapshot: "TRUCK-9", status: "completed", completed_stop_count: 1 }],
    metrics: [{ truck_id: "TRUCK-9", actual_gps_point_count: 2, actual_distance_km: 0.5 }]
  });
  const service = new DispatchService(pool, {
    now: () => new Date("2026-08-27T15:59:59Z")
  });
  const rows = await service.getDailyReports({ date: "2026-08-27" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tracking_duration_seconds, 3600);
  assert.equal(pool.calls.length, 3);
  pool.calls.forEach((call) => assert.equal(
    (call.sql.match(/\?/g) || []).length,
    call.parameters.length,
    "every daily list SQL placeholder must have one parameter"
  ));
  const gpsCall = pool.calls.find((call) => call.sql.includes("WITH daily_points AS"));
  assert.deepEqual(gpsCall.parameters.slice(0, 2), [
    "2026-08-27 00:00:00",
    "2026-08-28 00:00:00"
  ]);
  assert.match(gpsCall.sql, /PARTITION BY tll\.session_id/);
  assert.match(gpsCall.sql, /GROUP BY truck_id/);
  assert.doesNotMatch(gpsCall.sql, /CURDATE\s*\(/i);
  assert.doesNotMatch(
    gpsCall.sql.slice(gpsCall.sql.lastIndexOf("SELECT")),
    /recorded_at/i,
    "the list response query returns aggregates rather than route geometry"
  );
  const allSql = pool.calls.map((call) => call.sql).join("\n");
  assert.match(allSql, /actual_start_at[\s\S]*dispatched_at[\s\S]*issued_at/);
  assert.match(allSql, /tts_overlap\.started_at < \?/);
}

async function testDetailReturnsCompactChronologicalEvidence() {
  const pool = projectionPool({
    sessions: [{ id: 58, truck_id: "TRUCK-9", enforcer_name: "Ana", session_status: "stopped", started_at: "2026-08-27 08:00:00", ended_at: "2026-08-27 10:00:00" }],
    dispatches: [{ id: 7, ticket_number: "DPT-2026-0007", truck_id: "TRUCK-9", truck_name_snapshot: "TRUCK-9", status: "closed_early", completed_stop_count: 1 }],
    metrics: [{ truck_id: "TRUCK-9", actual_gps_point_count: 2, actual_distance_km: 0.5 }],
    points: [
      { session_id: 58, latitude: 6.1, longitude: 125.18, recorded_at: "2026-08-27 08:00:00" },
      { session_id: 58, latitude: 6.101, longitude: 125.18, recorded_at: "2026-08-27 08:01:00" }
    ],
    stops: [{ id: 4, dispatch_ticket_id: 7, stop_order: 1, stop_status: "completed", actual_arrival_at: "2026-08-27 09:00:00", actual_departure_at: "2026-08-27 09:05:00", stop_duration_seconds: 300 }],
    events: [{ id: 9, dispatch_ticket_id: 7, event_type: "dispatch_closed_early", event_at: "2026-08-27 10:00:00" }]
  });
  const service = new DispatchService(pool, {
    now: () => new Date("2026-08-27T04:00:00Z")
  });
  const detail = await service.getDailyReportDetails("TRUCK-9", { date: "2026-08-27" });
  assert.equal(detail.dispatches.length, 1);
  assert.equal(detail.dispatches[0].ticket_report_available, true);
  assert.equal(detail.route_points.length, 2);
  assert.deepEqual(Object.keys(detail.route_points[0]), [
    "session_id", "latitude", "longitude", "recorded_at"
  ]);
  assert.equal(detail.stops[0].counted_on_date, true);
  assert.equal(detail.summary.total_stop_duration_seconds, 300);
  assert.ok(detail.summary.actual_distance_km > 0);
  const routeCall = pool.calls.find((call) =>
    call.sql.includes("FROM truck_location_logs") && call.sql.includes("DATE_FORMAT(recorded_at")
  );
  assert.match(routeCall.sql, /ORDER BY recorded_at ASC, id ASC/);
  pool.calls.forEach((call) => assert.equal(
    (call.sql.match(/\?/g) || []).length,
    call.parameters.length,
    "every daily detail SQL placeholder must have one parameter"
  ));
}

async function testControllerAndLiteralRouteOrder() {
  const original = dispatchModule.getDailyReports;
  dispatchModule.getDailyReports = async () => [];
  delete require.cache[require.resolve("../controllers/dispatchController")];
  const controller = require("../controllers/dispatchController");
  const response = {
    statusCode: 500,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; }
  };
  try {
    await controller.getDailyReports({ query: { date: "2026-08-27" } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { success: true, data: [] });
  } finally {
    dispatchModule.getDailyReports = original;
  }

  const routes = read("routes/dispatchRoutes.js");
  const dailyIndex = routes.indexOf('router.get("/reports/daily"');
  const detailIndex = routes.indexOf('router.get("/reports/daily/:truckId"');
  const ticketIndex = routes.indexOf('router.get("/reports/:ticketId"');
  assert.ok(dailyIndex > -1 && detailIndex > dailyIndex && ticketIndex > detailIndex);
  assert.match(routes, /router\.use\(requireWebAuth\)/);
  assert.match(routes, /requireWebRole\("super_admin", "personnel"\)/);
}

function testReadOnlyContractAndNoDateTimezoneShortcuts() {
  const service = read("services/dispatchService.js");
  const dailyBlock = service.slice(
    service.indexOf("async loadDailyOperationalProjection"),
    service.indexOf("async getReports(filters")
  );
  assert.doesNotMatch(dailyBlock, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(dailyBlock, /CURDATE\s*\(|CURRENT_DATE/i);
  assert.doesNotMatch(dailyBlock, /session_distance_km/);
  assert.match(dailyBlock, /DATE_FORMAT\(recorded_at/);
  assert.match(dailyBlock, /loadDailyOperationalProjection/);
}

function testFrontendKeepsSessionTrailsSeparateAndReusesTicketReport() {
  const groups = dispatchDailyRouteGroups([
    { id: 1, session_id: 58, latitude: 6.1, longitude: 125.18, recorded_at: "2026-08-27 08:00:00" },
    { id: 3, session_id: 59, latitude: 7.0, longitude: 126.0, recorded_at: "2026-08-27 12:00:00" },
    { id: 2, session_id: 58, latitude: 6.2, longitude: 125.2, recorded_at: "2026-08-27 08:01:00" }
  ]);
  assert.equal(groups.size, 2);
  assert.deepEqual([...groups.get("58")].map((point) => point.id), [1, 2]);
  assert.equal(dispatchDailyDistance(null, 0), "Not recorded");

  const frontend = read("frontend/js/admin/admin-dispatch.js");
  assert.match(frontend, /data-dispatch-view-report=/);
  assert.match(frontend, /View Ticket Report/);
  assert.match(frontend, /Dark green: actual GPS trail per session/);
  assert.doesNotMatch(
    frontend.slice(
      frontend.indexOf("function renderDispatchDailyReportMap"),
      frontend.indexOf("function renderDispatchDailyReportDetails")
    ),
    /#d83a3a|current truck|live truck/i
  );

  const api = read("frontend/js/admin/admin-api.js");
  assert.match(api, /\/dispatch\/reports/);
  assert.match(api, /getDispatchDailyReportsApiUrl/);
  assert.match(api, /getDispatchDailyReportApiUrl/);
  const html = read("frontend/admin-dashboard.html");
  assert.match(html, /Ticket Reports/);
  assert.match(html, /Daily Operations/);
  assert.match(html, /id="dispatchDailyReportDate"/);
  assert.match(html, /id="dispatchDailyReportTruck"/);
}

async function run() {
  testExactManilaBoundariesIndependentOfServerTimezone();
  testCrossMidnightAndOverlappingSessionDuration();
  testDistanceScalesAndNeverBridgesSessions();
  testStopOccurrenceAndMidnightDwellSplit();
  testDailyGroupingCombinesSameTruckOnly();
  await testListUsesSummaryQueriesAndExactBoundaries();
  await testDetailReturnsCompactChronologicalEvidence();
  await testControllerAndLiteralRouteOrder();
  testReadOnlyContractAndNoDateTimezoneShortcuts();
  testFrontendKeepsSessionTrailsSeparateAndReusesTicketReport();
  console.log("Dispatch daily operations tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
