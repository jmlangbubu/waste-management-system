"use strict";

const crypto = require("crypto");
const {
  query, withTransaction, encryptionKeyFromEnv, decryptPayload, hashSha256,
  normalizeEmail, isCitizen, emailBindingHash, constantTimeHexMatch
} = require("./passwordResetRecoveryService");

const LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 4;
const MAX_QUEUE_AGE_MINUTES = 15;
const RETRY_SECONDS = [15, 45, 120, 240];

function createPasswordResetOutboxService({ db, sendPasswordResetEmail, logger = console, tokenFactory = () => crypto.randomBytes(32).toString("hex") }) {
  if (!db || typeof sendPasswordResetEmail !== "function") throw new Error("Missing outbox database/email sender");
  async function claimOne() {
    encryptionKeyFromEnv();
    const token = tokenFactory();
    const tokenHash = hashSha256(token);
    // Atomic lease claim; safe when multiple Render instances poll concurrently.
    const claimed = await query(db, `/* outbox:claim */ UPDATE password_reset_outbox
      SET state = 'leased', lease_token_hash = ?,
          leased_until = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${LEASE_SECONDS} SECOND), attempts = attempts + 1
      WHERE available_at <= UTC_TIMESTAMP(3)
        AND created_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ${MAX_QUEUE_AGE_MINUTES} MINUTE)
        AND attempts < ${MAX_ATTEMPTS}
        AND (state = 'pending' OR (state = 'leased' AND leased_until < UTC_TIMESTAMP(3)))
      ORDER BY available_at, id LIMIT 1`, [tokenHash]);
    if (Number(claimed.affectedRows || 0) !== 1) return null;
    const rows = await query(db, `/* outbox:claimed */ SELECT id, challenge_id, payload_encrypted, attempts
      FROM password_reset_outbox WHERE lease_token_hash = ? AND state = 'leased' LIMIT 1`, [tokenHash]);
    return rows.length === 1 ? { ...rows[0], tokenHash } : null;
  }

  async function canSend(job, recipientEmail) {
    const rows = await query(db, `/* outbox:can-send */ SELECT c.id, c.user_id, c.recipient_email_hash, c.consumed_at, c.delivery_status,
        o.state, o.lease_token_hash
        , u.email, u.role, u.mobile_role, u.status, u.email_verified
      FROM password_reset_challenges c
      INNER JOIN password_reset_outbox o ON o.challenge_id = c.id
      INNER JOIN users u ON u.id = c.user_id
      WHERE o.id = ? LIMIT 1`, [job.id]);
    return rows.length === 1 && !rows[0].consumed_at && rows[0].delivery_status === "queued" &&
      rows[0].state === "leased" && rows[0].lease_token_hash === job.tokenHash &&
      isCitizen(rows[0]) && normalizeEmail(rows[0].email) === normalizeEmail(recipientEmail) &&
      constantTimeHexMatch(rows[0].recipient_email_hash, emailBindingHash(rows[0].user_id, recipientEmail));
  }

  async function finish(job, outcome, recipientEmail = null) {
    // Reading ID before transaction is safe; locked rows are rechecked below.
    const lookup = await query(db, `/* outbox:find-user */ SELECT c.user_id FROM password_reset_challenges c
      INNER JOIN password_reset_outbox o ON o.challenge_id = c.id WHERE o.id = ?`, [job.id]);
    if (lookup.length !== 1) return false;
    return withTransaction(db, async (connection) => {
      // Consistent lock order with all recovery routes: USERS -> CHALLENGES -> OUTBOX.
      const users = await query(connection, "/* outbox:user-lock */ SELECT id, email, role, mobile_role, status, email_verified FROM users WHERE id = ? FOR UPDATE", [lookup[0].user_id]);
      if (users.length !== 1) return false;
      const challenges = await query(connection, `/* outbox:challenge-lock */ SELECT id, consumed_at, delivery_status, recipient_email_hash
        FROM password_reset_challenges WHERE id = ? FOR UPDATE`, [job.challenge_id]);
      if (challenges.length !== 1) return false;
      const jobs = await query(connection, `/* outbox:job-lock */ SELECT id, state, lease_token_hash, attempts
        FROM password_reset_outbox WHERE id = ? FOR UPDATE`, [job.id]);
      if (jobs.length !== 1 || jobs[0].state !== "leased" || jobs[0].lease_token_hash !== job.tokenHash) return false;

      const currentEmail = normalizeEmail(users[0].email);
      const emailStillBound = constantTimeHexMatch(
        challenges[0].recipient_email_hash, emailBindingHash(users[0].id, currentEmail)
      ) && (recipientEmail === null || currentEmail === normalizeEmail(recipientEmail));
      const active = !challenges[0].consumed_at && challenges[0].delivery_status === "queued" && emailStillBound;
      if (!active || outcome === "cancelled" || !isCitizen(users[0])) {
        await query(connection, `/* outbox:cancel */ UPDATE password_reset_outbox SET state = 'cancelled',
          payload_encrypted = NULL, lease_token_hash = NULL, leased_until = NULL WHERE id = ?`, [job.id]);
        await query(connection, `/* outbox:consume-failed */ UPDATE password_reset_challenges
          SET consumed_at = UTC_TIMESTAMP(3) WHERE id = ? AND consumed_at IS NULL`, [job.challenge_id]);
        return false;
      }
      if (outcome === "sent") {
        await query(connection, `/* outbox:activate-code */ UPDATE password_reset_challenges
          SET delivery_status = 'sent', sent_at = UTC_TIMESTAMP(3),
            expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE)
          WHERE id = ? AND delivery_status = 'queued' AND consumed_at IS NULL`, [job.challenge_id]);
        await query(connection, `/* outbox:mark-sent */ UPDATE password_reset_outbox
          SET state = 'sent', sent_at = UTC_TIMESTAMP(3),
            payload_encrypted = NULL, lease_token_hash = NULL, leased_until = NULL
          WHERE id = ?`, [job.id]);
        return true;
      }
      const terminal = Number(jobs[0].attempts) >= MAX_ATTEMPTS;
      if (terminal) {
        await query(connection, `/* outbox:terminal-fail */ UPDATE password_reset_outbox
          SET state = 'failed', payload_encrypted = NULL, lease_token_hash = NULL, leased_until = NULL
          WHERE id = ?`, [job.id]);
        await query(connection, `/* outbox:consume-failed */ UPDATE password_reset_challenges
          SET consumed_at = UTC_TIMESTAMP(3) WHERE id = ? AND consumed_at IS NULL`, [job.challenge_id]);
      } else {
        const retrySeconds = RETRY_SECONDS[Math.min(Number(jobs[0].attempts) - 1, RETRY_SECONDS.length - 1)];
        await query(connection, `/* outbox:retry */ UPDATE password_reset_outbox
          SET state = 'pending', lease_token_hash = NULL, leased_until = NULL,
              available_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND)
          WHERE id = ?`, [retrySeconds, job.id]);
      }
      return true;
    });
  }

  async function expireStale() {
    // Bounded maintenance: old jobs are not deliverable. Challenge stays unverified.
    return query(db, `/* outbox:expire-stale */ UPDATE password_reset_outbox
      SET state = 'failed', payload_encrypted = NULL, lease_token_hash = NULL, leased_until = NULL
      WHERE state IN ('pending','leased')
        AND (state = 'pending' OR leased_until < UTC_TIMESTAMP(3))
        AND (created_at <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ${MAX_QUEUE_AGE_MINUTES} MINUTE)
          OR attempts >= ${MAX_ATTEMPTS}) LIMIT 50`);
  }

  async function processOne() {
    await expireStale();
    const job = await claimOne();
    if (!job) return { processed: false };
    let payload;
    try { payload = decryptPayload(job.payload_encrypted, job.challenge_id, encryptionKeyFromEnv()); }
    catch (error) {
      // Invalid encrypted payload must not be retried indefinitely.
      logger.error("[ResetOutbox] Unreadable encrypted payload:", error.code || error.message || "UNKNOWN");
      await finish(job, "cancelled");
      return { processed: true, sent: false };
    }
    const expectedRecipientEmail = payload.email;
    if (!await canSend(job, expectedRecipientEmail)) {
      await finish(job, "cancelled", expectedRecipientEmail);
      payload.email = ""; payload.code = "";
      return { processed: true, sent: false };
    }
    try {
      // Do not log email, code, encrypted payload, response or tokens.
      await sendPasswordResetEmail(payload.email, payload.code);
    } catch (error) {
      logger.error("[ResetOutbox] Provider send failed:", error.code || error.name || "UNKNOWN");
      await finish(job, "failed", expectedRecipientEmail);
      return { processed: true, sent: false };
    } finally {
      if (payload) { payload.code = ""; payload.email = ""; }
    }
    // Important: if provider accepted but DB commit fails, this throws and the
    // lease may eventually be retried. Exactly-once email delivery is NOT guaranteed.
    const finalized = await finish(job, "sent", expectedRecipientEmail);
    return { processed: true, sent: finalized };
  }

  return { claimOne, canSend, finish, expireStale, processOne };
}

module.exports = { createPasswordResetOutboxService, LEASE_SECONDS, MAX_ATTEMPTS };
