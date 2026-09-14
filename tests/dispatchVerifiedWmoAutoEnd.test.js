const assert = require("node:assert/strict");
const Module = require("node:module");

const originalModuleLoad = Module._load;
Module._load = function loadWithMockedDispatchDependencies(request, parent, isMain) {
  const parentPath = parent?.filename.replace(/\\/g, "/") || "";
  if (
    request === "../config/dbPromise" &&
    parentPath.endsWith("services/dispatchService.js")
  ) {
    return {};
  }
  if (
    request === "../config/dbPromise" &&
    parentPath.endsWith("services/dispatchMonitorService.js")
  ) {
    return {};
  }
  if (
    request === "./dispatchService" &&
    parentPath.endsWith("services/dispatchMonitorService.js")
  ) {
    return {};
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
const { DispatchService } = require("../services/dispatchService");
const { DispatchMonitorService } = require("../services/dispatchMonitorService");
Module._load = originalModuleLoad;
const WMO = require("../utils/wmoGeofence");

const NOW = new Date("2026-09-14T10:00:00+08:00");

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function location(overrides = {}) {
  return {
    id: 800,
    latitude: WMO.latitude,
    longitude: WMO.longitude,
    accuracy: 10,
    recorded_at: "2026-09-14 09:59:30",
    ...overrides
  };
}

async function findEvidence(options = {}) {
  const service = new DispatchService({}, { now: () => NOW });
  const relation = options.relation === undefined
    ? {
        id: 7,
        dispatch_ticket_id: 91,
        tracking_session_id: 58,
        dispatch_status: "returning_to_wmo",
        session_status: "active",
        truck_id: "TRUCK-9",
        started_at: "2026-09-14 07:00:00",
        returning_to_wmo_at: "2026-09-14 09:55:00",
        ...(options.relationOverrides || {})
      }
    : options.relation;
  const logs = options.logs === undefined ? [location()] : options.logs;
  let relationSql = "";

  service.query = async (sql, parameters) => {
    const normalized = normalizeSql(sql);
    if (normalized.includes("FROM dispatch_tracking_sessions dts")) {
      relationSql = normalized;
      assert.deepEqual(parameters, [7]);
      return [relation ? [relation] : []];
    }
    if (normalized.includes("FROM truck_location_logs")) {
      assert.deepEqual(parameters, [58, "TRUCK-9"]);
      return [logs];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  };

  const evidence = await service.findVerifiedAutomaticWmoReturn(7, WMO);
  return { evidence, relationSql };
}

async function testQualifiedReturnRequiresTerminalStopsAndFreshReliableGps() {
  const verified = await findEvidence();
  assert.equal(verified.evidence.tracking_session_id, 58);
  assert.equal(verified.evidence.dispatch_ticket_id, 91);
  assert.equal(verified.evidence.recorded_at, "2026-09-14 09:59:30");
  assert.equal(verified.evidence.action_id, "server-verified-wmo-return:91");
  assert.ok(verified.evidence.distanceFromWmoMeters <= WMO.radiusMeters);
  assert.match(verified.relationSql, /dts\.is_primary = 1/);
  assert.match(verified.relationSql, /tts\.session_status = 'active'/);
  assert.match(verified.relationSql, /dt\.status IN \('dispatched', 'in_progress', 'returning_to_wmo'\)/);
  assert.match(verified.relationSql, /EXISTS \( SELECT 1 FROM dispatch_route_stops drs_any/);
  assert.match(verified.relationSql, /NOT EXISTS \( SELECT 1 FROM dispatch_route_stops drs_remaining/);
  assert.match(verified.relationSql, /stop_status NOT IN \('completed', 'skipped'\)/);

  const incomplete = await findEvidence({ relation: null });
  assert.equal(incomplete.evidence, null);

  const stale = await findEvidence({
    logs: [location({ recorded_at: "2026-09-14 09:54:59" })]
  });
  assert.equal(stale.evidence, null);

  const inaccurate = await findEvidence({ logs: [location({ accuracy: 50.01 })] });
  assert.equal(inaccurate.evidence, null);

  const outside = await findEvidence({ logs: [location({ latitude: 6.12 })] });
  assert.equal(outside.evidence, null);

  const preReturn = await findEvidence({
    relationOverrides: { returning_to_wmo_at: "2026-09-14 09:59:00" },
    logs: [location({ recorded_at: "2026-09-14 09:58:59" })]
  });
  assert.equal(preReturn.evidence, null);
}

async function testMonitorCompletesAndRefreshesExactlyOnce() {
  let available = true;
  let stopCalls = 0;
  let endedReconciliations = 0;
  const emitted = [];
  const relation = {
    id: 7,
    tracking_session_id: 58,
    cursor_id: 0,
    dispatch_status: "returning_to_wmo"
  };
  const pool = {
    async query(sql) {
      const normalized = normalizeSql(sql);
      if (normalized.includes("FROM dispatch_tracking_sessions dts")) return [[relation]];
      if (normalized.includes("FROM truck_location_logs")) return [[]];
      throw new Error(`Unexpected monitor SQL: ${normalized}`);
    }
  };
  const dispatch = {
    async reconcileStaleActiveOperations() {
      return { reconciled_count: 0 };
    },
    async findVerifiedAutomaticWmoReturn() {
      if (!available) return null;
      available = false;
      return {
        tracking_session_id: 58,
        dispatch_ticket_id: 91,
        action_id: "server-verified-wmo-return:91",
        recorded_at: "2026-09-14 09:59:30",
        end_latitude: WMO.latitude,
        end_longitude: WMO.longitude,
        end_accuracy: 10
      };
    },
    async reconcileEndedTrackingSession() {
      endedReconciliations += 1;
    }
  };
  const tracking = {
    async stopTrackingSessionAtVerifiedWmoReturn(sessionId, evidence) {
      stopCalls += 1;
      assert.equal(sessionId, 58);
      assert.equal(evidence.action_id, "server-verified-wmo-return:91");
      return { truck_id: "TRUCK-9" };
    }
  };
  const monitor = new DispatchMonitorService(pool, dispatch, tracking);
  monitor.io = {
    to(room) {
      assert.equal(room, "wmo");
      return { emit: (event, payload) => emitted.push({ event, payload }) };
    }
  };
  monitor.started = true;
  monitor.scheduleNextRun = () => {};

  await monitor.runCycle();
  await monitor.runCycle();

  assert.equal(stopCalls, 1);
  assert.equal(endedReconciliations, 2);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, "tracking:refresh");
  assert.equal(emitted[0].payload.reason, "verified_wmo_return");
  assert.equal(emitted[0].payload.session_id, 58);
  assert.equal(emitted[0].payload.dispatch_ticket_id, 91);
}

async function run() {
  await testQualifiedReturnRequiresTerminalStopsAndFreshReliableGps();
  await testMonitorCompletesAndRefreshesExactlyOnce();
  console.log("Dispatch verified WMO auto-end tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
