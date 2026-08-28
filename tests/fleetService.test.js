const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const projectRoot = path.join(__dirname, "..");
const originalModuleLoad = Module._load;
Module._load = function loadWithMockedFleetPool(request, parent, isMain) {
  if (
    request === "../config/dbPromise" &&
    parent?.filename.replace(/\\/g, "/").endsWith("services/fleetService.js")
  ) {
    return {};
  }
  if (
    request === "../services/webSessionService" &&
    parent?.filename.replace(/\\/g, "/").endsWith("middleware/webSessionAuth.js")
  ) {
    return {
      validateSession: async () => {
        throw new Error("not used by fleet role tests");
      },
      hashOpaqueToken: (value) => String(value || ""),
      normalizeWebRole: (value) => String(value || "").trim().toLowerCase()
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
const {
  FleetService,
  FleetServiceError
} = require("../services/fleetService");
const { requireWebRole } = require("../middleware/webSessionAuth");
Module._load = originalModuleLoad;

const tests = [];
function test(name, callback) {
  tests.push({ name, callback });
}

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function mockPool(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      return handler(sql, parameters, calls.length);
    }
  };
}

function listPool(overrides = {}) {
  return mockPool(async (sql) => {
    if (sql.includes("FROM fleet_trucks") && sql.includes("ORDER BY truck_name")) {
      return [overrides.fleet || []];
    }
    if (sql.includes("FROM dispatch_tickets")) return [overrides.dispatches || []];
    if (sql.includes("FROM truck_tracking_sessions")) return [overrides.tracking || []];
    if (sql.includes("FROM dispatch_plans")) return [overrides.plans || []];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
}

function createPool(options = {}) {
  let insertId = Number(options.firstInsertId || 1);
  return mockPool(async (sql) => {
    if (sql.includes("SELECT id, truck_code, plate_number")) {
      return [options.duplicates || []];
    }
    if (sql.includes("INSERT INTO fleet_trucks")) {
      return [{ insertId: insertId++ }];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
}

function updatePool(existingRow) {
  return mockPool(async (sql) => {
    if (sql.includes("FROM fleet_trucks") && sql.includes("WHERE id = ?")) {
      return [existingRow ? [existingRow] : []];
    }
    if (sql.includes("UPDATE fleet_trucks")) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
}

function assertFleetError(error, code, statusCode) {
  assert.ok(error instanceof FleetServiceError);
  assert.equal(error.code, code);
  assert.equal(error.statusCode, statusCode);
  return true;
}

async function runRoleMiddleware(role) {
  const req = { user: { role } };
  const res = {
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; }
  };
  let nextCalled = false;
  requireWebRole("super_admin", "personnel")(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

test("empty fleet returns an empty list", async () => {
  const pool = listPool();
  const rows = await new FleetService(pool).listTrucks();
  assert.deepEqual(rows, []);
  assert.equal(pool.calls.length, 1);
});

test("summary with no fleet has a zero total", async () => {
  const summary = await new FleetService(listPool()).getSummary();
  assert.deepEqual(summary, {
    total: 0,
    available: 0,
    for_maintenance: 0,
    out_of_service: 0,
    active: 0,
    returning: 0,
    tracking_awaiting_dispatch: 0,
    planned: 0,
    off_duty: 0
  });
});

test("creates an available truck with parameterized SQL", async () => {
  const pool = createPool({ firstInsertId: 41 });
  const truck = await new FleetService(pool).createTruck({
    truck_code: " TRUCK-04 ",
    truck_name: " WMO Truck 04 "
  }, { id: 7 });
  assert.equal(truck.id, 41);
  assert.equal(truck.truck_code, "TRUCK-04");
  assert.equal(truck.fleet_condition, "available");
  const insert = pool.calls.find((call) => call.sql.includes("INSERT INTO fleet_trucks"));
  assert.ok(insert);
  assert.equal((insert.sql.match(/\?/g) || []).length, insert.parameters.length);
});

test("rejects a duplicate truck code", async () => {
  const service = new FleetService(createPool({
    duplicates: [{ id: 1, truck_code: "TRUCK-04", plate_number: null }]
  }));
  await assert.rejects(
    () => service.createTruck({ truck_code: "TRUCK-04", truck_name: "Truck" }, { id: 7 }),
    (error) => assertFleetError(error, "FLEET_TRUCK_CODE_DUPLICATE", 409)
  );
});

test("allows multiple NULL plate numbers", async () => {
  const pool = createPool();
  const service = new FleetService(pool);
  await service.createTruck({ truck_code: "TRUCK-04", truck_name: "Truck 04" }, { id: 7 });
  await service.createTruck({ truck_code: "TRUCK-05", truck_name: "Truck 05" }, { id: 7 });
  const inserts = pool.calls.filter((call) => call.sql.includes("INSERT INTO fleet_trucks"));
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0].parameters[2], null);
  assert.equal(inserts[1].parameters[2], null);
});

test("rejects a duplicate non-null plate number", async () => {
  const service = new FleetService(createPool({
    duplicates: [{ id: 1, truck_code: "TRUCK-03", plate_number: "ABC-123" }]
  }));
  await assert.rejects(
    () => service.createTruck({
      truck_code: "TRUCK-04",
      truck_name: "Truck",
      plate_number: "ABC-123"
    }, { id: 7 }),
    (error) => assertFleetError(error, "FLEET_PLATE_DUPLICATE", 409)
  );
});

test("rejects an invalid fleet condition", async () => {
  const service = new FleetService(createPool());
  await assert.rejects(
    () => service.createTruck({
      truck_code: "TRUCK-04",
      truck_name: "Truck",
      fleet_condition: "active"
    }, { id: 7 }),
    (error) => assertFleetError(error, "FLEET_CONDITION_INVALID", 400)
  );
});

test("requires a reason for maintenance", async () => {
  const service = new FleetService(createPool());
  await assert.rejects(
    () => service.createTruck({
      truck_code: "TRUCK-04",
      truck_name: "Truck",
      fleet_condition: "for_maintenance"
    }, { id: 7 }),
    (error) => assertFleetError(error, "FLEET_CONDITION_REASON_REQUIRED", 400)
  );
});

test("requires a reason for out of service", async () => {
  const service = new FleetService(createPool());
  await assert.rejects(
    () => service.createTruck({
      truck_code: "TRUCK-04",
      truck_name: "Truck",
      fleet_condition: "out_of_service"
    }, { id: 7 }),
    (error) => assertFleetError(error, "FLEET_CONDITION_REASON_REQUIRED", 400)
  );
});

test("updates a truck to maintenance with its reason", async () => {
  const pool = updatePool({
    id: 4,
    truck_code: "TRUCK-04",
    truck_name: "Truck 04",
    plate_number: null,
    fleet_condition: "available",
    condition_reason: null
  });
  const truck = await new FleetService(pool, {
    now: () => new Date("2026-08-29T01:00:00Z")
  }).updateCondition(4, {
    fleet_condition: "for_maintenance",
    condition_reason: "Brake inspection"
  }, { id: 8 });
  assert.equal(truck.fleet_condition, "for_maintenance");
  assert.equal(truck.condition_reason, "Brake inspection");
  const update = pool.calls.find((call) => call.sql.includes("UPDATE fleet_trucks"));
  assert.deepEqual(update.parameters, ["for_maintenance", "Brake inspection", 8, 4]);
});

test("returning a truck to available clears a stale condition reason", async () => {
  const pool = updatePool({
    id: 4,
    truck_code: "TRUCK-04",
    truck_name: "Truck 04",
    plate_number: null,
    fleet_condition: "for_maintenance",
    condition_reason: "Old reason"
  });
  const truck = await new FleetService(pool).updateCondition(4, {
    fleet_condition: "available",
    condition_reason: "must not persist"
  }, { id: 8 });
  assert.equal(truck.fleet_condition, "available");
  assert.equal(truck.condition_reason, null);
  const update = pool.calls.find((call) => call.sql.includes("UPDATE fleet_trucks"));
  assert.equal(update.parameters[1], null);
});

test("uses the authenticated session actor instead of body actor fields", async () => {
  const pool = createPool();
  await new FleetService(pool).createTruck({
    truck_code: "TRUCK-04",
    truck_name: "Truck 04",
    created_by_web_user_id: 999,
    condition_updated_by_web_user_id: 999
  }, { id: 12 });
  const insert = pool.calls.find((call) => call.sql.includes("INSERT INTO fleet_trucks"));
  assert.equal(insert.parameters[5], 12);
  assert.equal(insert.parameters[6], 12);
  assert.equal(insert.parameters.includes(999), false);
});

test("unauthorized Web Admin roles are rejected", async () => {
  for (const role of ["division_admin", "supervisor", "clerk_admin"]) {
    const { res, nextCalled } = await runRoleMiddleware(role);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "WEB_ROLE_FORBIDDEN");
  }
});

function operationalFixture() {
  return {
    fleet: [
      { id: 1, truck_code: "RETURN", truck_name: "Returning", fleet_condition: "available" },
      { id: 2, truck_code: "ACTIVE", truck_name: "Active", fleet_condition: "available" },
      { id: 3, truck_code: "TRACKING", truck_name: "Tracking", fleet_condition: "available" },
      { id: 4, truck_code: "PLANNED", truck_name: "Planned", fleet_condition: "available" },
      { id: 5, truck_code: "OFF", truck_name: "Off", fleet_condition: "available" },
      { id: 6, truck_code: "MAINT-ACTIVE", truck_name: "Maintenance Active", fleet_condition: "for_maintenance", condition_reason: "Repair" }
    ],
    dispatches: [
      { id: 10, truck_id: "RETURN", status: "returning_to_wmo", ticket_number: "DPT-10" },
      { id: 11, truck_id: "ACTIVE", status: "in_progress", ticket_number: "DPT-11" },
      { id: 12, truck_id: "MAINT-ACTIVE", status: "dispatched", ticket_number: "DPT-12" }
    ],
    tracking: [
      { id: 20, truck_id: "RETURN", gps_status: "stale" },
      { id: 21, truck_id: "ACTIVE", gps_status: "online" },
      { id: 22, truck_id: "TRACKING", gps_status: "online" },
      { id: 23, truck_id: "MAINT-ACTIVE", gps_status: "offline" }
    ],
    plans: [
      { id: 30, fleet_truck_id: 1, operational_date: "2026-08-30", status: "planned" },
      { id: 31, fleet_truck_id: 3, operational_date: "2026-08-30", status: "planned" },
      { id: 32, fleet_truck_id: 4, operational_date: "2026-08-30", status: "planned", route_name: "North" }
    ]
  };
}

async function operationalRows() {
  return new FleetService(listPool(operationalFixture()), {
    now: () => new Date("2026-08-29T01:00:00Z")
  }).listTrucks();
}

test("derives active dispatch operational state", async () => {
  const row = (await operationalRows()).find((truck) => truck.truck_code === "ACTIVE");
  assert.equal(row.operational_state, "Active / On Dispatch");
  assert.equal(row.active_dispatch_ticket_id, 11);
  assert.equal(row.assignable, false);
});

test("returning to WMO takes precedence over tracking and planning", async () => {
  const row = (await operationalRows()).find((truck) => truck.truck_code === "RETURN");
  assert.equal(row.operational_state_key, "returning_to_wmo");
  assert.equal(row.operational_state, "Returning to WMO");
  assert.equal(row.active_tracking_session_id, 20);
});

test("derives tracking active and awaiting dispatch", async () => {
  const row = (await operationalRows()).find((truck) => truck.truck_code === "TRACKING");
  assert.equal(row.operational_state, "Tracking Active / Awaiting Dispatch");
  assert.equal(row.gps_status, "online");
  assert.equal(row.assignable, false);
});

test("derives planned state only when no active operation supersedes it", async () => {
  const row = (await operationalRows()).find((truck) => truck.truck_code === "PLANNED");
  assert.equal(row.operational_state, "Planned for 2026-08-30");
  assert.equal(row.operational_date, "2026-08-30");
  assert.equal(row.assignable, false);
});

test("derives off duty and assignable for an otherwise free available truck", async () => {
  const row = (await operationalRows()).find((truck) => truck.truck_code === "OFF");
  assert.equal(row.operational_state, "Off Duty");
  assert.equal(row.assignable, true);
});

test("maintenance condition always blocks assignment", async () => {
  const row = (await operationalRows()).find((truck) => truck.truck_code === "MAINT-ACTIVE");
  assert.equal(row.fleet_condition, "for_maintenance");
  assert.equal(row.assignable, false);
});

test("an active maintenance truck remains monitorable in its actual state", async () => {
  const row = (await operationalRows()).find((truck) => truck.truck_code === "MAINT-ACTIVE");
  assert.equal(row.operational_state, "Active / On Dispatch");
  assert.equal(row.active_dispatch_ticket_id, 12);
  assert.equal(row.active_tracking_session_id, 23);
  assert.equal(row.gps_status, "offline");
});

test("condition and operational summary dimensions remain separate", async () => {
  const summary = await new FleetService(listPool(operationalFixture()), {
    now: () => new Date("2026-08-29T01:00:00Z")
  }).getSummary();
  assert.equal(summary.total, 6);
  assert.equal(summary.available, 5);
  assert.equal(summary.for_maintenance, 1);
  assert.equal(summary.returning, 1);
  assert.equal(summary.active, 2);
  assert.equal(summary.tracking_awaiting_dispatch, 1);
  assert.equal(summary.planned, 1);
  assert.equal(summary.off_duty, 1);
});

test("missing fleet truck returns a safe not-found error", async () => {
  await assert.rejects(
    () => new FleetService(updatePool(null)).updateCondition(99, {
      fleet_condition: "available"
    }, { id: 8 }),
    (error) => assertFleetError(error, "FLEET_TRUCK_NOT_FOUND", 404)
  );
});

test("unexpected database errors are normalized without SQL detail", async () => {
  const pool = mockPool(async () => {
    const error = new Error("SELECT secret FROM internal_table");
    error.code = "PROTOCOL_CONNECTION_LOST";
    throw error;
  });
  await assert.rejects(
    () => new FleetService(pool).listTrucks(),
    (error) => {
      assertFleetError(error, "FLEET_DATABASE_UNAVAILABLE", 503);
      assert.doesNotMatch(error.message, /SELECT|internal_table/i);
      return true;
    }
  );
});

test("fleet routes use Web Admin auth, exact roles, CSRF, and no delete API", () => {
  const routes = read("routes/fleetRoutes.js");
  assert.match(routes, /router\.use\(requireWebAuth\)/);
  assert.match(routes, /requireWebRole\("super_admin", "personnel"\)/);
  assert.match(routes, /router\.use\(requireCsrf\)/);
  assert.match(routes, /router\.get\("\/trucks"/);
  assert.match(routes, /router\.get\("\/summary"/);
  assert.match(routes, /router\.post\("\/trucks"/);
  assert.match(routes, /router\.patch\("\/trucks\/:id\/condition"/);
  assert.doesNotMatch(routes, /router\.delete/i);
  assert.equal((read("server/server.js").match(/app\.use\("\/api\/fleet"/g) || []).length, 1);
});

test("fleet controllers pass only the authenticated user as actor", () => {
  const controller = read("controllers/fleetController.js");
  assert.match(controller, /fleetService\.createTruck\(req\.body \|\| \{\}, req\.user\)/);
  assert.match(controller, /fleetService\.updateCondition\([\s\S]*req\.user/);
  assert.doesNotMatch(controller, /created_by_web_user_id/);
  assert.doesNotMatch(controller, /condition_updated_by_web_user_id/);
});

async function run() {
  let passed = 0;
  for (const current of tests) {
    try {
      await current.callback();
      passed += 1;
    } catch (error) {
      error.message = `${current.name}: ${error.message}`;
      throw error;
    }
  }
  console.log(`Fleet service tests passed (${passed}/${tests.length})`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
