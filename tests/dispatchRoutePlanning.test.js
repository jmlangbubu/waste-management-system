const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DISPATCH_WMO_LOCATION,
  chooseDispatchSegmentOrientation,
  dispatchCatalogDestinationIsSelected,
  dispatchRoutingFailureState
} = require("../frontend/js/admin/admin-dispatch");

function testForwardAndReverseOrientation() {
  const segment = [
    { latitude: 6.1, longitude: 125.1 },
    { latitude: 6.1, longitude: 125.2 }
  ];
  const forward = chooseDispatchSegmentOrientation(
    { lat: 6.1, lng: 125.09 },
    { lat: 6.1, lng: 125.21 },
    segment
  );
  assert.equal(forward[0].longitude, 125.1);

  const reverse = chooseDispatchSegmentOrientation(
    { lat: 6.1, lng: 125.21 },
    { lat: 6.1, lng: 125.09 },
    segment
  );
  assert.equal(reverse[0].longitude, 125.2);
  assert.equal(segment[0].longitude, 125.1, "orientation must not mutate stored geometry");
}

function testDuplicateCatalogSelection() {
  const metadata = new Map([
    ["stop-1", { catalog_id: 42 }],
    ["stop-2", { catalog_id: null }]
  ]);
  assert.equal(dispatchCatalogDestinationIsSelected(42, metadata), true);
  assert.equal(dispatchCatalogDestinationIsSelected("42", metadata), true);
  assert.equal(dispatchCatalogDestinationIsSelected(43, metadata), false);
}

function testRequiredWmoReturnDisplay() {
  assert.deepEqual(DISPATCH_WMO_LOCATION, {
    latitude: 6.1060875,
    longitude: 125.1816406,
    radiusMeters: 100
  });
  const dashboard = fs.readFileSync(
    path.join(__dirname, "..", "frontend", "admin-dashboard.html"),
    "utf8"
  );
  const wmoBlock = dashboard.match(/<div class="dispatch-wmo-return"[\s\S]*?<\/div>\s*<div id="dispatchRoutePreviewNotice"/);
  assert.ok(wmoBlock, "the planner must show the required WMO return block");
  assert.match(wmoBlock[0], /Return to WMO/);
  assert.doesNotMatch(wmoBlock[0], /data-dispatch-stop-remove/);
}

function testRoutingFailurePreservesPlan() {
  assert.deepEqual(dispatchRoutingFailureState(), {
    message: "Road route preview unavailable",
    preserveSelectedStops: true,
    drawStraightFallback: false
  });
}

testForwardAndReverseOrientation();
testDuplicateCatalogSelection();
testRequiredWmoReturnDisplay();
testRoutingFailurePreservesPlan();
console.log("Dispatch route planning tests passed");
