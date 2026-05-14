const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

const db = require("../config/db");
const {
  createCitizenNotificationRecord
} = require("../controllers/notificationController");
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

const GENSAN_BARANGAY_CANONICAL_NAMES = [
  "Apopong",
  "Baluan",
  "Batomelong",
  "Buayan",
  "Bula",
  "Calumpang",
  "City Heights",
  "Conel",
  "Dadiangas East",
  "Dadiangas North",
  "Dadiangas South",
  "Dadiangas West",
  "Fatima",
  "Katangawan",
  "Labangal",
  "Lagao",
  "Ligaya",
  "Mabuhay",
  "Olympog",
  "San Isidro",
  "San Jose",
  "Siguel",
  "Sinawal",
  "Tambler",
  "Tinagacan",
  "Upper Labay"
];

function normalizeBarangayKey(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/barangay/g, "")
    .replace(/brgy\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function canonicalizeBarangayName(value) {
  const cleaned = cleanText(value);

  if (!cleaned) return "";

  if (
    cleaned.toLowerCase() === "for verification" ||
    cleaned.toLowerCase() === "select concern barangay"
  ) {
    return "";
  }

  const inputKey = normalizeBarangayKey(cleaned);

  if (!inputKey) return "";

  const match = GENSAN_BARANGAY_CANONICAL_NAMES.find((barangay) =>
    normalizeBarangayKey(barangay) === inputKey
  );

  return match || cleaned;
}

function normalizeSqlBarangayExpression(columnName) {
  return `LOWER(REPLACE(REPLACE(REPLACE(TRIM(${columnName}), ' ', ''), '-', ''), '.', ''))`;
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

function createCitizenNotificationSafe(payload = {}, contextLabel = "citizen notification") {
  if (typeof createCitizenNotificationRecord !== "function") {
    console.warn("createCitizenNotificationRecord is not available for", contextLabel);
    return;
  }

  createCitizenNotificationRecord(payload).catch((error) => {
    console.error(`Failed to create ${contextLabel}:`, error);
  });
}

function createComplaintSubmittedCitizenNotification(complaintId, source = {}) {
  const citizenId = parseOptionalInt(source.citizen_id || source.citizenId);
  const barangay = normalizeBarangayName(source.reporter_barangay || source.barangay || "");
  const subject = truncateNotificationText(source.subject || "your complaint", 80);

  if (!citizenId && !barangay) return;

  createCitizenNotificationSafe(
    {
      user_id: citizenId || null,
      barangay: barangay || null,
      type: "complaint_submitted_to_wmo",
      title: "Complaint submitted to WMO",
      message: subject
        ? `Your complaint "${subject}" was submitted to WMO for review. We will notify you when action is taken.`
        : "Your complaint was submitted to WMO for review. We will notify you when action is taken.",
      reference_id: `complaint:${complaintId}:submitted`
    },
    "citizen complaint submitted notification"
  );
}

function createComplaintResolvedCitizenNotifications(complaintId, complaint = {}) {
  const citizenId = parseOptionalInt(complaint.citizen_id || complaint.citizenId);
  const reporterBarangay = normalizeBarangayName(complaint.reporter_barangay || "");
  const actedBarangay = normalizeBarangayName(
    complaint.handled_by_barangay_name || complaint.assigned_barangay || complaint.barangay || ""
  );
  const subject = truncateNotificationText(complaint.subject || "a reported issue", 80);

  if (actedBarangay) {
    createCitizenNotificationSafe(
      {
        barangay: actedBarangay,
        type: "barangay_resolution_feedback",
        title: "Barangay action update",
        message: `${actedBarangay} resolved a WMO-forwarded complaint${subject ? ` about "${subject}"` : ""}. Thank you for helping keep your barangay responsive and clean.`,
        reference_id: `complaint:${complaintId}:barangay-resolved`
      },
      "barangay resolution feedback notification"
    );
  }

  /*
    If the reporting citizen belongs to a different barangay than the acting
    barangay, notify that citizen directly too. If same barangay, the citizen
    already receives the barangay-wide feedback notification above.
  */
  if (
    citizenId &&
    (!reporterBarangay || !actedBarangay || normalizeBarangayKey(reporterBarangay) !== normalizeBarangayKey(actedBarangay))
  ) {
    createCitizenNotificationSafe(
      {
        user_id: citizenId,
        barangay: reporterBarangay || null,
        type: "complaint_resolution_citizen",
        title: "Your complaint was resolved",
        message: `${actedBarangay || "The assigned barangay"} submitted a resolution report to WMO${subject ? ` for "${subject}"` : ""}.`,
        reference_id: `complaint:${complaintId}:citizen-resolved`
      },
      "citizen complaint resolved notification"
    );
  }
}



function normalizeBarangayName(value) {
  return canonicalizeBarangayName(value);
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



function resolveBarangayFromLearnedComplaints(point, callback) {
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
    Learned fallback:
    If barangay boundaries are incomplete, use previous complaints that already have
    a final/selected assigned_barangay near the same coordinate.

    This does NOT replace official boundary polygons.
    It only helps repeated/same-area reports while polygons are still being completed.
  */
  const sql = `
    SELECT
      id,
      assigned_barangay,
      assignment_method,
      latitude,
      longitude,
      status,
      created_at
    FROM complaints
    WHERE assigned_barangay IS NOT NULL
      AND TRIM(assigned_barangay) <> ''
      AND LOWER(TRIM(assigned_barangay)) <> 'for verification'
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL
    ORDER BY
      CASE
        WHEN assignment_method IN ('user_selected', 'manual_correction', 'polygon') THEN 0
        ELSE 1
      END,
      id DESC
    LIMIT 250
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      console.error("Learned barangay lookup error:", err);
      return callback(err, null);
    }

    let nearest = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    (rows || []).forEach((row) => {
      const rowLat = Number(row.latitude);
      const rowLng = Number(row.longitude);

      if (
        Number.isNaN(rowLat) ||
        Number.isNaN(rowLng) ||
        rowLat === 0 ||
        rowLng === 0
      ) {
        return;
      }

      const distanceMeters = calculateDistanceMeters(
        { lat, lng },
        { lat: rowLat, lng: rowLng }
      );

      if (distanceMeters < nearestDistance) {
        nearestDistance = distanceMeters;
        nearest = {
          complaint_id: row.id,
          barangay_name: row.assigned_barangay,
          assignment_method: row.assignment_method,
          status: row.status,
          distance_meters: Math.round(distanceMeters),
          latitude: rowLat,
          longitude: rowLng
        };
      }
    });

    /*
      Same location / nearby location threshold.
      200 meters is practical for mobile GPS drift but still avoids guessing too far.
    */
    if (nearest && nearestDistance <= 200) {
      return callback(null, nearest);
    }

    return callback(null, null);
  });
}

function normalizeBarangayList(value) {
  let rawValues = [];

  if (Array.isArray(value)) {
    rawValues = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();

    /*
      Accept these frontend payload formats:
      - ["San Isidro", "Mabuhay"]
      - "San Isidro,Mabuhay"
      - "San Isidro & Mabuhay"
      - "San Isidro | Mabuhay"
      - "San Isidro and Mabuhay"
    */
    try {
      const parsed = JSON.parse(trimmed);

      if (Array.isArray(parsed)) {
        rawValues = parsed;
      } else {
        rawValues = trimmed.split(/\s*(?:,|\||&|\band\b)\s*/i);
      }
    } catch (_) {
      rawValues = trimmed.split(/\s*(?:,|\||&|\band\b)\s*/i);
    }
  }

  const seen = new Set();
  const list = [];

  rawValues.forEach((item) => {
    const barangay = normalizeBarangayName(item);
    if (!barangay) return;

    const key = normalizeBarangayKey(barangay);
    if (!key || seen.has(key)) return;

    seen.add(key);
    list.push(barangay);
  });

  return list;
}

function buildBarangayNotificationInsertSql(count) {
  const safeCount = Math.max(0, Number(count) || 0);

  if (safeCount <= 0) return "";

  const placeholders = Array.from({ length: safeCount }, () => "(?, 'barangay', ?)").join(", ");

  return `
    INSERT INTO complaint_notifications (
      complaint_id,
      target_type,
      target_name
    )
    VALUES ${placeholders}
  `;
}

function getBarangayMatchWhereSql(columnName) {
  /*
    Match "San Isidro", "San isidro", "Sanisidro", "San-Isidro"
    and other spacing/capitalization differences.
  */
  return `${normalizeSqlBarangayExpression(columnName)} = ?`;
}

function getBarangayMatchParam(barangayName) {
  return normalizeBarangayKey(barangayName);
}


function markOtherBarangayNotificationsCleared(complaintId, acceptedBarangay, callback) {
  ensureComplaintNotificationClearColumns((ensureErr) => {
    if (ensureErr) {
      console.error("Failed preparing notification cleanup after accept:", ensureErr);
      return callback && callback(ensureErr);
    }

    const sql = `
      UPDATE complaint_notifications
      SET cleared_at = NOW(),
          cleared_by = ?
      WHERE complaint_id = ?
        AND target_type = 'barangay'
        AND LOWER(REPLACE(REPLACE(REPLACE(TRIM(target_name), ' ', ''), '-', ''), '.', '')) <> ?
        AND cleared_at IS NULL
    `;

    db.query(sql, [acceptedBarangay, complaintId, getBarangayMatchParam(acceptedBarangay)], (err) => {
      if (err) {
        console.error("Failed clearing other barangay notifications:", err);
      }

      if (callback) callback(err || null);
    });
  });
}



function getComplaintBarangayNotificationTargets(complaintId, callback) {
  const sql = `
    SELECT target_name
    FROM complaint_notifications
    WHERE complaint_id = ?
      AND target_type = 'barangay'
      AND target_name IS NOT NULL
      AND TRIM(target_name) <> ''
    GROUP BY target_name
    ORDER BY MIN(created_at) ASC, MIN(id) ASC
  `;

  db.query(sql, [complaintId], (err, rows) => {
    if (err) {
      console.error("Failed loading complaint barangay notification targets:", err);
      return callback(err, []);
    }

    const targets = parseBarangayTargets((rows || []).map((row) => row.target_name));
    return callback(null, targets);
  });
}

function insertBarangayInfoNotifications(complaintId, targetBarangays, notificationType, title, message, callback) {
  const targets = parseBarangayTargets(targetBarangays);

  if (!targets.length) {
    return callback && callback(null);
  }

  ensureComplaintNotificationClearColumns((ensureErr) => {
    if (ensureErr) {
      console.error("Failed preparing barangay info notifications:", ensureErr);
      return callback && callback(ensureErr);
    }

    const placeholders = targets.map(() => "(?, 'barangay', ?, ?, ?, ?, 0)").join(", ");
    const sql = `
      INSERT INTO complaint_notifications (
        complaint_id,
        target_type,
        target_name,
        notification_type,
        title,
        message,
        is_read
      )
      VALUES ${placeholders}
    `;

    const values = [];
    targets.forEach((barangay) => {
      values.push(
        complaintId,
        barangay,
        cleanText(notificationType),
        cleanText(title),
        cleanText(message)
      );
    });

    db.query(sql, values, (err) => {
      if (err) {
        console.error("Failed inserting barangay info notifications:", err);
      }

      return callback && callback(err || null);
    });
  });
}

function insertWmoComplaintNotification(complaintId, notificationType, title, message, callback) {
  ensureComplaintNotificationClearColumns((ensureErr) => {
    if (ensureErr) {
      console.error("Failed preparing WMO complaint notification:", ensureErr);
      return callback && callback(ensureErr);
    }

    const sql = `
      INSERT INTO complaint_notifications (
        complaint_id,
        target_type,
        target_name,
        notification_type,
        title,
        message,
        is_read
      )
      VALUES (?, 'wmo', 'WMO', ?, ?, ?, 0)
    `;

    db.query(
      sql,
      [
        complaintId,
        cleanText(notificationType),
        cleanText(title),
        cleanText(message)
      ],
      (err) => {
        if (err) {
          console.error("Failed inserting WMO complaint notification:", err);
        }

        return callback && callback(err || null);
      }
    );
  });
}

function truncateNotificationText(value, maxLength = 180) {
  const clean = cleanText(value);

  if (clean.length <= maxLength) return clean;

  return clean.substring(0, Math.max(0, maxLength - 3)).trim() + "...";
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

    if (!hasColumn(columnSet, "notification_type")) {
      alterSql.push(`
        ALTER TABLE complaint_notifications
        ADD COLUMN notification_type VARCHAR(80) NULL
      `);
    }

    if (!hasColumn(columnSet, "title")) {
      alterSql.push(`
        ALTER TABLE complaint_notifications
        ADD COLUMN title VARCHAR(255) NULL
      `);
    }

    if (!hasColumn(columnSet, "message")) {
      alterSql.push(`
        ALTER TABLE complaint_notifications
        ADD COLUMN message TEXT NULL
      `);
    }

    if (!hasColumn(columnSet, "is_read")) {
      alterSql.push(`
        ALTER TABLE complaint_notifications
        ADD COLUMN is_read TINYINT(1) NOT NULL DEFAULT 0
      `);
    }

    if (alterSql.length === 0) {
      return callback(null);
    }

    runSequentialSql(alterSql, (alterErr) => {
      if (alterErr) {
        console.error("Failed to add notification support columns:", alterErr);
        return callback(alterErr);
      }

      console.log("Complaint notification support columns checked/added.");
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

                const notificationTitle = "New complaint received";
                const notificationMessage = `${cleanText(citizen_name) || cleanText(username) || "A citizen"} submitted a complaint${cleanText(subject) ? `: ${truncateNotificationText(subject, 90)}` : ""}.`;

                insertWmoComplaintNotification(
                  complaintId,
                  "citizen_complaint_received",
                  notificationTitle,
                  notificationMessage,
                  (notifErr) => {
                    if (notifErr) {
                      console.error("WMO complaint received notification insert error:", notifErr);
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

            return resolveBarangayFromLearnedComplaints({ lat, lng }, (learnedErr, learnedBarangay) => {
              if (learnedErr) {
                deleteUploadedFileIfExists(req.file);

                return res.status(500).json({
                  success: false,
                  message: "Failed to check learned barangay records.",
                  error: learnedErr.message,
                  code: learnedErr.code
                });
              }

              if (learnedBarangay && learnedBarangay.barangay_name) {
                return finishComplaintCreation(
                  learnedBarangay.barangay_name,
                  "learned_previous_complaint",
                  {
                    source: "complaints",
                    note: "No boundary polygon matched. Assigned from a previous selected/verified complaint near this coordinate.",
                    learned_match: learnedBarangay
                  }
                );
              }

              return finishComplaintCreation(
                "For Verification",
                "manual_review",
                {
                  source: "manual_review",
                  note: "No barangay boundary polygon or learned nearby complaint matched this coordinate. Nearest barangay was intentionally not used."
                }
              );
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

        const distanceMeters = calculateDistanceMeters(
          { lat, lng },
          { lat: refLat, lng: refLng }
        );

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
      .filter((candidate) =>
        candidate &&
        Number.isFinite(candidate.distance_meters)
      )
      .sort((a, b) => a.distance_meters - b.distance_meters)
      .slice(0, 10);

    return res.json({
      success: true,
      issue_location: {
        latitude: lat,
        longitude: lng
      },
      sorting_basis: "distance_from_issue_location_to_barangay_reference_point",
      candidates
    });
  });
});

/* =========================
   VALIDATE + FORWARD TO BARANGAY
========================= */
router.post("/:id/validate-forward", (req, res) => {
  const complaintId = req.params.id;
  const {
    validated_by,
    selected_barangay,
    selected_barangays,
    target_barangays,
    forwarding_barangays
  } = req.body || {};

  const requestedTargets = normalizeBarangayList(
    target_barangays || selected_barangays || forwarding_barangays || selected_barangay
  ).slice(0, 2);

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

    if (String(complaint.status || "").toLowerCase() !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Only pending complaints can be forwarded to barangays."
      });
    }

    const continueForwardToTargets = (targets) => {
      const finalTargets = normalizeBarangayList(targets).slice(0, 2);

      if (!finalTargets.length) {
        return res.status(400).json({
          success: false,
          message: "Please choose at least one barangay to forward this complaint."
        });
      }

      const updateSql = `
        UPDATE complaints
        SET status = 'forwarded',
            assignment_method = 'multi_forwarded',
            validated_at = NOW(),
            validated_by = ?
        WHERE id = ?
          AND status = 'pending'
      `;

      db.query(updateSql, [validated_by || null, complaintId], (updateErr, updateResult) => {
        if (updateErr) {
          console.error("Validate+multi-forward update error:", updateErr);
          return res.status(500).json({
            success: false,
            message: "Failed to forward complaint."
          });
        }

        if (!updateResult || updateResult.affectedRows === 0) {
          return res.status(400).json({
            success: false,
            message: "Complaint could not be forwarded. It may have already been processed."
          });
        }

        const deleteOldBarangayNotifSql = `
          DELETE FROM complaint_notifications
          WHERE complaint_id = ?
            AND target_type = 'barangay'
        `;

        db.query(deleteOldBarangayNotifSql, [complaintId], (deleteNotifErr) => {
          if (deleteNotifErr) {
            console.error("Failed clearing old barangay notifications before multi-forward:", deleteNotifErr);
            return res.status(500).json({
              success: false,
              message: "Complaint was forwarded, but old barangay notifications could not be cleared.",
              error: deleteNotifErr.message,
              code: deleteNotifErr.code
            });
          }

          const notifSql = buildBarangayNotificationInsertSql(finalTargets.length);
          const notifValues = [];

          finalTargets.forEach((barangay) => {
            notifValues.push(complaintId, barangay);
          });

          db.query(notifSql, notifValues, (notifErr) => {
          if (notifErr) {
            console.error("Multi barangay notification insert error:", notifErr);
            return res.status(500).json({
              success: false,
              message: "Complaint was forwarded, but barangay notifications could not be created.",
              error: notifErr.message,
              code: notifErr.code
            });
          }

            return res.json({
              success: true,
              message:
                finalTargets.length > 1
                  ? `Complaint forwarded to ${finalTargets.join(" and ")}. The first barangay that accepts will become the assigned barangay.`
                  : `Complaint forwarded to ${finalTargets[0]}.`,
              complaint_id: complaintId,
              concern_barangay: complaint.assigned_barangay || null,
              forwarded_to_barangays: finalTargets,
              notification_targets_created: finalTargets.length,
              assignment_method: "multi_forwarded"
            });
          });
        });
      });
    };

    if (requestedTargets.length) {
      return continueForwardToTargets(requestedTargets);
    }

    const lat = parseFloat(complaint.latitude);
    const lng = parseFloat(complaint.longitude);

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({
        success: false,
        message: "Complaint has invalid coordinates. Please choose barangays manually."
      });
    }

    const referenceSql = `
      SELECT barangay_name, reference_name, latitude, longitude
      FROM barangay_reference_points
      WHERE status = 'active'
    `;

    db.query(referenceSql, (refErr, refRows) => {
      if (refErr) {
        console.error("Failed loading reference points for multi-forward:", refErr);
        return res.status(500).json({
          success: false,
          message: "Failed to load nearby barangay options."
        });
      }

      const autoTargets = (refRows || [])
        .map((row) => {
          const refLat = Number(row.latitude);
          const refLng = Number(row.longitude);

          if (Number.isNaN(refLat) || Number.isNaN(refLng)) return null;

          return {
            barangay_name: row.barangay_name,
            distance_meters: calculateDistanceMeters(
              { lat, lng },
              { lat: refLat, lng: refLng }
            )
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.distance_meters - b.distance_meters)
        .map((item) => item.barangay_name);

      return continueForwardToTargets(autoTargets);
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
  const {
    accepted_by,
    accepted_barangay,
    barangay,
    target_barangay,
    handled_by_barangay_name
  } = req.body || {};

  const acceptedBy = parseOptionalInt(accepted_by);
  const acceptingBarangay = normalizeBarangayName(
    accepted_barangay || barangay || target_barangay || handled_by_barangay_name
  );

  const findSql = `
    SELECT *
    FROM complaints
    WHERE id = ?
    LIMIT 1
  `;

  db.query(findSql, [complaintId], (findErr, rows) => {
    if (findErr) {
      console.error("Find complaint before accept error:", findErr);
      return res.status(500).json({
        success: false,
        message: "Failed to find complaint before accepting.",
        error: findErr.message,
        code: findErr.code
      });
    }

    if (!rows || !rows.length) {
      return res.status(404).json({
        success: false,
        message: "Complaint not found."
      });
    }

    const complaint = rows[0];
    const currentStatus = String(complaint.status || "").toLowerCase();

    if (!["forwarded", "in_progress"].includes(currentStatus)) {
      return res.status(400).json({
        success: false,
        message: "Only forwarded complaints can be accepted by a barangay."
      });
    }

    const continueAccept = (finalBarangay) => {
      const cleanBarangay = normalizeBarangayName(finalBarangay);

      if (!cleanBarangay) {
        return res.status(400).json({
          success: false,
          message: "Accepting barangay is required."
        });
      }

      const verifySql = `
        SELECT id
        FROM complaint_notifications
        WHERE complaint_id = ?
          AND target_type = 'barangay'
          AND ${getBarangayMatchWhereSql("target_name")}
        LIMIT 1
      `;

      db.query(verifySql, [complaintId, getBarangayMatchParam(cleanBarangay)], (verifyErr, verifyRows) => {
        if (verifyErr) {
          console.error("Accept verify notification error:", verifyErr);
          return res.status(500).json({
            success: false,
            message: "Failed to verify forwarded barangay.",
            error: verifyErr.message,
            code: verifyErr.code
          });
        }

        if (!verifyRows || !verifyRows.length) {
          return res.status(400).json({
            success: false,
            message: "This complaint was not forwarded to the selected barangay."
          });
        }

        getComplaintBarangayNotificationTargets(complaintId, (targetErr, allTargets) => {
          if (targetErr) {
            return res.status(500).json({
              success: false,
              message: "Failed to read forwarded barangay targets.",
              error: targetErr.message,
              code: targetErr.code
            });
          }

          const otherBarangays = (allTargets || []).filter((target) => {
            return getBarangayMatchParam(target) !== getBarangayMatchParam(cleanBarangay);
          });

          const updateSql = `
            UPDATE complaints
            SET status = 'accepted_by_barangay',
                assigned_barangay = ?,
                assignment_method = 'accepted_by_barangay',
                accepted_by = ?,
                accepted_at = NOW()
            WHERE id = ?
              AND status IN ('forwarded', 'in_progress')
          `;

          db.query(updateSql, [cleanBarangay, acceptedBy, complaintId], (updateErr, updateResult) => {
            if (updateErr) {
              console.error("Accept complaint error:", updateErr);
              return res.status(500).json({
                success: false,
                message: "Failed to accept complaint.",
                error: updateErr.message,
                code: updateErr.code
              });
            }

            if (!updateResult || updateResult.affectedRows === 0) {
              return res.status(400).json({
                success: false,
                message: "Complaint could not be accepted. Another barangay may have already accepted it."
              });
            }

            markOtherBarangayNotificationsCleared(complaintId, cleanBarangay, () => {
              const subject = truncateNotificationText(complaint.subject || "Forwarded concern", 80);
              const infoTitle = `Accepted by ${cleanBarangay}`;
              const infoMessage = `${cleanBarangay} accepted the WMO-forwarded complaint${subject ? `: ${subject}` : ""}. No action is needed from your barangay.`;

              insertBarangayInfoNotifications(
                complaintId,
                otherBarangays,
                "accepted_by_other_barangay",
                infoTitle,
                infoMessage,
                () => {
                  return res.json({
                    success: true,
                    message: `Complaint accepted by ${cleanBarangay}.`,
                    complaint_id: complaintId,
                    assigned_barangay: cleanBarangay,
                    notified_barangays: otherBarangays,
                    status: "accepted_by_barangay"
                  });
                }
              );
            });
          });
        });
      });
    };

    if (acceptingBarangay) {
      return continueAccept(acceptingBarangay);
    }

    const fallbackSql = `
      SELECT target_name
      FROM complaint_notifications
      WHERE complaint_id = ?
        AND target_type = 'barangay'
      ORDER BY created_at ASC
      LIMIT 1
    `;

    db.query(fallbackSql, [complaintId], (fallbackErr, fallbackRows) => {
      if (fallbackErr) {
        console.error("Accept fallback lookup error:", fallbackErr);
        return res.status(500).json({
          success: false,
          message: "Failed to determine accepting barangay.",
          error: fallbackErr.message,
          code: fallbackErr.code
        });
      }

      return continueAccept(fallbackRows && fallbackRows[0] ? fallbackRows[0].target_name : "");
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

          const notifySql = `
            SELECT
              id,
              citizen_id,
              citizen_name,
              reporter_barangay,
              subject,
              assigned_barangay,
              handled_by_barangay_name
            FROM complaints
            WHERE id = ?
            LIMIT 1
          `;

          db.query(notifySql, [complaintId], (notifyLookupErr, notifyRows) => {
            const notifyComplaint = notifyRows && notifyRows[0] ? notifyRows[0] : {};
            const notifyBarangay = normalizeBarangayName(
              notifyComplaint.assigned_barangay || handledBy
            );
            const subject = truncateNotificationText(notifyComplaint.subject || "Resolved complaint", 80);
            const notificationTitle = "Resolution submitted to WMO";
            const notificationMessage = `Your barangay submitted the resolution report${subject ? ` for: ${subject}` : ""}. It was sent back to WMO for review.`;

            if (notifyLookupErr) {
              console.error("Resolution notification lookup error:", notifyLookupErr);
            }

            createComplaintResolvedCitizenNotifications(complaintId, notifyComplaint);

            insertBarangayInfoNotifications(
              complaintId,
              notifyBarangay ? [notifyBarangay] : [],
              "resolution_submitted_to_wmo",
              notificationTitle,
              notificationMessage,
              () => {
                const wmoResolutionTitle = "Resolved complaint submitted";
                const wmoResolutionMessage = `${notifyBarangay || handledBy || "A barangay"} submitted a resolution report${subject ? ` for: ${subject}` : ""}. Review the resolved complaint report.`;

                return insertWmoComplaintNotification(
                  complaintId,
                  "barangay_resolution_submitted",
                  wmoResolutionTitle,
                  wmoResolutionMessage,
                  () => {
                    return res.json({
                  success: true,
                  message: "Complaint resolved successfully.",
                  complaint_id: complaintId,
                  barangay_notification_target: notifyBarangay,
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
                  }
                );
              }
            );
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
      brp.image_url AS assigned_barangay_image_url,
      forwarded.forwarded_to_barangays,
      forwarded.forwarded_barangay_count
    FROM complaints c
    LEFT JOIN barangay_reference_points brp
      ON TRIM(LOWER(brp.barangay_name)) = TRIM(LOWER(c.assigned_barangay))
      AND brp.status = 'active'
    LEFT JOIN (
      SELECT
        complaint_id,
        GROUP_CONCAT(DISTINCT target_name ORDER BY target_name SEPARATOR ' & ') AS forwarded_to_barangays,
        COUNT(DISTINCT target_name) AS forwarded_barangay_count
      FROM complaint_notifications
      WHERE target_type = 'barangay'
        AND target_name IS NOT NULL
        AND TRIM(target_name) <> ''
      GROUP BY complaint_id
    ) forwarded
      ON forwarded.complaint_id = c.id
    WHERE c.status IN ('resolved', 'rejected', 'forwarded', 'accepted_by_barangay', 'in_progress')
    ORDER BY
      CASE
        WHEN c.status = 'rejected' THEN COALESCE(c.rejected_at, c.created_at)
        WHEN c.status IN ('forwarded', 'accepted_by_barangay', 'in_progress') THEN COALESCE(c.validated_at, c.accepted_at, c.in_progress_at, c.created_at)
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
      WHERE LOWER(REPLACE(REPLACE(REPLACE(TRIM(assigned_barangay), ' ', ''), '-', ''), '.', '')) = ?
        AND LOWER(TRIM(status)) = 'resolved'
        AND resolved_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
        AND resolved_at < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
    `;

    db.query(sql, [getBarangayMatchParam(barangay)], (err, rows) => {
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
    SELECT DISTINCT
      c.*,
      COALESCE(brp.reference_name, notif_brp.reference_name) AS assigned_reference_name,
      COALESCE(brp.latitude, notif_brp.latitude) AS assigned_barangay_lat,
      COALESCE(brp.longitude, notif_brp.longitude) AS assigned_barangay_lng,
      COALESCE(brp.image_url, notif_brp.image_url) AS assigned_barangay_image_url,
      cn.target_name AS forwarded_to_barangay
    FROM complaints c
    LEFT JOIN complaint_notifications cn
      ON cn.complaint_id = c.id
      AND cn.target_type = 'barangay'
      AND LOWER(REPLACE(REPLACE(REPLACE(TRIM(cn.target_name), ' ', ''), '-', ''), '.', '')) = ?
    LEFT JOIN barangay_reference_points brp
      ON TRIM(LOWER(brp.barangay_name)) = TRIM(LOWER(c.assigned_barangay))
      AND brp.status = 'active'
    LEFT JOIN barangay_reference_points notif_brp
      ON TRIM(LOWER(notif_brp.barangay_name)) = TRIM(LOWER(cn.target_name))
      AND notif_brp.status = 'active'
    WHERE (
        c.status = 'forwarded'
        AND cn.id IS NOT NULL
      )
      OR (
        c.status IN ('in_progress', 'accepted_by_barangay')
        AND LOWER(REPLACE(REPLACE(REPLACE(TRIM(c.assigned_barangay), ' ', ''), '-', ''), '.', '')) = ?
      )
    ORDER BY c.created_at DESC
  `;

  db.query(sql, [getBarangayMatchParam(barangayName), getBarangayMatchParam(barangayName)], (err, rows) => {
    if (err) {
      console.error("Barangay complaint list error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to load barangay complaints."
      });
    }

    const normalizedRows = (rows || []).map((row) => {
      if (String(row.status || "").toLowerCase() === "forwarded") {
        return {
          ...row,
          forwarded_to_barangay: row.forwarded_to_barangay || barangayName,
          assigned_barangay: row.forwarded_to_barangay || barangayName
        };
      }

      return row;
    });

    return res.json({
      success: true,
      complaints: normalizedRows
    });
  });
});

/* =========================
   WMO NOTIFICATIONS
   Source for web admin notification bell complaint feed.
========================= */
router.get("/notifications/wmo", (req, res) => {
  ensureComplaintNotificationClearColumns((ensureErr) => {
    if (ensureErr) {
      return res.status(500).json({
        success: false,
        message: "Failed to prepare WMO complaint notifications.",
        error: ensureErr.message,
        code: ensureErr.code
      });
    }

    const sql = `
      SELECT
        cn.*,
        COALESCE(
          NULLIF(TRIM(cn.title), ''),
          CASE
            WHEN c.status = 'resolved' THEN 'Resolved complaint submitted'
            ELSE 'New complaint received'
          END
        ) AS title,
        COALESCE(
          NULLIF(TRIM(cn.message), ''),
          CASE
            WHEN c.status = 'resolved' THEN CONCAT(COALESCE(c.handled_by_barangay_name, c.assigned_barangay, 'A barangay'), ' submitted a resolution report for: ', COALESCE(c.subject, 'Complaint'))
            ELSE CONCAT('Citizen complaint received: ', COALESCE(c.subject, 'No subject'))
          END
        ) AS message,
        COALESCE(NULLIF(TRIM(cn.notification_type), ''),
          CASE
            WHEN c.status = 'resolved' THEN 'barangay_resolution_submitted'
            ELSE 'citizen_complaint_received'
          END
        ) AS notification_type,
        c.subject,
        c.assigned_barangay,
        c.handled_by_barangay_name,
        c.status,
        c.image_url,
        c.latitude,
        c.longitude,
        c.created_at AS complaint_created_at,
        c.resolved_at
      FROM complaint_notifications cn
      INNER JOIN complaints c ON c.id = cn.complaint_id
      WHERE cn.target_type = 'wmo'
        AND cn.cleared_at IS NULL
      ORDER BY cn.created_at DESC, cn.id DESC
      LIMIT 50
    `;

    db.query(sql, (err, rows) => {
      if (err) {
        console.error("WMO complaint notification error:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to load WMO complaint notifications.",
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
        AND LOWER(REPLACE(REPLACE(REPLACE(TRIM(cn.target_name), ' ', ''), '-', ''), '.', '')) = ?
        AND cn.cleared_at IS NULL
        AND c.status IN ('forwarded', 'in_progress', 'accepted_by_barangay', 'resolved')
      ORDER BY cn.created_at DESC
    `;

    db.query(sql, [getBarangayMatchParam(barangayName)], (err, rows) => {
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
        AND LOWER(REPLACE(REPLACE(REPLACE(TRIM(cn.target_name), ' ', ''), '-', ''), '.', '')) = ?
        AND cn.cleared_at IS NULL
        AND c.status IN ('forwarded', 'in_progress', 'accepted_by_barangay', 'resolved')
    `;

    db.query(sql, [clearedBy, notificationId, getBarangayMatchParam(barangayName)], (err, result) => {
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
        AND LOWER(REPLACE(REPLACE(REPLACE(TRIM(cn.target_name), ' ', ''), '-', ''), '.', '')) = ?
        AND cn.cleared_at IS NULL
        AND c.status IN ('forwarded', 'in_progress', 'accepted_by_barangay', 'resolved')
    `;

    db.query(sql, [clearedBy, getBarangayMatchParam(barangayName)], (err, result) => {
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
  const {
    viewed_by,
    viewed_by_barangay,
    barangay,
    target_barangay,
    assigned_barangay
  } = req.body || {};

  const actingBarangay = normalizeBarangayName(
    viewed_by_barangay || barangay || target_barangay || assigned_barangay
  );

  const continueMarkInProgress = (finalBarangay) => {
    const cleanBarangay = normalizeBarangayName(finalBarangay);

    const setClauses = [
      "status = 'in_progress'",
      "in_progress_at = NOW()"
    ];

    const values = [];

    if (cleanBarangay) {
      setClauses.push("assigned_barangay = ?");
      setClauses.push("assignment_method = 'accepted_by_barangay'");
      values.push(cleanBarangay);
    }

    values.push(complaintId);

    const sql = `
      UPDATE complaints
      SET ${setClauses.join(",\n          ")}
      WHERE id = ?
        AND status = 'forwarded'
    `;

    db.query(sql, values, (err, result) => {
      if (err) {
        console.error("Mark in progress error:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to update complaint status."
        });
      }

      if (result && result.affectedRows > 0 && cleanBarangay) {
        return markOtherBarangayNotificationsCleared(complaintId, cleanBarangay, () => {
          return res.json({
            success: true,
            message: "Complaint marked as in progress.",
            complaint_id: complaintId,
            viewed_by: viewed_by || null,
            assigned_barangay: cleanBarangay
          });
        });
      }

      return res.json({
        success: true,
        message: "Complaint marked as in progress.",
        complaint_id: complaintId,
        viewed_by: viewed_by || null,
        assigned_barangay: cleanBarangay || null
      });
    });
  };

  if (actingBarangay) {
    return continueMarkInProgress(actingBarangay);
  }

  return continueMarkInProgress("");
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

      return resolveBarangayFromLearnedComplaints({ lat, lng }, (learnedErr, learnedBarangay) => {
        if (learnedErr) {
          return res.status(500).json({
            success: false,
            message: "Failed to check learned barangay records.",
            assigned_barangay: "For Verification",
            concern_barangay: "For Verification",
            assignment_method: "learned_lookup_error",
            error: learnedErr.message
          });
        }

        if (learnedBarangay && learnedBarangay.barangay_name) {
          return res.json({
            success: true,
            assigned_barangay: learnedBarangay.barangay_name,
            concern_barangay: learnedBarangay.barangay_name,
            assignment_method: "learned_previous_complaint",
            message: "Barangay matched from a previous verified/selected complaint near this location.",
            learned_match: learnedBarangay,
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
          message: "No barangay boundary or learned nearby record covered this coordinate.",
          coordinates: {
            latitude: lat,
            longitude: lng
          }
        });
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
   DEBUG COMPLAINT NOTIFICATION TARGETS
   Use this to verify if both barangays received notification rows.
========================= */
router.get("/:id/notification-targets", (req, res) => {
  const complaintId = req.params.id;

  const sql = `
    SELECT
      cn.id,
      cn.complaint_id,
      cn.target_type,
      cn.target_name,
      cn.created_at,
      cn.cleared_at,
      c.status,
      c.assigned_barangay
    FROM complaint_notifications cn
    INNER JOIN complaints c ON c.id = cn.complaint_id
    WHERE cn.complaint_id = ?
    ORDER BY cn.id ASC
  `;

  db.query(sql, [complaintId], (err, rows) => {
    if (err) {
      console.error("Notification targets debug error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to load complaint notification targets.",
        error: err.message,
        code: err.code
      });
    }

    return res.json({
      success: true,
      complaint_id: complaintId,
      targets: rows || []
    });
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
