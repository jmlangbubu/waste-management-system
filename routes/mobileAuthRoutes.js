const express = require("express");
const mobileSessionService = require("../services/mobileSessionService");
const {
  readBearerToken,
  sendMobileAuthError,
  buildRequireMobileSession
} = require("../middleware/mobileSessionAuth");

function createMobileAuthRouter(service = mobileSessionService) {
  const router = express.Router();
  const requireMobileSession = buildRequireMobileSession(service);

  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    next();
  });

  router.get("/me", requireMobileSession, (req, res) => {
    return res.json({
      success: true,
      user: {
        id: req.mobileUser.id,
        full_name: req.mobileUser.full_name,
        username: req.mobileUser.username,
        role: req.mobileUser.role,
        mobile_role: req.mobileUser.mobile_role,
        status: req.mobileUser.status
      },
      expires_at: req.mobileSession.expiresAt
    });
  });

  router.post("/logout", async (req, res) => {
    const bearer = readBearerToken(req);
    if (!bearer.token) {
      return sendMobileAuthError(
        res,
        401,
        "Mobile authentication is required.",
        bearer.code
      );
    }

    try {
      await service.revokeMobileSession(bearer.token);
      return res.json({
        success: true,
        message: "Mobile session logged out."
      });
    } catch (error) {
      console.warn(
        "[MobileAuth] Session revocation unavailable:",
        error.cause?.code || error.code || "UNKNOWN_SESSION_ERROR"
      );
      return sendMobileAuthError(
        res,
        503,
        "Mobile authentication is temporarily unavailable.",
        "MOBILE_SESSION_STORE_UNAVAILABLE"
      );
    }
  });

  return router;
}

const router = createMobileAuthRouter();

module.exports = router;
module.exports.createMobileAuthRouter = createMobileAuthRouter;
