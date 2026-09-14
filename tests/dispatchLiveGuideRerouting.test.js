const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DISPATCH_LIVE_GUIDE_MIN_REQUEST_INTERVAL_MS,
  DISPATCH_ROUTING_MOVEMENT_METERS,
  DISPATCH_ROUTING_OFF_ROUTE_HOLD_MS,
  DISPATCH_ROUTING_OFF_ROUTE_METERS,
  DISPATCH_WMO_LOCATION,
  evaluateDispatchLiveGuideReroute,
  resolveDispatchLiveGuideTarget
} = require("../frontend/js/admin/admin-dispatch");

const source = fs.readFileSync(
  path.join(__dirname, "../frontend/js/admin/admin-dispatch.js"),
  "utf8"
);
const trackingSource = fs.readFileSync(
  path.join(__dirname, "../frontend/js/admin/admin-tracking.js"),
  "utf8"
);
const dashboardSource = fs.readFileSync(
  path.join(__dirname, "../frontend/admin-dashboard.html"),
  "utf8"
);

function point(lat, lng) {
  return { lat, lng };
}

function liveGuideSource() {
  const start = source.indexOf("function renderDispatchLiveGuide");
  const end = source.indexOf("function renderDispatchPersistedActiveRoute", start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

function testTargetProgressionAndWmoReturn() {
  const details = {
    ticket: { id: 91, status: "in_progress" },
    stops: [
      { id: 1, stop_order: 1, stop_status: "completed", latitude: 6.11, longitude: 125.16 },
      { id: 2, stop_order: 2, stop_status: "on_the_way", latitude: 6.12, longitude: 125.17 },
      { id: 3, stop_order: 3, stop_status: "pending", latitude: 6.13, longitude: 125.18 }
    ]
  };
  const next = resolveDispatchLiveGuideTarget(details, { sessionId: 58 });
  assert.equal(next.stop.id, 2);
  assert.match(next.signature, /ticket:91:session:58:stop:2/);

  const finalReturn = resolveDispatchLiveGuideTarget({
    ...details,
    ticket: { id: 91, status: "returning_to_wmo" },
    stops: details.stops.map((stop) => ({ ...stop, stop_status: "completed" }))
  }, { sessionId: 58 });
  assert.equal(finalReturn.stop, null);
  assert.deepEqual(finalReturn.point, {
    lat: DISPATCH_WMO_LOCATION.latitude,
    lng: DISPATCH_WMO_LOCATION.longitude
  });
  assert.match(finalReturn.signature, /wmo:return/);
}

function testDeviationAndNoiseDecisions() {
  const targetSignature = "ticket:91:session:58:stop:2";
  const guide = [point(6.1, 125.1), point(6.1, 125.12)];
  const offRouteTruck = point(6.101, 125.11);
  const now = 100000;

  const pending = evaluateDispatchLiveGuideReroute(offRouteTruck, targetSignature, {
    now,
    lastTargetSignature: targetSignature,
    lastStart: offRouteTruck,
    routeCoordinates: guide,
    offRouteSince: null,
    lastRequestAt: 0
  });
  assert.equal(pending.shouldReroute, false);
  assert.equal(pending.reason, "off_route_pending");
  assert.ok(pending.offRouteSince);

  const sustained = evaluateDispatchLiveGuideReroute(offRouteTruck, targetSignature, {
    now: now + DISPATCH_ROUTING_OFF_ROUTE_HOLD_MS + 1,
    lastTargetSignature: targetSignature,
    lastStart: offRouteTruck,
    routeCoordinates: guide,
    offRouteSince: pending.offRouteSince,
    lastRequestAt: 0
  });
  assert.equal(sustained.shouldReroute, true);
  assert.equal(sustained.reason, "sustained_off_route");

  const smallNoise = point(6.10005, 125.11);
  const stable = evaluateDispatchLiveGuideReroute(smallNoise, targetSignature, {
    now,
    lastTargetSignature: targetSignature,
    lastStart: smallNoise,
    routeCoordinates: guide,
    offRouteSince: null,
    lastRequestAt: 0
  });
  assert.equal(stable.shouldReroute, false);
  assert.equal(stable.reason, "stable");
  assert.equal(DISPATCH_ROUTING_OFF_ROUTE_METERS, 45);
}

function testPollingDoesNotSpamRouting() {
  const targetSignature = "ticket:91:session:58:stop:2";
  const guide = [point(6.1, 125.1), point(6.1, 125.12)];
  const previousOrigin = point(6.1, 125.1);
  const movedTruck = point(6.1006, 125.1);
  const lastRequestAt = 100000;

  const fiveSecondPoll = evaluateDispatchLiveGuideReroute(movedTruck, targetSignature, {
    now: lastRequestAt + 5000,
    lastTargetSignature: targetSignature,
    lastStart: previousOrigin,
    routeCoordinates: guide,
    offRouteSince: null,
    lastRequestAt
  });
  assert.ok(DISPATCH_ROUTING_MOVEMENT_METERS <= 70);
  assert.equal(fiveSecondPoll.shouldReroute, false);
  assert.equal(fiveSecondPoll.reason, "rate_limited");

  const failedGuideFiveSecondPoll = evaluateDispatchLiveGuideReroute(movedTruck, targetSignature, {
    now: lastRequestAt + 5000,
    lastTargetSignature: targetSignature,
    lastStart: previousOrigin,
    routeCoordinates: [],
    offRouteSince: null,
    lastRequestAt
  });
  assert.equal(failedGuideFiveSecondPoll.shouldReroute, false);
  assert.equal(failedGuideFiveSecondPoll.reason, "rate_limited");

  const afterCooldown = evaluateDispatchLiveGuideReroute(movedTruck, targetSignature, {
    now: lastRequestAt + DISPATCH_LIVE_GUIDE_MIN_REQUEST_INTERVAL_MS + 1,
    lastTargetSignature: targetSignature,
    lastStart: previousOrigin,
    routeCoordinates: guide,
    offRouteSince: null,
    lastRequestAt
  });
  assert.equal(afterCooldown.shouldReroute, true);
  assert.equal(afterCooldown.reason, "truck_moved");

  const destinationChanged = evaluateDispatchLiveGuideReroute(movedTruck, "ticket:91:session:58:stop:3", {
    now: lastRequestAt + 5000,
    lastTargetSignature: targetSignature,
    lastStart: previousOrigin,
    routeCoordinates: guide,
    lastRequestAt
  });
  assert.equal(destinationChanged.shouldReroute, true);
  assert.equal(destinationChanged.reason, "destination_changed");
}

function testRouteTruthsStaySeparate() {
  const guideRenderer = liveGuideSource();
  assert.match(guideRenderer, /requestDispatchRoadJourney\(\s*\[startPoint, target\.point\]/);
  assert.match(guideRenderer, /dispatchLiveGuideCoordinates\s*=/);
  assert.doesNotMatch(guideRenderer, /dispatchLastSuccessfulRouteCoordinates\s*=/);
  assert.doesNotMatch(guideRenderer, /selectedRoutePolyline|matchTrackingDisplaySegments|getCachedTrackingMatch/);
  assert.match(source, /Original assigned road route/);
  assert.match(source, /Live guide to/);
  assert.match(trackingSource, /TRACKING_ACTUAL_ROUTE_COLOR/);
  assert.match(trackingSource, /getCachedTrackingMatch/);
  assert.match(dashboardSource, /> Actual trail</);
  assert.match(dashboardSource, /> Assigned route</);
  assert.match(dashboardSource, /> Live guide</);
  assert.match(dashboardSource, /> Current truck</);
  assert.match(dashboardSource, /> Destination</);
  assert.match(dashboardSource, /> WMO</);
}

function run() {
  testTargetProgressionAndWmoReturn();
  testDeviationAndNoiseDecisions();
  testPollingDoesNotSpamRouting();
  testRouteTruthsStaySeparate();
  console.log("Dispatch live-guide rerouting tests passed");
}

run();
