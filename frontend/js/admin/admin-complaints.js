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
  barangayMarker: null,
  routeLine: null,
  routingControl: null,

  fullMap: null,
  fullIssueMarker: null,
  fullStartMarker: null,
  fullBarangayMarker: null,
  fullRouteLine: null,
  fullRoutingControl: null,

  lastRecord: null
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
    type: "issue",
    label: "End: Issue Location"
  };
}

function getResolutionActualStartPoint(record) {
  /*
    IMPORTANT:
    This must use the barangay personnel GPS/start coordinate only.
    Do NOT use assigned_barangay_lat/lng here because that is usually the barangay/reference location,
    not the actual start location of the personnel route.
  */
  const lat = getFirstValidCoordinate(record, [
    "start_latitude",
    "start_lat",
    "route_start_latitude",
    "route_start_lat",
    "personnel_start_latitude",
    "personnel_start_lat",
    "barangay_personnel_start_latitude",
    "barangay_personnel_start_lat",
    "gps_start_latitude",
    "gps_start_lat",
    "origin_latitude",
    "origin_lat",
    "from_latitude",
    "from_lat",
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
    "current_lat",
    "gps_latitude",
    "gps_lat"
  ]);

  const lng = getFirstValidCoordinate(record, [
    "start_longitude",
    "start_lng",
    "start_long",
    "route_start_longitude",
    "route_start_lng",
    "route_start_long",
    "personnel_start_longitude",
    "personnel_start_lng",
    "personnel_start_long",
    "barangay_personnel_start_longitude",
    "barangay_personnel_start_lng",
    "barangay_personnel_start_long",
    "gps_start_longitude",
    "gps_start_lng",
    "gps_start_long",
    "origin_longitude",
    "origin_lng",
    "origin_long",
    "from_longitude",
    "from_lng",
    "from_long",
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
    "current_long",
    "gps_longitude",
    "gps_lng",
    "gps_long"
  ]);

  if (lat === null || lng === null) return null;

  return {
    lat,
    lng,
    type: "actual",
    label: "Barangay Personnel Start"
  };
}

function getResolutionBarangayPoint(record) {
  /*
    Blue pin meaning:
    Barangay personnel marker.

    This intentionally uses the same ACTUAL GPS/start point as the route start.
    We are NOT using assigned_barangay_lat/lng anymore because that puts the pin
    on the barangay/reference coordinate instead of the personnel's actual GPS location.
  */
  const personnelPoint = getResolutionActualStartPoint(record);

  if (!personnelPoint) return null;

  return {
    ...personnelPoint,
    type: "personnel",
    label: "Barangay Personnel"
  };
}

function getResolutionStartPoint(record) {
  return getResolutionActualStartPoint(record);
}

function areResolutionPointsSame(pointA, pointB) {
  if (!pointA || !pointB) return false;

  const latDiff = Math.abs(Number(pointA.lat) - Number(pointB.lat));
  const lngDiff = Math.abs(Number(pointA.lng) - Number(pointB.lng));

  return latDiff < 0.00001 && lngDiff < 0.00001;
}

function getResolutionStartLabel(startPoint) {
  if (!startPoint) return "Start Point";

  if (startPoint.type === "actual") return "Start Point";
  if (startPoint.type === "personnel") return "Start Point";

  return "Start Point";
}

function getResolutionBarangayLabel(record) {
  return (
    record?.handled_by_barangay_name ||
    record?.barangay_personnel_name ||
    record?.personnel_name ||
    record?.assigned_barangay ||
    "Barangay Personnel"
  );
}

function getResolutionRouteNotePrefix(startPoint, barangayPoint) {
  if (!startPoint) return "Route preview.";

  return "Route from the barangay personnel GPS start point to the issue location.";
}


function ensureResolutionVisibleMarkerStyles() {
  if (document.getElementById("resolutionVisibleMarkerStyles")) return;

  const style = document.createElement("style");
  style.id = "resolutionVisibleMarkerStyles";
  style.textContent = `
    .resolution-start-icon-wrap,
    .resolution-end-icon-wrap {
      background: transparent !important;
      border: 0 !important;
      overflow: visible !important;
    }

    .resolution-start-icon-wrap .resolution-start-icon,
    .resolution-end-icon-wrap .resolution-end-icon {
      width: 24px;
      height: 24px;
      display: block;
      position: relative;
      border-radius: 999px;
      box-sizing: border-box;
      border: 3px solid #ffffff;
      box-shadow: 0 6px 16px rgba(15, 23, 42, 0.20);
    }

    /*
      Map-style target marker for START.
      Green bullseye so it reads like an origin point.
    */
    .resolution-start-icon-wrap .resolution-start-icon {
      background: radial-gradient(circle at center, #ffffff 0 4px, #22c55e 4px 8px, #ffffff 8px 11px, #16a34a 11px 100%);
    }

    /*
      Map-style target marker for END / ISSUE.
      Red bullseye so it reads like a destination point.
    */
    .resolution-end-icon-wrap .resolution-end-icon {
      background: radial-gradient(circle at center, #ffffff 0 4px, #ef4444 4px 8px, #ffffff 8px 11px, #dc2626 11px 100%);
    }

    .resolution-route-map-card .leaflet-marker-icon,
    .resolution-full-map-stage .leaflet-marker-icon {
      overflow: visible !important;
    }
  `;

  document.head.appendChild(style);
}

function addResolutionStartCircle(map, startPoint, record, markerKey = "startMarker") {
  const state = complaintResolutionRouteState;
  if (!map || !startPoint) return null;

  ensureResolutionVisibleMarkerStyles();

  /*
    Start marker:
    Map-style green target marker centered exactly on the start GPS coordinate.
  */
  const marker = L.marker([startPoint.lat, startPoint.lng], {
    icon: L.divIcon({
      className: "resolution-start-icon-wrap",
      html: `<span class="resolution-start-icon" aria-hidden="true"></span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      popupAnchor: [0, -12]
    }),
    interactive: true,
    keyboard: false,
    zIndexOffset: 1100
  }).addTo(map);

  marker.bindPopup(`
    <div>
      <strong>Start Point</strong><br>
      ${escapeHtml(record?.handled_by_barangay_name || record?.assigned_barangay || "-")}<br>
      Coordinates: ${escapeHtml(String(startPoint.lat))}, ${escapeHtml(String(startPoint.lng))}
    </div>
  `);

  state[markerKey] = marker;
  return marker;
}

function addResolutionEndDot(map, issuePoint, record, markerKey = "issueMarker") {
  const state = complaintResolutionRouteState;
  if (!map || !issuePoint) return null;

  ensureResolutionVisibleMarkerStyles();

  /*
    End marker:
    Map-style red target marker centered exactly on the issue GPS coordinate.
  */
  const marker = L.marker([issuePoint.lat, issuePoint.lng], {
    icon: L.divIcon({
      className: "resolution-end-icon-wrap",
      html: `<span class="resolution-end-icon" aria-hidden="true"></span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      popupAnchor: [0, -12]
    }),
    interactive: true,
    keyboard: false,
    zIndexOffset: 1200
  }).addTo(map);

  marker.bindPopup(`
    <div>
      <strong>Issue Location</strong><br>
      ${escapeHtml(record?.subject || "Resolved complaint")}<br>
      Coordinates: ${escapeHtml(String(issuePoint.lat))}, ${escapeHtml(String(issuePoint.lng))}
    </div>
  `);

  state[markerKey] = marker;
  return marker;
}

function addResolutionBarangayPin(map, barangayPoint, record, markerKey = "barangayMarker") {
  const state = complaintResolutionRouteState;
  if (!map || !barangayPoint) return null;

  /*
    Blue pin:
    This remains the barangay personnel GPS marker.
    No floating label; popup only when clicked.
  */
  const marker = L.marker([barangayPoint.lat, barangayPoint.lng], {
    icon: barangayBlueIcon,
    keyboard: false,
    zIndexOffset: 1150
  }).addTo(map);

  marker.bindPopup(`
    <div>
      <strong>Barangay Personnel</strong><br>
      ${escapeHtml(getResolutionBarangayLabel(record))}<br>
      Coordinates: ${escapeHtml(String(barangayPoint.lat))}, ${escapeHtml(String(barangayPoint.lng))}
    </div>
  `);

  state[markerKey] = marker;
  return marker;
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

  if (state.barangayMarker) {
    state.map.removeLayer(state.barangayMarker);
    state.barangayMarker = null;
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
  state.barangayMarker = null;
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
  ensureResolutionRouteMapRuntimeStyles();

  const modal = document.getElementById("complaintResolutionModal");
  if (!modal) return null;

  const mainGrid = modal.querySelector(".resolution-main-grid");
  const evidencePanel = modal.querySelector(".resolution-evidence-panel");

  let card = document.getElementById("resolutionRouteMapCard");

  if (!card) {
    card = document.createElement("div");
    card.id = "resolutionRouteMapCard";
    card.className = "resolution-route-map-card";
  }

  const needsFreshTemplate =
    !card.querySelector("#resolutionRouteMap") ||
    !card.querySelector("#btnOpenResolutionFullRouteMap") ||
    !card.querySelector("#resolutionRouteMapNote");

  if (needsFreshTemplate) {
    card.innerHTML = `
      <div class="resolution-route-map-header">
        <div class="resolution-route-map-title-block">
          <h3>Route Map</h3>
          <p id="resolutionRouteMapNote">Loading route preview...</p>
        </div>

        <button
          type="button"
          id="btnOpenResolutionFullRouteMap"
          class="view-all-btn small resolution-route-map-full-btn">
          Full Map
        </button>
      </div>

      <div class="resolution-route-map-legend" aria-label="Route map legend">
        <span><i class="route-legend-circle start"></i> Start target</span>
        <span><i class="route-legend-circle end"></i> Issue target</span>
        <span><i class="route-legend-pin barangay"></i> Personnel pin</span>
      </div>

      <div id="resolutionRouteMap"></div>
    `;
  } else {
    card.removeAttribute("style");

    const header = card.querySelector(".resolution-route-map-header");
    const title = card.querySelector(".resolution-route-map-header h3");
    const note = card.querySelector("#resolutionRouteMapNote");
    const map = card.querySelector("#resolutionRouteMap");

    if (header) header.removeAttribute("style");
    if (title) title.removeAttribute("style");
    if (note) note.removeAttribute("style");
    if (map) map.removeAttribute("style");
  }

  const fullMapBtn = card.querySelector("#btnOpenResolutionFullRouteMap");
  if (fullMapBtn && fullMapBtn.dataset.bound !== "true") {
    fullMapBtn.dataset.bound = "true";
    fullMapBtn.addEventListener("click", openResolutionFullRouteMap);
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

function ensureResolutionFullRouteMapModal() {
  let modal = document.getElementById("resolutionFullRouteMapModal");

  if (!modal) {
    modal = document.createElement("div");
    modal.id = "resolutionFullRouteMapModal";
    modal.className = "custom-modal hidden resolution-full-route-map-modal";

    modal.innerHTML = `
      <div class="custom-modal-overlay" id="resolutionFullRouteMapOverlay"></div>

      <div class="custom-modal-content resolution-full-route-map-content" style="width:min(1180px, calc(100vw - 48px)); max-width:1180px;">
        <div class="custom-modal-header">
          <div>
            <h3>Full Route Map</h3>
            <p id="resolutionFullRouteMapSubtitle">Start target, barangay personnel pin, and end issue location.</p>
          </div>
          <button type="button" id="closeResolutionFullRouteMapModal" class="modal-close-btn">&times;</button>
        </div>

        <div class="custom-modal-body resolution-full-route-map-body">
          <div class="complaint-map-summary">
            <div class="complaint-map-summary-item">
              <span>Start Point</span>
              <strong id="resolutionFullMapStartLabel">-</strong>
            </div>

            <div class="complaint-map-summary-item">
              <span>Barangay Personnel</span>
              <strong id="resolutionFullMapBarangayLabel">-</strong>
            </div>

            <div class="complaint-map-summary-item">
              <span>End Point</span>
              <strong id="resolutionFullMapEndLabel">-</strong>
            </div>

            <div class="complaint-map-summary-item">
              <span>Distance</span>
              <strong id="resolutionFullMapDistance">-</strong>
            </div>
          </div>

          <div class="resolution-route-map-legend" aria-label="Full route map legend" style="margin:12px 0; display:flex; gap:14px; flex-wrap:wrap;">
            <span><i class="route-legend-circle start"></i> Start target</span>
            <span><i class="route-legend-circle end"></i> Issue target</span>
            <span><i class="route-legend-pin barangay"></i> Personnel pin</span>
          </div>

          <div
            id="resolutionFullRouteMap"
            class="complaint-leaflet-map resolution-full-route-map"
            style="height:min(68vh, 620px); min-height:460px; border-radius:18px; overflow:hidden;">
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  if (modal.dataset.bound !== "true") {
    modal.dataset.bound = "true";

    document
      .getElementById("closeResolutionFullRouteMapModal")
      ?.addEventListener("click", closeResolutionFullRouteMapModal);

    document
      .getElementById("resolutionFullRouteMapOverlay")
      ?.addEventListener("click", closeResolutionFullRouteMapModal);
  }

  return modal;
}

function clearResolutionFullRouteMapLayers() {
  const state = complaintResolutionRouteState;

  if (!state.fullMap) return;

  if (state.fullIssueMarker) {
    state.fullMap.removeLayer(state.fullIssueMarker);
    state.fullIssueMarker = null;
  }

  if (state.fullStartMarker) {
    state.fullMap.removeLayer(state.fullStartMarker);
    state.fullStartMarker = null;
  }

  if (state.fullBarangayMarker) {
    state.fullMap.removeLayer(state.fullBarangayMarker);
    state.fullBarangayMarker = null;
  }

  if (state.fullRouteLine) {
    state.fullMap.removeLayer(state.fullRouteLine);
    state.fullRouteLine = null;
  }

  if (state.fullRoutingControl) {
    try {
      state.fullMap.removeControl(state.fullRoutingControl);
    } catch (error) {
      console.warn("Failed removing full route routing control:", error);
    }

    state.fullRoutingControl = null;
  }
}

function destroyResolutionFullRouteMap(removeModal = false) {
  const state = complaintResolutionRouteState;

  try {
    if (state.fullRoutingControl && state.fullMap) {
      state.fullMap.removeControl(state.fullRoutingControl);
    }
  } catch (error) {
    console.warn("Failed removing full route routing control:", error);
  }

  try {
    if (state.fullMap) {
      state.fullMap.off();
      state.fullMap.remove();
    }
  } catch (error) {
    console.warn("Failed destroying full route map:", error);
  }

  state.fullMap = null;
  state.fullIssueMarker = null;
  state.fullStartMarker = null;
  state.fullBarangayMarker = null;
  state.fullRouteLine = null;
  state.fullRoutingControl = null;

  const mapEl = document.getElementById("resolutionFullRouteMap");
  if (mapEl) {
    mapEl.innerHTML = "";

    try {
      delete mapEl._leaflet_id;
    } catch (error) {
      console.warn("Failed clearing full route Leaflet container id:", error);
    }
  }

  if (removeModal) {
    const modal = document.getElementById("resolutionFullRouteMapModal");
    if (modal) modal.remove();
  }
}

function closeResolutionFullRouteMapModal() {
  destroyResolutionFullRouteMap(false);
  resetComplaintModalDisplay("resolutionFullRouteMapModal");
}

function extendResolutionBounds(boundsPoints, point) {
  if (!point) return;
  boundsPoints.push([point.lat, point.lng]);
}

function drawResolutionFallbackLine(startPoint, issuePoint, mapInstance = null, routeKey = "routeLine") {
  const state = complaintResolutionRouteState;
  const map = mapInstance || state.map;

  if (!map) return;

  state[routeKey] = L.polyline(
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
  ).addTo(map);

  const bounds = L.latLngBounds([
    [startPoint.lat, startPoint.lng],
    [issuePoint.lat, issuePoint.lng]
  ]);

  map.fitBounds(bounds, { padding: [45, 45] });
}

function setResolutionMapNote(message) {
  const noteEl = document.getElementById("resolutionRouteMapNote");
  if (noteEl) noteEl.textContent = message;
}

function ensureResolutionRouteMapRuntimeStyles() {
  if (document.getElementById("resolutionRouteMapRuntimeStyles")) return;

  const style = document.createElement("style");
  style.id = "resolutionRouteMapRuntimeStyles";
  style.textContent = `
    #resolutionRouteMapCard .resolution-route-map-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 14px;
    }

    #resolutionRouteMapCard .resolution-route-map-title-block {
      min-width: 0;
    }

    .resolution-route-map-legend {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      margin: 10px 0 12px;
      color: #475569;
      font-size: 13px;
    }

    .route-legend-circle {
      display: inline-block;
      width: 11px;
      height: 11px;
      border-radius: 999px;
      margin-right: 6px;
      vertical-align: middle;
      box-sizing: border-box;
    }

    .route-legend-circle.start {
      background: #16a34a;
      border: 3px solid #ffffff;
      box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.30);
    }

    .route-legend-circle.end {
      background: #dc2626;
      border: 3px solid #ffffff;
      box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.32);
    }

    .route-legend-pin {
      display: inline-block;
      width: 10px;
      height: 14px;
      border-radius: 10px 10px 10px 0;
      transform: rotate(-45deg);
      margin-right: 8px;
      vertical-align: -2px;
      box-sizing: border-box;
    }

    .route-legend-pin.barangay {
      background: #2563eb;
      border: 2px solid #1d4ed8;
    }

    .resolution-route-tooltip {
      border: 0 !important;
      border-radius: 999px !important;
      box-shadow: 0 8px 18px rgba(15, 23, 42, 0.18) !important;
      color: #0f172a !important;
      font-weight: 800 !important;
      padding: 4px 8px !important;
    }

    .resolution-route-tooltip.start {
      background: #ccfbf1 !important;
    }

    .resolution-route-tooltip.end {
      background: #fee2e2 !important;
    }

    .resolution-route-tooltip.barangay {
      background: #dbeafe !important;
    }

    .resolution-route-map-full-btn {
      white-space: nowrap;
    }

    @media (max-width: 768px) {
      #resolutionRouteMapCard .resolution-route-map-header {
        flex-direction: column;
        align-items: stretch;
      }

      .resolution-route-map-full-btn {
        width: 100%;
      }
    }
  `;

  document.head.appendChild(style);
}

function renderResolutionFullRouteMap(record) {
  ensureResolutionFullRouteMapModal();
  destroyResolutionFullRouteMap(false);

  if (!window.L) {
    alert("Map library is not loaded. Please refresh the page.");
    return;
  }

  const issuePoint = getResolutionIssuePoint(record);
  const startPoint = getResolutionStartPoint(record);
  const barangayPoint = getResolutionBarangayPoint(record);

  if (!issuePoint) {
    alert("Issue coordinates are not available for this resolved complaint.");
    return;
  }

  if (!startPoint) {
    alert("Barangay personnel GPS/start point is not available for this resolved complaint record yet.");
    return;
  }

  const state = complaintResolutionRouteState;
  const mapEl = document.getElementById("resolutionFullRouteMap");

  if (!mapEl) return;

  document.getElementById("resolutionFullMapStartLabel").textContent = getResolutionStartLabel(startPoint);
  document.getElementById("resolutionFullMapBarangayLabel").textContent = barangayPoint
    ? getResolutionBarangayLabel(record)
    : "Not available";
  document.getElementById("resolutionFullMapEndLabel").textContent =
    record?.subject || "Issue Location";

  const straightDistance = calculateDistanceMetersLocal(
    startPoint.lat,
    startPoint.lng,
    issuePoint.lat,
    issuePoint.lng
  );

  document.getElementById("resolutionFullMapDistance").textContent = formatDistanceText(straightDistance);

  state.fullMap = L.map(mapEl, {
    zoomControl: true,
    attributionControl: true
  }).setView([issuePoint.lat, issuePoint.lng], 16);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(state.fullMap);

  addResolutionStartCircle(state.fullMap, startPoint, record, "fullStartMarker");
  addResolutionEndDot(state.fullMap, issuePoint, record, "fullIssueMarker");

  if (barangayPoint) {
    addResolutionBarangayPin(state.fullMap, barangayPoint, record, "fullBarangayMarker");
  }

  const boundsPoints = [];
  extendResolutionBounds(boundsPoints, startPoint);
  extendResolutionBounds(boundsPoints, issuePoint);
  extendResolutionBounds(boundsPoints, barangayPoint);

  if (boundsPoints.length > 1) {
    state.fullMap.fitBounds(L.latLngBounds(boundsPoints), { padding: [80, 80] });
  }

  if (!window.L.Routing) {
    drawResolutionFallbackLine(startPoint, issuePoint, state.fullMap, "fullRouteLine");
    return;
  }

  state.fullRoutingControl = L.Routing.control({
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
          weight: 7
        }
      ]
    }
  }).addTo(state.fullMap);

  state.fullRoutingControl.on("routesfound", function (event) {
    const route = event.routes && event.routes[0];
    if (!route) return;

    const routeDistance = Math.round(route.summary?.totalDistance || 0);
    document.getElementById("resolutionFullMapDistance").textContent = formatDistanceText(routeDistance);

    if (route.bounds) {
      state.fullMap.fitBounds(route.bounds, { padding: [80, 80] });
    }
  });

  state.fullRoutingControl.on("routingerror", function (error) {
    console.warn("Full route failed, drawing fallback line:", error);

    if (state.fullRoutingControl) {
      try {
        state.fullMap.removeControl(state.fullRoutingControl);
      } catch (removeError) {
        console.warn("Failed removing failed full routing control:", removeError);
      }

      state.fullRoutingControl = null;
    }

    drawResolutionFallbackLine(startPoint, issuePoint, state.fullMap, "fullRouteLine");
  });

  setTimeout(() => {
    state.fullMap.invalidateSize();
  }, 180);
}

function openResolutionFullRouteMap() {
  const record = complaintResolutionRouteState.lastRecord || currentComplaintResolution;

  if (!record) {
    alert("No resolved complaint selected.");
    return;
  }

  ensureResolutionFullRouteMapModal();
  openComplaintModalWithPosition("resolutionFullRouteMapModal");

  setTimeout(() => {
    renderResolutionFullRouteMap(record);
  }, 220);
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
  const barangayPoint = getResolutionBarangayPoint(record);
  const state = complaintResolutionRouteState;
  state.lastRecord = record;

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

  addResolutionEndDot(state.map, issuePoint, record, "issueMarker");

  if (!startPoint) {
    state.map.setView([issuePoint.lat, issuePoint.lng], 17);
    state.issueMarker.openPopup();
    setResolutionMapNote(
      "Only the issue location is available. Barangay personnel GPS/start point is not included in this resolved complaint record yet."
    );
    return;
  }

  addResolutionStartCircle(state.map, startPoint, record, "startMarker");

  if (barangayPoint) {
    addResolutionBarangayPin(state.map, barangayPoint, record, "barangayMarker");
  }

  const straightDistance = calculateDistanceMetersLocal(
    startPoint.lat,
    startPoint.lng,
    issuePoint.lat,
    issuePoint.lng
  );

  const notePrefix = getResolutionRouteNotePrefix(startPoint, barangayPoint);

  const sameStartAndBarangay = areResolutionPointsSame(startPoint, barangayPoint);
  const barangayNote = barangayPoint
    ? " Blue pin is the barangay personnel GPS marker at the start point."
    : " Barangay personnel GPS pin is not available.";

  setResolutionMapNote(
    `${notePrefix} Straight distance: ${formatDistanceText(straightDistance)}.${barangayNote}`
  );

  const boundsPoints = [];
  extendResolutionBounds(boundsPoints, startPoint);
  extendResolutionBounds(boundsPoints, issuePoint);
  extendResolutionBounds(boundsPoints, barangayPoint);

  if (boundsPoints.length > 1) {
    state.map.fitBounds(L.latLngBounds(boundsPoints), { padding: [45, 45] });
  }

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

    setResolutionMapNote(`${notePrefix} Route distance: ${routeDistanceText}.${barangayNote}`);

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
      `${notePrefix} Route service failed, so a direct line is shown. Straight distance: ${formatDistanceText(straightDistance)}.${barangayNote}`
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

      /*
        Rejected complaints are no longer shown in the active Complaints Management table.
        They are kept in View History / reports instead.
      */
      return ["pending", "validated", "forwarded", "in_progress"].includes(status);
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

    /*
      Rejected complaints are history/report records, not active validation items.
    */
    return ["pending", "validated", "forwarded", "in_progress"].includes(status);
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

    /*
      Rejected complaints must move to View History after rejection.
    */
    return ["pending", "validated", "forwarded", "in_progress"].includes(status);
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
  "complaintRejectModal",
  "complaintResolutionModal",
  "resolutionFullRouteMapModal",
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
    modal.style.setProperty("z-index", modalId === "complaintRejectModal" ? "2147483640" : "2147483600", "important");
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
        if (modalId === "complaintRejectModal") {
          content.style.setProperty("width", "min(560px, calc(100vw - 48px))", "important");
          content.style.setProperty("max-width", "560px", "important");
        } else if (modalId === "complaintHistoryModal") {
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

      if (modalId === "resolutionFullRouteMapModal" && complaintResolutionRouteState.fullMap) {
        setTimeout(() => {
          complaintResolutionRouteState.fullMap.invalidateSize();
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


function ensureComplaintRejectRuntimeStyles() {
  if (document.getElementById("complaintRejectRuntimeStyles")) return;

  const style = document.createElement("style");
  style.id = "complaintRejectRuntimeStyles";
  style.textContent = `
    #complaintDetailsModal .complaint-danger-btn,
    #complaintRejectModal .complaint-danger-btn {
      min-height: 48px;
      border: 0;
      border-radius: 14px;
      padding: 12px 20px;
      background: #dc2626;
      color: #ffffff;
      font-weight: 800;
      cursor: pointer;
      box-shadow: 0 16px 34px rgba(220, 38, 38, 0.22);
      transition: transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    #complaintDetailsModal .complaint-danger-btn:hover,
    #complaintRejectModal .complaint-danger-btn:hover {
      background: #b91c1c;
      transform: translateY(-1px);
      box-shadow: 0 20px 42px rgba(220, 38, 38, 0.28);
    }

    #complaintDetailsModal .complaint-danger-btn:disabled,
    #complaintRejectModal .complaint-danger-btn:disabled {
      opacity: 0.65;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }

    #complaintRejectModal .complaint-reject-modal-content {
      border-radius: 24px;
      overflow: hidden;
      background: #ffffff;
    }

    #complaintRejectModal .complaint-reject-body {
      padding: 22px 24px 24px;
      display: grid;
      gap: 16px;
    }

    #complaintRejectModal .complaint-reject-warning {
      display: grid;
      gap: 5px;
      padding: 14px 16px;
      border: 1px solid #fecaca;
      border-radius: 16px;
      background: #fef2f2;
      color: #7f1d1d;
    }

    #complaintRejectModal .complaint-reject-warning strong {
      font-size: 14px;
      font-weight: 900;
    }

    #complaintRejectModal .complaint-reject-warning span {
      font-size: 13px;
      line-height: 1.45;
      color: #991b1b;
    }

    #complaintRejectModal .complaint-reject-summary {
      display: grid;
      gap: 6px;
      padding: 14px 16px;
      border: 1px solid #e5e7eb;
      border-radius: 16px;
      background: #f8fafc;
    }

    #complaintRejectModal .complaint-reject-summary span,
    #complaintRejectModal .complaint-reject-field label {
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #64748b;
    }

    #complaintRejectModal .complaint-reject-summary strong {
      font-size: 16px;
      color: #0f172a;
    }

    #complaintRejectModal .complaint-reject-field {
      display: grid;
      gap: 8px;
    }

    #complaintRejectModal #complaintRejectReason {
      width: 100%;
      min-height: 130px;
      resize: vertical;
      border: 1px solid #cbd5e1;
      border-radius: 16px;
      padding: 14px 15px;
      font: inherit;
      color: #0f172a;
      background: #ffffff;
      outline: none;
      box-sizing: border-box;
    }

    #complaintRejectModal #complaintRejectReason:focus {
      border-color: #dc2626;
      box-shadow: 0 0 0 4px rgba(220, 38, 38, 0.12);
    }

    #complaintRejectModal #complaintRejectReasonHint {
      font-size: 12px;
      color: #64748b;
    }

    #complaintRejectModal .complaint-reject-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding-top: 4px;
    }

    @media (max-width: 640px) {
      #complaintDetailsModal .complaint-details-footer {
        flex-direction: column;
      }

      #complaintDetailsModal .complaint-details-footer button,
      #complaintRejectModal .complaint-reject-actions button {
        width: 100%;
      }

      #complaintRejectModal .complaint-reject-actions {
        flex-direction: column-reverse;
      }
    }
  `;

  document.head.appendChild(style);
}

function syncComplaintDetailsActionButtons(status) {
  const normalized = String(status || "pending").trim().toLowerCase();

  const rejectBtn = document.getElementById("btnRejectComplaintFromDetails");
  const validateBtn = document.getElementById("btnValidateComplaintFromDetails");

  const canReview = normalized === "pending";

  if (rejectBtn) {
    rejectBtn.style.display = canReview ? "inline-flex" : "none";
    rejectBtn.disabled = !canReview;
  }

  if (validateBtn) {
    validateBtn.style.display = canReview ? "inline-flex" : "none";
    validateBtn.disabled = !canReview;
  }
}

function openComplaintRejectModal() {
  if (!currentComplaint || !currentComplaint.id) {
    alert("No complaint selected.");
    return;
  }

  ensureComplaintRejectRuntimeStyles();

  const subjectEl = document.getElementById("complaintRejectSubject");
  const reasonEl = document.getElementById("complaintRejectReason");
  const hintEl = document.getElementById("complaintRejectReasonHint");
  const confirmBtn = document.getElementById("confirmComplaintRejectBtn");

  if (subjectEl) {
    subjectEl.textContent = currentComplaint.subject || "Selected complaint";
  }

  if (reasonEl) {
    reasonEl.value = "";
  }

  if (hintEl) {
    hintEl.textContent = "Minimum 10 characters. Be specific so the record is clear.";
    hintEl.style.color = "#64748b";
  }

  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Confirm Reject";
  }

  openComplaintModalWithPosition("complaintRejectModal");

  setTimeout(() => {
    reasonEl?.focus();
  }, 180);
}

function closeComplaintRejectModal() {
  resetComplaintModalDisplay("complaintRejectModal");

  const reasonEl = document.getElementById("complaintRejectReason");
  if (reasonEl) reasonEl.value = "";
}

async function submitComplaintRejection() {
  if (!currentComplaint || !currentComplaint.id) {
    alert("No complaint selected.");
    return;
  }

  const reasonEl = document.getElementById("complaintRejectReason");
  const hintEl = document.getElementById("complaintRejectReasonHint");
  const confirmBtn = document.getElementById("confirmComplaintRejectBtn");

  const reason = String(reasonEl?.value || "").trim();

  if (reason.length < 10) {
    if (hintEl) {
      hintEl.textContent = "Please enter a clear rejection reason with at least 10 characters.";
      hintEl.style.color = "#dc2626";
    }

    reasonEl?.focus();
    return;
  }

  const confirmed = confirm("Reject this complaint? This action will mark the complaint as rejected.");
  if (!confirmed) return;

  try {
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Rejecting...";
    }

    const response = await fetch(
      `${getComplaintsApiUrl()}/${currentComplaint.id}/reject`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          rejection_reason: reason,
          rejected_by: currentUser?.id || null
        })
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.success === false) {
      throw new Error(data.message || "Failed to reject complaint.");
    }

    alert(data.message || "Complaint rejected successfully.");

    resetComplaintModalDisplay("complaintRejectModal");
    resetComplaintModalDisplay("complaintMapModal");
    resetComplaintModalDisplay("complaintDetailsModal");

    selectedBarangayCandidate = null;
    currentComplaint = null;

    await loadComplaints();

    if (typeof loadComplaintHistory === "function") {
      try {
        await loadComplaintHistory();
      } catch (historyError) {
        console.warn("Complaint history refresh skipped:", historyError);
      }
    }
  } catch (error) {
    console.error("submitComplaintRejection error:", error);
    alert(error.message || "Failed to reject complaint.");
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Confirm Reject";
    }
  }
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



function ensureComplaintDetailsProblemBarangayStyles() {
  if (document.getElementById("complaintProblemBarangayRuntimeStyles")) return;

  const style = document.createElement("style");
  style.id = "complaintProblemBarangayRuntimeStyles";
  style.textContent = `
    #complaintDetailsModal .complaint-pro-submitted-grid {
      align-items: stretch !important;
      gap: 12px !important;
    }

    #complaintDetailsModal .complaint-pro-submitted-grid .complaint-pro-field {
      min-height: 64px !important;
      padding: 13px 14px !important;
      border: 1px solid #e5e7eb !important;
      border-radius: 14px !important;
      background: #ffffff !important;
    }

    @media (max-width: 680px) {
      #complaintDetailsModal .complaint-pro-submitted-grid {
        grid-template-columns: 1fr !important;
      }
    }
  `;

  document.head.appendChild(style);
}


function ensureComplaintProblemBarangayField() {
  const createdAtEl = document.getElementById("complaintModalCreatedAt");
  if (!createdAtEl) return;

  const submittedCard = createdAtEl.closest(".submitted-card");
  if (!submittedCard) return;

  if (document.getElementById("complaintModalProblemBarangay")) return;

  /*
    UI-only field:
    Shows the detected/assigned concern barangay beside Submitted At.
    This helps WMO verify quickly if the issue location was assigned to the correct barangay.
  */
  submittedCard.innerHTML = `
    <div class="complaint-pro-two-grid complaint-pro-submitted-grid">
      <div class="complaint-pro-field with-icon">
        <span class="complaint-mini-icon purple">🗓</span>
        <div>
          <label>Submitted At</label>
          <div id="complaintModalCreatedAt" class="complaint-field-value">-</div>
        </div>
      </div>

      <div class="complaint-pro-field with-icon">
        <span class="complaint-mini-icon">📍</span>
        <div>
          <label>Concern Barangay</label>
          <div id="complaintModalProblemBarangay" class="complaint-field-value">-</div>
        </div>
      </div>
    </div>
  `;
}

function getComplaintProblemBarangayLabel(data = {}) {
  return (
    data.problem_barangay ||
    data.detected_barangay ||
    data.issue_barangay ||
    data.assigned_barangay ||
    "For Verification"
  );
}


function openComplaintModal(data) {
  mountComplaintModalsToBody();
  ensureComplaintRejectRuntimeStyles();

  currentComplaint = data;
  selectedBarangayCandidate = null;

  ensureComplaintDetailsProblemBarangayStyles();
  ensureComplaintProblemBarangayField();

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  setText("complaintModalSubject", data.subject || "-");
  setText("complaintModalDescription", data.description || "-");
  setText("complaintModalCitizenName", data.citizen_name || "-");
  setText("complaintModalUsername", data.username || "-");
  setText("complaintModalBarangay", data.assigned_barangay || "-");
  setText("complaintModalProblemBarangay", getComplaintProblemBarangayLabel(data));
  setComplaintDetailsStatusUI(data.status || "pending");
  syncComplaintDetailsActionButtons(data.status || "pending");
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

let complaintHistorySearchQuery = "";
let complaintHistoryBarangayFilter = "all";

function formatComplaintHistoryStatus(status) {
  const normalized = String(status || "").toLowerCase().trim();

  if (normalized === "forwarded") return "Forwarded";
  if (normalized === "accepted_by_barangay") return "Accepted";
  if (normalized === "in_progress") return "In Progress";
  if (normalized === "resolved") return "Resolved";
  if (normalized === "rejected") return "Rejected";

  return status || "-";
}

function getComplaintHistoryStatusClass(status) {
  const normalized = String(status || "").toLowerCase().trim();

  if (normalized === "resolved") return "resolved";
  if (normalized === "rejected") return "rejected";
  if (normalized === "forwarded") return "forwarded";
  if (normalized === "accepted_by_barangay") return "accepted";
  if (normalized === "in_progress") return "in-progress";

  return "unknown";
}

function ensureComplaintHistoryStatusStyles() {
  // Styles are handled in css/admin/admin-complaints.css.
  return;
}

function ensureComplaintHistoryModalScrollStyles() {
  // Styles are handled in css/admin/admin-complaints.css.
  return;
}

function prepareComplaintHistoryTableScroll() {
  ensureComplaintHistoryModalScrollStyles();

  const modal = document.getElementById("complaintHistoryModal");
  const tbody = document.getElementById("complaintHistoryTableBody");
  if (!modal || !tbody) return;

  const table = tbody.closest("table");
  if (!table) return;

  table.classList.add("complaint-history-table");

  let scrollWrapper = table.closest(".complaint-history-table-scroll");

  if (!scrollWrapper) {
    scrollWrapper = document.createElement("div");
    scrollWrapper.className = "complaint-history-table-scroll";

    const parent = table.parentNode;
    if (parent) {
      parent.insertBefore(scrollWrapper, table);
      scrollWrapper.appendChild(table);
    }
  }

  const body =
    modal.querySelector(".custom-modal-body") ||
    modal.querySelector(".history-modal-body") ||
    modal.querySelector(".modal-body") ||
    scrollWrapper.parentElement;

  const content =
    modal.querySelector(".custom-modal-content") ||
    modal.querySelector(".history-modal-content");

  if (content) {
    content.style.setProperty("overflow", "hidden", "important");
    content.style.setProperty("max-height", "calc(100dvh - 48px)", "important");
  }

  if (body) {
    body.style.setProperty("overflow", "hidden", "important");
    body.style.setProperty("max-width", "100%", "important");
  }

  scrollWrapper.style.setProperty("overflow-x", "auto", "important");
  scrollWrapper.style.setProperty("overflow-y", "auto", "important");
  scrollWrapper.style.setProperty("max-width", "100%", "important");

  let hint = modal.querySelector(".complaint-history-scroll-hint");
  if (!hint) {
    hint = document.createElement("div");
    hint.className = "complaint-history-scroll-hint";
    hint.textContent = "Swipe or scroll sideways to view all columns.";
    scrollWrapper.parentNode?.insertBefore(hint, scrollWrapper);
  }
}


function normalizeComplaintHistoryFilterValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function getComplaintHistoryBarangayValue(item = {}) {
  return (
    item.assigned_barangay ||
    item.handled_by_barangay_name ||
    item.reporter_barangay ||
    "-"
  );
}

function getComplaintHistorySearchText(item = {}) {
  const statusLabel = formatComplaintHistoryStatus(item.status);
  const dateLabel = formatDateTimeDisplay(item.rejected_at || item.resolved_at || item.created_at);

  return normalizeComplaintHistoryFilterValue([
    item.subject,
    item.description,
    item.citizen_name,
    item.username,
    getComplaintHistoryBarangayValue(item),
    item.status,
    statusLabel,
    dateLabel,
    item.rejected_at,
    item.resolved_at,
    item.created_at
  ].join(" "));
}

function getFilteredComplaintHistoryRecords(records = []) {
  const searchValue = normalizeComplaintHistoryFilterValue(complaintHistorySearchQuery);
  const barangayValue = normalizeComplaintHistoryFilterValue(complaintHistoryBarangayFilter);

  return (Array.isArray(records) ? records : []).filter((item) => {
    const itemBarangay = normalizeComplaintHistoryFilterValue(getComplaintHistoryBarangayValue(item));
    const matchesSearch = !searchValue || getComplaintHistorySearchText(item).includes(searchValue);
    const matchesBarangay = barangayValue === "all" || itemBarangay === barangayValue;

    return matchesSearch && matchesBarangay;
  });
}

function getComplaintHistoryBarangayOptions(records = []) {
  const barangaySet = new Set();

  (Array.isArray(records) ? records : []).forEach((item) => {
    const barangay = String(getComplaintHistoryBarangayValue(item) || "").trim();

    if (barangay && barangay !== "-") {
      barangaySet.add(barangay);
    }
  });

  return Array.from(barangaySet).sort((a, b) =>
    a.localeCompare(b, undefined, {
      sensitivity: "base"
    })
  );
}

function updateComplaintHistoryMeta(totalCount, visibleCount) {
  const meta = document.getElementById("complaintHistoryFilterMeta");
  if (!meta) return;

  if (!totalCount) {
    meta.textContent = "No records";
    return;
  }

  const hasSearch = Boolean(normalizeComplaintHistoryFilterValue(complaintHistorySearchQuery));
  const hasBarangayFilter = normalizeComplaintHistoryFilterValue(complaintHistoryBarangayFilter) !== "all";

  if (!hasSearch && !hasBarangayFilter) {
    meta.textContent = `${totalCount} record${totalCount === 1 ? "" : "s"}`;
    return;
  }

  meta.textContent = `${visibleCount} of ${totalCount} shown`;
}

function updateComplaintHistoryBarangayFilterOptions(records = []) {
  const select = document.getElementById("complaintHistoryBarangayFilter");
  if (!select) return;

  const selectedValue = complaintHistoryBarangayFilter || "all";
  const barangays = getComplaintHistoryBarangayOptions(records);

  select.innerHTML = `
    <option value="all">All Barangays</option>
    ${barangays.map((barangay) => `
      <option value="${escapeHtml(barangay)}">${escapeHtml(barangay)}</option>
    `).join("")}
  `;

  const optionExists = Array.from(select.options).some((option) => option.value === selectedValue);
  complaintHistoryBarangayFilter = optionExists ? selectedValue : "all";
  select.value = complaintHistoryBarangayFilter;
}

function ensureComplaintHistoryToolbar() {
  const modal = document.getElementById("complaintHistoryModal");
  const header = modal?.querySelector(".history-modal-header");

  if (!modal || !header) return null;

  let toolbar = document.getElementById("complaintHistoryFilterToolbar");

  if (!toolbar) {
    toolbar = document.createElement("div");
    toolbar.id = "complaintHistoryFilterToolbar";
    toolbar.className = "complaint-history-filter-toolbar";

    toolbar.innerHTML = `
      <div class="complaint-history-search-box">
        <span class="complaint-history-search-icon" aria-hidden="true">⌕</span>
        <input
          type="text"
          id="complaintHistorySearchInput"
          class="complaint-history-search-input"
          placeholder="Search complaint history..."
          autocomplete="off"
        />
        <button
          type="button"
          id="clearComplaintHistorySearchBtn"
          class="complaint-history-search-clear"
          aria-label="Clear complaint history search"
          title="Clear search"
        >
          ×
        </button>
      </div>

      <div class="complaint-history-barangay-filter-wrap">
        <select id="complaintHistoryBarangayFilter" class="complaint-history-barangay-filter" aria-label="Filter complaint history by barangay">
          <option value="all">All Barangays</option>
        </select>
      </div>

      <div id="complaintHistoryFilterMeta" class="complaint-history-filter-meta">
        No records
      </div>
    `;

    header.insertAdjacentElement("afterend", toolbar);
  }

  const searchInput = document.getElementById("complaintHistorySearchInput");
  const clearBtn = document.getElementById("clearComplaintHistorySearchBtn");
  const barangaySelect = document.getElementById("complaintHistoryBarangayFilter");

  if (searchInput && searchInput.dataset.boundComplaintHistorySearch !== "true") {
    searchInput.dataset.boundComplaintHistorySearch = "true";

    searchInput.addEventListener("input", () => {
      complaintHistorySearchQuery = searchInput.value || "";
      renderComplaintHistoryTable(complaintHistoryRecords);
    });
  }

  if (clearBtn && clearBtn.dataset.boundComplaintHistorySearch !== "true") {
    clearBtn.dataset.boundComplaintHistorySearch = "true";

    clearBtn.addEventListener("click", () => {
      complaintHistorySearchQuery = "";

      if (searchInput) {
        searchInput.value = "";
        searchInput.focus();
      }

      renderComplaintHistoryTable(complaintHistoryRecords);
    });
  }

  if (barangaySelect && barangaySelect.dataset.boundComplaintHistoryBarangay !== "true") {
    barangaySelect.dataset.boundComplaintHistoryBarangay = "true";

    barangaySelect.addEventListener("change", () => {
      complaintHistoryBarangayFilter = barangaySelect.value || "all";
      renderComplaintHistoryTable(complaintHistoryRecords);
    });
  }

  if (searchInput && searchInput.value !== complaintHistorySearchQuery) {
    searchInput.value = complaintHistorySearchQuery;
  }

  updateComplaintHistoryBarangayFilterOptions(complaintHistoryRecords);

  return toolbar;
}

async function loadComplaintHistory() {
  ensureComplaintHistoryModalScrollStyles();
  ensureComplaintHistoryToolbar();
  prepareComplaintHistoryTableScroll();

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
    ensureComplaintHistoryToolbar();
    updateComplaintHistoryBarangayFilterOptions(complaintHistoryRecords);
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
  ensureComplaintHistoryStatusStyles();
  ensureComplaintHistoryToolbar();
  prepareComplaintHistoryTableScroll();

  const tbody = document.getElementById("complaintHistoryTableBody");
  if (!tbody) return;

  const safeRecords = Array.isArray(records) ? records : [];
  const filteredRecords = getFilteredComplaintHistoryRecords(safeRecords);

  updateComplaintHistoryBarangayFilterOptions(safeRecords);
  updateComplaintHistoryMeta(safeRecords.length, filteredRecords.length);

  if (!safeRecords.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-state-cell">No complaint history found.</td>
      </tr>
    `;
    return;
  }

  if (!filteredRecords.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-state-cell">No complaint history matches your search or barangay filter.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filteredRecords.map(item => `
    <tr>
      <td>${escapeHtml(item.subject || "-")}</td>
      <td>${escapeHtml(item.citizen_name || item.username || "-")}</td>
      <td>${escapeHtml(getComplaintHistoryBarangayValue(item))}</td>
      <td>
        <span class="complaint-history-status ${escapeHtml(getComplaintHistoryStatusClass(item.status))}">
          ${escapeHtml(formatComplaintHistoryStatus(item.status))}
        </span>
      </td>
      <td>${escapeHtml(formatDateTimeDisplay(item.rejected_at || item.resolved_at || item.created_at))}</td>
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
  ensureComplaintHistoryModalScrollStyles();
  ensureComplaintHistoryToolbar();

  openComplaintModalWithPosition("complaintHistoryModal");

  requestAnimationFrame(() => {
    applyComplaintModalPosition("complaintHistoryModal");
    prepareComplaintHistoryTableScroll();
  });

  loadComplaintHistory();
}

function closeComplaintHistoryModal() {
  resetComplaintModalDisplay("complaintHistoryModal");
}

// =========================
// COMPLAINT RESOLUTION MODAL
// =========================

function isValidResolutionImagePath(path) {
  if (!path) return false;

  const value = String(path).trim();

  if (!value) return false;

  const lowered = value.toLowerCase();

  if (lowered === "null" || lowered === "undefined") return false;

  /*
    Reject folder-only values.
    These are not actual image files and will always fail.
  */
  if (
    lowered === "/uploads/complaints" ||
    lowered === "uploads/complaints" ||
    lowered === "/uploads/complaints/" ||
    lowered === "uploads/complaints/" ||
    lowered === "/uploads/cplaints" ||
    lowered === "uploads/cplaints" ||
    lowered === "/uploads/cplaints/" ||
    lowered === "uploads/cplaints/"
  ) {
    return false;
  }

  return true;
}

function addUniqueResolutionImageCandidate(list, rawPath) {
  if (!isValidResolutionImagePath(rawPath)) return;

  const path = String(rawPath).trim();
  const key = path.toLowerCase();

  if (list.some(item => String(item || "").trim().toLowerCase() === key)) {
    return;
  }

  list.push(path);
}

function getResolutionImageCandidates(record = {}) {
  /*
    Keep all possible fields. Some old records use image_url or typo folders,
    while newer resolved records use resolution_evidence_url.
  */
  const candidates = [];

  [
    record?.resolution_evidence_url,
    record?.resolution_image_url,
    record?.resolution_photo_url,
    record?.resolved_evidence_url,
    record?.resolved_image_url,
    record?.resolved_photo_url,

    record?.image_url,
    record?.complaint_image_url,
    record?.evidence_url,
    record?.photo_url
  ].forEach((path) => {
    addUniqueResolutionImageCandidate(candidates, path);
  });

  return candidates;
}

function getValidResolutionImagePath(record) {
  const candidates = getResolutionImageCandidates(record);
  return candidates[0] || "";
}

function addCacheBusterToImageUrl(url) {
  if (!url) return "";

  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}t=${Date.now()}`;
}

function addUniqueResolutionImageUrl(list, rawPath, imageUrl) {
  if (!imageUrl) return;

  const cleanUrl = String(imageUrl).trim();
  const key = cleanUrl.toLowerCase();

  if (list.some(item => String(item.imageUrl || "").toLowerCase() === key)) {
    return;
  }

  list.push({
    rawPath,
    imageUrl: cleanUrl
  });
}

function getResolutionImageUrlCandidates(rawCandidates = []) {
  const urlCandidates = [];

  rawCandidates.forEach((rawPath) => {
    const imageUrl = getImageUrl(rawPath);

    addUniqueResolutionImageUrl(urlCandidates, rawPath, imageUrl);

    /*
      IMPORTANT COMPAT FIX:
      Some older files/records were stored under /uploads/cplaints/
      while newer backend code saves under /uploads/complaints/.
      If the first URL fails, the modal will try the alternate folder name
      using the same filename.
    */
    if (imageUrl && imageUrl.includes("/uploads/complaints/")) {
      addUniqueResolutionImageUrl(
        urlCandidates,
        rawPath,
        imageUrl.replace("/uploads/complaints/", "/uploads/cplaints/")
      );
    }

    if (imageUrl && imageUrl.includes("/uploads/cplaints/")) {
      addUniqueResolutionImageUrl(
        urlCandidates,
        rawPath,
        imageUrl.replace("/uploads/cplaints/", "/uploads/complaints/")
      );
    }

    /*
      If the config base URL is different from the page origin, also try
      the same upload path on the current domain.
    */
    try {
      const parsedUrl = new URL(imageUrl, window.location.origin);

      if (
        parsedUrl.pathname &&
        parsedUrl.pathname.includes("/uploads/")
      ) {
        addUniqueResolutionImageUrl(
          urlCandidates,
          rawPath,
          `${window.location.origin}${parsedUrl.pathname}`
        );

        if (parsedUrl.pathname.includes("/uploads/complaints/")) {
          addUniqueResolutionImageUrl(
            urlCandidates,
            rawPath,
            `${window.location.origin}${parsedUrl.pathname.replace("/uploads/complaints/", "/uploads/cplaints/")}`
          );
        }

        if (parsedUrl.pathname.includes("/uploads/cplaints/")) {
          addUniqueResolutionImageUrl(
            urlCandidates,
            rawPath,
            `${window.location.origin}${parsedUrl.pathname.replace("/uploads/cplaints/", "/uploads/complaints/")}`
          );
        }
      }
    } catch (error) {
      console.warn("Skipping current-origin image fallback:", error);
    }
  });

  return urlCandidates;
}

function renderResolutionEvidenceImage(record) {
  const evidenceImg = document.getElementById("resolutionModalEvidenceImage");
  const noEvidence = document.getElementById("resolutionModalNoEvidence");
  const evidenceFrame = document.getElementById("resolutionEvidenceFrame");

  if (!evidenceImg) return;

  const rawCandidates = getResolutionImageCandidates(record);
  const imageCandidates = getResolutionImageUrlCandidates(rawCandidates);

  console.log("CURRENT RESOLUTION DATA:", record);
  console.log("RAW IMAGE CANDIDATES:", rawCandidates);
  console.log("FINAL IMAGE URL CANDIDATES:", imageCandidates.map(item => item.imageUrl));

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

  if (!imageCandidates.length) {
    if (noEvidence) noEvidence.textContent = "No evidence image submitted.";
    return;
  }

  let currentIndex = 0;
  let loadTimeout = null;
  let finished = false;

  const clearImageLoadTimeout = () => {
    if (loadTimeout) {
      clearTimeout(loadTimeout);
      loadTimeout = null;
    }
  };

  const showFailedState = () => {
    clearImageLoadTimeout();

    evidenceImg.onload = null;
    evidenceImg.onerror = null;
    evidenceImg.removeAttribute("src");
    evidenceImg.classList.add("hidden");
    evidenceImg.style.display = "none";

    if (evidenceFrame) evidenceFrame.style.display = "none";

    if (noEvidence) {
      noEvidence.textContent = "Image failed to load.";
      noEvidence.classList.remove("hidden");
    }
  };

  const tryLoadImage = () => {
    clearImageLoadTimeout();

    if (finished) return;

    const current = imageCandidates[currentIndex];

    if (!current) {
      showFailedState();
      return;
    }

    if (noEvidence) {
      noEvidence.textContent =
        imageCandidates.length > 1
          ? `Loading evidence image ${currentIndex + 1} of ${imageCandidates.length}...`
          : "Loading evidence image...";
      noEvidence.classList.remove("hidden");
    }

    const finalUrl = addCacheBusterToImageUrl(current.imageUrl);

    evidenceImg.onload = () => {
      if (finished) return;

      finished = true;
      clearImageLoadTimeout();

      console.log("Resolution image loaded:", current.imageUrl);

      evidenceImg.classList.remove("hidden");
      evidenceImg.style.display = "block";

      if (evidenceFrame) evidenceFrame.style.display = "flex";
      if (noEvidence) noEvidence.classList.add("hidden");

      if (typeof enableImagePreview === "function") {
        enableImagePreview(evidenceImg);
      }
    };

    evidenceImg.onerror = () => {
      if (finished) return;

      clearImageLoadTimeout();
      console.warn("Resolution image failed, trying next if available:", current.imageUrl);

      currentIndex += 1;
      tryLoadImage();
    };

    /*
      Important:
      Some hosted image requests can hang instead of immediately firing error.
      This timeout forces the modal to try the next candidate, such as image_url,
      or the alternate /uploads/cplaints/ path.
    */
    loadTimeout = setTimeout(() => {
      if (finished) return;

      console.warn("Resolution image timed out, trying next if available:", current.imageUrl);

      evidenceImg.onload = null;
      evidenceImg.onerror = null;
      evidenceImg.removeAttribute("src");

      currentIndex += 1;
      tryLoadImage();
    }, 3500);

    evidenceImg.src = finalUrl;
  };

  tryLoadImage();
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
  destroyResolutionFullRouteMap(true);
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
  ensureComplaintHistoryToolbar();
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

  document.getElementById("btnRejectComplaintFromDetails")
    ?.addEventListener("click", openComplaintRejectModal);

  document.getElementById("closeComplaintRejectModal")
    ?.addEventListener("click", closeComplaintRejectModal);

  document.getElementById("cancelComplaintRejectBtn")
    ?.addEventListener("click", closeComplaintRejectModal);

  document.getElementById("complaintRejectOverlay")
    ?.addEventListener("click", closeComplaintRejectModal);

  document.getElementById("confirmComplaintRejectBtn")
    ?.addEventListener("click", submitComplaintRejection);

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

function ensureComplaintHistoryDateReadableStyles() {
  return;
}

window.ensureComplaintHistoryToolbar = ensureComplaintHistoryToolbar;
