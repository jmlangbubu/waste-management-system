"use strict";

// Account IDs are configuration, never client-supplied authorization. An empty
// or malformed list denies every account; no production account is a default.
function allowedAccountIds(env = process.env) {
  const raw = env.WMO_CLASSIFY_OBJECT_PROPOSALS_ALLOWED_USER_IDS;
  if (typeof raw !== "string" || !raw.trim() || raw.length > 2048) return new Set();
  const ids = raw.split(",").map(value => value.trim());
  if (ids.length > 100 || ids.some(id => !/^[1-9]\d*$/.test(id)
      || !Number.isSafeInteger(Number(id)))) return new Set();
  return new Set(ids);
}

function isAllowedProposalSession(session, env = process.env) {
  // This argument is supplied by server session authentication, never req.body.
  const userId = session?.user?.id;
  if (!Number.isSafeInteger(Number(session?.id)) || Number(session.id) <= 0
      || !["number", "string"].includes(typeof userId)
      || !/^[1-9]\d*$/.test(String(userId)) || !Number.isSafeInteger(Number(userId))) return false;
  return allowedAccountIds(env).has(String(userId));
}

module.exports = { allowedAccountIds, isAllowedProposalSession };
