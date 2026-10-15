"use strict";
const contract = require("../gemini-waste-classifier-cloudrun/cropRecognition");
const { matchRecognitionIdentity } = require("../utils/wasteMapper");
function createRecognitionService({ env = process.env, transport = contract.postJson, budget = contract.createBudget(), authHeaders } = {}) {
  let authenticate = authHeaders;
  return async function recognizeCrops(input, { principal, signal, deadlineAt } = {}) {
    if (!principal || !/^[1-9][0-9]*$/.test(String(principal))) throw new contract.RecognitionError("RECOGNITION_UNAUTHORIZED", 401);
    const validated = contract.validateRequest(input);
    if (env.CROP_RECOGNITION_ENABLED !== "true" || typeof env.CROP_RECOGNITION_SHARED_TOKEN !== "string"
        || env.CROP_RECOGNITION_SHARED_TOKEN.length < 32) throw new contract.RecognitionError("RECOGNITION_UNAVAILABLE", 503);
    let url;
    try {
      url = new URL(env.GEMINI_CROP_CLASSIFIER_URL || "recognize-crops",
        env.GEMINI_CLASSIFIER_URL || env.CLOUD_RUN_GEMINI_CLASSIFIER_URL);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    } catch (_) { throw new contract.RecognitionError("RECOGNITION_UNAVAILABLE", 503); }
    if (signal?.aborted) throw new contract.RecognitionError("RECOGNITION_CANCELLED", 499);
    const remaining = deadlineAt === undefined ? contract.LIMITS.deadlineMs : deadlineAt - Date.now();
    if (remaining <= 0) throw new contract.RecognitionError("RECOGNITION_TIMEOUT", 504);
    const release = budget.acquire(String(principal));
    const requestDeadline = Date.now() + Math.min(contract.LIMITS.deadlineMs, remaining);
    try {
      const auth = env.CLOUD_RUN_AUTH_MODE || env.WMO_DEPLOYMENT_MODE === "staging"
        ? await (authenticate ||= require("./cloudRunAuth").createCloudRunAuth({ env }))(url.toString(), { signal, timeoutMs: requestDeadline-Date.now() }) : {};
      if (signal?.aborted || requestDeadline <= Date.now()) throw new contract.RecognitionError("RECOGNITION_TIMEOUT", 504);
      const response = await transport(url.toString(), validated, { signal, timeoutMs: requestDeadline-Date.now(),
        headers: { ...auth, "X-Crop-Recognition-Token": env.CROP_RECOGNITION_SHARED_TOKEN } });
      if (!response || typeof response !== "object" || Object.keys(response).some(key => !["success", "requestId", "regions"].includes(key))
          || response.success !== true || response.requestId !== validated.requestId || !Array.isArray(response.regions))
        throw new contract.RecognitionError("INVALID_PROVIDER_RESPONSE", 502);
      // Revalidate across the service boundary; categories and geometry are never accepted from the remote service.
      const observations = { regions: response.regions.map(region => {
        if (!region || typeof region !== "object" || Array.isArray(region)
            || Object.keys(region).some(key => !["regionId", "status", "identitySource", "observedLabels", "suggestions", "requiresConfirmation", "reason"].includes(key))
            || region.identitySource !== "gemini_crop" || region.requiresConfirmation !== true || !Array.isArray(region.suggestions)
            || (region.reason !== undefined && region.reason !== "MISSING_REGION_RESULT"))
          throw new contract.RecognitionError("INVALID_PROVIDER_RESPONSE", 502);
        return { regionId: region.regionId, status: region.status, observedLabels: region.observedLabels };
      }) };
      const result = contract.normalizeResponse(validated, observations, matchRecognitionIdentity);
      for (const region of response.regions) {
        const normalized = result.regions.find(item => item.regionId === region.regionId);
        const validSuggestions = region.suggestions.length === normalized.suggestions.length
          && new Set(region.suggestions.map(item => item?.itemName)).size === region.suggestions.length
          && region.suggestions.every(item => item && typeof item === "object" && !Array.isArray(item)
            && Object.keys(item).every(key => ["itemName", "category"].includes(key))
            && normalized.suggestions.some(expected => expected.itemName === item.itemName && expected.category === item.category));
        if (region.status !== normalized.status || !validSuggestions
            || (region.reason && (region.status !== "unknown" || region.observedLabels.length)))
          throw new contract.RecognitionError("INVALID_PROVIDER_RESPONSE", 502);
        if (region.reason) normalized.reason = region.reason;
      }
      return result;
    } finally { release(); }
  };
}
module.exports = { createRecognitionService, recognizeCrops: createRecognitionService() };
