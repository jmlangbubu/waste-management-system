const { WasteCorrectionService, WasteCorrectionError } = require("../services/wasteCorrectionService");

const service = new WasteCorrectionService();

function respondError(res, error) {
  if (!(error instanceof WasteCorrectionError)) {
    console.error("Waste correction request failed:", error);
  }
  return res.status(error instanceof WasteCorrectionError ? error.statusCode : 500).json({
    success: false,
    code: error instanceof WasteCorrectionError ? error.code : "WASTE_CORRECTION_UNAVAILABLE",
    message: error instanceof WasteCorrectionError && error.statusCode < 500
      ? error.message
      : "Waste correction service is temporarily unavailable."
  });
}

async function requestCorrection(req, res) {
  try {
    const request = await service.request(req.params.id, req.user, req.body);
    return res.status(201).json({ success: true, data: request });
  } catch (error) {
    return respondError(res, error);
  }
}

async function reviewCorrection(req, res) {
  try {
    const request = await service.review(req.params.requestId, req.user, req.body);
    return res.status(200).json({ success: true, data: request });
  } catch (error) {
    return respondError(res, error);
  }
}

async function applyCorrection(req, res) {
  try {
    const request = await service.apply(req.params.requestId, req.user, req.body);
    return res.status(200).json({ success: true, data: request });
  } catch (error) {
    return respondError(res, error);
  }
}

async function cancelCorrection(req, res) {
  try {
    const request = await service.cancel(req.params.requestId, req.user, req.body);
    return res.status(200).json({ success: true, data: request });
  } catch (error) {
    return respondError(res, error);
  }
}

async function listCorrections(req, res) {
  try {
    const requests = await service.list(req.query, req.user);
    return res.status(200).json({ success: true, data: requests });
  } catch (error) {
    return respondError(res, error);
  }
}

async function getCorrectionHistory(req, res) {
  try {
    const [requests, audit] = await Promise.all([
      service.list({ recordId: req.params.id }, req.user),
      service.history(req.params.id, req.user)
    ]);
    return res.status(200).json({ success: true, data: { requests, audit } });
  } catch (error) {
    return respondError(res, error);
  }
}

module.exports = {
  requestCorrection,
  reviewCorrection,
  applyCorrection,
  cancelCorrection,
  listCorrections,
  getCorrectionHistory
};
