require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();

/* ROUTES */
const wasteRoutes = require("../routes/wasteRoutes");
const authRoutes = require("../routes/authRoutes");
const webAuthRoutes = require("../routes/webAuthRoutes");
const webUserRoutes = require("../routes/webUserRoutes");
const appointmentRoutes = require("../routes/appointmentRoutes");
const trackingRoutes = require("../routes/trackingRoutes");
const notificationRoutes = require("../routes/notificationRoutes");
const complaintRoutes = require("../routes/complaintRoutes");
const invoiceRoutes = require("../routes/invoiceRoutes");

/* =========================
   PATHS
========================= */
const ROOT_DIR = path.join(__dirname, "..");
const FRONTEND_DIR = path.join(ROOT_DIR, "frontend");
const UPLOADS_DIR = path.join(ROOT_DIR, "uploads");
const COMPLAINT_UPLOADS_DIR = path.join(UPLOADS_DIR, "complaints");

/* =========================
   ENSURE UPLOAD FOLDERS EXIST
========================= */
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

if (!fs.existsSync(COMPLAINT_UPLOADS_DIR)) {
  fs.mkdirSync(COMPLAINT_UPLOADS_DIR, { recursive: true });
}

/* =========================
   CORE MIDDLEWARE
========================= */
app.use(cors());

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

/* =========================
   REQUEST LOGGER
========================= */
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

/* =========================
   STATIC FILES
========================= */
app.use(
  "/uploads",
  express.static(UPLOADS_DIR, {
    fallthrough: true,
    setHeaders: (res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
  })
);

app.use(express.static(FRONTEND_DIR));

/* =========================
   BASIC TEST ROUTES
========================= */
app.get("/", (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

app.get("/health", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "Server is healthy"
  });
});

app.get("/api/test", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "API is reachable"
  });
});

/* =========================
   DEBUG UPLOAD CHECK
========================= */
app.get("/api/debug/uploads", (req, res) => {
  let complaintFiles = [];

  try {
    complaintFiles = fs.existsSync(COMPLAINT_UPLOADS_DIR)
      ? fs.readdirSync(COMPLAINT_UPLOADS_DIR)
      : [];
  } catch (error) {
    complaintFiles = [];
  }

  return res.json({
    success: true,
    rootDir: ROOT_DIR,
    frontendDir: FRONTEND_DIR,
    uploadsDir: UPLOADS_DIR,
    complaintUploadsDir: COMPLAINT_UPLOADS_DIR,
    uploadsDirExists: fs.existsSync(UPLOADS_DIR),
    complaintUploadsDirExists: fs.existsSync(COMPLAINT_UPLOADS_DIR),
    complaintFileCount: complaintFiles.length,
    complaintFiles
  });
});

app.get("/api/debug/file-exists", (req, res) => {
  const relativePath = req.query.path;

  if (!relativePath) {
    return res.status(400).json({
      success: false,
      message: "Missing query param: path"
    });
  }

  const safeRelative = String(relativePath)
    .replace(/^\/+/, "")
    .replace(/\.\./g, "");

  const absolutePath = path.join(ROOT_DIR, safeRelative);
  const exists = fs.existsSync(absolutePath);

  return res.json({
    success: true,
    requestedPath: relativePath,
    safeRelative,
    absolutePath,
    exists,
    publicUrl: exists
      ? `/uploads/${path.relative(UPLOADS_DIR, absolutePath).replace(/\\/g, "/")}`
      : null
  });
});

/* =========================
   API ROUTES
========================= */
app.use("/api/auth", authRoutes);
app.use("/api/waste", wasteRoutes);
app.use("/api/web-auth", webAuthRoutes);
app.use("/api/web-users", webUserRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/tracking", trackingRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/complaints", complaintRoutes);
app.use("/api/invoices", invoiceRoutes);

/* =========================
   404 HANDLER
========================= */
app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`
  });
});

/* =========================
   GLOBAL ERROR HANDLER
========================= */
app.use((err, req, res, next) => {
  console.error("=== GLOBAL EXPRESS ERROR ===");
  console.error(err);
  console.error(err.stack);

  return res.status(500).json({
    success: false,
    message: "Internal server error",
    error: err.message
  });
});

/* =========================
   PROCESS-LEVEL ERROR HANDLERS
========================= */
process.on("uncaughtException", (error) => {
  console.error("=== UNCAUGHT EXCEPTION ===");
  console.error(error);
  console.error(error.stack);
});

process.on("unhandledRejection", (reason) => {
  console.error("=== UNHANDLED REJECTION ===");
  console.error(reason);
});

/* =========================
   SERVER START
========================= */
const PORT = process.env.PORT || 8081;
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log("======================================");
  console.log(`Server running on port ${PORT}`);
  console.log(`Server host binding: ${HOST}`);
  console.log(`Local URL: http://localhost:${PORT}`);
  console.log(`Network URL: http://192.168.1.37:${PORT}`);
  console.log("--------------------------------------");
  console.log(`ROOT_DIR: ${ROOT_DIR}`);
  console.log(`FRONTEND_DIR: ${FRONTEND_DIR}`);
  console.log(`UPLOADS_DIR: ${UPLOADS_DIR}`);
  console.log(`COMPLAINT_UPLOADS_DIR: ${COMPLAINT_UPLOADS_DIR}`);
  console.log("--------------------------------------");
  console.log(`FRONTEND_DIR exists: ${fs.existsSync(FRONTEND_DIR)}`);
  console.log(`UPLOADS_DIR exists: ${fs.existsSync(UPLOADS_DIR)}`);
  console.log(`COMPLAINT_UPLOADS_DIR exists: ${fs.existsSync(COMPLAINT_UPLOADS_DIR)}`);
  console.log("======================================");
});
