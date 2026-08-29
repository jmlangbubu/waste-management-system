const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const projectRoot = path.join(__dirname, "..");
const originalModuleLoad = Module._load;
Module._load = function loadWithMockedPlanningPool(request, parent, isMain) {
  if (
    request === "../config/dbPromise" &&
    parent?.filename.replace(/\\/g, "/").endsWith("services/dispatchPlanService.js")
  ) {
    return {};
  }
  if (
    request === "../services/webSessionService" &&
    parent?.filename.replace(/\\/g, "/").endsWith("middleware/webSessionAuth.js")
  ) {
    return {
      validateSession: async () => {
        throw new Error("not used by planning role tests");
      },
      hashOpaqueToken: (value) => String(value || ""),
      normalizeWebRole: (value) => String(value || "").trim().toLowerCase()
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
const {
  DispatchPlanService,
  DispatchPlanServiceError,
  currentManilaDate,
  operationalDate,
  optionalManilaDateTime,
  normalizePlanError
} = require("../services/dispatchPlanService");
const {
  buildRequireWebAuth,
  requireWebRole
} = require("../middleware/webSessionAuth");
Module._load = originalModuleLoad;

const tests = [];
function test(name, callback) {
  tests.push({ name, callback });
}

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultState(overrides = {}) {
  return {
    trucks: [
      {
        id: 1,
        truck_code: "SYNTH-TRUCK-A",
        truck_name: "Synthetic Truck A",
        plate_number: "TEST-001",
        fleet_condition: "available"
      },
      {
        id: 2,
        truck_code: "SYNTH-MAINT",
        truck_name: "Synthetic Maintenance",
        plate_number: null,
        fleet_condition: "for_maintenance"
      },
      {
        id: 3,
        truck_code: "SYNTH-OOS",
        truck_name: "Synthetic Out of Service",
        plate_number: null,
        fleet_condition: "out_of_service"
      },
      {
        id: 4,
        truck_code: "SYNTH-TRUCK-B",
        truck_name: "Synthetic Truck B",
        plate_number: null,
        fleet_condition: "available"
      }
    ],
    users: [
      {
        id: 11,
        full_name: "Synthetic Enforcer One",
        username: "synthetic_enforcer_one",
        role: "enforcer",
        mobile_role: "enforcer",
        status: "active"
      },
      {
        id: 12,
        full_name: "Synthetic Enforcer Two",
        username: "synthetic_enforcer_two",
        role: "enforcer",
        mobile_role: "enforcer",
        status: "active"
      },
      {
        id: 13,
        full_name: "Synthetic Inactive Enforcer",
        username: "synthetic_inactive",
        role: "enforcer",
        mobile_role: "enforcer",
        status: "inactive"
      },
      {
        id: 14,
        full_name: "Synthetic Barangay User",
        username: "synthetic_barangay",
        role: "barangay",
        mobile_role: "barangay",
        status: "active"
      }
    ],
    destinations: [
      {
        id: 101,
        name: "Synthetic Road One",
        display_label: "Synthetic Road One",
        barangay: "Synthetic Barangay A",
        latitude: "6.1100000",
        longitude: "125.1700000",
        is_verified: 1,
        is_active: 1
      },
      {
        id: 102,
        name: "Synthetic Hall Two",
        display_label: "Synthetic Hall Two",
        barangay: "Synthetic Barangay B",
        latitude: "6.1200000",
        longitude: "125.1800000",
        is_verified: 1,
        is_active: 1
      },
      {
        id: 103,
        name: "Unverified Synthetic Place",
        display_label: "Unverified Synthetic Place",
        barangay: "Synthetic Barangay C",
        latitude: "6.1300000",
        longitude: "125.1900000",
        is_verified: 0,
        is_active: 1
      }
    ],
    plans: [],
    stops: [],
    nextPlanId: 1,
    nextStopId: 1,
    ...deepClone(overrides)
  };
}

function planFixture(overrides = {}) {
  return {
    id: 1,
    operational_date: "2026-08-30",
    fleet_truck_id: 1,
    truck_code_snapshot: "SYNTH-TRUCK-A",
    truck_name_snapshot: "Synthetic Truck A",
    assigned_enforcer_user_id: 11,
    assigned_enforcer_name_snapshot: "Synthetic Enforcer One",
    route_name: "Synthetic Route",
    route_description: "Synthetic description",
    planned_route_snapshot: null,
    stop_signature: "v1|1:6.110000,125.170000",
    scheduled_start_at: "2026-08-30 08:00:00",
    expected_return_at: "2026-08-30 17:00:00",
    status: "planned",
    notes: null,
    revision: 1,
    created_by_web_user_id: 7,
    updated_by_web_user_id: null,
    cancelled_by_web_user_id: null,
    cancellation_reason: null,
    cancelled_at: null,
    created_at: "2026-08-29 10:00:00",
    updated_at: "2026-08-29 10:00:00",
    ...overrides
  };
}

function stopFixture(overrides = {}) {
  return {
    id: 1,
    dispatch_plan_id: 1,
    stop_order: 1,
    destination_id: 101,
    location_name_snapshot: "Synthetic Road One",
    address_reference_snapshot: "Synthetic Barangay A",
    latitude: 6.11,
    longitude: 125.17,
    geofence_radius_meters: 100,
    expected_arrival_at: "2026-08-30 09:00:00",
    created_at: "2026-08-29 10:00:00",
    updated_at: "2026-08-29 10:00:00",
    ...overrides
  };
}

function createMockDatabase(overrides = {}, options = {}) {
  const state = defaultState(overrides);
  const calls = [];
  const transaction = {
    began: 0,
    committed: 0,
    rolledBack: 0,
    released: 0
  };
  let backup = null;

  function planRowForResponse(plan) {
    return {
      ...plan,
      description: plan.route_description,
      scheduled_start: plan.scheduled_start_at,
      expected_return: plan.expected_return_at,
      stop_count: state.stops.filter((stop) => stop.dispatch_plan_id === plan.id).length
    };
  }

  function stopRowForResponse(stop) {
    return {
      ...stop,
      expected_arrival: stop.expected_arrival_at
    };
  }

  async function handle(sql, parameters = [], transactional = false) {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    calls.push({ sql: normalized, parameters: [...parameters], transactional });

    if (normalized.includes("FROM fleet_trucks ft")) {
      const date = parameters[0];
      const rows = state.trucks.filter((truck) => {
        if (truck.fleet_condition !== "available") return false;
        return !state.plans.some((plan) =>
          plan.fleet_truck_id === truck.id &&
          plan.operational_date === date &&
          ["planned", "activated"].includes(plan.status)
        );
      });
      return [deepClone(rows)];
    }
    if (normalized.includes("FROM users u") && normalized.includes("display_name")) {
      const date = parameters[0];
      const rows = state.users.filter((user) => {
        const roleEligible = [user.role, user.mobile_role]
          .map((role) => String(role || "").toLowerCase())
          .includes("enforcer");
        if (String(user.status).toLowerCase() !== "active" || !roleEligible) return false;
        return !state.plans.some((plan) =>
          plan.assigned_enforcer_user_id === user.id &&
          plan.operational_date === date &&
          ["planned", "activated"].includes(plan.status)
        );
      }).map((user) => ({
        id: user.id,
        display_name: user.full_name || user.username,
        mobile_role: "enforcer"
      }));
      return [rows];
    }
    if (normalized.includes("FROM fleet_trucks") && normalized.includes("WHERE id = ?")) {
      return [[deepClone(state.trucks.find((truck) => truck.id === Number(parameters[0])) || null)].filter(Boolean)];
    }
    if (normalized.includes("FROM users") && normalized.includes("WHERE id = ?")) {
      return [[deepClone(state.users.find((user) => user.id === Number(parameters[0])) || null)].filter(Boolean)];
    }
    if (
      normalized.includes("FROM dispatch_plans") &&
      normalized.includes("fleet_truck_id = ?") &&
      normalized.includes("FOR UPDATE")
    ) {
      const [date, truckId, firstStatus, secondStatus, excludedId] = parameters;
      return [[...state.plans.filter((plan) =>
        plan.operational_date === date &&
        plan.fleet_truck_id === Number(truckId) &&
        [firstStatus, secondStatus].includes(plan.status) &&
        (!excludedId || plan.id !== Number(excludedId))
      ).slice(0, 1)]];
    }
    if (
      normalized.includes("FROM dispatch_plans") &&
      normalized.includes("assigned_enforcer_user_id = ?") &&
      normalized.includes("FOR UPDATE")
    ) {
      const [date, enforcerId, firstStatus, secondStatus, excludedId] = parameters;
      return [[...state.plans.filter((plan) =>
        plan.operational_date === date &&
        plan.assigned_enforcer_user_id === Number(enforcerId) &&
        [firstStatus, secondStatus].includes(plan.status) &&
        (!excludedId || plan.id !== Number(excludedId))
      ).slice(0, 1)]];
    }
    if (normalized.includes("FROM gensan_dispatch_destinations")) {
      const ids = parameters.map(Number);
      return [[...state.destinations.filter((destination) =>
        ids.includes(destination.id) &&
        Number(destination.is_verified) === 1 &&
        Number(destination.is_active) === 1
      )]];
    }
    if (normalized.startsWith("INSERT INTO dispatch_plans")) {
      if (options.duplicateOnPlanInsert) {
        const error = new Error(options.duplicateOnPlanInsert);
        error.code = "ER_DUP_ENTRY";
        error.sqlMessage = options.duplicateOnPlanInsert;
        throw error;
      }
      const id = state.nextPlanId++;
      state.plans.push(planFixture({
        id,
        operational_date: parameters[0],
        fleet_truck_id: Number(parameters[1]),
        truck_code_snapshot: parameters[2],
        truck_name_snapshot: parameters[3],
        assigned_enforcer_user_id: Number(parameters[4]),
        assigned_enforcer_name_snapshot: parameters[5],
        route_name: parameters[6],
        route_description: parameters[7],
        planned_route_snapshot: null,
        stop_signature: parameters[8],
        scheduled_start_at: parameters[9],
        expected_return_at: parameters[10],
        status: "planned",
        notes: parameters[11],
        revision: 1,
        created_by_web_user_id: Number(parameters[12])
      }));
      return [{ insertId: id, affectedRows: 1 }];
    }
    if (normalized.startsWith("INSERT INTO dispatch_plan_stops")) {
      if (Number(parameters[1]) === Number(options.failStopOrder)) {
        const error = new Error("Synthetic stop insert failure with private SQL detail");
        error.code = "ER_SYNTHETIC_STOP_FAILURE";
        throw error;
      }
      state.stops.push(stopFixture({
        id: state.nextStopId++,
        dispatch_plan_id: Number(parameters[0]),
        stop_order: Number(parameters[1]),
        destination_id: Number(parameters[2]),
        location_name_snapshot: parameters[3],
        address_reference_snapshot: parameters[4],
        latitude: Number(parameters[5]),
        longitude: Number(parameters[6]),
        geofence_radius_meters: Number(parameters[7]),
        expected_arrival_at: parameters[8]
      }));
      return [{ insertId: state.nextStopId - 1, affectedRows: 1 }];
    }
    if (
      normalized.includes("FROM dispatch_plans") &&
      normalized.includes("WHERE id = ?") &&
      normalized.includes("FOR UPDATE")
    ) {
      const plan = state.plans.find((item) => item.id === Number(parameters[0]));
      return [[plan ? deepClone(plan) : null].filter(Boolean)];
    }
    if (
      normalized.includes("FROM dispatch_plan_stops") &&
      normalized.includes("expected_arrival_at") &&
      normalized.includes("dispatch_plan_id = ?") &&
      normalized.includes("ORDER BY stop_order") &&
      !normalized.includes("location_name_snapshot")
    ) {
      return [[...state.stops
        .filter((stop) => stop.dispatch_plan_id === Number(parameters[0]))
        .sort((left, right) => left.stop_order - right.stop_order)
        .map((stop) => ({
          stop_order: stop.stop_order,
          expected_arrival_at: stop.expected_arrival_at
        }))]];
    }
    if (normalized.startsWith("UPDATE dispatch_plans") && normalized.includes("operational_date = ?")) {
      const id = Number(parameters[14]);
      const plan = state.plans.find((item) => item.id === id && item.status === "planned");
      if (!plan) return [{ affectedRows: 0 }];
      Object.assign(plan, {
        operational_date: parameters[0],
        fleet_truck_id: Number(parameters[1]),
        truck_code_snapshot: parameters[2],
        truck_name_snapshot: parameters[3],
        assigned_enforcer_user_id: Number(parameters[4]),
        assigned_enforcer_name_snapshot: parameters[5],
        route_name: parameters[6],
        route_description: parameters[7],
        planned_route_snapshot: parameters[8],
        stop_signature: parameters[9],
        scheduled_start_at: parameters[10],
        expected_return_at: parameters[11],
        notes: parameters[12],
        updated_by_web_user_id: Number(parameters[13]),
        revision: Number(plan.revision) + 1
      });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith("DELETE FROM dispatch_plan_stops")) {
      const planId = Number(parameters[0]);
      state.stops = state.stops.filter((stop) => stop.dispatch_plan_id !== planId);
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith("UPDATE dispatch_plans") && normalized.includes("status = 'cancelled'")) {
      const id = Number(parameters[3]);
      const plan = state.plans.find((item) => item.id === id && item.status === "planned");
      if (!plan) return [{ affectedRows: 0 }];
      Object.assign(plan, {
        status: "cancelled",
        cancelled_by_web_user_id: Number(parameters[0]),
        cancellation_reason: parameters[1],
        cancelled_at: "2026-08-29 12:00:00",
        updated_by_web_user_id: Number(parameters[2]),
        revision: Number(plan.revision) + 1
      });
      return [{ affectedRows: 1 }];
    }
    if (
      normalized.includes("FROM dispatch_plans dp") &&
      normalized.includes("WHERE dp.id = ?")
    ) {
      const plan = state.plans.find((item) => item.id === Number(parameters[0]));
      return [[plan ? planRowForResponse(plan) : null].filter(Boolean)];
    }
    if (
      normalized.includes("FROM dispatch_plan_stops") &&
      normalized.includes("location_name_snapshot")
    ) {
      const rows = state.stops
        .filter((stop) => stop.dispatch_plan_id === Number(parameters[0]))
        .sort((left, right) => left.stop_order - right.stop_order || left.id - right.id)
        .map(stopRowForResponse);
      return [deepClone(rows)];
    }
    if (
      normalized.includes("FROM dispatch_plans dp") &&
      normalized.includes("stop_summary")
    ) {
      let parameterIndex = 0;
      let rows = [...state.plans];
      if (normalized.includes("dp.operational_date = ?")) {
        const date = parameters[parameterIndex++];
        rows = rows.filter((plan) => plan.operational_date === date);
      }
      if (normalized.includes("dp.status = ?")) {
        const status = parameters[parameterIndex++];
        rows = rows.filter((plan) => plan.status === status);
      }
      rows.sort((left, right) =>
        left.operational_date.localeCompare(right.operational_date) || left.id - right.id
      );
      return [rows.map(planRowForResponse)];
    }
    throw new Error(`Unexpected SQL in planning test: ${normalized}`);
  }

  const connection = {
    async beginTransaction() {
      transaction.began += 1;
      backup = deepClone({
        plans: state.plans,
        stops: state.stops,
        nextPlanId: state.nextPlanId,
        nextStopId: state.nextStopId
      });
    },
    async commit() {
      transaction.committed += 1;
      backup = null;
    },
    async rollback() {
      transaction.rolledBack += 1;
      if (backup) {
        state.plans = backup.plans;
        state.stops = backup.stops;
        state.nextPlanId = backup.nextPlanId;
        state.nextStopId = backup.nextStopId;
      }
    },
    release() {
      transaction.released += 1;
    },
    query(sql, parameters) {
      return handle(sql, parameters, true);
    }
  };

  const pool = {
    calls,
    state,
    transaction,
    async getConnection() {
      if (options.connectionError) throw options.connectionError;
      return connection;
    },
    query(sql, parameters) {
      return handle(sql, parameters, false);
    }
  };
  return pool;
}

function serviceFor(pool) {
  return new DispatchPlanService(pool, {
    now: () => new Date("2026-08-29T01:00:00.000Z")
  });
}

function validPayload(overrides = {}) {
  return {
    operational_date: "2026-08-30",
    fleet_truck_id: 1,
    assigned_enforcer_user_id: 11,
    route_name: "Manual Synthetic Route",
    description: "Manually ordered synthetic destinations",
    scheduled_start: "2026-08-30 08:00",
    expected_return: "2026-08-30 17:00",
    notes: "Synthetic test only",
    stops: [
      { destination_id: 102, stop_order: 2, expected_arrival: "2026-08-30 10:00" },
      { destination_id: 101, stop_order: 1, expected_arrival: "2026-08-30 09:00" }
    ],
    ...overrides
  };
}

function assertPlanError(error, code, statusCode) {
  assert.ok(error instanceof DispatchPlanServiceError);
  assert.equal(error.code, code);
  assert.equal(error.statusCode, statusCode);
  return true;
}

test("Manila date helpers validate the operational calendar without UTC drift", () => {
  assert.equal(currentManilaDate(new Date("2026-08-28T16:30:00Z")), "2026-08-29");
  assert.equal(operationalDate("2026-08-29", new Date("2026-08-28T16:30:00Z")), "2026-08-29");
  assert.equal(
    optionalManilaDateTime("2026-08-30T00:00:00Z", "scheduled_start"),
    "2026-08-30 08:00:00.000"
  );
});

test("creates one planned plan and ordered stop snapshots in one transaction", async () => {
  const pool = createMockDatabase();
  const result = await serviceFor(pool).createPlan({
    ...validPayload(),
    created_by_web_user_id: 999,
    truck_code_snapshot: "SPOOFED-TRUCK",
    truck_name_snapshot: "Spoofed truck name",
    assigned_enforcer_name_snapshot: "Spoofed enforcer",
    planned_route_snapshot: { source: "client" },
    stops: validPayload().stops.map((stop) => ({
      ...stop,
      location_name_snapshot: "Spoofed destination",
      latitude: 0,
      longitude: 0,
      geofence_radius_meters: 9999
    }))
  }, { id: 7 });

  assert.equal(result.status, "planned");
  assert.equal(result.revision, 1);
  assert.equal(pool.transaction.began, 1);
  assert.equal(pool.transaction.committed, 1);
  assert.equal(pool.transaction.rolledBack, 0);
  assert.equal(pool.state.plans[0].created_by_web_user_id, 7);
  assert.equal(pool.state.plans[0].truck_code_snapshot, "SYNTH-TRUCK-A");
  assert.equal(pool.state.plans[0].assigned_enforcer_name_snapshot, "Synthetic Enforcer One");
  assert.equal(pool.state.plans[0].planned_route_snapshot, null);
  assert.deepEqual(result.stops.map((stop) => stop.stop_order), [1, 2]);
  assert.deepEqual(
    result.stops.map((stop) => stop.location_name_snapshot),
    ["Synthetic Road One", "Synthetic Hall Two"]
  );
  assert.deepEqual(
    result.stops.map((stop) => stop.geofence_radius_meters),
    [100, 100]
  );
  assert.equal(pool.state.plans[0].stop_signature,
    "v1|1:6.110000,125.170000|2:6.120000,125.180000");
});

test("uses a schema-safe default label when optional route_name is omitted", async () => {
  const pool = createMockDatabase();
  const payload = validPayload();
  delete payload.route_name;
  const result = await serviceFor(pool).createPlan(payload, { id: 7 });
  assert.equal(result.route_name, "Planned Route");
});

test("rejects an empty stop list before opening a transaction", async () => {
  const pool = createMockDatabase();
  await assert.rejects(
    () => serviceFor(pool).createPlan(validPayload({ stops: [] }), { id: 7 }),
    (error) => assertPlanError(error, "DISPATCH_PLAN_STOPS_REQUIRED", 400)
  );
  assert.equal(pool.transaction.began, 0);
});

test("rejects duplicate stop orders and duplicate destinations", async () => {
  const service = serviceFor(createMockDatabase());
  await assert.rejects(
    () => service.createPlan(validPayload({
      stops: [
        { destination_id: 101, stop_order: 1 },
        { destination_id: 102, stop_order: 1 }
      ]
    }), { id: 7 }),
    (error) => assertPlanError(error, "DISPATCH_PLAN_STOP_ORDER_DUPLICATE", 400)
  );
  await assert.rejects(
    () => service.createPlan(validPayload({
      stops: [
        { destination_id: 101, stop_order: 1 },
        { destination_id: 101, stop_order: 2 }
      ]
    }), { id: 7 }),
    (error) => assertPlanError(error, "DISPATCH_PLAN_DESTINATION_DUPLICATE", 400)
  );
});

test("rejects a missing fleet truck", async () => {
  await assert.rejects(
    () => serviceFor(createMockDatabase()).createPlan(
      validPayload({ fleet_truck_id: 999 }),
      { id: 7 }
    ),
    (error) => assertPlanError(error, "DISPATCH_PLAN_TRUCK_NOT_FOUND", 404)
  );
});

test("rejects maintenance and out-of-service trucks", async () => {
  for (const truckId of [2, 3]) {
    await assert.rejects(
      () => serviceFor(createMockDatabase()).createPlan(
        validPayload({ fleet_truck_id: truckId }),
        { id: 7 }
      ),
      (error) => assertPlanError(error, "DISPATCH_PLAN_TRUCK_UNAVAILABLE", 409)
    );
  }
});

test("rejects missing, inactive, and non-enforcer mobile users", async () => {
  const cases = [
    [999, "DISPATCH_PLAN_ENFORCER_NOT_FOUND", 404],
    [13, "DISPATCH_PLAN_ENFORCER_INACTIVE", 409],
    [14, "DISPATCH_PLAN_ENFORCER_ROLE_INELIGIBLE", 409]
  ];
  for (const [userId, code, status] of cases) {
    await assert.rejects(
      () => serviceFor(createMockDatabase()).createPlan(
        validPayload({ assigned_enforcer_user_id: userId }),
        { id: 7 }
      ),
      (error) => assertPlanError(error, code, status)
    );
  }
});

test("rejects unverified, inactive, or missing destinations", async () => {
  for (const destinationId of [103, 999]) {
    await assert.rejects(
      () => serviceFor(createMockDatabase()).createPlan(
        validPayload({ stops: [{ destination_id: destinationId, stop_order: 1 }] }),
        { id: 7 }
      ),
      (error) => assertPlanError(error, "DISPATCH_PLAN_DESTINATION_NOT_FOUND", 404)
    );
  }
});

test("rejects a past Manila operational date", async () => {
  await assert.rejects(
    () => serviceFor(createMockDatabase()).createPlan(
      validPayload({ operational_date: "2026-08-28" }),
      { id: 7 }
    ),
    (error) => assertPlanError(error, "DISPATCH_PLAN_OPERATIONAL_DATE_PAST", 400)
  );
});

test("rejects a same-day truck conflict", async () => {
  const pool = createMockDatabase({ plans: [planFixture()] });
  await assert.rejects(
    () => serviceFor(pool).createPlan(validPayload({ assigned_enforcer_user_id: 12 }), { id: 7 }),
    (error) => assertPlanError(error, "DISPATCH_PLAN_TRUCK_CONFLICT", 409)
  );
});

test("rejects a same-day enforcer conflict", async () => {
  const pool = createMockDatabase({ plans: [planFixture()] });
  await assert.rejects(
    () => serviceFor(pool).createPlan(validPayload({ fleet_truck_id: 4 }), { id: 7 }),
    (error) => assertPlanError(error, "DISPATCH_PLAN_ENFORCER_CONFLICT", 409)
  );
});

test("maps generated unique-key races to safe truck and enforcer conflicts", () => {
  for (const [constraint, code] of [
    ["uq_dispatch_plans_truck_day", "DISPATCH_PLAN_TRUCK_CONFLICT"],
    ["uq_dispatch_plans_enforcer_day", "DISPATCH_PLAN_ENFORCER_CONFLICT"]
  ]) {
    const source = new Error(`Duplicate entry for key '${constraint}'`);
    source.code = "ER_DUP_ENTRY";
    source.sqlMessage = source.message;
    const normalized = normalizePlanError(source);
    assertPlanError(normalized, code, 409);
    assert.doesNotMatch(normalized.message, /Duplicate entry|uq_dispatch/i);
  }
});

test("rolls back the plan and leaves no orphan after a stop insert failure", async () => {
  const pool = createMockDatabase({}, { failStopOrder: 2 });
  await assert.rejects(
    () => serviceFor(pool).createPlan(validPayload(), { id: 7 }),
    (error) => assertPlanError(error, "DISPATCH_PLAN_DATABASE_ERROR", 500)
  );
  assert.equal(pool.transaction.began, 1);
  assert.equal(pool.transaction.committed, 0);
  assert.equal(pool.transaction.rolledBack, 1);
  assert.equal(pool.transaction.released, 1);
  assert.equal(pool.state.plans.length, 0);
  assert.equal(pool.state.stops.length, 0);
});

test("lists plans by operational date and status using strict-grouping-safe SQL", async () => {
  const pool = createMockDatabase({
    plans: [
      planFixture(),
      planFixture({ id: 2, operational_date: "2026-08-31", status: "cancelled" })
    ],
    stops: [stopFixture()]
  });
  const rows = await serviceFor(pool).listPlans({
    operational_date: "2026-08-30",
    status: "planned"
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stop_count, 1);
  const query = pool.calls.find((call) => call.sql.includes("stop_summary"));
  assert.ok(query);
  assert.match(query.sql, /GROUP BY dispatch_plan_id/);
  assert.doesNotMatch(query.sql, /GROUP BY dp\.id/);
  assert.deepEqual(query.parameters, ["2026-08-30", "planned"]);
});

test("detail returns strictly ordered snapshots without private auth fields", async () => {
  const pool = createMockDatabase({
    plans: [planFixture()],
    stops: [
      stopFixture({ id: 2, stop_order: 2, destination_id: 102 }),
      stopFixture({ id: 1, stop_order: 1, destination_id: 101 })
    ]
  });
  const detail = await serviceFor(pool).getPlan(1);
  assert.deepEqual(detail.stops.map((stop) => stop.stop_order), [1, 2]);
  const serialized = JSON.stringify(detail);
  assert.doesNotMatch(serialized, /password|session_token|csrf|username/i);
});

test("cancelled plans remain historically readable", async () => {
  const pool = createMockDatabase({
    plans: [planFixture({ status: "cancelled", cancellation_reason: "Synthetic reason" })],
    stops: [stopFixture()]
  });
  const detail = await serviceFor(pool).getPlan(1);
  assert.equal(detail.status, "cancelled");
  assert.equal(detail.stops.length, 1);
});

test("updates a planned plan, increments revision, and replaces stops transactionally", async () => {
  const pool = createMockDatabase({
    plans: [planFixture()],
    stops: [stopFixture()]
  });
  const result = await serviceFor(pool).updatePlan(1, {
    route_name: "Updated Manual Route",
    created_by_web_user_id: 999,
    revision: 999,
    stops: [
      { destination_id: 102, stop_order: 5, expected_arrival: "2026-08-30 11:00" }
    ]
  }, { id: 8 });
  assert.equal(result.route_name, "Updated Manual Route");
  assert.equal(result.revision, 2);
  assert.deepEqual(result.stops.map((stop) => stop.stop_order), [5]);
  assert.equal(pool.state.plans[0].updated_by_web_user_id, 8);
  assert.equal(pool.state.plans[0].created_by_web_user_id, 7);
  assert.equal(pool.state.plans[0].planned_route_snapshot, null);
  assert.equal(pool.transaction.committed, 1);
  assert.ok(pool.calls.some((call) => call.sql.startsWith("DELETE FROM dispatch_plan_stops")));
});

test("a failed stop replacement rolls the entire planned update back", async () => {
  const pool = createMockDatabase({
    plans: [planFixture()],
    stops: [stopFixture()]
  }, { failStopOrder: 2 });
  await assert.rejects(
    () => serviceFor(pool).updatePlan(1, {
      route_name: "Must Roll Back",
      stops: [
        { destination_id: 101, stop_order: 1 },
        { destination_id: 102, stop_order: 2 }
      ]
    }, { id: 8 }),
    (error) => assertPlanError(error, "DISPATCH_PLAN_DATABASE_ERROR", 500)
  );
  assert.equal(pool.transaction.committed, 0);
  assert.equal(pool.transaction.rolledBack, 1);
  assert.equal(pool.state.plans[0].route_name, "Synthetic Route");
  assert.equal(pool.state.plans[0].revision, 1);
  assert.deepEqual(pool.state.stops.map((stop) => stop.destination_id), [101]);
});

test("update rechecks truck and enforcer conflicts", async () => {
  const state = {
    plans: [
      planFixture(),
      planFixture({
        id: 2,
        fleet_truck_id: 4,
        truck_code_snapshot: "SYNTH-TRUCK-B",
        assigned_enforcer_user_id: 12,
        assigned_enforcer_name_snapshot: "Synthetic Enforcer Two"
      })
    ],
    stops: [stopFixture()]
  };
  await assert.rejects(
    () => serviceFor(createMockDatabase(state)).updatePlan(1, { fleet_truck_id: 4 }, { id: 8 }),
    (error) => assertPlanError(error, "DISPATCH_PLAN_TRUCK_CONFLICT", 409)
  );
  await assert.rejects(
    () => serviceFor(createMockDatabase(state)).updatePlan(1, {
      assigned_enforcer_user_id: 12
    }, { id: 8 }),
    (error) => assertPlanError(error, "DISPATCH_PLAN_ENFORCER_CONFLICT", 409)
  );
});

test("activated and cancelled plans cannot be updated", async () => {
  for (const status of ["activated", "cancelled"]) {
    const pool = createMockDatabase({ plans: [planFixture({ status })] });
    await assert.rejects(
      () => serviceFor(pool).updatePlan(1, { notes: "must not change" }, { id: 8 }),
      (error) => assertPlanError(error, "DISPATCH_PLAN_IMMUTABLE", 409)
    );
    assert.equal(pool.state.plans[0].notes, null);
  }
});

test("planned cancellation records the session actor, keeps the row, and frees conflicts", async () => {
  const pool = createMockDatabase({
    plans: [planFixture()],
    stops: [stopFixture()],
    nextPlanId: 2,
    nextStopId: 2
  });
  const service = serviceFor(pool);
  const cancelled = await service.cancelPlan(1, {
    cancellation_reason: "Synthetic schedule change",
    cancelled_by_web_user_id: 999
  }, { id: 9 });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(pool.state.plans[0].cancelled_by_web_user_id, 9);
  assert.equal(pool.state.plans.length, 1);
  assert.equal(pool.state.stops.length, 1);

  const replacement = await service.createPlan(validPayload(), { id: 7 });
  assert.equal(replacement.status, "planned");
  assert.equal(pool.state.plans.length, 2);
});

test("cancellation requires a reason and cannot cancel an activated plan", async () => {
  await assert.rejects(
    () => serviceFor(createMockDatabase({ plans: [planFixture()] }))
      .cancelPlan(1, {}, { id: 9 }),
    (error) => assertPlanError(error, "DISPATCH_PLAN_CANCELLATION_REASON_REQUIRED", 400)
  );
  await assert.rejects(
    () => serviceFor(createMockDatabase({ plans: [planFixture({ status: "activated" })] }))
      .cancelPlan(1, { reason: "Synthetic reason" }, { id: 9 }),
    (error) => assertPlanError(error, "DISPATCH_PLAN_IMMUTABLE", 409)
  );
});

test("dated planning options exclude conflicts and reuse the destination catalog API", async () => {
  const pool = createMockDatabase({
    plans: [planFixture()]
  });
  const options = await serviceFor(pool).getPlanningOptions({
    operational_date: "2026-08-30"
  });
  assert.deepEqual(options.fleet_trucks.map((truck) => truck.id), [4]);
  assert.deepEqual(options.enforcers.map((enforcer) => enforcer.id), [12]);
  assert.equal(options.destination_catalog.endpoint, "/api/dispatch/destinations");
  assert.equal(options.destination_catalog.verified_only, true);
});

test("all SQL values are parameterized", async () => {
  const pool = createMockDatabase();
  await serviceFor(pool).createPlan(validPayload(), { id: 7 });
  for (const call of pool.calls) {
    if (!call.transactional && call.sql.includes("DATE_FORMAT")) continue;
    assert.equal((call.sql.match(/\?/g) || []).length, call.parameters.length);
  }
});

test("malformed IDs and absent actors are rejected without database access", async () => {
  const pool = createMockDatabase();
  await assert.rejects(
    () => serviceFor(pool).getPlan("1 OR 1=1"),
    (error) => assertPlanError(error, "DISPATCH_PLAN_ID_INVALID", 400)
  );
  await assert.rejects(
    () => serviceFor(pool).createPlan(validPayload(), { id: 0 }),
    (error) => assertPlanError(error, "WEB_SESSION_REQUIRED", 401)
  );
  assert.equal(pool.calls.length, 0);
});

test("unexpected database errors do not expose SQL detail", async () => {
  const source = new Error("SELECT password, session_token_hash FROM private_table");
  source.code = "PROTOCOL_CONNECTION_LOST";
  const pool = createMockDatabase({}, { connectionError: source });
  await assert.rejects(
    () => serviceFor(pool).createPlan(validPayload(), { id: 7 }),
    (error) => {
      assertPlanError(error, "DISPATCH_PLAN_DATABASE_ERROR", 500);
      assert.doesNotMatch(error.message, /SELECT|password|private_table/i);
      return true;
    }
  );
});

async function runRoleMiddleware(role) {
  const req = { user: role ? { role } : null };
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

test("planning routes require opaque Web auth, exact roles, and CSRF", async () => {
  const routes = read("routes/dispatchPlanRoutes.js");
  const server = read("server/server.js");
  assert.match(routes, /router\.use\(requireWebAuth\)/);
  assert.match(routes, /requireWebRole\("super_admin", "personnel"\)/);
  assert.match(routes, /router\.use\(requireCsrf\)/);
  assert.equal((server.match(/app\.use\("\/api\/dispatch\/plans"/g) || []).length, 1);
  assert.doesNotMatch(routes, /activate|tracking session|dispatch ticket/i);
  for (const role of ["division_admin", "supervisor", "clerk_admin"]) {
    const result = await runRoleMiddleware(role);
    assert.equal(result.nextCalled, false);
    assert.equal(result.res.statusCode, 403);
  }
  for (const role of ["super_admin", "personnel"]) {
    const result = await runRoleMiddleware(role);
    assert.equal(result.nextCalled, true);
  }
});

test("unauthenticated planning access is blocked by Web session middleware", async () => {
  const authError = new Error("Web Admin authentication is required.");
  authError.statusCode = 401;
  authError.code = "WEB_SESSION_REQUIRED";
  const middleware = buildRequireWebAuth({
    validateSession: async () => { throw authError; }
  });
  const req = { headers: {} };
  const res = {
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; }
  };
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "WEB_SESSION_REQUIRED");
});

test("controller mutations pass req.user separately and never trust actor fields", () => {
  const controller = read("controllers/dispatchPlanController.js");
  assert.match(controller, /createPlan\(req\.body \|\| \{\}, req\.user\)/);
  assert.match(controller, /updatePlan\(req\.params\.id, req\.body \|\| \{\}, req\.user\)/);
  assert.match(controller, /cancelPlan\(req\.params\.id, req\.body \|\| \{\}, req\.user\)/);
  assert.doesNotMatch(controller, /created_by_web_user_id|updated_by_web_user_id|cancelled_by_web_user_id/);
});

test("Phase 9H exposes CRUD/cancel/options only and does not change frontend or Android", () => {
  const routes = read("routes/dispatchPlanRoutes.js");
  assert.match(routes, /router\.get\("\/options"/);
  assert.match(routes, /router\.get\("\/"/);
  assert.match(routes, /router\.post\("\/"/);
  assert.match(routes, /router\.get\("\/:id"/);
  assert.match(routes, /router\.patch\("\/:id"/);
  assert.match(routes, /router\.post\("\/:id\/cancel"/);
  assert.doesNotMatch(routes, /activate|assignment/i);
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
  console.log(`Dispatch planning service tests passed (${passed}/${tests.length})`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
