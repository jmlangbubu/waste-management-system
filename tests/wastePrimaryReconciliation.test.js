"use strict";
// Offline service/route contract tests: no provider, filesystem or database writes.
const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),
 fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),{EventEmitter}=require("node:events");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition"),
 discovery=require("../services/wholeImageRecognitionService"),
 {createAssessmentService}=require("../services/perItemWasteAssessmentService");
const plain=value=>JSON.parse(JSON.stringify(value));
const box={left:.1,top:.1,right:.3,bottom:.5},far={left:.6,top:.1,right:.8,bottom:.5};
const localized=(name,confidence=.95,boundingBox=box)=>({name,confidence,boundingBox});
const capture=()=>({captureId:crypto.randomUUID(),requestId:crypto.randomUUID(),width:600,height:400,orientation:"upright",
 image:Buffer.from("ffd8ffc0000b080190025801011100ffd9","hex").toString("base64")});
const insufficient={category:"Unknown",kind:"unknown",material:"unknown",condition:"unknown",evidence:"insufficient"};
function fixture({objects=[],labels=[],primary=null,enabled=true,ai=false,facts=insufficient,compatible=false}={}) {
 const calls={primary:0,vision:0,discovery:0,assessment:0},env={
  WHOLE_IMAGE_DISCOVERY_ENABLED:String(enabled),WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:String(ai),
  CLOUD_RUN_AUTH_MODE:"iam",CLOUD_RUN_AUDIENCE:"https://synthetic.invalid",
  GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste",WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"offline-contract-token-over-thirty-two-characters"};
 const assessCapture=createAssessmentService({env,authHeaders:async()=>({}),transport:async(url,input)=>{
  calls.assessment++;return {schemaVersion:1,captureId:input.captureId,requestId:input.requestId,
   assessments:input.items.map(item=>({itemId:item.itemId,...facts}))};
 }});
 const transport={request(options,callback){calls.primary++;const request=new EventEmitter();request.write=()=>{};
  request.destroy=e=>request.emit("error",e);request.end=()=>{const response=new EventEmitter();response.statusCode=200;callback(response);
   response.emit("data",JSON.stringify(primary?{success:true,result:primary}:{success:false,result:null}));response.emit("end");};return request;}};
 const m={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../services/wasteAnalysisService.js"),"utf8"),{
  module:m,Buffer,URL,setTimeout,clearTimeout,process:{env},console:{log(){},warn(){},error(){}},require(id){
   if(id==="http"||id==="https")return transport;
   if(id==="./googleVisionService")return {...require("../services/googleVisionService"),async detectObjectsFromBase64(){calls.vision++;return plain(objects);}};
   if(id==="./geminiWasteClassifierService")return {classifyWasteWithGemini:async()=>null};
   if(id==="./cloudRunAuth")return {invocationHeaders:async()=>({})};
   if(id==="./wholeImageRecognitionService")return {...discovery,async discoverObjects(input){calls.discovery++;
    return whole.normalize(input,{objects:labels.map(([label,b=box])=>({label,box_2d:[b.top,b.left,b.bottom,b.right].map(n=>n*1000)}))});}};
   if(id==="./perItemWasteAssessmentService")return {assessCapture};
   if(id==="./wasteAssessmentDiagnostics")return {...require("../services/wasteAssessmentDiagnostics"),logAssessment(){}};
   if(["./cloudRunDiagnostics","./wasteDisplayNameService","./wasteLearningGuideService","./automaticWasteCategoryMapper"].includes(id))return require("../services/"+id.slice(2));
   if(id==="../utils/wasteMapper")return require(id);
   throw Error("Unexpected dependency: "+id);
  }
 });
 const c=capture(),service=m.exports;
 return {calls,c,service,run:()=>service.analyzeWaste({image:c.image,objectDiscovery:c,principal:42,detectedObject:"captured_waste_item",independentCategoryV2:compatible})};
}
async function route(serviceResult,{fail=false,capability,captureId}={}) {
 const handlers={},writes=[],effects={images:0},m={exports:{}},router=Object.fromEntries(["get","post","patch","delete"].map(method=>[method,(url,...chain)=>{handlers[method+" "+url]=chain.at(-1);} ]));
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../routes/wasteRoutes.js"),"utf8"),{
  module:m,__dirname:path.join(__dirname,"../routes"),Buffer,AbortController,console:{log(){},warn(){},error(){}},require(id){
   if(id==="express")return {Router:()=>router};if(id==="path")return path;if(id==="qrcode")return {};
   if(id==="fs")return {existsSync:()=>true,writeFileSync(){effects.images++;},mkdirSync(){throw Error("Unexpected directory write");}};
   if(id==="../config/db")return {queryReadOnly(sql,cb){assert.match(sql,/SHOW COLUMNS FROM scan_history/);
    cb(null,["image_url","analysis_source","ai_label","ai_confidence"].map(Field=>({Field})));},query(sql,values,cb){
     assert.match(sql,/INSERT INTO scan_history/);writes.push({sql,values});cb(fail?{code:"OFFLINE_INSERT_FAILURE"}:null,{insertId:17});}};
   if(id==="../services/wasteAnalysisService")return {analyzeWaste:async()=>serviceResult,buildScanSummary:require("../services/wasteAnalysisService").buildScanSummary};
   if(id.includes("Controller"))return new Proxy({},{get:()=>()=>{}});
   if(id==="../middleware/mobileSessionAuth")return {requireMobileSession(){}};
   if(id==="../middleware/webSessionAuth")return {requireWebCapability:()=>()=>{},requireCsrf(){}};
   if(id==="../gemini-waste-classifier-cloudrun/cropRecognition")return require(id);
   throw Error("Unexpected route dependency: "+id);
  }
 });
 let response,status=200;await handlers["post /analyze"]({headers:{"x-wmo-scan-capability":capability},body:{image:"c3ludGhldGlj",...(captureId?{objectDiscovery:{captureId}}:{})}},{json(v){response=v;return this;},status(code){status=code;return this;}});
 return {body:plain(response),writes,status,effects};
}
function unavailablePrimary(response) {
 assert.equal(response.status,503);
 assert.deepEqual(response.body,{success:false,message:"Waste analysis could not be completed. Please scan again or ask WMO to confirm the item."});
 assert.deepEqual(response.writes,[]);assert.equal(response.effects.images,0);
}
function neutral(result) {
 assert.equal(result.category,"Unknown");
 assert.match(result.action,/Confirm identity, material, contents and condition/);
 assert.doesNotMatch([result.explanation,result.action,result.warning].join(" "),/recyclable waste bin|residual waste bin|classified as residual|classified as recyclable/i);
}
function ownersPreserved(result,initial) {
 assert.deepEqual(result.detectedItems.map(i=>[i.itemId,i.analysisSource,i.confidence,i.boundingBox]),
  initial.map(i=>[i.itemId,i.analysisSource,i.confidence,i.boundingBox]));
 assert.equal(result.scanSummary.totalItems,initial.length);
}
function v7(result,c) {
 const sidecar=result.categoryAssessments,owners=new Map(result.detectedItems.map(i=>[i.itemId,i]));
 assert.equal(sidecar.schemaVersion,1);assert.equal(sidecar.captureId,c.captureId);
 assert.ok(["not_requested","complete","unavailable"].includes(sidecar.aiStatus));
 const seen=new Set();for(const row of sidecar.items){const owner=owners.get(row.itemId);assert.ok(owner);assert.ok(!seen.has(row.itemId));seen.add(row.itemId);
  assert.equal(row.requiresConfirmation,true);assert.ok(["Unknown","Biodegradable","Recyclable","Residual","Special Waste"].includes(row.category));
  assert.ok(["existing_category","reviewed_identity_rule","insufficient_evidence","ai_assisted"].includes(row.assessmentSource));
  if(row.assessmentSource==="ai_assisted"){assert.equal(owner.category,"Unknown");assert.equal(sidecar.aiStatus,"complete");}
  if(owner.category!=="Unknown")assert.equal(row.category,owner.category);
 }
}
test("full bottle veto neutralizes the exact Vision-owned primary, retaining owner geometry and source",async()=>{
 const f=fixture({objects:[localized("Empty plastic water bottle")],labels:[["Full plastic water bottle"]],ai:true});
 const initial=f.service.normalizeDetectedItems([localized("Empty plastic water bottle")],"google_vision_object_localization");
 const r=plain(await f.run());neutral(r);ownersPreserved(r,plain(initial));
 assert.equal(r.analysisSource,"google_vision_object_localization");assert.equal(r.aiConfidence,"0.95");
 assert.equal(r.detectedItems[0].category,"Unknown");assert.equal(r.scanSummary.categories.recyclable,0);v7(r,f.c);
 // This explicit original empty identity already receives one safety review;
 // primary reconciliation must not add another call or change that policy.
 assert.equal(f.calls.assessment,1);assert.deepEqual(Object.keys(r).filter(k=>/owner|provenance/i.test(k)),[]);
 const saved=await route(r);unavailablePrimary(saved);
});
for(const enabled of [false,true])for(const names of [["Unidentified bottle"],["Unidentified bottle","Unidentified packet"],[]])
 test(`no safe primary stays Unknown internally and fails closed for legacy clients: discovery=${enabled}, owners=${names.length}`,async()=>{
  const objects=names.map((n,i)=>localized(n,.95-i*.05,i?far:box)),f=fixture({objects,enabled});const r=plain(await f.run());neutral(r);
  assert.equal(r.analysisSource,"fallback_no_ai_result");assert.equal(r.detectedItems.length,names.length);
  assert.deepEqual(r.scanSummary.categories,{biodegradable:0,recyclable:0,residual:0,specialWaste:0});
  const snapshot=structuredClone(r);unavailablePrimary(await route(r));assert.deepEqual(r,snapshot);
 });
test("an Unknown Bottle cannot take the safe Battery primary or transfer its category",async()=>{
 const f=fixture({objects:[localized("Unidentified bottle"),localized("Battery",.9,far)]}),r=plain(await f.run());
 assert.equal(r.category,"Special Waste");assert.equal(r.aiLabel,"Battery");
 assert.deepEqual(r.detectedItems.map(i=>i.category),["Unknown","Special Waste"]);assert.equal(r.scanSummary.categories.specialWaste,1);v7(r,f.c);
 // The internal Battery primary remains valid, but shipping the Unknown
 // secondary to an unidentified legacy client is unsafe. Nothing is saved.
 const snapshot=structuredClone(r);unavailablePrimary(await route(r));assert.deepEqual(r,snapshot);
});
test("vetoed higher-confidence owner reselects the independent safe Battery, not a display-name/category match",async()=>{
 const f=fixture({objects:[localized("Empty plastic water bottle"),localized("Battery",.9,far)],labels:[["Full plastic water bottle"]]});
 const r=plain(await f.run());assert.equal(r.category,"Special Waste");assert.equal(r.aiLabel,"Battery");assert.equal(r.aiConfidence,"0.90");
 assert.deepEqual(r.detectedItems.map(i=>i.category),["Unknown","Special Waste"]);assert.match(r.action,/special waste/);
});
test("same-name separate bottles keep independent owners when only the first primary is vetoed",async()=>{
 const objects=[localized("Empty plastic water bottle"),localized("Empty plastic water bottle",.9,far)],
  f=fixture({objects,labels:[["Full plastic water bottle"]]}),r=plain(await f.run());
 const original=plain(f.service.normalizeDetectedItems(objects,"google_vision_object_localization"));ownersPreserved(r,original);
 assert.deepEqual(r.detectedItems.map(i=>i.category),["Unknown","Recyclable"]);
 assert.equal(r.category,"Recyclable");assert.equal(r.aiConfidence,"0.90");assert.equal(r.scanSummary.categories.recyclable,1);v7(r,f.c);
});
test("valid independent Gemini primary is unchanged despite all-Unknown final owners",async()=>{
 const primary={itemName:"Charger",category:"Special Waste",confidence:.87,explanation:"Independent explanation",action:"Independent safe action",warning:"Independent warning"};
 const f=fixture({primary,objects:[localized("Empty plastic water bottle"),localized("Snack packet",.9,far)],labels:[["Full plastic water bottle"]]});
 const r=plain(await f.run());assert.equal(r.itemName,primary.itemName);assert.equal(r.category,primary.category);assert.equal(r.aiConfidence,"0.87");
 for(const key of ["explanation","action","warning"])assert.equal(r[key],primary[key]);assert.equal(r.analysisSource,"cloud_run_gemini_vision");
 assert.ok(r.detectedItems.every(i=>i.category==="Unknown"));assert.equal(r.scanSummary.categories.specialWaste,0);v7(r,f.c);
 const snapshot=structuredClone(r);unavailablePrimary(await route(r));assert.deepEqual(r,snapshot);
});
for(const [name,category]of [["Empty snack wrapper","Residual"],["Discarded snack wrapper","Residual"],
 ["Empty instant noodle wrapper","Residual"],["Empty plastic beverage bottle","Recyclable"],
 ["Banana Peel","Biodegradable"],["Paint Can","Special Waste"],["Syringe","Special Waste"],["Charger","Special Waste"],["Battery","Special Waste"]])
 test(`supported original owner remains categorized: ${name}`,async()=>{
  const f=fixture({objects:[localized(name)]}),r=plain(await f.run());assert.equal(r.category,category);assert.equal(r.detectedItems[0].category,category);v7(r,f.c);
  const saved=await route(r);assert.equal(saved.status,200);assert.equal(saved.body.result.category,category);
  assert.deepEqual(saved.body.detectedItems,r.detectedItems);assert.deepEqual(saved.body.categoryAssessments,r.categoryAssessments);
  assert.equal(saved.writes.length,1);assert.equal(saved.effects.images,1);
 });
for(const name of ["Unopened Snack Packet","Generic Food Packaging"])
 test(`unsupported original product remains neutral: ${name}`,async()=>{const f=fixture({objects:[localized(name)],ai:true}),r=plain(await f.run());neutral(r);
  assert.equal(r.detectedItems[0].category,"Unknown");assert.equal(f.calls.assessment,0);v7(r,f.c);
 });
test("genuine independent Residual classification is not overruled by Unknown owners",async()=>{
 const f=fixture({primary:{itemName:"Empty snack wrapper",category:"Residual",confidence:.9,action:"Existing Residual guidance"},objects:[localized("Item")]});
 const r=plain(await f.run());assert.equal(r.category,"Residual");assert.equal(r.action,"Existing Residual guidance");
});
test("approved common wrapper preserves private evidence and needs no assessment request",async()=>{
 const f=fixture({objects:[localized("Snack wrapper")],labels:[["Empty snack wrapper"]],ai:true}),r=plain(await f.run());
 assert.equal(r.category,"Residual");assert.equal(r.detectedItems[0].category,"Residual");assert.equal(r.categoryAssessments.items[0].category,"Residual");
 assert.equal(r.categoryAssessments.aiStatus,"not_requested");assert.equal(f.calls.assessment,0);v7(r,f.c);
});
test("legitimate electrical evidence keeps one cached assessment batch without changing owner or primary",async()=>{
 const f=fixture({objects:[localized("Unclassified household container")],ai:true,
  facts:{category:"Special Waste",kind:"electrical",material:"mixed",condition:"unknown",evidence:"visible"}});
 const first=plain(await f.run()),second=plain(await f.run());neutral(first);assert.equal(first.detectedItems[0].category,"Unknown");
 assert.equal(first.categoryAssessments.items[0].category,"Special Waste");assert.deepEqual(second.categoryAssessments,first.categoryAssessments);
 assert.equal(f.calls.assessment,1);v7(first,f.c);
});
test("Unknown primary is rejected before even a failing persistence path is attempted",async()=>{
 const f=fixture({objects:[localized("Unidentified bottle")]}),r=plain(await f.run()),saved=await route(r,{fail:true});
 neutral(r);unavailablePrimary(saved);
});
test("source-equivalent Android Unknown contract is wired through real presentation and original-primary navigation",()=>{
 const root="C:/Users/ADMIN/AndroidStudioProjects/AIWasteManagementSystem-unknown-primary/app/src/main/java/com/example/aiwastemanagementsystem/";
 const presentation=fs.readFileSync(root+"WastePrimaryPresentation.java","utf8"),scan=fs.readFileSync(root+"WasteScanActivity.java","utf8"),
  details=fs.readFileSync(root+"ScanHistoryDetailActivity.java","utf8"),parser=fs.readFileSync(root+"WasteCategoryAssessments.java","utf8");
 assert.match(presentation,/default: return "Unknown"/);assert.match(presentation,/category\(primary.optString\("category", ""\)\).equals\("Unknown"\)\) return true/);
 assert.match(scan,/WastePrimaryPresentation.unknownPrimary/);assert.match(scan,/startActivity\(lastResultIntent\)/);
 assert.match(details,/WastePrimaryPresentation.category/);assert.match(parser,/!\(gemini \|\| vision\)/);
 // Source wiring only: installed v7 APK provenance is intentionally unverified.
});
