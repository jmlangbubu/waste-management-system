const DISPATCH_WMO_LOCATION = Object.freeze({
  latitude: 6.1060875,
  longitude: 125.1816406,
  radiusMeters: 100
});

let dispatchFocusedStopRow = null;

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
  clearDispatchPlannedRoute();
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
    clearDispatchPlannedRoute();
    selectedDispatchTicket = null;
    renderDispatchEmptyPanel(
      "This tracking session is not linked to a dispatch ticket. Open Dispatch Tickets to link the matching issued ticket."
    );
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
      clearDispatchTrackingSelection();
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
  const routePoints = [
    { point: wmoPoint, stop: null, isWmo: true },
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
    if (routePoint.isWmo) {
      if (index === 0) {
        L.marker(routePoint.point, {
          icon: dispatchMarkerIcon("W", "wmo")
        })
          .bindTooltip("WMO start and return point")
          .addTo(dispatchPlannedLayerGroup);
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
    canLink
      ? `<button type="button" class="dispatch-action-button" data-dispatch-action="link-active" data-ticket-id="${ticket.id}">Link active session</button>`
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
  return `
    <div class="dispatch-stop-row" data-dispatch-stop-row>
      <div class="dispatch-stop-row-header">
        <strong>Stop <span data-dispatch-stop-number>${index + 1}</span></strong>
        <div class="dispatch-stop-row-actions">
          <button type="button" data-dispatch-stop-move="up" aria-label="Move stop up">Up</button>
          <button type="button" data-dispatch-stop-move="down" aria-label="Move stop down">Down</button>
          <button type="button" data-dispatch-stop-remove aria-label="Remove stop">Remove</button>
        </div>
      </div>
      <div class="dispatch-stop-fields">
        <label class="dispatch-stop-field">
          Order
          <input type="number" min="1" data-dispatch-field="stop_order" value="${dispatchEscape(stop.stop_order || index + 1)}" required>
        </label>
        <label class="dispatch-stop-field wide">
          Location name
          <input type="text" maxlength="255" data-dispatch-field="location_name" value="${dispatchEscape(stop.location_name || "")}" required>
        </label>
        <label class="dispatch-stop-field">
          Geofence meters
          <input type="number" min="25" max="5000" data-dispatch-field="geofence_radius_meters" value="${dispatchEscape(stop.geofence_radius_meters || 100)}" required>
        </label>
        <label class="dispatch-stop-field wide">
          Address reference
          <input type="text" maxlength="500" data-dispatch-field="address_reference" value="${dispatchEscape(stop.address_reference || "")}">
        </label>
        <label class="dispatch-stop-field">
          Latitude
          <input type="number" min="-90" max="90" step="any" data-dispatch-field="latitude" value="${dispatchEscape(stop.latitude ?? "")}" required>
        </label>
        <label class="dispatch-stop-field">
          Longitude
          <input type="number" min="-180" max="180" step="any" data-dispatch-field="longitude" value="${dispatchEscape(stop.longitude ?? "")}" required>
        </label>
        <label class="dispatch-stop-field wide">
          Expected arrival
          <input type="datetime-local" data-dispatch-field="expected_arrival_at" value="${dispatchEscape(dispatchInputDateTime(stop.expected_arrival_at))}">
        </label>
      </div>
    </div>
  `;
}

function addDispatchStopRow(stop = {}) {
  const container = document.getElementById("dispatchStopRows");
  if (!container) return;
  const index = container.querySelectorAll("[data-dispatch-stop-row]").length;
  container.insertAdjacentHTML("beforeend", dispatchStopRowTemplate(stop, index));
  renumberDispatchStopRows(false);
  renderDispatchPlanningMap();
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

function initializeDispatchPlanningMap() {
  if (dispatchPlanningMap || !window.L) return;
  const mapElement = document.getElementById("dispatchPlanningMap");
  if (!mapElement) return;

  dispatchPlanningMap = L.map(mapElement).setView(
    [DISPATCH_WMO_LOCATION.latitude, DISPATCH_WMO_LOCATION.longitude],
    13
  );
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(dispatchPlanningMap);
  dispatchPlanningLayerGroup = L.layerGroup().addTo(dispatchPlanningMap);
  dispatchPlanningMap.on("click", (event) => {
    const row =
      dispatchFocusedStopRow ||
      document.querySelector("#dispatchStopRows [data-dispatch-stop-row]");
    if (!row) return;
    const latitudeInput = row.querySelector('[data-dispatch-field="latitude"]');
    const longitudeInput = row.querySelector('[data-dispatch-field="longitude"]');
    if (latitudeInput) latitudeInput.value = event.latlng.lat.toFixed(7);
    if (longitudeInput) longitudeInput.value = event.latlng.lng.toFixed(7);
    dispatchFocusedStopRow = row;
    renderDispatchPlanningMap();
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
      address_reference: value("address_reference").trim() || null,
      latitude: numericValue("latitude"),
      longitude: numericValue("longitude"),
      geofence_radius_meters: numericValue("geofence_radius_meters"),
      expected_arrival_at: value("expected_arrival_at") || null
    };
  });
}

function renderDispatchPlanningMap() {
  if (!dispatchPlanningMap || !dispatchPlanningLayerGroup) return;
  dispatchPlanningLayerGroup.clearLayers();

  const stops = getDispatchStopDrafts().filter(
    (stop) => Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude)
  );
  const wmo = [DISPATCH_WMO_LOCATION.latitude, DISPATCH_WMO_LOCATION.longitude];
  const points = [wmo, ...stops.map((stop) => [stop.latitude, stop.longitude]), wmo];

  L.marker(wmo, { icon: dispatchMarkerIcon("W", "wmo") })
    .bindTooltip("WMO")
    .addTo(dispatchPlanningLayerGroup);
  stops.forEach((stop) => {
    L.marker([stop.latitude, stop.longitude], {
      icon: dispatchMarkerIcon(stop.stop_order, "")
    })
      .bindTooltip(stop.location_name || `Stop ${stop.stop_order}`)
      .addTo(dispatchPlanningLayerGroup);
  });
  if (points.length > 2) {
    L.polyline(points, {
      color: "#66736d",
      weight: 3,
      dashArray: "8 8"
    }).addTo(dispatchPlanningLayerGroup);
    dispatchPlanningMap.fitBounds(L.latLngBounds(points), {
      padding: [25, 25],
      maxZoom: 16
    });
  }
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
  document.getElementById("dispatchStopRows").innerHTML = "";
  document.getElementById("dispatchEditingTicketId").value = "";
  document.getElementById("dispatchTicketEditorTitle").textContent =
    "Create Dispatch Ticket";
  document.getElementById("dispatchSaveTicketBtn").textContent =
    "Save Prepared Ticket";
  const today = new Date();
  const localToday = new Date(today.getTime() - today.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
  document.getElementById("dispatchDate").value = localToday;
  document.getElementById("dispatchTicketFormError")?.classList.add("hidden");
  addDispatchStopRow();
}

function fillDispatchTicketForm(details) {
  const ticket = details.ticket;
  resetDispatchTicketForm();
  document.getElementById("dispatchEditingTicketId").value = ticket.id;
  document.getElementById("dispatchTicketEditorTitle").textContent =
    `Edit ${ticket.ticket_number}`;
  document.getElementById("dispatchSaveTicketBtn").textContent =
    "Update Prepared Ticket";
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
  details.stops.forEach((stop) => addDispatchStopRow(stop));
  renumberDispatchStopRows(false);
  renderDispatchPlanningMap();
}

function openDispatchTicketEditor(details = null) {
  if (details) fillDispatchTicketForm(details);
  else resetDispatchTicketForm();
  openDispatchModal("dispatchTicketEditorModal");
  initializeDispatchPlanningMap();
  setTimeout(() => {
    dispatchPlanningMap?.invalidateSize();
    renderDispatchPlanningMap();
  }, 50);
}

async function submitDispatchTicketForm(event) {
  event.preventDefault();
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
    closeDispatchModal("dispatchTicketEditorModal");
    dispatchNotify(ticketId ? "Dispatch ticket updated." : "Dispatch ticket prepared.");
  } catch (error) {
    if (errorBox) {
      errorBox.textContent = error.message;
      errorBox.classList.remove("hidden");
    }
  } finally {
    saveButton.disabled = false;
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
  const tableBody = document.getElementById("dispatchTicketsTableBody");
  if (!tableBody) return;
  tableBody.innerHTML =
    '<tr><td colspan="7" class="loading-state">Loading dispatch tickets...</td></tr>';

  try {
    const query = dispatchTicketQuery();
    dispatchTicketRows = await dispatchRequest(
      `${getDispatchTicketsApiUrl()}${query ? `?${query}` : ""}`
    );
    if (!dispatchTicketRows.length) {
      tableBody.innerHTML =
        '<tr><td colspan="7" class="loading-state">No dispatch tickets found.</td></tr>';
      return;
    }
    tableBody.innerHTML = dispatchTicketRows
      .map((ticket) => {
        const terminalStops =
          Number(ticket.completed_stops || 0) + Number(ticket.skipped_stops || 0);
        return `
          <tr>
            <td><strong>${dispatchEscape(ticket.ticket_number)}</strong></td>
            <td>${dispatchEscape(String(ticket.dispatch_date || "").slice(0, 10))}</td>
            <td>${dispatchEscape(ticket.truck_name_snapshot || ticket.truck_id)}</td>
            <td>${dispatchEscape(ticket.route_name)}</td>
            <td>${terminalStops}/${Number(ticket.total_stops || 0)}</td>
            <td><span class="dispatch-status-chip ${dispatchStatusClass(ticket.status)}">${dispatchEscape(dispatchStatusLabel(ticket.status))}</span></td>
            <td><button type="button" class="dispatch-table-action" data-dispatch-open-ticket="${ticket.id}">View</button></td>
          </tr>
        `;
      })
      .join("");
  } catch (error) {
    tableBody.innerHTML = `<tr><td colspan="7" class="loading-state">${dispatchEscape(error.message)}</td></tr>`;
  }
}

async function openDispatchTicket(ticketId) {
  try {
    const details = await dispatchRequest(getDispatchTicketApiUrl(ticketId));
    selectedDispatchTicket = details;
    renderDispatchTicketDetails(details);
    renderDispatchPlannedRoute(details);
    closeDispatchModal("dispatchTicketsModal");
    document.getElementById("dispatchCurrentPanel")?.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  } catch (error) {
    dispatchNotify(error.message, "error");
  }
}

async function loadDispatchReports() {
  const tableBody = document.getElementById("dispatchReportsTableBody");
  if (!tableBody) return;
  tableBody.innerHTML =
    '<tr><td colspan="7" class="loading-state">Loading dispatch reports...</td></tr>';

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
      tableBody.innerHTML =
        '<tr><td colspan="7" class="loading-state">No completed or cancelled dispatch reports found.</td></tr>';
      return;
    }
    tableBody.innerHTML = reports
      .map(
        (report) => `
          <tr>
            <td><strong>${dispatchEscape(report.ticket_number)}</strong></td>
            <td>${dispatchEscape(String(report.dispatch_date || "").slice(0, 10))}</td>
            <td>${dispatchEscape(report.truck_name_snapshot || report.truck_id)}</td>
            <td>${dispatchEscape(report.route_name)}</td>
            <td>${Number(report.completed_stops || 0)} completed, ${Number(report.skipped_stops || 0)} skipped</td>
            <td>${dispatchEscape(dispatchFormatDuration(report.total_dispatch_duration_seconds))}</td>
            <td><span class="dispatch-status-chip ${dispatchStatusClass(report.status)}">${dispatchEscape(dispatchStatusLabel(report.status))}</span></td>
          </tr>
        `
      )
      .join("");
  } catch (error) {
    tableBody.innerHTML = `<tr><td colspan="7" class="loading-state">${dispatchEscape(error.message)}</td></tr>`;
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
  if (action === "link-active") endpoint = `/tickets/${ticketId}/link-active-session`;
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
    const rows = document.querySelectorAll(
      "#dispatchStopRows [data-dispatch-stop-row]"
    );
    if (rows.length <= 1) {
      dispatchNotify("A dispatch ticket needs at least one stop.", "error");
      return;
    }
    if (dispatchFocusedStopRow === row) dispatchFocusedStopRow = null;
    row.remove();
    renumberDispatchStopRows();
    renderDispatchPlanningMap();
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
  const createButton = document.getElementById("dispatchCreateTicketBtn");
  if (!createButton || createButton.dataset.bound === "true") return;
  createButton.dataset.bound = "true";

  createButton.addEventListener("click", () => openDispatchTicketEditor());
  document.getElementById("dispatchTicketsBtn")?.addEventListener("click", () => {
    openDispatchModal("dispatchTicketsModal");
    void loadDispatchTickets();
  });
  document.getElementById("dispatchReportsBtn")?.addEventListener("click", () => {
    openDispatchModal("dispatchReportsModal");
    void loadDispatchReports();
  });
  document
    .getElementById("dispatchAddStopBtn")
    ?.addEventListener("click", () => addDispatchStopRow());
  document
    .getElementById("dispatchTicketForm")
    ?.addEventListener("submit", submitDispatchTicketForm);
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
    renderDispatchPlanningMap();
  });

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
    const actionButton = event.target.closest("[data-dispatch-action]");
    if (actionButton) {
      void performDispatchAction(actionButton);
    }
  });

  renderDispatchEmptyPanel();
}
