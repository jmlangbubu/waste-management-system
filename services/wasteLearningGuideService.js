const { normalizeText } = require("../utils/wasteMapper");

// Model aliases identify visual assets, not waste classification rules.
const MODEL_ALIASES = [
  ["plastic_bottle", /(?:plastic|pet|water|soda|beverage) bottle/],
  ["glass_bottle", /glass (?:bottle|jar)/],
  ["aluminum_can", /(?:aluminum|aluminium|beverage|drink) can/],
  ["tin_can", /(?:tin|metal|food) can/],
  ["cardboard", /cardboard|carton/],
  ["paper", /paper|newspaper|magazine/],
  ["banana_peel", /banana/],
  ["food_waste", /food|fruit|vegetable|scraps/],
  ["battery", /battery/],
  ["light_bulb", /bulb|fluorescent lamp/],
  ["plastic_bag", /plastic bag/],
  ["sachet", /sachet|wrapper|plastic pouch/]
];
const GENERIC_KEYS = {
  Recyclable: "generic_recyclable", Biodegradable: "generic_biodegradable",
  Residual: "generic_residual", "Special Waste": "generic_special_waste"
};

function getWasteLearningGuide(canonicalItem, category) {
  const name = normalizeText(canonicalItem);
  const modelKey = MODEL_ALIASES.find(([, pattern]) => pattern.test(name))?.[0]
    || GENERIC_KEYS[category] || "generic_residual";
  const guidance = {
    whatItIs: `An item classified as ${category || "Residual"}; image identification may be uncertain.`,
    properDisposal: "Keep separate and follow local residual-waste collection rules.",
    preparation: "Contain safely; do not mix with hazardous items.",
    environmentalImpact: "Correct segregation reduces litter and contamination.",
    reuseIdeas: [], recoveryOptions: ["Follow local collection guidance"],
    warnings: ["Do not burn or litter waste."], modelKey, modelHotspots: []
  };
  if (category === "Recyclable") {
    guidance.properDisposal = "Use the recyclable stream only when local rules accept the material and its condition.";
    guidance.preparation = "Empty and rinse if practical; keep paper and cardboard dry.";
    guidance.recoveryOptions = ["May be accepted by local recyclers or junk shops depending on local rules and material condition."];
    guidance.warnings.push("Food, oil or chemical contamination may prevent recycling.");
    if (modelKey === "plastic_bottle") {
      guidance.preparation = "Empty contents and rinse if practical. Separate cap and label where required by the local recycler.";
      guidance.reuseIdeas = ["Use a clean, undamaged bottle as a planter or non-food container when safe.", "Use for a safe craft without heating or sharp edges."];
      guidance.warnings.push("Avoid burning plastic. Do not reuse chemical containers for food or water.");
    }
    if (modelKey === "aluminum_can" || modelKey === "tin_can") {
      guidance.warnings.push("Handle sharp or damaged edges carefully; do not reuse unsafe or damaged cans for food.");
    }
    if (modelKey === "glass_bottle") guidance.warnings.push("Handle broken glass safely; avoid casual reuse of cracked containers.");
  } else if (category === "Biodegradable") {
    guidance.properDisposal = "Keep separate from recyclables; compost when suitable for your local composting system.";
    guidance.preparation = "Remove packaging and keep away from plastics, batteries and chemicals.";
    guidance.environmentalImpact = "Proper composting can return nutrients to soil and reduce organic waste.";
    guidance.recoveryOptions = ["Suitable local composting or biodegradable collection"];
    guidance.warnings.push("Avoid littering; not every composting system accepts all food waste.");
  } else if (category === "Special Waste") {
    guidance.properDisposal = "Never mix with ordinary household waste. Use authorized special-waste, battery or e-waste collection appropriate to the item.";
    guidance.preparation = "Keep intact and separate; ask the collection operator how to package it safely.";
    guidance.environmentalImpact = "Special handling helps prevent toxic pollution and injury.";
    guidance.recoveryOptions = ["Authorized special-waste collection; confirm local acceptance"];
    guidance.warnings = ["Do not burn, puncture or dismantle this item.", "Do not attempt casual reuse; keep away from children and heat."];
  }
  if (modelKey === "plastic_bottle") {
    guidance.modelHotspots = [
      { key: "cap", label: "Cap", guidance: "Separate when required by the local recycler." },
      { key: "label", label: "Label", guidance: "Remove when practical before recycling, if accepted locally." },
      { key: "body", label: "Bottle Body", guidance: category === "Recyclable" ? "Empty and rinse before locally accepted recycling." : "Contamination may prevent recycling; follow the category guidance." }
    ];
  }
  return guidance;
}

module.exports = { getWasteLearningGuide };
