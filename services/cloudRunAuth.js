"use strict";
const fs = require("node:fs");
const path = require("node:path");
const AUTH_TIMEOUT_MS = 2000;
const STAGING_CALLER_EMAIL = "wmo-render-staging-caller@gen-lang-client-0282087033.iam.gserviceaccount.com";
function parseCallerCredentials(raw, env) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 32768) throw unavailable();
  let credentials;
  try { credentials = JSON.parse(raw); } catch (_) { throw unavailable(); }
  if (credentials?.type !== "service_account" || typeof credentials.client_email !== "string"
      || !credentials.client_email.endsWith(".iam.gserviceaccount.com")
      || typeof credentials.private_key !== "string" || !credentials.private_key
      || credentials.universe_domain && credentials.universe_domain !== "googleapis.com"
      || env.WMO_DEPLOYMENT_MODE === "staging" && credentials.client_email !== STAGING_CALLER_EMAIL) throw unavailable();
  return credentials;
}
function unavailable() { const error = new Error("Cloud Run authentication unavailable."); error.code = "CLOUD_RUN_AUTH_UNAVAILABLE"; return error; }
function createCloudRunAuth({ env = process.env, readFile = fs.readFileSync,
  loadLibrary = () => require("google-auth-library"), now = Date.now } = {}) {
  const cache = new Map();
  return async function headers(endpoint, { signal, timeoutMs = AUTH_TIMEOUT_MS } = {}) {
    const mode = env.CLOUD_RUN_AUTH_MODE;
    if (!mode && env.WMO_DEPLOYMENT_MODE !== "staging") return {};
    if (mode !== "iam") throw unavailable();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    let timer;
    const work = async () => {
      const audience = new URL(env.CLOUD_RUN_AUDIENCE), target = new URL(endpoint);
      if (audience.protocol !== "https:" || !audience.hostname.endsWith(".run.app")
          || audience.username || audience.password || audience.search || audience.hash
          || audience.pathname !== "/" || audience.port
          || target.origin !== audience.origin || target.username || target.password || target.search || target.hash)
        throw unavailable();
      const file = env.CLOUD_RUN_CALLER_CREDENTIALS_FILE;
      if (!file || !path.isAbsolute(file)) throw unavailable();
      const relative = path.relative(path.resolve(__dirname, ".."), path.resolve(file));
      if (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) throw unavailable();
      const cached = cache.get(audience.origin);
      if (cached && cached.expires > now() + 60000) return { Authorization: "Bearer " + cached.token };
      const raw = readFile(file, "utf8");
      const credentials = parseCallerCredentials(raw, env);
      // Dedicated caller only: never implicitly reuse Vision credentials or metadata-server ADC.
      const { JWT } = loadLibrary();
      const client = new JWT({ email: credentials.client_email, key: credentials.private_key, keyId: credentials.private_key_id });
      const request = client.transporter.request.bind(client.transporter);
      client.transporter.request = options => request({ ...options, timeout: Math.min(AUTH_TIMEOUT_MS, timeoutMs),
        retry: false, retryConfig: { retry: 0 }, signal: controller.signal });
      const token = await client.fetchIdToken(audience.origin);
      if (controller.signal.aborted || typeof token !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw unavailable();
      // Decode for cache/audience sanity only. Cloud Run verifies Google's signature.
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      if (payload.aud !== audience.origin || !Number.isFinite(payload.exp) || payload.exp * 1000 <= now() + 60000
          || !["https://accounts.google.com", "accounts.google.com"].includes(payload.iss)) throw unavailable();
      cache.set(audience.origin, { token, expires: payload.exp * 1000 });
      return { Authorization: "Bearer " + token };
    };
    try {
      if (signal?.aborted || timeoutMs <= 0) throw unavailable();
      signal?.addEventListener("abort", cancel, { once: true });
      const aborted = new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(unavailable()), { once: true }));
      timer = setTimeout(cancel, Math.min(AUTH_TIMEOUT_MS, timeoutMs));
      return await Promise.race([work(), aborted]);
    } catch (_) { throw unavailable(); }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  };
}
module.exports = { AUTH_TIMEOUT_MS, STAGING_CALLER_EMAIL, parseCallerCredentials, createCloudRunAuth, invocationHeaders: createCloudRunAuth() };
