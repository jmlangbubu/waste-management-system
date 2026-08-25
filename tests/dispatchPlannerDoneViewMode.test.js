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
    hasTruck: true,
    sessionEligible: true,
    routeReady: true,
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

function testAssignedRouteAndDoneReadiness() {
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
  assert.match(draftRoute, /applyDispatchAssignedDraftOrder\(journey\.plannedStops\)/);
  assert.doesNotMatch(draftRoute, /requestDispatchRoadCostMatrix/);
  assert.match(draftRoute, /buildDispatchRouteLayers\([\s\S]*usePersistedStopOrder: false/);
  assert.match(draftRoute, /renderDispatchSelectionFallback\([\s\S]*usePersistedStopOrder: false/);

  assert.equal(readyState({ routeReady: false }).canFinalize, false);
  assert.equal(readyState({ processing: true }).canFinalize, false);
  assert.equal(readyState().canFinalize, true);
}

function testSingleAuthoritativeRouteReadyContract() {
  const finalization = functionBlock(
    dispatch,
    "function dispatchPlannerFinalizationState",
    "function updateDispatchPlannerActions"
  );
  const plannerActions = functionBlock(
    dispatch,
    "function updateDispatchPlannerActions",
    "function requireDispatchAssignmentForDestinations"
  );
  const collectForm = functionBlock(
    dispatch,
    "function collectDispatchTicketForm",
    "function resetDispatchTicketForm"
  );
  const draftRoute = functionBlock(
    dispatch,
    "function renderDispatchDraftOnLiveMap",
    "function renderDispatchPlanningMap"
  );
  const routeNotice = functionBlock(
    dispatch,
    "function updateDispatchRoutePreviewNotice",
    "function updateDispatchMapRouteOverlay"
  );
  const clearReadinessError = functionBlock(
    dispatch,
    "function clearDispatchRouteReadinessError",
    "function dispatchDraftsInAssignedOrder"
  );
  const setup = functionBlock(
    dispatch,
    "function setupDispatchModule",
    'if (typeof window !== "undefined")'
  );

  assert.match(finalization, /const routeReady = Boolean\(options\.routeReady\)/);
  assert.doesNotMatch(finalization, /optimizedCount|hasSuccessfulRouteState|hasVisibleRoute/);
  assert.match(plannerActions, /getDispatchCurrentAssignedRouteReadiness\(\)/);
  assert.match(plannerActions, /routeReady: routeReadiness\.routeReady/);
  assert.match(collectForm, /requireDispatchAssignedRouteReady[\s\S]*getDispatchCurrentAssignedRouteReadiness\(selectedStops\)/);
  assert.doesNotMatch(collectForm, /dispatchOptimizedRouteStops|optimization|cost matrix/i);
  assert.match(draftRoute, /assignmentSignature: signature/);
  assert.match(draftRoute, /dispatchPendingRoutingSignature = ""[\s\S]*clearDispatchRouteReadinessError\(\)[\s\S]*updateDispatchRoutePreviewNotice\("ready"\)/);
  assert.match(routeNotice, /getDispatchCurrentAssignedRouteReadiness\(\)\.routeReady/);
  assert.match(clearReadinessError, /Retry dispatch to continue/);
  assert.match(setup, /data-dispatch-retry-dispatch[\s\S]*dispatchSelectedTruckNow\(\)/);
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
  assert.match(plannedRoute, /const routeStops = dispatchSavedStopRouteItems\(details\.stops\)/);
  assert.match(plannedRoute, /const startPoint = wmo/);
  assert.doesNotMatch(plannedRoute, /requestDispatchRoadCostMatrix|lockedPrefixCount/);
  assert.match(plannedRoute, /usePersistedStopOrder: true/);
  assert.match(trackingEligibility, /!truck\?\.dispatch/);
}

function testDestinationPickerPresentation() {
  const destinationStepStart = dashboard.indexOf('data-dispatch-step-panel="2"');
  const destinationStepEnd = dashboard.indexOf('id="dispatchCurrentPanel"', destinationStepStart);
  const destinationStep = dashboard.slice(destinationStepStart, destinationStepEnd);
  const presentationCss = css.slice(css.indexOf("/* Step 2 destination hierarchy"));

  assert.ok(destinationStepStart > dashboard.indexOf('id="dispatchPlannerStepHeader"'));
  assert.ok(destinationStep.indexOf("dispatchAddDestinationsHeading") >= 0);
  assert.ok(destinationStep.indexOf("dispatchDestinationSearchField") > destinationStep.indexOf("dispatchAddDestinationsHeading"));
  assert.ok(destinationStep.indexOf("dispatch-available-destinations-heading") > destinationStep.indexOf("dispatchDestinationSearchField"));
  assert.ok(destinationStep.indexOf("dispatchRequiredDestinationsHeading") > destinationStep.indexOf("dispatch-available-destinations-heading"));
  assert.ok(destinationStep.indexOf("dispatch-wmo-return") > destinationStep.indexOf("dispatchRequiredDestinationsHeading"));
  assert.ok(dashboard.indexOf("dispatch-inline-form-actions") > destinationStepEnd);

  assert.match(dashboard, /Add Destinations/);
  assert.match(dashboard, /Search road, street or location\.\.\./);
  assert.match(dashboard, /Available Locations/);
  assert.match(dashboard, /Selected Route/);
  assert.match(dashboard, /No collection stops selected yet\.[\s\S]*Search above to add destinations\./);
  assert.match(dispatch, /Type to search Gensan roads and locations\./);
  assert.match(dispatch, /dispatch-catalog-result-row[\s\S]*data-dispatch-popular-index/);
  assert.match(dispatch, /dispatch-stop-planned-number/);
  assert.match(dispatch, /dispatch-catalog-add-action/);
  assert.match(dispatch, /dispatchSetElementVisible\([\s\S]*dispatchDestinationSearchClearBtn/);
  assert.match(presentationCss, /\.dispatch-destinations-step[\s\S]*overflow-x:\s*hidden;[\s\S]*overflow-y:\s*auto/);
  assert.match(presentationCss, /\.dispatch-add-destinations-section[\s\S]*overflow:\s*visible/);
  assert.match(presentationCss, /\.dispatch-combobox-options\.dispatch-destination-results,[\s\S]*max-height:\s*none/);
  assert.match(presentationCss, /\.dispatch-inline-stop-rows[\s\S]*overflow:\s*visible/);
  assert.doesNotMatch(presentationCss, /\.dispatch-add-destinations-section\s*\{[^}]*overflow-y:\s*auto/);
}

function run() {
  testEditableEligibilityAndTwoStepShell();
  testAssignedRouteAndDoneReadiness();
  testSingleAuthoritativeRouteReadyContract();
  testDoneReusesExistingLifecycleAndFailurePreservesDraft();
  testFinalizedTicketsAlwaysUseReadOnlyMode();
  testPersistedOrderAndTerminalReuseContracts();
  testDestinationPickerPresentation();
  console.log("dispatchPlannerDoneViewMode.test.js: all assertions passed");
}

run();
