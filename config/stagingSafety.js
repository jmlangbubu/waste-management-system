"use strict";
// Shared by both MySQL pools, before any pool or connection is created.
function databasePolicy(env = process.env) {
  if (env.WMO_DEPLOYMENT_MODE && !["staging", "production", "development", "test"].includes(env.WMO_DEPLOYMENT_MODE))
    throw new Error("Invalid WMO_DEPLOYMENT_MODE.");
  const staging = env.WMO_DEPLOYMENT_MODE === "staging";
  if (!staging) return { uri: env.DATABASE_URL, schemaChanges: true, staging: false };
  if (!env.STAGING_DATABASE_URL || env.STAGING_DATABASE_ISOLATION_CONFIRMED !== "true"
      || env.STAGING_DATABASE_URL === env.DATABASE_URL)
    throw new Error("Staging requires a separate explicitly confirmed STAGING_DATABASE_URL; production fallback is forbidden.");
  let url;
  try { url = new URL(env.STAGING_DATABASE_URL); } catch (_) { throw new Error("Invalid staging database configuration."); }
  if (url.protocol !== "mysql:" || !url.hostname || !url.pathname || url.pathname === "/")
    throw new Error("Invalid staging database configuration.");
  if (env.DATABASE_URL) {
    let production;
    try { production = new URL(env.DATABASE_URL); } catch (_) { throw new Error("Cannot verify database isolation against DATABASE_URL."); }
    if (production.hostname.toLowerCase() === url.hostname.toLowerCase()
        && (production.port || "3306") === (url.port || "3306")
        && decodeURIComponent(production.pathname) === decodeURIComponent(url.pathname))
      throw new Error("Staging and production database identities must differ.");
  }
  if (env.STAGING_ALLOW_SCHEMA_CHANGES && !["true", "false"].includes(env.STAGING_ALLOW_SCHEMA_CHANGES))
    throw new Error("STAGING_ALLOW_SCHEMA_CHANGES must be true or false.");
  return { uri: env.STAGING_DATABASE_URL, schemaChanges: env.STAGING_ALLOW_SCHEMA_CHANGES === "true", staging: true };
}
function schemaQueryAllowed(query) {
  const sql = typeof query === "string" ? query : query?.sql;
  if (typeof sql !== "string" || /\/\*!/.test(sql)) return false;
  // Remove literals/comments before checking statement boundaries. Never allow procedures or dynamic SQL.
  const text = sql.replace(/'(?:''|\\.|[^'\\])*'|"(?:""|\\.|[^"\\])*"|`(?:``|[^`])*`/g, "''")
    .replace(/\/\*[\s\S]*?\*\/|--[^\r\n]*|#[^\r\n]*/g, " ").trim().replace(/;\s*$/, "");
  return !text.includes(";") && /^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|INSERT|UPDATE|DELETE|REPLACE|BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SET)\b/i.test(text);
}
function blocked() { const error = new Error("Automatic schema changes are disabled in staging."); error.code = "STAGING_SCHEMA_CHANGES_DISABLED"; return error; }
const guarded = new WeakSet();
const safeErrors = new WeakSet();
const safeEmitters = new WeakSet();
const SAFE_DATABASE_ERROR_CODES = new Set([
  "PROTOCOL_CONNECTION_LOST", "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE",
  "HANDSHAKE_SSL_ERROR", "HANDSHAKE_NO_SSL_SUPPORT",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ER_ACCESS_DENIED_ERROR", "ER_BAD_DB_ERROR", "ER_NO_SUCH_TABLE",
  "ER_BAD_FIELD_ERROR", "ER_DUP_ENTRY", "ER_DUP_FIELDNAME"
]);
function safeDatabaseError(error) {
  if (!error || safeErrors.has(error)) return error;
  const safe = new Error("Staging database operation failed.");
  safe.code = SAFE_DATABASE_ERROR_CODES.has(error.code) ? error.code : "STAGING_DATABASE_ERROR";
  if (error.fatal === true) safe.fatal = true;
  safeErrors.add(safe);
  return safe;
}
function safeEmitter(target) {
  if (!target || typeof target.emit !== "function" || safeEmitters.has(target)) return target;
  safeEmitters.add(target);
  const emit = target.emit;
  target.emit = function(event, ...args) {
    if (event === "error" && args[0]) args[0] = safeDatabaseError(args[0]);
    return emit.call(this, event, ...args);
  };
  return target;
}
function guardDatabase(target, policy, promise = false) {
  if (!policy.staging || guarded.has(target)) return target;
  guarded.add(target);
  safeEmitter(target);
  for (const method of ["query", "execute"]) {
    if (typeof target[method] !== "function") continue;
    const original = target[method].bind(target);
    target[method] = (...args) => {
      if (!policy.schemaChanges && !schemaQueryAllowed(args[0])) {
        const error = blocked();
        if (promise) return Promise.reject(error);
        const callback = args.findLast(value => typeof value === "function");
        if (callback) { process.nextTick(() => callback(error)); return; }
        throw error;
      }
      if (promise) {
        try { return Promise.resolve(original(...args)).catch(error => { throw safeDatabaseError(error); }); }
        catch (error) { return Promise.reject(safeDatabaseError(error)); }
      }
      const index = args.findLastIndex(value => typeof value === "function");
      if (index !== -1) {
        const callback = args[index];
        args[index] = (error, ...values) => callback(safeDatabaseError(error), ...values);
      }
      try { return safeEmitter(original(...args)); }
      catch (error) { throw safeDatabaseError(error); }
    };
  }
  if (typeof target.getConnection === "function") {
    const original = target.getConnection.bind(target);
    target.getConnection = promise
      ? async (...args) => {
        try { return guardDatabase(await original(...args), policy, true); }
        catch (error) { throw safeDatabaseError(error); }
      }
      : callback => {
        try { return original((error, connection) => callback(safeDatabaseError(error), connection && guardDatabase(connection, policy, false))); }
        catch (error) { throw safeDatabaseError(error); }
      };
  }
  if (typeof target.promise === "function") {
    const original = target.promise.bind(target);
    target.promise = () => guardDatabase(original(), policy, true);
  }
  return target;
}
module.exports = { databasePolicy, schemaQueryAllowed, guardDatabase };
