"use strict";

const { SafetyError } = require("./environment.cjs");
const DEPENDENCIES = Object.freeze(["poolFactory", "observerFactory", "serviceFactory", "routeLoader", "clock", "sessionService"]);
function refused() { throw new SafetyError("PHASE4A_RUNTIME_DISABLED"); }
function createDeferredRuntime(dependencies = {}) {
  // Retain no executable hooks. Activation needs a separately reviewed implementation.
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(dependencies))) throw new SafetyError("RUNTIME_CONTRACT_INVALID");
  let descriptors = Object.getOwnPropertyDescriptors(dependencies);
  if (Object.keys(descriptors).some(k => !DEPENDENCIES.includes(k)) ||
      Object.values(descriptors).some(p => !Object.hasOwn(p, "value") || typeof p.value !== "function")) {
    throw new SafetyError("RUNTIME_CONTRACT_INVALID");
  }
  const description = Object.freeze({ phase: "4A", active: false, databaseAccess: false,
    requiredBoundaries: DEPENDENCIES, suppliedBoundaries: Object.freeze(Object.keys(descriptors)) });
  descriptors = null; dependencies = null;
  return Object.freeze({
    describe: () => description,
    activate: refused, connect: refused, loadRoutes: refused, executeFixtures: refused,
    dispose: () => Object.freeze({ activated: false, externalCleanupPerformed: false })
  });
}
function createProviderGuards() {
  const counts = { email: 0, sms: 0, analytics: 0, http: 0, socket: 0 };
  const deny = kind => () => { counts[kind]++; throw new SafetyError("OUTBOUND_PROVIDER_BLOCKED"); };
  return Object.freeze({ email: Object.freeze({ send: deny("email") }), sms: Object.freeze({ send: deny("sms") }),
    analytics: Object.freeze({ track: deny("analytics") }), http: Object.freeze({ request: deny("http") }),
    socket: Object.freeze({ emit: deny("socket") }), counts: () => Object.freeze({ ...counts }) });
}
module.exports = { createDeferredRuntime, createProviderGuards };
function phase4BCapabilities() {
  return Object.freeze({ phase: "4B", selfCheck: "offline", plan: "offline", provision: "native-unsupported",
    verify: "native-unsupported", attest: "native-unsupported", teardown: "native-unsupported",
    requiredScopes: Object.freeze({ provision: "provision", verify: "verify", attest: "attest", teardown: "teardown" }),
    nativeExecutionAvailable: false, writeAccess: false, databaseAccess: false });
}
function createMockDisposableRuntime(configuration, transport) {
  // Loading this adapter is inert. No production router, database pool or provider client is imported.
  const disposable = require("./disposable.cjs");
  const lifecycle = disposable.createMockLifecycle(configuration, transport);
  return Object.freeze({ lifecycle, capabilities: phase4BCapabilities,
    integrationContract: () => Object.freeze({
      applicationService: "services/appointmentSchedulingService.js", productionPoolAllowed: false,
      poolFactory: "requires-reviewed-disposable-connection-adapter", observerFactory: "separate-read-only-account",
      clock: "explicit-fixed-clock", sessionIdentity: "synthetic-only", routeLoader: "unsupported",
      featureEnablement: "test-constructor-injection-only", productionEnvironmentMutation: false
    }),
    openPools: disposable.createNativeLifecycle, loadRoutes: disposable.createNativeLifecycle,
    providers: createProviderGuards()
  });
}
Object.assign(module.exports, { phase4BCapabilities, createMockDisposableRuntime });
async function nativeSmoke(io = { stdout: process.stdout, stderr: process.stderr }, input = process.stdin) {
  const host = require("./nativeHost.cjs");
  host.requireOwnerTrust(); // Deliberately before stdin listeners, challenge randomness or any native transport.
  const native = require("./nativeLifecycle.cjs");
  let buffer = "", pending, closed = false, frames = 0;
  const accept = () => {
    if (!pending || !buffer.includes("\n")) return;
    const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    const waiter = pending; pending = null; clearTimeout(waiter.timer);
    try { frames++; host.check(frames <= 2, "AUTH_INVALID"); waiter.resolve(host.data(JSON.parse(line))); }
    catch (_) { waiter.reject(new host.NativeError("AUTH_INVALID")); }
  };
  const fail = () => { closed = true; if (pending) { clearTimeout(pending.timer); pending.reject(new host.NativeError("AUTH_INVALID")); pending = null; } };
  const receive = chunk => { buffer += chunk.toString("utf8"); if (Buffer.byteLength(buffer) > 131072) fail(); else accept(); };
  function frame() { return new Promise((resolve, reject) => {
    if (closed) return reject(new host.NativeError("AUTH_INVALID"));
    pending = { resolve, reject, timer: setTimeout(fail, 120000) }; accept();
  }); }
  input.on("data", receive); input.on("end", fail); input.on("error", fail);
  try {
    const config = await frame(), challenge = native.createNativeChallenge(config);
    io.stdout.write(JSON.stringify({ classification: "unsigned-challenge-not-authority", nonce: challenge.nonce }) + "\n");
    const receipt = await frame(), lifecycle = native.createNativeLifecycle(challenge, receipt);
    try { return await native.smoke(lifecycle); }
    catch (caught) {
      // Only the coordinator's fixed, sanitized evidence is reportable; never serialize a native exception or SQL.
      io.stdout.write(JSON.stringify({ outcome: "failed", ...lifecycle.describe() }) + "\n"); throw host.error(caught);
    }
  } finally { fail(); input.removeListener("data", receive); input.removeListener("end", fail); input.removeListener("error", fail); input.pause(); }
}
module.exports.nativeSmoke = nativeSmoke;
