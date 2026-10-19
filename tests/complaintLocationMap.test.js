const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { resolveComplaintMapDestination } = require("../services/complaintMapDestinationService");
const source = fs.readFileSync(path.join(__dirname, "../frontend/js/admin/admin-complaints.js"), "utf8");
const boundary = name => ({ barangay_name: name, polygon_json: {
  type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] } });
const reference = (name = "Fixture A") => ({ barangay_name: name, latitude: 1.4, longitude: 1.6,
  reference_name: "Synthetic reference" });
function fixture(overrides = {}) {
  const state = { complaint: { id: 11, latitude: 1, longitude: 1, status: "pending",
    assigned_barangay: "Citizen text is not proof", assignment_confirmed_at: null },
    boundaries: [boundary("Fixture A")], references: [reference()], calls: [], ...overrides };
  const db = { query(sql, params, callback) {
    assert.match(sql.trim(), /^SELECT\b/);
    assert.doesNotMatch(sql, /FOR UPDATE|detect-barangay|ORDER BY|distance/i);
    state.calls.push({ sql, params });
    if (state.fail) return callback(new Error("Synthetic unavailable registry"));
    callback(null, sql.includes("FROM complaints") ? [state.complaint]
      : sql.includes("FROM barangay_boundaries") ? state.boundaries : state.references);
  } };
  return { state, run: () => resolveComplaintMapDestination(db, 11) };
}
test("unique active polygon gives one explicitly unconfirmed suggestion, not nearby destinations", async () => {
  const h = fixture();
  const result = await h.run();
  assert.equal(result.basis, "strict_polygon_suggestion");
  assert.match(result.label, /Geographic suggestion.*Needs Admin Confirmation/);
  assert.equal(result.destination.barangay_name, "Fixture A");
  assert.deepEqual(h.state.calls.at(-1).params, ["Fixture A"]);
  assert.match(h.state.calls[1].sql, /status = 'active'/);
  assert.equal(h.state.complaint.latitude, 1);
  assert.equal(h.state.complaint.longitude, 1);
});
test("confirmed assignment takes priority over polygon and citizen text", async () => {
  const h = fixture(); Object.assign(h.state.complaint, { status: "forwarded", assigned_barangay: "Fixture B",
    assignment_confirmed_at: "2026-10-19" }); h.state.references = [reference("Fixture B")];
  const result = await h.run();
  assert.equal(result.basis, "admin_confirmed");
  assert.equal(result.destination.barangay_name, "Fixture B");
  assert.equal(h.state.calls.length, 2);
});
for (const scenario of ["unmatched", "ambiguous polygon", "invalid polygon", "invalid GPS", "empty GPS",
  "legacy unconfirmed", "missing reference", "two references", "wrong reference", "invalid reference"]) {
  test(`${scenario} fails closed without a destination`, async () => {
    const h = fixture();
    if (scenario === "unmatched") h.state.boundaries = [];
    if (scenario === "ambiguous polygon") h.state.boundaries.push(boundary("Fixture B"));
    if (scenario === "invalid polygon") h.state.boundaries[0].polygon_json = "invalid";
    if (scenario === "invalid GPS") h.state.complaint.latitude = 91;
    if (scenario === "empty GPS") h.state.complaint.latitude = "";
    if (scenario === "legacy unconfirmed") h.state.complaint.status = "forwarded";
    if (scenario === "missing reference") h.state.references = [];
    if (scenario === "two references") h.state.references.push(reference());
    if (scenario === "wrong reference") h.state.references = [reference("Fixture B")];
    if (scenario === "invalid reference") h.state.references[0].longitude = null;
    const result = await h.run();
    assert.equal(result.destination, null); assert.equal(result.label, "Needs Admin Confirmation");
  });
}
test("unavailable lookup propagates safely to the HTTP fail-closed handler", async () => {
  await assert.rejects(fixture({ fail: true }).run(), /Synthetic unavailable/);
});

function mapHarness() {
  const state = { timers: [], maps: [], requests: [], response: null, alerts: [] };
  const elements = { complaintDetailsLeafletPreviewMap: {}, complaintDetailsMapPreviewLoading: {
    classList: { toggle() {} } }, complaintFullMapDestinationLabel: {}, complaintDetailsBadge: {} };
  const map = () => {
    const value = { layers: new Set(), controls: new Set(), setView(point) { this.center = point; return this; },
      fitBounds(points) { this.bounds = points; }, invalidateSize() {},
      removeLayer(layer) { this.layers.delete(layer); }, hasLayer(layer) { return this.layers.has(layer); },
      removeControl(control) { this.controls.delete(control); } };
    state.maps.push(value); return value;
  };
  const layer = (kind, point, options) => ({ kind, point, options, addTo(map) { map.layers.add(this); return this; },
    bindPopup(text) { this.popup = text; return this; }, openPopup() { return this; } });
  const L = { icon: options => options, map, tileLayer: () => ({ addTo() {} }),
    marker: (point, options) => layer("marker", point, options),
    polyline: points => layer("route", points), latLng: (lat, lng) => [lat, lng], latLngBounds: points => points };
  const context = vm.createContext({ currentComplaint: { id: 11, latitude: 1, longitude: 1 },
    complaintMapInstance: null, complaintMapMarker: null, complaintRoutingControl: null, complaintNearbyMarkers: [],
    window: { L, addEventListener() {} }, L, document: { getElementById: id => elements[id] || null,
      querySelector: selector => selector.includes("preview-map-badge") ? elements.complaintDetailsBadge : null },
    console: { warn() {}, error() {} }, escapeHtml: String, setTimeout: callback => state.timers.push(callback),
    alert: message => state.alerts.push(message), webAdminFetch: async url => {
      state.requests.push(url);
      const result = await (state.respond ? state.respond() : state.response);
      return { ok: true, json: async () => result };
    }, getComplaintsApiUrl: () => "/offline/complaints" });
  vm.runInContext(source, context);
  for (const name of ["mountComplaintModalsToBody", "ensureComplaintFullMapOnlyStyles", "ensureComplaintFullMapLegend",
    "ensureComplaintDetailsMapPreviewStyles", "openComplaintModalWithPosition", "resetComplaintModalDisplay"]) context[name] = () => {};
  context.ensureComplaintDetailsMapPreviewContainer = () => elements.complaintDetailsLeafletPreviewMap;
  async function flush() { while (state.timers.length) await state.timers.shift()(); }
  return { state, context, elements, L, flush,
    preview: () => context.renderComplaintDetailsMapPreview(context.currentComplaint),
    full: () => context.openComplaintMapModal(),
    blue: map => [...map.layers].filter(l => l.options?.icon?.iconUrl?.includes("blue")),
    red: map => [...map.layers].filter(l => l.options?.icon?.iconUrl?.includes("red")) };
}
const resolved = basis => ({ success: true, complaint_id: 11, basis, destination: reference(),
  label: basis === "admin_confirmed" ? "Admin-confirmed Barangay: Fixture A" : "Geographic suggestion: Fixture A — Needs Admin Confirmation" });
for (const basis of ["admin_confirmed", "strict_polygon_suggestion", "needs_admin_confirmation"]) {
  test(`preview/fullscreen share one resolution (${basis}) and preserve citizen coordinates`, async () => {
    const h = mapHarness(); h.state.response = basis === "needs_admin_confirmation"
      ? { success: true, complaint_id: 11, basis, destination: null } : resolved(basis);
    await h.preview(); await h.flush(); await h.full(); await h.flush();
    assert.equal(h.state.requests.length, 1);
    for (const map of h.state.maps) {
      assert.equal(h.red(map).length, 1);
      assert.deepEqual(Array.from(h.red(map)[0].point), [1, 1]);
      assert.equal(h.blue(map).length, basis === "needs_admin_confirmation" ? 0 : 1);
    }
    const full = h.state.maps[1];
    assert.equal([...full.layers].filter(l => l.kind === "route").length, basis === "needs_admin_confirmation" ? 0 : 1);
  });
}
test("two nearby references cannot become forwarding/map targets", () => {
  const h = mapHarness();
  assert.equal(h.context.getComplaintForwardingTargets([reference(), reference("Fixture B")]).length, 0);
});
test("closing removes markers and routes; old routing error cannot recreate a line", async () => {
  const h = mapHarness(); h.state.response = resolved("admin_confirmed");
  let control;
  h.L.Routing = { osrmv1: () => ({}), control: () => (control = {
    addTo(map) { map.controls.add(this); return this; }, on(_, callback) { this.fail = callback; } }) };
  await h.full(); await h.flush(); const map = h.state.maps[0];
  assert.equal(map.controls.size, 1);
  control.fail(); control.fail();
  assert.equal([...map.layers].filter(l => l.kind === "route").length, 1);
  h.context.closeComplaintMapModal(); control.fail();
  assert.equal(map.layers.size, 0); assert.equal(map.controls.size, 0);
});
test("switching complaints suppresses stale preview and fullscreen responses", async () => {
  const h = mapHarness(); let finish;
  h.state.respond = () => new Promise(resolve => { finish = resolve; });
  const preview = h.preview(); await h.full();
  const previewRender = h.state.timers.shift()();
  const full = h.state.timers.shift()();
  h.context.currentComplaint = { id: 12, latitude: 3, longitude: 4 };
  h.context.closeComplaintModal();
  h.context.closeComplaintMapModal();
  finish(resolved("admin_confirmed")); await preview; await previewRender; await full; await h.flush();
  assert.ok(h.state.maps.every(map => map.layers.size === 0));
});
test("network failure is red-only and visibly needs Admin confirmation", async () => {
  const h = mapHarness(); h.state.respond = () => { throw new Error("Synthetic network failure"); };
  await h.preview(); await h.flush(); await h.full(); await h.flush();
  assert.ok(h.state.maps.every(map => h.red(map).length === 1 && h.blue(map).length === 0));
  assert.equal(h.elements.complaintFullMapDestinationLabel.textContent, "Needs Admin Confirmation");
});
test("map lookup uses the existing Admin guards and cannot forward/assign", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../routes/complaintRoutes.js"), "utf8");
  const block = routes.slice(routes.indexOf('router.get("/:id/map-destination"'), routes.indexOf('router.get("/assignment-options"'));
  assert.match(block, /\.\.\.complaintAuth.admin/); assert.match(block, /no-store/);
  assert.match(block, /statusCode \|\| 503/);
  assert.doesNotMatch(block, /validate.forward|UPDATE|INSERT|DELETE|ALTER|CREATE/);
  assert.match(source, /confirm_assignment: true/);
  assert.match(source, /confirm\(/);
});
