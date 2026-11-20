const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../services/appointmentPolicy");
const { fixture, citizen, actor, requestKey } = require("./helpers/appointmentSchedulingFixture");
const now = () => new Date("2026-11-20T02:00:00Z");

test("policy preserves exact service keys, shared Others capacity, seven times and Manila boundaries", () => {
  assert.equal(policy.serviceKey("Others"), "others");
  assert.equal(policy.TIMES.length, 7);
  for (const [field, value] of [["purpose", "other"], ["preferred_date", "2026-11-23 12:00:00"], ["preferred_date", "2026-02-30 10:00:00"],
    ["preferred_date", "2026-11-20 09:00:00"], ["email", "invalid"], ["contact_number", "123"]]) {
    assert.throws(() => policy.booking({ ...citizen, [field]: value }, now()), error => error.statusCode === 400);
  }
  assert.throws(() => policy.booking({ ...citizen, purpose: "Others" }, now()), /specify/);
  assert.equal(policy.manilaNow(new Date("2026-11-19T16:00:00Z")), "2026-11-20 00:00:00");
  assert.throws(() => policy.schedule("Accreditation", "2026-11-19 16:00:00", new Date("2026-11-19T16:00:00Z")), /future/);
});
test("disabled/unready infrastructure and absent unique constraint fail closed before booking", async () => {
  for (const options of [{ enabled: false }, { unready: true }, { missingUnique: true }]) {
    const f = fixture(options);
    await assert.rejects(f.service.book(citizen, requestKey("blocked")), error => error.statusCode === 503);
    assert.equal(f.state.appointments.length, 0);
  }
});
test("MODEL concurrent same service/date/time yields one success and one 409; different services succeed", async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.service.book(citizen, requestKey("a")), f.service.book(citizen, requestKey("b"))]);
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(results.find(row => row.status === "rejected").reason.statusCode, 409);
  await f.service.book({ ...citizen, purpose: "IEC Resource Speaker" }, requestKey("c"));
  assert.equal(f.state.appointments.length, 2); assert.equal(f.state.notifications.length, 2);
  const snapshot = await f.service.availability("Accreditation", "2026-11-23");
  assert.equal(snapshot.slots.find(row => row.time === "10:00").status, "occupied");
  assert.doesNotMatch(JSON.stringify(snapshot), /Synthetic|091234|appointment_id|orientation_token|example/);
});
test("MODEL duplicate and uncertain-commit retries retain original reference without duplicate notice", async () => {
  const f = fixture({ commitUncertain: true });
  await assert.rejects(f.service.book(citizen, requestKey("retry")), error => error.statusCode === 503 && error.code === "APPOINTMENT_UNAVAILABLE");
  f.service.now = () => new Date("2026-11-24T00:00:00Z"); // Recovery remains possible after the original slot elapses.
  const replay = await f.service.book(citizen, requestKey("retry"));
  assert.equal(replay.idempotent, true); assert.equal(replay.appointment_code, "APT-000001");
  assert.equal(f.state.appointments.length, 1); assert.equal(f.state.notifications.length, 1);
  await assert.rejects(f.service.book({ ...citizen, notes: "different" }, requestKey("retry")), error => error.code === "IDEMPOTENCY_CONFLICT");
  assert.equal(f.connections[0].destroyCount, 1);
  assert.equal(f.connections[0].releaseCount, 0);
  assert.ok(f.connections.slice(1).every(connection => connection.released && connection.timezone === "SYSTEM"));
});
test("MODEL reference/notification failures roll back appointment, request and reservation", async () => {
  for (const failSql of ["SET appointment_code", "INSERT INTO notifications"]) {
    const f = fixture({ failSql });
    await assert.rejects(f.service.book(citizen, requestKey("rollback")), /Synthetic write failure/);
    for (const key of ["appointments", "requests", "slots", "notifications"]) assert.equal(f.state[key].length, 0);
    assert.ok(f.connections[0].released);
  }
});
test("pending and approved retain one slot; reject/cancel release it and retain history and session actor", async () => {
  for (const action of ["reject", "cancel"]) {
    const f = fixture(); const created = await f.service.book(citizen, requestKey(action));
    if (action === "cancel") await f.service.change(created.id, "accept", actor, f.expected(created.id));
    assert.equal(f.state.slots.length, 1);
    await f.service.change(created.id, action, actor, { ...f.expected(created.id), personnel_name: "FORGED" });
    assert.equal(f.state.slots.length, 0); assert.equal(f.state.appointments.length, 1);
    assert.equal(f.state.appointments[0].assigned_to ?? null, action === "cancel" ? "Authenticated Clerk" : null);
    await assert.rejects(f.service.change(created.id, "accept", actor, f.expected(created.id)), error => error.statusCode === 409);
  }
});
test("MODEL competing decisions and cancellation/reschedule cannot overwrite stale state", async () => {
  for (const actions of [["accept", "reject"], ["cancel", "reschedule"]]) {
    const f = fixture(); const { id } = await f.service.book(citizen, requestKey(actions[0])); const expected = f.expected(id);
    const results = await Promise.allSettled(actions.map(action => f.service.change(id, action, actor, { ...expected, new_date: "2026-11-23 11:00:00" })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.find(result => result.status === "rejected").reason.statusCode, 409);
  }
});
test("MODEL reschedule destination conflict rolls back source; two moves to one destination cannot both succeed", async () => {
  const f = fixture(); const first = await f.service.book(citizen, requestKey("first"));
  const second = await f.service.book({ ...citizen, preferred_date: "2026-11-23 11:00:00" }, requestKey("second"));
  await assert.rejects(f.service.change(first.id, "reschedule", actor, { ...f.expected(first.id), new_date: "2026-11-23 11:00:00" }), error => error.statusCode === 409);
  assert.equal(f.state.appointments[0].preferred_date, citizen.preferred_date);
  const results = await Promise.allSettled([first, second].map(row => f.service.change(row.id, "reschedule", actor, { ...f.expected(row.id), new_date: "2026-11-23 13:00:00" })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(f.state.slots.filter(row => row.slot_time === "13:00").length, 1);
});
test("Others notes never create separate capacity; completed appointments never reopen", async () => {
  const f = fixture(); const first = await f.service.book({ ...citizen, purpose: "Others", notes: "One" }, requestKey("others1"));
  await assert.rejects(f.service.book({ ...citizen, purpose: "Others", notes: "Two" }, requestKey("others2")), error => error.statusCode === 409);
  f.state.appointments[0].status = "completed";
  await assert.rejects(f.service.change(first.id, "accept", actor, f.expected(first.id)), error => error.statusCode === 409);
});
test("orientation approval retains token; existing progress/score cannot be reset by reapproval", async () => {
  const f = fixture(); const row = await f.service.book({ ...citizen, purpose: "SWM Orientation & Clearance" }, requestKey("orientation"));
  f.state.appointments[0].orientation_token = "ORI-existing";
  const approved = await f.service.change(row.id, "accept", actor, f.expected(row.id));
  assert.equal(approved.data.orientation_token, "ORI-existing");
  f.state.appointments[0].status = "rescheduled"; f.state.appointments[0].orientation_score = 8;
  await assert.rejects(f.service.change(row.id, "accept", actor, f.expected(row.id)), error => error.code === "ORIENTATION_REVIEW_REQUIRED");
  assert.equal(f.state.appointments[0].orientation_score, 8);
});

test("progressed orientations reject rescheduling before any write and retain all evidence", async () => {
  for (const evidence of [
    { orientation_status: "pending_orientation", orientation_started_at: "2026-11-23 10:01:00" },
    { orientation_status: "failed_orientation", orientation_score: 2, orientation_attempts: 1 },
    { orientation_status: "no_show" },
    { orientation_status: "ready_for_retake", orientation_score: 2, orientation_attempts: 1 },
    { orientation_status: "completed_orientation", orientation_completed: 1, orientation_score: 8, orientation_completed_at: "2026-11-23 10:30:00" },
    { orientation_status: "incomplete_orientation", orientation_completed_at: "2026-11-23 10:30:00" }
  ]) {
    const f = fixture();
    const { id } = await f.service.book({ ...citizen, purpose: "SWM Orientation & Clearance" }, requestKey("progress"));
    await f.service.change(id, "accept", actor, f.expected(id));
    Object.assign(f.state.appointments[0], evidence);
    const before = structuredClone(f.state), callStart = f.calls.length;
    await assert.rejects(f.service.change(id, "reschedule", actor, { ...f.expected(id), new_date: "2026-11-24 11:00:00" }),
      error => error.statusCode === 409 && error.code === "ORIENTATION_REVIEW_REQUIRED");
    assert.deepEqual(f.state, before);
    assert.equal(f.calls.slice(callStart).some(sql => /^(INSERT|UPDATE|DELETE) /.test(sql)), false);
  }
});
test("unstarted orientation can move and be reapproved; terminal records never move", async () => {
  const f = fixture();
  const { id } = await f.service.book({ ...citizen, purpose: "SWM Orientation & Clearance" }, requestKey("unstarted"));
  await f.service.change(id, "accept", actor, f.expected(id));
  const token = f.state.appointments[0].orientation_token;
  await f.service.change(id, "reschedule", actor, { ...f.expected(id), new_date: "2026-11-24 11:00:00" });
  await f.service.change(id, "accept", actor, f.expected(id));
  assert.equal(f.state.appointments[0].status, "approved");
  assert.equal(f.state.appointments[0].orientation_token, token);
  assert.equal(f.state.slots.length, 1);
  for (const status of ["completed", "rejected", "cancelled"]) {
    f.state.appointments[0].status = status;
    const before = structuredClone(f.state);
    await assert.rejects(f.service.change(id, "reschedule", actor, { ...f.expected(id), new_date: "2026-11-25 11:00:00" }),
      error => error.code === "INVALID_TRANSITION");
    assert.deepEqual(f.state, before);
  }
});
test("disabled maintenance never bypasses the reservation protocol, before or after activation", async () => {
  for (const action of ["accept", "reject", "cancel", "reschedule"]) {
    const options = {}, f = fixture(options);
    const { id } = await f.service.book(citizen, requestKey(action));
    const before = structuredClone(f.state);
    options.enabled = false;
    await assert.rejects(f.service.change(id, action, actor, { ...f.expected(id), new_date: "2026-11-24 11:00:00" }),
      error => error.statusCode === 503);
    assert.deepEqual(f.state, before);
    options.enabled = true;
    assert.equal((await f.service.availability(citizen.purpose, "2026-11-23")).slots.find(slot => slot.time === "10:00").status, "occupied");
    await f.service.change(id, action, actor, { ...f.expected(id), new_date: "2026-11-24 11:00:00" });
    assert.equal(f.state.slots.length, ["reject", "cancel"].includes(action) ? 0 : 1);
  }
  const f = fixture({ enabled: false });
  await assert.rejects(f.service.change(1, "cancel", actor, { expected_status: "pending", expected_schedule: citizen.preferred_date }),
    error => error.statusCode === 503);
  assert.equal(f.calls.some(sql => /^(INSERT|UPDATE|DELETE) /.test(sql)), false);
});
test("missing, stale or invalidated readiness and inconsistent reservations fail without mutations", async () => {
  for (const failure of ["missingState", "unready", "missingUnique", "unreadyInTransaction", "schemaVersion", "transactionSchemaVersion"]) {
    const options = {}, f = fixture(options);
    const { id } = await f.service.book(citizen, requestKey(failure));
    const before = structuredClone(f.state);
    options[failure] = failure.endsWith("SchemaVersion") || failure === "schemaVersion" ? 2 : true;
    await assert.rejects(f.service.change(id, "cancel", actor, f.expected(id)));
    assert.deepEqual(f.state, before);
  }
  for (const corrupt of [state => state.slots.splice(0), state => { state.slots[0].slot_time = "11:00"; }]) {
    const f = fixture(); const { id } = await f.service.book(citizen, requestKey("corrupt"));
    corrupt(f.state);
    const before = structuredClone(f.state);
    await assert.rejects(f.service.change(id, "cancel", actor, f.expected(id)), error => error.statusCode === 503);
    assert.deepEqual(f.state, before);
  }
});
test("lookup-only recovery returns the committed reference after elapsed time without creating any records", async () => {
  const f = fixture({ commitUncertain: true }), key = requestKey("recover");
  await assert.rejects(f.service.book(citizen, key), error => error.statusCode === 503 && error.code === "APPOINTMENT_UNAVAILABLE");
  f.service.now = () => new Date("2026-11-24T00:00:00Z");
  const before = structuredClone(f.state), callStart = f.calls.length;
  const recovered = await f.service.book(citizen, key, { recoveryOnly: true });
  assert.equal(recovered.appointment_code, "APT-000001");
  assert.equal(recovered.idempotent, true);
  assert.deepEqual(f.state, before);
  assert.equal(f.calls.slice(callStart).some(sql => /^(INSERT|UPDATE|DELETE) /.test(sql)), false);
  await assert.rejects(f.service.book({ ...citizen, full_name: "Different Citizen" }, key, { recoveryOnly: true }),
    error => error.code === "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(f.state, before);
});
test("lookup-only recovery of a missing key never creates a new booking or exposes citizen data", async () => {
  const f = fixture();
  await assert.rejects(f.service.book(citizen, requestKey("absent"), { recoveryOnly: true }),
    error => error.statusCode === 404 && error.code === "BOOKING_NOT_FOUND" && !/Synthetic|091234|example/.test(error.message));
  assert.equal(f.state.appointments.length, 0);
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.state.notifications.length, 0);
});
test("latest actual approval survives later actions; historical names are never inferred or replaced", async () => {
  const options = {}, f = fixture(options); const { id } = await f.service.book(citizen, requestKey("actor"));
  const first = { id: 11, full_name: "Staff A" }, later = { id: 12, full_name: "Staff B" };
  await f.service.change(id, "accept", first, f.expected(id));
  const acceptedAt = f.state.appointments[0].assigned_at;
  const moved = await f.service.change(id, "reschedule", later, { ...f.expected(id), new_date: "2026-11-24 11:00:00" });
  assert.equal(f.state.appointments[0].assigned_to, "Staff A");
  assert.equal(f.state.appointments[0].assigned_at, acceptedAt);
  assert.equal(moved.data.action_by, "Staff B");
  assert.equal(moved.data.assigned_to, "Staff A");
  options.databaseNow = "2026-11-21 10:00:00";
  await f.service.change(id, "accept", later, f.expected(id));
  assert.equal(f.state.appointments[0].assigned_to, "Staff B", "report means latest actual approval");
  assert.equal(f.state.appointments[0].assigned_at, options.databaseNow);
  await f.service.change(id, "cancel", first, f.expected(id));
  assert.equal(f.state.appointments[0].assigned_to, "Staff B");
  const g = fixture(); const pending = await g.service.book(citizen, requestKey("reject-actor"));
  await g.service.change(pending.id, "reject", later, g.expected(pending.id));
  assert.equal(g.state.appointments[0].assigned_to ?? null, null, "rejection must not fabricate an acceptance");
  const h = fixture(); const legacy = await h.service.book(citizen, requestKey("legacy-actor"));
  h.state.appointments[0].assigned_to = "Unverified legacy value";
  await h.service.change(legacy.id, "cancel", later, h.expected(legacy.id));
  assert.equal(h.state.appointments[0].assigned_to, "Unverified legacy value");
  const j = fixture(); const rescheduled = await j.service.book(citizen, requestKey("rejected-after-move"));
  await j.service.change(rescheduled.id, "accept", first, j.expected(rescheduled.id));
  await j.service.change(rescheduled.id, "reschedule", later, { ...j.expected(rescheduled.id), new_date: "2026-11-24 11:00:00" });
  await j.service.change(rescheduled.id, "reject", later, j.expected(rescheduled.id));
  assert.equal(j.state.appointments[0].assigned_to, "Staff A");
  assert.equal(j.state.slots.length, 0);
});
test("legacy pending snapshots use canonical status while conditional writes compare the original raw value", async () => {
  for (const status of [null, "", "   ", "PeNdInG", " pending ", "pending"]) {
    const f = fixture(); const { id } = await f.service.book(citizen, requestKey("status"));
    f.state.appointments[0].status = status;
    await f.service.change(id, "accept", actor, { ...f.expected(id), expected_status: "pending" });
    assert.equal(f.state.appointments[0].status, "approved");
    await assert.rejects(f.service.change(id, "cancel", actor, { ...f.expected(id), expected_revision: 0 }),
      error => error.code === "STALE_APPOINTMENT");
  }
});
test("a failed appointment update rolls back moved/deleted reservations and preserves acceptance evidence", async () => {
  for (const action of ["reschedule", "cancel", "reject"]) {
    const options = {}, f = fixture(options), { id } = await f.service.book(citizen, requestKey("write-failure"));
    if (action !== "reject") await f.service.change(id, "accept", actor, f.expected(id));
    const before = structuredClone(f.state);
    options.failSql = "UPDATE appointments SET status";
    await assert.rejects(f.service.change(id, action, { id: 12, full_name: "Later Staff" },
      { ...f.expected(id), new_date: "2026-11-24 11:00:00" }), /Synthetic write failure/);
    assert.deepEqual(f.state, before);
  }
});

function diagnostics(t) {
  const messages = [];
  t.mock.method(console, "warn", (...args) => messages.push(args));
  return messages;
}
function noCommittedRecords(f) {
  for (const key of ["appointments", "requests", "slots", "notifications"]) assert.equal(f.state[key].length, 0, key);
}

test("R1 normal booking commits once, restores the exact timezone and releases once", async () => {
  const f = fixture({ originalTimezone: "+05:30" });
  const result = await f.service.book(citizen, requestKey("r1-normal"));
  assert.equal(result.success, true); assert.equal(result.appointment_code, "APT-000001");
  for (const key of ["appointments", "requests", "slots", "notifications"]) assert.equal(f.state[key].length, 1, key);
  const c = f.connections[0];
  assert.equal(c.committed, true); assert.equal(c.transactionUnresolved, false);
  assert.equal(c.commitAttempts, 1); assert.equal(c.commitAcknowledgements, 1);
  assert.equal(c.rollbackAttempts, 0); assert.equal(c.timezone, "+05:30");
  assert.equal(c.releaseCount, 1); assert.equal(c.destroyCount, 0);
  assert.deepEqual(c.events, ["timezone_read", "timezone_set", "begin", "begun", "commit", "committed", "timezone_restore", "timezone_restored", "release"]);
  const writes = f.calls.filter(sql => /^(INSERT|UPDATE|DELETE) /.test(sql));
  assert.deepEqual(writes.map(sql => sql.match(/^(?:INSERT INTO|UPDATE) \w+/)[0]), [
    "INSERT INTO appointment_booking_requests", "INSERT INTO appointments", "INSERT INTO appointment_reservations",
    "UPDATE appointments", "INSERT INTO notifications", "UPDATE appointment_booking_requests"
  ]);
  assert.equal(f.calls.filter(sql => sql === "SELECT @@session.time_zone AS timezone").length, 1);
  assert.equal(f.calls.filter(sql => sql === "SET time_zone = '+08:00'").length, 1);
  assert.equal(f.calls.filter(sql => sql === "SET time_zone = ?").length, 1);
});

test("R1 readiness denial never acquires a connection or starts business work", async () => {
  for (const options of [{ enabled: false }, { unready: true }, { missingUnique: true }]) {
    const f = fixture(options);
    await assert.rejects(f.service.book(citizen, requestKey("r1-readiness")), error => error.statusCode === 503);
    assert.equal(f.metrics.acquisitionAttempts, 0); assert.equal(f.connections.length, 0);
    assert.equal(f.calls.some(sql => /^(INSERT|UPDATE|DELETE) /.test(sql)), false);
    noCommittedRecords(f);
  }
});

test("R1 acquisition failure preserves its error without transaction or replacement work", async () => {
  const primary = new Error("Synthetic acquisition error"), f = fixture({ acquireError: primary });
  await assert.rejects(f.service.book(citizen, requestKey("r1-acquire")), error => error === primary);
  assert.equal(f.metrics.acquisitionAttempts, 1); assert.equal(f.connections.length, 0);
  assert.equal(f.calls.some(sql => /^(INSERT|UPDATE|DELETE|SET) /.test(sql)), false);
  noCommittedRecords(f);
});

test("R1 timezone read, SET and invalid-state failures destroy without starting a transaction", async () => {
  for (const fault of ["timezoneReadError", "timezoneSetError", "missingTimezone", "nullTimezone", "emptyTimezone"]) {
    const primary = new Error(`Synthetic ${fault}`);
    const options = fault === "missingTimezone" ? { timezoneReadValue: undefined }
      : fault === "nullTimezone" ? { timezoneReadValue: null }
      : fault === "emptyTimezone" ? { timezoneReadValue: "" } : { [fault]: primary };
    const f = fixture(options);
    await assert.rejects(f.service.book(citizen, requestKey("r1-setup")),
      error => fault.endsWith("Error") ? error === primary : error.statusCode === 503);
    const c = f.connections[0];
    assert.equal(c.beginAttempts, 0); assert.equal(c.businessSqlAttempts, 0);
    assert.equal(c.rollbackAttempts, 0); assert.equal(c.commitAttempts, 0);
    assert.equal(c.timezoneRestoreAttempts, 0); assert.equal(c.releaseCount, 0);
    assert.equal(c.destroyCount, 1); assert.equal(c.destroyed, true);
    if (fault === "timezoneSetError") assert.equal(c.timezone, "+08:00", "failed SET acknowledgement can hide an applied change");
    noCommittedRecords(f);
  }
});

test("R1 failed BEGIN may leave a transaction active and must destroy without business SQL", async () => {
  const primary = new Error("Synthetic lost BEGIN acknowledgement"), f = fixture({ beginError: primary });
  await assert.rejects(f.service.book(citizen, requestKey("r1-begin")), error => error === primary);
  const c = f.connections[0];
  assert.equal(c.beginAttempts, 1); assert.equal(c.beginAcknowledgements, 0);
  assert.equal(c.businessSqlAttempts, 0); assert.equal(c.commitAttempts, 0);
  assert.equal(c.rollbackAttempts, 0); assert.equal(c.timezoneRestoreAttempts, 0);
  assert.equal(c.unresolvedAtCleanup, true); assert.equal(c.transactionUnresolved, false);
  assert.equal(c.destroyCount, 1); assert.equal(c.releaseCount, 0); noCommittedRecords(f);
});

test("R1 business error stays primary after acknowledged rollback and restoration", async () => {
  const primary = policy.fail(409, "SLOT_UNAVAILABLE", "Synthetic business conflict");
  const f = fixture({ failSql: "INSERT INTO notifications", businessError: primary, originalTimezone: "+05:30" });
  await assert.rejects(f.service.book(citizen, requestKey("r1-business")), error => error === primary);
  const c = f.connections[0];
  assert.ok(c.businessSqlAttempts > 0); assert.equal(c.commitAttempts, 0);
  assert.equal(c.rollbackAttempts, 1); assert.equal(c.rollbackAcknowledgements, 1);
  assert.equal(c.timezoneRestoreAcknowledgements, 1); assert.equal(c.timezone, "+05:30");
  assert.equal(c.releaseCount, 1); assert.equal(c.destroyCount, 0);
  assert.equal(c.committed, false); assert.equal(c.transactionUnresolved, false); noCommittedRecords(f);
});

test("R1 rollback failure preserves the business error and destroys without a release or restore", async t => {
  const warnings = diagnostics(t), primary = new Error("Synthetic business error");
  const f = fixture({ failSql: "INSERT INTO notifications", businessError: primary, rollbackError: true });
  await assert.rejects(f.service.book(citizen, requestKey("r1-rollback")), error => error === primary);
  const c = f.connections[0];
  assert.equal(c.rollbackAttempts, 1); assert.equal(c.rollbackAcknowledgements, 0);
  assert.equal(c.unresolvedAtCleanup, true); assert.equal(c.committed, false);
  assert.equal(c.timezoneRestoreAttempts, 0); assert.equal(c.releaseCount, 0);
  assert.equal(c.destroyCount, 1); assert.equal(c.destroyed, true);
  assert.equal(c.events.includes("rolled_back"), false);
  assert.deepEqual(warnings.map(args => args[1].stage), ["rollback_failed"]); noCommittedRecords(f);
});

for (const persisted of [true, false]) {
  test(`R1 lost COMMIT acknowledgement is unconfirmed when ${persisted ? "persisted" : "not persisted"}`, async t => {
    const warnings = diagnostics(t), f = fixture({ commitUncertain: true, commitPersisted: persisted });
    const key = requestKey(`r1-commit-${persisted}`), input = JSON.stringify(citizen);
    await assert.rejects(f.service.book(citizen, key), error => error.statusCode === 503 &&
      error.code === "APPOINTMENT_UNAVAILABLE" && /could not be confirmed/.test(error.message));
    assert.equal(JSON.stringify(citizen), input);
    const c = f.connections[0];
    assert.equal(f.connections.length, 1, "no automatic transaction retry");
    assert.equal(c.commitAttempts, 1); assert.equal(c.commitAcknowledgements, 0);
    assert.equal(c.committed, persisted); assert.equal(c.rollbackAttempts, 0);
    assert.equal(c.timezoneRestoreAttempts, 0); assert.equal(c.destroyCount, 1); assert.equal(c.releaseCount, 0);
    assert.equal(c.unresolvedAtCleanup, !persisted);
    assert.deepEqual(warnings.map(args => args[1].stage), ["commit_unconfirmed"]);
    const before = structuredClone(f.state), callStart = f.calls.length;
    f.service.now = () => new Date("2026-11-24T00:00:00Z");
    if (persisted) {
      const recovered = await f.service.book(citizen, key, { recoveryOnly: true });
      assert.equal(recovered.appointment_code, "APT-000001"); assert.equal(recovered.idempotent, true);
      assert.equal(f.state.requests[0].hash, require("node:crypto").createHash("sha256").update(key).digest("hex"));
      assert.equal(f.state.appointments.length, 1); assert.equal(f.state.notifications.length, 1);
    } else {
      await assert.rejects(f.service.book(citizen, key, { recoveryOnly: true }), error => error.code === "BOOKING_NOT_FOUND");
      noCommittedRecords(f);
    }
    assert.deepEqual(f.state, before);
    assert.equal(f.calls.slice(callStart).some(sql => /^(INSERT|UPDATE|DELETE) /.test(sql)), false,
      "recovery with the original key is lookup-only in both outcomes");
  });
}

test("R1 acknowledged COMMIT remains successful when timezone restoration fails", async t => {
  const warnings = diagnostics(t), options = { restoreError: true }, f = fixture(options);
  const key = requestKey("r1-restore"), result = await f.service.book(citizen, key);
  assert.equal(result.success, true); assert.equal(result.appointment_code, "APT-000001");
  const c = f.connections[0];
  assert.equal(c.commitAcknowledgements, 1); assert.equal(c.committed, true);
  assert.equal(c.rollbackAttempts, 0); assert.equal(c.timezoneRestoreAttempts, 1);
  assert.equal(c.timezoneRestoreAcknowledgements, 0); assert.equal(c.destroyCount, 1); assert.equal(c.releaseCount, 0);
  assert.deepEqual(warnings.map(args => args[1].stage), ["timezone_restore_failed"]);
  options.restoreError = false;
  const recovered = await f.service.book(citizen, key, { recoveryOnly: true });
  assert.equal(recovered.appointment_code, result.appointment_code);
  assert.equal(f.state.appointments.length, 1); assert.equal(f.state.notifications.length, 1);
});

test("R1 restoration failure after rollback cannot replace the original business error", async t => {
  diagnostics(t);
  const primary = new Error("Synthetic primary business error");
  const f = fixture({ failSql: "INSERT INTO notifications", businessError: primary, restoreError: true });
  await assert.rejects(f.service.book(citizen, requestKey("r1-error-restore")), error => error === primary);
  const c = f.connections[0];
  assert.equal(c.rollbackAcknowledgements, 1); assert.equal(c.timezoneRestoreAcknowledgements, 0);
  assert.equal(c.destroyCount, 1); assert.equal(c.releaseCount, 0); noCommittedRecords(f);
});

for (const scenario of [
  { label: "release exception preserves committed success", releaseError: true },
  { label: "destroy exception preserves committed success", destroyError: true, restoreError: true },
  { label: "destroy exception preserves a failed-rollback business error", destroyError: true, rollbackError: true, businessFailure: true },
  { label: "release exception preserves a rolled-back business error", releaseError: true, businessFailure: true }
]) {
  test(`R1 ${scenario.label}`, async t => {
    const warnings = diagnostics(t), primary = new Error("Synthetic primary error");
    const f = fixture({ ...scenario, ...(scenario.businessFailure ? { failSql: "INSERT INTO notifications", businessError: primary } : {}) });
    if (scenario.businessFailure) {
      await assert.rejects(f.service.book(citizen, requestKey("r1-terminal")), error => error === primary);
      noCommittedRecords(f);
    } else {
      assert.equal((await f.service.book(citizen, requestKey("r1-terminal"))).success, true);
      assert.equal(f.state.appointments.length, 1); assert.equal(f.state.notifications.length, 1);
    }
    const c = f.connections[0];
    assert.equal(c.releaseCount, scenario.releaseError ? 1 : 0);
    assert.equal(c.destroyCount, scenario.destroyError ? 1 : 0);
    assert.equal(c.releaseCount + c.destroyCount, 1, "never retry cleanup through the other terminal method");
    assert.equal(c.committed, !scenario.businessFailure);
    assert.equal(c.transactionUnresolved, Boolean(scenario.rollbackError), "a failed destroy does not prove physical closure");
    assert.ok(warnings.some(args => args[1].stage === (scenario.destroyError ? "destroy_failed" : "release_failed")));
  });
}

test("R1 healthy pooled operations continue without reusing a destroyed connection", async t => {
  diagnostics(t);
  const f = fixture({ commitUncertain: true, reuseConnections: true }), key = requestKey("r1-reuse");
  await assert.rejects(f.service.book(citizen, key), error => error.code === "APPOINTMENT_UNAVAILABLE");
  const damaged = f.connections[0];
  assert.equal((await f.service.book(citizen, key, { recoveryOnly: true })).appointment_code, "APT-000001");
  await f.service.book({ ...citizen, purpose: "IEC Resource Speaker" }, requestKey("r1-next"));
  assert.equal(f.connections.length, 2); assert.equal(f.leases.length, 3);
  assert.equal(f.leases[0], damaged); assert.notEqual(f.leases[1], damaged);
  assert.equal(f.leases[1], f.leases[2], "the healthy connection is actually reused by the model pool");
  assert.equal(damaged.destroyCount, 1); assert.equal(damaged.releaseCount, 0);
  assert.equal(f.connections[1].checkoutCount, 2); assert.equal(f.connections[1].releaseCount, 2);
  assert.equal(f.connections[1].destroyCount, 0); assert.equal(f.connections[1].timezone, "SYSTEM");
  assert.equal(f.state.appointments.length, 2); assert.equal(f.state.notifications.length, 2);
});

test("R1 fatal business errors cannot make a connection reusable even if cleanup callbacks succeed", async () => {
  const primary = Object.assign(new Error("Synthetic fatal business error"), { fatal: true });
  const f = fixture({ failSql: "INSERT INTO notifications", businessError: primary });
  await assert.rejects(f.service.book(citizen, requestKey("r1-fatal")), error => error === primary);
  const c = f.connections[0];
  assert.equal(c.rollbackAcknowledgements, 1); assert.equal(c.timezoneRestoreAttempts, 0);
  assert.equal(c.destroyCount, 1); assert.equal(c.releaseCount, 0); noCommittedRecords(f);
});

test("R1 commit failures and cleanup diagnostics never expose driver payloads or become slot conflicts", async t => {
  const warnings = diagnostics(t);
  const secret = "SYNTHETIC_PRIVATE_SQL synthetic@example.invalid ORI-private hash-private password-private";
  const raw = Object.assign(new Error(secret), { statusCode: 409, code: "SLOT_UNAVAILABLE", sql: secret });
  const f = fixture({ commitError: raw, commitPersisted: true });
  await assert.rejects(f.service.book(citizen, requestKey("r1-private")), error => {
    assert.equal(error.statusCode, 503); assert.equal(error.code, "APPOINTMENT_UNAVAILABLE");
    assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE|example|ORI-private|hash-private|password-private/);
    return true;
  });
  const g = fixture({ failSql: "INSERT INTO notifications", businessError: raw, rollbackError: raw, destroyError: raw });
  await assert.rejects(g.service.book(citizen, requestKey("r1-private-cleanup")), error => error === raw);
  const h = fixture({ restoreError: raw });
  assert.equal((await h.service.book(citizen, requestKey("r1-private-restore"))).success, true);
  assert.deepEqual(warnings.map(args => args[1].stage), ["commit_unconfirmed", "rollback_failed", "destroy_failed", "timezone_restore_failed"]);
  assert.doesNotMatch(JSON.stringify(warnings), /SYNTHETIC_PRIVATE|example|ORI-private|hash-private|password-private|sql|requestKey/i);
});

test("R1 diagnostic logger exceptions cannot replace a committed success or primary failure", async t => {
  t.mock.method(console, "warn", () => { throw new Error("Synthetic diagnostic failure"); });
  const f = fixture({ restoreError: true });
  assert.equal((await f.service.book(citizen, requestKey("r1-log-success"))).success, true);
  assert.equal(f.connections[0].destroyCount, 1);
  const primary = new Error("Synthetic original business error");
  const g = fixture({ failSql: "INSERT INTO notifications", businessError: primary, rollbackError: true });
  await assert.rejects(g.service.book(citizen, requestKey("r1-log-error")), error => error === primary);
  const h = fixture({ commitUncertain: true });
  await assert.rejects(h.service.book(citizen, requestKey("r1-log-commit")), error => error.code === "APPOINTMENT_UNAVAILABLE");
  assert.equal(h.connections[0].destroyCount, 1);
});
