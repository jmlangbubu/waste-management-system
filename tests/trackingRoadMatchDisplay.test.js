const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  TRACKING_MATCH_MAX_COORDINATES,
  TRACKING_ROUTE_GAP_MS,
  buildTrackingDisplayRoute,
  buildTrackingMatchUrl,
  chunkTrackingMatchSegment,
  clearTrackingDispatchStartMarker,
  ensureTrackingDispatchStartMarker,
  getCachedTrackingMatch,
  isTrackingMatchResponseCurrent,
  joinTrackingMatchedChunkGeometry,
  matchTrackingDisplaySegments,
  moveTrackingMarker,
  parseTrackingMatchResponse,
  renderTrackingActualRoute,
  resolveTrackingStartMarkerAction,
  splitTrackingDisplaySegments,
  trackingActualTrailLayerIsVisible,
  trackingBearingDegrees
} = require("../frontend/js/admin/admin-tracking.js");

const ROOT = path.resolve(__dirname, "..");
const trackingSource = fs.readFileSync(
  path.join(ROOT, "frontend/js/admin/admin-tracking.js"),
  "utf8"
);
const dispatchSource = fs.readFileSync(
  path.join(ROOT, "frontend/js/admin/admin-dispatch.js"),
  "utf8"
);
const dashboardHtml = fs.readFileSync(
  path.join(ROOT, "frontend/admin-dashboard.html"),
  "utf8"
);

function functionBlock(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.ok(startIndex >= 0, `missing ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `missing ${end}`);
  return source.slice(startIndex, endIndex);
}

function acceptedPoint(index, timestamp = 1_000_000) {
  return {
    id: index + 1,
    stableId: index + 1,
    lat: 6.1 + index * 0.0001,
    lng: 125.1 + index * 0.0001,
    timestamp: timestamp + index * 10_000,
    recorded_at: new Date(timestamp + index * 10_000).toISOString()
  };
}

function coordinatesFromMatchUrl(url) {
  const coordinateText = String(url).match(/\/match\/v1\/driving\/([^?]+)/)?.[1] || "";
  return coordinateText.split(";").filter(Boolean).map((coordinate) =>
    coordinate.split(",").map(Number)
  );
}

function successfulMatchResponse(url, confidence = 0.92) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        code: "Ok",
        matchings: [{
          confidence,
          geometry: { coordinates: coordinatesFromMatchUrl(url) }
        }]
      };
    }
  };
}

async function testRawGpsIsNeverMutatedAndMappedCountStaysGpsBased() {
  const rawGps = [
    { id: 1, latitude: "6.1000", longitude: "125.1000", accuracy: 8, recorded_at: "2026-09-09 08:00:00" },
    { id: 2, latitude: "6.1001", longitude: "125.1001", accuracy: 9, recorded_at: "2026-09-09 08:00:10" },
    { id: 3, latitude: "6.1002", longitude: "125.1002", accuracy: 10, recorded_at: "2026-09-09 08:00:20" }
  ];
  const originalGps = structuredClone(rawGps);
  const display = buildTrackingDisplayRoute(rawGps);
  const matched = await matchTrackingDisplaySegments(display.displayedPoints, {
    fetchImpl: async (url) => successfulMatchResponse(url)
  });

  assert.deepEqual(rawGps, originalGps, "display filtering and matching must not mutate backend GPS records");
  assert.equal(display.displayedPoints.length, 3, "mapped count remains accepted GPS records");
  assert.equal(matched.segments[0].rawPoints.length, 3);
  assert.equal(matched.matchedSegmentCount, 1);
}

async function testContinuousAndConfirmedGapSegmentation() {
  const continuous = [acceptedPoint(0), acceptedPoint(1), acceptedPoint(2)];
  assert.equal(splitTrackingDisplaySegments(continuous).length, 1);

  const withGap = [
    acceptedPoint(0),
    acceptedPoint(1),
    acceptedPoint(2, 1_100_001),
    acceptedPoint(3, 1_100_001)
  ];
  const segments = splitTrackingDisplaySegments(withGap);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map((segment) => segment.length), [2, 2]);
  assert.ok(segments[1][0].timestamp - segments[0][1].timestamp > TRACKING_ROUTE_GAP_MS);

  const requests = [];
  const result = await matchTrackingDisplaySegments(withGap, {
    fetchImpl: async (url) => {
      requests.push(url);
      return successfulMatchResponse(url);
    }
  });
  assert.equal(requests.length, 2, "each continuous segment gets its own match request");
  assert.equal(result.segments.length, 2);
  assert.ok(coordinatesFromMatchUrl(requests[0]).length === 2);
  assert.ok(coordinatesFromMatchUrl(requests[1]).length === 2);
  assert.doesNotMatch(requests[0], new RegExp(withGap[2].lng.toFixed(6)));
  assert.doesNotMatch(requests[1], new RegExp(withGap[1].lng.toFixed(6)));
}

function testMatchResponseValidationAndUrlContract() {
  const points = [acceptedPoint(0), acceptedPoint(1)];
  const url = buildTrackingMatchUrl(points);
  assert.match(url, /^https:\/\/router\.project-osrm\.org\/match\/v1\/driving\//);
  assert.match(url, /geometries=geojson/);
  assert.match(url, /gaps=ignore/);
  assert.equal(new URL(url).searchParams.get("timestamps").split(";").length, points.length);

  const duplicateSecondUrl = buildTrackingMatchUrl([
    acceptedPoint(0, 1_000_000),
    acceptedPoint(1, 990_000)
  ]);
  assert.equal(
    new URL(duplicateSecondUrl).searchParams.has("timestamps"),
    false,
    "duplicate whole-second timestamps must omit the optional timestamps parameter"
  );

  const valid = parseTrackingMatchResponse({
    code: "Ok",
    matchings: [{
      confidence: 0.9,
      geometry: { coordinates: [[125.1, 6.1], [125.2, 6.2]] }
    }]
  });
  assert.deepEqual(valid.geometry, [[6.1, 125.1], [6.2, 125.2]]);
  assert.equal(valid.confidence, 0.9);

  assert.equal(parseTrackingMatchResponse({ code: "Error" }), null);
  assert.equal(parseTrackingMatchResponse({
    code: "Ok",
    matchings: [{ confidence: 0.1, geometry: { coordinates: [[125.1, 6.1], [125.2, 6.2]] } }]
  }), null);
  assert.equal(parseTrackingMatchResponse({
    code: "Ok",
    matchings: [{ confidence: 0.9, geometry: { coordinates: [[125.1, 96.1], [125.2, 6.2]] } }]
  }), null);
  assert.equal(parseTrackingMatchResponse({
    code: "Ok",
    matchings: [{ confidence: 0.9, geometry: { coordinates: [[125.1, 6.1]] } }]
  }), null);
}

async function testMalformedNetworkAndTimeoutFallbackToRaw() {
  const points = [acceptedPoint(0), acceptedPoint(1)];
  const expectedRaw = points.map((point) => [point.lat, point.lng]);

  const malformed = await matchTrackingDisplaySegments(points, {
    fetchImpl: async () => ({ ok: true, async json() { return { code: "Ok", matchings: [] }; } })
  });
  assert.deepEqual(malformed.segments[0].geometry, expectedRaw);
  assert.equal(malformed.displayMode, "raw_fallback");

  const invalidJson = await matchTrackingDisplaySegments(points, {
    fetchImpl: async () => ({ ok: true, async json() { throw new SyntaxError("invalid JSON"); } })
  });
  assert.deepEqual(invalidJson.segments[0].geometry, expectedRaw);

  for (const status of [400, 429, 500]) {
    const httpFailure = await matchTrackingDisplaySegments(points, {
      fetchImpl: async () => ({ ok: false, status })
    });
    assert.deepEqual(httpFailure.segments[0].geometry, expectedRaw);
  }

  const networkFailure = await matchTrackingDisplaySegments(points, {
    fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.deepEqual(networkFailure.segments[0].geometry, expectedRaw);

  const timeout = await matchTrackingDisplaySegments(points, {
    timeoutMs: 5,
    fetchImpl: async () => new Promise(() => {})
  });
  assert.deepEqual(timeout.segments[0].geometry, expectedRaw);
  assert.equal(timeout.segments[0].fallbackReason, "aborted");

  const controller = new AbortController();
  controller.abort();
  const aborted = await matchTrackingDisplaySegments(points, {
    signal: controller.signal,
    fetchImpl: async () => { throw new Error("must not be called"); }
  });
  assert.deepEqual(aborted.segments[0].geometry, expectedRaw);
  assert.equal(aborted.aborted, true);

  let singlePointRequests = 0;
  const singlePoint = await matchTrackingDisplaySegments([points[0]], {
    fetchImpl: async () => {
      singlePointRequests++;
      return successfulMatchResponse("");
    }
  });
  assert.equal(singlePointRequests, 0);
  assert.equal(singlePoint.segments[0].fallbackReason, "single_point");
}

async function testStaleProtectionAndUnchangedSignatureCache() {
  assert.equal(isTrackingMatchResponseCurrent("58", "new", 7, {
    sessionId: "58",
    routeSignature: "new",
    requestId: 7
  }), true);
  assert.equal(isTrackingMatchResponseCurrent("58", "old", 6, {
    sessionId: "58",
    routeSignature: "new",
    requestId: 7
  }), false);
  assert.equal(isTrackingMatchResponseCurrent("57", "new", 7, {
    sessionId: "58",
    routeSignature: "new",
    requestId: 7
  }), false);

  const cache = new Map();
  const chunkCache = new Map();
  const points = [acceptedPoint(0), acceptedPoint(1)];
  let requestCount = 0;
  const options = {
    cache,
    chunkCache,
    fetchImpl: async (url) => {
      requestCount++;
      return successfulMatchResponse(url);
    }
  };
  const first = getCachedTrackingMatch(points, 58, "same-signature", options);
  const second = getCachedTrackingMatch(points.map((point) => ({ ...point })), 58, "same-signature", options);
  assert.equal(first, second, "same session/signature must reuse one pending or completed match");
  await Promise.all([first, second]);
  assert.equal(requestCount, 1);
  const extendedPoints = [...points, acceptedPoint(2)];
  await getCachedTrackingMatch(
    extendedPoints,
    58,
    "changed-signature",
    options
  );
  assert.equal(requestCount, 2);
}

async function testLongRouteChunkLimitOverlapAndDeduplication() {
  const points = Array.from({ length: 23 }, (_, index) => acceptedPoint(index));
  const original = structuredClone(points);
  const chunks = chunkTrackingMatchSegment(points);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.length <= TRACKING_MATCH_MAX_COORDINATES));
  assert.equal(chunks[0][chunks[0].length - 1], chunks[1][0], "chunks overlap by one accepted point");
  assert.equal(chunks[1][chunks[1].length - 1], chunks[2][0], "chunks overlap by one accepted point");

  const requestSizes = [];
  const result = await matchTrackingDisplaySegments(points, {
    fetchImpl: async (url) => {
      requestSizes.push(coordinatesFromMatchUrl(url).length);
      return successfulMatchResponse(url);
    }
  });
  assert.deepEqual(points, original);
  assert.deepEqual(requestSizes, [10, 10, 5]);
  assert.equal(result.segments[0].geometry.length, 23, "overlapping chunk vertices are deduplicated");
  result.segments[0].geometry.forEach((point, index, geometry) => {
    if (index) assert.notDeepEqual(point, geometry[index - 1]);
  });

  assert.deepEqual(
    joinTrackingMatchedChunkGeometry([[[6.1, 125.1], [6.2, 125.2]], [[6.2, 125.2], [6.3, 125.3]]]),
    [[6.1, 125.1], [6.2, 125.2], [6.3, 125.3]]
  );

  const edgeCases = new Map([
    [2, [2]],
    [9, [9]],
    [10, [10]],
    [11, [10, 2]],
    [19, [10, 10]],
    [20, [10, 10, 2]],
    [21, [10, 10, 3]],
    [34, [10, 10, 10, 7]]
  ]);
  edgeCases.forEach((expectedSizes, pointCount) => {
    const edgePoints = Array.from({ length: pointCount }, (_, index) => acceptedPoint(index));
    const edgeChunks = chunkTrackingMatchSegment(edgePoints);
    assert.deepEqual(edgeChunks.map((chunk) => chunk.length), expectedSizes);
    assert.equal(edgeChunks.at(-1).at(-1), edgePoints.at(-1), "final observation must be retained");
    for (let index = 1; index < edgeChunks.length; index++) {
      assert.equal(
        edgeChunks[index - 1].at(-1),
        edgeChunks[index][0],
        "adjacent chunks must overlap by one observation"
      );
    }
  });
}

async function testGrowingRouteReusesCompletedHistoricalChunks() {
  const routeCache = new Map();
  const chunkCache = new Map();
  let requestCount = 0;
  const options = {
    cache: routeCache,
    chunkCache,
    fetchImpl: async (url) => {
      requestCount++;
      return successfulMatchResponse(url);
    }
  };
  const initialPoints = Array.from({ length: 100 }, (_, index) => acceptedPoint(index));
  await getCachedTrackingMatch(initialPoints, 58, "100-points", options);
  assert.equal(requestCount, 11);

  const extendedPoints = [...initialPoints, acceptedPoint(100)];
  await getCachedTrackingMatch(extendedPoints, 58, "101-points", options);
  assert.equal(
    requestCount,
    12,
    "one appended observation must reuse 11 completed chunks and request only the new tail"
  );

  await getCachedTrackingMatch(initialPoints, 59, "100-points", options);
  assert.equal(requestCount, 23, "chunk cache entries must not collide across tracking sessions");

  const boundedChunkCache = new Map();
  await getCachedTrackingMatch(
    Array.from({ length: 34 }, (_, index) => acceptedPoint(index)),
    60,
    "bounded-cache",
    {
      cache: new Map(),
      chunkCache: boundedChunkCache,
      chunkCacheLimit: 2,
      fetchImpl: async (url) => successfulMatchResponse(url)
    }
  );
  assert.equal(boundedChunkCache.size, 2, "completed chunk cache must remain bounded");
}

function testSessionScopedStartStateAndExistingMapContracts() {
  const firstPoint = acceptedPoint(0);
  assert.deepEqual(resolveTrackingStartMarkerAction("", "58", firstPoint), {
    action: "replace",
    position: [firstPoint.lat, firstPoint.lng]
  });
  assert.deepEqual(resolveTrackingStartMarkerAction("58", "58", acceptedPoint(9)), {
    action: "keep",
    position: [acceptedPoint(9).lat, acceptedPoint(9).lng]
  });
  assert.equal(resolveTrackingStartMarkerAction("58", "59", {}).action, "none");

  const stationaryGps = [
    { id: 1, latitude: "6.100000", longitude: "125.100000", accuracy: 5, recorded_at: "2026-09-09 08:00:00" },
    { id: 2, latitude: "6.100001", longitude: "125.100001", accuracy: 5, recorded_at: "2026-09-09 08:00:10" }
  ];
  const stationaryDisplay = buildTrackingDisplayRoute(stationaryGps);
  assert.equal(stationaryDisplay.displayedPoints.length, 1);
  assert.equal(stationaryDisplay.startPoint.recorded_at, stationaryGps[0].recorded_at);
  assert.equal(stationaryDisplay.displayedPoints[0].recorded_at, stationaryGps[1].recorded_at);

  const removedLayers = [];
  global.truckMap = {
    removeLayer(layer) {
      removedLayers.push(layer);
    }
  };
  global.L = {
    divIcon(options) {
      return options;
    },
    marker(position, options) {
      return {
        position,
        options,
        addTo(map) {
          this.map = map;
          return this;
        },
        bindPopup(popup) {
          this.popup = popup;
          return this;
        }
      };
    }
  };
  global.escapeHtml = (value) => String(value);
  clearTrackingDispatchStartMarker();
  const initialMarker = ensureTrackingDispatchStartMarker("58", stationaryDisplay.startPoint);
  assert.deepEqual(initialMarker.position, [6.1, 125.1]);
  assert.equal(initialMarker.options.zIndexOffset, -100);
  assert.match(initialMarker.popup, /Started: .*8:00:00 AM/);
  assert.equal(
    ensureTrackingDispatchStartMarker("58", acceptedPoint(9)),
    initialMarker,
    "new GPS in the same session must not move or duplicate the Start marker"
  );
  const replacementMarker = ensureTrackingDispatchStartMarker("59", acceptedPoint(0));
  assert.notEqual(replacementMarker, initialMarker);
  assert.deepEqual(removedLayers, [initialMarker]);
  clearTrackingDispatchStartMarker();
  assert.deepEqual(removedLayers, [initialMarker, replacementMarker]);
  delete global.truckMap;
  delete global.L;
  delete global.escapeHtml;

  const startMarker = functionBlock(
    trackingSource,
    "function ensureTrackingDispatchStartMarker",
    "async function renderTrackingRoadMatchedRoute"
  );
  const loader = functionBlock(
    trackingSource,
    "async function loadTruckRoute",
    "async function hydrateSelectedTruckWorkspace"
  );
  const actualRenderer = functionBlock(
    trackingSource,
    "function renderTrackingActualRoute",
    "function clearTrackingRoadMatchRequest"
  );
  const matchedRenderer = functionBlock(
    trackingSource,
    "async function renderTrackingRoadMatchedRoute",
    "function getRoutePointTimestamp"
  );

  assert.doesNotMatch(startMarker, /setLatLng/, "start remains fixed within one selected session");
  assert.match(startMarker, /pane: "dispatchMarkerPane"/);
  assert.match(startMarker, /zIndexOffset: -100/);
  assert.match(startMarker, /formatTrackingTimeSafe/);
  assert.match(loader, /selectedCurrentMarker = updateTruckMarkerWithReliableRoutePoint/,
    "the selected truck must reuse the operational truck marker");
  assert.doesNotMatch(loader, /selectedCurrentMarker = L\.marker/,
    "route refresh must not create a second current-position marker");
  assert.match(trackingSource, /Last reliable point:/);
  assert.match(actualRenderer, /dashArray: "8, 10"/);
  assert.match(actualRenderer, /trackingActualRoutePane/);
  assert.doesNotMatch(matchedRenderer, /dispatchPlannedRoute|dispatchDestination|selectedDispatchTicket/);
  assert.doesNotMatch(dispatchSource, /match\/v1\/driving/, "assigned route logic is not changed into GPS matching");
  assert.equal((dashboardHtml.match(/tracking-legend-dot start/g) || []).length, 1);
}

function testActualRouteRendererKeepsRawGeometryWhenMatchIsUnusable() {
  const mapLayers = [];
  const removedLayers = [];
  const featureGroups = [];
  global.window = { trackingGapPolylines: [] };
  global.truckMap = {
    removeLayer(layer) {
      removedLayers.push(layer);
    }
  };
  global.selectedRoutePolyline = null;
  global.L = {
    featureGroup() {
      const group = {
        layers: [],
        addTo() {
          featureGroups.push(this);
          return this;
        }
      };
      return group;
    },
    polyline(geometry, options) {
      return {
        geometry,
        options,
        addTo(target) {
          if (Array.isArray(target.layers)) target.layers.push(this);
          else mapLayers.push(this);
          return this;
        },
        bindPopup(popup) {
          this.popup = popup;
          return this;
        }
      };
    }
  };

  const points = [
    acceptedPoint(0),
    acceptedPoint(1),
    acceptedPoint(2, 1_100_001),
    acceptedPoint(3, 1_100_001)
  ];
  const group = renderTrackingActualRoute(points, {
    segments: [
      { geometry: [[Number.NaN, 125.1], [6.2, 125.2]] },
      { geometry: [] }
    ]
  });
  assert.equal(group, featureGroups[0]);
  assert.deepEqual(group.layers.filter((line) => !line.options.dashArray).map((line) => line.geometry), [
    [[points[0].lat, points[0].lng], [points[1].lat, points[1].lng]],
    [[points[2].lat, points[2].lng], [points[3].lat, points[3].lng]]
  ]);
  assert.equal(group.layers.filter((line) => line.options.dashArray).length, 1,
    "confirmed GPS gap stays inside the swappable Actual Trail group");
  assert.equal(group.layers.find((line) => line.options.dashArray).options.dashArray, "8, 10");
  assert.equal(mapLayers.length, 0, "Actual Trail children do not accumulate outside their group");

  delete global.window;
  delete global.truckMap;
  delete global.selectedRoutePolyline;
  delete global.L;
}

function testLargeHistoricalRouteProducesVisibleActualTrail() {
  const mapLayers = new Set();
  global.window = { trackingGapPolylines: [] };
  global.selectedRoutePolyline = null;
  global.truckMap = {
    addLayer(layer) {
      mapLayers.add(layer);
    },
    hasLayer(layer) {
      return mapLayers.has(layer) || [...mapLayers].some((group) =>
        Array.isArray(group?.layers) && group.layers.includes(layer)
      );
    },
    removeLayer(layer) {
      mapLayers.delete(layer);
    }
  };
  global.L = {
    featureGroup() {
      return {
        layers: [],
        addTo(map) {
          map.addLayer(this);
          return this;
        },
        getLayers() {
          return this.layers;
        }
      };
    },
    polyline(geometry, options) {
      return {
        geometry,
        options,
        addTo(group) {
          group.layers.push(this);
          return this;
        },
        bindPopup() {
          return this;
        }
      };
    }
  };

  const points = Array.from({ length: 214 }, (_, index) => acceptedPoint(index));
  const group = renderTrackingActualRoute(points);
  assert.equal(group.getLayers().length, 1);
  assert.equal(group.getLayers()[0].geometry.length, 214);
  assert.equal(group.getLayers()[0].options.pane, "trackingActualRoutePane");
  assert.equal(group.getLayers()[0].options.color, "#285a48");
  assert.ok(group.getLayers()[0].options.weight >= 6);
  assert.equal(trackingActualTrailLayerIsVisible(global.truckMap, group), true);

  delete global.window;
  delete global.truckMap;
  delete global.selectedRoutePolyline;
  delete global.L;
}

function testMarkerMovementAndBearingReuse() {
  const calls = [];
  const marker = {
    setLatLng(value) {
      calls.push(value);
    }
  };
  const start = { lat: 6.1, lng: 125.1 };
  const end = { lat: 6.1, lng: 125.1002 };
  const bearing = trackingBearingDegrees(start, end);
  assert.ok(bearing > 89 && bearing < 91, "eastward movement derives an eastward bearing");
  const result = moveTrackingMarker(marker, start, end, {
    durationMs: 800,
    now: () => 0,
    requestFrame(callback) {
      callback(800);
      return 1;
    }
  });
  assert.equal(result.animated, true);
  assert.deepEqual(calls.at(-1), [end.lat, end.lng]);
  assert.equal(trackingBearingDegrees(start, { lat: 6.1, lng: 125.100001 }), null,
    "movement below the bearing threshold preserves the prior heading");

  const loader = functionBlock(
    trackingSource,
    "async function loadTruckRoute",
    "async function hydrateSelectedTruckWorkspace"
  );
  assert.match(loader, /if \(!keepView && routeChanged\)/,
    "five-second keepView polling must not force fitBounds");
  assert.doesNotMatch(loader, /L\.map\(/,
    "marker updates must not recreate the map");
}

function testNavigationDiagnosticsContract() {
  [
    "trackingRawPointCount",
    "trackingAcceptedPointCount",
    "trackingActualSegmentCount",
    "trackingActualLayerVisible",
    "trackingAssignedRoutePointCount",
    "trackingLiveGuideTarget",
    "trackingLiveGuidePointCount",
    "trackingLiveGuideLayerVisible",
    "trackingLiveGuideOrigin",
    "trackingLiveGuideOriginTime",
    "trackingAlternativeRouteCount",
    "trackingAlternativeVisibleCount",
    "trackingLiveGuideReason",
    "trackingLiveGuideTime",
    "trackingLiveGuideRequestStatus",
    "trackingLiveGuideMovedDistance",
    "trackingLiveGuideDistance",
    "trackingCurrentStopStatus"
  ].forEach((id) => {
    assert.equal((dashboardHtml.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `${id} must exist once`);
  });
  const paneOrder = [
    '"dispatchPlannedRoutePane", "420"',
    '"dispatchCompletedRoutePane", "430"',
    '"trackingActualRoutePane", "440"',
    '"dispatchAlternativeRoutePane", "450"',
    '"dispatchCurrentRoutePane", "460"',
    '"dispatchMarkerPane", "650"',
    '"trackingTruckPane", "700"'
  ].map((token) => trackingSource.indexOf(token));
  assert.ok(paneOrder.every((index) => index >= 0));
  assert.deepEqual(paneOrder, [...paneOrder].sort((first, second) => first - second));
}

async function run() {
  await testRawGpsIsNeverMutatedAndMappedCountStaysGpsBased();
  await testContinuousAndConfirmedGapSegmentation();
  testMatchResponseValidationAndUrlContract();
  await testMalformedNetworkAndTimeoutFallbackToRaw();
  await testStaleProtectionAndUnchangedSignatureCache();
  await testLongRouteChunkLimitOverlapAndDeduplication();
  await testGrowingRouteReusesCompletedHistoricalChunks();
  testSessionScopedStartStateAndExistingMapContracts();
  testActualRouteRendererKeepsRawGeometryWhenMatchIsUnusable();
  testLargeHistoricalRouteProducesVisibleActualTrail();
  testMarkerMovementAndBearingReuse();
  testNavigationDiagnosticsContract();
  console.log("trackingRoadMatchDisplay.test.js: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
