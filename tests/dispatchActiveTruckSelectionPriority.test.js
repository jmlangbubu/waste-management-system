const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  dispatchResolveKnownTicketForTruck,
  dispatchTruckCanStartNewDispatch
} = require("../frontend/js/admin/admin-dispatch.js");
const {
  TRACKING_GPS_AVAILABILITY_WINDOW_MS,
  getTrackingTruckDispatchState,
  isTrackingTruckAvailable
} = require("../frontend/js/admin/admin-tracking.js");

const ROOT = path.resolve(__dirname, "..");
const NOW = Date.parse("2026-08-26T02:00:00.000Z");
const dispatchSource = fs.readFileSync(
  path.join(ROOT, "frontend/js/admin/admin-dispatch.js"),
  "utf8"
);
const trackingSource = fs.readFileSync(
  path.join(ROOT, "frontend/js/admin/admin-tracking.js"),
  "utf8"
);
const stateSource = fs.readFileSync(
  path.join(ROOT, "frontend/js/admin/admin-state.js"),
  "utf8"
);

function functionBlock(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing ${start}`);
  assert.ok(endIndex > startIndex, `missing ${end}`);
  return source.slice(startIndex, endIndex);
}

function truck(overrides = {}) {
  return {
    session_id: 91,
    truck_id: "TRUCK-9",
    truck_name: "TRUCK-9",
    session_status: "active",
    latitude: 6.1164,
    longitude: 125.1716,
    accuracy: 10,
    location_last_updated: new Date(NOW - 30_000).toISOString(),
    ...overrides
  };
}

function ticket(status = "in_progress", overrides = {}) {
  return {
    id: 1,
    dispatch_ticket_id: 1,
    ticket_number: "001",
    truck_id: "TRUCK-9",
    status,
    total_stops: 3,
    completed_stops: 0,
    ...overrides
  };
}

function testDispatchStateAlwaysPrecedesGpsAvailability() {
  for (const status of ["dispatched", "in_progress", "returning_to_wmo"]) {
    const fresh = truck({ dispatch: ticket(status) });
    const stale = truck({
      dispatch: ticket(status),
      location_last_updated: new Date(
        NOW - TRACKING_GPS_AVAILABILITY_WINDOW_MS - 1
      ).toISOString()
    });
    const freshState = getTrackingTruckDispatchState(fresh, NOW);
    const staleState = getTrackingTruckDispatchState(stale, NOW);
    assert.equal(freshState.key, "active_dispatch");
    assert.equal(freshState.title, "Active Dispatch");
    assert.equal(freshState.actionLabel, "Open Live Dispatch");
    assert.equal(staleState.key, "active_dispatch");
    assert.equal(staleState.title, "Active Dispatch");
    assert.equal(staleState.gps.label, "GPS Stale");
    assert.equal(isTrackingTruckAvailable(fresh, NOW), false);
    assert.equal(isTrackingTruckAvailable(stale, NOW), false);
  }

  const prepared = truck({ existing_dispatch_ticket: ticket("prepared") });
  const preparedState = getTrackingTruckDispatchState(prepared, NOW);
  assert.equal(preparedState.key, "prepared_dispatch");
  assert.equal(preparedState.title, "Existing Dispatch Ticket");
  assert.equal(preparedState.actionLabel, "View Ticket");
  assert.equal(preparedState.available, false);

  const available = getTrackingTruckDispatchState(truck(), NOW);
  assert.equal(available.key, "available");
  assert.equal(available.title, "Available for dispatch");
  const unavailable = getTrackingTruckDispatchState(truck({
    location_last_updated: new Date(
      NOW - TRACKING_GPS_AVAILABILITY_WINDOW_MS - 1
    ).toISOString()
  }), NOW);
  assert.equal(unavailable.key, "unavailable");
  assert.equal(unavailable.title, "Unavailable for dispatch");
}

function testTerminalTicketReturnsToGpsAvailability() {
  for (const status of ["completed", "cancelled"]) {
    const fresh = truck({ existing_dispatch_ticket: ticket(status) });
    const stale = truck({
      existing_dispatch_ticket: ticket(status),
      location_last_updated: new Date(
        NOW - TRACKING_GPS_AVAILABILITY_WINDOW_MS - 1
      ).toISOString()
    });
    assert.equal(getTrackingTruckDispatchState(fresh, NOW).key, "available");
    assert.equal(getTrackingTruckDispatchState(stale, NOW).key, "unavailable");
  }
}

function testKnownTicketBlocksNewDispatchWithoutLiveSummaryShape() {
  const active = truck({
    dispatch: {
      dispatch_ticket_id: 1,
      ticket_number: "001",
      dispatch_status: "in_progress"
    }
  });
  assert.equal(dispatchResolveKnownTicketForTruck(active).status, "in_progress");
  assert.equal(dispatchTruckCanStartNewDispatch(active, [active]), false);

  const prepared = truck({ existing_dispatch_ticket: ticket("prepared") });
  assert.equal(dispatchResolveKnownTicketForTruck(prepared).status, "prepared");
  assert.equal(dispatchTruckCanStartNewDispatch(prepared, [prepared]), false);
}

function testActiveClickOpensExistingDispatchBeforePlanner() {
  const request = functionBlock(
    dispatchSource,
    "async function requestDispatchTruckSelection",
    "function getDispatchSelectedReliablePoint"
  );
  const openExisting = functionBlock(
    dispatchSource,
    "async function openDispatchExistingTicketForTruck",
    "async function resolveDispatchTicketBeforePlanning"
  );
  const prepare = functionBlock(
    dispatchSource,
    "function prepareDispatchPlannerForTruck",
    "function handleDispatchSelectedSessionEnded"
  );
  const lookupIndex = request.indexOf("resolveDispatchTicketBeforePlanning(truck)");
  const selectionIndex = request.indexOf("selectTruck(sessionId, truckId");
  assert.ok(lookupIndex >= 0 && lookupIndex < selectionIndex);
  assert.match(
    request,
    /if \(lookup\.ticket\) \{[\s\S]*await openDispatchExistingTicketForTruck[\s\S]*return;/
  );
  assert.match(openExisting, /preparePlanner: false/);
  assert.match(openExisting, /hydrateWorkspace: false/);
  assert.match(openExisting, /status: "existing_dispatch"/);
  assert.match(openExisting, /clearRoute: false/);
  assert.match(openExisting, /setDispatchWorkspaceTab\("plan"\)/);
  assert.doesNotMatch(
    openExisting,
    /setDispatchPlannerMode\("create"\)|clearDispatchPlannedRoute|clearDispatchDestinationMarkers|renderDispatchDraftOnLiveMap/
  );
  assert.match(prepare, /dispatchResolveKnownTicketForTruck\(truck\)/);
  assert.ok(
    prepare.indexOf("dispatchResolveKnownTicketForTruck(truck)") <
    prepare.indexOf('setDispatchPlannerMode("create")')
  );
  assert.match(prepare, /openDispatchExistingTicketForTruck/);
  assert.doesNotMatch(prepare, /status: "checking"/);
}

function testActiveClickKeepsRouteAndMarkers() {
  const openExisting = functionBlock(
    dispatchSource,
    "async function openDispatchExistingTicketForTruck",
    "async function resolveDispatchTicketBeforePlanning"
  );
  assert.match(openExisting, /if \(!dispatchHasVisiblePlannedRoute\(\)\)/);
  assert.match(openExisting, /renderDispatchTicketDetails\(hydratedDetails\)/);
  assert.doesNotMatch(
    openExisting,
    /clearDispatchDraftPlannerLayers|clearDispatchPlannedRoute|clearDispatchDestinationMarkers|resetDispatchTicketForm/
  );

  const activeCleanup = functionBlock(
    dispatchSource,
    "function clearDispatchDraftPlannerLayers",
    "function createDispatchWmoMarkerLayer"
  );
  assert.match(activeCleanup, /dispatchActiveMonitoringMatchesSelection\(\)[\s\S]*return false/);
}

function testOlderEligibilityCannotOverwriteConfirmedActiveDispatch() {
  const setEligibility = functionBlock(
    dispatchSource,
    "function setDispatchNewTicketEligibility",
    "async function resolveDispatchNewTicketEligibility"
  );
  const preflight = functionBlock(
    dispatchSource,
    "async function resolveDispatchTicketBeforePlanning",
    "async function requestDispatchTruckSelection"
  );
  assert.match(stateSource, /const dispatchEligibilityRequestGuard = createLatestResponseGuard\(\)/);
  assert.match(setEligibility, /dispatchTicketIsLive\(confirmedTicket\)/);
  assert.match(setEligibility, /status: "existing_dispatch"/);
  assert.match(setEligibility, /dispatchEligibilityRequestGeneration \+= 1/);
  assert.match(setEligibility, /dispatchEligibilityRequestGuard\.invalidate\(\)/);
  assert.match(preflight, /dispatchEligibilityRequestGuard\.begin\(\)/);
  assert.match(preflight, /signal: request\.signal/);
  assert.match(preflight, /dispatchEligibilityRequestGuard\.isCurrent\(request\)/);
  assert.match(preflight, /generation !== dispatchEligibilityRequestGeneration/);
}

function testCardAndReloadRemainConsistent() {
  const cards = functionBlock(
    trackingSource,
    "function renderActiveTruckList",
    "function updateTruckMarkers"
  );
  const loadActive = functionBlock(
    trackingSource,
    "async function loadActiveTrucks",
    "function invalidateTrackingActiveRequests"
  );
  assert.match(cards, /getTrackingTruckDispatchState\(truck\)/);
  assert.match(cards, /Active Dispatch/);
  assert.match(cards, /Open Live Dispatch/);
  assert.match(cards, /Existing Dispatch Ticket/);
  assert.match(cards, /View Ticket/);
  assert.match(loadActive, /resolveTrackingMonitoredDispatch\(trackingOperationalTrucks\)/);
  assert.match(loadActive, /await hydrateSelectedTruckWorkspace\(selectedSessionId, \{ keepView: true \}\)/);
  assert.doesNotMatch(loadActive, /prepareDispatchPlannerForTruck\(monitoredDispatch\)/);
}

function testReliableRouteStartDoesNotReturn() {
  assert.doesNotMatch(dispatchSource, /Reliable route start|selectedStartMarker|custom-start-marker/);
  assert.doesNotMatch(trackingSource, /Reliable route start|selectedStartMarker|custom-start-marker/);
  assert.doesNotMatch(stateSource, /selectedStartMarker/);
}

function run() {
  testDispatchStateAlwaysPrecedesGpsAvailability();
  testTerminalTicketReturnsToGpsAvailability();
  testKnownTicketBlocksNewDispatchWithoutLiveSummaryShape();
  testActiveClickOpensExistingDispatchBeforePlanner();
  testActiveClickKeepsRouteAndMarkers();
  testOlderEligibilityCannotOverwriteConfirmedActiveDispatch();
  testCardAndReloadRemainConsistent();
  testReliableRouteStartDoesNotReturn();
  console.log("dispatchActiveTruckSelectionPriority.test.js: all assertions passed");
}

run();
