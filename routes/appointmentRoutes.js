const express = require("express");
const router = express.Router();
const db = require("../config/db");
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);
const { buildAppointmentUpdateEmail } = require("../utils/appointmentUpdateEmail");
const { requireWebAuth, requireWebRole, requireWebCapability, requireCsrf } = require("../middleware/webSessionAuth");
const { AppointmentSchedulingService } = require("../services/appointmentSchedulingService");
const scheduling = new AppointmentSchedulingService(db);
const staffView = requireWebCapability("appointments.view");
const staffManage = [...requireWebCapability("appointments.manage"), requireCsrf];
const orientationView = requireWebCapability("orientation.view");
const orientationManage = [...requireWebCapability("orientation.manage"), requireCsrf];
const reservationSchema = async (req, res, next) => {
  if (!scheduling.enabled()) return next();
  try { await scheduling.ready(); next(); } catch (error) { return actionError(res, error); }
};
const reservationWrite = async (req, res, next) => {
  try { await scheduling.ready(); next(); } catch (error) { return actionError(res, error); }
};
const privateResponse = (req, res, next) => { res.set?.("Cache-Control", "no-store"); next(); };
const actionError = (res, error) => res.status(error.statusCode || 503).json({ success: false,
  code: error.statusCode ? error.code : "APPOINTMENT_UNAVAILABLE",
  message: error.statusCode ? error.message : "Appointment operation unavailable. No successful change is confirmed." });
router.get("/availability", publicRateLimit, privateResponse, async (req, res) => {
  try { return res.json(await scheduling.availability(req.query.service, req.query.date)); }
  catch (error) { return actionError(res, error); }
});
// Bounded process-local abuse protection; reverse-proxy/shared rate limiting remains a rollout requirement.
const publicAttempts = new Map();
function publicRateLimit(req, res, next) {
  const now = Date.now(), key = `${req.ip || req.socket?.remoteAddress || "unknown"}:${req.path || req.url}`;
  for (const [ip, value] of publicAttempts) if (value.until <= now) publicAttempts.delete(ip);
  let state = publicAttempts.get(key);
  if (!state) {
    if (publicAttempts.size >= 10000) return res.status(503).json({ success: false, message: "Appointment requests are temporarily busy." });
    state = { count: 0, until: now + 60000 }; publicAttempts.set(key, state);
  }
  if (++state.count > 20) { res.set?.("Retry-After", "60"); return res.status(429).json({ success: false, message: "Too many requests. Please wait before trying again." }); }
  next();
}
const {
  ORIENTATION_PURPOSE,
  normalizeOrientationStatus,
  getOrientationQuizResult,
  canTakeOrientationQuiz
} = require("../utils/orientationWorkflow");
const requireOrientationWebMutation = [
  requireWebAuth,
  requireWebRole("super_admin", "personnel"),
  requireCsrf
];

console.log("appointmentRoutes loaded");

// Reconcile attendance on the database's calendar date, not a rolling timer.
async function reconcileOverdueOrientationNoShows(req, res, next) {
  // Maintenance reads must not become unguarded writes or skip revisions.
  if (!scheduling.enabled()) return next();
  try { await scheduling.ready(); } catch (error) { return actionError(res, error); }
  db.query(
    `UPDATE appointments
     SET orientation_status = 'no_show', updated_at = NOW(), appointment_revision = appointment_revision + 1
     WHERE purpose = ?
       AND LOWER(TRIM(status)) = 'approved'
       AND preferred_date < CURDATE()
       AND orientation_started_at IS NULL
       AND orientation_completed_at IS NULL
       AND COALESCE(orientation_completed, 0) = 0
       AND LOWER(COALESCE(NULLIF(TRIM(orientation_status), ''), 'approved')) = 'approved'`,
    [ORIENTATION_PURPOSE],
    (error) => {
      if (error) {
        console.error("orientation no-show reconciliation error:", error);
        return res.status(500).json({ success: false, message: "Failed to reconcile orientation attendance" });
      }
      return next();
    }
  );
}

function generateAppointmentCode(appointmentId) {
  return `APT-${String(appointmentId).padStart(6, "0")}`;
}

function generateOrientationToken(appointmentId) {
  return `ORI-${appointmentId}-${Date.now()}`;
}




/* =========================================
   GET ALL APPOINTMENTS
========================================= */
router.get("/", ...staffView, privateResponse, reservationSchema, (req, res) => {
  const sql = `
    SELECT
      id,
      ${scheduling.enabled() ? "appointment_revision," : ""}
      full_name,
      barangay,
      purpose,
      preferred_date,
      DATE_FORMAT(preferred_date, '%Y-%m-%d %H:%i:%s') AS slot_schedule,
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
router.get("/active", ...staffView, privateResponse, reservationSchema, reconcileOverdueOrientationNoShows, (req, res) => {
  const sql = `
    SELECT
      id,
      ${scheduling.enabled() ? "appointment_revision," : ""}
      appointment_code,
      full_name,
      barangay,
      contact_number,
      email,
      purpose,
      preferred_date,
      DATE_FORMAT(preferred_date, '%Y-%m-%d %H:%i:%s') AS slot_schedule,
      status,
      assigned_to,
      orientation_qr_status,
      orientation_completed,
      orientation_status,
      orientation_started_at,
      orientation_completed_at,
      orientation_score,
      created_at,
      updated_at
    FROM appointments
    WHERE (
      status IS NULL
      OR TRIM(status) = ''
      OR LOWER(TRIM(status)) IN ('pending', 'approved', 'rescheduled')
    )
    AND preferred_date >= CURDATE()
    AND NOT (
      purpose = 'SWM Orientation & Clearance'
      AND (
        LOWER(TRIM(COALESCE(orientation_status, ''))) IN (
          'completed_orientation',
          'completed',
          'no_show',
          'no-show',
          'noshow',
          'incomplete_orientation',
          'incomplete'
        )
        OR COALESCE(orientation_completed, 0) = 1
        OR orientation_completed_at IS NOT NULL
      )
    )
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
router.get("/history", ...staffView, privateResponse, reservationSchema, reconcileOverdueOrientationNoShows, (req, res) => {
  const sql = `
    SELECT
      id,
      ${scheduling.enabled() ? "appointment_revision," : ""}
      appointment_code,
      full_name,
      barangay,
      contact_number,
      email,
      purpose,
      preferred_date,
      DATE_FORMAT(preferred_date, '%Y-%m-%d %H:%i:%s') AS slot_schedule,
      CASE
        WHEN purpose = 'SWM Orientation & Clearance'
          AND LOWER(TRIM(COALESCE(orientation_status, ''))) IN ('no_show', 'no-show', 'noshow')
        THEN 'no_show'
        WHEN purpose = 'SWM Orientation & Clearance'
          AND LOWER(TRIM(COALESCE(orientation_status, ''))) IN
            ('incomplete_orientation', 'incomplete')
        THEN 'incomplete'
        WHEN purpose = 'SWM Orientation & Clearance'
          AND (
            LOWER(TRIM(COALESCE(orientation_status, ''))) IN (
              'completed_orientation',
              'completed',
              'no_show',
              'no-show',
              'noshow',
              'incomplete_orientation',
              'incomplete'
            )
            OR COALESCE(orientation_completed, 0) = 1
            OR orientation_completed_at IS NOT NULL
          )
        THEN 'completed'
        ELSE status
      END AS status,
      assigned_to,
      orientation_qr_status,
      orientation_completed,
      orientation_status,
      orientation_started_at,
      orientation_completed_at,
      orientation_score,
      created_at,
      updated_at
    FROM appointments
    WHERE
      LOWER(TRIM(status)) IN ('rejected', 'cancelled', 'completed')
      OR (
        LOWER(TRIM(status)) IN ('approved', 'rescheduled')
        AND preferred_date < CURDATE()
        AND NOT (
          purpose = 'SWM Orientation & Clearance'
          AND LOWER(TRIM(COALESCE(orientation_status, ''))) IN
            ('failed_orientation', 'ready_for_retake')
        )
      )
      OR (
        purpose = 'SWM Orientation & Clearance'
        AND (
          LOWER(TRIM(COALESCE(orientation_status, ''))) IN (
            'completed_orientation',
            'completed',
            'no_show',
            'no-show',
            'noshow',
            'incomplete_orientation',
            'incomplete'
          )
          OR COALESCE(orientation_completed, 0) = 1
          OR orientation_completed_at IS NOT NULL
        )
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
router.get("/orientation", ...orientationView, privateResponse, reconcileOverdueOrientationNoShows, (req, res) => {
  const sql = `
  SELECT
    id,
    full_name,
    barangay,
    purpose,
    preferred_date,
    DATE_FORMAT(preferred_date, '%Y-%m-%d %H:%i:%s') AS slot_schedule,
    status,
    assigned_to,
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
   ORIENTATION WORKFLOW ACTIONS (WMO WEB)
========================================= */
function loadOrientationForWebAction(id, res, callback) {
  if (!/^\d+$/.test(String(id || "")) || Number(id) < 1) {
    return res.status(400).json({ success: false, message: "Valid appointment ID is required" });
  }

  db.query(
    `SELECT id, purpose, status, orientation_status, orientation_score
     FROM appointments WHERE id = ? AND purpose = ? LIMIT 1`,
    [id, ORIENTATION_PURPOSE],
    (error, rows) => {
      if (error) {
        console.error("orientation workflow lookup error:", error);
        return res.status(500).json({ success: false, message: "Failed to load orientation record" });
      }
      if (!rows || !rows.length) {
        return res.status(404).json({ success: false, message: "Orientation record not found" });
      }
      return callback(rows[0]);
    }
  );
}

router.post("/orientation/:id/allow-retake", requireOrientationWebMutation, reservationWrite, reconcileOverdueOrientationNoShows, (req, res) => {
  loadOrientationForWebAction(req.params.id, res, (record) => {
    const current = normalizeOrientationStatus(record.orientation_status);
    if (current === "ready_for_retake") {
      return res.json({ success: true, orientation_status: current, changed: false });
    }
    if (current !== "failed_orientation" || String(record.status).toLowerCase() !== "approved") {
      return res.status(409).json({ success: false, message: "This orientation cannot be reopened" });
    }

    db.query(
      `UPDATE appointments SET orientation_status = 'ready_for_retake', updated_at = NOW(), appointment_revision = appointment_revision + 1
       WHERE id = ? AND purpose = ? AND status = 'approved'
         AND orientation_status = 'failed_orientation'`,
      [record.id, ORIENTATION_PURPOSE],
      (error, result) => {
        if (error) {
          console.error("allow orientation retake error:", error);
          return res.status(500).json({ success: false, message: "Failed to allow retake" });
        }
        if (!result?.affectedRows) {
          return res.status(409).json({ success: false, message: "Orientation state changed; refresh and retry" });
        }
        return res.json({ success: true, orientation_status: "ready_for_retake", changed: true });
      }
    );
  });
});

router.post("/orientation/:id/mark-incomplete", requireOrientationWebMutation, reservationWrite, reconcileOverdueOrientationNoShows, (req, res) => {
  loadOrientationForWebAction(req.params.id, res, (record) => {
    const current = normalizeOrientationStatus(record.orientation_status);
    if (current === "incomplete_orientation") {
      return res.json({ success: true, orientation_status: current, changed: false });
    }
    if (!canTakeOrientationQuiz(current) && current !== "failed_orientation") {
      return res.status(409).json({ success: false, message: "This orientation cannot be marked incomplete" });
    }
    if (String(record.status).toLowerCase() !== "approved") {
      return res.status(409).json({ success: false, message: "Only approved orientation may be marked incomplete" });
    }

    db.query(
      `UPDATE appointments SET orientation_status = 'incomplete_orientation',
         orientation_completed = 0, orientation_completed_at = NOW(), updated_at = NOW(), appointment_revision = appointment_revision + 1
       WHERE id = ? AND purpose = ? AND status = 'approved'
         AND COALESCE(orientation_status, 'approved') = ?`,
      [record.id, ORIENTATION_PURPOSE, current],
      (error, result) => {
        if (error) {
          console.error("mark orientation incomplete error:", error);
          return res.status(500).json({ success: false, message: "Failed to mark orientation incomplete" });
        }
        if (!result?.affectedRows) {
          return res.status(409).json({ success: false, message: "Orientation state changed; refresh and retry" });
        }
        return res.json({ success: true, orientation_status: "incomplete_orientation", changed: true });
      }
    );
  });
});

/* =========================================
   VERIFY ORIENTATION TOKEN
   For mobile QR scan verification
========================================= */
router.get("/orientation/verify/:token", privateResponse, reservationSchema, reconcileOverdueOrientationNoShows, (req, res) => {
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
      orientation_status,
      orientation_score,
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
        orientation_completed: record.orientation_completed,
        orientation_status: normalizeOrientationStatus(record.orientation_status),
        orientation_score: record.orientation_score,
        can_take_quiz: canTakeOrientationQuiz(record.orientation_status)
      }
    });
  });
});

/* =========================================
   GENERATE ORIENTATION QR TOKEN
========================================= */
router.post("/:id/generate-orientation-qr", ...orientationManage, privateResponse, reservationWrite, reconcileOverdueOrientationNoShows, (req, res) => {
  const { id } = req.params;

  const checkSql = `
    SELECT
      id,
      full_name,
      barangay,
      purpose,
      preferred_date,
      status,
      orientation_status,
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

    if (!canTakeOrientationQuiz(appointment.orientation_status)) {
      return res.status(409).json({ success: false, message: "Orientation is not available for a QR" });
    }

    const tokenToUse = existingOrientationToken || generateOrientationToken(id);

    const updateSql = `
      UPDATE appointments
     SET
  orientation_token = ?,
  orientation_qr_status = 'generated',
  orientation_status = COALESCE(orientation_status, 'approved'),
  updated_at = NOW(), appointment_revision = appointment_revision + 1
      WHERE id = ? AND status = 'approved' AND orientation_token <=> ?
        AND COALESCE(orientation_status, 'approved') IN ('approved', 'pending_orientation', 'ready_for_retake')
    `;

    db.query(updateSql, [tokenToUse, id, appointment.orientation_token ?? null], (updateErr, updateResult) => {
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
          qr_url: `/orientation-quiz.html?token=${encodeURIComponent(tokenToUse)}`
        }
      });
    });
  });
});

/* =========================================
   ACCEPT / REJECT APPOINTMENT
   Auto-generate orientation QR when approved
========================================= */
async function sendRescheduleEmail(appointment, newDate) {
const email = appointment.email;
const fullName = appointment.full_name;

if (email) {
  try {
    const emailDetails = {
      fullName,
      oldDate: appointment.preferred_date,
      newDate: newDate,
      purpose: appointment.purpose,
      appointmentCode: appointment.appointment_code || generateAppointmentCode(appointment.id),
      status: "rescheduled"
    };

    const { data, error } = await resend.emails.send({
      from: "WMO System <noreply@wastegensan.com>",
      to: email,
      ...buildAppointmentUpdateEmail(emailDetails)
    }) ?? {};

    if (error) {
      // Provider messages may contain recipient details or credentials; log safe metadata only.
      console.error("Reschedule email rejected by Resend:", {
        type: "provider_error",
        statusCode: Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
          ? error.statusCode : undefined
      });
    } else if (typeof data?.id === "string" && /^[A-Za-z0-9-]{1,128}$/.test(data.id)) {
      console.log("Reschedule email accepted by Resend:", { emailId: data.id });
    } else {
      console.warn("Reschedule email returned no email ID or error");
    }
  } catch (err) {
    console.error("Resend exception during reschedule email:", { type: "send_exception" });
  }
}

}
async function manageAppointment(req, res, action) {
  try {
    const result = await scheduling.change(req.params.id, action, req.user, req.body);
    if (action === "reschedule") await sendRescheduleEmail(result.previous, result.data.new_date);
    delete result.previous;
    return res.json(result);
  } catch (error) { return actionError(res, error); }
}
router.put("/:id/decision", ...staffManage, privateResponse,
  (req, res) => {
    const action = String(req.body?.action || "").toLowerCase();
    if (!["accept", "reject"].includes(action)) return res.status(400).json({ success: false, message: "Invalid action. Use accept or reject" });
    return manageAppointment(req, res, action);
  });
router.put("/:id/reschedule", ...staffManage, privateResponse,
  (req, res) => manageAppointment(req, res, "reschedule"));
router.put("/:id/cancel", ...staffManage, privateResponse,
  (req, res) => manageAppointment(req, res, "cancel"));
router.post("/", publicRateLimit, privateResponse, async (req, res) => {
  const recovery = req.headers["idempotency-recovery"];
  if (recovery !== undefined && recovery !== "true") return res.status(400).json({ success: false, message: "Invalid recovery mode." });
  try { return res.json(await scheduling.book(req.body, req.headers["idempotency-key"], { recoveryOnly: recovery === "true" })); }
  catch (error) { return actionError(res, error); }
});

/* =========================================
   CHECK APPOINTMENT STATUS
========================================= */
router.post("/check-status", publicRateLimit, privateResponse, (req, res) => {
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

router.get("/:id/orientation-qr-image", ...requireWebCapability("orientation.manage"), privateResponse, (req, res) => {
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
router.put("/orientation/start/:token", privateResponse, reservationWrite, reconcileOverdueOrientationNoShows, (req, res) => {
  const { token } = req.params;

  const sql = `
    UPDATE appointments
    SET
      orientation_status = 'pending_orientation',
      orientation_started_at = COALESCE(orientation_started_at, NOW()),
      updated_at = NOW(), appointment_revision = appointment_revision + 1
    WHERE orientation_token = ? AND purpose = ? AND status = 'approved'
      AND COALESCE(orientation_status, 'approved') IN
        ('approved', 'pending_orientation', 'ready_for_retake')
  `;

  db.query(sql, [token, ORIENTATION_PURPOSE], (err, result) => {
    if (err) {
      console.error("start orientation error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to start orientation"
      });
    }

    if (!result?.affectedRows) {
      return res.status(409).json({ success: false, message: "Orientation is not available to start" });
    }

    return res.json({
      success: true,
      message: "Orientation started",
      orientation_status: "pending_orientation"
    });
  });
});

/* =========================================
   COMPLETE ORIENTATION (QUIZ DONE)
========================================= */
router.put("/orientation/complete/:token", privateResponse, reservationWrite, reconcileOverdueOrientationNoShows, (req, res) => {
  const { token } = req.params;
  const resultValue = getOrientationQuizResult(req.body?.score, req.body?.total_questions, req.body?.answers);
  if (!resultValue) {
    return res.status(400).json({ success: false, message: "A valid quiz score and question total are required" });
  }

  db.query(
    `SELECT id, purpose, status, orientation_status, orientation_score
     FROM appointments WHERE orientation_token = ? LIMIT 1`,
    [token],
    (lookupError, rows) => {
      if (lookupError) {
        console.error("orientation result lookup error:", lookupError);
        return res.status(500).json({ success: false, message: "Failed to load orientation record" });
      }
      if (!rows?.length || rows[0].purpose !== ORIENTATION_PURPOSE) {
        return res.status(404).json({ success: false, message: "Orientation record not found" });
      }
      const record = rows[0];
      const current = normalizeOrientationStatus(record.orientation_status);
      if (current === "completed_orientation" && resultValue.passed &&
          Number(record.orientation_score) === resultValue.score) {
        return res.json({
          success: true,
          passed: true,
          score: resultValue.score,
          total_questions: resultValue.totalQuestions,
          orientation_status: current,
          certificate_eligible: true,
          changed: false
        });
      }
      if (current === "failed_orientation" && !resultValue.passed &&
          Number(record.orientation_score) === resultValue.score) {
        return res.json({
          success: true,
          passed: false,
          score: resultValue.score,
          total_questions: resultValue.totalQuestions,
          orientation_status: current,
          certificate_eligible: false,
          changed: false
        });
      }
      if (String(record.status).toLowerCase() !== "approved" || !canTakeOrientationQuiz(current)) {
        return res.status(409).json({ success: false, message: "Orientation is not available for a quiz attempt" });
      }

      const nextStatus = resultValue.passed ? "completed_orientation" : "failed_orientation";
      const sql = resultValue.passed
        ? `UPDATE appointments SET status = 'completed', orientation_completed = 1,
             orientation_status = 'completed_orientation', orientation_completed_at = NOW(),
             orientation_score = ?, updated_at = NOW(), appointment_revision = appointment_revision + 1
           WHERE id = ? AND purpose = ? AND status = 'approved'
             AND COALESCE(orientation_status, 'approved') = ?`
        : `UPDATE appointments SET orientation_completed = 0,
             orientation_status = 'failed_orientation', orientation_completed_at = NULL,
             orientation_score = ?, updated_at = NOW(), appointment_revision = appointment_revision + 1
           WHERE id = ? AND purpose = ? AND status = 'approved'
             AND COALESCE(orientation_status, 'approved') = ?`;

      db.query(sql, [resultValue.score, record.id, ORIENTATION_PURPOSE, current], (err, result) => {
        if (err) {
          console.error("submit orientation result error:", err);
          return res.status(500).json({
            success: false,
            message: "Failed to save orientation result"
          });
        }

        if (!result || result.affectedRows === 0) {
          return res.status(409).json({
            success: false,
            message: "Orientation state changed; refresh and retry"
          });
        }

        return res.json({
          success: true,
          passed: resultValue.passed,
          score: resultValue.score,
          total_questions: resultValue.totalQuestions,
          orientation_status: nextStatus,
          certificate_eligible: resultValue.passed,
          changed: true,
          message: resultValue.passed
            ? "Orientation completed and moved to appointment history"
            : "Quiz attempt recorded; retake requires WMO authorization"
        });
      });
    }
  );
});
module.exports = router;
