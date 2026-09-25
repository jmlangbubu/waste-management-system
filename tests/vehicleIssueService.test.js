const assert = require("node:assert/strict");
const Module = require("node:module");

const originalModuleLoad = Module._load;
Module._load = function loadWithVehicleIssueMocks(request, parent, isMain) {
  const parentPath = parent?.filename.replace(/\\/g, "/") || "";
  if (
    request === "../config/dbPromise" &&
    parentPath.endsWith("services/vehicleIssueService.js")
  ) {
    return {};
  }
  if (
    request === "../middleware/vehicleIssueUpload" &&
    parentPath.endsWith("services/vehicleIssueService.js")
  ) {
    return {
      VehicleIssueUploadError: class VehicleIssueUploadError extends Error {},
      storeVehicleIssueImage: async () => null,
      deleteStoredVehicleIssueImage: async () => undefined
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
const {
  VehicleIssueService,
  VehicleIssueError,
  normalizeLocation
} = require("../services/vehicleIssueService");
Module._load = originalModuleLoad;

const tests = [];
const test = (name, callback) => tests.push({ name, callback });

function eligibleUser(overrides = {}) {
  return {
    id: 13,
    full_name: "John Paul",
    role: "enforcer",
    mobile_role: "enforcer",
    status: "active",
    ...overrides
  };
}

function safeAnswers(overrides = {}) {
  return {
    brakes_safe: true,
    steering_normal: true,
    smoke_fire_steam_present: false,
    serious_overheating: false,
    unsafe_tire: false,
    severe_power_loss: false,
    movement_safety: "safe",
    warning_indicator_persistent: false,
    noise_vibration_recurring: false,
    degraded_but_controllable: false,
    lights_affect_safe_visibility: false,
    ...overrides
  };
}

function payload(overrides = {}) {
  return {
    client_request_id: "vehicle-issue-request-0001",
    issue_category: "other",
    description: "Mirror bracket is loose but the truck remains controllable.",
    assistant_answers: safeAnswers(),
    ...overrides
  };
}

function assignment(overrides = {}) {
  return {
    dispatch_plan_id: 501,
    fleet_truck_id: 44,
    truck_code: "TRUCK-44",
    truck_name: "Collection Truck 44",
    dispatch_ticket_id: 601,
    dispatch_ticket_status: "in_progress",
    tracking_session_id: 701,
    tracking_session_status: "active",
    ...overrides
  };
}

class MemoryDb {
  constructor(options = {}) {
    this.assignment = options.assignment === undefined ? assignment() : options.assignment;
    this.report = options.report || null;
    this.truck = options.truck || {
      id: 44,
      fleet_condition: "available",
      condition_reason: null
    };
    this.calls = [];
    this.nextId = 900;
    this.connection = new MemoryConnection(this);
  }

  async query(sql, parameters = []) {
    this.calls.push({ scope: "pool", sql, parameters });
    if (sql.includes("FROM dispatch_plans dp")) {
      return [this.assignment ? [this.assignment] : []];
    }
    if (sql.includes("FROM vehicle_issue_reports") && sql.includes("client_request_id")) {
      return [
        this.report && this.report.client_request_id === parameters[0]
          ? [this.report]
          : []
      ];
    }
    if (sql.includes("FROM vehicle_issue_reports vir")) {
      return [this.report ? [{ ...this.report, current_fleet_condition: this.truck.fleet_condition }] : []];
    }
    if (sql.includes("INSERT INTO notifications")) {
      return [{ insertId: 77 }];
    }
    throw new Error(`Unexpected pool SQL: ${sql}`);
  }

  async getConnection() {
    return this.connection;
  }
}

class MemoryConnection {
  constructor(owner) {
    this.owner = owner;
    this.commits = 0;
    this.rollbacks = 0;
  }

  async beginTransaction() {}
  async commit() { this.commits += 1; }
  async rollback() { this.rollbacks += 1; }
  release() {}

  async query(sql, parameters = []) {
    this.owner.calls.push({ scope: "connection", sql, parameters });
    if (sql.includes("FROM dispatch_plans dp")) {
      return [this.owner.assignment ? [this.owner.assignment] : []];
    }
    if (sql.includes("FROM vehicle_issue_reports") && sql.includes("client_request_id")) {
      return [
        this.owner.report && this.owner.report.client_request_id === parameters[0]
          ? [this.owner.report]
          : []
      ];
    }
    if (sql.includes("INSERT INTO vehicle_issue_reports")) {
      const id = this.owner.nextId++;
      this.owner.report = {
        id,
        client_request_id: parameters[0],
        fleet_truck_id: parameters[1],
        truck_code_snapshot: parameters[2],
        truck_name_snapshot: parameters[3],
        reported_by_user_id: parameters[4],
        reported_by_name_snapshot: parameters[5],
        dispatch_plan_id: parameters[6],
        dispatch_ticket_id: parameters[7],
        tracking_session_id: parameters[8],
        issue_category: parameters[9],
        description: parameters[10],
        assistant_answers: parameters[11],
        assistant_ruleset_version: parameters[12],
        severity: parameters[13],
        possible_concern: parameters[14],
        recommended_action: parameters[15],
        latitude: parameters[16],
        longitude: parameters[17],
        accuracy_meters: parameters[18],
        location_recorded_at: parameters[19],
        image_url: parameters[20],
        report_status: "submitted",
        reviewed_by_web_user_id: null,
        reviewed_at: null,
        resolution_action: null,
        resolution_notes: null,
        resolved_by_web_user_id: null,
        resolved_at: null
      };
      return [{ insertId: id }];
    }
    if (sql.includes("SELECT * FROM vehicle_issue_reports WHERE id")) {
      return [this.owner.report ? [this.owner.report] : []];
    }
    if (sql.includes("SELECT id, fleet_condition, condition_reason FROM fleet_trucks")) {
      return [this.owner.truck ? [this.owner.truck] : []];
    }
    if (sql.includes("UPDATE fleet_trucks")) {
      this.owner.truck.fleet_condition = parameters[0];
      this.owner.truck.condition_reason = parameters[1];
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SET report_status = 'under_review'")) {
      this.owner.report.report_status = "under_review";
      this.owner.report.reviewed_by_web_user_id = parameters[0];
      this.owner.report.reviewed_at = "2026-09-25 08:00:00.000";
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SET report_status = 'resolved'")) {
      this.owner.report.report_status = "resolved";
      this.owner.report.reviewed_by_web_user_id ||= parameters[0];
      this.owner.report.reviewed_at ||= "2026-09-25 08:00:00.000";
      this.owner.report.resolution_action = parameters[1];
      this.owner.report.resolution_notes = parameters[2];
      this.owner.report.resolved_by_web_user_id = parameters[3];
      this.owner.report.resolved_at = "2026-09-25 08:10:00.000";
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected connection SQL: ${sql}`);
  }
}

function reportFixture(overrides = {}) {
  return {
    id: 900,
    client_request_id: "vehicle-issue-request-0001",
    fleet_truck_id: 44,
    truck_code_snapshot: "TRUCK-44",
    truck_name_snapshot: "Collection Truck 44",
    reported_by_user_id: 13,
    reported_by_name_snapshot: "John Paul",
    dispatch_plan_id: 501,
    dispatch_ticket_id: 601,
    tracking_session_id: 701,
    issue_category: "other",
    description: "Mirror bracket is loose but the truck remains controllable.",
    assistant_answers: JSON.stringify(safeAnswers()),
    assistant_ruleset_version: "vehicle-issue-triage-v1",
    severity: "low",
    possible_concern: "Potential vehicle condition requiring WMO review.",
    recommended_action: "Routine inspection.",
    latitude: null,
    longitude: null,
    accuracy_meters: null,
    location_recorded_at: null,
    image_url: null,
    report_status: "submitted",
    reviewed_by_web_user_id: null,
    reviewed_at: null,
    resolution_action: null,
    resolution_notes: null,
    resolved_by_web_user_id: null,
    resolved_at: null,
    ...overrides
  };
}

test("valid report stores authoritative assignment and server triage", async () => {
  const db = new MemoryDb();
  const service = new VehicleIssueService({ db });
  const result = await service.createReport({
    ...payload(),
    severity: "critical",
    reported_by_user_id: 999,
    fleet_truck_id: 999,
    dispatch_plan_id: 999,
    dispatch_ticket_id: 999,
    tracking_session_id: 999
  }, eligibleUser());
  assert.equal(result.idempotent, false);
  assert.equal(result.report.reported_by_user_id, 13);
  assert.equal(result.report.fleet_truck_id, 44);
  assert.equal(result.report.dispatch_plan_id, 501);
  assert.equal(result.report.dispatch_ticket_id, 601);
  assert.equal(result.report.tracking_session_id, 701);
  assert.equal(result.report.severity, "low");
  assert.equal(db.connection.commits, 1);
});

test("optional image URL is stored through the injected durable-storage boundary", async () => {
  const db = new MemoryDb();
  let storedFile = null;
  const service = new VehicleIssueService({
    db,
    storeImage: async (file) => {
      storedFile = file;
      return {
        url: "https://images.example.test/vehicle-issues/safe-random-id.webp",
        storage: "cloudinary",
        publicId: "vehicle-issues/safe-random-id"
      };
    }
  });
  const file = { mimetype: "image/webp", size: 100, buffer: Buffer.alloc(100) };
  const result = await service.createReport(payload(), eligibleUser(), file);
  assert.equal(storedFile, file);
  assert.equal(
    result.report.image_url,
    "https://images.example.test/vehicle-issues/safe-random-id.webp"
  );
});

test("generic WMO notification omits precise GPS evidence", async () => {
  const db = new MemoryDb();
  const service = new VehicleIssueService({ db });
  await service.createReport(payload({
    client_request_id: "vehicle-issue-request-gps-0001",
    latitude: 6.1060875,
    longitude: 125.1816406,
    accuracy_meters: 12,
    location_recorded_at: "2026-09-25T01:00:00.000Z"
  }), eligibleUser());
  const notificationCall = db.calls.find((call) =>
    call.sql.includes("INSERT INTO notifications")
  );
  assert.ok(notificationCall);
  const message = notificationCall.parameters[2];
  assert.doesNotMatch(message, /6\.1060875|125\.1816406/);
  assert.match(message, /TRUCK-44/);
});

test("other Enforcer or missing current assignment is rejected", async () => {
  const service = new VehicleIssueService({ db: new MemoryDb({ assignment: null }) });
  await assert.rejects(
    service.createReport(payload(), eligibleUser({ id: 99 })),
    (error) => error.code === "VEHICLE_ISSUE_CURRENT_ASSIGNMENT_REQUIRED" &&
      error.statusCode === 403
  );
});

test("current assignment query requires activated plan, nonterminal ticket, primary live link, and active session", async () => {
  const db = new MemoryDb();
  const service = new VehicleIssueService({ db });
  await service.loadCurrentAssignment(db, 13);
  const query = db.calls.find((call) => call.sql.includes("FROM dispatch_plans dp"));
  assert.ok(query);
  assert.match(query.sql, /dp\.assigned_enforcer_user_id = \?/);
  assert.match(query.sql, /dp\.status = 'activated'/);
  assert.match(query.sql, /dt\.status IN \(\?, \?, \?, \?\)/);
  assert.match(query.sql, /tts\.session_status = 'active'/);
  assert.match(query.sql, /dts\.unlinked_at IS NULL/);
  assert.match(query.sql, /dts\.is_primary = 1/);
  assert.deepEqual(query.parameters, [
    13,
    "prepared",
    "dispatched",
    "in_progress",
    "returning_to_wmo"
  ]);
});

test("duplicate client request returns the existing report", async () => {
  const db = new MemoryDb({ assignment: null, report: reportFixture() });
  const service = new VehicleIssueService({ db });
  const result = await service.createReport(payload(), eligibleUser());
  assert.equal(result.idempotent, true);
  assert.equal(result.report.id, 900);
  assert.equal(db.connection.commits, 0);
});

test("conflicting idempotency reuse is rejected", async () => {
  const db = new MemoryDb({ report: reportFixture() });
  const service = new VehicleIssueService({ db });
  await assert.rejects(
    service.createReport(payload({ description: "Different report" }), eligibleUser()),
    (error) => error.code === "VEHICLE_ISSUE_IDEMPOTENCY_CONFLICT" &&
      error.statusCode === 409
  );
});

test("malformed assistant JSON and invalid category are rejected", async () => {
  const service = new VehicleIssueService({ db: new MemoryDb() });
  await assert.rejects(
    service.createReport(payload({ assistant_answers: "bad-json" }), eligibleUser()),
    (error) => error.code === "VEHICLE_ISSUE_ANSWERS_MALFORMED"
  );
  await assert.rejects(
    service.createReport(payload({ issue_category: "repair" }), eligibleUser()),
    (error) => error.code === "VEHICLE_ISSUE_CATEGORY_INVALID"
  );
});

test("location evidence enforces complete bounded values", () => {
  assert.throws(
    () => normalizeLocation({ latitude: 91, longitude: 125, accuracy_meters: 5, location_recorded_at: "2026-09-25T00:00:00Z" }),
    (error) => error.code === "VEHICLE_ISSUE_LATITUDE_INVALID"
  );
  assert.throws(
    () => normalizeLocation({ latitude: 6, longitude: 181, accuracy_meters: 5, location_recorded_at: "2026-09-25T00:00:00Z" }),
    (error) => error.code === "VEHICLE_ISSUE_LONGITUDE_INVALID"
  );
  assert.throws(
    () => normalizeLocation({ latitude: 6 }),
    (error) => error.code === "VEHICLE_ISSUE_LOCATION_INCOMPLETE"
  );
});

test("submitted report moves under review and resolved report cannot reopen", async () => {
  const db = new MemoryDb({ report: reportFixture() });
  const service = new VehicleIssueService({ db });
  const reviewed = await service.reviewReport(900, { id: 4 });
  assert.equal(reviewed.report_status, "under_review");
  db.report.report_status = "resolved";
  await assert.rejects(
    service.reviewReport(900, { id: 4 }),
    (error) => error.code === "VEHICLE_ISSUE_ALREADY_RESOLVED"
  );
});

test("continue operation resolves without changing Fleet condition", async () => {
  const db = new MemoryDb({ report: reportFixture() });
  const service = new VehicleIssueService({ db });
  const result = await service.resolveReport(900, {
    resolution_action: "continue_operation",
    resolution_notes: "Safe to continue after WMO review."
  }, { id: 4 });
  assert.equal(result.report.report_status, "resolved");
  assert.equal(db.truck.fleet_condition, "available");
  assert.ok(!db.calls.some((call) => call.sql.includes("UPDATE fleet_trucks")));
});

test("maintenance resolution stores reason and changes Fleet condition only", async () => {
  const db = new MemoryDb({ report: reportFixture({ report_status: "under_review" }) });
  const service = new VehicleIssueService({ db });
  await service.resolveReport(900, {
    resolution_action: "set_for_maintenance",
    resolution_notes: "Inspect brake components before next route."
  }, { id: 4 });
  assert.equal(db.truck.fleet_condition, "for_maintenance");
  assert.equal(db.truck.condition_reason, "Inspect brake components before next route.");
  assert.ok(!db.calls.some((call) => /UPDATE\s+(dispatch_tickets|truck_tracking_sessions|dispatch_plans)/i.test(call.sql)));
});

test("out of service resolution preserves active dispatch and tracking state", async () => {
  const db = new MemoryDb({ report: reportFixture() });
  const service = new VehicleIssueService({ db });
  await service.resolveReport(900, {
    resolution_action: "set_out_of_service",
    resolution_notes: "Vehicle must remain parked after current safe handling."
  }, { id: 4 });
  assert.equal(db.truck.fleet_condition, "out_of_service");
  const mutationSql = db.calls
    .filter((call) => /^\s*UPDATE/i.test(call.sql))
    .map((call) => call.sql);
  assert.ok(mutationSql.every((sql) =>
    /UPDATE\s+(fleet_trucks|vehicle_issue_reports)/i.test(sql)
  ));
});

test("identical resolution is idempotent and conflicting resolution is rejected", async () => {
  const resolved = reportFixture({
    report_status: "resolved",
    resolution_action: "set_for_maintenance",
    resolution_notes: "Inspect vehicle."
  });
  const db = new MemoryDb({ report: resolved });
  const service = new VehicleIssueService({ db });
  const identical = await service.resolveReport(900, {
    resolution_action: "set_for_maintenance",
    resolution_notes: "Inspect vehicle."
  }, { id: 4 });
  assert.equal(identical.idempotent, true);
  await assert.rejects(
    service.resolveReport(900, {
      resolution_action: "set_out_of_service",
      resolution_notes: "Different final decision."
    }, { id: 4 }),
    (error) => error instanceof VehicleIssueError &&
      error.code === "VEHICLE_ISSUE_RESOLUTION_CONFLICT"
  );
});

test("maintenance and out-of-service resolution require a condition reason", async () => {
  const service = new VehicleIssueService({ db: new MemoryDb({ report: reportFixture() }) });
  await assert.rejects(
    service.resolveReport(900, { resolution_action: "set_for_maintenance" }, { id: 4 }),
    (error) => error.code === "VEHICLE_ISSUE_RESOLUTION_NOTES_REQUIRED"
  );
});

(async () => {
  let passed = 0;
  for (const current of tests) {
    try {
      await current.callback();
      passed += 1;
      console.log(`PASS ${current.name}`);
    } catch (error) {
      console.error(`FAIL ${current.name}`);
      console.error(error);
      process.exitCode = 1;
    }
  }
  console.log(`${passed}/${tests.length} vehicle issue service tests passed`);
})();
