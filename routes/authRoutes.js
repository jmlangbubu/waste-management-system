const express = require('express');
const router = express.Router();
const db = require('../config/db');
const bcrypt = require('bcrypt');

console.log("✅ authRoutes.js file executed");

router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Auth route is working'
  });
});

router.post('/register', async (req, res) => {
  const full_name = req.body ? req.body.full_name : null;
  const username = req.body ? req.body.username : null;
  const password = req.body ? req.body.password : null;
  const barangay = req.body ? req.body.barangay : null;

  if (!full_name || !username || !password || !barangay) {
    return res.status(400).json({
      success: false,
      message: 'Full name, username, password, and barangay are required'
    });
  }

  const checkUserSql = 'SELECT id FROM users WHERE username = ? LIMIT 1';

  db.query(checkUserSql, [username], async (checkErr, checkResults) => {
    if (checkErr) {
      return res.status(500).json({
        success: false,
        message: 'Database error while checking username',
        error: checkErr.message
      });
    }

    if (checkResults.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Username already exists'
      });
    }

    try {
      const hashedPassword = await bcrypt.hash(password, 10);

      const insertSql = `
        INSERT INTO users (full_name, username, password, role, barangay, status)
        VALUES (?, ?, ?, 'citizen', ?, 'active')
      `;

      db.query(insertSql, [full_name, username, hashedPassword, barangay], (insertErr, insertResult) => {
        if (insertErr) {
          return res.status(500).json({
            success: false,
            message: 'Database error while creating account',
            error: insertErr.message
          });
        }

        return res.status(201).json({
          success: true,
          message: 'Citizen account created successfully',
          user: {
            id: insertResult.insertId,
            full_name,
            username,
            role: 'citizen',
            barangay: barangay || ""
          }
        });
      });
    } catch (hashErr) {
      return res.status(500).json({
        success: false,
        message: 'Password hashing failed',
        error: hashErr.message
      });
    }
  });
});

router.post('/login', (req, res) => {
  console.log("==== LOGIN REQUEST START ====");
  console.log("headers content-type:", req.headers["content-type"]);
  console.log("req.body:", req.body);

  const username = req.body ? req.body.username : null;
  const password = req.body ? req.body.password : null;

  console.log("username:", username);
  console.log("password exists:", !!password);

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: 'Username and password are required',
      debug: {
        receivedUsername: username || null,
        receivedPassword: !!password
      }
    });
  }

  const sql = `
    SELECT
      id,
      full_name,
      username,
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
        message: 'Database error',
        error: err.message
      });
    }

    if (results.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password'
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
        message: 'Account role is missing. Please contact the administrator.'
      });
    }

    if (resolvedStatus === "suspended") {
      return res.status(403).json({
        success: false,
        message: 'This account is suspended.'
      });
    }

    if (resolvedStatus === "inactive") {
      return res.status(403).json({
        success: false,
        message: 'This account is inactive.'
      });
    }

    try {
      const isMatch = await bcrypt.compare(password, user.password);

      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: 'Invalid username or password'
        });
      }

      const responseUser = {
        id: user.id,
        full_name: user.full_name,
        username: user.username,
        role: resolvedRole,
        barangay: resolvedBarangay
      };

      console.log("LOGIN RESPONSE USER:", responseUser);

      return res.status(200).json({
        success: true,
        message: 'Login successful',
        user: responseUser
      });
    } catch (compareErr) {
      return res.status(500).json({
        success: false,
        message: 'Password verification failed',
        error: compareErr.message
      });
    }
  });
});

module.exports = router;