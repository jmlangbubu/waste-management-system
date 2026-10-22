"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
const contract=require("../gemini-waste-classifier-cloudrun/wasteItemAssessment");
const {createAssessmentService}=require("../services/perItemWasteAssessmentService");
const {withDisplayNames}=require("../services/wasteDisplayNameService");
const env={WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"true",CLOUD_RUN_AUTH_MODE:"iam",
 CLOUD_RUN_AUDIENCE:"https://synthetic.invalid",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste",
 WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"offline-token-more-than-thirty-two-characters"};
const evidence=(category,kind,material="unknown",condition="unknown",level="visible")=>({category,kind,material,condition,evidence:level});
const insufficient=evidence("Unknown","unknown","unknown","unknown","insufficient");
function scene(labels,vision=false){
 const capture={captureId:crypto.randomUUID(),requestId:crypto.randomUUID(),image:Buffer.from("ffd8ffc0000b080190025801011100ffd9","hex").toString("base64"),width:600,height:400,orientation:"upright"};
 const raw=whole.normalize(capture,{objects:labels.map((label,i)=>({label,box_2d:[100,10+i*200,600,150+i*200]}))}).objects;
 const items=vision?raw.map((item,i)=>({itemId:"item_"+i,analysisSource:"google_vision_object_localization",category:"Unknown",confidence:.8,
  observedIdentity:item.observedIdentity,originalItemName:item.observedIdentity,canonicalItem:item.canonicalItem,itemName:"Item",boundingBox:item.boundingBox})):raw;
 return {capture,items,principal:5,primary:{itemName:"Original scene classification",category:"Recyclable",analysisSource:"cloud_run_gemini_vision",aiConfidence:.9}};
}
function service(facts,config={},fail=false){
 let calls=0;const seen=[];
 const assess=createAssessmentService({env:{...env,...config},authHeaders:async()=>({}),transport:async(url,input)=>{
  calls++;seen.push(structuredClone(input));if(fail)throw Error("offline-only");
  return {schemaVersion:1,captureId:input.captureId,requestId:input.requestId,assessments:input.items.map(item=>({itemId:item.itemId,...(typeof facts==="function"?facts(item):facts)}))};
 }});
 return {assess,seen,calls:()=>calls,async response(input){const sidecar=await assess(input);return withDisplayNames({...input.primary,detectedItems:input.items,...(sidecar?{categoryAssessments:sidecar}:{})});}};
}
const cases=[
 ["A plastic beverage bottle","Plastic beverage bottle",evidence("Recyclable","single_material"),"Recyclable"],
 ["B paper envelope","Paper envelope",evidence("Recyclable","single_material","paper"),"Recyclable"],
 ["B cardboard sleeve","Cardboard sleeve",evidence("Recyclable","single_material"),"Recyclable"],
 ["C banana peel","Banana peel",evidence("Biodegradable","plant_food_scraps","plant_matter"),"Biodegradable"],
 ["C plant stems","Fallen plant stems",evidence("Biodegradable","plant_food_scraps","plant_matter"),"Biodegradable"],
 ["D conventional wrapper","Snack wrapper",evidence("Residual","wrapper","mixed"),"Residual"],
 ["D crumpled food packaging","Crumpled snack packaging",evidence("Residual","wrapper"),"Residual"],
 ["E charger","Phone charger",evidence("Special Waste","electrical","mixed"),"Special Waste"],
 ["E electric toothbrush","Electric toothbrush",evidence("Special Waste","electrical"),"Special Waste"],
 ["F ordinary nonrecoverable waste","Rubber band",insufficient,"Residual"],
 ["G generic item","Item",insufficient,"Unknown"],
 ["H nozzle","Bottle with blue applicator nozzle",evidence("Recyclable","single_material","pet_plastic","clean_dry"),"Unknown"],
 ["H spray","Glass spray bottle",evidence("Recyclable","single_material","glass"),"Unknown"],
 ["I cosmetic","Sunscreen cosmetic container",evidence("Recyclable","single_material"),"Unknown"],
 ["I SPF unknown contents","SPF 50 product container",insufficient,"Unknown"],
 ["I sunscreen paper tube","Sunscreen paper tube",evidence("Recyclable","single_material","paper"),"Unknown"],
 ["I cosmetic jar","Glass cosmetic jar",evidence("Recyclable","single_material","glass","clean_dry"),"Unknown"],
 ["K material contradiction","Paper envelope",evidence("Recyclable","single_material","aluminum","clean_dry"),"Unknown"],
 ["K kind contradiction","Paper envelope",evidence("Special Waste","electrical","mixed"),"Unknown"],
 ["K observed hazard","Chemical paper container",evidence("Recyclable","single_material","paper","clean_dry"),"Unknown"],
 ["K electrical glass object","Glass light bulb",evidence("Recyclable","single_material","glass","clean_dry"),"Unknown"],
 ["K printed material is not object material","Bottle with paper label",evidence("Recyclable","single_material","paper"),"Unknown"],
 ["M unknown attributes retained","Paper envelope",evidence("Recyclable","single_material"),"Recyclable"],
 ["M category alone","Item",evidence("Recyclable","unknown"),"Unknown"],
 ["M no independent material","Container",evidence("Recyclable","single_material","paper"),"Unknown"],
 ["M insufficient evidence","Paper envelope",evidence("Recyclable","single_material","paper","unknown","insufficient"),"Unknown"],
 ["M uncertain original identity","Possibly a paper envelope",evidence("Recyclable","single_material","paper"),"Unknown"],
 ["M contaminated condition","Paper envelope",evidence("Recyclable","single_material","paper","contaminated_nonhazardous"),"Unknown"]
];
for(const vision of [false,true])for(const [name,label,facts,expected] of cases)test(`${vision?"Vision":"Gemini"} final envelope ${name} -> ${expected}`,async()=>{
 const input=scene([label],vision),saved=structuredClone(input),provider=structuredClone(facts),s=service(facts),response=await s.response(input);
 assert.equal(response.categoryAssessments.items[0].category,expected);
 assert.equal(response.categoryAssessments.items[0].itemId,input.items[0].itemId);
 assert.equal(response.categoryAssessments.captureId,input.capture.captureId);
 assert.equal(response.categoryAssessments.schemaVersion,1);assert.equal(response.categoryAssessments.items[0].requiresConfirmation,true);
 if(response.categoryAssessments.items[0].assessmentSource==="ai_assisted"){
  assert.equal(response.categoryAssessments.aiStatus,"complete");assert.equal(input.items[0].category,"Unknown");
 }
 assert.deepEqual(input,saved);assert.deepEqual(facts,provider);assert.ok(s.calls()<=1);
 assert.deepEqual(response.detectedItems[0].boundingBox,input.items[0].boundingBox);
 assert.equal(response.itemName,input.primary.itemName);assert.equal(response.category,input.primary.category);
 if(expected!=="Unknown" && contract.categoryFromEvidence(facts)==="Unknown" && facts.condition==="unknown" && ["Paper envelope","Cardboard sleeve","Fallen plant stems","Crumpled snack packaging"].includes(label)){
  assert.equal(response.categoryAssessments.items[0].assessmentSource,"ai_assisted");
  assert.match(response.categoryAssessments.items[0].guidance.whatItIs,/not verified/);
  assert.deepEqual(response.categoryAssessments.items[0].guidance.reuseIdeas,[]);
 }
});
test("J four independent original regions, reversed provider results, one cached batch and unchanged v7 shape",async()=>{
 const input=scene(["Paper envelope","Fallen plant stems","Crumpled snack packaging","Electric toothbrush"],true),saved=structuredClone(input);
 const facts=[evidence("Recyclable","single_material","paper"),evidence("Biodegradable","plant_food_scraps","plant_matter"),evidence("Residual","wrapper"),evidence("Special Waste","electrical")];
 let calls=0;
 const assess=createAssessmentService({env,authHeaders:async()=>({}),transport:async(u,b)=>{calls++;return {schemaVersion:1,captureId:b.captureId,requestId:b.requestId,
  assessments:b.items.map((i,n)=>({itemId:i.itemId,...facts[n]})).reverse()};}});
 const sidecar=await assess(input),response=withDisplayNames({...input.primary,detectedItems:input.items,categoryAssessments:sidecar});
 assert.deepEqual(sidecar.items.map(i=>i.category),["Recyclable","Biodegradable","Residual","Special Waste"]);
 assert.deepEqual(sidecar.items.map(i=>i.itemId),input.items.map(i=>i.itemId));assert.deepEqual(input,saved);
 assert.deepEqual(Object.keys(sidecar).sort(),["schemaVersion","captureId","aiStatus","items"].sort());
 for(const row of sidecar.items){assert.equal(row.assessmentSource,"ai_assisted");assert.equal(row.requiresConfirmation,true);assert.deepEqual(Object.keys(row).sort(),["itemId","category","assessmentSource","requiresConfirmation","confirmationRequirements","guidance"].sort());}
 await assess({...input,capture:{...input.capture,requestId:crypto.randomUUID()}});assert.equal(calls,1);assert.equal(response.detectedItems.length,4);
});
test("L primary scene cannot supply missing per-item categories",async()=>{
 const input=scene(["Item","Container"]),s=service(insufficient);input.primary.category="Special Waste";
 const response=await s.response(input);assert.deepEqual(response.categoryAssessments.items.map(i=>i.category),["Unknown","Unknown"]);
 assert.equal(response.category,"Special Waste");assert.equal(s.calls(),1);
});
test("N disabled or failed provider does not fabricate provisional AI categories or retry",async()=>{
 for(const config of [{WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"},{}]){
  const input=scene(["Paper envelope"]),s=service(evidence("Recyclable","single_material","paper"),config,true);
  const result=await s.response(input);assert.equal(result.categoryAssessments.items[0].category,"Unknown");
  await s.response(input);assert.equal(s.calls(),config.WASTE_ITEM_ASSESSMENT_AI_ENABLED==="false"?0:1);
 }
 const input=scene(["Paper envelope"]),s=service(insufficient,{WASTE_ITEM_ASSESSMENT_ENABLED:"false"});
 const response=await s.response(input);assert.equal(response.categoryAssessments,undefined);assert.equal(s.calls(),0);
});
test("existing strict facts validator remains strict; prompt/protocol/deadlines stay version 1",()=>{
 const facts=evidence("Recyclable","single_material","paper");assert.equal(contract.categoryFromEvidence(facts),"Unknown");
 const input=scene(["Paper envelope"]);const body=contract.geminiBody({...input.capture,items:input.items});
 assert.match(body.contents[0].parts[0].text,/provisional category may coexist with unknown/);
 assert.deepEqual(body.generationConfig.responseSchema.properties.assessments.items.required,["itemId","category","kind","material","condition","evidence"]);
 assert.equal(contract.LIMITS.deadlineMs,12000);assert.equal(contract.LIMITS.outputTokens,2048);
});
