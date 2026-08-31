const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");
const {
  DispatchPlanActivationService,
  MobileDispatchPlanError,
  assignmentActivationState,
  isEligibleEnforcer,
  manilaDateTime,
  nextCalendarDate,
  validateActivationActionId
} = require("../services/dispatchPlanActivationService");

const tests = [];
const test = (name, callback) => tests.push({ name, callback });
const read = (relativePath) => fs.readFileSync(
  path.join(projectRoot, relativePath),
  "utf8"
);

class AssignmentPool {
  constructor(planRows, stopRows) {
    this.planRows = planRows;
    this.stopRows = stopRows;
    this.queries = [];
  }

  async query(sql, parameters = []) {
    this.queries.push({ sql, parameters });
    if (/FROM dispatch_plan_stops\s+WHERE dispatch_plan_id IN/i.test(sql)) {
      return [this.stopRows];
    }
    return [this.planRows];
  }
}

function eligibleUser(overrides = {}) {
  return {
    id: 77,
    full_name: "Synthetic Enforcer",
    username: "synthetic.enforcer",
    role: "personnel",
    mobile_role: "enforcer",
    status: "active",
    ...overrides
  };
}

function planRow(overrides = {}) {
  return {
    id: 501,
    operational_date: "2026-08-31",
    status: "planned",
    fleet_truck_id: 44,
    truck_code_snapshot: "SYNTH-TRUCK-44",
    truck_name_snapshot: "Synthetic Truck 44",
    route_name: "Synthetic Route",
    route_description: "Synthetic only",
    scheduled_start_at: "2026-08-31 08:00:00",
    expected_return_at: "2026-08-31 16:00:00",
    activated_dispatch_ticket_id: null,
    activated_tracking_session_id: null,
    truck_code: "SYNTH-TRUCK-44",
    fleet_condition: "available",
    stop_count: 2,
    has_active_truck_session: 0,
    has_active_enforcer_session: 0,
    has_truck_ticket_conflict: 0,
    has_enforcer_ticket_conflict: 0,
    ...overrides
  };
}

function stopRow(planId, order, name) {
  return {
    dispatch_plan_id: planId,
    stop_order: order,
    location_name_snapshot: name,
    address_reference_snapshot: null,
    latitude: "6.1061000",
    longitude: "125.1816000",
    geofence_radius_meters: 100,
    expected_arrival: null
  };
}

test("activation action id is required and constrained to safe opaque syntax", () => {
  assert.throws(
    () => validateActivationActionId(""),
    (error) => error.code === "DISPATCH_PLAN_ACTIVATION_ACTION_REQUIRED"
  );
  assert.throws(
    () => validateActivationActionId("short"),
    (error) => error.code === "DISPATCH_PLAN_ACTIVATION_ACTION_INVALID"
  );
  assert.throws(
    () => validateActivationActionId(`x${"a".repeat(160)}`),
    (error) => error.code === "DISPATCH_PLAN_ACTIVATION_ACTION_INVALID"
  );
  assert.equal(
    validateActivationActionId("44d34355-f864-43c3-852c-f34ce78d22ab"),
    "44d34355-f864-43c3-852c-f34ce78d22ab"
  );
});

test("only a current active enforcer account is eligible", () => {
  assert.equal(isEligibleEnforcer(eligibleUser()), true);
  assert.equal(isEligibleEnforcer(eligibleUser({ status: "inactive" })), false);
  assert.equal(isEligibleEnforcer(eligibleUser({ mobile_role: "citizen" })), false);
});

test("server date/time helpers use Asia/Manila including the UTC boundary", () => {
  assert.equal(
    manilaDateTime(new Date("2026-08-31T16:05:06.000Z")),
    "2026-09-01 00:05:06"
  );
  assert.equal(nextCalendarDate("2026-12-31"), "2027-01-01");
});

test("assignment response separates today and tomorrow with exact stored order", async () => {
  const today = planRow();
  const tomorrow = planRow({
    id: 502,
    operational_date: "2026-09-01",
    scheduled_start_at: "2026-09-01 08:00:00",
    expected_return_at: "2026-09-01 16:00:00"
  });
  const pool = new AssignmentPool(
    [today, tomorrow],
    [
      stopRow(501, 1, "First"),
      stopRow(501, 7, "Seventh"),
      stopRow(502, 3, "Tomorrow Third")
    ]
  );
  const service = new DispatchPlanActivationService(pool, {
    now: () => new Date("2026-08-31T00:00:00.000Z")
  });
  const result = await service.listAssignments(eligibleUser());

  assert.equal(result.server_date, "2026-08-31");
  assert.equal(result.time_zone, "Asia/Manila");
  assert.equal(result.today_assignment.id, 501);
  assert.equal(result.today_assignment.can_activate, true);
  assert.deepEqual(
    result.today_assignment.stops.map((stop) => stop.stop_order),
    [1, 7]
  );
  assert.equal(result.tomorrow_assignment.id, 502);
  assert.equal(result.tomorrow_assignment.can_activate, false);
  assert.equal(
    result.tomorrow_assignment.activation_reason_code,
    "DISPATCH_PLAN_OPERATIONAL_DATE_NOT_TODAY"
  );
});

test("assignment lookup uses authenticated identity and ignores arbitrary authority", async () => {
  const pool = new AssignmentPool([], []);
  const service = new DispatchPlanActivationService(pool, {
    now: () => new Date("2026-08-31T00:00:00.000Z")
  });
  await service.listAssignments(eligibleUser({ user_id: 999, enforcer_id: 999 }));
  assert.deepEqual(pool.queries[0].parameters.slice(-3), [
    77,
    "2026-08-31",
    "2026-09-01"
  ]);
});

test("unrelated user plans are excluded by the SQL assignment predicate", () => {
  const source = read("services/dispatchPlanActivationService.js");
  assert.match(source, /dp\.assigned_enforcer_user_id = \?/);
  assert.doesNotMatch(source, /filters\.user_id|payload\.user_id/);
});

test("activated today remains visible with linked IDs and is read-only", async () => {
  const pool = new AssignmentPool([
    planRow({
      status: "activated",
      activated_dispatch_ticket_id: 901,
      activated_tracking_session_id: 902
    })
  ], [stopRow(501, 1, "First")]);
  const service = new DispatchPlanActivationService(pool, {
    now: () => new Date("2026-08-31T00:00:00.000Z")
  });
  const result = await service.listAssignments(eligibleUser());
  assert.equal(result.today_assignment.id, 501);
  assert.equal(result.today_assignment.can_activate, false);
  assert.equal(result.today_assignment.linked_dispatch_ticket_id, 901);
  assert.equal(result.today_assignment.linked_tracking_session_id, 902);
  assert.equal(
    result.today_assignment.activation_reason_code,
    "DISPATCH_PLAN_ALREADY_ACTIVATED"
  );
});

test("cancelled assignment remains safe and read-only", () => {
  assert.deepEqual(
    assignmentActivationState(planRow({ status: "cancelled" }), "2026-08-31"),
    {
      can_activate: false,
      activation_reason_code: "DISPATCH_PLAN_IMMUTABLE"
    }
  );
});

test("assignment output does not expose auth or Web audit fields", async () => {
  const pool = new AssignmentPool([planRow()], [stopRow(501, 1, "First")]);
  const service = new DispatchPlanActivationService(pool, {
    now: () => new Date("2026-08-31T00:00:00.000Z")
  });
  const serialized = JSON.stringify(await service.listAssignments(eligibleUser()));
  for (const forbidden of [
    "password",
    "session_token",
    "hash",
    "created_by_web_user_id",
    "updated_by_web_user_id",
    "cancelled_by_web_user_id"
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("truck and operational conflicts make a planned today assignment read-only", () => {
  assert.equal(
    assignmentActivationState(
      planRow({ fleet_condition: "for_maintenance" }),
      "2026-08-31"
    ).activation_reason_code,
    "DISPATCH_PLAN_TRUCK_UNAVAILABLE"
  );
  assert.equal(
    assignmentActivationState(
      planRow({ has_active_enforcer_session: 1 }),
      "2026-08-31"
    ).activation_reason_code,
    "DISPATCH_PLAN_ENFORCER_OPERATION_CONFLICT"
  );
});

test("mobile router is bearer protected without Web auth or CSRF", () => {
  const routes = read("routes/mobileDispatchPlanRoutes.js");
  assert.match(routes, /router\.use\(requireMobileSession\)/);
  assert.match(routes, /router\.get\("\/assignments"/);
  assert.match(routes, /router\.post\("\/:planId\/activate"/);
  assert.doesNotMatch(routes, /requireWebAuth|requireWebRole|requireCsrf/);
});

test("mobile router is mounted before the generic Web planning router", () => {
  const server = read("server/server.js");
  assert.ok(
    server.indexOf('app.use("/api/dispatch/plans/mobile"') <
      server.indexOf('app.use("/api/dispatch/plans", dispatchPlanRoutes)')
  );
});

test("activation uses one connection-scoped transaction and no OSRM", () => {
  const source = read("services/dispatchPlanActivationService.js");
  assert.match(source, /this\.db\.getConnection\(\)/);
  assert.match(source, /connection\.beginTransaction\(\)/);
  assert.match(source, /connection\.commit\(\)/);
  assert.match(source, /connection\.rollback\(\)/);
  assert.match(source, /insertPreparedTicketInTransaction/);
  assert.match(source, /createTrackingSessionWithConnection/);
  assert.match(source, /upsertLastLocationWithConnection/);
  assert.doesNotMatch(source, /osrm|fetch\(|axios/i);
});

test("activation reuses the existing tracking-start GPS gate at receipt time", () => {
  const source = read("services/dispatchPlanActivationService.js");
  assert.match(
    source,
    /validateNewTrackingStartLocation\(\s*payload,\s*receivedAt\.getTime\(\)/
  );
});

test("activation copies plan snapshots and never trusts body truck or user IDs", () => {
  const source = read("services/dispatchPlanActivationService.js");
  assert.match(source, /truck_id: plan\.truck_code_snapshot/);
  assert.match(source, /assigned_personnel_id: userId/);
  assert.match(source, /created_by_user_id: null/);
  assert.doesNotMatch(source, /payload\.(?:truck_id|fleet_truck_id|enforcer_id|user_id)/);
});

test("known validation errors remain safe operational errors", () => {
  const error = new MobileDispatchPlanError("safe", 409, "SAFE_CODE");
  assert.equal(error.message, "safe");
  assert.equal(error.statusCode, 409);
  assert.equal(error.code, "SAFE_CODE");
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
  console.log(`Dispatch plan activation tests passed (${passed}/${tests.length})`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
