const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  dispatchPlannerFinalizationState,
  dispatchPlannerStepName,
  dispatchTicketViewMode,
  dispatchTruckCanStartNewDispatch
} = require("../frontend/js/admin/admin-dispatch.js");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const dispatch = read("frontend/js/admin/admin-dispatch.js");
const tracking = read("frontend/js/admin/admin-tracking.js");
const dashboard = read("frontend/admin-dashboard.html");
const css = read("frontend/css/admin/admin-dispatch.css");

function functionBlock(source, start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}

function readyState(overrides = {}) {
  return dispatchPlannerFinalizationState({
    destinationCount: 3,
    ticketNumberValid: true,
    hasTruck: true,
    sessionEligible: true,
    routePreparing: false,
    optimizedCount: 3,
    hasSuccessfulRouteState: true,
    hasVisibleRoute: true,
    processing: false,
    ...overrides
  });
}

function testEditableEligibilityAndTwoStepShell() {
  const freshTruck = { session_id: 58, dispatch: null };
  const activeTruck = { session_id: 58, dispatch: { ticket_number: "WMO-58" } };
  assert.equal(dispatchTruckCanStartNewDispatch(freshTruck, [freshTruck]), true);
  assert.equal(dispatchTruckCanStartNewDispatch(activeTruck, [activeTruck]), false);
  assert.equal(dispatchPlannerStepName(1), "Ticket");
  assert.equal(dispatchPlannerStepName(2), "Destinations");
  assert.equal((dashboard.match(/data-dispatch-step-panel="[12]"/g) || []).length, 2);
  assert.doesNotMatch(dashboard, /data-dispatch-step-panel="3"|dispatchStepReviewBtn|Review Route/);
  assert.match(dashboard, /Step 1 of 2/);
  assert.match(dashboard, /id="dispatchNowBtn"[^>]*>Done</);
}

function testAutomaticRouteAndDoneReadiness() {
  const addRow = functionBlock(
    dispatch,
    "function addDispatchStopRow",
    "function renderDispatchOptimizedRouteList"
  );
  const draftRoute = functionBlock(
    dispatch,
    "function renderDispatchDraftOnLiveMap",
    "function renderDispatchPlanningMap"
  );
  assert.match(addRow, /renderDispatchDraftOnLiveMap\(\)/);
  assert.match(draftRoute, /renderDispatchDestinationMarkers\(items, \{ usePersistedStopOrder: false \}\)/);
  assert.match(draftRoute, /applyDispatchOptimizedDraftOrder\(journey\.plannedStops\)/);
  assert.match(draftRoute, /buildDispatchRouteLayers\([\s\S]*usePersistedStopOrder: false/);
  assert.match(draftRoute, /renderDispatchSelectionFallback\([\s\S]*usePersistedStopOrder: false/);

  assert.equal(readyState({ ticketNumberValid: false }).canFinalize, false);
  assert.equal(readyState({ destinationCount: 0, optimizedCount: 0 }).canFinalize, false);
  assert.equal(readyState({ routePreparing: true }).canFinalize, false);
  assert.equal(readyState({ optimizedCount: 2 }).canFinalize, false);
  assert.equal(readyState({ hasSuccessfulRouteState: false }).canFinalize, false);
  assert.equal(readyState({ hasVisibleRoute: false }).canFinalize, false);
  assert.equal(readyState().canFinalize, true);
}

function testDoneReusesExistingLifecycleAndFailurePreservesDraft() {
  const done = functionBlock(
    dispatch,
    "async function dispatchSelectedTruckNow",
    "function dispatchTicketQuery"
  );
  const save = functionBlock(
    dispatch,
    "async function saveDispatchDraft",
    "function submitDispatchTicketForm"
  );
  assert.match(done, /saveDispatchDraft\(\{ notify: false, showResult: false, manageProcessing: false \}\)/);
  assert.match(done, /getDispatchTicketApiUrl\(ticketId\)\}\/issue/);
  assert.match(done, /getDispatchTicketApiUrl\(ticketId\)\}\/link-session/);
  assert.equal((done.match(/saveDispatchDraft/g) || []).length, 1);
  assert.match(done, /selectedDispatchTicket = details;[\s\S]*renderDispatchTicketDetails\(details\);[\s\S]*renderDispatchPlannedRoute\(details\)/);
  assert.match(done, /catch \(error\) \{[\s\S]*renderDispatchStepProgress\([\s\S]*return;/);
  assert.match(save, /captureDispatchRoutePreviewState\(\)/);
  assert.match(save, /restoreDispatchRoutePreviewState\(routeSnapshot\)/);
  assert.doesNotMatch(functionBlock(dispatch, "function submitDispatchTicketForm", "async function retryDispatchSessionLink"), /saveDispatchDraft|dispatchRequest/);
}

function testFinalizedTicketsAlwaysUseReadOnlyMode() {
  assert.equal(dispatchTicketViewMode({ status: "prepared" }), "editable");
  assert.equal(dispatchTicketViewMode({ status: "dispatched" }), "readonly");
  assert.equal(dispatchTicketViewMode({ status: "in_progress" }), "readonly");
  assert.equal(dispatchTicketViewMode({ status: "returning_to_wmo" }), "readonly");
  assert.equal(dispatchTicketViewMode({ status: "completed" }), "details");

  const prepare = functionBlock(
    dispatch,
    "function prepareDispatchPlannerForTruck",
    "function handleDispatchSelectedSessionEnded"
  );
  const details = functionBlock(
    dispatch,
    "function renderDispatchTicketDetails(details)",
    "const DISPATCH_PORTAL_MODAL_IDS"
  );
  const openTicket = functionBlock(
    dispatch,
    "async function openDispatchTicket",
    "function dispatchReportEndedAt"
  );
  const selectTruck = functionBlock(
    tracking,
    "function selectTruck",
    "function bindActiveTruckSelection"
  );

  assert.match(prepare, /if \(truck\.dispatch\)[\s\S]*setDispatchPlannerMode\("live"\)[\s\S]*return/);
  assert.match(selectTruck, /prepareDispatchPlannerForTruck\(selectedTrackingTruck\)/);
  assert.match(openTicket, /dispatchTicketIsLive\(details\.ticket\)[\s\S]*renderDispatchTicketDetails\(details\)[\s\S]*setDispatchWorkspaceTab\("plan"\)/);
  assert.match(details, /dispatchTicketViewMode\(ticket\) !== "readonly"/);
  assert.match(details, /dispatch-readonly-summary/);
  assert.match(details, /renderDispatchReadOnlyRoute\(stops, currentStop\)/);
  assert.match(details, /Last GPS Update/);
  assert.match(details, /lastKnownPoint/);
  assert.doesNotMatch(details, /data-dispatch-stop-remove|dispatchDestinationSearch|dispatchClearRouteBtn|dispatchTicketNumber|dispatchNowBtn|Review Route/);
  assert.match(css, /\.dispatch-live-monitor[\s\S]*overflow-y:\s*auto/);
}

function testPersistedOrderAndTerminalReuseContracts() {
  const readonlyRoute = functionBlock(
    dispatch,
    "function renderDispatchReadOnlyRoute",
    "function dispatchTicketIsStale"
  );
  const plannedRoute = functionBlock(
    dispatch,
    "function renderDispatchPlannedRoute",
    "function dispatchEventLabel"
  );
  const trackingEligibility = functionBlock(
    tracking,
    "function isTrackingTruckAvailable",
    "function filterAvailableTrackingTrucks"
  );
  assert.match(readonlyRoute, /sort\([\s\S]*first\.stop_order[\s\S]*second\.stop_order/);
  assert.match(plannedRoute, /lockedPrefixCount: items\.length/);
  assert.match(plannedRoute, /dispatchPersistedStopOrder/);
  assert.match(trackingEligibility, /!truck\?\.dispatch/);
}

function testDestinationPickerPresentation() {
  assert.match(dashboard, /Search road, street or location\.\.\./);
  assert.match(dashboard, /Available Locations/);
  assert.match(dashboard, /Selected Route/);
  assert.match(dashboard, /No destinations selected\.[\s\S]*Search above to add collection stops\./);
  assert.match(dispatch, /dispatch-catalog-add-action/);
  assert.match(dispatch, /dispatchSetElementVisible\([\s\S]*dispatchDestinationSearchClearBtn/);
  assert.match(css, /\.dispatch-destinations-step[\s\S]*overflow-y:\s*auto/);
  assert.match(css, /\.dispatch-combobox-options\.dispatch-destination-results,[\s\S]*max-height:\s*none/);
}

function run() {
  testEditableEligibilityAndTwoStepShell();
  testAutomaticRouteAndDoneReadiness();
  testDoneReusesExistingLifecycleAndFailurePreservesDraft();
  testFinalizedTicketsAlwaysUseReadOnlyMode();
  testPersistedOrderAndTerminalReuseContracts();
  testDestinationPickerPresentation();
  console.log("dispatchPlannerDoneViewMode.test.js: all assertions passed");
}

run();
