"use strict";
// One native run is authoritative. Strict/history/external are post-run policy
// classes of those same outcomes; no test body or registration is adapted.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const crypto = require("node:crypto"), {spawn, spawnSync} = require("node:child_process");
const ROOT = path.resolve(__dirname, "../..");
const NODE_VERSION = "v22.23.5";
const APPROVED_MANIFEST_SHA256 = "2a3a3bd7129dbcfd344991020fd50f6eacd305f36ceab6dbc1b06ca42e1e3f78";
const FILES = Object.freeze([
 "tests/wholeImageRecognition.test.js", "tests/wasteScanReconciliation.test.js",
 "tests/wasteProductStateSafety.test.js", "tests/wasteScanCategoryResolution.test.js",
 "tests/wastePrimaryReconciliation.test.js", "tests/wasteScanCapability.test.js",
 "tests/wasteScanAccuracy.test.js", "tests/wasteDisplayNames.test.js",
 "tests/visionSafetyIdentityConsistency.test.js", "tests/perItemWasteAssessmentIds.test.js"
]);
const CI_FILES = [".github/workflows/waste-scan-regression.yml", "scripts/ci/wasteScanRegressionGate.js",
 "tests/ci/wasteScanKnownFailures.json", "tests/ci/wasteScanRegressionGate.test.js"];
const SAFETY_TEST_BLOBS = ["dd6337a6fdae1412d2c5462e2c6a3372fce264cb",
 "7cf52a7405073391a29d3b53674037cf492aa435", "7c0464eac68443ccfc3fe31772315e87bb9c406b"];
const SAFETY_SOURCE = Object.freeze({
 "services/wholeImageRecognitionService.js":"18372e630def2ca3154df0ba3f6d4efa2663b3c0905611bf2ba554fcf6b222c1",
 "services/perItemWasteAssessmentService.js":"3105b2eec98deddce4bb63327ff797bd4dd7f858f549490c68f447ce8c9c5651"
});
const LIMITS = Object.freeze({bytes: 16*1024*1024, output: 1024*1024, tests:5000, diagnostics:2000});
const NATIVE_TIMEOUT_MS = 30000;
const EXECUTION_TIMEOUT_MS = 180000;
const STARTUP_TIMEOUT_MS = 20000;
const SUPERVISOR_GRACE_MS = 10000;
const EXTERNAL_TESTS = Object.freeze([
 Object.freeze({file:"tests/wasteProductStateSafety.test.js",
  name:"reference Android parser permits Unknown catalog identity independently of its catalog stream",
  relativeResource:"../../../android-classification-reconciliation/AIWasteManagementSystem-LATEST/app/src/main/java/com/example/aiwastemanagementsystem/DetectedWasteItem.java",
  dependency:"DetectedWasteItem.java"}),
 Object.freeze({file:"tests/wastePrimaryReconciliation.test.js",
  name:"source-equivalent Android Unknown contract is wired through real presentation and original-primary navigation",
  relativeResource:"../../../../../AndroidStudioProjects/AIWasteManagementSystem-unknown-primary/app/src/main/java/com/example/aiwastemanagementsystem/WastePrimaryPresentation.java",
  dependency:"WastePrimaryPresentation.java"})
]);
const TEST_SOURCE_DIGESTS = Object.freeze({
 "original-main":Object.freeze({
 "tests/wholeImageRecognition.test.js": "56649bd9cd8e32843a7f14b27763121bf7a3d6506e95ba564e46f443dbeaa229",
 "tests/wasteScanReconciliation.test.js": "b9d644774b193d5b77f6ad56af13ae064747282c0f8f0ed67d13f6a110ec6c2b",
 "tests/wasteProductStateSafety.test.js": "5720d5272fd697e0737be47dea61a2f488cae214700ded24e9a62e4ef3113c22",
 "tests/wasteScanCategoryResolution.test.js": "1725d71ff24bb7bb003613ffd9ea6b11da04086bab5dd1172c1abc8aeb04fdf5",
 "tests/wastePrimaryReconciliation.test.js": "686770a3762f34dac7be7052037399918a44f191c46fb064eb3c029835c733a8",
 "tests/wasteScanCapability.test.js": "51ff41b3fe0d2523f8d74483b98f94ed95c7f898158fcc2c1ab4761fb23aa51e",
 "tests/wasteScanAccuracy.test.js": "d09b610ef936ec5a99177c16672533aebaf9163db883b7f306388329a32d0168",
 "tests/wasteDisplayNames.test.js": "e6bccc7608f27204f1018a53b89577c0f637457a33c46ce5eaefe45d29f8b606",
 "tests/visionSafetyIdentityConsistency.test.js": "077a08ea00f6e512ad847e61b9f17618b3a8bbb7e55b6b5d422a3c7008686a77",
 "tests/perItemWasteAssessmentIds.test.js": "8ea4aff26fbcbe668d9a6b3b0691dcff270598a7e03b200df293169a89ef27c6"
}),
 "safety-required":Object.freeze({
 "tests/wholeImageRecognition.test.js": "a8d44ee5fa9d08f8168c5f2e927f0165c168273f77f973d3000d083d140f7197",
 "tests/wasteScanReconciliation.test.js": "785994e6767001263080a56014045972e160d90cafdf9ed103c5d53f52adb7c5",
 "tests/wasteProductStateSafety.test.js": "5720d5272fd697e0737be47dea61a2f488cae214700ded24e9a62e4ef3113c22",
 "tests/wasteScanCategoryResolution.test.js": "1725d71ff24bb7bb003613ffd9ea6b11da04086bab5dd1172c1abc8aeb04fdf5",
 "tests/wastePrimaryReconciliation.test.js": "686770a3762f34dac7be7052037399918a44f191c46fb064eb3c029835c733a8",
 "tests/wasteScanCapability.test.js": "51ff41b3fe0d2523f8d74483b98f94ed95c7f898158fcc2c1ab4761fb23aa51e",
 "tests/wasteScanAccuracy.test.js": "030e76e4cd3a28972eeb190d7bc1c06fc649350aa0e9d7397844433a92a92ade",
 "tests/wasteDisplayNames.test.js": "e6bccc7608f27204f1018a53b89577c0f637457a33c46ce5eaefe45d29f8b606",
 "tests/visionSafetyIdentityConsistency.test.js": "077a08ea00f6e512ad847e61b9f17618b3a8bbb7e55b6b5d422a3c7008686a77",
 "tests/perItemWasteAssessmentIds.test.js": "8ea4aff26fbcbe668d9a6b3b0691dcff270598a7e03b200df293169a89ef27c6"
})
});
// Full-file pins come from the two approved Git revisions, with only the
// reviewed Android root declarations replaced. Never learn pins from a checkout.
const TEST_SOURCE_POLICY = Object.freeze({
 algorithm:"SHA-256; strict UTF-8; CRLF -> LF only",
 anchorCorrection:"source-anchored-android-roots-v1",
 "original-main":"713a888d324904678873c831d8c3fb778fc10a25",
 "safety-required":"4a6a022783941fce2c73c5f1d1e9c4ec1c50dcfc"
});
function testSourceDigest(bytes){
 let text;
 try{text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);}
 catch(_){throw Error("UNSUPPORTED_TEST_SOURCE_ENCODING_OR_LINE_ENDINGS");}
 if(text.charCodeAt(0)===0xfeff||text.includes("\0")||/\r(?!\n)/.test(text))
  throw Error("UNSUPPORTED_TEST_SOURCE_ENCODING_OR_LINE_ENDINGS");
 // Only the newline representation changes; every other byte/token is retained.
 return sha(Buffer.from(text.replaceAll("\r\n","\n"),"utf8"));
}
function selectedTestPath(file){
 if(!FILES.includes(file))throw Error("UNAPPROVED_SELECTED_TEST_SOURCE_PATH");
 let current=ROOT;
 for(const part of file.split("/")){
  const entries=fs.readdirSync(current);
  if(!entries.includes(part))throw Error(entries.some(s=>s.toLowerCase()===part.toLowerCase())
   ?"UNEXPECTED_SELECTED_TEST_SOURCE_CASE":"MISSING_SELECTED_TEST_SOURCE");
  current=path.join(current,part);
  const stat=fs.lstatSync(current);
  if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))
   throw Error("UNTRUSTED_SELECTED_TEST_SOURCE_LINK");
 }
 const actual=fs.realpathSync.native(current),expected=path.join(fs.realpathSync.native(ROOT),file);
 if(externalPathKey(actual,process.platform)!==externalPathKey(expected,process.platform))
  throw Error("SUBSTITUTED_SELECTED_TEST_SOURCE_PATH");
 return current;
}
const testFileIdentity=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String);
function readSelectedTestSource(file){
 const target=selectedTestPath(file);let fd;
 try{
  fd=fs.openSync(target,"r");
  const before=fs.fstatSync(fd,{bigint:true}),named=fs.lstatSync(target,{bigint:true});
  if(!before.isFile()||named.isSymbolicLink()
   ||JSON.stringify(testFileIdentity(before))!==JSON.stringify(testFileIdentity(named)))
   throw Error("SELECTED_TEST_SOURCE_CHANGED_WHILE_READING");
  const digest=testSourceDigest(fs.readFileSync(fd));
  const after=fs.fstatSync(fd,{bigint:true}),last=fs.lstatSync(selectedTestPath(file),{bigint:true});
  const identity=testFileIdentity(before);
  if(JSON.stringify(identity)!==JSON.stringify(testFileIdentity(after))
   ||JSON.stringify(identity)!==JSON.stringify(testFileIdentity(last)))
   throw Error("SELECTED_TEST_SOURCE_CHANGED_WHILE_READING");
  return {digest,identity};
 }finally{if(fd!==undefined)fs.closeSync(fd);}
}
function verifyTestSources(profile){
 const name=profile?.name,pins=TEST_SOURCE_DIGESTS[name];
 const result={profile:name??"unknown",status:"REJECTED",reference:pins?TEST_SOURCE_POLICY[name]:null,
  policy:TEST_SOURCE_POLICY.algorithm,anchorCorrection:TEST_SOURCE_POLICY.anchorCorrection,
  files:[],fingerprint:null,issues:[]};
 if(!pins){result.issues.push("UNTRUSTED_TEST_SOURCE_PROFILE");return result;}
 if(JSON.stringify(Object.keys(pins))!==JSON.stringify(FILES)
  ||Object.values(pins).some(x=>typeof x!=="string"||!/^[a-f0-9]{64}$/.test(x)))
  throw Error("INVALID_PINNED_TEST_SOURCE_INVENTORY");
 const resolved=new Set();
 for(const file of FILES){
  const row={file,expected:pins[file],digest:null,identity:null,verified:false,reason:null};
  try{
   const target=externalPathKey(fs.realpathSync.native(selectedTestPath(file)),process.platform);
   if(!target||resolved.has(target))throw Error("DUPLICATE_SELECTED_TEST_SOURCE_RESOLUTION");
   resolved.add(target);
   Object.assign(row,readSelectedTestSource(file));
   row.verified=row.digest===row.expected;
   if(!row.verified)row.reason="UNAPPROVED TEST SOURCE CONTENT";
  }catch(error){
   row.reason=/^[A-Z_ ]+$/.test(error.message??"")?error.message
    :["ENOENT","ENOTDIR"].includes(error.code)?"MISSING_SELECTED_TEST_SOURCE":"UNREADABLE_SELECTED_TEST_SOURCE";
  }
  result.files.push(row);
  if(!row.verified)result.issues.push(file+" :: "+row.reason);
 }
 if(result.files.length===FILES.length&&result.files.every(r=>typeof r.digest==="string"))
  result.fingerprint=sha(JSON.stringify(result.files.map(r=>[r.file,r.digest])));
 if(result.files.length===FILES.length&&result.files.every(r=>r.verified))result.status="VERIFIED";
 return result;
}
function testSourceSnapshotOK(s,profile){
 const pins=TEST_SOURCE_DIGESTS[profile];
 return !!pins&&exact(s,["profile","status","reference","policy","anchorCorrection","files","fingerprint","issues"])
  &&s.profile===profile&&s.status==="VERIFIED"&&s.reference===TEST_SOURCE_POLICY[profile]
  &&s.policy===TEST_SOURCE_POLICY.algorithm&&s.anchorCorrection===TEST_SOURCE_POLICY.anchorCorrection
  &&Array.isArray(s.issues)&&s.issues.length===0&&Array.isArray(s.files)&&s.files.length===FILES.length
  &&s.files.every((r,i)=>exact(r,["file","expected","digest","identity","verified","reason"])
   &&r.file===FILES[i]&&r.expected===pins[r.file]&&r.digest===pins[r.file]&&r.verified===true&&r.reason===null
   &&Array.isArray(r.identity)&&r.identity.length===5&&r.identity.every(x=>typeof x==="string"&&/^\d+$/.test(x)))
  &&s.fingerprint===sha(JSON.stringify(s.files.map(r=>[r.file,r.digest])));
}
function sameTestSourceSnapshot(a,b){
 return !!a&&!!b&&a.fingerprint===b.fingerprint
  &&JSON.stringify(a.files.map(r=>[r.file,r.identity]))===JSON.stringify(b.files.map(r=>[r.file,r.identity]));
}
const id = r => JSON.stringify([r.file,r.name]);
const object = x => x!==null && typeof x==="object" && !Array.isArray(x);
const exact = (x,keys) => object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const integer = x => Number.isSafeInteger(x)&&x>=0;
const token = x => typeof x==="string"&&/^[a-f0-9]{32}$/.test(x);
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const cancelled = r => ["cancelledByParent","testTimeoutFailure","testAborted"].includes(r.error?.failureType);
function absoluteKey(p) {
 if(typeof p!=="string"||!path.isAbsolute(p))return null;
 p=path.normalize(p);return process.platform==="win32"?p.toLowerCase():p;
}
function readManifest(){return JSON.parse(fs.readFileSync(path.join(ROOT,"tests/ci/wasteScanKnownFailures.json"),"utf8"));}
function validateManifest(m){
 if(sha(JSON.stringify(m))!==APPROVED_MANIFEST_SHA256)throw Error("MANIFEST_DIGEST_CHANGED");
 const rows=FILES.flatMap(file=>m.requiredTests[file].map(name=>({file,name})));
 if(m.schemaVersion!==1||JSON.stringify(m.files)!==JSON.stringify(FILES)||rows.length!==557
 ||new Set(rows.map(id)).size!==557||m.minimumTests!==557||m.knownFailures.length!==17
 ||new Set(m.knownFailures.map(id)).size!==17||m.safetyTests.length!==27
 ||new Set(m.safetyTests.map(id)).size!==27||m.safetyMustPass.length!==28
 ||new Set(m.safetyMustPass.map(id)).size!==28
 ||JSON.stringify(m.exclusions.map(id))!==JSON.stringify(EXTERNAL_TESTS.map(id)))throw Error("MANIFEST_INVENTORY_CHANGED");
 return m;
}
function countRows(rows){
 rows=Array.isArray(rows)?rows.filter(object):[];
 const tests=rows.filter(r=>r.kind==="test");
 return {tests:tests.length,passed:tests.filter(r=>r.passed&&!r.skip&&!r.todo).length,
 failed:tests.filter(r=>!r.passed&&!r.skip&&!r.todo&&!cancelled(r)).length,
 cancelled:tests.filter(r=>!r.skip&&!r.todo&&cancelled(r)).length,
 skipped:tests.filter(r=>r.skip).length,todo:tests.filter(r=>r.todo).length,
 suites:rows.filter(r=>r.kind==="suite").length,topLevel:rows.filter(r=>r.nesting===0).length};
}
function countsMatch(a,b){return exact(a,Object.keys(b))&&Object.keys(b).every(k=>integer(a[k])&&a[k]===b[k]);}
function offlineEnvironment(){
 const allow=["PATH","Path","SystemRoot","WINDIR","TEMP","TMP","HOME","USERPROFILE","LOCALAPPDATA","APPDATA"];
 return {...Object.fromEntries(allow.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]])),NODE_ENV:"test",TZ:"UTC"};
}
function normalized(b){
 if(b.includes(0))return b;
 try {const s=new TextDecoder("utf-8",{fatal:true}).decode(b);return Buffer.from(s.replaceAll("\r\n","\n"));}
 catch(_){return b;}
}
function sourcePath(file){
 const parts=file.split("/");
 if(!file||parts.some(p=>!p||p==="."||p==="..")||path.isAbsolute(file))throw Error("INVALID_SOURCE_PATH");
 let dir=ROOT;
 for(let i=0;i<parts.length;i++){
  dir=path.join(dir,parts[i]);const s=fs.lstatSync(dir);
  if(s.isSymbolicLink()||(i<parts.length-1?!s.isDirectory():!s.isFile()))throw Error("UNTRUSTED_SOURCE_LINK");
 }
 return dir;
}
function sourceFile(file){return fs.readFileSync(sourcePath(file));}
// Production fingerprint establishes profile evidence; full test bodies are authenticated separately below.
function production(file){return !file.startsWith("tests/")&&!CI_FILES.includes(file);}
function gitCall(args,{input,buffer=false,allowFailure=false}={}){
 // Use a neutral working directory so a repository-local executable cannot
 // shadow git.exe on Windows. Git replacement objects are never profile evidence.
 const r=spawnSync("git",["--no-optional-locks","-C",ROOT,...args],{cwd:os.tmpdir(),
  env:{...offlineEnvironment(),GIT_NO_REPLACE_OBJECTS:"1",GIT_OPTIONAL_LOCKS:"0"},
  encoding:buffer?undefined:"utf8",input,windowsHide:true,timeout:30000,maxBuffer:64*1024*1024});
 if(r.error||r.signal||(!allowFailure&&r.status!==0))throw Error("GIT_EVIDENCE_UNAVAILABLE");
 return allowFailure?r:(buffer?r.stdout:r.stdout.trim());
}
function treeRows(ref){
 const text=gitCall(["ls-tree","-rz",ref]);
 return text.split("\0").filter(Boolean).map(line=>{
  const match=/^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(line);
  if(!match)throw Error("UNSUPPORTED_SOURCE_TREE");
  return {mode:match[1],oid:match[2],file:match[3]};
 });
}
function baselineSource(m){
 const rows=treeRows(m.baseCommit).filter(r=>production(r.file));
 const sizes=gitCall(["cat-file","--batch-check=%(objectname) %(objecttype) %(objectsize)"],
  {input:rows.map(r=>r.oid).join("\n")+"\n"}).split(/\r?\n/);
 const large=new Map();
 rows.forEach((row,i)=>{const match=/^([a-f0-9]{40}) blob (\d+)$/.exec(sizes[i]??"");
  if(!match||match[1]!==row.oid)throw Error("INVALID_BASELINE_SIZE");
  if(Number(match[2])>4*1024*1024){
   // Read large blobs separately to keep the immutable baseline batch bounded,
   // while using the same text normalization as every other source file.
   const b=gitCall(["cat-file","blob",row.oid],{buffer:true});
   if(b.length!==Number(match[2])||crypto.createHash("sha1").update(Buffer.from("blob "+b.length+"\0"))
    .update(b).digest("hex")!==row.oid)throw Error("BASELINE_OBJECT_INVALID");
   large.set(row.file,{hash:sha(normalized(b)),large:true});
  }});
 const small=rows.filter(r=>!large.has(r.file));
 const data=gitCall(["cat-file","--batch"],{input:small.map(r=>r.oid).join("\n")+"\n",buffer:true});
 let at=0;const expected=new Map();
 for(const row of small){
  const end=data.indexOf(10,at);if(end<0)throw Error("BASELINE_OBJECT_TRUNCATED");
  const header=/^([a-f0-9]{40}) blob (\d+)$/.exec(data.subarray(at,end).toString("ascii"));
  if(!header||header[1]!==row.oid)throw Error("BASELINE_OBJECT_INVALID");
  const size=Number(header[2]),start=end+1,b=data.subarray(start,start+size);
  if(b.length!==size||data[start+size]!==10
   ||crypto.createHash("sha1").update(Buffer.from("blob "+size+"\0")).update(b).digest("hex")!==row.oid)
   throw Error("BASELINE_OBJECT_INVALID");
  expected.set(row.file,{hash:sha(normalized(b)),large:false});at=start+size+1;
 }
 if(at!==data.length)throw Error("BASELINE_OBJECT_TRAILING_DATA");
 for(const [file,value]of large)expected.set(file,value);
 return expected;
}
function profileFromEvidence({gitVerified=false,head=null,original=false,safety=false,fingerprint=null,
 evidence=[],requireSafety=false}={}){
 const name=gitVerified&&(original||safety)?(safety||requireSafety?"safety-required":"original-main"):"unknown";
 return {name,requireSafety:name==="safety-required",gitVerified,head,fingerprint,evidence};
}
function detectProfile(m,requireSafety=false){
 const evidence=[];let head=null;
 try{
  if(absoluteKey(gitCall(["rev-parse","--show-toplevel"]))!==absoluteKey(ROOT)
   ||gitCall(["rev-parse","--is-shallow-repository"])!=="false")throw Error("FULL_CHECKOUT_REQUIRED");
  head=gitCall(["rev-parse","HEAD"]);if(!/^[a-f0-9]{40}$/.test(head))throw Error("INVALID_HEAD");
  const commits=gitCall(["rev-list","HEAD"]).split(/\r?\n/);
  if(!commits.includes(m.baseCommit))throw Error("APPROVED_BASE_ANCESTRY_MISSING");
  const historicalObjects=gitCall(["rev-list","--full-history","--objects","HEAD","--",...new Set(m.safetyTests.map(r=>r.file))])
   .split(/\r?\n/).map(line=>line.split(" ",1)[0]);
  const ancestry=commits.includes(m.safetyCommit),blob=SAFETY_TEST_BLOBS.some(x=>historicalObjects.includes(x));
  const baseline=baselineSource(m),headPaths=treeRows("HEAD").filter(r=>production(r.file)).map(r=>r.file).sort();
  const actual=new Map([...baseline].map(([file])=>[file,sha(normalized(sourceFile(file)))]));
  const fingerprint=sha(JSON.stringify([...actual].sort((a,b)=>a[0].localeCompare(b[0]))));
  const original=JSON.stringify(headPaths)===JSON.stringify([...baseline.keys()].sort())
   &&[...baseline].every(([file,value])=>actual.get(file)===value.hash);
  const source=Object.entries(SAFETY_SOURCE).every(([file,hash])=>actual.get(file)===hash);
  if(ancestry)evidence.push("Approved safety commit is in tested HEAD ancestry (requirements stay mandatory after revert).");
  if(blob)evidence.push("Approved safety-test content is reachable in complete tested history.");
  if(source)evidence.push("Both actual safety production files match pinned normalized content fingerprints.");
  if(original)evidence.push("All "+baseline.size+" actual non-test/non-CI baseline files and HEAD path inventory match approved original content.");
  if(requireSafety)evidence.push("Explicit safety requirement strengthens policy.");
  evidence.push("Verified checkout root, complete history, HEAD and approved baseline ancestry.");
  if(!original&&!source&&!ancestry&&!blob)evidence.push("Actual source is neither verified original content nor an established safety revision.");
  return profileFromEvidence({gitVerified:true,head,original,safety:source||ancestry||blob,
   fingerprint,evidence,requireSafety});
 }catch(error){return profileFromEvidence({head,evidence:["UNTRUSTED PROFILE: "+error.message]});}
}
function profileOK(p){
 return exact(p,["name","requireSafety","gitVerified","head","fingerprint","evidence"])
  &&["original-main","safety-required","unknown"].includes(p.name)&&p.requireSafety===(p.name==="safety-required")
  &&typeof p.gitVerified==="boolean"&&(p.head===null||/^[a-f0-9]{40}$/.test(p.head))
  &&(p.fingerprint===null||/^[a-f0-9]{64}$/.test(p.fingerprint))
  &&Array.isArray(p.evidence)&&p.evidence.every(x=>typeof x==="string"&&x.length<4096)
  &&(p.name==="unknown"||p.gitVerified&&p.fingerprint!==null);
}
function originMetadata(cause){
 if(!cause||!["ENOENT","ERR_ACCESS_DENIED"].includes(cause.code))return null;
 const string=x=>typeof x==="string"&&x.length>0&&x.length<=8192&&!x.includes("\0")?x:null;
 return {path:string(cause.path),syscall:string(cause.syscall),permission:string(cause.permission),
  resource:string(cause.resource),errno:Number.isSafeInteger(cause.errno)?cause.errno:null,stack:string(cause.stack)};
}
function nativeError(e){
 return e?{code:typeof e.code==="string"||Number.isSafeInteger(e.code)?e.code:null,
  failureType:typeof e.failureType==="string"?e.failureType:null,
  exitCode:integer(e.exitCode)?e.exitCode:null,signal:typeof e.signal==="string"?e.signal:null,
  causeType:typeof e.cause?.constructor?.name==="string"?e.cause.constructor.name:null,
  causeCode:typeof e.cause?.code==="string"||Number.isSafeInteger(e.cause?.code)?e.cause.code:null,
  origin:originMetadata(e.cause)}:null;
}
function originOK(o){
 return o===null||exact(o,["path","syscall","permission","resource","errno","stack"])
 &&["path","syscall","permission","resource","stack"].every(k=>o[k]===null
  ||typeof o[k]==="string"&&o[k].length>0&&o[k].length<=8192&&!o[k].includes("\0"))
 &&(o.errno===null||Number.isSafeInteger(o.errno));
}
function errorOK(e){
 return e===null||exact(e,["code","failureType","exitCode","signal","causeType","causeCode","origin"])
 &&(e.code===null||typeof e.code==="string"||Number.isSafeInteger(e.code))
 &&(e.failureType===null||typeof e.failureType==="string")&&(e.exitCode===null||integer(e.exitCode))
 &&(e.signal===null||typeof e.signal==="string")&&(e.causeType===null||typeof e.causeType==="string")
 &&(e.causeCode===null||typeof e.causeCode==="string"||Number.isSafeInteger(e.causeCode))&&originOK(e.origin);
}
function externalPathKey(value,platform){
 if(typeof value!=="string"||!value||value.includes("\0"))return null;
 if(platform==="win32"){
  const clean=value.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/,"");
  if(!/^[A-Za-z]:[\\/]/.test(clean)||clean.slice(3).split(/[\\/]/).some(p=>!p||p==="."||p===".."))return null;
  const normalized=path.win32.normalize(clean);
  // Drive letters are case-insensitive. Preserve component spelling rather
  // than assuming every Windows directory uses case-insensitive lookup.
  return normalized[0].toLowerCase()+normalized.slice(1);
 }
 if(platform!=="linux"||!path.posix.isAbsolute(value)||value!==path.posix.normalize(value))return null;
 return value;
}
function externalResource(spec,root=ROOT,platform=process.platform){
 const p=platform==="win32"?path.win32:platform==="linux"?path.posix:null;
 if(!p||!object(spec)||typeof root!=="string"||!p.isAbsolute(root)||!EXTERNAL_TESTS.some(s=>id(s)===id(spec)
  &&s.relativeResource===spec.relativeResource&&s.dependency===spec.dependency))return null;
 // This anchor is the verified module location, never a worker/collector cwd.
 return p.resolve(p.dirname(p.join(root,spec.file)),spec.relativeResource);
}
function verifyExternalOutcome(row,spec,platform=process.platform,root=ROOT){
 const check={file:spec.file,name:spec.name,dependency:spec.dependency,
  outcome:!row?"MISSING":row.skip?"SKIPPED":row.todo?"TODO":cancelled(row)?"CANCELLED":row.passed?"PASS":"FAIL",
  code:row?.error?.causeCode??null,verified:false,environment:null,reason:"MISSING_EXTERNAL_EXECUTION"};
 const reject=reason=>({...check,reason}),expected=externalResource(spec,root,platform),target=externalPathKey(expected,platform);
 if(!row)return check;
 if(!target||id(row)!==id(spec)||row.kind!=="test"||row.nesting!==0
  ||externalPathKey(row.source,platform)!==externalPathKey(
   (platform==="win32"?path.win32:path.posix).join(root,spec.file),platform))return reject("UNTRUSTED_EXTERNAL_IDENTITY");
 if(check.outcome!=="FAIL")return reject("UNEXPECTED_EXTERNAL_"+check.outcome);
 const e=row.error,o=e?.origin;
 if(!errorOK(e)||e.code!=="ERR_TEST_FAILURE"||e.failureType!=="testCodeFailure"
  ||e.exitCode!==null||e.signal!==null||e.causeType!=="Error"||!o||!originOK(o))
  return reject("UNVERIFIED_EXTERNAL_ERROR_METADATA");
 const frames=o.stack?.split(/\r?\n/).filter(line=>/^\s+at /.test(line))??[];
 const caller=/^\s+at TestContext\.<anonymous> \((.+):(\d+):(\d+)\)$/.exec(frames[1]??"");
 if(!/^\s+at Object\.readFileSync \(node:fs:\d+:\d+\)$/.test(frames[0]??"")
  ||!caller||externalPathKey(caller[1],platform)!==externalPathKey(row.source,platform)
  ||!integer(row.line)||row.line<1||Number(caller[2])<row.line||Number(caller[3])<1)
  return reject("UNVERIFIED_DIRECT_NATIVE_READ_ORIGIN");
 if(e.causeCode==="ERR_ACCESS_DENIED"){
  if(o.permission!=="FileSystemRead"||externalPathKey(o.resource,platform)!==target
   ||o.path!==null||o.syscall!==null||o.errno!==null)return reject("UNEXPECTED_ABSOLUTE_ACCESS_DENIAL_ORIGIN");
  return {...check,verified:true,environment:(platform==="win32"?"Windows":"Linux")
   +" native FileSystemRead denial for the source-anchored Android dependency",reason:null};
 }
 if(platform==="linux"&&e.causeCode==="ENOENT"){
  // Native path must itself be absolute. No cwd, message or source stack
  // can repair an ambiguous relative operand after the operation.
  if(externalPathKey(o.path,platform)!==target||o.syscall!=="open"||o.errno!==-2
   ||o.permission!==null||o.resource!==null)return reject("UNVERIFIED_ABSOLUTE_MISSING_RESOURCE_ORIGIN");
  return {...check,verified:true,environment:"Linux native open ENOENT at the absolute source-anchored Android dependency",reason:null};
 }
 return reject("UNEXPECTED_EXTERNAL_ERROR_CODE");
}
function metadata(d,passed){
 return {name:d.name,source:d.file??null,passed,skip:d.skip!==undefined&&d.skip!==false,
  todo:d.todo!==undefined&&d.todo!==false,nesting:d.nesting,kind:d.details?.type,
  number:d.testNumber,line:d.line,column:d.column,error:nativeError(d.details?.error)};
}
function metadataOK(d,file){
 return exact(d,["name","source","passed","skip","todo","nesting","kind","number","line","column","error"])
 &&typeof d.name==="string"&&d.name.length>0&&d.name.length<=4096
 &&absoluteKey(d.source)===absoluteKey(path.join(ROOT,file))&&typeof d.passed==="boolean"
 &&typeof d.skip==="boolean"&&typeof d.todo==="boolean"&&integer(d.nesting)
 &&["test","suite"].includes(d.kind)&&integer(d.number)&&d.number>0&&integer(d.line)&&d.line>0
 &&integer(d.column)&&d.column>0&&errorOK(d.error)&&(d.passed?d.error===null:d.error!==null);
}
function sameOutcome(a,b){
 if(!a||!b)return false;
 // Native run() renumbers leaf result events across files; completion events
 // retain their child-local number. Keep both originals, compare outcome data.
 const {number:an,...left}=a,{number:bn,...right}=b;
 return JSON.stringify(left)===JSON.stringify(right);
}
function unexpectedDiagnostic(d){
 return !exact(d,["source","level","message"])||(d.source!==null&&typeof d.source!=="string")
 ||!["info","warn","error"].includes(d.level)||typeof d.message!=="string"||d.message.length>4096
 ||d.level!=="info"||/^Error: (?:(?:Test|Test hook) "[\s\S]*"(?: at [\s\S]+:\d+:\d+)?|A resource) generated asynchronous activity after the test ended(?:\.|$)/.test(d.message);
}
function guardWarnings(text){
 const warning=/\(node:\d+\) SecurityWarning: The flag --allow-child-process must be used with extreme caution\. It could invalidate the permission model\.\n(?:\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n)?/g;
 const normalized=text.replaceAll("\r\n","\n"),matches=[...normalized.matchAll(warning)];
 return {count:matches.length,unexpected:normalized.replace(warning,"")};
}
function permissionArgs(root,tmp){
 return ["--permission","--allow-fs-read="+root,"--allow-fs-read="+tmp,"--allow-fs-write="+tmp,"--allow-child-process"];
}

const WINDOWS_JOB_SOURCE = "using System;\nusing System.Text;\nusing System.Threading;\nusing System.Runtime.InteropServices;\npublic static class WmoJob {\n [StructLayout(LayoutKind.Sequential)] struct Basic { public long User,Kernel;public uint Flags;public UIntPtr Min,Max;public uint Active;public UIntPtr Affinity;public uint Priority,Schedule; }\n [StructLayout(LayoutKind.Sequential)] struct IO {public ulong R1,R2,R3,R4,R5,R6;}\n [StructLayout(LayoutKind.Sequential)] struct Limits {public Basic Basic;public IO IO;public UIntPtr P1,P2,P3,P4;}\n [StructLayout(LayoutKind.Sequential)] struct Accounting {public long A,B,C,D;public uint Faults,Total,Active,Terminated;}\n [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {public uint cb;public string Reserved,Desktop,Title;public uint X,Y,XSize,YSize,CharsX,CharsY,Fill,Flags;public ushort Show,Reserved2;public IntPtr ReservedPtr,In,Out,Err;}\n [StructLayout(LayoutKind.Sequential)] struct Extended {public Startup Startup;public IntPtr Attributes;}\n [StructLayout(LayoutKind.Sequential)] struct Proc {public IntPtr Process,Thread;public uint Pid,Tid;}\n [DllImport(\"kernel32.dll\",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);\n [DllImport(\"kernel32.dll\",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,ref Limits l,uint n);\n [DllImport(\"kernel32.dll\",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int c,out Accounting a,uint n,IntPtr r);\n [DllImport(\"kernel32.dll\",SetLastError=true)] static extern bool TerminateJobObject(IntPtr j,uint c);\n [DllImport(\"kernel32.dll\",SetLastError=true)] static extern IntPtr GetStdHandle(int n);\n [DllImport(\"kernel32.dll\",SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint m,uint f);\n [DllImport(\"kernel32.dll\",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr p,int n,int f,ref IntPtr s);\n [DllImport(\"kernel32.dll\",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr p,uint f,IntPtr a,IntPtr v,IntPtr n,IntPtr o,IntPtr r);\n [DllImport(\"kernel32.dll\")] static extern void DeleteProcThreadAttributeList(IntPtr p);\n [DllImport(\"kernel32.dll\",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Extended s,out Proc p);\n [DllImport(\"kernel32.dll\",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr p,uint n);\n [DllImport(\"kernel32.dll\",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr p,out uint c);\n [DllImport(\"kernel32.dll\")] static extern bool CloseHandle(IntPtr h);\n static void Check(bool value,string op){if(!value)throw new Exception(op+\":\"+Marshal.GetLastWin32Error());}\n static uint Active(IntPtr job){Accounting a;Check(QueryInformationJobObject(job,1,out a,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),\"query\");return a.Active;}\n static string Quote(string value){var b=new StringBuilder(\"\\\"\");int slash=0;foreach(char c in value){if(c=='\\\\'){slash++;continue;}if(c=='\"'){b.Append('\\\\',slash*2+1);b.Append(c);slash=0;continue;}b.Append('\\\\',slash);slash=0;b.Append(c);}b.Append('\\\\',slash*2);b.Append('\"');return b.ToString();}\n static void Send(string json){Console.WriteLine(\"\\n\"+json);Console.Out.Flush();}\n public static int Run(string exe,string[] args,string cwd,string token,string jobName,int timeout){\n IntPtr job=IntPtr.Zero,list=IntPtr.Zero,jobs=IntPtr.Zero,handles=IntPtr.Zero;Proc p=new Proc();bool assigned=false;\n try{\n job=CreateJobObject(IntPtr.Zero,jobName);int last=Marshal.GetLastWin32Error();if(job==IntPtr.Zero||last==183)throw new Exception(\"create-job:\"+last);\n var limits=new Limits();limits.Basic.Flags=0x2000;Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))),\"limits\");\n Send(\"{\\\"host\\\":\\\"created\\\",\\\"token\\\":\\\"\"+token+\"\\\",\\\"hostPid\\\":\"+System.Diagnostics.Process.GetCurrentProcess().Id+\"}\");\n IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);list=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(list,2,0,ref size),\"attributes\");\n jobs=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobs,job);Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x2000D),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero),\"job-list\");\n var input=GetStdHandle(-10);var output=GetStdHandle(-11);var err=GetStdHandle(-12);\n Check(SetHandleInformation(input,1,1)&&SetHandleInformation(output,1,1)&&SetHandleInformation(err,1,1),\"inherit\");\n handles=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(handles,0,input);Marshal.WriteIntPtr(handles,IntPtr.Size,output);Marshal.WriteIntPtr(handles,IntPtr.Size*2,err);\n Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),\"handle-list\");\n var si=new Extended();si.Startup.cb=(uint)Marshal.SizeOf(typeof(Extended));si.Startup.Flags=0x100;si.Startup.In=input;si.Startup.Out=output;si.Startup.Err=err;si.Attributes=list;\n var command=new StringBuilder(Quote(exe));foreach(var arg in args)command.Append(\" \").Append(Quote(arg));\n Check(CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,true,0x08080000,IntPtr.Zero,cwd,ref si,out p),\"create-process\");assigned=true;\n Send(\"{\\\"host\\\":\\\"launched\\\",\\\"token\\\":\\\"\"+token+\"\\\",\\\"pid\\\":\"+p.Pid+\"}\");\n bool timed=WaitForSingleObject(p.Process,(uint)timeout)==258;uint code=2;\n if(timed)Check(TerminateJobObject(job,2),\"terminate-timeout\");WaitForSingleObject(p.Process,5000);Check(GetExitCodeProcess(p.Process,out code),\"exit\");\n var grace=DateTime.UtcNow.AddMilliseconds(250);while(Active(job)>0&&DateTime.UtcNow<grace)Thread.Sleep(10);\n uint remaining=Active(job);bool forced=remaining>0;if(forced)Check(TerminateJobObject(job,2),\"terminate-leftovers\");\n var until=DateTime.UtcNow.AddSeconds(5);while(Active(job)>0&&DateTime.UtcNow<until)Thread.Sleep(10);\n uint active=Active(job);Send(\"{\\\"host\\\":\\\"closed\\\",\\\"token\\\":\\\"\"+token+\"\\\",\\\"pid\\\":\"+p.Pid+\",\\\"exitCode\\\":\"+code+\",\\\"timedOut\\\":\"+(timed?\"true\":\"false\")+\",\\\"forced\\\":\"+(forced?\"true\":\"false\")+\",\\\"active\\\":\"+active+\"}\");\n return timed||active>0?2:(int)code;\n }finally{if(assigned&&job!=IntPtr.Zero)TerminateJobObject(job,2);if(p.Thread!=IntPtr.Zero)CloseHandle(p.Thread);if(p.Process!=IntPtr.Zero)CloseHandle(p.Process);if(list!=IntPtr.Zero){DeleteProcThreadAttributeList(list);Marshal.FreeHGlobal(list);}if(jobs!=IntPtr.Zero)Marshal.FreeHGlobal(jobs);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);if(job!=IntPtr.Zero)CloseHandle(job);}\n }\n}";
const LINUX_HOST_SOURCE = "import os,sys,json,time,signal,subprocess,ctypes\nc=json.loads(sys.argv[1])\nif not hasattr(os,\"pidfd_open\") or not hasattr(signal,\"pidfd_send_signal\"):\n raise RuntimeError(\"PIDFD_UNAVAILABLE\")\nif ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)!=0:\n raise RuntimeError(\"SUBREAPER_UNAVAILABLE\")\ncancel=False\ndef stop(signum,frame):\n global cancel\n cancel=True\nsignal.signal(signal.SIGTERM,stop)\nsignal.signal(signal.SIGINT,stop)\ndef send(v):\n v.update({\"token\":c[\"token\"]})\n print(\"\\n\"+json.dumps(v,separators=(\",\",\":\")),flush=True)\ndef info(pid):\n try:\n  s=open(\"/proc/\"+str(pid)+\"/stat\").read();x=s[s.rfind(\")\")+2:].split()\n  return {\"pid\":pid,\"state\":x[0],\"ppid\":int(x[1]),\"pgrp\":int(x[2]),\"start\":int(x[19])}\n except (OSError,ValueError,IndexError): return None\ndef children(pid):\n try:return [int(p) for p in open(\"/proc/\"+str(pid)+\"/task/\"+str(pid)+\"/children\").read().split()]\n except OSError:\n  if pid==os.getpid():raise RuntimeError(\"PROC_CHILDREN_UNAVAILABLE\")\n  return []\ndef owned():\n root=info(os.getpid())\n if root is None:raise RuntimeError(\"PROC_OWNERSHIP_UNAVAILABLE\")\n queue=[root];found=[]\n while queue:\n  parent=queue.pop()\n  if not parent:continue\n  current=info(parent[\"pid\"])\n  if not current or current[\"start\"]!=parent[\"start\"]:continue\n  for pid in children(parent[\"pid\"]):\n   a=info(pid)\n   if not a or a[\"ppid\"]!=parent[\"pid\"]:continue\n   try:fd=os.pidfd_open(pid)\n   except OSError:continue\n   b=info(pid)\n   if not b or b[\"start\"]!=a[\"start\"] or b[\"ppid\"]!=parent[\"pid\"]:\n    os.close(fd);continue\n   a[\"fd\"]=fd;found.append(a);queue.append(a)\n return found\ndef reaping():\n while True:\n  try:\n   p,s=os.waitpid(-1,os.WNOHANG)\n   if not p:return\n  except ChildProcessError:return\ndef signal_owned(sig):\n a=owned()\n try:\n  for p in a:\n   if p[\"state\"] in (\"Z\",\"X\"):continue\n   try:signal.pidfd_send_signal(p[\"fd\"],sig)\n   except ProcessLookupError:pass\n finally:\n  for p in a:os.close(p[\"fd\"])\n return len(a)\ndef count_owned():\n a=owned()\n try:return len(a)\n finally:\n  for p in a:os.close(p[\"fd\"])\nsend({\"host\":\"created\",\"hostPid\":os.getpid()})\np=subprocess.Popen([c[\"exe\"]]+c[\"args\"],cwd=c[\"cwd\"],stdin=sys.stdin,stdout=sys.stdout,stderr=sys.stderr,start_new_session=True)\nsend({\"host\":\"launched\",\"pid\":p.pid})\ndeadline=time.monotonic()+c[\"timeout\"]/1000\ntimed=False\nwhile p.poll() is None:\n if cancel or time.monotonic()>=deadline or os.getppid()!=c[\"parent\"]:\n  timed=True;break\n time.sleep(.02)\nif timed:\n signal_owned(signal.SIGTERM)\n until=time.monotonic()+.5\n while p.poll() is None and time.monotonic()<until:time.sleep(.02)\ncode=p.poll()\nif code is not None:\n until=time.monotonic()+.25\n while count_owned()>0 and time.monotonic()<until:\n  reaping();time.sleep(.01)\nforced=count_owned()>0\nif forced:\n signal_owned(signal.SIGTERM)\n until=time.monotonic()+.25\n while time.monotonic()<until:\n  if p.poll() is not None:reaping()\n  if count_owned()==0:break\n  time.sleep(.02)\n until=time.monotonic()+4\n while time.monotonic()<until:\n  signal_owned(signal.SIGSTOP);signal_owned(signal.SIGKILL)\n  if code is None:code=p.poll()\n  if code is not None:reaping()\n  if count_owned()==0:break\n  time.sleep(.02)\nif code is None:code=p.poll()\nif code is not None:reaping()\nremaining=count_owned()\nif children(os.getpid()):remaining=max(1,remaining)\nsend({\"host\":\"closed\",\"pid\":p.pid,\"exitCode\":code if code is not None and code>=0 else None,\n \"signal\":signal.Signals(-code).name if code is not None and code<0 else None,\n \"timedOut\":timed,\"forced\":forced,\"active\":remaining})\nsys.exit(2 if timed or remaining or code is None or code<0 else code)\n";

function emptyFile(file){return {file,completions:[],results:[],summary:null,completion:null,wrapperResults:[],output:[]};}
function beginNativeRecord(){
 return {node:process.version,platform:process.platform,cwd:process.cwd(),invocations:1,filters:[],files:FILES.map(emptyFile),results:[],
  summary:null,diagnostics:[],ended:false,activity:0,permissionArguments:null};
}
async function nativeCollect(c,controller){
 const record=beginNativeRecord(),map=new Map(record.files.map(f=>[absoluteKey(path.join(ROOT,f.file)),f]));
 record.permissionArguments=permissionArgs(ROOT,c.tmp);
 const send=data=>process.stdout.write(JSON.stringify({kind:"report",token:c.token,pid:process.pid,data})+"\n");
 const {run}=require("node:test");
 const stream=run({files:FILES.map(f=>path.join(ROOT,f)),isolation:"process",concurrency:1,
  execArgv:record.permissionArguments,argv:[],timeout:c.nativeTimeout,signal:controller.signal});
 let outputBytes=0,events=0;
 for await(const {type,data:d}of stream){
  if(++events>50000)throw Error("NATIVE_EVENT_LIMIT");
  const file=d.file?map.get(absoluteKey(d.file)):null;
  if(d.file&&!file)throw Error("FOREIGN_NATIVE_SOURCE");
  if(type==="test:complete"){
   if(!file)throw Error("MISSING_COMPLETION_SOURCE");
   const value=metadata(d,d.details?.passed);
   // Node's child summary precedes the FileTest completion. A leaf whose name
   // happens to be __filename still occurs before that summary.
   if(file.summary){
    if(file.completion||!metadataOK(value,file.file)||value.kind!=="test"||value.nesting!==0
     ||value.number!==FILES.indexOf(file.file)+1||value.line!==1||value.column!==1
     ||absoluteKey(value.name)!==absoluteKey(path.join(ROOT,file.file)))throw Error("INVALID_FILE_BOUNDARY");
    file.completion=value;
   }else file.completions.push(value);
  }else if(type==="test:pass"||type==="test:fail"){
   if(!file)throw Error("MISSING_RESULT_SOURCE");
   const value=metadata(d,type==="test:pass"),role=file.summary?"file":"leaf";
   if(role==="file"){
    if(!file.completion||JSON.stringify(file.completion)!==JSON.stringify(value))throw Error("INVALID_FILE_RESULT");
    file.wrapperResults.push(value);
   }else file.results.push(value);
   record.results.push({file:file.file,role,...value});
  }else if(type==="test:summary"){
   const value={counts:d.counts,success:d.success};
   if(file){if(file.summary||file.completion)throw Error("DUPLICATE_FILE_SUMMARY");file.summary=value;}
   else {if(record.summary)throw Error("DUPLICATE_NATIVE_SUMMARY");record.summary=value;}
  }else if(type==="test:diagnostic"){
   record.diagnostics.push({source:d.file??null,level:d.level,message:String(d.message??"")});
   if(record.diagnostics.length>LIMITS.diagnostics)throw Error("DIAGNOSTIC_LIMIT");
  }else if(type==="test:stdout"||type==="test:stderr"){
   if(!file||typeof d.message!=="string")throw Error("INVALID_NATIVE_OUTPUT");
   outputBytes+=Buffer.byteLength(d.message);if(outputBytes>LIMITS.output)throw Error("OUTPUT_LIMIT");
   file.output.push({channel:type==="test:stderr"?"stderr":"stdout",message:d.message});
  }else if(["test:enqueue","test:dequeue","test:start","test:plan"].includes(type)){
   record.activity++; // Registration/activity never establishes execution.
  }else throw Error("UNEXPECTED_NATIVE_EVENT");
  if(record.results.length>LIMITS.tests+FILES.length||record.files.some(f=>f.completions.length>LIMITS.tests))
   throw Error("NATIVE_TEST_LIMIT");
 }
 record.ended=true;
 if(Buffer.byteLength(JSON.stringify(record))>LIMITS.bytes-8192)throw Error("REPORT_LIMIT");
 send(record);process.exitCode=record.summary?.success?0:1;
}
function collectorMain(){
 let pending=Buffer.alloc(0),started=false;const controller=new AbortController();
 const fatal=()=>{controller.abort();process.exitCode=2;process.stdin.destroy();};
 process.stdin.on("error",fatal);
 process.stdin.on("end",()=>{if(!started||pending.length)fatal();});
 process.stdin.on("data",chunk=>{
  pending=Buffer.concat([pending,chunk]);if(pending.length>8192)return fatal();
  let end;
  while((end=pending.indexOf(10))>=0){
   const line=pending.subarray(0,end);pending=pending.subarray(end+1);
   let c;try{c=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(line));}catch(_){return fatal();}
   if(started){if(exact(c,["cancel"])&&c.cancel===true)controller.abort();else fatal();continue;}
   if(!exact(c,["token","pid","ppid","tmp","nativeTimeout"])||!token(c.token)||c.pid!==process.pid
    ||c.ppid!==process.ppid||typeof c.tmp!=="string"||!path.isAbsolute(c.tmp)
    ||!integer(c.nativeTimeout)||c.nativeTimeout<1||c.nativeTimeout>NATIVE_TIMEOUT_MS
    ||process.version!==NODE_VERSION)return fatal();
   started=true;
   process.stdout.write(JSON.stringify({kind:"start",token:c.token,pid:process.pid,
    ppid:process.ppid,node:process.version})+"\n");
   nativeCollect(c,controller).catch(()=>{controller.abort();process.exitCode=2;})
    .finally(()=>process.stdin.destroy());
  }
 });
}
function recordProblems(record,tmp){
 const issues=[],add=s=>{if(!issues.includes(s))issues.push(s);};
 if(!object(record)||record.node!==NODE_VERSION||record.platform!==process.platform
  ||absoluteKey(record.cwd)!==absoluteKey(ROOT)||record.invocations!==1||!Array.isArray(record.filters)
  ||record.filters.length||!Array.isArray(record.files)||!Array.isArray(record.results)
  ||!Array.isArray(record.diagnostics)||record.ended!==true)return ["INCOMPLETE_NATIVE_RECORD"];
 if(JSON.stringify(record.permissionArguments)!==JSON.stringify(permissionArgs(ROOT,tmp)))add("UNEXPECTED_NATIVE_ARGUMENTS");
 const seenFiles=new Set(),allLeaves=[],reported=[];
 for(const f of record.files){
  if(!object(f)||!FILES.includes(f.file)||seenFiles.has(f.file)){add("INVALID_FILE_INVENTORY");continue;}
  seenFiles.add(f.file);
  if(!Array.isArray(f.results)||!Array.isArray(f.completions)||!Array.isArray(f.wrapperResults)||!Array.isArray(f.output)){
   add("MALFORMED_FILE_RECORD");continue;
  }
  const complete=new Map(),identities=new Set(),numbers=new Set(),localNumbers=new Set();
  for(const d of f.completions){
   if(!object(d)){add("INVALID_OR_DUPLICATE_LEAF_COMPLETION");continue;}
   if(!metadataOK(d,f.file)||complete.has(JSON.stringify([d.name,d.nesting])))add("INVALID_OR_DUPLICATE_LEAF_COMPLETION");
   complete.set(JSON.stringify([d.name,d.nesting]),d);
   localNumbers.add(d.number);
  }
  if(localNumbers.size!==f.completions.length||[...localNumbers].sort((a,b)=>a-b).some((n,i)=>n!==i+1))
   add("CONTRADICTORY_CHILD_LOCAL_NUMBERS");
  for(const d of f.results){
   if(!metadataOK(d,f.file)){add("INVALID_LEAF_RESULT");continue;}
   const key=JSON.stringify([d.name,d.nesting]);
   if(!sameOutcome(complete.get(key),d))add("UNPAIRED_OR_CONTRADICTORY_LEAF");
   if(numbers.has(d.number))add("DUPLICATE_RESULT_NUMBER");numbers.add(d.number);
   if(identities.has(d.name))add("DUPLICATE_EXACT_IDENTITY");identities.add(d.name);
   if(d.kind!=="test"||d.nesting!==0)add("UNSUPPORTED_NONFLAT_IDENTITY");
   if(d.skip||d.todo||cancelled(d))add("UNEXPECTED_SKIP_TODO_CANCELLATION");
   allLeaves.push({file:f.file,...d});reported.push({file:f.file,role:"leaf",...d});
  }
  if(complete.size!==f.results.length)add("MISSING_LEAF_RESULT");
  const counts=countRows(f.results),expectedSuccess=counts.failed===0&&counts.cancelled===0;
  if(!exact(f.summary,["counts","success"])||!countsMatch(f.summary?.counts,counts)
   ||f.summary.success!==expectedSuccess)add("INVALID_OR_MISSING_FILE_SUMMARY");
  const end=f.completion,number=FILES.indexOf(f.file)+1;
  if(!end||!metadataOK(end,f.file)||end.kind!=="test"||end.nesting!==0||end.line!==1||end.column!==1
   ||end.number!==number||absoluteKey(end.name)!==absoluteKey(path.join(ROOT,f.file)))add("INVALID_OR_MISSING_FILE_COMPLETION");
  const code=end?.passed?0:end?.error?.exitCode,signal=end?.error?.signal??null;
  if(signal!==null||![0,1].includes(code))add("ABNORMAL_NATIVE_FILE_TERMINATION");
  if(expectedSuccess?(end?.passed!==true||code!==0):(end?.passed!==false||code!==1
   ||end?.error?.failureType!=="subtestsFailed"))add("UNEXPLAINED_NATIVE_FILE_FAILURE");
  if(f.wrapperResults.length>1)add("DUPLICATE_FILE_RESULT");
  for(const d of f.wrapperResults){
   if(JSON.stringify(d)!==JSON.stringify(end))add("CONTRADICTORY_FILE_RESULT");
   reported.push({file:f.file,role:"file",...d});
  }
  let stderr="",bytes=0;
  for(const o of f.output){
   if(!exact(o,["channel","message"])||!["stdout","stderr"].includes(o.channel)||typeof o.message!=="string"){
    add("INVALID_OUTPUT_RECORD");continue;
   }
   bytes+=Buffer.byteLength(o.message);if(o.channel==="stderr")stderr+=o.message;
  }
  if(bytes>LIMITS.output||guardWarnings(stderr).unexpected)add("UNEXPECTED_NATIVE_STDERR");
 }
 if(seenFiles.size!==FILES.length||record.files.length!==FILES.length)add("MISSING_SELECTED_FILE");
 // File results are emitted in file order at concurrency 1; names play no role
 // in deciding whether a record is an additional file-wrapper result.
 if(JSON.stringify(reported)!==JSON.stringify(record.results))add("CONTRADICTORY_NATIVE_RESULT_LEDGER");
 if(!exact(record.summary,["counts","success"])||!countsMatch(record.summary?.counts,countRows(record.results))
  ||record.summary.success!==(record.summary?.counts?.failed===0&&record.summary?.counts?.cancelled===0))
  add("INVALID_OR_MISSING_AGGREGATE_SUMMARY");
 if(record.diagnostics.some(unexpectedDiagnostic))add("UNEXPECTED_RUNNER_DIAGNOSTIC");
 if(allLeaves.length>LIMITS.tests)add("NATIVE_TEST_LIMIT");
 return issues;
}
function reportRows(record){
 return Array.isArray(record?.files)?record.files.flatMap(f=>object(f)&&Array.isArray(f.results)
  ?f.results.filter(object).map(r=>({file:f.file,...r})):[]):[];
}
function evaluateReport(report,m){
 validateManifest(m);
 const issues=[],missingCoverage=[],newFailures=[],historicalStill=[],historicalFixed=[],excluded=[];
 const result={accepted:false,decision:"REJECTED",strictStatus:"FAIL",identityStatus:"REJECTED",
  externalStatus:"UNVERIFIED",externalChecks:[],sourceStatus:"REJECTED",
  profile:report?.profile??null,raw:countRows([]),scoped:countRows([]),strict:countRows([]),historical:countRows([]),
  excluded,issues,missingCoverage,newFailures,historicalStill,historicalFixed,rows:[]};
 const add=s=>{if(!issues.includes(s))issues.push(s);};
 if(!object(report)||report.schemaVersion!==5||!profileOK(report.profile)||report.node!==NODE_VERSION
  ||process.version!==NODE_VERSION){add("MALFORMED_EXECUTION_REPORT");return result;}
 if(report.profile.name==="unknown"){
  result.decision="BLOCKED BY INSUFFICIENT EVIDENCE";add("UNKNOWN / UNTRUSTED PROFILE");return result;
 }
  const before=report.testSources?.before,after=report.testSources?.after;
  const beforeOK=testSourceSnapshotOK(before,report.profile.name),afterOK=testSourceSnapshotOK(after,report.profile.name);
  const same=beforeOK&&afterOK&&sameTestSourceSnapshot(before,after);
  result.sourceStatus=same?"VERIFIED":"REJECTED";
  if(!beforeOK||!afterOK)add("UNAPPROVED TEST SOURCE CONTENT");
  if(beforeOK&&afterOK&&!same)add("TEST_SOURCE_CHANGED_DURING_NATIVE_EXECUTION");
  if(report.execution===null)return result;
 const x=report.execution;
 if(!object(x)||!token(x.token)||!integer(x.pid)||x.pid<1||!x.closed
  ||!Array.isArray(x.issues)||x.issues.length||x.hostStderr!=="")add("UNVERIFIED_SUPERVISED_EXECUTION");
 if(!object(x?.cleanup)||x.cleanup.verified!==true||x.cleanup.active!==0
  ||!["windows-job","linux-subreaper"].includes(x.cleanup.method))add("UNVERIFIED_PROCESS_TREE_CLEANUP");
 if(x?.cleanup?.forced)add("ORPHANED_DESCENDANTS_REQUIRED_FORCED_CLEANUP");
 const record=x?.record;
 const nativeProblems=recordProblems(record,x?.tmp);
 for(const problem of nativeProblems)add(problem);
 const expectedExit=record?.summary?.success?0:1;
 if(x?.collectorExit!==expectedExit||x?.collectorSignal!==null||x?.hostTimedOut)add("UNEXPECTED_RUNNER_TERMINATION");
 if(report.sourceStable!==true)add("SOURCE_CHANGED_DURING_NATIVE_EXECUTION");
 const executionVerified=issues.length===0;
 const rows=reportRows(record),seen=new Map(),strict=[],historical=[];
 let safety=report.profile.requireSafety;
 if(rows.some(r=>m.safetyTests.some(s=>id(s)===id(r)))){
  safety=true;
  result.profile={...report.profile,name:"safety-required",requireSafety:true,
   evidence:[...report.profile.evidence,"Actual native safety identity observed; all 28 controls become mandatory."]};
 }
 const known=new Set(m.knownFailures.filter(r=>!safety||!m.safetyMustPass.some(s=>id(s)===id(r))).map(id));
 for(const r of rows){
  if(seen.has(id(r)))add("DUPLICATE_EXACT_IDENTITY");seen.set(id(r),r);
  if(m.exclusions.some(e=>id(e)===id(r))){excluded.push(r);continue;}
  if(["ERR_ACCESS_DENIED","ENOENT"].includes(r.error?.causeCode))
   add("UNEXPECTED_EXTERNAL_ACCESS_FAILURE_IN_APPROVED_TEST: "+r.file+" :: "+JSON.stringify(r.name));
  (known.has(id(r))?historical:strict).push(r);
  if(known.has(id(r)))(r.passed?historicalFixed:historicalStill).push(r);
  else if(!r.passed)newFailures.push(r);
 }
 for(const spec of EXTERNAL_TESTS){
  const matches=excluded.filter(r=>id(r)===id(spec));
  let check=verifyExternalOutcome(matches[0],spec);
  if(matches.length>1)check={...check,verified:false,outcome:"DUPLICATE",reason:"DUPLICATE_EXTERNAL_EXECUTION"};
  result.externalChecks.push(check);
  if(!check.verified)add("EXTERNAL_TEST_CONTRACT_REJECTED: "+spec.file+" :: "+JSON.stringify(spec.name)+" :: "+check.reason);
 }
 result.externalStatus=result.externalChecks.every(c=>c.verified)&&executionVerified?"VERIFIED":"UNVERIFIED";
 if(result.externalStatus!=="VERIFIED")add("UNVERIFIED_EXTERNAL_EXECUTION_CONTRACT");
 const required=FILES.flatMap(file=>m.requiredTests[file].map(name=>({file,name}))).concat(safety?m.safetyTests:[]);
 for(const r of required)if(!seen.has(id(r)))missingCoverage.push(r);
 if(safety)for(const r of m.safetyMustPass){
  const observed=seen.get(id(r));
  if(!observed||!observed.passed||observed.skip||observed.todo||!strict.some(s=>id(s)===id(r)))
   add("MANDATORY_SAFETY_CONTROL_NOT_PASSING: "+r.file+" :: "+JSON.stringify(r.name));
 }
 result.rows=rows;result.raw=countRows(rows);result.scoped=countRows([...strict,...historical]);
 result.strict=countRows(strict);result.historical=countRows(historical);
 if(!result.strict.tests)add("EMPTY_STRICT_REQUIREMENT_SET");
 result.strictStatus=result.sourceStatus==="VERIFIED"&&result.strict.tests&&!missingCoverage.some(r=>!known.has(id(r)))&&!result.strict.failed&&!result.strict.cancelled
  &&!result.strict.skipped&&!result.strict.todo?"PASS":"FAIL";
 result.identityStatus=issues.length||missingCoverage.length?"REJECTED":"VERIFIED";
 result.accepted=result.strictStatus==="PASS"&&result.identityStatus==="VERIFIED"&&!newFailures.length;
 result.decision=result.accepted?"ACCEPTED":"REJECTED";
 if(!x?.cleanup?.verified)result.decision="BLOCKED BY INSUFFICIENT EVIDENCE";
 return result;
}

function psQuote(value){return "'"+value.replaceAll("'","''")+"'";}
function windowsCommand(cfg){
 const script='$ErrorActionPreference="Stop";$ProgressPreference="SilentlyContinue";$source=@\'\n'
  +WINDOWS_JOB_SOURCE+'\n\'@\nAdd-Type -TypeDefinition $source;exit [WmoJob]::Run('
  +psQuote(cfg.exe)+',@('+cfg.args.map(psQuote).join(",")+'),'+psQuote(cfg.cwd)+','
  +psQuote(cfg.token)+','+psQuote("Local\\WmoFullNative-"+cfg.token)+','+cfg.timeout+')';
 const executable=path.join(process.env.SystemRoot??"C:\\Windows","System32/WindowsPowerShell/v1.0/powershell.exe");
 return {exe:executable,args:["-NoLogo","-NoProfile","-NonInteractive","-OutputFormat","Text","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")]};
}
function parseHostProtocol(context,onLaunch,onInvalid){
 let pending=Buffer.alloc(0),bytes=0,started=false,launched=false,ended=false,record=null,pid=null,collectorStart=false;
 const issues=[],add=s=>{if(!issues.includes(s))issues.push(s);onInvalid?.(s);};
 let cleanup=null,collectorExit=null,collectorSignal=null,hostTimedOut=false;
 function accept(value){
  if(!object(value)){add("MALFORMED_HOST_FRAME");return;}
  if(value.host){
   if(value.token!==context.token){add("HOST_TOKEN_MISMATCH");return;}
   if(value.host==="created"){
    if(started||!exact(value,["host","hostPid","token"])||value.hostPid!==context.hostPid){add("INVALID_HOST_CREATION");return;}
    started=true;
   }else if(value.host==="launched"){
    if(!started||launched||!exact(value,["host","pid","token"])||!integer(value.pid)||value.pid<1){add("INVALID_HOST_LAUNCH");return;}
    launched=true;pid=value.pid;onLaunch?.(pid);
   }else if(value.host==="closed"){
    const keys=["host","pid","exitCode","timedOut","forced","active","token",
     ...(context.platform==="linux"?["signal"]:[])];
    if(!launched||ended||!exact(value,keys)||value.pid!==pid||!(value.exitCode===null||integer(value.exitCode))
     ||typeof value.timedOut!=="boolean"||typeof value.forced!=="boolean"||!integer(value.active)
     ||context.platform==="linux"&&value.signal!==null&&typeof value.signal!=="string"){add("INVALID_HOST_CLOSE");return;}
    ended=true;collectorExit=value.exitCode;collectorSignal=value.signal??null;hostTimedOut=value.timedOut;
    cleanup={verified:value.active===0,active:value.active,forced:value.forced,
     method:context.platform==="win32"?"windows-job":"linux-subreaper"};
   }else add("UNKNOWN_HOST_FRAME");
  }else if(value.kind==="start"){
   if(!launched||collectorStart||ended||!exact(value,["kind","token","pid","ppid","node"])
    ||value.token!==context.token||value.pid!==pid||value.ppid!==context.hostPid||value.node!==NODE_VERSION)
    add("INVALID_COLLECTOR_START");
   else collectorStart=true;
  }else if(value.kind==="report"){
   if(!collectorStart||record!==null||ended||!exact(value,["kind","token","pid","data"])
    ||value.token!==context.token||value.pid!==pid||!object(value.data))add("INVALID_OR_DUPLICATE_NATIVE_REPORT");
   else record=value.data;
  }else add("UNKNOWN_PROTOCOL_FRAME");
 }
 return {
  write(chunk){
   bytes+=chunk.length;if(bytes>LIMITS.bytes+65536){add("PROTOCOL_OUTPUT_LIMIT");return;}
   pending=Buffer.concat([pending,chunk]);let end;
   while((end=pending.indexOf(10))>=0){
    const line=pending.subarray(0,end);pending=pending.subarray(end+1);
    if(line.length===0||line.length===1&&line[0]===13)continue;
    try{accept(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(line)));}
    catch(_){add("MALFORMED_PROTOCOL_JSON");}
   }
  },
  finish({code,signal,stderr="",error=null,tmp}){
   if(pending.length)add("TRUNCATED_PROTOCOL");
   if(!started||!launched||!collectorStart||!record||!ended)add("INCOMPLETE_SUPERVISION_EVIDENCE");
   if(error||signal||stderr)add("HOST_PROCESS_FAILURE");
   const expected=hostTimedOut||cleanup?.active||collectorSignal?2:collectorExit;
   if(code!==expected)add("HOST_EXIT_MISMATCH");
   return {token:context.token,pid,hostPid:context.hostPid,closed:true,collectorExit,collectorSignal,
    hostTimedOut,cleanup,record,hostCode:code,hostSignal:signal,hostStderr:stderr,issues,tmp};
  }
 };
}
function supervise({collectorFile=__filename,budget=EXECUTION_TIMEOUT_MS,nativeTimeout=NATIVE_TIMEOUT_MS}={}){
 if(!Number.isSafeInteger(budget)||budget<100||budget>EXECUTION_TIMEOUT_MS
  ||!Number.isSafeInteger(nativeTimeout)||nativeTimeout<1||nativeTimeout>NATIVE_TIMEOUT_MS)
  throw Error("INVALID_SUPERVISION_BUDGET");
 if(!["win32","linux"].includes(process.platform))throw Error("UNSUPPORTED_PROCESS_CONTAINMENT_PLATFORM");
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"wmo-full-native-")),nonce=crypto.randomBytes(16).toString("hex");
 const config={token:nonce,exe:process.execPath,args:[collectorFile,"--native-collect"],cwd:ROOT,
  parent:process.pid,timeout:budget};
 const command=process.platform==="win32"?windowsCommand(config)
  :{exe:"python3",args:["-u","-c",LINUX_HOST_SOURCE,JSON.stringify(config)]};
 return new Promise(resolve=>{
  const child=spawn(command.exe,command.args,{cwd:os.tmpdir(),
   env:{...offlineEnvironment(),TEMP:tmp,TMP:tmp,TMPDIR:tmp},stdio:["pipe","pipe","pipe"],windowsHide:true});
  const context={token:nonce,hostPid:child.pid,platform:process.platform};
  let stderr="",failure=null,launched=false,soft=null,hard=null,stopping=false;
  const stop=code=>{
   failure??=code;
   if(!stopping&&launched){stopping=true;child.stdin.write(JSON.stringify({cancel:true})+"\n");}
   if(process.platform==="linux")child.kill("SIGTERM");
  };
  const forceHost=()=>{failure??="SUPERVISOR_UNRESPONSIVE";child.kill("SIGKILL");};
  const startup=setTimeout(()=>{
   stop("HOST_STARTUP_TIMEOUT");hard=setTimeout(forceHost,SUPERVISOR_GRACE_MS);
  },STARTUP_TIMEOUT_MS);
  const reader=parseHostProtocol(context,pid=>{
   launched=true;clearTimeout(startup);if(hard)clearTimeout(hard);
   child.stdin.write(JSON.stringify({token:nonce,pid,ppid:child.pid,tmp,nativeTimeout})+"\n");
   soft=setTimeout(()=>stop("NATIVE_EXECUTION_DEADLINE"),Math.max(100,budget-250));
   if(failure)stop(failure);
   hard=setTimeout(()=>{
    failure??="SUPERVISOR_UNRESPONSIVE";
    // Windows job kill-on-close remains effective. Linux's trusted subreaper
    // has its own deadline; an unexplained supervisor death is never certified.
    child.kill("SIGKILL");
   },(failure?0:budget)+SUPERVISOR_GRACE_MS);
  },code=>stop(code));
  child.on("error",()=>{failure="HOST_LAUNCH_FAILED";});
  child.stdin.on("error",()=>{failure??="HOST_INPUT_FAILED";});
  child.stdout.on("data",b=>reader.write(b));
  child.stderr.on("data",b=>{
   stderr+=b.toString("utf8");if(Buffer.byteLength(stderr)>65536)stop("HOST_STDERR_LIMIT");
  });
  child.on("close",(code,signal)=>{
   clearTimeout(startup);if(soft)clearTimeout(soft);if(hard)clearTimeout(hard);child.stdin.destroy();
   const execution=reader.finish({code,signal,stderr,error:failure,tmp});
   if(failure&&!execution.issues.includes(failure))execution.issues.push(failure);
   // This directory is created by this call, and never contains source files.
   if(execution.cleanup?.verified&&!execution.cleanup.forced&&!execution.hostTimedOut&&!execution.issues.length
    &&recordProblems(execution.record,tmp).length===0
    &&path.dirname(tmp)===path.resolve(os.tmpdir())
    &&path.basename(tmp).startsWith("wmo-full-native-"))fs.rmSync(tmp,{recursive:true,force:true});
   resolve(execution);
  });
 });
}
async function executeGate(options={}){
 if(!exact(options,Object.keys(options))||Object.keys(options).some(k=>k!=="requireSafety")
  ||options.requireSafety!==undefined&&typeof options.requireSafety!=="boolean")throw Error("UNSUPPORTED_GATE_OPTIONS");
 const manifest=validateManifest(readManifest()),profile=detectProfile(manifest,options.requireSafety===true);
 if(process.version!==NODE_VERSION)throw Error("UNSUPPORTED_NODE_RUNTIME");
  const before=verifyTestSources(profile);
  if(profile.name==="unknown"||before.status!=="VERIFIED"){
   const report={schemaVersion:5,node:process.version,profile,execution:null,sourceStable:false,
    testSources:{before,after:null}};
   return {manifest,report,outcome:evaluateReport(report,manifest)};
  }
  const execution=await supervise(),afterProfile=detectProfile(manifest,options.requireSafety===true);
  const after=verifyTestSources(profile);
  const report={schemaVersion:5,node:process.version,profile,execution,
   testSources:{before,after},
   sourceStable:afterProfile.gitVerified&&afterProfile.head===profile.head
    &&afterProfile.fingerprint===profile.fingerprint&&after.status==="VERIFIED"&&sameTestSourceSnapshot(before,after)};
  return {manifest,report,outcome:evaluateReport(report,manifest)};
}
function formatSummary(m,o,r){
 const list=rows=>rows.length?rows.map(x=>"- "+x.file+" :: "+JSON.stringify(x.name)).join("\n"):"- None";
 const counts=c=>"Tests: "+c.tests+"; PASS: "+c.passed+"; FAIL: "+c.failed+"; skipped: "+c.skipped
  +"; TODO: "+c.todo+"; cancelled: "+c.cancelled+".";
 return [
 "# Waste Scan authoritative full-native scoped regression audit","",
   "**SOURCE PROFILE:** "+(o.profile?.name??"unknown"),
  "**SOURCE INTEGRITY: "+(o.sourceStatus??"REJECTED")+"**",
  "**REFERENCE SNAPSHOT:** "+(r?.testSources?.before?.reference??"Unavailable")
   +"; approved source-anchored Android root correction.",
  "Source policy: "+TEST_SOURCE_POLICY.algorithm+".",
  "Selected source inventory: "+FILES.length+" exact paths.",
  ...(r?.testSources?.before?.files??[]).map(f=>"- "+f.file+": "+(f.verified?"VERIFIED":"REJECTED")
   +(f.reason?"; "+f.reason:"")),
  ...(r?.testSources?.after?.issues??[]).map(s=>"- Post-execution source rejection: "+s),
  "Source integrity authenticates fixed reviewed content, not arbitrary PR code or a modified verifier.",
  "Before/after snapshots and file identities detect observed changes; transient change-and-restore or malicious same-process interference is not universally excluded.","",
"**AUTHORITATIVE NATIVE EXECUTION:** "+(r?.execution?.record?.ended?"Completed once, without name filters":"Not verified"),
 "**STRICT SAFETY REQUIREMENTS: "+o.strictStatus+"**",
 "**IDENTITY AUDIT: "+o.identityStatus+"**",
 "**EXTERNAL TEST CONTRACT: "+o.externalStatus+"**",
 "**OVERALL SCOPED REGRESSION DECISION: "+o.decision+"**","",
 "PROFILE: "+(o.profile?.name??"unknown")+"; runtime: "+(r?.node??process.version)+".",
 ...(o.profile?.evidence??[]).map(x=>"- "+x),"",
 "Full repository suite: NOT CLAIMED PASSING. Scoped acceptance is not selected-suite, backend-release or deployment approval.","",
 "## Raw native leaf outcomes",counts(o.raw),
 "File-wrapper outcomes are audited separately and are never extra leaf tests.",
 "## Approved offline scope",counts(o.scoped),
 "## Strict policy classification",counts(o.strict),
 "## Historical policy classification",counts(o.historical),
 "Historical FAIL outcomes remain unresolved. Exact identity does NOT establish unchanged failure cause.",
 "Historical nonzero native status alone cannot establish termination provenance or universally certify worker health.","",
   "## Actual mandatory safety controls",
  ...(o.profile?.requireSafety?m.safetyMustPass.map(c=>{const row=o.rows.find(x=>id(x)===id(c));return "- "+c.file+" :: "+JSON.stringify(c.name)+" - "+(!row?"NOT RUN":row.skip?"SKIPPED":row.todo?"TODO":row.passed?"PASS":"FAIL");}):["- Safety-only controls are not required by the original-main profile."]),
"## Actual historical FAIL identities",list(o.historicalStill),
 "## Actual historical improvements",list(o.historicalFixed),
 "## New strict failures",list(o.newFailures),
 "## Exact external-test environmental outcomes (outside approved offline counts)",
 ...(o.externalChecks??[]).map(c=>"- "+c.file+" :: "+JSON.stringify(c.name)+" — "+c.outcome
  +"; code "+JSON.stringify(c.code)+"; "+(c.verified?"VERIFIED":"UNVERIFIED")+"; dependency "+c.dependency
  +"; "+(c.verified?(c.code==="ERR_ACCESS_DENIED"?"Access-denied result.":"Missing file/directory result.")
   +" "+c.environment:"OTHER / UNVERIFIED: "+c.reason)+"."),
 "Both exact identities must execute once. No name filter supplies an environmental outcome.",
 "ENOENT is a missing file/directory result; it is not evidence of a permission denial or successful isolation.",
 "The filesystem guard permits child processes and is not a sandbox against malicious test code.",
  "Absolute native operand metadata is not cryptographic provenance or a guarantee of filesystem inode identity.","",
 "## Missing required identities",list(o.missingCoverage),
 "## Observed runtime / infrastructure issues",...(o.issues.length?o.issues.map(x=>"- "+x):["- None independently distinguished by the recorded checks."]),
 ...(r?.execution?.issues??[]).map(x=>"- "+x),
 "Collector exit: "+JSON.stringify(r?.execution?.collectorExit??null)+"; signal: "+JSON.stringify(r?.execution?.collectorSignal??null)+".",
 "Owned process cleanup: "+JSON.stringify(r?.execution?.cleanup??null)+".",
 ...(r?.execution?.record?.files??[]).map(f=>"- "+f.file+": native exit "+JSON.stringify(f.completion?.passed?0:f.completion?.error?.exitCode??null)
  +", signal "+JSON.stringify(f.completion?.error?.signal??null)+"; expected permission warnings "
  +guardWarnings((f.output??[]).filter(x=>x.channel==="stderr").map(x=>x.message).join("")).count+"."),
 "All bounded native stdout/stderr and diagnostics remain in the returned evidence; arbitrary payloads are omitted from this public summary.",
 "Forced-zero exit after otherwise complete valid evidence may be indistinguishable from normal completion.",
 "The host must remain trusted and live through verified cleanup; no universal containment against privileged/external-service process creation is claimed.",
 "## Exact selected files",...m.files.map(f=>"- "+f),""
 ].join("\n");
}
async function main(options={}){
 try{
  const result=await executeGate(options),summary=formatSummary(result.manifest,result.outcome,result.report);
  console.log(summary);if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary);
  process.exitCode=result.outcome.accepted?0:1;return result;
 }catch(_){
  const summary="Waste Scan authoritative native audit: BLOCKED BY INSUFFICIENT EVIDENCE.\n"
   +"Source integrity: REJECTED. Native execution: not established.\n"
   +"Strict safety requirements: FAIL. Identity audit: REJECTED.\n"
   +"The pinned runtime, manifest, profile or process containment could not be established. No full-suite PASS is claimed.\n";
  console.error(summary);if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary);
  process.exitCode=1;return null;
 }
}
module.exports={FILES,CI_FILES,EXTERNAL_TESTS,TEST_SOURCE_DIGESTS,TEST_SOURCE_POLICY,testSourceDigest,selectedTestPath,verifyTestSources,testSourceSnapshotOK,sameTestSourceSnapshot,SAFETY_TEST_BLOBS,SAFETY_SOURCE,NODE_VERSION,APPROVED_MANIFEST_SHA256,LIMITS,
 readManifest,validateManifest,countRows,countsMatch,offlineEnvironment,normalized,profileFromEvidence,detectProfile,
 profileOK,metadataOK,originMetadata,originOK,externalPathKey,externalResource,verifyExternalOutcome,recordProblems,reportRows,guardWarnings,permissionArgs,parseHostProtocol,supervise,
 evaluateReport,executeGate,formatSummary,main};
if(require.main===module){
 if(process.argv.length===3&&process.argv[2]==="--native-collect")collectorMain();
 else if(process.argv.length===2||process.argv.length===3&&process.argv[2]==="--require-safety")
  main({requireSafety:process.argv[2]==="--require-safety"});
 else {console.error("Unsupported native-audit arguments.");process.exitCode=2;}
}
