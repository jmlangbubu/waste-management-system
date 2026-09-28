const express = require("express");
const { createCitizenAssistantService, CitizenAssistantError } = require("../services/citizenAssistantService");

function createCitizenAssistantRouter({
  assistantService = createCitizenAssistantService(),
  authenticate = require("../middleware/mobileSessionAuth").requireMobileSession
} = {}) {
  const router = express.Router();
  router.use(authenticate);
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.post("/ask", async (req, res) => {
    const { message, userId } = req.body || {};
    if (typeof message !== "string" || !message.trim() || message.length > 2000) {
      return res.status(400).json({ success: false, message: "A non-empty message is required (maximum 2000 characters)." });
    }
    const validIdType = (typeof userId === "number" && Number.isSafeInteger(userId))
      || (typeof userId === "string" && /^\d+$/.test(userId.trim()));
    const id = validIdType ? Number(userId) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "A valid user ID is required." });
    }
    if (!req.mobileUser || Number(req.mobileUser.id) !== id) {
      return res.status(403).json({ success: false, message: "User ID does not match the authenticated session." });
    }

    try {
      const response = await assistantService.ask({ message: message.trim(), userId: id });
      return res.status(200).json(response);
    } catch (error) {
      if (error instanceof CitizenAssistantError) {
        return res.status(error.statusCode).json({ success: false, message: error.message, code: error.code });
      }
      console.warn("[Citizen Assistant] Request failed:", error.code || "UNKNOWN_ERROR");
      return res.status(500).json({ success: false, message: "Citizen Assistant is temporarily unavailable." });
    }
  });
  return router;
}

module.exports = { createCitizenAssistantRouter };
