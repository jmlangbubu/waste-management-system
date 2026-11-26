"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process"), { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const gate = require("../../scripts/ci/wmoAppointmentOfflineGate");
const one = (file = "one.test.js", tests = 1, skips = []) => ({ file, tests, skips });
function fixture(t, sources) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmo-appointment-offline-ci-"));
  for (const [name, source] of Object.entries(sources)) fs.writeFileSync(path.join(root, name), 'const test=require("node:test"),assert=require("node:assert/strict");\n' + source);
  t.after(() => {
    const resolved = fs.realpathSync(root), temporary = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved), temporary); assert.ok(path.basename(resolved).startsWith("wmo-appointment-offline-ci-"));
    fs.rmSync(resolved, { recursive: true }); // Only this test's proven fresh temporary directory.
  });
  return { root, env: {}, timeoutMs: 10000, graceMs: 100 };
}
const passing = 'test("required",()=>assert.equal(1,1));';

test("manifest pins the 275/34/6 baseline, 13 named real-database skips and 24 gate controls", () => {
  assert.equal(gate.MANIFEST.length, 12); assert.equal(gate.MANIFEST.slice(0,9).reduce((n,s)=>n+s.tests,0),275);
  assert.equal(gate.MANIFEST.reduce((n,s)=>n+s.tests-s.skips.length,0),339);
  assert.equal(gate.MANIFEST.reduce((n,s)=>n+s.skips.length,0),13);
  assert.equal(gate.MANIFEST.at(-1).tests,24);
  assert.throws(()=>gate.assertRuntime("v20.0.0",[])); assert.throws(()=>gate.assertRuntime("v22.23.5",["--require=unapproved"]));
});
test("unsafe database/provider/activation and inherited execution configuration fail before spawn", async t => {
  const f=fixture(t,{"one.test.js":passing}); let spawns=0;
  for(const key of ["DATABASE_URL","MYSQL_URL","MYSQL_PWD","RESEND_API_KEY","APPOINTMENT_RESERVATIONS_ENABLED","WMO_APPOINTMENT_MYSQL_EXECUTE","WMO_APPOINTMENT_MIGRATION_EXECUTE","WMO_APPOINTMENT_MYSQL_PASSWORD","NODE_OPTIONS","NODE_PATH","NODE_TEST_CONTEXT","NODE_V8_COVERAGE","NODE_EXTRA_CA_CERTS","NODE_TLS_REJECT_UNAUTHORIZED","LD_PRELOAD","BASH_ENV","OPENSSL_CONF"]){
    const r=await gate.runGate({...f,manifest:[one()],env:{[key]:"synthetic-forbidden-value"},spawnImpl(){spawns++;throw Error("must not execute");}});
    assert.equal(r.ok,false);assert.equal(r.reason,"UNSAFE_ENVIRONMENT:"+key);assert.ok(!r.reason.includes("synthetic-forbidden-value"));
  } assert.equal(spawns,0);
});
test("child environment contains no credentials, execution flags, injected modules or GitHub tokens", () => {
  const e=gate.childEnvironment({PATH:"synthetic-path",DATABASE_URL:"",WMO_APPOINTMENT_MYSQL_EXECUTE:"",GITHUB_TOKEN:"synthetic-secret",UNRELATED:"value"});
  assert.deepEqual(e,{PATH:"synthetic-path",WMO_APPOINTMENT_OFFLINE_CI_CHILD:"1"});
  assert.doesNotThrow(()=>gate.assertOfflineEnvironment({DATABASE_URL:"",MYSQL_PWD:""}));
});
test("missing selected source fails before any child is launched", async t => {
  const f=fixture(t,{});let spawned=false;
  const r=await gate.runGate({...f,manifest:[one()],spawnImpl(){spawned=true;throw Error("forbidden");}});assert.equal(r.ok,false);assert.equal(spawned,false);
});
test("A: two required passing files require native summaries and confirmed process closure", async t => {
  const f=fixture(t,{"one.test.js":passing,"two.test.js":passing}),r=await gate.runGate({...f,manifest:[one(),one("two.test.js")]});
  assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(r.counts,{tests:2,passed:2,skipped:0});assert.equal(r.records.at(-1).type,"reporter:complete");
});
test("B: ordinary assertion failure is never accepted", async t => {
  const f=fixture(t,{"one.test.js":'test("required",()=>assert.fail("synthetic assertion"));'}),r=await gate.runGate({...f,manifest:[one()]});
  assert.equal(r.ok,false);assert.equal(r.reason,"CHILD_EXECUTION_FAILED");assert.equal(r.process.closed,true);assert.notEqual(r.process.code,0);assert.ok(r.failures.some(x=>x.name==="required"));
});
test("a selected module that cannot be loaded fails the gate", async t => {
  const f=fixture(t,{"one.test.js":'require("./missing-synthetic-module");'});assert.equal((await gate.runGate({...f,manifest:[one()]})).ok,false);
});
test("an empty source or printed PASS without registered tests cannot satisfy a required suite", async t => {
  const f=fixture(t,{"one.test.js":'console.log("PASS");'});assert.equal((await gate.runGate({...f,manifest:[one()]})).ok,false);
});
test("D: an unexpectedly skipped required test blocks success", async t => {
  const f=fixture(t,{"one.test.js":'test.skip("required",()=>{});'});assert.equal((await gate.runGate({...f,manifest:[one()]})).ok,false);
});
test("unexpected TODO tests block success", async t => {
  const f=fixture(t,{"one.test.js":'test.todo("required");'});assert.equal((await gate.runGate({...f,manifest:[one()]})).ok,false);
});
test("E: an uncaught asynchronous exception fails the actual Node child", async t => {
  const f=fixture(t,{"one.test.js":'test("required",()=>new Promise(resolve=>{setImmediate(()=>{throw Error("synthetic asynchronous exception");});setTimeout(resolve,30);}));'});
  const r=await gate.runGate({...f,manifest:[one()]});assert.equal(r.ok,false);assert.equal(r.reason,"CHILD_EXECUTION_FAILED");assert.ok(r.failures.length>0);
});
test("F: an unhandled promise rejection fails the actual Node child", async t => {
  const f=fixture(t,{"one.test.js":'test("required",()=>{Promise.reject(Error("synthetic rejection"));});'}),r=await gate.runGate({...f,manifest:[one()]});assert.equal(r.ok,false);assert.equal(r.reason,"CHILD_EXECUTION_FAILED");assert.ok(r.failures.length>0);
});
test("a late asynchronous exception after a passing test still blocks success", async t => {
  const f=fixture(t,{"one.test.js":'test("required",()=>{setTimeout(()=>{throw Error("synthetic late exception");},40);});'}),r=await gate.runGate({...f,manifest:[one()]});
  assert.equal(r.ok,false);assert.equal(r.reason,"CHILD_EXECUTION_FAILED");assert.ok(r.observedPassed>=1);assert.ok(r.failures.length>0);
});
test("G: a child failure after a preceding file passed blocks overall success", async t => {
  const f=fixture(t,{"one.test.js":passing,"two.test.js":'test("required",()=>{});setTimeout(()=>process.exit(7),40);'});
  const r=await gate.runGate({...f,manifest:[one(),one("two.test.js")]});assert.equal(r.ok,false);assert.ok(r.completedFiles.includes(path.join(f.root,"one.test.js")));assert.ok(r.failures.length>0);
});
test("H: a hanging process is terminated within the gate deadline", async t => {
  const f=fixture(t,{"one.test.js":'test("required",()=>new Promise(()=>setInterval(()=>{},1000)));'}),started=Date.now();
  const r=await gate.runGate({...f,manifest:[one()],timeoutMs:700});assert.equal(r.ok,false);assert.ok(["TIMEOUT","CLOSE_UNCONFIRMED"].includes(r.process.fault));assert.ok(Date.now()-started<8000);
});
test("H: a signal-terminated child is not considered a successful test run", async t => {
  const f=fixture(t,{"one.test.js":'test("required",()=>process.kill(process.pid,"SIGTERM"));'});assert.equal((await gate.runGate({...f,manifest:[one()]})).ok,false);
  assert.throws(()=>gate.validate([],{closed:true,code:0,signal:"SIGTERM"},[one()],f.root),/CHILD_EXECUTION_FAILED/);
});
test("spawn failure cannot become a passing empty run", async t => {
  const f=fixture(t,{"one.test.js":passing});
  const r=await gate.runGate({...f,manifest:[one()],spawnImpl:(exe,args,options)=>spawn(path.join(f.root,"missing-node-executable"),args,options)});assert.equal(r.ok,false);
});
test("output-pipe errors and absent close confirmation fail boundedly", async t => {
  const f=fixture(t,{"one.test.js":passing});
  for(const noClose of [false,true]){
    const r=await gate.runGate({...f,manifest:[one()],timeoutMs:100,graceMs:30,spawnImpl(){
      const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();p.kill=()=>{if(!noClose)queueMicrotask(()=>p.emit("close",1,null));return true;};
      queueMicrotask(()=>p.stdout.emit("error",Error("synthetic pipe failure")));return p;
    }});assert.equal(r.ok,false);
  }
});
test("K: only the explicitly named disabled real-MySQL test is an allowed skip", async t => {
  const name="synthetic real MySQL disabled",f=fixture(t,{"one.test.js":passing+'test.skip('+JSON.stringify(name)+',()=>{throw Error("live path must never execute");});'});
  const r=await gate.runGate({...f,manifest:[one("one.test.js",2,[name])]});assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(r.counts,{tests:2,passed:1,skipped:1});
});
test("a missing intentional skip or unexpectedly executed live-labelled case blocks success", async t => {
  const f=fixture(t,{"one.test.js":passing+'test("synthetic real MySQL disabled",()=>{});'});
  assert.equal((await gate.runGate({...f,manifest:[one("one.test.js",2,["synthetic real MySQL disabled"])]})).ok,false);
});
test("I: missing, duplicate, unexpected and inconsistent structured results block success", async t => {
  const f=fixture(t,{"one.test.js":passing}),r=await gate.runGate({...f,manifest:[one()]});assert.equal(r.ok,true,JSON.stringify(r));
  const good={closed:true,code:0,signal:null};
  for(const mutate of [rows=>rows.pop(),rows=>rows.splice(0,1),rows=>rows.push({type:"unexpected"}),rows=>rows.unshift(rows.find(x=>x.type==="test:summary")),
    rows=>{rows.find(x=>x.type==="test:summary"&&x.file===null).counts.tests++;},rows=>{rows.find(x=>x.type==="test:pass").file=path.join(f.root,"unapproved.test.js");}]){
    const rows=structuredClone(r.records);mutate(rows);assert.throws(()=>gate.validate(rows,good,[one()],f.root));
  }
  for(const outcome of [{...good,code:1},{...good,closed:false},{...good,fault:"late process error"}])assert.throws(()=>gate.validate(r.records,outcome,[one()],f.root));
});
test("partial execution followed by explicit exit zero cannot conceal missing required tests", async t => {
  const f=fixture(t,{"one.test.js":'test("required",()=>{});setTimeout(()=>process.exit(0),30);'});assert.equal((await gate.runGate({...f,manifest:[one("one.test.js",2)]})).ok,false);
});
test("offline preloads refuse database/provider imports and network access before any connection", async t => {
  const f=fixture(t,{"one.test.js":'test("required",()=>{assert.throws(()=>require("mysql2"),/OFFLINE_IMPORT_FORBIDDEN/);assert.throws(()=>require("resend"),/OFFLINE_IMPORT_FORBIDDEN/);assert.throws(()=>require("dotenv"),/OFFLINE_IMPORT_FORBIDDEN/);assert.throws(()=>require("node:net").connect(3306,"127.0.0.1"),/OFFLINE_NETWORK_FORBIDDEN/);});'});
  const r=await gate.runGate({...f,manifest:[one()]});assert.equal(r.ok,true,JSON.stringify(r));
});
test("workflow retains approved pins, read-only permissions, Draft PR triggers and offline-only commands", () => {
  // JSON is a YAML subset: validate syntax locally with Node's standard parser,
  // without adding a YAML dependency, then check the exact Actions configuration.
  const source=fs.readFileSync(path.resolve(__dirname,"../../.github/workflows/wmo-appointment-offline-ci.yml"),"utf8");
  const workflow=JSON.parse(source),job=workflow.jobs["appointment-offline"];
  assert.deepEqual(Object.keys(workflow).sort(),["jobs","name","on","permissions"]);assert.equal(workflow.name,"WMO Appointment Offline CI");
  assert.deepEqual(workflow.on,{pull_request:{branches:["main"],types:["opened","synchronize","reopened","ready_for_review"]}});
  assert.deepEqual(workflow.permissions,{contents:"read"});assert.equal(Object.keys(workflow.jobs).length,1);
  assert.deepEqual(Object.keys(job).sort(),["name","runs-on","steps","timeout-minutes"]);assert.equal(job["runs-on"],"ubuntu-latest");assert.equal(job["timeout-minutes"],10);
  assert.deepEqual(job.steps,[
    {name:"Check out tested revision",uses:"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",with:{"persist-credentials":false}},
    {name:"Set up Node.js 22",uses:"actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",with:{"node-version":"22.23.5","package-manager-cache":false}},
    {name:"Install locked dependencies without lifecycle scripts",run:"npm ci --ignore-scripts --no-audit --no-fund"},
    {name:"Run strict appointment offline gate and its negative controls",run:"node scripts/ci/wmoAppointmentOfflineGate.js"}
  ]);
  assert.doesNotMatch(source,/continue-on-error|secrets\.|pull_request_target|workflow_dispatch|docker|DATABASE_URL|RESEND_API_KEY/);
});
