const MAX_RELIABLE_ACCURACY_METERS = 50;
const LIVE_LOCATION_FRESHNESS_MS = 5 * 60 * 1000;
const FUTURE_CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

class GpsValidationError extends Error {
  constructor(message, code = "GPS_POINT_INVALID") {
    super(message);
    this.name = "GpsValidationError";
    this.statusCode = 400;
    this.code = code;
  }
}

function formatManilaDateTime(timestampMs) {
  return new Date(timestampMs + (8 * 60 * 60 * 1000))
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

function parseStrictNumber(value, label, options = {}) {
  const { allowNumericString = false } = options;
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "object" ||
    (typeof value === "string" && value.trim() === "")
  ) {
    throw new GpsValidationError(`${label} must be a finite number`);
  }

  if (typeof value !== "number" && !(allowNumericString && typeof value === "string")) {
    throw new GpsValidationError(`${label} must be a finite number`);
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new GpsValidationError(`${label} must be a finite number`);
  }
  return number;
}

function parseManilaTimestamp(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : time;
  }
  if (typeof value !== "string") return null;

  const text = value.trim();
  if (!text) return null;

  const localMatch = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/
  );
  if (localMatch) {
    const [, year, month, day, hour, minute, second, milliseconds = "0"] = localMatch;
    const time = Date.parse(
      `${year}-${month}-${day}T${hour}:${minute}:${second}.${milliseconds.padEnd(3, "0")}+08:00`
    );
    if (Number.isNaN(time)) return null;
    const roundTrip = formatManilaDateTime(time);
    const expected = `${year}-${month}-${day} ${hour}:${minute}:${second}`;
    return roundTrip === expected ? time : null;
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    const time = Date.parse(text);
    return Number.isNaN(time) ? null : time;
  }

  return null;
}

function normalizeRecordedAt(value, options = {}) {
  const {
    nowMs = Date.now(),
    required = false,
    futureToleranceMs = FUTURE_CLOCK_SKEW_TOLERANCE_MS
  } = options;
  const missing = value === null || value === undefined;

  if (missing && !required) {
    return {
      recordedAt: formatManilaDateTime(nowMs),
      timestampMs: nowMs
    };
  }

  const timestampMs = parseManilaTimestamp(value);
  if (!timestampMs) {
    throw new GpsValidationError(
      "recorded_at must be a valid date and time",
      "GPS_TIMESTAMP_INVALID"
    );
  }
  if (timestampMs > nowMs + futureToleranceMs) {
    throw new GpsValidationError(
      "recorded_at is unreasonably far in the future",
      "GPS_TIMESTAMP_FUTURE"
    );
  }

  return {
    recordedAt: formatManilaDateTime(timestampMs),
    timestampMs
  };
}

function validateGpsPointForStorage(point = {}, options = {}) {
  if (!point || typeof point !== "object" || Array.isArray(point)) {
    throw new GpsValidationError("GPS point must be an object");
  }

  const latitude = parseStrictNumber(point.latitude, "latitude", options);
  const longitude = parseStrictNumber(point.longitude, "longitude", options);
  if (latitude < -90 || latitude > 90) {
    throw new GpsValidationError("latitude must be between -90 and 90");
  }
  if (longitude < -180 || longitude > 180) {
    throw new GpsValidationError("longitude must be between -180 and 180");
  }
  if (latitude === 0 && longitude === 0) {
    throw new GpsValidationError("latitude and longitude cannot both be 0");
  }

  const accuracyMissing =
    point.accuracy === null || point.accuracy === undefined;
  const accuracy = accuracyMissing
    ? null
    : parseStrictNumber(point.accuracy, "accuracy", options);
  if (accuracy !== null && accuracy < 0) {
    throw new GpsValidationError("accuracy must be non-negative");
  }

  const hasRecordedAt = Object.prototype.hasOwnProperty.call(point, "recorded_at") ||
    Object.prototype.hasOwnProperty.call(point, "recordedAt");
  const recordedAtValue = Object.prototype.hasOwnProperty.call(point, "recorded_at")
    ? point.recorded_at
    : point.recordedAt;
  const timestamp = normalizeRecordedAt(recordedAtValue, {
    ...options,
    required: options.timestampRequired === true || hasRecordedAt
  });

  return {
    ...point,
    latitude,
    longitude,
    accuracy,
    recorded_at: timestamp.recordedAt,
    timestampMs: timestamp.timestampMs
  };
}

function qualifyGpsPointForOperationalUse(point = {}, options = {}) {
  const {
    referenceTimeMs = Date.now(),
    freshnessMs = LIVE_LOCATION_FRESHNESS_MS
  } = options;
  try {
    const normalized = validateGpsPointForStorage(point, {
      ...options,
      allowNumericString: true,
      nowMs: referenceTimeMs,
      timestampRequired: true
    });
    if (normalized.accuracy === null || normalized.accuracy > MAX_RELIABLE_ACCURACY_METERS) {
      return { reliable: false, reason: "unreliable_accuracy", point: null };
    }
    const ageMs = referenceTimeMs - normalized.timestampMs;
    if (ageMs > freshnessMs) {
      return { reliable: false, reason: "stale_location", point: null };
    }
    return {
      reliable: true,
      reason: "reliable",
      point: normalized,
      ageMs
    };
  } catch (error) {
    if (error instanceof GpsValidationError) {
      return { reliable: false, reason: error.code, point: null };
    }
    throw error;
  }
}

module.exports = {
  MAX_RELIABLE_ACCURACY_METERS,
  LIVE_LOCATION_FRESHNESS_MS,
  FUTURE_CLOCK_SKEW_TOLERANCE_MS,
  GpsValidationError,
  formatManilaDateTime,
  parseManilaTimestamp,
  normalizeRecordedAt,
  validateGpsPointForStorage,
  qualifyGpsPointForOperationalUse
};
