/* =========================
   APPOINTMENTS MODULE
========================= */

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

    const sortedActiveAppointments = sortAppointmentRecordsByReference(activeAppointments);
    const sortedHistoryAppointments = sortAppointmentRecordsByReference(historyAppointments);

    allAppointments = sortAppointmentRecordsByReference([
      ...sortedActiveAppointments,
      ...sortedHistoryAppointments
    ]);

    renderAppointmentsTable(sortedActiveAppointments);
    renderAppointmentHistory(sortedHistoryAppointments);
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
        <td colspan="9" class="empty-state">No active appointments found.</td>
      </tr>
    `;
    return;
  }

  const sortedAppointments = sortAppointmentRecordsByReference(appointments);

  tableBody.innerHTML = sortedAppointments.map((app) => {
    const displayName = app.name || app.full_name || "-";
    const displayBarangay = app.barangay || "-";
    const displayContact =
      app.contact ||
      app.contact_number ||
      app.phone ||
      app.mobile_number ||
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
   APPOINTMENT HISTORY
========================= */

async function openAppointmentHistory() {
  const modal = document.getElementById("appointmentHistoryModal");
  const tableBody = document.getElementById("appointmentHistoryTableBody");

  if (tableBody) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="8" class="loading-state">Loading appointment history...</td>
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

    renderAppointmentHistory(sortAppointmentRecordsByReference(historyAppointments));

    if (modal) {
      modal.classList.remove("hidden");
    }
  } catch (error) {
    console.error("Error opening appointment history:", error);

    if (tableBody) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="8" class="empty-state">Failed to load appointment history.</td>
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

function renderAppointmentHistory(history = []) {
  const tableBody = document.getElementById("appointmentHistoryTableBody");
  if (!tableBody) return;

  if (!Array.isArray(history) || !history.length) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="9" class="empty-state">No history</td>
      </tr>
    `;
    return;
  }

  const sortedHistory = sortAppointmentRecordsByReference(history);

  tableBody.innerHTML = sortedHistory.map((app) => {
    const displayName = app.name || app.full_name || "-";
    const displayBarangay = app.barangay || "-";
    const displayContact = app.contact || app.contact_number || "-";
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
        <td>${escapeHtml(displayPurpose)}</td>
       <td>${formatDateTimeDisplay(displayDate)}</td>
        <td>${renderStatusBadge(app.status)}</td>
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
