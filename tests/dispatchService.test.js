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

const {
  DispatchService,
  isDispatchTableMissingError
} = require("../services/dispatchService");
Module._load = originalModuleLoad;

async function testTicketNumberSequenceUsesLock() {
  const calls = [];
  const connection = {
    async query(sql, parameters) {
      const normalizedSql = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: normalizedSql, parameters });

      if (normalizedSql.startsWith("SELECT last_value")) {
        return [[{ last_value: 41 }]];
      }
      return [{ affectedRows: 1 }];
    }
  };
  const service = new DispatchService({});
  const ticketNumber = await service.generateTicketNumber(connection, 2026);

  assert.equal(ticketNumber, "DPT-2026-0042");
  assert.equal(calls.length, 3);
  assert.match(calls[1].sql, /SELECT last_value/);
  assert.match(calls[1].sql, /FOR UPDATE/);
  assert.doesNotMatch(calls.map((call) => call.sql).join(" "), /COUNT\s*\(/i);
  assert.deepEqual(calls[2].parameters, [42, 2026]);
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
  testMissingDispatchTableRecognition();
  console.log("Dispatch service mock tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
