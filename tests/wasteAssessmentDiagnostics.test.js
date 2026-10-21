"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {summarizeAssessment,logAssessment}=require("../services/wasteAssessmentDiagnostics");
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
