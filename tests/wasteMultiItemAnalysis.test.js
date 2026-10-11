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

function loadAnalysis({ objects = [], external = null, local = null, visionFailure = false, externalStatus = 200 } = {}) {
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
    process: { env: { ...(external ? { GEMINI_CLASSIFIER_URL: "https://synthetic.invalid/classify" } : {}),
      ...(local ? { ALLOW_RENDER_GEMINI_DIRECT: "true" } : {}) } },
    require(id) {
      if (id === "http" || id === "https") return transport;
      if (id === "../utils/wasteMapper") return mapper;
      if (id === "./wasteLearningGuideService") return guide;
      if (id === "./googleVisionService") return { ...visionHelpers, async detectObjectsFromBase64() {
        calls.vision++;
        if (visionFailure) throw new Error("sensitive-provider-request-must-not-log");
        return objects;
      } };
      if (id === "./geminiWasteClassifierService") return { async classifyWasteWithGemini() { calls.local++; return local; } };
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
  assert.deepEqual(result.detectedItems.map((item) => item.category), ["Recyclable", "Biodegradable", "Special Waste"]);
  assert.deepEqual(result.detectedItems.map((item) => item.modelKey), ["plastic_bottle", "banana_peel", "battery"]);
  assert.equal(result.itemName, "Plastic Bottle");
  assert.equal(result.aiConfidence, "0.92");
  assert.deepEqual(result.scanSummary, { totalItems: 3, categories: { biodegradable: 1, recyclable: 1, residual: 0, specialWaste: 1 } });
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
test("rectangle coordinates clamp to the normalized range", () => {
  assert.deepEqual(normalize([object("Paper", .8, { left: -2, top: -.1, right: 4, bottom: 2 })])[0].boundingBox,
    { left: 0, top: 0, right: 1, bottom: 1 });
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
test("overlapping different object names remain separate", () => assert.equal(normalize([object(), object("Battery", .8)]).length, 2));
test("plastic bottle maps through existing recyclable rules", () => assert.equal(normalize([object()])[0].category, "Recyclable"));
test("banana peel and localized Banana are biodegradable", () => {
  for (const name of ["Banana", "banana peel"]) assert.equal(normalize([object(name)])[0].category, "Biodegradable");
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
test("same-category overlap ties prefer more specific names then original order", () => {
  for (const [generic, specific] of [["Bottle", "Plastic Bottle"], ["Can", "Aluminum Can"]]) {
    for (const objects of [[object(generic, .80), object(specific, .80)], [object(specific, .80), object(generic, .80)]]) {
      assert.equal(normalize(objects)[0].itemName, specific);
    }
    assert.equal(normalize([object(generic, .90), object(specific, .80)])[0].itemName, generic);
  }
  assert.equal(normalize([object("Bottle", .8), object("bottle", .8)])[0].itemName, "Bottle");
});
test("different non-special categories with subset names remain separate", () => {
  const items = normalize([object("Bottle", .95), object("Dirty Plastic Bottle", .90)]);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.category), ["Recyclable", "Residual"]);
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
  const valid = visionHelpers.normalizeBoundingBox({ normalizedVertices: [{}, { x: 2 }, { x: 2, y: 3 }, { y: 3 }] });
  assert.deepEqual(valid, { left: 0, top: 0, right: 1, bottom: 1 });
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
  assert.deepEqual(plain(result.detectedItems.map((item) => item.category)), ["Recyclable", "Biodegradable", "Special Waste"]);
});
test("unknown localized objects are ignored; classified unknown Gemini objects use a generic model", () => {
  assert.equal(normalize([object("Unknown shape")]).length, 0);
  assert.equal(normalize([{ ...object("Unknown shape"), category: "Recyclable" }], true)[0].modelKey, "generic_recyclable");
});
test("no provider result preserves the original fallback fields", async () => {
  const result = await run(loadAnalysis());
  assert.equal(result.category, "Residual");
  assert.equal(result.analysisSource, "fallback_no_ai_result");
  for (const key of ["itemName", "category", "explanation", "action", "warning", "detectedObject", "aiLabel", "aiConfidence", "analysisSource", "visionLabels", "mlKitLabels", "roboflowPredictions"]) assert.ok(key in result);
});

function loadVision(annotations, failure = false) {
  const requests = [], logs = [], module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../services/googleVisionService.js"), "utf8"), {
    module, Buffer, process: { env: { GOOGLE_APPLICATION_CREDENTIALS: "synthetic-only" } },
    console: Object.fromEntries(["log", "warn", "error"].map((key) => [key, (...args) => logs.push(args.join(" "))])),
    require(id) {
      assert.equal(id, "@google-cloud/vision");
      return { ImageAnnotatorClient: class { async annotateImage(request) {
        requests.push(request);
        if (failure) throw new Error("secret-request-image");
        return [annotations];
      } } };
    }
  });
  return { ...module.exports, requests, logs };
}
test("Google object helper retains boxes and legacy label helper remains intact", async () => {
  const service = loadVision({ localizedObjectAnnotations: [{ name: "Plastic Bottle", score: .92,
    boundingPoly: { normalizedVertices: [{ x: .1, y: .1 }, { x: .35, y: .1 }, { x: .35, y: .85 }, { x: .1, y: .85 }] } }],
    labelAnnotations: [{ description: "Plastic", score: .8 }], webDetection: { bestGuessLabels: [{ label: "Bottle" }] } });
  assert.deepEqual(plain(await service.detectObjectsFromBase64("c3ludGhldGlj")), [object()]);
  const labels = plain(await service.detectLabelsFromBase64("c3ludGhldGlj"));
  assert.deepEqual(labels.map((item) => item.source), ["label_detection", "object_localization", "web_best_guess"]);
  assert.deepEqual(plain(service.requests[0].features), [{ type: "OBJECT_LOCALIZATION", maxResults: 20 }]);
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
  vm.runInNewContext(source, { module, __dirname: path.join(__dirname, "../routes"), Buffer, console: { log() {}, warn() {}, error() {} },
    require(id) {
      if (id === "express") return { Router: () => router };
      if (id === "path") return path;
      if (id === "qrcode") return {};
      if (id === "fs") return { existsSync: () => true, writeFileSync: (...args) => files.push(args), mkdirSync() { throw new Error("No filesystem writes"); } };
      if (id === "../config/db") return database;
      if (id === "../services/wasteAnalysisService") return { analyzeWaste: async () => serviceResult, buildScanSummary: analysis.buildScanSummary };
      if (id.includes("Controller")) return new Proxy({}, { get: () => () => {} });
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
