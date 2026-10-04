const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "frontend/admin-dashboard.html"), "utf8");
const source = fs.readFileSync(path.join(root, "frontend/js/admin/admin-orientation.js"), "utf8");
const appointmentSource = fs.readFileSync(path.join(root, "frontend/js/admin/admin-appointments.js"), "utf8");
const utilsSource = fs.readFileSync(path.join(root, "frontend/js/admin/admin-utils.js"), "utf8");
const orientationCss = fs.readFileSync(path.join(root, "frontend/css/admin/admin-orientation.css"), "utf8");

function decodeHtml(value) {
  const entities = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#039;": "'" };
  return value.replace(/&amp;|&lt;|&gt;|&quot;|&#039;/g, (entity) => entities[entity]);
}

function createBarangaySelect() {
  let markup = "";
  let options = [];
  let value = "all";
  const select = {
    get innerHTML() { return markup; },
    set innerHTML(next) {
      markup = next;
      options = Array.from(next.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g), (match) => ({
        value: decodeHtml(match[1]), textContent: decodeHtml(match[2])
      }));
      value = options[0]?.value || "";
    },
    get options() { return options; },
    get selectedOptions() { return options.filter((option) => option.value === value); },
    get value() { return value; },
    set value(next) { value = options.some((option) => option.value === next) ? next : ""; }
  };
  select.innerHTML = '<option value="all">All Barangays</option>';
  return select;
}

function dateOffset(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function loadUi() {
  const queueBody = { innerHTML: "" };
  const historyBody = { innerHTML: "" };
  const searchInput = { value: "" };
  const barangayFilter = createBarangaySelect();
  const historyShell = { scrollLeft: 120, scrollTop: 80 };
  const modalClasses = new Set(["hidden"]);
  const historyModal = { classList: {
    add(value) { modalClasses.add(value); },
    remove(value) { modalClasses.delete(value); },
    contains(value) { return modalClasses.has(value); }
  } };
  const nodes = {
    orientationQueueTableBody: queueBody,
    orientationHistoryTableBody: historyBody,
    orientationHistorySearchInput: searchInput,
    orientationHistoryBarangayFilter: barangayFilter,
    orientationHistoryModal: historyModal,
    openOrientationHistoryBtn: {},
    closeOrientationHistoryBtn: {},
    orientationHistoryOverlay: {}
  };
  const fetchCalls = [];
  const context = {
    window: {},
    orientationAppointments: [],
    fetch(...args) {
      fetchCalls.push(args);
      throw new Error("Unexpected API request in a client-only UI test");
    },
    document: {
      addEventListener() {},
      getElementById(id) { return nodes[id] || null; },
      querySelector(selector) { return selector === "#orientationHistoryModal .table-shell" ? historyShell : null; }
    },
    formatSimpleDate(value) { return String(value); }
  };
  vm.createContext(context);
  vm.runInContext(utilsSource.match(/function escapeHtml\(value\) \{[\s\S]*?\n\}/)[0], context);
  vm.runInContext(source, context);
  context.ensureOrientationHistoryReportLayoutStyles = () => {};
  return { context, queueBody, historyBody, searchInput, barangayFilter, historyShell, historyModal, nodes, fetchCalls };
}

function record(id, preferredDate, extra = {}) {
  return {
    id,
    full_name: `Participant ${id}`,
    barangay: "Test Barangay",
    purpose: "SWM Orientation & Clearance",
    preferred_date: preferredDate,
    status: "approved",
    orientation_status: "approved",
    ...extra
  };
}

test("Orientation tab has exactly one queue table and no Active/Upcoming subsection", () => {
  const orientationPanel = html.split('id="appointmentsOrientationPanel"')[1].split('id="appointmentsHistoryPanel"')[0];
  assert.equal((orientationPanel.match(/<table\b/g) || []).length, 1);
  assert.equal((orientationPanel.match(/id="orientationQueueTableBody"/g) || []).length, 1);
  assert.doesNotMatch(orientationPanel, /Active Orientation|Upcoming Orientations|orientationCardList|upcomingOrientationTableBody/);
  assert.match(orientationPanel, /<th>Name<\/th><th>Barangay<\/th><th>Scheduled Date<\/th><th>Purpose<\/th><th>Status<\/th><th>Action<\/th>/);
});

test("future, today, started, failed and ready records share the one status-driven queue", () => {
  const { context, queueBody } = loadUi();
  const records = [
    record(1, dateOffset(1)),
    record(2, dateOffset(0)),
    record(3, dateOffset(-1), { orientation_status: "pending_orientation", orientation_started_at: "2026-09-26 09:00:00" }),
    record(4, dateOffset(-1), { orientation_status: "failed_orientation", orientation_score: 2 }),
    record(5, dateOffset(-1), { orientation_status: "ready_for_retake", orientation_score: 2 })
  ];
  const queue = context.getOrientationQueueRecords(records);
  assert.deepEqual(Array.from(queue, (item) => item.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(Array.from(queue, (item) => context.getOrientationStatusLabel(item)), [
    "Upcoming", "Pending Orientation", "Orientation in Progress", "Failed – Retake Required", "Ready for Retake"
  ]);
  context.renderOrientationQueue(queue);
  assert.equal((queueBody.innerHTML.match(/<tr>/g) || []).length, 5);
  assert.match(queueBody.innerHTML, /Allow Retake/);
  assert.match(queueBody.innerHTML, /Mark as Incomplete/);
  assert.match(queueBody.innerHTML, /Open QR Code/);
  assert.doesNotMatch(queueBody.innerHTML, /Take Web Exam|orientation-web-btn/);
  assert.equal(typeof context.window.openOrientationWebExam, "function");
});

test("terminal records stay out of queue and no-show keeps its lifecycle label without a report score", () => {
  const { context, queueBody, historyBody } = loadUi();
  const completed = record(6, dateOffset(-1), { status: "completed", orientation_status: "completed_orientation", orientation_score: 9 });
  const incomplete = record(7, dateOffset(-1), { orientation_status: "incomplete_orientation", orientation_score: 2 });
  const noShow = record(8, dateOffset(-1), { orientation_status: "no_show", orientation_score: null });
  assert.equal(context.getOrientationQueueRecords([completed, incomplete, noShow]).length, 0);
  for (const item of [completed, incomplete, noShow]) assert.equal(context.isOrientationHistoryRecord(item), true);
  assert.equal(context.getOrientationStatusLabel(completed), "Completed");
  assert.equal(context.getOrientationStatusLabel(incomplete), "Incomplete");
  assert.equal(context.getOrientationStatusLabel(noShow), "Did Not Attend");
  context.renderOrientationQueue([]);
  assert.match(queueBody.innerHTML, /No orientation records available\./);
  context.renderOrientationHistory([noShow]);
  assert.match(historyBody.innerHTML, /Participant 8/);
  assert.match(historyBody.innerHTML, /Test Barangay/);
  assert.match(historyBody.innerHTML, /SWM Orientation &amp; Clearance/);
  const cells = Array.from(historyBody.innerHTML.matchAll(/<td>(.*?)<\/td>/g), (match) => match[1]);
  assert.deepEqual(cells, ["8", "Participant 8", "Test Barangay", dateOffset(-1), "SWM Orientation &amp; Clearance", "-", "-", "-"]);
  assert.doesNotMatch(historyBody.innerHTML, /orientation-status|Did Not Attend|>no_show</);
});

test("purpose-filtered API rows render in the queue despite omitting purpose", async () => {
  const { context, queueBody } = loadUi();
  const current = record(9, dateOffset(0));
  delete current.purpose;
  context.getOrientationAppointmentsApiUrl = () => "/api/appointments/orientation";
  context.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ success: true, appointments: [current] }) });
  await context.loadOrientationAppointments();
  assert.match(queueBody.innerHTML, /Participant 9/);
  assert.match(queueBody.innerHTML, /Pending Orientation/);
});

test("browser does not infer no-show or incomplete solely from an elapsed date", () => {
  const { context } = loadUi();
  const pastApproved = record(10, dateOffset(-1));
  const pastStarted = record(11, dateOffset(-1), { orientation_status: "pending_orientation" });
  assert.equal(context.getOrientationLifecycleStatus(pastApproved), "approved");
  assert.equal(context.getOrientationLifecycleStatus(pastStarted), "pending_orientation");
  assert.equal(context.getOrientationStatusLabel(pastStarted), "Orientation in Progress");
  assert.doesNotMatch(source, /No active orientation records for today\.|renderUpcomingOrientation/);
});

test("Appointment History also distinguishes Did Not Attend from failed and completed", () => {
  assert.match(appointmentSource, /function getOrientationAppointmentHistoryStatus/);
  assert.match(appointmentSource, /return "no_show"/);
  assert.match(appointmentSource, /Did Not Attend/);
  assert.match(appointmentSource, /getOrientationAppointmentHistoryStatus\(app\)/);
});

test("Orientation report has the requested eight headers and accessible client-side controls", () => {
  const report = html.split('id="orientationHistoryModal"')[1].split('id="editUserModal"')[0];
  const headers = Array.from(report.matchAll(/<th>(.*?)<\/th>/g), (match) => match[1]);
  assert.deepEqual(headers, ["ID No.", "Name", "Barangay", "Scheduled Date", "Service", "Date Started", "Date Completed", "Score"]);
  assert.match(report, /id="orientationHistorySearchInput"[^>]*placeholder="Search by ID or name\.\.\."[^>]*aria-label="Search orientation history by ID or name"/);
  assert.match(report, /id="orientationHistoryBarangayFilter"[^>]*aria-label="Filter orientation history by barangay"/);
  assert.match(report, /<option value="all">All Barangays<\/option>/);
  assert.match(report, /colspan="8"/);
});

test("report-only positioning neutralizes legacy tablet offsets and keeps the mobile ID header readable", () => {
  const contentRule = orientationCss.match(/#orientationHistoryModal \.history-modal-content\s*\{([^}]+)\}/)[1];
  for (const side of ["top", "right", "bottom", "left"]) {
    assert.match(contentRule, new RegExp(`${side}: auto !important;`));
  }
  assert.match(contentRule, /transform: none !important;/);
  assert.match(orientationCss, /#orientationHistoryModal \.table-shell\s*\{[^}]*overflow: auto;/);
  const columnWidths = Array.from(source.matchAll(/tbody td:nth-child\(\d\) \{ width: (\d+)% !important;/g), (match) => Number(match[1]));
  assert.equal(columnWidths.length, 8);
  assert.equal(columnWidths.reduce((sum, width) => sum + width, 0), 100);
  // At the 860px mobile table minimum, allow >=44px after 16px side padding.
  assert.ok(860 * columnWidths[0] / 100 - 32 >= 44);
});

test("history filters combine literal case-insensitive ID/name search and barangay without changing source order", () => {
  const { context } = loadUi();
  const rows = [
    record(121, "2026-09-20", { full_name: "Ana Santos", barangay: " Alpha " }),
    record(21, "2026-09-19", { full_name: "ANA Cruz", barangay: "Beta" }),
    record(300, "2026-09-18", { full_name: "Mark [A]", barangay: "ALPHA" })
  ];
  const ids = (search, barangay) => Array.from(context.filterOrientationHistoryRecords(rows, search, barangay), (item) => item.id);
  assert.deepEqual(ids("", "all"), [121, 21, 300]);
  assert.deepEqual(ids("  ANA  ", "ALL"), [121, 21]);
  assert.deepEqual(ids("21", "all"), [121, 21]);
  assert.deepEqual(ids("ana", " aLpHa "), [121]);
  assert.deepEqual(ids("", "alpha"), [121, 300]);
  assert.deepEqual(ids("[A]", "alpha"), [300]);
  assert.deepEqual(ids("ana", "Gamma"), []);
  assert.deepEqual(rows.map((item) => item.id), [121, 21, 300]);
});

test("history renders real IDs, nullish fallback, all eight cells, escaped fields and zero score", () => {
  const { context, historyBody } = loadUi();
  const completed = record(0, "2026-09-20", {
    full_name: '<img src=x onerror="bad()">', barangay: "A & B", purpose: "Service <test>",
    orientation_status: "completed_orientation", orientation_score: 0,
    orientation_started_at: "2026-09-20 08:00:00", orientation_completed_at: "2026-09-20 09:00:00"
  });
  context.renderOrientationHistory([completed]);
  const cells = Array.from(historyBody.innerHTML.matchAll(/<td>(.*?)<\/td>/g), (match) => match[1]);
  assert.deepEqual(cells, ["0", "&lt;img src=x onerror=&quot;bad()&quot;&gt;", "A &amp; B", "2026-09-20", "Service &lt;test&gt;", "2026-09-20 08:00:00", "2026-09-20 09:00:00", "0"]);
  assert.doesNotMatch(historyBody.innerHTML, /<img|orientation-status/);
  assert.equal(context.getOrientationHistoryId({ id: null, appointment_id: 99, appointment_code: "APT-000099" }), "-");
  assert.equal(context.getOrientationHistoryId({ appointment_id: 99 }), "-");
  context.renderOrientationHistory([record(undefined, "2026-09-20", { orientation_status: "incomplete_orientation", orientation_score: null })]);
  assert.match(historyBody.innerHTML, /<tr>\s*<td>-<\/td>/);
  assert.match(historyBody.innerHTML, /<td>-<\/td>\s*<\/tr>/);
  context.renderOrientationHistory([record('<id "bad">', "2026-09-20")]);
  assert.match(historyBody.innerHTML, /<td>&lt;id &quot;bad&quot;&gt;<\/td>/);
});

test("barangay options use the full history, are unique and escaped, and survive search and refresh", () => {
  const { context, searchInput, barangayFilter, historyBody } = loadUi();
  const rows = [
    record(3, "2026-09-23", { full_name: "Newest", barangay: "Alpha" }),
    record(2, "2026-09-22", { full_name: "Older", barangay: " alpha " }),
    record(1, "2026-09-21", { full_name: "Oldest", barangay: 'B & "C" <option>' }),
    record(0, "2026-09-20", { barangay: null })
  ];
  context.renderOrientationHistory(rows);
  assert.deepEqual(barangayFilter.options.map((option) => option.value), ["all", "alpha", 'b & "c" <option>']);
  assert.match(barangayFilter.innerHTML, /value="b &amp; &quot;c&quot; &lt;option&gt;"/);
  assert.match(barangayFilter.innerHTML, />B &amp; &quot;C&quot; &lt;option&gt;<\/option>/);
  searchInput.value = "Newest";
  barangayFilter.value = "alpha";
  context.renderOrientationHistory(rows);
  assert.equal(barangayFilter.options.length, 3);
  assert.equal(barangayFilter.value, "alpha");
  assert.match(historyBody.innerHTML, /Newest/);
  assert.doesNotMatch(historyBody.innerHTML, /Older|Oldest/);
  context.renderOrientationHistory([record(4, "2026-09-24", { barangay: "Beta" })]);
  assert.equal(searchInput.value, "Newest");
  assert.equal(barangayFilter.value, "alpha");
  assert.equal(barangayFilter.selectedOptions[0].textContent, "Alpha");
  assert.match(historyBody.innerHTML, /No orientation history records match the current filters\./);
});

test("default/all renders newest first, filtering keeps that order, and no matches can be cleared", () => {
  const { context, searchInput, barangayFilter, historyBody } = loadUi();
  const rows = [
    record(11, "2026-09-20", { full_name: "Match oldest", barangay: "Alpha" }),
    record(12, "2026-09-22", { full_name: "Match newest", barangay: "Alpha" }),
    record(13, "2026-09-21", { full_name: "Other middle", barangay: "Beta" })
  ];
  const renderedIds = () => Array.from(historyBody.innerHTML.matchAll(/<tr>\s*<td>(.*?)<\/td>/g), (match) => match[1]);
  context.renderOrientationHistory(rows);
  assert.deepEqual(renderedIds(), ["12", "13", "11"]);
  assert.deepEqual(rows.map((item) => item.id), [11, 12, 13]);
  searchInput.value = "Match";
  barangayFilter.value = "alpha";
  context.renderOrientationHistory(rows);
  assert.deepEqual(renderedIds(), ["12", "11"]);
  searchInput.value = "does not exist";
  context.renderOrientationHistory(rows);
  assert.match(historyBody.innerHTML, /colspan="8" class="empty-state"/);
  searchInput.value = "";
  barangayFilter.value = "all";
  context.renderOrientationHistory(rows);
  assert.deepEqual(renderedIds(), ["12", "13", "11"]);
  context.renderOrientationHistory([]);
  assert.match(historyBody.innerHTML, /colspan="8">No orientation history records yet\./);
});

test("filter events bind once, preserve table shell scroll, use cached records and make no API requests", () => {
  const { context, searchInput, barangayFilter, historyBody, historyShell, historyModal, fetchCalls } = loadUi();
  const rows = [
    record(31, "2026-09-21", { full_name: "Alex", barangay: "Alpha", orientation_status: "completed_orientation" }),
    record(32, "2026-09-22", { full_name: "Alex B", barangay: "Beta", orientation_status: "incomplete_orientation" })
  ];
  context.orientationAppointments = rows;
  context.renderOrientationHistory(rows);
  let renders = 0;
  const render = context.renderOrientationHistory;
  context.renderOrientationHistory = (records) => { renders += 1; return render(records); };
  context.setupOrientationHistoryModal();
  context.setupOrientationHistoryModal();
  searchInput.value = "aLeX";
  searchInput.oninput();
  assert.equal(renders, 1);
  barangayFilter.value = "alpha";
  barangayFilter.onchange();
  assert.equal(renders, 2);
  assert.match(historyBody.innerHTML, /<td>31<\/td>/);
  assert.doesNotMatch(historyBody.innerHTML, /<td>32<\/td>/);
  assert.deepEqual(historyShell, { scrollLeft: 120, scrollTop: 80 });
  context.openOrientationHistoryModal();
  assert.equal(historyModal.classList.contains("hidden"), false);
  assert.deepEqual(historyShell, { scrollLeft: 0, scrollTop: 80 });
  assert.equal(searchInput.value, "aLeX");
  assert.equal(barangayFilter.value, "alpha");

  historyShell.scrollLeft = 160;
  searchInput.oninput();
  barangayFilter.onchange();
  assert.deepEqual(historyShell, { scrollLeft: 160, scrollTop: 80 });
  context.closeOrientationHistoryModal();
  assert.equal(historyModal.classList.contains("hidden"), true);
  assert.deepEqual(historyShell, { scrollLeft: 160, scrollTop: 80 });
  context.openOrientationHistoryModal();
  assert.equal(historyModal.classList.contains("hidden"), false);
  assert.deepEqual(historyShell, { scrollLeft: 0, scrollTop: 80 });
  assert.equal(searchInput.value, "aLeX");
  assert.equal(barangayFilter.value, "alpha");
  assert.deepEqual(fetchCalls, []);

  context.document.querySelector = () => null;
  assert.doesNotThrow(() => context.openOrientationHistoryModal());
});

test("an API refresh replaces cached history without clearing search or barangay selection", async () => {
  const { context, searchInput, barangayFilter, historyBody } = loadUi();
  const terminal = (id, name) => record(id, "2026-09-20", {
    full_name: name, barangay: "Alpha", orientation_status: "completed_orientation"
  });
  context.renderOrientationHistory([terminal(41, "Ana first")]);
  context.setupOrientationHistoryModal();
  searchInput.value = "Ana";
  barangayFilter.value = "alpha";
  const calls = [];
  context.getOrientationAppointmentsApiUrl = () => "/api/appointments/orientation";
  context.fetch = async (url) => {
    calls.push(url);
    return { ok: true, text: async () => JSON.stringify({ success: true, appointments: [terminal(42, "Ana refreshed"), terminal(43, "Other")] }) };
  };
  await context.loadOrientationAppointments();
  assert.deepEqual(calls, ["/api/appointments/orientation"]);
  assert.equal(searchInput.value, "Ana");
  assert.equal(barangayFilter.value, "alpha");
  assert.match(historyBody.innerHTML, /Ana refreshed/);
  assert.doesNotMatch(historyBody.innerHTML, /Ana first|Other/);
  searchInput.value = "43";
  searchInput.oninput();
  assert.match(historyBody.innerHTML, /Other/);
  assert.deepEqual(calls, ["/api/appointments/orientation"]);
});
