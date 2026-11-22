"use strict";

// Inert on import. No dotenv, production pool, driver, listener or credentials are loaded here.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const Module = require("node:module");
const EXECUTE = "I_AUTHORIZE_LOCAL_DISPOSABLE_MYSQL";
const ROOT = path.resolve(__dirname, "../..");
const TABLES = ["appointments", "notifications", "appointment_reservations", "appointment_booking_requests", "appointment_feature_state", "web_users", "web_admin_sessions"];

function validateTarget(env) {
  const refuse = () => { throw new Error("STAGING_TARGET_REFUSED: explicit fresh local fixture required"); };
  if (env.WMO_APPOINTMENT_MYSQL_EXECUTE !== EXECUTE || ["DATABASE_URL", "MYSQL_URL", "RESEND_API_KEY"].some(name => Object.hasOwn(env, name))) refuse();
  const database = env.WMO_APPOINTMENT_MYSQL_DATABASE, port = Number(env.WMO_APPOINTMENT_MYSQL_PORT);
  if (env.WMO_APPOINTMENT_MYSQL_HOST !== "127.0.0.1" || !Number.isInteger(port) || port < 1024 || port > 65535 || port === 3306 ||
      !/^wmo_appointment_staging_[a-z0-9_]{1,32}$/.test(database || "") || env.WMO_APPOINTMENT_MYSQL_CONFIRM_EMPTY !== database ||
      env.WMO_APPOINTMENT_MYSQL_USER !== "wmo_appt_stage_app" || env.WMO_APPOINTMENT_MYSQL_OBSERVER_USER !== "wmo_appt_stage_observer" ||
      !env.WMO_APPOINTMENT_MYSQL_PASSWORD || !env.WMO_APPOINTMENT_MYSQL_OBSERVER_PASSWORD) refuse();
  return { host: "127.0.0.1", port, database, user: env.WMO_APPOINTMENT_MYSQL_USER, password: env.WMO_APPOINTMENT_MYSQL_PASSWORD,
    observerUser: env.WMO_APPOINTMENT_MYSQL_OBSERVER_USER, observerPassword: env.WMO_APPOINTMENT_MYSQL_OBSERVER_PASSWORD };
}
function fixtureStatements() {
  const sql = fs.readFileSync(path.join(ROOT, "tests/fixtures/appointmentMysql.schema.sql"), "utf8").replace(/^\s*--.*$/gm, "");
  const statements = sql.split(";").map(s => s.trim()).filter(Boolean);
  assert.equal(statements.length, 8);
  assert.ok(statements.slice(0, 7).every(s => /^CREATE TABLE [a-z_]+ \(/.test(s) && /ENGINE=InnoDB/.test(s)));
  assert.match(statements[7], /VALUES \('service_slots', 1, 0\)$/);
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE|GRANT|CREATE DATABASE|USE)\b/i);
  return statements; // Inspection only. The test launcher NEVER executes this fixture.
}
function barrier(parties = 2, timeout = 8000) {
  let release, reject, timer, done = false;
  const ids = new Set(), promise = new Promise((yes, no) => { release = yes; reject = no; });
  promise.catch(() => {});
  function cancel() { if (!done) { done = true; clearTimeout(timer); reject(new Error("STAGING_BARRIER_ABORTED")); } }
  return { ids, cancel, async arrive(id) {
    assert.ok(!ids.has(id), "Concurrent work must use different physical connections"); ids.add(id);
    if (!timer) timer = setTimeout(cancel, timeout);
    if (ids.size === parties && !done) { done = true; clearTimeout(timer); release(); }
    await promise;
  } };
}
function instrumentPool(pool) {
  const controls = { gate: null, failNotification: false, loseCommitAck: false }, leases = [], active = new Set();
  const wrapped = { query: pool.query.bind(pool) };
  wrapped.getConnection = callback => pool.getConnection((error, raw) => {
    if (error) return callback(error);
    const record = { id: raw.threadId, events: [], released: 0, destroyed: 0, priorTimezone: null, restoredTimezone: null };
    leases.push(record); active.add(raw);
    const connection = new Proxy(raw, { get(target, name) {
      if (name === "query") return (sql, values, done) => {
        if (typeof values === "function") { done = values; values = []; }
        if (controls.failNotification && /^INSERT INTO notifications/.test(sql)) {
          controls.failNotification = false; return queueMicrotask(() => done(new Error("STAGING_NOTIFICATION_FAILURE")));
        }
        return raw.query(sql, values, (e, rows, fields) => {
          if (!e && sql === "SELECT @@session.time_zone AS timezone") record.priorTimezone = rows[0].timezone;
          if (!e && sql === "SET time_zone = ?") record.restoredTimezone = values[0];
          done(e, rows, fields);
        });
      };
      if (name === "beginTransaction") return done => raw.beginTransaction(error => {
        if (error) return done(error);
        record.events.push("begin");
        const gate = controls.gate;
        if (gate) gate.arrive(raw.threadId).then(() => done(), done); else done();
      });
      if (name === "commit") return done => {
        const lost = controls.loseCommitAck; controls.loseCommitAck = false;
        record.events.push("commit-sent");
        raw.commit(error => {
          if (!error && lost) { record.events.push("commit-ack-lost"); return done(new Error("STAGING_LOST_COMMIT_ACK")); }
          if (!error) record.events.push("commit-ack"); done(error);
        });
      };
      if (name === "rollback") return done => raw.rollback(error => { if (!error) record.events.push("rollback-ack"); done(error); });
      if (name === "release" || name === "destroy") return () => {
        active.delete(raw); record[name === "release" ? "released" : "destroyed"]++; return raw[name]();
      };
      const value = Reflect.get(target, name); return typeof value === "function" ? value.bind(target) : value;
    } });
    callback(null, connection);
  });
  return { pool: wrapped, controls, leases, destroyActive() { for (const c of active) c.destroy(); active.clear(); } };
}

async function createStaging() {
  const target = validateTarget(process.env); // BEFORE driver import, connection or any other external effect.
  for (const file of ["config/db.js", "config/dbPromise.js", "services/webSessionService.js", "middleware/webSessionAuth.js", "routes/appointmentRoutes.js", "controllers/notificationController.js"])
    assert.ok(!require.cache[path.join(ROOT, file)], "Staging requires a fresh process without previously loaded production database consumers");
  fixtureStatements();
  const mysql = require("mysql2"), express = require("express");
  const options = { host: target.host, port: target.port, database: target.database, connectionLimit: 4, waitForConnections: true,
    connectTimeout: 3000, multipleStatements: false, enableKeepAlive: true };
  const raw = mysql.createPool({ ...options, user: target.user, password: target.password });
  const observerPool = mysql.createPool({ ...options, connectionLimit: 1, user: target.observerUser, password: target.observerPassword, dateStrings: true });
  const observer = observerPool.promise(), instrumentation = instrumentPool(raw), db = instrumentation.pool;
  const oldFlag = process.env.APPOINTMENT_RESERVATIONS_ENABLED;
  const savedCache = new Map(Object.entries(require.cache)), emails = [], sessions = {};
  let server, closed = false, emailFailure = false;
  const query = (sql, params = []) => new Promise((resolve, reject) => raw.query(sql, params, (e, rows) => e ? reject(e) : resolve(rows)));
  async function inspect(sql, params = []) { const [rows] = await observer.execute(sql, params); return rows; }
  async function close() {
    if (closed) return; closed = true;
    instrumentation.controls.gate?.cancel(); instrumentation.destroyActive();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await Promise.all([new Promise(resolve => raw.end(resolve)), new Promise(resolve => observerPool.end(resolve))]);
    if (oldFlag === undefined) delete process.env.APPOINTMENT_RESERVATIONS_ENABLED; else process.env.APPOINTMENT_RESERVATIONS_ENABLED = oldFlag;
    for (const [key, value] of Object.entries(require.cache)) if (key.startsWith(ROOT + path.sep) && !savedCache.has(key)) delete require.cache[key];
    for (const [key, value] of savedCache) if (key.startsWith(ROOT + path.sep)) require.cache[key] = value;
  }
  function loadRouters() {
    const original = Module._load, dbPath = path.join(ROOT, "config/db.js"), promisePath = path.join(ROOT, "config/dbPromise.js");
    Module._load = function(name, parent, main) {
      if (name === "dotenv" || name.startsWith("dotenv/")) throw new Error("STAGING_DOTENV_FORBIDDEN");
      if (name === "resend") return { Resend: class { constructor() { this.emails = { send: async message => {
        const appointments = await inspect("SELECT id, DATE_FORMAT(preferred_date, '%Y-%m-%d %H:%i:%s') AS schedule FROM appointments ORDER BY id");
        emails.push({ message, appointments }); if (emailFailure) throw new Error("STAGING_EMAIL_FAILURE"); return { data: { id: "staging-email" } };
      } }; } } };
      const file = Module._resolveFilename(name, parent);
      if (file === dbPath) return db;
      if (file === promisePath) return raw.promise();
      if (file === path.join(ROOT, "server/server.js")) throw new Error("STAGING_FULL_SERVER_FORBIDDEN");
      return original.call(this, name, parent, main);
    };
    try {
      const files = ["routes/appointmentRoutes.js", "routes/notificationRoutes.js", "routes/webUserRoutes.js"];
      for (const file of files) delete require.cache[path.join(ROOT, file)];
      return { appointments: require("../../routes/appointmentRoutes"), notifications: require("../../routes/notificationRoutes"),
        legacy: require("../../routes/webUserRoutes"), session: require("../../services/webSessionService") };
    } finally { Module._load = original; }
  }
  const ctx = { db, query, inspect, emails, sessions, controls: instrumentation.controls, leases: instrumentation.leases, close,
    setEmailFailure(value) { emailFailure = value; },
    async restartHttp() {
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      const routes = loadRouters(), app = express(); app.use(express.json());
      app.use("/api/appointments", routes.appointments); app.use("/api/notifications", routes.notifications); app.use("/api/web-users", routes.legacy);
      server = http.createServer(app); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      return routes.session;
    },
    request(method, url, { body, key, user, csrf = true, recovery = false } = {}) {
      assert.ok(server?.listening && !closed); assert.ok(url.startsWith("/api/"));
      const headers = { Accept: "application/json" }, session = sessions[user];
      if (user) { assert.ok(session); headers.Cookie = `wmo_admin_session=${session.sessionToken}; wmo_admin_csrf=${session.csrfToken}`;
        if (csrf) headers["X-CSRF-Token"] = session.csrfToken; }
      if (key) headers["Idempotency-Key"] = key;
      if (recovery) headers["Idempotency-Recovery"] = "true";
      const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
      if (bytes) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = bytes.length; }
      return new Promise((resolve, reject) => {
        const request = http.request({ host: "127.0.0.1", port: server.address().port, path: url, method, headers, agent: false }, response => {
          const parts = []; let size = 0;
          response.on("error", reject); response.on("aborted", () => reject(new Error("STAGING_HTTP_ABORTED")));
          response.on("data", b => { size += b.length; if (size > 1048576) response.destroy(new Error("STAGING_HTTP_TOO_LARGE")); else parts.push(b); });
          response.on("end", () => { try { assert.equal(response.complete, true); resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(parts).toString("utf8")) }); } catch (e) { reject(e); } });
        });
        request.setTimeout(12000, () => request.destroy(new Error("STAGING_HTTP_TIMEOUT"))); request.on("error", reject); request.end(bytes);
      });
    },
    async snapshot() {
      const result = {};
      for (const [name, table] of [["appointments", "appointments"], ["reservations", "appointment_reservations"], ["requests", "appointment_booking_requests"], ["notifications", "notifications"]])
        result[name] = await inspect(`SELECT * FROM ${table} ORDER BY ${name === "reservations" ? "appointment_id" : name === "requests" ? "request_hash" : "id"}`);
      return result;
    },
    async expected(id) {
      const [row] = await inspect("SELECT status, DATE_FORMAT(preferred_date, '%Y-%m-%d %H:%i:%s') AS schedule, appointment_revision FROM appointments WHERE id = ?", [id]);
      assert.ok(row); return { expected_status: String(row.status || "pending").trim().toLowerCase() || "pending", expected_schedule: row.schedule, expected_revision: Number(row.appointment_revision) };
    }
  };
  try {
    for (const connection of [raw.promise(), observer]) {
      const [rows] = await connection.query("SELECT DATABASE() AS db, VERSION() AS version, @@session.time_zone AS timezone");
      assert.equal(rows[0].db, target.database); assert.match(rows[0].version, /^9\.7\.2(?:[-.]|$)/);
    }
    const tables = await inspect("SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", [target.database]);
    assert.deepEqual(tables.map(r => r.TABLE_NAME).sort(), [...TABLES].sort()); assert.ok(tables.every(r => r.ENGINE === "InnoDB"));
    for (const table of TABLES.filter(t => t !== "appointment_feature_state")) {
      const [row] = await inspect(`SELECT COUNT(*) AS n FROM ${table}`); assert.equal(Number(row.n), 0, "Fresh staging fixture must be empty");
    }
    const marker = await inspect("SELECT * FROM appointment_feature_state");
    assert.equal(marker.length, 1); assert.equal(marker[0].feature_key, "service_slots");
    assert.equal(Number(marker[0].schema_version), 1); assert.equal(Number(marker[0].backfill_complete), 0);
    // Only this disposable empty fixture is attested. No production backfill claim.
    await query("UPDATE appointment_feature_state SET backfill_complete = 1 WHERE feature_key = 'service_slots'");
    process.env.APPOINTMENT_RESERVATIONS_ENABLED = "true";
    const sessionService = await ctx.restartHttp();
    for (const [role, name] of [["super_admin", "Staging Admin"], ["clerk_admin", "Staging Clerk"], ["personnel", "Staging Personnel"]]) {
      const row = await query("INSERT INTO web_users (full_name, username, password, role, status) VALUES (?, ?, 'NO_LOGIN_PASSWORD', ?, 'active')", [name, role, role]);
      sessions[role] = await sessionService.createSession(row.insertId);
    }
    return ctx;
  } catch (e) { await close(); throw e; }
}

module.exports = { EXECUTE, validateTarget, fixtureStatements, barrier, instrumentPool, createStaging };
