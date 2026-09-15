function initializeTruckMap() {
  const mapContainer = document.getElementById("truckMap");
  if (!mapContainer) return;
  if (isTruckMapInitialized && truckMap) return;

  truckMap = L.map("truckMap").setView([6.1164, 125.1716], 13);

  [
    ["dispatchPlannedRoutePane", "420"],
    ["dispatchCompletedRoutePane", "430"],
    ["trackingActualRoutePane", "440"],
    ["dispatchAlternativeRoutePane", "450"],
    ["dispatchCurrentRoutePane", "460"],
    ["dispatchMarkerPane", "650"],
    ["trackingTruckPane", "700"]
  ].forEach(([name, zIndex]) => {
    const pane = truckMap.getPane(name) || truckMap.createPane(name);
    pane.style.zIndex = zIndex;
    pane.style.pointerEvents = ["dispatchMarkerPane", "trackingTruckPane"].includes(name)
      ? "auto"
      : "none";
  });
  trackingCurrentTruckLayerGroup = L.layerGroup().addTo(truckMap);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(truckMap);

  isTruckMapInitialized = true;
  if (typeof ensureDispatchWmoMarker === "function") ensureDispatchWmoMarker();
}

/* =========================================================
   OFFLINE-SAFE TRACKING UI HELPERS
   Works with the mobile offline queue:
   - "Active" = live GPS points are reaching the server.
   - "Sync pending" = session is still active, but phone signal is weak/offline.
   - Route redraws as one full route once queued mobile points sync.
========================================================= */

const TRACKING_SYNC_PENDING_AFTER_MS = 10 * 1000;
const TRACKING_DEVICE_OFFLINE_AFTER_MS = 30 * 1000;
const TRACKING_GPS_AVAILABILITY_WINDOW_MS = TRACKING_DEVICE_OFFLINE_AFTER_MS;
const TRACKING_CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;
const TRACKING_ROUTE_GAP_MS = 90 * 1000;
const TRACKING_MAX_RELIABLE_ACCURACY_METERS = 50;
const TRACKING_STATIONARY_RADIUS_METERS = 8;
const TRACKING_STATIONARY_WINDOW_MS = 2 * 60 * 1000;
const TRACKING_MAX_DISPLAY_SPEED_METERS_PER_SECOND = 35;
const TRACKING_MIN_JUMP_DISTANCE_METERS = 200;
const TRACKING_FALLBACK_RECENT_POINT_LIMIT = 12;
const TRACKING_ACTUAL_ROUTE_COLOR = "#285a48";
const TRACKING_MARKER_ANIMATION_MS = 800;
const TRACKING_MARKER_MIN_BEARING_DISTANCE_METERS = 5;
const TRACKING_MATCH_SERVICE_ORIGIN = "https://router.project-osrm.org";
const TRACKING_MATCH_TIMEOUT_MS = 12 * 1000;
const TRACKING_MATCH_MAX_COORDINATES = 10;
const TRACKING_MATCH_MIN_CONFIDENCE = 0.35;
const TRACKING_MATCH_CACHE_LIMIT = 24;
const TRACKING_MATCH_CHUNK_CACHE_LIMIT = 256;

let selectedDispatchStartMarker = null;
let selectedDispatchStartSessionId = "";
let trackingRoadMatchAbortController = null;
let trackingRoadMatchRequestId = 0;
let trackingRouteLoadRequestId = 0;
const trackingRoadMatchCache = new Map();
const trackingRoadMatchChunkCache = new Map();

function parseTrackingDate(value) {
  if (!value) return null;

  const text = String(value).trim();
  if (!text) return null;

  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const date = new Date(hasExplicitTimezone ? normalized : `${normalized}+08:00`);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function formatTrackingTimeSafe(value) {
  const date = parseTrackingDate(value);
  if (!date) return "--";

  return date.toLocaleString("en-PH", { timeZone: "Asia/Manila" });
}

function getTruckLastUpdateValue(truck) {
  if (!truck) return "";

  return (
    truck.location_last_updated ||
    truck.last_updated_at ||
    truck.lastUpdatedAt ||
    truck.updated_at ||
    truck.updatedAt ||
    ""
  );
}

function getTruckLastSyncValue(truck) {
  if (!truck) return "";

  return (
    truck.device_contact_at ||
    truck.server_sync_at ||
    truck.last_device_status_at ||
    truck.last_sync_at ||
    truck.sync_updated_at ||
    truck.last_updated_at ||
    truck.location_last_updated ||
    truck.updated_at ||
    truck.updatedAt ||
    ""
  );
}

function getTrackingAvailabilityMeta(truck, now = Date.now()) {
  const sessionStatus = String(truck?.session_status || "").toLowerCase();
  if (sessionStatus !== "active") {
    return {
      key: "stopped",
      label: "Tracking Stopped",
      className: "stopped",
      description: "The tracking session has ended.",
      available: false,
      ageMs: Number.POSITIVE_INFINITY
    };
  }

  /*
    GPS state and server connectivity are separate signals.

    last_device_status is the phone's explicit GPS/device report.
    location_last_updated is only the newest route point already uploaded.

    A stale route point must never by itself mean that the device is offline:
    the phone can be online while durable route points are still catching up
    from the local queue.
  */
  const directDeviceValues = [
    truck?.last_device_status,
    truck?.gps_status
  ].map((value) => String(value || "").trim().toLowerCase());

  const explicitlyGpsOff = directDeviceValues.some((value) =>
    value === "off" ||
    value === "gps_off" ||
    value === "tracking_off" ||
    value === "permission_missing" ||
    value === "no_permission" ||
    value === "no_gps" ||
    value.includes("gps_off") ||
    value.includes("tracking_off") ||
    value.includes("permission_missing")
  );

  const explicitlyGpsOnline = directDeviceValues.some((value) =>
    value === "active" ||
    value === "live" ||
    value === "on" ||
    value === "gps_on" ||
    value === "tracking_active" ||
    value === "synced"
  );

  const latitude = parseTrackingCoordinate(truck?.latitude);
  const longitude = parseTrackingCoordinate(truck?.longitude);
  const validCoordinates =
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180 &&
    !(latitude === 0 && longitude === 0);
  const reliableCoordinates = validCoordinates && isTrackingPointReliable(truck);

  const lastGpsDate = parseTrackingDate(getTruckLastUpdateValue(truck));
  const gpsAgeMs = lastGpsDate ? now - lastGpsDate.getTime() : Number.POSITIVE_INFINITY;

  const lastContactDate = parseTrackingDate(getTruckLastSyncValue(truck));
  const contactAgeMs = lastContactDate
    ? now - lastContactDate.getTime()
    : Number.POSITIVE_INFINITY;
  const contactIsFresh =
    lastContactDate &&
    contactAgeMs >= -TRACKING_CLOCK_SKEW_TOLERANCE_MS &&
    contactAgeMs < TRACKING_DEVICE_OFFLINE_AFTER_MS;

  if (explicitlyGpsOff) {
    return {
      key: "offline",
      label: "GPS Offline",
      className: "gps-off",
      description: "The mobile device explicitly reported that GPS tracking is unavailable.",
      available: false,
      ageMs: gpsAgeMs
    };
  }

  if (explicitlyGpsOnline && contactIsFresh) {
    return {
      key: "online",
      label: "GPS Online",
      className: "active",
      description:
        reliableCoordinates &&
        gpsAgeMs >= -TRACKING_CLOCK_SKEW_TOLERANCE_MS &&
        gpsAgeMs < TRACKING_SYNC_PENDING_AFTER_MS
          ? "GPS is online and current route points are reaching the server."
          : "GPS is online. Saved route points are still catching up with the server.",
      available: true,
      ageMs: gpsAgeMs
    };
  }

  if (
    lastGpsDate &&
    reliableCoordinates &&
    gpsAgeMs >= -TRACKING_CLOCK_SKEW_TOLERANCE_MS &&
    gpsAgeMs < TRACKING_SYNC_PENDING_AFTER_MS
  ) {
    return {
      key: "online",
      label: "GPS Online",
      className: "active",
      description: "A current reliable GPS point is available.",
      available: true,
      ageMs: gpsAgeMs
    };
  }

  return {
    key: "stale",
    label: "Last Known GPS",
    className: "sync-pending",
    description: lastGpsDate
      ? "The last uploaded GPS point is old. The active device may still be collecting points locally."
      : "The dispatch is active, but no reliable server-synced GPS point is available yet.",
    available: false,
    ageMs: gpsAgeMs
  };
}

function getTrackingStatusMeta(truck, now = Date.now()) {
  const availability = getTrackingAvailabilityMeta(truck, now);
  return {
    ...availability,
    key: availability.key === "online"
      ? "active"
      : availability.key === "stale"
        ? "sync_pending"
        : availability.key === "offline"
          ? "gps_off"
          : availability.key === "device_offline"
            ? "device_offline"
            : availability.key
  };
}

function getTrackingConnectivityMeta(truck, now = Date.now()) {
  const lastSyncDate = parseTrackingDate(getTruckLastSyncValue(truck));
  const syncAgeMs = lastSyncDate
    ? now - lastSyncDate.getTime()
    : Number.POSITIVE_INFINITY;

  if (!lastSyncDate || syncAgeMs >= TRACKING_DEVICE_OFFLINE_AFTER_MS) {
    return {
      key: "device_offline",
      label: "Device Offline",
      className: "device-offline",
      description: "No recent mobile-to-server contact has been received.",
      ageMs: syncAgeMs
    };
  }

  if (
    syncAgeMs < -TRACKING_CLOCK_SKEW_TOLERANCE_MS ||
    syncAgeMs >= TRACKING_SYNC_PENDING_AFTER_MS
  ) {
    return {
      key: "sync_pending",
      label: "Sync Pending",
      className: "sync-pending",
      description: "The last device contact is aging; saved route points may still be queued.",
      ageMs: syncAgeMs
    };
  }

  const gpsDate = parseTrackingDate(getTruckLastUpdateValue(truck));
  const gpsAgeMs = gpsDate ? now - gpsDate.getTime() : Number.POSITIVE_INFINITY;
  const routePointIsFresh =
    gpsDate &&
    gpsAgeMs >= -TRACKING_CLOCK_SKEW_TOLERANCE_MS &&
    gpsAgeMs < TRACKING_SYNC_PENDING_AFTER_MS &&
    isTrackingPointReliable(truck);

  if (!routePointIsFresh) {
    return {
      key: "sync_pending",
      label: "Sync Pending",
      className: "sync-pending",
      description: "The device is online, but queued route points are still catching up.",
      ageMs: syncAgeMs
    };
  }

  return {
    key: "synced",
    label: "Synced",
    className: "synced",
    description: "The mobile device and route are currently synchronized.",
    ageMs: syncAgeMs
  };
}

function getTrackingDisplayChannels(truck, now = Date.now()) {
  const tracking = getTrackingStatusMeta(truck, now);
  const connectivity = getTrackingConnectivityMeta(truck, now);

  let gps;
  if (tracking.key === "gps_off") {
    gps = {
      key: "gps_off",
      label: "GPS Offline",
      className: "gps-off"
    };
  } else if (tracking.key === "active") {
    gps = {
      key: "gps_online",
      label: "GPS Online",
      className: "gps-online"
    };
  } else {
    gps = {
      key: "last_known",
      label: "Last Known GPS",
      className: "last-known"
    };
  }

  const lastGpsDate = parseTrackingDate(getTruckLastUpdateValue(truck));
  const gpsAgeMs = lastGpsDate
    ? now - lastGpsDate.getTime()
    : Number.POSITIVE_INFINITY;
  const routePointIsFresh =
    lastGpsDate &&
    gpsAgeMs >= -TRACKING_CLOCK_SKEW_TOLERANCE_MS &&
    gpsAgeMs < TRACKING_SYNC_PENDING_AFTER_MS &&
    isTrackingPointReliable(truck);

  const route = tracking.key === "gps_off"
    ? { key: "gps_unavailable", label: "GPS unavailable", className: "gps-off" }
    : connectivity.key === "device_offline"
      ? { key: "last_known", label: "Last known", className: "last-known" }
      : routePointIsFresh
        ? { key: "live", label: "Live", className: "live" }
        : { key: "delayed", label: "Catching up", className: "delayed" };

  return {
    tracking,
    gps,
    connectivity,
    route
  };
}

function getTrackingTruckExistingTicket(truck) {
  if (!truck) return null;
  if (typeof dispatchResolveKnownTicketForTruck === "function") {
    return dispatchResolveKnownTicketForTruck(truck);
  }
  const ticket = truck.dispatch || truck.existing_dispatch_ticket || null;
  if (!ticket) return null;
  const status = String(
    ticket.status || ticket.ticket_status || ticket.dispatch_status ||
    (truck.dispatch ? "in_progress" : "")
  ).trim().toLowerCase();
  if (!["prepared", "dispatched", "in_progress", "returning_to_wmo"].includes(status)) {
    return null;
  }
  return { ...ticket, status };
}

function getTrackingTruckDispatchState(truck, now = Date.now()) {
  const ticket = getTrackingTruckExistingTicket(truck);
  const status = String(ticket?.status || "").toLowerCase();
  const gps = getTrackingStatusMeta(truck, now);
  if (["dispatched", "in_progress", "returning_to_wmo"].includes(status)) {
    return {
      key: "active_dispatch",
      ticket,
      gps,
      title: "Active Dispatch",
      actionLabel: "Open Live Dispatch",
      available: false
    };
  }
  if (status === "prepared") {
    return {
      key: "prepared_dispatch",
      ticket,
      gps,
      title: "Existing Dispatch Ticket",
      actionLabel: "View Ticket",
      available: false
    };
  }
  return {
    key: gps.available ? "available" : "unavailable",
    ticket: null,
    gps,
    title: gps.available ? "Available for dispatch" : "Unavailable for dispatch",
    actionLabel: gps.available ? "Plan Dispatch" : "Review Availability",
    available: gps.available
  };
}

function isTrackingTruckAvailable(truck, now = Date.now()) {
  return getTrackingTruckDispatchState(truck, now).available === true;
}

function filterAvailableTrackingTrucks(trucks, now = Date.now()) {
  return (Array.isArray(trucks) ? trucks : []).filter((truck) =>
    isTrackingTruckAvailable(truck, now)
  );
}

function buildTrackingAvailabilitySnapshot(
  trackingTrucks,
  dispatchForSession = () => null,
  now = Date.now(),
  liveDispatches = {}
) {
  const sessions = (Array.isArray(trackingTrucks) ? trackingTrucks : []).map((truck) => ({
    ...truck,
    dispatch: dispatchForSession(truck.session_id) || null
  }));

  const knownSessionIds = new Set(sessions.map((truck) => String(truck.session_id)));
  Object.entries(liveDispatches && typeof liveDispatches === "object" ? liveDispatches : {})
    .forEach(([sessionId, dispatch]) => {
      if (!dispatch || knownSessionIds.has(String(sessionId))) return;
      sessions.push({
        session_id: sessionId,
        truck_id: dispatch.truck_id,
        truck_name: dispatch.truck_name_snapshot || dispatch.truck_id,
        session_status: dispatch.tracking_session_status || "active",
        latitude: dispatch.last_latitude,
        longitude: dispatch.last_longitude,
        location_last_updated: dispatch.last_gps_update || dispatch.tracking_last_updated_at,
        last_updated_at: dispatch.tracking_last_updated_at,
        last_location_status: dispatch.gps_status,
        dispatch
      });
    });

  const availableTrucks = filterAvailableTrackingTrucks(sessions, now);
  const operationalTrucks = sessions.filter((truck) =>
    Boolean(truck.dispatch) ||
    String(truck?.session_status || "").toLowerCase() === "active"
  );

  return {
    sessions,
    availableTrucks,
    operationalTrucks
  };
}

function resolveTrackingMonitoredDispatch(trucks = [], selectedSession = null) {
  const activeDispatches = (Array.isArray(trucks) ? trucks : [])
    .filter((truck) => truck?.dispatch && truck?.session_id !== null && truck?.session_id !== undefined)
    .sort((first, second) => {
      const ticketDelta = Number(second.dispatch?.dispatch_ticket_id || second.dispatch?.id || 0) -
        Number(first.dispatch?.dispatch_ticket_id || first.dispatch?.id || 0);
      return ticketDelta || String(first.session_id).localeCompare(String(second.session_id));
    });
  if (selectedSession !== null && selectedSession !== undefined && String(selectedSession) !== "") {
    return activeDispatches.find(
      (truck) => String(truck.session_id) === String(selectedSession)
    ) || null;
  }
  return activeDispatches[0] || null;
}

function trackingRouteSignature(routePoints = []) {
  return (Array.isArray(routePoints) ? routePoints : []).map((point) => [
    point.stableId ?? point.id ?? "",
    point.timestamp || "",
    Number(point.lat).toFixed(6),
    Number(point.lng).toFixed(6)
  ].join(":"))
    .join("|");
}

function isValidTrackingLatLngPair(point) {
  return Array.isArray(point) &&
    point.length >= 2 &&
    Number.isFinite(Number(point[0])) &&
    Number.isFinite(Number(point[1])) &&
    Number(point[0]) >= -90 &&
    Number(point[0]) <= 90 &&
    Number(point[1]) >= -180 &&
    Number(point[1]) <= 180;
}

function trackingPointToLatLng(point) {
  const pair = [Number(point?.lat), Number(point?.lng)];
  return isValidTrackingLatLngPair(pair) ? pair : null;
}

function splitTrackingDisplaySegments(displayedPoints = [], gapMs = TRACKING_ROUTE_GAP_MS) {
  const segments = [];

  (Array.isArray(displayedPoints) ? displayedPoints : []).forEach((point) => {
    if (!trackingPointToLatLng(point)) return;
    const currentSegment = segments[segments.length - 1];
    const previous = currentSegment?.[currentSegment.length - 1];
    const hasConfirmedGap = Boolean(
      previous?.timestamp &&
      point?.timestamp &&
      point.timestamp - previous.timestamp > gapMs
    );

    if (!currentSegment || hasConfirmedGap) {
      segments.push([point]);
    } else {
      currentSegment.push(point);
    }
  });

  return segments;
}

function chunkTrackingMatchSegment(segment = [], maxCoordinates = TRACKING_MATCH_MAX_COORDINATES) {
  const points = Array.isArray(segment) ? segment : [];
  const safeLimit = Math.max(2, Math.floor(Number(maxCoordinates) || TRACKING_MATCH_MAX_COORDINATES));
  if (points.length <= safeLimit) return points.length ? [points.slice()] : [];

  const chunks = [];
  let startIndex = 0;
  while (startIndex < points.length - 1) {
    const endIndex = Math.min(points.length, startIndex + safeLimit);
    chunks.push(points.slice(startIndex, endIndex));
    if (endIndex >= points.length) break;
    startIndex = endIndex - 1;
  }
  return chunks;
}

function dedupeTrackingGeometryPoints(points = []) {
  const deduped = [];
  let previousKey = "";
  (Array.isArray(points) ? points : []).forEach((point) => {
    if (!isValidTrackingLatLngPair(point)) return;
    const normalized = [Number(point[0]), Number(point[1])];
    const key = `${normalized[0].toFixed(6)}:${normalized[1].toFixed(6)}`;
    if (key === previousKey) return;
    deduped.push(normalized);
    previousKey = key;
  });
  return deduped;
}

function joinTrackingMatchedChunkGeometry(chunkGeometries = []) {
  return dedupeTrackingGeometryPoints(
    (Array.isArray(chunkGeometries) ? chunkGeometries : []).flatMap(
      (geometry) => Array.isArray(geometry) ? geometry : []
    )
  );
}

function buildTrackingMatchUrl(points = []) {
  const usablePoints = (Array.isArray(points) ? points : [])
    .filter((point) => trackingPointToLatLng(point));
  if (usablePoints.length < 2) return "";

  const coordinates = usablePoints.map(
    (point) => `${Number(point.lng).toFixed(6)},${Number(point.lat).toFixed(6)}`
  ).join(";");
  const query = new URLSearchParams({
    geometries: "geojson",
    overview: "full",
    steps: "false",
    tidy: "true",
    gaps: "ignore"
  });
  const timestamps = usablePoints.map((point) => Math.floor(Number(point.timestamp) / 1000));
  const hasUsableTimestamps = timestamps.every(
    (timestamp, index) => Number.isFinite(timestamp) &&
      timestamp > 0 &&
      (!index || timestamp > timestamps[index - 1])
  );
  if (hasUsableTimestamps) query.set("timestamps", timestamps.join(";"));

  return `${TRACKING_MATCH_SERVICE_ORIGIN}/match/v1/driving/${coordinates}?${query.toString()}`;
}

function parseTrackingMatchResponse(payload, minimumConfidence = TRACKING_MATCH_MIN_CONFIDENCE) {
  const matchings = Array.isArray(payload?.matchings) ? payload.matchings : [];
  if (payload?.code !== "Ok" || matchings.length !== 1) return null;

  const matching = matchings[0];
  const confidence = Number(matching?.confidence);
  if (!Number.isFinite(confidence) || confidence < minimumConfidence) return null;

  const coordinates = matching?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const geometry = coordinates.map((coordinate) => [
    Number(coordinate?.[1]),
    Number(coordinate?.[0])
  ]);
  if (geometry.some((point) => !isValidTrackingLatLngPair(point))) return null;

  return { geometry, confidence };
}

function createTrackingMatchAbortError(message = "Tracking road match was cancelled.") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

async function requestTrackingMatchChunk(points = [], options = {}) {
  const url = buildTrackingMatchUrl(points);
  if (!url) throw new Error("At least two valid tracking points are required for road matching.");

  const fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) throw new Error("Road matching is unavailable in this browser.");

  const timeoutMs = Math.max(1, Number(options.timeoutMs) || TRACKING_MATCH_TIMEOUT_MS);
  const externalSignal = options.signal || null;
  if (externalSignal?.aborted) throw createTrackingMatchAbortError();

  const requestController = typeof AbortController === "function"
    ? new AbortController()
    : null;
  let timeoutId = null;
  let abortListener = null;

  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      requestController?.abort();
      reject(createTrackingMatchAbortError("Tracking road match timed out."));
    }, timeoutMs);
  });
  const abortPromise = externalSignal
    ? new Promise((resolve, reject) => {
        abortListener = () => {
          requestController?.abort();
          reject(createTrackingMatchAbortError());
        };
        externalSignal.addEventListener("abort", abortListener, { once: true });
      })
    : null;

  try {
    const payload = await Promise.race([
      Promise.resolve(fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: requestController?.signal
      })).then(async (response) => {
        if (!response?.ok) {
          throw new Error(`Tracking road match returned HTTP ${response?.status || "error"}.`);
        }
        return response.json();
      }),
      timeoutPromise,
      ...(abortPromise ? [abortPromise] : [])
    ]);
    return parseTrackingMatchResponse(payload, options.minimumConfidence);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (abortListener) externalSignal.removeEventListener("abort", abortListener);
  }
}

function trackingMatchChunkCacheKey(namespace, points = []) {
  return `${String(namespace || "")}|${trackingRouteSignature(points)}`;
}

async function getCachedTrackingMatchChunk(points = [], options = {}) {
  const cache = options.chunkCache instanceof Map ? options.chunkCache : null;
  if (!cache) return requestTrackingMatchChunk(points, options);

  const key = trackingMatchChunkCacheKey(options.chunkCacheNamespace, points);
  if (cache.has(key)) return cache.get(key);

  const matched = await requestTrackingMatchChunk(points, options);
  if (!matched || options.signal?.aborted) return matched;

  cache.set(key, matched);
  const maxEntries = Math.max(
    1,
    Number(options.chunkCacheLimit) || TRACKING_MATCH_CHUNK_CACHE_LIMIT
  );
  while (cache.size > maxEntries) {
    cache.delete(cache.keys().next().value);
  }
  return matched;
}

function rawTrackingSegmentResult(segment = [], fallbackReason = "") {
  return {
    rawPoints: Array.isArray(segment) ? segment : [],
    geometry: (Array.isArray(segment) ? segment : [])
      .map(trackingPointToLatLng)
      .filter(Boolean),
    matched: false,
    confidence: null,
    fallbackReason
  };
}

async function matchTrackingDisplaySegments(displayedPoints = [], options = {}) {
  const rawSegments = splitTrackingDisplaySegments(displayedPoints, options.gapMs);
  const segments = [];
  let matchedSegmentCount = 0;
  let eligibleSegmentCount = 0;
  let aborted = false;

  for (const segment of rawSegments) {
    if (segment.length < 2) {
      segments.push(rawTrackingSegmentResult(segment, "single_point"));
      continue;
    }
    eligibleSegmentCount++;

    if (aborted || options.signal?.aborted) {
      aborted = true;
      segments.push(rawTrackingSegmentResult(segment, "aborted"));
      continue;
    }

    try {
      const matchedChunks = [];
      const confidenceValues = [];
      const chunks = chunkTrackingMatchSegment(segment, options.maxCoordinates);
      for (const chunk of chunks) {
        const matched = await getCachedTrackingMatchChunk(chunk, options);
        if (!matched?.geometry?.length) throw new Error("Road matcher returned no usable geometry.");
        matchedChunks.push(matched.geometry);
        confidenceValues.push(matched.confidence);
      }

      const geometry = joinTrackingMatchedChunkGeometry(matchedChunks);
      if (geometry.length < 2) throw new Error("Road matcher returned insufficient geometry.");
      matchedSegmentCount++;
      segments.push({
        rawPoints: segment,
        geometry,
        matched: true,
        confidence: Math.min(...confidenceValues),
        fallbackReason: ""
      });
    } catch (error) {
      if (error?.name === "AbortError") aborted = true;
      segments.push(rawTrackingSegmentResult(segment, error?.name === "AbortError" ? "aborted" : "unavailable"));
    }
  }

  return {
    segments,
    matchedSegmentCount,
    eligibleSegmentCount,
    displayMode: matchedSegmentCount === eligibleSegmentCount && eligibleSegmentCount > 0
      ? "road_matched"
      : matchedSegmentCount > 0
        ? "mixed_fallback"
        : "raw_fallback",
    aborted
  };
}

function trackingMatchCacheKey(sessionId, routeSignature) {
  return `${String(sessionId || "")}|${String(routeSignature || "")}`;
}

function getCachedTrackingMatch(displayedPoints, sessionId, routeSignature, options = {}) {
  const cache = options.cache instanceof Map ? options.cache : trackingRoadMatchCache;
  const key = trackingMatchCacheKey(sessionId, routeSignature);
  if (cache.has(key)) return cache.get(key);

  const pending = matchTrackingDisplaySegments(displayedPoints, {
    ...options,
    chunkCache: options.chunkCache instanceof Map
      ? options.chunkCache
      : trackingRoadMatchChunkCache,
    chunkCacheNamespace: options.chunkCacheNamespace ?? String(sessionId || "")
  }).then((result) => {
    if (result.aborted && cache.get(key) === pending) cache.delete(key);
    return result;
  });
  cache.set(key, pending);

  const maxEntries = Math.max(1, Number(options.cacheLimit) || TRACKING_MATCH_CACHE_LIMIT);
  while (cache.size > maxEntries) {
    cache.delete(cache.keys().next().value);
  }
  return pending;
}

function isTrackingMatchResponseCurrent(sessionId, routeSignature, requestId, state = {}) {
  const currentSessionId = Object.prototype.hasOwnProperty.call(state, "sessionId")
    ? state.sessionId
    : (typeof selectedSessionId === "undefined" ? null : selectedSessionId);
  const currentRouteSignature = Object.prototype.hasOwnProperty.call(state, "routeSignature")
    ? state.routeSignature
    : (typeof selectedRouteSignature === "undefined" ? "" : selectedRouteSignature);
  const currentRequestId = Object.prototype.hasOwnProperty.call(state, "requestId")
    ? state.requestId
    : trackingRoadMatchRequestId;
  return String(currentSessionId || "") === String(sessionId || "") &&
    String(currentRouteSignature || "") === String(routeSignature || "") &&
    Number(currentRequestId) === Number(requestId);
}

function resolveTrackingStartMarkerAction(existingSessionId, nextSessionId, firstPoint) {
  const position = trackingPointToLatLng(firstPoint);
  if (!position) return { action: "none", position: null };
  return String(existingSessionId || "") === String(nextSessionId || "")
    ? { action: "keep", position }
    : { action: "replace", position };
}

let trackingOperationalTrucks = [];

function formatTrackingRelativeUpdate(value, now = Date.now()) {
  const date = parseTrackingDate(value);
  if (!date) return "Not recorded";
  const ageSeconds = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  if (ageSeconds < 5) return "just now";
  if (ageSeconds < 60) return `${ageSeconds} sec ago`;
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) return `${ageMinutes} min ago`;
  const ageHours = Math.floor(ageMinutes / 60);
  return `${ageHours} hr ago`;
}

function getTrackingSignalSummary(trucks) {
  const safeTrucks = Array.isArray(trucks) ? trucks : [];
  if (!safeTrucks.length) {
    return { text: "No active trucks", className: "idle" };
  }

  const statuses = safeTrucks.map((truck) => getTrackingStatusMeta(truck));
  const onlineCount = statuses.filter((status) => status.key === "active").length;
  const pendingCount = statuses.filter((status) => status.key === "sync_pending").length;
  const deviceOfflineCount = statuses.filter((status) => status.key === "device_offline").length;
  const gpsOffCount = statuses.filter((status) => status.key === "gps_off").length;

  if (onlineCount === safeTrucks.length) {
    return {
      text: onlineCount === 1 ? "1 GPS Online" : `${onlineCount} GPS Online`,
      className: "good"
    };
  }

  if (pendingCount === safeTrucks.length) {
    return {
      text: pendingCount === 1 ? "1 Sync Pending" : `${pendingCount} Sync Pending`,
      className: "warning"
    };
  }

  if (deviceOfflineCount === safeTrucks.length) {
    return {
      text: deviceOfflineCount === 1 ? "1 Device Offline" : `${deviceOfflineCount} Device Offline`,
      className: "warning"
    };
  }

  if (gpsOffCount === safeTrucks.length) {
    return {
      text: gpsOffCount === 1 ? "1 GPS Offline" : `${gpsOffCount} GPS Offline`,
      className: "warning"
    };
  }

  const parts = [];
  if (onlineCount) parts.push(`${onlineCount} Online`);
  if (pendingCount) parts.push(`${pendingCount} Pending`);
  if (deviceOfflineCount) parts.push(`${deviceOfflineCount} Device Offline`);
  if (gpsOffCount) parts.push(`${gpsOffCount} GPS Off`);

  return {
    text: parts.join(" · ") || `${safeTrucks.length} Active`,
    className: pendingCount || deviceOfflineCount || gpsOffCount ? "warning" : "good"
  };
}

function updateTrackingSummaryCards(trucks, selectedTruck = selectedTrackingTruck) {
  const suppliedTrucks = Array.isArray(trucks) ? trucks : [];
  const operationalTrucks =
    typeof trackingOperationalTrucks !== "undefined" &&
    Array.isArray(trackingOperationalTrucks)
      ? trackingOperationalTrucks
      : suppliedTrucks;

  const activeTruckCount = document.getElementById("activeTruckCount");
  const trackingSignalStatus = document.getElementById("trackingSignalStatus");

  if (activeTruckCount) {
    activeTruckCount.textContent = String(operationalTrucks.length);
  }

  if (trackingSignalStatus) {
    if (selectedTruck && String(selectedTruck.session_id) === String(selectedSessionId)) {
      const selectedChannels = getTrackingDisplayChannels(selectedTruck);
      trackingSignalStatus.textContent =
        `${selectedChannels.gps.label} · ${selectedChannels.connectivity.label}`;
      trackingSignalStatus.className =
        `tracking-signal-status ${selectedChannels.connectivity.className}`;
    } else {
      const summary = getTrackingSignalSummary(operationalTrucks);
      trackingSignalStatus.textContent = summary.text;
      trackingSignalStatus.className = `tracking-signal-status ${summary.className}`;
    }
  }
}

function trackingHaversineMeters(pointA, pointB) {
  const latitudeA = Number(pointA?.lat);
  const longitudeA = Number(pointA?.lng);
  const latitudeB = Number(pointB?.lat);
  const longitudeB = Number(pointB?.lng);
  if (![latitudeA, longitudeA, latitudeB, longitudeB].every(Number.isFinite)) {
    return Number.POSITIVE_INFINITY;
  }

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

function trackingBearingDegrees(pointA, pointB, minimumDistanceMeters = TRACKING_MARKER_MIN_BEARING_DISTANCE_METERS) {
  if (trackingHaversineMeters(pointA, pointB) < minimumDistanceMeters) return null;
  const latitudeA = Number(pointA?.lat);
  const longitudeA = Number(pointA?.lng);
  const latitudeB = Number(pointB?.lat);
  const longitudeB = Number(pointB?.lng);
  if (![latitudeA, longitudeA, latitudeB, longitudeB].every(Number.isFinite)) return null;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const toDegrees = (radians) => (radians * 180) / Math.PI;
  const longitudeDelta = toRadians(longitudeB - longitudeA);
  const y = Math.sin(longitudeDelta) * Math.cos(toRadians(latitudeB));
  const x = Math.cos(toRadians(latitudeA)) * Math.sin(toRadians(latitudeB)) -
    Math.sin(toRadians(latitudeA)) * Math.cos(toRadians(latitudeB)) * Math.cos(longitudeDelta);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function moveTrackingMarker(marker, previousPoint, nextPoint, options = {}) {
  if (!marker?.setLatLng || !nextPoint) return { moved: false, animated: false };
  const renderedPoint = typeof marker.getLatLng === "function" ? marker.getLatLng() : null;
  const startPoint = [renderedPoint?.lat, renderedPoint?.lng].every((value) =>
    Number.isFinite(Number(value))
  )
    ? renderedPoint
    : previousPoint;
  const start = {
    lat: Number(startPoint?.lat),
    lng: Number(startPoint?.lng)
  };
  const end = {
    lat: Number(nextPoint?.lat),
    lng: Number(nextPoint?.lng)
  };
  if (![end.lat, end.lng].every(Number.isFinite)) return { moved: false, animated: false };

  const browserWindow = typeof window !== "undefined" ? window : null;
  const requestFrame = options.requestFrame || browserWindow?.requestAnimationFrame?.bind(browserWindow);
  const cancelFrame = options.cancelFrame || browserWindow?.cancelAnimationFrame?.bind(browserWindow);
  const durationMs = Number(options.durationMs ?? TRACKING_MARKER_ANIMATION_MS);
  const shouldAnimate = options.animate !== false &&
    [start.lat, start.lng].every(Number.isFinite) &&
    typeof requestFrame === "function" &&
    durationMs > 0;

  if (marker.__trackingMoveFrame && typeof cancelFrame === "function") {
    cancelFrame(marker.__trackingMoveFrame);
  }
  marker.__trackingMoveFrame = null;

  if (!shouldAnimate) {
    marker.setLatLng([end.lat, end.lng]);
    return { moved: true, animated: false };
  }

  const now = options.now || (() => browserWindow?.performance?.now?.() ?? Date.now());
  const startedAt = now();
  const step = (frameTime) => {
    const elapsed = Math.max(0, Number(frameTime ?? now()) - startedAt);
    const progress = Math.min(1, elapsed / durationMs);
    const eased = 1 - ((1 - progress) ** 3);
    marker.setLatLng([
      start.lat + ((end.lat - start.lat) * eased),
      start.lng + ((end.lng - start.lng) * eased)
    ]);
    if (progress < 1) {
      marker.__trackingMoveFrame = requestFrame(step);
    } else {
      marker.__trackingMoveFrame = null;
    }
  };
  marker.__trackingMoveFrame = requestFrame(step);
  return { moved: true, animated: true };
}

function parseTrackingCoordinate(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return Number.NaN;
  }
  return Number(value);
}

function getTrackingPointAccuracy(point) {
  if (point?.accuracy === null || point?.accuracy === undefined || point?.accuracy === "") {
    return null;
  }
  const accuracy = Number(point.accuracy);
  return Number.isFinite(accuracy) && accuracy >= 0
    ? accuracy
    : Number.POSITIVE_INFINITY;
}

function isTrackingPointReliable(point) {
  const accuracy = getTrackingPointAccuracy(point);
  return accuracy === null || accuracy <= TRACKING_MAX_RELIABLE_ACCURACY_METERS;
}

function normalizeTrackingRoutePoints(routeLogs = []) {
  const seen = new Set();
  return (Array.isArray(routeLogs) ? routeLogs : [])
    .map((point, sourceIndex) => ({
      ...point,
      lat: parseTrackingCoordinate(point?.latitude),
      lng: parseTrackingCoordinate(point?.longitude),
      timestamp: getRoutePointTimestamp(point),
      stableId: Number.isFinite(Number(point?.id)) ? Number(point.id) : sourceIndex,
      sourceIndex,
      accuracyMeters: getTrackingPointAccuracy(point)
    }))
    .filter(
      (point) =>
        Number.isFinite(point.lat) &&
        Number.isFinite(point.lng) &&
        point.lat >= -90 &&
        point.lat <= 90 &&
        point.lng >= -180 &&
        point.lng <= 180 &&
        !(point.lat === 0 && point.lng === 0)
    )
    .sort((pointA, pointB) => {
      if (pointA.timestamp !== pointB.timestamp) {
        return pointA.timestamp - pointB.timestamp;
      }
      if (pointA.stableId !== pointB.stableId) {
        return pointA.stableId - pointB.stableId;
      }
      return pointA.sourceIndex - pointB.sourceIndex;
    })
    .filter((point) => {
      const duplicateKey = `${point.timestamp}|${point.lat.toFixed(7)}|${point.lng.toFixed(7)}`;
      if (seen.has(duplicateKey)) return false;
      seen.add(duplicateKey);
      return true;
    });
}

function buildTrackingDisplayRoute(routeLogs = []) {
  const rawCount = Array.isArray(routeLogs) ? routeLogs.length : 0;
  const normalizedPoints = normalizeTrackingRoutePoints(routeLogs);
  const reliablePoints = normalizedPoints.filter(isTrackingPointReliable);
  let candidates = reliablePoints;
  let fallbackUsed = false;

  if (candidates.length < 2 && normalizedPoints.length > candidates.length) {
    fallbackUsed = true;
    const recentPoints = normalizedPoints.slice(-TRACKING_FALLBACK_RECENT_POINT_LIMIT);
    const bestAccuracy = Math.min(
      ...recentPoints.map((point) => point.accuracyMeters ?? Number.POSITIVE_INFINITY)
    );
    const fallbackAccuracyCeiling = Number.isFinite(bestAccuracy)
      ? bestAccuracy + 10
      : Number.POSITIVE_INFINITY;
    const fallbackCandidates = recentPoints.filter(
      (point) => (point.accuracyMeters ?? Number.POSITIVE_INFINITY) <= fallbackAccuracyCeiling
    );
    candidates = fallbackCandidates.length >= 2
      ? fallbackCandidates
      : recentPoints.slice(-2);
  }

  const startPoint = candidates[0] ? { ...candidates[0] } : null;

  const displayedPoints = [];
  let collapsedCount = 0;
  let rejectedJumpCount = 0;

  candidates.forEach((point) => {
    const previous = displayedPoints[displayedPoints.length - 1];
    if (!previous) {
      displayedPoints.push({ ...point, collapsedPointCount: 0 });
      return;
    }

    const distanceMeters = trackingHaversineMeters(previous, point);
    const elapsedMs = point.timestamp && previous.timestamp
      ? point.timestamp - previous.timestamp
      : 0;
    const elapsedSeconds = elapsedMs > 0 ? elapsedMs / 1000 : 0;
    const impliedSpeed = elapsedSeconds > 0
      ? distanceMeters / elapsedSeconds
      : Number.POSITIVE_INFINITY;

    if (
      distanceMeters >= TRACKING_MIN_JUMP_DISTANCE_METERS &&
      (elapsedSeconds <= 0 ||
        impliedSpeed > TRACKING_MAX_DISPLAY_SPEED_METERS_PER_SECOND)
    ) {
      rejectedJumpCount++;
      return;
    }

    if (
      elapsedMs >= 0 &&
      elapsedMs <= TRACKING_STATIONARY_WINDOW_MS &&
      distanceMeters <= TRACKING_STATIONARY_RADIUS_METERS
    ) {
      displayedPoints[displayedPoints.length - 1] = {
        ...point,
        lat: previous.lat,
        lng: previous.lng,
        collapsedPointCount: Number(previous.collapsedPointCount || 0) + 1
      };
      collapsedCount++;
      return;
    }

    displayedPoints.push({ ...point, collapsedPointCount: 0 });
  });

  return {
    rawCount,
    validCount: normalizedPoints.length,
    reliableCount: reliablePoints.length,
    displayedPoints,
    startPoint,
    markerPoint:
      [...displayedPoints].reverse().find(isTrackingPointReliable) || null,
    fallbackUsed,
    rejectedAccuracyCount: normalizedPoints.length - reliablePoints.length,
    rejectedJumpCount,
    collapsedCount,
    gapCount: displayedPoints.reduce((count, point, index) => {
      if (!index) return count;
      const previous = displayedPoints[index - 1];
      return point.timestamp && previous.timestamp &&
        point.timestamp - previous.timestamp > TRACKING_ROUTE_GAP_MS
        ? count + 1
        : count;
    }, 0)
  };
}

function setTrackingDiagnosticText(id, value) {
  if (typeof document === "undefined") return;
  const element = document.getElementById(id);
  if (element) element.textContent = String(value ?? "--");
}

function updateTrackingMapDiagnostics(patch = {}) {
  if (Object.prototype.hasOwnProperty.call(patch, "actualTrailSegments") &&
    typeof trackingActualTrailSegmentCount !== "undefined") {
    trackingActualTrailSegmentCount = Number(patch.actualTrailSegments) || 0;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "actualTrailVisible") &&
    typeof trackingActualTrailVisible !== "undefined") {
    trackingActualTrailVisible = Boolean(patch.actualTrailVisible);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "assignedRoutePoints") &&
    typeof dispatchAssignedRoutePointCount !== "undefined") {
    dispatchAssignedRoutePointCount = Number(patch.assignedRoutePoints) || 0;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "liveGuideTarget") &&
    typeof dispatchLiveGuideTargetLabel !== "undefined") {
    dispatchLiveGuideTargetLabel = String(patch.liveGuideTarget || "");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "liveGuideReason") &&
    typeof dispatchLiveGuideLastRerouteReason !== "undefined") {
    dispatchLiveGuideLastRerouteReason = String(patch.liveGuideReason || "");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "liveGuideAt") &&
    typeof dispatchLiveGuideLastRerouteAt !== "undefined") {
    dispatchLiveGuideLastRerouteAt = patch.liveGuideAt || null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "liveGuideOriginAt") &&
    typeof dispatchLiveGuideLastOriginAt !== "undefined") {
    dispatchLiveGuideLastOriginAt = patch.liveGuideOriginAt || null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "liveGuideMovedMeters") &&
    typeof dispatchLiveGuideMovedMeters !== "undefined") {
    const distance = Number(patch.liveGuideMovedMeters);
    dispatchLiveGuideMovedMeters = Number.isFinite(distance) ? distance : null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "liveGuideRequestSucceeded") &&
    typeof dispatchLiveGuideLastRequestSucceeded !== "undefined") {
    dispatchLiveGuideLastRequestSucceeded = typeof patch.liveGuideRequestSucceeded === "boolean"
      ? patch.liveGuideRequestSucceeded
      : null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "liveGuideDistanceMeters") &&
    typeof dispatchLiveGuideDistanceMeters !== "undefined") {
    const distance = Number(patch.liveGuideDistanceMeters);
    dispatchLiveGuideDistanceMeters = Number.isFinite(distance) ? distance : null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "currentStopStatus") &&
    typeof dispatchCurrentStopStatus !== "undefined") {
    dispatchCurrentStopStatus = String(patch.currentStopStatus || "");
  }

  const actualSegments = typeof trackingActualTrailSegmentCount === "undefined"
    ? Number(patch.actualTrailSegments) || 0
    : trackingActualTrailSegmentCount;
  const actualVisible = typeof trackingActualTrailVisible === "undefined"
    ? Boolean(patch.actualTrailVisible)
    : trackingActualTrailVisible;
  const assignedPoints = typeof dispatchAssignedRoutePointCount === "undefined"
    ? Number(patch.assignedRoutePoints) || 0
    : dispatchAssignedRoutePointCount;
  const guideTarget = typeof dispatchLiveGuideTargetLabel === "undefined"
    ? String(patch.liveGuideTarget || "")
    : dispatchLiveGuideTargetLabel;
  const guidePoints = typeof dispatchLiveGuideCoordinates === "undefined"
    ? 0
    : dispatchLiveGuideCoordinates.length;
  const guideVisible = typeof dispatchCurrentRouteLayerGroup !== "undefined" &&
    typeof dispatchLayerHasVisiblePolyline === "function"
    ? dispatchLayerHasVisiblePolyline(dispatchCurrentRouteLayerGroup)
    : Boolean(patch.liveGuideVisible);
  const guideReason = typeof dispatchLiveGuideLastRerouteReason === "undefined"
    ? String(patch.liveGuideReason || "")
    : dispatchLiveGuideLastRerouteReason;
  const guideAt = typeof dispatchLiveGuideLastRerouteAt === "undefined"
    ? patch.liveGuideAt
    : dispatchLiveGuideLastRerouteAt;
  const guideOrigin = typeof dispatchLiveGuideLastStart === "undefined"
    ? String(patch.liveGuideOrigin || "")
    : dispatchLiveGuideLastStart
      ? `${Number(dispatchLiveGuideLastStart.lat).toFixed(5)}, ${Number(dispatchLiveGuideLastStart.lng).toFixed(5)}`
      : "";
  const guideOriginAt = typeof dispatchLiveGuideLastOriginAt === "undefined"
    ? patch.liveGuideOriginAt
    : dispatchLiveGuideLastOriginAt;
  const alternativeRouteCount = typeof dispatchLiveGuideAlternativeCoordinates === "undefined"
    ? Number(patch.liveGuideAlternativeRouteCount) || 0
    : typeof dispatchLiveGuideAlternativeRouteCount === "undefined"
      ? dispatchLiveGuideAlternativeCoordinates.length
      : dispatchLiveGuideAlternativeRouteCount;
  const alternativeVisibleCount = typeof dispatchAlternativeRouteVisibleCount === "function"
    ? dispatchAlternativeRouteVisibleCount()
    : Number(patch.liveGuideAlternativeVisibleCount) || 0;
  const guideRequestSucceeded = typeof dispatchLiveGuideLastRequestSucceeded === "undefined"
    ? patch.liveGuideRequestSucceeded
    : dispatchLiveGuideLastRequestSucceeded;
  const guideMovedMeters = typeof dispatchLiveGuideMovedMeters === "undefined"
    ? Number(patch.liveGuideMovedMeters)
    : dispatchLiveGuideMovedMeters;
  const guideDistance = typeof dispatchLiveGuideDistanceMeters === "undefined"
    ? Number(patch.liveGuideDistanceMeters)
    : dispatchLiveGuideDistanceMeters;
  const currentStopStatusValue = typeof dispatchCurrentStopStatus === "undefined"
    ? String(patch.currentStopStatus || "")
    : dispatchCurrentStopStatus;

  setTrackingDiagnosticText("trackingActualSegmentCount", actualSegments);
  setTrackingDiagnosticText("trackingActualLayerVisible", actualVisible ? "Yes" : "No");
  setTrackingDiagnosticText("trackingAssignedRoutePointCount", assignedPoints);
  setTrackingDiagnosticText("trackingLiveGuideTarget", guideTarget || "--");
  setTrackingDiagnosticText("trackingLiveGuidePointCount", guidePoints);
  setTrackingDiagnosticText("trackingLiveGuideLayerVisible", guideVisible ? "Yes" : "No");
  setTrackingDiagnosticText("trackingLiveGuideOrigin", guideOrigin || "--");
  setTrackingDiagnosticText(
    "trackingLiveGuideOriginTime",
    guideOriginAt && typeof formatTrackingTimeSafe === "function"
      ? formatTrackingTimeSafe(guideOriginAt)
      : "--"
  );
  setTrackingDiagnosticText("trackingAlternativeRouteCount", alternativeRouteCount);
  setTrackingDiagnosticText("trackingAlternativeVisibleCount", alternativeVisibleCount);
  setTrackingDiagnosticText("trackingLiveGuideReason", guideReason || "--");
  setTrackingDiagnosticText(
    "trackingLiveGuideTime",
    guideAt && typeof formatTrackingTimeSafe === "function" ? formatTrackingTimeSafe(guideAt) : "--"
  );
  setTrackingDiagnosticText(
    "trackingLiveGuideRequestStatus",
    guideRequestSucceeded === true
      ? "Success"
      : guideRequestSucceeded === false
        ? "Failed"
        : guideAt
          ? "Pending"
          : "--"
  );
  setTrackingDiagnosticText(
    "trackingLiveGuideMovedDistance",
    Number.isFinite(Number(guideMovedMeters)) ? `${Math.round(Number(guideMovedMeters))} m` : "--"
  );
  setTrackingDiagnosticText(
    "trackingLiveGuideDistance",
    Number.isFinite(Number(guideDistance)) ? `${Math.round(Number(guideDistance))} m` : "--"
  );
  setTrackingDiagnosticText("trackingCurrentStopStatus", currentStopStatusValue || "--");
}

function updateTrackingRouteStats(routeResult = {}) {
  const routePointCount = document.getElementById("trackingRoutePointCount");
  const rawPointCount = document.getElementById("trackingRawPointCount");
  const filteredPointCount = document.getElementById("trackingFilteredPointCount");
  const acceptedPointCount = document.getElementById("trackingAcceptedPointCount");
  const routeGapCount = document.getElementById("trackingRouteGapCount");
  const diagnosticsNotice = document.getElementById("trackingDiagnosticsNotice");
  if (routePointCount) {
    if (Array.isArray(routeResult)) {
      routePointCount.textContent = String(routeResult.length);
      return;
    }
    const rawCount = Number(routeResult.rawCount || 0);
    const mappedCount = Array.isArray(routeResult.displayedPoints)
      ? routeResult.displayedPoints.length
      : 0;
    routePointCount.textContent = String(mappedCount);
    if (rawPointCount) rawPointCount.textContent = String(rawCount);
    if (acceptedPointCount) acceptedPointCount.textContent = String(mappedCount);
    if (filteredPointCount) {
      filteredPointCount.textContent = String(Math.max(0, rawCount - mappedCount));
    }
    if (routeGapCount) routeGapCount.textContent = String(routeResult.gapCount || 0);
    if (diagnosticsNotice) {
      diagnosticsNotice.textContent = routeResult.fallbackUsed
        ? "Showing the best recent low-accuracy route points; the truck marker remains on its latest reliable position."
        : rawCount
          ? "Raw GPS data remains unchanged; filtering applies only to this map."
          : "Select a truck to inspect its route.";
    }
    updateTrackingMapDiagnostics();
  }
}

function clearTrackingGapPolylines() {
  if (!window.trackingGapPolylines || !Array.isArray(window.trackingGapPolylines)) {
    window.trackingGapPolylines = [];
    return;
  }

  window.trackingGapPolylines.forEach((line) => {
    try {
      if (line && truckMap) {
        truckMap.removeLayer(line);
      }
    } catch (error) {
      // Continue clearing the rest.
    }
  });

  window.trackingGapPolylines = [];
}

function trackingPolylineHasDisplayGeometry(layer) {
  const coordinates = typeof layer?.getLatLngs === "function"
    ? layer.getLatLngs()
    : layer?.geometry;
  const flatten = (items = []) => Array.isArray(items)
    ? items.flatMap((item) => Array.isArray(item) && item.length >= 2 &&
      Number.isFinite(Number(item[0])) && Number.isFinite(Number(item[1]))
      ? [item]
      : flatten(item))
    : [items];
  return flatten(coordinates).filter((point) => {
    const lat = Number(point?.lat ?? point?.[0]);
    const lng = Number(point?.lng ?? point?.[1]);
    return Number.isFinite(lat) && Number.isFinite(lng);
  }).length >= 2;
}

function trackingActualTrailLayerIsVisible(map = truckMap, layerGroup = selectedRoutePolyline) {
  if (!map || !layerGroup) return false;
  if (typeof map.hasLayer === "function" && !map.hasLayer(layerGroup)) return false;
  const layers = typeof layerGroup.getLayers === "function"
    ? layerGroup.getLayers()
    : (Array.isArray(layerGroup.layers) ? layerGroup.layers : []);
  return layers.some((layer) =>
    trackingPolylineHasDisplayGeometry(layer) &&
    (typeof map.hasLayer !== "function" || map.hasLayer(layer))
  );
}

function renderTrackingActualRoute(routePoints = [], matchedResult = null) {
  if (!truckMap) return null;
  const previousLayerGroup = selectedRoutePolyline;
  const previousGapPolylines = Array.isArray(window.trackingGapPolylines)
    ? [...window.trackingGapPolylines]
    : [];
  const nextLayerGroup = L.featureGroup();
  const nextGapPolylines = [];
  let solidSegmentCount = 0;

  const rawSegments = splitTrackingDisplaySegments(routePoints);
  rawSegments.forEach((segment, index) => {
    const rawGeometry = segment.map(trackingPointToLatLng).filter(Boolean);
    const candidateGeometry = matchedResult?.segments?.[index]?.geometry;
    const geometry = Array.isArray(candidateGeometry) &&
      candidateGeometry.length >= 2 &&
      candidateGeometry.every(isValidTrackingLatLngPair)
      ? candidateGeometry
      : rawGeometry;
    if (geometry.length < 2) return;

    L.polyline(geometry, {
      color: TRACKING_ACTUAL_ROUTE_COLOR,
      weight: 6,
      opacity: 0.96,
      pane: "trackingActualRoutePane",
      lineCap: "round",
      lineJoin: "round"
    }).addTo(nextLayerGroup);
    solidSegmentCount += 1;
  });

  for (let index = 1; index < rawSegments.length; index++) {
    const previous = rawSegments[index - 1][rawSegments[index - 1].length - 1];
    const current = rawSegments[index][0];
    const previousPosition = trackingPointToLatLng(previous);
    const currentPosition = trackingPointToLatLng(current);
    if (!previousPosition || !currentPosition) continue;

    const gapLine = L.polyline([previousPosition, currentPosition], {
      color: TRACKING_ACTUAL_ROUTE_COLOR,
      weight: 4,
      opacity: 0.7,
      pane: "trackingActualRoutePane",
      dashArray: "8, 10"
    }).addTo(nextLayerGroup);
    gapLine.bindPopup("Connected display segment after a confirmed synchronization gap.");
    nextGapPolylines.push(gapLine);
  }

  const nextLayers = typeof nextLayerGroup.getLayers === "function"
    ? nextLayerGroup.getLayers()
    : (nextLayerGroup.layers || []);
  if (!nextLayers.some(trackingPolylineHasDisplayGeometry)) {
    updateTrackingMapDiagnostics({
      actualTrailSegments: solidSegmentCount,
      actualTrailVisible: trackingActualTrailLayerIsVisible(truckMap, previousLayerGroup)
    });
    return previousLayerGroup || null;
  }

  nextLayerGroup.addTo(truckMap);
  selectedRoutePolyline = nextLayerGroup;
  if (previousLayerGroup && previousLayerGroup !== nextLayerGroup) {
    truckMap.removeLayer(previousLayerGroup);
  }
  previousGapPolylines.forEach((line) => {
    try {
      truckMap.removeLayer(line);
    } catch (_error) {
      // A group removal may already have removed this child layer.
    }
  });
  window.trackingGapPolylines = nextGapPolylines;
  updateTrackingMapDiagnostics({
    actualTrailSegments: solidSegmentCount,
    actualTrailVisible: trackingActualTrailLayerIsVisible(truckMap, nextLayerGroup)
  });
  return nextLayerGroup;
}

function clearTrackingRoadMatchRequest() {
  trackingRoadMatchRequestId++;
  trackingRoadMatchAbortController?.abort();
  trackingRoadMatchAbortController = null;
}

function clearTrackingDispatchStartMarker() {
  if (selectedDispatchStartMarker && truckMap) {
    truckMap.removeLayer(selectedDispatchStartMarker);
  }
  selectedDispatchStartMarker = null;
  selectedDispatchStartSessionId = "";
}

function ensureTrackingDispatchStartMarker(sessionId, firstPoint) {
  const action = resolveTrackingStartMarkerAction(
    selectedDispatchStartSessionId,
    sessionId,
    firstPoint
  );
  if (action.action === "none") return null;
  if (action.action === "keep" && selectedDispatchStartMarker) {
    return selectedDispatchStartMarker;
  }
  if (action.action === "replace") clearTrackingDispatchStartMarker();

  const startIcon = L.divIcon({
    className: "custom-dispatch-start-marker",
    html: '<span class="tracking-route-endpoint start">S</span>',
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  });
  selectedDispatchStartMarker = L.marker(action.position, {
    icon: startIcon,
    pane: "dispatchMarkerPane",
    zIndexOffset: -100
  }).addTo(truckMap).bindPopup(`
    <strong>Dispatch Start</strong><br>
    Started: ${escapeHtml(formatTrackingTimeSafe(
      firstPoint.recorded_at || firstPoint.created_at || firstPoint.createdAt
    ))}
  `);
  selectedDispatchStartSessionId = String(sessionId || "");
  return selectedDispatchStartMarker;
}

async function renderTrackingRoadMatchedRoute(sessionId, routeSignature, routePoints, options = {}) {
  trackingRoadMatchAbortController?.abort();
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  trackingRoadMatchAbortController = controller;
  const requestId = ++trackingRoadMatchRequestId;

  try {
    const matchedResult = await getCachedTrackingMatch(
      routePoints,
      sessionId,
      routeSignature,
      { signal: controller?.signal }
    );
    if (
      matchedResult.aborted ||
      matchedResult.matchedSegmentCount < 1 ||
      !isTrackingMatchResponseCurrent(sessionId, routeSignature, requestId)
    ) {
      return { applied: false, result: matchedResult };
    }

    renderTrackingActualRoute(routePoints, matchedResult);
    if (!options.keepView && selectedRoutePolyline?.getLayers().length) {
      truckMap.fitBounds(selectedRoutePolyline.getBounds(), { padding: [20, 20] });
    }
    return { applied: true, result: matchedResult };
  } catch (error) {
    return { applied: false, error };
  } finally {
    if (trackingRoadMatchAbortController === controller) {
      trackingRoadMatchAbortController = null;
    }
  }
}

function getRoutePointTimestamp(point) {
  const date = parseTrackingDate(point?.recorded_at || point?.created_at || point?.createdAt);
  return date ? date.getTime() : 0;
}

function buildTrackingMarkerIcon(statusMeta, bearing = null) {
  const color = statusMeta?.key === "active"
    ? "#198754"
    : statusMeta?.key === "sync_pending"
      ? "#f59e0b"
      : statusMeta?.key === "device_offline"
        ? "#6c757d"
        : statusMeta?.key === "gps_off"
          ? "#dc3545"
          : "#6c757d";

  const pulse = statusMeta?.key === "active"
    ? "tracking-marker-pulse"
    : "";
  const normalizedBearing = Number.isFinite(Number(bearing)) ? Number(bearing) : 90;

  return L.divIcon({
    className: `custom-truck-marker ${statusMeta?.className || ""}`,
    html: `
      <div class="truck-marker-bearing" style="--truck-marker-rotation:${normalizedBearing - 90}deg;">
        <div class="truck-marker-shell ${pulse}" style="--truck-marker-color:${color};">
          ${getTrackingInlineIcon("truck")}
        </div>
      </div>
    `,
    iconSize: [38, 38],
    iconAnchor: [19, 19]
  });
}

function getTrackingRouteNotice(routeLogs = []) {
  if (!Array.isArray(routeLogs) || routeLogs.length < 2) {
    return "";
  }

  let gapCount = 0;

  for (let i = 1; i < routeLogs.length; i++) {
    const prevTime = getRoutePointTimestamp(routeLogs[i - 1]);
    const currTime = getRoutePointTimestamp(routeLogs[i]);

    if (prevTime && currTime && currTime - prevTime > TRACKING_ROUTE_GAP_MS) {
      gapCount++;
    }
  }

  if (gapCount <= 0) {
    return "";
  }

  return `${gapCount} route gap${gapCount > 1 ? "s" : ""} connected after mobile sync.`;
}

async function loadActiveTrucks() {
  const request = trackingActiveRequestGuard.begin();
  try {
    const [res] = await Promise.all([
      webAdminFetch(getTrackingActiveApiUrl(), { signal: request.signal }),
      typeof loadDispatchLiveData === "function"
        ? loadDispatchLiveData()
        : Promise.resolve({})
    ]);
    const data = await res.json();
    if (!trackingActiveRequestGuard.isCurrent(request)) return;

    const trackingTrucks = Array.isArray(data)
      ? data
      : (data.data || []);
    const snapshot = buildTrackingAvailabilitySnapshot(
      trackingTrucks,
      (sessionId) => typeof getDispatchTrackingCardForSession === "function"
        ? getDispatchTrackingCardForSession(sessionId)
        : typeof getDispatchLiveForSession === "function"
          ? getDispatchLiveForSession(sessionId)
        : null,
      Date.now(),
      typeof dispatchLiveBySession === "object" ? dispatchLiveBySession : {}
    );
    const trackingSessions = snapshot.sessions;
    const trucks = snapshot.availableTrucks;
    trackingOperationalTrucks = snapshot.operationalTrucks;
    activeTrackingTrucks = trucks;

    if (!selectedSessionId) {
      const monitoredDispatch = resolveTrackingMonitoredDispatch(trackingOperationalTrucks);
      if (monitoredDispatch) {
        selectedSessionId = monitoredDispatch.session_id;
        selectedTruckId = monitoredDispatch.truck_id;
        selectedTrackingTruck = monitoredDispatch;
        renderActiveTruckList(trackingOperationalTrucks);
      }
    }

    renderActiveTruckList(trackingOperationalTrucks);
    updateTruckMarkers(trackingOperationalTrucks);
    updateTrackingSummaryCards(trackingOperationalTrucks);

    if (selectedSessionId) {
      const selectedTruck = trackingOperationalTrucks.find(
        (truck) => String(truck.session_id) === String(selectedSessionId)
      );
      const selectedLiveDispatch = typeof getDispatchTrackingCardForSession === "function"
        ? getDispatchTrackingCardForSession(selectedSessionId)
        : typeof getDispatchLiveForSession === "function"
          ? getDispatchLiveForSession(selectedSessionId)
        : null;

      if (!selectedTruck) {
        if (selectedLiveDispatch) {
          updateTrackingSummaryCards(trackingOperationalTrucks, selectedTrackingTruck);
          return;
        }
        resetTrackingView({ refresh: false });
        updateTrackingSummaryCards(trackingOperationalTrucks, null);
        return;
      }

      selectedTrackingTruck = selectedTruck;
      dispatchSelectedSessionActive = typeof dispatchTruckCanStartNewDispatch === "function"
        ? dispatchTruckCanStartNewDispatch(selectedTruck, activeTrackingTrucks)
        : isTrackingTruckAvailable(selectedTruck);
      updateTrackingActionButtons();
      if (typeof updateDispatchSelectedTruckContext === "function") {
        updateDispatchSelectedTruckContext(selectedTruck);
      }
      if (typeof reconcileDispatchEligibilityWithTracking === "function") {
        reconcileDispatchEligibilityWithTracking(selectedTruck);
      }
      updateTrackingSummaryCards(trackingOperationalTrucks, selectedTruck);

      await hydrateSelectedTruckWorkspace(selectedSessionId, { keepView: true });

      const selectedLabel = document.getElementById("selectedTruckLabel");
      if (selectedLabel) {
        selectedLabel.textContent = selectedTruck.truck_name ||
          selectedTruck.truck_display_name ||
          `Truck ${selectedTruck.truck_id}`;
      }

      const lastUpdated = document.getElementById("trackingLastUpdated");
      if (lastUpdated) {
        lastUpdated.textContent = formatTrackingTimeSafe(
          selectedTruck.location_last_updated || selectedTruck.last_updated_at
        );
      }
    } else {
      updateTrackingRouteStats({ rawCount: 0, displayedPoints: [] });
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
    console.error("Error loading active trucks:", error);

    const trackingSignalStatus = document.getElementById("trackingSignalStatus");
    if (trackingSignalStatus) {
      trackingSignalStatus.textContent = "Unable to refresh";
      trackingSignalStatus.className = "tracking-signal-status warning";
    }
  } finally {
    trackingActiveRequestGuard.finish(request);
  }
}

function invalidateTrackingActiveRequests() {
  trackingActiveRequestGuard.invalidate();
}

function getTrackingInlineIcon(name = "truck") {
  const icons = {
    truck: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 7h11v8H3z"></path>
        <path d="M14 10h3.5L21 13.5V15h-7z"></path>
        <path d="M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"></path>
      </svg>
    `,
    route: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM18 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"></path>
        <path d="M8 7h5.5a3.5 3.5 0 0 1 0 7H10a3 3 0 0 0 0 6h6"></path>
      </svg>
    `
  };

  return icons[name] || icons.truck;
}

function renderActiveTruckList(trucks) {
  const container = document.getElementById("activeTruckList");
  if (!container) return;

  if (!Array.isArray(trucks) || !trucks.length) {
    container.innerHTML = `
      <div class="tracking-empty-state">
        <span class="tracking-empty-icon">${getTrackingInlineIcon("truck")}</span>
        <strong>No available trucks or active dispatches</strong>
        <small>Fresh trucks and ongoing dispatches will appear here.</small>
      </div>
    `;
    return;
  }

  container.innerHTML = trucks.map((truck) => {
    const isSelected = String(selectedSessionId) === String(truck.session_id);
    const channels = getTrackingDisplayChannels(truck);
    const statusMeta = channels.tracking;
    const dispatchState = getTrackingTruckDispatchState(truck);
    const lastGpsValue = getTruckLastUpdateValue(truck);
    const lastSyncValue = getTruckLastSyncValue(truck);
    const truckName = truck.truck_name || truck.truck_display_name || `Truck ${truck.truck_id || "-"}`;
    const truckIdentifier = truck.truck_id || truckName;
    const existingTicket = dispatchState.ticket;
    const hasLiveDispatch = dispatchState.key === "active_dispatch";
    const hasPreparedDispatch = dispatchState.key === "prepared_dispatch";
    const dispatchLabel = hasLiveDispatch
      ? `<small class="dispatch-truck-ticket">Ticket ${escapeHtml(existingTicket.ticket_number)} &middot; Active Dispatch</small>
         <small class="dispatch-truck-progress">Completed ${Number(existingTicket.completed_stops || 0)} of ${Number(existingTicket.total_stops || 0)} stops</small>`
      : hasPreparedDispatch
        ? `<small class="dispatch-truck-ticket">Ticket ${escapeHtml(existingTicket.ticket_number)} &middot; Existing Dispatch Ticket</small>`
        : "";
    const operationalHint = hasLiveDispatch
      ? channels.connectivity.key === "synced"
        ? "Open Live Dispatch"
        : channels.connectivity.key === "sync_pending"
          ? "Open Live Dispatch · Waiting for mobile sync"
          : "Open Live Dispatch · Showing last known route"
      : hasPreparedDispatch
        ? "View Ticket"
        : dispatchState.title;
    const actionLabel = hasLiveDispatch
      ? "Open Live Dispatch for"
      : hasPreparedDispatch
        ? "View Ticket for"
        : dispatchState.available
          ? "Plan dispatch for"
          : "Review dispatch availability for";

    return `
      <button
        type="button"
        class="active-truck-item ${isSelected ? "active" : ""} ${statusMeta.className}"
        data-tracking-session-id="${typeof dispatchEscape === "function" ? dispatchEscape(truck.session_id) : escapeHtml(truck.session_id)}"
        data-tracking-truck-id="${escapeHtml(truck.truck_id || "")}"
        aria-pressed="${isSelected}"
        aria-label="${actionLabel} ${escapeHtml(truckIdentifier)}, ${escapeHtml(channels.gps.label)}, ${escapeHtml(channels.connectivity.label)}"
      >
        <span class="truck-item-icon">${getTrackingInlineIcon("truck")}</span>

        <div class="truck-item-body">
          <div class="truck-list-topline">
            <div>
              <strong>${escapeHtml(truckIdentifier)}</strong>
              ${truckName !== truckIdentifier ? `<small class="truck-id-line">${escapeHtml(truckName)}</small>` : ""}
            </div>

            <span class="tracking-channel-badges" aria-label="GPS and synchronization status">
              <small class="tracking-channel-badge ${channels.gps.className}">
                ${escapeHtml(channels.gps.label)}
              </small>
              <small class="tracking-channel-badge ${channels.connectivity.className}">
                ${escapeHtml(channels.connectivity.label)}
              </small>
            </span>
          </div>

          ${dispatchLabel}

          <small class="truck-sync-detail">
            <span>Last GPS: ${escapeHtml(formatTrackingRelativeUpdate(lastGpsValue))}</span>
            <span>Last sync: ${escapeHtml(formatTrackingRelativeUpdate(lastSyncValue))}</span>
          </small>

          <small class="truck-route-state ${channels.route.className}">
            Route: ${escapeHtml(channels.route.label)}
          </small>

          <small class="truck-plan-hint">${operationalHint}</small>
        </div>
      </button>
    `;
  }).join("");
}

function updateTruckMarkers(trucks) {
  if (!truckMap) return;
  const safeTrucks = Array.isArray(trucks) ? trucks : [];
  const activeSessionIds = new Set(
    safeTrucks.map((truck) => String(truck.session_id))
  );

  Object.keys(truckMarkers).forEach((sessionId) => {
    if (activeSessionIds.has(String(sessionId))) return;
    if (truckMarkers[sessionId]) {
      if (selectedCurrentMarker === truckMarkers[sessionId]) selectedCurrentMarker = null;
      (trackingCurrentTruckLayerGroup || truckMap).removeLayer(truckMarkers[sessionId]);
    }
    delete truckMarkers[sessionId];
    delete trackingMarkerStateBySession[sessionId];
  });

  safeTrucks.forEach((truck) => {
    const sessionId = String(truck.session_id);
    const point = {
      lat: parseTrackingCoordinate(truck.latitude),
      lng: parseTrackingCoordinate(truck.longitude),
      timestamp: getRoutePointTimestamp({ recorded_at: getTruckLastUpdateValue(truck) }),
      accuracy: truck.accuracy
    };
    const hasCoordinates =
      Number.isFinite(point.lat) &&
      Number.isFinite(point.lng) &&
      point.lat >= -90 &&
      point.lat <= 90 &&
      point.lng >= -180 &&
      point.lng <= 180 &&
      !(point.lat === 0 && point.lng === 0);
    const reliable = hasCoordinates && isTrackingPointReliable(point);
    const statusMeta = getTrackingStatusMeta(truck);
    const previousState = trackingMarkerStateBySession[sessionId] || {};
    let marker = truckMarkers[sessionId];
    let movementPlausible = true;

    if (
      marker &&
      reliable &&
      Number.isFinite(previousState.lat) &&
      Number.isFinite(previousState.lng)
    ) {
      const distanceMeters = trackingHaversineMeters(previousState, point);
      const elapsedSeconds =
        point.timestamp > previousState.timestamp
          ? (point.timestamp - previousState.timestamp) / 1000
          : 0;
      movementPlausible = !(
        distanceMeters >= TRACKING_MIN_JUMP_DISTANCE_METERS &&
        (elapsedSeconds <= 0 ||
          distanceMeters / elapsedSeconds > TRACKING_MAX_DISPLAY_SPEED_METERS_PER_SECOND)
      );
    }

    if (!marker && reliable) {
      marker = L.marker([point.lat, point.lng], {
        icon: buildTrackingMarkerIcon(statusMeta, previousState.bearing),
        riseOnHover: true,
        pane: "trackingTruckPane",
        zIndexOffset: 200
      }).addTo(trackingCurrentTruckLayerGroup || truckMap);
      truckMarkers[sessionId] = marker;
      trackingMarkerStateBySession[sessionId] = {
        lat: point.lat,
        lng: point.lng,
        timestamp: point.timestamp,
        statusKey: statusMeta.key,
        bearing: previousState.bearing ?? null
      };
    } else if (marker && reliable && movementPlausible) {
      const isNewer = !previousState.timestamp || point.timestamp >= previousState.timestamp;
      const changedPosition =
        point.lat !== previousState.lat || point.lng !== previousState.lng;
      const nextBearing = changedPosition
        ? trackingBearingDegrees(previousState, point)
        : null;
      const bearing = nextBearing ?? previousState.bearing ?? null;
      if (isNewer && changedPosition) {
        moveTrackingMarker(marker, previousState, point, {
          animate: getTrackingAvailabilityMeta(truck).available
        });
      }
      if (isNewer) {
        trackingMarkerStateBySession[sessionId] = {
          ...previousState,
          lat: point.lat,
          lng: point.lng,
          timestamp: point.timestamp,
          statusKey: statusMeta.key,
          bearing
        };
      }
    }

    if (!marker) return;
    const currentState = trackingMarkerStateBySession[sessionId] || previousState;
    if (
      previousState.statusKey !== statusMeta.key ||
      currentState.bearing !== previousState.bearing
    ) {
      marker.setIcon(buildTrackingMarkerIcon(statusMeta, currentState.bearing));
      trackingMarkerStateBySession[sessionId] = {
        ...currentState,
        statusKey: statusMeta.key
      };
    }
    const accuracyNote = reliable
      ? movementPlausible
        ? `Accuracy: ${getTrackingPointAccuracy(point) ?? "not reported"}${getTrackingPointAccuracy(point) === null ? "" : " m"}`
        : "Latest point ignored because the implied movement is not plausible"
      : `Latest point ignored for map movement (accuracy above ${TRACKING_MAX_RELIABLE_ACCURACY_METERS} m or invalid)`;
    if (!marker.getPopup()) marker.bindPopup("");
    marker.setPopupContent(`
      <strong>Truck ${escapeHtml(truck.truck_id || "-")}</strong><br>
      Status: ${escapeHtml(statusMeta.label)}<br>
      ${escapeHtml(statusMeta.description)}<br>
      ${escapeHtml(accuracyNote)}<br>
      Last sync: ${escapeHtml(formatTrackingTimeSafe(getTruckLastUpdateValue(truck)))}
    `);
  });
}

function updateTruckMarkerWithReliableRoutePoint(sessionId, point) {
  if (!truckMap || !point || !isTrackingPointReliable(point)) return null;
  const sessionKey = String(sessionId);
  const truck = activeTrackingTrucks.find(
    (item) => String(item.session_id) === sessionKey
  ) || selectedTrackingTruck;
  if (!truck) return null;

  const statusMeta = getTrackingStatusMeta(truck);
  const previousState = trackingMarkerStateBySession[sessionKey] || {};
  if (previousState.timestamp && point.timestamp < previousState.timestamp) return truckMarkers[sessionKey] || null;
  let marker = truckMarkers[sessionKey];
  const changedPosition = Number.isFinite(previousState.lat) && Number.isFinite(previousState.lng) &&
    (point.lat !== previousState.lat || point.lng !== previousState.lng);
  const nextBearing = changedPosition
    ? trackingBearingDegrees(previousState, point)
    : null;
  const bearing = nextBearing ?? previousState.bearing ?? null;
  if (!marker) {
    marker = L.marker([point.lat, point.lng], {
      icon: buildTrackingMarkerIcon(statusMeta, bearing),
      riseOnHover: true,
      pane: "trackingTruckPane",
      zIndexOffset: 200
    }).addTo(trackingCurrentTruckLayerGroup || truckMap).bindPopup("");
    truckMarkers[sessionKey] = marker;
  } else {
    moveTrackingMarker(marker, previousState, point, {
      animate: getTrackingAvailabilityMeta(truck).available
    });
    if (previousState.statusKey !== statusMeta.key || bearing !== previousState.bearing) {
      marker.setIcon(buildTrackingMarkerIcon(statusMeta, bearing));
    }
  }
  trackingMarkerStateBySession[sessionKey] = {
    lat: point.lat,
    lng: point.lng,
    timestamp: point.timestamp,
    statusKey: statusMeta.key,
    bearing
  };
  if (!marker.getPopup()) marker.bindPopup("");
  marker.setPopupContent(`
    <strong>Truck ${escapeHtml(truck.truck_id || "-")}</strong><br>
    Status: ${escapeHtml(statusMeta.label)}<br>
    ${escapeHtml(statusMeta.description)}<br>
    Accuracy: ${escapeHtml(getTrackingPointAccuracy(point) ?? "not reported")}${getTrackingPointAccuracy(point) === null ? "" : " m"}<br>
    Last reliable point: ${escapeHtml(formatTrackingTimeSafe(point.recorded_at || point.created_at || point.createdAt))}
  `);
  return marker;
}

async function loadTruckRoute(sessionId, options = {}) {
  if (!truckMap) return;

  const { keepView = false } = options;
  const routeLoadRequestId = ++trackingRouteLoadRequestId;

  try {
    const res = await webAdminFetch(getTrackingRouteApiUrl(sessionId));
    const data = await res.json();

    if (
      routeLoadRequestId !== trackingRouteLoadRequestId ||
      String(selectedSessionId || "") !== String(sessionId || "")
    ) return;

    const routeLogs = Array.isArray(data?.data?.route_logs)
      ? data.data.route_logs
      : [];

    const routeResult = buildTrackingDisplayRoute(routeLogs);
    const routePoints = routeResult.displayedPoints;

    if (!routePoints.length) {
      if (!selectedRoutePolyline) updateTrackingRouteStats(routeResult);
      return;
    }

    updateTrackingRouteStats(routeResult);

    const latlngs = routePoints.map((p) => [p.lat, p.lng]);
    const nextRouteSignature = trackingRouteSignature(routePoints);
    const routeChanged = nextRouteSignature !== selectedRouteSignature ||
      !trackingActualTrailLayerIsVisible(truckMap, selectedRoutePolyline);
    if (routeChanged) {
      renderTrackingActualRoute(routePoints);
      selectedRouteSignature = nextRouteSignature;
    }

    const startPoint = latlngs[0];
    ensureTrackingDispatchStartMarker(sessionId, routeResult.startPoint || routePoints[0]);
    const currentReliablePoint = routeResult.markerPoint;

    if (currentReliablePoint) {
      selectedReliableRoutePoint = currentReliablePoint;
      selectedCurrentMarker = updateTruckMarkerWithReliableRoutePoint(
        sessionId,
        currentReliablePoint
      );
      if (typeof updateDispatchSelectedTruckContext === "function") {
        updateDispatchSelectedTruckContext(selectedTrackingTruck);
      }
    }

    if (!keepView && routeChanged) {
      if (selectedRoutePolyline.getLayers().length) {
        truckMap.fitBounds(selectedRoutePolyline.getBounds(), {
          padding: [20, 20]
        });
      } else {
        truckMap.setView(startPoint, 17);
      }
    }

    if (routeChanged) {
      void renderTrackingRoadMatchedRoute(
        sessionId,
        nextRouteSignature,
        routePoints,
        { keepView }
      );
    }

    const lastUpdated = document.getElementById("trackingLastUpdated");
    if (lastUpdated) {
      const lastPoint = currentReliablePoint || routePoints[routePoints.length - 1];
      lastUpdated.textContent = formatTrackingTimeSafe(
        lastPoint.recorded_at || lastPoint.created_at || lastPoint.createdAt
      );
    }

  } catch (error) {
    console.error("Error loading route:", error);
  }
}

async function hydrateSelectedTruckWorkspace(sessionId, options = {}) {
  await loadTruckRoute(sessionId, options);
  if (String(selectedSessionId || "") !== String(sessionId || "")) return null;
  if (typeof loadDispatchForTrackingSession !== "function") return null;
  return loadDispatchForTrackingSession(sessionId, {
    refreshOnly: options.keepView === true
  });
}

function resetTrackingView(options = {}) {
  trackingRouteLoadRequestId++;
  clearTrackingRoadMatchRequest();
  if (selectedRoutePolyline && truckMap) {
    truckMap.removeLayer(selectedRoutePolyline);
    selectedRoutePolyline = null;
  }

  clearTrackingGapPolylines();
  clearTrackingDispatchStartMarker();

  selectedCurrentMarker = null;

  selectedSessionId = null;
  selectedTruckId = null;
  selectedTrackingTruck = null;
  selectedReliableRoutePoint = null;
  selectedRouteSignature = "";
  dispatchSelectedSessionActive = false;
  if (typeof clearDispatchTrackingSelection === "function") {
    clearDispatchTrackingSelection();
  }

  const selectedLabel = document.getElementById("selectedTruckLabel");
  if (selectedLabel) {
    selectedLabel.textContent = "No truck selected";
  }

  const lastUpdated = document.getElementById("trackingLastUpdated");
  if (lastUpdated) {
    lastUpdated.textContent = "--";
  }

  updateTrackingRouteStats({ rawCount: 0, displayedPoints: [] });
  updateTrackingMapDiagnostics({
    actualTrailSegments: 0,
    actualTrailVisible: false,
    assignedRoutePoints: 0,
    liveGuideTarget: "",
    liveGuideReason: "",
    liveGuideAt: null,
    liveGuideDistanceMeters: null,
    currentStopStatus: "",
    liveGuideVisible: false
  });

  const trackingSignalStatus = document.getElementById("trackingSignalStatus");
  if (trackingSignalStatus) {
    trackingSignalStatus.textContent = "No selected truck";
    trackingSignalStatus.className = "tracking-signal-status idle";
  }

  updateTrackingActionButtons();
  if (truckMap) truckMap.setView([6.1164, 125.1716], 13);
  if (options.refresh !== false) loadActiveTrucks();
}

function renderMonitoringAlerts(alerts, activeTrucks = []) {
  const monitoringAlertList = document.getElementById("monitoringAlertList");
  const monitoringActiveTruckCount = document.getElementById("monitoringActiveTruckCount");
  const monitoringMaintenanceCount = document.getElementById("monitoringMaintenanceCount");

  if (!monitoringAlertList || !monitoringActiveTruckCount || !monitoringMaintenanceCount) {
    return;
  }

  const safeAlerts = Array.isArray(alerts) ? alerts : [];
  const maintenanceAlerts = safeAlerts.filter(isMaintenanceAlert);

  monitoringActiveTruckCount.textContent = String(activeTrucks.length);
  monitoringMaintenanceCount.textContent = String(maintenanceAlerts.length);

  if (!safeAlerts.length) {
    monitoringAlertList.innerHTML = `
      <div class="summary-item">
        <span>No truck monitoring alerts yet.</span>
      </div>
    `;
    return;
  }

  monitoringAlertList.innerHTML = safeAlerts.slice(0, 3).map((alert) => `
    <div class="summary-item">
      <div class="monitoring-alert-title">${escapeHtml(alert.title || "Truck Alert")}</div>
      <div class="monitoring-alert-message">${escapeHtml(alert.message || "No message available.")}</div>
      <div class="monitoring-alert-time">${escapeHtml(formatMonitoringTime(alert.created_at || alert.createdAt))}</div>
    </div>
  `).join("");
}

function isTruckMonitoringAlert(alert) {
  if (!alert) return false;

  const type = String(alert.type || "").toLowerCase();
  const title = String(alert.title || "").toLowerCase();
  const message = String(alert.message || alert.notification_text || "").toLowerCase();
  const category = String(alert.category || "").toLowerCase();

  return (
    type.includes("truck") ||
    type.includes("tracking") ||
    type.includes("route") ||
    type.includes("gps") ||
    type.includes("maintenance") ||
    category.includes("truck") ||
    category.includes("tracking") ||
    category.includes("route") ||
    category.includes("gps") ||
    category.includes("maintenance") ||
    title.includes("truck") ||
    title.includes("tracking") ||
    title.includes("route") ||
    title.includes("gps") ||
    title.includes("maintenance") ||
    message.includes("truck") ||
    message.includes("tracking") ||
    message.includes("route") ||
    message.includes("gps") ||
    message.includes("location") ||
    message.includes("driver") ||
    message.includes("maintenance")
  );
}

function isMaintenanceAlert(alert) {
  if (!alert) return false;

  const type = String(alert.type || "").toLowerCase();
  const title = String(alert.title || "").toLowerCase();
  const message = String(alert.message || alert.notification_text || "").toLowerCase();
  const category = String(alert.category || "").toLowerCase();

  return (
    type.includes("maintenance") ||
    category.includes("maintenance") ||
    title.includes("maintenance") ||
    message.includes("maintenance") ||
    message.includes("service due") ||
    message.includes("repair") ||
    message.includes("oil change") ||
    message.includes("engine check")
  );
}

async function loadMonitoringPreview() {
  try {
    const [notifRes, trackingRes] = await Promise.all([
      fetch(getNotificationsApiUrl()),
      webAdminFetch(getTrackingActiveApiUrl())
    ]);

    const notifData = await notifRes.json();
    const trackingData = await trackingRes.json();

    const allAlerts = Array.isArray(notifData)
      ? notifData
      : (notifData.data || notifData.notifications || []);

    const activeTrucks = filterAvailableTrackingTrucks(Array.isArray(trackingData)
      ? trackingData
      : (trackingData.data || []));

    // Filter only truck-related alerts
    const truckAlerts = allAlerts.filter(isTruckMonitoringAlert);

    renderMonitoringAlerts(truckAlerts, activeTrucks);
    renderSystemRecommendations();
  } catch (error) {
    console.error("Error loading monitoring preview:", error);

    const monitoringAlertList = document.getElementById("monitoringAlertList");
    const monitoringActiveTruckCount = document.getElementById("monitoringActiveTruckCount");
    const monitoringMaintenanceCount = document.getElementById("monitoringMaintenanceCount");

    if (monitoringActiveTruckCount) monitoringActiveTruckCount.textContent = "0";
    if (monitoringMaintenanceCount) monitoringMaintenanceCount.textContent = "0";

    if (monitoringAlertList) {
      monitoringAlertList.innerHTML = `
        <div class="summary-item">
          <span>Failed to load monitoring alerts.</span>
        </div>
      `;
    }
  }
}

function renderTruckAnalyticsModal(alerts, activeTrucks = []) {
  const modalTotalAlerts = document.getElementById("modalTotalAlerts");
  const modalActiveTrucks = document.getElementById("modalActiveTrucks");
  const modalMaintenanceAlerts = document.getElementById("modalMaintenanceAlerts");
  const modalMonitoringAlertList = document.getElementById("modalMonitoringAlertList");
  const modalTruckStatusList = document.getElementById("modalTruckStatusList");
  const modalTruckDistanceChart = document.getElementById("modalTruckDistanceChart");
  const modalTruckRecommendationList = document.getElementById("modalTruckRecommendationList");

  if (
    !modalTotalAlerts ||
    !modalActiveTrucks ||
    !modalMaintenanceAlerts ||
    !modalMonitoringAlertList ||
    !modalTruckStatusList ||
    !modalTruckDistanceChart ||
    !modalTruckRecommendationList
  ) {
    return;
  }

  const maintenanceAlerts = alerts.filter(
    (alert) => String(alert.type || "").toLowerCase() === "maintenance"
  );

  modalTotalAlerts.textContent = String(alerts.length);
  modalActiveTrucks.textContent = String(activeTrucks.length);
  modalMaintenanceAlerts.textContent = String(maintenanceAlerts.length);

  if (!alerts.length) {
    modalMonitoringAlertList.innerHTML = `
      <div class="summary-item">
        <span>No monitoring alerts yet.</span>
      </div>
    `;
  } else {
    modalMonitoringAlertList.innerHTML = alerts.map((alert) => `
      <div class="truck-analytics-feed-item">
        <div class="truck-analytics-feed-title">${escapeHtml(alert.title || "Truck Alert")}</div>
        <div class="truck-analytics-feed-message">${escapeHtml(alert.message || "No message available.")}</div>
        <div class="truck-analytics-feed-time">${escapeHtml(formatModalDateTime(alert.created_at || alert.createdAt))}</div>
      </div>
    `).join("");
  }

  if (!activeTrucks.length) {
    modalTruckStatusList.innerHTML = `
      <div class="truck-analytics-empty">
        <span class="truck-analytics-empty-icon" aria-hidden="true">${getTrackingInlineIcon("truck")}</span>
        <strong>No active trucks available.</strong>
        <small>Active tracking sessions will appear here.</small>
      </div>
    `;
  } else {
    modalTruckStatusList.innerHTML = activeTrucks.map((truck) => `
      <div class="truck-analytics-feed-item">
        <div class="truck-analytics-feed-title">Truck ${escapeHtml(truck.truck_id || "-")}</div>
        <div class="truck-analytics-feed-message">
          Status: ${escapeHtml(truck.truck_status || "-")}<br>
          Last Updated: ${escapeHtml(formatTrackingTime(truck.location_last_updated))}
        </div>
      </div>
    `).join("");
  }

  const distanceItems = activeTrucks
    .map((truck) => ({
      label: truck.truck_id || "Unknown Truck",
      value: Number(truck.session_distance_km || truck.total_distance_km || 0)
    }))
    .sort((a, b) => b.value - a.value);

  const maxValue = Math.max(...distanceItems.map((item) => item.value), 0);

  if (!distanceItems.length || maxValue === 0) {
    modalTruckDistanceChart.innerHTML = `
      <div class="truck-analytics-empty">
        <span class="truck-analytics-empty-icon" aria-hidden="true">${getTrackingInlineIcon("route")}</span>
        <strong>No truck distance data available yet.</strong>
        <small>Distance appears after tracked movement is recorded.</small>
      </div>
    `;
  } else {
    modalTruckDistanceChart.innerHTML = distanceItems.map((item) => {
      const width = Math.max((item.value / maxValue) * 100, item.value > 0 ? 8 : 0);

      return `
        <div class="truck-distance-row">
          <div class="truck-distance-meta">
            <span>${escapeHtml(item.label)}</span>
            <span>${escapeHtml(item.value.toFixed(2))} km</span>
          </div>
          <div class="truck-distance-track">
            <div class="truck-distance-fill" style="width:${width}%"></div>
          </div>
        </div>
      `;
    }).join("");
  }

  const recommendations = [];

  if (maintenanceAlerts.length > 0) {
    recommendations.push("Some trucks have reached maintenance condition. Schedule preventive service immediately.");
  }

  if (activeTrucks.length === 0) {
    recommendations.push("No active trucks are currently tracked. Check if GPS tracking is enabled on the mobile device.");
  }

  const highestDistanceTruck = distanceItems[0];
  if (highestDistanceTruck && highestDistanceTruck.value > 0) {
    recommendations.push(
      `Truck ${highestDistanceTruck.label} currently has the highest monitored distance at ${highestDistanceTruck.value.toFixed(2)} km.`
    );
  }

  if (!recommendations.length) {
    recommendations.push("Fleet monitoring is stable. Continue tracking active truck movement and maintenance thresholds.");
  }

  modalTruckRecommendationList.innerHTML = recommendations.map((item) => `
    <div class="truck-analytics-feed-item">
      <div class="truck-analytics-feed-message">${escapeHtml(item)}</div>
    </div>
  `).join("");
}

async function loadTruckAnalyticsModalData() {
  try {
    const [notifRes, trackingRes] = await Promise.all([
      fetch(getNotificationsApiUrl()),
      webAdminFetch(getTrackingActiveApiUrl())
    ]);

    const notifData = await notifRes.json();
    const trackingData = await trackingRes.json();

    const alerts = Array.isArray(notifData)
      ? notifData
      : (notifData.data || notifData.notifications || []);

    const activeTrucks = filterAvailableTrackingTrucks(Array.isArray(trackingData)
      ? trackingData
      : (trackingData.data || []));

    renderTruckAnalyticsModal(alerts, activeTrucks);
  } catch (error) {
    console.error("Error loading truck analytics modal:", error);

    const ids = [
      "modalMonitoringAlertList",
      "modalTruckStatusList",
      "modalTruckDistanceChart",
      "modalTruckRecommendationList"
    ];

    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.innerHTML = `
          <div class="summary-item">
            <span>Failed to load analytics data.</span>
          </div>
        `;
      }
    });
  }
}

function bindTruckAnalyticsModalActions() {
  const openBtn = document.getElementById("viewAllTruckAnalyticsBtn");
  const closeBtn = document.getElementById("closeTruckAnalyticsBtn");
  const modal = document.getElementById("truckAnalyticsModal");
  const overlay = document.getElementById("truckAnalyticsOverlay");

  openBtn?.addEventListener("click", async () => {
    modal?.classList.remove("hidden");
    await loadTruckAnalyticsModalData();
  });

  closeBtn?.addEventListener("click", () => {
    modal?.classList.add("hidden");
  });

  overlay?.addEventListener("click", () => {
    modal?.classList.add("hidden");
  });
}

function selectTruck(sessionId, truckId, options = {}) {
  if (typeof markDispatchWorkspaceNavigation === "function") {
    markDispatchWorkspaceNavigation();
  }
  const isDifferentSession = String(selectedSessionId || "") !== String(sessionId);
  if (isDifferentSession) {
    trackingRouteLoadRequestId++;
    clearTrackingRoadMatchRequest();
    if (selectedRoutePolyline && truckMap) truckMap.removeLayer(selectedRoutePolyline);
    selectedRoutePolyline = null;
    selectedRouteSignature = "";
    clearTrackingGapPolylines();
    clearTrackingDispatchStartMarker();
    selectedCurrentMarker = null;
    selectedReliableRoutePoint = null;
  }

  selectedSessionId = sessionId;
  selectedTruckId = truckId;
  selectedTrackingTruck = trackingOperationalTrucks.find(
    (truck) => String(truck.session_id) === String(sessionId)
  ) || activeTrackingTrucks.find(
    (truck) => String(truck.session_id) === String(sessionId)
  ) || null;
  dispatchSelectedSessionActive = Boolean(
    selectedTrackingTruck &&
    (typeof dispatchTruckCanStartNewDispatch === "function"
      ? dispatchTruckCanStartNewDispatch(selectedTrackingTruck, activeTrackingTrucks)
      : isTrackingTruckAvailable(selectedTrackingTruck))
  );

  const selectedLabel = document.getElementById("selectedTruckLabel");
  if (selectedLabel) {
    selectedLabel.textContent = selectedTrackingTruck?.truck_name ||
      selectedTrackingTruck?.truck_display_name ||
      `Truck ${truckId}`;
  }

  updateTrackingActionButtons();
  renderActiveTruckList(trackingOperationalTrucks);
  updateTrackingSummaryCards(activeTrackingTrucks);
  if (options.preparePlanner !== false && typeof prepareDispatchPlannerForTruck === "function") {
    prepareDispatchPlannerForTruck(selectedTrackingTruck);
  }
  if (options.hydrateWorkspace !== false) {
    void hydrateSelectedTruckWorkspace(sessionId, { keepView: false });
  }
}

function bindActiveTruckSelection() {
  const list = document.getElementById("activeTruckList");
  if (!list || list.dataset.bound === "true") return;
  list.dataset.bound = "true";
  list.addEventListener("click", (event) => {
    const card = event.target.closest("[data-tracking-session-id]");
    if (!card) return;
    if (typeof requestDispatchTruckSelection === "function") {
      void requestDispatchTruckSelection(
        card.dataset.trackingSessionId,
        card.dataset.trackingTruckId,
        card
      );
    } else {
      selectTruck(card.dataset.trackingSessionId, card.dataset.trackingTruckId);
    }
  });
}

function updateTrackingActionButtons() {
  const forceStopBtn = document.getElementById("forceStopTruckBtn");
  const resetBtn = document.getElementById("resetTrackingViewBtn");

  if (forceStopBtn) {
    const canStop = Boolean(
      selectedSessionId &&
      selectedTrackingTruck &&
      String(selectedTrackingTruck.session_status || "").toLowerCase() === "active"
    );
    forceStopBtn.disabled = !canStop;
    forceStopBtn.hidden = !canStop;
  }

  if (resetBtn && !resetBtn.dataset.bound) {
    resetBtn.dataset.bound = "true";
    resetBtn.addEventListener("click", resetTrackingView);
  }

  if (forceStopBtn && !forceStopBtn.dataset.bound) {
    forceStopBtn.dataset.bound = "true";
    forceStopBtn.addEventListener("click", () => {
      if (selectedSessionId) {
        forceStopTruckSession(selectedSessionId);
      }
    });
  }
}

async function forceStopTruckSession(sessionId) {
  if (!sessionId) return;

  if (!confirm("Are you sure you want to stop this truck session?")) {
    return;
  }

  try {
    const response = await webAdminFetch(getTrackingForceStopApiUrl(sessionId), {
      method: "PUT",
      headers: {
        "Accept": "application/json"
      }
    });

    const data = await response.json();

    if (!response.ok || data.success === false) {
      throw new Error(data.message || "Failed to stop truck session.");
    }

    showToast("Truck session stopped successfully.", "success");
    resetTrackingView();
  } catch (error) {
    console.error("forceStopTruckSession error:", error);
    showToast(error.message || "Failed to stop truck session.", "error");
  }
}

let trackingRealtimeRefreshTimer = null;
let trackingRealtimeSocketBound = false;
let trackingRealtimeBindRetryTimer = null;

function scheduleTrackingRealtimeRefresh(reason = "tracking:refresh") {
  if (trackingRealtimeRefreshTimer) {
    clearTimeout(trackingRealtimeRefreshTimer);
  }

  trackingRealtimeRefreshTimer = setTimeout(() => {
    trackingRealtimeRefreshTimer = null;
    loadActiveTrucks();
  }, 150);
}

function bindTrackingRealtimeRefresh() {
  if (trackingRealtimeSocketBound) return;

  const realtimeSocket =
    typeof notificationRealtimeSocket !== "undefined"
      ? notificationRealtimeSocket
      : null;

  if (!realtimeSocket || typeof realtimeSocket.on !== "function") {
    if (!trackingRealtimeBindRetryTimer) {
      trackingRealtimeBindRetryTimer = setTimeout(() => {
        trackingRealtimeBindRetryTimer = null;
        bindTrackingRealtimeRefresh();
      }, 500);
    }
    return;
  }

  trackingRealtimeSocketBound = true;

  realtimeSocket.on("tracking:refresh", (payload = {}) => {
    scheduleTrackingRealtimeRefresh(payload.reason || "tracking:refresh");
  });

  realtimeSocket.on("connect", () => {
    scheduleTrackingRealtimeRefresh("socket-connected");
  });
}

function startTrackingAutoRefresh() {
  if (trackingPollInterval) {
    clearInterval(trackingPollInterval);
  }

  bindActiveTruckSelection();
  updateTrackingActionButtons();
  bindTrackingRealtimeRefresh();
  loadActiveTrucks();

  trackingPollInterval = setInterval(() => {
    loadActiveTrucks();
  }, 5000);

  if (typeof window !== "undefined" && !window.__trackingAutoRefreshResumeBound) {
    const refreshTrackingOnResume = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      loadActiveTrucks();
    };

    window.addEventListener("focus", refreshTrackingOnResume);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", refreshTrackingOnResume);
    }
    window.__trackingAutoRefreshResumeBound = true;
  }
}

function stopTrackingAutoRefresh() {
  if (trackingPollInterval) {
    clearInterval(trackingPollInterval);
    trackingPollInterval = null;
  }
}

if (typeof window !== "undefined") {
  window.selectTruck = selectTruck;
}

// =============================
// TRACKING REPORTS
// =============================

function getTrackingReportsApiUrl() {
  const apiBase = typeof getAppApiBase === "function"
    ? getAppApiBase()
    : `${window.location.origin}/api`;

  return `${apiBase.replace(/\/$/, "")}/tracking/reports`;
}

function getTrackingReportDetailsApiUrl(sessionId) {
  return `${getTrackingReportsApiUrl()}/${encodeURIComponent(sessionId)}`;
}

function formatTrackingReportDateTime(value) {
  const raw = value === null || value === undefined ? "" : String(value).trim();
  if (!raw || raw.toLowerCase() === "null") return "--";

  const mysqlMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (mysqlMatch) {
    const [, year, month, day, hour, minute, second = "00"] = mysqlMatch;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );

    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleString();
    }
  }

  try {
    if (typeof formatTrackingTime === "function") {
      return formatTrackingTime(raw);
    }
  } catch (error) {
    // Fallback below.
  }

  const date = parseTrackingDate(raw);
  return date ? date.toLocaleString() : raw;
}

function normalizeReportText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeReportStatusKey(value) {
  const raw = normalizeReportText(value).toLowerCase();

  if (["gps_off", "tracking_off", "permission_missing", "no_permission", "off"].includes(raw)) {
    return "gps_off";
  }

  if (["sync_pending", "weak_signal", "pending", "offline"].includes(raw)) {
    return "sync_pending";
  }

  if (["active", "live", "on", "synced"].includes(raw)) {
    return "active";
  }

  return raw || "gps_off";
}

function getTrackingReportRouteMeta(report = {}) {
  const routeCount = Number(report.route_logs_count || report.route_count || 0);
  const distanceKm = Number(report.session_distance_km || report.total_distance_km || 0);
  const hasRoute = routeCount > 0 || distanceKm > 0;

  let routeText = "No route";

  if (routeCount > 0) {
    routeText = `${routeCount} point${routeCount === 1 ? "" : "s"}`;
  } else if (distanceKm > 0) {
    routeText = `${distanceKm.toFixed(2)} km route`;
  }

  return {
    routeCount,
    distanceKm,
    hasRoute,
    routeText
  };
}

function getTrackingReportStatusMeta(report = {}) {
  const rawLabel = normalizeReportText(report.report_status_label);
  const rawTone = normalizeReportText(report.report_status_tone).toLowerCase();
  const sessionStatus = normalizeReportText(report.session_status || report.status).toLowerCase();
  const routeMeta = getTrackingReportRouteMeta(report);

  const finalStatus = normalizeReportStatusKey(
    report.tracking_status_key ||
    report.final_tracking_status_key ||
    report.last_device_status ||
    report.final_gps_status ||
    ""
  );

  let label = "Completed Normally";
  let tone = "completed";
  let key = "completed";

  if (sessionStatus === "active") {
    if (finalStatus === "gps_off") {
      label = routeMeta.hasRoute ? "Active · GPS Off" : "Active · No GPS Route";
      tone = "gps-off";
      key = routeMeta.hasRoute ? "active_gps_off_partial_route" : "active_gps_off_no_route";
    } else if (finalStatus === "sync_pending") {
      label = "Active · Sync Pending";
      tone = "sync-pending";
      key = routeMeta.hasRoute ? "active_sync_pending_route" : "active_sync_pending_no_route";
    } else {
      label = routeMeta.hasRoute ? "Active · Live Route" : "Active · Live";
      tone = "active";
      key = routeMeta.hasRoute ? "active_live_route" : "active_live_no_route";
    }
  } else if (sessionStatus === "auto_stopped") {
    if (finalStatus === "gps_off") {
      label = routeMeta.hasRoute ? "Shift Completed · GPS Off" : "Shift Completed · No GPS Route";
      tone = "gps-off";
      key = routeMeta.hasRoute ? "shift_completed_gps_off_partial_route" : "shift_completed_no_gps_route";
    } else if (finalStatus === "sync_pending") {
      label = routeMeta.hasRoute ? "Shift Completed · Synced Route" : "Shift Completed · Sync Pending";
      tone = "sync-pending";
      key = routeMeta.hasRoute ? "shift_completed_synced_route" : "shift_completed_sync_pending_no_route";
    } else {
      label = routeMeta.hasRoute ? "Shift Completed · Route Recorded" : "Shift Completed · No Route";
      tone = routeMeta.hasRoute ? "completed" : "neutral";
      key = routeMeta.hasRoute ? "shift_completed_route_recorded" : "shift_completed_no_route";
    }
  } else if (sessionStatus === "stopped") {
    if (finalStatus === "gps_off") {
      label = routeMeta.hasRoute ? "Stopped · GPS Off" : "Stopped · No GPS Route";
      tone = "gps-off";
      key = routeMeta.hasRoute ? "stopped_gps_off_partial_route" : "stopped_no_gps_route";
    } else if (finalStatus === "sync_pending") {
      label = "Stopped · Sync Pending";
      tone = "sync-pending";
      key = routeMeta.hasRoute ? "stopped_sync_pending_route" : "stopped_sync_pending_no_route";
    } else {
      label = routeMeta.hasRoute ? "Manually Stopped · Route Recorded" : "Manually Stopped · No Route";
      tone = routeMeta.hasRoute ? "stopped" : "neutral";
      key = routeMeta.hasRoute ? "stopped_route_recorded" : "stopped_no_route";
    }
  } else if (sessionStatus) {
    label = sessionStatus.replace(/_/g, " ");
    tone = "neutral";
    key = sessionStatus;
  }

  /*
    Backend may still return old labels for existing deployments.
    Trust backend labels only when they do not contradict the route evidence.
  */
  const rawLabelLooksWrong =
    rawLabel &&
    routeMeta.hasRoute &&
    /no\s+route|no\s+gps\s+route/i.test(rawLabel);

  if (rawLabel && !rawLabelLooksWrong) {
    label = rawLabel;
    tone = rawTone || tone;
    key = normalizeReportText(report.report_status_key) || key;
  }

  return {
    label,
    tone,
    gpsLabel: normalizeReportText(report.gps_condition_label) || getTrackingReportGpsLabel(finalStatus, routeMeta),
    description: getTrackingReportDescription(report, finalStatus, routeMeta),
    key,
    routeCount: routeMeta.routeCount,
    distanceKm: routeMeta.distanceKm,
    hasRoute: routeMeta.hasRoute,
    routeText: normalizeReportText(report.route_condition_label) || routeMeta.routeText,
    finalStatus
  };
}

function getTrackingReportGpsLabel(statusKey, routeMeta = {}) {
  const hasRoute = !!routeMeta.hasRoute;

  if (statusKey === "gps_off") {
    return hasRoute ? "GPS Off / Partial Route" : "GPS Off / No GPS Route";
  }

  if (statusKey === "sync_pending") {
    return hasRoute ? "Sync Pending / Route Recorded" : "Sync Pending / No Route";
  }

  return hasRoute ? "GPS Active / Route Recorded" : "GPS Active / No Route Yet";
}

function getTrackingReportDescription(report = {}, finalStatus = "", routeMeta = {}) {
  const direct = normalizeReportText(report.report_status_description || report.final_tracking_status_description);
  const directLooksWrong = direct && routeMeta.hasRoute && /no\s+route|no\s+route\s+points/i.test(direct);

  if (direct && !directLooksWrong) {
    return direct;
  }

  if (finalStatus === "gps_off") {
    return routeMeta.hasRoute
      ? "GPS was turned off before the shift ended, but earlier route data was recorded."
      : "GPS was off or unavailable during the shift, so no route points were recorded.";
  }

  if (finalStatus === "sync_pending") {
    return routeMeta.hasRoute
      ? "The mobile device had weak signal or delayed sync, but route data was recorded."
      : "The mobile device had weak signal or delayed sync and no route points were recorded.";
  }

  return routeMeta.hasRoute
    ? "GPS stayed available and the shift completed with route data recorded."
    : "The session completed, but no route points were recorded.";
}

function renderTrackingReportStatusBadge(report = {}) {
  const meta = getTrackingReportStatusMeta(report);

  return `
    <span class="tracking-report-status-badge tracking-report-status-${escapeHtml(meta.tone || "neutral")}">
      ${escapeHtml(meta.label)}
    </span>
  `;
}

function getTrackingReportSession(data = {}) {
  return data && data.session ? data.session : (data || {});
}

function renderTrackingReportSummary(data = {}, logs = []) {
  const mapContainer = document.getElementById("trackingReportMap");
  if (!mapContainer || !mapContainer.parentElement) return;

  const session = getTrackingReportSession(data);
  const statusMeta = getTrackingReportStatusMeta({
    ...session,
    route_logs_count: Array.isArray(logs) ? logs.length : Number(session.route_logs_count || 0)
  });

  let panel = document.getElementById("trackingReportSummaryPanel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "trackingReportSummaryPanel";
    panel.className = "tracking-report-summary-panel";
    mapContainer.parentElement.insertBefore(panel, mapContainer);
  }

  const description = statusMeta.description || (
    statusMeta.tone === "gps-off"
      ? "GPS was off or no live route points were recorded during this shift."
      : statusMeta.tone === "sync-pending"
        ? "Mobile signal was weak or pending before the shift ended."
        : "Tracking session was completed with normal route data."
  );

  panel.innerHTML = `
    <div class="tracking-report-summary-head">
      <div>
        <span class="tracking-report-eyebrow">Session Result</span>
        <h4>${escapeHtml(statusMeta.label)}</h4>
        <p>${escapeHtml(description)}</p>
      </div>
      ${renderTrackingReportStatusBadge({ ...session, route_logs_count: statusMeta.routeCount })}
    </div>
    <div class="tracking-report-summary-grid">
      <div class="tracking-report-summary-item">
        <span>Truck</span>
        <strong>${escapeHtml(session.truck_id || "-")}</strong>
      </div>
      <div class="tracking-report-summary-item">
        <span>GPS Condition</span>
        <strong>${escapeHtml(statusMeta.gpsLabel)}</strong>
      </div>
      <div class="tracking-report-summary-item">
        <span>Route Evidence</span>
        <strong>${escapeHtml(statusMeta.routeText || String(statusMeta.routeCount || 0))}</strong>
      </div>
      <div class="tracking-report-summary-item">
        <span>Start</span>
        <strong>${escapeHtml(formatTrackingReportDateTime(session.started_at))}</strong>
      </div>
      <div class="tracking-report-summary-item">
        <span>End</span>
        <strong>${escapeHtml(session.ended_at ? formatTrackingReportDateTime(session.ended_at) : "Still Active")}</strong>
      </div>
    </div>
  `;
}



/* =========================================================
   TRACKING REPORTS BOTTOM HORIZONTAL SCROLLBAR
   Keeps the horizontal scroll visible under the table body
   without covering the first row/header.
========================================================= */
let trackingReportsFloatingScrollState = {
  resizeObserver: null,
  isSyncing: false
};

function getTrackingReportsTableParts() {
  const tbody = document.getElementById("trackingReportsTableBody");
  const table = tbody ? tbody.closest("table") : null;
  const shell = table ? table.closest(".table-shell") : null;
  const modal = document.getElementById("trackingReportsModal");
  const body = modal ? modal.querySelector(".custom-modal-body") : null;

  return { tbody, table, shell, modal, body };
}

function isTrackingReportsTouchLayout() {
  return window.matchMedia?.("(max-width: 768px)")?.matches === true;
}

function applyTrackingReportsTouchScrollMode() {
  const { shell } = getTrackingReportsTableParts();
  const floatingScroll = document.getElementById("trackingReportsFloatingScroll");

  if (shell) {
    shell.classList.remove("has-custom-horizontal-scroll");
    shell.classList.add("tracking-reports-touch-scroll");
  }

  if (floatingScroll) {
    floatingScroll.remove();
  }
}

function destroyTrackingReportsFloatingScrollbar() {
  const floatingScroll = document.getElementById("trackingReportsFloatingScroll");
  const { shell } = getTrackingReportsTableParts();

  if (trackingReportsFloatingScrollState.resizeObserver) {
    try {
      trackingReportsFloatingScrollState.resizeObserver.disconnect();
    } catch (error) {
      // Keep UI safe if observer is already disconnected.
    }
  }

  trackingReportsFloatingScrollState = {
    resizeObserver: null,
    isSyncing: false
  };

  if (shell) {
    shell.classList.remove("has-custom-horizontal-scroll");
    shell.classList.remove("tracking-reports-touch-scroll");
  }

  if (floatingScroll) {
    floatingScroll.remove();
  }
}

function setupTrackingReportsFloatingScrollbar() {
  const { shell } = getTrackingReportsTableParts();

  /*
    Comfortable report modal rule:
    Use the table shell's native horizontal/vertical scroll instead of
    creating a second floating green scrollbar under the table. This keeps
    more vertical space available for report rows and feels more natural for users.
  */
  const floatingScroll = document.getElementById("trackingReportsFloatingScroll");

  if (trackingReportsFloatingScrollState.resizeObserver) {
    try {
      trackingReportsFloatingScrollState.resizeObserver.disconnect();
    } catch (error) {
      // Keep UI safe if observer is already disconnected.
    }
  }

  trackingReportsFloatingScrollState = {
    resizeObserver: null,
    isSyncing: false
  };

  if (floatingScroll) {
    floatingScroll.remove();
  }

  if (shell) {
    shell.classList.remove("has-custom-horizontal-scroll");
    shell.classList.add("tracking-reports-touch-scroll");
  }
}


let trackingReportsCache = [];
let trackingReportsFilterState = {
  search: "",
  status: "all",
  date: "all",
  route: "all"
};

function parseTrackingReportDateForFilter(value) {
  const raw = value === null || value === undefined ? "" : String(value).trim();
  if (!raw || raw.toLowerCase() === "null") return null;

  const mysqlMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (mysqlMatch) {
    const [, year, month, day, hour, minute, second = "00"] = mysqlMatch;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );

    return Number.isNaN(date.getTime()) ? null : date;
  }

  try {
    if (typeof parseTrackingDate === "function") {
      const parsed = parseTrackingDate(raw);
      if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
    }
  } catch (error) {
    // Fallback below.
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function getTrackingReportSearchText(report = {}) {
  const statusMeta = getTrackingReportStatusMeta(report);

  return [
    report.truck_id,
    report.truck_name,
    report.enforcer_name,
    report.device_id,
    report.session_status,
    report.status,
    report.report_status_label,
    statusMeta.label,
    statusMeta.gpsLabel,
    statusMeta.routeText,
    statusMeta.description
  ]
    .map(normalizeReportText)
    .join(" ")
    .toLowerCase();
}

function getTrackingReportStatusFilterKey(report = {}) {
  const statusMeta = getTrackingReportStatusMeta(report);
  const sessionStatus = normalizeReportText(report.session_status || report.status).toLowerCase();
  const label = normalizeReportText(statusMeta.label).toLowerCase();

  if (statusMeta.finalStatus === "gps_off" || label.includes("gps off")) {
    return "gps_off";
  }

  if (statusMeta.finalStatus === "sync_pending" || label.includes("sync pending")) {
    return "sync_pending";
  }

  if (!statusMeta.hasRoute || label.includes("no gps route") || label.includes("no route")) {
    return "no_route";
  }

  if (sessionStatus === "stopped" || label.includes("manually stopped") || label.startsWith("stopped")) {
    return "stopped";
  }

  if (sessionStatus === "auto_stopped" || label.includes("shift completed")) {
    return "completed";
  }

  return "all";
}

function isTrackingReportInsideDateFilter(report = {}, dateFilter = "all") {
  if (dateFilter === "all") return true;

  const date = parseTrackingReportDateForFilter(report.started_at || report.created_at || report.ended_at);
  if (!date) return false;

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

  if (dateFilter === "today") {
    return date >= startOfToday && date < startOfTomorrow;
  }

  if (dateFilter === "week") {
    const startOfWeek = new Date(startOfToday);
    const day = startOfWeek.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    startOfWeek.setDate(startOfWeek.getDate() + diffToMonday);

    const startOfNextWeek = new Date(startOfWeek);
    startOfNextWeek.setDate(startOfNextWeek.getDate() + 7);

    return date >= startOfWeek && date < startOfNextWeek;
  }

  if (dateFilter === "month") {
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
  }

  return true;
}

function getFilteredTrackingReports() {
  const safeReports = Array.isArray(trackingReportsCache) ? trackingReportsCache : [];
  const search = normalizeReportText(trackingReportsFilterState.search).toLowerCase();
  const statusFilter = trackingReportsFilterState.status || "all";
  const dateFilter = trackingReportsFilterState.date || "all";
  const routeFilter = trackingReportsFilterState.route || "all";

  return safeReports.filter((report) => {
    const statusMeta = getTrackingReportStatusMeta(report);

    if (search && !getTrackingReportSearchText(report).includes(search)) {
      return false;
    }

    if (statusFilter !== "all") {
      const key = getTrackingReportStatusFilterKey(report);

      if (statusFilter === "completed") {
        const sessionStatus = normalizeReportText(report.session_status || report.status).toLowerCase();
        if (sessionStatus !== "auto_stopped" && !normalizeReportText(statusMeta.label).toLowerCase().includes("shift completed")) {
          return false;
        }
      } else if (key !== statusFilter) {
        return false;
      }
    }

    if (!isTrackingReportInsideDateFilter(report, dateFilter)) {
      return false;
    }

    if (routeFilter === "with_route" && !statusMeta.hasRoute) {
      return false;
    }

    if (routeFilter === "no_route" && statusMeta.hasRoute) {
      return false;
    }

    return true;
  });
}

function setupTrackingReportsFilterToolbar() {
  const { tbody, shell, body } = getTrackingReportsTableParts();
  if (!tbody || !shell || !body) return;

  let toolbar = document.getElementById("trackingReportsFilterToolbar");

  if (!toolbar) {
    toolbar = document.createElement("div");
    toolbar.id = "trackingReportsFilterToolbar";
    toolbar.className = "tracking-reports-filter-toolbar";
    toolbar.innerHTML = `
      <div class="tracking-report-filter-field tracking-report-filter-search">
        <span>Search</span>
        <input
          id="trackingReportsSearchInput"
          type="search"
          placeholder="Truck, enforcer, or status..."
          autocomplete="off"
        />
      </div>

      <label class="tracking-report-filter-field">
        <span>Status</span>
        <select id="trackingReportsStatusFilter">
          <option value="all">All statuses</option>
          <option value="completed">Shift Completed</option>
          <option value="gps_off">GPS Off</option>
          <option value="sync_pending">Sync Pending</option>
          <option value="no_route">No GPS Route</option>
          <option value="stopped">Stopped</option>
        </select>
      </label>

      <label class="tracking-report-filter-field">
        <span>Date</span>
        <select id="trackingReportsDateFilter">
          <option value="all">All dates</option>
          <option value="today">Today</option>
          <option value="week">This week</option>
          <option value="month">This month</option>
        </select>
      </label>

      <label class="tracking-report-filter-field">
        <span>Route</span>
        <select id="trackingReportsRouteFilter">
          <option value="all">All routes</option>
          <option value="with_route">With route</option>
          <option value="no_route">No route</option>
        </select>
      </label>

      <button id="trackingReportsResetFilterBtn" type="button" class="tracking-report-filter-reset">
        Reset
      </button>

      <div id="trackingReportsFilterCount" class="tracking-report-filter-count">
        Showing 0 reports
      </div>
    `;

    shell.insertAdjacentElement("beforebegin", toolbar);
  }

  const searchInput = document.getElementById("trackingReportsSearchInput");
  const statusFilter = document.getElementById("trackingReportsStatusFilter");
  const dateFilter = document.getElementById("trackingReportsDateFilter");
  const routeFilter = document.getElementById("trackingReportsRouteFilter");
  const resetBtn = document.getElementById("trackingReportsResetFilterBtn");

  if (searchInput) searchInput.value = trackingReportsFilterState.search || "";
  if (statusFilter) statusFilter.value = trackingReportsFilterState.status || "all";
  if (dateFilter) dateFilter.value = trackingReportsFilterState.date || "all";
  if (routeFilter) routeFilter.value = trackingReportsFilterState.route || "all";

  if (!toolbar.dataset.bound) {
    const rerender = () => {
      trackingReportsFilterState = {
        search: searchInput ? searchInput.value : "",
        status: statusFilter ? statusFilter.value : "all",
        date: dateFilter ? dateFilter.value : "all",
        route: routeFilter ? routeFilter.value : "all"
      };

      renderTrackingReportsTable();
    };

    searchInput?.addEventListener("input", rerender);
    statusFilter?.addEventListener("change", rerender);
    dateFilter?.addEventListener("change", rerender);
    routeFilter?.addEventListener("change", rerender);

    resetBtn?.addEventListener("click", () => {
      trackingReportsFilterState = {
        search: "",
        status: "all",
        date: "all",
        route: "all"
      };

      if (searchInput) searchInput.value = "";
      if (statusFilter) statusFilter.value = "all";
      if (dateFilter) dateFilter.value = "all";
      if (routeFilter) routeFilter.value = "all";

      renderTrackingReportsTable();
    });

    toolbar.dataset.bound = "true";
  }
}

function updateTrackingReportsFilterCount(filteredCount, totalCount) {
  const countEl = document.getElementById("trackingReportsFilterCount");
  if (!countEl) return;

  if (totalCount <= 0) {
    countEl.textContent = "No reports loaded";
    return;
  }

  countEl.textContent = `Showing ${filteredCount} of ${totalCount} report${totalCount === 1 ? "" : "s"}`;
}

function renderTrackingReportsTable() {
  const tbody = document.getElementById("trackingReportsTableBody");
  if (!tbody) return;

  const totalReports = Array.isArray(trackingReportsCache) ? trackingReportsCache.length : 0;

  if (!totalReports) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-state">No tracking reports found.</td>
      </tr>
    `;
    updateTrackingReportsFilterCount(0, 0);
    destroyTrackingReportsFloatingScrollbar();
    return;
  }

  const filteredReports = getFilteredTrackingReports();
  updateTrackingReportsFilterCount(filteredReports.length, totalReports);

  if (!filteredReports.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-state">No reports match the current filters.</td>
      </tr>
    `;
    destroyTrackingReportsFloatingScrollbar();
    return;
  }

  tbody.innerHTML = filteredReports.map((r) => {
    const sessionId = r.id || r.session_id;
    const statusMeta = getTrackingReportStatusMeta(r);
    const routePointsText = statusMeta.routeText || (statusMeta.hasRoute ? "Route recorded" : "No route");

    return `
      <tr>
        <td>${escapeHtml(r.truck_id || "-")}</td>
        <td>${escapeHtml(r.enforcer_name || "-")}</td>
        <td>${formatTrackingReportDateTime(r.started_at)}</td>
        <td>${r.ended_at ? formatTrackingReportDateTime(r.ended_at) : "Still Active"}</td>
        <td>
          ${renderTrackingReportStatusBadge(r)}
          <div class="tracking-report-status-note">
            ${escapeHtml(statusMeta.gpsLabel)} • ${escapeHtml(routePointsText)}
          </div>
        </td>
        <td>${Number(r.session_distance_km || r.total_distance_km || 0).toFixed(2)} km</td>
        <td>
          <button type="button" class="view-all-btn small" onclick="viewTrackingReport('${escapeHtml(String(sessionId))}')">
            View
          </button>
        </td>
      </tr>
    `;
  }).join("");

  setTimeout(setupTrackingReportsFloatingScrollbar, 60);
}

async function loadTrackingReports() {
  const tbody = document.getElementById("trackingReportsTableBody");
  if (!tbody) return;

  tbody.innerHTML = `
    <tr>
      <td colspan="7" class="loading-state">Loading reports...</td>
    </tr>
  `;

  try {
    const res = await webAdminFetch(getTrackingReportsApiUrl(), {
      headers: {
        Accept: "application/json"
      }
    });

    const data = await res.json();

    if (!res.ok || data.success === false) {
      throw new Error(data.message || "Failed to load tracking reports.");
    }

    trackingReportsCache = Array.isArray(data)
      ? data
      : Array.isArray(data.data)
        ? data.data
        : [];

    setupTrackingReportsFilterToolbar();
    renderTrackingReportsTable();

  } catch (error) {
    console.error("loadTrackingReports error:", error);

    trackingReportsCache = [];
    updateTrackingReportsFilterCount(0, 0);

    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-state">Failed to load reports.</td>
      </tr>
    `;
    destroyTrackingReportsFloatingScrollbar();
  }
}

async function viewTrackingReport(sessionId) {
  if (!sessionId) return;

  try {
    const res = await webAdminFetch(getTrackingReportDetailsApiUrl(sessionId), {
      headers: {
        Accept: "application/json"
      }
    });

    const data = await res.json();

    if (!res.ok || data.success === false) {
      throw new Error(data.message || "Failed to load tracking report details.");
    }

    openTrackingReportModal(data.data || data);

  } catch (error) {
    console.error("viewTrackingReport error:", error);
    showToast?.("Failed to load tracking report details.", "error");
  }
}

let reportMap = null;

function openTrackingReportModal(data) {
  const modal = document.getElementById("trackingReportModal");
  const mapContainer = document.getElementById("trackingReportMap");

  if (!modal || !mapContainer) return;

  modal.classList.remove("hidden");

  setTimeout(() => {
    if (reportMap) {
      reportMap.remove();
      reportMap = null;
    }

    const logs = Array.isArray(data?.route_logs)
      ? data.route_logs
      : Array.isArray(data?.logs)
        ? data.logs
        : [];

    /*
      Route view modal rule:
      The View action should show the map only.
      Remove the old summary panel so the route map can use the full modal body.
    */
    const existingSummaryPanel = document.getElementById("trackingReportSummaryPanel");
    if (existingSummaryPanel) {
      existingSummaryPanel.remove();
    }

    mapContainer.innerHTML = "";

    if (!logs.length) {
      mapContainer.innerHTML = `
        <div class="empty-state tracking-report-map-empty">
          No route logs are available for this session.
        </div>
      `;
      return;
    }

    const latlngs = logs
      .map((p) => [parseFloat(p.latitude), parseFloat(p.longitude)])
      .filter(([lat, lng]) => !Number.isNaN(lat) && !Number.isNaN(lng));

    if (!latlngs.length) {
      mapContainer.innerHTML = `
        <div class="empty-state tracking-report-map-empty">
          No valid route coordinates available.
        </div>
      `;
      return;
    }

    reportMap = L.map("trackingReportMap").setView([6.1164, 125.1716], 13);

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
    }).addTo(reportMap);

    const startIcon = L.icon({
      iconUrl: "https://maps.google.com/mapfiles/ms/icons/green-dot.png",
      iconSize: [32, 32],
      iconAnchor: [16, 32]
    });

    const endIcon = L.icon({
      iconUrl: "https://maps.google.com/mapfiles/ms/icons/red-dot.png",
      iconSize: [32, 32],
      iconAnchor: [16, 32]
    });

    L.marker(latlngs[0], { icon: startIcon })
      .addTo(reportMap)
      .bindPopup("Start Point");

    L.marker(latlngs[latlngs.length - 1], { icon: endIcon })
      .addTo(reportMap)
      .bindPopup("End Point");

    L.polyline(latlngs, {
      color: "#0d6efd",
      weight: 5,
      opacity: 0.9
    }).addTo(reportMap);

    reportMap.fitBounds(latlngs, {
      padding: [24, 24]
    });

    setTimeout(() => {
      reportMap.invalidateSize();
    }, 150);

  }, 200);
}

function closeTrackingReportModal() {
  const modal = document.getElementById("trackingReportModal");

  if (modal) {
    modal.classList.add("hidden");
  }

  if (reportMap) {
    reportMap.remove();
    reportMap = null;
  }
}

function openTrackingReportsModal() {
  const modal = document.getElementById("trackingReportsModal");

  if (!modal) {
    alert("trackingReportsModal not found in HTML");
    return;
  }

  modal.classList.remove("hidden");
  loadTrackingReports();
}

function closeTrackingReportsModal() {
  const modal = document.getElementById("trackingReportsModal");

  if (modal) {
    modal.classList.add("hidden");
    destroyTrackingReportsFloatingScrollbar();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("resize", () => {
    const modal = document.getElementById("trackingReportsModal");
    if (!modal || modal.classList.contains("hidden")) return;

    window.clearTimeout(window.__trackingReportsScrollResizeTimer);
    window.__trackingReportsScrollResizeTimer = window.setTimeout(() => {
      setupTrackingReportsFloatingScrollbar();
    }, 120);
  });

  window.loadTrackingReports = loadTrackingReports;
  window.viewTrackingReport = viewTrackingReport;
  window.openTrackingReportsModal = openTrackingReportsModal;
  window.closeTrackingReportsModal = closeTrackingReportsModal;
  window.closeTrackingReportModal = closeTrackingReportModal;
  window.setupTrackingReportsFloatingScrollbar = setupTrackingReportsFloatingScrollbar;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    TRACKING_SYNC_PENDING_AFTER_MS,
    TRACKING_DEVICE_OFFLINE_AFTER_MS,
    TRACKING_GPS_AVAILABILITY_WINDOW_MS,
    TRACKING_MATCH_MAX_COORDINATES,
    TRACKING_ROUTE_GAP_MS,
    TRACKING_ACTUAL_ROUTE_COLOR,
    TRACKING_MARKER_ANIMATION_MS,
    buildTrackingDisplayRoute,
    buildTrackingMatchUrl,
    buildTrackingAvailabilitySnapshot,
    chunkTrackingMatchSegment,
    clearTrackingDispatchStartMarker,
    dedupeTrackingGeometryPoints,
    ensureTrackingDispatchStartMarker,
    filterAvailableTrackingTrucks,
    formatTrackingRelativeUpdate,
    formatTrackingTimeSafe,
    getCachedTrackingMatch,
    getTrackingAvailabilityMeta,
    getTrackingConnectivityMeta,
    getTrackingDisplayChannels,
    scheduleTrackingRealtimeRefresh,
    getTrackingTruckDispatchState,
    getTrackingTruckExistingTicket,
    isTrackingMatchResponseCurrent,
    isTrackingTruckAvailable,
    joinTrackingMatchedChunkGeometry,
    matchTrackingDisplaySegments,
    moveTrackingMarker,
    parseTrackingDate,
    parseTrackingMatchResponse,
    renderTrackingActualRoute,
    renderActiveTruckList,
    resolveTrackingStartMarkerAction,
    resolveTrackingMonitoredDispatch,
    splitTrackingDisplaySegments,
    trackingActualTrailLayerIsVisible,
    trackingBearingDegrees,
    trackingRouteSignature
  };
}
