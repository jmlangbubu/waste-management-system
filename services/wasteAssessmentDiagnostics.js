"use strict";
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
module.exports={summarizeAssessment,logAssessment,createAssessmentReasons,recordAssessmentReasons,assessmentReasonCounts};
