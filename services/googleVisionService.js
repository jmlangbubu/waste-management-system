const vision = require("@google-cloud/vision");

function parseServiceAccountJson(rawValue) {
  if (!rawValue || typeof rawValue !== "string") {
    return null;
  }

  try {
    let cleaned = rawValue.trim();

    // Supports base64-encoded JSON env value
    if (!cleaned.startsWith("{")) {
      try {
        cleaned = Buffer.from(cleaned, "base64").toString("utf8");
      } catch (_) {
        // keep original cleaned value
      }
    }

    const parsed = JSON.parse(cleaned);

    if (parsed.private_key) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }

    return parsed;
  } catch (error) {
    console.error("[GoogleVision] Failed to parse service account JSON env:", error.message);
    return null;
  }
}

function createVisionClient() {
  /*
    Render-friendly credential options.

    Recommended env variable:
    GOOGLE_APPLICATION_CREDENTIALS_JSON

    Value should be the full service account JSON content,
    or base64 version of that JSON.
  */
  const rawCredentials =
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
    process.env.GOOGLE_CLOUD_VISION_CREDENTIALS ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    "";

  const credentials = parseServiceAccountJson(rawCredentials);

  if (credentials && credentials.client_email && credentials.private_key) {
    console.log("[GoogleVision] Using service account JSON from environment variable.");

    return new vision.ImageAnnotatorClient({
      credentials,
      projectId: credentials.project_id
    });
  }

  /*
    Fallback:
    This works only if GOOGLE_APPLICATION_CREDENTIALS points to a real file path
    or if the hosting environment already has Google credentials configured.
  */
  console.log("[GoogleVision] Using default Google credentials.");

  return new vision.ImageAnnotatorClient();
}

const client = createVisionClient();

function cleanBase64Image(base64Image) {
  if (!base64Image || typeof base64Image !== "string") {
    return "";
  }

  return base64Image
    .replace(/^data:image\/\w+;base64,/i, "")
    .replace(/\s/g, "")
    .trim();
}

function normalizeLabel(value) {
  if (!value) return "";

  return String(value)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addLabel(resultMap, description, score = 0, source = "vision") {
  const normalized = normalizeLabel(description);

  if (!normalized) return;

  const existing = resultMap.get(normalized);

  if (!existing || Number(score || 0) > Number(existing.score || 0)) {
    resultMap.set(normalized, {
      description: normalized,
      score: typeof score === "number" ? score : 0,
      source
    });
  }
}

async function detectLabelsFromBase64(base64Image) {
  const cleanedBase64 = cleanBase64Image(base64Image);

  if (!cleanedBase64) {
    console.warn("[GoogleVision] Empty base64 image received.");
    return [];
  }

  const imageBuffer = Buffer.from(cleanedBase64, "base64");

  if (!imageBuffer || imageBuffer.length === 0) {
    console.warn("[GoogleVision] Invalid image buffer.");
    return [];
  }

  console.log("[GoogleVision] Image buffer size:", imageBuffer.length);

  const [result] = await client.annotateImage({
    image: {
      content: imageBuffer
    },
    features: [
      {
        type: "LABEL_DETECTION",
        maxResults: 20
      },
      {
        type: "OBJECT_LOCALIZATION",
        maxResults: 20
      },
      {
        type: "WEB_DETECTION",
        maxResults: 10
      }
    ]
  });

  const resultMap = new Map();

  const labelAnnotations = result.labelAnnotations || [];
  const localizedObjectAnnotations = result.localizedObjectAnnotations || [];
  const webDetection = result.webDetection || {};
  const bestGuessLabels = webDetection.bestGuessLabels || [];
  const webEntities = webDetection.webEntities || [];

  for (const label of labelAnnotations) {
    addLabel(
      resultMap,
      label.description || "",
      typeof label.score === "number" ? label.score : 0,
      "label_detection"
    );
  }

  for (const object of localizedObjectAnnotations) {
    addLabel(
      resultMap,
      object.name || "",
      typeof object.score === "number" ? object.score : 0,
      "object_localization"
    );
  }

  for (const guess of bestGuessLabels) {
    addLabel(
      resultMap,
      guess.label || "",
      0.85,
      "web_best_guess"
    );
  }

  for (const entity of webEntities) {
    addLabel(
      resultMap,
      entity.description || "",
      typeof entity.score === "number" ? entity.score : 0,
      "web_entity"
    );
  }

  const labels = Array.from(resultMap.values())
    .filter((item) => item.description)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

  console.log("[GoogleVision] Final labels:", labels);

  return labels;
}

module.exports = {
  detectLabelsFromBase64
};
