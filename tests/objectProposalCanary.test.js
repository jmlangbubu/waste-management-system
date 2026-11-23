"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const dbPath = require.resolve("../config/db");
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
  exports: { query() { throw Error("Live database forbidden"); } } };
const { MobileSessionService, hashOpaqueToken } = require("../services/mobileSessionService");
const { buildResolveObjectProposalSession } = require("../middleware/objectProposalCanary");
const { allowedAccountIds, isAllowedProposalSession } = require("../config/objectProposalCanary");
const CAP = "waste-scan-independent-category-v2", TOKEN = "a".repeat(43);
const ON = { WMO_CLASSIFY_OBJECT_PROPOSALS_ENABLED: "true",
  WMO_CLASSIFY_OBJECT_PROPOSALS_ALLOWED_USER_IDS: "7" };
const session = { id: 12, user: { id: 7 } };

async function resolve({ env = ON, authorization = "Bearer " + TOKEN, capability = CAP,
    authenticated = session, error, body = {} } = {}) {
  let reads = 0, next = 0, status = 200, response;
  const service = { async authenticateMobileSession(token) {
    reads++; assert.equal(token, TOKEN); if (error) throw error; return authenticated;
  } };
  const req = { headers: { authorization, "x-wmo-scan-capability": capability }, body,
    objectProposalSession: session };
  const res = { status(code) { status = code; return this; }, json(value) { response = value; } };
  await buildResolveObjectProposalSession(service, env)(req, res, () => next++);
  return { reads, next, status, response, req };
}

test("authenticated allowlisted existing session alone supplies the canary context", async () => {
  const result = await resolve();
  assert.equal(result.req.objectProposalSession, session);
  assert.equal(result.reads, 1); assert.equal(result.next, 1);
});
for (const [name, options, reads] of [
  ["missing credentials", { authorization: undefined }, 0],
  ["malformed bearer", { authorization: "Bearer bad" }, 0],
  ["duplicate bearer", { authorization: "Bearer " + TOKEN + ", Bearer " + TOKEN }, 0],
  ["array header", { authorization: ["Bearer " + TOKEN] }, 0],
  ["capability header alone", { authorization: "" }, 0],
  ["missing capability", { capability: "" }, 0],
  ["non-allowlisted account", { authenticated: { id: 12, user: { id: 8 } } }, 1],
  ["absent session record", { authenticated: null }, 1],
  ["expired or revoked session", { error: { statusCode: 401 } }, 1],
  ["inactive account", { error: { statusCode: 403 } }, 1],
  ["feature disabled", { env: { ...ON, WMO_CLASSIFY_OBJECT_PROPOSALS_ENABLED: "false" } }, 0],
  ["feature default OFF", { env: { WMO_CLASSIFY_OBJECT_PROPOSALS_ALLOWED_USER_IDS: "7" } }, 0],
  ["legacy discovery owns request", { env: { ...ON, WHOLE_IMAGE_DISCOVERY_ENABLED: "true" } }, 0],
  ["default-deny empty allowlist", { env: { ...ON, WMO_CLASSIFY_OBJECT_PROPOSALS_ALLOWED_USER_IDS: "" } }, 0]
]) test("denies A9 and preserves legacy flow: " + name, async () => {
  // undefined cannot override a destructuring default; use absent header explicitly.
  if (name === "missing credentials") options.authorization = null;
  const r = await resolve({ ...options, body: { userId: 7, principal: 7,
    proposalSession: session, objectProposalSession: session, a9ProposalEligible: true } });
  assert.equal(r.req.objectProposalSession, undefined);
  assert.equal(r.reads, reads); assert.equal(r.next, 1); assert.equal(r.status, 200);
});

test("session-store errors fail closed without analysis or secret-bearing errors", async () => {
  const r = await resolve({ error: Error("PRIVATE_DATABASE_DETAILS") });
  assert.equal(r.status, 503); assert.equal(r.next, 0);
  assert.ok(!JSON.stringify(r.response).includes("PRIVATE_DATABASE_DETAILS"));
});

for (const raw of [undefined, "", "*", "7,*", "7,", "0", "-7", "7.0", "7e0", "07", "9007199254740992", "7;8"])
  test("malformed/empty allowlist denies every account: " + String(raw), () => {
    const env = { WMO_CLASSIFY_OBJECT_PROPOSALS_ALLOWED_USER_IDS: raw };
    assert.equal(allowedAccountIds(env).size, 0);
    assert.equal(isAllowedProposalSession(session, env), false);
  });
test("explicit bounded IDs permit only exact session user IDs", () => {
  const env = { WMO_CLASSIFY_OBJECT_PROPOSALS_ALLOWED_USER_IDS: "7, 8" };
  assert.equal(isAllowedProposalSession({ id: 1, user: { id: "7" } }, env), true);
  assert.equal(isAllowedProposalSession({ id: 1, user: { id: "07" } }, env), false);
  assert.equal(isAllowedProposalSession({ id: 1, user: { id: 9 } }, env), false);
});

test("existing real mobile-session authenticator resolves account from opaque token hash", async () => {
  let queries = 0;
  const service = new MobileSessionService({ query(sql, values, cb) {
    queries++; assert.match(sql, /FROM mobile_user_sessions/); assert.match(sql, /INNER JOIN users/);
    assert.match(sql, /s.revoked_at IS NULL/); assert.match(sql, /s.expires_at > UTC_TIMESTAMP/);
    assert.deepEqual(values, [hashOpaqueToken(TOKEN)]);
    cb(null, [{ session_id: 12, user_id: 7, status: "active", role: "citizen", should_refresh_last_seen: 0 }]);
  } });
  const req = { headers: { authorization: "Bearer " + TOKEN, "x-wmo-scan-capability": CAP },
    body: { userId: 8 } };
  let next = false;
  await buildResolveObjectProposalSession(service, ON)(req, {}, () => { next = true; });
  assert.equal(next, true); assert.equal(queries, 1);
  assert.equal(req.objectProposalSession.user.id, 7);
});

test("mounted analyze route passes server session separately and ignores forged body authorization", async () => {
  const handlers = {}, calls = [], module = { exports: {} };
  const router = Object.fromEntries(["get", "post", "patch", "delete"].map(method =>
    [method, (url, ...chain) => { handlers[method + " " + url] = chain; }]));
  const fakeSessionService = { async authenticateMobileSession() { return session; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../routes/wasteRoutes.js"), "utf8"), {
    module, Buffer, AbortController, __dirname: path.join(__dirname, "../routes"), process: { env: ON },
    console: { log() {}, error() {}, warn() {} }, require(id) {
      if (id === "express") return { Router: () => router };
      if (id === "path") return path; if (id === "qrcode") return {};
      if (id === "fs") return { existsSync: () => true, writeFileSync() {} };
      if (id === "../config/db") return { queryReadOnly(sql, cb) { cb(null, []); }, query(sql, values, cb) { cb(null, { insertId: 1 }); } };
      if (id === "../services/wasteAnalysisService") return { buildScanSummary: () => ({}),
        async analyzeWaste(input, context) { calls.push({ input, context }); return null; } };
      if (id.includes("Controller")) return new Proxy({}, { get: () => () => {} });
      if (id === "../middleware/mobileSessionAuth") return { requireMobileSession() { throw Error("Unexpected discovery"); } };
      if (id === "../middleware/objectProposalCanary") return {
        resolveObjectProposalSession: buildResolveObjectProposalSession(fakeSessionService, ON) };
      if (id === "../middleware/webSessionAuth") return { requireWebCapability: () => () => {}, requireCsrf() {} };
      throw Error("Unexpected dependency: " + id);
    }
  });
  async function request(authorization) {
    const req = { headers: { authorization, "x-wmo-scan-capability": CAP }, body: {
      image: "c3ludGhldGlj", principal: 7, userId: 7, proposalSession: session, a9ProposalEligible: true } };
    const res = { status() { return this; }, json() {} };
    const chain = handlers["post /analyze"];
    await chain[0](req, res, () => chain[1](req, res, () => chain[2](req, res)));
  }
  await request(""); await request("Bearer " + TOKEN);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].context.proposalSession, undefined);
  assert.equal(calls[1].context.proposalSession, session);
  assert.equal(calls[0].input.principal, undefined);
  assert.equal(calls[0].input.proposalSession, undefined);
});
