const express = require("express");
const router = express.Router();
const db = require("../config/db");
const bcrypt = require("bcrypt");
const crypto = require("crypto");

let nodemailer = null;

try {
  nodemailer = require("nodemailer");
} catch (err) {
  console.warn("⚠️ nodemailer is not installed. Email verification sending will be disabled.");
}

console.log("✅ authRoutes.js file executed");

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

function isValidEmail(email) {
  const value = cleanText(email).toLowerCase();

  if (!value) return false;

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getUsersColumnSet(callback) {
  const sql = `SHOW COLUMNS FROM users`;

  db.query(sql, (err, rows) => {
    if (err) {
      console.error("Failed to inspect users columns:", err);
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
        /*
          If a concurrent request already added the same column,
          do not break the app.
        */
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

function ensureEmailVerificationColumns(callback) {
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

    if (!hasColumn(columnSet, "email_verification_code")) {
      alterSql.push(`
        ALTER TABLE users
        ADD COLUMN email_verification_code VARCHAR(10) NULL
      `);
    }

    if (!hasColumn(columnSet, "email_verification_expires_at")) {
      alterSql.push(`
        ALTER TABLE users
        ADD COLUMN email_verification_expires_at DATETIME NULL
      `);
    }

    if (alterSql.length === 0) {
      return callback(null);
    }

    runSequentialSql(alterSql, (alterErr) => {
      if (alterErr) {
        console.error("Failed to add email verification columns:", alterErr);
        return callback(alterErr);
      }

      console.log("Users email verification columns checked/added.");
      return callback(null);
    });
  });
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

function createMailTransporter() {
  if (!nodemailer) return null;

  /*
    Recommended ENV for Render:
    SMTP_HOST=smtp.gmail.com
    SMTP_PORT=465
    SMTP_SECURE=true
    SMTP_USER=your_email@gmail.com
    SMTP_PASS=your_app_password
    SMTP_FROM="AI Waste Management <your_email@gmail.com>"

    Fallback ENV also supported:
    EMAIL_USER=your_email@gmail.com
    EMAIL_PASS=your_app_password
  */
  const smtpHost = cleanText(process.env.SMTP_HOST);
  const smtpPort = Number(process.env.SMTP_PORT || 465);
  const smtpUser = cleanText(process.env.SMTP_USER || process.env.EMAIL_USER);
  const smtpPass = cleanText(process.env.SMTP_PASS || process.env.EMAIL_PASS);
  const smtpSecureRaw = cleanText(process.env.SMTP_SECURE || "true").toLowerCase();

  if (!smtpUser || !smtpPass) {
    return null;
  }

  if (smtpHost) {
    return nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecureRaw !== "false",
      auth: {
        user: smtpUser,
        pass: smtpPass
      }
    });
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: smtpUser,
      pass: smtpPass
    }
  });
}

async function sendVerificationEmail(email, fullName, verificationCode) {
  const transporter = createMailTransporter();

  if (!transporter) {
    return {
      sent: false,
      reason: "Email service is not configured."
    };
  }

  const smtpUser = cleanText(process.env.SMTP_USER || process.env.EMAIL_USER);
  const smtpFrom = cleanText(process.env.SMTP_FROM) || `AI Waste Management <${smtpUser}>`;

  const safeName = cleanText(fullName) || "Citizen";

  const subject = "Verify your AI Waste Management account";

  const text = [
    `Hello ${safeName},`,
    "",
    "Use this verification code to activate your account:",
    "",
    verificationCode,
    "",
    "This code will expire in 15 minutes.",
    "",
    "If you did not create this account, you can ignore this email.",
    "",
    "AI Waste Management"
  ].join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #173C2C;">
      <h2 style="margin-bottom: 8px;">Verify your account</h2>
      <p>Hello <strong>${safeName}</strong>,</p>
      <p>Use this verification code to activate your AI Waste Management account:</p>
      <div style="font-size: 28px; font-weight: bold; letter-spacing: 4px; padding: 14px 18px; background: #F1F8F3; border-radius: 12px; display: inline-block; color: #2F8A34;">
        ${verificationCode}
      </div>
      <p style="margin-top: 18px;">This code will expire in <strong>15 minutes</strong>.</p>
      <p>If you did not create this account, you can ignore this email.</p>
      <p style="color: #66766D;">AI Waste Management</p>
    </div>
  `;

  await transporter.sendMail({
    from: smtpFrom,
    to: email,
    subject,
    text,
    html
  });

  return {
    sent: true,
    reason: null
  };
}

/* =========================
   TEST
========================= */

router.get("/test", (req, res) => {
  res.json({
    success: true,
    message: "Auth route is working"
  });
});

/* =========================
   REGISTER CITIZEN
   Requires email for verification.
========================= */

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

  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: "Please enter a valid email address"
    });
  }

  if (username.length < 3) {
    return res.status(400).json({
      success: false,
      message: "Username must be at least 3 characters"
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      success: false,
      message: "Password must be at least 6 characters"
    });
  }

  ensureEmailVerificationColumns((ensureErr) => {
    if (ensureErr) {
      return res.status(500).json({
        success: false,
        message: "Failed to prepare email verification fields.",
        error: ensureErr.message,
        code: ensureErr.code
      });
    }

    const checkUserSql = `
      SELECT id, username, email
      FROM users
      WHERE username = ?
         OR LOWER(TRIM(email)) = LOWER(TRIM(?))
      LIMIT 1
    `;

    db.query(checkUserSql, [username, email], async (checkErr, checkResults) => {
      if (checkErr) {
        return res.status(500).json({
          success: false,
          message: "Database error while checking username/email",
          error: checkErr.message
        });
      }

      if (checkResults && checkResults.length > 0) {
        const existingUser = checkResults[0];

        if (
          cleanText(existingUser.username).toLowerCase() === username.toLowerCase()
        ) {
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

        const insertSql = `
          INSERT INTO users (
            full_name,
            username,
            email,
            password,
            role,
            barangay,
            status,
            email_verified,
            email_verification_code,
            email_verification_expires_at
          )
          VALUES (?, ?, ?, ?, 'citizen', ?, 'active', 0, ?, ?)
        `;

        db.query(
          insertSql,
          [
            fullName,
            username,
            email,
            hashedPassword,
            barangay,
            verificationCode,
            verificationExpiresAt
          ],
          async (insertErr, insertResult) => {
            if (insertErr) {
              return res.status(500).json({
                success: false,
                message: "Database error while creating account",
                error: insertErr.message,
                code: insertErr.code
              });
            }

            let emailResult = {
              sent: false,
              reason: "Email service is not configured."
            };

            try {
              emailResult = await sendVerificationEmail(email, fullName, verificationCode);
            } catch (emailErr) {
              console.error("Verification email send failed:", emailErr);
              emailResult = {
                sent: false,
                reason: emailErr.message
              };
            }

            const message = emailResult.sent
              ? "Account created. Please check your email for the verification code."
              : "Account created, but the verification email could not be sent. Please contact WMO support.";

            return res.status(201).json({
              success: true,
              message,
              verification_required: true,
              verification_email_sent: emailResult.sent,
              email,
              user: {
                id: insertResult.insertId,
                full_name: fullName,
                username,
                role: "citizen",
                barangay: barangay || "",
                email,
                email_verified: false
              }
            });
          }
        );
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

/* =========================
   VERIFY EMAIL CODE
========================= */

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

  ensureEmailVerificationColumns((ensureErr) => {
    if (ensureErr) {
      return res.status(500).json({
        success: false,
        message: "Failed to prepare email verification fields.",
        error: ensureErr.message,
        code: ensureErr.code
      });
    }

    const findSql = `
      SELECT
        id,
        email,
        email_verified,
        email_verification_code,
        email_verification_expires_at
      FROM users
      WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))
      LIMIT 1
    `;

    db.query(findSql, [email], (findErr, rows) => {
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
          message: "Account not found"
        });
      }

      const user = rows[0];

      if (Number(user.email_verified || 0) === 1) {
        return res.json({
          success: true,
          message: "Email is already verified"
        });
      }

      const savedCode = cleanText(user.email_verification_code);

      if (!savedCode || savedCode !== code) {
        return res.status(400).json({
          success: false,
          message: "Invalid verification code"
        });
      }

      const expiresAt = user.email_verification_expires_at
        ? new Date(user.email_verification_expires_at)
        : null;

      if (!expiresAt || Date.now() > expiresAt.getTime()) {
        return res.status(400).json({
          success: false,
          message: "Verification code expired. Please request a new code."
        });
      }

      const updateSql = `
        UPDATE users
        SET email_verified = 1,
            email_verification_code = NULL,
            email_verification_expires_at = NULL,
            status = 'active'
        WHERE id = ?
      `;

      db.query(updateSql, [user.id], (updateErr) => {
        if (updateErr) {
          return res.status(500).json({
            success: false,
            message: "Failed to verify email",
            error: updateErr.message
          });
        }

        return res.json({
          success: true,
          message: "Email verified successfully. You can now log in."
        });
      });
    });
  });
});

/* =========================
   RESEND VERIFICATION CODE
========================= */

router.post("/resend-verification", (req, res) => {
  const email = cleanText(req.body ? req.body.email : null).toLowerCase();
  const username = cleanText(req.body ? req.body.username : null);

  if (!email && !username) {
    return res.status(400).json({
      success: false,
      message: "Email or username is required"
    });
  }

  ensureEmailVerificationColumns((ensureErr) => {
    if (ensureErr) {
      return res.status(500).json({
        success: false,
        message: "Failed to prepare email verification fields.",
        error: ensureErr.message,
        code: ensureErr.code
      });
    }

    const findSql = `
      SELECT
        id,
        full_name,
        username,
        email,
        email_verified
      FROM users
      WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))
         OR username = ?
      LIMIT 1
    `;

    db.query(findSql, [email, username], async (findErr, rows) => {
      if (findErr) {
        return res.status(500).json({
          success: false,
          message: "Database error while finding account",
          error: findErr.message
        });
      }

      if (!rows || rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Account not found"
        });
      }

      const user = rows[0];

      if (!isValidEmail(user.email)) {
        return res.status(400).json({
          success: false,
          message: "This account does not have a valid email address"
        });
      }

      if (Number(user.email_verified || 0) === 1) {
        return res.json({
          success: true,
          message: "Email is already verified"
        });
      }

      const verificationCode = generateVerificationCode();
      const verificationExpiresAt = toMySqlDateTime(getVerificationExpiryDate());

      const updateSql = `
        UPDATE users
        SET email_verification_code = ?,
            email_verification_expires_at = ?
        WHERE id = ?
      `;

      db.query(
        updateSql,
        [verificationCode, verificationExpiresAt, user.id],
        async (updateErr) => {
          if (updateErr) {
            return res.status(500).json({
              success: false,
              message: "Failed to update verification code",
              error: updateErr.message
            });
          }

          let emailResult = {
            sent: false,
            reason: "Email service is not configured."
          };

          try {
            emailResult = await sendVerificationEmail(
              user.email,
              user.full_name || user.username,
              verificationCode
            );
          } catch (emailErr) {
            console.error("Resend verification email failed:", emailErr);
            emailResult = {
              sent: false,
              reason: emailErr.message
            };
          }

          if (!emailResult.sent) {
            return res.status(500).json({
              success: false,
              message: "Verification code was updated, but the email could not be sent. Please contact WMO support.",
              verification_email_sent: false
            });
          }

          return res.json({
            success: true,
            message: "Verification code resent. Please check your email.",
            verification_email_sent: true
          });
        }
      );
    });
  });
});

/* =========================
   LOGIN
========================= */

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

  ensureEmailVerificationColumns((ensureErr) => {
    if (ensureErr) {
      return res.status(500).json({
        success: false,
        message: "Failed to prepare email verification fields.",
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
        Only accounts with an email address are required to verify.
        Older accounts without an email remain compatible.
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
          email_verified: cleanText(user.email) ? Number(user.email_verified || 0) === 1 : true
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
