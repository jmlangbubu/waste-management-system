"use strict";

// Pure evidence validation only. These checks do not discover or authenticate a server.
const BASELINE = "97872ea96e3cf01035f3dac52a5fadfe74e63a72";
const IMAGE = "mysql:9.7.2-oraclelinux9";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PURPOSE = "wmo-appointment-disposable";
const RESOURCE_KINDS = Object.freeze(["container", "network", "volume"]);
const IDENTITY_ERROR_CODES = new Set(["IDENTITY_INVALID", "OWNERSHIP_INVALID", "SCHEMA_INVALID", "FIXTURE_INVALID",
  "AUTHORIZATION_REQUIRED", "IMAGE_UNVERIFIED", "CREDENTIAL_SCOPE_INVALID", "ENDPOINT_INVALID"]);
class SafetyError extends Error {
  constructor(code) { super(`Offline harness refused: ${code}. No action was performed.`); this.name = "SafetyError"; this.code = code; }
}
function normalizedIdentityError(error, fallback) {
  let code = fallback;
  try {
    const descriptor = error && Object.getOwnPropertyDescriptor(error, "code");
    if (descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string" && IDENTITY_ERROR_CODES.has(descriptor.value)) code = descriptor.value;
  } catch (_) { /* A caught Proxy or accessor is not trusted diagnostic evidence. */ }
  // Never retain the supplied message, stack, cause, custom fields or error identity.
  return new SafetyError(code);
}
function check(value, code = "IDENTITY_INVALID") { if (!value) throw new SafetyError(code); }
function record(value, keys) {
  check(value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const properties = Object.getOwnPropertyDescriptors(value);
  check(Object.values(properties).every(p => Object.hasOwn(p, "value")));
  check(Object.keys(properties).every(k => keys.includes(k)));
  return value;
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function inputData(value, depth = 0) {
  check(depth <= 7);
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  check(value && typeof value === "object" && Object.getOwnPropertySymbols(value).length === 0 &&
    (Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value))));
  const properties = Object.getOwnPropertyDescriptors(value);
  check(Object.keys(properties).length <= 64 && Object.values(properties).every(p => Object.hasOwn(p, "value")));
  if (Array.isArray(value)) {
    check(value.length <= 32 && Object.keys(properties).length === value.length + 1);
    return Array.from({ length: value.length }, (_, i) => inputData(properties[i].value, depth + 1));
  }
  return Object.fromEntries(Object.entries(properties).map(([k, p]) => [k, inputData(p.value, depth + 1)]));
}
function labels(value, runId) {
  record(value, ["wmo.test.purpose", "wmo.test.run"]);
  check(value["wmo.test.purpose"] === PURPOSE && value["wmo.test.run"] === runId, "OWNERSHIP_INVALID");
}
function endpoint(value) {
  record(value, ["host", "port", "containerPort", "protocol"]);
  // Literal IPv4 loopback only: localhost/DNS, URLs, sockets and alternate addresses are not admitted.
  check(value.host === "127.0.0.1" && value.protocol === "tcp" && value.containerPort === 3306 &&
    Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535, "ENDPOINT_INVALID");
}
function configuration(value, stage) {
  const c = record(value, ["authorization", "runId", "containerId", "labels", "image", "schema", "serverUuid", "endpoint",
    "networkId", "volumeName", "fixtureFingerprint", "credentials", "permittedSchemas", "sourceCommit"]);
  check(UUID.test(c.runId) && ID.test(c.containerId) && ID.test(c.networkId) && UUID.test(c.serverUuid));
  check(c.schema === `wmo_synthetic_${c.runId.replace(/-/g, "")}`, "SCHEMA_INVALID");
  check(c.volumeName === `wmo_appointments_${c.runId.replace(/-/g, "")}_data`, "OWNERSHIP_INVALID");
  check(c.sourceCommit === BASELINE && DIGEST.test(c.fixtureFingerprint), "FIXTURE_INVALID");
  labels(c.labels, c.runId); endpoint(c.endpoint);
  record(c.authorization, ["approved", "phase", "scope", "runId"]);
  check(c.authorization.approved === true && c.authorization.phase === "4B" &&
    c.authorization.scope === stage && c.authorization.runId === c.runId, "AUTHORIZATION_REQUIRED");
  record(c.image, ["reference", "digest", "verified"]);
  check(c.image.reference === IMAGE && DIGEST.test(c.image.digest) && c.image.verified === true, "IMAGE_UNVERIFIED");
  const cr = record(c.credentials, ["origin", "testOnly", "schema", "applicationAccount", "setupAccount", "observerAccount", "scopeVerified"]);
  check(cr.origin === "new-disposable-only" && cr.testOnly === true && cr.scopeVerified === true && cr.schema === c.schema, "CREDENTIAL_SCOPE_INVALID");
  const accounts = [cr.applicationAccount, cr.setupAccount, cr.observerAccount];
  check(accounts.every(a => typeof a === "string" && /^wmo_test_[a-z0-9_]{1,20}$/.test(a)) && new Set(accounts).size === 3, "CREDENTIAL_SCOPE_INVALID");
  check(Array.isArray(c.permittedSchemas) && c.permittedSchemas.length === 1 && c.permittedSchemas[0] === c.schema, "SCHEMA_INVALID");
  return c;
}
function verifyIdentity(value, observed, stage) {
  try {
    const c = configuration(inputData(value), stage);
    const o = record(inputData(observed), ["runId", "containerId", "labels", "imageReference", "imageDigest", "networkId", "volumeName",
      "networkInternal", "networkDedicated", "bindings", "endpoint", "serverUuid", "selectedSchema", "permittedSchemas",
      "credentialScopeVerified", "schemaEmpty", "marker"]);
    check(o.runId === c.runId && o.containerId === c.containerId && o.networkId === c.networkId && o.volumeName === c.volumeName, "OWNERSHIP_INVALID");
    labels(o.labels, c.runId); endpoint(o.endpoint);
    check(o.imageReference === c.image.reference && o.imageDigest === c.image.digest, "IMAGE_UNVERIFIED");
    check(o.networkInternal === true && o.networkDedicated === true, "ENDPOINT_INVALID");
    check(o.endpoint.host === c.endpoint.host && o.endpoint.port === c.endpoint.port &&
      o.endpoint.containerPort === c.endpoint.containerPort && o.endpoint.protocol === c.endpoint.protocol, "ENDPOINT_INVALID");
    check(Array.isArray(o.bindings) && o.bindings.length === 1, "ENDPOINT_INVALID");
    endpoint(o.bindings[0]);
    check(["host", "port", "containerPort", "protocol"].every(k => o.bindings[0][k] === o.endpoint[k]), "ENDPOINT_INVALID");
    check(o.serverUuid === c.serverUuid && o.selectedSchema === c.schema, "SCHEMA_INVALID");
    check(o.credentialScopeVerified === true && Array.isArray(o.permittedSchemas) &&
      o.permittedSchemas.length === 1 && o.permittedSchemas[0] === c.schema, "CREDENTIAL_SCOPE_INVALID");
    if (stage === "provisioning-identity") check(o.schemaEmpty === true && o.marker === undefined, "FIXTURE_INVALID");
    else {
      check(o.schemaEmpty === false, "FIXTURE_INVALID");
      const marker = record(o.marker, ["runId", "schema", "syntheticOnly", "fingerprint", "sourceCommit", "reconciled"]);
      check(marker.runId === c.runId && marker.schema === c.schema && marker.syntheticOnly === true &&
        marker.fingerprint === c.fixtureFingerprint && marker.sourceCommit === BASELINE && marker.reconciled === true, "FIXTURE_INVALID");
    }
    return freeze({ stage, runId: c.runId, schema: c.schema, containerId: c.containerId,
      offlineOnly: true, writeAccess: false, independentlyObservedHere: false });
  } catch (error) { throw normalizedIdentityError(error, "IDENTITY_INVALID"); }
}
const verifyProvisioningIdentity = (c, o) => verifyIdentity(c, o, "provisioning-identity");
const verifyRuntimeIdentity = (c, o) => verifyIdentity(c, o, "runtime-identity");
function planOwnedTeardown(value, observedResources) {
  try {
    value = inputData(value); observedResources = inputData(observedResources);
    // Inspect descriptors before reading authorization; untrusted getters are not evidence.
    const authorization = value && Object.getOwnPropertyDescriptor(value, "authorization");
    check(authorization && Object.hasOwn(authorization, "value"), "AUTHORIZATION_REQUIRED");
    const scope = authorization.value && Object.getOwnPropertyDescriptor(authorization.value, "scope");
    check(scope && Object.hasOwn(scope, "value"), "AUTHORIZATION_REQUIRED");
    const c = configuration(value, scope.value);
    check(["provisioning-identity", "runtime-identity"].includes(c.authorization.scope), "AUTHORIZATION_REQUIRED");
    check(Array.isArray(observedResources) && observedResources.length === 3, "OWNERSHIP_INVALID");
    const expected = { container: c.containerId, network: c.networkId, volume: c.volumeName };
    const seen = new Set();
    for (const r of observedResources) {
      record(r, ["kind", "id", "labels"]); labels(r.labels, c.runId);
      check(typeof r.kind === "string" && RESOURCE_KINDS.includes(r.kind), "OWNERSHIP_INVALID");
      check(!seen.has(r.kind) && r.id === expected[r.kind], "OWNERSHIP_INVALID");
      seen.add(r.kind);
    }
    check(seen.size === RESOURCE_KINDS.length && RESOURCE_KINDS.every(kind => seen.has(kind)), "OWNERSHIP_INVALID");
    return freeze({ executable: false, requiresSeparateAuthorization: true, runId: c.runId,
      resources: Object.entries(expected).map(([kind, id]) => ({ kind, id })) });
  } catch (error) { throw normalizedIdentityError(error, "OWNERSHIP_INVALID"); }
}
function buildChildEnvironment(source = {}) {
  const result = { NODE_ENV: "test", TZ: "UTC", WMO_APPOINTMENT_HARNESS_PHASE: "4A" };
  // Read only these OS plumbing values. Never enumerate/read the parent's other values.
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    const p = Object.getOwnPropertyDescriptor(source, key);
    if (!p) continue;
    check(Object.hasOwn(p, "value") && typeof p.value === "string" && p.value.length <= 1024 && !/[\0\r\n]/.test(p.value), "CHILD_ENV_INVALID");
    result[key] = p.value;
  }
  return freeze(result);
}
function assertInertCompose(text) {
  check(typeof text === "string", "COMPOSE_NOT_INERT");
  const roots = text.split(/\r?\n/).filter(line => line.trim() && !line.startsWith("#") && !/^\s/.test(line));
  check(roots.length === 2 && roots.includes("services: {}") && roots.includes("x-wmo-appointment-phase4a:"), "COMPOSE_NOT_INERT");
  check(!/(?:^|\s)(?:!!|&|\*)/.test(text), "COMPOSE_NOT_INERT");
  return freeze({ executableStack: false, services: 0, provisioningAuthorized: false });
}
module.exports = { BASELINE, IMAGE, PURPOSE, SafetyError, verifyProvisioningIdentity, verifyRuntimeIdentity,
  planOwnedTeardown, buildChildEnvironment, assertInertCompose };
