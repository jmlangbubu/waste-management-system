const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "frontend/admin-dashboard.html"), "utf8");
const source = fs.readFileSync(path.join(root, "frontend/js/admin/admin-orientation.js"), "utf8");

function dateOffset(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function loadUi() {
  const upcomingBody = { innerHTML: "" };
  const cardList = { innerHTML: "" };
  const historyBody = { innerHTML: "" };
  const context = {
    window: {},
    document: {
      addEventListener() {},
      getElementById(id) {
        return {
          upcomingOrientationTableBody: upcomingBody,
          orientationCardList: cardList,
          orientationHistoryTableBody: historyBody
        }[id] || null;
      }
    },
    escapeHtml(value) { return String(value); },
    formatSimpleDate(value) { return String(value); }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, upcomingBody, cardList, historyBody };
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

test("Orientation Queue has inline upcoming records and no global Upcoming button/modal", () => {
  assert.match(html, /id="upcomingOrientationTableBody"/);
  assert.match(html, /Upcoming Orientations/);
  assert.doesNotMatch(html, /id="openUpcomingOrientationBtn"|id="upcomingOrientationModal"/);
  assert.doesNotMatch(source, /openUpcomingOrientationModal|setupUpcomingOrientationModal/);
});

test("future records appear only in Upcoming with a per-record status", () => {
  const { context, upcomingBody } = loadUi();
  const today = record(1, dateOffset(0));
  const future = record(2, dateOffset(1));
  const records = [today, future];
  const active = context.getActiveOrientationRecords(records);
  const upcoming = context.getUpcomingOrientationRecords(records);

  assert.deepEqual(Array.from(active, (item) => item.id), [1]);
  assert.deepEqual(Array.from(upcoming, (item) => item.id), [2]);
  assert.equal(context.getOrientationStatusLabel(today), "Pending Orientation");
  assert.equal(context.getOrientationStatusLabel(future), "Upcoming");
  context.renderUpcomingOrientation(upcoming);
  assert.match(upcomingBody.innerHTML, /Participant 2/);
  assert.match(upcomingBody.innerHTML, /Upcoming/);
  assert.doesNotMatch(upcomingBody.innerHTML, /Participant 1/);
});

test("started orientation keeps a human-readable in-progress label", () => {
  const { context } = loadUi();
  const started = record(3, dateOffset(0), {
    orientation_status: "pending_orientation",
    orientation_started_at: new Date().toISOString()
  });
  assert.equal(context.getOrientationStatusLabel(started), "Orientation in Progress");
});

test("purpose-filtered orientation API rows render despite omitting the purpose column", async () => {
  const { context } = loadUi();
  const current = record(4, dateOffset(0));
  delete current.purpose;
  let rendered = [];
  context.getOrientationAppointmentsApiUrl = () => "/api/appointments/orientation";
  context.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({ success: true, appointments: [current] })
  });
  context.renderActiveOrientation = (records) => { rendered = Array.from(records); };
  context.renderUpcomingOrientation = () => {};
  context.renderOrientationHistory = () => {};
  await context.loadOrientationAppointments();
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].purpose, "SWM Orientation & Clearance");
});

test("failed and ready-for-retake records remain active even after their scheduled date", () => {
  const { context, cardList } = loadUi();
  const failed = record(5, dateOffset(-1), { orientation_status: "failed_orientation", orientation_score: 2 });
  const ready = record(6, dateOffset(-1), { orientation_status: "ready_for_retake", orientation_score: 2 });
  const active = context.getActiveOrientationRecords([failed, ready]);
  assert.deepEqual(Array.from(active, (item) => item.id), [5, 6]);
  assert.equal(context.getOrientationStatusLabel(failed), "Failed – Retake Required");
  assert.equal(context.getOrientationStatusLabel(ready), "Ready for Retake");
  assert.equal(context.isOrientationHistoryRecord(failed), false);
  assert.equal(context.isOrientationHistoryRecord(ready), false);
  context.renderActiveOrientation(active);
  assert.match(cardList.innerHTML, /Allow Retake/);
  assert.match(cardList.innerHTML, /Mark as Incomplete/);
  assert.doesNotMatch(cardList.innerHTML, /Cancel Orientation/);
});

test("completed and incomplete records leave the active queue and appear in history", () => {
  const { context } = loadUi();
  const completed = record(7, dateOffset(0), { status: "completed", orientation_status: "completed_orientation", orientation_completed_at: "2026-09-26" });
  const incomplete = record(8, dateOffset(0), { orientation_status: "incomplete_orientation", orientation_completed_at: "2026-09-26" });
  assert.equal(context.getActiveOrientationRecords([completed, incomplete]).length, 0);
  assert.equal(context.isOrientationHistoryRecord(completed), true);
  assert.equal(context.isOrientationHistoryRecord(incomplete), true);
  assert.equal(context.getOrientationStatusLabel(completed), "Completed");
  assert.equal(context.getOrientationStatusLabel(incomplete), "Incomplete");
});
