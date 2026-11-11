"use strict";
// Display only: never use these broad names as classification evidence.
const { matchIdentity } = require("../gemini-waste-classifier-cloudrun/cropRecognition");
const types = [
  [/\binstant noodle (?:packet|package|packaging|wrapper|wrapping|sachet|pouch)\b/, "Instant Noodle Packet"],
  [/\bnoodle (?:packet|package|packaging|wrapper|wrapping|sachet|pouch)\b/, "Noodle Packet"],
  [/\bcoffee (?:sachet|packet)\b/, "Coffee Sachet"],
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
// Noodle display extensions accept a physical head, not a noun found anywhere
// in a sentence. Incidental label text cannot supply or negate that identity.
function affirmativeNoodleHead(text) {
  const head = text.match(/^(?:(?:an?|the|actual|physical|real|unlisted|brand)\s+)*((?:(?:unopened|sealed|full|filled|empty)\s+)?(?:(?:black|white|red|green|blue|yellow|orange|purple|pink|brown|gray|grey|clear|transparent)\s+)*(?:instant\s+)?noodle\s+(?:packet|package|packaging|wrapper|wrapping|sachet|pouch))\b/);
  if (!head) return "";
  const suffix = text.slice(head[0].length).trim();
  if (!suffix) return head[1];
  const incidental = /^(?:with|without)\s+(?:(?:an?|the|no|possible|unreadable|printed|visible|missing|faded)\s+)*(?:label(?: artwork)?|packaging artwork|artwork|logo|(?:expiry|expiration) date|date|text|barcode|brand name|picture)(?:\s+(?:that (?:cannot|can't) be (?:identified|read|confirmed)|not visible|(?:of|depicting|showing)\s+(?:(?:an?|the)\s+)?[a-z]+(?:\s+[a-z]+){0,2}))?$/.test(suffix);
  const descriptive = /^(?:(?:lying|resting)\s+)?on (?:a|the) (?:table|surface|counter|floor)$|^with (?:torn|creased|folded) edges$/.test(suffix);
  return incidental || descriptive ? head[1] : "";
}
function shortObjectName(value) {
  let text = typeof value === "string" ? value.toLowerCase().replace(/[_-]+/g, " ") : "";
  if (/\b(?:instant\s+)?noodle\s+(?:packet|package|packaging|wrapper|wrapping|sachet|pouch)\b/.test(text)) {
    text = affirmativeNoodleHead(text.trim());
    if (!text) return "Item";
  }
  // These bounded description guards affect display only, never recognition evidence.
  const uncertain = /\b(?:unknown|unidentified|unclear|unrecognizable|possible|possibly|probably|perhaps|maybe|uncertain|unsure|ambiguous)\b|\b(?:may|might|could)\s+be\b/.test(text);
  const unidentifiable = /\b(?:cannot|can't|unable to)\s+(?:(?:be\s+)?identified|identify|confirm|recognize|determine)\b/.test(text);
  // Negate the packaging identity, not incidental text such as "no label".
  const negated = /\bnot (?:a|an)\b|\b(?:not|no)\s+(?:(?:an?|any|actual|physical)\s+)*(?:(?:instant\s+)?noodle|snack|food)\s+(?:packet|package|packaging|wrapper|wrapping|sachet|pouch)\b/.test(text);
  const absent = /\b(?:(?:instant\s+)?noodle|snack|food)\s+(?:packet|package|packaging|wrapper|wrapping|sachet|pouch)\s+(?:(?:is|was)\s+)?not\s+(?:visible|present|identifiable|confirmed)\b/.test(text);
  // Leading artwork references are not packages. Actual packages with printed
  // text/artwork remain eligible because their physical identity leads the label.
  const referenceOnly = /^\s*(?:(?:(?:this|that|it)\s+is|there\s+is)\s+)?(?:(?:an?|the|only|visible|printed|label|packaging)\s+)*(?:picture|image|photo(?:graph)?|drawing|illustration|artwork|depiction|logo|advertisement|product reference)\s+(?:of|showing|depicting)\b/.test(text);
  if (uncertain || unidentifiable || negated || absent || referenceOnly) return "Item";
  // A broad provider taxonomy does not prove which particular container is present.
  const noun = text.match(/\b[a-z]+\b/g)?.map(word => householdNouns.has(word) ? word : word.replace(/s$/, ""))
    .findLast(word => householdNouns.has(word));
  const type = /\bbottled and jarred packaged goods\b/.test(text) ? "Container"
    : types.find(([pattern]) => pattern.test(text))?.[1] || (noun ? noun[0].toUpperCase() + noun.slice(1) : "Item");
  // More than one color (e.g. a colored cap) is ambiguous: do not pick one.
  const colors = [...new Set((text.match(/\b(?:black|white|red|green|blue|yellow|orange|purple|pink|brown|gray|grey|clear|transparent)\b/g) || [])
    .map(color => color === "grey" ? "gray" : color === "transparent" ? "clear" : color))];
  if (type === "Item") return type;
  // Preserve explicitly observed packaging/product state instead of hiding it.
  // This is display-only; never use this string as assessment evidence.
  const state = text.match(/^(unopened|sealed|full|filled|empty)\s+/);
  const qualifier = state ? state[1][0].toUpperCase() + state[1].slice(1) + " " : "";
  return qualifier + (colors.length === 1 && type.split(" ").length < 3 ? colors[0][0].toUpperCase() + colors[0].slice(1) + " " : "") + type;
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
      if (catalog && catalog.itemName === original && (item.category === "Unknown" || catalog.category === item.category)
          && observed?.itemName === original && observed.category === catalog.category) return original;
      const primary = shortObjectName(original);
      // Only use another observation when the original was merely "item" or "object".
      // Explicitly uncertain/negated provider labels must never be overridden.
      if (primary !== "Item" || !/^(?:items?|objects?|household items?|household objects?)$/i.test(String(original || "").trim())) return primary;
      return shortObjectName(item.observedIdentity);
    })()
  })) };
}
module.exports = { shortObjectName, withDisplayNames };
