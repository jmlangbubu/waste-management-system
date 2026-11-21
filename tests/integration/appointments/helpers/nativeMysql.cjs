"use strict";

const h = require("./nativeHost.cjs"), e = require("./environment.cjs"), schema = require("./schema.cjs"), assertions = require("./assertions.cjs");
const TABLES = Object.freeze(["appointments", "notifications", "appointment_reservations", "appointment_booking_requests", "appointment_feature_state", "appointment_harness_identity"]);
const ROLES = Object.freeze(["setup", "application", "observer"]);
const q = name => "`" + name + "`";
function clientAddress(host) {
  h.check(typeof host === "string" && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split(".").every(v => Number(v) <= 255) &&
    /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host), "SERVER_INVALID"); return host;
}
function account(c, role, host) { h.check(ROLES.includes(role), "GRANTS_INVALID"); return "'" + c.accounts[role] + "'@'" + clientAddress(host) + "'"; }
// Pure, finite root protocol. This is NOT a SQL runner: neither SQL nor identifiers come from callers.
function rootProgram(configuration, operation, input = {}) {
  const c = e.validatePhase4BConfiguration(configuration), a = h.data(input), db = q(c.schema);
  switch (operation) {
    case "identity": h.exact(a, []); return "SELECT JSON_OBJECT('uuid', @@server_uuid, 'version', @@version, 'distribution', @@version_comment, 'mysqlx', (SELECT COUNT(*) FROM information_schema.plugins WHERE PLUGIN_NAME = 'mysqlx' AND PLUGIN_STATUS = 'ACTIVE'));";
    case "client-host": h.exact(a, ["threadId"]); h.check(Number.isSafeInteger(a.threadId) && a.threadId > 0 && a.threadId <= 4294967295, "SERVER_INVALID");
      return "SELECT JSON_OBJECT('host', PROCESSLIST_HOST) FROM performance_schema.threads WHERE PROCESSLIST_ID = " + a.threadId + ";";
    case "create-schema": h.exact(a, []); return "CREATE DATABASE " + db + " CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;";
    case "empty": h.exact(a, []); return "SELECT JSON_OBJECT('tables', (SELECT COUNT(*) FROM information_schema.tables WHERE TABLE_SCHEMA = '" + c.schema + "'), 'extras', (SELECT COUNT(*) FROM information_schema.routines WHERE ROUTINE_SCHEMA = '" + c.schema + "') + (SELECT COUNT(*) FROM information_schema.events WHERE EVENT_SCHEMA = '" + c.schema + "'));";
    case "create-account": h.exact(a, ["role", "host", "password"]);
      h.check(typeof a.password === "string" && /^[A-Za-z0-9_-]{43}$/.test(a.password), "SECRET_INVALID");
      return "CREATE USER " + account(c, a.role, a.host) + " IDENTIFIED WITH caching_sha2_password BY '" + a.password + "' REQUIRE SSL;";
    case "grant": {
      h.exact(a, ["role", "host", "stage", "table"]); h.check(ROLES.includes(a.role) && TABLES.includes(a.table), "GRANTS_INVALID");
      const right = e.expectedPhase4BGrants(c, a.stage)[a.role].rights.find(v => v.table === a.table);
      h.check(right && right.privileges.length, "GRANTS_INVALID");
      const rights = right.privileges.map(v => v.startsWith("UPDATE(") ? "UPDATE (" + q(v.slice(7, -1)) + ")" : v);
      return "GRANT " + rights.join(", ") + " ON " + db + "." + q(a.table) + " TO " + account(c, a.role, a.host) + ";";
    }
    case "grants": h.exact(a, ["role", "host"]); return "SHOW GRANTS FOR " + account(c, a.role, a.host) + ";";
    case "roles": h.exact(a, ["role", "host"]); account(c, a.role, a.host);
      return "SELECT JSON_OBJECT('mandatory', @@global.mandatory_roles, 'roles', (SELECT COUNT(*) FROM mysql.role_edges WHERE TO_USER = '" + c.accounts[a.role] + "' AND TO_HOST = '" + a.host + "'), 'defaults', (SELECT COUNT(*) FROM mysql.default_roles WHERE USER = '" + c.accounts[a.role] + "' AND HOST = '" + a.host + "'), 'proxy', (SELECT COUNT(*) FROM mysql.proxies_priv WHERE User = '" + c.accounts[a.role] + "' AND Host = '" + a.host + "'));";
    default: throw new h.NativeError("SCOPE_INVALID");
  }
}
function parseGrants(configuration, role, host, text) {
  const c = e.validatePhase4BConfiguration(configuration); account(c, role, host);
  h.check(typeof text === "string" && text.length > 0 && text.length < 32768, "GRANTS_INVALID");
  const expectedAccount = "`" + c.accounts[role] + "`@`" + host + "`", rights = new Map(); let usage = false;
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    h.check(!line.includes("GRANT OPTION") && !line.includes("PROXY") && !line.includes("REVOKE"), "GRANTS_INVALID");
    if (line === "GRANT USAGE ON *.* TO " + expectedAccount) { h.check(!usage, "GRANTS_INVALID"); usage = true; continue; }
    const match = /^GRANT (.+) ON `([^`]+)`\.`([^`]+)` TO (.+)$/.exec(line);
    h.check(match && match[2] === c.schema && TABLES.includes(match[3]) && match[4] === expectedAccount && !rights.has(match[3]), "GRANTS_INVALID");
    const privileges = match[1].split(/,\s*/).map(v => {
      if (["CREATE", "INSERT", "SELECT", "REFERENCES", "UPDATE", "DELETE"].includes(v)) return v;
      const column = /^UPDATE \(`(backfill_complete|reconciled)`\)$/.exec(v);
      h.check(column && (column[1] === "reconciled" ? match[3] === "appointment_harness_identity" : match[3] === "appointment_feature_state"), "GRANTS_INVALID");
      return "UPDATE(" + column[1] + ")";
    });
    h.check(new Set(privileges).size === privileges.length, "GRANTS_INVALID"); rights.set(match[3], privileges.sort());
  }
  h.check(usage, "GRANTS_INVALID");
  return { account: c.accounts[role], global: [], roles: [], rights: [...rights].map(([table, privileges]) => ({ schema: c.schema, table, privileges })) };
}
function sameRows(actual, expected) {
  const sorted = rows => rows.map(v => h.canonical(v)).sort(); return e.same(sorted(actual), sorted(expected));
}
function plain(rows) { h.check(Array.isArray(rows) && rows.length <= 511, "FIXTURE_INVALID"); return rows.map(row => Object.fromEntries(Object.entries(row))); }
function json(text, code = "SERVER_INVALID") { try { return JSON.parse(text); } catch (_) { throw new h.NativeError(code); } }
function normalizeCount(value, code = "FIXTURE_INVALID") {
  if (typeof value === "bigint") { h.check(value >= 0n, code); return value; }
  if (typeof value === "number") { h.check(Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0), code); return BigInt(value); }
  h.check(typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value), code);
  return BigInt(value);
}
function normalizeColumn(row) {
  const result = { ...row };
  if (typeof result.COLUMN_DEFAULT === "string" && /^current_timestamp(?:\(0?\))?$/i.test(result.COLUMN_DEFAULT)) result.COLUMN_DEFAULT = "CURRENT_TIMESTAMP";
  if (typeof result.EXTRA === "string") result.EXTRA = result.EXTRA.replace(/current_timestamp\(0?\)/ig, "CURRENT_TIMESTAMP");
  return result;
}
const METADATA = Object.freeze({
  tables: "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
  columns: "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, DATETIME_PRECISION, CHARACTER_SET_NAME, COLLATION_NAME, GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?",
  indexes: "SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART, EXPRESSION, INDEX_TYPE, IS_VISIBLE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?",
  foreignKeys: "SELECT k.CONSTRAINT_SCHEMA, k.CONSTRAINT_NAME, k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION, k.POSITION_IN_UNIQUE_CONSTRAINT, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME WHERE k.TABLE_SCHEMA = ?",
  extras: "SELECT (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?) + (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?) + (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?) AS n"
});
function createMysql(session, docker) {
  require("./nativeDocker.cjs").assertDocker(session, docker);
  const { configuration: c, kind } = h.describe(session), profile = schema.provisioningProfile(c), spec = schema.fixtureSpecification();
  const qualified = table => q(c.schema) + "." + q(table);
  // Use the approved seed/default definitions; CURRENT_TIMESTAMP is server-generated, not a fixed fixture instant.
  const initialAppointment = Object.fromEntries(Object.entries(spec.tables.appointments.columns)
    .filter(([, column]) => column.default !== "CURRENT_TIMESTAMP")
    .map(([name, column]) => [name, Object.hasOwn(spec.citizen, name) ? spec.citizen[name] :
      Object.hasOwn(profile.expectedSnapshot.appointments[0], name) ? profile.expectedSnapshot.appointments[0][name] : column.default]));
  const appointmentColumns = Object.keys(initialAppointment);
  function validateAppointmentRows(rows) {
    h.check(rows.length === 1 && rows[0].id === initialAppointment.id, "RECONCILIATION_INVALID");
    const row = rows[0];
    h.check(appointmentColumns.every(name => Object.hasOwn(row, name)), "RECONCILIATION_INVALID");
    const actual = Object.fromEntries(appointmentColumns.map(name => [name, name === "appointment_revision" ?
      (normalizeCount(row[name], "RECONCILIATION_INVALID") === 0n ? 0 : row[name]) : row[name]]));
    h.check(e.same(actual, initialAppointment), "RECONCILIATION_INVALID");
    return actual;
  }
  let driver, uuid, host, ca, certificate, pool, stopped = false, attested = false, bootstrapped = false, fixtureAttempted = false, uncertain = false, queries = 0;
  const connections = new Set();
  async function root(op, args) { h.access(session); queries++; return docker.root(op, args); }
  function destroy(connection) { if (!connection) return; try { connection.destroy(); } catch (_) { /* Retire regardless. */ } connections.delete(connection); }
  async function query(connection, sql, values = [], execute = false) {
    h.access(session); h.check(!stopped && connections.has(connection), "CONNECTION_INVALID"); queries++;
    try { return await h.bounded(session, () => new Promise((resolve, reject) => {
      const method = execute ? "execute" : "query";
      connection[method]({ sql, timeout: 5000 }, values, (caught, result) => {
        if (caught) {
          const fatal = Object.getOwnPropertyDescriptor(caught, "fatal"); if (fatal && Object.hasOwn(fatal, "value") && fatal.value === true) destroy(connection);
          reject(new h.NativeError("CONNECTION_INVALID"));
        } else if (result == null) reject(new h.NativeError("CONNECTION_INVALID")); else resolve(result);
      });
    }), 5000, () => destroy(connection)); } catch (caught) {
      const safe = h.error(caught, "CONNECTION_INVALID"); if (["NATIVE_TIMEOUT", "NATIVE_CANCELLED", "NATIVE_SCOPE_INVALID"].includes(safe.code)) destroy(connection); throw safe;
    }
  }
  function verifyPeer(connection) {
    const peer = connection.stream;
    h.check(peer && peer.authorized === true && ["TLSv1.2", "TLSv1.3"].includes(peer.getProtocol()) &&
      h.hash(peer.getPeerCertificate().raw) === h.hash(certificate.raw) && peer.remoteAddress === "127.0.0.1" && peer.remotePort === c.endpoint.port, "TLS_INVALID");
  }
  function options(role) {
    h.check(ROLES.includes(role) && ca && certificate, "CONNECTION_INVALID");
    return { host: "127.0.0.1", port: c.endpoint.port, database: c.schema, user: c.accounts[role], password: h.secret(session, role),
      connectTimeout: 5000, multipleStatements: false, debug: false, namedPlaceholders: false, dateStrings: true, timezone: "Z",
      supportBigNumbers: true, bigNumberStrings: true, flags: ["-LOCAL_FILES"], infileStreamFactory: () => { throw new h.NativeError("CONNECTION_INVALID"); },
      ssl: { ca: ca.toString(), rejectUnauthorized: true, verifyIdentity: false, minVersion: "TLSv1.2" } };
  }
  async function identity(connection, role) {
    verifyPeer(connection);
    const rows = plain(await query(connection, "SELECT @@server_uuid AS uuid, DATABASE() AS `schema`, CURRENT_USER() AS account, USER() AS client"));
    h.check(rows.length === 1 && rows[0].uuid === uuid && rows[0].schema === c.schema && rows[0].account === c.accounts[role] + "@" + host &&
      rows[0].client === c.accounts[role] + "@" + host, "SERVER_INVALID");
    return rows[0];
  }
  async function connect(role) {
    h.access(session); h.check(!stopped && uuid && host, "STAGE_INVALID");
    if (!driver) driver = await h.loadMysql(session);
    let connection;
    try {
      connection = driver.createConnection(options(role)); connections.add(connection);
      await h.bounded(session, () => new Promise((resolve, reject) => connection.connect(caught => caught ? reject(new h.NativeError("CONNECTION_INVALID")) : resolve())), 5000, () => destroy(connection));
      await identity(connection, role); return connection;
    } catch (caught) { destroy(connection); throw h.error(caught); }
  }
  async function close(connection) {
    if (!connections.has(connection)) return;
    await new Promise(resolve => {
      let done = false; const finish = () => { if (done) return; done = true; clearTimeout(timer); destroy(connection); resolve(); };
      const timer = setTimeout(finish, 1000); try { connection.end(finish); } catch (_) { finish(); }
    });
  }
  async function transaction(connection, operation) {
    let began = false, commitSent = false, committed = false, previous;
    try {
      const timezone = plain(await query(connection, "SELECT @@session.time_zone AS timezone"));
      h.check(timezone.length === 1 && typeof timezone[0].timezone === "string", "CONNECTION_INVALID"); previous = timezone[0].timezone;
      await query(connection, "SET SESSION time_zone = '+00:00'"); await query(connection, "START TRANSACTION"); began = true;
      const value = await operation(); commitSent = true;
      const ack = await query(connection, "COMMIT");
      h.check(typeof ack.serverStatus === "number" && !(ack.serverStatus & 1), "COMMIT_UNCERTAIN"); committed = true;
      await query(connection, "SET SESSION time_zone = ?", [previous]); return value;
    } catch (caught) {
      if (commitSent && !committed) { uncertain = true; destroy(connection); throw new h.NativeError("COMMIT_UNCERTAIN"); }
      if (committed) { destroy(connection); throw h.error(caught, "CONNECTION_INVALID"); }
      if (began && !committed && connections.has(connection)) {
        try { await query(connection, "ROLLBACK"); } catch (_) { destroy(connection); throw new h.NativeError("ROLLBACK_FAILED"); }
      }
      if (connections.has(connection) && previous !== undefined) { try { await query(connection, "SET SESSION time_zone = ?", [previous]); } catch (_) { destroy(connection); } }
      throw h.error(caught);
    }
  }
  async function verifyServer() {
    h.access(session, ["provision"]);
    const o = json(await root("identity", {}));
    h.exact(o, ["uuid", "version", "distribution", "mysqlx"], "SERVER_INVALID");
    h.check(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(o.uuid) && o.version === c.image.version && o.distribution === c.image.distribution && normalizeCount(o.mysqlx, "SERVER_INVALID") === 0n, "SERVER_INVALID");
    const os = await docker.readFile("os");
    h.check(/^ID="?ol"?$/m.test(os) && /^VERSION_ID="?9"?$/m.test(os), "SERVER_INVALID"); uuid = o.uuid;
    const X509 = require("node:crypto").X509Certificate;
    try { ca = new X509(await docker.readFile("ca")); certificate = new X509(await docker.readFile("certificate"));
      h.check(ca.ca && certificate.verify(ca.publicKey) && Date.parse(certificate.validFrom) <= Date.now() && Date.parse(certificate.validTo) > Date.now(), "TLS_INVALID");
    } catch (_) { throw new h.NativeError("TLS_INVALID"); }
    return { uuid, version: o.version };
  }
  async function nativeProbe() {
    const net = require("node:net");
    return new Promise((resolve, reject) => {
      let bytes = Buffer.alloc(0), timer, done = false, unregister = () => {};
      const socket = net.createConnection({ host: "127.0.0.1", port: c.endpoint.port });
      const fail = () => { if (done) return; done = true; clearTimeout(timer); unregister(); socket.destroy(); reject(new h.NativeError("CONNECTION_INVALID")); };
      socket.on("error", fail); socket.on("data", b => {
        bytes = Buffer.concat([bytes, b]); if (bytes.length > 4096) return fail();
        if (bytes.length < 5) return;
        const length = bytes.readUIntLE(0, 3); if (bytes.length < length + 4) return;
        if (bytes[3] !== 0 || bytes[4] !== 10 || socket.remoteAddress !== "127.0.0.1" || socket.remotePort !== c.endpoint.port) return fail();
        const end = bytes.indexOf(0, 5); if (end < 0 || end + 5 > bytes.length) return fail();
        done = true; clearTimeout(timer); resolve({ threadId: bytes.readUInt32LE(end + 1), close: () => { unregister(); socket.destroy(); } });
      }); timer = setTimeout(fail, 5000); unregister = h.onCancel(session, () => { if (done) { unregister(); socket.destroy(); } else fail(); });
    });
  }
  async function bootstrap() {
    h.access(session, ["provision"]); h.check(uuid && !host, "STAGE_INVALID");
    const probe = kind === "mock" ? await h.testDriver(session, "mysql").probe() : await nativeProbe();
    try { const observed = json(await root("client-host", { threadId: probe.threadId })); h.exact(observed, ["host"], "SERVER_INVALID"); host = clientAddress(observed.host); }
    finally { probe.close(); }
    await h.journal(session, "intent", "bootstrap");
    await root("create-schema", {});
    for (const role of ROLES) await root("create-account", { role, host, password: h.secret(session, role) });
    await grant("bootstrap");
    const empty = json(await root("empty", {})); h.exact(empty, ["tables", "extras"], "FIXTURE_INVALID");
    h.check(normalizeCount(empty.tables) === 0n && normalizeCount(empty.extras) === 0n, "FIXTURE_INVALID");
    const setup = await connect("setup");
    try { h.check(plain(await query(setup, METADATA.tables, [c.schema])).length === 0, "FIXTURE_INVALID"); }
    finally { await close(setup); }
    await verifyGrants("bootstrap"); await h.journal(session, "observed", "bootstrap"); bootstrapped = true;
  }
  async function grant(stage) {
    for (const role of ROLES) for (const right of e.expectedPhase4BGrants(c, stage)[role].rights) await root("grant", { role, host, stage, table: right.table });
  }
  async function verifyGrants(stage = "runtime") {
    h.access(session); const observed = {};
    for (const role of ROLES) {
      const facts = json(await root("roles", { role, host }), "GRANTS_INVALID");
      h.exact(facts, ["mandatory", "roles", "defaults", "proxy"], "GRANTS_INVALID");
      h.check(facts.mandatory === "" && [facts.roles, facts.defaults, facts.proxy].every(v => normalizeCount(v, "GRANTS_INVALID") === 0n), "GRANTS_INVALID");
      observed[role] = parseGrants(c, role, host, await root("grants", { role, host }));
    }
    const expected = e.expectedPhase4BGrants(c, stage);
    for (const role of ROLES) { h.check(sameRows(observed[role].rights, expected[role].rights), "GRANTS_INVALID"); observed[role].rights = expected[role].rights; }
    e.validatePhase4BGrants(c, observed, stage); return true;
  }
  async function fixtures() {
    h.access(session, ["provision"]); h.check(host && bootstrapped && !fixtureAttempted && !attested && !uncertain, "STAGE_INVALID"); fixtureAttempted = true;
    schema.validateInstantiatedProvisioningProfile(c, profile);
    await h.journal(session, "intent", "fixture"); const setup = await connect("setup");
    try {
      const creates = profile.ddl.filter(v => v.sql.startsWith("CREATE TABLE "));
      const initial = profile.ddl.filter(v => v.sql.startsWith("INSERT INTO " + qualified("appointment_feature_state")));
      h.check(creates.length === 6 && initial.length === 1 && creates.length + initial.length === profile.ddl.length, "FIXTURE_INVALID");
      for (const statement of creates) await query(setup, statement.sql, statement.parameters);
      await grant("runtime"); await verifyGrants();
      // The unchanged profile stores its unready marker INSERT beside DDL. Execute that DML atomically with the seeds.
      await transaction(setup, async () => { for (const statement of [...initial, ...profile.seed]) await query(setup, statement.sql, statement.parameters, true); });
    } finally { await close(setup); }
    await reconcile(false); await h.journal(session, "observed", "fixture");
  }
  async function metadata(connection, ready) {
    const expected = schema.provisioningMetadata(c);
    for (const [name, sql] of Object.entries(METADATA)) {
      const rows = plain(await query(connection, sql, name === "extras" ? [c.schema, c.schema, c.schema] : [c.schema]));
      if (name === "extras") { h.check(rows.length === 1 && normalizeCount(rows[0].n) === 0n, "FIXTURE_INVALID"); continue; }
      if (name === "tables") for (const row of rows) { h.check(row.TABLE_COLLATION === "utf8mb4_general_ci", "FIXTURE_INVALID"); delete row.TABLE_COLLATION; }
      h.check(sameRows(name === "columns" ? rows.map(normalizeColumn) : rows, expected[name]), "FIXTURE_INVALID");
    }
    const markers = plain(await query(connection, "SELECT feature_key, schema_version, backfill_complete FROM " + qualified("appointment_feature_state")));
    const identities = plain(await query(connection, "SELECT * FROM " + qualified("appointment_harness_identity")));
    h.check(sameRows(markers, [{ ...profile.marker, backfill_complete: ready ? 1 : 0 }]) && sameRows(identities, [schema.identityRow(c, ready ? 1 : 0)]), "RECONCILIATION_INVALID");
  }
  async function snapshot(connection) {
    const select = {
      appointments: appointmentColumns.join(", "),
      reservations: "appointment_id, service_key, appointment_date, appointment_time",
      requests: "request_hash, payload_hash, appointment_id, appointment_code", notifications: "id, type"
    };
    const mapping = { appointments: "appointments", reservations: "appointment_reservations", requests: "appointment_booking_requests", notifications: "notifications" }, result = {};
    for (const name of Object.keys(select)) {
      result[name] = plain(await query(connection, "SELECT " + select[name] + " FROM " + qualified(mapping[name])));
      if (name === "appointments") result[name] = result[name].map(row => {
        const actual = validateAppointmentRows([row]);
        return Object.fromEntries(Object.keys(profile.expectedSnapshot.appointments[0]).map(key => [key, actual[key]]));
      });
      h.check(sameRows(result[name], profile.expectedSnapshot[name]), "RECONCILIATION_INVALID");
    }
    assertions.assertReservationIntegrity(result);
    const citizen = plain(await query(connection, "SELECT full_name, barangay, contact_number, email, purpose, preferred_date, notes FROM " + qualified("appointments")));
    h.check(sameRows(citizen, [spec.citizen]), "RECONCILIATION_INVALID");
    return result;
  }
  async function reconcile(ready = attested) {
    h.access(session); await verifyGrants(); const observer = await connect("observer");
    try { await metadata(observer, ready); return await snapshot(observer); } finally { await close(observer); }
  }
  async function attest() {
    h.access(session, ["attest"]); h.check(!attested && !uncertain, "STAGE_INVALID");
    await verifyGrants(); await reconcile(false); const setup = await connect("setup");
    await h.journal(session, "intent", "attest");
    try {
      await transaction(setup, async () => {
        for (const table of ["appointment_harness_identity", "appointment_feature_state", "appointments", "appointment_reservations", "appointment_booking_requests", "notifications"]) {
          const locked = plain(await query(setup, "SELECT * FROM " + qualified(table) + " ORDER BY " + (table === "appointment_harness_identity" ? "run_id" : table === "appointment_feature_state" ? "feature_key" : table === "appointment_reservations" ? "service_key, appointment_date, appointment_time" : table === "appointment_booking_requests" ? "request_hash" : "id") + " FOR UPDATE"));
          if (table === "appointments") validateAppointmentRows(locked);
        }
        await metadata(setup, false); await snapshot(setup);
        for (const statement of schema.attestationStatements(c).updates) {
          const result = await query(setup, statement.sql, statement.parameters, true); h.check(result.affectedRows === 1, "ATTESTATION_INVALID");
        }
      });
    } finally { await close(setup); }
    // A separate connection observes only committed state; it cannot reuse the setup transaction snapshot.
    await reconcile(true); attested = true; await h.journal(session, "observed", "attest");
  }
  async function connectCheck() {
    h.access(session, ["connect-check"]); h.check(attested && !uncertain && !pool, "STAGE_INVALID");
    await reconcile(true); if (!driver) driver = await h.loadMysql(session);
    pool = driver.createPool({ ...options("application"), connectionLimit: 1, waitForConnections: false, queueLimit: 0, maxIdle: 1, idleTimeout: 1000 });
    let connection;
    try {
      connection = await h.bounded(session, () => new Promise((resolve, reject) => pool.getConnection((caught, value) => {
        if (caught || !value) reject(new h.NativeError("CONNECTION_INVALID")); else if (stopped) { value.destroy(); reject(new h.NativeError("CANCELLED")); } else resolve(value);
      })), 5000, () => { stopped = true; });
      connections.add(connection); await identity(connection, "application");
      const marker = plain(await query(connection, "SELECT feature_key, schema_version, backfill_complete FROM " + qualified("appointment_feature_state")));
      h.check(sameRows(marker, [{ ...profile.marker, backfill_complete: 1 }]), "RECONCILIATION_INVALID");
    } finally { destroy(connection); await closePool(); }
    await reconcile(true); return { application: true, observer: true };
  }
  async function closePool() {
    if (!pool) return; const current = pool;
    await new Promise((resolve, reject) => { let done = false;
      const finish = caught => { if (done) return; done = true; clearTimeout(timer); if (caught) reject(new h.NativeError("CLEANUP_INVALID")); else { pool = null; resolve(); } };
      const timer = setTimeout(() => finish(new h.NativeError("CLEANUP_INVALID")), 1000); try { current.end(finish); } catch (caught) { finish(caught); } });
  }
  async function dispose() { stopped = true; for (const connection of [...connections]) destroy(connection); await closePool(); return { connections: connections.size, pools: pool ? 1 : 0 }; }
  return Object.freeze({ verifyServer, bootstrap, fixtures, verifyGrants, reconcile, attest, connectCheck, dispose,
    metrics: () => ({ queries, connections: connections.size, pools: pool ? 1 : 0, uncertain, attested }) });
}
module.exports = { createMysql, rootProgram, parseGrants, normalizeCount, METADATA };
