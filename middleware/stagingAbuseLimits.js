"use strict";
const crypto = require("node:crypto");
const net = require("node:net");
const DEFAULTS = Object.freeze({
  loginIp: 20, loginUser: 10, loginWindowMs: 15 * 60000,
  floodPeer: 60, floodGlobal: 240, floodWindowMs: 60000,
  analysesPerUser: 12, analysesGlobal: 40, analysisWindowMs: 3600000,
  activePerUser: 1, activeGlobal: 2, maxKeys: 2048, maxUsers: 512,
  requestTimeoutMs: 45000
});
function canonicalIp(raw) {
  if (typeof raw !== "string" || raw.length > 64) return "unknown";
  const value = raw.toLowerCase().split("%")[0];
  if (value.startsWith("::ffff:") && net.isIP(value.slice(7)) === 4) return value.slice(7);
  if (net.isIP(value) === 4) return value;
  if (net.isIP(value) === 6) return new URL("http://[" + value + "]").hostname;
  return "unknown";
}
function createStagingAbuseControls({ now = Date.now, setTimer = setTimeout,
  clearTimer = clearTimeout, limits = {} } = {}) {
  const cap = { ...DEFAULTS, ...limits }, salt = crypto.randomBytes(32);
  for (const v of Object.values(cap)) if (!Number.isSafeInteger(v) || v <= 0) throw new Error("Invalid staging abuse limits.");
  const attempts = new Map(), users = new Map();
  let globalTimes = [], active = 0;
  const key = value => crypto.createHmac("sha256", salt).update(value).digest("hex");
  const retry = ms => Math.max(1, Math.ceil(ms / 1000));
  function prune(time) {
    for (const [id, entry] of attempts) if (time >= entry.start + entry.window) attempts.delete(id);
    globalTimes = globalTimes.filter(value => value > time - cap.analysisWindowMs);
    for (const [id, entry] of users) {
      entry.times = entry.times.filter(value => value > time - cap.analysisWindowMs);
      if (!entry.active && !entry.times.length) users.delete(id);
    }
  }
  function consume(id, limit, window) {
    const time = now(); prune(time);
    let entry = attempts.get(id);
    if (!entry) {
      if (attempts.size >= cap.maxKeys) return retry(window);
      entry = { start: time, count: 0, window }; attempts.set(id, entry);
    }
    if (entry.count >= limit) return retry(entry.start + window - time);
    entry.count++; return 0;
  }
  function deny(res, code, seconds) {
    res.setHeader("Retry-After", String(seconds));
    res.setHeader("Cache-Control", "no-store");
    return res.status(429).json({ success: false, code, message: "Request limit reached. Please try again later." });
  }
  function peer(req) { return canonicalIp(req.socket?.remoteAddress); }
  function loginIp(req, res, next) {
    if (req.method !== "POST" || req.path !== "/api/auth/login") return next();
    // req.ip follows Express trust-proxy configuration; the peer floor cannot be
    // replaced by a caller-controlled forwarding header, even on a direct connection.
    const address = peer(req), client = canonicalIp(req.ip);
    let wait = consume(key("login-peer:" + address), cap.loginIp, cap.loginWindowMs);
    if (!wait && client !== address) wait = consume(key("login-client:" + client), cap.loginIp, cap.loginWindowMs);
    return wait ? deny(res, "STAGING_LOGIN_RATE_LIMITED", wait) : next();
  }
  function loginUsername(req, res, next) {
    if (req.method !== "POST" || req.path !== "/api/auth/login") return next();
    const raw = req.body?.username;
    if (typeof raw !== "string" || !raw.trim()) return next();
    if (raw.length > 256) return deny(res, "STAGING_LOGIN_RATE_LIMITED", retry(cap.loginWindowMs));
    const username = raw.trim().toLowerCase();
    const wait = consume(key("login-user:" + username), cap.loginUser, cap.loginWindowMs);
    return wait ? deny(res, "STAGING_LOGIN_RATE_LIMITED", wait) : next();
  }
  function beforeAuth(req, res, next) {
    if (req.method !== "POST" || !["/api/waste/analyze", "/api/waste/recognize-crops"].includes(req.path)) return next();
    const wait = consume("flood-global", cap.floodGlobal, cap.floodWindowMs)
      || consume(key("flood-peer:" + peer(req)), cap.floodPeer, cap.floodWindowMs);
    return wait ? deny(res, "STAGING_REQUEST_RATE_LIMITED", wait) : next();
  }
  function acquire(principal) {
    const time = now(); prune(time);
    if (!/^[1-9][0-9]*$/.test(String(principal))) return { denied: true, code: "STAGING_ANALYSIS_UNAVAILABLE", retryAfter: 60 };
    const id = key("analysis-user:" + principal);
    let user = users.get(id);
    if (active >= cap.activeGlobal || (user?.active || 0) >= cap.activePerUser)
      return { denied: true, code: "STAGING_ANALYSIS_BUSY", retryAfter: 5 };
    if (globalTimes.length >= cap.analysesGlobal)
      return { denied: true, code: "STAGING_ANALYSIS_RATE_LIMITED", retryAfter: retry(globalTimes[0] + cap.analysisWindowMs - time) };
    if (user && user.times.length >= cap.analysesPerUser)
      return { denied: true, code: "STAGING_ANALYSIS_RATE_LIMITED", retryAfter: retry(user.times[0] + cap.analysisWindowMs - time) };
    if (!user && users.size >= cap.maxUsers)
      return { denied: true, code: "STAGING_ANALYSIS_BUSY", retryAfter: 60 };
    if (!user) { user = { times: [], active: 0 }; users.set(id, user); }
    user.times.push(time); globalTimes.push(time); user.active++; active++;
    let released = false;
    return { release() { if (released) return; released = true; user.active--; active--; } };
  }
  function analysis(req, res, next) {
    if (req.method !== "POST" || req.path !== "/api/waste/analyze") return next();
    if (req.aborted || res.destroyed) return;
    const permit = acquire(req.mobileUser?.id);
    if (permit.denied) return deny(res, permit.code, permit.retryAfter);
    const controller = new AbortController(); let timer, settled = false;
    function finish(cancel = false) {
      if (settled) return; settled = true;
      if (cancel) controller.abort();
      clearTimer(timer); permit.release();
      req.removeListener("aborted", abort); res.removeListener("close", close); res.removeListener("finish", done);
    }
    const abort = () => finish(true), close = () => finish(!res.writableFinished), done = () => finish(false);
    req.once("aborted", abort); res.once("close", close); res.once("finish", done);
    req.stagingAnalysisScope = { signal: controller.signal };
    timer = setTimer(() => {
      finish(true);
      if (!res.headersSent && !res.destroyed) res.status(504).json({
        success: false, code: "STAGING_ANALYSIS_TIMEOUT", message: "Analysis request timed out." });
      else res.destroy?.();
    }, cap.requestTimeoutMs);
    timer?.unref?.();
    try { return next(); } catch (error) { finish(true); throw error; }
  }
  return { loginIp, loginUsername, beforeAuth, analysis, acquire,
    snapshot() { prune(now()); return { attemptKeys: attempts.size, users: users.size, active, admitted: globalTimes.length }; } };
}
module.exports = { DEFAULTS, canonicalIp, createStagingAbuseControls };
