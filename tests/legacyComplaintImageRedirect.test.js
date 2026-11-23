"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const express = require("express");
const { createLegacyComplaintImageRedirect } = require("../middleware/legacyComplaintImageRedirect");

const CONFIG = "WMO_LEGACY_COMPLAINT_IMAGE_MAP_JSON";
const CLOUD = "unit-test-cloud";
// Synthetic names and content only. No private image map is a test fixture.
const pairs = Array.from({ length: 38 }, (_, i) => [
  `complaint-fixture-${String(i + 1).padStart(2, "0")}.jpg`,
  `https://res.cloudinary.com/${CLOUD}/image/upload/v123/wmo/legacy-complaints/unit-migration/`
    + crypto.createHash("sha256").update(`synthetic-image-${i % 16}`).digest("hex") + ".jpg"
]);
const validEnv = () => ({ [CONFIG]: JSON.stringify(pairs), CLOUDINARY_CLOUD_NAME: CLOUD });

function request(server, resource, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path: resource, method }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(3000, () => req.destroy(new Error("Local request timed out.")));
    req.on("error", reject);
    req.end();
  });
}

async function productionUploads(t, env = validEnv(), { local = false, absent = false, localContent = "existing-local-image" } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmo-legacy-images-test-"));
  const uploads = path.join(directory, "uploads"), frontend = path.join(directory, "frontend");
  fs.mkdirSync(frontend);
  if (!absent) fs.mkdirSync(path.join(uploads, "complaints"), { recursive: true });
  if (local) fs.writeFileSync(path.join(uploads, "complaints", pairs[0][0]), localContent);
  if (!absent) fs.writeFileSync(path.join(uploads, "unrelated.txt"), "unrelated-upload");
  fs.writeFileSync(path.join(frontend, "unrelated.txt"), "unrelated-frontend");
  t.after(() => {
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("wmo-legacy-images-test-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  const app = express();
  const serverFile = path.resolve(__dirname, "../server/server.js");
  const source = fs.readFileSync(serverFile, "utf8").replace(/\r\n?/g, "\n");
  const start = source.indexOf("/* =========================\n   STATIC FILES");
  const end = source.indexOf("/* =========================\n   BASIC TEST ROUTES", start);
  assert.ok(start >= 0 && end > start, "Production static-routing section must be identifiable.");
  // Execute the actual production mount section, without database/startup services.
  vm.runInNewContext(source.slice(start, end), {
    app, express, UPLOADS_DIR: uploads, FRONTEND_DIR: frontend,
    require: createRequire(serverFile), process: { env }
  }, { filename: "production-static-mounts.js" });
  app.use((_req, res) => res.status(404).end());
  const server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server;
}

function assertInvalid(env) {
  assert.throws(() => createLegacyComplaintImageRedirect({ env }), error => {
    assert.equal(error.code, "LEGACY_COMPLAINT_IMAGE_CONFIGURATION_INVALID");
    assert.equal(error.message, "Legacy complaint image configuration is invalid.");
    assert.equal(error.cause, undefined);
    return true;
  });
}

test("production startup preserves all 38 mappings when the uploads directory is absent", async t => {
  const server = await productionUploads(t, validEnv(), { absent: true });
  for (const [filename, destination] of pairs) {
    const response = await request(server, `/uploads/complaints/${filename}`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, destination);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["access-control-allow-origin"], "*");
  }
});

test("HEAD redirects without a response body", async t => {
  const server = await productionUploads(t);
  const response = await request(server, `/uploads/complaints/${pairs[0][0]}`, "HEAD");
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, pairs[0][1]);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.length, 0);
});

test("existing local GET and HEAD retain static priority, bytes and cache policy", async t => {
  const server = await productionUploads(t, validEnv(), { local: true });
  for (const method of ["GET", "HEAD"]) {
    const response = await request(server, `/uploads/complaints/${pairs[0][0]}?t=123`, method);
    assert.equal(response.status, 200);
    assert.equal(response.headers.location, undefined);
    assert.equal(response.headers["cache-control"], "public, max-age=0");
    assert.equal(response.headers["access-control-allow-origin"], "*");
    assert.equal(response.body.toString(), method === "HEAD" ? "" : "existing-local-image");
  }
});

test("an existing zero-byte original retains its current static response without substitution", async t => {
  const server = await productionUploads(t, validEnv(), { local: true, localContent: Buffer.alloc(0) });
  for (const method of ["GET", "HEAD"]) {
    const response = await request(server, `/uploads/complaints/${pairs[0][0]}`, method);
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-length"], "0");
    assert.equal(response.headers.location, undefined);
    assert.equal(response.body.length, 0);
  }
});

test("a legacy jpg filename may map to its verified PNG asset without a format conversion", async t => {
  const changed = pairs.map(pair => [...pair]); changed[0][1] = changed[0][1].replace(/\.jpg$/, ".png");
  const server = await productionUploads(t, { ...validEnv(), [CONFIG]: JSON.stringify(changed) });
  const response = await request(server, `/uploads/complaints/${pairs[0][0]}`);
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, changed[0][1]);
});

test("cache-busters and redirect-shaped queries cannot change the fixed destination", async t => {
  const server = await productionUploads(t);
  for (const query of ["?t=123", "?url=https%3A%2F%2Fevil.invalid", "?t=1&next=//evil.invalid"]) {
    const response = await request(server, `/uploads/complaints/${pairs[0][0]}${query}`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, pairs[0][1]);
  }
});

test("normal filename percent encoding resolves only its exact approved name", async t => {
  const server = await productionUploads(t);
  const response = await request(server, `/uploads/complaints/%63${pairs[0][0].slice(1)}`);
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, pairs[0][1]);
});

test("unknown, case-changed and malicious names never redirect", async t => {
  const server = await productionUploads(t, validEnv(), { absent: true });
  for (const name of ["missing.jpg", pairs[0][0].toUpperCase(), "__proto__", "constructor", "toString",
    "..", ".hidden", "../secret.jpg", "%2e%2e%2fsecret.jpg", "%2F" + pairs[0][0],
    "%5C" + pairs[0][0], "%252f" + pairs[0][0], pairs[0][0] + "%00", pairs[0][0] + "%23fragment",
    pairs[0][0] + "/extra", "/" + pairs[0][0], "%EF%BC%8F" + pairs[0][0]]) {
    const response = await request(server, `/uploads/complaints/${name}`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.location, undefined);
  }
});

test("malformed percent encoding is rejected without reflecting input", async t => {
  const server = await productionUploads(t);
  for (const name of ["%", "%ZZ", "%C0%AF", "%E0%A4%A"]) {
    const response = await request(server, `/uploads/complaints/${name}`);
    assert.equal(response.status, 400);
    assert.equal(response.headers.location, undefined);
    assert.equal(response.body.length, 0);
  }
});

test("non-GET/HEAD requests and unrelated static paths remain unchanged", async t => {
  const server = await productionUploads(t);
  const post = await request(server, `/uploads/complaints/${pairs[0][0]}`, "POST");
  assert.equal(post.status, 404);
  assert.equal(post.headers.location, undefined);
  for (const [resource, body] of [["/uploads/unrelated.txt", "unrelated-upload"], ["/unrelated.txt", "unrelated-frontend"]]) {
    const response = await request(server, resource);
    assert.equal(response.status, 200);
    assert.equal(response.body.toString(), body);
    assert.equal(response.headers.location, undefined);
  }
});

test("missing or blank configuration preserves existing static behavior without reading Cloudinary configuration", async t => {
  for (const raw of [undefined, "", " \n\t"]) {
    const env = raw === undefined ? {} : { [CONFIG]: raw };
    Object.defineProperty(env, "CLOUDINARY_CLOUD_NAME", { get() { throw new Error("Must not read disabled configuration."); } });
    const server = await productionUploads(t, env, { local: true });
    assert.equal((await request(server, `/uploads/complaints/${pairs[0][0]}`)).status, 200);
    assert.equal((await request(server, `/uploads/complaints/${pairs[1][0]}`)).status, 404);
  }
});

test("configured mapping is a startup snapshot and never reads API credentials", async t => {
  const env = validEnv();
  for (const key of ["CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]) {
    Object.defineProperty(env, key, { get() { throw new Error("Credential access is forbidden."); } });
  }
  const server = await productionUploads(t, env);
  env[CONFIG] = "broken-after-startup";
  env.CLOUDINARY_CLOUD_NAME = "other-account";
  assert.equal((await request(server, `/uploads/complaints/${pairs[0][0]}`)).headers.location, pairs[0][1]);
});

for (const [label, raw] of [
  ["invalid JSON", "{private-secret-placeholder"], ["null", "null"], ["object", "{}"], ["empty array", "[]"],
  ["partial mapping", JSON.stringify(pairs.slice(1))], ["extra mapping", JSON.stringify([...pairs, ["extra.jpg", pairs[0][1]]])],
  ["non-string value", 42], ["oversized input", " ".repeat(65536) + "[]"]
]) test(`invalid private configuration fails closed: ${label}`, () => assertInvalid({ ...validEnv(), [CONFIG]: raw }));

for (const [label, replacement] of [
  ["duplicate filename", pairs[1]], ["traversal key", ["../escape.jpg", pairs[0][1]]],
  ["encoded separator key", ["bad%2fname.jpg", pairs[0][1]]], ["extra fields", [...pairs[0], "extra"]],
  ["object entry", { filename: pairs[0][0], secureUrl: pairs[0][1] }], ["missing URL", [pairs[0][0], null]]
]) test(`invalid mapping entry fails closed: ${label}`, () => {
  const changed = pairs.map(pair => [...pair]); changed[0] = replacement;
  assertInvalid({ ...validEnv(), [CONFIG]: JSON.stringify(changed) });
});

for (const cloudName of [undefined, "", "wrong/account", " account", "account ", "account.example"]) {
  test(`missing or invalid approved Cloudinary account fails closed: ${JSON.stringify(cloudName)}`, () =>
    assertInvalid({ ...validEnv(), CLOUDINARY_CLOUD_NAME: cloudName }));
}

const original = pairs[0][1];
const invalidDestinations = [
  ["HTTP", original.replace("https:", "http:")], ["other host", original.replace("res.cloudinary.com", "evil.invalid")],
  ["host suffix", original.replace("res.cloudinary.com", "res.cloudinary.com.evil.invalid")],
  ["userinfo", original.replace("https://", "https://user@")],
  ["explicit default port", original.replace(".com/", ".com:443/")], ["other port", original.replace(".com/", ".com:444/")],
  ["backslash", original.replace(".com/", ".com\\")], ["case-normalized host", original.replace("res.cloudinary.com", "RES.CLOUDINARY.COM")],
  ["wrong account", original.replace(CLOUD, "other-account")], ["query", original + "?next=https://evil.invalid"],
  ["fragment", original + "#fragment"], ["leading whitespace", " " + original], ["trailing newline", original + "\n"],
  ["dot segment", original.replace("/image/", "/../" + CLOUD + "/image/")],
  ["encoded segment", original.replace("/image/", "/%69mage/")], ["double slash", original.replace("/image/", "//image/")],
  ["unversioned", original.replace("v123/", "")], ["transformed", original.replace("v123/", "q_auto/v123/")],
  ["wrong delivery type", original.replace("/upload/", "/authenticated/")], ["wrong resource type", original.replace("/image/", "/raw/")],
  ["unrelated asset namespace", original.replace("/legacy-complaints/", "/unrelated/")]
];
for (const [label, destination] of invalidDestinations) test(`unsafe Cloudinary destination fails closed: ${label}`, () => {
  const changed = pairs.map(pair => [...pair]); changed[0][1] = destination;
  assertInvalid({ ...validEnv(), [CONFIG]: JSON.stringify(changed) });
});

test("invalid configured mapping prevents the actual production static mount section from starting", async t => {
  await assert.rejects(productionUploads(t, { ...validEnv(), [CONFIG]: "not-json" }), {
    code: "LEGACY_COMPLAINT_IMAGE_CONFIGURATION_INVALID"
  });
});

const EMPTY_FILENAME_CONFIG = "WMO_LEGACY_COMPLAINT_EMPTY_FILENAME";
const EMPTY_SHA256 = crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex");
const emptyOriginal = () => ({ kind: "empty", bytes: 0, sha256: EMPTY_SHA256 });
const exceptionPairs = () => pairs.map(([filename], i) => [filename,
  i === 0 ? emptyOriginal() : pairs[(i - 1) % 15][1]
]);
const exceptionEnv = () => ({ ...validEnv(), [CONFIG]: JSON.stringify(exceptionPairs()),
  [EMPTY_FILENAME_CONFIG]: pairs[0][0] });

test("approved absent empty filename returns zero-byte HTTP 200 for GET and HEAD", async t => {
  const server = await productionUploads(t, exceptionEnv(), { absent: true });
  for (const method of ["GET", "HEAD"]) {
    const response = await request(server, `/uploads/complaints/${pairs[0][0]}?t=123`, method);
    assert.equal(response.status, 200);
    assert.equal(response.body.length, 0);
    assert.equal(response.headers["content-length"], "0");
    assert.equal(response.headers["content-type"], "image/jpeg");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["access-control-allow-origin"], "*");
    assert.equal(response.headers.location, undefined);
  }
});

test("all remaining 37 names still GET and HEAD redirect to exactly 15 fixed assets", async t => {
  const approved = exceptionPairs();
  assert.equal(new Set(approved.slice(1).map(pair => pair[1])).size, 15);
  const server = await productionUploads(t, exceptionEnv(), { absent: true });
  for (const [filename, destination] of approved.slice(1)) {
    for (const method of ["GET", "HEAD"]) {
      const response = await request(server, `/uploads/complaints/${filename}`, method);
      assert.equal(response.status, 302);
      assert.equal(response.headers.location, destination);
      assert.equal(response.headers["cache-control"], "no-store");
      if (method === "HEAD") assert.equal(response.body.length, 0);
    }
  }
});

test("static files retain priority over the empty exception whether empty or nonempty", async t => {
  for (const localContent of [Buffer.alloc(0), Buffer.from("existing-file-still-wins")]) {
    const server = await productionUploads(t, exceptionEnv(), { local: true, localContent });
    for (const method of ["GET", "HEAD"]) {
      const response = await request(server, `/uploads/complaints/${pairs[0][0]}`, method);
      assert.equal(response.status, 200);
      assert.equal(response.headers["content-length"], String(localContent.length));
      assert.equal(response.headers["cache-control"], "public, max-age=0");
      assert.equal(response.headers.location, undefined);
      assert.deepEqual(response.body, method === "HEAD" ? Buffer.alloc(0) : localContent);
    }
  }
});

test("empty exception remains exact and rejects aliases, traversal and encoded separators", async t => {
  const server = await productionUploads(t, exceptionEnv(), { absent: true });
  for (const name of [pairs[0][0].toUpperCase(), pairs[0][0] + ".extra", "missing-empty.jpg",
    "__proto__", "../" + pairs[0][0], "%2f" + pairs[0][0], "%5c" + pairs[0][0],
    "%252f" + pairs[0][0], pairs[0][0] + "%00", "/" + pairs[0][0]]) {
    const response = await request(server, `/uploads/complaints/${name}`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.location, undefined);
  }
});

test("queries cannot change the empty response or turn it into a redirect", async t => {
  const server = await productionUploads(t, exceptionEnv(), { absent: true });
  const response = await request(server, `/uploads/complaints/${pairs[0][0]}?url=https://evil.invalid&t=1`);
  assert.equal(response.status, 200);
  assert.equal(response.body.length, 0);
  assert.equal(response.headers["content-length"], "0");
  assert.equal(response.headers.location, undefined);
});

test("empty exception does not handle POST, PUT or DELETE", async t => {
  const server = await productionUploads(t, exceptionEnv(), { absent: true });
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await request(server, `/uploads/complaints/${pairs[0][0]}`, method);
    assert.equal(response.status, 404);
    assert.equal(response.headers.location, undefined);
  }
});

test("approved empty filename and response are immutable after startup", async t => {
  const env = exceptionEnv();
  const server = await productionUploads(t, env, { absent: true });
  env[EMPTY_FILENAME_CONFIG] = pairs[1][0];
  env[CONFIG] = "changed-after-startup";
  assert.equal((await request(server, `/uploads/complaints/${pairs[0][0]}`)).status, 200);
  assert.equal((await request(server, `/uploads/complaints/${pairs[1][0]}`)).status, 302);
});

for (const [label, descriptor] of [
  ["nonzero bytes", { ...emptyOriginal(), bytes: 1 }],
  ["string byte count", { ...emptyOriginal(), bytes: "0" }],
  ["wrong hash", { ...emptyOriginal(), sha256: "0".repeat(64) }],
  ["missing hash", { kind: "empty", bytes: 0 }],
  ["wrong kind", { ...emptyOriginal(), kind: "redirect" }],
  ["extra URL", { ...emptyOriginal(), url: pairs[0][1] }],
  ["extra response status", { ...emptyOriginal(), status: 302 }],
  ["array descriptor", ["empty", 0, EMPTY_SHA256]],
  ["null descriptor", null]
]) test(`invalid empty descriptor fails closed: ${label}`, () => {
  const changed = exceptionPairs(); changed[0][1] = descriptor;
  assertInvalid({ ...exceptionEnv(), [CONFIG]: JSON.stringify(changed) });
});

test("empty descriptor requires a separately approved private filename", () => {
  const env = exceptionEnv(); delete env[EMPTY_FILENAME_CONFIG];
  assertInvalid(env);
});

test("a different approved filename cannot activate the empty exception", () => {
  assertInvalid({ ...exceptionEnv(), [EMPTY_FILENAME_CONFIG]: pairs[1][0] });
  assertInvalid({ ...exceptionEnv(), [EMPTY_FILENAME_CONFIG]: pairs[0][0].toUpperCase() });
});

test("invalid approved empty filenames fail closed", () => {
  for (const name of ["../empty.jpg", "bad%2fname.jpg", " empty.jpg", pairs[0][0] + "\0"]) {
    assertInvalid({ ...exceptionEnv(), [EMPTY_FILENAME_CONFIG]: name });
  }
});

test("an approved empty filename cannot silently have a normal URL instead", () => {
  assertInvalid({ ...validEnv(), [EMPTY_FILENAME_CONFIG]: pairs[0][0] });
});

test("multiple empty responses are rejected", () => {
  const changed = exceptionPairs(); changed[1][1] = emptyOriginal();
  assertInvalid({ ...exceptionEnv(), [CONFIG]: JSON.stringify(changed) });
});

test("the exception requires 37 redirects covering exactly 15 asset URLs", () => {
  for (const count of [14, 16]) {
    const changed = exceptionPairs();
    for (let i = 1; i < changed.length; i++) changed[i][1] = pairs[(i - 1) % count][1];
    assertInvalid({ ...exceptionEnv(), [CONFIG]: JSON.stringify(changed) });
  }
});
