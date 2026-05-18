// =========================
// WASTE RECORD HELPERS (SAFE LAYER)
// =========================

function getWasteApiBase() {
  if (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) {
    return window.APP_CONFIG.API_BASE_URL;
  }

  if (window.API_BASE) {
    return window.API_BASE;
  }

  console.error("API BASE URL is not defined. Check APP_CONFIG or API_BASE.");
  return "";
}

function getCategoryPayload(record, categoryKey) {
  const rawPayload = safeParseRawPayload(record.raw_payload);
  if (!rawPayload) return null;

  return rawPayload[categoryKey] || null;
}

function getRecordDisplayName(record) {
  if (!record) return "—";
  return record.barangay_name || record.establishment_name || record.name || "—";
}

function getRecordType(record) {
  if (!record) return "—";

  const entryType = (record.entry_type || "").toString().trim().toLowerCase();

  if (entryType === "barangay") return "Barangay";
  if (entryType === "establishment") return "Establishment";

  return record.establishment_name ? "Establishment" : "Barangay";
}

function getValidationStatus(record) {
  return (record.validation_status || "Pending").toString().trim();
}

function getRecordCreatedAt(record) {
  return (
    record.validated_at ||
    record.created_at ||
    record.createdAt ||
    record.date_submitted ||
    record.dateSubmitted ||
    null
  );
}

function getStatusBadgeClass(status) {
  const normalized = String(status || "").toLowerCase();

  if (normalized === "validated") return "badge badge-approved";
  if (normalized === "pending") return "badge badge-pending";
  if (normalized === "rejected") return "badge badge-rejected";

  return "badge";
}

async function loadRecords() {
  try {
    const apiBase = getWasteApiBase();
    const response = await fetch(`${apiBase}/waste/validated-records`);
    const rawText = await response.text();
        let result = {};

        try {
  result = rawText ? JSON.parse(rawText) : {};
    } catch {
  console.error("Invalid JSON:", rawText);
  throw new Error("Invalid response format");
    }

    if (!response.ok) {
      throw new Error(result.message || "Failed to load validated records.");
    }

    validatedWasteRecords = Array.isArray(result)
      ? result
      : Array.isArray(result.data)
      ? result.data
      : [];

    populateWasteRecordFilters();
    renderWasteRecordsTable(validatedWasteRecords);
    updateWasteRecordsAnalyticsSafe(validatedWasteRecords);
  } catch (error) {
    console.error("Error loading validated waste records:", error);

    validatedWasteRecords = [];
    populateWasteRecordFilters();
    renderWasteRecordsTable([]);
    updateWasteRecordsAnalyticsSafe([]);

    const tbody = document.getElementById("wasteRecordsTableBody");
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="10" class="empty-state">Failed to load waste records.</td>
        </tr>
      `;
    }
  }
}

function populateWasteRecordFilters() {
  const barangayFilter = document.getElementById("wasteBarangayFilter");
  const typeFilter = document.getElementById("wasteTypeFilter");
  const validationFilter = document.getElementById("wasteValidationFilter");
  const monthFilter = document.getElementById("wasteMonthFilter");
  const yearFilter = document.getElementById("wasteYearFilter");

  if (!barangayFilter || !typeFilter || !validationFilter) return;

  // =========================
  // UNIQUE VALUES
  // =========================

  const uniqueNames = [...new Set(
    validatedWasteRecords
      .map(record => getRecordDisplayName(record))
      .filter(v => v && v !== "—")
  )].sort((a, b) => a.localeCompare(b));

  const uniqueTypes = [...new Set(
    validatedWasteRecords
      .map(record => getRecordType(record))
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  const uniqueStatuses = [...new Set(
    validatedWasteRecords
      .map(record => getValidationStatus(record))
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  // =========================
  // EXTRACT MONTH + YEAR
  // =========================

  const months = new Set();
  const years = new Set();

  validatedWasteRecords.forEach(record => {
    if (!record.period_start) return;

    const date = new Date(record.period_start);

    if (!isNaN(date)) {
      months.add(date.getMonth() + 1); // 1-12
      years.add(date.getFullYear());
    }
  });

  // =========================
  // POPULATE DROPDOWNS
  // =========================

  // Barangay
  barangayFilter.innerHTML = `<option value="">All Barangays</option>`;
  uniqueNames.forEach(name => {
    barangayFilter.innerHTML += `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
  });

  // Type
  typeFilter.innerHTML = `<option value="">All Types</option>`;
  uniqueTypes.forEach(type => {
    typeFilter.innerHTML += `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`;
  });

  // Status
  validationFilter.innerHTML = `<option value="">All Validation</option>`;
  uniqueStatuses.forEach(status => {
    validationFilter.innerHTML += `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`;
  });

  // =========================
  // MONTH FILTER
  // =========================

  if (monthFilter) {
    monthFilter.innerHTML = `<option value="">All Months</option>`;

    const monthNames = [
      "January","February","March","April","May","June",
      "July","August","September","October","November","December"
    ];

    [...months].sort((a, b) => a - b).forEach(m => {
      monthFilter.innerHTML += `<option value="${m}">${monthNames[m - 1]}</option>`;
    });
  }


  if (yearFilter) {
    yearFilter.innerHTML = `<option value="">All Years</option>`;

    [...years].sort((a, b) => b - a).forEach(y => {
      yearFilter.innerHTML += `<option value="${y}">${y}</option>`;
    });
  }
}

function getFilteredWasteRecords() {
  const searchValue = (document.getElementById("wasteSearchInput")?.value || "").trim().toLowerCase();
  const barangayValue = (document.getElementById("wasteBarangayFilter")?.value || "").trim().toLowerCase();
  const typeValue = (document.getElementById("wasteTypeFilter")?.value || "").trim().toLowerCase();
  const validationValue = (document.getElementById("wasteValidationFilter")?.value || "").trim().toLowerCase();
  const monthValue = (document.getElementById("wasteMonthFilter")?.value || "").trim();
  const yearValue = (document.getElementById("wasteYearFilter")?.value || "").trim();

  return validatedWasteRecords.filter(record => {
    const displayName = getRecordDisplayName(record).toLowerCase();
    const type = getRecordType(record).toLowerCase();
    const status = getValidationStatus(record).toLowerCase();
    const validatedBy = (record.validated_by || "").toString().toLowerCase();
    const remarks = (record.remarks || "").toString().toLowerCase();
    const period = formatPeriod(record.period_from, record.period_to).toLowerCase();

    const dateValue =
      record.period_from ||
      record.validated_at ||
      record.created_at ||
      record.createdAt ||
      record.date_submitted ||
      record.dateSubmitted ||
      null;

    const recordDate = dateValue ? new Date(dateValue) : null;
    const hasValidDate = recordDate && !Number.isNaN(recordDate.getTime());

    const recordMonth = hasValidDate ? String(recordDate.getMonth() + 1) : "";
    const recordYear = hasValidDate ? String(recordDate.getFullYear()) : "";

    const matchesSearch =
      !searchValue ||
      displayName.includes(searchValue) ||
      type.includes(searchValue) ||
      status.includes(searchValue) ||
      validatedBy.includes(searchValue) ||
      remarks.includes(searchValue) ||
      period.includes(searchValue);

    const matchesBarangay = !barangayValue || displayName === barangayValue;
    const matchesType = !typeValue || type === typeValue;
    const matchesValidation = !validationValue || status === validationValue;
    const matchesMonth = !monthValue || recordMonth === monthValue;
    const matchesYear = !yearValue || recordYear === yearValue;

    return (
      matchesSearch &&
      matchesBarangay &&
      matchesType &&
      matchesValidation &&
      matchesMonth &&
      matchesYear
    );
  });
}

function renderWasteRecordsTable(records) {
  const tbody = document.getElementById("wasteRecordsTableBody");
  if (!tbody) return;

  if (!Array.isArray(records) || !records.length) {
    window.__renderedWasteRecords = [];
    tbody.innerHTML = `
      <tr>
        <td colspan="11" class="empty-state">No waste records found.</td>
      </tr>
    `;
    return;
  }

  const getComparableDate = (record) => {
    if (record.period_from) {
      const d = new Date(record.period_from);
      if (!Number.isNaN(d.getTime())) return d.getTime();
    }

    const fallback = new Date(record.validated_at || record.created_at || 0);
    if (!Number.isNaN(fallback.getTime())) return fallback.getTime();

    return 0;
  };

  const getStableName = (record) => {
    return (
      record.barangay_name ||
      record.establishment_name ||
      record.name ||
      ""
    ).toString().trim().toLowerCase();
  };

  const getStableId = (record) => {
    return Number(record.id || 0);
  };

  const chronologicalRecords = [...records].sort((a, b) => {
    return (
      getComparableDate(a) - getComparableDate(b) ||
      getStableName(a).localeCompare(getStableName(b)) ||
      getStableId(a) - getStableId(b)
    );
  });

  const recordsWithControlNo = chronologicalRecords.map((record, index) => ({
    ...record,
    __controlNo: String(index + 1).padStart(2, "0")
  }));

  const displayRecords = [...recordsWithControlNo].reverse();

  window.__renderedWasteRecords = displayRecords;

  tbody.innerHTML = displayRecords.map((record, index) => {
    const name = getRecordDisplayName(record);
    const type = getRecordType(record);
    const period = formatPeriod(record.period_from, record.period_to);

    const biodegradable = formatKg(record.biodegradable_subtotal);
    const recyclable = formatKg(record.recyclable_subtotal);
    const residual = formatKg(record.residual_subtotal);
    const special = formatKg(record.special_subtotal);
    const grandTotal = formatKg(record.grand_total);

    const status = getValidationStatus(record);
    const badgeClass = getStatusBadgeClass(status);

    return `
      <tr>
        <td class="control-number-cell">${record.__controlNo}</td>
        <td>${escapeHtml(name)}</td>
        <td>${escapeHtml(type)}</td>
        <td>${escapeHtml(period)}</td>

        <td class="clickable-cell waste-cell-trigger"
            data-record-index="${index}"
            data-category-key="biodegradable"
            data-category-label="Biodegradable">
          ${escapeHtml(biodegradable)}
        </td>

        <td class="clickable-cell waste-cell-trigger"
            data-record-index="${index}"
            data-category-key="recyclable"
            data-category-label="Recyclable">
          ${escapeHtml(recyclable)}
        </td>

        <td class="clickable-cell waste-cell-trigger"
            data-record-index="${index}"
            data-category-key="residual"
            data-category-label="Residual">
          ${escapeHtml(residual)}
        </td>

        <td class="clickable-cell waste-cell-trigger"
            data-record-index="${index}"
            data-category-key="special"
            data-category-label="Special Waste">
          ${escapeHtml(special)}
        </td>

        <td>${escapeHtml(grandTotal)}</td>
        <td><span class="${badgeClass}">${escapeHtml(status)}</span></td>
        <td>
          <button
            type="button"
            class="details-arrow-btn validation-report-btn"
            data-record-index="${index}"
            aria-label="Open validation report"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M1 12C3 7 7 4 12 4C17 4 21 7 23 12C21 17 17 20 12 20C7 20 3 17 1 12Z" stroke="currentColor" stroke-width="2"/>
              <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/>
            </svg>
          </button>
        </td>
      </tr>
    `;
  }).join("");
}

function openWasteBreakdownModal(record, categoryKey, categoryLabel) {
  const modal = document.getElementById("wasteBreakdownModal");
  const title = document.getElementById("wasteBreakdownTitle");
  const subtitle = document.getElementById("wasteBreakdownSubtitle");
  const sourceName = document.getElementById("breakdownSourceName");
  const categoryName = document.getElementById("breakdownCategoryName");
  const subtotalValue = document.getElementById("breakdownSubtotalValue");
  const list = document.getElementById("wasteBreakdownList");

  if (!modal || !title || !subtitle || !sourceName || !categoryName || !subtotalValue || !list) {
    return;
  }

  const payload = getCategoryPayload(record, categoryKey);
  const source = getRecordDisplayName(record);

  title.textContent = `${categoryLabel} Breakdown`;
  subtitle.textContent = "Detailed waste inputs from raw payload";
  sourceName.textContent = source;
  categoryName.textContent = categoryLabel;

  if (!payload || typeof payload !== "object") {
    subtotalValue.textContent = "0 kg";
    list.innerHTML = `<div class="breakdown-empty">No detailed data available for this category.</div>`;
    modal.classList.remove("hidden");
    return;
  }

  const subtotal = toNumber(payload.subtotal);
  subtotalValue.textContent = formatKg(subtotal);

  const detailEntries = Object.entries(payload).filter(([key]) => key !== "subtotal");

  if (!detailEntries.length) {
    list.innerHTML = `<div class="breakdown-empty">No detailed data available for this category.</div>`;
    modal.classList.remove("hidden");
    return;
  }

  list.innerHTML = detailEntries.map(([key, value]) => `
    <div class="breakdown-row">
      <span class="breakdown-row-label">${escapeHtml(formatBreakdownLabel(key))}</span>
      <span class="breakdown-row-value">${escapeHtml(formatKg(value))}</span>
    </div>
  `).join("");

  modal.classList.remove("hidden");
}

function closeWasteBreakdownModal() {
  const modal = document.getElementById("wasteBreakdownModal");
  if (modal) {
    modal.classList.add("hidden");
  }
}

function setupWasteRecordTableClicks() {
  const tbody = document.getElementById("wasteRecordsTableBody");
  if (!tbody) return;

  tbody.addEventListener("click", (event) => {
    const cell = event.target.closest(".waste-cell-trigger");
    if (!cell) return;

    const index = Number(cell.dataset.recordIndex);
    const categoryKey = cell.dataset.categoryKey;
    const categoryLabel = cell.dataset.categoryLabel;

    const records = window.__renderedWasteRecords || [];
    const record = records[index];

    if (!record) {
      console.warn("No record found for clicked waste cell:", index);
      return;
    }

    openWasteBreakdownModal(record, categoryKey, categoryLabel);
  });
}

function setupWasteBreakdownModal() {
  const closeBtn = document.getElementById("closeWasteBreakdownModal");
  const overlay = document.getElementById("wasteBreakdownOverlay");

  closeBtn?.addEventListener("click", closeWasteBreakdownModal);
  overlay?.addEventListener("click", closeWasteBreakdownModal);
}

function setupWasteRecordFilters() {
  const searchInput = document.getElementById("wasteSearchInput");
  const barangayFilter = document.getElementById("wasteBarangayFilter");
  const typeFilter = document.getElementById("wasteTypeFilter");
  const validationFilter = document.getElementById("wasteValidationFilter");
  const monthFilter = document.getElementById("wasteMonthFilter");
  const yearFilter = document.getElementById("wasteYearFilter");
  const reportBtn = document.getElementById("generateWasteReportBtn");

  function applyWasteFilters() {
    const filtered = getFilteredWasteRecords();
    renderWasteRecordsTable(filtered);
    updateWasteRecordsAnalyticsSafe(filtered);
  }

  // =========================
  // FILTER EVENTS
  // =========================
  [
    searchInput,
    barangayFilter,
    typeFilter,
    validationFilter,
    monthFilter,
    yearFilter
  ].forEach(element => {
    if (!element) return;

    element.addEventListener("input", applyWasteFilters);
    element.addEventListener("change", applyWasteFilters);
  });

  // =========================
  // GENERATE REPORT BUTTON
  // =========================
  if (reportBtn) {
    reportBtn.addEventListener("click", () => {
      const filtered = getFilteredWasteRecords();
      generateWasteSummaryReport(filtered);
    });
  }
}

function buildReportGridItem(label, value) {
  return `
    <div class="report-grid-item">
      <div class="report-grid-label">${escapeHtml(label)}</div>
      <div class="report-grid-value">${escapeHtml(value)}</div>
    </div>
  `;
}


function buildReportFieldRow(label, value, options = {}) {
  const safeLabel = escapeHtml(label);
  const safeValue = escapeHtml(value || "—");
  const extraClass = options.highlight ? " report-field-row-highlight" : "";

  return `
    <div class="report-field-row${extraClass}">
      <div class="report-field-label">${safeLabel}</div>
      <div class="report-field-colon">:</div>
      <div class="report-field-value">${safeValue}</div>
    </div>
  `;
}

function buildWasteSummaryRow(label, value, options = {}) {
  const safeLabel = escapeHtml(label);
  const safeValue = escapeHtml(value || "0 kg");
  const extraClass = options.total ? " report-summary-total-row" : "";

  return `
    <tr class="report-summary-row${extraClass}">
      <td class="report-summary-label">${safeLabel}</td>
      <td class="report-summary-value">${safeValue}</td>
    </tr>
  `;
}

function buildReportInfoList(rows) {
  return `
    <div class="report-info-list">
      ${rows.join("")}
    </div>
  `;
}

function buildWasteSummaryTable(rows) {
  return `
    <div class="report-summary-table-wrap">
      <table class="report-summary-table">
        <tbody>
          ${rows.join("")}
        </tbody>
      </table>
    </div>
  `;
}

function openValidationDetailsModal(record) {
  const modal = document.getElementById("validationDetailsModal");
  const basicInfo = document.getElementById("reportBasicInfo");
  const wasteSummary = document.getElementById("reportWasteSummary");
  const validationInfo = document.getElementById("reportValidationInfo");
  const reportDate = document.getElementById("reportDate");
  const reportFooterValidator = document.getElementById("reportFooterValidator");

  if (!modal || !basicInfo || !wasteSummary || !validationInfo || !reportDate || !record) {
    return;
  }

  const name = getRecordDisplayName(record);
  const type = getRecordType(record);
  const period = formatPeriod(record.period_from, record.period_to);
  const grandTotal = `${formatNumber(record.grand_total)} kg`;

  const biodegradable = formatKg(record.biodegradable_subtotal);
  const recyclable = formatKg(record.recyclable_subtotal);
  const residual = formatKg(record.residual_subtotal);
  const special = formatKg(record.special_subtotal);

  const validatedBy = record.validated_by || "—";
  const validatedAt = formatDate(record.validated_at || record.created_at || record.createdAt);
  const status = getValidationStatus(record);
  const notes = record.validation_notes || "—";
  const remarks = record.remarks || "—";

  reportDate.textContent = new Date().toLocaleDateString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  if (reportFooterValidator) {
    const signatureBase64 = record.enforcer_signature || "";
    const signatureHtml = signatureBase64
      ? `<img src="data:image/png;base64,${signatureBase64}" alt="Enforcer Signature" class="report-signature-image">`
      : `<div class="report-signature-placeholder"></div>`;

    reportFooterValidator.innerHTML = `
      <div class="report-signature-block">
        <div class="report-signature-caption">
          Validated and reviewed by:
        </div>

        <div class="report-signature-box">
          ${signatureHtml}
        </div>

        <div class="report-signature-line"></div>

        <div class="report-signature-name">
          ${escapeHtml(validatedBy)}
        </div>
      </div>
    `;
  }

  basicInfo.innerHTML = buildReportInfoList([
    buildReportFieldRow("Name", name),
    buildReportFieldRow("Type", type),
    buildReportFieldRow("Period", period),
    buildReportFieldRow("Grand Total", grandTotal, { highlight: true })
  ]);

  wasteSummary.innerHTML = buildWasteSummaryTable([
    buildWasteSummaryRow("Biodegradable", biodegradable),
    buildWasteSummaryRow("Recyclable", recyclable),
    buildWasteSummaryRow("Residual", residual),
    buildWasteSummaryRow("Special Waste", special),
    buildWasteSummaryRow("Grand Total", grandTotal, { total: true })
  ]);

  validationInfo.innerHTML = buildReportInfoList([
    buildReportFieldRow("Validated By", validatedBy),
    buildReportFieldRow("Validated At", validatedAt),
    buildReportFieldRow("Validation Status", status),
    buildReportFieldRow("Validation Notes", notes),
    buildReportFieldRow("Remarks", remarks)
  ]);

  modal.classList.remove("hidden");
}

function closeValidationDetailsModal() {
  const modal = document.getElementById("validationDetailsModal");
  if (modal) {
    modal.classList.add("hidden");
  }
}

function setupValidationDetailsModal() {
  const closeBtn = document.getElementById("closeValidationDetailsModal");
  const overlay = document.getElementById("validationDetailsOverlay");
  const printBtn = document.getElementById("printReportBtn");

  closeBtn?.addEventListener("click", closeValidationDetailsModal);
  overlay?.addEventListener("click", closeValidationDetailsModal);
  printBtn?.addEventListener("click", () => window.print());
}

function setupWasteRecordValidationButtons() {
  const tbody = document.getElementById("wasteRecordsTableBody");
  if (!tbody) return;

  tbody.addEventListener("click", (event) => {
    const btn = event.target.closest(".validation-report-btn");
    if (!btn) return;

    const index = Number(btn.dataset.recordIndex);
    const records = window.__renderedWasteRecords || [];
    const record = records[index];

    if (!record) return;

    openValidationDetailsModal(record);
  });
}

function openWasteBreakdownFromTable(index, categoryKey, categoryLabel) {
  const renderedRecords = window.__renderedWasteRecords || [];
  const record = renderedRecords[index];

  if (!record) return;
  openWasteBreakdownModal(record, categoryKey, categoryLabel);
}

window.openWasteBreakdownFromTable = openWasteBreakdownFromTable;

function updateWasteRecordsAnalyticsSafe(records) {
  try {
    if (typeof updateDashboardAnalytics === "function") {
      updateDashboardAnalytics(records);
    }
  } catch (error) {
    console.warn("updateDashboardAnalytics skipped:", error);
  }

  try {
    if (typeof renderLatestSubmission === "function") {
      renderLatestSubmission(records);
    }
  } catch (error) {
    console.warn("renderLatestSubmission skipped:", error);
  }

  try {
    if (typeof renderSubmissionSources === "function") {
      renderSubmissionSources(records);
    }
  } catch (error) {
    console.warn("renderSubmissionSources skipped:", error);
  }

  try {
    if (typeof renderCategoryAnalytics === "function") {
      renderCategoryAnalytics(records);
    }
  } catch (error) {
    console.warn("renderCategoryAnalytics skipped:", error);
  }

  try {
    if (typeof renderSystemRecommendations === "function") {
      renderSystemRecommendations(records);
    }
  } catch (error) {
    console.warn("renderSystemRecommendations skipped:", error);
  }

  try {
    if (typeof renderWasteTrendOverview === "function") {
      renderWasteTrendOverview(records);
    }
  } catch (error) {
    console.warn("renderWasteTrendOverview skipped:", error);
  }
}   

function generateWasteSummaryReport(records) {
  const barangay = document.getElementById("wasteBarangayFilter")?.value || "All Barangays";
  const month = document.getElementById("wasteMonthFilter")?.selectedOptions?.[0]?.textContent || "All Months";
  const year = document.getElementById("wasteYearFilter")?.value || "All Years";

  const totalBio = records.reduce((sum, r) => sum + toNumber(r.biodegradable_subtotal), 0);
  const totalRec = records.reduce((sum, r) => sum + toNumber(r.recyclable_subtotal), 0);
  const totalRes = records.reduce((sum, r) => sum + toNumber(r.residual_subtotal), 0);
  const totalSpecial = records.reduce((sum, r) => sum + toNumber(r.special_subtotal), 0);
  const grandTotal = records.reduce((sum, r) => sum + toNumber(r.grand_total), 0);

  const reportWindow = window.open("", "_blank");

  reportWindow.document.write(`
    <html>
      <head>
        <title>Waste Summary Report</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            padding: 32px;
            color: #111827;
          }

          h1 {
            margin-bottom: 4px;
          }

          .muted {
            color: #64748b;
            margin-bottom: 24px;
          }

          .summary {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 12px;
            margin: 24px 0;
          }

          .card {
            border: 1px solid #e5e7eb;
            border-radius: 12px;
            padding: 16px;
          }

          .card span {
            display: block;
            color: #64748b;
            font-size: 13px;
          }

          .card strong {
            font-size: 22px;
          }

          table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
          }

          th, td {
            border: 1px solid #e5e7eb;
            padding: 10px;
            font-size: 13px;
            text-align: left;
          }

          th {
            background: #f8fafc;
          }

          .print-btn {
            margin-bottom: 20px;
            padding: 10px 16px;
            border: 0;
            border-radius: 8px;
            background: #15803d;
            color: white;
            font-weight: 700;
            cursor: pointer;
          }

          @media print {
            .print-btn {
              display: none;
            }
          }
        </style>
      </head>

      <body>
        <button class="print-btn" onclick="window.print()">Print Report</button>

        <h1>Waste Summary Report</h1>
        <div class="muted">
          Barangay: <strong>${escapeHtml(barangay)}</strong><br>
          Period: <strong>${escapeHtml(month)} ${escapeHtml(year)}</strong><br>
          Records Found: <strong>${records.length}</strong>
        </div>

        <div class="summary">
          <div class="card"><span>Biodegradable</span><strong>${formatNumber(totalBio)} kg</strong></div>
          <div class="card"><span>Recyclable</span><strong>${formatNumber(totalRec)} kg</strong></div>
          <div class="card"><span>Residual</span><strong>${formatNumber(totalRes)} kg</strong></div>
          <div class="card"><span>Special Waste</span><strong>${formatNumber(totalSpecial)} kg</strong></div>
          <div class="card"><span>Grand Total</span><strong>${formatNumber(grandTotal)} kg</strong></div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Control No.</th>
              <th>Name</th>
              <th>Type</th>
              <th>Period</th>
              <th>Biodegradable</th>
              <th>Recyclable</th>
              <th>Residual</th>
              <th>Special</th>
              <th>Grand Total</th>
            </tr>
          </thead>
          <tbody>
            ${records.map((record, index) => `
              <tr>
                <td>${String(index + 1).padStart(2, "0")}</td>
                <td>${escapeHtml(getRecordDisplayName(record))}</td>
                <td>${escapeHtml(getRecordType(record))}</td>
                <td>${escapeHtml(formatPeriod(record.period_from, record.period_to))}</td>
                <td>${escapeHtml(formatKg(record.biodegradable_subtotal))}</td>
                <td>${escapeHtml(formatKg(record.recyclable_subtotal))}</td>
                <td>${escapeHtml(formatKg(record.residual_subtotal))}</td>
                <td>${escapeHtml(formatKg(record.special_subtotal))}</td>
                <td>${escapeHtml(formatKg(record.grand_total))}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </body>
    </html>
  `);

  reportWindow.document.close();
}
