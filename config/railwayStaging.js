"use strict";
// Reviewed staging-only identities. These are identifiers, never credentials.
const PROJECT_ID = "1819925f-e0cf-4aed-abdc-acac14417acb";
const ENVIRONMENT_ID = "7e15f5b1-2753-4938-a9ce-048f689ae9d7";
const MYSQL_SERVICE_ID = "f72af026-d49f-4833-b126-72de120962a5";
const PRIVATE_DATABASE_HOST = "mysql.railway.internal";
function invalid() {
  const error = new Error("Railway staging transport requires the reviewed isolated runtime and database configuration.");
  error.code = "STAGING_RAILWAY_CONFIGURATION_INVALID";
  return error;
}
function assertRailwayStaging(env = process.env) {
  if (env.WMO_DEPLOYMENT_MODE !== "staging" || env.STAGING_WASTE_SCAN_ONLY !== "true"
      || env.STAGING_DATABASE_ISOLATION_CONFIRMED !== "true" || env.STAGING_ALLOW_SCHEMA_CHANGES !== "false"
      || env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
      || env.RAILWAY_PROJECT_ID !== PROJECT_ID || env.RAILWAY_ENVIRONMENT_ID !== ENVIRONMENT_ID
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.RAILWAY_SERVICE_ID || "")
      || env.RAILWAY_SERVICE_ID === MYSQL_SERVICE_ID) throw invalid();
}
function privateDatabaseOptions(policy, env = process.env) {
  assertRailwayStaging(env);
  try {
    if (!policy.staging || policy.schemaChanges || !env.STAGING_DATABASE_URL
        || policy.uri !== env.STAGING_DATABASE_URL || env.STAGING_DATABASE_URL === env.DATABASE_URL) throw invalid();
    const url = new URL(policy.uri);
    if (url.protocol !== "mysql:" || url.hostname !== PRIVATE_DATABASE_HOST
        || (url.port && url.port !== "3306") || url.pathname !== "/railway"
        || decodeURIComponent(url.username) !== "wmo_staging_app" || !url.password
        || url.search || url.hash) throw invalid();
    // Explicit network-layer encryption mode, NOT certificate-verified MySQL TLS.
    // Never retry an external TLS failure through this mode.
    return { ssl: false };
  } catch (_) { throw invalid(); }
}
module.exports = { assertRailwayStaging, privateDatabaseOptions, PROJECT_ID, ENVIRONMENT_ID, PRIVATE_DATABASE_HOST };
