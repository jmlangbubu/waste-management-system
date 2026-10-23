"use strict";
// Offline provider facts and geometry only; no real-image or phone-accuracy claim.
const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {normalizeDetectedItems,samePhysicalObject,buildScanSummary}=require("../services/wasteAnalysisService");
const {automaticCategory,corroboratedCategory}=require("../services/automaticWasteCategoryMapper");
const {createAssessmentService}=require("../services/perItemWasteAssessmentService");
const {merge,alignedIdentity,identityConflict}=require("../services/wholeImageRecognitionService");
const {withDisplayNames}=require("../services/wasteDisplayNameService");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
const {WASTE_RULES,analyzeWasteByObject}=require("../utils/wasteMapper");
const box={left:.1,top:.1,right:.3,bottom:.5},far={left:.6,top:.1,right:.8,bottom:.5};
const capture=()=>({captureId:crypto.randomUUID(),requestId:crypto.randomUUID(),image:Buffer.from("ffd8ffc0000b080190025801011100ffd9","hex").toString("base64"),width:600,height:400,orientation:"upright"});
const vision=(name,b=box,confidence=.9)=>normalizeDetectedItems([{name,confidence,boundingBox:b}],"google_vision_object_localization")[0];
const evidence=(category="Unknown",kind="unknown",material="unknown",condition="unknown",level="insufficient")=>({category,kind,material,condition,evidence:level});
const insufficient=evidence(),provisional=evidence("Residual","wrapper","unknown","unknown","visible"),verified=evidence("Residual","wrapper","mixed","non_recyclable","visible"),plant=evidence("Biodegradable","plant_food_scraps","plant_matter","food_only","visible");
const electrical=evidence("Special Waste","electrical","mixed","unknown","visible");
function service(facts=insufficient,{enabled=true,fail=false}={}) {
 let calls=0;const requests=[];
 const assess=createAssessmentService({env:{WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:String(enabled),CLOUD_RUN_AUTH_MODE:"iam",CLOUD_RUN_AUDIENCE:"https://synthetic.invalid",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste",WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"offline-token-more-than-thirty-two-characters"},authHeaders:async()=>({}),transport:async(u,input)=>{
  calls++;requests.push(structuredClone(input));if(fail)throw Error("offline timeout");
  return {schemaVersion:1,captureId:input.captureId,requestId:input.requestId,assessments:input.items.map(item=>({itemId:item.itemId,...(typeof facts==="function"?facts(item):facts)}))};
 }});return {assess,requests,calls:()=>calls};
}
const protectedProducts=[
 ["Unopened snack packet","Snack packet",verified],
 ["Sealed snack sachet","Snack sachet",verified],
 ["Full water bottle","Water bottle",evidence("Recyclable","single_material","glass","clean_dry","visible")]
];
const reverseProducts=[["Snack packet","Unopened snack packet","Residual",verified],
 ["Snack sachet","Sealed snack sachet","Residual",verified],
 ["Water bottle","Full water bottle","Recyclable",evidence("Recyclable","single_material","glass","clean_dry","visible")]];
for(const [original,qualifier,previous,facts]of reverseProducts)for(const reverse of [false,true])
 for(const mode of ["disabled","insufficient","supported"])
 test(`reverse product-state veto corrects owner and final envelope: ${original}, ${mode}, reverse=${reverse}`,async()=>{
  const c=capture(),raw=[{name:original,confidence:.9,boundingBox:box},{name:"Banana peel",confidence:.85,boundingBox:far}];
  const initial=normalizeDetectedItems(reverse?raw.reverse():raw,"google_vision_object_localization");
  const before=structuredClone(initial),originalOwner=initial.find(i=>i.canonicalItem===original.toLowerCase());
  // An unqualified product name no longer establishes empty/discarded state.
  assert.equal(originalOwner.category,"Unknown");
  const g=whole.normalize(c,{objects:[{label:qualifier,box_2d:[100,100,500,300]}]}).objects;
  const items=merge(initial,g,samePhysicalObject,c),owner=items.find(i=>i.itemId===originalOwner.itemId);
  assert.equal(owner.category,"Unknown");assert.equal(owner.requiresConfirmation,true);
  assert.equal(owner.canonicalItem,originalOwner.canonicalItem);assert.equal(owner.itemName,originalOwner.itemName);
  assert.equal(owner.analysisSource,originalOwner.analysisSource);assert.equal(owner.confidence,originalOwner.confidence);
  assert.deepEqual(owner.boundingBox,originalOwner.boundingBox);assert.equal(alignedIdentity(owner,c.captureId),qualifier);
  // Already-Unknown normalized owners may retain empty metadata containers,
  // but never category-specific advice or a usable model/tutorial reference.
  assert.deepEqual(owner.guidance||{},{});assert.equal(owner.modelKey||"","");assert.deepEqual(owner.modelHotspots||[],[]);
  for(const field of ["explanation","action","warning"])assert.equal(Object.hasOwn(owner,field),false,field);
  for(const field of ["observedIdentity","originalItemName","captureId"])assert.deepEqual(owner[field],originalOwner[field],field);
  const s=service(mode==="supported"?facts:insufficient,{enabled:mode!=="disabled"}),saved=structuredClone(items);
  const sidecar=await s.assess({capture:c,items,principal:5});
  const envelope=withDisplayNames({detectedItems:items,scanSummary:buildScanSummary(items),categoryAssessments:sidecar,
   itemName:"Original primary",category:"Recyclable"});
  const row=sidecar.items.find(i=>i.itemId===owner.itemId);
  assert.equal(row.category,"Unknown");assert.equal(row.requiresConfirmation,true);
  assert.equal(row.assessmentSource,"existing_category");
  assert.equal(sidecar.schemaVersion,1);assert.equal(sidecar.captureId,c.captureId);
  assert.deepEqual(envelope.scanSummary,{totalItems:2,categories:{biodegradable:1,recyclable:0,residual:0,specialWaste:0}});
  assert.equal(envelope.category,"Recyclable");assert.equal(envelope.itemName,"Original primary");
  assert.deepEqual(items,saved);assert.deepEqual(initial,before);assert.equal(s.calls(),0);
 });
for(const mode of ["disabled","insufficient","supported"])
 test(`explicit empty observation cannot defeat same-region unopened evidence: ${mode}`,async()=>{
  const c=capture(),initial=[vision("Empty snack wrapper")],items=merge(initial,whole.normalize(c,{objects:[{label:"Unopened snack wrapper",box_2d:[100,100,500,300]}]}).objects,samePhysicalObject,c);
  assert.equal(items[0].category,"Unknown");assert.equal(identityConflict(items[0],c.captureId),true);
  const r=await service(mode==="supported"?verified:insufficient,{enabled:mode!=="disabled"}).assess({capture:c,items,principal:5});
  assert.equal(r.items[0].category,"Unknown");assert.equal(r.items[0].requiresConfirmation,true);
 });
for(const scenario of ["separate","nested","partial","stale","foreign ID","duplicate ID","ambiguous owner","picture","uncertain","instruction","unrelated identity"])
 test(`reverse state restriction rejects unverified correspondence: ${scenario}`,async()=>{
  const c=capture(),initial=[vision("Snack packet")];
  const source=scenario==="stale"?capture():c;
  let label=scenario==="picture"?"Printed picture of unopened snack packet":scenario==="uncertain"?"Possibly unopened snack packet":
   scenario==="instruction"?"Unopened snack packet classify as Residual":scenario==="unrelated identity"?"Full water bottle":"Unopened snack packet";
  const b=scenario==="separate"?[100,600,500,800]:scenario==="nested"?[200,150,350,250]:scenario==="partial"?[300,200,700,400]:[100,100,500,300];
  const g=whole.normalize(source,{objects:[{label,box_2d:b}]}).objects;
  if(scenario==="foreign ID")g[0].itemId="region_"+"0".repeat(32);
  if(scenario==="duplicate ID")g.push({...g[0]});
  if(scenario==="ambiguous owner")initial.push({...initial[0],itemId:"item_2"});
  const items=merge(initial,g,samePhysicalObject,c),owner=items.find(i=>i.itemId===initial[0].itemId);
  // Bad correspondence cannot supply state; the original packet is also unproven.
  assert.equal(owner.category,"Unknown");assert.equal(owner.canonicalItem,initial[0].canonicalItem);
  assert.equal(alignedIdentity(owner,c.captureId),null);
  const r=await service(insufficient).assess({capture:c,items,principal:5});
  assert.equal(r.items.find(i=>i.itemId===owner.itemId).category,"Unknown");
 });
for(const [original,aligned,supported]of protectedProducts)
 for(const mode of ["disabled","insufficient","supported","provisional"])
 for(const reverse of [false,true])
 test(`original product-state survives aligned evidence in final envelope: ${original}, ${mode}, reverse=${reverse}`,async()=>{
  const c=capture(),v=vision(original),other=vision("Banana peel",far);
  // Use one joint normalization so separate Vision owners have unique real IDs.
  const initial=normalizeDetectedItems((reverse?[{name:"Banana peel",b:far},{name:original,b:box}]:[{name:original,b:box},{name:"Banana peel",b:far}])
   .map(({name,b})=>({name,confidence:.9,boundingBox:b})),"google_vision_object_localization");
  const proposals=whole.normalize(c,{objects:[{label:aligned,box_2d:[100,100,500,300]}]}).objects;
  const items=merge(initial,proposals,samePhysicalObject,c),owner=items.find(i=>i.canonicalItem===v.canonicalItem),before=structuredClone(items);
  assert.equal(alignedIdentity(owner,c.captureId),aligned);
  assert.equal(owner.category,"Unknown");assert.deepEqual(owner.boundingBox,box);assert.equal(owner.confidence,.9);
  const facts=mode==="supported"?supported:mode==="provisional"?provisional:insufficient;
  const s=service(facts,{enabled:mode!=="disabled"}),r=await s.assess({capture:c,items,principal:5,
   primary:{analysisSource:"cloud_run_gemini_vision",aiLabel:aligned,category:supported.category,aiConfidence:.99}});
  const row=r.items.find(i=>i.itemId===owner.itemId);
  assert.equal(row.category,"Unknown");assert.equal(row.requiresConfirmation,true);
  // A structured category response cannot establish removal of product contents.
  assert.equal(row.assessmentSource,"existing_category");
  assert.match(row.guidance.whatItIs,/not safely established/);assert.equal(r.captureId,c.captureId);assert.equal(r.schemaVersion,1);
  assert.equal(r.items.find(i=>i.itemId!==owner.itemId).category,"Biodegradable");assert.deepEqual(items,before);
  assert.equal(s.calls(),0);
  assert.deepEqual(other.boundingBox,far);
 });
for(const [original,aligned,supported]of protectedProducts)for(const source of ["Vision","Gemini"])
 for(const mode of ["disabled","insufficient","supported"])
 test(`original product-state without reconciliation remains guarded: ${source}, ${original}, ${mode}`,async()=>{
  const c=capture(),items=source==="Vision"?[vision(original)]:merge([],whole.normalize(c,{objects:[{label:original,box_2d:[100,100,500,300]}]}).objects,samePhysicalObject,c);
  const saved=structuredClone(items),s=service(mode==="supported"?supported:insufficient,{enabled:mode!=="disabled"});
  const r=await s.assess({capture:c,items,principal:5,primary:{analysisSource:"cloud_run_gemini_vision",aiLabel:aligned,category:supported.category,aiConfidence:.99}});
  assert.equal(r.items[0].category,"Unknown");assert.equal(r.items[0].requiresConfirmation,true);
  assert.equal(r.items[0].itemId,items[0].itemId);assert.deepEqual(items,saved);assert.ok(s.calls()<=1);
 });
test("an aligned product-state restriction also survives a neutral original identity",async()=>{
 const c=capture(),items=merge([vision("Packet")],whole.normalize(c,{objects:[{label:"Unopened snack packet",box_2d:[100,100,500,300]}]}).objects,samePhysicalObject,c);
 const r=await service(verified).assess({capture:c,items,principal:5});
 assert.equal(r.items[0].category,"Unknown");assert.equal(r.items[0].requiresConfirmation,true);
});
for(const [original,aligned,supported]of protectedProducts)
 test(`single-object primary corroboration cannot erase original product-state: ${original}`,async()=>{
  const c=capture(),v=vision(original),items=merge([v],whole.normalize(c,{objects:[{label:aligned,box_2d:[100,100,500,300]}]}).objects,samePhysicalObject,c);
  const before=structuredClone(items),s=service(insufficient),r=await s.assess({capture:c,items,principal:5,
   primary:{analysisSource:"cloud_run_gemini_vision",aiLabel:aligned,category:supported.category,aiConfidence:.99}});
  assert.equal(r.items[0].category,"Unknown");assert.equal(r.items[0].requiresConfirmation,true);
  assert.equal(r.items[0].itemId,v.itemId);assert.deepEqual(items,before);assert.equal(s.calls(),0);
 });
for(const label of ["Empty snack wrapper","Snack wrapper","Empty water bottle"])
 test(`explicit-empty state is required for product guidance: ${label}`,async()=>{
  const c=capture(),items=[vision(label)],before=structuredClone(items),s=service(insufficient);
  const r=await s.assess({capture:c,items,principal:5});
  assert.equal(r.items[0].category,label==="Snack wrapper"?"Unknown":label.includes("bottle")?"Recyclable":"Residual");assert.deepEqual(items,before);
 });
for(const initial of [false,true])for(const labels of [["Can","Spray Can"],["Spray Can","Can"]])
 for(const facts of [insufficient,electrical,verified])
 test(`spray-can risk survives reconciliation through final assessment: initial=${initial}, ${labels.join("/")}, ${facts.category}`,async()=>{
  const c=capture(),raw=whole.normalize(c,{objects:labels.map(label=>({label,box_2d:[100,100,500,300]}))}).objects;
  const owner=raw.find(item=>item.observedIdentity==="Spray Can"),before=structuredClone(raw);
  const items=merge(initial?raw:[],initial?[]:raw,samePhysicalObject,c),s=service(facts);
  assert.equal(items.length,1);assert.equal(items[0].observedIdentity,"Spray Can");
  assert.equal(items[0].itemId,owner.itemId);assert.deepEqual(items[0].boundingBox,owner.boundingBox);
  assert.equal(items[0].confidence,owner.confidence);assert.equal(identityConflict(items[0],c.captureId),true);
  const r=await s.assess({capture:c,items,principal:5});
  assert.equal(r.items[0].category,"Unknown");assert.equal(r.items[0].requiresConfirmation,true);
  assert.equal(r.items[0].itemId,owner.itemId);assert.equal(r.captureId,c.captureId);assert.equal(s.calls(),1);
  assert.deepEqual(raw,before);
 });
for(const reverse of [false,true])for(const [description,regions]of [
 ["separate",[[100,100,500,300],[100,600,500,800]]],
 ["nested",[[100,100,900,900],[300,300,600,600]]]])
 test(`Can/Spray Can independent ${description} objects retain ownership: reverse=${reverse}`,async()=>{
  const c=capture(),objects=regions.map((box_2d,i)=>({label:i?"Spray Can":"Can",box_2d}));
  const raw=whole.normalize(c,{objects:reverse?objects.reverse():objects}).objects;
  const items=merge([],raw,samePhysicalObject,c),s=service(verified);
  assert.equal(items.length,2);assert.deepEqual(new Set(items.map(i=>i.itemId)),new Set(raw.map(i=>i.itemId)));
  const r=await s.assess({capture:c,items,principal:5});
  const spray=items.find(i=>i.observedIdentity==="Spray Can");
  assert.equal(r.items.find(i=>i.itemId===spray.itemId).category,"Unknown");
  assert.ok(r.items.every(i=>i.requiresConfirmation));
  for(const item of items)assert.deepEqual(item.boundingBox,raw.find(i=>i.itemId===item.itemId).boundingBox);
 });
for(const labels of [["Can","Printed Spray Can Picture"],["Printed Spray Can Picture","Can"],
 ["Can","Possibly a spray can"],["Possibly a spray can","Can"]])
 test(`represented/uncertain spray evidence cannot become a safe stream: ${labels.join("/")}`,async()=>{
  const c=capture(),raw=whole.normalize(c,{objects:labels.map(label=>({label,box_2d:[100,100,500,300]}))}).objects;
  const items=merge([],raw,samePhysicalObject,c),s=service(verified),r=await s.assess({capture:c,items,principal:5});
  assert.equal(items.length,1);assert.equal(r.items[0].category,"Unknown");assert.equal(r.items[0].requiresConfirmation,true);
 });
for(const initial of [false,true])for(const labels of [["Can","Paint Can"],["Paint Can","Can"]])
 test(`unique Gemini Can/Paint Can preserves specific owner: initial=${initial}, ${labels.join("/")}`,async()=>{
  const c=capture(),raw=whole.normalize(c,{objects:labels.map(label=>({label,box_2d:[100,100,500,300]}))}).objects;
  const owner=raw.find(item=>item.observedIdentity==="Paint Can"),before=structuredClone(owner);
  const items=merge(initial?raw:[],initial?[]:raw,samePhysicalObject,c),s=service();
  assert.equal(items.length,1);assert.equal(identityConflict(items[0],c.captureId),false);
  assert.equal(items[0].itemId,owner.itemId);assert.deepEqual(items[0].boundingBox,owner.boundingBox);
  assert.equal(items[0].observedIdentity,owner.observedIdentity);assert.equal(items[0].confidence,owner.confidence);
  assert.equal((await s.assess({capture:c,items,principal:5})).items[0].category,"Special Waste");
  assert.deepEqual(owner,before);assert.equal(s.calls(),1);
 });
for(const labels of [["Can","Spray Can"],["Can","Chemical Can"],["Can","Printed Paint Can Picture"],
 ["Paint Can","Syringe"],["Can","Paint Can","Chemical Can"]])
 test(`specific refinement retains real conflict: ${labels.join("/")}`,async()=>{
  const c=capture(),raw=whole.normalize(c,{objects:labels.map(label=>({label,box_2d:[100,100,500,300]}))}).objects;
  const items=merge([],raw,samePhysicalObject,c),s=service(electrical);
  assert.equal(items.length,1);assert.equal(identityConflict(items[0],c.captureId),true);
  assert.equal((await s.assess({capture:c,items,principal:5})).items[0].category,"Unknown");
 });
for(const [description,boxes]of [["separate",[[100,100,500,300],[100,600,500,800]]],
 ["partial overlap",[[100,100,500,500],[300,300,700,700]]],
 ["nested",[[100,100,900,900],[300,300,600,600]]]])
 test(`Can/Paint Can keeps independent ${description} regions`,()=>{
  const c=capture(),raw=whole.normalize(c,{objects:boxes.map((box_2d,i)=>({label:i?"Paint Can":"Can",box_2d}))}).objects;
  const items=merge([],raw,samePhysicalObject,c);
  assert.equal(items.length,2);assert.deepEqual(new Set(items.map(i=>i.itemId)),new Set(raw.map(i=>i.itemId)));
  for(const item of items)assert.deepEqual(item.boundingBox,raw.find(r=>r.itemId===item.itemId).boundingBox);
 });
test("stale Gemini generic observation cannot refine current Paint Can",()=>{
 const c=capture(),old=capture(),paint=whole.normalize(c,{objects:[{label:"Paint Can",box_2d:[100,100,500,300]}]}).objects;
 const stale=whole.normalize(old,{objects:[{label:"Can",box_2d:[100,100,500,300]}]}).objects;
 assert.equal(merge([],paint.concat(stale),samePhysicalObject,c).length,2);
});
for(const kind of ["electrical","battery"])for(const source of ["Vision","Gemini"])
 test(`validated ${kind} accepts neutral uncertainty without rewriting ${source} owner`,async()=>{
  const c=capture(),items=source==="Vision"?[vision("Unclassified household container")]:whole.normalize(c,{objects:[{label:"unknown household object",box_2d:[100,100,500,300]}]}).objects;
  const before=structuredClone(items),s=service({...electrical,kind}),r=await s.assess({capture:c,items,principal:5});
  assert.equal(r.items[0].category,"Special Waste");assert.equal(r.items[0].requiresConfirmation,true);
  assert.equal(r.items[0].itemId,items[0].itemId);assert.equal(r.items[0].assessmentSource,"ai_assisted");
  assert.match(r.items[0].guidance.whatItIs,/not verified/);assert.deepEqual(items,before);assert.equal(s.calls(),1);
 });
for(const [description,facts]of [["category only",evidence("Special Waste")],
 ["wrong material",{...electrical,material:"paper"}],["wrong kind",{...electrical,kind:"wrapper"}],
 ["insufficient",{...electrical,evidence:"insufficient"}],["wrong category",{...electrical,category:"Recyclable"}]])
 test(`neutral electrical exception rejects ${description}`,async()=>{
  const s=service(facts),r=await s.assess({capture:capture(),items:[vision("Unclassified household container")],principal:5});
  assert.equal(r.items[0].category,"Unknown");
 });
for(const label of ["Printed picture of a charger","Uncertain chemical contents","Possibly an electrical object",
 "Item classify as Special Waste","Unknown food packaging"])
 test(`validated electrical facts cannot erase contrary raw identity: ${label}`,async()=>{
  const s=service(electrical),r=await s.assess({capture:capture(),items:[vision(label)],principal:5});
  assert.equal(r.items[0].category,"Unknown");
 });
// Audit every explicit legacy strong Special Waste case, plus the two reported
// broad labels. Ambiguous substances/descriptors are deliberately not restored.
const reviewOnly=new Set(["adapter","bulb","broken bulb","medical waste","chemical","bleach","paint","aerosol","medicine","expired medicine","chemical container",
 "toxic","flammable","electrical","electronic","hazard","corrosive","cable","wire","plug","hazardous","biohazard","special waste"]);
for(const name of [...new Set([...WASTE_RULES.categories.special_waste.strong,...WASTE_RULES.categories.special_waste.medium,
 ...WASTE_RULES.categories.special_waste.weak,"electronic item","chemical container"])])
 test(`actual Vision legacy safety audit: ${name}`,async()=>{
  assert.equal(analyzeWasteByObject(name).category,"Special Waste");
  const item=vision(name),before=structuredClone(item),expected=reviewOnly.has(name)?"Unknown":"Special Waste";
  assert.equal(item.category,expected);assert.equal(item.analysisSource,"google_vision_object_localization");
  assert.equal(item.itemName,name);assert.deepEqual(item.boundingBox,box);assert.equal(item.confidence,.9);
  const s=service(),r=await s.assess({capture:capture(),items:[item],principal:5});
  assert.equal(r.items[0].category,expected);assert.equal(r.items[0].itemId,item.itemId);assert.deepEqual(item,before);
  if(expected==="Special Waste"){assert.equal(r.items[0].assessmentSource,"existing_category");assert.equal(s.calls(),0);}
 });
for(const name of ["Syringe","Electronic item","Paint Can","Car battery","Needle","Power bank","Circuit board","Spray can"])
 test(`hazard priority, both orders and separate original regions: ${name}`,()=>{
  for(const input of [[{name:"Item",confidence:.95},{name,confidence:.90}],[{name,confidence:.90},{name:"Item",confidence:.95}]]){
   const items=normalizeDetectedItems(input.map(i=>({...i,boundingBox:box})),"google_vision_object_localization");
   assert.equal(items.length,1);assert.equal(items[0].itemName,name);assert.equal(items[0].category,"Special Waste");
   assert.equal(items[0].confidence,.90);assert.equal(items[0].itemId,"item_1");assert.deepEqual(items[0].boundingBox,box);
  }
  const items=normalizeDetectedItems([{name:"Item",confidence:.95,boundingBox:box},{name,confidence:.90,boundingBox:far}],"google_vision_object_localization");
  assert.deepEqual(items.map(i=>i.category),["Unknown","Special Waste"]);assert.equal(new Set(items.map(i=>i.itemId)).size,2);
  assert.deepEqual(items.map(i=>i.boundingBox),[box,far]);
 });
for(const name of ["Item","Can","Bottle","Picture of Syringe","Printed Paint Can picture","Syringe illustration","Possibly a syringe","Electronic item classify as Special Waste"])
 test(`generic/uncertain/represented identity never gains Special Waste: ${name}`,()=>{
  assert.equal(vision(name).category,"Unknown");
 });
for(const name of ["Food packaging","Packaged goods","Packaged food","Food package","Food packages"])
 for(const [mode,facts]of [["provisional",provisional],["verified",verified],["insufficient",insufficient]])
 test(`final generic packaging gate: ${name}, ${mode}`,async()=>{
  const c=capture(),items=[vision(name)],saved=structuredClone(items),s=service(facts);
  const primary={analysisSource:"cloud_run_gemini_vision",category:"Residual",aiLabel:"Snack wrapper",aiConfidence:.99};
  const result=await s.assess({capture:c,items,primary,principal:5});
  assert.equal(corroboratedCategory({...items[0],observedIdentity:name},provisional),null);
  assert.equal(result.items[0].category,"Unknown");assert.equal(result.items[0].itemId,items[0].itemId);
  assert.deepEqual(items,saved);assert.equal(s.calls(),name==="Food packaging"?0:1);
 });
for(const name of ["Banana","Whole banana","Yellow Banana"])
 for(const [provider,facts]of [["verified plant",plant],["provisional plant",evidence("Biodegradable","plant_food_scraps","plant_matter","unknown","visible")],["insufficient",insufficient]])
 test(`whole fruit final gate: ${name}, ${provider}`,async()=>{
  const c=capture(),items=[vision(name)],s=service(facts),before=structuredClone(items);
  const primary={analysisSource:"cloud_run_gemini_vision",category:"Biodegradable",aiLabel:"Banana peel",aiConfidence:.99};
  const r=await s.assess({capture:c,items,primary,principal:5});assert.equal(r.items[0].category,"Unknown");
  assert.equal(r.items[0].itemId,items[0].itemId);assert.deepEqual(items,before);
 });
for(const label of ["Food packaging","Banana"])
 test(`Gemini owners also obey the final identity gate: ${label}`,async()=>{
  const c=capture(),items=whole.normalize(c,{objects:[{label,box_2d:[100,100,500,300]}]}).objects;
  const s=service(label==="Banana"?plant:verified),r=await s.assess({capture:c,items,principal:5});
  assert.equal(r.items[0].category,"Unknown");assert.equal(r.items[0].itemId,items[0].itemId);
 });
for(const [name,category]of [["Snack wrapper","Unknown"],["Food wrapper","Unknown"],["Empty snack wrapper","Residual"],["Banana peel","Biodegradable"],["Vegetable scraps","Biodegradable"]])
 test(`supported waste form versus unproven wrapper state: ${name}`,async()=>{
  // Facts describe the original fixture, not the expected category. Ineligible
  // unqualified wrappers must remain Unknown even with a verified wrapper claim.
  const c=capture(),items=[vision(name)],s=service(/wrapper/i.test(name)?verified:plant);
  const r=await s.assess({capture:c,items,principal:5});assert.equal(r.items[0].category,category);
 });
test("aligned-only empty refinement cannot establish original packaging disposal state",async()=>{
 const c=capture(),v=vision("Packaged goods"),g=whole.normalize(c,{objects:[{label:"Empty snack wrapper",box_2d:[100,100,500,300]}]}).objects;
 const items=merge([v],g,samePhysicalObject,c),saved=structuredClone(items),s=service(verified);
 assert.equal(alignedIdentity(items[0],c.captureId),"Empty snack wrapper");
 const r=await s.assess({capture:c,items,principal:5});assert.equal(r.items[0].category,"Unknown");
 assert.equal(s.requests[0].items[0].observedIdentity,"Empty snack wrapper");assert.equal(r.items[0].itemId,v.itemId);
 assert.deepEqual(items,saved);assert.deepEqual(items[0].boundingBox,v.boundingBox);
});
test("original whole Banana cannot be reinterpreted as peel by a conflicting refined waste form",async()=>{
 const c=capture(),v=vision("Banana"),g=whole.normalize(c,{objects:[{label:"Banana peel",box_2d:[100,100,500,300]}]}).objects;
 const items=merge([v],g,samePhysicalObject,c),s=service(plant);
 assert.equal(items[0].canonicalItem,"banana");assert.equal(alignedIdentity(items[0],c.captureId),"Banana peel");
 const r=await s.assess({capture:c,items,principal:5});assert.equal(r.items[0].category,"Unknown");
 assert.equal(r.items[0].itemId,v.itemId);assert.deepEqual(items[0].boundingBox,v.boundingBox);
});
test("unopened product and conflicting identities retain their safety vetoes",async()=>{
 const c=capture(),s=service(verified),item=vision("Unopened food packet");
 assert.equal((await s.assess({capture:c,items:[item],principal:5})).items[0].category,"Unknown");
 const other=capture(),v=vision("Packet"),g=whole.normalize(other,{objects:[{label:"Chemical bottle",box_2d:[100,100,500,300]}]}).objects;
 const items=merge([v],g,samePhysicalObject,other);assert.equal(identityConflict(items[0],other.captureId),true);
 assert.equal((await service(verified).assess({capture:other,items,principal:5})).items[0].category,"Unknown");
});
test("mixed final sidecar keeps v7 fields, source enums, category ownership, boxes and a single cached batch",async()=>{
 const c=capture(),names=["Food packaging","Banana","Banana peel","Empty snack wrapper","Syringe"];
 const items=normalizeDetectedItems(names.map((name,i)=>({name,confidence:.9,boundingBox:{left:.01+i*.19,top:.1,right:.15+i*.19,bottom:.5}})),"google_vision_object_localization");
 const before=structuredClone(items),s=service(i=>i.observedIdentity==="banana"?plant:verified);
 const result=await s.assess({capture:c,items,principal:5});
 assert.deepEqual(result.items.map(i=>i.category),["Unknown","Unknown","Biodegradable","Residual","Special Waste"]);
 assert.deepEqual(result.items.map(i=>i.itemId),items.map(i=>i.itemId));assert.deepEqual(items,before);
 assert.equal(result.captureId,c.captureId);assert.equal(result.schemaVersion,1);assert.equal(result.aiStatus,"complete");
 assert.deepEqual(Object.keys(result).sort(),["aiStatus","captureId","items","schemaVersion"]);
 for(const row of result.items){assert.deepEqual(Object.keys(row).sort(),["assessmentSource","category","confirmationRequirements","guidance","itemId","requiresConfirmation"]);assert.equal(row.requiresConfirmation,true);}
 assert.deepEqual(result.items.map(i=>i.assessmentSource),["existing_category","ai_assisted","existing_category","existing_category","existing_category"]);
 const formatted=withDisplayNames({detectedItems:items,categoryAssessments:result});assert.equal(formatted.categoryAssessments,result);
 assert.deepEqual(formatted.detectedItems.map(i=>i.boundingBox),before.map(i=>i.boundingBox));
 await s.assess({capture:{...c,requestId:crypto.randomUUID()},items,principal:5});assert.equal(s.calls(),1);
});
test("disabled and unavailable AI preserve the guarded Unknown fallback with no retry",async()=>{
 for(const options of [{enabled:false},{fail:true}]){
  const c=capture(),items=normalizeDetectedItems([{name:"Food packaging",confidence:.9,boundingBox:box},
   {name:"Item",confidence:.9,boundingBox:far}],"google_vision_object_localization"),s=service(verified,options),input={capture:c,items,principal:5};
  const r=await s.assess(input);assert.deepEqual(r.items.map(i=>i.category),["Unknown","Unknown"]);
  assert.equal(r.aiStatus,options.fail?"unavailable":"not_requested");
  await s.assess(input);assert.equal(s.calls(),options.fail?1:0);
 }
});

// Final source-consistency matrix: real normalization/merge, mocked transport.
const ownedItems=(c,label,provider,b=box)=>provider==="Vision"
 ? merge(normalizeDetectedItems([{name:label,confidence:.9,boundingBox:b}],"google_vision_object_localization"),[],samePhysicalObject,c)
 : merge([],whole.normalize(c,{objects:[{label,box_2d:[b.top,b.left,b.bottom,b.right].map(n=>Math.round(n*1000))}]}).objects,samePhysicalObject,c);
const intactPhrases=["Banana","Bananas","Whole Banana","Unpeeled Banana","Whole Ripe Banana","Banana Fruit","Unpeeled Ripe Banana","Ripe Yellow Banana"];
for(const provider of ["Vision","Gemini"])for(const name of intactPhrases)
 test(`intact fruit final matrix ${provider}: ${name}`,async()=>{
  const c=capture(),items=ownedItems(c,name,provider),before=structuredClone(items),s=service(plant);
  assert.equal(items[0].category,"Unknown");
  const r=await s.assess({capture:c,items,principal:5,primary:{analysisSource:"cloud_run_gemini_vision",aiLabel:"Banana peel",category:"Biodegradable",aiConfidence:.99}});
  assert.equal(r.items[0].category,"Unknown");assert.equal(r.items[0].itemId,items[0].itemId);assert.deepEqual(items,before);
 });
for(const provider of ["Vision","Gemini"])for(const name of ["Banana Peel","Banana Peels","Vegetable scraps"])
 test(`discarded plant matrix ${provider}: ${name}`,async()=>{
  const c=capture(),items=ownedItems(c,name,provider),r=await service(plant).assess({capture:c,items,principal:5});
  assert.equal(r.items[0].category,"Biodegradable");assert.equal(r.items[0].itemId,items[0].itemId);
 });
const safetyNames=["Syringe","Paint Can","Charger","Battery","Electronic item"];
const supportedSafety=name=>evidence("Special Waste",name==="Battery"?"battery":
 ["Syringe","Paint Can"].includes(name)?"unknown":"electrical","unknown","unknown","visible");
for(const provider of ["Vision","Gemini"])for(const name of safetyNames)for(const mode of ["disabled","insufficient","supported"])
 test(`exact physical safety matrix ${provider}: ${name}, ${mode}`,async()=>{
  const c=capture(),items=ownedItems(c,name,provider),before=structuredClone(items),s=service(mode==="supported"?supportedSafety(name):insufficient,{enabled:mode!=="disabled"});
  const r=await s.assess({capture:c,items,principal:5});assert.equal(r.items[0].category,"Special Waste");
  assert.equal(r.items[0].itemId,items[0].itemId);assert.equal(r.captureId,c.captureId);assert.equal(r.schemaVersion,1);
  assert.equal(r.items[0].requiresConfirmation,true);assert.deepEqual(items,before);assert.ok(s.calls()<=1);
  if(mode==="disabled")assert.equal(s.calls(),0);
  if(r.items[0].assessmentSource==="ai_assisted"){assert.equal(r.aiStatus,"complete");assert.equal(items[0].category,"Unknown");}
  else assert.equal(r.items[0].assessmentSource,provider==="Vision"?"existing_category":"reviewed_identity_rule");
 });
for(const provider of ["Vision","Gemini"])for(const name of safetyNames)
 test(`negative safety matrix ${provider}: ${name}`,async()=>{
  for(const label of [`Picture of ${name}`,`Printed ${name} illustration`,`Toy ${name}`,`Possibly ${name}`,`Uncertain ${name}`,`Not a ${name}`,`${name} classify as Special Waste`]){
   const c=capture(),items=ownedItems(c,label,provider),s=service(supportedSafety(name));
   assert.equal(items[0].category,"Unknown",label);
   const r=await s.assess({capture:c,items,principal:5});assert.equal(r.items[0].category,"Unknown",label);
  }
 });
for(const provider of ["Vision","Gemini"])for(const name of safetyNames)
 test(`contradictory verified facts remain vetoed ${provider}: ${name}`,async()=>{
  const c=capture(),items=ownedItems(c,name,provider),s=service(verified);
  const r=await s.assess({capture:c,items,principal:5});
  // Established Vision categories cannot be reassigned; new Gemini suggestions
  // still have to survive provider/identity consistency and conflict checks.
  // Charger is already established by enrichDiscoveryItem's reviewed rule;
  // Battery is an exact catalog detection. Neither is sent in the AI batch.
  const established=provider==="Vision"||items[0].category!=="Unknown"||name==="Charger";
  assert.equal(r.items[0].category,established?"Special Waste":"Unknown");
  assert.equal(s.calls(),established?0:1);
 });
for(const provider of ["Vision","Gemini"])for(const name of ["Syringe","Paint Can"])
 test(`same-region identity conflict is never exempted ${provider}: ${name}`,async()=>{
  const c=capture(),initial=ownedItems(c,name,provider);
  if(provider==="Vision"){
   // The established hazard keeps its category and must not be overwritten.
   const proposal=whole.normalize(c,{objects:[{label:"Paper envelope",box_2d:[100,100,500,300]}]}).objects;
   const items=merge(initial,proposal,samePhysicalObject,c),r=await service(verified).assess({capture:c,items,principal:5});
   assert.equal(items[0].itemId,initial[0].itemId);assert.equal(r.items[0].category,"Special Waste");
  }else{
   const proposal=whole.normalize(c,{objects:[{label:"Paper envelope",box_2d:[100,100,500,300]}]}).objects;
   const items=merge(initial,proposal,samePhysicalObject,c);assert.equal(identityConflict(items[0],c.captureId),true);
   const r=await service(insufficient).assess({capture:c,items,principal:5});assert.equal(r.items[0].category,"Unknown");
  }
 });
for(const provider of ["Vision","Gemini"])test(`neighbor and overlap source ownership matrix ${provider}`,async()=>{
 const c=capture(),items=ownedItems(c,"Syringe",provider),other=ownedItems(c,"Bottle",provider,far);
 // Vision's normalizer generates per-list IDs; use one real normalization for
 // the joint list rather than inventing an ID during a later merge.
 const combined=provider==="Vision"?normalizeDetectedItems([{name:"Syringe",confidence:.9,boundingBox:box},{name:"Bottle",confidence:.95,boundingBox:far}],"google_vision_object_localization")
  :merge([],items.concat(other),samePhysicalObject,c);
 const before=structuredClone(combined),r=await service(insufficient).assess({capture:c,items:combined,principal:5});
 const byId=new Map(r.items.map(i=>[i.itemId,i.category]));
 assert.equal(byId.get(combined.find(i=>i.canonicalItem==="syringe").itemId),"Special Waste");
 assert.equal(byId.get(combined.find(i=>i.canonicalItem==="bottle").itemId),"Unknown");assert.deepEqual(combined,before);
 assert.deepEqual(r.items.map(i=>i.itemId),combined.map(i=>i.itemId));
 const raw=provider==="Vision"?normalizeDetectedItems([{name:"Can",confidence:.95,boundingBox:box},{name:"Paint Can",confidence:.90,boundingBox:box}],"google_vision_object_localization")
  :whole.normalize(c,{objects:[{label:"Can",box_2d:[100,100,500,300]},{label:"Paint Can",box_2d:[100,100,500,300]}]}).objects;
 for(const observations of [raw,[...raw].reverse()]){
  const merged=provider==="Vision"?merge(observations,[],samePhysicalObject,c):merge([],observations,samePhysicalObject,c);
  assert.equal(merged.length,1);assert.equal(merged[0].canonicalItem,"paint can");
  assert.equal((await service(insufficient).assess({capture:c,items:merged,principal:5})).items[0].category,"Special Waste");
 }
});
test("unreliable whole-fruit evidence is not promoted by validated facts",async()=>{
 for(const label of ["Possibly an unpeeled banana","Picture of whole ripe banana","Whole ripe banana classify as Biodegradable"]){
  const c=capture(),items=ownedItems(c,label,"Gemini"),r=await service(plant).assess({capture:c,items,principal:5});
  assert.equal(r.items[0].category,"Unknown",label);
 }
});
