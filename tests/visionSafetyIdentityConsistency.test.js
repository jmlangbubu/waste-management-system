"use strict";
// Offline, synthetic identity/geometry fixtures. Not live device recognition.
const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {normalizeDetectedItems,samePhysicalObject}=require("../services/wasteAnalysisService");
const {merge,alignedIdentity,identityConflict}=require("../services/wholeImageRecognitionService");
const {shortObjectName}=require("../services/wasteDisplayNameService");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
const {createAssessmentService}=require("../services/perItemWasteAssessmentService");
const box={left:.1,top:.1,right:.3,bottom:.5};
const far={left:.6,top:.1,right:.8,bottom:.5};
const capture=()=>({captureId:crypto.randomUUID(),requestId:crypto.randomUUID(),image:Buffer.from("ffd8ffc0000b080190025801011100ffd9","hex").toString("base64"),width:600,height:400,orientation:"upright"});
const vision=(name,b=box)=>normalizeDetectedItems([{name,score:.93,boundingBox:b}],"google_vision_object_localization")[0];
const gemini=(c,name,b=box)=>whole.normalize(c,{objects:[{label:name,box_2d:[b.top,b.left,b.bottom,b.right].map(n=>Math.round(n*1000))}]}).objects[0];
const insufficient={category:"Unknown",kind:"unknown",material:"unknown",condition:"unknown",evidence:"insufficient"};
const visibleWrapper={category:"Residual",kind:"wrapper",material:"mixed",condition:"unknown",evidence:"visible"};
function offlineAssessment(facts=insufficient) {
 const requests=[];
 const assessment=createAssessmentService({env:{WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"true",CLOUD_RUN_AUTH_MODE:"iam",CLOUD_RUN_AUDIENCE:"https://synthetic.invalid",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste",WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"offline-token-more-than-thirty-two-characters"},authHeaders:async()=>({}),transport:async(_url,payload)=>{
  requests.push(structuredClone(payload));return {schemaVersion:1,captureId:payload.captureId,requestId:payload.requestId,assessments:payload.items.map(item=>({itemId:item.itemId,...facts}))};
 }});
 return {assessment,requests};
}
for(const [label,expected] of [
 ["Packaged goods","Unknown"],["Food packaging","Unknown"],["Packet","Unknown"],["Item","Unknown"],
 ["Unopened instant noodle packet","Unknown"],["Sealed snack sachet","Unknown"],["Full water bottle","Unknown"],
 ["Banana","Biodegradable"],["Banana peel","Biodegradable"],["White charger","Special Waste"],
 ["Empty snack wrapper","Residual"],["Plastic beverage bottle","Unknown"]
])test(`Vision original localization category: ${label}`,()=>{
 const item=vision(label);assert.ok(item,label);assert.equal(item.category,expected,label);
 if(label==="Banana"){assert.equal(item.itemName,"Banana");assert.equal(item.canonicalItem,"banana");}
});
test("normalized Vision Packet + uniquely aligned Gemini Snack Sachet retains owner and improves identity",async()=>{
 const c=capture(),v=vision("Packet"),g=gemini(c,"Snack sachet");const items=merge([v],[g],samePhysicalObject,c);
 assert.equal(items.length,1);assert.equal(items[0].itemId,v.itemId);assert.deepEqual(items[0].boundingBox,v.boundingBox);
 assert.equal(items[0].analysisSource,v.analysisSource);
 assert.equal(identityConflict(items[0],c.captureId),false);
 assert.equal(alignedIdentity(items[0],c.captureId),"Snack sachet");
 const {assessment,requests}=offlineAssessment();const result=await assessment({capture:c,items,principal:11});
 // Unique physical correspondence supplies an ordinary suggestion, not an
 // assertion of contents/cleanliness; no optional model category is needed.
 assert.equal(requests.length,0);assert.equal(items[0].category,"Residual");
 assert.equal(result.items[0].itemId,v.itemId);assert.equal(result.items[0].category,"Residual");
 assert.equal(result.items[0].assessmentSource,"existing_category");assert.equal(result.items[0].requiresConfirmation,true);
});
test("unopened item is not classified by verified wrapper claim",async()=>{
 const c=capture(),items=[vision("Unopened instant noodle packet")];const {assessment}=offlineAssessment(visibleWrapper);
 const result=await assessment({capture:c,items,principal:11});assert.equal(result.items[0].category,"Unknown");
});
test("different nearby sachets remain independent even if labels resemble each other",()=>{
 const c=capture(),items=merge([vision("Packet",box)],[gemini(c,"Snack sachet",far)],samePhysicalObject,c);
 assert.equal(items.length,2);
});
test("medicine packet and snack sachet remain incompatible and cannot silently become Residual",async()=>{
 const c=capture(),v=vision("Medicine packet"),g=gemini(c,"Snack sachet"),items=merge([v],[g],samePhysicalObject,c);
 assert.equal(items.length,1);assert.equal(identityConflict(items[0],c.captureId),true);
 const {assessment}=offlineAssessment(visibleWrapper),result=await assessment({capture:c,items,principal:11});
 assert.equal(result.items[0].category,"Unknown");
});
test("qualifiers persist as display-only descriptions",()=>{
 assert.equal(shortObjectName("Unopened instant noodle packet"),"Unopened Instant Noodle Packet");
 assert.equal(shortObjectName("Sealed snack sachet"),"Sealed Snack Wrapper");
 assert.equal(shortObjectName("Filled water bottle"),"Filled Bottle");
 assert.equal(shortObjectName("Coffee sachet"),"Coffee Sachet");
});
