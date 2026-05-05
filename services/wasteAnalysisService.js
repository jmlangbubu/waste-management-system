const {
  analyzeWasteByObject,
  getFallbackResult,
  mapWasteCategory,
  normalizeText
} = require("../utils/wasteMapper");

const { classifyWasteWithGemini } = require("./geminiWasteClassifierService");

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
  if (clean.includes("biodegradable")) return "Biodegradable";
  if (clean.includes("special")) return "Special Waste";
  if (clean.includes("hazardous")) return "Special Waste";
  if (clean.includes("residual")) return "Residual";

  return "";
}

function toSafeString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;

  const text = String(value).trim();
  return text || fallback;
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

async function analyzeWaste({ image, detectedObject, mlKitLabels = [] }) {
  console.log("=== analyzeWaste START ===");
  console.log("detectedObject:", detectedObject);
  console.log("mlKitLabels:", mlKitLabels);
  console.log("image exists:", !!image);
  console.log("image length:", image ? image.length : 0);

  /*
    FIRST PRIORITY:
    Gemini Vision.
    This replaces the failed Roboflow path and avoids ML Kit false labels like "food".
  */
  try {
    const geminiResult = await classifyWasteWithGemini(image);

    console.log("[WasteAnalysis] Gemini success:", geminiResult?.success);
    console.log("[WasteAnalysis] Gemini result:", geminiResult?.result);

    if (geminiResult?.success && geminiResult?.result) {
      const result = geminiResult.result;
      const category = normalizeCategory(result.category);

      if (isValidCategory(category)) {
        console.log("[WasteAnalysis] RETURNING Gemini category:", category);

        return createSafeResult({
          category,
          detectedObject: result.itemName || category,
          aiLabel: result.itemName || category,
          aiConfidence:
            result.confidence !== null && result.confidence !== undefined
              ? Number(result.confidence).toFixed(2)
              : null,
          analysisSource: geminiResult.source || "gemini_vision",
          explanation: result.explanation || null,
          action: result.action || null,
          warning: result.warning || null,
          visionLabels: [],
          mlKitLabels: []
        });
      }
    }
  } catch (error) {
    console.error("[WasteAnalysis] Gemini classifier fatal error:", error.message);
  }

  /*
    SECOND PRIORITY:
    Optional local fallback.
    Since the Android capture-first flow sends detectedObject = captured_waste_item
    and empty ML Kit labels, this will usually not falsely classify bottles as food.
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
    But keep Residual because your existing frontend/history expects a valid category.
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
    mlKitLabels: [],
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
