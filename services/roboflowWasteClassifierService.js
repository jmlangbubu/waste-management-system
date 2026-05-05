const https = require("https");

const ROBOFLOW_API_HOST = "serverless.roboflow.com";

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

function normalizeClassName(value) {
  if (!value) return "";

  return String(value)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildRoboflowPath() {
  const apiKey = safeEnv(process.env.ROBOFLOW_API_KEY);
  const modelId = safeEnv(process.env.ROBOFLOW_MODEL_ID || "ai-waste-classifier");
  const version = safeEnv(process.env.ROBOFLOW_VERSION || "1");
  const confidence = safeEnv(process.env.ROBOFLOW_CONFIDENCE || "0.25");
  const overlap = safeEnv(process.env.ROBOFLOW_OVERLAP || "0.30");

  if (!apiKey) {
    throw new Error("ROBOFLOW_API_KEY is missing in environment variables.");
  }

  if (!modelId) {
    throw new Error("ROBOFLOW_MODEL_ID is missing in environment variables.");
  }

  if (!version) {
    throw new Error("ROBOFLOW_VERSION is missing in environment variables.");
  }

  const query = new URLSearchParams({
    api_key: apiKey,
    confidence,
    overlap,
    format: "json",
    image_type: "base64",
    max_detections: "10",
    disable_active_learning: "true",
    source: "ai-waste-management-system"
  });

  return `/${encodeURIComponent(modelId)}/${encodeURIComponent(version)}?${query.toString()}`;
}

function requestJson({ path, body, contentType = "application/json" }) {
  return new Promise((resolve, reject) => {
    const bodyString = typeof body === "string" ? body : JSON.stringify(body);

    const options = {
      hostname: ROBOFLOW_API_HOST,
      path,
      method: "POST",
      headers: {
        "Content-Type": contentType,
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
        } catch (parseError) {
          parsed = {
            raw: rawData
          };
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(
            `Roboflow request failed with status ${res.statusCode}`
          );
          error.statusCode = res.statusCode;
          error.response = parsed;
          return reject(error);
        }

        return resolve(parsed);
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error("Roboflow request timed out."));
    });

    req.on("error", (error) => {
      reject(error);
    });

    req.write(bodyString);
    req.end();
  });
}

function flattenPredictions(response) {
  if (!response || typeof response !== "object") {
    return [];
  }

  if (Array.isArray(response.predictions)) {
    return response.predictions;
  }

  if (Array.isArray(response.outputs)) {
    const predictions = [];

    for (const output of response.outputs) {
      if (Array.isArray(output?.predictions)) {
        predictions.push(...output.predictions);
      }

      if (Array.isArray(output?.model_predictions)) {
        predictions.push(...output.model_predictions);
      }
    }

    return predictions;
  }

  if (Array.isArray(response.model_predictions)) {
    return response.model_predictions;
  }

  return [];
}

function normalizePrediction(prediction) {
  if (!prediction || typeof prediction !== "object") {
    return null;
  }

  const className =
    prediction.class ||
    prediction.class_name ||
    prediction.label ||
    prediction.name ||
    "";

  const confidence =
    typeof prediction.confidence === "number"
      ? prediction.confidence
      : typeof prediction.class_confidence === "number"
      ? prediction.class_confidence
      : 0;

  const normalizedClass = normalizeClassName(className);

  if (!normalizedClass) {
    return null;
  }

  return {
    className: normalizedClass,
    rawClassName: className,
    confidence,
    x: prediction.x ?? null,
    y: prediction.y ?? null,
    width: prediction.width ?? null,
    height: prediction.height ?? null,
    detectionId: prediction.detection_id || prediction.detectionId || null,
    raw: prediction
  };
}

function getBestPrediction(predictions = []) {
  const normalized = predictions
    .map(normalizePrediction)
    .filter(Boolean)
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));

  return normalized.length > 0 ? normalized[0] : null;
}

async function classifyWasteWithRoboflow(base64Image) {
  const cleanedBase64 = cleanBase64Image(base64Image);

  if (!cleanedBase64) {
    return {
      success: false,
      message: "No image provided to Roboflow classifier.",
      predictions: [],
      bestPrediction: null
    };
  }

  const path = buildRoboflowPath();

  console.log("[Roboflow] Starting inference.");
  console.log("[Roboflow] Model path:", path.replace(/api_key=[^&]+/i, "api_key=***"));
  console.log("[Roboflow] Image length:", cleanedBase64.length);

  /*
    Primary request format for Serverless Hosted API:
    JSON body with base64 image.
  */
  try {
    const response = await requestJson({
      path,
      body: {
        image: cleanedBase64
      },
      contentType: "application/json"
    });

    const predictions = flattenPredictions(response);
    const bestPrediction = getBestPrediction(predictions);

    console.log("[Roboflow] JSON response predictions:", predictions.length);
    console.log("[Roboflow] Best prediction:", bestPrediction);

    return {
      success: true,
      source: "roboflow_json",
      response,
      predictions,
      bestPrediction
    };
  } catch (jsonError) {
    console.error("[Roboflow] JSON request failed:", jsonError.message);
    if (jsonError.response) {
      console.error("[Roboflow] JSON error response:", jsonError.response);
    }
  }

  /*
    Fallback request format:
    Some Roboflow legacy endpoints accept raw base64 body.
  */
  try {
    const response = await requestJson({
      path,
      body: cleanedBase64,
      contentType: "application/x-www-form-urlencoded"
    });

    const predictions = flattenPredictions(response);
    const bestPrediction = getBestPrediction(predictions);

    console.log("[Roboflow] Raw base64 response predictions:", predictions.length);
    console.log("[Roboflow] Best prediction:", bestPrediction);

    return {
      success: true,
      source: "roboflow_raw_base64",
      response,
      predictions,
      bestPrediction
    };
  } catch (rawError) {
    console.error("[Roboflow] Raw base64 request failed:", rawError.message);
    if (rawError.response) {
      console.error("[Roboflow] Raw error response:", rawError.response);
    }

    return {
      success: false,
      message: rawError.message,
      predictions: [],
      bestPrediction: null
    };
  }
}

module.exports = {
  classifyWasteWithRoboflow,
  cleanBase64Image,
  normalizeClassName
};