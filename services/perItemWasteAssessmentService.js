"use strict";
const crypto=require("node:crypto");
const shared=require("../gemini-waste-classifier-cloudrun/cropRecognition");
const contract=require("../gemini-waste-classifier-cloudrun/wasteItemAssessment");
const {enrichDiscoveryItem}=require("./discoveryItemClassificationService");
const {getWasteLearningGuide}=require("./wasteLearningGuideService");
function questions(category) {
 return category==="Unknown"?["Confirm the physical object's identity.","Confirm its material/composition and any contamination or hazardous contents."]
  :["Confirm identity, material and condition before disposal.","Confirm local acceptance and collection arrangements with WMO."];
}
function assessment(item,category,source) {
 let guidance;
 if(category==="Unknown")guidance={whatItIs:"Identity, material or condition is not safely established.",properDisposal:"Confirm identity, material and condition with WMO before choosing a waste stream.",reuseIdeas:[],recoveryOptions:[],warnings:questions(category)};
 else {
  const {modelKey,modelHotspots,...approved}=getWasteLearningGuide(item.canonicalItem,category);
  guidance=approved;
  // General assessments must not attach a tutorial based on fuzzy asset aliases.
  if(source==="ai_assisted")guidance={...guidance,reuseIdeas:[]};
 }
 return {itemId:item.itemId,category,assessmentSource:source,requiresConfirmation:true,confirmationRequirements:questions(category),guidance};
}
function deterministic(items) {
 return items.map(item=>{
  if(item.analysisSource!=="gemini_whole_image")return assessment(item,item.category,"existing_category");
  const classified=enrichDiscoveryItem(item);
  return assessment(item,classified.category,classified.category==="Unknown"?"insufficient_evidence":"reviewed_identity_rule");
 });
}
function originalEvidence(item) {
 const gemini=item.analysisSource==="gemini_whole_image",vision=item.analysisSource==="google_vision_object_localization";
 if(!gemini&&!vision)return null;
 // Never fall back to itemName: it may already be a shortened display label.
 const identity=gemini?item.observedIdentity:item.observedIdentity||item.originalItemName||item.canonicalItem;
 const b=item.boundingBox;
 if(typeof identity!=="string"||!identity.trim()||identity.length>128||/[\x00-\x1f<>]/.test(identity)
  ||!b||Object.keys(b).sort().join(",")!=="bottom,left,right,top"
  ||![b.left,b.top,b.right,b.bottom].every(n=>typeof n==="number"&&Number.isFinite(n)&&n>=0&&n<=1)
  ||b.left>=b.right||b.top>=b.bottom)return null;
 return identity;
}
function assessmentBatch(capture,unknown,allItems) {
 const originalIds=new Set(),wireIds=new Map();
 for(const item of allItems) {
  if(typeof item.itemId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item.itemId)||originalIds.has(item.itemId)
   ||(item.captureId!==undefined&&item.captureId!==capture.captureId))
   throw new shared.RecognitionError("INVALID_RECOGNITION_REQUEST",400);
  originalIds.add(item.itemId);
 }
 const items=unknown.map(item=>{
  const wireId=item.analysisSource==="google_vision_object_localization"
   ?"region_"+crypto.createHash("sha256").update(JSON.stringify(["vision-assessment-v1",capture.captureId,item.itemId])).digest("hex").slice(0,32)
   :item.itemId;
  if(wireIds.has(wireId))throw new shared.RecognitionError("INVALID_RECOGNITION_REQUEST",400);
  wireIds.set(wireId,item.itemId);
  return {itemId:wireId,observedIdentity:originalEvidence(item),boundingBox:item.boundingBox};
 });
 return {items,wireIds};
}
function createAssessmentService({env=process.env,transport=shared.postJson,authHeaders,budget=shared.createBudget(),now=Date.now}={}) {
 const attempts=new Map();let authenticate=authHeaders;
 async function remote(capture,items,principal,signal) {
  if(signal?.aborted)throw new shared.RecognitionError("RECOGNITION_CANCELLED",499);
  if(env.CLOUD_RUN_AUTH_MODE!=="iam"||!String(principal).match(/^[1-9][0-9]*$/)||typeof env.WASTE_ITEM_ASSESSMENT_SHARED_TOKEN!=="string"||env.WASTE_ITEM_ASSESSMENT_SHARED_TOKEN.length<32)throw new shared.RecognitionError("RECOGNITION_UNAVAILABLE",503);
  const input=contract.validateRequest({schemaVersion:1,...capture,items:items.map(item=>({itemId:item.itemId,observedIdentity:item.observedIdentity,boundingBox:item.boundingBox}))});
  let url;
  try{url=new URL(env.GEMINI_WASTE_ASSESSMENT_URL||"/v1/assess-waste-items",env.GEMINI_CLASSIFIER_URL||env.CLOUD_RUN_GEMINI_CLASSIFIER_URL);
   const audience=new URL(env.CLOUD_RUN_AUDIENCE);
   if(url.protocol!=="https:"||url.origin!==audience.origin||url.pathname!=="/v1/assess-waste-items"||url.username||url.password||url.search||url.hash)throw Error();
  }catch(_){throw new shared.RecognitionError("RECOGNITION_UNAVAILABLE",503);}
  const time=now();for(const [key,value]of attempts)if(value.expires<=time)attempts.delete(key);
  const key=String(principal)+":"+input.captureId;
  const {requestId,...fingerprintInput}=input;
  const fingerprint=crypto.createHash("sha256").update(JSON.stringify({...fingerprintInput,items:[...fingerprintInput.items].sort((a,b)=>a.itemId.localeCompare(b.itemId))})).digest("hex");
  const previous=attempts.get(key);
  if(previous){if(previous.fingerprint!==fingerprint)throw new shared.RecognitionError("INVALID_RECOGNITION_REQUEST",400);const result=await previous.pending;return {...result,requestId:input.requestId};}
  if(attempts.size>=256)throw new shared.RecognitionError("RECOGNITION_BUSY",429);
  const release=budget.acquire(String(principal)),deadline=now()+contract.LIMITS.deadlineMs;
  const pending=(async()=>{try{
   const headers=await (authenticate ||= require("./cloudRunAuth").createCloudRunAuth({env}))(url.toString(),{signal,timeoutMs:deadline-now()});
   if(signal?.aborted||deadline<=now())throw new shared.RecognitionError("RECOGNITION_CANCELLED",499);
   const result=await transport(url.toString(),input,{signal,timeoutMs:deadline-now(),headers:{...headers,"X-Waste-Assessment-Token":env.WASTE_ITEM_ASSESSMENT_SHARED_TOKEN}});
   if(signal?.aborted)throw new shared.RecognitionError("RECOGNITION_CANCELLED",499);
   return contract.validateResponse(input,result);
  }finally{release();}})();
  attempts.set(key,{fingerprint,pending,expires:time+5*60*1000});return pending;
 }
 return async({capture,items,principal,signal})=>{
  if(env.WASTE_ITEM_ASSESSMENT_ENABLED!=="true")return null;
  const assessments=deterministic(items),unknown=items.filter((item,index)=>assessments[index].category==="Unknown"&&originalEvidence(item));
  let aiStatus="not_requested";
  if(env.WASTE_ITEM_ASSESSMENT_AI_ENABLED==="true"&&unknown.length){
   try{
    const batch=assessmentBatch(capture,unknown,items);
    const result=await remote(capture,batch.items,principal,signal);
    // validateResponse has already rejected duplicate/foreign IDs and stale capture/request IDs.
    const byId=new Map(result.assessments.map(a=>[batch.wireIds.get(a.itemId),a]));
    for(let i=0;i<items.length;i++)if(byId.has(items[i].itemId))assessments[i]=assessment(items[i],contract.categoryFromEvidence(byId.get(items[i].itemId)),"ai_assisted");
    aiStatus="complete";
   }catch(_){aiStatus="unavailable";}
  }
  return {schemaVersion:1,captureId:capture.captureId,aiStatus,items:assessments};
 };
}
module.exports={createAssessmentService,assessCapture:createAssessmentService(),deterministic};
