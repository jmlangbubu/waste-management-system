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
const navigationSource = read("frontend/js/admin/admin-navigation.js");
const dispatchSource = read("frontend/js/admin/admin-dispatch.js");
const dashboardHtml = read("frontend/admin-dashboard.html");
const fleetCss = read("frontend/css/admin/admin-fleet.css");

function countId(id) {
  return (dashboardHtml.match(new RegExp(`\\bid="${id}"`, "g")) || []).length;
}

function elementMarkupById(id) {
  const opening = new RegExp(`<([a-z][\\w-]*)\\b[^>]*\\bid="${id}"[^>]*>`, "i").exec(dashboardHtml);
  assert.ok(opening, `Expected #${id} to exist`);
  const tagName = opening[1];
  const tags = new RegExp(`</?${tagName}\\b[^>]*>`, "gi");
  tags.lastIndex = opening.index;
  let depth = 0;
  let match;
  while ((match = tags.exec(dashboardHtml))) {
    if (match[0].startsWith("</")) depth -= 1;
    else if (!match[0].endsWith("/>")) depth += 1;
    if (depth === 0) return dashboardHtml.slice(opening.index, tags.lastIndex);
  }
  assert.fail(`Expected #${id} to have a closing tag`);
}

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
  assert.equal(countId("openFleetOverviewBtn"), 1);
  assert.equal(countId("fleetOverviewModal"), 1);
  assert.equal((dashboardHtml.match(/class="page-card fleet-overview-card"/g) || []).length, 1);
  assert.equal(countId("fleetTableBody"), 1);
  const parentMarkup = elementMarkupById("fleetOverviewModal");
  assert.match(parentMarkup, /class="page-card fleet-overview-card"/);
  assert.match(parentMarkup, /id="fleetOverviewTitle"/);
  assert.match(parentMarkup, /id="fleetRefreshBtn"/);
  assert.match(parentMarkup, /id="fleetAddTruckBtn"/);
  assert.match(parentMarkup, /id="fleetTableBody"/);
  assert.doesNotMatch(parentMarkup, /id="fleet(?:AddTruck|Condition)Modal"/);
  [
    "fleetOverviewTitle",
    "fleetRefreshBtn",
    "fleetAddTruckBtn",
    "fleetTableBody",
    "fleetAddTruckModal",
    "fleetConditionModal"
  ].forEach((id) => assert.equal(countId(id), 1, `Expected one #${id}`));
  assert.match(dashboardHtml, /<th>Fleet Condition<\/th>[\s\S]*<th>Operational State<\/th>[\s\S]*<th>GPS<\/th>[\s\S]*<th>Assignable<\/th>/);
  assert.match(fleetCss, /body > \.fleet-modal\.custom-modal[\s\S]*z-index: var\(--wmo-z-modal\)/);
  assert.match(fleetCss, /#fleetOverviewModal > \.fleet-overview-parent-content[\s\S]*width: min\(1280px/);
  assert.match(fleetCss, /body > \.fleet-modal\.custom-modal:not\(\.hidden\)[\s\S]*z-index: calc\(var\(--wmo-z-modal\) \+ 40\)/);
  assert.match(fleetCss, /html\.fleet-modal-open,\s*body\.fleet-modal-open\s*\{[\s\S]*overflow: hidden !important/);
  assert.match(fleetCss, /html\.fleet-modal-open body #adminLayout #dashboardSidebar[\s\S]*z-index: calc\(var\(--wmo-z-modal\) \+ 80\)[\s\S]*pointer-events: none/);
  assert.match(fleetCss, /html\.fleet-modal-open body #dashboardSidebar \.nav-btn,[\s\S]*#sidebarLogoToggleBtn[\s\S]*pointer-events: auto/);
  assert.match(fleetCss, /html\.fleet-modal-open body #adminLayout #mobileSidebarToggleBtn[\s\S]*z-index: calc\(var\(--wmo-z-modal\) \+ 90\)/);
  assert.match(fleetCss, /html\.fleet-modal-open body #adminLayout #sidebarBackdrop:not\(\.hidden\)[\s\S]*z-index: calc\(var\(--wmo-z-modal\) \+ 70\)/);
  assert.match(fleetSource, /document\.body\.appendChild\(modal\)/);
  assert.match(fleetSource, /FLEET_CHILD_MODAL_IDS = Object\.freeze\(\[[\s\S]*fleetAddTruckModal[\s\S]*fleetConditionModal/);
  assert.match(fleetSource, /function openFleetOverviewParentModal[\s\S]*void refreshFleetMonitoring\(\)/);
  assert.match(fleetSource, /function fleetSyncModalScrollLock[\s\S]*fleetOverviewModal[\s\S]*fleetHasOpenChildModal[\s\S]*document\.documentElement\.classList\.toggle\("fleet-modal-open", shouldLock\)[\s\S]*document\.body\.classList\.toggle\("fleet-modal-open", shouldLock\)/);
  assert.match(fleetSource, /function fleetSetTriggerAccess[\s\S]*openFleetOverviewBtn/);
  const escapeBlock = fleetSource.match(/document\.addEventListener\("keydown"[\s\S]*?\n  \}\);/)?.[0] || "";
  assert.ok(escapeBlock.indexOf("fleetConditionModal") < escapeBlock.indexOf("fleetAddTruckModal"));
  assert.ok(escapeBlock.indexOf("fleetAddTruckModal") < escapeBlock.indexOf("fleetOverviewModal"));
  assert.match(navigationSource, /closeFleetModalsForNavigation/);
  assert.match(navigationSource, /closeAllAdminModalsOnNavigation\(\);\s*showSection\(sectionId\);/);
  assert.match(navigationSource, /document\.documentElement\.classList\.remove\("fleet-modal-open"\)/);
  assert.match(fleetSource, /getElementById\("fleetRefreshBtn"\)[\s\S]*refreshFleetMonitoring/);
  assert.match(fleetSource, /getElementById\("fleetAddTruckBtn"\)[\s\S]*openAddTruckModal/);
  assert.match(fleetSource, /getElementById\("fleetTableBody"\)[\s\S]*data-fleet-change-condition/);
}

testEmptyFleetAndZeroSummary();
testFleetRowsKeepStatusDimensionsSeparate();
testFleetValidation();
testSafeApiErrorsAndRoleGate();
testApiAndRefreshIntegration();
testDailyOperationsCompatibility();
testMarkupScriptOrderAndModalSafety();

console.log("Fleet Monitoring UI tests passed (A-M coverage).");
