"use strict";
// Synthetic offline evidence only: no image upload, database or paid inference.
const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {normalizeDetectedItems,samePhysicalObject,buildScanSummary}=require("../services/wasteAnalysisService");
const {merge,alignedIdentity,identityConflict}=require("../services/wholeImageRecognitionService");
const {createAssessmentService}=require("../services/perItemWasteAssessmentService");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
const box={left:.1,top:.1,right:.3,bottom:.5},far={left:.6,top:.1,right:.8,bottom:.5};
const capture=()=>({captureId:crypto.randomUUID(),requestId:crypto.randomUUID(),width:600,height:400,orientation:"upright",
 image:Buffer.from("ffd8ffc0000b080190025801011100ffd9","hex").toString("base64")});
const vision=(names)=>normalizeDetectedItems(names.map(([name,b=box])=>({name,confidence:.9,boundingBox:b})),"google_vision_object_localization");
const proposals=(c,names)=>whole.normalize(c,{objects:names.map(([label,b=box])=>({label,
 box_2d:[b.top,b.left,b.bottom,b.right].map(n=>n*1000)}))}).objects;
async function assess(c,items) {
 let calls=0;
 const service=createAssessmentService({env:{WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"true",
  CLOUD_RUN_AUTH_MODE:"iam",CLOUD_RUN_AUDIENCE:"https://offline.invalid",GEMINI_CLASSIFIER_URL:"https://offline.invalid/classify-waste",
  WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"offline-provenance-token-over-thirty-two-characters"},authHeaders:async()=>({}),
  transport:async(url,input)=>{calls++;return {schemaVersion:1,captureId:input.captureId,requestId:input.requestId,
   assessments:input.items.map(i=>({itemId:i.itemId,category:"Residual",kind:"wrapper",material:"mixed",condition:"non_recyclable",evidence:"visible"}))};}});
 const sidecar=await service({capture:c,items,principal:5});
 return {sidecar,calls};
}
function preserved(owner,original) {
 for(const key of ["itemId","boundingBox","confidence","analysisSource","observedIdentity","originalItemName","canonicalItem","captureId"])
  assert.deepEqual(owner[key],original[key],key);
}
const duplicateCases={
 "matching geometry":(c,g)=>g.push({...g[0]}),
 "conflicting identity":(c,g)=>g.push({...proposals(c,[["Empty snack wrapper"]])[0],itemId:g[0].itemId}),
 "different geometry":(c,g)=>g.push({...proposals(c,[["Unopened snack packet",far]])[0],itemId:g[0].itemId}),
 "otherwise valid candidate":(c,g)=>g.push({...g[0]},...proposals(c,[["Empty snack packet"]])),
 "ambiguous correspondence":(c,g)=>g.push({...g[0]},...proposals(c,[["Snack packet"]])),
 "identity-only duplicate":(c,g)=>g.push({...g[0],boundingBox:undefined})
};
for(const [scenario,mutate]of Object.entries(duplicateCases))for(const reverse of [false,true])
 test(`duplicate proposal cannot establish alignment: ${scenario}, reverse=${reverse}`,async()=>{
  const c=capture(),v=vision([["Snack packet"]]),g=proposals(c,[["Unopened snack packet"]]);mutate(c,g);
  const before=structuredClone({v,g}),items=merge(v,reverse?[...g].reverse():g,samePhysicalObject,c),owner=items.find(i=>i.itemId===v[0].itemId);
  assert.equal(alignedIdentity(owner,c.captureId),null);preserved(owner,v[0]);
  const result=await assess(c,items);assert.equal(owner.category,"Unknown");
  assert.equal(result.sidecar.items.find(i=>i.itemId===owner.itemId).category,"Unknown");assert.ok(result.calls<=1);
  assert.deepEqual({v,g},before);
 });
for(const label of ["Maybe unopened snack packet","Possibly unopened snack packet","Uncertain snack packet","Ambiguous snack packet",
 "Unknown identity","Unidentified object","Printed picture of unopened snack packet","Picture of a snack packet"])
 test(`explicit uncertainty cannot establish alignment: ${label}`,async()=>{
  const c=capture(),v=vision([["Snack packet"]]),items=merge(v,proposals(c,[[label]]),samePhysicalObject,c),owner=items.find(i=>i.itemId===v[0].itemId);
  assert.equal(alignedIdentity(owner,c.captureId),null);preserved(owner,v[0]);
  const result=await assess(c,items);assert.equal(owner.category,"Unknown");
  assert.equal(result.sidecar.items.find(i=>i.itemId===owner.itemId).category,"Unknown");assert.equal(result.calls,0);
 });
for(const label of ["Unopened snack packet","Sealed snack packet","Full snack packet"])
 test(`specific Unknown category is not uncertain identity: ${label}`,async()=>{
  const c=capture(),v=vision([["Snack packet"]]),g=proposals(c,[[label]]),items=merge(v,g,samePhysicalObject,c);
  assert.equal(g[0].category,"Unknown");assert.equal(alignedIdentity(items[0],c.captureId),label);preserved(items[0],v[0]);
  const result=await assess(c,items);assert.equal(result.sidecar.items[0].category,"Unknown");assert.equal(result.calls,0);
 });
for(const scenario of ["stale","foreign ID","duplicate owner ID"])
 test(`untrusted ownership cannot establish alignment: ${scenario}`,()=>{
  const c=capture(),v=vision([["Snack packet"]]),g=proposals(scenario==="stale"?capture():c,[["Unopened snack packet"]]);
  if(scenario==="foreign ID")g[0].itemId="region_"+"0".repeat(32);
  if(scenario==="duplicate owner ID")v.push({...v[0]});
  const items=merge(v,g,samePhysicalObject,c);
  for(const owner of items)assert.equal(alignedIdentity(owner,c.captureId),null);
 });
for(const [name,b]of [["adjacent",far],["nested",{left:.15,top:.2,right:.25,bottom:.35}],
 ["partial",{left:.2,top:.3,right:.4,bottom:.7}]])for(const reverse of [false,true])
 test(`independent ${name} regions cannot transfer state: reverse=${reverse}`,()=>{
  const c=capture(),v=vision([["Snack packet"]]),g=proposals(c,[["Unopened snack packet",b]]);
  const items=reverse?merge(v, [...g].reverse(),samePhysicalObject,c):merge(v,g,samePhysicalObject,c);
  assert.equal(items.length,2);assert.equal(alignedIdentity(items.find(i=>i.itemId===v[0].itemId),c.captureId),null);
  assert.deepEqual(items.find(i=>i.itemId===v[0].itemId).boundingBox,box);
  assert.deepEqual(items.find(i=>i.itemId===g[0].itemId).boundingBox,b);
 });
test("distinct IDs in separate regions retain independent valid correspondence",()=>{
 const c=capture(),v=vision([["Snack packet"],["Snack sachet",far]]),g=proposals(c,[["Unopened snack packet"],["Sealed snack sachet",far]]);
 for(const ordered of [g,[...g].reverse()]){
  const items=merge(v,ordered,samePhysicalObject,c);assert.equal(items.length,2);
  assert.deepEqual(items.map(i=>alignedIdentity(i,c.captureId)),["Unopened snack packet","Sealed snack sachet"]);
  items.forEach((i,n)=>preserved(i,v[n]));
 }
});
for(const field of ["itemId","category","canonicalItem","observedIdentity","originalItemName","analysisSource","boundingBox","captureId","confidence"])
 test(`changed evidence snapshot invalidates private alignment: ${field}`,()=>{
  const c=capture(),items=merge(vision([["Snack packet"]]),proposals(c,[["Unopened snack packet"]]),samePhysicalObject,c),owner=items[0];
  assert.equal(alignedIdentity(owner,c.captureId),"Unopened snack packet");
  if(field==="boundingBox")owner.boundingBox={...owner.boundingBox,right:.31};
  else if(field==="confidence")owner.confidence=.8;
  else owner[field]=field==="category"?"Residual":"changed";
  assert.equal(alignedIdentity(owner,c.captureId),null);
 });
for(const reverse of [false,true])test(`a valid-looking later observation cannot clear conflict: reverse=${reverse}`,()=>{
 const c=capture(),v=vision([["Packet"]]),g=proposals(c,[["Unopened snack packet"],["Chemical bottle"]]);
 const items=merge(v,reverse?[...g].reverse():g,samePhysicalObject,c),owner=items.find(i=>i.itemId===v[0].itemId);
 assert.equal(identityConflict(owner,c.captureId),true);assert.equal(alignedIdentity(owner,c.captureId),null);
 assert.equal(owner.category,"Unknown");assert.equal(alignedIdentity(owner,c.captureId),null);
});
for(const reverse of [false,true])test(`duplicate proposal cannot clear independent conflict: reverse=${reverse}`,()=>{
 const c=capture(),v=vision([["Packet"]]),g=proposals(c,[["Unopened snack packet"],["Chemical bottle"]]);g.push({...g[0]});
 const items=merge(v,reverse?[...g].reverse():g,samePhysicalObject,c),owner=items.find(i=>i.itemId===v[0].itemId);
 assert.equal(identityConflict(owner,c.captureId),true);assert.equal(alignedIdentity(owner,c.captureId),null);
 assert.equal(owner.category,"Unknown");preserved(owner,v[0]);
});
test("Full Bottle veto and aligned-only empty-wrapper zero-call rule survive",async()=>{
 const c=capture(),v=vision([["Empty plastic water bottle"]]),items=merge(v,proposals(c,[["Full plastic water bottle"]]),samePhysicalObject,c);
 // Empty versus Full is conservative conflict evidence, not a trusted positive identity.
 assert.equal(alignedIdentity(items[0],c.captureId),null);assert.equal(identityConflict(items[0],c.captureId),true);assert.equal(items[0].category,"Unknown");
 for(const key of ["modelKey","modelHotspots","action","warning","guidance"])assert.equal(Object.hasOwn(items[0],key),false);
 const r=await assess(c,items);assert.equal(r.sidecar.items[0].category,"Unknown");
 assert.equal(buildScanSummary(items).categories.recyclable,0);
 const d=capture(),wrapper=merge(vision([["Snack wrapper"]]),proposals(d,[["Empty snack wrapper"]]),samePhysicalObject,d),a=await assess(d,wrapper);
 assert.equal(alignedIdentity(wrapper[0],d.captureId),"Empty snack wrapper");assert.equal(wrapper[0].category,"Residual");
 assert.equal(a.sidecar.items[0].category,"Residual");assert.equal(a.calls,0);
});
for(const variant of ["duplicate","uncertain"])test(`untrusted Full Bottle proposal cannot erase a conservative conflict: ${variant}`,async()=>{
 const c=capture(),v=vision([["Empty plastic water bottle"]]),g=proposals(c,[[variant==="uncertain"?"Possibly full plastic water bottle":"Full plastic water bottle"]]);
 if(variant==="duplicate")g.push({...g[0]});
 const items=merge(v,g,samePhysicalObject,c),owner=items.find(i=>i.itemId===v[0].itemId);
 assert.equal(alignedIdentity(owner,c.captureId),null);assert.equal(identityConflict(owner,c.captureId),true);
 assert.equal(owner.category,"Unknown");preserved(owner,v[0]);
 for(const key of ["guidance","modelKey","modelHotspots","action","warning"])assert.equal(Object.hasOwn(owner,key),false);
 const r=await assess(c,items);assert.equal(r.sidecar.items.find(i=>i.itemId===owner.itemId).category,"Unknown");assert.ok(r.calls<=1);
});
