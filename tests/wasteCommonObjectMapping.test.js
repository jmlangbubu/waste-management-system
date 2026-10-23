"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),{createRequire}=require("node:module");
const {automaticCategory,productStateVeto}=require("../services/automaticWasteCategoryMapper");
const box={left:.1,top:.1,right:.3,bottom:.5};
const owner=label=>({analysisSource:"google_vision_object_localization",category:"Unknown",observedIdentity:label,boundingBox:box});
for(const source of ["google_vision_object_localization","gemini_whole_image"])
 for(const [label,expected] of [["Instant Noodle Packet","Residual"],["Instant Noodle Wrapper","Residual"],
  ["Empty Noodle Sachet","Residual"],["Coffee Packet","Residual"],["Coffee Sachet","Residual"],["Snack Wrapper","Residual"],
  ["Unopened Noodle Sachet",null],["Full Noodle Sachet",null],["Empty Noodle Sachet containing chemicals",null],
  ["Possibly Empty Noodle Sachet",null],["Printed picture of Empty Noodle Sachet",null]])
  test(`physical packaging state ${source}: ${label}`,()=>{
   const item={...owner(label),analysisSource:source};assert.equal(automaticCategory(item),expected);
   assert.equal(item.observedIdentity,label);
  });
const practicalMappings={
 Recyclable:["Plastic Bottle","Water Bottle","PET Bottle","Ordinary Bottle","Beverage Can","Soda Can","Aluminum Can","Tin Can","Ordinary Can","Ordinary Container","Plastic Container","Empty Food Container","Glass Bottle","Glass Jar","Clean Newspaper","Clean Paper","Cardboard","Cardboard Box","Clean Metal Can","Recoverable Metal Scrap"],
 Residual:["Empty Snack Sachet","Empty Coffee Sachet","Empty Shampoo Sachet","Snack Wrapper","Candy Wrapper","Chip Wrapper","Instant Noodle Wrapper","Multilayer Food Packaging","Laminated Wrapper","Used Tissue","Disposable Diaper","Sanitary Pad","Disposable Mask","Broken Ceramic","Non-recoverable Household Packaging"],
 Biodegradable:["Banana Peel","Mango Peel","Orange Peel","Fruit Peel","Vegetable Scraps","Eggshells","Coffee Grounds","Tea Leaves","Dry Leaves","Grass Clippings","Garden Trimmings","Plant Scraps"],
 "Special Waste":["Battery","Lithium Battery","Car Battery","Charger","Power Bank","Circuit Board","Electronic Waste","Fluorescent Lamp","Hazardous Light Bulb","Aerosol Can","Spray Paint Can","Paint Waste","Pesticide Container","Chemical Waste","Used Motor Oil","Needles and Sharps"]
};
for(const [category,names] of Object.entries(practicalMappings))for(const name of names)
 test(`practical exact localized identity: ${name}`,()=>assert.equal(automaticCategory(owner(name)),category));
test("new packaging aliases cannot erase explicit unsafe state or substitute geometry/display evidence",()=>{
 for(const name of ["Empty shampoo sachet containing unknown contents","Full food container","Unopened coffee sachet","Contaminated laminated wrapper","Printed picture of soda can","Possibly recoverable metal scrap"])
  assert.equal(automaticCategory(owner(name)),null,name);
 for(const boundingBox of [null,{...box,right:box.left},{...box,left:-.1},{...box,top:NaN}])
  assert.equal(automaticCategory({...owner("Soda Can"),boundingBox}),null);
 assert.equal(automaticCategory({...owner("Unidentified object"),itemName:"Soda Can"}),null);
});
const mappings={Recyclable:["Can","Aluminum Can","Tin Can","Empty Drink Can","Container","Plastic Container","Bottle","Plastic Bottle","Water Bottle","Glass Bottle","Paper","Cardboard","Cardboard Box","Newspaper","Clean Recyclable Plastic Packaging","Empty Aluminum Can","Empty Plastic Bottle"],
 Biodegradable:["Banana","Banana Peel","Fruit Peel","Fruit Scraps","Vegetable Scraps","Food Scraps","Leaves","Grass","Ordinary Plant Waste"],
 Residual:["Sachet","Snack Sachet","Snack Wrapper","Empty Instant Noodle Wrapper","Candy Wrapper","Used Tissue","Diaper","Pen","Comb","Empty Snack Wrapper"],
 "Special Waste":["Battery","Used Battery","Electronic Waste","Broken Electronic Device","Hazardous Chemical Waste","Hazardous Chemical Container","Hazardous Aerosol Can"]};
for(const [category,labels]of Object.entries(mappings))for(const label of labels)test(`approved common suggestion: ${label} -> ${category}`,()=>{
 const item=owner(label),before=structuredClone(item);assert.equal(automaticCategory(item),category);assert.deepEqual(item,before);
});
for(const label of ["Item","Unidentified Object","Mystery Object","Candy","Chemical Container","Maybe Bottle","Not a Can","Food Packaging","Bottle with Nozzle","Cosmetic Container","Unopened Snack Sachet","Full Bottle","Contaminated Can","Printed picture of Can","Can containing unknown contents","Chemical Bottle","Possibly Hazardous Container"])
 test(`uncertainty/explicit exception is not ordinary waste: ${label}`,()=>assert.equal(automaticCategory(owner(label)),null));
test("hazardous original/aligned evidence cannot be erased by an ordinary common name",()=>{
 for(const label of ["Chemical container","Bottle with nozzle","Contaminated can","Unopened snack sachet"]){
  assert.equal(productStateVeto({...owner("Container"),originalItemName:label},"Recyclable"),true);
  assert.equal(productStateVeto(owner("Container"),"Recyclable",label),true);
 }
});

function helpers(){
 const f=path.join(__dirname,"wastePrimaryReconciliation.test.js"),s=fs.readFileSync(f,"utf8"),m={exports:{}};
 vm.runInNewContext(s.slice(0,s.indexOf('test("full bottle'))+"\nmodule.exports={fixture,localized,route,unavailablePrimary};",
  {module:m,require:createRequire(f),__dirname,Buffer,URL,AbortController,setTimeout,clearTimeout});return m.exports;
}
const {fixture,localized,route,unavailablePrimary}=helpers();
test("ordinary three-object scene uses unique localized identities without optional AI",async()=>{
 const bounds=[{left:.125,top:.125,right:.25,bottom:.625},{left:.375,top:.125,right:.5,bottom:.625},{left:.625,top:.125,right:.75,bottom:.625}];
 for(const ai of [false,true])for(const [identity,category]of [["Instant Noodle Packet","Residual"],["Can","Recyclable"]]) {
  const objects=[localized("Can",.93,bounds[0]),localized("Item",.93,bounds[1]),localized("Bottle",.93,bounds[2])];
  const f=fixture({objects,labels:[[identity,bounds[1]]],compatible:true,ai}),r=JSON.parse(JSON.stringify(await f.run()));
  assert.equal(r.detectedItems.length,3);assert.equal(new Set(r.detectedItems.map(x=>x.itemId)).size,3);
  assert.deepEqual(r.detectedItems.map(x=>x.category),["Recyclable",category,"Recyclable"]);
  assert.equal(r.detectedItems[1].itemName,identity);
  r.detectedItems.forEach((item,i)=>{assert.deepEqual(item.boundingBox,bounds[i]);assert.equal(item.confidence,.93);
   assert.equal(item.analysisSource,"google_vision_object_localization");
   const row=r.categoryAssessments.items.find(row=>row.itemId===item.itemId);
   assert.equal(row.category,item.category);assert.equal(row.assessmentSource,"existing_category");assert.equal(row.requiresConfirmation,true);});
  assert.equal(f.calls.assessment,0);assert.equal((await route(r,{capability:"waste-scan-independent-category-v2",captureId:f.c.captureId})).status,200);
 }
});
test("unrecognized Item and ambiguous or hazardous alignment never acquire an ordinary fallback",async()=>{
 for(const labels of [[],[["Chemical packet"]],[["Instant Noodle Packet"],["Coffee Sachet"]]]) {
  const f=fixture({objects:[localized("Item")],labels,compatible:true,ai:false}),r=await f.run();
  assert.equal(r.detectedItems[0].category,"Unknown");assert.equal(r.categoryAssessments.items[0].category,"Unknown");
 }
});
for(const provider of ["vision","gemini"])for(const [label,category] of [
 ["Can","Recyclable"],["Bottle","Recyclable"],["Instant Noodle Packet","Residual"],["Coffee Sachet","Residual"],["Banana","Biodegradable"],["Battery","Special Waste"],
 ["Soda Can","Recyclable"],["Empty Noodle Sachet","Residual"],["Empty Coffee Sachet","Residual"],["Empty Shampoo Sachet","Residual"],
 ["Multilayer Food Packaging","Residual"],["Orange Peel","Biodegradable"],["Coffee Grounds","Biodegradable"],
 ["Spray Paint Can","Special Waste"],["Pesticide Container","Special Waste"]])
 test(`practical final compatible response ${provider}: ${label}`,async()=>{
  const raw=localized(label,.93,{left:.125,top:.125,right:.375,bottom:.625});
  const f=fixture({objects:provider==="vision"?[raw]:[],labels:provider==="gemini"?[[label,raw.boundingBox]]:[],compatible:true});
  const r=JSON.parse(JSON.stringify(await f.run())),item=r.detectedItems[0];
  assert.equal(r.detectedItems.length,1);assert.deepEqual(item.boundingBox,raw.boundingBox);
  assert.equal(item.category,category);assert.equal(r.categoryAssessments.captureId,f.c.captureId);
  const row=r.categoryAssessments.items.find(row=>row.itemId===item.itemId);
  assert.equal(row.category,category);assert.equal(row.requiresConfirmation,true);assert.equal(f.calls.assessment,0);
  assert.equal((await route(r,{capability:"waste-scan-independent-category-v2",captureId:f.c.captureId})).status,200);
 });
function androidCompatible(result,captureId){
 const f=path.join(__dirname,"wasteDisplayNames.test.js"),s=fs.readFileSync(f,"utf8"),m={exports:{}};
 vm.runInNewContext(s.slice(0,s.indexOf("for(const [raw,display]"))+"\nmodule.exports={v5RawOwner,v5SidecarAccepted};",{module:m,require:createRequire(f)});
 assert.ok(result.detectedItems.every(m.exports.v5RawOwner));
 assert.equal(m.exports.v5SidecarAccepted(result,captureId),true);
 // Source-equivalent parser checks, not installed-phone execution.
}
// Binary-exact fractions also serialize to integer 0..1000 discovery coordinates.
function scene(names){return names.map((name,i)=>localized(name,.93,{left:i*.25,top:.125,right:.125+i*.25,bottom:.625}));}
for(const names of [["Sachet","Can","Container","Bottle"],["Battery","Bottle"],["Sachet","Can"],["Banana Peel","Container"]])
 test(`real pipeline HTTP 200 with independent Vision owners: ${names.join(" + ")}`,async()=>{
  const objects=scene(names),f=fixture({objects,ai:true}),r=JSON.parse(JSON.stringify(await f.run()));
  assert.equal(r.detectedItems.length,names.length);assert.equal(new Set(r.detectedItems.map(x=>x.itemId)).size,names.length);
  r.detectedItems.forEach((x,i)=>{assert.equal(x.category,automaticCategory(owner(names[i])));assert.deepEqual(x.boundingBox,objects[i].boundingBox);assert.equal(x.confidence,.93);
   const a=r.categoryAssessments.items.find(a=>a.itemId===x.itemId);assert.equal(a.category,x.category);assert.equal(a.assessmentSource,"existing_category");assert.equal(a.requiresConfirmation,true);});
  assert.equal(r.categoryAssessments.captureId,f.c.captureId);assert.equal(f.calls.assessment,0);
  androidCompatible(r,f.c.captureId);
  const api=await route(r);assert.equal(api.status,200);assert.deepEqual(JSON.parse(JSON.stringify(api.body.detectedItems)),r.detectedItems);assert.deepEqual(JSON.parse(JSON.stringify(api.body.categoryAssessments)),r.categoryAssessments);
 });
test("Gemini noncatalog common names get independent mapped sidecars without faking catalog owners or paid calls",async()=>{
 const names=["Sachet","Can","Container","Bottle"],f=fixture({labels:names.map((name,i)=>[name,scene(names)[i].boundingBox]),ai:true});
 const r=JSON.parse(JSON.stringify(await f.run()));assert.equal(r.detectedItems.length,4);assert.equal(f.calls.assessment,0);
 r.detectedItems.forEach(x=>{assert.equal(x.analysisSource,"gemini_whole_image");const a=r.categoryAssessments.items.find(a=>a.itemId===x.itemId);
  assert.equal(a.category,automaticCategory(owner(x.observedIdentity)));assert.equal(a.assessmentSource,"reviewed_identity_rule");});
 assert.equal(r.detectedItems.find(x=>x.observedIdentity==="Can").category,"Unknown");
 androidCompatible(r,f.c.captureId);
 unavailablePrimary(await route(r)); // Existing legacy safety guard must NOT be bypassed.
});
test("genuinely unresolved secondary retains its box/ID and still fails safely before persistence",async()=>{
 const f=fixture({objects:scene(["Bottle","Unidentified object"]),ai:false}),r=JSON.parse(JSON.stringify(await f.run()));
 assert.deepEqual(r.detectedItems.map(x=>x.category),["Recyclable","Unknown"]);assert.equal(r.detectedItems.length,2);
 unavailablePrimary(await route(r));
});
test("explicit hazardous cross-provider evidence keeps its veto despite a common Bottle mapping",async()=>{
 const objects=scene(["Bottle","Battery"]),f=fixture({objects,labels:[["Chemical Bottle",objects[0].boundingBox]],ai:false}),r=JSON.parse(JSON.stringify(await f.run()));
 assert.equal(r.detectedItems.length,2);assert.equal(r.detectedItems[0].category,"Unknown");
 assert.equal(r.detectedItems[1].category,"Special Waste");androidCompatible(r,f.c.captureId);
 unavailablePrimary(await route(r));
});
