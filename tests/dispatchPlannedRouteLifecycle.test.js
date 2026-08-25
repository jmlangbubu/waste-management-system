const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DISPATCH_COMPLETED_ROUTE_PANE,
  DISPATCH_CURRENT_ROUTE_PANE,
  DISPATCH_CURRENT_ROUTE_STYLE,
  DISPATCH_MARKER_PANE,
  DISPATCH_PLANNED_ROUTE_PANE,
  DISPATCH_PLANNED_ROUTE_STYLE,
  DISPATCH_ROUTING_GPS_STALE_MS,
  DISPATCH_WMO_LOCATION,
  buildDispatchPlannedJourney,
  buildDispatchRouteLayers,
  buildDispatchSelectionFallbackLayers,
  dispatchContinuousRouteWaypoints,
  dispatchLayerHasVisiblePolyline,
  dispatchOrderActiveRouteStops,
  dispatchPersistedStopOrder,
  dispatchRouteSegmentWithEndpoints,
  dispatchRoutingFailureState,
  dispatchRoutingResponseIsCurrent,
  dispatchSavedStopRouteItems,
  dispatchShouldReoptimizeRemaining,
  parseDispatchOsrmRoutePayload,
  resolveDispatchRouteOrigin,
  resolveDispatchLivePollState,
  requestDispatchRoadJourney
} = require("../frontend/js/admin/admin-dispatch");

const dispatchSource = fs.readFileSync(
  path.join(__dirname, "..", "frontend", "js", "admin", "admin-dispatch.js"),
  "utf8"
);
const trackingSource = fs.readFileSync(
  path.join(__dirname, "..", "frontend", "js", "admin", "admin-tracking.js"),
  "utf8"
);
const dashboardSource = fs.readFileSync(
  path.join(__dirname, "..", "frontend", "admin-dashboard.html"),
  "utf8"
);

function point(lat, lng) {
  return { lat, lng };
}

function testContinuousWaypointOrderAndWmoEndpoint() {
  const start = point(6.09, 125.14);
  const wmo = point(DISPATCH_WMO_LOCATION.latitude, DISPATCH_WMO_LOCATION.longitude);
  const journey = {
    plannedStops: [
      { geometry: [point(6.10, 125.15)] },
      { geometry: [point(6.11, 125.16), point(6.12, 125.17)] },
      { geometry: [point(6.13, 125.18)] },
      { geometry: [point(6.14, 125.19)] }
    ]
  };
  const waypoints = dispatchContinuousRouteWaypoints(start, journey, wmo);
  assert.deepEqual(waypoints[0], start);
  assert.deepEqual(waypoints.slice(1, -1), journey.plannedStops.flatMap((stop) => stop.geometry));
  assert.deepEqual(waypoints.at(-1), wmo);
}

function testRouteOriginUsesWmoUntilFreshTruckLeavesGeofence() {
  const now = Date.UTC(2026, 7, 12, 0, 0, 0);
  const wmo = point(DISPATCH_WMO_LOCATION.latitude, DISPATCH_WMO_LOCATION.longitude);
  const noGps = resolveDispatchRouteOrigin(null, { now });
  assert.deepEqual(noGps.point, wmo);
  assert.equal(noGps.source, "missing");

  const insideWmo = resolveDispatchRouteOrigin({
    lat: wmo.lat + 0.0002,
    lng: wmo.lng,
    timestamp: now
  }, { now });
  assert.deepEqual(insideWmo.point, wmo);
  assert.equal(insideWmo.source, "inside_wmo");

  const staleOutside = resolveDispatchRouteOrigin({
    lat: wmo.lat + 0.003,
    lng: wmo.lng,
    timestamp: now - DISPATCH_ROUTING_GPS_STALE_MS - 1
  }, { now });
  assert.deepEqual(staleOutside.point, wmo);
  assert.equal(staleOutside.source, "stale");

  const freshOutsidePoint = point(wmo.lat + 0.003, wmo.lng);
  const freshOutside = resolveDispatchRouteOrigin({
    ...freshOutsidePoint,
    timestamp: now
  }, { now });
  assert.deepEqual(freshOutside.point, freshOutsidePoint);
  assert.equal(freshOutside.source, "truck");
  assert.equal(freshOutside.usesTruckPosition, true);
  assert.equal(DISPATCH_ROUTING_GPS_STALE_MS, 5 * 60 * 1000);
}

function testImmediateRouteStartsAndEndsAtWmoBeforeDeparture() {
  const wmo = point(DISPATCH_WMO_LOCATION.latitude, DISPATCH_WMO_LOCATION.longitude);
  const journey = {
    plannedStops: [
      { geometry: [point(6.12, 125.17)] },
      { geometry: [point(6.13, 125.18)] }
    ]
  };
  const waypoints = dispatchContinuousRouteWaypoints(wmo, journey, wmo);
  assert.deepEqual(waypoints[0], wmo);
  assert.deepEqual(waypoints.at(-1), wmo);
}

function testConsecutiveDuplicateWaypointsAreRemovedWithoutReordering() {
  const shared = point(6.11, 125.16);
  const waypoints = dispatchContinuousRouteWaypoints(
    point(6.09, 125.14),
    { plannedStops: [{ geometry: [shared, shared, point(6.12, 125.17)] }] },
    point(6.13, 125.18)
  );
  assert.deepEqual(waypoints, [
    point(6.09, 125.14), shared, point(6.12, 125.17), point(6.13, 125.18)
  ]);
}

function testOsrmGeoJsonCoordinateConversion() {
  const waypoints = [point(6.1, 125.1), point(6.2, 125.2)];
  const parsed = parseDispatchOsrmRoutePayload({
    routes: [{ distance: 1200, geometry: { coordinates: [[125.1, 6.1], [125.15, 6.15], [125.2, 6.2]] } }]
  }, waypoints);
  assert.deepEqual(parsed.coordinates, [[6.1, 125.1], [6.15, 125.15], [6.2, 125.2]]);
  assert.equal(parsed.routeCount, 1);
  assert.equal(parsed.distance, 1200);
}

function testOsrmEndpointsMatchTruckAndWmo() {
  const start = point(6.0917, 125.1421);
  const wmo = point(6.1060875, 125.1816406);
  const parsed = parseDispatchOsrmRoutePayload({
    routes: [{ geometry: { coordinates: [[start.lng, start.lat], [125.16, 6.10], [wmo.lng, wmo.lat]] } }]
  }, [start, point(6.10, 125.16), wmo]);
  assert.deepEqual(parsed.coordinates[0], [start.lat, start.lng]);
  assert.deepEqual(parsed.coordinates.at(-1), [wmo.lat, wmo.lng]);
}

function testEmptyGeometryIsAnError() {
  assert.throws(
    () => parseDispatchOsrmRoutePayload({ routes: [{ geometry: { coordinates: [] } }] }, [point(6.1, 125.1), point(6.2, 125.2)]),
    /No drivable road route/
  );
}

async function testOneOrderedOsrmRequestAndParsedPolyline() {
  let requestedUrl = "";
  const waypoints = [point(6.31, 125.31), point(6.32, 125.32), point(6.33, 125.33)];
  const route = await requestDispatchRoadJourney(waypoints, new AbortController().signal, {
    generation: 17,
    fetchImplementation: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          routes: [{ distance: 300, geometry: { coordinates: waypoints.map((item) => [item.lng, item.lat]) } }]
        })
      };
    }
  });
  assert.match(requestedUrl, /125\.31,6\.31;125\.32,6\.32;125\.33,6\.33/);
  assert.deepEqual(route, waypoints.map((item) => [item.lat, item.lng]));
}

function fakeLeaflet() {
  const addable = (kind, value, options = {}) => ({
    kind,
    value,
    options,
    getLatLngs() { return kind === "polyline" ? value : []; },
    bindTooltip() { return this; },
    addTo(group) { group.layers.push(this); return this; }
  });
  return {
    layerGroup(children = []) {
      return {
        kind: "layer-group",
        layers: [...children],
        getLayers() { return this.layers; },
        addTo(map) { map.layers.push(this); return this; }
      };
    },
    divIcon(options) { return options; },
    marker(latlng, options) { return addable("marker", latlng, options); },
    polyline(latlngs, options) { return addable("polyline", latlngs, options); }
  };
}

function testOnePlannedPolylineAndSeparateLayerGroups() {
  global.L = fakeLeaflet();
  global.escapeHtml = (value) => String(value ?? "");
  const journey = {
    plannedStops: [
      {
        stop: { id: 1, latitude: 6.11, longitude: 125.16, location_name: "Stop 1", stop_status: "pending" },
        geometry: [point(6.10, 125.15), point(6.11, 125.16)]
      },
      {
        stop: { id: 2, latitude: 6.12, longitude: 125.17, location_name: "Stop 2", stop_status: "pending" },
        geometry: [point(6.12, 125.17)]
      }
    ]
  };
  const coordinates = [[6.09, 125.14], [6.11, 125.16], [6.12, 125.17], [6.1060875, 125.1816406]];
  const layers = buildDispatchRouteLayers(
    journey,
    coordinates,
    point(6.09, 125.14),
    point(6.1060875, 125.1816406),
    { showTruckMarker: false }
  );
  assert.equal(layers.planned.layers.length, 1, "draft route must be one continuous Leaflet polyline");
  assert.equal(layers.planned.layers[0].kind, "polyline");
  assert.deepEqual(layers.planned.layers[0].value, coordinates);
  assert.equal(layers.destinations.layers.length, 2);
  assert.deepEqual(layers.destinations.layers.map((layer) => layer.value), [
    [6.11, 125.16], [6.12, 125.17]
  ]);
  assert.match(layers.destinations.layers[0].options.icon.html, />1</);
  assert.match(layers.destinations.layers[1].options.icon.html, />2</);
  assert.equal(layers.wmo.layers.length, 1);
  assert.deepEqual(layers.wmo.layers[0].value, [6.1060875, 125.1816406]);
  assert.match(layers.wmo.layers[0].options.icon.html, />W</);
  assert.ok(layers.geometry.layers.every((layer) => layer.kind === "polyline"));
  assert.ok(layers.completed);
  assert.ok(layers.current);
  assert.equal(Object.hasOwn(layers, "root"), false, "an empty root wrapper must not be the route sentinel");
  delete global.L;
  delete global.escapeHtml;
}

function testPlannedRouteStyleAndPane() {
  assert.equal(DISPATCH_CURRENT_ROUTE_PANE, "dispatchCurrentRoutePane");
  assert.equal(DISPATCH_PLANNED_ROUTE_PANE, "dispatchPlannedRoutePane");
  assert.equal(DISPATCH_COMPLETED_ROUTE_PANE, "dispatchCompletedRoutePane");
  assert.equal(DISPATCH_MARKER_PANE, "dispatchMarkerPane");
  assert.equal(DISPATCH_CURRENT_ROUTE_STYLE.color, "#2d73c7");
  assert.equal(DISPATCH_CURRENT_ROUTE_STYLE.dashArray, undefined);
  assert.equal(DISPATCH_PLANNED_ROUTE_STYLE.color, "#2d73c7");
  assert.equal(DISPATCH_PLANNED_ROUTE_STYLE.weight, 5);
  assert.ok(DISPATCH_PLANNED_ROUTE_STYLE.opacity > 0.5);
  assert.equal(DISPATCH_PLANNED_ROUTE_STYLE.dashArray, undefined);
  assert.equal(DISPATCH_PLANNED_ROUTE_STYLE.pane, DISPATCH_PLANNED_ROUTE_PANE);
  assert.match(trackingSource, /"trackingActualRoutePane", "460"/);
  assert.match(trackingSource, /"dispatchPlannedRoutePane", "440"/);
  assert.match(trackingSource, /"dispatchCurrentRoutePane", "455"/);
  assert.match(trackingSource, /"dispatchCompletedRoutePane", "470"/);
  assert.match(trackingSource, /"dispatchMarkerPane", "650"/);
  assert.match(trackingSource, /TRACKING_ACTUAL_ROUTE_COLOR = "#285a48"/);
  assert.equal(
    (trackingSource.match(/color: TRACKING_ACTUAL_ROUTE_COLOR/g) || []).length,
    2,
    "solid actual trail and synchronization gaps must remain dark green"
  );
  assert.match(dashboardSource, /> Actual trail</);
  assert.match(dashboardSource, /> Assigned route</);
  assert.match(dashboardSource, /> Current truck</);
  assert.match(dashboardSource, /> Destination</);
}

function testActiveRouteUsesExactEndpointsAndDedicatedLayers() {
  global.L = fakeLeaflet();
  global.escapeHtml = (value) => String(value ?? "");
  const start = point(6.09, 125.14);
  const current = point(6.11, 125.16);
  const wmo = point(DISPATCH_WMO_LOCATION.latitude, DISPATCH_WMO_LOCATION.longitude);
  const routeCoordinates = [
    [6.0902, 125.1402],
    [6.105, 125.155],
    [6.1098, 125.1598],
    [6.12, 125.17],
    [6.1062, 125.1815]
  ];
  const journey = {
    plannedStops: [
      {
        stop: { id: 31, latitude: current.lat, longitude: current.lng, location_name: "Current", stop_status: "on_the_way" },
        geometry: [current]
      },
      {
        stop: { id: 32, latitude: 6.12, longitude: 125.17, location_name: "Next", stop_status: "pending" },
        geometry: [point(6.12, 125.17)]
      }
    ]
  };
  const layers = buildDispatchRouteLayers(journey, routeCoordinates, start, wmo, {
    currentStopId: 31
  });
  assert.equal(layers.current.layers.length, 0);
  assert.equal(layers.planned.layers.length, 1);
  assert.deepEqual(layers.planned.layers[0].value[0], [start.lat, start.lng]);
  assert.deepEqual(layers.planned.layers[0].value.at(-1), [wmo.lat, wmo.lng]);
  assert.equal(layers.planned.layers[0].options.pane, DISPATCH_PLANNED_ROUTE_PANE);
  assert.equal(layers.planned.layers[0].options.color, "#2d73c7");
  assert.deepEqual(
    dispatchRouteSegmentWithEndpoints([], start, current),
    [[start.lat, start.lng], [current.lat, current.lng]]
  );
  delete global.L;
  delete global.escapeHtml;
}

function testReadyRequiresAnAttachedPolyline() {
  const polyline = { getLatLngs: () => [[6.1, 125.1], [6.2, 125.2]] };
  const marker = { getLatLngs: undefined };
  const visibleGroup = { getLayers: () => [marker, polyline] };
  const markerOnlyGroup = { getLayers: () => [marker] };
  const visibleMap = { hasLayer: (layer) => layer === visibleGroup || layer === markerOnlyGroup || layer === polyline || layer === marker };
  assert.equal(dispatchLayerHasVisiblePolyline(visibleGroup, visibleMap), true);
  assert.equal(dispatchLayerHasVisiblePolyline(markerOnlyGroup, visibleMap), false);
  assert.equal(dispatchLayerHasVisiblePolyline(visibleGroup, { hasLayer: () => false }), false);
  assert.match(dispatchSource, /normalizedStatus === "ready" && !dispatchHasVisiblePlannedRoute\(\)/);
  assert.match(dispatchSource, /updateDispatchRoutePreviewNotice\("complete"\)/);
}

function testPollingRetainsPlannedRouteAndMapView() {
  const loadActiveTrucks = trackingSource.match(/async function loadActiveTrucks\(\)[\s\S]*?function renderActiveTruckList/);
  assert.ok(loadActiveTrucks);
  assert.match(loadActiveTrucks[0], /hydrateSelectedTruckWorkspace\(selectedSessionId, \{ keepView: true \}\)/);
  assert.doesNotMatch(loadActiveTrucks[0], /clearDispatchPlannedRoute/);
  assert.doesNotMatch(loadActiveTrucks[0], /\.fitBounds\(|\.setView\(/);
}

function testSelectionHydratesTrackingBeforeActiveDispatch() {
  const loader = trackingSource.match(/async function loadTruckRoute[\s\S]*?async function hydrateSelectedTruckWorkspace/)?.[0] || "";
  const hydration = trackingSource.match(/async function hydrateSelectedTruckWorkspace[\s\S]*?function resetTrackingView/)?.[0] || "";
  const selection = trackingSource.match(/function selectTruck[\s\S]*?function bindActiveTruckSelection/)?.[0] || "";
  assert.doesNotMatch(loader, /renderDispatchDraftOnLiveMap/);
  assert.match(loader, /String\(selectedSessionId \|\| ""\) !== String\(sessionId \|\| ""\)/);
  assert.match(hydration, /await loadTruckRoute\(sessionId, options\)[\s\S]*return loadDispatchForTrackingSession\(sessionId\)/);
  assert.match(selection, /void hydrateSelectedTruckWorkspace\(sessionId, \{ keepView: false \}\)/);
  assert.doesNotMatch(selection, /void loadDispatchForTrackingSession/);
  assert.match(dispatchSource, /mustRehydrateRoute[\s\S]*!dispatchHasVisiblePlannedRoute\(\)/);
}

function testStaleResponseRejection() {
  const activeLayer = {};
  assert.equal(dispatchRoutingResponseIsCurrent(8, null, 8, activeLayer), true);
  assert.equal(dispatchRoutingResponseIsCurrent(7, null, 8, activeLayer), false);
  assert.equal(dispatchRoutingResponseIsCurrent(8, {}, 8, activeLayer), false);
  assert.match(dispatchSource, /stale route response rejected/);
}

function testFailureRetainsSelectionsAndPreviousRoute() {
  assert.deepEqual(dispatchRoutingFailureState(), {
    message: "Route preview unavailable. The last route is still displayed.",
    preserveSelectedStops: true,
    preservePreviousRoute: true,
    drawStraightFallback: false
  });
  assert.match(dispatchSource, /if \(!dispatchHasVisiblePlannedRoute\(\)\) \{\s*renderDispatchSelectionFallback/);
  assert.match(dispatchSource, /previous_route_retained: dispatchHasVisiblePlannedRoute\(\)/);
  assert.doesNotMatch(dispatchSource, /drawStraightFallback\s*:\s*true/);
  assert.match(dispatchSource, /restoreDispatchRoutePreviewState\(routeSnapshot\)/);
  assert.match(dispatchSource, /Your route is still saved\. Please retry\./);
}

function testDispatchLiveFailureAndAuthoritativeEmptyState() {
  const activeDispatch = {
    "58": { dispatch_ticket_id: 2058, ticket_number: "DT-2026-2058" }
  };
  const afterFailure = resolveDispatchLivePollState(activeDispatch, undefined, false);
  const afterAuthoritativeEmpty = resolveDispatchLivePollState(activeDispatch, {}, true);

  assert.strictEqual(
    afterFailure,
    activeDispatch,
    "a failed request must retain the exact last successful dispatch snapshot"
  );
  assert.deepEqual(
    afterAuthoritativeEmpty,
    {},
    "a successful empty response must authoritatively clear the dispatch snapshot"
  );

  const liveLoader = dispatchSource.match(
    /async function loadDispatchLiveData[\s\S]*?function invalidateDispatchLiveRequests/
  )?.[0] || "";
  const failureBlock = liveLoader.slice(liveLoader.indexOf("catch (error)"));
  const linkedLoader = dispatchSource.match(
    /async function loadDispatchForTrackingSession[\s\S]*?function dispatchMarkerIcon/
  )?.[0] || "";
  assert.match(liveLoader, /resolveDispatchLivePollState\(dispatchLiveBySession, data, true\)/);
  assert.match(failureBlock, /dispatchLiveLastRequestStatus = "failed"/);
  assert.doesNotMatch(failureBlock, /dispatchLiveBySession\s*=\s*\{\}/);
  assert.match(
    linkedLoader,
    /if \(dispatchLiveLastRequestFailed\(\)\) return selectedDispatchTicket;[\s\S]*selectedDispatchTicket = null/
  );
}

function fallbackLayersForSavedStops(stops) {
  global.L = fakeLeaflet();
  global.escapeHtml = (value) => String(value ?? "");
  try {
    const items = dispatchSavedStopRouteItems(stops);
    return {
      items,
      layers: buildDispatchSelectionFallbackLayers(
        items,
        point(6.09, 125.14),
        point(DISPATCH_WMO_LOCATION.latitude, DISPATCH_WMO_LOCATION.longitude),
        null,
        { currentStopId: 101 }
      )
    };
  } finally {
    delete global.L;
    delete global.escapeHtml;
  }
}

function markerLabels(layers) {
  return layers.destinations.layers.map((layer) => {
    const match = layer.options.icon.html.match(/>([^<]+)</);
    return match ? match[1] : "";
  });
}

function testPersistedStopMarkersAndRoutingFallback() {
  assert.equal(dispatchPersistedStopOrder({ stop_order: "5" }, 1), 5);
  assert.equal(dispatchPersistedStopOrder({}, 4), 4);

  const contiguous = fallbackLayersForSavedStops([
    { id: 103, stop_order: 3, latitude: 6.13, longitude: 125.18, location_name: "Third", stop_status: "pending" },
    { id: 101, stop_order: 1, latitude: 6.11, longitude: 125.16, location_name: "First", stop_status: "on_the_way" },
    { id: 102, stop_order: 2, latitude: 6.12, longitude: 125.17, location_name: "Second", stop_status: "pending" }
  ]);
  assert.deepEqual(contiguous.items.map(({ stop }) => stop.stop_order), [1, 2, 3]);
  assert.deepEqual(markerLabels(contiguous.layers), ["1", "2", "3"]);

  const nonContiguous = fallbackLayersForSavedStops([
    { id: 205, stop_order: 5, latitude: 6.15, longitude: 125.19, location_name: "Fifth", stop_status: "pending" },
    { id: 201, stop_order: 1, latitude: 6.11, longitude: 125.16, location_name: "First", stop_status: "pending" },
    { id: 203, stop_order: 3, latitude: 6.13, longitude: 125.18, location_name: "Third", stop_status: "pending" }
  ]);
  assert.deepEqual(markerLabels(nonContiguous.layers), ["1", "3", "5"]);
  assert.notDeepEqual(markerLabels(nonContiguous.layers), ["1", "2", "3"]);

  global.L = fakeLeaflet();
  global.escapeHtml = (value) => String(value ?? "");
  try {
    const routed = buildDispatchRouteLayers(
      {
        plannedStops: nonContiguous.items.map(({ stop }) => ({
          stop,
          geometry: [point(stop.latitude, stop.longitude)]
        }))
      },
      [[6.09, 125.14], [6.13, 125.18], [6.1060875, 125.1816406]],
      point(6.09, 125.14),
      point(DISPATCH_WMO_LOCATION.latitude, DISPATCH_WMO_LOCATION.longitude)
    );
    assert.deepEqual(markerLabels(routed), ["1", "3", "5"]);
  } finally {
    delete global.L;
    delete global.escapeHtml;
  }

  const skipped = fallbackLayersForSavedStops([
    { id: 302, stop_order: 2, latitude: 6.12, longitude: 125.17, location_name: "Skipped", stop_status: "skipped" }
  ]);
  assert.deepEqual(markerLabels(skipped.layers), ["2"]);
  assert.match(skipped.layers.destinations.layers[0].options.icon.html, /dispatch-route-marker skipped/);
  assert.match(
    dispatchSource,
    /dispatchMarkerIcon\(dispatchPersistedStopOrder\(stop\), "skipped"\)/
  );

  const sameCoordinate = fallbackLayersForSavedStops([
    { id: 401, stop_order: 1, latitude: 6.12, longitude: 125.17, location_name: "Same A", stop_status: "pending" },
    { id: 402, stop_order: 2, latitude: 6.12, longitude: 125.17, location_name: "Same B", stop_status: "pending" },
    { id: 403, stop_order: 3, latitude: 6.12, longitude: 125.17, location_name: "Same C", stop_status: "pending" }
  ]);
  assert.equal(sameCoordinate.layers.destinations.layers.length, 3);
  assert.notStrictEqual(
    sameCoordinate.layers.destinations.layers[0],
    sameCoordinate.layers.destinations.layers[1],
    "same-coordinate persisted stops must remain separate marker objects"
  );
  assert.deepEqual(markerLabels(sameCoordinate.layers), ["1", "2", "3"]);
  assert.equal(sameCoordinate.layers.planned.layers.length, 0, "fallback must not fabricate a road route");
  assert.doesNotMatch(
    sameCoordinate.layers.destinations.layers.map((layer) => layer.options.icon.html).join(""),
    />\?</
  );
}

function testSavedMarkersRenderBeforeRoadRouting() {
  const activeRenderer = dispatchSource.match(
    /function renderDispatchPlannedRoute[\s\S]*?function dispatchEventLabel/
  )?.[0] || "";
  const immediateSavedMarkerIndex = activeRenderer.indexOf(
    "dispatchSavedStopRouteItems(details.stops)"
  );
  const routingRequestIndex = activeRenderer.indexOf("requestDispatchRoadJourney");
  const failureSavedMarkerIndex = activeRenderer.indexOf(
    "dispatchSavedStopRouteItems(details.stops, items)"
  );
  assert.ok(immediateSavedMarkerIndex >= 0 && immediateSavedMarkerIndex < routingRequestIndex);
  assert.ok(failureSavedMarkerIndex > routingRequestIndex);
  assert.match(
    activeRenderer,
    /if \(!dispatchHasVisiblePlannedRoute\(\) && details\.stops\.length\)[\s\S]*renderDispatchSelectionFallback/
  );
}

function testAssignmentAndActiveRouteOrderLocking() {
  const preDispatchJourney = buildDispatchPlannedJourney(
    point(6.1, 125.1),
    point(6.1, 125.13),
    [
      {
        stop: { id: 1, location_name: "Far first selection" },
        metadata: { catalog_id: 1 },
        geometry: [point(6.1, 125.12)]
      },
      {
        stop: { id: 2, location_name: "Near second selection" },
        metadata: { catalog_id: 2 },
        geometry: [point(6.1, 125.11)]
      }
    ]
  );
  assert.deepEqual(
    preDispatchJourney.plannedStops.map(({ stop }) => stop.id),
    [1, 2],
    "pre-dispatch planning must preserve the personnel-assigned order"
  );
  const routeStops = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(
    dispatchOrderActiveRouteStops(routeStops, [1, 3, 2], false).map((stop) => stop.id),
    [1, 3, 2],
    "ordinary movement must retain the current and pending order"
  );
  assert.deepEqual(
    dispatchOrderActiveRouteStops(routeStops, [1, 3, 2], true).map((stop) => stop.id),
    [1, 3, 2],
    "post-dispatch order must remain locked even if a reoptimization flag is supplied"
  );
  assert.equal(dispatchShouldReoptimizeRemaining("truck_moved"), false);
  assert.equal(dispatchShouldReoptimizeRemaining("destinations_changed"), false);
  assert.equal(dispatchShouldReoptimizeRemaining("sustained_off_route"), false);
  assert.equal(dispatchShouldReoptimizeRemaining("forced"), false);
  assert.equal(dispatchShouldReoptimizeRemaining("forced", { reoptimizeRemaining: true }), false);
  assert.doesNotMatch(dispatchSource, /dispatchReoptimizeRemainingBtn|Re-optimize Remaining Stops/);
  assert.doesNotMatch(dispatchSource, /reoptimizeRemaining\s*:/);
}

function testIssueSelectionPollingAndFailureLifecycle() {
  const dispatchNow = dispatchSource.match(
    /async function dispatchSelectedTruckNow[\s\S]*?function dispatchTicketQuery/
  )?.[0] || "";
  const activeRenderer = dispatchSource.match(
    /function renderDispatchPlannedRoute[\s\S]*?function dispatchEventLabel/
  )?.[0] || "";
  const routeLayers = dispatchSource.match(
    /function buildDispatchRouteLayers[\s\S]*?function renderDispatchSelectionFallback/
  )?.[0] || "";
  assert.match(dispatchNow, /renderDispatchTicketDetails\(details\)[\s\S]*renderDispatchPlannedRoute\(details\)/);
  assert.match(activeRenderer, /const startPoint = wmo/);
  assert.match(activeRenderer, /createDispatchPlannedLayerGroups\(\{ detached: true \}\)/);
  assert.match(activeRenderer, /requestDispatchRoadJourney[\s\S]*activateDispatchPlannedLayerGroups\(layers\)/);
  assert.doesNotMatch(activeRenderer, /resolveDispatchRouteOrigin|requestDispatchRoadCostMatrix/);
  assert.match(activeRenderer, /if \(!dispatchHasVisiblePlannedRoute\(\)\) \{\s*renderDispatchSelectionFallback/);
  assert.doesNotMatch(activeRenderer, /clearDispatchPlannedRoute/);
  assert.doesNotMatch(activeRenderer, /renderDispatchCompletedRouteGeometry/);
  assert.doesNotMatch(routeLayers, /color: "#408a71"/);
  assert.doesNotMatch(dashboardSource, /Edit Route/i);
}

function testDrawerRecordsAndTicketFailureDoNotClearRoute() {
  const drawerFunctions = dispatchSource.match(
    /function openDispatchPlannerDrawer[\s\S]*?function setDispatchWorkspaceTab/
  )?.[0] || "";
  const workspaceActions = dispatchSource.match(
    /workspace\.querySelectorAll\("\[data-dispatch-workspace-action\]"\)[\s\S]*?dispatchPlannerBackBtn/
  )?.[0] || "";
  const saveDraft = dispatchSource.match(
    /async function saveDispatchDraft[\s\S]*?function submitDispatchTicketForm/
  )?.[0] || "";
  assert.doesNotMatch(drawerFunctions, /clearDispatchPlannedRoute|resetDispatchTicketForm/);
  assert.doesNotMatch(workspaceActions, /clearDispatchPlannedRoute|resetDispatchTicketForm/);
  assert.match(saveDraft, /captureDispatchRoutePreviewState/);
  assert.match(saveDraft, /restoreDispatchRoutePreviewState/);
  assert.doesNotMatch(saveDraft, /clearDispatchPlannedRoute/);
}

function testLiveTransitionRerenderAndPanelActionsDoNotClearRoute() {
  const dispatchNow = dispatchSource.match(
    /async function dispatchSelectedTruckNow[\s\S]*?function dispatchTicketQuery/
  )?.[0] || "";
  const liveRenderer = dispatchSource.match(
    /function renderDispatchTicketDetails\(details\)[\s\S]*?function openDispatchModal/
  )?.[0] || "";
  const workspaceBindings = dispatchSource.match(
    /workspace\.querySelectorAll\("\[data-dispatch-workspace-action\]"\)[\s\S]*?dispatchPlannerConfirmationCancelBtn/
  )?.[0] || "";
  assert.match(dispatchNow, /renderDispatchTicketDetails\(details\)[\s\S]*renderDispatchPlannedRoute\(details\)/);
  assert.doesNotMatch(dispatchNow, /clearDispatchPlannedRoute/);
  assert.doesNotMatch(liveRenderer, /clearDispatchPlannedRoute|removeLayer/);
  assert.match(workspaceBindings, /dispatchStopActionSheet"\)\?\.classList\.toggle\("hidden"\)/);
  assert.match(workspaceBindings, /dispatchViewActiveRouteBtn"\)\?\.addEventListener\("click", viewDispatchActiveRoute\)/);
  assert.doesNotMatch(workspaceBindings, /clearDispatchPlannedRoute|resetDispatchTicketForm/);
  assert.match(dispatchSource, /function viewDispatchActiveRoute[\s\S]*renderDispatchPlannedRoute\(selectedDispatchTicket, \{[\s\S]*force: true/);
  assert.match(dispatchSource, /function renderDispatchCompletedRouteGeometry[\s\S]*DISPATCH_COMPLETED_ROUTE_STYLE/);
}

function testDiagnosticsAndExplicitClearReasons() {
  for (const token of [
    "url:", "waypoint_count", "generation_id", "http_status", "route_count",
    "coordinate_count", "render_success", "stale route response rejected", "planned route cleared"
  ]) {
    assert.ok(dispatchSource.includes(token), `missing route diagnostic: ${token}`);
  }
  assert.match(dispatchSource, /clearDispatchPlannedRoute\("no selected destinations"\)/);
  assert.match(dispatchSource, /clearDispatchPlannedRoute\("tracking selection cleared"\)/);
}

async function run() {
  testContinuousWaypointOrderAndWmoEndpoint();
  testRouteOriginUsesWmoUntilFreshTruckLeavesGeofence();
  testImmediateRouteStartsAndEndsAtWmoBeforeDeparture();
  testConsecutiveDuplicateWaypointsAreRemovedWithoutReordering();
  testOsrmGeoJsonCoordinateConversion();
  testOsrmEndpointsMatchTruckAndWmo();
  testEmptyGeometryIsAnError();
  await testOneOrderedOsrmRequestAndParsedPolyline();
  testOnePlannedPolylineAndSeparateLayerGroups();
  testPlannedRouteStyleAndPane();
  testActiveRouteUsesExactEndpointsAndDedicatedLayers();
  testReadyRequiresAnAttachedPolyline();
  testPollingRetainsPlannedRouteAndMapView();
  testSelectionHydratesTrackingBeforeActiveDispatch();
  testStaleResponseRejection();
  testFailureRetainsSelectionsAndPreviousRoute();
  testDispatchLiveFailureAndAuthoritativeEmptyState();
  testPersistedStopMarkersAndRoutingFallback();
  testSavedMarkersRenderBeforeRoadRouting();
  testAssignmentAndActiveRouteOrderLocking();
  testIssueSelectionPollingAndFailureLifecycle();
  testDrawerRecordsAndTicketFailureDoNotClearRoute();
  testLiveTransitionRerenderAndPanelActionsDoNotClearRoute();
  testDiagnosticsAndExplicitClearReasons();
  console.log("Dispatch planned-route lifecycle tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
