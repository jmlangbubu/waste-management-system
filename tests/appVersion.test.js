const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const {
  approvedApkUrl,
  createAppVersionRouter,
  validateAppVersionManifest
} = require("../routes/appVersionRoutes");

const manifestPath = path.join(__dirname, "..", "data", "android-app-version.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

async function requestVersion(router) {
  const app = express();
  app.use("/api/app-version", router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fetch(`http://127.0.0.1:${server.address().port}/api/app-version`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("public version endpoint returns only approved v1.0.3 metadata without login", async () => {
  const response = await requestVersion(createAppVersionRouter());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body, manifest);
  assert.equal(body.latestVersionCode, 4);
  assert.equal(body.latestVersionName, "1.0.3");
  assert.equal(body.minimumSupportedVersionCode, 1);
  assert.equal(body.apkUrl,
    "https://github.com/jmlangbubu/WMO-Mobile-Releases/releases/download/v1.0.3/WMO-Mobile-v1.0.3.apk");
  assert.equal(body.apkUrl, manifest.apkUrl);
  assert.match(body.downloadUrl, /^https:\/\/wastegensan\.com\//);
  assert.equal(body.apk.fileSizeBytes, 62505903);
  assert.match(body.apk.sha256, /^[A-F0-9]{64}$/);
  assert.deepEqual(Object.keys(body).sort(), [
    "apk", "apkUrl", "downloadUrl", "latestVersionCode", "latestVersionName",
    "minimumSupportedVersionCode", "publishedAt", "releaseNotes"
  ]);
});

test("manifest validation rejects unsupported versions and unsafe URLs", () => {
  for (const bad of [
    { latestVersionCode: 0 },
    { minimumSupportedVersionCode: 0 },
    { minimumSupportedVersionCode: manifest.latestVersionCode + 1 },
    { latestVersionName: " " },
    { downloadUrl: "http://wastegensan.com/download/app" },
    { downloadUrl: "https://other.example/download/app" },
    { apkUrl: "https://evil.example/app.apk" },
    { apkUrl: "javascript:alert(1)" },
    { apk: { ...manifest.apk, fileSizeBytes: 0 } },
    { apk: { ...manifest.apk, sha256: "invalid" } }
  ]) {
    assert.throws(() => validateAppVersionManifest({ ...manifest, ...bad }));
  }
});

test("only constrained HTTPS APK locations may become active", () => {
  assert.equal(approvedApkUrl(manifest.apkUrl), true);
  assert.equal(validateAppVersionManifest({ ...manifest, apkUrl: null }).apkUrl, null);
  assert.equal(approvedApkUrl("https://wastegensan.com/downloads/wmo-v1.0.1.apk"), true);
  for (const url of [
    "http://wastegensan.com/downloads/app.apk",
    "https://wastegensan.com.evil.example/downloads/app.apk",
    "https://wastegensan.com/downloads/app.apk?token=secret",
    "https://github.com/another-owner/repo/releases/download/v1/app.apk",
    "https://github.com/jmlangbubu/other-repo/releases/download/v1/app.apk",
    "https://github.com/jmlangbubu/AIWasteManagementSystem-Android/releases/download/v1.0.1/app.apk",
    "https://wastegensan.com/download/app"
  ]) {
    assert.equal(approvedApkUrl(url), false, url);
  }
});

test("extra manifest data is not exposed publicly", () => {
  const safe = validateAppVersionManifest({
    ...manifest,
    signingPassword: "must-not-leak",
    keystorePath: "C:/private/wmo.jks",
    apk: { ...manifest.apk, privateKey: "must-not-leak" }
  });
  assert.equal(JSON.stringify(safe).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(safe).includes("private"), false);
});

test("malformed manifest produces safe 503 without leaking paths or errors", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await requestVersion(createAppVersionRouter({
      readManifest: () => '{"apkUrl":"https://evil.example/app.apk"}'
    }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      message: "Version information is temporarily unavailable."
    });
  } finally {
    console.error = originalError;
  }
});
