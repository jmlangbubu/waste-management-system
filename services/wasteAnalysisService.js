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
  "floor"
]);

function isGenericLabel(label) {
  const normalized = normalizeText(label);

  if (!normalized) return true;

  if (
    normalized.includes("food") ||
    normalized.includes("fruit") ||
    normalized.includes("vegetable") ||
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
    normalized.includes("charger") ||
    normalized.includes("adapter") ||
    normalized.includes("electronic") ||
    normalized.includes("cable") ||
    normalized.includes("wire")
  ) {
    return false;
  }

  return GENERIC_LABELS.has(normalized);
}

function toSafeVisionLabels(labels = []) {
  if (!Array.isArray(labels)) return [];

  return labels
    .map(item => ({
      description: normalizeText(item?.description || item?.name || ""),
      score: typeof item?.score === "number" ? item.score : 0
    }))
    .filter(item => item.description)
    .filter(item => !isGenericLabel(item.description));
}

function toSafeMlKitLabels(labels = []) {
  if (!Array.isArray(labels)) return [];

  return labels
    .map(item => {
      if (typeof item === "string") {
        return { description: normalizeText(item), score: 0.5 };
      }

      return {
        description: normalizeText(item?.description || item?.name || ""),
        score: typeof item?.score === "number" ? item.score : 0.5
      };
    })
    .filter(item => item.description)
    .filter(item => !isGenericLabel(item.description));
}

function dedupeLabels(labels = []) {
  const seen = new Set();
  const result = [];

  for (const label of labels) {
    if (!label || !label.description) continue;

    if (!seen.has(label.description)) {
      seen.add(label.description);
      result.push(label);
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
    if (item?.description) pieces.push(item.description);
  }

  for (const item of mlKitLabels) {
    if (item?.description) pieces.push(item.description);
  }

  return normalizeText(pieces.join(" "));
}

function buildCategoryExplanation(category) {
  switch (category) {
    case "Recyclable":
      return "This waste type is recyclable because the detected item appears to be a bottle, can, paper-based material, carton, glass, or reusable container material.";
    case "Special Waste":
      return "This waste type is classified as special waste because it may contain electrical, electronic, chemical, hazardous, or regulated components that need special handling.";
    case "Residual":
    default:
      return "This waste type is residual because it is not confidently identified as recyclable or special waste and should be disposed of carefully as residual waste.";
  }
}

function buildCategoryAction(category) {
  switch (category) {
    case "Recyclable":
      return "Place the item in the recyclable waste bin. If possible, clean the item first before disposal.";
    case "Special Waste":
      return "Do not mix this item with ordinary household waste. Bring it to the proper special waste, hazardous waste, or e-waste collection point.";
    case "Residual":
    default:
      return "Place the item in the residual waste bin. Avoid mixing it with recyclable or special waste items.";
  }
}

function buildCategoryWarning(category) {
  switch (category) {
    case "Recyclable":
      return "Items that are heavily contaminated with food or chemicals may no longer be suitable for recycling.";
    case "Special Waste":
      return "Improper disposal of special waste may harm people, equipment, and the environment.";
    case "Residual":
    default:
      return "This result may be a fallback if the item was unclear, blurred, mixed with other objects, or not confidently detected.";
  }
}

function buildConflictOverride(combinedLabels = []) {
  const descriptions = combinedLabels
    .map(l => l?.description)
    .filter(Boolean);

  const hasSpecialWaste = descriptions.some(d =>
    d.includes("battery") ||
    d.includes("charger") ||
    d.includes("adapter") ||
    d.includes("power bank") ||
    d.includes("electronic") ||
    d.includes("electronics") ||
    d.includes("electrical") ||
    d.includes("bulb") ||
    d.includes("lamp") ||
    d.includes("chemical") ||
    d.includes("bleach") ||
    d.includes("paint") ||
    d.includes("medicine") ||
    d.includes("expired medicine") ||
    d.includes("aerosol") ||
    d.includes("spray can") ||
    d.includes("cable") ||
    d.includes("wire") ||
    d.includes("plug")
  );

  const hasRecyclable = descriptions.some(d =>
    d.includes("bottle") ||
    d.includes("container") ||
    d.includes("jar") ||
    d.includes("glass") ||
    d.includes("can") ||
    d.includes("metal") ||
    d.includes("aluminum") ||
    d.includes("tin") ||
    d.includes("paper") ||
    d.includes("carton") ||
    d.includes("cardboard")
  );

  const hasResidual = descriptions.some(d =>
    d.includes("wrapper") ||
    d.includes("sachet") ||
    d.includes("pouch") ||
    d.includes("styrofoam") ||
    d.includes("foam") ||
    d.includes("dirty") ||
    d.includes("greasy") ||
    d.includes("oily") ||
    d.includes("contaminated") ||
    d.includes("mixed waste")
  );

  const hasFoodAndPlasticMix = descriptions.some(d =>
    d.includes("food in plastic") ||
    d.includes("plastic with food") ||
    d.includes("dirty food container") ||
    d.includes("used food container")
  );

  if (hasSpecialWaste) {
    return "Special Waste";
  }

  if (hasFoodAndPlasticMix) {
    return "Residual";
  }

  if (hasRecyclable && !hasResidual) {
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

    console.log("visionLabels:", visionLabels);
    console.log("safeMlKitLabels:", safeMlKitLabels);
    console.log("combinedLabels:", combinedLabels);

    const forcedCategory = buildConflictOverride(combinedLabels);

    if (forcedCategory) {
      console.log("RETURNING forcedCategory:", forcedCategory);

      return createSafeResult({
        category: forcedCategory,
        detectedObject: forcedCategory,
        aiLabel: combinedLabels[0]?.description || null,
        aiConfidence:
          visionLabels[0]?.score != null
            ? Number(visionLabels[0].score).toFixed(2)
            : null,
        analysisSource: "conflict_override",
        visionLabels,
        mlKitLabels: safeMlKitLabels
      });
    }

    const combinedText = buildCombinedAnalysisText(
      detectedObject,
      visionLabels,
      safeMlKitLabels
    );

    console.log("combinedText:", combinedText);

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
        detectedObject: mapped.category,
        aiLabel: visionLabels[0]?.description || safeMlKitLabels[0]?.description || null,
        aiConfidence:
          visionLabels[0]?.score != null
            ? Number(visionLabels[0].score).toFixed(2)
            : safeMlKitLabels[0]?.score != null
            ? Number(safeMlKitLabels[0].score).toFixed(2)
            : null,
        analysisSource: visionLabels.length > 0 ? "google_vision_multi_label" : "mlkit_fusion",
        visionLabels,
        mlKitLabels: safeMlKitLabels
      });
    }

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
        detectedObject: ruleBased.category,
        aiLabel: visionLabels[0]?.description || safeMlKitLabels[0]?.description || null,
        aiConfidence:
          visionLabels[0]?.score != null
            ? Number(visionLabels[0].score).toFixed(2)
            : safeMlKitLabels[0]?.score != null
            ? Number(safeMlKitLabels[0].score).toFixed(2)
            : null,
        analysisSource: "rule_based_fallback",
        visionLabels,
        mlKitLabels: safeMlKitLabels
      });
    }

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

    const bestHint =
      visionLabels[0]?.description ||
      safeMlKitLabels[0]?.description ||
      detectedObject ||
      "unknown item";

    console.log("RETURNING final fallback:", fallback);

    return createSafeResult({
      category: fallback.category || "Residual",
      detectedObject: fallback.category || "Residual",
      aiLabel: bestHint,
      aiConfidence:
        visionLabels[0]?.score != null
          ? Number(visionLabels[0].score).toFixed(2)
          : safeMlKitLabels[0]?.score != null
          ? Number(safeMlKitLabels[0].score).toFixed(2)
          : null,
      analysisSource: "fallback",
      visionLabels,
      mlKitLabels: safeMlKitLabels,
      explanation: `The system could not confidently identify the waste item. Best detected hint: "${bestHint}". It was placed under residual as the safest fallback type.`,
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
        "Place the item in the residual waste bin and avoid mixing it with recyclable or special waste items.",
      warning:
        "This is a fallback result because the analysis service encountered a fatal error."
    });
  }
}

module.exports = {
  analyzeWaste
};