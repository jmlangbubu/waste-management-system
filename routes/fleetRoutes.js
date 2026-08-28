const express = require("express");
const fleetController = require("../controllers/fleetController");
const {
  requireWebAuth,
  requireWebRole,
  requireCsrf
} = require("../middleware/webSessionAuth");

const router = express.Router();

router.use(requireWebAuth);
router.use(requireWebRole("super_admin", "personnel"));
router.use(requireCsrf);

router.get("/trucks", fleetController.listTrucks);
router.get("/summary", fleetController.getSummary);
router.post("/trucks", fleetController.createTruck);
router.patch("/trucks/:id/condition", fleetController.updateCondition);

module.exports = router;
