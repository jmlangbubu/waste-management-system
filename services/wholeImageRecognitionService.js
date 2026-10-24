"use strict";
const shared=require("../gemini-waste-classifier-cloudrun/cropRecognition");
const crypto=require("node:crypto");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
const {unsafeIdentity,unreliablePhysicalIdentity,productStateVeto,automaticCategory}=require("./automaticWasteCategoryMapper");
function createDiscoveryService({env=process.env,transport=shared.postJson,budget=shared.createBudget(),authHeaders}={}) {
  const attempts=new Map();
  let authenticate=authHeaders;
  return async(input,{principal,signal}={})=>{
    if(env.WHOLE_IMAGE_DISCOVERY_ENABLED!=="true") throw new shared.RecognitionError("RECOGNITION_UNAVAILABLE",503);
    if(!/^[1-9][0-9]*$/.test(String(principal))) throw new shared.RecognitionError("RECOGNITION_UNAUTHORIZED",401);
    if(typeof env.WHOLE_IMAGE_DISCOVERY_SHARED_TOKEN!=="string" || env.WHOLE_IMAGE_DISCOVERY_SHARED_TOKEN.length<32)
      throw new shared.RecognitionError("RECOGNITION_UNAVAILABLE",503);
    const validated=whole.validateRequest(input); let url;
    try {url=new URL(env.GEMINI_WHOLE_IMAGE_URL || "discover-objects",env.GEMINI_CLASSIFIER_URL || env.CLOUD_RUN_GEMINI_CLASSIFIER_URL);
      if(url.protocol!=="https:" || url.username || url.password || url.search || url.hash) throw new Error();}
    catch(_){throw new shared.RecognitionError("RECOGNITION_UNAVAILABLE",503);}
    if(signal?.aborted) throw new shared.RecognitionError("RECOGNITION_CANCELLED",499);
    const now=Date.now();
    for(const [key,value] of attempts) if(value.expires<now) attempts.delete(key);
    const key=String(principal)+":"+validated.captureId;
    const fingerprint=crypto.createHash("sha256").update(validated.image).digest("hex");
    const previous=attempts.get(key);
    if(previous) {
      if(previous.fingerprint!==fingerprint) throw new shared.RecognitionError("INVALID_RECOGNITION_REQUEST",400);
      const result=await previous.pending; return {...result,requestId:validated.requestId};
    }
    if(attempts.size>=256) throw new shared.RecognitionError("RECOGNITION_BUSY",429);
    const release=budget.acquire(String(principal));
    const deadlineAt=Date.now()+whole.LIMITS.deadlineMs;
    const pending=(async()=>{
      try {const auth=env.CLOUD_RUN_AUTH_MODE
          ? await (authenticate ||= require("./cloudRunAuth").createCloudRunAuth({env}))(url.toString(),{signal,timeoutMs:deadlineAt-Date.now()}) : {};
        if(signal?.aborted || deadlineAt<=Date.now()) throw new shared.RecognitionError("RECOGNITION_CANCELLED",499);
        const response=await transport(url.toString(),validated,{signal,timeoutMs:deadlineAt-Date.now(),
        headers:{...auth,"X-Whole-Image-Token":env.WHOLE_IMAGE_DISCOVERY_SHARED_TOKEN}});
        return whole.validateResponse(validated,response);
      } finally {release();}
    })();
    // Store failed attempts too: a retry cannot repeatedly bill the same capture.
    attempts.set(key,{fingerprint,pending,expires:now+5*60*1000});
    return pending;
  };
}
const genericNames=new Set(["object","item","household object","household item","bottle","bottles","jar","jars",
  "container","can","packaging","packaged goods","bottled and jarred packaged goods",
  "packet","packets","sachet","sachets"]);
const identityKey=name=>String(name||"").trim().toLowerCase().replace(/[\s_-]+/g," ");
// Display refinement must never change the evidence used by later merge steps.
const physicalName=item=>identityKey(item.observedIdentity||item.originalItemName||item.canonicalItem||item.itemName);
const neutralIdentity=item=>/^(?:item|object|household item|household object|container)$/.test(physicalName(item));
const generic=item=>{
  const key=physicalName(item);
  const shapeOnly=key.replace(/\b(?:white|black|blue|green|red|yellow|brown|gray|grey|clear|small|large|round)\s+/g,"").trim();
  return genericNames.has(key)||genericNames.has(shapeOnly);
};
function alignedRegion(a,b) {
  const x=a.boundingBox,y=b.boundingBox;if(!x||!y)return false;
  const area=b=>(b.right-b.left)*(b.bottom-b.top);
  const intersection=Math.max(0,Math.min(x.right,y.right)-Math.max(x.left,y.left))
    *Math.max(0,Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top));
  return intersection/(area(x)+area(y)-intersection)>=.90
    && Math.abs((x.left+x.right-y.left-y.right)/2)<=.05*Math.min(x.right-x.left,y.right-y.left)
    && Math.abs((x.top+x.bottom-y.top-y.bottom)/2)<=.05*Math.min(x.bottom-x.top,y.bottom-y.top);
}
function compatibleIdentity(a,b) {
  const words=item=>physicalName(item).split(" ");
  const x=words(a),y=words(b);
  const materials=words=>new Set(words.filter(word=>/^(?:steel|aluminum|aluminium|glass|plastic|pet|hdpe)$/.test(word))
    .map(word=>word==="aluminium"?"aluminum":/^(?:pet|hdpe)$/.test(word)?"plastic":word));
  const mx=materials(x),my=materials(y);
  if(mx.size>1||my.size>1||(mx.size&&my.size&&[...mx][0]!==[...my][0]))return false;
  // Arbitrary extra words may describe batteries, mixed materials or contents.
  // Only exact originals or the bounded physical aliases below corroborate.
  if(physicalName(a)===physicalName(b))return true;
  // Physical aliases, NOT equal waste categories. Never strip adverse state.
  const family=item=>{
    const name=physicalName(item).replace(/^(?:(?:empty|discarded|clean|ordinary)\s+)+/,"");
    if(/^(?:can|tin can|steel food tin|food can|beverage can|drink can|soda can|alumin(?:um|ium) can|steel can|metal can)$/.test(name))return "can";
    if(/^(?:(?:plastic|pet|hdpe|glass)\s+)?(?:(?:water|drinking water|beverage|soda)\s+)?bottle$/.test(name))return "bottle";
    if(/^instant noodle (?:packet|wrapper|sachet)$/.test(name))return "noodle-wrapper";
    if(/^(?:snack|food|candy|chocolate|biscuit|chips)\s+(?:wrapper|sachet|packet)$/.test(name))return name;
    return null;
  };
  if(family(a)&&family(a)===family(b))return true;
  // Only simple, image-localized packaging aliases. Geometry, uniqueness,
  // capture ownership, hazardous-identity checks and category safeguards are
  // enforced separately by merge(); these names alone prove no category.
  const name=physicalName;
  const n=[name(a),name(b)];
  const broad=/^(?:packet|sachet|food packet|food sachet)$/;
  const specific=/^(?:(?:snack|food|instant noodle|coffee)\s+)(?:packet|sachet)$/;
  const forbidden=/\b(?:medicine|medication|medical|chemical|pesticide|hazard|unknown|unidentified|picture|printed|unopened|sealed|full|filled)\b/;
  return !n.some(label=>forbidden.test(label))
    && ((broad.test(n[0])&&specific.test(n[1]))||(broad.test(n[1])&&specific.test(n[0])));
}
const containerIdentity=item=>/\b(bottles?|jars?|containers?|cans?|cups?|box(?:es)?|bags?)\b/.test(physicalName(item));
// Server-only provenance; never add fields to Android's strict discovery schema.
const classificationEvidence=new WeakMap();
const evidenceSnapshot=item=>JSON.stringify([item.itemId,item.category,item.canonicalItem,item.observedIdentity,
  item.originalItemName,item.analysisSource,item.boundingBox,item.captureId,item.confidence]);
function alignedIdentity(item,captureId) {
  const evidence=classificationEvidence.get(item);
  return evidence && !evidence.conflict && evidence.captureId===captureId && evidence.snapshot===evidenceSnapshot(item)
    ? evidence.identity : null;
}
function identityConflict(item,captureId) {
  const evidence=classificationEvidence.get(item);
  return !!(evidence?.conflict && evidence.captureId===captureId && evidence.snapshot===evidenceSnapshot(item));
}
function belongsToCapture(item,capture) {
  if(item.captureId!==undefined && item.captureId!==capture.captureId)return false;
  const b=item.boundingBox;
  const rebuilt=whole.normalize(capture,{objects:[{label:item.observedIdentity,
    box_2d:[b.top,b.left,b.bottom,b.right].map(n=>Math.round(n*1000))}]}).objects[0];
  return rebuilt.itemId===item.itemId;
}
function merge(vision,proposals,samePhysicalObject,capture,hasNormalizationConflict=()=>false) {
  const retained=[];
  const currentObservation=item=>{
    if(!capture?.captureId)return true; // Legacy callers have no discovery capture.
    const r=item.boundingBox;
    return ["gemini_whole_image","google_vision_object_localization"].includes(item.analysisSource)
      && (item.captureId===undefined || item.captureId===capture.captureId)
      && r && Object.keys(r).sort().join(",")==="bottom,left,right,top"
      && [r.left,r.top,r.right,r.bottom].every(n=>typeof n==="number"&&Number.isFinite(n)&&n>=0&&n<=1)
      && r.left<r.right && r.top<r.bottom
      && (item.analysisSource!=="gemini_whole_image" || belongsToCapture(item,capture));
  };
  // Additional correspondence is geometry-only reconciliation of simple aliases,
  // never permission to refine identity or transfer a category. Both observations
  // must be trusted, unconfirmed and independently localized in this capture.
  const nearAlias=(a,b)=>{
    if(!capture?.captureId || [a,b].some(item=>item.confirmed || item.category!=="Unknown"
        || !["gemini_whole_image","google_vision_object_localization"].includes(item.analysisSource)
        || (item.captureId!==undefined && item.captureId!==capture.captureId)))return false;
    const valid=item=>{
      const r=item.boundingBox;
      return r && [r.left,r.top,r.right,r.bottom].every(n=>typeof n==="number"&&Number.isFinite(n)&&n>=0&&n<=1)
        && r.left<r.right && r.top<r.bottom && (item.analysisSource!=="gemini_whole_image" || belongsToCapture(item,capture));
    };
    if(!valid(a)||!valid(b))return false;
    const shape=item=>identityKey(item.observedIdentity||item.originalItemName||item.canonicalItem)
      .replace(/^(?:black|white|red|green|blue|yellow|gray|grey|clear|transparent)\s+/,"");
    const names=[shape(a),shape(b)];
    const neutral=name=>["item","object","household item","household object"].includes(name);
    const simple=name=>["container","bottle","jar"].includes(name);
    // A neutral observation may describe the same container, including a
    // cosmetic container. This is geometry-only suppression, NOT safe contents
    // evidence or permission to transfer the other observation's category.
    const neutralContainer=names.some(neutral) && names.every((name,index)=>neutral(name)||containerIdentity([a,b][index]));
    if(!neutralContainer && (!names.every(simple)
        || (names[0]!==names[1]&&!names.includes("container"))))return false;
    if([a,b].some(unsafeIdentity) && !neutralContainer)return false;
    const x=a.boundingBox,y=b.boundingBox,area=r=>(r.right-r.left)*(r.bottom-r.top);
    const contains=(p,q)=>p.left<=q.left&&p.top<=q.top&&p.right>=q.right&&p.bottom>=q.bottom;
    const intersection=Math.max(0,Math.min(x.right,y.right)-Math.max(x.left,y.left))
      *Math.max(0,Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top));
    const close=(p,q)=>Math.min(p,q)/Math.max(p,q)>=.95;
    // Near-equal extents may contain one another due to localization rounding.
    // A genuine smaller nested object must never take this path.
    if((contains(x,y)||contains(y,x)) &&
        (Math.min(x.right-x.left,y.right-y.left)/Math.max(x.right-x.left,y.right-y.left)<.98
        || Math.min(x.bottom-x.top,y.bottom-y.top)/Math.max(x.bottom-x.top,y.bottom-y.top)<.98))return false;
    return intersection/(area(x)+area(y)-intersection)>=.85
      && close(x.right-x.left,y.right-y.left)&&close(x.bottom-x.top,y.bottom-y.top)
      && Math.abs((x.left+x.right-y.left-y.right)/2)<=.04*Math.min(x.right-x.left,y.right-y.left)
      && Math.abs((x.top+x.bottom-y.top-y.bottom)/2)<=.04*Math.min(x.bottom-x.top,y.bottom-y.top);
  };
  const all=vision.concat(proposals);
  const related=(a,b)=>currentObservation(a)&&currentObservation(b)&&(samePhysicalObject(a,b)||nearAlias(a,b));
  const uniqueAlias=(a,b)=>nearAlias(a,b)&&!all.some(other=>other.itemId!==a.itemId&&other.itemId!==b.itemId
    &&(related(a,other)||related(b,other)));
  const matchesRegion=(a,b)=>currentObservation(a)&&currentObservation(b)&&(samePhysicalObject(a,b)||uniqueAlias(a,b));
  // Multiple descriptions may corroborate one physical owner, but multiple
  // localized Vision owners or a bridging/competing region are still ambiguous.
  const corroboratedGroup=(owner,proposal)=>{
    if(!capture?.captureId || !currentObservation(owner)||!currentObservation(proposal)
        || !alignedRegion(owner,proposal)||!samePhysicalObject(owner,proposal))return false;
    const group=all.filter(item=>item.itemId===owner.itemId||item.itemId===proposal.itemId
      || related(item,owner)||related(item,proposal));
    if(group.filter(item=>item.analysisSource==="google_vision_object_localization").length>1
        || group.some(item=>!currentObservation(item)||item.confirmed
          || all.filter(other=>other.itemId===item.itemId).length!==1
          || !alignedRegion(owner,item)||!samePhysicalObject(owner,item)
          || hasNormalizationConflict(item)
          || unsafeIdentity({...item,category:"Unknown"})||unreliablePhysicalIdentity({...item,category:"Unknown"})))return false;
    const specific=group.filter(item=>!neutralIdentity(item));
    if(!specific.length || specific.some((item,i)=>specific.slice(i+1).some(other=>!compatibleIdentity(item,other)))
        || group.some(item=>physicalName(item)==="container")&&!specific.every(containerIdentity))return false;
    const categories=specific.map(item=>automaticCategory({...item,category:"Unknown"})).filter(Boolean);
    if(!categories.length||new Set(categories).size!==1)return false;
    const anchor=specific.find(item=>automaticCategory({...item,category:"Unknown"})===categories[0]);
    // Use the established catalog anchor, but let EVERY original observation
    // veto explicit adverse state. An alias alone grants no contents/material facts.
    if(group.some(item=>productStateVeto(anchor,categories[0],physicalName(item))))return false;
    return !all.some(other=>!group.includes(other)&&group.some(item=>related(item,other)));
  };
  // Trust a unique current pair or strictly corroborating physical group. Unknown is
  // not physical uncertainty; use the established identity predicate on the
  // original evidence, including for already-categorized observations.
  const trustedCorrespondence=(owner,proposal)=>currentObservation(owner)&&currentObservation(proposal)
    && [owner,proposal].every(item=>all.filter(other=>other.itemId===item.itemId).length===1
      && !unreliablePhysicalIdentity({...item,category:"Unknown"}))
    && (!all.some(other=>other.itemId!==owner.itemId && other.itemId!==proposal.itemId
      && (related(other,owner)||related(other,proposal))) || corroboratedGroup(owner,proposal));
  // An exact neutral observation supplies no contradictory physical identity.
  // Preserve supported can/bottle suggestions and established exact biological/
  // special-waste identities against a unique, tightly aligned neutral label.
  // This cannot grant a category, clear a prior conflict, or erase adverse state.
  const neutralCorrespondence=(owner,proposal)=>{
    const mapped=automaticCategory({...owner,category:"Unknown"});
    const established=["Biodegradable","Special Waste"].includes(owner.category)&&mapped===owner.category;
    const ordinary=/\b(?:can|bottle)\b/.test(physicalName(owner))&&mapped==="Recyclable"
      && !unsafeIdentity({...owner,category:"Unknown"});
    return !!capture?.captureId
    && proposal.analysisSource==="gemini_whole_image" && proposal.category==="Unknown"
    && neutralIdentity(proposal)
    && (ordinary || established&&physicalName(proposal)!=="container")
    && !unsafeIdentity(proposal)
    && alignedRegion(owner,proposal) && trustedCorrespondence(owner,proposal);
  };
  // An exact generic Can observation adds no contrary contents evidence to a
  // uniquely localized Paint Can. Never extend this exception to other hazards,
  // nearby/nested regions, stale captures, or a third competing observation.
  const paintCanRefinement=(a,b)=>{
    const names=[a,b].map(item=>identityKey(item.observedIdentity));
    return !!capture?.captureId && [a,b].every(item=>item.analysisSource==="gemini_whole_image"
      && item.category==="Unknown" && !item.confirmed && currentObservation(item))
      && names.includes("can") && names.includes("paint can")
      && alignedRegion(a,b) && samePhysicalObject(a,b)
      && !all.some(other=>other.itemId!==a.itemId && other.itemId!==b.itemId
        && (related(other,a)||related(other,b)));
  };
  const recordConflict=item=>{
    // A catalog category cannot exempt this physical owner from adverse evidence.
    if(capture?.captureId && currentObservation(item))classificationEvidence.set(item,
      {captureId:capture.captureId,conflict:true,snapshot:evidenceSnapshot(item)});
  };
  // The initial list can itself contain conflicting observations of one region.
  // Keep the survivor's entire ID/geometry/evidence contract, never synthesize a box.
  for(const item of vision) {
    const matches=retained.filter(other=>matchesRegion(other,item));
    const index=matches.length===1?retained.indexOf(matches[0]):-1;
    if(index<0) {if(retained.length<8){const owner={...item};retained.push(owner);
      if(hasNormalizationConflict(item))recordConflict(owner);}continue;}
    const match=retained[index];
    if(paintCanRefinement(match,item)) {
      if(identityKey(item.observedIdentity)==="paint can")retained[index]={...item};
      continue;
    }
    if(!samePhysicalObject(match,item)) {
      if(unsafeIdentity(match)||unsafeIdentity(item))recordConflict(match);
      continue;
    }
    if(!compatibleIdentity(match,item) || unsafeIdentity(match)!==unsafeIdentity(item)) {
      if(!match.confirmed && match.category==="Unknown" && item.category==="Unknown"
          && ((containerIdentity(item) && !containerIdentity(match))
            || (generic(match) && !generic(item) && unsafeIdentity(item)))) retained[index]={...item};
      retained[index].requiresConfirmation=true;
      recordConflict(retained[index]);
    }
  }
  // Broad taxonomy phrases are not specific just because they contain more words.
  const ranked=proposals.map((item,index)=>({...item,index})).sort((a,b)=>Number(b.category!=="Unknown")-Number(a.category!=="Unknown")
    || Number(containerIdentity(b))-Number(containerIdentity(a))
    || Number(generic(a))-Number(generic(b)) || a.index-b.index);
  for(const {index,...proposal} of ranked) {
    // Identity-only observations are carried separately, never promoted into localized cards.
    if(!proposal.boundingBox) continue;
    const matches=retained.filter(item=>matchesRegion(item,proposal));
    // Never choose the first of multiple possible physical regions.
    if(matches.length>1)continue;
    const match=matches[0];
    if(match) {
      if(!samePhysicalObject(match,proposal)) {
        if(unsafeIdentity(match)||unsafeIdentity(proposal))recordConflict(match);
        continue;
      }
      const neutral=neutralCorrespondence(match,proposal)
        || neutralIdentity(proposal)&&corroboratedGroup(match,proposal);
      if(match.analysisSource==="gemini_whole_image") {
        if(paintCanRefinement(match,proposal))continue;
        if(!neutral && (!compatibleIdentity(match,proposal) || unsafeIdentity(match)!==unsafeIdentity(proposal))) {
          match.requiresConfirmation=true;
          if(capture?.captureId && proposal.analysisSource==="gemini_whole_image" && belongsToCapture(proposal,capture))recordConflict(match);
        }
        continue;
      }
      // Catalog-supported broad physical classes (Bottle/Can) can contradict
      // another identity; only neutral/taxonomic descriptions lack that evidence.
      const observations=ranked.filter(item=>!neutralIdentity(item)
        &&(!generic(item)||automaticCategory({...item,category:"Unknown"}))
        &&alignedRegion(match,item)&&samePhysicalObject(match,item));
      const conflicting=observations.some((item,i)=>observations.slice(i+1).some(other=>!compatibleIdentity(item,other)
        && ((!generic(item)&&!generic(other))
          || (automaticCategory({...item,category:"Unknown"})&&automaticCategory({...other,category:"Unknown"})))));
      const broad=generic(match) && !/\b(bottles?|jars?|cans?|cups?|bags?|box(?:es)?)\b/.test(identityKey(match.itemName));
      const identityMismatch=(!neutral && !broad && !compatibleIdentity(match,proposal))
        || unsafeIdentity(match)!==unsafeIdentity(proposal);
      // Can/Bottle/Container are broad but valid physical classes. Unlike Item
      // or a scene taxonomy, they may establish a unique localized identity.
      const supportedPhysical=!!automaticCategory({...proposal,category:"Unknown"});
      if(capture?.captureId && (conflicting || identityMismatch) && belongsToCapture(proposal,capture)) {
        classificationEvidence.set(match,{captureId:capture.captureId,conflict:true,snapshot:evidenceSnapshot(match)});
      }
      if(conflicting) {match.requiresConfirmation=true;continue;}
      if(capture?.captureId && match.category==="Unknown" && !match.confirmed
          && proposal.analysisSource==="gemini_whole_image" && (!generic(proposal)||supportedPhysical)
          && alignedRegion(match,proposal) && vision.filter(item=>samePhysicalObject(item,proposal)).length===1
          && !identityMismatch && trustedCorrespondence(match,proposal) && !identityConflict(match,capture.captureId)) {
        classificationEvidence.set(match,{captureId:capture.captureId,identity:proposal.observedIdentity,
          snapshot:evidenceSnapshot(match)});
      }
      // Refine only a generic, unconfirmed Vision identity with uniquely aligned evidence.
      // Do not transfer categories/scores or regenerate IDs or geometry.
      const refined=match.analysisSource==="google_vision_object_localization" && proposal.analysisSource==="gemini_whole_image"
          && match.category==="Unknown" && !match.confirmed
          && generic(match) && (!generic(proposal) || supportedPhysical && capture?.captureId
            && trustedCorrespondence(match,proposal) && !identityMismatch && !identityConflict(match,capture.captureId))
          && alignedRegion(match,proposal)
          && (!containerIdentity(match) || compatibleIdentity(match,proposal))
          && vision.filter(item=>samePhysicalObject(item,proposal)).length===1;
      const physicalIdentity=match.category==="Unknown" && !match.confirmed && !generic(match)
        && alignedRegion(match,proposal) && containerIdentity(proposal) && !containerIdentity(match)
        && vision.filter(item=>samePhysicalObject(item,proposal)).length===1;
      if(refined || physicalIdentity) match.itemName=proposal.itemName;
      if(!match.identityObservation || refined || physicalIdentity) {
        match.identityObservation=proposal.itemName; match.identitySource="gemini_whole_image";
        match.requiresConfirmation=true;
      }
    } else if(retained.length<8) retained.push(proposal);
  }
  // A known Vision suggestion must not discard a uniquely corresponding Gemini
  // observation that the product is still unopened/full. This can only veto a
  // stream, never grant a category or replace the localized owner identity.
  for(const owner of retained) {
    if(!capture?.captureId || owner.analysisSource!=="google_vision_object_localization"
        || owner.confirmed
        || !currentObservation(owner))continue;
    const physicalName=item=>identityKey(item.analysisSource==="gemini_whole_image"
      ? item.observedIdentity : item.originalItemName||item.observedIdentity||item.canonicalItem);
    const safe=item=>!unsafeIdentity({...item,category:"Unknown"})
      && !unreliablePhysicalIdentity({...item,category:"Unknown"});
    const base=item=>({...item,itemName:physicalName(item).replace(/^(?:(?:unopened|sealed|full|filled|empty|opened|discarded)\s+)+/,"")});
    const candidates=proposals.filter(proposal=>proposal.analysisSource==="gemini_whole_image"
      && currentObservation(proposal) && !proposal.confirmed && safe(owner) && safe(proposal)
      && /^(?:unopened|sealed|full|filled|empty|discarded)\s+/.test(physicalName(proposal))
      && /\b(?:packet|sachet|wrapper|packag(?:e|ed|ing)|pouch|bottle|container|jar|can)\b/.test(physicalName(proposal))
      && alignedRegion(owner,proposal) && samePhysicalObject(owner,proposal)
      && compatibleIdentity(base(owner),base(proposal))
      && trustedCorrespondence(owner,proposal));
    if(candidates.length!==1)continue;
    const prior=classificationEvidence.get(owner);
    // Keep state evidence even if it cannot grant any positive category.
    classificationEvidence.set(owner,{captureId:capture.captureId,identity:candidates[0].observedIdentity,
      conflict:!!prior?.conflict,snapshot:evidenceSnapshot(owner)});
  }
  for(const owner of retained) {
    let evidence=classificationEvidence.get(owner);
    const aligned=alignedIdentity(owner,capture?.captureId);
    // Classify only this uniquely matched, capture-bound physical owner. This
    // is deterministic original recognition evidence, not an optional AI
    // category response, scene-primary label or shortened display name.
    if(capture?.captureId && owner.analysisSource==="google_vision_object_localization"
        && owner.category==="Unknown" && aligned && !owner.confirmed
        && !identityConflict(owner,capture.captureId) && !unsafeIdentity(owner)) {
      // A valid corroborating alias must not erase the owner's independently
      // supported original identity just because the alias is not a catalog key.
      const mapped=automaticCategory({...owner,observedIdentity:aligned})||automaticCategory(owner);
      if(mapped && !productStateVeto(owner,mapped,aligned)) {
        owner.category=mapped;owner.requiresConfirmation=true;
        evidence={...evidence,snapshot:evidenceSnapshot(owner)};
        classificationEvidence.set(owner,evidence);
      }
    }
    const conflictingStream=identityConflict(owner,capture?.captureId);
    if(!conflictingStream && !productStateVeto(owner,owner.category,aligned))continue;
    owner.category="Unknown";
    owner.requiresConfirmation=true;
    for(const field of ["guidance","modelKey","modelHotspots","explanation","action","warning"])delete owner[field];
    // Snapshot after downgrade; copying the public result later must not be
    // used to recover or manufacture private cross-provider provenance.
    if(evidence)classificationEvidence.set(owner,{...evidence,snapshot:evidenceSnapshot(owner)});
  }
  // Keep the discovery v1 mobile contract intact; assessments travel separately.
  // A frame-sized generic Gemini proposal is scene/background evidence only
  // when three separate small physical regions corroborate a spread-out scene.
  // Never remove a named large object, a single object, or a nested cluster.
  return retained.filter(item=>{
    const b=item.boundingBox,area=r=>(r.right-r.left)*(r.bottom-r.top);
    if(!capture?.captureId || item.analysisSource!=="gemini_whole_image" || item.category!=="Unknown" || item.confirmed
        || !/^(?:item|object|household item|household object)$/.test(identityKey(item.observedIdentity))
        || !b || b.left>.02 || b.top>.02 || b.right<.98 || b.bottom<.98 || area(b)<.90
        || !belongsToCapture(item,capture))return true;
    const small=retained.filter(other=>{
      const r=other.boundingBox;
      return other!==item && r && other.analysisSource==="gemini_whole_image" && belongsToCapture(other,capture)
        && !/^(?:item|object|household item|household object)$/.test(identityKey(other.observedIdentity))
        && r.left>=b.left && r.top>=b.top && r.right<=b.right && r.bottom<=b.bottom
        && area(r)<=.12*area(b) && r.right-r.left<=.4*(b.right-b.left) && r.bottom-r.top<=.4*(b.bottom-b.top);
    });
    const separate=(x,y)=>x.right<=y.left||y.right<=x.left||x.bottom<=y.top||y.bottom<=x.top;
    for(let i=0;i<small.length;i++)for(let j=i+1;j<small.length;j++)for(let k=j+1;k<small.length;k++) {
      const regions=[small[i],small[j],small[k]].map(other=>other.boundingBox);
      if(!separate(regions[0],regions[1])||!separate(regions[0],regions[2])||!separate(regions[1],regions[2]))continue;
      const xs=regions.map(r=>(r.left+r.right)/2),ys=regions.map(r=>(r.top+r.bottom)/2);
      if(Math.max(...xs)-Math.min(...xs)>=.4*(b.right-b.left) && Math.max(...ys)-Math.min(...ys)>=.4*(b.bottom-b.top))return false;
    }
    return true;
  });
}
module.exports={createDiscoveryService,discoverObjects:createDiscoveryService(),merge,alignedIdentity,identityConflict};
