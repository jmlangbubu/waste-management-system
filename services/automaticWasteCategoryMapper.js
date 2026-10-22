"use strict";
// Provisional *household* category suggestions from original, independently
// localized recognition evidence. Never use shortened UI display names.
const TRUSTED = new Set(["gemini_whole_image", "google_vision_object_localization"]);
const CATEGORIES = new Set(["Biodegradable", "Recyclable", "Residual", "Special Waste"]);
const HAZARD = /\b(?:chemical(?:s)?|pesticide|insecticide|herbicide|bleach|disinfectant|solvent|paint(?:\s+thinner)?|thinner|motor\s+oil|engine\s+oil|fuel|gasoline|kerosene|acid|pharmaceutical|medicine|medication|medical\s+waste|sharps?|syringes?|aerosol|spray\s+paint|unknown\s+contents?|contaminat\w*|hazard\w*)\b/;
const REPRESENTATION = /\b(?:picture|drawing|photo(?:graph)?|printed\s+(?:image|picture)|illustration|logo|advertisement|toy|replica|label\s+showing)\b/;
const UNCERTAIN = /\b(?:maybe|possibly|probably|looks\s+like|appears\s+to\s+be|unidentified|unclassified|unknown|unclear|unsure|ambiguous|generic|could\s+be)\b/;
const INSTRUCTION = /\b(?:ignore\s+(?:all|previous|prior)|system\s+prompt|follow\s+instructions|classify\s+as|return\s+(?:json|category))\b|```/;
const COLOR = /^(?:(?:light|dark)\s+)?(?:black|white|red|green|blue|yellow|orange|gray|grey|brown|clear|transparent|pink|purple)\s+/;
function observedIdentity(item) {
 if(!item || !TRUSTED.has(item.analysisSource) || item.recognitionState === "unlocalized_observation"
  || (item.recognitionState && item.recognitionState !== "localized_observation")
  || !item.boundingBox || item.category !== "Unknown")return null;
 const label = item.analysisSource === "gemini_whole_image"
  ? item.observedIdentity
  : (item.observedIdentity || item.originalItemName || item.canonicalItem);
 if(typeof label !== "string" || !label.trim() || label.length > 128 || /[\x00-\x1f<>]/.test(label))return null;
 return label.toLowerCase().trim().replace(/\s+/g," ").replace(COLOR,"");
}
function hazardousIdentity(item) {
 const identity=observedIdentity(item);
 return !!identity && HAZARD.test(identity);
}
function automaticCategory(item) {
 const identity = observedIdentity(item);
 if(!identity || HAZARD.test(identity) || REPRESENTATION.test(identity) || UNCERTAIN.test(identity) || INSTRUCTION.test(identity))return null;
 // Specific recognition of electrical waste must take priority over packaging.
 if(/^(?:(?:mobile|cell|phone|usb|wall|power)\s+)?(?:charger|power adapter|usb adapter|electrical adapter)$/.test(identity)
  || /^(?:used\s+)?(?:battery|batteries|lithium battery|phone battery|electronic circuit board|light bulb|fluorescent lamp|electronic device|mobile phone|cell phone)$/.test(identity))
  return "Special Waste";
 // Plant-only discarded material; generic food scraps are intentionally excluded.
 if(/^(?:banana|mango|orange|apple|fruit|vegetable|potato)\s+peels?$/.test(identity)
  || /^(?:plant[- ]only\s+)?(?:vegetable|fruit)\s+scraps$/.test(identity)
  || /^(?:dry\s+)?leaves$/.test(identity) || /^(?:grass\s+clippings|garden\s+trimmings)$/.test(identity))
  return "Biodegradable";
 // Common multi-layer food wrappers: a *suggestion*, not a disposal guarantee.
 if(/^(?:(?:empty|opened|torn)\s+)?(?:snack|food|candy|chocolate|biscuit|chips)\s+(?:wrapper|sachet|packet)$/.test(identity)
  || /^(?:(?:plastic|foil|metalized|metallized|food|snack|candy|chocolate|biscuit|chips|chip|instant noodle)\s+)*(?:snack wrapper|food wrapper|candy wrapper|chocolate wrapper|biscuit wrapper|chip wrapper|chips wrapper|foil wrapper|plastic wrapper|sachet|snack sachet|snack packet|food packet|chips packet)$/.test(identity)
  || /^(?:snack|candy|chocolate|biscuit|chips|food)\s+(?:packaging|wrapper|sachet|packet)$/.test(identity))
  return "Residual";
 // Automatic household recycling *suggestions*. Actual acceptance depends on
 // contents/condition and confirmed local handling, not an image alone.
 // A cap is not a nozzle/pump. Require the original beverage identity, not
 // color, brand text or a generic bottle silhouette, for these extra phrases.
 if(/^(?:(?:empty|clean|ordinary)\s+)*(?:(?:plastic|pet|hdpe|glass)\s+)?(?:water|drinking water|beverage|soda)\s+bottle(?:\s+with\s+(?:a\s+)?(?:screw\s+)?cap)?$/.test(identity)
  || /^(?:(?:empty|clean|ordinary)\s+)*(?:plastic water|plastic|pet|hdpe|glass|water|drinking water|beverage|soda)?\s*bottle$/.test(identity)
  || /^(?:(?:empty|clean)\s+)?(?:plastic|pet|hdpe|glass)\s+(?:jar|container)$/.test(identity)
  || /^(?:(?:clean|dry|clean dry|unused|empty)\s+)?(?:cardboard|cardboard box|paperboard|corrugated cardboard)$/.test(identity)
  || /^(?:(?:clean|dry|clean dry|unused)\s+)(?:paper|newspaper|office paper|magazine)$/.test(identity)
  || /^(?:(?:empty|clean)\s+)?(?:aluminum|aluminium|tin|steel|metal)\s+(?:can|food can|beverage can)$/.test(identity))
  return "Recyclable";
 return null;
}
// The external provider's structured evidence can veto a broad identity-based
// suggestion, but a category-only provider claim is not itself sufficient.
function unsafeProviderEvidence(provider,category) {
 if(!provider || !CATEGORIES.has(category))return false;
 if(["used_nonhazardous","contaminated_nonhazardous"].includes(provider.condition))return true;
 if(category === "Recyclable" && (provider.kind === "battery" || provider.kind === "electrical"
  || (provider.evidence === "visible" && provider.material === "mixed")
  || (provider.category === "Special Waste" && provider.evidence === "visible")))return true;
 if(category === "Biodegradable" && provider.kind === "battery")return true;
 return false;
}
function unsafeIdentity(item) {
 const identity=observedIdentity(item);
 const contents=/\b(?:spray|pump|nozzle|cosmetic|detergent|soap|shampoo|lotion|oil)\b.*\b(?:bottle|container)\b|\b(?:bottle|container)\b.*\b(?:spray|pump|nozzle|cosmetic|detergent|soap|shampoo|lotion|oil)\b/;
 return !!identity && (HAZARD.test(identity)||REPRESENTATION.test(identity)||INSTRUCTION.test(identity)||contents.test(identity));
}
module.exports = {automaticCategory,unsafeProviderEvidence,hazardousIdentity,unsafeIdentity};
