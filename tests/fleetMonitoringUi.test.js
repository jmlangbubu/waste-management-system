const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  fleetConditionLabel,
  fleetOperationalLabel,
  fleetGpsLabel,
  fleetRequiresReason,
  fleetValidateTruck,
  fleetValidateCondition,
  fleetTableRowsHtml,
  renderFleetSummary,
  fleetErrorMessage,
  fleetUserHasAccess
} = require("../frontend/js/admin/admin-fleet");
const { dispatchDailyDistance } = require("../frontend/js/admin/admin-dispatch");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const fleetSource = read("frontend/js/admin/admin-fleet.js");
const apiSource = read("frontend/js/admin/admin-api.js");
const initSource = read("frontend/js/admin/admin-init.js");
const dispatchSource = read("frontend/js/admin/admin-dispatch.js");
const dashboardHtml = read("frontend/admin-dashboard.html");
const fleetCss = read("frontend/css/admin/admin-fleet.css");

function testEmptyFleetAndZeroSummary() {
  const empty = fleetTableRowsHtml([]);
  assert.match(empty, /No fleet trucks are registered yet\./);
  assert.match(empty, /official WMO truck roster once it has been verified/);
  assert.doesNotMatch(empty, /TRUCK-\d/i);

  const elements = new Map([
    "fleetSummaryTotal",
    "fleetSummaryAvailable",
    "fleetSummaryActive",
    "fleetSummaryMaintenance",
    "fleetSummaryOutOfService"
  ].map((id) => [id, { textContent: "pending" }]));
  const originalDocument = global.document;
  global.document = { getElementById: (id) => elements.get(id) || null };
  try {
    renderFleetSummary({});
  } finally {
    global.document = originalDocument;
  }
  elements.forEach((element) => assert.equal(element.textContent, "0"));
}

function testFleetRowsKeepStatusDimensionsSeparate() {
  const html = fleetTableRowsHtml([{
    id: 7,
    truck_code: "VERIFIED-07",
    truck_name: "Verified Collection Truck",
    plate_number: "ABC-1234",
    fleet_condition: "for_maintenance",
    condition_reason: "Brake inspection",
    operational_state_key: "active_dispatch",
    operational_state: "Active / On Dispatch",
    gps_status: "online",
    assignable: false
  }]);
  assert.match(html, /VERIFIED-07/);
  assert.match(html, /Verified Collection Truck/);
  assert.match(html, /ABC-1234/);
  assert.match(html, /For Maintenance/);
  assert.match(html, /Brake inspection/);
  assert.match(html, /Active \/ On Dispatch/);
  assert.match(html, />Online</);
  assert.match(html, />No</);
  assert.match(html, /Change Condition/);
  assert.equal(fleetConditionLabel("out_of_service"), "Out of Service");
  assert.equal(fleetOperationalLabel({ operational_state_key: "returning_to_wmo" }), "Returning to WMO");
  assert.equal(fleetGpsLabel("stale"), "Stale");
}

function testFleetValidation() {
  assert.equal(fleetRequiresReason("available"), false);
  assert.equal(fleetRequiresReason("for_maintenance"), true);
  assert.equal(fleetValidateTruck({
    truck_code: "",
    truck_name: "Truck",
    fleet_condition: "available"
  }).message, "Truck Code is required.");
  assert.equal(fleetValidateTruck({
    truck_code: "VERIFIED-01",
    truck_name: "Truck",
    fleet_condition: "for_maintenance",
    condition_reason: ""
  }).message, "Condition Reason is required for this fleet condition.");
  assert.equal(fleetValidateTruck({
    truck_code: "VERIFIED-01",
    truck_name: "Truck",
    fleet_condition: "available"
  }).valid, true);
  assert.equal(fleetValidateCondition({
    fleet_condition: "out_of_service",
    condition_reason: ""
  }).valid, false);
  assert.equal(fleetValidateCondition({
    fleet_condition: "available",
    condition_reason: null
  }).valid, true);
}

function testSafeApiErrorsAndRoleGate() {
  assert.equal(
    fleetErrorMessage({ status: 409, message: "A fleet truck with this truck code already exists" }),
    "A fleet truck with this truck code already exists"
  );
  assert.equal(
    fleetErrorMessage({ status: 403, message: "raw" }),
    "You do not have permission to manage fleet records."
  );
  assert.equal(
    fleetErrorMessage({ status: 401, message: "raw" }),
    "Your Web Admin session has expired."
  );
  assert.equal(fleetUserHasAccess({ role: "super_admin" }), true);
  assert.equal(fleetUserHasAccess({ role: "personnel" }), true);
  assert.equal(fleetUserHasAccess({ role: "division_admin" }), false);
}

function testApiAndRefreshIntegration() {
  assert.match(apiSource, /function getFleetTrucksApiUrl\(\)[\s\S]*\/fleet\/trucks/);
  assert.match(apiSource, /function getFleetSummaryApiUrl\(\)[\s\S]*\/fleet\/summary/);
  assert.match(apiSource, /function getFleetTruckConditionApiUrl\(truckId\)/);
  assert.match(fleetSource, /async function fleetRequest[\s\S]*webAdminFetch/);
  assert.match(fleetSource, /method: "POST"/);
  assert.match(fleetSource, /method: "PATCH"/);
  assert.match(fleetSource, /Promise\.allSettled\(\[\s*loadFleetSummary\(\),\s*loadFleetTrucks\(\)/);
  assert.ok((fleetSource.match(/await refreshFleetMonitoring\(\{ announce: false \}\)/g) || []).length >= 2);
  assert.ok((fleetSource.match(/fleetSetFormFeedback\("fleet(AddTruck|Condition)Feedback", message\)/g) || []).length >= 2);
  assert.doesNotMatch(fleetSource, /\balert\s*\(/);
  assert.doesNotMatch(fleetSource, /https?:\/\//);
}

function testDailyOperationsCompatibility() {
  assert.equal(dispatchDailyDistance(null, 0), "Not recorded");
  assert.equal(dispatchDailyDistance(0, 0, "No Operation"), "0.00 km");
  assert.equal(dispatchDailyDistance(1.257, 4), "1.26 km");
  assert.match(dispatchSource, /report\.result \? ` · \$\{dispatchEscape\(report\.result\)\}`/);
  assert.match(dispatchSource, /summary\.result \? ` · \$\{dispatchEscape\(summary\.result\)\}`/);
}

function testMarkupScriptOrderAndModalSafety() {
  assert.equal((dashboardHtml.match(/css\/admin\/admin-fleet\.css/g) || []).length, 1);
  assert.equal((dashboardHtml.match(/js\/admin\/admin-fleet\.js/g) || []).length, 1);
  assert.ok(dashboardHtml.indexOf("admin-api.js") < dashboardHtml.indexOf("admin-fleet.js"));
  assert.ok(dashboardHtml.indexOf("admin-fleet.js") < dashboardHtml.indexOf("admin-init.js"));
  assert.match(initSource, /safeRun\(initializeFleetMonitoring, "initializeFleetMonitoring"\)/);
  assert.doesNotMatch(initSource, /await safeRun\(initializeFleetMonitoring/);
  assert.match(dashboardHtml, /id="trackingSection"[\s\S]*id="fleetOverviewTitle"[\s\S]*class="page-card live-tracking-card"/);
  assert.match(dashboardHtml, /<th>Fleet Condition<\/th>[\s\S]*<th>Operational State<\/th>[\s\S]*<th>GPS<\/th>[\s\S]*<th>Assignable<\/th>/);
  assert.match(fleetCss, /body > \.fleet-modal\.custom-modal[\s\S]*z-index: var\(--wmo-z-modal\)/);
  assert.match(fleetSource, /document\.body\.appendChild\(modal\)/);
}

testEmptyFleetAndZeroSummary();
testFleetRowsKeepStatusDimensionsSeparate();
testFleetValidation();
testSafeApiErrorsAndRoleGate();
testApiAndRefreshIntegration();
testDailyOperationsCompatibility();
testMarkupScriptOrderAndModalSafety();

console.log("Fleet Monitoring UI tests passed (A-M coverage).");
