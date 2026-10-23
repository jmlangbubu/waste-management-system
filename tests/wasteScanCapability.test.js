"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),{createRequire}=require("node:module");
const capability="waste-scan-independent-category-v2";
const file=path.join(__dirname,"wastePrimaryReconciliation.test.js"),src=fs.readFileSync(file,"utf8"),m={exports:{}};
vm.runInNewContext(src.slice(0,src.indexOf('test("full bottle'))+"\nmodule.exports={fixture,localized,route};",{module:m,require:createRequire(file),__dirname,Buffer,URL,AbortController,setTimeout,clearTimeout});
const {fixture,localized,route}=m.exports,plain=v=>JSON.parse(JSON.stringify(v));
function objects(names){return names.map((n,i)=>localized(n,.93,{left:i*.25,top:.125,right:.125+i*.25,bottom:.625}));}
for(const provider of ["gemini","vision"])for(const names of [["Sachet","Can","Container","Bottle"],["Battery","Bottle"],["Banana Peel","Container"]])
test(`${provider} compatible independent owners: ${names.join(" + ")}`,async()=>{
 const raw=objects(names),f=fixture({objects:provider==="vision"?raw:[],labels:provider==="gemini"?raw.map(o=>[o.name,o.boundingBox]):[],compatible:true}),r=plain(await f.run());
 assert.equal(r.detectedItems.length,names.length);assert.equal(new Set(r.detectedItems.map(x=>x.itemId)).size,names.length);
 const categories=names.map(n=>n==="Sachet"?"Residual":n==="Battery"?"Special Waste":n==="Banana Peel"?"Biodegradable":"Recyclable");
 assert.deepEqual(r.detectedItems.map(x=>x.category),categories);
 r.detectedItems.forEach((o,i)=>{assert.deepEqual(o.boundingBox,raw[i].boundingBox);assert.equal(r.categoryAssessments.items.find(a=>a.itemId===o.itemId).category,o.category);});
 const response=await route(r,{capability,captureId:f.c.captureId});assert.equal(response.status,200);assert.equal(response.body.detectedItems.length,names.length);assert.equal(f.calls.assessment,0);
});
for(const marker of [undefined,"","invalid","waste-scan-independent-category-v3",[capability]])test(`legacy policy for unsupported capability: ${JSON.stringify(marker)}`,async()=>{
 const f=fixture({objects:objects(["Bottle","Unidentified object"])}),r=await f.run();
 assert.equal((await route(r,{capability:marker,captureId:f.c.captureId})).status,503);
});
test("compatible mixed supported/Unknown and Unknown-only retain neutral independent results",async()=>{
 for(const names of [["Bottle","Unidentified object"],["Unidentified object"],["Chemical container","Bottle"]]){
 const f=fixture({objects:objects(names),compatible:true}),r=plain(await f.run());assert.ok(r.detectedItems.some(x=>x.category==="Unknown"));
 assert.equal((await route(r,{capability,captureId:f.c.captureId})).status,200);assert.equal((await route(r)).status,503);
 }
});
test("foreign/duplicate/stale/contradictory sidecars cannot pass compatible safety policy",async()=>{
 const f=fixture({objects:objects(["Battery","Bottle"]),compatible:true}),r=plain(await f.run());
 for(const mutate of [x=>x.categoryAssessments.captureId="stale",x=>x.categoryAssessments.items[0].itemId="foreign",
 x=>x.categoryAssessments.items.push(x.categoryAssessments.items[0]),x=>x.categoryAssessments.items[0].category="Residual"]){
 const bad=plain(r);mutate(bad);assert.equal((await route(bad,{capability,captureId:f.c.captureId})).status,503);
 }
});
test("capability never turns explicit provider failure or empty Unknown primary into success",async()=>{
 for(const r of [{success:false,category:"Recyclable"},{category:"Unknown",detectedItems:[]}])assert.equal((await route(r,{capability})).status,503);
});
test("physical Bottle/Soap alias conflict retains Bottle identity and private veto through final assessment",async()=>{
 for(const reverse of [false,true]){
  const raw=objects(["Bottle"]),aliases=[raw[0],{...raw[0],name:"Soap",confidence:.99}];if(reverse)aliases.reverse();
  const f=fixture({objects:aliases,compatible:true}),r=plain(await f.run());
  assert.equal(r.detectedItems.length,1);assert.equal(r.detectedItems[0].itemName,"Bottle");
  assert.equal(r.detectedItems[0].category,"Unknown");assert.equal(r.categoryAssessments.items[0].category,"Unknown");
  assert.deepEqual(r.detectedItems[0].boundingBox,raw[0].boundingBox);assert.equal(f.calls.assessment,0);
  assert.equal((await route(r)).status,503);assert.equal((await route(r,{capability,captureId:f.c.captureId})).status,200);
  assert.deepEqual(Object.keys(r.detectedItems[0]).filter(k=>/conflict|provenance/i.test(k)),[]);
 }
});
