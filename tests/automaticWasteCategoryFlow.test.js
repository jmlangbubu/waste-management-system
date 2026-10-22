"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {createAssessmentService,deterministic}=require("../services/perItemWasteAssessmentService");
const box={left:.1,right:.5,top:.1,bottom:.5};
const vision=(label,id="item_1")=>({itemId:id,category:"Unknown",analysisSource:"google_vision_object_localization",originalItemName:label,canonicalItem:label.toLowerCase(),itemName:"Item",boundingBox:box});
const gemini=(label,id="region_"+'a'.repeat(32))=>({itemId:id,category:"Unknown",analysisSource:"gemini_whole_image",observedIdentity:label,canonicalItem:label.toLowerCase(),recognitionState:"localized_observation",boundingBox:box});
const env={WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"true",CLOUD_RUN_AUTH_MODE:"iam",CLOUD_RUN_AUDIENCE:"https://synthetic.invalid",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste",WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"synthetic-assessment-token-over-32-characters"};
const capture=()=>({captureId:crypto.randomUUID(),requestId:crypto.randomUUID(),image:Buffer.from("ffd8ffc0000b080190025801011100ffd9","hex").toString("base64"),width:600,height:400,orientation:"upright"});
const resultFor=(body,fn=()=>({category:"Unknown",kind:"unknown",material:"unknown",condition:"unknown",evidence:"insufficient"}))=>({schemaVersion:1,requestId:body.requestId,captureId:body.captureId,assessments:body.items.map(i=>({itemId:i.itemId,...fn(i)}))});
function service(make=()=>({category:"Unknown",kind:"unknown",material:"unknown",condition:"unknown",evidence:"insufficient"}),conf={}){
 let calls=0;
 const assess=createAssessmentService({env:{...env,...conf},authHeaders:async()=>({Authorization:"Bearer fake"}),transport:async(url,body)=>{calls++;return resultFor(body,make);}});
 return {assess,calls:()=>calls};
}
test("one capture five independent physical detections preserve exact IDs and useful generic suggestions",async()=>{
 const items=[vision('Water bottle'),gemini('white charger'),vision('foil chocolate wrapper','item_2'),gemini('Green Container','region_'+'b'.repeat(32)),vision('Banana peel','item_3')],ids=items.map(i=>i.itemId);
 const a=deterministic(items);assert.deepEqual(a.map(x=>x.category),['Unknown','Special Waste','Unknown','Unknown','Unknown']);
 assert.ok(a[0].guidance.reuseIdeas.length===0);
 const {assess,calls}=service();const response=await assess({capture:capture(),items,principal:5});
 assert.equal(calls(),1);assert.equal(response.aiStatus,'complete');assert.deepEqual(response.items.map(i=>i.category),['Recyclable','Special Waste','Residual','Unknown','Biodegradable']);
 assert.deepEqual(response.items.map(i=>i.itemId),ids);assert.equal(new Set(ids).size,5);
});
test("single generic Bottle remains Unknown rather than inventing a recycling suggestion",async()=>{
 const items=[vision('Bottle')],{assess}=service();const result=await assess({capture:capture(),items,principal:5});
 assert.equal(result.items[0].category,'Unknown');assert.equal(result.items[0].assessmentSource,'ai_assisted');
 assert.equal(result.items[0].requiresConfirmation,true);
});
test("visible hazardous evidence blocks the broad bottle mapping",async()=>{
 const {assess}=service(()=>({category:"Unknown",kind:"single_material",material:"mixed",condition:"contaminated_nonhazardous",evidence:"visible"}));
 const result=await assess({capture:capture(),items:[vision('Bottle')],principal:5});assert.equal(result.items[0].category,'Unknown');
});
test("explicit bleach/pesticide bottles remain Unknown even when provider calls them recyclable",async()=>{
 const {assess}=service(()=>({category:"Recyclable",kind:"single_material",material:"pet_plastic",condition:"clean_dry",evidence:"visible"}));
 for(const label of ['chemical bottle','pesticide bottle','bleach bottle']){
  const result=await assess({capture:capture(),items:[vision(label)],principal:5});assert.equal(result.items[0].category,'Unknown');
 }
});
test("AI validates a clean PET bottle and maps back the exact Android item ID",async()=>{
 const {assess}=service(()=>({category:"Recyclable",kind:"single_material",material:"pet_plastic",condition:"clean_dry",evidence:"visible"}));
 const result=await assess({capture:capture(),items:[vision('Bottle','item_7')],principal:5});
 assert.equal(result.items[0].itemId,'item_7');assert.equal(result.items[0].assessmentSource,'ai_assisted');assert.equal(result.items[0].category,'Recyclable');
});
test("pre-existing categories must not be overwritten by mapping or provider",async()=>{
 const obj=vision('Bottle');obj.category='Special Waste';const {assess,calls}=service();
 const result=await assess({capture:capture(),items:[obj],principal:5});assert.equal(result.items[0].category,'Special Waste');assert.equal(calls(),0);
});
test("AI disabled still uses generic automatic mappings without extra calls",async()=>{
 const {assess,calls}=service(undefined,{WASTE_ITEM_ASSESSMENT_AI_ENABLED:'false'});
 const result=await assess({capture:capture(),items:[vision('Bottle'),vision('unidentified object','item_2'),gemini('Bottle')],principal:5});
 assert.equal(result.aiStatus,'not_requested');assert.equal(calls(),0);
 // Android v1 cannot display Vision identity mappings without a completed AI batch.
 assert.deepEqual(result.items.map(x=>x.category),['Unknown','Unknown','Unknown']);
});
test("full assessment disabled remains fully off",async()=>{
 const {assess,calls}=service(undefined,{WASTE_ITEM_ASSESSMENT_ENABLED:'false'});
 const result=await assess({capture:capture(),items:[vision('Bottle')],principal:5});assert.equal(result,null);assert.equal(calls(),0);
});
test("pre-AI sources remain within existing Android category sidecar parser contract",async()=>{
 const v=vision('Water bottle'),g=gemini('Water bottle'),initial=deterministic([v,g]);
 assert.equal(initial[0].assessmentSource,'existing_category');assert.equal(initial[0].category,'Unknown');
 assert.equal(initial[1].assessmentSource,'reviewed_identity_rule');assert.equal(initial[1].category,'Recyclable');
 const {assess}=service();const live=await assess({capture:capture(),items:[v,g],principal:5});
 assert.equal(live.aiStatus,'complete');assert.equal(live.items[0].assessmentSource,'ai_assisted');
 assert.equal(live.items[1].assessmentSource,'reviewed_identity_rule');
 assert.deepEqual(live.items.map(x=>x.category),['Recyclable','Recyclable']);
});
test("AI failure keeps Vision Unknown under Android v1 while retaining Gemini mapping",async()=>{
 const assess=createAssessmentService({env,authHeaders:async()=>({}),transport:async()=>{throw Error('offline')}});
 const result=await assess({capture:capture(),items:[vision('Water bottle'),gemini('Water bottle')],principal:5});
 assert.equal(result.aiStatus,'unavailable');
 assert.deepEqual(result.items.map(x=>x.category),['Unknown','Recyclable']);
 assert.deepEqual(result.items.map(x=>x.assessmentSource),['existing_category','reviewed_identity_rule']);
});
