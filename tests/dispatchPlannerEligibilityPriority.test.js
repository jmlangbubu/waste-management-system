const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DISPATCH_NON_TERMINAL_TICKET_STATUSES,
  dispatchExistingTicketPresentation,
  dispatchFindNonTerminalTicket,
  dispatchResolveEligibilityPriority
} = require("../frontend/js/admin/admin-dispatch.js");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");
const dispatch = read("frontend/js/admin/admin-dispatch.js");
const tracking = read("frontend/js/admin/admin-tracking.js");
const state = read("frontend/js/admin/admin-state.js");
const dashboard = read("frontend/admin-dashboard.html");
const dispatchCss = read("frontend/css/admin/admin-dispatch.css");
const trackingCss = read("frontend/css/admin/admin-tracking.css");
const dispatchService = read("services/dispatchService.js");

function functionBlock(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0, `${start} must exist`);
  assert.ok(endIndex > startIndex, `${end} must follow ${start}`);
  return source.slice(startIndex, endIndex);
}

function truck(overrides = {}) {
  return {
    session_id: 27,
    truck_id: "TRUCK-9",
    session_status: "active",
    ...overrides
  };
}

function testExistingTicketHasPriorityOverStaleGps() {
  const ticket = {
    id: 91,
    ticket_number: "001",
    truck_id: "TRUCK-9",
    status: "in_progress"
  };
  const result = dispatchResolveEligibilityPriority({
    truck: truck(),
    tickets: [ticket],
    gpsEligible: false
  });

  assert.equal(result.status, "existing_dispatch");
  assert.equal(result.ticket.id, 91);
  assert.equal(result.ticket.ticket_number, "001");
  assert.deepEqual(DISPATCH_NON_TERMINAL_TICKET_STATUSES, [
    "prepared",
    "dispatched",
    "in_progress",
    "returning_to_wmo"
  ]);
}

function testTicketLookupUsesExactTruckAndAllNonTerminalStatuses() {
  const tickets = [
    { id: 1, truck_id: "TRUCK-90", ticket_number: "WRONG", status: "in_progress" },
    { id: 2, truck_id: "TRUCK-9", ticket_number: "OLD", status: "completed" },
    { id: 3, truck_id: "TRUCK-9", ticket_number: "CURRENT", status: "prepared" }
  ];
  const found = dispatchFindNonTerminalTicket(tickets, "truck-9");
  assert.equal(found.id, 3);
  assert.equal(found.ticket_number, "CURRENT");
}

function testStatusAwareExistingTicketActionsAndTerminalStatuses() {
  const preparedTicket = {
    id: 3,
    truck_id: "TRUCK-9",
    ticket_number: "001",
    status: "prepared"
  };
  const preparedResult = dispatchResolveEligibilityPriority({
    truck: truck(),
    tickets: [preparedTicket],
    gpsEligible: false
  });
  const preparedPresentation = dispatchExistingTicketPresentation(
    preparedResult.ticket,
    "TRUCK-9"
  );
  assert.equal(preparedResult.status, "existing_dispatch");
  assert.equal(preparedPresentation.title, "EXISTING DISPATCH TICKET");
  assert.equal(preparedPresentation.actionLabel, "View Ticket");
  assert.equal(preparedPresentation.isLive, false);

  for (const status of ["dispatched", "in_progress", "returning_to_wmo"]) {
    const presentation = dispatchExistingTicketPresentation({ status }, "TRUCK-9");
    assert.equal(presentation.title, "ACTIVE DISPATCH FOUND");
    assert.equal(presentation.actionLabel, "Open Live Dispatch");
    assert.equal(presentation.isLive, true);
  }

  for (const status of ["completed", "cancelled"]) {
    const result = dispatchResolveEligibilityPriority({
      truck: truck(),
      tickets: [{ id: 8, truck_id: "TRUCK-9", ticket_number: "OLD", status }],
      gpsEligible: true
    });
    assert.equal(result.status, "eligible");
    assert.equal(result.ticket, null);
  }
}

function testGpsIsEvaluatedOnlyAfterNoTicketIsFound() {
  assert.equal(dispatchResolveEligibilityPriority({
    truck: truck(),
    tickets: [],
    gpsEligible: false
  }).status, "gps_required");
  assert.equal(dispatchResolveEligibilityPriority({
    truck: truck(),
    tickets: [],
    gpsEligible: true
  }).status, "eligible");
  assert.equal(dispatchResolveEligibilityPriority({
    truck: truck(),
    tickets: [],
    gpsEligible: false,
    error: new Error("Unavailable")
  }).status, "error");
}

function testSelectionChecksTicketBeforeGpsAndDoesNotEnterStepTwo() {
  const resolve = functionBlock(
    dispatch,
    "async function resolveDispatchTicketBeforePlanning",
    "async function requestDispatchTruckSelection"
  );
  const request = functionBlock(
    dispatch,
    "async function requestDispatchTruckSelection",
    "function getDispatchSelectedReliablePoint"
  );
  const prepare = functionBlock(
    dispatch,
    "function prepareDispatchPlannerForTruck",
    "function handleDispatchSelectedSessionEnded"
  );
  const setStep = functionBlock(
    dispatch,
    "function setDispatchPlannerStep",
    "function openDispatchPlannerDrawer"
  );
  const ticketLookupIndex = resolve.indexOf("getDispatchTicketsApiUrl");
  const selectionIndex = request.indexOf("selectTruck(sessionId, truckId");
  const lookupIndex = request.indexOf("resolveDispatchTicketBeforePlanning(truck)");
  const gpsCheckIndex = prepare.indexOf("dispatchTruckCanStartNewDispatch");
  const knownTicketIndex = prepare.indexOf("dispatchResolveKnownTicketForTruck");

  assert.ok(ticketLookupIndex >= 0);
  assert.ok(lookupIndex >= 0 && lookupIndex < selectionIndex);
  assert.match(resolve, /dispatchFindNonTerminalTicket/);
  assert.ok(knownTicketIndex >= 0 && knownTicketIndex < gpsCheckIndex);
  assert.match(request, /if \(lookup\.ticket\) \{[\s\S]*openDispatchExistingTicketForTruck[\s\S]*return/);
  assert.match(prepare, /setDispatchPlannerStep\(1/);
  assert.doesNotMatch(prepare, /resolveDispatchNewTicketEligibility\(truck\)/);
  assert.doesNotMatch(prepare, /setDispatchPlannerStep\(2|renderDispatchDraftOnLiveMap/);
  assert.match(setStep, /nextStep === 2[\s\S]*!dispatchEligibilityAllowsPlanning\(\)[\s\S]*return false/);
}

function testInvalidNewDispatchNeverRequestsOsrmOrShowsTransactionFailure() {
  const route = functionBlock(
    dispatch,
    "function renderDispatchDraftOnLiveMap",
    "function renderDispatchPlanningMap"
  );
  const eligibilityGuardIndex = route.indexOf("!dispatchEligibilityAllowsPlanning()");
  const routeRequestIndex = route.indexOf("requestDispatchRoadJourney");
  const requireEligibility = functionBlock(
    dispatch,
    "function requireDispatchNewTicketEligibility",
    "function captureDispatchRoutePreviewState"
  );
  const dispatchNow = functionBlock(
    dispatch,
    "async function dispatchSelectedTruckNow",
    "function dispatchTicketQuery"
  );

  assert.ok(eligibilityGuardIndex >= 0 && eligibilityGuardIndex < routeRequestIndex);
  assert.match(route, /dispatchPlannerMode === "create"/);
  assert.doesNotMatch(requireEligibility, /renderDispatchStepProgress|renderDispatchWorkflowResult/);
  assert.ok(
    dispatchNow.indexOf("requireDispatchNewTicketEligibility") <
    dispatchNow.indexOf("renderDispatchStepProgress")
  );
}

function testBlockerUiShowsOnePriorityStateAndExistingDispatchAction() {
  const render = functionBlock(
    dispatch,
    "function renderDispatchEligibilityState",
    "function setDispatchNewTicketEligibility"
  );
  assert.match(dashboard, /id="dispatchEligibilityPanel"/);
  assert.match(dashboard, /id="dispatchOpenExistingBtn"[^>]*>View Ticket</);
  assert.match(dashboard, /id="dispatchEligibilityBackBtn"[^>]*>Back</);
  assert.match(render, /dispatchExistingTicketPresentation/);
  assert.match(render, /openButton\.textContent = existingTicketPresentation\.actionLabel/);
  assert.match(dispatch, /EXISTING DISPATCH TICKET/);
  assert.match(dispatch, /ACTIVE DISPATCH FOUND/);
  assert.match(render, /GPS LOCATION REQUIRED/);
  assert.match(dispatch, /already has an active dispatch/);
  assert.match(render, /does not currently have a fresh reliable GPS location/);
  assert.match(render, /dispatchWorkflowResult[^\n]*classList\.add\("hidden"\)/);
  assert.match(dispatchCss, /\.dispatch-inline-planner\.has-eligibility-blocker[\s\S]*grid-template-rows:\s*minmax\(0, 1fr\)/);
  assert.match(dispatchCss, /\.dispatch-eligibility-actions[\s\S]*flex-wrap:\s*wrap/);
}

function testReliableStartMarkerIsGoneButRouteOriginAndCurrentMarkerRemain() {
  assert.doesNotMatch(tracking, /Reliable route start|selectedStartMarker|custom-start-marker/);
  assert.doesNotMatch(state, /selectedStartMarker/);
  assert.doesNotMatch(dispatchCss, /tracking-route-endpoint\.start/);
  assert.doesNotMatch(trackingCss, /custom-start-marker/);

  const route = functionBlock(
    tracking,
    "async function loadTruckRoute",
    "async function hydrateSelectedTruckWorkspace"
  );
  assert.match(route, /const startPoint = latlngs\[0\]/);
  assert.match(route, /selectedReliableRoutePoint = currentReliablePoint/);
  assert.match(route, /selectedCurrentMarker = L\.marker/);
  assert.match(route, /trackingActualRoutePane/);
  assert.match(dispatch, /const DISPATCH_PLANNED_ROUTE_STYLE[\s\S]*color: "#2d73c7"/);
  assert.match(dispatch, /createDispatchWmoMarkerLayer[\s\S]*dispatchMarkerIcon\("W", "wmo"\)/);
}

function testExistingActiveRouteLifecycleRemainsIndependent() {
  const loadLinked = functionBlock(
    dispatch,
    "async function loadDispatchForTrackingSession",
    "function dispatchMarkerIcon"
  );
  const liveRoute = functionBlock(
    dispatch,
    "function renderDispatchPlannedRoute",
    "function dispatchEventLabel"
  );
  assert.match(loadLinked, /deferExistingDispatchOpen[\s\S]*return details/);
  assert.ok(
    loadLinked.indexOf("deferExistingDispatchOpen") <
    loadLinked.indexOf("renderDispatchTicketDetails(details)")
  );
  assert.match(liveRoute, /requestDispatchRoadJourney/);
  assert.match(liveRoute, /buildDispatchRouteLayers/);
  assert.doesNotMatch(liveRoute, /dispatchEligibilityAllowsPlanning/);
}

function testBackendRaceGuardRemainsFinalAuthority() {
  const guard = functionBlock(
    dispatchService,
    "async assertTruckHasNoOtherNonTerminalDispatch",
    "async getSelectedActiveTrackingSession"
  );
  const create = functionBlock(
    dispatchService,
    "async createTicket(payload = {})",
    "async listTickets(filters = {})"
  );
  const guardIndex = create.indexOf("assertTruckHasNoOtherNonTerminalDispatch");
  const insertIndex = create.indexOf("INSERT INTO dispatch_tickets");

  assert.match(guard, /NON_TERMINAL_TICKET_STATUSES/);
  assert.match(guard, /FOR UPDATE/);
  assert.ok(guardIndex >= 0 && guardIndex < insertIndex);
  assert.match(create, /this\.withTransaction/);
}

function run() {
  testExistingTicketHasPriorityOverStaleGps();
  testTicketLookupUsesExactTruckAndAllNonTerminalStatuses();
  testStatusAwareExistingTicketActionsAndTerminalStatuses();
  testGpsIsEvaluatedOnlyAfterNoTicketIsFound();
  testSelectionChecksTicketBeforeGpsAndDoesNotEnterStepTwo();
  testInvalidNewDispatchNeverRequestsOsrmOrShowsTransactionFailure();
  testBlockerUiShowsOnePriorityStateAndExistingDispatchAction();
  testReliableStartMarkerIsGoneButRouteOriginAndCurrentMarkerRemain();
  testExistingActiveRouteLifecycleRemainsIndependent();
  testBackendRaceGuardRemainsFinalAuthority();
  console.log("dispatchPlannerEligibilityPriority.test.js: all assertions passed");
}

run();
