async function loadOrientationAppointments() {
  const cardList = document.getElementById("orientationCardList");
  const historyBody = document.getElementById("orientationHistoryTableBody");

  if (!cardList) return;

  cardList.innerHTML = `<div class="empty-state">Loading orientation records...</div>`;

  if (historyBody) {
    historyBody.innerHTML = `<tr><td colspan="6">Loading history...</td></tr>`;
  }

  const upcomingBody = document.getElementById("upcomingOrientationTableBody");
  if (upcomingBody) {
    upcomingBody.innerHTML = `<tr><td colspan="5">Loading upcoming orientations...</td></tr>`;
  }

  try {
    const response = await fetch(getOrientationAppointmentsApiUrl(), {
      headers: { Accept: "application/json" }
    });

    const rawText = await response.text();
    let data = {};

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      console.error("Orientation API raw response:", rawText);
      throw new Error("Orientation API did not return valid JSON.");
    }

    if (!response.ok || !data.success) {
      throw new Error(data.message || "Failed to load orientation appointments.");
    }

    orientationAppointments = Array.isArray(data.appointments) ? data.appointments : [];

    const active = orientationAppointments.filter((item) => {
      const lifecycleStatus = getOrientationLifecycleStatus(item);

      /*
        Active Orientation must show today's schedules only.
        Future approved orientations should not appear yet.
        Past unfinished orientations are handled by history as No Show / Incomplete.
      */
      return (
        isOrientationToday(item) &&
        (lifecycleStatus === "approved" || lifecycleStatus === "pending_orientation")
      );
    });

    const upcoming = orientationAppointments.filter((item) => {
      const lifecycleStatus = getOrientationLifecycleStatus(item);

      return (
        isOrientationUpcoming(item) &&
        (lifecycleStatus === "approved" || lifecycleStatus === "pending_orientation")
      );
    });

    const history = orientationAppointments.filter((item) => {
      return isOrientationHistoryRecord(item);
    });

    renderActiveOrientation(active);
    renderUpcomingOrientation(upcoming);
    renderOrientationHistory(history);
  } catch (error) {
    console.error("Error loading orientation appointments:", error);
    cardList.innerHTML = `<div class="empty-state">Failed to load orientation data.</div>`;

    if (historyBody) {
      historyBody.innerHTML = `<tr><td colspan="6">Failed to load history.</td></tr>`;
    }

    const upcomingBody = document.getElementById("upcomingOrientationTableBody");
    if (upcomingBody) {
      upcomingBody.innerHTML = `<tr><td colspan="5">Failed to load upcoming orientations.</td></tr>`;
    }
  }
}

function renderActiveOrientation(records) {
  const cardList = document.getElementById("orientationCardList");
  if (!cardList) return;

  if (!Array.isArray(records) || !records.length) {
    cardList.innerHTML = `<div class="empty-state">No active orientation records for today.</div>`;
    return;
  }

  cardList.innerHTML = records.map((item) => {
    const status = getOrientationLifecycleStatus(item);

    return `
      <div class="orientation-card">
        <div class="orientation-card-head">
          <div class="orientation-icon">🏢</div>

          <span class="orientation-status ${getOrientationStatusClass(item)}">
            ${getOrientationStatusLabel(item)}
          </span>

          <button type="button" class="orientation-menu-btn">⋮</button>
        </div>

        <div class="orientation-card-body">
          <h3>${escapeHtml(item.full_name || "-")}</h3>

          <div class="orientation-date">
            📅 ${escapeHtml(formatSimpleDate(item.preferred_date))}
          </div>

          <div class="orientation-info">
            <span>Barangay</span>
            <strong>${escapeHtml(item.barangay || "-")}</strong>
          </div>

          <div class="orientation-info">
            <span>Type</span>
            <strong>SWM Orientation</strong>
          </div>
        </div>

        <div class="orientation-card-actions">
          <button type="button" class="orientation-qr-btn" data-id="${item.id}">
            <span>📲 Open QR Code</span>
            <b>›</b>
          </button>

          <button
            type="button"
            class="orientation-web-btn"
            data-id="${item.id}"
            ${status === "pending_orientation" || status === "completed_orientation" || status === "no_show" || status === "incomplete_orientation" ? "disabled" : ""}
          >
            <span>🖥️ Take Web Exam</span>
            <b>›</b>
          </button>
        </div>
      </div>
    `;
  }).join("");
}

function renderUpcomingOrientation(records) {
  const tableBody = document.getElementById("upcomingOrientationTableBody");
  if (!tableBody) return;

  if (!Array.isArray(records) || !records.length) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="5">No upcoming orientation schedules found.</td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = records.map((item) => `
    <tr>
      <td>${escapeHtml(item.full_name || "-")}</td>
      <td>${escapeHtml(item.barangay || "-")}</td>
      <td>${escapeHtml(formatSimpleDate(item.preferred_date))}</td>
      <td>SWM Orientation</td>
      <td>
        <span class="orientation-status status-approved">
          Scheduled
        </span>
      </td>
    </tr>
  `).join("");
}

function renderOrientationHistory(records) {
  const tableBody = document.getElementById("orientationHistoryTableBody");
  if (!tableBody) return;

  if (!Array.isArray(records) || !records.length) {
    tableBody.innerHTML = `<tr><td colspan="6">No orientation history records yet.</td></tr>`;
    return;
  }

  tableBody.innerHTML = records.map((item) => {
    const lifecycleStatus = getOrientationLifecycleStatus(item);
    const score =
      lifecycleStatus === "completed_orientation"
        ? formatOrientationScore(item.orientation_score)
        : "-";

    const startedDate =
      item.orientation_started_at
        ? formatSimpleDate(item.orientation_started_at)
        : formatSimpleDate(item.preferred_date);

    const completedDate =
      lifecycleStatus === "completed_orientation"
        ? formatSimpleDate(item.orientation_completed_at)
        : "-";

    return `
      <tr>
        <td>${escapeHtml(item.full_name || "-")}</td>
        <td>${escapeHtml(item.barangay || "-")}</td>
        <td>${escapeHtml(startedDate)}</td>
        <td>${escapeHtml(completedDate)}</td>
        <td>${escapeHtml(score)}</td>
        <td>
          <span class="orientation-status ${getOrientationStatusClass(item)}">
            ${getOrientationStatusLabel(item)}
          </span>
        </td>
      </tr>
    `;
  }).join("");
}

async function openOrientationWebExam(id) {
  const selected = orientationAppointments.find((item) => Number(item.id) === Number(id));

  if (!selected) {
    showToast("Orientation record not found.", "error");
    return;
  }

  try {
    let token = selected.orientation_token ? String(selected.orientation_token).trim() : "";

    if (!token) {
      const response = await fetch(getGenerateOrientationQrApiUrl(id), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      });

      const rawText = await response.text();
      let data = {};

      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        console.error("Generate orientation QR raw response:", rawText);
        throw new Error("Generate QR API did not return valid JSON.");
      }

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Failed to generate orientation token.");
      }

      token = data?.data?.token ? String(data.data.token).trim() : "";

      if (!token) {
        throw new Error("Orientation token was not returned by the server.");
      }

      await loadOrientationAppointments();
    }

    const webExamUrl =
      `${window.APP_CONFIG.BASE_URL}/orientation-quiz.html?token=${encodeURIComponent(token)}&mode=web`;

    window.open(webExamUrl, "_blank");
  } catch (error) {
    console.error("Error opening web orientation exam:", error);
    showToast(error.message || "Failed to open web exam.", "error");
  }
}

async function generateOrientationQr(id) {
  try {
    const response = await fetch(getGenerateOrientationQrApiUrl(id), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    });

    const rawText = await response.text();
    let data = {};

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      console.error("Generate orientation QR raw response:", rawText);
      throw new Error("Generate orientation QR API did not return valid JSON.");
    }

    if (!response.ok || !data.success) {
      throw new Error(data.message || "Failed to generate orientation QR.");
    }

    currentOrientationQrData = data.data || null;

    showToast("Orientation QR generated successfully.", "success");
    renderOrientationQrModal(currentOrientationQrData);
    openOrientationQrModal();

    await loadOrientationAppointments();
  } catch (error) {
    console.error("Error generating orientation QR:", error);
    showToast(error.message || "Failed to generate orientation QR.", "error");
  }
}

async function viewOrientationQr(id) {
  const selected = orientationAppointments.find((item) => Number(item.id) === Number(id));

  if (!selected) {
    showToast("Orientation record not found.", "error");
    return;
  }

  try {
    let token = selected.orientation_token ? String(selected.orientation_token).trim() : "";

    if (!token) {
      const response = await fetch(getGenerateOrientationQrApiUrl(id), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      });

      const rawText = await response.text();
      let data = {};

      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        console.error("Generate orientation QR raw response:", rawText);
        throw new Error("Generate QR API did not return valid JSON.");
      }

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Failed to generate orientation QR.");
      }

      token = data?.data?.token ? String(data.data.token).trim() : "";

      if (!token) {
        throw new Error("QR token was not returned by the server.");
      }

      await loadOrientationAppointments();
    }

    const latestRecord =
      orientationAppointments.find((item) => Number(item.id) === Number(id)) || selected;

    currentOrientationQrData = {
      appointment_id: latestRecord.id,
      full_name: latestRecord.full_name,
      barangay: latestRecord.barangay,
      preferred_date: latestRecord.preferred_date,
      token,
      qr_url: `${window.APP_CONFIG.BASE_URL}/orientation-quiz.html?token=${encodeURIComponent(token)}`
    };

    renderOrientationQrModal(currentOrientationQrData);
    openOrientationQrModal();
  } catch (error) {
    console.error("viewOrientationQr error:", error);
    showToast(error.message || "Failed to open orientation QR.", "error");
  }
}

function renderOrientationQrModal(data) {
  const qrContainer = document.getElementById("orientationQrContainer");
  const tokenText = document.getElementById("orientationQrTokenText");
  const nameText = document.getElementById("orientationQrNameText");
  const barangayText = document.getElementById("orientationQrBarangayText");
  const dateText = document.getElementById("orientationQrDateText");

  if (!qrContainer || !tokenText || !nameText || !barangayText || !dateText) return;

  if (!data || !data.token || !data.appointment_id) {
    qrContainer.innerHTML = "";
    nameText.textContent = "Name: -";
    barangayText.textContent = "Barangay: -";
    dateText.textContent = "Date: -";
    tokenText.textContent = "Token: QR data is unavailable.";
    return;
  }

  qrContainer.innerHTML = `
    <img
      src="${getAppApiBase()}/appointments/${data.appointment_id}/orientation-qr-image"
      alt="Orientation QR Code"
      style="width:240px;height:240px;"
    />
  `;

  nameText.textContent = `Name: ${data.full_name || "-"}`;
  barangayText.textContent = `Barangay: ${data.barangay || "-"}`;
  dateText.textContent = `Date: ${formatSimpleDate(data.preferred_date)}`;
  tokenText.textContent = `Token: ${data.token}`;
}

/* =========================
   QR MODAL
========================= */

function openOrientationQrModal() {
  const modal = document.getElementById("orientationQrModal");
  if (modal) modal.classList.remove("hidden");
}

function closeOrientationQrModal() {
  const modal = document.getElementById("orientationQrModal");
  if (modal) modal.classList.add("hidden");
}

function setupOrientationQrModal() {
  const closeBtn = document.getElementById("closeOrientationQrBtn");
  const overlay = document.getElementById("orientationQrOverlay");

  if (closeBtn) closeBtn.onclick = closeOrientationQrModal;
  if (overlay) overlay.onclick = closeOrientationQrModal;
}

/* =========================
   UPCOMING ORIENTATION MODAL
========================= */

function openUpcomingOrientationModal() {
  const modal = document.getElementById("upcomingOrientationModal");

  if (!modal) {
    console.error("upcomingOrientationModal not found in HTML.");
    showToast("Upcoming orientation modal is missing in HTML.", "error");
    return;
  }

  const upcoming = Array.isArray(orientationAppointments)
    ? orientationAppointments.filter((item) => {
        const lifecycleStatus = getOrientationLifecycleStatus(item);

        return (
          isOrientationUpcoming(item) &&
          (lifecycleStatus === "approved" || lifecycleStatus === "pending_orientation")
        );
      })
    : [];

  renderUpcomingOrientation(upcoming);
  modal.classList.remove("hidden");
}

function closeUpcomingOrientationModal() {
  const modal = document.getElementById("upcomingOrientationModal");
  if (modal) modal.classList.add("hidden");
}

function setupUpcomingOrientationModal() {
  const openBtn = document.getElementById("openUpcomingOrientationBtn");
  const closeBtn = document.getElementById("closeUpcomingOrientationBtn");
  const overlay = document.getElementById("upcomingOrientationOverlay");

  if (openBtn) {
    openBtn.onclick = openUpcomingOrientationModal;
  } else {
    console.warn("openUpcomingOrientationBtn not found.");
  }

  if (closeBtn) closeBtn.onclick = closeUpcomingOrientationModal;
  if (overlay) overlay.onclick = closeUpcomingOrientationModal;
}

/* =========================
   HISTORY MODAL
========================= */

function openOrientationHistoryModal() {
  const modal = document.getElementById("orientationHistoryModal");

  if (!modal) {
    console.error("orientationHistoryModal not found in HTML.");
    showToast("Orientation report modal is missing in HTML.", "error");
    return;
  }

  const history = Array.isArray(orientationAppointments)
    ? orientationAppointments.filter((item) => {
        return isOrientationHistoryRecord(item);
      })
    : [];

  renderOrientationHistory(history);
  modal.classList.remove("hidden");
}

function closeOrientationHistoryModal() {
  const modal = document.getElementById("orientationHistoryModal");
  if (modal) modal.classList.add("hidden");
}

function setupOrientationHistoryModal() {
  const openBtn = document.getElementById("openOrientationHistoryBtn");
  const closeBtn = document.getElementById("closeOrientationHistoryBtn");
  const overlay = document.getElementById("orientationHistoryOverlay");

  if (openBtn) {
    openBtn.onclick = openOrientationHistoryModal;
  } else {
    console.warn("openOrientationHistoryBtn not found.");
  }

  if (closeBtn) closeBtn.onclick = closeOrientationHistoryModal;
  if (overlay) overlay.onclick = closeOrientationHistoryModal;
}

/* =========================
   HELPERS
========================= */

function normalizeOrientationStatus(status) {
  return String(status || "").toLowerCase().trim();
}

function getOrientationLifecycleStatus(item) {
  const status = normalizeOrientationStatus(item?.orientation_status);

  if (status === "completed_orientation" || item?.orientation_completed_at) {
    return "completed_orientation";
  }

  if (status === "cancelled" || status === "cancelled_orientation") {
    return "cancelled_orientation";
  }

  if (
    status === "no_show" ||
    status === "no-show" ||
    status === "noshow" ||
    status === "missed_orientation"
  ) {
    return "no_show";
  }

  if (
    status === "incomplete" ||
    status === "incomplete_orientation" ||
    status === "expired_orientation"
  ) {
    return "incomplete_orientation";
  }

  if (isOrientationPastDue(item)) {
    /*
      Past approved/pending records should no longer stay in Active Orientation.
      If the user started but did not complete, mark as Incomplete.
      If the user did not start/take the orientation, mark as No Show.
    */
    if (item?.orientation_started_at) {
      return "incomplete_orientation";
    }

    return "no_show";
  }

  if (status === "pending_orientation") {
    return "pending_orientation";
  }

  return "approved";
}

function isOrientationHistoryRecord(item) {
  const lifecycleStatus = getOrientationLifecycleStatus(item);

  return (
    lifecycleStatus === "completed_orientation" ||
    lifecycleStatus === "no_show" ||
    lifecycleStatus === "incomplete_orientation" ||
    lifecycleStatus === "cancelled_orientation"
  );
}

function isOrientationToday(item) {
  const dateValue = item?.preferred_date;
  if (!dateValue) return false;

  const scheduledDate = parseOrientationDateOnly(dateValue);
  if (!scheduledDate) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return scheduledDate.getTime() === today.getTime();
}

function isOrientationUpcoming(item) {
  const dateValue = item?.preferred_date;
  if (!dateValue) return false;

  const scheduledDate = parseOrientationDateOnly(dateValue);
  if (!scheduledDate) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return scheduledDate > today;
}

function isOrientationPastDue(item) {
  const dateValue = item?.preferred_date;
  if (!dateValue) return false;

  const scheduledDate = parseOrientationDateOnly(dateValue);
  if (!scheduledDate) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return scheduledDate < today;
}

function parseOrientationDateOnly(dateValue) {
  const value = String(dateValue || "").trim();
  if (!value) return null;

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);

    const parsed = new Date(year, month, day);
    parsed.setHours(0, 0, 0, 0);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const fallback = new Date(value);
  if (Number.isNaN(fallback.getTime())) return null;

  fallback.setHours(0, 0, 0, 0);
  return fallback;
}

function formatOrientationScore(score) {
  if (score === 0 || score === "0") return "0";
  return score || "-";
}

function getOrientationStatusLabel(item) {
  const lifecycleStatus = getOrientationLifecycleStatus(item);

  if (lifecycleStatus === "pending_orientation") return "Taking Quiz";
  if (lifecycleStatus === "completed_orientation") return "Completed";
  if (lifecycleStatus === "no_show") return "No Show";
  if (lifecycleStatus === "incomplete_orientation") return "Incomplete";
  if (lifecycleStatus === "cancelled_orientation") return "Cancelled";

  return "Approved";
}

function getOrientationStatusClass(item) {
  const lifecycleStatus = getOrientationLifecycleStatus(item);

  if (lifecycleStatus === "pending_orientation") return "status-pending";
  if (lifecycleStatus === "completed_orientation") return "status-completed";
  if (lifecycleStatus === "no_show") return "status-no-show";
  if (lifecycleStatus === "incomplete_orientation") return "status-incomplete";
  if (lifecycleStatus === "cancelled_orientation") return "status-cancelled";

  return "status-approved";
}

/* =========================
   EVENTS
========================= */

document.addEventListener("click", (event) => {
  const qrBtn = event.target.closest(".orientation-qr-btn");
  if (qrBtn) {
    viewOrientationQr(qrBtn.dataset.id);
    return;
  }

  const webBtn = event.target.closest(".orientation-web-btn");
  if (webBtn) {
    openOrientationWebExam(webBtn.dataset.id);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  setupOrientationQrModal();
  setupOrientationHistoryModal();
  setupUpcomingOrientationModal();
});

/* =========================
   GLOBAL EXPORTS
========================= */

window.loadOrientationAppointments = loadOrientationAppointments;
window.generateOrientationQr = generateOrientationQr;
window.viewOrientationQr = viewOrientationQr;
window.openOrientationWebExam = openOrientationWebExam;
window.openOrientationHistoryModal = openOrientationHistoryModal;
window.closeOrientationHistoryModal = closeOrientationHistoryModal;
window.openUpcomingOrientationModal = openUpcomingOrientationModal;
window.closeUpcomingOrientationModal = closeUpcomingOrientationModal;
