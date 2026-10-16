const analysisLog = process.env.WMO_DEPLOYMENT_MODE === "staging" && process.env.STAGING_WASTE_SCAN_ONLY === "true" ? {
  log() {},
  warn() { console.warn("[Staging] Waste analysis warning."); },
  error() { console.error("[Staging] Waste analysis error."); }
} : console;
const http = require("http");
const https = require("https");
const { detectObjectsFromBase64, normalizeBoundingBox, OBJECT_LOCALIZATION_TIMEOUT_MS } = require("./googleVisionService");
const { getWasteLearningGuide } = require("./wasteLearningGuideService");

const {
  analyzeWasteByObject,
  getFallbackResult,
  mapWasteCategory,
  normalizeText
} = require("../utils/wasteMapper");

const MIN_OBJECT_CONFIDENCE = 0.40;
const MAX_DETECTED_ITEMS = 8;
const DUPLICATE_OVERLAP_THRESHOLD = 0.70;

function overlapRatio(a, b) {
  const intersection = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const area = (box) => (box.right - box.left) * (box.bottom - box.top);
  return intersection / (area(a) + area(b) - intersection);
}

// Provider aliases describe the same bottle/container silhouette, not its material.
const GENERIC_CONTAINER_NAMES = new Set(["bottle", "bottles", "jar", "jars", "container", "can", "bottled and jarred packaged goods"]);
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
function samePhysicalObject(a, b) {
  const x = a.boundingBox, y = b.boundingBox;
  if (!x || !y) return false;
  // Independent providers can disagree on identity while localizing the same
  // object. Require nearly identical extents and centers for a name-free match;
  // different-size nested objects and partial overlaps must remain independent.
  const sources = new Set([a.analysisSource, b.analysisSource]);
  if (sources.has("gemini_whole_image") && sources.has("google_vision_object_localization")
      && overlapRatio(x, y) >= .90
      && Math.abs((x.left + x.right - y.left - y.right) / 2) <= .05 * Math.min(x.right - x.left, y.right - y.left)
      && Math.abs((x.top + x.bottom - y.top - y.bottom) / 2) <= .05 * Math.min(x.bottom - x.top, y.bottom - y.top)) return true;
  if (!similarObjectNames(a.canonicalItem, b.canonicalItem)) return false;
  if (overlapRatio(x, y) >= DUPLICATE_OVERLAP_THRESHOLD) return true;
  const area = (box) => (box.right - box.left) * (box.bottom - box.top);
  const intersection = Math.max(0, Math.min(x.right, y.right) - Math.max(x.left, y.left))
    * Math.max(0, Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top));
  const small = Math.min(area(x), area(y)), large = Math.max(area(x), area(y));
  // Similar-size, almost-contained, centered aliases. Small nested objects survive.
  return small / large >= .65 && intersection / small >= .90
    && Math.abs((x.left + x.right - y.left - y.right) / 2) <= .15 * Math.min(x.right - x.left, y.right - y.left)
    && Math.abs((x.top + x.bottom - y.top - y.bottom) / 2) <= .15 * Math.min(x.bottom - x.top, y.bottom - y.top);
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
    // Banana is a common localized object name; map its waste form through the existing rules.
    const mapped = analyzeWasteByObject(canonicalItem === "banana" ? "banana peel" : canonicalItem);
    const classifierCategory = allowClassifierCategory ? normalizeCategory(object.category) : null;
    let category = mapped?.category === "Special Waste" || classifierCategory === "Special Waste"
      ? "Special Waste" : classifierCategory || mapped?.category;
    // A generic localized silhouette does not establish material or contamination.
    if (!classifierCategory && GENERIC_CONTAINER_NAMES.has(canonicalItem)) category = "Unknown";
    if (!isValidCategory(category) && category !== "Unknown") return [];
    const details = allowClassifierCategory ? Object.fromEntries(
      ["explanation", "action", "warning"].filter((key) => typeof object[key] === "string" && object[key].trim())
        .map((key) => [key, object[key]])
    ) : {};
    const { modelKey = "", modelHotspots = [], ...guidance } = category === "Unknown" ? {} : getWasteLearningGuide(canonicalItem, category);
    return [{ index, itemName: name, canonicalItem, category, confidence,
      analysisSource, boundingBox, modelKey, guidance, modelHotspots, ...details }];
  });
  // Safety and supported specificity precede confidence; geometry decides duplication.
  candidates.sort((a, b) => Number(b.category === "Special Waste") - Number(a.category === "Special Waste")
    || Number(GENERIC_CONTAINER_NAMES.has(a.canonicalItem)) - Number(GENERIC_CONTAINER_NAMES.has(b.canonicalItem))
    || b.confidence - a.confidence
    || b.canonicalItem.split(" ").length - a.canonicalItem.split(" ").length
    || a.index - b.index);
  const retained = [];
  for (const candidate of candidates) {
    if (retained.some((other) => samePhysicalObject(candidate, other))) continue;
    retained.push(candidate);
    if (retained.length === MAX_DETECTED_ITEMS) break;
  }
  return retained.sort((a, b) => a.index - b.index).map(({ index, ...item }, position) => ({
    itemId: `item_${position + 1}`, ...item
  }));
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
  return { ...result, detectedItems, scanSummary: buildScanSummary(detectedItems) };
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
    analysisLog.warn("[WasteAnalysis] Object localization unavailable; keeping primary classification.");
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
    analysisLog.warn("[WasteAnalysis] Multi-item enrichment unavailable; keeping legacy result.");
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
  analysisLog.warn("[WasteAnalysis] Local Gemini service not loaded:", error.message);
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
    analysisLog.error("[WasteAnalysis] mapWasteCategory error:", error.message);
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
    analysisLog.error("[WasteAnalysis] analyzeWasteByObject error:", error.message);
  }

  return null;
}

function postJson(urlString, payload, timeoutMs = 35000, invocationHeaders = {}, signal) {
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

    if (signal?.aborted) return reject(new Error("Classifier request cancelled."));
    let timer;
    const abort = () => req.destroy(new Error("Classifier request cancelled."));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const req = client.request(options, (res) => {
      let rawData = "";

      res.on("data", (chunk) => {
        rawData += chunk;
        if(Buffer.byteLength(rawData)>64*1024) { cleanup(); req.destroy(new Error("Classifier response exceeds limit.")); }
      });

      res.on("end", () => {
        cleanup();
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
          return reject(error);
        }

        resolve(parsed);
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error("Classifier request timed out."));
    });

    req.on("error", (error) => {
      cleanup();
      reject(error);
    });

    timer=setTimeout(()=>req.destroy(new Error("Classifier request deadline exceeded.")),timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    req.write(bodyString);
    req.end();
  });
}

async function classifyWithExternalGeminiService(image, timeoutMs = 35000, signal) {
  const classifierUrl =
    getEnvValue("GEMINI_CLASSIFIER_URL") ||
    getEnvValue("CLOUD_RUN_GEMINI_CLASSIFIER_URL");

  if (!classifierUrl) {
    analysisLog.warn("[WasteAnalysis] GEMINI_CLASSIFIER_URL is not set. Skipping external Gemini classifier.");
    return null;
  }

  try {
    analysisLog.log("[WasteAnalysis] Calling external Gemini classifier.");

    const deadlineAt = Date.now() + timeoutMs;
    const headers = process.env.CLOUD_RUN_AUTH_MODE || process.env.WMO_DEPLOYMENT_MODE === "staging"
      ? await require("./cloudRunAuth").invocationHeaders(classifierUrl, { timeoutMs, ...(signal ? { signal } : {}) }) : {};
    if (deadlineAt <= Date.now()) throw new Error("Classifier request deadline exceeded.");
    const response = await postJson(classifierUrl, {
      image
    }, Math.max(1, deadlineAt-Date.now()), headers, signal);

    analysisLog.log("[WasteAnalysis] External classifier response success:", response?.success);

    if (!response?.success || !response?.result) {
      return {
        success: false,
        message: response?.message || "External classifier returned no valid result.",
        result: null
      };
    }

    return {
      success: true,
      source: response.source || "cloud_run_gemini_vision",
      result: response.result
    };
  } catch (error) {
    analysisLog.error("[WasteAnalysis] External Gemini classifier unavailable; status:", error.statusCode || "unknown");

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
    analysisLog.warn("[WasteAnalysis] Render direct Gemini disabled. Set ALLOW_RENDER_GEMINI_DIRECT=true only if Render Gemini works.");
    return null;
  }

  if (typeof classifyWasteWithGemini !== "function") {
    analysisLog.warn("[WasteAnalysis] Local Gemini classifier function is unavailable.");
    return null;
  }

  try {
    analysisLog.log("[WasteAnalysis] Trying Render direct Gemini classifier.");
    return await classifyWasteWithGemini(image);
  } catch (error) {
    analysisLog.error("[WasteAnalysis] Local Gemini classifier fatal error:", error.message);

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

async function analyzeWasteLegacy({ image, detectedObject, mlKitLabels = [], boundedDiscovery = false, signal }) {
  const stageSignal = process.env.WMO_DEPLOYMENT_MODE === "staging" && process.env.STAGING_WASTE_SCAN_ONLY === "true" ? signal : undefined;
  if (stageSignal?.aborted) throw new Error("Analysis request cancelled.");
  analysisLog.log("=== analyzeWaste START ===");
  analysisLog.log("detectedObject:", detectedObject);
  analysisLog.log("mlKitLabels:", mlKitLabels);
  analysisLog.log("image exists:", !!image);
  analysisLog.log("image length:", image ? image.length : 0);

  /*
    FIRST PRIORITY:
    External Gemini classifier endpoint, preferably Google Cloud Run.

    This avoids the Render -> Gemini location restriction:
    "User location is not supported for the API use."
  */
  const externalGeminiResult = await classifyWithExternalGeminiService(image, boundedDiscovery ? 15000 : 35000, stageSignal);
  let externalItems = [];
  if (externalGeminiResult?.success) {
    externalItems = normalizeDetectedItems(externalGeminiResult.result?.detectedItems, "cloud_run_gemini_vision", true);
    if (!externalItems.length) externalItems = normalizeDetectedItems(externalGeminiResult.result?.items, "cloud_run_gemini_vision", true);
  }
  const externalAiResult = buildAiResultFromClassifier(externalGeminiResult, "cloud_run_gemini_vision");
  if (externalItems.length) return withDetectedItems(externalAiResult, externalItems, !!externalAiResult);
  // Do not speculate on Google before Gemini multi-item selection: that would add a needless call.
  // Once that selection is ruled out, overlap localization with the optional local fallback.
  if (stageSignal?.aborted) throw new Error("Analysis request cancelled.");
  const localizedObjects = localizeObjectsBestEffort(image);


  if (externalAiResult) {
    analysisLog.log("[WasteAnalysis] RETURNING external Gemini category:", externalAiResult.category);
    return enrichWithGoogleObjects(externalAiResult, localizedObjects, true);
  }

  /*
    SECOND PRIORITY:
    Optional direct Gemini from Render.

    Disabled by default because Render direct Gemini is currently failing.
    Only enable with ALLOW_RENDER_GEMINI_DIRECT=true if you confirm it works.
  */
  const localGeminiResult = boundedDiscovery || process.env.WMO_DEPLOYMENT_MODE === "staging" ? null : await classifyWithLocalRenderGemini(image);
  const localAiResult = buildAiResultFromClassifier(
    localGeminiResult,
    "gemini_vision"
  );

  if (localAiResult) {
    analysisLog.log("[WasteAnalysis] RETURNING local Gemini category:", localAiResult.category);
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

    analysisLog.log("[WasteAnalysis] RETURNING local mapper category:", category);

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
    analysisLog.error("[WasteAnalysis] getFallbackResult error:", error.message);
  }

  const fallbackCategory = normalizeCategory(fallback?.category) || "Residual";

  analysisLog.log("[WasteAnalysis] RETURNING final fallback:", fallbackCategory);

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

async function analyzeWaste(input) {
  if(process.env.WHOLE_IMAGE_DISCOVERY_ENABLED!=="true" || !input.objectDiscovery || !input.principal) return analyzeWasteLegacy(input);
  const discovery=require("./wholeImageRecognitionService");
  // One attempt per capture, concurrently with primary classification; optional failure is isolated.
  const observations=discovery.discoverObjects({...input.objectDiscovery,image:input.image},{principal:input.principal,signal:input.signal})
    .then(result=>result.objects).catch(()=>[]);
  const primary=await analyzeWasteLegacy({...input,boundedDiscovery:true});
  const objects=await observations;
  const detectedItems=discovery.merge(primary.detectedItems || [],objects,samePhysicalObject);
  return {...primary,detectedItems,scanSummary:buildScanSummary(detectedItems),identityObservations:objects.filter(item=>!item.boundingBox)};
}

// Additive and lazy: the existing analyze path never starts crop recognition.
async function recognizeCrops(input, context) {
  return require("./cropRecognitionService").recognizeCrops(input, context);
}

module.exports = {
  recognizeCrops,
  samePhysicalObject,
  analyzeWaste,
  normalizeDetectedItems,
  buildScanSummary,
  MIN_OBJECT_CONFIDENCE,
  MAX_DETECTED_ITEMS
};
