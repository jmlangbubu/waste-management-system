const dispatchService = require("../services/dispatchService");

function sendDispatchError(res, error, actionLabel) {
  const statusCode = Number(error.statusCode) || 500;
  const isExpected = statusCode < 500 || error.code === "DISPATCH_DATABASE_SETUP_REQUIRED";

  if (!isExpected) {
    console.error(`[Dispatch] ${actionLabel} failed:`, error);
  }

  return res.status(statusCode).json({
    success: false,
    message:
      error.code === "DISPATCH_DATABASE_SETUP_REQUIRED"
        ? "Dispatch database setup is required"
        : error.message || `Unable to ${actionLabel}`,
    code: error.code || "DISPATCH_REQUEST_FAILED"
  });
}

function sendData(res, data, message) {
  const payload = { success: true, data };
  if (message) payload.message = message;
  return res.status(200).json(payload);
}

exports.createTicket = async (req, res) => {
  try {
    const data = await dispatchService.createTicket(req.body);
    return res.status(201).json({
      success: true,
      message: "Dispatch ticket prepared successfully",
      data
    });
  } catch (error) {
    return sendDispatchError(res, error, "prepare dispatch ticket");
  }
};

exports.listTickets = async (req, res) => {
  try {
    return sendData(res, await dispatchService.listTickets(req.query));
  } catch (error) {
    return sendDispatchError(res, error, "load dispatch tickets");
  }
};

exports.getTicket = async (req, res) => {
  try {
    return sendData(res, await dispatchService.getTicketDetails(req.params.id));
  } catch (error) {
    return sendDispatchError(res, error, "load dispatch ticket");
  }
};

exports.updateTicket = async (req, res) => {
  try {
    return sendData(
      res,
      await dispatchService.updatePreparedTicket(req.params.id, req.body),
      "Dispatch ticket updated successfully"
    );
  } catch (error) {
    return sendDispatchError(res, error, "update dispatch ticket");
  }
};

exports.issueTicket = async (req, res) => {
  try {
    return sendData(
      res,
      await dispatchService.issueTicket(req.params.id, req.body),
      "Dispatch ticket issued successfully"
    );
  } catch (error) {
    return sendDispatchError(res, error, "issue dispatch ticket");
  }
};

exports.cancelTicket = async (req, res) => {
  try {
    return sendData(
      res,
      await dispatchService.cancelTicket(req.params.id, req.body),
      "Dispatch ticket cancelled"
    );
  } catch (error) {
    return sendDispatchError(res, error, "cancel dispatch ticket");
  }
};

exports.linkSession = async (req, res) => {
  try {
    return sendData(
      res,
      await dispatchService.linkSession(req.params.id, req.body),
      "Tracking session linked to dispatch ticket"
    );
  } catch (error) {
    return sendDispatchError(res, error, "link tracking session");
  }
};

exports.linkActiveSession = async (req, res) => {
  try {
    return sendData(
      res,
      await dispatchService.linkActiveSession(req.params.id, req.body),
      "Active tracking session linked to dispatch ticket"
    );
  } catch (error) {
    return sendDispatchError(res, error, "link active tracking session");
  }
};

exports.getLiveDispatches = async (req, res) => {
  try {
    return sendData(res, await dispatchService.getLiveDispatches());
  } catch (error) {
    return sendDispatchError(res, error, "load live dispatches");
  }
};

exports.getByTrackingSession = async (req, res) => {
  try {
    return sendData(
      res,
      await dispatchService.getTicketByTrackingSession(req.params.sessionId)
    );
  } catch (error) {
    return sendDispatchError(res, error, "load linked dispatch");
  }
};

exports.getEvents = async (req, res) => {
  try {
    return sendData(res, await dispatchService.getTicketEvents(req.params.id));
  } catch (error) {
    return sendDispatchError(res, error, "load dispatch events");
  }
};

exports.arriveAtStop = async (req, res) => {
  try {
    return sendData(
      res,
      await dispatchService.arriveAtStop(
        req.params.id,
        req.params.stopId,
        req.body
      ),
      "Stop marked arrived"
    );
  } catch (error) {
    return sendDispatchError(res, error, "mark stop arrived");
  }
};

exports.completeStop = async (req, res) => {
  try {
    return sendData(
      res,
      await dispatchService.completeStop(
        req.params.id,
        req.params.stopId,
        req.body
      ),
      "Stop completed"
    );
  } catch (error) {
    return sendDispatchError(res, error, "complete dispatch stop");
  }
};

exports.skipStop = async (req, res) => {
  try {
    return sendData(
      res,
      await dispatchService.skipStop(req.params.id, req.params.stopId, req.body),
      "Stop skipped"
    );
  } catch (error) {
    return sendDispatchError(res, error, "skip dispatch stop");
  }
};

exports.markReturning = async (req, res) => {
  try {
    return sendData(
      res,
      await dispatchService.markReturning(req.params.id, req.body),
      "Dispatch marked as returning to WMO"
    );
  } catch (error) {
    return sendDispatchError(res, error, "mark dispatch returning");
  }
};

exports.getReports = async (req, res) => {
  try {
    return sendData(res, await dispatchService.getReports(req.query));
  } catch (error) {
    return sendDispatchError(res, error, "load dispatch reports");
  }
};
