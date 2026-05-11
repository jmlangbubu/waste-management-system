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
    fileSize: 5 * 1024 * 1024
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
   SMALL HELPERS
========================= */

function cleanText(value) {
  if (value === null || value === undefined) return "";

  const text = String(value).trim();

  if (!text || text.toLowerCase() === "null" || text.toLowerCase() === "undefined") {
    return "";
  }

  return text;
}

function parseOptionalCoordinate(value) {
  const cleaned = cleanText(value);
  if (!cleaned) return null;

  const num = parseFloat(cleaned);

  if (!Number.isFinite(num) || Number.isNaN(num) || num === 0) {
    return null;
  }

  return num;
}

function parseOptionalInt(value) {
  const cleaned = cleanText(value);

  if (!cleaned) return null;

  if (!/^\d+$/.test(cleaned)) {
    return null;
  }

  const num = Number(cleaned);

  if (!Number.isInteger(num)) return null;

  return num;
}

function getComplaintColumnSet(callback) {
  const sql = `SHOW COLUMNS FROM complaints`;

  db.query(sql, (err, rows) => {
    if (err) {
      console.error("Failed to inspect complaints columns:", err);
      return callback(err, new Set());
    }

    const columnSet = new Set(
      (rows || []).map((row) => String(row.Field || "").trim())
    );

    return callback(null, columnSet);
  });
}

function hasColumn(columnSet, columnName) {
  return columnSet && columnSet.has(columnName);
}

function logUploadedFile(prefix, file) {
  console.log(prefix);

  if (file) {
    console.log("File name:", file.filename);
    console.log("File path:", file.path);
    console.log("File size:", file.size);
    console.log("Mime type:", file.mimetype);
  } else {
    console.log("NO FILE RECEIVED");
  }
}

function deleteUploadedFileIfExists(file) {
  try {
    if (file && file.path && fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
      console.log("Deleted unused uploaded file:", file.path);
    }
  } catch (err) {
    console.error("Failed deleting unused uploaded file:", err);
  }
}

function getComplaintByClientRequestId(clientRequestId, callback) {
  const sql = `
    SELECT id, reporter_barangay, assigned_barangay, assignment_method, status
    FROM complaints
    WHERE client_request_id = ?
    LIMIT 1
  `;

  db.query(sql, [clientRequestId], callback);
}

function respondWithExistingComplaint(res, existingComplaint, uploadedFile) {
  deleteUploadedFileIfExists(uploadedFile);

  return res.json({
    success: true,
    duplicate: true,
    message: "Complaint already submitted earlier. Duplicate submission was prevented.",
    complaintId: existingComplaint.id,
    reporter_barangay: existingComplaint.reporter_barangay || null,
    assigned_barangay: existingComplaint.assigned_barangay || "Unknown",
    assignment_method: existingComplaint.assignment_method || null,
    status: existingComplaint.status || null
  });
}

function respondWithExistingComplaintByClientRequestId(res, clientRequestId, uploadedFile) {
  getComplaintByClientRequestId(clientRequestId, (findErr, rows) => {
    if (!findErr && rows && rows.length > 0) {
      return respondWithExistingComplaint(res, rows[0], uploadedFile);
    }

    deleteUploadedFileIfExists(uploadedFile);

    return res.status(409).json({
      success: false,
      message: "Duplicate complaint request detected, but the existing complaint could not be loaded.",
      error: findErr ? findErr.message : null
    });
  });
}

/* =========================
   CREATE COMPLAINT
   Duplicate protection:
   - Android sends client_request_id.
   - Backend checks existing request before insert.
   - If same request is received again, it returns existing complaint instead of creating a new one.
========================= */
router.post("/", upload.single("image"), (req, res) => {
  try {
    const {
      client_request_id,
      citizen_id,
      citizen_name,
      username,
      reporter_barangay,
      subject,
      description,
      latitude,
      longitude
    } = req.body;

    const clientRequestId = cleanText(client_request_id).slice(0, 80);

    if (!citizen_id || !subject || !latitude || !longitude) {
      deleteUploadedFileIfExists(req.file);

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
      deleteUploadedFileIfExists(req.file);

      return res.status(400).json({
        success: false,
        message: "Uploaded image is empty or corrupted."
      });
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      deleteUploadedFileIfExists(req.file);

      return res.status(400).json({
        success: false,
        message: "Invalid complaint location coordinates."
      });
    }

    getComplaintColumnSet((columnErr, columnSet) => {
      if (columnErr) {
        deleteUploadedFileIfExists(req.file);

        return res.status(500).json({
          success: false,
          message: "Failed to inspect complaint table columns.",
          error: columnErr.message
        });
      }

      const canSaveClientRequestId = hasColumn(columnSet, "client_request_id");

      const continueComplaintCreation = () => {
        const boundarySql = `
          SELECT barangay_name, polygon_json
          FROM barangay_boundaries
          WHERE status = 'active'
        `;

        db.query(boundarySql, (boundaryErr, boundaryRows) => {
          if (boundaryErr) {
            deleteUploadedFileIfExists(req.file);

            console.error("Boundary query error:", boundaryErr);
            return res.status(500).json({
              success: false,
              message: "Failed to load barangay boundaries."
            });
          }

          try {
            console.log("=== COMPLAINT LOCATION DEBUG ===");
            console.log("Client request id:", clientRequestId || "none");
            console.log("Can save client_request_id:", canSaveClientRequestId);
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

            const insertColumns = [
              "citizen_id",
              "citizen_name",
              "username",
              "reporter_barangay",
              "subject",
              "description",
              "image_url",
              "latitude",
              "longitude",
              "assigned_barangay",
              "assignment_method",
              "status"
            ];

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

            if (canSaveClientRequestId) {
              insertColumns.push("client_request_id");
              insertValues.push(clientRequestId || null);
            }

            const placeholders = insertColumns.map(() => "?").join(", ");

            const insertSql = `
              INSERT INTO complaints (
                ${insertColumns.join(",\n                ")}
              )
              VALUES (${placeholders})
            `;

            db.query(insertSql, insertValues, (insertErr, insertResult) => {
              if (insertErr) {
                console.error("Complaint insert error:", insertErr);

                if (
                  canSaveClientRequestId &&
                  clientRequestId &&
                  insertErr.code === "ER_DUP_ENTRY"
                ) {
                  return respondWithExistingComplaintByClientRequestId(
                    res,
                    clientRequestId,
                    req.file
                  );
                }

                deleteUploadedFileIfExists(req.file);

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

                logUploadedFile("=== CREATE COMPLAINT UPLOAD DEBUG ===", req.file);

                return res.json({
                  success: true,
                  duplicate: false,
                  message:
                    assignmentMethod === "polygon"
                      ? "Complaint submitted successfully."
                      : assignmentMethod === "nearest_fallback"
                      ? "Complaint submitted successfully and auto-assigned to the nearest barangay."
                      : "Complaint submitted successfully and marked for manual verification.",
                  complaintId,
                  reporter_barangay: reporter_barangay || null,
                  assigned_barangay: finalBarangay,
                  assignment_method: assignmentMethod,
                  client_request_id_saved: canSaveClientRequestId && Boolean(clientRequestId),
                  missing_columns: !canSaveClientRequestId
                    ? {
                        client_request_id: true
                      }
                    : null
                });
              });
            });
          } catch (resolutionError) {
            deleteUploadedFileIfExists(req.file);

            console.error("Complaint barangay resolution error:", resolutionError);
            return res.status(500).json({
              success: false,
              message: "Barangay resolution failed.",
              error: resolutionError.message
            });
          }
        });
      };

      if (canSaveClientRequestId && clientRequestId) {
        return getComplaintByClientRequestId(clientRequestId, (findErr, rows) => {
          if (findErr) {
            deleteUploadedFileIfExists(req.file);

            console.error("Duplicate complaint lookup error:", findErr);
            return res.status(500).json({
              success: false,
              message: "Failed to check duplicate complaint request.",
              error: findErr.message,
              code: findErr.code
            });
          }

          if (rows && rows.length > 0) {
            return respondWithExistingComplaint(res, rows[0], req.file);
          }

          return continueComplaintCreation();
        });
      }

      return continueComplaintCreation();
    });
  } catch (error) {
    deleteUploadedFileIfExists(req.file);

    console.error("Complaint submit server error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while submitting complaint."
    });
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
   REJECT COMPLAINT BY WMO
   Safe additive route:
   - Does not affect validate/forward/resolve routes.
   - Saves rejection fields only if the columns exist.
   - Always updates status to rejected.
========================= */
router.patch("/:id/reject", (req, res) => {
  const complaintId = req.params.id;
  const { rejection_reason, rejected_by } = req.body || {};

  const reason = cleanText(rejection_reason);
  const rejectedBy = parseOptionalInt(rejected_by);

  if (!reason || reason.length < 10) {
    return res.status(400).json({
      success: false,
      message: "A clear rejection reason with at least 10 characters is required."
    });
  }

  const findSql = `
    SELECT id, status
    FROM complaints
    WHERE id = ?
    LIMIT 1
  `;

  db.query(findSql, [complaintId], (findErr, rows) => {
    if (findErr) {
      console.error("Find complaint for rejection error:", findErr);
      return res.status(500).json({
        success: false,
        message: "Failed to find complaint.",
        error: findErr.message,
        code: findErr.code
      });
    }

    if (!rows || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Complaint not found."
      });
    }

    const currentStatus = String(rows[0].status || "").trim().toLowerCase();

    if (currentStatus !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Only pending complaints can be rejected."
      });
    }

    getComplaintColumnSet((columnErr, columnSet) => {
      if (columnErr) {
        return res.status(500).json({
          success: false,
          message: "Failed to inspect complaint table columns.",
          error: columnErr.message
        });
      }

      const setClauses = [
        "status = 'rejected'"
      ];

      const values = [];

      if (hasColumn(columnSet, "rejection_reason")) {
        setClauses.push("rejection_reason = ?");
        values.push(reason);
      }

      if (hasColumn(columnSet, "rejected_by")) {
        setClauses.push("rejected_by = ?");
        values.push(rejectedBy);
      }

      if (hasColumn(columnSet, "rejected_at")) {
        setClauses.push("rejected_at = NOW()");
      }

      const updateSql = `
        UPDATE complaints
        SET ${setClauses.join(",\n            ")}
        WHERE id = ?
          AND status = 'pending'
      `;

      values.push(complaintId);

      db.query(updateSql, values, (updateErr, result) => {
        if (updateErr) {
          console.error("Reject complaint error:", updateErr);
          return res.status(500).json({
            success: false,
            message: "Failed to reject complaint.",
            error: updateErr.message,
            code: updateErr.code
          });
        }

        if (!result || result.affectedRows === 0) {
          return res.status(400).json({
            success: false,
            message: "Complaint could not be rejected. It may have already been processed."
          });
        }

        return res.json({
          success: true,
          message: "Complaint rejected successfully.",
          complaint_id: complaintId,
          rejection_reason_saved: hasColumn(columnSet, "rejection_reason"),
          rejected_by_saved: hasColumn(columnSet, "rejected_by"),
          rejected_at_saved: hasColumn(columnSet, "rejected_at"),
          missing_columns:
            !hasColumn(columnSet, "rejection_reason") ||
            !hasColumn(columnSet, "rejected_by") ||
            !hasColumn(columnSet, "rejected_at")
              ? {
                  rejection_reason: !hasColumn(columnSet, "rejection_reason"),
                  rejected_by: !hasColumn(columnSet, "rejected_by"),
                  rejected_at: !hasColumn(columnSet, "rejected_at")
                }
              : null
        });
      });
    });
  });
});

/* Optional fallback if frontend/server sends PUT instead of PATCH. */
router.put("/:id/reject", (req, res, next) => {
  req.method = "PATCH";
  router.handle(req, res, next);
});

/* =========================
   ACCEPT BY BARANGAY
========================= */
router.put("/:id/accept", (req, res) => {
  const complaintId = req.params.id;
  const { accepted_by } = req.body;

  const acceptedBy = parseOptionalInt(accepted_by);

  const sql = `
    UPDATE complaints
    SET status = 'accepted_by_barangay',
        accepted_by = ?,
        accepted_at = NOW()
    WHERE id = ?
  `;

  db.query(sql, [acceptedBy, complaintId], (err) => {
    if (err) {
      console.error("Accept complaint error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to accept complaint.",
        error: err.message,
        code: err.code
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
   OPTIONAL GPS START POINT SUPPORT
========================= */
router.put("/:id/resolve", upload.single("evidence"), (req, res) => {
  const complaintId = req.params.id;

  const {
    handled_by_barangay_name,
    resolution_report,
    resolved_by,
    resolver_latitude,
    resolver_longitude
  } = req.body;

  const handledBy = cleanText(handled_by_barangay_name);
  const report = cleanText(resolution_report);

  /*
    IMPORTANT:
    complaints.resolved_by is INT in your DB.
    Mobile may send username/barangay text.
    If it is not numeric, save NULL to prevent SQL type errors.
  */
  const resolvedBy = parseOptionalInt(resolved_by);

  if (!handledBy || !report) {
    return res.status(400).json({
      success: false,
      message: "Personnel name and resolution report are required."
    });
  }

  const evidenceUrl = req.file
    ? `/uploads/complaints/${req.file.filename}`
    : null;

  const resolverLat = parseOptionalCoordinate(resolver_latitude);
  const resolverLng = parseOptionalCoordinate(resolver_longitude);

  getComplaintColumnSet((columnErr, columnSet) => {
    if (columnErr) {
      return res.status(500).json({
        success: false,
        message: "Failed to inspect complaint table columns.",
        error: columnErr.message
      });
    }

    const setClauses = [
      "status = 'resolved'",
      "handled_by_barangay_name = ?",
      "resolution_report = ?",
      "resolution_evidence_url = ?",
      "resolved_by = ?",
      "resolved_at = NOW()"
    ];

    const values = [
      handledBy,
      report,
      evidenceUrl,
      resolvedBy
    ];

    const canSaveResolverLatitude = hasColumn(columnSet, "resolver_latitude");
    const canSaveResolverLongitude = hasColumn(columnSet, "resolver_longitude");

    if (resolverLat !== null && canSaveResolverLatitude) {
      setClauses.push("resolver_latitude = ?");
      values.push(resolverLat);
    }

    if (resolverLng !== null && canSaveResolverLongitude) {
      setClauses.push("resolver_longitude = ?");
      values.push(resolverLng);
    }

    const sql = `
      UPDATE complaints
      SET ${setClauses.join(",\n          ")}
      WHERE id = ?
        AND status IN ('forwarded', 'in_progress')
    `;

    values.push(complaintId);

    db.query(sql, values, (err, result) => {
      if (err) {
        console.error("Resolve complaint error:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to resolve complaint.",
          error: err.message,
          code: err.code
        });
      }

      if (!result || result.affectedRows === 0) {
        return res.status(400).json({
          success: false,
          message: "Complaint could not be resolved. It may already be resolved or not forwarded yet."
        });
      }

      logUploadedFile("=== RESOLUTION UPLOAD DEBUG ===", req.file);

      console.log("=== RESOLUTION GPS DEBUG ===");
      console.log("raw resolved_by from mobile:", resolved_by);
      console.log("saved resolvedBy:", resolvedBy);
      console.log("resolver_latitude from mobile:", resolver_latitude);
      console.log("resolver_longitude from mobile:", resolver_longitude);
      console.log("parsed resolverLat:", resolverLat);
      console.log("parsed resolverLng:", resolverLng);
      console.log("canSaveResolverLatitude:", canSaveResolverLatitude);
      console.log("canSaveResolverLongitude:", canSaveResolverLongitude);

      return res.json({
        success: true,
        message: "Complaint resolved successfully.",
        complaint_id: complaintId,
        resolution_evidence_url: evidenceUrl,
        resolved_by_saved: resolvedBy,
        resolver_location_received: resolverLat !== null && resolverLng !== null,
        resolver_location_saved:
          resolverLat !== null &&
          resolverLng !== null &&
          canSaveResolverLatitude &&
          canSaveResolverLongitude,
        missing_columns:
          !canSaveResolverLatitude || !canSaveResolverLongitude
            ? {
                resolver_latitude: !canSaveResolverLatitude,
                resolver_longitude: !canSaveResolverLongitude
              }
            : null
      });
    });
  });
});

/* =========================
   COMPLAINT HISTORY (WMO)
   Includes resolved and rejected complaints
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
    WHERE c.status IN ('resolved', 'rejected')
    ORDER BY
      CASE
        WHEN c.status = 'rejected' THEN COALESCE(c.rejected_at, c.created_at)
        ELSE COALESCE(c.resolved_at, c.created_at)
      END DESC,
      c.created_at DESC
  `;

  console.log("GET /api/complaints/history/resolved hit");

  db.query(sql, (err, rows) => {
    if (err) {
      console.error("Complaint history error FULL:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to load complaint history.",
        error: err.message,
        code: err.code
      });
    }

    console.log("Complaint history rows:", rows);

    return res.json({
      success: true,
      complaints: rows || []
    });
  });
});

/* =========================
   BARANGAY COMPLAINT ANALYTICS
   Citizen dashboard resolved count:
   - Shows RESOLVED complaints only.
   - Filters by current month using resolved_at.
   - Also returns total_issues for old Android compatibility.
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

    /*
      Monthly reset logic:
      This counts only complaints that were resolved within the current month.
      Example:
      - May resolved complaints show in May.
      - When June starts, May resolved complaints are no longer counted here.
    */
    const sql = `
      SELECT
        COUNT(*) AS resolved_this_month
      FROM complaints
      WHERE LOWER(TRIM(assigned_barangay)) = LOWER(TRIM(?))
        AND LOWER(TRIM(status)) = 'resolved'
        AND resolved_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
        AND resolved_at < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
    `;

    db.query(sql, [barangay], (err, rows) => {
      if (err) {
        console.error("Barangay complaint analytics error:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to load barangay complaint analytics.",
          error: err.message,
          code: err.code
        });
      }

      const summary = rows && rows.length
        ? rows[0]
        : { resolved_this_month: 0 };

      const resolvedThisMonth = Number(summary.resolved_this_month || 0);

      return res.json({
        success: true,
        summary: {
          resolved_this_month: resolvedThisMonth,
          resolved_issues: resolvedThisMonth,
          resolved_count: resolvedThisMonth,

          /*
            Keep this for backward compatibility with any older mobile build
            still reading summary.total_issues.
            Current updated CitizenHomeActivity reads resolved_this_month first.
          */
          total_issues: resolvedThisMonth
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

  db.query(sql, [complaintId], (err) => {
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
