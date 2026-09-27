const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "frontend/admin-dashboard.html"), "utf8");
const source = fs.readFileSync(path.join(root, "frontend/js/admin/admin-orientation.js"), "utf8");
const appointmentSource = fs.readFileSync(path.join(root, "frontend/js/admin/admin-appointments.js"), "utf8");

function dateOffset(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function loadUi() {
  const queueBody = { innerHTML: "" };
  const historyBody = { innerHTML: "" };
  const context = {
    window: {},
    document: {
      addEventListener() {},
      getElementById(id) {
        return { orientationQueueTableBody: queueBody, orientationHistoryTableBody: historyBody }[id] || null;
      }
    },
    escapeHtml(value) { return String(value); },
    formatSimpleDate(value) { return String(value); }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.ensureOrientationHistoryReportLayoutStyles = () => {};
  return { context, queueBody, historyBody };
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
  assert.match(queueBody.innerHTML, /Take Web Exam/);
});

test("terminal records stay out of queue and no-show is Did Not Attend in report without a score", () => {
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
  assert.match(historyBody.innerHTML, /SWM Orientation & Clearance/);
  assert.match(historyBody.innerHTML, /Did Not Attend/);
  assert.doesNotMatch(historyBody.innerHTML, />no_show</);
  assert.match(historyBody.innerHTML, /<td>-<\/td>/);
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
