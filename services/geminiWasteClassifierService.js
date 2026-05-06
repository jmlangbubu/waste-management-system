const https = require("https");

const GEMINI_HOST = "generativelanguage.googleapis.com";

function safeEnv(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function getGeminiApiKey() {
  return (
    safeEnv(process.env.GEMINI_API_KEY) ||
    safeEnv(process.env.GOOGLE_GEMINI_API_KEY) ||
    safeEnv(process.env.GOOGLE_API_KEY)
  );
}

function getModelCandidates() {
  const preferredModel = safeEnv(process.env.GEMINI_MODEL || "gemini-2.5-flash");

  const fallbackModels = [
    preferredModel,
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash"
  ];

  return [...new Set(fallbackModels.filter(Boolean))];
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

  if (!clean) return "";

  if (
    clean.includes("recyclable") ||
    clean.includes("recycle") ||
    clean.includes("recycling")
  ) {
    return "Recyclable";
  }

  if (
    clean.includes("biodegradable") ||
    clean.includes("organic") ||
    clean.includes("compost") ||
    clean.includes("compostable")
  ) {
    return "Biodegradable";
  }

  if (
    clean.includes("special") ||
    clean.includes("hazardous") ||
    clean.includes("e waste") ||
    clean.includes("ewaste") ||
    clean.includes("electronic") ||
    clean.includes("battery") ||
    clean.includes("chemical") ||
    clean.includes("medical")
  ) {
    return "Special Waste";
  }

  if (
    clean.includes("residual") ||
    clean.includes("general waste") ||
    clean.includes("trash") ||
    clean.includes("garbage") ||
    clean.includes("landfill") ||
    clean.includes("non recyclable") ||
    clean.includes("nonrecyclable")
  ) {
    return "Residual";
  }

  return "";
}

function inferCategoryFromText(text) {
  const clean = normalizeText(text);

  if (!clean) return "";

  const specialKeywords = [
    "battery",
    "batteries",
    "charger",
    "wire",
    "wires",
    "bulb",
    "lamp",
    "electronic",
    "electronics",
    "phone",
    "medicine",
    "chemical",
    "paint",
    "syringe",
    "needle",
    "medical",
    "hazardous",
    "e waste",
    "ewaste"
  ];

  const biodegradableKeywords = [
    "banana peel",
    "fruit peel",
    "vegetable",
    "food scrap",
    "food scraps",
    "leftover food",
    "leaves",
    "leaf",
    "grass",
    "plant",
    "organic",
    "compost",
    "biodegradable"
  ];

  const recyclableKeywords = [
    "plastic bottle",
    "pet bottle",
    "water bottle",
    "beverage bottle",
    "drink bottle",
    "coke bottle",
    "sprite bottle",
    "c2 bottle",
    "plastic container",
    "glass bottle",
    "can",
    "tin can",
    "aluminum can",
    "paper",
    "cardboard",
    "carton",
    "metal",
    "recyclable"
  ];

  const residualKeywords = [
    "sachet",
    "wrapper",
    "candy wrapper",
    "chips wrapper",
    "dirty plastic",
    "styrofoam",
    "diaper",
    "used tissue",
    "tissue",
    "contaminated",
    "residual"
  ];

  if (specialKeywords.some((keyword) => clean.includes(keyword))) {
    return "Special Waste";
  }

  if (recyclableKeywords.some((keyword) => clean.includes(keyword))) {
    return "Recyclable";
  }

  if (biodegradableKeywords.some((keyword) => clean.includes(keyword))) {
    return "Biodegradable";
  }

  if (residualKeywords.some((keyword) => clean.includes(keyword))) {
    return "Residual";
  }

  return "";
}

function isValidCategory(category) {
  return ["Biodegradable", "Recyclable", "Residual", "Special Waste"].includes(category);
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

function buildGeminiPrompt() {
  return `
You are a waste classification assistant for a municipal waste management system.

Analyze the image and classify the MAIN visible waste item into exactly one category:

1. Biodegradable
2. Recyclable
3. Residual
4. Special Waste

Important rules:
- A plastic beverage bottle, water bottle, C2 bottle, Coke bottle, Sprite bottle, PET bottle, plastic container, clean bottle, or drink bottle is Recyclable.
- Do not classify a plastic bottle as Biodegradable just because the label contains fruit, leaves, apple, tea, or natural graphics.
- Food scraps, banana peel, fruit peel, vegetable waste, leaves, grass, and organic waste are Biodegradable.
- Sachets, candy wrappers, chips wrappers, dirty plastic wrappers, styrofoam, diapers, used tissue, and contaminated packaging are Residual.
- Batteries, chargers, bulbs, wires, electronics, medicine, chemicals, paint, syringes, and hazardous items are Special Waste.
- Focus on the physical object, not only the brand label, logo, or printed design.
- If the image shows a bottle with a food or fruit label, classify based on the bottle material, not the label design.
- If uncertain, choose the safest category and explain the uncertainty.

Return JSON only with this exact shape:
{
  "itemName": "short name of detected item",
  "category": "Biodegradable | Recyclable | Residual | Special Waste",
  "confidence": 0.75,
  "explanation": "simple explanation",
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

  const allText = [];

  candidates.forEach((candidate) => {
    const parts = candidate?.content?.parts;

    if (Array.isArray(parts)) {
      parts.forEach((part) => {
        if (part?.text) {
          allText.push(part.text);
        }
      });
    }
  });

  return allText.join("\n").trim();
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

function sanitizeGeminiResult(parsed, rawText = "") {
  if (!parsed || typeof parsed !== "object") {
    const inferredFromRaw = inferCategoryFromText(rawText);

    if (!inferredFromRaw) {
      return null;
    }

    const defaults = buildDefaultDetails(inferredFromRaw);

    return {
      itemName: inferredFromRaw,
      category: inferredFromRaw,
      confidence: 0.65,
      explanation: defaults.explanation,
      action: defaults.action,
      warning: defaults.warning
    };
  }

  const combinedText = [
    parsed.category,
    parsed.itemName,
    parsed.item,
    parsed.detectedObject,
    parsed.explanation,
    parsed.action,
    rawText
  ]
    .filter(Boolean)
    .join(" ");

  let category = normalizeCategory(parsed.category);

  if (!category) {
    category = inferCategoryFromText(combinedText);
  }

  if (!isValidCategory(category)) {
    return null;
  }

  const defaults = buildDefaultDetails(category);

  const itemName =
    String(
      parsed.itemName ||
        parsed.item ||
        parsed.detectedObject ||
        parsed.object ||
        category
    ).trim() || category;

  let confidence = Number(parsed.confidence);

  if (Number.isNaN(confidence)) {
    confidence = 0.75;
  }

  if (confidence > 1) {
    confidence = confidence / 100;
  }

  confidence = Math.max(0, Math.min(1, confidence));

  return {
    itemName,
    category,
    confidence,
    explanation: String(parsed.explanation || defaults.explanation).trim(),
    action: String(parsed.action || defaults.action).trim(),
    warning: String(parsed.warning || defaults.warning).trim()
  };
}

function buildGeminiRequestBody(cleanedBase64) {
  return {
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
      temperature: 0.1,
      topP: 0.8,
      topK: 40,
      maxOutputTokens: 700,
      responseMimeType: "application/json"
    }
  };
}

async function tryClassifyWithModel({ apiKey, model, cleanedBase64 }) {
  const body = buildGeminiRequestBody(cleanedBase64);

  console.log("[Gemini] Trying model:", model);

  const response = await requestGeminiJson({
    apiKey,
    model,
    body
  });

  const text = extractGeminiText(response);
  const parsed = parseJsonFromGeminiText(text);
  const result = sanitizeGeminiResult(parsed, text);

  console.log("[Gemini] Raw text:", text || "[empty]");
  console.log("[Gemini] Parsed JSON:", parsed);
  console.log("[Gemini] Sanitized result:", result);

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
    source: "gemini_vision",
    model,
    result,
    rawResponse: response,
    rawText: text
  };
}

async function classifyWasteWithGemini(base64Image) {
  const apiKey = getGeminiApiKey();
  const cleanedBase64 = cleanBase64Image(base64Image);
  const modelCandidates = getModelCandidates();

  if (!apiKey) {
    console.error("[Gemini] Missing API key. Add GEMINI_API_KEY in Render Environment.");
    return {
      success: false,
      message: "GEMINI_API_KEY is missing in environment variables.",
      result: null
    };
  }

  if (!cleanedBase64) {
    console.error("[Gemini] No image provided.");
    return {
      success: false,
      message: "No image provided to Gemini classifier.",
      result: null
    };
  }

  console.log("[Gemini] Starting image classification.");
  console.log("[Gemini] Image length:", cleanedBase64.length);
  console.log("[Gemini] Model candidates:", modelCandidates.join(", "));

  let lastErrorMessage = "";

  for (const model of modelCandidates) {
    try {
      const classification = await tryClassifyWithModel({
        apiKey,
        model,
        cleanedBase64
      });

      if (classification.success) {
        console.log("[Gemini] Classification success with model:", model);
        return classification;
      }

      lastErrorMessage = classification.message || "Invalid Gemini result.";
      console.warn("[Gemini] Model returned invalid result:", model, lastErrorMessage);
    } catch (error) {
      lastErrorMessage = error.message || "Gemini request failed.";

      console.error("[Gemini] Classification failed for model:", model);
      console.error("[Gemini] Error:", lastErrorMessage);

      if (error.response) {
        console.error("[Gemini] Error response:", JSON.stringify(error.response, null, 2));
      }

      /*
        Continue to next model for model/version errors.
        For quota/auth errors, retrying another model usually won't help,
        but continuing is harmless and gives clearer logs.
      */
    }
  }

  return {
    success: false,
    message: lastErrorMessage || "All Gemini model attempts failed.",
    result: null
  };
}

module.exports = {
  classifyWasteWithGemini,
  cleanBase64Image,
  normalizeCategory
};
