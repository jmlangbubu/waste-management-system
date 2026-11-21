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
