const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

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

const isCloudinaryConfigured = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
} else {
  console.warn(
    "Cloudinary is not configured. Complaint uploads will fall back to local /uploads storage."
  );
}

/*
  Use memory storage so uploads can be sent directly to Cloudinary.
  Local disk is only used as fallback when Cloudinary env variables are missing.
*/
const storage = multer.memoryStorage();

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

function getUploadExtension(file) {
  const allowedExts = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  const originalExt = path.extname(file?.originalname || "").toLowerCase();

  if (allowedExts.has(originalExt)) {
    return originalExt;
  }

  const mimeExtMap = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp"
  };

  return mimeExtMap[file?.mimetype] || ".jpg";
}

function buildLocalUploadFilename(prefix, file) {
  const safePrefix = cleanText(prefix) || "complaint";
  const uniquePart = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  return `${safePrefix}_${uniquePart}${getUploadExtension(file)}`;
}

function uploadBufferToCloudinary(file, folderName = "complaints") {
  return new Promise((resolve, reject) => {
    if (!file || !file.buffer || file.buffer.length <= 0) {
      return reject(new Error("No image buffer found for upload."));
    }

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `wmo/${folderName}`,
        resource_type: "image",
        use_filename: false,
        unique_filename: true,
        overwrite: false
      },
      (error, result) => {
        if (error) {
          return reject(error);
        }

        if (!result || !result.secure_url) {
          return reject(new Error("Cloudinary upload did not return a secure URL."));
        }

        return resolve(result.secure_url);
      }
    );

    uploadStream.end(file.buffer);
  });
}

function saveUploadedImageLocally(file, prefix = "complaint") {
  return new Promise((resolve, reject) => {
    if (!file || !file.buffer || file.buffer.length <= 0) {
      return reject(new Error("No image buffer found for local upload."));
    }

    const filename = buildLocalUploadFilename(prefix, file);
    const absolutePath = path.join(uploadDir, filename);
    const publicPath = `/uploads/complaints/${filename}`;

    fs.writeFile(absolutePath, file.buffer, (err) => {
      if (err) {
        return reject(err);
      }

      return resolve(publicPath);
    });
  });
}

function saveUploadedComplaintImage(file, folderName = "complaints") {
  if (!file) {
    return Promise.resolve(null);
  }

  if (!file.buffer || file.buffer.length <= 0) {
    return Promise.reject(new Error("Uploaded image is empty or corrupted."));
  }

  if (isCloudinaryConfigured) {
    return uploadBufferToCloudinary(file, folderName);
  }

  return saveUploadedImageLocally(file, folderName === "resolutions" ? "resolution" : "complaint");
}

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



function normalizeBarangayName(value) {
  const cleaned = cleanText(value);

  if (!cleaned) return "";

  if (
    cleaned.toLowerCase() === "for verification" ||
    cleaned.toLowerCase() === "select concern barangay"
  ) {
    return "";
  }

  return cleaned;
}



function resolveNearestBarangayByReferencePoint(point, callback) {
  const lat = Number(point && point.lat);
  const lng = Number(point && point.lng);

  if (
    Number.isNaN(lat) ||
    Number.isNaN(lng) ||
    lat === 0 ||
    lng === 0
  ) {
    return callback(null, null);
  }

  /*
    Main auto-assignment source:
    barangay_reference_points

    Why:
    - The complaint is expected to be assigned to the nearest barangay/location.
    - Some polygon boundary records can be too broad or inaccurate.
    - Reference points are easier to maintain in MySQL and match what WMO sees on the map.
  */
  const sql = `
    SELECT
      id,
      barangay_name,
      reference_name,
      latitude,
      longitude
    FROM barangay_reference_points
    WHERE status = 'active'
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      console.error("Failed to load barangay reference points for assignment:", err);
      return callback(err, null);
    }

    let nearest = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    (rows || []).forEach((row) => {
      const refLat = Number(row.latitude);
      const refLng = Number(row.longitude);

      if (
        Number.isNaN(refLat) ||
        Number.isNaN(refLng) ||
        refLat === 0 ||
        refLng === 0
      ) {
        return;
      }

      const distanceMeters = calculateDistanceMeters(
        { lat, lng },
        { lat: refLat, lng: refLng }
      );

      if (distanceMeters < nearestDistance) {
        nearestDistance = distanceMeters;
        nearest = {
          barangay_name: row.barangay_name,
          reference_name: row.reference_name,
          latitude: refLat,
          longitude: refLng,
          distance_meters: Math.round(distanceMeters)
        };
      }
    });

    return callback(null, nearest);
  });
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

function getComplaintNotificationColumnSet(callback) {
  const sql = `SHOW COLUMNS FROM complaint_notifications`;

  db.query(sql, (err, rows) => {
    if (err) {
      console.error("Failed to inspect complaint_notifications columns:", err);
      return callback(err, new Set());
    }

    const columnSet = new Set(
      (rows || []).map((row) => String(row.Field || "").trim())
    );

    return callback(null, columnSet);
  });
}

function runSequentialSql(sqlList, callback) {
  const statements = sqlList || [];

  const runNext = (index) => {
    if (index >= statements.length) {
      return callback(null);
    }

    db.query(statements[index], (err) => {
      if (err) {
        return callback(err);
      }

      return runNext(index + 1);
    });
  };

  return runNext(0);
}

function ensureComplaintNotificationClearColumns(callback) {
  getComplaintNotificationColumnSet((columnErr, columnSet) => {
    if (columnErr) {
      return callback(columnErr);
    }

    const alterSql = [];

    if (!hasColumn(columnSet, "cleared_at")) {
      alterSql.push(`
        ALTER TABLE complaint_notifications
        ADD COLUMN cleared_at DATETIME NULL
      `);
    }

    if (!hasColumn(columnSet, "cleared_by")) {
      alterSql.push(`
        ALTER TABLE complaint_notifications
        ADD COLUMN cleared_by VARCHAR(255) NULL
      `);
    }

    if (alterSql.length === 0) {
      return callback(null);
    }

    runSequentialSql(alterSql, (alterErr) => {
      if (alterErr) {
        console.error("Failed to add notification clear columns:", alterErr);
        return callback(alterErr);
      }

      console.log("Complaint notification clear columns checked/added.");
      return callback(null);
    });
  });
}

function hasColumn(columnSet, columnName) {
  return columnSet && columnSet.has(columnName);
}

function logUploadedFile(prefix, file) {
  console.log(prefix);

  if (file) {
    console.log("Original file name:", file.originalname || file.filename || "memory-upload");
    console.log("File path:", file.path || "memory/cloud upload");
    console.log("File size:", file.size);
    console.log("Mime type:", file.mimetype);
    console.log("Storage target:", isCloudinaryConfigured ? "cloudinary" : "local fallback");
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
      longitude,
      selected_concern_barangay,
      detected_barangay_preview
    } = req.body;

    const clientRequestId = cleanText(client_request_id).slice(0, 80);
    const selectedConcernBarangay = normalizeBarangayName(selected_concern_barangay);
    const detectedBarangayPreview = normalizeBarangayName(detected_barangay_preview);

    if (!citizen_id || !subject || !latitude || !longitude) {
      deleteUploadedFileIfExists(req.file);

      return res.status(400).json({
        success: false,
        message: "Missing required complaint fields."
      });
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        success: false,
        message: "Image upload failed or missing."
      });
    }

    if (req.file.size <= 0 || req.file.buffer.length <= 0) {
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
        const finishComplaintCreation = (
          finalBarangay,
          assignmentMethod,
          assignmentDebug = {}
        ) => {
          const status = "pending";

          if (!finalBarangay || finalBarangay === "undefined") {
            finalBarangay = "For Verification";
            assignmentMethod = "manual_review";
          }

          saveUploadedComplaintImage(req.file, "complaints")
            .then((imageUrl) => {
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
                status
              ];

              if (canSaveClientRequestId) {
                insertColumns.push("client_request_id");
                insertValues.push(clientRequestId || null);
              }

              const placeholders = insertColumns.map(() => "?").join(", ");

              const insertSql = `
                INSERT INTO complaints (
                  ${insertColumns.join(",\n                  ")}
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
                      assignmentMethod === "user_selected"
                        ? "Complaint submitted successfully with selected concern barangay."
                        : assignmentMethod === "polygon"
                        ? "Complaint submitted successfully and assigned by barangay boundary."
                        : "Complaint submitted successfully and marked for manual verification.",
                    complaintId,
                    reporter_barangay: reporter_barangay || null,
                    assigned_barangay: finalBarangay,
                    assignment_method: assignmentMethod,
                    assignment_debug: assignmentDebug,
                    image_url: imageUrl,
                    storage: isCloudinaryConfigured ? "cloudinary" : "local",
                    client_request_id_saved: canSaveClientRequestId && Boolean(clientRequestId),
                    missing_columns: !canSaveClientRequestId
                      ? {
                          client_request_id: true
                        }
                      : null
                  });
                });
              });
            })
            .catch((uploadErr) => {
              console.error("Complaint image upload error:", uploadErr);

              return res.status(500).json({
                success: false,
                message: "Failed to upload complaint image.",
                error: uploadErr.message,
                storage: isCloudinaryConfigured ? "cloudinary" : "local"
              });
            });
        };

        /*
          If the citizen selected a barangay after the pin preview,
          respect that selection. This is the practical fallback while
          barangay boundary polygons are still incomplete.
        */
        if (selectedConcernBarangay) {
          return finishComplaintCreation(
            selectedConcernBarangay,
            "user_selected",
            {
              source: "android_manual_selection",
              detected_barangay_preview: detectedBarangayPreview || null,
              note: "Citizen selected the concern barangay after pinning the issue location."
            }
          );
        }

        /*
          IMPORTANT FIX:
          Complaint assignment must NOT be based on the nearest barangay hall/reference point.
          It must follow barangay jurisdiction/boundary.

          Rules:
          1. If the issue coordinate is inside a barangay polygon, assign to that barangay.
          2. If no polygon covers the coordinate, mark as "For Verification".
          3. WMO can then choose the correct barangay manually from the map modal.

          This prevents a Mabuhay-covered issue from being incorrectly assigned to
          San Isidro only because the San Isidro reference point is nearer.
        */
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
            const polygonMatchedBarangay = resolveBarangayByPolygon(
              { lat, lng },
              boundaryRows || []
            );

            if (polygonMatchedBarangay) {
              return finishComplaintCreation(
                polygonMatchedBarangay,
                "polygon",
                {
                  source: "barangay_boundaries",
                  note: "Assigned by barangay jurisdiction polygon. Nearest reference point was not used."
                }
              );
            }

            return finishComplaintCreation(
              "For Verification",
              "manual_review",
              {
                source: "manual_review",
                note: "No barangay boundary polygon covered this coordinate. Nearest barangay was intentionally not used."
              }
            );
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
  const sql = `
    SELECT *
    FROM complaints
    ORDER BY created_at DESC
  `;

  db.query(sql, (err, rows) => {
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
  const resolvedBy = parseOptionalInt(resolved_by);

  if (!handledBy || !report) {
    return res.status(400).json({
      success: false,
      message: "Personnel name and resolution report are required."
    });
  }

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

    saveUploadedComplaintImage(req.file, "resolutions")
      .then((evidenceUrl) => {
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
          SET ${setClauses.join(",\n              ")}
          WHERE id = ?
            AND status IN ('forwarded', 'in_progress', 'accepted_by_barangay')
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

          return res.json({
            success: true,
            message: "Complaint resolved successfully.",
            complaint_id: complaintId,
            resolution_evidence_url: evidenceUrl,
            storage: isCloudinaryConfigured ? "cloudinary" : "local",
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
      })
      .catch((uploadErr) => {
        console.error("Resolution evidence upload error:", uploadErr);

        return res.status(500).json({
          success: false,
          message: "Failed to upload resolution evidence.",
          error: uploadErr.message,
          storage: isCloudinaryConfigured ? "cloudinary" : "local"
        });
      });
  });
});

/* =========================
   COMPLAINT HISTORY (WMO)
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
   Actual active concerns count/list.
   Do not use this as the notification badge source.
========================= */
router.get("/barangay/:barangayName", (req, res) => {
  const barangayName = decodeURIComponent(req.params.barangayName || "").trim();

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
      AND c.status IN ('forwarded', 'in_progress', 'accepted_by_barangay')
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
   Source of truth for the barangay bell badge/dropdown.
   Cleared notifications stay in MySQL with cleared_at and will not appear again.
========================= */
router.get("/notifications/barangay/:barangayName", (req, res) => {
  const barangayName = decodeURIComponent(req.params.barangayName || "").trim();

  ensureComplaintNotificationClearColumns((ensureErr) => {
    if (ensureErr) {
      return res.status(500).json({
        success: false,
        message: "Failed to prepare barangay notification clearing.",
        error: ensureErr.message,
        code: ensureErr.code
      });
    }

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
        AND TRIM(LOWER(cn.target_name)) = TRIM(LOWER(?))
        AND cn.cleared_at IS NULL
        AND c.status IN ('forwarded', 'in_progress', 'accepted_by_barangay')
      ORDER BY cn.created_at DESC
    `;

    db.query(sql, [barangayName], (err, rows) => {
      if (err) {
        console.error("Barangay complaint notification error:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to load barangay complaint notifications.",
          error: err.message,
          code: err.code
        });
      }

      return res.json({
        success: true,
        notifications: rows || []
      });
    });
  });
});


/* =========================
   CLEAR SINGLE BARANGAY NOTIFICATION
   User must select one notification first.
   This only clears one notification row.
========================= */
router.post("/notifications/barangay/:barangayName/:notificationId/clear", (req, res) => {
  const barangayName = decodeURIComponent(req.params.barangayName || "").trim();
  const notificationId = parseOptionalInt(req.params.notificationId);
  const clearedBy = cleanText(req.body && req.body.cleared_by) || barangayName || "barangay";

  if (!barangayName) {
    return res.status(400).json({
      success: false,
      message: "Barangay name is required."
    });
  }

  if (!notificationId) {
    return res.status(400).json({
      success: false,
      message: "Valid notification id is required."
    });
  }

  ensureComplaintNotificationClearColumns((ensureErr) => {
    if (ensureErr) {
      return res.status(500).json({
        success: false,
        message: "Failed to prepare barangay notification clearing.",
        error: ensureErr.message,
        code: ensureErr.code
      });
    }

    const sql = `
      UPDATE complaint_notifications cn
      INNER JOIN complaints c ON c.id = cn.complaint_id
      SET cn.cleared_at = NOW(),
          cn.cleared_by = ?
      WHERE cn.id = ?
        AND cn.target_type = 'barangay'
        AND TRIM(LOWER(cn.target_name)) = TRIM(LOWER(?))
        AND cn.cleared_at IS NULL
        AND c.status IN ('forwarded', 'in_progress', 'accepted_by_barangay')
    `;

    db.query(sql, [clearedBy, notificationId, barangayName], (err, result) => {
      if (err) {
        console.error("Clear single barangay notification error:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to clear selected notification.",
          error: err.message,
          code: err.code
        });
      }

      if (!result || result.affectedRows === 0) {
        return res.status(404).json({
          success: false,
          message: "Selected notification was not found or already cleared."
        });
      }

      return res.json({
        success: true,
        message: "Selected notification cleared.",
        barangay: barangayName,
        notification_id: notificationId,
        cleared_count: result.affectedRows || 0
      });
    });
  });
});

router.patch("/notifications/barangay/:barangayName/:notificationId/clear", (req, res, next) => {
  req.method = "POST";
  router.handle(req, res, next);
});

/* =========================
   CLEAR BARANGAY NOTIFICATIONS
   This only clears the notification badge/dropdown.
   It does NOT delete complaints and does NOT remove actual forwarded concerns.
========================= */
router.post("/notifications/barangay/:barangayName/clear", (req, res) => {
  const barangayName = decodeURIComponent(req.params.barangayName || "").trim();
  const clearedBy = cleanText(req.body && req.body.cleared_by) || barangayName || "barangay";

  if (!barangayName) {
    return res.status(400).json({
      success: false,
      message: "Barangay name is required."
    });
  }

  ensureComplaintNotificationClearColumns((ensureErr) => {
    if (ensureErr) {
      return res.status(500).json({
        success: false,
        message: "Failed to prepare barangay notification clearing.",
        error: ensureErr.message,
        code: ensureErr.code
      });
    }

    const sql = `
      UPDATE complaint_notifications cn
      INNER JOIN complaints c ON c.id = cn.complaint_id
      SET cn.cleared_at = NOW(),
          cn.cleared_by = ?
      WHERE cn.target_type = 'barangay'
        AND TRIM(LOWER(cn.target_name)) = TRIM(LOWER(?))
        AND cn.cleared_at IS NULL
        AND c.status IN ('forwarded', 'in_progress', 'accepted_by_barangay')
    `;

    db.query(sql, [clearedBy, barangayName], (err, result) => {
      if (err) {
        console.error("Clear barangay notifications error:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to clear barangay notifications.",
          error: err.message,
          code: err.code
        });
      }

      return res.json({
        success: true,
        message: "Barangay notifications cleared.",
        barangay: barangayName,
        cleared_count: result ? result.affectedRows || 0 : 0
      });
    });
  });
});

router.patch("/notifications/barangay/:barangayName/clear", (req, res, next) => {
  req.method = "POST";
  router.handle(req, res, next);
});

/* =========================
   MARK AS IN PROGRESS
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
   DETECT BARANGAY BY COORDINATES
   Used by Android after the citizen pins their location.
   IMPORTANT:
   This preview uses barangay boundary/jurisdiction only.
   It does NOT use nearest barangay reference point as the basis.
========================= */
router.get("/detect-barangay", (req, res) => {
  const lat = parseFloat(req.query.latitude);
  const lng = parseFloat(req.query.longitude);

  if (Number.isNaN(lat) || Number.isNaN(lng) || lat === 0 || lng === 0) {
    return res.status(400).json({
      success: false,
      message: "Valid latitude and longitude are required.",
      assigned_barangay: "For Verification",
      assignment_method: "invalid_coordinates"
    });
  }

  const boundarySql = `
    SELECT barangay_name, polygon_json
    FROM barangay_boundaries
    WHERE status = 'active'
  `;

  db.query(boundarySql, (boundaryErr, boundaryRows) => {
    if (boundaryErr) {
      console.error("Detect barangay boundary query error:", boundaryErr);

      return res.status(500).json({
        success: false,
        message: "Failed to detect barangay boundary.",
        assigned_barangay: "For Verification",
        assignment_method: "boundary_error",
        error: boundaryErr.message,
        code: boundaryErr.code
      });
    }

    try {
      const matchedBarangay = resolveBarangayByPolygon(
        { lat, lng },
        boundaryRows || []
      );

      if (matchedBarangay) {
        return res.json({
          success: true,
          assigned_barangay: matchedBarangay,
          concern_barangay: matchedBarangay,
          assignment_method: "polygon",
          coordinates: {
            latitude: lat,
            longitude: lng
          }
        });
      }

      return res.json({
        success: true,
        assigned_barangay: "For Verification",
        concern_barangay: "For Verification",
        assignment_method: "manual_review",
        message: "No barangay boundary covered this coordinate.",
        coordinates: {
          latitude: lat,
          longitude: lng
        }
      });
    } catch (error) {
      console.error("Detect barangay resolution error:", error);

      return res.status(500).json({
        success: false,
        message: "Barangay detection failed.",
        assigned_barangay: "For Verification",
        assignment_method: "detect_error",
        error: error.message
      });
    }
  });
});


/* =========================
   GET SINGLE COMPLAINT
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
