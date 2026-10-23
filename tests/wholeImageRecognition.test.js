"use strict";
const assert=require("node:assert/strict"),{test}=require("node:test"),crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),{EventEmitter}=require("node:events");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition"),shared=require("../gemini-waste-classifier-cloudrun/cropRecognition");
const {createDiscoveryService,merge,identityConflict,alignedIdentity}=require("../services/wholeImageRecognitionService");
const analysis=require("../services/wasteAnalysisService");
const jpeg=Buffer.from([255,216,255,192,0,11,8,1,144,2,88,1,1,17,0,255,217]).toString("base64");
const input=()=>({requestId:crypto.randomUUID(),captureId:crypto.randomUUID(),image:jpeg,width:600,height:400,orientation:"upright"});
const env={WHOLE_IMAGE_DISCOVERY_ENABLED:"true",WHOLE_IMAGE_DISCOVERY_SHARED_TOKEN:"synthetic-shared-token-over-32-characters",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste",GEMINI_API_KEY:"synthetic-provider-key"};
const object=(label="Plastic Bottle",box_2d=[100,50,900,250])=>({label,...(box_2d?{box_2d}:{})});
const normalize=(objects,request=input())=>whole.normalize(request,{objects});
const vision=(name="Bottle",box={left:.05,top:.1,right:.25,bottom:.9},confidence=.8)=>({itemId:crypto.randomUUID(),itemName:name,canonicalItem:name.toLowerCase(),confidence,category:"Unknown",boundingBox:box,analysisSource:"google_vision_object_localization"});
const merged=(v,g)=>merge(v,normalize(g).objects,analysis.samePhysicalObject);
test("two distinct bottles and overlapping packaged-goods aliases remain two physical objects",()=>{
 const v=[vision(),vision("Bottle",{left:.45,top:.1,right:.65,bottom:.9})];
 const result=merged(v,[object(),object("Bottled and jarred packaged goods"),object("Plastic Bottle",[100,450,900,650])]);
 assert.equal(result.length,2);assert.deepEqual(result.map(i=>i.boundingBox),v.map(i=>i.boundingBox));assert.equal(result[0].identityObservation,"Plastic Bottle");assert.equal(result[0].category,"Unknown");
});
test("bottle plus separate pen, two bottles pen and packaging have independent localized entries",()=>{
 const objects=[object(),object("Plastic Bottle",[100,350,900,550]),object("ballpen",[200,650,850,700]),object("Food packaging",[600,750,900,950])];
 const result=merged([vision()],objects);assert.equal(result.length,4);assert.equal(result.find(x=>x.itemName==="Ballpoint Pen").category,"Unknown");
 assert.equal(new Set(result.map(x=>x.itemId)).size,4);assert.equal(merged([vision()],objects.slice(0,1).concat(objects[2])).length,2);
});
test("paper cardboard food waste and unspecified containers preserve observed identities and only approved categories",()=>{
 const result=normalize([object("Paper"),object("Cardboard"),object("Food waste"),object("White container")]);
 assert.deepEqual(result.objects.map(x=>x.category),["Unknown","Recyclable","Unknown","Unknown"]);
});
test("missing malformed reversed zero-area pixel and normalized-float geometry never invent boxes",()=>{
 for(const value of [null,[],[900,100,100,500],[0,0,0,100],[0,0,1024,1024],[.1,.1,.9,.9],{left:0,top:0,right:1,bottom:1},[0,0,NaN,1]]) {
  const result=normalize([object("Ballpoint Pen",value)]);assert.equal(result.objects[0].recognitionState,"identity_only");assert.equal(result.objects[0].boundingBox,undefined);assert.equal(merged([], [object("Pen",value)]).length,0);
 }
});
test("y-first 0..1000 convention maps asymmetric portrait and landscape boxes without axis guessing",()=>{
 assert.deepEqual(whole.box([100,200,800,400]),{left:.2,top:.1,right:.4,bottom:.8});
 assert.deepEqual(whole.box([200,100,400,800]),{left:.1,top:.2,right:.8,bottom:.4});
 const request=input();assert.deepEqual(whole.validateRequest(request),request);
 for(const patch of [{orientation:"rotate90"},{width:400,height:600},{height:0},{width:4096}])assert.throws(()=>whole.validateRequest({...request,...patch}));
 const rotated=Buffer.from(jpeg,"base64");const app1=Buffer.from([255,225,0,8,69,120,105,102,0,0]);
 assert.throws(()=>whole.validateRequest({...request,image:Buffer.concat([rotated.subarray(0,2),app1,rotated.subarray(2)]).toString("base64")}));
});
test("duplicate provider objects collapse by geometry and specificity, never by label alone",()=>{
 const result=merged([],[object("Bottle"),object("Plastic Bottle"),object("Plastic Bottle",[100,450,900,650])]);
 assert.equal(result.length,2);assert.equal(result[0].itemName,"Plastic Bottle");
 const nested=merged([],[object(),object("Pen",[300,100,500,150])]);assert.equal(nested.length,2);
 const partial=merged([],[object(),object("Plastic Bottle",[100,150,900,350])]);assert.equal(partial.length,2);
});
test("no generated confidence and unsupported hallucinated identities remain unverified Unknown observations",()=>{
 const item=normalize([object("Imagined unobtainium widget")]).objects[0];assert.equal(item.confidence,undefined);assert.equal(item.category,"Unknown");assert.equal(item.requiresConfirmation,true);
 assert.equal(item.localizationSource,"gemini_model_predicted");assert.throws(()=>normalize([{...object(),confidence:.75}]));
});
test("stable provider-independent IDs depend on capture and geometry, not provider ordering",()=>{
 const request=input(),a=object(),b=object("Pen",[100,400,800,450]);
 const x=normalize([a,b],request),y=normalize([b,a],request);assert.equal(x.objects[0].itemId,y.objects[1].itemId);
 assert.notEqual(normalize([a],input()).objects[0].itemId,x.objects[0].itemId);
});
test("strict schema rejects malformed or excessive responses and revalidates remote mappings",()=>{
 const request=input();for(const response of [null,{}, {objects:"bad"},{objects:Array(9).fill(object())},{objects:[{label:"Pen",category:"Residual"}]}])assert.throws(()=>whole.normalize(request,response));
 const valid=normalize([object()],request);assert.deepEqual(whole.validateResponse(request,valid),valid);
 for(const patch of [{category:"Residual"},{confidence:.55},{localizationSource:"verified"},{boundingBox:{left:0,top:0,right:2,bottom:1}}]) {
  assert.throws(()=>whole.validateResponse(request,{...valid,objects:[{...valid.objects[0],...patch}]}));
 }
 assert.throws(()=>whole.validateResponse(request,{...valid,requestId:crypto.randomUUID()}));
});
test("structured prompt uses one whole image with supported schema, no primary classification instructions",()=>{
 const body=whole.geminiBody(input());assert.equal(body.contents[0].parts.filter(x=>x.inlineData).length,1);
 assert.equal(body.generationConfig.thinkingConfig.thinkingBudget,0);assert.equal(body.generationConfig.responseSchema.properties.objects.maxItems,8);
 assert.match(body.contents[0].parts[0].text,/ymin,xmin,ymax,xmax/);
});
test("feature disabled, invalid identity, insecure URL, oversized or malformed image cannot call provider",async()=>{
 let calls=0;const transport=async()=>{calls++;};
 for(const config of [{},{...env,WHOLE_IMAGE_DISCOVERY_ENABLED:"false"},{...env,WHOLE_IMAGE_DISCOVERY_SHARED_TOKEN:"short"},{...env,GEMINI_WHOLE_IMAGE_URL:"http://synthetic.invalid"}]) {
  await assert.rejects(createDiscoveryService({env:config,transport})(input(),{principal:42}));
 }
 for(const request of [{...input(),image:"private-invalid-base64"},{...input(),image:"A".repeat(3*1024*1024)},{...input(),orientation:90}])await assert.rejects(createDiscoveryService({env,transport})(request,{principal:42}));
 await assert.rejects(createDiscoveryService({env,transport})(input(),{}));assert.equal(calls,0);
});
test("one bounded authenticated service call uses shared transport and validates response",async(t)=>{
 let now=1700000000000;
 t.mock.method(Date,"now",()=>now);
 // Exercise the remaining budget with controlled elapsed time, never wall-clock timing.
 for(const elapsedMs of [0,1,25]) {
  now=1700000000000;
  const request=input();let calls=0;
  const recognize=createDiscoveryService({env:{...env,CLOUD_RUN_AUTH_MODE:"iam"},authHeaders:async()=>{now+=elapsedMs;return {};},transport:async(url,body,options)=>{calls++;assert.equal(url,"https://synthetic.invalid/discover-objects");assert.equal(options.timeoutMs,whole.LIMITS.deadlineMs-elapsedMs);assert.ok(options.timeoutMs>0&&options.timeoutMs<=whole.LIMITS.deadlineMs);assert.equal(options.headers["X-Whole-Image-Token"],env.WHOLE_IMAGE_DISCOVERY_SHARED_TOKEN);return normalize([object("Pen")],body);}});
  const result=await recognize(request,{principal:42});assert.equal(calls,1);assert.equal(result.objects[0].category,"Unknown");
 }
});
test("provider timeout malformed response and cancellation do not leak payloads and enforce budgets",async()=>{
 for(const response of [new shared.RecognitionError("RECOGNITION_TIMEOUT",504),{}, {success:true}]) {
  const service=createDiscoveryService({env,transport:async()=>{if(response instanceof Error)throw response;return response;}});
  await assert.rejects(service(input(),{principal:42}));
 }
 let calls=0;const service=createDiscoveryService({env,transport:async(u,b)=>{calls++;return normalize([],b);},budget:shared.createBudget({perUser:1})});
 await service(input(),{principal:42});await assert.rejects(service(input(),{principal:42}));assert.equal(calls,1);
 const controller=new AbortController();controller.abort();await assert.rejects(service(input(),{principal:43,signal:controller.signal}));
});
function response(){const res=new EventEmitter();res.status=c=>{res.statusCode=c;return res;};res.json=x=>{res.body=x;res.writableEnded=true;res.emit("finish");return res;};return res;}
test("Cloud handler is gated authenticated bounded and uses only the pinned model",async()=>{
 const request=input();let calls=0;
 const handler=whole.createCloudHandler({env,transport:async(url,body,options)=>{calls++;assert.match(url,/gemini-2.5-flash/);assert.ok(options.timeoutMs<=10000);assert.equal(options.headers["x-goog-api-key"],env.GEMINI_API_KEY);return {candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({objects:[object("Pen")]})}]}}]};}});
 const req=new EventEmitter();req.body=request;req.get=()=>env.WHOLE_IMAGE_DISCOVERY_SHARED_TOKEN;const res=response();await handler(req,res);assert.equal(res.body.objects.length,1);assert.equal(calls,1);
 for(const config of [{...env,WHOLE_IMAGE_DISCOVERY_ENABLED:"false"},{...env,WHOLE_IMAGE_DISCOVERY_MODEL:"unverified-model"}]){const bad=response();await whole.createCloudHandler({env:config,transport:async()=>{throw Error("must not call");}})(req,bad);assert.equal(bad.statusCode,503);}
});
function serviceFixture({enabled=true,objects=[object("Pen",[100,400,800,450])],failure=false,visionObjects=null,assessmentEnabled=true,assessmentFailure=false}={}) {
 let resolveDiscovery;const calls={primary:0,vision:0,discovery:0};const primary={success:true,source:"original",result:{itemName:"Original Bottle",category:"Recyclable",confidence:.91,explanation:"Original explanation",action:"Original action",warning:"Original warning"}};
 const transport={request(options,callback){const req=new EventEmitter();req.write=()=>{};req.destroy=e=>req.emit("error",e);req.end=()=>{calls.primary++;const res=new EventEmitter();res.statusCode=200;callback(res);res.emit("data",JSON.stringify(primary));res.emit("end");return req;};return req;}};
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../services/wasteAnalysisService.js"),"utf8"),{module,Buffer,URL,setTimeout,clearTimeout,console:{log(){},warn(){},error(){}},process:{env:{GEMINI_CLASSIFIER_URL:env.GEMINI_CLASSIFIER_URL,...(enabled?{WHOLE_IMAGE_DISCOVERY_ENABLED:"true",...(assessmentEnabled?{WASTE_ITEM_ASSESSMENT_ENABLED:"true"}:{})}:{})}},require(id){
  if(id==="./cloudRunDiagnostics")return require("../services/cloudRunDiagnostics");
   if(id==="./automaticWasteCategoryMapper")return require("../services/automaticWasteCategoryMapper");
  if(id==="http"||id==="https")return transport;
  if(id==="./googleVisionService")return {...require("../services/googleVisionService"),async detectObjectsFromBase64(){calls.vision++;return visionObjects || [vision()];}};
  if(id==="./geminiWasteClassifierService")return {};
  if(id==="./wasteLearningGuideService")return require("../services/wasteLearningGuideService");
  if(id==="./wasteDisplayNameService")return require("../services/wasteDisplayNameService");
  if(id==="./perItemWasteAssessmentService"){if(assessmentFailure)throw Error("SYNTHETIC_PRIVATE_ASSESSMENT_FAILURE");return {assessCapture:require("../services/perItemWasteAssessmentService").createAssessmentService({env:{WASTE_ITEM_ASSESSMENT_ENABLED:"true"}})};}
  if(id==="./wasteAssessmentDiagnostics")return {logAssessment(){}};
  if(id==="../utils/wasteMapper")return require("../utils/wasteMapper");
  if(id==="./wholeImageRecognitionService")return {merge,identityConflict,alignedIdentity,discoverObjects:async(input)=>{calls.discovery++;if(failure)throw new shared.RecognitionError("RECOGNITION_TIMEOUT",504);return new Promise(resolve=>{resolveDiscovery=()=>resolve(normalize(objects,input));});}};
  throw Error("Unexpected dependency "+id);
 }});
 return {...module.exports,calls,complete:()=>resolveDiscovery?.()};
}
test("discovery and primary run concurrently, primary result stays unchanged, Vision geometry wins",async()=>{
 const request=input(),service=serviceFixture();const pending=service.analyzeWaste({image:request.image,objectDiscovery:request,principal:42});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(service.calls.discovery,1);assert.equal(service.calls.primary,1);assert.equal(service.calls.vision,1);service.complete();
 const result=await pending;assert.equal(result.itemName,"Original Bottle");assert.equal(result.explanation,"Original explanation");assert.equal(result.action,"Original action");assert.equal(result.aiConfidence,"0.91");assert.equal(result.analysisSource,"original");assert.equal(result.detectedItems.length,2);
});
test("Vision-only fallback and disabled baseline require no additional provider retries",async()=>{
 for(const enabled of [false,true]){const service=serviceFixture({enabled,failure:true}),request=input();const result=await service.analyzeWaste({image:request.image,objectDiscovery:request,principal:42});assert.equal(result.detectedItems.length,1);assert.equal(result.itemName,"Original Bottle");assert.equal(service.calls.discovery,enabled?1:0);assert.equal(service.calls.primary,1);}
});
test("Gemini-only valid detections remain bounded at eight and never contain confidence",()=>{
 const result=merged([],Array.from({length:8},(_,i)=>object("Pen",[100,10+i*120,900,50+i*120])));assert.equal(result.length,8);assert.ok(result.every(x=>!Object.hasOwn(x,"confidence")));
});
test("new discovery infrastructure contains no history writes or independent Vision calls",()=>{
 for(const file of ["../services/wholeImageRecognitionService.js","../gemini-waste-classifier-cloudrun/wholeImageRecognition.js"]){const source=fs.readFileSync(path.join(__dirname,file),"utf8");assert.doesNotMatch(source,/INSERT INTO|writeFile|detectObjectsFromBase64|console\.(log|error)/);}
});

test("same capture is attempted once per bounded cache window and cannot change image under that ID",async()=>{
 const request=input();let calls=0;const service=createDiscoveryService({env,transport:async(u,b)=>{calls++;return normalize([object()],b);}});
 const first=await service(request,{principal:42}), secondRequest={...request,requestId:crypto.randomUUID()};
 const second=await service(secondRequest,{principal:42});assert.equal(calls,1);assert.equal(second.requestId,secondRequest.requestId);assert.equal(first.objects[0].itemId,second.objects[0].itemId);
 const changed=Buffer.from(jpeg,"base64");changed[14]=1;
 await assert.rejects(service({...request,image:changed.toString("base64")},{principal:42}));assert.equal(calls,1);
});
test("remote JSON field ordering is irrelevant but optional confidences are still rejected",()=>{
 const request=input(),valid=normalize([object()],request);
 const reordered={...valid,objects:valid.objects.map(item=>Object.fromEntries(Object.entries(item).reverse()))};assert.deepEqual(whole.validateResponse(request,reordered),valid);
});

async function routeFixture({enabled=true,authenticated=true,compatible=false,assessmentEnabled=true,assessmentFailure=false}={}) {
 const handlers={},writes={history:0,image:0,auth:0},module={exports:{}},service=serviceFixture({enabled,assessmentEnabled,assessmentFailure});
 const router=Object.fromEntries(["get","post","patch","delete"].map(method=>[method,(url,...chain)=>{handlers[method+" "+url]=chain;}]));
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../routes/wasteRoutes.js"),"utf8"),{module,Buffer,AbortController,process:{env:enabled?{WHOLE_IMAGE_DISCOVERY_ENABLED:"true"}:{}},__dirname:path.join(__dirname,"../routes"),console:{log(){},warn(){},error(){}},require(id){
  if(id==="./cloudRunDiagnostics")return require("../services/cloudRunDiagnostics");
  if(id==="express")return {Router:()=>router};if(id==="path")return path;if(id==="qrcode")return {};
  if(id==="fs")return {existsSync:()=>true,mkdirSync(){throw Error("No new directory");},writeFileSync(){writes.image++;}};
  if(id==="../config/db")return {queryReadOnly(sql,callback){callback(null,["image_url","analysis_source","ai_label","ai_confidence"].map(Field=>({Field})));},query(sql,values,callback){assert.match(sql,/INSERT INTO scan_history/);writes.history++;callback(null,{insertId:123});}};
  if(id==="../services/wasteAnalysisService")return {analyzeWaste:service.analyzeWaste,buildScanSummary:analysis.buildScanSummary};
  if(id==="../middleware/mobileSessionAuth")return {requireMobileSession(req,res,next){writes.auth++;if(!authenticated)return res.status(401).json({success:false});req.mobileUser={id:42};return next();}};
  if(id.includes("Controller"))return new Proxy({},{get:()=>()=>{}});
  if(id.includes("webSessionAuth"))return {requireWebCapability:()=>()=>{},requireCsrf(){}};
  if(id==="../gemini-waste-classifier-cloudrun/cropRecognition")return shared;
  throw Error("Unexpected route dependency "+id);
 }});
 const request=input(),req=new EventEmitter(),res=response();req.body={image:request.image,objectDiscovery:{...request},detectedObject:"captured_waste_item",mlKitLabels:[]};delete req.body.objectDiscovery.image;
 req.headers=compatible?{"x-wmo-scan-capability":"waste-scan-independent-category-v2"}:{};
 const pending=(async()=>{for(const handler of handlers["post /analyze"]){let next=false;await handler(req,res,()=>{next=true;});if(!next)break;}})();
 await new Promise(resolve=>setImmediate(resolve));service.complete();await pending;return {writes,res,calls:service.calls,captureId:request.captureId};
}
test("opted-in analyze authenticates and merges without any extra scan-history or image writes",async()=>{
 const {writes,res,calls}=await routeFixture({compatible:true});assert.equal(res.statusCode||200,200);assert.equal(res.body.success,true);assert.equal(writes.auth,1);assert.equal(writes.history,1);assert.equal(writes.image,1);
 assert.equal(calls.discovery,1);assert.equal(calls.vision,1);assert.equal(res.body.result.id,123);assert.equal(res.body.result.itemName,"Original Bottle");assert.equal(res.body.detectedItems.length,2);
});
test("headerless mixed-Unknown scan fails legacy safety before image or history persistence",async()=>{
 const {writes,res}=await routeFixture();assert.equal(res.statusCode,503);assert.equal(res.body.success,false);
 assert.equal(writes.auth,1);assert.equal(writes.history,0);assert.equal(writes.image,0);
});
test("compatible scan preserves primary and independent detections when optional assessment is disabled or unavailable",async()=>{
 for(const options of [{assessmentEnabled:false},{assessmentFailure:true}]){
  const {writes,res,calls}=await routeFixture({compatible:true,...options});
  assert.equal(res.statusCode||200,200);assert.equal(res.body.success,true);assert.equal(res.body.result.itemName,"Original Bottle");
  assert.equal(res.body.result.category,"Recyclable");assert.equal(res.body.detectedItems.length,2);
  assert.equal(new Set(res.body.detectedItems.map(item=>item.itemId)).size,2);
  assert.equal(Object.hasOwn(res.body,"categoryAssessments"),false);
  assert.equal(writes.auth,1);assert.equal(writes.history,1);assert.equal(writes.image,1);
  assert.deepEqual(calls,{primary:1,vision:1,discovery:1});
 }
});
test("unauthenticated discovery is rejected before model calls or history writes",async()=>{
 const {writes,res,calls}=await routeFixture({authenticated:false});assert.equal(res.statusCode,401);assert.equal(writes.history,0);assert.equal(writes.image,0);assert.equal(calls.discovery,0);assert.equal(calls.primary,0);
});
test("server feature-off ignores discovery metadata and preserves the legacy analyze request",async()=>{
 const {writes,res,calls}=await routeFixture({enabled:false});assert.equal(writes.auth,0);assert.equal(writes.history,1);assert.equal(calls.discovery,0);assert.equal(res.body.detectedItems.length,1);
});

// Names/boxes copied from the successful user-run Gemini request; no photo or
// live-provider dependency. Vision responses below are deliberately mocked.
const realFour = [
 object("Sprite bottle",[258,200,621,360]), object("blue pen",[292,522,352,717]),
 object("blue plastic container",[406,712,533,922]), object("brown bottle with yellow cap",[509,495,840,650])
];
const realBoxes=realFour.map(x=>whole.box(x.box_2d));
function realVision(packageName) {
 const detections=[{name:"Bottle",confidence:.8,boundingBox:realBoxes[0]},
 {name:"Bottle",confidence:.75,boundingBox:realBoxes[3]}];
 if(packageName)detections.push({name:packageName,confidence:.65,boundingBox:realBoxes[2]});
 return analysis.normalizeDetectedItems(detections,"google_vision_object_localization");
}
test("actual four Gemini objects remain distinct Unknown observations without scores",()=>{
 const result=merged([],realFour);assert.equal(result.length,4);assert.equal(new Set(result.map(x=>x.itemId)).size,4);
 for(const raw of realFour){const item=result.find(x=>x.observedIdentity===raw.label);assert.ok(item);assert.deepEqual(item.boundingBox,whole.box(raw.box_2d));assert.equal(item.category,"Unknown");assert.equal(item.analysisSource,"gemini_whole_image");assert.equal(Object.hasOwn(item,"confidence"),false);}
});
test("actual two separate Vision bottles plus four Gemini observations remain four",()=>{
 const v=realVision(),before=JSON.stringify(v),result=merged(v,realFour);assert.equal(result.length,4);assert.equal(JSON.stringify(v),before);
 // A known Vision owner keeps its identity; the beverage brand is only a
 // separate provider observation, not proof of contents or discarded state.
 for(let i=0;i<v.length;i++){const matched=result.find(x=>x.itemId===v[i].itemId);assert.deepEqual(matched.boundingBox,v[i].boundingBox);assert.equal(matched.confidence,v[i].confidence);assert.equal(matched.category,"Recyclable");assert.equal(matched.itemName,v[i].itemName);assert.equal(matched.identityObservation,realFour[i===0?0:3].label);}
});
for(const label of ["Packaging","Plastic box"]){
 test("actual package plus mocked Vision "+label+" does not create a fifth item",()=>{
 const v=realVision(label),original=JSON.parse(JSON.stringify(v)),result=merged(v,realFour);assert.equal(v.length,3);assert.equal(result.length,4);
 const packageItem=result.find(x=>x.itemId===v[2].itemId);assert.equal(packageItem.identityObservation,"blue plastic container");assert.equal(packageItem.identitySource,"gemini_whole_image");assert.equal(packageItem.requiresConfirmation,true);
 for(const key of ["itemId","confidence","category","analysisSource","boundingBox","guidance","modelKey"])assert.deepEqual(packageItem[key],original[2][key]);
 assert.equal(packageItem.itemName,label==="Packaging" && original[2].category==="Unknown"?"blue plastic container":original[2].itemName);
 assert.deepEqual(v,original);assert.equal(result.filter(x=>JSON.stringify(x.boundingBox)===JSON.stringify(realBoxes[2])).length,1);
 });
}
test("strong cross-provider coincidence tolerates small localization differences without equivalent names",()=>{
 const v=vision("Packaging",realBoxes[2]),proposal=normalize([realFour[2]]).objects[0];
 proposal.boundingBox={...proposal.boundingBox,left:proposal.boundingBox.left+.001,right:proposal.boundingBox.right+.001};
 assert.equal(merge([v],[proposal],analysis.samePhysicalObject).length,1);
 // The same strict geometry applies to aliases from a single provider too.
 assert.equal(analysis.samePhysicalObject(v,{...proposal,analysisSource:v.analysisSource}),true);
});
test("partial overlaps, different extents and small nested objects remain independent",()=>{
 const v=vision("Packaging",{left:.2,top:.2,right:.8,bottom:.8});
 for(const b of [[300,500,900,900],[350,350,450,450],[200,200,750,750]]) {
 const proposal=normalize([object("blue plastic container",b)]).objects[0];assert.equal(merge([v],[proposal],analysis.samePhysicalObject).length,2);
 }
 // Same name and category also cannot collapse a spatially separate bottle.
 assert.equal(merged([vision("Bottle",realBoxes[0])],[realFour[3]]).length,2);
});
test("confirmed display metadata does not prove discarded product state",()=>{
 const v={...vision("User-confirmed package",realBoxes[2]),category:"Recyclable",confirmed:true};
 const result=merged([v],[realFour[2]])[0];assert.equal(result.itemName,v.itemName);assert.equal(result.category,"Unknown");assert.equal(result.confirmed,true);assert.equal(result.identityObservation,"blue plastic container");assert.equal(result.confidence,v.confidence);
 assert.equal(result.itemId,v.itemId);assert.deepEqual(result.boundingBox,v.boundingBox);
 for(const key of ["guidance","modelKey","modelHotspots"])assert.equal(Object.hasOwn(result,key),false);
});
test("ranked descriptive observation is retained rather than overwritten by later generic observations",()=>{
 const result=merged([vision("Bottle",realBoxes[0])],[realFour[0],object("Bottle",realFour[0].box_2d)]);
 assert.equal(result.length,1);assert.equal(result[0].identityObservation,"Sprite bottle");assert.equal(result[0].category,"Unknown");
});
test("actual four-object fixture preserves original primary View Details fields",async()=>{
 const request=input(),service=serviceFixture({objects:realFour,visionObjects:realVision("Packaging")});
 const pending=service.analyzeWaste({image:request.image,objectDiscovery:request,principal:42});await new Promise(resolve=>setImmediate(resolve));service.complete();const result=await pending;
 assert.equal(result.detectedItems.length,4);assert.equal(result.itemName,"Original Bottle");assert.equal(result.category,"Recyclable");assert.equal(result.explanation,"Original explanation");assert.equal(result.action,"Original action");assert.equal(result.warning,"Original warning");assert.equal(result.aiConfidence,"0.91");assert.equal(result.analysisSource,"original");
 assert.deepEqual(service.calls,{primary:1,vision:1,discovery:1});
});

// Controlled three-object capture: labels and boxes are synthetic, not a live result.
test("three distinct discovery objects survive full analyze with primary fallback unchanged", async () => {
 const objects=[object("Round container",[100,50,550,300]),object("White power adapter",[200,400,500,600]),object("Blue-handled object",[100,700,800,900])];
 const service=serviceFixture({objects,visionObjects:[]}),request=input();
 const pending=service.analyzeWaste({image:request.image,objectDiscovery:request,principal:42});
 await new Promise(resolve=>setImmediate(resolve));service.complete();const result=await pending;
 assert.equal(result.itemName,"Original Bottle");assert.equal(result.detectedItems.length,3);assert.equal(result.scanSummary.totalItems,3);
 assert.equal(new Set(result.detectedItems.map(x=>x.itemId)).size,3);assert.equal(new Set(result.detectedItems.map(x=>JSON.stringify(x.boundingBox))).size,3);
 assert.equal(result.detectedItems.find(item=>item.observedIdentity==="White power adapter").category,"Unknown");
 assert.equal(result.categoryAssessments.items.find(item=>item.itemId===result.detectedItems.find(i=>i.observedIdentity==="White power adapter").itemId).category,"Special Waste");
 assert.ok(result.detectedItems.filter(item=>item.observedIdentity!=="White power adapter").every(item=>item.category==="Unknown"));
 for(const item of result.detectedItems){assert.equal(item.requiresConfirmation,true);assert.equal(Object.hasOwn(item,"confidence"),false);}
 assert.deepEqual(JSON.parse(JSON.stringify(result.scanSummary.categories)),{biodegradable:0,recyclable:0,residual:0,specialWaste:0});
 assert.equal(service.calls.discovery,1);assert.equal(service.calls.vision,1);assert.equal(service.calls.primary,1);
});
test("forged discovery IDs fail response validation and repeated identical proposals create one item", () => {
 const request=input(),response=normalize([object("Blue-handled object")],request);
 assert.throws(()=>whole.validateResponse(request,{...response,objects:[{...response.objects[0],itemId:"item_forged"}]}));
 const result=merged([],[object("Blue-handled object"),object("Blue-handled object")]);
 assert.equal(result.length,1);assert.equal(new Set(result.map(x=>x.itemId)).size,1);
});

test("assessment flag off preserves the original full analyze response and billing counts",async()=>{
 const request=input(),service=serviceFixture({assessmentEnabled:false,visionObjects:[],objects:[object("white power adapter"),object("gray round container",[100,500,800,900])]});
 const pending=service.analyzeWaste({image:request.image,objectDiscovery:request,principal:42});await new Promise(resolve=>setImmediate(resolve));service.complete();const result=await pending;
 assert.equal(Object.hasOwn(result,"categoryAssessments"),false);assert.equal(result.itemName,"Original Bottle");assert.equal(result.detectedItems.length,2);
 assert.ok(result.detectedItems.every(i=>i.category==="Unknown"&&!Object.hasOwn(i,"guidance")));assert.deepEqual(service.calls,{primary:1,vision:1,discovery:1});
});
test("versioned deterministic assessments reach authenticated API response without extra history or image writes",async()=>{
 const {res,writes,calls,captureId}=await routeFixture({compatible:true});assert.equal(res.statusCode||200,200);assert.equal(res.body.result.itemName,"Original Bottle");assert.equal(res.body.result.category,"Recyclable");assert.equal(res.body.categoryAssessments.captureId,captureId);assert.equal(res.body.categoryAssessments.schemaVersion,1);assert.equal(res.body.categoryAssessments.aiStatus,"not_requested");
 assert.equal(res.body.categoryAssessments.items.length,res.body.detectedItems.length);assert.equal(writes.history,1);assert.equal(writes.image,1);assert.equal(writes.auth,1);assert.deepEqual(calls,{primary:1,vision:1,discovery:1});
});

test("even assessment module failure cannot trigger fallback or replace primary fields/detections",async()=>{
 const request=input(),service=serviceFixture({assessmentFailure:true,visionObjects:[],objects:[object("white power adapter")]});
 const pending=service.analyzeWaste({image:request.image,objectDiscovery:request,principal:42});await new Promise(resolve=>setImmediate(resolve));service.complete();const result=await pending;
 assert.equal(result.itemName,"Original Bottle");assert.equal(result.explanation,"Original explanation");assert.equal(result.analysisSource,"original");assert.equal(result.detectedItems.length,1);assert.equal(Object.hasOwn(result,"categoryAssessments"),false);assert.deepEqual(service.calls,{primary:1,vision:1,discovery:1});
 assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE_ASSESSMENT_FAILURE/);
});

test("long generic taxonomy cannot outrank a specific identity for the same region",()=>{
 const v=vision("Bottled and jarred packaged goods");
 for(const labels of [["Bottled and jarred packaged goods","Ballpoint Pen"],["Ballpoint Pen","Bottled and jarred packaged goods"]]) {
  const result=merged([v],labels.map(label=>object(label)));
  assert.equal(result.length,1);assert.equal(result[0].itemName,"Ballpoint Pen");
  assert.equal(result[0].identityObservation,"Ballpoint Pen");assert.equal(result[0].requiresConfirmation,true);
  for(const key of ["itemId","boundingBox","confidence","canonicalItem","category","analysisSource"])assert.deepEqual(result[0][key],v[key]);
 }
});
test("refining three independent generic detections preserves all boxes IDs capture metadata and categories",()=>{
 const v=[vision("Packaging"),vision("Packaging",{left:.4,top:.1,right:.6,bottom:.9}),vision("Packaging",{left:.75,top:.1,right:.95,bottom:.9})]
  .map(item=>({...item,captureId:"synthetic-capture",regionId:item.itemId,observedIdentity:item.itemName}));
 const before=JSON.parse(JSON.stringify(v));
 const proposals=v.map(item=>({...normalize([object("Wooden spoon")]).objects[0],boundingBox:{...item.boundingBox}}));
 const result=merge(v,proposals,analysis.samePhysicalObject);
 assert.equal(result.length,3);assert.equal(new Set(result.map(item=>item.itemId)).size,3);
 for(let i=0;i<3;i++) {
  assert.equal(result[i].itemName,"Wooden spoon");
  for(const key of Object.keys(v[i]).filter(key=>key!=="itemName"))assert.deepEqual(result[i][key],v[i][key]);
 }
 assert.deepEqual(v,before);
});
test("conflicting specific identities retain generic uncertainty regardless of order",()=>{
 for(const labels of [["Wooden spoon","Metal fork"],["Metal fork","Wooden spoon"]]) {
  const v=vision("Packaging"),result=merged([v],labels.map(label=>object(label)));
  assert.equal(result.length,1);assert.equal(result[0].itemName,"Packaging");
  assert.equal(result[0].category,"Unknown");assert.equal(result[0].requiresConfirmation,true);
  assert.equal(result[0].identityObservation,undefined);
 }
});
test("ordinary overlap does not establish duplication or permit identity refinement",()=>{
 const v=vision("Bottle"),proposal=normalize([object("Plastic Bottle")]).objects[0];
 proposal.boundingBox={...v.boundingBox,left:.07,right:.27};
 assert.equal(analysis.samePhysicalObject(v,proposal),false);
 assert.equal(merge([v],[proposal],analysis.samePhysicalObject).length,2);
 assert.equal(merge([v],[proposal],analysis.samePhysicalObject)[0].itemName,"Bottle");
});
test("duplicate initial localized regions are deduplicated without ambiguous relabeling",()=>{
 const v=[vision("Packaging"),vision("Packaging")];
 const result=merged(v,[object("Wooden spoon")]);
 assert.equal(result.length,1);assert.equal(result[0].itemId,v[0].itemId);assert.equal(result[0].itemName,"Packaging");
});
test("specific or confirmed Vision identities and established categories are never replaced",()=>{
 for(const v of [vision("Metal fork"),{...vision("Packaging"),confirmed:true},{...vision("Packaging"),category:"Special Waste"}]) {
  const result=merged([v],[object("Wooden spoon")])[0];
  assert.equal(result.itemName,v.itemName);assert.equal(result.category,v.category);
 }
});
test("generic-only and unlocalized observations never invent a specific name",()=>{
 const v=vision("Packaging");
 for(const proposals of [[object("Bottled and jarred packaged goods")],[object("Blue object")],[object("Round container")],[object("Wooden spoon",null)],[]]) {
  assert.equal(merged([v],proposals)[0].itemName,"Packaging");
 }
});

test("same-provider bottle/contents aliases share one strongly aligned physical region",()=>{
 for(const labels of [["Bottle","Soap"],["Soap","Bottle"],["Spray Bottle","Soap"],["Soap","Spray Bottle"]]) {
  const request=input(),proposals=normalize(labels.map(label=>object(label)),request).objects;
  const survivor=proposals.find(item=>/bottle/i.test(item.itemName));
  const result=merge([],proposals,analysis.samePhysicalObject);
  assert.equal(result.length,1);assert.equal(result[0].itemName,survivor.itemName);
  for(const key of ["itemId","captureId","observedIdentity","canonicalItem","boundingBox","category"])
   assert.deepEqual(result[0][key],survivor[key]);
  assert.equal(result[0].category,"Unknown");assert.equal(result[0].requiresConfirmation,true);
 }
});

test("cross-provider conflicting identities retain an observed container without transferring categories",()=>{
 for(const [localName,remoteName] of [["Bottle","Soap"],["Soap","Bottle"]]) {
  const local={...vision(localName),captureId:"local-capture",observedIdentity:localName};
  const before=JSON.parse(JSON.stringify(local));
  const result=merged([local],[object(remoteName)]);
  assert.equal(result.length,1);assert.equal(result[0].itemName,"Bottle");
  for(const key of Object.keys(local).filter(key=>key!=="itemName"))assert.deepEqual(result[0][key],before[key]);
  assert.equal(result[0].category,"Unknown");assert.deepEqual(local,before);
 }
});

test("initial duplicate observations are resolved in either order before discovery merging",()=>{
 const bottle={...vision("Bottle"),captureId:"capture"},soap=vision("Soap");
 for(const initial of [[soap,bottle],[bottle,soap]]) {
  const result=merge(initial,[],analysis.samePhysicalObject);
  assert.equal(result.length,1);assert.equal(result[0].itemName,"Bottle");
  assert.equal(result[0].itemId,bottle.itemId);assert.equal(result[0].captureId,"capture");
  assert.deepEqual(result[0].boundingBox,bottle.boundingBox);
 }
});

test("separate and nested soap is not treated as the bottle's contents alias",()=>{
 for(const region of [[100,400,900,600],[300,100,600,200],[100,150,900,350]]) {
  const result=merged([vision("Bottle")],[object("Soap",region)]);
  assert.equal(result.length,2);assert.equal(new Set(result.map(item=>item.itemId)).size,2);
 }
});

test("strong region matching rejects invalid geometry and tolerates only tiny localization drift",()=>{
 const bottle=vision("Bottle"),soap={...vision("Soap"),boundingBox:{...vision().boundingBox,left:.051,right:.251}};
 assert.equal(analysis.samePhysicalObject(bottle,soap),true);
 for(const boundingBox of [{...soap.boundingBox,left:NaN},{...soap.boundingBox,right:.01},
  {...soap.boundingBox,left:-.1},{...soap.boundingBox,top:null}]) {
  assert.equal(analysis.samePhysicalObject(bottle,{...soap,boundingBox}),false);
 }
});

test("final physical count and assessments agree before any per-item assessment, preserving primary",async()=>{
 for(const visionObjects of [[],[{name:"Bottle",confidence:.8,boundingBox:vision().boundingBox},
  {name:"Soap",confidence:.99,boundingBox:vision().boundingBox}]]) {
  const request=input(),service=serviceFixture({objects:[object("Soap"),object("Bottle")],visionObjects});
  const pending=service.analyzeWaste({image:request.image,objectDiscovery:request,principal:42});
  await new Promise(resolve=>setImmediate(resolve));service.complete();const result=await pending;
  assert.equal(result.detectedItems.length,1);assert.equal(result.detectedItems[0].itemName,"Bottle");
  assert.equal(result.scanSummary.totalItems,1);assert.equal(result.detectedItems[0].category,"Unknown");
  assert.equal(result.categoryAssessments.captureId,request.captureId);
  assert.equal(result.categoryAssessments.items.length,1);
  assert.equal(result.categoryAssessments.items[0].itemId,result.detectedItems[0].itemId);
  const fromGemini = visionObjects.length === 0;
  // Bottle/Soap observations conflict even when Gemini owns the survivor.
  // The independent original primary remains untouched below.
  assert.equal(result.categoryAssessments.items[0].category,"Unknown");
  assert.equal(result.categoryAssessments.items[0].assessmentSource,fromGemini?"insufficient_evidence":"existing_category");
  assert.equal(result.categoryAssessments.aiStatus,"not_requested");
  assert.equal(result.itemName,"Original Bottle");assert.equal(result.category,"Recyclable");
  assert.equal(result.explanation,"Original explanation");assert.equal(result.action,"Original action");
  assert.equal(result.warning,"Original warning");assert.equal(result.aiConfidence,"0.91");
  assert.deepEqual(service.calls,{primary:1,vision:1,discovery:1});
 }
});
