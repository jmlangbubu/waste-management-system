"use strict";

// Sends recovery emails through existing WMO Resend or SMTP configuration.
// The outbox owns retries and encrypted payloads; this sender never logs an OTP.
const clean = value => String(value || "").trim();

async function sendPasswordResetEmail(email, code) {
  const subject = "WMO Password Reset Code";
  const text = [
    "Waste Management Office – General Santos City", "",
    "A password reset was requested for your WMO account.",
    `Your verification code is: ${code}`,
    "This code is valid for 10 minutes after the email is accepted by our mail provider.",
    "If you did not request a password reset, you can ignore this email.",
    "Never share your code with anyone."
  ].join("\n");

  const resendKey = clean(process.env.RESEND_API_KEY || process.env.RESEND_KEY);
  if (resendKey) {
    const from = clean(process.env.RESEND_FROM);
    if (!from) throw Object.assign(new Error("Resend sender not configured"), { code: "RESET_RESEND_SENDER_MISSING" });
    let Resend;
    try { ({ Resend } = require("resend")); }
    catch (_) { throw Object.assign(new Error("Resend dependency unavailable"), { code: "RESET_RESEND_DEPENDENCY_MISSING" }); }
    const result = await new Resend(resendKey).emails.send({ from, to: [email], subject, text });
    if (result?.error || !(result?.data?.id || result?.id)) {
      throw Object.assign(new Error("Reset email not accepted"), { code: "RESET_RESEND_NOT_ACCEPTED" });
    }
    return;
  }

  const from = clean(process.env.SMTP_FROM);
  const user = clean(process.env.SMTP_USER || process.env.EMAIL_USER);
  const pass = clean(process.env.SMTP_PASS || process.env.EMAIL_PASS);
  if (!from || !user || !pass) throw Object.assign(new Error("SMTP sender not configured"), { code: "RESET_SMTP_NOT_CONFIGURED" });
  let nodemailer;
  try { nodemailer = require("nodemailer"); }
  catch (_) { throw Object.assign(new Error("SMTP dependency unavailable"), { code: "RESET_SMTP_DEPENDENCY_MISSING" }); }
  const options = { auth: { user, pass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 15000 };
  const host = clean(process.env.SMTP_HOST);
  const transporter = host
    ? nodemailer.createTransport({ ...options, host, port: Number(process.env.SMTP_PORT || 465), secure: clean(process.env.SMTP_SECURE || "true").toLowerCase() !== "false" })
    : nodemailer.createTransport({ ...options, service: "gmail" });
  await transporter.sendMail({ from, to: email, subject, text });
}

module.exports = { sendPasswordResetEmail };
