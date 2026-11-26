"use strict";

const h = require("./nativeHost.cjs"), e = require("./environment.cjs");
// These imports define adapters; they do not load native transports, credentials or mysql2.
const { createDocker } = require("./nativeDocker.cjs"), { createMysql } = require("./nativeMysql.cjs");
const lifecycles = new WeakMap();
function coordinate(session) {
  const { configuration: c, kind } = h.describe(session), docker = createDocker(session), mysql = createMysql(session, docker);
  const providers = require("./runtime.cjs").createProviderGuards();
  let stage = "authorized", disposed = false, busy = false, failure = null, connected = false, removed = false;
  const stages = [stage];
  function transition(next) { stage = next; stages.push(next); }
  function report() {
    const d = docker.metrics(), m = mysql.metrics();
    return e.freeze({ evidenceClass: kind === "native" ? "native-smoke-observation" : "offline-native-protocol",
      runId: c.runId, schema: c.schema, harnessCommit: c.source.harnessCommit, fixtureFingerprint: c.fixture.fingerprint,
      stage, stages: [...stages], failureClassification: failure, nativeVerified: kind === "native" && removed && connected,
      connected: kind === "native" && connected, attested: kind === "native" && m.attested,
      durableVerified: false, writeAccess: false, cleanup: removed ? (kind === "native" ? "owned-resources-absent" : "mock-owned-resources-absent") : "not-verified",
      counts: { dockerCommandAttempts: kind === "native" ? d.commands : 0, databaseQueryAttempts: kind === "native" ? m.queries : 0,
        modelCommands: kind === "mock" ? d.commands : 0, modelQueries: kind === "mock" ? m.queries : 0,
        connections: m.connections, pools: m.pools, resources: d.resources },
      recovery: stage === "quarantined" || stage === "cancelled" ? "fresh-owner-authorization-required" : "not-required" });
  }
  async function operation(token, action, allowedStages, work) {
    h.check(!disposed && !busy, "BUSY");
    h.begin(session, token, action); busy = true;
    try {
      h.check(allowedStages.includes(stage), "STAGE_INVALID"); await work(); return report();
    } catch (caught) {
      const safe = h.error(caught); failure = safe.code;
      if (!disposed && stage !== "cancelled") transition("quarantined");
      await mysql.dispose().catch(() => {}); h.revoke(session); throw safe;
    } finally { busy = false; h.end(session); }
  }
  async function reverify() { await h.observe(session); await docker.inspect(); }
  const api = Object.freeze({
    scope: action => { h.check(!disposed && !["quarantined", "cancelled", "removed"].includes(stage), "QUARANTINED"); return h.scope(session, action); },
    describe: report,
    provision: token => operation(token, "provision", ["authorized"], async () => {
      await h.observe(session); await docker.observeHost(); transition("host-verified");
      await docker.registry(); transition("image-verified");
      await h.claim(session); await h.credentials(session);
      await docker.create(); await docker.start(); transition("resources-created");
      await mysql.verifyServer(); transition("server-verified");
      await mysql.bootstrap(); transition("schema-empty");
      await mysql.fixtures(); transition("fixtures-unready");
    }),
    verify: token => operation(token, "verify", ["fixtures-unready", "reconciled", "attested", "connected"], async () => {
      await reverify(); await mysql.reconcile(["attested", "connected"].includes(stage));
      if (stage === "fixtures-unready") transition("reconciled");
    }),
    attest: token => operation(token, "attest", ["reconciled"], async () => { await reverify(); await mysql.attest(); transition("attested"); }),
    checkConnections: token => operation(token, "connect-check", ["attested"], async () => {
      await reverify(); await mysql.connectCheck(); connected = true; transition("connected");
    }),
    teardown: token => operation(token, "teardown", ["fixtures-unready", "reconciled", "attested", "connected"], async () => {
      const drained = await mysql.dispose(); h.check(drained.connections === 0 && drained.pools === 0 && Object.values(providers.counts()).every(v => v === 0), "CLEANUP_INVALID");
      await reverify(); transition("cleanup"); await docker.remove(); await h.deleteSecrets(session); removed = true; transition("removed");
    }),
    cancel: async () => { if (!disposed && stage !== "removed") { transition("cancelled"); h.revoke(session); await mysql.dispose(); } return report(); },
    dispose: async () => { if (!disposed) { disposed = true; h.revoke(session); await mysql.dispose(); } return report(); }
  });
  lifecycles.set(api, { session, admitted: () => !disposed && !busy && stage === "authorized", dispatching: false });
  return { api, session };
}
function createNativeLifecycle(challenge, receipt) {
  h.requireOwnerTrust(); // Refuses before I/O, config/receipt discovery, credential generation or native module loading.
  return coordinate(h.activate(challenge, receipt)).api;
}
async function smoke(lifecycle) {
  const owner = lifecycles.get(lifecycle);
  h.check(owner && owner.admitted() && !owner.dispatching, "AUTH_INVALID");
  h.assertAdmission(owner.session, h.ACTIONS);
  owner.dispatching = true;
  // Obtain every required permit before provision; a partial receipt must not strand a newly created environment.
  try {
    const permits = Object.fromEntries(h.ACTIONS.map(action => [action, lifecycle.scope(action)]));
    await lifecycle.provision(permits.provision); await lifecycle.verify(permits.verify);
    await lifecycle.attest(permits.attest); await lifecycle.checkConnections(permits["connect-check"]);
    return await lifecycle.teardown(permits.teardown);
  } finally { try { await lifecycle.dispose(); } finally { owner.dispatching = false; } }
}
module.exports = { createNativeLifecycle, createNativeChallenge: h.createNativeChallenge, smoke };
module.exports.testing = Object.freeze({ createLifecycle: (challenge, receipt) => coordinate(h.testing.activate(challenge, receipt)).api });
