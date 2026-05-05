// utils/wasteMapper.js

/*
  Waste Mapper
  ------------
  Purpose:
  - Converts detected labels/text from ML Kit / Google Vision into system waste categories.
  - Provides safe rule-based fallback when AI labels are weak.
  - Supports:
    1. Biodegradable
    2. Recyclable
    3. Residual
    4. Special Waste

  Important:
  - Keep exported function names because services/wasteAnalysisService.js imports them.
*/

const WASTE_RULES = {
  categories: {
    biodegradable: {
      label: "Biodegradable",
      color: "green",
      strong: [
        "banana peel",
        "banana skin",
        "orange peel",
        "fruit peel",
        "vegetable peel",
        "vegetable scraps",
        "fruit scraps",
        "food scraps",
        "leftover food",
        "spoiled food",
        "rotten fruit",
        "rotten vegetable",
        "apple core",
        "mango peel",
        "coconut husk",
        "coconut shell",
        "egg shell",
        "eggshell",
        "fish bone",
        "fish bones",
        "chicken bone",
        "chicken bones",
        "meat scraps",
        "rice",
        "cooked rice",
        "bread",
        "leaf",
        "leaves",
        "dry leaves",
        "grass",
        "grass clippings",
        "yard waste",
        "garden waste",
        "plant waste",
        "organic waste",
        "compostable waste",
        "biodegradable waste"
      ],
      medium: [
        "food",
        "fruit",
        "vegetable",
        "plant",
        "produce",
        "organic",
        "compost",
        "compostable",
        "peel",
        "scraps",
        "leftover",
        "bone",
        "shell",
        "leaf",
        "leaves",
        "grass"
      ],
      weak: [
        "natural material",
        "agricultural waste"
      ]
    },

    recyclable: {
      label: "Recyclable",
      color: "green",
      strong: [
        "plastic bottle",
        "pet bottle",
        "water bottle",
        "mineral water bottle",
        "soft drink bottle",
        "soda bottle",
        "beverage bottle",
        "juice bottle",
        "clear bottle",
        "clear plastic bottle",
        "plastic container",
        "clean plastic container",
        "food container",
        "clean food container",
        "sauce bottle",
        "condiment bottle",
        "hot sauce bottle",
        "ketchup bottle",
        "soy sauce bottle",
        "glass bottle",
        "glass jar",
        "jar",
        "aluminum can",
        "tin can",
        "metal can",
        "beverage can",
        "drink can",
        "food can",
        "clean can",
        "empty can",
        "metal container",
        "cardboard",
        "corrugated cardboard",
        "carton",
        "milk carton",
        "paper bag",
        "newspaper",
        "office paper",
        "magazine",
        "paper",
        "plastic cup",
        "clean plastic cup",
        "empty bottle",
        "empty container"
      ],
      medium: [
        "bottle",
        "container",
        "cup",
        "jar",
        "can",
        "glass",
        "paper",
        "metal",
        "aluminum",
        "tin",
        "plastic",
        "packaging",
        "recyclable material"
      ],
      weak: [
        "vessel",
        "storage container",
        "drink container"
      ]
    },

    residual: {
      label: "Residual",
      color: "orange",
      strong: [
        "candy wrapper",
        "chips wrapper",
        "snack wrapper",
        "wrapper",
        "sachet",
        "foil sachet",
        "laminated packaging",
        "plastic pouch",
        "plastic wrapper",
        "dirty wrapper",
        "dirty packaging",
        "styrofoam",
        "styrofoam container",
        "foam container",
        "diaper",
        "used tissue",
        "tissue",
        "sanitary pad",
        "cigarette butt",
        "dirty plastic",
        "dirty container",
        "dirty cup",
        "contaminated plastic",
        "plastic with food",
        "food in plastic",
        "dirty food container",
        "used food container",
        "greasy container",
        "oily container",
        "mixed waste"
      ],
      medium: [
        "trash",
        "disposable",
        "foam",
        "dirty packaging",
        "contaminated container",
        "pouch",
        "packet"
      ],
      weak: [
        "pack",
        "residual waste"
      ]
    },

    special_waste: {
      label: "Special Waste",
      color: "red",
      strong: [
        "battery",
        "lithium battery",
        "phone battery",
        "car battery",
        "charger",
        "phone charger",
        "adapter",
        "power adapter",
        "charging brick",
        "extension cord",
        "electronic waste",
        "e-waste",
        "bulb",
        "fluorescent lamp",
        "light bulb",
        "broken bulb",
        "syringe",
        "needle",
        "medical waste",
        "chemical",
        "bleach",
        "paint",
        "paint can",
        "aerosol",
        "spray can",
        "medicine",
        "expired medicine",
        "power bank",
        "circuit board",
        "electronics",
        "electronic device"
      ],
      medium: [
        "toxic",
        "flammable",
        "electrical",
        "electronic",
        "hazard",
        "corrosive",
        "cable",
        "wire",
        "plug"
      ],
      weak: [
        "hazardous",
        "biohazard",
        "special waste"
      ]
    }
  },

  genericIgnoreWords: [
    "product",
    "goods",
    "material",
    "object",
    "thing",
    "item",
    "indoor",
    "table",
    "floor",
    "room",
    "design",
    "font",
    "brand",
    "logo",
    "label",
    "text",
    "graphics",
    "image",
    "photography",
    "illustration",
    "symbol",
    "shape",
    "pattern",
    "technology",
    "gadget"
  ],

  strongPriorityCategories: [
    "special_waste",
    "biodegradable",
    "recyclable",
    "residual"
  ]
};

function normalizeText(value) {
  if (value === null || value === undefined) return "";

  return String(value)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLabels(labels = []) {
  if (!Array.isArray(labels)) return [];

  return labels
    .map((item) => {
      if (typeof item === "string") {
        return normalizeText(item);
      }

      return normalizeText(item?.description || item?.name || item?.label || "");
    })
    .filter(Boolean);
}

function containsPhrase(text, phrase) {
  const cleanText = normalizeText(text);
  const cleanPhrase = normalizeText(phrase);

  if (!cleanText || !cleanPhrase) return false;

  return cleanText.includes(cleanPhrase);
}

function scoreCategory(text, categoryRules) {
  let score = 0;
  const matched = [];

  for (const phrase of categoryRules.strong || []) {
    if (containsPhrase(text, phrase)) {
      score += 100;
      matched.push(phrase);
    }
  }

  for (const phrase of categoryRules.medium || []) {
    if (containsPhrase(text, phrase)) {
      score += 45;
      matched.push(phrase);
    }
  }

  for (const phrase of categoryRules.weak || []) {
    if (containsPhrase(text, phrase)) {
      score += 15;
      matched.push(phrase);
    }
  }

  return { score, matched };
}

function hasDirtyOrContaminatedContext(text) {
  const clean = normalizeText(text);

  return (
    clean.includes("dirty") ||
    clean.includes("contaminated") ||
    clean.includes("greasy") ||
    clean.includes("oily") ||
    clean.includes("used food container") ||
    clean.includes("dirty food container") ||
    clean.includes("food in plastic") ||
    clean.includes("plastic with food")
  );
}

function hasSpecialWasteContext(text) {
  const clean = normalizeText(text);

  return (
    clean.includes("battery") ||
    clean.includes("charger") ||
    clean.includes("adapter") ||
    clean.includes("power bank") ||
    clean.includes("electronic") ||
    clean.includes("electronics") ||
    clean.includes("electrical") ||
    clean.includes("bulb") ||
    clean.includes("lamp") ||
    clean.includes("chemical") ||
    clean.includes("bleach") ||
    clean.includes("paint") ||
    clean.includes("medicine") ||
    clean.includes("aerosol") ||
    clean.includes("spray can") ||
    clean.includes("wire") ||
    clean.includes("cable") ||
    clean.includes("plug") ||
    clean.includes("syringe") ||
    clean.includes("needle")
  );
}

function buildCategoryDetails(category) {
  switch (category) {
    case "Biodegradable":
      return {
        explanation:
          "This item appears to be organic or compostable waste such as food scraps, fruit or vegetable waste, leaves, or other natural materials.",
        action:
          "Place it in the biodegradable waste bin or composting area. Keep it separate from plastic, metal, glass, and hazardous items.",
        warning:
          "Do not mix biodegradable waste with plastic wrappers, sachets, batteries, chemicals, or other non-biodegradable materials."
      };

    case "Recyclable":
      return {
        explanation:
          "This item appears recyclable because it may be clean plastic, glass, metal, paper, carton, cardboard, bottle, can, or reusable container material.",
        action:
          "Place it in the recyclable waste bin. Empty and clean the item first if possible.",
        warning:
          "If the item is heavily contaminated with food, grease, oil, or chemicals, it may no longer be suitable for recycling."
      };

    case "Special Waste":
      return {
        explanation:
          "This item appears to require special handling because it may be electronic, electrical, chemical, medical, hazardous, or regulated waste.",
        action:
          "Do not place it in ordinary waste bins. Bring it to the proper special waste, hazardous waste, e-waste, or collection point.",
        warning:
          "Improper disposal of special waste may harm people, equipment, and the environment."
      };

    case "Residual":
    default:
      return {
        explanation:
          "This item appears to be residual waste because it is not clearly biodegradable, recyclable, or special waste.",
        action:
          "Place it in the residual waste bin. Avoid mixing it with recyclable, biodegradable, or special waste items.",
        warning:
          "This may be a fallback result if the item was unclear, blurred, contaminated, or not confidently detected."
      };
  }
}

function mapWasteCategory({ analysisText = "", labels = [], objectName = "" } = {}) {
  const labelText = normalizeLabels(labels).join(" ");
  const combinedText = normalizeText(`${objectName} ${analysisText} ${labelText}`);

  if (!combinedText) {
    return null;
  }

  /*
    Safety priority:
    - Special waste should win first.
    - Dirty/contaminated recyclable-looking items should become Residual.
  */
  if (hasSpecialWasteContext(combinedText)) {
    const details = buildCategoryDetails("Special Waste");

    return {
      itemName: "Special Waste",
      category: "Special Waste",
      matched: ["special waste safety override"],
      score: 999,
      ...details
    };
  }

  if (hasDirtyOrContaminatedContext(combinedText)) {
    const details = buildCategoryDetails("Residual");

    return {
      itemName: "Residual",
      category: "Residual",
      matched: ["dirty or contaminated override"],
      score: 900,
      ...details
    };
  }

  const scores = [];

  for (const [key, rules] of Object.entries(WASTE_RULES.categories)) {
    const result = scoreCategory(combinedText, rules);

    if (result.score > 0) {
      scores.push({
        key,
        label: rules.label,
        score: result.score,
        matched: result.matched
      });
    }
  }

  if (scores.length === 0) {
    return null;
  }

  scores.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;

    const aPriority = WASTE_RULES.strongPriorityCategories.indexOf(a.key);
    const bPriority = WASTE_RULES.strongPriorityCategories.indexOf(b.key);

    return aPriority - bPriority;
  });

  const winner = scores[0];
  const details = buildCategoryDetails(winner.label);

  return {
    itemName: winner.label,
    category: winner.label,
    matched: winner.matched,
    score: winner.score,
    ...details
  };
}

function analyzeWasteByObject(objectName = "") {
  const cleanObject = normalizeText(objectName);

  if (!cleanObject) {
    return null;
  }

  return mapWasteCategory({
    analysisText: cleanObject,
    labels: [],
    objectName: cleanObject
  });
}

function getFallbackResult() {
  const details = buildCategoryDetails("Residual");

  return {
    itemName: "Residual",
    category: "Residual",
    ...details
  };
}

module.exports = {
  WASTE_RULES,
  analyzeWasteByObject,
  getFallbackResult,
  mapWasteCategory,
  normalizeText
};
