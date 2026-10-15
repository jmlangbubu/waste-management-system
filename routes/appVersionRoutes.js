const express = require("express");
const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_PATH = path.join(__dirname, "..", "data", "android-app-version.json");
const DOWNLOAD_PAGE_URL = "https://wastegensan.com/download/app";
const PACKAGE_NAME = "com.example.aiwastemanagementsystem";

function approvedApkUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.port || url.search || url.hash) return false;

    if (url.hostname === "github.com") {
      return /^\/jmlangbubu\/WMO-Mobile-Releases\/releases\/download\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.apk$/i
        .test(url.pathname);
    }

    return url.hostname === "wastegensan.com" &&
      /^\/downloads\/[A-Za-z0-9._-]+\.apk$/i.test(url.pathname);
  } catch (_) {
    return false;
  }
}

function validateAppVersionManifest(input) {
  const manifest = typeof input === "string" ? JSON.parse(input) : input;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Invalid app version manifest");
  }

  const { latestVersionCode, minimumSupportedVersionCode } = manifest;
  if (!Number.isSafeInteger(latestVersionCode) || latestVersionCode <= 0 ||
      !Number.isSafeInteger(minimumSupportedVersionCode) ||
      minimumSupportedVersionCode <= 0 ||
      minimumSupportedVersionCode > latestVersionCode) {
    throw new Error("Invalid app version codes");
  }

  const latestVersionName = manifest.latestVersionName;
  if (typeof latestVersionName !== "string" || !latestVersionName.trim() ||
      latestVersionName.length > 64) {
    throw new Error("Invalid app version name");
  }

  if (manifest.downloadUrl !== DOWNLOAD_PAGE_URL) {
    throw new Error("Invalid app download page URL");
  }

  if (manifest.apkUrl !== null && !approvedApkUrl(manifest.apkUrl)) {
    throw new Error("Invalid APK URL");
  }

  if (!Array.isArray(manifest.releaseNotes) ||
      manifest.releaseNotes.length < 1 || manifest.releaseNotes.length > 12 ||
      manifest.releaseNotes.some((note) =>
        typeof note !== "string" || !note.trim() || note.length > 240)) {
    throw new Error("Invalid release notes");
  }

  if (typeof manifest.publishedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(manifest.publishedAt) ||
      Number.isNaN(Date.parse(manifest.publishedAt))) {
    throw new Error("Invalid publication date");
  }

  const apk = manifest.apk;
  if (!apk || typeof apk !== "object" || Array.isArray(apk) ||
      apk.packageName !== PACKAGE_NAME ||
      !Number.isSafeInteger(apk.fileSizeBytes) || apk.fileSizeBytes <= 0 ||
      typeof apk.sha256 !== "string" || !/^[A-Fa-f0-9]{64}$/.test(apk.sha256)) {
    throw new Error("Invalid APK metadata");
  }

  // Return only the public, documented fields, even if a future manifest grows.
  return {
    latestVersionCode,
    latestVersionName: latestVersionName.trim(),
    minimumSupportedVersionCode,
    downloadUrl: DOWNLOAD_PAGE_URL,
    apkUrl: manifest.apkUrl,
    releaseNotes: manifest.releaseNotes.map((note) => note.trim()),
    publishedAt: manifest.publishedAt,
    apk: {
      packageName: PACKAGE_NAME,
      fileSizeBytes: apk.fileSizeBytes,
      sha256: apk.sha256.toUpperCase()
    }
  };
}

function createAppVersionRouter({ readManifest = () =>
  fs.readFileSync(MANIFEST_PATH, "utf8") } = {}) {
  const router = express.Router();

  router.get("/", (_req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      return res.status(200).json(validateAppVersionManifest(readManifest()));
    } catch (error) {
      console.error("[AppVersion] Release metadata unavailable:", error.code || "INVALID_MANIFEST");
      return res.status(503).json({
        message: "Version information is temporarily unavailable."
      });
    }
  });

  return router;
}

module.exports = {
  approvedApkUrl,
  validateAppVersionManifest,
  createAppVersionRouter
};
