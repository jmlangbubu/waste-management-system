const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ComplaintWorkflowService, REQUIRED_COLUMNS } = require("../services/complaintWorkflowService");

// Source extraction deliberately excludes router bootstrap, preparation DDL,
// notification storage helpers and timer startup. No real DB or HTTP imports.
// SQL is interpreted by a narrow mock below, NOT validated against MySQL.
const source = fs.readFileSync(path.join(__dirname, "../routes/complaintRoutes.js"), "utf8");
const schedulerSource = source.slice(source.indexOf("function getOverdueAcceptedStatusCondition("),
  source.indexOf("/*\r\n  Backward-compatible alias.") >= 0
    ? source.indexOf("/*\r\n  Backward-compatible alias.")
    : source.indexOf("/*\n  Backward-compatible alias."));
assert.ok(schedulerSource.includes("async function markOverdueAcceptedComplaints("));
const querySource = source.slice(source.indexOf("function dbQueryAsync("),
  source.indexOf("function insertWmoComplaintNotificationAsync("));
const now = Date.parse("2026-10-18T12:00:00Z");
const atAge = hours => new Date(now - hours * 3600000).toISOString().slice(0, 19).replace("T", " ");
const actor = { id: 7, kind: "barangay", barangay: "Synthetic Barangay" };
const zeroDate = "0000-00-00 00:00:00";

function fixture(overrides = {}, { missingColumns = [] } = {}) {
  const row = { id: 11, subject: "Synthetic complaint", status: "in_progress",
    assigned_barangay: actor.barangay, handled_by_barangay_name: null,
    accepted_at: atAge(30), accepted_by: actor.id, assignment_confirmed_at: atAge(31),
    assignment_confirmed_by: 3, handling_owner: "barangay", accepted_overdue_at: null,
    ...overrides };
  const state = { row, sql: [], notices: [], phase1Notices: [], preparationCalls: 0,
    beforeUpdate: null, schemaError: false, commits: 0, rollbacks: 0 };
  const columns = [...new Set([...REQUIRED_COLUMNS, "id", "status", "accepted_at", "accepted_overdue_at"])]
    .filter(name => !missingColumns.includes(name));
  function eligible(current, sql) {
    assert.match(sql, /status IN \('accepted_by_barangay', 'in_progress'\)/);
    assert.match(sql, /<= DATE_SUB\(NOW\(\), INTERVAL 24 HOUR\)/);
    assert.match(sql, /accepted_overdue_at IS NULL/);
    const hasGuard = sql.includes("AND NOT (status = 'in_progress'");
    if (hasGuard) {
      assert.match(sql, /AND NOT \(status = 'in_progress' AND assignment_confirmed_at IS NOT NULL AND COALESCE\(handling_owner, ''\) = 'barangay'\)/);
      assert.ok(columns.includes("assignment_confirmed_at") && columns.includes("handling_owner"));
      if (current.status === "in_progress" && current.assignment_confirmed_at != null
        && (current.handling_owner ?? "") === "barangay") return false;
    }
    const time = Date.parse(String(current.accepted_at).replace(" ", "T") + "Z");
    return ["accepted_by_barangay", "in_progress"].includes(current.status)
      && Number.isFinite(time) && time <= now - 24 * 3600000
      && (current.accepted_overdue_at == null || current.accepted_overdue_at === zeroDate);
  }
  function resultFor(sql, params) {
    if (sql === "SHOW COLUMNS FROM complaints") {
      if (state.schemaError) throw new Error("Synthetic metadata unavailable");
      return columns.map(Field => ({ Field }));
    }
    if (sql.startsWith("SELECT * FROM complaints WHERE id = ? FOR UPDATE")) return [structuredClone(row)];
    if (sql.startsWith("SELECT DISTINCT target_name")) return [{ target_name: actor.barangay }];
    if (sql.startsWith("SELECT") && sql.includes("FROM complaints")) {
      assert.match(sql, /ORDER BY accepted_at ASC LIMIT 25$/);
      return eligible(row, sql) ? [structuredClone(row)] : [];
    }
    if (sql.startsWith("UPDATE complaints SET status = 'accepted_overdue'")) {
      assert.match(sql, /AND assigned_barangay <=> \? AND handled_by_barangay_name <=> \?/);
      assert.equal(params[1], row.id);
      const sameAssignment = (row.assigned_barangay ?? null) === params[2]
        && (row.handled_by_barangay_name ?? null) === params[3];
      if (!sameAssignment || !eligible(row, sql)) return { affectedRows: 0 };
      Object.assign(row, { status: "accepted_overdue", accepted_overdue_reason: params[0], accepted_overdue_at: atAge(0) });
      return { affectedRows: 1 };
    }
    if (sql.startsWith("UPDATE complaints SET status = 'resolved'")) {
      Object.assign(row, { status: "resolved", resolution_report: params[0], resolution_evidence_url: params[1],
        resolved_by: params[2], wmo_resolved_by: params[3], handled_by_barangay_name: params[4],
        resolver_latitude: params[5], resolver_longitude: params[6] });
      return { affectedRows: 1 };
    }
    if (sql.startsWith("UPDATE complaints SET status = 'in_progress'")) {
      assert.equal(row.status, "forwarded");
      Object.assign(row, { status: "in_progress", handling_owner: "barangay", accepted_by: params[0], accepted_at: atAge(0) });
      return { affectedRows: 1 };
    }
    if (sql.startsWith("INSERT INTO complaint_notifications")) {
      state.phase1Notices.push([...params]);
      return { affectedRows: 1 };
    }
    throw new Error(`Unexpected mock SQL: ${sql}`);
  }
  const query = (sql, params, done) => {
    if (typeof params === "function") { done = params; params = []; }
    sql = sql.replace(/\s+/g, " ").trim();
    state.sql.push(sql);
    assert.doesNotMatch(sql, /^(ALTER|CREATE|DROP|DELETE)\b/i);
    const hook = sql.startsWith("UPDATE complaints SET status = 'accepted_overdue'") ? state.beforeUpdate : null;
    if (hook) state.beforeUpdate = null;
    Promise.resolve().then(() => hook?.()).then(() => resultFor(sql, params || []))
      .then(result => done(null, result), done);
  };
  const db = { query, queryReadOnly: query, isReadOnlyQuery: sql => /^\s*(SELECT|SHOW)\b/i.test(sql),
    getConnection(done) { done(null, { query,
      beginTransaction(cb) { cb(null); }, commit(cb) { state.commits++; cb(null); },
      rollback(cb) { state.rollbacks++; cb(null); }, release() {} }); } };
  const notice = type => async (...args) => { state.notices.push({ type, args }); return true; };
  const context = vm.createContext({ db,
    prepareAcceptedComplaintDeadlineData: async () => { state.preparationCalls++; },
    normalizeBarangayName: value => String(value || "").trim(),
    truncateNotificationText: (value, length) => String(value).slice(0, length),
    createAcceptedOverdueExplanationRequestAsync: notice("explanation"),
    insertWmoComplaintNotificationAsync: notice("wmo"),
    insertBarangayInfoNotificationsAsync: notice("barangay"),
    emitWmoRealtime() { assert.fail("Unexpected realtime call"); },
    emitBarangayRealtime() { assert.fail("Unexpected realtime call"); },
    console: { error(...args) { assert.fail(`Unexpected worker error: ${args[0]}`); } },
    setTimeout() { assert.fail("No timers allowed"); }, setInterval() { assert.fail("No timers allowed"); }
  });
  vm.runInContext(querySource + schedulerSource, context, { filename: "extracted-complaint-scheduler.js" });
  return { state, service: new ComplaintWorkflowService(db),
    run: () => vm.runInContext("markOverdueAcceptedComplaints()", context) };
}

async function resolveWithRealService(f) {
  const result = await f.service.resolve(11, actor, { resolution_report: "Synthetic resolution",
    resolver_latitude: 1.25, resolver_longitude: 1.75 }, async () => "/synthetic/evidence.jpg");
  assert.equal(result.status, "resolved");
  assert.equal(f.state.row.resolved_by, actor.id);
  assert.equal(f.state.row.resolution_evidence_url, "/synthetic/evidence.jpg");
  assert.equal(f.state.row.resolver_latitude, 1.25);
}

for (const hours of [2, 30]) {
  test(`confirmed Phase 1 in_progress at ${hours}h stays resolvable via actual service`, async () => {
    const f = fixture({ accepted_at: atAge(hours) });
    const result = await f.run();
    assert.equal(result.processed, 0);
    assert.equal(result.count, 0);
    assert.equal(f.state.row.status, "in_progress");
    assert.equal(f.state.row.accepted_overdue_at, null);
    assert.equal(f.state.notices.length, 0);
    await resolveWithRealService(f);
  });
}

test("legacy accepted_by_barangay retains overdue marking and existing notice types", async () => {
  const f = fixture({ status: "accepted_by_barangay", assignment_confirmed_at: null, handling_owner: null });
  const result = await f.run();
  assert.equal(result.processed, 1);
  assert.equal(f.state.row.status, "accepted_overdue");
  assert.equal(f.state.row.accepted_overdue_at, atAge(0));
  assert.match(f.state.row.accepted_overdue_reason, /within 24 hours/);
  assert.deepEqual(f.state.notices.map(n => n.type), ["explanation", "wmo", "barangay"]);
  assert.equal(f.state.notices[1].args[1], "accepted_complaint_overdue");
  assert.equal(f.state.notices[2].args[2], "accepted_overdue_explanation_request");
  await assert.rejects(f.service.resolve(11, actor, { resolution_report: "Not authorized" }, async () => "image"),
    error => error.code === "ASSIGNMENT_REVIEW_REQUIRED");
});

for (const overrides of [{ assignment_confirmed_at: null },
  { assignment_confirmed_at: null, handling_owner: null }, { handling_owner: null }]) {
  test(`historical in_progress retains legacy behavior: ${JSON.stringify(overrides)}`, async () => {
    const f = fixture(overrides);
    assert.equal((await f.run()).processed, 1);
    assert.equal(f.state.row.status, "accepted_overdue");
    assert.equal(f.state.notices.length, 3);
    await assert.rejects(f.service.resolve(11, actor, { resolution_report: "No implicit grant" }, async () => "image"),
      error => ["ASSIGNMENT_REVIEW_REQUIRED", "ACCEPT_REQUIRED"].includes(error.code));
  });
}

for (const status of ["resolved", "rejected", "pending", "forwarded", "wmo_handling", "accepted_overdue"]) {
  test(`${status} is not mutated or notified by scheduler`, async () => {
    const f = fixture({ status });
    const before = structuredClone(f.state.row);
    assert.equal((await f.run()).processed, 0);
    assert.deepEqual(f.state.row, before);
    assert.equal(f.state.notices.length, 0);
  });
}

test("legacy repeated scans do not duplicate notices after a successful status update", async () => {
  const f = fixture({ status: "accepted_by_barangay", assignment_confirmed_at: null });
  assert.equal((await f.run()).processed, 1);
  assert.equal((await f.run()).processed, 0);
  assert.equal(f.state.notices.length, 3);
});

test("confirmed repeated scans retain in_progress and emit no overdue notices", async () => {
  const f = fixture();
  await f.run(); await f.run();
  assert.equal(f.state.row.status, "in_progress");
  assert.equal(f.state.notices.length, 0);
});

for (const missingColumns of [["assignment_confirmed_at", "handling_owner"],
  ["assignment_confirmed_at"], ["handling_owner"]]) {
  test(`legacy schema without ${missingColumns.join("/")} uses no absent-column SQL`, async () => {
    const f = fixture({ assignment_confirmed_at: null, handling_owner: null }, { missingColumns });
    assert.equal((await f.run()).processed, 1);
    const statements = f.state.sql.filter(sql => sql.includes("status IN"));
    for (const sql of statements) assert.doesNotMatch(sql, /assignment_confirmed_at|handling_owner/);
    await assert.rejects(f.service.decide(11, actor, "accept"), error => error.statusCode === 503);
  });
}

test("confirmation/Barangay ownership appearing after SELECT is protected by UPDATE predicate", async () => {
  const f = fixture({ assignment_confirmed_at: null, handling_owner: null });
  f.state.beforeUpdate = () => Object.assign(f.state.row, { assignment_confirmed_at: atAge(31), handling_owner: "barangay" });
  assert.equal((await f.run()).processed, 0);
  assert.equal(f.state.row.status, "in_progress");
  assert.equal(f.state.notices.length, 0);
  await resolveWithRealService(f);
});

test("real Phase 1 acceptance between scan and UPDATE is not overwritten", async () => {
  const f = fixture({ assignment_confirmed_at: null, handling_owner: null });
  f.state.beforeUpdate = async () => {
    Object.assign(f.state.row, { status: "forwarded", accepted_at: null, assignment_confirmed_at: atAge(0), handling_owner: "barangay" });
    assert.equal((await f.service.decide(11, actor, "accept")).status, "in_progress");
  };
  assert.equal((await f.run()).processed, 0);
  assert.equal(f.state.row.status, "in_progress");
  assert.equal(f.state.notices.length, 0);
  await resolveWithRealService(f);
});

test("real Phase 1 resolution between scan and UPDATE is not overwritten", async () => {
  const f = fixture({ assignment_confirmed_at: null, handling_owner: null });
  f.state.beforeUpdate = async () => {
    Object.assign(f.state.row, { assignment_confirmed_at: atAge(31), handling_owner: "barangay" });
    await resolveWithRealService(f);
  };
  assert.equal((await f.run()).processed, 0);
  assert.equal(f.state.row.status, "resolved");
  assert.equal(f.state.notices.length, 0);
});

for (const field of ["assigned_barangay", "handled_by_barangay_name"]) {
  test(`concurrent ${field} change fences stale notification/overdue UPDATE`, async () => {
    const f = fixture({ assignment_confirmed_at: null, handling_owner: null });
    f.state.beforeUpdate = () => { f.state.row[field] = "Different Synthetic Barangay"; };
    assert.equal((await f.run()).processed, 0);
    assert.equal(f.state.row.status, "in_progress");
    assert.equal(f.state.notices.length, 0);
  });
}

test("missing/invalid accepted clock stays excluded; exactly 24h retains legacy threshold", async () => {
  for (const accepted_at of [null, zeroDate, "not-a-date", atAge(23.99)]) {
    const f = fixture({ accepted_at, assignment_confirmed_at: null });
    assert.equal((await f.run()).processed, 0);
  }
  const f = fixture({ accepted_at: atAge(24), assignment_confirmed_at: null });
  assert.equal((await f.run()).processed, 1);
});

test("metadata lookup failure stops the scan rather than falling back to unguarded UPDATE", async () => {
  const f = fixture(); f.state.schemaError = true;
  await assert.rejects(f.run(), /Synthetic metadata unavailable/);
  assert.equal(f.state.row.status, "in_progress");
  assert.equal(f.state.notices.length, 0);
  assert.equal(f.state.sql.some(sql => sql.startsWith("UPDATE")), false);
});
