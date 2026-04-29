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

  // ✅ EMPTY STATE (UPDATED colspan = 7)
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

        <!-- SUBJECT -->
        <td>
          <span class="complaint-subject-main">${subject}</span>
        </td>

        <!-- DESCRIPTION (NEW COLUMN) -->
        <td class="complaint-description-cell" title="${escapeHtml(descriptionRaw)}">
          ${description || "-"}
        </td>

        <!-- CITIZEN -->
        <td class="complaint-citizen">
          ${citizen}
        </td>

        <!-- BARANGAY -->
        <td>
          <span class="barangay-badge">${barangay}</span>
        </td>

        <!-- STATUS -->
        <td>
          ${getComplaintStatusBadge(status)}
        </td>

        <!-- DATE -->
        <td class="complaint-date">
          ${formatDate(item.created_at)}
        </td>

        <!-- ACTION -->
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
// COMPLAINT DETAILS MODAL
// =========================

function openComplaintModal(data) {
  currentComplaint = data;

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  setText("complaintModalSubject", data.subject || "-");
  setText("complaintModalDescription", data.description || "-");
  setText("complaintModalCitizenName", data.citizen_name || "-");
  setText("complaintModalUsername", data.username || "-");
  setText("complaintModalBarangay", data.assigned_barangay || "-");
  setText("complaintModalStatus", data.status || "-");
  setText("complaintModalCreatedAt", formatModalDateTime(data.created_at));

  const lat = data.latitude ?? "-";
  const lng = data.longitude ?? "-";
  setText("complaintModalCoordinates", `${lat}, ${lng}`);

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

  document.getElementById("complaintDetailsModal")?.classList.remove("hidden");
}

function closeComplaintModal() {
  document.getElementById("complaintDetailsModal")?.classList.add("hidden");
}

function closeComplaintMapModal() {
  document.getElementById("complaintMapModal")?.classList.add("hidden");
}

// =========================
// COMPLAINT MAP MODAL
// =========================

async function openComplaintMapModal() {
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

  const mapModal = document.getElementById("complaintMapModal");
  mapModal?.classList.remove("hidden");

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
    document.getElementById("complaintDetailsModal")?.classList.add("hidden");
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

    document.getElementById("complaintMapModal")?.classList.add("hidden");
    document.getElementById("complaintDetailsModal")?.classList.add("hidden");

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
  document.getElementById("complaintHistoryModal")?.classList.remove("hidden");
  loadComplaintHistory();
}

function closeComplaintHistoryModal() {
  document.getElementById("complaintHistoryModal")?.classList.add("hidden");
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

  modal.classList.remove("hidden");
}

function closeComplaintResolutionModal() {
  const modal = document.getElementById("complaintResolutionModal");
  if (!modal) return;

  modal.classList.add("hidden");
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
  document.getElementById("btnRefreshComplaints")
    ?.addEventListener("click", loadComplaints);

  document.getElementById("btnOpenComplaintMap")
    ?.addEventListener("click", openComplaintMapModal);

  document.getElementById("btnValidateForwardComplaint")
    ?.addEventListener("click", validateAndForwardComplaint);

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
}
