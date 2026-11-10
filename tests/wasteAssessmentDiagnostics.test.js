"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {summarizeAssessment,logAssessment,createAssessmentReasons,recordAssessmentReasons,assessmentReasonCounts}=require("../services/wasteAssessmentDiagnostics");
const {logDiscovery,discoveryFailureStatus}=require("../services/wasteAssessmentDiagnostics");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const {createRequire}=require("node:module"),{EventEmitter}=require("node:events");
const shared=require("../gemini-waste-classifier-cloudrun/cropRecognition");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
const discovery=require("../services/wholeImageRecognitionService");
const {createAssessmentService}=require("../services/perItemWasteAssessmentService");
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

const analysisPath=path.join(__dirname,"../services/wasteAnalysisService.js");
const current=fs.readFileSync(analysisPath,"utf8"),load=createRequire(analysisPath);
const previous=process.env.WMO_DISCOVERY_BASELINE
 ? fs.readFileSync(process.env.WMO_DISCOVERY_BASELINE,"utf8") : null;
const privateText="PRIVATE_LABEL_TOKEN https://synthetic.invalid/image\n[Injected] secret";
const box=[100,100,400,400];
const wrapper="Discarded Instant Noodle Package";
const failure=code=>new shared.RecognitionError(code,503);

async function scan(source,{objects=[],mode="ok",assessment=true,sinkFails=false}={}) {
 const calls={primary:0,vision:0,discovery:0,assessment:0},logs=[];
 const controller=new AbortController();
 const image=Buffer.from("ffd8ffc0000b080190025801011100ffd9","hex").toString("base64");
 const capture={requestId:"11111111-1111-4111-8111-111111111111",captureId:"22222222-2222-4222-8222-222222222222",
  width:mode==="rejected"?0:600,height:400,orientation:"upright"};
 const env={WHOLE_IMAGE_DISCOVERY_ENABLED:mode==="disabled"?"false":"true",
  GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste",
  WHOLE_IMAGE_DISCOVERY_SHARED_TOKEN:"synthetic-discovery-token-over-32-characters",
  WASTE_ITEM_ASSESSMENT_ENABLED:assessment?"true":"false",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"true",
  WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"synthetic-assessment-token-over-32-characters"};
 let release;
 const gated=new Promise(resolve=>{release=resolve;});
 const discoverObjects=discovery.createDiscoveryService({env,transport:async(_url,input,options)=>{
  calls.discovery++;
  assert.equal(options.signal,controller.signal);
  await gated;
  if(mode==="cancelled"){controller.abort();throw failure("RECOGNITION_CANCELLED");}
  if(mode==="timeout")throw failure("RECOGNITION_TIMEOUT");
  if(mode==="unavailable")throw failure("RECOGNITION_UNAVAILABLE");
  if(mode==="failed")throw Object.assign(new Error(privateText),{code:"INVALID_PROVIDER_RESPONSE"});
  const result=whole.normalize(input,{objects});
  return mode==="invalid_response"?{...result,requestId:"stale"}:result;
 }});
 const assessCapture=createAssessmentService({env:{...env,CLOUD_RUN_AUTH_MODE:"iam",CLOUD_RUN_AUDIENCE:"https://synthetic.invalid"},
  authHeaders:async()=>({}),transport:async(_url,body)=>{
  calls.assessment++;
  return {schemaVersion:1,requestId:body.requestId,captureId:body.captureId,
   assessments:body.items.map(item=>({itemId:item.itemId,category:"Unknown",kind:"unknown",
    material:"unknown",condition:"unknown",evidence:"insufficient"}))};
 }});
 const logger={log(){},warn(){},error(){},info(line){if(sinkFails)throw Error(privateText);logs.push(line);}};
 const transport={request(_options,callback){
  const req=new EventEmitter();
  req.write=()=>{};
  req.destroy=error=>req.emit("error",error);
  req.end=()=>{
   calls.primary++;
   const res=new EventEmitter();res.statusCode=200;callback(res);
   res.emit("data",JSON.stringify({success:true,source:"fixture",result:{itemName:"Bottle",category:"Recyclable",confidence:.9}}));
   res.emit("end");
  };
  return req;
 }};
 const module={exports:{}};
 vm.runInNewContext(source,{module,Buffer,URL,setTimeout,clearTimeout,AbortController,console:logger,process:{env},require(id){
  if(id==="http"||id==="https")return transport;
  if(id==="./wholeImageRecognitionService")return {...discovery,discoverObjects};
  if(id==="./perItemWasteAssessmentService")return {assessCapture};
  if(id==="./wasteAssessmentDiagnostics")return {...load(id),
   logAssessment:(result,total,_logger,owners)=>logAssessment(result,total,logger,owners)};
  if(id==="./googleVisionService")return {...load(id),async detectObjectsFromBase64(){
   calls.vision++;return [{name:"Item",confidence:.8,boundingBox:{top:.1,left:.1,bottom:.4,right:.4}}];
  }};
  if(id==="./geminiWasteClassifierService")return {};
  return load(id);
 }},{filename:analysisPath});
 const result=module.exports.analyzeWaste({image,objectDiscovery:capture,principal:42,signal:controller.signal,independentCategoryV2:true});
 await new Promise(resolve=>setImmediate(resolve));
 // Legacy primary and Vision must start while discovery transport is gated.
 assert.equal(calls.primary,1);assert.equal(calls.vision,1);
 assert.equal(calls.discovery,["disabled","rejected"].includes(mode)?0:1);
 release();
 const response=JSON.stringify(await result);
 return {response,calls,logs};
}

const discoveryLine=/^\[WasteScanDiscovery\] status=(?:ok|empty|invalid_response|timeout|cancelled|unavailable|rejected|failed)(?: (?:proposals|generic|specific|localized|identity_only|physical|vision_owned|gemini_owned|aligned_vision_owners|final_unknown)=[0-8]){10}$/;
for(const [name,options,expected] of [
 ["empty without assessment",{assessment:false},"status=empty proposals=0 generic=0 specific=0 localized=0 identity_only=0 physical=1 vision_owned=1 gemini_owned=0 aligned_vision_owners=0 final_unknown=1"],
 ["generic objects",{objects:[{label:"Item",box_2d:box},{label:"Object",box_2d:[500,500,700,700]}]},"status=ok proposals=2 generic=2 specific=0 localized=2 identity_only=0"],
 ["identity only",{objects:[{label:wrapper}]},"status=ok proposals=1 generic=0 specific=1 localized=0 identity_only=1 physical=1 vision_owned=1 gemini_owned=0 aligned_vision_owners=0 final_unknown=1"],
 ["localized Vision alignment",{objects:[{label:wrapper,box_2d:box}]},"status=ok proposals=1 generic=0 specific=1 localized=1 identity_only=0 physical=1 vision_owned=1 gemini_owned=0 aligned_vision_owners=1 final_unknown=0"],
 ["mixed localized identities",{objects:[{label:wrapper,box_2d:box},{label:"Battery",box_2d:[500,500,600,600]},{label:"Banana Peel",box_2d:[700,700,900,900]}]},"status=ok proposals=3 generic=0 specific=3 localized=3 identity_only=0 physical=3 vision_owned=1 gemini_owned=2 aligned_vision_owners=1 final_unknown=0"],
 ["rejected before transport",{mode:"rejected"},"status=rejected proposals=0"],
 ["transport timeout",{mode:"timeout"},"status=timeout proposals=0"],
 ["transport unavailable",{mode:"unavailable"},"status=unavailable proposals=0"],
 ["invalid response from transport",{mode:"invalid_response"},"status=invalid_response proposals=0"],
 ["cancellation",{mode:"cancelled"},"status=cancelled proposals=0"],
 ["untyped failure with private error text",{mode:"failed"},"status=failed proposals=0"]
])test(`discovery diagnostics: ${name}`,async()=>{
 const actual=await scan(current,options),lines=actual.logs.filter(line=>line.startsWith("[WasteScanDiscovery]"));
 if(name==="identity only")assert.equal(actual.calls.assessment,1);
 assert.equal(lines.length,1);assert.match(lines[0],discoveryLine);assert.ok(lines[0].includes(expected),lines[0]);
 assert.doesNotMatch(lines[0],/PRIVATE|synthetic|discarded|Battery|11111111|22222222/i);
 assert.doesNotMatch(actual.response,/WasteScanDiscovery|aligned_vision_owners/);
 if(previous){
  const before=await scan(previous,options);
  assert.equal(actual.response,before.response);assert.deepEqual(actual.calls,before.calls);
  assert.deepEqual(actual.logs.filter(line=>!line.startsWith("[WasteScanDiscovery]")),before.logs);
 }
});

test("disabled discovery emits no outcome and a failing diagnostic sink preserves the result and calls",async()=>{
 const disabled=await scan(current,{mode:"disabled",assessment:false});
 assert.equal(disabled.logs.length,0);
 const options={objects:[{label:wrapper,box_2d:box}]};
 const normal=await scan(current,options),broken=await scan(current,{...options,sinkFails:true});
 assert.equal(broken.response,normal.response);assert.deepEqual(broken.calls,normal.calls);
 if(previous){
  const before=await scan(previous,{mode:"disabled",assessment:false});
  assert.equal(disabled.response,before.response);assert.deepEqual(disabled.calls,before.calls);
 }
});

test("discovery counters bound malformed inputs and never echo text, field names or coordinates",()=>{
 const logs=[],sink={info:line=>logs.push(line)};
 logDiscovery(privateText,[{observedIdentity:privateText}],"invalid",()=>8,sink);
 logDiscovery(undefined,Array(100).fill({observedIdentity:privateText,boundingBox:{left:-1}}),
  Array(100).fill({analysisSource:"google_vision_object_localization",category:"Unknown",itemId:privateText}),
  ()=>-1,sink);
 assert.equal(logs.length,2);logs.forEach(line=>assert.match(line,discoveryLine));
 assert.match(logs[0],/status=failed proposals=0/);
 assert.match(logs[1],/proposals=8 generic=0 specific=0 localized=0 identity_only=0 physical=8 vision_owned=8/);
 assert.match(logs[1],/aligned_vision_owners=0 final_unknown=8/);
 assert.doesNotMatch(logs.join(""),/PRIVATE|Injected|https:|itemId|left/);
 assert.equal(discoveryFailureStatus({code:"INVALID_PROVIDER_RESPONSE",message:privateText}),"failed");
});
