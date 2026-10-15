const PUBLIC_PORTAL_URL = "https://wastegensan.com/";
const LOGO_URL = "https://res.cloudinary.com/dcagkcius/image/upload/v1791127246/wmo-logo-new.jpg";
const HEADER_URL = "https://res.cloudinary.com/dcagkcius/image/upload/v1791127240/wmo-appointment-update-header.png";

function cleanText(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return !text || /^(null|undefined|-)$/i.test(text) ? "" : text;
}

function escapeHtml(value) {
  return cleanText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatAppointmentEmailDate(value) {
  // Preserve the booked calendar date/time rather than parsing SQL strings as UTC.
  let raw = cleanText(value);
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const pad = (part) => String(part).padStart(2, "0");
    raw = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
  }
  if (!raw) return "";
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::\d{2})?)?/);
  if (!match) return raw;
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4] || 0), Number(match[5] || 0), 0);
  if (Number.isNaN(parsed.getTime())) return raw;
  const datePart = new Intl.DateTimeFormat("en-US", {
    month: "long", day: "2-digit", year: "numeric"
  }).format(parsed);
  if (!match[4] || !match[5]) return datePart;
  const timePart = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true
  }).format(parsed);
  return `${datePart}, ${timePart}`;
}

function buildAppointmentStatusUrl(appointmentCode) {
  const url = new URL(PUBLIC_PORTAL_URL);
  const reference = cleanText(appointmentCode);
  if (/^APT-\d{6,20}$/i.test(reference)) {
    url.searchParams.set("appointment_code", reference);
  }
  url.hash = "appointmentStatusSection";
  return url.href;
}

function buildAppointmentUpdateEmail(details = {}) {
  const fullName = cleanText(details.fullName) || "Citizen";
  const referenceCode = cleanText(details.appointmentCode);
  const service = cleanText(details.purpose);
  const oldSchedule = formatAppointmentEmailDate(details.oldDate);
  const newSchedule = formatAppointmentEmailDate(details.newDate);
  const rawStatus = cleanText(details.status);
  const status = rawStatus ? rawStatus.charAt(0).toUpperCase() + rawStatus.slice(1) : "";
  const reason = cleanText(details.updateReason);
  const statusUrl = buildAppointmentStatusUrl(referenceCode);
  const safeSubjectReference = /^APT-\d{6,20}$/i.test(referenceCode) ? referenceCode : "";
  const subject = `WMO Appointment Update${safeSubjectReference ? ` – ${safeSubjectReference}` : ""}`;
  const rows = [
    ["Service", service],
    ["Previous Schedule", oldSchedule],
    ["Updated Schedule", newSchedule],
    ["Status", status],
    ["Reason for Update", reason]
  ].filter(([, value]) => value);
  const detailRows = rows.map(([label, value]) => `
    <tr>
      <td style="padding:15px 18px;border-bottom:1px solid #e0ebe3;${label === "Updated Schedule" ? "background:#fff9e7;border-left:4px solid #deb948;" : ""}">
        <p style="margin:0 0 5px;font-size:11px;line-height:1.5;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;color:#61756a;">${label}</p>
        <p style="margin:0;font-size:${label === "Updated Schedule" ? "19" : "15"}px;line-height:1.6;color:#164b32;font-weight:${label === "Updated Schedule" ? "700" : "400"};overflow-wrap:anywhere;">${escapeHtml(value)}</p>
      </td>
    </tr>`).join("");
  const text = [
    `Dear ${fullName},`, "",
    "Your appointment schedule has been updated. Please review the latest details below.", "",
    ...(referenceCode ? [`Reference Code: ${referenceCode}`] : []),
    ...rows.map(([label, value]) => `${label}: ${value}`), "",
    `Check Appointment Status: ${statusUrl}`,
    "Enter your email address or contact number on the portal to verify your appointment.", "",
    "Keep your reference code for future tracking.",
    "Please follow the updated schedule shown above.", "",
    "Waste Management Office", "General Santos City", "",
    "This is an automated appointment update email."
  ].join("\n");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Appointment Update</title>
  <style>@media only screen and (max-width:480px){.email-pad{padding-left:18px!important;padding-right:18px!important}.email-title{font-size:22px!important}.email-reference{font-size:24px!important}}</style>
</head>
<body style="margin:0;padding:0;background:#f2f7f3;font-family:Arial,Helvetica,sans-serif;color:#223c2e;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f2f7f3;">
    <tr><td align="center" style="padding:24px 10px;">
      <!--[if mso]><table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background:#ffffff;border:1px solid #dbe8de;border-radius:18px;overflow:hidden;">
        <tr><td style="background:#eaf6ee;">
          <img src="${HEADER_URL}" alt="Green calendar and clock illustration for your appointment update" width="640" style="display:block;width:100%;max-width:640px;height:auto;border:0;">
        </td></tr>
        <tr><td class="email-pad" style="padding:22px 30px;background:#edf7ef;border-bottom:1px solid #dbe8de;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td width="72" style="width:72px;vertical-align:middle;">
              <img src="${LOGO_URL}" alt="Waste Management Office logo" width="64" height="64" style="display:block;width:64px;height:64px;object-fit:contain;border:0;background:#ffffff;border-radius:12px;">
            </td>
            <td style="padding-left:14px;vertical-align:middle;">
              <h1 class="email-title" style="margin:0 0 6px;font-size:28px;line-height:1.2;color:#12452d;">Appointment Update</h1>
              <p style="margin:0;font-size:12px;line-height:1.6;color:#526e5d;">Waste Management Office – General Santos City</p>
            </td>
          </tr></table>
        </td></tr>
        <tr><td class="email-pad" style="padding:28px 30px 20px;">
          <p style="margin:0 0 12px;font-size:16px;line-height:1.7;">Dear ${escapeHtml(fullName)},</p>
          <p style="margin:0 0 22px;font-size:15px;line-height:1.8;color:#4f6658;">Your appointment schedule has been updated. Please review the latest details below.</p>
          ${referenceCode ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px;"><tr><td align="center" style="padding:20px 14px;background:#edf8f0;border:1px solid #bcdcc8;border-radius:12px;">
            <p style="margin:0 0 7px;font-size:11px;line-height:1.5;font-weight:700;letter-spacing:1.5px;color:#52715e;">REFERENCE CODE</p>
            <p class="email-reference" style="margin:0;font-size:29px;line-height:1.3;font-weight:700;letter-spacing:1px;color:#145333;overflow-wrap:anywhere;">${escapeHtml(referenceCode)}</p>
          </td></tr></table>` : ""}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e0ebe3;border-radius:12px;overflow:hidden;">${detailRows}</table>
        </td></tr>
        <tr><td class="email-pad" align="center" style="padding:8px 30px 24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:100%;"><tr><td align="center" bgcolor="#176b40" style="background:#176b40;border-radius:10px;">
            <a href="${escapeHtml(statusUrl)}" style="display:inline-block;padding:16px 22px;font-size:15px;line-height:1.5;font-weight:700;color:#ffffff;text-decoration:none;">Check Appointment Status</a>
          </td></tr></table>
          <p style="margin:13px 0 0;font-size:12px;line-height:1.7;color:#64796c;">Enter your email address or contact number on the portal to verify your appointment.</p>
          <p style="margin:16px 0 4px;font-size:12px;line-height:1.7;color:#64796c;">If the button does not work, use this link:</p>
          <p style="margin:0;font-size:12px;line-height:1.7;word-break:break-all;overflow-wrap:anywhere;"><a href="${escapeHtml(statusUrl)}" style="color:#176b40;text-decoration:underline;">Open the WMO Appointment Status page</a></p>
        </td></tr>
        <tr><td class="email-pad" style="padding:0 30px 26px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:16px 18px;background:#f6faf7;border-left:3px solid #d8b342;border-radius:8px;">
            <p style="margin:0 0 6px;font-size:13px;line-height:1.7;color:#526b5b;">Keep your reference code for future tracking.</p>
            <p style="margin:0;font-size:13px;line-height:1.7;color:#526b5b;">Please follow the updated schedule shown above.</p>
          </td></tr></table>
        </td></tr>
        <tr><td class="email-pad" align="center" style="padding:22px 30px;background:#edf5ef;border-top:1px solid #dbe8de;">
          <p style="margin:0;font-size:13px;line-height:1.7;font-weight:700;color:#315b42;">Waste Management Office</p>
          <p style="margin:0 0 12px;font-size:12px;line-height:1.7;color:#64796c;">General Santos City</p>
          <p style="margin:0;font-size:11px;line-height:1.7;color:#64796c;">This is an automated appointment update email.</p>
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, text, html };
}

module.exports = { buildAppointmentUpdateEmail, buildAppointmentStatusUrl, formatAppointmentEmailDate };
