"use strict";

// Test-only callback-style mysql2 simulation. NOT a substitute for real MySQL.
class FakeMysql {
  constructor() {
    this.nowMs = Date.parse("2026-10-20T00:00:00.000Z");
    this.state = {
      users: [{ id: 11, email: "citizen@example.com", password: "old-hash", role: "citizen", mobile_role: null, status: "active", email_verified: 1 }],
      challenges: [], outboxes: [], sessions: [{ user_id: 11, revoked_at: null }, { user_id: 11, revoked_at: null }],
      rateLimits: {}
    };
    this.nextId = 1;
    this.failTag = null;
    this.queue = Promise.resolve();
    this.releaseGate = null;
  }
  advance(ms) { this.nowMs += ms; }
  query(sql, params, cb) { this._query(this.state, sql, params, cb); }
  getConnection(cb) {
    const pool = this;
    const connection = {
      tx: null, released: false,
      beginTransaction(done) {
        let release;
        const previous = pool.queue;
        pool.queue = new Promise(resolve => { release = resolve; });
        previous.then(() => {
          connection.tx = structuredClone(pool.state);
          connection._releaseLock = release;
          queueMicrotask(() => done(null));
        });
      },
      query(sql, params, done) { pool._query(connection.tx, sql, params, done); },
      commit(done) {
        if (!connection.tx) return done(new Error("No active transaction"));
        // Rate limits are updated outside of transactions.
        connection.tx.rateLimits = pool.state.rateLimits;
        pool.state = connection.tx;
        connection.tx = null;
        connection._releaseLock();
        queueMicrotask(() => done(null));
      },
      rollback(done) { connection.tx = null; connection._releaseLock(); queueMicrotask(() => done(null)); },
      release() { connection.released = true; }
    };
    queueMicrotask(() => cb(null, connection));
  }
  _query(state, sql, params = [], cb) {
    queueMicrotask(() => {
      try {
        const match = /\/\*\s*(reset|outbox):([\w-]+)\s*\*\//.exec(sql);
        if (!match) throw new Error(`Untagged SQL in test: ${sql.slice(0, 90)}`);
        const tag = `${match[1]}:${match[2]}`;
        if (tag === this.failTag) throw Object.assign(new Error("Simulated DB failure"), { code: "TEST_DB_FAILURE" });
        cb(null, this._execute(state, tag, params));
      } catch (error) { cb(error); }
    });
  }
  _execute(s, tag, p) {
    const now = this.nowMs;
    const active = c => c.consumed_at == null;
    const row = id => s.challenges.find(c => c.id === id);
    const job = id => s.outboxes.find(o => o.id === id);
    switch (tag) {
      case "reset:limit-incr": {
        const v = s.rateLimits[p[0]];
        if (!v || v.started < now - 3600000) s.rateLimits[p[0]] = { request_count: 1, started: now };
        else v.request_count++;
        return { affectedRows: 1 };
      }
      case "reset:limit-get": return [s.rateLimits[p[0]]];
      case "reset:user-email": return s.users.filter(u => u.email.trim().toLowerCase() === p[0]).slice(0, 2);
      case "reset:user-lock": case "outbox:user-lock": return s.users.filter(u => u.id === p[0]);
      case "reset:active-challenge": return s.challenges.filter(c => c.user_id === p[0] && active(c) &&
        ((c.delivery_status === "queued" && c.created_at > now - 600000) ||
          (c.delivery_status === "sent" && c.expires_at > now))).sort((a, b) => b.id - a.id).slice(0, 1);
      case "reset:old-consume": {
        let count = 0;
        for (const c of s.challenges) if (c.user_id === p[0] && active(c)) { c.consumed_at = now; count++; }
        return { affectedRows: count };
      }
      case "reset:old-outbox-cancel": case "reset:all-outbox-cancel": {
        const ids = new Set(s.challenges.filter(c => c.user_id === p[0]).map(c => c.id));
        let count = 0;
        for (const o of s.outboxes) if (ids.has(o.challenge_id) && ["pending", "leased"].includes(o.state)) {
          Object.assign(o, { state: "cancelled", payload_encrypted: null, lease_token_hash: null, leased_until: null }); count++;
        }
        return { affectedRows: count };
      }
      case "reset:challenge-insert": {
        const id = this.nextId++;
        s.challenges.push({ id, user_id: p[0], recipient_email_hash: p[1], code_hash: p[2], expires_at: null,
          delivery_status: "queued", attempts: 0, verified_token_hash: null,
          verified_expires_at: null, consumed_at: null, created_at: now, sent_at: null });
        return { insertId: id, affectedRows: 1 };
      }
      case "reset:outbox-insert": {
        const id = this.nextId++;
        s.outboxes.push({ id, challenge_id: p[0], payload_encrypted: p[1], state: "pending",
          available_at: now, attempts: 0, lease_token_hash: null, leased_until: null, created_at: now, sent_at: null });
        return { insertId: id, affectedRows: 1 };
      }
      case "reset:verify-latest": return s.challenges.filter(c => c.user_id === p[0] && active(c) &&
        c.delivery_status === "sent" && c.verified_token_hash == null && c.expires_at > now)
        .sort((a, b) => b.id - a.id).slice(0, 1);
      case "reset:verify-attempt": row(p[0]).attempts++; return { affectedRows: 1 };
      case "reset:verify-token": {
        row(p[1]).verified_token_hash = p[0]; row(p[1]).verified_expires_at = now + 300000;
        return { affectedRows: 1 };
      }
      case "reset:ticket-preflight": return s.challenges.filter(c => c.verified_token_hash === p[0] &&
        active(c) && c.verified_expires_at > now).slice(0, 1).map(c => ({ id: c.id, user_id: c.user_id }));
      case "reset:ticket-lock": return s.challenges.filter(c => c.verified_token_hash === p[0] && c.user_id === p[1] &&
        active(c) && c.delivery_status === "sent" && c.verified_expires_at > now).map(c => ({ id: c.id, user_id: c.user_id, recipient_email_hash: c.recipient_email_hash }));
      case "reset:password-update": {
        const user = s.users.find(u => u.id === p[1]); if (!user) return { affectedRows: 0 };
        user.password = p[0]; return { affectedRows: 1 };
      }
      case "reset:sessions-revoke": {
        let count = 0;
        for (const session of s.sessions) if (session.user_id === p[0] && session.revoked_at === null) {
          session.revoked_at = now; count++;
        }
        return { affectedRows: count };
      }
      case "reset:all-consume": {
        let count = 0;
        for (const c of s.challenges) if (c.user_id === p[0] && active(c)) { c.consumed_at = now; count++; }
        return { affectedRows: count };
      }
      case "outbox:expire-stale": {
        let count = 0;
        for (const o of s.outboxes) if (["pending", "leased"].includes(o.state) &&
          (o.state === "pending" || o.leased_until < now) && (o.created_at <= now - 900000 || o.attempts >= 4)) {
          Object.assign(o, { state: "failed", payload_encrypted: null, lease_token_hash: null, leased_until: null }); count++;
        }
        return { affectedRows: count };
      }
      case "outbox:claim": {
        const o = s.outboxes.filter(j => j.available_at <= now && j.created_at > now - 900000 && j.attempts < 4 &&
          (j.state === "pending" || (j.state === "leased" && j.leased_until < now)))
          .sort((a, b) => a.available_at - b.available_at || a.id - b.id)[0];
        if (!o) return { affectedRows: 0 };
        Object.assign(o, { state: "leased", lease_token_hash: p[0], leased_until: now + 120000, attempts: o.attempts + 1 });
        return { affectedRows: 1 };
      }
      case "outbox:claimed": return s.outboxes.filter(o => o.lease_token_hash === p[0] && o.state === "leased").slice(0, 1);
      case "outbox:can-send": {
        const o = job(p[0]); if (!o) return [];
        const c = row(o.challenge_id); const user = s.users.find(u => u.id === c.user_id);
        return [{ id: c.id, user_id: c.user_id, recipient_email_hash: c.recipient_email_hash, consumed_at: c.consumed_at,
          delivery_status: c.delivery_status, state: o.state, lease_token_hash: o.lease_token_hash, ...user }];
      }
      case "outbox:find-user": { const o = job(p[0]); return o ? [{ user_id: row(o.challenge_id).user_id }] : []; }
      case "outbox:challenge-lock": return s.challenges.filter(c => c.id === p[0]);
      case "outbox:job-lock": return s.outboxes.filter(o => o.id === p[0]);
      case "outbox:cancel": Object.assign(job(p[0]), { state: "cancelled", payload_encrypted: null, lease_token_hash: null, leased_until: null }); return { affectedRows: 1 };
      case "outbox:activate-code": {
        const c = row(p[0]);
        if (c.delivery_status !== "queued" || !active(c)) return { affectedRows: 0 };
        Object.assign(c, { delivery_status: "sent", sent_at: now, expires_at: now + 600000 });
        return { affectedRows: 1 };
      }
      case "outbox:mark-sent": Object.assign(job(p[0]), { state: "sent", sent_at: now, payload_encrypted: null, lease_token_hash: null, leased_until: null }); return { affectedRows: 1 };
      case "outbox:terminal-fail": Object.assign(job(p[0]), { state: "failed", payload_encrypted: null, lease_token_hash: null, leased_until: null }); return { affectedRows: 1 };
      case "outbox:consume-failed": row(p[0]).consumed_at = now; return { affectedRows: 1 };
      case "outbox:retry": Object.assign(job(p[1]), { state: "pending", available_at: now + p[0] * 1000, lease_token_hash: null, leased_until: null }); return { affectedRows: 1 };
      default: throw new Error(`Unsupported SQL tag in fake: ${tag}`);
    }
  }
}
module.exports = { FakeMysql };
