const express = require("express");
const dispatchPlanController = require("../controllers/dispatchPlanController");
const {
  requireWebAuth,
  requireWebRole,
  requireCsrf
} = require("../middleware/webSessionAuth");

const router = express.Router();

router.use(requireWebAuth);
router.use(requireWebRole("super_admin", "personnel"));
router.use(requireCsrf);

router.get("/options", dispatchPlanController.getPlanningOptions);
router.get("/", dispatchPlanController.listPlans);
router.post("/", dispatchPlanController.createPlan);
router.get("/:id", dispatchPlanController.getPlan);
router.patch("/:id", dispatchPlanController.updatePlan);
router.post("/:id/cancel", dispatchPlanController.cancelPlan);

module.exports = router;
