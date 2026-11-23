"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const plain = value => JSON.parse(JSON.stringify(value));
const A = { left: .529, top: .305, right: .659, bottom: .470 };
const B = { left: .535, top: .305, right: .666, bottom: .470 };
const S = { ...A, top: .6, bottom: .765 };
const T = { ...B, top: .6, bottom: .765 };
const P = { left: .1, top: .55, right: .4, bottom: .9 };
const item = (name, confidence, boundingBox, category = "Unknown") => ({ name, confidence, boundingBox, category });
const scene = () => [item("Bottle", .9, A), item("Item", .89, T),
  item("Snack Sachet", .95, S, "Residual"), item("Bottle", .8, B), item("Paper", .85, P, "Recyclable")];

// Real service and mapping code; every possible provider entry is intercepted.
function fixture({ objects = [], externalItems = null } = {}) {
  const file = path.resolve(__dirname, "../services/wasteAnalysisService.js");
  const realRequire = createRequire(file), module = { exports: {} };
  const calls = { classifier: 0, vision: 0, local: 0 };
  const logs = [], bodies = [];
  const primary = { itemName: "Independent Primary", category: "Recyclable", confidence: .91,
    explanation: "Original explanation", action: "Original action", warning: "Original warning" };
  const transport = { request(options, callback) {
    assert.equal(options.hostname, "synthetic.invalid");
    const request = new EventEmitter();
    request.write = body => bodies.push(JSON.parse(body));
    request.destroy = error => request.emit("error", error);
    request.end = () => {
      calls.classifier++;
      const response = new EventEmitter(); response.statusCode = 200; callback(response);
      response.emit("data", JSON.stringify({ success: true, result: { ...primary,
        ...(externalItems === null ? {} : { detectedItems: externalItems }) } }));
      response.emit("end");
    };
    return request;
  } };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {
    module, exports: module.exports, URL, Buffer, setTimeout, clearTimeout,
    console: Object.fromEntries(["log", "warn", "error"].map(k => [k, (...args) => logs.push(args.join(" "))])),
    process: { env: { GEMINI_CLASSIFIER_URL: "https://synthetic.invalid/classify-waste",
      WMO_CLASSIFY_OBJECT_PROPOSALS_ENABLED: "false", WHOLE_IMAGE_DISCOVERY_ENABLED: "false" } },
    require(id) {
      if (id === "http" || id === "https") return transport;
      if (id === "./googleVisionService") return { ...realRequire(id), async detectObjectsFromBase64() { calls.vision++; return objects; } };
      if (id === "./geminiWasteClassifierService") return { async classifyWasteWithGemini() { calls.local++; throw Error("Unexpected provider call"); } };
      if (id === "./wholeImageRecognitionService" || id === "./cloudRunAuth") throw Error("Unexpected discovery/token request");
      return realRequire(id);
    }
  }, { filename: file });
  return { ...module.exports, calls, logs, bodies, primary };
}
const normalize = (rows, source = "cloud_run_gemini_vision") => plain(fixture().normalizeDetectedItems(rows, source, true));

test("consistency: exact-boundary duplicate bottles collapse without changing the public matcher thresholds", () => {
  const f = fixture(), x = { canonicalItem: "bottle", boundingBox: A }, y = { canonicalItem: "bottle", boundingBox: B };
  assert.notEqual(f.samePhysicalObject(x, y), f.samePhysicalObject(y, x), "reproduces the existing floating-point asymmetry");
  for (const rows of [[item("Bottle", .9, A), item("Bottle", .8, B)], [item("Bottle", .8, A), item("Bottle", .9, B)]]) {
    const result = normalize(rows); assert.equal(result.length, 1); assert.equal(result[0].confidence, .9);
    assert.equal(result[0].category, "Unknown"); assert.equal(result[0].requiresConfirmation, true);
  }
});

test("consistency: reported five-observation synthetic arrangement yields three proven localized objects", () => {
  const f = fixture(), result = normalize(scene());
  assert.deepEqual(result.map(x => x.itemName), ["Bottle", "Snack Sachet", "Paper"]);
  assert.deepEqual(result.map(x => x.itemId), ["item_1", "item_2", "item_3"]);
  assert.deepEqual(result.map(x => x.boundingBox), [A, S, P]);
  assert.deepEqual(result.map(x => x.category), ["Unknown", "Residual", "Recyclable"]);
  assert.deepEqual(plain(f.buildScanSummary(result)), { totalItems: 3, categories: { biodegradable: 0, recyclable: 1, residual: 1, specialWaste: 0 } });
});

test("consistency: a higher-confidence neutral Item cannot displace its uniquely matched specific original", () => {
  for (const name of ["Item", "Object", "Household item", "Household object"]) {
    const result = normalize([item(name, .99, S), item("Snack Sachet", .8, S, "Residual")]);
    assert.equal(result.length, 1); assert.equal(result[0].itemName, "Snack Sachet");
    assert.equal(result[0].confidence, .8); assert.equal(result[0].category, "Residual");
    assert.equal(result[0].analysisSource, "cloud_run_gemini_vision");
  }
});

test("consistency: two nearby overlapping real bottles remain separate", () => {
  const second = { ...A, left: .56, right: .69 };
  const result = normalize([item("Bottle", .9, A), item("Bottle", .8, second)]);
  assert.equal(result.length, 2); assert.deepEqual(result.map(x => x.boundingBox), [A, second]);
});

test("consistency: a separate cap and nested accessory are not swallowed by a bottle", () => {
  for (const name of ["Bottle cap", "Straw", "Pen"]) {
    const cap = { left: .55, top: .32, right: .58, bottom: .35 };
    const result = normalize([item("Bottle", .9, A), item(name, .8, cap)]);
    assert.equal(result.length, 2); assert.equal(result[1].itemName, name); assert.deepEqual(result[1].boundingBox, cap);
  }
});

test("consistency: adjacent sachet and paper keep their own categories", () => {
  const paper = { left: .64, top: .6, right: .85, bottom: .765 };
  const result = normalize([item("Snack Sachet", .9, S, "Residual"), item("Paper", .8, paper, "Recyclable")]);
  assert.deepEqual(result.map(x => x.category), ["Residual", "Recyclable"]); assert.equal(result.length, 2);
});

test("consistency: an unmatched neutral Item remains Unknown and no count is forced", () => {
  const result = normalize([...scene(), item("Item", .75, { left: .05, top: .05, right: .2, bottom: .2 })]);
  assert.equal(result.length, 4); assert.equal(result.at(-1).itemName, "Item"); assert.equal(result.at(-1).category, "Unknown");
});

test("consistency: a generic region competing for two retained objects is not arbitrarily suppressed", () => {
  const left = { left: .52, top: .1, right: .65, bottom: .3 };
  const right = { left: .532, top: .1, right: .662, bottom: .3 };
  const bridge = { left: .526, top: .1, right: .656, bottom: .3 };
  const result = normalize([item("Snack Sachet", .9, left, "Residual"), item("Paper", .85, right, "Recyclable"), item("Item", .99, bridge)]);
  assert.equal(result.length, 3); assert.equal(result[2].itemName, "Item"); assert.equal(result[2].category, "Unknown");
});

test("consistency: conflicting same-object categories are held Unknown without transferring guidance", () => {
  const result = normalize([item("Snack Sachet", .9, S, "Residual"), item("Item", .8, T, "Recyclable")]);
  assert.equal(result.length, 1); assert.equal(result[0].itemName, "Snack Sachet");
  assert.equal(result[0].category, "Unknown"); assert.equal(result[0].requiresConfirmation, true);
  assert.equal(result[0].modelKey, ""); assert.deepEqual(result[0].guidance, {});
});

test("consistency: same-region Special Waste evidence survives duplicate suppression", () => {
  for (const rows of [[item("Battery", .7, A, "Special Waste"), item("Item", .99, B)],
    [item("Bottle", .99, A, "Recyclable"), item("Chemical container", .7, B, "Special Waste")]]) {
    const result = normalize(rows); assert.equal(result.length, 1); assert.equal(result[0].category, "Special Waste");
    assert.equal(result[0].confidence, .7); assert.equal(result[0].requiresConfirmation, undefined);
  }
});

test("consistency: stable retained original indexes produce stable IDs and summaries", () => {
  const rows = scene(), before = structuredClone(rows), a = normalize(rows), b = normalize(rows);
  assert.deepEqual(a, b); assert.deepEqual(rows, before); assert.equal(new Set(a.map(x => x.itemId)).size, a.length);
  assert.deepEqual(a.map(x => x.confidence), [.9, .95, .85]);
});

for (const pathName of ["classifier-localized", "vision-localized"]) test("consistency: real feature-OFF " + pathName + " path keeps primary and provider budgets", async () => {
  const f = fixture(pathName === "classifier-localized" ? { externalItems: scene() } : { objects: scene() });
  const result = plain(await f.analyzeWaste({ image: "SYNTHETIC_IMAGE_NOT_LOGGED", detectedObject: "captured_waste_item" }));
  assert.equal(result.detectedItems.length, 3); assert.equal(result.scanSummary.totalItems, 3);
  assert.equal(result.itemName, f.primary.itemName); assert.equal(result.category, f.primary.category);
  assert.equal(result.explanation, f.primary.explanation); assert.equal(result.warning, f.primary.warning);
  assert.deepEqual(f.calls, { classifier: 1, vision: pathName === "vision-localized" ? 1 : 0, local: 0 });
  assert.equal(f.bodies.length, 1); assert.equal(Object.hasOwn(f.bodies[0], "objectProposals"), false);
  assert.ok(!f.logs.join(" ").includes("SYNTHETIC_IMAGE_NOT_LOGGED"));
});

const orders3 = rows => [[rows[0],rows[1],rows[2]],[rows[0],rows[2],rows[1]],[rows[1],rows[0],rows[2]],
  [rows[1],rows[2],rows[0]],[rows[2],rows[0],rows[1]],[rows[2],rows[1],rows[0]]];
test("consistency: an ambiguous high-confidence bridge cannot merge two different regions in any order", () => {
  const rows = [item("Bottle", .9, {left:.52,top:.1,right:.65,bottom:.3}),
    item("Bottle", .99, {left:.526,top:.1,right:.656,bottom:.3}),
    item("Bottle", .85, {left:.532,top:.1,right:.662,bottom:.3})];
  for(const order of orders3(rows)) assert.equal(normalize(order).length,3);
});
test("consistency: an ambiguous hazardous bridge keeps every region and withholds competing ordinary streams", () => {
  const rows = [item("Snack Sachet", .9, {left:.52,top:.1,right:.65,bottom:.3}, "Residual"),
    item("Item", .99, {left:.526,top:.1,right:.656,bottom:.3}, "Special Waste"),
    item("Paper", .85, {left:.532,top:.1,right:.662,bottom:.3}, "Recyclable")];
  for(const order of orders3(rows)) {
    const result=normalize(order);assert.equal(result.length,3);
    assert.equal(result.find(x=>x.itemName==="Item").category,"Special Waste");
    for(const x of result.filter(x=>x.itemName!=="Item")) {
      assert.equal(x.category,"Unknown");assert.equal(x.requiresConfirmation,true);
      assert.equal(x.modelKey,"");assert.deepEqual(x.guidance,{});
    }
  }
});
test("consistency: a complete group of three mutually corresponding duplicate regions collapses once", () => {
  const rows=[item("Bottle",.9,A),item("Bottle",.92,B),item("Bottle",.8,{left:.532,top:.305,right:.662,bottom:.470})];
  for(const order of orders3(rows)) {const result=normalize(order);assert.equal(result.length,1);assert.equal(result[0].confidence,.92);assert.deepEqual(result[0].boundingBox,B);}
});
test("consistency: a pair outside the existing strict centre boundary remains separate", () => {
  const beyond={...B,left:B.left+.0001,right:B.right+.0001};
  for(const rows of [[item("Bottle",.9,A),item("Bottle",.8,beyond)],[item("Bottle",.8,A),item("Bottle",.9,beyond)]])assert.equal(normalize(rows).length,2);
});
