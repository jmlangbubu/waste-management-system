// =========================
// APPROVED-ONLY ORIENTATION FILTER
// =========================

function normalizeOrientationAnyStatus(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
}

function getOrientationAppointmentStatus(item) {
  return normalizeOrientationAnyStatus(
    item?.status ||
    item?.appointment_status ||
    item?.approval_status ||
    ""
  );
}

function getOrientationRawLifecycleStatus(item) {
  return normalizeOrientationAnyStatus(
    item?.orientation_status ||
    item?.orientation_qr_status ||
    ""
  );
}

function isSwmOrientationPurpose(item) {
  return String(item?.purpose || item?.waste_type || "").trim() ===
    "SWM Orientation & Clearance";
}

function isRejectedOrCancelledOrientationRecord(item) {
  const appointmentStatus = getOrientationAppointmentStatus(item);
  const lifecycleStatus = getOrientationRawLifecycleStatus(item);

  const blockedStatuses = [
    "rejected",
    "reject",
    "cancelled",
    "canceled",
    "cancelled_orientation",
    "canceled_orientation",
    "cancelled_by_wmo",
    "canceled_by_wmo"
  ];

  return (
    blockedStatuses.includes(appointmentStatus) ||
    blockedStatuses.includes(lifecycleStatus)
  );
}

function isApprovedOrientationAppointment(item) {
  const appointmentStatus = getOrientationAppointmentStatus(item);

  /*
    Only approved appointments should enter Orientation.
    Pending stays in Appointments.
    Rejected/cancelled stays in Appointment History, not Orientation.
  */
  return appointmentStatus === "approved";
}

function isOrientationAllowedForDashboard(item) {
  return (
    isSwmOrientationPurpose(item) &&
    isApprovedOrientationAppointment(item) &&
    !isRejectedOrCancelledOrientationRecord(item)
  );
}

function getOrientationQueueRecords(records) {
  const safeRecords = Array.isArray(records) ? records : [];

  return safeRecords.filter((item) => {
    if (!isOrientationAllowedForDashboard(item)) return false;
    const lifecycleStatus = getOrientationLifecycleStatus(item);
    return ["approved", "pending_orientation", "failed_orientation", "ready_for_retake"].includes(lifecycleStatus);
  });
}


async function loadOrientationAppointments() {
  const queueBody = document.getElementById("orientationQueueTableBody");
  const historyBody = document.getElementById("orientationHistoryTableBody");

  if (!queueBody) return;

  queueBody.innerHTML = `<tr><td colspan="6">Loading orientation records...</td></tr>`;

  if (historyBody) {
    historyBody.innerHTML = `<tr><td colspan="8">Loading history...</td></tr>`;
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

    // The dedicated endpoint itself filters to this exact purpose.
    orientationAppointments = (Array.isArray(data.appointments) ? data.appointments : [])
      .map((item) => ({ ...item, purpose: item.purpose || "SWM Orientation & Clearance" }));

    const queue = getOrientationQueueRecords(orientationAppointments);
    const history = sortOrientationHistoryNewestFirst(
      orientationAppointments.filter((item) => {
        return isOrientationHistoryRecord(item);
      })
    );

    renderOrientationQueue(queue);
    renderOrientationHistory(history);
  } catch (error) {
    console.error("Error loading orientation appointments:", error);
    queueBody.innerHTML = `<tr><td colspan="6" class="empty-state">Failed to load orientation data.</td></tr>`;

    if (historyBody) {
      historyBody.innerHTML = `<tr><td colspan="8">Failed to load history.</td></tr>`;
    }
  }
}

function renderOrientationQueue(records) {
  const tableBody = document.getElementById("orientationQueueTableBody");
  if (!tableBody) return;

  if (!Array.isArray(records) || !records.length) {
    tableBody.innerHTML = `<tr><td colspan="6" class="empty-state">No orientation records available.</td></tr>`;
    return;
  }

  tableBody.innerHTML = records.map((item) => {
    const status = getOrientationLifecycleStatus(item);
    const showQr = status === "approved" || status === "pending_orientation" || status === "ready_for_retake";
    const showWebExam = (status === "pending_orientation" || status === "ready_for_retake" ||
      (status === "approved" && !isOrientationUpcoming(item)));

    return `
      <tr>
        <td>${escapeHtml(item.full_name || "-")}</td>
        <td>${escapeHtml(item.barangay || "-")}</td>
        <td>${escapeHtml(formatSimpleDate(item.preferred_date))}</td>
        <td>SWM Orientation &amp; Clearance</td>
        <td><span class="orientation-status ${getOrientationStatusClass(item)}">${getOrientationStatusLabel(item)}</span></td>
        <td><div class="orientation-queue-actions">
          ${showQr ? `<button type="button" class="orientation-qr-btn orientation-table-action" data-id="${item.id}">Open QR Code</button>` : ""}
          ${showWebExam ? `<button type="button" class="orientation-web-btn orientation-table-action" data-id="${item.id}">Take Web Exam</button>` : ""}
          ${status === "failed_orientation" ? `<button type="button" class="orientation-retake-btn orientation-table-action" data-id="${item.id}">Allow Retake</button>` : ""}
          ${status === "failed_orientation" || status === "ready_for_retake" ? `<button type="button" class="orientation-incomplete-btn orientation-table-action" data-id="${item.id}">Mark as Incomplete</button>` : ""}
        </div></td>
      </tr>
    `;
  }).join("");
}

function parseOrientationSortTime(value) {
  if (!value) return 0;

  const raw = String(value).trim();
  if (!raw) return 0;

  /*
    Supports common backend date formats:
    - 2026-05-14T13:01:33.000Z
    - 2026-05-14 21:01:33
    - 5/14/2026, 9:01:33 PM
  */
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const parsed = new Date(normalized);
  const time = parsed.getTime();

  return Number.isFinite(time) ? time : 0;
}

function getOrientationHistorySortTime(item = {}) {
  const possibleDates = [
    item.orientation_completed_at,
    item.completed_at,
    item.updated_at,
    item.orientation_started_at,
    item.preferred_date,
    item.created_at
  ];

  for (const value of possibleDates) {
    const time = parseOrientationSortTime(value);
    if (time > 0) return time;
  }

  return 0;
}

function getOrientationReferenceNumber(item = {}) {
  const code = String(item.appointment_code || item.orientation_code || "").trim();
  const numberMatch = code.match(/(\d+)\s*$/);

  if (numberMatch) {
    return Number(numberMatch[1]);
  }

  const id = Number(item.id || item.appointment_id || 0);
  return Number.isFinite(id) ? id : 0;
}

function sortOrientationHistoryNewestFirst(records = []) {
  if (!Array.isArray(records)) return [];

  return [...records].sort((a, b) => {
    const timeA = getOrientationHistorySortTime(a);
    const timeB = getOrientationHistorySortTime(b);

    if (timeA !== timeB) {
      return timeB - timeA;
    }

    const referenceA = getOrientationReferenceNumber(a);
    const referenceB = getOrientationReferenceNumber(b);

    if (referenceA !== referenceB) {
      return referenceB - referenceA;
    }

    return String(b.full_name || "").localeCompare(String(a.full_name || ""), undefined, {
      sensitivity: "base"
    });
  });
}

function ensureOrientationHistoryReportLayoutStyles() {
  if (document.getElementById("orientationHistoryReportLayoutStyles")) return;

  const style = document.createElement("style");
  style.id = "orientationHistoryReportLayoutStyles";
  style.textContent = `
    /*
      Orientation History / Report layout-only fix.
      This does not change QR, exam, certificate, API, or lifecycle logic.
    */
    #orientationHistoryModal {
      padding: 22px !important;
    }

    #orientationHistoryModal .custom-modal-content,
    #orientationHistoryModal .modal-content,
    #orientationHistoryModal .orientation-history-modal-content {
      width: min(1120px, calc(100vw - 44px)) !important;
      max-width: 1120px !important;
      margin: 0 auto !important;
      border-radius: 24px !important;
    }

    #orientationHistoryModal .modal-header,
    #orientationHistoryModal .custom-modal-header,
    #orientationHistoryModal .orientation-history-header {
      padding: 28px 34px 20px !important;
    }

    #orientationHistoryModal .modal-body,
    #orientationHistoryModal .custom-modal-body,
    #orientationHistoryModal .orientation-history-body {
      padding: 26px 34px 34px !important;
    }

    #orientationHistoryModal .table-shell {
      width: 100% !important;
      max-width: 100% !important;
      margin: 8px auto 0 !important;
      border-radius: 20px !important;
      overflow-x: auto !important;
      border: 1px solid #e5edf4 !important;
      background: #ffffff !important;
    }

    #orientationHistoryModal table {
      width: 100% !important;
      min-width: 1120px !important;
      border-collapse: collapse !important;
      table-layout: fixed !important;
    }

    #orientationHistoryModal thead th {
      padding: 18px 20px !important;
      background: #f6f8fa !important;
      color: #111827 !important;
      font-size: 13px !important;
      font-weight: 900 !important;
      letter-spacing: .02em !important;
      text-align: left !important;
      white-space: nowrap !important;
    }

    #orientationHistoryModal tbody td {
      padding: 17px 20px !important;
      color: #334155 !important;
      font-size: 13px !important;
      line-height: 1.35 !important;
      vertical-align: middle !important;
      border-top: 1px solid #edf1f5 !important;
      white-space: normal !important;
      word-break: normal !important;
    }

    #orientationHistoryModal thead th:nth-child(1),
    #orientationHistoryModal tbody td:nth-child(1) { width: 16% !important; }
    #orientationHistoryModal thead th:nth-child(2),
    #orientationHistoryModal tbody td:nth-child(2) { width: 11% !important; }
    #orientationHistoryModal thead th:nth-child(3),
    #orientationHistoryModal tbody td:nth-child(3) { width: 12% !important; }
    #orientationHistoryModal thead th:nth-child(4),
    #orientationHistoryModal tbody td:nth-child(4) { width: 18% !important; }
    #orientationHistoryModal thead th:nth-child(5),
    #orientationHistoryModal tbody td:nth-child(5) { width: 12% !important; }
    #orientationHistoryModal thead th:nth-child(6),
    #orientationHistoryModal tbody td:nth-child(6) { width: 12% !important; }
    #orientationHistoryModal thead th:nth-child(7),
    #orientationHistoryModal tbody td:nth-child(7) { width: 7% !important; text-align: center !important; }
    #orientationHistoryModal thead th:nth-child(8),
    #orientationHistoryModal tbody td:nth-child(8) { width: 12% !important; text-align: center !important; }

    #orientationHistoryModal .orientation-status {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      min-width: 110px !important;
      min-height: 30px !important;
      padding: 0 14px !important;
      border-radius: 999px !important;
      font-size: 12px !important;
      font-weight: 900 !important;
      letter-spacing: .04em !important;
      white-space: nowrap !important;
    }

    @media (max-width: 820px) {
      #orientationHistoryModal {
        padding: 10px !important;
      }

      #orientationHistoryModal .modal-header,
      #orientationHistoryModal .custom-modal-header,
      #orientationHistoryModal .orientation-history-header {
        padding: 22px 20px 16px !important;
      }

      #orientationHistoryModal .modal-body,
      #orientationHistoryModal .custom-modal-body,
      #orientationHistoryModal .orientation-history-body {
        padding: 18px 16px 24px !important;
      }

      #orientationHistoryModal table {
        min-width: 860px !important;
      }

      #orientationHistoryModal thead th,
      #orientationHistoryModal tbody td {
        padding-left: 16px !important;
        padding-right: 16px !important;
      }
    }
  `;

  document.head.appendChild(style);
}

function renderOrientationHistory(records) {
  ensureOrientationHistoryReportLayoutStyles();

  const tableBody = document.getElementById("orientationHistoryTableBody");
  if (!tableBody) return;

  if (!Array.isArray(records) || !records.length) {
    tableBody.innerHTML = `<tr><td colspan="8">No orientation history records yet.</td></tr>`;
    return;
  }

  const sortedRecords = sortOrientationHistoryNewestFirst(records);

  tableBody.innerHTML = sortedRecords.map((item) => {
    const lifecycleStatus = getOrientationLifecycleStatus(item);
    const score =
      lifecycleStatus === "completed_orientation" || lifecycleStatus === "incomplete_orientation"
        ? formatOrientationScore(item.orientation_score)
        : "-";

    const startedDate = item.orientation_started_at
      ? formatSimpleDate(item.orientation_started_at)
      : "-";

    const completedDate =
      lifecycleStatus === "completed_orientation" || lifecycleStatus === "incomplete_orientation"
        ? formatSimpleDate(item.orientation_completed_at)
        : "-";

    return `
      <tr>
        <td>${escapeHtml(item.full_name || "-")}</td>
        <td>${escapeHtml(item.barangay || "-")}</td>
        <td>${escapeHtml(formatSimpleDate(item.preferred_date))}</td>
        <td>${escapeHtml(item.purpose || "SWM Orientation & Clearance")}</td>
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
   HISTORY MODAL
========================= */

function openOrientationHistoryModal() {
  ensureOrientationHistoryReportLayoutStyles();

  const modal = document.getElementById("orientationHistoryModal");

  if (!modal) {
    console.error("orientationHistoryModal not found in HTML.");
    showToast("Orientation report modal is missing in HTML.", "error");
    return;
  }

  const history = Array.isArray(orientationAppointments)
    ? sortOrientationHistoryNewestFirst(
        orientationAppointments.filter((item) => {
          return isOrientationHistoryRecord(item);
        })
      )
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
  if (isRejectedOrCancelledOrientationRecord(item)) {
    return "cancelled_orientation";
  }

  const status = getOrientationRawLifecycleStatus(item);

  if (
    status === "incomplete" ||
    status === "incomplete_orientation" ||
    status === "expired_orientation"
  ) {
    return "incomplete_orientation";
  }

  if (status === "completed_orientation" || item?.orientation_completed_at) {
    return "completed_orientation";
  }

  if (
    status === "no_show" ||
    status === "no-show" ||
    status === "noshow" ||
    status === "missed_orientation"
  ) {
    return "no_show";
  }

  if (status === "failed_orientation" || status === "ready_for_retake") {
    return status;
  }

  if (status === "pending_orientation" || item?.orientation_started_at) {
    return "pending_orientation";
  }

  return "approved";
}

function isOrientationHistoryRecord(item) {
  /*
    Rejected/cancelled appointments belong to Appointment History,
    not Orientation Report.
  */
  if (!isSwmOrientationPurpose(item) || isRejectedOrCancelledOrientationRecord(item)) return false;

  const lifecycleStatus = getOrientationLifecycleStatus(item);

  return (
    lifecycleStatus === "completed_orientation" ||
    lifecycleStatus === "no_show" ||
    lifecycleStatus === "incomplete_orientation"
  );
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

  if (lifecycleStatus === "pending_orientation") return "Orientation in Progress";
  if (lifecycleStatus === "failed_orientation") return "Failed – Retake Required";
  if (lifecycleStatus === "ready_for_retake") return "Ready for Retake";
  if (lifecycleStatus === "completed_orientation") return "Completed";
  if (lifecycleStatus === "no_show") return "Did Not Attend";
  if (lifecycleStatus === "incomplete_orientation") return "Incomplete";
  if (lifecycleStatus === "cancelled_orientation") return "Cancelled";

  return isOrientationUpcoming(item) ? "Upcoming" : "Pending Orientation";
}

function getOrientationStatusClass(item) {
  const lifecycleStatus = getOrientationLifecycleStatus(item);

  if (lifecycleStatus === "pending_orientation") return "status-pending";
  if (lifecycleStatus === "failed_orientation") return "status-failed";
  if (lifecycleStatus === "ready_for_retake") return "status-retake-ready";
  if (lifecycleStatus === "completed_orientation") return "status-completed";
  if (lifecycleStatus === "no_show") return "status-no-show";
  if (lifecycleStatus === "incomplete_orientation") return "status-incomplete";
  if (lifecycleStatus === "cancelled_orientation") return "status-cancelled";

  return isOrientationUpcoming(item) ? "status-upcoming" : "status-approved";
}

async function postOrientationWorkflowAction(url, successMessage) {
  try {
    const response = await webAdminFetch(url, {
      method: "POST",
      headers: { Accept: "application/json" }
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.message || "Orientation action failed.");
    }
    showToast(successMessage, "success");
    await loadOrientationAppointments();
  } catch (error) {
    showToast(error.message || "Orientation action failed.", "error");
  }
}

/* =========================
   EVENTS
========================= */

document.addEventListener("click", (event) => {
  const retakeBtn = event.target.closest(".orientation-retake-btn");
  if (retakeBtn) {
    postOrientationWorkflowAction(
      getOrientationAllowRetakeApiUrl(retakeBtn.dataset.id),
      "Retake authorized."
    );
    return;
  }

  const incompleteBtn = event.target.closest(".orientation-incomplete-btn");
  if (incompleteBtn) {
    if (!window.confirm("Mark this orientation as incomplete? The participant will no longer continue the current orientation attempt.")) return;
    postOrientationWorkflowAction(
      getOrientationMarkIncompleteApiUrl(incompleteBtn.dataset.id),
      "Orientation marked incomplete."
    );
    return;
  }

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

window.renderOrientationQueue = renderOrientationQueue;
window.getOrientationQueueRecords = getOrientationQueueRecords;
window.isOrientationAllowedForDashboard = isOrientationAllowedForDashboard;
window.isSwmOrientationPurpose = isSwmOrientationPurpose;
