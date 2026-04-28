const mysql = require("mysql2");
require("dotenv").config();

const db = mysql.createPool({
  uri: process.env.DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

db.getConnection((err, connection) => {
  if (err) {
    console.error("❌ MySQL pool connection failed:", err);
    return;
  }

  console.log("✅ MySQL pool connected successfully");
  connection.release();
});

module.exports = db;
