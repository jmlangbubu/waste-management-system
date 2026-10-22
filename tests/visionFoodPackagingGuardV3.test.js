"use strict";
// Offline synthetic regression for the V3 correction; no live API requests.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { automaticCategory } = require("../services/automaticWasteCategoryMapper");
const { normalizeDetectedItems } = require("../services/wasteAnalysisService");
const { createAssessmentService } = require("../services/perItemWasteAssessmentService");
const box = { left: 0.1, top: 0.1, right: 0.3, bottom: 0.5 };
const vision = name => normalizeDetectedItems([{ name, score: 0.93, boundingBox: box }], "google_vision_object_localization")[0];

test("generic food packaging does not prove a discarded wrapper", () => {
  for (const name of ["Food packaging", "Packaged food", "Food package", "Food packages"]) {
    const item = { analysisSource: "google_vision_object_localization", observedIdentity: name, category: "Unknown", boundingBox: box };
    assert.equal(automaticCategory(item), null, name);
    assert.equal(vision(name)?.category, "Unknown", name);
  }
});

test("specific independently supported categories remain intact", () => {
  for (const [name, expected] of [
    ["Empty snack wrapper", "Residual"],
    ["Banana peel", "Biodegradable"],
    ["White charger", "Special Waste"],
    ["Plastic beverage bottle", "Recyclable"],
    ["Unopened instant noodle packet", "Unknown"]
  ]) assert.equal(vision(name)?.category, expected, name);
});

test("insufficient per-item facts cannot re-promote Food packaging to Residual", async () => {
  const capture = {
    captureId: crypto.randomUUID(), requestId: crypto.randomUUID(),
    image: Buffer.from("ffd8ffc0000b080190025801011100ffd9", "hex").toString("base64"),
    width: 600, height: 400, orientation: "upright"
  };
  const items = [vision("Food packaging")];
  let count = 0;
  const assess = createAssessmentService({
    env: {
      WASTE_ITEM_ASSESSMENT_ENABLED: "true", WASTE_ITEM_ASSESSMENT_AI_ENABLED: "true",
      CLOUD_RUN_AUTH_MODE: "iam", CLOUD_RUN_AUDIENCE: "https://synthetic.invalid",
      GEMINI_CLASSIFIER_URL: "https://synthetic.invalid/classify-waste",
      WASTE_ITEM_ASSESSMENT_SHARED_TOKEN: "offline-only-token-longer-than-thirty-two-characters"
    },
    authHeaders: async () => ({}),
    transport: async (_url, input) => {
      count++;
      return {
        schemaVersion: 1, requestId: input.requestId, captureId: input.captureId,
        assessments: input.items.map(item => ({
          itemId: item.itemId, category: "Unknown", kind: "unknown",
          material: "unknown", condition: "unknown", evidence: "insufficient"
        }))
      };
    }
  });
  const result = await assess({ capture, items, principal: 5 });
  assert.equal(count, 1);
  assert.equal(result.items[0].itemId, items[0].itemId);
  assert.equal(result.items[0].category, "Unknown");
});
