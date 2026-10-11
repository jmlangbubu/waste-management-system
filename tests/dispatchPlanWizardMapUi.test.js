const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "frontend/js/admin/admin-dispatch-plans.js"), "utf8");
const html = fs.readFileSync(path.join(root, "frontend/admin-dashboard.html"), "utf8");

function fixture(hostname = "localhost", runtime = "", session = "") {
  const nodes = new Map();
  function element(id) {
    if (!nodes.has(id)) {
      const classes = new Set(id.endsWith("Modal") ? ["hidden"] : []);
      nodes.set(id, { id, value: "", hidden: false, disabled: false, textContent: "", innerHTML: "", attrs: {},
        classList: { add: (s) => classes.add(s), remove: (s) => classes.delete(s), contains: (s) => classes.has(s),
          toggle: (s, on) => on ? classes.add(s) : classes.delete(s) },
        setAttribute(k,v) { this.attrs[k]=v; }, removeAttribute(k) { delete this.attrs[k]; },
        focus() { document.activeElement=this; }, reset() {}, querySelector: () => null,
        selectedOptions: [{ textContent: "Synthetic assignment" }] });
    }
    return nodes.get(id);
  }
  const document = { getElementById: element, querySelector: () => null, body: { classList: { toggle() {} } },
    documentElement: { classList: { toggle() {} } } };
  const destinations = [1,2,3].map((id) => ({ id, display_label: `Verified stop ${id}`, barangay: "Bula",
    destination_type: "road_segment", latitude: 6.11 + id * .005, longitude: 125.17 + id * .008 }));
  const date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  const plan = { id: 9, status: "planned", operational_date: date, fleet_truck_id: 4, assigned_enforcer_user_id: 11,
    revision: 2, stops: destinations.slice(0,2).map((s,i) => ({ ...s, destination_id:s.id, stop_order:i+1,
      location_name_snapshot:s.display_label, address_reference_snapshot:s.barangay })) };
  let reads = 0, mutations = 0, mapCreates = 0, mapRemoves = 0;
  const layers = { markers: [], routes: [], clearLayers() { this.markers=[];this.routes=[]; }, addTo() { return this; } };
  const map = { setView() { return this; }, invalidateSize() {}, fitBounds() {}, remove() { mapRemoves++; } };
  const context = { document, console, Headers, setTimeout, clearTimeout, module: { exports: {} },
    location: { hostname }, APP_CONFIG: { CARTO_BASEMAP_KEY: runtime },
    get sessionStorage() { reads++; return { getItem: () => session }; },
    L: { map: () => { mapCreates++;return map; }, layerGroup: () => layers, divIcon: (o) => o,
      tileLayer: (url,options) => ({ url, options, addTo() { return this; } }),
      marker: (coords,options) => ({ coords, options, addTo(group) { group.markers.push(this);return this; }, bindPopup() { return this; } }),
      polyline: (coords,options) => ({ coords,options,addTo(group) { group.routes.push(this);return this; } }) },
    getDispatchPlanOptionsApiUrl: () => "options", getDispatchDestinationsApiUrl: () => "destinations",
    getDispatchPlanApiUrl: () => "plan", getDispatchPlansApiUrl: () => "plans",
    webAdminFetch: async (url, options={}) => {
      if (options.method) mutations++;
      const data = url === "options" ? { fleet_trucks:[{id:4}],enforcers:[{id:11}] } : url === "plan" ? plan : url === "destinations" ? destinations : [];
      return { ok: true, json: async () => ({ success:true,data }) };
    } };
  vm.runInNewContext(source, context);
  return { api:context.module.exports, context, element, destinations, layers, plan,
    reads:()=>reads, mutations:()=>mutations, mapCreates:()=>mapCreates, mapRemoves:()=>mapRemoves };
}

test("create starts at Assignment; incomplete Next focuses guidance without saving", async () => {
  const f=fixture();await f.api.openCreateDispatchPlan();
  assert.equal(f.api.dispatchPlanState.wizardStep,1);
  assert.equal(f.element("dispatchPlanStep2").hidden,true);
  assert.equal(f.element("dispatchPlanSaveBtn").hidden,true);
  assert.equal(f.api.dispatchPlanNextStep(),false);
  assert.equal(f.context.document.activeElement.id,"dispatchPlanFleetTruck");
  assert.equal(f.mutations(),0);
});

test("eligible Assignment advances and Back preserves values, stops, and search", async () => {
  const f=fixture();await f.api.openCreateDispatchPlan();
  f.element("dispatchPlanFleetTruck").value="4";f.element("dispatchPlanEnforcer").value="11";
  assert.equal(f.api.dispatchPlanNextStep(),true);
  assert.equal(f.element("dispatchPlanStep1").hidden,true);
  assert.equal(f.element("dispatchPlanProgress2").attrs["aria-current"],"step");
  assert.equal(f.context.document.activeElement.id,"dispatchPlanDestinationSearch");
  f.api.addPlanStop(1);f.element("dispatchPlanDestinationSearch").value="Bula";
  f.api.dispatchPlanSetWizardStep(1);
  assert.equal(f.element("dispatchPlanFleetTruck").value,"4");
  assert.equal(f.element("dispatchPlanDestinationSearch").value,"Bula");
  assert.equal(f.api.dispatchPlanState.stops.length,1);
  f.api.dispatchPlanNextStep();assert.equal(f.mapCreates(),1);f.api.dispatchPlanDestroyPreview();
});

test("Next rejects date, stale assignment IDs and pending eligibility", async () => {
  const f=fixture();await f.api.openCreateDispatchPlan();
  f.element("dispatchPlanOperationalDate").value="invalid";assert.equal(f.api.dispatchPlanNextStep(),false);
  f.element("dispatchPlanOperationalDate").value=f.api.dispatchPlanTomorrowInManila();
  f.element("dispatchPlanFleetTruck").value="999";assert.equal(f.api.dispatchPlanNextStep(),false);
  f.api.dispatchPlanState.loadingOptions=true;assert.equal(f.api.dispatchPlanNextStep(),false);
});

test("add/remove/reorder redraw marker numbers and route from WMO without payload coordinates", async () => {
  const f=fixture();await f.api.openCreateDispatchPlan();
  f.element("dispatchPlanFleetTruck").value="4";f.element("dispatchPlanEnforcer").value="11";f.api.dispatchPlanNextStep();
  for (const id of [1,2,3]) assert.equal(f.api.addPlanStop(id),true);
  assert.equal(f.api.addPlanStop(1),false);
  assert.equal(f.api.dispatchPlanState.stops[0].latitude,f.destinations[0].latitude);
  assert.equal(f.layers.markers.length,4);
  assert.ok(f.layers.markers[3].options.icon.html.includes(">3</span>"));
  assert.equal(f.layers.routes[0].coords.length,4);
  f.api.removePlanStop(1);assert.equal(f.layers.markers.length,3);
  f.api.movePlanStop(1,"up");assert.equal(f.api.dispatchPlanState.stops[0].destination_id,3);
  assert.equal(f.layers.routes[0].coords[1][0],f.destinations[2].latitude);
  assert.ok(f.layers.markers[1].options.icon.html.includes(">1</span>"));
  const payload=f.api.dispatchPlanBuildPayload({ operational_date:f.plan.operational_date,fleet_truck_id:4,assigned_enforcer_user_id:11 },f.api.dispatchPlanState.stops);
  assert.equal(Object.keys(payload.stops[0]).sort().join(","),"destination_id,stop_order");
  assert.equal(f.mutations(),0);f.api.dispatchPlanDestroyPreview();
});

test("edit preserves saved coordinates and renders them entering Step 2", async () => {
  const f=fixture();await f.api.openEditDispatchPlan(9);
  assert.equal(f.api.dispatchPlanState.wizardStep,1);
  assert.equal(f.api.dispatchPlanState.stops[0].longitude,f.plan.stops[0].longitude);
  assert.equal(f.api.dispatchPlanNextStep(),true);
  assert.equal(f.layers.markers.length,3);assert.equal(f.element("dispatchPlanSaveBtn").textContent,"Save Changes");
  f.api.dispatchPlanDestroyPreview();
});

test("invalid coordinates remain in stops while only valid markers render", async () => {
  const f=fixture();await f.api.openCreateDispatchPlan();
  f.element("dispatchPlanFleetTruck").value="4";f.element("dispatchPlanEnforcer").value="11";f.api.dispatchPlanNextStep();
  f.destinations[0].latitude=null;f.api.addPlanStop(1);f.api.addPlanStop(2);
  assert.equal(f.api.dispatchPlanState.stops.length,2);assert.equal(f.layers.markers.length,2);
  assert.match(f.element("dispatchPlanPreviewNotice").textContent,/cannot be shown/);
  assert.equal(f.api.dispatchPlanPreviewPoints([{latitude:"",longitude:1},{latitude:91,longitude:0},{latitude:"NaN",longitude:1}]).length,0);
  assert.equal(f.element("dispatchPlanSaveBtn").disabled,false);f.api.dispatchPlanDestroyPreview();
});

test("reset/reopen and navigation destroy maps without duplicate instances", async () => {
  const f=fixture();await f.api.openCreateDispatchPlan();
  f.element("dispatchPlanFleetTruck").value="4";f.element("dispatchPlanEnforcer").value="11";f.api.dispatchPlanNextStep();
  f.api.closeDispatchPlanningModalsForNavigation();assert.equal(f.mapRemoves(),1);
  await f.api.openCreateDispatchPlan();f.element("dispatchPlanFleetTruck").value="4";f.element("dispatchPlanEnforcer").value="11";f.api.dispatchPlanNextStep();
  assert.equal(f.mapCreates(),2);f.api.dispatchPlanResetForm();assert.equal(f.mapRemoves(),2);
});

for (const hostname of ["localhost","127.0.0.1","::1","[::1]"]) test(`${hostname} permits trimmed local override`,()=>{
  const f=fixture(hostname,"RUNTIME_KEY"," LOCAL_KEY ");assert.ok(f.api.dispatchPlanCreateBasemapLayer().url.endsWith("key=LOCAL_KEY"));
});
test("production never reads storage; runtime and OSM policies unchanged",()=>{
  for(const hostname of ["wastegensan.com","www.wastegensan.com","admin.wastegensan.com"]){
    const f=fixture(hostname," RUNTIME_KEY ","STALE_KEY");assert.ok(f.api.dispatchPlanCreateBasemapLayer().url.endsWith("key=RUNTIME_KEY"));assert.equal(f.reads(),0);
  }
  const f=fixture("wastegensan.com","","STALE_KEY");assert.match(f.api.dispatchPlanCreateBasemapLayer().url,/tile\.openstreetmap\.org/);assert.equal(f.reads(),0);
});
test("denied local storage uses trimmed runtime key or OSM safely",()=>{
  const f=fixture("localhost"," RUNTIME_KEY ");
  Object.defineProperty(f.context,"sessionStorage",{get(){throw new Error("Denied");}});
  assert.ok(f.api.dispatchPlanCreateBasemapLayer().url.endsWith("key=RUNTIME_KEY"));
  f.context.APP_CONFIG.CARTO_BASEMAP_KEY=" ";assert.match(f.api.dispatchPlanCreateBasemapLayer().url,/tile\.openstreetmap\.org/);
});
test("wizard markup keeps existing dialog, hidden-step safety and catalog-only search",()=>{
  assert.match(html,/id="dispatchPlanFormModal"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html,/id="dispatchPlanStep2"[^>]*hidden/);
  assert.match(html,/id="dispatchPlanNextBtn"/);assert.match(html,/id="dispatchPlanBackBtn"[^>]*hidden/);
  assert.match(html,/Search verified street, barangay, or destination/);
  assert.doesNotMatch(source,/geocod|api\.mapbox|router\.project-osrm/);
});
