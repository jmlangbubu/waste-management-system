async function loadOrientationAppointments() {
  const cardList = document.getElementById("orientationCardList");
  const historyBody = document.getElementById("orientationHistoryTableBody");

  if (!cardList) return;

  cardList.innerHTML = `<div class="empty-state">Loading orientation records...</div>`;

  if (historyBody) {
    historyBody.innerHTML = `<tr><td colspan="6">Loading history...</td></tr>`;
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
      const status = normalizeOrientationStatus(item.orientation_status);
      return !status || status === "approved" || status === "pending_orientation";
    });

    const history = orientationAppointments.filter((item) => {
      return normalizeOrientationStatus(item.orientation_status) === "completed_orientation";
    });

    renderActiveOrientation(active);
    renderOrientationHistory(history);
  } catch (error) {
    console.error("Error loading orientation appointments:", error);
    cardList.innerHTML = `<div class="empty-state">Failed to load orientation data.</div>`;

    if (historyBody) {
      historyBody.innerHTML = `<tr><td colspan="6">Failed to load history.</td></tr>`;
    }
  }
}

function renderActiveOrientation(records) {
  const cardList = document.getElementById("orientationCardList");
  if (!cardList) return;

  if (!Array.isArray(records) || !records.length) {
    cardList.innerHTML = `<div class="empty-state">No active orientation records found.</div>`;
    return;
  }

  cardList.innerHTML = records.map((item) => {
    const status = normalizeOrientationStatus(item.orientation_status);

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
            ${status === "completed_orientation" ? "disabled" : ""}
          >
            <span>🖥️ Take Web Exam</span>
            <b>›</b>
          </button>
        </div>
      </div>
    `;
  }).join("");
}

function renderOrientationHistory(records) {
  const tableBody = document.getElementById("orientationHistoryTableBody");
  if (!tableBody) return;

  if (!Array.isArray(records) || !records.length) {
    tableBody.innerHTML = `<tr><td colspan="6">No completed orientation records yet.</td></tr>`;
    return;
  }

  tableBody.innerHTML = records.map((item) => `
    <tr>
      <td>${escapeHtml(item.full_name || "-")}</td>
      <td>${escapeHtml(item.barangay || "-")}</td>
      <td>${escapeHtml(formatSimpleDate(item.orientation_started_at))}</td>
      <td>${escapeHtml(formatSimpleDate(item.orientation_completed_at))}</td>
      <td>${escapeHtml(item.orientation_score || "-")}</td>
      <td>
        <span class="orientation-status status-completed">Completed</span>
      </td>
    </tr>
  `).join("");
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
        return normalizeOrientationStatus(item.orientation_status) === "completed_orientation";
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

function getOrientationStatusLabel(item) {
  const status = normalizeOrientationStatus(item.orientation_status);

  if (status === "pending_orientation") return "Pending Orientation";
  if (status === "completed_orientation") return "Completed";
  return "Approved";
}

function getOrientationStatusClass(item) {
  const status = normalizeOrientationStatus(item.orientation_status);

  if (status === "pending_orientation") return "status-pending";
  if (status === "completed_orientation") return "status-completed";
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
