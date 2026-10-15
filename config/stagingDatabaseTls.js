"use strict";
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const tls = require("node:tls");
const { X509Certificate } = require("node:crypto");

function invalid() {
  const error = new Error("Staging database TLS configuration is invalid; a trusted external CA file and verifiable DNS endpoint are required.");
  error.code = "STAGING_DB_TLS_CONFIGURATION_INVALID";
  return error;
}

// No production inputs or connection behavior are changed.
function stagingTlsOptions(policy, {
  env = process.env, readFile = fs.readFileSync, realpath = fs.realpathSync,
  certificate = pem => new X509Certificate(pem),
  secureContext = tls.createSecureContext, now = Date.now
} = {}) {
  if (env.STAGING_DATABASE_TRANSPORT === "railway_private")
    return require("./railwayStaging").privateDatabaseOptions(policy, env);
  if (!policy.staging) return {};
  if (env.STAGING_DATABASE_TRANSPORT !== undefined && env.STAGING_DATABASE_TRANSPORT !== "external_tls")
    throw invalid();
  try {
    const url = new URL(policy.uri);
    // mysql2 parses URL query parameters as driver options. Do not permit TLS,
    // debug, socketPath, or transport overrides through the staging URL.
    if (url.protocol !== "mysql:" || url.search || url.hash
        || !url.hostname || net.isIP(url.hostname.replace(/^\[|\]$/g, ""))
        || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(url.hostname)
        || url.hostname.split(".").some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))
        || env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw invalid();
    const file = env.STAGING_DATABASE_TLS_CA_FILE;
    if (typeof file !== "string" || !path.isAbsolute(file)) throw invalid();
    const app = realpath(path.resolve(__dirname, ".."));
    const resolvedFile = realpath(file);
    const relative = path.relative(app, resolvedFile);
    if (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) throw invalid();
    const ca = readFile(resolvedFile, "utf8");
    if (typeof ca !== "string" || Buffer.byteLength(ca) > 65536) throw invalid();
    const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!certificates?.length || ca.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()) throw invalid();
    for (const pem of certificates) {
      const cert = certificate(pem);
      if (!cert.ca || !Number.isFinite(Date.parse(cert.validFrom))
          || !Number.isFinite(Date.parse(cert.validTo))
          || Date.parse(cert.validFrom) > now() || Date.parse(cert.validTo) <= now()) throw invalid();
    }
    const ssl = { ca, rejectUnauthorized: true, verifyIdentity: true, minVersion: "TLSv1.2" };
    // Validate the PEM/trust context before mysql2 creates either pool.
    secureContext(ssl);
    return { ssl };
  } catch (_) {
    // Never retain certificate, URL, filesystem, or credential-bearing causes.
    throw invalid();
  }
}

module.exports = { stagingTlsOptions };
