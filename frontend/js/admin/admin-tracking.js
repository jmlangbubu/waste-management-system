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

async function loadActiveTrucks() {
  try {
    const res = await fetch(getTrackingActiveApiUrl());
    const data = await res.json();

    const trucks = Array.isArray(data)
      ? data
      : (data.data || []);

    // ✅ active count only
    const activeOnly = trucks.filter(
      (truck) => String(truck.truck_status || "").toLowerCase() === "active"
    );

    renderActiveTruckList(trucks);
    updateTruckMarkers(trucks);

    const activeTruckCount = document.getElementById("activeTruckCount");
    if (activeTruckCount) {
      activeTruckCount.textContent = activeOnly.length;
    }

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
        const statusLabel = String(selectedTruck.truck_status || "").toLowerCase() === "active"
          ? "Active"
          : "Offline";

        selectedLabel.textContent = `Truck ${selectedTruck.truck_id} (${statusLabel})`;
      }

      const lastUpdated = document.getElementById("trackingLastUpdated");
      if (lastUpdated) {
        lastUpdated.textContent = formatTrackingTime(
          selectedTruck.location_last_updated || selectedTruck.last_updated_at
        );
      }
    }
  } catch (error) {
    console.error("Error loading active trucks:", error);
  }
}

function renderActiveTruckList(trucks) {
  const container = document.getElementById("activeTruckList");
  if (!container) return;

  if (!Array.isArray(trucks) || !trucks.length) {
    container.innerHTML = `<div class="empty-state">No tracked trucks</div>`;
    return;
  }

  container.innerHTML = trucks.map((truck) => {
    const isSelected = String(selectedSessionId) === String(truck.session_id);
    const status = String(truck.truck_status || "offline").toLowerCase();
    const statusLabel = status === "active" ? "Active" : "Offline";

    return `
      <div
        class="active-truck-item ${isSelected ? "active" : ""} ${status === "offline" ? "offline" : ""}"
        onclick="selectTruck(${truck.session_id}, '${escapeHtml(truck.truck_id)}')"
      >
        <strong>Truck ${escapeHtml(truck.truck_id)}</strong><br>
        <small>${escapeHtml(truck.enforcer_name || "-")}</small><br>
        <small class="truck-status-label ${status}">${statusLabel}</small>
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

  const marker = L.marker([latitude, longitude]).addTo(truckMap);
  marker.bindPopup(`Truck ${truck_id}`);
  truckMarkers[session_id] = marker;
}

async function loadTruckRoute(sessionId, options = {}) {
  if (!truckMap) return;

  const { keepView = false } = options;

  try {
    const res = await fetch(getTrackingRouteApiUrl(sessionId));
    const data = await res.json();

    // ✅ actual backend shape: { success: true, data: { session, route_logs } }
    const routeLogs = Array.isArray(data?.data?.route_logs)
      ? data.data.route_logs
      : [];

    if (selectedRoutePolyline) {
      truckMap.removeLayer(selectedRoutePolyline);
      selectedRoutePolyline = null;
    }

    if (selectedStartMarker) {
      truckMap.removeLayer(selectedStartMarker);
      selectedStartMarker = null;
    }

    if (selectedCurrentMarker) {
      truckMap.removeLayer(selectedCurrentMarker);
      selectedCurrentMarker = null;
    }

    if (!routeLogs.length) {
      const lastUpdated = document.getElementById("trackingLastUpdated");
      if (lastUpdated) {
        lastUpdated.textContent = "--";
      }
      return;
    }

    const latlngs = routeLogs
      .filter((p) => p.latitude != null && p.longitude != null)
      .map((p) => [parseFloat(p.latitude), parseFloat(p.longitude)])
      .filter(([lat, lng]) => !Number.isNaN(lat) && !Number.isNaN(lng));

    if (!latlngs.length) return;

    if (latlngs.length >= 2) {
      selectedRoutePolyline = L.polyline(latlngs, {
        color: "#0d6efd",
        weight: 5,
        opacity: 0.9
      }).addTo(truckMap);
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

    selectedStartMarker = L.marker(startPoint, { icon: startIcon })
      .addTo(truckMap)
      .bindPopup("Start Point");

    selectedCurrentMarker = L.marker(currentPoint, { icon: currentIcon })
      .addTo(truckMap)
      .bindPopup("Current Location");

    // sync active truck marker too
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
      const lastPoint = routeLogs[routeLogs.length - 1];
      lastUpdated.textContent = formatTrackingTime(
        lastPoint.recorded_at || lastPoint.created_at || lastPoint.createdAt
      );
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

async function loadTrackingReports() {
  const tbody = document.getElementById("trackingReportsTableBody");
  if (!tbody) return;

  tbody.innerHTML = `
    <tr>
      <td colspan="7" class="loading-state">Loading reports...</td>
    </tr>
  `;

  try {
    const res = await fetch("http://localhost:8081/api/tracking/reports", {
      headers: {
        "Accept": "application/json"
      }
    });

    const data = await res.json();
    const reports = Array.isArray(data.data) ? data.data : [];

    if (!reports.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="empty-state">No tracking reports found.</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = reports.map((r) => `
      <tr>
        <td>${escapeHtml(r.truck_id || "-")}</td>
        <td>${escapeHtml(r.enforcer_name || "-")}</td>
        <td>${formatTrackingTime(r.started_at)}</td>
        <td>${r.ended_at ? formatTrackingTime(r.ended_at) : "Still Active"}</td>
        <td>${escapeHtml(r.session_status || "-")}</td>
        <td>${Number(r.session_distance_km || 0).toFixed(2)} km</td>
        <td>
          <button type="button" class="view-all-btn small" onclick="viewTrackingReport(${r.id})">
            View
          </button>
        </td>
      </tr>
    `).join("");

  } catch (error) {
    console.error("loadTrackingReports error:", error);

    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-state">Failed to load reports.</td>
      </tr>
    `;
  }
}

window.loadTrackingReports = loadTrackingReports;

window.loadTrackingReports = loadTrackingReports;

async function viewTrackingReport(sessionId) {
  try {
    const res = await fetch(`http://localhost:8081/api/tracking/reports/${sessionId}`, {
      headers: {
        "Accept": "application/json"
      }
    });

    const data = await res.json();
    openTrackingReportModal(data.data);

  } catch (error) {
    console.error("viewTrackingReport error:", error);
    showToast?.("Failed to load tracking report details.", "error");
  }
}

window.viewTrackingReport = viewTrackingReport;

let reportMap = null;

function openTrackingReportModal(data) {
  const modal = document.getElementById("trackingReportModal");
  if (!modal) return;

  modal.classList.remove("hidden");

  setTimeout(() => {
    if (reportMap) {
      reportMap.remove();
    }

    reportMap = L.map("trackingReportMap").setView([6.1164, 125.1716], 13);

    // TILE (fixed 403)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png')
      .addTo(reportMap);

    const logs = data.route_logs || [];
    if (!logs.length) return;

    const latlngs = logs
      .map(p => [parseFloat(p.latitude), parseFloat(p.longitude)])
      .filter(([lat, lng]) => !isNaN(lat) && !isNaN(lng));

    if (!latlngs.length) return;

    // ✅ ICONS
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

    // ✅ START (GREEN)
    L.marker(latlngs[0], { icon: startIcon })
      .addTo(reportMap)
      .bindPopup("Start Point");

    // ✅ END (RED)
    L.marker(latlngs[latlngs.length - 1], { icon: endIcon })
      .addTo(reportMap)
      .bindPopup("End Point");

    // ✅ ROUTE LINE
    L.polyline(latlngs, {
      color: "#0d6efd",
      weight: 5
    }).addTo(reportMap);

    reportMap.fitBounds(latlngs);

  }, 200);
}

function closeTrackingReportModal() {
  const modal = document.getElementById("trackingReportModal");
  if (modal) modal.classList.add("hidden");
}

window.viewTrackingReport = viewTrackingReport;
window.closeTrackingReportModal = closeTrackingReportModal;

function openTrackingReportsModal() {
  const modal = document.getElementById("trackingReportsModal");
  console.log("Opening tracking reports modal:", modal);

  if (!modal) {
    alert("trackingReportsModal not found in HTML");
    return;
  }

  modal.classList.remove("hidden");
  loadTrackingReports();
}

function closeTrackingReportsModal() {
  const modal = document.getElementById("trackingReportsModal");
  if (modal) modal.classList.add("hidden");
}

window.openTrackingReportsModal = openTrackingReportsModal;
window.closeTrackingReportsModal = closeTrackingReportsModal;