const mysql = require("mysql2/promise");
require("dotenv").config();

const pool = mysql.createPool({
  uri: process.env.DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true
});

console.log(" MySQL promise pool configured");

module.exports = pool;
