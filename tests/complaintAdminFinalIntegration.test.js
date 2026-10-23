const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Real complaint UI and shared webAdminFetch run in a VM. DOM, fetch,
// confirmation, multipart container and map rendering are in-memory fakes.
// No listeners, sockets, providers, real browser cookies or image files.
const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const frontend = read("frontend/js/admin/admin-complaints.js");
const api = read("frontend/js/admin/admin-api.js");
const registry = ["Synthetic A", "Synthetic B"];
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status,
  async json() { return body; }, async text() { return JSON.stringify(body); } });
const forwardAck = { success: true, complaint_id: 11, status: "forwarded",
  assigned_barangay: "Synthetic A", handling_owner: "barangay" };
const resolveAck = { success: true, complaint_id: 11, status: "resolved",
  handling_owner: "wmo", assigned_barangay: "Synthetic A", evidence_url: "/synthetic/evidence.jpg" };

test("WMO takeover controls are scoped, labeled and retain escaped decline information", () => {
  const h = harness({ status: "wmo_handling", owner: "wmo" });
  h.complaint.barangay_decline_reason = '<script>unsafe</script> — access blocked';
  h.render();
  const html = h.elements.complaintWmoHandlingOptions.innerHTML;
  assert.match(html, /<section class="complaint-wmo-panel"/);
  assert.match(html, /<h4>WMO Handling<\/h4>/);
  assert.match(html, /class="complaint-wmo-form"/);
  assert.match(html, /for="complaintWmoReport"/);
  assert.match(html, /name="resolution_report"/);
  assert.match(html, /name="evidence"/);
  assert.match(html, /&lt;script(?:>|&gt;)/);
  assert.doesNotMatch(html, /<script>/);
  const css = read("frontend/css/admin/admin-complaints.css");
  assert.match(css, /#complaintDetailsModal \.complaint-wmo-form/);
  assert.match(css, /textarea \{ resize: vertical; min-height: 112px/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*?complaint-wmo-submit \{ width: 100%/);
});

function element(value = "") {
  const classes = new Set();
  return { value, innerHTML: "", textContent: "", disabled: false, events: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); },
      contains: name => classes.has(name) },
    setAttribute() {}, addEventListener(name, handler) { this.events[name] = handler; } };
}

function harness({ status = "pending", owner = "barangay", role = "super_admin", csrf = true } = {}) {
  const state = { requests: [], alerts: [], confirmations: [], refreshes: 0, closes: 0,
    resets: [], redirects: [], maps: [], rendered: [], confirm: true };
  const complaint = { id: 11, status, handling_owner: owner, assigned_barangay: "Synthetic A",
    assignment_confirmed_at: status === "pending" ? null : "2026-10-19",
    barangay_decline_reason: "Synthetic decline reason", reporter_barangay: "Citizen text",
    latitude: 1.25, longitude: 1.75 };
  const elements = {
    complaintModalNearbyOptions: element(), complaintWmoHandlingOptions: element(), complaintAssignmentSelect: element("Synthetic A"),
    complaintAssignmentReason: element("  Admin verified the pinned location.  "),
    btnRejectComplaintFromDetails: element(), btnValidateComplaintFromDetails: element(),
    complaintRejectReason: element("Synthetic valid rejection reason"), complaintRejectReasonHint: element(),
    confirmComplaintRejectBtn: element(),
    manualBarangayContainer: element(), manualBarangaySelect: element("Hardcoded legacy value"),
    complaintsTableBody: element(), complaintsStatusFilter: { options: [{ value: "wmo_handling" }] }
  };
  const button = element();
  const form = { ...element(), elements: { resolution_report: element("Synthetic WMO report"),
    evidence: { files: [{ name: "synthetic.png", type: "image/png" }] } },
    querySelector(selector) { assert.equal(selector, "button"); return button; } };
  elements.complaintWmoResolutionForm = form;
  const dialogForm = element(), dialogCancel = element(), dialogSubmit = element();
  const dialog = { ...element(), open: false, showModal() { this.open = true; }, close() { this.open = false; },
    querySelector(selector) { return selector === "form" ? dialogForm : selector === "[data-cancel]" ? dialogCancel : dialogSubmit; } };
  class FakeFormData {
    constructor(input) {
      this.fields = { resolution_report: input.elements.resolution_report.value,
        evidence: input.elements.evidence.files[0] };
    }
  }
  const context = vm.createContext({ Headers, FormData: FakeFormData,
    currentUser: { id: 3, role }, currentComplaint: complaint, allComplaints: [], forwardingBarangayTargets: [],
    window: { addEventListener() {}, APP_CONFIG: { API_BASE_URL: "/offline" }, location: { pathname: "/admin-dashboard.html",
      replace(url) { state.redirects.push(url); } } },
    document: { cookie: csrf ? "wmo_admin_csrf=synthetic-csrf" : "",
      getElementById: id => elements[id] || null, querySelector: () => null,
      createElement(tag) { assert.equal(tag, "dialog"); return dialog; }, body: { appendChild(node) { elements[node.id] = node; } } },
    localStorage: { removeItem() {} }, L: { icon: () => ({}) },
    console: { error() {}, warn() {} },
    escapeHtml: value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    alert: message => state.alerts.push(message),
    confirm: message => { state.confirmations.push(message); return state.confirm; },
    fetch: async (url, options) => {
      state.requests.push({ url, options });
      return state.respond(url, options);
    },
    setTimeout() { /* No real timer is scheduled by this DOM harness. */ }
  });
  state.respond = url => {
    if (url.endsWith("/assignment-options")) return reply({ success: true, barangays: registry });
    if (url.endsWith("/validate-forward")) return reply(forwardAck);
    if (url.endsWith("/wmo-resolve")) return reply(resolveAck);
    if (url.endsWith("/reject")) return reply({ success: true, complaint_id: "11", message: "Synthetic rejection confirmed" });
    throw new Error(`Unmocked request: ${url}`);
  };
  vm.runInContext(api, context, { filename: "admin-api.js" });
  vm.runInContext(frontend, context, { filename: "admin-complaints.js" });
  const readList = context.loadComplaints;
  context.loadComplaints = async () => { state.refreshes++; };
  context.loadComplaintHistory = async () => {};
  context.closeComplaintModal = () => { state.closes++; };
  context.resetComplaintModalDisplay = id => state.resets.push(id);
  context.loadNearbyBarangaysForComplaint = async (lat, lng) => {
    assert.equal(lat, complaint.latitude); assert.equal(lng, complaint.longitude); return [];
  };
  context.renderComplaintDetailsMapPreview = (data, candidates) => state.maps.push({ data, candidates });
  context.renderComplaintsTable = rows => { state.rendered = rows; };
  state.gps = { success: true, complaint_id: 11, basis: "strict_polygon_suggestion", geographic_barangay: "Synthetic A" };
  context.loadComplaintMapDestination = async () => state.gps;
  return { state, context, complaint, elements, form, button, FakeFormData, readList,
    seedRegistry() { context.syntheticRegistry = registry; vm.runInContext("complaintAssignmentNames = syntheticRegistry", context); },
    async options() { await context.loadComplaintDetailsNearbyOptions(context.currentComplaint); },
    forward: () => context.validateAndForwardComplaint(),
    reject: () => context.submitComplaintRejection(),
    render() { context.renderComplaintDetailsNearbyOptions(); },
    async resolve() { assert.ok(form.events.submit, "Resolution form must be available");
      await form.events.submit({ preventDefault() {}, currentTarget: form }); } };
}

test("active registry GET uses real wrapper; forward sends one exact choice, confirmation and bounded reason", async () => {
  const h = harness(); await h.options();
  assert.match(h.elements.complaintModalNearbyOptions.innerHTML, /Needs Admin Confirmation/);
  assert.doesNotMatch(h.elements.complaintModalNearbyOptions.innerHTML, /<select|<textarea|citizen input/);
  assert.equal(h.state.maps.length, 1);
  assert.equal(h.state.requests[0].url, "/offline/complaints/assignment-options");
  assert.equal(h.state.requests[0].options.credentials, "include");
  assert.equal(h.state.requests[0].options.headers.has("X-CSRF-Token"), false);
  await h.forward();
  const request = h.state.requests[1];
  assert.equal(request.url, "/offline/complaints/11/validate-forward");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.credentials, "include");
  assert.equal(request.options.headers.get("X-CSRF-Token"), "synthetic-csrf");
  assert.deepEqual(JSON.parse(request.options.body), { selected_barangay: "Synthetic A", confirm_assignment: true,
    use_gps_match: true });
  assert.equal(h.state.refreshes, 1); assert.equal(h.state.closes, 1);
  assert.equal(h.complaint.status, "pending", "No optimistic object mutation");
});

for (const scenario of ["no match", "ambiguous", "wrong record", "no name", "cancel", "wrong role", "wrong status"]) {
  test(`forward blocks ${scenario} before POST`, async () => {
    const h = harness(); h.seedRegistry();
    if (scenario === "no match") h.state.gps = null;
    if (scenario === "ambiguous") h.state.gps.basis = "needs_admin_confirmation";
    if (scenario === "wrong record") h.state.gps.complaint_id = 22;
    if (scenario === "no name") h.state.gps.geographic_barangay = "";
    if (scenario === "nonregistry") h.elements.complaintAssignmentSelect.value = "Not registered";
    if (scenario === "multiple") h.elements.complaintAssignmentSelect.value = "Synthetic A,Synthetic B";
    if (scenario === "empty") h.elements.complaintAssignmentSelect.value = "";
    if (scenario === "blank reason") h.elements.complaintAssignmentReason.value = "  ";
    if (scenario === "long reason") h.elements.complaintAssignmentReason.value = "x".repeat(2001);
    if (scenario === "cancel") h.state.confirm = false;
    if (scenario === "wrong role") h.context.currentUser.role = "personnel";
    if (scenario === "wrong status") h.complaint.status = "forwarded";
    await h.forward(); assert.equal(h.state.requests.length, 0); assert.equal(h.state.refreshes, 0);
  });
}

test("missing CSRF uses existing wrapper rejection and enqueues no mutation", async () => {
  const h = harness({ csrf: false }); h.seedRegistry(); await h.forward();
  assert.equal(h.state.requests.length, 0); assert.equal(h.state.refreshes, 0);
  assert.match(h.state.alerts[0], /verification token/);
});

for (const status of [401, 403, 409, 503]) {
  for (const action of ["forward", "resolve"]) {
    test(`${action} HTTP ${status} preserves screen state, shows server message and does not retry`, async () => {
      const h = harness(action === "resolve" ? { status: "wmo_handling", owner: "wmo" } : {});
      h.seedRegistry(); h.render();
      h.state.respond = () => reply({ success: false, message: `Synthetic ${status} denial` }, status);
      await (action === "resolve" ? h.resolve() : h.forward());
      assert.equal(h.state.requests.length, 1); assert.equal(h.state.refreshes, 0); assert.equal(h.state.closes, 0);
      assert.equal(h.state.alerts[0], `Synthetic ${status} denial`);
      assert.equal(h.complaint.status, action === "resolve" ? "wmo_handling" : "pending");
      assert.equal(h.state.redirects.length, status === 401 ? 1 : 0);
    });
  }
}

for (const body of [{ success: true }, { ...forwardAck, complaint_id: 99 },
  { ...forwardAck, status: "resolved" }, { ...forwardAck, assigned_barangay: "Synthetic B" },
  { ...forwardAck, handling_owner: "wmo" }, { ...forwardAck, success: "true" }]) {
  test(`forward refuses mismatched/ambiguous acknowledgement ${JSON.stringify(body)}`, async () => {
    const h = harness(); h.seedRegistry(); h.state.respond = () => reply(body);
    await h.forward(); assert.equal(h.state.refreshes, 0); assert.equal(h.state.closes, 0);
    assert.equal(h.state.alerts.length, 1);
  });
}

test("original idempotent forward response without optional owner is accepted", async () => {
  const h = harness(); h.seedRegistry(); h.state.respond = () => reply({ success: true,
    complaint_id: "11", status: "forwarded", assigned_barangay: "Synthetic A", idempotent: true });
  await h.forward(); assert.equal(h.state.refreshes, 1);
});

test("WMO form posts original multipart fields with CSRF and no forced JSON content type", async () => {
  const h = harness({ status: "wmo_handling", owner: "wmo" }); h.render();
  assert.match(h.elements.complaintWmoHandlingOptions.innerHTML, /Synthetic decline reason/);
  await h.resolve(); const request = h.state.requests[0];
  assert.equal(request.url, "/offline/complaints/11/wmo-resolve"); assert.equal(request.options.method, "PUT");
  assert.equal(request.options.credentials, "include");
  assert.equal(request.options.headers.get("X-CSRF-Token"), "synthetic-csrf");
  assert.equal(request.options.headers.has("Content-Type"), false);
  assert.ok(request.options.body instanceof h.FakeFormData);
  assert.equal(request.options.body.fields.resolution_report, "Synthetic WMO report");
  assert.equal(request.options.body.fields.evidence, h.form.elements.evidence.files[0]);
  assert.equal(h.state.refreshes, 1); assert.equal(h.state.closes, 1); assert.equal(h.button.disabled, false);
  assert.equal(h.complaint.status, "wmo_handling");
});

for (const settings of [{ status: "pending", owner: "wmo" }, { status: "forwarded", owner: "barangay" },
  { status: "in_progress", owner: "barangay" }, { status: "wmo_handling", owner: "barangay" },
  { status: "wmo_handling", owner: null }, { status: "wmo_handling", owner: "wmo", role: "personnel" },
  { status: "resolved", owner: "wmo" }, { status: "rejected", owner: "wmo" }]) {
  test(`WMO Resolve absent for ${JSON.stringify(settings)}`, () => {
    const h = harness(settings); h.render();
    assert.doesNotMatch(h.elements.complaintModalNearbyOptions.innerHTML, /id="complaintWmoResolutionForm"/);
    assert.equal(h.form.events.submit, undefined);
    h.context.syncComplaintDetailsActionButtons(settings.status);
    assert.equal(h.elements.btnValidateComplaintFromDetails.disabled, !(settings.status === "pending" && settings.role !== "personnel"));
  });
}

for (const variation of ["blank report", "long report", "missing evidence", "owner changed", "selection changed"]) {
  test(`WMO submit blocks ${variation} without a request`, async () => {
    const h = harness({ status: "wmo_handling", owner: "wmo" }); h.render();
    if (variation === "blank report") h.form.elements.resolution_report.value = " ";
    if (variation === "long report") h.form.elements.resolution_report.value = "x".repeat(2001);
    if (variation === "missing evidence") h.form.elements.evidence.files = [];
    if (variation === "owner changed") h.complaint.handling_owner = "barangay";
    if (variation === "selection changed") h.context.currentComplaint = { ...h.complaint, id: 22 };
    await h.resolve(); assert.equal(h.state.requests.length, 0);
  });
}

for (const body of [{ success: true }, { ...resolveAck, complaint_id: 99 },
  { ...resolveAck, status: "in_progress" }, { ...resolveAck, handling_owner: "barangay" },
  { ...resolveAck, assigned_barangay: "Synthetic B" }, { ...resolveAck, evidence_url: "" }]) {
  test(`WMO refuses mismatched acknowledgement ${JSON.stringify(body)}`, async () => {
    const h = harness({ status: "wmo_handling", owner: "wmo" }); h.render(); h.state.respond = () => reply(body);
    await h.resolve(); assert.equal(h.state.refreshes, 0); assert.equal(h.state.closes, 0);
    assert.equal(h.state.alerts.length, 1);
  });
}

test("pending action cannot be submitted twice while the first request is unresolved", async () => {
  const h = harness(); h.seedRegistry(); let complete;
  h.state.respond = () => new Promise(resolve => { complete = resolve; });
  const pending = h.forward(); await h.forward(); assert.equal(h.state.requests.length, 1);
  complete(reply(forwardAck)); await pending; assert.equal(h.state.refreshes, 1);
});

test("unavailable GPS lookup blocks validation without selecting a fallback", async () => {
  const h = harness(); h.context.loadComplaintMapDestination = async () => null;
  await h.context.validateComplaintFromDetails();
  assert.equal(h.state.requests.length, 0);
  assert.match(h.state.alerts.at(-1), /Admin review/);
});
test("Validate confirms the detected name with no selection/reason popup", async () => {
  const h = harness(); h.state.confirm = false;
  await h.context.validateComplaintFromDetails();
  assert.equal(h.state.requests.length, 0);
  assert.match(h.state.confirmations[0], /GPS-detected Barangay: Synthetic A/);
  assert.equal(h.elements.complaintAssignmentDialog, undefined);
  h.state.confirm = true;
  await h.context.validateComplaintFromDetails();
  assert.equal(h.state.requests.length, 1);
  assert.deepEqual(JSON.parse(h.state.requests[0].options.body), {selected_barangay:"Synthetic A",confirm_assignment:true,use_gps_match:true});
});
test("switching complaints while GPS lookup is pending cannot forward", async () => {
  const h = harness(); let complete;
  h.context.loadComplaintMapDestination = () => new Promise(resolve => { complete = resolve; });
  const pending = h.forward(); h.context.currentComplaint = {id:22,status:"pending"};
  complete({success:true,complaint_id:11,basis:"strict_polygon_suggestion",geographic_barangay:"Synthetic A"});
  await pending; assert.equal(h.state.requests.length, 0);
});

test("older registry response cannot overwrite a newer request for the same complaint", async () => {
  const h = harness(); let complete;
  h.state.respond = () => new Promise(resolve => { complete = resolve; });
  const older = h.options();
  h.state.respond = () => reply({ success: true, barangays: registry }); await h.options();
  complete(reply({ success: true, barangays: ["Stale option"] })); await older;
  await h.forward(); // A valid registry choice still passes; only action ACK is now deliberately invalid.
  assert.equal(h.state.requests.length, 3);
  assert.equal(h.state.requests[2].options.method, "POST");
});

test("legacy hardcoded select is hidden/disabled; only registry choice can assign", () => {
  const h = harness(); h.context.updateManualBarangayVisibility(h.complaint);
  assert.equal(h.elements.manualBarangayContainer.style.display, "none");
  assert.equal(h.elements.manualBarangaySelect.disabled, true);
  assert.equal(h.elements.manualBarangaySelect.value, "");
});

test("actual list reader includes forwarded/in_progress/WMO handling and excludes terminal rows", async () => {
  const h = harness(); h.state.respond = () => reply({ success: true,
    complaints: ["pending", "forwarded", "in_progress", "wmo_handling", "resolved", "rejected"].map((status, id) => ({ id, status })) });
  await h.readList();
  assert.deepEqual(Array.from(h.state.rendered, row => row.status), ["pending", "forwarded", "in_progress", "wmo_handling"]);
  assert.equal(h.state.requests[0].options.method, "GET");
  for (const [status, label] of Object.entries({ pending: "Pending", forwarded: "Forwarded",
    in_progress: "In Progress", wmo_handling: "WMO handling", resolved: "Resolved", rejected: "Rejected" })) {
    assert.equal(h.context.formatComplaintStatusLabel(status), label);
  }
  assert.equal(h.context.formatComplaintStatusLabel("wmo_handling"), "WMO handling");
});

test("detail open has no Accept or mutation endpoint; existing evidence/map hooks remain", () => {
  const block = frontend.slice(frontend.indexOf("function openComplaintModal(data)"), frontend.indexOf("function closeComplaintModal()"));
  assert.doesNotMatch(block, /\/accept|method:\s*["'](?:PUT|POST|PATCH)/);
  assert.match(block, /renderComplaintDetailsMapPreview/); assert.match(block, /enableImagePreview/);
  assert.match(block, /data.latitude/); assert.match(block, /data.longitude/);
});

for (const action of ["forward", "resolve"]) {
  for (const failure of ["network", "invalid JSON"]) {
    test(`${action} ${failure} never refreshes or retries an ambiguous mutation`, async () => {
      const h = harness(action === "resolve" ? { status: "wmo_handling", owner: "wmo" } : {});
      h.seedRegistry(); h.render();
      h.state.respond = () => {
        if (failure === "network") throw new Error("Synthetic connection timeout; outcome unknown");
        return { ok: true, status: 200, async json() { throw new SyntaxError("Synthetic non-JSON response"); } };
      };
      await (action === "resolve" ? h.resolve() : h.forward());
      assert.equal(h.state.requests.length, 1); assert.equal(h.state.refreshes, 0); assert.equal(h.state.closes, 0);
      assert.equal(h.state.alerts.length, 1);
    });
  }
}

test("confirmed old forward response refreshes list without closing another complaint", async () => {
  const h = harness(); h.seedRegistry(); let complete, started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  h.state.respond = () => new Promise(resolve => { complete = resolve; started(); });
  const pending = h.forward(); await requestStarted; const other = { ...h.complaint, id: 22 };
  h.context.currentComplaint = other; complete(reply(forwardAck)); await pending;
  assert.equal(h.state.closes, 0); assert.equal(h.state.refreshes, 1);
  assert.equal(h.context.currentComplaint, other);
});

test("rejection keeps existing endpoint/body, CSRF wrapper and confirmed-only refresh", async () => {
  const h = harness(); await h.reject();
  assert.equal(h.state.requests[0].url, "/offline/complaints/11/reject");
  assert.equal(h.state.requests[0].options.method, "PATCH");
  assert.equal(h.state.requests[0].options.headers.get("X-CSRF-Token"), "synthetic-csrf");
  assert.equal(JSON.parse(h.state.requests[0].options.body).rejection_reason, "Synthetic valid rejection reason");
  assert.equal(h.state.refreshes, 1); assert.equal(h.context.currentComplaint, null);
});

for (const settings of [{ status: "forwarded" }, { status: "in_progress" }, { status: "wmo_handling" },
  { status: "resolved" }, { status: "rejected" }, { role: "personnel" }]) {
  test(`rejection blocked for ${JSON.stringify(settings)}`, async () => {
    const h = harness(settings); await h.reject(); assert.equal(h.state.requests.length, 0);
  });
}

for (const body of [{}, { success: true }, { success: true, complaint_id: 99 }]) {
  test(`rejection refuses ambiguous acknowledgement ${JSON.stringify(body)}`, async () => {
    const h = harness(); h.state.respond = () => reply(body); await h.reject();
    assert.equal(h.state.refreshes, 0); assert.equal(h.context.currentComplaint, h.complaint);
  });
}
