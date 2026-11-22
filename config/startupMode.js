"use strict";
const { databasePolicy } = require("./stagingSafety");

// Staging always means the isolated scan API. Missing flags must never start WMO.
function isWasteScanOnly(env = process.env) {
  const policy = databasePolicy(env);
  return policy.staging;
}

module.exports = { isWasteScanOnly };
