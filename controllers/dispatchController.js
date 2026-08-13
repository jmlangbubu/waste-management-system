const dispatchService = require("../services/dispatchService");

function withAuthenticatedActor(req) {
  const user = req.user || {};
  const actorName = user.full_name || user.username || null;
  return {
    ...(req.body || {}),
    actor_type: "web_user",
    actor_id: user.id || null,
    actor_name: actorName,
    created_by_user_id: user.id || null,
    created_by_name: actorName
  };
}

function sendDispatchError(res, error, actionLabel) {
  const statusCode = Number(error.statusCode) || 500;
  const isExpected =
    statusCode < 500 ||
    error.code === "DISPATCH_DATABASE_SETUP_REQUIRED" ||
    error.code === "DISPATCH_DESTINATION_CATALOG_SETUP_REQUIRED";

  if (!isExpected) {
    console.error(`[Dispatch] ${actionLabel} failed:`, error);
  }

  const safeUnexpectedMessage = actionLabel === "prepare dispatch ticket"
    ? "Dispatch ticket could not be created. Your route is still saved. Please retry."
    : `Unable to ${actionLabel}`;

  return res.status(statusCode).json({
    success: false,
    message:
      error.code === "DISPATCH_DATABASE_SETUP_REQUIRED"
        ? "Dispatch database setup is required"
        : error.code === "DISPATCH_DESTINATION_CATALOG_SETUP_REQUIRED"
          ? "Dispatch destination catalog setup is required"
          : isExpected
            ? error.message || `Unable to ${actionLabel}`
            : safeUnexpectedMessage,
    code: isExpected ? error.code || "DISPATCH_REQUEST_FAILED" : "DISPATCH_REQUEST_FAILED"
  });
}

function sendData(res, data, message) {
  const payload = { success: true, data };
  if (message) payload.message = message;
  return res.status(200).json(payload);
}

exports.createTicket = async (req, res) => {
  try {
    const data = await dispatchService.createTicket(withAuthenticatedActor(req));
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

exports.listDestinations = async (req, res) => {
  try {
    return sendData(res, await dispatchService.listDestinations(req.query));
  } catch (error) {
    return sendDispatchError(res, error, "search dispatch destinations");
  }
};

exports.getDestination = async (req, res) => {
  try {
    return sendData(res, await dispatchService.getDestination(req.params.id));
  } catch (error) {
    return sendDispatchError(res, error, "load dispatch destination");
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
      await dispatchService.updatePreparedTicket(
        req.params.id,
        withAuthenticatedActor(req)
      ),
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
      await dispatchService.issueTicket(
        req.params.id,
        withAuthenticatedActor(req)
      ),
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
      await dispatchService.cancelTicket(
        req.params.id,
        withAuthenticatedActor(req)
      ),
      "Dispatch ticket cancelled"
    );
  } catch (error) {
    return sendDispatchError(res, error, "cancel dispatch ticket");
  }
};

exports.endDispatch = async (req, res) => {
  try {
    return sendData(
      res,
      await dispatchService.endDispatch(
        req.params.id,
        withAuthenticatedActor(req)
      ),
      "Dispatch ended early"
    );
  } catch (error) {
    return sendDispatchError(res, error, "end dispatch");
  }
};

exports.linkSession = async (req, res) => {
  try {
    return sendData(
      res,
      await dispatchService.linkSession(
        req.params.id,
        withAuthenticatedActor(req)
      ),
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
      await dispatchService.linkActiveSession(
        req.params.id,
        withAuthenticatedActor(req)
      ),
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
        withAuthenticatedActor(req)
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
        withAuthenticatedActor(req)
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
      await dispatchService.skipStop(
        req.params.id,
        req.params.stopId,
        withAuthenticatedActor(req)
      ),
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
      await dispatchService.markReturning(
        req.params.id,
        withAuthenticatedActor(req)
      ),
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

exports.getReport = async (req, res) => {
  try {
    return sendData(
      res,
      await dispatchService.getReportDetails(req.params.ticketId)
    );
  } catch (error) {
    return sendDispatchError(res, error, "load dispatch report");
  }
};
