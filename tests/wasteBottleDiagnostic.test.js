"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createRequire } = require("node:module"), { EventEmitter } = require("node:events");
const { createDiagnostic } = require("../services/wasteBottleDiagnostic");
const token = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"; // synthetic only
const bearer = { authorization: `Bearer ${token}`, "x-wmo-scan-capability": "waste-scan-independent-category-v2" };
const box = { left: .12, top: .2, right: .43, bottom: .85 };
const config = () => ({ WMO_BOTTLE_DIAGNOSTIC_ENABLED: "true", WMO_BOTTLE_DIAGNOSTIC_ALLOWED_USER_ID: "123" });
const owner = () => ({ id: 100, expiresAt: "2099-01-01T00:00:00Z", user: { id: 123, status: "active" } });
const fake = (headers = bearer) => ({ headers, body: { image: "synthetic" } });
function harness(env = config()) { const lines = []; return { lines, observer: createDiagnostic({ env, logger: line => lines.push(line) }) }; }
function loadAuth() {
 const file = path.resolve(__dirname, "../middleware/mobileSessionAuth.js"), real = createRequire(file), module = { exports: {} };
 vm.runInNewContext(fs.readFileSync(file, "utf8"), { module, exports: module.exports, console: { warn() {} }, require(id) {
  if (id === "../services/mobileSessionService") return { isValidOpaqueToken: value => /^[A-Za-z0-9_-]{43}$/.test(value), authenticateMobileSession() { throw Error("Unexpected default authentication"); } };
  return real(id);
 } }, { filename: file }); return module.exports.buildRequireMobileSession;
}
const buildRequireMobileSession = loadAuth();
// The marker is handed off only by the real trusted middleware's success callback.
async function verified(observer, req = fake(), session = owner()) {
 let authCalls = 0, reached = false;
 await buildRequireMobileSession({ async authenticateMobileSession() { authCalls++; return session; } })(req,
  { status() { return this; }, json() {} }, () => { reached = true; observer.rememberVerifiedRequest(req); });
 assert.equal(reached, true); return { req, calls: () => authCalls };
}
async function scan(observer, req, cb = () => {}) { return observer.middleware(req, {}, cb); }
const parsed = lines => JSON.parse(lines[0].replace(/^\[WmoBottleDiagnostic\] /, ""));

for (const env of [{}, null, { ...config(), WMO_BOTTLE_DIAGNOSTIC_ENABLED: "false" },
 { ...config(), WMO_BOTTLE_DIAGNOSTIC_ALLOWED_USER_ID: undefined }, { ...config(), WMO_BOTTLE_DIAGNOSTIC_ALLOWED_USER_ID: "123 OR 1=1" }])
 test("OFF/missing/invalid configuration never authenticates or records: " + JSON.stringify(env), async () => {
  let calls = 0; const lines = [], observer = createDiagnostic({ env, authenticate() { calls++; }, logger: line => lines.push(line) });
  await scan(observer, fake(), () => { observer.recordItems("preNormalization", "cloud_run_gemini_vision", [{ name: "Bottle" }]); observer.finish({}); });
  assert.equal(calls, 0); assert.deepEqual(lines, []);
 });

test("corrective: diagnostic never initiates fallback authentication or trusts spoofed principals", async () => {
 let calls = 0; const lines = [], observer = createDiagnostic({ env: config(), authenticate() { calls++; throw Error("Forbidden reauthentication"); }, logger: line => lines.push(line) });
 for (const headers of [bearer, {}, { authorization: "Bearer malformed" }]) {
  const req = { ...fake(headers), mobileUser: owner().user, mobileSession: { id: 100, expiresAt: owner().expiresAt } };
  req.body.userId = 123; req.body.mobileUser = owner().user;
  await scan(observer, req, () => observer.finish({ category: "Unknown" }));
 }
 assert.equal(calls, 0); assert.deepEqual(lines, []);
});

test("trusted request marker cannot be copied by headers, body or another request object", async () => {
 const { observer, lines } = harness(), { req, calls } = await verified(observer);
 await scan(observer, { ...req }, () => observer.finish({})); assert.equal(lines.length, 0);
 await scan(observer, req, () => observer.finish({ category: "Unknown" }));
 assert.equal(lines.length, 1); assert.equal(calls(), 1);
});

test("trusted middleware authentication is reused with zero extra calls or diagnostic dependencies", async () => {
 const file = path.resolve(__dirname, "../services/wasteBottleDiagnostic.js"), real = createRequire(file), module = { exports: {} }, imports = [];
 vm.runInNewContext(fs.readFileSync(file, "utf8"), { module, exports: module.exports, Date, console, require(id) { imports.push(id); assert.equal(id, "node:async_hooks"); return real(id); } }, { filename: file });
 const lines = [], observer = module.exports.createDiagnostic({ env: config(), logger: line => lines.push(line) });
 const { req, calls } = await verified(observer); await scan(observer, req, () => observer.finish({ category: "Unknown" }));
 assert.equal(calls(), 1); assert.equal(lines.length, 1); assert.deepEqual(imports, ["node:async_hooks"]);
});

for (const scenario of ["expired", "inactive", "wrong owner", "invalid session", "replaced user", "changed session", "changed expiry"])
 test("unusable trusted principal fails closed for diagnostics: " + scenario, async () => {
  const { observer, lines } = harness(), session = owner();
  if (scenario === "expired") session.expiresAt = "2000-01-01T00:00:00Z";
  if (scenario === "inactive") session.user.status = "inactive";
  if (scenario === "wrong owner") session.user.id = 456;
  if (scenario === "invalid session") session.id = 0;
  const { req } = await verified(observer, fake(), session);
  if (scenario === "replaced user") req.mobileUser = { id: 456, status: "active" };
  if (scenario === "changed session") req.mobileSession.id = 101;
  if (scenario === "changed expiry") req.mobileSession.expiresAt = "2099-02-01T00:00:00Z";
  let next = 0; await scan(observer, req, () => { next++; observer.finish({}); });
  assert.equal(next, 1); assert.deepEqual(lines, []);
 });

for (const reason of ["expired", "revoked", "store unavailable"])
 test("failed existing authentication never grants a diagnostic marker: " + reason, async () => {
  const { observer, lines } = harness(), req = fake(); let calls = 0, status = 0;
  await buildRequireMobileSession({ async authenticateMobileSession() { calls++; const error = new Error(reason); error.statusCode = reason === "store unavailable" ? 503 : 401; throw error; } })(req,
   { status(n) { status = n; return this; }, json() {} }, () => observer.rememberVerifiedRequest(req));
  await scan(observer, req, () => observer.finish({})); assert.equal(calls, 1); assert.equal(status, reason === "store unavailable" ? 503 : 401); assert.deepEqual(lines, []);
 });

test("one verified request emits bounded sanitized original/normalized/final evidence", async () => {
 const { observer, lines } = harness(), { req } = await verified(observer);
 await scan(observer, req, () => {
  observer.recordPrimary("cloud_run_gemini_vision", { itemName: "Plastic Water Bottle", category: "Recyclable", confidence: .95, secret: "NeverLogThisSecret" });
  observer.recordItems("preNormalization", "cloud_run_gemini_vision", [
   { itemName: "Empty Plastic Water Bottle", category: "Unknown", confidence: .95, boundingBox: box, photoBase64: "NeverLogThisBase64", userId: "NeverLogThisUser" },
   { itemName: "John Doe + 123-456-7890", category: "Residual" }
  ]);
  observer.recordItems("normalized", "cloud_run_gemini_vision", [{ itemName: "Empty Plastic Water Bottle", category: "Unknown", boundingBox: box }]);
  observer.finish({ category: "Recyclable", analysisSource: "cloud_run_gemini_vision", detectedItems: [{ itemId: "NeverLogThisId", itemName: "Bottle", originalItemName: "Empty Plastic Water Bottle", observedIdentity: "PET Bottle", category: "Unknown", confidence: .95, boundingBox: box }],
   categoryAssessments: { aiStatus: "complete", items: [{ itemId: "NeverLogThisId", category: "Unknown", assessmentSource: "ai_assisted", notes: "NeverLogThisNotes" }] } });
  observer.finish({});
 });
 const second = await verified(observer); await scan(observer, second.req, () => observer.finish({}));
 assert.equal(lines.length, 1); assert.doesNotMatch(lines[0], /NeverLogThis|John Doe|userId|itemId|photoBase64|secret|notes|123-456|2099|Bearer/);
 assert.ok(!lines[0].includes(token)); const r = parsed(lines);
 assert.equal(r.preNormalization[0].items[0].identity, "Empty Plastic Water Bottle"); assert.equal(r.preNormalization[0].items[0].explicitUnknown, true);
 assert.equal(r.preNormalization[0].items[1].identity, "redacted"); assert.equal(r.final.items[0].proposedDisplayCategory, "Unknown");
});

for (const [obj, field, identity] of [
 [{ itemName: "Bottle", name: "Glass bottle", observedIdentity: "PET water bottle", originalItemName: "Empty plastic water bottle" }, "itemName", "Bottle"],
 [{ itemName: "", name: "PET Bottle" }, "name", "PET Bottle"],
 [{ observedIdentity: "PET Bottle", originalItemName: "Plastic bottle", canonicalItem: "bottle" }, null, "unavailable"],
 [{ itemName: 42, name: "PET Bottle" }, "itemName", "unavailable"],
 [{ name: "" }, "name", "unavailable"], [{}, null, "unavailable"]])
 test("corrective: raw identity selects the actual normalization field: " + JSON.stringify(obj), async () => {
  const { observer, lines } = harness(), { req } = await verified(observer);
  await scan(observer, req, () => { observer.recordItems("preNormalization", "cloud_run_gemini_vision", [obj]); observer.finish({}); });
  const item = parsed(lines).preNormalization[0].items[0]; assert.equal(item.identityField, field); assert.equal(item.identity, identity);
  if (obj.observedIdentity) assert.equal(item.providerObservedIdentity, obj.observedIdentity);
 });

for (const [obj, cat, provided, explicit] of [[{}, null, false, null], [{ category: "Unknown" }, "Unknown", true, true],
 [{ category: "Recyclable" }, "Recyclable", true, false], [{ category: "private arbitrary category" }, null, true, null]])
 test("original provider category and explicit Unknown are not inferred: " + JSON.stringify(obj), async () => {
  const { observer, lines } = harness(), { req } = await verified(observer);
  await scan(observer, req, () => { observer.recordItems("preNormalization", "cloud_run_gemini_vision", [obj]); observer.finish({ category: "Recyclable" }); });
  const item = parsed(lines).preNormalization[0].items[0]; assert.equal(item.category, cat); assert.equal(item.categoryProvided, provided); assert.equal(item.explicitUnknown, explicit);
 });

test("raw hook source and exact finite geometry/confidence cannot be replaced by provider aliases", async () => {
 const { observer, lines } = harness(), { req } = await verified(observer), confidence = .9123456789;
 await scan(observer, req, () => {
  observer.recordItems("preNormalization", "cloud_run_gemini_vision", [{ itemName: "Bottle", analysisSource: "gemini_whole_image", confidence, boundingBox: box }]);
  observer.recordItems("normalized", "untrusted source", [{ itemName: "Bottle\nBearer token 123", confidence: 55, boundingBox: { left: -1, top: 0, right: 3, bottom: 5 } }]); observer.finish({});
 });
 const r = parsed(lines); assert.equal(r.preNormalization[0].items[0].source, "cloud_run_gemini_vision"); assert.equal(r.preNormalization[0].items[0].confidence, confidence);
 assert.deepEqual(r.preNormalization[0].items[0].boundingBox, box); assert.equal(r.normalized[0].items[0].identity, "redacted");
 assert.equal(r.normalized[0].items[0].source, "unrecognized_source"); assert.equal(r.normalized[0].items[0].boundingBox, null);
});

test("concurrent verified requests yield at most one trace without further authentication", async () => {
 const { observer, lines } = harness(), ready = await Promise.all(Array.from({ length: 20 }, () => verified(observer)));
 await Promise.all(ready.map(({ req }) => scan(observer, req, async () => { await new Promise(resolve => setImmediate(resolve)); observer.finish({ category: "Unknown" }); })));
 assert.equal(lines.length, 1); assert.ok(ready.every(x => x.calls() === 1));
});

test("observer never mutates frozen raw, normalized, final or assessment objects", async () => {
 const { observer, lines } = harness(), { req } = await verified(observer);
 const raw = Object.freeze({ itemName: "PET Bottle", category: "Unknown", confidence: .72, boundingBox: Object.freeze({ ...box }) });
 const retained = Object.freeze({ ...raw, itemId: "NeverLogThisId" });
 const result = Object.freeze({ category: "Recyclable", detectedItems: Object.freeze([retained]), categoryAssessments: Object.freeze({ aiStatus: "complete", items: Object.freeze([Object.freeze({ itemId: retained.itemId, category: "Unknown", assessmentSource: "ai_assisted" })]) }) });
 const snapshot = JSON.stringify({ raw, result }); await scan(observer, req, () => { observer.recordItems("preNormalization", "cloud_run_gemini_vision", [raw]); observer.recordItems("normalized", "cloud_run_gemini_vision", [retained]); observer.finish(result); });
 assert.equal(JSON.stringify({ raw, result }), snapshot); assert.equal(lines.length, 1);
});

test("output remains bounded and logger failure cannot fail the scan", async () => {
 const { observer, lines } = harness(), { req } = await verified(observer);
 await scan(observer, req, () => { for (let n = 0; n < 10; n++) observer.recordItems("preNormalization", "cloud_run_gemini_vision", Array.from({ length: 80 }, () => ({ name: "Bottle" }))); observer.finish({ detectedItems: Array.from({ length: 20 }, () => ({ itemName: "Paper" })) }); });
 const out = parsed(lines); assert.equal(out.preNormalization.length, 2); assert.equal(out.preNormalization[0].items.length, 8); assert.equal(out.final.items.length, 8); assert.ok(Buffer.byteLength(lines[0]) < 32768);
 const throwing = createDiagnostic({ env: config(), logger() { throw Error("offline logger failure"); } }), trusted = await verified(throwing);
 await scan(throwing, trusted.req, () => throwing.finish({}));
});

function routeFixture(env, observer, session = owner(), authenticateError = null) {
 const file = path.resolve(__dirname, "../routes/wasteRoutes.js"), real = createRequire(file), module = { exports: {} }, handlers = {};
 const counts = { auth: 0, analysis: 0, inserts: 0, imageWrites: 0 };
 const result = { itemName: "Paper", category: "Recyclable", analysisSource: "cloud_run_gemini_vision", explanation: "Original", action: "Original", warning: "Original", detectedItems: [{ itemId: "item_1", itemName: "Bottle", originalItemName: "Bottle", canonicalItem: "bottle", category: "Unknown", analysisSource: "cloud_run_gemini_vision", confidence: .9, requiresConfirmation: true, boundingBox: box }] };
 const router = Object.fromEntries(["get", "post", "patch", "delete"].map(method => [method, (url, ...chain) => { handlers[method + " " + url] = chain; }]));
 class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ["2026-11-24T00:00:00Z"])); } static now() { return Date.parse("2026-11-24T00:00:00Z"); } }
 vm.runInNewContext(fs.readFileSync(file, "utf8"), { module, __dirname: path.dirname(file), Buffer, AbortController, Date: FixedDate, Math: Object.assign(Object.create(Math), { random: () => .5 }), process: { env }, console: { log() {}, warn() {}, error() {} }, require(id) {
  if (id === "express") return { Router: () => router }; if (id === "path") return path; if (id === "qrcode") return {};
  if (id === "fs") return { existsSync: () => true, mkdirSync() { throw Error("Unexpected directory write"); }, writeFileSync() { counts.imageWrites++; } };
  if (id === "../config/db") return { queryReadOnly(_sql, cb) { cb(null, ["image_url", "analysis_source", "ai_label", "ai_confidence"].map(Field => ({ Field }))); }, query(sql, _params, cb) { assert.match(sql, /INSERT INTO scan_history/); counts.inserts++; cb(null, { insertId: 123 }); } };
  if (id === "../services/wasteAnalysisService") return { buildScanSummary: real(id).buildScanSummary, async analyzeWaste() { counts.analysis++; observer.recordItems("normalized", "cloud_run_gemini_vision", result.detectedItems); return structuredClone(result); } };
  if (id === "../services/wasteBottleDiagnostic") return observer;
  if (id === "../middleware/mobileSessionAuth") return { requireMobileSession: buildRequireMobileSession({ async authenticateMobileSession() { counts.auth++; if (authenticateError) throw authenticateError; return session; } }) };
  if (id.includes("Controller")) return new Proxy({}, { get: () => () => {} });
  if (id.includes("webSessionAuth")) return { requireWebCapability: () => () => {}, requireCsrf() {} };
  if (id === "../gemini-waste-classifier-cloudrun/cropRecognition") return real(id);
  throw Error("Unexpected dependency: " + id);
 } }, { filename: file });
 return { counts, async run() {
  const req = Object.assign(new EventEmitter(), fake()); req.body = { image: "c3ludGhldGlj", objectDiscovery: { captureId: "synthetic-capture" } };
  // Client-shaped principal properties alone are deliberately not authenticated.
  if (env.WHOLE_IMAGE_DISCOVERY_ENABLED !== "true") Object.assign(req, { mobileUser: owner().user, mobileSession: { id: 100, expiresAt: owner().expiresAt } });
  const res = new EventEmitter(); res.statusCode = 200; res.status = n => { res.statusCode = n; return res; }; res.json = body => { res.body = body; res.writableEnded = true; return res; };
  async function dispatch(i) { if (i >= handlers["post /analyze"].length) return; let downstream; await handlers["post /analyze"][i](req, res, () => (downstream = dispatch(i + 1))); if (downstream) await downstream; }
  await dispatch(0); return { status: res.statusCode, body: JSON.parse(JSON.stringify(res.body)) };
 } };
}

test("actual route handoff adds zero auth/DB operations and preserves the entire OFF/ON response", async () => {
 const off = harness({ ...config(), WMO_BOTTLE_DIAGNOSTIC_ENABLED: "false" }), on = harness();
 const offRoute = routeFixture({ WHOLE_IMAGE_DISCOVERY_ENABLED: "true", WMO_BOTTLE_DIAGNOSTIC_ENABLED: "false" }, off.observer);
 const onRoute = routeFixture({ WHOLE_IMAGE_DISCOVERY_ENABLED: "true", WMO_BOTTLE_DIAGNOSTIC_ENABLED: "true" }, on.observer);
 assert.deepEqual(await onRoute.run(), await offRoute.run()); assert.deepEqual(onRoute.counts, offRoute.counts);
 assert.deepEqual(onRoute.counts, { auth: 1, analysis: 1, inserts: 1, imageWrites: 1 }); assert.equal(on.lines.length, 1); assert.equal(off.lines.length, 0);
});

test("actual route without existing authentication skips diagnostics and preserves scanning", async () => {
 const { observer, lines } = harness(), route = routeFixture({ WMO_BOTTLE_DIAGNOSTIC_ENABLED: "true" }, observer);
 const response = await route.run(); assert.equal(response.status, 200); assert.equal(response.body.success, true); assert.equal(route.counts.auth, 0); assert.equal(lines.length, 0);
});

test("actual route failed existing authentication remains unchanged and cannot capture", async () => {
 const { observer, lines } = harness(), error = new Error("synthetic revoked session"); error.statusCode = 401;
 const route = routeFixture({ WHOLE_IMAGE_DISCOVERY_ENABLED: "true", WMO_BOTTLE_DIAGNOSTIC_ENABLED: "true" }, observer, owner(), error);
 assert.equal((await route.run()).status, 401); assert.deepEqual(route.counts, { auth: 1, analysis: 0, inserts: 0, imageWrites: 0 }); assert.equal(lines.length, 0);
});

test("corrective: existing VM route without process preserves DB success/failure responses", async () => {
 const file = path.join(__dirname, "wasteMultiItemAnalysis.test.js"), real = createRequire(file), module = { exports: {} };
 vm.runInNewContext(fs.readFileSync(file, "utf8") + "\nmodule.exports={routeResponse};", { module, __dirname, URL, Buffer, AbortController, setTimeout, clearTimeout, require: id => id === "node:test" ? { test() {} } : real(id) }, { filename: file });
 for (const failInsert of [false, true]) { const { response, statusCode } = await module.exports.routeResponse({ failInsert }); assert.equal(statusCode, 200); assert.equal(response.success, true); assert.equal(response.detectedItems.length, 3); }
});

for (const processValue of [undefined, {}, { env: undefined }, { env: null }])
 test("observer module defaults OFF with missing process/environment: " + JSON.stringify(processValue), async () => {
  const file = path.resolve(__dirname, "../services/wasteBottleDiagnostic.js"), real = createRequire(file), module = { exports: {} };
  const context = { module, exports: module.exports, Date, console: { info() { throw Error("Unexpected log"); } }, require: real };
  if (processValue !== undefined) context.process = processValue;
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  let next = 0; await module.exports.middleware(fake(), {}, () => next++); module.exports.finish({}); assert.equal(next, 1);
 });

test("inherited category is never reported as explicitly supplied provider evidence", async () => {
 const {observer,lines}=harness(),{req}=await verified(observer);
 await scan(observer,req,()=>{observer.recordItems("preNormalization","cloud_run_gemini_vision",[Object.create({category:"Unknown"})]);observer.finish({});});
 const item=parsed(lines).preNormalization[0].items[0];assert.equal(item.categoryProvided,false);assert.equal(item.category,null);assert.equal(item.explicitUnknown,null);
});
for(const processValue of [undefined,{}, {env:null}])test("normalizer diagnostic hook is OFF without process/env: "+JSON.stringify(processValue),()=>{
 const file=path.resolve(__dirname,"../services/wasteAnalysisService.js"),real=createRequire(file),module={exports:{}};
 const context={module,exports:module.exports,URL,Buffer,setTimeout,clearTimeout,console:{log(){},warn(){},error(){}},require(id){assert.notEqual(id,"./wasteBottleDiagnostic");return real(id);}};
 if(processValue!==undefined)context.process=processValue;
 vm.runInNewContext(fs.readFileSync(file,"utf8"),context,{filename:file});
 const items=module.exports.normalizeDetectedItems([{name:"Bottle",category:"Unknown",confidence:.9,boundingBox:box}],"cloud_run_gemini_vision",true);
 assert.equal(items.length,1);assert.equal(items[0].category,"Unknown");assert.equal(items[0].itemId,"item_1");
});
