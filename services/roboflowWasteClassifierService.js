const https = require("https");

const SERVERLESS_HOST = "serverless.roboflow.com";
const DETECT_HOST = "detect.roboflow.com";

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

function parseModelConfig() {
  const apiKey = safeEnv(process.env.ROBOFLOW_API_KEY);
  const workspaceId = safeEnv(process.env.ROBOFLOW_WORKSPACE_ID);

  let modelId = safeEnv(process.env.ROBOFLOW_MODEL_ID || "ai-waste-classifier");
  let version = safeEnv(process.env.ROBOFLOW_VERSION || "1");
  let modelUrl = safeEnv(process.env.ROBOFLOW_MODEL_URL || "");

  /*
    Supports:
    ROBOFLOW_MODEL_ID=ai-waste-classifier
    ROBOFLOW_VERSION=1

    or:
    ROBOFLOW_MODEL_ID=ai-waste-classifier/1

    or optional:
    ROBOFLOW_MODEL_URL=ai-waste-classifier/1
  */
  if (modelUrl) {
    const parts = modelUrl.split("/").map((part) => part.trim()).filter(Boolean);

    if (parts.length >= 2) {
      modelId = parts[0];
      version = parts[1];
    }
  } else if (modelId.includes("/")) {
    const parts = modelId.split("/").map((part) => part.trim()).filter(Boolean);

    if (parts.length >= 2) {
      modelId = parts[0];
      version = parts[1];
    }
  }

  modelUrl = `${modelId}/${version}`;

  const confidence = safeEnv(process.env.ROBOFLOW_CONFIDENCE || "0.20");
  const overlap = safeEnv(process.env.ROBOFLOW_OVERLAP || "0.30");

  if (!apiKey) {
    throw new Error("ROBOFLOW_API_KEY is missing in Render environment variables.");
  }

  if (!modelId) {
    throw new Error("ROBOFLOW_MODEL_ID is missing in Render environment variables.");
  }

  if (!version) {
    throw new Error("ROBOFLOW_VERSION is missing in Render environment variables.");
  }

  return {
    apiKey,
    workspaceId,
    modelId,
    version,
    modelUrl,
    confidence,
    overlap
  };
}

function buildQuery(config) {
  return new URLSearchParams({
    api_key: config.apiKey,
    confidence: config.confidence,
    overlap: config.overlap,
    format: "json",
    image_type: "base64",
    max_detections: "10",
    disable_active_learning: "true",
    source: "ai-waste-management-system"
  }).toString();
}

function encodeSegment(value) {
  return encodeURIComponent(String(value || "").trim());
}

function buildCandidateEndpoints(config) {
  const query = buildQuery(config);

  const workspace = encodeSegment(config.workspaceId);
  const model = encodeSegment(config.modelId);
  const version = encodeSegment(config.version);

  /*
    Critical fix:
    For Roboflow Serverless v2, workspace mode should be:
    /{workspace_id}/{model_id%2Fversion}

    NOT:
    /{workspace_id}/{model_id}/{version}

    Because the documented endpoint accepts only two path params:
    /{dataset_id}/{version_id}
  */
  const encodedModelUrl = encodeSegment(config.modelUrl);

  const endpoints = [];

  if (workspace) {
    endpoints.push({
      name: "serverless_workspace_encoded_model_url",
      host: SERVERLESS_HOST,
      path: `/${workspace}/${encodedModelUrl}?${query}`
    });

    endpoints.push({
      name: "detect_workspace_encoded_model_url",
      host: DETECT_HOST,
      path: `/${workspace}/${encodedModelUrl}?${query}`
    });
  }

  /*
    Legacy/direct model endpoint.
    Keep this as fallback because some public/legacy projects still use it.
  */
  endpoints.push({
    name: "serverless_model_version",
    host: SERVERLESS_HOST,
    path: `/${model}/${version}?${query}`
  });

  endpoints.push({
    name: "detect_model_version",
    host: DETECT_HOST,
    path: `/${model}/${version}?${query}`
  });

  return endpoints;
}

function redactPath(path) {
  return String(path || "").replace(/api_key=[^&]+/i, "api_key=***");
}

function requestRoboflow({ host, path, body, contentType }) {
  return new Promise((resolve, reject) => {
    const bodyString = typeof body === "string" ? body : JSON.stringify(body);

    const options = {
      hostname: host,
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
        } catch (_) {
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
          error.host = host;
          error.path = path;

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

  if (Array.isArray(response.model_predictions)) {
    return response.model_predictions;
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

      if (Array.isArray(output?.model?.predictions)) {
        predictions.push(...output.model.predictions);
      }

      if (Array.isArray(output?.output?.predictions)) {
        predictions.push(...output.output.predictions);
      }
    }

    return predictions;
  }

  if (response.output && Array.isArray(response.output.predictions)) {
    return response.output.predictions;
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
    prediction.className ||
    prediction.label ||
    prediction.name ||
    "";

  const confidence =
    typeof prediction.confidence === "number"
      ? prediction.confidence
      : typeof prediction.class_confidence === "number"
      ? prediction.class_confidence
      : typeof prediction.score === "number"
      ? prediction.score
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

async function tryEndpointWithBodies(endpoint, cleanedBase64) {
  /*
    Attempt 1:
    Serverless JSON request body.
  */
  try {
    const response = await requestRoboflow({
      host: endpoint.host,
      path: endpoint.path,
      body: {
        image: cleanedBase64
      },
      contentType: "application/json"
    });

    return {
      success: true,
      requestType: "json_image",
      response
    };
  } catch (error) {
    console.error(
      `[Roboflow] ${endpoint.name} JSON failed:`,
      error.statusCode || "",
      error.message
    );

    if (error.response) {
      console.error("[Roboflow] JSON error response:", error.response);
    }
  }

  /*
    Attempt 2:
    Legacy raw base64 body.
  */
  try {
    const response = await requestRoboflow({
      host: endpoint.host,
      path: endpoint.path,
      body: cleanedBase64,
      contentType: "application/x-www-form-urlencoded"
    });

    return {
      success: true,
      requestType: "raw_base64",
      response
    };
  } catch (error) {
    console.error(
      `[Roboflow] ${endpoint.name} raw failed:`,
      error.statusCode || "",
      error.message
    );

    if (error.response) {
      console.error("[Roboflow] Raw error response:", error.response);
    }
  }

  /*
    Attempt 3:
    Plain text base64 body.
  */
  try {
    const response = await requestRoboflow({
      host: endpoint.host,
      path: endpoint.path,
      body: cleanedBase64,
      contentType: "text/plain"
    });

    return {
      success: true,
      requestType: "text_plain_base64",
      response
    };
  } catch (error) {
    console.error(
      `[Roboflow] ${endpoint.name} text failed:`,
      error.statusCode || "",
      error.message
    );

    if (error.response) {
      console.error("[Roboflow] Text error response:", error.response);
    }
  }

  return {
    success: false,
    response: null
  };
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

  let config;

  try {
    config = parseModelConfig();
  } catch (error) {
    console.error("[Roboflow] Config error:", error.message);

    return {
      success: false,
      message: error.message,
      predictions: [],
      bestPrediction: null
    };
  }

  const endpoints = buildCandidateEndpoints(config);

  console.log("[Roboflow] Starting inference.");
  console.log("[Roboflow] Workspace ID:", config.workspaceId || "(not set)");
  console.log("[Roboflow] Model ID:", config.modelId);
  console.log("[Roboflow] Version:", config.version);
  console.log("[Roboflow] Model URL:", config.modelUrl);
  console.log("[Roboflow] Encoded Model URL:", encodeSegment(config.modelUrl));
  console.log("[Roboflow] Image length:", cleanedBase64.length);

  for (const endpoint of endpoints) {
    console.log(
      `[Roboflow] Trying ${endpoint.name}: https://${endpoint.host}${redactPath(endpoint.path)}`
    );

    const attempt = await tryEndpointWithBodies(endpoint, cleanedBase64);

    if (!attempt.success || !attempt.response) {
      continue;
    }

    const predictions = flattenPredictions(attempt.response);
    const bestPrediction = getBestPrediction(predictions);

    console.log("[Roboflow] Successful endpoint:", endpoint.name);
    console.log("[Roboflow] Request type:", attempt.requestType);
    console.log("[Roboflow] Predictions count:", predictions.length);
    console.log("[Roboflow] Best prediction:", bestPrediction);

    return {
      success: true,
      source: `roboflow_${endpoint.name}_${attempt.requestType}`,
      response: attempt.response,
      predictions,
      bestPrediction
    };
  }

  return {
    success: false,
    message: "All Roboflow endpoints failed or returned no usable response.",
    predictions: [],
    bestPrediction: null
  };
}

module.exports = {
  classifyWasteWithRoboflow,
  cleanBase64Image,
  normalizeClassName
};
