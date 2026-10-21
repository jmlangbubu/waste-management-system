"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
const {createAssessmentService}=require("../services/perItemWasteAssessmentService");
const env={WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"true",CLOUD_RUN_AUTH_MODE:"iam",
 CLOUD_RUN_AUDIENCE:"https://synthetic.invalid",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste",
 WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"synthetic-assessment-token-over-32-characters"};
function scene() {
 const capture={requestId:crypto.randomUUID(),captureId:crypto.randomUUID(),image:Buffer.from([255,216,255,192,0,11,8,1,144,2,88,1,1,17,0,255,217]).toString("base64"),width:600,height:400,orientation:"upright"};
 const gemini=whole.normalize(capture,{objects:[{label:"unknown household object",box_2d:[100,50,800,250]},
  {label:"banana peel",box_2d:[100,750,800,950]}]}).objects;
 const vision=[1,2].map((n)=>({itemId:`item_${n}`,itemName:"Container",originalItemName:"Unclassified household container",
  canonicalItem:"unclassified household container",category:"Unknown",confidence:.8,
  analysisSource:"google_vision_object_localization",boundingBox:{left:.25*n,top:.2,right:.25*n+.2,bottom:.7}}));
 return {capture,items:[gemini[0],...vision,gemini[1]],principal:42};
}
function response(input) {return {schemaVersion:1,requestId:input.requestId,captureId:input.captureId,
 assessments:input.items.map(item=>({itemId:item.itemId,category:"Special Waste",kind:"electrical",material:"mixed",condition:"unknown",evidence:"visible"}))};}
function fixture(transform=value=>value,config={}) {
 const calls=[];const assess=createAssessmentService({env:{...env,...config},authHeaders:async()=>({Authorization:"Bearer synthetic"}),
  transport:async(url,input,options)=>{calls.push({url,input:structuredClone(input),options});return transform(response(input),input);}});
 return {assess,calls};
}
test("one mixed-provider batch maps Vision wire IDs back to exact Android IDs without mutating recognition",async()=>{
 const input=scene(),before=structuredClone(input),{assess,calls}=fixture(value=>({...value,assessments:value.assessments.reverse()}));
 const result=await assess(input);
 assert.equal(calls.length,1);assert.equal(calls[0].input.items.length,3);
 assert.equal(calls[0].input.image,input.capture.image);
 assert.equal(calls[0].input.captureId,input.capture.captureId);assert.equal(calls[0].input.orientation,"upright");
 assert.equal(calls[0].input.items[0].itemId,input.items[0].itemId);
 for(let n=1;n<3;n++) {
  const sent=calls[0].input.items[n];assert.match(sent.itemId,/^region_[0-9a-f]{32}$/);
  assert.notEqual(sent.itemId,input.items[n].itemId);assert.equal(sent.observedIdentity,input.items[n].originalItemName);
  assert.notEqual(sent.observedIdentity,input.items[n].itemName);assert.deepEqual(sent.boundingBox,input.items[n].boundingBox);
 }
 assert.equal(new Set(calls[0].input.items.map(i=>i.itemId)).size,3);
 assert.deepEqual(result.items.map(i=>i.itemId),input.items.map(i=>i.itemId));
 assert.deepEqual(result.items.map(i=>i.category),["Special Waste","Special Waste","Special Waste","Biodegradable"]);
 assert.equal(result.captureId,input.capture.captureId);assert.equal(result.schemaVersion,1);
 assert.ok(result.items.every(i=>i.requiresConfirmation===true));assert.deepEqual(input,before);
 assert.ok(calls[0].options.timeoutMs>0&&calls[0].options.timeoutMs<=12000);
});
test("same-name independent Vision objects keep distinct stable wire IDs across order and request IDs",async()=>{
 const input=scene(),{assess,calls}=fixture();
 const first=await assess(input);
 const second=await assess({...input,capture:{...input.capture,requestId:crypto.randomUUID()},items:[...input.items].reverse()});
 assert.equal(calls.length,1);assert.equal(calls[0].input.items[1].observedIdentity,calls[0].input.items[2].observedIdentity);
 assert.notEqual(calls[0].input.items[1].itemId,calls[0].input.items[2].itemId);
 assert.deepEqual(second.items.map(i=>i.itemId),input.items.map(i=>i.itemId).reverse());
 assert.deepEqual(second.items.map(i=>i.category),first.items.map(i=>i.category).reverse());
});
test("concurrent requests share one in-flight mixed batch",async()=>{
 const input=scene();let complete,calls=0,started;
 const ready=new Promise(resolve=>{started=resolve;});
 const assess=createAssessmentService({env,authHeaders:async()=>({}),transport:async(url,body)=>{
  calls++;started();return new Promise(resolve=>{complete=()=>resolve(response(body));});}});
 const first=assess(input);await ready;
 const second=assess({...input,capture:{...input.capture,requestId:crypto.randomUUID()}});
 complete();assert.equal((await first).aiStatus,"complete");assert.equal((await second).aiStatus,"complete");assert.equal(calls,1);
});
for(const kind of ["duplicate response ID","foreign response ID","Android ID echoed","stale capture","stale request","missing response"]) {
 test(`${kind} rejects the whole batch, preserves categories, and is not retried`,async()=>{
  const input=scene(),{assess,calls}=fixture(value=>{
   if(kind==="duplicate response ID")value.assessments[1].itemId=value.assessments[0].itemId;
   if(kind==="foreign response ID")value.assessments[1].itemId="region_"+"f".repeat(32);
   if(kind==="Android ID echoed")value.assessments[1].itemId="item_1";
   if(kind==="stale capture")value.captureId=crypto.randomUUID();
   if(kind==="stale request")value.requestId=crypto.randomUUID();
   if(kind==="missing response")value.assessments.pop();
   return value;
  });
  for(let retry=0;retry<2;retry++) {
   const result=await assess(input);assert.equal(result.aiStatus,"unavailable");
   assert.deepEqual(result.items.map(i=>i.category),["Unknown","Unknown","Unknown","Biodegradable"]);
   assert.deepEqual(result.items.map(i=>i.itemId),input.items.map(i=>i.itemId));
  }
  assert.equal(calls.length,1);
 });
}
test("duplicate original IDs including deterministic items cannot overwrite an established category",async()=>{
 const input=scene();input.items[1].itemId=input.items[3].itemId;
 const {assess,calls}=fixture(),result=await assess(input);
 assert.equal(calls.length,0);assert.equal(result.aiStatus,"unavailable");assert.equal(result.items[3].category,"Biodegradable");
});
test("Vision items lacking original evidence or valid geometry are excluded, never shortened-name classified",async()=>{
 const input=scene();delete input.items[1].originalItemName;delete input.items[1].canonicalItem;
 input.items[2].boundingBox={left:.5,top:.2,right:.4,bottom:.7};
 const {assess,calls}=fixture(),result=await assess(input);
 assert.equal(calls.length,1);assert.equal(calls[0].input.items.length,1);
 assert.equal(result.items[1].category,"Unknown");assert.equal(result.items[2].category,"Unknown");
});
test("Vision canonical evidence is used when originalItemName/observedIdentity are absent",async()=>{
 const input=scene();delete input.items[1].originalItemName;
 const {assess,calls}=fixture();await assess(input);
 assert.equal(calls[0].input.items[1].observedIdentity,input.items[1].canonicalItem);
});
for(const kind of ["insufficient","unknown material","category contradiction"]) {
 test(`AI ${kind} remains Unknown for both providers`,async()=>{
  const input=scene(),{assess}=fixture(value=>{
   for(const a of value.assessments) {
    a.category="Recyclable";a.kind="single_material";a.material="glass";a.condition="clean_dry";
    if(kind==="insufficient")a.evidence="insufficient";
    if(kind==="unknown material")a.material="unknown";
    if(kind==="category contradiction")a.category="Residual";
   }
   return value;
  });
  const result=await assess(input);assert.ok(result.items.slice(0,3).every(i=>i.category==="Unknown"&&i.requiresConfirmation));
 });
}
test("changed evidence under the same capture cannot trigger another inference",async()=>{
 const input=scene(),{assess,calls}=fixture();await assess(input);
 const changed=structuredClone(input);changed.items[1].originalItemName="different original evidence";
 assert.equal((await assess(changed)).aiStatus,"unavailable");assert.equal(calls.length,1);
});
test("a stale item capture ID is rejected before inference",async()=>{
 const input=scene();input.items[1].captureId=crypto.randomUUID();
 const {assess,calls}=fixture(),result=await assess(input);
 assert.equal(calls.length,0);assert.equal(result.aiStatus,"unavailable");
});
test("AI flag off keeps deterministic results with no provider or identity mutation",async()=>{
 const input=scene(),before=structuredClone(input),{assess,calls}=fixture(value=>value,{WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"});
 const result=await assess(input);assert.equal(result.aiStatus,"not_requested");assert.equal(calls.length,0);assert.deepEqual(input,before);
});
