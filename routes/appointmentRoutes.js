const express = require("express");
const router = express.Router();
const db = require("../config/db");
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
  user: process.env.EMAIL_USER,
  pass: process.env.EMAIL_PASS
}
});

console.log("appointmentRoutes loaded");

function generateAppointmentCode(appointmentId) {
  return `APT-${String(appointmentId).padStart(6, "0")}`;
}

function generateOrientationToken(appointmentId) {
  const timestamp = Date.now();
  return `ORI-${appointmentId}-${timestamp}`;
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
      LOWER(TRIM(status)) IN ('approved', 'rejected', 'rescheduled', 'cancelled', 'completed')
      OR preferred_date < CURDATE()
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
    SELECT id, status, preferred_date, email, full_name
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

    db.query(updateSql, [new_date, cleanPersonnelName, id], (updateErr, result) => {
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
  const mailOptions = {
    from: "wastemanagementgensan00@gmail.com",
    to: email,
    subject: "Appointment Rescheduled",
    html: `
      <h3>Hello ${fullName},</h3>
      <p>Your appointment has been <b>rescheduled</b>.</p>
      <p><b>New Date:</b> ${new_date}</p>
      <p>Please be guided accordingly.</p>
      <br>
      <p>Waste Management Office</p>
    `
  };

  transporter.sendMail(mailOptions, (err) => {
    if (err) {
      console.error("Email send error:", err);
    } else {
      console.log("Reschedule email sent to:", email);
    }
  });
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
