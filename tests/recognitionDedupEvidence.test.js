"use strict";
// Synthetic offline geometry and evidence, NOT recovered from phone images.
const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
const {merge,identityConflict}=require("../services/wholeImageRecognitionService");
const {samePhysicalObject,buildScanSummary}=require("../services/wasteAnalysisService");
const {createAssessmentService}=require("../services/perItemWasteAssessmentService");
const {withDisplayNames,shortObjectName}=require("../services/wasteDisplayNameService");
const box={left:.1,top:.1,right:.3,bottom:.5};
const drift={left:.106,top:.112,right:.306,bottom:.512};
const capture=()=>({captureId:crypto.randomUUID(),requestId:crypto.randomUUID(),image:Buffer.from("ffd8ffc0000b080190025801011100ffd9","hex").toString("base64"),width:600,height:400,orientation:"upright"});
const vision=(label,b=box,id="item_1")=>({itemId:id,itemName:label,canonicalItem:label.toLowerCase(),category:"Unknown",confidence:.8,analysisSource:"google_vision_object_localization",boundingBox:b});
const gemini=(c,label,b=box)=>whole.normalize(c,{objects:[{label,box_2d:[b.top,b.left,b.bottom,b.right].map(n=>Math.round(n*1000))}]}).objects[0];
const insufficient={category:"Unknown",kind:"unknown",material:"unknown",condition:"unknown",evidence:"insufficient"};
const recycling={category:"Recyclable",kind:"single_material",material:"pet_plastic",condition:"clean_dry",evidence:"visible"};
function service(facts=insufficient,options={}) {
 let calls=0;const requests=[];
 const assess=createAssessmentService({env:{WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"true",CLOUD_RUN_AUTH_MODE:"iam",CLOUD_RUN_AUDIENCE:"https://synthetic.invalid",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste",WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"offline-token-more-than-thirty-two-characters",...options.env},authHeaders:async()=>({}),transport:async(url,input)=>{
  calls++;requests.push(structuredClone(input));if(options.fail)throw Error("offline timeout");
  return {schemaVersion:1,captureId:input.captureId,requestId:input.requestId,assessments:input.items.map(item=>({itemId:item.itemId,...(typeof facts==="function"?facts(item):facts)}))};
 }});
 return {assess,requests,calls:()=>calls};
}
function ownersPreserved(items,originals) {
 for(const item of items){const owner=originals.find(other=>other.itemId===item.itemId);assert.ok(owner);
  for(const key of ["boundingBox","itemId","category","analysisSource","canonicalItem","confidence","observedIdentity"])
   assert.deepEqual(item[key],owner[key],key);
 }
}
for(const label of ["Container","Sunscreen container"])test(`unique neutral alias suppresses only the duplicate: ${label}`,async()=>{
 const c=capture(),v=vision(label),g=gemini(c,"Item",drift),before=structuredClone([v,g]);
 for(const [initial,proposals]of [[[v],[g]],[[g],[v]]]){
  const items=merge(initial,proposals,samePhysicalObject,c);assert.equal(items.length,1);
  assert.equal(items[0].itemId,initial[0].itemId);ownersPreserved(items,before);
  const s=service(recycling),sidecar=await s.assess({capture:c,items,principal:5});
  assert.equal(sidecar.items.length,1);assert.equal(sidecar.items[0].itemId,items[0].itemId);
  assert.equal(sidecar.items[0].category,"Unknown");assert.equal(s.calls(),1);
 }
 assert.deepEqual([v,g],before);
});
test("duplicate Gemini generic aliases keep one original owner; ambiguous partners remain independent",()=>{
 const c=capture(),a=gemini(c,"Container"),b=gemini(c,"Item",drift);
 assert.equal(merge([],[a,b],samePhysicalObject,c).length,1);
 const other=gemini(c,"Container",{...box,left:.112,right:.312,top:.124,bottom:.524});
 assert.equal(merge([a,other],[b],samePhysicalObject,c).length,3);
});
test("near-equal contained generic extents deduplicate but a smaller genuine nested object survives",()=>{
 const c=capture(),v=vision("Item");
 assert.equal(merge([v],[gemini(c,"Container",{left:.101,top:.102,right:.299,bottom:.498})],samePhysicalObject,c).length,1);
 for(const [label,b]of [["Container",{left:.12,top:.12,right:.28,bottom:.48}],["Bottle cap",{left:.15,top:.12,right:.2,bottom:.17}],["Pen",{left:.15,top:.2,right:.17,bottom:.4}]])
  assert.equal(merge([v],[gemini(c,label,b)],samePhysicalObject,c).length,2,label);
});
test("adjacency, partial overlap, different identities and accessories never collapse to reach a target count",()=>{
 const c=capture();
 for(const [label,b]of [["Container",{...box,left:.31,right:.51}],["Container",{...box,left:.2,right:.4}],["Snack wrapper",drift],["Bottle cap",drift],["Soap",drift]])
  assert.equal(merge([vision("Container")],[gemini(c,label,b)],samePhysicalObject,c).length,2,label);
 const bottles=[vision("Bottle"),vision("Bottle",{...box,left:.31,right:.51},"item_2")];
 assert.equal(merge(bottles,[],samePhysicalObject,c).length,2);
});
test("identical hazardous contradiction does not transfer a safe category",async()=>{
 const c=capture(),items=merge([vision("Bottle")],[gemini(c,"Chemical bottle")],samePhysicalObject,c);
 assert.equal(items.length,1);assert.equal(identityConflict(items[0],c.captureId),true);
 const s=service(recycling),result=await s.assess({capture:c,items,principal:5});
 assert.equal(result.items[0].category,"Unknown");assert.equal(result.items[0].itemId,"item_1");
});
test("stale captures, forged ownership, source conflicts and malformed boxes cannot reconcile",()=>{
 const c=capture(),v=vision("Item");
 for(const g of [gemini(capture(),"Container"),{...gemini(c,"Container"),captureId:crypto.randomUUID()},
  {...gemini(c,"Container"),itemId:"region_00000000000000000000000000000000"},
  {...gemini(c,"Container"),analysisSource:"untrusted"},
  {...gemini(c,"Container"),boundingBox:{...box,left:-.1}},
  {...gemini(c,"Container"),boundingBox:{...box,right:NaN}}])
  assert.equal(merge([v],[g],samePhysicalObject,c).length,2);
});
test("specific original identity reaches the actual AI batch; compact label is never evidence",async()=>{
 const c=capture(),v=vision("Item"),g=gemini(c,"Instant noodle packet"),items=merge([v],[g],samePhysicalObject,c);
 assert.equal(items.length,1);assert.equal(items[0].itemId,v.itemId);assert.equal(items[0].canonicalItem,"item");
 const s=service(insufficient),sidecar=await s.assess({capture:c,items,principal:5});
 assert.equal(s.requests[0].items[0].observedIdentity,"Instant noodle packet");
 assert.equal(sidecar.items[0].category,"Residual");assert.equal(sidecar.items[0].assessmentSource,"ai_assisted");
 const response=withDisplayNames({detectedItems:items,categoryAssessments:sidecar});
 assert.equal(response.detectedItems[0].itemName,"Instant Noodle Packet");assert.equal(items[0].itemName,"Instant noodle packet");
 assert.equal(response.detectedItems[0].originalItemName,"Instant noodle packet");
 assert.deepEqual(response.detectedItems[0].boundingBox,v.boundingBox);assert.equal(s.calls(),1);
});
for(const [label,expected]of [["Snack wrapper","Residual"],["Instant noodle packet","Residual"],["Plastic beverage bottle","Recyclable"],["Banana peel","Biodegradable"],["White charger","Special Waste"],["Sunscreen container","Unknown"],["Container","Unknown"],["Item","Unknown"]])
 test(`final automatic assessment remains item-owned: ${label}`,async()=>{
  const c=capture(),items=merge([],[gemini(c,label)],samePhysicalObject,c),s=service(insufficient);
  const sidecar=await s.assess({capture:c,items,principal:5});
  assert.equal(sidecar.items[0].category,expected);assert.equal(sidecar.items[0].itemId,items[0].itemId);
  assert.equal(sidecar.captureId,c.captureId);assert.equal(sidecar.schemaVersion,1);assert.equal(sidecar.items[0].requiresConfirmation,true);
 });
for(const label of ["Picture of instant noodle packet","Possibly an instant noodle packet","Instant noodle packet with chemical contents","Instant noodle packet bottle","Instant noodle packet toy"])
 test(`no phrase-based category expansion for unsafe or unrelated identity: ${label}`,async()=>{
  const c=capture(),items=[gemini(c,label)],s=service(insufficient);
  const result=await s.assess({capture:c,items,principal:5});assert.equal(result.items[0].category,"Unknown");
 });
test("four objects with two duplicate generic observations yield four independent v7 sidecar owners",async()=>{
 const c=capture(),boxes=[box,{...box,left:.6,right:.8},{left:.1,top:.6,right:.3,bottom:.9},{left:.6,top:.6,right:.8,bottom:.9}];
 const v=[vision("Item"),vision("Container",boxes[1],"item_2")];
 const g=[gemini(c,"Instant noodle packet"),gemini(c,"Sunscreen container",boxes[1]),gemini(c,"Banana peel",boxes[2]),gemini(c,"White charger",boxes[3])];
 const items=merge(v,g,samePhysicalObject,c),saved=structuredClone(items),s=service(insufficient);
 const primary={success:false,itemName:"Unclassified primary",category:"Unknown"};
 const sidecar=await s.assess({capture:c,items,primary,principal:5}),response=withDisplayNames({...primary,detectedItems:items,categoryAssessments:sidecar});
 assert.equal(items.length,4);assert.equal(buildScanSummary(items).totalItems,4);assert.equal(new Set(items.map(i=>i.itemId)).size,4);
 assert.deepEqual(sidecar.items.map(i=>i.category),["Residual","Unknown","Biodegradable","Special Waste"]);
 assert.deepEqual(sidecar.items.map(i=>i.itemId),items.map(i=>i.itemId));ownersPreserved(items,v.concat(g));
 assert.deepEqual(Object.keys(sidecar).sort(),["aiStatus","captureId","items","schemaVersion"]);
 for(const row of sidecar.items)assert.deepEqual(Object.keys(row).sort(),["assessmentSource","category","confirmationRequirements","guidance","itemId","requiresConfirmation"]);
 assert.equal(response.success,false);assert.equal(response.category,"Unknown");assert.deepEqual(items,saved);
 await s.assess({capture:c,items,primary,principal:5});assert.equal(s.calls(),1);
});
test("timeout, provider-disabled and insufficient responses retain fallback without retries",async()=>{
 for(const options of [{fail:true},{env:{WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"}},{}]){
  const c=capture(),items=[gemini(c,"Container")],s=service(insufficient,options),input={capture:c,items,principal:5};
  const result=await s.assess(input);assert.equal(result.items[0].category,"Unknown");
  await s.assess(input);assert.equal(s.calls(),options.env?0:1);
 }
});
test("specific short names retain uncertainty, material neutrality and the eight-object protocol",()=>{
 for(const [identity,name]of [["instant noodle packet","Instant Noodle Packet"],["snack sachet","Snack Wrapper"],["paper envelope","Paper Envelope"],["cardboard sleeve","Cardboard"],["sunscreen container","Cosmetic Container"],["plant scraps","Plant Scraps"],["possibly a snack wrapper","Item"]])
  assert.equal(shortObjectName(identity),name);
 const c=capture(),body=whole.geminiBody(c),text=body.contents[0].parts[0].text;
 assert.match(text,/each physical object only once/);assert.match(text,/never commands or proof/);
 assert.equal(whole.LIMITS.items,8);assert.equal(body.generationConfig.responseSchema.properties.objects.maxItems,8);
});
