/* =========================
   APPOINTMENTS MODULE
========================= */

function normalizeAppointmentLifecycleValue(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
}

function isSwmOrientationAppointmentRecord(app = {}) {
  return String(app.purpose || app.waste_type || "")
    .trim()
    .toLowerCase() === "swm orientation & clearance";
}

function isOrientationCompletedForAppointmentModule(app = {}) {
  if (!isSwmOrientationAppointmentRecord(app)) return false;

  const appointmentStatus = normalizeAppointmentLifecycleValue(app.status);
  const orientationStatus = normalizeAppointmentLifecycleValue(
    app.orientation_status || app.orientation_qr_status || ""
  );

  return Boolean(
    appointmentStatus === "completed" ||
    orientationStatus === "completed_orientation" ||
    orientationStatus === "completed" ||
    orientationStatus === "no_show" ||
    orientationStatus === "no-show" ||
    orientationStatus === "noshow" ||
    orientationStatus === "incomplete_orientation" ||
    orientationStatus === "incomplete" ||
    Number(app.orientation_completed || 0) === 1 ||
    app.orientation_completed_at
  );
}

function getVisibleActiveAppointments(records = []) {
  return (Array.isArray(records) ? records : []).filter((app) => {
    return !isOrientationCompletedForAppointmentModule(app);
  });
}

function getAppointmentHistoryWithCompletedOrientation(activeRecords = [], historyRecords = []) {
  const completedFromActive = (Array.isArray(activeRecords) ? activeRecords : [])
    .filter((app) => isOrientationCompletedForAppointmentModule(app))
    .map((app) => ({
      ...app,
      status: "completed"
    }));

  const combined = [
    ...(Array.isArray(historyRecords) ? historyRecords : []),
    ...completedFromActive
  ];

  const seen = new Set();

  return combined.filter((app) => {
    const key = `${app.appointment_code || ""}:${app.id || ""}`;

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

async function loadAppointments() {
  try {
    const [activeRes, historyRes] = await Promise.all([
      fetch(getActiveAppointmentsApiUrl(), {
        headers: {
          "Accept": "application/json"
        }
      }),
      fetch(getAppointmentHistoryApiUrl(), {
        headers: {
          "Accept": "application/json"
        }
      })
    ]);

    const activeRawText = await activeRes.text();
    const historyRawText = await historyRes.text();

    let activeData = {};
    let historyData = {};

    try {
      activeData = activeRawText ? JSON.parse(activeRawText) : {};
    } catch (parseError) {
      console.error("Active appointments raw response:", activeRawText);
      throw new Error(
        `Active appointments API did not return JSON. Response starts with: ${activeRawText.slice(0, 200)}`
      );
    }

    try {
      historyData = historyRawText ? JSON.parse(historyRawText) : {};
    } catch (parseError) {
      console.error("Appointment history raw response:", historyRawText);
      throw new Error(
        `Appointment history API did not return JSON. Response starts with: ${historyRawText.slice(0, 200)}`
      );
    }

    if (!activeRes.ok) {
      throw new Error(activeData.message || "Failed to load active appointments.");
    }

    if (!historyRes.ok) {
      throw new Error(historyData.message || "Failed to load appointment history.");
    }

    const activeAppointments = Array.isArray(activeData)
      ? activeData
      : (activeData.appointments || activeData.data || []);

    const historyAppointments = Array.isArray(historyData)
      ? historyData
      : (historyData.history || historyData.data || []);

    /*
      Safety filter:
      If an orientation is already completed but the backend still returns it
      in active appointments, remove it from Active and push it to History.
    */
    const visibleActiveAppointments = getVisibleActiveAppointments(activeAppointments);
    const mergedHistoryAppointments = getAppointmentHistoryWithCompletedOrientation(
      activeAppointments,
      historyAppointments
    );

    const sortedActiveAppointments = sortAppointmentRecordsByReference(visibleActiveAppointments);
    const sortedHistoryAppointments = sortAppointmentRecordsByReference(mergedHistoryAppointments);

    allAppointments = sortAppointmentRecordsByReference([
      ...sortedActiveAppointments,
      ...sortedHistoryAppointments
    ]);

    renderAppointmentsTable(sortedActiveAppointments);
    appointmentHistoryRecords = sortedHistoryAppointments;

    renderAppointmentHistory(appointmentHistoryRecords, true);
  } catch (error) {
    console.error("Error loading appointments:", error);
    allAppointments = [];
    renderAppointmentsTable([]);
    renderAppointmentHistory([]);
  }
}

async function handleAppointmentDecision(id, action) {
  const personnel_name =
    currentUser?.fullName ||
    currentUser?.username ||
    "WMO Admin";

  const actionLabel = action === "accept" ? "accept" : "reject";
  const confirmed = window.confirm(`Are you sure you want to ${actionLabel} this appointment?`);

  if (!confirmed) return;

  try {
    const res = await fetch(getAppointmentDecisionApiUrl(id), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        action,
        personnel_name
      })
    });

    const rawText = await res.text();
    let data = {};

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch (parseError) {
      console.error("Appointment decision raw response:", rawText);
      throw new Error(`Appointment decision API did not return JSON. Response starts with: ${rawText.slice(0, 200)}`);
    }

    if (!res.ok) {
      showToast(data.message || "Failed to update appointment", "error");
      return;
    }

    showToast(
      action === "accept"
        ? "Appointment accepted successfully"
        : "Appointment rejected successfully",
      "success"
    );

    await loadAppointments();
    await loadNotifications(false);

    if (typeof loadOrientationAppointments === "function") {
      await loadOrientationAppointments();
    }
  } catch (error) {
    console.error("Appointment decision error:", error);
    showToast(error.message || "Failed to update appointment", "error");
  }
}

window.handleAppointmentDecision = handleAppointmentDecision;

/* =========================
   LOAD PERSONNEL
========================= */

async function loadPersonnel() {
  try {
    const res = await fetch(getWebUsersApiUrl());
    const rawText = await res.text();
        let data = {};

    try {
  data = rawText ? JSON.parse(rawText) : {};
    } catch {
  console.error("Personnel raw response:", rawText);
  throw new Error("Personnel API invalid JSON");
    }

    const users = Array.isArray(data)
      ? data
      : (data.users || data.data || []);

    activePersonnel = users.filter((u) => u.role !== "citizen");
  } catch (error) {
    console.error("Error loading personnel:", error);
  }
}

/* =========================
   APPOINTMENT SORTING
========================= */

function sortAppointmentRecordsByReference(records = []) {
  if (!Array.isArray(records)) return [];

  return [...records].sort((a, b) => {
    const numberA = getAppointmentReferenceNumber(a);
    const numberB = getAppointmentReferenceNumber(b);

    if (numberA !== numberB) {
      return numberA - numberB;
    }

    const codeA = String(a?.appointment_code || "").toUpperCase();
    const codeB = String(b?.appointment_code || "").toUpperCase();

    return codeA.localeCompare(codeB, undefined, {
      numeric: true,
      sensitivity: "base"
    });
  });
}

function getAppointmentReferenceNumber(app) {
  const code = String(app?.appointment_code || "").trim();
  const numberMatch = code.match(/(\d+)\s*$/);

  if (numberMatch) {
    return Number(numberMatch[1]);
  }

  const fallbackId = Number(app?.id);

  if (Number.isFinite(fallbackId)) {
    return fallbackId;
  }

  return Number.MAX_SAFE_INTEGER;
}

/* =========================
   APPOINTMENTS RENDER
========================= */

function renderAppointmentsTable(appointments) {
  const tableBody = document.getElementById("appointmentsTableBody");
  if (!tableBody) return;

  if (!Array.isArray(appointments) || !appointments.length) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="10" class="empty-state">No active appointments found.</td>
      </tr>
    `;
    return;
  }

  const sortedAppointments = sortAppointmentRecordsByReference(
    getVisibleActiveAppointments(appointments)
  );

  if (!sortedAppointments.length) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="10" class="empty-state">No active appointments found.</td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = sortedAppointments.map((app) => {
    const displayName = app.name || app.full_name || "-";
    const displayBarangay = app.barangay || "-";
    const displayContact =
      app.contact ||
      app.contact_number ||
      app.phone ||
      app.mobile_number ||
      "-";
    const displayEmail =
      app.email ||
      app.email_address ||
      app.user_email ||
      app.client_email ||
      app.appointment_email ||
      "-";
    const displayPurpose = app.purpose || app.waste_type || "-";
    const displayDate = app.appointment_date || app.preferred_date || null;
    const displayAssigned =
      app.assigned_personnel ||
      app.assigned_personnel_name ||
      app.assigned_to ||
      "-";

    const currentStatus = String(app.status || "pending").toLowerCase().trim();

    const isPending = currentStatus === "pending" || currentStatus === "";
    const isApproved = currentStatus === "approved";
    const isRescheduled = currentStatus === "rescheduled";

    return `
      <tr>
        <td>${escapeHtml(app.appointment_code || "-")}</td>
        <td>${escapeHtml(displayName)}</td>
        <td>${escapeHtml(displayBarangay)}</td>
        <td>${escapeHtml(displayContact)}</td>
        <td>${escapeHtml(displayEmail)}</td>
        <td>${escapeHtml(displayPurpose)}</td>
        <td>
          ${formatDateTimeDisplay(displayDate)}
          ${isRescheduled ? `<small class="rescheduled-note">Updated</small>` : ""}
        </td>
        <td>${renderStatusBadge(currentStatus)}</td>
        <td>${escapeHtml(displayAssigned)}</td>
       <td>
  <div class="appointment-action-buttons">

    ${isPending ? `
      <button class="inline-action-btn assign-btn"
        onclick="handleAppointmentDecision(${app.id}, 'accept')">
        Accept
      </button>

      <button class="inline-action-btn delete-btn"
        onclick="handleAppointmentDecision(${app.id}, 'reject')">
        Reject
      </button>

      <button class="inline-action-btn warning-btn"
        onclick="handleReschedule(${app.id})">
        Reschedule
      </button>
    ` : ""}

    ${isRescheduled ? `
      <button class="inline-action-btn assign-btn"
        onclick="handleAppointmentDecision(${app.id}, 'accept')">
        Approve
      </button>

      <button class="inline-action-btn delete-btn"
        onclick="handleAppointmentDecision(${app.id}, 'reject')">
        Reject
      </button>

      <button class="inline-action-btn warning-btn"
        onclick="handleReschedule(${app.id})">
        Reschedule
      </button>
    ` : ""}

    ${isApproved ? `
      <button class="inline-action-btn warning-btn"
        onclick="handleReschedule(${app.id})">
        Reschedule
      </button>

      <button class="inline-action-btn danger-btn"
        onclick="handleCancel(${app.id})">
        Cancel
      </button>
    ` : ""}

  </div>
</td>
      </tr>
    `;
  }).join("");
}

function renderStatusBadge(status) {
  const normalized = String(status || "").toLowerCase().trim();

  if (normalized === "approved") {
    return `<span class="status-badge resolved">Approved</span>`;
  }

  if (normalized === "rejected") {
    return `<span class="status-badge rejected">Rejected</span>`;
  }

  if (normalized === "rescheduled") {
    return `<span class="status-badge forwarded">Rescheduled</span>`;
  }

  if (normalized === "cancelled") {
    return `<span class="status-badge rejected">Cancelled</span>`;
  }

  if (normalized === "completed") {
    return `<span class="status-badge resolved">Completed</span>`;
  }

  return `<span class="status-badge pending">Pending</span>`;
}

/* =========================
   APPOINTMENT MODAL PORTAL FIX
   Keeps Appointment History modal above sidebar/topbar by moving
   the existing modal DOM node to <body>. Event listeners are preserved.
========================= */

const APPOINTMENT_PORTAL_MODAL_IDS = [
  "appointmentHistoryModal"
];

function mountAppointmentModalsToBody() {
  APPOINTMENT_PORTAL_MODAL_IDS.forEach((modalId) => {
    const modal = document.getElementById(modalId);

    if (!modal) return;

    if (modal.parentElement !== document.body) {
      document.body.appendChild(modal);
    }
  });
}

window.mountAppointmentModalsToBody = mountAppointmentModalsToBody;

/* =========================
   APPOINTMENT HISTORY SEARCH STATE
========================= */

let appointmentHistoryRecords = [];
let appointmentHistorySearchQuery = "";

/* =========================
   APPOINTMENT HISTORY
========================= */

function normalizeAppointmentHistorySearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function getAppointmentEmail(app = {}) {
  return (
    app.email ||
    app.email_address ||
    app.user_email ||
    app.client_email ||
    app.appointment_email ||
    "-"
  );
}

function getAppointmentHistorySearchText(app = {}) {
  const values = [
    app.appointment_code,
    app.name,
    app.full_name,
    app.barangay,
    app.contact,
    app.contact_number,
    app.phone,
    app.mobile_number,
    getAppointmentEmail(app),
    app.purpose,
    app.waste_type,
    app.appointment_date,
    app.preferred_date,
    app.status,
    app.assigned_personnel,
    app.assigned_personnel_name,
    app.assigned_to,
    app.updated_at,
    app.created_at
  ];

  return normalizeAppointmentHistorySearchText(values.join(" "));
}

function getFilteredAppointmentHistory(records = []) {
  const query = normalizeAppointmentHistorySearchText(appointmentHistorySearchQuery);

  if (!query) return records;

  return records.filter((app) => getAppointmentHistorySearchText(app).includes(query));
}

function updateAppointmentHistorySearchMeta(totalCount, visibleCount) {
  const meta = document.getElementById("appointmentHistorySearchMeta");
  if (!meta) return;

  const query = normalizeAppointmentHistorySearchText(appointmentHistorySearchQuery);

  if (!totalCount) {
    meta.textContent = "No records";
    return;
  }

  if (!query) {
    meta.textContent = `${totalCount} record${totalCount === 1 ? "" : "s"}`;
    return;
  }

  meta.textContent = `${visibleCount} of ${totalCount} shown`;
}

function ensureAppointmentHistorySearchBar() {
  const modal = document.getElementById("appointmentHistoryModal");
  const content = modal?.querySelector(".history-modal-content");
  const header = modal?.querySelector(".history-modal-header");

  if (!modal || !content || !header) return null;

  let toolbar = document.getElementById("appointmentHistorySearchToolbar");

  if (!toolbar) {
    toolbar = document.createElement("div");
    toolbar.id = "appointmentHistorySearchToolbar";
    toolbar.className = "appointment-history-search-toolbar";

    toolbar.innerHTML = `
      <div class="appointment-history-search-box">
        <span class="appointment-history-search-icon" aria-hidden="true">⌕</span>
        <input
          type="text"
          id="appointmentHistorySearchInput"
          class="appointment-history-search-input"
          placeholder="Search appointment history..."
          autocomplete="off"
        />
        <button
          type="button"
          id="clearAppointmentHistorySearchBtn"
          class="appointment-history-search-clear"
          aria-label="Clear appointment history search"
          title="Clear search"
        >
          ×
        </button>
      </div>

      <div id="appointmentHistorySearchMeta" class="appointment-history-search-meta">
        No records
      </div>
    `;

    header.insertAdjacentElement("afterend", toolbar);
  }

  const input = document.getElementById("appointmentHistorySearchInput");
  const clearBtn = document.getElementById("clearAppointmentHistorySearchBtn");

  if (input && !input.dataset.boundAppointmentHistorySearch) {
    input.dataset.boundAppointmentHistorySearch = "true";

    input.addEventListener("input", () => {
      appointmentHistorySearchQuery = input.value || "";
      renderAppointmentHistory(appointmentHistoryRecords, true);
    });
  }

  if (clearBtn && !clearBtn.dataset.boundAppointmentHistorySearch) {
    clearBtn.dataset.boundAppointmentHistorySearch = "true";

    clearBtn.addEventListener("click", () => {
      appointmentHistorySearchQuery = "";

      if (input) {
        input.value = "";
        input.focus();
      }

      renderAppointmentHistory(appointmentHistoryRecords, true);
    });
  }

  if (input && input.value !== appointmentHistorySearchQuery) {
    input.value = appointmentHistorySearchQuery;
  }

  return toolbar;
}

async function openAppointmentHistory() {
  mountAppointmentModalsToBody();
  ensureAppointmentHistorySearchBar();
  const modal = document.getElementById("appointmentHistoryModal");
  const tableBody = document.getElementById("appointmentHistoryTableBody");

  if (tableBody) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="10" class="loading-state">Loading appointment history...</td>
      </tr>
    `;
  }

  try {
    const res = await fetch(getAppointmentHistoryApiUrl(), {
      headers: {
        "Accept": "application/json"
      }
    });

    const rawText = await res.text();
    let data = {};

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch (parseError) {
      console.error("Appointment history raw response:", rawText);
      throw new Error("Appointment history API did not return valid JSON.");
    }

    if (!res.ok) {
      throw new Error(data.message || "Failed to load appointment history.");
    }

    const historyAppointments = Array.isArray(data)
      ? data
      : (data.history || data.data || []);

    appointmentHistoryRecords = sortAppointmentRecordsByReference(historyAppointments);

    renderAppointmentHistory(appointmentHistoryRecords, true);

    if (modal) {
      modal.classList.remove("hidden");
    }
  } catch (error) {
    console.error("Error opening appointment history:", error);

    if (tableBody) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="10" class="empty-state">Failed to load appointment history.</td>
        </tr>
      `;
    }

    if (modal) {
      modal.classList.remove("hidden");
    }
  }
}

function closeAppointmentHistory() {
  const modal = document.getElementById("appointmentHistoryModal");
  modal?.classList.add("hidden");
}

function renderAppointmentHistory(history = [], preserveSearch = false) {
  const tableBody = document.getElementById("appointmentHistoryTableBody");
  if (!tableBody) return;

  ensureAppointmentHistorySearchBar();

  const sourceHistory = Array.isArray(history) ? history : [];

  appointmentHistoryRecords = sortAppointmentRecordsByReference(sourceHistory);

  if (!preserveSearch && !appointmentHistorySearchQuery) {
    const input = document.getElementById("appointmentHistorySearchInput");
    if (input) input.value = "";
  }

  const filteredHistory = getFilteredAppointmentHistory(appointmentHistoryRecords);

  updateAppointmentHistorySearchMeta(appointmentHistoryRecords.length, filteredHistory.length);

  if (!appointmentHistoryRecords.length) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="10" class="empty-state">No history</td>
      </tr>
    `;
    return;
  }

  if (!filteredHistory.length) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="10" class="empty-state">No appointment history matches your search.</td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = filteredHistory.map((app) => {
    const displayName = app.name || app.full_name || "-";
    const displayBarangay = app.barangay || "-";
    const displayContact =
      app.contact ||
      app.contact_number ||
      app.phone ||
      app.mobile_number ||
      "-";
    const displayEmail = getAppointmentEmail(app);
    const displayPurpose = app.purpose || app.waste_type || "-";
    const displayDate = app.appointment_date || app.preferred_date || null;
    const displayAssigned =
      app.assigned_personnel ||
      app.assigned_personnel_name ||
      app.assigned_to ||
      "-";

    return `
      <tr>
        <td>${escapeHtml(app.appointment_code || "-")}</td>
        <td>${escapeHtml(displayName)}</td>
        <td>${escapeHtml(displayBarangay)}</td>
        <td>${escapeHtml(displayContact)}</td>
        <td>${escapeHtml(displayEmail)}</td>
        <td>${escapeHtml(displayPurpose)}</td>
        <td>${formatDateTimeDisplay(displayDate)}</td>
        <td>${renderStatusBadge(isOrientationCompletedForAppointmentModule(app) ? "completed" : app.status)}</td>
        <td>${escapeHtml(displayAssigned)}</td>
        <td>${formatDate(app.updated_at || app.created_at)}</td>
      </tr>
    `;
  }).join("");
}

function handleReschedule(id) {
  selectedRescheduleAppointmentId = id;

  const modal = document.getElementById("rescheduleAppointmentModal");
  const dateInput = document.getElementById("rescheduleAppointmentDate");

  if (dateInput) {
    dateInput.value = "";
    dateInput.min = new Date().toISOString().split("T")[0];
  }

  modal?.classList.remove("hidden");
}

function closeRescheduleModal() {
  selectedRescheduleAppointmentId = null;

  const modal = document.getElementById("rescheduleAppointmentModal");
  const dateInput = document.getElementById("rescheduleAppointmentDate");
  const timeInput = document.getElementById("rescheduleAppointmentTime");

  if (dateInput) dateInput.value = "";
  if (timeInput) timeInput.value = "";

  modal?.classList.add("hidden");
}

async function confirmRescheduleAppointment() {
  console.log("CONFIRM RESCHEDULE CLICKED");
  console.log("Selected ID:", selectedRescheduleAppointmentId);

  const btn = document.getElementById("confirmRescheduleAppointmentBtn");
  const dateInput = document.getElementById("rescheduleAppointmentDate");
  const timeInput = document.getElementById("rescheduleAppointmentTime");

  const newDate = dateInput?.value || "";
  const newTime = timeInput?.value || "";

  if (!selectedRescheduleAppointmentId) {
    showToast("No appointment selected.", "error");
    return;
  }

  if (!newDate || !newTime) {
    showToast("Please select a new date and time.", "error");
    return;
  }

  const newDateTime = `${newDate} ${newTime}:00`;

  const personnel_name =
    currentUser?.fullName ||
    currentUser?.username ||
    "WMO Admin";

  const url = getRescheduleAppointmentUrl(selectedRescheduleAppointmentId);

  console.log("Reschedule URL:", url);
  console.log("Reschedule payload:", {
    new_date: newDateTime,
    personnel_name
  });

  const originalText = btn ? btn.innerText : "Save Reschedule";

  try {
    if (btn) {
      btn.innerText = "Saving...";
      btn.disabled = true;
    }

    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        new_date: newDateTime,
        personnel_name
      })
    });

    const rawText = await res.text();
    console.log("Reschedule raw response:", rawText);

    let data = {};

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      throw new Error("Server returned invalid response.");
    }

    if (!res.ok || !data.success) {
      showToast(data.message || "Failed to reschedule appointment.", "error");
      return;
    }

    showToast("Appointment successfully rescheduled.", "success");

    closeRescheduleModal();
    await loadAppointments();

    if (typeof loadOrientationAppointments === "function") {
      await loadOrientationAppointments();
    }
  } catch (error) {
    console.error("Reschedule error:", error);
    showToast(error.message || "Error rescheduling appointment.", "error");
  } finally {
    if (btn) {
      btn.innerText = originalText;
      btn.disabled = false;
    }
  }
}

async function handleCancel(id) {
  const confirmed = confirm("Are you sure you want to cancel this appointment?");
  if (!confirmed) return;

  const personnel_name =
    currentUser?.fullName ||
    currentUser?.username ||
    "WMO Admin";

  try {
    const res = await fetch(getCancelAppointmentUrl(id), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        personnel_name
      })
    });

    const data = await res.json();

    if (!res.ok) {
      showToast(data.message || "Failed to cancel", "error");
      return;
    }

    showToast("Appointment cancelled successfully", "success");

    await loadAppointments();
  } catch (error) {
    console.error(error);
    showToast("Error cancelling appointment", "error");
  }
}

function initializeAppointments() {
  mountAppointmentModalsToBody();
  ensureAppointmentHistorySearchBar();
  const openBtn = document.getElementById("openAppointmentHistoryBtn");
  const closeBtn = document.getElementById("closeAppointmentHistoryBtn");
  const overlay = document.getElementById("historyModalOverlay");

  openBtn?.addEventListener("click", openAppointmentHistory);
  closeBtn?.addEventListener("click", closeAppointmentHistory);
  overlay?.addEventListener("click", closeAppointmentHistory);

  document.getElementById("closeRescheduleAppointmentBtn")?.addEventListener("click", closeRescheduleModal);
  document.getElementById("cancelRescheduleAppointmentBtn")?.addEventListener("click", closeRescheduleModal);
  document.getElementById("rescheduleAppointmentOverlay")?.addEventListener("click", closeRescheduleModal);

  const confirmBtn = document.getElementById("confirmRescheduleAppointmentBtn");

  if (confirmBtn) {
  confirmBtn.addEventListener("click", confirmRescheduleAppointment);
}
}

window.openAppointmentHistory = openAppointmentHistory;
window.closeAppointmentHistory = closeAppointmentHistory;
window.handleAppointmentDecision = handleAppointmentDecision;
window.handleReschedule = handleReschedule;
window.handleCancel = handleCancel;
window.confirmRescheduleAppointment = confirmRescheduleAppointment;

/* =========================================================
   APPOINTMENT CUSTOM DROPDOWN UI - FULL INTEGRATED
   Added for:
   - Reschedule Appointment time dropdown
   - Appointment-related modal selects

   Notes:
   - Original native <select> remains active behind the custom UI.
   - Existing appointment logic still reads the real select value.
   - Dropdown menu is rendered as a portal to avoid being clipped by modal overflow.
========================================================= */

let activeAppointmentCustomSelect = null;
let activeAppointmentPortalMenu = null;

function isAppointmentSelectTarget(select) {
  if (!select || select.tagName !== "SELECT") return false;

  return Boolean(
    select.closest("#rescheduleAppointmentModal") ||
    select.closest("#appointmentRescheduleModal") ||
    select.closest("#rescheduleModal") ||
    select.closest(".appointment-reschedule-modal") ||
    select.closest("#appointmentDetailsModal") ||
    select.closest(".appointment-modal") ||
    select.id === "rescheduleAppointmentTime"
  );
}

function getAppointmentSelectLabel(select) {
  if (!select) return "-";

  const selectedOption = select.options[select.selectedIndex];
  return selectedOption ? selectedOption.textContent.trim() : "-";
}

function closeAppointmentCustomDropdown() {
  if (activeAppointmentPortalMenu) {
    activeAppointmentPortalMenu.remove();
    activeAppointmentPortalMenu = null;
  }

  if (activeAppointmentCustomSelect) {
    activeAppointmentCustomSelect.classList.remove("open");

    const btn = activeAppointmentCustomSelect.querySelector(".appointment-custom-select-btn");
    if (btn) btn.setAttribute("aria-expanded", "false");

    activeAppointmentCustomSelect = null;
  }
}

function syncAppointmentCustomDropdown(select) {
  if (!select || !select.id) return;

  const wrapper = document.querySelector(
    `.appointment-custom-select[data-for="${select.id}"]`
  );

  if (!wrapper) return;

  const label = wrapper.querySelector(".appointment-custom-select-label");
  if (label) label.textContent = getAppointmentSelectLabel(select);

  const btn = wrapper.querySelector(".appointment-custom-select-btn");
  if (btn) {
    btn.disabled = !!select.disabled;
    btn.classList.toggle("is-disabled", !!select.disabled);
  }
}

function positionAppointmentPortalMenu(wrapper, portal) {
  if (!wrapper || !portal) return;

  const button = wrapper.querySelector(".appointment-custom-select-btn");
  if (!button) return;

  const rect = button.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const menuWidth = Math.max(rect.width, 230);

  let left = rect.left;
  const top = rect.bottom + 8; // Always open below the Select Time field

  if (left + menuWidth > viewportWidth - 12) {
    left = viewportWidth - menuWidth - 12;
  }

  /*
    Keep the dropdown compact so the top and bottom of the dropdown box
    remain visible. The list scrolls internally when there are more options.
  */
  const compactMaxHeight = 220;
  const availableBelow = Math.max(130, viewportHeight - top - 18);
  const naturalMenuHeight = portal.scrollHeight || compactMaxHeight;
  const finalMenuHeight = Math.min(naturalMenuHeight, compactMaxHeight, availableBelow);

  portal.style.left = `${Math.max(12, left)}px`;
  portal.style.top = `${Math.max(12, top)}px`;
  portal.style.width = `${menuWidth}px`;
  portal.style.maxHeight = `${finalMenuHeight}px`;
  portal.style.overflowY = naturalMenuHeight > finalMenuHeight ? "auto" : "visible";
}

function openAppointmentCustomDropdown(select, wrapper) {
  closeAppointmentCustomDropdown();

  if (!select || !wrapper || select.disabled) return;

  wrapper.classList.add("open");

  const btn = wrapper.querySelector(".appointment-custom-select-btn");
  if (btn) btn.setAttribute("aria-expanded", "true");

  const portal = document.createElement("div");
  portal.className = "appointment-custom-select-portal-menu";
  portal.setAttribute("role", "listbox");
  portal.dataset.for = select.id;

  Array.from(select.options).forEach((option) => {
    const optionBtn = document.createElement("button");
    optionBtn.type = "button";
    optionBtn.className = "appointment-custom-select-option";
    optionBtn.dataset.value = option.value;
    optionBtn.textContent = option.textContent;
    optionBtn.setAttribute("role", "option");

    const isActive = option.value === select.value;
    optionBtn.classList.toggle("active", isActive);
    optionBtn.setAttribute("aria-selected", isActive ? "true" : "false");

    if (option.disabled) {
      optionBtn.disabled = true;
      optionBtn.classList.add("is-disabled");
    }

    optionBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (option.disabled) return;

      select.value = option.value;

      select.dispatchEvent(
        new Event("change", {
          bubbles: true
        })
      );

      syncAppointmentCustomDropdown(select);
      closeAppointmentCustomDropdown();
    });

    portal.appendChild(optionBtn);
  });

  document.body.appendChild(portal);

  activeAppointmentCustomSelect = wrapper;
  activeAppointmentPortalMenu = portal;

  positionAppointmentPortalMenu(wrapper, portal);

  requestAnimationFrame(() => {
    positionAppointmentPortalMenu(wrapper, portal);
  });
}

function buildAppointmentCustomDropdown(select) {
  if (!isAppointmentSelectTarget(select)) return;

  if (!select.id) {
    select.id = `appointmentSelect_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  const existingWrapper = document.querySelector(
    `.appointment-custom-select[data-for="${select.id}"]`
  );

  if (existingWrapper) {
    select.classList.add("appointment-native-select-hidden");
    syncAppointmentCustomDropdown(select);
    return;
  }

  select.classList.add("appointment-native-select-hidden");

  const wrapper = document.createElement("div");
  wrapper.className = "appointment-custom-select";
  wrapper.dataset.for = select.id;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "appointment-custom-select-btn";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");

  button.innerHTML = `
    <span class="appointment-custom-select-label">${getAppointmentSelectLabel(select)}</span>
    <span class="appointment-custom-select-arrow">⌄</span>
  `;

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (select.disabled) return;

    if (wrapper.classList.contains("open")) {
      closeAppointmentCustomDropdown();
      return;
    }

    openAppointmentCustomDropdown(select, wrapper);
  });

  wrapper.appendChild(button);
  select.insertAdjacentElement("afterend", wrapper);

  select.addEventListener("change", () => {
    syncAppointmentCustomDropdown(select);
  });

  syncAppointmentCustomDropdown(select);
}

function setupAppointmentCustomDropdowns(root = document) {
  if (!root || !root.querySelectorAll) return;

  root.querySelectorAll("select").forEach((select) => {
    if (isAppointmentSelectTarget(select)) {
      buildAppointmentCustomDropdown(select);
    }
  });
}

function observeAppointmentCustomDropdowns() {
  if (window.__appointmentCustomDropdownObserverBound === true) return;
  window.__appointmentCustomDropdownObserverBound = true;

  const observer = new MutationObserver((mutations) => {
    let shouldSetup = false;

    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;

        if (
          node.matches?.("select") ||
          node.querySelector?.("select") ||
          node.id === "rescheduleAppointmentModal" ||
          node.id === "appointmentRescheduleModal" ||
          node.id === "rescheduleModal" ||
          node.closest?.("#rescheduleAppointmentModal, #appointmentRescheduleModal, #rescheduleModal")
        ) {
          shouldSetup = true;
        }
      });
    });

    if (shouldSetup) {
      setTimeout(() => setupAppointmentCustomDropdowns(), 40);
      setTimeout(() => setupAppointmentCustomDropdowns(), 160);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  window.appointmentCustomDropdownObserver = observer;
}

/*
  Wrap handleReschedule so the custom dropdown is initialized immediately
  when the Reschedule modal opens.
*/
if (typeof handleReschedule === "function" && !window.__handleRescheduleAppointmentDropdownWrapped) {
  window.__handleRescheduleAppointmentDropdownWrapped = true;

  const originalHandleReschedule = handleReschedule;

  handleReschedule = function patchedHandleReschedule(...args) {
    const result = originalHandleReschedule.apply(this, args);

    setTimeout(() => setupAppointmentCustomDropdowns(), 30);
    setTimeout(() => setupAppointmentCustomDropdowns(), 120);

    return result;
  };

  window.handleReschedule = handleReschedule;
}

/*
  Wrap closeRescheduleModal so open dropdown portals are removed when modal closes.
*/
if (typeof closeRescheduleModal === "function" && !window.__closeRescheduleAppointmentDropdownWrapped) {
  window.__closeRescheduleAppointmentDropdownWrapped = true;

  const originalCloseRescheduleModal = closeRescheduleModal;

  closeRescheduleModal = function patchedCloseRescheduleModal(...args) {
    closeAppointmentCustomDropdown();

    const result = originalCloseRescheduleModal.apply(this, args);

    return result;
  };

  window.closeRescheduleModal = closeRescheduleModal;
}

/*
  Wrap initializeAppointments so custom dropdowns and observers are registered
  together with the appointment module.
*/
if (typeof initializeAppointments === "function" && !window.__initializeAppointmentsDropdownWrapped) {
  window.__initializeAppointmentsDropdownWrapped = true;

  const originalInitializeAppointments = initializeAppointments;

  initializeAppointments = function patchedInitializeAppointments(...args) {
    const result = originalInitializeAppointments.apply(this, args);

    setupAppointmentCustomDropdowns();
    observeAppointmentCustomDropdowns();

    setTimeout(() => setupAppointmentCustomDropdowns(), 250);
    setTimeout(() => setupAppointmentCustomDropdowns(), 800);

    return result;
  };

  window.initializeAppointments = initializeAppointments;
}

/*
  Wrap table/history renderers only to keep observers alive after dynamic renders.
*/
[
  "renderAppointmentsTable",
  "renderAppointmentHistory",
  "loadAppointments"
].forEach((fnName) => {
  if (typeof window[fnName] === "function" && !window[`__${fnName}AppointmentDropdownWrapped`]) {
    window[`__${fnName}AppointmentDropdownWrapped`] = true;

    const originalFn = window[fnName];

    window[fnName] = function patchedAppointmentDropdownFunction(...args) {
      const result = originalFn.apply(this, args);

      setTimeout(() => setupAppointmentCustomDropdowns(), 80);

      return result;
    };
  }
});

document.addEventListener("click", (event) => {
  const clickedCustomSelect = event.target.closest(".appointment-custom-select");
  const clickedPortal = event.target.closest(".appointment-custom-select-portal-menu");

  if (!clickedCustomSelect && !clickedPortal) {
    closeAppointmentCustomDropdown();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeAppointmentCustomDropdown();
  }
});

window.addEventListener("resize", () => {
  if (activeAppointmentCustomSelect && activeAppointmentPortalMenu) {
    positionAppointmentPortalMenu(activeAppointmentCustomSelect, activeAppointmentPortalMenu);
  }
});

window.addEventListener("scroll", () => {
  if (activeAppointmentCustomSelect && activeAppointmentPortalMenu) {
    positionAppointmentPortalMenu(activeAppointmentCustomSelect, activeAppointmentPortalMenu);
  }
}, true);

document.addEventListener("DOMContentLoaded", () => {
  mountAppointmentModalsToBody();
  ensureAppointmentHistorySearchBar();
  setupAppointmentCustomDropdowns();
  observeAppointmentCustomDropdowns();

  setTimeout(setupAppointmentCustomDropdowns, 250);
  setTimeout(setupAppointmentCustomDropdowns, 800);
  setTimeout(setupAppointmentCustomDropdowns, 1400);
});

window.setupAppointmentCustomDropdowns = setupAppointmentCustomDropdowns;
window.closeAppointmentCustomDropdown = closeAppointmentCustomDropdown;
window.syncAppointmentCustomDropdown = syncAppointmentCustomDropdown;

window.ensureAppointmentHistorySearchBar = ensureAppointmentHistorySearchBar;
