const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const planning = require("../frontend/js/admin/admin-dispatch-plans");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");
const planningSource = read("frontend/js/admin/admin-dispatch-plans.js");
const apiSource = read("frontend/js/admin/admin-api.js");
const initSource = read("frontend/js/admin/admin-init.js");
const navigationSource = read("frontend/js/admin/admin-navigation.js");
const dashboardHtml = read("frontend/admin-dashboard.html");
const planningCss = read("frontend/css/admin/admin-dispatch-plans.css");

function countId(id) {
  return (dashboardHtml.match(new RegExp(`\\bid="${id}"`, "g")) || []).length;
}

function elementMarkupById(id) {
  const opening = new RegExp(`<([a-z][\\w-]*)\\b[^>]*\\bid="${id}"[^>]*>`, "i").exec(dashboardHtml);
  assert.ok(opening, `Expected #${id} to exist`);
  const tagName = opening[1];
  const tags = new RegExp(`</?${tagName}\\b[^>]*>`, "gi");
  tags.lastIndex = opening.index;
  let depth = 0;
  let match;
  while ((match = tags.exec(dashboardHtml))) {
    if (match[0].startsWith("</")) depth -= 1;
    else if (!match[0].endsWith("/>")) depth += 1;
    if (depth === 0) return dashboardHtml.slice(opening.index, tags.lastIndex);
  }
  assert.fail(`Expected #${id} to have a closing tag`);
}

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function apiResponse(data) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data })
  };
}

function classList(initial = []) {
  const classes = new Set(initial);
  return {
    add: (...names) => names.forEach((name) => classes.add(name)),
    remove: (...names) => names.forEach((name) => classes.delete(name)),
    contains: (name) => classes.has(name),
    toggle: (name, force) => {
      if (force === true) classes.add(name);
      else if (force === false) classes.delete(name);
      else if (classes.has(name)) classes.delete(name);
      else classes.add(name);
      return classes.has(name);
    }
  };
}

function installDetailDom(request) {
  const previous = new Map(
    ["document", "webAdminFetch", "getDispatchPlanApiUrl", "getDispatchTicketApiUrl"]
      .map((key) => [key, {
        present: Object.prototype.hasOwnProperty.call(global, key),
        value: global[key]
      }])
  );
  const detailBody = { innerHTML: "" };
  const detailModal = {
    hidden: true,
    classList: classList(["hidden"]),
    setAttribute() {},
    querySelector: () => null
  };
  const documentStub = {
    activeElement: null,
    documentElement: { classList: classList() },
    body: { classList: classList() },
    getElementById(id) {
      if (id === "dispatchPlanDetailBody") return detailBody;
      if (id === "dispatchPlanDetailModal") return detailModal;
      return null;
    },
    querySelector(selector) {
      if (selector === ".dispatch-plan-modal:not(.hidden)") {
        return detailModal.classList.contains("hidden") ? null : detailModal;
      }
      return null;
    }
  };
  global.document = documentStub;
  global.webAdminFetch = request;
  global.getDispatchPlanApiUrl = (id) => `/plans/${id}`;
  global.getDispatchTicketApiUrl = (id) => `/tickets/${id}`;
  return {
    detailBody,
    detailModal,
    restore() {
      for (const [key, state] of previous) {
        if (state.present) global[key] = state.value;
        else delete global[key];
      }
    }
  };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

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
  }, [{ destination_id: 101 }]);
  assert.deepEqual(payload, {
    operational_date: "2026-08-30",
    fleet_truck_id: 4,
    assigned_enforcer_user_id: 11,
    stops: [{ destination_id: 101, stop_order: 1 }]
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
  assert.doesNotMatch(html, /Manual Route|2026-08-30 08:00:00|2026-08-30 16:00:00/);
  assert.equal((html.match(/<td>/g) || []).length, 6);
  assert.match(html, />Planned</);
  assert.match(html, /data-dispatch-plan-action="view"/);
});

scenario("Q", "detail renders stops in backend stop_order", () => {
  const html = planning.dispatchPlanDetailHtml(plan({
    stops: [
      { stop_order: 2, location_name_snapshot: "Second", expected_arrival: "2026-08-30 10:00:00" },
      { stop_order: 1, location_name_snapshot: "First", expected_arrival: "2026-08-30 09:00:00" }
    ]
  }));
  assert.ok(html.indexOf("First") < html.indexOf("Second"));
  assert.match(html, /Waiting for tracking/);
  assert.match(html, /Actual Arrival/);
  assert.doesNotMatch(html, /Expected|Route Name|Scheduled Start|Expected Return|Description|Notes/);
  assert.doesNotMatch(html, /latitude|longitude|geofence/i);
});

scenario("AA", "stop cards explain tracking-controlled arrival without an input", () => {
  const html = planning.dispatchPlanStopRowsHtml([{
    destination_id: 101,
    stop_order: 1,
    display_label: "Pioneer Avenue",
    barangay: "Verified destination"
  }]);
  assert.match(html, /Pioneer Avenue/);
  assert.match(html, /Arrival/);
  assert.match(html, /Recorded automatically during tracking/);
  assert.doesNotMatch(html, /datetime-local|data-plan-stop-arrival|Expected Arrival/);
  assert.doesNotMatch(planningSource, /dispatchPlanHandleStopInput|data-plan-stop-arrival/);
});

scenario("AB", "legacy expected arrival survives reorder but never becomes Actual Arrival", () => {
  const reordered = planning.dispatchPlanMoveStopInList([
    { destination_id: 101, expected_arrival: "2026-08-30 09:00:00" },
    { destination_id: 102 }
  ], 0, "down");
  assert.deepEqual(planning.dispatchPlanBuildPayload({
    operational_date: "2026-08-30",
    fleet_truck_id: 4,
    assigned_enforcer_user_id: 11
  }, reordered).stops, [
    { destination_id: 102, stop_order: 1 },
    { destination_id: 101, stop_order: 2, expected_arrival: "2026-08-30 09:00:00" }
  ]);

  const html = planning.dispatchPlanDetailHtml(plan({
    status: "activated",
    activated_dispatch_ticket_id: 70,
    stops: [{
      stop_order: 1,
      location_name_snapshot: "Pioneer Avenue",
      expected_arrival: "2026-08-30 09:00:00"
    }]
  }), {
    stops: [{
      stop_order: 1,
      stop_status: "arrived",
      actual_arrival_at: "2026-09-09 14:35:00"
    }]
  });
  assert.match(html, /Arrived/);
  assert.match(html, /Sep 9, 2026 · 2:35 PM/);
  assert.doesNotMatch(html, /Aug 30|Expected/);
});

scenario("AC", "activated detail reuses ticket API and isolates ticket failure", async () => {
  const calls = [];
  const loaded = await planning.dispatchPlanLoadDetail(7, {
    getPlanUrl: (id) => `/plans/${id}`,
    getTicketUrl: (id) => `/tickets/${id}`,
    request: async (url) => {
      calls.push(url);
      return url.startsWith("/plans/")
        ? plan({ activated_dispatch_ticket_id: 70 })
        : { stops: [{ stop_order: 1, actual_arrival_at: null }] };
    }
  });
  assert.deepEqual(calls, ["/plans/7", "/tickets/70"]);
  assert.equal(loaded.ticketUnavailable, false);

  const degraded = await planning.dispatchPlanLoadDetail(7, {
    getPlanUrl: () => "/plans/7",
    getTicketUrl: () => "/tickets/70",
    request: async (url) => {
      if (url.startsWith("/tickets/")) throw new Error("temporary");
      return plan({
        activated_dispatch_ticket_id: 70,
        stops: [{ stop_order: 1, location_name_snapshot: "Pioneer Avenue" }]
      });
    }
  });
  assert.equal(degraded.ticketUnavailable, true);
  assert.match(
    planning.dispatchPlanDetailHtml(degraded.plan, null, { ticketUnavailable: true }),
    /Tracking status temporarily unavailable/
  );
});

scenario("AD", "form and table markup expose only the simplified planning flow", () => {
  const formMarkup = elementMarkupById("dispatchPlanFormModal");
  assert.match(formMarkup, />1<[\s\S]*>Assignment</);
  assert.match(formMarkup, />2<[\s\S]*>Ordered Verified Destinations</);
  assert.match(formMarkup, />3<[\s\S]*>Review</);
  assert.doesNotMatch(formMarkup, /dispatchPlan(?:RouteName|Description|ScheduledStart|ExpectedReturn|Notes)/);
  assert.doesNotMatch(formMarkup, /Schedule and Route Information|Expected Arrival/);
  const parentMarkup = elementMarkupById("dispatchPlanningModal");
  assert.match(parentMarkup, /<th>Date<\/th>[\s\S]*<th>Truck<\/th>[\s\S]*<th>Enforcer<\/th>[\s\S]*<th>Stops<\/th>[\s\S]*<th>Status<\/th>[\s\S]*<th>Actions<\/th>/);
  assert.doesNotMatch(parentMarkup, /<th>Route<\/th>|<th>Schedule<\/th>/);
  assert.doesNotMatch(planningSource, /colspan="8"/);
  assert.match(planningSource, /colspan="6"/);
});

scenario("AE", "later plan selection wins when plan responses resolve out of order", async () => {
  const planA = deferred();
  const planB = deferred();
  const dom = installDetailDom((url) => {
    if (url === "/plans/1") return planA.promise;
    if (url === "/plans/2") return planB.promise;
    throw new Error(`Unexpected URL: ${url}`);
  });
  try {
    const openingA = planning.openDispatchPlanDetail(1);
    const openingB = planning.openDispatchPlanDetail(2);
    planB.resolve(apiResponse(plan({ id: 2, truck_name_snapshot: "Plan B Truck" })));
    await openingB;
    assert.match(dom.detailBody.innerHTML, /Plan B Truck/);
    const renderedB = dom.detailBody.innerHTML;

    planA.resolve(apiResponse(plan({ id: 1, truck_name_snapshot: "Plan A Truck" })));
    await openingA;
    assert.equal(dom.detailBody.innerHTML, renderedB);
    assert.doesNotMatch(dom.detailBody.innerHTML, /Plan A Truck/);
  } finally {
    planning.closeDispatchPlanningModalsForNavigation();
    dom.restore();
  }
});

scenario("AF", "late linked-ticket response cannot overwrite a newer plan", async () => {
  const ticketA = deferred();
  const calls = [];
  const dom = installDetailDom((url) => {
    calls.push(url);
    if (url === "/plans/1") {
      return Promise.resolve(apiResponse(plan({
        id: 1,
        activated_dispatch_ticket_id: 101,
        truck_name_snapshot: "Plan A Truck",
        stops: [{ stop_order: 1, location_name_snapshot: "Plan A Stop" }]
      })));
    }
    if (url === "/tickets/101") return ticketA.promise;
    if (url === "/plans/2") {
      return Promise.resolve(apiResponse(plan({ id: 2, truck_name_snapshot: "Plan B Truck" })));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  try {
    const openingA = planning.openDispatchPlanDetail(1);
    await nextTurn();
    assert.ok(calls.includes("/tickets/101"));

    const openingB = planning.openDispatchPlanDetail(2);
    await openingB;
    assert.match(dom.detailBody.innerHTML, /Plan B Truck/);
    const renderedB = dom.detailBody.innerHTML;

    ticketA.resolve(apiResponse({
      stops: [{
        stop_order: 1,
        stop_status: "arrived",
        actual_arrival_at: "2026-09-09 14:35:00"
      }]
    }));
    await openingA;
    assert.equal(dom.detailBody.innerHTML, renderedB);
    assert.doesNotMatch(dom.detailBody.innerHTML, /Plan A Stop|Sep 9, 2026/);
  } finally {
    planning.closeDispatchPlanningModalsForNavigation();
    dom.restore();
  }
});

scenario("AG", "closing detail invalidates a pending response", async () => {
  assert.match(
    planningSource,
    /function dispatchPlanCloseModal\(id\)[\s\S]*id === "dispatchPlanDetailModal"[\s\S]*dispatchPlanInvalidateDetailRequest\(\)/
  );
  const pending = deferred();
  const dom = installDetailDom(() => pending.promise);
  try {
    const opening = planning.openDispatchPlanDetail(1);
    planning.closeDispatchPlanningModalsForNavigation();
    const contentAfterClose = dom.detailBody.innerHTML;
    assert.equal(dom.detailModal.classList.contains("hidden"), true);

    pending.resolve(apiResponse(plan({ id: 1, truck_name_snapshot: "Late Plan" })));
    await opening;
    assert.equal(dom.detailBody.innerHTML, contentAfterClose);
    assert.doesNotMatch(dom.detailBody.innerHTML, /Late Plan/);
    assert.equal(dom.detailModal.classList.contains("hidden"), true);
  } finally {
    planning.closeDispatchPlanningModalsForNavigation();
    dom.restore();
  }
});

scenario("AH", "stale rejection cannot replace the current plan with an error", async () => {
  const planA = deferred();
  const dom = installDetailDom((url) => {
    if (url === "/plans/1") return planA.promise;
    if (url === "/plans/2") {
      return Promise.resolve(apiResponse(plan({ id: 2, truck_name_snapshot: "Plan B Truck" })));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  try {
    const openingA = planning.openDispatchPlanDetail(1);
    await planning.openDispatchPlanDetail(2);
    const renderedB = dom.detailBody.innerHTML;
    assert.match(renderedB, /Plan B Truck/);

    planA.reject(new Error("Stale Plan A failure"));
    await openingA;
    assert.equal(dom.detailBody.innerHTML, renderedB);
    assert.doesNotMatch(dom.detailBody.innerHTML, /Stale Plan A failure/);
  } finally {
    planning.closeDispatchPlanningModalsForNavigation();
    dom.restore();
  }
});

scenario("AI", "current detail request still renders its safe error state", async () => {
  const dom = installDetailDom(async () => ({
    ok: false,
    status: 503,
    json: async () => ({ code: "DISPATCH_PLAN_DATABASE_ERROR" })
  }));
  try {
    const result = await planning.openDispatchPlanDetail(1);
    assert.equal(result, null);
    assert.match(dom.detailBody.innerHTML, /Dispatch planning is temporarily unavailable/);
    assert.match(dom.detailBody.innerHTML, /dispatch-plan-feedback error/);
    assert.equal(dom.detailModal.classList.contains("hidden"), false);
  } finally {
    planning.closeDispatchPlanningModalsForNavigation();
    dom.restore();
  }
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
  assert.equal(countId("openDispatchPlanningBtn"), 1);
  assert.equal(countId("dispatchPlanningModal"), 1);
  assert.equal(countId("dispatchPlansWorkspace"), 1);
  const parentMarkup = elementMarkupById("dispatchPlanningModal");
  assert.match(parentMarkup, /id="dispatchPlansWorkspace"/);
  assert.match(parentMarkup, /id="dispatchPlansTitle"/);
  assert.match(parentMarkup, /id="dispatchPlansRefreshBtn"/);
  assert.match(parentMarkup, /id="dispatchPlanCreateBtn"/);
  assert.match(parentMarkup, /id="dispatchPlansDateFilter"/);
  assert.match(parentMarkup, /id="dispatchPlansStatusFilter"/);
  assert.match(parentMarkup, /id="dispatchPlansTableBody"/);
  assert.doesNotMatch(parentMarkup, /id="dispatchPlan(?:Form|Detail|Cancel)Modal"/);
  [
    "dispatchPlansWorkspace",
    "dispatchPlansTitle",
    "dispatchPlansRefreshBtn",
    "dispatchPlanCreateBtn",
    "dispatchPlansDateFilter",
    "dispatchPlansStatusFilter",
    "dispatchPlansTableBody",
    "dispatchPlanFormModal",
    "dispatchPlanDetailModal",
    "dispatchPlanCancelModal"
  ].forEach((id) => assert.equal(countId(id), 1, `Expected one #${id}`));
  assert.match(planningCss, /body > \.dispatch-plan-modal\.custom-modal[\s\S]*z-index: var\(--wmo-z-modal\)/);
  assert.match(planningCss, /@media \(max-width: 560px\)[\s\S]*flex-direction: column/);
  assert.match(planningCss, /#dispatchPlanningModal > \.dispatch-planning-parent-content[\s\S]*width: min\(1280px/);
  assert.match(planningCss, /body > \.dispatch-plan-modal\.custom-modal:not\(\.hidden\)[\s\S]*z-index: calc\(var\(--wmo-z-modal\) \+ 40\)/);
  assert.match(planningCss, /html\.dispatch-plan-modal-open,\s*body\.dispatch-plan-modal-open\s*\{[\s\S]*overflow: hidden !important/);
  assert.match(planningCss, /html\.dispatch-plan-modal-open body #adminLayout #dashboardSidebar[\s\S]*z-index: calc\(var\(--wmo-z-modal\) \+ 80\)[\s\S]*pointer-events: none/);
  assert.match(planningCss, /html\.dispatch-plan-modal-open body #dashboardSidebar \.nav-btn,[\s\S]*#sidebarLogoToggleBtn[\s\S]*pointer-events: auto/);
  assert.match(planningCss, /html\.dispatch-plan-modal-open body #adminLayout #mobileSidebarToggleBtn[\s\S]*z-index: calc\(var\(--wmo-z-modal\) \+ 90\)/);
  assert.match(planningCss, /html\.dispatch-plan-modal-open body #adminLayout #sidebarBackdrop:not\(\.hidden\)[\s\S]*z-index: calc\(var\(--wmo-z-modal\) \+ 70\)/);
  assert.match(planningSource, /DISPATCH_PLAN_CHILD_MODAL_IDS = Object\.freeze\(\[[\s\S]*dispatchPlanFormModal[\s\S]*dispatchPlanDetailModal[\s\S]*dispatchPlanCancelModal/);
  assert.match(planningSource, /function dispatchPlanMountModals[\s\S]*document\.body\.appendChild\(modal\)/);
  assert.match(planningSource, /function openDispatchPlanningParentModal[\s\S]*void loadDispatchPlans\(\)/);
  assert.match(planningSource, /function dispatchPlanSyncModalScrollLock[\s\S]*dispatchPlanningModal[\s\S]*dispatchPlanHasOpenChildModal[\s\S]*document\.documentElement\.classList\.toggle\("dispatch-plan-modal-open", shouldLock\)[\s\S]*document\.body\.classList\.toggle\("dispatch-plan-modal-open", shouldLock\)/);
  assert.match(planningSource, /returnFocus: null,[\s\S]*parentReturnFocus: null/);
  assert.match(planningSource, /function dispatchPlanSetTriggerAccess[\s\S]*openDispatchPlanningBtn/);
  const escapeBlock = planningSource.match(/document\.addEventListener\("keydown"[\s\S]*?\n    \}\);/)?.[0] || "";
  assert.ok(escapeBlock.indexOf("dispatch-plan-modal:not(.hidden)") < escapeBlock.indexOf("dispatchPlanningModal"));
  assert.match(navigationSource, /closeDispatchPlanningModalsForNavigation/);
  assert.match(navigationSource, /closeAllAdminModalsOnNavigation\(\);\s*showSection\(sectionId\);/);
  assert.match(navigationSource, /document\.documentElement\.classList\.remove\("dispatch-plan-modal-open"\)/);
  assert.match(planningSource, /dispatchPlanCreateBtn[\s\S]*openCreateDispatchPlan/);
  assert.match(planningSource, /data-dispatch-plan-action[\s\S]*action === "view"[\s\S]*action === "edit"[\s\S]*action === "cancel"/);

  const ids = [...dashboardHtml.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
});

async function run() {
  assert.equal(scenarios.length, 35);
  for (const current of scenarios) {
    try {
      await current.callback();
    } catch (error) {
      error.message = `${current.letter}. ${current.name}: ${error.message}`;
      throw error;
    }
  }
  console.log("Dispatch Planning UI tests passed (35/35 required scenarios).");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
