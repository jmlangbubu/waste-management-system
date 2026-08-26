const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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

const { TrackingService } = trackingModule;

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function createTestService() {
  const service = new TrackingService();
  service.ensureTrackingSessionReportColumns = async () => {};
  service.ensureWmoNotificationsTableSafe = async () => {};
  service.backfillTrackingCompletedNotifications = async () => 0;
  service.createGpsTrackingNotification = async () => null;
  service.createTrackingCompletedNotification = async () => null;
  service.upsertLastLocation = async () => {};
  return service;
}

async function testClockTimesNeverAutoStop() {
  const service = createTestService();
  const checkTimes = [
    "2026-08-18 16:59:00",
    "2026-08-18 17:00:00",
    "2026-08-18 17:01:00",
    "2026-08-18 18:00:00",
    "2026-08-18 22:00:00",
    "2026-08-19 00:30:00"
  ];
  let queryCount = 0;

  queryHandler = async () => {
    queryCount += 1;
    throw new Error("Time-based compatibility check must not query or update the database");
  };

  for (const time of checkTimes) {
    service.getManilaNowDateTime = () => time;
    const result = await service.autoStopExpiredSessions();
    assert.deepEqual(result, {
      stopped_count: 0,
      reason: "time_based_auto_stop_disabled"
    });
  }

  assert.equal(queryCount, 0);
}

function testLegacySchedulerApiCannotStartATimer() {
  const service = createTestService();
  const originalSetTimeout = global.setTimeout;
  let timerCount = 0;

  global.setTimeout = () => {
    timerCount += 1;
    return 1;
  };

  try {
    assert.equal(service.startAutoStopScheduler(), false);
    assert.equal(service.requestAutoStopCheck(), false);
    assert.equal(service.stopAutoStopScheduler(), false);
  } finally {
    global.setTimeout = originalSetTimeout;
  }

  assert.equal(timerCount, 0);
}

async function assertSessionCanStartAt(startedAt, requestedCompatibilityTime) {
  const service = createTestService();
  service.getManilaNowDateTime = () => startedAt;
  service.validateNewTrackingStartLocation = () => ({
    latitude: 6.1060875,
    longitude: 125.1816406,
    accuracy: 10,
    recorded_at: startedAt,
    distanceFromWmoMeters: 0
  });
  const calls = [];

  queryHandler = async (sql, parameters = []) => {
    const normalized = normalizeSql(sql);
    calls.push({ sql: normalized, parameters });

    if (normalized.startsWith("SELECT id FROM truck_tracking_sessions")) {
      return [[]];
    }

    if (normalized.startsWith("INSERT INTO truck_tracking_sessions")) {
      return [{ insertId: 701 }];
    }

    throw new Error(`Unexpected SQL: ${normalized}`);
  };

  const result = await service.startTrackingSession({
    truck_id: "TRUCK-NIGHT",
    enforcer_id: 88,
    enforcer_name: "Night Enforcer",
    device_id: "android-night",
    ...(requestedCompatibilityTime ? { shift_end_time: requestedCompatibilityTime } : {})
  });

  assert.deepEqual(result, {
    alreadyActive: false,
    sessionId: 701,
    notification: null
  });

  const insert = calls.find((call) => call.sql.startsWith("INSERT INTO truck_tracking_sessions"));
  assert.ok(insert);
  assert.equal(insert.parameters[4], startedAt);
  assert.equal(insert.parameters[5], requestedCompatibilityTime || startedAt);
  assert.equal(insert.parameters[6], requestedCompatibilityTime || startedAt);
}

async function testAfterHoursStartsRemainAvailable() {
  await assertSessionCanStartAt("2026-08-18 18:00:00", "2026-08-18 17:00:00");
  await assertSessionCanStartAt("2026-08-18 22:00:00", null);
  await assertSessionCanStartAt("2026-08-19 00:30:00", null);
}

async function testActiveTruckRemainsVisibleAfterTenPm() {
  const service = createTestService();
  service.getManilaNowDateTime = () => "2026-08-18 22:00:00";
  const activeTruck = {
    session_id: 801,
    truck_id: "TRUCK-ACTIVE",
    session_status: "active",
    tracking_status_key: "active"
  };

  queryHandler = async (sql, parameters = []) => {
    const normalized = normalizeSql(sql);
    assert.match(normalized, /WHERE tts\.session_status = 'active'/);
    assert.doesNotMatch(normalized, /shift_end_time\s*[<>=]/i);
    assert.deepEqual(parameters, ["2026-08-18 22:00:00"]);
    return [[activeTruck]];
  };

  const rows = await service.getActiveTrucks();
  assert.deepEqual(rows, [activeTruck]);
}

async function testManualStopUsesActualRequestTimeAfterFivePm() {
  const service = createTestService();
  const stoppedAt = "2026-08-18 22:15:00";
  service.getManilaNowDateTime = () => stoppedAt;
  let sessionUpdate = null;
  let lastLocationUpdate = null;

  queryHandler = async (sql, parameters = []) => {
    const normalized = normalizeSql(sql);

    if (normalized.includes("FROM truck_tracking_sessions tts") && normalized.includes("WHERE tts.id = ?")) {
      return [[{
        id: 901,
        truck_id: "TRUCK-MANUAL",
        enforcer_name: "Manual Enforcer",
        session_status: "active",
        started_at: "2026-08-18 18:00:00",
        created_at: "2026-08-18 18:00:00",
        shift_end_time: "2026-08-18 17:00:00",
        effective_shift_end_time: "2026-08-18 17:00:00",
        last_updated_at: "2026-08-18 22:14:45",
        last_device_status: "active",
        last_device_status_at: "2026-08-18 22:14:45",
        last_location_status: "active",
        location_last_updated: "2026-08-18 22:14:45"
      }]];
    }

    if (normalized.startsWith("UPDATE truck_tracking_sessions")) {
      sessionUpdate = parameters;
      return [{ affectedRows: 1 }];
    }

    if (normalized.startsWith("UPDATE truck_last_locations")) {
      lastLocationUpdate = parameters;
      return [{ affectedRows: 1 }];
    }

    throw new Error(`Unexpected SQL: ${normalized}`);
  };

  const result = await service.stopTrackingSession(901, {
    stop_type: "manual_stopped"
  });

  assert.equal(result.success, true);
  assert.equal(result.already_stopped, false);
  assert.ok(sessionUpdate);
  assert.equal(sessionUpdate[0], "manual_stopped");
  assert.equal(sessionUpdate[1], stoppedAt);
  assert.equal(sessionUpdate[2], "2026-08-18 17:00:00");
  assert.equal(sessionUpdate[11], stoppedAt);
  assert.ok(lastLocationUpdate);
}

async function testWebAdminStopDelegatesWithoutClockPolicy() {
  const service = createTestService();
  const calls = [];
  service.stopTrackingSession = async (sessionId, data) => {
    calls.push({ sessionId, data });
    return { success: true, already_stopped: false };
  };

  const result = await service.stopTrackingSessionByWebAdmin(902, {
    id: 17,
    full_name: "WMO Admin"
  });

  assert.deepEqual(calls, [{
    sessionId: 902,
    data: { stop_type: "manual_stopped" }
  }]);
  assert.equal(result.success, true);
  assert.deepEqual(result.stopped_by, { id: 17, name: "WMO Admin" });
}

async function testTrackingReportsRemainCompatible() {
  const service = createTestService();
  const reportRow = {
    id: 1001,
    truck_id: "TRUCK-HISTORICAL",
    session_status: "auto_stopped",
    final_tracking_status_key: "active",
    session_distance_km: 2.5,
    route_logs_count: 4
  };

  queryHandler = async () => [[reportRow]];
  const rows = await service.getTrackingReports();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1001);
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
    return { id: 1101 };
  };

  let backfillSql = "";
  queryHandler = async (sql) => {
    backfillSql = normalizeSql(sql);
    return [[{
      id: 1102,
      session_id: 1102,
      truck_id: "TRUCK-COMPLETE",
      session_status: "auto_stopped"
    }]];
  };

  const createdCount = await service.backfillTrackingCompletedNotifications(25);

  assert.equal(createdCount, 1);
  assert.deepEqual(createdForSessions, [1102]);
  assert.match(backfillSql, /n\.type = 'tracking_completed'/);
  assert.match(backfillSql, /CAST\(n\.reference_id AS UNSIGNED\) = tts\.id/);
  assert.doesNotMatch(backfillSql, /n\.reference_id = CAST\(tts\.id AS CHAR\)/);
}

function testServerDoesNotStartTimeBasedScheduler() {
  const serverSource = fs.readFileSync(
    path.join(__dirname, "..", "server", "server.js"),
    "utf8"
  );
  const serviceSource = fs.readFileSync(
    path.join(__dirname, "..", "services", "trackingService.js"),
    "utf8"
  );

  assert.doesNotMatch(serverSource, /startAutoStopScheduler\s*\(/);
  assert.doesNotMatch(
    serviceSource,
    /UPDATE truck_tracking_sessions[\s\S]{0,500}session_status = 'auto_stopped'/
  );
}

async function run() {
  await testClockTimesNeverAutoStop();
  testLegacySchedulerApiCannotStartATimer();
  await testAfterHoursStartsRemainAvailable();
  await testActiveTruckRemainsVisibleAfterTenPm();
  await testManualStopUsesActualRequestTimeAfterFivePm();
  await testWebAdminStopDelegatesWithoutClockPolicy();
  await testTrackingReportsRemainCompatible();
  await testTrackingCompletedBackfillUsesNumericReferenceComparison();
  testServerDoesNotStartTimeBasedScheduler();
  console.log("Tracking lifecycle tests passed: wall-clock times never stop sessions, after-hours start/visibility works, and explicit stop paths remain available.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
