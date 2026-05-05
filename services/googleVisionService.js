let vision = null;
let cachedClient = null;
let cachedClientChecked = false;

function hasGoogleVisionCredentials() {
  return Boolean(
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
      process.env.GOOGLE_CLOUD_VISION_CREDENTIALS ||
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  );
}

function parseServiceAccountJson(rawValue) {
  if (!rawValue || typeof rawValue !== "string") {
    return null;
  }

  try {
    let cleaned = rawValue.trim();

    if (!cleaned.startsWith("{")) {
      try {
        cleaned = Buffer.from(cleaned, "base64").toString("utf8");
      } catch (_) {
        // Keep original value.
      }
    }

    const parsed = JSON.parse(cleaned);

    if (parsed.private_key) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }

    return parsed;
  } catch (error) {
    console.error("[GoogleVision] Failed to parse credentials JSON:", error.message);
    return null;
  }
}

function createVisionClient() {
  if (cachedClientChecked) {
    return cachedClient;
  }

  cachedClientChecked = true;

  if (!hasGoogleVisionCredentials()) {
    console.warn("[GoogleVision] No Google credentials found. Skipping Google Vision.");
    cachedClient = null;
    return null;
  }

  try {
    vision = require("@google-cloud/vision");

    const rawCredentials =
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
      process.env.GOOGLE_CLOUD_VISION_CREDENTIALS ||
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
      "";

    const credentials = parseServiceAccountJson(rawCredentials);

    if (credentials && credentials.client_email && credentials.private_key) {
      console.log("[GoogleVision] Using service account JSON from environment variable.");

      cachedClient = new vision.ImageAnnotatorClient({
        credentials,
        projectId: credentials.project_id
      });

      return cachedClient;
    }

    console.log("[GoogleVision] Using default Google credentials path.");

    cachedClient = new vision.ImageAnnotatorClient();
    return cachedClient;
  } catch (error) {
    console.error("[GoogleVision] Failed to create client:", error.message);
    cachedClient = null;
    return null;
  }
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

async function detectLabelsFromBase64(base64Image) {
  const cleanedBase64 = cleanBase64Image(base64Image);

  if (!cleanedBase64) {
    return [];
  }

  const client = createVisionClient();

  if (!client) {
    return [];
  }

  try {
    const imageBuffer = Buffer.from(cleanedBase64, "base64");

    if (!imageBuffer || imageBuffer.length === 0) {
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

    const labels = [];
    const seen = new Set();

    function addLabel(description, score = 0, source = "vision") {
      const clean = String(description || "").trim();

      if (!clean) return;

      const key = clean.toLowerCase();

      if (seen.has(key)) return;
      seen.add(key);

      labels.push({
        description: clean,
        score: typeof score === "number" ? score : 0,
        source
      });
    }

    for (const label of result.labelAnnotations || []) {
      addLabel(label.description, label.score, "label_detection");
    }

    for (const object of result.localizedObjectAnnotations || []) {
      addLabel(object.name, object.score, "object_localization");
    }

    for (const guess of result.webDetection?.bestGuessLabels || []) {
      addLabel(guess.label, 0.85, "web_best_guess");
    }

    for (const entity of result.webDetection?.webEntities || []) {
      addLabel(entity.description, entity.score, "web_entity");
    }

    console.log("[GoogleVision] Final labels:", labels);

    return labels;
  } catch (error) {
    console.error("[GoogleVision] Detection failed:", error.message);
    return [];
  }
}

module.exports = {
  detectLabelsFromBase64
};
