const DISPATCH_WMO_LOCATION = Object.freeze({
  latitude: 6.1060875,
  longitude: 125.1816406,
  radiusMeters: 100
});
const DISPATCH_DEFAULT_GEOFENCE_METERS = 100;
const DISPATCH_NEAR_DUPLICATE_METERS = 12;
const DISPATCH_LOCATION_CACHE_PRECISION = 5;

let dispatchFocusedStopRow = null;
let dispatchLocationLookupController = null;
const dispatchLocationLabelCache = new Map();

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
  const selectedTab = ["live", "dispatch", "tickets", "reports"].includes(tabName)
    ? tabName
    : "live";
  document.querySelectorAll("[data-tracking-workspace-tab]").forEach((button) => {
    const isActive = button.dataset.trackingWorkspaceTab === selectedTab;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
  document.querySelectorAll("[data-tracking-workspace-view]").forEach((view) => {
    const isActive = view.dataset.trackingWorkspaceView === selectedTab;
    view.classList.toggle("active", isActive);
    view.hidden = !isActive;
  });
  if (selectedTab === "tickets") void loadDispatchTickets();
  if (selectedTab === "reports") void loadDispatchReports();
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
    document.getElementById("dispatchSelectedTruckName").textContent = "Choose a truck from Live";
    document.getElementById("dispatchSelectedTruckStatus").textContent = "Waiting";
    document.getElementById("dispatchSelectedSessionLabel").textContent = "--";
    document.getElementById("dispatchSelectedPersonnelLabel").textContent = "--";
    document.getElementById("dispatchSelectedStartLabel").textContent = "--";
    document.getElementById("dispatchSelectedGpsLabel").textContent = "--";
    document.getElementById("dispatchSelectedCoordinatesLabel").textContent = "--";
    if (dispatchNowButton) dispatchNowButton.disabled = true;
    if (hint) hint.textContent = "Select a live truck, then enable Add Destination and click the map.";
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
  document.getElementById("dispatchSelectedSessionLabel").textContent = `#${truck.session_id}`;
  document.getElementById("dispatchSelectedPersonnelLabel").textContent = personnelName;
  document.getElementById("dispatchSelectedStartLabel").textContent = dispatchFormatDateTime(truck.started_at);
  document.getElementById("dispatchSelectedGpsLabel").textContent = dispatchFormatDateTime(
    reliablePoint?.recorded_at || truck.location_last_updated || truck.last_updated_at
  );
  document.getElementById("dispatchSelectedCoordinatesLabel").textContent = reliablePoint
    ? `${Number(reliablePoint.lat).toFixed(6)}, ${Number(reliablePoint.lng).toFixed(6)}`
    : "Waiting for a reliable GPS point";

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
      ? "Enable Add Destination, then click the live map to create ordered stops."
      : "The truck is selected, but the map is waiting for a reliable GPS point.";
  }
}

function prepareDispatchPlannerForTruck(truck) {
  if (!truck) return;
  const previousSessionId = document.getElementById("dispatchTrackingSessionId")?.value;
  const isNewSelection = String(previousSessionId || "") !== String(truck.session_id);
  if (isNewSelection) resetDispatchTicketForm();
  updateDispatchSelectedTruckContext(truck);
  setDispatchWorkspaceTab("dispatch");
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
    if (
      response.status === 503 ||
      payload.code === "DISPATCH_DATABASE_SETUP_REQUIRED"
    ) {
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

  dispatchSetupRequired = false;
  updateDispatchSetupNotices();
  return payload.data;
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
  if (stop.stop_status === "arrived" || isCurrent) return "#2d73c7";
  if (stop.stop_status === "on_the_way") return "#2d73c7";
  return "#8a9690";
}

function renderDispatchPlannedRoute(details) {
  clearDispatchPlannedRoute();
  if (!truckMap || !window.L || !details || !Array.isArray(details.stops)) return;

  const stops = [...details.stops].sort(
    (a, b) => Number(a.stop_order) - Number(b.stop_order)
  );
  dispatchPlannedLayerGroup = L.layerGroup().addTo(truckMap);

  const wmoPoint = [
    DISPATCH_WMO_LOCATION.latitude,
    DISPATCH_WMO_LOCATION.longitude
  ];
  const reliableStart =
    selectedTrackingTruck &&
    String(selectedTrackingTruck.truck_id) === String(details.ticket?.truck_id)
      ? getDispatchSelectedReliablePoint()
      : null;
  const routeStartPoint = reliableStart
    ? [Number(reliableStart.lat), Number(reliableStart.lng)]
    : wmoPoint;
  const routePoints = [
    { point: routeStartPoint, stop: null, isWmo: !reliableStart, isTruckStart: Boolean(reliableStart) },
    ...stops.map((stop) => ({
      point: [Number(stop.latitude), Number(stop.longitude)],
      stop,
      isWmo: false
    })),
    { point: wmoPoint, stop: null, isWmo: true }
  ].filter(({ point }) => point.every(Number.isFinite));

  const currentStop = stops.find(
    (stop) => !["completed", "skipped"].includes(stop.stop_status)
  );

  routePoints.forEach((routePoint, index) => {
    if (routePoint.isWmo || routePoint.isTruckStart) {
      if (index === 0) {
        if (routePoint.isWmo) {
          L.marker(routePoint.point, {
            icon: dispatchMarkerIcon("W", "wmo")
          })
            .bindTooltip("WMO start and return point")
            .addTo(dispatchPlannedLayerGroup);
        }
      }
      return;
    }

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
              ? "active"
            : "";
    L.marker(routePoint.point, {
      icon: dispatchMarkerIcon(stop.stop_order, markerClass)
    })
      .bindTooltip(
        `${dispatchEscape(stop.location_name)} · ${dispatchEscape(dispatchStatusLabel(stop.stop_status))}`
      )
      .addTo(dispatchPlannedLayerGroup);
  });

  for (let index = 0; index < routePoints.length - 1; index++) {
    const destination = routePoints[index + 1];
    const isCurrent =
      destination.stop &&
      currentStop &&
      Number(destination.stop.id) === Number(currentStop.id);
    L.polyline([routePoints[index].point, destination.point], {
      color: dispatchSegmentColor(destination.stop, isCurrent),
      weight: 4,
      opacity: 0.65,
      dashArray: "9 9"
    }).addTo(dispatchPlannedLayerGroup);
  }
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
  return `
    <article class="dispatch-stop-row" data-dispatch-stop-row>
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
        <label class="dispatch-stop-field wide dispatch-stop-location-field">
          Street / location
          <input type="text" maxlength="255" data-dispatch-field="location_name" value="${dispatchEscape(stop.location_name || "")}" required>
        </label>
        <label class="dispatch-stop-field">
          Barangay
          <input type="text" maxlength="120" data-dispatch-field="barangay" value="${dispatchEscape(barangay)}" placeholder="Resolving...">
        </label>
        <label class="dispatch-stop-field">
          Radius
          <div class="dispatch-input-suffix"><input type="number" min="25" max="5000" data-dispatch-field="geofence_radius_meters" value="${dispatchEscape(stop.geofence_radius_meters || DISPATCH_DEFAULT_GEOFENCE_METERS)}" required><span>m</span></div>
        </label>
        <label class="dispatch-stop-field">
          Latitude
          <input type="number" min="-90" max="90" step="any" data-dispatch-field="latitude" value="${dispatchEscape(stop.latitude ?? "")}" required>
        </label>
        <label class="dispatch-stop-field">
          Longitude
          <input type="number" min="-180" max="180" step="any" data-dispatch-field="longitude" value="${dispatchEscape(stop.longitude ?? "")}" required>
        </label>
        <label class="dispatch-stop-field">
          Expected arrival <small>Optional</small>
          <input type="datetime-local" data-dispatch-field="expected_arrival_at" value="${dispatchEscape(dispatchInputDateTime(stop.expected_arrival_at))}">
        </label>
        <input type="hidden" data-dispatch-field="address_reference" value="${dispatchEscape(stop.address_reference || "")}">
      </div>
      <small class="dispatch-stop-location-status" data-dispatch-location-status>${barangay ? `Barangay resolved: ${dispatchEscape(barangay)}` : "Location label is editable."}</small>
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
  clearDispatchPlannedRoute();
  if (!truckMap || !window.L) return;
  const stops = getDispatchStopDrafts().filter(
    (stop) => Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude)
  );
  if (!stops.length) return;
  dispatchPlannedLayerGroup = L.layerGroup().addTo(truckMap);
  const reliableStart = getDispatchSelectedReliablePoint();
  const wmo = [DISPATCH_WMO_LOCATION.latitude, DISPATCH_WMO_LOCATION.longitude];
  const startPoint = reliableStart
    ? [Number(reliableStart.lat), Number(reliableStart.lng)]
    : wmo;
  const points = [startPoint, ...stops.map((stop) => [stop.latitude, stop.longitude]), wmo];

  stops.forEach((stop) => {
    L.marker([stop.latitude, stop.longitude], {
      icon: dispatchMarkerIcon(stop.stop_order, "")
    })
      .bindTooltip(stop.location_name || `Stop ${stop.stop_order}`)
      .addTo(dispatchPlannedLayerGroup);
  });
  if (points.length > 1) {
    L.polyline(points, {
      color: "#66736d",
      weight: 3,
      opacity: 0.75,
      dashArray: "8 8"
    }).addTo(dispatchPlannedLayerGroup);
  }
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
        ? "Stop Adding"
        : "Add Destination";
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

async function resolveDispatchDestinationLabel(row, latitude, longitude, stopNumber) {
  if (!row) return;
  const status = row.querySelector("[data-dispatch-location-status]");
  const locationInput = row.querySelector('[data-dispatch-field="location_name"]');
  const barangayInput = row.querySelector('[data-dispatch-field="barangay"]');
  const addressInput = row.querySelector('[data-dispatch-field="address_reference"]');
  const fallbackLabel = `Selected Location ${stopNumber}`;
  if (locationInput && !locationInput.value) locationInput.value = fallbackLabel;
  if (status) status.textContent = "Checking the local barangay boundary...";

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
      if (status) status.textContent = "Location lookup unavailable. Coordinates are preserved; edit the label if needed.";
      return;
    }
  }

  if (!row.isConnected) return;
  const barangay = String(result?.assigned_barangay || "").trim();
  const boundaryConfirmed = result?.assignment_method === "polygon";
  if (barangay && barangay !== "For Verification") {
    const formattedLabel = `Barangay ${barangay}, General Santos City`;
    if (barangayInput) barangayInput.value = barangay;
    if (addressInput) addressInput.value = formattedLabel;
    if (locationInput && (!locationInput.value || locationInput.value === fallbackLabel)) {
      locationInput.value = formattedLabel;
    }
    if (status) {
      status.textContent = boundaryConfirmed
        ? `Inside the ${barangay} barangay polygon. Add a street name if known.`
        : `Possible Barangay ${barangay}. Verify the editable label before dispatch.`;
    }
  } else if (status) {
    status.textContent = "No barangay polygon matched. Verify this General Santos location before dispatch.";
  }
  renderDispatchDraftOnLiveMap();
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

  const stopNumber = getDispatchStopDrafts().length + 1;
  const row = addDispatchStopRow({
    stop_order: stopNumber,
    location_name: `Selected Location ${stopNumber}`,
    latitude: latitude.toFixed(7),
    longitude: longitude.toFixed(7),
    geofence_radius_meters: DISPATCH_DEFAULT_GEOFENCE_METERS
  });
  void resolveDispatchDestinationLabel(row, latitude, longitude, stopNumber);
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
    stops
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
  document.getElementById("dispatchExpectedReturn").value =
    dispatchInputDateTime(ticket.expected_return_at);
  document.getElementById("dispatchRouteName").value = ticket.route_name || "";
  document.getElementById("dispatchRouteDescription").value =
    ticket.route_description || "";
  document.getElementById("dispatchNotes").value = ticket.notes || "";

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
  setDispatchWorkspaceTab("dispatch");
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

async function saveDispatchDraft({ notify = true } = {}) {
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
    renderDispatchWorkflowResult(
      `${details.ticket.ticket_number} saved as a prepared draft.`,
      "success"
    );
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
    renderDispatchWorkflowResult(
      "Link retry blocked because the originally selected tracking session is no longer active.",
      "error",
      ticketId
    );
    return;
  }
  try {
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
    renderDispatchWorkflowResult(
      `${details.ticket.ticket_number} is dispatched and linked to tracking session #${sessionId}.`,
      "success"
    );
    await loadDispatchLiveData();
  } catch (error) {
    dispatchPendingLinkTicketId = ticketId;
    renderDispatchWorkflowResult(
      `Link Failed for ticket ${selectedDispatchTicket?.ticket?.ticket_number || ticketId}: ${error.message}`,
      "error",
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
    const editingTicketId = document.getElementById("dispatchEditingTicketId")?.value;
    const editingStatus =
      details && Number(details.ticket?.id) === Number(editingTicketId)
        ? details.ticket.status
        : null;
    if (!editingTicketId || !["dispatched", "in_progress"].includes(editingStatus)) {
      try {
        details = await saveDispatchDraft({ notify: false });
      } catch (error) {
        renderDispatchWorkflowResult(`Prepare Failed: ${error.message}`, "error");
        return;
      }
    }

    const ticketId = details.ticket.id;
    const ticketNumber = details.ticket.ticket_number;
    if (details.ticket.status === "prepared") {
      try {
        details = await dispatchRequest(`${getDispatchTicketApiUrl(ticketId)}/issue`, {
          method: "POST",
          body: JSON.stringify(dispatchActorPayload())
        });
        selectedDispatchTicket = details;
      } catch (error) {
        renderDispatchWorkflowResult(
          `${ticketNumber} remains saved as a prepared draft. Issue Failed: ${error.message}`,
          "error"
        );
        return;
      }
    }

    try {
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
      renderDispatchWorkflowResult(
        `${ticketNumber} was issued, but Link Failed: ${error.message}`,
        "error",
        ticketId
      );
      return;
    }

    dispatchPendingLinkTicketId = null;
    selectedDispatchTicket = details;
    renderDispatchTicketDetails(details);
    renderDispatchPlannedRoute(details);
    renderDispatchWorkflowResult(
      `${ticketNumber} is in progress on ${document.getElementById("dispatchTruckName")?.value || selectedTrackingTruck.truck_id}, linked to session #${selectedSession}.`,
      "success"
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
    status: document.getElementById("dispatchTicketStatusFilter")?.value,
    date: document.getElementById("dispatchTicketDateFilter")?.value,
    truck: document.getElementById("dispatchTicketTruckFilter")?.value.trim()
  };
  Object.entries(values).forEach(([key, value]) => {
    if (value) parameters.set(key, value);
  });
  return parameters.toString();
}

async function loadDispatchTickets() {
  const list = document.getElementById("dispatchTicketsList");
  if (!list) return;
  list.innerHTML = '<div class="dispatch-route-empty">Loading dispatch tickets...</div>';

  try {
    const query = dispatchTicketQuery();
    dispatchTicketRows = await dispatchRequest(
      `${getDispatchTicketsApiUrl()}${query ? `?${query}` : ""}`
    );
    if (!document.getElementById("dispatchTicketStatusFilter")?.value) {
      dispatchTicketRows = dispatchTicketRows.filter(
        (ticket) => !["completed", "cancelled"].includes(ticket.status)
      );
    }
    if (!dispatchTicketRows.length) {
      list.innerHTML = '<div class="dispatch-route-empty">No active or prepared dispatch tickets found.</div>';
      return;
    }
    list.innerHTML = dispatchTicketRows
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
  } catch (error) {
    list.innerHTML = `<div class="dispatch-route-empty error">${dispatchEscape(error.message)}</div>`;
  }
}

async function openDispatchTicket(ticketId) {
  try {
    const details = await dispatchRequest(getDispatchTicketApiUrl(ticketId));
    selectedDispatchTicket = details;
    renderDispatchTicketDetails(details);
    renderDispatchPlannedRoute(details);
    setDispatchWorkspaceTab("dispatch");
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
  const dateFrom = document.getElementById("dispatchReportDateFrom")?.value;
  const dateTo = document.getElementById("dispatchReportDateTo")?.value;
  const truck = document.getElementById("dispatchReportTruck")?.value.trim();
  if (dateFrom) parameters.set("date_from", dateFrom);
  if (dateTo) parameters.set("date_to", dateTo);
  if (truck) parameters.set("truck", truck);

  try {
    const reports = await dispatchRequest(
      `${getDispatchReportsApiUrl()}${parameters.toString() ? `?${parameters}` : ""}`
    );
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
    row.remove();
    renumberDispatchStopRows();
    const container = document.getElementById("dispatchStopRows");
    if (container && !container.querySelector("[data-dispatch-stop-row]")) {
      container.innerHTML = '<div class="dispatch-route-empty">No destinations added yet.</div>';
    }
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

  workspace.querySelectorAll("[data-tracking-workspace-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      setDispatchAddDestinationMode(false);
      setDispatchWorkspaceTab(button.dataset.trackingWorkspaceTab);
    });
  });
  document.getElementById("dispatchAddStopBtn")?.addEventListener("click", () => {
    if (!selectedTrackingTruck) {
      dispatchNotify("Select an active truck from the Live tab first.", "error");
      setDispatchWorkspaceTab("live");
      return;
    }
    setDispatchAddDestinationMode(!dispatchAddDestinationMode);
  });
  document.getElementById("dispatchClearRouteBtn")?.addEventListener("click", () => {
    const container = document.getElementById("dispatchStopRows");
    if (container) {
      container.innerHTML = '<div class="dispatch-route-empty">No destinations added yet.</div>';
    }
    dispatchFocusedStopRow = null;
    setDispatchAddDestinationMode(false);
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
    ?.addEventListener("click", loadDispatchTickets);
  document
    .getElementById("dispatchReportFilterBtn")
    ?.addEventListener("click", loadDispatchReports);

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
    const actionButton = event.target.closest("[data-dispatch-action]");
    if (actionButton) {
      void performDispatchAction(actionButton);
    }
  });

  resetDispatchTicketForm();
  updateDispatchSelectedTruckContext(null);
  setDispatchWorkspaceTab("live");
  renderDispatchEmptyPanel();
}
