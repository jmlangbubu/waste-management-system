const express = require("express");
const router = express.Router();
const db = require("../config/db");
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);

console.log("appointmentRoutes loaded");

function generateAppointmentCode(appointmentId) {
  return `APT-${String(appointmentId).padStart(6, "0")}`;
}

function generateOrientationToken(appointmentId) {
  const timestamp = Date.now();
  return `ORI-${appointmentId}-${timestamp}`;
}


function cleanText(value) {
  if (value === null || value === undefined) return "";

  const text = String(value).trim();

  if (!text || text.toLowerCase() === "null" || text.toLowerCase() === "undefined") {
    return "";
  }

  return text;
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
  const raw = cleanText(value);

  if (!raw) return "-";

  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::\d{2})?)?/);

  if (!match) {
    return raw;
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);

  const parsed = new Date(year, monthIndex, day, hour, minute, 0);

  if (Number.isNaN(parsed.getTime())) {
    return raw;
  }

  const hasTime = Boolean(match[4] && match[5]);

  const datePart = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "2-digit",
    year: "numeric"
  }).format(parsed);

  if (!hasTime) {
    return datePart;
  }

  const timePart = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(parsed);

  return `${datePart}, ${timePart}`;
}


function buildAppointmentStatusUrl(appointmentCode, contact) {
  const configuredUrl =
    cleanText(process.env.APPOINTMENT_STATUS_URL) ||
    cleanText(process.env.LANDING_APPOINTMENT_STATUS_URL) ||
    cleanText(process.env.PUBLIC_FRONTEND_URL) ||
    cleanText(process.env.FRONTEND_URL) ||
    "https://wastegensan.com/";

  const hashFromEnv = cleanText(process.env.APPOINTMENT_STATUS_HASH) || "appointment-status";

  let baseUrl = configuredUrl;
  let hashValue = hashFromEnv;

  const hashIndex = baseUrl.indexOf("#");

  if (hashIndex >= 0) {
    hashValue = cleanText(baseUrl.slice(hashIndex + 1)) || hashValue;
    baseUrl = baseUrl.slice(0, hashIndex);
  }

  if (!baseUrl.endsWith("/") && !baseUrl.includes("?")) {
    /*
      Keep root domain clean:
      https://wastegensan.com + ?appointment_code=...
    */
  }

  const params = new URLSearchParams();

  const safeAppointmentCode = cleanText(appointmentCode);
  const safeContact = cleanText(contact);

  if (safeAppointmentCode) {
    params.set("appointment_code", safeAppointmentCode);
  }

  if (safeContact) {
    params.set("contact", safeContact);
  }

  const queryString = params.toString();
  const separator = baseUrl.includes("?") ? "&" : "?";
  const queryPart = queryString ? `${separator}${queryString}` : "";

  return `${baseUrl}${queryPart}#${hashValue}`;
}

function buildAppointmentRescheduledEmailText(details) {
  const fullName = cleanText(details.fullName) || "Client";
  const newDate = cleanText(details.newDate) || "-";
  const barangay = cleanText(details.barangay) || "-";
  const purpose = cleanText(details.purpose) || "Appointment";
  const appointmentCode = cleanText(details.appointmentCode) || `Appointment #${details.appointmentId || ""}`;
  const assignedTo = cleanText(details.assignedTo) || "WMO Personnel";

  return [
    `Hello ${fullName},`,
    "",
    "Your WMO appointment has been rescheduled.",
    "",
    `Reference: ${appointmentCode}`,
    `Purpose: ${purpose}`,
    `Barangay: ${barangay}`,
    `New Schedule: ${newDate}`,
    `Updated by: ${assignedTo}`,
    "",
    `Check appointment status: ${cleanText(details.statusUrl) || "-"}`,
    "",
    "Please be guided by the updated schedule. If you have questions, contact the Waste Management Office.",
    "",
    "Waste Management Office",
    "General Santos City"
  ].join("\n");
}

function buildAppointmentRescheduledEmailHtml(details) {
  const fullName = escapeHtml(details.fullName || "Client");
  const newDate = escapeHtml(details.newDate || "-");
  const barangay = escapeHtml(details.barangay || "-");
  const purpose = escapeHtml(details.purpose || "Appointment");
  const appointmentCode = escapeHtml(details.appointmentCode || `Appointment #${details.appointmentId || ""}`);
  const assignedTo = escapeHtml(details.assignedTo || "WMO Personnel");
  const statusUrl = escapeHtml(details.statusUrl || "https://wastegensan.com/#appointment-status");

  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Appointment Rescheduled</title>
      </head>
      <body style="margin:0; padding:0; background:#F3F8F4; font-family:Arial, Helvetica, sans-serif; color:#173C2C;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#F3F8F4; margin:0; padding:24px 12px;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:620px; background:#FFFFFF; border-radius:22px; overflow:hidden; border:1px solid #DCE9DF; box-shadow:0 8px 22px rgba(18,56,38,0.08);">
                <tr>
                  <td style="background:#0B4B2B; padding:24px 28px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="vertical-align:middle; width:46px;">
                          <div style="width:46px; height:46px; line-height:46px; text-align:center; border-radius:16px; background:#E7F5EA; color:#0B4B2B; font-weight:800; font-size:15px; letter-spacing:0.5px;">
                            WMO
                          </div>
                        </td>
                        <td style="vertical-align:middle; padding-left:14px;">
                          <div style="font-size:20px; line-height:1.25; font-weight:800; color:#FFFFFF;">
                            Appointment Rescheduled
                          </div>
                          <div style="font-size:12px; line-height:1.5; color:#CFE6D6; margin-top:2px;">
                            Waste Management Office · General Santos City
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td style="padding:30px 28px 10px 28px;">
                    <div style="font-size:23px; line-height:1.25; font-weight:800; color:#123826; margin:0 0 10px 0;">
                      Your appointment schedule was updated
                    </div>

                    <div style="font-size:15px; line-height:1.7; color:#40564A; margin:0 0 20px 0;">
                      Hello <strong style="color:#123826;">${fullName}</strong>, your WMO appointment has been <strong>rescheduled</strong>. Please review the updated details below.
                    </div>

                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 22px 0;">
                      <tr>
                        <td align="center" style="background:#F0FAF2; border:1px solid #D4EBDD; border-radius:18px; padding:22px 14px;">
                          <div style="font-size:11px; line-height:1.4; color:#60756A; font-weight:700; letter-spacing:0.8px; text-transform:uppercase; margin-bottom:8px;">
                            New Schedule
                          </div>
                          <div style="font-size:26px; line-height:1.25; font-weight:900; color:#2F8A34; font-family:Arial, Helvetica, sans-serif;">
                            ${newDate}
                          </div>
                        </td>
                      </tr>
                    </table>

                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #E0ECE3; border-radius:18px; overflow:hidden; margin:0 0 20px 0;">
                      <tr>
                        <td style="background:#F7FBF8; padding:14px 16px; border-bottom:1px solid #E0ECE3;">
                          <div style="font-size:12px; color:#60756A; font-weight:700; text-transform:uppercase; letter-spacing:0.5px;">Reference</div>
                          <div style="font-size:15px; color:#173C2C; font-weight:700; margin-top:4px;">${appointmentCode}</div>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:14px 16px; border-bottom:1px solid #E0ECE3;">
                          <div style="font-size:12px; color:#60756A; font-weight:700; text-transform:uppercase; letter-spacing:0.5px;">Purpose</div>
                          <div style="font-size:15px; color:#173C2C; margin-top:4px;">${purpose}</div>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:14px 16px; border-bottom:1px solid #E0ECE3;">
                          <div style="font-size:12px; color:#60756A; font-weight:700; text-transform:uppercase; letter-spacing:0.5px;">Barangay</div>
                          <div style="font-size:15px; color:#173C2C; margin-top:4px;">${barangay}</div>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:14px 16px;">
                          <div style="font-size:12px; color:#60756A; font-weight:700; text-transform:uppercase; letter-spacing:0.5px;">Updated By</div>
                          <div style="font-size:15px; color:#173C2C; margin-top:4px;">${assignedTo}</div>
                        </td>
                      </tr>
                    </table>

                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px 0;">
                      <tr>
                        <td style="background:#FFF8E7; border:1px solid #F1D28A; border-radius:16px; padding:14px 16px;">
                          <div style="font-size:14px; line-height:1.6; color:#5F4A1A;">
                            Please be guided by the updated schedule. Arrive on time and bring any required information related to your appointment.
                          </div>
                        </td>
                      </tr>
                    </table>

                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px 0;">
                      <tr>
                        <td align="center">
                          <a href="${statusUrl}" target="_blank" style="display:inline-block; background:#0B4B2B; color:#FFFFFF; text-decoration:none; font-size:15px; font-weight:800; padding:14px 24px; border-radius:14px;">
                            Check Appointment Status
                          </a>
                        </td>
                      </tr>
                    </table>

                    <div style="font-size:14px; line-height:1.7; color:#60756A;">
                      If you have questions, please contact the Waste Management Office.
                    </div>
                  </td>
                </tr>

                <tr>
                  <td style="padding:22px 28px 28px 28px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid #E4EEE7;">
                      <tr>
                        <td style="padding-top:18px;">
                          <div style="font-size:13px; line-height:1.6; color:#7B8C82;">
                            Waste Management Office<br>
                            General Santos City
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <div style="max-width:620px; margin:14px auto 0 auto; font-size:11px; line-height:1.6; color:#7B8C82; text-align:center;">
                This is an automated message. Please do not reply to this email.
              </div>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
}


/* =========================================
   GET ALL APPOINTMENTS
========================================= */
router.get("/", (req, res) => {
  const sql = `
    SELECT
      id,
      full_name,
      barangay,
      purpose,
      preferred_date,
      status,
      assigned_to,
      created_at,
      updated_at
    FROM appointments
    ORDER BY created_at DESC, id DESC
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error("get all appointments error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch appointments",
        error: err.message
      });
    }

    return res.json({
      success: true,
      appointments: results
    });
  });
});

/* =========================================
   GET ACTIVE APPOINTMENTS
========================================= */
router.get("/active", (req, res) => {
  const sql = `
    SELECT
      id,
      appointment_code,
      full_name,
      barangay,
      contact_number,
      email,
      purpose,
      preferred_date,
      status,
      assigned_to,
      created_at,
      updated_at
    FROM appointments
    WHERE (
      status IS NULL
      OR TRIM(status) = ''
      OR LOWER(TRIM(status)) IN ('pending', 'approved', 'rescheduled')
    )
    AND preferred_date >= CURDATE()
    ORDER BY preferred_date ASC, id DESC
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error("get active appointments error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch active appointments",
        error: err.message
      });
    }

    return res.json({
      success: true,
      appointments: results
    });
  });
});

/* =========================================
   GET APPOINTMENT HISTORY
========================================= */
router.get("/history", (req, res) => {
  const sql = `
    SELECT
      id,
      appointment_code,
      full_name,
      barangay,
      contact_number,
      email,
      purpose,
      preferred_date,
      status,
      assigned_to,
      created_at,
      updated_at
    FROM appointments
  WHERE
  LOWER(TRIM(status)) IN ('rejected', 'cancelled', 'completed')
  OR (
    LOWER(TRIM(status)) IN ('approved', 'rescheduled')
    AND preferred_date < CURDATE()
  )
    ORDER BY updated_at DESC, id DESC
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error("get appointment history error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch appointment history",
        error: err.message
      });
    }

    return res.json({
      success: true,
      history: results
    });
  });
});

/* =========================================
   GET ORIENTATION APPOINTMENTS
   Approved orientation records only
========================================= */
router.get("/orientation", (req, res) => {
  const sql = `
  SELECT
    id,
    full_name,
    barangay,
    preferred_date,
    status,
    assigned_to,
    orientation_token,
    orientation_qr_status,
    orientation_completed,
    orientation_status,
    orientation_started_at,
    orientation_completed_at,
    orientation_score,
    created_at,
    updated_at
  FROM appointments
  WHERE purpose = 'SWM Orientation & Clearance'
  ORDER BY preferred_date ASC, id DESC
`;

  db.query(sql, (err, results) => {
    if (err) {
      console.error("get orientation appointments error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to load orientation appointments",
        error: err.message
      });
    }

    return res.json({
      success: true,
      appointments: results
    });
  });
});

/* =========================================
   VERIFY ORIENTATION TOKEN
   For mobile QR scan verification
========================================= */
router.get("/orientation/verify/:token", (req, res) => {
  const { token } = req.params;

  if (!token || !String(token).trim()) {
    return res.status(400).json({
      success: false,
      message: "Orientation token is required"
    });
  }

  const cleanToken = String(token).trim();

  const sql = `
    SELECT
      id,
      full_name,
      barangay,
      purpose,
      preferred_date,
      status,
      assigned_to,
      orientation_token,
      orientation_qr_status,
      orientation_completed,
      created_at,
      updated_at
    FROM appointments
    WHERE orientation_token = ?
    LIMIT 1
  `;

  db.query(sql, [cleanToken], (err, results) => {
    if (err) {
      console.error("verify orientation token error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to verify orientation token",
        error: err.message
      });
    }

    if (!results || results.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Invalid or expired orientation token"
      });
    }

    const record = results[0];
    const status = String(record.status || "").toLowerCase().trim();
    const purpose = String(record.purpose || "").trim();

    if (purpose !== "SWM Orientation & Clearance") {
      return res.status(400).json({
        success: false,
        message: "This token is not linked to an orientation record"
      });
    }

    if (status !== "approved") {
      return res.status(400).json({
        success: false,
        message: "This orientation record is not approved"
      });
    }

    return res.json({
      success: true,
      message: "Orientation token verified successfully",
      data: {
        id: record.id,
        full_name: record.full_name,
        barangay: record.barangay,
        purpose: record.purpose,
        preferred_date: record.preferred_date,
        status: record.status,
        assigned_to: record.assigned_to,
        orientation_token: record.orientation_token,
        orientation_qr_status: record.orientation_qr_status,
        orientation_completed: record.orientation_completed
      }
    });
  });
});

/* =========================================
   GENERATE ORIENTATION QR TOKEN
========================================= */
router.post("/:id/generate-orientation-qr", (req, res) => {
  const { id } = req.params;

  const checkSql = `
    SELECT
      id,
      full_name,
      barangay,
      purpose,
      preferred_date,
      status,
      orientation_token,
      orientation_qr_status,
      orientation_completed
    FROM appointments
    WHERE id = ?
    LIMIT 1
  `;

  db.query(checkSql, [id], (checkErr, checkResults) => {
    if (checkErr) {
      console.error("check orientation appointment error:", checkErr);
      return res.status(500).json({
        success: false,
        message: "Failed to validate orientation appointment",
        error: checkErr.message
      });
    }

    if (!checkResults || checkResults.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Orientation appointment not found"
      });
    }

    const appointment = checkResults[0];
    const status = String(appointment.status || "").toLowerCase().trim();
    const purpose = String(appointment.purpose || "").trim();
    const existingOrientationToken = String(appointment.orientation_token || "").trim();

    if (purpose !== "SWM Orientation & Clearance") {
      return res.status(400).json({
        success: false,
        message: "This appointment is not an orientation request"
      });
    }

    if (status !== "approved") {
      return res.status(400).json({
        success: false,
        message: "Only approved orientation appointments can generate a QR"
      });
    }

    const tokenToUse = existingOrientationToken || generateOrientationToken(id);

    const updateSql = `
      UPDATE appointments
     SET
  orientation_token = ?,
  orientation_qr_status = 'generated',
  orientation_status = COALESCE(orientation_status, 'approved'),
  updated_at = NOW()
      WHERE id = ?
    `;

    db.query(updateSql, [tokenToUse, id], (updateErr, updateResult) => {
      if (updateErr) {
        console.error("generate orientation qr update error:", updateErr);
        return res.status(500).json({
          success: false,
          message: "Failed to generate orientation QR",
          error: updateErr.message
        });
      }

      if (!updateResult || updateResult.affectedRows === 0) {
        return res.status(404).json({
          success: false,
          message: "Orientation appointment not found or no changes made"
        });
      }

      return res.json({
        success: true,
        message: "Orientation QR generated successfully",
        data: {
          appointment_id: Number(id),
          full_name: appointment.full_name || "",
          barangay: appointment.barangay || "",
          preferred_date: appointment.preferred_date || null,
          token: tokenToUse,
          qr_url: `http://192.168.100.70:8081/orientation-quiz.html?token=${encodeURIComponent(tokenToUse)}`
        }
      });
    });
  });
});

/* =========================================
   ACCEPT / REJECT APPOINTMENT
   Auto-generate orientation QR when approved
========================================= */
router.put("/:id/decision", (req, res) => {
  const { id } = req.params;
  const { action, personnel_name } = req.body;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "Appointment ID is required"
    });
  }

  if (!action || !["accept", "reject"].includes(String(action).toLowerCase())) {
    return res.status(400).json({
      success: false,
      message: "Invalid action. Use accept or reject"
    });
  }

  if (!personnel_name || !String(personnel_name).trim()) {
    return res.status(400).json({
      success: false,
      message: "Personnel name is required"
    });
  }

  const normalizedAction = String(action).toLowerCase();
  const newStatus = normalizedAction === "accept" ? "approved" : "rejected";
  const cleanPersonnelName = String(personnel_name).trim();

  const checkSql = `
    SELECT id, status, purpose, orientation_token
    FROM appointments
    WHERE id = ?
    LIMIT 1
  `;

  db.query(checkSql, [id], (checkErr, checkResults) => {
    if (checkErr) {
      console.error("check appointment before decision error:", checkErr);
      return res.status(500).json({
        success: false,
        message: "Failed to validate appointment",
        error: checkErr.message
      });
    }

    if (!checkResults || checkResults.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Appointment not found"
      });
    }

    const appointment = checkResults[0];
    const existingStatus = String(appointment.status || "").toLowerCase().trim();
    const purpose = String(appointment.purpose || "").trim();
    const existingOrientationToken = String(appointment.orientation_token || "").trim();

    if (existingStatus === "approved" || existingStatus === "rejected") {
      return res.status(400).json({
        success: false,
        message: "Appointment already processed"
      });
    }

    const isOrientation = purpose === "SWM Orientation & Clearance";
    const shouldGenerateOrientationQr = newStatus === "approved" && isOrientation;

    const tokenToUse = shouldGenerateOrientationQr
      ? (existingOrientationToken || generateOrientationToken(id))
      : null;

    let updateSql = "";
    let updateParams = [];

    if (shouldGenerateOrientationQr) {
      updateSql = `
        UPDATE appointments
       SET
  status = ?,
  assigned_to = ?,
  orientation_token = ?,
  orientation_qr_status = 'generated',
  orientation_status = 'approved',
  updated_at = NOW()
        WHERE id = ?
      `;
      updateParams = [newStatus, cleanPersonnelName, tokenToUse, id];
    } else {
      updateSql = `
        UPDATE appointments
        SET
          status = ?,
          assigned_to = ?,
          updated_at = NOW()
        WHERE id = ?
      `;
      updateParams = [newStatus, cleanPersonnelName, id];
    }

    db.query(updateSql, updateParams, (updateErr, updateResult) => {
      if (updateErr) {
        console.error("appointment decision update error:", updateErr);
        return res.status(500).json({
          success: false,
          message: "Failed to update appointment decision",
          error: updateErr.message
        });
      }

      if (!updateResult || updateResult.affectedRows === 0) {
        return res.status(404).json({
          success: false,
          message: "Appointment not found or no changes made"
        });
      }

      return res.json({
        success: true,
        message:
          newStatus === "approved"
            ? "Appointment accepted successfully"
            : "Appointment rejected successfully",
        data: {
          id: Number(id),
          status: newStatus,
          assigned_to: cleanPersonnelName,
          orientation_token: shouldGenerateOrientationQr ? tokenToUse : null,
          orientation_qr_status: shouldGenerateOrientationQr ? "generated" : null
        }
      });
    });
  });
});

/* =========================================
   RESCHEDULE APPOINTMENT
========================================= */
router.put("/:id/reschedule", (req, res) => {
  const { id } = req.params;
  const { new_date, personnel_name } = req.body;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "Appointment ID is required"
    });
  }

  if (!new_date) {
    return res.status(400).json({
      success: false,
      message: "New date is required"
    });
  }

  if (!personnel_name || !String(personnel_name).trim()) {
    return res.status(400).json({
      success: false,
      message: "Personnel name is required"
    });
  }

  const cleanPersonnelName = String(personnel_name).trim();

  const checkSql = `
    SELECT
      id,
      appointment_code,
      status,
      preferred_date,
      email,
      full_name,
      barangay,
      purpose
    FROM appointments
    WHERE id = ?
    LIMIT 1
  `;

  db.query(checkSql, [id], (checkErr, checkResults) => {
    if (checkErr) {
      console.error("check appointment before reschedule error:", checkErr);
      return res.status(500).json({
        success: false,
        message: "Failed to validate appointment",
        error: checkErr.message
      });
    }

    if (!checkResults || checkResults.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Appointment not found"
      });
    }

    const appointment = checkResults[0];
    const existingStatus = String(appointment.status || "").toLowerCase().trim();

    if (["rejected", "cancelled", "completed"].includes(existingStatus)) {
      return res.status(400).json({
        success: false,
        message: "Cannot reschedule rejected, cancelled, or completed appointments"
      });
    }

    const updateSql = `
      UPDATE appointments
      SET
        preferred_date = ?,
        status = 'rescheduled',
        assigned_to = ?,
        assigned_at = NOW(),
        updated_at = NOW()
      WHERE id = ?
    `;

    db.query(updateSql, [new_date, cleanPersonnelName, id], async (updateErr, result) => {
      if (updateErr) {
        console.error("reschedule appointment error:", updateErr);
        return res.status(500).json({
          success: false,
          message: "Failed to reschedule appointment",
          error: updateErr.message
        });
      }

const email = appointment.email;
const fullName = appointment.full_name;

if (email) {
  try {
    const emailDetails = {
      fullName,
      newDate: formatAppointmentEmailDate(new_date),
      barangay: appointment.barangay,
      purpose: appointment.purpose,
      appointmentCode: appointment.appointment_code,
      appointmentId: appointment.id,
      assignedTo: cleanPersonnelName,
      statusUrl: buildAppointmentStatusUrl(
        appointment.appointment_code || generateAppointmentCode(appointment.id),
        appointment.email
      )
    };

    await resend.emails.send({
      from: "WMO System <noreply@wastegensan.com>",
      to: email,
      subject: "Appointment Rescheduled - WMO",
      text: buildAppointmentRescheduledEmailText(emailDetails),
      html: buildAppointmentRescheduledEmailHtml(emailDetails)
    });

    console.log("Reschedule email sent to:", email);
  } catch (err) {
    console.error("Resend error:", err);
  }
}

      return res.json({
        success: true,
        message: "Appointment successfully rescheduled",
        data: {
          id: Number(id),
          status: "rescheduled",
          new_date,
          assigned_to: cleanPersonnelName
        }
      });
    });
  });
});

/* =========================================
   CANCEL APPOINTMENT
========================================= */
router.put("/:id/cancel", (req, res) => {
  const { id } = req.params;
  const { personnel_name } = req.body;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "Appointment ID is required"
    });
  }

  if (!personnel_name || !String(personnel_name).trim()) {
    return res.status(400).json({
      success: false,
      message: "Personnel name is required"
    });
  }

  const cleanPersonnelName = String(personnel_name).trim();

  const updateSql = `
    UPDATE appointments
    SET
      status = 'cancelled',
      assigned_to = ?,
      assigned_at = NOW(),
      updated_at = NOW()
    WHERE id = ?
      AND LOWER(status) NOT IN ('rejected', 'cancelled', 'completed')
  `;

  db.query(updateSql, [cleanPersonnelName, id], (err, result) => {
    if (err) {
      console.error("cancel appointment error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to cancel appointment",
        error: err.message
      });
    }

    if (!result || result.affectedRows === 0) {
      return res.status(400).json({
        success: false,
        message: "Appointment cannot be cancelled or was not found"
      });
    }

    return res.json({
      success: true,
      message: "Appointment cancelled successfully",
      data: {
        id: Number(id),
        status: "cancelled"
      }
    });
  });
});

/* =========================================
   CREATE APPOINTMENT
========================================= */
router.post("/", (req, res) => {
  const {
    full_name,
    barangay,
    contact_number,
    email,
    purpose,
    preferred_date,
    notes
  } = req.body;

  if (!full_name || !barangay || !purpose || !preferred_date) {
    return res.status(400).json({
      success: false,
      message: "Required fields are missing"
    });
  }

  const sql = `
    INSERT INTO appointments (
      full_name,
      barangay,
      contact_number,
      email,
      purpose,
      preferred_date,
      notes,
      status,
      orientation_token,
      orientation_qr_status,
      orientation_completed,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 'not_generated', 0, NOW(), NOW())
  `;

  db.query(
    sql,
    [
      full_name,
      barangay,
      contact_number || null,
      email || null,
      purpose,
      preferred_date,
      notes || null
    ],
    (err, result) => {
      if (err) {
        console.error("create appointment error:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to create appointment",
          error: err.message
        });
      }

      const notifSql = `
        INSERT INTO notifications (type, title, message)
        VALUES (?, ?, ?)
      `;

      const notifValues = [
        "appointment",
        "New Appointment Request",
        `New appointment from ${full_name} (${barangay}) for ${purpose}`
      ];

     const appointmentId = result.insertId;
const appointmentCode = generateAppointmentCode(appointmentId);

// UPDATE appointment_code
const updateCodeSql = `
  UPDATE appointments
  SET appointment_code = ?
  WHERE id = ?
`;

db.query(updateCodeSql, [appointmentCode, appointmentId], (codeErr) => {
  if (codeErr) {
    console.error("appointment code update error:", codeErr);
  }

  // INSERT NOTIFICATION
  const notifSql = `
    INSERT INTO notifications (type, title, message)
    VALUES (?, ?, ?)
  `;

  const notifValues = [
    "appointment",
    "New Appointment Request",
    `New appointment from ${full_name} (${barangay}) for ${purpose}`
  ];

  db.query(notifSql, notifValues, (notifErr) => {
    if (notifErr) {
      console.error("notification insert error:", notifErr);
    }

    // FINAL RESPONSE
    return res.json({
      success: true,
      message: "Appointment request submitted successfully",
      id: appointmentId,
      appointment_code: appointmentCode
    });
  });
});
    }
  );
});

/* =========================================
   CHECK APPOINTMENT STATUS
========================================= */
router.post("/check-status", (req, res) => {
  const { appointment_code, contact } = req.body;

  if (!appointment_code || !contact) {
    return res.status(400).json({
      success: false,
      message: "Appointment code and email/contact number are required"
    });
  }

  const sql = `
    SELECT
      appointment_code,
      full_name,
      barangay,
      contact_number,
      email,
      purpose,
      preferred_date,
      status,
      assigned_to,
      updated_at
    FROM appointments
    WHERE appointment_code = ?
      AND (
        email = ?
        OR contact_number = ?
      )
    LIMIT 1
  `;

  db.query(
    sql,
    [
      String(appointment_code).trim(),
      String(contact).trim(),
      String(contact).trim()
    ],
    (err, results) => {
      if (err) {
        console.error("check appointment status error:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to check appointment status",
          error: err.message
        });
      }

      if (!results || results.length === 0) {
        return res.status(404).json({
          success: false,
          message: "No appointment found. Please check your reference code and email/contact number."
        });
      }

      return res.json({
        success: true,
        appointment: results[0]
      });
    }
  );
});

const QRCode = require("qrcode");

router.get("/:id/orientation-qr-image", (req, res) => {
  const { id } = req.params;

  const sql = `
    SELECT orientation_token
    FROM appointments
    WHERE id = ?
    LIMIT 1
  `;

  db.query(sql, [id], async (err, results) => {
    if (err) {
      console.error("QR image fetch token error:", err);
      return res.status(500).json({ success: false });
    }

    if (!results || results.length === 0 || !results[0].orientation_token) {
      return res.status(404).json({
        success: false,
        message: "Orientation token not found"
      });
    }

    try {
      const qrBuffer = await QRCode.toBuffer(results[0].orientation_token, {
        type: "png",
        width: 260,
        margin: 4,
        errorCorrectionLevel: "M"
      });

      res.setHeader("Content-Type", "image/png");
      return res.send(qrBuffer);
    } catch (error) {
      console.error("QR image generation error:", error);
      return res.status(500).json({ success: false });
    }
  });
});

/* =========================================
   START ORIENTATION (QR SCAN)
========================================= */
router.put("/orientation/start/:token", (req, res) => {
  const { token } = req.params;

  const sql = `
    UPDATE appointments
    SET
      orientation_status = 'pending_orientation',
      orientation_started_at = NOW()
    WHERE orientation_token = ?
  `;

  db.query(sql, [token], (err, result) => {
    if (err) {
      console.error("start orientation error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to start orientation"
      });
    }

    return res.json({
      success: true,
      message: "Orientation started"
    });
  });
});

/* =========================================
   COMPLETE ORIENTATION (QUIZ DONE)
========================================= */
router.put("/orientation/complete/:token", (req, res) => {
  const { token } = req.params;
  const { score } = req.body;

  const sql = `
    UPDATE appointments
    SET
      orientation_status = 'completed_orientation',
      orientation_completed_at = NOW(),
      orientation_score = ?
    WHERE orientation_token = ?
  `;

  db.query(sql, [score || null, token], (err, result) => {
    if (err) {
      console.error("complete orientation error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to complete orientation"
      });
    }

    return res.json({
      success: true,
      message: "Orientation completed"
    });
  });
});
module.exports = router;
