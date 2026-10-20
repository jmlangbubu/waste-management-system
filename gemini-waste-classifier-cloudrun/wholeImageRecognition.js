"use strict";
// Optional discovery only. Reuses crop transport, authentication primitives and budgets.
const crypto = require("node:crypto");
const shared = require("./cropRecognition");
const LIMITS = Object.freeze({ items: 8, bytes: 2 * 1024 * 1024, jsonBytes: 3 * 1024 * 1024,
  dimension: 2048, deadlineMs: 12000, providerMs: 10000 });
const fail = () => { throw new shared.RecognitionError("INVALID_PROVIDER_RESPONSE", 502); };
const record = x => x !== null && typeof x === "object" && !Array.isArray(x);
const only = (x, keys) => record(x) && Object.keys(x).every(key => keys.includes(key));
const uuid = x => typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
function validateRequest(input) {
  const bad = () => { throw new shared.RecognitionError("INVALID_RECOGNITION_REQUEST", 400); };
  if (!only(input,["requestId","captureId","image","width","height","orientation"]) || !uuid(input.requestId) || !uuid(input.captureId)
      || input.orientation !== "upright" || !Number.isInteger(input.width) || !Number.isInteger(input.height)
      || input.width < 1 || input.height < 1 || input.width > LIMITS.dimension || input.height > LIMITS.dimension
      || typeof input.image !== "string" || input.image.length > 4*Math.ceil(LIMITS.bytes/3)
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.image) || input.image.length%4) bad();
  const bytes=Buffer.from(input.image,"base64");
  if (!bytes.length || bytes.length>LIMITS.bytes || bytes.toString("base64")!==input.image
      || bytes[0]!==255 || bytes[1]!==216 || bytes[2]!==255) bad();
  // The Android encoder strips EXIF by re-encoding the oriented bitmap. Reject APP1 metadata
  // rather than trusting a contradictory rotation declaration from another client.
  let position=2;
  while(position+4<=bytes.length && bytes[position]===255) {
    const marker=bytes[position+1]; if(marker===0xda || marker===0xd9) break;
    const length=bytes.readUInt16BE(position+2); if(length<2 || position+2+length>bytes.length) bad();
    if(marker===0xe1) bad(); position+=length+2;
  }
  const dimensions=shared.imageDimensions(bytes,"image/jpeg");
  if(!dimensions || dimensions.width!==input.width || dimensions.height!==input.height) bad();
  return { requestId:input.requestId,captureId:input.captureId,image:input.image,width:input.width,height:input.height,orientation:"upright" };
}
// Gemini's documented convention: [ymin,xmin,ymax,xmax], integer coordinates 0..1000.
function box(value) {
  if(!Array.isArray(value) || value.length!==4 || !value.every(x=>Number.isInteger(x) && x>=0 && x<=1000)) return null;
  const [top,left,bottom,right]=value;
  if(top>=bottom || left>=right) return null;
  return {left:left/1000,top:top/1000,right:right/1000,bottom:bottom/1000};
}
function name(value) {
  if(typeof value!=="string" || !value.trim() || value.length>128 || /[\x00-\x1f<>]/.test(value)) return "";
  return value.trim();
}
function id(input,label,bounds) {
  return "region_"+crypto.createHash("sha256").update(JSON.stringify([input.captureId,label.toLowerCase(),bounds])).digest("hex").slice(0,32);
}
function normalize(input,provider) {
  if(!only(provider,["objects"]) || !Array.isArray(provider.objects) || provider.objects.length>LIMITS.items) fail();
  const items=[];
  for(const object of provider.objects) {
    if(!only(object,["label","box_2d"])) fail();
    const label=name(object.label); if(!label) fail();
    const bounds=box(object.box_2d), supported=shared.matchIdentity(label);
    const itemName=supported?.itemName || (/^(ballpen|ballpoint pen|pen)$/i.test(label)?"Ballpoint Pen":label);
    items.push({itemId:id(input,itemName,bounds),regionId:id(input,itemName,bounds),itemName,observedIdentity:label,
      canonicalItem:supported?.itemName.toLowerCase() || itemName.toLowerCase(),category:supported?.category || "Unknown",
      analysisSource:"gemini_whole_image",identitySource:"gemini_whole_image",localizationSource:bounds?"gemini_model_predicted":"none",
      recognitionState:bounds?"localized_observation":"identity_only",requiresConfirmation:true,
      geometrySpace:"oriented_image",schemaVersion:1,...(bounds?{boundingBox:bounds}:{})});
  }
  return {success:true,requestId:input.requestId,captureId:input.captureId,objects:items};
}
function geminiBody(input) {
  return {contents:[{role:"user",parts:[{text:
    "Find up to eight independently visible physical household objects, including small pens and packaging. "
    +"Do not describe printed pictures, logos, text or imagined/occluded objects as separate objects. "
    +"Use short, specific image-supported object identities; do not infer unobservable materials. "
    +"Return objects with label and, only when localized, box_2d as [ymin,xmin,ymax,xmax], integers normalized 0..1000 in the upright supplied image. "
    +"Omit box_2d if localization is uncertain. Do not return confidence, categories or disposal advice."},
    {inlineData:{mimeType:"image/jpeg",data:input.image}}]}],generationConfig:{temperature:0,responseMimeType:"application/json",maxOutputTokens:2048,
      thinkingConfig:{thinkingBudget:0},responseSchema:{type:"OBJECT",required:["objects"],properties:{objects:{type:"ARRAY",maxItems:8,
        items:{type:"OBJECT",required:["label"],properties:{label:{type:"STRING"},box_2d:{type:"ARRAY",items:{type:"INTEGER"},minItems:4,maxItems:4}}}}}}}};
}
function validateResponse(input,response) {
  if(!only(response,["success","requestId","captureId","objects"]) || response.success!==true || response.requestId!==input.requestId
      || response.captureId!==input.captureId || !Array.isArray(response.objects) || response.objects.length>8) fail();
  // Reconstruct at Render; never trust remote categories, confidence or normalization.
  const provider={objects:response.objects.map(item=>{
    if(!record(item) || Object.keys(item).some(k=>!["itemId","regionId","itemName","observedIdentity","canonicalItem","category","analysisSource","identitySource","localizationSource","recognitionState","requiresConfirmation","geometrySpace","schemaVersion","boundingBox"].includes(k))) fail();
    const b=item.boundingBox;
    if(b && (!only(b,["left","top","right","bottom"]) || ![b.top,b.left,b.bottom,b.right].every(n=>typeof n==="number" && Number.isFinite(n) && n>=0 && n<=1))) fail();
    return {label:item.observedIdentity,...(b?{box_2d:[b.top,b.left,b.bottom,b.right].map(n=>Math.round(n*1000))}:{})};
  })};
  const rebuilt=normalize(input,provider);
  const ordered=value=>Array.isArray(value)?value.map(ordered):record(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
  if(JSON.stringify(ordered(response.objects))!==JSON.stringify(ordered(rebuilt.objects))) fail();
  return rebuilt;
}
function createCloudHandler({env=process.env,transport=shared.postJson,budget=shared.createBudget()}={}) {
  return async(req,res)=>{
    const scope=shared.httpScope(req,res,{deadlineMs:LIMITS.deadlineMs}); let release;
    try {
      if(env.WHOLE_IMAGE_DISCOVERY_ENABLED!=="true" || !env.GEMINI_API_KEY || typeof env.WHOLE_IMAGE_DISCOVERY_SHARED_TOKEN!=="string"
          || env.WHOLE_IMAGE_DISCOVERY_SHARED_TOKEN.length<32) throw new shared.RecognitionError("RECOGNITION_UNAVAILABLE",503);
      if(!shared.tokenMatches(req.get("X-Whole-Image-Token"),env.WHOLE_IMAGE_DISCOVERY_SHARED_TOKEN)) throw new shared.RecognitionError("RECOGNITION_UNAUTHORIZED",401);
      const input=validateRequest(req.body); release=budget.acquire("backend");
      // Schema is verified against this model family only; other models require separate validation.
      const model=env.WHOLE_IMAGE_DISCOVERY_MODEL || "gemini-2.5-flash";
      if(model!=="gemini-2.5-flash") throw new shared.RecognitionError("RECOGNITION_UNAVAILABLE",503);
      const response=await transport(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,geminiBody(input),
        {signal:scope.signal,timeoutMs:Math.min(LIMITS.providerMs,scope.deadlineAt-Date.now()),headers:{"x-goog-api-key":env.GEMINI_API_KEY}});
      const result=normalize(input,shared.parseGemini(response)); if(!scope.signal.aborted) res.json(result);
    } catch(error) {if(!scope.signal.aborted){const safe=shared.errorResponse(error);res.status(safe.status).json(safe.body);}}
    finally {release?.();scope.dispose();}
  };
}
module.exports={LIMITS,validateRequest,box,normalize,validateResponse,geminiBody,createCloudHandler};
