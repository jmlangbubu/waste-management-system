"use strict";

const SERVICES = Object.freeze({
  "SWM Orientation & Clearance": "orientation",
  "Accreditation": "accreditation",
  "IEC Resource Speaker": "iec_resource_speaker",
  "Others": "others"
});
const TIMES = Object.freeze(["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"]);
const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
function serviceKey(service) {
  if (typeof service !== "string" || !Object.hasOwn(SERVICES, service)) {
    throw fail(400, "INVALID_SERVICE", "Select one of the four appointment services.");
  }
  return SERVICES[service];
}
function validateDate(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail(400, "INVALID_DATE", "Select a valid appointment date.");
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || Number(date.slice(0, 4)) < 1970) {
    throw fail(400, "INVALID_DATE", "Select a valid appointment date.");
  }
  return date;
}
function manilaNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(now).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
function schedule(service, dateTime, now = new Date()) {
  const key = serviceKey(service);
  const match = typeof dateTime === "string" && dateTime.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::00)?$/);
  if (!match || !TIMES.includes(match[2])) throw fail(400, "INVALID_TIME", "Select one of the seven appointment times.");
  const date = validateDate(match[1]), time = match[2], sql = `${date} ${time}:00`;
  if (sql <= manilaNow(now)) throw fail(400, "PAST_SLOT", "Select a future date and time in Philippine time.");
  return { key, date, time, sql };
}
function booking(body, now = new Date()) {
  const text = (name, max, required = true) => {
    const value = body?.[name];
    if (value != null && typeof value !== "string") throw fail(400, "INVALID_FIELD", `Invalid ${name}.`);
    const clean = (value || "").trim();
    if ((required && !clean) || clean.length > max) throw fail(400, "INVALID_FIELD", `Check ${name}.`);
    return clean;
  };
  const result = { full_name: text("full_name", 150), barangay: text("barangay", 100),
    contact_number: text("contact_number", 11), email: text("email", 254),
    purpose: text("purpose", 100), notes: text("notes", 2000, false) };
  if (!/^\d{11}$/.test(result.contact_number) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) {
    throw fail(400, "INVALID_CONTACT", "Enter an 11-digit contact number and a valid email address.");
  }
  if (result.purpose === "Others" && !result.notes) throw fail(400, "NOTES_REQUIRED", "Please specify your service in Additional Notes.");
  return { ...result, slot: schedule(result.purpose, body.preferred_date, now) };
}
module.exports = { SERVICES, TIMES, fail, serviceKey, validateDate, manilaNow, schedule, booking };
