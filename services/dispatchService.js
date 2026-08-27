const db = require("../config/dbPromise");
const {
  GpsValidationError,
  MAX_RELIABLE_ACCURACY_METERS,
  formatManilaDateTime,
  parseManilaTimestamp,
  validateGpsPointForStorage,
  qualifyGpsPointForOperationalUse
} = require("../utils/gpsValidation");

const DISPATCH_STOP_TRANSITION_RULES = Object.freeze({
  departureHysteresisMeters: 25,
  confirmationSampleCount: 3,
  arrivalConfirmationSeconds: 60,
  departureConfirmationSeconds: 30,
  arrivalCandidateGapMs: 90000,
  departureCandidateGapMs: 60000
});

const TICKET_STATUSES = new Set([
  "prepared",
  "dispatched",
  "in_progress",
  "returning_to_wmo",
  "completed",
  "cancelled"
]);

const STOP_STATUSES = new Set([
  "pending",
  "on_the_way",
  "arrived",
  "completed",
  "skipped"
]);

const TERMINAL_STOP_STATUSES = new Set(["completed", "skipped"]);
const ACTIVE_TICKET_STATUSES = new Set([
  "dispatched",
  "in_progress",
  "returning_to_wmo"
]);
const NON_TERMINAL_TICKET_STATUSES = new Set([
  "prepared",
  "dispatched",
  "in_progress",
  "returning_to_wmo"
]);
const END_DISPATCH_REASONS = Object.freeze({
  trip_cancelled: "Trip cancelled",
  vehicle_unavailable: "Vehicle unavailable",
  mechanical_issue: "Mechanical issue",
  wrong_ticket_or_route: "Wrong ticket or route",
  returned_early: "Returned early",
  other: "Other"
});
const DISPATCH_TABLE_NAMES = new Set([
  "dispatch_ticket_sequences",
  "dispatch_tickets",
  "dispatch_route_stops",
  "dispatch_tracking_sessions",
  "dispatch_events"
]);
const DESTINATION_CATALOG_TABLE_NAMES = new Set([
  "gensan_dispatch_destinations",
  "gensan_dispatch_destination_points"
]);
const DESTINATION_TYPES = new Set(["road_segment", "barangay_hall"]);
const DEFAULT_DESTINATION_LIMIT = 20;
const MAX_DESTINATION_LIMIT = 1000;
const DISPATCH_HISTORY_REPLAY_PAGE_SIZE = 500;
const DISPATCH_PLANNED_ROUTE_VERSION = 1;
const DISPATCH_PLANNED_ROUTE_SOURCE = "osrm";
const DISPATCH_PLANNED_ROUTE_MAX_POINTS = 10000;
const DISPATCH_PLANNED_ROUTE_MAX_BYTES = 512 * 1024;
const DISPATCH_PLANNED_ROUTE_MAX_DISTANCE_METERS = 2000000;
const DISPATCH_PLANNED_ROUTE_MAX_STOP_SIGNATURE_LENGTH = 4096;

function qualifyDispatchStopEvidence(locationLog = {}, options = {}) {
  const referenceTimeMs = Number.isFinite(Number(options.referenceTimeMs))
    ? Number(options.referenceTimeMs)
    : Date.now();

  try {
    const point = validateGpsPointForStorage(locationLog, {
      allowNumericString: true,
      timestampRequired: true,
      nowMs: referenceTimeMs
    });

    if (
      point.accuracy === null ||
      point.accuracy <= 0 ||
      point.accuracy > MAX_RELIABLE_ACCURACY_METERS
    ) {
      return {
        qualified: false,
        reason: "unreliable_accuracy",
        point: null
      };
    }

    return {
      qualified: true,
      reason: "qualified",
      point
    };
  } catch (error) {
    if (error instanceof GpsValidationError) {
      return {
        qualified: false,
        reason: error.code,
        point: null
      };
    }
    throw error;
  }
}

function normalizedHistoryTimestamp(value) {
  const timestampMs = parseManilaTimestamp(value);
  return timestampMs === null ? null : formatManilaDateTime(timestampMs);
}

function automaticEventForStop(events, stopId, eventType) {
  return events.find(
    (event) =>
      Number(event.dispatch_route_stop_id) === Number(stopId) &&
      event.event_type === eventType &&
      event.event_source === "automatic"
  ) || null;
}

function manualEventTimestamp(events, stopId, eventTypes) {
  const event = events.find(
    (candidate) =>
      Number(candidate.dispatch_route_stop_id) === Number(stopId) &&
      eventTypes.includes(candidate.event_type) &&
      candidate.event_source !== "automatic"
  );
  return normalizedHistoryTimestamp(event?.event_at);
}

function createDispatchHistoryReplayState(stops = [], events = [], options = {}) {
  const ticketStatus = String(options.ticketStatus || "").toLowerCase();
  const activeTicket = ACTIVE_TICKET_STATUSES.has(ticketStatus);
  const completedTicket = ticketStatus === "completed";

  const replayStops = stops.map((stop, index) => {
    const arrivalEvent = automaticEventForStop(
      events,
      stop.id,
      "arrived_at_stop"
    );
    const departureEvent = automaticEventForStop(
      events,
      stop.id,
      "departed_stop"
    );
    const arrivalManual = stop.arrival_source === "manual";
    const departureManual = stop.departure_source === "manual";
    const skipped = stop.stop_status === "skipped";
    const manualArrivalAt = arrivalManual
      ? normalizedHistoryTimestamp(stop.actual_arrival_at) ||
        manualEventTimestamp(events, stop.id, ["arrived_at_stop"])
      : null;
    const manualDepartureAt = departureManual
      ? normalizedHistoryTimestamp(stop.actual_departure_at) ||
        normalizedHistoryTimestamp(stop.completed_at) ||
        manualEventTimestamp(events, stop.id, ["stop_completed"])
      : null;
    const skippedAt = skipped
      ? normalizedHistoryTimestamp(stop.skipped_at) ||
        manualEventTimestamp(events, stop.id, ["stop_skipped"])
      : null;
    const hasAutomaticHistory =
      stop.arrival_source === "automatic" ||
      stop.departure_source === "automatic" ||
      Boolean(arrivalEvent) ||
      Boolean(departureEvent);
    const ambiguousManualState =
      (arrivalManual && !manualArrivalAt) ||
      (departureManual && !manualDepartureAt) ||
      (skipped && !skippedAt);
    const replayAllowed =
      !skipped &&
      !ambiguousManualState &&
      (activeTicket || completedTicket || hasAutomaticHistory);

    return {
      ...stop,
      replay_index: index,
      replay_allowed: replayAllowed,
      preserve_entirely: skipped || !replayAllowed,
      manual_arrival: arrivalManual,
      manual_departure: departureManual,
      manual_arrival_at: manualArrivalAt,
      manual_departure_at: manualDepartureAt,
      manual_terminal_at: skippedAt || manualDepartureAt,
      replay_arrival_at: manualArrivalAt,
      replay_departure_at: manualDepartureAt,
      replay_arrival_candidate_at: null,
      replay_arrival_candidate_count: 0,
      replay_departure_candidate_at: null,
      replay_departure_candidate_count: 0,
      replay_arrival_event: null,
      replay_departure_event: null,
      existing_auto_arrival_event: arrivalEvent,
      existing_auto_departure_event: departureEvent
    };
  });

  return {
    ticket_status: ticketStatus,
    stops: replayStops,
    current_stop_index: 0,
    previous_recorded_at_ms: null,
    qualified_rows: 0,
    ignored_rows: 0
  };
}

function evaluateDispatchTransitionCandidate(
  kind,
  currentCandidateAt,
  currentCandidateCount,
  locationLog,
  previousRecordedAtMs
) {
  const gapMs = kind === "arrival"
    ? DISPATCH_STOP_TRANSITION_RULES.arrivalCandidateGapMs
    : DISPATCH_STOP_TRANSITION_RULES.departureCandidateGapMs;
  const confirmationSeconds = kind === "arrival"
    ? DISPATCH_STOP_TRANSITION_RULES.arrivalConfirmationSeconds
    : DISPATCH_STOP_TRANSITION_RULES.departureConfirmationSeconds;
  const currentTimeMs = Number.isFinite(Number(locationLog.timestampMs))
    ? Number(locationLog.timestampMs)
    : parseManilaTimestamp(locationLog.recorded_at);
  const hasLongGap =
    Number.isFinite(previousRecordedAtMs) &&
    currentTimeMs > previousRecordedAtMs &&
    currentTimeMs - previousRecordedAtMs > gapMs;
  const candidateAt = currentCandidateAt && !hasLongGap
    ? currentCandidateAt
    : locationLog.recorded_at;
  const candidateCount = currentCandidateAt && !hasLongGap
    ? Number(currentCandidateCount || 0) + 1
    : 1;
  const candidateTimeMs = parseManilaTimestamp(candidateAt);
  const elapsedSeconds = Math.max(
    0,
    (currentTimeMs - candidateTimeMs) / 1000
  );
  return {
    candidateAt,
    candidateCount,
    elapsedSeconds,
    confirmed:
      candidateCount >= DISPATCH_STOP_TRANSITION_RULES.confirmationSampleCount &&
      elapsedSeconds >= confirmationSeconds
  };
}

function nextReplayCandidate(stop, kind, locationLog, previousRecordedAtMs) {
  const prefix = kind === "arrival" ? "replay_arrival" : "replay_departure";
  const candidate = evaluateDispatchTransitionCandidate(
    kind,
    stop[`${prefix}_candidate_at`],
    stop[`${prefix}_candidate_count`],
    locationLog,
    previousRecordedAtMs
  );
  stop[`${prefix}_candidate_at`] = candidate.candidateAt;
  stop[`${prefix}_candidate_count`] = candidate.candidateCount;
  return candidate;
}

function clearReplayCandidate(stop, kind) {
  const prefix = kind === "arrival" ? "replay_arrival" : "replay_departure";
  stop[`${prefix}_candidate_at`] = null;
  stop[`${prefix}_candidate_count`] = 0;
}

function applyDispatchHistoryLocation(replayState, locationLog, options = {}) {
  const evidence = qualifyDispatchStopEvidence(locationLog, options);
  const rawRecordedAtMs = parseManilaTimestamp(locationLog.recorded_at);
  const recordedAtMs = evidence.qualified
    ? evidence.point.timestampMs
    : rawRecordedAtMs;

  if (!Number.isFinite(recordedAtMs)) {
    replayState.ignored_rows += 1;
    return;
  }

  const cutoffMs = Number(options.cutoffMs);
  const startMs = Number(options.startMs);
  if (Number.isFinite(startMs) && recordedAtMs < startMs) {
    replayState.ignored_rows += 1;
    replayState.previous_recorded_at_ms = recordedAtMs;
    return;
  }
  if (Number.isFinite(cutoffMs) && recordedAtMs > cutoffMs) {
    replayState.ignored_rows += 1;
    replayState.previous_recorded_at_ms = recordedAtMs;
    return;
  }

  while (replayState.current_stop_index < replayState.stops.length) {
    const barrierStop = replayState.stops[replayState.current_stop_index];
    const terminalAtMs = parseManilaTimestamp(barrierStop.manual_terminal_at);

    if (barrierStop.preserve_entirely) {
      if (
        TERMINAL_STOP_STATUSES.has(barrierStop.stop_status) &&
        Number.isFinite(terminalAtMs) &&
        recordedAtMs >= terminalAtMs
      ) {
        replayState.current_stop_index += 1;
        continue;
      }
      replayState.previous_recorded_at_ms = recordedAtMs;
      replayState.ignored_rows += 1;
      return;
    }

    if (
      barrierStop.manual_departure &&
      Number.isFinite(terminalAtMs) &&
      recordedAtMs >= terminalAtMs
    ) {
      replayState.current_stop_index += 1;
      continue;
    }
    break;
  }

  const stop = replayState.stops[replayState.current_stop_index];
  if (!stop) {
    replayState.previous_recorded_at_ms = recordedAtMs;
    replayState.ignored_rows += 1;
    return;
  }

  if (!evidence.qualified) {
    clearReplayCandidate(
      stop,
      stop.replay_arrival_at ? "departure" : "arrival"
    );
    replayState.previous_recorded_at_ms = recordedAtMs;
    replayState.ignored_rows += 1;
    return;
  }

  const point = evidence.point;
  const distance = haversineMeters(
    point.latitude,
    point.longitude,
    Number(stop.latitude),
    Number(stop.longitude)
  );

  if (
    stop.manual_arrival &&
    recordedAtMs < parseManilaTimestamp(stop.manual_arrival_at)
  ) {
    replayState.previous_recorded_at_ms = recordedAtMs;
    replayState.ignored_rows += 1;
    return;
  }

  if (!stop.replay_arrival_at) {
    const qualifies = distance <= Number(stop.geofence_radius_meters);
    if (!qualifies) {
      clearReplayCandidate(stop, "arrival");
    } else {
      const candidate = nextReplayCandidate(
        stop,
        "arrival",
        point,
        replayState.previous_recorded_at_ms
      );
      if (candidate.confirmed) {
        stop.replay_arrival_at = candidate.candidateAt;
        stop.replay_arrival_event = {
          event_type: "arrived_at_stop",
          event_at: candidate.candidateAt,
          latitude: point.latitude,
          longitude: point.longitude,
          accuracy_meters: point.accuracy,
          details: {
            distance_meters: Math.round(distance),
            confirmed_at: point.recorded_at,
            confirming_location_log_id: point.id,
            candidate_sample_count: candidate.candidateCount,
            reconciled_from_history: true
          }
        };
        clearReplayCandidate(stop, "arrival");
      }
    }
  } else if (!stop.manual_departure) {
    const qualifies =
      distance >
      Number(stop.geofence_radius_meters) +
        DISPATCH_STOP_TRANSITION_RULES.departureHysteresisMeters;
    if (!qualifies) {
      clearReplayCandidate(stop, "departure");
    } else {
      const candidate = nextReplayCandidate(
        stop,
        "departure",
        point,
        replayState.previous_recorded_at_ms
      );
      const arrivalTimeMs = parseManilaTimestamp(stop.replay_arrival_at);
      if (
        candidate.confirmed &&
        Number.isFinite(arrivalTimeMs) &&
        parseManilaTimestamp(candidate.candidateAt) >= arrivalTimeMs
      ) {
        stop.replay_departure_at = candidate.candidateAt;
        stop.replay_departure_event = {
          event_type: "departed_stop",
          event_at: candidate.candidateAt,
          latitude: point.latitude,
          longitude: point.longitude,
          accuracy_meters: point.accuracy,
          details: {
            distance_meters: Math.round(distance),
            confirmed_at: point.recorded_at,
            confirming_location_log_id: point.id,
            candidate_sample_count: candidate.candidateCount,
            reconciled_from_history: true
          }
        };
        clearReplayCandidate(stop, "departure");
        replayState.current_stop_index += 1;
      }
    }
  }

  replayState.previous_recorded_at_ms = recordedAtMs;
  replayState.qualified_rows += 1;
}

class DispatchServiceError extends Error {
  constructor(message, statusCode = 400, code = "DISPATCH_ERROR") {
    super(message);
    this.name = "DispatchServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

class DispatchDatabaseUnavailableError extends DispatchServiceError {
  constructor(cause) {
    super(
      "Dispatch database setup is required",
      503,
      "DISPATCH_DATABASE_SETUP_REQUIRED"
    );
    this.name = "DispatchDatabaseUnavailableError";
    this.cause = cause;
  }
}

class DispatchDestinationCatalogUnavailableError extends DispatchServiceError {
  constructor(cause) {
    super(
      "Dispatch destination catalog setup is required",
      503,
      "DISPATCH_DESTINATION_CATALOG_SETUP_REQUIRED"
    );
    this.name = "DispatchDestinationCatalogUnavailableError";
    this.cause = cause;
  }
}

function duplicateDispatchTicketNumberError(cause = null) {
  const error = new DispatchServiceError(
    "This ticket number is already in use.",
    409,
    "DISPATCH_TICKET_NUMBER_DUPLICATE"
  );
  error.cause = cause;
  return error;
}

function dispatchTruckAlreadyAssignedError(cause = null) {
  const error = new DispatchServiceError(
    "This truck already has a non-terminal dispatch ticket.",
    409,
    "DISPATCH_TRUCK_ALREADY_ASSIGNED"
  );
  error.cause = cause;
  return error;
}

function isDestinationCatalogTableMissingError(error) {
  if (!error) return false;
  if (error.code === "DISPATCH_DESTINATION_CATALOG_SETUP_REQUIRED") return true;
  if (error.cause && error.cause !== error) {
    return isDestinationCatalogTableMissingError(error.cause);
  }
  if (!["ER_NO_SUCH_TABLE", "ER_BAD_TABLE_ERROR"].includes(error.code)) {
    return false;
  }
  const message = String(error.message || "").toLowerCase();
  return [...DESTINATION_CATALOG_TABLE_NAMES].some((tableName) =>
    message.includes(tableName)
  );
}

function isDispatchTableMissingError(error) {
  if (!error) return false;
  if (error.code === "DISPATCH_DATABASE_SETUP_REQUIRED") return true;
  if (error.cause && error.cause !== error) {
    return isDispatchTableMissingError(error.cause);
  }
  if (["ER_NO_SUCH_TABLE", "ER_BAD_TABLE_ERROR"].includes(error.code)) return true;

  const message = String(error.message || "").toLowerCase();
  return (
    message.includes("doesn't exist") &&
    [...DISPATCH_TABLE_NAMES].some((tableName) => message.includes(tableName))
  );
}

function normalizeDispatchError(error) {
  if (isDestinationCatalogTableMissingError(error)) {
    return new DispatchDestinationCatalogUnavailableError(error);
  }
  if (isDispatchTableMissingError(error)) {
    return new DispatchDatabaseUnavailableError(error);
  }
  return error;
}

function normalizeDestinationSearchText(value) {
  return cleanText(value, 255)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function destinationLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_DESTINATION_LIMIT;
  return Math.min(parsed, MAX_DESTINATION_LIMIT);
}

function cleanText(value, maxLength = 255) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, maxLength);
}

function nullableText(value, maxLength = 255) {
  const text = cleanText(value, maxLength);
  return text || null;
}

function requiredId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new DispatchServiceError(`${label} must be a positive integer`);
  }
  return id;
}

function optionalId(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return requiredId(value, label);
}

function requiredCoordinate(value, label, min, max) {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  ) {
    throw new DispatchServiceError(`${label} is required`);
  }
  const coordinate = Number(value);
  if (!Number.isFinite(coordinate) || coordinate < min || coordinate > max) {
    throw new DispatchServiceError(`${label} must be between ${min} and ${max}`);
  }
  return coordinate;
}

function optionalDateTime(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new DispatchServiceError(`${label} must be a valid date and time`);
  }
  return parsed;
}

function dateOnly(value, label) {
  const text = cleanText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new DispatchServiceError(`${label} must use YYYY-MM-DD format`);
  }
  const parsed = new Date(`${text}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== text
  ) {
    throw new DispatchServiceError(`${label} must be a valid date`);
  }
  return text;
}

function currentManilaDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts
      .filter((part) => ["year", "month", "day"].includes(part.type))
      .map((part) => [part.type, part.value])
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeEndDispatchReason(payload = {}) {
  const reasonCode = cleanText(
    payload.reason_code ?? payload.reasonCode,
    80
  ).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(END_DISPATCH_REASONS, reasonCode)) {
    throw new DispatchServiceError(
      "Select a valid reason for ending the dispatch",
      400,
      "DISPATCH_END_REASON_REQUIRED"
    );
  }

  const otherReason = cleanText(
    payload.other_reason ?? payload.otherReason,
    500
  );
  if (reasonCode === "other" && !otherReason) {
    throw new DispatchServiceError(
      "Enter a reason when Other is selected",
      400,
      "DISPATCH_END_OTHER_REASON_REQUIRED"
    );
  }

  const reasonLabel = END_DISPATCH_REASONS[reasonCode];
  return {
    reason_code: reasonCode,
    reason_label: reasonLabel,
    reason: reasonCode === "other" ? `${reasonLabel}: ${otherReason}` : reasonLabel,
    other_reason: reasonCode === "other" ? otherReason : null
  };
}

function parseEventDetails(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function dispatchPlannedRouteError(message) {
  return new DispatchServiceError(
    message,
    400,
    "DISPATCH_PLANNED_ROUTE_INVALID"
  );
}

function dispatchPlannedRouteStopSignature(stops = []) {
  if (!Array.isArray(stops) || stops.length === 0) return "";
  const orderedStops = stops
    .map((stop) => ({
      stop_order: stop?.stop_order ?? stop?.stopOrder,
      latitude: stop?.latitude,
      longitude: stop?.longitude
    }))
    .map((stop) => ({
      stop_order: stop.stop_order === null || stop.stop_order === ""
        ? Number.NaN
        : Number(stop.stop_order),
      latitude: stop.latitude === null || stop.latitude === ""
        ? Number.NaN
        : Number(stop.latitude),
      longitude: stop.longitude === null || stop.longitude === ""
        ? Number.NaN
        : Number(stop.longitude)
    }))
    .sort((first, second) => first.stop_order - second.stop_order);

  if (orderedStops.some((stop, index) =>
    !Number.isInteger(stop.stop_order) ||
    stop.stop_order !== index + 1 ||
    !Number.isFinite(stop.latitude) ||
    stop.latitude < -90 ||
    stop.latitude > 90 ||
    !Number.isFinite(stop.longitude) ||
    stop.longitude < -180 ||
    stop.longitude > 180
  )) {
    return "";
  }

  return `v1|${orderedStops.map((stop) =>
    `${stop.stop_order}:${stop.latitude.toFixed(6)},${stop.longitude.toFixed(6)}`
  ).join("|")}`;
}

function normalizeDispatchPlannedRouteSnapshot(value, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw dispatchPlannedRouteError("The assigned route snapshot must be an object");
  }

  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw dispatchPlannedRouteError("The assigned route snapshot is not serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > DISPATCH_PLANNED_ROUTE_MAX_BYTES) {
    throw dispatchPlannedRouteError(
      `The assigned route snapshot exceeds ${DISPATCH_PLANNED_ROUTE_MAX_BYTES} bytes`
    );
  }

  if (value.version !== DISPATCH_PLANNED_ROUTE_VERSION) {
    throw dispatchPlannedRouteError("The assigned route snapshot version is not supported");
  }
  if (value.source !== DISPATCH_PLANNED_ROUTE_SOURCE) {
    throw dispatchPlannedRouteError("The assigned route snapshot source must be osrm");
  }
  if (
    !value.geometry ||
    typeof value.geometry !== "object" ||
    Array.isArray(value.geometry) ||
    value.geometry.type !== "LineString"
  ) {
    throw dispatchPlannedRouteError("The assigned route geometry must be a LineString");
  }

  const rawCoordinates = value.geometry.coordinates;
  if (!Array.isArray(rawCoordinates) || rawCoordinates.length < 2) {
    throw dispatchPlannedRouteError("The assigned route must contain at least two coordinates");
  }
  if (rawCoordinates.length > DISPATCH_PLANNED_ROUTE_MAX_POINTS) {
    throw dispatchPlannedRouteError(
      `The assigned route exceeds ${DISPATCH_PLANNED_ROUTE_MAX_POINTS} coordinates`
    );
  }

  const coordinates = rawCoordinates.map((coordinate, index) => {
    if (!Array.isArray(coordinate) || coordinate.length !== 2) {
      throw dispatchPlannedRouteError(
        `Assigned route coordinate ${index + 1} must contain longitude and latitude`
      );
    }
    const [longitude, latitude] = coordinate;
    if (
      typeof longitude !== "number" ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw dispatchPlannedRouteError(
        `Assigned route longitude ${index + 1} must be between -180 and 180`
      );
    }
    if (
      typeof latitude !== "number" ||
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90
    ) {
      throw dispatchPlannedRouteError(
        `Assigned route latitude ${index + 1} must be between -90 and 90`
      );
    }
    return [longitude, latitude];
  });

  const distanceMeters = value.distance_meters;
  if (
    typeof distanceMeters !== "number" ||
    !Number.isFinite(distanceMeters) ||
    distanceMeters < 0 ||
    distanceMeters > DISPATCH_PLANNED_ROUTE_MAX_DISTANCE_METERS
  ) {
    throw dispatchPlannedRouteError(
      `The assigned route distance must be between 0 and ${DISPATCH_PLANNED_ROUTE_MAX_DISTANCE_METERS} meters`
    );
  }

  const stopSignature = typeof value.stop_signature === "string"
    ? value.stop_signature.trim()
    : "";
  if (
    !stopSignature ||
    stopSignature.length > DISPATCH_PLANNED_ROUTE_MAX_STOP_SIGNATURE_LENGTH
  ) {
    throw dispatchPlannedRouteError("The assigned route stop signature is invalid");
  }

  const truckId = typeof value.truck_id === "string" ? value.truck_id.trim() : "";
  if (!truckId || truckId.length > 100) {
    throw dispatchPlannedRouteError("The assigned route truck identity is invalid");
  }
  const trackingSessionId = Number(value.tracking_session_id);
  if (!Number.isInteger(trackingSessionId) || trackingSessionId <= 0) {
    throw dispatchPlannedRouteError("The assigned route tracking session is invalid");
  }

  const capturedAtValue = options.capturedAt ?? value.captured_at;
  const capturedAt = new Date(capturedAtValue);
  if (!capturedAtValue || Number.isNaN(capturedAt.getTime())) {
    throw dispatchPlannedRouteError("The assigned route capture time is invalid");
  }

  const normalized = {
    version: DISPATCH_PLANNED_ROUTE_VERSION,
    source: DISPATCH_PLANNED_ROUTE_SOURCE,
    captured_at: capturedAt.toISOString(),
    geometry: {
      type: "LineString",
      coordinates
    },
    distance_meters: distanceMeters,
    stop_signature: stopSignature,
    truck_id: truckId,
    tracking_session_id: trackingSessionId
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > DISPATCH_PLANNED_ROUTE_MAX_BYTES) {
    throw dispatchPlannedRouteError(
      `The assigned route snapshot exceeds ${DISPATCH_PLANNED_ROUTE_MAX_BYTES} bytes`
    );
  }
  return normalized;
}

function storedDispatchPlannedRouteSnapshot(details) {
  const plannedRoute = parseEventDetails(details).planned_route;
  if (!plannedRoute) return null;
  try {
    return normalizeDispatchPlannedRouteSnapshot(plannedRoute);
  } catch (error) {
    return null;
  }
}

function durationSecondsBetween(startValue, endValue) {
  if (!startValue || !endValue) return null;
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end.getTime() < start.getTime()
  ) {
    return null;
  }
  return Math.floor((end.getTime() - start.getTime()) / 1000);
}

function normalizeActor(payload = {}, fallbackType = "web_user") {
  return {
    actor_type: cleanText(payload.actor_type || payload.actorType || fallbackType, 40),
    actor_id: optionalId(payload.actor_id || payload.actorId, "actor_id"),
    actor_name: nullableText(payload.actor_name || payload.actorName, 255)
  };
}

function haversineMeters(latitudeA, longitudeA, latitudeB, longitudeB) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusMeters = 6371000;
  const latitudeDelta = toRadians(latitudeB - latitudeA);
  const longitudeDelta = toRadians(longitudeB - longitudeA);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(latitudeA)) *
      Math.cos(toRadians(latitudeB)) *
      Math.sin(longitudeDelta / 2) ** 2;

  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function validateTicketInput(payload = {}, options = {}) {
  const ticketNumber = cleanText(
    payload.ticket_number ?? payload.ticketNumber,
    100
  );
  const truckId = cleanText(payload.truck_id || payload.truckId, 100);
  const truckName = cleanText(
    payload.truck_name_snapshot || payload.truckNameSnapshot,
    255
  );
  const routeName = cleanText(payload.route_name || payload.routeName, 255);

  if (options.requireTicketNumber && !ticketNumber) {
    throw new DispatchServiceError(
      "Enter the ticket number to continue.",
      400,
      "DISPATCH_TICKET_NUMBER_REQUIRED"
    );
  }
  if (!truckId) throw new DispatchServiceError("truck_id is required");
  if (!truckName) {
    throw new DispatchServiceError("truck_name_snapshot is required");
  }
  if (!routeName) throw new DispatchServiceError("route_name is required");

  const authoritativeNow = typeof options.now === "function"
    ? options.now()
    : options.now;
  const dispatchDate = dateOnly(
    options.dispatchDate || currentManilaDate(authoritativeNow),
    "dispatch_date"
  );
  const scheduledStartAt = optionalDateTime(
    payload.scheduled_start_at || payload.scheduledStartAt,
    "scheduled_start_at"
  );
  const expectedReturnAt = optionalDateTime(
    payload.expected_return_at || payload.expectedReturnAt,
    "expected_return_at"
  );

  if (
    scheduledStartAt &&
    expectedReturnAt &&
    expectedReturnAt.getTime() <= scheduledStartAt.getTime()
  ) {
    throw new DispatchServiceError(
      "expected_return_at must be later than scheduled_start_at"
    );
  }

  const rawStops = payload.stops;
  if (!Array.isArray(rawStops) || rawStops.length === 0) {
    throw new DispatchServiceError("At least one route stop is required");
  }

  const seenOrders = new Set();
  const stops = rawStops.map((rawStop, index) => {
    const stopOrder = Number(rawStop.stop_order || rawStop.stopOrder || index + 1);
    if (!Number.isInteger(stopOrder) || stopOrder <= 0) {
      throw new DispatchServiceError("Each stop_order must be a positive integer");
    }
    if (seenOrders.has(stopOrder)) {
      throw new DispatchServiceError(`Duplicate stop_order: ${stopOrder}`);
    }
    seenOrders.add(stopOrder);

    const locationName = cleanText(
      rawStop.location_name || rawStop.locationName,
      255
    );
    if (!locationName) {
      throw new DispatchServiceError(
        `location_name is required for stop ${stopOrder}`
      );
    }

    const geofenceRadius = Number(
      rawStop.geofence_radius_meters ||
        rawStop.geofenceRadiusMeters ||
        100
    );
    if (!Number.isFinite(geofenceRadius) || geofenceRadius < 25 || geofenceRadius > 5000) {
      throw new DispatchServiceError(
        `geofence_radius_meters for stop ${stopOrder} must be between 25 and 5000`
      );
    }

    return {
      stop_order: stopOrder,
      location_name: locationName,
      address_reference: nullableText(
        rawStop.address_reference || rawStop.addressReference,
        500
      ),
      latitude: requiredCoordinate(
        rawStop.latitude,
        `latitude for stop ${stopOrder}`,
        -90,
        90
      ),
      longitude: requiredCoordinate(
        rawStop.longitude,
        `longitude for stop ${stopOrder}`,
        -180,
        180
      ),
      geofence_radius_meters: Math.round(geofenceRadius),
      expected_arrival_at: optionalDateTime(
        rawStop.expected_arrival_at || rawStop.expectedArrivalAt,
        `expected_arrival_at for stop ${stopOrder}`
      )
    };
  });

  stops.sort((a, b) => a.stop_order - b.stop_order);
  let previousExpectedArrival = scheduledStartAt;
  for (const stop of stops) {
    if (!stop.expected_arrival_at) continue;
    if (
      previousExpectedArrival &&
      stop.expected_arrival_at.getTime() < previousExpectedArrival.getTime()
    ) {
      throw new DispatchServiceError(
        `expected_arrival_at for stop ${stop.stop_order} is earlier than the preceding schedule`
      );
    }
    if (
      expectedReturnAt &&
      stop.expected_arrival_at.getTime() > expectedReturnAt.getTime()
    ) {
      throw new DispatchServiceError(
        `expected_arrival_at for stop ${stop.stop_order} is later than expected_return_at`
      );
    }
    previousExpectedArrival = stop.expected_arrival_at;
  }

  return {
    ticket_number: ticketNumber || null,
    truck_id: truckId,
    truck_name_snapshot: truckName,
    assigned_personnel_id: optionalId(
      payload.assigned_personnel_id || payload.assignedPersonnelId,
      "assigned_personnel_id"
    ),
    assigned_personnel_name: nullableText(
      payload.assigned_personnel_name || payload.assignedPersonnelName,
      255
    ),
    dispatch_date: dispatchDate,
    scheduled_start_at: scheduledStartAt,
    expected_return_at: expectedReturnAt,
    route_name: routeName,
    route_description: nullableText(
      payload.route_description || payload.routeDescription,
      2000
    ),
    notes: nullableText(payload.notes, 2000),
    created_by_user_id: options.includeCreator
      ? optionalId(
          payload.created_by_user_id || payload.createdByUserId,
          "created_by_user_id"
        )
      : undefined,
    created_by_name: options.includeCreator
      ? nullableText(payload.created_by_name || payload.createdByName, 255)
      : undefined,
    stops
  };
}

class DispatchService {
  constructor(pool = db, options = {}) {
    this.db = pool;
    this.now = typeof options.now === "function" ? options.now : () => new Date();
  }

  async withTransaction(work) {
    const connection = await this.db.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.warn(
          "[Dispatch] Transaction rollback warning:",
          rollbackError.code || rollbackError.message
        );
      }
      throw normalizeDispatchError(error);
    } finally {
      connection.release();
    }
  }

  async query(sql, parameters = []) {
    try {
      return await this.db.query(sql, parameters);
    } catch (error) {
      throw normalizeDispatchError(error);
    }
  }

  async generateTicketNumber(connection, dispatchYear) {
    await connection.query(
      `
        INSERT INTO dispatch_ticket_sequences (
          dispatch_year,
          \`last_value\`,
          updated_at
        )
        VALUES (?, 0, NOW())
        ON DUPLICATE KEY UPDATE updated_at = updated_at
      `,
      [dispatchYear]
    );

    const [sequenceRows] = await connection.query(
      `
        SELECT \`last_value\`
        FROM dispatch_ticket_sequences
        WHERE dispatch_year = ?
        FOR UPDATE
      `,
      [dispatchYear]
    );

    if (sequenceRows.length !== 1) {
      throw new DispatchServiceError(
        "Unable to reserve the next dispatch ticket number",
        500,
        "DISPATCH_SEQUENCE_ERROR"
      );
    }

    const nextValue = Number(sequenceRows[0].last_value || 0) + 1;
    await connection.query(
      `
        UPDATE dispatch_ticket_sequences
        SET \`last_value\` = ?,
            updated_at = NOW()
        WHERE dispatch_year = ?
      `,
      [nextValue, dispatchYear]
    );

    return `DPT-${dispatchYear}-${String(nextValue).padStart(4, "0")}`;
  }

  async listDestinations(filters = {}) {
    const destinationType = cleanText(filters.type, 40).toLowerCase();
    if (!DESTINATION_TYPES.has(destinationType)) {
      throw new DispatchServiceError(
        "type must be road_segment or barangay_hall",
        400,
        "INVALID_DESTINATION_TYPE"
      );
    }

    const query = normalizeDestinationSearchText(filters.q);
    const barangay = normalizeDestinationSearchText(filters.barangay);
    const limit = destinationLimit(filters.limit);
    const searchable = `
      LOWER(CONVERT(CONCAT_WS(' ',
        gdd.name,
        gdd.display_label,
        COALESCE(gdd.barangay, ''),
        COALESCE(gdd.aliases, ''),
        COALESCE(gdd.search_keywords, '')
      ) USING utf8mb4)) COLLATE utf8mb4_unicode_ci
    `;
    const nameSearch =
      "LOWER(CONVERT(gdd.name USING utf8mb4)) COLLATE utf8mb4_unicode_ci";
    const displaySearch =
      "LOWER(CONVERT(gdd.display_label USING utf8mb4)) COLLATE utf8mb4_unicode_ci";
    const clauses = ["gdd.is_active = 1", "gdd.is_verified = 1"];
    const parameters = [];
    if (destinationType === "road_segment") {
      clauses.push("gdd.destination_type IN ('road_segment', 'road')");
    } else {
      clauses.push("gdd.destination_type = ?");
      parameters.push(destinationType);
    }

    if (barangay) {
      clauses.push(
        "LOWER(CONVERT(gdd.barangay USING utf8mb4)) COLLATE utf8mb4_unicode_ci = ?"
      );
      parameters.push(barangay);
    }
    if (query) {
      clauses.push(`${searchable} LIKE ?`);
      parameters.push(`%${query}%`);
    }

    const rankingSql = query
      ? `CASE
          WHEN ${displaySearch} = ? OR ${nameSearch} = ? THEN 0
          WHEN ${displaySearch} LIKE ? OR ${nameSearch} LIKE ? THEN 1
          ELSE 2
        END ASC,`
      : "";
    if (query) parameters.push(query, query, `${query}%`, `${query}%`);
    parameters.push(limit);

    const [rows] = await this.query(
      `
        SELECT
          gdd.id,
          CASE
            WHEN gdd.destination_type = 'road' THEN 'road_segment'
            ELSE gdd.destination_type
          END AS destination_type,
          gdd.name,
          gdd.barangay,
          gdd.display_label,
          gdd.latitude,
          gdd.longitude,
          gdd.aliases,
          gdd.is_verified,
          EXISTS (
            SELECT 1
            FROM gensan_dispatch_destination_points gddp
            WHERE gddp.destination_id = gdd.id
              AND gddp.point_type IN ('geometry', 'entry', 'middle', 'exit')
          ) AS has_geometry,
          (
            SELECT COUNT(*)
            FROM gensan_dispatch_destination_points gddpc
            WHERE gddpc.destination_id = gdd.id
              AND gddpc.point_type IN ('geometry', 'entry', 'middle', 'exit')
          ) AS geometry_point_count
        FROM gensan_dispatch_destinations gdd
        WHERE ${clauses.join(" AND ")}
        ORDER BY
          ${rankingSql}
          gdd.is_verified DESC,
          gdd.name ASC,
          gdd.id ASC
        LIMIT ?
      `,
      parameters
    );

    return rows.map((row) => ({
      ...row,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      is_verified: Boolean(Number(row.is_verified)),
      has_geometry: Boolean(Number(row.has_geometry)),
      geometry_point_count: Number(row.geometry_point_count || 0)
    }));
  }

  async getDestination(destinationId) {
    const id = requiredId(destinationId, "destination id");
    const [[destinations], [points]] = await Promise.all([
      this.query(
        `
          SELECT
            id,
            CASE
              WHEN destination_type = 'road' THEN 'road_segment'
              ELSE destination_type
            END AS destination_type,
            name,
            barangay,
            display_label,
            latitude,
            longitude,
            aliases,
            search_keywords,
            osm_type,
            osm_id,
            is_verified,
            is_active
          FROM gensan_dispatch_destinations
          WHERE id = ?
            AND is_active = 1
            AND is_verified = 1
          LIMIT 1
        `,
        [id]
      ),
      this.query(
        `
          SELECT id, destination_id, point_order, point_type, latitude, longitude
          FROM gensan_dispatch_destination_points
          WHERE destination_id = ?
          ORDER BY point_order ASC, id ASC
        `,
        [id]
      )
    ]);

    if (!destinations.length) {
      throw new DispatchServiceError(
        "Dispatch destination not found",
        404,
        "DISPATCH_DESTINATION_NOT_FOUND"
      );
    }

    const destination = destinations[0];
    destination.latitude = Number(destination.latitude);
    destination.longitude = Number(destination.longitude);
    destination.is_verified = Boolean(Number(destination.is_verified));
    destination.is_active = Boolean(Number(destination.is_active));
    const normalizedPoints = points.map((point) => ({
      ...point,
      latitude: Number(point.latitude),
      longitude: Number(point.longitude)
    }));
    return {
      destination,
      points: normalizedPoints,
      has_geometry: normalizedPoints.some((point) =>
        ["geometry", "entry", "middle", "exit"].includes(point.point_type)
      ),
      geometry_point_count: normalizedPoints.filter((point) =>
        ["geometry", "entry", "middle", "exit"].includes(point.point_type)
      ).length
    };
  }

  async insertStops(connection, ticketId, stops) {
    for (const stop of stops) {
      await connection.query(
        `
          INSERT INTO dispatch_route_stops (
            dispatch_ticket_id,
            stop_order,
            location_name,
            address_reference,
            latitude,
            longitude,
            geofence_radius_meters,
            expected_arrival_at,
            stop_status,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW(), NOW())
        `,
        [
          ticketId,
          stop.stop_order,
          stop.location_name,
          stop.address_reference,
          stop.latitude,
          stop.longitude,
          stop.geofence_radius_meters,
          stop.expected_arrival_at
        ]
      );
    }
  }

  async insertEvent(connection, event = {}) {
    const eventType = cleanText(event.event_type || event.eventType, 80);
    if (!eventType) {
      throw new DispatchServiceError("event_type is required");
    }

    const details =
      event.details === null || event.details === undefined
        ? null
        : JSON.stringify(event.details);

    const [result] = await connection.query(
      `
        INSERT INTO dispatch_events (
          dispatch_ticket_id,
          dispatch_route_stop_id,
          tracking_session_id,
          event_type,
          event_at,
          event_source,
          actor_type,
          actor_id,
          actor_name,
          latitude,
          longitude,
          accuracy_meters,
          details,
          idempotency_key,
          created_at
        )
        VALUES (?, ?, ?, ?, COALESCE(?, NOW()), ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
      `,
      [
        requiredId(event.dispatch_ticket_id, "dispatch_ticket_id"),
        optionalId(event.dispatch_route_stop_id, "dispatch_route_stop_id"),
        optionalId(event.tracking_session_id, "tracking_session_id"),
        eventType,
        event.event_at || null,
        cleanText(event.event_source || "system", 40),
        cleanText(event.actor_type || "system", 40),
        optionalId(event.actor_id, "actor_id"),
        nullableText(event.actor_name, 255),
        event.latitude === undefined ? null : event.latitude,
        event.longitude === undefined ? null : event.longitude,
        event.accuracy_meters === undefined ? null : event.accuracy_meters,
        details,
        nullableText(event.idempotency_key, 255)
      ]
    );

    return result.insertId;
  }

  async getTicketForUpdate(connection, ticketId) {
    const [rows] = await connection.query(
      `
        SELECT *
        FROM dispatch_tickets
        WHERE id = ?
        FOR UPDATE
      `,
      [requiredId(ticketId, "ticket id")]
    );

    if (!rows.length) {
      throw new DispatchServiceError(
        "Dispatch ticket not found",
        404,
        "DISPATCH_TICKET_NOT_FOUND"
      );
    }
    return rows[0];
  }

  async lockTruckDispatchAssignment(connection, truckId) {
    const normalizedTruckId = cleanText(truckId, 100);
    if (!normalizedTruckId) {
      throw new DispatchServiceError("truck_id is required");
    }

    const [rows] = await connection.query(
      `
        SELECT id
        FROM truck_tracking_sessions
        WHERE truck_id = ?
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE
      `,
      [normalizedTruckId]
    );
    if (!rows.length) {
      throw new DispatchServiceError(
        "The selected active tracking session was not found.",
        404,
        "ACTIVE_TRACKING_SESSION_NOT_FOUND"
      );
    }
    return rows[0];
  }

  async getTicketAfterTruckDispatchLock(connection, ticketId) {
    const id = requiredId(ticketId, "ticket id");
    const [ticketReferences] = await connection.query(
      `
        SELECT id, truck_id
        FROM dispatch_tickets
        WHERE id = ?
        LIMIT 1
      `,
      [id]
    );
    if (!ticketReferences.length) {
      throw new DispatchServiceError(
        "Dispatch ticket not found",
        404,
        "DISPATCH_TICKET_NOT_FOUND"
      );
    }

    const referencedTruckId = cleanText(ticketReferences[0].truck_id, 100);
    await this.lockTruckDispatchAssignment(connection, referencedTruckId);
    const ticket = await this.getTicketForUpdate(connection, id);
    if (String(ticket.truck_id) !== String(referencedTruckId)) {
      await this.lockTruckDispatchAssignment(connection, ticket.truck_id);
    }
    return ticket;
  }

  async assertTruckHasNoOtherNonTerminalDispatch(
    connection,
    truckId,
    options = {}
  ) {
    const normalizedTruckId = cleanText(truckId, 100);
    if (!options.lockAcquired) {
      await this.lockTruckDispatchAssignment(connection, normalizedTruckId);
    }

    const statuses = [...NON_TERMINAL_TICKET_STATUSES];
    const clauses = [
      "truck_id = ?",
      `status IN (${statuses.map(() => "?").join(", ")})`
    ];
    const parameters = [normalizedTruckId, ...statuses];
    const excludeTicketId = optionalId(
      options.excludeTicketId,
      "exclude ticket id"
    );
    if (excludeTicketId !== null) {
      clauses.push("id <> ?");
      parameters.push(excludeTicketId);
    }

    const [rows] = await connection.query(
      `
        SELECT id, ticket_number, status
        FROM dispatch_tickets
        WHERE ${clauses.join(" AND ")}
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE
      `,
      parameters
    );
    if (rows.length) throw dispatchTruckAlreadyAssignedError();
  }

  async getSelectedActiveTrackingSession(connection, trackingSessionId, truckId) {
    const sessionId = requiredId(trackingSessionId, "tracking_session_id");
    const [rows] = await connection.query(
      `
        SELECT id, truck_id, enforcer_id, enforcer_name, session_status
        FROM truck_tracking_sessions
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [sessionId]
    );
    if (!rows.length) {
      throw new DispatchServiceError(
        "The selected active tracking session was not found.",
        404,
        "ACTIVE_TRACKING_SESSION_NOT_FOUND"
      );
    }

    const session = rows[0];
    if (String(session.session_status || "").toLowerCase() !== "active") {
      throw new DispatchServiceError(
        "The selected tracking session is no longer active.",
        409,
        "ACTIVE_TRACKING_SESSION_ENDED"
      );
    }
    if (String(session.truck_id) !== String(truckId)) {
      throw new DispatchServiceError(
        "The selected active tracking session does not match the truck.",
        409,
        "DISPATCH_TRUCK_MISMATCH"
      );
    }
    return session;
  }

  async createTicket(payload = {}) {
    const ticketData = validateTicketInput(payload, {
      includeCreator: true,
      requireTicketNumber: false,
      now: this.now()
    });

    const ticketId = await this.withTransaction(async (connection) => {
      await this.lockTruckDispatchAssignment(connection, ticketData.truck_id);
      const selectedSession = await this.getSelectedActiveTrackingSession(
        connection,
        payload.tracking_session_id || payload.trackingSessionId,
        ticketData.truck_id
      );
      ticketData.assigned_personnel_id = optionalId(
        selectedSession.enforcer_id,
        "assigned_personnel_id"
      );
      ticketData.assigned_personnel_name = nullableText(
        selectedSession.enforcer_name,
        255
      );
      await this.assertTruckHasNoOtherNonTerminalDispatch(
        connection,
        ticketData.truck_id,
        { lockAcquired: true }
      );

      ticketData.ticket_number = await this.generateTicketNumber(
        connection,
        Number(ticketData.dispatch_date.slice(0, 4))
      );

      let ticketResult;
      try {
        [ticketResult] = await connection.query(
          `
            INSERT INTO dispatch_tickets (
              ticket_number,
              truck_id,
              truck_name_snapshot,
              assigned_personnel_id,
              assigned_personnel_name,
              dispatch_date,
              scheduled_start_at,
              expected_return_at,
              route_name,
              route_description,
              status,
              notes,
              created_by_user_id,
              created_by_name,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, NOW(), NOW())
          `,
          [
            ticketData.ticket_number,
            ticketData.truck_id,
            ticketData.truck_name_snapshot,
            ticketData.assigned_personnel_id,
            ticketData.assigned_personnel_name,
            ticketData.dispatch_date,
            ticketData.scheduled_start_at,
            ticketData.expected_return_at,
            ticketData.route_name,
            ticketData.route_description,
            ticketData.notes,
            ticketData.created_by_user_id,
            ticketData.created_by_name
          ]
        );
      } catch (error) {
        if (error?.code === "ER_DUP_ENTRY") {
          throw duplicateDispatchTicketNumberError(error);
        }
        throw error;
      }

      await this.insertStops(connection, ticketResult.insertId, ticketData.stops);
      await this.insertEvent(connection, {
        dispatch_ticket_id: ticketResult.insertId,
        event_type: "dispatch_prepared",
        event_source: "web",
        actor_type: "web_user",
        actor_id: ticketData.created_by_user_id,
        actor_name: ticketData.created_by_name,
        idempotency_key: `dispatch-prepared:${ticketResult.insertId}`
      });

      return ticketResult.insertId;
    });

    return this.getTicketDetails(ticketId);
  }

  async listTickets(filters = {}) {
    const clauses = [];
    const parameters = [];

    if (filters.status) {
      const status = cleanText(filters.status, 40);
      if (!TICKET_STATUSES.has(status)) {
        throw new DispatchServiceError("Invalid dispatch ticket status");
      }
      clauses.push("dt.status = ?");
      parameters.push(status);
    }

    if (filters.date) {
      clauses.push("dt.dispatch_date = ?");
      parameters.push(dateOnly(filters.date, "date"));
    }

    if (filters.truck) {
      clauses.push("dt.truck_id LIKE ?");
      parameters.push(`%${cleanText(filters.truck, 100)}%`);
    }

    const ticketFilter = filters.ticket ?? filters.search;
    if (ticketFilter) {
      clauses.push("dt.ticket_number LIKE ?");
      parameters.push(`%${cleanText(ticketFilter, 100)}%`);
    }

    const [rows] = await this.query(
      `
        SELECT
          dt.id,
          dt.ticket_number,
          dt.truck_id,
          dt.truck_name_snapshot,
          dt.dispatch_date,
          dt.scheduled_start_at,
          dt.expected_return_at,
          dt.route_name,
          dt.status,
          dt.actual_start_at,
          dt.actual_end_at,
          dt.issued_at,
          dt.created_at,
          dt.updated_at,
          COUNT(drs.id) AS total_stops,
          SUM(CASE WHEN drs.stop_status = 'completed' THEN 1 ELSE 0 END) AS completed_stops,
          SUM(CASE WHEN drs.stop_status = 'skipped' THEN 1 ELSE 0 END) AS skipped_stops
        FROM dispatch_tickets dt
        LEFT JOIN dispatch_route_stops drs
          ON drs.dispatch_ticket_id = dt.id
        ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
        GROUP BY dt.id
        ORDER BY COALESCE(dt.issued_at, dt.created_at) DESC, dt.id DESC
      `,
      parameters
    );

    return rows;
  }

  async getTicketDetails(ticketId) {
    const id = requiredId(ticketId, "ticket id");
    const [[ticketRows], [stops], [sessions], [events]] = await Promise.all([
      this.query("SELECT * FROM dispatch_tickets WHERE id = ? LIMIT 1", [id]),
      this.query(
        `
          SELECT *
          FROM dispatch_route_stops
          WHERE dispatch_ticket_id = ?
          ORDER BY stop_order ASC, id ASC
        `,
        [id]
      ),
      this.query(
        `
          SELECT
            dts.*,
            tts.truck_id,
            tts.enforcer_name,
            tts.session_status,
            tts.started_at,
            tts.ended_at,
            tts.end_latitude,
            tts.end_longitude,
            tts.last_latitude,
            tts.last_longitude,
            tts.last_updated_at,
            tts.session_distance_km
          FROM dispatch_tracking_sessions dts
          INNER JOIN truck_tracking_sessions tts
            ON tts.id = dts.tracking_session_id
          WHERE dts.dispatch_ticket_id = ?
            AND dts.unlinked_at IS NULL
          ORDER BY dts.is_primary DESC, dts.linked_at DESC, dts.id DESC
        `,
        [id]
      ),
      this.query(
        `
          SELECT *
          FROM dispatch_events
          WHERE dispatch_ticket_id = ?
          ORDER BY event_at ASC, id ASC
        `,
        [id]
      )
    ]);

    if (!ticketRows.length) {
      throw new DispatchServiceError(
        "Dispatch ticket not found",
        404,
        "DISPATCH_TICKET_NOT_FOUND"
      );
    }

    const ticket = ticketRows[0];
    const warnings = [];
    const allStopsTerminal =
      stops.length > 0 &&
      stops.every((stop) => TERMINAL_STOP_STATUSES.has(stop.stop_status));
    const latestSession = sessions[0];

    if (
      ticket.status === "returning_to_wmo" &&
      allStopsTerminal &&
      latestSession &&
      latestSession.session_status !== "active"
    ) {
      warnings.push(
        latestSession.end_latitude !== null || latestSession.last_latitude !== null
          ? "Tracking ended outside the WMO return geofence. The dispatch remains returning to WMO and requires review."
          : "Tracking ended without a final WMO location. Manual review is required."
      );
    }

    const progress = {
      total_stops: stops.length,
      completed_stops: stops.filter(
        (stop) => stop.stop_status === "completed"
      ).length,
      skipped_stops: stops.filter((stop) => stop.stop_status === "skipped").length,
      terminal_stops: stops.filter((stop) =>
        TERMINAL_STOP_STATUSES.has(stop.stop_status)
      ).length
    };

    return {
      ticket,
      stops,
      tracking_sessions: sessions,
      progress,
      events,
      warnings
    };
  }

  async updatePreparedTicket(ticketId, payload = {}) {
    const ticketData = validateTicketInput(payload, { now: this.now() });

    await this.withTransaction(async (connection) => {
      await this.lockTruckDispatchAssignment(connection, ticketData.truck_id);
      const ticket = await this.getTicketForUpdate(connection, ticketId);
      if (ticket.status !== "prepared") {
        throw new DispatchServiceError(
          "Only prepared dispatch tickets can be edited",
          409,
          "DISPATCH_TICKET_NOT_EDITABLE"
        );
      }
      ticketData.dispatch_date = ticket.dispatch_date;
      await this.assertTruckHasNoOtherNonTerminalDispatch(
        connection,
        ticketData.truck_id,
        { excludeTicketId: ticket.id, lockAcquired: true }
      );

      await connection.query(
        `
          UPDATE dispatch_tickets
          SET truck_id = ?,
              truck_name_snapshot = ?,
              assigned_personnel_id = ?,
              assigned_personnel_name = ?,
              dispatch_date = ?,
              scheduled_start_at = ?,
              expected_return_at = ?,
              route_name = ?,
              route_description = ?,
              notes = ?,
              updated_at = NOW()
          WHERE id = ?
        `,
        [
          ticketData.truck_id,
          ticketData.truck_name_snapshot,
          ticketData.assigned_personnel_id,
          ticketData.assigned_personnel_name,
          ticketData.dispatch_date,
          ticketData.scheduled_start_at,
          ticketData.expected_return_at,
          ticketData.route_name,
          ticketData.route_description,
          ticketData.notes,
          ticket.id
        ]
      );

      await connection.query(
        "DELETE FROM dispatch_route_stops WHERE dispatch_ticket_id = ?",
        [ticket.id]
      );
      await this.insertStops(connection, ticket.id, ticketData.stops);
    });

    return this.getTicketDetails(ticketId);
  }

  async issueTicket(ticketId, payload = {}) {
    const actor = normalizeActor(payload);
    await this.withTransaction(async (connection) => {
      const ticket = await this.getTicketAfterTruckDispatchLock(connection, ticketId);
      if (ticket.status === "dispatched") return;
      if (ticket.status !== "prepared") {
        throw new DispatchServiceError(
          "Only a prepared ticket can be issued",
          409,
          "DISPATCH_TICKET_NOT_PREPARED"
        );
      }
      await this.assertTruckHasNoOtherNonTerminalDispatch(
        connection,
        ticket.truck_id,
        { excludeTicketId: ticket.id, lockAcquired: true }
      );

      const snapshotInput = payload.planned_route_snapshot ?? payload.plannedRouteSnapshot;
      let plannedRouteSnapshot = null;
      if (snapshotInput !== null && snapshotInput !== undefined) {
        plannedRouteSnapshot = normalizeDispatchPlannedRouteSnapshot(snapshotInput, {
          capturedAt: this.now().toISOString()
        });
        const [routeStops] = await connection.query(
          `
            SELECT stop_order, latitude, longitude
            FROM dispatch_route_stops
            WHERE dispatch_ticket_id = ?
            ORDER BY stop_order ASC
          `,
          [ticket.id]
        );
        const persistedStopSignature = dispatchPlannedRouteStopSignature(routeStops);
        if (
          !persistedStopSignature ||
          plannedRouteSnapshot.stop_signature !== persistedStopSignature
        ) {
          throw dispatchPlannedRouteError(
            "The assigned route no longer matches the prepared ticket stops"
          );
        }
        if (plannedRouteSnapshot.truck_id !== String(ticket.truck_id || "").trim()) {
          throw dispatchPlannedRouteError(
            "The assigned route no longer matches the prepared ticket truck"
          );
        }
      }

      await connection.query(
        `
          UPDATE dispatch_tickets
          SET status = 'dispatched',
              issued_at = COALESCE(issued_at, NOW()),
              dispatched_at = COALESCE(dispatched_at, NOW()),
              updated_at = NOW()
          WHERE id = ?
        `,
        [ticket.id]
      );
      await this.insertEvent(connection, {
        dispatch_ticket_id: ticket.id,
        event_type: "ticket_issued",
        event_source: "web",
        ...actor,
        details: plannedRouteSnapshot
          ? { planned_route: plannedRouteSnapshot }
          : undefined,
        idempotency_key: `dispatch-issued:${ticket.id}`
      });
    });
    return this.getTicketDetails(ticketId);
  }

  async cancelTicket(ticketId, payload = {}) {
    const reason = cleanText(payload.reason || payload.cancellation_reason, 1000);
    if (!reason) {
      throw new DispatchServiceError("Cancellation reason is required");
    }
    const actor = normalizeActor(payload);

    await this.withTransaction(async (connection) => {
      const ticket = await this.getTicketForUpdate(connection, ticketId);
      if (ticket.status === "cancelled") return;
      if (ticket.status === "completed") {
        throw new DispatchServiceError(
          "A completed dispatch ticket cannot be cancelled",
          409,
          "DISPATCH_TICKET_COMPLETED"
        );
      }
      if (ACTIVE_TICKET_STATUSES.has(ticket.status)) {
        throw new DispatchServiceError(
          "Use End Dispatch to close an active dispatch",
          409,
          "DISPATCH_END_REQUIRED"
        );
      }

      await connection.query(
        `
          UPDATE dispatch_tickets
          SET status = 'cancelled',
              cancelled_at = NOW(),
              cancellation_reason = ?,
              updated_at = NOW()
          WHERE id = ?
        `,
        [reason, ticket.id]
      );
      await this.insertEvent(connection, {
        dispatch_ticket_id: ticket.id,
        event_type: "ticket_cancelled",
        event_source: "web",
        ...actor,
        details: { reason },
        idempotency_key: `dispatch-cancelled:${ticket.id}`
      });
    });
    return this.getTicketDetails(ticketId);
  }

  async endDispatch(ticketId, payload = {}) {
    const closure = normalizeEndDispatchReason(payload);
    const actor = normalizeActor(payload);

    await this.withTransaction(async (connection) => {
      const ticket = await this.getTicketForUpdate(connection, ticketId);
      if (ticket.status === "cancelled") {
        const [existingEvents] = await connection.query(
          `
            SELECT id
            FROM dispatch_events
            WHERE dispatch_ticket_id = ?
              AND event_type = 'dispatch_closed_early'
            LIMIT 1
          `,
          [ticket.id]
        );
        if (existingEvents.length) return;
      }

      if (!ACTIVE_TICKET_STATUSES.has(ticket.status)) {
        throw new DispatchServiceError(
          ticket.status === "completed"
            ? "A completed dispatch cannot be ended early"
            : "Only an active dispatch can be ended early",
          409,
          ticket.status === "completed"
            ? "DISPATCH_ALREADY_COMPLETED"
            : "DISPATCH_END_NOT_ALLOWED"
        );
      }

      const [sessionRows] = await connection.query(
        `
          SELECT tracking_session_id
          FROM dispatch_tracking_sessions
          WHERE dispatch_ticket_id = ?
            AND unlinked_at IS NULL
          ORDER BY is_primary DESC, linked_at DESC, id DESC
          LIMIT 1
        `,
        [ticket.id]
      );
      const trackingSessionId = sessionRows[0]?.tracking_session_id || null;

      await connection.query(
        `
          UPDATE dispatch_tickets
          SET status = 'cancelled',
              actual_end_at = NOW(),
              cancelled_at = NOW(),
              cancellation_reason = ?,
              updated_at = NOW()
          WHERE id = ?
        `,
        [closure.reason, ticket.id]
      );
      await this.insertEvent(connection, {
        dispatch_ticket_id: ticket.id,
        tracking_session_id: trackingSessionId,
        event_type: "dispatch_closed_early",
        event_source: "web",
        ...actor,
        details: closure,
        idempotency_key: `dispatch-closed-early:${ticket.id}`
      });
    });

    return this.getTicketDetails(ticketId);
  }

  async linkSessionInTransaction(
    connection,
    ticketId,
    trackingSessionId,
    linkSource,
    actor,
    lockedTicket = null
  ) {
    const ticket = lockedTicket || await this.getTicketAfterTruckDispatchLock(
      connection,
      ticketId
    );
    if (!["dispatched", "in_progress"].includes(ticket.status)) {
      throw new DispatchServiceError(
        "Issue the dispatch ticket before linking a tracking session",
        409,
        "DISPATCH_TICKET_NOT_ISSUED"
      );
    }

    const sessionId = requiredId(trackingSessionId, "tracking_session_id");
    const [sessionRows] = await connection.query(
      `
        SELECT id, truck_id, enforcer_id, enforcer_name, session_status, started_at
        FROM truck_tracking_sessions
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [sessionId]
    );
    if (!sessionRows.length) {
      throw new DispatchServiceError(
        "Tracking session not found",
        404,
        "TRACKING_SESSION_NOT_FOUND"
      );
    }

    const session = sessionRows[0];
    if (
      linkSource === "active_truck_match" &&
      session.session_status !== "active"
    ) {
      throw new DispatchServiceError(
        "The matching tracking session is no longer active",
        409,
        "ACTIVE_TRACKING_SESSION_ENDED"
      );
    }
    if (String(session.truck_id) !== String(ticket.truck_id)) {
      throw new DispatchServiceError(
        "Tracking session truck does not match the dispatch ticket",
        409,
        "DISPATCH_TRUCK_MISMATCH"
      );
    }

    const [existingRows] = await connection.query(
      `
        SELECT dispatch_ticket_id
        FROM dispatch_tracking_sessions
        WHERE tracking_session_id = ?
          AND unlinked_at IS NULL
        LIMIT 1
      `,
      [sessionId]
    );
    if (existingRows.length) {
      if (Number(existingRows[0].dispatch_ticket_id) === Number(ticket.id)) {
        return { ticket, session, alreadyLinked: true };
      }
      throw new DispatchServiceError(
        "Tracking session is already linked to another dispatch ticket",
        409,
        "TRACKING_SESSION_ALREADY_LINKED"
      );
    }

    await this.assertTruckHasNoOtherNonTerminalDispatch(
      connection,
      ticket.truck_id,
      { excludeTicketId: ticket.id, lockAcquired: true }
    );

    await connection.query(
      `
        UPDATE dispatch_tracking_sessions
        SET is_primary = 0
        WHERE dispatch_ticket_id = ?
          AND unlinked_at IS NULL
      `,
      [ticket.id]
    );
    await connection.query(
      `
        INSERT INTO dispatch_tracking_sessions (
          dispatch_ticket_id,
          tracking_session_id,
          is_primary,
          link_source,
          linked_at,
          created_at
        )
        VALUES (?, ?, 1, ?, NOW(), NOW())
      `,
      [ticket.id, sessionId, cleanText(linkSource, 40)]
    );
    await connection.query(
      `
        UPDATE dispatch_tickets
        SET status = 'in_progress',
            actual_start_at = COALESCE(actual_start_at, ?),
            updated_at = NOW()
        WHERE id = ?
      `,
      [session.started_at || new Date(), ticket.id]
    );
    await connection.query(
      `
        UPDATE dispatch_route_stops
        SET stop_status = 'on_the_way',
            updated_at = NOW()
        WHERE dispatch_ticket_id = ?
          AND stop_status = 'pending'
        ORDER BY stop_order ASC
        LIMIT 1
      `,
      [ticket.id]
    );
    await this.insertEvent(connection, {
      dispatch_ticket_id: ticket.id,
      tracking_session_id: sessionId,
      event_type: "tracking_started",
      event_at: session.started_at,
      event_source: "web",
      ...actor,
      details: { link_source: linkSource },
      idempotency_key: `tracking-linked:${ticket.id}:${sessionId}`
    });

    return { ticket, session, alreadyLinked: false };
  }

  async linkSession(ticketId, payload = {}) {
    const actor = normalizeActor(payload);
    const trackingSessionId =
      payload.tracking_session_id || payload.trackingSessionId;

    await this.withTransaction((connection) =>
      this.linkSessionInTransaction(
        connection,
        ticketId,
        trackingSessionId,
        "manual",
        actor
      )
    );
    return this.getTicketDetails(ticketId);
  }

  async linkActiveSession(ticketId, payload = {}) {
    const actor = normalizeActor(payload);
    await this.withTransaction(async (connection) => {
      const ticket = await this.getTicketAfterTruckDispatchLock(connection, ticketId);
      const [activeRows] = await connection.query(
        `
          SELECT id
          FROM truck_tracking_sessions
          WHERE truck_id = ?
            AND session_status = 'active'
          ORDER BY started_at DESC, id DESC
        `,
        [ticket.truck_id]
      );

      if (activeRows.length === 0) {
        throw new DispatchServiceError(
          "No active tracking session matches this ticket's truck",
          404,
          "ACTIVE_TRACKING_SESSION_NOT_FOUND"
        );
      }
      if (activeRows.length !== 1) {
        throw new DispatchServiceError(
          "Multiple active sessions match this truck; link a session explicitly",
          409,
          "AMBIGUOUS_ACTIVE_TRACKING_SESSION"
        );
      }

      await this.linkSessionInTransaction(
        connection,
        ticket.id,
        activeRows[0].id,
        "active_truck_match",
        actor,
        ticket
      );
    });
    return this.getTicketDetails(ticketId);
  }

  async getLiveDispatches() {
    const [rows] = await this.query(
      `
        SELECT
          dt.id AS dispatch_ticket_id,
          dt.ticket_number,
          dt.truck_id,
          dt.truck_name_snapshot,
          dt.route_name,
          dt.assigned_personnel_id,
          dt.assigned_personnel_name,
          dt.status AS dispatch_status,
          dt.actual_start_at,
          dt.returning_to_wmo_at,
          dts.tracking_session_id,
          dts.linked_at,
          tts.session_status AS tracking_session_status,
          tts.started_at AS tracking_started_at,
          tts.last_updated_at AS tracking_last_updated_at,
          tll.latitude AS last_latitude,
          tll.longitude AS last_longitude,
          tll.last_updated_at AS last_gps_update,
          tll.status AS gps_status,
          current_stop.id AS current_stop_id,
          current_stop.stop_order AS current_stop_order,
          current_stop.location_name AS current_stop_name,
          current_stop.latitude AS current_stop_latitude,
          current_stop.longitude AS current_stop_longitude,
          current_stop.geofence_radius_meters,
          current_stop.stop_status AS current_stop_status,
          next_stop.id AS next_stop_id,
          next_stop.stop_order AS next_stop_order,
          next_stop.location_name AS next_stop_name,
          next_stop.latitude AS next_stop_latitude,
          next_stop.longitude AS next_stop_longitude,
          next_stop.stop_status AS next_stop_status,
          totals.total_stops,
          totals.completed_stops,
          totals.skipped_stops
        FROM dispatch_tickets dt
        INNER JOIN dispatch_tracking_sessions dts
          ON dts.dispatch_ticket_id = dt.id
         AND dts.unlinked_at IS NULL
         AND dts.is_primary = 1
        INNER JOIN truck_tracking_sessions tts
          ON tts.id = dts.tracking_session_id
        LEFT JOIN truck_last_locations tll
          ON tll.session_id = dts.tracking_session_id
        LEFT JOIN dispatch_route_stops current_stop
          ON current_stop.id = (
            SELECT drs_current.id
            FROM dispatch_route_stops drs_current
            WHERE drs_current.dispatch_ticket_id = dt.id
              AND drs_current.stop_status NOT IN ('completed', 'skipped')
            ORDER BY drs_current.stop_order ASC, drs_current.id ASC
            LIMIT 1
          )
        LEFT JOIN dispatch_route_stops next_stop
          ON next_stop.id = (
            SELECT drs_next.id
            FROM dispatch_route_stops drs_next
            WHERE drs_next.dispatch_ticket_id = dt.id
              AND drs_next.stop_status NOT IN ('completed', 'skipped')
              AND drs_next.stop_order > COALESCE(current_stop.stop_order, 0)
            ORDER BY drs_next.stop_order ASC, drs_next.id ASC
            LIMIT 1
          )
        LEFT JOIN (
          SELECT
            dispatch_ticket_id,
            COUNT(*) AS total_stops,
            SUM(stop_status = 'completed') AS completed_stops,
            SUM(stop_status = 'skipped') AS skipped_stops
          FROM dispatch_route_stops
          GROUP BY dispatch_ticket_id
        ) totals
          ON totals.dispatch_ticket_id = dt.id
        WHERE dt.status IN ('dispatched', 'in_progress', 'returning_to_wmo')
        ORDER BY dt.updated_at DESC, dt.id DESC
      `
    );

    return rows.reduce((result, row) => {
      result[String(row.tracking_session_id)] = row;
      return result;
    }, {});
  }

  async getTicketByTrackingSession(trackingSessionId) {
    const sessionId = requiredId(trackingSessionId, "tracking session id");
    const [rows] = await this.query(
      `
        SELECT dispatch_ticket_id
        FROM dispatch_tracking_sessions
        WHERE tracking_session_id = ?
          AND unlinked_at IS NULL
        ORDER BY is_primary DESC, linked_at DESC, id DESC
        LIMIT 1
      `,
      [sessionId]
    );
    if (!rows.length) {
      throw new DispatchServiceError(
        "No dispatch ticket is linked to this tracking session",
        404,
        "DISPATCH_LINK_NOT_FOUND"
      );
    }
    return this.getTicketDetails(rows[0].dispatch_ticket_id);
  }

  async getTicketEvents(ticketId) {
    const id = requiredId(ticketId, "ticket id");
    const [rows] = await this.query(
      `
        SELECT *
        FROM dispatch_events
        WHERE dispatch_ticket_id = ?
        ORDER BY event_at ASC, id ASC
      `,
      [id]
    );
    return rows;
  }

  async getStopForUpdate(connection, ticketId, stopId) {
    const [rows] = await connection.query(
      `
        SELECT *
        FROM dispatch_route_stops
        WHERE id = ?
          AND dispatch_ticket_id = ?
        FOR UPDATE
      `,
      [
        requiredId(stopId, "stop id"),
        requiredId(ticketId, "ticket id")
      ]
    );
    if (!rows.length) {
      throw new DispatchServiceError(
        "Dispatch route stop not found",
        404,
        "DISPATCH_STOP_NOT_FOUND"
      );
    }
    return rows[0];
  }

  async updateNextStop(connection, ticketId) {
    await connection.query(
      `
        UPDATE dispatch_route_stops
        SET stop_status = 'on_the_way',
            updated_at = NOW()
        WHERE dispatch_ticket_id = ?
          AND stop_status = 'pending'
        ORDER BY stop_order ASC, id ASC
        LIMIT 1
      `,
      [ticketId]
    );
  }

  async moveTicketToReturningIfDone(
    connection,
    ticketId,
    eventSource,
    actor,
    trackingSessionId = null,
    eventAt = null
  ) {
    const [remainingRows] = await connection.query(
      `
        SELECT id
        FROM dispatch_route_stops
        WHERE dispatch_ticket_id = ?
          AND stop_status NOT IN ('completed', 'skipped')
        LIMIT 1
      `,
      [ticketId]
    );
    if (remainingRows.length) return false;

    const [ticketRows] = await connection.query(
      "SELECT status FROM dispatch_tickets WHERE id = ? FOR UPDATE",
      [ticketId]
    );
    if (!ticketRows.length || ["completed", "cancelled"].includes(ticketRows[0].status)) {
      return false;
    }

    const alreadyReturning = ticketRows[0].status === "returning_to_wmo";
    await connection.query(
      `
        UPDATE dispatch_tickets
        SET status = 'returning_to_wmo',
            returning_to_wmo_at = COALESCE(returning_to_wmo_at, ?, NOW()),
            updated_at = NOW()
        WHERE id = ?
      `,
      [eventAt, ticketId]
    );
    if (!alreadyReturning) {
      await this.insertEvent(connection, {
        dispatch_ticket_id: ticketId,
        tracking_session_id: trackingSessionId,
        event_type: "returning_to_wmo",
        event_at: eventAt,
        event_source: eventSource,
        ...actor,
        idempotency_key: `returning-to-wmo:${ticketId}`
      });
    }
    return true;
  }

  async arriveAtStop(ticketId, stopId, payload = {}) {
    const actor = normalizeActor(payload);
    await this.withTransaction(async (connection) => {
      await this.getTicketForUpdate(connection, ticketId);
      const stop = await this.getStopForUpdate(connection, ticketId, stopId);
      if (stop.stop_status === "arrived") return;
      if (TERMINAL_STOP_STATUSES.has(stop.stop_status)) {
        throw new DispatchServiceError(
          "A terminal stop cannot be marked arrived",
          409,
          "DISPATCH_STOP_TERMINAL"
        );
      }

      await connection.query(
        `
          UPDATE dispatch_route_stops
          SET stop_status = 'arrived',
              actual_arrival_at = COALESCE(actual_arrival_at, NOW()),
              arrival_source = 'manual',
              arrival_candidate_at = NULL,
              arrival_candidate_count = 0,
              updated_at = NOW()
          WHERE id = ?
        `,
        [stop.id]
      );
      await connection.query(
        `
          UPDATE dispatch_tickets
          SET status = 'in_progress',
              updated_at = NOW()
          WHERE id = ?
            AND status = 'dispatched'
        `,
        [ticketId]
      );
      await this.insertEvent(connection, {
        dispatch_ticket_id: ticketId,
        dispatch_route_stop_id: stop.id,
        event_type: "arrived_at_stop",
        event_source: "manual",
        ...actor,
        idempotency_key: `manual-arrive:${ticketId}:${stop.id}`
      });
    });
    return this.getTicketDetails(ticketId);
  }

  async completeStop(ticketId, stopId, payload = {}) {
    const actor = normalizeActor(payload);
    await this.withTransaction(async (connection) => {
      await this.getTicketForUpdate(connection, ticketId);
      const stop = await this.getStopForUpdate(connection, ticketId, stopId);
      if (stop.stop_status === "completed") return;
      if (stop.stop_status === "skipped") {
        throw new DispatchServiceError(
          "A skipped stop cannot be completed",
          409,
          "DISPATCH_STOP_SKIPPED"
        );
      }

      await connection.query(
        `
          UPDATE dispatch_route_stops
          SET stop_status = 'completed',
              actual_departure_at = COALESCE(actual_departure_at, NOW()),
              departure_source = 'manual',
              stop_duration_seconds = CASE
                WHEN actual_arrival_at IS NULL THEN stop_duration_seconds
                ELSE TIMESTAMPDIFF(
                  SECOND,
                  actual_arrival_at,
                  COALESCE(actual_departure_at, NOW())
                )
              END,
              completed_at = COALESCE(completed_at, NOW()),
              departure_candidate_at = NULL,
              departure_candidate_count = 0,
              updated_at = NOW()
          WHERE id = ?
        `,
        [stop.id]
      );
      await this.insertEvent(connection, {
        dispatch_ticket_id: ticketId,
        dispatch_route_stop_id: stop.id,
        event_type: "stop_completed",
        event_source: "manual",
        ...actor,
        idempotency_key: `manual-complete:${ticketId}:${stop.id}`
      });
      await this.updateNextStop(connection, ticketId);
      await this.moveTicketToReturningIfDone(
        connection,
        ticketId,
        "manual",
        actor
      );
    });
    return this.getTicketDetails(ticketId);
  }

  async skipStop(ticketId, stopId, payload = {}) {
    const reason = cleanText(payload.reason || payload.skip_reason, 1000);
    if (!reason) throw new DispatchServiceError("Skip reason is required");
    const actor = normalizeActor(payload);

    await this.withTransaction(async (connection) => {
      await this.getTicketForUpdate(connection, ticketId);
      const stop = await this.getStopForUpdate(connection, ticketId, stopId);
      if (stop.stop_status === "skipped") return;
      if (stop.stop_status === "completed") {
        throw new DispatchServiceError(
          "A completed stop cannot be skipped",
          409,
          "DISPATCH_STOP_COMPLETED"
        );
      }

      await connection.query(
        `
          UPDATE dispatch_route_stops
          SET stop_status = 'skipped',
              skip_reason = ?,
              skipped_at = COALESCE(skipped_at, NOW()),
              updated_at = NOW()
          WHERE id = ?
        `,
        [reason, stop.id]
      );
      await this.insertEvent(connection, {
        dispatch_ticket_id: ticketId,
        dispatch_route_stop_id: stop.id,
        event_type: "stop_skipped",
        event_source: "manual",
        ...actor,
        details: { reason },
        idempotency_key: `manual-skip:${ticketId}:${stop.id}`
      });
      await this.updateNextStop(connection, ticketId);
      await this.moveTicketToReturningIfDone(
        connection,
        ticketId,
        "manual",
        actor
      );
    });
    return this.getTicketDetails(ticketId);
  }

  async markReturning(ticketId, payload = {}) {
    const actor = normalizeActor(payload);
    await this.withTransaction(async (connection) => {
      const ticket = await this.getTicketForUpdate(connection, ticketId);
      if (ticket.status === "returning_to_wmo") return;
      if (["completed", "cancelled", "prepared"].includes(ticket.status)) {
        throw new DispatchServiceError(
          "This dispatch ticket cannot be marked as returning",
          409,
          "DISPATCH_RETURN_NOT_ALLOWED"
        );
      }
      await connection.query(
        `
          UPDATE dispatch_tickets
          SET status = 'returning_to_wmo',
              returning_to_wmo_at = COALESCE(returning_to_wmo_at, NOW()),
              updated_at = NOW()
          WHERE id = ?
        `,
        [ticket.id]
      );
      await this.insertEvent(connection, {
        dispatch_ticket_id: ticket.id,
        event_type: "returning_to_wmo",
        event_source: "manual",
        ...actor,
        idempotency_key: `returning-to-wmo:${ticket.id}`
      });
    });
    return this.getTicketDetails(ticketId);
  }

  async getReports(filters = {}) {
    const clauses = ["dt.status IN ('completed', 'cancelled')"];
    const parameters = [];
    const status = cleanText(filters.status, 40).toLowerCase();
    if (status) {
      if (!["completed", "closed_early", "cancelled"].includes(status)) {
        throw new DispatchServiceError("Invalid dispatch report status");
      }
      if (status === "closed_early") {
        clauses.push("closure_event.id IS NOT NULL");
      } else if (status === "cancelled") {
        clauses.push("dt.status = 'cancelled' AND closure_event.id IS NULL");
      } else {
        clauses.push("dt.status = 'completed'");
      }
    }
    if (filters.date_from) {
      clauses.push("dt.dispatch_date >= ?");
      parameters.push(dateOnly(filters.date_from, "date_from"));
    }
    if (filters.date_to) {
      clauses.push("dt.dispatch_date <= ?");
      parameters.push(dateOnly(filters.date_to, "date_to"));
    }
    if (filters.truck) {
      clauses.push("(dt.truck_id = ? OR dt.truck_name_snapshot LIKE ?)");
      parameters.push(
        cleanText(filters.truck, 100),
        `%${cleanText(filters.truck, 100)}%`
      );
    }

    const [rows] = await this.query(
      `
        SELECT
          dt.id,
          dt.ticket_number,
          dt.truck_id,
          dt.truck_name_snapshot,
          dt.assigned_personnel_id,
          dt.assigned_personnel_name,
          dt.dispatch_date,
          dt.route_name,
          CASE
            WHEN closure_event.id IS NOT NULL THEN 'closed_early'
            ELSE dt.status
          END AS status,
          dt.status AS stored_status,
          dt.actual_start_at,
          dt.actual_end_at,
          dt.completed_at,
          dt.cancelled_at,
          dt.cancellation_reason,
          dt.created_by_user_id,
          dt.created_by_name,
          closure_event.actor_id AS closed_by_user_id,
          closure_event.actor_name AS closed_by_name,
          closure_event.event_at AS closed_at,
          return_event.event_at AS returned_to_wmo_at,
          primary_link.tracking_session_id,
          CASE
            WHEN COALESCE(route_counts.route_logs_count, 0) > 0
              THEN tracking_session.session_distance_km
            ELSE NULL
          END AS actual_distance_km,
          COALESCE(route_counts.route_logs_count, 0) AS actual_gps_point_count,
          COALESCE(stop_summary.total_stops, 0) AS total_stops,
          stop_summary.completed_stops,
          stop_summary.skipped_stops,
          COALESCE(stop_summary.total_stop_duration_seconds, 0) AS total_stop_duration_seconds,
          TIMESTAMPDIFF(
            SECOND,
            dt.actual_start_at,
            dt.actual_end_at
          ) AS total_dispatch_duration_seconds
        FROM dispatch_tickets dt
        LEFT JOIN (
          SELECT
            dispatch_ticket_id,
            COUNT(*) AS total_stops,
            SUM(stop_status = 'completed') AS completed_stops,
            SUM(stop_status = 'skipped') AS skipped_stops,
            SUM(COALESCE(stop_duration_seconds, 0)) AS total_stop_duration_seconds
          FROM dispatch_route_stops
          GROUP BY dispatch_ticket_id
        ) stop_summary
          ON stop_summary.dispatch_ticket_id = dt.id
        LEFT JOIN dispatch_events closure_event
          ON closure_event.id = (
            SELECT de_close.id
            FROM dispatch_events de_close
            WHERE de_close.dispatch_ticket_id = dt.id
              AND de_close.event_type = 'dispatch_closed_early'
            ORDER BY de_close.event_at DESC, de_close.id DESC
            LIMIT 1
          )
        LEFT JOIN dispatch_events return_event
          ON return_event.id = (
            SELECT de_return.id
            FROM dispatch_events de_return
            WHERE de_return.dispatch_ticket_id = dt.id
              AND de_return.event_type = 'returned_to_wmo'
            ORDER BY de_return.event_at DESC, de_return.id DESC
            LIMIT 1
          )
        LEFT JOIN dispatch_tracking_sessions primary_link
          ON primary_link.id = (
            SELECT dts_report.id
            FROM dispatch_tracking_sessions dts_report
            WHERE dts_report.dispatch_ticket_id = dt.id
              AND dts_report.unlinked_at IS NULL
            ORDER BY dts_report.is_primary DESC, dts_report.linked_at DESC, dts_report.id DESC
            LIMIT 1
          )
        LEFT JOIN truck_tracking_sessions tracking_session
          ON tracking_session.id = primary_link.tracking_session_id
        LEFT JOIN (
          SELECT session_id, COUNT(*) AS route_logs_count
          FROM truck_location_logs
          GROUP BY session_id
        ) route_counts
          ON route_counts.session_id = primary_link.tracking_session_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY
          COALESCE(dt.actual_end_at, dt.completed_at, dt.cancelled_at, dt.updated_at) DESC,
          dt.id DESC
      `,
      parameters
    );
    return rows;
  }

  async getReportDetails(ticketId) {
    const details = await this.getTicketDetails(ticketId);
    const { ticket, stops, tracking_sessions: sessions, events } = details;
    if (!["completed", "cancelled"].includes(ticket.status)) {
      throw new DispatchServiceError(
        "Dispatch report is not available for an active ticket",
        404,
        "DISPATCH_REPORT_NOT_FOUND"
      );
    }

    const primarySession = sessions[0] || null;
    let routeLogs = [];
    if (primarySession?.tracking_session_id) {
      [routeLogs] = await this.query(
        `
          SELECT
            id,
            session_id,
            truck_id,
            latitude,
            longitude,
            speed,
            accuracy,
            heading,
            altitude,
            sync_source,
            recorded_at
          FROM truck_location_logs
          WHERE session_id = ?
          ORDER BY recorded_at ASC, id ASC
        `,
        [primarySession.tracking_session_id]
      );
    }

    const closureEvent = events.find(
      (event) => event.event_type === "dispatch_closed_early"
    ) || null;
    const returnedEvent = events.find(
      (event) => event.event_type === "returned_to_wmo"
    ) || null;
    const issuedEvent = events.find(
      (event) => event.event_type === "ticket_issued"
    ) || null;
    const closureDetails = parseEventDetails(closureEvent?.details);
    const plannedRouteSnapshot = storedDispatchPlannedRouteSnapshot(issuedEvent?.details);
    const endedAt = closureEvent
      ? ticket.actual_end_at || ticket.cancelled_at || closureEvent.event_at
      : ticket.actual_end_at || ticket.completed_at || null;
    const measuredDistance =
      routeLogs.length > 0 && primarySession?.session_distance_km !== null
        ? Number(primarySession.session_distance_km)
        : null;
    const recordedStopDurations = stops
      .map((stop) => stop.stop_duration_seconds)
      .filter((value) => value !== null && value !== undefined)
      .map(Number)
      .filter((value) => Number.isFinite(value) && value >= 0);
    const totalStopDurationSeconds = recordedStopDurations.length
      ? recordedStopDurations.reduce((total, duration) => total + duration, 0)
      : null;

    return {
      ticket: {
        ...ticket,
        report_status: closureEvent ? "closed_early" : ticket.status,
        ended_at: endedAt,
        closure_reason: closureEvent
          ? closureDetails.reason || ticket.cancellation_reason || null
          : null,
        closed_by_user_id: closureEvent?.actor_id || null,
        closed_by_name: closureEvent?.actor_name || null,
        closed_at: closureEvent?.event_at || null,
        returned_to_wmo_at: returnedEvent?.event_at || null
      },
      stops,
      tracking_session: primarySession,
      route_logs: routeLogs,
      planned_route_snapshot: plannedRouteSnapshot,
      progress: details.progress,
      events,
      metrics: {
        dispatch_duration_seconds: durationSecondsBetween(
          ticket.actual_start_at,
          endedAt
        ),
        actual_distance_km:
          Number.isFinite(measuredDistance) ? measuredDistance : null,
        actual_gps_point_count: routeLogs.length,
        destination_count: stops.length,
        completed_stops: stops.filter(
          (stop) => stop.stop_status === "completed"
        ).length,
        skipped_stops: stops.filter(
          (stop) => stop.stop_status === "skipped"
        ).length,
        total_stop_duration_seconds: totalStopDurationSeconds,
        returned_to_wmo_at: returnedEvent?.event_at || null
      }
    };
  }

  async reconcileAutomaticStopEvent(
    connection,
    relation,
    stop,
    event,
    existingEvent,
    idempotencyKey
  ) {
    if (!event) {
      if (existingEvent?.id && existingEvent.event_source === "automatic") {
        await connection.query(
          `
            DELETE FROM dispatch_events
            WHERE id = ?
              AND event_source = 'automatic'
          `,
          [existingEvent.id]
        );
      }
      return;
    }

    const details = JSON.stringify(event.details || {});
    if (existingEvent?.id) {
      if (existingEvent.event_source !== "automatic") return;
      await connection.query(
        `
          UPDATE dispatch_events
          SET tracking_session_id = ?,
              event_at = ?,
              latitude = ?,
              longitude = ?,
              accuracy_meters = ?,
              details = ?
          WHERE id = ?
            AND event_source = 'automatic'
        `,
        [
          relation.tracking_session_id,
          event.event_at,
          event.latitude,
          event.longitude,
          event.accuracy_meters,
          details,
          existingEvent.id
        ]
      );
      return;
    }

    await this.insertEvent(connection, {
      dispatch_ticket_id: relation.dispatch_ticket_id,
      dispatch_route_stop_id: stop.id,
      tracking_session_id: relation.tracking_session_id,
      event_type: event.event_type,
      event_at: event.event_at,
      event_source: "automatic",
      actor_type: "system",
      latitude: event.latitude,
      longitude: event.longitude,
      accuracy_meters: event.accuracy_meters,
      details: event.details,
      idempotency_key: idempotencyKey
    });
  }

  async persistAutomaticHistoryStop(connection, replayState, stop) {
    if (stop.preserve_entirely) return;

    const arrivalAt = stop.manual_arrival
      ? stop.manual_arrival_at
      : stop.replay_arrival_at;
    const departureAt = stop.manual_departure
      ? stop.manual_departure_at
      : stop.replay_departure_at;
    const arrivalSource = stop.manual_arrival
      ? "manual"
      : (arrivalAt ? "automatic" : null);
    const departureSource = stop.manual_departure
      ? "manual"
      : (departureAt ? "automatic" : null);
    const durationSeconds = departureAt && arrivalAt
      ? durationSecondsBetween(arrivalAt, departureAt)
      : null;
    const stopStatus = departureAt
      ? "completed"
      : (arrivalAt
        ? "arrived"
        : (stop.replay_index === replayState.current_stop_index
          ? "on_the_way"
          : "pending"));
    const completedAt = stop.manual_departure
      ? stop.completed_at || departureAt
      : departureAt;

    await connection.query(
      `
        UPDATE dispatch_route_stops
        SET stop_status = ?,
            actual_arrival_at = ?,
            arrival_source = ?,
            arrival_candidate_at = ?,
            arrival_candidate_count = ?,
            actual_departure_at = ?,
            departure_source = ?,
            departure_candidate_at = ?,
            departure_candidate_count = ?,
            stop_duration_seconds = ?,
            completed_at = ?,
            updated_at = NOW()
        WHERE id = ?
      `,
      [
        stopStatus,
        arrivalAt,
        arrivalSource,
        stop.replay_arrival_candidate_at,
        stop.replay_arrival_candidate_count,
        departureAt,
        departureSource,
        stop.replay_departure_candidate_at,
        stop.replay_departure_candidate_count,
        durationSeconds,
        completedAt,
        stop.id
      ]
    );
  }

  async reconcileAutomaticDispatchHistory(relationId) {
    const relationKey = requiredId(relationId, "dispatch tracking relation id");
    return this.withTransaction(async (connection) => {
      const [relationRows] = await connection.query(
        `
          SELECT
            dts.*,
            dt.status AS dispatch_status,
            dt.actual_end_at,
            dt.cancelled_at,
            dt.completed_at AS dispatch_completed_at,
            tts.session_status,
            tts.started_at AS tracking_started_at,
            tts.ended_at AS tracking_ended_at
          FROM dispatch_tracking_sessions dts
          INNER JOIN dispatch_tickets dt
            ON dt.id = dts.dispatch_ticket_id
          INNER JOIN truck_tracking_sessions tts
            ON tts.id = dts.tracking_session_id
          WHERE dts.id = ?
            AND dts.unlinked_at IS NULL
          FOR UPDATE
        `,
        [relationKey]
      );
      if (!relationRows.length) {
        return { replayed: false, reason: "relation_not_found" };
      }

      const relation = relationRows[0];
      const [stopRows] = await connection.query(
        `
          SELECT *
          FROM dispatch_route_stops
          WHERE dispatch_ticket_id = ?
          ORDER BY stop_order ASC, id ASC
          FOR UPDATE
        `,
        [relation.dispatch_ticket_id]
      );
      const [eventRows] = await connection.query(
        `
          SELECT *
          FROM dispatch_events
          WHERE dispatch_ticket_id = ?
            AND event_type IN (
              'arrived_at_stop',
              'departed_stop',
              'stop_completed',
              'stop_skipped',
              'returning_to_wmo'
            )
          ORDER BY event_at ASC, id ASC
          FOR UPDATE
        `,
        [relation.dispatch_ticket_id]
      );
      const [boundaryRows] = await connection.query(
        `
          SELECT COALESCE(MAX(id), 0) AS max_location_log_id
          FROM truck_location_logs
          WHERE session_id = ?
        `,
        [relation.tracking_session_id]
      );
      const maxLocationLogId = Number(
        boundaryRows[0]?.max_location_log_id || 0
      );
      const replayState = createDispatchHistoryReplayState(
        stopRows,
        eventRows,
        { ticketStatus: relation.dispatch_status }
      );
      const cutoffAt = [
        relation.actual_end_at,
        relation.cancelled_at,
        relation.dispatch_completed_at,
        relation.session_status === "active" ? null : relation.tracking_ended_at
      ]
        .map((value) => parseManilaTimestamp(value))
        .filter(Number.isFinite)
        .sort((left, right) => left - right)[0];
      const referenceTimeMs = this.now().getTime();
      const trackingStartedAtMs = parseManilaTimestamp(
        relation.tracking_started_at
      );
      let afterRecordedAt = null;
      let afterId = 0;
      let pagesProcessed = 0;
      let rowsProcessed = 0;

      while (maxLocationLogId > 0) {
        const parameters = [
          relation.tracking_session_id,
          maxLocationLogId
        ];
        const afterClause = afterRecordedAt
          ? `
              AND (
                recorded_at > ?
                OR (recorded_at = ? AND id > ?)
              )
            `
          : "";
        if (afterRecordedAt) {
          parameters.push(afterRecordedAt, afterRecordedAt, afterId);
        }
        parameters.push(DISPATCH_HISTORY_REPLAY_PAGE_SIZE);

        const [locationRows] = await connection.query(
          `
            SELECT
              id,
              session_id,
              latitude,
              longitude,
              accuracy,
              DATE_FORMAT(recorded_at, '%Y-%m-%d %H:%i:%s') AS recorded_at
            FROM truck_location_logs
            WHERE session_id = ?
              AND id <= ?
              ${afterClause}
            ORDER BY recorded_at ASC, id ASC
            LIMIT ?
          `,
          parameters
        );
        if (!locationRows.length) break;

        pagesProcessed += 1;
        rowsProcessed += locationRows.length;
        for (const locationLog of locationRows) {
          applyDispatchHistoryLocation(replayState, locationLog, {
            referenceTimeMs,
            startMs: trackingStartedAtMs,
            cutoffMs: cutoffAt
          });
        }

        const lastLocation = locationRows[locationRows.length - 1];
        const nextAfterRecordedAt = normalizedHistoryTimestamp(
          lastLocation.recorded_at
        );
        const nextAfterId = Number(lastLocation.id);
        if (
          !nextAfterRecordedAt ||
          (nextAfterRecordedAt === afterRecordedAt && nextAfterId <= afterId)
        ) {
          throw new DispatchServiceError(
            "Dispatch history replay made no paging progress",
            500,
            "DISPATCH_HISTORY_REPLAY_STALLED"
          );
        }
        afterRecordedAt = nextAfterRecordedAt;
        afterId = nextAfterId;

        if (locationRows.length < DISPATCH_HISTORY_REPLAY_PAGE_SIZE) break;
      }

      for (const stop of replayState.stops) {
        await this.persistAutomaticHistoryStop(connection, replayState, stop);
        if (stop.preserve_entirely) continue;
        await this.reconcileAutomaticStopEvent(
          connection,
          relation,
          stop,
          stop.manual_arrival ? null : stop.replay_arrival_event,
          stop.existing_auto_arrival_event,
          `auto-arrive:${relation.dispatch_ticket_id}:${stop.id}`
        );
        await this.reconcileAutomaticStopEvent(
          connection,
          relation,
          stop,
          stop.manual_departure ? null : stop.replay_departure_event,
          stop.existing_auto_departure_event,
          `auto-depart:${relation.dispatch_ticket_id}:${stop.id}`
        );
      }

      if (
        relation.dispatch_status === "dispatched" &&
        replayState.stops.some((stop) => Boolean(stop.replay_arrival_at))
      ) {
        await connection.query(
          `
            UPDATE dispatch_tickets
            SET status = 'in_progress',
                updated_at = NOW()
            WHERE id = ?
              AND status = 'dispatched'
          `,
          [relation.dispatch_ticket_id]
        );
      }

      const allStopsTerminal = replayState.stops.length > 0 &&
        replayState.stops.every((stop) => {
          if (stop.preserve_entirely) {
            return TERMINAL_STOP_STATUSES.has(stop.stop_status);
          }
          return Boolean(stop.replay_departure_at || stop.manual_departure_at);
        });
      const returningEvent = eventRows.find(
        (event) => event.event_type === "returning_to_wmo"
      );
      if (allStopsTerminal) {
        const finalTransitionAt = replayState.stops
          .map((stop) => stop.replay_departure_at || stop.manual_terminal_at)
          .filter(Boolean)
          .sort()
          .at(-1) || null;
        if (
          finalTransitionAt &&
          returningEvent?.event_source === "automatic"
        ) {
          await connection.query(
            `
              UPDATE dispatch_tickets
              SET returning_to_wmo_at = ?,
                  updated_at = NOW()
              WHERE id = ?
            `,
            [finalTransitionAt, relation.dispatch_ticket_id]
          );
          await connection.query(
            `
              UPDATE dispatch_events
              SET tracking_session_id = ?,
                  event_at = ?
              WHERE id = ?
                AND event_source = 'automatic'
            `,
            [
              relation.tracking_session_id,
              finalTransitionAt,
              returningEvent.id
            ]
          );
        } else if (
          finalTransitionAt &&
          ["dispatched", "in_progress", "returning_to_wmo"].includes(
            relation.dispatch_status
          )
        ) {
          await this.moveTicketToReturningIfDone(
            connection,
            relation.dispatch_ticket_id,
            "automatic",
            { actor_type: "system", actor_id: null, actor_name: null },
            relation.tracking_session_id,
            finalTransitionAt
          );
        }
      } else if (
        !allStopsTerminal &&
        relation.dispatch_status === "returning_to_wmo" &&
        returningEvent?.event_source === "automatic"
      ) {
        const hasArrival = replayState.stops.some(
          (stop) => Boolean(stop.replay_arrival_at || stop.manual_arrival_at)
        );
        await connection.query(
          `
            UPDATE dispatch_tickets
            SET status = ?,
                returning_to_wmo_at = NULL,
                updated_at = NOW()
            WHERE id = ?
              AND status = 'returning_to_wmo'
          `,
          [
            hasArrival ? "in_progress" : "dispatched",
            relation.dispatch_ticket_id
          ]
        );
        await connection.query(
          `
            DELETE FROM dispatch_events
            WHERE id = ?
              AND event_source = 'automatic'
          `,
          [returningEvent.id]
        );
      }

      await connection.query(
        `
          UPDATE dispatch_tracking_sessions
          SET last_processed_location_log_id = GREATEST(
            COALESCE(last_processed_location_log_id, 0),
            ?
          )
          WHERE id = ?
        `,
        [maxLocationLogId, relationKey]
      );

      return {
        replayed: true,
        max_location_log_id: maxLocationLogId,
        pages_processed: pagesProcessed,
        rows_processed: rowsProcessed,
        qualified_rows: replayState.qualified_rows,
        ignored_rows: replayState.ignored_rows
      };
    });
  }

  async processAutomaticLocationLog(relationId, locationLog) {
    const relationKey = requiredId(relationId, "dispatch tracking relation id");
    const logId = requiredId(locationLog.id, "location log id");
    await this.withTransaction(async (connection) => {
      const [relationRows] = await connection.query(
        `
          SELECT
            dts.*,
            dt.status AS dispatch_status
          FROM dispatch_tracking_sessions dts
          INNER JOIN dispatch_tickets dt
            ON dt.id = dts.dispatch_ticket_id
          WHERE dts.id = ?
            AND dts.unlinked_at IS NULL
          FOR UPDATE
        `,
        [relationKey]
      );
      if (!relationRows.length) return;

      const relation = relationRows[0];
      if (
        String(locationLog.session_id) !== String(relation.tracking_session_id)
      ) {
        return;
      }

      if (["completed", "cancelled"].includes(relation.dispatch_status)) {
        await connection.query(
          `
            UPDATE dispatch_tracking_sessions
            SET last_processed_location_log_id = GREATEST(
              COALESCE(last_processed_location_log_id, 0),
              ?
            )
            WHERE id = ?
          `,
          [logId, relationKey]
        );
        return;
      }

      const [stopRows] = await connection.query(
        `
          SELECT *
          FROM dispatch_route_stops
          WHERE dispatch_ticket_id = ?
            AND stop_status NOT IN ('completed', 'skipped')
          ORDER BY stop_order ASC, id ASC
          LIMIT 1
          FOR UPDATE
        `,
        [relation.dispatch_ticket_id]
      );

      const stop = stopRows[0];
      const evidence = qualifyDispatchStopEvidence(locationLog, {
        referenceTimeMs: this.now().getTime()
      });

      if (stop) {
        const qualifiedLocationLog = evidence.qualified
          ? { ...locationLog, ...evidence.point }
          : locationLog;
        const distance = evidence.qualified
          ? haversineMeters(
              evidence.point.latitude,
              evidence.point.longitude,
              Number(stop.latitude),
              Number(stop.longitude)
            )
          : null;

        if (stop.stop_status !== "arrived") {
          const arrivalQualifies =
            evidence.qualified &&
            distance <= Number(stop.geofence_radius_meters);
          await this.advanceArrivalCandidate(
            connection,
            relation,
            stop,
            qualifiedLocationLog,
            arrivalQualifies,
            distance
          );
        } else {
          const departureQualifies =
            evidence.qualified &&
            distance >
              Number(stop.geofence_radius_meters) +
                DISPATCH_STOP_TRANSITION_RULES.departureHysteresisMeters;
          await this.advanceDepartureCandidate(
            connection,
            relation,
            stop,
            qualifiedLocationLog,
            departureQualifies,
            distance
          );
        }
      }

      await connection.query(
        `
          UPDATE dispatch_tracking_sessions
          SET last_processed_location_log_id = GREATEST(
            COALESCE(last_processed_location_log_id, 0),
            ?
          )
          WHERE id = ?
        `,
        [logId, relationKey]
      );
    });
  }

  async getPreviousLocationLog(connection, locationLog) {
    const [rows] = await connection.query(
      `
        SELECT id, recorded_at
        FROM truck_location_logs
        WHERE session_id = ?
          AND (
            recorded_at < ?
            OR (recorded_at = ? AND id < ?)
          )
        ORDER BY recorded_at DESC, id DESC
        LIMIT 1
      `,
      [
        locationLog.session_id,
        locationLog.recorded_at,
        locationLog.recorded_at,
        locationLog.id
      ]
    );
    return rows[0] || null;
  }

  async advanceArrivalCandidate(
    connection,
    relation,
    stop,
    locationLog,
    qualifies,
    distance
  ) {
    if (!qualifies) {
      await connection.query(
        `
          UPDATE dispatch_route_stops
          SET arrival_candidate_at = NULL,
              arrival_candidate_count = 0,
              updated_at = NOW()
          WHERE id = ?
        `,
        [stop.id]
      );
      return;
    }

    const previousLog = await this.getPreviousLocationLog(connection, locationLog);
    const candidate = evaluateDispatchTransitionCandidate(
      "arrival",
      stop.arrival_candidate_at,
      stop.arrival_candidate_count,
      locationLog,
      previousLog ? parseManilaTimestamp(previousLog.recorded_at) : null
    );
    const { candidateAt, candidateCount } = candidate;

    if (candidate.confirmed) {
      const [arrivalResult] = await connection.query(
        `
          UPDATE dispatch_route_stops
          SET stop_status = 'arrived',
              actual_arrival_at = COALESCE(actual_arrival_at, ?),
              arrival_source = 'automatic',
              arrival_candidate_at = NULL,
              arrival_candidate_count = 0,
              updated_at = NOW()
          WHERE id = ?
            AND stop_status NOT IN ('arrived', 'completed', 'skipped')
        `,
        [candidateAt, stop.id]
      );

      if (!arrivalResult || Number(arrivalResult.affectedRows || 0) === 0) {
        return;
      }

      await connection.query(
        `
          UPDATE dispatch_tickets
          SET status = 'in_progress',
              updated_at = NOW()
          WHERE id = ?
            AND status = 'dispatched'
        `,
        [relation.dispatch_ticket_id]
      );
      await this.insertEvent(connection, {
        dispatch_ticket_id: relation.dispatch_ticket_id,
        dispatch_route_stop_id: stop.id,
        tracking_session_id: relation.tracking_session_id,
        event_type: "arrived_at_stop",
        event_at: candidateAt,
        event_source: "automatic",
        actor_type: "system",
        latitude: locationLog.latitude,
        longitude: locationLog.longitude,
        accuracy_meters: locationLog.accuracy,
        details: {
          distance_meters: Math.round(distance),
          confirmed_at: locationLog.recorded_at,
          confirming_location_log_id: locationLog.id,
          candidate_sample_count: candidateCount
        },
        idempotency_key: `auto-arrive:${relation.dispatch_ticket_id}:${stop.id}`
      });
      return;
    }

    await connection.query(
      `
        UPDATE dispatch_route_stops
        SET arrival_candidate_at = ?,
            arrival_candidate_count = ?,
            updated_at = NOW()
        WHERE id = ?
      `,
      [candidateAt, candidateCount, stop.id]
    );
  }

  async advanceDepartureCandidate(
    connection,
    relation,
    stop,
    locationLog,
    qualifies,
    distance
  ) {
    if (!qualifies) {
      await connection.query(
        `
          UPDATE dispatch_route_stops
          SET departure_candidate_at = NULL,
              departure_candidate_count = 0,
              updated_at = NOW()
          WHERE id = ?
        `,
        [stop.id]
      );
      return;
    }

    const previousLog = await this.getPreviousLocationLog(connection, locationLog);
    const candidate = evaluateDispatchTransitionCandidate(
      "departure",
      stop.departure_candidate_at,
      stop.departure_candidate_count,
      locationLog,
      previousLog ? parseManilaTimestamp(previousLog.recorded_at) : null
    );
    const { candidateAt, candidateCount } = candidate;

    if (candidate.confirmed) {
      const arrivalTime = parseManilaTimestamp(stop.actual_arrival_at);
      const departureTime = parseManilaTimestamp(candidateAt);
      if (
        !Number.isFinite(arrivalTime) ||
        !Number.isFinite(departureTime) ||
        departureTime < arrivalTime
      ) {
        await connection.query(
          `
            UPDATE dispatch_route_stops
            SET departure_candidate_at = NULL,
                departure_candidate_count = 0,
                updated_at = NOW()
            WHERE id = ?
          `,
          [stop.id]
        );
        return;
      }

      const [departureResult] = await connection.query(
        `
          UPDATE dispatch_route_stops
          SET stop_status = 'completed',
              actual_departure_at = COALESCE(actual_departure_at, ?),
              departure_source = 'automatic',
              stop_duration_seconds = CASE
                WHEN actual_arrival_at IS NULL THEN stop_duration_seconds
                WHEN ? < actual_arrival_at THEN stop_duration_seconds
                ELSE TIMESTAMPDIFF(SECOND, actual_arrival_at, ?)
              END,
              completed_at = COALESCE(completed_at, ?),
              departure_candidate_at = NULL,
              departure_candidate_count = 0,
              updated_at = NOW()
          WHERE id = ?
            AND stop_status = 'arrived'
        `,
        [
          candidateAt,
          candidateAt,
          candidateAt,
          candidateAt,
          stop.id
        ]
      );

      if (!departureResult || Number(departureResult.affectedRows || 0) === 0) {
        return;
      }

      await this.insertEvent(connection, {
        dispatch_ticket_id: relation.dispatch_ticket_id,
        dispatch_route_stop_id: stop.id,
        tracking_session_id: relation.tracking_session_id,
        event_type: "departed_stop",
        event_at: candidateAt,
        event_source: "automatic",
        actor_type: "system",
        latitude: locationLog.latitude,
        longitude: locationLog.longitude,
        accuracy_meters: locationLog.accuracy,
        details: {
          distance_meters: Math.round(distance),
          confirmed_at: locationLog.recorded_at,
          confirming_location_log_id: locationLog.id,
          candidate_sample_count: candidateCount
        },
        idempotency_key: `auto-depart:${relation.dispatch_ticket_id}:${stop.id}`
      });
      await this.updateNextStop(connection, relation.dispatch_ticket_id);
      await this.moveTicketToReturningIfDone(
        connection,
        relation.dispatch_ticket_id,
        "automatic",
        { actor_type: "system", actor_id: null, actor_name: null },
        relation.tracking_session_id,
        candidateAt
      );
      return;
    }

    await connection.query(
      `
        UPDATE dispatch_route_stops
        SET departure_candidate_at = ?,
            departure_candidate_count = ?,
            updated_at = NOW()
        WHERE id = ?
      `,
      [candidateAt, candidateCount, stop.id]
    );
  }

  async reconcileEndedTrackingSession(relationId, wmoLocation) {
    const relationKey = requiredId(relationId, "dispatch tracking relation id");
    const wmoLatitude = Number(wmoLocation && wmoLocation.latitude);
    const wmoLongitude = Number(wmoLocation && wmoLocation.longitude);
    const wmoRadiusMeters = Number(wmoLocation && wmoLocation.radiusMeters);
    if (
      !Number.isFinite(wmoLatitude) ||
      !Number.isFinite(wmoLongitude) ||
      !Number.isFinite(wmoRadiusMeters)
    ) {
      throw new DispatchServiceError(
        "Dispatch monitor WMO geofence is invalid",
        500,
        "DISPATCH_MONITOR_CONFIGURATION_ERROR"
      );
    }
    await this.withTransaction(async (connection) => {
      const [rows] = await connection.query(
        `
          SELECT
            dts.id,
            dts.dispatch_ticket_id,
            dts.tracking_session_id,
            dt.status AS dispatch_status,
            tts.session_status,
            tts.truck_id,
            tts.started_at,
            tts.ended_at,
            tts.end_latitude,
            tts.end_longitude,
            tts.last_latitude,
            tts.last_longitude
          FROM dispatch_tracking_sessions dts
          INNER JOIN dispatch_tickets dt
            ON dt.id = dts.dispatch_ticket_id
          INNER JOIN truck_tracking_sessions tts
            ON tts.id = dts.tracking_session_id
          WHERE dts.id = ?
            AND dts.unlinked_at IS NULL
          FOR UPDATE
        `,
        [relationKey]
      );
      if (!rows.length) return;
      const relation = rows[0];
      if (relation.session_status === "active") return;
      if (["completed", "cancelled"].includes(relation.dispatch_status)) return;

      const allTerminal = await this.moveTicketToReturningIfDone(
        connection,
        relation.dispatch_ticket_id,
        "automatic",
        { actor_type: "system", actor_id: null, actor_name: null },
        relation.tracking_session_id
      );
      if (!allTerminal) return;

      const [locationRows] = await connection.query(
        `
          SELECT
            latitude,
            longitude,
            accuracy,
            DATE_FORMAT(recorded_at, '%Y-%m-%d %H:%i:%s') AS recorded_at
          FROM truck_location_logs
          WHERE session_id = ?
            AND truck_id = ?
          ORDER BY recorded_at DESC, id DESC
          LIMIT 25
        `,
        [relation.tracking_session_id, relation.truck_id]
      );
      let actualQualification = null;
      const startedAtMs = parseManilaTimestamp(relation.started_at);
      const endedAtMs = parseManilaTimestamp(relation.ended_at);
      for (const locationRow of locationRows || []) {
        const qualification = qualifyGpsPointForOperationalUse(locationRow, {
          referenceTimeMs: Number.isFinite(endedAtMs)
            ? endedAtMs
            : this.now().getTime()
        });
        const pointTimeMs = qualification.point?.timestampMs;
        const withinTrackingPeriod =
          qualification.reliable &&
          (!Number.isFinite(startedAtMs) || pointTimeMs >= startedAtMs) &&
          (!Number.isFinite(endedAtMs) || pointTimeMs <= endedAtMs);
        if (withinTrackingPeriod) {
          actualQualification = qualification;
          break;
        }
      }
      if (!actualQualification) return;

      const hasEndLatitude = relation.end_latitude !== null && relation.end_latitude !== undefined;
      const hasEndLongitude = relation.end_longitude !== null && relation.end_longitude !== undefined;
      let completionPoint = actualQualification.point;

      if (hasEndLatitude || hasEndLongitude) {
        if (!hasEndLatitude || !hasEndLongitude) return;
        let endPoint;
        try {
          endPoint = validateGpsPointForStorage({
            latitude: relation.end_latitude,
            longitude: relation.end_longitude
          }, { allowNumericString: true });
        } catch (error) {
          return;
        }

        const endToCurrentMeters = haversineMeters(
          endPoint.latitude,
          endPoint.longitude,
          actualQualification.point.latitude,
          actualQualification.point.longitude
        );
        const agreementRadiusMeters = Math.max(
          10,
          Number(actualQualification.point.accuracy)
        );
        if (endToCurrentMeters > agreementRadiusMeters) return;
        completionPoint = {
          ...actualQualification.point,
          latitude: endPoint.latitude,
          longitude: endPoint.longitude
        };
      }

      const { latitude, longitude } = completionPoint;

      const distanceToWmo = haversineMeters(
        latitude,
        longitude,
        wmoLatitude,
        wmoLongitude
      );
      if (distanceToWmo > wmoRadiusMeters) return;

      await connection.query(
        `
          UPDATE dispatch_tickets
          SET status = 'completed',
              actual_end_at = COALESCE(actual_end_at, ?, NOW()),
              completed_at = COALESCE(completed_at, NOW()),
              updated_at = NOW()
          WHERE id = ?
            AND status = 'returning_to_wmo'
        `,
        [relation.ended_at, relation.dispatch_ticket_id]
      );
      await this.insertEvent(connection, {
        dispatch_ticket_id: relation.dispatch_ticket_id,
        tracking_session_id: relation.tracking_session_id,
        event_type: "returned_to_wmo",
        event_at: relation.ended_at,
        event_source: "automatic",
        actor_type: "system",
        latitude,
        longitude,
        accuracy_meters: completionPoint.accuracy,
        details: { distance_meters: Math.round(distanceToWmo) },
        idempotency_key: `returned-to-wmo:${relation.dispatch_ticket_id}`
      });
      await this.insertEvent(connection, {
        dispatch_ticket_id: relation.dispatch_ticket_id,
        tracking_session_id: relation.tracking_session_id,
        event_type: "dispatch_completed",
        event_at: relation.ended_at,
        event_source: "automatic",
        actor_type: "system",
        idempotency_key: `dispatch-completed:${relation.dispatch_ticket_id}`
      });
    });
  }
}

const dispatchService = new DispatchService();

module.exports = dispatchService;
module.exports.DispatchService = DispatchService;
module.exports.DispatchServiceError = DispatchServiceError;
module.exports.DispatchDatabaseUnavailableError =
  DispatchDatabaseUnavailableError;
module.exports.DispatchDestinationCatalogUnavailableError =
  DispatchDestinationCatalogUnavailableError;
module.exports.isDispatchTableMissingError = isDispatchTableMissingError;
module.exports.isDestinationCatalogTableMissingError =
  isDestinationCatalogTableMissingError;
module.exports.normalizeDispatchError = normalizeDispatchError;
module.exports.normalizeDestinationSearchText = normalizeDestinationSearchText;
module.exports.destinationLimit = destinationLimit;
module.exports.currentManilaDate = currentManilaDate;
module.exports.DESTINATION_TYPES = DESTINATION_TYPES;
module.exports.TICKET_STATUSES = TICKET_STATUSES;
module.exports.STOP_STATUSES = STOP_STATUSES;
module.exports.ACTIVE_TICKET_STATUSES = ACTIVE_TICKET_STATUSES;
module.exports.NON_TERMINAL_TICKET_STATUSES = NON_TERMINAL_TICKET_STATUSES;
module.exports.END_DISPATCH_REASONS = END_DISPATCH_REASONS;
module.exports.normalizeEndDispatchReason = normalizeEndDispatchReason;
module.exports.durationSecondsBetween = durationSecondsBetween;
module.exports.dispatchPlannedRouteStopSignature = dispatchPlannedRouteStopSignature;
module.exports.normalizeDispatchPlannedRouteSnapshot = normalizeDispatchPlannedRouteSnapshot;
module.exports.storedDispatchPlannedRouteSnapshot = storedDispatchPlannedRouteSnapshot;
module.exports.DISPATCH_PLANNED_ROUTE_VERSION = DISPATCH_PLANNED_ROUTE_VERSION;
module.exports.DISPATCH_PLANNED_ROUTE_MAX_POINTS = DISPATCH_PLANNED_ROUTE_MAX_POINTS;
module.exports.DISPATCH_PLANNED_ROUTE_MAX_BYTES = DISPATCH_PLANNED_ROUTE_MAX_BYTES;
module.exports.qualifyDispatchStopEvidence = qualifyDispatchStopEvidence;
module.exports.DISPATCH_STOP_TRANSITION_RULES =
  DISPATCH_STOP_TRANSITION_RULES;
module.exports.DISPATCH_HISTORY_REPLAY_PAGE_SIZE =
  DISPATCH_HISTORY_REPLAY_PAGE_SIZE;
module.exports.createDispatchHistoryReplayState =
  createDispatchHistoryReplayState;
module.exports.applyDispatchHistoryLocation = applyDispatchHistoryLocation;
