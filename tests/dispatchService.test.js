const assert = require("node:assert/strict");
const Module = require("node:module");

const originalModuleLoad = Module._load;
Module._load = function loadWithMockedDispatchPool(request, parent, isMain) {
  if (
    request === "../config/dbPromise" &&
    parent &&
    parent.filename.replace(/\\/g, "/").endsWith("services/dispatchService.js")
  ) {
    return {};
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const dispatchServiceModule = require("../services/dispatchService");
const {
  DispatchService,
  NON_TERMINAL_TICKET_STATUSES,
  currentManilaDate,
  isDispatchTableMissingError
} = dispatchServiceModule;
Module._load = originalModuleLoad;

function productionDispatchNowPayload(overrides = {}) {
  return {
    ticket_number: "00090009",
    tracking_session_id: 58,
    truck_id: "TRUCK-9",
    truck_name_snapshot: "Truck 9",
    assigned_personnel_id: 999,
    assigned_personnel_name: "Client supplied personnel",
    scheduled_start_at: null,
    expected_return_at: null,
    route_name: "Current operating route",
    route_description: null,
    notes: null,
    created_by_user_id: 7,
    created_by_name: "Dispatch Operator",
    stops: [{
      stop_order: 1,
      location_name: "Pioneer Avenue",
      latitude: 6.11,
      longitude: 125.17,
      geofence_radius_meters: 100
    }],
    ...overrides
  };
}

async function testTicketNumberSequenceUsesLock() {
  const calls = [];
  const connection = {
    async query(sql, parameters) {
      const normalizedSql = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: normalizedSql, parameters });

      if (normalizedSql.startsWith("SELECT `last_value`")) {
        return [[{ last_value: 41 }]];
      }
      return [{ affectedRows: 1 }];
    }
  };
  const service = new DispatchService({});
  const ticketNumber = await service.generateTicketNumber(connection, 2026);

  assert.equal(ticketNumber, "DPT-2026-0042");
  assert.equal(calls.length, 3);
  assert.match(calls[0].sql, /INSERT INTO dispatch_ticket_sequences \( dispatch_year, `last_value`, updated_at \)/);
  assert.match(calls[0].sql, /ON DUPLICATE KEY UPDATE updated_at = updated_at/);
  assert.match(calls[1].sql, /SELECT `last_value`/);
  assert.match(calls[1].sql, /FOR UPDATE/);
  assert.match(calls[2].sql, /SET `last_value` = \?/);
  assert.doesNotMatch(calls.map((call) => call.sql).join(" "), /COUNT\s*\(/i);
  assert.deepEqual(calls[2].parameters, [42, 2026]);
}

async function testSequenceInitializesAndIncrementsWithoutDuplicates() {
  const sequence = new Map();
  const calls = [];
  const connection = {
    async query(sql, parameters) {
      const normalizedSql = sql.replace(/\s+/g, " ").trim();
      calls.push(normalizedSql);
      const year = Number(parameters?.at(-1));
      if (normalizedSql.startsWith("INSERT INTO dispatch_ticket_sequences")) {
        if (!sequence.has(year)) sequence.set(year, 0);
        return [{ affectedRows: 1 }];
      }
      if (normalizedSql.startsWith("SELECT `last_value`")) {
        return [[{ last_value: sequence.get(year) }]];
      }
      if (normalizedSql.startsWith("UPDATE dispatch_ticket_sequences")) {
        sequence.set(Number(parameters[1]), Number(parameters[0]));
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${normalizedSql}`);
    }
  };
  const service = new DispatchService({});
  assert.equal(await service.generateTicketNumber(connection, 2026), "DPT-2026-0001");
  assert.equal(await service.generateTicketNumber(connection, 2026), "DPT-2026-0002");
  assert.equal(sequence.get(2026), 2);
  assert.equal(calls.filter((sql) => /FOR UPDATE/.test(sql)).length, 2);
}

function createTransactionalPool({
  failTicketInsert = false,
  duplicateTicket = false,
  duplicateOnInsert = false,
  sessionStatus = "active",
  sessionTruckId = "TRUCK-9",
  existingTickets = []
} = {}) {
  const state = {
    sequence: new Map(),
    calls: [],
    ticketParameters: null,
    selectedSessionParameters: null,
    truckLockParameters: null,
    conflictCheckParameters: null,
    began: false,
    committed: false,
    rolledBack: false,
    released: false
  };
  const connection = {
    async beginTransaction() { state.began = true; },
    async commit() { state.committed = true; },
    async rollback() { state.rolledBack = true; },
    release() { state.released = true; },
    async query(sql, parameters = []) {
      const normalizedSql = sql.replace(/\s+/g, " ").trim();
      state.calls.push({ sql: normalizedSql, parameters });
      if (normalizedSql.startsWith("SELECT id FROM truck_tracking_sessions WHERE truck_id")) {
        state.truckLockParameters = parameters;
        return [[{ id: 1 }]];
      }
      if (normalizedSql.startsWith("SELECT id, truck_id, enforcer_id, enforcer_name, session_status")) {
        state.selectedSessionParameters = parameters;
        return [[{
          id: 58,
          truck_id: sessionTruckId,
          enforcer_id: 44,
          enforcer_name: "Stored Session Personnel",
          session_status: sessionStatus
        }]];
      }
      if (normalizedSql.startsWith("SELECT id, ticket_number, status FROM dispatch_tickets")) {
        state.conflictCheckParameters = parameters;
        const excludedTicketId = normalizedSql.includes("id <> ?")
          ? Number(parameters.at(-1))
          : null;
        const statuses = new Set(parameters.slice(1, 1 + NON_TERMINAL_TICKET_STATUSES.size));
        return [existingTickets.filter((ticket) =>
          String(ticket.truck_id) === String(parameters[0]) &&
          statuses.has(ticket.status) &&
          Number(ticket.id) !== excludedTicketId
        )];
      }
      if (normalizedSql.startsWith("SELECT id FROM dispatch_tickets WHERE ticket_number")) {
        return [duplicateTicket ? [{ id: 77 }] : []];
      }
      if (normalizedSql.startsWith("INSERT INTO dispatch_ticket_sequences")) {
        const year = Number(parameters[0]);
        if (!state.sequence.has(year)) state.sequence.set(year, 0);
        return [{ affectedRows: 1 }];
      }
      if (normalizedSql.startsWith("SELECT `last_value`")) {
        return [[{ last_value: state.sequence.get(Number(parameters[0])) }]];
      }
      if (normalizedSql.startsWith("UPDATE dispatch_ticket_sequences")) {
        state.sequence.set(Number(parameters[1]), Number(parameters[0]));
        return [{ affectedRows: 1 }];
      }
      if (normalizedSql.startsWith("INSERT INTO dispatch_tickets")) {
        if (duplicateOnInsert) {
          throw Object.assign(new Error("Duplicate entry for ticket_number"), {
            code: "ER_DUP_ENTRY"
          });
        }
        if (failTicketInsert) {
          throw Object.assign(new Error("simulated SQL syntax failure"), {
            code: "ER_PARSE_ERROR"
          });
        }
        state.ticketParameters = parameters;
        return [{ insertId: 501 }];
      }
      if (
        normalizedSql.startsWith("INSERT INTO dispatch_route_stops") ||
        normalizedSql.startsWith("INSERT INTO dispatch_events")
      ) {
        return [{ insertId: 601, affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${normalizedSql}`);
    }
  };
  return {
    state,
    pool: { async getConnection() { return connection; } }
  };
}

function ticketPayload(overrides = {}) {
  return productionDispatchNowPayload({
    dispatch_date: "2099-12-31",
    ...overrides
  });
}

function assertTruckAlreadyAssigned(error) {
  assert.equal(error.statusCode, 409);
  assert.equal(error.code, "DISPATCH_TRUCK_ALREADY_ASSIGNED");
  assert.equal(
    error.message,
    "This truck already has a non-terminal dispatch ticket."
  );
  return true;
}

function createLifecyclePool({
  ticket = {
    id: 77,
    truck_id: "TRUCK-9",
    status: "prepared",
    dispatch_date: "2026-08-03"
  },
  existingTickets = [],
  linkedTicketId = null,
  sessionTruckId = "TRUCK-9"
} = {}) {
  const state = {
    calls: [],
    began: false,
    committed: false,
    rolledBack: false,
    released: false,
    conflictChecks: 0
  };
  const connection = {
    async beginTransaction() { state.began = true; },
    async commit() { state.committed = true; },
    async rollback() { state.rolledBack = true; },
    release() { state.released = true; },
    async query(sql, parameters = []) {
      const normalizedSql = sql.replace(/\s+/g, " ").trim();
      state.calls.push({ sql: normalizedSql, parameters });
      if (normalizedSql.startsWith("SELECT id, truck_id FROM dispatch_tickets")) {
        return [[{ id: ticket.id, truck_id: ticket.truck_id }]];
      }
      if (normalizedSql.startsWith("SELECT * FROM dispatch_tickets")) {
        return [[{ ...ticket }]];
      }
      if (normalizedSql.startsWith("SELECT id FROM truck_tracking_sessions WHERE truck_id")) {
        return [[{ id: 1 }]];
      }
      if (normalizedSql.startsWith("SELECT id, ticket_number, status FROM dispatch_tickets")) {
        state.conflictChecks += 1;
        const excludedTicketId = normalizedSql.includes("id <> ?")
          ? Number(parameters.at(-1))
          : null;
        const statuses = new Set(parameters.slice(1, 1 + NON_TERMINAL_TICKET_STATUSES.size));
        return [existingTickets.filter((candidate) =>
          String(candidate.truck_id) === String(parameters[0]) &&
          statuses.has(candidate.status) &&
          Number(candidate.id) !== excludedTicketId
        )];
      }
      if (normalizedSql.startsWith("SELECT id, truck_id, enforcer_id, enforcer_name, session_status, started_at")) {
        return [[{
          id: 58,
          truck_id: sessionTruckId,
          enforcer_id: 44,
          enforcer_name: "Stored Session Personnel",
          session_status: "active",
          started_at: "2026-08-03 08:00:00"
        }]];
      }
      if (normalizedSql.startsWith("SELECT dispatch_ticket_id FROM dispatch_tracking_sessions")) {
        return [linkedTicketId === null ? [] : [{ dispatch_ticket_id: linkedTicketId }]];
      }
      if (
        normalizedSql.startsWith("UPDATE dispatch_tickets") ||
        normalizedSql.startsWith("UPDATE dispatch_tracking_sessions") ||
        normalizedSql.startsWith("UPDATE dispatch_route_stops") ||
        normalizedSql.startsWith("DELETE FROM dispatch_route_stops") ||
        normalizedSql.startsWith("INSERT INTO dispatch_route_stops") ||
        normalizedSql.startsWith("INSERT INTO dispatch_tracking_sessions") ||
        normalizedSql.startsWith("INSERT INTO dispatch_events")
      ) {
        return [{ affectedRows: 1, insertId: 88 }];
      }
      throw new Error(`Unexpected SQL: ${normalizedSql}`);
    }
  };
  return {
    state,
    connection,
    pool: { async getConnection() { return connection; } }
  };
}

async function testCreateTicketUsesCurrentManilaDateAndOptimizedStops() {
  const fixedNow = new Date("2026-08-02T16:30:00.000Z");
  const { pool, state } = createTransactionalPool();
  const service = new DispatchService(pool, { now: () => fixedNow });
  service.getTicketDetails = async (ticketId) => ({ ticket: { id: ticketId }, stops: [] });

  const details = await service.createTicket(ticketPayload({
    stops: [
      {
        stop_order: 3,
        location_name: "Pendatun Avenue",
        latitude: 6.13,
        longitude: 125.13,
        geofence_radius_meters: 100
      },
      {
        stop_order: 1,
        location_name: "Pioneer Avenue",
        latitude: 6.11,
        longitude: 125.11,
        geofence_radius_meters: 100
      },
      {
        stop_order: 2,
        location_name: "Santiago Boulevard",
        latitude: 6.12,
        longitude: 125.12,
        geofence_radius_meters: 100
      }
    ]
  }));
  assert.equal(details.ticket.id, 501);
  assert.equal(currentManilaDate(fixedNow), "2026-08-03");
  assert.equal(state.ticketParameters[0], "00090009");
  assert.equal(state.ticketParameters[5], "2026-08-03");
  assert.notEqual(state.ticketParameters[5], "2099-12-31");
  assert.deepEqual(state.selectedSessionParameters, [58]);
  assert.equal(state.ticketParameters[3], 44);
  assert.equal(state.ticketParameters[4], "Stored Session Personnel");
  assert.notEqual(state.ticketParameters[3], 999);
  assert.equal(
    state.calls.some((call) => call.sql.includes("dispatch_ticket_sequences")),
    false
  );
  assert.equal(state.began, true);
  assert.equal(state.committed, true);
  assert.equal(state.rolledBack, false);
  assert.equal(state.released, true);
  const ticketInsertIndex = state.calls.findIndex((call) => call.sql.startsWith("INSERT INTO dispatch_tickets"));
  const truckLockIndex = state.calls.findIndex((call) =>
    call.sql.startsWith("SELECT id FROM truck_tracking_sessions WHERE truck_id")
  );
  const activeSessionIndex = state.calls.findIndex((call) =>
    call.sql.startsWith("SELECT id, truck_id, enforcer_id, enforcer_name, session_status")
  );
  const duplicateCheckIndex = state.calls.findIndex((call) =>
    call.sql.startsWith("SELECT id FROM dispatch_tickets WHERE ticket_number")
  );
  const truckConflictIndex = state.calls.findIndex((call) =>
    call.sql.startsWith("SELECT id, ticket_number, status FROM dispatch_tickets")
  );
  const stopInsertIndex = state.calls.findIndex((call) => call.sql.startsWith("INSERT INTO dispatch_route_stops"));
  assert.ok(
    truckLockIndex >= 0 &&
    activeSessionIndex > truckLockIndex &&
    truckConflictIndex > activeSessionIndex &&
    duplicateCheckIndex > truckConflictIndex &&
    ticketInsertIndex > duplicateCheckIndex &&
    stopInsertIndex > ticketInsertIndex
  );
  const stopInserts = state.calls.filter((call) =>
    call.sql.startsWith("INSERT INTO dispatch_route_stops")
  );
  assert.deepEqual(stopInserts.map((call) => call.parameters[1]), [1, 2, 3]);
  assert.deepEqual(stopInserts.map((call) => call.parameters[2]), [
    "Pioneer Avenue",
    "Santiago Boulevard",
    "Pendatun Avenue"
  ]);
  assert.ok(stopInserts.every((call) => call.parameters[2] !== "Return to WMO"));
}

async function testNewTicketIgnoresEveryClientDispatchDateVariant() {
  const fixedNow = new Date("2026-08-02T16:30:00.000Z");
  const variants = [
    { label: "missing", payload: productionDispatchNowPayload() },
    { label: "null", payload: productionDispatchNowPayload({ dispatch_date: null }) },
    { label: "empty", payload: productionDispatchNowPayload({ dispatch_date: "" }) },
    { label: "malformed", payload: productionDispatchNowPayload({ dispatch_date: "invalid" }) },
    { label: "past", payload: productionDispatchNowPayload({ dispatch_date: "2001-01-01" }) },
    { label: "future", payload: productionDispatchNowPayload({ dispatch_date: "2099-12-31" }) }
  ];

  for (const variant of variants) {
    const { pool, state } = createTransactionalPool();
    const service = new DispatchService(pool, { now: () => fixedNow });
    service.getTicketDetails = async (ticketId) => ({ ticket: { id: ticketId } });

    await service.createTicket(variant.payload);
    assert.equal(
      state.ticketParameters[5],
      "2026-08-03",
      `${variant.label} client dispatch_date must be ignored`
    );
  }
}

async function testManualTicketNumberIsRequiredAndPreservesLeadingZeros() {
  const service = new DispatchService({
    async getConnection() {
      throw new Error("A transaction must not start for invalid input");
    }
  });
  await assert.rejects(
    () => service.createTicket(ticketPayload({ ticket_number: "   " })),
    (error) => {
      assert.equal(error.message, "Enter the ticket number to continue.");
      assert.equal(error.code, "DISPATCH_TICKET_NUMBER_REQUIRED");
      return true;
    }
  );

  const { pool, state } = createTransactionalPool();
  const validService = new DispatchService(pool, {
    now: () => new Date("2026-08-03T00:00:00.000Z")
  });
  validService.getTicketDetails = async (ticketId) => ({ ticket: { id: ticketId } });
  await validService.createTicket(ticketPayload({ ticket_number: "  000042  " }));
  assert.equal(state.ticketParameters[0], "000042");
}

async function testDuplicateTicketNumberIsRejectedSafely() {
  for (const options of [{ duplicateTicket: true }, { duplicateOnInsert: true }]) {
    const { pool, state } = createTransactionalPool(options);
    const service = new DispatchService(pool, {
      now: () => new Date("2026-08-03T00:00:00.000Z")
    });
    await assert.rejects(
      () => service.createTicket(ticketPayload()),
      (error) => {
        assert.equal(error.message, "This ticket number is already in use.");
        assert.equal(error.code, "DISPATCH_TICKET_NUMBER_DUPLICATE");
        assert.equal(error.statusCode, 409);
        assert.doesNotMatch(error.message, /SQL|duplicate entry|ticket_number/i);
        return true;
      }
    );
    assert.equal(state.committed, false);
    assert.equal(state.rolledBack, true);
    assert.equal(
      state.calls.some((call) => call.sql.startsWith("INSERT INTO dispatch_route_stops")),
      false
    );
  }
}

async function testSelectedActiveSessionMustMatchTruck() {
  const { pool, state } = createTransactionalPool({ sessionTruckId: "TRUCK-10" });
  const service = new DispatchService(pool, {
    now: () => new Date("2026-08-03T00:00:00.000Z")
  });
  await assert.rejects(
    () => service.createTicket(ticketPayload()),
    (error) => {
      assert.equal(error.code, "DISPATCH_TRUCK_MISMATCH");
      assert.equal(error.statusCode, 409);
      return true;
    }
  );
  assert.equal(state.rolledBack, true);
  assert.equal(state.ticketParameters, null);

  const ended = createTransactionalPool({ sessionStatus: "stopped" });
  const endedService = new DispatchService(ended.pool, {
    now: () => new Date("2026-08-03T00:00:00.000Z")
  });
  await assert.rejects(
    () => endedService.createTicket(ticketPayload()),
    (error) => {
      assert.equal(error.code, "ACTIVE_TRACKING_SESSION_ENDED");
      assert.equal(error.statusCode, 409);
      return true;
    }
  );
  assert.equal(ended.state.rolledBack, true);
  assert.equal(ended.state.ticketParameters, null);
}

async function testCreateRejectsEveryNonTerminalStatusForSameTruck() {
  for (const status of NON_TERMINAL_TICKET_STATUSES) {
    const { pool, state } = createTransactionalPool({
      existingTickets: [{
        id: 70,
        ticket_number: `LEGACY-${status}`,
        truck_id: "TRUCK-9",
        status
      }]
    });
    const service = new DispatchService(pool, {
      now: () => new Date("2026-08-03T00:00:00.000Z")
    });

    await assert.rejects(
      () => service.createTicket(ticketPayload({ ticket_number: `NEW-${status}` })),
      assertTruckAlreadyAssigned
    );
    assert.equal(state.rolledBack, true, `${status} conflict must roll back`);
    assert.equal(state.ticketParameters, null, `${status} conflict must not insert`);
    assert.deepEqual(state.truckLockParameters, ["TRUCK-9"]);
    assert.deepEqual(state.conflictCheckParameters, [
      "TRUCK-9",
      ...NON_TERMINAL_TICKET_STATUSES
    ]);
  }
}

async function testTerminalTicketsAllowNewCreate() {
  for (const status of ["completed", "cancelled"]) {
    const { pool, state } = createTransactionalPool({
      existingTickets: [{
        id: 70,
        ticket_number: `OLD-${status}`,
        truck_id: "TRUCK-9",
        status
      }]
    });
    const service = new DispatchService(pool, {
      now: () => new Date("2026-08-03T00:00:00.000Z")
    });
    service.getTicketDetails = async (ticketId) => ({ ticket: { id: ticketId } });

    const result = await service.createTicket(
      ticketPayload({ ticket_number: `NEW-${status}` })
    );
    assert.equal(result.ticket.id, 501);
    assert.equal(state.committed, true, `${status} must permit a new ticket`);
    assert.ok(state.ticketParameters);
  }
}

async function testOtherTruckDoesNotBlockCreate() {
  const { pool, state } = createTransactionalPool({
    existingTickets: [{
      id: 70,
      ticket_number: "OTHER-TRUCK",
      truck_id: "TRUCK-10",
      status: "in_progress"
    }]
  });
  const service = new DispatchService(pool, {
    now: () => new Date("2026-08-03T00:00:00.000Z")
  });
  service.getTicketDetails = async (ticketId) => ({ ticket: { id: ticketId } });

  await service.createTicket(ticketPayload());
  assert.equal(state.committed, true);
  assert.deepEqual(state.truckLockParameters, ["TRUCK-9"]);
}

async function testUnifiedTicketFiltersAreParameterizedAndExcludePersonnel() {
  const calls = [];
  const service = new DispatchService({
    async query(sql, parameters) {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), parameters });
      return [[]];
    }
  });
  await service.listTickets({ ticket: "0009", truck: "TRUCK-9" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /dt\.ticket_number LIKE \?/);
  assert.match(calls[0].sql, /dt\.truck_id LIKE \?/);
  assert.doesNotMatch(calls[0].sql, /assigned_personnel/);
  assert.match(calls[0].sql, /ORDER BY COALESCE\(dt\.issued_at, dt\.created_at\) DESC/);
  assert.deepEqual(calls[0].parameters, ["%TRUCK-9%", "%0009%"]);
}

async function testSqlFailureRollsBackTicketTransaction() {
  const { pool, state } = createTransactionalPool({ failTicketInsert: true });
  const service = new DispatchService(pool, {
    now: () => new Date("2026-08-03T00:00:00.000Z")
  });
  await assert.rejects(
    () => service.createTicket(ticketPayload()),
    /simulated SQL syntax failure/
  );
  assert.equal(state.began, true);
  assert.equal(state.committed, false);
  assert.equal(state.rolledBack, true);
  assert.equal(state.released, true);
}

async function testPreparedTicketKeepsItsOriginalOperatingDateAfterMidnight() {
  const state = { updateParameters: null, committed: false };
  const connection = {
    async beginTransaction() {},
    async commit() { state.committed = true; },
    async rollback() {},
    release() {},
    async query(sql, parameters = []) {
      const normalizedSql = sql.replace(/\s+/g, " ").trim();
      if (normalizedSql.startsWith("SELECT * FROM dispatch_tickets")) {
        return [[{
          id: 77,
          truck_id: "TRUCK-9",
          status: "prepared",
          dispatch_date: "2026-08-02"
        }]];
      }
      if (normalizedSql.startsWith("SELECT id FROM truck_tracking_sessions WHERE truck_id")) {
        return [[{ id: 1 }]];
      }
      if (normalizedSql.startsWith("SELECT id, ticket_number, status FROM dispatch_tickets")) {
        assert.deepEqual(parameters, [
          "TRUCK-9",
          ...NON_TERMINAL_TICKET_STATUSES,
          77
        ]);
        return [[]];
      }
      if (normalizedSql.startsWith("UPDATE dispatch_tickets")) {
        state.updateParameters = parameters;
        return [{ affectedRows: 1 }];
      }
      if (
        normalizedSql.startsWith("DELETE FROM dispatch_route_stops") ||
        normalizedSql.startsWith("INSERT INTO dispatch_route_stops")
      ) {
        return [{ affectedRows: 1, insertId: 88 }];
      }
      throw new Error(`Unexpected SQL: ${normalizedSql}`);
    }
  };
  const service = new DispatchService(
    { async getConnection() { return connection; } },
    { now: () => new Date("2026-08-02T16:30:00.000Z") }
  );
  service.getTicketDetails = async () => ({ ticket: { id: 77 }, stops: [] });
  await service.updatePreparedTicket(77, ticketPayload());
  assert.equal(state.updateParameters[4], "2026-08-02");
  assert.equal(state.committed, true);
}

async function testPreparedTicketUpdateRejectsOccupiedDestinationTruck() {
  const { pool, state } = createLifecyclePool({
    ticket: {
      id: 77,
      truck_id: "TRUCK-8",
      status: "prepared",
      dispatch_date: "2026-08-03"
    },
    existingTickets: [{
      id: 88,
      ticket_number: "OCCUPIED-9",
      truck_id: "TRUCK-9",
      status: "dispatched"
    }]
  });
  const service = new DispatchService(pool);

  await assert.rejects(
    () => service.updatePreparedTicket(77, ticketPayload({ truck_id: "TRUCK-9" })),
    assertTruckAlreadyAssigned
  );
  assert.equal(state.rolledBack, true);
  assert.equal(
    state.calls.some((call) => call.sql.startsWith("UPDATE dispatch_tickets")),
    false
  );
}

async function testPreparedTicketUpdateExcludesItself() {
  const { pool, state } = createLifecyclePool({
    existingTickets: [{
      id: 77,
      ticket_number: "CURRENT-77",
      truck_id: "TRUCK-9",
      status: "prepared"
    }]
  });
  const service = new DispatchService(pool);
  service.getTicketDetails = async (ticketId) => ({ ticket: { id: ticketId } });

  await service.updatePreparedTicket(77, ticketPayload());
  assert.equal(state.committed, true);
  const conflictCall = state.calls.find((call) =>
    call.sql.startsWith("SELECT id, ticket_number, status FROM dispatch_tickets")
  );
  assert.match(conflictCall.sql, /id <> \?/);
  assert.deepEqual(conflictCall.parameters, [
    "TRUCK-9",
    ...NON_TERMINAL_TICKET_STATUSES,
    77
  ]);
}

async function testIssueRejectsAnotherPreparedTicketForSameTruck() {
  const { pool, state } = createLifecyclePool({
    existingTickets: [
      { id: 77, ticket_number: "CURRENT-77", truck_id: "TRUCK-9", status: "prepared" },
      { id: 88, ticket_number: "LEGACY-88", truck_id: "TRUCK-9", status: "prepared" }
    ]
  });
  const service = new DispatchService(pool);

  await assert.rejects(() => service.issueTicket(77), assertTruckAlreadyAssigned);
  assert.equal(state.rolledBack, true);
  assert.equal(
    state.calls.some((call) =>
      call.sql.startsWith("UPDATE dispatch_tickets") &&
      call.sql.includes("SET status = 'dispatched'")
    ),
    false
  );
  const referenceIndex = state.calls.findIndex((call) =>
    call.sql.startsWith("SELECT id, truck_id FROM dispatch_tickets")
  );
  const truckLockIndex = state.calls.findIndex((call) =>
    call.sql.startsWith("SELECT id FROM truck_tracking_sessions WHERE truck_id")
  );
  const ticketLockIndex = state.calls.findIndex((call) =>
    call.sql.startsWith("SELECT * FROM dispatch_tickets")
  );
  const conflictIndex = state.calls.findIndex((call) =>
    call.sql.startsWith("SELECT id, ticket_number, status FROM dispatch_tickets")
  );
  assert.ok(
    referenceIndex >= 0 &&
    truckLockIndex > referenceIndex &&
    ticketLockIndex > truckLockIndex &&
    conflictIndex > ticketLockIndex
  );
}

async function testTrackingSessionAlreadyLinkedBehaviorIsUnchanged() {
  const { pool, state } = createLifecyclePool({
    ticket: {
      id: 77,
      truck_id: "TRUCK-9",
      status: "dispatched",
      dispatch_date: "2026-08-03"
    },
    linkedTicketId: 88
  });
  const service = new DispatchService(pool);

  await assert.rejects(
    () => service.linkSession(77, { tracking_session_id: 58 }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "TRACKING_SESSION_ALREADY_LINKED");
      assert.equal(
        error.message,
        "Tracking session is already linked to another dispatch ticket"
      );
      return true;
    }
  );
  assert.equal(state.rolledBack, true);
  assert.equal(state.conflictChecks, 0);
}

async function testLinkSessionRejectsAnotherNonTerminalTicketForTruck() {
  const { pool, state } = createLifecyclePool({
    ticket: {
      id: 77,
      truck_id: "TRUCK-9",
      status: "dispatched",
      dispatch_date: "2026-08-03"
    },
    existingTickets: [
      { id: 77, ticket_number: "CURRENT-77", truck_id: "TRUCK-9", status: "dispatched" },
      { id: 88, ticket_number: "OTHER-88", truck_id: "TRUCK-9", status: "prepared" }
    ]
  });
  const service = new DispatchService(pool);

  await assert.rejects(
    () => service.linkSession(77, { tracking_session_id: 58 }),
    assertTruckAlreadyAssigned
  );
  assert.equal(state.rolledBack, true);
  assert.equal(state.conflictChecks, 1);
  assert.equal(
    state.calls.some((call) => call.sql.startsWith("INSERT INTO dispatch_tracking_sessions")),
    false
  );
}

async function testSameTicketSessionLinkRemainsIdempotent() {
  const { pool, state } = createLifecyclePool({
    ticket: {
      id: 77,
      truck_id: "TRUCK-9",
      status: "dispatched",
      dispatch_date: "2026-08-03"
    },
    linkedTicketId: 77,
    existingTickets: [{
      id: 77,
      ticket_number: "CURRENT-77",
      truck_id: "TRUCK-9",
      status: "dispatched"
    }]
  });
  const service = new DispatchService(pool);
  service.getTicketDetails = async (ticketId) => ({ ticket: { id: ticketId } });

  await service.linkSession(77, { tracking_session_id: 58 });
  assert.equal(state.committed, true);
  assert.equal(state.conflictChecks, 0);
  assert.equal(
    state.calls.some((call) => call.sql.startsWith("INSERT INTO dispatch_tracking_sessions")),
    false
  );
}

function createSharedTruckRowLock() {
  let held = false;
  let heldCount = 0;
  let maxHeldCount = 0;
  const waiters = [];
  return {
    get maxHeldCount() { return maxHeldCount; },
    async acquire() {
      if (held) {
        await new Promise((resolve) => waiters.push(resolve));
      }
      held = true;
      heldCount += 1;
      maxHeldCount = Math.max(maxHeldCount, heldCount);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        heldCount -= 1;
        held = false;
        const next = waiters.shift();
        if (next) next();
      };
    }
  };
}

async function testConcurrentSameTruckCreatesSerializeAndOnlyOneCommits() {
  const sharedTickets = [];
  const truckRowLock = createSharedTruckRowLock();
  const state = { lockAttempts: 0, commits: 0, rollbacks: 0, lockSql: [] };
  let releaseSecondAttempt;
  const secondAttempted = new Promise((resolve) => { releaseSecondAttempt = resolve; });
  let nextTicketId = 500;

  const pool = {
    async getConnection() {
      let releaseTruckLock = null;
      return {
        async beginTransaction() {},
        async commit() {
          state.commits += 1;
          releaseTruckLock?.();
        },
        async rollback() {
          state.rollbacks += 1;
          releaseTruckLock?.();
        },
        release() {},
        async query(sql, parameters = []) {
          const normalizedSql = sql.replace(/\s+/g, " ").trim();
          if (normalizedSql.startsWith("SELECT id FROM truck_tracking_sessions WHERE truck_id")) {
            state.lockAttempts += 1;
            state.lockSql.push({ sql: normalizedSql, parameters });
            if (state.lockAttempts === 2) releaseSecondAttempt();
            releaseTruckLock = await truckRowLock.acquire();
            return [[{ id: 1 }]];
          }
          if (normalizedSql.startsWith("SELECT id, truck_id, enforcer_id, enforcer_name, session_status")) {
            return [[{
              id: 58,
              truck_id: "TRUCK-9",
              enforcer_id: 44,
              enforcer_name: "Stored Session Personnel",
              session_status: "active"
            }]];
          }
          if (normalizedSql.startsWith("SELECT id, ticket_number, status FROM dispatch_tickets")) {
            return [sharedTickets.filter((ticket) =>
              ticket.truck_id === parameters[0] &&
              NON_TERMINAL_TICKET_STATUSES.has(ticket.status)
            )];
          }
          if (normalizedSql.startsWith("SELECT id FROM dispatch_tickets WHERE ticket_number")) {
            return [sharedTickets.filter((ticket) => ticket.ticket_number === parameters[0])];
          }
          if (normalizedSql.startsWith("INSERT INTO dispatch_tickets")) {
            if (state.lockAttempts < 2) await secondAttempted;
            const id = ++nextTicketId;
            sharedTickets.push({
              id,
              ticket_number: parameters[0],
              truck_id: parameters[1],
              status: "prepared"
            });
            return [{ insertId: id }];
          }
          if (
            normalizedSql.startsWith("INSERT INTO dispatch_route_stops") ||
            normalizedSql.startsWith("INSERT INTO dispatch_events")
          ) {
            return [{ affectedRows: 1, insertId: 600 }];
          }
          throw new Error(`Unexpected SQL: ${normalizedSql}`);
        }
      };
    }
  };
  const service = new DispatchService(pool, {
    now: () => new Date("2026-08-03T00:00:00.000Z")
  });
  service.getTicketDetails = async (ticketId) => ({ ticket: { id: ticketId } });

  const results = await Promise.allSettled([
    service.createTicket(ticketPayload({ ticket_number: "CONCURRENT-A" })),
    service.createTicket(ticketPayload({ ticket_number: "CONCURRENT-B" }))
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assertTruckAlreadyAssigned(rejected[0].reason);
  assert.equal(sharedTickets.length, 1);
  assert.equal(state.commits, 1);
  assert.equal(state.rollbacks, 1);
  assert.equal(state.lockAttempts, 2);
  assert.equal(truckRowLock.maxHeldCount, 1);
  assert.ok(state.lockSql.every(({ sql, parameters }) =>
    sql.includes("ORDER BY id ASC LIMIT 1 FOR UPDATE") &&
    parameters[0] === "TRUCK-9"
  ));
}

async function testConcurrentLegacyPreparedIssuesCannotBothDispatch() {
  const tickets = [
    { id: 77, ticket_number: "LEGACY-77", truck_id: "TRUCK-9", status: "prepared" },
    { id: 88, ticket_number: "LEGACY-88", truck_id: "TRUCK-9", status: "prepared" }
  ];
  const truckRowLock = createSharedTruckRowLock();
  const state = { lockAttempts: 0, dispatchedUpdates: 0 };
  let releaseSecondAttempt;
  const secondAttempted = new Promise((resolve) => { releaseSecondAttempt = resolve; });

  const pool = {
    async getConnection() {
      let releaseTruckLock = null;
      return {
        async beginTransaction() {},
        async commit() { releaseTruckLock?.(); },
        async rollback() { releaseTruckLock?.(); },
        release() {},
        async query(sql, parameters = []) {
          const normalizedSql = sql.replace(/\s+/g, " ").trim();
          if (normalizedSql.startsWith("SELECT id, truck_id FROM dispatch_tickets")) {
            const ticket = tickets.find((candidate) => candidate.id === Number(parameters[0]));
            return [ticket ? [{ id: ticket.id, truck_id: ticket.truck_id }] : []];
          }
          if (normalizedSql.startsWith("SELECT * FROM dispatch_tickets")) {
            return [[{ ...tickets.find((ticket) => ticket.id === Number(parameters[0])) }]];
          }
          if (normalizedSql.startsWith("SELECT id FROM truck_tracking_sessions WHERE truck_id")) {
            state.lockAttempts += 1;
            if (state.lockAttempts === 2) releaseSecondAttempt();
            releaseTruckLock = await truckRowLock.acquire();
            return [[{ id: 1 }]];
          }
          if (normalizedSql.startsWith("SELECT id, ticket_number, status FROM dispatch_tickets")) {
            if (state.lockAttempts < 2) await secondAttempted;
            const excludedTicketId = Number(parameters.at(-1));
            return [tickets.filter((ticket) =>
              ticket.truck_id === parameters[0] &&
              NON_TERMINAL_TICKET_STATUSES.has(ticket.status) &&
              ticket.id !== excludedTicketId
            )];
          }
          if (
            normalizedSql.startsWith("UPDATE dispatch_tickets") &&
            normalizedSql.includes("SET status = 'dispatched'")
          ) {
            state.dispatchedUpdates += 1;
            return [{ affectedRows: 1 }];
          }
          if (normalizedSql.startsWith("INSERT INTO dispatch_events")) {
            return [{ affectedRows: 1, insertId: 600 }];
          }
          throw new Error(`Unexpected SQL: ${normalizedSql}`);
        }
      };
    }
  };
  const service = new DispatchService(pool);

  const results = await Promise.allSettled([
    service.issueTicket(77),
    service.issueTicket(88)
  ]);
  assert.equal(results.filter((result) => result.status === "rejected").length, 2);
  results.forEach((result) => assertTruckAlreadyAssigned(result.reason));
  assert.equal(state.dispatchedUpdates, 0);
  assert.equal(state.lockAttempts, 2);
  assert.equal(truckRowLock.maxHeldCount, 1);
}

async function testUnexpectedCreateErrorReturnsSafeOperatorMessage() {
  const originalCreateTicket = dispatchServiceModule.createTicket;
  const originalConsoleError = console.error;
  dispatchServiceModule.createTicket = async () => {
    throw Object.assign(
      new Error("You have an error in your SQL syntax near dispatch_ticket_sequences"),
      { code: "ER_PARSE_ERROR" }
    );
  };
  console.error = () => {};
  delete require.cache[require.resolve("../controllers/dispatchController")];
  const controller = require("../controllers/dispatchController");
  const response = {
    statusCode: null,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; }
  };
  try {
    await controller.createTicket({ body: ticketPayload() }, response);
    assert.equal(response.statusCode, 500);
    assert.equal(
      response.body.message,
      "Dispatch ticket could not be created. Your route is still saved. Please retry."
    );
    assert.equal(response.body.code, "DISPATCH_REQUEST_FAILED");
    assert.doesNotMatch(response.body.message, /SQL|dispatch_ticket_sequences/i);
  } finally {
    dispatchServiceModule.createTicket = originalCreateTicket;
    console.error = originalConsoleError;
  }
}

async function testDuplicateCreateErrorReturnsExactOperatorMessage() {
  const originalCreateTicket = dispatchServiceModule.createTicket;
  dispatchServiceModule.createTicket = async () => {
    throw Object.assign(
      new Error("This ticket number is already in use."),
      { statusCode: 409, code: "DISPATCH_TICKET_NUMBER_DUPLICATE" }
    );
  };
  delete require.cache[require.resolve("../controllers/dispatchController")];
  const controller = require("../controllers/dispatchController");
  const response = {
    statusCode: null,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; }
  };
  try {
    await controller.createTicket({ body: ticketPayload() }, response);
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.message, "This ticket number is already in use.");
    assert.equal(response.body.code, "DISPATCH_TICKET_NUMBER_DUPLICATE");
    assert.doesNotMatch(response.body.message, /SQL|duplicate entry|ticket_number/i);
  } finally {
    dispatchServiceModule.createTicket = originalCreateTicket;
  }
}

async function testTruckConflictReturnsExactControllerPayload() {
  const originalCreateTicket = dispatchServiceModule.createTicket;
  dispatchServiceModule.createTicket = async () => {
    throw Object.assign(
      new Error("This truck already has a non-terminal dispatch ticket."),
      { statusCode: 409, code: "DISPATCH_TRUCK_ALREADY_ASSIGNED" }
    );
  };
  delete require.cache[require.resolve("../controllers/dispatchController")];
  const controller = require("../controllers/dispatchController");
  const response = {
    statusCode: null,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; }
  };
  try {
    await controller.createTicket({ body: ticketPayload() }, response);
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.body, {
      success: false,
      message: "This truck already has a non-terminal dispatch ticket.",
      code: "DISPATCH_TRUCK_ALREADY_ASSIGNED"
    });
  } finally {
    dispatchServiceModule.createTicket = originalCreateTicket;
  }
}

function testMissingDispatchTableRecognition() {
  assert.equal(
    isDispatchTableMissingError({
      code: "ER_NO_SUCH_TABLE",
      message: "Table dispatch_tickets does not exist"
    }),
    true
  );
  assert.equal(
    isDispatchTableMissingError({
      code: "DISPATCH_DATABASE_SETUP_REQUIRED",
      cause: { code: "ER_BAD_TABLE_ERROR" }
    }),
    true
  );
  assert.equal(
    isDispatchTableMissingError({
      code: "PROTOCOL_CONNECTION_LOST",
      message: "Connection lost"
    }),
    false
  );
}

async function run() {
  await testTicketNumberSequenceUsesLock();
  await testSequenceInitializesAndIncrementsWithoutDuplicates();
  await testCreateTicketUsesCurrentManilaDateAndOptimizedStops();
  await testNewTicketIgnoresEveryClientDispatchDateVariant();
  await testManualTicketNumberIsRequiredAndPreservesLeadingZeros();
  await testDuplicateTicketNumberIsRejectedSafely();
  await testSelectedActiveSessionMustMatchTruck();
  await testCreateRejectsEveryNonTerminalStatusForSameTruck();
  await testTerminalTicketsAllowNewCreate();
  await testOtherTruckDoesNotBlockCreate();
  await testUnifiedTicketFiltersAreParameterizedAndExcludePersonnel();
  await testSqlFailureRollsBackTicketTransaction();
  await testPreparedTicketKeepsItsOriginalOperatingDateAfterMidnight();
  await testPreparedTicketUpdateRejectsOccupiedDestinationTruck();
  await testPreparedTicketUpdateExcludesItself();
  await testIssueRejectsAnotherPreparedTicketForSameTruck();
  await testTrackingSessionAlreadyLinkedBehaviorIsUnchanged();
  await testLinkSessionRejectsAnotherNonTerminalTicketForTruck();
  await testSameTicketSessionLinkRemainsIdempotent();
  await testConcurrentSameTruckCreatesSerializeAndOnlyOneCommits();
  await testConcurrentLegacyPreparedIssuesCannotBothDispatch();
  await testUnexpectedCreateErrorReturnsSafeOperatorMessage();
  await testDuplicateCreateErrorReturnsExactOperatorMessage();
  await testTruckConflictReturnsExactControllerPayload();
  testMissingDispatchTableRecognition();
  console.log("Dispatch service mock tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
