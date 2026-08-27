const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildDispatchReportViewModel,
  dispatchReportActualPoints,
  dispatchReportEventLabel,
  dispatchReportPlannedPoints,
  dispatchReportStopView,
  dispatchReportTotalStopSeconds
} = require("../frontend/js/admin/admin-dispatch");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

function completedReportFixture() {
  return {
    ticket: {
      id: 91,
      ticket_number: "DPT-2026-0001",
      truck_id: "TRUCK-9",
      truck_name_snapshot: "TRUCK-9",
      route_name: "South Route",
      report_status: "completed",
      status: "completed",
      dispatch_date: "2026-08-27",
      assigned_personnel_name: "Enforcer One",
      created_by_name: "WMO Admin",
      actual_start_at: "2026-08-27 08:00:00",
      ended_at: "2026-08-27 16:30:00"
    },
    stops: [
      {
        id: 12,
        stop_order: 2,
        location_name: "Pendatun Avenue",
        address_reference: "Barangay Lagao",
        stop_status: "skipped",
        skip_reason: "Road blocked",
        actual_arrival_at: null,
        actual_departure_at: null,
        stop_duration_seconds: null,
        latitude: 6.12,
        longitude: 125.18
      },
      {
        id: 11,
        stop_order: 1,
        location_name: "Pioneer Avenue",
        address_reference: "Barangay Dadiangas",
        stop_status: "completed",
        actual_arrival_at: "2026-08-27 12:00:00",
        actual_departure_at: "2026-08-27 12:30:00",
        stop_duration_seconds: 1800,
        latitude: 6.11,
        longitude: 125.17
      }
    ],
    tracking_session: {
      tracking_session_id: 58,
      started_at: "2026-08-27 08:00:00",
      ended_at: "2026-08-27 16:30:00"
    },
    route_logs: [
      { id: 3, latitude: 6.12, longitude: 125.18, accuracy: 10, recorded_at: "2026-08-27 12:30:00" },
      { id: 2, latitude: 6.11, longitude: 125.17, accuracy: 10, recorded_at: "2026-08-27 12:00:00" },
      { id: 1, latitude: 6.10, longitude: 125.16, accuracy: 10, recorded_at: "2026-08-27 08:00:00" }
    ],
    planned_route_snapshot: null,
    progress: { total_stops: 2, completed_stops: 1, skipped_stops: 1 },
    events: [
      { id: 5, event_type: "dispatch_completed", event_at: "2026-08-27 16:30:00" },
      { id: 3, event_type: "departed_stop", dispatch_route_stop_id: 11, event_at: "2026-08-27 12:30:00" },
      { id: 2, event_type: "arrived_at_stop", dispatch_route_stop_id: 11, event_at: "2026-08-27 12:00:00" },
      { id: 1, event_type: "tracking_started", event_at: "2026-08-27 08:00:00" },
      { id: 4, event_type: "returned_to_wmo", event_at: "2026-08-27 16:30:00" }
    ],
    metrics: {
      dispatch_duration_seconds: 30600,
      actual_distance_km: 24.7,
      actual_gps_point_count: 3,
      destination_count: 2,
      completed_stops: 1,
      skipped_stops: 1,
      total_stop_duration_seconds: 1800,
      returned_to_wmo_at: "2026-08-27 16:30:00"
    }
  };
}

function testCompletedReportProjection() {
  const report = buildDispatchReportViewModel(completedReportFixture());
  assert.equal(report.status_label, "Completed");
  assert.equal(report.started_at, "2026-08-27 08:00:00");
  assert.equal(report.ended_at, "2026-08-27 16:30:00");
  assert.equal(report.duration_seconds, 30600);
  assert.equal(report.actual_distance_km, 24.7);
  assert.equal(report.destination_count, 2);
  assert.equal(report.completed_stops, 1);
  assert.equal(report.skipped_stops, 1);
  assert.equal(report.total_stop_duration_seconds, 1800);
  assert.equal(report.returned_at, "2026-08-27 16:30:00");
}

function testOrderedStopRecordsAndPersistedTiming() {
  const report = buildDispatchReportViewModel(completedReportFixture());
  assert.deepEqual(report.stops.map((stop) => stop.stop_order), [1, 2]);
  assert.equal(report.stops[0].arrival_at, "2026-08-27 12:00:00");
  assert.equal(report.stops[0].departure_at, "2026-08-27 12:30:00");
  assert.equal(report.stops[0].dwell_seconds, 1800);
  assert.equal(report.stops[1].status_label, "Skipped");
  assert.equal(report.stops[1].skip_reason, "Road blocked");

  const legacy = dispatchReportStopView({ stop_status: "completed" });
  assert.equal(legacy.arrival_at, null);
  assert.equal(legacy.departure_at, null);
  assert.equal(legacy.dwell_seconds, null);
  assert.equal(dispatchReportTotalStopSeconds([legacy], {}), null);
}

function testActualTrailAndPlannedRouteTruthfulness() {
  const fixture = completedReportFixture();
  const points = dispatchReportActualPoints(fixture.route_logs);
  assert.deepEqual(points.map((point) => point.id), [1, 2, 3]);
  assert.equal(points[0].recorded_at, "2026-08-27 08:00:00");
  assert.deepEqual(dispatchReportPlannedPoints(null), []);
  assert.deepEqual(
    dispatchReportPlannedPoints({ points: [{ latitude: 6.1, longitude: 125.1 }] }),
    [{ lat: 6.1, lng: 125.1 }]
  );

  const report = buildDispatchReportViewModel(fixture);
  assert.equal(report.has_actual_trail, true);
  assert.equal(report.has_planned_route, false);
}

function testTimelineChronologyAndLabels() {
  const report = buildDispatchReportViewModel(completedReportFixture());
  assert.deepEqual(report.events.map((event) => event.id), [1, 2, 3, 4, 5]);
  assert.equal(report.events[1].label, "Arrived at Pioneer Avenue");
  assert.equal(report.events[2].label, "Departed Pioneer Avenue");
  assert.equal(
    dispatchReportEventLabel({ event_type: "future_event" }, new Map()),
    "Future Event"
  );
}

function testClosedEarlyAndLegacyNullProjection() {
  const fixture = completedReportFixture();
  fixture.ticket.status = "cancelled";
  fixture.ticket.report_status = "closed_early";
  fixture.ticket.closure_reason = "Mechanical issue";
  fixture.ticket.closed_by_name = "WMO Operator";
  fixture.ticket.closed_at = "2026-08-27 11:00:00";
  fixture.ticket.ended_at = "2026-08-27 11:00:00";
  const closed = buildDispatchReportViewModel(fixture);
  assert.equal(closed.status_label, "Closed Early");
  assert.equal(closed.closure_reason, "Mechanical issue");
  assert.equal(closed.closed_by, "WMO Operator");
  assert.equal(closed.closed_at, "2026-08-27 11:00:00");

  const legacy = buildDispatchReportViewModel({
    ticket: { status: "completed" },
    stops: [{ id: 1, stop_order: 1, stop_status: "completed" }],
    events: [],
    route_logs: []
  });
  assert.equal(legacy.actual_distance_km, null);
  assert.equal(legacy.duration_seconds, null);
  assert.equal(legacy.total_stop_duration_seconds, null);
  assert.equal(legacy.has_actual_trail, false);
  assert.equal(legacy.has_planned_route, false);
}

function testReadOnlyApiAndFrontendLifecycleStructure() {
  const service = read("services/dispatchService.js");
  const detailBlock = service.slice(
    service.indexOf("async getReportDetails"),
    service.indexOf("async reconcileAutomaticStopEvent")
  );
  assert.match(detailBlock, /ORDER BY recorded_at ASC, id ASC/);
  assert.match(detailBlock, /planned_route_snapshot: null/);
  assert.match(detailBlock, /total_stop_duration_seconds: totalStopDurationSeconds/);
  assert.match(detailBlock, /ticket:/);
  assert.match(detailBlock, /stops,/);
  assert.match(detailBlock, /tracking_session: primarySession/);
  assert.match(detailBlock, /route_logs: routeLogs/);
  assert.match(detailBlock, /progress: details\.progress/);
  assert.match(detailBlock, /events,/);
  assert.match(detailBlock, /metrics:/);
  assert.doesNotMatch(detailBlock, /UPDATE |INSERT INTO|DELETE FROM/);

  const frontend = read("frontend/js/admin/admin-dispatch.js");
  const reportBlock = frontend.slice(
    frontend.indexOf("function dispatchReportStopStatus"),
    frontend.indexOf("async function openDispatchReport")
  );
  assert.match(reportBlock, /Dark green: actual GPS trail/);
  assert.match(reportBlock, /Original assigned road route was not recorded for this dispatch/);
  assert.match(reportBlock, /dispatchReportStopPopup/);
  assert.match(reportBlock, /Trip Start \/ Return Point/);
  assert.match(reportBlock, /Trip End/);
  assert.match(reportBlock, /dispatchReportMap\?\.invalidateSize/);
  assert.doesNotMatch(reportBlock, /router\.project-osrm|requestDispatchRoadJourney/);
  assert.doesNotMatch(reportBlock, /dispatchReportSuggestedPoints\(stops\)/);

  const closeBlock = frontend.slice(
    frontend.indexOf("function closeDispatchReportModal"),
    frontend.indexOf("function dispatchReportStopStatus")
  );
  assert.match(closeBlock, /dispatchReportMap\.remove\(\)/);
  const openBlock = frontend.slice(
    frontend.indexOf("async function openDispatchReport"),
    frontend.indexOf("function openDispatchEndModal")
  );
  assert.match(openBlock, /openDispatchModal\("dispatchReportModal"\)/);
  assert.doesNotMatch(openBlock, /closeDispatchReportsModal|dispatchReportsCache\s*=/);
  assert.match(frontend, /"dispatchReportsModal",\s*"dispatchReportModal"/);

  const css = read("frontend/css/admin/admin-dispatch.css");
  assert.match(css, /body > #dispatchReportsModal[\s\S]*z-index: 30000/);
  assert.match(css, /body > #dispatchReportModal[\s\S]*z-index: 30010/);

  const html = read("frontend/admin-dashboard.html");
  assert.match(html, /id="closeDispatchReportModalBtn"/);
  assert.equal((html.match(/id="closeDispatchReportModalBtn"/g) || []).length, 1);
}

function run() {
  testCompletedReportProjection();
  testOrderedStopRecordsAndPersistedTiming();
  testActualTrailAndPlannedRouteTruthfulness();
  testTimelineChronologyAndLabels();
  testClosedEarlyAndLegacyNullProjection();
  testReadOnlyApiAndFrontendLifecycleStructure();
  console.log("Dispatch operational report view tests passed");
}

run();
