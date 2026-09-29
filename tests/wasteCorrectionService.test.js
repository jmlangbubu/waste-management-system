const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { getWebCapabilities } = require("../config/webRoleCapabilities");
const { WasteCorrectionService } = require("../services/wasteCorrectionService");

const actors = {
  super_admin: { id: 1, role: "super_admin" },
  clerk_admin: { id: 2, role: "clerk_admin" },
  division_admin: { id: 3, role: "division_admin" },
  supervisor: { id: 4, role: "supervisor" },
  personnel: { id: 5, role: "personnel" },
  unknown: { id: 6, role: "unknown" }
};

function fixture() {
  const state = {
    record: {
      id: 11,
      validation_status: "Validated",
      biodegradable_subtotal: "100.00",
      recyclable_subtotal: "120.00",
      residual_subtotal: "80.00",
      special_subtotal: "20.00",
      grand_total: "320.00"
    },
    requests: [],
    audits: [],
    failAudit: false,
    failCancel: false,
    rollbacks: 0,
    commits: 0
  };
  const database = {
    async getConnection() {
      let before;
      return {
        async beginTransaction() { before = structuredClone({ record: state.record, requests: state.requests, audits: state.audits }); },
        async commit() { state.commits += 1; },
        async rollback() {
          state.record = before.record;
          state.requests = before.requests;
          state.audits = before.audits;
          state.rollbacks += 1;
        },
        release() {},
        async query(sql, params = []) { return runQuery(sql, params); }
      };
    },
    async query(sql, params = []) { return runQuery(sql, params); }
  };
  async function runQuery(sql, params) {
    const statement = sql.replace(/\s+/g, " ").trim();
    if (statement.startsWith("SELECT id, validation_status") && statement.includes("FROM validated_waste_records")) {
      return [[state.record && Number(params[0]) === state.record.id ? { ...state.record } : null].filter(Boolean)];
    }
    if (statement.startsWith("SELECT id FROM waste_record_correction_requests")) {
      return [state.requests.filter((request) => request.waste_record_id === Number(params[0]) &&
        ["pending", "approved"].includes(request.status)).slice(0, 1)];
    }
    if (statement.startsWith("INSERT INTO waste_record_correction_requests")) {
      const id = state.requests.length + 1;
      state.requests.push({
        id, waste_record_id: params[0], requested_by_user_id: params[1], requested_by_role: params[2],
        reason: params[3], original_values: params[4], proposed_values: params[5], status: "pending",
        reviewed_by_user_id: null, reviewed_by_role: null
      });
      return [{ insertId: id }];
    }
    if (statement.startsWith("SELECT id, requested_by_user_id, status FROM waste_record_correction_requests")) {
      return [state.requests.filter((request) => request.id === Number(params[0])).map((request) => ({ ...request }))];
    }
    if (statement.startsWith("UPDATE waste_record_correction_requests SET status = ?")) {
      Object.assign(state.requests.find((request) => request.id === Number(params[4])), {
        status: params[0], reviewed_by_user_id: params[1], reviewed_by_role: params[2], decision_reason: params[3]
      });
      return [{ affectedRows: 1 }];
    }
    if (statement.startsWith("UPDATE waste_record_correction_requests SET status = 'cancelled'")) {
      Object.assign(state.requests.find((request) => request.id === Number(params[3])), {
        status: "cancelled", cancelled_by_user_id: params[0],
        cancelled_by_role: params[1], cancel_reason: params[2], cancelled_at: "2026-09-29T12:00:00.000Z"
      });
      if (state.failCancel) throw new Error("simulated cancellation write failure");
      return [{ affectedRows: 1 }];
    }
    if (statement.startsWith("SELECT waste_record_id FROM waste_record_correction_requests")) {
      return [state.requests.filter((request) => request.id === Number(params[0]))
        .map((request) => ({ waste_record_id: request.waste_record_id }))];
    }
    if (statement.startsWith("SELECT * FROM waste_record_correction_requests")) {
      return [state.requests.filter((request) => request.id === Number(params[0])).map((request) => ({ ...request }))];
    }
    if (statement.startsWith("UPDATE validated_waste_records SET")) {
      for (const [index, field] of [
        "biodegradable_subtotal", "recyclable_subtotal", "residual_subtotal", "special_subtotal", "grand_total"
      ].entries()) state.record[field] = params[index];
      return [{ affectedRows: 1 }];
    }
    if (statement.startsWith("INSERT INTO waste_record_correction_audit")) {
      if (state.failAudit) throw new Error("simulated audit insert failure");
      state.audits.push({
        waste_record_id: params[0], correction_request_id: params[1],
        old_values: JSON.parse(params[2]), new_values: JSON.parse(params[3]),
        reason: params[4], requested_by_user_id: params[5], approved_by_user_id: params[6],
        applied_by_user_id: params[7], requested_by_role: params[8],
        approved_by_role: params[9], applied_by_role: params[10]
      });
      return [{ insertId: state.audits.length }];
    }
    if (statement.startsWith("UPDATE waste_record_correction_requests SET status = 'applied'")) {
      state.requests.find((request) => request.id === Number(params[2])).status = "applied";
      return [{ affectedRows: 1 }];
    }
    if (statement.includes("FROM waste_record_correction_requests c")) {
      const filtered = state.requests.filter((request) =>
        (!statement.includes("c.status = ?") || request.status === params[0]) &&
        (!statement.includes("c.waste_record_id = ?") || request.waste_record_id === Number(params.at(-1))));
      return [filtered.map((request) => ({ ...request, barangay_name: "Bula" }))];
    }
    if (statement.includes("FROM waste_record_correction_audit a")) {
      return [state.audits.filter((audit) => audit.waste_record_id === Number(params[0]))];
    }
    throw new Error(`Unexpected query: ${statement}`);
  }
  return { state, service: new WasteCorrectionService(database) };
}

const proposal = { reason: "Correct weighing transcription", proposedChanges: { biodegradable_subtotal: "110.00" } };
async function requestedAndApproved(f) {
  const request = await f.service.request(11, actors.clerk_admin, proposal);
  await f.service.review(request.id, actors.supervisor, { decision: "approve" });
  return request;
}

test("five-role capability matrix denies mutation to monitor-only, personnel, and unknown roles", () => {
  const expectations = {
    super_admin: [true, true, true, true],
    clerk_admin: [true, true, false, true],
    division_admin: [true, false, false, false],
    supervisor: [true, false, true, false],
    personnel: [false, false, false, false],
    unknown: [false, false, false, false]
  };
  for (const [role, allowed] of Object.entries(expectations)) {
    assert.deepEqual(["view", "request", "review", "apply"].map((action) =>
      getWebCapabilities(role).includes(`waste.correction.${action}`)), allowed, role);
  }
});

test("request stores server snapshots, requires reason and real allowed change, and ignores spoofed actor", async () => {
  const f = fixture();
  for (const body of [
    { ...proposal, reason: " " },
    { ...proposal, proposedChanges: { grand_total: "500.00" } },
    { ...proposal, grand_total: "500.00" },
    { ...proposal, proposedChanges: { validation_status: "Approved" } },
    { ...proposal, proposedChanges: { biodegradable_subtotal: "-1" } },
    { ...proposal, proposedChanges: { biodegradable_subtotal: "NaN" } },
    { ...proposal, proposedChanges: { biodegradable_subtotal: "100.00" } }
  ]) await assert.rejects(f.service.request(11, actors.clerk_admin, body), { statusCode: 400 });
  await assert.rejects(f.service.request(11, actors.supervisor, proposal), { statusCode: 403 });
  const created = await f.service.request(11, actors.clerk_admin, {
    ...proposal, requesterId: 999, requesterRole: "super_admin"
  });
  assert.equal(created.status, "pending");
  assert.equal(f.state.requests[0].requested_by_user_id, actors.clerk_admin.id);
  assert.equal(f.state.requests[0].requested_by_role, "clerk_admin");
  assert.equal(JSON.parse(f.state.requests[0].original_values).grand_total, "320.00");
  assert.equal(JSON.parse(f.state.requests[0].proposed_values).grand_total, "330.00");
  assert.equal(f.state.record.grand_total, "320.00");
});

test("DECIMAL(10,2) maximum subtotal and grand total can be requested and applied", async () => {
  const f = fixture();
  for (const field of ["biodegradable_subtotal", "recyclable_subtotal", "residual_subtotal", "special_subtotal", "grand_total"]) {
    f.state.record[field] = "0.00";
  }
  const request = await f.service.request(11, actors.clerk_admin, {
    reason: "Correct the measured amount",
    proposedChanges: { biodegradable_subtotal: "99999999.99" }
  });
  assert.equal(request.proposed_values.biodegradable_subtotal, "99999999.99");
  assert.equal(request.proposed_values.grand_total, "99999999.99");
  await f.service.review(request.id, actors.supervisor, { decision: "approve" });
  const applied = await f.service.apply(request.id, actors.clerk_admin, {});
  assert.equal(applied.applied_values.grand_total, "99999999.99");
  assert.equal(f.state.record.grand_total, "99999999.99");
  assert.equal(f.state.requests[0].status, "applied");
  assert.equal(f.state.audits[0].new_values.grand_total, "99999999.99");
});

test("DECIMAL(10,2) rejects a subtotal above 99999999.99", async () => {
  const f = fixture();
  await assert.rejects(f.service.request(11, actors.clerk_admin, {
    reason: "Out-of-range correction",
    proposedChanges: { biodegradable_subtotal: "100000000.00" }
  }), { statusCode: 400 });
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.state.record.grand_total, "320.00");
});

test("individually valid subtotals cannot create an overflowing grand total", async () => {
  const f = fixture();
  await assert.rejects(f.service.request(11, actors.clerk_admin, {
    reason: "Combined values exceed the column limit",
    proposedChanges: { biodegradable_subtotal: "50000000.00", recyclable_subtotal: "50000000.00" }
  }), { statusCode: 400, message: /grand total exceeds/ });
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.state.record.grand_total, "320.00");
  assert.equal(f.state.audits.length, 0);

  const approved = await requestedAndApproved(f);
  f.state.requests[0].proposed_values = JSON.stringify({
    ...JSON.parse(f.state.requests[0].proposed_values),
    biodegradable_subtotal: "50000000.00",
    recyclable_subtotal: "50000000.00",
    grand_total: "99999999.99"
  });
  await assert.rejects(f.service.apply(approved.id, actors.clerk_admin, {}),
    { statusCode: 400, message: /grand total exceeds/ });
  assert.equal(f.state.record.grand_total, "320.00");
  assert.equal(f.state.requests[0].status, "approved");
  assert.equal(f.state.audits.length, 0);
});

test("pending and approved requests block duplicates; rejected and applied history does not", async () => {
  const f = fixture();
  const first = await f.service.request(11, actors.clerk_admin, proposal);
  await assert.rejects(f.service.request(11, actors.clerk_admin, proposal), { statusCode: 409 });
  await f.service.review(first.id, actors.supervisor, { decision: "approve" });
  await assert.rejects(f.service.request(11, actors.clerk_admin, proposal), { statusCode: 409 });
  await f.service.apply(first.id, actors.clerk_admin, {});
  const second = await f.service.request(11, actors.clerk_admin, {
    reason: "Another correction", proposedChanges: { special_subtotal: "25.00" }
  });
  await f.service.review(second.id, actors.supervisor, { decision: "reject", decisionReason: "Not supported" });
  const third = await f.service.request(11, actors.clerk_admin, {
    reason: "Revised evidence", proposedChanges: { special_subtotal: "25.00" }
  });
  assert.equal(third.id, 3);
});

test("original requester cancels own pending and approved requests, preserving records and allowing replacement", async () => {
  const f = fixture();
  const pending = await f.service.request(11, actors.clerk_admin, proposal);
  const cancelledPending = await f.service.cancel(pending.id, actors.clerk_admin, { reason: "Wrong proposed value" });
  assert.equal(cancelledPending.status, "cancelled");
  assert.equal(f.state.requests[0].cancelled_by_user_id, actors.clerk_admin.id);
  assert.equal(f.state.requests[0].cancel_reason, "Wrong proposed value");
  assert.equal(f.state.record.grand_total, "320.00");
  assert.equal(f.state.audits.length, 0);
  assert.equal((await f.service.list({ status: "cancelled" }, actors.division_admin)).length, 1);
  const replacement = await f.service.request(11, actors.clerk_admin, proposal);
  await f.service.review(replacement.id, actors.supervisor, { decision: "approve" });
  await assert.rejects(f.service.request(11, actors.clerk_admin, proposal), { statusCode: 409 });
  await f.service.cancel(replacement.id, actors.clerk_admin, { reason: "Need to submit updated correction" });
  assert.equal(f.state.requests[1].status, "cancelled");
  await assert.rejects(f.service.apply(replacement.id, actors.clerk_admin, {}), { statusCode: 409 });
  const revised = await f.service.request(11, actors.clerk_admin, {
    reason: "Revised value", proposedChanges: { biodegradable_subtotal: "111.00" }
  });
  assert.equal(revised.id, 3);
  assert.equal(f.state.audits.length, 0);
});

test("unrelated Clerk and review-only or denied roles cannot cancel another request", async () => {
  const f = fixture();
  const request = await f.service.request(11, actors.clerk_admin, proposal);
  for (const actor of [
    { id: 22, role: "clerk_admin" }, actors.supervisor,
    actors.division_admin, actors.personnel, actors.unknown
  ]) {
    await assert.rejects(f.service.cancel(request.id, actor, { reason: "Not permitted" }), { statusCode: 403 });
  }
  assert.equal(f.state.requests[0].status, "pending");
});

test("Super Admin may cancel another request while pending or approved", async () => {
  const f = fixture();
  const pending = await f.service.request(11, actors.clerk_admin, proposal);
  await f.service.cancel(pending.id, actors.super_admin, { reason: "Duplicate request" });
  assert.equal(f.state.requests[0].cancelled_by_user_id, actors.super_admin.id);
  const approved = await requestedAndApproved(f);
  await f.service.cancel(approved.id, actors.super_admin, { reason: "Request no longer needed" });
  assert.equal(f.state.requests[1].status, "cancelled");
  assert.equal(f.state.audits.length, 0);
});

test("cancellation requires a reason and ignores or rejects client actor/status fields", async () => {
  const f = fixture();
  const request = await f.service.request(11, actors.clerk_admin, proposal);
  for (const body of [
    {}, { reason: " " }, { reason: "Withdraw", userId: actors.super_admin.id },
    { reason: "Withdraw", role: "super_admin" },
    { reason: "Withdraw", status: "cancelled" },
    { reason: "Withdraw", proposedChanges: { biodegradable_subtotal: "500.00" } }
  ]) await assert.rejects(f.service.cancel(request.id, actors.clerk_admin, body), { statusCode: 400 });
  assert.equal(f.state.requests[0].status, "pending");
  await f.service.cancel(request.id, actors.clerk_admin, { reason: "Withdraw" });
  assert.equal(f.state.requests[0].cancelled_by_user_id, actors.clerk_admin.id);
  assert.equal(f.state.requests[0].cancelled_by_role, "clerk_admin");
});

test("rejected, applied, and already cancelled requests cannot transition to cancelled", async () => {
  const f = fixture();
  const first = await f.service.request(11, actors.clerk_admin, proposal);
  await f.service.review(first.id, actors.supervisor, { decision: "reject", decisionReason: "Invalid evidence" });
  await assert.rejects(f.service.cancel(first.id, actors.clerk_admin, { reason: "Too late" }), { statusCode: 409 });
  const second = await requestedAndApproved(f);
  await f.service.apply(second.id, actors.clerk_admin, {});
  await assert.rejects(f.service.cancel(second.id, actors.super_admin, { reason: "Too late" }), { statusCode: 409 });
  const third = await f.service.request(11, actors.clerk_admin, {
    reason: "Further correction", proposedChanges: { residual_subtotal: "85.00" }
  });
  await f.service.cancel(third.id, actors.clerk_admin, { reason: "Withdraw" });
  await assert.rejects(f.service.cancel(third.id, actors.clerk_admin, { reason: "Again" }), { statusCode: 409 });
  await assert.rejects(f.service.review(third.id, actors.supervisor, { decision: "approve" }), { statusCode: 409 });
});

test("cancellation write failure rolls back its status and actor metadata", async () => {
  const f = fixture();
  const request = await f.service.request(11, actors.clerk_admin, proposal);
  f.state.failCancel = true;
  await assert.rejects(f.service.cancel(request.id, actors.clerk_admin, { reason: "Wrong value" }),
    /simulated cancellation write failure/);
  assert.equal(f.state.requests[0].status, "pending");
  assert.equal(f.state.requests[0].cancelled_by_user_id, undefined);
  assert.ok(f.state.rollbacks > 0);
});

test("review requires Supervisor capability, reason for rejection, pending status, and a different reviewer", async () => {
  const f = fixture();
  const first = await f.service.request(11, actors.clerk_admin, proposal);
  await assert.rejects(f.service.review(first.id, actors.clerk_admin, { decision: "approve" }), { statusCode: 403 });
  await assert.rejects(f.service.review(first.id, actors.supervisor, { decision: "reject" }), { statusCode: 400 });
  await f.service.review(first.id, actors.supervisor, { decision: "reject", decisionReason: "Evidence insufficient" });
  assert.equal(f.state.requests[0].status, "rejected");
  await assert.rejects(f.service.review(first.id, actors.supervisor, { decision: "approve" }), { statusCode: 409 });
  const second = await f.service.request(11, actors.super_admin, {
    reason: "Admin correction", proposedChanges: { residual_subtotal: "90.00" }
  });
  await assert.rejects(f.service.review(second.id, actors.super_admin, { decision: "approve" }), { statusCode: 403 });
  await f.service.review(second.id, actors.supervisor, { decision: "approve" });
  assert.equal(f.state.requests[1].status, "approved");
});

test("apply uses only stored approved values, recalculates total, audits, and cannot run twice", async () => {
  const f = fixture();
  const request = await requestedAndApproved(f);
  await assert.rejects(f.service.apply(request.id, actors.supervisor, {}), { statusCode: 403 });
  await assert.rejects(f.service.apply(request.id, actors.clerk_admin, { proposedChanges: { biodegradable_subtotal: "500.00" } }), { statusCode: 400 });
  await assert.rejects(f.service.apply(request.id, actors.clerk_admin, { grand_total: "500.00" }), { statusCode: 400 });
  const applied = await f.service.apply(request.id, actors.clerk_admin, {});
  assert.equal(applied.status, "applied");
  assert.equal(f.state.record.biodegradable_subtotal, "110.00");
  assert.equal(f.state.record.grand_total, "330.00");
  assert.equal(f.state.requests[0].status, "applied");
  assert.equal(f.state.audits.length, 1);
  assert.equal(f.state.audits[0].old_values.grand_total, "320.00");
  assert.equal(f.state.audits[0].new_values.grand_total, "330.00");
  assert.equal(f.state.audits[0].approved_by_user_id, actors.supervisor.id);
  await assert.rejects(f.service.apply(request.id, actors.clerk_admin, {}), { statusCode: 409 });
  assert.equal(f.state.audits.length, 1);
});

test("pending and rejected requests cannot apply", async () => {
  const f = fixture();
  const request = await f.service.request(11, actors.clerk_admin, proposal);
  await assert.rejects(f.service.apply(request.id, actors.clerk_admin, {}), { statusCode: 409 });
  await f.service.review(request.id, actors.supervisor, { decision: "reject", decisionReason: "Incorrect" });
  await assert.rejects(f.service.apply(request.id, actors.clerk_admin, {}), { statusCode: 409 });
});

test("stale record values reject apply without overwriting new official data", async () => {
  const f = fixture();
  const request = await requestedAndApproved(f);
  f.state.record.recyclable_subtotal = "121.00";
  await assert.rejects(f.service.apply(request.id, actors.clerk_admin, {}), { statusCode: 409, code: "WASTE_CORRECTION_STALE" });
  assert.equal(f.state.record.recyclable_subtotal, "121.00");
  assert.equal(f.state.audits.length, 0);
  assert.equal(f.state.requests[0].status, "approved");
});

test("audit insertion failure rolls back record and request state atomically", async () => {
  const f = fixture();
  const request = await requestedAndApproved(f);
  f.state.failAudit = true;
  await assert.rejects(f.service.apply(request.id, actors.clerk_admin, {}), /simulated audit insert failure/);
  assert.equal(f.state.record.biodegradable_subtotal, "100.00");
  assert.equal(f.state.record.grand_total, "320.00");
  assert.equal(f.state.requests[0].status, "approved");
  assert.equal(f.state.audits.length, 0);
  assert.ok(f.state.rollbacks > 0);
});

test("monitoring read APIs allow division and deny personnel; routes keep mobile path untouched", async () => {
  const f = fixture();
  await f.service.request(11, actors.clerk_admin, proposal);
  assert.equal((await f.service.list({ recordId: 11 }, actors.division_admin)).length, 1);
  assert.equal((await f.service.history(11, actors.division_admin)).length, 0);
  await assert.rejects(f.service.list({}, actors.personnel), { statusCode: 403 });
  await assert.rejects(f.service.history(11, actors.personnel), { statusCode: 403 });
  const routes = fs.readFileSync(path.join(__dirname, "../routes/wasteRoutes.js"), "utf8");
  assert.match(routes, /router\.post\("\/web\/validated-records\/:id\/correction-requests", requireWebCapability\("waste\.correction\.request"\), requireCsrf/);
  assert.match(routes, /router\.patch\("\/web\/correction-requests\/:requestId\/review", requireWebCapability\("waste\.correction\.review"\), requireCsrf/);
  assert.match(routes, /router\.post\("\/web\/correction-requests\/:requestId\/apply", requireWebCapability\("waste\.correction\.apply"\), requireCsrf/);
  assert.match(routes, /router\.post\("\/web\/correction-requests\/:requestId\/cancel", requireWebCapability\("waste\.correction\.request"\), requireCsrf/);
  assert.match(routes, /router\.get\("\/validated-records", wasteController\.getValidatedWasteRecords\)/);
  assert.match(routes, /router\.post\("\/validated-records", wasteController\.createValidatedWasteRecord\)/);
});
