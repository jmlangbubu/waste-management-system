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
