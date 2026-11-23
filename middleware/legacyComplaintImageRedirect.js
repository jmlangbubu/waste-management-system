"use strict";

const CONFIG_VARIABLE = "WMO_LEGACY_COMPLAINT_IMAGE_MAP_JSON";
const EMPTY_FILENAME_VARIABLE = "WMO_LEGACY_COMPLAINT_EMPTY_FILENAME";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EXPECTED_FILES = 38;
const MAX_CONFIG_BYTES = 64 * 1024;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const CLOUDINARY_ASSET = /^v[1-9][0-9]{0,19}\/wmo\/legacy-complaints\/[A-Za-z0-9][A-Za-z0-9_-]{0,79}\/[a-f0-9]{64}\.(?:jpg|jpeg|png|webp)$/;

function invalidConfiguration() {
  const error = new Error("Legacy complaint image configuration is invalid.");
  error.code = "LEGACY_COMPLAINT_IMAGE_CONFIGURATION_INVALID";
  return error;
}

function loadMappings(env) {
  const raw = env[CONFIG_VARIABLE];
  // Unconfigured environments keep their existing static-file behavior.
  if (raw === undefined || typeof raw === "string" && !raw.trim()) return null;
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) {
    throw invalidConfiguration();
  }

  let pairs;
  try {
    pairs = JSON.parse(raw);
  } catch (_) {
    throw invalidConfiguration();
  }
  // Pairs make duplicate filenames detectable, unlike duplicate JSON object keys.
  if (!Array.isArray(pairs) || pairs.length !== EXPECTED_FILES) throw invalidConfiguration();
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  if (typeof cloudName !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(cloudName)) {
    throw invalidConfiguration();
  }
  const prefix = `https://res.cloudinary.com/${cloudName}/image/upload/`;
  const rawEmptyFilename = env[EMPTY_FILENAME_VARIABLE];
  const approvedEmptyFilename = rawEmptyFilename === "" ? undefined : rawEmptyFilename;
  if (approvedEmptyFilename !== undefined && (typeof approvedEmptyFilename !== "string"
      || !SAFE_FILENAME.test(approvedEmptyFilename))) throw invalidConfiguration();
  const mappings = new Map();
  const assetUrls = new Set();
  let emptyEntries = 0;
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) throw invalidConfiguration();
    const [filename, destination] = pair;
    if (typeof filename !== "string" || !SAFE_FILENAME.test(filename) || mappings.has(filename)) {
      throw invalidConfiguration();
    }
    if (destination && typeof destination === "object" && !Array.isArray(destination)) {
      if (Object.keys(destination).sort().join(",") !== "bytes,kind,sha256"
          || destination.kind !== "empty" || destination.bytes !== 0 || destination.sha256 !== EMPTY_SHA256
          || filename !== approvedEmptyFilename || emptyEntries !== 0) throw invalidConfiguration();
      emptyEntries++;
      mappings.set(filename, null);
      continue;
    }
    // Validate the original string: URL parsing can erase explicit default ports,
    // backslashes and dot segments. Only canonical, versioned migration assets fit.
    if (typeof destination !== "string" || !destination.startsWith(prefix)
        || !CLOUDINARY_ASSET.test(destination.slice(prefix.length))) {
      throw invalidConfiguration();
    }
    mappings.set(filename, destination);
    assetUrls.add(destination);
  }
  if (approvedEmptyFilename !== undefined && (emptyEntries !== 1 || assetUrls.size !== 15)) {
    throw invalidConfiguration();
  }
  return mappings;
}

function createLegacyComplaintImageRedirect({ env = process.env } = {}) {
  const mappings = loadMappings(env);
  if (!mappings) return (_req, _res, next) => next();

  // Mount AFTER /uploads express.static, at /uploads/complaints only.
  // Real filenames and delivery URLs belong in private server configuration,
  // never in this module, public fixtures or a client-selected redirect target.
  return function legacyComplaintImageRedirect(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    // Express can consume an extra slash while trimming the mount path. Inspect
    // originalUrl so a malformed path cannot become an approved basename.
    const rawPath = String(req.originalUrl || req.url || "").split("?", 1)[0];
    const prefix = "/uploads/complaints/";
    if (!rawPath.startsWith(prefix)) return res.status(404).end();
    let filename;
    try {
      filename = decodeURIComponent(rawPath.slice(prefix.length));
    } catch (_) {
      return res.status(400).end();
    }
    if (!SAFE_FILENAME.test(filename) || !mappings.has(filename)) return res.status(404).end();

    // Cache-busting queries are allowed but never forwarded or used as targets.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    const destination = mappings.get(filename);
    if (destination === null) {
      // One privately approved original was already empty. Preserve its exact
      // response without manufacturing an image or a Cloudinary destination.
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Length", "0");
      return res.status(200).end();
    }
    return res.redirect(302, destination);
  };
}

module.exports = { createLegacyComplaintImageRedirect };
