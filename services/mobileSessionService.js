const crypto = require("crypto");
const db = require("../config/db");

const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LAST_SEEN_THROTTLE_MINUTES = 10;
const MAX_DEVICE_ID_LENGTH = 150;
const MAX_TOKEN_INSERT_ATTEMPTS = 2;

class MobileSessionError extends Error {
  constructor(message, statusCode, code, cause = null) {
    super(message);
    this.name = "MobileSessionError";
    this.statusCode = statusCode;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function generateOpaqueToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

function hashOpaqueToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

function isValidOpaqueToken(token) {
  return TOKEN_PATTERN.test(String(token || ""));
}

function normalizeAccountStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDeviceId(value) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, MAX_DEVICE_ID_LENGTH) : null;
}

function toMysqlUtc(date) {
  return date.toISOString().slice(0, 23).replace("T", " ");
}

function query(database, sql, parameters = []) {
  return new Promise((resolve, reject) => {
    database.query(sql, parameters, (error, results) => {
      if (error) reject(error);
      else resolve(results);
    });
  });
}

function invalidSessionError() {
  return new MobileSessionError(
    "Mobile authentication is required.",
    401,
    "MOBILE_SESSION_INVALID"
  );
}

function toStoreUnavailableError(error) {
  if (error instanceof MobileSessionError) return error;
  return new MobileSessionError(
    "Mobile authentication is temporarily unavailable.",
    503,
    "MOBILE_SESSION_STORE_UNAVAILABLE",
    error
  );
}

class MobileSessionService {
  constructor(database = db, options = {}) {
    this.db = database;
    this.now = typeof options.now === "function" ? options.now : () => new Date();
    this.tokenFactory =
      typeof options.tokenFactory === "function"
        ? options.tokenFactory
        : generateOpaqueToken;
    this.ttlSeconds = Number.isInteger(options.ttlSeconds)
      ? options.ttlSeconds
      : DEFAULT_SESSION_TTL_SECONDS;
  }

  async createMobileSession(userId, deviceId = null) {
    const normalizedUserId = Number(userId);
    if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) {
      throw new MobileSessionError(
        "A valid mobile account is required.",
        400,
        "MOBILE_SESSION_USER_REQUIRED"
      );
    }

    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1000);

    for (let attempt = 0; attempt < MAX_TOKEN_INSERT_ATTEMPTS; attempt += 1) {
      const token = this.tokenFactory();
      if (!isValidOpaqueToken(token)) {
        throw new MobileSessionError(
          "Secure mobile session generation failed.",
          500,
          "MOBILE_SESSION_GENERATION_FAILED"
        );
      }

      try {
        const result = await query(
          this.db,
          `
            INSERT INTO mobile_user_sessions (
              session_token_hash,
              user_id,
              device_id,
              created_at,
              last_seen_at,
              expires_at,
              revoked_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL)
          `,
          [
            hashOpaqueToken(token),
            normalizedUserId,
            normalizeDeviceId(deviceId),
            toMysqlUtc(now),
            toMysqlUtc(now),
            toMysqlUtc(expiresAt)
          ]
        );

        return {
          id: result.insertId,
          token,
          expiresAt
        };
      } catch (error) {
        if (
          error?.code === "ER_DUP_ENTRY" &&
          attempt + 1 < MAX_TOKEN_INSERT_ATTEMPTS
        ) {
          continue;
        }
        throw toStoreUnavailableError(error);
      }
    }

    throw new MobileSessionError(
      "Secure mobile session generation failed.",
      500,
      "MOBILE_SESSION_GENERATION_FAILED"
    );
  }

  async authenticateMobileSession(rawToken) {
    if (!isValidOpaqueToken(rawToken)) {
      throw invalidSessionError();
    }

    try {
      const rows = await query(
        this.db,
        `
          SELECT
            s.id AS session_id,
            s.device_id,
            s.expires_at,
            s.last_seen_at,
            CASE
              WHEN s.last_seen_at <= DATE_SUB(
                UTC_TIMESTAMP(3),
                INTERVAL ${LAST_SEEN_THROTTLE_MINUTES} MINUTE
              ) THEN 1
              ELSE 0
            END AS should_refresh_last_seen,
            u.id AS user_id,
            u.full_name,
            u.username,
            u.role,
            u.mobile_role,
            u.status
          FROM mobile_user_sessions s
          INNER JOIN users u
            ON u.id = s.user_id
          WHERE s.session_token_hash = ?
            AND s.revoked_at IS NULL
            AND s.expires_at > UTC_TIMESTAMP(3)
          LIMIT 1
        `,
        [hashOpaqueToken(rawToken)]
      );

      if (!rows.length) {
        throw invalidSessionError();
      }

      const row = rows[0];
      const status = normalizeAccountStatus(row.status);
      if (status !== "active") {
        throw new MobileSessionError(
          "This mobile account is inactive.",
          403,
          "MOBILE_SESSION_ACCOUNT_INACTIVE"
        );
      }

      if (Number(row.should_refresh_last_seen) === 1) {
        await query(
          this.db,
          `
            UPDATE mobile_user_sessions
            SET last_seen_at = UTC_TIMESTAMP(3)
            WHERE id = ?
              AND revoked_at IS NULL
              AND expires_at > UTC_TIMESTAMP(3)
              AND last_seen_at <= DATE_SUB(
                UTC_TIMESTAMP(3),
                INTERVAL ${LAST_SEEN_THROTTLE_MINUTES} MINUTE
              )
          `,
          [row.session_id]
        );
      }

      const role = String(row.role || row.mobile_role || "").trim();
      const mobileRole = String(row.mobile_role || row.role || "").trim();

      return {
        id: row.session_id,
        deviceId: row.device_id || null,
        expiresAt: row.expires_at,
        user: {
          id: row.user_id,
          full_name: row.full_name,
          username: row.username,
          role,
          mobile_role: mobileRole,
          status
        }
      };
    } catch (error) {
      throw toStoreUnavailableError(error);
    }
  }

  async revokeMobileSession(rawToken) {
    if (!isValidOpaqueToken(rawToken)) return false;

    try {
      const result = await query(
        this.db,
        `
          UPDATE mobile_user_sessions
          SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP(3))
          WHERE session_token_hash = ?
            AND revoked_at IS NULL
        `,
        [hashOpaqueToken(rawToken)]
      );
      return Number(result.affectedRows || 0) > 0;
    } catch (error) {
      throw toStoreUnavailableError(error);
    }
  }
}

const mobileSessionService = new MobileSessionService();

module.exports = mobileSessionService;
module.exports.MobileSessionService = MobileSessionService;
module.exports.MobileSessionError = MobileSessionError;
module.exports.DEFAULT_SESSION_TTL_SECONDS = DEFAULT_SESSION_TTL_SECONDS;
module.exports.LAST_SEEN_THROTTLE_MINUTES = LAST_SEEN_THROTTLE_MINUTES;
module.exports.TOKEN_BYTES = TOKEN_BYTES;
module.exports.generateOpaqueToken = generateOpaqueToken;
module.exports.hashOpaqueToken = hashOpaqueToken;
module.exports.isValidOpaqueToken = isValidOpaqueToken;
module.exports.normalizeDeviceId = normalizeDeviceId;
