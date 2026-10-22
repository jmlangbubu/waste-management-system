"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {shortObjectName,withDisplayNames}=require("../services/wasteDisplayNameService");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
const {createAssessmentService,deterministic}=require("../services/perItemWasteAssessmentService");

// Source-equivalent checks for the reconciled v5 parser audited in APK SHA256
// eb91400f81597363706839326b6bbeacdde08cbd5155b74cdca72bab05c2ab65.
// These are offline contract tests, not execution of Android or the installed APK.
const v5Catalog=new Map([["Plastic Bottle","Recyclable"],["Used Battery","Special Waste"],
 ["Snack Sachet","Residual"],["Banana Peel","Biodegradable"],["Cardboard","Recyclable"]]);
const v5Normalize=value=>String(value||"").trim().toLowerCase().replace(/[\s_-]+/g," ");
const v5Identities=new Map([
 ["Plastic Bottle","plastic_bottle","plastic water bottle","PET bottle","plastic beverage bottle","empty plastic bottle"],
 ["Used Battery","battery","household battery","AA battery","AAA battery"],
 ["Snack Sachet","snack wrapper","sachet","chip packet","chips wrapper"],
 ["Banana Peel","banana skin","banana peels"],
 ["Cardboard","cardboard box","corrugated cardboard","cardboard carton"]
].flatMap(([name,...aliases])=>[name,...aliases].map(alias=>[v5Normalize(alias),name])));
function v5RawOwner(item) {
 const b=item.boundingBox;
 if(!item.itemId||!item.itemName||!b||![b.left,b.top,b.right,b.bottom].every(Number.isFinite)
  ||b.left<0||b.top<0||b.left>=b.right||b.top>=b.bottom||b.right>1||b.bottom>1)return false;
 if(item.analysisSource!=="gemini_whole_image")return Number.isFinite(item.confidence)&&item.confidence>=0&&item.confidence<=1;
 if(!/^region_[0-9a-f]{32}$/.test(item.itemId)||item.regionId!==item.itemId||item.schemaVersion!==1
  ||item.identitySource!=="gemini_whole_image"||item.localizationSource!=="gemini_model_predicted"
  ||item.recognitionState!=="localized_observation"||item.geometrySpace!=="oriented_image"
  ||item.requiresConfirmation!==true||item.confidence!=null||!item.observedIdentity
  ||["guidance","modelKey","modelHotspots"].some(key=>Object.hasOwn(item,key)))return false;
 if(item.category==="Unknown")return true;
 // v5 permits an exact reviewed alias as evidence, but requires the canonical output name.
 return v5Catalog.get(item.itemName)===item.category && v5Identities.get(v5Normalize(item.observedIdentity))===item.itemName;
}
function v5SidecarAccepted(result,captureId) {
 const sidecar=result.categoryAssessments,owners=new Map(result.detectedItems.filter(v5RawOwner).map(i=>[i.itemId,i]));
 if(!sidecar||sidecar.schemaVersion!==1||sidecar.captureId!==captureId
  ||!["complete","unavailable","not_requested"].includes(sidecar.aiStatus)
  ||!Array.isArray(sidecar.items)||sidecar.items.length>8||sidecar.items.length>owners.size)return false;
 const seen=new Set();
 return sidecar.items.every(row=>{
  const owner=owners.get(row.itemId),gemini=owner?.analysisSource==="gemini_whole_image",vision=owner?.analysisSource==="google_vision_object_localization";
  if(!owner||seen.has(row.itemId)||row.requiresConfirmation!==true
   ||!["Biodegradable","Recyclable","Residual","Special Waste","Unknown"].includes(row.category)
   ||!Array.isArray(row.confirmationRequirements)||row.confirmationRequirements.length>4
   ||row.confirmationRequirements.some(s=>typeof s!=="string"||s.length>512))return false;
  seen.add(row.itemId);
  if(owner.category!=="Unknown"&&row.category!==owner.category)return false;
  if(row.assessmentSource==="ai_assisted")return (gemini||vision)&&sidecar.aiStatus==="complete"&&owner.category==="Unknown";
  if(row.assessmentSource==="reviewed_identity_rule")return gemini&&row.category!=="Unknown";
  if(row.assessmentSource==="insufficient_evidence")return gemini&&row.category==="Unknown";
  return row.assessmentSource==="existing_category"&&!gemini&&row.category===owner.category;
 });
}
for(const [raw,display] of [
 ["green compact powder","Green Container"],["gray compact powder","Gray Container"],
 ["white charger","White Charger"],["clear spray bottle","Clear Bottle"],
 ["bottled and jarred packaged goods","Container"],["yellow plastic bottle","Yellow Bottle"],
 ["long handled wooden spoon","Spoon"],["blue ballpoint pen with printed text","Blue Pen"],
 ["gray heavy duty hammer","Gray Hammer"],["wireless computer keyboard","Keyboard"],
 ["black USB charging cable","Black Cable"],["brown cardboard box","Brown Container"],
 ["red bottle with blue cap","Bottle"],["unidentified white shape","Item"],
 ["orange snack wrapper","Orange Wrapper"],["snack sachet","Packet"],
 ["green cosmetics case","Green Container"],["gray powder compact","Gray Container"],
 ["foil chocolate wrapper","Wrapper"],["blue plastic packet","Blue Packet"],
 ["possibly a glass bottle","Item"],["unlisted product name","Item"],[null,"Item"]
]) test(`short display: ${raw} -> ${display}`,()=>assert.equal(shortObjectName(raw),display));
function scene(labels) {
 const capture={captureId:crypto.randomUUID(),requestId:crypto.randomUUID()};
 return {capture,principal:42,items:whole.normalize(capture,{objects:labels.map((label,i)=>({label,box_2d:[100,10+i*120,900,70+i*120]}))}).objects};
}
test("display formatting is immutable and preserves raw evidence, IDs, geometry and primary/assessment contracts",()=>{
 const s=scene(["green compact powder","white charger","gray compact powder"]);
 const raw=JSON.parse(JSON.stringify(s.items));
 const result={itemName:"Original primary result",category:"Special Waste",captureId:s.capture.captureId,
  detectedItems:s.items,categoryAssessments:{schemaVersion:1,captureId:s.capture.captureId,items:deterministic(s.items)}};
 const formatted=withDisplayNames(result);
 assert.equal(formatted.itemName,result.itemName);assert.equal(formatted.category,result.category);
 assert.equal(formatted.categoryAssessments,result.categoryAssessments);
 assert.equal(formatted.detectedItems.length,3);assert.equal(new Set(formatted.detectedItems.map(i=>i.itemId)).size,3);
 for(let i=0;i<3;i++) {
  for(const key of Object.keys(s.items[i]).filter(key=>key!=="itemName"))assert.deepEqual(formatted.detectedItems[i][key],s.items[i][key]);
  assert.equal(formatted.detectedItems[i].originalItemName,s.items[i].itemName);
  assert.ok(formatted.detectedItems[i].itemName.split(" ").length<=3);
 }
 assert.deepEqual(s.items,raw);assert.deepEqual(withDisplayNames(formatted),formatted);
});

for(const name of ["Plastic Bottle","Used Battery","Snack Sachet"])test(`v5 known Gemini catalog name survives display formatting: ${name}`,()=>{
 const s=scene([name]),before=structuredClone(s.items[0]);
 const response={detectedItems:s.items,categoryAssessments:{schemaVersion:1,captureId:s.capture.captureId,
  aiStatus:"not_requested",items:deterministic(s.items)}};
 const formatted=withDisplayNames(response),item=formatted.detectedItems[0];
 assert.equal(item.itemName,name);assert.equal(item.originalItemName,name);assert.equal(v5RawOwner(item),true);
 assert.equal(v5SidecarAccepted(formatted,s.capture.captureId),true);
 for(const key of Object.keys(before))assert.deepEqual(item[key],before[key],key);
 assert.equal(formatted.categoryAssessments,response.categoryAssessments);assert.deepEqual(s.items[0],before);
 const oldBehavior={...formatted,detectedItems:[{...item,itemName:shortObjectName(name)}]};
 assert.equal(v5RawOwner(oldBehavior.detectedItems[0]),false);
 assert.equal(v5SidecarAccepted(oldBehavior,s.capture.captureId),false);
});

test("reviewed observed aliases retain canonical Gemini names without rewriting evidence",()=>{
 const s=scene(["plastic water bottle","AA battery","snack wrapper"]),raw=structuredClone(s.items);
 const formatted=withDisplayNames({detectedItems:s.items,categoryAssessments:{schemaVersion:1,captureId:s.capture.captureId,
  aiStatus:"not_requested",items:deterministic(s.items)}});
 assert.deepEqual(formatted.detectedItems.map(i=>i.itemName),["Plastic Bottle","Used Battery","Snack Sachet"]);
 assert.equal(v5SidecarAccepted(formatted,s.capture.captureId),true);
 assert.deepEqual(formatted.detectedItems.map(i=>i.observedIdentity),raw.map(i=>i.observedIdentity));
 assert.deepEqual(s.items,raw);
});

test("Vision known names and Unknown Gemini names retain compact formatting",()=>{
 for(const name of ["Plastic Bottle","Used Battery","Snack Sachet"]){
  const item=scene([name]).items[0];
  for(const variant of [{...item,analysisSource:"google_vision_object_localization",confidence:.8},{...item,category:"Unknown"}]){
   const formatted=withDisplayNames({detectedItems:[variant]}).detectedItems[0];
   assert.equal(formatted.itemName,shortObjectName(name));
   for(const key of Object.keys(variant).filter(key=>key!=="itemName"))assert.deepEqual(formatted[key],variant[key]);
  }
 }
});

test("a mismatched category, alias or unsupported observed identity is not blessed as a catalog result",()=>{
 const known=scene(["Plastic Bottle"]).items[0];
 for(const item of [{...known,category:"Special Waste"},{...known,itemName:"plastic bottle"},
  {...known,observedIdentity:"Chemical bottle"},{...known,category:"Future Category"}]){
  const formatted=withDisplayNames({detectedItems:[item]}).detectedItems[0];
  assert.equal(formatted.itemName,shortObjectName(item.itemName));assert.equal(formatted.category,item.category);
  assert.equal(v5RawOwner(formatted),false);
 }
});

test("known Gemini catalog formatting is idempotent without altering primary or sidecar",()=>{
 const s=scene(["Plastic Bottle","Used Battery","Snack Sachet"]);
 const response={itemName:"Original scene primary",category:"Special Waste",captureId:s.capture.captureId,
  detectedItems:s.items,categoryAssessments:{schemaVersion:1,captureId:s.capture.captureId,aiStatus:"not_requested",items:deterministic(s.items)}};
 const once=withDisplayNames(response);assert.deepEqual(withDisplayNames(once),once);
 assert.equal(once.itemName,response.itemName);assert.equal(once.category,response.category);
 assert.equal(once.captureId,response.captureId);assert.equal(once.categoryAssessments,response.categoryAssessments);
});

test("five mixed owners retain all v5 sidecar entries with Vision AI and Gemini reviewed sources",async()=>{
 const s=scene(["Plastic Bottle","Used Battery","Snack Sachet","white charger","Bottle"]);
 Object.assign(s.capture,{image:Buffer.from("ffd8ffc0000b080190025801011100ffd9","hex").toString("base64"),width:600,height:400,orientation:"upright"});
 s.items[3]={...s.items[3],analysisSource:"google_vision_object_localization",canonicalItem:"white charger",confidence:.8};
 const raw=structuredClone(s.items);let calls=0;
 const assess=createAssessmentService({env:{WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"true",
  CLOUD_RUN_AUTH_MODE:"iam",CLOUD_RUN_AUDIENCE:"https://synthetic.invalid",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste",
  WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"synthetic-offline-assessment-token-long-enough"},authHeaders:async()=>({}),transport:async(url,input)=>{
   calls++;return {schemaVersion:1,captureId:input.captureId,requestId:input.requestId,assessments:input.items.map(item=>({itemId:item.itemId,
    category:"Unknown",kind:"unknown",material:"unknown",condition:"unknown",evidence:"insufficient"})).reverse()};
  }});
 const sidecar=await assess(s),formatted=withDisplayNames({detectedItems:s.items,categoryAssessments:sidecar});
 assert.equal(calls,1);assert.equal(sidecar.aiStatus,"complete");assert.equal(v5SidecarAccepted(formatted,s.capture.captureId),true);
 assert.equal(formatted.detectedItems.length,5);assert.equal(sidecar.items.length,5);
 assert.equal(new Set(formatted.detectedItems.map(i=>i.itemId)).size,5);
 assert.deepEqual(sidecar.items.map(i=>i.category),["Recyclable","Special Waste","Residual","Special Waste","Unknown"]);
 assert.equal(sidecar.items[3].assessmentSource,"ai_assisted");
 assert.equal(sidecar.items[0].assessmentSource,"reviewed_identity_rule");
 assert.deepEqual(sidecar.items.map(i=>i.itemId),raw.map(i=>i.itemId));assert.deepEqual(s.items,raw);
 for(let i=0;i<5;i++)for(const key of Object.keys(raw[i]).filter(key=>key!=="itemName"))assert.deepEqual(formatted.detectedItems[i][key],raw[i][key]);
 assert.equal(v5SidecarAccepted({...formatted,categoryAssessments:{...sidecar,captureId:crypto.randomUUID()}},s.capture.captureId),false);
 assert.equal(v5SidecarAccepted({...formatted,categoryAssessments:{...sidecar,items:[...sidecar.items,sidecar.items[0]]}},s.capture.captureId),false);
});
test("every item gets an independent confirmation-required assessment from original evidence, not color/display type",async()=>{
 const s=scene(["used battery","banana peel","snack sachet","empty aluminum can","green compact powder","white charger","bottle","yellow bottle"]);
 let calls=0;
 const assess=createAssessmentService({env:{WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"},transport:async()=>{calls++;throw Error("Paid calls forbidden");}});
 const result=await assess(s);
 assert.equal(result.captureId,s.capture.captureId);assert.equal(result.schemaVersion,1);assert.equal(result.aiStatus,"not_requested");
 assert.deepEqual(result.items.map(i=>i.itemId),s.items.map(i=>i.itemId));
 assert.deepEqual(result.items.map(i=>i.category),["Special Waste","Biodegradable","Residual","Recyclable","Unknown","Special Waste","Unknown","Unknown"]);
 assert.ok(result.items.every(i=>i.requiresConfirmation===true));assert.equal(calls,0);
 assert.deepEqual(deterministic(withDisplayNames({detectedItems:s.items}).detectedItems),result.items);
 // A known Gemini catalog name must remain exact; an uncertain one stays compact.
 const both=scene(["plastic bottle","chemical bottle"]);
 assert.deepEqual(withDisplayNames({detectedItems:both.items}).detectedItems.map(i=>i.itemName),["Plastic Bottle","Bottle"]);
 assert.deepEqual(deterministic(both.items).map(i=>i.category),["Recyclable","Unknown"]);
});
test("production-default assessment-off stays off and cannot invoke a provider",async()=>{
 const assess=createAssessmentService({env:{},transport:async()=>{throw Error("Provider forbidden");}});
 assert.equal(await assess(scene(["white charger"])),null);
});
test("Vision evidence is retained when no original observedIdentity field exists",()=>{
 const item={itemId:"item_1",itemName:"brown jar with cap",canonicalItem:"brown jar with cap",category:"Unknown",
  analysisSource:"google_vision_object_localization",boundingBox:{left:0,top:0,right:1,bottom:1}};
 const display=withDisplayNames({detectedItems:[item]}).detectedItems[0];
 assert.equal(display.originalItemName,item.itemName);assert.equal(display.itemName,"Brown Container");
 assert.equal(display.observedIdentity,undefined);assert.equal(display.canonicalItem,item.canonicalItem);
});

test("generic placeholder uses explicit observation without changing underlying evidence",()=>{
 const item={itemId:"item_2",itemName:"Item",observedIdentity:"green makeup case",canonicalItem:"unresolved",category:"Unknown",boundingBox:{left:0,top:0,right:1,bottom:1}};
 const display=withDisplayNames({detectedItems:[item]}).detectedItems[0];
 assert.equal(display.itemName,"Green Container");assert.equal(display.originalItemName,"Item");
 assert.equal(display.observedIdentity,item.observedIdentity);assert.equal(display.canonicalItem,item.canonicalItem);
 assert.equal(display.category,"Unknown");assert.deepEqual(display.boundingBox,item.boundingBox);
 assert.equal(withDisplayNames({detectedItems:[display]}).detectedItems[0].itemName,"Green Container");
 for(const raw of ["unknown item","unidentified bottle","possibly a glass bottle","not a bottle"]){
  assert.equal(withDisplayNames({detectedItems:[{itemName:raw,observedIdentity:"green container"}]}).detectedItems[0].itemName,"Item");
 }
 assert.equal(withDisplayNames({detectedItems:[{itemName:"Item",observedIdentity:"green round shape"}]}).detectedItems[0].itemName,"Item");
});

test("specific capped beverage and wrapper suggestions keep strict v5 mixed-owner acceptance",async()=>{
 const s=scene(["plastic beverage bottle with cap","torn snack wrapper","Plastic Bottle","Item"]);
 Object.assign(s.capture,{image:Buffer.from("ffd8ffc0000b080190025801011100ffd9","hex").toString("base64"),width:600,height:400,orientation:"upright"});
 s.items[3]={...s.items[3],analysisSource:"google_vision_object_localization",canonicalItem:"item",confidence:.8};
 const original=structuredClone(s.items);let calls=0;
 const assess=createAssessmentService({env:{WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"true",
  CLOUD_RUN_AUTH_MODE:"iam",CLOUD_RUN_AUDIENCE:"https://synthetic.invalid",GEMINI_CLASSIFIER_URL:"https://synthetic.invalid/classify-waste",
  WASTE_ITEM_ASSESSMENT_SHARED_TOKEN:"synthetic-offline-assessment-token-long-enough"},authHeaders:async()=>({}),transport:async(url,input)=>{
   calls++;return {schemaVersion:1,requestId:input.requestId,captureId:input.captureId,assessments:input.items.map(i=>({itemId:i.itemId,
    category:"Unknown",kind:"unknown",material:"unknown",condition:"unknown",evidence:"insufficient"}))};
  }});
 const sidecar=await assess(s),response=withDisplayNames({detectedItems:s.items,categoryAssessments:sidecar});
 assert.equal(calls,1);assert.equal(v5SidecarAccepted(response,s.capture.captureId),true);
 assert.deepEqual(sidecar.items.map(i=>i.category),["Recyclable","Residual","Recyclable","Unknown"]);
 assert.deepEqual(sidecar.items.map(i=>i.assessmentSource),["reviewed_identity_rule","reviewed_identity_rule","reviewed_identity_rule","ai_assisted"]);
 assert.deepEqual(s.items,original);assert.equal(response.categoryAssessments,sidecar);
 assert.deepEqual(Object.keys(sidecar).sort(),["schemaVersion","captureId","aiStatus","items"].sort());
});

test("deduplicated simple aliases preserve strict v5 owners, sidecar count and selected-item geometry",async()=>{
 const c={captureId:crypto.randomUUID(),requestId:crypto.randomUUID(),image:Buffer.from("ffd8ffc0000b080190025801011100ffd9","hex").toString("base64"),width:600,height:400,orientation:"upright"};
 const raw=whole.normalize(c,{objects:[{label:"Container",box_2d:[100,100,500,300]},
  {label:"Clear bottle",box_2d:[112,106,512,306]},{label:"Snack Sachet",box_2d:[600,100,900,300]},
  {label:"Used Battery",box_2d:[600,500,900,700]}]}).objects;
 const {merge}=require("../services/wholeImageRecognitionService"),{samePhysicalObject}=require("../services/wasteAnalysisService");
 const items=merge([],raw,samePhysicalObject,c);
 const assess=createAssessmentService({env:{WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"}});
 const sidecar=await assess({capture:c,items,principal:5}),primary={itemName:"Original primary",category:"Residual"};
 const result=withDisplayNames({...primary,detectedItems:items,categoryAssessments:sidecar});
 assert.equal(items.length,3);assert.equal(sidecar.items.length,3);assert.equal(v5SidecarAccepted(result,c.captureId),true);
 assert.equal(result.itemName,primary.itemName);assert.equal(result.category,primary.category);
 for(const item of items) {
  const owner=raw.find(i=>i.itemId===item.itemId);assert.deepEqual(item.boundingBox,owner.boundingBox);
  assert.equal(item.category,owner.category);assert.equal(item.observedIdentity,owner.observedIdentity);
 }
});

test("scene-frame removal and identity suggestions keep strict v5 schema without mutating primary or detections",async()=>{
 const c={captureId:crypto.randomUUID(),requestId:crypto.randomUUID()},raw=whole.normalize(c,{objects:[
  {label:"Item",box_2d:[10,10,990,990]},{label:"Sheet of paper",box_2d:[100,100,300,300]},
  {label:"White charger",box_2d:[100,650,300,850]},{label:"Snack Sachet",box_2d:[650,100,850,300]},
  {label:"Banana Peel",box_2d:[650,650,850,850]}]}).objects;
 const {merge}=require("../services/wholeImageRecognitionService"),{samePhysicalObject}=require("../services/wasteAnalysisService");
 const items=merge([],raw,samePhysicalObject,c),before=structuredClone(items);
 const assess=createAssessmentService({env:{WASTE_ITEM_ASSESSMENT_ENABLED:"true",WASTE_ITEM_ASSESSMENT_AI_ENABLED:"false"}});
 const sidecar=await assess({capture:c,items,principal:5}),primary={itemName:"Original primary",category:"Special Waste"};
 const response=withDisplayNames({...primary,detectedItems:items,categoryAssessments:sidecar});
 assert.equal(items.length,4);assert.equal(sidecar.items.length,4);assert.equal(v5SidecarAccepted(response,c.captureId),true);
 assert.deepEqual(items,before);assert.equal(response.itemName,primary.itemName);assert.equal(response.category,primary.category);
 assert.equal(sidecar.items.filter(i=>i.category==="Special Waste").length,1);
 assert.ok(sidecar.items.every(i=>i.requiresConfirmation));
 assert.deepEqual(Object.keys(sidecar).sort(),["schemaVersion","captureId","aiStatus","items"].sort());
});
