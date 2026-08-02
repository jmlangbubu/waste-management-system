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
  currentManilaDate,
  isDispatchTableMissingError
} = dispatchServiceModule;
Module._load = originalModuleLoad;

function ticketPayload(overrides = {}) {
  return {
    truck_id: "TRUCK-9",
    truck_name_snapshot: "Truck 9",
    route_name: "Current operating route",
    dispatch_date: "2099-12-31",
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

function createTransactionalPool({ failTicketInsert = false } = {}) {
  const state = {
    sequence: new Map(),
    calls: [],
    ticketParameters: null,
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
  assert.equal(state.ticketParameters[5], "2026-08-03");
  assert.notEqual(state.ticketParameters[5], "2099-12-31");
  assert.equal(state.sequence.get(2026), 1);
  assert.equal(state.began, true);
  assert.equal(state.committed, true);
  assert.equal(state.rolledBack, false);
  assert.equal(state.released, true);
  const ticketInsertIndex = state.calls.findIndex((call) => call.sql.startsWith("INSERT INTO dispatch_tickets"));
  const stopInsertIndex = state.calls.findIndex((call) => call.sql.startsWith("INSERT INTO dispatch_route_stops"));
  assert.ok(ticketInsertIndex >= 0 && stopInsertIndex > ticketInsertIndex);
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
          status: "prepared",
          dispatch_date: "2026-08-02"
        }]];
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
  await testSqlFailureRollsBackTicketTransaction();
  await testPreparedTicketKeepsItsOriginalOperatingDateAfterMidnight();
  await testUnexpectedCreateErrorReturnsSafeOperatorMessage();
  testMissingDispatchTableRecognition();
  console.log("Dispatch service mock tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
