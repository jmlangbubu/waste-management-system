"use strict";
// Display only: never use these broad names as classification evidence.
const { matchIdentity } = require("../gemini-waste-classifier-cloudrun/cropRecognition");
const types = [
  [/\binstant noodle (?:packet|packaging|sachet)\b/, "Instant Noodle Packet"],
  [/\bsnack (?:wrapper|wrapping|sachet|packet|packaging)\b/, "Snack Wrapper"],
  [/\bfood (?:wrapper|wrapping|sachet|packet|packaging)\b/, "Food Wrapper"],
  [/\b(?:sunscreen|sunblock|cosmetic) (?:product )?(?:container|bottle|tube|jar)\b/, "Cosmetic Container"],
  [/\bpaper envelope\b/, "Paper Envelope"],
  [/\bcardboard\b/, "Cardboard"],
  [/\bplant (?:scraps|stems|trimmings)\b/, "Plant Scraps"],
  [/\b(?:chargers?|power adapters?)\b/, "Charger"],
  [/\b(?:batter(?:y|ies))\b/, "Battery"],
  [/\bbottles?\b/, "Bottle"], [/\b(?:spray cans?|cans?)\b/, "Can"],
  [/\b(?:wrappers?|wrappings?)\b/, "Wrapper"],
  [/\b(?:sachets?|packets?)\b/, "Packet"],
  [/\b(?:cosmetics?|makeup|powder)\s+(?:cases?|compacts?)\b/, "Container"],
  [/\b(?:containers?|jars?|boxes|box|tubs?|pots?|cartons?|packages?|packaging|sachets?|packets?|tubes?)\b/, "Container"],
  [/\b(?:compact|palette)\b.*\b(?:powder|cosmetics?|makeup|blush|eyeshadow|foundation)\b|\b(?:powder|cosmetics?|makeup|blush|eyeshadow|foundation)\b.*\b(?:compact|palette)\b/, "Container"],
  [/\b(?:pens?|ballpens?|ballpoint pens?)\b/, "Pen"], [/\bpencils?\b/, "Pencil"],
  [/\bspoons?\b/, "Spoon"], [/\bforks?\b/, "Fork"], [/\b(?:knives|knife)\b/, "Knife"],
  [/\b(?:cables?|cords?|wires?)\b/, "Cable"], [/\b(?:light bulbs?|bulbs?)\b/, "Bulb"],
  [/\b(?:phones?|smartphones?)\b/, "Phone"], [/\b(?:circuit boards?)\b/, "Circuit Board"],
  [/\bcardboard\b/, "Cardboard"], [/\bpaper\b/, "Paper"],
  [/\b(?:food scraps?|food waste|fruit peels?|vegetable scraps?)\b/, "Food Scraps"],
  [/\bbanana peels?\b/, "Banana Peel"], [/\bbananas?\b/, "Banana"],
  [/\b(?:leaves|leaf)\b/, "Leaf"], [/\b(?:clothing|clothes|garments?)\b/, "Clothing"],
  [/\b(?:shoes?|footwear)\b/, "Shoe"], [/\b(?:bags?)\b/, "Bag"],
  [/\b(?:cups?|mugs?)\b/, "Cup"], [/\bplates?\b/, "Plate"]
];
const householdNouns = new Set(("hammer screwdriver scissors brush comb toothbrush towel cloth sponge soap mask glove toy remote watch clock "
  + "keyboard mouse headphone earphone computer laptop screen monitor pan bowl bin bucket basket tool device chair table book notebook newspaper envelope tissue").split(" "));
function shortObjectName(value) {
  const text = typeof value === "string" ? value.toLowerCase().replace(/[_-]+/g, " ") : "";
  if (/\b(?:unknown|unidentified|unclear|unrecognizable|possibly|maybe)\b|\bnot a\b/.test(text)) return "Item";
  // A broad provider taxonomy does not prove which particular container is present.
  const noun = text.match(/\b[a-z]+\b/g)?.map(word => householdNouns.has(word) ? word : word.replace(/s$/, ""))
    .findLast(word => householdNouns.has(word));
  const type = /\bbottled and jarred packaged goods\b/.test(text) ? "Container"
    : types.find(([pattern]) => pattern.test(text))?.[1] || (noun ? noun[0].toUpperCase() + noun.slice(1) : "Item");
  // More than one color (e.g. a colored cap) is ambiguous: do not pick one.
  const colors = [...new Set((text.match(/\b(?:black|white|red|green|blue|yellow|orange|purple|pink|brown|gray|grey|clear|transparent)\b/g) || [])
    .map(color => color === "grey" ? "gray" : color === "transparent" ? "clear" : color))];
  if (type === "Item") return type;
  return (colors.length === 1 && type.split(" ").length < 3 ? colors[0][0].toUpperCase() + colors[0].slice(1) + " " : "") + type;
}
function withDisplayNames(result) {
  return { ...result, detectedItems: (result.detectedItems || []).map(item => ({ ...item,
    originalItemName: item.originalItemName || item.itemName,
    itemName: (() => {
      const original = item.originalItemName || item.itemName;
      // Android v5 validates known Gemini categories against the exact catalog
      // name before it binds sidecar IDs. Compacting that name rejects the owner.
      const catalog = item.analysisSource === "gemini_whole_image" ? matchIdentity(original) : null;
      const observed = catalog ? matchIdentity(item.observedIdentity) : null;
      if (catalog && catalog.itemName === original && catalog.category === item.category
          && observed?.itemName === original && observed.category === item.category) return original;
      const primary = shortObjectName(original);
      // Only use another observation when the original was merely "item" or "object".
      // Explicitly uncertain/negated provider labels must never be overridden.
      if (primary !== "Item" || !/^(?:items?|objects?|household items?|household objects?)$/i.test(String(original || "").trim())) return primary;
      return shortObjectName(item.observedIdentity);
    })()
  })) };
}
module.exports = { shortObjectName, withDisplayNames };
