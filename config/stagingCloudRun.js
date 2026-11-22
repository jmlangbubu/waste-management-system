"use strict";
const fs = require("node:fs"), path = require("node:path");
const { createPrivateKey } = require("node:crypto");
const { parseCallerCredentials, validateCloudRunTarget } = require("../services/cloudRunAuth");

function invalid() {
  const error = new Error("Staging requires an isolated IAM classifier endpoint and dedicated caller credentials.");
  error.code = "STAGING_CLOUD_RUN_CONFIGURATION_INVALID";
  return error;
}
function assertStagingCloudRun(env = process.env, { readFile = fs.readFileSync, parseKey = createPrivateKey } = {}) {
  if (env.WMO_DEPLOYMENT_MODE !== "staging") return;
  try {
    if (env.CLOUD_RUN_AUTH_MODE !== "iam") throw invalid();
    validateCloudRunTarget(env.GEMINI_CLASSIFIER_URL || env.CLOUD_RUN_GEMINI_CLASSIFIER_URL, env);
    if (env.WMO_CLASSIFY_OBJECT_PROPOSALS_ENABLED === "true"
        && (env.WHOLE_IMAGE_DISCOVERY_ENABLED === "true"
          || typeof env.CLASSIFY_OBJECT_PROPOSALS_SHARED_TOKEN !== "string"
          || env.CLASSIFY_OBJECT_PROPOSALS_SHARED_TOKEN.length < 32)) throw invalid();
    const file = env.CLOUD_RUN_CALLER_CREDENTIALS_FILE;
    if (!file || !path.isAbsolute(file) || env.CLOUD_RUN_CALLER_CREDENTIALS_JSON !== undefined) throw invalid();
    const relative = path.relative(path.resolve(__dirname, ".."), path.resolve(file));
    if (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) throw invalid();
    const credentials = parseCallerCredentials(readFile(file, "utf8"), env);
    if (parseKey(credentials.private_key).asymmetricKeyType !== "rsa") throw invalid();
  } catch (_) { throw invalid(); }
}
module.exports = { assertStagingCloudRun };
