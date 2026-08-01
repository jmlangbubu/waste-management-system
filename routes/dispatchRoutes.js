const express = require("express");
const dispatchController = require("../controllers/dispatchController");

const router = express.Router();

router.get("/destinations", dispatchController.listDestinations);
router.get("/destinations/:id", dispatchController.getDestination);
router.post("/tickets", dispatchController.createTicket);
router.get("/tickets", dispatchController.listTickets);
router.get("/live", dispatchController.getLiveDispatches);
router.get("/tracking-sessions/:sessionId", dispatchController.getByTrackingSession);
router.get("/reports", dispatchController.getReports);
router.get("/tickets/:id/events", dispatchController.getEvents);
router.post(
  "/tickets/:id/stops/:stopId/arrive",
  dispatchController.arriveAtStop
);
router.post(
  "/tickets/:id/stops/:stopId/complete",
  dispatchController.completeStop
);
router.post(
  "/tickets/:id/stops/:stopId/skip",
  dispatchController.skipStop
);
router.post("/tickets/:id/issue", dispatchController.issueTicket);
router.post("/tickets/:id/cancel", dispatchController.cancelTicket);
router.post("/tickets/:id/link-session", dispatchController.linkSession);
router.post(
  "/tickets/:id/link-active-session",
  dispatchController.linkActiveSession
);
router.post("/tickets/:id/returning", dispatchController.markReturning);
router.get("/tickets/:id", dispatchController.getTicket);
router.patch("/tickets/:id", dispatchController.updateTicket);

module.exports = router;
