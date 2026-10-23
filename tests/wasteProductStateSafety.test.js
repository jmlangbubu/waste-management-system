"use strict";
// Synthetic offline evidence, not proof of image accuracy or installed APK identity.
const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),fs=require("node:fs");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
const {normalizeDetectedItems,samePhysicalObject,buildScanSummary}=require("../services/wasteAnalysisService");
const {merge,alignedIdentity}=require("../services/wholeImageRecognitionService");
const {createAssessmentService}=require("../services/perItemWasteAssessmentService");
const {withDisplayNames}=require("../services/wasteDisplayNameService");
const {productStateVeto}=require("../services/automaticWasteCategoryMapper");
const box={left:.1,top:.1,right:.3,bottom:.5},far={left:.6,top:.1,right:.8,bottom:.5};
const capture=()=>({captureId:crypto.randomUUID(),requestId:crypto.randomUUID(),image:Buffer.from("ffd8ffc0000b080190025801011100ffd9","hex").toString("base64"),width:600,height:400,orientation:"upright"});
const insufficient={category:"Unknown",kind:"unknown",material:"unknown",condition:"unknown",evidence:"insufficient"};
const residual={category:"Residual",kind:"wrapper",material:"mixed",condition:"non_recyclable",evidence:"visible"};
const recyclable={category:"Recyclable",kind:"single_material",material:"pet_plastic",condition:"clean_dry",evidence:"visible"};
function gemini(c,label,b=box){return whole.normalize(c,{objects:[{label,box_2d:[b.top,b.left,b.bottom,b.right].map(n=>Math.round(n*1000))}]}).objects[0];}
function vision(label,b=box){return normalizeDetectedItems([{name:label,confidence:.9,boundingBox:b}],"google_vision_object_localization")[0];}
function fixture(facts=insufficient,enabled=true){let calls=0;const requests=[];
 const assess=createAssessmentService({env:{WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:String(enabled),CLOUD_RUN_AUTH_MODE:"iam",CLOUD_RUN_AUDIENCE:"https://synthetic.invalid",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste",WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"offline-token-more-than-thirty-two-characters"},authHeaders:async()=>({}),transport:async(url,input)=>{
  calls++;requests.push(structuredClone(input));return {schemaVersion:1,captureId:input.captureId,requestId:input.requestId,assessments:input.items.map(item=>({itemId:item.itemId,...(typeof facts==="function"?facts(item):facts)}))};
 }});return {assess,requests,calls:()=>calls};
}
// Explicit source-equivalent v7 ownership checks, NOT execution of Android.
function acceptedV7(result,c){
 const owners=new Map(result.detectedItems.map(item=>[item.itemId,item]));
 assert.equal(owners.size,result.detectedItems.length);
 for(const item of owners.values()){
  assert.ok(item.itemName);assert.ok(item.boundingBox);assert.equal(item.requiresConfirmation,true);
  if(item.analysisSource==="gemini_whole_image"){
   assert.match(item.itemId,/^region_[0-9a-f]{32}$/);assert.equal(item.regionId,item.itemId);
   assert.equal(item.schemaVersion,1);assert.equal(item.geometrySpace,"oriented_image");
   for(const key of ["modelKey","modelHotspots","guidance"])assert.equal(Object.hasOwn(item,key),false);
   if(item.category!=="Unknown")assert.equal(require("../gemini-waste-classifier-cloudrun/cropRecognition").matchIdentity(item.observedIdentity)?.itemName,item.itemName);
  }else assert.equal(item.confidence,.9);
 }
 const sidecar=result.categoryAssessments;assert.equal(sidecar.schemaVersion,1);assert.equal(sidecar.captureId,c.captureId);
 const seen=new Set();for(const row of sidecar.items){const owner=owners.get(row.itemId);
  assert.ok(owner);assert.equal(seen.has(row.itemId),false);seen.add(row.itemId);assert.equal(row.requiresConfirmation,true);
  assert.ok(["Unknown","Biodegradable","Recyclable","Residual","Special Waste"].includes(row.category));
  assert.ok(["existing_category","insufficient_evidence","reviewed_identity_rule","ai_assisted"].includes(row.assessmentSource));
  if(row.assessmentSource==="ai_assisted"){assert.equal(owner.category,"Unknown");assert.equal(sidecar.aiStatus,"complete");}
  if(row.assessmentSource==="existing_category"){assert.notEqual(owner.analysisSource,"gemini_whole_image");assert.equal(row.category,owner.category);}
  if(owner.category!=="Unknown")assert.equal(row.category,owner.category);
 }
}
const unknownNames=["Snack Sachet","Instant Noodle Packet","Snack Packet","Generic Food Packaging","Unopened Snack Packet","Sealed Snack Sachet","Full Water Bottle","Filled Beverage Bottle","Whole Banana","Unpeeled Banana","Uncertain chemical container","Possibly empty snack wrapper","Printed picture of empty snack wrapper","Opened snack packet","Torn snack wrapper","Plastic Bottle"];
for(const source of ["Vision","Gemini"])for(const name of unknownNames)for(const mode of ["disabled","insufficient","supported"])
 test(`product-state final veto ${source}: ${name}, ${mode}`,async()=>{
  const c=capture(),raw=source==="Vision"?[vision(name)]:[gemini(c,name)],original=structuredClone(raw);
  const items=merge(source==="Vision"?raw:[],source==="Gemini"?raw:[],samePhysicalObject,c);
  const saved=structuredClone(items),s=fixture(mode==="supported"?(name.toLowerCase().includes("bottle")?recyclable:residual):insufficient,mode!=="disabled");
  const sidecar=await s.assess({capture:c,items,principal:5,primary:{analysisSource:"cloud_run_gemini_vision",category:"Residual",aiLabel:"Empty snack wrapper",aiConfidence:.99}});
  const result=withDisplayNames({detectedItems:items,categoryAssessments:sidecar,scanSummary:buildScanSummary(items)});
  // Explicitly approved common-object policy supersedes absence-of-state vetoes.
  // Explicit full/sealed/uncertain/hazardous cases below still require Unknown.
  const common={"Snack Sachet":"Residual","Plastic Bottle":"Recyclable","Whole Banana":"Biodegradable","Unpeeled Banana":"Biodegradable"};
  const expected=common[name]||"Unknown";
  const ownerExpected=source==="Gemini" && ["Whole Banana","Unpeeled Banana"].includes(name)?"Unknown":expected;
  assert.equal(items.length,1);assert.equal(items[0].category,ownerExpected);assert.equal(sidecar.items[0].category,expected);
  assert.equal(items[0].itemId,original[0].itemId);assert.deepEqual(items[0].boundingBox,original[0].boundingBox);
  assert.equal(items[0].analysisSource,original[0].analysisSource);assert.equal(items[0].confidence,original[0].confidence);
  assert.deepEqual(items,saved);assert.deepEqual(raw,original);assert.ok(s.calls()<=1);acceptedV7(result,c);
  if(["Snack Sachet","Instant Noodle Packet","Snack Packet","Plastic Bottle"].includes(name))assert.equal(s.calls(),0);
  if(source==="Gemini" && ["Snack Sachet","Plastic Bottle"].includes(name))assert.equal(result.detectedItems[0].itemName,name);
 });
for(const source of ["Vision","Gemini"])for(const [name,expected]of [["Empty snack wrapper","Residual"],["Discarded snack wrapper","Residual"],["Empty instant noodle wrapper","Residual"],["Discarded instant noodle wrapper","Residual"],["Empty plastic water bottle","Recyclable"],["Banana Peel","Biodegradable"],["Vegetable scraps","Biodegradable"],["Paint Can","Special Waste"],["Syringe","Special Waste"],["Charger","Special Waste"],["Battery","Special Waste"],["Electronic item","Special Waste"]])
 test(`product-state positive ${source}: ${name}`,async()=>{
  const c=capture(),raw=source==="Vision"?[vision(name)]:[gemini(c,name)];
  const items=merge(source==="Vision"?raw:[],source==="Gemini"?raw:[],samePhysicalObject,c),before=structuredClone(items);
  const s=fixture(),r=await s.assess({capture:c,items,principal:5});assert.equal(r.items[0].category,expected);
  assert.equal(r.items[0].itemId,items[0].itemId);assert.equal(r.items[0].requiresConfirmation,true);assert.deepEqual(items,before);
  // PR #152 already performs one optional safety review for fresh Gemini
  // mappings; the policy must not add a request or disable that review.
  if(/^(?:Empty|Discarded)/.test(name))assert.equal(s.calls(),source==="Gemini"?1:0);
 });
for(const name of ["Empty snack wrapper","Empty plastic water bottle"])for(const mode of ["disabled","insufficient","supported"])
 test(`unique aligned empty evidence belongs only to its Vision owner: ${name}, ${mode}`,async()=>{
  const c=capture(),initial=normalizeDetectedItems([{name:name.includes("bottle")?"Plastic bottle":"Snack wrapper",confidence:.9,boundingBox:box},{name:"Snack packet",confidence:.9,boundingBox:far}],"google_vision_object_localization");
  const items=merge(initial,[gemini(c,name)],samePhysicalObject,c),s=fixture(mode==="supported"?(name.includes("bottle")?recyclable:residual):insufficient,mode!=="disabled");
  const r=await s.assess({capture:c,items,principal:5});
  const expected=name.includes("bottle")?"Recyclable":"Residual";
  assert.equal(items[0].itemId,initial[0].itemId);assert.equal(items[0].category,expected);
  assert.equal(alignedIdentity(items[0],c.captureId),name);
  assert.equal(r.items[0].category,expected);
  assert.equal(r.items[0].requiresConfirmation,true);
  assert.equal(s.calls(),0);
  assert.deepEqual(items[0].boundingBox,initial[0].boundingBox);
  assert.equal(items[0].analysisSource,initial[0].analysisSource);
  assert.equal(items[0].confidence,initial[0].confidence);
  assert.equal(r.items[1].category,"Unknown");
 });
for(const reverse of [false,true])for(const enabled of [false,true])
 test(`aligned-only empty state cannot create eligibility after owner ordering: reversed=${reverse}, AI=${enabled}`,async()=>{
  const c=capture(),initial=[vision("Snack wrapper"),{...vision("Snack packet",far),itemId:"item_2"}];
  if(reverse)initial.reverse();
  const raw=structuredClone(initial),items=merge(initial,[gemini(c,"Empty snack wrapper")],samePhysicalObject,c);
  const owner=items.find(item=>item.itemId==="item_1"),s=fixture(residual,enabled);
  const before=structuredClone(items),result=await s.assess({capture:c,items,principal:5});
  assert.equal(owner.category,"Residual");assert.equal(alignedIdentity(owner,c.captureId),"Empty snack wrapper");
  assert.equal(result.items.find(item=>item.itemId===owner.itemId).category,"Residual");
  assert.equal(s.calls(),0);assert.deepEqual(items,before);assert.deepEqual(initial,raw);
  assert.deepEqual(owner.boundingBox,box);assert.equal(owner.confidence,.9);
 });
for(const scenario of ["nearby","nested","partial","stale","foreign ID","duplicate ID","ambiguous","printed","uncertain"])
 test(`untrusted empty evidence cannot grant category: ${scenario}`,async()=>{
  const c=capture(),initial=[vision("Snack packet")],b=scenario==="nearby"?far:scenario==="nested"?{left:.15,top:.2,right:.25,bottom:.4}:scenario==="partial"?{left:.2,top:.3,right:.4,bottom:.6}:box;
  const label=scenario==="printed"?"Printed picture of empty snack wrapper":scenario==="uncertain"?"Possibly empty snack wrapper":"Empty snack wrapper";
  const proposals=[gemini(scenario==="stale"?capture():c,label,b)];
  if(scenario==="foreign ID")proposals[0].itemId="region_"+"0".repeat(32);
  if(scenario==="duplicate ID")proposals.push({...proposals[0]});
  if(scenario==="ambiguous")initial.push({...initial[0],itemId:"item_2"});
  const items=merge(initial,proposals,samePhysicalObject,c),r=await fixture(residual).assess({capture:c,items,principal:5});
  assert.equal(r.items.find(row=>row.itemId===initial[0].itemId).category,"Unknown");
 });
test("full/empty conflict cannot be resolved as empty by supported provider facts",async()=>{
 const c=capture(),items=merge([vision("Full plastic water bottle")],[gemini(c,"Empty plastic water bottle")],samePhysicalObject,c);
 assert.equal(items.length,1);const r=await fixture(recyclable).assess({capture:c,items,principal:5});
 assert.equal(items[0].category,"Unknown");assert.equal(r.items[0].category,"Unknown");
});
test("category-only provider assertion and a rewritten display name cannot supply product state",async()=>{
 const c=capture(),items=merge([vision("Snack packet")],[],samePhysicalObject,c);items[0].itemName="Empty snack wrapper";
 const r=await fixture({...insufficient,category:"Residual"}).assess({capture:c,items,principal:5});assert.equal(r.items[0].category,"Unknown");
 assert.equal(productStateVeto(items[0],"Residual"),true);
});
test("Can/Spray Can conflicts and original primary result remain separate from safe item suggestions",async()=>{
 const c=capture(),raw=[gemini(c,"Can"),gemini(c,"Spray Can")],items=merge([],raw,samePhysicalObject,c);
 const primary={itemName:"Original primary",category:"Recyclable",action:"Original primary action"},saved=structuredClone(primary);
 const r=await fixture(insufficient).assess({capture:c,items,primary,principal:5});
 assert.equal(r.items[0].category,"Unknown");assert.deepEqual(primary,saved);
});
test("reference Android parser permits Unknown catalog identity independently of its catalog stream",()=>{
 const root="C:/Users/ADMIN/.codex/worktrees/android-classification-reconciliation/AIWasteManagementSystem-LATEST/app/src/main/java/com/example/aiwastemanagementsystem/";
 const owner=fs.readFileSync(root+"DetectedWasteItem.java","utf8"),sidecar=fs.readFileSync(root+"WasteCategoryAssessments.java","utf8");
 assert.match(owner,/if\(!"Unknown"\.equals\(category\)/);
 assert.match(sidecar,/boolean vision="google_vision_object_localization"/);
 assert.match(sidecar,/!\(gemini \|\| vision\)/);
 // Deliberately not a claim about the installed APK's signing/build provenance.
});
for(const source of ["Vision","Gemini"])test(`neutral object still receives validated electrical evidence: ${source}`,async()=>{
 const c=capture(),raw=source==="Vision"?[vision("Unclassified household container")]:[gemini(c,"unknown household object")];
 const items=merge(source==="Vision"?raw:[],source==="Gemini"?raw:[],samePhysicalObject,c);
 const s=fixture({category:"Special Waste",kind:"electrical",material:"mixed",condition:"unknown",evidence:"visible"});
 const r=await s.assess({capture:c,items,principal:5});assert.equal(r.items[0].category,"Special Waste");assert.equal(s.calls(),1);
});
test("existing Paint Can safety review still vetoes contradictory provider facts",async()=>{
 const c=capture(),items=merge([],[gemini(c,"Paint Can")],samePhysicalObject,c),s=fixture(residual);
 const r=await s.assess({capture:c,items,principal:5});assert.equal(s.calls(),1);assert.equal(r.items[0].category,"Unknown");
});
