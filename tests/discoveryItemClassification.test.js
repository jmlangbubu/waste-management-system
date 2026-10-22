"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
const shared=require("../gemini-waste-classifier-cloudrun/cropRecognition");
const {createDiscoveryService,merge}=require("../services/wholeImageRecognitionService");
const {enrichDiscoveryItem}=require("../services/discoveryItemClassificationService");
const {samePhysicalObject}=require("../services/wasteAnalysisService");
const request=()=>({requestId:crypto.randomUUID(),captureId:crypto.randomUUID(),image:Buffer.from([255,216,255,192,0,11,8,1,144,2,88,1,1,17,0,255,217]).toString("base64"),width:600,height:400,orientation:"upright"});
const object=(label,box_2d=[100,50,900,250])=>({label,box_2d});
const normalized=label=>whole.normalize(request(),{objects:[object(label)]}).objects[0];
const classify=label=>enrichDiscoveryItem(normalized(label));
const cases=[
 ["white power adapter","Special Waste"],["power adapter","Special Waste"],
 ["phone charger","Special Waste"],["USB wall charger","Special Waste"],
 ["used battery","Special Waste"],["plastic bottle","Recyclable"],
 ["banana peel","Biodegradable"],["cardboard","Recyclable"],
 ["snack sachet","Residual"],["gray round container","Unknown"],
 ["bottled and jarred packaged goods","Unknown"],["generic bottle","Unknown"],
 ["generic packaging","Unknown"],["unidentified packaging","Unknown"],
 ["visually ambiguous clear object","Unknown"],["generic container","Unknown"],
 ["unsupported identity","Unknown"],["adapter","Unknown"],["charger","Unknown"],
 ["plastic bottle packaging label","Unknown"],["phone charger picture","Unknown"],
 ["not a power adapter","Unknown"],["adapter cable packaging","Unknown"],
 ["banana peel snack packaging","Unknown"],["dirty plastic bottle","Unknown"],
 ["chemical bottle","Unknown"],["oil bottle","Unknown"],["USB wall charger box","Unknown"]
];
for(const [label,category] of cases)test(`reviewed exact identity: ${label} -> ${category}`,()=>{
 const before=normalized(label),saved=structuredClone(before),after=enrichDiscoveryItem(before);
 assert.equal(after.category,category);assert.deepEqual(before,saved);
 for(const field of Object.keys(saved).filter(key=>key!=="category"))assert.deepEqual(after[field],saved[field],field);
 assert.equal(after.requiresConfirmation,true);assert.equal(Object.hasOwn(after,"confidence"),false);
 assert.equal(after.localizationSource,"gemini_model_predicted");
 if(category==="Unknown") {
  assert.match(after.guidance.properDisposal,/confirm.*identity and material/);
  assert.doesNotMatch(JSON.stringify(after.guidance),/landfill|residual|recycl|compost|planter/i);
  assert.deepEqual(after.guidance.reuseIdeas,[]);assert.deepEqual(after.guidance.recoveryOptions,[]);
  assert.equal(after.modelKey,"");assert.deepEqual(after.modelHotspots,[]);
 }
});
test("electrical aliases tolerate only case and whitespace, with no inferred materials or condition",()=>{
 assert.equal(classify("  WHITE   POWER ADAPTER ").category,"Special Waste");
 const item=classify("USB wall charger");assert.match(item.guidance.properDisposal,/Never mix with ordinary household waste/);
 assert.match(item.guidance.recoveryOptions.join(" "),/confirm local acceptance/);
 assert.deepEqual(item.guidance.reuseIdeas,[]);assert.doesNotMatch(JSON.stringify(item.guidance),/available at|Calumpang|facility at/i);
});
test("approved recycling, biodegradable, reuse, model and hotspot guidance is reused unchanged",()=>{
 const {getWasteLearningGuide}=require("../services/wasteLearningGuideService");
 for(const [label,category] of cases.filter(([,category])=>category!=="Unknown")) {
  const item=classify(label),expected=getWasteLearningGuide(item.canonicalItem,category);
  const {modelKey,modelHotspots,...guidance}=expected;
  assert.deepEqual(item.guidance,guidance);assert.equal(item.modelKey,modelKey);assert.deepEqual(item.modelHotspots,modelHotspots);
 }
 assert.match(classify("plastic bottle").guidance.warnings.join(" "),/oil or chemical contamination/);
});
test("three-item fixture preserves IDs, order and all three independent boxes, enriching only the adapter",()=>{
 const input=request(),raw=whole.normalize(input,{objects:[object("bottled and jarred packaged goods"),object("white power adapter",[200,400,500,600]),object("gray round container",[100,700,800,900])]});
 const before=structuredClone(raw),validated=whole.validateResponse(input,raw),items=merge([],validated.objects,samePhysicalObject).map(enrichDiscoveryItem);
 assert.deepEqual(raw,before);assert.equal(items.length,3);assert.equal(new Set(items.map(item=>item.itemId)).size,3);
 const expected=new Map(before.objects.map(item=>[item.itemId,item]));
 for(const item of items) {
  const original=expected.get(item.itemId);for(const key of Object.keys(original).filter(key=>key!=="category"))assert.deepEqual(item[key],original[key],key);
 }
 assert.equal(items.find(item=>item.observedIdentity==="white power adapter").category,"Special Waste");
 assert.ok(items.filter(item=>item.observedIdentity!=="white power adapter").every(item=>item.category==="Unknown"));
 assert.deepEqual(whole.validateResponse(input,raw),before);
});
test("Cloud Run and transport contract remain identity-only: arbitrary provider categories/scores are rejected",async()=>{
 const input=request(),valid=whole.normalize(input,{objects:[object("white power adapter")]});
 assert.equal(valid.objects[0].category,"Unknown");assert.equal(whole.validateResponse(input,valid).objects[0].category,"Unknown");
 const env={WHOLE_IMAGE_DISCOVERY_ENABLED:"true",WHOLE_IMAGE_DISCOVERY_SHARED_TOKEN:"synthetic-shared-token-over-32-characters",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste"};
 for(const patch of [{category:"Special Waste"},{category:"Residual"},{confidence:.99},{guidance:{properDisposal:"Provider says landfill"}},{localizationSource:"verified"}]) {
  let calls=0;const service=createDiscoveryService({env,transport:async()=>{calls++;return {...valid,objects:[{...valid.objects[0],...patch}]};}});
  await assert.rejects(service(input,{principal:42}),{code:"INVALID_PROVIDER_RESPONSE"});assert.equal(calls,1);
 }
 assert.throws(()=>whole.normalize(input,{objects:[{...object("power adapter"),category:"Special Waste"}]}));
});
test("one capture is billed once; enrichment leaves cache/raw response valid and has no added transport",async()=>{
 const input=request(),env={WHOLE_IMAGE_DISCOVERY_ENABLED:"true",WHOLE_IMAGE_DISCOVERY_SHARED_TOKEN:"synthetic-shared-token-over-32-characters",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste"};
 let calls=0;const service=createDiscoveryService({env,transport:async(url,body)=>{calls++;return whole.normalize(body,{objects:[object("white power adapter")]});}});
 const raw=await service(input,{principal:42}),saved=structuredClone(raw),items=merge([],raw.objects,samePhysicalObject).map(enrichDiscoveryItem);
 assert.equal(items[0].category,"Special Waste");assert.deepEqual(raw,saved);
 const retry={...input,requestId:crypto.randomUUID()};const next=await service(retry,{principal:42});
 assert.equal(calls,1);assert.equal(next.objects[0].category,"Unknown");assert.deepEqual(whole.validateResponse(retry,next),next);
});
test("Vision geometry, IDs, scores, names, established categories and guidance always win a conflicting observation",()=>{
 const proposal=normalized("white power adapter");
 for(const category of ["Unknown","Recyclable","Residual","Special Waste"]) {
  const original={...proposal,itemId:"vision-id",regionId:"vision-region",analysisSource:"google_vision_object_localization",identitySource:"google_vision",localizationSource:"google_vision",itemName:"Confirmed item",canonicalItem:"confirmed item",category,confidence:.81,guidance:{properDisposal:"Existing authoritative guidance"}};
  const saved=structuredClone(original),[result]=merge([original],[proposal],samePhysicalObject);
  for(const key of Object.keys(saved).filter(key=>key!=="identitySource"))assert.deepEqual(result[key],saved[key],key);
  assert.equal(result.identityObservation,"white power adapter");assert.deepEqual(original,saved);
 }
});
test("deduplication, ranking and eight-item selection are identical to the pre-enrichment merge",()=>{
 const module={exports:{}},source=fs.readFileSync(path.join(__dirname,"../services/wholeImageRecognitionService.js"),"utf8");
 vm.runInNewContext(source,{module,process:{env:{}},require(id){
  if(id==="./discoveryItemClassificationService")return {enrichDiscoveryItem:item=>item};
  if(id==="./automaticWasteCategoryMapper")return require("../services/automaticWasteCategoryMapper");
  if(id.startsWith("../"))return require(id);if(id==="node:crypto")return crypto;throw Error("Unexpected dependency");
 }});
 const input=request(),items=whole.normalize(input,{objects:[object("Bottle"),object("Plastic Bottle"),object("Plastic Bottle",[100,400,900,600]),object("white power adapter",[200,700,500,900])]}).objects;
 const project=items=>Array.from(items,item=>({itemId:item.itemId,itemName:item.itemName,boundingBox:item.boundingBox}));
 assert.deepEqual(project(merge([],items,samePhysicalObject)),project(module.exports.merge([],items,samePhysicalObject)));
 const many=Array.from({length:10},(_,i)=>({...normalized(i%2?"power adapter":"Unknown item"),itemId:`synthetic-${i}`,boundingBox:{left:i/12,top:.1,right:(i+.5)/12,bottom:.9}}));
 assert.deepEqual(project(merge([],many,samePhysicalObject)),project(module.exports.merge([],many,samePhysicalObject)));assert.equal(merge([],many,samePhysicalObject).length,8);
});
test("identity-only observations and conflicting established categories are not promoted",()=>{
 const known=normalized("power adapter"),conflict={...known,category:"Recyclable"};assert.strictEqual(enrichDiscoveryItem(conflict),conflict);
 const identity=whole.normalize(request(),{objects:[{label:"power adapter"}]}).objects[0];assert.strictEqual(enrichDiscoveryItem(identity),identity);assert.deepEqual(merge([],[identity],samePhysicalObject),[]);
});
test("new helper has no logging, network, DB, env, uploads or broad legacy classification dependency",()=>{
 const source=fs.readFileSync(path.join(__dirname,"../services/discoveryItemClassificationService.js"),"utf8");
 assert.doesNotMatch(source,/console\.|process\.env|fetch\(|https?:|mysql|config\/db|writeFile|analyzeWasteByObject|mapWasteCategory|\.includes\(/);
 const input=normalized("white power adapter");Object.freeze(input.boundingBox);Object.freeze(input);assert.equal(enrichDiscoveryItem(input).category,"Special Waste");
 const privateSentinel="SYNTHETIC_SECRET_IMAGE_TOKEN_MUST_NOT_APPEAR";
 assert.doesNotMatch(JSON.stringify(enrichDiscoveryItem(normalized(privateSentinel))).replace(privateSentinel,""),/Bearer |API_KEY|private_key/);
});
