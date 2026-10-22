"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
const {merge,identityConflict}=require("../services/wholeImageRecognitionService");
const {samePhysicalObject,buildScanSummary}=require("../services/wasteAnalysisService");
const {createAssessmentService}=require("../services/perItemWasteAssessmentService");
const {assessmentReasonCounts,logAssessment}=require("../services/wasteAssessmentDiagnostics");
const box={left:.1,top:.1,right:.3,bottom:.5};
const shift=b=>({left:b.left+.006,top:b.top+.012,right:b.right+.006,bottom:b.bottom+.012});
const capture=()=>({captureId:crypto.randomUUID(),requestId:crypto.randomUUID(),image:Buffer.from("ffd8ffc0000b080190025801011100ffd9","hex").toString("base64"),width:600,height:400,orientation:"upright"});
const vision=(name,id="item_1",b=box)=>({itemId:id,itemName:name,canonicalItem:name.toLowerCase(),category:"Unknown",confidence:.8,analysisSource:"google_vision_object_localization",boundingBox:b});
const gemini=(c,label,b=box)=>whole.normalize(c,{objects:[{label,box_2d:[b.top,b.left,b.bottom,b.right].map(n=>Math.round(n*1000))}]}).objects[0];
const insufficient={category:"Unknown",kind:"unknown",material:"unknown",condition:"unknown",evidence:"insufficient"};
const recyclable={category:"Recyclable",kind:"single_material",material:"pet_plastic",condition:"clean_dry",evidence:"visible"};
function service(facts=()=>insufficient,extra={}) {
 let calls=0;
 const assess=createAssessmentService({env:{WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"true",CLOUD_RUN_AUTH_MODE:"iam",
  CLOUD_RUN_AUDIENCE:"https://synthetic.invalid",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste",
  WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"offline-only-token-longer-than-thirty-two-characters",...extra},authHeaders:async()=>({}),transport:async(url,input)=>{
   calls++;return {schemaVersion:1,requestId:input.requestId,captureId:input.captureId,assessments:input.items.map(i=>({itemId:i.itemId,...facts(i)}))};
  }});
 return {assess,calls:()=>calls};
}
test("synthetic two Vision plus four Gemini observations resolve to four, preserving original owners",async()=>{
 // Controlled synthetic geometry, NOT recovered from a production photo.
 const c=capture(),green={left:.5,top:.1,right:.7,bottom:.5};
 const v=[vision("Container"),vision("Green container","item_2",green)];
 const g=[gemini(c,"Clear bottle",shift(box)),gemini(c,"Green jar",shift(green)),
  gemini(c,"White charger",{left:.1,top:.6,right:.3,bottom:.9}),gemini(c,"Red snack wrapper",{left:.5,top:.6,right:.7,bottom:.9})];
 const before=structuredClone({v,g});
 for(const [initial,proposals] of [[v,g],[[...v].reverse(),[...g].reverse()],[g,v]]) {
  const items=merge(initial,proposals,samePhysicalObject,c);
  assert.equal(items.length,4);assert.equal(buildScanSummary(items).totalItems,4);
  assert.equal(new Set(items.map(i=>i.itemId)).size,4);
  for(const item of items) {
   const owner=initial.concat(proposals).find(i=>i.itemId===item.itemId);
   for(const key of ["itemId","boundingBox","category","canonicalItem","observedIdentity","analysisSource","confidence","captureId"])
    assert.deepEqual(item[key],owner[key]);
  }
  const s=service(),result=await s.assess({capture:c,items,principal:5});
  assert.equal(result.items.length,4);assert.equal(s.calls(),1);assert.equal(result.captureId,c.captureId);
  assert.deepEqual(result.items.map(i=>i.itemId),items.map(i=>i.itemId));assert.ok(result.items.every(i=>i.requiresConfirmation));
 }
 assert.deepEqual({v,g},before);
});
test("same-provider near aliases merge only with one unambiguous partner",()=>{
 const c=capture(),a=gemini(c,"Container"),b=gemini(c,"Clear bottle",shift(box));
 for(const proposals of [[a,b],[b,a]])assert.equal(merge([],proposals,samePhysicalObject,c).length,1);
 const right=gemini(c,"Bottle",{...box,left:.4,right:.6});
 assert.equal(merge([],[b,right],samePhysicalObject,c).length,2);
 const left=gemini(c,"Bottle",{...box,left:.088,right:.288}),middle=gemini(c,"Container",{...box,left:.094,right:.294,top:.112,bottom:.512});
 assert.equal(merge([a,left],[middle],samePhysicalObject,c).length,3);
});
test("near aliases never absorb nested objects, accessories, partial overlap, unsafe identities or foreign captures",()=>{
 const c=capture(),a=vision("Container");
 for(const b of [gemini(c,"Bottle",{left:.12,top:.12,right:.28,bottom:.48}),
  gemini(c,"Bottle",{...box,left:.15,right:.35}),gemini(c,"Bottle cap",shift(box)),
  gemini(c,"Snack wrapper",shift(box)),gemini(c,"Spray bottle",shift(box)),gemini(c,"Printed bottle picture",shift(box)),
  gemini(c,"Chemical bottle",shift(box)),gemini(c,"Bottle",{...box,left:.4,right:.6}),
  gemini(capture(),"Bottle",shift(box))])assert.equal(merge([a],[b],samePhysicalObject,c).length,2,b.observedIdentity);
 const known={...a,category:"Special Waste"};assert.equal(merge([known],[gemini(c,"Bottle",shift(box))],samePhysicalObject,c).length,2);
});
test("same-provider conflicting identities veto classification even with AI disabled or valid provider recycling facts",async()=>{
 for(const enabled of ["true","false"])for(const labels of [["Bottle","Soap"],["Soap","Bottle"]]) {
  const c=capture(),g=labels.map(label=>gemini(c,label)),items=merge([],g,samePhysicalObject,c);
  assert.equal(items.length,1);assert.equal(identityConflict(items[0],c.captureId),true);
  const s=service(()=>recyclable,{WASTE_ITEM_ASSESSMENT_AI_ENABLED:enabled});
  const result=await s.assess({capture:c,items,principal:5});assert.equal(result.items[0].category,"Unknown");
  assert.equal(s.calls(),Number(enabled==="true"));assert.equal(result.items[0].itemId,items[0].itemId);
 }
 for(const labels of [["Bottle","Spray bottle"],["Spray bottle","Bottle"]]) {
  const c=capture(),v=labels.map((label,i)=>vision(label,`item_${i+1}`)),items=merge(v,[],samePhysicalObject,c);
  assert.equal(items.length,1);assert.equal(identityConflict(items[0],c.captureId),true);
  const s=service(()=>recyclable),r=await s.assess({capture:c,items,principal:5});
  assert.equal(r.items[0].category,"Unknown");assert.equal(r.items[0].itemId,items[0].itemId);
 }
});
test("safe single primary corroboration remains separate from nozzle and unsupported primary evidence",async()=>{
 const primary={analysisSource:"cloud_run_gemini_vision",category:"Recyclable",aiLabel:"Plastic water bottle",aiConfidence:.95};
 for(const [label,expected] of [["Water bottle with cap","Recyclable"],["Spray bottle with nozzle","Unknown"],["Bottle with unknown contents","Unknown"]]) {
  const s=service(),c=capture(),items=[vision(label)],before=structuredClone({primary,items});
  const result=await s.assess({capture:c,items,primary,principal:5});
  assert.equal(result.items[0].category,expected);assert.equal(s.calls(),1);assert.deepEqual({primary,items},before);
 }
 const s=service(),result=await s.assess({capture:capture(),items:[vision("Spray bottle with nozzle")],primary,principal:5});
 const reasons=assessmentReasonCounts(result);assert.equal(reasons.veto_observed_identity,1);assert.equal(reasons.veto_primary_hazard,0);
 assert.equal(reasons.veto_provider_evidence,0);
});
test("validated structured evidence reconciles independently and precise counters never log private data",async()=>{
 const c=capture(),items=[vision("Water bottle with cap"),vision("Snack wrapper","item_2",{...box,left:.5,right:.7}),vision("White charger","item_3",{...box,top:.6,bottom:.9})];
 const s=service(i=>i.observedIdentity.includes("water")?recyclable:insufficient);
 const result=await s.assess({capture:c,items,principal:5});
 assert.deepEqual(result.items.map(i=>i.category),["Recyclable","Residual","Special Waste"]);assert.equal(s.calls(),1);
 const logs=[];logAssessment(result,3,{info:line=>logs.push(line)},items);
 assert.doesNotMatch(logs.join(""),/item_1|water bottle|Snack wrapper|White charger|captureId|Bearer|boundingBox/);
 assert.deepEqual(Object.keys(result).sort(),["schemaVersion","captureId","aiStatus","items"].sort());
 const denied=service(()=>({...insufficient,material:"mixed",evidence:"visible"}));
 const r=await denied.assess({capture:capture(),items:[vision("Water bottle with cap")],principal:5});
 assert.equal(r.items[0].category,"Unknown");assert.equal(assessmentReasonCounts(r).veto_provider_evidence,1);
});

test("active primary hazard is distinct from observational safety counts on an unrelated scene primary",async()=>{
 const primary={analysisSource:"cloud_run_gemini_vision",category:"Special Waste",aiLabel:"Chemical bottle",aiConfidence:.95};
 const s=service(),r=await s.assess({capture:capture(),items:[vision("Water bottle with cap")],primary,principal:5});
 assert.equal(r.items[0].category,"Unknown");
 assert.equal(assessmentReasonCounts(r).veto_primary_hazard,1);assert.equal(assessmentReasonCounts(r).veto_observed_identity,0);
 const unrelated=service(()=>({...insufficient,material:"mixed",evidence:"visible"}));
 const result=await unrelated.assess({capture:capture(),items:[vision("Opaque tub"),vision("Item","item_2")],
  primary:{...primary,category:"Recyclable",aiLabel:"Plastic bottle"},principal:5});
 const reasons=assessmentReasonCounts(result);assert.equal(reasons.safety_veto,2);
 for(const code of ["veto_observed_identity","veto_primary_hazard","veto_provider_evidence"])assert.equal(reasons[code],0);
});
