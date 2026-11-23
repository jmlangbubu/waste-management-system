const http = require("http");
const https = require("https");
const diagnostics = require("./cloudRunDiagnostics");
const { withDisplayNames } = require("./wasteDisplayNameService");
const { detectObjectsFromBase64, normalizeBoundingBox, OBJECT_LOCALIZATION_TIMEOUT_MS } = require("./googleVisionService");
const { getWasteLearningGuide } = require("./wasteLearningGuideService");
const { automaticCategory, productStateVeto } = require("./automaticWasteCategoryMapper");

const {
  analyzeWasteByObject,
  getFallbackResult,
  mapWasteCategory,
  normalizeText
} = require("../utils/wasteMapper");

const MIN_OBJECT_CONFIDENCE = 0.40;
const MAX_DETECTED_ITEMS = 8;
// Request-local ownership, never serialized into responses or scan history.
const primaryOwners = new WeakMap();

function overlapRatio(a, b) {
  const intersection = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const area = (box) => (box.right - box.left) * (box.bottom - box.top);
  return intersection / (area(a) + area(b) - intersection);
}

// Provider aliases describe the same bottle/container silhouette, not its material.
const GENERIC_CONTAINER_NAMES = new Set(["bottle", "bottles", "jar", "jars", "container", "can", "bottled and jarred packaged goods"]);
// Neutral observations carry no more physical specificity than a localized noun.
const NEUTRAL_OBJECT_NAMES = new Set(["item", "object", "household item", "household object"]);
// Private only: a normalization conflict must survive the later merge/assessment.
const normalizationConflicts = new WeakSet();
function holdNormalizedCategory(item) {
  item.category = "Unknown"; item.requiresConfirmation = true;
  item.modelKey = ""; item.modelHotspots = []; item.guidance = {};
  for (const field of ["explanation", "action", "warning"]) delete item[field];
  normalizationConflicts.add(item);
  return item;
}
function identityFamily(name) {
  if (name === "bottled and jarred packaged goods") return "packaged-container";
  if (/\bbottles?\b/.test(name)) return "bottle";
  if (/\bjars?\b/.test(name)) return "jar";
  return name;
}
function similarObjectNames(a, b) {
  const firstFamily = identityFamily(a), secondFamily = identityFamily(b);
  if (firstFamily === secondFamily) return true;
  if ((firstFamily === "packaged-container" && ["bottle", "jar"].includes(secondFamily))
      || (secondFamily === "packaged-container" && ["bottle", "jar"].includes(firstFamily))) return true;
  const words = (name) => name.split(" ").map((word) => word.replace(/s$/, ""));
  const first = words(a), second = words(b);
  return first.every((word) => second.includes(word)) || second.every((word) => first.includes(word));
}
// Name-free strict region identity (unchanged thresholds, shared by samePhysicalObject).
function strictlySameRegion(x, y) {
  return overlapRatio(x, y) >= .90
      && Math.abs((x.left + x.right - y.left - y.right) / 2) <= .05 * Math.min(x.right - x.left, y.right - y.left)
      && Math.abs((x.top + x.bottom - y.top - y.bottom) / 2) <= .05 * Math.min(x.bottom - x.top, y.bottom - y.top);
}
function samePhysicalObject(a, b) {
  const x = a.boundingBox, y = b.boundingBox;
  if (!normalizeBoundingBox(x) || !normalizeBoundingBox(y)) return false;
  // Both same-provider and independent observations can disagree on the same
  // object. Require nearly identical extents and centers for a name-free match;
  // different-size nested objects and partial overlaps must remain independent.
  if (strictlySameRegion(x, y)) return true;
  // Only independent providers with compatible physical identities may tolerate
  // small translation error. Containment and same-provider overlap are not proof.
  const sources = new Set([a.analysisSource, b.analysisSource]);
  const contains = (a, b) => a.left <= b.left && a.top <= b.top && a.right >= b.right && a.bottom >= b.bottom;
  if (!sources.has("gemini_whole_image") || !sources.has("google_vision_object_localization")
      || contains(x, y) || contains(y, x)
      || !similarObjectNames(a.canonicalItem || "", b.canonicalItem || "")) return false;
  const closeSize = (a, b) => Math.min(a, b) / Math.max(a, b) >= .90;
  return overlapRatio(x, y) >= .80 && closeSize(x.right - x.left, y.right - y.left)
    && closeSize(x.bottom - x.top, y.bottom - y.top)
    && Math.abs((x.left + x.right - y.left - y.right) / 2) <= .08 * Math.min(x.right - x.left, y.right - y.left)
    && Math.abs((x.top + x.bottom - y.top - y.bottom) / 2) <= .08 * Math.min(x.bottom - x.top, y.bottom - y.top);
}
// samePhysicalObject can round differently by argument order at an exact boundary.
// Normalization and the proposal reconciler use this symmetric form. The public
// matcher, discovery matching and all numerical thresholds remain unchanged.
function sameObjectEitherOrder(a, b) {
  return samePhysicalObject(a, b) || samePhysicalObject(b, a);
}
// P-2c: the merge keeps symmetric same-object matching (P-2) everywhere except a Gemini pair split across a Vision
// owner region (exactly one of the two is the same object as an owner): such a pair matches only when the existing
// comparison holds in both orders, so a one-directional boundary match cannot move valid owner evidence to a card.
function createMergeMatcher(owners) {
  const visionOwners = owners.filter((owner) => owner.analysisSource === "google_vision_object_localization" && owner.boundingBox);
  const onOwner = new Map();
  const ownerSide = (item) => { if (!onOwner.has(item)) onOwner.set(item, visionOwners.some((owner) => sameObjectEitherOrder(owner, item))); return onOwner.get(item); };
  return (a, b) => {
    if (a.analysisSource === "google_vision_object_localization" || b.analysisSource === "google_vision_object_localization") return sameObjectEitherOrder(a, b);
    if (ownerSide(a) !== ownerSide(b)) return samePhysicalObject(a, b) && samePhysicalObject(b, a);
    return sameObjectEitherOrder(a, b);
  };
}

function normalizeDetectedItems(objects, analysisSource, allowClassifierCategory = false) {
  if (!Array.isArray(objects)) return [];
  const candidates = objects.flatMap((object, index) => {
    if (!object || typeof object !== "object") return [];
    const name = typeof (object.itemName || object.name) === "string"
      ? (object.itemName || object.name).trim().slice(0, 160) : "";
    const canonicalItem = normalizeText(name);
    const confidence = object.confidence ?? object.score;
    const boundingBox = normalizeBoundingBox(object.boundingBox || object.boundingPoly);
    if (!canonicalItem || !Number.isFinite(confidence) || confidence < MIN_OBJECT_CONFIDENCE
      || confidence > 1 || !boundingBox) return [];
    // Google Vision OBJECT_LOCALIZATION supplies object labels, not evidence
    // of waste condition. Never apply the broad legacy word-score mapper to it.
    // The existing narrow identity rules are provisional suggestions only.
    const visionLocalization = analysisSource === "google_vision_object_localization";
    const mapped = visionLocalization
      ? { category: automaticCategory({
        analysisSource, observedIdentity: name, category: "Unknown", boundingBox
      }) }
      : analyzeWasteByObject(canonicalItem);
    const classifierCategory = allowClassifierCategory ? normalizeCategory(object.category) : null;
    let category = mapped?.category === "Special Waste" || classifierCategory === "Special Waste"
      ? "Special Waste" : classifierCategory || mapped?.category;
    // No whole-banana-to-peel conversion or category from broad packaging words.
    if (!category || (allowClassifierCategory && object.category === "Unknown")
        || (!visionLocalization && !classifierCategory && GENERIC_CONTAINER_NAMES.has(canonicalItem))) category = "Unknown";
    if(productStateVeto({analysisSource,observedIdentity:name,boundingBox},category))category="Unknown";
    if (!isValidCategory(category) && category !== "Unknown") return [];
    const details = allowClassifierCategory ? Object.fromEntries(
      ["explanation", "action", "warning"].filter((key) => typeof object[key] === "string" && object[key].trim())
        .map((key) => [key, object[key]])
    ) : {};
    const { modelKey = "", modelHotspots = [], ...guidance } = category === "Unknown" ? {} : getWasteLearningGuide(canonicalItem, category);
    return [{ index, itemName: name, canonicalItem, category, confidence,
      analysisSource, boundingBox, modelKey, guidance, modelHotspots, ...details,
      ...(visionLocalization || category === "Unknown" ? { requiresConfirmation: true } : {}) }];
  });
  // Safety and supported specificity precede confidence; geometry decides duplication.
  candidates.sort((a, b) => Number(b.category === "Special Waste") - Number(a.category === "Special Waste")
    || Number(NEUTRAL_OBJECT_NAMES.has(a.canonicalItem)) - Number(NEUTRAL_OBJECT_NAMES.has(b.canonicalItem))
    || Number(GENERIC_CONTAINER_NAMES.has(a.canonicalItem)) - Number(GENERIC_CONTAINER_NAMES.has(b.canonicalItem))
    || b.confidence - a.confidence
    || b.canonicalItem.split(" ").length - a.canonicalItem.split(" ").length
    || a.index - b.index);
  const retained = [];
  const corresponds = (a, b) => a === b || sameObjectEitherOrder(a, b);
  // Closed neighborhoods must agree: a bridging observation cannot collapse
  // separate regions merely because it was processed first. This also permits
  // a complete group of mutually matching duplicates to collapse only once.
  const uniqueCorrespondence = (a, b) => corresponds(a, b)
    && candidates.every(peer => corresponds(peer, a) === corresponds(peer, b));
  for (const candidate of candidates) {
    const matches = retained.filter((other) => uniqueCorrespondence(candidate, other));
    const duplicate = matches.length === 1 ? retained.indexOf(matches[0]) : -1;
    if (duplicate !== -1) {
      const other = retained[duplicate];
      // Prefer an observed physical container over an incompatible contents label,
      // without inferring material/category or replacing established safety evidence.
      const container = (item) => /\b(bottles?|jars?|containers?|cans?|cups?|box(?:es)?|bags?)\b/.test(item.canonicalItem);
      const categoryConflict = isValidCategory(candidate.category) && isValidCategory(other.category)
        && candidate.category !== other.category;
      if (candidate.category !== "Special Waste" && other.category !== "Special Waste"
          && (categoryConflict || (!similarObjectNames(candidate.canonicalItem,other.canonicalItem)
          && container(candidate) !== container(other)))) {
        // A unique region match grants no authority to reconcile opposing streams.
        const survivor = NEUTRAL_OBJECT_NAMES.has(other.canonicalItem) && !NEUTRAL_OBJECT_NAMES.has(candidate.canonicalItem)
          ? candidate : NEUTRAL_OBJECT_NAMES.has(candidate.canonicalItem) && !NEUTRAL_OBJECT_NAMES.has(other.canonicalItem)
          ? other : container(candidate) && !container(other) ? candidate : other;
        retained[duplicate] = holdNormalizedCategory(survivor);
        continue;
      }
      if (candidate.category === "Unknown" && other.category === "Unknown"
          && !similarObjectNames(candidate.canonicalItem, other.canonicalItem)) {
        if (container(candidate) && !container(other)) retained[duplicate] = candidate;
        retained[duplicate].requiresConfirmation = true;
      }
      continue;
    }
    // An ambiguous hazardous region remains a separate card. Its competing
    // ordinary regions retain identity/geometry, but gain no disposal authority.
    if (candidate.category !== "Special Waste" && retained.some(other =>
        other.category === "Special Waste" && corresponds(candidate, other))) {
      holdNormalizedCategory(candidate);
    }
    retained.push(candidate);
    if (retained.length === MAX_DETECTED_ITEMS) break;
  }
  return retained.sort((a, b) => a.index - b.index).map((candidate, position) => {
    const {index,...item}=candidate,owner={itemId:`item_${position+1}`,...item};
    if(normalizationConflicts.has(candidate))normalizationConflicts.add(owner);
    return owner;
  });
}

function buildScanSummary(detectedItems = []) {
  const categories = { biodegradable: 0, recyclable: 0, residual: 0, specialWaste: 0 };
  const keys = { Biodegradable: "biodegradable", Recyclable: "recyclable", Residual: "residual", "Special Waste": "specialWaste" };
  for (const item of detectedItems) if (keys[item.category]) categories[keys[item.category]] += 1;
  return { totalItems: detectedItems.length, categories };
}

function withDetectedItems(legacyResult, detectedItems, preserveLegacyPrimary = false) {
  const primary = detectedItems.filter((item) => isValidCategory(item.category))
    .reduce((best, item) => !best || item.confidence > best.confidence ? item : best, null);
  const result = primary && !preserveLegacyPrimary ? {
    ...createSafeResult({ category: primary.category, detectedObject: primary.itemName,
      aiLabel: primary.itemName, aiConfidence: toSafeNumberText(primary.confidence), analysisSource: primary.analysisSource,
      explanation: primary.explanation, action: primary.action, warning: primary.warning }),
    itemName: primary.itemName
  } : legacyResult;
  const response = { ...result, detectedItems, scanSummary: buildScanSummary(detectedItems) };
  if (primary && !preserveLegacyPrimary) primaryOwners.set(response, primary);
  return response;
}

// The existing Unknown primary wording. The A9 primary holds (accepted path and hazard-safe fallback) use exactly
// this text.
const UNKNOWN_PRIMARY_GUIDANCE = Object.freeze({
  explanation: "The object's waste category or condition has not been safely established.",
  action: "Confirm identity, material, contents and condition with WMO before choosing a disposal stream.",
  warning: "Keep separate until identity, contents and condition are established. Do not choose a disposal stream from an uncertain result."
});

function reconcilePrimary(result, detectedItems) {
  const owner = primaryOwners.get(result);
  const noClassification = result.analysisSource === "fallback_no_ai_result" || !isValidCategory(result.category);
  // A valid independent classifier/mapper result is not owned by a localized
  // observation. Never infer ownership from its label or category agreement.
  if (!owner && !noClassification) return result;
  const sameOwner = owner && detectedItems.filter(item => item.itemId === owner.itemId
    && item.analysisSource === owner.analysisSource && item.captureId === owner.captureId
    && item.confidence === owner.confidence && ["left", "top", "right", "bottom"]
      .every(key => item.boundingBox?.[key] === owner.boundingBox?.[key]));
  if (sameOwner?.length === 1 && sameOwner[0].category === result.category
      && isValidCategory(sameOwner[0].category)) return result;
  const safe = detectedItems.filter(item => isValidCategory(item.category))
    .reduce((best, item) => !best || (item.confidence ?? 0) > (best.confidence ?? 0) ? item : best, null);
  if (safe) return { ...result, ...createSafeResult({ category: safe.category,
    detectedObject: safe.itemName, aiLabel: safe.itemName,
    aiConfidence: toSafeNumberText(safe.confidence), analysisSource: safe.analysisSource,
    explanation: safe.explanation, action: safe.action, warning: safe.warning }), itemName: safe.itemName };
  // Do not pass Unknown through the legacy createSafeResult Residual default.
  return { ...result, ...(noClassification ? { itemName: "Unidentified item" } : {}), category: "Unknown", ...UNKNOWN_PRIMARY_GUIDANCE };
}

async function localizeObjectsBestEffort(image) {
  let timer;
  try {
    // A slow localization provider must not indefinitely hold a valid primary result.
    return await Promise.race([
      Promise.resolve().then(() => detectObjectsFromBase64(image)),
      new Promise((resolve) => { timer = setTimeout(() => resolve([]), OBJECT_LOCALIZATION_TIMEOUT_MS); })
    ]);
  } catch (_) {
    console.warn("[WasteAnalysis] Object localization unavailable; keeping primary classification.");
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function enrichWithGoogleObjects(legacyResult, localizedObjects, preserveLegacyPrimary = false) {
  try {
    const objects = await localizedObjects;
    return withDetectedItems(legacyResult, normalizeDetectedItems(objects, "google_vision_object_localization"), preserveLegacyPrimary);
  } catch (_) {
    console.warn("[WasteAnalysis] Multi-item enrichment unavailable; keeping legacy result.");
    return withDetectedItems(legacyResult, []);
  }
}

/*
  IMPORTANT:
  Render direct Gemini call is currently failing with:
  "User location is not supported for the API use."

  So this service now prioritizes an external Gemini classifier endpoint,
  preferably hosted on Google Cloud Run.

  Add this to Render Environment when Cloud Run classifier is ready:
  GEMINI_CLASSIFIER_URL=https://your-cloud-run-url/classify-waste

  Optional:
  ALLOW_RENDER_GEMINI_DIRECT=true
  Only use this if Render direct Gemini starts working later.
*/

let classifyWasteWithGemini = null;

try {
  classifyWasteWithGemini = require("./geminiWasteClassifierService").classifyWasteWithGemini;
} catch (error) {
  console.warn("[WasteAnalysis] Local Gemini service not loaded:", error.message);
}

function getEnvValue(name) {
  return process.env[name] ? String(process.env[name]).trim() : "";
}

function buildCategoryExplanation(category) {
  switch (category) {
    case "Biodegradable":
      return "This waste type is biodegradable because the detected item appears to be food waste, fruit or vegetable waste, leaves, plant-based waste, or other organic compostable material.";
    case "Recyclable":
      return "This waste type is recyclable because the detected item appears to be a bottle, can, paper-based material, carton, glass, metal, plastic container, or reusable container material.";
    case "Special Waste":
      return "This waste type is classified as special waste because it may contain electrical, electronic, chemical, hazardous, medical, or regulated components that need special handling.";
    case "Residual":
    default:
      return "This waste type is residual because it is not confidently identified as biodegradable, recyclable, or special waste and should be disposed of carefully as residual waste.";
  }
}

function buildCategoryAction(category) {
  switch (category) {
    case "Biodegradable":
      return "Place the item in the biodegradable waste bin or composting area. Keep it separate from plastic, metal, glass, and hazardous waste.";
    case "Recyclable":
      return "Place the item in the recyclable waste bin. If possible, empty and clean the item first before disposal.";
    case "Special Waste":
      return "Do not mix this item with ordinary household waste. Bring it to the proper special waste, hazardous waste, e-waste, or regulated collection point.";
    case "Residual":
    default:
      return "Place the item in the residual waste bin. Avoid mixing it with biodegradable, recyclable, or special waste items.";
  }
}

function buildCategoryWarning(category) {
  switch (category) {
    case "Biodegradable":
      return "Do not mix biodegradable waste with plastic wrappers, sachets, cans, bottles, batteries, chemicals, or other non-biodegradable materials.";
    case "Recyclable":
      return "Items that are heavily contaminated with food, grease, oil, or chemicals may no longer be suitable for recycling.";
    case "Special Waste":
      return "Improper disposal of special waste may harm people, equipment, and the environment.";
    case "Residual":
    default:
      return "This result may be a fallback if the item was unclear, blurred, mixed with other objects, or not confidently detected.";
  }
}

function isValidCategory(category) {
  return ["Biodegradable", "Recyclable", "Residual", "Special Waste"].includes(category);
}

function normalizeCategory(category) {
  const clean = normalizeText(category);

  if (clean.includes("recyclable")) return "Recyclable";
  if (clean.includes("recycle")) return "Recyclable";

  if (clean.includes("biodegradable")) return "Biodegradable";
  if (clean.includes("organic")) return "Biodegradable";
  if (clean.includes("compost")) return "Biodegradable";

  if (clean.includes("special")) return "Special Waste";
  if (clean.includes("hazardous")) return "Special Waste";
  if (clean.includes("e waste")) return "Special Waste";
  if (clean.includes("ewaste")) return "Special Waste";
  if (clean.includes("electronic")) return "Special Waste";
  if (clean.includes("battery")) return "Special Waste";
  if (clean.includes("chemical")) return "Special Waste";
  if (clean.includes("medical")) return "Special Waste";

  if (clean.includes("residual")) return "Residual";
  if (clean.includes("general waste")) return "Residual";
  if (clean.includes("trash")) return "Residual";
  if (clean.includes("garbage")) return "Residual";

  return "";
}

function toSafeString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;

  const text = String(value).trim();
  return text || fallback;
}

function toSafeNumberText(value) {
  if (value === null || value === undefined || value === "") return null;

  const numberValue = Number(value);

  if (Number.isNaN(numberValue)) return null;

  if (numberValue > 1) {
    return Math.max(0, Math.min(100, numberValue)).toFixed(2);
  }

  return Math.max(0, Math.min(1, numberValue)).toFixed(2);
}

function createSafeResult({
  category = "Residual",
  detectedObject = "",
  aiLabel = null,
  aiConfidence = null,
  analysisSource = "fallback",
  visionLabels = [],
  mlKitLabels = [],
  roboflowPredictions = [],
  explanation = null,
  action = null,
  warning = null
}) {
  const normalizedCategory = normalizeCategory(category) || "Residual";

  return {
    itemName: normalizedCategory,
    category: normalizedCategory,
    explanation: explanation || buildCategoryExplanation(normalizedCategory),
    action: action || buildCategoryAction(normalizedCategory),
    warning: warning || buildCategoryWarning(normalizedCategory),
    detectedObject: detectedObject || normalizedCategory,
    aiLabel,
    aiConfidence,
    analysisSource,
    visionLabels,
    mlKitLabels,
    roboflowPredictions
  };
}

function buildFallbackFromMapper({ detectedObject = "", mlKitLabels = [] } = {}) {
  const labelText = Array.isArray(mlKitLabels)
    ? mlKitLabels
        .map((item) => {
          if (typeof item === "string") return item;
          return item?.description || item?.name || item?.label || "";
        })
        .filter(Boolean)
        .join(" ")
    : "";

  const combinedText = normalizeText(`${detectedObject} ${labelText}`);

  if (!combinedText || combinedText === "captured waste item") {
    return null;
  }

  let mapped = null;

  try {
    mapped = mapWasteCategory({
      analysisText: combinedText,
      labels: mlKitLabels,
      objectName: detectedObject
    });
  } catch (error) {
    console.error("[WasteAnalysis] mapWasteCategory error:", error.message);
    mapped = null;
  }

  if (mapped && mapped.category) {
    return mapped;
  }

  try {
    const ruleBased = analyzeWasteByObject(combinedText);

    if (ruleBased && ruleBased.category) {
      return ruleBased;
    }
  } catch (error) {
    console.error("[WasteAnalysis] analyzeWasteByObject error:", error.message);
  }

  return null;
}

function postJson(urlString, payload, timeoutMs = 35000, invocationHeaders = {}) {
  return new Promise((resolve, reject) => {
    let parsedUrl = null;

    try {
      parsedUrl = new URL(urlString);
    } catch (error) {
      return reject(new Error("Invalid classifier URL."));
    }

    const bodyString = JSON.stringify(payload);
    const isHttps = parsedUrl.protocol === "https:";
    const client = isHttps ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyString),
        ...invocationHeaders
      },
      timeout: timeoutMs
    };

    let timer;
    const req = client.request(options, (res) => {
      let rawData = "";

      res.on("data", (chunk) => {
        rawData += chunk;
        if(Buffer.byteLength(rawData)>64*1024) { clearTimeout(timer); req.destroy(new Error("Classifier response exceeds limit.")); }
      });

      res.on("end", () => {
        clearTimeout(timer);
        let parsed = null;

        try {
          parsed = rawData ? JSON.parse(rawData) : {};
        } catch (_) {
          parsed = { raw: rawData };
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`Classifier request failed with status ${res.statusCode}`);
          error.statusCode = res.statusCode;
          error.response = parsed;
          diagnostics.mark(error, "classifier_http_response", res.statusCode);
          return reject(error);
        }

        resolve(parsed);
      });
    });

    req.on("timeout", () => {
      req.destroy(diagnostics.mark(new Error("Classifier request timed out."), "timeout"));
    });

    req.on("error", (error) => {
      clearTimeout(timer);
      reject(diagnostics.has(error) ? error : diagnostics.mark(error, "classifier_network_transport"));
    });

    timer=setTimeout(()=>req.destroy(diagnostics.mark(new Error("Classifier request deadline exceeded."), "timeout")),timeoutMs);
    req.write(bodyString);
    req.end();
  });
}

async function classifyWithExternalGeminiService(image, timeoutMs = 35000, proposalRequest = null) {
  const classifierUrl =
    getEnvValue("GEMINI_CLASSIFIER_URL") ||
    getEnvValue("CLOUD_RUN_GEMINI_CLASSIFIER_URL");

  if (!classifierUrl) {
    console.warn("[WasteAnalysis] GEMINI_CLASSIFIER_URL is not set. Skipping external Gemini classifier.");
    return null;
  }

  let failureStage = "iam_authentication";
  try {
    console.log("[WasteAnalysis] Calling external Gemini classifier.");

    const deadlineAt = Date.now() + timeoutMs;
    const headers = process.env.CLOUD_RUN_AUTH_MODE
      ? await require("./cloudRunAuth").invocationHeaders(classifierUrl, { timeoutMs }) : {};
    if (deadlineAt <= Date.now()) throw new Error("Classifier request deadline exceeded.");
    failureStage = "classifier_network_transport";
    // Feature-off requests keep the exact legacy body and headers. An eligible
    // proposal request adds only the opt-in flag and its Cloud Run token header.
    const response = await postJson(classifierUrl, proposalRequest ? {
      image, objectProposals: true
    } : {
      image
    }, Math.max(1, deadlineAt-Date.now()), proposalRequest
      ? { ...headers, "X-Classify-Proposals-Token": proposalRequest.token } : headers);

    console.log("[WasteAnalysis] External classifier response success:", response?.success === true);

    const envelope = response !== null && typeof response === "object" && !Array.isArray(response);
    const hasResult = envelope && response.success === true && response.result !== null
      && typeof response.result === "object" && !Array.isArray(response.result);
    const validUnsuccessful = envelope && response.success === false && response.result === null;
    const usablePrimary = hasResult && isValidCategory(normalizeCategory(response.result.category));
    if (!usablePrimary) {
      const stage = validUnsuccessful ? "classifier_upstream_unsuccessful" : "classifier_response_validation";
      console.error("[WasteAnalysis] classifier failure", diagnostics.diagnostic(null, stage));
    }
    if (!hasResult) {
      return {
        success: false,
        message: response?.message || "External classifier returned no valid result.",
        result: null
      };
    }

    // An unusable primary may still carry valid independent detections. Let the
    // existing item normalization and primary/fallback selection handle them.
    return {
      success: true,
      source: response.source || "cloud_run_gemini_vision",
      result: response.result
    };
  } catch (error) {
    console.error("[WasteAnalysis] classifier failure", diagnostics.diagnostic(error, failureStage));

    return {
      success: false,
      message: error.message,
      result: null
    };
  }
}

async function classifyWithLocalRenderGemini(image) {
  const allowDirectGemini = getEnvValue("ALLOW_RENDER_GEMINI_DIRECT").toLowerCase() === "true";

  if (!allowDirectGemini) {
    console.warn("[WasteAnalysis] Render direct Gemini disabled. Set ALLOW_RENDER_GEMINI_DIRECT=true only if Render Gemini works.");
    return null;
  }

  if (typeof classifyWasteWithGemini !== "function") {
    console.warn("[WasteAnalysis] Local Gemini classifier function is unavailable.");
    return null;
  }

  try {
    console.log("[WasteAnalysis] Trying Render direct Gemini classifier.");
    return await classifyWasteWithGemini(image);
  } catch (error) {
    console.error("[WasteAnalysis] Local Gemini classifier fatal error:", error.message);

    return {
      success: false,
      message: error.message,
      result: null
    };
  }
}

function buildAiResultFromClassifier(classifierResult, sourceFallback) {
  if (!classifierResult?.success || !classifierResult?.result) {
    return null;
  }

  const result = classifierResult.result;
  const category = normalizeCategory(result.category);

  if (!isValidCategory(category)) {
    return null;
  }

  return { ...createSafeResult({
    category,
    detectedObject: result.itemName || result.detectedObject || category,
    aiLabel: result.itemName || result.detectedObject || category,
    aiConfidence: toSafeNumberText(result.confidence),
    analysisSource: classifierResult.source || sourceFallback,
    explanation: result.explanation || null,
    action: result.action || null,
    warning: result.warning || null,
    visionLabels: [],
    mlKitLabels: []
  }), itemName: result.itemName || result.detectedObject || category };
}

async function analyzeWasteLegacy({ image, detectedObject, mlKitLabels = [], boundedDiscovery = false }, proposalContext = null) {
  console.log("=== analyzeWaste START ===");

  /*
    FIRST PRIORITY:
    External Gemini classifier endpoint, preferably Google Cloud Run.

    This avoids the Render -> Gemini location restriction:
    "User location is not supported for the API use."
  */
  const externalGeminiResult = await classifyWithExternalGeminiService(image, boundedDiscovery ? 15000 : 35000,
    proposalContext ? proposalContext.request : null);
  let externalItems = [];
  if (externalGeminiResult?.success) {
    externalItems = normalizeDetectedItems(externalGeminiResult.result?.detectedItems, "cloud_run_gemini_vision", true);
    if (!externalItems.length) externalItems = normalizeDetectedItems(externalGeminiResult.result?.items, "cloud_run_gemini_vision", true);
  }
  const externalAiResult = buildAiResultFromClassifier(externalGeminiResult, "cloud_run_gemini_vision");
  if (externalItems.length) return withDetectedItems(externalAiResult, externalItems, !!externalAiResult);
  // Do not speculate on Google before Gemini multi-item selection: that would add a needless call.
  // Once that selection is ruled out, overlap localization with the optional local fallback.
  const localizedObjects = localizeObjectsBestEffort(image);


  if (externalAiResult) {
    // Request-local: proposals are only ever considered beside a VALID primary
    // returned by this same classifier response; never serialized from here.
    if (proposalContext) {
      proposalContext.primaryValid = true;
      proposalContext.raw = externalGeminiResult.result.objectProposals;
    }
    console.log("[WasteAnalysis] RETURNING external Gemini category:", externalAiResult.category);
    return enrichWithGoogleObjects(externalAiResult, localizedObjects, true);
  }

  /*
    SECOND PRIORITY:
    Optional direct Gemini from Render.

    Disabled by default because Render direct Gemini is currently failing.
    Only enable with ALLOW_RENDER_GEMINI_DIRECT=true if you confirm it works.
  */
  const localGeminiResult = boundedDiscovery || !!process.env.CLOUD_RUN_AUTH_MODE ? null : await classifyWithLocalRenderGemini(image);
  const localAiResult = buildAiResultFromClassifier(
    localGeminiResult,
    "gemini_vision"
  );

  if (localAiResult) {
    console.log("[WasteAnalysis] RETURNING local Gemini category:", localAiResult.category);
    return enrichWithGoogleObjects(localAiResult, localizedObjects, true);
  }

  /*
    THIRD PRIORITY:
    ML Kit / rule-based local fallback.

    This only works well if Android sends mlKitLabels.
    If Android sends empty labels and detectedObject is captured_waste_item,
    there is no reliable image understanding here.
  */
  const mappedFallback = buildFallbackFromMapper({
    detectedObject,
    mlKitLabels
  });

  if (mappedFallback && mappedFallback.category) {
    const category = normalizeCategory(mappedFallback.category) || "Residual";

    console.log("[WasteAnalysis] RETURNING local mapper category:", category);

    return enrichWithGoogleObjects(createSafeResult({
      category,
      detectedObject: mappedFallback.itemName || category,
      aiLabel: mappedFallback.itemName || category,
      aiConfidence: null,
      analysisSource: "local_mapper_fallback",
      explanation: mappedFallback.explanation || null,
      action: mappedFallback.action || null,
      warning: mappedFallback.warning || null,
      visionLabels: [],
      mlKitLabels: Array.isArray(mlKitLabels) ? mlKitLabels : []
    }), localizedObjects);
  }

  /*
    FINAL FALLBACK:
    Do not pretend this is accurate.
    Keep a valid category because the frontend/history expects one.
  */
  let fallback = null;

  try {
    fallback = getFallbackResult();
  } catch (error) {
    console.error("[WasteAnalysis] getFallbackResult error:", error.message);
  }

  const fallbackCategory = normalizeCategory(fallback?.category) || "Residual";

  console.log("[WasteAnalysis] RETURNING final fallback:", fallbackCategory);

  return enrichWithGoogleObjects(createSafeResult({
    category: fallbackCategory,
    detectedObject: toSafeString(detectedObject, fallbackCategory),
    aiLabel: "unable to confidently identify item",
    aiConfidence: null,
    analysisSource: "fallback_no_ai_result",
    visionLabels: [],
    mlKitLabels: Array.isArray(mlKitLabels) ? mlKitLabels : [],
    explanation:
      "The system could not confidently identify the waste item using the image classifier.",
    action:
      "Please retake the photo with one clear waste item centered in the frame, then analyze again.",
    warning:
      "This is a fallback result and may not be accurate. Do not rely on it if the item is clearly recyclable, biodegradable, or special waste."
  }), localizedObjects);
}

/*
  OPTIONAL CLASSIFY-CALL OBJECT PROPOSALS (backend flag, default OFF)
  -------------------------------------------------------------------
  WMO_CLASSIFY_OBJECT_PROPOSALS_ENABLED === "true" lets an ELIGIBLE request ask
  the EXISTING Cloud Run classifier call for identity/geometry proposals. They
  are observations only: re-normalized here by the existing strict discovery
  normalizer under an ephemeral server capture, then reconciled with the SAME
  scan's Vision boxes by the existing discovery merge, whose capture-bound
  category authority and deterministic rules alone decide categories.
  No /discover-objects, /recognize-crops, assessment or second Gemini call.
  All modules below are loaded lazily so the feature-off path is unchanged.
*/
function proposalDiagnostics(summary) {
  try { require("./wasteAssessmentDiagnostics").logObjectProposals(summary, console); }
  catch (_) { /* Diagnostics never affect analysis. */ }
}

function objectProposalContext(input, proposalSession) {
  if (process.env.WMO_CLASSIFY_OBJECT_PROPOSALS_ENABLED !== "true") return null;
  const ineligible = (reason) => { proposalDiagnostics({ status: "ineligible", reason }); return null; };
  if (!require("../config/objectProposalCanary").isAllowedProposalSession(proposalSession)) {
    return ineligible("account_ineligible");
  }
  // Route-derived from the exact v2 capability header; protocol negotiation only.
  if (input?.independentCategoryV2 !== true) return ineligible("capability_missing");
  // The existing discovery mode keeps sole ownership of its own pipeline.
  if (process.env.WHOLE_IMAGE_DISCOVERY_ENABLED === "true") return ineligible("discovery_mode");
  const token = getEnvValue("CLASSIFY_OBJECT_PROPOSALS_SHARED_TOKEN");
  if (token.length < 32) return ineligible("token_unconfigured");
  let classifierUrl;
  try { classifierUrl = new URL(getEnvValue("GEMINI_CLASSIFIER_URL") || getEnvValue("CLOUD_RUN_GEMINI_CLASSIFIER_URL")); }
  catch (_) { return ineligible("classifier_unconfigured"); }
  // The proposal token is never sent over plain HTTP or with URL credentials.
  if (classifierUrl.protocol !== "https:" || classifierUrl.username || classifierUrl.password) {
    return ineligible("classifier_insecure");
  }
  try {
    const whole = require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
    const shared = require("../gemini-waste-classifier-cloudrun/cropRecognition");
    const { randomUUID } = require("node:crypto");
    const image = input.image;
    // Existing whole-image bounds (canonical JPEG base64, size, dimensions, no EXIF APP1).
    if (typeof image !== "string" || image.length > 4 * Math.ceil(whole.LIMITS.bytes / 3)) return ineligible("image");
    const dimensions = shared.imageDimensions(Buffer.from(image, "base64"), "image/jpeg");
    if (!dimensions) return ineligible("image");
    // Ephemeral, request-local server capture: never serialized, persisted,
    // reused, or presented to Android as a client capture or assessment sidecar.
    const capture = whole.validateRequest({ requestId: randomUUID(), captureId: randomUUID(), image,
      width: dimensions.width, height: dimensions.height, orientation: "upright" });
    return { capture, request: { token }, primaryValid: false, raw: undefined };
  } catch (_) {
    return ineligible("image");
  }
}

// Set-level validation: any violation rejects every proposal (legacy fallback).
function normalizeObjectProposals(capture, raw) {
  const whole = require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
  const reject = () => { throw new Error("Object proposals rejected."); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || Object.keys(raw).some((key) => key !== "objects" && key !== "primaryObjectIndex")) reject();
  const { objects, primaryObjectIndex: index } = raw;
  if (!Array.isArray(objects) || objects.length < 1 || objects.length > whole.LIMITS.items) reject();
  for (const object of objects) {
    if (!object || typeof object !== "object" || Array.isArray(object)) reject();
    // A supplied box must satisfy the existing y-first 0..1000 integer convention.
    if (Object.prototype.hasOwnProperty.call(object, "box_2d") && !whole.box(object.box_2d)) reject();
  }
  if (index !== undefined && !(Number.isInteger(index) && index >= 0 && index < objects.length)) reject();
  // Existing normalizer: exact keys, label bounds, capture-bound IDs; no remote
  // categories, confidences or IDs are accepted (it rejects any extra field).
  const normalized = whole.normalize(capture, { objects: objects.map((object) => ({ ...object })) }).objects;
  if (new Set(normalized.map((item) => item.itemId)).size !== normalized.length) reject();
  return { objects: normalized, primaryIndex: Number.isInteger(index) ? index : null };
}

/*
  ON-path proposal reconciliation BEFORE the unchanged discovery merge.
  Provisional, uncalibrated offline geometry; never a category grant:
  - F1: a one-to-one proposal confirming the SAME exact physical Special Waste
    identity of an independently authorized Vision owner is removed, so that
    owner keeps exactly its feature-off result (no asymmetric-metadata demotion).
  - F2: a one-to-one near-duplicate (not strict) proposal is removed so one
    physical object yields one card. Disagreeing, hazardous, contradictory or
    adverse-state evidence makes the owner Unknown through the merge's existing
    normalization-conflict channel; it is never promoted.
  - Ambiguous associations are never resolved by guessing, yet hazard or
    adverse-state evidence still fails closed for ordinary owners.
  Strict non-confirming pairs stay entirely under existing merge authority.
*/
const PROPOSAL_DUPLICATE_IOU = 0.70;             // inclusive
const PROPOSAL_DUPLICATE_CENTER = 0.15;          // x smaller width / height
const PROPOSAL_DUPLICATE_SIZE = 0.80;            // min/max width and height
const PROPOSAL_DUPLICATE_CONTAINED_SIZE = 0.90;  // when one box contains the other
const PROPOSAL_HAZARD_OVERLAP = 0.50;            // intersection / smaller area
const PROPOSAL_GEOMETRY_TOLERANCE = 1e-9;
// P-9: the only value the optional item-level hazardNotice ever carries. Clients own the wording.
const PROPOSAL_HAZARD_NOTICE_CODE = "possible_hazard_confirmation_required";
const ORDINARY_CATEGORIES = ["Recyclable", "Residual", "Biodegradable"];

function regionMetrics(a, b) {
  const intersection = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const area = (r) => (r.right - r.left) * (r.bottom - r.top);
  const contains = (p, q) => p.left <= q.left && p.top <= q.top && p.right >= q.right && p.bottom >= q.bottom;
  return { intersection, smallerArea: Math.min(area(a), area(b)), contained: contains(a, b) || contains(b, a) };
}

function nearDuplicateRegion(a, b) {
  const widths = [a.right - a.left, b.right - b.left], heights = [a.bottom - a.top, b.bottom - b.top];
  const sizeFloor = regionMetrics(a, b).contained ? PROPOSAL_DUPLICATE_CONTAINED_SIZE : PROPOSAL_DUPLICATE_SIZE;
  const t = PROPOSAL_GEOMETRY_TOLERANCE;
  return overlapRatio(a, b) >= PROPOSAL_DUPLICATE_IOU - t
    && Math.abs((a.left + a.right - b.left - b.right) / 2) <= PROPOSAL_DUPLICATE_CENTER * Math.min(...widths) + t
    && Math.abs((a.top + a.bottom - b.top - b.bottom) / 2) <= PROPOSAL_DUPLICATE_CENTER * Math.min(...heights) + t
    && Math.min(...widths) / Math.max(...widths) >= sizeFloor - t
    && Math.min(...heights) / Math.max(...heights) >= sizeFloor - t;
}

function hazardRegionOverlap(a, b) {
  const { intersection, smallerArea } = regionMetrics(a, b);
  return intersection > 0 && intersection >= PROPOSAL_HAZARD_OVERLAP * smallerArea - PROPOSAL_GEOMETRY_TOLERANCE;
}

function reconcileProposalOverlaps(owners, proposals, captureId, finalSafe = null, mode = null) {
  const mapper = require("./automaticWasteCategoryMapper");
  const { categoryAuthority } = require("./wholeImageRecognitionService");
  // Original evidence as an unclassified observation; never the display name.
  const observation = (item) => ({ ...item, category: "Unknown" });
  const label = (item) => String((item.analysisSource === "gemini_whole_image" ? item.observedIdentity
    : item.observedIdentity || item.originalItemName || item.canonicalItem) || "").trim().toLowerCase().replace(/\s+/g, " ");
  const specialIdentity = (item) => mapper.physicalSpecialWasteIdentity(observation(item));
  // X2/H1: a normalized Gemini proposal's Special Waste category comes only from the validated
  // catalog (the normalizer rejects remote categories), so it is hazard evidence too. Veto and
  // support only, never a category grant; Vision owners are unaffected.
  const hazardEvidence = (item) => !!specialIdentity(item)
    || (item.analysisSource === "gemini_whole_image" && item.category === "Special Waste")
    || (mapper.unsafeIdentity(observation(item)) && !mapper.unreliablePhysicalIdentity(observation(item)));
  const adverseState = (owner, proposal) => mapper.productStateVeto(owner, owner.category, label(proposal));
  const ordinary = (item) => ORDINARY_CATEGORIES.includes(item.category);
  // Exact helper-normalized physical identity only: no synonyms, no shared words.
  const confirmsSpecial = (owner, proposal) => owner.category === "Special Waste"
    && categoryAuthority(owner, captureId) === "independent"
    && !!specialIdentity(owner) && specialIdentity(owner) === specialIdentity(proposal);
  const agrees = (owner, proposal) => {
    const item = observation(proposal);
    if (mapper.unsafeIdentity(item) || mapper.unreliablePhysicalIdentity(item) || specialIdentity(proposal)
        || adverseState(owner, proposal)) return false;
    return label(proposal) === label(owner) || mapper.automaticCategory(item) === owner.category;
  };
  // Contradicting same-region evidence for an ordinary stream: a hazard; the
  // existing product-state veto (Residual/Recyclable only); explicit full, sealed,
  // unopened or uncertain/representational state, which that helper skips for
  // labels without a packaging word; and, because it does not cover Biodegradable,
  // a non-neutral description whose own stream differs when either is Biodegradable.
  const neutral = (proposal) => /^(?:item|object|household item|household object)$/.test(label(proposal));
  const contradicts = (owner, category, proposal) => {
    const stream = mapper.automaticCategory(observation(proposal));
    return hazardEvidence(proposal) || mapper.productStateVeto(owner, category, label(proposal))
      || /\b(?:unopened|sealed|full|filled|containing|contains|not empty|not discarded)\b/.test(label(proposal))
      || mapper.unreliablePhysicalIdentity(observation(proposal))
      || (!neutral(proposal) && (category === "Biodegradable" || stream === "Biodegradable") && stream !== category);
  };
  // F-2R: ONE standard for every credible same-region claim on an independently
  // categorized ordinary owner (strict, ambiguous strict/near, or an overlap reaching
  // the duplicate IoU), as the near one-to-one rule below already applies. The owner
  // keeps its stream only when the claim agrees (exact label or the same mapped
  // stream) or is neutral, and never when it contradicts. A description the mapper
  // cannot place is unresolved identity: it withholds the stream but proves no
  // contents, hazard or category.
  const disputesOrdinary = (owner, proposal) => contradicts(owner, owner.category, proposal)
    || !(neutral(proposal) || agrees(owner, proposal));
  // A credible competing claim on the same region (never a merge or suppression):
  // the existing duplicate IoU with the existing centre rule. A contained pair at
  // that IoU is already within 0.15 x the containing box on each axis; the
  // contained-size floor only decides whether two observations collapse into one card.
  const competingRegion = (a, b) => {
    const t = PROPOSAL_GEOMETRY_TOLERANCE;
    if (overlapRatio(a, b) < PROPOSAL_DUPLICATE_IOU - t) return false;
    if (regionMetrics(a, b).contained) return true;
    const widths = [a.right - a.left, b.right - b.left], heights = [a.bottom - a.top, b.bottom - b.top];
    return Math.abs((a.left + a.right - b.left - b.right) / 2) <= PROPOSAL_DUPLICATE_CENTER * Math.min(...widths) + t
      && Math.abs((a.top + a.bottom - b.top - b.bottom) / 2) <= PROPOSAL_DUPLICATE_CENTER * Math.min(...heights) + t;
  };
  const edges = [];
  for (const owner of owners) {
    if (!normalizeBoundingBox(owner.boundingBox)) continue;
    for (const proposal of proposals) {
      if (!proposal.boundingBox) continue;
      const kind = strictlySameRegion(owner.boundingBox, proposal.boundingBox) ? "strict"
        : nearDuplicateRegion(owner.boundingBox, proposal.boundingBox) ? "near"
        : hazardRegionOverlap(owner.boundingBox, proposal.boundingBox) ? "overlap" : "";
      if (kind) edges.push({ owner, proposal, kind });
    }
  }
  // Order-independent one-to-one test over every strict/near association.
  const associated = edges.filter((edge) => edge.kind !== "overlap");
  const oneToOne = (edge) => associated.filter((other) => other.owner === edge.owner).length === 1
    && associated.filter((other) => other.proposal === edge.proposal).length === 1;
  const suppressed = new Map(), vetoed = new Set(), observedBy = new Map();
  for (const edge of associated) {
    const { owner, proposal } = edge;
    if (!oneToOne(edge)) {
      if (ordinary(owner) && disputesOrdinary(owner, proposal)) vetoed.add(owner);
      continue;
    }
    if (confirmsSpecial(owner, proposal)) { suppressed.set(proposal, owner.itemId); continue; }
    // A strict one-to-one pair stays under merge authority for identity, but it is
    // the most credible same-object evidence: an unsupported claim fails the owner closed.
    if (edge.kind === "strict") {
      if (ordinary(owner) && disputesOrdinary(owner, proposal)) vetoed.add(owner);
      continue;
    }
    suppressed.set(proposal, owner.itemId);
    observedBy.set(owner, proposal);
    if (owner.category === "Unknown") continue;
    const supported = owner.category === "Special Waste" ? hazardEvidence(proposal) : agrees(owner, proposal);
    if (!supported) vetoed.add(owner);
  }
  // Substantial hazardous overlap below the duplicate geometry: keep both
  // observations, but never leave the ordinary owner as an unqualified stream.
  // F-2/F-3/F-2R: an overlap still reaching the duplicate IoU (nested, enclosing or
  // offset) is a credible competing claim under the same standard as a strict pair.
  for (const edge of edges) {
    if (edge.kind !== "overlap" || !ordinary(edge.owner)) continue;
    if (hazardEvidence(edge.proposal) || (competingRegion(edge.owner.boundingBox, edge.proposal.boundingBox)
        && disputesOrdinary(edge.owner, edge.proposal))) vetoed.add(edge.owner);
  }
  // G1/G1-C/F-2/F-3: an initially Unknown owner can still receive an ordinary
  // stream inside the merge from a STRICTLY aligned proposal (the only alignment
  // the merge uses to derive categories). Lacking independent category authority,
  // it keeps that stream only if every other credible claim on its region supports
  // the same single stream; otherwise conflict-mark it so the merge's existing
  // authority keeps it Unknown. Credible claims: ambiguous strict/near associations
  // and overlaps reaching the duplicate IoU. Any other substantial hazardous overlap
  // also competes, except a smaller hazard nested inside the owner below that IoU,
  // which stays a distinct object under the existing F2 geometry.
  const nestedInside = (outer, inner) => outer.left <= inner.left && outer.top <= inner.top
    && outer.right >= inner.right && outer.bottom >= inner.bottom;
  for (const owner of owners) {
    if (owner.category !== "Unknown" || vetoed.has(owner)) continue;
    const promotion = [...new Set(associated.filter((edge) => edge.owner === owner && edge.kind === "strict")
      .map((edge) => mapper.automaticCategory(observation(edge.proposal)))
      .filter((category) => ORDINARY_CATEGORIES.includes(category)))];
    if (!promotion.length) continue;
    const disputes = (proposal) => promotion.length > 1 || contradicts(owner, promotion[0], proposal)
      || mapper.automaticCategory(observation(proposal)) !== promotion[0];
    const competing = edges.some((edge) => edge.owner === owner && (edge.kind !== "overlap"
      ? !oneToOne(edge) && disputes(edge.proposal)
      : (competingRegion(owner.boundingBox, edge.proposal.boundingBox) && disputes(edge.proposal))
        || (hazardEvidence(edge.proposal) && !nestedInside(owner.boundingBox, edge.proposal.boundingBox))));
    if (competing) vetoed.add(owner);
  }
  const reconciledOwners = owners.map((owner) => {
    if (!vetoed.has(owner) && !observedBy.has(owner)) return owner;
    // Request-local copy; the legacy owner object and its evidence are never mutated.
    const copy = { ...owner };
    if (normalizationConflicts.has(owner)) normalizationConflicts.add(copy);
    const proposal = observedBy.get(owner);
    if (proposal && !copy.identityObservation) {
      copy.identityObservation = proposal.itemName;
      copy.identitySource = "gemini_whole_image";
      copy.requiresConfirmation = true;
    }
    if (vetoed.has(owner)) {
      copy.category = "Unknown";
      copy.requiresConfirmation = true;
      for (const field of ["guidance", "modelKey", "modelHotspots", "explanation", "action", "warning"]) delete copy[field];
      normalizationConflicts.add(copy);
    }
    return copy;
  });
  // F-2R: an owner failed closed here leaves its region unresolved, so no other
  // credible observation of that region (a near or competing-overlap claim) may stay
  // an actionable ordinary card. One the merge matches to an owner (samePhysicalObject,
  // which includes every strict pair) is left to the merge; one-to-one near ones were
  // removed above. Any other keeps its own ID, geometry and card, but enters the merge
  // with the owners as a conflict-marked observation so the merge's existing
  // normalization-conflict authority keeps it Unknown. Unknown and Special Waste
  // observations, and separate objects, are left untouched.
  const unresolved = new Set(edges.filter((edge) => vetoed.has(edge.owner) && (edge.kind === "near"
      || (edge.kind === "overlap" && competingRegion(edge.owner.boundingBox, edge.proposal.boundingBox))))
    .map((edge) => edge.proposal).filter((proposal) => !suppressed.has(proposal)
      && ORDINARY_CATEGORIES.includes(proposal.category)
      && !owners.some((owner) => sameObjectEitherOrder(owner, proposal))));
  // W-1: likewise, no ordinary proposal may stay an actionable stream where it substantially
  // overlaps (the existing hazard-overlap threshold) independent hazard evidence: a Special
  // Waste or hazardous-identity owner, or an unsuppressed localized hazardous proposal. Overlap
  // is not proof of one object, so it is never deleted or re-categorized here: it keeps its ID,
  // geometry and card and joins the conflict-marked observations, under the capacity rules below.
  // Pairs the existing same-object association links stay under merge authority.
  // X2/H2: suppression only removes a duplicate card; a suppressed hazard claim still anchors with
  // its own validated identity and box (it never becomes a card or lends its category).
  const hazardAnchors = owners.filter((owner) => normalizeBoundingBox(owner.boundingBox)
      && (owner.category === "Special Waste" || hazardEvidence(owner)))
    .concat(proposals.filter((proposal) => proposal.boundingBox && hazardEvidence(proposal)));
  for (const proposal of proposals) {
    if (!proposal.boundingBox || suppressed.has(proposal) || !ORDINARY_CATEGORIES.includes(proposal.category)
        || owners.some((owner) => sameObjectEitherOrder(owner, proposal))) continue;
    if (hazardAnchors.some((anchor) => anchor !== proposal && !sameObjectEitherOrder(anchor, proposal)
        && hazardRegionOverlap(anchor.boundingBox, proposal.boundingBox))) unresolved.add(proposal);
  }
  // X2/H3: merge authority can adjudicate a same-object hazard claim only one-to-one. A suppressed
  // claim never reaches the merge, and one with two or more same-object partners (owners or any
  // unsuppressed proposal, unresolved or not) is skipped there as ambiguous, recording no conflict.
  // Its ordinary same-object proposal partners then join the conflict-marked observations, so the
  // lost claim cannot leave them actionable. Set-based over complete evidence: order-independent.
  for (const hazard of proposals) {
    if (!hazard.boundingBox || !hazardEvidence(hazard)) continue;
    const ownerPartners = owners.filter((owner) => sameObjectEitherOrder(owner, hazard)).length;
    const proposalPartners = proposals.filter((other) => other !== hazard && other.boundingBox
      && !suppressed.has(other) && sameObjectEitherOrder(other, hazard));
    if (!suppressed.has(hazard) && ownerPartners + proposalPartners.length < 2) continue;
    for (const partner of proposalPartners) {
      if (ORDINARY_CATEGORIES.includes(partner.category)
          && !owners.some((owner) => sameObjectEitherOrder(owner, partner))) unresolved.add(partner);
    }
  }
  // W-7: such an observation re-describes a region its Unknown owner card already
  // shows, so it may use only capacity no other card can need. Admit them (all or
  // none, so input order never matters) only if the owners, every proposal that may
  // still need its own card (an upper bound) and these observations fit the existing
  // cap; otherwise omit them so the merge ranks only independent proposals.
  const remaining = proposals.filter((proposal) => !suppressed.has(proposal) && !unresolved.has(proposal));
  const localized = remaining.filter((proposal) => proposal.boundingBox
    && !owners.some((owner) => sameObjectEitherOrder(owner, proposal)));
  // CE-1: an ordinary proposal that samePhysicalObject places on the same object as a
  // disputed observation re-describes that unresolved region. An observation matching no
  // other one is always admitted ahead of every proposal (no owner matches it), so the
  // merge folds such a proposal into it: credit that only while no Special Waste or
  // Unknown proposal could be folded and hidden the same way.
  const disputed = [...unresolved], ordinaryProposal = (proposal) => ORDINARY_CATEGORIES.includes(proposal.category);
  const sameObject = (group, proposal) => group.some((other) => sameObjectEitherOrder(other, proposal));
  const isolated = disputed.filter((observation) => !sameObject(disputed.filter((other) => other !== observation), observation));
  const folded = localized.some((proposal) => !ordinaryProposal(proposal) && sameObject(disputed, proposal)) ? []
    : localized.filter((proposal) => ordinaryProposal(proposal) && sameObject(isolated, proposal));
  const fits = reconciledOwners.length + unresolved.size + localized.length - folded.length <= MAX_DETECTED_ITEMS;
  // Omitting the observations must not release their ordinary re-descriptions (or theirs)
  // as actionable cards that also take capacity ahead of independent objects.
  const withheld = new Set(disputed);
  for (let grew = !fits; grew;) {
    grew = false;
    for (const proposal of localized) {
      if (withheld.has(proposal) || !ordinaryProposal(proposal) || !sameObject([...withheld], proposal)) continue;
      withheld.add(proposal);
      grew = true;
    }
  }
  const observations = !fits ? [] : proposals.filter((proposal) => unresolved.has(proposal)).map((proposal) => {
    const copy = { ...proposal }; // Request-local; the normalized proposal is never mutated.
    normalizationConflicts.add(copy);
    return copy;
  });
  // MHPA2 (proposal path only): request-local admission tiers for the merge's ranked stream, used only when
  // the remaining candidates cannot all fit the existing cap. Candidate H ranks by spatial coverage, not identity.
  // Tier 0: an uncovered localized hazard claim with no same-object owner or proposal, or an uncovered disputed
  // group whose one card also covers such a claim (P-1b). Tier 1: every other uncovered unowned same-object group
  // holding hazard evidence, including an H3 claim whose ordinary copies were withheld above. Tier 2: a hazard
  // claim already spatially represented by a non-actionable Vision owner card or by a kept overlapping hazard unit
  // (P-1, P-3). Tier 3: all other candidates. Half tiers rank an at-risk unit first within its tier (P-7).
  // A group that reaches a Vision owner keeps its existing order, so owner matching and adjudication are
  // unchanged. A tier orders admission only: it never grants a category, confidence, ID, guidance or card,
  // proves no physical identity, and is never attached to an item, response or diagnostic.
  const pending = localized.filter((proposal) => !withheld.has(proposal));
  const overflow = !fits && reconciledOwners.length + pending.length > MAX_DETECTED_ITEMS;
  const tiers = new Map(), relied = new Set();
  const alt = mode || {};
  let altChanged = 0, hazardClaims = [];
  let hintable = false;
  if (overflow) {
    // FAIL-1: a strict/near owner edge recorded above (associated) is an owner association too, even when
    // samePhysicalObject does not match it; such a claim is never an independent Tier-0 unit.
    // FAIL-2: so is an overlap owner edge that the existing competingRegion rule (as F-2R uses it) treats as a
    // credible competing claim on that owner's region, e.g. a box contained below the contained-size floor.
    const ownerMatched = (proposal) => owners.some((owner) => sameObjectEitherOrder(owner, proposal))
      || associated.some((edge) => edge.proposal === proposal)
      || edges.some((edge) => edge.proposal === proposal && edge.kind === "overlap"
        && competingRegion(edge.owner.boundingBox, edge.proposal.boundingBox));
    const partnered = (claim) => proposals.some((other) => other !== claim && other.boundingBox
      && !suppressed.has(other) && sameObjectEitherOrder(other, claim));
    const pool = remaining.filter((proposal) => proposal.boundingBox && !withheld.has(proposal));
    hazardClaims = pool.filter((proposal) => hazardEvidence(proposal));
    const parent = new Map(pool.map((proposal) => [proposal, proposal]));
    const find = (node) => { while (parent.get(node) !== node) node = parent.get(node); return node; };
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
      if (!sameObjectEitherOrder(pool[i], pool[j])) continue;
      const a = find(pool[i]), b = find(pool[j]);
      if (a !== b) parent.set(a, b);
    }
    const groups = new Map();
    for (const proposal of pool) {
      const root = find(proposal);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(proposal);
    }
    // P-1 coverage: a hazard claim whose own box lies at least PROPOSAL_HAZARD_OVERLAP inside a Vision owner card
    // that this reconciler already keeps non-actionable is spatially represented by that card: failed closed above,
    // Special Waste, or Unknown with no strict ordinary promotion (the G1 promotion set). A G1-promotable Unknown
    // owner counts only when a first local merge left it Unknown or Special Waste (P-6 finalSafe); every such owner
    // consulted is recorded so the caller keeps the second result only if each one is still non-actionable.
    const promotable = (owner) => associated.some((edge) => edge.owner === owner && edge.kind === "strict"
      && ORDINARY_CATEGORIES.includes(mapper.automaticCategory(observation(edge.proposal))));
    const verifiedSafe = (owner) => !!finalSafe && finalSafe.has(owner.itemId) && !!relied.add(owner.itemId);
    const safeOwner = (owner) => vetoed.has(owner) || owner.category === "Special Waste"
      || (owner.category === "Unknown" && (!promotable(owner) || verifiedSafe(owner)));
    // Directional: measured against the claim's own area, so a small owner inside a large claim never covers it.
    const covers = (outer, inner) => regionMetrics(outer, inner).intersection
      >= PROPOSAL_HAZARD_OVERLAP * (inner.right - inner.left) * (inner.bottom - inner.top) - PROPOSAL_GEOMETRY_TOLERANCE;
    const ownerCovered = (proposal) => edges.some((edge) => edge.proposal === proposal && safeOwner(edge.owner)
      && covers(edge.owner.boundingBox, proposal.boundingBox));
    hintable = edges.some((edge) => edge.owner.category === "Unknown" && promotable(edge.owner)
      && hazardEvidence(edge.proposal) && covers(edge.owner.boundingBox, edge.proposal.boundingBox));
    const hazardMembers = (group) => group.filter((proposal) => hazardEvidence(proposal));
    const groupCovered = (group) => hazardMembers(group).every(ownerCovered);
    const uncoveredGroups = [...groups.values()].filter((group) => group.some((proposal) => hazardEvidence(proposal))
      && !group.some((proposal) => ownerMatched(proposal)) && !groupCovered(group));
    const coversAll = (group, claim) => group.every((member) => covers(member.boundingBox, claim.boundingBox));
    const servesUncovered = (group) => { const served = uncoveredGroups.flatMap(hazardMembers).filter((claim) => !group.includes(claim) && coversAll(group, claim));
      return served.length >= 2 && served.some((claim) => !uncoveredGroups.some((other) => !other.includes(claim) && coversAll(other, claim))); };
    // A covered claim keeps its own card whenever capacity remains; it only stops outranking hazard regions with no card.
    for (const group of groups.values()) {
      const associated = group.some((proposal) => ownerMatched(proposal));
      const representative = associated && !!alt.ownerAssoc && group.some((proposal) => hazardEvidence(proposal)) && servesUncovered(group);
      if (!group.some((proposal) => hazardEvidence(proposal)) || (associated && !representative)) continue;
      if (representative) altChanged++;
      const tier = !representative && groupCovered(group) && (alt.h || !servesUncovered(group)) ? 2 : group.length === 1 && !partnered(group[0]) ? 0 : 1;
      for (const proposal of group) tiers.set(proposal, tier === 2 && !hazardEvidence(proposal) ? 3 : tier);
    }
    const tierOf = (proposal) => (tiers.has(proposal) ? tiers.get(proposal) : 3);
    const area = (proposal) => (proposal.boundingBox.right - proposal.boundingBox.left)
      * (proposal.boundingBox.bottom - proposal.boundingBox.top);
    const geometryKey = (proposal) => { const box = proposal.boundingBox; return [box.left, box.top, box.right, box.bottom, label(proposal)]; };
    const compareKeys = (x, y) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
    // A transitive same-object chain can still yield a second card for one disputed region: a non-hazard member that
    // is not same-object with the group's strict clique but lies inside every clique member ranks with ordinary items.
    // Strict pairs are untouched, so the existing card identity of a disputed pair does not change.
    for (const group of groups.values()) {
      if (group.length < 2 || !group.some((proposal) => tierOf(proposal) <= 1)) continue;
      const clique = [];
      for (const member of [...group].sort((a, b) => area(b) - area(a) || compareKeys(geometryKey(a), geometryKey(b)))) {
        if (clique.every((other) => sameObjectEitherOrder(other, member))) { clique.push(member); continue; }
        if ((!alt.h || !hazardEvidence(member)) && clique.every((other) => covers(other.boundingBox, member.boundingBox))) tiers.set(member, !alt.h && hazardEvidence(member) ? 2 : 3);
      }
    }
    // Hazard units still ranked 0 or 1, compared by tier, then by the existing validated catalog category, then geometry.
    const unitTier = (group) => Math.min(...group.map(tierOf));
    const unitArea = (group) => Math.max(...hazardMembers(group).map(area));
    const unitCatalog = (group) => Number(hazardMembers(group).some((proposal) => proposal.category !== "Unknown"));
    const unitGeometry = (group) => hazardMembers(group).map(geometryKey).sort()[0];
    const byTierAreaCatalog = (a, b) => unitTier(a) - unitTier(b) || unitArea(b) - unitArea(a)
      || unitCatalog(b) - unitCatalog(a) || compareKeys(unitGeometry(a), unitGeometry(b));
    const units = [...groups.values()].filter((group) => group.some((proposal) => tierOf(proposal) <= 1)).sort(byTierAreaCatalog);
    // P-1b: an uncovered disputed group whose every member covers an uncovered independent claim ranks as
    // independent, so its one card represents both regions.
    for (const group of units) {
      if (unitTier(group) !== 1) continue;
      const outer = units.some((unit) => unit !== group && unitTier(unit) === 0 && hazardMembers(unit)
        .every((proposal) => group.every((other) => covers(other.boundingBox, proposal.boundingBox))));
      if (outer) for (const proposal of group) if (tiers.get(proposal) === 1) tiers.set(proposal, 0);
    }
    // P-3 (narrowed): no size preference between near-identical claims. Re-order with the updated tiers, then rank by
    // catalog category and geometry (Array.prototype.sort is stable, so equal keys keep the previous order).
    units.sort(byTierAreaCatalog);
    units.sort((a, b) => unitTier(a) - unitTier(b) || unitCatalog(b) - unitCatalog(a) || compareKeys(unitGeometry(a), unitGeometry(b)));
    const demote = (group) => { for (const proposal of group) tiers.set(proposal, hazardEvidence(proposal) ? 2 : 3); };
    const coverers = (unit) => (alt.groupHazardOnly ? hazardMembers(unit) : unit);
    if (alt.groupHazardOnly && units.some((unit) => hazardMembers(unit).length !== unit.length)) altChanged++;
    const inside = (inner, outer) => hazardMembers(inner)
      .every((proposal) => coverers(outer).every((other) => covers(other.boundingBox, proposal.boundingBox)));
    const relevant = units.flatMap(hazardMembers);
    const coverage = (unit) => new Set(relevant.filter((claim) => hazardMembers(unit).includes(claim)
      || coverers(unit).every((other) => covers(other.boundingBox, claim.boundingBox))));
    const preserves = (inner, outer) => { const kept = coverage(outer); return [...coverage(inner)].every((claim) => kept.has(claim)); };
    let kept = [];
    for (const group of units) {
      if (kept.some((other) => inside(group, other) && (alt.h || preserves(group, other)))) demote(group); else kept.push(group);
    }
    // A kept unit strictly inside another kept unit of no lower priority is covered only by that container's card.
    for (const group of [...kept].sort((a, b) => unitArea(b) - unitArea(a))) {
      const container = kept.find((other) => other !== group && unitTier(other) <= unitTier(group)
        && inside(group, other) && (alt.h ? !inside(other, group) : (preserves(group, other) && (!inside(other, group) || !preserves(other, group)))));
      if (container) { demote(group); kept = kept.filter((other) => other !== group); }
    }
    if (alt.union) for (const group of [...kept].sort((a, b) => unitTier(b) - unitTier(a) || unitCatalog(a) - unitCatalog(b) || compareKeys(unitGeometry(a), unitGeometry(b)))) {
      const others = kept.filter((other) => other !== group), union = new Set(others.flatMap((other) => [...coverage(other)]));
      if (others.some((other) => unitTier(other) <= unitTier(group) && inside(group, other)) && [...coverage(group)].every((claim) => union.has(claim))) { demote(group); kept = others; altChanged++; }
    }
    // P-7: within its tier, a unit whose only apparent cover is a G1-promotable Unknown owner (which the merge may
    // still make actionable) is admitted first. This is coverage state, not hazard severity.
    const atRisk = (group) => group.some((proposal) => hazardEvidence(proposal) && edges.some((edge) => edge.proposal === proposal
      && edge.owner.category === "Unknown" && promotable(edge.owner) && !(finalSafe && finalSafe.has(edge.owner.itemId))
      && covers(edge.owner.boundingBox, proposal.boundingBox)));
    for (const group of kept) {
      const tier = unitTier(group);
      if (tier <= 1 && atRisk(group)) for (const proposal of group) if (tiers.get(proposal) === tier) tiers.set(proposal, tier - 0.5);
    }
  }
  // retry and relied are request-local caller hints (P-6); they never reach an item, response or diagnostic.
  // localizedHazards (P-8): every localized hazard claim, the same proposal set W-1 anchors on (suppressed claims
  // included), whether or not the cap overflows. Read only by the post-selection hold; never a card or a field.
  return { owners: reconciledOwners.concat(observations),
    proposals: remaining.filter((proposal) => !withheld.has(proposal)), suppressed,
    admission: { tier: (item) => (tiers.has(item) ? tiers.get(item) : 3) }, retry: hintable && !finalSafe, relied, altChanged, hazardClaims,
    localizedHazards: proposals.filter((proposal) => proposal.boundingBox && hazardEvidence(proposal)) };
}

// Diagnostic-only physical association. Never renames, re-categorizes, reorders
// or re-owns any item, and never changes the primary or its history record.
function primaryObjectLink(primary, proposals, primaryIndex, detectedItems, captureId, suppressed = new Map()) {
  if (primaryIndex === null) return "none";
  const proposal = proposals[primaryIndex];
  if (!proposal || !proposal.boundingBox) return "unresolved";
  const sameRegion = (a, b) => !!normalizeBoundingBox(a) && !!normalizeBoundingBox(b) && strictlySameRegion(a, b);
  // A removed proposal resolves only through its single recorded owner, never by its own ID.
  const candidates = suppressed.has(proposal)
    ? detectedItems.filter((item) => item.itemId === suppressed.get(proposal))
    : detectedItems.filter((item) => item.itemId === proposal.itemId
      || (item.analysisSource === "google_vision_object_localization" && sameRegion(item.boundingBox, proposal.boundingBox)));
  if (candidates.length !== 1) return candidates.length ? "ambiguous" : "unresolved";
  const owner = candidates[0];
  if (proposals.some((other) => other !== proposal && other.boundingBox && sameRegion(other.boundingBox, owner.boundingBox))) {
    return "ambiguous";
  }
  if (require("./wholeImageRecognitionService").identityConflict(owner, captureId)) return "identity_conflict";
  if (owner.category !== "Unknown" && owner.category !== primary.category) return "category_conflict";
  const { unsafeIdentity } = require("./automaticWasteCategoryMapper");
  if (primary.category !== "Special Waste"
      && (unsafeIdentity({ ...owner, category: "Unknown" }) || unsafeIdentity({ ...proposal, category: "Unknown" }))) {
    return "safety_conflict";
  }
  return "linked";
}

async function analyzeWasteWithObjectProposals(input, context) {
  // Same bounded classifier budget and no direct-Gemini fallback as the existing
  // discovery path. Vision keeps its existing single bounded call and schedule.
  const legacy = await analyzeWasteLegacy({ ...input, boundedDiscovery: true }, context);
  const legacyResult = () => withDisplayNames(reconcilePrimary(legacy, legacy.detectedItems || []));
  // P-8 downgrade shape for a held card (a request-local copy): Unknown, confirmation required, no guidance, model,
  // hotspot or text fields; ID, name, geometry, confidence and provenance are kept.
  const holdCard = (item) => {
    const copy = { ...item, category: "Unknown", requiresConfirmation: true };
    for (const field of ["guidance", "modelKey", "modelHotspots", "explanation", "action", "warning"]) delete copy[field];
    return copy;
  };
  // P-9: the only place the fixed-code notice is written, on request-local copies; nothing else on a card changes.
  const withNotices = (items, ids) => (ids.size ? items.map((item) => (ids.has(item.itemId)
    ? { ...item, hazardNotice: { code: PROPOSAL_HAZARD_NOTICE_CODE } } : item)) : items);
  if (!context.primaryValid) { proposalDiagnostics({ status: "primary_unavailable" }); return legacyResult(); }
  if (context.raw === undefined) { proposalDiagnostics({ status: "absent" }); return legacyResult(); }
  let proposals;
  try { proposals = normalizeObjectProposals(context.capture, context.raw); }
  catch (_) { proposalDiagnostics({ status: "rejected" }); return legacyResult(); }
  // hazardConflict: set only when this request's own A9 result shows a safety conflict with accepted hazard claims.
  // hazardSafeFallback is assigned inside the try (it uses its helpers) and also serves the generic catch below.
  // anchoredOnHazard: the classifier's own primary anchor shares the region of an accepted, localized hazard claim.
  let detectedItems, reconciled, noticed = new Set(), hazardConflict = false, hazardSafeFallback = null, anchoredOnHazard = false;
  const discovery = require("./wholeImageRecognitionService");
  try {
    // A9 (owner policy D-A / D-B / D-C): the base is Candidate H's own tiers with the P-2c matcher. A fixed, bounded list
    // of local alternatives (A5 rules and its union / group / owner-association modes, the unranked X2 order on the same
    // reconciled owners, each admitted card moved last, each other proposal moved first) is merged locally. An alternative
    // is adopted only when its actual final items are strictly safer than the base: no represented hazard claim, fully
    // covered region or touched region of the base is lost, no hazard claim becomes actionable-only, no more strictly
    // redundant cards, Vision owners byte-identical, and a hazard that loses its own card stays covered by a
    // hazard-labelled non-actionable card and only for a region gain (an ordinary-labelled or Vision cover never replaces
    // an identity). The first adopted alternative that no other adopted alternative is strictly safer than wins (list
    // order); otherwise the base stands. Local merges only; no new fields, provider calls or category grants.
    const conflict = (item) => normalizationConflicts.has(item);
    const coversClaim = (outer, inner) => regionMetrics(outer, inner).intersection
      >= PROPOSAL_HAZARD_OVERLAP * (inner.right - inner.left) * (inner.bottom - inner.top) - PROPOSAL_GEOMETRY_TOLERANCE;
    const regionsOf = (hazards) => { const parent = hazards.map((_, i) => i), find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      for (let i = 0; i < hazards.length; i++) for (let j = i + 1; j < hazards.length; j++)
        if (hazardRegionOverlap(hazards[i].boundingBox, hazards[j].boundingBox)) parent[find(i)] = find(j);
      return new Map(hazards.map((claim, i) => [claim.itemId, find(i)])); };
    const safeCard = (item) => item.category === "Unknown" || item.category === "Special Waste";
    // P-9 notice selection: a localized hazard claim marks its own retained card; a claim without one marks every
    // Unknown or Special Waste card covering it (the coverState rule below). Claims that no card covers stay unmarked
    // (they are not attributed to an unrelated card).
    const noticeIds = (items) => {
      const ids = new Set(), retained = new Set(items.map((item) => item.itemId));
      for (const claim of reconciled.localizedHazards) {
        if (retained.has(claim.itemId)) { ids.add(claim.itemId); continue; }
        for (const item of items) {
          if (item.boundingBox && safeCard(item) && coversClaim(item.boundingBox, claim.boundingBox)) ids.add(item.itemId);
        }
      }
      return ids;
    };
    // The classifier's own validated primaryObjectIndex anchor box (null when the index is absent or names an
    // unlocalized proposal). It is the only link between the independent primary and a region: labels and categories
    // never link them.
    const anchor = proposals.primaryIndex === null ? null : proposals.objects[proposals.primaryIndex];
    const anchorBox = anchor && anchor.boundingBox ? anchor.boundingBox : null;
    // Two-way region test (coversClaim in either direction): the anchor covers >= 50 % of a claim, or a claim covers
    // >= 50 % of the anchor (a small object inside a large hazard region).
    const anchorShares = (claims) => !!anchorBox && claims.some((claim) => coversClaim(anchorBox, claim.boundingBox)
      || coversClaim(claim.boundingBox, anchorBox));
    // Hazard-safe exceptional fallback, used by the two guards below, where this request's own A9 result shows a
    // safety conflict with accepted, localized hazard claims (validated, capture-bound proposals), and by the generic
    // catch once such claims are known. It returns the feature-OFF cards and primary, but fails closed for every "open"
    // claim, one that no Unknown or Special Waste feature-OFF card covers:
    // - each ordinary feature-OFF card covering an open claim is held in the P-8 downgrade shape;
    // - an ordinary classifier primary is held in the existing Unknown primary shape, unless the classifier's own
    //   primaryObjectIndex places it on a localized object sharing no open claim's region (the two-way test above). An
    //   unlocalized primary describes the whole image, which covers every claim; matching labels or categories never
    //   link it to a card.
    // P-9 notices follow the accepted-path rule. No card, category grant, identity, confidence, field or provider call is
    // added; card IDs, order, names and geometry are kept. Every other card is unchanged.
    hazardSafeFallback = () => {
      const items = legacy.detectedItems || [];
      const open = reconciled.localizedHazards.filter((claim) => !items.some((item) => item.boundingBox && safeCard(item)
        && coversClaim(item.boundingBox, claim.boundingBox)));
      const coversOpen = (box) => !!box && open.some((claim) => coversClaim(box, claim.boundingBox));
      const cards = items.map((item) => (ORDINARY_CATEGORIES.includes(item.category) && coversOpen(item.boundingBox)
        ? holdCard(item) : item));
      let primary = reconcilePrimary(legacy, cards);
      if (open.length && ORDINARY_CATEGORIES.includes(primary.category) && (!anchorBox || anchorShares(open))) {
        primary = { ...primary, category: "Unknown", ...UNKNOWN_PRIMARY_GUIDANCE };
      }
      return withDisplayNames({ ...primary, detectedItems: withNotices(cards, noticeIds(cards)), scanSummary: buildScanSummary(cards) });
    };
    const coverState = (items, hazards, regionOf) => {
      const hazardIds = new Set(hazards.map((claim) => claim.itemId)), rep = new Set(), act = new Set(), own = new Set(), hazardCover = new Set(), labelCover = new Set(), regions = new Map();
      const covering = (claim, list) => list.filter((item) => item.boundingBox && (item.itemId === claim.itemId || coversClaim(item.boundingBox, claim.boundingBox)));
      for (const claim of hazards) { const cover = covering(claim, items), safe = cover.filter(safeCard), region = regionOf.get(claim.itemId);
        if (!regions.has(region)) regions.set(region, []); regions.get(region).push(claim.itemId);
        if (safe.length) { rep.add(claim.itemId); if (safe.some((item) => item.itemId === claim.itemId)) own.add(claim.itemId);
          if (safe.some((item) => item.itemId !== claim.itemId && item.analysisSource === "gemini_whole_image" && hazardIds.has(item.itemId))) hazardCover.add(claim.itemId);
          if (safe.some((item) => item.itemId !== claim.itemId && item.analysisSource === "gemini_whole_image" && item.observedIdentity === claim.observedIdentity)) labelCover.add(claim.itemId); }
        else if (cover.length) act.add(claim.itemId); }
      const complete = new Set(), touched = new Set();
      for (const [region, ids] of regions) { const n = ids.filter((id) => rep.has(id)).length; if (n === ids.length) complete.add(region); if (n) touched.add(region); }
      let redundant = 0;
      if (rep.size < hazards.length) for (const card of items) { if (card.analysisSource !== "gemini_whole_image" || !safeCard(card)) continue;
        const rest = items.filter((item) => item !== card);
        if (hazards.every((claim) => !rep.has(claim.itemId) || covering(claim, rest).some(safeCard))) redundant++; }
      return { rep, act, own, hazardCover, labelCover, complete, touched, redundant }; };
    const within = (a, b) => [...a].every((x) => b.has(x));
    const safer = (c, b) => {
      if (!(within(b.rep, c.rep) && within(b.complete, c.complete) && within(b.touched, c.touched) && within(c.act, b.act) && c.redundant <= b.redundant)) return false;
      const regionGain = c.complete.size > b.complete.size || c.touched.size > b.touched.size, lost = [...b.own].filter((id) => !c.own.has(id) && !c.labelCover.has(id));
      if (lost.length && !(regionGain && lost.every((id) => c.hazardCover.has(id)))) return false;
      return c.rep.size > b.rep.size || regionGain || c.act.size < b.act.size || c.redundant < b.redundant || (within(b.own, c.own) && c.own.size > b.own.size); };
    const visionKey = (items) => JSON.stringify(items.filter((item) => item.analysisSource === "google_vision_object_localization"));
    const tierKey = (rec) => rec.proposals.map((proposal) => proposal.itemId + ":" + rec.admission.tier(proposal)).join("|");
    const MODES = [{}, { union: true, groupHazardOnly: true }, { ownerAssoc: true }];
    const pass = (finalSafe) => {
      reconciled = reconcileProposalOverlaps(legacy.detectedItems || [], proposals.objects, context.capture.captureId, finalSafe, { h: true });
      const matcher = createMergeMatcher(reconciled.owners);
      const items = discovery.merge(reconciled.owners, reconciled.proposals, matcher, context.capture, conflict, reconciled.admission);
      const baseRec = reconciled, hazards = baseRec.hazardClaims;
      if (!hazards.length) return [baseRec, items];
      const regionOf = regionsOf(hazards), base = coverState(items, hazards, regionOf);
      if (base.own.size === hazards.length) return [baseRec, items];   // every hazard already shows its own card
      const baseVision = visionKey(items), seen = new Set([tierKey(baseRec)]), adopted = [];
      const consider = (rec, candidateItems, label) => { if (visionKey(candidateItems) !== baseVision) return;
        const state = coverState(candidateItems, hazards, regionOf); if (safer(state, base)) adopted.push({ rec, items: candidateItems, state, label }); };
      for (const mode of MODES) {
        const candidate = reconcileProposalOverlaps(legacy.detectedItems || [], proposals.objects, context.capture.captureId, finalSafe, mode);
        const key = tierKey(candidate); if (seen.has(key)) continue; seen.add(key);
        consider(candidate, discovery.merge(candidate.owners, candidate.proposals, createMergeMatcher(candidate.owners), context.capture, conflict, candidate.admission), "mode");
      }
      const tier = (proposal) => baseRec.admission.tier(proposal);
      const ranked = baseRec.proposals.map((proposal, index) => ({ proposal, index })).sort((a, b) => tier(a.proposal) - tier(b.proposal) || a.index - b.index).map((entry) => entry.proposal);
      const moved = (target, value) => discovery.merge(baseRec.owners, baseRec.proposals, matcher, context.capture, conflict, { tier: (proposal) => (proposal === target ? value : tier(proposal)) });
      consider(baseRec, discovery.merge(baseRec.owners, baseRec.proposals, matcher, context.capture, conflict), "x2order");
      const admitted = new Set(items.filter((item) => item.analysisSource === "gemini_whole_image").map((item) => item.itemId));
      for (const proposal of ranked) if (admitted.has(proposal.itemId)) consider(baseRec, moved(proposal, 1e9), "demote");
      for (const proposal of ranked) if (!admitted.has(proposal.itemId) && proposal.boundingBox) consider(baseRec, moved(proposal, -1e9), "promote");
      const maximal = adopted.filter((a) => !adopted.some((b) => b !== a && safer(b.state, a.state))), best = maximal[0];
      return best ? [best.rec, best.items] : [baseRec, items];
    };
    [reconciled, detectedItems] = pass(null);
    // P-6: when a hazard claim's only cover is a G1-promotable Unknown owner, re-rank once using the owners this
    // local merge actually left Unknown or Special Waste. The second result is kept only if every owner it relied
    // on is still Unknown or Special Waste in it; otherwise the first result stands. No provider is called again.
    if (reconciled.retry) {
      const safeOwnerIds = (items) => new Set(items.filter((item) => item.analysisSource === "google_vision_object_localization"
        && (item.category === "Unknown" || item.category === "Special Waste")).map((item) => item.itemId));
      const first = reconciled;
      const [second, again] = pass(safeOwnerIds(detectedItems));
      reconciled = first;
      const stillSafe = safeOwnerIds(again);
      if ([...second.relied].every((id) => stillSafe.has(id))) { reconciled = second; detectedItems = again; }
    }
    // P-8 G1 hazard hold, on the final selection after P-6. The merge's G1 derivation can give an initially Unknown
    // Vision owner an ordinary stream while a localized hazard claim in its region was left without any Unknown or
    // Special Waste card, its own or a covering one (the coverState rule above). Every ordinary card covering such
    // a claim fails closed. If its stream came from G1 (the owner entered the merge Unknown), it becomes a
    // request-local copy in the merge's own downgrade shape: Unknown, confirmation required, no guidance, model,
    // hotspot or text fields; ID, name, geometry, confidence and provenance are kept. Any other ordinary cover is
    // never rewritten in the A9 result: the whole request takes the hazard-safe fallback (feature-OFF cards and primary,
    // failing closed on open claims). A claim that already has a safe card changes nothing (G1 controls E/F). Selection
    // and every other card are unchanged; no category is granted.
    const premerge = new Map(reconciled.owners.filter((owner) => owner.analysisSource === "google_vision_object_localization")
      .map((owner) => [owner.itemId, owner]));
    const held = new Set();
    for (const claim of reconciled.localizedHazards) {
      const cover = detectedItems.filter((item) => item.boundingBox
        && (item.itemId === claim.itemId || coversClaim(item.boundingBox, claim.boundingBox)));
      if (cover.some(safeCard)) continue;
      for (const item of cover) {
        if (item.analysisSource !== "google_vision_object_localization" || premerge.get(item.itemId)?.category !== "Unknown") {
          proposalDiagnostics({ status: "merge_failed" });
          hazardConflict = true;
          return hazardSafeFallback();
        }
        held.add(item.itemId);
      }
    }
    if (held.size) detectedItems = detectedItems.map((item) => (held.has(item.itemId) ? holdCard(item) : item));
    // P-9 hazard notice, chosen on the final cards after the hold (noticeIds above). The notice is one fixed code: no
    // proposal label, provider text, confidence or category; nothing else on the card changes. A marked card must be
    // non-actionable: an ordinary own card takes the hazard-safe fallback.
    noticed = noticeIds(detectedItems);
    if (detectedItems.some((item) => noticed.has(item.itemId) && !safeCard(item))) {
      proposalDiagnostics({ status: "merge_failed" });
      hazardConflict = true;
      return hazardSafeFallback();
    }
    anchoredOnHazard = anchorShares(reconciled.localizedHazards);
  } catch (error) {
    // A failure while building the hazard-safe fallback must not return the feature-OFF result it replaces: the
    // request fails closed (the route answers ANALYSIS_UNAVAILABLE).
    if (hazardConflict) throw error;
    proposalDiagnostics({ status: "merge_failed" });
    // Any other unexpected failure once this request's accepted, localized hazard claims are known takes the
    // hazard-safe fallback; a failure while building it propagates (fails closed, as above). Without such claims, or
    // before the first reconciliation has produced them, the existing feature-OFF fallback is kept.
    if (hazardSafeFallback && reconciled && reconciled.localizedHazards.length) return hazardSafeFallback();
    return legacyResult();
  }
  const primary = reconcilePrimary(legacy, detectedItems);
  // A valid classifier primary is returned unchanged (except for the anchored hold below); proposals never create one.
  if (primary !== legacy) { proposalDiagnostics({ status: "merge_failed" }); return legacyResult(); }
  let primaryLink = "not_evaluated";
  try {
    primaryLink = primaryObjectLink(primary, proposals.objects, proposals.primaryIndex, detectedItems,
      context.capture.captureId, reconciled.suppressed);
  }
  catch (_) { /* Optional diagnostic only. */ }
  const visionOwned = detectedItems.filter((item) => item.analysisSource === "google_vision_object_localization");
  proposalDiagnostics({ status: "accepted", proposals: proposals.objects.length,
    localized: proposals.objects.filter((item) => item.boundingBox).length, physical: detectedItems.length,
    visionOwned: visionOwned.length,
    geminiOwned: detectedItems.filter((item) => item.analysisSource === "gemini_whole_image").length,
    alignedVisionOwners: visionOwned.filter((item) => !!discovery.alignedIdentity(item, context.capture.captureId)).length,
    finalUnknown: detectedItems.filter((item) => item.category === "Unknown").length, primaryLink });
  // P-9: the notice is attached last, on request-local copies (as withDisplayNames makes), so the primary check and
  // the diagnostics above read exactly the P-8 cards and their capture-bound evidence.
  detectedItems = withNotices(detectedItems, noticed);
  // Classifier-anchored primary hold, the one narrow exception to the independent-primary contract: when the
  // classifier's own validated primaryObjectIndex places its primary on a localized object sharing the region of an
  // accepted, localized hazard claim (the two-way test), an ordinary stream is withheld with the existing Unknown
  // primary text. It is applied after the primary check and the diagnostics, so logs and primary_link are unchanged.
  // Identity and provenance are kept; it never grants Special Waste and changes no card. An unanchored primary (no
  // index, or an index on an unlocalized proposal) keeps the existing contract.
  const shown = anchoredOnHazard && ORDINARY_CATEGORIES.includes(primary.category)
    ? { ...primary, category: "Unknown", ...UNKNOWN_PRIMARY_GUIDANCE } : primary;
  return withDisplayNames({ ...shown, detectedItems, scanSummary: buildScanSummary(detectedItems) });
}

async function analyzeWaste(input, { proposalSession } = {}) {
  if(process.env.WHOLE_IMAGE_DISCOVERY_ENABLED!=="true" || !input.objectDiscovery || !input.principal) {
    // Backend flag OFF (default) returns null without any work or logging.
    const proposalContext = objectProposalContext(input, proposalSession);
    if (proposalContext) return analyzeWasteWithObjectProposals(input, proposalContext);
    const legacy = await analyzeWasteLegacy(input);
    return withDisplayNames(reconcilePrimary(legacy, legacy.detectedItems || []));
  }
  const discovery=require("./wholeImageRecognitionService");
  // One attempt per capture, concurrently with primary classification; optional failure is isolated.
  let discoveryFailure;
  const observations=discovery.discoverObjects({...input.objectDiscovery,image:input.image},{principal:input.principal,signal:input.signal})
    .then(result=>result.objects).catch(error=>{
      discoveryFailure="failed";
      try {discoveryFailure=require("./wasteAssessmentDiagnostics").discoveryFailureStatus(error);}
      catch (_) { /* Preserve the original discovery fallback. */ }
      return [];
    });
  const legacy=await analyzeWasteLegacy({...input,boundedDiscovery:true});
  const objects=await observations;
  const detectedItems=discovery.merge(legacy.detectedItems || [],objects,samePhysicalObject,input.objectDiscovery,
    item=>normalizationConflicts.has(item));
  let primary=reconcilePrimary(legacy,detectedItems);
  // A versioned sidecar never changes detection v1 IDs, categories or metadata.
  let categoryAssessments=null;
  if(process.env.WASTE_ITEM_ASSESSMENT_ENABLED==="true") {
    try {categoryAssessments=await require("./perItemWasteAssessmentService").assessCapture({capture:{...input.objectDiscovery,image:input.image},items:detectedItems,primary,principal:input.principal,signal:input.signal});}
    catch(_) { /* Optional assessment failure must never replace a valid primary scan. */ }
    try {require("./wasteAssessmentDiagnostics").logAssessment(categoryAssessments,detectedItems.length,undefined,detectedItems);}
    catch (_) { /* Diagnostic sink failures do not affect analysis. */ }
  }
  if(input.independentCategoryV2 && categoryAssessments?.schemaVersion===1
      && categoryAssessments.captureId===input.objectDiscovery.captureId) {
    const rows=categoryAssessments.items,counts=new Map();
    for(const row of rows)counts.set(row.itemId,(counts.get(row.itemId)||0)+1);
    for(const item of detectedItems) {
      const row=rows.find(row=>row.itemId===item.itemId);
      if(item.analysisSource!=="gemini_whole_image" || item.category!=="Unknown"
          || counts.get(item.itemId)!==1 || row?.assessmentSource!=="reviewed_identity_rule"
          || !isValidCategory(row.category) || !row.requiresConfirmation)continue;
      // Promote only the same localized object's original deterministic mapping;
      // no identity, geometry, provider, or independent object's category transfer.
      if(automaticCategory(item)===row.category
          && !discovery.identityConflict(item,input.objectDiscovery.captureId)
          && !productStateVeto(item,row.category,discovery.alignedIdentity(item,input.objectDiscovery.captureId)))item.category=row.category;
    }
    primary=reconcilePrimary(legacy,detectedItems);
  }
  try {
    require("./wasteAssessmentDiagnostics").logDiscovery(discoveryFailure,objects,detectedItems,
      item=>!!discovery.alignedIdentity(item,input.objectDiscovery.captureId),console);
  } catch (_) { /* Discovery diagnostics are independent of assessment and best effort. */ }
  return withDisplayNames({...primary,detectedItems,scanSummary:buildScanSummary(detectedItems),identityObservations:objects.filter(item=>!item.boundingBox),...(categoryAssessments?{categoryAssessments}:{})});
}

module.exports = {
  samePhysicalObject,
  analyzeWaste,
  normalizeDetectedItems,
  buildScanSummary,
  MIN_OBJECT_CONFIDENCE,
  MAX_DETECTED_ITEMS
};
