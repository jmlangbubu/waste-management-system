"use strict";
// Operational counters only: no capture IDs, usernames, images, original labels or secrets.
const STATUSES=new Set(["complete","unavailable","not_requested"]);
const CATEGORIES=new Set(["Biodegradable","Recyclable","Residual","Special Waste"]);
function summarizeAssessment(result,totalItems) {
 const total=Number.isInteger(totalItems)&&totalItems>=0&&totalItems<=8?totalItems:0;
 const items=Array.isArray(result?.items)?result.items.slice(0,total):[];
 const status=STATUSES.has(result?.aiStatus)?result.aiStatus:"unavailable";
 const classified=items.filter(item=>CATEGORIES.has(item?.category)).length;
 const aiAssisted=items.filter(item=>item?.assessmentSource==="ai_assisted").length;
 return {status,total,assessed:items.length,classified,unknown:total-classified,aiAssisted};
}
function logAssessment(result,totalItems,logger=console) {
 const s=summarizeAssessment(result,totalItems);
 logger.info(`[WasteScanAssessment] status=${s.status} total=${s.total} assessed=${s.assessed} classified=${s.classified} unknown=${s.unknown} aiAssisted=${s.aiAssisted}`);
 return s;
}
module.exports={summarizeAssessment,logAssessment};
