// =========================
// COMPLAINT MAP HELPERS
// =========================

const issueRedIcon = L.icon({
  iconUrl: "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});

const barangayBlueIcon = L.icon({
  iconUrl: "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-blue.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});

const personnelGreenIcon = L.icon({
  iconUrl: "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});

const complaintResolutionRouteState = {
  map: null,
  issueMarker: null,
  startMarker: null,
  routeLine: null,
  routingControl: null
};

function formatComplaintStatus(status) {
  if (!status) return "pending";
  return String(status).toLowerCase();
}

function getComplaintStatusBadge(status) {
  const s = String(status || "").toLowerCase();

  if (s === "pending") return `<span class="status-badge pending">Pending</span>`;
  if (s === "validated") return `<span class="status-badge forwarded">Validated</span>`;
  if (s === "forwarded") return `<span class="status-badge forwarded">Forwarded</span>`;
  if (s === "in_progress") return `<span class="status-badge in-progress">In Progress</span>`;
  if (s === "resolved") return `<span class="status-badge resolved">Resolved</span>`;
  if (s === "rejected") return `<span class="status-badge rejected">Rejected</span>`;

  return `<span class="status-badge unknown">${escapeHtml(status || "-")}</span>`;
}

function clearComplaintMapLayers() {
  if (!complaintMapInstance) return;

  if (complaintMapMarker) {
    complaintMapInstance.removeLayer(complaintMapMarker);
    complaintMapMarker = null;
  }

  if (complaintRoutingControl) {
    complaintMapInstance.removeControl(complaintRoutingControl);
    complaintRoutingControl = null;
  }

  complaintNearbyMarkers.forEach((marker) => {
    if (complaintMapInstance.hasLayer(marker)) {
      complaintMapInstance.removeLayer(marker);
    }
  });

  complaintNearbyMarkers = [];
}

function calculateDistanceMetersLocal(lat1, lng1, lat2, lng2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const earthRadius = 6371000;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(earthRadius * c);
}

function formatDistanceText(distanceMeters) {
  const distance = Number(distanceMeters);

  if (!Number.isFinite(distance) || distance <= 0) return "Distance unavailable";

  if (distance >= 1000) {
    return `${(distance / 1000).toFixed(2)} km`;
  }

  return `${Math.round(distance)} meters`;
}

function renderNearbyBarangayList(candidates) {
  const listEl = document.getElementById("nearbyBarangayList");
  if (!listEl) return;

  if (!Array.isArray(candidates) || !candidates.length) {
    listEl.innerHTML = `<div class="nearby-empty">No nearby barangays found.</div>`;
    return;
  }

  listEl.innerHTML = candidates.map((candidate, index) => {
    const isActive =
      selectedBarangayCandidate &&
      selectedBarangayCandidate.barangay_name === candidate.barangay_name &&
      selectedBarangayCandidate.reference_name === candidate.reference_name;

    const distanceText =
      Number(candidate.distance_meters) > 0
        ? `${candidate.distance_meters} meters away`
        : "Distance unavailable";

    return `
      <div class="nearby-candidate-item ${isActive ? "active" : ""}" data-index="${index}">
        <div class="nearby-candidate-name">${escapeHtml(candidate.barangay_name || "-")}</div>
        <div class="nearby-candidate-ref">${escapeHtml(candidate.reference_name || "-")}</div>
        <div class="nearby-candidate-distance">${escapeHtml(distanceText)}</div>
      </div>
    `;
  }).join("");

  listEl.querySelectorAll(".nearby-candidate-item").forEach((item) => {
    item.addEventListener("click", () => {
      const index = Number(item.dataset.index);
      const candidate = candidates[index];

      if (candidate) {
        selectBarangayCandidate(candidate, candidates);
      }
    });
  });
}

function updateChosenBarangayUI() {
  const chosenText = document.getElementById("chosenBarangayText");
  const chosenMeta = document.getElementById("chosenBarangayMeta");

  if (!chosenText || !chosenMeta) return;

  if (!selectedBarangayCandidate) {
    chosenText.textContent = "None selected";
    chosenMeta.textContent = "";
    return;
  }

  const distanceText =
    Number(selectedBarangayCandidate.distance_meters) > 0
      ? `${selectedBarangayCandidate.distance_meters} meters away`
      : "Distance unavailable";

  chosenText.textContent = `Suggested: ${selectedBarangayCandidate.barangay_name || "-"}`;
  chosenMeta.textContent =
    `${selectedBarangayCandidate.reference_name || "-"} • ${distanceText}`;
}

function selectBarangayCandidate(candidate, candidates = []) {
  if (!currentComplaint || !complaintMapInstance) return;

  if (!window.L || !L.Routing) {
    console.error("Leaflet Routing Machine is not loaded.");
    alert("Routing library is not loaded. Please refresh the page.");
    return;
  }

  const issueLat = parseFloat(currentComplaint.latitude);
  const issueLng = parseFloat(currentComplaint.longitude);
  const destLat = parseFloat(candidate.latitude);
  const destLng = parseFloat(candidate.longitude);

  let fallbackDistance =
    Number(candidate.distance_meters) > 0
      ? Number(candidate.distance_meters)
      : (!Number.isNaN(issueLat) &&
         !Number.isNaN(issueLng) &&
         !Number.isNaN(destLat) &&
         !Number.isNaN(destLng))
      ? calculateDistanceMetersLocal(issueLat, issueLng, destLat, destLng)
      : null;

  selectedBarangayCandidate = {
    ...candidate,
    distance_meters: fallbackDistance
  };

  updateChosenBarangayUI();
  renderNearbyBarangayList(candidates);

  if (
    Number.isNaN(issueLat) ||
    Number.isNaN(issueLng) ||
    Number.isNaN(destLat) ||
    Number.isNaN(destLng)
  ) {
    return;
  }

  if (complaintRoutingControl) {
    try {
      complaintMapInstance.removeControl(complaintRoutingControl);
    } catch (err) {
      console.warn("Failed removing old routing control:", err);
    }

    complaintRoutingControl = null;
  }

  const initialBounds = L.latLngBounds([
    [issueLat, issueLng],
    [destLat, destLng]
  ]);

  complaintMapInstance.fitBounds(initialBounds, { padding: [50, 50] });

  complaintRoutingControl = L.Routing.control({
    waypoints: [
      L.latLng(issueLat, issueLng),
      L.latLng(destLat, destLng)
    ],
    router: L.Routing.osrmv1({
      serviceUrl: "https://router.project-osrm.org/route/v1"
    }),
    routeWhileDragging: false,
    addWaypoints: false,
    draggableWaypoints: false,
    fitSelectedRoutes: true,
    showAlternatives: false,
    show: false,
    createMarker: function () {
      return null;
    },
    lineOptions: {
      addWaypoints: false,
      extendToWaypoints: true,
      missingRouteTolerance: 0,
      styles: [
        {
          color: "#2563eb",
          opacity: 0.95,
          weight: 6
        }
      ]
    }
  }).addTo(complaintMapInstance);

  complaintRoutingControl.on("routesfound", function (e) {
    const route = e.routes && e.routes[0];
    if (!route) return;

    const totalDistanceMeters = Math.round(route.summary?.totalDistance || 0);

    if (totalDistanceMeters > 0) {
      selectedBarangayCandidate = {
        ...selectedBarangayCandidate,
        distance_meters: totalDistanceMeters
      };

      updateChosenBarangayUI();
      renderNearbyBarangayList(candidates);
    }

    if (route.coordinates && route.coordinates.length > 0) {
      const routeBounds = L.latLngBounds(
        route.coordinates.map((coord) => [coord.lat, coord.lng])
      );

      complaintMapInstance.fitBounds(routeBounds, { padding: [50, 50] });
    }
  });

  complaintRoutingControl.on("routingerror", function (e) {
    console.error("Routing failed:", e);

    const fallbackBounds = L.latLngBounds([
      [issueLat, issueLng],
      [destLat, destLng]
    ]);

    complaintMapInstance.fitBounds(fallbackBounds, { padding: [50, 50] });

    updateChosenBarangayUI();
    renderNearbyBarangayList(candidates);
  });
}

function enableImagePreview(imgElement) {
  if (!imgElement) return;

  imgElement.onclick = () => {
    if (!imgElement.src) return;

    const existingOverlay = document.getElementById("imagePreviewOverlay");
    const existingImage = document.getElementById("imagePreviewFull");

    if (existingOverlay && existingImage) {
      existingImage.src = imgElement.src;
      existingOverlay.classList.remove("hidden");
      return;
    }

    const modal = document.createElement("div");
    modal.className = "image-preview-modal";
    modal.innerHTML = `<img src="${imgElement.src}" alt="Evidence Preview">`;

    modal.addEventListener("click", () => {
      modal.remove();
    });

    document.body.appendChild(modal);
  };
}

// =========================
// RESOLVED COMPLAINT ROUTE MAP
// =========================

function parseCoordinateValue(value) {
  const num = parseFloat(value);

  if (!Number.isFinite(num) || Number.isNaN(num) || num === 0) {
    return null;
  }

  return num;
}

function getFirstValidCoordinate(record, keys = []) {
  for (const key of keys) {
    if (!record || !(key in record)) continue;

    const coordinate = parseCoordinateValue(record[key]);

    if (coordinate !== null) {
      return coordinate;
    }
  }

  return null;
}

function getResolutionIssuePoint(record) {
  const lat = getFirstValidCoordinate(record, [
    "latitude",
    "complaint_latitude",
    "issue_latitude",
    "issue_lat",
    "complaint_lat"
  ]);

  const lng = getFirstValidCoordinate(record, [
    "longitude",
    "complaint_longitude",
    "issue_longitude",
    "issue_lng",
    "issue_long",
    "complaint_lng",
    "complaint_long"
  ]);

  if (lat === null || lng === null) return null;

  return {
    lat,
    lng,
    label: "Issue Location"
  };
}

function getResolutionStartPoint(record) {
  const actualStartLat = getFirstValidCoordinate(record, [
    "resolver_latitude",
    "resolver_lat",
    "resolved_latitude",
    "resolved_lat",
    "resolution_latitude",
    "resolution_lat",
    "handled_latitude",
    "handled_lat",
    "personnel_latitude",
    "personnel_lat",
    "barangay_personnel_latitude",
    "barangay_personnel_lat",
    "current_latitude",
    "current_lat"
  ]);

  const actualStartLng = getFirstValidCoordinate(record, [
    "resolver_longitude",
    "resolver_lng",
    "resolver_long",
    "resolved_longitude",
    "resolved_lng",
    "resolved_long",
    "resolution_longitude",
    "resolution_lng",
    "resolution_long",
    "handled_longitude",
    "handled_lng",
    "handled_long",
    "personnel_longitude",
    "personnel_lng",
    "personnel_long",
    "barangay_personnel_longitude",
    "barangay_personnel_lng",
    "barangay_personnel_long",
    "current_longitude",
    "current_lng",
    "current_long"
  ]);

  if (actualStartLat !== null && actualStartLng !== null) {
    return {
      lat: actualStartLat,
      lng: actualStartLng,
      type: "actual",
      label: "Barangay Personnel Start"
    };
  }

  const referenceLat = getFirstValidCoordinate(record, [
    "assigned_barangay_lat",
    "assigned_barangay_latitude",
    "assigned_latitude",
    "assigned_lat",
    "barangay_latitude",
    "barangay_lat",
    "reference_latitude",
    "reference_lat",
    "assigned_reference_latitude",
    "assigned_reference_lat"
  ]);

  const referenceLng = getFirstValidCoordinate(record, [
    "assigned_barangay_lng",
    "assigned_barangay_longitude",
    "assigned_barangay_long",
    "assigned_lng",
    "assigned_longitude",
    "assigned_long",
    "barangay_lng",
    "barangay_longitude",
    "barangay_long",
    "reference_lng",
    "reference_longitude",
    "reference_long",
    "assigned_reference_lng",
    "assigned_reference_longitude",
    "assigned_reference_long"
  ]);

  if (referenceLat !== null && referenceLng !== null) {
    return {
      lat: referenceLat,
      lng: referenceLng,
      type: "reference",
      label: "Barangay Reference Start"
    };
  }

  return null;
}

function clearResolutionRouteMapLayers() {
  const state = complaintResolutionRouteState;

  if (!state.map) return;

  if (state.issueMarker) {
    state.map.removeLayer(state.issueMarker);
    state.issueMarker = null;
  }

  if (state.startMarker) {
    state.map.removeLayer(state.startMarker);
    state.startMarker = null;
  }

  if (state.routeLine) {
    state.map.removeLayer(state.routeLine);
    state.routeLine = null;
  }

  if (state.routingControl) {
    try {
      state.map.removeControl(state.routingControl);
    } catch (error) {
      console.warn("Failed removing resolution routing control:", error);
    }

    state.routingControl = null;
  }
}


function destroyResolutionRouteMap(removeCard = false) {
  const state = complaintResolutionRouteState;

  try {
    if (state.routingControl && state.map) {
      state.map.removeControl(state.routingControl);
    }
  } catch (error) {
    console.warn("Failed removing resolution routing control:", error);
  }

  try {
    if (state.map) {
      state.map.off();
      state.map.remove();
    }
  } catch (error) {
    console.warn("Failed destroying resolution route map:", error);
  }

  state.map = null;
  state.issueMarker = null;
  state.startMarker = null;
  state.routeLine = null;
  state.routingControl = null;

  const mapEl = document.getElementById("resolutionRouteMap");
  if (mapEl) {
    mapEl.innerHTML = "";
    mapEl.className = "";
    mapEl.removeAttribute("tabindex");
    mapEl.removeAttribute("aria-label");

    try {
      delete mapEl._leaflet_id;
    } catch (error) {
      console.warn("Failed clearing Leaflet container id:", error);
    }
  }

  if (removeCard) {
    const card = document.getElementById("resolutionRouteMapCard");
    if (card) card.remove();
  }
}

function ensureResolutionRouteMapContainer() {
  const modal = document.getElementById("complaintResolutionModal");
  if (!modal) return null;

  const mainGrid = modal.querySelector(".resolution-main-grid");
  const evidencePanel = modal.querySelector(".resolution-evidence-panel");

  let card = document.getElementById("resolutionRouteMapCard");

  if (!card) {
    card = document.createElement("div");
    card.id = "resolutionRouteMapCard";
    card.className = "resolution-route-map-card";

    card.innerHTML = `
      <div class="resolution-route-map-header">
        <h3>Route Map</h3>
        <p id="resolutionRouteMapNote">
          Loading route preview...
        </p>
      </div>

      <div id="resolutionRouteMap"></div>
    `;
  } else {
    /*
      Keep the existing card/map if already created,
      but remove old inline styles that forced it to behave incorrectly.
    */
    card.removeAttribute("style");

    const header = card.querySelector(".resolution-route-map-header");
    const title = card.querySelector(".resolution-route-map-header h3");
    const note = card.querySelector("#resolutionRouteMapNote");
    const map = card.querySelector("#resolutionRouteMap");

    if (header) header.removeAttribute("style");
    if (title) title.removeAttribute("style");
    if (note) note.removeAttribute("style");
    if (map) map.removeAttribute("style");

    if (!card.querySelector("#resolutionRouteMap")) {
      card.innerHTML = `
        <div class="resolution-route-map-header">
          <h3>Route Map</h3>
          <p id="resolutionRouteMapNote">
            Loading route preview...
          </p>
        </div>

        <div id="resolutionRouteMap"></div>
      `;
    }
  }

  /*
    Correct placement:
    Route Map must be a sibling of .resolution-left-panel and .resolution-evidence-panel,
    not inside the left panel after Coordinates.
  */
  if (mainGrid) {
    if (evidencePanel && evidencePanel.parentElement === mainGrid) {
      mainGrid.insertBefore(card, evidencePanel.nextSibling);
    } else {
      mainGrid.appendChild(card);
    }
  } else {
    const content =
      modal.querySelector(".resolution-pro-body") ||
      modal.querySelector(".complaint-resolution-modal-body") ||
      modal.querySelector(".custom-modal-content") ||
      modal;

    content.appendChild(card);
  }

  return {
    card,
    mapEl: document.getElementById("resolutionRouteMap"),
    noteEl: document.getElementById("resolutionRouteMapNote")
  };
}

function drawResolutionFallbackLine(startPoint, issuePoint) {
  const state = complaintResolutionRouteState;
  if (!state.map) return;

  state.routeLine = L.polyline(
    [
      [startPoint.lat, startPoint.lng],
      [issuePoint.lat, issuePoint.lng]
    ],
    {
      color: "#2563eb",
      weight: 6,
      opacity: 0.9,
      lineCap: "round",
      lineJoin: "round"
    }
  ).addTo(state.map);

  const bounds = L.latLngBounds([
    [startPoint.lat, startPoint.lng],
    [issuePoint.lat, issuePoint.lng]
  ]);

  state.map.fitBounds(bounds, { padding: [45, 45] });
}

function setResolutionMapNote(message) {
  const noteEl = document.getElementById("resolutionRouteMapNote");
  if (noteEl) noteEl.textContent = message;
}

function renderResolvedComplaintRouteMap(record) {
  const container = ensureResolutionRouteMapContainer();

  if (!container || !container.mapEl) return;

  /*
    Leaflet can break when a modal is closed and opened again using the same map container.
    Recreate only this small resolved-route map each time to prevent oversized tiles/overflow.
  */
  destroyResolutionRouteMap(false);

  if (!window.L) {
    setResolutionMapNote("Map library is not loaded. Please refresh the page.");
    return;
  }

  const issuePoint = getResolutionIssuePoint(record);

  if (!issuePoint) {
    setResolutionMapNote("Issue coordinates are not available for this resolved complaint.");
    return;
  }

  const startPoint = getResolutionStartPoint(record);
  const state = complaintResolutionRouteState;

  if (!state.map) {
    state.map = L.map(container.mapEl, {
      zoomControl: true,
      attributionControl: true
    }).setView([issuePoint.lat, issuePoint.lng], 16);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(state.map);
  } else {
    state.map.invalidateSize();
  }

  clearResolutionRouteMapLayers();

  state.issueMarker = L.marker([issuePoint.lat, issuePoint.lng], {
    icon: issueRedIcon
  }).addTo(state.map);

  state.issueMarker.bindPopup(`
    <div>
      <strong>Issue Location</strong><br>
      ${escapeHtml(record?.subject || "Resolved complaint")}<br>
      Coordinates: ${escapeHtml(String(issuePoint.lat))}, ${escapeHtml(String(issuePoint.lng))}
    </div>
  `);

  if (!startPoint) {
    state.map.setView([issuePoint.lat, issuePoint.lng], 17);
    state.issueMarker.openPopup();
    setResolutionMapNote(
      "Only the issue location is available. Starting point is not included in this resolved complaint record yet."
    );
    return;
  }

  const startIcon = startPoint.type === "actual" ? personnelGreenIcon : barangayBlueIcon;

  state.startMarker = L.marker([startPoint.lat, startPoint.lng], {
    icon: startIcon
  }).addTo(state.map);

  const startLabel =
    startPoint.type === "actual"
      ? "Barangay Personnel Start"
      : "Assigned Barangay Reference";

  state.startMarker.bindPopup(`
    <div>
      <strong>${escapeHtml(startLabel)}</strong><br>
      ${escapeHtml(record?.handled_by_barangay_name || record?.assigned_barangay || "-")}<br>
      Coordinates: ${escapeHtml(String(startPoint.lat))}, ${escapeHtml(String(startPoint.lng))}
    </div>
  `);

  const straightDistance = calculateDistanceMetersLocal(
    startPoint.lat,
    startPoint.lng,
    issuePoint.lat,
    issuePoint.lng
  );

  const notePrefix =
    startPoint.type === "actual"
      ? "Route from barangay personnel GPS location to the issue location."
      : "Route from assigned barangay reference point to the issue location.";

  setResolutionMapNote(`${notePrefix} Straight distance: ${formatDistanceText(straightDistance)}.`);

  if (!window.L.Routing) {
    drawResolutionFallbackLine(startPoint, issuePoint);
    return;
  }

  state.routingControl = L.Routing.control({
    waypoints: [
      L.latLng(startPoint.lat, startPoint.lng),
      L.latLng(issuePoint.lat, issuePoint.lng)
    ],
    router: L.Routing.osrmv1({
      serviceUrl: "https://router.project-osrm.org/route/v1"
    }),
    routeWhileDragging: false,
    addWaypoints: false,
    draggableWaypoints: false,
    fitSelectedRoutes: true,
    showAlternatives: false,
    show: false,
    createMarker: function () {
      return null;
    },
    lineOptions: {
      addWaypoints: false,
      extendToWaypoints: true,
      missingRouteTolerance: 0,
      styles: [
        {
          color: "#2563eb",
          opacity: 0.95,
          weight: 6
        }
      ]
    }
  }).addTo(state.map);

  state.routingControl.on("routesfound", function (event) {
    const route = event.routes && event.routes[0];

    if (!route) return;

    const routeDistance = Math.round(route.summary?.totalDistance || 0);
    const routeDistanceText = formatDistanceText(routeDistance);

    setResolutionMapNote(`${notePrefix} Route distance: ${routeDistanceText}.`);

    if (route.bounds) {
      state.map.fitBounds(route.bounds, { padding: [45, 45] });
    }
  });

  state.routingControl.on("routingerror", function (error) {
    console.warn("Resolved complaint route failed, drawing fallback line:", error);

    if (state.routingControl) {
      try {
        state.map.removeControl(state.routingControl);
      } catch (removeError) {
        console.warn("Failed removing failed routing control:", removeError);
      }

      state.routingControl = null;
    }

    drawResolutionFallbackLine(startPoint, issuePoint);
    setResolutionMapNote(
      `${notePrefix} Route service failed, so a direct line is shown. Straight distance: ${formatDistanceText(straightDistance)}.`
    );
  });

  setTimeout(() => {
    state.map.invalidateSize();
  }, 180);
}

// =========================
// COMPLAINT SUMMARY + LOAD
// =========================

function updateComplaintSummary(complaints = []) {
  const safeComplaints = Array.isArray(complaints) ? complaints : [];

  const total = safeComplaints.length;
  const pending = safeComplaints.filter(item =>
    String(item.status || "").toLowerCase() === "pending"
  ).length;
  const resolved = safeComplaints.filter(item =>
    String(item.status || "").toLowerCase() === "resolved"
  ).length;

  const totalEl = document.getElementById("complaintsTotalCount");
  const pendingEl = document.getElementById("complaintsPendingCount");
  const resolvedEl = document.getElementById("complaintsResolvedCount");
  const validatedEl = document.getElementById("complaintsValidatedCount");
  const forwardedEl = document.getElementById("complaintsForwardedCount");

  if (totalEl) totalEl.textContent = total;
  if (pendingEl) pendingEl.textContent = pending;
  if (resolvedEl) resolvedEl.textContent = resolved;

  if (validatedEl) {
    validatedEl.textContent = safeComplaints.filter(item =>
      String(item.status || "").toLowerCase() === "validated"
    ).length;
  }

  if (forwardedEl) {
    forwardedEl.textContent = safeComplaints.filter(item =>
      ["forwarded", "in_progress"].includes(String(item.status || "").toLowerCase())
    ).length;
  }
}

async function loadComplaints() {
  const tableBody = document.getElementById("complaintsTableBody");
  if (!tableBody) return;

  tableBody.innerHTML = `
    <tr>
      <td colspan="6" class="loading-state">Loading complaints...</td>
    </tr>
  `;

  try {
    const response = await fetch(getComplaintsApiUrl(), {
      method: "GET",
      headers: {
        "Accept": "application/json"
      }
    });

    const rawText = await response.text();
    let data = {};

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch (parseError) {
      console.error("Complaints raw response:", rawText);
      throw new Error("Complaints API did not return valid JSON.");
    }

    if (!response.ok || data.success === false) {
      throw new Error(data.message || "Failed to load complaints.");
    }

    allComplaints = Array.isArray(data.complaints)
      ? data.complaints
      : Array.isArray(data.data)
      ? data.data
      : Array.isArray(data)
      ? data
      : [];

    updateComplaintSummary(allComplaints);

    const activeComplaints = allComplaints.filter((item) => {
      const status = String(item.status || "").toLowerCase();
      return ["pending", "validated", "forwarded", "in_progress", "rejected"].includes(status);
    });

    renderComplaintsTable(activeComplaints);
  } catch (error) {
    console.error("loadComplaints error:", error);

    allComplaints = [];
    updateComplaintSummary([]);

    tableBody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-state-cell">
          Failed to load complaints.
        </td>
      </tr>
    `;
  }
}

// =========================
// COMPLAINT TABLE
// =========================

function getFilteredComplaints() {
  const searchValue = (document.getElementById("complaintsSearchInput")?.value || "")
    .trim()
    .toLowerCase();

  const statusValue = (document.getElementById("complaintsStatusFilter")?.value || "all")
    .trim()
    .toLowerCase();

  const activeComplaints = allComplaints.filter((item) => {
    const status = String(item.status || "").toLowerCase();
    return ["pending", "validated", "forwarded", "in_progress", "rejected"].includes(status);
  });

  return activeComplaints.filter((item) => {
    const status = String(item.status || "").toLowerCase();

    const haystack = [
      item.subject,
      item.description,
      item.citizen_name,
      item.username,
      item.assigned_barangay,
      status,
      item.created_at
    ].map(value => String(value || "").toLowerCase()).join(" ");

    const matchesSearch = !searchValue || haystack.includes(searchValue);
    const matchesStatus = statusValue === "all" || status === statusValue;

    return matchesSearch && matchesStatus;
  });
}

function applyComplaintFilters() {
  renderComplaintsTable(getFilteredComplaints());
}

function renderComplaintsTable(complaints) {
  const tableBody = document.getElementById("complaintsTableBody");
  if (!tableBody) return;

  const safeComplaints = Array.isArray(complaints) ? complaints : [];

  const activeComplaints = safeComplaints.filter((item) => {
    const status = String(item.status || "").toLowerCase();
    return ["pending", "validated", "forwarded", "in_progress", "rejected"].includes(status);
  });

  if (!activeComplaints.length) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-state-cell">
          No active complaints found.
        </td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = activeComplaints.map(item => {
    const subject = escapeHtml(item.subject || "No Subject");
    const descriptionRaw = item.description || "";
    const description = escapeHtml(truncateText(descriptionRaw, 60));
    const citizen = escapeHtml(item.citizen_name || item.username || "-");
    const barangay = escapeHtml(item.assigned_barangay || "For Verification");
    const status = String(item.status || "").toLowerCase();

    return `
      <tr class="complaint-row complaint-${escapeHtml(status)}">

        <td>
          <span class="complaint-subject-main">${subject}</span>
        </td>

        <td class="complaint-description-cell" title="${escapeHtml(descriptionRaw)}">
          ${description || "-"}
        </td>

        <td class="complaint-citizen">
          ${citizen}
        </td>

        <td>
          <span class="barangay-badge">${barangay}</span>
        </td>

        <td>
          ${getComplaintStatusBadge(status)}
        </td>

        <td class="complaint-date">
          ${formatDate(item.created_at)}
        </td>

        <td>
          <button class="complaint-action-btn" data-id="${escapeHtml(item.id)}">
            View
          </button>
        </td>

      </tr>
    `;
  }).join("");

  bindComplaintButtons();
}

function bindComplaintButtons() {
  document.querySelectorAll(".complaint-action-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const complaint = allComplaints.find(c => String(c.id) === String(id));

      if (complaint) {
        openComplaintModal(complaint);
      }
    });
  });
}

// =========================
// COMPLAINT MODAL PORTAL FIX
// =========================

const COMPLAINT_PORTAL_MODAL_IDS = [
  "complaintDetailsModal",
  "complaintResolutionModal",
  "complaintMapModal",
  "complaintHistoryModal"
];

function mountComplaintModalsToBody() {
  COMPLAINT_PORTAL_MODAL_IDS.forEach((modalId) => {
    const modal = document.getElementById(modalId);

    if (!modal) return;

    if (modal.parentElement !== document.body) {
      document.body.appendChild(modal);
    }
  });
}

function applyComplaintModalPosition(modalId) {
  try {
    const modal = document.getElementById(modalId);
    if (!modal) return;

    const isMobile = window.matchMedia("(max-width: 992px)").matches;

    const overlay =
      modal.querySelector(".custom-modal-overlay") ||
      modal.querySelector(".history-modal-overlay");

    const content =
      modal.querySelector(".custom-modal-content") ||
      modal.querySelector(".history-modal-content");

    modal.style.setProperty("position", "fixed", "important");
    modal.style.setProperty("inset", "0", "important");
    modal.style.setProperty("top", "0", "important");
    modal.style.setProperty("right", "0", "important");
    modal.style.setProperty("bottom", "0", "important");
    modal.style.setProperty("left", "0", "important");
    modal.style.setProperty("width", "100vw", "important");
    modal.style.setProperty("height", "100vh", "important");
    modal.style.setProperty("height", "100dvh", "important");
    modal.style.setProperty("margin", "0", "important");
    modal.style.setProperty("display", "flex", "important");
    modal.style.setProperty("align-items", isMobile ? "flex-start" : "center", "important");
    modal.style.setProperty("justify-content", "center", "important");
    modal.style.setProperty("z-index", "2147483600", "important");
    modal.style.setProperty("overflow", "hidden", "important");
    modal.style.setProperty("padding", isMobile ? "12px" : "24px", "important");
    modal.style.setProperty("box-sizing", "border-box", "important");

    if (overlay) {
      overlay.style.setProperty("position", "fixed", "important");
      overlay.style.setProperty("inset", "0", "important");
      overlay.style.setProperty("top", "0", "important");
      overlay.style.setProperty("right", "0", "important");
      overlay.style.setProperty("bottom", "0", "important");
      overlay.style.setProperty("left", "0", "important");
      overlay.style.setProperty("width", "100vw", "important");
      overlay.style.setProperty("height", "100vh", "important");
      overlay.style.setProperty("height", "100dvh", "important");
      overlay.style.setProperty("z-index", "1", "important");
    }

    if (content) {
      content.style.setProperty("position", "relative", "important");
      content.style.setProperty("top", "auto", "important");
      content.style.setProperty("left", "auto", "important");
      content.style.setProperty("right", "auto", "important");
      content.style.setProperty("bottom", "auto", "important");
      content.style.setProperty("transform", "none", "important");
      content.style.setProperty("z-index", "2", "important");
      content.style.setProperty("overflow", "auto", "important");
      content.style.setProperty("margin", "0 auto", "important");

      if (isMobile) {
        content.style.setProperty("width", "calc(100vw - 24px)", "important");
        content.style.setProperty("max-width", "calc(100vw - 24px)", "important");
        content.style.setProperty("max-height", "calc(100dvh - 24px)", "important");
      } else {
        if (modalId === "complaintHistoryModal") {
          content.style.setProperty("width", "min(1180px, calc(100vw - 48px))", "important");
          content.style.setProperty("max-width", "1180px", "important");
        } else {
          content.style.setProperty("width", "min(1220px, calc(100vw - 48px))", "important");
          content.style.setProperty("max-width", "1220px", "important");
        }

        content.style.setProperty("max-height", "calc(100dvh - 48px)", "important");
      }
    }
  } catch (error) {
    console.warn("Complaint modal positioning skipped:", error);
  }
}

function openComplaintModalWithPosition(modalId) {
  mountComplaintModalsToBody();

  const modal = document.getElementById(modalId);
  if (!modal) return;

  modal.classList.remove("hidden");

  requestAnimationFrame(() => {
    applyComplaintModalPosition(modalId);
  });
}

function resetComplaintModalDisplay(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;

  modal.classList.add("hidden");
  modal.style.removeProperty("display");
}

window.addEventListener("resize", () => {
  COMPLAINT_PORTAL_MODAL_IDS.forEach((modalId) => {
    const modal = document.getElementById(modalId);
    if (modal && !modal.classList.contains("hidden")) {
      applyComplaintModalPosition(modalId);

      if (modalId === "complaintResolutionModal" && complaintResolutionRouteState.map) {
        setTimeout(() => {
          complaintResolutionRouteState.map.invalidateSize();
        }, 120);
      }
    }
  });
});

// =========================
// COMPLAINT DETAILS MODAL
// =========================

function formatComplaintStatusLabel(status) {
  const normalized = String(status || "pending").trim().toLowerCase();

  const labels = {
    pending: "Pending",
    validated: "Validated",
    forwarded: "Forwarded",
    in_progress: "In Progress",
    resolved: "Resolved",
    rejected: "Rejected"
  };

  return labels[normalized] || (status || "Pending");
}

function setComplaintDetailsStatusUI(status) {
  const statusEl = document.getElementById("complaintModalStatus");
  if (!statusEl) return;

  const normalized = String(status || "pending").trim().toLowerCase();
  statusEl.textContent = formatComplaintStatusLabel(normalized);

  statusEl.className = "complaint-details-status-pill";
  statusEl.classList.add(normalized.replaceAll("_", "-"));
}

function updateManualBarangayVisibility(complaint) {
  const container = document.getElementById("manualBarangayContainer");
  const select = document.getElementById("manualBarangaySelect");

  if (!container) return;

  const assignedBarangay = String(complaint?.assigned_barangay || "").trim();
  const needsManualSelection =
    !assignedBarangay || assignedBarangay.toLowerCase() === "for verification";

  container.style.display = needsManualSelection ? "block" : "none";

  if (select && !needsManualSelection) {
    select.value = "";
  }
}

function closeImagePreviewOverlay() {
  const overlay = document.getElementById("imagePreviewOverlay");
  const image = document.getElementById("imagePreviewFull");

  if (image) image.removeAttribute("src");
  overlay?.classList.add("hidden");
}

async function requestComplaintReviewFromDetails() {
  if (!currentComplaint) {
    alert("No complaint selected.");
    return;
  }

  await openComplaintMapModal();
}

async function validateComplaintFromDetails() {
  if (!currentComplaint || !currentComplaint.id) {
    alert("No complaint selected.");
    return;
  }

  const assignedBarangay = String(currentComplaint.assigned_barangay || "").trim();
  const needsManualSelection =
    !assignedBarangay || assignedBarangay.toLowerCase() === "for verification";

  if (needsManualSelection && !selectedBarangayCandidate) {
    const proceedToMap = confirm(
      "This complaint needs barangay verification before validation. Open the map now?"
    );

    if (proceedToMap) {
      await openComplaintMapModal();
    }

    return;
  }

  await validateAndForwardComplaint();
}

function openComplaintModal(data) {
  mountComplaintModalsToBody();

  currentComplaint = data;
  selectedBarangayCandidate = null;

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  setText("complaintModalSubject", data.subject || "-");
  setText("complaintModalDescription", data.description || "-");
  setText("complaintModalCitizenName", data.citizen_name || "-");
  setText("complaintModalUsername", data.username || "-");
  setText("complaintModalBarangay", data.assigned_barangay || "-");
  setComplaintDetailsStatusUI(data.status || "pending");
  setText("complaintModalCreatedAt", formatModalDateTime(data.created_at));

  const lat = data.latitude ?? "-";
  const lng = data.longitude ?? "-";
  setText("complaintModalCoordinates", `${lat}, ${lng}`);

  updateManualBarangayVisibility(data);

  const imageEl = document.getElementById("complaintModalImage");
  const skeletonEl = document.getElementById("complaintImageSkeleton");
  const noImageText = document.getElementById("noImageText");

  if (imageEl) {
    const rawPath = data.image_url || data.evidence_url || data.photo_url;
    const imageUrl = getImageUrl(rawPath);

    imageEl.onload = null;
    imageEl.onerror = null;
    imageEl.onclick = null;

    imageEl.style.display = "none";
    imageEl.removeAttribute("src");

    if (skeletonEl) skeletonEl.style.display = "block";
    if (noImageText) noImageText.style.display = "none";

    imageEl.onload = () => {
      if (skeletonEl) skeletonEl.style.display = "none";
      if (noImageText) noImageText.style.display = "none";
      imageEl.style.display = "block";
      enableImagePreview(imageEl);
    };

    imageEl.onerror = () => {
      if (skeletonEl) skeletonEl.style.display = "none";
      imageEl.style.display = "none";
      if (noImageText) noImageText.style.display = "flex";
    };

    if (imageUrl) {
      imageEl.src = `${imageUrl}?t=${Date.now()}`;
    } else {
      if (skeletonEl) skeletonEl.style.display = "none";
      if (noImageText) noImageText.style.display = "flex";
    }
  }

  openComplaintModalWithPosition("complaintDetailsModal");
}

function closeComplaintModal() {
  resetComplaintModalDisplay("complaintDetailsModal");
}

function closeComplaintMapModal() {
  resetComplaintModalDisplay("complaintMapModal");
}

// =========================
// COMPLAINT MAP MODAL
// =========================

async function openComplaintMapModal() {
  mountComplaintModalsToBody();

  if (!currentComplaint) {
    alert("No complaint selected.");
    return;
  }

  const lat = parseFloat(currentComplaint.latitude);
  const lng = parseFloat(currentComplaint.longitude);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    alert("Invalid complaint coordinates.");
    return;
  }

  selectedBarangayCandidate = null;
  updateChosenBarangayUI();

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  setText("complaintMapSubject", currentComplaint.subject || "-");
  setText("complaintMapBarangay", currentComplaint.assigned_barangay || "-");
  setText("complaintMapCoordinates", `${lat}, ${lng}`);

  const nearbyListEl = document.getElementById("nearbyBarangayList");
  if (nearbyListEl) {
    nearbyListEl.innerHTML = `<div class="nearby-empty">Loading nearby barangays...</div>`;
  }

  openComplaintModalWithPosition("complaintMapModal");

  setTimeout(async () => {
    try {
      if (!complaintMapInstance) {
        complaintMapInstance = L.map("complaintLeafletMap").setView([lat, lng], 15);

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "&copy; OpenStreetMap contributors"
        }).addTo(complaintMapInstance);
      } else {
        complaintMapInstance.invalidateSize();
        complaintMapInstance.setView([lat, lng], 15);
      }

      clearComplaintMapLayers();

      complaintMapMarker = L.marker([lat, lng], { icon: issueRedIcon })
        .addTo(complaintMapInstance);

      complaintMapMarker.bindPopup(`
        <div>
          <strong>${escapeHtml(currentComplaint.subject || "Complaint Issue")}</strong><br>
          Citizen: ${escapeHtml(currentComplaint.citizen_name || currentComplaint.username || "-")}<br>
          Barangay: ${escapeHtml(currentComplaint.assigned_barangay || "-")}<br>
          Coordinates: ${escapeHtml(String(lat))}, ${escapeHtml(String(lng))}
        </div>
      `).openPopup();

      const candidates = await loadNearbyBarangaysForComplaint(lat, lng);

      if (!Array.isArray(candidates) || candidates.length === 0) {
        if (nearbyListEl) {
          nearbyListEl.innerHTML = `<div class="nearby-empty">No nearby barangays found.</div>`;
        }
        return;
      }

      complaintNearbyMarkers = candidates.map((candidate) => {
        const markerLat = parseFloat(candidate.latitude);
        const markerLng = parseFloat(candidate.longitude);

        if (Number.isNaN(markerLat) || Number.isNaN(markerLng)) {
          return null;
        }

        const marker = L.marker(
          [markerLat, markerLng],
          { icon: barangayBlueIcon }
        ).addTo(complaintMapInstance);

        const popupDistance =
          Number(candidate.distance_meters) > 0
            ? `${candidate.distance_meters} meters away`
            : "Distance unavailable";

        marker.bindPopup(`
          <div>
            <strong>${escapeHtml(candidate.barangay_name || "-")}</strong><br>
            ${escapeHtml(candidate.reference_name || "-")}<br>
            ${escapeHtml(popupDistance)}
          </div>
        `);

        marker.on("click", () => {
          complaintMapInstance.flyTo([markerLat, markerLng], 16, {
            duration: 0.8
          });

          selectBarangayCandidate(candidate, candidates);
          marker.openPopup();
        });

        return marker;
      }).filter(Boolean);

      renderNearbyBarangayList(candidates);

      const nearestCandidate = candidates[0];

      if (nearestCandidate) {
        selectBarangayCandidate(nearestCandidate, candidates);
      } else {
        updateChosenBarangayUI();
      }

      const boundsPoints = [
        [lat, lng],
        ...candidates
          .map((candidate) => [
            parseFloat(candidate.latitude),
            parseFloat(candidate.longitude)
          ])
          .filter(([cLat, cLng]) => !Number.isNaN(cLat) && !Number.isNaN(cLng))
      ];

      if (boundsPoints.length > 1) {
        const bounds = L.latLngBounds(boundsPoints);
        complaintMapInstance.fitBounds(bounds, { padding: [40, 40] });
      } else {
        complaintMapInstance.setView([lat, lng], 15);
      }
    } catch (error) {
      console.error("Error opening complaint map modal:", error);

      if (nearbyListEl) {
        nearbyListEl.innerHTML = `
          <div class="nearby-empty">${escapeHtml(error.message || "Failed to load nearby barangays.")}</div>
        `;
      }
    }
  }, 150);
}

async function loadNearbyBarangaysForComplaint(lat, lng) {
  try {
    const response = await fetch(
      `${getComplaintsApiUrl()}/nearby-barangays?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}`,
      {
        headers: {
          "Accept": "application/json"
        }
      }
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.message || "Failed to load nearby barangays.");
    }

    const rawCandidates = Array.isArray(data.candidates) ? data.candidates : [];

    const normalizedCandidates = rawCandidates.map((candidate) => {
      const refLat = parseFloat(candidate.latitude);
      const refLng = parseFloat(candidate.longitude);

      let distanceMeters = Number(candidate.distance_meters) || 0;

      if (
        distanceMeters <= 0 &&
        !Number.isNaN(refLat) &&
        !Number.isNaN(refLng)
      ) {
        distanceMeters = calculateDistanceMetersLocal(lat, lng, refLat, refLng);
      }

      return {
        ...candidate,
        distance_meters: distanceMeters
      };
    });

    normalizedCandidates.sort((a, b) => a.distance_meters - b.distance_meters);

    return normalizedCandidates;
  } catch (error) {
    console.error("Nearby barangay error:", error);
    return [];
  }
}

// =========================
// COMPLAINT VALIDATION
// =========================

async function validateComplaint() {
  if (!currentComplaint) return;

  if (!confirm("Validate and forward this complaint?")) return;

  try {
    const res = await fetch(
      `${getComplaintsApiUrl()}/${currentComplaint.id}/validate`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          validated_by: currentUser?.id || null
        })
      }
    );

    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.message || "Failed to validate complaint.");
    }

    alert("Complaint forwarded successfully.");
    resetComplaintModalDisplay("complaintDetailsModal");
    await loadComplaints();
  } catch (err) {
    console.error("validateComplaint error:", err);
    alert(err.message || "Error validating complaint.");
  }
}

async function validateAndForwardComplaint() {
  if (!currentComplaint || !currentComplaint.id) {
    alert("No complaint selected.");
    return;
  }

  const assignedBarangay = String(currentComplaint.assigned_barangay || "").trim();
  const needsManualSelection =
    !assignedBarangay || assignedBarangay === "For Verification";

  if (needsManualSelection && !selectedBarangayCandidate) {
    alert("Please choose a barangay from the map first.");
    return;
  }

  try {
    const response = await fetch(
      `${getComplaintsApiUrl()}/${currentComplaint.id}/validate-forward`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          selected_barangay: selectedBarangayCandidate
            ? selectedBarangayCandidate.barangay_name
            : null
        })
      }
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.message || "Failed to validate complaint.");
    }

    alert(data.message || "Complaint validated and forwarded.");

    resetComplaintModalDisplay("complaintMapModal");
    resetComplaintModalDisplay("complaintDetailsModal");

    selectedBarangayCandidate = null;

    await loadComplaints();
  } catch (error) {
    console.error("Validate complaint error:", error);
    alert(error.message || "Failed to validate complaint.");
  }
}

// =========================
// COMPLAINT HISTORY
// =========================

function formatComplaintHistoryStatus(status) {
  const normalized = String(status || "").toLowerCase().trim();

  if (normalized === "forwarded") return "Forwarded";
  if (normalized === "accepted_by_barangay") return "Accepted";
  if (normalized === "in_progress") return "In Progress";
  if (normalized === "resolved") return "Resolved";

  return status || "-";
}

async function loadComplaintHistory() {
  const tbody = document.getElementById("complaintHistoryTableBody");
  if (!tbody) return;

  tbody.innerHTML = `
    <tr>
      <td colspan="6" class="loading-state">Loading complaint history...</td>
    </tr>
  `;

  try {
    const response = await fetch(`${getComplaintsApiUrl()}/history/resolved`);
    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.message || "Failed to load complaint history.");
    }

    complaintHistoryRecords = Array.isArray(data.complaints) ? data.complaints : [];
    renderComplaintHistoryTable(complaintHistoryRecords);
  } catch (error) {
    console.error("loadComplaintHistory error:", error);

    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-state-cell">Failed to load complaint history.</td>
      </tr>
    `;
  }
}

function renderComplaintHistoryTable(records) {
  const tbody = document.getElementById("complaintHistoryTableBody");
  if (!tbody) return;

  const safeRecords = Array.isArray(records) ? records : [];

  if (!safeRecords.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-state-cell">No complaint history found.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = safeRecords.map(item => `
    <tr>
      <td>${escapeHtml(item.subject || "-")}</td>
      <td>${escapeHtml(item.citizen_name || item.username || "-")}</td>
      <td>${escapeHtml(item.assigned_barangay || "-")}</td>
      <td>
        <span class="complaint-history-status resolved">
          ${escapeHtml(formatComplaintHistoryStatus(item.status))}
        </span>
      </td>
      <td>${escapeHtml(formatDateTimeDisplay(item.resolved_at || item.created_at))}</td>
      <td>
        <button
          type="button"
          class="complaint-history-view-btn"
          data-resolution-id="${escapeHtml(item.id)}"
        >
          View
        </button>
      </td>
    </tr>
  `).join("");
}

function openComplaintHistoryModal() {
  mountComplaintModalsToBody();

  openComplaintModalWithPosition("complaintHistoryModal");
  loadComplaintHistory();
}

function closeComplaintHistoryModal() {
  resetComplaintModalDisplay("complaintHistoryModal");
}

// =========================
// COMPLAINT RESOLUTION MODAL
// =========================

function getValidResolutionImagePath(record) {
  const candidates = [
    record?.resolution_evidence_url,
    record?.image_url,
    record?.evidence_url,
    record?.photo_url
  ];

  return candidates.find((path) => {
    if (!path) return false;

    const value = String(path).trim().toLowerCase();

    if (!value || value === "null" || value === "undefined") return false;

    if (
      value === "/uploads/complaints" ||
      value === "uploads/complaints" ||
      value.endsWith("/uploads/complaints/")
    ) {
      return false;
    }

    return true;
  }) || "";
}

function renderResolutionEvidenceImage(record) {
  const evidenceImg = document.getElementById("resolutionModalEvidenceImage");
  const noEvidence = document.getElementById("resolutionModalNoEvidence");
  const evidenceFrame = document.getElementById("resolutionEvidenceFrame");

  if (!evidenceImg) return;

  const rawImage = getValidResolutionImagePath(record);
  const evidenceUrl = getImageUrl(rawImage);

  console.log("CURRENT RESOLUTION DATA:", record);
  console.log("RAW IMAGE PATH:", rawImage);
  console.log("FINAL IMAGE URL:", evidenceUrl);

  evidenceImg.onload = null;
  evidenceImg.onerror = null;
  evidenceImg.onclick = null;
  evidenceImg.removeAttribute("src");
  evidenceImg.classList.add("hidden");
  evidenceImg.style.display = "none";

  if (evidenceFrame) evidenceFrame.style.display = "none";

  if (noEvidence) {
    noEvidence.textContent = "Loading evidence image...";
    noEvidence.classList.remove("hidden");
  }

  if (!evidenceUrl) {
    if (noEvidence) noEvidence.textContent = "No evidence image submitted.";
    return;
  }

  evidenceImg.onload = () => {
    evidenceImg.classList.remove("hidden");
    evidenceImg.style.display = "block";

    if (evidenceFrame) evidenceFrame.style.display = "flex";
    if (noEvidence) noEvidence.classList.add("hidden");

    if (typeof enableImagePreview === "function") {
      enableImagePreview(evidenceImg);
    }
  };

  evidenceImg.onerror = () => {
    console.error("Image failed to load:", evidenceUrl);

    evidenceImg.removeAttribute("src");
    evidenceImg.classList.add("hidden");
    evidenceImg.style.display = "none";

    if (evidenceFrame) evidenceFrame.style.display = "none";

    if (noEvidence) {
      noEvidence.textContent = "Image failed to load.";
      noEvidence.classList.remove("hidden");
    }
  };

  evidenceImg.src = evidenceUrl;
}

function openComplaintResolutionModal(complaintId) {
  mountComplaintModalsToBody();

  document.getElementById("complaintHistoryModal")?.classList.add("hidden");

  const modal = document.getElementById("complaintResolutionModal");
  if (!modal) return;

  currentComplaintResolution = complaintHistoryRecords.find(
    item => Number(item.id) === Number(complaintId)
  );

  if (!currentComplaintResolution) {
    console.error("Complaint not found:", complaintId);
    return;
  }

  const setText = (id, value, fallback = "-") => {
    const el = document.getElementById(id);
    if (el) el.textContent = cleanText(value, fallback);
  };

  setText("resolutionModalSubject", currentComplaintResolution.subject);
  setText("resolutionModalAssignedBarangay", currentComplaintResolution.assigned_barangay);
  setText("resolutionModalReporterBarangay", currentComplaintResolution.reporter_barangay);
  setText("resolutionModalHandledBy", currentComplaintResolution.handled_by_barangay_name);
  setText("resolutionModalStatus", "Resolved");
  setText("resolutionModalResolvedAt", formatDateTimeDisplay(currentComplaintResolution.resolved_at));
  setText("resolutionModalDescription", currentComplaintResolution.description, "No description provided.");
  setText("resolutionModalReport", currentComplaintResolution.resolution_report, "No resolution report provided.");

  setText(
    "resolutionModalCoordinates",
    `${cleanText(currentComplaintResolution.latitude, "-")}, ${cleanText(currentComplaintResolution.longitude, "-")}`
  );

  renderResolutionEvidenceImage(currentComplaintResolution);

  openComplaintModalWithPosition("complaintResolutionModal");

  const body =
    modal.querySelector(".resolution-pro-body") ||
    modal.querySelector(".complaint-resolution-modal-body") ||
    modal.querySelector(".custom-modal-content");

  if (body) body.scrollTop = 0;

  setTimeout(() => {
    renderResolvedComplaintRouteMap(currentComplaintResolution);
  }, 250);
}

function closeComplaintResolutionModal() {
  const modal = document.getElementById("complaintResolutionModal");
  if (!modal) return;

  destroyResolutionRouteMap(true);
  resetComplaintModalDisplay("complaintResolutionModal");
  currentComplaintResolution = null;
}

function setupComplaintResolutionModal() {
  const tbody = document.getElementById("complaintHistoryTableBody");
  const closeBtn = document.getElementById("closeComplaintResolutionModal");
  const overlay = document.getElementById("complaintResolutionOverlay");

  if (tbody && tbody.dataset.bound !== "true") {
    tbody.dataset.bound = "true";

    tbody.addEventListener("click", (event) => {
      const viewBtn = event.target.closest("[data-resolution-id]");
      if (!viewBtn) return;

      openComplaintResolutionModal(viewBtn.getAttribute("data-resolution-id"));
    });
  }

  closeBtn?.addEventListener("click", closeComplaintResolutionModal);
  overlay?.addEventListener("click", closeComplaintResolutionModal);
}

// =========================
// COMPLAINT MODULE SETUP
// =========================

function setupComplaintsModule() {
  mountComplaintModalsToBody();
  setupComplaintResolutionModal();

  document.getElementById("btnRefreshComplaints")
    ?.addEventListener("click", loadComplaints);

  document.getElementById("btnOpenComplaintMap")
    ?.addEventListener("click", openComplaintMapModal);

  document.getElementById("btnValidateForwardComplaint")
    ?.addEventListener("click", validateAndForwardComplaint);

  const detailsValidateBtn = document.getElementById("btnValidateComplaintFromDetails");
  if (detailsValidateBtn) {
    detailsValidateBtn.removeAttribute("onclick");
    detailsValidateBtn.addEventListener("click", validateComplaintFromDetails);
  }

  document.getElementById("btnRequestComplaintReview")
    ?.addEventListener("click", requestComplaintReviewFromDetails);

  document.getElementById("btnCloseComplaintModalFooter")
    ?.addEventListener("click", closeComplaintModal);

  document.getElementById("closeComplaintDetailsModal")
    ?.addEventListener("click", closeComplaintModal);

  document.getElementById("complaintDetailsOverlay")
    ?.addEventListener("click", closeComplaintModal);

  document.getElementById("closeComplaintMapModal")
    ?.addEventListener("click", closeComplaintMapModal);

  document.getElementById("complaintMapOverlay")
    ?.addEventListener("click", closeComplaintMapModal);

  document.getElementById("btnOpenComplaintHistory")
    ?.addEventListener("click", openComplaintHistoryModal);

  document.getElementById("closeComplaintHistoryBtn")
    ?.addEventListener("click", closeComplaintHistoryModal);

  document.getElementById("complaintHistoryOverlay")
    ?.addEventListener("click", closeComplaintHistoryModal);

  document.getElementById("complaintsSearchInput")
    ?.addEventListener("input", applyComplaintFilters);

  document.getElementById("complaintsStatusFilter")
    ?.addEventListener("change", applyComplaintFilters);

  document.getElementById("closeImagePreviewBtn")
    ?.addEventListener("click", closeImagePreviewOverlay);

  document.getElementById("imagePreviewOverlay")
    ?.addEventListener("click", (event) => {
      if (event.target?.id === "imagePreviewOverlay") {
        closeImagePreviewOverlay();
      }
    });
} 
