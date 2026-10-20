"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto"), path = require("node:path"), fs = require("node:fs"), vm = require("node:vm");
const { EventEmitter } = require("node:events");
const diagnostics = require("../services/cloudRunDiagnostics");
const { createCloudRunAuth } = require("../services/cloudRunAuth");
const audience = "https://synthetic-example.run.app", endpoint = audience + "/classify-waste";
const privateKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
const credentials = { type: "service_account", client_email: "offline-only@synthetic-project.iam.gserviceaccount.com", private_key: privateKey, private_key_id: "SYNTHETIC_KEY_ID_MUST_NOT_LEAK" };
const env = { CLOUD_RUN_AUTH_MODE: "iam", CLOUD_RUN_AUDIENCE: audience, CLOUD_RUN_CALLER_CREDENTIALS_FILE: path.resolve(require("node:os").tmpdir(), "synthetic-not-created.json") };
const now = Date.now();
const token = patch => "synthetic." + Buffer.from(JSON.stringify({ aud: audience, iss: "https://accounts.google.com", exp: Math.floor(now / 1000) + 3600, ...patch })).toString("base64url") + ".signature";
const secretError = () => Object.assign(new Error("SYNTHETIC_SECRET_MESSAGE_MUST_NOT_LEAK"), { stack: "SYNTHETIC_SECRET_STACK_MUST_NOT_LEAK", response: { data: "SYNTHETIC_PROVIDER_BODY_MUST_NOT_LEAK" }, diagnostic: { stage: "credential_file_read", code: "SYNTHETIC_FORGED_CODE" } });
function fixture(options = {}) {
  const calls = { read: 0, sdk: 0, exchange: 0 };
  class JWT {
    constructor() { calls.sdk++; if (options.constructorError) throw secretError(); this.transporter = { request: async () => ({}) }; }
    async fetchIdToken() { calls.exchange++; if (options.hang) return new Promise(() => {}); if (options.oauthError) throw secretError(); return options.rawToken ?? token(options.payload); }
  }
  const auth = createCloudRunAuth({ env: { ...env, ...options.env }, now: () => now,
    readFile() { calls.read++; if (options.readError) throw Object.assign(secretError(), { code: options.readError }); return options.raw ?? JSON.stringify({ ...credentials, ...options.credentials }); },
    loadLibrary() { if (options.sdkError) throw secretError(); return options.library ?? { JWT }; } });
  return { auth, calls };
}
async function rejectStage(f, stage, opts) {
  await assert.rejects(f.auth(endpoint, opts), error => {
    assert.equal(error.code, "CLOUD_RUN_AUTH_UNAVAILABLE"); assert.equal(error.message, "Cloud Run authentication unavailable.");
    assert.equal(diagnostics.diagnostic(error).stage, stage);
    const safe = JSON.stringify(diagnostics.diagnostic(error)); assert.doesNotMatch(safe, /SYNTHETIC_|PRIVATE KEY|Bearer|service_account|run\.app/); return true;
  });
}
test("valid IAM path retains header/cache and has no error diagnostic", async () => {
  const f = fixture(); const result = await f.auth(endpoint); assert.equal(result.Authorization, "Bearer " + token());
  await f.auth(audience + "/discover-objects"); assert.deepEqual(f.calls, { read: 1, sdk: 1, exchange: 1 });
});
test("exact origin mismatch gets fixed diagnostic before any credential access", async () => {
  const f = fixture({ env: { CLOUD_RUN_AUDIENCE: "https://other-synthetic.run.app" } }); await rejectStage(f, "audience_origin_mismatch"); assert.equal(f.calls.read, 0);
});
for (const code of ["ENOENT", "EACCES"]) test("credential read boundary: " + code, async () => {
  const f = fixture({ readError: code }); await rejectStage(f, "credential_file_read"); assert.equal(f.calls.sdk, 0);
});
for (const raw of ["{invalid", "null", "{}", JSON.stringify({ ...credentials, type: "authorized_user" })]) test("credential format is rejected without leaking input: " + raw.length, async () => {
  const f = fixture({ raw }); await rejectStage(f, "credential_format_validation"); assert.equal(f.calls.sdk, 0);
});
test("invalid RSA material is distinguished before SDK/OAuth", async () => {
  const f = fixture({ credentials: { private_key: "SYNTHETIC_BAD_KEY_MUST_NOT_LEAK" } }); await rejectStage(f, "credential_key_validation"); assert.equal(f.calls.exchange, 0);
});
test("non-RSA key remains fail-closed before SDK signing", async () => {
  const key = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });
  const f = fixture({ credentials: { private_key: key } }); await rejectStage(f, "credential_key_validation"); assert.equal(f.calls.sdk, 0);
});
for (const options of [{ sdkError: true }, { library: {} }, { constructorError: true }, { library: { JWT: class {} } }, { library: { JWT: class { constructor() { this.transporter = { request() {} }; } } } }]) test("missing/incompatible SDK receives fixed stage: " + Object.keys(options)[0], async () => {
  const f = fixture(options); await rejectStage(f, "sdk_initialization"); assert.equal(f.calls.exchange, 0);
});
test("OAuth or SDK signing rejection receives fixed stage without low-level details", async () => { await rejectStage(fixture({ oauthError: true }), "token_signing_or_oauth"); });
for (const payload of [{ aud: endpoint }, { exp: 1 }, { exp: Math.floor(now / 1000) + 30 }, { iss: "synthetic-invalid" }]) test("invalid ID token is never forwarded: " + Object.keys(payload)[0], async () => { await rejectStage(fixture({ payload }), "token_response_validation"); });
test("malformed token payload JSON gets token response stage", async () => { await rejectStage(fixture({ rawToken: "synthetic.bm90LWpzb24.signature" }), "token_response_validation"); });
test("timeout and pre-start cancellation have different diagnostics", async () => {
  await rejectStage(fixture({ hang: true }), "timeout", { timeoutMs: 10 });
  const controller = new AbortController(); controller.abort(); const f = fixture(); await rejectStage(f, "cancelled", { signal: controller.signal }); assert.equal(f.calls.read, 0);
});
test("in-flight cancellation is preserved and no late token is forwarded", async () => {
  const f = fixture({ hang: true }), controller = new AbortController(); const pending = rejectStage(f, "cancelled", { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await pending; assert.equal(f.calls.exchange, 1);
});
test("configuration failures and staging caller identity checks remain fail-closed", async () => {
  for (const patch of [{ CLOUD_RUN_AUTH_MODE: "IAM" }, { CLOUD_RUN_AUDIENCE: endpoint }, { CLOUD_RUN_CALLER_CREDENTIALS_FILE: undefined }, { CLOUD_RUN_CALLER_CREDENTIALS_FILE: "relative.json" }]) await rejectStage(fixture({ env: patch }), "configuration_validation");
  await rejectStage(fixture({ env: { WMO_DEPLOYMENT_MODE: "staging" } }), "credential_format_validation");
});
test("only privately tagged fixed metadata may reach the log formatter", () => {
  const unsafe = secretError(); assert.deepEqual(diagnostics.diagnostic(unsafe, "classifier_network_transport"), { stage: "classifier_network_transport", code: "CLASSIFIER_NETWORK_ERROR" });
  const evil = new Proxy({}, { get() { throw Error("Must not inspect exception properties"); } }); assert.equal(diagnostics.diagnostic(evil).code, "CLOUD_RUN_AUTH_UNAVAILABLE");
  for (const status of [401, 403, 500]) assert.equal(diagnostics.diagnostic(diagnostics.mark(unsafe, "classifier_http_response", status)).status, status);
  for (const status of ["403", "SYNTHETIC_SECRET", 999, NaN]) assert.equal(Object.hasOwn(diagnostics.diagnostic(diagnostics.mark(unsafe, "classifier_http_response", status)), "status"), false);
  assert.equal(diagnostics.diagnostic(diagnostics.mark(unsafe, "SYNTHETIC_FORGED_STAGE")).stage, "iam_authentication");
});
function analysisFixture({ status = 200, network = false, timeout = false, authError, invalidResponse = false } = {}) {
  const logs = [], calls = { http: 0, local: 0 }, m = { exports: {} };
  const original = { itemName: "Plastic Bottle", category: "Recyclable", explanation: "synthetic explanation", action: "synthetic action", warning: "synthetic warning" };
  const transport = { request(options, callback) {
    calls.http++; const req = new EventEmitter(); req.write = () => {}; req.destroy = error => req.emit("error", error);
    req.end = () => {
      if (timeout) return req.emit("timeout");
      if (network) return req.emit("error", secretError());
      const res = new EventEmitter(); res.statusCode = status; callback(res);
      res.emit("data", JSON.stringify(status !== 200 ? { error: "SYNTHETIC_PROVIDER_BODY_MUST_NOT_LEAK" } : invalidResponse ? { success: false, message: "SYNTHETIC_PROVIDER_BODY_MUST_NOT_LEAK" } : { success: true, result: original })); res.emit("end");
    }; return req;
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../services/wasteAnalysisService.js"), "utf8"), {
    module: m, Buffer, URL, Date, setTimeout, clearTimeout,
    process: { env: { CLOUD_RUN_AUTH_MODE: "iam", GEMINI_CLASSIFIER_URL: endpoint, ALLOW_RENDER_GEMINI_DIRECT: "true" } },
    console: Object.fromEntries(["log", "warn", "error"].map(name => [name, (...args) => logs.push(args)])),
    require(id) {
      if (id === "http" || id === "https") return transport;
      if (id === "./cloudRunDiagnostics") return diagnostics;
      if (id === "./cloudRunAuth") return { invocationHeaders: async () => { if (authError) throw authError; return { Authorization: "Bearer SYNTHETIC_TOKEN_MUST_NOT_LEAK" }; } };
      if (id === "./googleVisionService") return { detectObjectsFromBase64: async () => [], OBJECT_LOCALIZATION_TIMEOUT_MS: 5000 };
      if (id === "./geminiWasteClassifierService") return { classifyWasteWithGemini: async () => { calls.local++; throw Error("No IAM bypass"); } };
      if (id === "./wasteLearningGuideService") return require("../services/wasteLearningGuideService");
      if (id === "../utils/wasteMapper") return require(id);
      throw Error("Unexpected dependency");
    }
  });
  return { analyze: () => m.exports.analyzeWaste({ image: "SYNTHETIC_IMAGE_MUST_NOT_LEAK", detectedObject: "captured_waste_item", mlKitLabels: [] }), calls, logs, original };
}
for (const status of [401, 403]) test("classifier HTTP " + status + " logs only stage/code/status and preserves fallback", async () => {
  const f = analysisFixture({ status }); const result = await f.analyze();
  assert.equal(result.category, "Residual"); assert.equal(result.analysisSource, "fallback_no_ai_result"); assert.equal(f.calls.local, 0);
  const log = f.logs.find(args => args[0] === "[WasteAnalysis] classifier failure"); assert.deepEqual(log[1], { stage: "classifier_http_response", code: "CLASSIFIER_HTTP_ERROR", status });
  assert.doesNotMatch(JSON.stringify(f.logs), /SYNTHETIC_.*MUST_NOT_LEAK/);
});
test("network failure logs constant metadata without exception/body/header details", async () => {
  const f = analysisFixture({ network: true }); await f.analyze(); assert.equal(f.calls.local, 0);
  assert.equal(f.logs.find(args => args[0] === "[WasteAnalysis] classifier failure")[1].stage, "classifier_network_transport"); assert.doesNotMatch(JSON.stringify(f.logs), /SYNTHETIC_.*MUST_NOT_LEAK/);
});
test("IAM stage survives classifier catch and prevents classifier POST and direct Gemini", async () => {
  const error = await fixture({ readError: "ENOENT" }).auth(endpoint).catch(e => e); const f = analysisFixture({ authError: error });
  const result = await f.analyze(); assert.equal(result.category, "Residual"); assert.deepEqual(f.calls, { http: 0, local: 0 });
  assert.equal(f.logs.find(args => args[0] === "[WasteAnalysis] classifier failure")[1].stage, "credential_file_read"); assert.doesNotMatch(JSON.stringify(f.logs), /SYNTHETIC_.*MUST_NOT_LEAK/);
});
test("invalid provider result is diagnosed without logging provider message", async () => {
  const f = analysisFixture({ invalidResponse: true }); await f.analyze(); assert.equal(f.logs.find(args => args[0] === "[WasteAnalysis] classifier failure")[1].stage, "classifier_response_validation"); assert.doesNotMatch(JSON.stringify(f.logs), /SYNTHETIC_.*MUST_NOT_LEAK/);
});
test("successful primary classification remains unchanged with no failure log", async () => {
  const f = analysisFixture(); const result = await f.analyze(); for (const [key, value] of Object.entries(f.original)) assert.equal(result[key], value);
  assert.equal(f.logs.some(args => args[0] === "[WasteAnalysis] classifier failure"), false); assert.equal(f.calls.local, 0);
});
test("real installed JWT and Gaxios work with synthetic key and mocked OAuth fetch only", async () => {
  const { JWT } = require("google-auth-library"); let exchanges = 0;
  class OfflineJWT extends JWT {
    constructor(options) { super(options); this.transporter.defaults.fetchImplementation = async url => {
      exchanges++; assert.equal(String(url), "https://oauth2.googleapis.com/token"); return new Response(JSON.stringify({ id_token: token() }), { status: 200, headers: { "content-type": "application/json" } });
    }; }
  }
  const auth = createCloudRunAuth({ env, now: () => now, readFile: () => JSON.stringify(credentials), loadLibrary: () => ({ JWT: OfflineJWT }) });
  assert.equal((await auth(endpoint)).Authorization, "Bearer " + token()); assert.equal(exchanges, 1);
});

test("classifier socket timeout preserves fixed timeout diagnostic and fallback", async () => {
  const f = analysisFixture({ timeout: true }); const result = await f.analyze();
  assert.equal(result.category, "Residual"); assert.equal(f.calls.local, 0);
  assert.deepEqual(f.logs.find(args => args[0] === "[WasteAnalysis] classifier failure")[1], { stage: "timeout", code: "CLOUD_RUN_REQUEST_TIMEOUT" });
  assert.doesNotMatch(JSON.stringify(f.logs), /SYNTHETIC_.*MUST_NOT_LEAK/);
});
