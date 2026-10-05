const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const page = fs.readFileSync(path.join(root, "frontend", "download-app.html"), "utf8");
const landing = fs.readFileSync(path.join(root, "frontend", "index.html"), "utf8");
const server = fs.readFileSync(path.join(root, "server", "server.js"), "utf8");
const pageScript = fs.readFileSync(path.join(root, "frontend", "js", "download-app.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "data", "android-app-version.json"), "utf8"));

function renderWith(response) {
  const nodes = new Map();
  let ready;
  let fetchCount = 0;
  function node(id) {
    if (!nodes.has(id)) {
      nodes.set(id, {
        textContent: "", className: "", hidden: false, href: undefined, children: [],
        removeAttribute(name) { if (name === "href") this.href = undefined; },
        replaceChildren() { this.children = []; },
        appendChild(child) { this.children.push(child); }
      });
    }
    return nodes.get(id);
  }
  const document = {
    getElementById: node,
    createElement: () => ({ textContent: "" }),
    addEventListener: (name, callback) => { if (name === "DOMContentLoaded") ready = callback; }
  };
  const fetch = async (url, options) => {
    fetchCount += 1;
    assert.equal(url, "/api/app-version");
    assert.equal(options.cache, "no-store");
    if (response instanceof Error) throw response;
    return response;
  };
  vm.runInNewContext(pageScript, { document, fetch, URL, Intl, Number, Error });
  return { nodes, ready: async () => {
    await ready();
    assert.equal(fetchCount, 1, "both download actions share one version request");
  } };
}

function assertDownloadActions(nodes, apkUrl, pendingLabel) {
  for (const [linkId, pendingId] of [
    ["downloadLink", "downloadPending"],
    ["downloadLinkFinal", "downloadPendingFinal"]
  ]) {
    assert.equal(nodes.get(linkId).href, apkUrl || undefined);
    assert.equal(nodes.get(linkId).hidden, !apkUrl);
    assert.equal(nodes.get(pendingId).hidden, Boolean(apkUrl));
    if (pendingLabel) assert.equal(nodes.get(pendingId).textContent, pendingLabel);
  }
}

test("download page and landing entry are wired to public routes only", () => {
  assert.match(server, /app\.get\("\/download\/app"[\s\S]*?download-app\.html/);
  assert.match(server, /app\.use\("\/api\/app-version", createAppVersionRouter\(\)\)/);
  assert.match(page, /WMO MOBILE APP/);
  assert.match(page.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "),
    /Official Android Application/);
  assert.match(page, /Release Notes/);
  assert.match(page, /Installation Guide/);
  assert.match(page, /id="downloadPending"[^>]*disabled/);
  assert.match(page, /id="downloadPendingFinal"[^>]*disabled/);
  for (const id of ["downloadLink", "downloadLinkFinal", "heroVersionName"]) {
    assert.equal((page.match(new RegExp(`id="${id}"`, "g")) || []).length, 1);
  }
  assert.match(landing, /href="\/download\/app"[^>]*aria-label="Download WMO Mobile App for Android"/);
  assert.doesNotMatch(landing, /href="[^"]+\.apk"/);
  assert.doesNotMatch(landing, /playstoreModal|Coming Soon on Google Play/);
  assert.doesNotMatch(page, /password|keystore|\.jks|private.key/i);
});

test("null APK URL keeps download disabled and shows honest release metadata", async () => {
  const { nodes, ready } = renderWith({
    ok: true, json: async () => ({ ...manifest, apkUrl: null })
  });
  await ready();
  assert.equal(nodes.get("versionName").textContent, "1.0.3");
  assert.equal(nodes.get("heroVersionName").textContent, "1.0.3");
  assert.equal(nodes.get("fileVersion").textContent, "1.0.3 (code 4)");
  assert.equal(nodes.get("fileSize").textContent, "62,505,903 bytes");
  assert.equal(nodes.get("checksum").textContent, manifest.apk.sha256);
  assert.equal(nodes.get("downloadPending").hidden, false);
  assert.equal(nodes.get("downloadPending").textContent, "APK Publishing in Progress");
  assert.equal(nodes.get("downloadLink").hidden, true);
  assert.equal(nodes.get("downloadLink").href, undefined);
  assertDownloadActions(nodes, null, "APK Publishing in Progress");
  assert.equal(nodes.get("releaseNotes").children.length, manifest.releaseNotes.length);
});

test("API failure clears version details and leaves no download link", async () => {
  const { nodes, ready } = renderWith(new Error("offline"));
  await ready();
  assert.equal(nodes.get("versionName").textContent, "Unavailable");
  assert.equal(nodes.get("heroVersionName").textContent, "Unavailable");
  assert.equal(nodes.get("downloadMessage").textContent,
    "Version information is temporarily unavailable.");
  assert.equal(nodes.get("downloadLink").hidden, true);
  assert.equal(nodes.get("downloadLink").href, undefined);
  assertDownloadActions(nodes, null, "Download unavailable");
});

test("verified approved asset URL activates the link but unsafe URLs never do", async () => {
  const approved = manifest.apkUrl;
  const good = renderWith({ ok: true, json: async () => manifest });
  await good.ready();
  assert.equal(good.nodes.get("downloadLink").href, approved);
  assert.equal(good.nodes.get("downloadLink").hidden, false);
  assert.equal(good.nodes.get("downloadPending").hidden, true);
  assertDownloadActions(good.nodes, approved);

  const bad = renderWith({ ok: true, json: async () => ({
    ...manifest, apkUrl: "https://evil.example/app.apk"
  }) });
  await bad.ready();
  assert.equal(bad.nodes.get("downloadLink").hidden, true);
  assert.equal(bad.nodes.get("downloadLink").href, undefined);
  assert.equal(bad.nodes.get("downloadPending").hidden, false);
  assertDownloadActions(bad.nodes, null, "Download unavailable");
});
