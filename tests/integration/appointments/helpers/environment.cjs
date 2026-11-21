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
// Phase 4B contracts are pure DTO validation. They never attest that observations are real.
const PHASE4B_PROFILE = "wmo-appointments-p4b-v1";
const APPLICATION_FILES = freeze({
  "services/appointmentSchedulingService.js": "d2b94ccbb3e3452062a2b4178bd523d8b7b6a09321cf611afdf5a531d8bf5bd9",
  "services/appointmentPolicy.js": "f173bc45067753f8e77d38b82d00710d07dec6f48ba988732f5d6589cffd1b44",
  "package-lock.json": "626e12da093e5c32c47851f38813d80db9e9bb8cab9a54b44126df73f5420427"
});
const P4B_CODES = new Set(["P4B_CONFIG_INVALID", "P4B_CONTEXT_INVALID", "P4B_IMAGE_INVALID", "P4B_RESOURCE_INVALID",
  "P4B_SOURCE_INVALID", "P4B_SERVER_INVALID", "P4B_GRANTS_INVALID", "P4B_FIXTURE_INVALID", "P4B_SCOPE_INVALID",
  "P4B_STAGE_INVALID", "P4B_RECONCILIATION_INVALID", "P4B_ATTESTATION_INVALID", "P4B_CLEANUP_INVALID",
  "P4B_ADAPTER_FAILED", "P4B_NATIVE_UNSUPPORTED", "P4B_EVIDENCE_INVALID", "P4B_COMPOSE_INVALID"]);
function p4bError(error, fallback = "P4B_CONFIG_INVALID") {
  let code = fallback;
  try { const p = error && Object.getOwnPropertyDescriptor(error, "code"); if (p && Object.hasOwn(p, "value") && P4B_CODES.has(p.value)) code = p.value; } catch (_) { /* Untrusted diagnostics. */ }
  return new SafetyError(code);
}
function p4bCheck(condition, code = "P4B_CONFIG_INVALID") { if (!condition) throw new SafetyError(code); }
function p4bData(value, depth = 0) {
  p4bCheck(depth <= 12);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") { p4bCheck(value.length <= 65536); return value; }
  if (typeof value === "number") { p4bCheck(Number.isFinite(value)); return value; }
  p4bCheck(value && typeof value === "object" && !Object.getOwnPropertySymbols(value).length &&
    (Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value))));
  const ds = Object.getOwnPropertyDescriptors(value);
  p4bCheck(Object.keys(ds).length <= 512 && Object.values(ds).every(p => Object.hasOwn(p, "value")));
  if (Array.isArray(value)) {
    p4bCheck(value.length <= 511 && Object.keys(ds).length === value.length + 1);
    return Array.from({ length: value.length }, (_, i) => p4bData(ds[i].value, depth + 1));
  }
  return Object.fromEntries(Object.entries(ds).map(([k, p]) => [k, p4bData(p.value, depth + 1)]));
}
function exactKeys(value, keys, code = "P4B_CONFIG_INVALID") {
  p4bCheck(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length &&
    keys.every(k => Object.hasOwn(value, k)), code);
}
const same = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && same(a[k], b[k]));
};
const HEX40 = /^[0-9a-f]{40}$/, HEX64 = /^[0-9a-f]{64}$/;
function runNames(runId) {
  p4bCheck(typeof runId === "string" && UUID.test(runId));
  const compact = runId.replace(/-/g, ""), suffix = compact.slice(0, 10), prefix = "wmo_appointments_" + compact;
  return freeze({ container: prefix + "_mysql", network: prefix + "_net", volume: prefix + "_data",
    setup: "wmo_test_setup_" + suffix, application: "wmo_test_app_" + suffix, observer: "wmo_test_observer_" + suffix });
}
function validatePhase4BConfiguration(input) {
  try {
    const c = p4bData(input);
    exactKeys(c, ["runId", "schema", "docker", "node", "image", "endpoint", "source", "fixture", "accounts", "secretDirectory"]);
    const names = runNames(c.runId);
    p4bCheck(c.schema === "wmo_synthetic_" + c.runId.replace(/-/g, ""));
    exactKeys(c.docker, ["context", "endpoint", "executable", "executableHash"]);
    p4bCheck(typeof c.docker.context === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(c.docker.context));
    p4bCheck(["npipe:////./pipe/dockerDesktopLinuxEngine", "npipe:////./pipe/docker_engine"].includes(c.docker.endpoint));
    p4bCheck(typeof c.docker.executable === "string" && /^[A-Z]:\\[^<>"|?*\r\n]+\\docker\.exe$/.test(c.docker.executable) && HEX64.test(c.docker.executableHash));
    exactKeys(c.node, ["executable", "version", "executableHash"]);
    p4bCheck(typeof c.node.executable === "string" && /^[A-Z]:\\[^<>"|?*\r\n]+\\node\.exe$/.test(c.node.executable) &&
      c.node.version === "22.23.5" && HEX64.test(c.node.executableHash));
    p4bCheck(typeof c.secretDirectory === "string" && /^[A-Z]:\\[^<>"|?*\r\n]+$/.test(c.secretDirectory) &&
      !c.secretDirectory.split("\\").some(p => p === "." || p === "..") &&
      c.secretDirectory.endsWith("\\wmo_appointments_" + c.runId.replace(/-/g, "") + "_secrets"));
    exactKeys(c.image, ["reference", "indexDigest", "platformDigest", "configDigest", "os", "architecture", "version", "distribution", "osId", "osVersion"]);
    p4bCheck(c.image.reference === IMAGE && [c.image.indexDigest, c.image.platformDigest, c.image.configDigest].every(x => typeof x === "string" && DIGEST.test(x)) &&
      new Set([c.image.indexDigest, c.image.platformDigest, c.image.configDigest]).size === 3 &&
      c.image.os === "linux" && ["amd64", "arm64"].includes(c.image.architecture) &&
      c.image.version === "9.7.2" && c.image.distribution === "MySQL Community Server - GPL" && c.image.osId === "ol" && c.image.osVersion === "9", "P4B_IMAGE_INVALID");
    endpoint(c.endpoint);
    exactKeys(c.source, ["applicationCommit", "harnessCommit", "applicationFiles", "harnessManifestHash"]);
    p4bCheck(c.source.applicationCommit === BASELINE && HEX40.test(c.source.harnessCommit) &&
      HEX64.test(c.source.harnessManifestHash) && same(c.source.applicationFiles, APPLICATION_FILES), "P4B_SOURCE_INVALID");
    exactKeys(c.fixture, ["profile", "fingerprint"]);
    p4bCheck(c.fixture.profile === PHASE4B_PROFILE && DIGEST.test(c.fixture.fingerprint), "P4B_FIXTURE_INVALID");
    exactKeys(c.accounts, ["setup", "application", "observer"]);
    p4bCheck(Object.keys(c.accounts).every(role => c.accounts[role] === names[role]), "P4B_GRANTS_INVALID");
    return freeze(c);
  } catch (error) { throw p4bError(error); }
}
function validatePhase4BHost(input, observation) {
  try {
    const c = validatePhase4BConfiguration(input), o = p4bData(observation);
    exactKeys(o, ["context", "endpoint", "engineVersion", "os", "architecture", "daemonId", "dockerExecutableHash", "node", "source"], "P4B_CONTEXT_INVALID");
    p4bCheck(o.context === c.docker.context && o.endpoint === c.docker.endpoint && /^(?:0|[1-9]\d{0,2})\.\d{1,3}\.\d{1,3}$/.test(o.engineVersion) &&
      Number(o.engineVersion.split(".")[0]) >= 28 && o.os === "linux" && o.architecture === c.image.architecture &&
      typeof o.daemonId === "string" && /^[a-zA-Z0-9:-]{8,128}$/.test(o.daemonId) && o.dockerExecutableHash === c.docker.executableHash, "P4B_CONTEXT_INVALID");
    p4bCheck(same(o.node, c.node), "P4B_SOURCE_INVALID");
    exactKeys(o.source, ["clean", "applicationCommit", "harnessCommit", "applicationFiles", "harnessManifestHash"], "P4B_SOURCE_INVALID");
    p4bCheck(o.source.clean === true && same({ ...o.source, clean: undefined }, { ...c.source, clean: undefined }), "P4B_SOURCE_INVALID");
    return freeze({ offlineOnly: true, writeAccess: false, independentlyObservedHere: false, daemonId: o.daemonId });
  } catch (error) { throw p4bError(error); }
}
function expectedPhase4BGrants(input, stage = "runtime") {
  const c = validatePhase4BConfiguration(input);
  p4bCheck(["provisioning", "runtime"].includes(stage), "P4B_GRANTS_INVALID");
  const tables = ["appointments", "notifications", "appointment_reservations", "appointment_booking_requests", "appointment_feature_state", "appointment_harness_identity"];
  const grant = (account, rights) => ({ account, global: [], roles: [], rights });
  const setup = Object.fromEntries(tables.map(t => [t, ["CREATE", "INSERT", "SELECT",
    ...(t === "appointments" ? ["REFERENCES"] : []), ...(t === "appointment_feature_state" ? ["UPDATE(backfill_complete)"] : []),
    ...(t === "appointment_harness_identity" ? ["UPDATE(reconciled)"] : [])].sort()]));
  const app = { appointments: ["INSERT", "SELECT", "UPDATE"], appointment_reservations: ["DELETE", "INSERT", "SELECT", "UPDATE"],
    appointment_booking_requests: ["INSERT", "SELECT", "UPDATE"], notifications: ["INSERT"], appointment_feature_state: ["SELECT"] };
  const scoped = rights => Object.entries(rights).map(([table, privileges]) => ({ schema: c.schema, table, privileges }));
  return freeze({ setup: grant(c.accounts.setup, scoped(setup)), application: grant(c.accounts.application, scoped(stage === "runtime" ? app : {})),
    observer: grant(c.accounts.observer, scoped(stage === "runtime" ? Object.fromEntries(tables.map(t => [t, ["SELECT"]])) : {})) });
}
function validatePhase4BGrants(c, observed, stage = "runtime") {
  try {
    const o = p4bData(observed), expected = expectedPhase4BGrants(c, stage);
    // These are normalized effective privileges, not unparsed SHOW GRANTS strings.
    p4bCheck(same(o, expected), "P4B_GRANTS_INVALID");
    return freeze({ offlineOnly: true, writeAccess: false, independentlyObservedHere: false });
  } catch (error) { throw p4bError(error); }
}
function validatePhase4BResources(input, observation) {
  try {
    const c = validatePhase4BConfiguration(input), rs = p4bData(observation), n = runNames(c.runId);
    p4bCheck(Array.isArray(rs) && rs.length === 3, "P4B_RESOURCE_INVALID");
    const kinds = new Set();
    for (const r of rs) {
      p4bCheck(typeof r.kind === "string" && RESOURCE_KINDS.includes(r.kind) && !kinds.has(r.kind), "P4B_RESOURCE_INVALID"); kinds.add(r.kind);
      p4bCheck(r.name === n[r.kind] && same(r.labels, { "wmo.test.purpose": PURPOSE, "wmo.test.run": c.runId }), "P4B_RESOURCE_INVALID");
      if (r.kind === "volume") {
        exactKeys(r, ["kind", "id", "name", "labels", "driver", "scope"], "P4B_RESOURCE_INVALID");
        p4bCheck(r.id === n.volume && r.driver === "local" && r.scope === "local", "P4B_RESOURCE_INVALID");
      } else if (r.kind === "network") {
        exactKeys(r, ["kind", "id", "name", "labels", "driver", "internal", "ipv6", "members"], "P4B_RESOURCE_INVALID");
        p4bCheck(ID.test(r.id) && r.driver === "bridge" && r.internal === true && r.ipv6 === false &&
          same(r.members, rs.filter(v => v.kind === "container").map(v => v.id)), "P4B_RESOURCE_INVALID");
      } else {
        exactKeys(r, ["kind", "id", "name", "labels", "imageConfig", "networkId", "ports", "mounts", "privileged", "networkMode", "restart", "cpus", "memory", "mysqlx"], "P4B_RESOURCE_INVALID");
        p4bCheck(ID.test(r.id) && r.imageConfig === c.image.configDigest && r.networkId === rs.find(v => v.kind === "network")?.id &&
          same(r.ports, [c.endpoint]) && r.privileged === false && r.networkMode === "bridge" && r.restart === "no" &&
          r.cpus === 2 && r.memory === 1073741824 && r.mysqlx === false, "P4B_RESOURCE_INVALID");
        p4bCheck(same(r.mounts, [
          { type: "volume", source: n.volume, target: "/var/lib/mysql", readOnly: false },
          { type: "bind", source: c.secretDirectory + "\\root-password", target: "/run/secrets/wmo-root-password", readOnly: true },
          { type: "bind", source: c.secretDirectory + "\\root-client", target: "/run/secrets/wmo-root-client", readOnly: true }
        ]), "P4B_RESOURCE_INVALID");
      }
    }
    p4bCheck(kinds.size === 3 && new Set(rs.map(r => r.id)).size === 3, "P4B_RESOURCE_INVALID");
    return freeze({ offlineOnly: true, writeAccess: false, independentlyObservedHere: false });
  } catch (error) { throw p4bError(error); }
}
function validatePhase4BServer(input, observation, expectedUuid, emptySchema = false) {
  try {
    const c = validatePhase4BConfiguration(input), o = p4bData(observation);
    exactKeys(o, ["uuid", "schema", "version", "distribution", "osId", "osVersion", "socket", "tables"], "P4B_SERVER_INVALID");
    p4bCheck(typeof expectedUuid === "string" && UUID.test(expectedUuid) && o.uuid === expectedUuid && o.schema === c.schema &&
      o.version === c.image.version && o.distribution === c.image.distribution && o.osId === c.image.osId &&
      o.osVersion === c.image.osVersion && same(o.socket, c.endpoint) && Array.isArray(o.tables), "P4B_SERVER_INVALID");
    p4bCheck(!emptySchema || o.tables.length === 0, "P4B_SERVER_INVALID");
    return freeze({ offlineOnly: true, writeAccess: false, independentlyObservedHere: false });
  } catch (error) { throw p4bError(error); }
}
function phase4bComposeTemplate() {
  const required = key => "$" + "{" + key + ":?Required reviewed Phase 4B input}";
  const labels = { "wmo.test.purpose": PURPOSE, "wmo.test.run": required("WMO_RUN_ID") };
  return {
    services: { mysql: { profiles: ["wmo-disposable"], image: IMAGE + "@" + required("WMO_MYSQL_PLATFORM_DIGEST"),
      platform: "linux/" + required("WMO_MYSQL_ARCH"), container_name: "wmo_appointments_" + required("WMO_RUN_COMPACT") + "_mysql",
      command: ["--mysqlx=0"], restart: "no", privileged: false, cpus: 2, mem_limit: "1024m",
      environment: { MYSQL_ROOT_PASSWORD_FILE: "/run/secrets/wmo-root-password", MYSQL_ROOT_HOST: "localhost" },
      ports: [{ target: 3306, published: required("WMO_MYSQL_HOST_PORT"), host_ip: "127.0.0.1", protocol: "tcp" }],
      networks: ["owned"], volumes: [{ type: "volume", source: "owned", target: "/var/lib/mysql" }],
      secrets: ["wmo-root-password", "wmo-root-client"], labels } },
    networks: { owned: { name: "wmo_appointments_" + required("WMO_RUN_COMPACT") + "_net", driver: "bridge", internal: true, enable_ipv6: false, labels } },
    volumes: { owned: { name: "wmo_appointments_" + required("WMO_RUN_COMPACT") + "_data", driver: "local", labels } },
    secrets: { "wmo-root-password": { file: required("WMO_ROOT_PASSWORD_FILE") }, "wmo-root-client": { file: required("WMO_ROOT_CLIENT_FILE") } },
    "x-wmo-appointment-phase4b": { execution_scope: required("WMO_EXECUTION_SCOPE"), image_index_digest: required("WMO_MYSQL_INDEX_DIGEST"),
      image_config_digest: required("WMO_MYSQL_CONFIG_DIGEST"), synthetic_schema: required("WMO_SYNTHETIC_SCHEMA"),
      default_execution: "disabled", native_adapter: "unsupported", profiles_are_not_authorization: true }
  };
}
function assertPhase4BCompose(text) {
  try {
    // Fixed JSON is a YAML subset. Exact canonical bytes avoid YAML tags, merges, duplicate-key ambiguity and parser dependencies.
    p4bCheck(text === JSON.stringify(phase4bComposeTemplate(), null, 2) + "\n", "P4B_COMPOSE_INVALID");
    return freeze({ defaultRunnableServices: 0, optInServices: 1, nativeExecutionAvailable: false, writeAccess: false });
  } catch (error) { throw p4bError(error); }
}
Object.assign(module.exports, { PHASE4B_PROFILE, APPLICATION_FILES, p4bData, p4bError, p4bCheck, exactKeys, same, freeze, runNames,
  validatePhase4BConfiguration, validatePhase4BHost, expectedPhase4BGrants, validatePhase4BGrants, validatePhase4BResources,
  validatePhase4BServer, phase4bComposeTemplate, assertPhase4BCompose });
