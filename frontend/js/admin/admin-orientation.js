async function loadOrientationAppointments() {
  const cardList = document.getElementById("orientationCardList");
if (!cardList) return;

cardList.innerHTML = `<div class="empty-state">Loading orientation records...</div>`;

  try {
    const response = await fetch(getOrientationAppointmentsApiUrl(), {
      headers: {
        "Accept": "application/json"
      }
    });

    const rawText = await response.text();
    let data = {};

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch (parseError) {
      console.error("Orientation API raw response:", rawText);
      throw new Error("Orientation API did not return valid JSON.");
    }

    if (!response.ok || !data.success) {
      throw new Error(data.message || "Failed to load orientation appointments.");
    }

    orientationAppointments = Array.isArray(data.appointments)
      ? data.appointments
      : [];

    renderOrientationAppointmentsTable(orientationAppointments);
  } catch (error) {
    console.error("Error loading orientation appointments:", error);

    cardList.innerHTML = `<div class="empty-state">Failed to load orientation data.</div>`;
  }
}

function renderOrientationAppointmentsTable(records) {
  const cardList = document.getElementById("orientationCardList");
  if (!cardList) return;

  if (!Array.isArray(records) || !records.length) {
    cardList.innerHTML = `<div class="empty-state">No approved orientation records found.</div>`;
    return;
  }

  cardList.innerHTML = records.map(item => `
    <div class="orientation-card">

      <!-- HEADER -->
      <div class="orientation-card-head">
        <div class="orientation-icon">🏢</div>
        <span class="orientation-status">Approved</span>
        <button class="orientation-menu-btn">⋮</button>
      </div>

      <!-- BODY -->
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

      <!-- ACTIONS -->
      <div class="orientation-card-actions">
        <button type="button" class="orientation-qr-btn" data-id="${item.id}">
          <span>📲 Open QR Code</span>
          <b>›</b>
        </button>

        <button type="button" class="orientation-web-btn" data-id="${item.id}">
          <span>🖥️ Take Web Exam</span>
          <b>›</b>
        </button>
      </div>

    </div>
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
          "Accept": "application/json"
        }
      });

      const rawText = await response.text();
      let data = {};

      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch (parseError) {
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
window.openOrientationWebExam = openOrientationWebExam;

async function generateOrientationQr(id) {
  try {
    const response = await fetch(getGenerateOrientationQrApiUrl(id), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      }
    });

    const rawText = await response.text();
    let data = {};

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch (parseError) {
      console.error("Generate orientation QR raw response:", rawText);
      throw new Error("Generate QR API did not return valid JSON.");
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

    // Auto-generate QR if missing
    if (!token) {
      const response = await fetch(getGenerateOrientationQrApiUrl(id), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        }
      });

      const rawText = await response.text();
      let data = {};

      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch (parseError) {
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

      // refresh orientation list para updated na local state
      await loadOrientationAppointments();
    }

    const latestRecord =
      orientationAppointments.find((item) => Number(item.id) === Number(id)) || selected;

    const quizUrl = `${window.APP_CONFIG.BASE_URL}/orientation-quiz.html?token=${encodeURIComponent(token)}`;

    currentOrientationQrData = {
      appointment_id: latestRecord.id,
      full_name: latestRecord.full_name,
      barangay: latestRecord.barangay,
      preferred_date: latestRecord.preferred_date,
      token,
      qr_url: quizUrl
    };

    renderOrientationQrModal(currentOrientationQrData);
    openOrientationQrModal();
  } catch (error) {
    console.error("viewOrientationQr error:", error);
    alert(error.message || "Failed to open orientation QR.");
  }
}


function renderOrientationQrModal(data) {
  const qrContainer = document.getElementById("orientationQrContainer");
  const tokenText = document.getElementById("orientationQrTokenText");
  const nameText = document.getElementById("orientationQrNameText");
  const barangayText = document.getElementById("orientationQrBarangayText");
  const dateText = document.getElementById("orientationQrDateText");

  if (!qrContainer || !tokenText || !nameText || !barangayText || !dateText) return;

  qrContainer.innerHTML = `
  <img 
    src="${getAppApiBase()}/appointments/${data.appointment_id}/orientation-qr-image" 
    alt="QR Code"
    style="width:240px;height:240px;"
  />
`;

  if (!data || !data.token) {
    nameText.textContent = "Name: -";
    barangayText.textContent = "Barangay: -";
    dateText.textContent = "Date: -";
    tokenText.textContent = "Token: QR data is unavailable.";
    return;
  }

  const quizUrl = data.qr_url ||
    `${window.APP_CONFIG.BASE_URL}/orientation-quiz.html?token=${encodeURIComponent(data.token)}`;


  nameText.textContent = `Name: ${data.full_name || "-"}`;
  barangayText.textContent = `Barangay: ${data.barangay || "-"}`;
  dateText.textContent = `Date: ${formatSimpleDate(data.preferred_date)}`;
  tokenText.textContent = `Token: ${data.token}`;
}

function openOrientationQrModal() {
  console.log("opening orientation QR modal");
  const modal = document.getElementById("orientationQrModal");
  console.log("modal element:", modal);

  if (modal) {
    modal.classList.remove("hidden");
  }
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

document.addEventListener("click", (event) => {
  const qrBtn = event.target.closest(".orientation-qr-btn");
  if (qrBtn) {
    const id = qrBtn.dataset.id;
    viewOrientationQr(id);
    return;
  }

  const webBtn = event.target.closest(".orientation-web-btn");
  if (webBtn) {
    const id = webBtn.dataset.id;
    openOrientationWebExam(id);
  }
});

window.generateOrientationQr = generateOrientationQr;
window.viewOrientationQr = viewOrientationQr;
