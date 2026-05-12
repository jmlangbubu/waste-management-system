
const express = require("express");
const router = express.Router();

const db = require("../config/db");

/* =========================
   DIGITAL CERTIFICATE ROUTES

   Purpose:
   - Save certificate records permanently in MySQL.
   - Allow the Citizen mobile app to reload the certificate after logout/login.
   - Allow WMO/Admin to view issued certificate records later.

   Mount in server.js:
   const certificateRoutes = require("../routes/certificateRoutes");
   app.use("/api/certificates", certificateRoutes);
========================= */

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

function normalizeStatus(value) {
  const status = cleanText(value).toLowerCase();

  if (status === "revoked") return "revoked";
  if (status === "expired") return "expired";

  return "active";
}

function getCurrentYear() {
  return new Date().getFullYear();
}

function buildCertificateSuffix(sourceValue, citizenId) {
  let source = cleanText(sourceValue)
    .replace(/^WMO\d{4}-SWMC-/i, "")
    .replace(/^ORI-/i, "")
    .replace(/^CERT-/i, "")
    .trim();

  if (!source && citizenId) {
    source = String(citizenId);
  }

  if (!source) {
    source = String(Date.now()).slice(-6);
  }

  source = source.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

  if (source.length > 8) {
    source = source.slice(-8);
  }

  return source.padStart(4, "0");
}

function buildCertificateNumber(sourceValue, citizenId) {
  const cleaned = cleanText(sourceValue);

  if (/^WMO\d{4}-SWMC-[A-Za-z0-9]+$/i.test(cleaned)) {
    return cleaned.toUpperCase();
  }

  return `WMO${getCurrentYear()}-SWMC-${buildCertificateSuffix(cleaned, citizenId)}`;
}

function normalizeCertificate(row) {
  if (!row) return null;

  return {
    id: row.id,
    citizen_id: row.citizen_id,
    full_name: row.full_name || "",
    username: row.username || "",
    barangay: row.barangay || "",
    orientation_token: row.orientation_token || "",
    certificate_number: row.certificate_number || "",
    issued_at: row.issued_at || row.created_at || null,
    status: row.status || "active",
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

function ensureCertificatesTable(callback) {
  const sql = `
    CREATE TABLE IF NOT EXISTS certificates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      citizen_id INT NULL,
      full_name VARCHAR(150) NOT NULL,
      username VARCHAR(100) NULL,
      barangay VARCHAR(150) NULL,
      orientation_token VARCHAR(120) NULL,
      certificate_number VARCHAR(80) NOT NULL,
      issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_certificate_citizen_id (citizen_id),
      UNIQUE KEY uniq_certificate_number (certificate_number),
      UNIQUE KEY uniq_certificate_orientation_token (orientation_token)
    )
  `;

  db.query(sql, callback);
}

/*
  Safe startup table creation.
  If DB user has CREATE privilege, the table will be created automatically.
  If not, use the SQL file included in the generated bundle.
*/
ensureCertificatesTable((err) => {
  if (err) {
    console.error("Failed to ensure certificates table:", err);
  } else {
    console.log("Certificates table ready.");
  }
});

/* =========================
   CREATE / UPSERT CERTIFICATE
   Used after citizen completes/passes orientation/test.
========================= */
router.post("/", (req, res) => {
  const body = req.body || {};

  const citizenId = parseOptionalInt(body.citizen_id || body.user_id);
  const fullName = cleanText(body.full_name || body.citizen_name || body.name);
  const username = cleanText(body.username);
  const barangay = cleanText(body.barangay || body.citizen_barangay);
  const orientationToken = cleanText(body.orientation_token || body.token || body.certificate_token);
  const certificateNumber = buildCertificateNumber(
    body.certificate_number || body.certificate_no || orientationToken,
    citizenId
  );
  const status = normalizeStatus(body.status);

  if (!citizenId) {
    return res.status(400).json({
      success: false,
      message: "citizen_id is required."
    });
  }

  if (!fullName) {
    return res.status(400).json({
      success: false,
      message: "full_name is required."
    });
  }

  ensureCertificatesTable((tableErr) => {
    if (tableErr) {
      console.error("Certificate table check error:", tableErr);
      return res.status(500).json({
        success: false,
        message: "Failed to prepare certificate table.",
        error: tableErr.message,
        code: tableErr.code
      });
    }

    const sql = `
      INSERT INTO certificates (
        citizen_id,
        full_name,
        username,
        barangay,
        orientation_token,
        certificate_number,
        issued_at,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)
      ON DUPLICATE KEY UPDATE
        full_name = VALUES(full_name),
        username = VALUES(username),
        barangay = VALUES(barangay),
        orientation_token = COALESCE(VALUES(orientation_token), orientation_token),
        certificate_number = VALUES(certificate_number),
        status = VALUES(status),
        updated_at = NOW(),
        id = LAST_INSERT_ID(id)
    `;

    const values = [
      citizenId,
      fullName,
      username || null,
      barangay || null,
      orientationToken || null,
      certificateNumber,
      status
    ];

    db.query(sql, values, (err, result) => {
      if (err) {
        console.error("Create certificate error:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to save certificate record.",
          error: err.message,
          code: err.code
        });
      }

      const certificateId = result && result.insertId ? result.insertId : null;

      const findSql = `
        SELECT *
        FROM certificates
        WHERE id = ?
        LIMIT 1
      `;

      db.query(findSql, [certificateId], (findErr, rows) => {
        if (findErr) {
          console.error("Find saved certificate error:", findErr);
          return res.status(500).json({
            success: false,
            message: "Certificate saved but failed to reload record.",
            error: findErr.message,
            code: findErr.code
          });
        }

        const certificate = rows && rows.length > 0 ? normalizeCertificate(rows[0]) : null;

        return res.json({
          success: true,
          message: "Certificate record saved successfully.",
          has_certificate: Boolean(certificate),
          certificate
        });
      });
    });
  });
});

/* =========================
   GET CERTIFICATE BY USER ID
   Used by CitizenHomeActivity / CertificateActivity.
========================= */
router.get("/user/:userId", (req, res) => {
  const userId = parseOptionalInt(req.params.userId);

  if (!userId) {
    return res.status(400).json({
      success: false,
      message: "Valid user id is required."
    });
  }

  ensureCertificatesTable((tableErr) => {
    if (tableErr) {
      console.error("Certificate table check error:", tableErr);
      return res.status(500).json({
        success: false,
        message: "Failed to prepare certificate table.",
        error: tableErr.message,
        code: tableErr.code
      });
    }

    const sql = `
      SELECT *
      FROM certificates
      WHERE citizen_id = ?
        AND status = 'active'
      ORDER BY issued_at DESC, id DESC
      LIMIT 1
    `;

    db.query(sql, [userId], (err, rows) => {
      if (err) {
        console.error("Get certificate by user error:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to load certificate.",
          error: err.message,
          code: err.code
        });
      }

      if (!rows || rows.length === 0) {
        return res.json({
          success: true,
          has_certificate: false,
          certificate: null
        });
      }

      return res.json({
        success: true,
        has_certificate: true,
        certificate: normalizeCertificate(rows[0])
      });
    });
  });
});

/* =========================
   GET CERTIFICATE BY TOKEN
   Optional lookup by orientation/certificate token.
========================= */
router.get("/token/:token", (req, res) => {
  const token = cleanText(req.params.token);

  if (!token) {
    return res.status(400).json({
      success: false,
      message: "Token is required."
    });
  }

  ensureCertificatesTable((tableErr) => {
    if (tableErr) {
      console.error("Certificate table check error:", tableErr);
      return res.status(500).json({
        success: false,
        message: "Failed to prepare certificate table.",
        error: tableErr.message,
        code: tableErr.code
      });
    }

    const sql = `
      SELECT *
      FROM certificates
      WHERE orientation_token = ?
         OR certificate_number = ?
      ORDER BY issued_at DESC, id DESC
      LIMIT 1
    `;

    db.query(sql, [token, token], (err, rows) => {
      if (err) {
        console.error("Get certificate by token error:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to load certificate.",
          error: err.message,
          code: err.code
        });
      }

      if (!rows || rows.length === 0) {
        return res.json({
          success: true,
          has_certificate: false,
          certificate: null
        });
      }

      return res.json({
        success: true,
        has_certificate: true,
        certificate: normalizeCertificate(rows[0])
      });
    });
  });
});

/* =========================
   GET ALL CERTIFICATES
   For WMO/Admin certificate records.
========================= */
router.get("/", (req, res) => {
  ensureCertificatesTable((tableErr) => {
    if (tableErr) {
      console.error("Certificate table check error:", tableErr);
      return res.status(500).json({
        success: false,
        message: "Failed to prepare certificate table.",
        error: tableErr.message,
        code: tableErr.code
      });
    }

    const sql = `
      SELECT *
      FROM certificates
      ORDER BY issued_at DESC, id DESC
    `;

    db.query(sql, (err, rows) => {
      if (err) {
        console.error("Get all certificates error:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to load certificate records.",
          error: err.message,
          code: err.code
        });
      }

      return res.json({
        success: true,
        certificates: (rows || []).map(normalizeCertificate)
      });
    });
  });
});

module.exports = router;
