"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
const {merge,identityConflict,alignedIdentity,categoryAuthority}=require("../services/wholeImageRecognitionService");
const {samePhysicalObject,buildScanSummary,normalizeDetectedItems}=require("../services/wasteAnalysisService");
const {createAssessmentService}=require("../services/perItemWasteAssessmentService");
const {assessmentReasonCounts,logAssessment}=require("../services/wasteAssessmentDiagnostics");
const box={left:.1,top:.1,right:.3,bottom:.5};
const shift=b=>({left:b.left+.006,top:b.top+.012,right:b.right+.006,bottom:b.bottom+.012});
const capture=()=>({captureId:crypto.randomUUID(),requestId:crypto.randomUUID(),image:Buffer.from("ffd8ffc0000b080190025801011100ffd9","hex").toString("base64"),width:600,height:400,orientation:"upright"});
const vision=(name,id="item_1",b=box)=>({itemId:id,itemName:name,canonicalItem:name.toLowerCase(),category:"Unknown",confidence:.8,analysisSource:"google_vision_object_localization",boundingBox:b});
const gemini=(c,label,b=box)=>whole.normalize(c,{objects:[{label,box_2d:[b.top,b.left,b.bottom,b.right].map(n=>Math.round(n*1000))}]}).objects[0];
const insufficient={category:"Unknown",kind:"unknown",material:"unknown",condition:"unknown",evidence:"insufficient"};
const recyclable={category:"Recyclable",kind:"single_material",material:"pet_plastic",condition:"clean_dry",evidence:"visible"};
function service(facts=()=>insufficient,extra={}) {
 let calls=0;
 const assess=createAssessmentService({env:{WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"true",CLOUD_RUN_AUTH_MODE:"iam",
  CLOUD_RUN_AUDIENCE:"https://synthetic.invalid",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste",
  WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"offline-only-token-longer-than-thirty-two-characters",...extra},authHeaders:async()=>({}),transport:async(url,input)=>{
   calls++;return {schemaVersion:1,requestId:input.requestId,captureId:input.captureId,assessments:input.items.map(i=>({itemId:i.itemId,...facts(i)}))};
  }});
 return {assess,calls:()=>calls};
}
test("synthetic two Vision plus four Gemini observations resolve to four, preserving original owners",async()=>{
 // Controlled synthetic geometry, NOT recovered from a production photo.
 const c=capture(),green={left:.5,top:.1,right:.7,bottom:.5};
 const v=[vision("Container"),vision("Green container","item_2",green)];
 const g=[gemini(c,"Clear bottle",shift(box)),gemini(c,"Green jar",shift(green)),
  gemini(c,"White charger",{left:.1,top:.6,right:.3,bottom:.9}),gemini(c,"Red snack wrapper",{left:.5,top:.6,right:.7,bottom:.9})];
 const before=structuredClone({v,g});
 for(const [initial,proposals] of [[v,g],[[...v].reverse(),[...g].reverse()],[g,v]]) {
  const items=merge(initial,proposals,samePhysicalObject,c);
  assert.equal(items.length,4);assert.equal(buildScanSummary(items).totalItems,4);
  assert.equal(new Set(items.map(i=>i.itemId)).size,4);
  for(const item of items) {
   const owner=initial.concat(proposals).find(i=>i.itemId===item.itemId);
   for(const key of ["itemId","boundingBox","category","canonicalItem","observedIdentity","analysisSource","confidence","captureId"])
    assert.deepEqual(item[key],owner[key]);
  }
  const s=service(),result=await s.assess({capture:c,items,principal:5});
  assert.equal(result.items.length,4);assert.equal(s.calls(),1);assert.equal(result.captureId,c.captureId);
  assert.deepEqual(result.items.map(i=>i.itemId),items.map(i=>i.itemId));assert.ok(result.items.every(i=>i.requiresConfirmation));
 }
 assert.deepEqual({v,g},before);
});
test("same-provider near aliases merge only with one unambiguous partner",()=>{
 const c=capture(),a=gemini(c,"Container"),b=gemini(c,"Clear bottle",shift(box));
 for(const proposals of [[a,b],[b,a]])assert.equal(merge([],proposals,samePhysicalObject,c).length,1);
 const right=gemini(c,"Bottle",{...box,left:.4,right:.6});
 assert.equal(merge([],[b,right],samePhysicalObject,c).length,2);
 const left=gemini(c,"Bottle",{...box,left:.088,right:.288}),middle=gemini(c,"Container",{...box,left:.094,right:.294,top:.112,bottom:.512});
 assert.equal(merge([a,left],[middle],samePhysicalObject,c).length,3);
});
test("near aliases never absorb nested objects, accessories, partial overlap, unsafe identities or foreign captures",()=>{
 const c=capture(),a=vision("Container");
 for(const b of [gemini(c,"Bottle",{left:.12,top:.12,right:.28,bottom:.48}),
  gemini(c,"Bottle",{...box,left:.15,right:.35}),gemini(c,"Bottle cap",shift(box)),
  gemini(c,"Snack wrapper",shift(box)),gemini(c,"Spray bottle",shift(box)),gemini(c,"Printed bottle picture",shift(box)),
  gemini(c,"Chemical bottle",shift(box)),gemini(c,"Bottle",{...box,left:.4,right:.6}),
  gemini(capture(),"Bottle",shift(box))])assert.equal(merge([a],[b],samePhysicalObject,c).length,2,b.observedIdentity);
 const known={...a,category:"Special Waste"},proposal=gemini(c,"Bottle",shift(box)),before=structuredClone(known);
 const owners=merge([known],[proposal],samePhysicalObject,c);
 assert.equal(owners.length,2); // Category correction must not enable nearAlias.
 assert.equal(owners[0].category,"Unknown");assert.equal(owners[0].itemName,known.itemName);
 assert.equal(categoryAuthority(owners[0],c.captureId),"invalid");
 assert.deepEqual(owners.map(item=>[item.itemId,item.boundingBox,item.analysisSource]),
  [known,proposal].map(item=>[item.itemId,item.boundingBox,item.analysisSource]));
 assert.equal(merge(owners,[],samePhysicalObject,c).length,2);
 assert.deepEqual(known,before);
});
test("same-provider conflicting identities veto classification even with AI disabled or valid provider recycling facts",async()=>{
 for(const enabled of ["true","false"])for(const labels of [["Bottle","Soap"],["Soap","Bottle"]]) {
  const c=capture(),g=labels.map(label=>gemini(c,label)),items=merge([],g,samePhysicalObject,c);
  assert.equal(items.length,1);assert.equal(identityConflict(items[0],c.captureId),true);
  const s=service(()=>recyclable,{WASTE_ITEM_ASSESSMENT_AI_ENABLED:enabled});
  const result=await s.assess({capture:c,items,principal:5});assert.equal(result.items[0].category,"Unknown");
  assert.equal(s.calls(),Number(enabled==="true"));assert.equal(result.items[0].itemId,items[0].itemId);
 }
 for(const labels of [["Bottle","Spray bottle"],["Spray bottle","Bottle"]]) {
  const c=capture(),v=labels.map((label,i)=>vision(label,`item_${i+1}`)),items=merge(v,[],samePhysicalObject,c);
  assert.equal(items.length,1);assert.equal(identityConflict(items[0],c.captureId),true);
  const s=service(()=>recyclable),r=await s.assess({capture:c,items,principal:5});
  assert.equal(r.items[0].category,"Unknown");assert.equal(r.items[0].itemId,items[0].itemId);
 }
});
test("primary corroboration cannot establish discarded state and remains separate from nozzle evidence",async()=>{
 const primary={analysisSource:"cloud_run_gemini_vision",category:"Recyclable",aiLabel:"Plastic water bottle",aiConfidence:.95};
 for(const [label,expected,calls] of [["Water bottle with cap","Unknown",0],["Spray bottle with nozzle","Unknown",1],["Bottle with unknown contents","Unknown",1]]) {
  const s=service(),c=capture(),items=[vision(label)],before=structuredClone({primary,items});
  const result=await s.assess({capture:c,items,primary,principal:5});
  assert.equal(result.items[0].category,expected);assert.equal(s.calls(),calls);assert.deepEqual({primary,items},before);
 }
 const s=service(),result=await s.assess({capture:capture(),items:[vision("Spray bottle with nozzle")],primary,principal:5});
 const reasons=assessmentReasonCounts(result);assert.equal(reasons.veto_observed_identity,1);assert.equal(reasons.veto_primary_hazard,0);
 assert.equal(reasons.veto_provider_evidence,0);
});
test("validated structured evidence reconciles independently and precise counters never log private data",async()=>{
 const c=capture(),items=[vision("Water bottle with cap"),vision("Snack wrapper","item_2",{...box,left:.5,right:.7}),vision("White charger","item_3",{...box,top:.6,bottom:.9})];
 const s=service(i=>i.observedIdentity.includes("water")?recyclable:insufficient);
 const result=await s.assess({capture:c,items,principal:5});
 assert.deepEqual(result.items.map(i=>i.category),["Unknown","Unknown","Special Waste"]);assert.equal(s.calls(),1);
 const logs=[];logAssessment(result,3,{info:line=>logs.push(line)},items);
 assert.doesNotMatch(logs.join(""),/item_1|water bottle|Snack wrapper|White charger|captureId|Bearer|boundingBox/);
 assert.deepEqual(Object.keys(result).sort(),["schemaVersion","captureId","aiStatus","items"].sort());
 const denied=service(()=>({...insufficient,material:"mixed",evidence:"visible"}));
 const r=await denied.assess({capture:capture(),items:[vision("Water bottle with cap")],principal:5});
 assert.equal(r.items[0].category,"Unknown");assert.equal(assessmentReasonCounts(r).veto_provider_evidence,0);assert.equal(denied.calls(),0);
 // A separate explicitly empty owner remains eligible and exercises the actual provider veto.
 const eligible=service(()=>({...insufficient,material:"mixed",evidence:"visible"}));
 const vetoed=await eligible.assess({capture:capture(),items:[vision("Empty plastic water bottle")],principal:5});
 assert.equal(vetoed.items[0].category,"Unknown");assert.equal(eligible.calls(),1);
 assert.equal(assessmentReasonCounts(vetoed).veto_provider_evidence,1);
});

test("active primary hazard is distinct from observational safety counts on an unrelated scene primary",async()=>{
 const primary={analysisSource:"cloud_run_gemini_vision",category:"Special Waste",aiLabel:"Chemical bottle",aiConfidence:.95};
 const s=service(),r=await s.assess({capture:capture(),items:[vision("Water bottle with cap")],primary,principal:5});
 assert.equal(r.items[0].category,"Unknown");
 assert.equal(assessmentReasonCounts(r).veto_primary_hazard,0);assert.equal(assessmentReasonCounts(r).veto_observed_identity,0);assert.equal(s.calls(),0);
 const eligible=service(),hazard=await eligible.assess({capture:capture(),items:[vision("Bottle")],primary,principal:5});
 assert.equal(hazard.items[0].category,"Unknown");assert.equal(eligible.calls(),1);
 assert.equal(assessmentReasonCounts(hazard).veto_primary_hazard,1);
 const unrelated=service(()=>({...insufficient,material:"mixed",evidence:"visible"}));
 const result=await unrelated.assess({capture:capture(),items:[vision("Opaque tub"),vision("Item","item_2")],
  primary:{...primary,category:"Recyclable",aiLabel:"Plastic bottle"},principal:5});
 const reasons=assessmentReasonCounts(result);assert.equal(reasons.safety_veto,2);
 for(const code of ["veto_observed_identity","veto_primary_hazard","veto_provider_evidence"])assert.equal(reasons[code],0);
});

// Fixed synthetic captures; never historical labels, coordinates or responses.
function phase2ACapture(foreign=false) {
 return {captureId:foreign?"33333333-3333-4333-8333-333333333333":"22222222-2222-4222-8222-222222222222",
  requestId:"11111111-1111-4111-8111-111111111111",
  image:Buffer.from("ffd8ffc0000b080190025801011100ffd9","hex").toString("base64"),
  width:600,height:400,orientation:"upright"};
}

test("Phase 2A: correspondence outcomes survive assessment with trace parity and no extra requests",async t=>{
 const c=phase2ACapture(),primary={itemName:"Synthetic scene",category:"Recyclable",
  analysisSource:"cloud_run_gemini_vision",aiLabel:"Synthetic scene",aiConfidence:.95};
 // These extend the geometric matrix through real assessment, including an
 // actual insufficient-evidence batch for a specific but uncategorized owner.
 const cases=[
  {label:"Instant Noodle Packet",category:"Residual",aligned:"Instant Noodle Packet",calls:0},
  {label:"Wooden spoon",category:"Unknown",aligned:"Wooden spoon",calls:1},
  {label:"Unopened Instant Noodle Packet",category:"Unknown",aligned:"Unopened Instant Noodle Packet",calls:1},
  {label:"Chemical bottle",category:"Unknown",aligned:null,conflict:true,calls:0}
 ];
 for(const scenario of cases) {
  const v={...vision("Item"),observedIdentity:"Item",originalItemName:"Item",captureId:c.captureId};
  const proposals=whole.validateResponse(c,whole.normalize(c,{objects:[{label:scenario.label,box_2d:[100,100,500,300]}]})).objects;
  const before=structuredClone({v,proposals,primary}),runs=[];
  let matcherCalls=0;
  for(const traced of [false,true]) {
   const observations=[];
   const matcher=traced?(a,b)=>{const accepted=samePhysicalObject(a,b);observations.push(accepted);return accepted;}:samePhysicalObject;
   const items=merge([v],proposals,matcher,c);
   assert.equal(items.length,1);assert.equal(buildScanSummary(items).totalItems,1);
   const owner=items[0];
   for(const key of ["itemId","boundingBox","analysisSource","confidence","captureId","canonicalItem","observedIdentity","originalItemName"])
    assert.deepEqual(owner[key],v[key],key);
   assert.equal(owner.category,scenario.category);
   assert.equal(alignedIdentity(owner,c.captureId),scenario.aligned);
   assert.equal(identityConflict(owner,c.captureId),!!scenario.conflict);
   const s=service(),result=await s.assess({capture:c,items,primary,principal:5});
   assert.equal(result.items.length,1);assert.equal(result.items[0].itemId,v.itemId);
   assert.equal(result.items[0].category,scenario.category);assert.equal(result.items[0].requiresConfirmation,true);
   assert.equal(result.captureId,c.captureId);assert.equal(s.calls(),scenario.calls);
   const retry=await s.assess({capture:{...c,requestId:"44444444-4444-4444-8444-444444444444"},items,primary,principal:5});
   assert.deepEqual(retry,result);assert.equal(s.calls(),scenario.calls);
   runs.push({items,result,calls:s.calls(),aligned:alignedIdentity(owner,c.captureId),conflict:identityConflict(owner,c.captureId)});
   if(traced){assert.ok(observations.length>0);assert.ok(observations.every(v=>typeof v==="boolean"));matcherCalls+=observations.length;}
   assert.deepEqual({v,proposals,primary},before);
  }
  assert.deepEqual(runs[1],runs[0]);
  t.diagnostic("synthetic assessment mergeCalls=2, tracedMatcherCalls="+matcherCalls+", stubRequestsPerRun="+scenario.calls);
 }
});

test("Phase 2A M characterization: an unbound Vision owner retains a derived category under a stale capture",async()=>{
 const c=phase2ACapture(),other=phase2ACapture(true);
 const initial=normalizeDetectedItems([{name:"Item",score:.8,boundingBox:box}],"google_vision_object_localization");
 const original=structuredClone(initial[0]);
 assert.equal(original.category,"Unknown");assert.equal(original.captureId,undefined);
 const proposal=gemini(c,"White charger"),items=merge(initial,[proposal],samePhysicalObject,c),owner=items[0];
 assert.equal(items.length,1);assert.equal(owner.category,"Special Waste");
 for(const key of ["itemId","boundingBox","analysisSource","confidence","canonicalItem","captureId"])
  assert.deepEqual(owner[key],original[key]);
 assert.equal(alignedIdentity(owner,c.captureId),"White charger");
 assert.equal(alignedIdentity(owner,other.captureId),null);
 assert.equal(identityConflict(owner,other.captureId),false);
 const before=structuredClone(items),current=service(),stale=service();
 const fresh=await current.assess({capture:c,items,principal:5});
 const replay=await stale.assess({capture:other,items,principal:5});
 assert.equal(fresh.items[0].category,"Special Waste");
 // Phase 2A.1 converts the observed defect into the required fail-closed
 // regression, retaining the original same-capture and zero-request controls.
 assert.equal(replay.items[0].category,"Unknown");
 assert.equal(replay.items[0].itemId,original.itemId);
 assert.equal(replay.captureId,other.captureId);
 assert.equal(current.calls(),0);assert.equal(stale.calls(),0);
 // Controls: a fresh generic owner under the new capture remains Unknown,
 // and an explicitly capture-bound stale owner is rejected before inference.
 const control=service(()=>insufficient,{WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"});
 const neutral=await control.assess({capture:other,items:[original],principal:5});
 assert.equal(neutral.items[0].category,"Unknown");assert.equal(control.calls(),0);
 const bound=service();
 await assert.rejects(bound.assess({capture:other,items:[{...owner,captureId:c.captureId}],principal:5}),
  error=>error.code==="INVALID_RECOGNITION_REQUEST");
 assert.equal(bound.calls(),0);assert.deepEqual(items,before);assert.deepEqual(initial,[original]);
});

function phase2ADerivedOwner(c) {
 const initial=normalizeDetectedItems([{name:"Item",score:.8,boundingBox:{...box}}],"google_vision_object_localization");
 return merge(initial,[gemini(c,"White charger")],samePhysicalObject,c)[0];
}

test("Phase 2A.1: only validated merge copies preserve current correspondence authority",async()=>{
 const c=phase2ACapture(),other=phase2ACapture(true),owner=phase2ADerivedOwner(c);
 const before=structuredClone(owner);
 assert.equal(categoryAuthority(owner,c.captureId),"correspondence");
 const current=merge([owner],[],samePhysicalObject,c);
 assert.notEqual(current[0],owner);assert.equal(current[0].category,"Special Waste");
 assert.equal(alignedIdentity(current[0],c.captureId),"White charger");
 assert.equal(categoryAuthority(current[0],c.captureId),"correspondence");
 for(const copy of [item=>item,item=>({...item}),item=>structuredClone(item),item=>JSON.parse(JSON.stringify(item))]) {
  for(const target of [c,other]) {
   const item=copy(owner),saved=structuredClone(item),s=service();
   const authorized=item===owner&&target===c;
   assert.equal(categoryAuthority(item,target.captureId),authorized?"correspondence":"invalid");
   const result=await s.assess({capture:target,items:[item],principal:5});
   assert.equal(result.items[0].category,authorized?"Special Waste":"Unknown");assert.equal(s.calls(),0);
   const merged=merge([item],[],samePhysicalObject,target);
   assert.equal(merged.length,1);assert.equal(merged[0].category,authorized?"Special Waste":"Unknown");
   for(const key of ["itemId","boundingBox","analysisSource","canonicalItem","captureId","confidence"])
    assert.deepEqual(merged[0][key],item[key]);
   const final=await s.assess({capture:target,items:merged,principal:5});
   assert.equal(final.items[0].category,merged[0].category);assert.equal(s.calls(),0);
   assert.deepEqual(item,saved);
  }
 }
 assert.deepEqual(owner,before);
});

test("Phase 2A.1: changed authority snapshots fail closed while display-only changes grant nothing",async()=>{
 const c=phase2ACapture();
 const mutations=[
  item=>{item.itemId="item_changed";},
  item=>{item.observedIdentity="Charger";},
  item=>{item.originalItemName="Charger";},
  item=>{item.canonicalItem="charger";},
  item=>{item.category="Recyclable";},
  item=>{item.category="Unknown";},
  item=>{item.boundingBox={...box,right:.31};},
  item=>{item.analysisSource="separate_classifier";}
 ];
 for(const mutate of mutations) {
  const item=phase2ADerivedOwner(c);mutate(item);
  const before=structuredClone(item),s=service();
  assert.equal(alignedIdentity(item,c.captureId),null);
  assert.equal(categoryAuthority(item,c.captureId),"invalid");
  const result=await s.assess({capture:c,items:[item],principal:5});
  assert.equal(result.items[0].category,"Unknown");assert.equal(s.calls(),0);
  const owners=merge([item],[],samePhysicalObject,c);
  assert.equal(owners.length,1);assert.equal(owners[0].category,"Unknown");
  assert.equal((await s.assess({capture:c,items:owners,principal:5})).items[0].category,"Unknown");
  assert.equal(s.calls(),0);assert.deepEqual(item,before);
 }
 const display=phase2ADerivedOwner(c);display.itemName="Cardboard";
 assert.equal(categoryAuthority(display,c.captureId),"correspondence");
 assert.equal(alignedIdentity(display,c.captureId),"White charger");
 const s=service(),result=await s.assess({capture:c,items:[display],principal:5});
 assert.equal(result.items[0].category,"Special Waste");assert.equal(s.calls(),0);
 const copied={...display},denied=service();
 assert.equal((await denied.assess({capture:c,items:[copied],principal:5})).items[0].category,"Unknown");
 assert.equal(denied.calls(),0);
 const foreign=phase2ADerivedOwner(c);foreign.captureId=phase2ACapture(true).captureId;
 const blocked=service();
 await assert.rejects(blocked.assess({capture:c,items:[foreign],principal:5}),e=>e.code==="INVALID_RECOGNITION_REQUEST");
 assert.equal(blocked.calls(),0);
});

test("Phase 2A.1: copied independent four-category originals remain valid without private correspondence",async()=>{
 const c=phase2ACapture();
 for(const [name,category] of [["Charger","Special Waste"],["Cardboard","Recyclable"],
  ["Banana Peel","Biodegradable"],["Snack Sachet","Residual"]]) {
  const original=normalizeDetectedItems([{name,score:.8,boundingBox:box}],"google_vision_object_localization")[0];
  assert.equal(original.category,category);
  for(const copy of [item=>item,item=>({...item}),item=>structuredClone(item),item=>JSON.parse(JSON.stringify(item))]) {
   const item=copy(original),before=structuredClone(item),s=service();
   assert.equal(categoryAuthority(item,c.captureId),"independent");
   const result=await s.assess({capture:c,items:[item],principal:5});
   assert.equal(result.items[0].category,category);assert.equal(s.calls(),0);
   const owners=merge([item],[],samePhysicalObject,c);
   assert.equal(owners[0].category,category);assert.deepEqual(owners[0].boundingBox,item.boundingBox);
   assert.equal(owners[0].itemId,item.itemId);assert.deepEqual(item,before);
  }
 }
});

test("Phase 2A.1: fresh generic eligibility remains one cached assessment, separate from carried authority denial",async()=>{
 const c=phase2ACapture(),fresh=vision("Item"),s=service();
 const first=await s.assess({capture:c,items:[fresh],principal:5});
 assert.equal(first.items[0].category,"Unknown");assert.equal(s.calls(),1);
 assert.deepEqual(await s.assess({capture:c,items:[fresh],principal:5}),first);assert.equal(s.calls(),1);
 const invalid={...fresh,category:"Special Waste",itemName:"Charger"},denied=service();
 assert.equal((await denied.assess({capture:c,items:[invalid],principal:5})).items[0].category,"Unknown");
 assert.equal(denied.calls(),0);
});

test("Phase 2A.1: display serialization cannot turn refined names into original category authority",async()=>{
 const c=phase2ACapture(),owner=phase2ADerivedOwner(c),before=structuredClone(owner);
 const formatted=require("../services/wasteDisplayNameService").withDisplayNames({detectedItems:[owner]});
 const copy=JSON.parse(JSON.stringify(formatted)).detectedItems[0];
 assert.equal(copy.category,"Special Waste");assert.equal(copy.canonicalItem,"item");
 assert.equal(categoryAuthority(copy,c.captureId),"invalid");
 const s=service(),result=await s.assess({capture:c,items:[copy],principal:5});
 assert.equal(result.items[0].category,"Unknown");assert.equal(s.calls(),0);
 const owners=merge([copy],[],samePhysicalObject,c);
 assert.equal(owners[0].category,"Unknown");assert.equal(owners[0].itemId,owner.itemId);
 assert.deepEqual(owners[0].boundingBox,owner.boundingBox);assert.deepEqual(owner,before);
 const stripped={...copy};delete stripped.identitySource;delete stripped.identityObservation;
 const stale=service();
 assert.equal(categoryAuthority(stripped,phase2ACapture(true).captureId),"invalid");
 assert.equal((await stale.assess({capture:phase2ACapture(true),items:[stripped],principal:5})).items[0].category,"Unknown");
 assert.equal(stale.calls(),0);
 const neutralCopy=require("../services/wasteDisplayNameService").withDisplayNames({detectedItems:owners}).detectedItems[0];
 delete neutralCopy.identitySource;delete neutralCopy.identityObservation;
 const generic=service();
 const neutral=await generic.assess({capture:c,items:[neutralCopy],principal:5});
 assert.equal(neutral.items[0].category,"Unknown");
 // Losing an Unknown denial marker cannot establish a category from display
 // text. It has only the ordinary fresh-generic eligibility (one cached batch).
 assert.equal(generic.calls(),1);
 for(const adverse of ["Printed picture of Charger","Possibly a Charger","Chemical bottle"]) {
  const independent=normalizeDetectedItems([{name:"Charger",score:.8,boundingBox:box}],"google_vision_object_localization")[0];
  independent.originalItemName=adverse;
  const denied=service();
  assert.equal(categoryAuthority(independent,c.captureId),"invalid");
  assert.equal((await denied.assess({capture:c,items:[independent],principal:5})).items[0].category,"Unknown");
  assert.equal(denied.calls(),0);
 }
});
