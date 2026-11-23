"use strict";

const mobileSessionService = require("../services/mobileSessionService");
const { readBearerToken, sendMobileAuthError } = require("./mobileSessionAuth");
const { allowedAccountIds, isAllowedProposalSession } = require("../config/objectProposalCanary");

function buildResolveObjectProposalSession(service = mobileSessionService, env = process.env) {
  return async function resolveObjectProposalSession(req, res, next) {
    req.objectProposalSession = undefined;
    if (env.WMO_CLASSIFY_OBJECT_PROPOSALS_ENABLED !== "true"
        || env.WHOLE_IMAGE_DISCOVERY_ENABLED === "true"
        || req.headers?.["x-wmo-scan-capability"] !== "waste-scan-independent-category-v2"
        || allowedAccountIds(env).size === 0) return next();
    const bearer = readBearerToken(req);
    // Missing/invalid/expired sessions cannot opt in. Legacy scanning retains
    // its existing authentication contract for non-canary clients.
    if (!bearer.token) return next();
    try {
      const session = await service.authenticateMobileSession(bearer.token);
      if (isAllowedProposalSession(session, env)) req.objectProposalSession = session;
    } catch (error) {
      if (![401, 403].includes(Number(error.statusCode))) {
        return sendMobileAuthError(res, 503, "Mobile authentication is temporarily unavailable.",
          "MOBILE_SESSION_STORE_UNAVAILABLE");
      }
    }
    return next();
  };
}

module.exports = { buildResolveObjectProposalSession,
  resolveObjectProposalSession: buildResolveObjectProposalSession() };
