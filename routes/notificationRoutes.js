const express = require("express");
const router = express.Router();

const notificationController = require("../controllers/notificationController");

/*
  Existing WMO/web notification routes are preserved.
  Citizen routes are added separately so mobile notifications do not affect
  the current global notifications table.
*/

/* =========================
   CITIZEN NOTIFICATIONS
========================= */

// GET CITIZEN NOTIFICATIONS
// Example:
// /api/notifications/citizen?user_id=5&email=user@gmail.com&barangay=Bula
router.get("/citizen", notificationController.getCitizenNotifications);

// OPTIONAL: CREATE CITIZEN NOTIFICATION
// Used for testing or internal backend modules.
router.post("/citizen", notificationController.createCitizenNotification);

// MARK ALL CITIZEN NOTIFICATIONS AS READ
router.patch("/citizen/read-all", notificationController.markAllCitizenNotificationsRead);

// MARK ONE CITIZEN NOTIFICATION AS READ
router.patch("/citizen/:id/read", notificationController.markCitizenNotificationRead);

/* =========================
   EXISTING WMO/WEB NOTIFICATIONS
========================= */

// GET ALL
router.get("/", notificationController.getNotifications);

// DELETE SINGLE
router.delete("/:id", notificationController.deleteNotification);

// CLEAR ALL
router.delete("/", notificationController.clearAllNotifications);

module.exports = router;
