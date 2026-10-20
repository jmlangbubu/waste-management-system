"use strict";
const shared=require("../gemini-waste-classifier-cloudrun/cropRecognition");
const crypto=require("node:crypto");
const whole=require("../gemini-waste-classifier-cloudrun/wholeImageRecognition");
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
function merge(vision,proposals,samePhysicalObject) {
  const retained=vision.slice(0,8).map(item=>({...item}));
  const ranked=proposals.map((item,index)=>({...item,index})).sort((a,b)=>Number(b.category!=="Unknown")-Number(a.category!=="Unknown")
    || b.itemName.split(" ").length-a.itemName.split(" ").length || a.index-b.index);
  for(const {index,...proposal} of ranked) {
    // Identity-only observations are carried separately, never promoted into localized cards.
    if(!proposal.boundingBox) continue;
    const match=retained.find(item=>samePhysicalObject(item,proposal));
    if(match) {
      if(match.analysisSource==="gemini_whole_image") continue;
      // Vision's box, ID and score remain authoritative. A safe identity suggestion is separate.
      // Observed identity remains useful without a supported disposal category.
      // Preserve the first (ranked) observation and all authoritative Vision data.
      if(!match.identityObservation) {
        match.identityObservation=proposal.itemName; match.identitySource="gemini_whole_image";
        match.requiresConfirmation=true;
      }
    } else if(retained.length<8) retained.push(proposal);
  }
  return retained;
}
module.exports={createDiscoveryService,discoverObjects:createDiscoveryService(),merge};
