"use strict";
const {RecognitionError}=require("../gemini-waste-classifier-cloudrun/cropRecognition");

const DISCOVERY_ERRORS=new Map([
 ["INVALID_PROVIDER_RESPONSE","invalid_response"],["RECOGNITION_TIMEOUT","timeout"],
 ["RECOGNITION_CANCELLED","cancelled"],["RECOGNITION_UNAVAILABLE","unavailable"],
 ...["INVALID_RECOGNITION_REQUEST","RECOGNITION_PAYLOAD_TOO_LARGE","RECOGNITION_UNAUTHORIZED",
  "RECOGNITION_RATE_LIMITED","RECOGNITION_BUSY"].map(code=>[code,"rejected"])
]);
const DISCOVERY_FAILURES=new Set(["failed",...DISCOVERY_ERRORS.values()]);
// Diagnostic vocabulary only. It is not a recognition or classification rule.
const GENERIC_IDENTITIES=new Set(["object","item","household object","household item","bottle","bottles","jar","jars",
 "container","can","packaging","packaged goods","bottled and jarred packaged goods","packet","packets","sachet","sachets"]);
const VISION="google_vision_object_localization",GEMINI="gemini_whole_image";
function discoveryFailureStatus(error) {
 return error instanceof RecognitionError ? DISCOVERY_ERRORS.get(error.code)||"failed" : "failed";
}
const boundedDiscoveryItems=value=>Array.isArray(value)?value.slice(0,8):[];
function localizedDiscoveryBox(box) {
 return !!box && typeof box==="object" && Object.keys(box).sort().join(",")==="bottom,left,right,top"
  && [box.left,box.top,box.right,box.bottom].every(n=>Number.isFinite(n)&&n>=0&&n<=1)
  && box.left<box.right && box.top<box.bottom;
}
function logDiscovery(failure,proposals,owners,hasAlignment,logger=console) {
 try {
  const validated=failure===undefined && Array.isArray(proposals);
  const candidates=validated?boundedDiscoveryItems(proposals):[];
  const status=validated?(candidates.length?"ok":"empty"):(DISCOVERY_FAILURES.has(failure)?failure:"failed");
  let generic=0,specific=0,localized=0,identityOnly=0;
  for(const candidate of candidates) {
   const label=candidate?.observedIdentity;
   if(typeof label==="string" && label.length<=128 && label.trim() && !/[\x00-\x1f<>]/.test(label)) {
    const key=label.trim().toLowerCase().replace(/[\s_-]+/g," ");
    const shapeOnly=key.replace(/\b(?:white|black|blue|green|red|yellow|brown|gray|grey|clear|small|large|round)\s+/g,"").trim();
    if(GENERIC_IDENTITIES.has(key)||GENERIC_IDENTITIES.has(shapeOnly))generic++;
    else specific++;
   }
   if(localizedDiscoveryBox(candidate?.boundingBox))localized++;
   else if(candidate && candidate.boundingBox===undefined && candidate.recognitionState==="identity_only")identityOnly++;
  }
  const items=boundedDiscoveryItems(owners);
  const vision=items.filter(item=>item?.analysisSource===VISION);
  const gemini=items.filter(item=>item?.analysisSource===GEMINI).length;
  const unknown=items.filter(item=>item?.category==="Unknown").length;
  // This proves alignment for a surviving owner, not how many proposals merged.
  const aligned=typeof hasAlignment==="function"?vision.filter(item=>hasAlignment(item)===true).length:0;
  const counts=[candidates.length,generic,specific,localized,identityOnly,items.length,vision.length,gemini,aligned,unknown];
  if(!counts.every(n=>Number.isSafeInteger(n)&&n>=0&&n<=8))return;
  logger.info(`[WasteScanDiscovery] status=${status} proposals=${candidates.length} generic=${generic} specific=${specific} localized=${localized} identity_only=${identityOnly} physical=${items.length} vision_owned=${vision.length} gemini_owned=${gemini} aligned_vision_owners=${aligned} final_unknown=${unknown}`);
 } catch (_) { /* A diagnostic failure cannot fail the scan. */ }
}
// Operational counters only: no capture IDs, usernames, images, original labels or secrets.
const STATUSES=new Set(["complete","unavailable","not_requested"]);
const CATEGORIES=new Set(["Biodegradable","Recyclable","Residual","Special Waste"]);
// Private per-capture gate counters, never serialized into Android's strict v1 sidecar.
// Counters may overlap: they describe failed gates, not exclusive object counts.
const REASONS=Object.freeze(["provider_insufficient","safety_veto","identity_conflict","category_contradiction",
 "primary_mismatch","generic_container","identity_unproven","classification_accepted",
 "primary_confidence_unproven","primary_identity_mismatch","primary_category_unproven",
 "request_rejected","ai_unavailable","ai_not_requested",
 "veto_observed_identity","veto_primary_hazard","veto_provider_evidence"]);
const privateReasons=new WeakMap();
function createAssessmentReasons() {return Object.fromEntries(REASONS.map(reason=>[reason,0]));}
function recordAssessmentReasons(result,counts) {
 const safe=createAssessmentReasons();
 for(const reason of REASONS)if(Number.isInteger(counts?.[reason])&&counts[reason]>=0&&counts[reason]<=8)safe[reason]=counts[reason];
 privateReasons.set(result,Object.freeze(safe));
 return result;
}
function assessmentReasonCounts(result) {
 const counts=result && privateReasons.get(result);
 return counts?{...counts}:null;
}
function summarizeAssessment(result,totalItems) {
 const total=Number.isInteger(totalItems)&&totalItems>=0&&totalItems<=8?totalItems:0;
 const items=Array.isArray(result?.items)?result.items.slice(0,total):[];
 const status=STATUSES.has(result?.aiStatus)?result.aiStatus:"unavailable";
 const classified=items.filter(item=>CATEGORIES.has(item?.category)).length;
 const aiAssisted=items.filter(item=>item?.assessmentSource==="ai_assisted").length;
 return {status,total,assessed:items.length,classified,unknown:total-classified,aiAssisted};
}
function logAssessment(result,totalItems,logger=console,physicalItems=[]) {
 const s=summarizeAssessment(result,totalItems);
 logger.info(`[WasteScanAssessment] status=${s.status} total=${s.total} assessed=${s.assessed} classified=${s.classified} unknown=${s.unknown} aiAssisted=${s.aiAssisted}`);
 if(physicalItems.length) {
  const items=physicalItems.slice(0,8),assessed=result?.items||[];
  const vision=items.filter(i=>i.analysisSource==="google_vision_object_localization").length;
  const gemini=items.filter(i=>i.analysisSource==="gemini_whole_image").length;
  const reviewed=assessed.filter(i=>i.assessmentSource==="reviewed_identity_rule").length;
  const existing=assessed.filter(i=>i.assessmentSource==="existing_category").length;
  logger.info(`[WasteScanStages] discovery=requested physical=${items.length} vision=${vision} gemini=${gemini} reviewed=${reviewed} existing=${existing} unknown_evidence=${s.unknown} ai_unavailable=${Number(s.status==="unavailable")}`);
 }
 const reasons=assessmentReasonCounts(result);
 if(reasons)logger.info(`[WasteScanReasons] ${REASONS.map(reason=>`${reason}=${reasons[reason]}`).join(" ")}`);
 return s;
}
// Optional classify-call object proposals: fixed vocabulary and bounded counts only.
// Never logs labels, coordinates, capture/request IDs, images, users or provider text.
const PROPOSAL_STATUSES=new Set(["accepted","absent","rejected","merge_failed","primary_unavailable","ineligible"]);
const PROPOSAL_INELIGIBLE=new Set(["capability_missing","discovery_mode","token_unconfigured","classifier_unconfigured",
 "classifier_insecure","image"]);
const PROPOSAL_LINKS=new Set(["linked","none","unresolved","ambiguous","identity_conflict","category_conflict",
 "safety_conflict","not_evaluated"]);
function logObjectProposals(summary,logger=console) {
 try {
  const status=PROPOSAL_STATUSES.has(summary?.status)?summary.status:"rejected";
  if(status==="ineligible") {
   logger.info(`[WasteScanProposals] status=ineligible reason=${PROPOSAL_INELIGIBLE.has(summary?.reason)?summary.reason:"other"}`);
   return;
  }
  if(status!=="accepted") {logger.info(`[WasteScanProposals] status=${status}`);return;}
  const counts=["proposals","localized","physical","visionOwned","geminiOwned","alignedVisionOwners","finalUnknown"]
   .map(key=>summary?.[key]);
  if(!counts.every(n=>Number.isSafeInteger(n)&&n>=0&&n<=8))return;
  const link=PROPOSAL_LINKS.has(summary?.primaryLink)?summary.primaryLink:"not_evaluated";
  logger.info(`[WasteScanProposals] status=accepted proposals=${counts[0]} localized=${counts[1]} physical=${counts[2]} vision_owned=${counts[3]} gemini_owned=${counts[4]} aligned_vision_owners=${counts[5]} final_unknown=${counts[6]} primary_link=${link}`);
 } catch (_) { /* A diagnostic failure cannot fail the scan. */ }
}
module.exports={summarizeAssessment,logAssessment,createAssessmentReasons,recordAssessmentReasons,assessmentReasonCounts,
 discoveryFailureStatus,logDiscovery,logObjectProposals};
