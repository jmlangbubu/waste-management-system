"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {summarizeAssessment,logAssessment,createAssessmentReasons,recordAssessmentReasons,assessmentReasonCounts}=require("../services/wasteAssessmentDiagnostics");
test("diagnostics reflect completed but mostly Unknown assessment without leaking content",()=>{
 const sensitive="SECRET_IMAGE_BASE64_USERNAME_CAPTURE_ID";const emitted=[];
 const input={aiStatus:"complete",captureId:sensitive,items:[
  {itemId:sensitive,category:"Unknown",assessmentSource:"ai_assisted",guidance:{whatItIs:sensitive}},
  {itemName:sensitive,category:"Special Waste",assessmentSource:"existing_category"},
  {itemName:sensitive,category:"Unknown",assessmentSource:"ai_assisted"}
 ]};
 const out=logAssessment(input,3,{info:m=>emitted.push(m)});
 assert.deepEqual(out,{status:"complete",total:3,assessed:3,classified:1,unknown:2,aiAssisted:2});
 assert.equal(emitted.length,1);assert.match(emitted[0],/status=complete.*unknown=2.*aiAssisted=2/);
 assert.ok(!emitted[0].includes(sensitive));
});
test("disabled/not requested and missing assessment remain diagnostically distinct",()=>{
 assert.deepEqual(summarizeAssessment({aiStatus:"not_requested",items:[{category:"Unknown"}]},1),
  {status:"not_requested",total:1,assessed:1,classified:0,unknown:1,aiAssisted:0});
 assert.deepEqual(summarizeAssessment(null,4),
  {status:"unavailable",total:4,assessed:0,classified:0,unknown:4,aiAssisted:0});
 assert.equal(summarizeAssessment({aiStatus:"arbitrary secret",items:[{category:"fake"}]},1).status,"unavailable");
});
test("pipeline diagnostics emit aggregate provider/source counters only",()=>{
 const emitted=[],secret="PRIVATE_LABEL_CAPTURE_TOKEN";
 logAssessment({aiStatus:"complete",items:[{category:"Special Waste",assessmentSource:"ai_assisted",itemId:secret}]},1,
  {info:line=>emitted.push(line)},[{analysisSource:"google_vision_object_localization",itemName:secret,boundingBox:{secret}}]);
 assert.equal(emitted.length,2);assert.match(emitted[1],/physical=1 vision=1 gemini=0/);
 assert.match(emitted[1],/unknown_evidence=0 ai_unavailable=0/);
 assert.doesNotMatch(emitted.join(""),/PRIVATE|boundingBox|itemId/);
});

test("rejection counters are private, allowlisted, bounded, immutable to readers and contain no dynamic text",()=>{
 const secret="PRIVATE_CAPTURE_IMAGE_LABEL_USERNAME_TOKEN",result={schemaVersion:1,captureId:secret,aiStatus:"complete",items:[]};
 const before=JSON.stringify(result),counts={...createAssessmentReasons(),provider_insufficient:2,safety_veto:1,
  classification_accepted:3,identity_unproven:secret,generic_container:-1,primary_mismatch:99,[secret]:8};
 recordAssessmentReasons(result,counts);
 const got=assessmentReasonCounts(result);assert.equal(got.provider_insufficient,2);assert.equal(got.safety_veto,1);
 assert.equal(got.classification_accepted,3);assert.equal(got.identity_unproven,0);assert.equal(got.generic_container,0);
 assert.equal(got.primary_mismatch,0);assert.equal(JSON.stringify(got).includes(secret),false);
 got.provider_insufficient=7;assert.equal(assessmentReasonCounts(result).provider_insufficient,2);
 assert.equal(JSON.stringify(result),before);
 const emitted=[];logAssessment(result,5,{info:line=>emitted.push(line)});
 const reason=emitted.find(line=>line.startsWith("[WasteScanReasons]"));
 assert.match(reason,/provider_insufficient=2/);assert.match(reason,/classification_accepted=3/);
 assert.doesNotMatch(emitted.join(""),/PRIVATE|captureId|itemId|image|username|token/i);
});

test("absent private reasons do not manufacture a rejection or leak response fields",()=>{
 assert.equal(assessmentReasonCounts(null),null);assert.equal(assessmentReasonCounts({}),null);
 const output=[];logAssessment({captureId:"SECRET",aiStatus:"unavailable"},1,{info:line=>output.push(line)});
 assert.equal(output.length,1);assert.equal(output[0].includes("SECRET"),false);
});
