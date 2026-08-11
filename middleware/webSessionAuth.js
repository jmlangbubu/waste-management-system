const crypto = require("crypto");
const webSessionService = require("../services/webSessionService");
const {
  hashOpaqueToken,
  normalizeWebRole
} = require("../services/webSessionService");

const SESSION_COOKIE_NAME = "wmo_admin_session";
const CSRF_COOKIE_NAME = "wmo_admin_csrf";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function getCookieValue(req, name) {
  const cookieHeader = String(req?.headers?.cookie || "");
  for (const part of cookieHeader.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex < 0) continue;
    const key = part.slice(0, separatorIndex).trim();
    if (key !== name) continue;
    const value = part.slice(separatorIndex + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch (error) {
      return "";
    }
  }
  return "";
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (options.httpOnly) parts.push("HttpOnly");
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  if (Number.isFinite(options.maxAge)) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.expires instanceof Date) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  return parts.join("; ");
}

function appendCookie(res, value) {
  if (typeof res.append === "function") {
    res.append("Set-Cookie", value);
    return;
  }
  const existing = res.getHeader?.("Set-Cookie");
  const values = existing
    ? Array.isArray(existing) ? existing : [existing]
    : [];
  res.setHeader("Set-Cookie", [...values, value]);
}

function setSessionCookies(res, session) {
  appendCookie(
    res,
    serializeCookie(SESSION_COOKIE_NAME, session.sessionToken, {
      httpOnly: true,
      maxAge: session.ttlSeconds,
      expires: session.expiresAt
    })
  );
  appendCookie(
    res,
    serializeCookie(CSRF_COOKIE_NAME, session.csrfToken, {
      httpOnly: false,
      maxAge: session.ttlSeconds,
      expires: session.expiresAt
    })
  );
}

function clearSessionCookies(res) {
  const expired = new Date(0);
  appendCookie(
    res,
    serializeCookie(SESSION_COOKIE_NAME, "", {
      httpOnly: true,
      maxAge: 0,
      expires: expired
    })
  );
  appendCookie(
    res,
    serializeCookie(CSRF_COOKIE_NAME, "", {
      httpOnly: false,
      maxAge: 0,
      expires: expired
    })
  );
}

function sendAuthError(res, statusCode, message, code) {
  return res.status(statusCode).json({
    success: false,
    message,
    code
  });
}

function buildRequireWebAuth(service = webSessionService) {
  return async function requireWebAuthMiddleware(req, res, next) {
    const sessionToken = getCookieValue(req, SESSION_COOKIE_NAME);
    try {
      const session = await service.validateSession(sessionToken);
      req.user = session.user;
      req.webSession = {
        id: session.id,
        csrfTokenHash: session.csrfTokenHash,
        expiresAt: session.expiresAt,
        divisionName: session.divisionName
      };
      return next();
    } catch (error) {
      const statusCode = Number(error.statusCode) || 503;
      const code = error.code || "WEB_SESSION_STORE_UNAVAILABLE";
      if (statusCode >= 500) {
        console.warn(
          "[WebAuth] Session validation unavailable:",
          error.cause?.code || error.code || "UNKNOWN_SESSION_ERROR"
        );
      }
      return sendAuthError(
        res,
        statusCode,
        statusCode === 503
          ? "Web Admin authentication is temporarily unavailable."
          : error.message || "Web Admin authentication is required.",
        code
      );
    }
  };
}

function requireWebRole(...roles) {
  const allowedRoles = new Set(roles.flat().map(normalizeWebRole).filter(Boolean));
  return function requireWebRoleMiddleware(req, res, next) {
    if (!req.user) {
      return sendAuthError(
        res,
        401,
        "Web Admin authentication is required.",
        "WEB_SESSION_REQUIRED"
      );
    }
    if (!allowedRoles.has(normalizeWebRole(req.user.role))) {
      return sendAuthError(
        res,
        403,
        "This Web Admin account is not authorized for this operation.",
        "WEB_ROLE_FORBIDDEN"
      );
    }
    return next();
  };
}

function requireCsrf(req, res, next) {
  if (SAFE_METHODS.has(String(req.method || "").toUpperCase())) return next();
  if (!req.user || !req.webSession?.csrfTokenHash) {
    return sendAuthError(
      res,
      401,
      "Web Admin authentication is required.",
      "WEB_SESSION_REQUIRED"
    );
  }

  const headerValue = Array.isArray(req.headers?.["x-csrf-token"])
    ? req.headers["x-csrf-token"][0]
    : req.headers?.["x-csrf-token"];
  const cookieValue = getCookieValue(req, CSRF_COOKIE_NAME);
  const headerMatchesCookie =
    Boolean(headerValue && cookieValue) && constantTimeEqual(headerValue, cookieValue);
  const hashMatchesSession =
    Boolean(cookieValue) &&
    constantTimeEqual(hashOpaqueToken(cookieValue), req.webSession.csrfTokenHash);

  if (!headerMatchesCookie || !hashMatchesSession) {
    return sendAuthError(
      res,
      403,
      "The Web Admin request could not be verified.",
      "WEB_CSRF_INVALID"
    );
  }
  return next();
}

const requireWebAuth = buildRequireWebAuth();

module.exports = {
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  getCookieValue,
  serializeCookie,
  setSessionCookies,
  clearSessionCookies,
  buildRequireWebAuth,
  requireWebAuth,
  requireWebRole,
  requireCsrf
};
