const dispatchPlanService = require("../services/dispatchPlanService");

function sendPlanningError(res, error, actionLabel) {
  const statusCode = Number(error.statusCode) || 500;
  const expected = statusCode < 500;
  if (!expected) {
    console.error(
      `[DispatchPlanning] ${actionLabel} failed:`,
      error.cause?.code || error.code || "UNKNOWN_PLANNING_ERROR"
    );
  }
  return res.status(statusCode).json({
    success: false,
    message: expected
      ? error.message
      : "Dispatch planning is temporarily unavailable",
    code: expected
      ? error.code || "DISPATCH_PLAN_REQUEST_FAILED"
      : "DISPATCH_PLAN_DATABASE_ERROR"
  });
}

function sendData(res, data, message, statusCode = 200) {
  const payload = { success: true, data };
  if (message) payload.message = message;
  return res.status(statusCode).json(payload);
}

exports.listPlans = async (req, res) => {
  try {
    return sendData(res, await dispatchPlanService.listPlans(req.query || {}));
  } catch (error) {
    return sendPlanningError(res, error, "list dispatch plans");
  }
};

exports.getPlan = async (req, res) => {
  try {
    return sendData(res, await dispatchPlanService.getPlan(req.params.id));
  } catch (error) {
    return sendPlanningError(res, error, "load dispatch plan");
  }
};

exports.createPlan = async (req, res) => {
  try {
    return sendData(
      res,
      await dispatchPlanService.createPlan(req.body || {}, req.user),
      "Dispatch plan created successfully",
      201
    );
  } catch (error) {
    return sendPlanningError(res, error, "create dispatch plan");
  }
};

exports.updatePlan = async (req, res) => {
  try {
    return sendData(
      res,
      await dispatchPlanService.updatePlan(req.params.id, req.body || {}, req.user),
      "Dispatch plan updated successfully"
    );
  } catch (error) {
    return sendPlanningError(res, error, "update dispatch plan");
  }
};

exports.cancelPlan = async (req, res) => {
  try {
    return sendData(
      res,
      await dispatchPlanService.cancelPlan(req.params.id, req.body || {}, req.user),
      "Dispatch plan cancelled successfully"
    );
  } catch (error) {
    return sendPlanningError(res, error, "cancel dispatch plan");
  }
};

exports.getPlanningOptions = async (req, res) => {
  try {
    return sendData(
      res,
      await dispatchPlanService.getPlanningOptions(req.query || {})
    );
  } catch (error) {
    return sendPlanningError(res, error, "load dispatch planning options");
  }
};
