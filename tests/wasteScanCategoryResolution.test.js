"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition"),contract=require("../gemini-waste-classifier-cloudrun/wasteItemAssessment");
const {merge}=require("../services/wholeImageRecognitionService"),{samePhysicalObject}=require("../services/wasteAnalysisService");
const {createAssessmentService}=require("../services/perItemWasteAssessmentService");
const capture=()=>({captureId:crypto.randomUUID(),requestId:crypto.randomUUID(),image:Buffer.from("ffd8ffc0000b080190025801011100ffd9","hex").toString("base64"),width:600,height:400,orientation:"upright"});
const objects=[{label:"Water bottle with cap",box_2d:[100,100,300,300]},
 {label:"White charger",box_2d:[100,650,300,850]},{label:"Snack wrapper",box_2d:[650,100,850,300]},
 {label:"Banana peel",box_2d:[650,650,850,850]}];
const generic={label:"Item",box_2d:[10,10,990,990]};
const insufficient={category:"Unknown",kind:"unknown",material:"unknown",condition:"unknown",evidence:"insufficient"};
function fixture(facts=()=>insufficient,extra={}) {
 let calls=0;
 const assess=createAssessmentService({env:{WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"true",CLOUD_RUN_AUTH_MODE:"iam",
  CLOUD_RUN_AUDIENCE:"https://synthetic.invalid",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste",
  WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"offline-only-token-more-than-thirty-two-characters",...extra},authHeaders:async()=>({}),transport:async(url,input)=>{
   calls++;return {schemaVersion:1,requestId:input.requestId,captureId:input.captureId,assessments:input.items.map(i=>({itemId:i.itemId,...facts(i)}))};
  }});
 return {assess,calls:()=>calls};
}
test("Gemini-only four small physical regions plus generic scene frame become four without owner mutation",async()=>{
 const c=capture(),raw=whole.normalize(c,{objects:[generic,...objects]}).objects,saved=structuredClone(raw);
 const items=merge([],raw,samePhysicalObject,c);assert.equal(items.length,4);assert.deepEqual(raw,saved);
 assert.deepEqual(items.map(i=>i.itemId).sort(),raw.slice(1).map(i=>i.itemId).sort());
 for(const item of items)assert.deepEqual(item,raw.find(i=>i.itemId===item.itemId));
 const f=fixture(),result=await f.assess({capture:c,items,principal:5});assert.equal(f.calls(),1);
 assert.deepEqual(raw.slice(1).map(owner=>result.items.find(i=>i.itemId===owner.itemId).category),["Recyclable","Special Waste","Residual","Biodegradable"]);
 assert.equal(result.items.length,items.length);assert.equal(result.captureId,c.captureId);
});
test("large real objects, single generic frames, nested clusters and partial overlaps are preserved",()=>{
 const c=capture();
 for(const input of [[generic],[{...generic,label:"Cardboard box"},...objects],
  [generic,...objects.slice(0,2)],[generic,...objects.map((o,i)=>({...o,box_2d:[200+i*25,200+i*25,300+i*25,300+i*25]}))],
  [generic,...objects.map((o,i)=>({...o,box_2d:[200+i*80,200+i*80,700+i*80,700+i*80]}))],
  [{...generic,box_2d:[100,100,900,900]},...objects]]) {
  const raw=whole.normalize(c,{objects:input}).objects;
  assert.equal(merge([],raw,samePhysicalObject,c).length,raw.length);
 }
});
test("bare/color-only bottle, generic container and Item require confirmation instead of identity-only recycling",async()=>{
 const c=capture();
 for(const ai of ["true","false"])for(const label of ["Bottle","Green Bottle","Container","Item"]){
  const items=whole.normalize(c,{objects:[{label,box_2d:[100,100,500,300]}]}).objects;
  const f=fixture(undefined,{WASTE_ITEM_ASSESSMENT_AI_ENABLED:ai});
  const r=await f.assess({capture:c,items,primary:{analysisSource:"cloud_run_gemini_vision",category:"Recyclable",aiLabel:"Plastic water bottle",aiConfidence:.95},principal:5});
  assert.equal(r.items[0].category,"Unknown",label);assert.equal(r.items[0].requiresConfirmation,true);
 }
});
test("specific identity supplies a provisional stream without fabricated provider material/condition",async()=>{
 const c=capture(),raw=whole.normalize(c,{objects:[{label:"Sheet of paper",box_2d:[100,100,500,300]}]}).objects;
 const f=fixture(),result=await f.assess({capture:c,items:raw,principal:5});
 assert.equal(result.items[0].category,"Recyclable");assert.equal(result.items[0].assessmentSource,"reviewed_identity_rule");
 assert.equal(result.items[0].requiresConfirmation,true);assert.match(result.items[0].guidance.whatItIs,/not verified/);
 assert.equal(raw[0].category,"Unknown");assert.equal(f.calls(),1);
 const recyclable={category:"Recyclable",kind:"single_material",material:"pet_plastic",condition:"clean_dry",evidence:"visible"};
 const verified=fixture(()=>recyclable),items=whole.normalize(c,{objects:[{label:"Bottle",box_2d:[100,100,500,300]}]}).objects;
 const r=await verified.assess({capture:c,items,principal:5});assert.equal(r.items[0].category,"Recyclable");
 assert.equal(r.items[0].assessmentSource,"ai_assisted");
 assert.equal(contract.categoryFromEvidence({...recyclable,material:"unknown",condition:"unknown"}),"Unknown");
});
test("generic removal cannot bypass nozzle, contamination, mixed-material or opposing-kind vetoes",async()=>{
 const c=capture(),recyclable={category:"Recyclable",kind:"single_material",material:"pet_plastic",condition:"clean_dry",evidence:"visible"};
 for(const label of ["Spray bottle with nozzle","Chemical bottle","Cosmetic container","Bottle with unknown contents","Printed picture of bottle"]){
  const f=fixture(()=>recyclable),items=whole.normalize(c,{objects:[{label,box_2d:[100,100,500,300]}]}).objects;
  assert.equal((await f.assess({capture:c,items,principal:5})).items[0].category,"Unknown");
 }
 for(const facts of [{...recyclable,material:"mixed"},{...recyclable,condition:"contaminated_nonhazardous"},
  {category:"Residual",kind:"wrapper",material:"mixed",condition:"non_recyclable",evidence:"visible"}]){
  const f=fixture(()=>facts),items=whole.normalize(c,{objects:[{label:"Bottle",box_2d:[100,100,500,300]}]}).objects;
  assert.equal((await f.assess({capture:c,items,principal:5})).items[0].category,"Unknown");
 }
});
test("local Cloud Run prompts demand specific supported identity and separate suggestions from facts, preserving v1 schemas",()=>{
 const c=capture(),discovery=whole.geminiBody(c),text=discovery.contents[0].parts[0].text;
 assert.match(text,/prefer.*physical.*identit/i);assert.match(text,/contents|material/);assert.match(text,/whole scene|full.frame/i);
 assert.deepEqual(discovery.generationConfig.responseSchema.properties.objects.items.required,["label"]);
 const request={...c,items:[{itemId:"region_"+"a".repeat(32),observedIdentity:"Snack wrapper",boundingBox:{left:.1,top:.1,right:.3,bottom:.5}}]};
 const body=contract.geminiBody(request),prompt=body.contents[0].parts[0].text;
 assert.match(prompt,/provisional.*suggestion/i);assert.match(prompt,/unknown attributes/);
 assert.equal(body.contents[0].parts.length,2);assert.equal(body.generationConfig.maxOutputTokens,contract.LIMITS.outputTokens);
 assert.deepEqual(body.generationConfig.responseSchema.properties.assessments.items.required,["itemId","category","kind","material","condition","evidence"]);
});

test("one bounded discovery and one existing assessment batch are cached per capture without category cross-transfer",async()=>{
 const {createDiscoveryService}=require("../services/wholeImageRecognitionService");
 const c=capture();let discoveryCalls=0;
 const discover=createDiscoveryService({env:{WHOLE_IMAGE_DISCOVERY_ENABLED:"true",CLOUD_RUN_AUTH_MODE:"iam",
  GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste",WHOLE_IMAGE_DISCOVERY_SHARED_TOKEN:"offline-only-discovery-token-longer-than-32"},
  authHeaders:async()=>({}),transport:async(url,input)=>{discoveryCalls++;return whole.normalize(input,{objects:[generic,...objects]});}});
 const discovered=await discover(c,{principal:5}),items=merge([],discovered.objects,samePhysicalObject,c),f=fixture();
 const primary={category:"Special Waste",aiLabel:"White charger",analysisSource:"cloud_run_gemini_vision",aiConfidence:.99},saved=structuredClone(primary);
 const result=await f.assess({capture:c,items,primary,principal:5});
 assert.equal(result.items.filter(i=>i.category==="Special Waste").length,1);assert.deepEqual(primary,saved);
 const retry={...c,requestId:crypto.randomUUID()};await discover(retry,{principal:5});await f.assess({capture:retry,items,primary,principal:5});
 assert.equal(discoveryCalls,1);assert.equal(f.calls(),1);assert.deepEqual(result.items.map(i=>i.itemId),items.map(i=>i.itemId));
});
