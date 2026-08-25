const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  dispatchActiveRouteMarkerStateSignature,
  dispatchActiveRouteStops
} = require("../frontend/js/admin/admin-dispatch.js");
const {
  buildTrackingAvailabilitySnapshot,
  resolveTrackingMonitoredDispatch,
  trackingRouteSignature
} = require("../frontend/js/admin/admin-tracking.js");

const ROOT = path.resolve(__dirname, "..");
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
  assert.ok(startIndex >= 0, `missing ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `missing ${end}`);
  return source.slice(startIndex, endIndex);
}

function activeDispatch(sessionId, ticketId) {
  return {
    session_id: sessionId,
    truck_id: `TRUCK-${sessionId}`,
    session_status: "active",
    dispatch: {
      dispatch_ticket_id: ticketId,
      ticket_number: `DPT-${ticketId}`
    }
  };
}

function persistedStops() {
  return [
    {
      id: 103,
      stop_order: 3,
      location_name: "Third",
      latitude: 6.13,
      longitude: 125.18,
      stop_status: "pending"
    },
    {
      id: 101,
      stop_order: 1,
      location_name: "First",
      latitude: 6.11,
      longitude: 125.16,
      stop_status: "completed"
    },
    {
      id: 102,
      stop_order: 2,
      location_name: "Second",
      latitude: 6.12,
      longitude: 125.17,
      stop_status: "on_the_way"
    }
  ];
}

function testPersistedStopOrderDrivesActiveMarkersAndRemainingRoute() {
  const details = {
    ticket: { id: 700, status: "in_progress" },
    stops: persistedStops()
  };
  assert.deepEqual(
    dispatchActiveRouteStops(details).map((stop) => stop.stop_order),
    [2, 3],
    "completed stop 1 must remain a marker but not be rerouted as a remaining stop"
  );

  const firstSignature = dispatchActiveRouteMarkerStateSignature(details);
  const reorderedSignature = dispatchActiveRouteMarkerStateSignature({
    ...details,
    stops: [...details.stops].reverse()
  });
  assert.equal(firstSignature, reorderedSignature, "source array order must not renumber persisted stops");
  assert.match(firstSignature, /101:1:completed/);
  assert.match(firstSignature, /102:2:on_the_way/);
  assert.match(firstSignature, /103:3:pending/);
}

function testOneActiveDispatchAutoSelectionIsDeterministic() {
  const one = activeDispatch(9, 409);
  assert.equal(resolveTrackingMonitoredDispatch([one]), one);

  const older = activeDispatch(7, 407);
  const newer = activeDispatch(11, 411);
  assert.equal(resolveTrackingMonitoredDispatch([older, newer]), newer);
  assert.equal(resolveTrackingMonitoredDispatch([older, newer], 7), older);

  const liveOnly = {
    "19": {
      dispatch_ticket_id: 419,
      ticket_number: "DPT-419",
      truck_id: "TRUCK-19",
      tracking_session_status: "active",
      last_latitude: 6.11,
      last_longitude: 125.18,
      last_gps_update: "2026-08-25T12:00:00+08:00"
    }
  };
  const snapshot = buildTrackingAvailabilitySnapshot([], () => null, Date.now(), liveOnly);
  assert.equal(snapshot.operationalTrucks.length, 1);
  assert.equal(snapshot.operationalTrucks[0].session_id, "19");
  assert.equal(snapshot.operationalTrucks[0].dispatch, liveOnly["19"]);
}

function testPollingRouteSignatureRetainsUnchangedActualTrail() {
  const points = [
    { stableId: 1, timestamp: 10, lat: 6.1, lng: 125.1 },
    { stableId: 2, timestamp: 20, lat: 6.2, lng: 125.2 }
  ];
  assert.equal(trackingRouteSignature(points), trackingRouteSignature(points.map((point) => ({ ...point }))));
  assert.notEqual(
    trackingRouteSignature(points),
    trackingRouteSignature([...points, { stableId: 3, timestamp: 30, lat: 6.3, lng: 125.3 }])
  );

  const loader = functionBlock(
    trackingSource,
    "async function loadTruckRoute",
    "async function hydrateSelectedTruckWorkspace"
  );
  const emptyRouteIndex = loader.indexOf("if (!routePoints.length)");
  const removeRouteIndex = loader.indexOf("truckMap.removeLayer(selectedRoutePolyline)");
  assert.ok(emptyRouteIndex >= 0 && emptyRouteIndex < removeRouteIndex);
  assert.match(loader, /const routeChanged = nextRouteSignature !== selectedRouteSignature \|\| !selectedRoutePolyline/);
  assert.match(loader, /if \(routeChanged\) \{[\s\S]*clearTrackingGapPolylines/);
  assert.match(loader, /if \(!keepView && routeChanged\)/);
}

function testPostDispatchAndReloadRehydrateWithoutTruckClick() {
  const dispatchNow = functionBlock(
    dispatchSource,
    "async function dispatchSelectedTruckNow",
    "function dispatchTicketQuery"
  );
  const linkedLoader = functionBlock(
    dispatchSource,
    "async function loadDispatchForTrackingSession",
    "function dispatchMarkerIcon"
  );
  const activePoll = functionBlock(
    trackingSource,
    "async function loadActiveTrucks",
    "function invalidateTrackingActiveRequests"
  );

  assert.match(dispatchNow, /selectedDispatchTicket = details;[\s\S]*renderDispatchTicketDetails\(details\);[\s\S]*renderDispatchPlannedRoute\(details\)/);
  assert.doesNotMatch(dispatchNow, /clearDispatchPlannedRoute|clearDispatchDestinationMarkers/);
  assert.match(activePoll, /if \(!selectedSessionId\) \{[\s\S]*resolveTrackingMonitoredDispatch\(trackingOperationalTrucks\)/);
  assert.match(activePoll, /selectedSessionId = monitoredDispatch\.session_id/);
  assert.match(activePoll, /await hydrateSelectedTruckWorkspace\(selectedSessionId, \{ keepView: true \}\)/);
  assert.doesNotMatch(activePoll, /prepareDispatchPlannerForTruck\(monitoredDispatch\)/);
  assert.match(linkedLoader, /renderDispatchTicketDetails\(details\)[\s\S]*renderDispatchPlannedRoute\(details/);
  assert.match(linkedLoader, /deferExistingDispatchOpen[\s\S]*renderDispatchPlannedRoute\(details, \{[\s\S]*preservePlannerMode: true/);
}

function testActiveRendererRestoresMetadataMarkersAndBlueRouteTogether() {
  const activeRenderer = functionBlock(
    dispatchSource,
    "function renderDispatchPlannedRoute",
    "function dispatchEventLabel"
  );
  const markerRenderer = functionBlock(
    dispatchSource,
    "function renderDispatchPersistedActiveMarkers",
    "function renderDispatchPlannedRoute"
  );

  assert.match(activeRenderer, /dispatchActiveRouteStops\(details, groups\)/);
  assert.match(activeRenderer, /getTrackingAvailabilityMeta\(selectedTrackingTruck\)\.available/);
  assert.match(activeRenderer, /resolveDispatchRouteOrigin\(activeRoutePoint, \{ wmo \}\)/);
  assert.match(activeRenderer, /requestDispatchRoadJourney\([\s\S]*activateDispatchPlannedLayerGroups\(layers\)/);
  assert.match(markerRenderer, /dispatchSavedStopRouteItems\(details\.stops \|\| \[\]\)/);
  assert.match(markerRenderer, /usePersistedStopOrder: true/);
  assert.match(markerRenderer, /currentStopId: groups\.currentStop\?\.id \|\| null/);
  assert.match(activeRenderer, /renderDispatchTerminalStopMarkers\(layers, groups\.completedStops, groups\.skippedStops\)/);
  assert.match(activeRenderer, /dispatchActiveRouteOrderSignature = routeStops\.map/);
}

function testGpsLossOsrmFailureAndPollingPreserveWorkingLayers() {
  const activeRenderer = functionBlock(
    dispatchSource,
    "function renderDispatchPlannedRoute",
    "function dispatchEventLabel"
  );
  const linkedLoader = functionBlock(
    dispatchSource,
    "async function loadDispatchForTrackingSession",
    "function dispatchMarkerIcon"
  );

  assert.match(
    activeRenderer,
    /\["missing", "stale"\]\.includes\(routeOrigin\.source\)[\s\S]*dispatchHasVisiblePlannedRoute\(\)[\s\S]*updateDispatchRoutePreviewNotice\("ready"\)[\s\S]*return/
  );
  assert.doesNotMatch(
    activeRenderer.slice(
      activeRenderer.indexOf('["missing", "stale"]'),
      activeRenderer.indexOf("if (!routeStops.length")
    ),
    /clearDispatchPlannedRoute|clearDispatchDestinationMarkers|removeLayer/
  );
  assert.match(activeRenderer, /previous_route_retained: dispatchHasVisiblePlannedRoute\(\)/);
  assert.match(activeRenderer, /if \(!dispatchHasVisiblePlannedRoute\(\)\) \{[\s\S]*renderDispatchPersistedActiveMarkers\(details, groups\)/);
  assert.match(activeRenderer, /updateDispatchRoutePreviewNotice\("error"\)/);
  assert.doesNotMatch(activeRenderer, /L\.polyline\(\[\s*\[startPoint/);

  assert.match(linkedLoader, /mustRehydrateRoute[\s\S]*!dispatchHasVisiblePlannedRoute\(\)/);
  assert.doesNotMatch(linkedLoader, /clearDispatchPlannedRoute\("poll|clearDispatchDestinationMarkers\(\).*same/);
}

function testPlannerCleanupCannotEraseMatchingActiveDispatch() {
  const draftClear = functionBlock(
    dispatchSource,
    "function clearDispatchDraftPlannerLayers",
    "function createDispatchWmoMarkerLayer"
  );
  const closeDrawer = functionBlock(
    dispatchSource,
    "function closeDispatchPlannerDrawer",
    "function setDispatchWorkspaceTab"
  );
  const eligibility = functionBlock(
    dispatchSource,
    "function setDispatchNewTicketEligibility",
    "async function resolveDispatchNewTicketEligibility"
  );

  assert.match(draftClear, /dispatchActiveMonitoringMatchesSelection\(\)[\s\S]*return false/);
  assert.match(draftClear, /clearDispatchPlannedRoute\(reason\)[\s\S]*clearDispatchDestinationMarkers\(\)/);
  assert.match(eligibility, /clearDispatchDraftPlannerLayers/);
  assert.doesNotMatch(closeDrawer, /clearDispatchPlannedRoute|clearDispatchDestinationMarkers|resetDispatchTicketForm/);
  assert.match(stateSource, /let dispatchActiveRouteTicketId = null/);
  assert.match(stateSource, /let dispatchActiveRouteSessionId = null/);
}

function testOnlyEndDispatchPerformsTheIntendedActiveClear() {
  const endDispatch = functionBlock(
    dispatchSource,
    "async function submitDispatchEnd",
    "async function performDispatchAction"
  );
  assert.match(endDispatch, /selectedDispatchTicket = null/);
  assert.match(endDispatch, /clearDispatchPlannedRoute\("dispatch ended early"\)/);
  assert.match(endDispatch, /clearDispatchDestinationMarkers\(\)/);
  assert.match(endDispatch, /delete dispatchLiveBySession/);
}

function testReliableRouteStartMarkerRemainsAbsent() {
  assert.doesNotMatch(dispatchSource, /Reliable route start/);
  assert.doesNotMatch(trackingSource, /Reliable route start|selectedStartMarker|custom-start-marker/);
  assert.doesNotMatch(stateSource, /selectedStartMarker/);
}

function run() {
  testPersistedStopOrderDrivesActiveMarkersAndRemainingRoute();
  testOneActiveDispatchAutoSelectionIsDeterministic();
  testPollingRouteSignatureRetainsUnchangedActualTrail();
  testPostDispatchAndReloadRehydrateWithoutTruckClick();
  testActiveRendererRestoresMetadataMarkersAndBlueRouteTogether();
  testGpsLossOsrmFailureAndPollingPreserveWorkingLayers();
  testPlannerCleanupCannotEraseMatchingActiveDispatch();
  testOnlyEndDispatchPerformsTheIntendedActiveClear();
  testReliableRouteStartMarkerRemainsAbsent();
  console.log("dispatchActiveRouteRehydration.test.js: all assertions passed");
}

run();
