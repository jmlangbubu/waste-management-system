const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DISPATCH_WMO_LOCATION,
  buildDispatchDestinationMarkerLayer,
  buildDispatchRouteLayers,
  createDispatchWmoMarkerLayer
} = require("../frontend/js/admin/admin-dispatch.js");

const ROOT = path.resolve(__dirname, "..");
const dispatchSource = fs.readFileSync(
  path.join(ROOT, "frontend", "js", "admin", "admin-dispatch.js"),
  "utf8"
);
const trackingSource = fs.readFileSync(
  path.join(ROOT, "frontend", "js", "admin", "admin-tracking.js"),
  "utf8"
);
const dashboardSource = fs.readFileSync(
  path.join(ROOT, "frontend", "admin-dashboard.html"),
  "utf8"
);

function fakeLeaflet() {
  const addable = (kind, value, options = {}) => ({
    kind,
    value,
    options,
    bindTooltip() { return this; },
    addTo(group) { group.layers.push(this); return this; }
  });
  return {
    layerGroup() {
      return {
        layers: [],
        getLayers() { return this.layers; },
        addTo(map) { map.layers.push(this); return this; }
      };
    },
    divIcon(options) { return options; },
    marker(latlng, options) { return addable("marker", latlng, options); },
    polyline(latlngs, options) { return addable("polyline", latlngs, options); }
  };
}

function draftItems(stopOrders = [9, 4, 7]) {
  return stopOrders.map((stopOrder, index) => ({
    stop: {
      id: index + 1,
      stop_order: stopOrder,
      location_name: `Destination ${index + 1}`,
      latitude: 6.11 + index * 0.01,
      longitude: 125.15 + index * 0.01,
      stop_status: "pending"
    },
    geometry: [{ lat: 6.11 + index * 0.01, lng: 125.15 + index * 0.01 }]
  }));
}

function markerLabels(layerGroup) {
  return layerGroup.layers.map((layer) => {
    const match = String(layer.options?.icon?.html || "").match(/>([^<]+)</);
    return match?.[1] || "";
  });
}

function withLeaflet(run) {
  global.L = fakeLeaflet();
  global.escapeHtml = (value) => String(value ?? "");
  try {
    run();
  } finally {
    delete global.L;
    delete global.escapeHtml;
  }
}

function testDraftMarkersExistBeforeSaveAndUseReviewedOrder() {
  withLeaflet(() => {
    const wmoLayer = createDispatchWmoMarkerLayer();
    const draftLayer = buildDispatchDestinationMarkerLayer(draftItems(), {
      usePersistedStopOrder: false
    });
    assert.deepEqual(markerLabels(wmoLayer), ["W"]);
    assert.deepEqual(markerLabels(draftLayer), ["1", "2", "3"]);
    assert.deepEqual(wmoLayer.layers[0].value, [
      DISPATCH_WMO_LOCATION.latitude,
      DISPATCH_WMO_LOCATION.longitude
    ]);
  });
}

function testSavedMarkersUseOnlyPersistedStopOrder() {
  withLeaflet(() => {
    const savedLayer = buildDispatchDestinationMarkerLayer(draftItems([1, 3, 5]));
    assert.deepEqual(markerLabels(savedLayer), ["1", "3", "5"]);
  });
}

function testOptimizedRouteMarkersIgnorePreOptimizationDraftNumbers() {
  withLeaflet(() => {
    const items = draftItems([9, 4, 7]);
    const route = buildDispatchRouteLayers(
      { plannedStops: items },
      [[6.1, 125.14], [6.11, 125.15], [6.12, 125.16], [6.1060875, 125.1816406]],
      { lat: 6.1, lng: 125.14 },
      { lat: DISPATCH_WMO_LOCATION.latitude, lng: DISPATCH_WMO_LOCATION.longitude },
      { usePersistedStopOrder: false }
    );
    assert.deepEqual(markerLabels(route.destinations), ["1", "2", "3"]);
  });
}

function testLayerOwnershipAndFailureOrder() {
  const clearBlock = dispatchSource.slice(
    dispatchSource.indexOf("function clearDispatchPlannedRoute"),
    dispatchSource.indexOf("function createDispatchWmoMarkerLayer")
  );
  const draftBlock = dispatchSource.slice(
    dispatchSource.indexOf("function renderDispatchDraftOnLiveMap"),
    dispatchSource.indexOf("function renderDispatchPlanningMap")
  );
  const previewBlock = dispatchSource.slice(
    dispatchSource.indexOf("function updateDispatchDestinationPreview"),
    dispatchSource.indexOf("async function resolveDispatchPreviewBarangay")
  );

  assert.doesNotMatch(clearBlock, /removeLayer\(dispatchWmoMarkerLayerGroup\)/);
  assert.doesNotMatch(clearBlock, /removeLayer\(dispatchDestinationMarkerLayerGroup\)/);
  assert.match(clearBlock, /ensureDispatchWmoMarker\(\)/);
  assert.match(
    draftBlock,
    /renderDispatchDestinationMarkers\(items, \{ usePersistedStopOrder: false \}\)[\s\S]*evaluateDispatchDynamicReroute/
  );
  assert.match(
    draftBlock,
    /catch \(error\)[\s\S]*renderDispatchSelectionFallback\([\s\S]*usePersistedStopOrder: false/
  );
  assert.match(previewBlock, /dispatchPreviewMarker/);
  assert.doesNotMatch(previewBlock, /dispatchDestinationMarkerLayerGroup/);
  assert.match(trackingSource, /initializeTruckMap[\s\S]*ensureDispatchWmoMarker\(\)/);
}

function testPlannerPresentationContract() {
  assert.match(dashboardSource, /Search road, street, location\.\.\./);
  assert.match(dashboardSource, /Available destinations/);
  assert.match(dispatchSource, /data-dispatch-stop-number/);
  assert.match(dashboardSource, /Trucks &amp; Active Dispatches/);
}

function run() {
  testDraftMarkersExistBeforeSaveAndUseReviewedOrder();
  testSavedMarkersUseOnlyPersistedStopOrder();
  testOptimizedRouteMarkersIgnorePreOptimizationDraftNumbers();
  testLayerOwnershipAndFailureOrder();
  testPlannerPresentationContract();
  console.log("dispatchPlannerMapOfflineVisibility.test.js: all assertions passed");
}

run();
