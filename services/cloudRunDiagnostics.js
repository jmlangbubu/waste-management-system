"use strict";
// Only errors tagged at a known boundary can contribute diagnostic data.
// Never copy exception messages, stacks, URLs, headers or provider bodies.
const records = new WeakMap();
const CODES = Object.freeze({
  configuration_validation: "CLOUD_RUN_AUTH_CONFIGURATION_INVALID",
  audience_origin_mismatch: "CLOUD_RUN_AUTH_ORIGIN_MISMATCH",
  credential_file_read: "CLOUD_RUN_AUTH_FILE_UNAVAILABLE",
  credential_format_validation: "CLOUD_RUN_AUTH_CREDENTIALS_INVALID",
  credential_key_validation: "CLOUD_RUN_AUTH_KEY_INVALID",
  sdk_initialization: "CLOUD_RUN_AUTH_SDK_UNAVAILABLE",
  token_signing_or_oauth: "CLOUD_RUN_AUTH_TOKEN_ACQUISITION_FAILED",
  token_response_validation: "CLOUD_RUN_AUTH_TOKEN_INVALID",
  iam_authentication: "CLOUD_RUN_AUTH_UNAVAILABLE",
  timeout: "CLOUD_RUN_REQUEST_TIMEOUT",
  cancelled: "CLOUD_RUN_REQUEST_CANCELLED",
  classifier_http_response: "CLASSIFIER_HTTP_ERROR",
  classifier_network_transport: "CLASSIFIER_NETWORK_ERROR",
  classifier_upstream_unsuccessful: "CLASSIFIER_UPSTREAM_UNSUCCESSFUL",
  classifier_response_validation: "CLASSIFIER_RESPONSE_INVALID"
});
function record(stage, status) {
  const valid = Object.hasOwn(CODES, stage) ? stage : "iam_authentication";
  return Object.freeze({ stage: valid, code: CODES[valid],
    ...(valid === "classifier_http_response" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}) });
}
function mark(error, stage, status) { records.set(error, record(stage, status)); return error; }
function has(error) { return error !== null && (typeof error === "object" || typeof error === "function") && records.has(error); }
function diagnostic(error, fallback = "iam_authentication") { return has(error) ? records.get(error) : record(fallback); }
module.exports = { mark, has, diagnostic };
