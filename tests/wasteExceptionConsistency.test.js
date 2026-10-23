"use strict";
// Offline only: real production functions, synthetic evidence, no external writes.
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),
 path=require("node:path"),vm=require("node:vm"),crypto=require("node:crypto"),{createRequire}=require("node:module"),{EventEmitter}=require("node:events");
const {createAssessmentService,deterministic}=require("../services/perItemWasteAssessmentService");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
const privateText="PRIVATE_FAULT_TOKEN_IMAGE_PROVIDER_RESPONSE";
function existingFixtures() {
 const f=path.join(__dirname,"wastePrimaryReconciliation.test.js"),s=fs.readFileSync(f,"utf8"),m={exports:{}};
 vm.runInNewContext(s.slice(0,s.indexOf('test("full bottle'))+"\nmodule.exports={fixture,localized,box,far};",
  {module:m,require:createRequire(f),__dirname,Buffer,URL,AbortController,setTimeout,clearTimeout});return m.exports;
}
const {fixture,localized,box,far}=existingFixtures();
function androidValidator() {
 const f=path.join(__dirname,"wasteDisplayNames.test.js"),s=fs.readFileSync(f,"utf8"),m={exports:{}};
 vm.runInNewContext(s.slice(0,s.indexOf("for(const [raw,display]"))+"\nmodule.exports={v5RawOwner,v5SidecarAccepted};",
  {module:m,require:createRequire(f)});return m.exports;
}
const v7=androidValidator(); // Matches the reconciled owner/sidecar rules; not an installed APK test.
function routeHarness({analyze,insertFail=false,body={image:"c3ludGhldGlj"},fatal=false,
 cancelled=false,alreadySent=false,closeAtInsert=false,deferColumns=false}={}) {
 const chains={},writes={images:0,inserts:0,service:0},logs=[],m={exports:{}},req=new EventEmitter(),res=new EventEmitter();
 req.body=body;req.aborted=cancelled;res.headersSent=alreadySent;res.statusCode=200;res.responses=[];
 res.status=function(code){this.statusCode=code;return this;};res.json=function(value){assert.equal(this.responses.length,0,"No double response");this.responses.push(JSON.parse(JSON.stringify(value)));this.headersSent=true;this.writableEnded=true;this.emit("finish");return this;};
 if(fatal)Object.defineProperty(req,"body",{get(){throw Error(privateText);}});
 const router=Object.fromEntries(["get","post","patch","delete"].map(method=>[method,(url,...chain)=>{chains[method+" "+url]=chain;}]));
 let columnReads=0,pendingColumn;
 const columns=["image_url","analysis_source","ai_label","ai_confidence"].map(Field=>({Field}));
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../routes/wasteRoutes.js"),"utf8"),{
  module:m,__dirname:path.join(__dirname,"../routes"),Buffer,AbortController,process:{env:{}},
  console:Object.fromEntries(["log","warn","error"].map(k=>[k,(...args)=>logs.push(args)])),require(id){
   if(id==="express")return {Router:()=>router};if(id==="path")return path;if(id==="qrcode")return {};
   if(id==="fs")return {existsSync:()=>true,writeFileSync(){writes.images++;},mkdirSync(){throw Error("Unexpected directory");}};
   if(id==="../config/db")return {queryReadOnly(sql,cb){assert.match(sql,/SHOW COLUMNS FROM scan_history/);
    if(deferColumns&&++columnReads>1){pendingColumn=()=>cb(null,columns);return;}cb(null,columns);},query(sql,values,cb){
     assert.match(sql,/INSERT INTO scan_history/);writes.inserts++;if(closeAtInsert)res.emit("close");cb(insertFail?{message:privateText}:null,{insertId:19});}};
   if(id==="../services/wasteAnalysisService")return {async analyzeWaste(input){writes.service++;return analyze(input,req,res);},
    buildScanSummary:require("../services/wasteAnalysisService").buildScanSummary};
   if(id.includes("Controller"))return new Proxy({},{get:()=>()=>{}});
   if(id==="../middleware/mobileSessionAuth")return {requireMobileSession(){throw Error("Auth must not be bypassed by opted-in callers");}};
   if(id==="../middleware/webSessionAuth")return {requireWebCapability:()=>()=>{},requireCsrf(){}};
   if(id==="../gemini-waste-classifier-cloudrun/cropRecognition")return require(id);
   throw Error("Unexpected dependency: "+id);
  }
 });
 const chain=chains["post /analyze"];
 return {req,res,writes,logs,run:async()=>{for(const handler of chain){let next=false;await handler(req,res,()=>{next=true;});if(!next)break;}},releaseColumns:()=>pendingColumn?.()};
}
const message="Waste analysis could not be completed. Please scan again or ask WMO to confirm the item.";
function failed(h,status=503) {
 assert.equal(h.res.statusCode,status);assert.deepEqual(h.res.responses,[{success:false,message:status===400?"Image is required":message}]);
 assert.equal(h.writes.images,0);assert.equal(h.writes.inserts,0);
 assert.doesNotMatch(JSON.stringify(h.logs),/PRIVATE_FAULT|Error:|\bat .*\.js/);
}
for(const objects of [[],[localized("Unidentified object")],[localized("Unidentified object"),localized("Unidentified packet",.9,far)]])
 test(`Unknown primary returns legacy-safe 503 before persistence: owners=${objects.length}`,async()=>{
  const f=fixture({objects}),r=JSON.parse(JSON.stringify(await f.run())),snapshot=structuredClone(r);
  assert.equal(r.category,"Unknown");let signal;
  const h=routeHarness({analyze:async input=>{signal=input.signal;return r;}});await h.run();failed(h);
  assert.equal(h.writes.service,1);assert.equal(signal.aborted,true);assert.deepEqual(r,snapshot);
 });

test("a classified sidecar cannot promote an Unknown primary through the legacy response guard",async()=>{
 const f=fixture({objects:[localized("Unclassified household container")],ai:true,
  facts:{category:"Special Waste",kind:"electrical",material:"mixed",condition:"unknown",evidence:"visible"}});
 const r=JSON.parse(JSON.stringify(await f.run())),snapshot=structuredClone(r);
 assert.equal(r.category,"Unknown");assert.equal(r.categoryAssessments.items[0].category,"Special Waste");
 const h=routeHarness({analyze:async()=>r});await h.run();failed(h);assert.deepEqual(r,snapshot);assert.equal(f.calls.assessment,1);
});
test("service exception returns controlled 503 without classification, image/history writes or private errors",async()=>{
 let signal;
 const h=routeHarness({body:{image:"c3ludGhldGlj",detectedObject:privateText,mlKitLabels:[privateText]},analyze:async input=>{signal=input.signal;throw Error(privateText);}});
 await h.run();failed(h);assert.equal(h.writes.service,1);assert.equal(signal.aborted,true);
});
test("fatal route exception returns the same safe error without fabricated success",async()=>{
 const h=routeHarness({fatal:true,analyze:async()=>assert.fail("No service call")});await h.run();failed(h);assert.equal(h.writes.service,0);
});
for(const result of [null,[],{},false,{category:"Future Category"},{success:false,category:"Residual"}])
 test(`invalid service result fails closed: ${JSON.stringify(result)}`,async()=>{const h=routeHarness({analyze:async()=>result});await h.run();failed(h);});
for(const body of [undefined,null,{},[],{image:42},{image:" "}])
 test(`malformed request returns 400 without recognition: ${JSON.stringify(body)}`,async()=>{
  const h=routeHarness({body:body===undefined?{}:body,analyze:async()=>assert.fail("No inference")});await h.run();failed(h,400);assert.equal(h.writes.service,0);
 });
test("already-aborted and already-responded requests do not analyze or respond again",async()=>{
 for(const options of [{cancelled:true},{alreadySent:true}]){const h=routeHarness({...options,analyze:async()=>assert.fail("No inference")});await h.run();
  assert.equal(h.res.responses.length,0);assert.equal(h.writes.service,0);assert.equal(h.writes.images,0);assert.equal(h.writes.inserts,0);}
});
test("abort during analysis prevents image/history writes and any response",async()=>{
 const h=routeHarness({analyze:async(input,req)=>{req.emit("aborted");throw Error(privateText);}});await h.run();
 assert.equal(h.res.responses.length,0);assert.equal(h.writes.images,0);assert.equal(h.writes.inserts,0);
});
test("disconnect while awaiting valid analysis prevents success and image/history writes",async()=>{
 const f=fixture({objects:[localized("Battery")]}),r=await f.run(),h=routeHarness({analyze:async(input,req,res)=>{res.emit("close");return r;}});
 await h.run();assert.equal(h.res.responses.length,0);assert.equal(h.writes.images,0);assert.equal(h.writes.inserts,0);
});
test("disconnect before history insertion stops the write; completed valid analysis is not reclassified",async()=>{
 const f=fixture({objects:[localized("Battery")]}),r=await f.run(),h=routeHarness({deferColumns:true,analyze:async()=>r});
 await h.run();h.res.emit("close");h.releaseColumns();assert.equal(h.writes.inserts,0);assert.equal(h.res.responses.length,0);
});
test("disconnect after a valid insertion begins does not send a second or late response",async()=>{
 const f=fixture({objects:[localized("Battery")]}),r=await f.run(),h=routeHarness({closeAtInsert:true,analyze:async()=>r});
 await h.run();assert.equal(h.writes.inserts,1);assert.equal(h.res.responses.length,0);
});
for(const insertFail of [false,true])test(`valid processing remains successful with DB failure=${insertFail}`,async()=>{
 for(const objects of [[localized("Empty plastic water bottle")],[localized("Empty plastic water bottle"),localized("Battery",.9,far)],[localized("Battery")]]){
  const f=fixture({objects}),r=JSON.parse(JSON.stringify(await f.run())),h=routeHarness({insertFail,analyze:async()=>r});await h.run();
  assert.equal(h.res.statusCode,200);const response=h.res.responses[0];assert.equal(response.success,true);
  assert.equal(response.result.category,r.category);assert.equal(response.result.id,insertFail?0:19);
  assert.equal(response.result.analysisSource,r.analysisSource+(insertFail?"_db_save_failed":""));
  assert.deepEqual(response.detectedItems,r.detectedItems);assert.deepEqual(response.categoryAssessments,r.categoryAssessments);
  assert.equal(h.writes.images,1);assert.equal(h.writes.inserts,1);assert.doesNotMatch(JSON.stringify(h.logs),/PRIVATE_FAULT/);
 }
});

test("mixed known/Unknown owners fail before persistence without dropping or relabeling objects",async()=>{
 for(const objects of [[localized("Battery"),localized("Unidentified bottle",.9,far)],
  [localized("Empty plastic water bottle"),localized("Unidentified packet",.9,far)]]){
  const f=fixture({objects}),r=JSON.parse(JSON.stringify(await f.run())),saved=structuredClone(r);
  assert.notEqual(r.category,"Unknown");assert.ok(r.detectedItems.some(item=>item.category==="Unknown"));
  const h=routeHarness({analyze:async()=>r});await h.run();failed(h);assert.deepEqual(r,saved);
 }
});

test("Unknown optional suggestion cannot enter legacy secondary-item navigation",async()=>{
 const f=fixture({objects:[localized("Battery")]}),r=JSON.parse(JSON.stringify(await f.run()));
 r.categoryAssessments.items[0].category="Unknown";
 const h=routeHarness({analyze:async()=>r});await h.run();failed(h);
});
test("genuine independent Residual remains successful with original guidance",async()=>{
 const f=fixture({primary:{itemName:"Empty snack wrapper",category:"Residual",confidence:.9,action:"Supported original guidance"}}),r=await f.run();
 const h=routeHarness({analyze:async()=>r});await h.run();assert.equal(h.res.responses[0].result.category,"Residual");assert.equal(h.res.responses[0].result.action,"Supported original guidance");
});
for(const ai of [false,true])for(const source of ["gemini_whole_image","google_vision_object_localization"])
 test(`raw unsafe known owner rejects optional assessment without mutation: ${source}, AI=${ai}`,async()=>{
  const c={captureId:crypto.randomUUID(),requestId:crypto.randomUUID()},owner=whole.normalize(c,{objects:[{label:"Plastic Bottle",box_2d:[100,100,500,300]}]}).objects[0];
  owner.observedIdentity="Full Plastic Bottle";
  if(source!=="gemini_whole_image")Object.assign(owner,{analysisSource:source,confidence:.9});
  const saved=structuredClone(owner);let calls=0;
  const assess=createAssessmentService({env:{WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:String(ai)},transport:async()=>{calls++;throw Error("No paid call");}});
  assert.throws(()=>deterministic([owner],c.captureId),e=>e.code==="INVALID_RECOGNITION_REQUEST");
  await assert.rejects(assess({capture:c,items:[owner],principal:42}),e=>e.code==="INVALID_RECOGNITION_REQUEST");assert.deepEqual(owner,saved);assert.equal(calls,0);
 });
test("supported established owner is not contradicted by optional provider uncertainty",async()=>{
 for(const name of ["Empty Plastic Bottle","Used Battery","Banana Peel"]){
  const c={captureId:crypto.randomUUID(),requestId:crypto.randomUUID()},owners=whole.normalize(c,{objects:[{label:name,box_2d:[100,100,500,300]}]}).objects;
  const saved=structuredClone(owners);let calls=0;
  const assess=createAssessmentService({env:{WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"true"},transport:async()=>{calls++;return {};}});
  const sidecar=await assess({capture:c,items:owners,principal:42});assert.equal(sidecar.items[0].category,owners[0].category);
  assert.equal(sidecar.items[0].assessmentSource,"reviewed_identity_rule");assert.deepEqual(owners,saved);assert.equal(calls,0);
  assert.equal(v7.v5SidecarAccepted({detectedItems:owners,categoryAssessments:sidecar},c.captureId),true);
 }
});
for(const ai of [false,true])for(const mode of ["vision","gemini"])
 test(`real final pipeline has consistent v7 owners and suggestions: ${mode}, AI=${ai}`,async()=>{
  for(const [label,expected]of [["Full Plastic Bottle","Unknown"],["Snack Sachet","Residual"],["Unopened Snack Packet","Unknown"],
   ["Empty plastic water bottle","Recyclable"],["Empty snack wrapper","Residual"],["Banana Peel","Biodegradable"],
   ["Paint Can","Special Waste"],["Syringe","Special Waste"],["Charger","Special Waste"]]){
   const f=fixture({objects:mode==="vision"?[localized(label)]:[],labels:mode==="gemini"?[[label]]:[],ai}),r=JSON.parse(JSON.stringify(await f.run()));
   assert.ok(r.detectedItems.every(v7.v5RawOwner),label);assert.equal(v7.v5SidecarAccepted(r,f.c.captureId),true,label);
   assert.equal(r.categoryAssessments.items[0].category,expected,label);assert.equal(r.categoryAssessments.items[0].requiresConfirmation,true);
   const owner=r.detectedItems[0];assert.equal(owner.analysisSource,mode==="vision"?"google_vision_object_localization":"gemini_whole_image");assert.deepEqual(owner.boundingBox,JSON.parse(JSON.stringify(box)));
   assert.equal(r.categoryAssessments.items[0].itemId,owner.itemId);assert.equal(r.categoryAssessments.captureId,f.c.captureId);
   if(owner.category!=="Unknown")assert.equal(owner.category,expected);else assert.ok(!owner.modelKey&&!owner.modelHotspots?.length);
   assert.ok(f.calls.assessment<=1);if(mode==="vision")assert.equal(owner.confidence,.95);
  }
 });
test("approved wrapper mapping still makes zero requests and keeps a consistent pair",async()=>{
 const f=fixture({objects:[localized("Snack wrapper")],labels:[["Empty snack wrapper"]],ai:true}),r=await f.run();
 assert.equal(r.detectedItems[0].category,"Residual");assert.equal(r.categoryAssessments.items[0].category,"Residual");assert.equal(f.calls.assessment,0);
 assert.equal(v7.v5SidecarAccepted(r,f.c.captureId),true);
});
test("Can/Spray Can ambiguity remains one Unknown owner and a matching accepted sidecar",async()=>{
 for(const ai of [false,true]){const f=fixture({labels:[["Can"],["Spray Can"]],ai}),r=JSON.parse(JSON.stringify(await f.run()));
  assert.equal(r.detectedItems.length,1);assert.equal(r.detectedItems[0].category,"Unknown");assert.equal(r.categoryAssessments.items[0].category,"Unknown");
  assert.equal(r.scanSummary.totalItems,1);assert.equal(v7.v5SidecarAccepted(r,f.c.captureId),true);assert.ok(f.calls.assessment<=1);
 }
});
test("foreign, duplicate, stale and contradictory final sidecars remain rejected",async()=>{
 const f=fixture({objects:[localized("Battery"),localized("Bottle",.9,far)]}),r=JSON.parse(JSON.stringify(await f.run()));
 assert.equal(v7.v5SidecarAccepted(r,f.c.captureId),true);
 for(const mutate of [s=>s.captureId=crypto.randomUUID(),s=>s.items[0].itemId="foreign_id",
  s=>s.items[1].itemId=s.items[0].itemId,s=>s.items[0].category="Unknown",s=>s.items[0].requiresConfirmation=false]){
  const bad=structuredClone(r);mutate(bad.categoryAssessments);assert.equal(v7.v5SidecarAccepted(bad,f.c.captureId),false);
 }
});
test("Android safe failure and explicit Unknown flows remain separate in the actual source",()=>{
 const root="C:/Users/ADMIN/AndroidStudioProjects/AIWasteManagementSystem-unknown-primary/app/src/main/java/com/example/aiwastemanagementsystem/";
 const scan=fs.readFileSync(root+"WasteScanActivity.java","utf8"),parser=fs.readFileSync(root+"WasteCategoryAssessments.java","utf8");
 assert.match(scan,/if \(!success\) \{\s*setAnalysisErrorState\(\)/);assert.match(scan,/setAnalysisErrorState\(\);[\s\S]*?Server error:/);
 assert.match(scan,/WastePrimaryPresentation.unknownPrimary/);assert.match(parser,/!owner.category.equals\("Unknown"\) && !category.equals\(owner.category\)/);
 // Wiring inspection only; no claim that these sources match the installed APK.
});
