const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const projectRoot = path.join(__dirname, "..");
const originalModuleLoad = Module._load;
Module._load = function loadWithMockedDispatchPool(request, parent, isMain) {
  if (
    request === "../config/dbPromise" &&
    parent?.filename.replace(/\\/g, "/").endsWith("services/dispatchService.js")
  ) {
    return {};
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const dispatchModule = require("../services/dispatchService");
const {
  DispatchService,
  DISPATCH_PLANNED_ROUTE_MAX_BYTES,
  DISPATCH_PLANNED_ROUTE_MAX_POINTS,
  dispatchPlannedRouteStopSignature: backendStopSignature,
  normalizeDispatchPlannedRouteSnapshot,
  storedDispatchPlannedRouteSnapshot
} = dispatchModule;
Module._load = originalModuleLoad;

const {
  buildDispatchIssuePlannedRouteSnapshot,
  dispatchPlannedRouteStopSignature: frontendStopSignature,
  dispatchReportPlannedPoints
} = require("../frontend/js/admin/admin-dispatch");

const stops = [
  { stop_order: 1, latitude: 6.11483642979854, longitude: 125.170284877666 },
  { stop_order: 2, latitude: 6.07322672, longitude: 125.14017154 }
];
const routeCoordinates = [
  { lat: 6.1060875, lng: 125.1816406 },
  { lat: 6.1148364, lng: 125.1702849 },
  { lat: 6.0732267, lng: 125.1401715 },
  { lat: 6.1060875, lng: 125.1816406 }
];

function frontendSnapshotOptions(overrides = {}) {
  const currentSignature = "draft:TRUCK-9:58:wmo:6.10609,125.18164:stops:wmo:6.10609,125.18164";
  return {
    readiness: {
      routeReady: true,
      routePreparing: false,
      currentSignature
    },
    routeState: {
      assignmentSignature: currentSignature,
      routeContext: "TRUCK-9:58"
    },
    routeCoordinates,
    distanceMeters: 12750.4,
    stops,
    truckId: "TRUCK-9",
    trackingSessionId: 58,
    ...overrides
  };
}

function validClientSnapshot() {
  return buildDispatchIssuePlannedRouteSnapshot(frontendSnapshotOptions());
}

function validStoredSnapshot() {
  return normalizeDispatchPlannedRouteSnapshot(validClientSnapshot(), {
    capturedAt: "2026-08-27T01:02:03.000Z"
  });
}

function testFrontendCaptureAndCoordinateOrder() {
  assert.equal(frontendStopSignature(stops), backendStopSignature(stops));
  const sourceCoordinates = routeCoordinates.map((point) => ({ ...point }));
  const snapshot = buildDispatchIssuePlannedRouteSnapshot(
    frontendSnapshotOptions({ routeCoordinates: sourceCoordinates })
  );
  assert.deepEqual(snapshot.geometry.coordinates[0], [125.1816406, 6.1060875]);
  assert.deepEqual(snapshot.geometry.coordinates[1], [125.1702849, 6.1148364]);
  assert.equal(snapshot.source, "osrm");
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.truck_id, "TRUCK-9");
  assert.equal(snapshot.tracking_session_id, 58);

  sourceCoordinates[0].lat = 80;
  sourceCoordinates.push({ lat: 1, lng: 1 });
  assert.deepEqual(
    snapshot.geometry.coordinates[0],
    [125.1816406, 6.1060875],
    "later live-route mutation must not change the issue snapshot"
  );
  assert.equal(snapshot.geometry.coordinates.length, 4);
}

function testFrontendRejectsStaleWrongTruckAndMalformedRoutes() {
  assert.throws(
    () => buildDispatchIssuePlannedRouteSnapshot(frontendSnapshotOptions({
      routeState: {
        assignmentSignature: "older-route",
        routeContext: "TRUCK-9:58"
      }
    })),
    /route is stale/i
  );
  assert.throws(
    () => buildDispatchIssuePlannedRouteSnapshot(frontendSnapshotOptions({
      truckId: "TRUCK-10"
    })),
    /does not match the selected truck session/i
  );
  assert.throws(
    () => buildDispatchIssuePlannedRouteSnapshot(frontendSnapshotOptions({
      routeCoordinates: [{ lat: 91, lng: 125 }, { lat: 6, lng: 125 }]
    })),
    /latitude 1 is invalid/i
  );
  assert.throws(
    () => buildDispatchIssuePlannedRouteSnapshot(frontendSnapshotOptions({
      routeCoordinates: [{ lat: null, lng: 125 }, { lat: 6, lng: 125 }]
    })),
    /latitude 1 is invalid/i
  );
  assert.throws(
    () => buildDispatchIssuePlannedRouteSnapshot(frontendSnapshotOptions({
      routeCoordinates: Array.from(
        { length: DISPATCH_PLANNED_ROUTE_MAX_POINTS + 1 },
        () => ({ lat: 6.1, lng: 125.1 })
      )
    })),
    /exceeds 10000 coordinates/i
  );
}

function testBackendValidationAndStoredProjection() {
  const stored = validStoredSnapshot();
  assert.equal(stored.captured_at, "2026-08-27T01:02:03.000Z");
  assert.deepEqual(
    storedDispatchPlannedRouteSnapshot(JSON.stringify({ planned_route: stored })),
    stored
  );
  assert.equal(storedDispatchPlannedRouteSnapshot("not json"), null);
  assert.equal(
    storedDispatchPlannedRouteSnapshot({ planned_route: { geometry: null } }),
    null
  );

  const badLatitude = validClientSnapshot();
  badLatitude.geometry.coordinates[0][1] = 91;
  assert.throws(
    () => normalizeDispatchPlannedRouteSnapshot(badLatitude, { capturedAt: new Date() }),
    (error) => error.code === "DISPATCH_PLANNED_ROUTE_INVALID" && /latitude 1/i.test(error.message)
  );

  const stringCoordinate = validClientSnapshot();
  stringCoordinate.geometry.coordinates[0][0] = "125.1816406";
  assert.throws(
    () => normalizeDispatchPlannedRouteSnapshot(stringCoordinate, { capturedAt: new Date() }),
    /longitude 1/i
  );

  const tooMany = validClientSnapshot();
  tooMany.geometry.coordinates = Array.from(
    { length: DISPATCH_PLANNED_ROUTE_MAX_POINTS + 1 },
    () => [125.1, 6.1]
  );
  assert.throws(
    () => normalizeDispatchPlannedRouteSnapshot(tooMany, { capturedAt: new Date() }),
    /exceeds 10000 coordinates/i
  );

  const tooLarge = validClientSnapshot();
  tooLarge.untrusted_padding = "x".repeat(DISPATCH_PLANNED_ROUTE_MAX_BYTES);
  assert.throws(
    () => normalizeDispatchPlannedRouteSnapshot(tooLarge, { capturedAt: new Date() }),
    /exceeds 524288 bytes/i
  );
}

function createIssueHarness(options = {}) {
  const state = {
    status: options.status || "prepared",
    updateCount: 0,
    rollbackCount: 0,
    commitCount: 0,
    eventDetails: []
  };
  const connection = {
    async beginTransaction() {},
    async commit() { state.commitCount += 1; },
    async rollback() { state.rollbackCount += 1; },
    release() {},
    async query(sql, parameters = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT stop_order, latitude, longitude")) {
        return [[...stops]];
      }
      if (normalized.startsWith("UPDATE dispatch_tickets")) {
        state.updateCount += 1;
        state.status = "dispatched";
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith("INSERT INTO dispatch_events")) {
        if (options.failEventInsert) {
          throw new Error("simulated event persistence failure");
        }
        state.eventDetails.push(parameters[12] ? JSON.parse(parameters[12]) : null);
        return [{ insertId: state.eventDetails.length }];
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    }
  };
  const service = new DispatchService(
    { async getConnection() { return connection; } },
    { now: () => new Date("2026-08-27T01:02:03.000Z") }
  );
  service.getTicketAfterTruckDispatchLock = async () => ({
    id: 91,
    status: state.status,
    truck_id: "TRUCK-9"
  });
  service.assertTruckHasNoOtherNonTerminalDispatch = async () => {};
  service.getTicketDetails = async () => ({
    ticket: { id: 91, status: state.status },
    stops,
    tracking_sessions: [],
    events: []
  });
  return { service, state };
}

async function testIssueSnapshotFailureRollsBackTransaction() {
  const { service, state } = createIssueHarness({ failEventInsert: true });
  await assert.rejects(
    () => service.issueTicket(91, { planned_route_snapshot: validClientSnapshot() }),
    /simulated event persistence failure/i
  );
  assert.equal(state.commitCount, 0);
  assert.equal(state.rollbackCount, 1);
  assert.equal(state.eventDetails.length, 0);
}

async function testIssueTransactionPersistenceAndIdempotency() {
  const { service, state } = createIssueHarness();
  await service.issueTicket(91, { planned_route_snapshot: validClientSnapshot() });
  assert.equal(state.updateCount, 1);
  assert.equal(state.eventDetails.length, 1);
  assert.deepEqual(state.eventDetails[0].planned_route, validStoredSnapshot());
  assert.equal(state.commitCount, 1);

  const replacement = validClientSnapshot();
  replacement.geometry.coordinates[1] = [125.5, 6.5];
  await service.issueTicket(91, { planned_route_snapshot: replacement });
  assert.equal(state.updateCount, 1, "duplicate issuance must not update the ticket again");
  assert.equal(state.eventDetails.length, 1, "duplicate issuance must keep one issue event");
  assert.deepEqual(
    state.eventDetails[0].planned_route,
    validStoredSnapshot(),
    "duplicate issuance must not replace the original snapshot"
  );
}

async function testIssueIdentityValidationAndLegacyCompatibility() {
  const wrongStopsHarness = createIssueHarness();
  const wrongStopsSnapshot = validClientSnapshot();
  wrongStopsSnapshot.stop_signature = "v1|1:0.000000,0.000000";
  await assert.rejects(
    () => wrongStopsHarness.service.issueTicket(91, {
      planned_route_snapshot: wrongStopsSnapshot
    }),
    (error) => error.code === "DISPATCH_PLANNED_ROUTE_INVALID"
  );
  assert.equal(wrongStopsHarness.state.updateCount, 0);
  assert.equal(wrongStopsHarness.state.eventDetails.length, 0);
  assert.equal(wrongStopsHarness.state.rollbackCount, 1);

  const wrongTruckHarness = createIssueHarness();
  const wrongTruckSnapshot = validClientSnapshot();
  wrongTruckSnapshot.truck_id = "TRUCK-10";
  await assert.rejects(
    () => wrongTruckHarness.service.issueTicket(91, {
      planned_route_snapshot: wrongTruckSnapshot
    }),
    /no longer matches the prepared ticket truck/i
  );
  assert.equal(wrongTruckHarness.state.updateCount, 0);

  const legacyHarness = createIssueHarness();
  await legacyHarness.service.issueTicket(91, {});
  assert.equal(legacyHarness.state.updateCount, 1);
  assert.deepEqual(legacyHarness.state.eventDetails, [null]);
}

async function reportWith(status, events) {
  const service = new DispatchService({});
  service.getTicketDetails = async () => ({
    ticket: {
      id: 91,
      status,
      actual_start_at: "2026-08-27T01:00:00.000Z",
      actual_end_at: "2026-08-27T02:00:00.000Z"
    },
    stops: [],
    tracking_sessions: [],
    events,
    progress: { total_stops: 0, completed_stops: 0, skipped_stops: 0 }
  });
  return service.getReportDetails(91);
}

async function testCompletedClosedEarlyAndLegacyReports() {
  const stored = validStoredSnapshot();
  const issued = {
    id: 1,
    event_type: "ticket_issued",
    event_at: stored.captured_at,
    details: JSON.stringify({ planned_route: stored })
  };
  const completed = await reportWith("completed", [issued]);
  assert.deepEqual(completed.planned_route_snapshot, stored);

  const closed = await reportWith("cancelled", [
    issued,
    {
      id: 2,
      event_type: "dispatch_closed_early",
      event_at: "2026-08-27T02:00:00.000Z",
      details: JSON.stringify({ reason: "Mechanical issue" })
    }
  ]);
  assert.deepEqual(closed.planned_route_snapshot, stored);
  assert.equal(closed.ticket.report_status, "closed_early");

  const legacy = await reportWith("completed", []);
  assert.equal(legacy.planned_route_snapshot, null);
  const malformed = await reportWith("completed", [{
    event_type: "ticket_issued",
    details: JSON.stringify({ planned_route: { geometry: "bad" } })
  }]);
  assert.equal(malformed.planned_route_snapshot, null);
}

function testReportUiUsesPersistedGeoJsonWithoutOsrm() {
  const stored = validStoredSnapshot();
  assert.deepEqual(dispatchReportPlannedPoints(stored), routeCoordinates);
  assert.deepEqual(dispatchReportPlannedPoints({ geometry: { type: "LineString", coordinates: null } }), []);

  const source = fs.readFileSync(
    path.join(projectRoot, "frontend/js/admin/admin-dispatch.js"),
    "utf8"
  );
  const dispatchNow = source.slice(
    source.indexOf("async function dispatchSelectedTruckNow"),
    source.indexOf("function dispatchTicketQuery")
  );
  assert.ok(
    dispatchNow.indexOf("buildDispatchIssuePlannedRouteSnapshot") <
      dispatchNow.indexOf("saveDispatchDraft"),
    "snapshot must be detached before saving can trigger another render"
  );
  assert.match(dispatchNow, /planned_route_snapshot: issuePlannedRouteSnapshot/);

  const reportOpen = source.slice(
    source.indexOf("function dispatchReportStopStatus"),
    source.indexOf("function openDispatchEndModal")
  );
  assert.doesNotMatch(reportOpen, /router\.project-osrm|requestDispatchRoadJourney|requestDispatchRoadRoute/);
  assert.match(reportOpen, /Original assigned road route was not recorded for this dispatch/);
  assert.match(reportOpen, /Dark green: actual GPS trail/);
  assert.match(reportOpen, /Blue: persisted assigned route/);

  const controller = fs.readFileSync(
    path.join(projectRoot, "controllers/dispatchController.js"),
    "utf8"
  );
  assert.match(controller, /\.\.\.\(req\.body \|\| \{\}\)/);
  assert.match(
    controller,
    /dispatchService\.issueTicket\([\s\S]*withAuthenticatedActor\(req\)/
  );

  const service = fs.readFileSync(
    path.join(projectRoot, "services/dispatchService.js"),
    "utf8"
  );
  const issueBlock = service.slice(
    service.indexOf("async issueTicket"),
    service.indexOf("async cancelTicket")
  );
  assert.doesNotMatch(issueBlock, /ALTER TABLE|CREATE TABLE|DROP TABLE/);
}

async function run() {
  testFrontendCaptureAndCoordinateOrder();
  testFrontendRejectsStaleWrongTruckAndMalformedRoutes();
  testBackendValidationAndStoredProjection();
  await testIssueTransactionPersistenceAndIdempotency();
  await testIssueSnapshotFailureRollsBackTransaction();
  await testIssueIdentityValidationAndLegacyCompatibility();
  await testCompletedClosedEarlyAndLegacyReports();
  testReportUiUsesPersistedGeoJsonWithoutOsrm();
  console.log("Dispatch planned-route snapshot tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
