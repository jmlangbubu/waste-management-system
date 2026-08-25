const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  dispatchDefaultRouteName,
  dispatchPlannerFinalizationState,
  dispatchResolveSelectedNewTicketTruck,
  dispatchSelectedTruckIdentity,
  dispatchSessionKey,
  dispatchTruckCanStartNewDispatch,
  resolveDispatchRouteOrigin
} = require("../frontend/js/admin/admin-dispatch.js");
const {
  buildTrackingAvailabilitySnapshot,
  formatTrackingTimeSafe,
  getTrackingAvailabilityMeta,
  parseTrackingDate
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
const NOW = Date.parse("2026-08-25T19:57:30+08:00");

function functionBlock(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  return source.slice(startIndex, endIndex);
}

function freshTruck(overrides = {}) {
  return {
    session_id: 27,
    truck_id: "TRUCK-9",
    enforcer_id: 14,
    enforcer_name: "WMO Personnel",
    session_status: "active",
    latitude: 6.1061,
    longitude: 125.1816,
    accuracy: 12,
    location_last_updated: "2026-08-25T19:57:12+08:00",
    last_location_status: "active",
    ...overrides
  };
}

function snapshot(truck, dispatch = null) {
  return buildTrackingAvailabilitySnapshot(
    [truck],
    () => dispatch,
    NOW
  );
}

function testAValidSessionAndRouteCanFinalize() {
  const current = snapshot(freshTruck());
  const selected = dispatchResolveSelectedNewTicketTruck(
    "27",
    current.availableTrucks
  );
  const identity = dispatchSelectedTruckIdentity(selected);

  assert.equal(selected, current.availableTrucks[0]);
  assert.deepEqual(identity, {
    tracking_session_id: "27",
    truck_id: "TRUCK-9",
    truck_name_snapshot: "Truck TRUCK-9",
    assigned_personnel_id: "14",
    assigned_personnel_name: "WMO Personnel"
  });
  assert.equal(dispatchPlannerFinalizationState({
    hasTruck: Boolean(selected),
    sessionEligible: Boolean(selected),
    routeReady: true,
    processing: false
  }).canFinalize, true);
}

function testBPlanningDoesNotClearSelectedSession() {
  const prepare = functionBlock(
    dispatchSource,
    "function prepareDispatchPlannerForTruck",
    "function handleDispatchSelectedSessionEnded"
  );
  const routeCalculation = functionBlock(
    dispatchSource,
    "async function renderDispatchDraftOnLiveMap",
    "function renderDispatchPlanningMap"
  );

  assert.doesNotMatch(prepare, /selectedSessionId\s*=\s*(?:null|undefined|"")/);
  assert.doesNotMatch(routeCalculation, /selectedSessionId\s*=|selectedTrackingTruck\s*=/);
  assert.match(prepare, /updateDispatchSelectedTruckContext\(truck\)/);
}

function testCPollReplacementResolvesCurrentObjectBySessionId() {
  const staleObject = freshTruck({ truck_name: "Old object" });
  const refreshedObject = freshTruck({ truck_name: "Current object", accuracy: 8 });
  const current = snapshot(refreshedObject);
  const resolved = dispatchResolveSelectedNewTicketTruck(
    staleObject.session_id,
    current.availableTrucks
  );

  assert.notEqual(resolved, staleObject);
  assert.equal(resolved, current.availableTrucks[0]);
  assert.equal(resolved.truck_name, "Current object");
}

function testDStringAndNumberSessionIdsMatchSafely() {
  const truck = freshTruck({ session_id: 27 });
  assert.equal(dispatchSessionKey(" 27 "), "27");
  assert.equal(
    dispatchResolveSelectedNewTicketTruck("27", [truck]),
    truck
  );
  assert.equal(dispatchTruckCanStartNewDispatch({ ...truck, session_id: "27" }, [truck]), true);
}

function testEGenuinelyStaleTruckIsBlockedWithoutLosingItsIdentity() {
  const staleTruck = freshTruck({
    location_last_updated: "2026-08-25T19:51:00+08:00"
  });
  const current = snapshot(staleTruck);

  assert.equal(getTrackingAvailabilityMeta(staleTruck, NOW).label, "GPS Stale");
  assert.deepEqual(current.availableTrucks, []);
  assert.equal(dispatchResolveSelectedNewTicketTruck(27, current.availableTrucks), null);
  assert.equal(dispatchPlannerFinalizationState({
    hasTruck: true,
    sessionEligible: false,
    routeReady: true,
    processing: false
  }).canFinalize, false);
}

function testFFreshGpsRecoveryRestoresSameSessionEligibility() {
  const stale = snapshot(freshTruck({
    location_last_updated: "2026-08-25T19:51:00+08:00"
  }));
  const recovered = snapshot(freshTruck({
    location_last_updated: "2026-08-25T19:57:20+08:00"
  }));

  assert.equal(dispatchResolveSelectedNewTicketTruck("27", stale.availableTrucks), null);
  assert.equal(
    dispatchResolveSelectedNewTicketTruck("27", recovered.availableTrucks)?.session_id,
    27
  );
}

function testGActiveDispatchCannotReceiveSecondTicket() {
  const activeDispatch = { id: 91, ticket_number: "DPT-2026-0091" };
  const current = snapshot(freshTruck(), activeDispatch);

  assert.deepEqual(current.availableTrucks, []);
  assert.equal(current.operationalTrucks.length, 1);
  assert.equal(current.operationalTrucks[0].dispatch, activeDispatch);
  assert.equal(
    dispatchTruckCanStartNewDispatch(current.operationalTrucks[0], current.availableTrucks),
    false
  );
}

function testHSaveUsesCurrentSessionIdentityAndIndependentRouteName() {
  const truck = freshTruck();
  const identity = dispatchSelectedTruckIdentity(truck);
  const routeName = dispatchDefaultRouteName(
    truck,
    new Date("2026-08-25T12:00:00Z")
  );
  const collect = functionBlock(
    dispatchSource,
    "function collectDispatchTicketForm",
    "function resetDispatchTicketForm"
  );
  const save = functionBlock(
    dispatchSource,
    "async function saveDispatchDraft",
    "function submitDispatchTicketForm"
  );

  assert.ok(identity.tracking_session_id);
  assert.ok(identity.truck_id);
  assert.ok(identity.truck_name_snapshot);
  assert.match(routeName, /^Truck TRUCK-9 - 2026-08-25$/);
  assert.match(collect, /dispatchResolveSelectedNewTicketTruck\(\)/);
  assert.match(collect, /dispatchDefaultRouteName\(selectedTrackingTruck\)/);
  assert.doesNotMatch(
    save,
    /!payload\.truck_name_snapshot\s*\|\|\s*!payload\.route_name/
  );
  assert.match(save, /if \(!payload\.route_name\)/);
}

function testIManilaTimestampIsNotTreatedAsEightHoursFuture() {
  const timestamp = "2026-08-25T19:57:12+08:00";
  const timezoneLessTimestamp = "2026-08-25 19:57:12";
  const meta = getTrackingAvailabilityMeta(freshTruck({
    location_last_updated: timezoneLessTimestamp
  }), NOW);

  assert.equal(new Date(timestamp).toISOString(), "2026-08-25T11:57:12.000Z");
  assert.equal(parseTrackingDate(timezoneLessTimestamp).toISOString(), "2026-08-25T11:57:12.000Z");
  assert.equal(meta.available, true);
  assert.equal(meta.ageMs, 18_000);
  assert.equal(resolveDispatchRouteOrigin({
    lat: 6.12,
    lng: 125.2,
    recorded_at: timezoneLessTimestamp
  }, { now: NOW }).source, "truck");
}

function testJDisplayFormattingDoesNotMutateEligibilityTimestamp() {
  const truck = freshTruck();
  const rawTimestamp = truck.location_last_updated;
  const before = getTrackingAvailabilityMeta(truck, NOW);
  const display = formatTrackingTimeSafe(rawTimestamp);
  const after = getTrackingAvailabilityMeta(truck, NOW);

  assert.ok(display && display !== "--");
  assert.match(display, /7:57:12\s*PM/i);
  assert.equal(truck.location_last_updated, rawTimestamp);
  assert.deepEqual(after, before);
}

function testPollingKeepsSelectedSessionAndUsesSnapshotAuthority() {
  const loadActive = functionBlock(
    trackingSource,
    "async function loadActiveTrucks",
    "function renderActiveTruckList"
  );

  assert.match(loadActive, /selectedTrackingTruck = selectedTruck/);
  assert.match(
    loadActive,
    /dispatchTruckCanStartNewDispatch\(selectedTruck, activeTrackingTrucks\)/
  );
  assert.match(loadActive, /hydrateSelectedTruckWorkspace\(selectedSessionId, \{ keepView: true \}\)/);
  assert.doesNotMatch(
    loadActive,
    /!isTrackingTruckAvailable\(selectedTruck\)[\s\S]*resetTrackingView/
  );
}

function run() {
  testAValidSessionAndRouteCanFinalize();
  testBPlanningDoesNotClearSelectedSession();
  testCPollReplacementResolvesCurrentObjectBySessionId();
  testDStringAndNumberSessionIdsMatchSafely();
  testEGenuinelyStaleTruckIsBlockedWithoutLosingItsIdentity();
  testFFreshGpsRecoveryRestoresSameSessionEligibility();
  testGActiveDispatchCannotReceiveSecondTicket();
  testHSaveUsesCurrentSessionIdentityAndIndependentRouteName();
  testIManilaTimestampIsNotTreatedAsEightHoursFuture();
  testJDisplayFormattingDoesNotMutateEligibilityTimestamp();
  testPollingKeepsSelectedSessionAndUsesSnapshotAuthority();
  console.log("dispatchSelectedSessionEligibility.test.js: all assertions passed");
}

run();
