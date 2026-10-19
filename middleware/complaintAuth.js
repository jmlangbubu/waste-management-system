const { requireWebAuth, requireWebRole, requireCsrf } = require("./webSessionAuth");
const { requireMobileSession } = require("./mobileSessionAuth");

function buildComplaintAuth(service) {
  const admin = [requireWebAuth, requireWebRole("super_admin"), requireCsrf, (req, res, next) => {
    req.complaintActor = { id: req.user.id, kind: "admin" }; next();
  }];
  const barangay = [requireMobileSession, async (req, res, next) => {
    try { req.complaintActor = await service.barangayActor(req.mobileUser.id); next(); }
    catch (error) { res.status(error.statusCode || 503).json({ success: false, code: error.code || "COMPLAINT_AUTH_UNAVAILABLE", message: "Barangay authorization or assignment could not be verified." }); }
  }];
  const ownBarangay = (req, res, next) => {
    const { key } = require("../services/complaintWorkflowService");
    if (key(req.params.barangayName) !== key(req.complaintActor.barangay)) {
      return res.status(403).json({ success: false, code: "WRONG_BARANGAY", message: "Access is limited to your assigned barangay." });
    }
    next();
  };
  const reader = [(req, res, next) => {
    const run = (handlers, index = 0) => {
      if (index === handlers.length) return next();
      return handlers[index](req, res, () => run(handlers, index + 1));
    };
    if (String(req.headers?.cookie || "").includes("wmo_admin_session=")) return run(admin);
    return run([requireMobileSession, async (request, response, proceed) => {
      if (request.mobileUser.role === "citizen") { request.complaintActor = { id: request.mobileUser.id, kind: "citizen" }; return proceed(); }
      try { request.complaintActor = await service.barangayActor(request.mobileUser.id); proceed(); }
      catch (_) { response.status(403).json({ success: false, message: "Complaint access denied." }); }
    }]);
  }];
  return { admin, barangay, ownBarangay, reader };
}
module.exports = { buildComplaintAuth };
