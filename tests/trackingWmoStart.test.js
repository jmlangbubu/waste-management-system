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
    parent?.filename.replace(/\\/g, "/").endsWith("services/trackingService.js")
  ) {
    return mockPool;
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const trackingModule = require("../services/trackingService");
Module._load = originalModuleLoad;

const {
  TrackingService,
  TrackingStartEligibilityError,
  WMO_GEOFENCE
} = trackingModule;

const REFERENCE_TIME_MS = Date.parse("2026-08-26T10:00:00+08:00");
const QUALIFIED_START = Object.freeze({
  truck_id: "TRUCK-WMO-1",
  enforcer_id: 7,
  enforcer_name: "Test Enforcer",
  device_id: "android-test",
  shift_end_time: "2026-08-26 17:00:00",
  latitude: WMO_GEOFENCE.latitude,
  longitude: WMO_GEOFENCE.longitude,
  accuracy: 12,
  recorded_at: "2026-08-26 10:00:00"
});

function startPayloadAtDistanceMeters(distanceMeters, overrides = {}) {
  const earthRadiusMeters = 6371000;
  const latitudeOffsetDegrees = (distanceMeters / earthRadiusMeters) * (180 / Math.PI);
  return {
    ...QUALIFIED_START,
    latitude: WMO_GEOFENCE.latitude + latitudeOffsetDegrees,
    longitude: WMO_GEOFENCE.longitude,
    ...overrides
  };
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function createService() {
  const service = new TrackingService();
  service.ensureTrackingSessionReportColumns = async () => {};
  service.createGpsTrackingNotification = async () => null;
  service.getManilaNowDateTime = () => "2026-08-26 10:00:00";
  return service;
}

function assertStartError(service, payload, code) {
  assert.throws(
    () => service.validateNewTrackingStartLocation(payload, REFERENCE_TIME_MS),
    (error) => error instanceof TrackingStartEligibilityError &&
      error.code === code &&
      error.statusCode === 400
  );
}

function testQualifiedStartEvidenceRules() {
  const service = createService();
  const inside = service.validateNewTrackingStartLocation(
    startPayloadAtDistanceMeters(99.999),
    REFERENCE_TIME_MS
  );
  assert.ok(inside.distanceFromWmoMeters < WMO_GEOFENCE.radiusMeters);

  const edge = service.validateNewTrackingStartLocation(
    startPayloadAtDistanceMeters(100),
    REFERENCE_TIME_MS
  );
  assert.ok(Math.abs(edge.distanceFromWmoMeters - 100) < 0.000001);

  assertStartError(
    service,
    startPayloadAtDistanceMeters(100.001),
    "TRACKING_START_OUTSIDE_WMO"
  );

  assertStartError(
    service,
    { ...QUALIFIED_START, latitude: 0, longitude: 0 },
    "TRACKING_START_GPS_INVALID"
  );
  assertStartError(
    service,
    { ...QUALIFIED_START, latitude: 90.001 },
    "TRACKING_START_GPS_INVALID"
  );
  assertStartError(
    service,
    { ...QUALIFIED_START, accuracy: 50.01 },
    "TRACKING_START_GPS_INACCURATE"
  );
  assertStartError(
    service,
    { ...QUALIFIED_START, recorded_at: "2026-08-26 09:54:59" },
    "TRACKING_START_GPS_STALE"
  );
  assertStartError(
    service,
    { ...QUALIFIED_START, recorded_at: "2026-08-26 10:01:01" },
    "TRACKING_START_GPS_FUTURE"
  );
  assertStartError(
    service,
    { truck_id: QUALIFIED_START.truck_id },
    "TRACKING_START_GPS_REQUIRED"
  );

  const exactReliabilityBoundary = service.validateNewTrackingStartLocation({
    ...QUALIFIED_START,
    accuracy: 50,
    recorded_at: "2026-08-26 09:55:00"
  }, REFERENCE_TIME_MS);
  assert.equal(exactReliabilityBoundary.accuracy, 50);

  const exactFutureBoundary = service.validateNewTrackingStartLocation({
    ...QUALIFIED_START,
    recorded_at: "2026-08-26 10:01:00"
  }, REFERENCE_TIME_MS);
  assert.equal(exactFutureBoundary.recorded_at, "2026-08-26 10:01:00");
}

async function testExistingActiveSessionRestoresOutsideWmoWithoutGpsGate() {
  const service = createService();
  let validationCalls = 0;
  let insertCalls = 0;
  service.validateNewTrackingStartLocation = () => {
    validationCalls += 1;
    throw new Error("Active restore must not validate new-session GPS");
  };

  queryHandler = async (sql) => {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith("SELECT id FROM truck_tracking_sessions")) {
      return [[{ id: 58 }]];
    }
    if (normalized.startsWith("UPDATE truck_tracking_sessions")) {
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith("INSERT INTO truck_tracking_sessions")) {
      insertCalls += 1;
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  };

  const result = await service.startTrackingSession({
    truck_id: QUALIFIED_START.truck_id,
    ...startPayloadAtDistanceMeters(5000),
    accuracy: 10,
    recorded_at: QUALIFIED_START.recorded_at
  });

  assert.equal(result.alreadyActive, true);
  assert.equal(result.sessionId, 58);
  assert.equal(validationCalls, 0);
  assert.equal(insertCalls, 0);
}

async function testQualifiedInsidePointCreatesOneSession() {
  const service = createService();
  let insertCalls = 0;
  let upserted = null;
  service.upsertLastLocation = async (point) => {
    upserted = point;
  };

  queryHandler = async (sql, parameters = []) => {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith("SELECT id FROM truck_tracking_sessions")) {
      return [[]];
    }
    if (normalized.startsWith("INSERT INTO truck_tracking_sessions")) {
      insertCalls += 1;
      assert.deepEqual(parameters.slice(7, 12), [
        QUALIFIED_START.latitude,
        QUALIFIED_START.longitude,
        QUALIFIED_START.latitude,
        QUALIFIED_START.longitude,
        QUALIFIED_START.recorded_at
      ]);
      return [{ insertId: 71 }];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  };

  const originalDateNow = Date.now;
  Date.now = () => REFERENCE_TIME_MS;
  try {
    const result = await service.startTrackingSession(QUALIFIED_START);
    assert.deepEqual(result, {
      alreadyActive: false,
      sessionId: 71,
      notification: null
    });
  } finally {
    Date.now = originalDateNow;
  }

  assert.equal(insertCalls, 1);
  assert.equal(upserted.session_id, 71);
  assert.equal(upserted.accuracy, QUALIFIED_START.accuracy);
  assert.equal(upserted.recorded_at, QUALIFIED_START.recorded_at);
}

async function testDirectOutsideCallerCannotCreateSession() {
  const service = createService();
  let insertCalls = 0;

  queryHandler = async (sql) => {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith("SELECT id FROM truck_tracking_sessions")) {
      return [[]];
    }
    if (normalized.startsWith("INSERT INTO truck_tracking_sessions")) {
      insertCalls += 1;
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  };

  const originalDateNow = Date.now;
  Date.now = () => REFERENCE_TIME_MS;
  try {
    await assert.rejects(
      () => service.startTrackingSession(startPayloadAtDistanceMeters(5000)),
      (error) => error instanceof TrackingStartEligibilityError &&
        error.code === "TRACKING_START_OUTSIDE_WMO" &&
        error.statusCode === 400
    );
  } finally {
    Date.now = originalDateNow;
  }

  assert.equal(insertCalls, 0);
}

async function testTruckIdentityIsRequiredBeforeDatabasePreparation() {
  const service = createService();
  let preparationCalls = 0;
  service.ensureTrackingSessionReportColumns = async () => {
    preparationCalls += 1;
  };

  await assert.rejects(
    () => service.startTrackingSession({ ...QUALIFIED_START, truck_id: "  " }),
    (error) => error instanceof TrackingStartEligibilityError &&
      error.code === "TRACKING_START_TRUCK_REQUIRED" &&
      error.statusCode === 400
  );
  assert.equal(preparationCalls, 0);
}

async function testConcurrentStartsCreateOnlyOneSession() {
  const service = createService();
  service.upsertLastLocation = async () => {};
  let selectCalls = 0;
  let insertCalls = 0;
  let releaseInsert;
  let signalInsertReached;
  const insertGate = new Promise((resolve) => {
    releaseInsert = resolve;
  });
  const insertReached = new Promise((resolve) => {
    signalInsertReached = resolve;
  });

  queryHandler = async (sql) => {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith("SELECT id FROM truck_tracking_sessions")) {
      selectCalls += 1;
      return [[]];
    }
    if (normalized.startsWith("INSERT INTO truck_tracking_sessions")) {
      insertCalls += 1;
      signalInsertReached();
      await insertGate;
      return [{ insertId: 72 }];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  };

  const originalDateNow = Date.now;
  Date.now = () => REFERENCE_TIME_MS;
  try {
    const firstStart = service.startTrackingSession(QUALIFIED_START);
    const secondStart = service.startTrackingSession(QUALIFIED_START);
    await insertReached;
    releaseInsert();
    const [firstResult, secondResult] = await Promise.all([firstStart, secondStart]);

    assert.equal(firstResult.sessionId, 72);
    assert.equal(firstResult.alreadyActive, false);
    assert.equal(secondResult.sessionId, 72);
    assert.equal(secondResult.alreadyActive, true);
  } finally {
    Date.now = originalDateNow;
  }

  assert.equal(selectCalls, 1);
  assert.equal(insertCalls, 1);
}

async function testControllerReturnsStableEligibilityErrorContract() {
  const singleton = require("../services/trackingService");
  const originalStart = singleton.startTrackingSession;
  singleton.startTrackingSession = async () => {
    throw new TrackingStartEligibilityError(
      "A new tracking session can start only inside the WMO area.",
      "TRACKING_START_OUTSIDE_WMO"
    );
  };
  delete require.cache[require.resolve("../controllers/trackingController")];
  const controller = require("../controllers/trackingController");
  const response = {
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; }
  };
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await controller.startTrackingSession({ body: {}, app: null }, response);
  } finally {
    console.error = originalConsoleError;
    singleton.startTrackingSession = originalStart;
  }

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, {
    success: false,
    message: "A new tracking session can start only inside the WMO area.",
    code: "TRACKING_START_OUTSIDE_WMO"
  });
}

async function testControllerReturnsSafeInfrastructureErrorContract() {
  const singleton = require("../services/trackingService");
  const originalStart = singleton.startTrackingSession;
  singleton.startTrackingSession = async () => {
    throw new Error("ER_INTERNAL_DATABASE_DETAIL");
  };
  delete require.cache[require.resolve("../controllers/trackingController")];
  const controller = require("../controllers/trackingController");
  const response = {
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; }
  };
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await controller.startTrackingSession({ body: {}, app: null }, response);
  } finally {
    console.error = originalConsoleError;
    singleton.startTrackingSession = originalStart;
  }

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, {
    success: false,
    message: "Unable to start the tracking session right now.",
    code: "TRACKING_START_FAILED"
  });
}

async function run() {
  testQualifiedStartEvidenceRules();
  await testExistingActiveSessionRestoresOutsideWmoWithoutGpsGate();
  await testQualifiedInsidePointCreatesOneSession();
  await testDirectOutsideCallerCannotCreateSession();
  await testTruckIdentityIsRequiredBeforeDatabasePreparation();
  await testConcurrentStartsCreateOnlyOneSession();
  await testControllerReturnsStableEligibilityErrorContract();
  await testControllerReturnsSafeInfrastructureErrorContract();
  console.log("Tracking WMO start eligibility tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
