"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),path=require("node:path"),crypto=require("node:crypto"),fs=require("node:fs"),vm=require("node:vm"),{EventEmitter}=require("node:events");
const {createCloudRunAuth,validateCloudRunTarget}=require("../services/cloudRunAuth");
const audience="https://gemini-waste-classifier-staging-2lzk3t3i7q-uc.a.run.app",endpoint=audience+"/classify-waste";
const taggedEndpoint="https://a9-43847bc---gemini-waste-classifier-staging-2lzk3t3i7q-uc.a.run.app/classify-waste";
const railway=require("../config/railwayStaging");
const env={WMO_DEPLOYMENT_MODE:"staging",STAGING_WASTE_SCAN_ONLY:"true",STAGING_DATABASE_ISOLATION_CONFIRMED:"true",
 STAGING_ALLOW_SCHEMA_CHANGES:"false",STAGING_DATABASE_TRANSPORT:"railway_private",RAILWAY_PROJECT_ID:railway.PROJECT_ID,
 RAILWAY_ENVIRONMENT_ID:railway.ENVIRONMENT_ID,RAILWAY_SERVICE_ID:"11111111-1111-1111-1111-111111111111",
 CLOUD_RUN_AUTH_MODE:"iam",CLOUD_RUN_AUDIENCE:audience,CLOUD_RUN_CALLER_CREDENTIALS_FILE:path.resolve(require("node:os").tmpdir(),"synthetic-caller-not-created.json")};
const syntheticKey=crypto.generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"});
const now=Date.now();const token=(patch={})=>"synthetic."+Buffer.from(JSON.stringify({aud:audience,iss:"https://accounts.google.com",exp:Math.floor(now/1000)+3600,...patch})).toString("base64url")+".signature";
function fixture(overrides={},behavior={}) {const calls=[];const auth=createCloudRunAuth({env:{...env,...overrides},now:()=>now,
 readFile(){calls.push("read");return JSON.stringify({type:"service_account",client_email:"wmo-render-staging-caller@gen-lang-client-0282087033.iam.gserviceaccount.com",private_key:syntheticKey});},
 loadLibrary(){calls.push("sdk");return {JWT:class {constructor(options){calls.push(options);this.transporter={request:async options=>{calls.push(options);return {};}};}async fetchIdToken(aud){calls.push(aud);await this.transporter.request({retry:true,timeout:999999});if(behavior.hang)return new Promise(()=>{});if(behavior.error)throw Error("SECRET_MUST_NOT_ESCAPE");return token(behavior.payload);}}};}});return {auth,calls};}
test("tagged staging IAM uses the canonical audience and shares its token cache",async()=>{
 const {auth,calls}=fixture();assert.equal((await auth(taggedEndpoint)).Authorization,"Bearer "+token());
 await auth(endpoint);assert.equal(calls.filter(x=>x==="read").length,1);
 assert.equal(calls.filter(x=>x===audience).length,1);assert.ok(!calls.includes(new URL(taggedEndpoint).origin));
});

test("IAM obtains Google ID token for service origin, caches it and disables SDK retries",async()=>{
 const {auth,calls}=fixture();assert.equal((await auth(endpoint)).Authorization,"Bearer "+token());await auth(audience+"/classify-waste");
 assert.equal(calls.filter(x=>x==="read").length,1);assert.ok(calls.includes(audience));const request=calls.find(x=>x?.retry===false);assert.equal(request.timeout,2000);assert.equal(request.retryConfig.retry,0);assert.ok(request.signal);
});
for(const [name,patch] of Object.entries({missingMode:{CLOUD_RUN_AUTH_MODE:undefined},badMode:{CLOUD_RUN_AUTH_MODE:"none"},missingAudience:{CLOUD_RUN_AUDIENCE:undefined},pathAudience:{CLOUD_RUN_AUDIENCE:endpoint},insecure:{CLOUD_RUN_AUDIENCE:"http://staging-example.run.app"},missingCredentials:{CLOUD_RUN_CALLER_CREDENTIALS_FILE:undefined},relativeCredentials:{CLOUD_RUN_CALLER_CREDENTIALS_FILE:"key.json"},repoCredentials:{CLOUD_RUN_CALLER_CREDENTIALS_FILE:path.resolve(__dirname,"key.json")}}))
 test("IAM rejects "+name,async()=>{const {auth}=fixture(patch);await assert.rejects(auth(endpoint),{code:"CLOUD_RUN_AUTH_UNAVAILABLE"});});
test("IAM never sends a token to another origin or a credential-bearing URL",async()=>{const {auth,calls}=fixture();for(const url of ["https://elsewhere.invalid/discover-objects",audience+"/discover-objects?token=hidden","https://user:pass@staging-example.run.app/discover-objects"])await assert.rejects(auth(url));assert.equal(calls.length,0);});
test("legacy non-staging invocation remains unauthenticated unless explicitly configured",async()=>assert.deepEqual(await createCloudRunAuth({env:{},loadLibrary(){throw Error("Must not load");}})(endpoint),{}));
test("IAM errors are sanitized",async()=>{const {auth}=fixture({}, {error:true});await assert.rejects(auth(endpoint),e=>e.message==="Cloud Run authentication unavailable."&&!JSON.stringify(e).includes("SECRET"));});
test("missing library or malformed credentials fail closed",async()=>{for(const options of [{readFile(){throw Error("private-path");}},{readFile:()=>"{}"},{readFile:()=>JSON.stringify({type:"authorized_user"})},{readFile:()=>JSON.stringify({type:"service_account",client_email:"wmo-render-staging-caller@gen-lang-client-0282087033.iam.gserviceaccount.com",private_key:syntheticKey}),loadLibrary(){throw Error("missing-sdk");}}])await assert.rejects(createCloudRunAuth({env,...options})(endpoint),{code:"CLOUD_RUN_AUTH_UNAVAILABLE"});});
for(const payload of [{aud:"https://staging-example.run.app/discover-objects"},{exp:1},{iss:"untrusted"}])test("invalid returned ID token is never forwarded: "+JSON.stringify(payload),async()=>{const {auth}=fixture({}, {payload});await assert.rejects(auth(endpoint));});

const rejectedTargets = [
 ["other tag", taggedEndpoint.replace("a9-43847bc---", "other---")],
 ["lookalike tag", taggedEndpoint.replace("a9-43847bc---", "a9-43847bc-extra---")],
 ["other service", taggedEndpoint.replace("staging-2lzk", "production-2lzk")],
 ["other service hash", taggedEndpoint.replace("2lzk3t3i7q", "otherhash")],
 ["suffix spoof", taggedEndpoint.replace(".app/", ".app.attacker.invalid/")],
 ["canonical wrong service", "https://other.run.app/classify-waste"],
 ["insecure", taggedEndpoint.replace("https:", "http:")],
 ["non-HTTP", taggedEndpoint.replace("https:", "ftp:")],
 ["default port", taggedEndpoint.replace(".app/", ".app:443/")],
 ["other port", taggedEndpoint.replace(".app/", ".app:8443/")],
 ["userinfo", taggedEndpoint.replace("https://", "https://user:pass@")],
 ["empty userinfo", taggedEndpoint.replace("https://", "https://@")],
 ["query", taggedEndpoint + "?override=1"], ["empty query", taggedEndpoint + "?"],
 ["fragment", taggedEndpoint + "#override"], ["empty fragment", taggedEndpoint + "#"],
 ["alternate path", taggedEndpoint.replace("classify-waste", "discover-objects")],
 ["trailing slash", taggedEndpoint + "/"], ["escaped path", taggedEndpoint.replace("classify", "%63lassify")],
 ["normalized traversal", taggedEndpoint.replace("/classify", "/unused/../classify")],
 ["backslash", taggedEndpoint.replace("/classify", "\\classify")],
 ["leading whitespace", " " + taggedEndpoint], ["trailing newline", taggedEndpoint + "\n"],
 ["encoded host", taggedEndpoint.replace("a9-", "%619-")],
 ["relative", "/classify-waste"], ["malformed", "not-a-url"], ["missing", undefined]
];
for (const [name, destination] of rejectedTargets) test("staging URL policy rejects " + name + " before credentials or SDK access", async () => {
 const {auth,calls}=fixture();await assert.rejects(auth(destination),{code:"CLOUD_RUN_AUTH_UNAVAILABLE"});assert.equal(calls.length,0);
});

test("staging URL policy rejects wrong audiences, Railway identity and conflicting aliases before credential access",async()=>{
 const patches=[{RAILWAY_PROJECT_ID:"wrong"},{RAILWAY_ENVIRONMENT_ID:"wrong"},{RAILWAY_SERVICE_ID:"f72af026-d49f-4833-b126-72de120962a5"},
  {RAILWAY_SERVICE_ID:undefined},{STAGING_WASTE_SCAN_ONLY:"false"},{STAGING_DATABASE_ISOLATION_CONFIRMED:"false"},
  {STAGING_ALLOW_SCHEMA_CHANGES:"true"},{STAGING_DATABASE_TRANSPORT:"external_tls"},{NODE_TLS_REJECT_UNAUTHORIZED:"0"},
  ...[new URL(taggedEndpoint).origin,"https://other.run.app",audience+":443",audience+"?",audience+"#",audience+"/classify-waste", " "+audience].map(CLOUD_RUN_AUDIENCE=>({CLOUD_RUN_AUDIENCE})),
  {GEMINI_CLASSIFIER_URL:taggedEndpoint,CLOUD_RUN_GEMINI_CLASSIFIER_URL:endpoint},
  {GEMINI_CLASSIFIER_URL:taggedEndpoint,CLOUD_RUN_GEMINI_CLASSIFIER_URL:""},
  {GEMINI_CLASSIFIER_URL:"https://other.run.app/classify-waste"}];
 for(const patch of patches){const {auth,calls}=fixture(patch);await assert.rejects(auth(taggedEndpoint),{code:"CLOUD_RUN_AUTH_UNAVAILABLE"});assert.equal(calls.length,0,JSON.stringify(patch));}
});

test("staging rejects invalid destinations and identity changes after the canonical cache is populated",async()=>{
 const runtimeEnv={...env};let reads=0,exchanges=0;
 const auth=createCloudRunAuth({env:runtimeEnv,now:()=>now,readFile(){reads++;return JSON.stringify({type:"service_account",client_email:"wmo-render-staging-caller@gen-lang-client-0282087033.iam.gserviceaccount.com",private_key:syntheticKey});},
  loadLibrary:()=>({JWT:class{constructor(){this.transporter={request:async()=>({})};}async fetchIdToken(aud){exchanges++;assert.equal(aud,audience);return token();}}})});
 await auth(taggedEndpoint);for(const [,url] of rejectedTargets)await assert.rejects(auth(url));
 runtimeEnv.RAILWAY_PROJECT_ID="wrong";await assert.rejects(auth(taggedEndpoint));runtimeEnv.RAILWAY_PROJECT_ID=env.RAILWAY_PROJECT_ID;
 runtimeEnv.CLOUD_RUN_GEMINI_CLASSIFIER_URL=endpoint;await assert.rejects(auth(taggedEndpoint));
 assert.equal(reads,1);assert.equal(exchanges,1);
});

test("approved canonical staging compatibility remains available but A9 proposals require the tagged destination",async()=>{
 for(const destination of [endpoint,taggedEndpoint]){const {auth}=fixture({GEMINI_CLASSIFIER_URL:destination,CLOUD_RUN_GEMINI_CLASSIFIER_URL:destination});assert.ok((await auth(destination)).Authorization);}
 const {auth,calls}=fixture({WMO_CLASSIFY_OBJECT_PROPOSALS_ENABLED:"true"});await assert.rejects(auth(endpoint));assert.equal(calls.length,0);assert.ok((await auth(taggedEndpoint)).Authorization);
});

test("production preserves same-origin paths and rejects the staging cross-origin exception",async()=>{
 const {auth,calls}=fixture({WMO_DEPLOYMENT_MODE:"production"});await auth(audience+"/discover-objects");await auth(endpoint);
 await assert.rejects(auth(taggedEndpoint));assert.equal(calls.filter(x=>x==="read").length,1);
});

test("shared staging URL validation is pure and permits a canonical audience trailing slash",()=>{
 const input={...env,CLOUD_RUN_AUDIENCE:audience+"/",GEMINI_CLASSIFIER_URL:taggedEndpoint};const before={...input};
 const result=validateCloudRunTarget(taggedEndpoint,Object.freeze(input));assert.equal(result.audience.origin,audience);assert.equal(result.target.href,taggedEndpoint);assert.deepEqual(input,before);
});

test("staging token refresh remains tied to the canonical audience",async()=>{
 let clock=now,exchanges=0;
 const auth=createCloudRunAuth({env,now:()=>clock,readFile:()=>JSON.stringify({type:"service_account",client_email:"wmo-render-staging-caller@gen-lang-client-0282087033.iam.gserviceaccount.com",private_key:syntheticKey}),
  loadLibrary:()=>({JWT:class{constructor(){this.transporter={request:async()=>({})};}async fetchIdToken(aud){exchanges++;assert.equal(aud,audience);return token({exp:Math.floor(clock/1000)+3600});}}})});
 const first=await auth(taggedEndpoint);clock+=3541000;const refreshed=await auth(taggedEndpoint);assert.notEqual(refreshed.Authorization,first.Authorization);await auth(endpoint);assert.equal(exchanges,2);
});

test("approved tagged transport still rejects a different service-account identity before token exchange",async()=>{
 let reads=0,sdk=0;
 const auth=createCloudRunAuth({env,readFile(){reads++;return JSON.stringify({type:"service_account",client_email:"different@gen-lang-client-0282087033.iam.gserviceaccount.com",private_key:syntheticKey});},loadLibrary(){sdk++;throw Error("Must not exchange");}});
 await assert.rejects(auth(taggedEndpoint),error=>error.code==="CLOUD_RUN_AUTH_UNAVAILABLE"&&require("../services/cloudRunDiagnostics").diagnostic(error).stage==="credential_format_validation");assert.equal(reads,1);assert.equal(sdk,0);
});
test("token acquisition is bounded and cancellation prevents forwarding",async()=>{const {auth,calls}=fixture({}, {hang:true});await assert.rejects(auth(endpoint,{timeoutMs:15}),{code:"CLOUD_RUN_AUTH_UNAVAILABLE"});assert.equal(calls.find(x=>x?.retry===false).signal.aborted,true);const controller=new AbortController();controller.abort();const f=fixture();await assert.rejects(f.auth(endpoint,{signal:controller.signal}));assert.equal(f.calls.length,0);});
test("discovery retains shared-token header alongside IAM and remains off without calls",async()=>{
 const {createDiscoveryService}=require("../services/wholeImageRecognitionService"),whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
 const input={requestId:crypto.randomUUID(),captureId:crypto.randomUUID(),image:Buffer.from([255,216,255,192,0,11,8,1,144,2,88,1,1,17,0,255,217]).toString("base64"),width:600,height:400,orientation:"upright"};let calls=0;
 const options={env:{...env,WHOLE_IMAGE_DISCOVERY_ENABLED:"true",WHOLE_IMAGE_DISCOVERY_SHARED_TOKEN:"synthetic-shared-token-longer-than-32",GEMINI_WHOLE_IMAGE_URL:endpoint},authHeaders:async url=>{assert.equal(url,endpoint);return {Authorization:"Bearer synthetic"};},transport:async(url,body,opts)=>{calls++;assert.equal(opts.headers.Authorization,"Bearer synthetic");assert.ok(opts.headers["X-Whole-Image-Token"]);assert.ok(opts.timeoutMs<=12000);return whole.normalize(body,{objects:[]});}};
 await createDiscoveryService(options)(input,{principal:1});assert.equal(calls,1);await assert.rejects(createDiscoveryService({...options,env:{...options.env,WHOLE_IMAGE_DISCOVERY_ENABLED:"false"}})(input,{principal:1}));assert.equal(calls,1);
});
for(const failAuth of [false,true]) test(failAuth ? "private primary IAM failure cannot bypass auth through direct Gemini" : "primary classifier uses same IAM helper and preserves primary result",async()=>{
 const source=fs.readFileSync(path.join(__dirname,"../services/wasteAnalysisService.js"),"utf8");let headers,body,timeout,authCalls=0,transportCalls=0,localCalls=0;
 const expected={itemName:"Plastic Bottle",category:"Recyclable",explanation:"original",action:"original",warning:"original"};const module={exports:{}};
 const transport={request(options,cb){transportCalls++;headers=options.headers;timeout=options.timeout;const req=new EventEmitter();req.write=value=>{body=JSON.parse(value);};req.destroy=e=>req.emit("error",e);req.end=()=>{const res=new EventEmitter();res.statusCode=200;cb(res);res.emit("data",JSON.stringify({success:true,result:expected}));res.emit("end");};return req;}};
 vm.runInNewContext(source,{module,process:{env:{...env,GEMINI_CLASSIFIER_URL:audience+"/classify-waste",ALLOW_RENDER_GEMINI_DIRECT:"true"}},URL,Buffer,Date,setTimeout,clearTimeout,console:{log(){},warn(){},error(){}},require(id){
  if(id==="./cloudRunDiagnostics")return require("../services/cloudRunDiagnostics");if(id==="http"||id==="https")return transport;if(id==="./cloudRunAuth")return {invocationHeaders:async(url,options)=>{assert.equal(url,audience+"/classify-waste");assert.equal(options.timeoutMs,35000);authCalls++;if(failAuth)throw Error("Cloud Run authentication unavailable.");return {Authorization:"Bearer synthetic"};}};if(id==="./googleVisionService")return {detectObjectsFromBase64:async()=>[],OBJECT_LOCALIZATION_TIMEOUT_MS:5000};if(id==="./geminiWasteClassifierService")return {classifyWasteWithGemini:async()=>{localCalls++;throw Error("No fallback allowed");}};if(id.startsWith("../"))return require(id);if(["./wasteLearningGuideService","./wasteDisplayNameService","./automaticWasteCategoryMapper"].includes(id))return require("../services/"+id.slice(2));throw Error("Unexpected dependency "+id);}});
 const result=await module.exports.analyzeWaste({image:"synthetic",detectedObject:"Bottle",mlKitLabels:[]});assert.equal(authCalls,1);assert.equal(localCalls,0);assert.equal(transportCalls,failAuth?0:1);if(failAuth){assert.equal(typeof result.itemName,"string");assert.ok(Array.isArray(result.detectedItems));}else{assert.equal(headers.Authorization,"Bearer synthetic");assert.deepEqual(body,{image:"synthetic"});assert.ok(timeout>0&&timeout<=35000);assert.equal(headers["X-Classify-Proposals-Token"],undefined);for(const key of Object.keys(expected))assert.equal(result[key],expected[key]);}
});
