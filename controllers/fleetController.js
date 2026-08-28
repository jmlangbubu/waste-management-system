const fleetService = require("../services/fleetService");

function sendFleetError(res, error, actionLabel) {
  const statusCode = Number(error.statusCode) || 500;
  const expected = statusCode < 500;
  if (!expected) {
    console.error(
      `[Fleet] ${actionLabel} failed:`,
      error.cause?.code || error.code || "UNKNOWN_FLEET_ERROR"
    );
  }
  return res.status(statusCode).json({
    success: false,
    message: expected
      ? error.message
      : "Fleet data is temporarily unavailable",
    code: expected ? error.code || "FLEET_REQUEST_FAILED" : "FLEET_DATABASE_UNAVAILABLE"
  });
}

exports.listTrucks = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: await fleetService.listTrucks()
    });
  } catch (error) {
    return sendFleetError(res, error, "load fleet trucks");
  }
};

exports.getSummary = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: await fleetService.getSummary()
    });
  } catch (error) {
    return sendFleetError(res, error, "load fleet summary");
  }
};

exports.createTruck = async (req, res) => {
  try {
    return res.status(201).json({
      success: true,
      message: "Fleet truck created successfully",
      data: await fleetService.createTruck(req.body || {}, req.user)
    });
  } catch (error) {
    return sendFleetError(res, error, "create fleet truck");
  }
};

exports.updateCondition = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      message: "Fleet condition updated successfully",
      data: await fleetService.updateCondition(
        req.params.id,
        req.body || {},
        req.user
      )
    });
  } catch (error) {
    return sendFleetError(res, error, "update fleet condition");
  }
};
