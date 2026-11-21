"use strict";

const assert = require("node:assert/strict");
const environment = require("./helpers/environment.cjs");
const schema = require("./helpers/schema.cjs");
const runtime = require("./helpers/runtime.cjs");
const control = require("./helpers/control.cjs");
const invariants = require("./helpers/assertions.cjs");

async function selfCheck() {
  const checks = [];
  const run = async (name, operation) => { await operation(); checks.push(name); };
  await run("identity-refusal", () => assert.throws(() => environment.verifyRuntimeIdentity({}, {}), environment.SafetyError));
  await run("inert-fixtures", () => {
    const fixture = schema.fixtureSpecification();
    assert.equal(Object.keys(fixture.tables).length, 5); assert.equal(fixture.marker.backfill_complete, 0);
    assert.equal(fixture.executable, false); assert.match(fixture.fingerprint, /^sha256:[0-9a-f]{64}$/);
  });
  await run("runtime-locked", () => {
    const deferred = runtime.createDeferredRuntime();
    assert.equal(deferred.describe().active, false);
    assert.throws(() => deferred.activate(), { code: "PHASE4A_RUNTIME_DISABLED" });
  });
  await run("provider-refusal", () => assert.throws(() => runtime.createProviderGuards().email.send(), { code: "OUTBOUND_PROVIDER_BLOCKED" }));
  await run("bounded-synchronization", () => control.withControls(async controls => {
    const gate = controls.barrier("self-check");
    const waiting = gate.wait(); await gate.reached(); gate.release(); await waiting;
    assert.equal(controls.inspect().pending, 0);
  }));
  await run("snapshot-invariants", () => {
    const empty = { appointments: [], reservations: [], requests: [], notifications: [] };
    assert.equal(invariants.assertBookingDelta(empty, empty, 0), true);
  });
  await run("philippine-midnight", () => assert.equal(invariants.assertPhilippineSnapshot("2026-11-20T16:00:00Z",
    { date: "2026-11-21", timestamp: "2026-11-21 00:00:00" }), true));
  await run("offline-evidence", () => {
    const evidence = invariants.createOfflineEvidence({ testId: "P4A.self_check", sourceCommit: environment.BASELINE,
      reportedEngineVersion: null, fixtureVariant: "offline", runId: "00000000-0000-0000-0000-000000000000", outcome: "pass",
      counts: { modelQueries: 0, databaseQueries: 0, leases: 0, releaseAttempts: 0, destroyAttempts: 0 },
      checks: ["capacity"], failureClassification: "none", cleanup: "not-needed" });
    assert.equal(evidence.persistence.durableVerified, false); assert.equal(evidence.engine.connected, false);
  });
  return Object.freeze({ phase: "4A", outcome: "pass", checks: Object.freeze(checks), databaseEvidence: false });
}
async function main(args, io = { stdout: process.stdout, stderr: process.stderr }) {
  if (Array.isArray(args) && args.length === 1 && args[0] === "--plan") {
    io.stdout.write(JSON.stringify({ phase: "4B", classification: "offline-preparation", capabilities: runtime.phase4BCapabilities(),
      candidateImage: environment.IMAGE, approvedIndexDigest: null, approvedPlatformDigest: null,
      fixtureProfile: environment.PHASE4B_PROFILE, fixtureFingerprint: schema.provisioningFingerprint(),
      applicationCommit: environment.BASELINE, harnessCommit: "must-be-observed-from-clean-reviewed-checkout",
      prerequisites: ["reviewed-execution-scope", "node-22.23.5", "local-linux-engine-at-least-28", "official-registry-proof",
        "windows-isolation-proof", "credential-acl-and-grants-adapter", "trusted-native-observation-adapter"],
      performsExternalOperations: false, writeAccess: false }) + "\n");
    return 0;
  }
  if (Array.isArray(args) && args.length === 1 && ["--provision", "--verify", "--attest", "--teardown"].includes(args[0])) {
    io.stderr.write("PHASE4A_MODE_REFUSED: PHASE4B_NATIVE_UNSUPPORTED; no reviewed native execution authority or transport is installed. No operation was performed.\n");
    return 2;
  }
  if (!Array.isArray(args) || args.length !== 1 || args[0] !== "--self-check") {
    io.stderr.write("PHASE4A_MODE_REFUSED: only --self-check is available. Database and provisioning execution are not authorized.\n");
    return 2;
  }
  try {
    const result = await selfCheck();
    io.stdout.write(`PHASE4A_OFFLINE_SELF_CHECK_PASS: ${result.checks.length} checks. No MySQL compatibility or durable-state evidence.\n`);
    return 0;
  } catch (_) {
    io.stderr.write("PHASE4A_SELF_CHECK_FAILED: offline safety checks did not pass.\n");
    return 1;
  }
}
if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { process.stderr.write("PHASE4A_SELF_CHECK_FAILED\n"); process.exitCode = 1; });
}
module.exports = { main, selfCheck };
