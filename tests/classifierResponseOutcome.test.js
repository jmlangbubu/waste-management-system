"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),{EventEmitter}=require("node:events");
const source=path.join(__dirname,"../services/wasteAnalysisService.js"),localRequire=require("node:module").createRequire(source);
const secret="PRIVATE_IMAGE_LABEL_CAPTURE_ITEM_USERNAME_TOKEN_PROVIDER_BODY";
async function run(response,{status=200,network=false,timeout=false,authError}={}) {
 const logs=[],calls={http:0,vision:0,local:0},module={exports:{}};
 const transport={request(options,callback){
  calls.http++;const req=new EventEmitter();req.write=()=>{};req.destroy=error=>req.emit("error",error);
  req.end=()=>{
   if(timeout)return req.emit("timeout");
   if(network)return req.emit("error",Error(secret));
   const res=new EventEmitter();res.statusCode=status;callback(res);res.emit("data",JSON.stringify(response));res.emit("end");
  };return req;
 }};
 vm.runInNewContext(fs.readFileSync(source,"utf8"),{module,Buffer,URL,Date,setTimeout,clearTimeout,
  process:{env:{CLOUD_RUN_AUTH_MODE:"iam",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste"}},
  console:Object.fromEntries(["log","warn","error"].map(name=>[name,(...args)=>logs.push(args)])),
  require(id){
   if(id==="http"||id==="https")return transport;
   if(id==="./cloudRunAuth")return {invocationHeaders:async()=>{if(authError)throw authError;return {Authorization:`Bearer ${secret}`};}};
   if(id==="./googleVisionService")return {detectObjectsFromBase64:async()=>{calls.vision++;return [];},
    normalizeBoundingBox:localRequire(id).normalizeBoundingBox,OBJECT_LOCALIZATION_TIMEOUT_MS:5000};
   if(id==="./geminiWasteClassifierService")return {classifyWasteWithGemini:async()=>{calls.local++;throw Error(secret);}};
   return localRequire(id);
  }
 });
 const result=await module.exports.analyzeWaste({image:secret,detectedObject:"captured_waste_item",mlKitLabels:[]});
 return {logs,calls,result};
}
test("only an explicit false/null unsuccessful envelope gets the upstream-unsuccessful code",async()=>{
 for(const response of [{success:false,message:secret,rawText:secret,result:null},
  {success:false,result:[]},{success:false,result:secret},{success:false,result:{}},{success:false},
  {success:true},{success:true,result:null,message:secret},{success:true,result:secret},{success:true,result:[]},
  {success:true,result:{}},{success:true,result:{category:"not_a_category"}},
  {success:true,result:{category:null}},{success:true,result:{category:42}},{success:true,result:{category:{}}},
  {success:secret,result:{itemName:secret}},{success:1,result:{category:"Recyclable"}},null,[],{}]) {
  const {logs,calls,result}=await run(response),diagnostic=logs.find(args=>args[0]==="[WasteAnalysis] classifier failure")[1];
  assert.deepEqual(diagnostic,response?.success===false&&response.result===null
   ?{stage:"classifier_upstream_unsuccessful",code:"CLASSIFIER_UPSTREAM_UNSUCCESSFUL"}
   :{stage:"classifier_response_validation",code:"CLASSIFIER_RESPONSE_INVALID"});
  assert.equal(result.category,"Residual");assert.equal(result.analysisSource,"fallback_no_ai_result");
  assert.deepEqual(calls,{http:1,vision:1,local:0});assert.doesNotMatch(JSON.stringify(logs),/PRIVATE_|Bearer|synthetic\.invalid/);
  assert.equal(typeof logs.find(args=>args[0]==="[WasteAnalysis] External classifier response success:")[1],"boolean");
 }
});
test("successful original classifier result and primary details remain unchanged",async()=>{
 const original={itemName:"Plastic Bottle",category:"Recyclable",confidence:.93,explanation:"Original explanation",action:"Original action",warning:"Original warning"};
 const {result,logs,calls}=await run({success:true,result:original,source:"cloud_run_gemini_vision"});
 for(const key of ["itemName","category","explanation","action","warning"])assert.equal(result[key],original[key]);
 assert.equal(result.analysisSource,"cloud_run_gemini_vision");assert.equal(logs.some(args=>args[0]==="[WasteAnalysis] classifier failure"),false);
 assert.deepEqual(calls,{http:1,vision:1,local:0});
});

test("supported legacy category normalization is reused without replacing valid primary details",async()=>{
 for(const [category,normalized] of [["Recyclable","Recyclable"],["organic","Biodegradable"],["electronic","Special Waste"],["general waste","Residual"]]) {
  const original={category,itemName:"Original object",confidence:.91,explanation:"Original explanation",action:"Original action",warning:"Original warning"};
  const {result,logs,calls}=await run({success:true,result:original});
  assert.equal(result.category,normalized);assert.equal(result.aiConfidence,String(original.confidence));
  for(const key of ["itemName","explanation","action","warning"])assert.equal(result[key],original[key]);
  assert.equal(logs.some(args=>args[0]==="[WasteAnalysis] classifier failure"),false);
  assert.deepEqual(calls,{http:1,vision:1,local:0});
 }
});

test("unusable primary diagnoses invalid response but preserves valid independent detectedItems/items",async()=>{
 const boxes=[{left:.1,top:.1,right:.3,bottom:.8},{left:.6,top:.1,right:.8,bottom:.8}];
 const items=[{itemName:"Plastic Bottle",category:"Recyclable",confidence:.92,boundingBox:boxes[0]},
  {itemName:"Snack wrapper",category:"Residual",confidence:.87,boundingBox:boxes[1]}];
 for(const field of ["detectedItems","items"])for(const primary of [{},{category:"not_a_category"}]) {
  const input={success:true,result:{...primary,[field]:items}},saved=structuredClone(input);
  const {result,logs,calls}=await run(input);
  assert.deepEqual(input,saved);assert.equal(result.detectedItems.length,2);assert.equal(result.scanSummary.totalItems,2);
  assert.equal(result.category,"Recyclable");assert.equal(result.itemName,"Plastic Bottle");
  assert.deepEqual(Array.from(result.detectedItems,item=>item.itemId),["item_1","item_2"]);
  assert.deepEqual(Array.from(result.detectedItems,item=>item.category),["Recyclable","Residual"]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.detectedItems.map(item=>item.boundingBox))),boxes);
  const errors=logs.filter(args=>args[0]==="[WasteAnalysis] classifier failure");assert.equal(errors.length,1);
  assert.deepEqual(errors[0][1],{stage:"classifier_response_validation",code:"CLASSIFIER_RESPONSE_INVALID"});
  assert.deepEqual(calls,{http:1,vision:0,local:0});
 }
});

test("HTTP, transport, IAM and timeout failures retain distinct fixed diagnostics without payloads or retries",async()=>{
 const diagnostics=localRequire("./cloudRunDiagnostics");
 const authError=diagnostics.mark(Error(secret),"token_signing_or_oauth");
 for(const [options,stage,code,http] of [
  [{status:403},"classifier_http_response","CLASSIFIER_HTTP_ERROR",1],
  [{network:true},"classifier_network_transport","CLASSIFIER_NETWORK_ERROR",1],
  [{authError},"token_signing_or_oauth","CLOUD_RUN_AUTH_TOKEN_ACQUISITION_FAILED",0],
  [{timeout:true},"timeout","CLOUD_RUN_REQUEST_TIMEOUT",1]
 ]) {
  const {result,logs,calls}=await run({success:false,result:null,message:secret},options);
  const errors=logs.filter(args=>args[0]==="[WasteAnalysis] classifier failure");assert.equal(errors.length,1);
  assert.deepEqual(errors[0][1],{stage,code,...(options.status?{status:options.status}:{})});
  assert.equal(result.category,"Residual");assert.equal(result.analysisSource,"fallback_no_ai_result");
  assert.deepEqual(calls,{http,vision:1,local:0});assert.doesNotMatch(JSON.stringify(logs),/PRIVATE_|Bearer|synthetic\.invalid/);
 }
});
