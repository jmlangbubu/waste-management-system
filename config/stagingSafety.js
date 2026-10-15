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
function guardDatabase(target, policy, promise = false) {
  if (!policy.staging || policy.schemaChanges || guarded.has(target)) return target;
  guarded.add(target);
  for (const method of ["query", "execute"]) {
    if (typeof target[method] !== "function") continue;
    const original = target[method].bind(target);
    target[method] = (...args) => {
      if (schemaQueryAllowed(args[0])) return original(...args);
      const error = blocked();
      if (promise) return Promise.reject(error);
      const callback = args.findLast(value => typeof value === "function");
      if (callback) { process.nextTick(() => callback(error)); return; }
      throw error;
    };
  }
  if (typeof target.getConnection === "function") {
    const original = target.getConnection.bind(target);
    target.getConnection = promise
      ? async (...args) => guardDatabase(await original(...args), policy, true)
      : callback => original((error, connection) => callback(error, connection && guardDatabase(connection, policy, false)));
  }
  if (typeof target.promise === "function") {
    const original = target.promise.bind(target);
    target.promise = () => guardDatabase(original(), policy, true);
  }
  return target;
}
module.exports = { databasePolicy, schemaQueryAllowed, guardDatabase };
