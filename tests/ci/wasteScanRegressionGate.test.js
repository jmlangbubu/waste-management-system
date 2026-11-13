"use strict";
// Real native/OS/Git integration fixtures run outside the worktree. Synthetic
// evidence-corruption tests are labelled explicitly and never prove execution.
const {test}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),cp=require("node:child_process");
const gate=require("../../scripts/ci/wasteScanRegressionGate"),m=gate.validateManifest(gate.readManifest());
const ROOT=path.resolve(__dirname,"../.."),key=r=>JSON.stringify([r.file,r.name]),clone=x=>JSON.parse(JSON.stringify(x));
const known=new Set(m.knownFailures.map(key)),controls=new Set(m.safetyMustPass.map(key));
const stale=m.safetyMustPass.find(r=>known.has(key(r))),first=m.files[0],historical=m.knownFailures[0];
let cache=null,objects=null;
function git(args,{cwd=ROOT,input,buffer=false}={}){
 const r=cp.spawnSync("git",["--no-optional-locks","-C",cwd,...args],{cwd:os.tmpdir(),env:{...gate.offlineEnvironment(),GIT_NO_REPLACE_OBJECTS:"1"},
 input,encoding:buffer?undefined:"utf8",timeout:60000,maxBuffer:128*1024*1024,windowsHide:true});
 assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr?.toString());return r.stdout;
}
function baseCache(){
 if(cache)return cache;
 cache=fs.mkdtempSync(path.join(os.tmpdir(),"wmo-native-base-"));
 objects=git(["rev-parse","--path-format=absolute","--git-path","objects"]).trim();
 const tar=git(["archive","--format=tar",m.baseCommit],{buffer:true});
 for(let at=0;at+512<=tar.length;){
  const header=tar.subarray(at,at+512);if(header.every(x=>x===0))break;
  const str=(a,b)=>header.subarray(a,b).toString("utf8").split("\0")[0];
  const name=(str(345,500)?str(345,500)+"/":"")+str(0,100),size=parseInt(str(124,136).trim()||"0",8),type=str(156,157);
  const body=tar.subarray(at+512,at+512+size);
  if(type==="0"||type===""){
   assert.ok(!path.isAbsolute(name)&&!name.split("/").includes(".."));
   fs.mkdirSync(path.dirname(path.join(cache,name)),{recursive:true});fs.writeFileSync(path.join(cache,name),body);
  }else assert.ok(["5","g","x"].includes(type),"Unsupported fixture archive entry");
  at+=512+Math.ceil(size/512)*512;
 }
 assert.ok(fs.existsSync(path.join(cache,"services/wholeImageRecognitionService.js")));return cache;
}
const LEGACY_RELATIVE_ORIGIN_SOURCE="function verifyExternalOutcome(row,spec,platform=process.platform,root=ROOT){\n const check={file:spec.file,name:spec.name,dependency:spec.dependency,\n  outcome:!row?\"MISSING\":row.skip?\"SKIPPED\":row.todo?\"TODO\":cancelled(row)?\"CANCELLED\":row.passed?\"PASS\":\"FAIL\",\n  code:row?.error?.causeCode??null,verified:false,environment:null,reason:\"MISSING_EXTERNAL_EXECUTION\"};\n const reject=reason=>({...check,reason});\n if(!row)return check;\n if(id(row)!==id(spec)||row.kind!==\"test\"||row.nesting!==0\n  ||externalPathKey(row.source,platform)!==externalPathKey(\n   (platform===\"win32\"?path.win32:path.posix).join(root,spec.file),platform))return reject(\"UNTRUSTED_EXTERNAL_IDENTITY\");\n if(check.outcome!==\"FAIL\")return reject(\"UNEXPECTED_EXTERNAL_\"+check.outcome);\n const e=row.error,o=e?.origin;\n if(!errorOK(e)||e.code!==\"ERR_TEST_FAILURE\"||e.failureType!==\"testCodeFailure\"\n  ||e.exitCode!==null||e.signal!==null||e.causeType!==\"Error\"||!o||!originOK(o))\n  return reject(\"UNVERIFIED_EXTERNAL_ERROR_METADATA\");\n const frames=o.stack?.split(/\\r?\\n/).filter(line=>/^\\s+at /.test(line))??[];\n const caller=/^\\s+at TestContext\\.<anonymous> \\((.+):(\\d+):(\\d+)\\)$/.exec(frames[1]??\"\");\n if(!/^\\s+at Object\\.readFileSync \\(node:fs:\\d+:\\d+\\)$/.test(frames[0]??\"\")\n  ||!caller||externalPathKey(caller[1],platform)!==externalPathKey(row.source,platform)\n  ||!integer(row.line)||row.line<1||Number(caller[2])<row.line||Number(caller[3])<1)\n  return reject(\"UNVERIFIED_DIRECT_NATIVE_READ_ORIGIN\");\n if(platform===\"win32\"){\n  if(e.causeCode!==\"ERR_ACCESS_DENIED\"||o.permission!==\"FileSystemRead\"\n   ||externalPathKey(o.resource,platform)!==externalPathKey(spec.resource,platform)\n   ||o.path!==null||o.syscall!==null||o.errno!==null)return reject(\"UNEXPECTED_WINDOWS_EXTERNAL_ORIGIN\");\n  return {...check,verified:true,environment:\"Windows native FileSystemRead denial for the known Android dependency\",reason:null};\n }\n if(platform===\"linux\"){\n  // The immutable C:/... literal is relative on Linux. In the collector's\n  // verified checkout cwd it names an unavailable in-checkout dependency,\n  // never evidence that the real /mnt/c Android checkout was permission-denied.\n  if(e.causeCode!==\"ENOENT\"||o.path!==spec.resource||o.syscall!==\"open\"||o.errno!==-2\n   ||o.permission!==null||o.resource!==null||path.posix.isAbsolute(o.path)\n   ||!path.posix.resolve(root,o.path).startsWith(path.posix.resolve(root)+\"/\"))\n   return reject(\"UNEXPECTED_LINUX_EXTERNAL_ORIGIN\");\n  return {...check,verified:true,environment:\"Linux native open ENOENT for the known Windows-style Android dependency path\",reason:null};\n }\n return reject(\"UNSUPPORTED_EXTERNAL_ENVIRONMENT\");\n}";
const legacyOperand=spec=>(process.platform==="linux"?"X:/legacy-android/":"legacy-relative/")+spec.dependency;
// Protocol/runner fixtures below deliberately invent callback bodies. Their
// disposable gate copies receive explicit fixture-only pins. They do NOT test
// production reference provenance; the full-source fixtures below never repin.
const SOURCE_SAFETY_BLOBS=Object.freeze({
 "tests/wholeImageRecognition.test.js":"7c0464eac68443ccfc3fe31772315e87bb9c406b",
 "tests/wasteScanReconciliation.test.js":"7cf52a7405073391a29d3b53674037cf492aa435",
 "tests/wasteScanAccuracy.test.js":"dd6337a6fdae1412d2c5462e2c6a3372fce264cb"
});
const SOURCE_SAFETY_PRODUCTION=Object.freeze({
 "services/wholeImageRecognitionService.js":"d9a562430dccf2cd74a1882406010112db07783d",
 "services/perItemWasteAssessmentService.js":"e8f675178de294c22e21bf42953b73eeb2ec81a9"
});
const SOURCE_ANCHORS=Object.freeze({
 "tests/wasteProductStateSafety.test.js":{
  old:'const root="C:/Users/ADMIN/.codex/worktrees/android-classification-reconciliation/AIWasteManagementSystem-LATEST/app/src/main/java/com/example/aiwastemanagementsystem/";',
  approved:'const androidPath=require("node:path");\n const root=androidPath.resolve(__dirname,"../../../android-classification-reconciliation/AIWasteManagementSystem-LATEST/app/src/main/java/com/example/aiwastemanagementsystem")+androidPath.sep;'},
 "tests/wastePrimaryReconciliation.test.js":{
  old:'const root="C:/Users/ADMIN/AndroidStudioProjects/AIWasteManagementSystem-unknown-primary/app/src/main/java/com/example/aiwastemanagementsystem/";',
  approved:'const androidPath=require("node:path");\n const root=androidPath.resolve(__dirname,"../../../../../AndroidStudioProjects/AIWasteManagementSystem-unknown-primary/app/src/main/java/com/example/aiwastemanagementsystem")+androidPath.sep;'}
});
const sourceHash=b=>require("node:crypto").createHash("sha256").update(b).digest("hex");
function approvedTestReference(file,safety){
 const object=safety&&SOURCE_SAFETY_BLOBS[file]||m.baseCommit+":"+file;
 let text=git(["cat-file","blob",object]).replaceAll("\r\n","\n");
 const anchor=SOURCE_ANCHORS[file];
 if(anchor){assert.equal(text.split(anchor.old).length,2);text=text.replace(anchor.old,anchor.approved);}
 return text;
}
function trustSyntheticFixture(root){
 const pins=Object.fromEntries(m.files.map(f=>[f,sourceHash(fs.readFileSync(path.join(root,f),"utf8").replaceAll("\r\n","\n"))]));
 const file=path.join(root,"scripts/ci/wasteScanRegressionGate.js"),text=fs.readFileSync(file,"utf8");
 const a=text.indexOf("const TEST_SOURCE_DIGESTS ="),b=text.indexOf("const TEST_SOURCE_POLICY =",a);
 assert.ok(a>=0&&b>a);
 const fixturePins='const TEST_SOURCE_DIGESTS = Object.freeze({"original-main":Object.freeze('+JSON.stringify(pins)+'),"safety-required":Object.freeze('+JSON.stringify(pins)+')});\n';
 fs.writeFileSync(file,text.slice(0,a)+fixturePins+text.slice(b));
}
function syntheticSourceSnapshot(profile){
 const files=gate.FILES.map(file=>({file,expected:gate.TEST_SOURCE_DIGESTS[profile][file],
  digest:gate.TEST_SOURCE_DIGESTS[profile][file],identity:["0","1","1","1","1"],verified:true,reason:null}));
 return {profile,status:"VERIFIED",reference:gate.TEST_SOURCE_POLICY[profile],policy:gate.TEST_SOURCE_POLICY.algorithm,
  anchorCorrection:gate.TEST_SOURCE_POLICY.anchorCorrection,files,
  fingerprint:sourceHash(JSON.stringify(files.map(r=>[r.file,r.digest]))),issues:[]};
}
function approvedSourceFixture(safety=false){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),"wmo-full-fixture-approved-"));
 const root=path.join(home,".codex","worktrees","ci","wmo-product-state-safety");
 fs.mkdirSync(root,{recursive:true});fs.cpSync(baseCache(),root,{recursive:true});
 for(const f of gate.CI_FILES){fs.mkdirSync(path.dirname(path.join(root,f)),{recursive:true});fs.copyFileSync(path.join(ROOT,f),path.join(root,f));}
 git(["init","--quiet"],{cwd:root});fs.writeFileSync(path.join(root,".git/objects/info/alternates"),objects+"\n");
 // BASE ancestry plus the two pinned production bodies supplies positive safety
 // evidence even after a squash/rebase makes the original safety commit absent.
 fs.writeFileSync(path.join(root,".git/HEAD"),m.baseCommit+"\n");
 if(safety)for(const [f,oid]of Object.entries(SOURCE_SAFETY_PRODUCTION))fs.writeFileSync(path.join(root,f),git(["cat-file","blob",oid],{buffer:true}));
 for(const f of m.files)fs.writeFileSync(path.join(root,f),approvedTestReference(f,safety));
 return root;
}
let sourceParser=null;
function sourceAST(text){
 if(!sourceParser){const p={exports:{}};require("node:vm").runInNewContext(process.binding("natives")["internal/deps/acorn/acorn/dist/acorn"],{module:p,exports:p.exports});sourceParser=p.exports;}
 return sourceParser.parse(text,{ecmaVersion:"latest"});
}
function rewriteApprovedCallback(root,target,rewrite){
 const file=path.join(root,target.file),text=fs.readFileSync(file,"utf8");
 const n=sourceAST(text).body.find(n=>n.expression?.callee?.name==="test"&&n.expression.arguments[0]?.value===target.name);
 assert.ok(n,"Required exact static registration absent: "+target.name);
 const fn=n.expression.arguments.find(n=>["ArrowFunctionExpression","FunctionExpression"].includes(n.type));
 assert.ok(fn&&fn.body.type==="BlockStatement");
 const next=rewrite(text.slice(fn.body.start,fn.body.end),{text,n,fn});
 fs.writeFileSync(file,text.slice(0,fn.body.start)+next+text.slice(fn.body.end));
}
function removeApprovedRegistration(root,target){
 const file=path.join(root,target.file),text=fs.readFileSync(file,"utf8");
 const n=sourceAST(text).body.find(n=>n.expression?.callee?.name==="test"&&n.expression.arguments[0]?.value===target.name);
 assert.ok(n);fs.writeFileSync(file,text.slice(0,n.start)+text.slice(n.end));
}
function actualSourceGate(root,{cli=false,mutateAfterStart=null}={}){
 const driver=path.join(root,"tests/ci/source-integrity-driver.cjs");
 fs.writeFileSync(driver,'const fs=require("node:fs"),path=require("node:path"),g=require("../../scripts/ci/wasteScanRegressionGate");'
  +'const p=g.executeGate();'+(mutateAfterStart??"")
  +'p.then(r=>{console.log(JSON.stringify({...r,summary:g.formatSummary(r.manifest,r.outcome,r.report)}));process.exitCode=r.outcome.accepted?0:1}).catch(e=>{console.error(e);process.exitCode=2;});');
 const result=cp.spawnSync(process.execPath,[driver],{cwd:root,env:gate.offlineEnvironment(),encoding:"utf8",windowsHide:true,timeout:260000,maxBuffer:16*1024*1024});
 assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.stderr,"");
 assert.ok([0,1].includes(result.status));const value=JSON.parse(result.stdout);
 assert.equal(result.status,value.outcome.accepted?0:1);
 if(cli){
  const run=cp.spawnSync(process.execPath,["scripts/ci/wasteScanRegressionGate.js"],{cwd:root,env:gate.offlineEnvironment(),encoding:"utf8",windowsHide:true,timeout:260000,maxBuffer:4*1024*1024});
  assert.equal(run.error,undefined);assert.equal(run.signal,null);assert.equal(run.stderr,"");
  assert.equal(run.status,result.status);value.actualCLI={status:run.status,summary:run.stdout};
 }
 return value;
}
function sourceRejects(value,file){
 assert.equal(value.outcome.accepted,false);assert.equal(value.outcome.sourceStatus,"REJECTED");
 assert.equal(value.report.execution,null,"Unapproved source must reject before native loading");
 assert.ok(value.outcome.issues.includes("UNAPPROVED TEST SOURCE CONTENT"));
 if(file)assert.ok(value.report.testSources.before.files.some(r=>r.file===file&&!r.verified));
 assert.match(value.summary,/SOURCE INTEGRITY: REJECTED/);
 assert.doesNotMatch(value.summary,/STRICT SAFETY REQUIREMENTS: PASS/);
}
function fixture({safety=false,change=()=>"",prefix="",unknown=false,fast=false,legacyOrigin=false,missingExternal=false}={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),"wmo-full-fixture-"));
 const root=path.join(home,".codex","worktrees","ci","wmo-product-state-safety");fs.mkdirSync(root,{recursive:true});
 fs.cpSync(baseCache(),root,{recursive:true});
 for(const f of gate.CI_FILES){fs.mkdirSync(path.dirname(path.join(root,f)),{recursive:true});fs.copyFileSync(path.join(ROOT,f),path.join(root,f));}
 if(fast){const file=path.join(root,"scripts/ci/wasteScanRegressionGate.js");
  fs.writeFileSync(file,fs.readFileSync(file,"utf8").replace("NATIVE_TIMEOUT_MS = 30000","NATIVE_TIMEOUT_MS = 800")
   .replace("EXECUTION_TIMEOUT_MS = 180000","EXECUTION_TIMEOUT_MS = 3000"));}
 git(["init","--quiet"],{cwd:root});fs.writeFileSync(path.join(root,".git/objects/info/alternates"),objects+"\n");
 fs.writeFileSync(path.join(root,".git/HEAD"),m.baseCommit+"\n");
 for(const file of m.files){
  const rows=m.requiredTests[file].map(name=>({file,name})).concat(safety?m.safetyTests.filter(r=>r.file===file):[],m.exclusions.filter(r=>r.file===file))
   .map(r=>({...r,options:"",body:m.exclusions.some(e=>key(e)===key(r))
    ?'require("fs").readFileSync('+(legacyOrigin?"":'require("path").resolve(__dirname,')+JSON.stringify(legacyOrigin?legacyOperand(gate.EXTERNAL_TESTS.find(e=>key(e)===key(r))):gate.EXTERNAL_TESTS.find(e=>key(e)===key(r)).relativeResource)+(legacyOrigin?"":")")+',"utf8");'
    :known.has(key(r))&&!(safety&&controls.has(key(r)))?'throw Error("historical fixture");':""}));
  const extra=change(file,rows,root)||"";
  const source=prefix+'\nconst api=require("node:test"),test=api.test,assert=require("node:assert/strict");const jobs=[];let strictRan=false,historyRan=false;\n'
   +rows.map(r=>'jobs.push(test('+JSON.stringify(r.name)+','+(r.options?r.options+",":"")+'(t)=>{'+r.body+'}));').join("\n")+"\n"+extra;
  fs.writeFileSync(path.join(root,file),source);
 }
 configureOriginFixture(root,{legacyOrigin,missingExternal});
 if(safety)for(const [f,oid]of Object.entries(SOURCE_SAFETY_PRODUCTION))fs.writeFileSync(path.join(root,f),git(["cat-file","blob",oid],{buffer:true}));
 trustSyntheticFixture(root);
 if(unknown)fs.appendFileSync(path.join(root,"services/wholeImageRecognitionService.js"),"\n// unknown revised production source\n");
 return root;
}
function removeFixture(root){
 const home=path.resolve(root,"../../../..");
 assert.equal(path.dirname(home),path.resolve(os.tmpdir()));assert.ok(path.basename(home).startsWith("wmo-full-fixture-"));
 assert.equal(root,path.join(home,".codex","worktrees","ci","wmo-product-state-safety"));
 fs.rmSync(home,{recursive:true,force:true});
}
function runFixture(options={},executionOptions={}){
 const root=fixture(options),driver=path.join(root,"tests/ci/temporary-driver.cjs");
 fs.writeFileSync(driver,'const g=require("../../scripts/ci/wasteScanRegressionGate");g.executeGate('+JSON.stringify(executionOptions)+')'
 +'.then(r=>{console.log(JSON.stringify({...r,summary:g.formatSummary(r.manifest,r.outcome,r.report)}));process.exitCode=r.outcome.accepted?0:1;})'
 +'.catch(e=>{console.log(JSON.stringify({error:e.message}));process.exitCode=2;});');
 const r=cp.spawnSync(process.execPath,[driver],{cwd:root,env:gate.offlineEnvironment(),encoding:"utf8",timeout:260000,maxBuffer:16*1024*1024,windowsHide:true});
 try{
  assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.stderr,"");
  const value=JSON.parse(r.stdout);assert.ok([0,1].includes(r.status),value.error);
  assert.equal(r.status,value.outcome.accepted?0:1);
  if(value.report.execution){
   assert.equal(value.report.execution.record?.invocations,1);
   assert.deepEqual(value.report.execution.record?.filters,[]);
   assert.equal(value.report.execution.cleanup?.verified,true);
  }
  return value;
 }finally{removeFixture(root);}
}
const nativeError=()=>({code:"ERR_TEST_FAILURE",failureType:"testCodeFailure",exitCode:null,signal:null,causeType:"Error",causeCode:"ERR_ASSERTION",origin:null});
function externalError(spec,platform=process.platform,root=ROOT,line=2){
 const p=platform==="win32"?path.win32:path.posix,resource=gate.externalResource(spec,root,platform);
 return {...nativeError(),causeCode:platform==="win32"?"ERR_ACCESS_DENIED":"ENOENT",
  origin:{path:platform==="linux"?resource:null,syscall:platform==="linux"?"open":null,
   permission:platform==="win32"?"FileSystemRead":null,resource:platform==="win32"?resource:null,
   errno:platform==="linux"?-2:null,stack:"Error: SYNTHETIC environmental evidence\n    at Object.readFileSync (node:fs:440:20)\n    at TestContext.<anonymous> ("+p.join(root,spec.file)+":"+line+":1)\n    at Test.runInAsyncScope (node:async_hooks:214:14)"}};
}
function meta(file,name,passed=true,number=1,line=2){
 return {name,source:path.join(ROOT,file),passed,skip:false,todo:false,nesting:0,kind:"test",number,line,column:1,error:passed?null:nativeError()};
}
function synthetic(safety=false){
 const rows=m.files.flatMap(file=>m.requiredTests[file].map(name=>({file,name})).concat(safety?m.safetyTests.filter(r=>r.file===file):[],m.exclusions.filter(r=>r.file===file)));
 let globalNumber=0;
 const files=m.files.map((file,index)=>{
  const results=rows.filter(r=>r.file===file).map(r=>meta(file,r.name,
   !(known.has(key(r))&&!(safety&&controls.has(key(r))))&&!m.exclusions.some(x=>key(x)===key(r)),++globalNumber));
  for(const row of results){const spec=gate.EXTERNAL_TESTS.find(x=>x.file===file&&x.name===row.name);if(spec)row.error=externalError(spec);}
  const completions=results.map((r,i)=>({...clone(r),number:i+1}));
  const counts=gate.countRows(results),failed=counts.failed>0,completion=meta(file,path.join(ROOT,file),!failed,index+1,1);
  if(failed)completion.error={...nativeError(),failureType:"subtestsFailed",exitCode:1};
  return {file,results,completions,summary:{counts,success:!failed},completion,wrapperResults:[],output:[]};
 });
 const native={node:process.version,platform:process.platform,cwd:ROOT,invocations:1,filters:[],files,results:files.flatMap(f=>f.results.map(r=>({file:f.file,role:"leaf",...r}))),
  summary:null,diagnostics:[],ended:true,activity:1,permissionArguments:gate.permissionArgs(ROOT,path.join(os.tmpdir(),"synthetic-native-only"))};
 native.summary={counts:gate.countRows(native.results),success:native.results.every(r=>r.passed)};
  const sourceSnapshot=syntheticSourceSnapshot(safety?"safety-required":"original-main");
 return {schemaVersion:5,node:process.version,testSources:{before:sourceSnapshot,after:clone(sourceSnapshot)},profile:gate.profileFromEvidence({gitVerified:true,head:m.baseCommit,original:!safety,
  safety,fingerprint:"b".repeat(64),evidence:["SYNTHETIC profile evidence only"]}),sourceStable:true,
  execution:{token:"a".repeat(32),pid:1234,closed:true,issues:[],hostStderr:"",collectorExit:1,collectorSignal:null,
   hostTimedOut:false,cleanup:{verified:true,active:0,forced:false,method:process.platform==="win32"?"windows-job":"linux-subreaper"},
   record:native,tmp:path.join(os.tmpdir(),"synthetic-native-only")}};
}
function inspect(r){return gate.evaluateReport(r,m);}
function rebuild(r){
 const n=r.execution.record;
 for(const f of n.files){
  f.completions=f.results.map((d,i)=>({...clone(d),number:i+1}));
  f.summary={counts:gate.countRows(f.results),success:f.results.every(d=>d.passed||d.skip||d.todo)};
  f.completion.passed=f.summary.success;f.completion.error=f.summary.success?null:{...nativeError(),failureType:"subtestsFailed",exitCode:1};
 }
 n.results=n.files.flatMap(f=>f.results.map(d=>({file:f.file,role:"leaf",...d})));
 n.summary={counts:gate.countRows(n.results),success:n.files.every(f=>f.summary.success)};
 r.execution.collectorExit=n.summary.success?0:1;return r;
}
function deny(r){assert.equal(inspect(r).accepted,false);}
test("pinned runtime and immutable 557 / 17 / 27 / 28 manifest contract",()=>{
 assert.equal(process.version,gate.NODE_VERSION);
 assert.equal(Object.values(m.requiredTests).flat().length,557);assert.equal(m.knownFailures.length,17);
 assert.equal(m.safetyTests.length,27);assert.equal(m.safetyMustPass.length,28);
 const changed=clone(m);changed.knownFailures[0].name+=" changed";assert.throws(()=>gate.validateManifest(changed),/DIGEST/);
});
for(const safety of [false,true])test("real native single authoritative inventory: "+(safety?"safety 568 / 16":"original 540 / 17"),()=>{
 const r=runFixture({safety}),o=r.outcome;
 assert.equal(o.accepted,true);assert.equal(o.strict.passed,safety?568:540);assert.equal(o.strict.failed,0);
 assert.equal(o.historical.failed,safety?16:17);assert.equal(o.scoped.tests,safety?584:557);
 assert.equal(o.raw.tests,safety?586:559);assert.equal(o.excluded.length,2);
 assert.equal(r.report.execution.collectorExit,1);
 if(safety)for(const c of m.safetyMustPass)assert.ok(o.rows.some(x=>key(x)===key(c)&&x.passed));
 assert.match(r.summary,/NOT CLAIMED PASSING/);assert.match(r.summary,/remain unresolved/);
});
for(const safety of [false,true])test("synthetic consistent evidence accepts "+safety,()=>assert.equal(inspect(synthetic(safety)).accepted,true));
for(const c of m.safetyMustPass)test("synthetic mandatory safety omission rejects: "+c.name,()=>{
 const r=synthetic(true);for(const f of r.execution.record.files)f.results=f.results.filter(x=>key({file:f.file,...x})!==key(c));
 rebuild(r);const o=inspect(r);assert.equal(o.accepted,false);assert.equal(o.strictStatus,"FAIL");
 assert.ok(o.missingCoverage.some(x=>key(x)===key(c)));
});
for(const safety of [false,true])test("synthetic every original identity remains required in one ledger: "+safety,()=>{
 for(const [file,names]of Object.entries(m.requiredTests))for(const name of names){
  const r=synthetic(safety),f=r.execution.record.files.find(f=>f.file===file);f.results=f.results.filter(x=>x.name!==name);
  rebuild(r);const o=inspect(r);assert.equal(o.accepted,false);
  if(!known.has(key({file,name}))||safety&&controls.has(key({file,name})))assert.equal(o.strictStatus,"FAIL");
 }
});
const realCases=[
 ["new passing test",()=>({change:f=>f===first?'test("new passing native test",()=>{});':""}),true],
 ["new failing test",()=>({change:f=>f===first?'test("new strict failure",()=>assert.fail("new failure"));':""}),false],
 ["historical name in another file",()=>({change:f=>f===first?'test('+JSON.stringify(historical.name)+',()=>assert.fail("cross-file"));':""}),false],
 ["external-exclusion name in another file",()=>({change:f=>f===first?'test('+JSON.stringify(m.exclusions[0].name)+',()=>assert.fail("outside exact exclusion"));':""}),false],
 ["duplicate exact identity",()=>({change(f,rows){if(f===first)rows.push({...rows[0]});}}),false],
 ["unexpected skip",()=>({change(f,rows){if(f===first)rows[0].options="{skip:true}";}}),false],
 ["unexpected TODO",()=>({change(f,rows){if(f===first)rows[0].options="{todo:true}";}}),false],
 ["unexpected cancellation",()=>({change:f=>f===first?'test("aborted test",{signal:AbortSignal.abort()},()=>{});':""}),false],
 ["missing original",()=>({change(f,rows){if(f===first)rows.shift();}}),false],
 ["historical fix",()=>({change(f,rows){if(f===historical.file)rows.find(r=>r.name===historical.name).body="";}}),true],
 ["historical same-ID changed cause",()=>({change(f,rows){if(f===historical.file)rows.find(r=>r.name===historical.name).body='throw new TypeError("changed cause");';}}),true],
 ["historical dependency-loader cause",()=>({change(f,rows){if(f===historical.file)rows.find(r=>r.name===historical.name).body='require("./missing-dependency");';}}),true],
 ["missing historical identity",()=>({change(f,rows){if(f===historical.file)rows.splice(rows.findIndex(r=>r.name===historical.name),1);}}),false],
 ["passing __filename on first source line",()=>({prefix:'require("node:test")(__filename,()=>{});'}),true],
 ["failing __filename",()=>({change:f=>f===first?'test(__filename,()=>assert.fail("filename"));':""}),false],
 ["basename and same-name leaves across files",()=>({change:f=>[first,m.files[1]].includes(f)?'test("same leaf",()=>{});test('+JSON.stringify(path.basename(f))+',()=>{});':""}),true],
 ["regex Unicode newline quote path names",()=>({change:f=>f===first?[".*[x](a)?+$^{}|","🧪 漢字","line\nnext\n",'quotes " \' \\ slash',"a/b"].map(n=>'test('+JSON.stringify(n)+',()=>{});').join("\n"):""}),true],
 ["strict loader failure",()=>({change:f=>f===first?'test("strict loader",()=>require("./missing-dependency"));':""}),false],
 ["native callback own call ignored",()=>({change:f=>f===first?'function cb(){assert.fail("native invocation")};cb.call=()=>{};test("owned call",cb);':""}),false],
 ["native callback own call cannot falsely reject",()=>({change:f=>f===first?'function cb(){};cb.call=()=>assert.fail("unused");test("owned call pass",cb);':""}),true],
 ["native aliases contexts hooks promises mocks and AsyncResource",()=>({change:f=>f===first?'let ctor;api.before(t=>{ctor=t.constructor});api.beforeEach(t=>assert.equal(t.constructor,ctor));api.afterEach(t=>assert.equal(t.constructor,ctor));api.after(t=>assert.equal(t.constructor,ctor));test("context",t=>{assert.equal(t.constructor,ctor);assert.equal(api.test,api);assert.equal(api.it,api)});test("sync",()=>{});test("promise",()=>Promise.resolve());test("async",async()=>{await Promise.resolve()});test("mock",t=>{const x={f:()=>1};t.mock.method(x,"f",()=>2);assert.equal(x.f(),2)});new (require("async_hooks").AsyncResource)("Test").runInAsyncScope(()=>test("resource",()=>{}));':""}),true],
 ["native clean exit restoration",()=>({change:f=>f===first?'process.exitCode=2;process.on("exit",()=>{process.exitCode=0});':""}),true],
 ["late uncaught with complete named coverage",()=>({change:f=>f===first?'setImmediate(()=>{throw Error("late uncaught")});':""}),false],
 ["late rejection with complete named coverage",()=>({change:f=>f===first?'setImmediate(()=>Promise.reject(Error("late rejection")));':""}),false],
 ["nonzero exit after named tests",()=>({change:f=>f===first?'setImmediate(()=>process.exit(2));':""}),false],
 ["unexpected signal",()=>({change:f=>f===first?'setImmediate(()=>process.kill(process.pid,"SIGTERM"));':""}),false],
 ["zero exit without coverage",()=>({change:f=>f===first?'process.exit(0);':""}),false],
 ["historical late asynchronous error",()=>({change(f,rows){if(f===historical.file){const r=rows.find(r=>r.name===historical.name);r.body='setImmediate(()=>{throw Error("late historical")});'+r.body;}}}),false],
 ["unknown revised production source",()=>({unknown:true}),false]
];
for(const [name,setup,accepted]of realCases)test("real native: "+name,()=>{
 const r=runFixture(setup());assert.equal(r.outcome.accepted,accepted,JSON.stringify({issues:r.outcome.issues,executionIssues:r.report.execution?.issues,cleanup:r.report.execution?.cleanup}));
 if(name.startsWith("late "))assert.equal(r.outcome.missingCoverage.length,0);
 if(name==="unknown revised production source"){assert.equal(r.outcome.profile.name,"unknown");assert.equal(r.report.execution,null);assert.match(r.outcome.decision,/INSUFFICIENT/);}
});
for(const mode of ["shared historical state","strict setup state","conditional new registration","missing safety","renamed safety","stale full failure"])
 test("real authoritative regression: "+mode,()=>{
 const r=runFixture({safety:true,change(file,rows){
  if(mode==="missing safety"||mode==="renamed safety"){const c=m.safetyTests[0];if(file===c.file){const i=rows.findIndex(x=>x.name===c.name);
   if(mode==="missing safety")rows.splice(i,1);else rows[i].name+=" renamed";}return;}
  const target=mode==="stale full failure"?stale:historical;
  if(file!==target.file)return;
  const h=rows.find(x=>known.has(key(x))&&!controls.has(key(x))),s=rows.find(x=>!known.has(key(x)));
  h.body="historyRan=true;"+h.body;s.body="strictRan=true;"+s.body;
  if(mode==="conditional new registration")return 'Promise.allSettled(jobs).then(()=>{if(historyRan&&strictRan)test("conditional new failure",()=>assert.fail("registered in full run"))});';
  if(mode==="stale full failure")rows.find(x=>x.name===stale.name).body='assert.equal(historyRan,false,"stale full run detects shared state");';
  else return 'test("shared full-run failure",()=>assert.equal('+(mode==="strict setup state"?"strictRan":"historyRan")+',false));';
 }});
 assert.equal(r.outcome.accepted,false);
 if(mode==="conditional new registration")assert.ok(r.outcome.newFailures.some(x=>x.name==="conditional new failure"));
 if(mode==="stale full failure"){assert.equal(r.outcome.missingCoverage.length,0);assert.ok(r.outcome.rows.some(x=>key(x)===key(stale)&&!x.passed));}
});
test("real original source with an explicit safety requirement cannot waive controls",()=>{
 const r=runFixture({}, {requireSafety:true});assert.equal(r.outcome.accepted,false);assert.equal(r.outcome.missingCoverage.length,27);
});
test("real unknown source cannot obtain authority from an explicit safety flag",()=>{
 const r=runFixture({unknown:true,safety:true},{requireSafety:true});
 assert.equal(r.outcome.profile.name,"unknown");assert.equal(r.report.execution,null);
 assert.equal(r.outcome.decision,"BLOCKED BY INSUFFICIENT EVIDENCE");
});
test("caller-supplied original profile is not an executable gate option",async()=>{
 await assert.rejects(gate.executeGate({profile:{name:"original-main"}}),/UNSUPPORTED_GATE_OPTIONS/);
});
test("synthetic profile authority requires positive verified evidence",()=>{
 assert.equal(gate.profileFromEvidence({original:true}).name,"unknown");
 assert.equal(gate.profileFromEvidence({gitVerified:true,original:false}).name,"unknown");
 assert.equal(gate.profileFromEvidence({gitVerified:true,requireSafety:true}).name,"unknown");
 assert.equal(gate.profileFromEvidence({gitVerified:true,original:true}).name,"original-main");
 assert.equal(gate.profileFromEvidence({gitVerified:true,original:true,safety:true}).name,"safety-required");
});
for(const [name,mutate]of Object.entries({
 "wrong runtime":r=>r.node="v0",
 "missing invocation":r=>r.execution.record.invocations=0,
 "historical filtering":r=>r.execution.record.filters=["old failure"],
 "missing file completion":r=>r.execution.record.files[0].completion=null,
 "missing file summary":r=>r.execution.record.files[0].summary=null,
 "missing aggregate":r=>r.execution.record.summary=null,
 "contradictory aggregate":r=>r.execution.record.summary.counts.passed++,
 "missing named completion":r=>r.execution.record.files[0].completions.pop(),
 "contradictory named status":r=>r.execution.record.files[0].completions[0].passed=false,
 "duplicate completion":r=>r.execution.record.files[0].completions.push(clone(r.execution.record.files[0].completions[0])),
 "foreign source":r=>r.execution.record.files[0].results[0].source=path.join(ROOT,"foreign.js"),
 "wrapper number":r=>r.execution.record.files[0].completion.number=999,
 "wrapper name":r=>r.execution.record.files[0].completion.name="wrong",
 "duplicate wrapper":r=>r.execution.record.files[0].wrapperResults=[r.execution.record.files[0].completion,r.execution.record.files[0].completion],
 "missing selected file":r=>r.execution.record.files.pop(),
 "missing stream end":r=>r.execution.record.ended=false,
 "wrong collector exit":r=>r.execution.collectorExit=2,
 "collector signal":r=>r.execution.collectorSignal="SIGTERM",
 "unclosed host":r=>r.execution.closed=false,
 "cleanup unverified":r=>r.execution.cleanup.verified=false,
 "cleanup active child":r=>r.execution.cleanup.active=1,
 "forced orphan cleanup":r=>r.execution.cleanup.forced=true,
 "late diagnostic":r=>r.execution.record.diagnostics.push({source:null,level:"error",message:"late"}),
 "source changed":r=>r.sourceStable=false,
 "unexpected stderr":r=>r.execution.record.files[0].output.push({channel:"stderr",message:"unexpected diagnostic"})
}))test("synthetic execution audit rejects "+name,()=>{const r=synthetic();mutate(r);deny(r);});
function protocol(frames,extra=""){
 const ctx={token:"a".repeat(32),hostPid:10,platform:process.platform};
 const p=gate.parseHostProtocol(ctx);
 for(const f of frames)p.write(Buffer.from(JSON.stringify(f)+"\n"));
 if(extra)p.write(Buffer.from(extra));
 return p.finish({code:1,signal:null,tmp:path.join(os.tmpdir(),"synthetic-native-only")});
}
function frames(){
 const token="a".repeat(32),r=synthetic();
 return [{host:"created",token,hostPid:10},{host:"launched",token,pid:20},
  {kind:"start",token,pid:20,ppid:10,node:process.version},{kind:"report",token,pid:20,data:r.execution.record},
  {host:"closed",token,pid:20,exitCode:1,timedOut:false,forced:false,active:0,...(process.platform==="linux"?{signal:null}:{})}];
}
test("synthetic valid bounded host protocol preserves one report",()=>assert.equal(protocol(frames()).issues.length,0));
for(const [label,change,tail]of [
 ["malformed JSON",a=>a,"{bad}\n"],["truncated",a=>a,"{"],["missing terminal",a=>a.slice(0,-1),""],
 ["duplicate report",a=>[...a.slice(0,4),a[3],a[4]],""],["unknown event",a=>[...a,{unknown:true}],""],
 ["wrong PID",a=>{a[2].pid++;return a;},""],["wrong token",a=>{a[0].token="b".repeat(32);return a;},""]
])test("synthetic protocol rejects "+label,()=>assert.ok(protocol(change(frames()),tail).issues.length));
test("synthetic bounded protocol rejects oversized input",()=>{
 const p=gate.parseHostProtocol({token:"a".repeat(32),hostPid:1,platform:process.platform});
 p.write(Buffer.alloc(gate.LIMITS.bytes+65537,65));assert.ok(p.finish({code:1,signal:null}).issues.length);
});
test("permission startup warning is explicit; other stderr is never hidden",()=>{
 const text="(node:1) SecurityWarning: The flag --allow-child-process must be used with extreme caution. It could invalidate the permission model.\n";
 assert.equal(gate.guardWarnings(text).count,1);assert.equal(gate.guardWarnings(text).unexpected,"");
 assert.notEqual(gate.guardWarnings(text+"unexpected").unexpected,"");
});
test("report labels raw/external/scoped/history truthfully",()=>{
 const r=synthetic(true),o=inspect(r),s=gate.formatSummary(m,o,r);
 assert.equal(o.accepted,true);assert.equal(o.raw.failed,18);assert.equal(o.historical.failed,16);
 assert.match(s,/AUTHORITATIVE NATIVE EXECUTION/);assert.match(s,/STRICT SAFETY REQUIREMENTS: PASS/);
 assert.match(s,/IDENTITY AUDIT: VERIFIED/);assert.match(s,/NOT CLAIMED PASSING/);
 assert.match(s,/does NOT establish unchanged failure cause/);assert.match(s,/Forced-zero/);
 assert.equal((s.match(/— FAIL; code/g)||[]).length,2);
 assert.match(s,/EXTERNAL TEST CONTRACT: VERIFIED/);
});

function profileFixture(root,setup=""){
 const file=path.join(root,"tests/ci/profile-driver.cjs");
 fs.writeFileSync(file,setup+'const g=require("../../scripts/ci/wasteScanRegressionGate");console.log(JSON.stringify(g.detectProfile(g.readManifest())));');
 const r=cp.spawnSync(process.execPath,[file],{cwd:root,env:gate.offlineEnvironment(),encoding:"utf8",timeout:90000,maxBuffer:2*1024*1024,windowsHide:true});
 assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
test("real Git: original source remains positive with CI-only file changes and detached HEAD",()=>{
 const root=fixture();
 try{const p=profileFixture(root);assert.equal(p.name,"original-main");assert.equal(p.gitVerified,true);assert.match(p.fingerprint,/^[a-f0-9]{64}$/);
 assert.ok(p.evidence.some(x=>/actual non-test/.test(x)));}finally{removeFixture(root);}
});
test("real Git: environment redirects cannot replace checkout profile authority",()=>{
 const root=fixture();
 try{assert.equal(profileFixture(root,'process.env.GIT_DIR="untrusted-redirect";').name,"original-main");}
 finally{removeFixture(root);}
});
for(const changed of [false,true])test("real Git: large original text normalizes CRLF; content change "+changed,()=>{
 const root=fixture(),file=path.join(root,"database/generated/gensan-dispatch-destination-seed.sql");
 try{
  let text=fs.readFileSync(file,"utf8").replaceAll("\r\n","\n").replaceAll("\n","\r\n");
  if(changed)text+="\r\n-- changed source, not only line endings\r\n";
  fs.writeFileSync(file,text);
  const p=profileFixture(root);assert.equal(p.name,changed?"unknown":"original-main",JSON.stringify(p.evidence));
 }finally{removeFixture(root);}
});
for(const mode of ["shallow","missing Git"])test("real Git: "+mode+" metadata blocks",()=>{
 const root=fixture();
 try{
  if(mode==="shallow")fs.writeFileSync(path.join(root,".git/shallow"),m.baseCommit+"\n");
  else {const target=path.resolve(root,".git");assert.ok(target.startsWith(root+path.sep));fs.rmSync(target,{recursive:true,force:true});}
  const p=profileFixture(root);assert.equal(p.name,"unknown");assert.equal(p.gitVerified,false);
 }finally{removeFixture(root);}
});
test("real rewritten source with zero additions cannot default to original-main",()=>{
 const r=runFixture({unknown:true});assert.equal(r.outcome.profile.name,"unknown");
 assert.match(r.outcome.decision,/INSUFFICIENT/);assert.equal(r.report.execution,null);
});
test("synthetic verified safety ancestry remains mandatory after source revert",()=>{
 const p=gate.profileFromEvidence({gitVerified:true,original:true,safety:true,fingerprint:"c".repeat(64),head:m.baseCommit,evidence:["Verified earlier safety ancestry"]});
 assert.equal(p.name,"safety-required");assert.equal(p.requireSafety,true);
});
for(const resistant of [false,true])test("real native timeout rejects and terminates "+(resistant?"SIGTERM-resistant":"cooperative")+" child",()=>{
 const root=fixture({fast:true,change:f=>f===first
  ?'require("fs").writeFileSync(require("path").join(require("os").tmpdir(),"native-timeout.pid"),String(process.pid));'
   +(resistant?'process.on("SIGTERM",()=>{});':"")+'setInterval(()=>{},1000);':""});
 const driver=path.join(root,"tests/ci/timeout-driver.cjs");
 fs.writeFileSync(driver,'require("../../scripts/ci/wasteScanRegressionGate").executeGate().then(r=>console.log(JSON.stringify(r)));');
 const run=cp.spawnSync(process.execPath,[driver],{cwd:root,env:gate.offlineEnvironment(),encoding:"utf8",timeout:90000,maxBuffer:16*1024*1024,windowsHide:true});
 try{
  assert.equal(run.error,undefined);assert.equal(run.stderr,"");const r=JSON.parse(run.stdout);
  assert.equal(r.outcome.accepted,false);const e=r.report.execution;
  assert.equal(e.cleanup?.verified,true);assert.equal(e.cleanup.active,0);
  const marker=path.join(e.tmp,"native-timeout.pid");assert.ok(fs.existsSync(marker),"Timeout must reach the actual native body");
  const pid=Number(fs.readFileSync(marker,"utf8"));let alive=false;try{process.kill(pid,0);alive=true;}catch(error){assert.equal(error.code,"ESRCH");}
  assert.equal(alive,false,"Native child survived cleanup");
  assert.ok(path.basename(e.tmp).startsWith("wmo-full-native-"));fs.rmSync(e.tmp,{recursive:true,force:true});
 }finally{removeFixture(root);}
});
for(const mode of ["parent exits first","resistant detached descendant","cooperative timeout"])test("real owned tree: "+mode,async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wmo-owned-tree-")),file=path.join(dir,"actor.cjs");
 const childCode='process.on("SIGTERM",()=>{});setInterval(()=>{},1000);';
 fs.writeFileSync(file,'const fs=require("fs"),path=require("path"),{spawn}=require("child_process");'
  +'process.stdin.once("data",data=>{const c=JSON.parse(data.toString().trim());const p=spawn(process.execPath,["-e",'
  +JSON.stringify(mode==="cooperative timeout"?'setInterval(()=>{},1000)':childCode)
  +'],{detached:true,stdio:"ignore",windowsHide:true});fs.writeFileSync(path.join(c.tmp,"descendant.pid"),String(p.pid));'
  +(mode==="parent exits first"?'setTimeout(()=>process.exit(0),250);':'setInterval(()=>{},1000);')+'});');
 const sentinel=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});
 let e;
 try{
  e=await gate.supervise({collectorFile:file,budget:2000,nativeTimeout:500});
  assert.equal(e.cleanup?.verified,true);assert.equal(e.cleanup.active,0);
  assert.ok(e.issues.length>0,"Lifecycle fixture must not fabricate native evidence");
  const pid=Number(fs.readFileSync(path.join(e.tmp,"descendant.pid"),"utf8"));
  let alive=false;try{process.kill(pid,0);alive=true;}catch(error){assert.equal(error.code,"ESRCH");}assert.equal(alive,false);
  process.kill(sentinel.pid,0); // An unrelated sibling must remain alive.
 }finally{
  sentinel.kill();assert.ok(path.basename(dir).startsWith("wmo-owned-tree-"));fs.rmSync(dir,{recursive:true,force:true});
  if(e?.cleanup?.verified&&path.basename(e.tmp).startsWith("wmo-full-native-"))fs.rmSync(e.tmp,{recursive:true,force:true});
 }
});

test("real supervisor: a silent startup host is bounded and never certified",async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wmo-silent-host-")),file=path.join(dir,"gate.cjs");
 let source=fs.readFileSync(path.join(ROOT,"scripts/ci/wasteScanRegressionGate.js"),"utf8")
  .replace("STARTUP_TIMEOUT_MS = 20000","STARTUP_TIMEOUT_MS = 200")
  .replace("SUPERVISOR_GRACE_MS = 10000","SUPERVISOR_GRACE_MS = 500");
 const entry=" return new Promise(resolve=>{";
 assert.ok(source.includes(entry));
 source=source.replace(entry,' command.exe=process.execPath;command.args=["-e","setInterval(()=>{},1000)"];\n'+entry);
 fs.writeFileSync(file,source);
 try{
  const start=Date.now(),e=await require(file).supervise({budget:1000});
  assert.ok(Date.now()-start<5000);assert.equal(e.cleanup,null);
  assert.ok(e.issues.includes("HOST_STARTUP_TIMEOUT"));assert.ok(e.issues.includes("INCOMPLETE_SUPERVISION_EVIDENCE"));
  assert.ok(e.hostPid>0);let alive=false;try{process.kill(e.hostPid,0);alive=true;}catch(error){assert.equal(error.code,"ESRCH");}
  assert.equal(alive,false);
 }finally{assert.ok(path.basename(dir).startsWith("wmo-silent-host-"));fs.rmSync(dir,{recursive:true,force:true});}
});

for(const platform of ["win32","linux"])test("synthetic external contract verifies structured "+platform+" origin",()=>{
 const root=platform==="win32"?"C:\\synthetic-ci":"/synthetic-ci";
 for(const spec of gate.EXTERNAL_TESTS){
  const p=platform==="win32"?path.win32:path.posix,row={file:spec.file,...meta(spec.file,spec.name,false),source:p.join(root,spec.file),error:externalError(spec,platform,root)};
  const check=gate.verifyExternalOutcome(row,spec,platform,root);
  assert.equal(check.verified,true);assert.equal(check.code,platform==="win32"?"ERR_ACCESS_DENIED":"ENOENT");
 }
});
for(const [name,mutate]of Object.entries({
 "missing origin":r=>r.error.origin=null,
 "missing structured target":r=>{r.error.origin.path=null;r.error.origin.resource=null;},
 "wrong structured target":r=>{if(process.platform==="linux")r.error.origin.path="/unrelated-dependency";else r.error.origin.resource="C:/unrelated-dependency";},
 "missing native stack":r=>r.error.origin.stack=null,
 "only matching message":r=>r.error.origin.stack="Error: ENOENT: protected Android dependency",
 "ordinary application throw":r=>r.error.origin.stack="Error: same message\n    at TestContext.<anonymous> ("+r.source+":2:1)",
 "wrong native operation":r=>r.error.origin.stack=r.error.origin.stack.replace("Object.readFileSync","Object.statSync"),
 "foreign caller":r=>r.error.origin.stack=r.error.origin.stack.replace(r.source,path.join(ROOT,"unrelated.js")),
 "wrong failure type":r=>r.error.failureType="hookFailed",
 "different code":r=>r.error.causeCode="EACCES",
 "missing code":r=>r.error.causeCode=null,
 "module loader":r=>{r.error.causeCode="MODULE_NOT_FOUND";r.error.origin=null;},
 "unexpected type":r=>r.error.causeType="TypeError",
 "missing syscall or permission":r=>{if(process.platform==="linux")r.error.origin.syscall=null;else r.error.origin.permission=null;},
 "wrong syscall or permission":r=>{if(process.platform==="linux")r.error.origin.syscall="stat";else r.error.origin.permission="FileSystemWrite";},
 "wrong errno":r=>r.error.origin.errno=process.platform==="linux"?-13:-2,
 "unexpected process exit metadata":r=>r.error.exitCode=1,
 "unexpected signal metadata":r=>r.error.signal="SIGTERM",
 "malformed origin":r=>r.error.origin.path={file:"forged"},
 "malformed stack":r=>r.error.origin.stack=42,
 "wrong platform outcome":r=>r.error=externalError(gate.EXTERNAL_TESTS[0],process.platform==="win32"?"linux":"win32"),
 "identity mismatch":r=>r.name+=" lookalike"
}))test("synthetic external origin rejects "+name,()=>{
 const spec=gate.EXTERNAL_TESTS[0],row={file:spec.file,...meta(spec.file,spec.name,false),error:externalError(spec)};
 mutate(row);assert.equal(gate.verifyExternalOutcome(row,spec).verified,false);
});
for(const index of [0,1])test("synthetic external missing execution rejects identity "+index,()=>{
 const r=synthetic(true),spec=gate.EXTERNAL_TESTS[index];
 for(const f of r.execution.record.files)f.results=f.results.filter(x=>key({file:f.file,...x})!==key(spec));
 rebuild(r);const o=inspect(r);assert.equal(o.accepted,false);assert.equal(o.missingCoverage.length,0);
 assert.equal(o.externalChecks[index].outcome,"MISSING");assert.equal(o.externalStatus,"UNVERIFIED");
});
test("synthetic both external identities cannot disappear behind unchanged approved counts",()=>{
 const r=synthetic(true);
 for(const f of r.execution.record.files)f.results=f.results.filter(x=>!gate.EXTERNAL_TESTS.some(s=>key(s)===key({file:f.file,...x})));
 rebuild(r);const o=inspect(r);assert.equal(o.scoped.tests,584);assert.equal(o.accepted,false);
 assert.ok(o.externalChecks.every(c=>c.outcome==="MISSING"));
});
for(const field of ["platform","cwd"])test("synthetic external environment rejects contradictory "+field,()=>{
 const r=synthetic();r.execution.record[field]=field==="cwd"?path.dirname(ROOT):"unverified-os";deny(r);
});
test("synthetic external duplicate, completion and result contradictions never verify",()=>{
 for(const mode of ["duplicate","missing completion","contradictory completion"]){
  const r=synthetic(true),spec=gate.EXTERNAL_TESTS[0],f=r.execution.record.files.find(f=>f.file===spec.file),row=f.results.find(x=>x.name===spec.name);
  if(mode==="duplicate"){f.results.push(clone(row));rebuild(r);}
  else if(mode==="missing completion")f.completions=f.completions.filter(x=>x.name!==spec.name);
  else f.completions.find(x=>x.name===spec.name).error.origin.stack=null;
  const o=inspect(r);assert.equal(o.accepted,false);assert.equal(o.externalStatus,"UNVERIFIED");
 }
});
const externalCases=[
 ["first missing",(f,rows)=>{const s=gate.EXTERNAL_TESTS[0];if(f===s.file)rows.splice(rows.findIndex(r=>r.name===s.name),1);}],
 ["second missing",(f,rows)=>{const s=gate.EXTERNAL_TESTS[1];if(f===s.file)rows.splice(rows.findIndex(r=>r.name===s.name),1);}],
 ["both missing",(f,rows)=>{for(let i=rows.length-1;i>=0;i--)if(gate.EXTERNAL_TESTS.some(s=>s.file===f&&s.name===rows[i].name))rows.splice(i,1);}],
 ["duplicate",(f,rows)=>{const s=gate.EXTERNAL_TESTS[0];if(f===s.file)rows.push({...rows.find(r=>r.name===s.name)});}],
 ["unexpected pass",(_,__,r)=>r.body=""],
 ["skip",(_,__,r)=>r.options="{skip:true}"],
 ["TODO",(_,__,r)=>r.options="{todo:true}"],
 ["cancellation",(_,__,r)=>r.options="{signal:AbortSignal.abort()}"],
 ["TypeError",(_,__,r)=>r.body='throw new TypeError("unrelated external");'],
 ["ReferenceError",(_,__,r)=>r.body='throw new ReferenceError("unrelated external");'],
 ["SyntaxError",(_,__,r)=>r.body='throw new SyntaxError("unrelated external");'],
 ["dependency loader",(_,__,r)=>r.body='require("./independently-missing-module");'],
 ["wrong resource",(_,__,r)=>r.body='require("fs").readFileSync("unrelated-missing-dependency");'],
 ["wrong denied resource",(_,__,r)=>r.body='require("fs").readFileSync("/not-the-known-android-resource");'],
 ["matching message only",(_,__,r)=>r.body='throw Error("ENOENT: no such file or directory, open Android");'],
 ["forged structured origin without native read",(_,__,r,root)=>{
  const spec=gate.EXTERNAL_TESTS[0];
  r.body='throw Object.assign(Error("same environmental message"),'+JSON.stringify(process.platform==="win32"
   ?{code:"ERR_ACCESS_DENIED",permission:"FileSystemRead",resource:gate.externalResource(spec,root)}
   :{code:"ENOENT",path:gate.externalResource(spec,root),syscall:"open",errno:-2})+');';
 }],
 ["late async error",(_,__,r)=>r.body='setImmediate(()=>{throw Error("late external")});'+r.body],
 ["native exit one",(_,__,r)=>r.body='setImmediate(()=>process.exit(1));'+r.body]
];
for(const [name,change]of externalCases)test("real native external contract rejects "+name,()=>{
 const r=runFixture({safety:true,change(file,rows,root){
  const row=rows.find(x=>key(x)===key(gate.EXTERNAL_TESTS[0]));
  if(row||["first missing","second missing","both missing","duplicate"].includes(name))change(file,rows,row,root);
 }}),o=r.outcome;
 assert.equal(o.accepted,false);assert.equal(o.missingCoverage.length,0,"Approved coverage must remain intact");
 assert.equal(o.externalStatus,"UNVERIFIED");
 if(name==="unexpected pass")assert.equal(o.externalChecks[0].outcome,"PASS");
 assert.match(r.summary,/EXTERNAL TEST CONTRACT: UNVERIFIED/);
 assert.doesNotMatch(r.summary,/filesystem permissions deny their protected/);
});
for(const which of ["strict","historical"])for(const code of ["ENOENT","ERR_ACCESS_DENIED"])
 test("real native unexpected "+code+" in "+which+" identity rejects",()=>{
 const target=which==="historical"?historical:{file:first,name:m.requiredTests[first][0]};
 const r=runFixture({change(file,rows){
  if(file!==target.file)return;
  rows.find(r=>r.name===target.name).body='require("fs").readFileSync('+JSON.stringify(code==="ENOENT"?"missing-required-dependency":"/outside-required-allowlist")+');';
 }}),o=r.outcome;
 assert.equal(o.accepted,false);assert.equal(o.missingCoverage.length,0);
 assert.ok(o.issues.some(x=>x.startsWith("UNEXPECTED_EXTERNAL_ACCESS_FAILURE_IN_APPROVED_TEST:")));
 const actual=o.rows.find(x=>key(x)===key(target));assert.equal(actual.error.causeCode,code);
});
test("synthetic external reporting keeps actual code and verification separate without absolute paths",()=>{
 const r=synthetic(true),o=inspect(r),summary=gate.formatSummary(m,o,r);
 assert.equal(o.externalStatus,"VERIFIED");
 const part=summary.split("## Exact external-test environmental outcomes")[1].split("## Missing required identities")[0];
 assert.ok(!part.includes(ROOT));assert.ok(!part.includes("C:/Users/ADMIN"));
 assert.match(part,new RegExp(process.platform==="linux"?"Missing file/directory result":"Access-denied result"));
 if(process.platform==="linux")assert.equal((part.match(/Access-denied result/g)||[]).length,0);
 const bad=clone(r),f=bad.execution.record.files.find(f=>f.file===gate.EXTERNAL_TESTS[0].file),row=f.results.find(x=>x.name===gate.EXTERNAL_TESTS[0].name);
 row.passed=true;row.error=null;rebuild(bad);const result=inspect(bad),text=gate.formatSummary(m,result,bad);
 assert.equal(result.accepted,false);assert.match(text,/— PASS; code null; UNVERIFIED/);
});


function configureOriginFixture(root,{legacyOrigin,missingExternal}){
 if(!legacyOrigin&&!missingExternal)return;
 const file=path.join(root,"scripts/ci/wasteScanRegressionGate.js");
 let source=fs.readFileSync(file,"utf8");
 if(legacyOrigin){
  const a=source.indexOf("function verifyExternalOutcome("),b=source.indexOf("function metadata(");
  assert.ok(a>=0&&b>a);source=source.slice(0,a)+LEGACY_RELATIVE_ORIGIN_SOURCE+"\n"+source.slice(b);
  for(const spec of gate.EXTERNAL_TESTS){
   const needle="relativeResource:"+JSON.stringify(spec.relativeResource);assert.equal(source.split(needle).length,2);
   source=source.replace(needle,"resource:"+JSON.stringify(legacyOperand(spec))+","+needle);
  }
 }
 if(missingExternal){
  assert.equal(process.platform,"linux");assert.equal(legacyOrigin,false);
  const home=path.resolve(root,"../../../.."),targets=gate.EXTERNAL_TESTS.map(s=>gate.externalResource(s,root));
  for(const target of targets){
   assert.ok(target.startsWith(home+path.sep),"Test-only permission grant must stay in its owned temporary home");
   assert.throws(()=>fs.lstatSync(target),{code:"ENOENT"},"Never grant a readable existing Android checkout");
  }
  const needle='"--allow-child-process"]';
  assert.equal(source.split(needle).length,2);
  source=source.replace(needle,'"--allow-child-process",'+targets.map(t=>JSON.stringify("--allow-fs-read="+t)).join(",")+"]");
 }
 fs.writeFileSync(file,source);
}
function externalRow(r,spec){return r.outcome.rows.find(x=>key(x)===key(spec));}
function fixtureMessages(r,file){
 return r.report.execution.record.files.find(f=>f.file===file).output.filter(x=>x.channel==="stdout")
  .flatMap(x=>x.message.split(/\r?\n/)).flatMap(s=>{try{return [JSON.parse(s)];}catch(_){return [];}});
}
function cwdBody(body,mode){
 const begin='const path=require("node:path"),fs=require("node:fs"),before=process.cwd();'
  +(mode==="nested"?'const nested=path.join(require("node:os").tmpdir(),"cwd space 雪");fs.mkdirSync(nested,{recursive:true});process.chdir(nested);'
   :'process.chdir(require("node:os").tmpdir());')
  +'console.log(JSON.stringify({anchoredCwdFixture:true,cwd:process.cwd(),source:__dirname}));';
 return begin+(mode==="restored"?'try{'+body+'}catch(e){process.chdir(before);console.log(JSON.stringify({restoredCwd:process.cwd()}));throw e;}':body);
}
test("source contract: only the two approved Android path declarations differ from original source",()=>{
 for(const spec of gate.EXTERNAL_TESTS){
  const original=git(["cat-file","blob",m.baseCommit+":"+spec.file]).replaceAll("\r\n","\n");
  const declarations=original.match(/const root="[^"\r\n]+";/g)||[];assert.equal(declarations.length,1);
  const directory=path.posix.dirname(spec.relativeResource);
  const replacement='const androidPath=require("node:path");\n const root=androidPath.resolve(__dirname,'+JSON.stringify(directory)+')+androidPath.sep;';
  const expected=original.replace(declarations[0],replacement);
  assert.equal(fs.readFileSync(path.join(ROOT,spec.file),"utf8").replaceAll("\r\n","\n"),expected,
   "No identity, assertion, ordering or unrelated definition may change");
  assert.equal(gate.externalResource(spec,ROOT),path.resolve(path.dirname(path.join(ROOT,spec.file)),spec.relativeResource));
 }
});
for(const index of [0,1])for(const mode of ["changed","restored","nested"])
 test("real native anchored external "+index+" is stable after worker cwd "+mode,()=>{
 const spec=gate.EXTERNAL_TESTS[index],r=runFixture({safety:true,change(file,rows){
  if(file===spec.file){const row=rows.find(x=>key(x)===key(spec));row.body=cwdBody(row.body,mode);}
 }});
 assert.equal(r.outcome.accepted,true);assert.equal(r.outcome.missingCoverage.length,0);
 assert.equal(r.outcome.scoped.tests,584);assert.equal(r.outcome.strict.passed,568);
 const actual=externalRow(r,spec),expected=gate.externalResource(spec,r.report.execution.record.cwd);
 assert.equal(actual.error.causeCode,"ERR_ACCESS_DENIED");
 assert.equal(gate.externalPathKey(actual.error.origin.resource,process.platform),gate.externalPathKey(expected,process.platform));
 assert.equal(path.isAbsolute(actual.error.origin.resource),true);
 const marker=fixtureMessages(r,spec.file).find(x=>x.anchoredCwdFixture);assert.ok(marker);
 assert.notEqual(marker.cwd,r.report.execution.record.cwd);
 if(mode==="restored")assert.equal(fixtureMessages(r,spec.file).find(x=>x.restoredCwd)?.restoredCwd,r.report.execution.record.cwd);
});
for(const index of [0,1])for(const mode of ["changed","restored"])
 test("real native wrong-location relative ENOENT rejects external "+index+" after "+mode,()=>{
 const spec=gate.EXTERNAL_TESTS[index],literal=process.platform==="linux"?"X:/legacy-android/"+spec.dependency:"wrong-relative/"+spec.dependency;
 const r=runFixture({safety:true,change(file,rows){if(file===spec.file)rows.find(x=>key(x)===key(spec)).body=cwdBody('require("fs").readFileSync('+JSON.stringify(literal)+',"utf8");',mode);}});
 assert.equal(r.outcome.accepted,false);assert.equal(r.outcome.missingCoverage.length,0);assert.equal(r.outcome.scoped.tests,584);
 assert.equal(externalRow(r,spec).error.causeCode,"ENOENT");
 if(process.platform==="linux")assert.equal(externalRow(r,spec).error.origin.path,literal);
 assert.equal(r.outcome.externalChecks[index].verified,false);assert.equal(r.outcome.externalChecks[1-index].verified,true);
 assert.match(r.summary,/EXTERNAL TEST CONTRACT: UNVERIFIED/);
});
test("real native legacy relative-origin red and corrected wrong-location green preserve safety coverage",()=>{
 const spec=gate.EXTERNAL_TESTS[0],change=(file,rows)=>{
  if(file===spec.file)rows.find(x=>key(x)===key(spec)).body=cwdBody('require("fs").readFileSync('+JSON.stringify(legacyOperand(spec))+',"utf8");',"restored");
 };
 // Only this isolated copy reinstates the exact previous vulnerable validator.
 // On Windows the relative-control ENOENT was never an accepted Android denial.
 const red=runFixture({safety:true,legacyOrigin:true,change}),green=runFixture({safety:true,change});
 assert.equal(red.outcome.accepted,process.platform==="linux");assert.equal(green.outcome.accepted,false);
 for(const r of [red,green]){
  assert.equal(r.outcome.missingCoverage.length,0);assert.equal(r.outcome.scoped.tests,584);
  assert.equal(externalRow(r,spec).error.causeCode,"ENOENT");assert.equal(r.report.execution.record.invocations,1);
  for(const c of m.safetyMustPass)assert.ok(r.outcome.rows.some(x=>key(x)===key(c)&&x.passed));
 }
 if(process.platform==="linux"){
  assert.equal(externalRow(red,spec).error.origin.path,externalRow(green,spec).error.origin.path);
  assert.equal(red.outcome.externalChecks[0].verified,true);
 }
 assert.equal(green.outcome.externalChecks[0].verified,false);assert.equal(green.outcome.externalChecks[1].verified,true);
});
for(const index of [0,1])for(const which of ["wrong absolute","parent traversal"])
 test("real native anchored external "+index+" rejects "+which+" operand",()=>{
 const spec=gate.EXTERNAL_TESTS[index],r=runFixture({safety:true,change(file,rows,root){
  if(file!==spec.file)return;
  const wrong=which==="wrong absolute"?path.join(root,"unrelated missing 雪.java"):"../unrelated-parent-"+spec.dependency;
  rows.find(x=>key(x)===key(spec)).body='require("fs").readFileSync('+JSON.stringify(wrong)+',"utf8");';
 }});
 assert.equal(r.outcome.accepted,false);assert.equal(r.outcome.missingCoverage.length,0);
 assert.equal(r.outcome.externalChecks[index].verified,false);assert.equal(r.outcome.externalChecks[1-index].verified,true);
});
test("real native test-only missing-resource grant reports Ubuntu absolute ENOENT or guarded Windows denial",()=>{
 // Both intended sibling layouts are inside a unique temporary fixture home.
 // Linux alone grants the exact proven-missing files in this test copy, never
 // the real Android checkout. Production permissionArgs stays unchanged.
 const r=runFixture({safety:true,missingExternal:process.platform==="linux"}),o=r.outcome;
 assert.equal(o.accepted,true);assert.equal(o.missingCoverage.length,0);
 for(const spec of gate.EXTERNAL_TESTS){
  const e=externalRow(r,spec).error,expected=gate.externalResource(spec,r.report.execution.record.cwd);
  if(process.platform==="linux"){assert.equal(e.causeCode,"ENOENT");assert.equal(e.origin.path,expected);assert.equal(e.origin.syscall,"open");}
  else {assert.equal(e.causeCode,"ERR_ACCESS_DENIED");assert.equal(gate.externalPathKey(e.origin.resource,process.platform),gate.externalPathKey(expected,process.platform));}
 }
 const part=r.summary.split("## Exact external-test environmental outcomes")[1].split("## Missing required identities")[0];
 assert.match(part,process.platform==="linux"?/Missing file\/directory result/:/Access-denied result/);
 if(process.platform==="linux")assert.doesNotMatch(part,/Access-denied result/);
});
for(const [name,platform,alter,accepted]of [
 ["POSIX exact spaces and Unicode","linux",s=>s,true],
 ["POSIX case mismatch","linux",s=>s.replace("AndroidStudioProjects","androidstudioprojects"),false],
 ["POSIX parent traversal","linux",s=>s.replace("/app/","/app/../app/"),false],
 ["POSIX duplicate separator","linux",s=>s.replace("/app/","//app/"),false],
 ["POSIX relative operand","linux",s=>s.slice(1),false],
 ["Windows forward separators","win32",s=>s.replaceAll("\\","/"),true],
 ["Windows drive case","win32",s=>s[0].toLowerCase()+s.slice(1),true],
 ["Windows component case mismatch","win32",s=>s.replace("AndroidStudioProjects","androidstudioprojects"),false],
 ["Windows parent traversal","win32",s=>s.replace("\\app\\","\\app\\..\\app\\"),false],
 ["Windows drive-relative format","win32",s=>s.replace(":\\",":"),false],
 ["Windows UNC alias","win32",s=>"\\\\server\\alias\\"+s.slice(3),false]
])test("synthetic anchored path rules: "+name,()=>{
 const root=platform==="win32"?"C:\\fixture space 雪\\.codex\\worktrees\\ci\\repo":"/fixture space 雪/.codex/worktrees/ci/repo";
 const spec=gate.EXTERNAL_TESTS[1],p=platform==="win32"?path.win32:path.posix,row={file:spec.file,...meta(spec.file,spec.name,false),source:p.join(root,spec.file),error:externalError(spec,platform,root)};
 const origin=row.error.origin,field=platform==="linux"?"path":"resource";origin[field]=alter(origin[field]);
 assert.equal(gate.verifyExternalOutcome(row,spec,platform,root).verified,accepted);
});
test("synthetic absolute Linux denial is distinct from absolute ENOENT",()=>{
 const spec=gate.EXTERNAL_TESTS[0],root="/fixture/.codex/worktrees/ci/repo",source=path.posix.join(root,spec.file);
 const e=externalError(spec,"linux",root);e.causeCode="ERR_ACCESS_DENIED";e.origin={path:null,syscall:null,permission:"FileSystemRead",resource:gate.externalResource(spec,root,"linux"),errno:null,stack:e.origin.stack};
 const row={file:spec.file,...meta(spec.file,spec.name,false),source,error:e},check=gate.verifyExternalOutcome(row,spec,"linux",root);
 assert.equal(check.verified,true);assert.equal(check.code,"ERR_ACCESS_DENIED");assert.match(check.environment,/Linux native FileSystemRead denial/);
 e.origin.resource=null;assert.equal(gate.verifyExternalOutcome(row,spec,"linux",root).verified,false);
});


test("full-source integrity: all twenty pins match independently transformed approved Git blobs",()=>{
 for(const safety of [false,true]){
  const profile=safety?"safety-required":"original-main";
  assert.deepEqual(Object.keys(gate.TEST_SOURCE_DIGESTS[profile]),m.files);
  for(const file of m.files){
   const reference=approvedTestReference(file,safety);
   assert.equal(sourceHash(reference),gate.TEST_SOURCE_DIGESTS[profile][file],file);
   assert.equal(gate.testSourceDigest(Buffer.from(reference)),sourceHash(reference));
  }
 }
 assert.equal(gate.TEST_SOURCE_POLICY["original-main"],m.baseCommit);
 assert.equal(gate.TEST_SOURCE_POLICY["safety-required"],m.safetyCommit);
});
for(const safety of [false,true])test("full-source integrity: actual approved "+(safety?"safety":"original")+" native baseline",()=>{
 const root=approvedSourceFixture(safety);
 try{
  const r=actualSourceGate(root,{cli:true}),o=r.outcome;
  assert.equal(o.accepted,true);assert.equal(o.sourceStatus,"VERIFIED");
  assert.equal(o.profile.name,safety?"safety-required":"original-main");
  assert.equal(o.scoped.tests,safety?584:557);assert.equal(o.strict.passed,safety?568:540);
  assert.equal(o.historical.failed,safety?16:17);assert.equal(o.missingCoverage.length,0);
  assert.equal(r.report.execution.record.invocations,1);assert.deepEqual(r.report.execution.record.filters,[]);
  assert.equal(o.externalChecks.length,2);assert.ok(o.externalChecks.every(x=>x.verified&&x.code==="ERR_ACCESS_DENIED"));
  assert.equal(r.report.testSources.before.files.length,10);assert.equal(r.report.testSources.after.status,"VERIFIED");
  if(safety)for(const c of m.safetyMustPass)assert.ok(o.rows.some(r=>key(r)===key(c)&&r.passed));
  assert.match(r.actualCLI.summary,/SOURCE INTEGRITY: VERIFIED/);assert.match(r.actualCLI.summary,/NOT CLAIMED PASSING/);
 }finally{removeFixture(root);}
});
for(const safety of [false,true])test("full-source integrity: CRLF approved "+(safety?"safety":"original")+" native baseline",()=>{
 const root=approvedSourceFixture(safety);
 try{
  for(const file of m.files)fs.writeFileSync(path.join(root,file),approvedTestReference(file,safety).replaceAll("\n","\r\n"));
  const r=actualSourceGate(root);assert.equal(r.outcome.accepted,true);assert.equal(r.outcome.sourceStatus,"VERIFIED");
  assert.equal(r.outcome.scoped.tests,safety?584:557);assert.equal(r.outcome.scoped.passed,safety?568:540);
 }finally{removeFixture(root);}
});
function removeFirstSourceAssertion(body,info,replacement=""){
 let found=null;
 const visit=n=>{if(!n||found)return;if(n.type==="ExpressionStatement"&&n.expression?.callee?.object?.name==="assert"){found=n;return;}
  for(const v of Object.values(n))if(Array.isArray(v))for(const e of v){if(e?.type)visit(e);}else if(v?.type)visit(v);};
 visit(info.fn.body);assert.ok(found,"Expected an assertion in the mandatory control");
 const a=found.start-info.fn.body.start,b=found.end-info.fn.body.start;
 return body.slice(0,a)+replacement+body.slice(b);
}
const sourceMutations=[
 ["empty mandatory callback",root=>rewriteApprovedCallback(root,stale,()=> "{}"),stale.file,true],
 ["mandatory assertion removed",root=>rewriteApprovedCallback(root,stale,(b,i)=>removeFirstSourceAssertion(b,i)),stale.file],
 ["mandatory assertion replaced with no-op",root=>rewriteApprovedCallback(root,stale,(b,i)=>removeFirstSourceAssertion(b,i,"void 0;")),stale.file],
 ["mandatory callback unconditionally returns",root=>rewriteApprovedCallback(root,stale,()=>"{return;}"),stale.file],
 ["test name retained implementation changed",root=>rewriteApprovedCallback(root,stale,()=>'{assert.ok(true);}'),stale.file],
 ["registration retained hooks changed",root=>fs.appendFileSync(path.join(root,stale.file),'\nrequire("node:test").before(()=>{});\n'),stale.file],
 ["module setup removed",root=>{const f=path.join(root,stale.file),s=fs.readFileSync(f,"utf8"),n=s.replace(/^const box=.*\n/m,"");assert.notEqual(s,n);fs.writeFileSync(f,n);},stale.file],
 ["new failing test replaced by empty callback",root=>{const f=path.join(root,stale.file),before=fs.readFileSync(f,"utf8")+'\ntest("new source-integrity strict test",()=>assert.fail("new failure"));\n';fs.writeFileSync(f,before.replace('()=>assert.fail("new failure")','()=>{}'));},stale.file],
 ["historical body modified",root=>rewriteApprovedCallback(root,historical,()=> "{}"),historical.file],
 ["safety addition body modified",root=>rewriteApprovedCallback(root,m.safetyTests[0],()=> "{}"),m.safetyTests[0].file],
 ["original body modified",root=>rewriteApprovedCallback(root,{file:first,name:m.requiredTests[first][0]},()=> "{}"),first],
 ["external anchored target changed",root=>{const s=gate.EXTERNAL_TESTS[0],f=path.join(root,s.file);fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace("../../../android-classification-reconciliation/","../../../unapproved-android-target/"));},gate.EXTERNAL_TESTS[0].file],
 ["external assertion changed",root=>{const s=gate.EXTERNAL_TESTS[0],f=path.join(root,s.file),text=fs.readFileSync(f,"utf8");assert.ok(text.includes('assert.match(owner,'));fs.writeFileSync(f,text.replace('assert.match(owner,','assert.doesNotMatch(owner,'));},gate.EXTERNAL_TESTS[0].file],
 ["unknown extra source content",root=>fs.appendFileSync(path.join(root,first),"\n// unapproved source content\n"),first],
 ["missing selected file",root=>fs.unlinkSync(path.join(root,first)),first],
 ["selected file replaced",root=>fs.copyFileSync(path.join(root,m.files[1]),path.join(root,first)),first],
 ["identical counts and displayed names",root=>fs.appendFileSync(path.join(root,stale.file),"\n;void 0;\n"),stale.file],
 ["all safety bodies empty with names retained",root=>{for(const c of m.safetyTests)rewriteApprovedCallback(root,c,()=> "{}");rewriteApprovedCallback(root,stale,()=> "{}");},stale.file],
 ["one safety registration missing",root=>removeApprovedRegistration(root,m.safetyTests[0]),m.safetyTests[0].file],
 ["all 27 safety additions removed",root=>{for(const c of m.safetyTests)removeApprovedRegistration(root,c);},m.safetyTests[0].file],
 ["stale alignment returns to failure",root=>rewriteApprovedCallback(root,stale,()=>'{assert.fail("stale authority regression");}'),stale.file],
 ["cross-file name collision",root=>fs.appendFileSync(path.join(root,first),'\nrequire("node:test")('+JSON.stringify(historical.name)+',()=>{});\n'),first],
 ["identical names altered import",root=>{const f=path.join(root,stale.file),s=fs.readFileSync(f,"utf8");assert.ok(s.includes('"node:crypto"'));fs.writeFileSync(f,s.replace('"node:crypto"','"crypto"'));},stale.file],
 ["one original file in safety snapshot",root=>fs.writeFileSync(path.join(root,stale.file),approvedTestReference(stale.file,false)),stale.file],
 ["entire original source under safety authority",root=>{for(const f of m.files)fs.writeFileSync(path.join(root,f),approvedTestReference(f,false));},stale.file],
 ["unexpected selected directory link",root=>{const dir=path.join(root,"tests"),target=path.join(root,"approved-tests-owned-target");fs.renameSync(dir,target);fs.symlinkSync(target,dir,process.platform==="win32"?"junction":"dir");},first],
 ["wrong case source filename",root=>{const f=path.join(root,first),hold=f+".case-hold";fs.renameSync(f,hold);fs.renameSync(hold,path.join(path.dirname(f),path.basename(f).toLowerCase()));},first],
 ["unapproved whitespace",root=>{const f=path.join(root,first);fs.writeFileSync(f," "+fs.readFileSync(f,"utf8"));},first]
];
for(const [name,change,file,cli]of sourceMutations)test("full-source integrity: rejects "+name,()=>{
 const root=approvedSourceFixture(true);
 try{
  const g=require(path.join(root,"scripts/ci/wasteScanRegressionGate")),before=g.verifyTestSources(g.detectProfile(m));
  assert.equal(before.status,"VERIFIED");const oldFingerprint=g.detectProfile(m).fingerprint;
  change(root);
  const r=actualSourceGate(root,{cli:!!cli});sourceRejects(r,file);
  assert.equal(r.report.profile.requireSafety,true,"No safety downgrade");
  if(name==="empty mandatory callback"){
   assert.equal(g.detectProfile(m).fingerprint,oldFingerprint,"The old production-only fingerprint is unchanged");
   assert.notEqual(r.report.testSources.before.fingerprint,before.fingerprint,"The complete test-source digest changes");
   assert.match(r.actualCLI.summary,/UNAPPROVED TEST SOURCE CONTENT/);
   assert.equal(r.actualCLI.status,1);
  }
 }finally{removeFixture(root);}
});
test("full-source integrity: valid safety inventory cannot invent original Git authority",()=>{
 const root=approvedSourceFixture(false);
 try{
  for(const f of m.files)fs.writeFileSync(path.join(root,f),approvedTestReference(f,true));
  const r=actualSourceGate(root);sourceRejects(r,first);
  assert.equal(r.report.profile.name,"original-main");
 }finally{removeFixture(root);}
});
test("full-source integrity: approved bytes cannot invent missing Git provenance",()=>{
 const root=approvedSourceFixture(true);
 try{
  fs.renameSync(path.join(root,".git"),path.join(root,".owned-hidden-git"));
  const r=actualSourceGate(root);assert.equal(r.outcome.accepted,false);
  assert.equal(r.report.profile.name,"unknown");assert.equal(r.report.execution,null);
 }finally{removeFixture(root);}
});
for(const [name,change]of [
 ["lone CR",s=>Buffer.from(s.replace("\n","\r"))],
 ["CRCRLF",s=>Buffer.from(s.replace("\n","\r\r\n"))],
 ["BOM",s=>Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(s)])],
 ["NUL",s=>Buffer.concat([Buffer.from(s),Buffer.from([0])])],
 ["invalid UTF-8",s=>Buffer.concat([Buffer.from(s),Buffer.from([0xc0,0xaf])])],
 ["UTF-16",s=>Buffer.from(s,"utf16le")],
 ["Unicode line separator",s=>Buffer.from(s.replace("\n","\u2028"))]
])test("full-source integrity: rejects unsupported "+name,()=>{
 const root=approvedSourceFixture(true);
 try{fs.writeFileSync(path.join(root,first),change(approvedTestReference(first,true)));sourceRejects(actualSourceGate(root),first);}
 finally{removeFixture(root);}
});
test("synthetic full-source integrity: only LF and CRLF representation canonicalizes",()=>{
 const s="const x=1;\n// approved line\n";
 assert.equal(gate.testSourceDigest(Buffer.from(s)),gate.testSourceDigest(Buffer.from(s.replaceAll("\n","\r\n"))));
 assert.equal(gate.testSourceDigest(Buffer.from(s)),gate.testSourceDigest(Buffer.from(s.replace("\n","\r\n"))));
 for(const changed of [s+" ",s+"// comment\n",s.replace("1","2"),s.replace("const","let")])
  assert.notEqual(gate.testSourceDigest(Buffer.from(s)),gate.testSourceDigest(Buffer.from(changed)));
 for(const changed of [Buffer.from(s.replace("\n","\r")),Buffer.from([0xef,0xbb,0xbf,...Buffer.from(s)]),Buffer.from([0xff])])
  assert.throws(()=>gate.testSourceDigest(changed),/UNSUPPORTED/);
});
for(const [label,mutate]of [
 ["missing source snapshot",r=>r.testSources.before=null],
 ["duplicate source path",r=>r.testSources.before.files[1].file=r.testSources.before.files[0].file],
 ["outside source path",r=>r.testSources.before.files[0].file="../outside.js"],
 ["wrong source profile",r=>r.testSources.before.profile="original-main"],
 ["altered reference commit",r=>r.testSources.before.reference=m.baseCommit],
 ["expected digest altered",r=>r.testSources.before.files[0].expected="0".repeat(64)],
 ["actual digest altered",r=>r.testSources.before.files[0].digest="0".repeat(64)],
 ["missing after snapshot",r=>r.testSources.after=null],
 ["changed inode after execution",r=>r.testSources.after.files[0].identity[1]="9999"],
 ["unexpected source inventory",r=>r.testSources.before.files.push(clone(r.testSources.before.files[0]))]
])test("synthetic full-source integrity: rejects "+label,()=>{const r=synthetic(true);mutate(r);deny(r);});
test("synthetic full-source integrity: unapproved path arguments reject before reading",()=>{
 for(const file of ["../tests/wholeImageRecognition.test.js","tests\\wholeImageRecognition.test.js",path.join(ROOT,first),"tests/WholeImageRecognition.test.js"])
  assert.throws(()=>gate.selectedTestPath(file),/UNAPPROVED/);
});
for(const mode of ["content changed","identical content replacement","content written and restored"])
 test("full-source integrity: detects native-window "+mode,()=>{
 const root=approvedSourceFixture(true);
 try{
  const file=stale.file;
  const start='const source=path.resolve(__dirname,"../../'+file+'"),saved=fs.readFileSync(source);';
  const mutate=start+(mode==="content changed"?'fs.appendFileSync(source,"\\n// observed source mutation\\n");'
   :mode==="identical content replacement"?'fs.renameSync(source,source+".owned-prior");fs.writeFileSync(source,saved);'
   :'fs.appendFileSync(source,"\\n// transient observed mutation\\n");fs.writeFileSync(source,saved);');
  const r=actualSourceGate(root,{mutateAfterStart:mutate});
  assert.equal(r.outcome.accepted,false);assert.equal(r.outcome.sourceStatus,"REJECTED");assert.equal(r.outcome.strictStatus,"FAIL");assert.equal(r.report.sourceStable,false);
  assert.equal(r.report.testSources.before.status,"VERIFIED");assert.equal(r.report.execution.record.invocations,1);
  assert.equal(r.outcome.missingCoverage.length,0);assert.equal(r.outcome.scoped.tests,584);
  assert.equal(r.outcome.scoped.passed,568);assert.equal(r.outcome.historical.failed,16);
  for(const c of m.safetyMustPass)assert.ok(r.outcome.rows.some(x=>key(x)===key(c)&&x.passed));
  if(mode==="content changed")assert.equal(r.report.testSources.after.status,"REJECTED");
  else {assert.equal(r.report.testSources.after.status,"VERIFIED");assert.ok(r.outcome.issues.includes("TEST_SOURCE_CHANGED_DURING_NATIVE_EXECUTION"));}
 }finally{removeFixture(root);}
});
test("full-source integrity: public source rejection names files without local paths",()=>{
 const root=approvedSourceFixture(true);
 try{
  rewriteApprovedCallback(root,stale,()=> "{}");const r=actualSourceGate(root,{cli:true});
  assert.match(r.actualCLI.summary,/SOURCE INTEGRITY: REJECTED/);assert.match(r.actualCLI.summary,/REFERENCE SNAPSHOT/);
  assert.ok(r.actualCLI.summary.includes(stale.file));assert.ok(!r.actualCLI.summary.includes(root));
  assert.match(r.actualCLI.summary,/NOT RUN/);assert.doesNotMatch(r.actualCLI.summary,/STRICT SAFETY REQUIREMENTS: PASS/);
 }finally{removeFixture(root);}
});
