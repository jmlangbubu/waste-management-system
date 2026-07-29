const mysql = require("mysql2");
require("dotenv").config();

const db = mysql.createPool({
  uri: process.env.DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  connectTimeout: 10000
});

const TRANSIENT_DATABASE_ERROR_CODES = new Set([
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE"
]);

function isTransientDatabaseError(error) {
  return Boolean(
    error &&
    TRANSIENT_DATABASE_ERROR_CODES.has(String(error.code || "").toUpperCase())
  );
}

function isReadOnlyQuery(sql) {
  return /^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i.test(
    String(sql || "").trim()
  );
}

function queryReadOnly(sql, values, callback) {
  let queryValues = values;
  let done = callback;

  if (typeof values === "function") {
    done = values;
    queryValues = [];
  }

  if (typeof done !== "function") {
    throw new TypeError("queryReadOnly requires a callback.");
  }

  if (!isReadOnlyQuery(sql)) {
    const error = new Error("queryReadOnly only accepts read-only SQL.");
    error.code = "DB_READ_ONLY_QUERY_REQUIRED";
    return process.nextTick(() => done(error));
  }

  const runQuery = (attempt) => {
    db.query(sql, queryValues || [], (error, results, fields) => {
      if (error && attempt === 0 && isTransientDatabaseError(error)) {
        console.warn(
          `[DB] Transient read error ${error.code}; retrying once in 400ms.`
        );
        return setTimeout(() => runQuery(1), 400);
      }

      return done(error, results, fields);
    });
  };

  return runQuery(0);
}

function healthCheck(callback) {
  return queryReadOnly("SELECT 1 AS ok", callback);
}

db.isTransientError = isTransientDatabaseError;
db.shouldReturnServiceUnavailable = isTransientDatabaseError;
db.isReadOnlyQuery = isReadOnlyQuery;
db.queryReadOnly = queryReadOnly;
db.healthCheck = healthCheck;

db.getConnection((err, connection) => {
  if (err) {
    console.error(
      "❌ MySQL pool connection failed:",
      err.code || "UNKNOWN_DB_ERROR",
      err.message
    );
    return;
  }

  console.log("✅ MySQL pool connected successfully");
  connection.release();
});

module.exports = db;
