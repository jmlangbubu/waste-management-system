const mobileSessionService = require("../services/mobileSessionService");
const { isValidOpaqueToken } = require("../services/mobileSessionService");

function readBearerToken(req) {
  const value = req?.headers?.authorization;
  if (typeof value !== "string" || !value.trim()) {
    return { token: "", code: "MOBILE_SESSION_REQUIRED" };
  }

  const match = value.trim().match(/^Bearer\s+([^\s]+)$/i);
  if (!match || !isValidOpaqueToken(match[1])) {
    return { token: "", code: "MOBILE_SESSION_MALFORMED" };
  }

  return { token: match[1], code: "" };
}

function sendMobileAuthError(res, statusCode, message, code) {
  return res.status(statusCode).json({
    success: false,
    message,
    code
  });
}

function buildRequireMobileSession(service = mobileSessionService) {
  return async function requireMobileSessionMiddleware(req, res, next) {
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
      const session = await service.authenticateMobileSession(bearer.token);
      req.mobileUser = session.user;
      req.mobileSession = {
        id: session.id,
        deviceId: session.deviceId,
        expiresAt: session.expiresAt
      };
      return next();
    } catch (error) {
      const statusCode = Number(error.statusCode) || 503;
      const code = error.code || "MOBILE_SESSION_STORE_UNAVAILABLE";
      if (statusCode >= 500) {
        console.warn(
          "[MobileAuth] Session validation unavailable:",
          error.cause?.code || code
        );
      }
      return sendMobileAuthError(
        res,
        statusCode,
        statusCode >= 500
          ? "Mobile authentication is temporarily unavailable."
          : error.message || "Mobile authentication is required.",
        code
      );
    }
  };
}

const requireMobileSession = buildRequireMobileSession();

module.exports = {
  readBearerToken,
  sendMobileAuthError,
  buildRequireMobileSession,
  requireMobileSession
};
