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
const {
  TrackingService,
  TrackingEndOperationsError
} = require("../services/trackingService");
Module._load = originalModuleLoad;

const WMO_EVIDENCE = Object.freeze({
  end_latitude: 6.1060875,
  end_longitude: 125.1816406,
  end_accuracy: 8,
  recorded_at: "2026-08-27 16:55:00",
  operation_intent: "end_operations",
  action_id: "END-58-20260827"
});

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function createService(dispatchCalls = []) {
  const service = new TrackingService({
    dispatchService: {
      async finalizeMobileTrackingEnd(sessionId, evidence) {
        dispatchCalls.push({ sessionId: Number(sessionId), evidence });
        return { outcome: "completed" };
      }
    }
  });
  service.ensureTrackingSessionReportColumns = async () => {};
  service.createTrackingCompletedNotification = async () => null;
  service.getManilaNowDateTime = () => "2026-08-27 18:00:00";
  return service;
}

function session(status = "active", endedAt = null) {
  return {
    id: 58,
    truck_id: "TRUCK-58",
    enforcer_name: "Test Enforcer",
    session_status: status,
    started_at: "2026-08-27 08:00:00",
    ended_at: endedAt,
    shift_end_time: "2026-08-27 17:00:00",
    effective_shift_end_time: "2026-08-27 17:00:00",
    last_updated_at: "2026-08-27 16:54:55",
    last_device_status: "active",
    last_location_status: "active",
    location_last_updated: "2026-08-27 16:54:55"
  };
}

async function testHistoricalWmoEvidenceControlsEndedAt() {
  const dispatchCalls = [];
  const service = createService(dispatchCalls);
  let sessionUpdate = null;

  queryHandler = async (sql, parameters = []) => {
    const normalized = normalizeSql(sql);
    if (normalized.includes("FROM truck_tracking_sessions tts")) {
      return [[session()]];
    }
    if (normalized.startsWith("UPDATE truck_tracking_sessions")) {
      sessionUpdate = parameters;
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith("UPDATE truck_last_locations")) {
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  };

  const result = await service.stopTrackingSession(58, WMO_EVIDENCE);
  assert.equal(result.success, true);
  assert.equal(result.already_stopped, false);
  assert.equal(sessionUpdate[0], "manual_wmo_stop");
  assert.equal(sessionUpdate[1], "2026-08-27 16:55:00");
  assert.equal(sessionUpdate[7], WMO_EVIDENCE.end_latitude);
  assert.equal(sessionUpdate[8], WMO_EVIDENCE.end_longitude);
  assert.equal(dispatchCalls.length, 1);
  assert.equal(dispatchCalls[0].evidence.recorded_at, "2026-08-27 16:55:00");
  assert.equal(dispatchCalls[0].evidence.action_id, WMO_EVIDENCE.action_id);
}

async function testOutsideWmoEndOperationsIsRejectedBeforeUpdate() {
  const service = createService();
  let updated = false;
  queryHandler = async (sql) => {
    const normalized = normalizeSql(sql);
    if (normalized.includes("FROM truck_tracking_sessions tts")) {
      return [[session()]];
    }
    if (normalized.startsWith("UPDATE")) updated = true;
    throw new Error(`Unexpected SQL: ${normalized}`);
  };

  await assert.rejects(
    () => service.stopTrackingSession(58, {
      ...WMO_EVIDENCE,
      end_latitude: 6.15,
      end_longitude: 125.20
    }),
    (error) => error instanceof TrackingEndOperationsError &&
      error.code === "TRACKING_END_OUTSIDE_WMO"
  );
  assert.equal(updated, false);
}

async function testRepeatedEndActionIsIdempotent() {
  const dispatchCalls = [];
  const service = createService(dispatchCalls);
  queryHandler = async (sql) => {
    const normalized = normalizeSql(sql);
    if (normalized.includes("FROM truck_tracking_sessions tts")) {
      return [[session("manual_wmo_stop", "2026-08-27 16:55:00")]];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  };

  const result = await service.stopTrackingSession(58, WMO_EVIDENCE);
  assert.equal(result.already_stopped, true);
  assert.equal(dispatchCalls.length, 1);
  assert.equal(dispatchCalls[0].evidence.action_id, WMO_EVIDENCE.action_id);
}

async function testForcedRolloverHasNoWmoEvidence() {
  const dispatchCalls = [];
  const service = createService(dispatchCalls);
  service.getManilaNowDateTime = () => "2026-08-28 00:00:05";
  let sessionUpdate = null;
  queryHandler = async (sql, parameters = []) => {
    const normalized = normalizeSql(sql);
    if (normalized.includes("FROM truck_tracking_sessions tts")) {
      return [[session()]];
    }
    if (normalized.startsWith("UPDATE truck_tracking_sessions")) {
      sessionUpdate = parameters;
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith("UPDATE truck_last_locations")) {
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  };

  await service.stopTrackingSession(58, {
    operation_intent: "forced_day_rollover",
    action_id: "ROLLOVER-58-20260828",
    recorded_at: "2026-08-28 00:00:00"
  });
  assert.equal(sessionUpdate[0], "auto_stopped");
  assert.equal(sessionUpdate[1], "2026-08-28 00:00:00");
  assert.equal(sessionUpdate[7], null);
  assert.equal(sessionUpdate[8], null);
  assert.equal(dispatchCalls[0].evidence.latitude, null);
  assert.equal(dispatchCalls[0].evidence.longitude, null);
}

async function testForcedRolloverRequiresManilaMidnight() {
  const service = createService();
  service.getManilaNowDateTime = () => "2026-08-28 00:01:00";
  queryHandler = async (sql) => {
    const normalized = normalizeSql(sql);
    if (normalized.includes("FROM truck_tracking_sessions tts")) {
      return [[session()]];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  };

  await assert.rejects(
    () => service.stopTrackingSession(58, {
      operation_intent: "forced_day_rollover",
      action_id: "ROLLOVER-58-BAD-TIME",
      recorded_at: "2026-08-27 23:59:59"
    }),
    (error) => error instanceof TrackingEndOperationsError &&
      error.code === "TRACKING_DAY_ROLLOVER_TIMESTAMP_INVALID"
  );
}

async function testPointAfterHistoricalEndIsRejected() {
  const service = createService();
  service.ensureOfflineTrackingColumns = async () => {};
  queryHandler = async (sql) => {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith("SELECT id, truck_id, session_status")) {
      return [[{
        id: 58,
        truck_id: "TRUCK-58",
        session_status: "manual_wmo_stop",
        shift_end_time: "2026-08-27 17:00:00",
        ended_at: "2026-08-27 16:55:00"
      }]];
    }
    if (normalized.startsWith("SELECT id FROM truck_location_logs")) return [[]];
    throw new Error(`Unexpected SQL: ${normalized}`);
  };

  await assert.rejects(
    () => service.addSingleLocationLog(58, {
      latitude: 6.12,
      longitude: 125.19,
      accuracy: 10,
      recorded_at: "2026-08-27 17:05:00",
      local_point_id: "HOME-ROUTE-POINT"
    }),
    /no longer active/
  );
}

async function testQueuedPointAtOrBeforeHistoricalEndIsAccepted() {
  const service = createService();
  service.ensureOfflineTrackingColumns = async () => {};
  let insertedParameters = null;
  queryHandler = async (sql, parameters = []) => {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith("SELECT id, truck_id, session_status")) {
      return [[{
        id: 58,
        truck_id: "TRUCK-58",
        session_status: "manual_wmo_stop",
        shift_end_time: "2026-08-27 17:00:00",
        ended_at: "2026-08-27 16:55:00"
      }]];
    }
    if (normalized.startsWith("SELECT id FROM truck_location_logs")) return [[]];
    if (normalized.startsWith("INSERT INTO truck_location_logs")) {
      insertedParameters = parameters;
      return [{ insertId: 700 }];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  };

  const result = await service.addSingleLocationLog(58, {
    latitude: 6.1060875,
    longitude: 125.1816406,
    accuracy: 8,
    recorded_at: "2026-08-27 16:55:00",
    local_point_id: "FINAL-WMO-POINT"
  }, { skipRouteRecalculation: true });

  assert.equal(result.duplicate, false);
  assert.equal(insertedParameters[8], "FINAL-WMO-POINT");
  assert.equal(insertedParameters[10], "2026-08-27 16:55:00");
  assert.equal(insertedParameters[9], "mobile_offline_queue");
}

async function run() {
  await testHistoricalWmoEvidenceControlsEndedAt();
  await testOutsideWmoEndOperationsIsRejectedBeforeUpdate();
  await testRepeatedEndActionIsIdempotent();
  await testForcedRolloverHasNoWmoEvidence();
  await testForcedRolloverRequiresManilaMidnight();
  await testPointAfterHistoricalEndIsRejected();
  await testQueuedPointAtOrBeforeHistoricalEndIsAccepted();
  console.log("Tracking end-operations tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
