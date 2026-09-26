const express = require("express");
const vehicleIssueController = require("../controllers/vehicleIssueController");
const { requireMobileSession } = require("../middleware/mobileSessionAuth");
const {
  requireWebAuth,
  requireWebRole,
  requireCsrf
} = require("../middleware/webSessionAuth");
const {
  vehicleIssueImageUpload
} = require("../middleware/vehicleIssueUpload");

const router = express.Router();

// Mobile routes must remain ahead of the generic /:id Web routes.
router.get(
  "/mobile/assistant-schema",
  requireMobileSession,
  vehicleIssueController.getAssistantSchema
);
router.post(
  "/mobile",
  requireMobileSession,
  vehicleIssueImageUpload,
  vehicleIssueController.createReport
);

router.use(requireWebAuth);
router.use(requireWebRole("super_admin", "personnel"));
router.use(requireCsrf);

router.get("/", vehicleIssueController.listReports);
router.get("/:id", vehicleIssueController.getReport);
router.patch("/:id/review", vehicleIssueController.reviewReport);
router.post("/:id/resolve", vehicleIssueController.resolveReport);

module.exports = router;
