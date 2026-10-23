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
 assert.equal(calls(),1);assert.equal(response.aiStatus,'complete');assert.deepEqual(response.items.map(i=>i.category),['Unknown','Special Waste','Unknown','Unknown','Biodegradable']);
 assert.deepEqual(response.items.map(i=>i.itemId),ids);assert.equal(new Set(ids).size,5);
});
test("ordinary localized Bottle receives a provisional recycling suggestion",async()=>{
 const items=[vision('Bottle')],{assess}=service();const result=await assess({capture:capture(),items,principal:5});
 assert.equal(result.items[0].category,'Recyclable');assert.equal(result.items[0].assessmentSource,'ai_assisted');
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
test("ordinary Bottle with supported PET facts retains provisional recycling and exact Android ID",async()=>{
 const {assess}=service(()=>({category:"Recyclable",kind:"single_material",material:"pet_plastic",condition:"clean_dry",evidence:"visible"}));
 const result=await assess({capture:capture(),items:[vision('Bottle','item_7')],principal:5});
 assert.equal(result.items[0].itemId,'item_7');assert.equal(result.items[0].assessmentSource,'ai_assisted');assert.equal(result.items[0].category,'Recyclable');
 assert.doesNotMatch(JSON.stringify(result.items[0].guidance),/residual waste bin/);
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
 assert.deepEqual(result.items.map(x=>x.category),['Unknown','Unknown','Recyclable']);
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
 assert.equal(live.aiStatus,'not_requested');assert.equal(live.items[0].assessmentSource,'existing_category');
 assert.equal(live.items[1].assessmentSource,'reviewed_identity_rule');
 assert.deepEqual(live.items.map(x=>x.category),['Unknown','Recyclable']);
});
test("ineligible bottles avoid AI while an actual provider failure preserves independent fallback",async()=>{
 let calls=0;const assess=createAssessmentService({env,authHeaders:async()=>({}),transport:async()=>{calls++;throw Error('offline')}});
 const result=await assess({capture:capture(),items:[vision('Water bottle'),gemini('Water bottle')],principal:5});
 // Ordinary water-bottle mapping requires no new AI call; Vision ownership stays unchanged.
 assert.equal(result.aiStatus,'not_requested');
 assert.deepEqual(result.items.map(x=>x.category),['Unknown','Recyclable']);
 assert.deepEqual(result.items.map(x=>x.assessmentSource),['existing_category','reviewed_identity_rule']);
 assert.equal(calls,0);
 const input={capture:capture(),items:[vision('Item'),gemini('white charger')],principal:5};
 const failed=await assess(input);
 assert.equal(failed.aiStatus,'unavailable');assert.deepEqual(failed.items.map(x=>x.category),['Unknown','Special Waste']);
 assert.deepEqual(failed.items.map(x=>x.assessmentSource),['existing_category','reviewed_identity_rule']);
 await assess(input);assert.equal(calls,1);
});
