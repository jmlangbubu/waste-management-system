const express = require("express");
const bcrypt = require("bcrypt");
const db = require("../config/db");
const webSessionService = require("../services/webSessionService");
const {
  SESSION_COOKIE_NAME,
  getCookieValue,
  setSessionCookies,
  clearSessionCookies,
  requireWebAuth,
  requireWebRole,
  requireCsrf
} = require("../middleware/webSessionAuth");

const router = express.Router();

router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
});

function sendSessionStoreError(res, error, operation) {
  console.warn(
    `[WebAuth] ${operation} unavailable:`,
    error.cause?.code || error.code || "UNKNOWN_SESSION_ERROR"
  );
  return res.status(503).json({
    success: false,
    message: "Web Admin authentication is temporarily unavailable.",
    code: "WEB_SESSION_STORE_UNAVAILABLE"
  });
}

router.post("/login", (req, res) => {
  const username = req.body?.username ? String(req.body.username).trim() : "";
  const password = req.body?.password ? String(req.body.password).trim() : "";

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: "Username and password are required."
    });
  }

  const sql = `
    SELECT id, full_name, username, password, role, division_name, status
    FROM web_users
    WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))
    LIMIT 1
  `;

  db.queryReadOnly(sql, [username], async (error, results) => {
    if (error) {
      console.warn(
        "[WebAuth] Login database lookup failed:",
        error.code || "UNKNOWN_DB_ERROR"
      );

      if (db.shouldReturnServiceUnavailable(error)) {
        return res.status(503).json({
          success: false,
          message: "Database service is temporarily unavailable. Please try again."
        });
      }

      return res.status(500).json({
        success: false,
        message: "Server error during web login."
      });
    }

    if (!results || results.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password."
      });
    }

    const user = results[0];
    const dbPassword = String(user.password || "").trim();
    const inputPassword = String(password || "").trim();
    const status = String(user.status || "").trim().toLowerCase();

    if (status !== "active") {
      return res.status(403).json({
        success: false,
        message: "This account is inactive."
      });
    }

    try {
      const isHashedPassword =
        dbPassword.startsWith("$2a$") ||
        dbPassword.startsWith("$2b$") ||
        dbPassword.startsWith("$2y$");
      const isMatch = isHashedPassword
        ? await bcrypt.compare(inputPassword, dbPassword)
        : dbPassword === inputPassword;

      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: "Invalid username or password."
        });
      }

      const previousSessionToken = getCookieValue(req, SESSION_COOKIE_NAME);
      const session = await webSessionService.rotateSession(
        user.id,
        previousSessionToken
      );
      setSessionCookies(res, session);

      return res.json({
        success: true,
        message: "Web login successful.",
        user: {
          id: user.id,
          fullName: user.full_name,
          username: user.username,
          role: user.role,
          divisionName: user.division_name,
          status: user.status
        }
      });
    } catch (loginError) {
      if (loginError.code === "WEB_SESSION_STORE_UNAVAILABLE") {
        return sendSessionStoreError(res, loginError, "Session creation");
      }
      console.warn(
        "[WebAuth] Password verification failed:",
        loginError.code || loginError.name || "PASSWORD_COMPARE_ERROR"
      );
      return res.status(500).json({
        success: false,
        message: "Server error during password verification."
      });
    }
  });
});

router.get("/session", requireWebAuth, (req, res) => {
  const divisionName = req.webSession?.divisionName || null;
  return res.json({
    success: true,
    user: {
      id: req.user.id,
      full_name: req.user.full_name,
      fullName: req.user.full_name,
      username: req.user.username,
      role: req.user.role,
      status: req.user.status,
      division_name: divisionName,
      divisionName
    },
    expires_at: req.webSession?.expiresAt || null
  });
});

router.post("/logout", requireWebAuth, requireCsrf, async (req, res) => {
  const sessionToken = getCookieValue(req, SESSION_COOKIE_NAME);
  try {
    await webSessionService.revokeSession(sessionToken);
    clearSessionCookies(res);
    return res.json({
      success: true,
      message: "Web Admin logout successful."
    });
  } catch (error) {
    clearSessionCookies(res);
    return sendSessionStoreError(res, error, "Session revocation");
  }
});

router.post(
  "/create-user",
  requireWebAuth,
  requireWebRole("super_admin"),
  requireCsrf,
  (req, res) => {
    const {
      fullName,
      username,
      password,
      role,
      divisionName,
      status
    } = req.body;

    if (!fullName || !username || !password || !role) {
      return res.status(400).json({
        success: false,
        message: "Full name, username, password, and role are required."
      });
    }

    const allowedRoles = ["division_admin", "personnel"];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Invalid role. Super admin can only create division_admin or personnel."
      });
    }

    const checkSql = `
      SELECT id
      FROM web_users
      WHERE LOWER(TRIM(username)) = LOWER(TRIM(?))
      LIMIT 1
    `;

    db.query(checkSql, [username], async (checkError, checkResults) => {
      if (checkError) {
        console.warn("[WebAuth] Username check failed:", checkError.code || "DB_ERROR");
        return res.status(500).json({
          success: false,
          message: "Server error while checking username."
        });
      }

      if (checkResults.length > 0) {
        return res.status(409).json({
          success: false,
          message: "Username already exists."
        });
      }

      try {
        const passwordHash = await bcrypt.hash(String(password).trim(), 10);
        const insertSql = `
          INSERT INTO web_users (
            full_name,
            username,
            password,
            role,
            division_name,
            status,
            created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        const values = [
          String(fullName).trim(),
          String(username).trim(),
          passwordHash,
          String(role).trim(),
          divisionName ? String(divisionName).trim() : null,
          status ? String(status).trim() : "active",
          req.user.id
        ];

        db.query(insertSql, values, (insertError, result) => {
          if (insertError) {
            console.warn("[WebAuth] Web user creation failed:", insertError.code || "DB_ERROR");
            return res.status(500).json({
              success: false,
              message: "Failed to create web user."
            });
          }

          return res.status(201).json({
            success: true,
            message: "Web user created successfully.",
            user: {
              id: result.insertId,
              fullName: values[0],
              username: values[1],
              role: values[3],
              divisionName: values[4],
              status: values[5]
            }
          });
        });
      } catch (hashError) {
        console.warn("[WebAuth] Web user password hashing failed.");
        return res.status(500).json({
          success: false,
          message: "Failed to create web user."
        });
      }
    });
  }
);

module.exports = router;
