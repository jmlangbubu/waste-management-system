const assert = require("node:assert/strict");
const Module = require("node:module");

const {
  GpsValidationError,
  LIVE_LOCATION_FRESHNESS_MS,
  MAX_RELIABLE_ACCURACY_METERS,
  formatManilaDateTime,
  qualifyGpsPointForOperationalUse,
  validateGpsPointForStorage
} = require("../utils/gpsValidation");

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
    parent?.filename.replace(/\\/g, "/").endsWith("services/trackingService.js")
  ) {
    return mockPool;
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
const {
  TrackingService,
  TrackingStartEligibilityError
} = require("../services/trackingService");
Module._load = originalModuleLoad;

const NOW_MS = Date.parse("2026-08-17T10:00:00+08:00");
const VALID_POINT = Object.freeze({
  latitude: 6.1060875,
  longitude: 125.1816406,
  accuracy: 12,
  recorded_at: "2026-08-17 10:00:00"
});

function assertGpsValidationError(point, code = "GPS_POINT_INVALID") {
  assert.throws(
    () => validateGpsPointForStorage(point, { nowMs: NOW_MS }),
    (error) => error instanceof GpsValidationError && error.code === code
  );
}

function testStrictStorageValidation() {
  const normalized = validateGpsPointForStorage(VALID_POINT, { nowMs: NOW_MS });
  assert.equal(normalized.latitude, VALID_POINT.latitude);
  assert.equal(normalized.longitude, VALID_POINT.longitude);
  assert.equal(normalized.accuracy, VALID_POINT.accuracy);

  for (const latitude of [null, undefined, "", false, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertGpsValidationError({ ...VALID_POINT, latitude });
  }
  for (const longitude of [null, undefined, "", true, {}, Number.NaN, Number.NEGATIVE_INFINITY]) {
    assertGpsValidationError({ ...VALID_POINT, longitude });
  }
  assertGpsValidationError({ ...VALID_POINT, latitude: "6.1060875" });
  assertGpsValidationError({ ...VALID_POINT, latitude: 90.0001 });
  assertGpsValidationError({ ...VALID_POINT, latitude: -90.0001 });
  assertGpsValidationError({ ...VALID_POINT, longitude: 180.0001 });
  assertGpsValidationError({ ...VALID_POINT, longitude: -180.0001 });
  assertGpsValidationError({ ...VALID_POINT, latitude: 0, longitude: 0 });
  assertGpsValidationError({ ...VALID_POINT, accuracy: -1 });
  assertGpsValidationError({ ...VALID_POINT, accuracy: "" });
  assertGpsValidationError({ ...VALID_POINT, accuracy: false });
  assertGpsValidationError({ ...VALID_POINT, accuracy: {} });
  assertGpsValidationError({ ...VALID_POINT, accuracy: Number.NaN });
  assertGpsValidationError({ ...VALID_POINT, accuracy: Number.POSITIVE_INFINITY });
  assertGpsValidationError(
    { ...VALID_POINT, recorded_at: "not-a-timestamp" },
    "GPS_TIMESTAMP_INVALID"
  );
  assertGpsValidationError(
    { ...VALID_POINT, recorded_at: "2026-08-17 10:01:01" },
    "GPS_TIMESTAMP_FUTURE"
  );
}

function testStorageAndOperationalRulesRemainSeparate() {
  const oldPoint = {
    ...VALID_POINT,
    recorded_at: "2026-08-16 08:00:00"
  };
  assert.doesNotThrow(() => validateGpsPointForStorage(oldPoint, { nowMs: NOW_MS }));

  const fresh = qualifyGpsPointForOperationalUse(VALID_POINT, {
    referenceTimeMs: NOW_MS
  });
  assert.equal(fresh.reliable, true);
  assert.equal(fresh.point.accuracy, 12);

  const stale = qualifyGpsPointForOperationalUse(oldPoint, {
    referenceTimeMs: NOW_MS
  });
  assert.equal(stale.reliable, false);
  assert.equal(stale.reason, "stale_location");

  const boundary = qualifyGpsPointForOperationalUse({
    ...VALID_POINT,
    recorded_at: formatManilaDateTime(NOW_MS - LIVE_LOCATION_FRESHNESS_MS),
    accuracy: MAX_RELIABLE_ACCURACY_METERS
  }, { referenceTimeMs: NOW_MS });
  assert.equal(boundary.reliable, true);

  const poor = qualifyGpsPointForOperationalUse({
    ...VALID_POINT,
    accuracy: MAX_RELIABLE_ACCURACY_METERS + 0.01
  }, { referenceTimeMs: NOW_MS });
  assert.equal(poor.reliable, false);
  assert.equal(poor.reason, "unreliable_accuracy");
}

async function testSingleUploadRejectsBeforeDatabase() {
  const service = new TrackingService();
  service.ensureOfflineTrackingColumns = async () => {};
  let queries = 0;
  queryHandler = async () => {
    queries += 1;
    throw new Error("Malformed payload reached the database");
  };

  for (const point of [
    { ...VALID_POINT, latitude: "" },
    { ...VALID_POINT, latitude: false },
    { ...VALID_POINT, latitude: {} },
    { ...VALID_POINT, latitude: Number.NaN },
    { ...VALID_POINT, longitude: Number.POSITIVE_INFINITY },
    { ...VALID_POINT, latitude: 0, longitude: 0 },
    { ...VALID_POINT, recorded_at: "invalid" }
  ]) {
    await assert.rejects(
      () => service.addSingleLocationLog(91, point),
      (error) => error instanceof GpsValidationError && error.statusCode === 400
    );
  }
  assert.equal(queries, 0);
}

async function testBatchValidatesBeforeWritingAndSortsChronologically() {
  const service = new TrackingService();
  service.ensureOfflineTrackingColumns = async () => {};
  service.getLocationLogSession = async () => ({
    id: 91,
    truck_id: "TRUCK-9",
    session_status: "active"
  });
  let routeRecalculations = 0;
  service.recalculateSessionDistanceAndLatestLocation = async () => {
    routeRecalculations += 1;
  };
  const received = [];
  service.addSingleLocationLog = async (_sessionId, point) => {
    received.push(point.recorded_at);
    return { duplicate: false, local_point_id: point.local_point_id };
  };
  service.requestAutoStopCheck = () => {};

  await assert.rejects(
    () => service.addLocationLogsBatch(91, {
      locations: [
        { ...VALID_POINT, recorded_at: "2026-08-16 08:00:00" },
        { ...VALID_POINT, longitude: false, recorded_at: "2026-08-16 08:00:01" }
      ]
    }),
    (error) => error instanceof GpsValidationError && /locations\[1\]/.test(error.message)
  );
  assert.deepEqual(received, []);

  const result = await service.addLocationLogsBatch(91, {
    locations: [
      { ...VALID_POINT, local_point_id: "later", recorded_at: "2026-08-16 09:00:00" },
      { ...VALID_POINT, local_point_id: "earlier", recorded_at: "2026-08-16 08:00:00" }
    ]
  });
  assert.deepEqual(received, ["2026-08-16 08:00:00", "2026-08-16 09:00:00"]);
  assert.equal(result.inserted_count, 2);
  assert.equal(routeRecalculations, 1);
}

async function testBatchResponseCountsIdsAndZeroInsertSafety() {
  const cases = [
    {
      name: "all new",
      outcomes: [false, false, false],
      expectedInserted: 3,
      expectedDuplicates: 0,
      expectedRecalculations: 1
    },
    {
      name: "all duplicates",
      outcomes: [true, true, true],
      expectedInserted: 0,
      expectedDuplicates: 3,
      expectedRecalculations: 0
    },
    {
      name: "mixed",
      outcomes: [false, true, false],
      expectedInserted: 2,
      expectedDuplicates: 1,
      expectedRecalculations: 1
    }
  ];

  for (const item of cases) {
    const service = new TrackingService();
    let offlineColumnChecks = 0;
    let sessionLookups = 0;
    let routeRecalculations = 0;
    const results = [...item.outcomes];

    service.ensureOfflineTrackingColumns = async () => {
      offlineColumnChecks += 1;
    };
    service.getLocationLogSession = async () => {
      sessionLookups += 1;
      return { id: 91, truck_id: "TRUCK-9", session_status: "active" };
    };
    service.addSingleLocationLog = async (_sessionId, point, options) => {
      assert.equal(options.skipOfflineColumnCheck, true);
      assert.equal(options.skipRouteRecalculation, true);
      assert.equal(options.session.id, 91);
      return {
        duplicate: results.shift(),
        local_point_id: point.local_point_id
      };
    };
    service.recalculateSessionDistanceAndLatestLocation = async () => {
      routeRecalculations += 1;
    };
    service.requestAutoStopCheck = () => {};

    const result = await service.addLocationLogsBatch(91, {
      locations: [
        { ...VALID_POINT, local_point_id: "batch-1", recorded_at: "2026-08-16 08:00:01" },
        { ...VALID_POINT, local_point_id: "batch-2", recorded_at: "2026-08-16 08:00:02" },
        { ...VALID_POINT, local_point_id: "batch-3", recorded_at: "2026-08-16 08:00:03" }
      ]
    });

    assert.deepEqual(result, {
      success: true,
      message: "Location batch synced successfully",
      inserted_count: item.expectedInserted,
      duplicate_count: item.expectedDuplicates,
      synced_local_point_ids: ["batch-1", "batch-2", "batch-3"]
    }, item.name);
    assert.equal(offlineColumnChecks, 1, item.name);
    assert.equal(sessionLookups, 1, item.name);
    assert.equal(routeRecalculations, item.expectedRecalculations, item.name);
  }
}

async function testAllDuplicateBatchPerformsNoWritesOrRecalculation() {
  const service = new TrackingService();
  service.ensureOfflineTrackingColumns = async () => {};
  let sessionLookups = 0;
  let duplicateLookups = 0;
  let writes = 0;
  let routeRecalculations = 0;

  queryHandler = async (sql) => {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    if (normalized.includes("FROM truck_tracking_sessions") && normalized.includes("WHERE id = ?")) {
      sessionLookups += 1;
      return [[{
        id: 91,
        truck_id: "TRUCK-9",
        session_status: "active",
        shift_end_time: "2026-08-17 17:00:00",
        ended_at: null
      }]];
    }
    if (normalized.startsWith("SELECT id FROM truck_location_logs")) {
      duplicateLookups += 1;
      return [[{ id: duplicateLookups }]];
    }
    if (normalized.startsWith("INSERT") || normalized.startsWith("UPDATE")) {
      writes += 1;
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  };
  service.recalculateSessionDistanceAndLatestLocation = async () => {
    routeRecalculations += 1;
  };
  service.requestAutoStopCheck = () => {};

  const result = await service.addLocationLogsBatch(91, {
    locations: [
      { ...VALID_POINT, local_point_id: "duplicate-1" },
      { ...VALID_POINT, local_point_id: "duplicate-2" },
      { ...VALID_POINT, local_point_id: "duplicate-3" }
    ]
  });

  assert.equal(sessionLookups, 1);
  assert.equal(duplicateLookups, 3);
  assert.equal(writes, 0);
  assert.equal(routeRecalculations, 0);
  assert.deepEqual(result, {
    success: true,
    message: "Location batch synced successfully",
    inserted_count: 0,
    duplicate_count: 3,
    synced_local_point_ids: ["duplicate-1", "duplicate-2", "duplicate-3"]
  });
}

async function testQueuedBatchPreparesAndRecalculatesOnlyOnce() {
  const service = new TrackingService();
  let offlineColumnChecks = 0;
  let sessionLookups = 0;
  let routeRecalculations = 0;
  const receivedOptions = [];
  const recalculationOptions = [];

  service.ensureOfflineTrackingColumns = async () => {
    offlineColumnChecks += 1;
  };
  service.getLocationLogSession = async () => {
    sessionLookups += 1;
    return { id: 91, truck_id: "TRUCK-9", session_status: "active" };
  };
  service.addSingleLocationLog = async (_sessionId, point, options) => {
    receivedOptions.push(options);
    return { duplicate: false, local_point_id: point.local_point_id };
  };
  service.recalculateSessionDistanceAndLatestLocation = async (sessionId, options) => {
    routeRecalculations += 1;
    recalculationOptions.push({ sessionId, options });
  };
  service.requestAutoStopCheck = () => {};

  const locations = Array.from({ length: 75 }, (_unused, index) => ({
    ...VALID_POINT,
    local_point_id: `queued-${index}`,
    recorded_at: `2026-08-16 08:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`
  }));

  const result = await service.addLocationLogsBatch(91, { locations });

  assert.equal(result.inserted_count, 75);
  assert.equal(offlineColumnChecks, 1);
  assert.equal(sessionLookups, 1);
  assert.equal(routeRecalculations, 1);
  assert.equal(recalculationOptions[0].sessionId, 91);
  assert.equal(recalculationOptions[0].options.session.id, 91);
  assert.equal(receivedOptions.length, 75);
  assert.ok(receivedOptions.every((options) =>
    options.skipOfflineColumnCheck === true &&
    options.skipRouteRecalculation === true &&
    options.session.id === 91
  ));
}

async function testHistoricalQueuedBatchPreservesOriginalRecordedAt() {
  const service = new TrackingService();
  service.ensureOfflineTrackingColumns = async () => {};
  service.getManilaNowDateTime = () => "2026-08-17 10:00:00";
  let routeRecalculations = 0;
  const insertedParameters = [];

  queryHandler = async (sql, parameters = []) => {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    if (normalized.includes("FROM truck_tracking_sessions") && normalized.includes("WHERE id = ?")) {
      return [[{
        id: 91,
        truck_id: "TRUCK-9",
        session_status: "stopped",
        shift_end_time: "2026-08-16 17:00:00",
        ended_at: "2026-08-16 17:05:00"
      }]];
    }
    if (normalized.startsWith("SELECT id FROM truck_location_logs")) return [[]];
    if (normalized.startsWith("INSERT INTO truck_location_logs")) {
      insertedParameters.push(parameters);
      return [{ insertId: insertedParameters.length }];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  };
  service.recalculateSessionDistanceAndLatestLocation = async () => {
    routeRecalculations += 1;
  };
  service.requestAutoStopCheck = () => {};

  const result = await service.addLocationLogsBatch(91, {
    locations: [
      { ...VALID_POINT, local_point_id: "historical-1", recorded_at: "2026-08-16 16:58:00" },
      { ...VALID_POINT, local_point_id: "historical-2", recorded_at: "2026-08-16 16:59:00" }
    ]
  });

  assert.equal(result.inserted_count, 2);
  assert.equal(routeRecalculations, 1);
  assert.deepEqual(insertedParameters.map((parameters) => parameters[10]), [
    "2026-08-16 16:58:00",
    "2026-08-16 16:59:00"
  ]);
  assert.ok(insertedParameters.every((parameters) =>
    parameters[9] === "mobile_offline_queue" &&
    parameters[11] === "2026-08-17 10:00:00"
  ));
}

async function testCoordinateFreeNewStartIsRejectedBeforeInsert() {
  const service = new TrackingService();
  service.autoStopExpiredSessions = async () => {};
  service.ensureTrackingSessionReportColumns = async () => {};
  service.getManilaNowDateTime = () => "2026-08-17 10:00:00";
  service.resolveShiftEndForDuty = (requestedShiftEnd) => requestedShiftEnd;
  service.createGpsTrackingNotification = async () => null;

  const calls = [];
  queryHandler = async (sql, parameters = []) => {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    calls.push({ sql: normalized, parameters });
    if (normalized.startsWith("SELECT id FROM truck_tracking_sessions")) return [[]];
    if (normalized.startsWith("INSERT INTO truck_tracking_sessions")) {
      return [{ insertId: 58 }];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  };

  await assert.rejects(
    () => service.startTrackingSession({
      truck_id: "TRUCK-9",
      enforcer_id: 7,
      enforcer_name: "Test Enforcer",
      device_id: "test-device",
      shift_end_time: "2026-08-17 17:00:00"
    }),
    (error) => error instanceof TrackingStartEligibilityError &&
      error.code === "TRACKING_START_GPS_REQUIRED" &&
      error.statusCode === 400
  );

  assert.equal(calls.some((call) =>
    call.sql.startsWith("INSERT INTO truck_tracking_sessions")
  ), false);
}

async function testAlreadyActiveStartResponseKeepsExistingSessionId() {
  const service = new TrackingService();
  service.autoStopExpiredSessions = async () => {};
  service.ensureTrackingSessionReportColumns = async () => {};
  service.getManilaNowDateTime = () => "2026-08-17 10:00:00";
  service.resolveShiftEndForDuty = (requestedShiftEnd) => requestedShiftEnd;
  service.createGpsTrackingNotification = async () => null;

  queryHandler = async (sql) => {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    if (normalized.startsWith("SELECT id FROM truck_tracking_sessions")) {
      return [[{ id: "58" }]];
    }
    if (normalized.startsWith("UPDATE truck_tracking_sessions")) {
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  };

  const result = await service.startTrackingSession({
    truck_id: "TRUCK-9",
    enforcer_id: 7,
    enforcer_name: "Test Enforcer",
    device_id: "test-device",
    shift_end_time: "2026-08-17 17:00:00"
  });

  assert.deepEqual(result, {
    alreadyActive: true,
    sessionId: "58",
    notification: null
  });
}

async function testStoppedSessionHistoricalQueuePointRemainsSupported() {
  const service = new TrackingService();
  service.ensureOfflineTrackingColumns = async () => {};
  service.recalculateSessionDistanceAndLatestLocation = async () => {};
  const calls = [];
  queryHandler = async (sql, parameters = []) => {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    calls.push({ sql: normalized, parameters });
    if (normalized.startsWith("SELECT id, truck_id, session_status")) {
      return [[{
        id: 91,
        truck_id: "TRUCK-9",
        session_status: "stopped",
        shift_end_time: "2026-08-16 17:00:00",
        ended_at: "2026-08-16 17:05:00"
      }]];
    }
    if (normalized.startsWith("SELECT id FROM truck_location_logs")) return [[]];
    if (normalized.startsWith("INSERT INTO truck_location_logs")) return [{ insertId: 1 }];
    throw new Error(`Unexpected SQL: ${normalized}`);
  };

  const result = await service.addSingleLocationLog(91, {
    ...VALID_POINT,
    local_point_id: "offline-91-1",
    recorded_at: "2026-08-16 16:59:00"
  });
  assert.equal(result.duplicate, false);
  const insert = calls.find((call) => call.sql.startsWith("INSERT INTO truck_location_logs"));
  assert.ok(insert);
  assert.equal(insert.parameters[8], "offline-91-1");
  assert.equal(insert.parameters[9], "mobile_offline_queue");
  assert.equal(insert.parameters[10], "2026-08-16 16:59:00");
}

async function testWebAdminStopUsesFixedStopTypeAndIsIdempotent() {
  const service = new TrackingService();
  const calls = [];
  service.stopTrackingSession = async (sessionId, payload) => {
    calls.push({ sessionId, payload });
    return {
      message: calls.length === 1
        ? "Tracking session stopped successfully"
        : "Session already stopped",
      truck_id: "TRUCK-9",
      already_stopped: calls.length > 1,
      notification: null
    };
  };
  const actor = { id: 7, full_name: "Trusted Operator" };
  const first = await service.stopTrackingSessionByWebAdmin(91, actor);
  const repeated = await service.stopTrackingSessionByWebAdmin(91, actor);

  assert.deepEqual(calls, [
    { sessionId: 91, payload: { stop_type: "manual_stopped" } },
    { sessionId: 91, payload: { stop_type: "manual_stopped" } }
  ]);
  assert.equal(first.already_stopped, false);
  assert.equal(repeated.already_stopped, true);
  assert.deepEqual(first.stopped_by, { id: 7, name: "Trusted Operator" });

  service.stopTrackingSession = async () => {
    throw new Error("Tracking session not found");
  };
  await assert.rejects(
    () => service.stopTrackingSessionByWebAdmin(404, actor),
    (error) => error.statusCode === 404 && error.code === "TRACKING_SESSION_NOT_FOUND"
  );
}

async function testInvalidUploadReturnsControlledControllerJson() {
  const trackingSingleton = require("../services/trackingService");
  const originalAddLocationLog = trackingSingleton.addLocationLog;
  trackingSingleton.addLocationLog = async () => {
    throw new GpsValidationError("latitude must be a finite number");
  };
  delete require.cache[require.resolve("../controllers/trackingController")];
  const controller = require("../controllers/trackingController");
  const response = {
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; }
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    await controller.addLocationLog({ params: { sessionId: "91" }, body: {} }, response);
  } finally {
    console.error = originalError;
    trackingSingleton.addLocationLog = originalAddLocationLog;
  }
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, {
    success: false,
    message: "latitude must be a finite number"
  });
}

async function testDelayedHistoryDoesNotAcquireSyncTimeAsLocationTime() {
  const service = new TrackingService();
  let latestUpsert = null;
  service.upsertLastLocation = async (point) => {
    latestUpsert = point;
  };
  queryHandler = async (sql) => {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    if (normalized.startsWith("SELECT id, truck_id, session_status")) {
      return [[{ id: 91, truck_id: "TRUCK-9", session_status: "active" }]];
    }
    if (normalized.includes("FROM truck_location_logs")) {
      assert.match(normalized, /DATE_FORMAT\(recorded_at/);
      return [[{
        latitude: VALID_POINT.latitude,
        longitude: VALID_POINT.longitude,
        accuracy: VALID_POINT.accuracy,
        recorded_at: "2026-08-16 08:00:00"
      }]];
    }
    if (normalized.startsWith("UPDATE truck_tracking_sessions")) {
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  };

  await service.recalculateSessionDistanceAndLatestLocation(91);
  assert.equal(latestUpsert.recorded_at, "2026-08-16 08:00:00");
}

async function run() {
  testStrictStorageValidation();
  testStorageAndOperationalRulesRemainSeparate();
  await testSingleUploadRejectsBeforeDatabase();
  await testBatchValidatesBeforeWritingAndSortsChronologically();
  await testBatchResponseCountsIdsAndZeroInsertSafety();
  await testAllDuplicateBatchPerformsNoWritesOrRecalculation();
  await testQueuedBatchPreparesAndRecalculatesOnlyOnce();
  await testHistoricalQueuedBatchPreservesOriginalRecordedAt();
  await testCoordinateFreeNewStartIsRejectedBeforeInsert();
  await testAlreadyActiveStartResponseKeepsExistingSessionId();
  await testStoppedSessionHistoricalQueuePointRemainsSupported();
  await testWebAdminStopUsesFixedStopTypeAndIsIdempotent();
  await testDelayedHistoryDoesNotAcquireSyncTimeAsLocationTime();
  await testInvalidUploadReturnsControlledControllerJson();
  console.log("GPS validation and offline-history tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
