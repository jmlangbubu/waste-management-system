const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const db = require("../config/db");
const {
  resolveBarangayByPolygon,
  resolveNearestBarangay,
  calculateDistanceMeters
} = require("../services/barangayBoundaryService");

const uploadDir = path.join(__dirname, "..", "uploads", "complaints");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || ".jpg");
    cb(null, `complaint_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },

  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];

    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error("Only JPG, PNG, WEBP images are allowed"), false);
    }

    cb(null, true);
  }
});

/* =========================
   CREATE COMPLAINT
========================= */
router.post("/", upload.single("image"), (req, res) => {
  try {
    const {
      citizen_id,
      citizen_name,
      username,
      reporter_barangay,
      subject,
      description,
      latitude,
      longitude
    } = req.body;

   if (!citizen_id || !subject || !latitude || !longitude) {
  return res.status(400).json({
    success: false,
    message: "Missing required complaint fields."
  });
  }

  if (!req.file || !req.file.path) {
  return res.status(400).json({
    success: false,
    message: "Image upload failed or missing."
  });
  }

    
  if (req.file.size <= 0) {
  return res.status(400).json({
    success: false,
    message: "Uploaded image is empty or corrupted."
  });
  }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({
        success: false,
        message: "Invalid complaint location coordinates."
      });
    }

    const boundarySql = `
      SELECT barangay_name, polygon_json
      FROM barangay_boundaries
      WHERE status = 'active'
    `;

    db.query(boundarySql, (boundaryErr, boundaryRows) => {
      if (boundaryErr) {
        console.error("Boundary query error:", boundaryErr);
        return res.status(500).json({
          success: false,
          message: "Failed to load barangay boundaries."
        });
      }

      try {
        console.log("=== COMPLAINT LOCATION DEBUG ===");
        console.log("Point:", { lat, lng });
        console.log("Boundary rows count:", (boundaryRows || []).length);

        const polygonMatchedBarangay = resolveBarangayByPolygon(
          { lat, lng },
          boundaryRows || []
        );

        console.log("Polygon matched barangay:", polygonMatchedBarangay);

        let finalBarangay = polygonMatchedBarangay || null;
        let assignmentMethod = "polygon";
        let status = "pending";

        if (!finalBarangay) {
          const nearestBarangay = resolveNearestBarangay(
            { lat, lng },
            boundaryRows || []
          );

          console.log("Nearest fallback barangay:", nearestBarangay);

          if (nearestBarangay && typeof nearestBarangay === "string") {
            finalBarangay = nearestBarangay;
            assignmentMethod = "nearest_fallback";
          } else {
            finalBarangay = "For Verification";
            assignmentMethod = "manual_review";
          }
        }

        if (!finalBarangay || finalBarangay === "undefined") {
          finalBarangay = "For Verification";
          assignmentMethod = "manual_review";
        }

        console.log("FINAL assigned barangay:", finalBarangay);
        console.log("Assignment method:", assignmentMethod);

        const imageUrl = `/uploads/complaints/${req.file.filename}`;

        const insertSql = `
          INSERT INTO complaints (
            citizen_id,
            citizen_name,
            username,
            reporter_barangay,
            subject,
            description,
            image_url,
            latitude,
            longitude,
            assigned_barangay,
            assignment_method,
            status
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const insertValues = [
          citizen_id,
          citizen_name || null,
          username || null,
          reporter_barangay || null,
          subject,
          description || null,
          imageUrl,
          lat,
          lng,
          finalBarangay || "For Verification",
          assignmentMethod || "manual_review",
          status || "pending"
        ];

        db.query(insertSql, insertValues, (insertErr, insertResult) => {
          if (insertErr) {
            console.error("Complaint insert error:", insertErr);
            return res.status(500).json({
              success: false,
              message: "Failed to save complaint.",
              sqlError: insertErr.message,
              sqlCode: insertErr.code
            });
          }

          const complaintId = insertResult.insertId;

          const notifSql = `
            INSERT INTO complaint_notifications (
              complaint_id,
              target_type,
              target_name
            )
            VALUES (?, 'wmo', 'WMO')
          `;

          db.query(notifSql, [complaintId], (notifErr) => {
            if (notifErr) {
              console.error("WMO notification insert error:", notifErr);
            }

            return res.json({
              success: true,
              message:
                assignmentMethod === "polygon"
                  ? "Complaint submitted successfully."
                  : assignmentMethod === "nearest_fallback"
                  ? "Complaint submitted successfully and auto-assigned to the nearest barangay."
                  : "Complaint submitted successfully and marked for manual verification.",
              complaintId,
              reporter_barangay: reporter_barangay || null,
              assigned_barangay: finalBarangay,
              assignment_method: assignmentMethod
            });
          });
        });
      } catch (resolutionError) {
        console.error("Complaint barangay resolution error:", resolutionError);
        return res.status(500).json({
          success: false,
          message: "Barangay resolution failed.",
          error: resolutionError.message
        });
      }
    });
  } catch (error) {
    console.error("Complaint submit server error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while submitting complaint."
    });
  }

  console.log("=== CREATE COMPLAINT UPLOAD DEBUG ===");

  if (req.file) {
  console.log("File name:", req.file.filename);
  console.log("File path:", req.file.path);
  console.log("File size:", req.file.size);
  console.log("Mime type:", req.file.mimetype);
} else {
  console.log("NO FILE RECEIVED");
}
});

/* =========================
   GET ALL COMPLAINTS (WMO)
========================= */
router.get("/", (req, res) => {
  console.log("GET /api/complaints hit");

  const sql = `
    SELECT *
    FROM complaints
    ORDER BY created_at DESC
  `;

  db.query(sql, (err, rows) => {
    console.log("GET /api/complaints query callback reached");

    if (err) {
      console.error("Complaint list error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to load complaints."
      });
    }

    return res.json({
      success: true,
      complaints: rows || []
    });
  });
});

/* =========================
   NEARBY BARANGAY REFERENCE POINTS
   MUST STAY BEFORE ANY DYNAMIC GET ROUTES
========================= */
router.get("/nearby-barangays", (req, res) => {
  const { latitude, longitude } = req.query;

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({
      success: false,
      message: "Valid latitude and longitude are required."
    });
  }

  const sql = `
    SELECT
      id,
      barangay_name,
      reference_name,
      latitude,
      longitude,
      image_url
    FROM barangay_reference_points
    WHERE status = 'active'
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      console.error("Error loading nearby barangays:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to load nearby barangay reference points."
      });
    }

    const candidates = (rows || [])
      .map((row) => {
        const refLat = parseFloat(row.latitude);
        const refLng = parseFloat(row.longitude);

        if (Number.isNaN(refLat) || Number.isNaN(refLng)) {
          return null;
        }

        const distanceMeters = calculateDistanceMeters(lat, lng, refLat, refLng);

        return {
          id: row.id,
          barangay_name: row.barangay_name,
          reference_name: row.reference_name,
          latitude: refLat,
          longitude: refLng,
          image_url: row.image_url || null,
          distance_meters: Math.round(distanceMeters)
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance_meters - b.distance_meters)
      .slice(0, 10);

    console.log("Nearby barangay candidates:", candidates);

    return res.json({
      success: true,
      issue_location: {
        latitude: lat,
        longitude: lng
      },
      candidates
    });
  });
});

/* =========================
   VALIDATE + FORWARD TO BARANGAY
========================= */
router.post("/:id/validate-forward", (req, res) => {
  const complaintId = req.params.id;
  const { validated_by, selected_barangay } = req.body;

  const findSql = `
    SELECT *
    FROM complaints
    WHERE id = ?
    LIMIT 1
  `;

  db.query(findSql, [complaintId], (findErr, rows) => {
    if (findErr) {
      console.error("Find complaint error:", findErr);
      return res.status(500).json({
        success: false,
        message: "Failed to find complaint."
      });
    }

    if (!rows || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Complaint not found."
      });
    }

    const complaint = rows[0];
    let finalBarangay = complaint.assigned_barangay;

    const continueForward = (resolvedBarangay) => {
      const updateSql = `
        UPDATE complaints
        SET assigned_barangay = ?,
            status = 'forwarded',
            validated_at = NOW(),
            validated_by = ?
        WHERE id = ?
      `;

      db.query(
        updateSql,
        [resolvedBarangay, validated_by || null, complaintId],
        (updateErr) => {
          if (updateErr) {
            console.error("Validate+Forward error:", updateErr);
            return res.status(500).json({
              success: false,
              message: "Failed to forward complaint."
            });
          }

          const notifSql = `
            INSERT INTO complaint_notifications (
              complaint_id,
              target_type,
              target_name
            )
            VALUES (?, 'barangay', ?)
          `;

          db.query(notifSql, [complaintId, resolvedBarangay], (notifErr) => {
            if (notifErr) {
              console.error("Barangay notification insert error:", notifErr);
            }

            return res.json({
              success: true,
              message: "Complaint forwarded to barangay successfully.",
              assigned_barangay: resolvedBarangay
            });
          });
        }
      );
    };

    if (selected_barangay && String(selected_barangay).trim() !== "") {
      return continueForward(String(selected_barangay).trim());
    }

    if (finalBarangay && finalBarangay !== "For Verification") {
      return continueForward(finalBarangay);
    }

    const boundarySql = `
      SELECT barangay_name, polygon_json
      FROM barangay_boundaries
      WHERE status = 'active'
    `;

    db.query(boundarySql, (boundaryErr, boundaryRows) => {
      if (boundaryErr) {
        console.error("Boundary query error during validate:", boundaryErr);
        return res.status(500).json({
          success: false,
          message: "Failed to load barangay boundaries."
        });
      }

      const point = {
        lat: parseFloat(complaint.latitude),
        lng: parseFloat(complaint.longitude)
      };

      let resolvedBarangay = resolveBarangayByPolygon(point, boundaryRows || []);

      if (!resolvedBarangay) {
        resolvedBarangay = resolveNearestBarangay(point, boundaryRows || []);
      }

      if (!resolvedBarangay) {
        return res.status(400).json({
          success: false,
          message: "Unable to auto-detect barangay for this complaint. Please choose a barangay from the map first."
        });
      }

      return continueForward(resolvedBarangay);
    });
  });
});

/* =========================
   ACCEPT BY BARANGAY
========================= */
router.put("/:id/accept", (req, res) => {
  const complaintId = req.params.id;
  const { accepted_by } = req.body;

  const sql = `
    UPDATE complaints
    SET status = 'accepted_by_barangay',
        accepted_by = ?,
        accepted_at = NOW()
    WHERE id = ?
  `;

  db.query(sql, [accepted_by || null, complaintId], (err) => {
    if (err) {
      console.error("Accept complaint error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to accept complaint."
      });
    }

    return res.json({
      success: true,
      message: "Complaint accepted successfully."
    });
  });
});

/* =========================
   RESOLVE BY BARANGAY
========================= */
router.put("/:id/resolve", upload.single("evidence"), (req, res) => {
  const complaintId = req.params.id;
  const {
    handled_by_barangay_name,
    resolution_report,
    resolved_by
  } = req.body;

  if (
    !handled_by_barangay_name ||
    !String(handled_by_barangay_name).trim() ||
    !resolution_report ||
    !String(resolution_report).trim()
  ) {
    return res.status(400).json({
      success: false,
      message: "Personnel name and resolution report are required."
    });
  }

  const evidenceUrl = req.file
    ? `/uploads/complaints/${req.file.filename}`
    : null;

  const sql = `
    UPDATE complaints
    SET status = 'resolved',
        handled_by_barangay_name = ?,
        resolution_report = ?,
        resolution_evidence_url = ?,
        resolved_by = ?,
        resolved_at = NOW()
    WHERE id = ?
      AND status IN ('forwarded', 'in_progress')
  `;

  db.query(
    sql,
    [
      String(handled_by_barangay_name).trim(),
      String(resolution_report).trim(),
      evidenceUrl,
      resolved_by || null,
      complaintId
    ],
    (err, result) => {
      if (err) {
        console.error("Resolve complaint error:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to resolve complaint."
        });
      }

      return res.json({
        success: true,
        message: "Complaint resolved successfully.",
        complaint_id: complaintId,
        resolution_evidence_url: evidenceUrl
      });
    }
  );
  console.log("=== RESOLUTION UPLOAD DEBUG ===");

if (req.file) {
  console.log("File name:", req.file.filename);
  console.log("File path:", req.file.path);
  console.log("File size:", req.file.size);
  console.log("Mime type:", req.file.mimetype);
} else {
  console.log("NO RESOLUTION FILE RECEIVED");
}
});

/* =========================
   RESOLVED COMPLAINTS HISTORY (WMO)
========================= */
router.get("/history/resolved", (req, res) => {
  const sql = `
    SELECT
      c.*,
      brp.reference_name AS assigned_reference_name,
      brp.latitude AS assigned_barangay_lat,
      brp.longitude AS assigned_barangay_lng,
      brp.image_url AS assigned_barangay_image_url
    FROM complaints c
    LEFT JOIN barangay_reference_points brp
      ON TRIM(LOWER(brp.barangay_name)) = TRIM(LOWER(c.assigned_barangay))
      AND brp.status = 'active'
    WHERE c.status = 'resolved'
    ORDER BY c.resolved_at DESC, c.created_at DESC
  `;

  console.log("GET /api/complaints/history/resolved hit");

  db.query(sql, (err, rows) => {
    if (err) {
      console.error("Resolved complaint history error FULL:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to load resolved complaint history.",
        error: err.message,
        code: err.code
      });
    }

    console.log("Resolved complaint history rows:", rows);

    return res.json({
      success: true,
      complaints: rows || []
    });
  });

});

/* =========================
   BARANGAY COMPLAINT ANALYTICS
========================= */
router.get("/barangay-analytics/:barangay", (req, res) => {
  try {
    const barangay = String(req.params.barangay || "").trim();

    if (!barangay) {
      return res.status(400).json({
        success: false,
        message: "Barangay is required."
      });
    }

    const sql = `
      SELECT COUNT(*) AS total_issues
      FROM complaints
      WHERE LOWER(TRIM(assigned_barangay)) = LOWER(TRIM(?))
        AND LOWER(TRIM(status)) = 'resolved'
    `;

    db.query(sql, [barangay], (err, rows) => {
      if (err) {
        console.error("Barangay complaint analytics error:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to load barangay complaint analytics.",
          error: err.message
        });
      }

      const summary = rows && rows.length ? rows[0] : { total_issues: 0 };

      return res.json({
        success: true,
        summary: {
          total_issues: Number(summary.total_issues || 0)
        }
      });
    });
  } catch (err) {
    console.error("Barangay analytics route error:", err);
    return res.status(500).json({
      success: false,
      message: "Unexpected server error.",
      error: err.message
    });
  }
});


/* =========================
   BARANGAY COMPLAINT LIST
   NOW INCLUDES REFERENCE POINT COORDINATES
========================= */
router.get("/barangay/:barangayName", (req, res) => {
   const barangayName = decodeURIComponent(req.params.barangayName || "").trim();

  console.log("Barangay complaint request:", barangayName);

  const sql = `
    SELECT
      c.*,
      brp.reference_name AS assigned_reference_name,
      brp.latitude AS assigned_barangay_lat,
      brp.longitude AS assigned_barangay_lng,
      brp.image_url AS assigned_barangay_image_url
    FROM complaints c
    LEFT JOIN barangay_reference_points brp
      ON TRIM(LOWER(brp.barangay_name)) = TRIM(LOWER(c.assigned_barangay))
      AND brp.status = 'active'
    WHERE TRIM(LOWER(c.assigned_barangay)) = TRIM(LOWER(?))
      AND c.status IN ('forwarded', 'in_progress')
    ORDER BY c.created_at DESC
  `;

  db.query(sql, [barangayName], (err, rows) => {
    if (err) {
      console.error("Barangay complaint list error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to load barangay complaints."
      });
    }

    return res.json({
      success: true,
      complaints: rows || []
    });
  });
});

/* =========================
   WMO NOTIFICATIONS
========================= */
router.get("/notifications/wmo", (req, res) => {
  const sql = `
    SELECT
      cn.*,
      c.subject,
      c.assigned_barangay,
      c.status,
      c.image_url,
      c.latitude,
      c.longitude,
      c.created_at AS complaint_created_at
    FROM complaint_notifications cn
    INNER JOIN complaints c ON c.id = cn.complaint_id
    WHERE cn.target_type = 'wmo'
    ORDER BY cn.created_at DESC
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      console.error("WMO complaint notification error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to load WMO complaint notifications."
      });
    }

    return res.json({
      success: true,
      notifications: rows || []
    });
  });
});

/* =========================
   BARANGAY NOTIFICATIONS
========================= */
router.get("/notifications/barangay/:barangayName", (req, res) => {
  const barangayName = req.params.barangayName;

  const sql = `
    SELECT
      cn.*,
      c.subject,
      c.assigned_barangay,
      c.status,
      c.image_url,
      c.latitude,
      c.longitude,
      c.created_at AS complaint_created_at
    FROM complaint_notifications cn
    INNER JOIN complaints c ON c.id = cn.complaint_id
    WHERE cn.target_type = 'barangay'
      AND cn.target_name = ?
    ORDER BY cn.created_at DESC
  `;

  db.query(sql, [barangayName], (err, rows) => {
    if (err) {
      console.error("Barangay complaint notification error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to load barangay complaint notifications."
      });
    }

    return res.json({
      success: true,
      notifications: rows || []
    });
  });
});

/* =========================
   MARK AS IN PROGRESS
   Trigger when barangay opens complaint
========================= */
router.put("/:id/in-progress", (req, res) => {
  const complaintId = req.params.id;
  const { viewed_by } = req.body || {};

  const sql = `
    UPDATE complaints
    SET status = 'in_progress',
        in_progress_at = NOW()
    WHERE id = ?
      AND status = 'forwarded'
  `;

  db.query(sql, [complaintId], (err, result) => {
    if (err) {
      console.error("Mark in progress error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to update complaint status."
      });
    }

    return res.json({
      success: true,
      message: "Complaint marked as in progress.",
      complaint_id: complaintId,
      viewed_by: viewed_by || null
    });
  });
});

/* =========================
   GET SINGLE COMPLAINT
   NOW INCLUDES REFERENCE POINT COORDINATES
   KEEP THIS LAST
========================= */
router.get("/:id", (req, res) => {
  const complaintId = req.params.id;

const sql = `
  SELECT
    c.*,
    brp.reference_name AS assigned_reference_name,
    brp.latitude AS assigned_barangay_lat,
    brp.longitude AS assigned_barangay_lng,
    brp.image_url AS assigned_barangay_image_url
  FROM complaints c
  LEFT JOIN barangay_reference_points brp
    ON TRIM(LOWER(brp.barangay_name)) = TRIM(LOWER(c.assigned_barangay))
    AND brp.status = 'active'
  WHERE c.id = ?
  LIMIT 1
`;

  db.query(sql, [complaintId], (err, rows) => {
    if (err) {
      console.error("Complaint detail error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to load complaint details."
      });
    }

    if (!rows || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Complaint not found."
      });
    }

    return res.json({
      success: true,
      complaint: rows[0]
    });
  });
});

module.exports = router;