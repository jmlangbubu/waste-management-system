const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const planning = require("../frontend/js/admin/admin-dispatch-plans");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");
const planningSource = read("frontend/js/admin/admin-dispatch-plans.js");
const apiSource = read("frontend/js/admin/admin-api.js");
const initSource = read("frontend/js/admin/admin-init.js");
const dashboardHtml = read("frontend/admin-dashboard.html");
const planningCss = read("frontend/css/admin/admin-dispatch-plans.css");

function destination(id, label, barangay = "Lagao") {
  return {
    id,
    destination_type: "road_segment",
    display_label: label,
    barangay
  };
}

function plan(overrides = {}) {
  return {
    id: 7,
    operational_date: "2026-08-30",
    status: "planned",
    fleet_truck_id: 4,
    truck_code_snapshot: "TRUCK-04",
    truck_name_snapshot: "Garbage Truck 1",
    assigned_enforcer_user_id: 11,
    assigned_enforcer_name_snapshot: "Verified Enforcer",
    route_name: "Manual Route",
    scheduled_start: "2026-08-30 08:00:00",
    expected_return: "2026-08-30 16:00:00",
    stop_count: 2,
    revision: 1,
    ...overrides
  };
}

const scenarios = [];
function scenario(letter, name, callback) {
  scenarios.push({ letter, name, callback });
}

scenario("A", "tomorrow defaults from the Asia/Manila calendar", () => {
  assert.equal(
    planning.dispatchPlanTomorrowInManila(new Date("2026-08-29T15:30:00Z")),
    "2026-08-30"
  );
  assert.equal(
    planning.dispatchPlanTomorrowInManila(new Date("2026-08-29T16:30:00Z")),
    "2026-08-31"
  );
  assert.equal(planning.MANILA_TIME_ZONE, "Asia/Manila");
});

scenario("B", "past operational dates are blocked", () => {
  const result = planning.dispatchPlanValidateOperationalDate(
    "2026-08-28",
    new Date("2026-08-29T04:00:00Z")
  );
  assert.equal(result.valid, false);
  assert.match(result.message, /past.*Asia\/Manila/i);
  assert.match(dashboardHtml, /id="dispatchPlanOperationalDate"[^>]*required/);
});

scenario("C", "empty truck options have a clean roster state", () => {
  assert.equal(
    planning.dispatchPlanTruckOptionsHtml([]),
    '<option value="">Choose an eligible truck</option>'
  );
  assert.match(planningSource, /No eligible fleet trucks are available for this date/);
  assert.match(planningSource, /Register and verify the WMO fleet roster in Fleet Monitoring/);
  assert.match(planningSource, /trucks\.length === 0/);
});

scenario("D", "eligible truck options are human readable", () => {
  const html = planning.dispatchPlanTruckOptionsHtml([{
    id: 4,
    truck_name: "Garbage Truck 1",
    truck_code: "TRUCK-04",
    plate_number: "ABC-1234"
  }], 4);
  assert.match(html, /Garbage Truck 1/);
  assert.match(html, /TRUCK-04/);
  assert.match(html, /ABC-1234/);
  assert.match(html, /value="4" selected/);
});

scenario("E", "eligible mobile enforcers render safe display names", () => {
  const html = planning.dispatchPlanEnforcerOptionsHtml([{
    id: 11,
    display_name: "Verified Enforcer",
    mobile_role: "enforcer"
  }], 11);
  assert.match(html, /Verified Enforcer/);
  assert.doesNotMatch(html, /password|token|hash/i);
});

scenario("F", "verified destinations render with safe catalog context", () => {
  const html = planning.dispatchPlanDestinationOptionsHtml([
    destination(101, "Pendatun Avenue")
  ]);
  assert.match(html, /Pendatun Avenue/);
  assert.match(html, /Lagao/);
  assert.match(html, /Road \/ Street/);
  assert.match(planningSource, /DESTINATION_TYPES = Object\.freeze\(\["road_segment", "barangay_hall"\]\)/);
});

scenario("G", "duplicate destinations are blocked", () => {
  const first = planning.dispatchPlanAddStopToList([], destination(101, "Pendatun Avenue"));
  const duplicate = planning.dispatchPlanAddStopToList(first.stops, destination(101, "Pendatun Avenue"));
  assert.equal(first.error, "");
  assert.match(duplicate.error, /already included/);
  assert.equal(duplicate.stops.length, 1);
});

scenario("H", "Add Stop appends a selected verified destination", () => {
  const result = planning.dispatchPlanAddStopToList([], destination(102, "Santiago Boulevard"));
  assert.equal(result.stops.length, 1);
  assert.equal(result.stops[0].destination_id, 102);
  assert.equal(result.stops[0].stop_order, 1);
});

scenario("I", "Remove Stop renumbers the visible route", () => {
  const stops = [destination(101, "One"), destination(102, "Two")].map((item) => ({
    destination_id: item.id,
    display_label: item.display_label
  }));
  const result = planning.dispatchPlanRemoveStopFromList(stops, 0);
  assert.deepEqual(result.map((stop) => [stop.destination_id, stop.stop_order]), [[102, 1]]);
});

scenario("J", "Move Up changes only manual visible order", () => {
  const stops = [101, 102, 103].map((id) => ({ destination_id: id }));
  const result = planning.dispatchPlanMoveStopInList(stops, 2, "up");
  assert.deepEqual(result.map((stop) => stop.destination_id), [101, 103, 102]);
});

scenario("K", "Move Down changes only manual visible order", () => {
  const stops = [101, 102, 103].map((id) => ({ destination_id: id }));
  const result = planning.dispatchPlanMoveStopInList(stops, 0, "down");
  assert.deepEqual(result.map((stop) => stop.destination_id), [102, 101, 103]);
});

scenario("L", "submitted stop_order is regenerated from visible order", () => {
  const moved = planning.dispatchPlanMoveStopInList([
    { destination_id: 101, stop_order: 99 },
    { destination_id: 102, stop_order: 4 }
  ], 0, "down");
  const payload = planning.dispatchPlanBuildPayload({
    operational_date: "2026-08-30",
    fleet_truck_id: 4,
    assigned_enforcer_user_id: 11
  }, moved);
  assert.deepEqual(payload.stops.map((stop) => [stop.destination_id, stop.stop_order]), [
    [102, 1],
    [101, 2]
  ]);
});

scenario("M", "create request shape matches the merged backend contract", () => {
  const payload = planning.dispatchPlanBuildPayload({
    operational_date: "2026-08-30",
    fleet_truck_id: "4",
    assigned_enforcer_user_id: "11",
    route_name: "Manual Route",
    description: "Collect in submitted order",
    scheduled_start: "2026-08-30T08:00",
    expected_return: "2026-08-30T16:00",
    notes: "Bring safety equipment"
  }, [{ destination_id: 101, expected_arrival: "2026-08-30T09:00" }]);
  assert.deepEqual(payload, {
    operational_date: "2026-08-30",
    fleet_truck_id: 4,
    assigned_enforcer_user_id: 11,
    route_name: "Manual Route",
    description: "Collect in submitted order",
    scheduled_start: "2026-08-30T08:00",
    expected_return: "2026-08-30T16:00",
    notes: "Bring safety equipment",
    stops: [{ destination_id: 101, stop_order: 1, expected_arrival: "2026-08-30T09:00" }]
  });
  assert.equal(
    planning.dispatchPlanValidatePayload(payload, new Date("2026-08-29T04:00:00Z")).valid,
    true
  );
});

scenario("N", "client snapshot spoof fields are never submitted", () => {
  const payload = planning.dispatchPlanBuildPayload({
    operational_date: "2026-08-30",
    fleet_truck_id: 4,
    assigned_enforcer_user_id: 11,
    truck_code_snapshot: "SPOOF",
    created_by_web_user_id: 999,
    revision: 999
  }, [{
    destination_id: 101,
    latitude: 0,
    longitude: 0,
    geofence_radius_meters: 9999,
    location_name_snapshot: "SPOOF"
  }]);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /snapshot|latitude|longitude|geofence|creator|revision/i);
});

scenario("O", "successful create refreshes plan list and options", async () => {
  const calls = [];
  let plans = 0;
  let options = 0;
  const result = await planning.dispatchPlanRunMutation({
    request: async (url, requestOptions) => {
      calls.push([url, requestOptions.method, JSON.parse(requestOptions.body)]);
      return { id: 7 };
    },
    url: "/api/dispatch/plans",
    method: "POST",
    payload: { operational_date: "2026-08-30" },
    refreshPlans: async () => { plans += 1; },
    refreshOptions: async () => { options += 1; }
  });
  assert.equal(result.id, 7);
  assert.deepEqual(calls[0].slice(0, 2), ["/api/dispatch/plans", "POST"]);
  assert.deepEqual([plans, options], [1, 1]);
});

scenario("P", "plan list renders server response fields and friendly status", () => {
  const html = planning.dispatchPlanRowsHtml([plan()]);
  assert.match(html, /2026-08-30/);
  assert.match(html, /Garbage Truck 1/);
  assert.match(html, /Verified Enforcer/);
  assert.match(html, /Manual Route/);
  assert.match(html, />Planned</);
  assert.match(html, /data-dispatch-plan-action="view"/);
});

scenario("Q", "detail renders stops in backend stop_order", () => {
  const html = planning.dispatchPlanDetailHtml(plan({
    stops: [
      { stop_order: 2, location_name_snapshot: "Second" },
      { stop_order: 1, location_name_snapshot: "First" }
    ]
  }));
  assert.ok(html.indexOf("First") < html.indexOf("Second"));
  assert.doesNotMatch(html, /latitude|longitude|geofence/i);
});

scenario("R", "only Planned plans expose edit controls", () => {
  assert.deepEqual(planning.dispatchPlanViewPermissions("planned"), {
    canView: true,
    canEdit: true,
    canCancel: true
  });
  assert.match(planning.dispatchPlanRowsHtml([plan()]), /data-dispatch-plan-action="edit"/);
});

scenario("S", "Activated plans are read-only with no activation control", () => {
  const html = planning.dispatchPlanRowsHtml([plan({ status: "activated" })]);
  assert.deepEqual(planning.dispatchPlanViewPermissions("activated"), {
    canView: true,
    canEdit: false,
    canCancel: false
  });
  assert.doesNotMatch(html, /data-dispatch-plan-action="(?:edit|cancel|activate)"/);
  assert.doesNotMatch(planningSource, /data-dispatch-plan-action=\"activate\"/);
});

scenario("T", "Cancelled plans remain visible and read-only", () => {
  const html = planning.dispatchPlanRowsHtml([plan({
    status: "cancelled",
    cancellation_reason: "Weather"
  })]);
  assert.match(html, />Cancelled</);
  assert.doesNotMatch(html, /data-dispatch-plan-action="(?:edit|cancel)"/);
});

scenario("U", "successful PATCH refreshes plans and options", async () => {
  let method = "";
  let refreshes = 0;
  await planning.dispatchPlanRunMutation({
    request: async (url, options) => { method = options.method; return { id: 7 }; },
    url: "/api/dispatch/plans/7",
    method: "PATCH",
    payload: { route_name: "Updated" },
    refreshPlans: async () => { refreshes += 1; },
    refreshOptions: async () => { refreshes += 1; }
  });
  assert.equal(method, "PATCH");
  assert.equal(refreshes, 2);
});

scenario("V", "cancel requires a non-empty reason", () => {
  assert.equal(planning.dispatchPlanValidateCancellation("   ").valid, false);
  assert.match(planning.dispatchPlanValidateCancellation("").message, /required/);
  assert.deepEqual(planning.dispatchPlanValidateCancellation("Schedule changed"), {
    valid: true,
    value: "Schedule changed",
    message: ""
  });
});

scenario("W", "successful cancel refreshes options and list", async () => {
  let method = "";
  let refreshes = 0;
  await planning.dispatchPlanRunMutation({
    request: async (url, options) => { method = options.method; return { status: "cancelled" }; },
    url: "/api/dispatch/plans/7/cancel",
    method: "POST",
    payload: { cancellation_reason: "Schedule changed" },
    refreshPlans: async () => { refreshes += 1; },
    refreshOptions: async () => { refreshes += 1; }
  });
  assert.equal(method, "POST");
  assert.equal(refreshes, 2);
});

scenario("X", "truck conflicts are safe and trigger refresh", async () => {
  assert.match(planning.dispatchPlanErrorMessage({
    status: 409,
    code: "DISPATCH_PLAN_TRUCK_CONFLICT"
  }), /truck is already assigned/i);
  let refreshes = 0;
  await assert.rejects(
    () => planning.dispatchPlanRunMutation({
      request: async () => { const error = new Error("raw"); error.status = 409; throw error; },
      url: "/api/dispatch/plans",
      method: "POST",
      payload: {},
      refreshPlans: async () => { refreshes += 1; },
      refreshOptions: async () => { refreshes += 1; }
    }),
    /raw/
  );
  assert.equal(refreshes, 2);
});

scenario("Y", "enforcer conflicts are safe and trigger refreshed choice", () => {
  assert.match(planning.dispatchPlanErrorMessage({
    status: 409,
    code: "DISPATCH_PLAN_ENFORCER_CONFLICT"
  }), /enforcer is already assigned/i);
  assert.doesNotMatch(planning.dispatchPlanErrorMessage({
    status: 500,
    message: "SELECT password FROM users"
  }), /SELECT|password/i);
});

scenario("Z", "authorization, same-origin helpers, imports, and initialization stay isolated", () => {
  assert.equal(planning.dispatchPlanUserHasAccess({ role: "super_admin" }), true);
  assert.equal(planning.dispatchPlanUserHasAccess({ role: "personnel" }), true);
  assert.equal(planning.dispatchPlanUserHasAccess({ role: "division_admin" }), false);
  assert.match(planning.dispatchPlanErrorMessage({ status: 401 }), /session has expired/i);
  assert.match(planning.dispatchPlanErrorMessage({ status: 403 }), /permission/i);

  assert.match(apiSource, /function getDispatchPlansApiUrl\(filters = \{\}\)/);
  assert.match(apiSource, /function getDispatchPlanOptionsApiUrl\(operationalDate\)/);
  assert.match(apiSource, /function getDispatchPlanApiUrl\(planId\)/);
  assert.match(apiSource, /function getDispatchPlanCancelApiUrl\(planId\)/);
  assert.match(planningSource, /globalScope\.webAdminFetch/);
  assert.doesNotMatch(planningSource, /https?:\/\//);
  assert.doesNotMatch(planningSource, /Bearer|mobileSession/i);
  assert.doesNotMatch(planningSource, /optimi[sz]|best truck|recommended enforcer|suggested destination/i);

  assert.equal((dashboardHtml.match(/css\/admin\/admin-dispatch-plans\.css/g) || []).length, 1);
  assert.equal((dashboardHtml.match(/js\/admin\/admin-dispatch-plans\.js/g) || []).length, 1);
  assert.ok(dashboardHtml.indexOf("admin-api.js") < dashboardHtml.indexOf("admin-dispatch-plans.js"));
  assert.ok(dashboardHtml.indexOf("admin-dispatch-plans.js") < dashboardHtml.indexOf("admin-init.js"));
  assert.equal((initSource.match(/safeRun\(setupDispatchPlansModule/g) || []).length, 1);
  assert.match(dashboardHtml, /id="trackingSection"[\s\S]*id="dispatchPlansWorkspace"[\s\S]*class="page-card live-tracking-card"/);
  assert.match(planningCss, /body > \.dispatch-plan-modal\.custom-modal[\s\S]*z-index: var\(--wmo-z-modal\)/);
  assert.match(planningCss, /@media \(max-width: 560px\)[\s\S]*flex-direction: column/);

  const ids = [...dashboardHtml.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
});

async function run() {
  assert.equal(scenarios.length, 26);
  for (const current of scenarios) {
    try {
      await current.callback();
    } catch (error) {
      error.message = `${current.letter}. ${current.name}: ${error.message}`;
      throw error;
    }
  }
  console.log("Dispatch Planning UI tests passed (26/26 required scenarios).");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
