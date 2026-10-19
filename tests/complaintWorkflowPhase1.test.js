const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ComplaintWorkflowService, REQUIRED_COLUMNS } = require("../services/complaintWorkflowService");
const { resolveStrictBarangay } = require("../services/barangayBoundaryService");
const { resolveComplaintMapDestination } = require("../services/complaintMapDestinationService");
const root = path.join(__dirname, "..");
// Abstract squares are offline geometry fixtures, NOT real Bula/GenSan coordinates or boundaries.
const square = (name = "Fixture A", offset = 0) => ({ barangay_name: name,
  polygon_json: { type: "Polygon", coordinates: [[[offset, 0], [offset + 2, 0], [offset + 2, 2], [offset, 2], [offset, 0]]] } });
const actor = { id: 7, kind: "barangay", barangay: "Fixture A" };
const admin = { id: 3, kind: "admin" };
const forwardBody = { selected_barangay: "Fixture A", confirm_assignment: true, assignment_confirmation_reason: "Admin verified recipient manually." };

function fixture({ pending = false, missingColumn = false, failNotice = false } = {}) {
  const state = { complaint: { id: 11, citizen_id: 99, subject: "Synthetic concern", status: pending ? "pending" : "forwarded",
    assigned_barangay: pending ? "For Verification" : "Fixture A", latitude: 1, longitude: 1,
    assignment_confirmed_at: pending ? null : "2026-10-18", assignment_confirmed_by: pending ? null : 3,
    handling_owner: pending ? null : "barangay", image_url: "/synthetic/original.jpg" },
    notifications: pending ? [] : [{ target_type: "barangay", target_name: "Fixture A" }],
    user: { id: 7, role: "barangay", mobile_role: "barangay", status: "active", barangay: "Fixture A", assigned_source_name: "Fixture A" },
    boundaries: [square(), square("Fixture B", 4)], calls: [], commits: 0, rollbacks: 0 };
  let tail = Promise.resolve();
  const runQuery = (sql, params = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    state.calls.push(text);
    assert.doesNotMatch(text, /^(ALTER|CREATE|DROP|DELETE)\b/i);
    if (text === "SHOW COLUMNS FROM complaints") return (missingColumn ? [] : REQUIRED_COLUMNS).map(Field => ({ Field }));
    if (text.includes("FROM barangay_boundaries")) return state.boundaries;
    if (text.includes("FROM users WHERE id")) return Number(params[0]) === state.user.id ? [state.user] : [];
    if (text.includes("SELECT * FROM complaints")) return Number(params[0]) === 11 ? [structuredClone(state.complaint)] : [];
    if (text.startsWith("SELECT DISTINCT target_name")) return [...new Set(state.notifications.filter(n => n.target_type === "barangay").map(n => n.target_name))].map(target_name => ({ target_name }));
    if (text.startsWith("INSERT INTO complaint_notifications")) {
      if (failNotice) throw new Error("Synthetic notification write failed");
      state.notifications.push({ complaint_id: params[0], target_type: params[1], target_name: params[2], notification_type: params[3], message: params[5] });
      return { insertId: state.notifications.length, affectedRows: 1 };
    }
    if (text.startsWith("UPDATE complaints")) {
      const c = state.complaint;
      if (text.includes("SET status = 'forwarded'")) {
        Object.assign(c, { status: "forwarded", assigned_barangay: params[0], validated_by: params[1],
          assignment_confirmed_by: params[2], assignment_confirmed_at: "now", assignment_confirmation_reason: params[3], handling_owner: "barangay" });
      } else if (text.includes("status = 'wmo_handling'")) {
        Object.assign(c, { status: "wmo_handling", handling_owner: "wmo", barangay_decline_reason: params[0], barangay_declined_by: params[1], barangay_declined_at: "now" });
      } else if (text.includes("status = 'in_progress'")) {
        Object.assign(c, { status: "in_progress", accepted_by: params[0], accepted_at: "now", in_progress_at: "now", handling_owner: "barangay" });
      } else if (text.includes("status = 'resolved'")) {
        Object.assign(c, { status: "resolved", resolution_report: params[0], resolution_evidence_url: params[1],
          resolved_by: params[2], wmo_resolved_by: params[3], handled_by_barangay_name: params[4],
          resolver_latitude: params[5], resolver_longitude: params[6] });
      } else throw new Error(`Unhandled update: ${text}`);
      return { affectedRows: 1 };
    }
    throw new Error(`Unexpected database call: ${text}`);
  };
  const query = (sql, values, callback) => {
    if (typeof values === "function") { callback = values; values = []; }
    try { callback(null, runQuery(sql, values)); } catch (error) { callback(error); }
  };
  const db = { query, getConnection(callback) {
    let unlock, before;
    callback(null, { query, beginTransaction(done) {
      const previous = tail; tail = new Promise(resolve => { unlock = resolve; });
      previous.then(() => { before = structuredClone({ complaint: state.complaint, notifications: state.notifications }); done(null); });
    }, commit(done) { state.commits++; done(null); }, rollback(done) {
      state.rollbacks++; state.complaint = before.complaint; state.notifications = before.notifications; done(null);
    }, release() { unlock(); } });
  } };
  return { service: new ComplaintWorkflowService(db), state };
}
const rejects = (promise, statusCode, code) => assert.rejects(promise, error => error.statusCode === statusCode && (!code || error.code === code));

test("strict single polygon gives one candidate; overlap, edge, unknown, malformed and missing coverage do not", () => {
  assert.equal(resolveStrictBarangay({ lat: 1, lng: 1 }, [square()]).barangay, "Fixture A");
  for (const [point, rows] of [[{ lat: 1, lng: 1 }, [square(), square("Fixture B", .5)]],
    [{ lat: 0, lng: 1 }, [square()]], [{ lat: 20, lng: 20 }, [square()]], [{ lat: 1, lng: 1 }, []],
    [{ lat: NaN, lng: 1 }, [square()]], [{ lat: "", lng: 1 }, [square()]], [{ lat: 1, lng: 1 }, [{ polygon_json: "bad" }]]]) {
    assert.equal(resolveStrictBarangay(point, rows).barangay, null);
  }
});
test("GeoJSON holes and MultiPolygon are handled without nearest/area guesses", () => {
  const geometry = square().polygon_json;
  geometry.coordinates.push([[.5, .5], [1.5, .5], [1.5, 1.5], [.5, 1.5], [.5, .5]]);
  assert.equal(resolveStrictBarangay({ lat: 1, lng: 1 }, [{ barangay_name: "Fixture A", polygon_json: geometry }]).barangay, null);
  assert.equal(resolveStrictBarangay({ lat: 1, lng: 1 }, [{ barangay_name: "Fixture A", polygon_json:
    { type: "MultiPolygon", coordinates: [square().polygon_json.coordinates] } }]).barangay, "Fixture A");
});
test("server-owned active Barangay account is used; missing/conflicting assignments fail closed", async () => {
  const { service, state } = fixture();
  assert.equal((await service.barangayActor(7)).barangay, "Fixture A");
  state.user.assigned_source_name = "Fixture B";
  await rejects(service.barangayActor(7), 403);
  state.user.assigned_source_name = "Fixture A"; state.user.role = "citizen";
  await rejects(service.barangayActor(7), 403);
  state.user.role = "barangay"; state.user.status = "inactive";
  await rejects(service.barangayActor(7), 403);
});
test("Admin confirms one recipient; one notice and evidence/GPS retained", async () => {
  const { service, state } = fixture({ pending: true });
  const result = await service.forward(11, admin, forwardBody);
  assert.equal(result.assigned_barangay, "Fixture A"); assert.equal(state.notifications.length, 1);
  assert.equal(state.complaint.image_url, "/synthetic/original.jpg"); assert.equal(state.complaint.latitude, 1);
  await service.forward(11, admin, forwardBody); assert.equal(state.notifications.length, 1);
  // Reload through the map's read model after the real forwarding transaction.
  const readDb = { query(sql, params, callback) {
    assert.match(sql.trim(), /^SELECT/);
    callback(null, sql.includes("FROM complaints") ? [structuredClone(state.complaint)]
      : sql.includes("FROM complaint_notifications") ? state.notifications.filter(row => row.target_type === "barangay")
        .map(row => ({ target_name: row.target_name }))
      : [{ barangay_name: "Fixture A", reference_name: "Synthetic reference", latitude: 1.4, longitude: 1.6 }]);
  } };
  const reloaded = await resolveComplaintMapDestination(readDb, 11);
  assert.equal(reloaded.basis, "admin_confirmed");
  assert.equal(reloaded.assigned_barangay, "Fixture A");
  assert.equal(reloaded.destination.barangay_name, "Fixture A");
});
test("ambiguous/no geometry still requires explicit Admin confirmation and reason", async () => {
  const { service, state } = fixture({ pending: true });
  state.boundaries = [square(), square("Fixture B", .5)];
  await rejects(service.forward(11, admin, { selected_barangay: "Fixture A" }), 400);
  const result = await service.forward(11, admin, forwardBody);
  assert.equal(result.geographic_candidate, null); assert.equal(result.assigned_barangay, "Fixture A");
});

test("GPS forwarding recomputes the stored point and generates accurate server audit text", async () => {
  const {service,state} = fixture({pending:true});
  const result = await service.forward(11, admin, {selected_barangay:"Fixture A",confirm_assignment:true,use_gps_match:true,
    assignment_confirmation_reason:"Spoofed independently verified claim"});
  assert.equal(result.assigned_barangay,"Fixture A");
  assert.equal(state.complaint.assignment_confirmed_by,admin.id);
  assert.match(state.complaint.assignment_confirmation_reason,/stored citizen GPS/);
  assert.match(state.complaint.assignment_confirmation_reason,/not been independently verified/);
  assert.doesNotMatch(state.complaint.assignment_confirmation_reason,/Spoofed/);
  assert.equal(state.complaint.latitude,1); assert.equal(state.notifications.length,1);
  const reloaded = await resolveComplaintMapDestination({query(sql, params, callback) {
    assert.match(sql.trim(), /^SELECT/);
    callback(null, sql.includes("FROM complaints") ? [structuredClone(state.complaint)]
      : sql.includes("FROM complaint_notifications") ? [{target_name:state.complaint.assigned_barangay}]
      : [{barangay_name:"Fixture A",reference_name:"Synthetic reference",latitude:1.4,longitude:1.6}]);
  }},11);
  assert.equal(reloaded.basis,"admin_confirmed"); assert.equal(reloaded.assigned_barangay,"Fixture A");
});
for (const scenario of ["missing", "overlap", "invalid GPS", "different target", "unconfirmed"]) {
  test(`GPS forwarding rejects ${scenario} without an assignment or notification`, async () => {
    const {service,state} = fixture({pending:true});
    if (scenario === "missing") state.boundaries = [square("Fixture A",10)];
    if (scenario === "overlap") state.boundaries.push(square("Fixture B",.5));
    if (scenario === "invalid GPS") state.complaint.latitude = null;
    const body = {selected_barangay:scenario === "different target"?"Fixture B":"Fixture A",confirm_assignment:scenario !== "unconfirmed",use_gps_match:true};
    await assert.rejects(service.forward(11,admin,body), error => [400,409].includes(error.statusCode));
    assert.equal(state.complaint.status,"pending"); assert.equal(state.complaint.assignment_confirmed_at,null);
    assert.equal(state.notifications.length,0);
  });
}
test("two names, absent confirmation/reason, and unknown active name cannot forward", async () => {
  const { service } = fixture({ pending: true });
  for (const body of [{ ...forwardBody, target_barangays: ["Fixture A", "Fixture B"] },
    { ...forwardBody, confirm_assignment: false }, { ...forwardBody, assignment_confirmation_reason: " " },
    { ...forwardBody, selected_barangay: "Made up" }]) await rejects(service.forward(11, admin, body), 400);
});
test("explicit Accept moves to in_progress and duplicate tap does not duplicate notice", async () => {
  const { service, state } = fixture();
  assert.equal((await service.decide(11, actor, "accept", { accepted_by: 999, barangay: "Fixture B" })).status, "in_progress");
  assert.equal(state.complaint.accepted_by, 7);
  assert.equal((await service.decide(11, actor, "accept")).idempotent, true);
  assert.equal(state.notifications.filter(n => n.target_type === "wmo").length, 1);
});
test("Cannot Accept requires bounded reason; preserves original barangay and records WMO owner", async () => {
  const { service, state } = fixture();
  for (const value of [undefined, "  ", "x".repeat(2001)]) await rejects(service.decide(11, actor, "cannot_accept", { reason: value }), 400);
  await service.decide(11, actor, "cannot_accept", { reason: "  Synthetic reason  ", declined_by: 999 });
  assert.equal(state.complaint.status, "wmo_handling"); assert.equal(state.complaint.handling_owner, "wmo");
  assert.equal(state.complaint.assigned_barangay, "Fixture A"); assert.equal(state.complaint.barangay_declined_by, 7);
  assert.equal(state.complaint.barangay_decline_reason, "Synthetic reason");
  assert.ok(!state.notifications.at(-1).message.includes("Synthetic reason"));
  assert.equal((await service.decide(11, actor, "cannot_accept", { reason: "Synthetic reason" })).idempotent, true);
  await rejects(service.decide(11, actor, "accept"), 409);
  await rejects(service.decide(11, actor, "cannot_accept", { reason: "Different reason" }), 409);
});
test("accept/decline races produce exactly one owner and one new WMO notice", async () => {
  const { service, state } = fixture();
  const results = await Promise.allSettled([service.decide(11, actor, "accept"), service.decide(11, actor, "cannot_accept", { reason: "Reason" })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.statusCode, 409);
  assert.equal(state.notifications.filter(n => n.target_type === "wmo").length, 1);
});
test("notification failure rolls back decision, actor, reason and ownership", async () => {
  const { service, state } = fixture({ failNotice: true });
  await assert.rejects(service.decide(11, actor, "cannot_accept", { reason: "Reason" }));
  assert.equal(state.complaint.status, "forwarded"); assert.equal(state.complaint.barangay_decline_reason, undefined);
  assert.equal(state.notifications.length, 1); assert.equal(state.rollbacks, 1);
});
test("concurrent identical declines persist one reason and one notice even when decline wins first", async () => {
  const { service, state } = fixture();
  const results = await Promise.allSettled([service.decide(11, actor, "cannot_accept", { reason: "First reason" }),
    service.decide(11, actor, "cannot_accept", { reason: "First reason" }), service.decide(11, actor, "accept")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 2);
  assert.equal(results[1].value.idempotent, true); assert.equal(results[2].reason.statusCode, 409);
  assert.equal(state.complaint.status, "wmo_handling");
  assert.equal(state.notifications.filter(n => n.target_type === "wmo").length, 1);
});
test("forward notification failure rolls back confirmation and recipient atomically", async () => {
  const { service, state } = fixture({ pending: true, failNotice: true });
  await assert.rejects(service.forward(11, admin, forwardBody));
  assert.equal(state.complaint.status, "pending"); assert.equal(state.complaint.assigned_barangay, "For Verification");
  assert.equal(state.complaint.assignment_confirmed_at, null); assert.equal(state.notifications.length, 0);
});
test("resolution GPS is preserved while spoofed resolver IDs are ignored", async () => {
  const { service, state } = fixture();
  await service.decide(11, actor, "accept");
  await service.resolve(11, actor, { resolution_report: "Synthetic resolution", resolved_by: 999,
    resolver_latitude: 1.25, resolver_longitude: 1.75 }, async () => "/synthetic/proof.jpg");
  assert.equal(state.complaint.resolver_latitude, 1.25); assert.equal(state.complaint.resolver_longitude, 1.75);
  assert.equal(state.complaint.resolved_by, actor.id);
});
test("wrong barangay, legacy fanout, stale state and absent complaint reject safely", async () => {
  const { service, state } = fixture();
  await rejects(service.decide(11, { ...actor, barangay: "Fixture B" }, "accept"), 403);
  state.notifications.push({ target_type: "barangay", target_name: "Fixture B" });
  await rejects(service.decide(11, actor, "accept"), 409);
  state.notifications.pop(); state.complaint.status = "resolved";
  await rejects(service.decide(11, actor, "accept"), 409);
  await rejects(service.decide(999, actor, "accept"), 404);
});
test("unmigrated feature returns 503 before any transaction/write", async () => {
  const { service, state } = fixture({ missingColumn: true });
  await rejects(service.decide(11, actor, "accept"), 503, "COMPLAINT_FEATURE_UNAVAILABLE");
  await rejects(service.forward(11, admin, forwardBody), 503);
  assert.equal(state.commits, 0); assert.equal(state.complaint.status, "forwarded");
});
test("accepted barangay resolves with evidence; cannot resolve forwarded or WMO-owned work", async () => {
  const { service, state } = fixture(); let uploads = 0;
  const save = async () => { uploads++; return "/synthetic/evidence.jpg"; };
  await rejects(service.resolve(11, actor, { resolution_report: "Done" }, save), 409);
  assert.equal(uploads, 0);
  await service.decide(11, actor, "accept");
  await service.resolve(11, actor, { resolution_report: "Done" }, save);
  assert.equal(state.complaint.resolved_by, 7); assert.equal(state.complaint.wmo_resolved_by, null);
  assert.equal(state.complaint.resolution_evidence_url, "/synthetic/evidence.jpg");
});
test("WMO resolution preserves mobile/web actor namespaces and decline audit", async () => {
  const { service, state } = fixture();
  await service.decide(11, actor, "cannot_accept", { reason: "Reason" });
  await rejects(service.resolve(11, actor, { resolution_report: "Done" }, async () => "image"), 409);
  await service.resolve(11, admin, { resolution_report: "WMO visited and completed work" }, async () => "/synthetic/wmo-evidence.jpg");
  assert.equal(state.complaint.resolved_by, null); assert.equal(state.complaint.wmo_resolved_by, 3);
  assert.equal(state.complaint.barangay_decline_reason, "Reason"); assert.equal(state.complaint.assigned_barangay, "Fixture A");
});

function authFixture({ webRole = "super_admin", csrf = true, signedIn = true } = {}) {
  const source = fs.readFileSync(path.join(root, "middleware/complaintAuth.js"), "utf8"), module = { exports: {} };
  const { service } = fixture();
  vm.runInNewContext(source, { module, require(name) {
    if (name === "./webSessionAuth") return { requireWebAuth(req, res, next) {
      if (!signedIn) return res.status(401).json({}); req.user = { id: 3, role: webRole }; next();
    }, requireWebRole(role) { assert.equal(role, "super_admin"); return (req, res, next) => req.user.role === role ? next() : res.status(403).json({}); },
    requireCsrf(req, res, next) { return csrf ? next() : res.status(403).json({}); } };
    if (name === "./mobileSessionAuth") return { requireMobileSession(req, res, next) {
      if (!signedIn) return res.status(401).json({}); req.mobileUser = { id: 7, role: "barangay" }; next();
    } };
    if (name === "../services/complaintWorkflowService") return require(name);
    throw new Error(`Unexpected auth dependency: ${name}`);
  } });
  return module.exports.buildComplaintAuth(service);
}
async function runGuard(handlers, req = {}) {
  let statusCode = 200, completed = false;
  const res = { status(code) { statusCode = code; return this; }, json() { return this; } };
  const advance = async index => { if (index === handlers.length) { completed = true; return; }
    let continuation; await handlers[index](req, res, () => { continuation = advance(index + 1); }); await continuation; };
  await advance(0); return { statusCode, completed, req };
}
test("Admin guard requires session, exact super_admin and CSRF; Personnel/Enforcer/aliases denied", async () => {
  assert.equal((await runGuard(authFixture().admin)).completed, true);
  assert.equal((await runGuard(authFixture({ signedIn: false }).admin)).statusCode, 401);
  assert.equal((await runGuard(authFixture({ csrf: false }).admin)).statusCode, 403);
  for (const webRole of ["admin", "personnel", "enforcer", "division_admin", "supervisor", "clerk_admin"]) {
    assert.equal((await runGuard(authFixture({ webRole }).admin)).statusCode, 403);
  }
});
test("Barangay guard ignores body identity and forbids another barangay URL", async () => {
  const auth = authFixture();
  const result = await runGuard([...auth.barangay, auth.ownBarangay], { params: { barangayName: "Fixture B" }, body: { barangay: "Fixture B", accepted_by: 999 } });
  assert.equal(result.req.complaintActor.id, 7); assert.equal(result.statusCode, 403);
  assert.equal((await runGuard(authFixture({ signedIn: false }).barangay)).statusCode, 401);
});
test("source integration preserves maps/photos/GPS and removes auto-accept/multi-forward decision path", () => {
  const route = fs.readFileSync(path.join(root, "routes/complaintRoutes.js"), "utf8");
  const client = fs.readFileSync(path.join(root, "frontend/js/admin/admin-complaints.js"), "utf8");
  assert.match(route, /EXPLICIT_ACCEPT_REQUIRED/); assert.doesNotMatch(route, /assignment_method = 'multi_forwarded'/);
  assert.doesNotMatch(route.slice(route.indexOf('router.post("/",'), route.indexOf('router.get("/",')), /"user_selected"|"learned_previous_complaint"/);
  assert.match(route, /upload\.single\("image"\)/); assert.match(route, /upload\.single\("evidence"\)/);
  assert.match(client, /renderComplaintDetailsMapPreview/); assert.match(client, /enableImagePreview/);
  assert.match(client, /escapeHtml\(data\.barangay_decline_reason/); assert.match(client, /new FormData\(form\)/);
  assert.match(client, /await webAdminFetch/); assert.doesNotMatch(client, /\bawait fetch\(/);
});
