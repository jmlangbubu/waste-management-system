const defaultService = require("../services/vehicleIssueService");

function sendVehicleIssueError(res, error, actionLabel) {
  const statusCode = Number(error.statusCode) || 500;
  const expected = statusCode < 500;
  if (!expected) {
    console.error(
      `[VehicleIssue] ${actionLabel} failed:`,
      error.cause?.code || error.code || "UNKNOWN_VEHICLE_ISSUE_ERROR"
    );
  }
  return res.status(statusCode).json({
    success: false,
    message: expected
      ? error.message
      : "Vehicle issue data is temporarily unavailable",
    code: expected
      ? error.code || "VEHICLE_ISSUE_REQUEST_FAILED"
      : "VEHICLE_ISSUE_DATABASE_UNAVAILABLE"
  });
}

function emitVehicleIssueRefresh(req, payload = {}) {
  const io = req.app?.get?.("io");
  if (!io) return;
  io.to("wmo").emit("vehicle-issue:refresh", payload);
}

function buildVehicleIssueController(service = defaultService) {
  return {
    getAssistantSchema(req, res) {
      try {
        return res.status(200).json({
          success: true,
          data: service.getAssistantSchema(req.mobileUser)
        });
      } catch (error) {
        return sendVehicleIssueError(res, error, "load assistant schema");
      }
    },

    async createReport(req, res) {
      try {
        const result = await service.createReport(
          req.body || {},
          req.mobileUser,
          req.file || null
        );
        if (!result.idempotent) {
          emitVehicleIssueRefresh(req, {
            report_id: result.report.id,
            report_status: result.report.report_status,
            severity: result.report.severity
          });
          if (result.notification) {
            req.app?.get?.("io")?.to("wmo").emit(
              "notification:new",
              result.notification
            );
          }
        }
        return res.status(result.idempotent ? 200 : 201).json({
          success: true,
          message: result.idempotent
            ? "Existing vehicle issue report returned"
            : "Vehicle issue report submitted successfully",
          idempotent: result.idempotent,
          data: result.report
        });
      } catch (error) {
        return sendVehicleIssueError(res, error, "create report");
      }
    },

    async listReports(req, res) {
      try {
        return res.status(200).json({
          success: true,
          data: await service.listReports(req.query || {})
        });
      } catch (error) {
        return sendVehicleIssueError(res, error, "list reports");
      }
    },

    async getReport(req, res) {
      try {
        return res.status(200).json({
          success: true,
          data: await service.getReport(req.params.id)
        });
      } catch (error) {
        return sendVehicleIssueError(res, error, "load report detail");
      }
    },

    async reviewReport(req, res) {
      try {
        const report = await service.reviewReport(req.params.id, req.user);
        emitVehicleIssueRefresh(req, {
          report_id: report.id,
          report_status: report.report_status
        });
        return res.status(200).json({
          success: true,
          message: "Vehicle issue report is under review",
          data: report
        });
      } catch (error) {
        return sendVehicleIssueError(res, error, "review report");
      }
    },

    async resolveReport(req, res) {
      try {
        const result = await service.resolveReport(
          req.params.id,
          req.body || {},
          req.user
        );
        if (!result.idempotent) {
          emitVehicleIssueRefresh(req, {
            report_id: result.report.id,
            report_status: result.report.report_status,
            resolution_action: result.report.resolution_action,
            fleet_truck_id: result.report.fleet_truck_id
          });
        }
        return res.status(200).json({
          success: true,
          message: result.idempotent
            ? "Existing vehicle issue resolution returned"
            : "Vehicle issue report resolved successfully",
          idempotent: result.idempotent,
          data: result.report
        });
      } catch (error) {
        return sendVehicleIssueError(res, error, "resolve report");
      }
    }
  };
}

module.exports = buildVehicleIssueController();
module.exports.buildVehicleIssueController = buildVehicleIssueController;
module.exports.sendVehicleIssueError = sendVehicleIssueError;
