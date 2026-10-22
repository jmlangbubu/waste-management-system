"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
const {createAssessmentService}=require("../services/perItemWasteAssessmentService");
const env={WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"true",CLOUD_RUN_AUTH_MODE:"iam",
 CLOUD_RUN_AUDIENCE:"https://synthetic.invalid",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste",
 WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"offline-only-assessment-token-longer-than-32"};
function scene(labels,vision=false){
 const capture={captureId:crypto.randomUUID(),requestId:crypto.randomUUID(),image:Buffer.from("ffd8ffc0000b080190025801011100ffd9","hex").toString("base64"),width:600,height:400,orientation:"upright"};
 const items=whole.normalize(capture,{objects:labels.map((label,i)=>({label,box_2d:[100,50+i*200,500,200+i*200]}))}).objects;
 return {capture,items:vision?items.map((item,i)=>({itemId:"item_"+i,category:"Unknown",analysisSource:"google_vision_object_localization",
  observedIdentity:item.observedIdentity,originalItemName:item.observedIdentity,itemName:"Item",canonicalItem:item.canonicalItem,boundingBox:item.boundingBox,confidence:.8})):items,principal:5};
}
function service(facts={category:"Unknown",kind:"unknown",material:"unknown",condition:"unknown",evidence:"insufficient"}){
 let calls=0;
 const assess=createAssessmentService({env,authHeaders:async()=>({}),transport:async(url,input)=>{calls++;return {schemaVersion:1,captureId:input.captureId,requestId:input.requestId,
  assessments:input.items.map(item=>({itemId:item.itemId,...facts}))};}});
 return {assess,calls:()=>calls};
}
for(const vision of [false,true])for(const [label,category] of [
 ["Plastic water bottle","Recyclable"],["Clean cardboard","Recyclable"],["Clean dry paper","Recyclable"],
 ["Banana peel","Biodegradable"],["Snack wrapper","Residual"],["Charger","Special Waste"],
 ["Rubber band","Residual"],["Broken ceramic cup","Residual"],
 ["Suspected chemical bottle","Unknown"],["Bottle","Unknown"],["Container","Unknown"],["Item","Unknown"]
])test(`final ${vision?"Vision":"Gemini"} sidecar: ${label} => ${category}`,async()=>{
 const input=scene([label],vision),before=structuredClone(input),{assess,calls}=service();
 const output=await assess(input);
 assert.equal(output.items[0].category,category);assert.equal(output.items[0].itemId,input.items[0].itemId);
 assert.equal(output.captureId,input.capture.captureId);assert.equal(output.items[0].requiresConfirmation,true);
 assert.deepEqual(input,before);assert.ok(calls()<=1);
 if(category==="Unknown")assert.match(output.items[0].guidance.properDisposal,/WMO/);
});
test("four final categories remain independent, preserve boxes and IDs, and cache the one batch",async()=>{
 const input=scene(["Plastic water bottle","Banana peel","Rubber band","Charger"],true),before=structuredClone(input),{assess,calls}=service();
 const output=await assess(input);assert.deepEqual(output.items.map(item=>item.category),["Recyclable","Biodegradable","Residual","Special Waste"]);
 assert.deepEqual(output.items.map(item=>item.itemId),input.items.map(item=>item.itemId));assert.deepEqual(input,before);
 await assess({...input,capture:{...input.capture,requestId:crypto.randomUUID()}});assert.equal(calls(),1);
});
test("ordinary Residual mapping cannot override dangerous, represented, ambiguous or conflicting evidence",async()=>{
 for(const label of ["Chemical rubber band","Contaminated broken ceramic cup","Possibly a rubber band","Printed picture of rubber band","Rubber band with unknown contents"]){
  const {assess}=service();assert.equal((await assess(scene([label]))).items[0].category,"Unknown");
 }
 const {assess}=service({category:"Special Waste",kind:"electrical",material:"mixed",condition:"unknown",evidence:"visible"});
 assert.equal((await assess(scene(["Rubber band"]))).items[0].category,"Unknown");
});
test("final display-name response envelope preserves four assessment owners and original evidence",async()=>{
 const {withDisplayNames}=require("../services/wasteDisplayNameService");
 const input=scene(["Plastic water bottle","Banana peel","Rubber band","Charger"]),before=structuredClone(input.items),{assess}=service();
 const result=withDisplayNames({detectedItems:input.items,categoryAssessments:await assess(input)});
 assert.ok(Array.isArray(result.detectedItems));assert.equal(result.detectedItems.length,4);
 assert.deepEqual(result.categoryAssessments.items.map(item=>item.category),["Recyclable","Biodegradable","Residual","Special Waste"]);
 result.detectedItems.forEach((item,i)=>{assert.equal(item.itemId,before[i].itemId);assert.deepEqual(item.boundingBox,before[i].boundingBox);assert.equal(item.observedIdentity,before[i].observedIdentity);});
 assert.deepEqual(input.items,before);
});
