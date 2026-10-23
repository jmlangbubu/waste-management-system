"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {automaticCategory,unsafeProviderEvidence}=require("../services/automaticWasteCategoryMapper");
const box={left:.1,top:.2,right:.6,bottom:.8};
function item(label,src="gemini_whole_image",extra={}) {return {analysisSource:src,category:"Unknown",boundingBox:box,
 ...(src==="gemini_whole_image" ? {observedIdentity:label,recognitionState:"localized_observation"}:{originalItemName:label,canonicalItem:label.toLowerCase(),itemName:"Item"}),...extra};}
for(const [label,category] of [
 // Approved exact common-object suggestions; explicit adverse cues below
 // remain negative. This does not assert material composition.
 ["Bottle","Recyclable"],["Clear bottle",null],["Plastic bottle","Recyclable"],
 ["plastic water bottle","Recyclable"],["glass bottle","Recyclable"],["PET container",null],
 ["empty aluminum can","Recyclable"],["cardboard","Recyclable"],["clean dry paper","Recyclable"],
 ["green snack wrapper",null],["foil chocolate wrapper",null],["snack sachet","Residual"],
 ["empty plastic water bottle","Recyclable"],["empty snack wrapper","Residual"],
 ["banana peel","Biodegradable"],["vegetable scraps","Biodegradable"],["leaves","Biodegradable"],
 ["White Charger","Special Waste"],["power adapter","Special Waste"],["battery","Special Waste"],
 ["Bottle of bleach",null],["chemical bottle",null],["pesticide bottle",null],["spray paint can",null],
 ["motor oil bottle",null],["contaminated plastic bottle",null],["medicine bottle",null],
 ["green container",null],["gray container",null],["Item",null],["plastic-looking object",null],
 ["possibly a glass bottle",null],["generic bottle",null],["printed picture of battery",null],
 ["food scraps","Biodegradable"],["paper","Recyclable"],["packet",null],["used tissue","Residual"],["soap",null],
 ["box of batteries",null],["plastic bag",null],["spray bottle",null]
])test(`identity ${label} => ${category??"Unknown"}`,()=>{
 assert.equal(automaticCategory(item(label)),category);
 assert.equal(automaticCategory(item(label,"google_vision_object_localization")),category);
});
test("does not classify shortened Android Item or arbitrary primary source",()=>{
 assert.equal(automaticCategory(item("plastic bottle","local_mapper_fallback")),null);
 assert.equal(automaticCategory(item("Item","google_vision_object_localization",{itemName:"Plastic Bottle"})),null);
 assert.equal(automaticCategory(item("plastic bottle","gemini_whole_image",{recognitionState:"unlocalized_observation"})),null);
 assert.equal(automaticCategory(item("plastic bottle","gemini_whole_image",{boundingBox:null})),null);
 assert.equal(automaticCategory(item("plastic bottle","gemini_whole_image",{category:"Special Waste"})),null);
});
test("provider hazard/contamination evidence vetoes recycling suggestion",()=>{
 assert.equal(unsafeProviderEvidence({kind:"electrical",material:"mixed",condition:"unknown",evidence:"visible"},"Recyclable"),true);
 assert.equal(unsafeProviderEvidence({kind:"single_material",material:"mixed",condition:"unknown",evidence:"visible"},"Recyclable"),true);
 assert.equal(unsafeProviderEvidence({kind:"single_material",material:"unknown",condition:"contaminated_nonhazardous",evidence:"visible"},"Recyclable"),true);
 assert.equal(unsafeProviderEvidence({kind:"single_material",material:"unknown",condition:"unknown",evidence:"insufficient"},"Recyclable"),false);
});

test("narrow beverage/cap and food-wrapper phrasing uses original identities without shape or brand expansion",()=>{
 for(const source of ["gemini_whole_image","google_vision_object_localization"]) {
  // A cap/opening/tear does not establish removal of contents; preserve the
  // original phrases rather than adding empty evidence to make them positive.
  for(const [label,expected] of [["plastic beverage bottle with cap",null],["water bottle with cap",null],["empty PET water bottle with a screw cap","Recyclable"]])
   assert.equal(automaticCategory(item(label,source)),expected,label);
  for(const [label,expected] of [["torn snack wrapper",null],["opened snack sachet",null],["empty candy packet","Residual"]])
   assert.equal(automaticCategory(item(label,source)),expected,label);
  for(const label of ["Bottle with cap","Green bottle with cap","plastic bottle with cap","C2 tea beverage",
   "bottle-shaped container","red wrapper","torn packet","opened item","printed picture of torn snack wrapper",
   "possibly a water bottle with cap","medicine water bottle with cap","contaminated beverage bottle with cap"])
   assert.equal(automaticCategory(item(label,source)),null,label);
 }
});
