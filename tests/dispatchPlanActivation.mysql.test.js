const assert = require("node:assert/strict");
const mysql = require("mysql2/promise");

const {
  DispatchPlanActivationService
} = require("../services/dispatchPlanActivationService");
const { DispatchService } = require("../services/dispatchService");
const {
  TrackingService
} = require("../services/trackingService");
const { planStopSignature } = require("../services/dispatchPlanService");

const MYSQL_URL = process.env.PHASE9K_MYSQL_URL;
const FIXED_NOW = new Date("2026-08-31T00:00:00.000Z");
const TODAY = "2026-08-31";
const TOMORROW = "2026-09-01";
const PAST = "2026-08-30";
const VALID_GPS = Object.freeze({
  activation_action_id: "44d34355-f864-43c3-852c-f34ce78d22ab",
  latitude: 6.1060875,
  longitude: 125.1816406,
  accuracy: 12,
  recorded_at: "2026-08-31 08:00:00"
});
const TABLES_TO_RESET = [
  "dispatch_events",
  "dispatch_tracking_sessions",
  "truck_last_locations",
  "truck_location_logs",
  "dispatch_route_stops",
  "dispatch_plan_stops",
  "dispatch_plans",
  "dispatch_tickets",
  "dispatch_ticket_sequences",
  "truck_tracking_sessions",
  "fleet_trucks",
  "users",
  "web_users"
];

function mobileUser(id = 101, overrides = {}) {
  return {
    id,
    full_name: `Synthetic Enforcer ${id}`,
    username: `synthetic.enforcer.${id}`,
    role: "personnel",
    mobile_role: "enforcer",
    status: "active",
    ...overrides
  };
}

function defaultStops() {
  return [
    {
      stop_order: 1,
      location_name_snapshot: "Synthetic Stop One",
      address_reference_snapshot: "Synthetic Address One",
      latitude: 6.1062,
      longitude: 125.1817,
      geofence_radius_meters: 100,
      expected_arrival_at: "2026-08-31 09:00:00"
    },
    {
      stop_order: 3,
      location_name_snapshot: "Synthetic Stop Three",
      address_reference_snapshot: null,
      latitude: 6.1072,
      longitude: 125.1827,
      geofence_radius_meters: 125,
      expected_arrival_at: "2026-08-31 10:00:00"
    },
    {
      stop_order: 7,
      location_name_snapshot: "Synthetic Stop Seven",
      address_reference_snapshot: "Synthetic Address Seven",
      latitude: 6.1082,
      longitude: 125.1837,
      geofence_radius_meters: 150,
      expected_arrival_at: "2026-08-31 11:00:00"
    }
  ];
}

async function resetDatabase(pool) {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const table of TABLES_TO_RESET) {
      await connection.query(`TRUNCATE TABLE \`${table}\``);
    }
    await connection.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    connection.release();
  }
}

async function seedWebUser(pool) {
  await pool.query(
    `
      INSERT INTO web_users (id, full_name, username, password, role, status)
      VALUES (1, 'Synthetic Web Planner', 'synthetic.web.planner',
        'synthetic-not-a-real-password', 'super_admin', 'active')
    `
  );
}

async function seedUser(pool, id, overrides = {}) {
  const user = mobileUser(id, overrides);
  await pool.query(
    `
      INSERT INTO users (
        id, full_name, username, password, role, mobile_role, status
      ) VALUES (?, ?, ?, 'synthetic-not-a-real-password', ?, ?, ?)
    `,
    [
      user.id,
      user.full_name,
      user.username,
      user.role,
      user.mobile_role,
      user.status
    ]
  );
  return user;
}

async function seedTruck(pool, code, overrides = {}) {
  const [result] = await pool.query(
    `
      INSERT INTO fleet_trucks (
        truck_code, truck_name, plate_number, fleet_condition, created_by_web_user_id
      ) VALUES (?, ?, ?, ?, 1)
    `,
    [
      code,
      overrides.truck_name || `Synthetic ${code}`,
      overrides.plate_number || null,
      overrides.fleet_condition || "available"
    ]
  );
  return {
    id: result.insertId,
    truck_code: code,
    truck_name: overrides.truck_name || `Synthetic ${code}`
  };
}

async function seedPlan(pool, options = {}) {
  const stops = options.stops === undefined ? defaultStops() : options.stops;
  const storedSignature = options.stop_signature === undefined
    ? planStopSignature(stops)
    : options.stop_signature;
  const [result] = await pool.query(
    `
      INSERT INTO dispatch_plans (
        operational_date,
        fleet_truck_id,
        truck_code_snapshot,
        truck_name_snapshot,
        assigned_enforcer_user_id,
        assigned_enforcer_name_snapshot,
        route_name,
        route_description,
        planned_route_snapshot,
        stop_signature,
        scheduled_start_at,
        expected_return_at,
        status,
        notes,
        revision,
        created_by_web_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'planned', ?, 1, 1)
    `,
    [
      options.operational_date || TODAY,
      options.truck.id,
      options.truck_code_snapshot || options.truck.truck_code,
      options.truck.truck_name,
      options.user.id,
      options.user.full_name,
      options.route_name || "Synthetic Plan Route",
      "Synthetic route description",
      storedSignature,
      options.scheduled_start_at === undefined
        ? `${options.operational_date || TODAY} 08:00:00`
        : options.scheduled_start_at,
      options.expected_return_at === undefined
        ? `${options.operational_date || TODAY} 16:00:00`
        : options.expected_return_at,
      "Synthetic integration fixture"
    ]
  );
  for (const stop of stops) {
    await pool.query(
      `
        INSERT INTO dispatch_plan_stops (
          dispatch_plan_id, stop_order, destination_id,
          location_name_snapshot, address_reference_snapshot,
          latitude, longitude, geofence_radius_meters, expected_arrival_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `,
      [
        result.insertId,
        stop.stop_order,
        stop.location_name_snapshot,
        stop.address_reference_snapshot,
        stop.latitude,
        stop.longitude,
        stop.geofence_radius_meters,
        stop.expected_arrival_at
      ]
    );
  }
  return result.insertId;
}

async function seedFixture(pool, options = {}) {
  await resetDatabase(pool);
  await seedWebUser(pool);
  const user = await seedUser(pool, options.user_id || 101, options.user || {});
  const otherUser = await seedUser(pool, options.other_user_id || 102);
  const truck = await seedTruck(pool, options.truck_code || "SYNTH-TRUCK-A", {
    fleet_condition: options.fleet_condition,
    truck_name: "Synthetic Truck A"
  });
  const otherTruck = await seedTruck(pool, "SYNTH-TRUCK-B", {
    truck_name: "Synthetic Truck B"
  });
  const planId = await seedPlan(pool, {
    truck,
    user,
    operational_date: options.operational_date,
    scheduled_start_at: options.scheduled_start_at,
    stops: options.stops,
    stop_signature: options.stop_signature,
    truck_code_snapshot: options.truck_code_snapshot
  });
  return { user, otherUser, truck, otherTruck, planId };
}

function createService(pool, options = {}) {
  const dispatchService = new DispatchService(pool, { now: () => FIXED_NOW });
  const trackingService = new TrackingService({ dispatchService });
  return new DispatchPlanActivationService(pool, {
    now: () => FIXED_NOW,
    dispatchService,
    trackingService,
    failureInjector: options.failureInjector,
    notifyTrackingStarted: async () => null
  });
}

async function scalar(pool, sql, parameters = []) {
  const [rows] = await pool.query(sql, parameters);
  return Number(Object.values(rows[0])[0]);
}

async function counts(pool) {
  const result = {};
  for (const table of [
    "dispatch_tickets",
    "dispatch_route_stops",
    "dispatch_events",
    "truck_tracking_sessions",
    "truck_last_locations",
    "dispatch_tracking_sessions",
    "truck_location_logs"
  ]) {
    result[table] = await scalar(pool, `SELECT COUNT(*) AS count FROM \`${table}\``);
  }
  return result;
}

async function expectCode(promise, expectedCode) {
  await assert.rejects(
    promise,
    (error) => error.code === expectedCode,
    expectedCode
  );
}

async function testSchemaContracts(pool) {
  const [planIndexes] = await pool.query("SHOW INDEX FROM dispatch_plans");
  const uniqueIndexes = new Set(
    planIndexes
      .filter((row) => Number(row.Non_unique) === 0)
      .map((row) => row.Key_name)
  );
  assert.ok(uniqueIndexes.has("uq_dispatch_plans_activation_action"));
  assert.ok(uniqueIndexes.has("uq_dispatch_plans_tracking_session"));
  assert.ok(uniqueIndexes.has("uq_dispatch_plans_dispatch_ticket"));

  const [columns] = await pool.query("SHOW COLUMNS FROM dispatch_plans");
  const byName = new Map(columns.map((column) => [column.Field, column]));
  assert.match(byName.get("id").Type, /^bigint unsigned$/i);
  assert.equal(byName.get("activation_action_id").Type, "varchar(160)");
  assert.match(byName.get("activated_dispatch_ticket_id").Type, /^int unsigned$/i);
  assert.match(byName.get("activated_tracking_session_id").Type, /^int$/i);
}

async function testHappyPathAndReplay(pool) {
  const fixture = await seedFixture(pool);
  const service = createService(pool);
  const spoofedPayload = {
    ...VALID_GPS,
    truck_id: "ATTACKER-TRUCK",
    fleet_truck_id: 999999,
    enforcer_id: 999999,
    enforcer_name: "Spoofed",
    user_id: 999999,
    stop_order: 999
  };
  const first = await service.activatePlan(
    fixture.planId,
    spoofedPayload,
    fixture.user,
    { deviceId: "synthetic-device-a" }
  );
  assert.equal(first.data.already_activated, false);
  assert.equal(first.data.plan.status, "activated");
  assert.equal(first.data.dispatch_ticket.status, "in_progress");
  assert.equal(first.data.tracking_session.session_status, "active");
  assert.equal(first.data.truck.truck_id, fixture.truck.truck_code);
  assert.deepEqual(first.data.stops.map((stop) => stop.stop_order), [1, 3, 7]);
  assert.deepEqual(
    first.data.stops.map((stop) => stop.stop_status),
    ["on_the_way", "pending", "pending"]
  );

  const [ticketRows] = await pool.query(
    "SELECT * FROM dispatch_tickets WHERE id = ?",
    [first.data.dispatch_ticket.id]
  );
  assert.equal(ticketRows[0].truck_id, fixture.truck.truck_code);
  assert.equal(Number(ticketRows[0].assigned_personnel_id), fixture.user.id);
  assert.equal(ticketRows[0].created_by_user_id, null);

  const [planRows] = await pool.query(
    "SELECT planned_route_snapshot, activated_dispatch_ticket_id, activated_tracking_session_id FROM dispatch_plans WHERE id = ?",
    [fixture.planId]
  );
  assert.equal(planRows[0].planned_route_snapshot, null);
  assert.equal(
    Number(planRows[0].activated_dispatch_ticket_id),
    first.data.dispatch_ticket.id
  );
  assert.equal(
    Number(planRows[0].activated_tracking_session_id),
    first.data.tracking_session.id
  );

  const [lastLocations] = await pool.query(
    "SELECT * FROM truck_last_locations WHERE truck_id = ?",
    [fixture.truck.truck_code]
  );
  assert.equal(lastLocations.length, 1);
  assert.equal(Number(lastLocations[0].session_id), first.data.tracking_session.id);
  assert.equal(
    String(lastLocations[0].last_updated_at).includes("2026"),
    true
  );
  assert.equal(await scalar(pool, "SELECT COUNT(*) FROM truck_location_logs"), 0);
  assert.equal(await scalar(pool, "SELECT COUNT(*) FROM dispatch_events"), 3);

  const beforeReplay = await counts(pool);
  const replay = await service.activatePlan(
    fixture.planId,
    VALID_GPS,
    fixture.user,
    { deviceId: "different-device-is-ignored-on-replay" }
  );
  assert.equal(replay.data.already_activated, true);
  assert.equal(replay.data.dispatch_ticket.id, first.data.dispatch_ticket.id);
  assert.equal(replay.data.tracking_session.id, first.data.tracking_session.id);
  assert.deepEqual(await counts(pool), beforeReplay);

  await expectCode(
    service.activatePlan(
      fixture.planId,
      { ...VALID_GPS, activation_action_id: "different-action-0000000000000001" },
      fixture.user,
      {}
    ),
    "DISPATCH_PLAN_ALREADY_ACTIVATED"
  );
  assert.deepEqual(await counts(pool), beforeReplay);
}

async function testAssignments(pool) {
  const fixture = await seedFixture(pool);
  await seedPlan(pool, {
    truck: fixture.otherTruck,
    user: fixture.user,
    operational_date: TOMORROW,
    stops: defaultStops().map((stop) => ({
      ...stop,
      expected_arrival_at: stop.expected_arrival_at.replace(TODAY, TOMORROW)
    }))
  });
  const service = createService(pool);
  const result = await service.listAssignments({
    ...fixture.user,
    user_id: fixture.otherUser.id
  });
  assert.equal(result.server_date, TODAY);
  assert.equal(result.today_assignment.id, fixture.planId);
  assert.equal(result.today_assignment.can_activate, true);
  assert.equal(result.tomorrow_assignment.operational_date, TOMORROW);
  assert.equal(result.tomorrow_assignment.can_activate, false);
  assert.deepEqual(
    result.today_assignment.stops.map((stop) => stop.stop_order),
    [1, 3, 7]
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("password"), false);
  assert.equal(serialized.includes("created_by_web_user_id"), false);
}

async function testAuthorizationAndDates(pool) {
  let fixture = await seedFixture(pool);
  let service = createService(pool);
  await expectCode(
    service.activatePlan(fixture.planId, VALID_GPS, fixture.otherUser, {}),
    "DISPATCH_PLAN_NOT_ASSIGNED_TO_USER"
  );
  await expectCode(
    service.activatePlan(
      fixture.planId,
      VALID_GPS,
      { ...fixture.user, mobile_role: "citizen" },
      {}
    ),
    "DISPATCH_PLAN_ENFORCER_REQUIRED"
  );

  for (const date of [TOMORROW, PAST]) {
    fixture = await seedFixture(pool, { operational_date: date });
    service = createService(pool);
    await expectCode(
      service.activatePlan(fixture.planId, VALID_GPS, fixture.user, {}),
      "DISPATCH_PLAN_OPERATIONAL_DATE_NOT_TODAY"
    );
  }
}

async function testTruckAndUserEligibility(pool) {
  for (const fleetCondition of ["for_maintenance", "out_of_service"]) {
    const fixture = await seedFixture(pool, { fleet_condition: fleetCondition });
    await expectCode(
      createService(pool).activatePlan(fixture.planId, VALID_GPS, fixture.user, {}),
      "DISPATCH_PLAN_TRUCK_UNAVAILABLE"
    );
  }

  let fixture = await seedFixture(pool, {
    truck_code_snapshot: "SYNTH-STALE-SNAPSHOT"
  });
  await expectCode(
    createService(pool).activatePlan(fixture.planId, VALID_GPS, fixture.user, {}),
    "DISPATCH_PLAN_TRUCK_SNAPSHOT_MISMATCH"
  );

  for (const userOverride of [
    { status: "inactive" },
    { mobile_role: "citizen" }
  ]) {
    fixture = await seedFixture(pool, { user: userOverride });
    const requestUser = { ...fixture.user, status: "active", mobile_role: "enforcer" };
    await expectCode(
      createService(pool).activatePlan(fixture.planId, VALID_GPS, requestUser, {}),
      userOverride.status === "inactive"
        ? "MOBILE_SESSION_ACCOUNT_INACTIVE"
        : "DISPATCH_PLAN_ENFORCER_REQUIRED"
    );
  }
}

async function insertActiveSession(pool, data) {
  await pool.query(
    `
      INSERT INTO truck_tracking_sessions (
        truck_id, enforcer_id, enforcer_name, device_id, session_status,
        started_at, shift_end_time, created_at, updated_at
      ) VALUES (?, ?, 'Synthetic Conflict', 'synthetic-device', 'active',
        '2026-08-31 07:00:00', '2026-08-31 16:00:00',
        '2026-08-31 07:00:00', '2026-08-31 07:00:00')
    `,
    [data.truck_id, data.enforcer_id]
  );
}

async function insertNonterminalTicket(pool, data) {
  await pool.query(
    `
      INSERT INTO dispatch_tickets (
        ticket_number, truck_id, truck_name_snapshot,
        assigned_personnel_id, assigned_personnel_name,
        dispatch_date, scheduled_start_at, route_name, status,
        created_by_user_id, created_by_name
      ) VALUES (?, ?, 'Synthetic Conflict Truck', ?, 'Synthetic Conflict',
        ?, '2026-08-31 07:00:00', 'Synthetic Conflict Route', 'prepared',
        NULL, 'Synthetic Test')
    `,
    [data.ticket_number, data.truck_id, data.enforcer_id, TODAY]
  );
}

async function testOperationalConflicts(pool) {
  let fixture = await seedFixture(pool);
  await insertActiveSession(pool, {
    truck_id: fixture.truck.truck_code,
    enforcer_id: fixture.otherUser.id
  });
  await expectCode(
    createService(pool).activatePlan(fixture.planId, VALID_GPS, fixture.user, {}),
    "DISPATCH_TRUCK_ALREADY_TRACKING"
  );

  fixture = await seedFixture(pool);
  await insertActiveSession(pool, {
    truck_id: "SYNTH-UNRELATED-TRUCK",
    enforcer_id: fixture.user.id
  });
  await expectCode(
    createService(pool).activatePlan(fixture.planId, VALID_GPS, fixture.user, {}),
    "DISPATCH_PLAN_ENFORCER_OPERATION_CONFLICT"
  );

  fixture = await seedFixture(pool);
  await insertNonterminalTicket(pool, {
    ticket_number: "DPT-2026-9001",
    truck_id: fixture.truck.truck_code,
    enforcer_id: fixture.otherUser.id
  });
  await expectCode(
    createService(pool).activatePlan(fixture.planId, VALID_GPS, fixture.user, {}),
    "DISPATCH_TRUCK_ALREADY_ASSIGNED"
  );

  fixture = await seedFixture(pool);
  await insertNonterminalTicket(pool, {
    ticket_number: "DPT-2026-9002",
    truck_id: "SYNTH-UNRELATED-TRUCK",
    enforcer_id: fixture.user.id
  });
  await expectCode(
    createService(pool).activatePlan(fixture.planId, VALID_GPS, fixture.user, {}),
    "DISPATCH_PLAN_ENFORCER_OPERATION_CONFLICT"
  );
}

async function testStopsAndSchedule(pool) {
  let fixture = await seedFixture(pool, { stops: [] });
  await expectCode(
    createService(pool).activatePlan(fixture.planId, VALID_GPS, fixture.user, {}),
    "DISPATCH_PLAN_STOPS_REQUIRED"
  );

  fixture = await seedFixture(pool, { stop_signature: "v1|tampered" });
  await expectCode(
    createService(pool).activatePlan(fixture.planId, VALID_GPS, fixture.user, {}),
    "DISPATCH_PLAN_STOP_SIGNATURE_MISMATCH"
  );

  fixture = await seedFixture(pool, { scheduled_start_at: null });
  await expectCode(
    createService(pool).activatePlan(fixture.planId, VALID_GPS, fixture.user, {}),
    "DISPATCH_PLAN_SCHEDULE_REQUIRED"
  );
}

async function testGpsGate(pool) {
  const cases = [
    [{ latitude: 0, longitude: 0 }, "TRACKING_START_GPS_INVALID"],
    [{ latitude: 91 }, "TRACKING_START_GPS_INVALID"],
    [{ recorded_at: "2026-08-31 07:54:59" }, "TRACKING_START_GPS_STALE"],
    [{ recorded_at: "2026-08-31 08:01:01" }, "TRACKING_START_GPS_FUTURE"],
    [{ accuracy: 50.01 }, "TRACKING_START_GPS_INACCURATE"],
    [{ latitude: 6.12, longitude: 125.19 }, "TRACKING_START_OUTSIDE_WMO"]
  ];
  for (const [override, code] of cases) {
    const fixture = await seedFixture(pool);
    await expectCode(
      createService(pool).activatePlan(
        fixture.planId,
        { ...VALID_GPS, ...override },
        fixture.user,
        {}
      ),
      code
    );
    assert.deepEqual(await counts(pool), {
      dispatch_tickets: 0,
      dispatch_route_stops: 0,
      dispatch_events: 0,
      truck_tracking_sessions: 0,
      truck_last_locations: 0,
      dispatch_tracking_sessions: 0,
      truck_location_logs: 0
    });
  }
}

async function testCrossPlanActionCollision(pool) {
  const fixture = await seedFixture(pool);
  const service = createService(pool);
  await service.activatePlan(fixture.planId, VALID_GPS, fixture.user, {});
  const secondPlanId = await seedPlan(pool, {
    truck: fixture.otherTruck,
    user: fixture.otherUser,
    operational_date: TODAY
  });
  await expectCode(
    service.activatePlan(secondPlanId, VALID_GPS, fixture.otherUser, {}),
    "DISPATCH_PLAN_ACTIVATION_ACTION_CONFLICT"
  );
  assert.equal(await scalar(pool, "SELECT COUNT(*) FROM dispatch_tickets"), 1);
  assert.equal(await scalar(pool, "SELECT COUNT(*) FROM truck_tracking_sessions"), 1);
}

async function testConcurrentSameAction(pool) {
  const fixture = await seedFixture(pool);
  const firstService = createService(pool);
  const secondService = createService(pool);
  const results = await Promise.all([
    firstService.activatePlan(fixture.planId, VALID_GPS, fixture.user, {}),
    secondService.activatePlan(fixture.planId, VALID_GPS, fixture.user, {})
  ]);
  assert.deepEqual(
    results.map((result) => result.data.already_activated).sort(),
    [false, true]
  );
  assert.equal(results[0].data.dispatch_ticket.id, results[1].data.dispatch_ticket.id);
  assert.equal(results[0].data.tracking_session.id, results[1].data.tracking_session.id);
  assert.equal(await scalar(pool, "SELECT COUNT(*) FROM dispatch_tickets"), 1);
  assert.equal(await scalar(pool, "SELECT COUNT(*) FROM truck_tracking_sessions"), 1);
  assert.equal(await scalar(pool, "SELECT COUNT(*) FROM dispatch_events"), 3);
}

async function testRollbackCheckpoints(pool) {
  const checkpoints = [
    "ticket_creation",
    "stop_copy",
    "event_creation",
    "tracking_session_creation",
    "last_location_insertion",
    "ticket_session_linkage",
    "ticket_in_progress",
    "plan_activation_update"
  ];
  for (const checkpoint of checkpoints) {
    const fixture = await seedFixture(pool);
    const service = createService(pool, {
      failureInjector: async (name) => {
        if (name === checkpoint) {
          const error = new Error(`Synthetic rollback at ${checkpoint}`);
          error.code = "SYNTHETIC_ROLLBACK";
          throw error;
        }
      }
    });
    await expectCode(
      service.activatePlan(fixture.planId, VALID_GPS, fixture.user, {}),
      "DISPATCH_PLAN_ACTIVATION_UNAVAILABLE"
    );
    const [plans] = await pool.query(
      `
        SELECT status, activation_action_id,
          activated_dispatch_ticket_id, activated_tracking_session_id
        FROM dispatch_plans WHERE id = ?
      `,
      [fixture.planId]
    );
    assert.equal(plans[0].status, "planned", checkpoint);
    assert.equal(plans[0].activation_action_id, null, checkpoint);
    assert.equal(plans[0].activated_dispatch_ticket_id, null, checkpoint);
    assert.equal(plans[0].activated_tracking_session_id, null, checkpoint);
    assert.deepEqual(await counts(pool), {
      dispatch_tickets: 0,
      dispatch_route_stops: 0,
      dispatch_events: 0,
      truck_tracking_sessions: 0,
      truck_last_locations: 0,
      dispatch_tracking_sessions: 0,
      truck_location_logs: 0
    }, checkpoint);
  }
}

async function run() {
  if (!MYSQL_URL) {
    console.log("Dispatch plan activation MySQL tests skipped (PHASE9K_MYSQL_URL not set)");
    return;
  }
  const pool = mysql.createPool({
    uri: MYSQL_URL,
    connectionLimit: 8,
    dateStrings: true,
    decimalNumbers: false
  });
  const tests = [
    ["exact schema contracts", testSchemaContracts],
    ["assignment reads", testAssignments],
    ["happy path, exact stops, and response-loss replay", testHappyPathAndReplay],
    ["authorization and operational dates", testAuthorizationAndDates],
    ["truck and current-user eligibility", testTruckAndUserEligibility],
    ["operational conflicts", testOperationalConflicts],
    ["stops, signature, and schedule", testStopsAndSchedule],
    ["GPS gate", testGpsGate],
    ["cross-plan action collision", testCrossPlanActionCollision],
    ["concurrent same action", testConcurrentSameAction],
    ["all rollback checkpoints", testRollbackCheckpoints]
  ];
  let passed = 0;
  try {
    for (const [name, callback] of tests) {
      try {
        await callback(pool);
        passed += 1;
      } catch (error) {
        error.message = `${name}: ${error.message}`;
        throw error;
      }
    }
    console.log(
      `Dispatch plan activation disposable MySQL tests passed (${passed}/${tests.length})`
    );
  } finally {
    await resetDatabase(pool);
    await pool.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
