const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DISPATCH_WMO_LOCATION,
  DISPATCH_ROUTING_MOVEMENT_METERS,
  DISPATCH_ROUTING_OFF_ROUTE_METERS,
  DISPATCH_ROUTING_OFF_ROUTE_HOLD_MS,
  DISPATCH_TICKET_CREATE_FAILURE_MESSAGE,
  buildDispatchPlannedJourney,
  chooseDispatchSegmentOrientation,
  dispatchCatalogStopFromDetail,
  dispatchCatalogDestinationIsSelected,
  dispatchDistanceToRouteMeters,
  dispatchDraftsInAssignedOrder,
  dispatchManilaOperatingDay,
  dispatchNormalizeTicketNumber,
  dispatchRoutingFailureState,
  dispatchRoutingResponseIsCurrent,
  dispatchRoutingResponsePreservesOrder,
  dispatchSafeTicketErrorMessage,
  dispatchSegmentColor,
  dispatchTicketIsStale,
  dispatchTicketFailureState,
  dispatchWmoStopOrder,
  evaluateDispatchDynamicReroute,
  matchDispatchCatalogCandidateForStop,
  requestDispatchRoadCostMatrix,
  splitDispatchOperationalStops
} = require("../frontend/js/admin/admin-dispatch");

function roadStop(id, clickOrder, geometry) {
  return {
    stop: {
      id,
      stop_order: clickOrder,
      metadata_key: `stop-${id}`,
      location_name: `Road ${id}`,
      latitude: geometry[Math.floor(geometry.length / 2)].latitude,
      longitude: geometry[Math.floor(geometry.length / 2)].longitude,
      stop_status: "pending"
    },
    metadata: { catalog_id: id },
    geometry
  };
}

function pointStop(id, clickOrder, latitude, longitude) {
  return {
    stop: {
      id,
      stop_order: clickOrder,
      metadata_key: `stop-${id}`,
      location_name: `Point ${id}`,
      latitude,
      longitude,
      stop_status: "pending"
    },
    metadata: { catalog_id: id, destination_type: "barangay_hall" },
    geometry: []
  };
}

function keyedRoadCost(costs, fallback = 10000) {
  return (start, end) => {
    if (start.lat === end.lat && start.lng === end.lng) return 0;
    return costs.get(`${start.lat},${start.lng}>${end.lat},${end.lng}`) ?? fallback;
  };
}

function testOrientationHelperDoesNotMutateGeometry() {
  const segment = [
    { latitude: 6.1, longitude: 125.1 },
    { latitude: 6.1, longitude: 125.2 }
  ];
  const reversed = chooseDispatchSegmentOrientation(
    { lat: 6.1, lng: 125.21 },
    { lat: 6.1, lng: 125.09 },
    segment
  );
  assert.equal(reversed[0].longitude, 125.2);
  assert.equal(segment[0].longitude, 125.1);
}

function testManualOrderWinsOverLowerTravelCost() {
  const start = { lat: 6.1, lng: 125.1 };
  const wmo = { lat: 6.5, lng: 125.5 };
  const clickedFirstButExpensive = pointStop(1, 1, 6.2, 125.2);
  const clickedSecondButPractical = pointStop(2, 2, 6.11, 125.11);
  const costs = new Map([
    ["6.1,125.1>6.2,125.2", 900],
    ["6.1,125.1>6.11,125.11", 100],
    ["6.11,125.11>6.2,125.2", 100],
    ["6.2,125.2>6.11,125.11", 700],
    ["6.2,125.2>6.5,125.5", 100],
    ["6.11,125.11>6.5,125.5", 900]
  ]);
  const journey = buildDispatchPlannedJourney(
    start,
    wmo,
    [clickedFirstButExpensive, clickedSecondButPractical],
    { costLookup: keyedRoadCost(costs) }
  );
  assert.deepEqual(journey.plannedStops.map((item) => item.metadata.catalog_id), [1, 2]);
  assert.equal(journey.connectorLegs[0].destination_stop_order, 1);
  assert.equal(journey.connectorLegs.at(-1).is_wmo_return, true);
  assert.deepEqual(journey.connectorLegs.at(-1).end, wmo);
}

function testClosestStopDoesNotMoveAheadOfAssignedOrder() {
  const start = { lat: 6, lng: 125 };
  const wmo = { lat: 6.5, lng: 125.5 };
  const pendatun = pointStop(1, 1, 6.1, 125.1);
  const pioneer = pointStop(2, 2, 6.2, 125.2);
  const santiago = pointStop(3, 3, 6.3, 125.3);
  const joseCatolico = pointStop(4, 4, 6.4, 125.4);
  const costs = new Map([
    ["6,125>6.2,125.2", 10],
    ["6.2,125.2>6.3,125.3", 10],
    ["6.3,125.3>6.1,125.1", 10],
    ["6.1,125.1>6.4,125.4", 10],
    ["6.4,125.4>6.5,125.5", 10]
  ]);
  const journey = buildDispatchPlannedJourney(
    start,
    wmo,
    [pendatun, pioneer, santiago, joseCatolico],
    { costLookup: keyedRoadCost(costs, 10000) }
  );
  assert.deepEqual(
    journey.plannedStops.map((item) => item.metadata.catalog_id),
    [1, 2, 3, 4]
  );
  assert.equal(journey.plannedStops[0].stop.location_name, "Point 1");
  assert.equal(journey.connectorLegs.at(-1).is_wmo_return, true);
}

function testDraftRemovalRenumbersWithoutReordering() {
  const selectedDestinations = [
    { metadata_key: "a", stop_order: 1, location_name: "A" },
    { metadata_key: "c", stop_order: 3, location_name: "C" }
  ];
  const ticketStops = dispatchDraftsInAssignedOrder(selectedDestinations);
  assert.deepEqual(ticketStops.map((stop) => stop.location_name), ["A", "C"]);
  assert.deepEqual(ticketStops.map((stop) => stop.stop_order), [1, 2]);
}

function testTruckPositionCannotReorderAssignment() {
  const wmo = { lat: 6.5, lng: 125.5 };
  const first = pointStop(1, 1, 6.11, 125.11);
  const second = pointStop(2, 2, 6.21, 125.21);
  const fromFirst = buildDispatchPlannedJourney({ lat: 6.1, lng: 125.1 }, wmo, [second, first]);
  const fromSecond = buildDispatchPlannedJourney({ lat: 6.22, lng: 125.22 }, wmo, [first, second]);
  assert.deepEqual(fromFirst.plannedStops.map((item) => item.metadata.catalog_id), [2, 1]);
  assert.deepEqual(fromSecond.plannedStops.map((item) => item.metadata.catalog_id), [1, 2]);
}

function testContinuousJourneyAndFixedWmo() {
  const start = { lat: 6.1, lng: 125.1 };
  const wmo = { lat: DISPATCH_WMO_LOCATION.latitude, lng: DISPATCH_WMO_LOCATION.longitude };
  const selected = [
    roadStop(1, 1, [{ latitude: 6.15, longitude: 125.15 }, { latitude: 6.16, longitude: 125.16 }]),
    pointStop(5, 2, 6.12, 125.12),
    roadStop(2, 3, [{ latitude: 6.13, longitude: 125.13 }, { latitude: 6.14, longitude: 125.14 }]),
    roadStop(3, 4, [{ latitude: 6.17, longitude: 125.17 }, { latitude: 6.18, longitude: 125.18 }])
  ];
  const journey = buildDispatchPlannedJourney(start, wmo, selected);
  assert.equal(journey.plannedStops.length, 4);
  assert.equal(journey.connectorLegs.length, 5);
  assert.equal(journey.orderedLegs.length, 9);
  journey.plannedStops.forEach((stop, index) => {
    assert.deepEqual(journey.connectorLegs[index].end, stop.geometry[0]);
    if (index) assert.deepEqual(journey.connectorLegs[index].start, journey.plannedStops[index - 1].geometry.at(-1));
  });
  assert.deepEqual(journey.connectorLegs.at(-1).end, wmo);
}

function testRoadOrientationUsesApproachAndDepartureCosts() {
  const start = { lat: 6.1, lng: 125.1 };
  const wmo = { lat: 6.4, lng: 125.4 };
  const road = roadStop(1, 1, [
    { latitude: 6.2, longitude: 125.2 },
    { latitude: 6.3, longitude: 125.3 }
  ]);
  const costs = new Map([
    ["6.1,125.1>6.2,125.2", 800],
    ["6.1,125.1>6.3,125.3", 100],
    ["6.3,125.3>6.4,125.4", 800],
    ["6.2,125.2>6.4,125.4", 100]
  ]);
  const journey = buildDispatchPlannedJourney(start, wmo, [road], {
    costLookup: keyedRoadCost(costs)
  });
  assert.equal(journey.plannedStops[0].orientation, "reverse");
  assert.equal(road.geometry[0].latitude, 6.2, "stored geometry must remain unchanged");
}

function testCompletedCurrentRemainingAndSkippedPartition() {
  const stops = [
    { id: 1, stop_order: 2, stop_status: "completed", completed_at: "2026-08-02T02:00:00Z" },
    { id: 2, stop_order: 1, stop_status: "completed", completed_at: "2026-08-02T01:00:00Z" },
    { id: 3, stop_order: 3, stop_status: "on_the_way" },
    { id: 4, stop_order: 4, stop_status: "pending" },
    { id: 5, stop_order: 5, stop_status: "skipped" }
  ];
  const groups = splitDispatchOperationalStops(stops);
  assert.deepEqual(groups.completedStops.map((stop) => stop.id), [2, 1]);
  assert.equal(groups.currentStop.id, 3);
  assert.deepEqual(groups.remainingStops.map((stop) => stop.id), [4]);
  assert.deepEqual(groups.skippedStops.map((stop) => stop.id), [5]);
}

function testActiveRouteKeepsEveryPersistedStopInOrder() {
  const start = { lat: 6.1, lng: 125.1 };
  const wmo = { lat: 6.5, lng: 125.5 };
  const current = pointStop(10, 1, 6.3, 125.3);
  const far = pointStop(11, 2, 6.4, 125.4);
  const nearAfterCurrent = pointStop(12, 3, 6.31, 125.31);
  const journey = buildDispatchPlannedJourney(start, wmo, [current, far, nearAfterCurrent], {
    lockedPrefixCount: 1
  });
  assert.deepEqual(journey.plannedStops.map((item) => item.metadata.catalog_id), [10, 11, 12]);
}

function testDynamicRerouteThresholdsAndJitterProtection() {
  const route = [{ lat: 6.1, lng: 125.1 }, { lat: 6.1, lng: 125.2 }];
  const lastStart = { lat: 6.1, lng: 125.1 };
  const jitter = evaluateDispatchDynamicReroute({ lat: 6.1001, lng: 125.1 }, "same", {
    lastSignature: "same", lastStart, routeCoordinates: route, now: 1000
  });
  assert.equal(jitter.shouldReroute, false);
  const moved = evaluateDispatchDynamicReroute({ lat: 6.1006, lng: 125.1 }, "same", {
    lastSignature: "same", lastStart, routeCoordinates: route, now: 1000
  });
  assert.equal(moved.shouldReroute, true);
  assert.equal(moved.reason, "truck_moved");
  assert.equal(DISPATCH_ROUTING_MOVEMENT_METERS, 50);
}

function testSustainedOffRouteTrigger() {
  const route = [{ lat: 6.1, lng: 125.1 }, { lat: 6.1, lng: 125.2 }];
  const offRoutePoint = { lat: 6.10042, lng: 125.15 };
  assert.ok(dispatchDistanceToRouteMeters(offRoutePoint, route) >= DISPATCH_ROUTING_OFF_ROUTE_METERS);
  const pending = evaluateDispatchDynamicReroute(offRoutePoint, "same", {
    lastSignature: "same",
    lastStart: offRoutePoint,
    routeCoordinates: route,
    now: 1000,
    offRouteSince: null
  });
  assert.equal(pending.shouldReroute, false);
  const sustained = evaluateDispatchDynamicReroute(offRoutePoint, "same", {
    lastSignature: "same",
    lastStart: offRoutePoint,
    routeCoordinates: route,
    now: 1000 + DISPATCH_ROUTING_OFF_ROUTE_HOLD_MS,
    offRouteSince: pending.offRouteSince
  });
  assert.equal(sustained.shouldReroute, true);
  assert.equal(sustained.reason, "sustained_off_route");
}

async function testRoadCostMatrixUsesExistingOsrmProvider() {
  let requestedUrl = "";
  const points = [
    { lat: 6.701001, lng: 125.701001 },
    { lat: 6.702002, lng: 125.702002 },
    { lat: 6.703003, lng: 125.703003 }
  ];
  const lookup = await requestDispatchRoadCostMatrix(points, new AbortController().signal, {
    fetchImplementation: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ distances: [[0, 10, 20], [11, 0, 12], [21, 13, 0]] })
      };
    }
  });
  assert.match(requestedUrl, /router\.project-osrm\.org\/table\/v1\/driving/);
  assert.equal(lookup(points[0], points[1]), 10);
}

function testCatalogSelectionAndDetailConversion() {
  const metadata = new Map([["stop-1", { catalog_id: 42 }]]);
  assert.equal(dispatchCatalogDestinationIsSelected("42", metadata), true);
  const stop = dispatchCatalogStopFromDetail({
    destination: {
      id: 71, destination_type: "road_segment", name: "Pendatun Avenue",
      display_label: "Pendatun Avenue", barangay: null,
      latitude: 6.115, longitude: 125.17, is_verified: true
    },
    points: [
      { point_order: 1, point_type: "entry", latitude: 6.11, longitude: 125.16 },
      { point_order: 2, point_type: "exit", latitude: 6.12, longitude: 125.18 }
    ]
  }, 1);
  assert.equal(stop.catalog_id, 71);
  assert.equal(stop.geometry_segments[0].length, 2);
}

function testPersistedRoadStopRehydratesOnlyTheMatchingCatalogComponent() {
  const stop = {
    location_name: "1st Street - Section 2",
    latitude: 6.11,
    longitude: 125.18
  };
  const candidates = [
    {
      id: 1,
      display_label: "1st Street - Section 2",
      latitude: 6.2,
      longitude: 125.3
    },
    {
      id: 2,
      display_label: "1st Street - Section 2",
      latitude: 6.11001,
      longitude: 125.18001
    },
    {
      id: 3,
      display_label: "1st Street - Section 1",
      latitude: 6.11,
      longitude: 125.18
    }
  ];
  assert.equal(matchDispatchCatalogCandidateForStop(stop, candidates)?.id, 2);
  assert.equal(matchDispatchCatalogCandidateForStop(stop, [candidates[0]]), null);
}

function testFailureStateStaleResponsesAndActualGpsIndependence() {
  assert.deepEqual(dispatchRoutingFailureState(), {
    message: "Route preview unavailable. The last route is still displayed.",
    preserveSelectedStops: true,
    preservePreviousRoute: true,
    drawStraightFallback: false
  });
  const layer = {};
  assert.equal(dispatchRoutingResponseIsCurrent(4, layer, 4, layer), true);
  assert.equal(dispatchRoutingResponseIsCurrent(3, layer, 4, layer), false);
  const source = fs.readFileSync(
    path.join(__dirname, "..", "frontend", "js", "admin", "admin-dispatch.js"),
    "utf8"
  );
  const clearFunction = source.match(/function clearDispatchPlannedRoute\([^)]*\)[\s\S]*?function createDispatchPlannedLayerGroups/);
  const ticketDetailsFunction = source.match(/function renderDispatchTicketDetails\(details\)[\s\S]*?function openDispatchModal/);
  assert.ok(clearFunction);
  assert.ok(ticketDetailsFunction);
  assert.doesNotMatch(clearFunction[0], /selectedRoutePolyline/);
  assert.doesNotMatch(ticketDetailsFunction[0], /dispatchEscape\(stop\.latitude\)|dispatchEscape\(stop\.longitude\)/);
  assert.match(source, /activateDispatchPlannedLayerGroups\(layers\)[\s\S]*dispatchLastSuccessfulRouteState = \{ journey, originSource:/);
  assert.match(source, /if \(dispatchHasVisiblePlannedRoute\(\)\) return;/);
  assert.match(source, /const routeSnapshot = captureDispatchRoutePreviewState\(\)/);
  assert.match(source, /catch \(error\) \{[\s\S]*restoreDispatchRoutePreviewState\(routeSnapshot\)/);
  assert.deepEqual(dispatchTicketFailureState(), {
    message: DISPATCH_TICKET_CREATE_FAILURE_MESSAGE,
    preserveSelectedStops: true,
    preserveOptimizedOrder: true,
    preservePreviousRoute: true
  });
  assert.equal(
    dispatchSafeTicketErrorMessage({
      status: 500,
      message: "You have an error in your SQL syntax near last_value"
    }),
    DISPATCH_TICKET_CREATE_FAILURE_MESSAGE
  );
}

function testOperatingDateAndRecordFiltersAreNotClientControlled() {
  assert.equal(
    dispatchManilaOperatingDay(new Date("2026-08-02T16:01:00.000Z")),
    "2026-08-03"
  );
  const source = fs.readFileSync(
    path.join(__dirname, "..", "frontend", "js", "admin", "admin-dispatch.js"),
    "utf8"
  );
  const dashboard = fs.readFileSync(
    path.join(__dirname, "..", "frontend", "admin-dashboard.html"),
    "utf8"
  );
  const recordsMarkup = dashboard.match(/<section class="tracking-workspace-view" data-tracking-workspace-view="records"[\s\S]*?<\/section>/)?.[0] || "";
  const collectForm = source.match(/function collectDispatchTicketForm\(\)[\s\S]*?function resetDispatchTicketForm/)?.[0] || "";
  assert.doesNotMatch(recordsMarkup, /type="date"|dispatchTicketDateFilter/);
  assert.match(recordsMarkup, /Dispatch Tickets/i);
  assert.match(recordsMarkup, /Review saved and issued dispatch tickets\./);
  assert.match(recordsMarkup, /dispatchTicketClearFiltersBtn/);
  assert.doesNotMatch(recordsMarkup, /Active Tickets|Prepared Tickets|Completed \/ Cancelled/);
  assert.doesNotMatch(collectForm, /dispatch_date|dispatchDate/);
}

function testStaleDispatchWarningDoesNotChangeLifecycle() {
  const now = new Date("2026-08-13T10:00:00.000Z").getTime();
  assert.equal(
    dispatchTicketIsStale({ actual_start_at: "2026-08-12T09:00:00.000Z" }, now),
    true
  );
  assert.equal(
    dispatchTicketIsStale({ actual_start_at: "2026-08-13T09:00:00.000Z" }, now),
    false
  );
  assert.equal(dispatchTicketIsStale({}, now), false);
}

function testGeneratedTicketNumberAndUnifiedTicketsWorkflow() {
  assert.equal(dispatchNormalizeTicketNumber("  000042  "), "000042");
  assert.equal(dispatchNormalizeTicketNumber("   "), "");

  const source = fs.readFileSync(
    path.join(__dirname, "..", "frontend", "js", "admin", "admin-dispatch.js"),
    "utf8"
  );
  const trackingSource = fs.readFileSync(
    path.join(__dirname, "..", "frontend", "js", "admin", "admin-tracking.js"),
    "utf8"
  );
  const dashboard = fs.readFileSync(
    path.join(__dirname, "..", "frontend", "admin-dashboard.html"),
    "utf8"
  );
  const plannerForm = dashboard.match(/<form id="dispatchTicketForm"[\s\S]*?<\/form>/)?.[0] || "";
  const recordsMarkup = dashboard.match(/data-tracking-workspace-view="records"[\s\S]*?<\/section>/)?.[0] || "";
  const selectedTruckHeader = dashboard.match(/id="dispatchSelectedTruckSummary"[\s\S]*?dispatch-workspace-actions/)?.[0] || "";
  const activeTruckRenderer = trackingSource.match(/function renderActiveTruckList\(trucks\)[\s\S]*?function updateTruckMarkers/)?.[0] || "";
  const recordRenderer = source.match(/function renderDispatchRecordCards[\s\S]*?async function loadDispatchTickets/)?.[0] || "";
  const ticketDetailsRenderer = source.match(/function renderDispatchTicketDetails\(details\)[\s\S]*?function openDispatchModal/)?.[0] || "";
  const ticketDetailsModalRenderer = source.match(/function renderDispatchTicketDetailsModal\(details\)[\s\S]*?function renderDispatchTicketDetails/)?.[0] || "";
  const collectForm = source.match(/function collectDispatchTicketForm\(\)[\s\S]*?function resetDispatchTicketForm/)?.[0] || "";

  assert.match(plannerForm, /<input type="hidden" id="dispatchTicketNumber"/);
  assert.match(plannerForm, /id="dispatchGeneratedTicketNumber">Auto-generated</);
  assert.match(plannerForm, /Generated automatically when dispatch is finalized\./);
  assert.doesNotMatch(plannerForm, /type="text" id="dispatchTicketNumber"/);
  assert.match(plannerForm, /id="dispatchDestinationControls"[^>]*disabled/);
  assert.ok(
    plannerForm.indexOf("dispatchTicketNumber") < plannerForm.indexOf("dispatchAddDestinationsHeading")
  );
  assert.doesNotMatch(plannerForm, /type="date"|dispatchExpectedReturn/);
  assert.match(plannerForm, /type="hidden" id="dispatchTruckId"/);
  assert.match(plannerForm, /type="hidden" id="dispatchRouteName"/);
  assert.doesNotMatch(selectedTruckHeader, /Personnel|dispatchSelectedPersonnelLabel/);
  assert.doesNotMatch(activeTruckRenderer, /personnelName|truck-personnel|enforcer_name/);

  assert.deepEqual(
    [...dashboard.matchAll(/data-dispatch-workspace-action="([^"]+)"/g)].map((match) => match[1]),
    ["plan", "tickets"]
  );
  assert.doesNotMatch(recordsMarkup, /data-dispatch-record-tab|dispatchReportsList|Personnel/i);
  assert.match(recordsMarkup, /id="dispatchTicketSearch" placeholder="Ticket Number"/);
  assert.match(recordsMarkup, /id="dispatchTicketTruckFilter" placeholder="Truck Number"/);
  assert.match(recordsMarkup, /id="dispatchTicketsList"/);
  assert.match(dashboard, /id="openTrackingReportsBtn"/);
  assert.match(source, /getElementById\("openTrackingReportsBtn"\)[\s\S]*openDispatchReportsModal/);
  assert.match(dashboard, />\s*Dispatch Reports\s*</i);
  assert.match(dashboard, /id="dispatchReportsModal"/);
  assert.match(dashboard, /id="dispatchReportModal"/);

  assert.match(source, /destinationControls\.disabled = !destinationsEnabled/);
  assert.doesNotMatch(source, /dispatchPlannerFinalizationState\([\s\S]*ticketNumberValid/);
  assert.doesNotMatch(collectForm, /ticket_number:/);
  assert.match(collectForm, /tracking_session_id:/);
  assert.match(source, /getElementById\("dispatchTruckId"\)\.value = truck\.truck_id/);
  assert.doesNotMatch(recordRenderer, /assigned_personnel|personnel/i);
  assert.doesNotMatch(ticketDetailsRenderer, /assigned_personnel_name|Personnel/);
  assert.match(ticketDetailsModalRenderer, /assigned_personnel_name/);
  assert.match(recordRenderer, /View Details/);
  assert.match(recordRenderer, /ticket\.issued_at \|\| ticket\.created_at/);
}

function testFocusedTwoStepPlannerAndLiveMonitor() {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "frontend", "js", "admin", "admin-dispatch.js"),
    "utf8"
  );
  const trackingSource = fs.readFileSync(
    path.join(__dirname, "..", "frontend", "js", "admin", "admin-tracking.js"),
    "utf8"
  );
  const dashboard = fs.readFileSync(
    path.join(__dirname, "..", "frontend", "admin-dashboard.html"),
    "utf8"
  );
  const css = fs.readFileSync(
    path.join(__dirname, "..", "frontend", "css", "admin", "admin-dispatch.css"),
    "utf8"
  );
  const stepOne = dashboard.slice(
    dashboard.indexOf('data-dispatch-step-panel="1"'),
    dashboard.indexOf('data-dispatch-step-panel="2"')
  );
  const stepTwo = dashboard.slice(
    dashboard.indexOf('data-dispatch-step-panel="2"'),
    dashboard.indexOf('id="dispatchCurrentPanel"')
  );
  const stepTransition = source.match(/function setDispatchPlannerStep[\s\S]*?function openDispatchPlannerDrawer/)?.[0] || "";
  const workspaceTransition = source.match(/function setDispatchWorkspaceTab[\s\S]*?function dispatchPlannerHasUnsavedRoute/)?.[0] || "";
  const liveRenderer = source.match(/function renderDispatchTicketDetails\(details\)[\s\S]*?function openDispatchModal/)?.[0] || "";
  const trackingSection = dashboard.slice(
    dashboard.indexOf('<section id="trackingSection"'),
    dashboard.indexOf('<!-- USER MANAGEMENT -->')
  );

  assert.equal([...dashboard.matchAll(/data-dispatch-step-panel="[123]"/g)].length, 2);
  assert.match(stepOne, /dispatchTicketNumber/);
  assert.match(stepOne, /ticket number will be generated securely by the backend\./i);
  assert.doesNotMatch(stepOne, /dispatchDestinationSearch|dispatchOptimizedRouteList|dispatchCurrentPanel/);
  assert.match(stepTwo, /dispatchDestinationSearch/);
  assert.match(stepTwo, /dispatchStopRows/);
  assert.match(stepTwo, /Stops will be visited in the order shown below\./);
  assert.match(stepTwo, /dispatchOptimizedRouteList|Return to WMO/);
  assert.doesNotMatch(dashboard, /data-dispatch-step-panel="3"|Review Route/);
  assert.match(dashboard, /id="dispatchStepContinueBtn"/);
  assert.match(dashboard, /id="dispatchStepBackBtn"/);
  assert.match(dashboard, /id="dispatchNowBtn"[^>]*>Done</);
  assert.match(dashboard, /id="dispatchUpdateStopStatusBtn"/);
  assert.match(dashboard, /id="dispatchViewActiveRouteBtn"/);
  assert.ok(dashboard.indexOf("dispatch-inline-form-actions") > dashboard.indexOf("dispatch-step-viewport"));
  assert.doesNotMatch(stepTransition, /resetDispatchTicketForm|clearDispatchPlannedRoute/);
  assert.doesNotMatch(workspaceTransition, /resetDispatchTicketForm|clearDispatchPlannedRoute/);
  assert.match(liveRenderer, /dispatchStopActionSheet[\s\S]*hidden/);
  assert.match(liveRenderer, /Mark Arrived/);
  assert.match(liveRenderer, /Complete Stop/);
  assert.match(liveRenderer, /Skip Stop/);
  assert.equal((dashboard.match(/id="dispatchViewTicketDetailsBtn"/g) || []).length, 1);
  assert.doesNotMatch(liveRenderer, /Tracking links|Expected return|dispatch-event-list/);
  assert.match(source, /restoreDispatchRoutePreviewState\(routeSnapshot\)/);
  assert.match(source, /dispatchHasVisiblePlannedRoute\(\)/);
  assert.doesNotMatch(workspaceTransition, /removeLayer|dispatchPlannedLayerGroup\s*=\s*null/);
  assert.match(trackingSource, /hydrateSelectedTruckWorkspace\(selectedSessionId, \{ keepView: true \}\)/);
  assert.doesNotMatch(trackingSection, /onclick=/);
  assert.match(css, /grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
  assert.match(css, /grid-template-rows:\s*minmax\(0, 1fr\) var\(--dispatch-action-footer-height\)/);
  assert.match(css, /\.dispatch-inline-planner\.is-live-dispatch \.dispatch-inline-form-actions[\s\S]*height:\s*var\(--dispatch-action-footer-height\)/);
  assert.match(css, /\.dispatch-live-monitor[\s\S]*overflow-y:\s*auto/);
  assert.match(liveRenderer, /dispatchLiveRouteState/);
  assert.match(liveRenderer, /dispatch-live-route-preview[\s\S]*Next[\s\S]*Final/);
  assert.match(css, /@media \(min-width: 993px\) and \(max-width: 1280px\)/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /overflow-x|overflow:\s*hidden/);
}

function testRoutingResponseOrderAndUiRequirements() {
  const start = { lat: 6.1, lng: 125.1 };
  const end = { lat: 6.2, lng: 125.2 };
  assert.equal(dispatchRoutingResponsePreservesOrder(start, end, [
    [6.1001, 125.1001], [6.1999, 125.1999]
  ]), true);
  assert.equal(dispatchRoutingResponsePreservesOrder(start, end, [
    [6.1999, 125.1999], [6.1001, 125.1001]
  ]), false);
  const source = fs.readFileSync(
    path.join(__dirname, "..", "frontend", "js", "admin", "admin-dispatch.js"),
    "utf8"
  );
  const dashboard = fs.readFileSync(
    path.join(__dirname, "..", "frontend", "admin-dashboard.html"),
    "utf8"
  );
  assert.match(source, /route\/v1\/driving/);
  assert.match(source, /table\/v1\/driving/);
  assert.doesNotMatch(source, /trip\/v1/);
  assert.match(source, /DISPATCH_BROWSE_DESTINATION_BATCH_SIZE = 20/);
  assert.match(source, /label: "Selected"/);
  assert.doesNotMatch(source, /data-dispatch-stop-move=/);
  assert.match(dashboard, /Selected Route/i);
  assert.match(dashboard, /Stops will be visited in the order shown below\./i);
  const draftRenderer = source.match(/function renderDispatchDraftOnLiveMap[\s\S]*?function dispatchCatalogStopFromDetail/)?.[0] || "";
  const activeRenderer = source.match(/function renderDispatchPlannedRoute[\s\S]*?function dispatchEventLabel/)?.[0] || "";
  assert.doesNotMatch(draftRenderer, /requestDispatchRoadCostMatrix/);
  assert.doesNotMatch(activeRenderer, /requestDispatchRoadCostMatrix/);
  assert.doesNotMatch(draftRenderer, /applyDispatchOptimizedDraftOrder/);
  assert.match(dashboard, /Return to WMO/);
  assert.equal(dispatchWmoStopOrder(4), 5);
  assert.equal(dispatchSegmentColor({ stop_status: "completed" }, false), "#2e8b57");
  assert.equal(dispatchSegmentColor({ stop_status: "skipped" }, false), "#c44747");
}

async function run() {
  testOrientationHelperDoesNotMutateGeometry();
  testManualOrderWinsOverLowerTravelCost();
  testClosestStopDoesNotMoveAheadOfAssignedOrder();
  testDraftRemovalRenumbersWithoutReordering();
  testTruckPositionCannotReorderAssignment();
  testContinuousJourneyAndFixedWmo();
  testRoadOrientationUsesApproachAndDepartureCosts();
  testCompletedCurrentRemainingAndSkippedPartition();
  testActiveRouteKeepsEveryPersistedStopInOrder();
  testDynamicRerouteThresholdsAndJitterProtection();
  testSustainedOffRouteTrigger();
  await testRoadCostMatrixUsesExistingOsrmProvider();
  testCatalogSelectionAndDetailConversion();
  testPersistedRoadStopRehydratesOnlyTheMatchingCatalogComponent();
  testFailureStateStaleResponsesAndActualGpsIndependence();
  testOperatingDateAndRecordFiltersAreNotClientControlled();
  testStaleDispatchWarningDoesNotChangeLifecycle();
  testGeneratedTicketNumberAndUnifiedTicketsWorkflow();
  testFocusedTwoStepPlannerAndLiveMonitor();
  testRoutingResponseOrderAndUiRequirements();
  assert.deepEqual(DISPATCH_WMO_LOCATION, {
    latitude: 6.1060875,
    longitude: 125.1816406,
    radiusMeters: 100
  });
  console.log("Dispatch assigned-order route tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
