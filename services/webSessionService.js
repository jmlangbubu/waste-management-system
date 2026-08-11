const crypto = require("crypto");
const db = require("../config/db");

const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MIN_SESSION_TTL_SECONDS = 5 * 60;
const MAX_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

class WebSessionError extends Error {
  constructor(message, statusCode, code, cause = null) {
    super(message);
    this.name = "WebSessionError";
    this.statusCode = statusCode;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function normalizeWebRole(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function normalizeAccountStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveSessionTtlSeconds(value) {
  const parsed = Number(value);
  if (
    Number.isInteger(parsed) &&
    parsed >= MIN_SESSION_TTL_SECONDS &&
    parsed <= MAX_SESSION_TTL_SECONDS
  ) {
    return parsed;
  }
  return DEFAULT_SESSION_TTL_SECONDS;
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

function toStoreUnavailableError(error) {
  if (error instanceof WebSessionError) return error;
  return new WebSessionError(
    "Web Admin session service is temporarily unavailable.",
    503,
    "WEB_SESSION_STORE_UNAVAILABLE",
    error
  );
}

class WebSessionService {
  constructor(database = db, options = {}) {
    this.db = database;
    this.now = typeof options.now === "function" ? options.now : () => new Date();
    this.ttlSeconds = resolveSessionTtlSeconds(
      options.ttlSeconds ?? process.env.WEB_ADMIN_SESSION_TTL_SECONDS
    );
  }

  async createSession(userId) {
    const normalizedUserId = String(userId ?? "").trim();
    if (!normalizedUserId) {
      throw new WebSessionError(
        "A valid Web Admin account is required.",
        400,
        "WEB_SESSION_USER_REQUIRED"
      );
    }

    const sessionToken = generateOpaqueToken();
    const csrfToken = generateOpaqueToken();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1000);

    try {
      const result = await query(
        this.db,
        `
          INSERT INTO web_admin_sessions (
            session_token_hash,
            user_id,
            csrf_token_hash,
            created_at,
            last_seen_at,
            expires_at,
            revoked_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL)
        `,
        [
          hashOpaqueToken(sessionToken),
          normalizedUserId,
          hashOpaqueToken(csrfToken),
          toMysqlUtc(now),
          toMysqlUtc(now),
          toMysqlUtc(expiresAt)
        ]
      );

      return {
        id: result.insertId,
        sessionToken,
        csrfToken,
        expiresAt,
        ttlSeconds: this.ttlSeconds
      };
    } catch (error) {
      throw toStoreUnavailableError(error);
    }
  }

  async rotateSession(userId, previousSessionToken) {
    if (isValidOpaqueToken(previousSessionToken)) {
      await this.revokeSession(previousSessionToken);
    }
    return this.createSession(userId);
  }

  async validateSession(sessionToken) {
    if (!isValidOpaqueToken(sessionToken)) {
      throw new WebSessionError(
        "Web Admin authentication is required.",
        401,
        "WEB_SESSION_INVALID"
      );
    }

    try {
      const rows = await query(
        this.db,
        `
          SELECT
            s.id AS session_id,
            s.csrf_token_hash,
            s.expires_at,
            u.id AS user_id,
            u.full_name,
            u.username,
            u.role,
            u.division_name,
            u.status
          FROM web_admin_sessions s
          INNER JOIN web_users u
            ON u.id = s.user_id
          WHERE s.session_token_hash = ?
            AND s.revoked_at IS NULL
            AND s.expires_at > UTC_TIMESTAMP(3)
          LIMIT 1
        `,
        [hashOpaqueToken(sessionToken)]
      );

      if (!rows.length) {
        throw new WebSessionError(
          "Web Admin authentication is required.",
          401,
          "WEB_SESSION_INVALID"
        );
      }

      const row = rows[0];
      if (normalizeAccountStatus(row.status) !== "active") {
        throw new WebSessionError(
          "This Web Admin account is inactive.",
          403,
          "WEB_SESSION_ACCOUNT_INACTIVE"
        );
      }

      await query(
        this.db,
        `
          UPDATE web_admin_sessions
          SET last_seen_at = UTC_TIMESTAMP(3)
          WHERE id = ?
            AND revoked_at IS NULL
            AND expires_at > UTC_TIMESTAMP(3)
        `,
        [row.session_id]
      );

      return {
        id: row.session_id,
        csrfTokenHash: row.csrf_token_hash,
        expiresAt: row.expires_at,
        divisionName: row.division_name || null,
        user: {
          id: row.user_id,
          full_name: row.full_name,
          username: row.username,
          role: normalizeWebRole(row.role),
          status: normalizeAccountStatus(row.status)
        }
      };
    } catch (error) {
      throw toStoreUnavailableError(error);
    }
  }

  async revokeSession(sessionToken) {
    if (!isValidOpaqueToken(sessionToken)) return false;

    try {
      const result = await query(
        this.db,
        `
          UPDATE web_admin_sessions
          SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP(3))
          WHERE session_token_hash = ?
            AND revoked_at IS NULL
        `,
        [hashOpaqueToken(sessionToken)]
      );
      return Number(result.affectedRows || 0) > 0;
    } catch (error) {
      throw toStoreUnavailableError(error);
    }
  }

  async revokeUserSessions(userId) {
    const normalizedUserId = String(userId ?? "").trim();
    if (!normalizedUserId) return 0;

    try {
      const result = await query(
        this.db,
        `
          UPDATE web_admin_sessions
          SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP(3))
          WHERE user_id = ?
            AND revoked_at IS NULL
        `,
        [normalizedUserId]
      );
      return Number(result.affectedRows || 0);
    } catch (error) {
      throw toStoreUnavailableError(error);
    }
  }

  async cleanupExpiredSessions() {
    try {
      const result = await query(
        this.db,
        `
          UPDATE web_admin_sessions
          SET revoked_at = UTC_TIMESTAMP(3)
          WHERE revoked_at IS NULL
            AND expires_at <= UTC_TIMESTAMP(3)
        `
      );
      return Number(result.affectedRows || 0);
    } catch (error) {
      throw toStoreUnavailableError(error);
    }
  }
}

const webSessionService = new WebSessionService();

module.exports = webSessionService;
module.exports.WebSessionService = WebSessionService;
module.exports.WebSessionError = WebSessionError;
module.exports.DEFAULT_SESSION_TTL_SECONDS = DEFAULT_SESSION_TTL_SECONDS;
module.exports.generateOpaqueToken = generateOpaqueToken;
module.exports.hashOpaqueToken = hashOpaqueToken;
module.exports.isValidOpaqueToken = isValidOpaqueToken;
module.exports.normalizeWebRole = normalizeWebRole;
module.exports.resolveSessionTtlSeconds = resolveSessionTtlSeconds;
