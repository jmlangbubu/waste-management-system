"use strict";

// No native transport is installed. This module executes only branded, in-memory mock transports.
// Command/SQL descriptors below are inert review material, never executable authorization.
const crypto = require("node:crypto");
const e = require("./environment.cjs");
const schema = require("./schema.cjs");
const assertions = require("./assertions.cjs");
const transports = new WeakMap(), scopes = new WeakMap(), lifecycles = new WeakMap();
const ACTIONS = Object.freeze(["provision", "verify", "attest", "connect-check", "teardown"]);
const WRITE_ACTIONS = new Set(["provision", "attest", "teardown"]);
const MEDIA = e.freeze({
  indexes: ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"],
  manifests: ["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"],
  configurations: {
    "application/vnd.oci.image.manifest.v1+json": "application/vnd.oci.image.config.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json": "application/vnd.docker.container.image.v1+json"
  },
  layers: {
    "application/vnd.oci.image.manifest.v1+json": ["application/vnd.oci.image.layer.v1.tar", "application/vnd.oci.image.layer.v1.tar+gzip", "application/vnd.oci.image.layer.v1.tar+zstd"],
    "application/vnd.docker.distribution.manifest.v2+json": ["application/vnd.docker.image.rootfs.diff.tar", "application/vnd.docker.image.rootfs.diff.tar.gzip"]
  }
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = text => "sha256:" + crypto.createHash("sha256").update(text).digest("hex");
const fail = (condition, code) => e.p4bCheck(condition, code);
const guarded = operation => { try { return operation(); } catch (error) { throw e.p4bError(error, "P4B_ADAPTER_FAILED"); } };
function verifyRegistryProof(input, supplied) {
  return guarded(() => {
    const c = e.validatePhase4BConfiguration(input), p = e.p4bData(supplied);
    e.exactKeys(p, ["indexRaw", "manifestRaw", "configRaw"], "P4B_IMAGE_INVALID");
    fail([p.indexRaw, p.manifestRaw, p.configRaw].every(v => typeof v === "string" && v.length > 0 && v.length <= 65536), "P4B_IMAGE_INVALID");
    fail(digest(p.indexRaw) === c.image.indexDigest && digest(p.manifestRaw) === c.image.platformDigest && digest(p.configRaw) === c.image.configDigest, "P4B_IMAGE_INVALID");
    let index, manifest, image;
    try { index = JSON.parse(p.indexRaw); manifest = JSON.parse(p.manifestRaw); image = JSON.parse(p.configRaw); } catch (_) { throw e.p4bError(null, "P4B_IMAGE_INVALID"); }
    fail(index && index.schemaVersion === 2 && MEDIA.indexes.includes(index.mediaType) &&
      Array.isArray(index.manifests) && index.manifests.length > 0 && index.manifests.length <= 32, "P4B_IMAGE_INVALID");
    fail(index.manifests.every(m => m && typeof m === "object" && !Array.isArray(m) &&
      [...MEDIA.indexes, ...MEDIA.manifests].includes(m.mediaType) && typeof m.digest === "string" &&
      /^sha256:[0-9a-f]{64}$/.test(m.digest) && Number.isSafeInteger(m.size) && m.size > 0), "P4B_IMAGE_INVALID");
    const selected = index.manifests.filter(m => m.platform?.os === c.image.os && m.platform?.architecture === c.image.architecture);
    fail(selected.length === 1 && MEDIA.manifests.includes(selected[0].mediaType) &&
      selected[0].digest === c.image.platformDigest && selected[0].size === Buffer.byteLength(p.manifestRaw), "P4B_IMAGE_INVALID");
    fail(manifest && manifest.schemaVersion === 2 && MEDIA.manifests.includes(manifest.mediaType) &&
      selected[0].mediaType === manifest.mediaType && manifest.config?.mediaType === MEDIA.configurations[manifest.mediaType] &&
      manifest.config?.digest === c.image.configDigest && manifest.config?.size === Buffer.byteLength(p.configRaw) &&
      Array.isArray(manifest.layers) && manifest.layers.length > 0 &&
      manifest.layers.every(layer => layer && MEDIA.layers[manifest.mediaType].includes(layer.mediaType) &&
        typeof layer.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(layer.digest) && Number.isSafeInteger(layer.size) && layer.size > 0) &&
      image && image.os === c.image.os && image.architecture === c.image.architecture, "P4B_IMAGE_INVALID");
    return e.freeze({ evidenceSource: "supplied-manifest-bytes", independentlyObservedHere: false, writeAccess: false });
  });
}
function commandPlan(input) {
  return guarded(() => {
    const c = e.validatePhase4BConfiguration(input), n = e.runNames(c.runId), root = c.secretDirectory;
    fail(!root.includes(","), "P4B_CONFIG_INVALID");
    const labelArgs = ["--label", "wmo.test.purpose=" + e.PURPOSE, "--label", "wmo.test.run=" + c.runId];
    const command = args => ({ executable: c.docker.executable, args: ["--context", c.docker.context, ...args],
      executableNow: false, shell: false, timeoutMs: 10000 });
    return e.freeze({ executable: false, requiresSeparateAuthorization: true,
      create: [
        command(["network", "create", "--driver", "bridge", "--internal", ...labelArgs, n.network]),
        command(["volume", "create", "--driver", "local", ...labelArgs, n.volume]),
        command(["container", "create", "--pull=never", "--name", n.container, "--network", n.network,
          "--publish", "127.0.0.1:" + c.endpoint.port + ":3306/tcp", "--cpus", "2", "--memory", "1073741824", "--restart", "no",
          "--mount", "type=volume,source=" + n.volume + ",target=/var/lib/mysql",
          "--mount", "type=bind,source=" + root + "\\root-password,target=/run/secrets/wmo-root-password,readonly",
          "--mount", "type=bind,source=" + root + "\\root-client,target=/run/secrets/wmo-root-client,readonly",
          "--env", "MYSQL_ROOT_HOST=localhost", "--env", "MYSQL_ROOT_PASSWORD_FILE=/run/secrets/wmo-root-password",
          ...labelArgs, e.IMAGE + "@" + c.image.platformDigest, "--mysqlx=0"])
      ],
      childEnvironment: { ...e.buildChildEnvironment({}), WMO_APPOINTMENT_HARNESS_PHASE: "4B", COMPOSE_DISABLE_ENV_FILE: "1" },
      composeInvocation: { profile: "wmo-disposable", explicitFileRequired: true, explicitNonsecretEnvFileRequired: true,
        automaticOverridesAllowed: false, inheritedEnvironmentAllowed: false },
      secretContract: { generator: "separately-reviewed-crypto-adapter-required", generatedHere: false, argvSecretsAllowed: false,
        gitStorageAllowed: false, ownerOnlyTemporaryFilesRequired: true, rootHost: "localhost" }
    });
  });
}
function createMockTransport(script) {
  return guarded(() => {
    const copied = e.p4bData(script);
    const kinds = ["host", "registry", "resources", "bootstrapIdentity", "provisioning", "fixture", "runtime", "connections", "cleanup",
      "createResources", "startContainer", "bootstrap", "createFixtures", "grantRuntime", "attest", "stopContainer", "removeResources"];
    fail(Object.keys(copied).every(k => kinds.includes(k)), "P4B_CONFIG_INVALID");
    for (const v of Object.values(copied)) { e.exactKeys(v, ["results"]); fail(Array.isArray(v.results) && v.results.length > 0, "P4B_CONFIG_INVALID"); }
    const state = { script: copied, events: [], reads: 0, commands: 0, sqlStatements: 0 };
    const transport = Object.freeze({ classification: "mock-only", inspect: () => e.freeze({
      events: state.events.map(x => ({ ...x })), modelReads: state.reads, modelCommands: state.commands,
      modelSqlStatements: state.sqlStatements, dockerCommands: 0, databaseQueries: 0, networkConnections: 0, filesystemWrites: 0
    }) });
    transports.set(transport, state); return transport;
  });
}
function createMockScope(transport, input, actions, lifecycle) {
  return guarded(() => {
    fail(transports.has(transport), "P4B_SCOPE_INVALID");
    const c = e.validatePhase4BConfiguration(input), selected = e.p4bData(actions);
    const owner = lifecycles.get(lifecycle);
    fail(owner && !owner.disposed && owner.transport === transport && e.same(owner.configuration, c), "P4B_SCOPE_INVALID");
    fail(Array.isArray(selected) && selected.length > 0 && new Set(selected).size === selected.length &&
      selected.every(a => ACTIONS.includes(a)), "P4B_SCOPE_INVALID");
    const scope = Object.freeze({ classification: "mock-scope-not-execution-authority" });
    const state = { owner, transport, configuration: c, remaining: new Set(selected), revoked: false };
    scopes.set(scope, state); owner.scopes.add(state); return scope;
  });
}
function createNativeLifecycle(...args) {
  try { return require("./nativeLifecycle.cjs").createNativeLifecycle(...args); }
  catch (_) { throw e.p4bError(null, "P4B_NATIVE_UNSUPPORTED"); }
}
function createMockLifecycle(input, transport) {
  return guarded(() => {
    const c = e.validatePhase4BConfiguration(input), spec = schema.provisioningProfile(c);
    schema.validateInstantiatedProvisioningProfile(c, spec);
    fail(transports.has(transport), "P4B_SCOPE_INVALID");
    const io = transports.get(transport);
    const owner = { transport, configuration: c, disposed: false, scopes: new Set() };
    let stage = "planned", uuid, owned, daemonId, busy = false;
    const response = (operation, write = false, counts = {}) => {
      const queue = io.script[operation]?.results;
      fail(queue && queue.length > 0, "P4B_ADAPTER_FAILED");
      const value = e.p4bData(queue.length > 1 ? queue.shift() : queue[0]);
      io.events.push({ operation, write });
      if (write) { io.commands += counts.commands || 0; io.sqlStatements += counts.sql || 0; }
      else io.reads++;
      if (value && value.failure) throw e.p4bError(null, "P4B_ADAPTER_FAILED");
      if (write) fail(value.modelAck === true, "P4B_ADAPTER_FAILED");
      return value;
    };
    const scopeCheck = (scope, action) => {
      const s = scopes.get(scope);
      fail(!owner.disposed && s && !s.revoked && s.owner === owner && s.transport === transport &&
        e.same(s.configuration, c) && s.remaining.has(action), "P4B_SCOPE_INVALID");
      // Consume before any downstream operation, including a failed attempt. Read-only actions may repeat.
      if (WRITE_ACTIONS.has(action)) s.remaining.delete(action);
    };
    const hostCheck = () => {
      const host = response("host");
      e.validatePhase4BHost(c, host);
      if (daemonId) fail(host.daemonId === daemonId, "P4B_CONTEXT_INVALID");
      verifyRegistryProof(c, response("registry"));
      daemonId = host.daemonId;
    };
    const resourceCheck = () => {
      const resources = response("resources");
      e.validatePhase4BResources(c, resources);
      if (owned) fail(e.same(owned, resources), "P4B_RESOURCE_INVALID");
      else owned = e.freeze(resources);
    };
    const fixtureCheck = (observation, ready) => {
      e.exactKeys(observation, ["server", "grants", "metadata", "identity", "marker", "snapshot"], "P4B_FIXTURE_INVALID");
      e.validatePhase4BServer(c, observation.server, uuid);
      e.validatePhase4BGrants(c, observation.grants);
      const metadata = schema.provisioningMetadata(c);
      fail(e.same(observation.metadata, metadata) &&
        e.same([...observation.server.tables].sort(), metadata.tables.map(t => t.TABLE_NAME).sort()), "P4B_FIXTURE_INVALID");
      fail(e.same(observation.identity, schema.identityRow(c, ready ? 1 : 0)) &&
        e.same(observation.marker, { ...spec.marker, backfill_complete: ready ? 1 : 0 }), "P4B_FIXTURE_INVALID");
      try { assertions.assertReservationIntegrity(observation.snapshot); } catch (_) { throw e.p4bError(null, "P4B_RECONCILIATION_INVALID"); }
      fail(e.same(observation.snapshot, spec.expectedSnapshot), "P4B_RECONCILIATION_INVALID");
      return observation;
    };
    const report = verifiedStage => assertions.createProvisioningEvidence({
      runId: c.runId, applicationCommit: c.source.applicationCommit, harnessCommit: c.source.harnessCommit,
      harnessManifestHash: c.source.harnessManifestHash, fixtureProfile: c.fixture.profile, fixtureFingerprint: c.fixture.fingerprint,
      imageIndexDigest: c.image.indexDigest, imagePlatformDigest: c.image.platformDigest, imageConfigDigest: c.image.configDigest,
      platform: "linux/" + c.image.architecture, schema: c.schema, stage: verifiedStage, evidenceSource: "mock",
      counts: { resources: owned ? 3 : 0, connections: 0, modelCommands: io.commands, modelSqlStatements: io.sqlStatements,
        dockerCommands: 0, databaseQueries: 0 },
      checks: ["source", "image", "ownership", ...(uuid ? ["server"] : []), ...(verifiedStage !== "planned" ? ["fixture"] : [])],
      cleanup: verifiedStage === "removed" ? "mock-owned-removed" : "not-run"
    });
    const action = (scope, kind, operation) => {
      scopeCheck(scope, kind); fail(!busy && !["quarantined", "removed"].includes(stage), "P4B_STAGE_INVALID");
      busy = true;
      try { return operation(); }
      catch (error) { stage = "quarantined"; throw e.p4bError(error, "P4B_ADAPTER_FAILED"); }
      finally { busy = false; }
    };
    const lifecycle = Object.freeze({
      describe: () => e.freeze({ classification: "mock-lifecycle", stage, nativeExecutionAvailable: false, writeAccess: false }),
      provision: scope => action(scope, "provision", () => {
        fail(stage === "planned", "P4B_STAGE_INVALID");
        hostCheck(); commandPlan(c);
        response("createResources", true, { commands: 3 }); resourceCheck();
        response("startContainer", true, { commands: 1 });
        const initial = response("bootstrapIdentity"), containerId = owned.find(r => r.kind === "container").id;
        e.exactKeys(initial, ["uuid", "containerId", "version", "distribution", "osId", "osVersion"], "P4B_SERVER_INVALID");
        fail(UUID.test(initial.uuid) && initial.containerId === containerId && initial.version === c.image.version &&
          initial.distribution === c.image.distribution && initial.osId === c.image.osId && initial.osVersion === c.image.osVersion, "P4B_SERVER_INVALID");
        uuid = initial.uuid;
        response("bootstrap", true, { sql: 1 }); // Model recipe only: schema + scoped account setup is native-unsupported.
        const admission = response("provisioning");
        e.exactKeys(admission, ["server", "grants"], "P4B_SERVER_INVALID");
        e.validatePhase4BServer(c, admission.server, uuid, true);
        e.validatePhase4BGrants(c, admission.grants, "provisioning");
        response("createFixtures", true, { sql: spec.ddl.length + spec.seed.length });
        response("grantRuntime", true, { sql: 1 });
        fixtureCheck(response("fixture"), false);
        stage = "fixtures-unready"; return report(stage);
      }),
      verify: scope => action(scope, "verify", () => {
        fail(["fixtures-unready", "ready"].includes(stage), "P4B_STAGE_INVALID");
        hostCheck(); resourceCheck(); fixtureCheck(response(stage === "ready" ? "runtime" : "fixture"), stage === "ready");
        return report(stage);
      }),
      attest: scope => action(scope, "attest", () => {
        fail(stage === "fixtures-unready", "P4B_STAGE_INVALID");
        hostCheck(); resourceCheck(); fixtureCheck(response("fixture"), false);
        const protocol = schema.attestationStatements(c);
        fail(protocol.requiresFreshReconciliation && protocol.updates.length === 2, "P4B_ATTESTATION_INVALID");
        const ack = response("attest", true, { sql: 2 });
        fail(e.same(ack.affectedRows, [1, 1]) && ack.commit === "acknowledged" && ack.snapshotLocked === true, "P4B_ATTESTATION_INVALID");
        fixtureCheck(response("runtime"), true);
        stage = "ready"; return report(stage);
      }),
      checkConnections: scope => action(scope, "connect-check", () => {
        fail(stage === "ready", "P4B_STAGE_INVALID");
        hostCheck(); resourceCheck(); fixtureCheck(response("runtime"), true);
        const observed = response("connections");
        e.exactKeys(observed, ["application", "observer"], "P4B_SERVER_INVALID");
        for (const role of ["application", "observer"]) {
          e.exactKeys(observed[role], ["account", "uuid", "schema", "socket"], "P4B_SERVER_INVALID");
          fail(observed[role].account === c.accounts[role] && observed[role].uuid === uuid &&
            observed[role].schema === c.schema && e.same(observed[role].socket, c.endpoint), "P4B_SERVER_INVALID");
        }
        return report(stage);
      }),
      teardown: scope => {
        scopeCheck(scope, "teardown"); fail(!busy && owned && stage !== "removed", "P4B_STAGE_INVALID");
        busy = true;
        try {
          hostCheck(); resourceCheck();
          const cleanup = response("cleanup");
          fail(e.same(cleanup, { workers: 0, connections: 0, providers: 0 }), "P4B_CLEANUP_INVALID");
          const ids = Object.fromEntries(owned.map(r => [r.kind, r.id]));
          const removal = [
            ["container", "stop", "--time", "10", ids.container],
            ["container", "rm", ids.container], ["network", "rm", ids.network], ["volume", "rm", ids.volume]
          ];
          fail(removal.every(args => !args.includes("--force") && !args.includes("prune")), "P4B_CLEANUP_INVALID");
          response("stopContainer", true, { commands: 1 }); response("removeResources", true, { commands: 3 });
          stage = "removed"; return report(stage);
        } catch (error) { stage = "quarantined"; throw e.p4bError(error, "P4B_CLEANUP_INVALID"); }
        finally { busy = false; }
      },
      dispose: () => {
        owner.disposed = true;
        owner.scopes.forEach(scope => { scope.revoked = true; scope.remaining.clear(); });
        owner.scopes.clear();
        return e.freeze({ externalCleanupPerformed: false, nativeExecutionAvailable: false });
      }
    });
    lifecycles.set(lifecycle, owner);
    return lifecycle;
  });
}
module.exports = { verifyRegistryProof, commandPlan, createMockTransport, createMockScope, createMockLifecycle, createNativeLifecycle, ACTIONS };
// Inert account recipe. No passwords are accepted, generated or interpolated here.
function grantRecipe(input, observedClientHost, stage = "runtime") {
  return guarded(() => {
    const c = e.validatePhase4BConfiguration(input);
    fail(typeof observedClientHost === "string" && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(observedClientHost) &&
      observedClientHost.split(".").every(n => Number(n) <= 255) &&
      /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(observedClientHost), "P4B_GRANTS_INVALID");
    const q = name => String.fromCharCode(96) + name + String.fromCharCode(96);
    const expected = e.expectedPhase4BGrants(c, stage), accounts = [], grants = [];
    for (const role of ["setup", "application", "observer"]) {
      const account = "'" + c.accounts[role] + "'@'" + observedClientHost + "'";
      accounts.push({ role, sql: "CREATE USER " + account + " IDENTIFIED BY ?;", parameterSlots: [role + "-password"] });
      for (const right of expected[role].rights) {
        // Table-qualified grants make underscores literal; never use an unescaped schema.* pattern.
        const privileges = right.privileges.map(p => p.startsWith("UPDATE(") ? "UPDATE (" + q(p.slice(7, -1)) + ")" : p);
        grants.push({ role, sql: "GRANT " + privileges.join(", ") + " ON " + q(c.schema) + "." + q(right.table) + " TO " + account + ";", parameterSlots: [] });
      }
    }
    return e.freeze({ executable: false, nativeBootstrapSupported: false, requiresObservedClientHost: true,
      stage, accounts, grants, accountCreationSeparateFromGranting: true, globalGrants: false, effectiveGrantObservationRequired: true, inheritedRolesAllowed: false });
  });
}
module.exports.grantRecipe = grantRecipe;
