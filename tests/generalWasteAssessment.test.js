"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),fs=require("node:fs"),path=require("node:path"),{EventEmitter}=require("node:events");
const contract=require("../gemini-waste-classifier-cloudrun/wasteItemAssessment");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
const shared=require("../gemini-waste-classifier-cloudrun/cropRecognition");
const {createAssessmentService,deterministic}=require("../services/perItemWasteAssessmentService");
const {merge}=require("../services/wholeImageRecognitionService");
const {samePhysicalObject}=require("../services/wasteAnalysisService");
function scene(labels=["unlisted electrical device"]){
 const capture={requestId:crypto.randomUUID(),captureId:crypto.randomUUID(),image:Buffer.from([255,216,255,192,0,11,8,1,144,2,88,1,1,17,0,255,217]).toString("base64"),width:600,height:400,orientation:"upright"};
 return {capture,items:whole.normalize(capture,{objects:labels.map((label,i)=>({label,box_2d:[100,10+i*120,900,70+i*120]}))}).objects,principal:42};
}
const facts=(item,category="Special Waste",kind="electrical",material="mixed",condition="unknown",evidence="visible")=>({itemId:item.itemId,category,kind,material,condition,evidence});
const reply=(input,make=item=>facts(item))=>({schemaVersion:1,requestId:input.requestId,captureId:input.captureId,assessments:input.items.map(make)});
const env={WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"true",WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"synthetic-assessment-token-over-32-characters",CLOUD_RUN_AUTH_MODE:"iam",CLOUD_RUN_AUDIENCE:"https://synthetic.invalid",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste"};
function service({config={},make=item=>facts(item),error,clock}={}){
 const calls=[];const assess=createAssessmentService({env:{...env,...config},...(clock?{now:()=>clock.time}:{}),authHeaders:async(url,options)=>{calls.push({auth:true,url,timeout:options.timeoutMs});return {Authorization:"Bearer synthetic"};},transport:async(url,input,options)=>{calls.push({input,url,timeout:options.timeoutMs});if(error)throw error;return reply(input,make);}});
 return {assess,calls};
}
const examples=[
 ["banana peel","Biodegradable"],["vegetable scraps","Biodegradable"],["fruit peels","Biodegradable"],["plant-only food scraps","Biodegradable"],
 ["plastic water bottle","Recyclable"],["cardboard","Recyclable"],["clean dry paper","Recyclable"],["empty aluminum can","Recyclable"],
 ["snack wrapper","Residual"],["phone charger","Special Waste"],["power adapter","Special Waste"],["battery","Special Waste"],["electronic circuit board","Special Waste"],
 ["food scraps","Unknown"],["paper","Unknown"],["glass bottle","Recyclable"],["gray round container","Unknown"],["generic bottle","Unknown"],
 ["unidentified plastic-looking object","Unknown"],["ambiguous packaging","Unknown"],["unknown mixed-material object","Unknown"],
 ["condition cannot be confirmed","Unknown"],["unsupported identity","Unknown"],["used tissue","Unknown"],["mixed contaminated packaging","Unknown"],
 ["vegetable scraps printed on packaging","Unknown"],["electronic circuit board picture","Unknown"]
];
for(const [label,category]of examples)test(`diverse deterministic dataset: ${label} -> ${category}`,()=>{
 const input=scene([label]),saved=structuredClone(input.items),[a]=deterministic(input.items);assert.equal(a.category,category);assert.equal(a.requiresConfirmation,true);assert.deepEqual(input.items,saved);
 if(category==="Unknown"){assert.deepEqual(a.guidance.reuseIdeas,[]);assert.deepEqual(a.guidance.recoveryOptions,[]);assert.match(a.guidance.properDisposal,/Confirm identity, material and condition/);}
});
const evidenceCases=[
 ["unlisted garden trimmings","Biodegradable","plant_food_scraps","plant_matter","food_only","Biodegradable"],
 ["unlisted paper sleeve","Recyclable","single_material","paper","clean_dry","Recyclable"],
 ["aluminum can","Recyclable","single_material","aluminum","clean_dry","Recyclable"],
 ["glass bottle","Recyclable","single_material","glass","clean_dry","Recyclable"],
 ["marked PET object","Recyclable","single_material","pet_plastic","clean_dry","Recyclable"],
 ["non-recyclable wrapper","Residual","wrapper","mixed","non_recyclable","Residual"],
 ["used tissue","Residual","tissue","paper","used_nonhazardous","Unknown"],
 ["mixed contaminated packaging","Residual","mixed_packaging","mixed","contaminated_nonhazardous","Unknown"],
 ["unlisted karaoke remote","Special Waste","electrical","mixed","unknown","Special Waste"],
 ["gray round container","Recyclable","single_material","unknown","unknown","Unknown"],
 ["green plastic-looking object","Recyclable","single_material","unknown","clean_dry","Unknown"],
 ["unknown mixed-material object","Recyclable","single_material","mixed","clean_dry","Unknown"],
 ["food scraps of uncertain composition","Biodegradable","plant_food_scraps","unknown","food_only","Unknown"],
 ["paper with uncertain condition","Recyclable","single_material","paper","unknown","Unknown"],
 ["contradictory electrical plant","Special Waste","electrical","plant_matter","food_only","Unknown"],
 ["conflicting category claim","Biodegradable","electrical","mixed","unknown","Unknown"]
];
for(const [label,category,kind,material,condition,expected]of evidenceCases)test(`bounded evidence assessment: ${label} -> ${expected}`,async()=>{
 const {assess,calls}=service({make:item=>facts(item,category,kind,material,condition)}),input=scene([label]),before=structuredClone(input.items);
 const result=await assess(input);assert.equal(result.items[0].category,expected);assert.equal(result.items[0].requiresConfirmation,true);assert.equal(result.items[0].assessmentSource,"ai_assisted");assert.deepEqual(input.items,before);assert.equal(calls.filter(c=>c.input).length,1);
 assert.deepEqual(result.items[0].guidance.reuseIdeas,[]);assert.ok(result.items[0].confirmationRequirements.length);
});
test("both new flags default off independently; safe rules never cause inference",async()=>{
 for(const config of [{WASTE_ITEM_ASSESSMENT_ENABLED:undefined},{WASTE_ITEM_ASSESSMENT_ENABLED:"false"},{WASTE_ITEM_ASSESSMENT_AI_ENABLED:undefined},{WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"}]){
  const {assess,calls}=service({config}),result=await assess(scene());assert.equal(calls.length,0);if(config.WASTE_ITEM_ASSESSMENT_ENABLED!==undefined&&config.WASTE_ITEM_ASSESSMENT_ENABLED!=="false")assert.equal(result.aiStatus,"not_requested");
 }
 const {assess,calls}=service();const result=await assess(scene(["banana peel","phone charger"]));assert.equal(calls.length,0);assert.equal(result.aiStatus,"not_requested");
});
test("3-8 object mixed scenes use one unknown-only batch and preserve every current detection",async()=>{
 for(let count=3;count<=8;count++){
  const labels=["banana peel","power adapter",...Array.from({length:count-2},(_,i)=>`previously unseen electronic object ${i}`)],input=scene(labels),saved=structuredClone(input.items);
  const {assess,calls}=service();const result=await assess(input);assert.equal(result.items.length,count);assert.equal(calls.filter(c=>c.input).length,1);assert.equal(calls.find(c=>c.input).input.items.length,count-2);assert.deepEqual(input.items,saved);
  assert.equal(new Set(result.items.map(i=>i.itemId)).size,count);assert.equal(result.items[0].category,"Biodegradable");assert.ok(result.items.slice(1).every(i=>i.category==="Special Waste"));
 }
});
test("reversed model order and caller item order do not affect identity matching or repeat billing",async()=>{
 const input=scene(["unseen electrical one","unseen electrical two"]);let calls=0;
 const assess=createAssessmentService({env,authHeaders:async()=>({}),transport:async(url,body)=>{calls++;const r=reply(body);r.assessments.reverse();return r;}});
 const first=await assess(input),second=await assess({...input,capture:{...input.capture,requestId:crypto.randomUUID()},items:[...input.items].reverse()});
 assert.equal(calls,1);assert.deepEqual(first.items.map(i=>i.itemId).sort(),second.items.map(i=>i.itemId).sort());assert.ok(second.items.every(i=>i.category==="Special Waste"));
});
test("failed capture is cached too; changed bytes/objects cannot resubmit under its identity",async()=>{
 const input=scene(),{assess,calls}=service({error:new Error("PRIVATE_PROVIDER_TOKEN_IMAGE_MUST_NOT_ESCAPE")});
 assert.equal((await assess(input)).aiStatus,"unavailable");assert.equal((await assess(input)).aiStatus,"unavailable");assert.equal((await assess({...input,items:scene().items})).aiStatus,"unavailable");assert.equal(calls.filter(c=>c.input).length,1);
 const serialized=JSON.stringify(await assess(input));assert.doesNotMatch(serialized,/PRIVATE_PROVIDER|Bearer|synthetic-assessment-token/);
});
test("IAM, URL, principal, cancellation and shared-token failures cannot make assessment calls",async()=>{
 for(const config of [{CLOUD_RUN_AUTH_MODE:"shared_token"},{CLOUD_RUN_AUTH_MODE:undefined},{CLOUD_RUN_AUDIENCE:"https://other.invalid"},{GEMINI_WASTE_ASSESSMENT_URL:"http://synthetic.invalid/v1/assess-waste-items"},{GEMINI_WASTE_ASSESSMENT_URL:"https://synthetic.invalid/discover-objects"},{WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"short"}]){
  const {assess,calls}=service({config});assert.equal((await assess(scene())).aiStatus,"unavailable");assert.equal(calls.length,0);
 }
 for(const principal of [undefined,0,"bad"]){const {assess,calls}=service();await assess({...scene(),principal});assert.equal(calls.length,0);}
 const c=new AbortController();c.abort();const {assess,calls}=service();await assess({...scene(),signal:c.signal});assert.equal(calls.length,0);
});
test("request/response schemas reject category-only claims, extra secrets, invalid IDs, stale captures and malformed geometry",()=>{
 const s=scene(),input=contract.validateRequest({schemaVersion:1,...s.capture,items:s.items.map(({itemId,observedIdentity,boundingBox})=>({itemId,observedIdentity,boundingBox}))});
 for(const patch of [{schemaVersion:2},{captureId:crypto.randomUUID()},{requestId:crypto.randomUUID()},{secret:"synthetic"},{assessments:[]}])assert.throws(()=>contract.validateResponse(input,{...reply(input),...patch}));
 for(const patch of [{category:"Landfill"},{confidence:.9},{material:"looks blue"},{itemId:"region_forged"},{condition:"chemically_safe"},{guidance:"provider advice"},{evidence:"user_confirmed"}])assert.throws(()=>contract.validateResponse(input,{...reply(input),assessments:[{...facts(input.items[0]),...patch}]}));
 assert.throws(()=>contract.validateResponse(input,{...reply(input),assessments:[{itemId:input.items[0].itemId,category:"Recyclable"}]}));
 for(const patch of [{schemaVersion:2},{items:[]},{items:Array(9).fill(input.items[0])},{image:"bad"},{width:400},{items:[{...input.items[0],boundingBox:{left:0,top:0,right:0,bottom:1}}]},{items:[input.items[0],input.items[0]]}])assert.throws(()=>contract.validateRequest({...input,...patch}));
});
test("valid-shaped but inconsistent/insufficient model statements never become authoritative",async()=>{
 const {assess}=service({make:item=>facts(item,"Special Waste","electrical","mixed","unknown","insufficient")});const result=await assess(scene());assert.equal(result.items[0].category,"Unknown");assert.equal(result.items[0].requiresConfirmation,true);
 const {assess:bad}=service({make:item=>({...facts(item),confidence:.99})});assert.equal((await bad(scene())).aiStatus,"unavailable");
});
test("separate captures and principals cannot share assessments; concurrent identical calls bill once",async()=>{
 const {assess,calls}=service(),s=scene();await Promise.all([assess(s),assess(s)]);assert.equal(calls.filter(c=>c.input).length,1);
 await assess({...s,principal:43});await assess(scene());assert.equal(calls.filter(c=>c.input).length,3);
});
test("Vision Unknown items receive sidecar suggestions but established categories/recognition remain unchanged",async()=>{
 for(const category of ["Unknown","Recyclable"]) {
  const s=scene();s.items[0]={...s.items[0],analysisSource:"google_vision_object_localization",category,confidence:.87};
  const before=structuredClone(s.items),{assess,calls}=service(),result=await assess(s);
  assert.deepEqual(s.items,before);
  assert.equal(calls.filter(c=>c.input).length,category==="Unknown"?1:0);
  assert.equal(result.items[0].category,category==="Unknown"?"Special Waste":"Recyclable");
  assert.equal(result.items[0].itemId,s.items[0].itemId);
 }
});
function response(){const res=new EventEmitter();res.status=c=>{res.statusCode=c;return res;};res.json=x=>{res.body=x;res.writableEnded=true;res.emit("finish");return res;};return res;}
test("new Cloud endpoint authenticates before inference, pins model and bounds one full-image batch",async()=>{
 const s=scene(["unseen one","unseen two"]),input=contract.validateRequest({schemaVersion:1,...s.capture,items:s.items.map(({itemId,observedIdentity,boundingBox})=>({itemId,observedIdentity,boundingBox}))});let calls=0;
 const handler=contract.createCloudHandler({env:{...env,GEMINI_API_KEY:"synthetic-provider-key"},transport:async(url,body,options)=>{calls++;assert.match(url,/gemini-2.5-flash:generateContent$/);assert.equal(body.generationConfig.maxOutputTokens,2048);assert.equal(body.contents[0].parts.filter(p=>p.inlineData).length,1);assert.ok(options.timeoutMs>0&&options.timeoutMs<=10000);return {candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({assessments:reply(input).assessments})}]}}]};}});
 const req=new EventEmitter();req.body=input;req.get=()=>env.WASTE_ITEM_ASSESSMENT_SHARED_TOKEN;const res=response();await handler(req,res);assert.equal(res.body.schemaVersion,1);assert.equal(calls,1);
 const disabled=response();await contract.createCloudHandler({env:{},transport:async()=>{throw Error("Forbidden");}})(req,disabled);assert.equal(disabled.statusCode,503);
 req.get=()=>"wrong";const denied=response();await handler(req,denied);assert.equal(denied.statusCode,401);assert.equal(calls,1);
});
test("new route is separately mounted, disabled/auth-checked before body parsing",()=>{
 let route,chain,parsed=0;contract.mount({post(url,...handlers){route=url;chain=handlers;}},{json(){parsed++;return ()=>{};}},{env:{}});
 assert.equal(route,"/v1/assess-waste-items");const req=new EventEmitter(),res=response();req.get=()=>"";chain[0](req,res,()=>assert.fail("Disabled must not parse"));assert.equal(res.statusCode,503);assert.equal(parsed,0);
});
test("discovery v1 survives unchanged and satisfies the actual current Android parser restrictions",()=>{
 const s=scene(["power adapter","gray round container","plastic bottle"]),items=merge([],s.items,samePhysicalObject);
 assert.equal(items.length,3);assert.ok(items.filter(i=>i.observedIdentity!=="plastic bottle").every(i=>i.category==="Unknown"));
 for(const i of items)for(const key of ["guidance","modelKey","modelHotspots","confidence"])assert.equal(Object.hasOwn(i,key),false);
 assert.deepEqual(whole.validateResponse(s.capture,{success:true,requestId:s.capture.requestId,captureId:s.capture.captureId,objects:items}).objects,items);
 const java=fs.readFileSync("C:/Users/ADMIN/AndroidStudioProjects/AIWasteManagementSystem-LATEST/app/src/main/java/com/example/aiwastemanagementsystem/DetectedWasteItem.java","utf8");
 assert.match(java,/GEMINI_CATEGORY_IDENTITY_MISMATCH/);assert.match(java,/GEMINI_METADATA_DISALLOWED/);
 assert.equal(items.find(i=>i.observedIdentity==="power adapter").category,"Unknown");assert.equal(deterministic(items).find(i=>i.itemId===items.find(x=>x.observedIdentity==="power adapter").itemId).category,"Special Waste");
});
test("same-named duplicate physical objects keep distinct IDs, boxes and assessments",async()=>{
 const input=scene(["unseen remote","unseen remote"]),{assess}=service();const result=await assess(input);assert.equal(new Set(result.items.map(i=>i.itemId)).size,2);assert.notDeepEqual(input.items[0].boundingBox,input.items[1].boundingBox);
});
test("new sources do not log inputs, load dotenv/DB or persist images; unknown has no disposal stream/model/tutorial",()=>{
 for(const name of ["services/perItemWasteAssessmentService.js","gemini-waste-classifier-cloudrun/wasteItemAssessment.js"]){const source=fs.readFileSync(path.join(__dirname,"..",name),"utf8");assert.doesNotMatch(source,/console\.|dotenv|config\/db|mysql|writeFile|INSERT INTO/);}
 const unknown=deterministic(scene(["gray round container"]).items)[0];assert.doesNotMatch(JSON.stringify(unknown.guidance),/landfill|residual|compost|recycl|planter/i);
 const body=contract.geminiBody(contract.validateRequest({schemaVersion:1,...scene().capture,items:scene().items.map(({itemId,observedIdentity,boundingBox})=>({itemId,observedIdentity,boundingBox}))}));assert.match(body.contents[0].parts[0].text,/Do not infer material from color/);assert.match(body.contents[0].parts[0].text,/No confidence scores/);
});

test("assessment deadline subtracts IAM time and budget refuses extra captures without retries",async()=>{
 let time=1700000000000,calls=0;
 const assess=createAssessmentService({env,now:()=>time,budget:shared.createBudget({perUser:1}),authHeaders:async()=>{time+=25;return {};},transport:async(url,body,options)=>{calls++;assert.equal(options.timeoutMs,11975);return reply(body);}});
 assert.equal((await assess(scene())).aiStatus,"complete");assert.equal((await assess(scene())).aiStatus,"unavailable");assert.equal(calls,1);
});
test("cancellation during IAM acquisition cannot reach model transport",async()=>{
 const controller=new AbortController();let calls=0;
 const assess=createAssessmentService({env,authHeaders:async()=>{controller.abort();return {};},transport:async()=>{calls++;throw Error("Forbidden");}});
 assert.equal((await assess({...scene(),signal:controller.signal})).aiStatus,"unavailable");assert.equal(calls,0);
});
test("batch duplicate, missing and foreign IDs invalidate assessments without removing detections",async()=>{
 const input=scene(["unseen first","unseen second"]);
 for(const transform of [a=>[a[0]],a=>[a[0],a[0]],a=>[a[0],{...a[1],itemId:"region_"+"f".repeat(32)}]]){
  const assess=createAssessmentService({env,authHeaders:async()=>({}),transport:async(url,body)=>({...reply(body),assessments:transform(reply(body).assessments)})});
  const result=await assess(input);assert.equal(result.aiStatus,"unavailable");assert.equal(result.items.length,2);assert.ok(result.items.every(a=>a.category==="Unknown"));
 }
});
test("authorized-route guard still rejects a wrong shared token before JSON parsing",()=>{
 let chain,parsed=0;contract.mount({post(url,...handlers){chain=handlers;}},{json(){parsed++;return ()=>{};}},{env:{...env,GEMINI_API_KEY:"synthetic"}});
 const req=new EventEmitter(),res=response();req.get=()=>"wrong";chain[0](req,res,()=>assert.fail("No parsing allowed"));assert.equal(res.statusCode,401);assert.equal(parsed,0);
});
test("Cloud output validation errors expose neither provider payload nor image/key content",async()=>{
 const s=scene(),input=contract.validateRequest({schemaVersion:1,...s.capture,items:s.items.map(({itemId,observedIdentity,boundingBox})=>({itemId,observedIdentity,boundingBox}))});
 const handler=contract.createCloudHandler({env:{...env,GEMINI_API_KEY:"PRIVATE_KEY_SENTINEL"},transport:async()=>({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({assessments:[{...facts(input.items[0]),confidence:.9}],privateKey:"PRIVATE_KEY_SENTINEL"})}]}}]})});
 const req=new EventEmitter(),res=response();req.body=input;req.get=()=>env.WASTE_ITEM_ASSESSMENT_SHARED_TOKEN;await handler(req,res);assert.equal(res.statusCode,502);assert.doesNotMatch(JSON.stringify(res.body),/PRIVATE_KEY|confidence|image|Bearer/);
});
