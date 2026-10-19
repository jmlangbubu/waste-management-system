"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { FakeMysql } = require("./fakeMysql");
const {
  createPasswordResetRecoveryService, encryptPayload, decryptPayload,
  encryptionKeyFromEnv, normalizeEmail, isCitizen, hashSha256
} = require("../services/passwordResetRecoveryService");
const { createPasswordResetOutboxService } = require("../services/passwordResetOutboxService");

// Fixed values are FAKE TEST-ONLY, not production secrets.
process.env.PASSWORD_RESET_HMAC_SECRET = "TEST_ONLY_0123456789abcdef0123456789abcdef";
process.env.PASSWORD_RESET_OUTBOX_KEY = Buffer.alloc(32, 7).toString("base64");
const logger = { error() {} };
function setup(sender) {
  const db = new FakeMysql();
  const bcrypt = { async hash(password, cost) { assert.equal(cost, 12); return `fakebcrypt:${password}`; } };
  const recovery = createPasswordResetRecoveryService({ db, bcrypt, logger, now: () => db.nowMs, delay: async () => {} });
  const deliveries = [];
  const outbox = createPasswordResetOutboxService({ db, logger, sendPasswordResetEmail: sender || (async (email, code) => deliveries.push({ email, code })) });
  return { db, recovery, deliveries, outbox };
}
async function sendOne(ctx) { await ctx.recovery.requestCode("citizen@example.com", "ip-1"); return ctx.outbox.processOne(); }
async function prepareTicket(ctx) {
  await sendOne(ctx);
  return ctx.recovery.verifyCode("citizen@example.com", ctx.deliveries[0].code, "ip-1");
}

// Critical crypto and account-scope invariants.
test("normalizes emails without coercing arbitrary input", () => {
  assert.equal(normalizeEmail("  Citizen@Example.COM  "), "citizen@example.com");
  assert.equal(normalizeEmail(123), "");
});
test("only active verified citizen users are eligible", () => {
  assert.equal(isCitizen({ role: "citizen", status: "active", email_verified: 1 }), true);
  for (const v of [{ role: "admin", status: "active", email_verified: 1 }, { role: "citizen", status: "suspended", email_verified: 1 }, { role: "citizen", status: "active", email_verified: 0 }]) assert.equal(isCitizen(v), false);
});
test("outbox payload is encrypted and decrypts with matching challenge AAD", () => {
  const key = encryptionKeyFromEnv();
  const encrypted = encryptPayload({ email: "citizen@example.com", code: "123456" }, 1, key);
  assert.equal(encrypted.includes("123456"), false);
  assert.equal(encrypted.includes("citizen@example.com"), false);
  assert.deepEqual(decryptPayload(encrypted, 1, key), { email: "citizen@example.com", code: "123456" });
  assert.throws(() => decryptPayload(encrypted, 2, key));
});
test("AES-GCM tamper fails authentication", () => {
  const encrypted = encryptPayload({ email: "citizen@example.com", code: "123456" }, 5, encryptionKeyFromEnv());
  const parts = encrypted.split(":"); parts[2] = Buffer.alloc(16, 4).toString("base64");
  assert.throws(() => decryptPayload(parts.join(":"), 5, encryptionKeyFromEnv()));
});
test("missing outbox key blocks issuance and never saves plaintext", async () => {
  const { db, recovery } = setup();
  const previous = process.env.PASSWORD_RESET_OUTBOX_KEY;
  delete process.env.PASSWORD_RESET_OUTBOX_KEY;
  try { await assert.rejects(recovery.requestCode("citizen@example.com", "ip-1"), /KEY_MISSING/); }
  finally { process.env.PASSWORD_RESET_OUTBOX_KEY = previous; }
  assert.equal(db.state.outboxes.length, 0);
});
test("unknown address does not queue email", async () => {
  const x = setup(); await x.recovery.requestCode("unknown@example.com", "ip-1");
  assert.equal(x.db.state.challenges.length, 0); assert.equal(x.db.state.outboxes.length, 0);
});
test("unverified, suspended, and admin do not queue email", async () => {
  for (const changes of [{ email_verified: 0 }, { status: "suspended" }, { role: "admin" }]) {
    const x = setup(); Object.assign(x.db.state.users[0], changes);
    await x.recovery.requestCode("citizen@example.com", "ip-1");
    assert.equal(x.db.state.outboxes.length, 0);
  }
});
test("eligible request stores hash and encrypted queued email (never raw code)", async () => {
  const x = setup(); await x.recovery.requestCode("citizen@example.com", "ip-1");
  assert.equal(x.db.state.challenges.length, 1);
  assert.equal(x.db.state.challenges[0].delivery_status, "queued");
  assert.equal(x.db.state.challenges[0].expires_at, null);
  assert.match(x.db.state.challenges[0].code_hash, /^[0-9a-f]{64}$/);
  assert.equal(x.db.state.outboxes.length, 1);
  assert.equal(x.db.state.outboxes[0].state, "pending");
  assert.equal(x.db.state.outboxes[0].payload_encrypted.includes("citizen@example.com"), false);
});
test("queued OTP is not valid until worker marks email accepted", async () => {
  const x = setup(); await x.recovery.requestCode("citizen@example.com", "ip-1");
  const code = decryptPayload(x.db.state.outboxes[0].payload_encrypted, x.db.state.challenges[0].id, encryptionKeyFromEnv()).code;
  const reply = await x.recovery.verifyCode("citizen@example.com", code, "ip-1");
  assert.equal(reply.status, 400);
});
test("simultaneous issuance serializes under user lock; only one OTP is queued", async () => {
  const x = setup();
  await Promise.all(Array.from({ length: 3 }, () => x.recovery.requestCode("citizen@example.com", "ip-1")));
  assert.equal(x.db.state.challenges.length, 1);
  assert.equal(x.db.state.outboxes.length, 1);
});
test("per-email hourly request limit prevents fourth issuance", async () => {
  const x = setup();
  await x.recovery.requestCode("citizen@example.com", "ip-1");
  x.db.advance(600001); await x.recovery.requestCode("citizen@example.com", "ip-1");
  x.db.advance(600001); await x.recovery.requestCode("citizen@example.com", "ip-1");
  x.db.advance(600001); await x.recovery.requestCode("citizen@example.com", "ip-1");
  assert.equal(x.db.state.challenges.length, 3);
});
test("successful worker send activates a 10-minute OTP and clears ciphertext", async () => {
  const x = setup(); const outcome = await sendOne(x);
  assert.deepEqual(outcome, { processed: true, sent: true });
  assert.equal(x.deliveries.length, 1);
  assert.equal(x.db.state.challenges[0].delivery_status, "sent");
  assert.equal(x.db.state.challenges[0].expires_at, x.db.nowMs + 600000);
  assert.equal(x.db.state.outboxes[0].payload_encrypted, null);
});
test("worker does not send the same completed job again", async () => {
  const x = setup(); await sendOne(x); await x.outbox.processOne();
  assert.equal(x.deliveries.length, 1);
});
test("valid OTP returns random opaque one-use ticket", async () => {
  const x = setup(); const result = await prepareTicket(x);
  assert.equal(result.status, 200);
  assert.match(result.body.reset_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(x.db.state.challenges[0].verified_token_hash, hashSha256(result.body.reset_token));
  assert.equal(await x.recovery.verifyCode("citizen@example.com", x.deliveries[0].code, "ip-1").then(r => r.status), 400);
});
test("wrong code increments tries and blocks after five", async () => {
  const x = setup(); await sendOne(x);
  for (let i = 0; i < 5; i++) {
    const wrong = x.deliveries[0].code === "000000" ? "000001" : "000000";
    assert.equal((await x.recovery.verifyCode("citizen@example.com", wrong, "ip-1")).status, 400);
  }
  assert.equal(x.db.state.challenges[0].attempts, 5);
  assert.equal((await x.recovery.verifyCode("citizen@example.com", x.deliveries[0].code, "ip-1")).status, 400);
});
test("expired OTP is rejected", async () => {
  const x = setup(); await sendOne(x); x.db.advance(600001);
  assert.equal((await x.recovery.verifyCode("citizen@example.com", x.deliveries[0].code, "ip-1")).status, 400);
});
test("reset changes password, revokes all sessions and consumes ticket", async () => {
  const x = setup(); const t = await prepareTicket(x);
  const result = await x.recovery.resetPassword(t.body.reset_token, "very-long-password", "ip-1");
  assert.equal(result.status, 200);
  assert.equal(x.db.state.users[0].password, "fakebcrypt:very-long-password");
  assert.equal(x.db.state.sessions.every(s => s.revoked_at != null), true);
  assert.equal(x.db.state.challenges[0].consumed_at != null, true);
  assert.equal((await x.recovery.resetPassword(t.body.reset_token, "another-good-password", "ip-1")).status, 400);
});
test("expired reset ticket is rejected without changing password", async () => {
  const x = setup(); const t = await prepareTicket(x); x.db.advance(300001);
  assert.equal((await x.recovery.resetPassword(t.body.reset_token, "another-long-password", "ip-1")).status, 400);
  assert.equal(x.db.state.users[0].password, "old-hash");
});
test("transaction rollback preserves password and sessions when session revoke fails", async () => {
  const x = setup(); const t = await prepareTicket(x);
  x.db.failTag = "reset:sessions-revoke";
  await assert.rejects(x.recovery.resetPassword(t.body.reset_token, "a-different-password", "ip-1"), /Simulated DB failure/);
  assert.equal(x.db.state.users[0].password, "old-hash");
  assert.equal(x.db.state.sessions.every(s => s.revoked_at == null), true);
  assert.equal(x.db.state.challenges[0].consumed_at, null);
});
test("simultaneous OTP verification produces only one reset token", async () => {
  const x = setup(); await sendOne(x);
  const results = await Promise.all([0, 1].map(() => x.recovery.verifyCode("citizen@example.com", x.deliveries[0].code, "ip-1")));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
});
test("simultaneous ticket redemption produces exactly one success", async () => {
  const x = setup(); const t = await prepareTicket(x);
  const results = await Promise.all([0, 1].map(() => x.recovery.resetPassword(t.body.reset_token, "new-long-password", "ip-1")));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
});
test("email transport failure queues retry, not valid OTP", async () => {
  const x = setup(async () => { throw Object.assign(new Error("offline"), { code: "TEST_MAIL_DOWN" }); });
  await x.recovery.requestCode("citizen@example.com", "ip-1");
  const result = await x.outbox.processOne();
  assert.equal(result.sent, false);
  assert.equal(x.db.state.challenges[0].delivery_status, "queued");
  assert.equal(x.db.state.outboxes[0].state, "pending");
  assert.equal(x.db.state.outboxes[0].attempts, 1);
});
test("four failed deliveries terminate job and burn OTP", async () => {
  const x = setup(async () => { throw new Error("offline"); });
  await x.recovery.requestCode("citizen@example.com", "ip-1");
  for (let i = 0; i < 4; i++) { await x.outbox.processOne(); x.db.advance(130000); }
  assert.equal(x.db.state.outboxes[0].state, "failed");
  assert.equal(x.db.state.outboxes[0].payload_encrypted, null);
  assert.equal(x.db.state.challenges[0].consumed_at != null, true);
});
test("stale queued emails are discarded without ever making OTP valid", async () => {
  const x = setup(); await x.recovery.requestCode("citizen@example.com", "ip-1"); x.db.advance(900001);
  const result = await x.outbox.processOne();
  assert.equal(result.processed, false);
  assert.equal(x.db.state.outboxes[0].state, "failed");
  assert.equal(x.db.state.challenges[0].delivery_status, "queued");
});
test("parallel workers claim one job only", async () => {
  const x = setup(); await x.recovery.requestCode("citizen@example.com", "ip-1");
  const result = await Promise.all([x.outbox.claimOne(), x.outbox.claimOne()]);
  assert.equal(result.filter(Boolean).length, 1);
});
test("provider accepted but DB finalization failed leaves leased state for retry (at-least-once)", async () => {
  const x = setup(); await x.recovery.requestCode("citizen@example.com", "ip-1");
  x.db.failTag = "outbox:mark-sent";
  await assert.rejects(x.outbox.processOne(), /Simulated DB failure/);
  assert.equal(x.deliveries.length, 1);
  assert.equal(x.db.state.challenges[0].delivery_status, "queued");
  assert.equal(x.db.state.outboxes[0].state, "leased");
});
test("missing key prevents worker from claiming encrypted jobs", async () => {
  const x = setup(); await x.recovery.requestCode("citizen@example.com", "ip-1");
  const old = process.env.PASSWORD_RESET_OUTBOX_KEY; delete process.env.PASSWORD_RESET_OUTBOX_KEY;
  try { await assert.rejects(x.outbox.claimOne(), /KEY_MISSING/); }
  finally { process.env.PASSWORD_RESET_OUTBOX_KEY = old; }
  assert.equal(x.db.state.outboxes[0].state, "pending");
});
test("queued message is cancelled when account becomes suspended before delivery", async () => {
  const x = setup(); await x.recovery.requestCode("citizen@example.com", "ip-1");
  x.db.state.users[0].status = "suspended";
  const result = await x.outbox.processOne();
  assert.equal(result.sent, false);
  assert.equal(x.deliveries.length, 0);
  assert.equal(x.db.state.outboxes[0].state, "cancelled");
  assert.equal(x.db.state.challenges[0].consumed_at != null, true);
});
test("queued message is cancelled when recipient email changed", async () => {
  const x = setup(); await x.recovery.requestCode("citizen@example.com", "ip-1");
  x.db.state.users[0].email = "updated@example.com";
  const result = await x.outbox.processOne();
  assert.equal(result.sent, false);
  assert.equal(x.deliveries.length, 0);
  assert.equal(x.db.state.outboxes[0].state, "cancelled");
});
test("public forgot response is identical for eligible and unknown email", async () => {
  async function invoke(email) {
    const x = setup();
    const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await x.recovery.forgotHandler({ body: { email }, ip: "1.2.3.4" }, response);
    return { code: response.code, body: response.body, queued: x.db.state.outboxes.length };
  }
  const known = await invoke("citizen@example.com");
  const unknown = await invoke("unknown@example.com");
  assert.equal(known.code, 200);
  assert.equal(unknown.code, 200);
  assert.deepEqual(known.body, unknown.body);
  assert.equal(known.queued, 1);
  assert.equal(unknown.queued, 0);
});
test("invalid forgot email fails without DB mutation", async () => {
  const x = setup();
  const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await x.recovery.forgotHandler({ body: { email: "invalid address" }, ip: "1.2.3.4" }, response);
  assert.equal(response.code, 400);
  assert.equal(x.db.state.outboxes.length, 0);
});
test("invalid new password fails without DB mutation", async () => {
  const x = setup(); const ticket = crypto.randomBytes(32).toString("base64url");
  const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await x.recovery.resetHandler({ body: { reset_token: ticket, new_password: "short" }, ip: "1.2.3.4" }, response);
  assert.equal(response.code, 400);
  assert.equal(x.db.state.users[0].password, "old-hash");
});

// Regression: an OTP is bound to the recipient email, not just the user ID.
test("OTP sent to previous email cannot verify after account email changes", async () => {
  const x = setup(); await sendOne(x);
  x.db.state.users[0].email = "updated@example.com";
  const attempt = await x.recovery.verifyCode("updated@example.com", x.deliveries[0].code, "ip-1");
  assert.equal(attempt.status, 400);
  assert.equal(x.db.state.challenges[0].verified_token_hash, null);
});
test("ticket issued before email change cannot reset password afterward", async () => {
  const x = setup(); const ticket = await prepareTicket(x);
  x.db.state.users[0].email = "updated@example.com";
  const attempt = await x.recovery.resetPassword(ticket.body.reset_token, "very-long-password", "ip-1");
  assert.equal(attempt.status, 400);
  assert.equal(x.db.state.users[0].password, "old-hash");
  assert.equal(x.db.state.sessions.every(item => item.revoked_at == null), true);
});
test("email changed during provider delivery cannot activate sent code", async () => {
  const x = setup(async () => { x.db.state.users[0].email = "updated@example.com"; });
  await x.recovery.requestCode("citizen@example.com", "ip-1");
  const attempt = await x.outbox.processOne();
  assert.equal(attempt.sent, false);
  assert.equal(x.db.state.outboxes[0].state, "cancelled");
  assert.equal(x.db.state.challenges[0].delivery_status, "queued");
  assert.ok(x.db.state.challenges[0].consumed_at != null);
});
test("corrupt encrypted message is cancelled immediately rather than retried", async () => {
  const x = setup(); await x.recovery.requestCode("citizen@example.com", "ip-1");
  x.db.state.outboxes[0].payload_encrypted = "v1:corrupt";
  const attempt = await x.outbox.processOne();
  assert.equal(attempt.sent, false);
  assert.equal(x.db.state.outboxes[0].state, "cancelled");
  assert.ok(x.db.state.challenges[0].consumed_at != null);
});
