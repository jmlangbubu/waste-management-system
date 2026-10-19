"use strict";

const express = require("express");
const bcrypt = require("bcrypt");
const db = require("../config/db");
const { createPasswordResetRecoveryService } = require("../services/passwordResetRecoveryService");
const { sendPasswordResetEmail } = require("../services/passwordResetEmailService");
const { startPasswordResetOutboxWorker } = require("../services/passwordResetOutboxWorker");

const router = express.Router();
const recovery = createPasswordResetRecoveryService({ db, bcrypt });
// Feature is OFF until migration, secrets, worker, and deployment are approved.
router.use((req, res, next) => {
  if (process.env.PASSWORD_RESET_ENABLED !== "1") {
    return res.status(503).json({ success: false, message: "Password recovery is temporarily unavailable. Please try again later." });
  }
  next();
});
router.post("/forgot-password", recovery.forgotHandler);
router.post("/verify-reset-code", recovery.verifyHandler);
router.post("/reset-password", recovery.resetHandler);

// Opt-in only. Off by default and must stay off until schema/env/review gates pass.
// No new server.js or authRoutes.js edits needed (minimal registration already exists).
if (process.env.PASSWORD_RESET_ENABLED === "1" && process.env.PASSWORD_RESET_OUTBOX_WORKER_ENABLED === "1") {
  startPasswordResetOutboxWorker({ db, sendPasswordResetEmail });
}

module.exports = router;
