const mysql = require("mysql2/promise");
require("dotenv").config();

const { databasePolicy, guardDatabase } = require("./stagingSafety");
const policy = databasePolicy();
const pool = guardDatabase(mysql.createPool({
  uri: policy.uri,
  ...(policy.staging ? { ...require("./railwayStaging").privateDatabaseOptions(policy), multipleStatements: false } : {}),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true
}), policy, true);

console.log(" MySQL promise pool configured");

module.exports = pool;
