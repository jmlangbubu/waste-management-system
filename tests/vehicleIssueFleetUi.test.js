const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  FLEET_CONDITION_LABELS,
  VEHICLE_ISSUE_SEVERITY_LABELS,
  VEHICLE_ISSUE_RESOLUTION_LABELS,
  fleetVehicleIssueSeverityLabel,
  fleetVehicleIssueStatusLabel,
  fleetVehicleIssueCategoryLabel,
  fleetVehicleIssueIsOpen,
  fleetVehicleIssueResolutionRequiresNotes,
  fleetValidateVehicleIssueResolution,
  fleetVehicleIssueFilteredReports,
  fleetLatestOpenIssueForTruck,
  fleetVehicleIssueRowsHtml,
  fleetVehicleIssueDetailHtml
} = require("../frontend/js/admin/admin-fleet");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const dashboardHtml = read("frontend/admin-dashboard.html");
const fleetSource = read("frontend/js/admin/admin-fleet.js");
const apiSource = read("frontend/js/admin/admin-api.js");
const fleetCss = read("frontend/css/admin/admin-fleet.css");

function countId(id) {
  return (dashboardHtml.match(new RegExp(`\\bid="${id}"`, "g")) || []).length;
}

function allIds() {
  return [...dashboardHtml.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
}

const reports = [
  {
    id: 13,
    fleet_truck_id: 8,
    truck_code_snapshot: "TRUCK-8",
    truck_name_snapshot: "Collection Truck 8",
    reported_by_name_snapshot: "Juan Enforcer",
    issue_category: "brakes",
    description: "Brake response feels delayed.",
    severity: "critical",
    report_status: "submitted",
    created_at: "2026-09-25T01:00:00.000Z"
  },
  {
    id: 12,
    fleet_truck_id: 8,
    truck_code_snapshot: "TRUCK-8",
    truck_name_snapshot: "Collection Truck 8",
    reported_by_name_snapshot: "Juan Enforcer",
    issue_category: "noise_vibration",
    description: "Recurring vibration.",
    severity: "moderate",
    report_status: "under_review",
    created_at: "2026-09-24T01:00:00.000Z"
  },
  {
    id: 11,
    fleet_truck_id: 9,
    truck_code_snapshot: "TRUCK-9",
    truck_name_snapshot: "Collection Truck 9",
    reported_by_name_snapshot: "Maria Enforcer",
    issue_category: "lights",
    description: "Marker light replaced.",
    severity: "low",
    report_status: "resolved",
    resolution_action: "continue_operation",
    resolution_notes: null,
    resolved_by_name: "WMO Personnel",
    resolved_at: "2026-09-24T02:00:00.000Z",
    created_at: "2026-09-23T01:00:00.000Z"
  }
];

function testSingleFleetEntryAndModals() {
  assert.equal(countId("fleetVehicleIssuesBtn"), 1);
  assert.equal(countId("fleetVehicleIssuesCount"), 1);
  assert.equal(countId("fleetVehicleIssuesModal"), 1);
  assert.equal(countId("fleetVehicleIssueDetailModal"), 1);
  assert.equal(countId("fleetManageVehicleIssue"), 1);
  assert.match(dashboardHtml, /id="fleetVehicleIssuesBtn"[\s\S]*Vehicle Issues/);
  assert.match(dashboardHtml, /id="fleetVehicleIssueStatusFilter"[\s\S]*value="open" selected>Open/);
  assert.match(dashboardHtml, /value="submitted">Submitted[\s\S]*value="under_review">Under Review[\s\S]*value="resolved">Resolved[\s\S]*value="all">All/);
  assert.match(dashboardHtml, /id="fleetVehicleIssueSeverityFilter"[\s\S]*value="critical">Critical[\s\S]*value="moderate">Moderate[\s\S]*value="low">Low/);
  assert.match(fleetCss, /#fleetVehicleIssuesModal[\s\S]*z-index/);
  assert.match(fleetCss, /#fleetVehicleIssueDetailModal[\s\S]*z-index/);
}

function testNoDuplicateIds() {
  const ids = allIds();
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  assert.deepEqual(duplicates, []);

  const referencedIds = [...fleetSource.matchAll(/getElementById\("(fleetVehicleIssues?[^" ]*)"\)/g)]
    .map((match) => match[1]);
  [...new Set(referencedIds)].forEach((id) => {
    assert.equal(countId(id), 1, `Expected one HTML element for referenced #${id}`);
  });
}

function testLabelsAndOpenFiltering() {
  assert.deepEqual(Object.keys(VEHICLE_ISSUE_SEVERITY_LABELS).sort(), ["critical", "low", "moderate"]);
  assert.equal(fleetVehicleIssueSeverityLabel("critical"), "Critical");
  assert.equal(fleetVehicleIssueSeverityLabel("moderate"), "Moderate");
  assert.equal(fleetVehicleIssueSeverityLabel("low"), "Low");
  assert.equal(fleetVehicleIssueStatusLabel("under_review"), "Under Review");
  assert.equal(fleetVehicleIssueCategoryLabel("noise_vibration"), "Unusual Noise / Vibration");
  assert.equal(fleetVehicleIssueIsOpen(reports[0]), true);
  assert.equal(fleetVehicleIssueIsOpen(reports[1]), true);
  assert.equal(fleetVehicleIssueIsOpen(reports[2]), false);
  assert.deepEqual(
    fleetVehicleIssueFilteredReports(reports, { status: "open", severity: "all" }).map((item) => item.id),
    [13, 12]
  );
  assert.deepEqual(
    fleetVehicleIssueFilteredReports(reports, { status: "all", severity: "low" }).map((item) => item.id),
    [11]
  );
  assert.equal(fleetLatestOpenIssueForTruck(8, reports).id, 13);
  assert.equal(fleetLatestOpenIssueForTruck(9, reports), null);
}

function testQueueAndDetailRendering() {
  const queue = fleetVehicleIssueRowsHtml(reports, { status: "open", severity: "all" });
  assert.match(queue, /Critical/);
  assert.match(queue, /TRUCK-8/);
  assert.match(queue, /Brakes/);
  assert.match(queue, /Juan Enforcer/);
  assert.match(queue, /Submitted/);
  assert.match(queue, /data-vehicle-issue-view="13"/);
  assert.doesNotMatch(queue, /Marker light replaced/);

  const resolvedDetail = fleetVehicleIssueDetailHtml({
    ...reports[2],
    current_fleet_condition: "available",
    current_condition_reason: null,
    possible_concern: "Lighting concern assessed.",
    recommended_action: "Continue with monitoring.",
    assistant_ruleset_version: "vehicle-issue-triage-v1",
    dispatch_plan_id: 5,
    dispatch_ticket_id: 6,
    tracking_session_id: 7,
    latitude: null,
    longitude: null,
    accuracy_meters: null,
    location_recorded_at: null,
    image_url: null
  });
  assert.match(resolvedDetail, /Truck Information/);
  assert.match(resolvedDetail, /Current Fleet Condition/);
  assert.match(resolvedDetail, /Current Operational State/);
  assert.match(resolvedDetail, /Report Information/);
  assert.match(resolvedDetail, /Vehicle Issue Status/);
  assert.match(resolvedDetail, /Vehicle Assistant Assessment/);
  assert.match(resolvedDetail, /Evidence/);
  assert.match(resolvedDetail, /Operation References/);
  assert.match(resolvedDetail, /This resolved report is read-only/);
  assert.match(resolvedDetail, /Continue Operation/);
  assert.doesNotMatch(resolvedDetail, /Mark Under Review/);
  assert.doesNotMatch(resolvedDetail, /Resolve Vehicle Issue/);
  assert.doesNotMatch(resolvedDetail, />0\.000000, 0\.000000</);
}

function testReviewAndResolutionContracts() {
  assert.match(fleetSource, /report_status[\s\S]*!== "submitted"[\s\S]*Only submitted reports can be marked under review/);
  assert.match(fleetSource, /getVehicleIssueReviewApiUrl\(fleetVehicleIssueSelected\.id\)[\s\S]*method: "PATCH"/);
  assert.deepEqual(VEHICLE_ISSUE_RESOLUTION_LABELS, {
    continue_operation: "Continue Operation",
    set_for_maintenance: "Set For Maintenance",
    set_out_of_service: "Set Out of Service"
  });
  assert.equal(fleetVehicleIssueResolutionRequiresNotes("continue_operation"), false);
  assert.equal(fleetVehicleIssueResolutionRequiresNotes("set_for_maintenance"), true);
  assert.equal(fleetVehicleIssueResolutionRequiresNotes("set_out_of_service"), true);
  assert.equal(fleetValidateVehicleIssueResolution({
    resolution_action: "continue_operation",
    resolution_notes: ""
  }).valid, true);
  assert.equal(fleetValidateVehicleIssueResolution({
    resolution_action: "set_for_maintenance",
    resolution_notes: ""
  }).valid, false);
  assert.equal(fleetValidateVehicleIssueResolution({
    resolution_action: "set_out_of_service",
    resolution_notes: "Unsafe tire"
  }).valid, true);
  assert.match(fleetSource, /getVehicleIssueResolveApiUrl\(fleetVehicleIssueSelected\.id\)[\s\S]*method: "POST"[\s\S]*JSON\.stringify\(payload\)/);
  assert.match(fleetSource, /window\.confirm\(confirmation\)/);
  assert.match(fleetSource, /await refreshFleetMonitoring\(\{ announce: false \}\)[\s\S]*Vehicle issue resolved successfully/);
  assert.match(fleetSource, /controls\?\.classList\.toggle\("hidden", !unresolved\)/);
}

function testFleetStatusSeparationAndWarning() {
  assert.deepEqual(Object.keys(FLEET_CONDITION_LABELS).sort(), [
    "available",
    "for_maintenance",
    "out_of_service"
  ]);
  assert.doesNotMatch(fleetSource, /issue_reported/);
  assert.doesNotMatch(dashboardHtml, /value="issue_reported"/);
  assert.match(fleetSource, /Updating the Fleet condition does not automatically end the current active operation\./);
  assert.match(fleetSource, /FLEET_ACTIVE_OPERATION_KEYS[\s\S]*active_dispatch[\s\S]*returning_to_wmo[\s\S]*tracking_awaiting_dispatch/);
  assert.match(dashboardHtml, /Latest unresolved report/);
}

function testCentralizedApiAndCsrf() {
  assert.match(apiSource, /function getVehicleIssuesApiUrl\(filters = \{\}\)[\s\S]*getAppApiBase\(\)[\s\S]*\/vehicle-issues/);
  assert.match(apiSource, /function getVehicleIssueReviewApiUrl\(reportId\)/);
  assert.match(apiSource, /function getVehicleIssueResolveApiUrl\(reportId\)/);
  assert.match(fleetSource, /async function fleetRequest[\s\S]*webAdminFetch/);
  assert.match(apiSource, /async function webAdminFetch[\s\S]*X-CSRF-Token/);
  assert.doesNotMatch(fleetSource, /https?:\/\//);
}

testSingleFleetEntryAndModals();
testNoDuplicateIds();
testLabelsAndOpenFiltering();
testQueueAndDetailRendering();
testReviewAndResolutionContracts();
testFleetStatusSeparationAndWarning();
testCentralizedApiAndCsrf();

console.log("Vehicle Issue Fleet UI tests passed.");
