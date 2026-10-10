const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../frontend/js/admin/admin-tracking.js"), "utf8");
const helper = source.slice(0, source.indexOf("function initializeTruckMap()"));

function selectLayer(hostname, sessionKey, runtimeKey, denied = false) {
  let storageReads = 0;
  const window = {
    location: { hostname },
    APP_CONFIG: { CARTO_BASEMAP_KEY: runtimeKey },
    get sessionStorage() {
      storageReads++;
      if (denied) throw new Error("Storage unavailable");
      return { getItem(name) {
        assert.equal(name, "wmo_carto_basemap_key");
        return sessionKey;
      } };
    }
  };
  const layer = vm.runInNewContext(`${helper}\ncreateTrackingBasemapLayer();`, {
    window,
    L: { tileLayer: (url, options) => ({ url, options }) }
  });
  return { ...layer, storageReads };
}

for (const hostname of ["localhost", "127.0.0.1", "::1", "[::1]", "LOCALHOST"]) {
  test(`${hostname}: local session override wins`, () => {
    const layer = selectLayer(hostname, "LOCAL_KEY", "RUNTIME_KEY");
    assert.ok(layer.url.endsWith("key=LOCAL_KEY"));
    assert.equal(layer.storageReads, 1);
  });
}

for (const hostname of ["wastegensan.com", "www.wastegensan.com", "admin.wastegensan.com", "localhost.example.com", "127.0.0.2", ""]) {
  test(`${hostname || "empty hostname"}: runtime wins without reading session storage`, () => {
    const layer = selectLayer(hostname, "STALE_KEY", "RUNTIME_KEY", true);
    assert.ok(layer.url.endsWith("key=RUNTIME_KEY"));
    assert.equal(layer.storageReads, 0);
  });
}

test("production without runtime key ignores stale session and falls back to OSM", () => {
  const layer = selectLayer("wastegensan.com", "STALE_KEY", "");
  assert.equal(layer.url, "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png");
  assert.equal(layer.storageReads, 0);
  assert.equal(layer.options.attribution, "&copy; OpenStreetMap contributors");
});

test("local denied storage still uses runtime configuration", () => {
  assert.ok(selectLayer("localhost", "LOCAL_KEY", "RUNTIME_KEY", true).url.endsWith("key=RUNTIME_KEY"));
});

test("local whitespace-only or absent session falls back to trimmed runtime key", () => {
  for (const session of ["   ", null, undefined]) {
    assert.ok(selectLayer("127.0.0.1", session, "  RUNTIME_KEY \n").url.endsWith("key=RUNTIME_KEY"));
  }
});

test("local session is trimmed and encoded without mutating stored value", () => {
  const stored = "  LOCAL /& KEY  ";
  const layer = selectLayer("localhost", stored, "RUNTIME_KEY");
  assert.ok(layer.url.endsWith(`key=${encodeURIComponent(stored.trim())}`));
  assert.equal(stored, "  LOCAL /& KEY  ");
});

test("production runtime is trimmed, including whitespace-only OSM fallback", () => {
  assert.ok(selectLayer("wastegensan.com", "STALE_KEY", "  RUNTIME_KEY  ").url.endsWith("key=RUNTIME_KEY"));
  assert.match(selectLayer("wastegensan.com", "STALE_KEY", "   ").url, /tile\.openstreetmap\.org/);
});

test("String normalization and CARTO rendering configuration remain intact", () => {
  const layer = selectLayer("wastegensan.com", "STALE_KEY", 123);
  assert.equal(layer.url, "https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png?key=123");
  assert.equal(layer.options.maxZoom, 20);
  assert.equal(layer.options.attribution, "&copy; OpenStreetMap contributors &copy; CARTO");
  assert.equal((source.match(/createTrackingBasemapLayer\(\)\.addTo\(/g) || []).length, 2);
  assert.doesNotMatch(helper, /console\.|setItem|removeItem/);
});
