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
  "confidence": 0.0,
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

  const category = normalizeCategory(parsed.category);

  if (!isValidCategory(category)) {
    return null;
  }

  const defaults = buildDefaultDetails(category);

  const itemName = String(parsed.itemName || parsed.item || category).trim() || category;

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
      temperature: 0.1,
      topP: 0.8,
      topK: 40,
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
      source: "gemini_vision",
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
