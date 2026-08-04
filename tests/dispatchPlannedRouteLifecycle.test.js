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
  DISPATCH_WMO_LOCATION,
  buildDispatchRouteLayers,
  dispatchContinuousRouteWaypoints,
  dispatchLayerHasVisiblePolyline,
  dispatchOrderActiveRouteStops,
  dispatchRouteSegmentWithEndpoints,
  dispatchRoutingFailureState,
  dispatchRoutingResponseIsCurrent,
  dispatchShouldReoptimizeRemaining,
  parseDispatchOsrmRoutePayload,
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
  assert.equal(DISPATCH_PLANNED_ROUTE_STYLE.color, "#687a73");
  assert.equal(DISPATCH_PLANNED_ROUTE_STYLE.weight, 5);
  assert.ok(DISPATCH_PLANNED_ROUTE_STYLE.opacity > 0.5);
  assert.ok(DISPATCH_PLANNED_ROUTE_STYLE.dashArray);
  assert.equal(DISPATCH_PLANNED_ROUTE_STYLE.pane, DISPATCH_PLANNED_ROUTE_PANE);
  assert.match(trackingSource, /"trackingActualRoutePane", "410"/);
  assert.match(trackingSource, /"dispatchPlannedRoutePane", "440"/);
  assert.match(trackingSource, /"dispatchCurrentRoutePane", "455"/);
  assert.match(trackingSource, /"dispatchCompletedRoutePane", "470"/);
  assert.match(trackingSource, /"dispatchMarkerPane", "650"/);
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
  assert.equal(layers.current.layers.length, 1);
  assert.equal(layers.planned.layers.length, 1);
  assert.deepEqual(layers.current.layers[0].value[0], [start.lat, start.lng]);
  assert.deepEqual(layers.current.layers[0].value.at(-1), [current.lat, current.lng]);
  assert.deepEqual(layers.planned.layers[0].value[0], [current.lat, current.lng]);
  assert.deepEqual(layers.planned.layers[0].value.at(-1), [wmo.lat, wmo.lng]);
  assert.equal(layers.current.layers[0].options.pane, DISPATCH_CURRENT_ROUTE_PANE);
  assert.equal(layers.planned.layers[0].options.pane, DISPATCH_PLANNED_ROUTE_PANE);
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
    message: "Route update is temporarily unavailable. The last route is still displayed.",
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

function testActiveRouteOrderLockingAndExplicitReoptimization() {
  const routeStops = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(
    dispatchOrderActiveRouteStops(routeStops, [1, 3, 2], false).map((stop) => stop.id),
    [1, 3, 2],
    "ordinary movement must retain the current and pending order"
  );
  assert.deepEqual(
    dispatchOrderActiveRouteStops(routeStops, [1, 3, 2], true).map((stop) => stop.id),
    [1, 2, 3],
    "an allowed reoptimization may use the new candidate order"
  );
  assert.equal(dispatchShouldReoptimizeRemaining("truck_moved"), false);
  assert.equal(dispatchShouldReoptimizeRemaining("destinations_changed"), true);
  assert.equal(dispatchShouldReoptimizeRemaining("sustained_off_route"), true);
  assert.equal(dispatchShouldReoptimizeRemaining("forced"), false);
  assert.equal(dispatchShouldReoptimizeRemaining("forced", { reoptimizeRemaining: true }), true);
}

function testDrawerRecordsAndTicketFailureDoNotClearRoute() {
  const drawerFunctions = dispatchSource.match(
    /function openDispatchPlannerDrawer[\s\S]*?function setDispatchWorkspaceTab/
  )?.[0] || "";
  const workspaceActions = dispatchSource.match(
    /workspace\.querySelectorAll\("\[data-dispatch-workspace-action\]"\)[\s\S]*?dispatchPlannerBackBtn/
  )?.[0] || "";
  const saveDraft = dispatchSource.match(
    /async function saveDispatchDraft[\s\S]*?async function submitDispatchTicketForm/
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
  testActiveRouteOrderLockingAndExplicitReoptimization();
  testDrawerRecordsAndTicketFailureDoNotClearRoute();
  testLiveTransitionRerenderAndPanelActionsDoNotClearRoute();
  testDiagnosticsAndExplicitClearReasons();
  console.log("Dispatch planned-route lifecycle tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
