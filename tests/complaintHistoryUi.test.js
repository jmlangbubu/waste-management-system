const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const html = read("frontend/admin-dashboard.html");
const source = read("frontend/js/admin/admin-complaints.js");
const css = read("frontend/css/admin/admin-complaints.css");
const modalHtml = html.split('id="complaintHistoryModal"')[1].split('id="complaintResolutionModal"')[0];
const columns = ["id", "subject", "citizen", "assigned", "forwarded", "status", "date", "action"];

function node() {
  const classes = new Set();
  return {
    dataset: {}, events: {}, innerHTML: "", value: "", textContent: "",
    style: { setProperty() {}, removeProperty() {} },
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
    addEventListener(name, handler) { this.events[name] = handler; },
    focus() { this.focused = true; }
  };
}

function loadUi() {
  const ids = [
    "complaintHistoryModal", "complaintHistoryTableBody", "complaintHistoryFilterToolbar",
    "complaintHistorySearchInput", "clearComplaintHistorySearchBtn", "complaintHistoryBarangayFilter",
    "complaintHistoryFilterMeta", "complaintResolutionModal"
  ];
  const nodes = Object.fromEntries(ids.map((id) => [id, node()]));
  const header = node();
  const content = node();
  const hint = node();
  const shell = node();
  const scroll = { ...node(), parentElement: shell, scrollLeft: 120, scrollTop: 80 };
  const animationFrames = [];
  const headers = Array.from(modalHtml.matchAll(/<th\b[^>]*>([^<]*)<\/th>/g), (match) => ({ textContent: match[1] }));
  const table = {
    ...node(),
    closest: () => scroll,
    querySelector: () => ({ children: headers })
  };
  nodes.complaintHistoryTableBody.closest = () => table;
  nodes.complaintHistoryModal.querySelector = (selector) => ({
    ".history-modal-header": header,
    ".history-modal-content": content,
    ".complaint-history-scroll-hint": hint
  }[selector] || null);
  nodes.complaintResolutionModal.querySelector = () => content;
  nodes.complaintResolutionModal.querySelectorAll = () => [];
  let optionsHtml = "";
  Object.defineProperty(nodes.complaintHistoryBarangayFilter, "innerHTML", {
    get: () => optionsHtml,
    set(value) {
      optionsHtml = value;
      this.options = Array.from(value.matchAll(/<option value="([^"]*)"/g), (match) => ({ value: match[1] }));
    }
  });
  const context = {
    window: { addEventListener() {} }, L: { icon: () => ({}) }, complaintHistoryRecords: [], currentComplaintResolution: null,
    console: { error() {}, warn() {}, log() {} }, setTimeout() {},
    requestAnimationFrame(callback) { animationFrames.push(callback); },
    document: {
      getElementById: (id) => nodes[id] || null,
      querySelector: (selector) => selector === "#complaintHistoryModal .complaint-history-table-scroll" ? scroll : null,
      createElement: () => node(),
      head: { appendChild(element) { nodes[element.id] = element; } }
    },
    fetch() { throw new Error("Unexpected network request in mocked UI test"); }
  };
  vm.createContext(context);
  vm.runInContext(read("frontend/js/admin/admin-utils.js"), context);
  vm.runInContext(source, context);
  return { context, nodes, headers, scroll, animationFrames };
}

function record(id, extra = {}) {
  return {
    id, subject: "Missed collection", citizen_name: "Test Citizen", assigned_barangay: "North",
    forwarded_to_barangays: "North & South", status: "resolved", resolved_at: "2026-10-01 09:30:00",
    ...extra
  };
}

function search(ui, value) {
  ui.nodes.complaintHistorySearchInput.value = value;
  ui.nodes.complaintHistorySearchInput.events.input();
}

test("history declares eight semantic columns with ID No immediately before Subject", () => {
  const headers = Array.from(modalHtml.matchAll(/<th\b[^>]*>([^<]*)<\/th>/g), (match) => match[1]);
  assert.match(headers[0], /^ID No\.?$/);
  assert.deepEqual(headers.slice(1), ["Subject", "Citizen", "Assigned Barangay", "Forwarded Barangays", "Status", "Date", "Action"]);
  for (const column of columns) {
    assert.match(modalHtml, new RegExp(`class="complaint-history-${column}-column"`));
    assert.match(css, new RegExp(`#complaintHistoryModal \\.complaint-history-table \\.complaint-history-${column}-column`));
  }
  assert.match(modalHtml, /colspan="8" class="loading-state"/);
  assert.match(css, /min-width:\s*1280px !important/);
  assert.doesNotMatch(source.slice(source.indexOf("function ensureComplaintHistoryForwardedColumnStyles"), source.indexOf("function getComplaintHistoryBarangayValue")), /nth-child|min-width:\s*0/);
  assert.match(source, /placeholder="Search by ID, subject, or citizen\.\.\."/);
});

test("history opening and reopening reset only horizontal scroll, not subsequent filtering or manual scrolling", () => {
  const ui = loadUi();
  const { context, nodes, scroll, animationFrames } = ui;
  context.complaintHistoryRecords = [record(902), record(903, { assigned_barangay: "South" })];
  context.mountComplaintModalsToBody = () => {};
  context.openComplaintModalWithPosition = () => nodes.complaintHistoryModal.classList.remove("hidden");
  context.applyComplaintModalPosition = () => {};
  let loads = 0;
  context.loadComplaintHistory = () => { loads += 1; };
  const flushFrames = () => { while (animationFrames.length) animationFrames.shift()(); };

  context.openComplaintHistoryModal();
  flushFrames();
  assert.equal(scroll.scrollLeft, 0);
  assert.equal(scroll.scrollTop, 80);
  assert.equal(loads, 1);

  scroll.scrollLeft = 240;
  context.renderComplaintHistoryTable(context.complaintHistoryRecords);
  search(ui, "902");
  nodes.complaintHistoryBarangayFilter.value = "North";
  nodes.complaintHistoryBarangayFilter.events.change();
  nodes.clearComplaintHistorySearchBtn.events.click();
  assert.equal(scroll.scrollLeft, 240);
  assert.equal(scroll.scrollTop, 80);

  context.closeComplaintHistoryModal();
  assert.equal(nodes.complaintHistoryModal.classList.contains("hidden"), true);
  assert.equal(scroll.scrollLeft, 240);
  context.openComplaintHistoryModal();
  flushFrames();
  assert.equal(nodes.complaintHistoryModal.classList.contains("hidden"), false);
  assert.equal(scroll.scrollLeft, 0);
  assert.equal(scroll.scrollTop, 80);
  assert.equal(loads, 2);

  context.document.querySelector = () => null;
  context.openComplaintHistoryModal();
  assert.doesNotThrow(flushFrames);
});

test("render uses actual complaint IDs, keeps eight cells and does not duplicate the forwarded header", () => {
  const { context, nodes, headers } = loadUi();
  const records = [record(902), record(17, { status: "accepted_overdue" })];
  context.renderComplaintHistoryTable(records);
  const rows = nodes.complaintHistoryTableBody.innerHTML.match(/<tr>[\s\S]*?<\/tr>/g);
  assert.equal(rows.length, 2);
  rows.forEach((row, index) => {
    assert.equal((row.match(/<td\b/g) || []).length, 8);
    assert.match(row, new RegExp(`<td class="complaint-history-id-column">${records[index].id}<\\/td>\\s*<td class="complaint-history-subject-column">`));
    assert.match(row, new RegExp(`data-resolution-id="${records[index].id}"`));
  });
  assert.match(rows[1], /complaint-history-status accepted-overdue[\s\S]*?Overdue/);
  context.renderComplaintHistoryTable(records.slice().reverse());
  assert.equal(headers.length, 8);
  assert.match(nodes.complaintHistoryTableBody.innerHTML, /complaint-history-id-column">17<\/td>/);
  assert.equal(nodes.complaintHistoryFilterMeta.textContent, "2 records");
});

test("ID display escapes API values and uses only a nullish fallback", () => {
  const { context, nodes } = loadUi();
  context.renderComplaintHistoryTable([record('<ID&"7>'), record(null), record(undefined), record(0)]);
  const cells = Array.from(nodes.complaintHistoryTableBody.innerHTML.matchAll(/class="complaint-history-id-column">([^<]*)<\/td>/g), (match) => match[1]);
  assert.deepEqual(cells, ["&lt;ID&amp;&quot;7&gt;", "-", "-", "0"]);
  assert.match(nodes.complaintHistoryTableBody.innerHTML, /data-resolution-id="&lt;ID&amp;&quot;7&gt;"/);
  assert.doesNotMatch(nodes.complaintHistoryTableBody.innerHTML, /<ID&/);
});

test("ID search intersects existing barangay filtering and clearing search preserves the filter", () => {
  const ui = loadUi();
  ui.context.complaintHistoryRecords = [record(902), record(903, { assigned_barangay: "South" }), record(904, { status: "forwarded" })];
  ui.context.renderComplaintHistoryTable(ui.context.complaintHistoryRecords);
  search(ui, " 902 ");
  assert.match(ui.nodes.complaintHistoryTableBody.innerHTML, /data-resolution-id="902"/);
  assert.doesNotMatch(ui.nodes.complaintHistoryTableBody.innerHTML, /data-resolution-id="903"/);
  assert.equal(ui.nodes.complaintHistoryFilterMeta.textContent, "1 of 3 shown");
  ui.nodes.complaintHistoryBarangayFilter.value = "South";
  ui.nodes.complaintHistoryBarangayFilter.events.change();
  assert.match(ui.nodes.complaintHistoryTableBody.innerHTML, /colspan="8".*No complaint history matches/);
  ui.nodes.clearComplaintHistorySearchBtn.events.click();
  assert.equal(ui.nodes.complaintHistorySearchInput.value, "");
  assert.equal(ui.nodes.complaintHistorySearchInput.focused, true);
  assert.equal(ui.nodes.complaintHistoryBarangayFilter.value, "South");
  assert.match(ui.nodes.complaintHistoryTableBody.innerHTML, /data-resolution-id="903"/);
  assert.doesNotMatch(ui.nodes.complaintHistoryBarangayFilter.innerHTML, /Awaiting Acceptance/);
});

test("existing subject, citizen, forwarded barangay, status and date searches still match", () => {
  const ui = loadUi();
  ui.context.complaintHistoryRecords = [record(902, { description: "Illegal dumping near creek" })];
  ui.context.renderComplaintHistoryTable(ui.context.complaintHistoryRecords);
  for (const query of ["missed collection", "test citizen", "illegal dumping", "south", "resolved", "2026-10-01"]) {
    search(ui, query);
    assert.match(ui.nodes.complaintHistoryTableBody.innerHTML, /data-resolution-id="902"/, query);
  }
  assert.equal(ui.context.getComplaintHistoryBarangayValue(record(904, { status: "forwarded" })), "Awaiting Acceptance");
  assert.match(ui.context.renderComplaintHistoryAssignedBarangay(record(904, { status: "forwarded" })), /Awaiting Acceptance/);
  assert.match(ui.context.renderComplaintHistoryForwardedBarangays(record(904)), /North[\s\S]*?South/);
});

test("View delegation keeps the real ID and the resolution modal selects that same record", () => {
  const { context, nodes } = loadUi();
  const records = [record(902), record(17)];
  context.complaintHistoryRecords = records;
  context.renderComplaintHistoryTable(records);
  const actualOpen = context.openComplaintResolutionModal;
  let clickedId;
  context.openComplaintResolutionModal = (id) => { clickedId = id; };
  context.setupComplaintResolutionModal();
  nodes.complaintHistoryTableBody.events.click({ target: {
    closest(selector) {
      assert.equal(selector, "[data-resolution-id]");
      return { getAttribute: () => "17" };
    }
  } });
  assert.equal(clickedId, "17");
  context.mountComplaintModalsToBody = () => {};
  context.ensureComplaintResolutionStateStyles = () => {};
  context.ensureResolutionEvidenceComparisonDom = () => {};
  context.renderCitizenEvidenceImage = () => {};
  context.renderResolutionEvidenceImage = () => {};
  let openedModal;
  context.openComplaintModalWithPosition = (id) => { openedModal = id; };
  actualOpen(clickedId);
  assert.equal(context.currentComplaintResolution, records[1]);
  assert.equal(openedModal, "complaintResolutionModal");
  assert.equal(nodes.complaintHistoryModal.classList.contains("hidden"), true);
  let closedModal;
  context.resetComplaintModalDisplay = (id) => { closedModal = id; };
  context.closeComplaintHistoryModal();
  assert.equal(closedModal, "complaintHistoryModal");
});

test("history GET loading and error states span all eight columns without any real request", async () => {
  const { context, nodes } = loadUi();
  context.getComplaintsApiUrl = () => "/api/complaints";
  let respond;
  context.fetch = (url, options) => {
    assert.equal(url, "/api/complaints/history/resolved");
    assert.equal(options, undefined);
    return new Promise((resolve) => { respond = resolve; });
  };
  const pending = context.loadComplaintHistory();
  assert.match(nodes.complaintHistoryTableBody.innerHTML, /colspan="8".*Loading complaint history/);
  respond({ ok: true, json: async () => ({ success: true, complaints: [record(902)] }) });
  await pending;
  assert.match(nodes.complaintHistoryTableBody.innerHTML, /complaint-history-id-column">902<\/td>/);
  context.fetch = async () => ({ ok: false, json: async () => ({ success: false }) });
  await context.loadComplaintHistory();
  assert.match(nodes.complaintHistoryTableBody.innerHTML, /colspan="8".*Failed to load complaint history/);
});

test("empty history state spans all eight columns", () => {
  const { context, nodes } = loadUi();
  context.renderComplaintHistoryTable([]);
  assert.match(nodes.complaintHistoryTableBody.innerHTML, /colspan="8".*No complaint history found/);
  assert.equal(nodes.complaintHistoryFilterMeta.textContent, "No records");
});
