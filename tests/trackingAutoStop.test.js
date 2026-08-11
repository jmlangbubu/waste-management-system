const assert = require("node:assert/strict");
const Module = require("node:module");

let queryHandler = async () => {
  throw new Error("Unexpected database query");
};

const mockPool = {
  query(sql, parameters) {
    return queryHandler(sql, parameters);
  }
};

const originalModuleLoad = Module._load;
Module._load = function loadWithMockedTrackingPool(request, parent, isMain) {
  if (
    request === "../config/dbPromise" &&
    parent &&
    parent.filename.replace(/\\/g, "/").endsWith("services/trackingService.js")
  ) {
    return mockPool;
  }

  return originalModuleLoad.call(this, request, parent, isMain);
};

const trackingModule = require("../services/trackingService");
Module._load = originalModuleLoad;

const { TrackingService, WMO_GEOFENCE } = trackingModule;
const BEFORE_SHIFT_END = "2026-08-02 16:59:59";
const AFTER_SHIFT_END = "2026-08-02 17:00:01";

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function buildSession(overrides = {}) {
  return {
    id: 101,
    truck_id: "TRUCK-1",
    enforcer_name: "Test Enforcer",
    session_status: "active",
    started_at: "2026-08-02 08:00:00",
    created_at: "2026-08-02 08:00:00",
    shift_end_time: "2026-08-02 17:00:00",
    effective_shift_end_time: "2026-08-02 17:00:00",
    last_updated_at: "2026-08-02 17:00:01",
    last_device_status: "active",
    last_device_status_at: "2026-08-02 17:00:01",
    current_location_truck_id: "TRUCK-1",
    current_location_session_id: 101,
    current_latitude: WMO_GEOFENCE.latitude,
    current_longitude: WMO_GEOFENCE.longitude,
    location_last_updated: "2026-08-02 17:00:01",
    last_location_status: "active",
    ...overrides
  };
}

function createTestService() {
  const service = new TrackingService();
  service.ensureTrackingSessionReportColumns = async () => {};
  service.backfillTrackingCompletedNotifications = async () => 0;
  return service;
}

function testBeforeShiftEndRemainsActive() {
  const service = createTestService();
  const result = service.evaluateAutoStopEligibility(
    buildSession(),
    { latitude: WMO_GEOFENCE.latitude, longitude: WMO_GEOFENCE.longitude },
    BEFORE_SHIFT_END
  );

  assert.equal(result.shouldStop, false);
  assert.equal(result.reason, "before_shift_end");
}

function testAfterShiftEndOutsideWmoRemainsActive() {
  const service = createTestService();
  const result = service.evaluateAutoStopEligibility(
    buildSession(),
    { latitude: 6.1160875, longitude: 125.1816406 },
    AFTER_SHIFT_END
  );

  assert.equal(result.shouldStop, false);
  assert.equal(result.reason, "outside_wmo_geofence");
  assert.ok(result.distanceMeters > WMO_GEOFENCE.radiusMeters);
}

function testAfterShiftEndInsideWmoAutoStops() {
  const service = createTestService();
  const result = service.evaluateAutoStopEligibility(
    buildSession(),
    { latitude: WMO_GEOFENCE.latitude, longitude: WMO_GEOFENCE.longitude },
    AFTER_SHIFT_END
  );

  assert.equal(result.shouldStop, true);
  assert.equal(result.reason, "inside_wmo_geofence");
}

function testAfterShiftEndWithoutLocationRemainsActive() {
  const service = createTestService();
  const result = service.evaluateAutoStopEligibility(buildSession(), null, AFTER_SHIFT_END);

  assert.equal(result.shouldStop, false);
  assert.equal(result.reason, "no_reliable_location");
}

function testInvalidCoordinatesRemainActive() {
  const service = createTestService();
  const invalidLocations = [
    { latitude: null, longitude: WMO_GEOFENCE.longitude },
    { latitude: WMO_GEOFENCE.latitude, longitude: undefined },
    { latitude: 91, longitude: WMO_GEOFENCE.longitude },
    { latitude: WMO_GEOFENCE.latitude, longitude: 181 },
    { latitude: "not-a-number", longitude: WMO_GEOFENCE.longitude },
    { latitude: 0, longitude: 0 }
  ];

  for (const location of invalidLocations) {
    const result = service.evaluateAutoStopEligibility(buildSession(), location, AFTER_SHIFT_END);
    assert.equal(result.shouldStop, false);
    assert.equal(result.reason, "no_reliable_location");
  }
}

function testExactlyOneHundredMetersUsesInclusiveBoundary() {
  const service = createTestService();
  const boundaryLatitude = WMO_GEOFENCE.latitude +
    ((WMO_GEOFENCE.radiusMeters / 6371000) * (180 / Math.PI));
  const result = service.evaluateAutoStopEligibility(
    buildSession(),
    { latitude: boundaryLatitude, longitude: WMO_GEOFENCE.longitude },
    AFTER_SHIFT_END
  );

  assert.ok(Math.abs(result.distanceMeters - 100) < 0.000001);
  assert.equal(result.shouldStop, true);
}

async function testLatestLocationPriorityAndFallback() {
  const service = createTestService();
  let fallbackQueries = 0;

  queryHandler = async () => {
    fallbackQueries += 1;
    return [[
      { latitude: null, longitude: null, recorded_at: "2026-08-02 17:00:01" },
      {
        latitude: WMO_GEOFENCE.latitude,
        longitude: WMO_GEOFENCE.longitude,
        recorded_at: "2026-08-02 17:00:00"
      }
    ]];
  };

  const current = await service.getLatestReliableLocation(buildSession());
  assert.equal(current.source, "truck_last_locations");
  assert.equal(fallbackQueries, 0);

  const fallback = await service.getLatestReliableLocation(buildSession({
    current_latitude: null,
    current_longitude: null
  }));
  assert.equal(fallback.source, "truck_location_logs");
  assert.equal(fallbackQueries, 1);
}

async function testSessionsAreIndependentWhenOneLookupFails() {
  const service = createTestService();
  const updatedSessionIds = [];
  const notificationSessionIds = [];
  const sessions = [
    buildSession({
      id: 201,
      truck_id: "TRUCK-FAIL",
      current_location_truck_id: null,
      current_location_session_id: null,
      current_latitude: null,
      current_longitude: null
    }),
    buildSession({
      id: 202,
      truck_id: "TRUCK-INSIDE",
      current_location_truck_id: "TRUCK-INSIDE",
      current_location_session_id: 202
    }),
    buildSession({
      id: 203,
      truck_id: "TRUCK-OUTSIDE",
      current_location_truck_id: "TRUCK-OUTSIDE",
      current_location_session_id: 203,
      current_latitude: 6.1160875
    })
  ];

  service.getManilaNowDateTime = () => AFTER_SHIFT_END;
  service.createTrackingCompletedNotification = async (data) => {
    notificationSessionIds.push(data.session_id);
  };

  queryHandler = async (sql, parameters = []) => {
    const normalized = normalizeSql(sql);

    if (normalized.includes("FROM truck_tracking_sessions tts") && normalized.includes("session_status = 'active'")) {
      return [sessions];
    }

    if (normalized.includes("FROM truck_location_logs") && parameters[0] === 201) {
      throw new Error("simulated session lookup failure");
    }

    if (normalized.startsWith("UPDATE truck_tracking_sessions")) {
      updatedSessionIds.push(parameters[parameters.length - 1]);
      return [{ affectedRows: 1 }];
    }

    if (normalized.startsWith("UPDATE truck_last_locations")) {
      return [{ affectedRows: 1 }];
    }

    throw new Error(`Unexpected query: ${normalized}`);
  };

  const originalConsoleError = console.error;
  const loggedErrors = [];
  console.error = (...args) => loggedErrors.push(args.join(" "));

  try {
    await service.runAutoStopExpiredSessions();
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(updatedSessionIds, [202]);
  assert.deepEqual(notificationSessionIds, [202]);
  assert.ok(loggedErrors.some((message) => message.includes("Session 201 failed")));
}

async function testRepeatedCyclesDoNotDuplicateAutoStop() {
  const service = createTestService();
  const session = buildSession({ id: 301, current_location_session_id: 301 });
  let updateAttempts = 0;
  let notificationCount = 0;

  service.getManilaNowDateTime = () => AFTER_SHIFT_END;
  service.createTrackingCompletedNotification = async () => {
    notificationCount += 1;
  };

  queryHandler = async (sql) => {
    const normalized = normalizeSql(sql);

    if (normalized.includes("FROM truck_tracking_sessions tts") && normalized.includes("session_status = 'active'")) {
      return [[session]];
    }

    if (normalized.startsWith("UPDATE truck_tracking_sessions")) {
      updateAttempts += 1;
      return [{ affectedRows: updateAttempts === 1 ? 1 : 0 }];
    }

    if (normalized.startsWith("UPDATE truck_last_locations")) {
      return [{ affectedRows: 1 }];
    }

    throw new Error(`Unexpected query: ${normalized}`);
  };

  await service.autoStopExpiredSessions();
  await service.autoStopExpiredSessions();

  assert.equal(updateAttempts, 2);
  assert.equal(notificationCount, 1);
}

async function testActiveEndpointKeepsOutsideTruckAndDoesNotWaitForSweep() {
  const service = createTestService();
  const outsideTruck = {
    session_id: 401,
    truck_id: "TRUCK-OUTSIDE",
    session_status: "active",
    latitude: 6.1160875,
    longitude: WMO_GEOFENCE.longitude
  };
  let backgroundChecks = 0;

  service.requestAutoStopCheck = () => {
    backgroundChecks += 1;
  };
  queryHandler = async (sql) => {
    const normalized = normalizeSql(sql);
    assert.ok(normalized.includes("WHERE tts.session_status = 'active'"));
    return [[outsideTruck]];
  };

  const rows = await service.getActiveTrucks();
  assert.deepEqual(rows, [outsideTruck]);
  assert.equal(backgroundChecks, 1);
}

async function testStoppedHistoricalSessionsAreNotReopened() {
  const service = createTestService();
  let writes = 0;

  queryHandler = async (sql) => {
    const normalized = normalizeSql(sql);

    if (normalized.includes("FROM truck_tracking_sessions tts")) {
      assert.ok(normalized.includes("WHERE tts.session_status = 'active'"));
      return [[]];
    }

    if (normalized.startsWith("UPDATE") || normalized.startsWith("INSERT")) {
      writes += 1;
    }

    throw new Error(`Unexpected query: ${normalized}`);
  };

  await service.runAutoStopExpiredSessions();
  assert.equal(writes, 0);
}

function testEndedAtCannotPrecedeStartedAt() {
  const service = createTestService();
  const endedAt = service.getSafeAutoStopEndedAt(
    buildSession({ started_at: "2026-08-02 18:00:00" }),
    AFTER_SHIFT_END
  );

  assert.equal(endedAt, "2026-08-02 18:00:00");
}

async function testTrackingReportsRemainCompatible() {
  const service = createTestService();
  service.autoStopExpiredSessions = async () => {};
  const reportRow = {
    id: 501,
    truck_id: "TRUCK-REPORT",
    session_status: "auto_stopped",
    final_tracking_status_key: "active",
    session_distance_km: 2.5,
    route_logs_count: 4
  };

  queryHandler = async () => [[reportRow]];
  const rows = await service.getTrackingReports();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 501);
  assert.equal(rows[0].session_status, "auto_stopped");
  assert.equal(rows[0].route_logs_count, 4);
  assert.ok(rows[0].report_status_key);
}

async function testTrackingCompletedBackfillUsesNumericReferenceComparison() {
  const service = new TrackingService();
  service.ensureWmoNotificationsTableSafe = async () => {};
  service.ensureTrackingSessionReportColumns = async () => {};
  const createdForSessions = [];
  service.createTrackingCompletedNotification = async (session) => {
    createdForSessions.push(session.session_id);
    return { id: 9001 };
  };

  let backfillSql = "";
  queryHandler = async (sql) => {
    backfillSql = normalizeSql(sql);
    return [[{
      id: 612,
      session_id: 612,
      truck_id: "TRUCK-COMPLETE",
      session_status: "auto_stopped"
    }]];
  };

  const createdCount = await service.backfillTrackingCompletedNotifications(25);

  assert.equal(createdCount, 1);
  assert.deepEqual(createdForSessions, [612]);
  assert.match(backfillSql, /n\.type = 'tracking_completed'/);
  assert.match(backfillSql, /CAST\(n\.reference_id AS UNSIGNED\) = tts\.id/);
  assert.doesNotMatch(backfillSql, /n\.reference_id = CAST\(tts\.id AS CHAR\)/);
}

async function testSchedulerSkipsOverlapAndSchedulesOneNextRun() {
  const service = createTestService();
  let scheduledRuns = 0;

  service.autoStopSchedulerStarted = true;
  service.autoStopRunPromise = new Promise(() => {});
  service.scheduleNextAutoStopRun = () => {
    scheduledRuns += 1;
  };

  const originalConsoleWarn = console.warn;
  console.warn = () => {};

  try {
    await service.runAutoStopSchedulerCycle();
  } finally {
    console.warn = originalConsoleWarn;
  }

  assert.equal(scheduledRuns, 1);
}

async function run() {
  testBeforeShiftEndRemainsActive();
  testAfterShiftEndOutsideWmoRemainsActive();
  testAfterShiftEndInsideWmoAutoStops();
  testAfterShiftEndWithoutLocationRemainsActive();
  testInvalidCoordinatesRemainActive();
  testExactlyOneHundredMetersUsesInclusiveBoundary();
  await testLatestLocationPriorityAndFallback();
  await testSessionsAreIndependentWhenOneLookupFails();
  await testRepeatedCyclesDoNotDuplicateAutoStop();
  await testActiveEndpointKeepsOutsideTruckAndDoesNotWaitForSweep();
  await testStoppedHistoricalSessionsAreNotReopened();
  testEndedAtCannotPrecedeStartedAt();
  await testTrackingReportsRemainCompatible();
  await testTrackingCompletedBackfillUsesNumericReferenceComparison();
  await testSchedulerSkipsOverlapAndSchedulesOneNextRun();
  console.log("Tracking geofence auto-stop tests passed (13 required scenarios plus source priority, numeric notification lookup, and scheduler overlap).");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
