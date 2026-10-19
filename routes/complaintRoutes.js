const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

const db = require("../config/db");
const { ComplaintWorkflowService } = require("../services/complaintWorkflowService");
const { buildComplaintAuth } = require("../middleware/complaintAuth");
const { requireWebAuth, requireWebRole, requireCsrf } = require("../middleware/webSessionAuth");
const { resolveStrictBarangay } = require("../services/barangayBoundaryService");
const complaintWorkflow = new ComplaintWorkflowService(db);
const complaintAuth = buildComplaintAuth(complaintWorkflow);
const { resolveComplaintMapDestination } = require("../services/complaintMapDestinationService");
router.get("/:id/map-destination", ...complaintAuth.admin, async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    return res.json(await resolveComplaintMapDestination(db, req.params.id));
  } catch (error) {
    return res.status(error.statusCode || 503).json({ success: false,
      message: error.statusCode ? error.message : "Map destination unavailable. Needs Admin Confirmation." });
  }
});
router.get("/assignment-options", ...complaintAuth.admin, async (req, res) => {
  try {
    const rows = await complaintWorkflow.activeBarangays();
    return res.json({ success: true, barangays: [...new Set(rows.map((row) => row.barangay_name))] });
  } catch (_) { return res.status(503).json({ success: false, message: "Active barangay registry unavailable." }); }
});
const complaintAction = (operation) => async (req, res) => {
  try {
    const result = await operation(req);
    if (!result.idempotent) emitWmoRealtime(req, "wmo:complaint-updated", { complaint_id: result.complaint_id, status: result.status });
    if (!result.idempotent && result.status === "forwarded") {
      emitBarangayRealtime(req, result.assigned_barangay, "barangay:complaint-forwarded",
        { complaint_id: result.complaint_id, status: result.status });
    }
    if (!result.idempotent && result.status === "resolved") {
      db.query("SELECT id, citizen_id, reporter_barangay, subject, assigned_barangay, handled_by_barangay_name FROM complaints WHERE id = ?", [result.complaint_id], (error, rows) => {
        if (error || !rows?.length) return;
        if (result.handling_owner === "barangay") createComplaintResolvedCitizenNotifications(result.complaint_id, rows[0]);
        else createCitizenNotificationSafe({ user_id: rows[0].citizen_id, type: "complaint_resolved",
          title: "WMO complaint resolution recorded", message: "WMO recorded a resolution report for your complaint.",
          reference_id: `complaint:${result.complaint_id}:wmo-resolved` });
      });
    }
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 503).json({ success: false,
      code: error.code && error.statusCode ? error.code : "COMPLAINT_WORKFLOW_UNAVAILABLE",
      message: error.statusCode ? error.message : "Complaint action unavailable. No successful action is claimed." });
  }
};
async function requireComplaintSchema(req, res, next) {
  try { await complaintWorkflow.checkSchema(); next(); }
  catch (_) { return res.status(503).json({ success: false, code: "COMPLAINT_FEATURE_UNAVAILABLE",
    message: "Complaint workflow migration has not been verified. No action was saved." }); }
}
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
   REAL-TIME HELPERS
========================= */

function getRealtimeIo(req) {
  try {
    return req && req.app && typeof req.app.get === "function"
      ? req.app.get("io")
      : null;
  } catch (_) {
    return null;
  }
}

function getRealtimeBarangayRoom(value) {
  const key = normalizeBarangayKey(value);
  return key ? `barangay:${key}` : "";
}

function getRealtimeCitizenRoom(value) {
  const id = cleanText(value);
  return id ? `citizen:${id}` : "";
}

function emitRealtimeEvent(req, room, eventName, payload = {}) {
  const io = getRealtimeIo(req);

  if (!io || !room || !eventName) return;

  try {
    io.to(room).emit(eventName, {
      ...payload,
      emitted_at: new Date().toISOString()
    });
  } catch (error) {
    console.error("Realtime emit failed:", eventName, room, error);
  }
}

function emitWmoRealtime(req, eventName, payload = {}) {
  emitRealtimeEvent(req, "wmo", eventName, payload);
}

function emitBarangayRealtime(req, barangayName, eventName, payload = {}) {
  const room = getRealtimeBarangayRoom(barangayName);
  emitRealtimeEvent(req, room, eventName, payload);
}

function emitBarangayRealtimeMany(req, barangayNames = [], eventName, payload = {}) {
  const list = parseBarangayTargets(barangayNames);

  list.forEach((barangay) => {
    emitBarangayRealtime(req, barangay, eventName, {
      ...payload,
      barangay
    });
  });
}

function emitCitizenRealtime(req, citizenId, eventName, payload = {}) {
  const room = getRealtimeCitizenRoom(citizenId);
  emitRealtimeEvent(req, room, eventName, payload);
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
  /*
    Force one collation for barangay matching.

    Fixes MySQL error:
    ER_CANT_AGGREGATE_2COLLATIONS
    Illegal mix of collations (utf8mb4_0900_ai_ci) and (utf8mb4_general_ci)

    This happens when complaint_notifications, complaints, or
    barangay_response_messages columns use different collations.
  */
  return `LOWER(REPLACE(REPLACE(REPLACE(TRIM(${columnName}), ' ', ''), '-', ''), '.', '')) COLLATE utf8mb4_general_ci`;
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

function parseBarangayTargets(value) {
  return normalizeBarangayList(value);
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


/* =========================
   BARANGAY NOT-ACCEPTED EXPLANATION HELPERS
   Purpose:
   - When a barangay reaches 3 forwarded concerns accepted by other barangays,
     WMO automatically asks for an explanation.
   - Barangay can reply from the mobile dashboard.
   - WMO receives the reply through the existing complaint notification bell.
========================= */

function getCurrentMonthKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function ensureBarangayResponseMessagesTable(callback) {
  const sql = `
    CREATE TABLE IF NOT EXISTS barangay_response_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      barangay_name VARCHAR(255) NOT NULL,
      barangay_key VARCHAR(255) NOT NULL,
      source_complaint_id INT NULL,
      trigger_count INT NOT NULL DEFAULT 0,
      trigger_month CHAR(7) NOT NULL,
      request_type VARCHAR(80) NOT NULL DEFAULT 'not_accepted_forwarded',
      request_title VARCHAR(255) NOT NULL,
      request_message TEXT NOT NULL,
      response_message TEXT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      replied_at DATETIME NULL,
      INDEX idx_barangay_response_key_month (barangay_key, trigger_month),
      INDEX idx_barangay_response_type (request_type),
      INDEX idx_barangay_response_status (status),
      INDEX idx_barangay_response_source (source_complaint_id)
    )
  `;

  db.query(sql, (err) => {
    if (err) {
      console.error("Failed ensuring barangay_response_messages table:", err);
      return callback && callback(err);
    }

    db.query(`SHOW COLUMNS FROM barangay_response_messages`, (columnErr, columns) => {
      if (columnErr) {
        console.error("Failed checking barangay_response_messages columns:", columnErr);
        return callback && callback(columnErr);
      }

      const columnSet = new Set((columns || []).map((row) => String(row.Field || "").trim()));
      const alters = [];

      if (!columnSet.has("request_type")) {
        alters.push("ADD COLUMN request_type VARCHAR(80) NOT NULL DEFAULT 'not_accepted_forwarded'");
      }

      if (!alters.length) {
        return callback && callback(null);
      }

      db.query(
        `ALTER TABLE barangay_response_messages ${alters.join(", ")}`,
        (alterErr) => {
          if (alterErr && alterErr.code !== "ER_DUP_FIELDNAME") {
            console.error("Failed updating barangay_response_messages columns:", alterErr);
            return callback && callback(alterErr);
          }

          return callback && callback(null);
        }
      );
    });
  });
}

function getBarangayNotAcceptedSummary(barangayName, callback) {
  const barangayKey = getBarangayMatchParam(barangayName);

  /*
    Robust not-accepted summary.

    Why this uses two sources:
    1. accepted_by_other_barangay notification rows
       - best source when the info notification was successfully created
    2. forwarded notification history + complaint final assignee
       - fallback source when the info notification row is missing
       - this still counts a complaint if it was forwarded to this barangay,
         but another barangay became the assigned/accepted barangay
  */
  const sql = `
    SELECT
      COUNT(DISTINCT x.complaint_id) AS not_accepted_count,
      MAX(x.complaint_id) AS source_complaint_id
    FROM (
      SELECT
        cn.complaint_id,
        cn.created_at AS event_at
      FROM complaint_notifications cn
      WHERE cn.target_type = 'barangay'
        AND ${normalizeSqlBarangayExpression("cn.target_name")} = ?
        AND (
          LOWER(COALESCE(cn.notification_type, '')) = 'accepted_by_other_barangay'
          OR LOWER(COALESCE(cn.message, '')) LIKE '%no action is needed from your barangay%'
          OR LOWER(COALESCE(cn.message, '')) LIKE '%accepted the wmo-forwarded complaint%'
        )

      UNION

      SELECT
        c.id AS complaint_id,
        COALESCE(c.accepted_at, c.in_progress_at, c.resolved_at, c.created_at) AS event_at
      FROM complaint_notifications cn_forwarded
      INNER JOIN complaints c
        ON c.id = cn_forwarded.complaint_id
      WHERE cn_forwarded.target_type = 'barangay'
        AND ${normalizeSqlBarangayExpression("cn_forwarded.target_name")} = ?
        AND LOWER(TRIM(COALESCE(c.status, ''))) IN ('accepted_by_barangay', 'accepted_overdue', 'in_progress', 'resolved')
        AND c.assigned_barangay IS NOT NULL
        AND TRIM(c.assigned_barangay) <> ''
        AND ${normalizeSqlBarangayExpression("c.assigned_barangay")} <> ?
    ) x
    WHERE x.event_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
      AND x.event_at < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
  `;

  db.query(sql, [barangayKey, barangayKey, barangayKey], (err, rows) => {
    if (err) {
      console.error("Failed loading barangay not-accepted summary:", err);
      return callback(err, {
        not_accepted_count: 0,
        source_complaint_id: null
      });
    }

    const row = rows && rows.length ? rows[0] : {};

    return callback(null, {
      not_accepted_count: Number(row.not_accepted_count || 0),
      source_complaint_id: row.source_complaint_id || null
    });
  });
}

function normalizeBarangayExplanationRequestType(value) {
  const cleaned = cleanText(value).toLowerCase();

  if (
    cleaned.includes("accepted_overdue") ||
    cleaned.includes("overdue_resolution") ||
    cleaned.includes("resolution_overdue") ||
    cleaned.includes("accepted complaint overdue")
  ) {
    return "accepted_overdue_resolution";
  }

  return "not_accepted_forwarded";
}

function findBarangayExplanationRequest(barangayName, triggerMonth, callback, requestType = "not_accepted_forwarded") {
  const barangayKey = getBarangayMatchParam(barangayName);
  const normalizedRequestType = normalizeBarangayExplanationRequestType(requestType);

  const sql = `
    SELECT *
    FROM barangay_response_messages
    WHERE barangay_key = ?
      AND trigger_month = ?
      AND COALESCE(request_type, 'not_accepted_forwarded') = ?
    ORDER BY id DESC
    LIMIT 1
  `;

  db.query(sql, [barangayKey, triggerMonth, normalizedRequestType], (err, rows) => {
    if (err) {
      console.error("Failed finding barangay explanation request:", err);
      return callback(err, null);
    }

    return callback(null, rows && rows.length ? rows[0] : null);
  });
}

function createBarangayExplanationRequestNotification(req, requestRow, callback) {
  if (!requestRow || !requestRow.source_complaint_id) {
    return callback && callback(null);
  }

  ensureComplaintNotificationClearColumns((ensureErr) => {
    if (ensureErr) {
      return callback && callback(ensureErr);
    }

    const duplicateSql = `
      SELECT id
      FROM complaint_notifications
      WHERE complaint_id = ?
        AND target_type = 'barangay'
        AND ${normalizeSqlBarangayExpression("target_name")} = ?
        AND LOWER(COALESCE(notification_type, '')) = 'not_accepted_explanation_request'
        AND created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
        AND created_at < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
      LIMIT 1
    `;

    db.query(
      duplicateSql,
      [requestRow.source_complaint_id, getBarangayMatchParam(requestRow.barangay_name)],
      (dupErr, dupRows) => {
        if (dupErr) {
          console.error("Failed checking duplicate explanation notification:", dupErr);
          return callback && callback(dupErr);
        }

        if (dupRows && dupRows.length) {
          return callback && callback(null);
        }

        const insertSql = `
          INSERT INTO complaint_notifications (
            complaint_id,
            target_type,
            target_name,
            notification_type,
            title,
            message,
            is_read
          )
          VALUES (?, 'barangay', ?, 'not_accepted_explanation_request', ?, ?, 0)
        `;

        db.query(
          insertSql,
          [
            requestRow.source_complaint_id,
            requestRow.barangay_name,
            requestRow.request_title,
            requestRow.request_message
          ],
          (insertErr) => {
            if (insertErr) {
              console.error("Failed creating barangay explanation notification:", insertErr);
              return callback && callback(insertErr);
            }

            emitBarangayRealtime(req, requestRow.barangay_name, "barangay:not-accepted-explanation-request", {
              complaint_id: requestRow.source_complaint_id,
              title: requestRow.request_title,
              message: requestRow.request_message,
              notification_type: "not_accepted_explanation_request",
              status: "pending_explanation"
            });

            return callback && callback(null);
          }
        );
      }
    );
  });
}

function maybeCreateBarangayNotAcceptedExplanationRequest(req, barangayName, callback) {
  const barangay = normalizeBarangayName(barangayName);

  if (!barangay) {
    return callback && callback(null, {
      created: false,
      count: 0,
      request: null
    });
  }

  const triggerMonth = getCurrentMonthKey();

  ensureBarangayResponseMessagesTable((tableErr) => {
    if (tableErr) {
      return callback && callback(tableErr, null);
    }

    getBarangayNotAcceptedSummary(barangay, (summaryErr, summary) => {
      if (summaryErr) {
        return callback && callback(summaryErr, null);
      }

      const count = Number(summary.not_accepted_count || 0);
      const sourceComplaintId = summary.source_complaint_id || null;

      if (count < 3 || !sourceComplaintId) {
        return callback && callback(null, {
          created: false,
          count,
          request: null
        });
      }

      findBarangayExplanationRequest(barangay, triggerMonth, (findErr, existingRequest) => {
        if (findErr) {
          return callback && callback(findErr, null);
        }

        if (existingRequest) {
          createBarangayExplanationRequestNotification(req, existingRequest, () => {
            return callback && callback(null, {
              created: false,
              count,
              request: existingRequest
            });
          });
          return;
        }

        const title = "WMO explanation request";
        const message = `${barangay} has ${count} forwarded concern${count === 1 ? "" : "s"} this month that were accepted by another barangay. Please send a short reason so WMO can review the forwarding process.`;

        const insertSql = `
          INSERT INTO barangay_response_messages (
            barangay_name,
            barangay_key,
            source_complaint_id,
            trigger_count,
            trigger_month,
            request_type,
            request_title,
            request_message,
            status
          )
          VALUES (?, ?, ?, ?, ?, 'not_accepted_forwarded', ?, ?, 'pending')
        `;

        db.query(
          insertSql,
          [
            barangay,
            getBarangayMatchParam(barangay),
            sourceComplaintId,
            count,
            triggerMonth,
            title,
            message
          ],
          (insertErr, insertResult) => {
            if (insertErr) {
              console.error("Failed inserting barangay explanation request:", insertErr);
              return callback && callback(insertErr, null);
            }

            const requestRow = {
              id: insertResult.insertId,
              barangay_name: barangay,
              barangay_key: getBarangayMatchParam(barangay),
              source_complaint_id: sourceComplaintId,
              trigger_count: count,
              trigger_month: triggerMonth,
              request_type: "not_accepted_forwarded",
              request_title: title,
              request_message: message,
              status: "pending"
            };

            createBarangayExplanationRequestNotification(req, requestRow, (notifErr) => {
              if (notifErr) {
                return callback && callback(notifErr, null);
              }

              return callback && callback(null, {
                created: true,
                count,
                request: requestRow
              });
            });
          }
        );
      });
    });
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

    const lat = Number(latitude);
    const lng = Number(longitude);

    if (latitude === null || longitude === null || String(latitude ?? "").trim() === "" || String(longitude ?? "").trim() === ""
      || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
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

                    emitWmoRealtime(req, "wmo:complaint-received", {
                      complaint_id: complaintId,
                      title: notificationTitle,
                      message: notificationMessage,
                      subject: cleanText(subject),
                      citizen_name: cleanText(citizen_name),
                      reporter_barangay: reporter_barangay || null,
                      assigned_barangay: finalBarangay,
                      status
                    });

                    createComplaintSubmittedCitizenNotification(complaintId, {
                      citizen_id,
                      reporter_barangay,
                      barangay: reporter_barangay,
                      subject
                    });

                    emitCitizenRealtime(req, citizen_id, "citizen:complaint-submitted", {
                      complaint_id: complaintId,
                      title: "Complaint submitted to WMO",
                      message: cleanText(subject)
                        ? `Your complaint "${truncateNotificationText(subject, 80)}" was submitted to WMO for review.`
                        : "Your complaint was submitted to WMO for review.",
                      status,
                      reporter_barangay: reporter_barangay || null
                    });

                    return res.json({
                    success: true,
                    duplicate: false,
                    message: "Complaint submitted successfully. Admin must confirm the responsible barangay before forwarding.",
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

        // Citizen declarations and nearby complaints are not geographic proof.
        db.query("SELECT barangay_name, polygon_json FROM barangay_boundaries WHERE status = 'active'", (boundaryErr, rows) => {
          const candidate = boundaryErr ? null : resolveStrictBarangay({ lat, lng }, rows || []).barangay;
          return finishComplaintCreation(candidate || "For Verification",
            candidate ? "polygon_candidate" : "manual_review", { source: "admin_confirmation_required" });
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
router.get("/", ...complaintAuth.admin, (req, res) => {
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
router.post("/:id/validate-forward", ...complaintAuth.admin,
  complaintAction((req) => complaintWorkflow.forward(req.params.id, req.complaintActor, req.body)));
router.put("/:id/cannot-accept", ...complaintAuth.barangay,
  complaintAction((req) => complaintWorkflow.decide(req.params.id, req.complaintActor, "cannot_accept", req.body)));
router.put("/:id/wmo-resolve", ...complaintAuth.admin, upload.single("evidence"),
  complaintAction((req) => complaintWorkflow.resolve(req.params.id, req.complaintActor, req.body,
    () => saveUploadedComplaintImage(req.file, "resolutions"))));

/* =========================
   REJECT COMPLAINT BY WMO
========================= */
router.patch("/:id/reject", ...complaintAuth.admin, (req, res) => {
  const complaintId = req.params.id;
  const { rejection_reason, rejected_by } = req.body || {};

  const reason = cleanText(rejection_reason);
  const rejectedBy = req.user.id;

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
router.put("/:id/accept", ...complaintAuth.barangay,
  complaintAction((req) => complaintWorkflow.decide(req.params.id, req.complaintActor, "accept", req.body)));

/* =========================
   RESOLVE BY BARANGAY
========================= */
router.put("/:id/resolve", ...complaintAuth.barangay, upload.single("evidence"),
  complaintAction((req) => complaintWorkflow.resolve(req.params.id, req.complaintActor, req.body,
    () => saveUploadedComplaintImage(req.file, "resolutions"))));

/* =========================
   COMPLAINT HISTORY (WMO)
========================= */
router.get("/history/resolved", ...complaintAuth.admin, (req, res) => {
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
    WHERE c.status IN ('resolved', 'rejected', 'forwarded', 'accepted_by_barangay', 'accepted_overdue', 'in_progress', 'wmo_handling')
    ORDER BY
      CASE
        WHEN c.status = 'rejected' THEN COALESCE(c.rejected_at, c.created_at)
        WHEN c.status IN ('forwarded', 'accepted_by_barangay', 'accepted_overdue', 'in_progress') THEN COALESCE(c.accepted_overdue_at, c.validated_at, c.accepted_at, c.in_progress_at, c.created_at)
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
    const barangay = normalizeBarangayName(
      decodeURIComponent(String(req.params.barangay || "").trim())
    );

    if (!barangay) {
      return res.status(400).json({
        success: false,
        message: "Barangay is required."
      });
    }

    const barangayKey = getBarangayMatchParam(barangay);

    /*
      Permanent barangay complaint analytics.

      resolved_this_month:
      - complaints finally assigned to this barangay
      - resolved during the current month

      not_accepted_forwarded_this_month:
      - complaints forwarded to this barangay
      - another barangay accepted first
      - counted from two durable sources:
        1) accepted_by_other_barangay notification rows
        2) fallback from complaint_notifications + complaints.assigned_barangay mismatch
      - this fixes the dashboard showing 0 when WMO history shows the forwarded
        complaint was accepted by another barangay but the info notification row
        was missing/cleared/not generated.
    */
    const sql = `
      SELECT
        (
          SELECT COUNT(*)
          FROM complaints c
          WHERE ${normalizeSqlBarangayExpression("c.assigned_barangay")} = ?
            AND LOWER(TRIM(c.status)) = 'resolved'
            AND c.resolved_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
            AND c.resolved_at < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
        ) AS resolved_this_month,

        (
          SELECT COUNT(DISTINCT x.complaint_id)
          FROM (
            SELECT
              cn.complaint_id,
              cn.created_at AS event_at
            FROM complaint_notifications cn
            WHERE cn.target_type = 'barangay'
              AND ${normalizeSqlBarangayExpression("cn.target_name")} = ?
              AND (
                LOWER(COALESCE(cn.notification_type, '')) = 'accepted_by_other_barangay'
                OR LOWER(COALESCE(cn.message, '')) LIKE '%no action is needed from your barangay%'
                OR LOWER(COALESCE(cn.message, '')) LIKE '%accepted the wmo-forwarded complaint%'
              )

            UNION

            SELECT
              c.id AS complaint_id,
              COALESCE(c.accepted_at, c.in_progress_at, c.resolved_at, c.created_at) AS event_at
            FROM complaint_notifications cn_forwarded
            INNER JOIN complaints c
              ON c.id = cn_forwarded.complaint_id
            WHERE cn_forwarded.target_type = 'barangay'
              AND ${normalizeSqlBarangayExpression("cn_forwarded.target_name")} = ?
              AND LOWER(TRIM(COALESCE(c.status, ''))) IN ('accepted_by_barangay', 'accepted_overdue', 'in_progress', 'resolved')
              AND c.assigned_barangay IS NOT NULL
              AND TRIM(c.assigned_barangay) <> ''
              AND ${normalizeSqlBarangayExpression("c.assigned_barangay")} <> ?
          ) x
          WHERE x.event_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
            AND x.event_at < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
        ) AS not_accepted_forwarded_this_month,

        (
          SELECT COUNT(DISTINCT x_all.complaint_id)
          FROM (
            SELECT
              cn_all.complaint_id
            FROM complaint_notifications cn_all
            WHERE cn_all.target_type = 'barangay'
              AND ${normalizeSqlBarangayExpression("cn_all.target_name")} = ?
              AND (
                LOWER(COALESCE(cn_all.notification_type, '')) = 'accepted_by_other_barangay'
                OR LOWER(COALESCE(cn_all.message, '')) LIKE '%no action is needed from your barangay%'
                OR LOWER(COALESCE(cn_all.message, '')) LIKE '%accepted the wmo-forwarded complaint%'
              )

            UNION

            SELECT
              c_all.id AS complaint_id
            FROM complaint_notifications cn_forwarded_all
            INNER JOIN complaints c_all
              ON c_all.id = cn_forwarded_all.complaint_id
            WHERE cn_forwarded_all.target_type = 'barangay'
              AND ${normalizeSqlBarangayExpression("cn_forwarded_all.target_name")} = ?
              AND LOWER(TRIM(COALESCE(c_all.status, ''))) IN ('accepted_by_barangay', 'in_progress', 'resolved')
              AND c_all.assigned_barangay IS NOT NULL
              AND TRIM(c_all.assigned_barangay) <> ''
              AND ${normalizeSqlBarangayExpression("c_all.assigned_barangay")} <> ?
          ) x_all
        ) AS not_accepted_forwarded_total
    `;

    db.query(
      sql,
      [
        barangayKey,
        barangayKey,
        barangayKey,
        barangayKey,
        barangayKey,
        barangayKey,
        barangayKey
      ],
      (err, rows) => {
        if (err) {
          console.error("Barangay complaint analytics error:", err);
          return res.status(500).json({
            success: false,
            message: "Failed to load barangay complaint analytics.",
            error: err.message,
            code: err.code
          });
        }

        const summary = rows && rows.length ? rows[0] : {};

        const resolvedThisMonth = Number(summary.resolved_this_month || 0);
        const notAcceptedForwardedThisMonth = Number(summary.not_accepted_forwarded_this_month || 0);
        const notAcceptedForwardedTotal = Number(summary.not_accepted_forwarded_total || 0);

        return res.json({
          success: true,
          barangay,
          summary: {
            resolved_this_month: resolvedThisMonth,
            resolved_issues: resolvedThisMonth,
            resolved_count: resolvedThisMonth,
            total_issues: resolvedThisMonth,

            not_accepted_forwarded_this_month: notAcceptedForwardedThisMonth,
            not_accepted_forwarded: notAcceptedForwardedThisMonth,
            not_accepted_forwarded_count: notAcceptedForwardedThisMonth,
            missed_forwarded_count: notAcceptedForwardedThisMonth,

            not_accepted_forwarded_total: notAcceptedForwardedTotal
          }
        });
      }
    );
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
router.get("/barangay/:barangayName", ...complaintAuth.barangay, complaintAuth.ownBarangay, requireComplaintSchema, (req, res) => {
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
      AND LOWER(REPLACE(REPLACE(REPLACE(TRIM(cn.target_name), ' ', ''), '-', ''), '.', '')) COLLATE utf8mb4_general_ci = ? COLLATE utf8mb4_general_ci
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
        c.status IN ('in_progress', 'accepted_by_barangay', 'accepted_overdue')
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

    const normalizedRows = (rows || []).filter((row) => row.assignment_confirmed_at
      && normalizeBarangayKey(row.assigned_barangay) === normalizeBarangayKey(barangayName)
      && row.handling_owner === "barangay").map((row) => {
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
router.get("/notifications/wmo", ...complaintAuth.admin, (req, res) => {
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
router.get("/notifications/barangay/:barangayName", ...complaintAuth.barangay, complaintAuth.ownBarangay, (req, res) => {
  const barangayName = decodeURIComponent(req.params.barangayName || "").trim();

  maybeCreateBarangayNotAcceptedExplanationRequest(req, barangayName, (explainErr) => {
    if (explainErr) {
      console.error("Failed preparing not-accepted explanation request:", explainErr);
      // Do not block normal notification loading. The dashboard should still work.
    }

    ensureBarangayResponseMessagesTable((responseTableErr) => {
      if (responseTableErr) {
        console.error("Failed preparing barangay response message storage:", responseTableErr);
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
      SELECT
        cn.*,
        c.subject,
        c.assigned_barangay,
        c.status,
        c.image_url,
        c.latitude,
        c.longitude,
        c.created_at AS complaint_created_at,
        brm.id AS explanation_request_id,
        brm.request_type AS explanation_request_type,
        brm.request_message AS explanation_request_message,
        brm.response_message,
        brm.status AS explanation_status,
        brm.replied_at
      FROM complaint_notifications cn
      INNER JOIN complaints c ON c.id = cn.complaint_id
      LEFT JOIN barangay_response_messages brm
        ON brm.source_complaint_id = cn.complaint_id
       AND brm.barangay_key COLLATE utf8mb4_general_ci = ${normalizeSqlBarangayExpression("cn.target_name")}
       AND brm.trigger_month = DATE_FORMAT(COALESCE(cn.created_at, NOW()), '%Y-%m')
      WHERE cn.target_type = 'barangay'
        AND LOWER(REPLACE(REPLACE(REPLACE(TRIM(cn.target_name), ' ', ''), '-', ''), '.', '')) COLLATE utf8mb4_general_ci = ? COLLATE utf8mb4_general_ci
        AND cn.cleared_at IS NULL
        AND c.status IN ('forwarded', 'in_progress', 'accepted_by_barangay', 'accepted_overdue', 'resolved')
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
  });
});


/* =========================
   CLEAR SINGLE BARANGAY NOTIFICATION
   User must select one notification first.
   This only clears one notification row.
========================= */
router.post("/notifications/barangay/:barangayName/:notificationId/clear", ...complaintAuth.barangay, complaintAuth.ownBarangay, (req, res) => {
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
        AND LOWER(REPLACE(REPLACE(REPLACE(TRIM(cn.target_name), ' ', ''), '-', ''), '.', '')) COLLATE utf8mb4_general_ci = ? COLLATE utf8mb4_general_ci
        AND cn.cleared_at IS NULL
        AND c.status IN ('forwarded', 'in_progress', 'accepted_by_barangay', 'accepted_overdue', 'resolved')
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

router.patch("/notifications/barangay/:barangayName/:notificationId/clear", ...complaintAuth.barangay, complaintAuth.ownBarangay, (req, res, next) => {
  req.method = "POST";
  router.handle(req, res, next);
});

/* =========================
   CLEAR BARANGAY NOTIFICATIONS
   This only clears the notification badge/dropdown.
   It does NOT delete complaints and does NOT remove actual forwarded concerns.
========================= */
router.post("/notifications/barangay/:barangayName/clear", ...complaintAuth.barangay, complaintAuth.ownBarangay, (req, res) => {
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
        AND LOWER(REPLACE(REPLACE(REPLACE(TRIM(cn.target_name), ' ', ''), '-', ''), '.', '')) COLLATE utf8mb4_general_ci = ? COLLATE utf8mb4_general_ci
        AND cn.cleared_at IS NULL
        AND c.status IN ('forwarded', 'in_progress', 'accepted_by_barangay', 'accepted_overdue', 'resolved')
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

router.patch("/notifications/barangay/:barangayName/clear", ...complaintAuth.barangay, complaintAuth.ownBarangay, (req, res, next) => {
  req.method = "POST";
  router.handle(req, res, next);
});


/* =========================
   BARANGAY EXPLANATION REPLY
   Barangay replies to either:
   - not-accepted forwarded concern explanation request
   - accepted complaint overdue resolution explanation request
========================= */
router.post("/notifications/barangay/:barangayName/not-accepted-explanation/reply", ...complaintAuth.barangay, complaintAuth.ownBarangay, (req, res) => {
  const barangay = normalizeBarangayName(
    decodeURIComponent(String(req.params.barangayName || "").trim())
  );

  const responseMessage = cleanText(
    req.body && (
      req.body.response_message ||
      req.body.reply ||
      req.body.message ||
      req.body.reason
    )
  );

  const requestType = normalizeBarangayExplanationRequestType(
    req.body && (
      req.body.request_type ||
      req.body.notification_type ||
      req.body.type ||
      req.body.title ||
      ""
    )
  );

  if (!barangay) {
    return res.status(400).json({
      success: false,
      message: "Barangay name is required."
    });
  }

  if (!responseMessage || responseMessage.length < 10) {
    return res.status(400).json({
      success: false,
      message: "Please provide a clear explanation with at least 10 characters."
    });
  }

  const triggerMonth = getCurrentMonthKey();

  const continueReply = () => {
    ensureBarangayResponseMessagesTable((tableErr) => {
      if (tableErr) {
        return res.status(500).json({
          success: false,
          message: "Failed to prepare barangay response storage.",
          error: tableErr.message,
          code: tableErr.code
        });
      }

      findBarangayExplanationRequest(barangay, triggerMonth, (findErr, requestRow) => {
        if (findErr) {
          return res.status(500).json({
            success: false,
            message: "Failed to find the WMO explanation request.",
            error: findErr.message,
            code: findErr.code
          });
        }

        if (!requestRow) {
          return res.status(404).json({
            success: false,
            message: "No active WMO explanation request was found for this barangay."
          });
        }

        const updateSql = `
          UPDATE barangay_response_messages
          SET response_message = ?,
              status = 'replied',
              replied_at = NOW()
          WHERE id = ?
        `;

        db.query(updateSql, [responseMessage, requestRow.id], (updateErr) => {
          if (updateErr) {
            console.error("Failed saving barangay explanation reply:", updateErr);
            return res.status(500).json({
              success: false,
              message: "Failed to save barangay explanation reply.",
              error: updateErr.message,
              code: updateErr.code
            });
          }

          const sourceComplaintId = requestRow.source_complaint_id;
          const isAcceptedOverdue = requestType === "accepted_overdue_resolution";
          const title = isAcceptedOverdue
            ? "Overdue complaint explanation received"
            : "Barangay explanation received";
          const message = isAcceptedOverdue
            ? `${barangay} replied to WMO's accepted complaint overdue request: ${truncateNotificationText(responseMessage, 140)}`
            : `${barangay} replied to WMO's not-accepted forwarded concerns request: ${truncateNotificationText(responseMessage, 140)}`;
          const replyNotificationType = isAcceptedOverdue
            ? "barangay_accepted_overdue_explanation_reply"
            : "barangay_not_accepted_explanation_reply";

          insertWmoComplaintNotification(
            sourceComplaintId,
            replyNotificationType,
            title,
            message,
            (notifErr) => {
              if (notifErr) {
                console.error("Failed creating WMO explanation reply notification:", notifErr);
                return res.status(500).json({
                  success: false,
                  message: "Reply saved, but WMO notification could not be created.",
                  error: notifErr.message,
                  code: notifErr.code
                });
              }

              emitWmoRealtime(req, "wmo:barangay-explanation-received", {
                complaint_id: sourceComplaintId,
                title,
                message,
                barangay,
                notification_type: replyNotificationType,
                request_type: requestType
              });

              emitBarangayRealtime(req, barangay, "barangay:not-accepted-explanation-replied", {
                complaint_id: sourceComplaintId,
                title: "Explanation sent",
                message: "Your explanation was sent to WMO.",
                notification_type: isAcceptedOverdue
                  ? "accepted_overdue_explanation_replied"
                  : "not_accepted_explanation_replied",
                request_type: requestType
              });

              return res.json({
                success: true,
                message: "Your explanation was sent to WMO.",
                barangay,
                request_id: requestRow.id,
                source_complaint_id: sourceComplaintId,
                response_message: responseMessage,
                explanation_status: "replied",
                request_type: requestType,
                replied_at: new Date().toISOString()
              });
            }
          );
        });
      }, requestType);
    });
  };

  if (requestType === "not_accepted_forwarded") {
    maybeCreateBarangayNotAcceptedExplanationRequest(req, barangay, (ensureErr) => {
      if (ensureErr) {
        return res.status(500).json({
          success: false,
          message: "Failed to prepare the WMO explanation request.",
          error: ensureErr.message,
          code: ensureErr.code
        });
      }

      continueReply();
    });
    return;
  }

  continueReply();
});

router.patch("/notifications/barangay/:barangayName/not-accepted-explanation/reply", ...complaintAuth.barangay, complaintAuth.ownBarangay, (req, res, next) => {
  req.method = "POST";
  router.handle(req, res, next);
});


/* =========================
   MARK AS IN PROGRESS
========================= */
router.put("/:id/in-progress", ...complaintAuth.barangay, (req, res) => {
  return res.status(409).json({ success: false, code: "EXPLICIT_ACCEPT_REQUIRED",
    message: "Opening a complaint does not accept it. Use the explicit Accept action." });
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
   ACCEPTED COMPLAINT 24-HOUR OVERDUE CHECK
   Purpose:
   - If a barangay accepts a WMO-forwarded complaint but does not submit a
     resolution report within 24 hours, keep the complaint valid and mark it
     as accepted_overdue instead of rejected.
   - WMO gets an in-system notification.
   - The accepting barangay gets an explanation request notification.
   - The barangay can still resolve the complaint after it becomes overdue.
========================= */

function dbQueryAsync(sql, values = []) {
  return new Promise((resolve, reject) => {
    const query = db.isReadOnlyQuery(sql)
      ? db.queryReadOnly
      : db.query.bind(db);

    query(sql, values, (err, rows) => {
      if (err) return reject(err);
      return resolve(rows);
    });
  });
}

function insertWmoComplaintNotificationAsync(complaintId, notificationType, title, message) {
  return new Promise((resolve) => {
    insertWmoComplaintNotification(
      complaintId,
      notificationType,
      title,
      message,
      (err) => {
        if (err) {
          console.error("Overdue accepted WMO notification error:", err);
        }

        resolve(!err);
      }
    );
  });
}

function insertBarangayInfoNotificationsAsync(complaintId, targetBarangays, notificationType, title, message) {
  return new Promise((resolve) => {
    insertBarangayInfoNotifications(
      complaintId,
      targetBarangays,
      notificationType,
      title,
      message,
      (err) => {
        if (err) {
          console.error("Overdue accepted barangay notification error:", err);
        }

        resolve(!err);
      }
    );
  });
}

async function ensureAcceptedComplaintDeadlineColumns() {
  const rows = await dbQueryAsync(`SHOW COLUMNS FROM complaints`);
  const columnSet = new Set((rows || []).map((row) => String(row.Field || "").trim()));
  const alterSql = [];

  if (!columnSet.has("accepted_overdue_at")) {
    alterSql.push(`ADD COLUMN accepted_overdue_at DATETIME NULL`);
  }

  if (!columnSet.has("accepted_overdue_reason")) {
    alterSql.push(`ADD COLUMN accepted_overdue_reason TEXT NULL`);
  }

  /*
    Keep these legacy columns safe because older database versions may already
    have them from the previous auto-reject implementation. We no longer use
    them to mark valid complaints as rejected.
  */
  if (!columnSet.has("rejection_reason")) {
    alterSql.push(`ADD COLUMN rejection_reason TEXT NULL`);
  }

  if (!columnSet.has("rejected_at")) {
    alterSql.push(`ADD COLUMN rejected_at DATETIME NULL`);
  }

  if (!columnSet.has("auto_rejected_at")) {
    alterSql.push(`ADD COLUMN auto_rejected_at DATETIME NULL`);
  }

  if (!alterSql.length) {
    return;
  }

  try {
    await dbQueryAsync(`
      ALTER TABLE complaints
      ${alterSql.join(",\n      ")}
    `);
  } catch (error) {
    if (error && error.code === "ER_DUP_FIELDNAME") {
      console.warn("Accepted complaint deadline columns already exist.");
      return;
    }

    throw error;
  }
}

async function cleanupAcceptedComplaintZeroDateValues() {
  try {
    const rows = await dbQueryAsync(`SHOW COLUMNS FROM complaints`);
    const columnSet = new Set((rows || []).map((row) => String(row.Field || "").trim()));

    const dateColumns = [
      "accepted_at",
      "accepted_overdue_at",
      "auto_rejected_at",
      "rejected_at",
      "resolved_at",
      "validated_at",
      "forwarded_at",
      "in_progress_at"
    ].filter((columnName) => columnSet.has(columnName));

    for (const columnName of dateColumns) {
      await dbQueryAsync(
        `
        UPDATE complaints
        SET ${columnName} = NULL
        WHERE ${columnName} IS NOT NULL
          AND CAST(${columnName} AS CHAR) IN ('0000-00-00 00:00:00', '0000-00-00')
        `
      );
    }
  } catch (error) {
    if (db.isTransientError(error)) {
      console.warn(
        "cleanupAcceptedComplaintZeroDateValues temporarily failed; a later scheduler cycle will retry:",
        error.code || "UNKNOWN_DB_ERROR",
        error.message
      );
      throw error;
    }

    console.warn(
      "cleanupAcceptedComplaintZeroDateValues warning; continuing with guarded overdue queries:",
      error.code || "UNKNOWN_DB_ERROR",
      error.message
    );
  }
}

let acceptedComplaintPreparationComplete = false;
let acceptedComplaintPreparationPromise = null;

async function prepareAcceptedComplaintDeadlineData() {
  if (acceptedComplaintPreparationComplete) {
    return;
  }

  if (!acceptedComplaintPreparationPromise) {
    acceptedComplaintPreparationPromise = (async () => {
      await ensureAcceptedComplaintDeadlineColumns();
      await cleanupAcceptedComplaintZeroDateValues();
      acceptedComplaintPreparationComplete = true;
    })();
  }

  try {
    await acceptedComplaintPreparationPromise;
  } finally {
    acceptedComplaintPreparationPromise = null;
  }
}

function createAcceptedOverdueExplanationRequestAsync(complaintId, barangay, title, message) {
  return new Promise((resolve) => {
    ensureBarangayResponseMessagesTable((tableErr) => {
      if (tableErr) {
        console.error("Failed preparing accepted-overdue explanation request table:", tableErr);
        return resolve(false);
      }

      const triggerMonth = getCurrentMonthKey();
      const requestType = "accepted_overdue_resolution";
      const barangayKey = getBarangayMatchParam(barangay);

      const duplicateSql = `
        SELECT id
        FROM barangay_response_messages
        WHERE barangay_key = ?
          AND source_complaint_id = ?
          AND COALESCE(request_type, '') = ?
        LIMIT 1
      `;

      db.query(duplicateSql, [barangayKey, complaintId, requestType], (dupErr, dupRows) => {
        if (dupErr) {
          console.error("Failed checking accepted-overdue explanation duplicate:", dupErr);
          return resolve(false);
        }

        if (dupRows && dupRows.length) {
          return resolve(true);
        }

        const insertSql = `
          INSERT INTO barangay_response_messages (
            barangay_name,
            barangay_key,
            source_complaint_id,
            trigger_count,
            trigger_month,
            request_type,
            request_title,
            request_message,
            status
          )
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'pending')
        `;

        db.query(
          insertSql,
          [
            barangay,
            barangayKey,
            complaintId,
            triggerMonth,
            requestType,
            title,
            message
          ],
          (insertErr) => {
            if (insertErr) {
              console.error("Failed inserting accepted-overdue explanation request:", insertErr);
              return resolve(false);
            }

            return resolve(true);
          }
        );
      });
    });
  });
}

function getOverdueAcceptedStatusCondition(columns) {
  const names = new Set((columns || []).map((column) => column.Field));
  if (names.has("assignment_confirmed_at") && names.has("handling_owner")) {
    // Phase 1 resolution requires confirmed Barangay work to stay in_progress.
    // COALESCE keeps unconfirmed/legacy NULL ownership eligible as before.
    return `status IN ('accepted_by_barangay', 'in_progress')
      AND NOT (status = 'in_progress' AND assignment_confirmed_at IS NOT NULL
        AND COALESCE(handling_owner, '') = 'barangay')`;
  }
  // Without both columns, the schema-gated Phase 1 flow cannot accept work.
  return "status IN ('accepted_by_barangay', 'in_progress')";
}

async function processOverdueAcceptedComplaint(app, complaint, statusCondition) {
  const complaintId = complaint.id;
  const barangay = normalizeBarangayName(
    complaint.assigned_barangay || complaint.handled_by_barangay_name || ""
  );

  if (!complaintId || !barangay) {
    return {
      complaint_id: complaintId || null,
      updated: false,
      reason: "Missing complaint ID or assigned barangay."
    };
  }

  const reason =
    `${barangay} accepted this WMO-forwarded complaint but did not submit a resolution report within 24 hours.`;

  const updateResult = await dbQueryAsync(
    `
    UPDATE complaints
    SET status = 'accepted_overdue',
        accepted_overdue_reason = ?,
        accepted_overdue_at = NOW()
    WHERE id = ?
      AND ${statusCondition}
      AND assigned_barangay <=> ?
      AND handled_by_barangay_name <=> ?
      AND accepted_at IS NOT NULL
      AND NULLIF(CAST(accepted_at AS CHAR), '0000-00-00 00:00:00') IS NOT NULL
      AND STR_TO_DATE(
        NULLIF(CAST(accepted_at AS CHAR), '0000-00-00 00:00:00'),
        '%Y-%m-%d %H:%i:%s'
      ) <= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      AND (
        accepted_overdue_at IS NULL
        OR NULLIF(CAST(accepted_overdue_at AS CHAR), '0000-00-00 00:00:00') IS NULL
      )
    `,
    [
      reason,
      complaintId,
      complaint.assigned_barangay ?? null,
      complaint.handled_by_barangay_name ?? null
    ]
  );

  if (!updateResult || updateResult.affectedRows === 0) {
    return {
      complaint_id: complaintId,
      updated: false,
      reason: "Already processed or no longer overdue."
    };
  }

  const subject = truncateNotificationText(complaint.subject || "Accepted complaint", 90);
  const wmoTitle = "Accepted Complaint Overdue";
  const wmoMessage =
    `${barangay} accepted the WMO-forwarded complaint${subject ? `: ${subject}` : ""} but did not submit a resolution within 24 hours. WMO should review the delay and wait for the barangay explanation.`;

  const barangayTitle = "Resolution Explanation Required";
  const barangayMessage =
    `Your barangay accepted this WMO-forwarded complaint${subject ? `: ${subject}` : ""}, but no resolution report was submitted within 24 hours. Please send a short explanation to WMO and resolve the concern as soon as possible.`;

  await createAcceptedOverdueExplanationRequestAsync(
    complaintId,
    barangay,
    barangayTitle,
    barangayMessage
  );

  await insertWmoComplaintNotificationAsync(
    complaintId,
    "accepted_complaint_overdue",
    wmoTitle,
    wmoMessage
  );

  await insertBarangayInfoNotificationsAsync(
    complaintId,
    [barangay],
    "accepted_overdue_explanation_request",
    barangayTitle,
    barangayMessage
  );

  const fakeReq = app ? { app } : null;

  if (fakeReq) {
    emitWmoRealtime(fakeReq, "wmo:complaint-accepted-overdue", {
      complaint_id: complaintId,
      title: wmoTitle,
      message: wmoMessage,
      assigned_barangay: barangay,
      status: "accepted_overdue",
      notification_type: "accepted_complaint_overdue"
    });

    emitBarangayRealtime(fakeReq, barangay, "barangay:accepted-overdue-explanation-request", {
      complaint_id: complaintId,
      title: barangayTitle,
      message: barangayMessage,
      assigned_barangay: barangay,
      status: "accepted_overdue",
      notification_type: "accepted_overdue_explanation_request"
    });
  }

  return {
    complaint_id: complaintId,
    updated: true,
    assigned_barangay: barangay,
    status: "accepted_overdue",
    notification_only: false
  };
}

async function markOverdueAcceptedComplaints(app = null) {
  await prepareAcceptedComplaintDeadlineData();

  const statusCondition = getOverdueAcceptedStatusCondition(
    await dbQueryAsync("SHOW COLUMNS FROM complaints")
  );

  const rows = await dbQueryAsync(
    `
    SELECT
      id,
      subject,
      description,
      citizen_name,
      reporter_barangay,
      assigned_barangay,
      handled_by_barangay_name,
      accepted_at,
      status
    FROM complaints
    WHERE ${statusCondition}
      AND accepted_at IS NOT NULL
      AND NULLIF(CAST(accepted_at AS CHAR), '0000-00-00 00:00:00') IS NOT NULL
      AND STR_TO_DATE(
        NULLIF(CAST(accepted_at AS CHAR), '0000-00-00 00:00:00'),
        '%Y-%m-%d %H:%i:%s'
      ) <= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      AND (
        accepted_overdue_at IS NULL
        OR NULLIF(CAST(accepted_overdue_at AS CHAR), '0000-00-00 00:00:00') IS NULL
      )
    ORDER BY accepted_at ASC
    LIMIT 25
    `
  );

  const results = [];

  for (const complaint of rows || []) {
    try {
      const result = await processOverdueAcceptedComplaint(app, complaint, statusCondition);
      results.push(result);
    } catch (error) {
      console.error("processOverdueAcceptedComplaint error:", error);
      results.push({
        complaint_id: complaint?.id || null,
        updated: false,
        error: error.message
      });
    }
  }

  return {
    checked: true,
    notification_only: false,
    count: rows ? rows.length : 0,
    processed: results.filter((item) => item.updated).length,
    results
  };
}

/*
  Backward-compatible alias.
  server.js may still call the old exported function name, but the behavior is
  now overdue marking, not rejection.
*/
async function autoRejectOverdueAcceptedComplaints(app = null) {
  return markOverdueAcceptedComplaints(app);
}

let overdueAcceptedComplaintSchedulerStarted = false;
let schedulerRunInProgress = false;

function startOverdueAcceptedComplaintScheduler(app) {
  if (overdueAcceptedComplaintSchedulerStarted) {
    return;
  }

  overdueAcceptedComplaintSchedulerStarted = true;

  let schedulerTimer = null;

  const scheduleNextRun = (delay) => {
    if (schedulerTimer) {
      clearTimeout(schedulerTimer);
    }

    schedulerTimer = setTimeout(() => {
      schedulerTimer = null;
      runCheck();
    }, delay);
  };

  const runCheck = async () => {
    if (schedulerRunInProgress) {
      console.warn("[Complaint Scheduler] Skipped overlapping overdue complaint check.");
      scheduleNextRun(5 * 60 * 1000);
      return;
    }

    schedulerRunInProgress = true;

    try {
      const result = await markOverdueAcceptedComplaints(app);

      if (result.processed > 0) {
        console.log(
          `[Complaint Scheduler] Marked ${result.processed} accepted complaint(s) as overdue.`
        );
      }
    } catch (error) {
      console.error(
        "[Complaint Scheduler] Overdue accepted complaint check failed:",
        error.code || "UNKNOWN_DB_ERROR",
        error.message
      );
    } finally {
      schedulerRunInProgress = false;
      scheduleNextRun(5 * 60 * 1000);
    }
  };

  /*
    Run once after startup, then wait 5 minutes after each completed run.
    This gives a maximum delay of around 5 minutes after the 24-hour deadline.
  */
  scheduleNextRun(15000);

  console.log("[Complaint Scheduler] 24-hour accepted complaint overdue checker started.");
}

async function handleManualOverdueAcceptedCheck(req, res) {
  try {
    const result = await markOverdueAcceptedComplaints(req.app);

    return res.json({
      success: true,
      checked: true,
      ...result,
      note: "Accepted complaints older than 24 hours are marked as accepted_overdue, not rejected. Zero-date DATETIME values are handled safely."
    });
  } catch (error) {
    console.error("Manual overdue accepted complaint check error:", error);

    return res.status(500).json({
      success: false,
      checked: false,
      message: "Failed to check overdue accepted complaints.",
      error: error.message
    });
  }
}

/*
  Manual maintenance endpoint.
  Maintenance is an authenticated, CSRF-protected Admin mutation.
  GET also covers Express's automatic HEAD fallback without running the worker.
*/
router.get("/maintenance/check-overdue-accepted", (req, res) => {
  res.set("Allow", "POST");
  return res.status(405).json({ success: false, message: "Method not allowed. Use POST." });
});
router.post("/maintenance/check-overdue-accepted",
  requireWebAuth, requireWebRole("super_admin"), requireCsrf, handleManualOverdueAcceptedCheck);


/* =========================
   DEBUG COMPLAINT NOTIFICATION TARGETS
   Use this to verify if both barangays received notification rows.
========================= */
router.get("/:id/notification-targets", requireWebAuth, requireWebRole("super_admin"), (req, res) => {
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
router.get("/:id", ...complaintAuth.reader, (req, res) => {
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

    const actor = req.complaintActor;
    if ((actor.kind === "citizen" && Number(rows[0].citizen_id) !== Number(actor.id))
      || (actor.kind === "barangay" && String(rows[0].assigned_barangay || "").trim().toLowerCase() !== actor.barangay.toLowerCase())) {
      return res.status(403).json({ success: false, message: "This complaint is not assigned to your barangay." });
    }
    if (actor.kind === "citizen") {
      delete rows[0].barangay_decline_reason;
      delete rows[0].assignment_confirmation_reason;
    }
    return res.json({
      success: true,
      complaint: rows[0]
    });
  });
});

router.markOverdueAcceptedComplaints = markOverdueAcceptedComplaints;
router.autoRejectOverdueAcceptedComplaints = autoRejectOverdueAcceptedComplaints;
router.startOverdueAcceptedComplaintScheduler = startOverdueAcceptedComplaintScheduler;

module.exports = router;
 
