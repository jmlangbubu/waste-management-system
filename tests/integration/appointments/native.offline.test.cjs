"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
// RFC 8032 test seed, TEST ONLY. It is not the pinned owner key and cannot authorize real execution.
const testKey = crypto.createPrivateKey({ key: Buffer.from("302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"), format: "der", type: "pkcs8" });
const testPublic = crypto.createPublicKey(testKey).export({ format: "pem", type: "spki" });
const publicCA = require("node:tls").rootCertificates.find(p => {
  const x = new crypto.X509Certificate(p); return x.ca && x.verify(x.publicKey) && Date.parse(x.validFrom) < Date.now() && Date.parse(x.validTo) > Date.now();
});
const publicCertificate = new crypto.X509Certificate(publicCA);
function traps() {
  const counts = { network: 0, process: 0, write: 0, production: 0, secretRead: 0, credentialGeneration: 0 }, undo = [];
  const patch = (o, key, value) => { const old = Object.getOwnPropertyDescriptor(o, key); if (!old || old.configurable || old.writable) {
    undo.push(() => old ? Object.defineProperty(o, key, old) : delete o[key]); Object.defineProperty(o, key, { value, configurable: true, writable: true }); } };
  const deny = kind => () => { counts[kind]++; throw new Error("OFFLINE_NATIVE_INTERCEPTION"); };
  const fs = require("node:fs"), net = require("node:net"), cp = require("node:child_process"), module = require("node:module");
  for (const api of [net, require("node:tls"), require("node:http"), require("node:https"), require("node:dgram")])
    for (const key of ["connect", "createConnection", "request", "get", "createServer", "createSocket"]) if (typeof api[key] === "function") patch(api, key, deny("network"));
  patch(net.Socket.prototype, "connect", deny("network")); patch(net.Server.prototype, "listen", deny("network")); patch(globalThis, "fetch", deny("network"));
  for (const api of [require("node:dns"), require("node:dns").promises]) for (const key of ["lookup", "resolve", "resolve4", "resolve6", "reverse"]) if (api[key]) patch(api, key, deny("network"));
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) patch(cp, key, deny("process"));
  for (const api of [fs, fs.promises]) for (const key of ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "rm", "rmSync", "unlink", "unlinkSync", "rename", "renameSync", "copyFile", "copyFileSync", "createWriteStream", "truncate", "truncateSync"]) if (typeof api[key] === "function") patch(api, key, deny("write"));
  for (const api of [fs, fs.promises]) for (const key of ["open", "openSync"]) if (api[key]) { const original = api[key]; patch(api, key, function(p, flags, ...rest) {
    if (typeof flags !== "string" || !/^r[s]?$/.test(flags)) return deny("write")(); return original.call(this, p, flags, ...rest);
  }); }
  const read = fs.readFileSync; patch(fs, "readFileSync", function(p, ...rest) { if (typeof p === "string" && /(?:^|[/\\])(?:\.env(?:\.|$)|root-password$|root-client$|owner-(?:public|private)(?:[.-]|$))/i.test(p)) return deny("secretRead")(); return read.call(this, p, ...rest); });
  const load = module._load; patch(module, "_load", function(name, parent, main) {
    if (/^(?:mysql2|dotenv)(?:\/|$)/.test(name) || /(?:^|[/\\])(?:routes[/\\]|config[/\\]db|server[/\\]server)/.test(name)) return deny("production")();
    return load.call(this, name, parent, main);
  });
  for (const key of ["randomBytes", "randomFill", "randomFillSync", "generateKeyPair", "generateKeyPairSync", "randomUUID"]) patch(crypto, key, deny("credentialGeneration"));
  return { counts, restore: () => { while (undo.length) undo.pop()(); } };
}
const importGuard = traps();
let h, e, schema, native, mysql, launcher;
try {
  h = require("./helpers/nativeHost.cjs"); e = require("./helpers/environment.cjs"); schema = require("./helpers/schema.cjs");
  native = require("./helpers/nativeLifecycle.cjs"); mysql = require("./helpers/nativeMysql.cjs"); launcher = require("./run.cjs");
  assert.ok(Object.values(importGuard.counts).every(v => v === 0));
} finally { importGuard.restore(); }
const guards = new Map();
test.beforeEach(t => guards.set(t.fullName, traps()));
test.afterEach(t => { const guard = guards.get(t.fullName); guard.restore(); guards.delete(t.fullName); assert.ok(Object.values(guard.counts).every(v => v === 0), JSON.stringify(guard.counts)); });
const clone = v => structuredClone(v), RUN = "11111111-1111-4111-8111-111111111111", UUID = "22222222-2222-4222-8222-222222222222";
const CONTAINER = "a".repeat(64), NETWORK = "b".repeat(64), HOST = "192.168.65.1", NOW = Date.parse("2026-11-21T00:00:00Z");
const policy = { publicKey: testPublic, owner: "offline-owner", nonce: "f".repeat(64), now: NOW };
const sign = payload => ({ payload, signature: crypto.sign(null, Buffer.from(h.canonical(payload)), testKey).toString("base64") });
function setup(options = {}) {
  const digest = value => "sha256:" + h.hash(value);
  const imageDefaults = { Labels: {}, Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "MYSQL_MAJOR=9.7", "MYSQL_VERSION=9.7.2"],
    Entrypoint: ["docker-entrypoint.sh"], Cmd: ["mysqld"], User: "", WorkingDir: "" };
  options.imageDefaults?.(imageDefaults);
  const configRaw = JSON.stringify({ os: "linux", architecture: "amd64", config: imageDefaults });
  const manifestRaw = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: digest(configRaw), size: Buffer.byteLength(configRaw) },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: "sha256:" + "d".repeat(64), size: 100 }] });
  const indexRaw = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [
    { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: digest(manifestRaw), size: Buffer.byteLength(manifestRaw), platform: { os: "linux", architecture: "amd64" } }] });
  const names = e.runNames(RUN), c = { runId: RUN, schema: "wmo_synthetic_" + RUN.replace(/-/g, ""),
    docker: { context: "desktop-linux", endpoint: "npipe:////./pipe/dockerDesktopLinuxEngine", executable: "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe", executableHash: "a".repeat(64) },
    node: { executable: "C:\\SyntheticNode22\\node.exe", executableHash: "b".repeat(64), version: "22.23.5" },
    image: { reference: e.IMAGE, indexDigest: digest(indexRaw), platformDigest: digest(manifestRaw), configDigest: digest(configRaw), os: "linux", architecture: "amd64", version: "9.7.2", distribution: "MySQL Community Server - GPL", osId: "ol", osVersion: "9" },
    endpoint: { host: "127.0.0.1", port: 33307, containerPort: 3306, protocol: "tcp" },
    source: { applicationCommit: e.BASELINE, harnessCommit: "861ca795cc657008e8f1d321f764e0912335b332", applicationFiles: clone(e.APPLICATION_FILES), harnessManifestHash: "e".repeat(64) },
    fixture: { profile: e.PHASE4B_PROFILE, fingerprint: schema.provisioningFingerprint() }, accounts: { setup: names.setup, application: names.application, observer: names.observer },
    secretDirectory: "C:\\Windows\\Temp\\wmo_appointments_" + RUN.replace(/-/g, "") + "_secrets" };
  const execution = { daemonId: "c".repeat(64), ownerSid: "S-1-5-21-1-2-3-1001", dependencyRoot: "C:\\Synthetic\\wmo_appointment_dependencies\\" + "e".repeat(64), dependencyHash: "e".repeat(64),
    backendExecutable: "C:\\Program Files\\Docker\\Docker\\resources\\com.docker.backend.exe", backendHash: "d".repeat(64) };
  const payload = { version: 1, owner: policy.owner, nonce: policy.nonce, issuedAt: "2026-11-21T00:00:00Z", expiresAt: "2026-11-21T00:10:00Z", configuration: clone(c), execution, actions: [...h.ACTIONS] };
  const profile = schema.provisioningProfile(c), labels = { "wmo.test.purpose": e.PURPOSE, "wmo.test.run": RUN };
  const state = { events: [], created: new Set(), files: new Set(), directory: false, tables: new Set(), seeded: false, marker: 0, reconciled: 0,
    grants: Object.fromEntries(["setup", "application", "observer"].map(role => [role, new Map()])), markerPresent: false, seedCount: 0, connections: 0, pool: false, running: false };
  const appointmentRow = () => ({ ...Object.fromEntries(Object.entries(schema.fixtureSpecification().tables.appointments.columns).map(([name, column]) => [name, column.default])),
    ...schema.fixtureSpecification().citizen, ...profile.expectedSnapshot.appointments[0], created_at: "2026-11-21 00:00:00" });
  const record = (kind, value) => state.events.push({ kind, value });
  const fail = () => { throw new Error("SECRET_CANARY citizen@example.invalid mysql://password@railway.app ORI-secret"); };
  const nativeInfo = () => ({ ID: execution.daemonId, OSType: "linux", Architecture: "x86_64", RegistryConfig: { Mirrors: [], IndexConfigs: { "docker.io": { Secure: true } } } });
  const volume = () => ({ Name: names.volume, Driver: "local", Scope: "local", Labels: clone(labels), CreatedAt: "2026-11-21T00:00:00Z", Options: null });
  const resources = () => ({
    container: { Id: CONTAINER, Name: "/" + names.container, Image: c.image.configDigest, Path: imageDefaults.Entrypoint?.[0], Args: [...(imageDefaults.Entrypoint || []).slice(1), "--mysqlx=0"],
      State: { Running: state.running, Status: state.running ? "running" : "created", Paused: false, Restarting: false, Dead: false },
      Config: { ...clone(imageDefaults), Image: e.IMAGE + "@" + c.image.platformDigest, Labels: clone(labels), Cmd: ["--mysqlx=0"],
        Env: [...(imageDefaults.Env || []).filter(v => !/^(?:MYSQL_ROOT_HOST|MYSQL_ROOT_PASSWORD_FILE)=/.test(v)),
          "MYSQL_ROOT_HOST=localhost", "MYSQL_ROOT_PASSWORD_FILE=/run/secrets/wmo-root-password"] },
      HostConfig: { NetworkMode: names.network, PortBindings: { "3306/tcp": [{ HostIp: "127.0.0.1", HostPort: String(c.endpoint.port) }] }, Privileged: false, RestartPolicy: { Name: "no" }, NanoCpus: 2e9, Memory: 1073741824 },
      NetworkSettings: { Networks: { [names.network]: { NetworkID: NETWORK, GlobalIPv6Address: "" } }, Ports: { "3306/tcp": [{ HostIp: "127.0.0.1", HostPort: String(c.endpoint.port) }], "33060/tcp": null } },
      Mounts: [{ Type: "volume", Name: names.volume, Destination: "/var/lib/mysql", RW: true }, ...[["root-password", "wmo-root-password"], ["root-client", "wmo-root-client"]].map(([src, dst]) => ({ Type: "bind", Source: c.secretDirectory + "\\" + src, Destination: "/run/secrets/" + dst, RW: false }))] },
    network: { Id: NETWORK, Name: names.network, Driver: "bridge", Internal: true, EnableIPv6: false, Labels: clone(labels), Containers: state.created.has("container") ? { [CONTAINER]: {} } : {}, Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" } }, volume: volume()
  });
  const root = sql => {
    record("root", sql.split(" ")[0]);
    if (sql === mysql.rootProgram(c, "identity")) { const result = { uuid: UUID, version: "9.7.2", distribution: c.image.distribution, mysqlx: 0 }; options.identity?.(result); return JSON.stringify(result); }
    if (sql === mysql.rootProgram(c, "client-host", { threadId: 77 })) return JSON.stringify({ host: HOST });
    if (sql === mysql.rootProgram(c, "create-schema")) { state.database = true; return ""; }
    if (sql === mysql.rootProgram(c, "empty")) return JSON.stringify({ tables: state.tables.size + (options.nonempty ? 1 : 0), extras: 0 });
    for (const role of ["setup", "application", "observer"]) {
      if (sql.startsWith("CREATE USER '" + c.accounts[role] + "'")) { assert.match(sql, /REQUIRE SSL;$/); return ""; }
      if (sql === mysql.rootProgram(c, "roles", { role, host: HOST })) return JSON.stringify({ mandatory: options.roles ? "unexpected_role" : "", roles: 0, defaults: 0, proxy: 0 });
      if (sql === mysql.rootProgram(c, "grants", { role, host: HOST })) {
        const lines = ["GRANT USAGE ON *.* TO `" + c.accounts[role] + "`@`" + HOST + "`"];
        for (const [table, rights] of state.grants[role]) lines.push("GRANT " + [...rights].sort().map(v => v.startsWith("UPDATE(") ? "UPDATE (`" + v.slice(7, -1) + "`)" : v).join(", ") + " ON `" + c.schema + "`.`" + table + "` TO `" + c.accounts[role] + "`@`" + HOST + "`");
        if (options.excessGrant) lines.push("GRANT ALL PRIVILEGES ON *.* TO `" + c.accounts[role] + "`@`" + HOST + "`");
        return lines.join("\n");
      }
    }
    const grant = /^GRANT (.+) ON `([^`]+)`\.`([^`]+)` TO '([^']+)'@'([^']+)';$/.exec(sql);
    if (grant) {
      assert.equal(grant[2], c.schema); assert.equal(grant[5], HOST);
      const role = Object.keys(c.accounts).find(r => c.accounts[r] === grant[4]); assert.ok(role);
      const current = state.grants[role].get(grant[3]) || new Set();
      for (const right of grant[1].split(", ")) current.add(right.replace(/^UPDATE \(`([^`]+)`\)$/, "UPDATE($1)"));
      state.grants[role].set(grant[3], current); return "";
    }
    throw new Error("Unexpected fake root protocol");
  };
  const fakeHost = {
    async identity() { return { sid: execution.ownerSid, architecture: options.architecture || "AMD64" }; },
    async binary(p) { return options.hashMismatch ? "0".repeat(64) : p === c.node.executable ? c.node.executableHash : p === c.docker.executable ? c.docker.executableHash : execution.backendHash; },
    async context() { return { Name: options.wrongContext ? "other" : c.docker.context, Endpoints: { docker: { Host: options.remote ? "tcp://remote:2375" : c.docker.endpoint } } }; },
    async observeSource() { return { head: options.wrongCommit ? "0".repeat(40) : c.source.harnessCommit, branch: "feat/wmo-appointment-service-slot-availability", root: "same", expectedRoot: "same", clean: !options.dirty,
      hashes: options.sourceMismatch ? {} : clone(c.source.applicationFiles), manifestHash: c.source.harnessManifestHash }; },
    async directory() { record("directory"); if (options.reparse || options.directoryExists) fail(); state.directory = true; return { ok: true }; },
    async acl() { record("acl"); return { ok: !options.unsafeACL }; },
    async file(p) { record("file", p.split("\\").at(-1)); if (state.files.has(p) || options.fileExists) fail(); state.files.add(p); return { ok: true }; },
    async journal(p, line) { assert.ok(state.files.has(p)); record("journal", JSON.parse(line)); },
    async remove(p) { record("delete", p.split("\\").at(-1)); assert.ok(state.files.has(p)); if (options.secretDelete) return { ok: false }; state.files.delete(p); return { ok: true }; },
    async removeDirectory() { assert.equal(state.files.size, 0); state.directory = false; record("directory-removed"); return { ok: true }; },
    async passwords() { record("fake-credentials"); return Object.fromEntries(["root", "setup", "application", "observer"].map((role, i) => [role, "ABCD"[i].repeat(43)])); },
    async listener() { return { listeners: [{ address: options.publicListener ? "0.0.0.0" : "127.0.0.1", port: c.endpoint.port, executable: execution.backendExecutable }], allowRules: options.firewall ? [{ remote: ["Any"] }] : [], profiles: [{ enabled: true, inbound: "Block" }] }; },
    async dependencies() { record("fake-dependency"); return fakeMysql; },
    async processCall(executable, allArgs, input) {
      assert.equal(executable, c.docker.executable); assert.deepEqual(allArgs.slice(0, 4), ["--config", c.secretDirectory, "--host", c.docker.endpoint]);
      const args = allArgs.slice(4); assert.ok(!args.some(v => /SECRET_CANARY|password=|[ABCD]{43}|--force|prune|compose/.test(v))); record("docker", args.join(" "));
      if (args[0] === "version") return JSON.stringify({ Version: options.oldEngine ? "27.0.0" : "28.0.0", Os: "linux", Arch: "amd64" });
      if (args[0] === "info") { const info = nativeInfo(); if (options.changedDaemon && state.seeded) info.ID = "other-daemon"; return JSON.stringify(info); }
      if (args[1] === "ls") return state.created.has(args[0]) ? JSON.stringify({ Name: names[args[0]] }) : "";
      if (args[0] === "image") return args[1] === "pull" ? "downloaded" : JSON.stringify([{ Id: c.image.configDigest, Os: "linux", Architecture: "amd64", RepoDigests: ["mysql@" + c.image.platformDigest] }]);
      if (args[1] === "create") { if (options.partialCreation && args[0] === "container") fail(); state.created.add(args[0]); return args[0] === "container" ? CONTAINER : args[0] === "network" ? NETWORK : names.volume; }
      if (args[1] === "inspect") { const all = resources(); options.resources?.(all); return JSON.stringify([all[args[0]]]); }
      if (args[1] === "start" || args[1] === "stop") { state.running = args[1] === "start"; options.afterStart?.(state); return CONTAINER; }
      if (args[1] === "rm") { if (options.removeUncertain) fail(); state.created.delete(args[0]); return args[2]; }
      if (args[1] === "exec") {
        if (args.includes("mysql")) return root(input.trim());
        const p = args.at(-1);
        if (p === "/etc/os-release") return 'ID="ol"\nVERSION_ID="9"';
        if (p.endsWith(".pem")) return publicCA;
        if (p === "/proc/net/route") return "Iface Destination Gateway Flags RefCnt Use Metric Mask\neth0 0001A8C0 00000000 0001 0 0 0 00FFFFFF";
        if (p === "/proc/net/ipv6_route") return "00000000000000000000000000000001 80 00000000000000000000000000000000 00 00000000000000000000000000000000 00000000 00000000 00000000 00000000 lo";
      }
      throw new Error("Unexpected fake Docker operation");
    }
  };
  const registry = { async request(url, headers) {
    record("registry", new URL(url).pathname); assert.equal(headers["Accept-Encoding"], "identity");
    const origin = new URL(url).origin, body = url.includes("/blobs/") ? configRaw : url.endsWith(c.image.platformDigest) ? manifestRaw : indexRaw;
    const response = { origin: options.wrongOrigin ? "https://untrusted.invalid" : origin, status: 200, headers: {}, body: Buffer.from(body) };
    if (options.registryRedirect) { response.status = 302; response.headers.location = "https://untrusted.invalid"; }
    if (options.digestMismatch) response.body = Buffer.from(body + " ");
    if (options.registryMutation) options.registryMutation(response, url, c);
    return response;
  } };
  const fakeMysql = {
    async probe() { record("fake-probe"); return { threadId: 77, close() { record("probe-closed"); } }; },
    createConnection(opts) {
      assert.equal(opts.host, "127.0.0.1"); assert.equal(opts.database, c.schema); assert.equal(opts.multipleStatements, false); assert.equal(opts.ssl.rejectUnauthorized, true);
      const role = Object.keys(c.accounts).find(r => c.accounts[r] === opts.user); assert.ok(role); record("connect", role); state.connections++;
      let destroyed = false, pending = null;
      const current = () => pending || state;
      const connection = { stream: { authorized: !options.tlsUnauthorized, remoteAddress: "127.0.0.1", remotePort: c.endpoint.port,
        getProtocol: () => options.oldTLS ? "TLSv1" : "TLSv1.3", getPeerCertificate: () => ({ raw: options.peerMismatch ? Buffer.from("bad") : publicCertificate.raw }) },
        connect(cb) { queueMicrotask(() => cb(null)); },
        destroy() { if (!destroyed) { destroyed = true; state.connections--; record("destroy", role); } },
        end(cb) { connection.destroy(); cb(); },
        query(statement, values, cb) {
          const sql = statement.sql; assert.equal(statement.timeout, 5000); record("sql", sql);
          const result = value => queueMicrotask(() => cb(null, value));
          const failure = () => queueMicrotask(() => cb(Object.assign(new Error("SECRET_CANARY"), { fatal: false })));
          if (destroyed) return failure();
          if (sql.startsWith("SELECT @@server_uuid")) return result([{ uuid: options.wrongUUID ? "33333333-3333-4333-8333-333333333333" : UUID, schema: options.wrongSchema ? "railway" : c.schema,
            account: (options.wrongAccount ? "root" : opts.user) + "@" + HOST, client: opts.user + "@" + HOST }]);
          if (sql === "SELECT @@session.time_zone AS timezone") return result([{ timezone: "SYSTEM" }]);
          if (sql.startsWith("SET SESSION time_zone")) return options.restoreFailure && sql.endsWith("?") ? failure() : result({ serverStatus: 2 });
          if (sql === "START TRANSACTION") { pending = { seeded: state.seeded, marker: state.marker, markerPresent: state.markerPresent, reconciled: state.reconciled, seedCount: state.seedCount }; return result({ serverStatus: 3 }); }
          if (sql === "ROLLBACK") { pending = null; return options.rollbackFailure ? failure() : result({ serverStatus: 2 }); }
          if (sql === "COMMIT") {
            const attestCommit = pending && pending.reconciled === 1;
            if (pending) { Object.assign(state, pending); pending = null; }
            if (attestCommit && options.uncertainCommit) return result(null);
            return result({ serverStatus: 2 });
          }
          const ddl = profile.ddl.find(v => v.sql === sql);
          if (ddl) {
            const table = /^CREATE TABLE `[^`]+`\.`([^`]+)`/.exec(sql);
            if (options.partialDDL && table?.[1] === "appointment_reservations") return failure();
            if (table) state.tables.add(table[1]); else { assert.ok(pending); pending.markerPresent = true; }
            return result({ affectedRows: 0, serverStatus: 2 });
          }
          const seed = profile.seed.findIndex(v => v.sql === sql);
          if (seed >= 0) {
            assert.ok(pending); assert.deepEqual(values, profile.seed[seed].parameters);
            if (options.seedFailure && seed === 2) return failure();
            pending.seedCount++; if (pending.seedCount === profile.seed.length) pending.seeded = true;
            return result({ affectedRows: 1, serverStatus: 3 });
          }
          if (schema.attestationStatements(c).updates.some(v => v.sql === sql)) {
            assert.ok(pending); if (sql.includes("SET reconciled")) pending.reconciled = 1; else pending.marker = 1;
            return result({ affectedRows: options.affectedRows ? 0 : 1, serverStatus: 3 });
          }
          if (sql.endsWith("FOR UPDATE")) {
            if (sql.includes(".`appointments`")) {
              const rows = current().seeded ? [appointmentRow()] : [];
              options.lockedRows?.(rows); return result(rows);
            }
            return result([]);
          }
          const metadataName = Object.keys(mysql.METADATA).find(k => mysql.METADATA[k] === sql);
          if (metadataName) {
            if (metadataName === "extras") return result(options.missingCount ? [{}] : [{ n: Object.hasOwn(options, "count") ? options.count : 0 }]);
            const rows = clone(schema.provisioningMetadata(c)[metadataName]).filter(row => state.tables.has(row.TABLE_NAME));
            if (metadataName === "tables") rows.forEach(row => { row.TABLE_COLLATION = "utf8mb4_general_ci"; });
            if (options.metadata && metadataName === "columns" && rows.length) rows[0].COLUMN_TYPE = "bigint unsigned";
            return result(rows);
          }
          if (sql.includes("FROM `" + c.schema + "`.`appointment_feature_state`")) return result(current().markerPresent ? [{ ...profile.marker, backfill_complete: options.contradictory && role === "observer" && state.marker ? 0 : current().marker }] : []);
          if (sql.includes("FROM `" + c.schema + "`.`appointment_harness_identity`")) return result(current().seeded ? [schema.identityRow(c, current().reconciled)] : []);
          if (sql.startsWith("SELECT full_name")) return result(current().seeded ? [clone(schema.fixtureSpecification().citizen)] : []);
          if (sql.includes("orientation_token") && sql.endsWith("FROM `" + c.schema + "`.`appointments`")) {
            const row = appointmentRow(); options.snapshotRow?.(row);
            const names = sql.slice(7, sql.indexOf(" FROM ")).split(", ");
            return result(current().seeded ? [Object.fromEntries(names.map(name => [name, row[name]]))] : []);
          }
          for (const [key, table] of [["appointments", "appointments"], ["reservations", "appointment_reservations"], ["requests", "appointment_booking_requests"], ["notifications", "notifications"]])
            if (sql.endsWith("FROM `" + c.schema + "`.`" + table + "`")) return result(current().seeded ? clone(profile.expectedSnapshot[key]) : []);
          throw new Error("Unexpected fake SQL protocol");
        },
        execute(statement, values, cb) { connection.query(statement, values, cb); }
      };
      return connection;
    },
    createPool(opts) { assert.equal(opts.connectionLimit, 1); record("pool"); state.pool = true;
      return { getConnection(cb) { cb(null, fakeMysql.createConnection(opts)); }, end(cb) { state.pool = false; record("pool-closed"); cb(); } };
    }
  };
  const fake = { host: fakeHost, registry, mysql: fakeMysql };
  function lifecycle(changes = () => {}) { const p = clone(payload); changes(p); const challenge = h.testing.challenge(c, policy, fake); return native.testing.createLifecycle(challenge, sign(p)); }
  return { c, payload, policy, state, fake, lifecycle, profile, resources, indexRaw, manifestRaw, configRaw };
}
const kinds = (f, name) => f.state.events.filter(v => v.kind === name);
async function rejects(operation, code) {
  await assert.rejects(operation, caught => {
    assert.ok(caught instanceof h.NativeError); assert.match(caught.code, /^NATIVE_/);
    assert.doesNotMatch(caught.message + caught.stack + JSON.stringify(caught), /SECRET_CANARY|citizen@|mysql:\/\/|ORI-secret|railway\.app/);
    return !code || caught.code === "NATIVE_" + code;
  });
}
async function provision(f) { const life = f.lifecycle(); await life.provision(life.scope("provision")); return life; }
async function reconciled(f) { const life = await provision(f); await life.verify(life.scope("verify")); return life; }

test("real entry and real factory refuse locked native activation before any effect or input consumption", async () => {
  assert.throws(() => native.createNativeChallenge({}), { code: "NATIVE_TRUST_UNAVAILABLE" });
  assert.throws(() => native.createNativeLifecycle({}, {}), { code: "NATIVE_TRUST_UNAVAILABLE" });
  let stdout = "", stderr = "";
  assert.equal(await launcher.main(["--native-smoke"], { stdout: { write: v => { stdout += v; } }, stderr: { write: v => { stderr += v; } } }), 2);
  assert.equal(stdout, ""); assert.match(stderr, /NATIVE_EXECUTION_REFUSED/);
});
test("unsigned or synthetic test authority cannot activate the real factory", () => {
  const f = setup(), challenge = h.testing.challenge(f.c, policy, f.fake);
  assert.throws(() => native.createNativeLifecycle(challenge, sign(f.payload)), { code: "NATIVE_TRUST_UNAVAILABLE" }); assert.deepEqual(f.state.events, []);
});
test("receipt signature binds the entire reviewed configuration and exact execution identity", () => {
  const f = setup(); assert.equal(h.testing.verifyReceipt(f.c, sign(f.payload), policy).configuration.schema, f.c.schema);
  const receipt = sign(f.payload); receipt.payload.execution.daemonId = "changed-daemon";
  assert.throws(() => h.testing.verifyReceipt(f.c, receipt, policy), { code: "NATIVE_AUTH_INVALID" }); assert.deepEqual(f.state.events, []);
});
for (const [name, mutation] of Object.entries({
  owner: p => { p.owner = "other-owner"; }, nonce: p => { p.nonce = "0".repeat(64); }, expired: p => { p.expiresAt = p.issuedAt; },
  run: p => { p.configuration.runId = UUID; }, commit: p => { p.configuration.source.harnessCommit = "0".repeat(40); },
  action: p => { p.actions = ["arbitrary-sql"]; }, key_in_receipt: p => { p.publicKey = testPublic; },
  endpoint: p => { p.configuration.endpoint.host = "railway.app"; }, missing_digest: p => { delete p.configuration.image.indexDigest; },
  fingerprint: p => { p.configuration.fixture.fingerprint = "sha256:" + "0".repeat(64); }
})) test("authorization rejects " + name + " before adapter effects", () => {
  const f = setup(); assert.throws(() => f.lifecycle(mutation), h.NativeError); assert.deepEqual(f.state.events, []);
});
test("invalid signature, missing verifier key and accessor receipts are rejected", () => {
  const f = setup(), r = sign(f.payload); r.signature = "A".repeat(86) + "==";
  assert.throws(() => h.testing.verifyReceipt(f.c, r, policy), h.NativeError);
  assert.throws(() => h.testing.verifyReceipt(f.c, sign(f.payload), { ...policy, publicKey: null }), h.NativeError);
  let reads = 0; assert.throws(() => h.testing.verifyReceipt(f.c, { get payload() { reads++; return f.payload; }, signature: r.signature }, policy), h.NativeError);
  assert.equal(reads, 0); assert.deepEqual(f.state.events, []);
});
test("positive native protocol completes only through fake adapters and remains mock-only", async () => {
  const f = setup(), life = f.lifecycle(), report = await native.smoke(life);
  assert.equal(report.stage, "removed"); assert.equal(report.evidenceClass, "offline-native-protocol"); assert.equal(report.nativeVerified, false);
  assert.equal(report.connected, false); assert.equal(report.durableVerified, false); assert.equal(report.counts.dockerCommandAttempts, 0); assert.equal(report.counts.databaseQueryAttempts, 0);
  assert.deepEqual([...f.state.created], []); assert.equal(f.state.files.size, 0); assert.equal(f.state.directory, false); assert.equal(f.state.connections, 0); assert.equal(f.state.pool, false);
  assert.deepEqual(report.stages, ["authorized", "host-verified", "image-verified", "resources-created", "server-verified", "schema-empty", "fixtures-unready", "reconciled", "attested", "connected", "cleanup", "removed"]);
});
test("provisioning leaves both readiness markers unready and does not open an application pool", async () => {
  const f = setup(), life = await provision(f); assert.equal(life.describe().stage, "fixtures-unready");
  assert.equal(f.state.marker, 0); assert.equal(f.state.reconciled, 0); assert.equal(kinds(f, "pool").length, 0); await life.dispose();
});
for (const [name, options] of Object.entries({ wrong_context: { wrongContext: true }, remote_daemon: { remote: true },
  old_engine: { oldEngine: true }, wrong_architecture: { architecture: "ARM64" }, wrong_executable: { hashMismatch: true },
  dirty_source: { dirty: true }, source_manifest: { sourceMismatch: true }, wrong_commit: { wrongCommit: true } }))
  test("host refusal " + name + " precedes registry, credentials and provisioning", async () => {
    const f = setup(options), life = f.lifecycle(); await rejects(life.provision(life.scope("provision")));
    assert.equal(kinds(f, "registry").length, 0); assert.equal(kinds(f, "fake-credentials").length, 0); assert.equal(f.state.created.size, 0);
  });
for (const [name, options] of Object.entries({ wrong_origin: { wrongOrigin: true }, unsafe_redirect: { registryRedirect: true }, raw_digest: { digestMismatch: true } }))
  test("registry refusal " + name + " creates no secrets or Docker resources", async () => {
    const f = setup(options), life = f.lifecycle(); await rejects(life.provision(life.scope("provision")));
    assert.equal(kinds(f, "fake-credentials").length, 0); assert.equal(f.state.created.size, 0); assert.equal(kinds(f, "directory").length, 0);
  });
for (const [name, change] of Object.entries({ descriptor: i => { i.manifests[0].mediaType = "unsupported"; }, platform: i => { i.manifests[0].platform.architecture = "arm64"; }, size: i => { i.manifests[0].size++; } }))
  test("authenticated bytes still require valid " + name + " descriptors", async () => {
    const f = setup(), index = JSON.parse(f.indexRaw); change(index); const raw = JSON.stringify(index);
    f.c.image.indexDigest = "sha256:" + h.hash(raw); f.payload.configuration = clone(f.c);
    f.fake.registry.request = async url => ({ origin: new URL(url).origin, status: 200, headers: {}, body: Buffer.from(url.includes("/blobs/") ? f.configRaw : url.endsWith(f.c.image.platformDigest) ? f.manifestRaw : raw) });
    const life = f.lifecycle(); await rejects(life.provision(life.scope("provision"))); assert.equal(kinds(f, "directory").length, 0);
  });
for (const [name, options] of Object.entries({ ACL: { unsafeACL: true }, reparse: { reparse: true }, existing_directory: { directoryExists: true }, existing_file: { fileExists: true } }))
  test("credential refusal " + name + " performs zero secret generation and SQL", async () => {
    const f = setup(options), life = f.lifecycle(); await rejects(life.provision(life.scope("provision")));
    assert.equal(kinds(f, "fake-credentials").length, 0); assert.equal(kinds(f, "root").length, 0); assert.equal(f.state.created.size, 0);
  });
for (const [name, change] of Object.entries({ unknown_container: r => { r.container.Id = "f".repeat(64); }, ownership: r => { delete r.container.Config.Labels["wmo.test.run"]; },
  extra_port: r => { r.container.NetworkSettings.Ports["33060/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "33060" }]; },
  ipv6: r => { r.network.EnableIPv6 = true; }, extra_member: r => { r.network.Containers["f".repeat(64)] = {}; },
  extra_network: r => { r.container.NetworkSettings.Networks.unrelated = { NetworkID: "f".repeat(64) }; },
  foreign_volume: r => { r.volume.CreatedAt = "different"; }, docker_socket: r => { r.container.Mounts.push({ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: true }); } }))
  test("resource refusal " + name + " precedes all SQL", async () => {
    const f = setup({ resources: change }), life = f.lifecycle(); await rejects(life.provision(life.scope("provision")));
    assert.equal(kinds(f, "root").length, 0); assert.equal(kinds(f, "sql").length, 0); assert.ok(!kinds(f, "docker").some(v => / rm /.test(v.value)));
  });
for (const name of ["publicListener", "firewall"]) test("Windows isolation refusal " + name + " precedes database bootstrap", async () => {
  const f = setup({ [name]: true }), life = f.lifecycle(); await rejects(life.provision(life.scope("provision")), "ISOLATION_UNVERIFIED"); assert.equal(kinds(f, "root").length, 0);
});
for (const name of ["wrongUUID", "wrongSchema", "wrongAccount", "tlsUnauthorized", "oldTLS", "peerMismatch", "nonempty", "excessGrant", "roles", "metadata"])
  test("MySQL refusal " + name + " never admits attestation or application writers", async () => {
    const expected = { wrongUUID: "SERVER_INVALID", wrongSchema: "SERVER_INVALID", wrongAccount: "SERVER_INVALID", tlsUnauthorized: "TLS_INVALID", oldTLS: "TLS_INVALID", peerMismatch: "TLS_INVALID", nonempty: "FIXTURE_INVALID", excessGrant: "GRANTS_INVALID", roles: "GRANTS_INVALID", metadata: "FIXTURE_INVALID" };
    const f = setup({ [name]: true }), life = f.lifecycle(); await rejects(life.provision(life.scope("provision")), expected[name]);
    assert.equal(f.state.marker, 0); assert.equal(f.state.reconciled, 0); assert.equal(kinds(f, "pool").length, 0); assert.equal(f.state.connections, 0);
  });
test("server version mismatch is rejected before account and schema creation", async () => {
  const f = setup({ identity: o => { o.version = "8.4.0"; } }), life = f.lifecycle(); await rejects(life.provision(life.scope("provision")), "SERVER_INVALID");
  assert.equal(f.state.database, undefined); assert.equal(kinds(f, "connect").length, 0);
});
test("partial DDL quarantines without claiming DDL rollback or seeding", async () => {
  const f = setup({ partialDDL: true }), life = f.lifecycle(); await rejects(life.provision(life.scope("provision")));
  assert.ok(f.state.tables.size > 0); assert.equal(f.state.seeded, false); assert.ok(!kinds(f, "sql").some(v => v.value === "ROLLBACK"));
  assert.equal(life.describe().stage, "quarantined");
});
test("seed failure explicitly rolls back and never attests", async () => {
  const f = setup({ seedFailure: true }), life = f.lifecycle(); await rejects(life.provision(life.scope("provision")));
  assert.ok(kinds(f, "sql").some(v => v.value === "ROLLBACK")); assert.equal(f.state.seeded, false); assert.equal(f.state.marker, 0); assert.equal(f.state.markerPresent, false);
});
test("rollback failure destroys the setup connection and quarantines", async () => {
  const f = setup({ seedFailure: true, rollbackFailure: true }), life = f.lifecycle(); await rejects(life.provision(life.scope("provision")), "ROLLBACK_FAILED"); assert.equal(f.state.connections, 0);
});
test("timezone restoration failure after committed seed never releases a reusable lease", async () => {
  const f = setup({ restoreFailure: true }), life = f.lifecycle(); await rejects(life.provision(life.scope("provision"))); assert.equal(f.state.connections, 0); assert.equal(f.state.marker, 0);
});
test("attestation locks all six tables before conditional marker updates", async () => {
  const f = setup(), life = await reconciled(f); await life.attest(life.scope("attest"));
  const sql = kinds(f, "sql").map(v => v.value), locks = sql.filter(v => v.endsWith("FOR UPDATE")); assert.equal(locks.length, 6);
  assert.ok(sql.indexOf(locks.at(-1)) < sql.findIndex(v => v.startsWith("UPDATE"))); assert.equal(f.state.marker, 1); assert.equal(f.state.reconciled, 1); await life.dispose();
});
test("attestation cannot skip reconciliation", async () => {
  const f = setup(), life = await provision(f); const before = f.state.events.length;
  await rejects(life.attest(life.scope("attest")), "STAGE_INVALID"); assert.equal(f.state.marker, 0); assert.equal(kinds(f, "pool").length, 0);
  assert.ok(!f.state.events.slice(before).some(v => v.kind === "sql" && v.value.startsWith("UPDATE")));
});
for (const name of ["affectedRows", "uncertainCommit", "contradictory"]) test("attestation refusal " + name + " quarantines without replay or an application pool", async () => {
  const f = setup({ [name]: true }), life = await reconciled(f), token = life.scope("attest"); await rejects(life.attest(token));
  const before = f.state.events.length; await rejects(life.attest(token)); assert.equal(f.state.events.length, before); assert.equal(kinds(f, "pool").length, 0);
  assert.equal(life.describe().attested, false); assert.equal(life.describe().durableVerified, false);
});
test("cross-lifecycle, forged and cloned scopes cause zero downstream effects", async () => {
  const a = setup(), b = setup(), la = a.lifecycle(), lb = b.lifecycle(), token = la.scope("provision");
  for (const scope of [token, {}, structuredClone(token)]) await rejects(lb.provision(scope), "SCOPE_INVALID");
  assert.deepEqual(a.state.events, []); assert.deepEqual(b.state.events, []); await la.dispose(); await lb.dispose();
});
test("consumed failed write permit cannot be reissued or replayed", async () => {
  const f = setup({ dirty: true }), life = f.lifecycle(), token = life.scope("provision"); await rejects(life.provision(token));
  const before = f.state.events.length; await rejects(life.provision(token)); assert.throws(() => life.scope("provision"), h.NativeError); assert.equal(f.state.events.length, before);
});
test("cancellation and disposal invalidate issued authorization", async () => {
  for (const action of ["cancel", "dispose"]) {
    const f = setup(), life = f.lifecycle(), token = life.scope("provision"); await life[action](); await rejects(life.provision(token)); assert.deepEqual(f.state.events, []);
  }
});
test("one-time challenge admission rejects copied or already consumed challenges", () => {
  const f = setup(), ch = h.testing.challenge(f.c, policy, f.fake); native.testing.createLifecycle(ch, sign(f.payload));
  assert.throws(() => native.testing.createLifecycle(ch, sign(f.payload)), h.NativeError);
  assert.throws(() => native.testing.createLifecycle(structuredClone(ch), sign(f.payload)), h.NativeError);
});
test("partial creation and uncertain removal preserve journal and refuse automatic cleanup", async () => {
  const partial = setup({ partialCreation: true }), lp = partial.lifecycle(); await rejects(lp.provision(lp.scope("provision")));
  assert.equal(partial.state.created.size, 2); assert.ok(kinds(partial, "journal").some(v => v.value.phase === "uncertain"));
  assert.throws(() => lp.scope("teardown"), h.NativeError);
  const removal = setup({ removeUncertain: true }), lr = await provision(removal); await rejects(lr.teardown(lr.scope("teardown")));
  assert.ok(removal.state.files.size > 0); assert.equal(lr.describe().cleanup, "not-verified");
});
test("changed daemon or unowned resource prevents cleanup commands", async () => {
  const f = setup({ changedDaemon: true }), life = f.lifecycle(); await life.provision(life.scope("provision"));
  await rejects(life.teardown(life.scope("teardown"))); assert.ok(!kinds(f, "docker").some(v => / (?:rm|stop) /.test(v.value)));
});
test("failed secret deletion never reports completed cleanup", async () => {
  const f = setup({ secretDelete: true }), life = await provision(f); await rejects(life.teardown(life.scope("teardown")), "CLEANUP_INVALID");
  assert.equal(f.state.created.size, 0); assert.ok(f.state.files.size > 0); assert.equal(life.describe().cleanup, "not-verified");
});
test("fixed root protocol cannot become an arbitrary administrative SQL runner", () => {
  const f = setup();
  for (const [op, args] of [["arbitrary", { sql: "DROP DATABASE railway" }], ["create-schema", { schema: "railway" }],
    ["create-account", { role: "root", host: HOST, password: "A".repeat(43) }], ["create-account", { role: "setup", host: HOST, password: "' ; DROP" }],
    ["grant", { role: "application", host: HOST, stage: "runtime", table: "appointment_harness_identity" }]]) assert.throws(() => mysql.rootProgram(f.c, op, args));
  assert.deepEqual(f.state.events, []);
});
test("grant parser rejects roles, globals, wildcard schemas and malformed rights", () => {
  const f = setup(), account = "`" + f.c.accounts.application + "`@`" + HOST + "`", usage = "GRANT USAGE ON *.* TO " + account;
  for (const line of ["GRANT SELECT ON *.* TO " + account, "GRANT ALL PRIVILEGES ON `" + f.c.schema + "`.* TO " + account,
    "GRANT `role` TO " + account, "GRANT SELECT ON `railway`.`appointments` TO " + account,
    "GRANT SELECT ON `" + f.c.schema + "`.`appointments` TO " + account + " WITH GRANT OPTION"])
    assert.throws(() => mysql.parseGrants(f.c, "application", HOST, usage + "\n" + line), h.NativeError);
  assert.deepEqual(mysql.parseGrants(f.c, "application", HOST, usage).rights, []);
});
test("restricted child environment excludes inherited production and Node preload settings", () => {
  const output = h.childEnvironment({ SystemRoot: "C:\\Windows", DATABASE_URL: "SECRET_CANARY", DOCKER_HOST: "tcp://remote", NODE_OPTIONS: "SECRET_CANARY", NODE_PATH: "SECRET_CANARY", HTTPS_PROXY: "SECRET_CANARY", RESEND_API_KEY: "SECRET_CANARY", COMPOSE_FILE: "evil" });
  for (const key of ["DATABASE_URL", "DOCKER_HOST", "NODE_OPTIONS", "NODE_PATH", "HTTPS_PROXY", "RESEND_API_KEY", "COMPOSE_FILE"]) assert.equal(output[key], undefined);
});
test("smoke requires all explicit action permissions before any provisioning", async () => {
  const f = setup(), life = f.lifecycle(p => { p.actions = ["provision", "teardown"]; }); await rejects(native.smoke(life)); assert.deepEqual(f.state.events, []);
});
test("provider request guards and generic transport escape attempts refuse", () => {
  const guards = require("./helpers/runtime.cjs").createProviderGuards(); assert.throws(() => guards.http.request(), { code: "OUTBOUND_PROVIDER_BLOCKED" });
  const f = setup(); assert.throws(() => require("./helpers/nativeDocker.cjs").readCommand({}, {}), h.NativeError);
  assert.throws(() => h.testDriver({}, "host"), h.NativeError); assert.deepEqual(f.state.events, []);
});
test("scope guards do not disclose mutable session state or native driver constructors", () => {
  const f = setup(), ch = h.testing.challenge(f.c, policy, f.fake), session = h.testing.activate(ch, sign(f.payload));
  h.begin(session, h.scope(session, "provision"), "provision");
  assert.equal(h.access(session), undefined); assert.equal(h.driver, undefined); assert.equal(h.io, undefined);
  const description = h.describe(session); description.kind = "native";
  assert.equal(h.describe(session).kind, "mock"); assert.ok(Object.isFrozen(description.configuration));
  assert.throws(() => mysql.createMysql(session, { root() {} }), { code: "NATIVE_SCOPE_INVALID" });
  h.end(session); h.revoke(session); assert.deepEqual(f.state.events, []);
});
test("official Bearer challenge uses only the fixed pull authority and scope", async () => {
  const f = setup(), original = f.fake.registry.request; let requested = false, issued = false;
  f.fake.registry.request = async (url, headers) => {
    if (!requested) { requested = true; return { origin: "https://registry-1.docker.io", status: 401,
      headers: { "www-authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/mysql:pull"' }, body: Buffer.from("{}") }; }
    if (url.startsWith("https://auth.docker.io/")) {
      assert.equal(url, "https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fmysql%3Apull");
      assert.equal(headers.Authorization, undefined); issued = true;
      return { origin: "https://auth.docker.io", status: 200, headers: {}, body: Buffer.from(JSON.stringify({ token: "T".repeat(40) })) };
    }
    assert.ok(issued); assert.equal(headers.Authorization, "Bearer " + "T".repeat(40)); return original(url, headers);
  };
  const life = await provision(f); assert.ok(issued); await life.dispose();
});
test("untrusted token authority is rejected before token or provisioning requests", async () => {
  const f = setup(); let calls = 0;
  f.fake.registry.request = async () => { calls++; return { origin: "https://registry-1.docker.io", status: 401,
    headers: { "www-authenticate": 'Bearer realm="https://untrusted.invalid/token",service="registry.docker.io",scope="repository:library/mysql:pull"' }, body: Buffer.from("{}") }; };
  const life = f.lifecycle(); await rejects(life.provision(life.scope("provision")), "REGISTRY_INVALID"); assert.equal(calls, 1); assert.equal(kinds(f, "directory").length, 0);
});
test("image configuration must match the selected platform even with a consistent digest chain", async () => {
  const f = setup(), rawConfig = JSON.stringify({ os: "windows", architecture: "amd64" }), manifest = JSON.parse(f.manifestRaw), index = JSON.parse(f.indexRaw);
  manifest.config.digest = "sha256:" + h.hash(rawConfig); manifest.config.size = Buffer.byteLength(rawConfig);
  const rawManifest = JSON.stringify(manifest); index.manifests[0].digest = "sha256:" + h.hash(rawManifest); index.manifests[0].size = Buffer.byteLength(rawManifest);
  const rawIndex = JSON.stringify(index);
  Object.assign(f.c.image, { configDigest: manifest.config.digest, platformDigest: index.manifests[0].digest, indexDigest: "sha256:" + h.hash(rawIndex) }); f.payload.configuration = clone(f.c);
  f.fake.registry.request = async url => ({ origin: new URL(url).origin, status: 200, headers: {}, body: Buffer.from(url.includes("/blobs/") ? rawConfig : url.endsWith(f.c.image.platformDigest) ? rawManifest : rawIndex) });
  const life = f.lifecycle(); await rejects(life.provision(life.scope("provision")), "IMAGE_INVALID"); assert.equal(kinds(f, "directory").length, 0);
});
test("premature readiness and failed fresh reconciliation prevent conditional attestation writes", async () => {
  for (const change of [f => { f.state.marker = 1; }, f => { f.state.seeded = false; }]) {
    const f = setup(), life = await provision(f); change(f); const from = f.state.events.length;
    await rejects(life.verify(life.scope("verify")), "RECONCILIATION_INVALID");
    assert.ok(!f.state.events.slice(from).some(v => v.kind === "sql" && v.value.startsWith("UPDATE"))); assert.equal(kinds(f, "pool").length, 0);
  }
});
test("cleanup reobserves ownership after provisioning and rejects cross-run targets", async () => {
  const options = {}, f = setup(options), life = await provision(f);
  options.resources = resources => { resources.container.Config.Labels["wmo.test.run"] = UUID; };
  await rejects(life.teardown(life.scope("teardown")), "RESOURCE_INVALID");
  assert.ok(!kinds(f, "docker").some(v => / (?:rm|stop) /.test(v.value))); assert.ok(f.state.files.size > 0);
});
test("cancellation of pending observation revokes work before downstream effects", async () => {
  const f = setup(); let unblock;
  const original = f.fake.host.observeSource; f.fake.host.observeSource = async () => { await new Promise(resolve => { unblock = resolve; }); return original(); };
  const life = f.lifecycle(), work = life.provision(life.scope("provision"));
  await Promise.resolve(); await life.cancel(); unblock(); await rejects(work);
  assert.equal(kinds(f, "docker").length, 0); assert.equal(kinds(f, "registry").length, 0); assert.equal(kinds(f, "fake-credentials").length, 0);
});
test("bounded adapter timeout never executes a later step", async () => {
  const f = setup(), session = h.testing.activate(h.testing.challenge(f.c, policy, f.fake), sign(f.payload));
  h.begin(session, h.scope(session, "provision"), "provision"); let timeout = 0, downstream = 0;
  await rejects(h.bounded(session, () => new Promise(() => {}), 5, () => { timeout++; }), "TIMEOUT");
  h.revoke(session); await rejects(h.bounded(session, () => { downstream++; }, 5));
  assert.equal(timeout, 1); assert.equal(downstream, 0); assert.deepEqual(f.state.events, []);
});
test("concurrent lifecycle operations cannot share an active write scope", async () => {
  const f = setup(); let unblock;
  const original = f.fake.host.observeSource; f.fake.host.observeSource = async () => { await new Promise(resolve => { unblock = resolve; }); return original(); };
  const life = f.lifecycle(), provisionToken = life.scope("provision"), verifyToken = life.scope("verify"), work = life.provision(provisionToken);
  await Promise.resolve(); await rejects(life.verify(verifyToken), "BUSY"); await life.cancel(); unblock(); await rejects(work);
  assert.equal(kinds(f, "docker").length, 0);
});
test("source mismatch invalidates permits issued before the mismatch", async () => {
  const f = setup({ dirty: true }), life = f.lifecycle(), write = life.scope("provision"), cleanup = life.scope("teardown");
  await rejects(life.provision(write), "SOURCE_INVALID"); const count = f.state.events.length;
  await rejects(life.teardown(cleanup), "SCOPE_INVALID"); assert.equal(f.state.events.length, count);
});
test("approved fixture fingerprints remain unchanged", () => {
  assert.equal(schema.fixtureFingerprint(), "sha256:4cb53e3f85feb78cb3359f59b7e8b88f8de423f11fabcc27b81f6cdb52e142c1");
  assert.equal(schema.provisioningFingerprint(), "sha256:9b3350ff0c2a06e0dac2f689de3ae05fb4d776d91caa9c6a86aa7bbe55543255");
});
test("all fixture DML including the unready marker runs after DDL inside the seed transaction", async () => {
  const f = setup(), life = await provision(f), sql = kinds(f, "sql").map(v => v.value);
  const begin = sql.indexOf("START TRANSACTION"), inserts = sql.filter(v => v.startsWith("INSERT INTO "));
  assert.equal(inserts.length, 6); assert.ok(inserts.every(v => sql.indexOf(v) > begin));
  assert.ok(sql.filter(v => v.startsWith("CREATE TABLE ")).every(v => sql.indexOf(v) < begin)); await life.dispose();
});
test("root writes cannot use a read-only verification scope", async () => {
  const f = setup(), session = h.testing.activate(h.testing.challenge(f.c, policy, f.fake), sign(f.payload));
  h.begin(session, h.scope(session, "provision"), "provision");
  const docker = require("./helpers/nativeDocker.cjs").createDocker(session);
  await docker.observeHost(); await docker.registry(); await h.claim(session); await h.credentials(session); await docker.create(); await docker.start();
  h.end(session); h.begin(session, h.scope(session, "verify"), "verify"); const before = f.state.events.length;
  await rejects(docker.root("create-schema", {}), "SCOPE_INVALID");
  assert.equal(f.state.events.length, before); assert.equal(kinds(f, "root").length, 0); h.end(session); h.revoke(session);
});
test("sensitive adapter exceptions are replaced without retaining their identity", async () => {
  const f = setup(), supplied = new Error("SECRET_CANARY mysql://password@railway.app citizen@example.invalid ORI-secret");
  f.fake.host.binary = async () => { throw supplied; }; const life = f.lifecycle();
  await assert.rejects(life.provision(life.scope("provision")), caught => caught !== supplied && caught instanceof h.NativeError &&
    !/SECRET_CANARY|railway|citizen@|ORI-secret/.test(caught.message + caught.stack + JSON.stringify(caught)));
  assert.equal(kinds(f, "directory").length, 0); assert.equal(kinds(f, "registry").length, 0);
});

// Private probes and defect mutations exist only in memory. Native activation is never enabled.
function memoryModule(name, mutate = text => text, overrides = {}) {
  const path = require("node:path"), Module = require("node:module"), file = path.join(__dirname, "helpers", name + ".cjs");
  assert.ok(["nativeHost", "nativeDocker", "nativeMysql", "nativeLifecycle"].includes(name));
  const original = require("node:fs").readFileSync(file, "utf8"), source = mutate(original), m = { exports: {} }, local = Module.createRequire(file);
  const extra = name === "nativeHost" ? "module.exports.probePrivate={runChild,verifiedOwnerTrust,nativeActivation:NATIVE_ACTIVATION_ENABLED};" : name === "nativeDocker" ? "module.exports.probePrivate={requestBytes};" : "";
  new Function("require", "module", "exports", "__dirname", source + "\n" + extra)(n => Object.hasOwn(overrides, n) ? overrides[n] : local(n), m, m.exports, path.dirname(file));
  return m.exports;
}
function replaceOnce(source, before, after) { assert.ok(source.includes(before), "mutation target must exist"); return source.replace(before, after); }
function sessionFor(f, host = h) {
  const session = host.testing.activate(host.testing.challenge(f.c, policy, f.fake), sign(f.payload));
  host.begin(session, host.scope(session, "provision"), "provision"); return session;
}
async function stoppedDocker(options = {}, module = require("./helpers/nativeDocker.cjs")) {
  const f = setup(options), session = sessionFor(f), docker = module.createDocker(session);
  await docker.observeHost(); await docker.registry(); await h.claim(session); await h.credentials(session); await docker.create();
  return { f, session, docker, close() { h.end(session); h.revoke(session); } };
}
const starts = f => kinds(f, "docker").filter(v => v.value.startsWith("container start"));
const readinessWrites = f => kinds(f, "sql").filter(v => v.value.startsWith("UPDATE ") && /SET (?:reconciled|backfill_complete)/.test(v.value));

for (const [name, mutate] of Object.entries({
  owner: r => { r.container.Config.Labels["wmo.test.run"] = UUID; },
  image: r => { r.container.Image = "sha256:" + "f".repeat(64); },
  mount: r => { r.container.Mounts[0].Name = "unowned"; },
  extra_port: r => { r.container.NetworkSettings.Ports["33060/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "33060" }]; },
  network: r => { r.container.HostConfig.NetworkMode = "host"; },
  network_owner: r => { delete r.network.Labels["wmo.test.run"]; },
  running_early: r => { r.container.State.Running = true; r.container.State.Status = "running"; }
})) test("FIX start admission rejects " + name + " before every start command", async () => {
  const options = {}, context = await stoppedDocker(options);
  try {
    options.resources = mutate; await rejects(context.docker.start(), "RESOURCE_INVALID");
    assert.equal(starts(context.f).length, 0); assert.equal(kinds(context.f, "root").length, 0);
    await rejects(context.docker.start(), "STAGE_INVALID"); assert.equal(starts(context.f).length, 0);
  } finally { context.close(); }
});
test("FIX start admission rechecks the daemon before dispatch", async () => {
  const context = await stoppedDocker(), call = context.f.fake.host.processCall;
  context.f.fake.host.processCall = async (...args) => {
    const result = await call(...args); if (args[1][4] !== "info") return result;
    return JSON.stringify({ ...JSON.parse(result), ID: "changed-daemon" });
  };
  try { await rejects(context.docker.start(), "HOST_INVALID"); assert.equal(starts(context.f).length, 0); }
  finally { context.close(); }
});
test("FIX a changed observation between admission and dispatch prevents start", async () => {
  const options = {}, context = await stoppedDocker(options), call = context.f.fake.host.processCall; let inspections = 0;
  context.f.fake.host.processCall = async (...args) => {
    const result = await call(...args);
    if (args[1][4] === "volume" && args[1][5] === "inspect" && ++inspections === 1)
      options.resources = r => { r.container.Config.Labels["wmo.test.run"] = UUID; };
    return result;
  };
  try { await rejects(context.docker.start(), "RESOURCE_INVALID"); assert.equal(starts(context.f).length, 0); }
  finally { context.close(); }
});
test("FIX valid stopped configuration permits exactly one verified start", async () => {
  const context = await stoppedDocker();
  try {
    const observed = await context.docker.start(); assert.equal(observed.length, 3); assert.equal(starts(context.f).length, 1);
    const events = context.f.state.events, start = events.findIndex(v => v.kind === "docker" && v.value.startsWith("container start"));
    assert.equal(events.slice(0, start).filter(v => v.kind === "docker" && v.value.startsWith("container inspect")).length, 2);
    assert.ok(events.slice(0, start).some(v => v.kind === "journal" && v.value.kind === "start" && v.value.phase === "intent"));
    assert.ok(events.slice(start).some(v => v.kind === "journal" && v.value.kind === "start" && v.value.phase === "observed"));
  } finally { context.close(); }
});
test("FIX stopped resources need configured bindings, not a live listener or fabricated membership", async () => {
  const options = {}, context = await stoppedDocker(options);
  options.resources = r => { if (!context.f.state.running) {
    r.container.NetworkSettings.Ports = { "3306/tcp": null, "33060/tcp": null };
    r.container.NetworkSettings.Networks = { [e.runNames(RUN).network]: { NetworkID: "", GlobalIPv6Address: "" } }; r.network.Containers = {};
  } };
  try { await context.docker.start(); assert.equal(starts(context.f).length, 1); }
  finally { context.close(); }
});
test("FIX post-start changes quarantine before SQL and preserve the uncertain journal", async () => {
  const options = {}, context = await stoppedDocker(options);
  options.afterStart = () => { options.resources = r => { r.container.Image = "sha256:" + "f".repeat(64); }; };
  try {
    await rejects(context.docker.start(), "RESOURCE_INVALID"); assert.equal(starts(context.f).length, 1);
    assert.equal(kinds(context.f, "root").length, 0); assert.equal(context.docker.metrics().uncertain, true);
    assert.ok(kinds(context.f, "journal").some(v => v.value.kind === "start" && v.value.phase === "uncertain"));
  } finally { context.close(); }
});

for (const [name, value, expected] of [
  ["number zero", 0, 0n], ["string zero", "0", 0n], ["bigint zero", 0n, 0n],
  ["number one", 1, 1n], ["string one", "1", 1n], ["bigint one", 1n, 1n],
  ["number many", 23, 23n], ["string many", "23", 23n], ["bigint many", 23n, 23n],
  ["large exact string", "9007199254740993", 9007199254740993n], ["large bigint", 2n ** 100n, 2n ** 100n]
]) test("FIX count accepts " + name + " without precision loss", () => assert.equal(mysql.normalizeCount(value), expected));
for (const [name, value] of Object.entries({ null: null, missing: undefined, false: false, true: true, negative: -1,
  negative_bigint: -1n, negative_string: "-1", negative_zero: -0, signed_string: "+0", negative_zero_string: "-0",
  fraction: 0.5, fraction_string: "0.5", exponent: "1e3", leading_zero: "00", whitespace: " 0", empty: "",
  nonnumeric: "invalid", unsafe: Number.MAX_SAFE_INTEGER + 1, infinite: Infinity, nan: NaN, object: {}, array: [] }))
  test("FIX count rejects " + name, () => assert.throws(() => mysql.normalizeCount(value), { code: "NATIVE_FIXTURE_INVALID" }));
for (const [name, value] of [["number", 0], ["string", "0"], ["bigint", 0n]])
  test("FIX metadata permits canonical " + name + " zero", async () => { const f = setup({ count: value }), life = await provision(f); assert.equal(life.describe().stage, "fixtures-unready"); await life.dispose(); });
for (const [name, options] of [["nonzero number", { count: 1 }], ["nonzero string", { count: "2" }], ["nonzero bigint", { count: 2n }], ["missing field", { missingCount: true }]])
  test("FIX metadata still rejects " + name + " before readiness", async () => {
    const f = setup(options), life = f.lifecycle(); await rejects(life.provision(life.scope("provision")), "FIXTURE_INVALID");
    assert.equal(f.state.marker, 0); assert.equal(f.state.reconciled, 0); assert.equal(readinessWrites(f).length, 0);
  });
test("FIX root identity, emptiness and role COUNT values use the same strict normalization", async () => {
  const f = setup(), call = f.fake.host.processCall;
  f.fake.host.processCall = async (...args) => {
    const output = await call(...args);
    if (!args[1].includes("mysql") || !args[2].startsWith("SELECT JSON_OBJECT")) return output;
    const value = JSON.parse(output);
    for (const name of ["mysqlx", "tables", "extras", "roles", "defaults", "proxy"]) if (Object.hasOwn(value, name)) value[name] = String(value[name]);
    return JSON.stringify(value);
  };
  const report = await native.smoke(f.lifecycle()); assert.equal(report.stage, "removed"); assert.equal(report.nativeVerified, false);
});

test("FIX smoke rejects arbitrary and forged-success objects before delegating anything", async () => {
  let delegated = 0;
  const fake = { scope() { delegated++; }, provision() { delegated++; }, verify() { delegated++; }, attest() { delegated++; },
    checkConnections() { delegated++; }, teardown() { delegated++; return { nativeVerified: true, durableVerified: true }; }, dispose() { delegated++; } };
  for (const value of [fake, { ...fake, nativeVerified: true }, Object.create(fake), new Proxy(fake, {}), JSON.parse(JSON.stringify({ nativeVerified: true, durableVerified: true }))])
    await rejects(native.smoke(value), "AUTH_INVALID");
  assert.equal(delegated, 0);
});
test("FIX copied, cross-lifecycle and serialized coordinator objects have no smoke authority", async () => {
  const a = setup(), b = setup(), la = a.lifecycle(), lb = b.lifecycle();
  for (const value of [{ ...la }, { ...la, scope: lb.scope }, Object.create(la), new Proxy(la, {}), JSON.parse(JSON.stringify(la))]) await rejects(native.smoke(value), "AUTH_INVALID");
  assert.equal(a.state.events.length, 0); assert.equal(b.state.events.length, 0); await la.dispose(); await lb.dispose();
});
for (const method of ["dispose", "cancel"]) test("FIX " + method + " revokes smoke before delegation", async () => {
  const f = setup(), life = f.lifecycle(); await life[method](); const before = f.state.events.length;
  await rejects(native.smoke(life), "AUTH_INVALID"); assert.equal(f.state.events.length, before);
});
test("FIX smoke rejects a lifecycle branded by another coordinator module", async () => {
  const other = memoryModule("nativeLifecycle"), f = setup(), life = other.testing.createLifecycle(h.testing.challenge(f.c, policy, f.fake), sign(f.payload));
  await rejects(native.smoke(life), "AUTH_INVALID"); assert.equal(f.state.events.length, 0); await life.dispose();
});
test("FIX a genuine offline coordinator remains mock-only and cannot dispatch twice", async () => {
  const f = setup(), life = f.lifecycle(), report = await native.smoke(life), count = f.state.events.length;
  assert.equal(report.evidenceClass, "offline-native-protocol"); assert.equal(report.nativeVerified, false); assert.equal(report.durableVerified, false);
  await rejects(native.smoke(life), "AUTH_INVALID"); assert.equal(f.state.events.length, count);
  assert.throws(() => native.createNativeLifecycle({}, {}), { code: "NATIVE_TRUST_UNAVAILABLE" });
});

for (const [name, mutate] of Object.entries({
  token: rows => { rows[0].orientation_token = "ORI-unexpected-synthetic"; }, completed: rows => { rows[0].orientation_completed = 1; },
  orientation_status: rows => { rows[0].orientation_status = "completed"; }, qr_status: rows => { rows[0].orientation_qr_status = "generated"; },
  orientation_started: rows => { rows[0].orientation_started_at = "2026-11-21 01:00:00"; }, score: rows => { rows[0].orientation_score = 100; },
  personnel_id: rows => { rows[0].assigned_personnel_id = 999; }, personnel_name: rows => { rows[0].assigned_personnel_name = "Unexpected synthetic staff"; },
  assigned_to: rows => { rows[0].assigned_to = "Unexpected synthetic staff"; }, assigned_at: rows => { rows[0].assigned_at = "2026-11-21 01:00:00"; },
  accepted_status: rows => { rows[0].status = "approved"; }, wrong_id: rows => { rows[0].id++; }, absent: rows => { rows.splice(0); },
  missing_field: rows => { delete rows[0].orientation_token; }, duplicate: rows => { rows.push(clone(rows[0])); }
})) test("FIX locked appointment rejects " + name + " before either readiness update", async () => {
  const f = setup({ lockedRows: mutate }), life = await reconciled(f), token = life.scope("attest");
  await rejects(life.attest(token), "RECONCILIATION_INVALID");
  assert.equal(readinessWrites(f).length, 0); assert.equal(f.state.marker, 0); assert.equal(f.state.reconciled, 0);
  assert.ok(kinds(f, "sql").some(v => v.value === "ROLLBACK")); assert.equal(f.state.connections, 0);
  const count = f.state.events.length; await rejects(life.attest(token)); assert.equal(f.state.events.length, count);
});
test("FIX snapshot validation also covers orientation and personnel fields", async () => {
  const f = setup({ snapshotRow: row => { row.orientation_token = "ORI-unexpected-synthetic"; } }), life = f.lifecycle();
  await rejects(life.provision(life.scope("provision")), "RECONCILIATION_INVALID"); assert.equal(readinessWrites(f).length, 0); assert.equal(f.state.marker, 0);
});
test("FIX locked-state failure with failed rollback stays quarantined", async () => {
  const f = setup({ rollbackFailure: true, lockedRows: rows => { rows[0].orientation_completed = 1; } }), life = await reconciled(f);
  await rejects(life.attest(life.scope("attest")), "ROLLBACK_FAILED"); assert.equal(life.describe().stage, "quarantined"); assert.equal(readinessWrites(f).length, 0);
});
test("FIX correct approved defaults attest while post-commit contradiction still quarantines", async () => {
  const f = setup(), life = await reconciled(f); await life.attest(life.scope("attest")); assert.equal(readinessWrites(f).length, 2); await life.dispose();
  const bad = setup({ contradictory: true }), lb = await reconciled(bad); await rejects(lb.attest(lb.scope("attest")), "RECONCILIATION_INVALID");
  assert.equal(lb.describe().attested, false); assert.equal(lb.describe().stage, "quarantined"); assert.equal(kinds(bad, "pool").length, 0);
});

function childProbe(options = {}, mutate) {
  const host = memoryModule("nativeHost", mutate), f = setup(), session = sessionFor(f, host), EventEmitter = require("node:events");
  const stats = { spawns: 0, kills: 0, closes: 0, input: 0, timerCalls: 0 }, timers = new Set();
  class Child extends EventEmitter {
    constructor() {
      super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.stdin = new EventEmitter();
      this.stdin.end = () => {
        stats.input++; if (options.stdinThrows) throw new Error("SECRET_CANARY stdin");
        if (options.hang) return;
        queueMicrotask(() => {
          if (options.asyncError) return this.emit("error", new Error("SECRET_CANARY child"));
          if (options.cancelFirst) host.revoke(session);
          this.stdout.emit("data", Buffer.from("ok\n")); this.closed();
          if (options.cancelLast) host.revoke(session);
        });
      };
    }
    on(name, fn) {
      super.on(name, fn);
      if (name === "close" && !this.injected) {
        this.injected = true;
        if (options.setupError) this.emit("error", new Error("SECRET_CANARY setup"));
        if (options.closeDuringSetup) this.closed();
        if (options.registrationAfterSpawn) { host.revoke(session); host.onCancel(session, () => {}); }
      }
      return this;
    }
    closed(code = 0) { stats.closes++; this.emit("close", code); }
    kill() { stats.kills++; if (options.killThrows) throw new Error("SECRET_CANARY kill");
      if (!options.noClose && !options.killFalse) this.closed(null); return !options.killFalse; }
  }
  const child = new Child(), transport = {
    spawn(executable, args, settings) {
      assert.equal(executable, f.c.docker.executable); assert.deepEqual(args, ["version"]); assert.equal(settings.shell, false);
      assert.equal(settings.env.DATABASE_URL, undefined); stats.spawns++;
      if (options.revokeDuringSpawn) host.revoke(session); return child;
    },
    registerCancel(fn) { if (options.registrationThrows) throw new Error("SECRET_CANARY registration"); return host.onCancel(session, fn); },
    setTimer(fn, ms) {
      stats.timerCalls++;
      if (options.timerThrows && stats.timerCalls === 1 || options.cleanupTimerThrows && stats.timerCalls === 2) throw new Error("SECRET_CANARY timer");
      const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t;
    },
    clearTimer(t) { clearTimeout(t); timers.delete(t); }
  };
  return { host, session, stats, timers, child, run: () => host.probePrivate.runChild(session, transport, f.c.docker.executable, ["version"], "", 30, 15),
    close() { host.revoke(session); for (const t of timers) clearTimeout(t); timers.clear(); } };
}
async function faultReject(work, code) {
  await assert.rejects(work, caught => {
    assert.equal(caught.code, "NATIVE_" + code);
    assert.doesNotMatch(caught.message + caught.stack + JSON.stringify(caught), /SECRET_CANARY|password@|ORI-secret/); return true;
  });
}
test("FIX historical revocation during spawn terminates before sending input", async () => {
  const p = childProbe({ revokeDuringSpawn: true });
  try { await faultReject(p.run(), "CANCELLED"); assert.equal(p.stats.spawns, 1); assert.equal(p.stats.kills, 1); assert.equal(p.stats.closes, 1); assert.equal(p.stats.input, 0); assert.equal(p.timers.size, 0); }
  finally { p.close(); }
});
for (const [name, options, code] of [
  ["registration throws before dispatch", { registrationThrows: true }, "PROCESS_FAILED"],
  ["operation timeout setup throws before dispatch", { timerThrows: true }, "PROCESS_FAILED"],
  ["registration throws after child creation", { registrationAfterSpawn: true }, "CANCELLED"],
  ["child emits error during setup", { setupError: true }, "PROCESS_FAILED"],
  ["asynchronous child error", { asyncError: true }, "PROCESS_FAILED"],
  ["stdin setup fails", { stdinThrows: true }, "PROCESS_FAILED"],
  ["deadline expires", { hang: true }, "TIMEOUT"],
  ["post-spawn cleanup timer setup throws but close is observed", { setupError: true, cleanupTimerThrows: true }, "PROCESS_FAILED"],
  ["kill is refused", { setupError: true, killFalse: true }, "QUARANTINED"],
  ["kill throws", { setupError: true, killThrows: true }, "QUARANTINED"],
  ["kill has no close evidence", { setupError: true, noClose: true }, "QUARANTINED"],
  ["cleanup cannot be bounded", { setupError: true, noClose: true, cleanupTimerThrows: true }, "QUARANTINED"],
  ["cancellation wins completion race", { cancelFirst: true }, "CANCELLED"]
]) test("FIX child wrapper: " + name, async () => {
  const p = childProbe(options);
  try {
    await faultReject(p.run(), code); assert.equal(p.timers.size, 0);
    if (options.registrationThrows || options.timerThrows) assert.equal(p.stats.spawns, 0);
    else { assert.equal(p.stats.spawns, 1); assert.equal(p.stats.kills, 1); }
    if (code === "QUARANTINED") { assert.equal(p.stats.closes, 0); assert.throws(() => p.host.scope(p.session, "verify"), { code: "NATIVE_SCOPE_INVALID" }); }
    if (p.stats.spawns) assert.doesNotThrow(() => p.child.emit("error", new Error("late synthetic error")));
    else assert.equal(p.child.listenerCount("error"), 0, "an undispatched fixture is not an owned child");
  } finally { p.close(); }
});
for (const [name, options, expected] of [["normal completion", {}, "ok"], ["exit during setup", { closeDuringSetup: true }, ""], ["completion wins cancellation race", { cancelLast: true }, "ok"]])
  test("FIX child wrapper positive control: " + name, async () => {
    const p = childProbe(options);
    try { assert.equal(await p.run(), expected); assert.equal(p.stats.kills, 0); assert.equal(p.stats.closes, 1); assert.equal(p.timers.size, 0); }
    finally { p.close(); }
  });

function requestProbe(options = {}) {
  const module = memoryModule("nativeDocker"), f = setup(), session = sessionFor(f), EventEmitter = require("node:events");
  const stats = { requests: 0, destroys: 0, closes: 0, ends: 0, agentClosed: 0 }, timers = new Set(); let receive, timerCalls = 0;
  class Request extends EventEmitter {
    on(name, fn) { super.on(name, fn); if (name === "close" && !this.injected) {
      this.injected = true;
      if (options.setupError) this.emit("error", new Error("SECRET_CANARY request setup"));
      if (options.registrationAfterCreate) { h.revoke(session); h.onCancel(session, () => {}); }
    } return this; }
    destroy() { stats.destroys++; if (!options.noClose) { stats.closes++; this.emit("close"); } }
    end() {
      stats.ends++; if (options.hang) return;
      queueMicrotask(() => {
        if (options.asyncError) return this.emit("error", new Error("SECRET_CANARY response"));
        const response = new EventEmitter(); response.statusCode = 200; response.headers = {};
        response.destroy = () => response.emit("close"); receive(response);
        response.emit("data", Buffer.from("{}")); response.emit("end");
        if (!options.eofOnly) { stats.closes++; this.emit("close"); }
      });
    }
  }
  const request = new Request(), transport = {
    agent: { destroy() { stats.agentClosed++; } },
    request(url, settings, callback) {
      assert.equal(url.origin, "https://registry-1.docker.io"); assert.equal(settings.rejectUnauthorized, true); stats.requests++; receive = callback;
      if (options.revokeDuringCreate) h.revoke(session); return request;
    },
    registerCancel(fn) { if (options.registrationThrows) throw new Error("SECRET_CANARY registration"); return h.onCancel(session, fn); },
    setTimer(fn, ms) { timerCalls++; if (options.cleanupTimerThrows && timerCalls === 2) throw new Error("SECRET_CANARY timer");
      const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; },
    clearTimer(t) { clearTimeout(t); timers.delete(t); }
  };
  return { stats, timers, run: () => module.probePrivate.requestBytes(session, "https://registry-1.docker.io/v2/library/mysql/manifests/9.7.2-oraclelinux9", {}, transport, 30, 15),
    close() { h.revoke(session); for (const t of timers) clearTimeout(t); timers.clear(); } };
}
for (const [name, options, code] of [
  ["registration fails before creation", { registrationThrows: true }, "REGISTRY_INVALID"],
  ["revocation during creation", { revokeDuringCreate: true }, "CANCELLED"],
  ["registration fails after creation", { registrationAfterCreate: true }, "CANCELLED"],
  ["error during setup", { setupError: true }, "REGISTRY_INVALID"],
  ["asynchronous error", { asyncError: true }, "REGISTRY_INVALID"],
  ["timeout", { hang: true }, "TIMEOUT"],
  ["response EOF without request close", { eofOnly: true }, "TIMEOUT"],
  ["termination stays uncertain", { setupError: true, noClose: true }, "QUARANTINED"],
  ["post-create timeout setup fails", { setupError: true, noClose: true, cleanupTimerThrows: true }, "QUARANTINED"]
]) test("FIX HTTPS wrapper: " + name, async () => {
  const p = requestProbe(options);
  try {
    await faultReject(p.run(), code); assert.equal(p.timers.size, 0);
    if (options.registrationThrows) assert.equal(p.stats.requests, 0);
    else { assert.equal(p.stats.requests, 1); assert.equal(p.stats.destroys, 1); }
    if (options.revokeDuringCreate || options.registrationAfterCreate) assert.equal(p.stats.ends, 0);
    if (code === "QUARANTINED") assert.equal(p.stats.closes, 0);
    assert.equal(p.stats.agentClosed, 1);
  } finally { p.close(); }
});
test("FIX HTTPS positive control requires response EOF and independently observed request close", async () => {
  const p = requestProbe();
  try { const response = await p.run(); assert.equal(response.body.toString(), "{}"); assert.equal(p.stats.closes, 1); assert.equal(p.stats.destroys, 0); assert.equal(p.timers.size, 0); }
  finally { p.close(); }
});

test("SENSITIVITY removing pre-start admission reproduces the original start-before-rejection defect", async () => {
  let mutant;
  const bridge = { ...h, dockerInvoke: async (session, token) => {
    const request = mutant.readCommand(session, token);
    return h.testDriver(session, "host").processCall(request.executable, request.args, request.input, request.timeout);
  } };
  mutant = memoryModule("nativeDocker", source => replaceOnce(source,
    '    const admitted = await resourceSnapshot(true);\n    await h.journal(session, "intent", "start", created.get("container"));\n    const fresh = await resourceSnapshot(true);\n    h.check(e.same(admitted.raw, fresh.raw), "RESOURCE_INVALID");',
    '    await h.journal(session, "intent", "start", created.get("container"));'), { "./nativeHost.cjs": bridge });
  const spec = async module => {
    const options = {}, context = await stoppedDocker(options, module);
    try { options.resources = r => { delete r.container.Config.Labels["wmo.test.run"]; };
      await rejects(context.docker.start(), "RESOURCE_INVALID"); assert.equal(starts(context.f).length, 0); }
    finally { context.close(); }
  };
  await spec(require("./helpers/nativeDocker.cjs")); await assert.rejects(spec(mutant), { code: "ERR_ASSERTION" });
});
test("SENSITIVITY removing termination fails the observed-close child safety control", async () => {
  const spec = async mutate => {
    const p = childProbe({ setupError: true }, mutate);
    try { await faultReject(p.run(), "PROCESS_FAILED"); assert.equal(p.stats.kills, 1); assert.equal(p.stats.closes, 1); }
    finally { p.close(); }
  };
  await spec();
  await assert.rejects(spec(source => replaceOnce(source, "try { child.kill(); }", "try { /* mutation: no termination */ }")), { code: "ERR_ASSERTION" });
});
function lifecycleWithMysql(f, module) {
  return memoryModule("nativeLifecycle", source => source, { "./nativeMysql.cjs": module }).testing.createLifecycle(h.testing.challenge(f.c, policy, f.fake), sign(f.payload));
}
test("SENSITIVITY restoring numeric-only count comparison rejects legitimate string zero", async () => {
  const mutant = memoryModule("nativeMysql", source => replaceOnce(source, "normalizeCount(rows[0].n) === 0n", "rows[0].n === 0"));
  const spec = async module => {
    const f = setup({ count: "0" }), life = lifecycleWithMysql(f, module);
    try { await life.provision(life.scope("provision")); assert.equal(life.describe().stage, "fixtures-unready"); }
    finally { await life.dispose(); }
  };
  await spec(mysql); await assert.rejects(spec(mutant), { code: "NATIVE_FIXTURE_INVALID" });
});
test("SENSITIVITY unbranding smoke makes the forged-lifecycle rejection test fail", async () => {
  const mutant = memoryModule("nativeLifecycle", source => {
    const start = source.indexOf("async function smoke(lifecycle) {"), end = source.indexOf("\nmodule.exports =", start);
    assert.ok(start > 0 && end > start);
    return source.slice(0, start) + 'async function smoke(lifecycle) { const permits = Object.fromEntries(h.ACTIONS.map(a => [a, lifecycle.scope(a)])); try { await lifecycle.provision(permits.provision); await lifecycle.verify(permits.verify); await lifecycle.attest(permits.attest); await lifecycle.checkConnections(permits["connect-check"]); return await lifecycle.teardown(permits.teardown); } finally { await lifecycle.dispose(); } }\n' + source.slice(end);
  });
  const spec = async module => {
    let calls = 0; const step = async () => { calls++; };
    const fake = { scope: () => ({}), provision: step, verify: step, attest: step, checkConnections: step,
      teardown: async () => { calls++; return { nativeVerified: true, durableVerified: true }; }, dispose: step };
    await assert.rejects(module.smoke(fake), { code: "NATIVE_AUTH_INVALID" }); assert.equal(calls, 0);
  };
  await spec(native); await assert.rejects(spec(mutant), { code: "ERR_ASSERTION" });
  assert.throws(() => mutant.createNativeLifecycle({}, {}), { code: "NATIVE_TRUST_UNAVAILABLE" });
});
test("SENSITIVITY discarding locked appointments reproduces unauthorized readiness", async () => {
  const mutant = memoryModule("nativeMysql", source => replaceOnce(source,
    'if (table === "appointments") validateAppointmentRows(locked);', 'if (false) validateAppointmentRows(locked);'));
  const spec = async module => {
    const f = setup({ lockedRows: rows => { rows[0].orientation_token = "ORI-unexpected-synthetic"; } }), life = lifecycleWithMysql(f, module);
    try {
      await life.provision(life.scope("provision")); await life.verify(life.scope("verify"));
      await assert.rejects(life.attest(life.scope("attest")), { code: "NATIVE_RECONCILIATION_INVALID" }); assert.equal(readinessWrites(f).length, 0);
    } finally { await life.dispose(); }
  };
  await spec(mysql); await assert.rejects(spec(mutant), { code: "ERR_ASSERTION" });
});

for (const [name, mutate] of Object.entries({
  root_host: r => { r.container.Config.Env = r.container.Config.Env.map(v => v.startsWith("MYSQL_ROOT_HOST=") ? "MYSQL_ROOT_HOST=%" : v); },
  password_file: r => { r.container.Config.Env = r.container.Config.Env.map(v => v.startsWith("MYSQL_ROOT_PASSWORD_FILE=") ? "MYSQL_ROOT_PASSWORD_FILE=/tmp/unapproved" : v); },
  shell_entrypoint: r => { r.container.Config.Entrypoint = ["/bin/sh", "-c", "echo synthetic"]; },
  duplicate_equal: r => { r.container.Config.Env.push("MYSQL_ROOT_HOST=localhost"); },
  duplicate_conflicting: r => { r.container.Config.Env.push("MYSQL_ROOT_HOST=%"); },
  unexpected_env: r => { r.container.Config.Env.push("UNREVIEWED_OVERRIDE=1"); },
  missing_override: r => { r.container.Config.Env = r.container.Config.Env.filter(v => !v.startsWith("MYSQL_ROOT_HOST=")); },
  missing_image_default: r => { r.container.Config.Env = r.container.Config.Env.filter(v => !v.startsWith("PATH=")); },
  changed_image_default: r => { r.container.Config.Env = r.container.Config.Env.map(v => v.startsWith("PATH=") ? "PATH=/tmp/unapproved" : v); },
  malformed_env: r => { r.container.Config.Env.push("NO_EQUALS"); },
  missing_env: r => { delete r.container.Config.Env; },
  non_array_env: r => { r.container.Config.Env = { MYSQL_ROOT_HOST: "localhost" }; },
  missing_entrypoint: r => { r.container.Config.Entrypoint = null; },
  command: r => { r.container.Config.Cmd = ["--init-file=/tmp/unapproved"]; },
  user: r => { r.container.Config.User = "unexpected"; },
  working_directory: r => { r.container.Config.WorkingDir = "/tmp/unapproved"; },
  shell: r => { r.container.Config.Shell = ["/bin/sh", "-c"]; },
  stop_signal: r => { r.container.Config.StopSignal = "SIGKILL"; },
  escaped_args: r => { r.container.Config.ArgsEscaped = true; },
  healthcheck: r => { r.container.Config.Healthcheck = { Test: ["CMD-SHELL", "echo synthetic"] }; },
  executable: r => { r.container.Path = "/bin/sh"; },
  arguments: r => { r.container.Args = ["-c", "echo synthetic"]; },
  image_reference: r => { r.container.Config.Image = "mysql:unapproved"; },
  image_identity: r => { r.container.Image = "sha256:" + "f".repeat(64); },
  tty: r => { r.container.Config.Tty = true; },
  interactive_input: r => { r.container.Config.OpenStdin = true; },
  network_disabled: r => { r.container.Config.NetworkDisabled = true; },
  stop_timeout: r => { r.container.Config.StopTimeout = 90; }
})) test("P1 startup rejects stable " + name + " before start", async () => {
  const options = {}, context = await stoppedDocker(options);
  try {
    options.resources = mutate;
    await rejects(context.docker.start(), "RESOURCE_INVALID");
    assert.equal(starts(context.f).length, 0); assert.equal(kinds(context.f, "root").length, 0);
  } finally { context.close(); }
});

test("P1 verified image defaults survive exact overrides and environment reordering", async () => {
  const options = { imageDefaults: d => {
    d.Env.push("VERIFIED_VALUE=a=b", "MYSQL_ROOT_HOST=image-default", "MYSQL_ROOT_PASSWORD_FILE=/image-default");
    d.User = "mysql"; d.WorkingDir = "/var/lib/mysql"; d.StopSignal = "SIGTERM";
    d.Healthcheck = { Test: ["CMD", "true"], Interval: 1000000000 };
  } }, context = await stoppedDocker(options);
  options.resources = r => { r.container.Config.Env.reverse(); };
  try {
    await context.docker.start(); assert.equal(starts(context.f).length, 1);
    assert.equal(kinds(context.f, "docker").filter(v => v.value.startsWith("container inspect")).length, 3);
  } finally { context.close(); }
});

for (const [name, imageDefaults] of [
  ["duplicate image variable", d => { d.Env.push("MYSQL_MAJOR=unapproved"); }],
  ["missing executable entrypoint", d => { d.Entrypoint = []; }]
]) test("P1 malformed verified image defaults fail closed: " + name, async () => {
  const f = setup({ imageDefaults }), life = f.lifecycle();
  await rejects(life.provision(life.scope("provision")), "IMAGE_INVALID");
  assert.equal(starts(f).length, 0); assert.equal(kinds(f, "docker").filter(v => v.value.startsWith("container create")).length, 0);
});

test("P1 startup expectations cannot come from image bytes with the wrong digest", async () => {
  const f = setup({ registryMutation: (response, url) => { if (url.includes("/blobs/")) {
    const value = JSON.parse(response.body); value.config.Env.push("UNREVIEWED_OVERRIDE=1"); response.body = Buffer.from(JSON.stringify(value));
  } } }), life = f.lifecycle();
  await rejects(life.provision(life.scope("provision")), "IMAGE_INVALID"); assert.equal(starts(f).length, 0);
});

test("P1 post-start startup drift quarantines before any database operation", async () => {
  const options = {}, context = await stoppedDocker(options);
  options.afterStart = () => { options.resources = r => { r.container.Config.Env.push("UNREVIEWED_OVERRIDE=1"); }; };
  try {
    await rejects(context.docker.start(), "RESOURCE_INVALID"); assert.equal(starts(context.f).length, 1);
    assert.equal(context.docker.metrics().uncertain, true); assert.equal(kinds(context.f, "root").length, 0);
  } finally { context.close(); }
});

async function pipeErrorSpec(stream, options = {}, mutate) {
  const p = childProbe({ hang: true, ...options }, mutate);
  const outcome = p.run().then(value => ({ value }), caught => ({ caught }));
  try {
    await Promise.resolve(); // The error arrives after setup, outside the controller's synchronous try/catch.
    assert.doesNotThrow(() => p.child[stream].emit("error", new Error("SECRET_CANARY asynchronous pipe")));
    const result = await outcome;
    assert.equal(result.caught?.code, options.noClose || options.killFalse || options.killThrows ? "NATIVE_QUARANTINED" : "NATIVE_PROCESS_FAILED");
    assert.doesNotMatch(result.caught.message + result.caught.stack + JSON.stringify(result.caught), /SECRET_CANARY/);
    assert.equal(p.stats.kills, 1); assert.equal(p.stats.closes, options.noClose || options.killFalse || options.killThrows ? 0 : 1);
    assert.equal(p.timers.size, 0);
    if (result.caught.code === "NATIVE_QUARANTINED") assert.throws(() => p.host.scope(p.session, "verify"), { code: "NATIVE_SCOPE_INVALID" });
    for (const name of ["stdout", "stderr"]) assert.doesNotThrow(() => p.child[name].emit("error", new Error("SECRET_CANARY late pipe")));
    assert.equal(p.stats.kills, 1);
  } finally { p.close(); await outcome; }
}

for (const stream of ["stdout", "stderr"]) {
  test("P1 asynchronous " + stream + " failure observes termination without escaping", () => pipeErrorSpec(stream));
  for (const [name, options] of [["no close", { noClose: true }], ["kill refused", { killFalse: true }], ["kill throws", { killThrows: true }]])
    test("P1 " + stream + " failure quarantines when " + name, () => pipeErrorSpec(stream, options));

  test("P1 " + stream + " error during cancellation cannot terminate twice", async () => {
    const p = childProbe({ hang: true }), outcome = p.run().then(value => ({ value }), caught => ({ caught })), kill = p.child.kill.bind(p.child);
    p.child.kill = () => { p.child[stream].emit("error", new Error("SECRET_CANARY cancellation pipe")); return kill(); };
    try {
      assert.doesNotThrow(() => p.host.revoke(p.session));
      assert.equal((await outcome).caught?.code, "NATIVE_CANCELLED"); assert.equal(p.stats.kills, 1); assert.equal(p.stats.closes, 1);
      assert.doesNotThrow(() => p.child[stream].emit("error", new Error("SECRET_CANARY late cancelled pipe")));
      assert.equal(p.stats.kills, 1); assert.equal(p.timers.size, 0);
    } finally { p.close(); await outcome; }
  });

  test("P1 " + stream + " error coincident with timeout keeps one bounded outcome", async () => {
    const p = childProbe({ hang: true }), kill = p.child.kill.bind(p.child);
    p.child.kill = () => { p.child[stream].emit("error", new Error("SECRET_CANARY timeout pipe")); return kill(); };
    try {
      await faultReject(p.run(), "TIMEOUT"); assert.equal(p.stats.kills, 1); assert.equal(p.stats.closes, 1); assert.equal(p.timers.size, 0);
    } finally { p.close(); }
  });

  test("P1 late " + stream + " error after normal closure stays handled", async () => {
    const p = childProbe();
    try {
      assert.equal(await p.run(), "ok"); assert.equal(p.stats.closes, 1);
      assert.ok(p.child[stream].listenerCount("error") > 0);
      assert.doesNotThrow(() => p.child[stream].emit("error", new Error("SECRET_CANARY closed pipe")));
      assert.equal(p.stats.kills, 0); assert.equal(p.timers.size, 0);
    } finally { p.close(); }
  });

  test("P1 " + stream + " stays guarded after post-spawn registration fails", async () => {
    const p = childProbe({ registrationAfterSpawn: true });
    try {
      await faultReject(p.run(), "CANCELLED"); assert.equal(p.stats.kills, 1); assert.equal(p.stats.closes, 1);
      assert.doesNotThrow(() => p.child[stream].emit("error", new Error("SECRET_CANARY failed setup pipe")));
      assert.equal(p.stats.kills, 1); assert.equal(p.timers.size, 0);
    } finally { p.close(); }
  });
}

test("SENSITIVITY removing effective startup comparison admits the original root-host exploit", async () => {
  let mutant;
  const bridge = { ...h, dockerInvoke: async (session, token) => {
    const request = mutant.readCommand(session, token);
    return h.testDriver(session, "host").processCall(request.executable, request.args, request.input, request.timeout);
  } };
  mutant = memoryModule("nativeDocker", source => replaceOnce(source,
    "imageStartup && e.same(effective, imageStartup)", "imageStartup && true"), { "./nativeHost.cjs": bridge });
  const spec = async module => {
    const options = {}, context = await stoppedDocker(options, module);
    options.resources = r => { r.container.Config.Env = r.container.Config.Env.map(v => v.startsWith("MYSQL_ROOT_HOST=") ? "MYSQL_ROOT_HOST=%" : v); };
    try { await assert.rejects(context.docker.start(), { code: "NATIVE_RESOURCE_INVALID" }); assert.equal(starts(context.f).length, 0); }
    finally { context.close(); }
  };
  await spec(require("./helpers/nativeDocker.cjs")); await assert.rejects(spec(mutant), { code: "ERR_ASSERTION" });
});

for (const stream of ["stdout", "stderr"]) test("SENSITIVITY removing " + stream + " error handling reproduces the escaping error", async () => {
  await pipeErrorSpec(stream);
  await assert.rejects(pipeErrorSpec(stream, {}, source => replaceOnce(source,
    '      child.' + stream + '.on("error", caught => stop(caught));', '      /* in-memory mutation: pipe error listener removed */')), { code: "ERR_ASSERTION" });
});

const OWNER_FINGERPRINT = "4349e07a097600d70940fa3ab4438339217e9442e7e5270773389dd828006700";
function pinnedHostWithPublicKey(pem) {
  const original = memoryModule("nativeHost").probePrivate.verifiedOwnerTrust();
  return memoryModule("nativeHost", source => replaceOnce(source, JSON.stringify(original.publicKey), JSON.stringify(pem)));
}

test("TRUST rotated source pin is canonical Ed25519 SPKI with the exact DER fingerprint", () => {
  const host = memoryModule("nativeHost"), trust = host.probePrivate.verifiedOwnerTrust();
  assert.equal(trust.owner, "wmo-appointment-owner-v1"); assert.ok(Object.isFrozen(trust));
  const key = crypto.createPublicKey(trust.publicKey), der = key.export({ type: "spki", format: "der" });
  assert.equal(key.asymmetricKeyType, "ed25519"); assert.equal(h.hash(der), OWNER_FINGERPRINT);
  assert.notEqual(h.hash(trust.publicKey), OWNER_FINGERPRINT); assert.notEqual(trust.publicKey, testPublic);
  assert.equal(host.probePrivate.nativeActivation, false);
  assert.equal(h.probePrivate, undefined); assert.equal(h.OWNER_TRUST, undefined); assert.equal(h.NATIVE_ACTIVATION_ENABLED, undefined);
  assert.throws(() => host.requireOwnerTrust(), { code: "NATIVE_TRUST_UNAVAILABLE" });
});

test("TRUST mismatched source fingerprint fails without native admission", () => {
  const host = memoryModule("nativeHost", source => replaceOnce(source, OWNER_FINGERPRINT, "0".repeat(64)));
  assert.throws(() => host.probePrivate.verifiedOwnerTrust(), { code: "NATIVE_TRUST_UNAVAILABLE" });
  assert.throws(() => host.createNativeChallenge({}), { code: "NATIVE_TRUST_UNAVAILABLE" });
});

for (const [name, key] of [
  ["invalid SPKI", "-----BEGIN PUBLIC KEY-----\nAA==\n-----END PUBLIC KEY-----\n"],
  ["non-pinned synthetic key (retired-key equivalent)", testPublic],
  ["non-Ed25519 public key", publicCertificate.publicKey.export({ type: "spki", format: "pem" })],
  ["ambiguous multiple PEM blocks", testPublic + testPublic],
  ["unexpected PEM prefix", "unexpected\n" + testPublic]
]) test("TRUST rejects " + name + " without reading any owner key file", () => {
  const host = pinnedHostWithPublicKey(key);
  assert.throws(() => host.probePrivate.verifiedOwnerTrust(), { code: "NATIVE_TRUST_UNAVAILABLE" });
  assert.throws(() => host.requireOwnerTrust(), { code: "NATIVE_TRUST_UNAVAILABLE" });
});

test("TRUST refuses appended DER bytes even if a parser accepts the SPKI prefix", () => {
  const pinned = memoryModule("nativeHost").probePrivate.verifiedOwnerTrust();
  const der = crypto.createPublicKey(pinned.publicKey).export({ type: "spki", format: "der" });
  const pem = "-----BEGIN PUBLIC KEY-----\n" + Buffer.concat([der, Buffer.from([0])]).toString("base64") + "\n-----END PUBLIC KEY-----\n";
  const host = pinnedHostWithPublicKey(pem);
  assert.throws(() => host.probePrivate.verifiedOwnerTrust(), { code: "NATIVE_TRUST_UNAVAILABLE" });
});

test("TRUST synthetic canonical signatures remain isolated from the pinned real owner", () => {
  const f = setup(), reversed = Object.fromEntries(Object.entries(f.payload).reverse());
  assert.equal(h.testing.verifyReceipt(f.c, sign(reversed), policy).owner, "offline-owner");
  const owner = memoryModule("nativeHost").probePrivate.verifiedOwnerTrust();
  const forged = sign({ ...f.payload, owner: owner.owner });
  assert.throws(() => h.testing.verifyReceipt(f.c, forged, { ...policy, owner: owner.owner, publicKey: owner.publicKey }), { code: "NATIVE_AUTH_INVALID" });
  assert.throws(() => native.createNativeLifecycle(h.testing.challenge(f.c, policy, f.fake), forged), { code: "NATIVE_TRUST_UNAVAILABLE" });
  assert.equal(f.state.events.length, 0);
});

test("ADMISSION lock refuses before inspecting supplied configuration, receipt or stdin", async () => {
  let reads = 0;
  const opaque = new Proxy({}, { get() { reads++; throw new Error("SECRET_CANARY unexpected input access"); }, ownKeys() { reads++; throw new Error("SECRET_CANARY unexpected enumeration"); } });
  assert.throws(() => h.requireOwnerTrust(opaque), { code: "NATIVE_TRUST_UNAVAILABLE" });
  assert.throws(() => h.createNativeChallenge(opaque), { code: "NATIVE_TRUST_UNAVAILABLE" });
  assert.throws(() => native.createNativeLifecycle(opaque, opaque), { code: "NATIVE_TRUST_UNAVAILABLE" });
  await rejects(require("./helpers/runtime.cjs").nativeSmoke(opaque, opaque), "TRUST_UNAVAILABLE");
  assert.equal(reads, 0);
});

for (const variable of ["OWNER_TRUST", "NATIVE_ACTIVATION_ENABLED", "WMO_APPOINTMENT_OWNER_PUBLIC_KEY", "WMO_APPOINTMENT_OWNER_ID", "WMO_APPOINTMENT_NATIVE_ACTIVATION"])
  test("ADMISSION environment cannot override source trust/activation: " + variable, () => {
    const previous = process.env[variable];
    try {
      process.env[variable] = variable.includes("KEY") ? testPublic : "true";
      const host = memoryModule("nativeHost");
      assert.equal(host.probePrivate.verifiedOwnerTrust().owner, "wmo-appointment-owner-v1");
      assert.equal(host.probePrivate.nativeActivation, false);
      assert.throws(() => host.requireOwnerTrust(), { code: "NATIVE_TRUST_UNAVAILABLE" });
      assert.throws(() => host.createNativeChallenge({}), { code: "NATIVE_TRUST_UNAVAILABLE" });
    } finally { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; }
  });

test("ADMISSION caller JSON and mutable test metadata cannot enable the private gate", () => {
  const host = memoryModule("nativeHost"); host.probePrivate.nativeActivation = true; // A copied diagnostic value, never the private source constant.
  for (const input of [{ nativeActivation: true }, { OWNER_TRUST: { publicKey: testPublic }, NATIVE_ACTIVATION_ENABLED: true }]) {
    assert.throws(() => host.requireOwnerTrust(input), { code: "NATIVE_TRUST_UNAVAILABLE" });
    assert.throws(() => host.createNativeChallenge(input), { code: "NATIVE_TRUST_UNAVAILABLE" });
  }
  assert.ok(!Object.keys(h).some(k => /enable|unlock|set.*trust|set.*activation/i.test(k)));
});

for (const args of [["--native-smoke"], ["--native-smoke", "--enable-native"], ["--native-smoke", "--owner-public-key=synthetic"], ["--provision"]])
  test("ADMISSION CLI cannot authorize native execution: " + args.join(" "), async () => {
    let stdout = "", stderr = "";
    assert.equal(await launcher.main(args, { stdout: { write: v => { stdout += v; } }, stderr: { write: v => { stderr += v; } } }), 2);
    assert.equal(stdout, "");
    assert.doesNotMatch(stderr, /SECRET_CANARY|PRIVATE KEY|CREDENTIAL/);
    if (args.length === 1 && args[0] === "--native-smoke") assert.match(stderr, /NATIVE_TRUST_UNAVAILABLE/);
  });

test("ADMISSION mock scope cannot be admitted as native even with a pinned owner identity", () => {
  const f = setup(), owner = memoryModule("nativeHost").probePrivate.verifiedOwnerTrust();
  const challenge = h.testing.challenge(f.c, policy, f.fake), receipt = sign({ ...f.payload, owner: owner.owner });
  assert.throws(() => h.activate(challenge, receipt), { code: "NATIVE_AUTH_INVALID" });
  assert.throws(() => native.createNativeLifecycle(challenge, receipt), { code: "NATIVE_TRUST_UNAVAILABLE" });
  assert.equal(f.state.events.length, 0);
});

test("ADMISSION public key integration leaves the offline plan non-executable", async () => {
  let output = "";
  assert.equal(await launcher.main(["--plan"], { stdout: { write: v => { output += v; } }, stderr: { write() { assert.fail("unexpected plan error"); } } }), 0);
  const plan = JSON.parse(output);
  assert.equal(plan.performsExternalOperations, false); assert.equal(plan.writeAccess, false);
  assert.equal(plan.capabilities.nativeExecutionAvailable, false);
});
