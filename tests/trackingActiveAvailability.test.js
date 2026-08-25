const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  TRACKING_GPS_AVAILABILITY_WINDOW_MS,
  buildTrackingAvailabilitySnapshot,
  filterAvailableTrackingTrucks,
  formatTrackingRelativeUpdate,
  getTrackingAvailabilityMeta,
  isTrackingTruckAvailable,
  renderActiveTruckList
} = require("../frontend/js/admin/admin-tracking.js");
const {
  createLatestResponseGuard
} = require("../frontend/js/admin/admin-state.js");
const {
  dispatchTruckCanStartNewDispatch
} = require("../frontend/js/admin/admin-dispatch.js");

const ROOT = path.resolve(__dirname, "..");
const NOW = Date.parse("2026-08-13T08:00:00.000Z");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function activeTruck(overrides = {}) {
  return {
    session_id: 71,
    truck_id: "TRUCK-07",
    truck_name: "Truck 07",
    session_status: "active",
    latitude: 6.1063,
    longitude: 125.1818,
    accuracy: 12,
    tracking_status_key: "active",
    location_last_updated: new Date(NOW - 30_000).toISOString(),
    ...overrides
  };
}

function testAvailabilityBoundaryAndSignals() {
  assert.equal(TRACKING_GPS_AVAILABILITY_WINDOW_MS, 5 * 60 * 1000);

  const fresh = getTrackingAvailabilityMeta(activeTruck(), NOW);
  assert.equal(fresh.key, "online");
  assert.equal(fresh.label, "GPS Online");
  assert.equal(fresh.available, true);

  const boundary = getTrackingAvailabilityMeta(activeTruck({
    location_last_updated: new Date(NOW - TRACKING_GPS_AVAILABILITY_WINDOW_MS).toISOString()
  }), NOW);
  assert.equal(boundary.available, true);

  const stale = getTrackingAvailabilityMeta(activeTruck({
    location_last_updated: new Date(NOW - TRACKING_GPS_AVAILABILITY_WINDOW_MS - 1).toISOString()
  }), NOW);
  assert.equal(stale.key, "stale");
  assert.equal(stale.label, "GPS Stale");
  assert.equal(stale.available, false);

  const offline = getTrackingAvailabilityMeta(activeTruck({
    tracking_status_key: "gps_off"
  }), NOW);
  assert.equal(offline.key, "offline");
  assert.equal(offline.label, "GPS Offline");
  assert.equal(offline.available, false);

  assert.equal(getTrackingAvailabilityMeta(activeTruck({ last_location_status: "offline" }), NOW).available, false);

  assert.equal(getTrackingAvailabilityMeta(activeTruck({ accuracy: 51 }), NOW).available, false);
  assert.equal(getTrackingAvailabilityMeta(activeTruck({ latitude: null }), NOW).available, false);
  assert.equal(getTrackingAvailabilityMeta(activeTruck({ session_status: "stopped" }), NOW).available, false);
}

function testDispatchEndAndGpsReturnTransition() {
  const truck = activeTruck();
  const liveDispatch = {
    id: 502,
    ticket_number: "DT-2026-0502",
    completed_stops: 1,
    total_stops: 3
  };

  const duringDispatch = buildTrackingAvailabilitySnapshot(
    [truck],
    () => liveDispatch,
    NOW
  );
  assert.deepEqual(duringDispatch.availableTrucks, []);
  assert.equal(duringDispatch.operationalTrucks.length, 1);
  assert.equal(duringDispatch.operationalTrucks[0].dispatch.ticket_number, "DT-2026-0502");

  const afterEndFresh = buildTrackingAvailabilitySnapshot([truck], () => null, NOW);
  assert.equal(afterEndFresh.availableTrucks.length, 1);
  assert.equal(afterEndFresh.availableTrucks[0].dispatch, null);

  const afterEndOffline = buildTrackingAvailabilitySnapshot(
    [activeTruck({ tracking_status_key: "gps_off" })],
    () => null,
    NOW
  );
  assert.deepEqual(afterEndOffline.availableTrucks, []);
  assert.deepEqual(afterEndOffline.operationalTrucks, []);

  const afterGpsReturn = buildTrackingAvailabilitySnapshot(
    [activeTruck({ tracking_status_key: "active", location_last_updated: new Date(NOW).toISOString() })],
    () => null,
    NOW
  );
  assert.equal(afterGpsReturn.availableTrucks.length, 1);
  assert.equal(afterGpsReturn.availableTrucks[0].dispatch, null);
}

function testActiveDispatchSurvivesGpsOutage() {
  const activeDispatch = { dispatch_ticket_id: 502, ticket_number: "DT-2026-0502" };
  const staleSnapshot = buildTrackingAvailabilitySnapshot(
    [activeTruck({
      location_last_updated: new Date(NOW - TRACKING_GPS_AVAILABILITY_WINDOW_MS - 1).toISOString()
    })],
    () => activeDispatch,
    NOW
  );
  const offlineSnapshot = buildTrackingAvailabilitySnapshot(
    [activeTruck({ tracking_status_key: "gps_off" })],
    () => activeDispatch,
    NOW
  );
  const resumedSnapshot = buildTrackingAvailabilitySnapshot(
    [activeTruck({
      tracking_status_key: "active",
      location_last_updated: new Date(NOW).toISOString()
    })],
    () => activeDispatch,
    NOW
  );

  assert.deepEqual(staleSnapshot.availableTrucks, []);
  assert.deepEqual(offlineSnapshot.availableTrucks, []);
  assert.equal(staleSnapshot.operationalTrucks.length, 1);
  assert.equal(offlineSnapshot.operationalTrucks.length, 1);
  assert.equal(staleSnapshot.operationalTrucks[0].dispatch, activeDispatch);
  assert.equal(offlineSnapshot.operationalTrucks[0].dispatch, activeDispatch);
  assert.deepEqual(resumedSnapshot.availableTrucks, []);
  assert.equal(resumedSnapshot.operationalTrucks.length, 1);
  assert.equal(resumedSnapshot.operationalTrucks[0].dispatch, activeDispatch);
  assert.equal(staleSnapshot.sessions[0].dispatch, activeDispatch);
  assert.equal(offlineSnapshot.sessions[0].dispatch, activeDispatch);
  assert.equal(getTrackingAvailabilityMeta(staleSnapshot.sessions[0], NOW).label, "GPS Stale");
  assert.equal(getTrackingAvailabilityMeta(offlineSnapshot.sessions[0], NOW).label, "GPS Offline");
}

function testStaleTruckWithoutDispatchIsNotOperationalOrAvailable() {
  const snapshot = buildTrackingAvailabilitySnapshot(
    [activeTruck({
      location_last_updated: new Date(NOW - TRACKING_GPS_AVAILABILITY_WINDOW_MS - 1).toISOString()
    })],
    () => null,
    NOW
  );

  assert.deepEqual(snapshot.availableTrucks, []);
  assert.deepEqual(snapshot.operationalTrucks, []);
  assert.equal(getTrackingAvailabilityMeta(snapshot.sessions[0], NOW).label, "GPS Stale");
}

function testNewDispatchWorkflowEligibilityGuard() {
  const activeDispatch = { dispatch_ticket_id: 502, ticket_number: "DT-2026-0502" };
  const freshWithoutDispatch = activeTruck({ dispatch: null });
  const freshWithDispatch = activeTruck({ dispatch: activeDispatch });

  assert.equal(
    dispatchTruckCanStartNewDispatch(freshWithoutDispatch, [freshWithoutDispatch]),
    true
  );
  assert.equal(
    dispatchTruckCanStartNewDispatch(freshWithDispatch, [freshWithDispatch]),
    false
  );
  assert.equal(isTrackingTruckAvailable(freshWithDispatch, NOW), false);
  assert.equal(dispatchTruckCanStartNewDispatch(freshWithoutDispatch, []), false);

  const dispatch = read("frontend/js/admin/admin-dispatch.js");
  const eligibilityBlock = dispatch.slice(
    dispatch.indexOf("function dispatchTruckCanStartNewDispatch"),
    dispatch.indexOf("function dispatchNewTicketBlockMessage")
  );
  const contextBlock = dispatch.slice(
    dispatch.indexOf("function updateDispatchSelectedTruckContext"),
    dispatch.indexOf("function prepareDispatchPlannerForTruck")
  );
  const prepareBlock = dispatch.slice(
    dispatch.indexOf("function prepareDispatchPlannerForTruck"),
    dispatch.indexOf("function handleDispatchSelectedSessionEnded")
  );
  const plannerActionsBlock = dispatch.slice(
    dispatch.indexOf("function updateDispatchPlannerActions"),
    dispatch.indexOf("function requireDispatchTicketNumberForDestinations")
  );
  const saveBlock = dispatch.slice(
    dispatch.indexOf("async function saveDispatchDraft"),
    dispatch.indexOf("function submitDispatchTicketForm")
  );
  const dispatchNowBlock = dispatch.slice(
    dispatch.indexOf("async function dispatchSelectedTruckNow"),
    dispatch.indexOf("function dispatchTicketQuery")
  );
  const setupBlock = dispatch.slice(
    dispatch.indexOf("function setupDispatchModule"),
    dispatch.indexOf('if (typeof window !== "undefined")')
  );

  assert.match(eligibilityBlock, /!truck\.dispatch/);
  assert.match(eligibilityBlock, /availableTrucks[\s\S]*session_id/);
  assert.match(contextBlock, /dispatchTruckCanStartNewDispatch\(truck, activeTrackingTrucks\)/);
  assert.match(prepareBlock, /if \(truck\.dispatch\)[\s\S]*setDispatchPlannerMode\("live"\)[\s\S]*return/);
  assert.match(plannerActionsBlock, /dispatchPlannerFinalizationState\([\s\S]*sessionEligible: dispatchSelectedSessionActive/);
  assert.match(saveBlock, /requireDispatchNewTicketEligibility/);
  assert.match(dispatchNowBlock, /if \(!requireDispatchNewTicketEligibility\(\)\) return/);
  assert.match(setupBlock, /dispatchStepContinueBtn[\s\S]*requireDispatchNewTicketEligibility/);
  assert.match(setupBlock, /dispatchNowBtn[\s\S]*dispatchSelectedTruckNow/);
}

function testFilteringAndRelativeUpdateLabel() {
  const visible = filterAvailableTrackingTrucks([
    activeTruck({ session_id: 1 }),
    activeTruck({ session_id: 2, tracking_status_key: "gps_off" }),
    activeTruck({
      session_id: 3,
      location_last_updated: new Date(NOW - TRACKING_GPS_AVAILABILITY_WINDOW_MS - 1).toISOString()
    })
  ], NOW);

  assert.deepEqual(visible.map((truck) => truck.session_id), [1]);
  assert.equal(formatTrackingRelativeUpdate(new Date(NOW - 12_000).toISOString(), NOW), "12 sec ago");
}

function testActiveEndpointKeepsManilaTimestampCurrent() {
  const responseTime = Date.parse("2026-08-18T16:41:21.000Z");
  const manilaTimestamp = "2026-08-19T00:41:12+08:00";
  const incorrectlyMarkedUtc = "2026-08-19T00:41:12.000Z";

  const current = getTrackingAvailabilityMeta(activeTruck({
    location_last_updated: manilaTimestamp
  }), responseTime);
  const future = getTrackingAvailabilityMeta(activeTruck({
    location_last_updated: incorrectlyMarkedUtc
  }), responseTime);

  assert.equal(
    new Date(manilaTimestamp).toISOString(),
    "2026-08-18T16:41:12.000Z"
  );
  assert.notEqual(
    new Date(incorrectlyMarkedUtc).toISOString(),
    "2026-08-18T16:41:12.000Z"
  );
  assert.equal(current.available, true);
  assert.equal(current.ageMs, 9_000);
  assert.equal(future.available, false);
  assert.ok(future.ageMs < -60_000);

  const trackingService = read("services/trackingService.js");
  const activeQuery = trackingService.slice(
    trackingService.indexOf("async getActiveTrucks()"),
    trackingService.indexOf("async getRouteHistoryBySession")
  );
  assert.match(
    activeQuery,
    /DATE_FORMAT\(tll\.last_updated_at, '%Y-%m-%dT%H:%i:%s'\)[\s\S]*?'\+08:00'[\s\S]*?AS location_last_updated/
  );
}

function testEmptyStateRendering() {
  const container = { innerHTML: "" };
  const originalDocument = global.document;
  global.document = {
    getElementById(id) {
      return id === "activeTruckList" ? container : null;
    }
  };
  try {
    renderActiveTruckList([]);
  } finally {
    global.document = originalDocument;
  }
  assert.match(container.innerHTML, /No available trucks or active dispatches/);
  assert.match(container.innerHTML, /Fresh trucks and ongoing dispatches will appear here\./);
}

function testFrontendTransitionWiringAndSingleActions() {
  const tracking = read("frontend/js/admin/admin-tracking.js");
  const dispatch = read("frontend/js/admin/admin-dispatch.js");
  const html = read("frontend/admin-dashboard.html");
  const loadLinkedBlock = dispatch.slice(
    dispatch.indexOf("async function loadDispatchForTrackingSession"),
    dispatch.indexOf("function dispatchMarkerIcon")
  );
  const endBlock = dispatch.slice(
    dispatch.indexOf("async function submitDispatchEnd"),
    dispatch.indexOf("async function performDispatchAction")
  );
  const activeCardBlock = tracking.slice(
    tracking.indexOf("function renderActiveTruckList"),
    tracking.indexOf("function updateTruckMarkers")
  );
  const staleWarningBlock = dispatch.slice(
    dispatch.indexOf("const staleWarning ="),
    dispatch.indexOf("panel.innerHTML", dispatch.indexOf("const staleWarning ="))
  );
  const performActionBlock = dispatch.slice(
    dispatch.indexOf("async function performDispatchAction"),
    dispatch.indexOf("function dispatchTicketPayload")
  );
  const dismissActionBlock = performActionBlock.slice(
    performActionBlock.indexOf('if (action === "dismiss-stale")'),
    performActionBlock.indexOf('if (action === "end")')
  );
  const loadActiveBlock = tracking.slice(
    tracking.indexOf("async function loadActiveTrucks"),
    tracking.indexOf("function getTrackingInlineIcon")
  );
  const plannedRouteBlock = dispatch.slice(
    dispatch.indexOf("function renderDispatchPlannedRoute"),
    dispatch.indexOf("function dispatchEventLabel")
  );
  const openTicketBlock = dispatch.slice(
    dispatch.indexOf("async function openDispatchTicket"),
    dispatch.indexOf("function dispatchReportEndedAt")
  );

  assert.match(tracking, /const trucks = snapshot\.availableTrucks/);
  assert.match(tracking, /trackingOperationalTrucks = snapshot\.operationalTrucks/);
  assert.match(tracking, /renderActiveTruckList\(trackingOperationalTrucks\)/);
  assert.match(tracking, /setInterval\(\(\) => \{[\s\S]*?loadActiveTrucks\(\);[\s\S]*?\}, 5000\)/);
  assert.match(loadLinkedBlock, /selectedDispatchTicket = null/);
  assert.match(loadLinkedBlock, /clearDispatchPlannedRoute\("live dispatch no longer active"\)/);
  assert.doesNotMatch(loadLinkedBlock, /currentTicketMatchesTruck/);
  assert.match(endBlock, /delete dispatchLiveBySession/);
  assert.match(endBlock, /invalidateDispatchLiveRequests\(\)/);
  assert.match(endBlock, /invalidateTrackingActiveRequests\(\)/);
  assert.match(endBlock, /await loadDispatchLiveData\(\)/);
  assert.match(endBlock, /await loadActiveTrucks\(\)/);
  assert.doesNotMatch(endBlock, /stopTracking|force-stop|Stop Truck/);
  assert.match(activeCardBlock, /truck-status-label[^\n]*\$\{statusMeta\.className\}[\s\S]*\$\{escapeHtml\(statusMeta\.label\)\}/);
  assert.match(activeCardBlock, /Active Dispatch/);
  assert.match(activeCardBlock, /Last-known progress/);
  assert.doesNotMatch(activeCardBlock, /GPS off|GPS live/i);
  assert.match(staleWarningBlock, /dismiss-stale/);
  assert.doesNotMatch(staleWarningBlock, /data-dispatch-action="end"|keep-active/);
  assert.match(dismissActionBlock, /dispatchDismissedStaleTicketIds\.add/);
  assert.doesNotMatch(dismissActionBlock, /dispatchRequest|fetch|POST|PUT|PATCH|DELETE/);
  assert.match(
    loadActiveBlock,
    /dispatchTruckCanStartNewDispatch\(selectedTruck, activeTrackingTrucks\)/
  );
  assert.doesNotMatch(
    loadActiveBlock,
    /!isTrackingTruckAvailable\(selectedTruck\)[\s\S]*resetTrackingView/
  );
  assert.match(
    loadActiveBlock,
    /const selectedLiveDispatch =[\s\S]*if \(!selectedTruck\) \{[\s\S]*if \(selectedLiveDispatch\) \{[\s\S]*return;[\s\S]*resetTrackingView/
  );
  assert.match(loadActiveBlock, /hydrateSelectedTruckWorkspace\(selectedSessionId, \{ keepView: true \}\)/);
  assert.doesNotMatch(loadActiveBlock, /selectedRoutePolyline\s*=\s*null|clearDispatchPlannedRoute/);
  assert.match(plannedRouteBlock, /const startPoint = wmo/);
  assert.match(plannedRouteBlock, /dispatchSavedStopRouteItems\(details\.stops\)[\s\S]*renderDispatchSelectionFallback/);
  assert.doesNotMatch(plannedRouteBlock, /resolveDispatchRouteOrigin|requestDispatchRoadCostMatrix/);
  assert.doesNotMatch(plannedRouteBlock.slice(0, plannedRouteBlock.indexOf("const reroute")), /clearDispatchPlannedRoute/);
  assert.match(openTicketBlock, /dispatchTicketIsLive\(details\.ticket\)/);
  assert.match(openTicketBlock, /buildDispatchTrackingContext\(details\)/);
  assert.match(openTicketBlock, /loadTruckRoute\(trackingContext\.session_id, \{ keepView: true \}\)/);
  assert.match(openTicketBlock, /setDispatchWorkspaceTab\("plan"\)/);
  assert.match(dispatch, /Last known location/);
  assert.match(dispatch, /Last GPS update/);
  assert.match(dispatch, /Completed[\s\S]*of[\s\S]*stops/);
  assert.equal((html.match(/id="dispatchOpenTicketsBtn"/g) || []).length, 1);

  const activeResponseCheckIndex = loadActiveBlock.indexOf(
    "trackingActiveRequestGuard.isCurrent(request)"
  );
  const activeStateWriteIndex = loadActiveBlock.indexOf("activeTrackingTrucks = trucks");
  assert.ok(activeResponseCheckIndex >= 0 && activeResponseCheckIndex < activeStateWriteIndex);

  const liveLoadBlock = dispatch.slice(
    dispatch.indexOf("async function loadDispatchLiveData"),
    dispatch.indexOf("function getDispatchLiveForSession")
  );
  const liveResponseCheckIndex = liveLoadBlock.indexOf(
    "dispatchLiveRequestGuard.isCurrent(request)"
  );
  const liveStateWriteIndex = liveLoadBlock.indexOf("dispatchLiveBySession =");
  assert.ok(liveResponseCheckIndex >= 0 && liveResponseCheckIndex < liveStateWriteIndex);

  [
    "dispatchViewActiveRouteBtn",
    "dispatchViewTicketDetailsBtn",
    "dispatchUpdateStopStatusBtn",
    "dispatchEndActiveBtn"
  ].forEach((id) => {
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, "g")) || []).length, 1, `${id} must be unique`);
  });
}

function testLatestResponseGuardsRejectOlderPollingResults() {
  const activeGuard = createLatestResponseGuard();
  const activeA = activeGuard.begin();
  const activeB = activeGuard.begin();
  let activeSnapshot = "initial";
  if (activeGuard.isCurrent(activeB)) activeSnapshot = "fresh";
  if (activeGuard.isCurrent(activeA)) activeSnapshot = "stale";
  assert.equal(activeA.signal.aborted, true);
  assert.equal(activeSnapshot, "fresh");

  const liveGuard = createLatestResponseGuard();
  const liveBeforeEnd = liveGuard.begin();
  liveGuard.invalidate();
  let selectedTicket = null;
  if (liveGuard.isCurrent(liveBeforeEnd)) selectedTicket = "closed-ticket";
  assert.equal(liveBeforeEnd.signal.aborted, true);
  assert.equal(selectedTicket, null);
}

function run() {
  testAvailabilityBoundaryAndSignals();
  testDispatchEndAndGpsReturnTransition();
  testActiveDispatchSurvivesGpsOutage();
  testStaleTruckWithoutDispatchIsNotOperationalOrAvailable();
  testNewDispatchWorkflowEligibilityGuard();
  testFilteringAndRelativeUpdateLabel();
  testActiveEndpointKeepsManilaTimestampCurrent();
  testEmptyStateRendering();
  testFrontendTransitionWiringAndSingleActions();
  testLatestResponseGuardsRejectOlderPollingResults();
  console.log("trackingActiveAvailability.test.js: all assertions passed");
}

run();
