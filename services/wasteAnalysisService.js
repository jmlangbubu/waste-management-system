const http = require("http");
const https = require("https");

const {
  analyzeWasteByObject,
  getFallbackResult,
  mapWasteCategory,
  normalizeText
} = require("../utils/wasteMapper");

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

function postJson(urlString, payload, timeoutMs = 35000) {
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
        "Content-Length": Buffer.byteLength(bodyString)
      },
      timeout: timeoutMs
    };

    const req = client.request(options, (res) => {
      let rawData = "";

      res.on("data", (chunk) => {
        rawData += chunk;
      });

      res.on("end", () => {
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
      reject(error);
    });

    req.write(bodyString);
    req.end();
  });
}

async function classifyWithExternalGeminiService(image) {
  const classifierUrl =
    getEnvValue("GEMINI_CLASSIFIER_URL") ||
    getEnvValue("CLOUD_RUN_GEMINI_CLASSIFIER_URL");

  if (!classifierUrl) {
    console.warn("[WasteAnalysis] GEMINI_CLASSIFIER_URL is not set. Skipping external Gemini classifier.");
    return null;
  }

  try {
    console.log("[WasteAnalysis] Calling external Gemini classifier:", classifierUrl);

    const response = await postJson(classifierUrl, {
      image
    });

    console.log("[WasteAnalysis] External classifier response success:", response?.success);
    console.log("[WasteAnalysis] External classifier result:", response?.result);

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
    console.error("[WasteAnalysis] External Gemini classifier error:", error.message);

    if (error.response) {
      console.error("[WasteAnalysis] External classifier error response:", error.response);
    }

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

  return createSafeResult({
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
  });
}

async function analyzeWaste({ image, detectedObject, mlKitLabels = [] }) {
  console.log("=== analyzeWaste START ===");
  console.log("detectedObject:", detectedObject);
  console.log("mlKitLabels:", mlKitLabels);
  console.log("image exists:", !!image);
  console.log("image length:", image ? image.length : 0);

  /*
    FIRST PRIORITY:
    External Gemini classifier endpoint, preferably Google Cloud Run.

    This avoids the Render -> Gemini location restriction:
    "User location is not supported for the API use."
  */
  const externalGeminiResult = await classifyWithExternalGeminiService(image);
  const externalAiResult = buildAiResultFromClassifier(
    externalGeminiResult,
    "cloud_run_gemini_vision"
  );

  if (externalAiResult) {
    console.log("[WasteAnalysis] RETURNING external Gemini category:", externalAiResult.category);
    return externalAiResult;
  }

  /*
    SECOND PRIORITY:
    Optional direct Gemini from Render.

    Disabled by default because Render direct Gemini is currently failing.
    Only enable with ALLOW_RENDER_GEMINI_DIRECT=true if you confirm it works.
  */
  const localGeminiResult = await classifyWithLocalRenderGemini(image);
  const localAiResult = buildAiResultFromClassifier(
    localGeminiResult,
    "gemini_vision"
  );

  if (localAiResult) {
    console.log("[WasteAnalysis] RETURNING local Gemini category:", localAiResult.category);
    return localAiResult;
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

    return createSafeResult({
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
    });
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

  return createSafeResult({
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
  });
}

module.exports = {
  analyzeWaste
};
