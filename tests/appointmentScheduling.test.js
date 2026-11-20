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
  await assert.rejects(f.service.book(citizen, requestKey("retry")), /lost commit/);
  f.service.now = () => new Date("2026-11-24T00:00:00Z"); // Recovery remains possible after the original slot elapses.
  const replay = await f.service.book(citizen, requestKey("retry"));
  assert.equal(replay.idempotent, true); assert.equal(replay.appointment_code, "APT-000001");
  assert.equal(f.state.appointments.length, 1); assert.equal(f.state.notifications.length, 1);
  await assert.rejects(f.service.book({ ...citizen, notes: "different" }, requestKey("retry")), error => error.code === "IDEMPOTENCY_CONFLICT");
  assert.ok(f.connections.every(connection => connection.released && connection.timezone === "SYSTEM"));
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
  await assert.rejects(f.service.book(citizen, key), /lost commit/);
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
