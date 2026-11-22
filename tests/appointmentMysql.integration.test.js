"use strict";

// Default invocation is OFFLINE: only guard/fixture checks run; real tests are skipped.
// Future authorized execution, in a fresh PowerShell process (never load .env):
// 1. Operator creates a fresh local MySQL 9.7.2 instance, empty database named
//    wmo_appointment_staging_<run>, and applies fixtures/appointmentMysql.schema.sql.
// 2. Local-only accounts: wmo_appt_stage_app has SELECT/INSERT/UPDATE/DELETE on that
//    database; wmo_appt_stage_observer has SELECT. Neither needs global/DDL privileges.
// 3. Set WMO_APPOINTMENT_MYSQL_HOST=127.0.0.1, PORT=<nondefault published port>,
//    DATABASE=<exact schema>, CONFIRM_EMPTY=<same schema>, USER=wmo_appt_stage_app,
//    PASSWORD=<local password>, OBSERVER_USER=wmo_appt_stage_observer,
//    OBSERVER_PASSWORD=<local password>. Prefix every name with WMO_APPOINTMENT_MYSQL_.
// 4. Remove inherited DATABASE_URL, MYSQL_URL and RESEND_API_KEY from that process.
//    Set WMO_APPOINTMENT_MYSQL_EXECUTE=I_AUTHORIZE_LOCAL_DISPOSABLE_MYSQL.
//    Run the verified Node 22 executable with:
//      --test --test-concurrency=1 tests/appointmentMysql.integration.test.js
// Requires separately authorized dependency installation and database execution.
// No automatic migration, DROP, row cleanup, Docker or production-server startup.
// Data remains for inspection; every subsequent run requires another empty fixture.

const test = require("node:test");
const assert = require("node:assert/strict");
const { EXECUTE, validateTarget, fixtureStatements, barrier, instrumentPool, createStaging } = require("./helpers/appointmentMysqlStaging");
const policy = require("../services/appointmentPolicy");
const { AppointmentSchedulingService } = require("../services/appointmentSchedulingService");
const { WEB_ORIENTATION_ANSWERS } = require("../utils/orientationWorkflow");

function syntheticEnvironment() {
  return { WMO_APPOINTMENT_MYSQL_EXECUTE: EXECUTE, WMO_APPOINTMENT_MYSQL_HOST: "127.0.0.1", WMO_APPOINTMENT_MYSQL_PORT: "33308",
    WMO_APPOINTMENT_MYSQL_DATABASE: "wmo_appointment_staging_offline", WMO_APPOINTMENT_MYSQL_CONFIRM_EMPTY: "wmo_appointment_staging_offline",
    WMO_APPOINTMENT_MYSQL_USER: "wmo_appt_stage_app", WMO_APPOINTMENT_MYSQL_PASSWORD: "synthetic-not-used",
    WMO_APPOINTMENT_MYSQL_OBSERVER_USER: "wmo_appt_stage_observer", WMO_APPOINTMENT_MYSQL_OBSERVER_PASSWORD: "synthetic-not-used" };
}
test("offline: absent authority refuses before driver import or connection", async () => {
  assert.throws(() => validateTarget({}), /STAGING_TARGET_REFUSED/);
  if (process.env.WMO_APPOINTMENT_MYSQL_EXECUTE !== EXECUTE) await assert.rejects(createStaging(), /STAGING_TARGET_REFUSED/);
});
test("offline: local target guard rejects remote, ambiguous and production configuration", () => {
  const valid = syntheticEnvironment(); assert.equal(validateTarget(valid).database, valid.WMO_APPOINTMENT_MYSQL_DATABASE);
  for (const change of [{ WMO_APPOINTMENT_MYSQL_HOST: "localhost" }, { WMO_APPOINTMENT_MYSQL_HOST: "railway.invalid" },
    { WMO_APPOINTMENT_MYSQL_PORT: "3306" }, { WMO_APPOINTMENT_MYSQL_PORT: "NaN" }, { WMO_APPOINTMENT_MYSQL_PORT: "65536" },
    { WMO_APPOINTMENT_MYSQL_DATABASE: "railway" }, { WMO_APPOINTMENT_MYSQL_DATABASE: "wmo_appointment_staging_x;DROP" },
    { WMO_APPOINTMENT_MYSQL_CONFIRM_EMPTY: "different" }, { WMO_APPOINTMENT_MYSQL_USER: "root" },
    { WMO_APPOINTMENT_MYSQL_OBSERVER_USER: "root" }, { WMO_APPOINTMENT_MYSQL_PASSWORD: "" },
    { WMO_APPOINTMENT_MYSQL_OBSERVER_PASSWORD: "" }, { DATABASE_URL: "never-used" }, { MYSQL_URL: "never-used" },
    { RESEND_API_KEY: "never-used" }, { WMO_APPOINTMENT_MYSQL_EXECUTE: "true" }])
    assert.throws(() => validateTarget({ ...valid, ...change }), /STAGING_TARGET_REFUSED/);
});
test("offline: fixture stays staging-only, InnoDB, signed-ID compatible and unready", () => {
  const statements = fixtureStatements(), sql = statements.join(";\n");
  assert.equal(statements.filter(s => s.startsWith("CREATE TABLE")).length, 7);
  assert.match(sql, /PRIMARY KEY \(service_key, appointment_date, appointment_time\)/);
  assert.match(sql, /appointment_id INT NOT NULL/); assert.match(sql, /appointment_id INT NULL DEFAULT NULL/);
  assert.equal((sql.match(/ON DELETE RESTRICT ON UPDATE RESTRICT/g) || []).length, 2);
  assert.match(sql, /appointment_revision BIGINT UNSIGNED NOT NULL DEFAULT 0/);
  assert.match(sql, /VALUES \('service_slots', 1, 0\)/);
});
test("offline: concurrency barrier waits for two distinct connections", async () => {
  const gate = barrier(2, 200); let first = false;
  const one = gate.arrive(1).then(() => { first = true; }); await Promise.resolve(); assert.equal(first, false);
  await Promise.all([one, gate.arrive(2)]); assert.equal(first, true); assert.equal(gate.ids.size, 2);
});
test("offline: aborted concurrency barrier settles without leaving its timer", async () => {
  const gate = barrier(2, 200), waiting = gate.arrive(1); gate.cancel(); await assert.rejects(waiting, /STAGING_BARRIER_ABORTED/);
});
test("offline: pool adapter preserves query binding and reports real commit before a controlled lost acknowledgement", async () => {
  const calls = [], raw = { threadId: 42,
    query(sql, values, done) { calls.push(sql); queueMicrotask(() => done(null, [])); },
    beginTransaction(done) { queueMicrotask(done); }, commit(done) { calls.push("real commit callback"); queueMicrotask(done); },
    rollback(done) { queueMicrotask(done); }, release() { calls.push("released"); }, destroy() { calls.push("destroyed"); }
  };
  const pool = { query(sql, done) { assert.equal(this, pool); calls.push(sql); done(); }, getConnection(done) { done(null, raw); } };
  const adapter = instrumentPool(pool); adapter.pool.query("unmodified pool query", () => {});
  const c = await new Promise((resolve, reject) => adapter.pool.getConnection((e, value) => e ? reject(e) : resolve(value)));
  await new Promise((resolve, reject) => c.query("unmodified SQL", [], e => e ? reject(e) : resolve()));
  adapter.controls.loseCommitAck = true;
  await assert.rejects(new Promise((resolve, reject) => c.commit(e => e ? reject(e) : resolve())), /STAGING_LOST_COMMIT_ACK/);
  c.destroy(); assert.deepEqual(calls, ["unmodified pool query", "unmodified SQL", "real commit callback", "destroyed"]);
  assert.deepEqual(adapter.leases[0].events, ["commit-sent", "commit-ack-lost"]); assert.equal(adapter.leases[0].destroyed, 1);
});

let sequence = 0;
const key = () => `staging-http-request-${String(++sequence).padStart(8, "0")}`;
function day(offset) {
  const date = new Date(policy.manilaNow().slice(0, 10) + "T00:00:00Z"); date.setUTCDate(date.getUTCDate() + 30 + offset);
  return date.toISOString().slice(0, 10);
}
function citizen(offset, purpose = "Accreditation", time = "10:00") {
  const n = ++sequence;
  return { full_name: `Staging Citizen ${n}`, barangay: "Apopong", contact_number: "09123456789", email: `staging${n}@example.invalid`,
    purpose, preferred_date: `${day(offset)} ${time}:00`, notes: purpose === "Others" ? "Synthetic staging service" : "" };
}
function ok(response, status = 200) { assert.equal(response.status, status, `Unexpected HTTP outcome: ${response.body?.code || response.body?.message || "non-JSON"}`); return response.body; }
function delta(before, after, amount) { for (const name of ["appointments", "reservations", "requests", "notifications"]) assert.equal(after[name].length - before[name].length, amount, name); }
async function booking(ctx, body, requestKey = key()) { return ok(await ctx.request("POST", "/api/appointments", { body, key: requestKey })); }
async function change(ctx, id, action, extra = {}, user = "clerk_admin") {
  const path = ["accept", "reject"].includes(action) ? "decision" : action;
  return ctx.request("PUT", `/api/appointments/${id}/${path}`, { user, body: { ...await ctx.expected(id), action, ...extra } });
}
async function parallel(ctx, jobs) {
  const gate = barrier(); ctx.controls.gate = gate;
  try { const responses = await Promise.all(jobs.map(job => job())); assert.equal(gate.ids.size, 2); return responses; }
  finally { gate.cancel(); ctx.controls.gate = null; }
}

test("real MySQL HTTP appointment integration (explicit local execution only)", {
  skip: process.env.WMO_APPOINTMENT_MYSQL_EXECUTE !== EXECUTE, timeout: 180000
}, async t => {
  const ctx = await createStaging();
  async function run(name, work) {
    await t.test(name, { timeout: 30000 }, async () => {
      await ctx.restartHttp(); // Fresh real router, including its process-local rate-limit state.
      try { await work(); }
      finally { ctx.controls.gate?.cancel(); ctx.controls.gate = null; ctx.controls.failNotification = false; ctx.controls.loseCommitAck = false; ctx.setEmailFailure(false); }
    });
  }
  try {
    await run("all four services and seven times remain bookable", async () => {
      for (const purpose of Object.keys(policy.SERVICES)) {
        await ctx.restartHttp();
        for (const time of policy.TIMES) await booking(ctx, citizen(0, purpose, time));
        const result = ok(await ctx.request("GET", `/api/appointments/availability?service=${encodeURIComponent(purpose)}&date=${day(0)}`));
        assert.deepEqual(result.slots.map(s => s.time), [...policy.TIMES]); assert.ok(result.slots.every(s => s.status === "occupied"));
      }
    });
    await run("concurrent same service/date/time commits only one booking", async () => {
      const before = await ctx.snapshot(), body = citizen(1);
      const result = await parallel(ctx, [() => ctx.request("POST", "/api/appointments", { body, key: key() }), () => ctx.request("POST", "/api/appointments", { body: { ...body, full_name: "Other Staging Citizen" }, key: key() })]);
      assert.deepEqual(result.map(r => r.status).sort(), [200, 409]); assert.equal(result.find(r => r.status === 409).body.code, "SLOT_UNAVAILABLE");
      delta(before, await ctx.snapshot(), 1);
    });
    await run("different services simultaneously use the same clock time", async () => {
      const before = await ctx.snapshot();
      const result = await parallel(ctx, ["Accreditation", "IEC Resource Speaker"].map(purpose => () => ctx.request("POST", "/api/appointments", { body: citizen(2, purpose), key: key() })));
      result.forEach(r => ok(r)); delta(before, await ctx.snapshot(), 2);
    });
    await run("pending and approved both block their service slot", async () => {
      const body = citizen(3), first = await booking(ctx, body);
      assert.equal(ok(await ctx.request("POST", "/api/appointments", { body, key: key() }), 409).code, "SLOT_UNAVAILABLE");
      ok(await change(ctx, first.id, "accept"));
      assert.equal(ok(await ctx.request("POST", "/api/appointments", { body, key: key() }), 409).code, "SLOT_UNAVAILABLE");
      const rows = (await ctx.snapshot()).reservations.filter(r => r.appointment_id === first.id); assert.equal(rows.length, 1);
    });
    await run("rejection and cancellation release capacity but retain history", async () => {
      for (const [offset, action] of [[4, "reject"], [5, "cancel"]]) {
        const body = citizen(offset), first = await booking(ctx, body);
        if (action === "cancel") ok(await change(ctx, first.id, "accept"));
        ok(await change(ctx, first.id, action)); const next = await booking(ctx, body); assert.notEqual(next.id, first.id);
        const rows = await ctx.snapshot(); assert.ok(rows.appointments.some(r => r.id === first.id && r.status === (action === "reject" ? "rejected" : "cancelled")));
        assert.ok(!rows.reservations.some(r => r.appointment_id === first.id));
      }
    });
    await run("successful and conflicting reschedules preserve slots and email semantics", async () => {
      const first = await booking(ctx, citizen(6)), blocked = await booking(ctx, citizen(6, "Accreditation", "11:00"));
      const before = await ctx.snapshot(), emailCount = ctx.emails.length;
      assert.equal(ok(await change(ctx, first.id, "reschedule", { new_date: `${day(6)} 11:00:00` }), 409).code, "SLOT_UNAVAILABLE");
      assert.deepEqual(await ctx.snapshot(), before); assert.equal(ctx.emails.length, emailCount);
      const moved = `${day(6)} 13:00:00`; ok(await change(ctx, first.id, "reschedule", { new_date: moved }));
      let state = await ctx.snapshot(); assert.equal(state.appointments.find(r => r.id === first.id).preferred_date, moved);
      assert.equal(state.reservations.find(r => r.appointment_id === first.id).appointment_time, "13:00:00");
      assert.equal(ok(await ctx.request("POST", "/api/appointments", { body: citizen(6, "Accreditation", "13:00"), key: key() }), 409).code, "SLOT_UNAVAILABLE");
      assert.ok(state.reservations.some(r => r.appointment_id === blocked.id)); assert.equal(ctx.emails.length, emailCount + 1);
      assert.equal(ctx.emails.at(-1).appointments.find(r => r.id === first.id).schedule, moved, "Email must observe committed schedule");
      await booking(ctx, citizen(6)); // Released source slot is usable.
      ctx.setEmailFailure(true); ok(await change(ctx, first.id, "reschedule", { new_date: `${day(6)} 14:00:00` }));
      state = await ctx.snapshot(); assert.equal(state.appointments.find(r => r.id === first.id).preferred_date, `${day(6)} 14:00:00`);
    });
    await run("concurrent retries, changed payload and lookup-only recovery", async () => {
      const body = citizen(7), requestKey = key(), before = await ctx.snapshot();
      const result = await parallel(ctx, [0, 1].map(() => () => ctx.request("POST", "/api/appointments", { body, key: requestKey })));
      result.forEach(r => ok(r)); assert.equal(result[0].body.appointment_code, result[1].body.appointment_code); delta(before, await ctx.snapshot(), 1);
      assert.equal(ok(await ctx.request("POST", "/api/appointments", { body: { ...body, notes: "changed" }, key: requestKey }), 409).code, "IDEMPOTENCY_CONFLICT");
      const committed = await ctx.snapshot(); ok(await ctx.request("POST", "/api/appointments", { body, key: requestKey, recovery: true }));
      assert.equal(ok(await ctx.request("POST", "/api/appointments", { body, key: key(), recovery: true }), 404).code, "BOOKING_NOT_FOUND");
      assert.deepEqual(await ctx.snapshot(), committed);
    });
    await run("concurrent staff changes cannot overwrite the same expected revision", async () => {
      for (const [offset, actions] of [[17, ["accept", "reject"]], [18, ["cancel", "reschedule"]]]) {
        const created = await booking(ctx, citizen(offset)), expected = await ctx.expected(created.id);
        const result = await parallel(ctx, actions.map(action => () => ctx.request("PUT", `/api/appointments/${created.id}/${["accept", "reject"].includes(action) ? "decision" : action}`, {
          user: "clerk_admin", body: { ...expected, action, new_date: `${day(offset)} 11:00:00` }
        })));
        assert.deepEqual(result.map(r => r.status).sort(), [200, 409]); assert.equal(result.find(r => r.status === 409).body.code, "STALE_APPOINTMENT");
        const state = await ctx.snapshot(), row = state.appointments.find(r => r.id === created.id), slots = state.reservations.filter(r => r.appointment_id === created.id);
        assert.equal(Number(row.appointment_revision), 1); assert.equal(slots.length, ["rejected", "cancelled"].includes(row.status) ? 0 : 1);
      }
    });
    await run("real session/capability/CSRF checks, attribution, tracking and report feeds", async () => {
      const body = citizen(8), created = await booking(ctx, body), expected = await ctx.expected(created.id);
      ok(await ctx.request("GET", "/api/appointments/active"), 401);
      ok(await ctx.request("PUT", `/api/appointments/${created.id}/decision`, { user: "personnel", body: { ...expected, action: "accept" } }), 403);
      ok(await ctx.request("PUT", `/api/appointments/${created.id}/decision`, { user: "clerk_admin", csrf: false, body: { ...expected, action: "accept" } }), 403);
      const approved = ok(await change(ctx, created.id, "accept", { personnel_name: "FORGED" })); assert.equal(approved.data.assigned_to, "Staging Clerk");
      const active = ok(await ctx.request("GET", "/api/appointments/active", { user: "clerk_admin" })).appointments;
      assert.equal(active.find(r => r.id === created.id).assigned_to, "Staging Clerk");
      ok(await change(ctx, created.id, "cancel", {}, "super_admin"));
      const history = ok(await ctx.request("GET", "/api/appointments/history", { user: "clerk_admin" })).history;
      assert.equal(history.find(r => r.id === created.id).assigned_to, "Staging Clerk");
      const tracked = ok(await ctx.request("POST", "/api/appointments/check-status", { body: { appointment_code: created.appointment_code, contact: body.email } }));
      assert.equal(tracked.appointment.status, "cancelled"); assert.ok(!Object.hasOwn(tracked.appointment, "orientation_token"));
      ok(await ctx.request("GET", "/api/web-users/appointments/active", { user: "clerk_admin" }), 403); // No User Management expansion.
      ok(await ctx.request("GET", "/api/web-users/appointments/history", { user: "super_admin" }));
    });
    await run("booking notifications are committed and visible through their real API", async () => {
      const body = citizen(9), before = await ctx.snapshot(); await booking(ctx, body);
      const after = await ctx.snapshot(); delta(before, after, 1);
      const notices = ok(await ctx.request("GET", "/api/notifications", { user: "clerk_admin" })).notifications;
      assert.ok(notices.some(n => n.type === "appointment" && n.message.includes(body.full_name)));
    });
    await run("Philippine slot cutoffs, midnight and connection timezone restoration", async () => {
      let clock = new Date("2099-01-02T00:59:59Z");
      const service = new AppointmentSchedulingService(ctx.db, { enabled: () => true, now: () => clock });
      const body = { ...citizen(10), preferred_date: "2099-01-02 09:00:00" }, beforeLease = ctx.leases.length;
      const created = await service.book(body, key());
      const slot = (await ctx.snapshot()).reservations.find(r => r.appointment_id === created.id);
      assert.equal(slot.appointment_date, "2099-01-02"); assert.equal(slot.appointment_time, "09:00:00");
      clock = new Date("2099-01-02T01:00:00Z"); const before = await ctx.snapshot();
      await assert.rejects(service.book(body, key()), e => e.code === "PAST_SLOT"); assert.deepEqual(await ctx.snapshot(), before);
      assert.equal((await service.availability(body.purpose, "2099-01-02")).slots[0].status, "past");
      clock = new Date("2099-01-02T15:59:59Z"); assert.equal(policy.manilaNow(clock), "2099-01-02 23:59:59");
      clock = new Date("2099-01-02T16:00:00Z"); assert.equal(policy.manilaNow(clock), "2099-01-03 00:00:00");
      assert.ok((await service.availability(body.purpose, "2099-01-03")).slots.every(s => s.status === "available"));
      for (const lease of ctx.leases.slice(beforeLease).filter(l => l.events.includes("begin"))) {
        assert.equal(lease.restoredTimezone, lease.priorTimezone); assert.equal(lease.released, 1); assert.equal(lease.destroyed, 0);
      }
    });
    await run("HTTP active/history use the Philippine calendar date", async () => {
      const today = policy.manilaNow().slice(0, 10), date = new Date(today + "T00:00:00Z"); date.setUTCDate(date.getUTCDate() - 1);
      const yesterday = date.toISOString().slice(0, 10), ids = [];
      for (const [offset, target] of [[11, today], [12, yesterday]]) {
        const created = await booking(ctx, citizen(offset)); ok(await change(ctx, created.id, "accept")); ids.push(created.id);
        // Explicit synthetic calendar fixture, updated atomically across appointment/reservation.
        await ctx.query("UPDATE appointments a JOIN appointment_reservations r ON r.appointment_id = a.id SET a.preferred_date = ?, r.appointment_date = ? WHERE a.id = ?", [`${target} 10:00:00`, target, created.id]);
      }
      const active = ok(await ctx.request("GET", "/api/appointments/active", { user: "clerk_admin" })).appointments;
      const history = ok(await ctx.request("GET", "/api/appointments/history", { user: "clerk_admin" })).history;
      assert.ok(active.some(r => r.id === ids[0])); assert.ok(!active.some(r => r.id === ids[1])); assert.ok(history.some(r => r.id === ids[1]));
    });
    await run("real transaction rollback removes partial booking and allows original-key retry", async () => {
      const body = citizen(13), requestKey = key(), before = await ctx.snapshot(), index = ctx.leases.length;
      ctx.controls.failNotification = true; ok(await ctx.request("POST", "/api/appointments", { body, key: requestKey }), 503);
      assert.deepEqual(await ctx.snapshot(), before);
      const lease = ctx.leases.slice(index).find(l => l.events.includes("rollback-ack")); assert.ok(lease); assert.equal(lease.released, 1); assert.equal(lease.restoredTimezone, lease.priorTimezone);
      await booking(ctx, body, requestKey); delta(before, await ctx.snapshot(), 1);
    });
    await run("controlled lost commit acknowledgement recovers durable booking without duplicates", async () => {
      const body = citizen(14), requestKey = key(), before = await ctx.snapshot(), index = ctx.leases.length;
      ctx.controls.loseCommitAck = true;
      assert.equal(ok(await ctx.request("POST", "/api/appointments", { body, key: requestKey }), 503).code, "APPOINTMENT_UNAVAILABLE");
      const committed = await ctx.snapshot(); delta(before, committed, 1);
      const lease = ctx.leases.slice(index).find(l => l.events.includes("commit-ack-lost")); assert.ok(lease); assert.equal(lease.destroyed, 1); assert.equal(lease.released, 0);
      const recovered = ok(await ctx.request("POST", "/api/appointments", { body, key: requestKey, recovery: true })); assert.equal(recovered.idempotent, true);
      assert.equal(recovered.appointment_code, committed.appointments.at(-1).appointment_code); assert.deepEqual(await ctx.snapshot(), committed);
      // The real COMMIT was acknowledged to the adapter, then deliberately hidden from the service.
      // This is controlled acknowledgement-fault coverage, not a real network-failure claim.
    });
    await run("orientation QR, failed quiz, retake, completion and eligibility remain compatible", async () => {
      const created = await booking(ctx, citizen(15, "SWM Orientation & Clearance"));
      const approved = ok(await change(ctx, created.id, "accept")), token = approved.data.orientation_token;
      const qr = ok(await ctx.request("POST", `/api/appointments/${created.id}/generate-orientation-qr`, { user: "clerk_admin", body: {} })); assert.equal(qr.data.token, token);
      ok(await ctx.request("GET", `/api/appointments/orientation/verify/${encodeURIComponent(token)}`));
      const startedAt = policy.manilaNow();
      ok(await ctx.request("PUT", `/api/appointments/orientation/start/${encodeURIComponent(token)}`, { body: {} }));
      const row = (await ctx.snapshot()).appointments.find(r => r.id === created.id); assert.ok(row.orientation_started_at >= startedAt && row.orientation_started_at <= policy.manilaNow());
      assert.equal(ok(await change(ctx, created.id, "reschedule", { new_date: `${day(15)} 11:00:00` }), 409).code, "ORIENTATION_REVIEW_REQUIRED");
      const failed = ok(await ctx.request("PUT", `/api/appointments/orientation/complete/${encodeURIComponent(token)}`, { body: { score: 0, total_questions: 5, answers: Array(5).fill("wrong") } })); assert.equal(failed.certificate_eligible, false);
      ok(await ctx.request("POST", `/api/appointments/orientation/${created.id}/allow-retake`, { user: "super_admin", body: {} }));
      ok(await ctx.request("PUT", `/api/appointments/orientation/start/${encodeURIComponent(token)}`, { body: {} }));
      const passed = ok(await ctx.request("PUT", `/api/appointments/orientation/complete/${encodeURIComponent(token)}`, { body: { score: 5, total_questions: 5, answers: WEB_ORIENTATION_ANSWERS } })); assert.equal(passed.certificate_eligible, true);
      const after = (await ctx.snapshot()).appointments.find(r => r.id === created.id); assert.equal(after.status, "completed"); assert.equal(after.orientation_score, 5); assert.equal(after.orientation_token, token);
      ok(await change(ctx, created.id, "accept"), 409);
    });
    await run("flag-off and unready marker reject writes without changing booking tables", async () => {
      const before = await ctx.snapshot(), body = citizen(16);
      process.env.APPOINTMENT_RESERVATIONS_ENABLED = "false";
      try {
        ok(await ctx.request("POST", "/api/appointments", { body, key: key() }), 503);
        ok(await ctx.request("GET", `/api/appointments/availability?service=Accreditation&date=${day(16)}`), 503);
        const pending = before.appointments.find(r => r.status === "pending"); assert.ok(pending);
        ok(await change(ctx, pending.id, "cancel"), 503);
      } finally { process.env.APPOINTMENT_RESERVATIONS_ENABLED = "true"; }
      await ctx.query("UPDATE appointment_feature_state SET backfill_complete = 0 WHERE feature_key = 'service_slots'");
      try { ok(await ctx.request("POST", "/api/appointments", { body, key: key() }), 503); }
      finally { await ctx.query("UPDATE appointment_feature_state SET backfill_complete = 1 WHERE feature_key = 'service_slots'"); }
      assert.deepEqual(await ctx.snapshot(), before);
    });
  } finally { await ctx.close(); }
});
