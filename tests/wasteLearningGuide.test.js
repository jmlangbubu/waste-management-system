const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { getWasteLearningGuide } = require("../services/wasteLearningGuideService");

const models = {
  "plastic bottle": ["plastic_bottle", "Recyclable"], "glass bottle": ["glass_bottle", "Recyclable"],
  "aluminum can": ["aluminum_can", "Recyclable"], "tin can": ["tin_can", "Recyclable"],
  cardboard: ["cardboard", "Recyclable"], paper: ["paper", "Recyclable"],
  "banana peel": ["banana_peel", "Biodegradable"], "food waste": ["food_waste", "Biodegradable"],
  battery: ["battery", "Special Waste"], "light bulb": ["light_bulb", "Special Waste"],
  "plastic bag": ["plastic_bag", "Recyclable"], sachet: ["sachet", "Residual"]
};
for (const [name, [key, category]] of Object.entries(models)) test(`${name} has the supported ${key} model`, () => {
  const result = getWasteLearningGuide(name, category);
  assert.equal(result.modelKey, key);
  for (const field of ["whatItIs", "properDisposal", "preparation", "environmentalImpact"]) assert.ok(result[field].length > 0);
  for (const field of ["reuseIdeas", "recoveryOptions", "warnings", "modelHotspots"]) assert.ok(Array.isArray(result[field]) && result[field].length <= 4);
  assert.ok(result.warnings.length > 0 && result.recoveryOptions.length > 0);
});
for (const [category, key] of Object.entries({ Recyclable: "generic_recyclable", Biodegradable: "generic_biodegradable", Residual: "generic_residual", "Special Waste": "generic_special_waste" })) {
  test(`unknown item has ${key} guidance`, () => assert.equal(getWasteLearningGuide("Unknown shape", category).modelKey, key));
}
test("plastic bottle provides safe empty/rinse/cap/label guidance and three hotspots", () => {
  const guide = getWasteLearningGuide("Plastic Bottle", "Recyclable");
  assert.match(guide.preparation, /Empty.*rinse.*cap and label/);
  assert.match(guide.recoveryOptions[0], /May be accepted.*depending on local rules/);
  assert.match(guide.reuseIdeas.join(" "), /planter.*when safe/);
  assert.match(guide.warnings.join(" "), /burning plastic/);
  assert.deepEqual(guide.modelHotspots.map((item) => item.key), ["cap", "label", "body"]);
});
test("banana peel guidance explains suitable composting, segregation, nutrients and no litter", () => {
  const guide = getWasteLearningGuide("banana peel", "Biodegradable");
  assert.match(guide.properDisposal, /separate from recyclables.*compost when suitable/);
  assert.match(guide.environmentalImpact, /nutrients/);
  assert.match(guide.warnings.join(" "), /littering/);
});
test("metal can guidance warns about sharp edges and unsafe food reuse", () => {
  for (const name of ["aluminum can", "tin can"]) {
    const guide = getWasteLearningGuide(name, "Recyclable");
    assert.match(guide.preparation, /Empty and rinse/);
    assert.match(guide.warnings.join(" "), /sharp.*do not reuse.*food/);
  }
});
test("battery guidance requires special collection and avoids casual reuse", () => {
  const guide = getWasteLearningGuide("battery", "Special Waste");
  assert.equal(guide.modelKey, "battery");
  assert.deepEqual(guide.reuseIdeas, []);
  assert.match(guide.properDisposal, /Never mix.*battery or e-waste collection/);
  assert.match(guide.warnings.join(" "), /Do not burn, puncture.*Do not attempt casual reuse/);
});
test("contaminated bottle keeps residual disposal rather than recommending recycling", () => {
  const guide = getWasteLearningGuide("dirty plastic bottle", "Residual");
  assert.match(guide.properDisposal, /residual/);
  assert.deepEqual(guide.reuseIdeas, []);
  assert.match(guide.modelHotspots[2].guidance, /Contamination may prevent/);
});
test("guidance is deterministic, independent per request and has no DB/network dependency", () => {
  const first = getWasteLearningGuide("Battery", "Special Waste");
  const second = getWasteLearningGuide("Battery", "Special Waste");
  assert.deepEqual(first, second);
  first.warnings.push("test mutation");
  assert.notDeepEqual(first, second);
  const source = fs.readFileSync(path.join(__dirname, "../services/wasteLearningGuideService.js"), "utf8");
  assert.doesNotMatch(source, /config\/db|fetch\(|https|gemini|mysql/i);
});
