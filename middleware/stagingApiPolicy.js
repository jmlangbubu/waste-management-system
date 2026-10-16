"use strict";

// Mounted before all parsers, CORS, routers and static handlers in reduced staging only.
const ROUTES = new Set([
  "GET /health",
  "POST /api/auth/login",
  "GET /api/auth/mobile/me",
  "POST /api/auth/mobile/logout",
  "POST /api/waste/analyze",
  "POST /api/waste/recognize-crops"
]);
const NOT_FOUND = Object.freeze({ success: false, message: "Not found" });
function allowedRequest(method, target) {
  if (typeof target !== "string" || target.length > 8192 || /[\\\\\x00-\x20\x7f#]/.test(target)) return false;
  const question = target.indexOf("?");
  const pathname = question < 0 ? target : target.slice(0, question);
  // Reject alternate encodings rather than relying on Express/URL normalization.
  if (!/^\/[A-Za-z0-9/-]+$/.test(pathname) || pathname.includes("//") || pathname.endsWith("/")) return false;
  if (question >= 0) {
    try { decodeURIComponent(target.slice(question + 1)); } catch (_) { return false; }
  }
  return ROUTES.has(method + " " + pathname);
}
function stagingApiPolicy(req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  if (!allowedRequest(req.method, req.originalUrl || req.url))
    return res.status(404).json(NOT_FOUND);
  return next();
}
// Symbol keys cannot be supplied through JSON, query parameters or HTTP headers.
const ANALYSIS_AUTHENTICATED = Symbol.for("wmo.staging.analysisAuthenticated");
function preAuthenticateAnalysis(authenticate) {
  return (req, res, next) => {
    if (req.method !== "POST" || req.path !== "/api/waste/analyze") return next();
    return authenticate(req, res, () => {
      req[ANALYSIS_AUTHENTICATED] = true;
      return next();
    });
  };
}
function denyUpgrade(_req, socket) {
  // No engine or protocol negotiation is available in restricted staging.
  socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}
function stagingError(error, _req, res, next) {
  if (res.headersSent) return next(error);
  const tooLarge = error?.type === "entity.too.large";
  const badRequest = ["entity.parse.failed", "encoding.unsupported", "charset.unsupported",
    "request.aborted", "request.size.invalid"].includes(error?.type);
  const status = tooLarge ? 413 : badRequest ? 400 : 500;
  return res.status(status).json({ success: false,
    code: status === 413 ? "PAYLOAD_TOO_LARGE" : status === 400 ? "INVALID_REQUEST" : "INTERNAL_SERVER_ERROR",
    message: status === 413 ? "Request payload too large." : status === 400 ? "Invalid request." : "Internal server error" });
}
module.exports = { allowedRequest, stagingApiPolicy, preAuthenticateAnalysis, denyUpgrade, stagingError };
