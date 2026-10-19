"use strict";

// WMO citizen password recovery. All SQL uses the existing callback-style mysql2 pool.
// No schema changes or external connections are made when this module is imported.
const crypto = require("crypto");

const PUBLIC_MESSAGE = "If an eligible account uses this email, a recovery code will be sent shortly.";
const INVALID_CODE = "Invalid or expired code. Request a new code and try again.";
const INVALID_TOKEN = "The reset session has expired. Request a new code.";
const CODE_PATTERN = /^\d{6}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_MINUTES = 10;
const TICKET_MINUTES = 5;
const MAX_ATTEMPTS = 5;

function normalizeEmail(value) { return typeof value === "string" ? value.trim().toLowerCase() : ""; }
function isValidEmail(email) { return email.length <= 254 && EMAIL_PATTERN.test(email); }
function isCitizen(user) {
  return String(user?.role || user?.mobile_role || "").trim().toLowerCase() === "citizen" &&
    String(user?.status || "active").trim().toLowerCase() === "active" &&
    Number(user?.email_verified || 0) === 1;
}
function query(connection, sql, params = []) {
  return new Promise((resolve, reject) => connection.query(sql, params, (error, result) => error ? reject(error) : resolve(result)));
}
function connectionFrom(pool) {
  return new Promise((resolve, reject) => pool.getConnection((error, connection) => error ? reject(error) : resolve(connection)));
}
function method(connection, name) {
  return new Promise((resolve, reject) => connection[name]((error) => error ? reject(error) : resolve()));
}
async function withTransaction(pool, work) {
  const connection = await connectionFrom(pool);
  let began = false;
  try {
    await method(connection, "beginTransaction");
    began = true;
    const result = await work(connection);
    await method(connection, "commit");
    began = false;
    return result;
  } catch (error) {
    if (began) {
      try { await method(connection, "rollback"); }
      catch (rollbackError) { console.error("[PasswordReset] Transaction rollback failed:", rollbackError.code || "UNKNOWN"); }
    }
    throw error;
  } finally {
    connection.release();
  }
}
function hashSha256(value) { return crypto.createHash("sha256").update(value, "utf8").digest("hex"); }
function hashHmac(secret, value) { return crypto.createHmac("sha256", secret).update(value, "utf8").digest("hex"); }
function constantTimeHexMatch(a, b) {
  if (typeof a !== "string" || !/^[0-9a-f]{64}$/i.test(a)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
function secretFromEnv() {
  const secret = process.env.PASSWORD_RESET_HMAC_SECRET || "";
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("PASSWORD_RESET_HMAC_SECRET_MISSING");
  return secret;
}
// Bind each challenge to the exact verified email, not only the account ID.
// This prevents old email inbox access from resetting an account after its email changes.
function emailBindingHash(userId, email) {
  return hashHmac(secretFromEnv(), `recipient-email:${userId}:${normalizeEmail(email)}`);
}
function encryptionKeyFromEnv() {
  const raw = process.env.PASSWORD_RESET_OUTBOX_KEY || "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(raw)) throw new Error("PASSWORD_RESET_OUTBOX_KEY_MISSING");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64") !== raw) throw new Error("PASSWORD_RESET_OUTBOX_KEY_INVALID");
  return key;
}
function encryptPayload(payload, challengeId, key) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`wmo-reset:${challengeId}:v1`, "utf8"));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return `v1:${nonce.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}
function decryptPayload(encrypted, challengeId, key) {
  const parts = String(encrypted || "").split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("RESET_OUTBOX_PAYLOAD_FORMAT");
  const nonce = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  if (nonce.length !== 12 || tag.length !== 16) throw new Error("RESET_OUTBOX_PAYLOAD_FORMAT");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(`wmo-reset:${challengeId}:v1`, "utf8"));
  decipher.setAuthTag(tag);
  const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[3], "base64")), decipher.final()]).toString("utf8"));
  if (!isValidEmail(value.email) || !CODE_PATTERN.test(value.code)) throw new Error("RESET_OUTBOX_PAYLOAD_INVALID");
  return value;
}

function createPasswordResetRecoveryService({ db, bcrypt, logger = console, now = () => Date.now(), delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!db || !bcrypt) throw new Error("PasswordResetRecoveryService missing database/bcrypt");
  const secret = () => secretFromEnv();
  const encryptionKey = () => encryptionKeyFromEnv();
  const hmac = value => hashHmac(secret(), value);
  const getIp = req => String(req.ip || req.socket?.remoteAddress || "unknown").slice(0, 180);

  async function rateLimit(kind, value, maximum) {
    const hash = hmac(`limit:${kind}:${value}`);
    // Single-row atomic counter; assignment order is deliberate for MySQL.
    await query(db, `/* reset:limit-incr */
      INSERT INTO password_reset_rate_limits (key_hash, window_start, request_count, updated_at)
      VALUES (?, UTC_TIMESTAMP(3), 1, UTC_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE
        request_count = IF(window_start < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 HOUR), 1, request_count + 1),
        window_start = IF(window_start < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 HOUR), UTC_TIMESTAMP(3), window_start),
        updated_at = UTC_TIMESTAMP(3)
    `, [hash]);
    const rows = await query(db, "/* reset:limit-get */ SELECT request_count FROM password_reset_rate_limits WHERE key_hash = ?", [hash]);
    return Number(rows[0]?.request_count || 999999) <= maximum;
  }

  async function findEligibleUser(email) {
    const rows = await query(db, `/* reset:user-email */ SELECT id, email, role, mobile_role, status, email_verified
      FROM users WHERE LOWER(TRIM(email)) = ? LIMIT 2`, [email]);
    return rows.length === 1 && isCitizen(rows[0]) ? rows[0] : null;
  }

  // Bounded minimum plus randomized response time mitigates—but cannot prove absence
  // of—account enumeration via network timing. No external provider call is awaited.
  async function publicTiming(start) {
    const targetMs = 300 + crypto.randomInt(0, 151);
    const remaining = targetMs - (now() - start);
    if (remaining > 0) await delay(remaining);
  }

  async function requestCode(email, ip) {
    secret(); encryptionKey();
    const allowedIp = await rateLimit("request-ip", ip, 30);
    const allowedEmail = await rateLimit("request-email", email, 3);
    if (!allowedIp || !allowedEmail) return;
    const initialUser = await findEligibleUser(email);
    if (!initialUser) return;

    await withTransaction(db, async (connection) => {
      // Shared lock order for issuing, verifying, resetting, and worker finalization:
      // USERS -> CHALLENGES -> OUTBOX. Serializes simultaneous OTP issuance per user.
      const users = await query(connection, `/* reset:user-lock */ SELECT id, email, role, mobile_role, status, email_verified
        FROM users WHERE id = ? FOR UPDATE`, [initialUser.id]);
      if (users.length !== 1 || !isCitizen(users[0]) || normalizeEmail(users[0].email) !== email) return;
      const current = await query(connection, `/* reset:active-challenge */ SELECT id, delivery_status FROM password_reset_challenges
        WHERE user_id = ? AND consumed_at IS NULL
          AND ((delivery_status = 'queued' AND created_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE))
            OR (delivery_status = 'sent' AND expires_at > UTC_TIMESTAMP(3)))
        ORDER BY id DESC LIMIT 1 FOR UPDATE`, [initialUser.id]);
      // Never invalidate an actively queued/sent code just because user tapped again.
      // Retrying from the same request is thus safe; request fresh code after expiry.
      if (current.length) return;
      await query(connection, `/* reset:old-consume */ UPDATE password_reset_challenges
        SET consumed_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND consumed_at IS NULL`, [initialUser.id]);
      await query(connection, `/* reset:old-outbox-cancel */ UPDATE password_reset_outbox o
        INNER JOIN password_reset_challenges c ON c.id = o.challenge_id
        SET o.state = 'cancelled', o.payload_encrypted = NULL, o.lease_token_hash = NULL, o.leased_until = NULL
        WHERE c.user_id = ? AND o.state IN ('pending','leased')`, [initialUser.id]);

      const code = String(crypto.randomInt(100000, 1000000));
      const inserted = await query(connection, `/* reset:challenge-insert */ INSERT INTO password_reset_challenges
        (user_id, recipient_email_hash, code_hash, expires_at, delivery_status)
        VALUES (?, ?, ?, NULL, 'queued')`, [initialUser.id, emailBindingHash(initialUser.id, users[0].email), hmac(`otp:${initialUser.id}:${code}`)]);
      const ciphertext = encryptPayload({ email: users[0].email, code }, inserted.insertId, encryptionKey());
      await query(connection, `/* reset:outbox-insert */ INSERT INTO password_reset_outbox
        (challenge_id, payload_encrypted, state, available_at)
        VALUES (?, ?, 'pending', UTC_TIMESTAMP(3))`, [inserted.insertId, ciphertext]);
    });
  }

  async function verifyCode(email, code, ip) {
    secret();
    if (!await rateLimit("verify-ip", ip, 60)) return { status: 429, body: { success: false, message: "Too many attempts. Please try again later." } };
    // Additional per-email bucket prevents distributed IP guessing.
    if (!await rateLimit("verify-email", email, 15)) return { status: 400, body: { success: false, message: INVALID_CODE } };
    const user = await findEligibleUser(email);
    if (!user) return { status: 400, body: { success: false, message: INVALID_CODE } };
    return withTransaction(db, async (connection) => {
      const users = await query(connection, `/* reset:user-lock */ SELECT id, email, role, mobile_role, status, email_verified
        FROM users WHERE id = ? FOR UPDATE`, [user.id]);
      if (users.length !== 1 || !isCitizen(users[0]) || normalizeEmail(users[0].email) !== email) {
        return { status: 400, body: { success: false, message: INVALID_CODE } };
      }
      const challenges = await query(connection, `/* reset:verify-latest */ SELECT id, code_hash, recipient_email_hash, attempts FROM password_reset_challenges
        WHERE user_id = ? AND consumed_at IS NULL AND delivery_status = 'sent'
          AND verified_token_hash IS NULL AND expires_at > UTC_TIMESTAMP(3)
        ORDER BY id DESC LIMIT 1 FOR UPDATE`, [user.id]);
      const entry = challenges[0];
      if (!entry || Number(entry.attempts) >= MAX_ATTEMPTS ||
        !constantTimeHexMatch(entry.recipient_email_hash, emailBindingHash(user.id, email))) {
        return { status: 400, body: { success: false, message: INVALID_CODE } };
      }
      await query(connection, "/* reset:verify-attempt */ UPDATE password_reset_challenges SET attempts = attempts + 1 WHERE id = ?", [entry.id]);
      if (!constantTimeHexMatch(entry.code_hash, hmac(`otp:${user.id}:${code}`))) {
        return { status: 400, body: { success: false, message: INVALID_CODE } };
      }
      const token = crypto.randomBytes(32).toString("base64url");
      await query(connection, `/* reset:verify-token */ UPDATE password_reset_challenges
        SET verified_token_hash = ?, verified_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${TICKET_MINUTES} MINUTE)
        WHERE id = ? AND verified_token_hash IS NULL`, [hashSha256(token), entry.id]);
      return { status: 200, body: { success: true, reset_token: token, expires_in_seconds: TICKET_MINUTES * 60 } };
    });
  }

  async function resetPassword(token, password, ip) {
    secret();
    if (!await rateLimit("reset-ip", ip, 60)) return { status: 429, body: { success: false, message: "Too many attempts. Please try again later." } };
    const tokenHash = hashSha256(token);
    const preflight = await query(db, `/* reset:ticket-preflight */ SELECT id, user_id FROM password_reset_challenges
      WHERE verified_token_hash = ? AND consumed_at IS NULL AND verified_expires_at > UTC_TIMESTAMP(3) LIMIT 1`, [tokenHash]);
    if (preflight.length !== 1) return { status: 400, body: { success: false, message: INVALID_TOKEN } };
    const passwordHash = await bcrypt.hash(password, 12);
    return withTransaction(db, async (connection) => {
      const userRows = await query(connection, `/* reset:user-lock */ SELECT id, email, role, mobile_role, status, email_verified
        FROM users WHERE id = ? FOR UPDATE`, [preflight[0].user_id]);
      if (userRows.length !== 1 || !isCitizen(userRows[0])) return { status: 400, body: { success: false, message: INVALID_TOKEN } };
      const ticketRows = await query(connection, `/* reset:ticket-lock */ SELECT id, user_id, recipient_email_hash FROM password_reset_challenges
        WHERE verified_token_hash = ? AND user_id = ? AND consumed_at IS NULL
          AND delivery_status = 'sent' AND verified_expires_at > UTC_TIMESTAMP(3) FOR UPDATE`, [tokenHash, preflight[0].user_id]);
      if (ticketRows.length !== 1 ||
        !constantTimeHexMatch(ticketRows[0].recipient_email_hash, emailBindingHash(userRows[0].id, userRows[0].email))) {
        return { status: 400, body: { success: false, message: INVALID_TOKEN } };
      }
      const changed = await query(connection, "/* reset:password-update */ UPDATE users SET password = ? WHERE id = ?", [passwordHash, preflight[0].user_id]);
      if (Number(changed.affectedRows) !== 1) throw new Error("RESET_PASSWORD_WRITE_FAILED");
      await query(connection, `/* reset:sessions-revoke */ UPDATE mobile_user_sessions
        SET revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP(3)) WHERE user_id = ? AND revoked_at IS NULL`, [preflight[0].user_id]);
      await query(connection, `/* reset:all-consume */ UPDATE password_reset_challenges
        SET consumed_at = COALESCE(consumed_at, UTC_TIMESTAMP(3)) WHERE user_id = ? AND consumed_at IS NULL`, [preflight[0].user_id]);
      await query(connection, `/* reset:all-outbox-cancel */ UPDATE password_reset_outbox o
        INNER JOIN password_reset_challenges c ON c.id = o.challenge_id
        SET o.state = 'cancelled', o.payload_encrypted = NULL, o.lease_token_hash = NULL, o.leased_until = NULL
        WHERE c.user_id = ? AND o.state IN ('pending','leased')`, [preflight[0].user_id]);
      return { status: 200, body: { success: true, message: "Password updated. Sign in with your new password." } };
    });
  }

  function failResponse(res, error) {
    logger.error("[PasswordReset] Recovery request failed:", error?.code || error?.name || "UNKNOWN");
    return res.status(503).json({ success: false, message: "Password recovery is temporarily unavailable. Please try again later." });
  }

  async function forgotHandler(req, res) {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) return res.status(400).json({ success: false, message: "Enter a valid email address." });
    const start = now();
    try {
      await requestCode(email, getIp(req));
      await publicTiming(start);
      return res.status(200).json({ success: true, message: PUBLIC_MESSAGE });
    } catch (error) { await publicTiming(start); return failResponse(res, error); }
  }
  async function verifyHandler(req, res) {
    const email = normalizeEmail(req.body?.email);
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    if (!isValidEmail(email) || !CODE_PATTERN.test(code)) return res.status(400).json({ success: false, message: INVALID_CODE });
    try { const answer = await verifyCode(email, code, getIp(req)); return res.status(answer.status).json(answer.body); }
    catch (error) { return failResponse(res, error); }
  }
  async function resetHandler(req, res) {
    const token = typeof req.body?.reset_token === "string" ? req.body.reset_token : "";
    const password = typeof req.body?.new_password === "string" ? req.body.new_password : "";
    if (!TOKEN_PATTERN.test(token)) return res.status(400).json({ success: false, message: INVALID_TOKEN });
    if (password.length < 10 || Buffer.byteLength(password, "utf8") > 72) {
      return res.status(400).json({ success: false, message: "Use at least 10 characters (maximum 72 UTF-8 bytes)." });
    }
    try { const answer = await resetPassword(token, password, getIp(req)); return res.status(answer.status).json(answer.body); }
    catch (error) { return failResponse(res, error); }
  }
  return { forgotHandler, verifyHandler, resetHandler, requestCode, verifyCode, resetPassword };
}

module.exports = {
  createPasswordResetRecoveryService, PUBLIC_MESSAGE, INVALID_CODE, INVALID_TOKEN,
  normalizeEmail, isValidEmail, isCitizen, query, withTransaction, connectionFrom,
  hashSha256, secretFromEnv, emailBindingHash, encryptionKeyFromEnv, encryptPayload, decryptPayload,
  constantTimeHexMatch
};
