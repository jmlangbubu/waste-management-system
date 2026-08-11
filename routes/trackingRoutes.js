const express = require("express");
const router = express.Router();
const trackingController = require("../controllers/trackingController");
const {
  requireWebAuth,
  requireWebRole
} = require("../middleware/webSessionAuth");

const requireTrackingWebRead = [
  requireWebAuth,
  requireWebRole("super_admin", "personnel")
];

// Start a new tracking session
router.post("/start", trackingController.startTrackingSession);

// Stop an existing tracking session
router.post("/:sessionId/stop", trackingController.stopTrackingSession);

// Receive GPS location for an active session
router.post("/:sessionId/location", trackingController.addLocationLog);

// Receive offline/mobile queued GPS locations in one request
router.post("/:sessionId/locations/batch", trackingController.addLocationLogsBatch);

// Receive mobile GPS/device status such as active, sync_pending, or gps_off
router.post("/:sessionId/status", trackingController.updateTrackingDeviceStatus);

// Dashboard: get all active trucks
router.get("/active", ...requireTrackingWebRead, trackingController.getActiveTrucks);

// Dashboard: get route history by session
router.get(
  "/route/:sessionId",
  ...requireTrackingWebRead,
  trackingController.getRouteHistoryBySession
);

// Latest session by truck
router.get("/truck/:truckId/latest-session", trackingController.getTruckLatestSession);

/* ================================
   TRACKING REPORTS
================================ */

// Admin report list
router.get("/reports", ...requireTrackingWebRead, trackingController.getTrackingReports);

// Admin report detail
router.get(
  "/reports/:sessionId",
  ...requireTrackingWebRead,
  trackingController.getTrackingReportDetails
);

module.exports = router;
