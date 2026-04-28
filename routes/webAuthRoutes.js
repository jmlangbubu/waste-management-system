const express = require("express");
const router = express.Router();
const db = require("../config/db");

console.log("webAuthRoutes loaded");

router.post("/login", (req, res) => {
  const username = req.body?.username ? String(req.body.username).trim() : "";
  const password = req.body?.password ? String(req.body.password).trim() : "";

  console.log("WEB LOGIN ATTEMPT:", username);

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

  db.query(sql, [username], (err, results) => {
    if (err) {
      console.error("WEB LOGIN DB ERROR:", err);
      return res.status(500).json({
        success: false,
        message: "Server error during web login."
      });
    }

    console.log("WEB LOGIN RESULT COUNT:", results.length);

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

    console.log("WEB LOGIN STATUS:", status);
    console.log("WEB LOGIN PASSWORD MATCH:", dbPassword === inputPassword);

    if (status !== "active") {
      return res.status(403).json({
        success: false,
        message: "This account is inactive."
      });
    }

    if (dbPassword !== inputPassword) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password."
      });
    }

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
  });
});

router.post("/create-user", (req, res) => {
  const {
    fullName,
    username,
    password,
    role,
    divisionName,
    status,
    createdByRole,
    createdById
  } = req.body;

  if (!fullName || !username || !password || !role) {
    return res.status(400).json({
      success: false,
      message: "Full name, username, password, and role are required."
    });
  }

  if (createdByRole !== "super_admin") {
    return res.status(403).json({
      success: false,
      message: "Only super admin can create web accounts."
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

  db.query(checkSql, [username], (checkErr, checkResults) => {
    if (checkErr) {
      console.error("Check username error:", checkErr);
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
      String(password).trim(),
      String(role).trim(),
      divisionName ? String(divisionName).trim() : null,
      status ? String(status).trim() : "active",
      createdById || null
    ];

    db.query(insertSql, values, (insertErr, result) => {
      if (insertErr) {
        console.error("Create web user error:", insertErr);
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
  });
});

module.exports = router;
