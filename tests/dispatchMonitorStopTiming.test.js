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
const {
  DispatchService,
  DISPATCH_STOP_TRANSITION_RULES,
  qualifyDispatchStopEvidence
} = require("../services/dispatchService");
Module._load = originalModuleLoad;

const RELATION = Object.freeze({
  dispatch_ticket_id: 91,
  tracking_session_id: 58
});
const STOP_LOCATION = Object.freeze({
  latitude: 6.116,
  longitude: 125.171
});
const REFERENCE_TIME_MS = Date.parse("2026-08-26T13:00:00+08:00");

function normalizedSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function parseManila(value) {
  return Date.parse(`${String(value).replace(" ", "T")}+08:00`);
}

function secondsBetween(start, end) {
  return Math.floor((parseManila(end) - parseManila(start)) / 1000);
}

function locationLog(id, recordedAt, overrides = {}) {
  return {
    id,
    session_id: 58,
    latitude: STOP_LOCATION.latitude,
    longitude: STOP_LOCATION.longitude,
    accuracy: 10,
    recorded_at: recordedAt,
    ...overrides
  };
}

function createCandidateHarness(initialStop = {}) {
  const stop = {
    id: 11,
    dispatch_ticket_id: 91,
    stop_order: 1,
    stop_status: "on_the_way",
    latitude: STOP_LOCATION.latitude,
    longitude: STOP_LOCATION.longitude,
    geofence_radius_meters: 100,
    actual_arrival_at: null,
    arrival_candidate_at: null,
    arrival_candidate_count: 0,
    actual_departure_at: null,
    departure_candidate_at: null,
    departure_candidate_count: 0,
    stop_duration_seconds: null,
    ...initialStop
  };
  const events = [];
  const transitions = { nextStopUpdates: 0, returningChecks: 0 };
  let previousLog = null;
  let nextLogId = 1;

  const service = new DispatchService({}, {
    now: () => new Date(REFERENCE_TIME_MS)
  });
  service.getPreviousLocationLog = async () => previousLog;
  service.insertEvent = async (_connection, event) => {
    events.push(event);
    return events.length;
  };
  service.updateNextStop = async () => {
    transitions.nextStopUpdates += 1;
  };
  service.moveTicketToReturningIfDone = async () => {
    transitions.returningChecks += 1;
  };

  const connection = {
    async query(sql, parameters = []) {
      const normalized = normalizedSql(sql);

      if (normalized.includes("SET stop_status = 'arrived'")) {
        if (["arrived", "completed", "skipped"].includes(stop.stop_status)) {
          return [{ affectedRows: 0 }];
        }
        stop.stop_status = "arrived";
        stop.actual_arrival_at = stop.actual_arrival_at || parameters[0];
        stop.arrival_source = "automatic";
        stop.arrival_candidate_at = null;
        stop.arrival_candidate_count = 0;
        return [{ affectedRows: 1 }];
      }

      if (normalized.includes("SET arrival_candidate_at = NULL")) {
        stop.arrival_candidate_at = null;
        stop.arrival_candidate_count = 0;
        return [{ affectedRows: 1 }];
      }

      if (normalized.includes("SET arrival_candidate_at = ?")) {
        stop.arrival_candidate_at = parameters[0];
        stop.arrival_candidate_count = Number(parameters[1]);
        return [{ affectedRows: 1 }];
      }

      if (normalized.includes("SET stop_status = 'completed'")) {
        if (stop.stop_status !== "arrived") {
          return [{ affectedRows: 0 }];
        }
        const departureAt = parameters[0];
        stop.stop_status = "completed";
        stop.actual_departure_at = stop.actual_departure_at || departureAt;
        stop.departure_source = "automatic";
        if (
          stop.actual_arrival_at &&
          parseManila(departureAt) >= parseManila(stop.actual_arrival_at)
        ) {
          stop.stop_duration_seconds = secondsBetween(
            stop.actual_arrival_at,
            departureAt
          );
        }
        stop.departure_candidate_at = null;
        stop.departure_candidate_count = 0;
        return [{ affectedRows: 1 }];
      }

      if (normalized.includes("SET departure_candidate_at = NULL")) {
        stop.departure_candidate_at = null;
        stop.departure_candidate_count = 0;
        return [{ affectedRows: 1 }];
      }

      if (normalized.includes("SET departure_candidate_at = ?")) {
        stop.departure_candidate_at = parameters[0];
        stop.departure_candidate_count = Number(parameters[1]);
        return [{ affectedRows: 1 }];
      }

      if (normalized.startsWith("UPDATE dispatch_tickets")) {
        return [{ affectedRows: 1 }];
      }

      throw new Error(`Unexpected SQL in stop timing harness: ${normalized}`);
    }
  };

  async function arrival(recordedAt, qualifies = true, distance = 25) {
    const log = locationLog(nextLogId++, recordedAt);
    await service.advanceArrivalCandidate(
      connection,
      RELATION,
      stop,
      log,
      qualifies,
      distance
    );
    previousLog = { id: log.id, recorded_at: log.recorded_at };
    return log;
  }

  async function departure(recordedAt, qualifies = true, distance = 140) {
    const log = locationLog(nextLogId++, recordedAt);
    await service.advanceDepartureCandidate(
      connection,
      RELATION,
      stop,
      log,
      qualifies,
      distance
    );
    previousLog = { id: log.id, recorded_at: log.recorded_at };
    return log;
  }

  return { service, connection, stop, events, transitions, arrival, departure };
}

function testRulesAndStrictHistoricalEvidence() {
  assert.deepEqual(DISPATCH_STOP_TRANSITION_RULES, {
    departureHysteresisMeters: 25,
    arrivalConfirmationSampleCount: 1,
    departureConfirmationSampleCount: 3,
    arrivalConfirmationSeconds: 0,
    departureConfirmationSeconds: 30,
    arrivalCandidateGapMs: 90000,
    departureCandidateGapMs: 60000
  });

  const delayed = qualifyDispatchStopEvidence(
    locationLog(1, "2026-08-26 12:00:00"),
    { referenceTimeMs: REFERENCE_TIME_MS }
  );
  assert.equal(delayed.qualified, true);
  assert.equal(delayed.point.recorded_at, "2026-08-26 12:00:00");

  assert.equal(qualifyDispatchStopEvidence(
    locationLog(2, "2026-08-26 12:00:00", { latitude: 0, longitude: 0 }),
    { referenceTimeMs: REFERENCE_TIME_MS }
  ).qualified, false);
  assert.equal(qualifyDispatchStopEvidence(
    locationLog(3, "2026-08-26 12:00:00", { latitude: 91 }),
    { referenceTimeMs: REFERENCE_TIME_MS }
  ).qualified, false);
  assert.equal(qualifyDispatchStopEvidence(
    locationLog(4, "2026-08-26 12:00:00", { accuracy: 50.01 }),
    { referenceTimeMs: REFERENCE_TIME_MS }
  ).reason, "unreliable_accuracy");
  assert.equal(qualifyDispatchStopEvidence(
    locationLog(5, "2026-08-26 12:00:00", { accuracy: 0 }),
    { referenceTimeMs: REFERENCE_TIME_MS }
  ).qualified, false);
  assert.equal(qualifyDispatchStopEvidence(
    locationLog(6, "2026-08-26 13:01:01"),
    { referenceTimeMs: REFERENCE_TIME_MS }
  ).reason, "GPS_TIMESTAMP_FUTURE");
}

async function testArrivalUsesFirstQualifiedEntryTime() {
  const harness = createCandidateHarness();
  await harness.arrival("2026-08-26 12:00:00");

  assert.equal(harness.stop.stop_status, "arrived");
  assert.equal(harness.stop.actual_arrival_at, "2026-08-26 12:00:00");
  assert.equal(harness.stop.arrival_candidate_at, null);
  assert.equal(harness.stop.arrival_candidate_count, 0);
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].event_type, "arrived_at_stop");
  assert.equal(harness.events[0].event_at, "2026-08-26 12:00:00");
  assert.equal(harness.events[0].details.confirmed_at, "2026-08-26 12:00:00");
  assert.equal(harness.events[0].details.candidate_sample_count, 1);
  assert.equal(harness.events[0].idempotency_key, "auto-arrive:91:11");
}

async function testArrivalRequiresQualifiedInGeofenceEvidenceAndIsIdempotent() {
  const harness = createCandidateHarness();
  await harness.arrival("2026-08-26 12:00:00", false, 101);
  assert.equal(harness.stop.stop_status, "on_the_way");
  assert.equal(harness.events.length, 0);

  const firstArrival = await harness.arrival("2026-08-26 12:00:10", true, 100);
  assert.equal(harness.stop.stop_status, "arrived");
  assert.equal(harness.stop.actual_arrival_at, "2026-08-26 12:00:10");

  const staleArrival = {
    ...harness.stop,
    stop_status: "on_the_way",
    arrival_candidate_at: null,
    arrival_candidate_count: 0
  };
  await harness.service.advanceArrivalCandidate(
    harness.connection,
    RELATION,
    staleArrival,
    firstArrival,
    true,
    20
  );
  assert.equal(harness.events.length, 1);
  assert.equal(harness.stop.actual_arrival_at, "2026-08-26 12:00:10");
}

async function testDepartureUsesFirstCandidateAndPersistedArrivalForDwell() {
  const harness = createCandidateHarness({
    stop_status: "arrived",
    actual_arrival_at: "2026-08-26 12:00:00"
  });
  await harness.departure("2026-08-26 12:30:00");
  await harness.departure("2026-08-26 12:30:15");
  await harness.departure("2026-08-26 12:30:35");

  assert.equal(harness.stop.stop_status, "completed");
  assert.equal(harness.stop.actual_departure_at, "2026-08-26 12:30:00");
  assert.equal(harness.stop.stop_duration_seconds, 1800);
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].event_type, "departed_stop");
  assert.equal(harness.events[0].event_at, "2026-08-26 12:30:00");
  assert.equal(harness.events[0].details.confirmed_at, "2026-08-26 12:30:35");
  assert.equal(harness.events[0].idempotency_key, "auto-depart:91:11");
  assert.equal(harness.transitions.nextStopUpdates, 1);
  assert.equal(harness.transitions.returningChecks, 1);
}

async function testDepartureDurationGapAndHysteresisRules() {
  const underDuration = createCandidateHarness({
    stop_status: "arrived",
    actual_arrival_at: "2026-08-26 12:00:00"
  });
  await underDuration.departure("2026-08-26 12:30:00");
  await underDuration.departure("2026-08-26 12:30:10");
  await underDuration.departure("2026-08-26 12:30:20");
  assert.equal(underDuration.stop.stop_status, "arrived");

  const gap = createCandidateHarness({
    stop_status: "arrived",
    actual_arrival_at: "2026-08-26 12:00:00"
  });
  await gap.departure("2026-08-26 12:30:00");
  await gap.departure("2026-08-26 12:31:01");
  assert.equal(gap.stop.departure_candidate_at, "2026-08-26 12:31:01");
  assert.equal(gap.stop.departure_candidate_count, 1);

  const hysteresis = createCandidateHarness({
    stop_status: "arrived",
    actual_arrival_at: "2026-08-26 12:00:00"
  });
  await hysteresis.departure("2026-08-26 12:30:00", false, 101);
  await hysteresis.departure("2026-08-26 12:30:20", false, 124);
  await hysteresis.departure("2026-08-26 12:30:40", false, 130);
  assert.equal(hysteresis.stop.stop_status, "arrived");
  assert.equal(hysteresis.stop.departure_candidate_at, null);
  assert.equal(hysteresis.events.length, 0);
}

async function testDepartureBeforeArrivalAndNegativeChronologyAreImpossible() {
  const beforeArrival = createCandidateHarness();
  await beforeArrival.arrival("2026-08-26 12:00:00", false, 150);
  assert.equal(beforeArrival.stop.stop_status, "on_the_way");
  assert.equal(beforeArrival.stop.departure_candidate_at, null);

  const negative = createCandidateHarness({
    stop_status: "arrived",
    actual_arrival_at: "2026-08-26 12:30:00"
  });
  await negative.departure("2026-08-26 12:00:00");
  await negative.departure("2026-08-26 12:00:15");
  await negative.departure("2026-08-26 12:00:35");
  assert.equal(negative.stop.stop_status, "arrived");
  assert.equal(negative.stop.actual_departure_at, null);
  assert.equal(negative.stop.stop_duration_seconds, null);
  assert.equal(negative.stop.departure_candidate_at, null);
  assert.equal(negative.events.length, 0);
}

async function testTransitionEventsRemainIdempotent() {
  const arrival = createCandidateHarness();
  const confirmingArrival = await arrival.arrival("2026-08-26 12:00:00");
  const staleArrival = {
    ...arrival.stop,
    stop_status: "on_the_way",
    arrival_candidate_at: "2026-08-26 12:00:00",
    arrival_candidate_count: 0
  };
  await arrival.service.advanceArrivalCandidate(
    arrival.connection,
    RELATION,
    staleArrival,
    confirmingArrival,
    true,
    20
  );
  assert.equal(arrival.events.length, 1);

  const departure = createCandidateHarness({
    stop_status: "arrived",
    actual_arrival_at: "2026-08-26 12:00:00"
  });
  await departure.departure("2026-08-26 12:30:00");
  await departure.departure("2026-08-26 12:30:15");
  const confirmingDeparture = await departure.departure("2026-08-26 12:30:35");
  const staleDeparture = {
    ...departure.stop,
    stop_status: "arrived",
    departure_candidate_at: "2026-08-26 12:30:00",
    departure_candidate_count: 2
  };
  await departure.service.advanceDepartureCandidate(
    departure.connection,
    RELATION,
    staleDeparture,
    confirmingDeparture,
    true,
    140
  );
  assert.equal(departure.events.length, 1);
}

async function testDelayedFifoUsesOriginalRecordedAtTimeline() {
  const harness = createCandidateHarness();
  const timeline = [
    ["arrival", "2026-08-26 12:00:00"],
    ["arrival", "2026-08-26 12:00:30"],
    ["arrival", "2026-08-26 12:01:05"],
    ["departure", "2026-08-26 12:30:00"],
    ["departure", "2026-08-26 12:30:15"],
    ["departure", "2026-08-26 12:30:35"]
  ];

  for (const [transition, recordedAt] of timeline) {
    const evidence = qualifyDispatchStopEvidence(
      locationLog(99, recordedAt),
      { referenceTimeMs: REFERENCE_TIME_MS }
    );
    assert.equal(evidence.qualified, true);
    await harness[transition](recordedAt);
  }

  assert.equal(harness.stop.actual_arrival_at, "2026-08-26 12:00:00");
  assert.equal(harness.stop.actual_departure_at, "2026-08-26 12:30:00");
  assert.equal(harness.stop.stop_duration_seconds, 1800);
}

async function testEarliestStopAndTrackingSessionOwnershipStayLocked() {
  const relation = {
    id: 7,
    dispatch_ticket_id: 91,
    tracking_session_id: 58,
    dispatch_status: "in_progress"
  };
  const stopOne = {
    id: 11,
    stop_order: 1,
    stop_status: "on_the_way",
    latitude: 6.11,
    longitude: 125.16,
    geofence_radius_meters: 100
  };
  const stopTwo = {
    id: 12,
    stop_order: 2,
    stop_status: "pending",
    latitude: 6.12,
    longitude: 125.17,
    geofence_radius_meters: 100
  };
  let observedStopId = null;
  let cursorUpdates = 0;
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql) {
      const normalized = normalizedSql(sql);
      if (normalized.includes("FROM dispatch_tracking_sessions dts")) {
        return [[relation]];
      }
      if (normalized.includes("FROM dispatch_route_stops")) {
        assert.match(normalized, /ORDER BY stop_order ASC, id ASC LIMIT 1 FOR UPDATE/);
        assert.match(normalized, /stop_status NOT IN \('completed', 'skipped'\)/);
        return [[stopOne]];
      }
      if (normalized.startsWith("UPDATE dispatch_tracking_sessions")) {
        cursorUpdates += 1;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected processAutomaticLocationLog SQL: ${normalized}`);
    }
  };
  const pool = { async getConnection() { return connection; } };
  const service = new DispatchService(pool, {
    now: () => new Date(REFERENCE_TIME_MS)
  });
  service.advanceArrivalCandidate = async (_connection, _relation, stop) => {
    observedStopId = stop.id;
  };

  await service.processAutomaticLocationLog(
    relation.id,
    locationLog(1, "2026-08-26 12:00:00", {
      latitude: stopTwo.latitude,
      longitude: stopTwo.longitude
    })
  );
  assert.equal(observedStopId, stopOne.id);
  assert.equal(stopTwo.stop_status, "pending");
  assert.equal(cursorUpdates, 1);

  observedStopId = null;
  await service.processAutomaticLocationLog(
    relation.id,
    locationLog(2, "2026-08-26 12:00:10", { session_id: 999 })
  );
  assert.equal(observedStopId, null);
  assert.equal(cursorUpdates, 1);
}

function testMonitorPreservesIncrementalChronologicalProcessing() {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "../services/dispatchMonitorService.js"),
    "utf8"
  );
  assert.match(source, /WHERE session_id = \?/);
  assert.match(source, /AND id > \?/);
  assert.match(source, /ORDER BY id ASC/);
  assert.match(source, /LIMIT \?/);
  assert.match(source, /reconcileAutomaticDispatchHistory/);
  assert.match(source, /OR EXISTS \(/);
  assert.match(source, /dt\.status AS dispatch_status/);

  const dispatchSource = fs.readFileSync(
    path.join(__dirname, "../services/dispatchService.js"),
    "utf8"
  );
  assert.match(dispatchSource, /ORDER BY recorded_at ASC, id ASC/);
}

async function run() {
  testRulesAndStrictHistoricalEvidence();
  await testArrivalUsesFirstQualifiedEntryTime();
  await testArrivalRequiresQualifiedInGeofenceEvidenceAndIsIdempotent();
  await testDepartureUsesFirstCandidateAndPersistedArrivalForDwell();
  await testDepartureDurationGapAndHysteresisRules();
  await testDepartureBeforeArrivalAndNegativeChronologyAreImpossible();
  await testTransitionEventsRemainIdempotent();
  await testDelayedFifoUsesOriginalRecordedAtTimeline();
  await testEarliestStopAndTrackingSessionOwnershipStayLocked();
  testMonitorPreservesIncrementalChronologicalProcessing();
  console.log("Dispatch automatic stop timing state-machine tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
