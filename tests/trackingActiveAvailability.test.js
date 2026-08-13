const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  TRACKING_GPS_AVAILABILITY_WINDOW_MS,
  buildTrackingAvailabilitySnapshot,
  filterAvailableTrackingTrucks,
  formatTrackingRelativeUpdate,
  getTrackingAvailabilityMeta,
  renderActiveTruckList
} = require("../frontend/js/admin/admin-tracking.js");

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
  assert.equal(duringDispatch.availableTrucks.length, 1);
  assert.equal(duringDispatch.availableTrucks[0].dispatch.ticket_number, "DT-2026-0502");

  const afterEndFresh = buildTrackingAvailabilitySnapshot([truck], () => null, NOW);
  assert.equal(afterEndFresh.availableTrucks.length, 1);
  assert.equal(afterEndFresh.availableTrucks[0].dispatch, null);

  const afterEndOffline = buildTrackingAvailabilitySnapshot(
    [activeTruck({ tracking_status_key: "gps_off" })],
    () => null,
    NOW
  );
  assert.deepEqual(afterEndOffline.availableTrucks, []);

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

  assert.deepEqual(staleSnapshot.availableTrucks, []);
  assert.deepEqual(offlineSnapshot.availableTrucks, []);
  assert.equal(staleSnapshot.sessions[0].dispatch, activeDispatch);
  assert.equal(offlineSnapshot.sessions[0].dispatch, activeDispatch);
  assert.equal(getTrackingAvailabilityMeta(staleSnapshot.sessions[0], NOW).label, "GPS Stale");
  assert.equal(getTrackingAvailabilityMeta(offlineSnapshot.sessions[0], NOW).label, "GPS Offline");
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
  assert.match(container.innerHTML, /No active trucks/);
  assert.match(container.innerHTML, /Trucks will appear here when GPS tracking is active\./);
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
  assert.match(tracking, /setInterval\(\(\) => \{[\s\S]*?loadActiveTrucks\(\);[\s\S]*?\}, 5000\)/);
  assert.match(loadLinkedBlock, /selectedDispatchTicket = null/);
  assert.match(loadLinkedBlock, /clearDispatchPlannedRoute\("live dispatch no longer active"\)/);
  assert.doesNotMatch(loadLinkedBlock, /currentTicketMatchesTruck/);
  assert.match(endBlock, /delete dispatchLiveBySession/);
  assert.match(endBlock, /await loadDispatchLiveData\(\)/);
  assert.match(endBlock, /await loadActiveTrucks\(\)/);
  assert.doesNotMatch(endBlock, /stopTracking|force-stop|Stop Truck/);
  assert.match(activeCardBlock, /truck-status-label[^\n]*\$\{statusMeta\.className\}[\s\S]*\$\{escapeHtml\(statusMeta\.label\)\}/);
  assert.doesNotMatch(activeCardBlock, /GPS off|GPS live/i);
  assert.match(staleWarningBlock, /dismiss-stale/);
  assert.doesNotMatch(staleWarningBlock, /data-dispatch-action="end"|keep-active/);
  assert.match(dismissActionBlock, /dispatchDismissedStaleTicketIds\.add/);
  assert.doesNotMatch(dismissActionBlock, /dispatchRequest|fetch|POST|PUT|PATCH|DELETE/);
  assert.match(loadActiveBlock, /!isTrackingTruckAvailable\(selectedTruck\) && !selectedTruck\.dispatch/);
  assert.match(loadActiveBlock, /hydrateSelectedTruckWorkspace\(selectedSessionId, \{ keepView: true \}\)/);
  assert.doesNotMatch(loadActiveBlock, /selectedRoutePolyline\s*=\s*null|clearDispatchPlannedRoute/);
  assert.match(plannedRouteBlock, /\["missing", "stale"\]\.includes\(routeOrigin\.source\)/);
  assert.match(plannedRouteBlock, /dispatchHasVisiblePlannedRoute\(\)[\s\S]*updateDispatchRoutePreviewNotice\("ready"\)[\s\S]*return/);
  assert.doesNotMatch(plannedRouteBlock.slice(0, plannedRouteBlock.indexOf("const reroute")), /clearDispatchPlannedRoute/);
  assert.match(openTicketBlock, /dispatchTicketIsLive\(details\.ticket\)/);
  assert.match(openTicketBlock, /buildDispatchTrackingContext\(details\)/);
  assert.match(openTicketBlock, /loadTruckRoute\(trackingContext\.session_id, \{ keepView: true \}\)/);
  assert.match(openTicketBlock, /setDispatchWorkspaceTab\("plan"\)/);
  assert.equal((html.match(/id="dispatchOpenTicketsBtn"/g) || []).length, 1);

  [
    "dispatchViewActiveRouteBtn",
    "dispatchViewTicketDetailsBtn",
    "dispatchUpdateStopStatusBtn",
    "dispatchEndActiveBtn"
  ].forEach((id) => {
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, "g")) || []).length, 1, `${id} must be unique`);
  });
}

function run() {
  testAvailabilityBoundaryAndSignals();
  testDispatchEndAndGpsReturnTransition();
  testActiveDispatchSurvivesGpsOutage();
  testFilteringAndRelativeUpdateLabel();
  testEmptyStateRendering();
  testFrontendTransitionWiringAndSingleActions();
  console.log("trackingActiveAvailability.test.js: all assertions passed");
}

run();
