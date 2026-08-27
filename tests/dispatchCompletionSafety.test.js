const assert = require("node:assert/strict");
const Module = require("node:module");

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
const { DispatchService } = require("../services/dispatchService");
Module._load = originalModuleLoad;
const { formatManilaDateTime, LIVE_LOCATION_FRESHNESS_MS } = require("../utils/gpsValidation");

const WMO = Object.freeze({
  latitude: 6.1060875,
  longitude: 125.1816406,
  radiusMeters: 100
});

function freshTime(offsetMs = 0) {
  return formatManilaDateTime(Date.now() + offsetMs);
}

async function reconcile(overrides = {}, options = {}) {
  const relation = {
    id: 1,
    dispatch_ticket_id: 11,
    tracking_session_id: 101,
    dispatch_status: "returning_to_wmo",
    session_status: "stopped",
    truck_id: "TRUCK-9",
    ended_at: freshTime(),
    end_latitude: WMO.latitude,
    end_longitude: WMO.longitude,
    last_latitude: WMO.latitude,
    last_longitude: WMO.longitude,
    current_location_session_id: 101,
    current_latitude: WMO.latitude,
    current_longitude: WMO.longitude,
    current_accuracy: 10,
    current_recorded_at: freshTime(),
    ...overrides
  };
  const actualLogs = options.actualLogs === undefined
    ? [{
        latitude: WMO.latitude,
        longitude: WMO.longitude,
        accuracy: 10,
        recorded_at: freshTime()
      }]
    : options.actualLogs;
  let completionUpdates = 0;
  let locationLookups = 0;
  const events = [];
  const connection = {
    async query(sql, parameters = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.includes("FROM dispatch_tracking_sessions dts")) {
        return [[relation]];
      }
      if (normalized.includes("FROM truck_location_logs")) {
        locationLookups += 1;
        assert.match(normalized, /WHERE session_id = \? AND truck_id = \?/);
        assert.match(normalized, /ORDER BY recorded_at DESC, id DESC LIMIT 25/);
        assert.deepEqual(parameters, [101, "TRUCK-9"]);
        return [actualLogs];
      }
      if (normalized.startsWith("UPDATE dispatch_tickets")) {
        completionUpdates += 1;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected query: ${normalized}`);
    }
  };
  const service = new DispatchService();
  service.withTransaction = async (callback) => callback(connection);
  service.moveTicketToReturningIfDone = async () => options.allTerminal !== false;
  service.insertEvent = async (_connection, event) => {
    events.push(event);
  };

  await service.reconcileEndedTrackingSession(1, WMO);
  return { completionUpdates, events, locationLookups };
}

async function testQualifiedCompletionCases() {
  const explicitInside = await reconcile();
  assert.equal(explicitInside.completionUpdates, 1);
  assert.deepEqual(
    explicitInside.events.map((event) => event.event_type),
    ["returned_to_wmo", "dispatch_completed"]
  );
  assert.equal(explicitInside.events[0].accuracy_meters, 10);

  const boundaryLatitude = WMO.latitude +
    ((WMO.radiusMeters / 6371000) * (180 / Math.PI));
  const boundary = await reconcile({
    end_latitude: boundaryLatitude
  }, {
    actualLogs: [{
      latitude: boundaryLatitude,
      longitude: WMO.longitude,
      accuracy: 10,
      recorded_at: freshTime()
    }]
  });
  assert.equal(boundary.completionUpdates, 1, "the 100-meter boundary is inclusive");

  const freshActualInside = await reconcile({
    end_latitude: null,
    end_longitude: null
  });
  assert.equal(freshActualInside.completionUpdates, 1);

  const delayedAfterStoppedSession = await reconcile({
    ended_at: "2026-08-27 12:30:00",
    end_latitude: null,
    end_longitude: null
  }, {
    actualLogs: [{
      latitude: WMO.latitude,
      longitude: WMO.longitude,
      accuracy: 10,
      recorded_at: "2026-08-27 12:29:30"
    }]
  });
  assert.equal(
    delayedAfterStoppedSession.completionUpdates,
    1,
    "late uploaded evidence stays fresh relative to the tracking end time"
  );
}

async function testUnqualifiedPositionsDoNotComplete() {
  const outsideLatitude = WMO.latitude + 0.01;
  const cases = [
    {
      name: "explicit outside",
      values: { end_latitude: outsideLatitude },
      actualLogs: [{
        latitude: outsideLatitude,
        longitude: WMO.longitude,
        accuracy: 10,
        recorded_at: freshTime()
      }]
    },
    {
      name: "explicit inside with stale actual log",
      values: {},
      actualLogs: [{
        latitude: WMO.latitude,
        longitude: WMO.longitude,
        accuracy: 10,
        recorded_at: freshTime(-LIVE_LOCATION_FRESHNESS_MS - 1000)
      }]
    },
    {
      name: "fresh legacy cache with stale actual log",
      values: { end_latitude: null, end_longitude: null, current_recorded_at: freshTime() },
      actualLogs: [{
        latitude: WMO.latitude,
        longitude: WMO.longitude,
        accuracy: 10,
        recorded_at: freshTime(-LIVE_LOCATION_FRESHNESS_MS - 1000)
      }]
    },
    {
      name: "fresh legacy cache with no actual log",
      values: { end_latitude: null, end_longitude: null, current_recorded_at: freshTime() },
      actualLogs: []
    },
    {
      name: "fresh actual log outside WMO",
      values: { end_latitude: null, end_longitude: null },
      actualLogs: [{
        latitude: outsideLatitude,
        longitude: WMO.longitude,
        accuracy: 10,
        recorded_at: freshTime()
      }]
    },
    {
      name: "poor-accuracy actual log",
      values: { end_latitude: null, end_longitude: null },
      actualLogs: [{
        latitude: WMO.latitude,
        longitude: WMO.longitude,
        accuracy: 50.01,
        recorded_at: freshTime()
      }]
    },
    {
      name: "future actual log",
      values: { end_latitude: null, end_longitude: null },
      actualLogs: [{
        latitude: WMO.latitude,
        longitude: WMO.longitude,
        accuracy: 10,
        recorded_at: freshTime(61000)
      }]
    },
    {
      name: "invalid actual point",
      values: { end_latitude: null, end_longitude: null },
      actualLogs: [{
        latitude: 91,
        longitude: WMO.longitude,
        accuracy: 10,
        recorded_at: freshTime()
      }]
    },
    {
      name: "zero actual point",
      values: { end_latitude: null, end_longitude: null },
      actualLogs: [{ latitude: 0, longitude: 0, accuracy: 10, recorded_at: freshTime() }]
    },
    {
      name: "explicit point disagrees with qualified actual log",
      values: {},
      actualLogs: [{
        latitude: outsideLatitude,
        longitude: WMO.longitude,
        accuracy: 10,
        recorded_at: freshTime()
      }]
    }
  ];

  for (const item of cases) {
    const result = await reconcile(item.values, { actualLogs: item.actualLogs });
    assert.equal(result.completionUpdates, 0, item.name);
    assert.deepEqual(result.events, [], item.name);
  }
}

async function testLifecycleGuardsRemainIndependent() {
  const active = await reconcile({ session_status: "active" });
  assert.equal(active.completionUpdates, 0);
  assert.deepEqual(active.events, []);
  assert.equal(active.locationLookups, 0);

  const closedEarly = await reconcile({ dispatch_status: "cancelled" });
  assert.equal(closedEarly.completionUpdates, 0);
  assert.deepEqual(closedEarly.events, []);
  assert.equal(closedEarly.locationLookups, 0);

  const incompleteStops = await reconcile({}, { allTerminal: false });
  assert.equal(incompleteStops.completionUpdates, 0);
  assert.deepEqual(incompleteStops.events, []);
  assert.equal(incompleteStops.locationLookups, 0);
}

async function run() {
  await testQualifiedCompletionCases();
  await testUnqualifiedPositionsDoNotComplete();
  await testLifecycleGuardsRemainIndependent();
  console.log("Dispatch completion GPS-safety tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
