"use strict";
const { databasePolicy } = require("./stagingSafety");

// Opt-in only. A stray flag outside staging cannot reduce production startup.
function isWasteScanOnly(env = process.env) {
  if (env.WMO_DEPLOYMENT_MODE !== "staging") return false;
  const flag = env.STAGING_WASTE_SCAN_ONLY;
  if (flag !== undefined && flag !== "true" && flag !== "false")
    throw new Error("STAGING_WASTE_SCAN_ONLY must be true or false.");
  if (flag !== "true") return false;
  const policy = databasePolicy(env);
  if (policy.schemaChanges)
    throw new Error("Waste Scan staging requires automatic schema changes to remain disabled.");
  return true;
}

module.exports = { isWasteScanOnly };
