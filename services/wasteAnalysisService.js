const {
  analyzeWasteByObject,
  getFallbackResult,
  mapWasteCategory,
  normalizeText
} = require("../utils/wasteMapper");
const { detectLabelsFromBase64 } = require("./googleVisionService");

const GENERIC_LABELS = new Set([
  "material",
  "font",
  "product",
  "brand",
  "photography",
  "image",
  "design",
  "pattern",
  "object",
  "indoor",
  "technology",
  "gadget",
  "graphics",
  "logo",
  "label",
  "text",
  "room",
  "table",
  "floor",
  "hand",
  "finger",
  "person",
  "human",
  "skin"
]);

function isGenericLabel(label) {
  const normalized = normalizeText(label);

  if (!normalized) return true;

  /*
    These words are allowed even if they are broad because they are useful
    for waste classification.
  */
  if (
    normalized.includes("food") ||
    normalized.includes("fruit") ||
    normalized.includes("vegetable") ||
    normalized.includes("banana") ||
    normalized.includes("apple") ||
    normalized.includes("orange") ||
    normalized.includes("mango") ||
    normalized.includes("leaf") ||
    normalized.includes("leaves") ||
    normalized.includes("plant") ||
    normalized.includes("organic") ||
    normalized.includes("compost") ||
    normalized.includes("can") ||
    normalized.includes("bottle") ||
    normalized.includes("plastic") ||
    normalized.includes("glass") ||
    normalized.includes("metal") ||
    normalized.includes("container") ||
    normalized.includes("wrapper") ||
    normalized.includes("sachet") ||
    normalized.includes("battery") ||
    normalized.includes("bulb") ||
    normalized.includes("paper") ||
    normalized.includes("carton") ||
    normalized.includes("cardboard") ||
    normalized.includes("charger") ||
    normalized.includes("adapter") ||
    normalized.includes("electronic") ||
    normalized.includes("cable") ||
    normalized.includes("wire") ||
    normalized.includes("styrofoam") ||
    normalized.includes("foam") ||
    normalized.includes("diaper") ||
    normalized.includes("tissue")
  ) {
    return false;
  }

  return GENERIC_LABELS.has(normalized);
}

function toSafeVisionLabels(labels = []) {
  if (!Array.isArray(labels)) return [];

  return labels
    .map((item) => ({
      description: normalizeText(item?.description || item?.name || ""),
      score: typeof item?.score === "number" ? item.score : 0
    }))
    .filter((item) => item.description)
    .filter((item) => !isGenericLabel(item.description));
}

function toSafeMlKitLabels(labels = []) {
  if (!Array.isArray(labels)) return [];

  return labels
    .map((item) => {
      if (typeof item === "string") {
        return { description: normalizeText(item), score: 0.5 };
      }

      return {
        description: normalizeText(item?.description || item?.name || ""),
        score: typeof item?.score === "number" ? item.score : 0.5
      };
    })
    .filter((item) => item.description)
    .filter((item) => !isGenericLabel(item.description));
}

function dedupeLabels(labels = []) {
  const seen = new Set();
  const result = [];

  for (const label of labels) {
    if (!label || !label.description) continue;

    const description = normalizeText(label.description);
    if (!description) continue;

    if (!seen.has(description)) {
      seen.add(description);
      result.push({
        ...label,
        description
      });
    }
  }

  return result;
}

function buildCombinedAnalysisText(detectedObject = "", visionLabels = [], mlKitLabels = []) {
  const pieces = [];

  if (detectedObject) {
    pieces.push(normalizeText(detectedObject));
  }

  for (const item of visionLabels) {
    if (item?.description) pieces.push(normalizeText(item.description));
  }

  for (const item of mlKitLabels) {
    if (item?.description) pieces.push(normalizeText(item.description));
  }

  return normalizeText(pieces.join(" "));
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

function hasAny(text, keywords = []) {
  const normalized = normalizeText(text);
  return keywords.some((keyword) => normalized.includes(normalizeText(keyword)));
}

function buildConflictOverride(combinedText = "") {
  const text = normalizeText(combinedText);

  if (!text) return null;

  const hasSpecialWaste = hasAny(text, [
    "battery",
    "lithium battery",
    "phone battery",
    "car battery",
    "charger",
    "adapter",
    "power bank",
    "electronic",
    "electronics",
    "electrical",
    "e waste",
    "ewaste",
    "bulb",
    "lamp",
    "fluorescent",
    "chemical",
    "bleach",
    "paint",
    "medicine",
    "expired medicine",
    "aerosol",
    "spray can",
    "cable",
    "wire",
    "plug",
    "syringe",
    "needle",
    "medical waste"
  ]);

  const hasDirtyOrContaminated = hasAny(text, [
    "dirty",
    "contaminated",
    "greasy",
    "oily",
    "food in plastic",
    "plastic with food",
    "dirty food container",
    "used food container",
    "mixed waste"
  ]);

  const hasBiodegradable = hasAny(text, [
    "food waste",
    "food scraps",
    "leftover food",
    "spoiled food",
    "fruit",
    "vegetable",
    "banana",
    "banana peel",
    "apple",
    "apple core",
    "orange peel",
    "mango peel",
    "peel",
    "leaf",
    "leaves",
    "dry leaves",
    "grass",
    "plant",
    "organic",
    "compost",
    "compostable",
    "egg shell",
    "eggshell",
    "fish bone",
    "chicken bone",
    "rice",
    "bread"
  ]);

  const hasRecyclable = hasAny(text, [
    "bottle",
    "plastic bottle",
    "water bottle",
    "pet bottle",
    "container",
    "jar",
    "glass",
    "can",
    "metal",
    "aluminum",
    "tin",
    "paper",
    "carton",
    "cardboard",
    "plastic cup",
    "plastic container",
    "newspaper",
    "magazine"
  ]);

  const hasResidual = hasAny(text, [
    "wrapper",
    "sachet",
    "pouch",
    "packet",
    "styrofoam",
    "foam",
    "diaper",
    "used tissue",
    "tissue",
    "sanitary pad",
    "cigarette butt",
    "laminated packaging"
  ]);

  /*
    Priority:
    1. Special waste always wins for safety.
    2. Dirty/contaminated recyclable-looking items become residual.
    3. Organic food/plant waste becomes biodegradable.
    4. Clean recyclable materials become recyclable.
    5. Known residual materials become residual.
  */
  if (hasSpecialWaste) {
    return "Special Waste";
  }

  if (hasDirtyOrContaminated) {
    return "Residual";
  }

  if (hasBiodegradable && !hasRecyclable) {
    return "Biodegradable";
  }

  if (hasRecyclable) {
    return "Recyclable";
  }

  if (hasResidual) {
    return "Residual";
  }

  return null;
}

function createSafeResult({
  category = "Residual",
  detectedObject = "",
  aiLabel = null,
  aiConfidence = null,
  analysisSource = "fallback",
  visionLabels = [],
  mlKitLabels = [],
  explanation = null,
  action = null,
  warning = null
}) {
  return {
    itemName: category,
    category,
    explanation: explanation || buildCategoryExplanation(category),
    action: action || buildCategoryAction(category),
    warning: warning || buildCategoryWarning(category),
    detectedObject: detectedObject || category,
    aiLabel,
    aiConfidence,
    analysisSource,
    visionLabels,
    mlKitLabels
  };
}

function getBestLabel({ visionLabels = [], safeMlKitLabels = [], detectedObject = "" }) {
  return (
    visionLabels[0]?.description ||
    safeMlKitLabels[0]?.description ||
    normalizeText(detectedObject) ||
    "unknown item"
  );
}

function getBestConfidence({ visionLabels = [], safeMlKitLabels = [] }) {
  if (visionLabels[0]?.score != null) {
    return Number(visionLabels[0].score).toFixed(2);
  }

  if (safeMlKitLabels[0]?.score != null) {
    return Number(safeMlKitLabels[0].score).toFixed(2);
  }

  return null;
}

async function analyzeWaste({ image, detectedObject, mlKitLabels = [] }) {
  console.log("=== analyzeWaste START ===");
  console.log("detectedObject:", detectedObject);
  console.log("mlKitLabels:", mlKitLabels);
  console.log("image exists:", !!image);
  console.log("image length:", image ? image.length : 0);

  try {
    let rawVisionLabels = [];

    try {
      const visionResult = await detectLabelsFromBase64(image);
      rawVisionLabels = Array.isArray(visionResult) ? visionResult : [];
      console.log("rawVisionLabels:", rawVisionLabels);
    } catch (error) {
      console.error("Google Vision error:", error);
      rawVisionLabels = [];
    }

    const visionLabels = dedupeLabels(toSafeVisionLabels(rawVisionLabels));
    const safeMlKitLabels = dedupeLabels(toSafeMlKitLabels(mlKitLabels));
    const combinedLabels = dedupeLabels([...visionLabels, ...safeMlKitLabels]);

    const combinedText = buildCombinedAnalysisText(
      detectedObject,
      visionLabels,
      safeMlKitLabels
    );

    console.log("visionLabels:", visionLabels);
    console.log("safeMlKitLabels:", safeMlKitLabels);
    console.log("combinedLabels:", combinedLabels);
    console.log("combinedText:", combinedText);

    /*
      First pass: direct safety/category override from all available text.
      This helps when Google Vision fails but detectedObject still has useful text.
    */
    const forcedCategory = buildConflictOverride(combinedText);

    if (forcedCategory) {
      console.log("RETURNING forcedCategory:", forcedCategory);

      return createSafeResult({
        category: forcedCategory,
        detectedObject: forcedCategory,
        aiLabel: getBestLabel({ visionLabels, safeMlKitLabels, detectedObject }),
        aiConfidence: getBestConfidence({ visionLabels, safeMlKitLabels }),
        analysisSource:
          visionLabels.length > 0
            ? "vision_text_override"
            : safeMlKitLabels.length > 0
            ? "mlkit_text_override"
            : "detected_object_override",
        visionLabels,
        mlKitLabels: safeMlKitLabels
      });
    }

    /*
      Second pass: wasteMapper category rules.
      This requires the updated utils/wasteMapper.js with function exports.
    */
    let mapped = null;

    try {
      mapped = mapWasteCategory({
        analysisText: combinedText,
        labels: combinedLabels,
        objectName: detectedObject
      });
      console.log("mapped:", mapped);
    } catch (mapError) {
      console.error("mapWasteCategory error:", mapError);
      mapped = null;
    }

    if (mapped && mapped.category) {
      console.log("RETURNING mapped.category:", mapped.category);

      return createSafeResult({
        category: mapped.category,
        detectedObject: mapped.detectedObject || mapped.itemName || mapped.category,
        aiLabel: getBestLabel({ visionLabels, safeMlKitLabels, detectedObject }),
        aiConfidence: getBestConfidence({ visionLabels, safeMlKitLabels }),
        analysisSource:
          visionLabels.length > 0
            ? "google_vision_mapper"
            : safeMlKitLabels.length > 0
            ? "mlkit_mapper"
            : "detected_object_mapper",
        visionLabels,
        mlKitLabels: safeMlKitLabels,
        explanation: mapped.explanation || null,
        action: mapped.action || null,
        warning: mapped.warning || null
      });
    }

    /*
      Third pass: direct object rules.
    */
    let ruleBased = null;

    try {
      ruleBased = analyzeWasteByObject(detectedObject || combinedText);
      console.log("ruleBased:", ruleBased);
    } catch (ruleError) {
      console.error("analyzeWasteByObject error:", ruleError);
      ruleBased = null;
    }

    if (ruleBased && ruleBased.category) {
      console.log("RETURNING ruleBased.category:", ruleBased.category);

      return createSafeResult({
        category: ruleBased.category,
        detectedObject: ruleBased.detectedObject || ruleBased.itemName || ruleBased.category,
        aiLabel: getBestLabel({ visionLabels, safeMlKitLabels, detectedObject }),
        aiConfidence: getBestConfidence({ visionLabels, safeMlKitLabels }),
        analysisSource: "rule_based_fallback",
        visionLabels,
        mlKitLabels: safeMlKitLabels,
        explanation: ruleBased.explanation || null,
        action: ruleBased.action || null,
        warning: ruleBased.warning || null
      });
    }

    /*
      Final fallback: still return stable result, but include best label hint.
    */
    let fallback = null;

    try {
      fallback = getFallbackResult();
    } catch (fallbackError) {
      console.error("getFallbackResult error:", fallbackError);
      fallback = {
        category: "Residual",
        action: "Place the item in the residual waste bin.",
        warning: "This is a fallback result."
      };
    }

    const bestHint = getBestLabel({ visionLabels, safeMlKitLabels, detectedObject });

    console.log("RETURNING final fallback:", fallback);

    return createSafeResult({
      category: fallback.category || "Residual",
      detectedObject: fallback.detectedObject || fallback.itemName || fallback.category || "Residual",
      aiLabel: bestHint,
      aiConfidence: getBestConfidence({ visionLabels, safeMlKitLabels }),
      analysisSource: "fallback",
      visionLabels,
      mlKitLabels: safeMlKitLabels,
      explanation:
        fallback.explanation ||
        `The system could not confidently identify the waste item. Best detected hint: "${bestHint}". It was placed under residual as the safest fallback type.`,
      action: fallback.action || "Place the item in the residual waste bin.",
      warning: fallback.warning || "This is a fallback result."
    });
  } catch (fatalError) {
    console.error("=== analyzeWaste FATAL ERROR ===");
    console.error(fatalError);
    console.error(fatalError.stack);

    return createSafeResult({
      category: "Residual",
      detectedObject: detectedObject || "Residual",
      aiLabel: null,
      aiConfidence: null,
      analysisSource: "fatal_service_fallback",
      visionLabels: [],
      mlKitLabels: [],
      explanation:
        "The system encountered a fatal analysis error and returned a safe fallback result.",
      action:
        "Place the item in the residual waste bin and avoid mixing it with biodegradable, recyclable, or special waste items.",
      warning:
        "This is a fallback result because the analysis service encountered a fatal error."
    });
  }
}

module.exports = {
  analyzeWaste
};
