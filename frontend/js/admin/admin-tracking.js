function initializeTruckMap() {
  const mapContainer = document.getElementById("truckMap");
  if (!mapContainer) return;
  if (isTruckMapInitialized && truckMap) return;

  truckMap = L.map("truckMap").setView([6.1164, 125.1716], 13);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(truckMap);

  isTruckMapInitialized = true;
}

/* =========================================================
   OFFLINE-SAFE TRACKING UI HELPERS
   Works with the mobile offline queue:
   - "Active" = live GPS points are reaching the server.
   - "Sync pending" = session is still active, but phone signal is weak/offline.
   - Route redraws as one full route once queued mobile points sync.
========================================================= */

const TRACKING_LIVE_WINDOW_MS = 60 * 1000;
const TRACKING_SYNC_PENDING_WINDOW_MS = 5 * 60 * 1000;
const TRACKING_ROUTE_GAP_MS = 90 * 1000;

function parseTrackingDate(value) {
  if (!value) return null;

  const text = String(value).trim();
  if (!text) return null;

  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const date = new Date(normalized);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function formatTrackingTimeSafe(value) {
  try {
    if (typeof formatTrackingTime === "function") {
      return formatTrackingTime(value);
    }
  } catch (error) {
    // Fall back below.
  }

  const date = parseTrackingDate(value);
  if (!date) return "--";

  return date.toLocaleString();
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

function getTrackingStatusMeta(truck) {
  const rawStatus = String(truck?.truck_status || truck?.status || "").toLowerCase();
  const sessionStatus = String(truck?.session_status || "").toLowerCase();

  /*
    Prefer backend-computed status when available.
    This allows the web UI to show different warnings for:
    - GPS Off / no live GPS points
    - Sync Pending / weak mobile signal
    - Live / normal tracking
  */
  const serverKey = String(
    truck?.tracking_status_key ||
    truck?.tracking_warning_key ||
    truck?.gps_status ||
    truck?.sync_status ||
    ""
  ).toLowerCase();

  if (sessionStatus === "stopped" || sessionStatus === "auto_stopped" || serverKey === "stopped") {
    return {
      key: "stopped",
      label: "Stopped",
      className: "stopped",
      description: "Tracking session has ended."
    };
  }

  if (
    serverKey.includes("gps_off") ||
    serverKey.includes("tracking_off") ||
    serverKey.includes("no_gps")
  ) {
    return {
      key: "gps_off",
      label: "GPS off",
      className: "gps-off",
      description: "GPS tracking is turned off. No live route points are being recorded."
    };
  }

  if (
    serverKey.includes("sync_pending") ||
    serverKey.includes("weak_signal") ||
    serverKey.includes("pending")
  ) {
    return {
      key: "sync_pending",
      label: "Sync pending",
      className: "sync-pending",
      description: "GPS may still be on, but mobile signal is weak. Route points will continue after the phone syncs."
    };
  }

  if (serverKey.includes("live") || serverKey === "active" || serverKey === "on") {
    return {
      key: "active",
      label: "Live",
      className: "active",
      description: "Live GPS signal is syncing normally."
    };
  }

  const lastUpdateValue = getTruckLastUpdateValue(truck);
  const lastDate = parseTrackingDate(lastUpdateValue);
  const ageMs = lastDate ? Date.now() - lastDate.getTime() : Number.POSITIVE_INFINITY;

  if (rawStatus === "active" && ageMs <= TRACKING_LIVE_WINDOW_MS) {
    return {
      key: "active",
      label: "Live",
      className: "active",
      description: "Live GPS signal is syncing normally."
    };
  }

  if (ageMs <= TRACKING_SYNC_PENDING_WINDOW_MS) {
    return {
      key: "sync_pending",
      label: "Sync pending",
      className: "sync-pending",
      description: "GPS may still be on, but mobile signal is weak. Route points will continue after the phone syncs."
    };
  }

  return {
    key: "gps_off",
    label: "GPS off",
    className: "gps-off",
    description: "GPS tracking is turned off or no live GPS points are being recorded."
  };
}

function getTrackingSignalSummary(trucks) {
  const safeTrucks = Array.isArray(trucks) ? trucks : [];
  const liveCount = safeTrucks.filter((truck) => getTrackingStatusMeta(truck).key === "active").length;
  const pendingCount = safeTrucks.filter((truck) => getTrackingStatusMeta(truck).key === "sync_pending").length;
  const gpsOffCount = safeTrucks.filter((truck) => getTrackingStatusMeta(truck).key === "gps_off").length;

  if (!safeTrucks.length) {
    return {
      text: "No active sessions",
      className: "idle"
    };
  }

  const parts = [];

  if (liveCount > 0) parts.push(`${liveCount} live`);
  if (pendingCount > 0) parts.push(`${pendingCount} sync pending`);
  if (gpsOffCount > 0) parts.push(`${gpsOffCount} GPS off`);

  if (gpsOffCount > 0) {
    return {
      text: parts.join(" • "),
      className: "danger"
    };
  }

  if (pendingCount > 0) {
    return {
      text: parts.join(" • "),
      className: "warning"
    };
  }

  return {
    text: parts.join(" • ") || "No live GPS",
    className: liveCount > 0 ? "good" : "idle"
  };
}

function updateTrackingSummaryCards(trucks) {
  const safeTrucks = Array.isArray(trucks) ? trucks : [];
  const activeTruckCount = document.getElementById("activeTruckCount");
  const trackingSignalStatus = document.getElementById("trackingSignalStatus");

  if (activeTruckCount) {
    /*
      Count active tracking sessions, not only currently live signal.
      This prevents the web dashboard from looking like tracking stopped
      when the phone simply has weak mobile data.
    */
    activeTruckCount.textContent = safeTrucks.length;
  }

  if (trackingSignalStatus) {
    const summary = getTrackingSignalSummary(safeTrucks);
    trackingSignalStatus.textContent = summary.text;
    trackingSignalStatus.className = `tracking-signal-status ${summary.className}`;
  }
}

function updateTrackingRouteStats(routeLogs = []) {
  const routePointCount = document.getElementById("trackingRoutePointCount");
  if (routePointCount) {
    routePointCount.textContent = String(Array.isArray(routeLogs) ? routeLogs.length : 0);
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

function getRoutePointTimestamp(point) {
  const date = parseTrackingDate(point?.recorded_at || point?.created_at || point?.createdAt);
  return date ? date.getTime() : 0;
}

function buildTrackingMarkerIcon(statusMeta) {
  const color = statusMeta?.key === "active"
    ? "#198754"
    : statusMeta?.key === "sync_pending"
      ? "#f59e0b"
      : statusMeta?.key === "gps_off"
        ? "#dc3545"
        : "#6c757d";

  const pulse = statusMeta?.key === "active"
    ? "tracking-marker-pulse"
    : "";

  return L.divIcon({
    className: `custom-truck-marker ${statusMeta?.className || ""}`,
    html: `
      <div class="truck-marker-shell ${pulse}" style="
        width:22px;
        height:22px;
        border-radius:50%;
        background:${color};
        border:3px solid #ffffff;
        box-shadow:0 3px 12px rgba(0,0,0,0.28);
      "></div>
    `,
    iconSize: [22, 22],
    iconAnchor: [11, 11]
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
  try {
    const res = await fetch(getTrackingActiveApiUrl());
    const data = await res.json();

    const trucks = Array.isArray(data)
      ? data
      : (data.data || []);

    renderActiveTruckList(trucks);
    updateTruckMarkers(trucks);
    updateTrackingSummaryCards(trucks);

    if (selectedSessionId) {
      const selectedTruck = trucks.find(
        (truck) => String(truck.session_id) === String(selectedSessionId)
      );

      if (!selectedTruck) {
        resetTrackingView();
        return;
      }

      await loadTruckRoute(selectedSessionId, { keepView: true });

      const selectedLabel = document.getElementById("selectedTruckLabel");
      if (selectedLabel) {
        const statusMeta = getTrackingStatusMeta(selectedTruck);
        selectedLabel.textContent = `Truck ${selectedTruck.truck_id} (${statusMeta.label})`;
      }

      const lastUpdated = document.getElementById("trackingLastUpdated");
      if (lastUpdated) {
        lastUpdated.textContent = formatTrackingTimeSafe(
          selectedTruck.location_last_updated || selectedTruck.last_updated_at
        );
      }
    } else {
      updateTrackingRouteStats([]);
    }
  } catch (error) {
    console.error("Error loading active trucks:", error);

    const trackingSignalStatus = document.getElementById("trackingSignalStatus");
    if (trackingSignalStatus) {
      trackingSignalStatus.textContent = "Unable to refresh";
      trackingSignalStatus.className = "tracking-signal-status warning";
    }
  }
}

function renderActiveTruckList(trucks) {
  const container = document.getElementById("activeTruckList");
  if (!container) return;

  if (!Array.isArray(trucks) || !trucks.length) {
    container.innerHTML = `
      <div class="empty-state">
        No active tracking sessions yet.
      </div>
    `;
    return;
  }

  container.innerHTML = trucks.map((truck) => {
    const isSelected = String(selectedSessionId) === String(truck.session_id);
    const statusMeta = getTrackingStatusMeta(truck);
    const lastUpdated = getTruckLastUpdateValue(truck);

    return `
      <div
        class="active-truck-item ${isSelected ? "active" : ""} ${statusMeta.className}"
        onclick="selectTruck(${truck.session_id}, '${escapeHtml(truck.truck_id)}')"
      >
        <div class="truck-list-topline">
          <strong>Truck ${escapeHtml(truck.truck_id || "-")}</strong>
          <small class="truck-status-label ${statusMeta.className}">${escapeHtml(statusMeta.label)}</small>
        </div>
        <small>${escapeHtml(truck.enforcer_name || "-")}</small><br>
        <small class="truck-sync-note">${escapeHtml(statusMeta.description)}</small><br>
        <small class="truck-last-sync">Last sync: ${escapeHtml(formatTrackingTimeSafe(lastUpdated))}</small>
      </div>
    `;
  }).join("");
}

function updateTruckMarkers(trucks) {
  if (!truckMap) return;

  Object.keys(truckMarkers).forEach((id) => {
    if (truckMarkers[id]) {
      truckMap.removeLayer(truckMarkers[id]);
    }
  });
  truckMarkers = {};

  if (!selectedSessionId) {
    return;
  }

  const selectedTruck = trucks.find(
    (truck) => String(truck.session_id) === String(selectedSessionId)
  );

  if (!selectedTruck) {
    return;
  }

  const { latitude, longitude, session_id, truck_id } = selectedTruck;

  if (latitude == null || longitude == null) return;

  const statusMeta = getTrackingStatusMeta(selectedTruck);
  const marker = L.marker([latitude, longitude], {
    icon: buildTrackingMarkerIcon(statusMeta)
  }).addTo(truckMap);

  marker.bindPopup(`
    <strong>Truck ${escapeHtml(truck_id || "-")}</strong><br>
    Status: ${escapeHtml(statusMeta.label)}<br>
    ${escapeHtml(statusMeta.description)}<br>
    Last sync: ${escapeHtml(formatTrackingTimeSafe(getTruckLastUpdateValue(selectedTruck)))}
  `);

  truckMarkers[session_id] = marker;
}

async function loadTruckRoute(sessionId, options = {}) {
  if (!truckMap) return;

  const { keepView = false } = options;

  try {
    const res = await fetch(getTrackingRouteApiUrl(sessionId));
    const data = await res.json();

    const routeLogs = Array.isArray(data?.data?.route_logs)
      ? data.data.route_logs
      : [];

    const orderedRouteLogs = routeLogs
      .slice()
      .sort((a, b) => {
        const aTime = getRoutePointTimestamp(a);
        const bTime = getRoutePointTimestamp(b);
        return aTime - bTime;
      });

    if (selectedRoutePolyline) {
      truckMap.removeLayer(selectedRoutePolyline);
      selectedRoutePolyline = null;
    }

    clearTrackingGapPolylines();

    if (selectedStartMarker) {
      truckMap.removeLayer(selectedStartMarker);
      selectedStartMarker = null;
    }

    if (selectedCurrentMarker) {
      truckMap.removeLayer(selectedCurrentMarker);
      selectedCurrentMarker = null;
    }

    updateTrackingRouteStats(orderedRouteLogs);

    if (!orderedRouteLogs.length) {
      const lastUpdated = document.getElementById("trackingLastUpdated");
      if (lastUpdated) {
        lastUpdated.textContent = "--";
      }
      return;
    }

    const routePoints = orderedRouteLogs
      .filter((p) => p.latitude != null && p.longitude != null)
      .map((p) => ({
        ...p,
        lat: parseFloat(p.latitude),
        lng: parseFloat(p.longitude),
        timestamp: getRoutePointTimestamp(p)
      }))
      .filter((p) => !Number.isNaN(p.lat) && !Number.isNaN(p.lng));

    const latlngs = routePoints.map((p) => [p.lat, p.lng]);

    if (!latlngs.length) return;

    if (latlngs.length >= 2) {
      selectedRoutePolyline = L.polyline(latlngs, {
        color: "#0d6efd",
        weight: 5,
        opacity: 0.9
      }).addTo(truckMap);

      for (let i = 1; i < routePoints.length; i++) {
        const prev = routePoints[i - 1];
        const current = routePoints[i];

        if (prev.timestamp && current.timestamp && current.timestamp - prev.timestamp > TRACKING_ROUTE_GAP_MS) {
          const gapLine = L.polyline(
            [
              [prev.lat, prev.lng],
              [current.lat, current.lng]
            ],
            {
              color: "#0d6efd",
              weight: 4,
              opacity: 0.65,
              dashArray: "8, 10"
            }
          ).addTo(truckMap);

          gapLine.bindPopup("Estimated/connected route segment after mobile sync gap.");
          window.trackingGapPolylines.push(gapLine);
        }
      }
    }

    const startPoint = latlngs[0];
    const currentPoint = latlngs[latlngs.length - 1];

    const startIcon = L.divIcon({
      className: "custom-start-marker",
      html: `
        <div style="
          width:18px;
          height:18px;
          border-radius:50%;
          background:#198754;
          border:3px solid #ffffff;
          box-shadow:0 2px 8px rgba(0,0,0,0.25);
        "></div>
      `,
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });

    const currentIcon = L.divIcon({
      className: "custom-current-marker",
      html: `
        <div style="
          width:20px;
          height:20px;
          border-radius:50%;
          background:#dc3545;
          border:3px solid #ffffff;
          box-shadow:0 2px 10px rgba(0,0,0,0.3);
        "></div>
      `,
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });

    const routeNotice = getTrackingRouteNotice(orderedRouteLogs);

    selectedStartMarker = L.marker(startPoint, { icon: startIcon })
      .addTo(truckMap)
      .bindPopup("Start Point");

    selectedCurrentMarker = L.marker(currentPoint, { icon: currentIcon })
      .addTo(truckMap)
      .bindPopup(routeNotice ? `Current Location<br>${escapeHtml(routeNotice)}` : "Current Location");

    if (truckMarkers[sessionId]) {
      truckMarkers[sessionId].setLatLng(currentPoint);
    }

    if (!keepView) {
      if (selectedRoutePolyline) {
        truckMap.fitBounds(selectedRoutePolyline.getBounds(), {
          padding: [20, 20]
        });
      } else {
        truckMap.setView(currentPoint, 17);
      }
    }

    const lastUpdated = document.getElementById("trackingLastUpdated");
    if (lastUpdated) {
      const lastPoint = orderedRouteLogs[orderedRouteLogs.length - 1];
      lastUpdated.textContent = formatTrackingTimeSafe(
        lastPoint.recorded_at || lastPoint.created_at || lastPoint.createdAt
      );
    }

    const trackingSignalStatus = document.getElementById("trackingSignalStatus");
    if (trackingSignalStatus && routeNotice) {
      trackingSignalStatus.textContent = routeNotice;
      trackingSignalStatus.className = "tracking-signal-status warning";
    }
  } catch (error) {
    console.error("Error loading route:", error);
  }
}

function resetTrackingView() {
  if (selectedRoutePolyline && truckMap) {
    truckMap.removeLayer(selectedRoutePolyline);
    selectedRoutePolyline = null;
  }

  clearTrackingGapPolylines();

  if (selectedStartMarker && truckMap) {
    truckMap.removeLayer(selectedStartMarker);
    selectedStartMarker = null;
  }

  if (selectedCurrentMarker && truckMap) {
    truckMap.removeLayer(selectedCurrentMarker);
    selectedCurrentMarker = null;
  }

  Object.keys(truckMarkers).forEach((id) => {
    if (truckMarkers[id] && truckMap) {
      truckMap.removeLayer(truckMarkers[id]);
    }
  });
  truckMarkers = {};

  selectedSessionId = null;
  selectedTruckId = null;

  const selectedLabel = document.getElementById("selectedTruckLabel");
  if (selectedLabel) {
    selectedLabel.textContent = "None";
  }

  const lastUpdated = document.getElementById("trackingLastUpdated");
  if (lastUpdated) {
    lastUpdated.textContent = "--";
  }

  updateTrackingRouteStats([]);

  const trackingSignalStatus = document.getElementById("trackingSignalStatus");
  if (trackingSignalStatus) {
    trackingSignalStatus.textContent = "No selected truck";
    trackingSignalStatus.className = "tracking-signal-status idle";
  }

  updateTrackingActionButtons();
  loadActiveTrucks();
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
      fetch(getTrackingActiveApiUrl())
    ]);

    const notifData = await notifRes.json();
    const trackingData = await trackingRes.json();

    const allAlerts = Array.isArray(notifData)
      ? notifData
      : (notifData.data || notifData.notifications || []);

    const activeTrucks = Array.isArray(trackingData)
      ? trackingData
      : (trackingData.data || []);

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
      <div class="summary-item">
        <span>No active trucks available.</span>
      </div>
    `;
  } else {
    modalTruckStatusList.innerHTML = activeTrucks.map((truck) => `
      <div class="truck-analytics-feed-item">
        <div class="truck-analytics-feed-title">Truck ${escapeHtml(truck.truck_id || "-")}</div>
        <div class="truck-analytics-feed-message">
          Enforcer: ${escapeHtml(truck.enforcer_name || "-")}<br>
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
      <div class="summary-item">
        <span>No truck distance data available yet.</span>
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
      fetch(getTrackingActiveApiUrl())
    ]);

    const notifData = await notifRes.json();
    const trackingData = await trackingRes.json();

    const alerts = Array.isArray(notifData)
      ? notifData
      : (notifData.data || notifData.notifications || []);

    const activeTrucks = Array.isArray(trackingData)
      ? trackingData
      : (trackingData.data || []);

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

function selectTruck(sessionId, truckId) {
  selectedSessionId = sessionId;
  selectedTruckId = truckId;

  const selectedLabel = document.getElementById("selectedTruckLabel");
  if (selectedLabel) {
    selectedLabel.textContent = `Truck ${truckId}`;
  }

  updateTrackingActionButtons();
  loadActiveTrucks();
  loadTruckRoute(sessionId);
}

function updateTrackingActionButtons() {
  const forceStopBtn = document.getElementById("forceStopTruckBtn");
  const resetBtn = document.getElementById("resetTrackingViewBtn");

  if (forceStopBtn) {
    forceStopBtn.disabled = !selectedSessionId;
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
    const response = await fetch(getTrackingForceStopApiUrl(sessionId), {
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

function startTrackingAutoRefresh() {
  if (trackingPollInterval) {
    clearInterval(trackingPollInterval);
  }

  loadActiveTrucks();

  trackingPollInterval = setInterval(() => {
    loadActiveTrucks();
  }, 5000);
}

function stopTrackingAutoRefresh() {
  if (trackingPollInterval) {
    clearInterval(trackingPollInterval);
    trackingPollInterval = null;
  }
}

window.selectTruck = selectTruck;

// =============================
// TRACKING REPORTS
// =============================

function getTrackingReportsApiUrl() {
  const apiBase =
    window.APP_CONFIG?.API_BASE_URL ||
    window.API_BASE ||
    "http://192.168.1.37:8081/api";

  return `${apiBase.replace(/\/$/, "")}/tracking/reports`;
}

function getTrackingReportDetailsApiUrl(sessionId) {
  return `${getTrackingReportsApiUrl()}/${encodeURIComponent(sessionId)}`;
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
    const res = await fetch(getTrackingReportsApiUrl(), {
      headers: {
        Accept: "application/json"
      }
    });

    const data = await res.json();

    if (!res.ok || data.success === false) {
      throw new Error(data.message || "Failed to load tracking reports.");
    }

    const reports = Array.isArray(data)
      ? data
      : Array.isArray(data.data)
        ? data.data
        : [];

    if (!reports.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="empty-state">No tracking reports found.</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = reports.map((r) => {
      const sessionId = r.id || r.session_id;

      return `
        <tr>
          <td>${escapeHtml(r.truck_id || "-")}</td>
          <td>${escapeHtml(r.enforcer_name || "-")}</td>
          <td>${formatTrackingTime(r.started_at)}</td>
          <td>${r.ended_at ? formatTrackingTime(r.ended_at) : "Still Active"}</td>
          <td>${escapeHtml(r.session_status || r.status || "-")}</td>
          <td>${Number(r.session_distance_km || r.total_distance_km || 0).toFixed(2)} km</td>
          <td>
            <button type="button" class="view-all-btn small" onclick="viewTrackingReport('${escapeHtml(String(sessionId))}')">
              View
            </button>
          </td>
        </tr>
      `;
    }).join("");

  } catch (error) {
    console.error("loadTrackingReports error:", error);

    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-state">Failed to load reports.</td>
      </tr>
    `;
  }
}

async function viewTrackingReport(sessionId) {
  if (!sessionId) return;

  try {
    const res = await fetch(getTrackingReportDetailsApiUrl(sessionId), {
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

    reportMap = L.map("trackingReportMap").setView([6.1164, 125.1716], 13);

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
    }).addTo(reportMap);

    const logs = Array.isArray(data?.route_logs)
      ? data.route_logs
      : Array.isArray(data?.logs)
        ? data.logs
        : [];

    if (!logs.length) {
      mapContainer.innerHTML = `<div class="empty-state">No route logs available.</div>`;
      return;
    }

    const latlngs = logs
      .map((p) => [parseFloat(p.latitude), parseFloat(p.longitude)])
      .filter(([lat, lng]) => !Number.isNaN(lat) && !Number.isNaN(lng));

    if (!latlngs.length) {
      mapContainer.innerHTML = `<div class="empty-state">No valid route coordinates available.</div>`;
      return;
    }

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
  }
}

window.loadTrackingReports = loadTrackingReports;
window.viewTrackingReport = viewTrackingReport;
window.openTrackingReportsModal = openTrackingReportsModal;
window.closeTrackingReportsModal = closeTrackingReportsModal;
window.closeTrackingReportModal = closeTrackingReportModal;
