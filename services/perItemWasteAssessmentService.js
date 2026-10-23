"use strict";
const crypto=require("node:crypto");
const shared=require("../gemini-waste-classifier-cloudrun/cropRecognition");
const contract=require("../gemini-waste-classifier-cloudrun/wasteItemAssessment");
const {enrichDiscoveryItem}=require("./discoveryItemClassificationService");
const {automaticCategory,unsafeProviderEvidence,unsafeIdentity,corroboratedCategory,providerIdentityConflict,requiresWasteIdentityReview,physicalSpecialWasteIdentity,unreliablePhysicalIdentity,productStateVeto,commonObjectCategory}=require("./automaticWasteCategoryMapper");
const {alignedIdentity,identityConflict}=require("./wholeImageRecognitionService");
const {getWasteLearningGuide}=require("./wasteLearningGuideService");
const {createAssessmentReasons,recordAssessmentReasons}=require("./wasteAssessmentDiagnostics");
function questions(category) {
 return category==="Unknown"?["Confirm the physical object's identity.","Confirm its material/composition and any contamination or hazardous contents."]
  :["Confirm identity, material and condition before disposal.","Confirm local acceptance and collection arrangements with WMO."];
}
function assessment(item,category,source,identityMapped=false) {
 let guidance;
 if(category==="Unknown")guidance={whatItIs:"Identity, material or condition is not safely established.",properDisposal:"Confirm identity, material and condition with WMO before choosing a waste stream.",reuseIdeas:[],recoveryOptions:[],warnings:questions(category)};
 else {
  const {modelKey,modelHotspots,...approved}=getWasteLearningGuide(item.canonicalItem,category);
  guidance=approved;
  // General assessments must not attach a tutorial based on fuzzy asset aliases.
  if(source==="ai_assisted"||identityMapped)guidance={...guidance,reuseIdeas:[]};
  if(identityMapped)guidance={...guidance,whatItIs:"Provisional suggestion from the observed object identity. Material, contents and condition are not verified."};
 }
 return {itemId:item.itemId,category,assessmentSource:source,requiresConfirmation:true,confirmationRequirements:questions(category),guidance};
}
function deterministic(items,captureId) {
 // Capture ownership applies before every path, including no-AI/cache-free
 // deterministic suggestions. Unbound legacy Vision observations stay valid.
 if(items.some(item=>item.captureId!==undefined && item.captureId!==captureId))
  throw new shared.RecognitionError("INVALID_RECOGNITION_REQUEST",400);
 // A sidecar-only API cannot rewrite the caller's known detection owner.
 // Final assembly must apply this veto to owners first (merge does so), then
 // recalculate primary/summary. Reject raw unsafe owners rather than emit a
 // conflicting Unknown row or silently bless the old disposal category.
 if(items.some(item=>item.category!=="Unknown"
   && productStateVeto(item,item.category,alignedIdentity(item,captureId))))
  throw new shared.RecognitionError("INVALID_RECOGNITION_REQUEST",400);
 return items.map(item=>{
  if(item.category==="Unknown" && identityConflict(item,captureId))return assessment(item,"Unknown",
   item.analysisSource==="gemini_whole_image"?"insufficient_evidence":"existing_category");
  // Android assessment v1 only accepts reviewed_identity_rule for Gemini.
  // Keep Vision's established/Unknown category as existing_category until AI succeeds.
  if(item.analysisSource!=="gemini_whole_image")return assessment(item,item.category,"existing_category");
  const classified=enrichDiscoveryItem(item);
  const mapped=classified.category==="Unknown"?automaticCategory(item):null;
  if(productStateVeto(item,mapped||classified.category,alignedIdentity(item,captureId)))
   return assessment(item,"Unknown","insufficient_evidence");
  return assessment(item,mapped||classified.category,mapped?"reviewed_identity_rule":
   classified.category==="Unknown"?"insufficient_evidence":"reviewed_identity_rule",!!mapped);
 });
}
function originalEvidence(item,captureId,useAlignment=true) {
 if(item.captureId!==undefined && item.captureId!==captureId)return null;
 const gemini=item.analysisSource==="gemini_whole_image",vision=item.analysisSource==="google_vision_object_localization";
 if(!gemini&&!vision)return null;
 // Never fall back to itemName: it may already be a shortened display label.
 const identity=(useAlignment && !unsafeIdentity(item) && alignedIdentity(item,captureId))
  || (gemini?item.observedIdentity:item.observedIdentity||item.originalItemName||item.canonicalItem);
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
  return {itemId:wireId,observedIdentity:originalEvidence(item,capture.captureId),boundingBox:item.boundingBox};
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
 return async({capture,items,primary,principal,signal})=>{
  if(env.WASTE_ITEM_ASSESSMENT_ENABLED!=="true")return null;
  const reasons=createAssessmentReasons();
  const assessments=deterministic(items,capture.captureId),unknown=items.filter((item,index)=>{
   if(!originalEvidence(item,capture.captureId)){
    if(assessments[index].category==="Unknown")reasons.identity_unproven++;
    return false;
   }
   // Structured assessment v1 has no empty/discarded-state evidence field.
   // Do not create a paid assessment just because this policy vetoed an old
   // catalog suggestion: its category/material facts cannot lift that veto.
   // Eligibility belongs to the original localized owner, not a different
   // observation's empty/discarded qualifier. Keep aligned evidence private
   // and available for existing eligible requests, without creating a new one.
   const identity=originalEvidence(item,capture.captureId,false),catalog=shared.matchIdentity(identity);
   // New deterministic common-object suggestions require no new paid call.
   // Conflict and explicit safety vetoes were already applied above/at merge.
   if(commonObjectCategory(identity)===assessments[index].category
     && assessments[index].category!=="Unknown"
     && !/^(?:empty|discarded)\s+/i.test(identity))return false;
   const productIdentity=(catalog && ["Residual","Recyclable"].includes(catalog.category))
    || (/\b(?:snack|food|noodle|candy|chocolate|biscuit|chips|beverage|water|soda)\b/i.test(identity)
      && /\b(?:wrapper|packet|sachet|packaging|bottle)\b/i.test(identity));
   // Generic objects may still carry valid electrical/battery evidence, and
   // existing hazardous-object suggestions must still receive their AI veto.
   if(assessments[index].category==="Unknown" && productIdentity
     && productStateVeto(item,"Residual"))return false;
   if(assessments[index].category==="Unknown")return true;
   // Keep one bounded AI safety review for freshly mapped suggestions.
   // Do not re-assess pre-existing, established item categories.
   return !!automaticCategory(item)&&item.category==="Unknown"
    &&(item.analysisSource!=="gemini_whole_image"||enrichDiscoveryItem(item).category==="Unknown");
  });
  let aiStatus="not_requested";
  if(env.WASTE_ITEM_ASSESSMENT_AI_ENABLED==="true"&&unknown.length){
   try{
    const batch=assessmentBatch(capture,unknown,items);
    const result=await remote(capture,batch.items,principal,signal);
    // validateResponse has already rejected duplicate/foreign IDs and stale capture/request IDs.
    const byId=new Map(result.assessments.map(a=>[batch.wireIds.get(a.itemId),a]));
    for(let i=0;i<items.length;i++)if(byId.has(items[i].itemId)) {
     const provider=byId.get(items[i].itemId),verified=contract.categoryFromEvidence(provider);
     const identity=originalEvidence(items[i],capture.captureId);
     const evidenceItem={...items[i],observedIdentity:identity};
     // Failed/unhelpful alignment cannot erase an independent localized Vision
     // identity. Explicit conflicting/state evidence still vetoes below.
     const independent=items[i].analysisSource==="google_vision_object_localization"
      ? automaticCategory({...items[i],observedIdentity:originalEvidence(items[i],capture.captureId,false)}) : null;
     const mapped=automaticCategory(evidenceItem)||independent;
     const provisional=verified==="Unknown"?corroboratedCategory(evidenceItem,provider):null;
     const evidenceCategory=verified!=="Unknown"?verified:provisional||"Unknown";
     const suggested=evidenceCategory!=="Unknown"?evidenceCategory:
      mapped&&!unsafeProviderEvidence(provider,mapped)?mapped:"Unknown";
     // Scene primary is never copied to multiple items. It may corroborate an
     // matching, safely recognized single identity only after a valid AI batch.
     const primaryItem={...items[i],observedIdentity:primary?.aiLabel || primary?.itemName};
     const family=label=>String(label||"").toLowerCase().match(/\b(?:bottle|charger|power adapter|banana peel|snack wrapper)\b/g);
     const localFamily=family(identity),primaryFamily=family(primaryItem.observedIdentity);
     const genericIdentity=/^(?:(?:black|white|red|green|blue|yellow|gray|grey|clear|transparent)\s+)?(?:bottle|container|item|object)$/i.test(identity);
     const consistentPrimary=items.length===1 && primary?.analysisSource==="cloud_run_gemini_vision"
      && !genericIdentity
      && Number(primary.aiConfidence)>=.8 && Number(primary.aiConfidence)<=1
      && primary.category===automaticCategory(primaryItem) && !unsafeIdentity(primaryItem)
      && localFamily?.length===1 && primaryFamily?.length===1 && localFamily[0]===primaryFamily[0]
      && !/\b(?:unknown|unidentified|ambiguous|generic|maybe|possibly|not|picture|printed|packaging)\b/i.test(identity);
     const supported=suggested==="Unknown" && consistentPrimary && !unsafeProviderEvidence(provider,primary.category)
      ? primary.category : suggested;
     const contradictory=providerIdentityConflict(evidenceItem,provider) || evidenceCategory!=="Unknown" && ((mapped && mapped!==evidenceCategory)
      || (/\bbottle\b/i.test(identity) && !["single_material","unknown"].includes(provider.kind))
      || (consistentPrimary && primary.category!==evidenceCategory));
     const unprovenContainer=supported==="Recyclable" && !mapped
      && /\b(?:container|item|object)\b/i.test(identity)
      && !/\b(?:glass|paper|cardboard|aluminum|pet|hdpe|marked)\b/i.test(identity);
     const primaryHazard=items.length===1 && primary?.analysisSource==="cloud_run_gemini_vision"
      && (primary.category==="Special Waste" || unsafeIdentity(primaryItem)) && supported!=="Special Waste";
     const conflictingIdentity=identityConflict(items[i],capture.captureId);
     // Preserve exact independently localized safety identities when optional
     // assessment adds no contrary facts. This is not an exemption for a model
     // category claim, an unrecognized hazardous object, or conflicting evidence.
     const exactSpecial=supported==="Special Waste" && mapped==="Special Waste"
      && !!physicalSpecialWasteIdentity(evidenceItem) && !conflictingIdentity && !contradictory
      && (!unsafeIdentity(items[i]) || !!physicalSpecialWasteIdentity(items[i]))
      && (provider.evidence==="insufficient" || provider.kind==="unknown" || !unsafeIdentity(evidenceItem));
     // A neutral missing-identity label is not contradictory physical evidence.
     // Only strict, visible electrical/battery facts may supply provisional
     // Special Waste routing here; no identity or material is rewritten.
     const neutralIdentity=value=>/^(?:(?:unknown|unclassified|unidentified|generic)\s+)?(?:household\s+)?(?:item|object|container)$/i.test(String(value||"").trim());
     const validatedElectrical=verified==="Special Waste" && ["electrical","battery"].includes(provider.kind)
      && !conflictingIdentity && !contradictory && neutralIdentity(identity)
      && neutralIdentity(items[i].observedIdentity||items[i].originalItemName||items[i].canonicalItem)
      && !unsafeIdentity(items[i]) && !unsafeIdentity(evidenceItem);
     const unsafeRecognition=((unsafeIdentity(items[i]) || unsafeIdentity(evidenceItem)) && !exactSpecial)
      || (!validatedElectrical && (unreliablePhysicalIdentity(items[i]) || unreliablePhysicalIdentity(evidenceItem)));
     // A visible unopened/filled product is not established as discarded
     // empty packaging, even when structured model facts suggest a stream.
     const protectedProduct=productStateVeto(items[i],supported)
      || productStateVeto(items[i],supported,alignedIdentity(items[i],capture.captureId));
     // Unlike the overlapping legacy safety_veto counter, these identify the
     // specific predicates that blocked a suggestion or forced Unknown.
     const providerVeto=suggested==="Unknown" && ((mapped && unsafeProviderEvidence(provider,mapped))
      || (consistentPrimary && unsafeProviderEvidence(provider,primary.category)));
     // Original or capture-bound reconciled identity must establish waste form.
     // Neither validated provider facts nor a scene-primary category can supply
     // that missing identity for generic food packaging or whole fruit.
     const unprovenWasteForm=requiresWasteIdentityReview(evidenceItem,items[i]);
     const category=conflictingIdentity || contradictory || unprovenContainer || primaryHazard || unsafeRecognition
      || unprovenWasteForm
      || (protectedProduct && ["Residual","Recyclable"].includes(supported))
      ? "Unknown" : supported;
     // Observe the existing decision only; do not broaden identity or safety gates.
     if(category==="Unknown") {
      if(unsafeRecognition)reasons.veto_observed_identity++;
      if(primaryHazard)reasons.veto_primary_hazard++;
      if(providerVeto)reasons.veto_provider_evidence++;
      if(verified==="Unknown")reasons.provider_insufficient++;
      if(primaryHazard || unsafeRecognition || unsafeProviderEvidence(provider,mapped||primary?.category))reasons.safety_veto++;
      if(conflictingIdentity)reasons.identity_conflict++;
      if(contradictory)reasons.category_contradiction++;
      if(unprovenContainer || (!mapped && /\b(?:container|item|object|packaging)\b/i.test(identity||"")))reasons.generic_container++;
      if(!mapped)reasons.identity_unproven++;
      if(items.length===1 && primary && !consistentPrimary) {
       reasons.primary_mismatch++;
       if(!(Number(primary.aiConfidence)>=.8 && Number(primary.aiConfidence)<=1))reasons.primary_confidence_unproven++;
       if(!(localFamily?.length===1 && primaryFamily?.length===1 && localFamily[0]===primaryFamily[0]))reasons.primary_identity_mismatch++;
       if(primary.analysisSource!=="cloud_run_gemini_vision" || primary.category!==automaticCategory(primaryItem))reasons.primary_category_unproven++;
      }
     }
     if(category==="Unknown")assessments[i]=assessment(items[i],"Unknown","ai_assisted");
     else if(evidenceCategory!=="Unknown"||consistentPrimary||items[i].analysisSource==="google_vision_object_localization")
      // Keep the v1 ai_assisted/complete pairing and original owner ID/category.
      // Vision-capable Android parser support must be verified on the installed app.
      assessments[i]=assessment(items[i],category,"ai_assisted",verified==="Unknown"||validatedElectrical);
     // Otherwise retain Gemini's reviewed_identity_rule mapping suggestion.
    }
    aiStatus="complete";
   }catch(error){aiStatus="unavailable";reasons.ai_unavailable=1;
    if(error?.code==="INVALID_RECOGNITION_REQUEST")reasons.request_rejected=1;
   }
  }
  if(aiStatus==="not_requested" && unknown.length)reasons.ai_not_requested=1;
  reasons.classification_accepted=assessments.filter(item=>["Biodegradable","Recyclable","Residual","Special Waste"].includes(item.category)).length;
  return recordAssessmentReasons({schemaVersion:1,captureId:capture.captureId,aiStatus,items:assessments},reasons);
 };
}
module.exports={createAssessmentService,assessCapture:createAssessmentService(),deterministic};
