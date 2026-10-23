"use strict";
// Render-only enrichment of strictly validated discovery items AFTER merge/dedup.
// Do not use this helper on raw provider output or change the shared cloud catalog.
const { matchIdentity } = require("../gemini-waste-classifier-cloudrun/cropRecognition");
const { getWasteLearningGuide } = require("./wasteLearningGuideService");
const { productStateVeto } = require("./automaticWasteCategoryMapper");
const EXTRA_IDENTITIES = new Map([
  ["vegetable scraps", "Biodegradable"], ["fruit peels", "Biodegradable"],
  ["plant-only food scraps", "Biodegradable"], ["clean dry paper", "Recyclable"],
  ["empty aluminum can", "Recyclable"], ["electronic circuit board", "Special Waste"]
]);
const ELECTRICAL_IDENTITIES = new Set([
  "white power adapter", "power adapter", "phone charger", "usb wall charger", "charger", "wall charger", "usb charger"
]);
function enrichDiscoveryItem(item) {
  // A coincident Vision region keeps ALL its authoritative classification data.
  if (item.analysisSource !== "gemini_whole_image"
      || item.identitySource !== "gemini_whole_image"
      || item.recognitionState !== "localized_observation" || !item.boundingBox) return item;
  const label = item.observedIdentity.trim().toLowerCase().replace(/\s+/g, " ");
  const supported = matchIdentity(item.observedIdentity)
    || (ELECTRICAL_IDENTITIES.has(label.replace(/^(?:black|white|red|green|blue|yellow|gray|grey)\s+/, "")) ? { category: "Special Waste" }
      : EXTRA_IDENTITIES.has(label) ? { category: EXTRA_IDENTITIES.get(label) } : null);
  if(productStateVeto(item,supported?.category || item.category)){
    const safe={...item,category:"Unknown",requiresConfirmation:true};
    for(const field of ["guidance","modelKey","modelHotspots","explanation","action","warning"])delete safe[field];
    return safe;
  }
  if (!supported) {
    if (item.category !== "Unknown") return item;
    // Never pass Unknown through the legacy guide's generic Residual fallback.
    return { ...item, modelKey: "", modelHotspots: [], guidance: {
      whatItIs: "Identity and material need confirmation.",
      properDisposal: "Ask WMO to confirm this item's identity and material before choosing a waste stream.",
      preparation: "", environmentalImpact: "", reuseIdeas: [], recoveryOptions: [],
      warnings: ["Image identification may be uncertain; confirm identity and material."]
    } };
  }
  // The input has already passed the unchanged remote validator. Never replace a
  // conflicting established category, even if a caller supplies one locally.
  if (item.category !== "Unknown" && item.category !== supported.category) return item;
  const { modelKey, modelHotspots, ...guidance } = getWasteLearningGuide(item.canonicalItem, supported.category);
  return { ...item, category: supported.category, modelKey, modelHotspots, guidance };
}
module.exports = { enrichDiscoveryItem };
