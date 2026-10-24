"use strict";
// Synthetic offline geometry and evidence, NOT recovered from phone images.
const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
const {merge,identityConflict,alignedIdentity}=require("../services/wholeImageRecognitionService");
const {samePhysicalObject,buildScanSummary,normalizeDetectedItems}=require("../services/wasteAnalysisService");
const {createAssessmentService}=require("../services/perItemWasteAssessmentService");
const {withDisplayNames,shortObjectName}=require("../services/wasteDisplayNameService");
const box={left:.1,top:.1,right:.3,bottom:.5};
const drift={left:.106,top:.112,right:.306,bottom:.512};
const capture=()=>({captureId:crypto.randomUUID(),requestId:crypto.randomUUID(),image:Buffer.from("ffd8ffc0000b080190025801011100ffd9","hex").toString("base64"),width:600,height:400,orientation:"upright"});
const vision=(label,b=box,id="item_1")=>({itemId:id,itemName:label,canonicalItem:label.toLowerCase(),category:"Unknown",confidence:.8,analysisSource:"google_vision_object_localization",boundingBox:b});
const gemini=(c,label,b=box)=>whole.normalize(c,{objects:[{label,box_2d:[b.top,b.left,b.bottom,b.right].map(n=>Math.round(n*1000))}]}).objects[0];
const insufficient={category:"Unknown",kind:"unknown",material:"unknown",condition:"unknown",evidence:"insufficient"};
const recycling={category:"Recyclable",kind:"single_material",material:"pet_plastic",condition:"clean_dry",evidence:"visible"};
function service(facts=insufficient,options={}) {
 let calls=0;const requests=[];
 const assess=createAssessmentService({env:{WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"true",CLOUD_RUN_AUTH_MODE:"iam",CLOUD_RUN_AUDIENCE:"https://synthetic.invalid",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste",WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"offline-token-more-than-thirty-two-characters",...options.env},authHeaders:async()=>({}),transport:async(url,input)=>{
  calls++;requests.push(structuredClone(input));if(options.fail)throw Error("offline timeout");
  return {schemaVersion:1,captureId:input.captureId,requestId:input.requestId,assessments:input.items.map(item=>({itemId:item.itemId,...(typeof facts==="function"?facts(item):facts)}))};
 }});
 return {assess,requests,calls:()=>calls};
}
function ownersPreserved(items,originals) {
 for(const item of items){const owner=originals.find(other=>other.itemId===item.itemId);assert.ok(owner);
  for(const key of ["boundingBox","itemId","category","analysisSource","canonicalItem","confidence","observedIdentity"])
   assert.deepEqual(item[key],owner[key],key);
 }
}
const corroborationCases=[
 ["Can",["Can","Item"],"Recyclable"],
 ["Can",["Container"],"Recyclable"],
 ["Can",["Steel Food Tin"],"Recyclable"],
 ["Can",["Ordinary Food Can","Item"],"Recyclable"],
 ["Bottle",["Bottle","Object"],"Recyclable"],
 ["Item",["Discarded Instant Noodle Packet","Discarded Instant Noodle Wrapper"],"Residual"],
 ["Item",["Discarded Instant Noodle Packet","Item"],"Residual"]
];
for(const [label,labels,category]of corroborationCases)for(const known of [false,true])
 test(`corroborating Vision owner known=${known}: ${label} + ${labels.join(" + ")}`,async()=>{
  const c=capture(),v=known?normalizeDetectedItems([{name:label,confidence:.93,boundingBox:box}],"google_vision_object_localization")[0]:vision(label);
  for(const order of [labels,[...labels].reverse()]){
   const g=order.map(name=>gemini(c,name)),original=structuredClone([v,...g]),items=merge([v],g,samePhysicalObject,c);
   assert.equal(items.length,1);assert.equal(items[0].itemId,v.itemId);assert.equal(items[0].category,category);
   for(const key of ["canonicalItem","observedIdentity","boundingBox","analysisSource","confidence"])
    assert.deepEqual(items[0][key],v[key],key);
   assert.equal(identityConflict(items[0],c.captureId),false);
   const s=service(insufficient,{env:{WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"}}),sidecar=await s.assess({capture:c,items,principal:5});
   assert.equal(sidecar.items[0].category,category);assert.equal(sidecar.items[0].itemId,v.itemId);
   assert.equal(sidecar.items[0].assessmentSource,"existing_category");assert.equal(sidecar.captureId,c.captureId);
   assert.equal(sidecar.items[0].requiresConfirmation,true);assert.equal(s.calls(),0);
   assert.deepEqual([v,...g],original);
  }
 });

for(const [labels,category]of [[["Can","Beverage Can","Item"],"Recyclable"],
 [["Bottle","Water Bottle","Object"],"Recyclable"],
 [["Discarded Instant Noodle Packet","Discarded Instant Noodle Wrapper","Item"],"Residual"]])
 test(`corroborating Gemini owners retain original evidence: ${labels.join(" + ")}`,async()=>{
  const c=capture();
  for(const order of [labels,[...labels].reverse()]){
   const g=order.map(name=>gemini(c,name)),saved=structuredClone(g),items=merge([],g,samePhysicalObject,c);
   assert.equal(items.length,1);ownersPreserved(items,g);assert.equal(identityConflict(items[0],c.captureId),false);
   const s=service(insufficient,{env:{WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"}}),sidecar=await s.assess({capture:c,items,principal:5});
   assert.equal(sidecar.items[0].category,category);assert.equal(sidecar.items[0].assessmentSource,"reviewed_identity_rule");
   assert.equal(sidecar.items[0].itemId,items[0].itemId);assert.equal(s.calls(),0);assert.deepEqual(g,saved);
  }
 });

test("display refinement cannot forge a compatible original physical identity",()=>{
 const c=capture();
 const bottle={...normalizeDetectedItems([{name:"Bottle",confidence:.93,boundingBox:box}],"google_vision_object_localization")[0],itemName:"Can"};
 const items=merge([bottle],[gemini(c,"Steel Food Tin")],samePhysicalObject,c);
 assert.equal(items[0].canonicalItem,"bottle");assert.equal(items[0].category,"Unknown");
 assert.equal(identityConflict(items[0],c.captureId),true);
 const item={...vision("Item"),itemName:"Discarded Instant Noodle Wrapper"};
 assert.equal(merge([item],[gemini(c,"Item")],samePhysicalObject,c)[0].category,"Unknown");
});

for(const labels of [["Can","Chemical Can","Item"],["Can","Paint Can","Item"],
 ["Can","Aerosol Can","Item"],["Can","Spray Can","Item"],["Can","Pesticide Can","Item"],
 ["Can","Bottle","Item"],["Steel Can","Aluminum Can","Item"],
 ["Discarded Instant Noodle Packet","Unopened Instant Noodle Packet","Item"],
 ["Discarded Instant Noodle Wrapper","Sealed Instant Noodle Wrapper","Item"],
 ["Discarded Instant Noodle Wrapper","Full Instant Noodle Wrapper","Item"],
 ["Discarded Instant Noodle Wrapper","Contaminated Instant Noodle Wrapper","Item"],
 ["Discarded Instant Noodle Wrapper","Printed picture of Instant Noodle Wrapper","Item"],
 ["Discarded Instant Noodle Packet","Coffee Sachet","Item"]])
 test(`corroboration never overrides adverse or competing original evidence: ${labels.join(" + ")}`,async()=>{
  const c=capture(),v=vision(labels[0].includes("Can")?"Can":"Item");
  for(const order of [labels,[...labels].reverse()]){
   const items=merge([v],order.map(name=>gemini(c,name)),samePhysicalObject,c);
   assert.equal(items[0].itemId,v.itemId);assert.equal(items[0].category,"Unknown");
   const s=service(insufficient,{env:{WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"}});
   assert.equal((await s.assess({capture:c,items,principal:5})).items[0].category,"Unknown");assert.equal(s.calls(),0);
  }
 });

test("corroboration rejects multiple owners, stale/forged captures and duplicate IDs",()=>{
 const c=capture(),v=vision("Item"),packet=gemini(c,"Discarded Instant Noodle Wrapper");
 for(const proposals of [[packet,{...packet}],
   [{...packet,itemId:"region_00000000000000000000000000000000"}],
   [{...packet,captureId:crypto.randomUUID()}],[gemini(capture(),"Discarded Instant Noodle Wrapper")]]){
  const items=merge([v],proposals,samePhysicalObject,c);
  assert.equal(items.find(item=>item.itemId===v.itemId).category,"Unknown");assert.equal(alignedIdentity(items[0],c.captureId),null);
 }
 const ambiguous=merge([v,{...v,itemId:"second_owner"}],[packet,gemini(c,"Discarded Instant Noodle Packet")],samePhysicalObject,c);
 assert.ok(ambiguous.every(item=>item.category==="Unknown"));
 const unknown=merge([v],[gemini(c,"Item")],samePhysicalObject,c);
 assert.equal(unknown.length,1);assert.equal(unknown[0].category,"Unknown");
});

const permutations=items=>items.length<2?[items]:items.flatMap((item,i)=>
 permutations(items.filter((_,j)=>j!==i)).map(rest=>[item,...rest]));
const categoryConflicts=[
 ["Banana Peel","Chemical Container"], ["Banana Peel","Battery"],
 ["Food Scraps","Chemical Container"], ["Food Scraps","Plastic Bottle"],
 ["Plastic Bottle","Chemical Bottle"], ["Plastic Bottle","Contaminated Plastic Bottle"],
 ["Plastic Bottle","Unopened Plastic Bottle"], ["Plastic Bottle","Glass Bottle"],
 ["Can","Chemical Can"], ["Can","Aerosol Can"],
 ["Snack Sachet","Unopened Snack Sachet"],
 ["Discarded Instant Noodle Wrapper","Discarded Instant Noodle Wrapper with Battery"],
 ["Discarded Instant Noodle Wrapper","Filled Instant Noodle Wrapper"],
 ["Battery","Bottle"]
];
for(const labels of categoryConflicts)for(const source of ["gemini","vision"])
 test(`all-category conflict matrix: ${source} ${labels.join(" + ")}`,async()=>{
  const c=capture();
  for(const order of permutations([...labels,"Item"])){
   const v=vision("Item"),g=order.map(label=>gemini(c,label)),original=structuredClone([v,...g]);
   const items=merge(source==="vision"?[v]:[],g,samePhysicalObject,c);
   assert.equal(items.length,1);const owner=items[0],initial=[v,...g].find(item=>item.itemId===owner.itemId);
   assert.equal(owner.category,"Unknown",order.join(" + "));assert.equal(owner.requiresConfirmation,true);
   assert.equal(identityConflict(owner,c.captureId),true);assert.equal(identityConflict(owner,crypto.randomUUID()),false);
   assert.equal(alignedIdentity(owner,c.captureId),null);
   for(const key of ["itemId","boundingBox","analysisSource","observedIdentity","canonicalItem","confidence"])
    assert.deepEqual(owner[key],initial[key],key);
   assert.deepEqual(buildScanSummary(items),{totalItems:1,categories:{biodegradable:0,recyclable:0,residual:0,specialWaste:0}});
   for(const ai of [false,true]){
    const s=service(recycling,{env:{WASTE_ITEM_ASSESSMENT_AI_ENABLED:String(ai)}});
    const sidecar=await s.assess({capture:c,items,principal:5,primary:{category:"Recyclable",itemName:"Plastic Bottle",analysisSource:"cloud_run_gemini_vision",aiConfidence:.99}});
    assert.equal(s.calls(),0);assert.equal(sidecar.aiStatus,"not_requested");
    assert.equal(sidecar.captureId,c.captureId);assert.equal(sidecar.schemaVersion,1);assert.equal(sidecar.items.length,1);
    const row=sidecar.items[0];assert.equal(row.itemId,owner.itemId);assert.equal(row.category,"Unknown");assert.equal(row.requiresConfirmation,true);
    assert.equal(row.assessmentSource,source==="vision"?"existing_category":"insufficient_evidence");
    assert.deepEqual(Object.keys(row).sort(),["assessmentSource","category","confirmationRequirements","guidance","itemId","requiresConfirmation"]);
   }
   assert.deepEqual([v,...g],original);
  }
 });

test("standalone and separate Banana Peel and Battery retain independent categories with neutral observations",async()=>{
 for(const label of ["Banana Peel","Battery","Food Scraps"]){
  const c=capture(),original=gemini(c,label),expected=label==="Battery"?"Special Waste":"Biodegradable";
  for(const proposals of [[original],[original,gemini(c,"Item")],[gemini(c,"Item"),original]]){
   const items=merge([],proposals,samePhysicalObject,c),s=service(insufficient,{env:{WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"}});
   assert.equal(items.length,1);assert.equal(identityConflict(items[0],c.captureId),false);
   assert.equal((await s.assess({capture:c,items,principal:5})).items[0].category,expected);
  }
 }
 const c=capture(),peel=gemini(c,"Banana Peel"),battery=gemini(c,"Battery",{left:.6,top:.1,right:.8,bottom:.5});
 for(const order of [[peel,battery],[battery,peel]]){
  const items=merge([],order,samePhysicalObject,c);assert.equal(items.length,2);ownersPreserved(items,order);
  assert.ok(items.every(item=>!identityConflict(item,c.captureId)));
  const sidecar=await service(insufficient,{env:{WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"}}).assess({capture:c,items,principal:5});
  assert.deepEqual(new Map(sidecar.items.map(item=>[item.itemId,item.category])),new Map([[peel.itemId,"Biodegradable"],[battery.itemId,"Special Waste"]]));
  assert.deepEqual(buildScanSummary(items).categories,{biodegradable:1,recyclable:0,residual:0,specialWaste:1});
 }
});

for(const [label,adverse]of [
 ["Plastic Bottle","Chemical Bottle"],
 ["Plastic Bottle","Contaminated Plastic Bottle"],
 ["Plastic Bottle","Unopened Plastic Bottle"],
 ["Snack Sachet","Unopened Snack Sachet"],
 ["Plastic Bottle","Glass Bottle"]
])test(`known Gemini category cannot bypass current-capture conflict: ${label} + ${adverse}`,async()=>{
 const c=capture();
 for(const order of permutations([label,adverse,"Item"])){
  const proposals=order.map(name=>gemini(c,name));
  const independent=[gemini(c,"Battery",{left:.6,top:.1,right:.7,bottom:.4}),
   gemini(c,"Can",{left:.8,top:.1,right:.9,bottom:.4})];
  const original=structuredClone([...proposals,...independent]);
  const owner=proposals.find(item=>item.observedIdentity===label);
  assert.ok(["Recyclable","Residual"].includes(owner.category));
  const items=merge([],proposals.concat(independent),samePhysicalObject,c);
  assert.equal(items.length,3);
  const result=items.find(item=>item.itemId===owner.itemId);assert.ok(result);
  assert.equal(result.category,"Unknown",order.join(" + "));
  assert.equal(result.requiresConfirmation,true);
  for(const key of ["itemId","boundingBox","analysisSource","observedIdentity","canonicalItem","confidence"])
   assert.deepEqual(result[key],owner[key],key);
  assert.equal(identityConflict(result,c.captureId),true);
  assert.equal(identityConflict(result,crypto.randomUUID()),false);
  assert.equal(alignedIdentity(result,c.captureId),null);
  for(const ai of [false,true]){
   const s=service(recycling,{env:{WASTE_ITEM_ASSESSMENT_AI_ENABLED:String(ai)}});
   const sidecar=await s.assess({capture:c,items,principal:5});
   const row=sidecar.items.find(item=>item.itemId===owner.itemId);
   assert.equal(row.category,"Unknown");assert.equal(row.requiresConfirmation,true);
   assert.equal(sidecar.captureId,c.captureId);assert.equal(sidecar.schemaVersion,1);
   assert.equal(sidecar.items.find(item=>item.itemId===independent[0].itemId).category,"Special Waste");
   assert.equal(sidecar.items.find(item=>item.itemId===independent[1].itemId).category,"Recyclable");
   assert.ok(s.calls()<=(ai?1:0));
   assert.ok(s.requests.every(request=>request.items.every(item=>item.itemId!==owner.itemId)));
   assert.equal(sidecar.items.length,items.length);
   assert.equal(sidecar.aiStatus,s.calls()?"complete":"not_requested");
   const onlyConflict=service(recycling,{env:{WASTE_ITEM_ASSESSMENT_AI_ENABLED:String(ai)}});
   const single=await onlyConflict.assess({capture:c,items:[result],principal:5});
   assert.equal(onlyConflict.calls(),0);assert.equal(single.aiStatus,"not_requested");
   assert.equal(single.items.length,1);assert.equal(single.items[0].itemId,owner.itemId);
   assert.equal(single.items[0].category,"Unknown");assert.equal(single.items[0].requiresConfirmation,true);
   assert.equal(single.items[0].assessmentSource,"insufficient_evidence");
   assert.match(single.items[0].guidance.properDisposal,/Confirm identity, material and condition with WMO/);
  }
  for(const other of independent){
   const retained=items.find(item=>item.itemId===other.itemId);assert.ok(retained);
   for(const key of ["itemId","boundingBox","analysisSource","observedIdentity","canonicalItem","confidence"])
    assert.deepEqual(retained[key],other[key]);
   assert.equal(identityConflict(retained,c.captureId),false);
  }
  assert.deepEqual([...proposals,...independent],original);
 }
});

test("conflicted owners stay out of a cached mixed Gemini/Vision batch without disabling eligible electrical assessment",async()=>{
 const c=capture(),conflict=merge([],['Snack Sachet','Unopened Snack Sachet','Item'].map(name=>gemini(c,name)),samePhysicalObject,c)[0];
 const eligible={...vision("Item",{left:.6,top:.1,right:.8,bottom:.5},"eligible_vision"),captureId:c.captureId};
 const electrical=gemini(c,"Unclassified household object",{left:.81,top:.1,right:.95,bottom:.5});
 const items=[conflict,eligible,electrical],saved=structuredClone(items);
 const facts={category:"Special Waste",kind:"electrical",material:"mixed",condition:"unknown",evidence:"visible"};
 for(const ai of [false,true]){
  const s=service(facts,{env:{WASTE_ITEM_ASSESSMENT_AI_ENABLED:String(ai)}});
  const first=await s.assess({capture:c,items,principal:5});
  const second=await s.assess({capture:{...c,requestId:crypto.randomUUID()},items:[...items].reverse(),principal:5});
  assert.equal(s.calls(),ai?1:0);assert.equal(first.aiStatus,ai?"complete":"not_requested");
  assert.equal(second.aiStatus,first.aiStatus);assert.equal(first.schemaVersion,1);
  assert.equal(first.captureId,c.captureId);assert.deepEqual(first.items.map(item=>item.itemId),items.map(item=>item.itemId));
  const byId=new Map(first.items.map(item=>[item.itemId,item.category]));
  assert.equal(byId.get(conflict.itemId),"Unknown");
  assert.equal(byId.get(eligible.itemId),ai?"Special Waste":"Unknown");
  assert.equal(byId.get(electrical.itemId),ai?"Special Waste":"Unknown");
  assert.deepEqual(new Map(second.items.map(item=>[item.itemId,item.category])),byId);
  if(ai){
   const sent=s.requests[0];assert.equal(sent.captureId,c.captureId);assert.equal(sent.image,c.image);
   const wireId="region_"+crypto.createHash("sha256").update(JSON.stringify(["vision-assessment-v1",c.captureId,eligible.itemId])).digest("hex").slice(0,32);
   assert.deepEqual(new Set(sent.items.map(item=>item.itemId)),new Set([wireId,electrical.itemId]));
   assert.ok(!sent.items.some(item=>item.itemId===conflict.itemId));
   assert.deepEqual(sent.items.find(item=>item.itemId===wireId).boundingBox,eligible.boundingBox);
   assert.equal(sent.items.find(item=>item.itemId===wireId).observedIdentity,eligible.canonicalItem);
   assert.deepEqual(sent.items.find(item=>item.itemId===electrical.itemId).boundingBox,electrical.boundingBox);
  }
 }
 const disabled=service(facts,{env:{WASTE_ITEM_ASSESSMENT_ENABLED:"false"}});
 assert.equal(await disabled.assess({capture:c,items,principal:5}),null);assert.equal(disabled.calls(),0);
 assert.deepEqual(items,saved);assert.equal(identityConflict(conflict,c.captureId),true);
});

test("excluding every conflicted owner preserves duplicate-ID and stale-capture rejection",async()=>{
 const c=capture(),conflict=merge([],['Snack Sachet','Unopened Snack Sachet','Item'].map(name=>gemini(c,name)),samePhysicalObject,c)[0];
 const s=service(recycling),duplicate=await s.assess({capture:c,items:[conflict,conflict],principal:5});
 assert.equal(duplicate.aiStatus,"unavailable");assert.equal(duplicate.items.length,2);
 assert.ok(duplicate.items.every(item=>item.category==="Unknown"));assert.equal(s.calls(),0);
 await assert.rejects(s.assess({capture:{...c,captureId:crypto.randomUUID()},items:[{...conflict,captureId:c.captureId}],principal:5}),
  error=>error.code==="INVALID_RECOGNITION_REQUEST");
 assert.equal(s.calls(),0);
 const malformed={...vision("Item"),boundingBox:{...box,right:NaN}};
 const invalid=await s.assess({capture:c,items:[conflict,malformed],principal:5});
 assert.equal(invalid.items.length,2);assert.ok(invalid.items.every(item=>item.category==="Unknown"));
 assert.equal(s.calls(),0);
});

test("bounded empty-wrapper alias preserves supported Residual guidance in every order",async()=>{
 const c=capture();
 for(const order of permutations(["Snack wrapper","Empty snack wrapper","Item"])){
  const v=vision("Item"),g=order.map(label=>gemini(c,label)),original=structuredClone([v,...g]);
  const items=merge([v],g,samePhysicalObject,c);
  assert.equal(items.length,1);assert.equal(items[0].category,"Residual");
  assert.equal(identityConflict(items[0],c.captureId),false);
  assert.equal(items[0].itemId,v.itemId);assert.deepEqual(items[0].boundingBox,v.boundingBox);
  const s=service(insufficient,{env:{WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"}});
  assert.equal((await s.assess({capture:c,items,principal:5})).items[0].category,"Residual");
  assert.equal(s.calls(),0);assert.deepEqual([v,...g],original);
 }
});
for(const labels of [
 ["Discarded Instant Noodle Wrapper with Battery","Discarded Instant Noodle Wrapper"],
 ["Glass and Steel Food Tin","Steel Food Tin"],
 ["Steel Food Tin with Glass Lid","Steel Food Tin"],
 ["Glass Steel Food Tin","Steel Food Tin"]
])for(const source of ["vision","gemini"])
 test(`unsupported corroboration qualifiers remain unresolved in every order: ${source} ${labels.join(" + ")}`,async()=>{
  const c=capture();
  for(const order of permutations([...labels,"Item"])){
   const v=vision("Item"),g=order.map(label=>gemini(c,label)),original=structuredClone([v,...g]);
   const items=merge(source==="vision"?[v]:[],g,samePhysicalObject,c);
   assert.equal(items.length,1);assert.equal(items[0].category,"Unknown",order.join(" + "));
   ownersPreserved(items,source==="vision"?[v]:g);
   assert.equal(identityConflict(items[0],c.captureId),true);
   assert.equal(alignedIdentity(items[0],c.captureId),null);
   const s=service(insufficient,{env:{WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"}});
   const sidecar=await s.assess({capture:c,items,principal:5});
   assert.equal(sidecar.items[0].category,"Unknown");assert.equal(sidecar.items[0].requiresConfirmation,true);
   assert.equal(sidecar.items[0].itemId,items[0].itemId);assert.equal(sidecar.captureId,c.captureId);
   assert.equal(s.calls(),0);assert.deepEqual([v,...g],original);
  }
 });

test("corroborating descriptions do not absorb adjacent or nested independent objects",()=>{
 const c=capture(),can=normalizeDetectedItems([{name:"Can",confidence:.93,boundingBox:box}],"google_vision_object_localization")[0];
 for(const b of [{left:.15,top:.2,right:.2,bottom:.3},{...box,left:.31,right:.51}]){
  const extra=gemini(c,"Bottle cap",b),items=merge([can],[gemini(c,"Can"),gemini(c,"Item"),extra],samePhysicalObject,c);
  assert.equal(items.length,2);assert.ok(items.some(item=>item.itemId===extra.itemId));
  assert.deepEqual(items.find(item=>item.itemId===extra.itemId).boundingBox,b);
 }
});
for(const source of ["vision","gemini"])for(const label of ["Can","Bottle"])
 for(const neutral of ["Item","Object","Household item","Household object"])
 test(`unique neutral ${neutral} does not veto original ${source} ${label}`,async()=>{
  const c=capture(),owner=source==="vision"
   ?normalizeDetectedItems([{name:label,confidence:.93,boundingBox:box}],"google_vision_object_localization")[0]
   :gemini(c,label),proposal=gemini(c,neutral),before=structuredClone([owner,proposal]);
  const items=merge(source==="vision"?[owner]:[],source==="vision"?[proposal]:[owner,proposal],samePhysicalObject,c);
  assert.equal(items.length,1);assert.equal(items[0].itemId,owner.itemId);
  assert.equal(identityConflict(items[0],c.captureId),false);ownersPreserved(items,[owner]);
  assert.equal(items[0].itemName,owner.itemName);
  const s=service(insufficient,{env:{WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"}}),sidecar=await s.assess({capture:c,items,principal:5});
  assert.equal(sidecar.items[0].category,"Recyclable");assert.equal(sidecar.items[0].itemId,owner.itemId);
  assert.equal(sidecar.items[0].assessmentSource,source==="vision"?"existing_category":"reviewed_identity_rule");
  assert.equal(sidecar.items[0].requiresConfirmation,true);assert.equal(sidecar.captureId,c.captureId);
  assert.equal(s.calls(),0);assert.deepEqual([owner,proposal],before);
 });

test("neutral evidence never erases competing hazardous or unopened observations",async()=>{
 for(const label of ["Chemical Can","Paint Can","Aerosol Can","Unopened Can","Can with unknown contents"]){
  const c=capture(),owner=normalizeDetectedItems([{name:"Can",confidence:.93,boundingBox:box}],"google_vision_object_localization")[0];
  for(const proposals of [[gemini(c,label),gemini(c,"Item")],[gemini(c,"Item"),gemini(c,label)]]){
   const items=merge([owner],proposals,samePhysicalObject,c);
   assert.equal(items.length,1);assert.equal(items[0].itemId,owner.itemId);assert.deepEqual(items[0].boundingBox,box);
   assert.equal(items[0].category,"Unknown",label);assert.equal(identityConflict(items[0],c.captureId),true,label);
   const s=service(insufficient,{env:{WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"}});
   assert.equal((await s.assess({capture:c,items,principal:5})).items[0].category,"Unknown");assert.equal(s.calls(),0);
  }
 }
});

test("neutral observations do not change an established Special Waste owner",async()=>{
 for(const label of ["Paint Can","Aerosol Can","Battery","Charger"]){
  const c=capture(),owner=normalizeDetectedItems([{name:label,confidence:.93,boundingBox:box}],"google_vision_object_localization")[0];
  assert.equal(owner.category,"Special Waste");
  const items=merge([owner],[gemini(c,"Item")],samePhysicalObject,c);
  assert.equal(items.length,1);ownersPreserved(items,[owner]);
  const s=service(insufficient,{env:{WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"}});
  assert.equal((await s.assess({capture:c,items,principal:5})).items[0].category,"Special Waste");
 }
});

test("neutral exception needs tight geometry and unique correspondence",()=>{
 const c=capture(),owners=normalizeDetectedItems([{name:"Can",confidence:.93,boundingBox:box}],"google_vision_object_localization");
 // A competing same-region observation disables the neutral exception.
 const competing={...owners[0],itemId:"other_owner"};
 const ambiguous=merge([owners[0],competing],[gemini(c,"Item")],samePhysicalObject,c);
 assert.equal(ambiguous[0].category,"Unknown");
 // Partial overlap and actual nested objects must remain separate.
 for(const b of [{...box,left:.2,right:.4},{left:.15,top:.2,right:.2,bottom:.3}]){
  const items=merge(owners,[gemini(c,"Item",b)],samePhysicalObject,c);
  assert.equal(items.length,2);assert.equal(items[0].category,"Recyclable");
 }
 const unknown=merge([],[gemini(c,"Item")],samePhysicalObject,c);
 assert.equal(unknown.length,1);assert.equal(unknown[0].category,"Unknown");
});

test("neutral Can observation preserves independent Can wrapper Bottle category ownership",async()=>{
 const c=capture(),names=["Can","Discarded instant noodle wrapper","Bottle"],
  boxes=[box,{...box,left:.4,right:.6},{...box,left:.7,right:.9}],
  owners=normalizeDetectedItems(names.map((name,i)=>({name,confidence:.93,boundingBox:boxes[i]})),"google_vision_object_localization");
 const items=merge(owners,[gemini(c,"Item")],samePhysicalObject,c);
 ownersPreserved(items,owners);assert.equal(items.length,3);assert.equal(new Set(items.map(i=>i.itemId)).size,3);
 const s=service(insufficient,{env:{WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"}}),sidecar=await s.assess({capture:c,items,principal:5});
 assert.deepEqual(sidecar.items.map(i=>i.category),["Recyclable","Residual","Recyclable"]);
 assert.deepEqual(sidecar.items.map(i=>i.itemId),owners.map(i=>i.itemId));assert.equal(s.calls(),0);
});
for(const label of ["Container","Sunscreen container"])test(`unique neutral alias suppresses only the duplicate: ${label}`,async()=>{
 const c=capture(),v=vision(label),g=gemini(c,"Item",drift),before=structuredClone([v,g]);
 for(const [initial,proposals]of [[[v],[g]],[[g],[v]]]){
  const items=merge(initial,proposals,samePhysicalObject,c);assert.equal(items.length,1);
  assert.equal(items[0].itemId,initial[0].itemId);ownersPreserved(items,before);
  const s=service(recycling),sidecar=await s.assess({capture:c,items,principal:5});
  assert.equal(sidecar.items.length,1);assert.equal(sidecar.items[0].itemId,items[0].itemId);
  // Only the retained ordinary Container owner supports the common-object rule.
  // A retained Gemini Item does not inherit the discarded observation's category.
  assert.equal(sidecar.items[0].category,label==="Container" && initial[0].analysisSource==="google_vision_object_localization"?"Recyclable":"Unknown");
  if(label==="Sunscreen container"){
   assert.equal(identityConflict(items[0],c.captureId),true);
   assert.equal(s.calls(),0);assert.equal(sidecar.aiStatus,"not_requested");
  }else assert.equal(s.calls(),1);
 }
 assert.deepEqual([v,g],before);
});
test("duplicate Gemini generic aliases keep one original owner; ambiguous partners remain independent",()=>{
 const c=capture(),a=gemini(c,"Container"),b=gemini(c,"Item",drift);
 assert.equal(merge([],[a,b],samePhysicalObject,c).length,1);
 const other=gemini(c,"Container",{...box,left:.112,right:.312,top:.124,bottom:.524});
 assert.equal(merge([a,other],[b],samePhysicalObject,c).length,3);
});
test("near-equal contained generic extents deduplicate but a smaller genuine nested object survives",()=>{
 const c=capture(),v=vision("Item");
 assert.equal(merge([v],[gemini(c,"Container",{left:.101,top:.102,right:.299,bottom:.498})],samePhysicalObject,c).length,1);
 for(const [label,b]of [["Container",{left:.12,top:.12,right:.28,bottom:.48}],["Bottle cap",{left:.15,top:.12,right:.2,bottom:.17}],["Pen",{left:.15,top:.2,right:.17,bottom:.4}]])
  assert.equal(merge([v],[gemini(c,label,b)],samePhysicalObject,c).length,2,label);
});
test("adjacency, partial overlap, different identities and accessories never collapse to reach a target count",()=>{
 const c=capture();
 for(const [label,b]of [["Container",{...box,left:.31,right:.51}],["Container",{...box,left:.2,right:.4}],["Snack wrapper",drift],["Bottle cap",drift],["Soap",drift]])
  assert.equal(merge([vision("Container")],[gemini(c,label,b)],samePhysicalObject,c).length,2,label);
 const bottles=[vision("Bottle"),vision("Bottle",{...box,left:.31,right:.51},"item_2")];
 assert.equal(merge(bottles,[],samePhysicalObject,c).length,2);
});
test("identical hazardous contradiction does not transfer a safe category",async()=>{
 const c=capture(),items=merge([vision("Bottle")],[gemini(c,"Chemical bottle")],samePhysicalObject,c);
 assert.equal(items.length,1);assert.equal(identityConflict(items[0],c.captureId),true);
 const s=service(recycling),result=await s.assess({capture:c,items,principal:5});
 assert.equal(result.items[0].category,"Unknown");assert.equal(result.items[0].itemId,"item_1");
});
test("stale captures, forged ownership, source conflicts and malformed boxes cannot reconcile",()=>{
 const c=capture(),v=vision("Item");
 for(const g of [gemini(capture(),"Container"),{...gemini(c,"Container"),captureId:crypto.randomUUID()},
  {...gemini(c,"Container"),itemId:"region_00000000000000000000000000000000"},
  {...gemini(c,"Container"),analysisSource:"untrusted"},
  {...gemini(c,"Container"),boundingBox:{...box,left:-.1}},
  {...gemini(c,"Container"),boundingBox:{...box,right:NaN}}])
  assert.equal(merge([v],[g],samePhysicalObject,c).length,2);
});
test("specific same-object identity maps directly; unlisted identity reaches AI without compact-label evidence",async()=>{
 for(const [label,category,display,calls]of [["Instant noodle packet","Residual","Instant Noodle Packet",0],["Paper envelope","Recyclable","Paper Envelope",0],["Ceramic spoon","Unknown","Spoon",1]]){
 const c=capture(),v=vision("Item"),g=gemini(c,label),items=merge([v],[g],samePhysicalObject,c);
 assert.equal(items.length,1);assert.equal(items[0].itemId,v.itemId);assert.equal(items[0].canonicalItem,"item");
 const s=service(insufficient),sidecar=await s.assess({capture:c,items,principal:5});
 if(calls)assert.equal(s.requests[0].items[0].observedIdentity,label);
 assert.equal(sidecar.items[0].category,category);assert.equal(sidecar.items[0].assessmentSource,calls?"ai_assisted":"existing_category");
 if(category==="Unknown")assert.doesNotMatch(JSON.stringify(sidecar.items[0].guidance),/residual.bin|recycling.bin|landfill/i);
 const response=withDisplayNames({detectedItems:items,categoryAssessments:sidecar});
 assert.equal(response.detectedItems[0].itemName,display);assert.equal(items[0].itemName,label);
 assert.equal(response.detectedItems[0].originalItemName,label);
 assert.deepEqual(response.detectedItems[0].boundingBox,v.boundingBox);assert.equal(s.calls(),calls);
 }
});
for(const [label,expected]of [["Snack wrapper","Residual"],["Instant noodle packet","Residual"],["Plastic beverage bottle","Unknown"],["Empty snack wrapper","Residual"],["Empty plastic water bottle","Recyclable"],["Banana peel","Biodegradable"],["White charger","Special Waste"],["Sunscreen container","Unknown"],["Container","Recyclable"],["Item","Unknown"]])
 test(`final automatic assessment remains item-owned: ${label}`,async()=>{
  const c=capture(),items=merge([],[gemini(c,label)],samePhysicalObject,c),s=service(insufficient);
  const sidecar=await s.assess({capture:c,items,principal:5});
  assert.equal(sidecar.items[0].category,expected);assert.equal(sidecar.items[0].itemId,items[0].itemId);
  assert.equal(sidecar.captureId,c.captureId);assert.equal(sidecar.schemaVersion,1);assert.equal(sidecar.items[0].requiresConfirmation,true);
 });
for(const label of ["Picture of instant noodle packet","Possibly an instant noodle packet","Instant noodle packet with chemical contents","Instant noodle packet bottle","Instant noodle packet toy"])
 test(`no phrase-based category expansion for unsafe or unrelated identity: ${label}`,async()=>{
  const c=capture(),items=[gemini(c,label)],s=service(insufficient);
  const result=await s.assess({capture:c,items,principal:5});assert.equal(result.items[0].category,"Unknown");
 });
test("four objects with two duplicate generic observations yield four independent v7 sidecar owners",async()=>{
 const c=capture(),boxes=[box,{...box,left:.6,right:.8},{left:.1,top:.6,right:.3,bottom:.9},{left:.6,top:.6,right:.8,bottom:.9}];
 const v=[vision("Item"),vision("Container",boxes[1],"item_2")];
 const g=[gemini(c,"Instant noodle packet"),gemini(c,"Sunscreen container",boxes[1]),gemini(c,"Banana peel",boxes[2]),gemini(c,"White charger",boxes[3])];
 const items=merge(v,g,samePhysicalObject,c),saved=structuredClone(items),s=service(insufficient);
 const primary={success:false,itemName:"Unclassified primary",category:"Unknown"};
 const sidecar=await s.assess({capture:c,items,primary,principal:5}),response=withDisplayNames({...primary,detectedItems:items,categoryAssessments:sidecar});
 assert.equal(items.length,4);assert.equal(buildScanSummary(items).totalItems,4);assert.equal(new Set(items.map(i=>i.itemId)).size,4);
 assert.deepEqual(sidecar.items.map(i=>i.category),["Residual","Unknown","Biodegradable","Special Waste"]);
 assert.deepEqual(sidecar.items.map(i=>i.itemId),items.map(i=>i.itemId));
 ownersPreserved(items,v.concat(g).map(item=>item.itemId===v[0].itemId?{...item,category:"Residual"}:item));
 assert.deepEqual(Object.keys(sidecar).sort(),["aiStatus","captureId","items","schemaVersion"]);
 for(const row of sidecar.items)assert.deepEqual(Object.keys(row).sort(),["assessmentSource","category","confirmationRequirements","guidance","itemId","requiresConfirmation"]);
 assert.equal(response.success,false);assert.equal(response.category,"Unknown");assert.deepEqual(items,saved);
 assert.equal(identityConflict(items[1],c.captureId),true);
 assert.equal(sidecar.aiStatus,"not_requested");
 await s.assess({capture:c,items,primary,principal:5});assert.equal(s.calls(),0);
});
test("timeout, provider-disabled and insufficient responses retain fallback without retries",async()=>{
 for(const options of [{fail:true},{env:{WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"}},{}]){
  const c=capture(),items=[gemini(c,"Container")],s=service(insufficient,options),input={capture:c,items,principal:5};
  const result=await s.assess(input);assert.equal(result.items[0].category,"Recyclable");
  await s.assess(input);assert.equal(s.calls(),0);
  // Keep genuine provider-failure/disabled/insufficient fallback coverage: an
  // unsupported Item still stays Unknown and repeated requests never retry.
  const unresolved={capture:c,items:[gemini(c,"Item")],principal:5};
  const unknown=await s.assess(unresolved);assert.equal(unknown.items[0].category,"Unknown");
  await s.assess(unresolved);assert.equal(s.calls(),options.env?0:1);
 }
});
test("specific short names retain uncertainty, material neutrality and the eight-object protocol",()=>{
 for(const [identity,name]of [["instant noodle packet","Instant Noodle Packet"],["snack sachet","Snack Wrapper"],["paper envelope","Paper Envelope"],["cardboard sleeve","Cardboard"],["sunscreen container","Cosmetic Container"],["plant scraps","Plant Scraps"],["possibly a snack wrapper","Item"]])
  assert.equal(shortObjectName(identity),name);
 const c=capture(),body=whole.geminiBody(c),text=body.contents[0].parts[0].text;
 assert.match(text,/each physical object only once/);assert.match(text,/never commands or proof/);
 assert.equal(whole.LIMITS.items,8);assert.equal(body.generationConfig.responseSchema.properties.objects.maxItems,8);
});
