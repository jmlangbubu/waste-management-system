const assert = require("node:assert/strict");
const Module = require("node:module");

const originalModuleLoad = Module._load;
Module._load = function loadWithMockedDispatchDependencies(request, parent, isMain) {
  if (
    request === "../config/dbPromise" &&
    /services\/(dispatchMonitorService|dispatchService)\.js$/.test(
      parent?.filename.replace(/\\/g, "/") || ""
    )
  ) {
    return {};
  }
  if (
    request === "./dispatchService" &&
    parent?.filename.replace(/\\/g, "/").endsWith("services/dispatchMonitorService.js")
  ) {
    return {};
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
const {
  DispatchMonitorService
} = require("../services/dispatchMonitorService");
const {
  DispatchService,
  DISPATCH_HISTORY_REPLAY_PAGE_SIZE,
  createDispatchHistoryReplayState,
  applyDispatchHistoryLocation
} = require("../services/dispatchService");
Module._load = originalModuleLoad;

function compareChronology(left, right) {
  return String(left.recorded_at).localeCompare(String(right.recorded_at)) ||
    Number(left.id) - Number(right.id);
}

async function proveLegacyCursorAppendsLateHistoryOutOfOrder() {
  const relation = {
    id: 7,
    tracking_session_id: 58,
    cursor_id: 0
  };
  const logs = [
    { id: 1, session_id: 58, recorded_at: "2026-08-27 12:20:00" },
    { id: 2, session_id: 58, recorded_at: "2026-08-27 12:25:00" },
    { id: 3, session_id: 58, recorded_at: "2026-08-27 12:35:00" },
    { id: 4, session_id: 58, recorded_at: "2026-08-27 12:40:00" }
  ];
  const processed = [];

  const pool = {
    async query(sql, parameters) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.includes("MAX(recorded_at)")) {
        const cursor = Number(parameters[1] || 0);
        const latest = logs
          .filter((log) => log.id <= cursor)
          .sort(compareChronology)
          .at(-1)?.recorded_at || null;
        return [[{ latest_processed_recorded_at: latest }]];
      }
      const cursor = Number(parameters[1] || 0);
      const limit = Number(parameters[2] || 500);
      return [[...logs]
        .filter((log) => log.session_id === Number(parameters[0]) && log.id > cursor)
        .sort((left, right) => left.id - right.id)
        .slice(0, limit)];
    }
  };
  const service = {
    async processAutomaticLocationLog(_relationId, log) {
      processed.push(log.recorded_at);
      relation.cursor_id = Math.max(relation.cursor_id, log.id);
    },
    async reconcileAutomaticDispatchHistory() {
      processed.splice(
        0,
        processed.length,
        ...[...logs].sort(compareChronology).map((log) => log.recorded_at)
      );
      relation.cursor_id = Math.max(...logs.map((log) => log.id));
    },
    async reconcileEndedTrackingSession() {}
  };
  const monitor = new DispatchMonitorService(pool, service);

  await monitor.processRelation(relation);

  logs.push(
    { id: 5, session_id: 58, recorded_at: "2026-08-27 12:00:00" },
    { id: 6, session_id: 58, recorded_at: "2026-08-27 12:05:00" },
    { id: 7, session_id: 58, recorded_at: "2026-08-27 12:10:00" },
    { id: 8, session_id: 58, recorded_at: "2026-08-27 12:30:00" }
  );
  await monitor.processRelation(relation);

  const expected = [...logs]
    .sort(compareChronology)
    .map((log) => log.recorded_at);
  assert.deepEqual(
    processed,
    expected,
    "late rows with newer IDs must be reconstructed in authoritative recorded_at order"
  );
}

async function testMonitorPagesBeyondFiveHundredWithoutGaps() {
  const logs = buildLargeTimeline(1200);
  const processedIds = [];
  let endedReconciliations = 0;
  const pool = {
    async query(sql, parameters) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      assert.doesNotMatch(normalized, /ORDER BY recorded_at ASC, id ASC/);
      const cursor = Number(parameters[1] || 0);
      const limit = Number(parameters[2] || 500);
      return [[...logs]
        .filter((log) => log.id > cursor)
        .sort((left, right) => left.id - right.id)
        .slice(0, limit)];
    }
  };
  const service = {
    async processAutomaticLocationLog(_relationId, log) {
      processedIds.push(log.id);
    },
    async reconcileAutomaticDispatchHistory() {
      throw new Error("chronological monotonic input must stay on the fast path");
    },
    async reconcileEndedTrackingSession() {
      endedReconciliations += 1;
    }
  };
  const monitor = new DispatchMonitorService(pool, service);
  await monitor.processRelation({
    id: 7,
    tracking_session_id: 58,
    cursor_id: 0,
    dispatch_status: "in_progress"
  });

  assert.equal(processedIds.length, 1200);
  assert.deepEqual(processedIds, Array.from({ length: 1200 }, (_, index) => index + 1));
  assert.equal(endedReconciliations, 1);
}

async function testWithinPageIdChronologyMismatchTriggersReplay() {
  const logs = [
    gps(1, "2026-08-27 12:20:00", 150),
    gps(2, "2026-08-27 12:00:00", 25),
    gps(3, "2026-08-27 12:30:00", 150)
  ];
  let replayCount = 0;
  let incrementalCount = 0;
  const pool = {
    async query(_sql, parameters) {
      return [[...logs]
        .filter((log) => log.id > Number(parameters[1] || 0))
        .sort((left, right) => left.id - right.id)
        .slice(0, Number(parameters[2] || 500))];
    }
  };
  const service = {
    async processAutomaticLocationLog() { incrementalCount += 1; },
    async reconcileAutomaticDispatchHistory() { replayCount += 1; },
    async reconcileEndedTrackingSession() {}
  };
  const monitor = new DispatchMonitorService(pool, service);
  await monitor.processRelation({
    id: 7,
    tracking_session_id: 58,
    cursor_id: 0,
    dispatch_status: "in_progress"
  });
  assert.equal(replayCount, 1);
  assert.equal(incrementalCount, 0);
}

function distanceLatitude(latitude, meters) {
  return latitude + ((meters / 6371000) * (180 / Math.PI));
}

function stop(overrides = {}) {
  return {
    id: 11,
    dispatch_ticket_id: 91,
    stop_order: 1,
    stop_status: "on_the_way",
    latitude: 6.116,
    longitude: 125.171,
    geofence_radius_meters: 100,
    actual_arrival_at: null,
    arrival_source: null,
    arrival_candidate_at: null,
    arrival_candidate_count: 0,
    actual_departure_at: null,
    departure_source: null,
    departure_candidate_at: null,
    departure_candidate_count: 0,
    stop_duration_seconds: null,
    completed_at: null,
    skipped_at: null,
    ...overrides
  };
}

function gps(id, recordedAt, distanceMeters, overrides = {}) {
  return {
    id,
    session_id: 58,
    latitude: distanceLatitude(6.116, distanceMeters),
    longitude: 125.171,
    accuracy: 10,
    recorded_at: recordedAt,
    local_point_id: `point-${id}`,
    ...overrides
  };
}

function authoritativeTimeline() {
  return [
    gps(1, "2026-08-27 12:00:00", 25),
    gps(2, "2026-08-27 12:00:30", 20),
    gps(3, "2026-08-27 12:01:05", 30),
    gps(4, "2026-08-27 12:30:00", 150),
    gps(5, "2026-08-27 12:30:15", 155),
    gps(6, "2026-08-27 12:30:35", 160)
  ];
}

function reconstruct(logs, options = {}) {
  const replay = createDispatchHistoryReplayState(
    options.stops || [stop()],
    options.events || [],
    { ticketStatus: options.ticketStatus || "in_progress" }
  );
  const uniqueLogs = [...new Map(
    logs.map((log) => [log.local_point_id || `id:${log.id}`, log])
  ).values()].sort(compareChronology);
  for (const log of uniqueLogs) {
    applyDispatchHistoryLocation(replay, log, {
      referenceTimeMs: Date.parse("2026-08-27T14:00:00+08:00"),
      cutoffMs: options.cutoffMs
    });
  }
  return replay;
}

function finalStopSummary(replay) {
  const result = replay.stops[0];
  const arrivalMs = Date.parse(`${result.replay_arrival_at.replace(" ", "T")}+08:00`);
  const departureMs = Date.parse(`${result.replay_departure_at.replace(" ", "T")}+08:00`);
  return {
    arrival: result.replay_arrival_at,
    departure: result.replay_departure_at,
    dwell: Math.floor((departureMs - arrivalMs) / 1000),
    arrivalEvents: result.replay_arrival_event ? 1 : 0,
    departureEvents: result.replay_departure_event ? 1 : 0
  };
}

function testInsertionOrderInvariantReconstruction() {
  const timeline = authoritativeTimeline();
  const orders = [
    timeline,
    [...timeline].reverse(),
    [timeline[3], timeline[4], timeline[0], timeline[5], timeline[2], timeline[1]],
    [...timeline.slice(3), ...timeline.slice(0, 3)],
    [...timeline, ...timeline],
    [...timeline.slice(0, 4), ...timeline.slice(2)]
  ];
  const expected = {
    arrival: "2026-08-27 12:00:00",
    departure: "2026-08-27 12:30:00",
    dwell: 1800,
    arrivalEvents: 1,
    departureEvents: 1
  };

  for (const order of orders) {
    assert.deepEqual(finalStopSummary(reconstruct(order)), expected);
  }
}

function testGpsPolicyAndManualProtection() {
  const invalid = [
    gps(1, "2026-08-27 12:00:00", 0, { latitude: 0, longitude: 0 }),
    gps(2, "2026-08-27 12:00:30", 0, { accuracy: 50.01 }),
    gps(3, "2026-08-27 14:01:01", 0),
    gps(4, "2026-08-27 12:01:30", 0, { session_id: 999 })
  ];
  const relevant = invalid.filter((log) => log.session_id === 58);
  const replay = reconstruct(relevant);
  assert.equal(replay.stops[0].replay_arrival_at, null);

  const skipped = stop({
    stop_status: "skipped",
    skipped_at: "2026-08-27 12:05:00"
  });
  const skippedReplay = reconstruct(authoritativeTimeline(), { stops: [skipped] });
  assert.equal(skippedReplay.stops[0].stop_status, "skipped");
  assert.equal(skippedReplay.stops[0].replay_arrival_at, null);

  const manual = stop({
    stop_status: "completed",
    actual_arrival_at: "2026-08-27 11:59:00",
    arrival_source: "manual",
    actual_departure_at: "2026-08-27 12:31:00",
    departure_source: "manual",
    completed_at: "2026-08-27 12:31:00"
  });
  const manualReplay = reconstruct(authoritativeTimeline(), {
    stops: [manual],
    ticketStatus: "completed"
  });
  assert.equal(manualReplay.stops[0].replay_arrival_at, "2026-08-27 11:59:00");
  assert.equal(manualReplay.stops[0].replay_departure_at, "2026-08-27 12:31:00");
}

function testTerminalLifecycleAndStopOrderProtection() {
  const existingEvents = [
    {
      id: 101,
      dispatch_route_stop_id: 11,
      event_type: "arrived_at_stop",
      event_source: "automatic",
      event_at: "2026-08-27 12:05:00"
    },
    {
      id: 102,
      dispatch_route_stop_id: 11,
      event_type: "departed_stop",
      event_source: "automatic",
      event_at: "2026-08-27 12:35:00"
    }
  ];
  const previouslyLate = stop({
    stop_status: "completed",
    actual_arrival_at: "2026-08-27 12:05:00",
    arrival_source: "automatic",
    actual_departure_at: "2026-08-27 12:35:00",
    departure_source: "automatic",
    completed_at: "2026-08-27 12:35:00"
  });
  for (const ticketStatus of ["completed", "cancelled"]) {
    const replay = reconstruct(authoritativeTimeline(), {
      stops: [previouslyLate],
      events: existingEvents,
      ticketStatus,
      cutoffMs: Date.parse("2026-08-27T13:00:00+08:00")
    });
    assert.deepEqual(finalStopSummary(replay), {
      arrival: "2026-08-27 12:00:00",
      departure: "2026-08-27 12:30:00",
      dwell: 1800,
      arrivalEvents: 1,
      departureEvents: 1
    });
    assert.equal(replay.ticket_status, ticketStatus);
  }

  const stopTwo = stop({
    id: 12,
    stop_order: 2,
    latitude: 6.13,
    longitude: 125.18,
    stop_status: "pending"
  });
  const earlyStopTwoLogs = [
    {
      ...gps(20, "2026-08-27 11:50:00", 0),
      latitude: stopTwo.latitude,
      longitude: stopTwo.longitude
    },
    {
      ...gps(21, "2026-08-27 11:51:00", 0),
      latitude: stopTwo.latitude,
      longitude: stopTwo.longitude
    },
    {
      ...gps(22, "2026-08-27 11:52:00", 0),
      latitude: stopTwo.latitude,
      longitude: stopTwo.longitude
    }
  ];
  const replay = reconstruct([...earlyStopTwoLogs, ...authoritativeTimeline()], {
    stops: [stop(), stopTwo]
  });
  assert.equal(replay.stops[1].replay_arrival_at, null);
}

function buildLargeTimeline(count) {
  const base = Date.parse("2026-08-27T10:00:00+08:00");
  const logs = [];
  for (let index = 0; index < count; index++) {
    const recordedAt = new Date(base + index * 1000 + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    const distance = index < 65 ? 25 : 160;
    logs.push(gps(index + 1, recordedAt, distance));
  }
  return logs;
}

function testBoundedLargeHistoryObservations() {
  assert.equal(DISPATCH_HISTORY_REPLAY_PAGE_SIZE, 500);
  for (const count of [500, 1200, 3600]) {
    const logs = buildLargeTimeline(count);
    const startedAt = performance.now();
    const replay = reconstruct([...logs].reverse());
    const durationMs = performance.now() - startedAt;
    assert.equal(replay.stops[0].replay_arrival_at, "2026-08-27 10:00:00");
    assert.ok(replay.stops[0].replay_departure_at);
    assert.equal(Math.ceil(count / DISPATCH_HISTORY_REPLAY_PAGE_SIZE), Math.ceil(count / 500));
    console.log(
      `Historical replay observation: rows=${count} pages=${Math.ceil(count / 500)} duration_ms=${durationMs.toFixed(2)}`
    );
  }
}

function testMultipleSeventyFivePointBatchesConverge() {
  const logs = buildLargeTimeline(225);
  const batches = [
    logs.slice(0, 75),
    logs.slice(75, 150),
    logs.slice(150, 225)
  ];
  const uploadOrders = [
    batches,
    [...batches].reverse(),
    [batches[1], batches[0], batches[2]],
    [batches[0], batches[1], batches[1], batches[2]],
    [batches[0].slice(0, 40), batches[0], batches[2], batches[1]]
  ];
  const expected = finalStopSummary(reconstruct(logs));

  for (const uploadOrder of uploadOrders) {
    assert.deepEqual(
      finalStopSummary(reconstruct(uploadOrder.flat())),
      expected
    );
  }
}

function createPersistenceHarness(logs, options = {}) {
  const initialStop = stop({
    stop_status: "completed",
    actual_arrival_at: "2026-08-27 10:05:00",
    arrival_source: "automatic",
    actual_departure_at: "2026-08-27 10:10:00",
    departure_source: "automatic",
    stop_duration_seconds: 300,
    completed_at: "2026-08-27 10:10:00"
  });
  const state = {
    relation: {
      id: 7,
      dispatch_ticket_id: 91,
      tracking_session_id: 58,
      last_processed_location_log_id: Number(options.cursorId || 0),
      dispatch_status: options.dispatchStatus || "completed",
      actual_end_at: null,
      cancelled_at: null,
      dispatch_completed_at: null,
      session_status: options.sessionStatus || "stopped",
      tracking_started_at: "2026-08-27 09:00:00",
      tracking_ended_at: options.trackingEndedAt || "2026-08-27 14:00:00"
    },
    stops: [initialStop],
    events: [
      {
        id: 201,
        dispatch_ticket_id: 91,
        dispatch_route_stop_id: 11,
        tracking_session_id: 58,
        event_type: "arrived_at_stop",
        event_source: "automatic",
        event_at: "2026-08-27 10:05:00",
        idempotency_key: "auto-arrive:91:11"
      },
      {
        id: 202,
        dispatch_ticket_id: 91,
        dispatch_route_stop_id: 11,
        tracking_session_id: 58,
        event_type: "departed_stop",
        event_source: "automatic",
        event_at: "2026-08-27 10:10:00",
        idempotency_key: "auto-depart:91:11"
      }
    ],
    pages: 0,
    commits: 0,
    rollbacks: 0,
    failEventUpdateOnce: options.failEventUpdateOnce === true
  };
  if (options.includeReturningEvent) {
    state.events.push({
      id: 203,
      dispatch_ticket_id: 91,
      dispatch_route_stop_id: null,
      tracking_session_id: 58,
      event_type: "returning_to_wmo",
      event_source: options.returningEventSource || "automatic",
      event_at: "2026-08-27 10:10:00",
      idempotency_key: "returning-to-wmo:91"
    });
  }
  let snapshot = null;

  const connection = {
    async beginTransaction() {
      snapshot = JSON.stringify({
        relation: state.relation,
        stops: state.stops,
        events: state.events
      });
    },
    async commit() {
      state.commits += 1;
      snapshot = null;
    },
    async rollback() {
      state.rollbacks += 1;
      if (snapshot) {
        const restored = JSON.parse(snapshot);
        state.relation = restored.relation;
        state.stops = restored.stops;
        state.events = restored.events;
      }
      snapshot = null;
    },
    release() {},
    async query(sql, parameters = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized.includes("FROM dispatch_tracking_sessions dts")) {
        return [[{ ...state.relation }]];
      }
      if (normalized.includes("FROM dispatch_route_stops")) {
        return [[...state.stops]];
      }
      if (normalized.startsWith("SELECT * FROM dispatch_events")) {
        return [[...state.events]];
      }
      if (normalized.includes("MAX(id)") && normalized.includes("truck_location_logs")) {
        return [[{
          max_location_log_id: logs.length
            ? Math.max(...logs.map((log) => Number(log.id)))
            : 0
        }]];
      }
      if (normalized.includes("FROM truck_location_logs")) {
        state.pages += 1;
        const maxId = Number(parameters[1]);
        const hasCheckpoint = parameters.length > 3;
        const afterAt = hasCheckpoint ? parameters[2] : null;
        const afterId = hasCheckpoint ? Number(parameters[4]) : 0;
        const limit = Number(parameters.at(-1));
        return [[...logs]
          .filter((log) => Number(log.id) <= maxId)
          .sort(compareChronology)
          .filter((log) => !afterAt ||
            String(log.recorded_at) > String(afterAt) ||
            (String(log.recorded_at) === String(afterAt) && Number(log.id) > afterId))
          .slice(0, limit)];
      }
      if (normalized.startsWith("UPDATE dispatch_route_stops")) {
        const target = state.stops.find((item) => Number(item.id) === Number(parameters[11]));
        Object.assign(target, {
          stop_status: parameters[0],
          actual_arrival_at: parameters[1],
          arrival_source: parameters[2],
          arrival_candidate_at: parameters[3],
          arrival_candidate_count: parameters[4],
          actual_departure_at: parameters[5],
          departure_source: parameters[6],
          departure_candidate_at: parameters[7],
          departure_candidate_count: parameters[8],
          stop_duration_seconds: parameters[9],
          completed_at: parameters[10]
        });
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith("UPDATE dispatch_events")) {
        if (state.failEventUpdateOnce) {
          state.failEventUpdateOnce = false;
          throw new Error("simulated replay event failure");
        }
        if (parameters.length === 3) {
          const event = state.events.find((item) =>
            Number(item.id) === Number(parameters[2]));
          Object.assign(event, {
            tracking_session_id: parameters[0],
            event_at: parameters[1]
          });
          return [{ affectedRows: 1 }];
        }
        const event = state.events.find((item) => Number(item.id) === Number(parameters[6]));
        Object.assign(event, {
          tracking_session_id: parameters[0],
          event_at: parameters[1],
          latitude: parameters[2],
          longitude: parameters[3],
          accuracy_meters: parameters[4],
          details: parameters[5]
        });
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith("UPDATE dispatch_tickets")) {
        state.relation.returning_to_wmo_at = parameters[0];
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith("DELETE FROM dispatch_events")) {
        state.events = state.events.filter((item) => Number(item.id) !== Number(parameters[0]));
        return [{ affectedRows: 1 }];
      }
      if (normalized.startsWith("INSERT INTO dispatch_events")) {
        state.events.push({
          id: 300 + state.events.length,
          dispatch_ticket_id: parameters[0],
          dispatch_route_stop_id: parameters[1],
          tracking_session_id: parameters[2],
          event_type: parameters[3],
          event_at: parameters[4],
          event_source: parameters[5],
          details: parameters[12],
          idempotency_key: parameters[13]
        });
        return [{ insertId: state.events.at(-1).id }];
      }
      if (normalized.startsWith("UPDATE dispatch_tracking_sessions")) {
        state.relation.last_processed_location_log_id = Math.max(
          Number(state.relation.last_processed_location_log_id || 0),
          Number(parameters[0])
        );
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected replay persistence SQL: ${normalized}`);
    }
  };
  const pool = { async getConnection() { return connection; } };
  return { state, service: new DispatchService(pool, {
    now: () => new Date("2026-08-27T14:00:00+08:00")
  }) };
}

async function testPagedPersistenceAndTransactionRetry() {
  const logs = buildLargeTimeline(1200);
  const harness = createPersistenceHarness(logs, {
    failEventUpdateOnce: true
  });

  await assert.rejects(
    () => harness.service.reconcileAutomaticDispatchHistory(7),
    /simulated replay event failure/
  );
  assert.equal(harness.state.rollbacks, 1);
  assert.equal(harness.state.commits, 0);
  assert.equal(harness.state.relation.last_processed_location_log_id, 0);
  assert.equal(harness.state.stops[0].actual_arrival_at, "2026-08-27 10:05:00");
  assert.equal(harness.state.events[0].event_at, "2026-08-27 10:05:00");

  const result = await harness.service.reconcileAutomaticDispatchHistory(7);
  assert.equal(result.rows_processed, 1200);
  assert.equal(result.pages_processed, 3);
  assert.equal(harness.state.commits, 1);
  assert.equal(harness.state.relation.last_processed_location_log_id, 1200);
  assert.equal(harness.state.stops[0].actual_arrival_at, "2026-08-27 10:00:00");
  assert.equal(harness.state.stops[0].stop_duration_seconds, 65);
  assert.equal(harness.state.events.filter((event) =>
    event.idempotency_key === "auto-arrive:91:11").length, 1);
  assert.equal(harness.state.events.filter((event) =>
    event.idempotency_key === "auto-depart:91:11").length, 1);
}

async function testStaleAutomaticEventsAreRemovedWithoutReopeningTicket() {
  const incompleteEvidence = [
    gps(1, "2026-08-27 12:00:00", 25),
    gps(2, "2026-08-27 12:00:30", 20)
  ];
  const harness = createPersistenceHarness(incompleteEvidence, {
    dispatchStatus: "completed"
  });
  await harness.service.reconcileAutomaticDispatchHistory(7);

  assert.equal(harness.state.relation.dispatch_status, "completed");
  assert.equal(harness.state.stops[0].actual_arrival_at, null);
  assert.equal(harness.state.stops[0].actual_departure_at, null);
  assert.equal(harness.state.events.length, 0);
}

async function testCompletedReturnEventTimestampConvergesWithoutReopening() {
  const harness = createPersistenceHarness(buildLargeTimeline(1200), {
    dispatchStatus: "completed",
    includeReturningEvent: true
  });
  await harness.service.reconcileAutomaticDispatchHistory(7);

  const returningEvent = harness.state.events.find((event) =>
    event.event_type === "returning_to_wmo");
  assert.equal(harness.state.relation.dispatch_status, "completed");
  assert.equal(returningEvent.event_at, "2026-08-27 10:01:05");
  assert.equal(
    harness.state.relation.returning_to_wmo_at,
    "2026-08-27 10:01:05"
  );

  const manualHarness = createPersistenceHarness(buildLargeTimeline(1200), {
    dispatchStatus: "completed",
    includeReturningEvent: true,
    returningEventSource: "manual"
  });
  await manualHarness.service.reconcileAutomaticDispatchHistory(7);
  const manualReturningEvent = manualHarness.state.events.find((event) =>
    event.event_type === "returning_to_wmo");
  assert.equal(manualReturningEvent.event_at, "2026-08-27 10:10:00");
  assert.equal(manualHarness.state.relation.returning_to_wmo_at, undefined);
}

proveLegacyCursorAppendsLateHistoryOutOfOrder()
  .then(() => testMonitorPagesBeyondFiveHundredWithoutGaps())
  .then(() => testWithinPageIdChronologyMismatchTriggersReplay())
  .then(() => {
    testInsertionOrderInvariantReconstruction();
    testGpsPolicyAndManualProtection();
    testTerminalLifecycleAndStopOrderProtection();
    testBoundedLargeHistoryObservations();
    testMultipleSeventyFivePointBatchesConverge();
    return testPagedPersistenceAndTransactionRetry();
  })
  .then(() => testStaleAutomaticEventsAreRemovedWithoutReopeningTicket())
  .then(() => testCompletedReturnEventTimestampConvergesWithoutReopening())
  .then(() => {
    console.log("Dispatch historical replay tests passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
