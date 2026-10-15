const dispatchPlanActivationService = require(
  "../services/dispatchPlanActivationService"
);

function emitWmoTrackingNotification(req, notification) {
  if (!notification) return;
  try {
    const io = req.app && typeof req.app.get === "function"
      ? req.app.get("io")
      : null;
    if (!io || typeof io.to !== "function") return;
    const payload = {
      ...notification,
      _source: "tracking",
      type: notification.type || "tracking",
      createdAt: notification.createdAt || new Date().toISOString()
    };
    io.to("wmo").emit("wmo:gps-tracking-notification", payload);
    io.to("wmo").emit("wmo:tracking-notification", payload);
    io.to("wmo").emit("notification:new", payload);
  } catch (error) {
    console.warn(
      "[MobileDispatchPlan] Notification emit warning:",
      error?.code || error?.message || "EMIT_FAILED"
    );
  }
}

function sendMobileDispatchPlanError(res, error, actionLabel) {
  const statusCode = Number(error.statusCode) || 503;
  const expected = statusCode < 500;
  if (!expected) {
    console.warn(
      `[MobileDispatchPlan] ${actionLabel} failed:`,
      error.cause?.code || error.code || "DISPATCH_PLAN_ACTIVATION_UNAVAILABLE"
    );
  }
  return res.status(statusCode).json({
    success: false,
    message: expected
      ? error.message
      : "Dispatch plan activation is temporarily unavailable",
    code: expected
      ? error.code || "DISPATCH_PLAN_ACTIVATION_ERROR"
      : "DISPATCH_PLAN_ACTIVATION_UNAVAILABLE"
  });
}

exports.listAssignments = async (req, res) => {
  try {
    const data = await dispatchPlanActivationService.listAssignments(
      req.mobileUser
    );
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return sendMobileDispatchPlanError(res, error, "list mobile assignments");
  }
};

exports.activatePlan = async (req, res) => {
  try {
    const result = await dispatchPlanActivationService.activatePlan(
      req.params.planId,
      req.body || {},
      req.mobileUser,
      req.mobileSession || {}
    );
    emitWmoTrackingNotification(req, result.notification);
    return res.status(200).json({
      success: true,
      message: result.data.already_activated
        ? "Dispatch plan was already activated"
        : "Dispatch plan activated successfully",
      data: result.data
    });
  } catch (error) {
    return sendMobileDispatchPlanError(res, error, "activate dispatch plan");
  }
};

exports.emitWmoTrackingNotification = emitWmoTrackingNotification;
exports.sendMobileDispatchPlanError = sendMobileDispatchPlanError;
