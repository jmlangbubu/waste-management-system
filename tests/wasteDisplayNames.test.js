"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {shortObjectName,withDisplayNames}=require("../services/wasteDisplayNameService");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
const {createAssessmentService,deterministic}=require("../services/perItemWasteAssessmentService");
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
 // Identical display names do not imply identical disposal categories.
 const both=scene(["plastic bottle","bottle"]);
 assert.deepEqual(withDisplayNames({detectedItems:both.items}).detectedItems.map(i=>i.itemName),["Bottle","Bottle"]);
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
