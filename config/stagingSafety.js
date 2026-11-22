"use strict";
// Shared by both MySQL pools, before any pool or connection is created.
function databasePolicy(env = process.env) {
  // A missing mode in the reviewed staging environment must never start the full
  // app or pick up DATABASE_URL. Other environments retain the legacy behavior.
  if (env.RAILWAY_ENVIRONMENT_ID === require("./railwayStaging").ENVIRONMENT_ID
      && env.WMO_DEPLOYMENT_MODE !== "staging")
    throw new Error("The isolated Railway environment requires staging deployment mode.");
  if (env.WMO_DEPLOYMENT_MODE && !["staging", "production", "development", "test"].includes(env.WMO_DEPLOYMENT_MODE))
    throw new Error("Invalid WMO_DEPLOYMENT_MODE.");
  const staging = env.WMO_DEPLOYMENT_MODE === "staging";
  if (!staging) return { uri: env.DATABASE_URL, schemaChanges: true, staging: false };
  if (!env.STAGING_DATABASE_URL || env.STAGING_DATABASE_ISOLATION_CONFIRMED !== "true"
      || env.DATABASE_URL !== undefined)
    throw new Error("Staging requires a separate explicitly confirmed STAGING_DATABASE_URL; production fallback is forbidden.");
  let url;
  try { url = new URL(env.STAGING_DATABASE_URL); } catch (_) { throw new Error("Invalid staging database configuration."); }
  if (url.protocol !== "mysql:" || !url.hostname || !url.pathname || url.pathname === "/")
    throw new Error("Invalid staging database configuration.");
  const policy = { uri: env.STAGING_DATABASE_URL, schemaChanges: false, staging: true };
  require("./railwayStaging").privateDatabaseOptions(policy, env);
  return policy;
}
function schemaQueryAllowed(query) {
  const sql = typeof query === "string" ? query : query?.sql;
  if (typeof sql !== "string") return false;
  let executableComment = false;
  // Tokenize literals and comments together: quotes inside comments cannot hide
  // executable SQL, and SQL-looking literal contents remain inert placeholders.
  const text = sql.replace(/'(?:''|\\.|[^'\\])*'|"(?:""|\\.|[^"\\])*"|`(?:``|\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|--(?=[\x00-\x20]|$)[^\r\n]*|#[^\r\n]*/g, token => {
    if (/^\/\*[!+]/.test(token)) executableComment = true;
    return /^["'`]/.test(token) ? "''" : " ";
  }).trim().replace(/;\s*$/, "");
  if (executableComment || /\bINTO\s+(?:OUTFILE|DUMPFILE)\b|\bLOAD_FILE\s*\(/i.test(text)) return false;
  // No dynamic SQL, stored procedures, administrative commands or session SQL-mode
  // changes (which could alter literal/comment parsing). mysql2 also disables
  // multi-statements. The restricted DB account is a separate enforcement layer.
  return !text.includes(";") && /^(SELECT|SHOW|DESCRIBE|DESC|INSERT|UPDATE|DELETE|BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\b/i.test(text);
}
function blocked() { const error = new Error("Automatic schema changes are disabled in staging."); error.code = "STAGING_SCHEMA_CHANGES_DISABLED"; return error; }
const guarded = new WeakSet();
const safeErrors = new WeakSet();
const safeEmitters = new WeakSet();
function safeDatabaseError(error) {
  if (!error || safeErrors.has(error)) return error;
  const safe = new Error("Staging database operation failed.");
  // Preserve real MySQL error codes for existing error handling, without carrying
  // the driver's SQL, credential-bearing message, parameters or nested cause.
  safe.code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code || "") ? error.code : "STAGING_DATABASE_ERROR";
  if (Number.isSafeInteger(error.errno)) safe.errno = error.errno;
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
