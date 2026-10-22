const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const visionHelpers = require("../services/googleVisionService");
const mapper = require("../utils/wasteMapper");
const guide = require("../services/wasteLearningGuideService");
const plain = (value) => JSON.parse(JSON.stringify(value));
const box = { left: .10, top: .10, right: .35, bottom: .85 };
const object = (name = "Plastic Bottle", confidence = .92, boundingBox = box) => ({ name, confidence, boundingBox });
const synthetic = [object(), object("Banana", .88, { left: .40, top: .35, right: .65, bottom: .78 }),
  object("Battery", .90, { left: .70, top: .40, right: .88, bottom: .72 })];

function loadAnalysis({ objects = [], external = null, local = null, visionFailure = false, externalStatus = 200,
  visionImplementation = null, localImplementation = null, fastLocalizationTimeout = false } = {}) {
  const logs = [], calls = { vision: 0, external: 0, local: 0 };
  const logger = Object.fromEntries(["log", "warn", "error"].map((key) => [key, (...args) => logs.push(args.join(" "))]));
  const transport = { request(options, callback) {
    calls.external++;
    const request = new EventEmitter();
    request.write = () => {};
    request.destroy = (error) => request.emit("error", error);
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = externalStatus;
      callback(response);
      response.emit("data", JSON.stringify(external));
      response.emit("end");
    };
    return request;
  } };
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, console: logger, URL, Buffer,
    setTimeout: (callback, delay) => setTimeout(callback, fastLocalizationTimeout ? Math.min(delay, 5) : delay), clearTimeout,
    process: { env: { ...(external ? { GEMINI_CLASSIFIER_URL: "https://synthetic.invalid/classify" } : {}),
      ...(local ? { ALLOW_RENDER_GEMINI_DIRECT: "true" } : {}) } },
    require(id) {
      if(id==="./cloudRunDiagnostics") return require("../services/cloudRunDiagnostics");
      if (id === "./automaticWasteCategoryMapper") return require("../services/automaticWasteCategoryMapper");
      if (id === "http" || id === "https") return transport;
      if (id === "../utils/wasteMapper") return mapper;
      if (id === "./wasteLearningGuideService") return guide;
      if (id === "./wasteDisplayNameService") return require("../services/wasteDisplayNameService");
      if (id === "./googleVisionService") return { ...visionHelpers, async detectObjectsFromBase64() {
        calls.vision++;
        if (visionFailure) throw new Error("sensitive-provider-request-must-not-log");
        if (visionImplementation) return visionImplementation();
        return objects;
      } };
      if (id === "./geminiWasteClassifierService") return { async classifyWasteWithGemini() {
        calls.local++; return localImplementation ? localImplementation() : local;
      } };
      throw new Error(`Unexpected dependency: ${id}`);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../services/wasteAnalysisService.js"), "utf8"), context);
  return { ...module.exports, logs, calls };
}
const analysis = loadAnalysis();
const normalize = (items, classifier = false) => plain(analysis.normalizeDetectedItems(items, "synthetic", classifier));
const run = (service, input = {}) => service.analyzeWaste({ image: "c3ludGhldGljLWltYWdl", detectedObject: "captured_waste_item", ...input });

test("one localized object produces one entry with the full item contract", () => {
  const [item] = normalize([object()]);
  assert.deepEqual(Object.keys(item).sort(), ["itemId", "itemName", "canonicalItem", "category", "confidence", "analysisSource", "boundingBox", "modelKey", "guidance", "modelHotspots"].sort());
  assert.equal(item.itemId, "item_1");
  assert.equal(item.category, "Recyclable");
  assert.equal(item.modelKey, "plastic_bottle");
});
test("synthetic three-item response selects Plastic Bottle and counts each category", async () => {
  const result = plain(await run(loadAnalysis({ objects: synthetic })));
  assert.equal(result.detectedItems.length, 3);
  assert.deepEqual(result.detectedItems.map((item) => item.category), ["Recyclable", "Unknown", "Special Waste"]);
  assert.deepEqual(result.detectedItems.map((item) => item.modelKey), ["plastic_bottle", "", "battery"]);
  const banana = result.detectedItems[1];
  assert.equal(banana.itemName, "Banana");
  assert.equal(banana.analysisSource, "google_vision_object_localization");
  assert.equal(banana.confidence, synthetic[1].confidence);
  assert.deepEqual(banana.boundingBox, synthetic[1].boundingBox);
  assert.equal(result.itemName, "Plastic Bottle");
  assert.equal(result.aiConfidence, "0.92");
  assert.deepEqual(result.scanSummary, { totalItems: 3, categories: { biodegradable: 0, recyclable: 1, residual: 0, specialWaste: 1 } });
});
test("maximum eight keeps highest confidences without collapsing separate same-name objects", () => {
  const items = Array.from({ length: 12 }, (_, i) => object("Plastic Bottle", .40 + i * .04,
    { left: i / 12, right: (i + .5) / 12, top: .1, bottom: .9 }));
  const results = normalize(items);
  assert.equal(results.length, 8);
  assert.equal(results[0].confidence, .56);
});
test("minimum confidence is named, inclusive, finite and normalized", () => {
  assert.equal(analysis.MIN_OBJECT_CONFIDENCE, .40);
  assert.equal(analysis.MAX_DETECTED_ITEMS, 8);
  assert.equal(normalize([object("Paper", .39)]).length, 0);
  assert.equal(normalize([object("Paper", .40)]).length, 1);
  for (const confidence of [NaN, Infinity, -1, 1.1, null, "bad"]) assert.equal(normalize([object("Paper", confidence)]).length, 0);
});
test("malformed, reversed and degenerate boxes are discarded", () => {
  for (const boundingBox of [null, {}, { ...box, right: .1 }, { ...box, bottom: .1 }, { ...box, left: NaN }, { ...box, top: null }]) {
    assert.equal(normalize([object("Paper", .8, boundingBox)]).length, 0);
  }
});
test("out-of-range rectangle coordinates are rejected rather than fabricated into valid boxes", () => {
  assert.equal(normalize([object("Paper", .8, { left: -2, top: -.1, right: 4, bottom: 2 })]).length, 0);
  for (const boundingBox of [{ ...box, left: -.001 }, { ...box, bottom: 1.001 }]) {
    assert.equal(normalize([object("Paper", .8, boundingBox)]).length, 0);
  }
});
test("Google vertices normalize omitted zeros and reject malformed polygons", () => {
  assert.deepEqual(visionHelpers.normalizeBoundingBox({ normalizedVertices: [{}, { x: .5 }, { x: .5, y: .7 }, { y: .7 }] }),
    { left: 0, top: 0, right: .5, bottom: .7 });
  assert.equal(visionHelpers.normalizeBoundingBox({ normalizedVertices: [{}, {}] }), null);
  assert.equal(visionHelpers.normalizeBoundingBox({ normalizedVertices: [{}, { x: "bad" }, { y: .7 }] }), null);
  assert.equal(visionHelpers.normalizeBoundingBox({ normalizedVertices: [{}, {}, {}] }), null);
});
test("overlapping duplicates retain higher confidence including similar names", () => {
  const items = normalize([object("Bottle", .6), object("Plastic Bottle", .9), object("plastic bottles", .8)]);
  assert.equal(items.length, 1);
  assert.equal(items[0].confidence, .9);
});
test("ordinary overlap between different object names remains separate", () => assert.equal(normalize([object(),
  object("Battery", .8, { ...box, left: .2, right: .45 })]).length, 2));
test("plastic bottle maps through existing recyclable rules", () => assert.equal(normalize([object()])[0].category, "Recyclable"));
test("whole Banana remains Unknown while actual banana peel is biodegradable", () => {
  for (const source of ["synthetic", "google_vision_object_localization"]) {
    const items = plain(analysis.normalizeDetectedItems([object("Banana"), object("banana peel", .88,
      { ...box, left: .5, right: .7 })], source));
    assert.deepEqual(items.map(item => item.category), ["Unknown", "Biodegradable"]);
    assert.deepEqual(items.map(item => item.itemName), ["Banana", "banana peel"]);
    assert.equal(items[0].modelKey, "");
    assert.equal(items[1].modelKey, "banana_peel");
  }
});
test("all existing special-waste safety names remain Special Waste", () => {
  for (const name of ["battery", "charger", "electronic item", "chemical container", "light bulb", "syringe"]) {
    assert.equal(normalize([object(name)])[0].category, "Special Waste");
  }
});
test("dirty/contaminated Google objects retain mapper safety rules", () => {
  for (const name of ["dirty plastic bottle", "contaminated container"]) {
    const item = normalize([object(name)])[0];
    assert.equal(item.category, "Residual");
    assert.match(item.guidance.properDisposal, /residual/);
  }
});
test("primary uses highest confidence and input-order tie break", async () => {
  const result = await run(loadAnalysis({ objects: [object("Battery", .9), object("Paper", .9)] }));
  assert.equal(result.detectedObject, "Battery");
  assert.equal(result.category, "Special Waste");
});
test("summary includes residual and all zero categories for an empty result", () => {
  assert.deepEqual(plain(analysis.buildScanSummary(normalize([object("sachet")]))),
    { totalItems: 1, categories: { biodegradable: 0, recyclable: 0, residual: 1, specialWaste: 0 } });
  assert.equal(analysis.buildScanSummary().totalItems, 0);
});
test("Gemini single result is preserved when no localized objects exist", async () => {
  const external = { success: true, result: { itemName: "Glass Bottle", category: "Recyclable", confidence: .87,
    explanation: "Original explanation", action: "Original action", warning: "Original warning" } };
  const result = await run(loadAnalysis({ external }));
  assert.equal(result.detectedObject, "Glass Bottle");
  assert.equal(result.itemName, "Glass Bottle");
  assert.equal(result.explanation, "Original explanation");
  assert.equal(result.action, "Original action");
  assert.equal(result.warning, "Original warning");
  assert.equal(result.aiConfidence, "0.87");
  assert.equal(result.detectedItems.length, 0); // Do not invent a localized box for a single result.
});
for (const field of ["detectedItems", "items"]) test(`Gemini result.${field} normalizes before Google without another provider call`, async () => {
  const service = loadAnalysis({ external: { success: true, result: { [field]: synthetic.map(({ name, ...item }) => ({ itemName: name, ...item })) } }, objects: [object("Paper")] });
  const result = await run(service);
  assert.equal(result.detectedItems.length, 3);
  assert.equal(result.analysisSource, "cloud_run_gemini_vision");
  assert.equal(service.calls.external, 1);
  assert.equal(service.calls.vision, 0);
  assert.equal(service.calls.local, 0);
});

test("Case A: Gemini .95 stays primary while weaker Google objects enrich the response", async () => {
  const external = { success: true, source: "synthetic_gemini_source", result: { itemName: "Plastic Bottle",
    category: "Recyclable", confidence: .95, explanation: "Visible plastic body", action: "Empty and rinse", warning: "Check contamination" } };
  const service = loadAnalysis({ external, objects: [object("Bottle", .75), object("Banana", .80, synthetic[1].boundingBox)] });
  const result = await run(service);
  assert.equal(result.itemName, "Plastic Bottle");
  assert.equal(result.detectedObject, "Plastic Bottle");
  assert.equal(result.category, "Recyclable");
  assert.equal(result.aiConfidence, "0.95");
  assert.equal(result.analysisSource, "synthetic_gemini_source");
  for (const field of ["explanation", "action", "warning"]) assert.equal(result[field], external.result[field]);
  assert.deepEqual(plain(result.detectedItems.map((item) => item.itemName)), ["Bottle", "Banana"]);
  assert.equal(service.calls.vision, 1);
  assert.equal(service.calls.local, 0);
});
test("valid local Gemini single result has the same preservation policy", async () => {
  const local = { success: true, source: "gemini_vision_material_checked", result: { itemName: "Plastic Bottle",
    category: "Recyclable", confidence: .95, explanation: "Local explanation", action: "Local action", warning: "Local warning" } };
  const service = loadAnalysis({ local, objects: [object("Banana", .99)] });
  const result = await run(service);
  assert.equal(result.itemName, "Plastic Bottle");
  assert.equal(result.category, "Recyclable");
  assert.equal(result.aiConfidence, "0.95");
  assert.equal(result.analysisSource, local.source);
  for (const field of ["explanation", "action", "warning"]) assert.equal(result[field], local.result[field]);
  assert.equal(service.calls.local, 1);
  assert.equal(result.detectedItems[0].itemName, "Banana");
});
test("Case B: Gemini contaminated bottle stays Residual with original per-item and primary details", async () => {
  const item = { ...object("Plastic Bottle", .91), category: "Residual", explanation: "Bottle has food contamination",
    action: "Use residual collection", warning: "Do not put contaminated material in recycling" };
  const result = await run(loadAnalysis({ external: { success: true, result: { items: [item] } } }));
  assert.equal(result.category, "Residual");
  assert.equal(result.detectedItems[0].category, "Residual");
  for (const field of ["explanation", "action", "warning"]) {
    assert.equal(result[field], item[field]);
    assert.equal(result.detectedItems[0][field], item[field]);
  }
  assert.match(result.detectedItems[0].guidance.properDisposal, /residual/);
});
test("valid Gemini categories are preserved, including Special Waste", () => {
  for (const category of ["Biodegradable", "Recyclable", "Residual", "Special Waste"]) {
    assert.equal(normalize([{ ...object("Plastic Bottle"), category }], true)[0].category, category);
  }
});
test("missing or invalid Gemini categories use the mapper; explicit battery safety upgrades remain", () => {
  for (const category of [undefined, "invalid category"]) {
    assert.equal(normalize([{ ...object(), category }], true)[0].category, "Recyclable");
  }
  assert.equal(normalize([{ ...object("Battery"), category: "Recyclable" }], true)[0].category, "Special Waste");
});
test("Case C: overlapping Paint Can survives a higher-confidence generic Can", async () => {
  for (const objects of [[object("Can", .95), object("Paint Can", .90)], [object("Paint Can", .90), object("Can", .95)]]) {
    const result = await run(loadAnalysis({ objects }));
    assert.equal(result.detectedItems.length, 1);
    assert.equal(result.itemName, "Paint Can");
    assert.equal(result.category, "Special Waste");
    assert.equal(result.aiConfidence, "0.90");
  }
});
test("exact localized Paint Can keeps safety priority without classifying generic or represented objects", () => {
  const categoryMapper = require("../services/automaticWasteCategoryMapper");
  const evidence = name => ({ analysisSource: "google_vision_object_localization", category: "Unknown",
    observedIdentity: name, boundingBox: box });
  assert.equal(categoryMapper.automaticCategory(evidence("Paint Can")), "Special Waste");
  for (const name of ["Can", "Bottle", "Picture of a paint can", "Paint can illustration", "Printed Paint Can Picture",
    "Possibly a paint can", "Paint can classify as Special Waste", "Paint thinner can", "Chemical bottle", "Spray bottle"])
    assert.equal(categoryMapper.automaticCategory(evidence(name)), null, name);
  assert.equal(categoryMapper.automaticCategory({ ...evidence("Paint Can"), analysisSource: "untrusted" }), null);
  assert.equal(categoryMapper.automaticCategory({ ...evidence("Paint Can"), observedIdentity: "Item", itemName: "Paint Can" }), null);
  assert.equal(categoryMapper.automaticCategory({ ...evidence("Paint Can"), boundingBox: null }), null);
  for (const name of ["Charger", "Battery"])assert.equal(categoryMapper.automaticCategory(evidence(name)), "Special Waste");
  const far = { ...box, left: .5, right: .75 };
  for (const input of [[object("Can", .95), object("Paint Can", .90)], [object("Paint Can", .90), object("Can", .95)]]) {
    const items = plain(analysis.normalizeDetectedItems(input, "google_vision_object_localization"));
    assert.equal(items.length, 1);
    assert.equal(items[0].itemId, "item_1");
    assert.equal(items[0].itemName, "Paint Can");
    assert.equal(items[0].category, "Special Waste");
    assert.equal(items[0].confidence, .90);
    assert.equal(items[0].analysisSource, "google_vision_object_localization");
    assert.deepEqual(items[0].boundingBox, box);
  }
  const items = plain(analysis.normalizeDetectedItems([object("Can", .95), object("Paint Can", .90, far)], "google_vision_object_localization"));
  assert.deepEqual(items.map(item => item.category), ["Unknown", "Special Waste"]);
  assert.equal(new Set(items.map(item => item.itemId)).size, 2);
  assert.deepEqual(items.map(item => item.boundingBox), [box, far]);
});
test("same-category overlap ties prefer more specific names then original order", () => {
  for (const [generic, specific] of [["Bottle", "Plastic Bottle"], ["Can", "Aluminum Can"]]) {
    for (const objects of [[object(generic, .80), object(specific, .80)], [object(specific, .80), object(generic, .80)]]) {
      assert.equal(normalize(objects)[0].itemName, specific);
    }
    assert.equal(normalize([object(generic, .90), object(specific, .80)])[0].itemName, specific);
  }
  assert.equal(normalize([object("Bottle", .8), object("bottle", .8)])[0].itemName, "Bottle");
});
test("same-object generic bottle does not mask its specific contaminated identity", () => {
  const items = normalize([object("Bottle", .95), object("Dirty Plastic Bottle", .90)]);
  assert.equal(items.length, 1);
  assert.equal(items[0].itemName, "Dirty Plastic Bottle");
  assert.equal(items[0].category, "Residual");
});
test("Case D: without Gemini, highest-confidence Google object still supplies the primary", async () => {
  const result = await run(loadAnalysis({ objects: [synthetic[0], synthetic[2], synthetic[1]] }));
  assert.equal(result.itemName, "Plastic Bottle");
  assert.equal(result.category, "Recyclable");
  assert.equal(result.aiConfidence, "0.92");
  assert.equal(result.analysisSource, "google_vision_object_localization");
  assert.equal(result.detectedItems.length, 3);
});
test("enrichment failure preserves a valid Gemini primary and its details", async () => {
  const external = { success: true, result: { itemName: "Plastic Bottle", category: "Recyclable", confidence: .95,
    explanation: "Original explanation", action: "Original action", warning: "Original warning" } };
  const result = await run(loadAnalysis({ external, visionFailure: true }));
  assert.equal(result.itemName, "Plastic Bottle");
  assert.equal(result.aiConfidence, "0.95");
  assert.equal(result.explanation, external.result.explanation);
  assert.equal(result.detectedItems.length, 0);
});
test("malformed explicit vertex axes are rejected while omitted zeros remain supported", () => {
  for (const invalid of [undefined, null, NaN, Infinity, true, {}, "", "bad", "0.5"]) {
    assert.equal(visionHelpers.normalizeBoundingBox({ normalizedVertices: [{}, { x: invalid, y: 0 }, { x: .7, y: .8 }, { y: .8 }] }), null);
  }
  assert.equal(visionHelpers.normalizeBoundingBox({ normalizedVertices: [[], { x: .7 }, { y: .8 }] }), null);
  assert.equal(visionHelpers.normalizeBoundingBox({ normalizedVertices: [{}, { x: 2 }, { x: 2, y: 3 }, { y: 3 }] }), null);
  assert.deepEqual(visionHelpers.normalizeBoundingBox({ normalizedVertices: [{}, { x: 1 }, { x: 1, y: 1 }, { y: 1 }] }),
    { left: 0, top: 0, right: 1, bottom: 1 });
});
test("unusable Gemini array falls back to Google objects", async () => {
  const result = await run(loadAnalysis({ external: { success: true, result: { items: [object("Paper", .1)] } }, objects: synthetic }));
  assert.equal(result.detectedItems.length, 3);
  assert.equal(result.analysisSource, "google_vision_object_localization");
});
test("Gemini alternate items array is used if detectedItems is empty", async () => {
  const result = await run(loadAnalysis({ external: { success: true, result: { detectedItems: [], items: synthetic } } }));
  assert.equal(result.detectedItems.length, 3);
  assert.equal(result.analysisSource, "cloud_run_gemini_vision");
});
test("classifier special-waste category cannot be downgraded by a generic object name", () => {
  assert.equal(normalize([{ ...object("Container"), category: "Special Waste" }], true)[0].category, "Special Waste");
});
test("Google failure preserves legacy mapper result without sensitive exception logging", async () => {
  const service = loadAnalysis({ visionFailure: true });
  const result = await run(service, { detectedObject: "plastic bottle" });
  assert.equal(result.category, "Recyclable");
  assert.equal(result.analysisSource, "local_mapper_fallback");
  assert.equal(result.detectedItems.length, 0);
  assert.ok(!service.logs.join(" ").includes("sensitive-provider-request"));
});
test("external provider failure still allows Google enrichment", async () => {
  const service = loadAnalysis({ external: { image: "must-not-log" }, externalStatus: 500, objects: synthetic });
  const result = await run(service);
  assert.equal(result.detectedItems.length, 3);
  assert.ok(!service.logs.join(" ").includes("must-not-log"));
});
test("global labels do not contaminate per-object classification", async () => {
  const result = await run(loadAnalysis({ objects: synthetic }), { mlKitLabels: ["battery", "plastic", "food"] });
  assert.deepEqual(plain(result.detectedItems.map((item) => item.category)), ["Recyclable", "Unknown", "Special Waste"]);
});
test("unmapped localized identities remain Unknown; explicitly classified objects keep existing guidance", () => {
  assert.equal(normalize([object("Unknown shape")])[0].category, "Unknown");
  assert.equal(normalize([{ ...object("Unknown shape"), category: "Recyclable" }], true)[0].modelKey, "generic_recyclable");
});
test("no provider result preserves the original fallback fields", async () => {
  const result = await run(loadAnalysis());
  assert.equal(result.category, "Residual");
  assert.equal(result.analysisSource, "fallback_no_ai_result");
  for (const key of ["itemName", "category", "explanation", "action", "warning", "detectedObject", "aiLabel", "aiConfidence", "analysisSource", "visionLabels", "mlKitLabels", "roboflowPredictions"]) assert.ok(key in result);
});

function loadVision(annotations, failure = false) {
  const requests = [], options = [], logs = [], module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../services/googleVisionService.js"), "utf8"), {
    module, Buffer, process: { env: { GOOGLE_APPLICATION_CREDENTIALS: "synthetic-only" } },
    console: Object.fromEntries(["log", "warn", "error"].map((key) => [key, (...args) => logs.push(args.join(" "))])),
    require(id) {
      if(id==="./cloudRunDiagnostics") return require("../services/cloudRunDiagnostics");
      assert.equal(id, "@google-cloud/vision");
      return { ImageAnnotatorClient: class { async annotateImage(request, callOptions) {
        requests.push(request);
        options.push(callOptions);
        if (failure) throw new Error("secret-request-image");
        return [annotations];
      } } };
    }
  });
  return { ...module.exports, requests, options, logs };
}
test("Google object helper retains boxes and legacy label helper remains intact", async () => {
  const service = loadVision({ localizedObjectAnnotations: [{ name: "Plastic Bottle", score: .92,
    boundingPoly: { normalizedVertices: [{ x: .1, y: .1 }, { x: .35, y: .1 }, { x: .35, y: .85 }, { x: .1, y: .85 }] } }],
    labelAnnotations: [{ description: "Plastic", score: .8 }], webDetection: { bestGuessLabels: [{ label: "Bottle" }] } });
  assert.deepEqual(plain(await service.detectObjectsFromBase64("c3ludGhldGlj")), [object()]);
  const labels = plain(await service.detectLabelsFromBase64("c3ludGhldGlj"));
  assert.deepEqual(labels.map((item) => item.source), ["label_detection", "object_localization", "web_best_guess"]);
  assert.deepEqual(plain(service.requests[0].features), [{ type: "OBJECT_LOCALIZATION", maxResults: 20 }]);
  assert.deepEqual(plain(service.options[0]), { timeout: 5000, retry: null });
  assert.equal(service.options[1], undefined); // Legacy label helper call is untouched.
});

test("two independent plastic bottles retain separate per-scan identities and boxes", async () => {
  const objects = [object("Plastic Bottle", .91, { left: .05, top: .15, right: .3, bottom: .85 }),
    object("Plastic Bottle", .89, { left: .65, top: .15, right: .95, bottom: .85 })];
  const result = await run(loadAnalysis({ objects }));
  assert.equal(result.detectedItems.length, 2);
  assert.deepEqual(plain(result.detectedItems.map((item) => item.itemId)), ["item_1", "item_2"]);
  assert.deepEqual(plain(result.detectedItems.map((item) => item.boundingBox)), objects.map((item) => item.boundingBox));
  assert.deepEqual(plain(result.detectedItems.map((item) => item.category)), ["Recyclable", "Recyclable"]);
  assert.deepEqual(normalize(objects).map((item) => item.itemId), normalize(objects).map((item) => item.itemId));
});
test("portrait and landscape boxes retain normalized x/y without dimension swapping", () => {
  for (const boundingBox of [{ left: .1, top: .05, right: .3, bottom: .95 },
    { left: .05, top: .3, right: .95, bottom: .7 }]) {
    const vertices = [{ x: boundingBox.left, y: boundingBox.top }, { x: boundingBox.right, y: boundingBox.top },
      { x: boundingBox.right, y: boundingBox.bottom }, { x: boundingBox.left, y: boundingBox.bottom }];
    assert.deepEqual(visionHelpers.normalizeBoundingBox({ normalizedVertices: vertices }), boundingBox);
    assert.deepEqual(normalize([object("Plastic Bottle", .9, boundingBox)])[0].boundingBox, boundingBox);
  }
});
test("slow localization cannot indefinitely block a preserved Gemini primary", async () => {
  const external = { success: true, result: { itemName: "Plastic Bottle", category: "Recyclable", confidence: .95,
    explanation: "Primary evidence", action: "Primary action", warning: "Primary warning" } };
  let completeVision;
  const service = loadAnalysis({ external, fastLocalizationTimeout: true,
    visionImplementation: () => new Promise((resolve) => { completeVision = resolve; }) });
  const result = await run(service);
  assert.equal(result.itemName, "Plastic Bottle");
  assert.equal(result.explanation, external.result.explanation);
  assert.equal(result.detectedItems.length, 0);
  completeVision(synthetic);
  await Promise.resolve();
  assert.equal(result.detectedItems.length, 0); // Late localization cannot rewrite a response.
});
test("Google localization overlaps optional local classification instead of waiting for it", async () => {
  const local = { success: true, result: { itemName: "Plastic Bottle", category: "Recyclable", confidence: .95 } };
  let service;
  service = loadAnalysis({ local, objects: synthetic, localImplementation: async () => {
    await Promise.resolve();
    assert.equal(service.calls.vision, 1);
    return local;
  } });
  const result = await run(service);
  assert.equal(result.itemName, "Plastic Bottle");
  assert.equal(result.analysisSource, "gemini_vision");
  assert.equal(result.detectedItems.length, 3);
  assert.equal(service.calls.vision, 1);
});
test("invalid geometry in localization is omitted without losing the legacy primary", async () => {
  const external = { success: true, result: { itemName: "Plastic Bottle", category: "Recyclable", confidence: .95 } };
  const result = await run(loadAnalysis({ external, objects: [object("Bottle", .8, { left: -2, top: -1, right: 4, bottom: 3 })] }));
  assert.equal(result.detectedItems.length, 0);
  assert.equal(result.scanSummary.totalItems, 0);
  assert.equal(result.itemName, "Plastic Bottle");
  assert.equal(result.aiConfidence, "0.95");
});
test("Google object failure returns an empty array and never logs its request", async () => {
  const service = loadVision({}, true);
  assert.equal((await service.detectObjectsFromBase64("c3ludGhldGlj")).length, 0);
  assert.ok(!service.logs.join(" ").includes("secret-request-image"));
});
test("Google helper discards malformed annotations without losing valid ones", async () => {
  const service = loadVision({ localizedObjectAnnotations: [null, { name: "Paper", score: .8, boundingPoly: {} },
    { name: "Battery", score: .9, boundingPoly: { normalizedVertices: [{}, { x: 1 }, { x: 1, y: 1 }, { y: 1 }] } }] });
  const items = await service.detectObjectsFromBase64("c3ludGhldGlj");
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "Battery");
});

async function routeResponse({ failInsert = false, fatal = false } = {}) {
  const serviceResult = await run(loadAnalysis({ objects: synthetic }));
  const inserts = [], files = [], handlers = {}, module = { exports: {} };
  const router = Object.fromEntries(["get", "post", "patch", "delete"].map((method) => [method, (url, ...chain) => { handlers[`${method} ${url}`] = chain.at(-1); }]));
  const columns = ["image_url", "analysis_source", "ai_label", "ai_confidence"];
  const database = {
    queryReadOnly(sql, callback) { assert.match(sql, /SHOW COLUMNS FROM scan_history/); callback(null, columns.map((Field) => ({ Field }))); },
    query(sql, values, callback) {
      assert.match(sql, /INSERT INTO scan_history/); // No DDL, extra table or extra write allowed.
      inserts.push({ sql, values });
      callback(failInsert ? new Error("synthetic DB save failure") : null, { insertId: 123 });
    }
  };
  const source = fs.readFileSync(path.join(__dirname, "../routes/wasteRoutes.js"), "utf8");
  vm.runInNewContext(source, { module, AbortController, __dirname: path.join(__dirname, "../routes"), Buffer, console: { log() {}, warn() {}, error() {} },
    require(id) {
      if(id==="./cloudRunDiagnostics") return require("../services/cloudRunDiagnostics");
      if (id === "express") return { Router: () => router };
      if (id === "path") return path;
      if (id === "qrcode") return {};
      if (id === "fs") return { existsSync: () => true, writeFileSync: (...args) => files.push(args), mkdirSync() { throw new Error("No filesystem writes"); } };
      if (id === "../config/db") return database;
      if (id === "../services/wasteAnalysisService") return { analyzeWaste: async () => serviceResult, buildScanSummary: analysis.buildScanSummary };
      if (id.includes("Controller")) return new Proxy({}, { get: () => () => {} });
      if (id.includes("mobileSessionAuth")) return { requireMobileSession() {} };
      if (id === "../gemini-waste-classifier-cloudrun/cropRecognition") return require(id);
      if (id.includes("webSessionAuth")) return { requireWebCapability: () => () => {}, requireCsrf() {} };
      throw new Error(`Unexpected route dependency: ${id}`);
    }
  });
  let response;
  await handlers["post /analyze"]({ body: fatal ? null : { image: "c3ludGhldGlj" } }, { json(value) { response = value; return value; }, status() { return this; } });
  return { response: plain(response), inserts, files };
}
for (const failInsert of [false, true]) test(`API preserves legacy result and multi-item fields when DB save ${failInsert ? "fails" : "succeeds"}`, async () => {
  const { response, inserts, files } = await routeResponse({ failInsert });
  assert.equal(response.success, true);
  assert.equal(response.result.id, failInsert ? 0 : 123);
  assert.equal(response.result.itemName, "Plastic Bottle");
  assert.equal(response.result.aiConfidence, "0.92");
  assert.equal(response.detectedItems.length, 3);
  assert.equal(response.scanSummary.totalItems, 3);
  assert.equal(response.result.imageUrl, response.result.image_path);
  assert.equal(response.result.imageUrl, response.result.image_url);
  for (const key of ["id", "itemName", "category", "explanation", "action", "warning", "detectedObject", "imageUrl", "aiLabel", "aiConfidence", "analysisSource"]) assert.ok(key in response.result);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].values[0], "Plastic Bottle");
  assert.ok(!inserts[0].sql.includes("detectedItems"));
  assert.equal(files.length, 1);
});
test("fatal API fallback keeps mandatory result and zero summary", async () => {
  const { response, inserts } = await routeResponse({ fatal: true });
  assert.equal(response.success, true);
  assert.equal(response.result.analysisSource, "fatal_route_fallback");
  assert.equal(response.detectedItems.length, 0);
  assert.equal(response.scanSummary.totalItems, 0);
  assert.equal(inserts.length, 0);
});

// Synthetic geometry only: no device photos or provider requests.
test("two bottles with four alias labels produce two independent review items", () => {
  const second = { left: .60, top: .1, right: .85, bottom: .85 };
  const items = normalize([object("Bottle", .70), object("Bottle", .64, second),
    object("Bottled and jarred packaged goods", .57, { ...box, left: .11, right: .36 }),
    object("Bottled and jarred packaged goods", .54, { ...second, left: .61, right: .86 })]);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(item => item.itemName), ["Bottle", "Bottle"]);
  assert.deepEqual(items.map(item => item.category), ["Unknown", "Unknown"]);
  assert.notEqual(items[0].itemId, items[1].itemId);
});
test("alias specificity outranks confidence only when geometry identifies the same object", () => {
  const items = normalize([object("Bottled and jarred packaged goods", .95), object("Plastic Bottle", .6)]);
  assert.equal(items.length, 1); assert.equal(items[0].itemName, "Plastic Bottle");
});
test("same-object polygons suppress aliases but containment alone does not", () => {
  const polygon = { normalizedVertices: [{ x: .1, y: .1 }, { x: .35, y: .1 }, { x: .35, y: .85 }, { x: .1, y: .85 }] };
  assert.equal(normalize([{ name: "Bottle", confidence: .7, boundingPoly: polygon }, object("Bottled and jarred packaged goods", .6)]).length, 1);
  assert.equal(normalize([object("Bottle", .7), object("Bottled and jarred packaged goods", .6,
    { left: .12, top: .14, right: .33, bottom: .81 })]).length, 2);
});
test("partially overlapping and small nested legitimate instances survive", () => {
  assert.equal(normalize([object("Bottle", .8), object("Bottle", .7,
    { left: .25, top: .1, right: .5, bottom: .85 })]).length, 2);
  assert.equal(normalize([object("Bottle", .8), object("Bottle", .7,
    { left: .18, top: .3, right: .25, bottom: .5 })]).length, 2);
  assert.equal(normalize([object("Plastic Bottle", .8), object("Battery", .7,
    { left: .18, top: .3, right: .25, bottom: .5 })]).length, 2);
});
test("generic container material requires verification while unsupported identities are not fabricated", () => {
  assert.equal(normalize([object("Bottled and jarred packaged goods")])[0].category, "Unknown");
  assert.equal(normalize([object("Unrecognized shape")])[0].category, "Unknown");
});
test("Gemini primary is preserved even when it also returns localized items", async () => {
  const external = { success: true, result: { itemName: "Used Battery", category: "Special Waste", confidence: .91,
    explanation: "original explanation", action: "original action", warning: "original warning",
    detectedItems: [{ ...object("Plastic Bottle", .98), category: "Recyclable" }] } };
  const result = await run(loadAnalysis({ external }));
  assert.equal(result.itemName, "Used Battery"); assert.equal(result.category, "Special Waste");
  assert.equal(result.explanation, "original explanation"); assert.equal(result.action, "original action");
  assert.equal(result.warning, "original warning"); assert.equal(result.detectedItems.length, 1);
});

test("different container identities do not collapse solely because their boxes overlap", () => {
  for (const name of ["Can", "Jar"]) {
    assert.equal(normalize([object("Bottle", .8), object(name, .7, { ...box, left: .2, right: .45 })]).length, 2);
  }
});
test("unclassified bottle silhouette cannot replace the existing fallback primary category", async () => {
  const result = await run(loadAnalysis({ objects: [object("Bottle", .8)] }));
  assert.equal(result.category, "Residual");
  assert.equal(result.detectedItems[0].category, "Unknown");
});

// Synthetic localized identities only; no user photo, provider or database calls.
test("unmapped localized identities retain boxes and Unknown without unsafe guidance", () => {
  const result = normalize([object("Blue-handled object")]);
  assert.equal(result.length, 1);assert.equal(result[0].category,"Unknown");assert.equal(result[0].requiresConfirmation,true);
  assert.deepEqual(result[0].boundingBox,box);assert.deepEqual(result[0].guidance,{});assert.equal(result[0].modelKey,"");
  for (const confidence of [undefined,null,"0.8",true,NaN,Infinity,-1,1.1]) {
    assert.equal(normalize([{name:"Blue-handled object",confidence,boundingBox:box}]).length,0);
  }
  assert.equal(normalize([object("Blue-handled object",.8,null)]).length,0);
});
test("explicit unresolved classifier category never becomes a guessed recycling policy", () => {
  const result=normalize([{...object("Plastic Bottle"),category:"Unknown"}],true);
  assert.equal(result.length,1);assert.equal(result[0].category,"Unknown");assert.equal(result[0].modelKey,"");
});

test("one localized bottle with a conflicting contents alias remains one Unknown physical item", () => {
  for (const names of [["Bottle", "Soap"], ["Soap", "Bottle"]]) {
    const detections = names.map(name => object(name, name === "Soap" ? .99 : .7));
    const items = normalize(detections);
    assert.equal(items.length, 1);
    assert.equal(items[0].itemName, "Bottle");
    assert.equal(items[0].canonicalItem, "bottle");
    assert.equal(items[0].category, "Unknown");
    assert.equal(items[0].requiresConfirmation, true);
    assert.deepEqual(items[0].boundingBox, box);
    assert.equal(items[0].itemId, "item_1");
    assert.equal(analysis.buildScanSummary(items).totalItems, 1);
    assert.deepEqual(normalize(detections), items);
  }
});

test("two bottles and separate soap retain independent IDs even with matching names", () => {
  const detections = [object("Bottle"), object("Bottle", .8, { ...box, left: .5, right: .7 }),
    object("Soap", .9, { left: .75, top: .2, right: .95, bottom: .4 })];
  const items = normalize(detections);
  assert.equal(items.length, 3);
  assert.equal(new Set(items.map(item => item.itemId)).size, 3);
  assert.deepEqual(items.map(item => item.boundingBox), detections.map(item => item.boundingBox));
});

test("ordinary high overlap and centered nested boxes alone do not collapse same-name objects", () => {
  for (const other of [{ ...box, left: .13, right: .38 },
    { left: .12, top: .14, right: .33, bottom: .81 }]) {
    assert.equal(normalize([object("Bottle"), object("Bottle", .8, other)]).length, 2);
  }
});
