const https = require("https");

const GEMINI_HOST = "generativelanguage.googleapis.com";

function safeEnv(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function cleanBase64Image(base64Image) {
  if (!base64Image || typeof base64Image !== "string") {
    return "";
  }

  return base64Image
    .replace(/^data:image\/\w+;base64,/i, "")
    .replace(/\s/g, "")
    .trim();
}

function normalizeText(value) {
  if (value === null || value === undefined) return "";

  return String(value)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCategory(category) {
  const clean = normalizeText(category);

  if (clean.includes("recyclable")) return "Recyclable";
  if (clean.includes("biodegradable")) return "Biodegradable";
  if (clean.includes("special")) return "Special Waste";
  if (clean.includes("hazardous")) return "Special Waste";
  if (clean.includes("residual")) return "Residual";

  return "";
}

function isValidCategory(category) {
  return ["Biodegradable", "Recyclable", "Residual", "Special Waste"].includes(category);
}

function includesAny(text, keywords = []) {
  const clean = normalizeText(text);

  return keywords.some((keyword) => clean.includes(normalizeText(keyword)));
}

function clampConfidence(value, fallback = 0.55) {
  let confidence = Number(value);

  if (Number.isNaN(confidence)) {
    confidence = fallback;
  }

  if (confidence > 1) {
    confidence = confidence / 100;
  }

  return Math.max(0, Math.min(1, confidence));
}

function buildDefaultDetails(category) {
  switch (category) {
    case "Biodegradable":
      return {
        explanation:
          "This item appears to be organic or compostable waste such as food scraps, fruit or vegetable waste, leaves, or other natural materials.",
        action:
          "Place it in the biodegradable waste bin or composting area. Keep it separate from plastic, metal, glass, and hazardous items.",
        warning:
          "Do not mix biodegradable waste with plastic wrappers, sachets, bottles, cans, batteries, chemicals, or other non-biodegradable materials."
      };

    case "Recyclable":
      return {
        explanation:
          "This item appears to be recyclable because it is likely a clean plastic, glass, metal, paper, carton, cardboard, bottle, can, or reusable container material.",
        action:
          "Place it in the recyclable waste bin. Empty and clean the item first if possible.",
        warning:
          "If the item is heavily contaminated with food, grease, oil, or chemicals, it may no longer be suitable for recycling."
      };

    case "Special Waste":
      return {
        explanation:
          "This item appears to require special handling because it may be electronic, electrical, chemical, medical, hazardous, or regulated waste.",
        action:
          "Do not place it in ordinary waste bins. Bring it to the proper special waste, hazardous waste, e-waste, or collection point.",
        warning:
          "Improper disposal of special waste may harm people, equipment, and the environment."
      };

    case "Residual":
    default:
      return {
        explanation:
          "This item appears to be residual waste because it is not clearly biodegradable, recyclable, or special waste.",
        action:
          "Place it in the residual waste bin. Avoid mixing it with recyclable, biodegradable, or special waste items.",
        warning:
          "This may be a fallback result if the item was unclear, blurred, contaminated, or not confidently detected."
      };
  }
}

function buildUnclearMaterialDetails(itemName) {
  return {
    itemName,
    category: "Recyclable",
    confidence: 0.42,
    explanation:
      "A bottle or container is visible, but the material is not clear enough to confidently identify it as glass, plastic, metal, or paper-based.",
    action:
      "Retake the photo with the item centered, closer, and well-lit. Show the body material clearly before disposal.",
    warning:
      "The system should not guess the exact material. Do not treat this as a confirmed plastic or glass result."
  };
}

function buildDirtyPaperCupDetails() {
  return {
    itemName: "used or contaminated paper cup",
    category: "Residual",
    confidence: 0.78,
    explanation:
      "The item appears to be a used paper cup or coated paper cup. Used, wet, stained, or plastic-coated paper cups are usually not accepted as clean paper recycling.",
    action:
      "Place it in the residual waste bin unless your local facility specifically accepts clean paper cups.",
    warning:
      "Paper cups can be misleading because many have plastic lining. If it has liquid, food stain, or plastic coating, do not place it with clean paper recyclables."
  };
}

function buildGeminiPrompt() {
  return `
You are a waste classification assistant for a municipal waste management system.

Analyze the image and classify ONLY the MAIN visible waste item into exactly one category:

1. Biodegradable
2. Recyclable
3. Residual
4. Special Waste

CRITICAL ACCURACY RULES:
- Focus on the physical waste item and its material. Do not rely only on brand name, logo, printed fruit, color, or label design.
- Do NOT guess the exact material. If the object is a bottle, cup, container, or wrapper, identify the material first.
- A bottle is NOT automatically plastic. A bottle can be glass, plastic/PET, metal, or unclear.
- Only call it "plastic bottle" if the bottle body clearly looks plastic/PET.
- Only call it "glass bottle" if the bottle body clearly looks glass, rigid, shiny/reflective, or transparent glass.
- If a bottle is visible but the material is unclear, return itemName "bottle - material unclear", category "Recyclable", confidence 0.45 or lower, and tell the user to retake a clearer photo.
- If the image shows a brand such as Magnolia, Coke, Sprite, C2, McDo, or any drink brand, classify based on the material of the container, not the brand.
- A plastic beverage bottle, water bottle, PET bottle, clear plastic bottle, or clean plastic container is Recyclable.
- A clean glass bottle or glass jar is Recyclable.
- A clean metal can or aluminum can is Recyclable.
- Food scraps, banana peel, fruit peel, vegetable waste, leaves, grass, and organic waste are Biodegradable.
- Sachets, candy wrappers, chips wrappers, dirty plastic wrappers, styrofoam, diapers, used tissue, and contaminated packaging are Residual.
- Batteries, chargers, bulbs, wires, electronics, medicine, chemicals, paint, syringes, and hazardous items are Special Waste.

PAPER CUP RULES:
- A clean and dry paper cup can be Recyclable only if it appears paper-based and not dirty.
- A used paper cup, wet paper cup, cup with drink residue, stained cup, greasy cup, or plastic-coated paper cup should be Residual.
- If unsure whether the paper cup is coated or contaminated, mention the uncertainty and use lower confidence.

OUTPUT QUALITY RULES:
- The explanation must mention visible evidence for the material, for example: "clear glass body", "plastic/PET body", "paper cup", "metal can", "food residue", or "dirty wrapper".
- Do not say "plastic bottle" in itemName unless the explanation also gives visible plastic/PET evidence.
- If the image is blurry, too far, partially covered, or the material is unclear, do not force a specific material. Use a low confidence and ask for a clearer photo.
- Confidence should be high only when the object and material are clearly visible.

Return JSON only with this exact shape:
{
  "itemName": "short name of detected item",
  "category": "Biodegradable | Recyclable | Residual | Special Waste",
  "confidence": 0.0,
  "explanation": "simple explanation that includes visible material evidence",
  "action": "recommended disposal action",
  "warning": "important warning"
}
`;
}

function requestGeminiJson({ apiKey, model, body }) {
  return new Promise((resolve, reject) => {
    const bodyString = JSON.stringify(body);

    const path = `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const options = {
      hostname: GEMINI_HOST,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyString)
      },
      timeout: 30000
    };

    const req = https.request(options, (res) => {
      let rawData = "";

      res.on("data", (chunk) => {
        rawData += chunk;
      });

      res.on("end", () => {
        let parsed = null;

        try {
          parsed = rawData ? JSON.parse(rawData) : {};
        } catch (_) {
          parsed = { raw: rawData };
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`Gemini request failed with status ${res.statusCode}`);
          error.statusCode = res.statusCode;
          error.response = parsed;
          return reject(error);
        }

        resolve(parsed);
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error("Gemini request timed out."));
    });

    req.on("error", (error) => {
      reject(error);
    });

    req.write(bodyString);
    req.end();
  });
}

function extractGeminiText(response) {
  const candidates = response?.candidates;

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return "";
  }

  const parts = candidates[0]?.content?.parts;

  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => part?.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseJsonFromGeminiText(text) {
  if (!text) return null;

  let cleaned = String(text).trim();

  cleaned = cleaned
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    console.error("[Gemini] Failed to parse JSON:", error.message);
    console.error("[Gemini] Raw text:", text);
    return null;
  }
}

function sanitizeGeminiResult(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  let category = normalizeCategory(parsed.category);

  if (!isValidCategory(category)) {
    return null;
  }

  const rawItemName = String(parsed.itemName || parsed.item || category).trim() || category;
  const rawExplanation = String(parsed.explanation || "").trim();
  const rawAction = String(parsed.action || "").trim();
  const rawWarning = String(parsed.warning || "").trim();

  const itemClean = normalizeText(rawItemName);
  const explanationClean = normalizeText(rawExplanation);
  const combinedClean = normalizeText(`${rawItemName} ${rawExplanation} ${rawAction} ${rawWarning}`);

  let confidence = clampConfidence(parsed.confidence, 0.55);

  const bottleTerms = ["bottle", "jar"];
  const genericBottleTerms = [
    "bottle",
    "drink bottle",
    "beverage bottle",
    "clean bottle",
    "empty bottle",
    "container bottle"
  ];

  const visiblePlasticEvidenceTerms = [
    "plastic body",
    "pet body",
    "pet bottle",
    "plastic bottle body",
    "clear plastic",
    "transparent plastic",
    "thin plastic",
    "flexible plastic",
    "squeezable",
    "crumpled plastic",
    "plastic container"
  ];

  const visibleGlassEvidenceTerms = [
    "glass body",
    "glass bottle",
    "clear glass",
    "transparent glass",
    "rigid glass",
    "shiny glass",
    "reflective glass",
    "glass jar"
  ];

  const paperCupTerms = [
    "paper cup",
    "mcdo cup",
    "mcdonalds cup",
    "mcdonald s cup",
    "fast food cup",
    "drink cup"
  ];

  const dirtyCupTerms = [
    "used",
    "dirty",
    "wet",
    "stained",
    "greasy",
    "oily",
    "food residue",
    "drink residue",
    "liquid residue",
    "contaminated",
    "plastic coated",
    "coated paper",
    "wax coated"
  ];

  const hasBottle = includesAny(itemClean, bottleTerms);
  const isGenericBottle =
    genericBottleTerms.includes(itemClean) ||
    (hasBottle &&
      !includesAny(itemClean, ["plastic", "pet", "glass", "metal", "aluminum", "steel"]));

  const saysPlasticBottle = includesAny(itemClean, ["plastic bottle", "pet bottle"]);
  const saysGlassBottle = includesAny(itemClean, ["glass bottle", "glass jar"]);
  const hasPlasticEvidence = includesAny(explanationClean, visiblePlasticEvidenceTerms);
  const hasGlassEvidence = includesAny(explanationClean, visibleGlassEvidenceTerms);

  /*
    Guard 1:
    Do not allow a generic "bottle" result to pretend that the exact material is known.
    Keep the valid category, but lower the confidence and ask for clearer material evidence.
  */
  if (isGenericBottle) {
    const unclear = buildUnclearMaterialDetails("bottle - material unclear");

    return {
      ...unclear,
      confidence: Math.min(confidence, unclear.confidence)
    };
  }

  /*
    Guard 2:
    If Gemini says plastic bottle but gives no visible plastic/PET evidence,
    downgrade the item name to material unclear instead of showing a wrong specific result.
  */
  if (saysPlasticBottle && !hasPlasticEvidence) {
    const unclear = buildUnclearMaterialDetails("bottle - material unclear");

    return {
      ...unclear,
      confidence: Math.min(confidence, unclear.confidence),
      warning:
        "The AI tried to identify this as plastic, but the response did not include enough visible plastic/PET evidence. Retake the photo to confirm the material."
    };
  }

  /*
    Guard 3:
    If Gemini says glass bottle but gives no visible glass evidence,
    keep it cautious instead of confidently showing a material-specific result.
  */
  if (saysGlassBottle && !hasGlassEvidence) {
    const unclear = buildUnclearMaterialDetails("bottle - material unclear");

    return {
      ...unclear,
      confidence: Math.min(confidence, unclear.confidence),
      warning:
        "The AI tried to identify this as glass, but the response did not include enough visible glass evidence. Retake the photo to confirm the material."
    };
  }

  /*
    Guard 4:
    Paper cups are often coated or contaminated. If the result contains used/dirty/coated context,
    Residual is safer than clean paper recycling.
  */
  if (includesAny(combinedClean, paperCupTerms) && includesAny(combinedClean, dirtyCupTerms)) {
    const dirtyPaperCup = buildDirtyPaperCupDetails();

    return {
      ...dirtyPaperCup,
      confidence: Math.min(Math.max(confidence, 0.65), dirtyPaperCup.confidence)
    };
  }

  const defaults = buildDefaultDetails(category);

  let itemName = rawItemName;

  /*
    Small item-name cleanup for common cases.
    This improves display without changing the core category.
  */
  if (saysPlasticBottle) {
    itemName = "plastic bottle";
    category = "Recyclable";
  } else if (saysGlassBottle) {
    itemName = itemClean.includes("jar") ? "glass jar" : "glass bottle";
    category = "Recyclable";
  } else if (includesAny(itemClean, ["paper cup"])) {
    itemName = "paper cup";
  }

  return {
    itemName,
    category,
    confidence,
    explanation: rawExplanation || defaults.explanation,
    action: rawAction || defaults.action,
    warning: rawWarning || defaults.warning
  };
}

async function classifyWasteWithGemini(base64Image) {
  const apiKey = safeEnv(process.env.GEMINI_API_KEY);
  const model = safeEnv(process.env.GEMINI_MODEL || "gemini-2.5-flash");
  const cleanedBase64 = cleanBase64Image(base64Image);

  if (!apiKey) {
    return {
      success: false,
      message: "GEMINI_API_KEY is missing in environment variables.",
      result: null
    };
  }

  if (!cleanedBase64) {
    return {
      success: false,
      message: "No image provided to Gemini classifier.",
      result: null
    };
  }

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: buildGeminiPrompt()
          },
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: cleanedBase64
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.05,
      topP: 0.7,
      topK: 20,
      responseMimeType: "application/json"
    }
  };

  console.log("[Gemini] Starting image classification.");
  console.log("[Gemini] Model:", model);
  console.log("[Gemini] Image length:", cleanedBase64.length);

  try {
    const response = await requestGeminiJson({
      apiKey,
      model,
      body
    });

    const text = extractGeminiText(response);
    const parsed = parseJsonFromGeminiText(text);
    const result = sanitizeGeminiResult(parsed);

    console.log("[Gemini] Raw text:", text);
    console.log("[Gemini] Parsed result:", result);

    if (!result) {
      return {
        success: false,
        message: "Gemini returned an invalid waste classification result.",
        result: null,
        rawResponse: response,
        rawText: text
      };
    }

    return {
      success: true,
      source: "gemini_vision_material_checked",
      result,
      rawResponse: response,
      rawText: text
    };
  } catch (error) {
    console.error("[Gemini] Classification failed:", error.message);

    if (error.response) {
      console.error("[Gemini] Error response:", error.response);
    }

    return {
      success: false,
      message: error.message,
      result: null
    };
  }
}

module.exports = {
  classifyWasteWithGemini,
  cleanBase64Image,
  normalizeCategory
};
