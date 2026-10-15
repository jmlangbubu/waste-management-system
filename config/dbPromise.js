const mysql = require("mysql2/promise");
require("dotenv").config();

const { databasePolicy, guardDatabase } = require("./stagingSafety");
const { stagingTlsOptions } = require("./stagingDatabaseTls");
const policy = databasePolicy();
const pool = guardDatabase(mysql.createPool({
  uri: policy.uri,
  ...stagingTlsOptions(policy),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true
}), policy, true);

console.log(" MySQL promise pool configured");

module.exports = pool;
