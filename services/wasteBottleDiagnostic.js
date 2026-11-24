"use strict";

// Diagnostic only. NEVER copy arbitrary provider strings, request bodies, tokens,
// user information, or item IDs to telemetry. This module does not classify waste.
const { AsyncLocalStorage } = require("node:async_hooks");

const SOURCES = new Set([
  "cloud_run_gemini_vision", "google_vision_object_localization",
  "gemini_whole_image", "gemini_vision", "local_mapper_fallback",
  "fallback_no_ai_result"
]);
const CATEGORIES = new Set(["Unknown", "Recyclable", "Residual", "Biodegradable", "Special Waste"]);
const ASSESSMENT_SOURCES = new Set([
  "reviewed_identity_rule", "existing_category", "insufficient_evidence", "ai_assisted"
]);
const AI_STATUSES = new Set(["not_requested", "complete", "unavailable"]);
// Only a known household descriptor may be emitted literally. Others are REDACTED.
// All tokens must be on this bounded allowlist, not just contain "bottle".
const IDENTITY_WORDS = new Set((
  "bottle bottles plastic pet hdpe water drinking beverage soda empty clean dry " +
  "clear transparent glass metal full filled contaminated dirty with a cap screw " +
  "spray nozzle chemical cosmetic reusable jar container can item object paper " +
  "sheet of cardboard snack sachet packet wrapper unopened sealed discarded " +
  "food packaging unknown beverage" ).split(" "));
const MAX_ITEMS = 8;
function validOwnerId(value) {
  return typeof value === "string" && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
}
function identity(value) {
  if (typeof value !== "string" || !value.trim()) return "unavailable";
  if (value.length > 120 || /[\x00-\x1f\x7f]/.test(value)) return "redacted";
  const trimmed = value.trim(), words = trimmed.toLowerCase().split(/\s+/);
  return words.length <= 12 && words.every(word => IDENTITY_WORDS.has(word)) ? trimmed : "redacted";
}
function boundedNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value : null;
}
function box(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // Handle only the existing normalized geometry shape; never serialize arbitrary metadata.
  const result = {};
  for (const key of ["left", "top", "right", "bottom"]) {
    const n = boundedNumber(value[key]);
    if (n === null) return null;
    result[key] = n;
  }
  return result.left < result.right && result.top < result.bottom ? result : null;
}
function category(value) { return CATEGORIES.has(value) ? value : null; }
function source(value) { return SOURCES.has(value) ? value : "unrecognized_source"; }
// Match normalizeDetectedItems exactly: a truthy itemName wins over name,
// even if that selected value is malformed. Aliases never fill missing evidence.
function selectedIdentity(obj, final = false) {
  const field = final && obj.originalItemName ? "originalItemName"
    : obj.itemName ? "itemName" : Object.hasOwn(obj, "name") ? "name" : null;
  return { identityField: field, identity: identity(field ? obj[field] : undefined) };
}
function safeItem(item, stage = "normalized", providerSource = null) {
  const obj = item && typeof item === "object" && !Array.isArray(item) ? item : {};
  const raw = stage === "preNormalization", provided = Object.hasOwn(obj, "category");
  const originalCategory = provided ? category(obj.category) : null;
  return {
    ...selectedIdentity(obj, stage === "final"),
    source: source(providerSource === null ? obj.analysisSource : providerSource),
    category: originalCategory,
    categoryProvided: raw ? provided : null,
    explicitUnknown: raw && originalCategory !== null ? originalCategory === "Unknown" : null,
    confidence: boundedNumber(obj.confidence ?? obj.score), boundingBox: box(obj.boundingBox),
    ...(raw ? { providerItemName: identity(obj.itemName), providerName: identity(obj.name),
      providerObservedIdentity: identity(obj.observedIdentity), providerOriginalItemName: identity(obj.originalItemName) } : {})
  };
}
function clipped(items, stage, providerSource) { return Array.isArray(items) ? items.slice(0, MAX_ITEMS).map(item => safeItem(item, stage, providerSource)) : []; }
function environment() { return typeof process === "undefined" ? {} : process?.env || {}; }
function positiveId(value) {
  return ["string", "number"].includes(typeof value) && /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
}
function principal(req) {
  const user = req?.mobileUser, session = req?.mobileSession;
  if (!positiveId(user?.id) || !positiveId(session?.id) || user.status !== "active"
      || !(typeof session.expiresAt === "string" || session.expiresAt instanceof Date)) return null;
  const expiresAt = new Date(session.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
    ? { userId: String(user.id), sessionId: String(session.id), expiresAt } : null;
}

function createDiagnostic({ env = environment(), logger = console.info } = {}) {
  const store = new AsyncLocalStorage(), verifiedRequests = new WeakMap();
  let claimed = false;
  const enabled = () => env?.WMO_BOTTLE_DIAGNOSTIC_ENABLED === "true" && validOwnerId(env?.WMO_BOTTLE_DIAGNOSTIC_ALLOWED_USER_ID);
  // Server-only handoff, called exclusively in the success callback of the
  // existing trusted mobile-session middleware. Headers/body/principal fields
  // alone cannot create this request-bound marker. No auth or DB dependency.
  function rememberVerifiedRequest(req) {
    if (!enabled() || claimed) return false;
    const verified = principal(req);
    if (!verified || verified.userId !== env.WMO_BOTTLE_DIAGNOSTIC_ALLOWED_USER_ID) return false;
    verifiedRequests.set(req, verified);
    return true;
  }
  function middleware(req, _res, next) {
    if (!enabled() || claimed || !req?.body || typeof req.body.image !== "string" || !req.body.image.trim()) return next();
    const verified = verifiedRequests.get(req), current = principal(req);
    verifiedRequests.delete(req);
    if (!verified || !current || verified.userId !== current.userId || verified.sessionId !== current.sessionId
        || verified.expiresAt !== current.expiresAt || current.userId !== env.WMO_BOTTLE_DIAGNOSTIC_ALLOWED_USER_ID) return next();
    claimed = true; // One attempted authenticated scan PER PROCESS, even under concurrency.
    return store.run({ schema: "wmo-bottle-diagnostic-v1", classifierPrimary: null,
      preNormalization: [], normalized: [], final: null }, () => next());
  }
  function recordPrimary(providerSource, providerResult) {
    const trace = store.getStore();
    if (!trace || trace.classifierPrimary) return;
    const obj = providerResult && typeof providerResult === "object" && !Array.isArray(providerResult) ? providerResult : {};
    trace.classifierPrimary = {
      identityField: obj.itemName ? "itemName" : Object.hasOwn(obj, "detectedObject") ? "detectedObject" : null,
      identity: identity(obj.itemName || obj.detectedObject), source: source(providerSource),
      category: Object.hasOwn(obj, "category") ? category(obj.category) : null, categoryProvided: Object.hasOwn(obj, "category"),
      explicitUnknown: Object.hasOwn(obj, "category") && category(obj.category) !== null ? obj.category === "Unknown" : null,
      confidence: boundedNumber(obj.confidence)
    };
  }
  function recordItems(stage, providerSource, objects) {
    const trace = store.getStore();
    if (!trace || !["preNormalization", "normalized"].includes(stage) || trace[stage].length >= 2) return;
    trace[stage].push({ source: source(providerSource), items: clipped(objects, stage, providerSource) });
  }
  function finish(result) {
    const trace = store.getStore();
    if (!trace || trace.final) return;
    const response = result && typeof result === "object" && !Array.isArray(result) ? result : {};
    const sidecar = response.categoryAssessments;
    const rows = Array.isArray(sidecar?.items) ? sidecar.items : [];
    const output = (Array.isArray(response.detectedItems) ? response.detectedItems : []).slice(0, MAX_ITEMS).map(item => {
      const base = safeItem(item, "final");
      // The itemId is used only for a request-local join; never exported.
      const matches = rows.filter(row => row && row.itemId === item?.itemId);
      const match = matches.length === 1 ? matches[0] : null;
      return {
        ...base, observedIdentity: identity(item?.observedIdentity),
        originalItemName: identity(item?.originalItemName),
        assessmentCategory: match ? category(match.category) : null,
        assessmentSource: match && ASSESSMENT_SOURCES.has(match.assessmentSource) ? match.assessmentSource : null,
        proposedDisplayCategory: match ? category(match.category) : base.category
      };
    });
    trace.final = {
      primaryCategory: category(response.category), primarySource: source(response.analysisSource),
      aiStatus: AI_STATUSES.has(sidecar?.aiStatus) ? sidecar.aiStatus : null,
      items: output
    };
    try { logger("[WmoBottleDiagnostic] " + JSON.stringify(trace)); } catch (_) { /* Never affect the scan. */ }
  }
  return { rememberVerifiedRequest, middleware, recordPrimary, recordItems, finish };
}

module.exports = { ...createDiagnostic(), createDiagnostic };
