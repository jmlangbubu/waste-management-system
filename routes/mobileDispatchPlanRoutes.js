const express = require("express");
const mobileDispatchPlanController = require(
  "../controllers/mobileDispatchPlanController"
);
const { requireMobileSession } = require("../middleware/mobileSessionAuth");

const router = express.Router();

router.use(requireMobileSession);
router.get("/assignments", mobileDispatchPlanController.listAssignments);
router.post("/:planId/activate", mobileDispatchPlanController.activatePlan);

module.exports = router;
