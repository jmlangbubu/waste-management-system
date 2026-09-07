const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const dashboardHtml = read("frontend/admin-dashboard.html");
const dashboardCss = read("frontend/css/admin/admin-dashboard.css");
const dashboardSource = read("frontend/js/admin/admin-dashboard-analytics.js");

class TestElement {
  constructor(textContent = "") {
    this.textContent = textContent;
    this.innerHTML = "";
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
}

const operationIds = [
  "dashboardFleetTotal",
  "dashboardFleetAvailable",
  "dashboardFleetActive",
  "dashboardFleetMaintenance",
  "dashboardFleetOutOfService",
  "dashboardDispatchToday",
  "dashboardDispatchTomorrow",
  "dashboardDispatchActive",
  "dashboardDispatchNext",
  "dashboardDispatchNextMeta",
  "dashboardLatestSource",
  "dashboardLatestTruck",
  "dashboardLatestEnforcer",
  "dashboardLatestStatus",
  "dashboardLatestTime",
  "recommendationList",
  "monitoringActiveTruckCount",
  "monitoringMaintenanceCount",
  "monitoringAlertList"
];
const elements = new Map(operationIds.map((id) => [id, new TestElement()]));

global.document = {
  addEventListener() {},
  getElementById: (id) => elements.get(id) || null,
  querySelector: () => null,
  querySelectorAll: () => []
};
global.window = {};
global.localStorage = {
  getItem: () => null,
  setItem() {}
};
global.validatedWasteRecords = [];
global.allWebUsers = [];
global.escapeHtml = (value) => String(value);

const {
  dashboardOperationsCalendarDate,
  dashboardOperationsPlannedForDate,
  dashboardOperationsNextSchedule,
  dashboardOperationsStatus,
  dashboardOperationsDispatchModel,
  dashboardOperationsTrackingModel,
  renderDashboardFleetSummary,
  renderDashboardDispatchSummary,
  renderDashboardLatestOperation,
  loadDashboardLatestOperation,
  loadDashboardOperationsSnapshot
} = require("../frontend/js/admin/admin-dashboard-analytics");

function resetElements() {
  elements.forEach((element) => {
    element.textContent = "";
    element.innerHTML = "";
    element.dataset = {};
  });
}

function response(data, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status || (options.ok === false ? 503 : 200),
    json: async () => ({
      success: options.ok !== false,
      data
    })
  };
}

function testDashboardMarkupAndScope() {
  [
    ...operationIds.slice(0, 15),
    "dashboardFleetStatusTitle",
    "dashboardDispatchSummaryTitle",
    "dashboardLatestOperationTitle",
    "dashboardRecommendationsTitle"
  ].forEach((id) => {
    assert.equal(
      (dashboardHtml.match(new RegExp(`\\bid="${id}"`, "g")) || []).length,
      1,
      `Expected one #${id}`
    );
  });
  assert.equal((dashboardHtml.match(/\bid="recommendationList"/g) || []).length, 1);
  assert.match(dashboardHtml, /class="dashboard-legacy-monitoring-hooks" hidden aria-hidden="true"/);
  assert.match(dashboardHtml, /id="viewAllTruckAnalyticsBtn"[^>]*tabindex="-1"/);
  assert.doesNotMatch(dashboardHtml, /<h2>Truck Monitoring<\/h2>/);
  assert.match(dashboardCss, /PHASE UI-4: OPERATIONS SNAPSHOT/);
  assert.match(dashboardCss, /dashboard-fleet-metrics[\s\S]*grid-column: span 3/);
  assert.match(dashboardCss, /@media \(max-width: 720px\)[\s\S]*operations-snapshot-grid[\s\S]*grid-template-columns: 1fr/);
  assert.doesNotMatch(dashboardSource, /setInterval\([^)]*loadDashboardOperationsSnapshot/);
}

function testFleetMetrics() {
  resetElements();
  renderDashboardFleetSummary({
    total: 9,
    available: 6,
    active: 2,
    for_maintenance: 2,
    out_of_service: 1
  });
  assert.equal(elements.get("dashboardFleetTotal").textContent, "9");
  assert.equal(elements.get("dashboardFleetAvailable").textContent, "6");
  assert.equal(elements.get("dashboardFleetActive").textContent, "2");
  assert.equal(elements.get("dashboardFleetMaintenance").textContent, "2");
  assert.equal(elements.get("dashboardFleetOutOfService").textContent, "1");
  assert.equal(elements.get("monitoringActiveTruckCount").textContent, "2");
  assert.equal(elements.get("monitoringMaintenanceCount").textContent, "2");
  renderDashboardFleetSummary(null);
  assert.equal(elements.get("dashboardFleetTotal").textContent, "—");
}

function testManilaDatesAndDispatchMetrics() {
  resetElements();
  const boundaryInstant = new Date("2026-09-05T16:30:00.000Z");
  const today = dashboardOperationsCalendarDate(boundaryInstant, 0);
  const tomorrow = dashboardOperationsCalendarDate(boundaryInstant, 1);
  assert.equal(today, "2026-09-06");
  assert.equal(tomorrow, "2026-09-07");

  const todayPlans = [
    {
      id: 1,
      operational_date: today,
      status: "planned",
      truck_code_snapshot: "TRUCK-1",
      scheduled_start: `${today} 08:00:00`
    },
    { id: 2, operational_date: today, status: "activated" },
    { id: 3, operational_date: today, status: "cancelled" }
  ];
  const tomorrowPlans = [{
    id: 4,
    operational_date: tomorrow,
    status: "planned",
    truck_name_snapshot: "Truck Four",
    assigned_enforcer_name_snapshot: "Enforcer Four",
    scheduled_start: `${tomorrow} 07:30:00`
  }];
  assert.equal(dashboardOperationsPlannedForDate(todayPlans, today).length, 1);
  assert.equal(dashboardOperationsPlannedForDate(tomorrowPlans, tomorrow).length, 1);

  renderDashboardDispatchSummary({
    todayPlans,
    tomorrowPlans,
    liveDispatches: { 58: { dispatch_ticket_id: 8 }, 59: { dispatch_ticket_id: 9 } },
    today,
    tomorrow
  });
  assert.equal(elements.get("dashboardDispatchToday").textContent, "1");
  assert.equal(elements.get("dashboardDispatchTomorrow").textContent, "1");
  assert.equal(elements.get("dashboardDispatchActive").textContent, "2");
  assert.equal(elements.get("dashboardDispatchNext").textContent, "TRUCK-1");
  assert.match(elements.get("dashboardDispatchNextMeta").textContent, /Today • 8:00 AM/);

  const nextTomorrow = dashboardOperationsNextSchedule(tomorrowPlans, today, tomorrow);
  assert.deepEqual(nextTomorrow, {
    truck: "Truck Four",
    meta: "Tomorrow • 7:30 AM • Enforcer Four"
  });
  renderDashboardDispatchSummary({ todayPlans: [], tomorrowPlans: [], liveDispatches: {}, today, tomorrow });
  assert.equal(elements.get("dashboardDispatchNext").textContent, "No upcoming plan");
  assert.equal(elements.get("dashboardDispatchNextMeta").textContent, "No planned dispatch found");
}

function testLatestOperationModels() {
  resetElements();
  const dispatchModel = dashboardOperationsDispatchModel({
    truck_id: "TRUCK-9",
    assigned_personnel_name: "Jeremiah Quintana",
    status: "day_end_incomplete",
    actual_end_at: "2026-09-02 17:05:00"
  });
  assert.equal(dispatchModel.statusLabel, "Day-End Incomplete");
  assert.equal(dispatchModel.statusState, "warning");
  renderDashboardLatestOperation(dispatchModel, "ready");
  assert.equal(elements.get("dashboardLatestSource").textContent, "Dispatch Report");
  assert.equal(elements.get("dashboardLatestTruck").textContent, "TRUCK-9");
  assert.equal(elements.get("dashboardLatestStatus").textContent, "Day-End Incomplete");
  assert.doesNotMatch(elements.get("dashboardLatestTime").textContent, /undefined|null|NaN/);

  const trackingModel = dashboardOperationsTrackingModel([
    { session_status: "active", ended_at: null, truck_id: "ACTIVE" },
    {
      session_status: "auto_stopped",
      report_status_label: "Shift Completed · Route Recorded",
      ended_at: "2026-09-03 17:00:00",
      truck_id: "TRUCK-10",
      enforcer_name: "Enforcer Ten"
    }
  ]);
  assert.equal(trackingModel.source, "Tracking Report");
  assert.equal(trackingModel.truck, "TRUCK-10");
  assert.equal(trackingModel.statusLabel, "Shift Completed · Route Recorded");
  assert.equal(dashboardOperationsStatus("closed_early").label, "Closed Early");
  assert.equal(dashboardOperationsStatus("cancelled").label, "Cancelled");
}

async function testPrimaryAndFallbackRequests() {
  resetElements();
  global.getDispatchReportsApiUrl = () => "/dispatch/reports";
  global.getTrackingReportsApiUrl = () => "/tracking/reports";
  const methods = [];
  global.webAdminFetch = async (url, options = {}) => {
    methods.push(options.method || "GET");
    if (url === "/dispatch/reports") {
      return response([{
        truck_id: "PRIMARY-1",
        assigned_personnel_name: "Primary Enforcer",
        status: "completed",
        completed_at: "2026-09-04 16:30:00"
      }]);
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  await loadDashboardLatestOperation();
  assert.equal(elements.get("dashboardLatestSource").textContent, "Dispatch Report");
  assert.equal(elements.get("dashboardLatestTruck").textContent, "PRIMARY-1");

  global.webAdminFetch = async (url, options = {}) => {
    methods.push(options.method || "GET");
    if (url === "/dispatch/reports") return response([]);
    if (url === "/tracking/reports") {
      return response([{
        truck_id: "FALLBACK-1",
        enforcer_name: "Fallback Enforcer",
        session_status: "stopped",
        report_status_label: "Manually Stopped · Route Recorded",
        ended_at: "2026-09-04 15:00:00"
      }]);
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  await loadDashboardLatestOperation();
  assert.equal(elements.get("dashboardLatestSource").textContent, "Tracking Report");
  assert.equal(elements.get("dashboardLatestTruck").textContent, "FALLBACK-1");
  assert.deepEqual([...new Set(methods)], ["GET"]);
}

async function testFailureIsolationAndSafeUi() {
  resetElements();
  global.getFleetSummaryApiUrl = () => "/fleet/summary";
  global.getDispatchPlansApiUrl = ({ operational_date }) => `/dispatch/plans?date=${operational_date}`;
  global.getDispatchLiveApiUrl = () => "/dispatch/live";
  global.getDispatchReportsApiUrl = () => "/dispatch/reports";
  global.getTrackingReportsApiUrl = () => "/tracking/reports";
  global.webAdminFetch = async (url) => {
    if (url === "/fleet/summary") return response(null, { ok: false });
    if (url.includes("/dispatch/plans?date=")) {
      return url.includes(dashboardOperationsCalendarDate(new Date(), 0))
        ? response([{ operational_date: dashboardOperationsCalendarDate(new Date(), 0), status: "planned" }])
        : response(null, { ok: false });
    }
    if (url === "/dispatch/live") return response({ 58: { dispatch_ticket_id: 8 } });
    if (url === "/dispatch/reports") return response([]);
    if (url === "/tracking/reports") return response(null, { ok: false });
    throw new Error(`Unexpected URL ${url}`);
  };

  const results = await loadDashboardOperationsSnapshot();
  assert.equal(results.length, 3);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(elements.get("dashboardFleetTotal").textContent, "—");
  assert.equal(elements.get("dashboardDispatchTomorrow").textContent, "—");
  assert.equal(elements.get("dashboardDispatchActive").textContent, "1");
  assert.equal(elements.get("dashboardLatestTruck").textContent, "Unavailable");
  operationIds.slice(0, 15).forEach((id) => {
    assert.doesNotMatch(String(elements.get(id).textContent), /undefined|null|NaN|\[object Object\]/);
  });
}

async function main() {
  testDashboardMarkupAndScope();
  testFleetMetrics();
  testManilaDatesAndDispatchMetrics();
  testLatestOperationModels();
  await testPrimaryAndFallbackRequests();
  await testFailureIsolationAndSafeUi();
  console.log("Dashboard Operations Snapshot UI tests passed (13/13 scenarios).");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
