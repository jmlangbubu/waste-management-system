const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DISPATCH_PLANNED_ROUTE_PANE,
  DISPATCH_PLANNED_ROUTE_STYLE,
  DISPATCH_WMO_LOCATION,
  buildDispatchRouteLayers,
  dispatchContinuousRouteWaypoints,
  dispatchRoutingFailureState,
  dispatchRoutingResponseIsCurrent,
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
    bindTooltip() { return this; },
    addTo(group) { group.layers.push(this); return this; }
  });
  return {
    layerGroup(children = []) {
      return {
        kind: "layer-group",
        layers: [...children],
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
  assert.equal(layers.connectors.layers.length, 1, "planned route must be one Leaflet polyline");
  assert.equal(layers.connectors.layers[0].kind, "polyline");
  assert.deepEqual(layers.connectors.layers[0].value, coordinates);
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
  assert.deepEqual(layers.root.layers, [
    layers.geometry, layers.connectors, layers.destinations, layers.wmo, layers.start
  ]);
  delete global.L;
  delete global.escapeHtml;
}

function testPlannedRouteStyleAndPane() {
  assert.equal(DISPATCH_PLANNED_ROUTE_PANE, "dispatchPlannedRoutePane");
  assert.equal(DISPATCH_PLANNED_ROUTE_STYLE.color, "#245c46");
  assert.equal(DISPATCH_PLANNED_ROUTE_STYLE.weight, 5);
  assert.ok(DISPATCH_PLANNED_ROUTE_STYLE.opacity > 0.5);
  assert.ok(DISPATCH_PLANNED_ROUTE_STYLE.dashArray);
  assert.equal(DISPATCH_PLANNED_ROUTE_STYLE.pane, DISPATCH_PLANNED_ROUTE_PANE);
  assert.match(trackingSource, /createPane\("dispatchPlannedRoutePane"\)[\s\S]*zIndex = "450"/);
}

function testPollingRetainsPlannedRouteAndMapView() {
  const loadActiveTrucks = trackingSource.match(/async function loadActiveTrucks\(\)[\s\S]*?function renderActiveTruckList/);
  assert.ok(loadActiveTrucks);
  assert.match(loadActiveTrucks[0], /loadTruckRoute\(selectedSessionId, \{ keepView: true \}\)/);
  assert.doesNotMatch(loadActiveTrucks[0], /clearDispatchPlannedRoute/);
  assert.doesNotMatch(loadActiveTrucks[0], /\.fitBounds\(|\.setView\(/);
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
    message: "Route preview unavailable",
    preserveSelectedStops: true,
    preservePreviousRoute: true,
    drawStraightFallback: false
  });
  assert.match(dispatchSource, /if \(!dispatchPlannedLayerGroup\) \{\s*renderDispatchSelectionFallback/);
  assert.match(dispatchSource, /previous_route_retained: Boolean\(dispatchPlannedLayerGroup\)/);
  assert.doesNotMatch(dispatchSource, /drawStraightFallback\s*:\s*true/);
  assert.match(dispatchSource, /restoreDispatchRoutePreviewState\(routeSnapshot\)/);
  assert.match(dispatchSource, /Your route is still saved\. Please retry\./);
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
  testPollingRetainsPlannedRouteAndMapView();
  testStaleResponseRejection();
  testFailureRetainsSelectionsAndPreviousRoute();
  testDrawerRecordsAndTicketFailureDoNotClearRoute();
  testDiagnosticsAndExplicitClearReasons();
  console.log("Dispatch planned-route lifecycle tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
