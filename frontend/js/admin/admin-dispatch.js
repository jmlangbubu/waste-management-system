const DISPATCH_WMO_LOCATION = Object.freeze({
  latitude: 6.1060875,
  longitude: 125.1816406,
  radiusMeters: 100
});
const DISPATCH_DEFAULT_GEOFENCE_METERS = 100;
const DISPATCH_NEAR_DUPLICATE_METERS = 20;
const DISPATCH_LOCATION_CACHE_PRECISION = 5;
const DISPATCH_DESTINATION_SEARCH_DEBOUNCE_MS = 250;
const DISPATCH_DESTINATION_RESULT_LIMIT = 8;
const DISPATCH_POPULAR_DESTINATION_LIMIT = 4;
const DISPATCH_POPULAR_ROAD_LABELS = Object.freeze([
  "Pendatun Avenue",
  "Santiago Boulevard",
  "Pioneer Avenue",
  "Jose Catolico Avenue"
]);
const DISPATCH_ROUTING_DEBOUNCE_MS = 300;
const DISPATCH_ROUTING_MOVEMENT_METERS = 50;

let dispatchFocusedStopRow = null;
let dispatchLocationLookupController = null;
const dispatchLocationLabelCache = new Map();

function dispatchPoint(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function dispatchDistanceMeters(first, second) {
  if (!first || !second) return Number.POSITIVE_INFINITY;
  const radians = (degrees) => (Number(degrees) * Math.PI) / 180;
  const latitudeDelta = radians(second.lat - first.lat);
  const longitudeDelta = radians(second.lng - first.lng);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(first.lat)) * Math.cos(radians(second.lat)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function chooseDispatchSegmentOrientation(previousPoint, nextPoint, segment = []) {
  if (!Array.isArray(segment) || segment.length < 2) return [...(segment || [])];
  const first = dispatchPoint(segment[0].latitude ?? segment[0].lat, segment[0].longitude ?? segment[0].lng ?? segment[0].lon);
  const lastValue = segment[segment.length - 1];
  const last = dispatchPoint(lastValue.latitude ?? lastValue.lat, lastValue.longitude ?? lastValue.lng ?? lastValue.lon);
  const forwardScore = dispatchDistanceMeters(previousPoint, first) + dispatchDistanceMeters(last, nextPoint);
  const reverseScore = dispatchDistanceMeters(previousPoint, last) + dispatchDistanceMeters(first, nextPoint);
  return reverseScore < forwardScore ? [...segment].reverse() : [...segment];
}

function dispatchCatalogDestinationIsSelected(catalogId, metadata = dispatchStopMetadata) {
  if (catalogId === null || catalogId === undefined || catalogId === "") return false;
  return [...metadata.values()].some((item) => String(item.catalog_id) === String(catalogId));
}

function dispatchRoutingFailureState() {
  return {
    message: "Road route preview unavailable",
    preserveSelectedStops: true,
    drawStraightFallback: false
  };
}

function dispatchEscape(value) {
  if (typeof escapeHtml === "function") return escapeHtml(value ?? "");
  const element = document.createElement("div");
  element.textContent = value ?? "";
  return element.innerHTML;
}

function dispatchStatusLabel(status) {
  return String(status || "unknown")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function dispatchStatusClass(status) {
  return String(status || "unknown").replace(/_/g, "-");
}

function dispatchFormatDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return dispatchEscape(value);
  return date.toLocaleString("en-PH", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function dispatchFormatDuration(totalSeconds) {
  const seconds = Number(totalSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return "--";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function dispatchInputDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function dispatchActorPayload() {
  const user = currentUser || {};
  const rawId = user.id || user.user_id || user.web_user_id;
  const actorId = Number(rawId);
  return {
    actor_type: "web_user",
    actor_id: Number.isInteger(actorId) && actorId > 0 ? actorId : null,
    actor_name:
      user.full_name ||
      user.fullName ||
      user.name ||
      user.username ||
      "WMO administrator"
  };
}

function dispatchNotify(message, type = "success") {
  if (typeof showToast === "function") {
    showToast(message, type);
    return;
  }
  if (type === "error") console.error(message);
  else console.log(message);
}

function dispatchLocalInputDateTime(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function setDispatchWorkspaceTab(tabName) {
  const selectedTab = ["monitor", "plan", "records"].includes(tabName)
    ? tabName
    : "monitor";
  document.querySelectorAll("[data-tracking-workspace-view]").forEach((view) => {
    const isActive = view.dataset.trackingWorkspaceView === selectedTab;
    view.classList.toggle("active", isActive);
    view.hidden = !isActive;
  });
  if (selectedTab === "records") void loadDispatchRecords();
  if (truckMap) setTimeout(() => truckMap.invalidateSize(), 0);
}

function getDispatchSelectedReliablePoint() {
  if (
    selectedReliableRoutePoint &&
    String(selectedReliableRoutePoint.session_id || selectedSessionId) === String(selectedSessionId)
  ) {
    return selectedReliableRoutePoint;
  }
  if (!selectedTrackingTruck) return null;
  const point = {
    lat: typeof parseTrackingCoordinate === "function"
      ? parseTrackingCoordinate(selectedTrackingTruck.latitude)
      : Number(selectedTrackingTruck.latitude),
    lng: typeof parseTrackingCoordinate === "function"
      ? parseTrackingCoordinate(selectedTrackingTruck.longitude)
      : Number(selectedTrackingTruck.longitude),
    accuracy: selectedTrackingTruck.accuracy,
    recorded_at:
      selectedTrackingTruck.location_last_updated ||
      selectedTrackingTruck.last_updated_at,
    session_id: selectedTrackingTruck.session_id
  };
  const validCoordinates =
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    point.lng >= -180 &&
    point.lng <= 180 &&
    !(point.lat === 0 && point.lng === 0);
  const reliable =
    typeof isTrackingPointReliable !== "function" || isTrackingPointReliable(point);
  return validCoordinates && reliable ? point : null;
}

function updateDispatchSelectedTruckContext(truck = selectedTrackingTruck) {
  const summary = document.getElementById("dispatchSelectedTruckSummary");
  const dispatchNowButton = document.getElementById("dispatchNowBtn");
  const warning = document.getElementById("dispatchSessionWarning");
  const hint = document.getElementById("dispatchDestinationHint");

  if (!truck) {
    summary?.classList.add("is-empty");
    document.getElementById("dispatchSelectedTruckName").textContent = "Choose a truck";
    document.getElementById("dispatchSelectedTruckStatus").textContent = "Waiting";
    document.getElementById("dispatchSelectedTruckStatus").className = "tracking-live-chip";
    document.getElementById("dispatchSelectedTruckIdLabel").textContent = "--";
    document.getElementById("dispatchSelectedSessionLabel").textContent = "--";
    document.getElementById("dispatchSelectedPersonnelLabel").textContent = "--";
    document.getElementById("dispatchSelectedGpsStatusLabel").textContent = "--";
    document.getElementById("dispatchSelectedGpsLabel").textContent = "--";
    if (dispatchNowButton) dispatchNowButton.disabled = true;
    if (hint) hint.textContent = "Select a truck before planning destinations.";
    warning?.classList.add("hidden");
    return;
  }

  selectedTrackingTruck = truck;
  dispatchSelectedSessionActive =
    String(truck.session_status || "active").toLowerCase() === "active" &&
    activeTrackingTrucks.some(
      (activeTruck) => String(activeTruck.session_id) === String(truck.session_id)
    );
  const reliablePoint = getDispatchSelectedReliablePoint();
  const statusMeta = typeof getTrackingStatusMeta === "function"
    ? getTrackingStatusMeta(truck)
    : { label: dispatchSelectedSessionActive ? "Live" : "Ended" };
  const truckLabel = truck.truck_name || truck.truck_display_name || `Truck ${truck.truck_id}`;
  const personnelName = truck.enforcer_name || "Not assigned";

  summary?.classList.remove("is-empty");
  document.getElementById("dispatchSelectedTruckName").textContent = truckLabel;
  document.getElementById("dispatchSelectedTruckStatus").textContent = statusMeta.label;
  document.getElementById("dispatchSelectedTruckStatus").className =
    `tracking-live-chip ${statusMeta.className || ""}`;
  document.getElementById("dispatchSelectedTruckIdLabel").textContent = truck.truck_id || "--";
  document.getElementById("dispatchSelectedSessionLabel").textContent = `#${truck.session_id}`;
  document.getElementById("dispatchSelectedPersonnelLabel").textContent = personnelName;
  document.getElementById("dispatchSelectedGpsLabel").textContent = dispatchFormatDateTime(
    reliablePoint?.recorded_at || truck.location_last_updated || truck.last_updated_at
  );
  document.getElementById("dispatchSelectedGpsStatusLabel").textContent = reliablePoint
    ? "Reliable fix"
    : "Waiting for reliable GPS";

  document.getElementById("dispatchTrackingSessionId").value = truck.session_id || "";
  document.getElementById("dispatchTruckId").value = truck.truck_id || "";
  document.getElementById("dispatchTruckName").value = truckLabel;
  document.getElementById("dispatchPersonnelId").value = truck.enforcer_id || "";
  document.getElementById("dispatchPersonnelName").value = personnelName === "Not assigned" ? "" : personnelName;
  if (dispatchNowButton) dispatchNowButton.disabled = !dispatchSelectedSessionActive;
  if (warning) {
    warning.classList.toggle("hidden", dispatchSelectedSessionActive);
    warning.textContent = dispatchSelectedSessionActive
      ? ""
      : "The selected tracking session has ended. You can save this route as a draft, but Dispatch Now is disabled.";
  }
  if (hint) {
    hint.textContent = reliablePoint
      ? "Choose a verified road section or barangay hall from the catalog."
      : "The truck is selected, but the map is waiting for a reliable GPS point.";
  }
}

function prepareDispatchPlannerForTruck(truck) {
  if (!truck) return;
  const previousSessionId = document.getElementById("dispatchTrackingSessionId")?.value;
  const isNewSelection = String(previousSessionId || "") !== String(truck.session_id);
  if (isNewSelection) resetDispatchTicketForm();
  updateDispatchSelectedTruckContext(truck);
  setDispatchWorkspaceTab("plan");
  renderDispatchDraftOnLiveMap();
}

function handleDispatchSelectedSessionEnded() {
  dispatchSelectedSessionActive = false;
  updateDispatchSelectedTruckContext(selectedTrackingTruck);
}

async function dispatchRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch (error) {
    payload = {};
  }

  if (!response.ok) {
    if (payload.code === "DISPATCH_DESTINATION_CATALOG_SETUP_REQUIRED") {
      dispatchDestinationCatalogSetupRequired = true;
      updateDispatchDestinationCatalogNotice();
    } else if (payload.code === "DISPATCH_DATABASE_SETUP_REQUIRED") {
      dispatchSetupRequired = true;
      updateDispatchSetupNotices();
    }
    const requestError = new Error(
      payload.message || `Dispatch request failed (${response.status})`
    );
    requestError.status = response.status;
    requestError.code = payload.code;
    throw requestError;
  }

  if (url.includes("/dispatch/destinations")) {
    dispatchDestinationCatalogSetupRequired = false;
    updateDispatchDestinationCatalogNotice();
  } else {
    dispatchSetupRequired = false;
    updateDispatchSetupNotices();
  }
  return payload.data;
}

function updateDispatchDestinationCatalogNotice() {
  document
    .getElementById("dispatchDestinationCatalogNotice")
    ?.classList.toggle("hidden", !dispatchDestinationCatalogSetupRequired);
}

function updateDispatchSetupNotices() {
  [
    "dispatchTicketsSetupNotice",
    "dispatchReportsSetupNotice"
  ].forEach((id) => {
    document
      .getElementById(id)
      ?.classList.toggle("hidden", !dispatchSetupRequired);
  });
}

async function loadDispatchLiveData() {
  try {
    const data = await dispatchRequest(getDispatchLiveApiUrl());
    dispatchLiveBySession =
      data && typeof data === "object" && !Array.isArray(data) ? data : {};
    return dispatchLiveBySession;
  } catch (error) {
    dispatchLiveBySession = {};
    if (error.status !== 503) {
      console.error("Unable to load live dispatch data:", error);
    } else if (!selectedDispatchTicket) {
      renderDispatchEmptyPanel();
    }
    return dispatchLiveBySession;
  }
}

function getDispatchLiveForSession(sessionId) {
  return dispatchLiveBySession[String(sessionId)] || null;
}

function clearDispatchPlannedRoute() {
  clearTimeout(dispatchRoutingRequestTimer);
  dispatchRoutingGeneration += 1;
  if (dispatchPlannedLayerGroup && truckMap) {
    truckMap.removeLayer(dispatchPlannedLayerGroup);
  }
  dispatchPlannedLayerGroup = null;
}

function clearDispatchTrackingSelection() {
  selectedDispatchTicket = null;
  dispatchPendingLinkTicketId = null;
  dispatchSelectedSessionActive = false;
  setDispatchAddDestinationMode(false);
  clearDispatchPlannedRoute();
  resetDispatchTicketForm();
  updateDispatchSelectedTruckContext(null);
  renderDispatchEmptyPanel();
}

function renderDispatchEmptyPanel(message) {
  const panel = document.getElementById("dispatchCurrentPanel");
  if (!panel) return;
  const setupMessage = dispatchSetupRequired
    ? "Dispatch database setup is required."
    : message ||
      "Select an active truck or open a dispatch ticket to view its planned route and stop progress.";

  panel.innerHTML = `
    <div class="dispatch-panel-empty">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 4h14v16H5z"></path>
        <path d="M8 8h8M8 12h8M8 16h5"></path>
      </svg>
      <div>
        <strong>${dispatchSetupRequired ? "Dispatch setup required" : "No dispatch ticket selected"}</strong>
        <p>${dispatchEscape(setupMessage)}</p>
      </div>
    </div>
  `;
}

async function loadDispatchForTrackingSession(sessionId) {
  if (!sessionId) {
    clearDispatchTrackingSelection();
    return null;
  }

  const liveDispatch = getDispatchLiveForSession(sessionId);
  if (!liveDispatch) {
    const currentTicketMatchesTruck =
      selectedDispatchTicket?.ticket &&
      selectedTrackingTruck &&
      String(selectedDispatchTicket.ticket.truck_id) === String(selectedTrackingTruck.truck_id);
    if (currentTicketMatchesTruck) {
      renderDispatchTicketDetails(selectedDispatchTicket);
    } else {
      selectedDispatchTicket = null;
      renderDispatchEmptyPanel(
        "This tracking session has no linked ticket yet. Use the inline planner above to save a draft or dispatch it now."
      );
    }
    renderDispatchDraftOnLiveMap();
    return null;
  }

  try {
    const details = await dispatchRequest(
      getDispatchTrackingSessionApiUrl(sessionId)
    );
    selectedDispatchTicket = details;
    renderDispatchTicketDetails(details);
    renderDispatchPlannedRoute(details);
    return details;
  } catch (error) {
    if (error.status === 404) {
      selectedDispatchTicket = null;
      renderDispatchEmptyPanel(
        "This tracking session has no linked dispatch ticket yet."
      );
      renderDispatchDraftOnLiveMap();
      return null;
    }
    if (error.status !== 503) {
      console.error("Unable to load linked dispatch:", error);
    }
    renderDispatchEmptyPanel(error.message);
    return null;
  }
}

function dispatchMarkerIcon(label, className) {
  return L.divIcon({
    className: "",
    html: `<span class="dispatch-route-marker ${dispatchEscape(className)}">${dispatchEscape(label)}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13]
  });
}

function dispatchSegmentColor(stop, isCurrent) {
  if (!stop) return "#6c4bb8";
  if (stop.stop_status === "completed") return "#2e8b57";
  if (stop.stop_status === "skipped") return "#c44747";
  if (stop.stop_status === "arrived" || isCurrent) return "#e47d1b";
  if (stop.stop_status === "on_the_way") return "#2d73c7";
  return "#8a9690";
}

function updateDispatchRoutePreviewNotice(failed = false) {
  const notice = document.getElementById("dispatchRoutePreviewNotice");
  if (!notice) return;
  notice.classList.toggle("hidden", !failed);
  notice.innerHTML = failed
    ? `${dispatchEscape(dispatchRoutingFailureState().message)} <button type="button" data-dispatch-route-retry>Retry</button>`
    : "";
}

function dispatchRoutingCacheKey(start, end) {
  return [start.lat, start.lng, end.lat, end.lng]
    .map((value) => Number(value).toFixed(5))
    .join(":");
}

function requestDispatchRoadRoute(start, end) {
  const key = dispatchRoutingCacheKey(start, end);
  if (dispatchRoutingCache.has(key)) return Promise.resolve(dispatchRoutingCache.get(key));
  if (!window.L?.Routing?.osrmv1) {
    return Promise.reject(new Error("Leaflet Routing Machine is unavailable."));
  }
  return new Promise((resolve, reject) => {
    const router = L.Routing.osrmv1({
      serviceUrl: "https://router.project-osrm.org/route/v1",
      profile: "driving"
    });
    router.route(
      [L.latLng(start.lat, start.lng), L.latLng(end.lat, end.lng)],
      (error, routes) => {
        const coordinates = routes?.[0]?.coordinates;
        if (error || !Array.isArray(coordinates) || coordinates.length < 2) {
          reject(error || new Error("No drivable road route was returned."));
          return;
        }
        const route = coordinates
          .map((point) => [Number(point.lat), Number(point.lng)])
          .filter((point) => point.every(Number.isFinite));
        if (route.length < 2) {
          reject(new Error("The road route contained no usable coordinates."));
          return;
        }
        dispatchRoutingCache.set(key, route);
        resolve(route);
      },
      null,
      { alternatives: false }
    );
  });
}

function scheduleDispatchRoadConnectors(legs, layerGroup, generation, colorForLeg = null) {
  clearTimeout(dispatchRoutingRequestTimer);
  dispatchRoutingRequestTimer = setTimeout(async () => {
    let failed = false;
    for (const leg of legs) {
      try {
        const coordinates = await requestDispatchRoadRoute(leg.start, leg.end);
        if (generation !== dispatchRoutingGeneration || layerGroup !== dispatchPlannedLayerGroup) return;
        L.polyline(coordinates, {
          color: typeof colorForLeg === "function" ? colorForLeg(leg) : "#245c46",
          weight: 4,
          opacity: 0.8,
          dashArray: "8 7"
        })
          .bindTooltip("Road-following planned connection")
          .addTo(layerGroup);
      } catch (error) {
        console.warn("Dispatch road route preview unavailable:", error);
        failed = true;
      }
    }
    if (generation === dispatchRoutingGeneration) updateDispatchRoutePreviewNotice(failed);
  }, DISPATCH_ROUTING_DEBOUNCE_MS);
}

function renderDispatchPlannedRoute(details) {
  if (!truckMap || !window.L || !details || !Array.isArray(details.stops)) return;

  const stops = [...details.stops].sort(
    (a, b) => Number(a.stop_order) - Number(b.stop_order)
  );
  const wmoPoint = dispatchPoint(
    DISPATCH_WMO_LOCATION.latitude,
    DISPATCH_WMO_LOCATION.longitude
  );
  const reliableStart =
    selectedTrackingTruck &&
    String(selectedTrackingTruck.truck_id) === String(details.ticket?.truck_id)
      ? getDispatchSelectedReliablePoint()
      : null;
  const routeStartPoint = reliableStart
    ? dispatchPoint(reliableStart.lat, reliableStart.lng)
    : wmoPoint;
  const routePoints = [
    { point: routeStartPoint, stop: null },
    ...stops.map((stop) => ({
      point: dispatchPoint(stop.latitude, stop.longitude),
      stop
    })),
    { point: wmoPoint, stop: null, isWmoReturn: true }
  ].filter(({ point }) => point);
  const signature = `ticket:${details.ticket?.id || "unknown"}:${routePoints.slice(1)
    .map(({ point, stop }) => `${point.lat.toFixed(5)},${point.lng.toFixed(5)},${stop?.stop_status || ""}`)
    .join("|")}`;
  if (
    dispatchPlannedLayerGroup &&
    signature === dispatchLastRoutingSignature &&
    dispatchDistanceMeters(routeStartPoint, dispatchLastRoutingStart) < DISPATCH_ROUTING_MOVEMENT_METERS
  ) return;

  clearDispatchPlannedRoute();
  dispatchLastRoutingSignature = signature;
  dispatchLastRoutingStart = routeStartPoint;
  dispatchPlannedLayerGroup = L.layerGroup().addTo(truckMap);
  const layerGroup = dispatchPlannedLayerGroup;
  const generation = dispatchRoutingGeneration;

  const currentStop = stops.find(
    (stop) => !["completed", "skipped"].includes(stop.stop_status)
  );

  L.marker([wmoPoint.lat, wmoPoint.lng], {
    icon: dispatchMarkerIcon("W", "wmo")
  })
    .bindTooltip("Required WMO return point")
    .addTo(layerGroup);
  routePoints.filter(({ stop }) => stop).forEach((routePoint) => {
    const stop = routePoint.stop;
    const isCurrent = currentStop && Number(currentStop.id) === Number(stop.id);
    const markerClass =
      stop.stop_status === "completed"
        ? "completed"
        : stop.stop_status === "skipped"
          ? "skipped"
          : stop.stop_status === "arrived"
            ? "current"
            : isCurrent
              ? "current"
            : "";
    L.marker([routePoint.point.lat, routePoint.point.lng], {
      icon: dispatchMarkerIcon(stop.stop_order, markerClass)
    })
      .bindTooltip(
        `${dispatchEscape(stop.location_name)} · ${dispatchEscape(dispatchStatusLabel(stop.stop_status))}`
      )
      .addTo(layerGroup);
  });

  const legs = routePoints.slice(0, -1).map((routePoint, index) => ({
    start: routePoint.point,
    end: routePoints[index + 1].point,
    destinationStop: routePoints[index + 1].stop
  }));
  scheduleDispatchRoadConnectors(legs, layerGroup, generation, (leg) => {
    const isCurrent =
      leg.destinationStop &&
      currentStop &&
      Number(leg.destinationStop.id) === Number(currentStop.id);
    return dispatchSegmentColor(leg.destinationStop, isCurrent);
  });
}

function dispatchEventLabel(eventType) {
  const labels = {
    dispatch_prepared: "Dispatch prepared",
    ticket_issued: "Ticket issued",
    tracking_started: "Tracking started",
    arrived_at_stop: "Arrived at stop",
    departed_stop: "Departed stop",
    stop_completed: "Stop completed",
    stop_skipped: "Stop skipped",
    returning_to_wmo: "Returning to WMO",
    returned_to_wmo: "Returned to WMO",
    dispatch_completed: "Dispatch completed",
    ticket_cancelled: "Ticket cancelled"
  };
  return labels[eventType] || dispatchStatusLabel(eventType);
}

function renderDispatchTicketDetails(details) {
  const panel = document.getElementById("dispatchCurrentPanel");
  if (!panel || !details || !details.ticket) return;

  const ticket = details.ticket;
  const stops = Array.isArray(details.stops) ? details.stops : [];
  const events = Array.isArray(details.events) ? details.events : [];
  const linkedSessions = Array.isArray(details.tracking_sessions)
    ? details.tracking_sessions
    : [];
  const completedStops = stops.filter(
    (stop) => stop.stop_status === "completed"
  ).length;
  const terminalStops = stops.filter((stop) =>
    ["completed", "skipped"].includes(stop.stop_status)
  ).length;
  const canEdit = ticket.status === "prepared";
  const canIssue = ticket.status === "prepared";
  const canLink = ["dispatched", "in_progress"].includes(ticket.status);
  const canReturn = ["dispatched", "in_progress"].includes(ticket.status);
  const canCancel = !["completed", "cancelled"].includes(ticket.status);

  const ticketActions = [
    canEdit
      ? `<button type="button" class="dispatch-action-button" data-dispatch-action="edit" data-ticket-id="${ticket.id}">Edit prepared ticket</button>`
      : "",
    canIssue
      ? `<button type="button" class="dispatch-action-button" data-dispatch-action="issue" data-ticket-id="${ticket.id}">Issue ticket</button>`
      : "",
    canLink && selectedTrackingTruck && String(selectedTrackingTruck.truck_id) === String(ticket.truck_id)
      ? `<button type="button" class="dispatch-action-button" data-dispatch-action="link-selected" data-ticket-id="${ticket.id}">Link selected session</button>`
      : "",
    canReturn
      ? `<button type="button" class="dispatch-action-button" data-dispatch-action="returning" data-ticket-id="${ticket.id}">Returning to WMO</button>`
      : "",
    canCancel
      ? `<button type="button" class="dispatch-action-button danger" data-dispatch-action="cancel" data-ticket-id="${ticket.id}">Cancel ticket</button>`
      : ""
  ].join("");

  const stopCards = stops
    .map((stop) => {
      const terminal = ["completed", "skipped"].includes(stop.stop_status);
      const actions = terminal
        ? ""
        : `
          <div class="dispatch-stop-actions">
            ${stop.stop_status !== "arrived" ? `<button type="button" class="dispatch-action-button" data-dispatch-action="arrive" data-ticket-id="${ticket.id}" data-stop-id="${stop.id}">Mark arrived</button>` : ""}
            <button type="button" class="dispatch-action-button" data-dispatch-action="complete" data-ticket-id="${ticket.id}" data-stop-id="${stop.id}">Complete</button>
            <button type="button" class="dispatch-action-button danger" data-dispatch-action="skip" data-ticket-id="${ticket.id}" data-stop-id="${stop.id}">Skip</button>
          </div>
        `;

      return `
        <article class="dispatch-stop-card">
          <span class="dispatch-stop-order">${dispatchEscape(stop.stop_order)}</span>
          <div class="dispatch-stop-main">
            <strong>${dispatchEscape(stop.location_name)}</strong>
            <small>${dispatchEscape(stop.address_reference || "No address reference")}</small>
            <small>${dispatchEscape(stop.latitude)}, ${dispatchEscape(stop.longitude)} · ${dispatchEscape(stop.geofence_radius_meters)} m geofence</small>
            <span class="dispatch-stop-status ${dispatchStatusClass(stop.stop_status)}">${dispatchEscape(dispatchStatusLabel(stop.stop_status))}</span>
            ${actions}
          </div>
        </article>
      `;
    })
    .join("");

  const timeline = events.length
    ? events
        .map(
          (event) => `
            <div class="dispatch-event-item">
              <i></i>
              <div>
                <strong>${dispatchEscape(dispatchEventLabel(event.event_type))}</strong>
                <small>${dispatchEscape(dispatchFormatDateTime(event.event_at))} · ${dispatchEscape(event.event_source || "system")}${event.actor_name ? ` · ${dispatchEscape(event.actor_name)}` : ""}</small>
              </div>
            </div>
          `
        )
        .join("")
    : `<div class="dispatch-panel-empty"><div><strong>No dispatch events yet</strong></div></div>`;

  const warnings = Array.isArray(details.warnings)
    ? details.warnings
        .map((warning) => `<div class="dispatch-warning">${dispatchEscape(warning)}</div>`)
        .join("")
    : "";

  panel.innerHTML = `
    <div class="dispatch-current-header">
      <div class="dispatch-ticket-heading">
        <span class="dispatch-ticket-number">${dispatchEscape(ticket.ticket_number)}</span>
        <h3>${dispatchEscape(ticket.route_name)}</h3>
        <p>${dispatchEscape(ticket.truck_name_snapshot)} · ${dispatchEscape(ticket.assigned_personnel_name || "No personnel assigned")} · ${dispatchEscape(ticket.dispatch_date)}</p>
        <div class="dispatch-ticket-actions">${ticketActions}</div>
      </div>
      <span class="dispatch-status-chip ${dispatchStatusClass(ticket.status)}">${dispatchEscape(dispatchStatusLabel(ticket.status))}</span>
    </div>
    ${warnings}
    <div class="dispatch-current-body">
      <div class="dispatch-progress-card">
        <div class="dispatch-progress-summary">
          <div><span>Route stops</span><strong>${stops.length}</strong></div>
          <div><span>Completed</span><strong>${completedStops}</strong></div>
          <div><span>Progress</span><strong>${terminalStops}/${stops.length}</strong></div>
        </div>
        <div class="dispatch-stop-list">${stopCards || "<p>No route stops available.</p>"}</div>
      </div>
      <div class="dispatch-timeline-card">
        <div class="dispatch-progress-summary">
          <div><span>Tracking links</span><strong>${linkedSessions.length}</strong></div>
          <div><span>Started</span><strong>${dispatchEscape(dispatchFormatDateTime(ticket.actual_start_at))}</strong></div>
          <div><span>Expected return</span><strong>${dispatchEscape(dispatchFormatDateTime(ticket.expected_return_at))}</strong></div>
        </div>
        <div class="dispatch-event-list">${timeline}</div>
      </div>
    </div>
  `;
}

function openDispatchModal(modalId) {
  document.getElementById(modalId)?.classList.remove("hidden");
}

function closeDispatchModal(modalId) {
  document.getElementById(modalId)?.classList.add("hidden");
}

function dispatchStopRowTemplate(stop = {}, index = 0) {
  const barangay = stop.barangay || "";
  const destinationType = stop.destination_type || "custom";
  const metadataKey = stop.metadata_key || `dispatch-stop-${++dispatchStopMetadataSequence}`;
  dispatchStopMetadata.set(metadataKey, {
    catalog_id: stop.catalog_id || null,
    destination_type: destinationType,
    is_verified: Boolean(stop.is_verified),
    geometry_segments: Array.isArray(stop.geometry_segments)
      ? stop.geometry_segments
      : []
  });
  return `
    <article class="dispatch-stop-row" data-dispatch-stop-row data-dispatch-metadata-key="${dispatchEscape(metadataKey)}">
      <div class="dispatch-stop-row-header">
        <strong>Stop <span data-dispatch-stop-number>${index + 1}</span></strong>
        <div class="dispatch-stop-row-actions">
          <button type="button" data-dispatch-stop-move="up" aria-label="Move stop up" title="Move up"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg></button>
          <button type="button" data-dispatch-stop-move="down" aria-label="Move stop down" title="Move down"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
          <button type="button" data-dispatch-stop-remove aria-label="Remove stop" title="Remove"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M8 7l1 13h6l1-13"/></svg></button>
        </div>
      </div>
      <div class="dispatch-stop-fields">
        <input type="hidden" data-dispatch-field="stop_order" value="${dispatchEscape(stop.stop_order || index + 1)}">
        <div class="dispatch-stop-summary dispatch-stop-location-field">
          <strong>${dispatchEscape(stop.operator_label || stop.name || stop.location_name || "Destination")}${stop.is_verified ? ' <span class="dispatch-stop-verified">Verified</span>' : ""}</strong>
          <small>${dispatchEscape(dispatchDestinationTypeLabel(destinationType))}${barangay ? ` · ${dispatchEscape(barangay)}` : ""}</small>
        </div>
        <details class="dispatch-stop-advanced">
          <summary>Advanced stop options</summary>
          <div class="dispatch-stop-advanced-fields">
            <label class="dispatch-stop-field dispatch-stop-radius-field">
              Geofence radius
              <div class="dispatch-input-suffix"><input type="number" min="25" max="5000" data-dispatch-field="geofence_radius_meters" value="${dispatchEscape(stop.geofence_radius_meters || DISPATCH_DEFAULT_GEOFENCE_METERS)}" required><span>m</span></div>
            </label>
            <label class="dispatch-stop-field">
              Expected arrival <small>Optional</small>
              <input type="datetime-local" data-dispatch-field="expected_arrival_at" value="${dispatchEscape(dispatchInputDateTime(stop.expected_arrival_at))}">
            </label>
          </div>
        </details>
        <input type="hidden" data-dispatch-field="location_name" value="${dispatchEscape(stop.location_name || "")}">
        <input type="hidden" data-dispatch-field="destination_type" value="${dispatchEscape(destinationType)}">
        <input type="hidden" data-dispatch-field="barangay" value="${dispatchEscape(barangay)}">
        <input type="hidden" data-dispatch-field="latitude" value="${dispatchEscape(stop.latitude ?? "")}">
        <input type="hidden" data-dispatch-field="longitude" value="${dispatchEscape(stop.longitude ?? "")}">
        <input type="hidden" data-dispatch-field="address_reference" value="${dispatchEscape(stop.address_reference || "")}">
      </div>
    </article>
  `;
}

function addDispatchStopRow(stop = {}) {
  const container = document.getElementById("dispatchStopRows");
  if (!container) return;
  container.querySelector(".dispatch-route-empty")?.remove();
  const index = container.querySelectorAll("[data-dispatch-stop-row]").length;
  container.insertAdjacentHTML("beforeend", dispatchStopRowTemplate(stop, index));
  renumberDispatchStopRows(false);
  const row = container.lastElementChild;
  dispatchFocusedStopRow = row;
  renderDispatchDraftOnLiveMap();
  return row;
}

function renumberDispatchStopRows(rewriteOrders = true) {
  const rows = [
    ...document.querySelectorAll("#dispatchStopRows [data-dispatch-stop-row]")
  ];
  rows.forEach((row, index) => {
    const number = row.querySelector("[data-dispatch-stop-number]");
    if (number) number.textContent = String(index + 1);
    if (rewriteOrders) {
      const order = row.querySelector('[data-dispatch-field="stop_order"]');
      if (order) order.value = String(index + 1);
    }
  });
}

function getDispatchStopDrafts() {
  return [
    ...document.querySelectorAll("#dispatchStopRows [data-dispatch-stop-row]")
  ].map((row) => {
    const value = (field) =>
      row.querySelector(`[data-dispatch-field="${field}"]`)?.value || "";
    const numericValue = (field) => {
      const rawValue = value(field);
      return rawValue === "" ? Number.NaN : Number(rawValue);
    };
    return {
      metadata_key: row.dataset.dispatchMetadataKey || "",
      stop_order: numericValue("stop_order"),
      location_name: value("location_name").trim(),
      barangay: value("barangay").trim() || null,
      address_reference:
        value("address_reference").trim() ||
        (value("barangay").trim()
          ? `Barangay ${value("barangay").trim()}, General Santos City`
          : null),
      latitude: numericValue("latitude"),
      longitude: numericValue("longitude"),
      geofence_radius_meters: numericValue("geofence_radius_meters"),
      expected_arrival_at: value("expected_arrival_at") || null
    };
  });
}

function renderDispatchDraftOnLiveMap() {
  if (!truckMap || !window.L) return;
  const stops = getDispatchStopDrafts().filter(
    (stop) => Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude)
  );
  if (!stops.length) {
    clearDispatchPlannedRoute();
    dispatchLastRoutingSignature = "";
    dispatchLastRoutingStart = null;
    updateDispatchRoutePreviewNotice(false);
    return;
  }
  const reliableStart = getDispatchSelectedReliablePoint();
  const wmo = dispatchPoint(DISPATCH_WMO_LOCATION.latitude, DISPATCH_WMO_LOCATION.longitude);
  const startPoint = reliableStart
    ? dispatchPoint(reliableStart.lat, reliableStart.lng)
    : wmo;
  let previousPoint = startPoint;
  const plannedStops = stops.map((stop, index) => {
    const metadata = dispatchStopMetadata.get(stop.metadata_key);
    const geometrySegments = Array.isArray(metadata?.geometry_segments)
      ? metadata.geometry_segments
      : [];
    const nextStop = stops[index + 1];
    const nextPoint = nextStop
      ? dispatchPoint(nextStop.latitude, nextStop.longitude)
      : wmo;
    const sourceGeometry = geometrySegments.length ? geometrySegments[0] : [];
    const orientedGeometry = chooseDispatchSegmentOrientation(previousPoint, nextPoint, sourceGeometry)
      .map((point) => dispatchPoint(point.latitude, point.longitude))
      .filter(Boolean);
    const entryPoint = orientedGeometry[0] || dispatchPoint(stop.latitude, stop.longitude);
    const exitPoint = orientedGeometry[orientedGeometry.length - 1] || entryPoint;
    const planned = {
      stop,
      metadata,
      geometry: orientedGeometry,
      connector: { start: previousPoint, end: entryPoint }
    };
    previousPoint = exitPoint;
    return planned;
  });
  const connectorLegs = [
    ...plannedStops.map(({ connector }) => connector),
    { start: previousPoint, end: wmo }
  ];
  const signature = `draft:${plannedStops.map(({ stop, metadata, geometry }) =>
    `${stop.stop_order}:${metadata?.catalog_id || "custom"}:${stop.latitude.toFixed(5)},${stop.longitude.toFixed(5)}:${geometry
      .map((point) => `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`)
      .join(";")}`
  ).join("|")}`;
  if (
    dispatchPlannedLayerGroup &&
    signature === dispatchLastRoutingSignature &&
    dispatchDistanceMeters(startPoint, dispatchLastRoutingStart) < DISPATCH_ROUTING_MOVEMENT_METERS
  ) return;

  clearDispatchPlannedRoute();
  dispatchLastRoutingSignature = signature;
  dispatchLastRoutingStart = startPoint;
  dispatchPlannedLayerGroup = L.layerGroup().addTo(truckMap);
  const layerGroup = dispatchPlannedLayerGroup;
  const generation = dispatchRoutingGeneration;
  L.marker([wmo.lat, wmo.lng], {
    icon: dispatchMarkerIcon("W", "wmo")
  })
    .bindTooltip("Required WMO return point")
    .addTo(layerGroup);

  plannedStops.forEach(({ stop, geometry }) => {
    if (geometry.length > 1) {
      L.polyline(geometry.map((point) => [point.lat, point.lng]), {
        color: "#2d7d52",
        weight: 6,
        opacity: 0.48
      })
        .bindTooltip(`${stop.location_name || `Stop ${stop.stop_order}`} · verified OSM geometry`)
        .addTo(layerGroup);
    }
    L.marker([stop.latitude, stop.longitude], {
      icon: dispatchMarkerIcon(stop.stop_order, "")
    })
      .bindTooltip(stop.location_name || `Stop ${stop.stop_order}`)
      .addTo(layerGroup);
  });
  updateDispatchRoutePreviewNotice(false);
  scheduleDispatchRoadConnectors(connectorLegs, layerGroup, generation);
}

function renderDispatchPlanningMap() {
  renderDispatchDraftOnLiveMap();
}

function setDispatchAddDestinationMode(enabled) {
  dispatchAddDestinationMode = Boolean(enabled);
  const button = document.getElementById("dispatchAddStopBtn");
  const instruction = document.getElementById("dispatchMapInstruction");
  const mapWrap = document.querySelector(".tracking-map-wrap");
  if (button) {
    button.classList.toggle("active", dispatchAddDestinationMode);
    button.setAttribute("aria-pressed", String(dispatchAddDestinationMode));
    const label = button.querySelector("[data-dispatch-add-label]");
    if (label) {
      label.textContent = dispatchAddDestinationMode
        ? "Cancel Map Selection"
        : "Add Unlisted Location";
    }
  }
  instruction?.classList.toggle("hidden", !dispatchAddDestinationMode);
  mapWrap?.classList.toggle("dispatch-add-destination-mode", dispatchAddDestinationMode);
}

function dispatchCoordinatesAreNearlyDuplicate(latitude, longitude) {
  const candidate = { lat: Number(latitude), lng: Number(longitude) };
  return getDispatchStopDrafts().some((stop) => {
    const existing = { lat: stop.latitude, lng: stop.longitude };
    return trackingHaversineMeters(existing, candidate) <= DISPATCH_NEAR_DUPLICATE_METERS;
  });
}

function dispatchNormalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function clearDispatchDestinationPreview() {
  dispatchDestinationPreview = null;
  if (dispatchPreviewMarker && truckMap) truckMap.removeLayer(dispatchPreviewMarker);
  if (dispatchPreviewGeometryLayer && truckMap) {
    truckMap.removeLayer(dispatchPreviewGeometryLayer);
  }
  dispatchPreviewMarker = null;
  dispatchPreviewGeometryLayer = null;
  document.getElementById("dispatchDestinationPreview")?.classList.add("hidden");
  document.getElementById("dispatchCustomLabelField")?.classList.add("hidden");
  const confirmButton = document.getElementById("dispatchConfirmDestinationBtn");
  if (confirmButton) confirmButton.disabled = true;
  const labelInput = document.getElementById("dispatchPreviewLabel");
  if (labelInput) labelInput.value = "";
}

function dispatchDestinationTypeLabel(type) {
  if (type === "road_segment" || type === "road") return "Road Section";
  if (type === "barangay_hall") return "Barangay Hall";
  return "Custom map point";
}

function dispatchGeometrySegments(points = []) {
  const segments = [];
  let current = [];
  for (const point of points) {
    if (!point || point.point_type === "anchor") continue;
    if (point.point_type === "entry" && current.length) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push(point);
    if (point.point_type === "exit") {
      if (current.length > 1) segments.push(current);
      current = [];
    }
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

function updateDispatchDestinationPreview(location, options = {}) {
  if (!location || !selectedTrackingTruck) return false;
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (dispatchCoordinatesAreNearlyDuplicate(latitude, longitude)) {
    dispatchNotify(
      `This destination is within ${DISPATCH_NEAR_DUPLICATE_METERS} meters of an existing stop. Choose a distinct location.`,
      "error"
    );
    return false;
  }

  const geometrySegments = Array.isArray(location.geometry_segments)
    ? location.geometry_segments
        .map((segment) => segment
          .map((point) => [Number(point.latitude), Number(point.longitude)])
          .filter((point) => point.every(Number.isFinite)))
        .filter((segment) => segment.length > 1)
    : [];
  const isCustom = location.destination_type === "custom";
  dispatchDestinationPreview = {
    catalog_id: location.catalog_id || null,
    destination_type: location.destination_type || "custom",
    name: location.name || location.location_name || "Selected location",
    location_name:
      location.display_label || location.location_name || location.name || "Selected location",
    barangay: location.barangay || "",
    address_reference:
      location.address_reference ||
      `${dispatchDestinationTypeLabel(location.destination_type)} · ${location.barangay || "General Santos City"}`,
    latitude,
    longitude,
    geometry_segments: location.geometry_segments || [],
    is_verified: Boolean(location.is_verified),
    has_geometry: geometrySegments.length > 0,
    is_custom: isCustom,
    geofence_radius_meters: DISPATCH_DEFAULT_GEOFENCE_METERS
  };

  if (dispatchPreviewMarker && truckMap) truckMap.removeLayer(dispatchPreviewMarker);
  if (dispatchPreviewGeometryLayer && truckMap) {
    truckMap.removeLayer(dispatchPreviewGeometryLayer);
  }
  if (truckMap && window.L) {
    if (geometrySegments.length) {
      dispatchPreviewGeometryLayer = L.featureGroup();
      geometrySegments.forEach((geometry) => {
        L.polyline(geometry, {
          color: "#22784a",
          weight: 6,
          opacity: 0.45
        })
          .bindTooltip(dispatchDestinationPreview.name)
          .addTo(dispatchPreviewGeometryLayer);
      });
      dispatchPreviewGeometryLayer.addTo(truckMap);
    }
    dispatchPreviewMarker = L.marker([latitude, longitude], {
      icon: dispatchMarkerIcon("+", "preview")
    })
      .bindTooltip(dispatchDestinationPreview.name)
      .addTo(truckMap);
    if (options.flyTo !== false) {
      if (geometrySegments.length && typeof truckMap.fitBounds === "function") {
        truckMap.fitBounds(dispatchPreviewGeometryLayer.getBounds(), {
          padding: [28, 28],
          maxZoom: 17
        });
      } else if (typeof truckMap.flyTo === "function") {
        truckMap.flyTo([latitude, longitude], Math.max(truckMap.getZoom?.() || 15, 16));
      }
    }
  }

  document.getElementById("dispatchDestinationPreview")?.classList.remove("hidden");
  document.getElementById("dispatchPreviewName").textContent = dispatchDestinationPreview.name;
  const previewMeta = document.getElementById("dispatchPreviewMeta");
  if (previewMeta) {
    const geometryNote =
      ["road_segment", "road"].includes(dispatchDestinationPreview.destination_type) && !geometrySegments.length
        ? " · Approximate verified road point"
        : geometrySegments.length
          ? " · Stored road geometry"
          : "";
    previewMeta.textContent =
      `${dispatchDestinationTypeLabel(dispatchDestinationPreview.destination_type)} · ${dispatchDestinationPreview.barangay || "General Santos City"}${geometryNote}`;
  }
  const labelInput = document.getElementById("dispatchPreviewLabel");
  if (labelInput) labelInput.value = dispatchDestinationPreview.location_name;
  document
    .getElementById("dispatchCustomLabelField")
    ?.classList.toggle("hidden", !isCustom);
  document.getElementById("dispatchConfirmDestinationBtn").disabled = isCustom;
  if (isCustom) labelInput?.focus();
  return true;
}

async function resolveDispatchPreviewBarangay(latitude, longitude) {
  const cacheKey = `${Number(latitude).toFixed(DISPATCH_LOCATION_CACHE_PRECISION)},${Number(longitude).toFixed(DISPATCH_LOCATION_CACHE_PRECISION)}`;
  let result = dispatchLocationLabelCache.get(cacheKey);
  if (!result) {
    dispatchLocationLookupController?.abort();
    dispatchLocationLookupController = new AbortController();
    try {
      const response = await fetch(
        getDispatchLocationLabelApiUrl(latitude, longitude),
        { signal: dispatchLocationLookupController.signal }
      );
      if (!response.ok) throw new Error(`Location lookup failed (${response.status})`);
      result = await response.json();
      dispatchLocationLabelCache.set(cacheKey, result);
    } catch (error) {
      if (error.name === "AbortError") return;
      const previewMeta = document.getElementById("dispatchPreviewMeta");
      if (previewMeta) previewMeta.textContent = "Custom map point · Barangay unavailable";
      return;
    }
  }

  if (
    !dispatchDestinationPreview ||
    Number(dispatchDestinationPreview.latitude).toFixed(5) !== Number(latitude).toFixed(5) ||
    Number(dispatchDestinationPreview.longitude).toFixed(5) !== Number(longitude).toFixed(5)
  ) return;
  const barangay = String(result?.assigned_barangay || "").trim();
  if (barangay && barangay !== "For Verification") {
    dispatchDestinationPreview.barangay = barangay;
    dispatchDestinationPreview.address_reference = `Selected Location, ${barangay}, General Santos City`;
    const labelInput = document.getElementById("dispatchPreviewLabel");
    if (labelInput && /^Selected Location(?:,|$)/i.test(labelInput.value.trim())) {
      labelInput.value = `Selected Location, ${barangay}`;
      dispatchDestinationPreview.location_name = labelInput.value;
    }
    document.getElementById("dispatchPreviewMeta").textContent =
      `Custom map point · ${barangay}`;
  } else {
    document.getElementById("dispatchPreviewMeta").textContent =
      "Custom map point · Barangay requires verification";
  }
}

function handleDispatchLiveMapClick(event) {
  if (!dispatchAddDestinationMode) return;
  if (!selectedTrackingTruck) {
    dispatchNotify("Select an active truck before adding destinations.", "error");
    return;
  }
  const latitude = Number(event?.latlng?.lat);
  const longitude = Number(event?.latlng?.lng);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    dispatchNotify("The selected map coordinates are invalid.", "error");
    return;
  }
  if (dispatchCoordinatesAreNearlyDuplicate(latitude, longitude)) {
    dispatchNotify(
      `This destination is within ${DISPATCH_NEAR_DUPLICATE_METERS} meters of an existing stop. Choose a distinct location.`,
      "error"
    );
    return;
  }

  const previewSet = updateDispatchDestinationPreview({
    location_name: "Selected Location",
    destination_type: "custom",
    address_reference: "Custom map point, General Santos City",
    barangay: "",
    latitude,
    longitude
  }, { flyTo: false });
  if (previewSet) void resolveDispatchPreviewBarangay(latitude, longitude);
}

function confirmDispatchDestinationPreview() {
  if (!selectedTrackingTruck || !dispatchDestinationPreview) return;
  const labelInput = document.getElementById("dispatchPreviewLabel");
  const locationName = labelInput?.value.trim();
  if (!locationName) {
    dispatchNotify("Enter a destination label before adding this stop.", "error");
    labelInput?.focus();
    return;
  }
  if (
    dispatchCoordinatesAreNearlyDuplicate(
      dispatchDestinationPreview.latitude,
      dispatchDestinationPreview.longitude
    )
  ) {
    dispatchNotify(
      `This destination is within ${DISPATCH_NEAR_DUPLICATE_METERS} meters of an existing stop.`,
      "error"
    );
    return;
  }

  const stopNumber = getDispatchStopDrafts().length + 1;
  addDispatchStopRow({
    ...dispatchDestinationPreview,
    stop_order: stopNumber,
    location_name: locationName,
    operator_label: dispatchDestinationPreview.name,
    address_reference: dispatchDestinationPreview.address_reference || locationName
  });
  clearDispatchDestinationPreview();
  setDispatchAddDestinationMode(false);
  const searchInput = document.getElementById("dispatchDestinationSearch");
  if (searchInput) searchInput.value = "";
  dispatchNotify(`Destination ${stopNumber} added to the route.`);
}

function setDispatchComboboxExpanded(input, options, expanded) {
  input?.setAttribute("aria-expanded", String(Boolean(expanded)));
  options?.classList.toggle("hidden", !expanded);
}

function renderDispatchDestinationSuggestions(state = "results") {
  const input = document.getElementById("dispatchDestinationSearch");
  const options = document.getElementById("dispatchDestinationSuggestions");
  if (!input || !options) return;
  dispatchDestinationResultIndex = -1;

  if (state === "hidden") {
    options.innerHTML = "";
    setDispatchComboboxExpanded(input, options, false);
    return;
  }
  if (state === "loading") {
    options.innerHTML = '<div class="dispatch-combobox-message">Loading destination catalog…</div>';
  } else if (state === "minimum") {
    options.innerHTML = '<div class="dispatch-combobox-message">Type at least 2 characters, or clear to browse.</div>';
  } else if (!dispatchDestinationResults.length) {
    options.innerHTML = '<div class="dispatch-combobox-message">No catalog destinations found. Use a custom map point if needed.</div>';
  } else {
    options.innerHTML = dispatchDestinationResults.map((destination, index) => `
      <button type="button" role="option" data-dispatch-destination-index="${index}" aria-selected="false">
        <span><strong>${dispatchEscape(destination.display_label || destination.name)}</strong><small>${dispatchEscape(dispatchDestinationTypeLabel(destination.destination_type))} · ${dispatchEscape(destination.barangay || "General Santos City")}</small></span>
        ${destination.is_verified ? '<i class="dispatch-verified-mark" title="Verified catalog entry"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></i>' : ""}
      </button>
    `).join("");
  }
  setDispatchComboboxExpanded(input, options, true);
}

function updateDispatchDestinationResultHighlight() {
  document.querySelectorAll("[data-dispatch-destination-index]").forEach((button, index) => {
    const active = index === dispatchDestinationResultIndex;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
}

function renderDispatchPopularDestinations() {
  const container = document.getElementById("dispatchPopularDestinations");
  if (!container) return;
  if (!dispatchPopularDestinationResults.length) {
    container.innerHTML = '<small class="dispatch-popular-empty">No verified destinations are available.</small>';
    return;
  }
  container.innerHTML = dispatchPopularDestinationResults.map((destination, index) => {
    const selected = dispatchCatalogDestinationIsSelected(destination.id);
    return `
      <button type="button" data-dispatch-popular-index="${index}" ${selected ? "disabled" : ""}>
        <span>${dispatchEscape(destination.display_label || destination.name)}</span>
        <i class="dispatch-verified-mark" title="Verified catalog entry"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></i>
      </button>
    `;
  }).join("");
}

function selectDispatchPopularDestinations(destinations = [], mode = dispatchDestinationMode) {
  const ranked = [...destinations];
  if (mode === "road_segment") {
    const priorities = new Map(
      DISPATCH_POPULAR_ROAD_LABELS.map((label, index) => [dispatchNormalizeSearchText(label), index])
    );
    ranked.sort((first, second) => {
      const firstRank = priorities.get(dispatchNormalizeSearchText(first.display_label || first.name));
      const secondRank = priorities.get(dispatchNormalizeSearchText(second.display_label || second.name));
      return (firstRank ?? Number.MAX_SAFE_INTEGER) - (secondRank ?? Number.MAX_SAFE_INTEGER) ||
        String(first.display_label || first.name).localeCompare(String(second.display_label || second.name));
    });
  }
  return ranked.slice(0, DISPATCH_POPULAR_DESTINATION_LIMIT);
}

async function chooseDispatchDestinationResult(index) {
  const result = dispatchDestinationResults[index];
  if (!result) return;
  return chooseDispatchDestination(result);
}

async function chooseDispatchDestination(result) {
  if (!result || dispatchCatalogDestinationIsSelected(result.id)) {
    dispatchNotify("That verified destination is already in this route.", "error");
    return;
  }
  const input = document.getElementById("dispatchDestinationSearch");
  if (input) input.value = result.display_label || result.name;
  renderDispatchDestinationSuggestions("loading");
  try {
    const detail = await dispatchRequest(getDispatchDestinationApiUrl(result.id));
    const destination = detail.destination;
    const geometrySegments = dispatchGeometrySegments(detail.points || []);
    if (dispatchCatalogDestinationIsSelected(destination.id)) {
      dispatchNotify("That verified destination is already in this route.", "error");
      renderDispatchDestinationSuggestions("hidden");
      return;
    }
    if (dispatchCoordinatesAreNearlyDuplicate(destination.latitude, destination.longitude)) {
      dispatchNotify(
        `This destination is within ${DISPATCH_NEAR_DUPLICATE_METERS} meters of an existing stop.`,
        "error"
      );
      renderDispatchDestinationSuggestions("hidden");
      return;
    }
    const row = addDispatchStopRow({
      catalog_id: destination.id,
      destination_type: destination.destination_type,
      name: destination.name,
      operator_label: destination.display_label || destination.name,
      location_name: destination.display_label || destination.name,
      address_reference: `${dispatchDestinationTypeLabel(destination.destination_type)} · ${destination.barangay || "General Santos City"}`,
      barangay: destination.barangay,
      latitude: destination.latitude,
      longitude: destination.longitude,
      is_verified: destination.is_verified,
      geometry_segments: geometrySegments,
      stop_order: getDispatchStopDrafts().length + 1,
      geofence_radius_meters: DISPATCH_DEFAULT_GEOFENCE_METERS
    });
    dispatchLastAddedStopRow = row;
    const workflowResult = document.getElementById("dispatchWorkflowResult");
    if (workflowResult) {
      workflowResult.className = "dispatch-workflow-result success dispatch-add-result";
      workflowResult.innerHTML = 'Destination added. <button type="button" data-dispatch-undo-stop>Undo</button>';
    }
    renderDispatchDestinationSuggestions("hidden");
    dispatchDestinationResults = [];
    if (input) {
      input.value = "";
      input.focus();
    }
    renderDispatchPopularDestinations();
  } catch (error) {
    if (error.name !== "AbortError") dispatchNotify(error.message, "error");
    renderDispatchDestinationSuggestions("hidden");
  }
}

async function performDispatchDestinationSearch() {
  const input = document.getElementById("dispatchDestinationSearch");
  const query = input?.value.trim() || "";
  if (!query) {
    dispatchDestinationSearchController?.abort();
    dispatchDestinationSearchController = new AbortController();
    try {
      const popularCandidates = await dispatchRequest(
        getDispatchDestinationsApiUrl({
          type: dispatchDestinationMode,
          limit: DISPATCH_DESTINATION_RESULT_LIMIT
        }),
        { signal: dispatchDestinationSearchController.signal }
      );
      dispatchPopularDestinationResults = selectDispatchPopularDestinations(
        Array.isArray(popularCandidates) ? popularCandidates : [],
        dispatchDestinationMode
      );
      renderDispatchPopularDestinations();
      renderDispatchDestinationSuggestions("hidden");
    } catch (error) {
      if (error.name === "AbortError") return;
      dispatchPopularDestinationResults = [];
      renderDispatchPopularDestinations();
    }
    return;
  }
  if (query.length === 1) {
    dispatchDestinationResults = [];
    renderDispatchDestinationSuggestions("minimum");
    return;
  }

  dispatchDestinationSearchController?.abort();
  dispatchDestinationSearchController = new AbortController();
  renderDispatchDestinationSuggestions("loading");
  try {
    dispatchDestinationResults = await dispatchRequest(
      getDispatchDestinationsApiUrl({
        type: dispatchDestinationMode,
        q: query,
        limit: DISPATCH_DESTINATION_RESULT_LIMIT
      }),
      { signal: dispatchDestinationSearchController.signal }
    );
    if (!Array.isArray(dispatchDestinationResults)) dispatchDestinationResults = [];
    renderDispatchDestinationSuggestions("results");
  } catch (error) {
    if (error.name === "AbortError") return;
    dispatchDestinationResults = [];
    renderDispatchDestinationSuggestions("results");
  }
}

function scheduleDispatchDestinationSearch({ immediate = false } = {}) {
  clearTimeout(dispatchDestinationSearchTimer);
  dispatchDestinationSearchTimer = setTimeout(
    performDispatchDestinationSearch,
    immediate ? 0 : DISPATCH_DESTINATION_SEARCH_DEBOUNCE_MS
  );
}

function handleDispatchDestinationSearchKeydown(event) {
  if (!dispatchDestinationResults.length) {
    if (event.key === "Escape") renderDispatchDestinationSuggestions("hidden");
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    dispatchDestinationResultIndex = Math.min(
      dispatchDestinationResultIndex + 1,
      dispatchDestinationResults.length - 1
    );
    updateDispatchDestinationResultHighlight();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    dispatchDestinationResultIndex = Math.max(dispatchDestinationResultIndex - 1, 0);
    updateDispatchDestinationResultHighlight();
  } else if (event.key === "Enter" && dispatchDestinationResultIndex >= 0) {
    event.preventDefault();
    void chooseDispatchDestinationResult(dispatchDestinationResultIndex);
  } else if (event.key === "Escape") {
    renderDispatchDestinationSuggestions("hidden");
  }
}

function setDispatchDestinationMode(mode) {
  if (!["road_segment", "barangay_hall"].includes(mode)) return;
  dispatchDestinationMode = mode;
  document.querySelectorAll("[data-dispatch-destination-mode]").forEach((button) => {
    const active = button.dataset.dispatchDestinationMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const input = document.getElementById("dispatchDestinationSearch");
  const label = document.getElementById("dispatchDestinationSearchLabel");
  if (input) {
    input.value = "";
    input.placeholder = mode === "road_segment" ? "Search verified road sections..." : "Search verified barangay halls...";
  }
  if (label) label.textContent = mode === "road_segment" ? "Search Road Sections" : "Search Barangay Halls";
  const popularHeading = document.getElementById("dispatchPopularDestinationHeading");
  if (popularHeading) {
    popularHeading.textContent = mode === "road_segment"
      ? "Popular Road Sections"
      : "Verified Barangay Halls";
  }
  dispatchPopularDestinationResults = [];
  renderDispatchPopularDestinations();
  clearDispatchDestinationPreview();
  scheduleDispatchDestinationSearch({ immediate: true });
}

function collectDispatchTicketForm() {
  const stops = getDispatchStopDrafts();
  if (!stops.length) throw new Error("Add at least one route stop.");
  const orders = stops.map((stop) => stop.stop_order);
  if (orders.some((order) => !Number.isInteger(order) || order <= 0)) {
    throw new Error("Every stop order must be a positive integer.");
  }
  if (new Set(orders).size !== orders.length) {
    throw new Error("Duplicate stop orders are not allowed.");
  }
  for (const stop of stops) {
    if (!stop.location_name) throw new Error(`Stop ${stop.stop_order} needs a location name.`);
    if (!Number.isFinite(stop.latitude) || stop.latitude < -90 || stop.latitude > 90) {
      throw new Error(`Stop ${stop.stop_order} has an invalid latitude.`);
    }
    if (!Number.isFinite(stop.longitude) || stop.longitude < -180 || stop.longitude > 180) {
      throw new Error(`Stop ${stop.stop_order} has an invalid longitude.`);
    }
    if (
      !Number.isFinite(stop.geofence_radius_meters) ||
      stop.geofence_radius_meters < 25 ||
      stop.geofence_radius_meters > 5000
    ) {
      throw new Error(`Stop ${stop.stop_order} needs a geofence from 25 to 5000 meters.`);
    }
  }

  const scheduledStart = document.getElementById("dispatchScheduledStart")?.value;
  const expectedReturn = document.getElementById("dispatchExpectedReturn")?.value;
  if (
    scheduledStart &&
    expectedReturn &&
    new Date(expectedReturn).getTime() <= new Date(scheduledStart).getTime()
  ) {
    throw new Error("Expected return must be later than the scheduled start.");
  }
  let previousExpectedTime = scheduledStart
    ? new Date(scheduledStart).getTime()
    : null;
  const expectedReturnTime = expectedReturn
    ? new Date(expectedReturn).getTime()
    : null;
  for (const stop of [...stops].sort((a, b) => a.stop_order - b.stop_order)) {
    if (!stop.expected_arrival_at) continue;
    const stopExpectedTime = new Date(stop.expected_arrival_at).getTime();
    if (previousExpectedTime !== null && stopExpectedTime < previousExpectedTime) {
      throw new Error(
        `Expected arrival for stop ${stop.stop_order} is earlier than the preceding schedule.`
      );
    }
    if (expectedReturnTime !== null && stopExpectedTime > expectedReturnTime) {
      throw new Error(
        `Expected arrival for stop ${stop.stop_order} is later than the expected return.`
      );
    }
    previousExpectedTime = stopExpectedTime;
  }

  const actor = dispatchActorPayload();
  return {
    truck_id: document.getElementById("dispatchTruckId")?.value.trim(),
    truck_name_snapshot: document.getElementById("dispatchTruckName")?.value.trim(),
    assigned_personnel_id:
      document.getElementById("dispatchPersonnelId")?.value || null,
    assigned_personnel_name:
      document.getElementById("dispatchPersonnelName")?.value.trim() || null,
    dispatch_date: document.getElementById("dispatchDate")?.value,
    scheduled_start_at: scheduledStart || null,
    expected_return_at: expectedReturn || null,
    route_name: document.getElementById("dispatchRouteName")?.value.trim(),
    route_description:
      document.getElementById("dispatchRouteDescription")?.value.trim() || null,
    notes: document.getElementById("dispatchNotes")?.value.trim() || null,
    created_by_user_id: actor.actor_id,
    created_by_name: actor.actor_name,
    stops: stops.map(({ metadata_key, barangay, ...stop }) => stop)
  };
}

function resetDispatchTicketForm() {
  document.getElementById("dispatchTicketForm")?.reset();
  const stopRows = document.getElementById("dispatchStopRows");
  if (stopRows) {
    stopRows.innerHTML = '<div class="dispatch-route-empty">No destinations added yet.</div>';
  }
  const editingId = document.getElementById("dispatchEditingTicketId");
  if (editingId) editingId.value = "";
  document.getElementById("dispatchTicketEditorTitle").textContent = "Dispatch Planner";
  document.getElementById("dispatchSaveTicketBtn").textContent = "Save Draft";
  const today = new Date();
  const localToday = new Date(today.getTime() - today.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
  document.getElementById("dispatchDate").value = localToday;
  document.getElementById("dispatchScheduledStart").value = dispatchLocalInputDateTime(today);
  const routeName = document.getElementById("dispatchRouteName");
  if (routeName) {
    routeName.value = selectedTrackingTruck
      ? `Truck ${selectedTrackingTruck.truck_id} - ${localToday}`
      : "";
  }
  document.getElementById("dispatchTicketFormError")?.classList.add("hidden");
  document.getElementById("dispatchWorkflowResult")?.classList.add("hidden");
  dispatchPendingLinkTicketId = null;
  dispatchDestinationResults = [];
  dispatchDestinationSearchController?.abort();
  clearTimeout(dispatchDestinationSearchTimer);
  dispatchStopMetadata.clear();
  clearDispatchDestinationPreview();
  renderDispatchDestinationSuggestions("hidden");
  setDispatchDestinationMode("road_segment");
  setDispatchAddDestinationMode(false);
  renderDispatchDraftOnLiveMap();
}

function fillDispatchTicketForm(details) {
  const ticket = details.ticket;
  resetDispatchTicketForm();
  document.getElementById("dispatchEditingTicketId").value = ticket.id;
  document.getElementById("dispatchTicketEditorTitle").textContent =
    `Edit ${ticket.ticket_number}`;
  document.getElementById("dispatchSaveTicketBtn").textContent =
    "Update Draft";
  document.getElementById("dispatchTruckId").value = ticket.truck_id || "";
  document.getElementById("dispatchTruckName").value =
    ticket.truck_name_snapshot || "";
  document.getElementById("dispatchPersonnelId").value =
    ticket.assigned_personnel_id || "";
  document.getElementById("dispatchPersonnelName").value =
    ticket.assigned_personnel_name || "";
  document.getElementById("dispatchDate").value = String(
    ticket.dispatch_date || ""
  ).slice(0, 10);
  document.getElementById("dispatchScheduledStart").value =
    dispatchInputDateTime(ticket.scheduled_start_at);
  document.getElementById("dispatchRouteName").value = ticket.route_name || "";
  document.getElementById("dispatchRouteDescription").value =
    ticket.route_description || "";

  const stopRows = document.getElementById("dispatchStopRows");
  stopRows.innerHTML = "";
  details.stops.forEach((stop) => addDispatchStopRow({
    ...stop,
    barangay: String(stop.address_reference || "").match(/Barangay\s+([^,]+)/i)?.[1] || ""
  }));
  if (!details.stops.length) {
    stopRows.innerHTML = '<div class="dispatch-route-empty">No destinations added yet.</div>';
  }
  renumberDispatchStopRows(false);
  renderDispatchDraftOnLiveMap();
}

function openDispatchTicketEditor(details = null) {
  if (details) fillDispatchTicketForm(details);
  else resetDispatchTicketForm();
  setDispatchWorkspaceTab("plan");
  updateDispatchSelectedTruckContext(selectedTrackingTruck);
}

function renderDispatchWorkflowResult(message, type = "success", ticketId = null) {
  const result = document.getElementById("dispatchWorkflowResult");
  if (!result) return;
  result.className = `dispatch-workflow-result ${type}`;
  result.innerHTML = `
    <div>${dispatchEscape(message)}</div>
    ${ticketId ? `<button type="button" class="dispatch-inline-action secondary" data-dispatch-retry-link="${dispatchEscape(ticketId)}">Retry Link</button>` : ""}
  `;
}

function renderDispatchStepProgress(activeStep, state = "progress", detail = "", ticketId = null) {
  const result = document.getElementById("dispatchWorkflowResult");
  if (!result) return;
  const steps = ["Creating ticket", "Issuing", "Linking truck", "Dispatched"];
  result.className = `dispatch-workflow-result dispatch-step-progress ${state}`;
  result.innerHTML = `
    <ol>
      ${steps.map((label, index) => {
        const stepClass = index < activeStep
          ? "complete"
          : index === activeStep
            ? state === "error" ? "error" : state === "success" ? "complete" : "current"
            : "pending";
        return `<li class="${stepClass}"><i>${index + 1}</i><span>${dispatchEscape(label)}</span></li>`;
      }).join("")}
    </ol>
    ${detail ? `<p>${dispatchEscape(detail)}</p>` : ""}
    ${ticketId ? `<button type="button" class="dispatch-inline-action secondary" data-dispatch-retry-link="${dispatchEscape(ticketId)}">Retry Link</button>` : ""}
  `;
}

async function saveDispatchDraft({ notify = true, showResult = true } = {}) {
  const errorBox = document.getElementById("dispatchTicketFormError");
  const saveButton = document.getElementById("dispatchSaveTicketBtn");
  try {
    errorBox?.classList.add("hidden");
    saveButton.disabled = true;
    const payload = collectDispatchTicketForm();
    if (!payload.truck_id || !payload.truck_name_snapshot || !payload.dispatch_date || !payload.route_name) {
      throw new Error("Truck, dispatch date, and route name are required.");
    }
    const ticketId = document.getElementById("dispatchEditingTicketId")?.value;
    const details = await dispatchRequest(
      ticketId ? getDispatchTicketApiUrl(ticketId) : getDispatchTicketsApiUrl(),
      {
        method: ticketId ? "PATCH" : "POST",
        body: JSON.stringify(payload)
      }
    );
    selectedDispatchTicket = details;
    renderDispatchTicketDetails(details);
    renderDispatchPlannedRoute(details);
    document.getElementById("dispatchEditingTicketId").value = details.ticket.id;
    document.getElementById("dispatchTicketEditorTitle").textContent = details.ticket.ticket_number;
    document.getElementById("dispatchSaveTicketBtn").textContent = "Update Draft";
    if (showResult) {
      renderDispatchWorkflowResult(
        `${details.ticket.ticket_number} saved as a prepared draft.`,
        "success"
      );
    }
    if (notify) dispatchNotify(ticketId ? "Dispatch draft updated." : "Dispatch draft saved.");
    return details;
  } catch (error) {
    if (errorBox) {
      errorBox.textContent = error.message;
      errorBox.classList.remove("hidden");
    }
    throw error;
  } finally {
    saveButton.disabled = false;
  }
}

async function submitDispatchTicketForm(event) {
  event.preventDefault();
  try {
    await saveDispatchDraft();
  } catch (error) {
    // The inline form already displays the exact validation or request error.
  }
}

async function retryDispatchSessionLink(ticketId) {
  const sessionId = document.getElementById("dispatchTrackingSessionId")?.value;
  if (!dispatchSelectedSessionActive || !sessionId) {
    renderDispatchStepProgress(
      2,
      "error",
      "Link retry blocked because the originally selected tracking session is no longer active.",
      ticketId
    );
    return;
  }
  try {
    renderDispatchStepProgress(2, "progress", "Retrying the exact selected tracking session.");
    const details = await dispatchRequest(
      `${getDispatchTicketApiUrl(ticketId)}/link-session`,
      {
        method: "POST",
        body: JSON.stringify({
          ...dispatchActorPayload(),
          tracking_session_id: sessionId
        })
      }
    );
    dispatchPendingLinkTicketId = null;
    selectedDispatchTicket = details;
    renderDispatchTicketDetails(details);
    renderDispatchPlannedRoute(details);
    renderDispatchStepProgress(
      3,
      "success",
      `${details.ticket.ticket_number} is linked to tracking session #${sessionId}.`
    );
    await loadDispatchLiveData();
  } catch (error) {
    dispatchPendingLinkTicketId = ticketId;
    renderDispatchStepProgress(
      2,
      "error",
      `Link Failed for ticket ${selectedDispatchTicket?.ticket?.ticket_number || ticketId}: ${error.message}`,
      ticketId
    );
  }
}

async function dispatchSelectedTruckNow() {
  const button = document.getElementById("dispatchNowBtn");
  const selectedSession = document.getElementById("dispatchTrackingSessionId")?.value;
  if (
    !dispatchSelectedSessionActive ||
    !selectedTrackingTruck ||
    !selectedSession ||
    String(selectedSession) !== String(selectedSessionId)
  ) {
    renderDispatchWorkflowResult(
      "Dispatch Now requires the exact active truck session selected from the Live tab. Save Draft remains available.",
      "error"
    );
    return;
  }

  button.disabled = true;
  let details = selectedDispatchTicket;
  try {
    renderDispatchStepProgress(0, "progress");
    const editingTicketId = document.getElementById("dispatchEditingTicketId")?.value;
    const editingStatus =
      details && Number(details.ticket?.id) === Number(editingTicketId)
        ? details.ticket.status
        : null;
    if (!editingTicketId || !["dispatched", "in_progress"].includes(editingStatus)) {
      try {
        details = await saveDispatchDraft({ notify: false, showResult: false });
      } catch (error) {
        renderDispatchStepProgress(0, "error", `Prepare Failed: ${error.message}`);
        return;
      }
    }

    const ticketId = details.ticket.id;
    const ticketNumber = details.ticket.ticket_number;
    if (details.ticket.status === "prepared") {
      try {
        renderDispatchStepProgress(1, "progress", `${ticketNumber} prepared successfully.`);
        details = await dispatchRequest(`${getDispatchTicketApiUrl(ticketId)}/issue`, {
          method: "POST",
          body: JSON.stringify(dispatchActorPayload())
        });
        selectedDispatchTicket = details;
      } catch (error) {
        renderDispatchStepProgress(
          1,
          "error",
          `${ticketNumber} remains saved as a prepared draft. Issue Failed: ${error.message}`
        );
        return;
      }
    }

    try {
      renderDispatchStepProgress(2, "progress", `${ticketNumber} issued successfully.`);
      details = await dispatchRequest(`${getDispatchTicketApiUrl(ticketId)}/link-session`, {
        method: "POST",
        body: JSON.stringify({
          ...dispatchActorPayload(),
          tracking_session_id: selectedSession
        })
      });
    } catch (error) {
      dispatchPendingLinkTicketId = ticketId;
      selectedDispatchTicket = details;
      renderDispatchTicketDetails(details);
      renderDispatchStepProgress(
        2,
        "error",
        `${ticketNumber} was issued, but Link Failed: ${error.message}`,
        ticketId
      );
      return;
    }

    dispatchPendingLinkTicketId = null;
    selectedDispatchTicket = details;
    renderDispatchTicketDetails(details);
    renderDispatchPlannedRoute(details);
    renderDispatchStepProgress(
      3,
      "success",
      `${ticketNumber} is in progress on ${document.getElementById("dispatchTruckName")?.value || selectedTrackingTruck.truck_id}, linked to session #${selectedSession}.`
    );
    await loadDispatchLiveData();
    dispatchNotify("Dispatch ticket issued and linked successfully.");
  } finally {
    button.disabled = !dispatchSelectedSessionActive;
  }
}

function dispatchTicketQuery() {
  const parameters = new URLSearchParams();
  const values = {
    search: document.getElementById("dispatchTicketSearch")?.value.trim(),
    date: document.getElementById("dispatchTicketDateFilter")?.value,
    truck: document.getElementById("dispatchTicketTruckFilter")?.value.trim()
  };
  Object.entries(values).forEach(([key, value]) => {
    if (value) parameters.set(key, value);
  });
  return parameters.toString();
}

function renderDispatchRecordCards(list, tickets, emptyMessage) {
  if (!list) return;
  if (!tickets.length) {
    list.innerHTML = `<div class="dispatch-route-empty">${dispatchEscape(emptyMessage)}</div>`;
    return;
  }

  list.innerHTML = tickets
    .map((ticket) => {
      const terminalStops =
        Number(ticket.completed_stops || 0) + Number(ticket.skipped_stops || 0);
      return `
        <article class="dispatch-inline-list-card">
          <div class="dispatch-inline-list-heading">
            <div><strong>${dispatchEscape(ticket.ticket_number)}</strong><small>${dispatchEscape(ticket.route_name)}</small></div>
            <span class="dispatch-status-chip ${dispatchStatusClass(ticket.status)}">${dispatchEscape(dispatchStatusLabel(ticket.status))}</span>
          </div>
          <dl>
            <div><dt>Truck</dt><dd>${dispatchEscape(ticket.truck_name_snapshot || ticket.truck_id)}</dd></div>
            <div><dt>Date</dt><dd>${dispatchEscape(String(ticket.dispatch_date || "").slice(0, 10))}</dd></div>
            <div><dt>Stops</dt><dd>${terminalStops}/${Number(ticket.total_stops || 0)}</dd></div>
          </dl>
          <button type="button" class="dispatch-inline-action secondary" data-dispatch-open-ticket="${ticket.id}">Open details</button>
        </article>
      `;
    })
    .join("");
}

async function loadDispatchTickets() {
  const activeList = document.getElementById("dispatchActiveTicketsList");
  const preparedList = document.getElementById("dispatchPreparedTicketsList");
  if (!activeList || !preparedList) return;
  activeList.innerHTML = '<div class="dispatch-route-empty">Loading active tickets...</div>';
  preparedList.innerHTML = '<div class="dispatch-route-empty">Loading prepared tickets...</div>';

  try {
    const query = dispatchTicketQuery();
    dispatchTicketRows = await dispatchRequest(
      `${getDispatchTicketsApiUrl()}${query ? `?${query}` : ""}`
    );
    renderDispatchRecordCards(
      activeList,
      dispatchTicketRows.filter((ticket) =>
        ["dispatched", "in_progress", "returning_to_wmo"].includes(ticket.status)
      ),
      "No active dispatch tickets found."
    );
    renderDispatchRecordCards(
      preparedList,
      dispatchTicketRows.filter((ticket) => ticket.status === "prepared"),
      "No prepared dispatch tickets found."
    );
  } catch (error) {
    const message = `<div class="dispatch-route-empty error">${dispatchEscape(error.message)}</div>`;
    activeList.innerHTML = message;
    preparedList.innerHTML = message;
  }
}

function setDispatchRecordTab(tabName) {
  const nextTab = ["active", "prepared", "reports"].includes(tabName)
    ? tabName
    : "active";
  document.querySelectorAll("[data-dispatch-record-tab]").forEach((button) => {
    const active = button.dataset.dispatchRecordTab === nextTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-dispatch-record-view]").forEach((view) => {
    const active = view.dataset.dispatchRecordView === nextTab;
    view.classList.toggle("active", active);
    view.hidden = !active;
  });
}

async function loadDispatchRecords() {
  await Promise.all([loadDispatchTickets(), loadDispatchReports()]);
}

async function openDispatchTicket(ticketId) {
  try {
    const details = await dispatchRequest(getDispatchTicketApiUrl(ticketId));
    selectedDispatchTicket = details;
    renderDispatchTicketDetails(details);
    renderDispatchPlannedRoute(details);
    setDispatchWorkspaceTab("plan");
    document.getElementById("dispatchCurrentPanel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    dispatchNotify(error.message, "error");
  }
}

async function loadDispatchReports() {
  const list = document.getElementById("dispatchReportsList");
  if (!list) return;
  list.innerHTML = '<div class="dispatch-route-empty">Loading dispatch reports...</div>';

  const parameters = new URLSearchParams();
  const date = document.getElementById("dispatchTicketDateFilter")?.value;
  const truck = document.getElementById("dispatchTicketTruckFilter")?.value.trim();
  const search = dispatchNormalizeSearchText(
    document.getElementById("dispatchTicketSearch")?.value
  );
  if (date) parameters.set("date_from", date);
  if (date) parameters.set("date_to", date);
  if (truck) parameters.set("truck", truck);

  try {
    let reports = await dispatchRequest(
      `${getDispatchReportsApiUrl()}${parameters.toString() ? `?${parameters}` : ""}`
    );
    if (search) {
      reports = reports.filter((report) =>
        dispatchNormalizeSearchText(
          [
            report.ticket_number,
            report.route_name,
            report.truck_id,
            report.truck_name_snapshot,
            report.assigned_personnel_name
          ].join(" ")
        ).includes(search)
      );
    }
    if (!reports.length) {
      list.innerHTML = '<div class="dispatch-route-empty">No completed or cancelled dispatch reports found.</div>';
      return;
    }
    list.innerHTML = reports
      .map(
        (report) => `
          <article class="dispatch-inline-list-card">
            <div class="dispatch-inline-list-heading">
              <div><strong>${dispatchEscape(report.ticket_number)}</strong><small>${dispatchEscape(report.route_name)}</small></div>
              <span class="dispatch-status-chip ${dispatchStatusClass(report.status)}">${dispatchEscape(dispatchStatusLabel(report.status))}</span>
            </div>
            <dl>
              <div><dt>Truck</dt><dd>${dispatchEscape(report.truck_name_snapshot || report.truck_id)}</dd></div>
              <div><dt>Date</dt><dd>${dispatchEscape(String(report.dispatch_date || "").slice(0, 10))}</dd></div>
              <div><dt>Stops</dt><dd>${Number(report.completed_stops || 0)} done, ${Number(report.skipped_stops || 0)} skipped</dd></div>
              <div><dt>Duration</dt><dd>${dispatchEscape(dispatchFormatDuration(report.total_dispatch_duration_seconds))}</dd></div>
            </dl>
            <button type="button" class="dispatch-inline-action secondary" data-dispatch-open-ticket="${report.id}">Open details</button>
          </article>
        `
      )
      .join("");
  } catch (error) {
    list.innerHTML = `<div class="dispatch-route-empty error">${dispatchEscape(error.message)}</div>`;
  }
}

async function performDispatchAction(button) {
  const action = button.dataset.dispatchAction;
  const ticketId = button.dataset.ticketId;
  const stopId = button.dataset.stopId;
  if (!action || !ticketId) return;

  if (action === "edit") {
    const details =
      selectedDispatchTicket?.ticket?.id === Number(ticketId)
        ? selectedDispatchTicket
        : await dispatchRequest(getDispatchTicketApiUrl(ticketId));
    openDispatchTicketEditor(details);
    return;
  }

  let endpoint = "";
  const body = dispatchActorPayload();
  if (action === "issue") endpoint = `/tickets/${ticketId}/issue`;
  if (action === "link-selected") {
    const trackingSessionId = document.getElementById("dispatchTrackingSessionId")?.value;
    if (!dispatchSelectedSessionActive || !trackingSessionId) {
      dispatchNotify("Select the exact active truck session before linking.", "error");
      return;
    }
    body.tracking_session_id = trackingSessionId;
    endpoint = `/tickets/${ticketId}/link-session`;
  }
  if (action === "returning") endpoint = `/tickets/${ticketId}/returning`;
  if (action === "arrive") endpoint = `/tickets/${ticketId}/stops/${stopId}/arrive`;
  if (action === "complete") endpoint = `/tickets/${ticketId}/stops/${stopId}/complete`;
  if (action === "cancel") {
    const reason = window.prompt("Enter the dispatch cancellation reason:");
    if (!reason) return;
    body.reason = reason;
    endpoint = `/tickets/${ticketId}/cancel`;
  }
  if (action === "skip") {
    const reason = window.prompt("Enter the reason for skipping this stop:");
    if (!reason) return;
    body.reason = reason;
    endpoint = `/tickets/${ticketId}/stops/${stopId}/skip`;
  }
  if (!endpoint) return;

  button.disabled = true;
  try {
    const details = await dispatchRequest(
      `${getAppApiBase()}/dispatch${endpoint}`,
      { method: "POST", body: JSON.stringify(body) }
    );
    selectedDispatchTicket = details;
    renderDispatchTicketDetails(details);
    renderDispatchPlannedRoute(details);
    await loadDispatchLiveData();
    dispatchNotify("Dispatch updated successfully.");
  } catch (error) {
    dispatchNotify(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function handleDispatchStopEditorClick(event) {
  const row = event.target.closest("[data-dispatch-stop-row]");
  if (!row) return;
  if (event.target.closest("[data-dispatch-stop-remove]")) {
    if (dispatchFocusedStopRow === row) dispatchFocusedStopRow = null;
    dispatchStopMetadata.delete(row.dataset.dispatchMetadataKey || "");
    row.remove();
    renumberDispatchStopRows();
    const container = document.getElementById("dispatchStopRows");
    if (container && !container.querySelector("[data-dispatch-stop-row]")) {
      container.innerHTML = '<div class="dispatch-route-empty">No destinations added yet.</div>';
    }
    renderDispatchPopularDestinations();
    renderDispatchDraftOnLiveMap();
    return;
  }

  const moveButton = event.target.closest("[data-dispatch-stop-move]");
  if (!moveButton) return;
  const direction = moveButton.dataset.dispatchStopMove;
  if (direction === "up" && row.previousElementSibling) {
    row.parentElement.insertBefore(row, row.previousElementSibling);
  } else if (direction === "down" && row.nextElementSibling) {
    row.parentElement.insertBefore(row.nextElementSibling, row);
  }
  renumberDispatchStopRows();
  renderDispatchPlanningMap();
}

function setupDispatchModule() {
  const workspace = document.querySelector(".tracking-dispatch-workspace");
  if (!workspace || workspace.dataset.bound === "true") return;
  workspace.dataset.bound = "true";
  if (typeof bindActiveTruckSelection === "function") bindActiveTruckSelection();

  workspace.querySelectorAll("[data-dispatch-workspace-action]").forEach((button) => {
    button.addEventListener("click", () => {
      setDispatchAddDestinationMode(false);
      const action = button.dataset.dispatchWorkspaceAction;
      if (action === "monitor") {
        setDispatchWorkspaceTab("monitor");
      } else {
        setDispatchRecordTab(action === "reports" ? "reports" : "active");
        setDispatchWorkspaceTab("records");
        if (action === "reports") void loadDispatchReports();
      }
    });
  });
  document.getElementById("dispatchAddStopBtn")?.addEventListener("click", () => {
    if (!selectedTrackingTruck) {
      dispatchNotify("Select an active truck first.", "error");
      setDispatchWorkspaceTab("monitor");
      return;
    }
    setDispatchAddDestinationMode(!dispatchAddDestinationMode);
  });
  document
    .getElementById("dispatchConfirmDestinationBtn")
    ?.addEventListener("click", confirmDispatchDestinationPreview);
  document
    .getElementById("dispatchClearPreviewBtn")
    ?.addEventListener("click", clearDispatchDestinationPreview);

  workspace.querySelectorAll("[data-dispatch-destination-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      setDispatchDestinationMode(button.dataset.dispatchDestinationMode);
    });
  });
  const destinationInput = document.getElementById("dispatchDestinationSearch");
  const destinationOptions = document.getElementById("dispatchDestinationSuggestions");
  destinationInput?.addEventListener("input", scheduleDispatchDestinationSearch);
  destinationInput?.addEventListener("keydown", handleDispatchDestinationSearchKeydown);
  destinationInput?.addEventListener("focus", () => {
    scheduleDispatchDestinationSearch({ immediate: true });
  });
  destinationOptions?.addEventListener("click", (event) => {
    const option = event.target.closest("[data-dispatch-destination-index]");
    if (option) {
      void chooseDispatchDestinationResult(Number(option.dataset.dispatchDestinationIndex));
    }
  });
  document.getElementById("dispatchPopularDestinations")?.addEventListener("click", (event) => {
    const option = event.target.closest("[data-dispatch-popular-index]");
    if (option) {
      void chooseDispatchDestination(
        dispatchPopularDestinationResults[Number(option.dataset.dispatchPopularIndex)]
      );
    }
  });
  document.getElementById("dispatchDestinationSearchClearBtn")?.addEventListener("click", () => {
    dispatchDestinationSearchController?.abort();
    clearTimeout(dispatchDestinationSearchTimer);
    dispatchDestinationResults = [];
    if (destinationInput) {
      destinationInput.value = "";
      destinationInput.focus();
    }
    scheduleDispatchDestinationSearch({ immediate: true });
  });
  document.getElementById("dispatchPreviewLabel")?.addEventListener("input", (event) => {
    if (!dispatchDestinationPreview?.is_custom) return;
    dispatchDestinationPreview.location_name = event.target.value.trim();
    document.getElementById("dispatchConfirmDestinationBtn").disabled =
      !dispatchDestinationPreview.location_name;
  });
  document.getElementById("dispatchClearRouteBtn")?.addEventListener("click", () => {
    const container = document.getElementById("dispatchStopRows");
    if (container) {
      container.innerHTML = '<div class="dispatch-route-empty">No destinations added yet.</div>';
    }
    dispatchStopMetadata.clear();
    dispatchFocusedStopRow = null;
    setDispatchAddDestinationMode(false);
    clearDispatchDestinationPreview();
    renderDispatchPopularDestinations();
    renderDispatchDraftOnLiveMap();
  });
  document
    .getElementById("dispatchTicketForm")
    ?.addEventListener("submit", submitDispatchTicketForm);
  document
    .getElementById("dispatchNowBtn")
    ?.addEventListener("click", dispatchSelectedTruckNow);
  document
    .getElementById("dispatchTicketFilterBtn")
    ?.addEventListener("click", loadDispatchRecords);
  workspace.querySelectorAll("[data-dispatch-record-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      setDispatchRecordTab(button.dataset.dispatchRecordTab);
      if (button.dataset.dispatchRecordTab === "reports") void loadDispatchReports();
    });
  });

  document
    .getElementById("dispatchStopRows")
    ?.addEventListener("click", handleDispatchStopEditorClick);
  document.getElementById("dispatchStopRows")?.addEventListener("focusin", (event) => {
    dispatchFocusedStopRow = event.target.closest("[data-dispatch-stop-row]");
  });
  document.getElementById("dispatchStopRows")?.addEventListener("input", () => {
    renderDispatchDraftOnLiveMap();
  });

  if (truckMap && !truckMap.__dispatchMapClickBound) {
    truckMap.__dispatchMapClickBound = true;
    truckMap.on("click", handleDispatchLiveMapClick);
  }

  document.addEventListener("click", (event) => {
    if (!event.target.closest("#dispatchDestinationSearchWrap")) {
      renderDispatchDestinationSuggestions("hidden");
    }
    const closeButton = event.target.closest("[data-dispatch-close]");
    if (closeButton) {
      closeDispatchModal(closeButton.dataset.dispatchClose);
      return;
    }
    const openTicketButton = event.target.closest("[data-dispatch-open-ticket]");
    if (openTicketButton) {
      void openDispatchTicket(openTicketButton.dataset.dispatchOpenTicket);
      return;
    }
    const retryLinkButton = event.target.closest("[data-dispatch-retry-link]");
    if (retryLinkButton) {
      void retryDispatchSessionLink(retryLinkButton.dataset.dispatchRetryLink);
      return;
    }
    if (event.target.closest("[data-dispatch-undo-stop]")) {
      const row = dispatchLastAddedStopRow;
      if (row?.isConnected) {
        dispatchStopMetadata.delete(row.dataset.dispatchMetadataKey || "");
        row.remove();
        renumberDispatchStopRows();
        const container = document.getElementById("dispatchStopRows");
        if (container && !container.querySelector("[data-dispatch-stop-row]")) {
          container.innerHTML = '<div class="dispatch-route-empty">No destinations added yet.</div>';
        }
        renderDispatchPopularDestinations();
        renderDispatchDraftOnLiveMap();
      }
      dispatchLastAddedStopRow = null;
      document.getElementById("dispatchWorkflowResult")?.classList.add("hidden");
      return;
    }
    if (event.target.closest("[data-dispatch-route-retry]")) {
      dispatchLastRoutingSignature = "";
      if (selectedDispatchTicket && !document.querySelector('[data-tracking-workspace-view="plan"]')?.hidden) {
        renderDispatchDraftOnLiveMap();
      } else if (selectedDispatchTicket) {
        renderDispatchPlannedRoute(selectedDispatchTicket);
      } else {
        renderDispatchDraftOnLiveMap();
      }
      return;
    }
    const actionButton = event.target.closest("[data-dispatch-action]");
    if (actionButton) {
      void performDispatchAction(actionButton);
    }
  });

  resetDispatchTicketForm();
  updateDispatchSelectedTruckContext(null);
  setDispatchWorkspaceTab("monitor");
  setDispatchRecordTab("active");
  renderDispatchEmptyPanel();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DISPATCH_WMO_LOCATION,
    chooseDispatchSegmentOrientation,
    dispatchCatalogDestinationIsSelected,
    dispatchRoutingFailureState
  };
}
