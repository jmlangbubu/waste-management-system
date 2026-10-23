"use strict";
const { commonObjectCategory } = require("../utils/wasteMapper");
// Provisional *household* category suggestions from original, independently
// localized recognition evidence. Never use shortened UI display names.
const TRUSTED = new Set(["gemini_whole_image", "google_vision_object_localization"]);
const CATEGORIES = new Set(["Biodegradable", "Recyclable", "Residual", "Special Waste"]);
const HAZARD = /\b(?:chemical(?:s)?|pesticide|insecticide|herbicide|bleach|disinfectant|solvent|paint(?:\s+thinner)?|thinner|motor\s+oil|engine\s+oil|fuel|gasoline|kerosene|acid|pharmaceutical|medicine|medication|medical\s+waste|sharps?|syringes?|aerosol|spray\s+paint|unknown\s+contents?|contaminat\w*|hazard\w*)\b/;
const REPRESENTATION = /\b(?:picture|drawing|photo(?:graph)?|printed\s+(?:image|picture)|illustration|logo|advertisement|toy|replica|label\s+showing)\b/;
const UNCERTAIN = /\b(?:maybe|possibly|probably|looks\s+like|appears\s+to\s+be|unidentified|unclassified|unknown|unclear|unsure|uncertain|ambiguous|generic|could\s+be)\b/;
const INSTRUCTION = /\b(?:ignore\s+(?:all|previous|prior)|system\s+prompt|follow\s+instructions|classify\s+as|return\s+(?:json|category))\b|```/;
const COLOR = /^(?:(?:light|dark)\s+)?(?:black|white|red|green|blue|yellow|orange|gray|grey|brown|clear|transparent|pink|purple)\s+/;
// Exact physical identities only; never restore the legacy substring scorer.
const SPECIAL_OBJECTS = new Set(["paint can","syringe","needle","electronic item","car battery",
 "charging brick","extension cord","electronic waste","e waste","broken light bulb",
 "spray can","power bank","circuit board","electronics"]);
function observedIdentity(item) {
 if(!item || !TRUSTED.has(item.analysisSource) || item.recognitionState === "unlocalized_observation"
  || (item.recognitionState && item.recognitionState !== "localized_observation")
  || !item.boundingBox || item.category !== "Unknown")return null;
 const b=item.boundingBox;
 if(Object.keys(b).sort().join(",")!=="bottom,left,right,top"
  || ![b.left,b.top,b.right,b.bottom].every(n=>typeof n==="number"&&Number.isFinite(n)&&n>=0&&n<=1)
  || b.left>=b.right || b.top>=b.bottom)return null;
 const label = item.analysisSource === "gemini_whole_image"
  ? item.observedIdentity
  : (item.observedIdentity || item.originalItemName || item.canonicalItem);
 if(typeof label !== "string" || !label.trim() || label.length > 128 || /[\x00-\x1f<>]/.test(label))return null;
 const normalized=label.toLowerCase().trim().replace(/\s+/g," ");
 // An exact object identity (e.g. Orange Peel) must not lose its noun as color.
 return commonObjectCategory(normalized)?normalized:normalized.replace(COLOR,"");
}
function hazardousIdentity(item) {
 const identity=observedIdentity(item);
 return !!identity && HAZARD.test(identity);
}
function unreliablePhysicalIdentity(item) {
 const identity=observedIdentity(item);
 return !!identity && (REPRESENTATION.test(identity) || UNCERTAIN.test(identity) || INSTRUCTION.test(identity)
  || /\bnot (?:a|an)\b/.test(identity));
}
function physicalSpecialWasteIdentity(item) {
 const identity=observedIdentity(item),b=item?.boundingBox;
 if(!identity || unreliablePhysicalIdentity(item)
  || !b || Object.keys(b).sort().join(",")!=="bottom,left,right,top"
  || ![b.left,b.top,b.right,b.bottom].every(n=>typeof n==="number"&&Number.isFinite(n)&&n>=0&&n<=1)
  || b.left>=b.right || b.top>=b.bottom)return null;
 return SPECIAL_OBJECTS.has(identity.replace(/-/g," "))
  || commonObjectCategory(identity)==="Special Waste"
  || /^(?:(?:mobile|cell|phone|usb|wall|power)\s+)?(?:charger|power adapter|usb adapter|electrical adapter)$/.test(identity)
  || /^(?:used\s+)?(?:battery|batteries|lithium battery|phone battery|electronic circuit board|light bulb|fluorescent lamp|electronic device|mobile phone|cell phone)$/.test(identity)
  ? identity : null;
}
function requiresWasteIdentityReview(item,originalItem=item) {
 const identity=observedIdentity(item);
 // Broad packaged-food taxonomies still do not identify a waste object.
 return !!identity && /^(?:food packaging|packaged food|food packages?|packaged goods)$/.test(identity);
}
// Shared acceptance rule, including already-known catalog categories. Inputs
// are original localized evidence; aligned must come from capture-bound merge
// provenance, never itemName/display text or a scene-wide primary classifier.
function productStateVeto(item,category,aligned=null) {
 if(!["Residual","Recyclable"].includes(category))return false;
 if(!item || !TRUSTED.has(item.analysisSource))return false;
 if(!item.boundingBox)return true;
 const raw=[item.observedIdentity,item.originalItemName];
 if(!raw.some(value=>typeof value==="string" && value.trim()))raw.push(item.canonicalItem);
 if(aligned)raw.push(aligned);
 const labels=raw.filter(value=>typeof value==="string" && value.trim())
  .map(value=>value.toLowerCase().trim().replace(/\s+/g," "));
 const packaging=/\b(?:bottles?|jars?|containers?|cans?|packets?|sachets?|wrappers?|pouches?|packag(?:e|es|ed|ing))\b/;
 if(!labels.some(label=>packaging.test(label)))return false;
 if(labels.some(label=>label.length>160 || /[\x00-\x1f<>]/.test(label)
   || REPRESENTATION.test(label)||UNCERTAIN.test(label)||INSTRUCTION.test(label)
   || unsafeIdentity({...item,category:"Unknown",observedIdentity:label})
   || /\b(?:unopened|sealed|full|filled|containing|contains|not empty|not discarded|not (?:a|an))\b/.test(label)))return true;
 // Approved ordinary common-object policy: an explicit adverse state still
 // vetoes above, but absence of an empty qualifier alone is not a veto.
 if(labels.some(label=>commonObjectCategory(label)===category))return false;
 // Opened/torn and a recognized product name alone do not establish removal
 // of contents. Empty/discarded is still provisional, not verified ground truth.
 return !labels.some(label=>packaging.test(label) && /^(?:(?:light|dark)\s+)?(?:(?:black|white|red|green|blue|yellow|orange|gray|grey|brown|clear|transparent|pink|purple)\s+)?(?:empty|discarded)\s+/.test(label));
}
function automaticCategory(item) {
 const category=identityCategory(item);
 return productStateVeto(item,category)?null:category;
}
function identityCategory(item) {
 const identity = observedIdentity(item);
 if(!identity || REPRESENTATION.test(identity) || UNCERTAIN.test(identity) || INSTRUCTION.test(identity))return null;
 // Exact physical hazardous-object identity retains safety priority during
 // localization/deduplication. This does not establish contents or cleanliness.
 if(physicalSpecialWasteIdentity(item))return "Special Waste";
 const common=commonObjectCategory(identity);
 if(common==="Special Waste")return common;
 if(HAZARD.test(identity))return null;
 if(unsafeIdentity(item))return null;
 // A provider's generic food-packaging taxonomy does not establish discarded,
 // empty multilayer wrapping. Keep specific independently evidenced wrappers.
 if(requiresWasteIdentityReview(item))return null;
 if(common)return common;
 // Plant-only discarded material; generic food scraps are intentionally excluded.
 if(/^(?:banana|mango|orange|apple|fruit|vegetable|potato)\s+peels?$/.test(identity)
  || /^(?:plant[- ]only\s+)?(?:vegetable|fruit)\s+scraps$/.test(identity)
  || /^(?:dry\s+)?leaves$/.test(identity) || /^(?:grass\s+clippings|garden\s+trimmings)$/.test(identity))
  return "Biodegradable";
 // Common multi-layer food wrappers: a *suggestion*, not a disposal guarantee.
 if(/^(?:(?:empty|discarded|opened|torn)\s+)?(?:snack|food|candy|chocolate|biscuit|chips|instant noodle)\s+(?:wrapper|sachet|packet)$/.test(identity)
  || /^(?:(?:plastic|foil|metalized|metallized|food|snack|candy|chocolate|biscuit|chips|chip|instant noodle)\s+)*(?:snack wrapper|food wrapper|candy wrapper|chocolate wrapper|biscuit wrapper|chip wrapper|chips wrapper|foil wrapper|plastic wrapper|sachet|snack sachet|snack packet|food packet|chips packet)$/.test(identity)
  || /^(?:snack|candy|chocolate|biscuit|chips|food)\s+(?:packaging|wrapper|sachet|packet)$/.test(identity))
  return "Residual";
 // Automatic household recycling *suggestions*. Actual acceptance depends on
 // contents/condition and confirmed local handling, not an image alone.
 // A cap is not a nozzle/pump. Require the original beverage identity, not
 // color, brand text or a generic bottle silhouette, for these extra phrases.
 if(/^(?:(?:empty|clean|ordinary)\s+)*(?:(?:plastic|pet|hdpe|glass)\s+)?(?:water|drinking water|beverage|soda)\s+bottle(?:\s+with\s+(?:a\s+)?(?:screw\s+)?cap)?$/.test(identity)
  || /^(?:(?:empty|clean|ordinary)\s+)*(?:plastic water|plastic|pet|hdpe|glass|water|drinking water|beverage|soda)\s+bottle$/.test(identity)
  || /^(?:(?:empty|clean)\s+)?(?:plastic|pet|hdpe|glass)\s+(?:jar|container)$/.test(identity)
  || /^(?:(?:clean|dry|clean dry|unused|empty)\s+)?(?:cardboard|cardboard box|paperboard|corrugated cardboard)$/.test(identity)
  || /^(?:(?:clean|dry|clean dry|unused)\s+)(?:paper|newspaper|office paper|magazine)$/.test(identity)
  || /^(?:sheet of paper|paper sheet|cardboard carton)$/.test(identity)
  || /^(?:(?:empty|clean)\s+)?(?:aluminum|aluminium|tin|steel|metal)\s+(?:can|food can|beverage can)$/.test(identity))
  return "Recyclable";
 // Ordinary, specifically identified non-recoverable household objects. This is
 // deliberately not a catch-all for generic objects, contents or contamination.
 // Existing hazard/representation/uncertainty gates above still take priority.
 if(/^(?:rubber band|(?:broken\s+)?ceramic\s+(?:cup|mug|plate|shard))$/.test(identity))
  return "Residual";
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
 const contents=/\b(?:spray|pump|nozzle|cosmetic|sunscreen|sunblock|spf|detergent|soap|shampoo|lotion|cream|oil)\b.*\b(?:bottle|container|tube|jar|vial|canister)\b|\b(?:bottle|container|tube|jar|vial|canister)\b.*\b(?:spray|pump|nozzle|cosmetic|sunscreen|sunblock|spf|detergent|soap|shampoo|lotion|cream|oil)\b/;
 // A spray can carries unresolved contents/pressure risk, unlike a generic
 // can. This is a veto signal, not evidence of a particular chemical/category.
 return !!identity && (HAZARD.test(identity)||REPRESENTATION.test(identity)||INSTRUCTION.test(identity)||contents.test(identity)
  || /\bspray\s+cans?\b/.test(identity));
}
// An optional model category is not proof by itself. Bridge the strict facts
// validator only when the ORIGINAL localized identity independently corroborates
// the structured kind/material without requiring hidden condition/material
// assertions. Never rewrite unknown attributes into asserted facts.
const identityMaterials=identity=>new Set([["paper","paper"],["cardboard","cardboard"],
 ["glass","glass"],["aluminum","aluminum"],["aluminium","aluminum"]]
 .filter(([word])=>new RegExp("\\b"+word+"\\b").test(identity)).map(([,material])=>material));
function providerIdentityConflict(item,provider) {
 const identity=observedIdentity(item);
 if(!identity || provider?.evidence!=="visible")return false;
 const materials=identityMaterials(identity),electrical=/\b(?:electric|electrical|electronic|batter(?:y|ies)|charger|circuit|light bulb|fluorescent)\b/.test(identity);
 if(materials.size===1 && ["electrical","battery"].includes(provider.kind) && !electrical)return true;
 if(materials.size===1 && provider.kind==="single_material" && provider.material!=="unknown"
  && !materials.has(provider.material))return true;
 if(electrical && !["electrical","battery","unknown"].includes(provider.kind))return true;
 return false;
}
function corroboratedCategory(item,provider) {
 const identity=observedIdentity(item);
 if(!identity || productStateVeto(item,provider?.category) || requiresWasteIdentityReview(item) || unsafeIdentity(item) || UNCERTAIN.test(identity)
  || /\b(?:uncertain|not|used|dirty|soiled|tissue|contaminated|label|logo|printed|containing|contains|filled|with)\b/.test(identity)
  || !provider || provider.evidence!=="visible" || provider.condition!=="unknown"
  || !CATEGORIES.has(provider.category) || providerIdentityConflict(item,provider))return null;
 if(provider.category==="Recyclable" && provider.kind==="single_material") {
  // No polymer inference: general plastic, shape, color and brand are not cues.
  // Mixed/laminated constructions cannot be promoted as single-material waste.
  if(/\b(?:plastic|rubber|ceramic|metal|foil|laminated)\b/.test(identity))return null;
  const materials=identityMaterials(identity);
  if(materials.size===1 && (provider.material==="unknown" || materials.has(provider.material)))return "Recyclable";
 }
 if(provider.category==="Biodegradable" && provider.kind==="plant_food_scraps"
  && ["plant_matter","unknown"].includes(provider.material)
  && /\b(?:plant|fruit|vegetable|garden|grass|leaves|leaf)\b/.test(identity)
  && /\b(?:peels?|scraps|stems?|trimmings|grass|leaves|leaf)\b/.test(identity)
  && !/\b(?:plastic|meat|fish|bones?|dairy)\b/.test(identity))return "Biodegradable";
 if(provider.category==="Residual" && provider.kind==="wrapper"
  && ["mixed","unknown"].includes(provider.material)
  && /\b(?:food|snack|candy|chocolate|biscuit|chips)\b/.test(identity)
  && /\b(?:wrapper|sachet|packet|packaging)\b/.test(identity))return "Residual";
 return null;
}
module.exports = {automaticCategory,unsafeProviderEvidence,hazardousIdentity,unsafeIdentity,corroboratedCategory,providerIdentityConflict,requiresWasteIdentityReview,physicalSpecialWasteIdentity,unreliablePhysicalIdentity,productStateVeto,commonObjectCategory};
