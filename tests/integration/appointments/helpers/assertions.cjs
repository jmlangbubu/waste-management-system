"use strict";

const { SafetyError, BASELINE } = require("./environment.cjs");
const { SERVICES, TIMES } = require("./schema.cjs");
const invariant = (condition, code) => { if (!condition) throw new SafetyError(`INVARIANT_${code}`); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const status = row => String(row.status || "pending").trim().toLowerCase() || "pending";
const active = row => ["pending", "approved", "rescheduled"].includes(status(row));
const safeId = value => Number.isSafeInteger(value) && value > 0;
function dateOK(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
}
function assertReservationIntegrity(snapshot) {
  invariant(snapshot && ["appointments", "reservations", "requests", "notifications"].every(k => Array.isArray(snapshot[k])), "SNAPSHOT");
  const apps = new Map(), codes = new Set(), slots = new Set(), linked = new Set(), requests = new Set(), requestApps = new Set();
  for (const row of snapshot.appointments) {
    invariant(safeId(row.id) && !apps.has(row.id), "APPOINTMENT_ID"); apps.set(row.id, row);
    if (row.appointment_code != null) { invariant(!codes.has(row.appointment_code), "REFERENCE_UNIQUENESS"); codes.add(row.appointment_code); }
    invariant(Number.isSafeInteger(row.appointment_revision) && row.appointment_revision >= 0, "REVISION");
  }
  for (const row of snapshot.reservations) {
    const app = apps.get(row.appointment_id), key = JSON.stringify([row.service_key, row.appointment_date, row.appointment_time]);
    invariant(app && !linked.has(app.id), "RESERVATION_LINK");
    invariant(Object.values(SERVICES).includes(row.service_key) && dateOK(row.appointment_date) &&
      TIMES.some(t => `${t}:00` === row.appointment_time), "SLOT");
    invariant(!slots.has(key), "CAPACITY"); slots.add(key); linked.add(app.id);
    invariant(row.service_key === SERVICES[app.purpose] && `${row.appointment_date} ${row.appointment_time}` === app.preferred_date, "SCHEDULE_LINK");
    invariant(!["rejected", "cancelled"].includes(status(app)), "RELEASE");
  }
  for (const app of apps.values()) invariant(!active(app) || linked.has(app.id), "ACTIVE_RESERVATION");
  for (const row of snapshot.requests) {
    invariant(typeof row.request_hash === "string" && /^[0-9a-f]{64}$/.test(row.request_hash) && !requests.has(row.request_hash), "IDEMPOTENCY");
    requests.add(row.request_hash);
    invariant(typeof row.payload_hash === "string" && /^[0-9a-f]{64}$/.test(row.payload_hash), "PAYLOAD_HASH");
    const app = apps.get(row.appointment_id);
    invariant(app && !requestApps.has(app.id) && row.appointment_code === app.appointment_code &&
      typeof row.appointment_code === "string" && /^APT-\d{6,}$/.test(row.appointment_code), "REQUEST_LINK");
    requestApps.add(app.id);
  }
  return true;
}
function assertBookingDelta(before, after, expectedCount) {
  invariant(Number.isSafeInteger(expectedCount) && expectedCount >= 0, "BOOKING_COUNT");
  assertReservationIntegrity(before); assertReservationIntegrity(after);
  for (const key of ["appointments", "reservations", "requests"]) invariant(after[key].length - before[key].length === expectedCount, "BOOKING_ATOMICITY");
  const notices = state => state.notifications.filter(n => n.type === "appointment").length;
  invariant(notices(after) - notices(before) === expectedCount, "NOTIFICATION_ATOMICITY");
  // Count-based notice proof requires an isolated operation: the production notice has no appointment FK.
  const oldApps = new Set(before.appointments.map(a => a.id));
  const newApps = after.appointments.filter(a => !oldApps.has(a.id));
  invariant(newApps.length === expectedCount && newApps.every(a => after.requests.some(r => r.appointment_id === a.id)), "BOOKING_LINKAGE");
  for (const [key, identity] of [["appointments", "id"], ["reservations", "appointment_id"], ["requests", "request_hash"], ["notifications", "id"]]) {
    invariant(before[key].every(row => after[key].some(other => other[identity] === row[identity] && equal(row, other))), "EXISTING_ROW_PRESERVATION");
  }
  return true;
}
function assertChange(before, after, { appointmentId, action, succeeded }) {
  invariant(safeId(appointmentId) && ["accept", "reject", "cancel", "reschedule"].includes(action) && typeof succeeded === "boolean", "CHANGE_INPUT");
  assertReservationIntegrity(before); assertReservationIntegrity(after);
  const a = before.appointments.find(r => r.id === appointmentId), b = after.appointments.find(r => r.id === appointmentId);
  invariant(a && b, "CHANGE_INPUT");
  const reservations = state => state.reservations.filter(r => r.appointment_id === appointmentId);
  if (!succeeded) {
    invariant(equal(a, b) && equal(reservations(before), reservations(after)), "FAILED_RESCHEDULE_PRESERVATION");
  } else {
    const allowed = action === "cancel" || action === "reschedule" ? ["pending", "approved", "rescheduled"] : ["pending", "rescheduled"];
    invariant(allowed.includes(status(a)), "TRANSITION");
    invariant(status(b) === ({ accept: "approved", reject: "rejected", cancel: "cancelled", reschedule: "rescheduled" })[action] &&
      b.appointment_revision === a.appointment_revision + 1, "REVISION");
    if (["reject", "cancel"].includes(action)) invariant(reservations(after).length === 0, "RELEASE");
    if (action === "reschedule") invariant(a.preferred_date !== b.preferred_date && reservations(after).length === 1, "RESCHEDULE");
    if (action !== "accept") invariant(a.assigned_to === b.assigned_to && a.assigned_at === b.assigned_at, "ACCEPTANCE_PRESERVATION");
  }
  return true;
}
function assertRecoveryUnchanged(before, after, { requestHash, appointmentId, appointmentCode }) {
  assertReservationIntegrity(before); assertReservationIntegrity(after);
  invariant(equal(before, after), "RECOVERY_MUTATION");
  invariant(after.requests.some(r => r.request_hash === requestHash && r.appointment_id === appointmentId && r.appointment_code === appointmentCode), "RECOVERY_LINK");
  return true;
}
function assertPhilippineSnapshot(instant, snapshot) {
  invariant(typeof instant === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(instant) && Number.isFinite(Date.parse(instant)), "CLOCK");
  // Independent fixed UTC+08 oracle for the modern Philippine instants in this suite.
  const expected = new Date(Date.parse(instant) + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  invariant(snapshot && snapshot.timestamp === expected && snapshot.date === expected.slice(0, 10), "PHILIPPINE_TIME");
  return true;
}
function assertTerminalDisposition(lifecycle) {
  const safe = lifecycle && lifecycle.setup === "acknowledged" && !lifecycle.unsafe && lifecycle.restore === "acknowledged" &&
    (lifecycle.commit === "acknowledged" || lifecycle.commit === "pending" && lifecycle.rollback === "acknowledged");
  invariant(!(lifecycle?.commit === "acknowledged" && lifecycle.rollback === "acknowledged"), "CONTRADICTORY_TRANSACTION");
  invariant(lifecycle && lifecycle.releaseAttempts === (safe ? 1 : 0) && lifecycle.destroyAttempts === (safe ? 0 : 1), "TERMINAL_DISPOSITION");
  if (lifecycle.outcome === "success") invariant(lifecycle.commit === "acknowledged", "UNCONFIRMED_SUCCESS");
  return true;
}
const CHECKS = Object.freeze(["capacity", "reservation-links", "request-links", "booking-atomicity", "notification-atomicity",
  "revision", "release", "failed-reschedule", "philippine-time", "terminal-disposition", "recovery-unchanged"]);
function evidenceData(value, depth = 0) {
  invariant(depth <= 6, "EVIDENCE");
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  invariant(value && typeof value === "object" && Object.getOwnPropertySymbols(value).length === 0 &&
    (Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value))), "EVIDENCE");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  invariant(Object.keys(descriptors).length <= 64 && Object.values(descriptors).every(p => Object.hasOwn(p, "value")), "EVIDENCE");
  if (Array.isArray(value)) {
    invariant(value.length <= 32 && Object.keys(descriptors).length === value.length + 1, "EVIDENCE");
    return Array.from({ length: value.length }, (_, i) => evidenceData(descriptors[i].value, depth + 1));
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, p]) => [key, evidenceData(p.value, depth + 1)]));
}
function createOfflineEvidence(input) {
  try {
    input = evidenceData(input);
    const fields = ["testId", "sourceCommit", "reportedEngineVersion", "fixtureVariant", "runId", "outcome", "counts", "checks", "failureClassification", "cleanup"];
    invariant(input && Object.keys(input).every(k => fields.includes(k)), "EVIDENCE");
    invariant(typeof input.testId === "string" && /^(?:P4A|[A-G]\d{2})(?:\.[a-z0-9_]{1,32}){0,3}$/.test(input.testId) && input.sourceCommit === BASELINE, "EVIDENCE");
    invariant(input.reportedEngineVersion === null || typeof input.reportedEngineVersion === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input.reportedEngineVersion), "EVIDENCE");
    invariant(["offline", "golden-unready", "missing-table", "wrong-type", "wrong-key", "wrong-fk"].includes(input.fixtureVariant), "EVIDENCE");
    invariant(typeof input.runId === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(input.runId), "EVIDENCE");
    invariant(["pass", "fail", "refused"].includes(input.outcome) && ["none", "environment", "unsupported-mode", "timeout", "cancelled", "assertion", "adapter-fault"].includes(input.failureClassification), "EVIDENCE");
    const countKeys = ["modelQueries", "databaseQueries", "leases", "releaseAttempts", "destroyAttempts"];
    invariant(input.counts && Object.keys(input.counts).length === countKeys.length && Object.keys(input.counts).every(k => countKeys.includes(k)) &&
      countKeys.every(k => Number.isSafeInteger(input.counts[k]) && input.counts[k] >= 0) && input.counts.databaseQueries === 0, "EVIDENCE");
    invariant(Array.isArray(input.checks) && input.checks.every(c => CHECKS.includes(c)) && ["not-needed", "disposed", "failed"].includes(input.cleanup), "EVIDENCE");
    return Object.freeze({ phase: "4A", evidenceClass: "offline-model", testId: input.testId, sourceCommit: BASELINE,
      engine: Object.freeze({ name: "MySQL", reportedVersion: input.reportedEngineVersion, connected: false, versionVerified: false }),
      fixtureVariant: input.fixtureVariant, runId: input.runId, outcome: input.outcome,
      counts: Object.freeze({ ...input.counts }), persistence: Object.freeze({ source: "synthetic-snapshot", durableVerified: false, checks: Object.freeze([...input.checks]) }),
      failureClassification: input.failureClassification, cleanup: input.cleanup });
  } catch (_) { throw new SafetyError("EVIDENCE_INVALID"); }
}
module.exports = { assertReservationIntegrity, assertBookingDelta, assertChange, assertRecoveryUnchanged,
  assertPhilippineSnapshot, assertTerminalDisposition, createOfflineEvidence };
