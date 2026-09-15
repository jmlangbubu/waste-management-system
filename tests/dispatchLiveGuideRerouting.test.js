const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DISPATCH_LIVE_GUIDE_MIN_REQUEST_INTERVAL_MS,
  DISPATCH_LIVE_GUIDE_MISSING_RETRY_MS,
  DISPATCH_LIVE_GUIDE_MOVEMENT_METERS,
  DISPATCH_LIVE_GUIDE_OFF_ROUTE_HOLD_MS,
  DISPATCH_LIVE_GUIDE_OFF_ROUTE_METERS,
  DISPATCH_LIVE_GUIDE_MAX_ALTERNATIVES,
  DISPATCH_ALTERNATIVE_ROUTE_PANE,
  DISPATCH_ALTERNATIVE_ROUTE_STYLE,
  DISPATCH_CURRENT_ROUTE_STYLE,
  DISPATCH_WMO_LOCATION,
  dispatchLiveNavigationAccuracyIsReliable,
  evaluateDispatchLiveGuideReroute,
  dispatchStopMarkerClass,
  parseDispatchLiveNavigationPayload,
  replaceDispatchLiveGuideLayer,
  replaceDispatchLiveNavigationLayers,
  renderDispatchLiveGuide,
  requestDispatchLiveNavigationRoutes,
  requestDispatchRoadJourney,
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
const dispatchCssSource = fs.readFileSync(
  path.join(__dirname, "../frontend/css/admin/admin-dispatch.css"),
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
    now: now + DISPATCH_LIVE_GUIDE_OFF_ROUTE_HOLD_MS + 1,
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
  assert.equal(DISPATCH_LIVE_GUIDE_OFF_ROUTE_METERS, 30);
  assert.equal(DISPATCH_LIVE_GUIDE_MOVEMENT_METERS, 25);
  assert.equal(DISPATCH_LIVE_GUIDE_OFF_ROUTE_HOLD_MS, 7000);
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
  assert.equal(DISPATCH_LIVE_GUIDE_MOVEMENT_METERS, 25);
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

  const missingGuideRetry = evaluateDispatchLiveGuideReroute(movedTruck, targetSignature, {
    now: lastRequestAt + DISPATCH_LIVE_GUIDE_MISSING_RETRY_MS + 1,
    lastTargetSignature: targetSignature,
    lastStart: previousOrigin,
    routeCoordinates: [],
    offRouteSince: null,
    lastRequestAt
  });
  assert.equal(missingGuideRetry.shouldReroute, true,
    "a missing guide must recover before the ordinary movement cooldown expires");
  assert.equal(missingGuideRetry.reason, "guide_missing");

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

  const failedDestinationChangeFiveSecondPoll = evaluateDispatchLiveGuideReroute(
    movedTruck,
    "ticket:91:session:58:stop:3",
    {
      now: lastRequestAt + 5000,
      lastTargetSignature: targetSignature,
      lastRequestedTargetSignature: "ticket:91:session:58:stop:3",
      lastStart: previousOrigin,
      routeCoordinates: guide,
      lastRequestAt
    }
  );
  assert.equal(failedDestinationChangeFiveSecondPoll.shouldReroute, false,
    "a failed destination-change request must not repeat on every five-second poll");
  assert.equal(failedDestinationChangeFiveSecondPoll.reason, "rate_limited");

  const failedDestinationChangeRetry = evaluateDispatchLiveGuideReroute(
    movedTruck,
    "ticket:91:session:58:stop:3",
    {
      now: lastRequestAt + DISPATCH_LIVE_GUIDE_MISSING_RETRY_MS + 1,
      lastTargetSignature: targetSignature,
      lastRequestedTargetSignature: "ticket:91:session:58:stop:3",
      lastStart: previousOrigin,
      routeCoordinates: guide,
      lastRequestAt
    }
  );
  assert.equal(failedDestinationChangeRetry.shouldReroute, true);
  assert.equal(failedDestinationChangeRetry.reason, "destination_changed");
}

async function testNavigationOnlyAlternativesRequestAndParsing() {
  const start = point(6.201, 125.201);
  const destination = point(6.211, 125.211);
  const candidates = [0, 1, 2, 3].map((offset) => ({
    distance: 1000 + offset,
    duration: 100 + offset,
    geometry: {
      coordinates: [
        [start.lng, start.lat],
        [125.205 + offset * 0.0001, 6.205 + offset * 0.0001],
        [destination.lng, destination.lat]
      ]
    }
  }));
  const parsed = parseDispatchLiveNavigationPayload({ routes: candidates }, start, destination);
  assert.equal(parsed.routeCount, 4, "all valid provider routes are counted");
  assert.equal(parsed.primary.index, 0, "the first valid OSRM route remains primary");
  assert.equal(parsed.alternatives.length, DISPATCH_LIVE_GUIDE_MAX_ALTERNATIVES);
  assert.deepEqual(parsed.alternatives.map((route) => route.index), [1, 2]);

  let navigationUrl = "";
  const navigationRoutes = await requestDispatchLiveNavigationRoutes(
    start,
    destination,
    new AbortController().signal,
    {
      generation: 21,
      fetchImplementation: async (url) => {
        navigationUrl = url;
        return { ok: true, status: 200, json: async () => ({ routes: candidates }) };
      }
    }
  );
  assert.match(navigationUrl, /alternatives=true&steps=false&overview=full&geometries=geojson/);
  assert.equal(navigationRoutes.primary.coordinates.length, 3);
  assert.equal(navigationRoutes.alternatives.length, 2);
  const cachedNavigationRoutes = await requestDispatchLiveNavigationRoutes(
    start,
    destination,
    new AbortController().signal,
    {
      fetchImplementation: async () => {
        throw new Error("origin/destination cache should prevent a duplicate request");
      }
    }
  );
  assert.deepEqual(cachedNavigationRoutes, navigationRoutes);
  assert.notEqual(cachedNavigationRoutes, navigationRoutes, "cached route sets are returned as safe copies");
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    requestDispatchLiveNavigationRoutes(start, destination, cancelled.signal),
    (error) => error?.name === "AbortError"
  );

  let legacyUrl = "";
  const legacyStart = point(6.221, 125.221);
  const legacyEnd = point(6.231, 125.231);
  const legacyRoute = await requestDispatchRoadJourney(
    [legacyStart, legacyEnd],
    new AbortController().signal,
    {
      fetchImplementation: async (url) => {
        legacyUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            routes: [{ geometry: { coordinates: [
              [legacyStart.lng, legacyStart.lat],
              [legacyEnd.lng, legacyEnd.lat]
            ] } }]
          })
        };
      }
    }
  );
  assert.match(legacyUrl, /alternatives=false&steps=false&overview=full&geometries=geojson/);
  assert.deepEqual(legacyRoute, [
    [legacyStart.lat, legacyStart.lng],
    [legacyEnd.lat, legacyEnd.lng]
  ], "the shared planner/report route helper keeps its coordinate-array contract");

  const oneRouteStart = point(6.241, 125.241);
  const oneRouteEnd = point(6.251, 125.251);
  const oneRoute = await requestDispatchLiveNavigationRoutes(
    oneRouteStart,
    oneRouteEnd,
    new AbortController().signal,
    {
      fetchImplementation: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ routes: [{ geometry: { coordinates: [
          [oneRouteStart.lng, oneRouteStart.lat],
          [oneRouteEnd.lng, oneRouteEnd.lat]
        ] } }] })
      })
    }
  );
  assert.equal(oneRoute.routeCount, 1);
  assert.equal(oneRoute.alternatives.length, 0, "one OSRM route renders normally without alternatives");
}

function testGuideLayerReplacementAndFailurePreservationContracts() {
  const events = [];
  const oldLayer = { id: "old" };
  const oldAlternative = { id: "old-alternative" };
  const group = {
    layers: [oldLayer],
    getLayers() {
      return [...this.layers];
    },
    removeLayer(layer) {
      events.push(`remove:${layer.id}`);
      this.layers = this.layers.filter((candidate) => candidate !== layer);
    }
  };
  const alternativeGroup = {
    layers: [oldAlternative],
    getLayers() {
      return [...this.layers];
    },
    removeLayer(layer) {
      events.push(`remove:${layer.id}`);
      this.layers = this.layers.filter((candidate) => candidate !== layer);
    }
  };
  let layerSequence = 0;
  global.L = {
    polyline(coordinates, options) {
      return {
        id: `new-${++layerSequence}`,
        coordinates,
        options,
        getLatLngs() {
          return this.coordinates;
        },
        bindTooltip(label) {
          this.label = label;
          return this;
        },
        addTo(target) {
          events.push(`add:${this.id}`);
          target.layers.push(this);
          return this;
        }
      };
    }
  };
  const replacement = replaceDispatchLiveGuideLayer(
    group,
    [[6.1, 125.1], [6.2, 125.2]],
    "Pioneer Avenue"
  );
  assert.equal(replacement.options.color, "#f28c18");
  assert.equal(replacement.options.dashArray, undefined);
  assert.deepEqual(events, ["add:new-1", "remove:old"],
    "the valid replacement is attached before the previous guide is removed");
  assert.deepEqual(group.layers, [replacement], "guide replacement cannot accumulate polylines");

  events.length = 0;
  const navigationReplacement = replaceDispatchLiveNavigationLayers(
    group,
    alternativeGroup,
    {
      primary: { coordinates: [[6.1, 125.1], [6.2, 125.2]] },
      alternatives: [
        { coordinates: [[6.1, 125.1], [6.15, 125.18], [6.2, 125.2]] },
        { coordinates: [[6.1, 125.1], [6.16, 125.17], [6.2, 125.2]] }
      ]
    },
    "Pioneer Avenue"
  );
  assert.equal(navigationReplacement.primaryLayer.options.color, "#f28c18");
  assert.equal(navigationReplacement.alternativeLayers.length, 2);
  navigationReplacement.alternativeLayers.forEach((layer) => {
    assert.equal(layer.options.color, "#66b7e8");
    assert.equal(layer.options.pane, DISPATCH_ALTERNATIVE_ROUTE_PANE);
    assert.deepEqual(layer.options, DISPATCH_ALTERNATIVE_ROUTE_STYLE);
  });
  assert.equal(group.layers.length, 1);
  assert.equal(alternativeGroup.layers.length, 2);
  assert.ok(
    events.indexOf("add:new-2") < events.indexOf(`remove:${replacement.id}`),
    "new primary attaches before the previous primary is removed"
  );
  assert.ok(
    events.indexOf("add:new-3") < events.indexOf("remove:old-alternative"),
    "new alternatives attach before previous alternatives are removed"
  );

  replaceDispatchLiveNavigationLayers(
    group,
    alternativeGroup,
    {
      primary: { coordinates: [[6.11, 125.11], [6.21, 125.21]] },
      alternatives: [{ coordinates: [[6.11, 125.11], [6.21, 125.21]] }]
    },
    "Next destination"
  );
  assert.equal(group.layers.length, 1, "primary layers cannot accumulate");
  assert.equal(alternativeGroup.layers.length, 1, "alternative layers cannot accumulate");
  delete global.L;

  const guideRenderer = liveGuideSource();
  const requestIndex = guideRenderer.indexOf("await routeRequest");
  assert.ok(requestIndex > 0);
  assert.doesNotMatch(guideRenderer.slice(0, requestIndex), /clearLayers/,
    "pending reroutes must retain the current guide");
  assert.match(guideRenderer, /replaceDispatchLiveNavigationLayers/);
  const catchBlock = guideRenderer.slice(guideRenderer.indexOf("} catch (error)"));
  assert.match(catchBlock, /target\.signature !== dispatchLiveGuideTargetSignature[\s\S]*clearLayers/,
    "only a guide for a previous destination may be cleared after a failed target change");
}

function testMarkerStatusVisualSemantics() {
  assert.equal(dispatchStopMarkerClass({ id: 1, stop_status: "pending" }, 2), "");
  assert.equal(dispatchStopMarkerClass({ id: 2, stop_status: "on_the_way" }, 2), "current");
  assert.equal(dispatchStopMarkerClass({ id: 2, stop_status: "arrived" }, 2), "arrived");
  assert.equal(dispatchStopMarkerClass({ id: 1, stop_status: "completed" }, 2), "completed");
  assert.equal(dispatchStopMarkerClass({ id: 1, stop_status: "skipped" }, 2), "skipped");
  assert.match(dispatchCssSource, /\.dispatch-route-marker\.arrived\s*\{[\s\S]*background: #2e8b57/);
  assert.match(dispatchCssSource, /\.dispatch-route-marker\.completed::after[\s\S]*content: "\\2713"/);
  assert.match(dispatchCssSource, /\.dispatch-route-marker\.skipped\s*\{[\s\S]*background: #c44747/);
}

function testFarFromAssignedRouteStillGeneratesGuide() {
  const result = evaluateDispatchLiveGuideReroute(
    point(6.25, 125.35),
    "ticket:91:session:58:stop:2",
    {
      now: 50000,
      lastTargetSignature: "",
      lastStart: null,
      routeCoordinates: [],
      offRouteSince: null,
      lastRequestAt: 0
    }
  );
  assert.equal(result.shouldReroute, true);
  assert.equal(result.reason, "guide_missing");
  assert.equal(DISPATCH_CURRENT_ROUTE_STYLE.pane, "dispatchCurrentRoutePane");
}

async function testValidLiveContextRendersRoadGuide() {
  const createLayerGroup = () => ({
    layers: [],
    getLayers() { return [...this.layers]; },
    removeLayer(layer) {
      this.layers = this.layers.filter((candidate) => candidate !== layer);
    },
    addTo() { return this; }
  });
  const layerGroup = createLayerGroup();
  const alternativeLayerGroup = createLayerGroup();
  const map = {
    hasLayer(layer) {
      return layer === layerGroup ||
        layer === alternativeLayerGroup ||
        layerGroup.layers.includes(layer) ||
        alternativeLayerGroup.layers.includes(layer);
    }
  };
  global.L = {
    polyline(coordinates, options) {
      return {
        coordinates,
        options,
        getLatLngs() {
          return this.coordinates;
        },
        bindTooltip(label) {
          this.label = label;
          return this;
        },
        addTo(group) {
          group.layers.push(this);
          return this;
        }
      };
    }
  };
  Object.assign(global, {
    truckMap: map,
    selectedSessionId: 58,
    dispatchLiveBySession: {},
    dispatchCurrentRouteLayerGroup: layerGroup,
    dispatchAlternativeRouteLayerGroup: alternativeLayerGroup,
    dispatchLiveGuideRequestTimer: null,
    dispatchLiveGuideAbortController: null,
    dispatchLiveGuideGeneration: 0,
    dispatchLiveGuideTargetSignature: "",
    dispatchLiveGuidePendingSignature: "",
    dispatchLiveGuideLastStart: null,
    dispatchLiveGuideCoordinates: [],
    dispatchLiveGuideAlternativeCoordinates: [],
    dispatchLiveGuideAlternativeRouteCount: 0,
    dispatchLiveGuideOffRouteSince: null,
    dispatchLiveGuideLastRequestAt: 0,
    dispatchLiveGuideLastRequestedTargetSignature: "",
    dispatchLiveGuideLastRerouteReason: "",
    dispatchLiveGuideLastRerouteAt: null,
    dispatchLiveGuideLastRequestSucceeded: null,
    dispatchLiveGuideLastOriginAt: null,
    dispatchLiveGuideMovedMeters: null,
    dispatchAssignedRoutePointCount: 3,
    dispatchLiveGuideTargetLabel: "",
    dispatchLiveGuideDistanceMeters: null,
    dispatchCurrentStopStatus: ""
  });

  let scheduledWork = null;
  const position = {
    lat: 6.12,
    lng: 125.19,
    accuracy: 12,
    recorded_at: new Date().toISOString()
  };
  const details = {
    ticket: { id: 91, status: "in_progress" },
    tracking_sessions: [{ tracking_session_id: 58, is_primary: 1 }],
    stops: [{
      id: 1,
      stop_order: 1,
      stop_status: "on_the_way",
      location_name: "Pioneer Avenue",
      latitude: 6.13,
      longitude: 125.2
    }]
  };
  const started = renderDispatchLiveGuide(details, position, {
    groups: { currentStop: details.stops[0] },
    routeRequest: async (start, destination) => {
      assert.deepEqual(start, { lat: position.lat, lng: position.lng });
      assert.deepEqual(destination, { lat: 6.13, lng: 125.2 });
      return {
        primary: { coordinates: [[position.lat, position.lng], [6.125, 125.195], [6.13, 125.2]] },
        alternatives: [
          { coordinates: [[position.lat, position.lng], [6.124, 125.196], [6.13, 125.2]] },
          { coordinates: [[position.lat, position.lng], [6.126, 125.194], [6.13, 125.2]] }
        ],
        routeCount: 3
      };
    },
    schedule(callback) {
      scheduledWork = callback();
      return 1;
    }
  });
  assert.equal(started, true);
  await scheduledWork;
  assert.equal(layerGroup.layers.length, 1);
  assert.equal(layerGroup.layers[0].coordinates.length, 3);
  assert.equal(layerGroup.layers[0].options.color, "#f28c18");
  assert.equal(alternativeLayerGroup.layers.length, 2);
  assert.ok(alternativeLayerGroup.layers.every((layer) => layer.options.color === "#66b7e8"));
  assert.match(global.dispatchLiveGuideTargetSignature, /stop:1/);
  assert.equal(global.dispatchLiveGuideAlternativeRouteCount, 2);
  assert.equal(global.dispatchLiveGuideLastRequestSucceeded, true);
  assert.equal(global.dispatchLiveGuideLastOriginAt, position.recorded_at);

  layerGroup.layers = [];
  alternativeLayerGroup.layers = [];
  let unexpectedRecoveryRequest = false;
  assert.equal(renderDispatchLiveGuide(details, position, {
    groups: { currentStop: details.stops[0] },
    routeRequest: async () => {
      unexpectedRecoveryRequest = true;
      return [];
    },
    schedule() {
      unexpectedRecoveryRequest = true;
      return 0;
    }
  }), false);
  assert.equal(unexpectedRecoveryRequest, false,
    "a detached cached guide is restored without another OSRM request");
  assert.equal(layerGroup.layers.length, 1);
  assert.equal(alternativeLayerGroup.layers.length, 2,
    "detached cached alternatives are restored without another OSRM request");

  const firstGuide = layerGroup.layers[0];
  const firstAlternatives = [...alternativeLayerGroup.layers];
  let resolveChangedRoute;
  const changedDetails = {
    ...details,
    stops: [{
      ...details.stops[0],
      id: 2,
      stop_order: 2,
      location_name: "Pendatun Avenue",
      latitude: 6.14,
      longitude: 125.21
    }]
  };
  assert.equal(renderDispatchLiveGuide(changedDetails, position, {
    groups: { currentStop: changedDetails.stops[0] },
    routeRequest: () => new Promise((resolve) => {
      resolveChangedRoute = resolve;
    }),
    schedule(callback) {
      scheduledWork = callback();
      return 2;
    }
  }), true);
  assert.equal(layerGroup.layers[0], firstGuide,
    "the old guide remains visible while the destination-change route is pending");
  resolveChangedRoute({
    primary: { coordinates: [[position.lat, position.lng], [6.13, 125.2], [6.14, 125.21]] },
    alternatives: [{ coordinates: [[position.lat, position.lng], [6.132, 125.198], [6.14, 125.21]] }],
    routeCount: 2
  });
  await scheduledWork;
  assert.equal(layerGroup.layers.length, 1, "destination change swaps rather than accumulates guides");
  assert.notEqual(layerGroup.layers[0], firstGuide);
  assert.equal(alternativeLayerGroup.layers.length, 1);
  assert.ok(!alternativeLayerGroup.layers.some((layer) => firstAlternatives.includes(layer)),
    "destination change replaces alternatives from the previous target");
  assert.match(global.dispatchLiveGuideTargetSignature, /stop:2/);

  const retainedGuide = layerGroup.layers[0];
  const retainedAlternatives = [...alternativeLayerGroup.layers];
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(renderDispatchLiveGuide(changedDetails, position, {
      force: true,
      groups: { currentStop: changedDetails.stops[0] },
      routeRequest: async () => {
        throw new Error("simulated OSRM failure");
      },
      schedule(callback) {
        scheduledWork = callback();
        return 3;
      }
    }), true);
    await scheduledWork;
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(layerGroup.layers, [retainedGuide],
    "a failed reroute preserves the last valid guide");
  assert.deepEqual(alternativeLayerGroup.layers, retainedAlternatives,
    "a failed reroute preserves the last valid alternatives");

  let poorAccuracyRequest = false;
  assert.equal(dispatchLiveNavigationAccuracyIsReliable({ accuracy: 75 }), false);
  assert.equal(renderDispatchLiveGuide(changedDetails, {
    ...position,
    accuracy: 75,
    lat: position.lat + 0.001
  }, {
    force: true,
    groups: { currentStop: changedDetails.stops[0] },
    routeRequest: async () => {
      poorAccuracyRequest = true;
      throw new Error("must not run");
    },
    schedule() {
      poorAccuracyRequest = true;
      return 4;
    }
  }), false);
  assert.equal(poorAccuracyRequest, false, "accuracy-poor GPS cannot trigger a navigation reroute");

  [
    "L", "truckMap", "selectedSessionId", "dispatchLiveBySession",
    "dispatchCurrentRouteLayerGroup", "dispatchLiveGuideRequestTimer",
    "dispatchAlternativeRouteLayerGroup",
    "dispatchLiveGuideAbortController", "dispatchLiveGuideGeneration",
    "dispatchLiveGuideTargetSignature", "dispatchLiveGuidePendingSignature",
    "dispatchLiveGuideLastStart", "dispatchLiveGuideCoordinates",
    "dispatchLiveGuideAlternativeCoordinates",
    "dispatchLiveGuideAlternativeRouteCount",
    "dispatchLiveGuideOffRouteSince", "dispatchLiveGuideLastRequestAt",
    "dispatchLiveGuideLastRequestedTargetSignature",
    "dispatchLiveGuideLastRerouteReason", "dispatchLiveGuideLastRerouteAt",
    "dispatchLiveGuideLastRequestSucceeded", "dispatchLiveGuideLastOriginAt",
    "dispatchLiveGuideMovedMeters",
    "dispatchAssignedRoutePointCount", "dispatchLiveGuideTargetLabel",
    "dispatchLiveGuideDistanceMeters", "dispatchCurrentStopStatus"
  ].forEach((key) => delete global[key]);
}

function testRouteTruthsStaySeparate() {
  const guideRenderer = liveGuideSource();
  assert.match(guideRenderer, /routeRequest\(\s*startPoint,\s*target\.point/);
  assert.match(guideRenderer, /: requestDispatchLiveNavigationRoutes/,
    "production live navigation must use its alternatives-aware request helper");
  assert.match(guideRenderer, /dispatchLiveGuideCoordinates\s*=/);
  assert.match(guideRenderer, /dispatchLiveGuideAlternativeCoordinates\s*=/);
  assert.doesNotMatch(guideRenderer, /dispatchLastSuccessfulRouteCoordinates\s*=/);
  assert.doesNotMatch(guideRenderer, /selectedRoutePolyline|matchTrackingDisplaySegments|getCachedTrackingMatch/);
  assert.match(source, /Original assigned road route/);
  assert.match(source, /Live guide to/);
  assert.match(trackingSource, /TRACKING_ACTUAL_ROUTE_COLOR/);
  assert.match(trackingSource, /getCachedTrackingMatch/);
  assert.match(dashboardSource, /> Actual trail</);
  assert.match(dashboardSource, /> Assigned route</);
  assert.match(dashboardSource, /> Primary live guide</);
  assert.match(dashboardSource, /> Alternative route</);
  assert.match(dashboardSource, /> Current truck</);
  assert.match(dashboardSource, /> Destination</);
  assert.match(dashboardSource, /> WMO</);
  assert.match(source, /activateDispatchPlannedLayerGroups\(route\.layers, \{ preserveLiveGuide: true \}\)/);
  assert.doesNotMatch(
    source.slice(
      source.indexOf("const routeSignature = [", source.indexOf("function renderDispatchPersistedActiveRoute")),
      source.indexOf("].join", source.indexOf("const routeSignature = [", source.indexOf("function renderDispatchPersistedActiveRoute")))
    ),
    /markerSignature/,
    "marker-state refreshes must not tear down stable assigned/live route layers"
  );
  assert.doesNotMatch(guideRenderer, /fitBounds|setView/,
    "normal navigation polling preserves operator zoom and pan");
  assert.match(guideRenderer, /generation !== dispatchLiveGuideGeneration/);
  assert.match(guideRenderer, /expectedAlternativeLayerGroup !== dispatchAlternativeRouteLayerGroup/);
  const routeLoaderStart = trackingSource.indexOf("async function loadTruckRoute");
  const routeLoaderEnd = trackingSource.indexOf("async function hydrateSelectedTruckWorkspace", routeLoaderStart);
  const routeLoader = trackingSource.slice(routeLoaderStart, routeLoaderEnd);
  assert.ok(
    routeLoader.indexOf("updateTruckMarkerWithReliableRoutePoint") <
      routeLoader.indexOf("renderTrackingRoadMatchedRoute"),
    "accepted GPS moves the shared truck marker before asynchronous route display work"
  );
  assert.match(trackingSource, /if \(!keepView && routeChanged\)/,
    "normal five-second refreshes do not refit the map");
}

async function run() {
  testTargetProgressionAndWmoReturn();
  testDeviationAndNoiseDecisions();
  testPollingDoesNotSpamRouting();
  await testNavigationOnlyAlternativesRequestAndParsing();
  testFarFromAssignedRouteStillGeneratesGuide();
  testGuideLayerReplacementAndFailurePreservationContracts();
  testMarkerStatusVisualSemantics();
  await testValidLiveContextRendersRoadGuide();
  testRouteTruthsStaySeparate();
  console.log("Dispatch live-guide rerouting tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
