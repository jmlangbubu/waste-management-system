const express = require("express");
const router = express.Router();
const db = require("../config/db");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

let nodemailer = null;
let ResendSDK = null;

try {
  nodemailer = require("nodemailer");
} catch (err) {
  console.warn("⚠️ nodemailer is not installed. Run: npm install nodemailer");
}

try {
  const resendPackage = require("resend");
  ResendSDK = resendPackage.Resend;
} catch (err) {
  console.warn("⚠️ resend is not installed. Run: npm install resend");
}

console.log("✅ authRoutes.js file executed");

/* =========================================================
   PROFILE UPLOAD CONFIG
   ========================================================= */

const ROOT_DIR = path.join(__dirname, "..");
const UPLOADS_DIR = path.join(ROOT_DIR, "uploads");
const PROFILE_UPLOADS_DIR = path.join(UPLOADS_DIR, "profiles");

if (!fs.existsSync(PROFILE_UPLOADS_DIR)) {
  fs.mkdirSync(PROFILE_UPLOADS_DIR, { recursive: true });
}

const profileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, PROFILE_UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const userId = cleanText(req.params ? req.params.userId : "user");
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const safeExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
    cb(null, `PROFILE_${userId}_${Date.now()}${safeExt}`);
  }
});

const profileUpload = multer({
  storage: profileStorage,
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const mimetype = (file.mimetype || "").toLowerCase();

    if (!mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed."));
    }

    return cb(null, true);
  }
});

const DEFAULT_PROFILE_AVATAR_KEYS = new Set([
  "avatar_leaf",
  "avatar_recycle",
  "avatar_green",
  "avatar_blue",
  "avatar_orange",
  "avatar_purple"
]);



/* =========================================================
   HELPERS
   ========================================================= */

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

function isValidEmail(email) {
  const value = cleanText(email).toLowerCase();
  if (!value) return false;

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function generateVerificationCode() {
  return String(crypto.randomInt(100000, 999999));
}

function getVerificationExpiryDate() {
  return new Date(Date.now() + 15 * 60 * 1000);
}

function toMySqlDateTime(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function getUsersColumnSet(callback) {
  db.query("SHOW COLUMNS FROM users", (err, rows) => {
    if (err) {
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

function runSequentialSql(sqlList, callback) {
  const statements = sqlList || [];

  const runNext = (index) => {
    if (index >= statements.length) {
      return callback(null);
    }

    db.query(statements[index], (err) => {
      if (err) {
        if (err.code === "ER_DUP_FIELDNAME") {
          return runNext(index + 1);
        }

        return callback(err);
      }

      return runNext(index + 1);
    });
  };

  return runNext(0);
}

function ensureUsersEmailColumns(callback) {
  getUsersColumnSet((columnErr, columnSet) => {
    if (columnErr) {
      return callback(columnErr);
    }

    const alterSql = [];

    if (!hasColumn(columnSet, "email")) {
      alterSql.push(`
        ALTER TABLE users
        ADD COLUMN email VARCHAR(255) NULL
      `);
    }

    if (!hasColumn(columnSet, "email_verified")) {
      alterSql.push(`
        ALTER TABLE users
        ADD COLUMN email_verified TINYINT(1) NOT NULL DEFAULT 0
      `);
    }

    if (!hasColumn(columnSet, "email_verified_at")) {
      alterSql.push(`
        ALTER TABLE users
        ADD COLUMN email_verified_at DATETIME NULL
      `);
    }

    if (alterSql.length === 0) {
      return callback(null);
    }

    runSequentialSql(alterSql, (alterErr) => {
      if (alterErr) {
        console.error("Failed to add users email columns:", alterErr);
        return callback(alterErr);
      }

      console.log("✅ users email columns checked/added.");
      return callback(null);
    });
  });
}


function ensureUsersProfileColumns(callback) {
  getUsersColumnSet((columnErr, columnSet) => {
    if (columnErr) {
      return callback(columnErr);
    }

    const alterSql = [];

    if (!hasColumn(columnSet, "profile_image_url")) {
      alterSql.push(`
        ALTER TABLE users
        ADD COLUMN profile_image_url VARCHAR(500) NULL
      `);
    }

    if (!hasColumn(columnSet, "profile_avatar_key")) {
      alterSql.push(`
        ALTER TABLE users
        ADD COLUMN profile_avatar_key VARCHAR(100) NULL
      `);
    }

    if (!hasColumn(columnSet, "profile_updated_at")) {
      alterSql.push(`
        ALTER TABLE users
        ADD COLUMN profile_updated_at DATETIME NULL
      `);
    }

    if (alterSql.length === 0) {
      return callback(null);
    }

    runSequentialSql(alterSql, (alterErr) => {
      if (alterErr) {
        console.error("Failed to add users profile columns:", alterErr);
        return callback(alterErr);
      }

      console.log("✅ users profile columns checked/added.");
      return callback(null);
    });
  });
}

function ensureUserProfileReady(callback) {
  ensureUsersEmailColumns((emailErr) => {
    if (emailErr) {
      return callback(emailErr);
    }

    ensureUsersProfileColumns(callback);
  });
}

function buildPublicUrl(req, relativePath) {
  const cleanPath = cleanText(relativePath);

  if (!cleanPath) return "";

  if (cleanPath.startsWith("http://") || cleanPath.startsWith("https://")) {
    return cleanPath;
  }

  /*
    Keep relative path in DB, but return a full URL too.
    x-forwarded-proto helps Render return https:// instead of http://.
  */
  const protocol = cleanText(req.headers["x-forwarded-proto"]) || req.protocol || "https";
  const host = req.get("host");

  if (!host) return cleanPath;

  return `${protocol}://${host}${cleanPath.startsWith("/") ? "" : "/"}${cleanPath}`;
}

function deleteOldProfileImageIfLocal(oldProfileImageUrl) {
  const cleanUrl = cleanText(oldProfileImageUrl);

  if (!cleanUrl || !cleanUrl.startsWith("/uploads/profiles/")) {
    return;
  }

  const fileName = path.basename(cleanUrl);
  const filePath = path.join(PROFILE_UPLOADS_DIR, fileName);

  fs.unlink(filePath, (err) => {
    if (err && err.code !== "ENOENT") {
      console.warn("Failed to delete old profile image:", err.message);
    }
  });
}

function getSafeUserId(value) {
  const userId = parseInt(cleanText(value), 10);

  if (!Number.isFinite(userId) || userId <= 0) {
    return -1;
  }

  return userId;
}


function ensurePendingCitizenSignupsTable(callback) {
  const sql = `
    CREATE TABLE IF NOT EXISTS pending_citizen_signups (
      id INT AUTO_INCREMENT PRIMARY KEY,
      full_name VARCHAR(255) NOT NULL,
      username VARCHAR(100) NOT NULL,
      email VARCHAR(255) NOT NULL,
      password VARCHAR(255) NOT NULL,
      barangay VARCHAR(150) NOT NULL,
      verification_code VARCHAR(10) NOT NULL,
      verification_expires_at DATETIME NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_pending_username (username),
      UNIQUE KEY unique_pending_email (email)
    )
  `;

  db.query(sql, (err) => {
    if (err) {
      console.error("Failed to create pending_citizen_signups table:", err);
      return callback(err);
    }

    return callback(null);
  });
}

function ensureAuthTables(callback) {
  ensureUsersEmailColumns((usersErr) => {
    if (usersErr) {
      return callback(usersErr);
    }

    ensureUsersProfileColumns((profileErr) => {
      if (profileErr) {
        return callback(profileErr);
      }

      ensurePendingCitizenSignupsTable((pendingErr) => {
        if (pendingErr) {
          return callback(pendingErr);
        }

        return callback(null);
      });
    });
  });
}


function createResendClient() {
  const resendApiKey = cleanText(process.env.RESEND_API_KEY || process.env.RESEND_KEY);

  if (!ResendSDK || !resendApiKey) {
    return null;
  }

  return new ResendSDK(resendApiKey);
}

function getResendFromAddress() {
  /*
    Recommended:
    RESEND_FROM=WMO <noreply@wastegensan.com>

    For quick testing, Resend usually allows:
    RESEND_FROM=WMO <onboarding@resend.dev>

    For production/custom domain, verify wastegensan.com inside Resend first.
  */
  return cleanText(process.env.RESEND_FROM) ||
    cleanText(process.env.SMTP_FROM) ||
    "WMO <onboarding@resend.dev>";
}

function logEmailProviderStatus() {
  const resendApiKey = cleanText(process.env.RESEND_API_KEY || process.env.RESEND_KEY);
  const resendFrom = getResendFromAddress();

  console.log("📨 EMAIL PROVIDER STATUS:", {
    resendInstalled: !!ResendSDK,
    resendApiKeyConfigured: !!resendApiKey,
    resendFrom,
    smtpUserConfigured: !!cleanText(process.env.SMTP_USER || process.env.EMAIL_USER),
    smtpPassConfigured: !!cleanText(process.env.SMTP_PASS || process.env.EMAIL_PASS)
  });
}


function createMailTransporter() {
  if (!nodemailer) {
    console.warn("⚠️ nodemailer package is not available.");
    return null;
  }

  const smtpHost = cleanText(process.env.SMTP_HOST);
  const smtpPort = Number(process.env.SMTP_PORT || 465);
  const smtpUser = cleanText(process.env.SMTP_USER || process.env.EMAIL_USER);
  const smtpPass = cleanText(process.env.SMTP_PASS || process.env.EMAIL_PASS);
  const smtpSecureRaw = cleanText(process.env.SMTP_SECURE || "true").toLowerCase();
  const timeoutMs = getSmtpTimeoutMs();

  if (!smtpUser || !smtpPass) {
    console.warn("⚠️ SMTP credentials are missing. Check SMTP_USER/SMTP_PASS or EMAIL_USER/EMAIL_PASS.");
    return null;
  }

  const baseOptions = {
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    auth: {
      user: smtpUser,
      pass: smtpPass
    }
  };

  if (smtpHost) {
    return nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecureRaw !== "false",
      ...baseOptions
    });
  }

  return nodemailer.createTransport({
    service: "gmail",
    ...baseOptions
  });
}

async function sendVerificationEmail(email, fullName, verificationCode) {
  logEmailProviderStatus();

  const safeName = cleanText(fullName) || "Citizen";
  const safeNameHtml = escapeHtml(safeName);
  const safeCode = cleanText(verificationCode);
  const safeCodeHtml = escapeHtml(safeCode);

  const subject = "Verify your WMO Account";

  const text = [
    `Hello ${safeName},`,
    "",
    "Welcome to WMO.",
    "",
    "Use this verification code to activate your account:",
    "",
    safeCode,
    "",
    "This code will expire in 15 minutes.",
    "Do not share this code with anyone.",
    "",
    "If you did not create this account, you can ignore this email.",
    "",
    "Waste Management Office"
  ].join("\n");

  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Verify your WMO Account</title>
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
                        <td style="vertical-align:middle;">
                          <div style="display:inline-block; width:46px; height:46px; line-height:46px; text-align:center; border-radius:16px; background:#E7F5EA; color:#0B4B2B; font-weight:800; font-size:15px; letter-spacing:0.5px;">
                            WMO
                          </div>
                        </td>
                        <td style="vertical-align:middle; padding-left:14px;">
                          <div style="font-size:20px; line-height:1.25; font-weight:800; color:#FFFFFF;">
                            Waste Management Office
                          </div>
                          <div style="font-size:12px; line-height:1.5; color:#CFE6D6; margin-top:2px;">
                            Account Verification
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td style="padding:30px 28px 10px 28px;">
                    <div style="font-size:24px; line-height:1.25; font-weight:800; color:#123826; margin:0 0 10px 0;">
                      Verify your account
                    </div>

                    <div style="font-size:15px; line-height:1.7; color:#40564A; margin:0 0 20px 0;">
                      Hello <strong style="color:#123826;">${safeNameHtml}</strong>, use the code below to activate your WMO account.
                    </div>

                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 22px 0;">
                      <tr>
                        <td align="center" style="background:#F0FAF2; border:1px solid #D4EBDD; border-radius:18px; padding:22px 14px;">
                          <div style="font-size:11px; line-height:1.4; color:#60756A; font-weight:700; letter-spacing:0.8px; text-transform:uppercase; margin-bottom:8px;">
                            Verification Code
                          </div>
                          <div style="font-size:34px; line-height:1; font-weight:900; letter-spacing:8px; color:#2F8A34; font-family:Arial, Helvetica, sans-serif;">
                            ${safeCodeHtml}
                          </div>
                        </td>
                      </tr>
                    </table>

                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px 0;">
                      <tr>
                        <td style="background:#FFF8E7; border:1px solid #F1D28A; border-radius:16px; padding:14px 16px;">
                          <div style="font-size:14px; line-height:1.6; color:#5F4A1A;">
                            This code will expire in <strong>15 minutes</strong>. For security, do not share this code with anyone.
                          </div>
                        </td>
                      </tr>
                    </table>

                    <div style="font-size:14px; line-height:1.7; color:#60756A;">
                      If you did not create this account, you can safely ignore this email.
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

  /*
    PRIMARY PROVIDER: Resend API
    This avoids Gmail SMTP connection timeout on Render.
  */
  const resend = createResendClient();

  if (resend) {
    const resendFrom = getResendFromAddress();

    console.log("📨 Sending verification email via Resend API to:", email);

    const result = await resend.emails.send({
      from: resendFrom,
      to: [email],
      subject,
      text,
      html
    });

    if (result && result.error) {
      console.error("Resend email error:", result.error);

      return {
        sent: false,
        reason: result.error.message || JSON.stringify(result.error)
      };
    }

    console.log("✅ Verification email sent via Resend API to:", email);

    return {
      sent: true,
      reason: null
    };
  }

  /*
    FALLBACK PROVIDER: Gmail SMTP / Nodemailer
    Use this only when RESEND_API_KEY is not configured.
  */
  logSmtpConfigStatus();

  const transporter = createMailTransporter();

  if (!transporter) {
    return {
      sent: false,
      reason: "Email service is not configured. Add RESEND_API_KEY/RESEND_FROM or SMTP_USER/SMTP_PASS."
    };
  }

  const smtpUser = cleanText(process.env.SMTP_USER || process.env.EMAIL_USER);
  const smtpFrom = cleanText(process.env.SMTP_FROM) || `WMO <${smtpUser}>`;

  console.log("📧 Sending verification email via SMTP to:", email);

  await transporter.sendMail({
    from: smtpFrom,
    to: email,
    subject,
    text,
    html
  });

  console.log("✅ Verification email sent via SMTP to:", email);

  return {
    sent: true,
    reason: null
  };
}

function getErrorMessageFromEmailSend(error) {
  if (!error) {
    return "Verification email could not be sent.";
  }

  if (error.name === "validation_error") {
    return "Resend validation failed. Check RESEND_FROM sender/domain and recipient email.";
  }

  if (error.code === "ETIMEDOUT" || error.code === "ESOCKET") {
    return "SMTP connection timed out. Use RESEND_API_KEY to send through Resend API instead of Gmail SMTP.";
  }

  if (error.code === "EAUTH") {
    return "Gmail authentication failed. Check SMTP_USER and SMTP_PASS App Password.";
  }

  if (error.response) {
    return error.response;
  }

  if (error.message) {
    return error.message;
  }

  return "Verification email could not be sent.";
}


function getSmtpTimeoutMs() {
  const configuredTimeout = Number(process.env.SMTP_TIMEOUT_MS || 15000);

  if (!Number.isFinite(configuredTimeout) || configuredTimeout < 5000) {
    return 15000;
  }

  return configuredTimeout;
}

function logSmtpConfigStatus() {
  const smtpHost = cleanText(process.env.SMTP_HOST);
  const smtpPort = cleanText(process.env.SMTP_PORT || "465");
  const smtpUser = cleanText(process.env.SMTP_USER || process.env.EMAIL_USER);
  const smtpPass = cleanText(process.env.SMTP_PASS || process.env.EMAIL_PASS);
  const smtpFrom = cleanText(process.env.SMTP_FROM);

  console.log("📧 SMTP CONFIG STATUS:", {
    host: smtpHost || "(gmail service fallback)",
    port: smtpPort,
    userConfigured: !!smtpUser,
    passConfigured: !!smtpPass,
    fromConfigured: !!smtpFrom,
    timeoutMs: getSmtpTimeoutMs()
  });
}


/* =========================================================
   ROUTES
   ========================================================= */

router.get("/test", (req, res) => {
  res.json({
    success: true,
    message: "Auth route is working"
  });
});

/* =========================================================
   CITIZEN PROFILE ROUTES
   Database-backed profile picture and default avatar.
   ========================================================= */

router.get("/profile/:userId", (req, res) => {
  const userId = getSafeUserId(req.params.userId);

  if (userId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Valid user ID is required"
    });
  }

  ensureUserProfileReady((ensureErr) => {
    if (ensureErr) {
      return res.status(500).json({
        success: false,
        message: "Failed to prepare profile fields",
        error: ensureErr.message,
        code: ensureErr.code
      });
    }

    const sql = `
      SELECT
        id,
        full_name,
        username,
        email,
        role,
        barangay,
        profile_image_url,
        profile_avatar_key,
        profile_updated_at
      FROM users
      WHERE id = ?
      LIMIT 1
    `;

    db.query(sql, [userId], (err, rows) => {
      if (err) {
        return res.status(500).json({
          success: false,
          message: "Database error while loading profile",
          error: err.message
        });
      }

      if (!rows || rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "User profile not found"
        });
      }

      const user = rows[0];

      return res.json({
        success: true,
        profile: {
          id: user.id,
          full_name: user.full_name || "",
          username: user.username || "",
          email: user.email || "",
          role: user.role || "",
          barangay: user.barangay || "",
          profile_image_url: user.profile_image_url || "",
          profile_image_full_url: buildPublicUrl(req, user.profile_image_url || ""),
          profile_avatar_key: user.profile_avatar_key || "avatar_leaf",
          profile_updated_at: user.profile_updated_at || null
        }
      });
    });
  });
});

router.post("/profile/:userId/avatar", (req, res) => {
  const userId = getSafeUserId(req.params.userId);
  const avatarKey = cleanText(req.body ? req.body.profile_avatar_key : "");

  if (userId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Valid user ID is required"
    });
  }

  if (!avatarKey || !DEFAULT_PROFILE_AVATAR_KEYS.has(avatarKey)) {
    return res.status(400).json({
      success: false,
      message: "Invalid default avatar selected"
    });
  }

  ensureUserProfileReady((ensureErr) => {
    if (ensureErr) {
      return res.status(500).json({
        success: false,
        message: "Failed to prepare profile fields",
        error: ensureErr.message,
        code: ensureErr.code
      });
    }

    const findSql = `
      SELECT profile_image_url
      FROM users
      WHERE id = ?
      LIMIT 1
    `;

    db.query(findSql, [userId], (findErr, rows) => {
      if (findErr) {
        return res.status(500).json({
          success: false,
          message: "Database error while checking profile",
          error: findErr.message
        });
      }

      if (!rows || rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "User profile not found"
        });
      }

      const oldProfileImageUrl = rows[0].profile_image_url || "";

      const updateSql = `
        UPDATE users
        SET profile_avatar_key = ?,
            profile_image_url = NULL,
            profile_updated_at = NOW()
        WHERE id = ?
      `;

      db.query(updateSql, [avatarKey, userId], (updateErr) => {
        if (updateErr) {
          return res.status(500).json({
            success: false,
            message: "Database error while saving avatar",
            error: updateErr.message
          });
        }

        deleteOldProfileImageIfLocal(oldProfileImageUrl);

        return res.json({
          success: true,
          message: "Profile avatar updated successfully",
          profile: {
            id: userId,
            profile_avatar_key: avatarKey,
            profile_image_url: "",
            profile_image_full_url: ""
          }
        });
      });
    });
  });
});

router.post("/profile/:userId/photo", profileUpload.single("profile_image"), (req, res) => {
  const userId = getSafeUserId(req.params.userId);

  if (userId <= 0) {
    if (req.file && req.file.path) {
      fs.unlink(req.file.path, () => {});
    }

    return res.status(400).json({
      success: false,
      message: "Valid user ID is required"
    });
  }

  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "Profile image is required"
    });
  }

  ensureUserProfileReady((ensureErr) => {
    if (ensureErr) {
      if (req.file && req.file.path) {
        fs.unlink(req.file.path, () => {});
      }

      return res.status(500).json({
        success: false,
        message: "Failed to prepare profile fields",
        error: ensureErr.message,
        code: ensureErr.code
      });
    }

    const relativeImageUrl = `/uploads/profiles/${req.file.filename}`;

    const findSql = `
      SELECT profile_image_url
      FROM users
      WHERE id = ?
      LIMIT 1
    `;

    db.query(findSql, [userId], (findErr, rows) => {
      if (findErr) {
        fs.unlink(req.file.path, () => {});

        return res.status(500).json({
          success: false,
          message: "Database error while checking profile",
          error: findErr.message
        });
      }

      if (!rows || rows.length === 0) {
        fs.unlink(req.file.path, () => {});

        return res.status(404).json({
          success: false,
          message: "User profile not found"
        });
      }

      const oldProfileImageUrl = rows[0].profile_image_url || "";

      const updateSql = `
        UPDATE users
        SET profile_image_url = ?,
            profile_avatar_key = NULL,
            profile_updated_at = NOW()
        WHERE id = ?
      `;

      db.query(updateSql, [relativeImageUrl, userId], (updateErr) => {
        if (updateErr) {
          fs.unlink(req.file.path, () => {});

          return res.status(500).json({
            success: false,
            message: "Database error while saving profile image",
            error: updateErr.message
          });
        }

        deleteOldProfileImageIfLocal(oldProfileImageUrl);

        return res.json({
          success: true,
          message: "Profile picture updated successfully",
          profile: {
            id: userId,
            profile_avatar_key: "",
            profile_image_url: relativeImageUrl,
            profile_image_full_url: buildPublicUrl(req, relativeImageUrl)
          }
        });
      });
    });
  });
});



/*
  REGISTER FLOW:
  1. Validate user details.
  2. Check users table for existing username/email.
  3. Store details in pending_citizen_signups only.
  4. Send code to Gmail.
  5. No row is inserted into users yet.
*/
router.post("/register", async (req, res) => {
  const fullName = cleanText(req.body ? req.body.full_name : null);
  const username = cleanText(req.body ? req.body.username : null);
  const email = cleanText(req.body ? req.body.email : null).toLowerCase();
  const password = cleanText(req.body ? req.body.password : null);
  const barangay = cleanText(req.body ? req.body.barangay : null);

  if (!fullName || !username || !email || !password || !barangay) {
    return res.status(400).json({
      success: false,
      message: "Full name, username, email, password, and barangay are required"
    });
  }

  if (username.length < 3) {
    return res.status(400).json({
      success: false,
      message: "Username must be at least 3 characters"
    });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: "Please enter a valid email address"
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      success: false,
      message: "Password must be at least 6 characters"
    });
  }

  ensureAuthTables((ensureErr) => {
    if (ensureErr) {
      return res.status(500).json({
        success: false,
        message: "Failed to prepare signup verification tables.",
        error: ensureErr.message,
        code: ensureErr.code
      });
    }

    const checkExistingUserSql = `
      SELECT id, username, email
      FROM users
      WHERE username = ?
         OR LOWER(TRIM(email)) = LOWER(TRIM(?))
      LIMIT 1
    `;

    db.query(checkExistingUserSql, [username, email], async (checkErr, checkResults) => {
      if (checkErr) {
        return res.status(500).json({
          success: false,
          message: "Database error while checking existing account",
          error: checkErr.message
        });
      }

      if (checkResults && checkResults.length > 0) {
        const existingUser = checkResults[0];

        if (cleanText(existingUser.username).toLowerCase() === username.toLowerCase()) {
          return res.status(409).json({
            success: false,
            message: "Username already exists"
          });
        }

        return res.status(409).json({
          success: false,
          message: "Email address is already registered"
        });
      }

      try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const verificationCode = generateVerificationCode();
        const verificationExpiresAt = toMySqlDateTime(getVerificationExpiryDate());

        /*
          Replace old pending attempt with the newest one.
          This lets a user retry signup if they typed the wrong code or code expired.
        */
        const deletePendingSql = `
          DELETE FROM pending_citizen_signups
          WHERE username = ?
             OR LOWER(TRIM(email)) = LOWER(TRIM(?))
        `;

        db.query(deletePendingSql, [username, email], (deleteErr) => {
          if (deleteErr) {
            return res.status(500).json({
              success: false,
              message: "Database error while resetting previous pending signup",
              error: deleteErr.message
            });
          }

          const insertPendingSql = `
            INSERT INTO pending_citizen_signups (
              full_name,
              username,
              email,
              password,
              barangay,
              verification_code,
              verification_expires_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `;

          db.query(
            insertPendingSql,
            [
              fullName,
              username,
              email,
              hashedPassword,
              barangay,
              verificationCode,
              verificationExpiresAt
            ],
            async (insertErr) => {
              if (insertErr) {
                return res.status(500).json({
                  success: false,
                  message: "Database error while saving pending signup",
                  error: insertErr.message,
                  code: insertErr.code
                });
              }

              try {
                const emailResult = await sendVerificationEmail(email, fullName, verificationCode);

                if (!emailResult.sent) {
                  db.query(
                    "DELETE FROM pending_citizen_signups WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))",
                    [email],
                    () => {}
                  );

                  return res.status(500).json({
                    success: false,
                    message: "Verification email was not sent. Account was not created. Please check SMTP settings.",
                    email_sent: false,
                    reason: emailResult.reason
                  });
                }

                return res.status(201).json({
                  success: true,
                  message: "Verification code sent. Please check your email.",
                  verification_required: true,
                  email_sent: true,
                  email
                });
              } catch (emailErr) {
                console.error("Verification email send failed:", emailErr);

                db.query(
                  "DELETE FROM pending_citizen_signups WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))",
                  [email],
                  () => {}
                );

                return res.status(500).json({
                  success: false,
                  message: "Verification email was not sent. Account was not created. Please check SMTP settings.",
                  email_sent: false,
                  error: getErrorMessageFromEmailSend(emailErr)
                });
              }
            }
          );
        });
      } catch (hashErr) {
        return res.status(500).json({
          success: false,
          message: "Password hashing failed",
          error: hashErr.message
        });
      }
    });
  });
});

/*
  VERIFY FLOW:
  1. Check pending_citizen_signups by email.
  2. Validate code and expiration.
  3. Insert into users only after successful verification.
  4. Delete pending signup.
*/
router.post("/verify-email", (req, res) => {
  const email = cleanText(req.body ? req.body.email : null).toLowerCase();
  const code = cleanText(req.body ? req.body.code : null);

  if (!email || !code) {
    return res.status(400).json({
      success: false,
      message: "Email and verification code are required"
    });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: "Please enter a valid email address"
    });
  }

  ensureAuthTables((ensureErr) => {
    if (ensureErr) {
      return res.status(500).json({
        success: false,
        message: "Failed to prepare signup verification tables.",
        error: ensureErr.message,
        code: ensureErr.code
      });
    }

    const findPendingSql = `
      SELECT *
      FROM pending_citizen_signups
      WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))
      LIMIT 1
    `;

    db.query(findPendingSql, [email], (findErr, rows) => {
      if (findErr) {
        return res.status(500).json({
          success: false,
          message: "Database error while checking verification code",
          error: findErr.message
        });
      }

      if (!rows || rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "No pending signup found. Please sign up again."
        });
      }

      const pendingUser = rows[0];

      if (cleanText(pendingUser.verification_code) !== code) {
        return res.status(400).json({
          success: false,
          message: "Invalid verification code"
        });
      }

      const expiresAt = pendingUser.verification_expires_at
        ? new Date(pendingUser.verification_expires_at)
        : null;

      if (!expiresAt || Date.now() > expiresAt.getTime()) {
        return res.status(400).json({
          success: false,
          message: "Verification code expired. Please request a new code."
        });
      }

      const checkExistingUserSql = `
        SELECT id, username, email
        FROM users
        WHERE username = ?
           OR LOWER(TRIM(email)) = LOWER(TRIM(?))
        LIMIT 1
      `;

      db.query(
        checkExistingUserSql,
        [pendingUser.username, pendingUser.email],
        (checkErr, existingRows) => {
          if (checkErr) {
            return res.status(500).json({
              success: false,
              message: "Database error while finalizing account",
              error: checkErr.message
            });
          }

          if (existingRows && existingRows.length > 0) {
            return res.status(409).json({
              success: false,
              message: "Account already exists. Please go back to login."
            });
          }

          const insertUserSql = `
            INSERT INTO users (
              full_name,
              username,
              email,
              password,
              role,
              barangay,
              status,
              email_verified,
              email_verified_at
            )
            VALUES (?, ?, ?, ?, 'citizen', ?, 'active', 1, NOW())
          `;

          db.query(
            insertUserSql,
            [
              pendingUser.full_name,
              pendingUser.username,
              pendingUser.email,
              pendingUser.password,
              pendingUser.barangay
            ],
            (insertErr, insertResult) => {
              if (insertErr) {
                return res.status(500).json({
                  success: false,
                  message: "Database error while creating verified account",
                  error: insertErr.message,
                  code: insertErr.code
                });
              }

              db.query(
                "DELETE FROM pending_citizen_signups WHERE id = ?",
                [pendingUser.id],
                () => {}
              );

              return res.status(201).json({
                success: true,
                message: "Email verified successfully. Your account is now created.",
                user: {
                  id: insertResult.insertId,
                  full_name: pendingUser.full_name,
                  username: pendingUser.username,
                  email: pendingUser.email,
                  role: "citizen",
                  barangay: pendingUser.barangay || "",
                  email_verified: true
                }
              });
            }
          );
        }
      );
    });
  });
});

/*
  RESEND FLOW:
  Resend code only for pending signups.
*/
router.post("/resend-verification", (req, res) => {
  const email = cleanText(req.body ? req.body.email : null).toLowerCase();
  const username = cleanText(req.body ? req.body.username : null);

  if (!email && !username) {
    return res.status(400).json({
      success: false,
      message: "Email or username is required"
    });
  }

  ensureAuthTables((ensureErr) => {
    if (ensureErr) {
      return res.status(500).json({
        success: false,
        message: "Failed to prepare signup verification tables.",
        error: ensureErr.message,
        code: ensureErr.code
      });
    }

    const findPendingSql = `
      SELECT *
      FROM pending_citizen_signups
      WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))
         OR username = ?
      LIMIT 1
    `;

    db.query(findPendingSql, [email, username], (findErr, rows) => {
      if (findErr) {
        return res.status(500).json({
          success: false,
          message: "Database error while finding pending signup",
          error: findErr.message
        });
      }

      if (!rows || rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "No pending signup found. Please sign up again."
        });
      }

      const pendingUser = rows[0];
      const newCode = generateVerificationCode();
      const newExpiresAt = toMySqlDateTime(getVerificationExpiryDate());

      const updatePendingSql = `
        UPDATE pending_citizen_signups
        SET verification_code = ?,
            verification_expires_at = ?
        WHERE id = ?
      `;

      db.query(updatePendingSql, [newCode, newExpiresAt, pendingUser.id], async (updateErr) => {
        if (updateErr) {
          return res.status(500).json({
            success: false,
            message: "Failed to update verification code",
            error: updateErr.message
          });
        }

        try {
          const emailResult = await sendVerificationEmail(
            pendingUser.email,
            pendingUser.full_name,
            newCode
          );

          if (!emailResult.sent) {
            return res.status(500).json({
              success: false,
              message: "Verification email was not sent. Please check SMTP settings.",
              email_sent: false,
              reason: emailResult.reason
            });
          }

          return res.json({
            success: true,
            message: "Verification code resent. Please check your email.",
            email_sent: true
          });
        } catch (emailErr) {
          console.error("Resend verification email failed:", emailErr);

          return res.status(500).json({
            success: false,
            message: "Verification email was not sent. Please check SMTP settings.",
            email_sent: false,
            error: getErrorMessageFromEmailSend(emailErr)
          });
        }
      });
    });
  });
});

/*
  LOGIN:
  Pending signups are not in users table, so they cannot login yet.
*/
router.post("/login", (req, res) => {
  console.log("==== LOGIN REQUEST START ====");
  console.log("headers content-type:", req.headers["content-type"]);
  console.log("req.body:", req.body);

  const username = cleanText(req.body ? req.body.username : null);
  const password = cleanText(req.body ? req.body.password : null);

  console.log("username:", username);
  console.log("password exists:", !!password);

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: "Username and password are required",
      debug: {
        receivedUsername: username || null,
        receivedPassword: !!password
      }
    });
  }

  ensureUserProfileReady((ensureErr) => {
    if (ensureErr) {
      return res.status(500).json({
        success: false,
        message: "Failed to prepare login fields.",
        error: ensureErr.message,
        code: ensureErr.code
      });
    }

    const sql = `
      SELECT
        id,
        full_name,
        username,
        email,
        email_verified,
        profile_image_url,
        profile_avatar_key,
        password,
        role,
        mobile_role,
        barangay,
        assigned_source_name,
        status
      FROM users
      WHERE username = ?
      LIMIT 1
    `;

    db.query(sql, [username], async (err, results) => {
      if (err) {
        return res.status(500).json({
          success: false,
          message: "Database error",
          error: err.message
        });
      }

      if (results.length === 0) {
        return res.status(401).json({
          success: false,
          message: "Invalid username or password"
        });
      }

      const user = results[0];
      console.log("LOGIN DB USER:", user);

      const resolvedRole = (user.role || user.mobile_role || "").toString().trim();
      const resolvedBarangay = (user.barangay || user.assigned_source_name || "").toString().trim();
      const resolvedStatus = (user.status || "active").toString().trim().toLowerCase();

      if (!resolvedRole) {
        return res.status(500).json({
          success: false,
          message: "Account role is missing. Please contact the administrator."
        });
      }

      if (resolvedStatus === "suspended") {
        return res.status(403).json({
          success: false,
          message: "This account is suspended."
        });
      }

      if (resolvedStatus === "inactive") {
        return res.status(403).json({
          success: false,
          message: "This account is inactive."
        });
      }

      /*
        Compatibility:
        Old accounts without email are allowed.
        New citizen accounts created through verify-email have email_verified = 1.
      */
      if (cleanText(user.email) && Number(user.email_verified || 0) !== 1) {
        return res.status(403).json({
          success: false,
          message: "Please verify your email before logging in.",
          email_verification_required: true,
          email: user.email
        });
      }

      try {
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
          return res.status(401).json({
            success: false,
            message: "Invalid username or password"
          });
        }

        const responseUser = {
          id: user.id,
          full_name: user.full_name,
          username: user.username,
          role: resolvedRole,
          barangay: resolvedBarangay,
          email: user.email || "",
          email_verified: cleanText(user.email) ? Number(user.email_verified || 0) === 1 : true,
          profile_image_url: user.profile_image_url || "",
          profile_avatar_key: user.profile_avatar_key || ""
        };

        console.log("LOGIN RESPONSE USER:", responseUser);

        return res.status(200).json({
          success: true,
          message: "Login successful",
          user: responseUser
        });
      } catch (compareErr) {
        return res.status(500).json({
          success: false,
          message: "Password verification failed",
          error: compareErr.message
        });
      }
    });
  });
});

module.exports = router;
