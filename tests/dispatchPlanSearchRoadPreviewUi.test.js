const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Reuse the existing wizard fixture so the API/payload baseline remains identical.
const fixtureSource = fs.readFileSync(path.join(__dirname, "dispatchPlanWizardMapUi.test.js"), "utf8").split('\ntest("create starts')[0];
function fixture() {
  const sandbox = { require, __dirname, console, Headers, setTimeout, clearTimeout };
  vm.runInNewContext(fixtureSource + ";this.makeFixture = fixture;", sandbox);
  const f = sandbox.makeFixture();
  const timers = new Map(); let next = 0;
  f.context.setTimeout = (fn, delay) => { timers.set(++next, { fn, delay }); return next; };
  f.context.clearTimeout = (id) => timers.delete(id);
  f.context.AbortController = AbortController;
  f.layers.removeLayer = (layer) => { f.layers.routes = f.layers.routes.filter((item) => item !== layer); };
  f.calls = [];
  f.context.requestDispatchRoadJourney = async (points, signal) => {
    f.calls.push({ points: JSON.parse(JSON.stringify(points)), signal });
    return points.map((point) => [point.latitude, point.longitude]);
  };
  f.flush = async () => {
    for (const [id, task] of [...timers]) { timers.delete(id); await task.fn(); }
  };
  f.routeTask = () => {
    const entry = [...timers].find(([, task]) => task.delay === 300);
    if (!entry) return null;
    timers.delete(entry[0]); return entry[1].fn();
  };
  f.key = (key) => f.api.dispatchPlanSearchKeydown({ key, preventDefault() {}, stopPropagation() {} });
  f.search = (query) => { f.element("dispatchPlanDestinationSearch").value = query; f.api.dispatchPlanSearchInput(); };
  f.start = async () => {
    await f.api.openCreateDispatchPlan();
    f.element("dispatchPlanFleetTruck").value = "4";
    f.element("dispatchPlanEnforcer").value = "11";
    f.api.dispatchPlanNextStep();
  };
  return f;
}
const json = (value) => JSON.parse(JSON.stringify(value));

test("typing renders immediate case-insensitive results without fetching; empty/no-result states", async () => {
  const f = fixture(); await f.start();
  f.destinations[0].display_label = "Pendatun Avenue";
  f.search(" PENDATUN ");
  assert.match(f.element("dispatchPlanSearchResults").innerHTML, /Pendatun Avenue/);
  assert.equal(f.element("dispatchPlanSearchStatus").textContent, "1 matching destination.");
  assert.equal(f.element("dispatchPlanDestinationSearch").attrs["aria-expanded"], "true");
  f.search("pendatun xyz"); assert.match(f.element("dispatchPlanSearchStatus").textContent, /No verified destinations match/);
  f.search(""); assert.equal(f.element("dispatchPlanSearchResults").innerHTML, "");
  assert.match(f.element("dispatchPlanSearchStatus").textContent, /Start typing/);
  assert.equal(f.mutations(), 0); f.api.dispatchPlanDestroyPreview();
});

test("results capped at eight and Add shares duplicate prevention; remove restores availability", async () => {
  const f = fixture(); await f.start();
  f.api.dispatchPlanState.destinations = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, display_label: `Street ${i}`, barangay: "Bula", latitude: 6.11, longitude: 125.18 }));
  f.search("street"); assert.equal(f.api.dispatchPlanSearchMatches().length, 8);
  assert.equal(f.element("dispatchPlanSearchStatus").textContent, "8 matching destinations shown. Refine your search for more.");
  const event = { target: { closest: () => ({ disabled: false, dataset: { addDestination: "1" } }) } };
  f.api.dispatchPlanSearchAdd(event); f.api.dispatchPlanSearchAdd(event);
  assert.equal(f.api.dispatchPlanState.stops.length, 1);
  assert.match(f.element("dispatchPlanSearchResults").innerHTML, /Added ✓/);
  f.api.removePlanStop(0);
  assert.doesNotMatch(f.element("dispatchPlanSearchResults").innerHTML, /Added ✓/);
  f.api.dispatchPlanDestroyPreview();
});

test("keyboard arrows/Enter add, skip added options, and Escape closes only search", async () => {
  const f = fixture(); await f.start(); f.search("verified");
  f.key("ArrowDown"); assert.equal(f.element("dispatchPlanDestinationSearch").attrs["aria-activedescendant"], "dispatchPlanSearchOption0");
  f.key("Enter"); assert.equal(f.api.dispatchPlanState.stops[0].destination_id, 1);
  f.key("ArrowDown"); f.key("Enter"); assert.equal(f.api.dispatchPlanState.stops[1].destination_id, 2);
  f.key("ArrowUp"); assert.equal(f.element("dispatchPlanDestinationSearch").attrs["aria-activedescendant"], "dispatchPlanSearchOption2");
  f.key("Escape"); assert.equal(f.element("dispatchPlanDestinationSearch").attrs["aria-expanded"], "false");
  assert.equal(f.api.dispatchPlanState.wizardStep, 2); f.api.dispatchPlanDestroyPreview();
});

test("zero stops never request a route; add/remove/reorder debounce to authoritative ordered waypoints", async () => {
  const f = fixture(); await f.start(); await f.flush(); assert.equal(f.calls.length, 0);
  [1, 2, 3].forEach((id) => f.api.addPlanStop(id));
  await f.flush(); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].points[0], { latitude: 6.1060875, longitude: 125.1816406 });
  f.api.movePlanStop(2, "up"); await f.flush();
  assert.equal(f.calls[1].points[2].latitude, f.destinations[2].latitude);
  f.api.removePlanStop(0); await f.flush();
  assert.equal(f.calls[2].points.length, 3);
  assert.equal(f.calls[2].points[1].latitude, f.destinations[2].latitude);
  f.api.dispatchPlanDestroyPreview();
});

test("road geometry replaces dashed sequence without moving markers or changing payload", async () => {
  const f = fixture(); await f.start(); f.api.addPlanStop(1);
  const geometry = [[6.1060875, 125.1816406], [6.109, 125.182], [6.115, 125.178]];
  f.context.requestDispatchRoadJourney = async () => geometry;
  assert.equal(f.layers.routes[0].options.dashArray, "7 6"); await f.flush();
  assert.deepEqual(json(f.layers.routes[0].coords), geometry);
  assert.equal(f.layers.routes[0].options.dashArray, undefined);
  assert.equal(f.layers.markers[1].coords[0], f.destinations[0].latitude);
  assert.match(f.element("dispatchPlanRoadStatus").textContent, /Road route/);
  const payload = f.api.dispatchPlanBuildPayload({ operational_date: f.plan.operational_date, fleet_truck_id: 4, assigned_enforcer_user_id: 11 }, f.api.dispatchPlanState.stops);
  assert.deepEqual(Object.keys(payload.stops[0]).sort(), ["destination_id", "stop_order"]);
  f.api.dispatchPlanDestroyPreview();
});

test("in-flight route is aborted and stale results ignored after reorder", async () => {
  const f = fixture(); await f.start(); f.api.addPlanStop(1); f.api.addPlanStop(2);
  let resolve; let signal;
  f.context.requestDispatchRoadJourney = (_points, parent) => { signal = parent; return new Promise((done) => { resolve = done; }); };
  const pending = f.routeTask();
  f.api.movePlanStop(1, "up"); assert.equal(signal.aborted, true);
  resolve([[1, 2], [3, 4]]); await pending;
  assert.notDeepEqual(json(f.layers.routes[0].coords), [[1, 2], [3, 4]]);
  f.api.dispatchPlanDestroyPreview();
});

test("offline/invalid routing keeps dashed fallback, stops and Save available", async () => {
  for (const result of ["offline", "invalid"]) {
    const f = fixture(); await f.start(); f.api.addPlanStop(1);
    f.context.requestDispatchRoadJourney = async () => { if (result === "offline") throw new Error("Offline"); return [[NaN, 0]]; };
    await f.flush();
    assert.match(f.element("dispatchPlanRoadStatus").textContent, /Road route unavailable/);
    assert.equal(f.layers.routes[0].options.dashArray, "7 6");
    assert.equal(f.api.dispatchPlanState.stops.length, 1);
    assert.equal(f.element("dispatchPlanSaveBtn").disabled, false); f.api.dispatchPlanDestroyPreview();
  }
});

test("edit automatically routes restored coordinates; close cancels pending request", async () => {
  const f = fixture(); await f.api.openEditDispatchPlan(9); f.api.dispatchPlanNextStep(); await f.flush();
  assert.equal(f.calls[0].points[1].longitude, f.plan.stops[0].longitude);
  f.api.addPlanStop(3); f.api.closeDispatchPlanningModalsForNavigation(); await f.flush();
  assert.equal(f.calls.length, 1); assert.equal(f.mapRemoves(), 1);
});

test("search layout preserves hidden legacy controls and uses existing routing helper only", () => {
  const html = fs.readFileSync(path.join(__dirname, "../frontend/admin-dashboard.html"), "utf8");
  const js = fs.readFileSync(path.join(__dirname, "../frontend/js/admin/admin-dispatch-plans.js"), "utf8");
  assert.match(html, /class="dispatch-plan-destination-picker" hidden/);
  assert.match(html, /role="combobox"[^>]*aria-autocomplete="list"/);
  assert.match(html, /id="dispatchPlanSearchResults"[^>]*role="listbox"/);
  assert.match(js, /requestDispatchRoadJourney\(route\.map/);
  assert.doesNotMatch(js, /router\.project-osrm|api\.mapbox/);
});
