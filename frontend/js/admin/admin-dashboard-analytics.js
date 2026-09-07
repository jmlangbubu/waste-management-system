/* =========================
   DASHBOARD ANALYTICS
========================= */

function updateDashboardAnalytics(records = validatedWasteRecords) {
  const totalRecords = records.length;

  const totalBiodegradable = records.reduce((sum, record) => sum + toNumber(record.biodegradable_subtotal), 0);
  const totalRecyclable = records.reduce((sum, record) => sum + toNumber(record.recyclable_subtotal), 0);
  const totalResidual = records.reduce((sum, record) => sum + toNumber(record.residual_subtotal), 0);
  const totalSpecial = records.reduce((sum, record) => sum + toNumber(record.special_subtotal), 0);
  const totalGrand = records.reduce((sum, record) => sum + toNumber(record.grand_total), 0);

  const totalValidated = records.filter(record =>
    getValidationStatus(record).toLowerCase() === "validated"
  ).length;

  const totalPending = records.filter(record =>
    getValidationStatus(record).toLowerCase() === "pending"
  ).length;

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = formatNumber(value);
  };

  /* OLD / LEGACY METRICS */
  setText("totalRecordsCount", totalRecords);
  setText("totalWasteVolume", totalGrand);
  setText("validatedCount", totalValidated);
  setText("pendingCount", totalPending);

  /* DASHBOARD SUMMARY CARDS */
  setText("totalBiodegradable", totalBiodegradable);
  setText("totalRecyclable", totalRecyclable);
  setText("totalResidual", totalResidual);
  setText("totalHazardous", totalSpecial);
}

function renderLatestSubmission(records = validatedWasteRecords) {
  if (!records.length) return;

  const sortedRecords = [...records].sort((a, b) => {
    const dateA = new Date(getRecordCreatedAt(a) || 0);
    const dateB = new Date(getRecordCreatedAt(b) || 0);
    return dateB - dateA;
  });

  const latest = sortedRecords[0];

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  setText("latestSubmissionBarangay", getRecordDisplayName(latest));
  setText("latestSubmissionPersonnel", getRecordType(latest));
  setText("latestSubmissionEnforcer", latest.validated_by || "-");
  setText("latestSubmissionDate", formatDate(getRecordCreatedAt(latest)));

  const recordsToday = document.getElementById("recordsToday");
  if (recordsToday) {
    recordsToday.textContent = formatNumber(records.length);
  }
}

function setChartLoadingState(containerId, isLoading) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.classList.toggle("loading", !!isLoading);
}

function destroyChartInstance(chartInstanceRefName) {
  if (window[chartInstanceRefName]) {
    window[chartInstanceRefName].destroy();
    window[chartInstanceRefName] = null;
  }
}

function renderDashboardRecentRecords(records = validatedWasteRecords) {
  const tbody = document.getElementById("dashboardRecentRecordsBody");
  if (!tbody) return;

  if (!Array.isArray(records) || records.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="empty-state">No recent records available.</td>
      </tr>
    `;
    return;
  }

  const getValue = (record, keys, fallback = "-") => {
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null && String(record[key]).trim() !== "") {
        return record[key];
      }
    }
    return fallback;
  };

  const latest = [...records]
    .sort((a, b) => new Date(getRecordCreatedAt(b) || 0) - new Date(getRecordCreatedAt(a) || 0))
    .slice(0, 5);

  tbody.innerHTML = latest.map(record => {
    const controlNo = getValue(record, [
      "control_no",
      "controlNo",
      "control_number",
      "controlNumber",
      "reference_no",
      "referenceNo",
      "id"
    ]);

    const source = getRecordDisplayName(record) || getValue(record, [
      "barangay",
      "barangay_name",
      "establishment_name",
      "source",
      "name"
    ]);

    const type = getRecordType(record) || getValue(record, [
      "type",
      "entry_type",
      "source_type",
      "record_type"
    ]);

    const grandTotal = getValue(record, [
      "grand_total",
      "grandTotal",
      "total",
      "total_waste"
    ], 0);

    const status = getValidationStatus(record) || getValue(record, [
      "status",
      "validation_status"
    ]);

    return `
      <tr>
        <td>${escapeHtml(String(controlNo))}</td>
        <td>${escapeHtml(String(source))}</td>
        <td>${escapeHtml(String(type))}</td>
        <td>${formatNumber(toNumber(grandTotal))}</td>
        <td>${escapeHtml(String(status))}</td>
      </tr>
    `;
  }).join("");
}

/* =========================
   SUBMISSION SOURCE ANALYTICS
========================= */

function renderSubmissionSources(records = validatedWasteRecords) {
  const container = document.getElementById("barangayContributionChart");
  if (!container) return;

  let canvas = document.getElementById("submissionSourcesCanvas");
  if (!canvas) {
    container.innerHTML = `
      <div class="chart-loading-skeleton"></div>
      <canvas id="submissionSourcesCanvas"></canvas>
    `;
    canvas = document.getElementById("submissionSourcesCanvas");
  }

  const oldEmpty = container.querySelector(".dashboard-empty-box");
  if (oldEmpty) oldEmpty.remove();

  canvas.style.display = "block";
  setChartLoadingState("barangayContributionChart", true);

  const nameCount = {};

  records.forEach((record) => {
    const key = getRecordDisplayName(record);
    if (!key || key === "—") return;
    nameCount[key] = (nameCount[key] || 0) + 1;
  });

  const sorted = Object.entries(nameCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  if (submissionSourcesChartInstance) {
    submissionSourcesChartInstance.destroy();
    submissionSourcesChartInstance = null;
  }

  if (!sorted.length) {
    canvas.style.display = "none";
    container.insertAdjacentHTML("beforeend", `<div class="dashboard-empty-box">No submission source data available.</div>`);
    setChartLoadingState("barangayContributionChart", false);
    return;
  }

  const labels = sorted.map(([name]) => name);
  const values = sorted.map(([, count]) => count);

  const ctx = canvas.getContext("2d");

  submissionSourcesChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Validated Records",
          data: values,
          borderWidth: 1,
          borderRadius: 8,
          barThickness: 18
        }
      ]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 900
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              return `Records: ${formatNumber(context.raw)}`;
            }
          }
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: {
            precision: 0
          },
          grid: {
            drawBorder: false
          }
        },
        y: {
          grid: {
            display: false,
            drawBorder: false
          }
        }
      }
    }
  });

  setTimeout(() => {
    setChartLoadingState("barangayContributionChart", false);
  }, 250);
}

function setupDashboardRangeFilters() {
  const rangeButtons = document.querySelectorAll("[data-range]");

  rangeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      dashboardRange = btn.getAttribute("data-range") || "day";

      rangeButtons.forEach((item) => item.classList.remove("active"));
      btn.classList.add("active");

      updateDashboardAnalytics(validatedWasteRecords);
      renderWasteTrendOverview(validatedWasteRecords);
    });
  });
}

/* =========================
   CATEGORY ANALYTICS
========================= */

function renderCategoryAnalytics(records = validatedWasteRecords) {
  const container = document.getElementById("wasteCategoryChart");
  if (!container) return;

  const filteredRecords = getFilteredCategoryRecordsByRange(records);

  const items = [
    {
      label: "Biodegradable",
      value: filteredRecords.reduce((sum, record) => sum + toNumber(record.biodegradable_subtotal), 0)
    },
    {
      label: "Recyclable",
      value: filteredRecords.reduce((sum, record) => sum + toNumber(record.recyclable_subtotal), 0)
    },
    {
      label: "Residual",
      value: filteredRecords.reduce((sum, record) => sum + toNumber(record.residual_subtotal), 0)
    },
    {
      label: "Special Waste",
      value: filteredRecords.reduce((sum, record) => sum + toNumber(record.special_subtotal), 0)
    }
  ];

  const hasData = items.some((item) => item.value > 0);

  if (!hasData) {
    if (wasteCategoryChartInstance) {
      wasteCategoryChartInstance.destroy();
      wasteCategoryChartInstance = null;
    }

    container.innerHTML = `<div class="dashboard-empty-box">No waste category data available for this range.</div>`;
    return;
  }

  let canvas = document.getElementById("wasteCategoryCanvas");

  if (!canvas) {
    container.innerHTML = `<canvas id="wasteCategoryCanvas"></canvas>`;
    canvas = document.getElementById("wasteCategoryCanvas");
  }

  if (!canvas) return;

  try {
  if (wasteCategoryChartInstance) {
    wasteCategoryChartInstance.destroy();
    wasteCategoryChartInstance = null;
  }

  if (typeof Chart !== "undefined" && Chart.getChart) {
    const existingChart = Chart.getChart(canvas);
    if (existingChart) {
      existingChart.destroy();
    }
  }
} catch (error) {
  console.warn("Old waste category chart cleanup skipped:", error);
  wasteCategoryChartInstance = null;
}

if (typeof Chart === "undefined") {
  console.error("Chart.js is not loaded.");
  return;
}

const ctx = canvas.getContext("2d");

wasteCategoryChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: items.map((item) => item.label),
      datasets: [
        {
          label: "Waste Volume",
          data: items.map((item) => item.value),
          borderRadius: 12,
          barThickness: 24,
          backgroundColor: (context) => {
            const chart = context.chart;
            const { ctx, chartArea } = chart;

            if (!chartArea) return "#2e7d32";

            const gradient = ctx.createLinearGradient(0, chartArea.left, chartArea.right, 0);
            gradient.addColorStop(0, "#66bb6a");
            gradient.addColorStop(1, "#1b5e20");

            return gradient;
          }
        }
      ]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 900,
        easing: "easeOutQuart"
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              return `Total: ${formatNumber(context.raw)}`;
            }
          }
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: {
            callback: function(value) {
              return formatNumber(value);
            }
          },
          grid: {
            drawBorder: false
          }
        },
        y: {
          grid: {
            display: false,
            drawBorder: false
          }
        }
      }
    }
  });
}

function setupCategoryRangeFilters() {
  const categoryButtons = document.querySelectorAll("[data-category-range]");

  categoryButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      categoryRange = btn.getAttribute("data-category-range") || "day";

      categoryButtons.forEach((item) => item.classList.remove("active"));
      btn.classList.add("active");

      renderCategoryAnalytics(validatedWasteRecords);
    });
  });
}

function getFilteredCategoryRecordsByRange(records = validatedWasteRecords) {
  if (!records.length) return [];

  const now = new Date();

  return records.filter((record) => {
    const rawDate = getRecordCreatedAt(record);
    if (!rawDate) return false;

    const recordDate = new Date(rawDate);
    if (Number.isNaN(recordDate.getTime())) return false;

    if (categoryRange === "day") {
      return (
        recordDate.getFullYear() === now.getFullYear() &&
        recordDate.getMonth() === now.getMonth() &&
        recordDate.getDate() === now.getDate()
      );
    }

    if (categoryRange === "month") {
      return (
        recordDate.getFullYear() === now.getFullYear() &&
        recordDate.getMonth() === now.getMonth()
      );
    }

    if (categoryRange === "year") {
      return recordDate.getFullYear() === now.getFullYear();
    }

    return true;
  });
}

/* =========================
   SYSTEM RECOMMENDATIONS
========================= */

function renderSystemRecommendations(records = validatedWasteRecords) {
  const container = document.getElementById("recommendationList");
  if (!container) return;

  const recommendations = [];

  if (!records.length) {
    recommendations.push("No validated waste records yet. Encourage field submissions to populate dashboard analytics.");
  }

  if (records.length > 0) {
    const sourceCount = {};
    let totalWaste = 0;

    records.forEach((record) => {
      const name = getRecordDisplayName(record);
      sourceCount[name] = (sourceCount[name] || 0) + 1;
      totalWaste += toNumber(record.grand_total);
    });

    const topSourceEntry = Object.entries(sourceCount).sort((a, b) => b[1] - a[1])[0];

    if (topSourceEntry) {
      recommendations.push(
        `${topSourceEntry[0]} currently has the highest submission activity with ${topSourceEntry[1]} validated records.`
      );
    }

    if (totalWaste > 0) {
      recommendations.push(
        `Total monitored waste is now ${formatNumber(totalWaste)} units. Review collection efficiency and disposal scheduling.`
      );
    }

    const pendingCount = records.filter(
      (record) => getValidationStatus(record).toLowerCase() === "pending"
    ).length;

    if (pendingCount > 0) {
      recommendations.push(
        `${pendingCount} record(s) are still pending validation. Review enforcer validation workflow for delayed submissions.`
      );
    }
  }

  if (allWebUsers.length > 0) {
    const inactiveUsers = allWebUsers.filter(
      (user) => String(user.status || "").toLowerCase() === "inactive"
    ).length;

    if (inactiveUsers > 0) {
      recommendations.push(
        `${inactiveUsers} web account(s) are inactive. Review account access and assign only active personnel to operations.`
      );
    } else {
      recommendations.push("All current web accounts are active and available for system operations.");
    }
  }

  const monitoringActiveTruckCount = Number(
    document.getElementById("monitoringActiveTruckCount")?.textContent || 0
  );
  const monitoringMaintenanceCount = Number(
    document.getElementById("monitoringMaintenanceCount")?.textContent || 0
  );

  if (monitoringMaintenanceCount > 0) {
    recommendations.push(
      `${monitoringMaintenanceCount} truck(s) may require maintenance attention. Review truck monitoring before dispatch.`
    );
  } else {
    recommendations.push("No maintenance alerts detected. Fleet monitoring status is currently stable.");
  }

  if (monitoringActiveTruckCount === 0) {
    recommendations.push("No active truck tracking detected. Check if GPS tracking is enabled on the enforcer mobile devices.");
  }

  const finalItems = recommendations.slice(0, 4);

  container.innerHTML = finalItems.length
    ? finalItems.map((item) => `
        <div class="summary-item recommendation-item">
          <span>${escapeHtml(item)}</span>
        </div>
      `).join("")
    : `<div class="summary-item"><span>No recommendations available yet.</span></div>`;
}

/* =========================
   WASTE TREND OVERVIEW
========================= */

function getFilteredRecordsByRange(records = validatedWasteRecords) {
  if (!records.length) return [];

  const now = new Date();

  return records.filter((record) => {
    const rawDate = getRecordCreatedAt(record);
    if (!rawDate) return false;

    const recordDate = new Date(rawDate);
    if (Number.isNaN(recordDate.getTime())) return false;

    if (dashboardRange === "day") {
      return (
        recordDate.getFullYear() === now.getFullYear() &&
        recordDate.getMonth() === now.getMonth() &&
        recordDate.getDate() === now.getDate()
      );
    }

    if (dashboardRange === "month") {
      return (
        recordDate.getFullYear() === now.getFullYear() &&
        recordDate.getMonth() === now.getMonth()
      );
    }

    if (dashboardRange === "year") {
      return recordDate.getFullYear() === now.getFullYear();
    }

    return true;
  });
}

function formatTrendLabelByRange(date, range) {
  const safeDate = new Date(date);
  if (Number.isNaN(safeDate.getTime())) return "-";

  if (range === "day") {
    return safeDate.toLocaleTimeString("en-PH", {
      hour: "numeric",
      minute: "2-digit"
    });
  }

  if (range === "month") {
    return safeDate.toLocaleDateString("en-PH", {
      month: "short",
      day: "numeric"
    });
  }

  if (range === "year") {
    return safeDate.toLocaleDateString("en-PH", {
      month: "short"
    });
  }

  return safeDate.toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric"
  });
}

function getTrendDateKey(date, range) {
  const safeDate = new Date(date);
  if (Number.isNaN(safeDate.getTime())) return null;

  const year = safeDate.getFullYear();
  const month = String(safeDate.getMonth() + 1).padStart(2, "0");
  const day = String(safeDate.getDate()).padStart(2, "0");
  const hour = String(safeDate.getHours()).padStart(2, "0");

  if (range === "day") {
    return `${year}-${month}-${day} ${hour}:00`;
  }

  if (range === "month") {
    return `${year}-${month}-${day}`;
  }

  if (range === "year") {
    return `${year}-${month}`;
  }

  return `${year}-${month}-${day}`;
}

function buildWasteTrendData(records = validatedWasteRecords) {
  const filteredRecords = getFilteredRecordsByRange(records);

  if (!filteredRecords.length) {
    return [];
  }

  const grouped = new Map();

  filteredRecords.forEach((record) => {
    const rawDate = getRecordCreatedAt(record);
    if (!rawDate) return;

    const key = getTrendDateKey(rawDate, dashboardRange);
    if (!key) return;

    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        label: formatTrendLabelByRange(rawDate, dashboardRange),
        biodegradable: 0,
        recyclable: 0,
        residual: 0,
        special: 0
      });
    }

    const entry = grouped.get(key);
    entry.biodegradable += toNumber(record.biodegradable_subtotal);
    entry.recyclable += toNumber(record.recyclable_subtotal);
    entry.residual += toNumber(record.residual_subtotal);
    entry.special += toNumber(record.special_subtotal);
  });

  return Array.from(grouped.values()).sort((a, b) => a.key.localeCompare(b.key));
}

function renderWasteTrendOverview(records = validatedWasteRecords) {
  const container = document.getElementById("wasteTrendChart");
  if (!container) return;

  let canvas = document.getElementById("wasteTrendCanvas");

  const trendData = buildWasteTrendData(records);

  if (!trendData.length) {
    if (wasteTrendChartInstance) {
      wasteTrendChartInstance.destroy();
      wasteTrendChartInstance = null;
    }

    container.innerHTML = `<div class="dashboard-empty-box">No waste monitoring data available for this range.</div>`;
    return;
  }

  if (!canvas) {
    container.innerHTML = `<canvas id="wasteTrendCanvas"></canvas>`;
    canvas = document.getElementById("wasteTrendCanvas");
  }

  if (!canvas) return;

  const labels = trendData.map(item => item.label);
  const biodegradableData = trendData.map(item => item.biodegradable);
  const recyclableData = trendData.map(item => item.recyclable);
  const residualData = trendData.map(item => item.residual);
  const specialData = trendData.map(item => item.special);

 try {
  if (wasteTrendChartInstance) {
    wasteTrendChartInstance.destroy();
    wasteTrendChartInstance = null;
  }

  if (typeof Chart !== "undefined" && Chart.getChart) {
    const existingChart = Chart.getChart(canvas);
    if (existingChart) {
      existingChart.destroy();
    }
  }
} catch (error) {
  console.warn("Old waste trend chart cleanup skipped:", error);
  wasteTrendChartInstance = null;
}

if (typeof Chart === "undefined") {
  console.error("Chart.js is not loaded.");
  return;
}

const ctx = canvas.getContext("2d");

wasteTrendChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
  {
    label: "Bio",
    data: biodegradableData,
    borderWidth: 3,
    tension: 0.35,
    fill: false,
    pointRadius: 5,
    pointHoverRadius: 7
  },
  {
    label: "Recycle",
    data: recyclableData,
    borderWidth: 3,
    tension: 0.35,
    fill: false,
    pointRadius: 5,
    pointHoverRadius: 7
  },
  {
    label: "Residual",
    data: residualData,
    borderWidth: 3,
    tension: 0.35,
    fill: false,
    pointRadius: 5,
    pointHoverRadius: 7
  },
  {
    label: "Special",
    data: specialData,
    borderWidth: 3,
    tension: 0.35,
    fill: false,
    pointRadius: 5,
    pointHoverRadius: 7
  }
]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false
      },
      plugins: {
        legend: {
          position: "top",
          labels: {
            usePointStyle: true,
            boxWidth: 10,
            padding: 16
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              return `${context.dataset.label}: ${formatNumber(context.raw)}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            display: false
          }
        },
        y: {
          beginAtZero: true,
          ticks: {
            callback: function(value) {
              return formatNumber(value);
            }
          }
        }
      }
    }
  });
}

/* =========================
   DASHBOARD INIT
========================= */

function initializeDashboardData() {
  try {
    updateDashboardAnalytics(validatedWasteRecords);
  } catch (error) {
    console.error("updateDashboardAnalytics error:", error);
  }

  try {
    renderWasteTrendOverview(validatedWasteRecords);
  } catch (error) {
    console.error("renderWasteTrendOverview error:", error);
  }

  try {
    renderLatestSubmission(validatedWasteRecords);
  } catch (error) {
    console.error("renderLatestSubmission error:", error);
  }

  try {
    renderSubmissionSources(validatedWasteRecords);
  } catch (error) {
    console.error("renderSubmissionSources error:", error);
  }

  try {
    renderWebUserActivity();
  } catch (error) {
    console.error("renderWebUserActivity error:", error);
  }

  try {
    renderCategoryAnalytics(validatedWasteRecords);
  } catch (error) {
    console.error("renderCategoryAnalytics error:", error);
  }

  try {
    renderSystemRecommendations(validatedWasteRecords);
  } catch (error) {
    console.error("renderSystemRecommendations error:", error);
  }
}

function renderWebUserActivity() {
  const container = document.getElementById("webUsersChart");
  if (!container) return;

  let canvas = document.getElementById("webUsersActivityCanvas");
  if (!canvas) {
    container.innerHTML = `
      <div class="chart-loading-skeleton"></div>
      <canvas id="webUsersActivityCanvas"></canvas>
    `;
    canvas = document.getElementById("webUsersActivityCanvas");
  }

  const oldEmpty = container.querySelector(".dashboard-empty-box");
  if (oldEmpty) oldEmpty.remove();

  canvas.style.display = "block";
  setChartLoadingState("webUsersChart", true);

  const users = Array.isArray(allWebUsers) ? allWebUsers : [];

  let activeCount = 0;
  let suspendedCount = 0;
  let inactiveCount = 0;

  users.forEach(user => {
    const status = String(user.status || "").toLowerCase().trim();

    if (status === "active") activeCount++;
    else if (status === "suspended") suspendedCount++;
    else if (status === "inactive") inactiveCount++;
  });

  if (webUsersActivityChartInstance) {
    webUsersActivityChartInstance.destroy();
    webUsersActivityChartInstance = null;
  }

  if (!users.length) {
    canvas.style.display = "none";
    container.insertAdjacentHTML("beforeend", `<div class="dashboard-empty-box">No web user data available.</div>`);
    setChartLoadingState("webUsersChart", false);
    return;
  }

  const ctx = canvas.getContext("2d");

  webUsersActivityChartInstance = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Active", "Suspended", "Inactive"],
      datasets: [
        {
          data: [activeCount, suspendedCount, inactiveCount],
          backgroundColor: [
            "#3B9AE1",
            "#FF5C5C",
            "#F4B5C0"
          ],
          borderWidth: 0,
          hoverOffset: 8
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        animateRotate: true,
        duration: 900
      },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            usePointStyle: true,
            boxWidth: 10,
            padding: 14
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              return `${context.label}: ${formatNumber(context.raw)}`;
            }
          }
        }
      },
      cutout: "62%"
    }
  });

  setTimeout(() => {
    setChartLoadingState("webUsersChart", false);
  }, 250);
}
/* =========================================================
   DASHBOARD ANALYTICS FINAL UPDATE
   Period filter + cleaner empty chart states
   Added safely at bottom to override earlier functions.

   Features:
   - Today / Current Month / Last Month / Last 3 Months / This Year
   - Existing Day / Month / Year buttons still work
   - Waste Monitoring summary cards follow selected trend period
   - Waste Trend chart filters by selected period
   - Waste Category Analytics filters by selected category period
   - Empty states are centered and cleaner
========================================================= */

function formatDashboardLocalDate(date) {
  const safeDate = new Date(date);
  if (Number.isNaN(safeDate.getTime())) return "";

  const year = safeDate.getFullYear();
  const month = String(safeDate.getMonth() + 1).padStart(2, "0");
  const day = String(safeDate.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getDashboardPeriodRange(periodKey) {
  const now = new Date();

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  if (periodKey === "today") {
    return {
      periodKey,
      rangeType: "day",
      label: "Today",
      startDate: todayStart,
      endDate: todayEnd
    };
  }

  if (periodKey === "current_month") {
    return {
      periodKey,
      rangeType: "month",
      label: "Current Month",
      startDate: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
      endDate: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
    };
  }

  if (periodKey === "last_month") {
    return {
      periodKey,
      rangeType: "month",
      label: "Last Month",
      startDate: new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0),
      endDate: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
    };
  }

  if (periodKey === "last_3_months") {
    return {
      periodKey,
      rangeType: "year",
      label: "Last 3 Months",
      startDate: new Date(now.getFullYear(), now.getMonth() - 2, 1, 0, 0, 0, 0),
      endDate: todayEnd
    };
  }

  if (periodKey === "this_year") {
    return {
      periodKey,
      rangeType: "year",
      label: "This Year",
      startDate: new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0),
      endDate: new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999)
    };
  }

  return getDashboardPeriodRange("today");
}

function mapDashboardRangeToPeriodKey(range) {
  if (range === "day") return "today";
  if (range === "month") return "current_month";
  if (range === "year") return "this_year";
  return "today";
}

function getSelectedDashboardTrendPeriodKey() {
  return (
    localStorage.getItem("dashboardTrendPeriod") ||
    mapDashboardRangeToPeriodKey(typeof dashboardRange !== "undefined" ? dashboardRange : "day")
  );
}

function getSelectedDashboardCategoryPeriodKey() {
  return (
    localStorage.getItem("dashboardCategoryPeriod") ||
    mapDashboardRangeToPeriodKey(typeof categoryRange !== "undefined" ? categoryRange : "day")
  );
}

function setActiveDashboardSegment(selector, rangeType) {
  const buttons = document.querySelectorAll(selector);

  buttons.forEach((btn) => {
    const value = btn.getAttribute(
      selector.includes("category") ? "data-category-range" : "data-range"
    );

    btn.classList.toggle("active", value === rangeType);
  });
}

function getDashboardRecordDate(record) {
  const rawDate = getRecordCreatedAt(record);
  if (!rawDate) return null;

  const date = new Date(rawDate);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isRecordWithinDashboardRange(record, periodInfo) {
  const recordDate = getDashboardRecordDate(record);
  if (!recordDate) return false;

  return recordDate >= periodInfo.startDate && recordDate <= periodInfo.endDate;
}

function getFilteredRecordsByPeriod(records = validatedWasteRecords, periodKey = "today") {
  if (!Array.isArray(records) || !records.length) return [];

  const periodInfo = getDashboardPeriodRange(periodKey);

  return records.filter((record) => isRecordWithinDashboardRange(record, periodInfo));
}

/*
  Override old trend filtering.
  This now supports Last Month and Last 3 Months, not only current day/month/year.
*/
function getFilteredRecordsByRange(records = validatedWasteRecords) {
  const periodKey = getSelectedDashboardTrendPeriodKey();
  const periodInfo = getDashboardPeriodRange(periodKey);

  dashboardRange = periodInfo.rangeType;

  return getFilteredRecordsByPeriod(records, periodKey);
}

/*
  Override old category filtering.
*/
function getFilteredCategoryRecordsByRange(records = validatedWasteRecords) {
  const periodKey = getSelectedDashboardCategoryPeriodKey();
  const periodInfo = getDashboardPeriodRange(periodKey);

  categoryRange = periodInfo.rangeType;

  return getFilteredRecordsByPeriod(records, periodKey);
}

function createDashboardPeriodSelect(id, storageKey, filterType) {
  const select = document.createElement("select");
  select.id = id;
  select.className = "dashboard-period-select";
  select.setAttribute("aria-label", `${filterType} period filter`);

  select.innerHTML = `
    <option value="today">Today</option>
    <option value="current_month">Current Month</option>
    <option value="last_month">Last Month</option>
    <option value="last_3_months">Last 3 Months</option>
    <option value="this_year">This Year</option>
  `;

  select.value = localStorage.getItem(storageKey) || "today";

  select.addEventListener("change", () => {
    if (filterType === "trend") {
      setDashboardTrendPeriod(select.value);
    } else {
      setDashboardCategoryPeriod(select.value);
    }
  });

  return select;
}

function setupDashboardAdvancedPeriodFilters() {
  if (window.__dashboardAdvancedPeriodFiltersInitialized === true) {
    syncDashboardPeriodSelects();
    return;
  }

  window.__dashboardAdvancedPeriodFiltersInitialized = true;

  const trendActions = document
    .querySelector("#viewAllAnalyticsBtn")
    ?.closest(".dashboard-header-actions");

  const categoryActions = document
    .querySelector("#viewAllWasteMixBtn")
    ?.closest(".dashboard-header-actions");

  if (trendActions && !document.getElementById("dashboardTrendPeriodSelect")) {
    const trendSelect = createDashboardPeriodSelect(
      "dashboardTrendPeriodSelect",
      "dashboardTrendPeriod",
      "trend"
    );

    trendActions.appendChild(trendSelect);
  }

  if (categoryActions && !document.getElementById("dashboardCategoryPeriodSelect")) {
    const categorySelect = createDashboardPeriodSelect(
      "dashboardCategoryPeriodSelect",
      "dashboardCategoryPeriod",
      "category"
    );

    categoryActions.appendChild(categorySelect);
  }

  syncDashboardPeriodSelects();
}

function syncDashboardPeriodSelects() {
  const trendSelect = document.getElementById("dashboardTrendPeriodSelect");
  const categorySelect = document.getElementById("dashboardCategoryPeriodSelect");

  if (trendSelect) {
    trendSelect.value = getSelectedDashboardTrendPeriodKey();
  }

  if (categorySelect) {
    categorySelect.value = getSelectedDashboardCategoryPeriodKey();
  }

  const trendInfo = getDashboardPeriodRange(getSelectedDashboardTrendPeriodKey());
  const categoryInfo = getDashboardPeriodRange(getSelectedDashboardCategoryPeriodKey());

  setActiveDashboardSegment("[data-range]", trendInfo.rangeType);
  setActiveDashboardSegment("[data-category-range]", categoryInfo.rangeType);
}

function setDashboardTrendPeriod(periodKey) {
  const periodInfo = getDashboardPeriodRange(periodKey);

  localStorage.setItem("dashboardTrendPeriod", periodKey);
  dashboardRange = periodInfo.rangeType;

  syncDashboardPeriodSelects();

  const filteredRecords = getFilteredRecordsByRange(validatedWasteRecords);

  updateDashboardAnalytics(filteredRecords);
  renderWasteTrendOverview(validatedWasteRecords);

  document.dispatchEvent(
    new CustomEvent("dashboard:periodFilterChanged", {
      detail: {
        filterType: "trend",
        periodKey,
        label: periodInfo.label,
        rangeType: periodInfo.rangeType,
        startDate: formatDashboardLocalDate(periodInfo.startDate),
        endDate: formatDashboardLocalDate(periodInfo.endDate)
      }
    })
  );
}

function setDashboardCategoryPeriod(periodKey) {
  const periodInfo = getDashboardPeriodRange(periodKey);

  localStorage.setItem("dashboardCategoryPeriod", periodKey);
  categoryRange = periodInfo.rangeType;

  syncDashboardPeriodSelects();
  renderCategoryAnalytics(validatedWasteRecords);

  document.dispatchEvent(
    new CustomEvent("dashboard:periodFilterChanged", {
      detail: {
        filterType: "category",
        periodKey,
        label: periodInfo.label,
        rangeType: periodInfo.rangeType,
        startDate: formatDashboardLocalDate(periodInfo.startDate),
        endDate: formatDashboardLocalDate(periodInfo.endDate)
      }
    })
  );
}

/*
  Override old Day / Month / Year filter setup.
  Existing buttons still work, but they now map to:
  Day = Today
  Month = Current Month
  Year = This Year
*/
function setupDashboardRangeFilters() {
  const rangeButtons = document.querySelectorAll("[data-range]");

  rangeButtons.forEach((btn) => {
    btn.onclick = () => {
      const range = btn.getAttribute("data-range") || "day";
      setDashboardTrendPeriod(mapDashboardRangeToPeriodKey(range));
    };
  });

  syncDashboardPeriodSelects();
}

function setupCategoryRangeFilters() {
  const categoryButtons = document.querySelectorAll("[data-category-range]");

  categoryButtons.forEach((btn) => {
    btn.onclick = () => {
      const range = btn.getAttribute("data-category-range") || "day";
      setDashboardCategoryPeriod(mapDashboardRangeToPeriodKey(range));
    };
  });

  syncDashboardPeriodSelects();
}

function renderDashboardChartEmpty(container, message, subText) {
  if (!container) return;

  container.innerHTML = `
    <div class="dashboard-chart-empty">
      <span>${escapeHtml(message)}</span>
      <small>${escapeHtml(subText || "")}</small>
    </div>
  `;
}

function renderWasteTrendOverview(records = validatedWasteRecords) {
  const container = document.getElementById("wasteTrendChart");
  if (!container) return;

  let canvas = document.getElementById("wasteTrendCanvas");

  const trendData = buildWasteTrendData(records);
  const periodInfo = getDashboardPeriodRange(getSelectedDashboardTrendPeriodKey());

  if (!trendData.length) {
    if (wasteTrendChartInstance) {
      wasteTrendChartInstance.destroy();
      wasteTrendChartInstance = null;
    }

    renderDashboardChartEmpty(
      container,
      "No waste monitoring data available for this range.",
      `${periodInfo.label}: ${formatDashboardLocalDate(periodInfo.startDate)} to ${formatDashboardLocalDate(periodInfo.endDate)}`
    );
    return;
  }

  if (!canvas) {
    container.innerHTML = `<canvas id="wasteTrendCanvas"></canvas>`;
    canvas = document.getElementById("wasteTrendCanvas");
  }

  if (!canvas) return;

  const labels = trendData.map(item => item.label);
  const biodegradableData = trendData.map(item => item.biodegradable);
  const recyclableData = trendData.map(item => item.recyclable);
  const residualData = trendData.map(item => item.residual);
  const specialData = trendData.map(item => item.special);

  try {
    if (wasteTrendChartInstance) {
      wasteTrendChartInstance.destroy();
      wasteTrendChartInstance = null;
    }

    if (typeof Chart !== "undefined" && Chart.getChart) {
      const existingChart = Chart.getChart(canvas);
      if (existingChart) existingChart.destroy();
    }
  } catch (error) {
    console.warn("Old waste trend chart cleanup skipped:", error);
    wasteTrendChartInstance = null;
  }

  if (typeof Chart === "undefined") {
    console.error("Chart.js is not loaded.");
    renderDashboardChartEmpty(
      container,
      "Chart.js is not loaded.",
      "Please check if the Chart.js script is included before dashboard analytics."
    );
    return;
  }

  const ctx = canvas.getContext("2d");

  wasteTrendChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Bio",
          data: biodegradableData,
          borderWidth: 3,
          tension: 0.35,
          fill: false,
          pointRadius: 5,
          pointHoverRadius: 7
        },
        {
          label: "Recycle",
          data: recyclableData,
          borderWidth: 3,
          tension: 0.35,
          fill: false,
          pointRadius: 5,
          pointHoverRadius: 7
        },
        {
          label: "Residual",
          data: residualData,
          borderWidth: 3,
          tension: 0.35,
          fill: false,
          pointRadius: 5,
          pointHoverRadius: 7
        },
        {
          label: "Special",
          data: specialData,
          borderWidth: 3,
          tension: 0.35,
          fill: false,
          pointRadius: 5,
          pointHoverRadius: 7
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false
      },
      plugins: {
        legend: {
          position: "top",
          labels: {
            usePointStyle: true,
            boxWidth: 10,
            padding: 16
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              return `${context.dataset.label}: ${formatNumber(context.raw)}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            display: false
          }
        },
        y: {
          beginAtZero: true,
          ticks: {
            callback: function(value) {
              return formatNumber(value);
            }
          }
        }
      }
    }
  });
}

function renderCategoryAnalytics(records = validatedWasteRecords) {
  const container = document.getElementById("wasteCategoryChart");
  if (!container) return;

  const filteredRecords = getFilteredCategoryRecordsByRange(records);
  const periodInfo = getDashboardPeriodRange(getSelectedDashboardCategoryPeriodKey());

  const items = [
    {
      label: "Biodegradable",
      value: filteredRecords.reduce((sum, record) => sum + toNumber(record.biodegradable_subtotal), 0)
    },
    {
      label: "Recyclable",
      value: filteredRecords.reduce((sum, record) => sum + toNumber(record.recyclable_subtotal), 0)
    },
    {
      label: "Residual",
      value: filteredRecords.reduce((sum, record) => sum + toNumber(record.residual_subtotal), 0)
    },
    {
      label: "Special Waste",
      value: filteredRecords.reduce((sum, record) => sum + toNumber(record.special_subtotal), 0)
    }
  ];

  const hasData = items.some((item) => item.value > 0);

  if (!hasData) {
    if (wasteCategoryChartInstance) {
      wasteCategoryChartInstance.destroy();
      wasteCategoryChartInstance = null;
    }

    renderDashboardChartEmpty(
      container,
      "No waste category data available for this range.",
      `${periodInfo.label}: ${formatDashboardLocalDate(periodInfo.startDate)} to ${formatDashboardLocalDate(periodInfo.endDate)}`
    );
    return;
  }

  let canvas = document.getElementById("wasteCategoryCanvas");

  if (!canvas) {
    container.innerHTML = `<canvas id="wasteCategoryCanvas"></canvas>`;
    canvas = document.getElementById("wasteCategoryCanvas");
  }

  if (!canvas) return;

  try {
    if (wasteCategoryChartInstance) {
      wasteCategoryChartInstance.destroy();
      wasteCategoryChartInstance = null;
    }

    if (typeof Chart !== "undefined" && Chart.getChart) {
      const existingChart = Chart.getChart(canvas);
      if (existingChart) existingChart.destroy();
    }
  } catch (error) {
    console.warn("Old waste category chart cleanup skipped:", error);
    wasteCategoryChartInstance = null;
  }

  if (typeof Chart === "undefined") {
    console.error("Chart.js is not loaded.");
    renderDashboardChartEmpty(
      container,
      "Chart.js is not loaded.",
      "Please check if the Chart.js script is included before dashboard analytics."
    );
    return;
  }

  const ctx = canvas.getContext("2d");

  wasteCategoryChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: items.map((item) => item.label),
      datasets: [
        {
          label: "Waste Volume",
          data: items.map((item) => item.value),
          borderRadius: 6,
          borderSkipped: false,
          barThickness: 14,
          maxBarThickness: 16,
          categoryPercentage: 0.72,
          barPercentage: 0.86,
          backgroundColor: (context) => {
            const chart = context.chart;
            const { ctx, chartArea } = chart;

            if (!chartArea) return "#2e7d32";

            const gradient = ctx.createLinearGradient(0, chartArea.left, chartArea.right, 0);
            gradient.addColorStop(0, "#66bb6a");
            gradient.addColorStop(1, "#1b5e20");

            return gradient;
          }
        }
      ]
    },
    plugins: [
      {
        id: "wmoCategoryBarPresentation",
        beforeDatasetsUpdate(chart) {
          chart.data.datasets.forEach((dataset) => {
            dataset.borderRadius = 6;
            dataset.borderSkipped = false;
          });
        }
      }
    ],
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: {
          top: 8,
          right: 12,
          bottom: 8,
          left: 6
        }
      },
      animation: {
        duration: 900,
        easing: "easeOutQuart"
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              return `Total: ${formatNumber(context.raw)}`;
            }
          }
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: {
            color: "#7b8981",
            padding: 6,
            maxRotation: 0,
            minRotation: 0,
            font: {
              size: 11,
              weight: "500"
            },
            callback: function(value) {
              return formatNumber(value);
            }
          },
          grid: {
            color: "rgba(76, 101, 88, 0.10)",
            lineWidth: 1,
            drawTicks: false
          },
          border: {
            display: true,
            color: "rgba(76, 101, 88, 0.16)",
            width: 1
          }
        },
        y: {
          ticks: {
            autoSkip: false,
            color: "#5f6f66",
            padding: 10,
            font: {
              size: 12,
              weight: "500"
            }
          },
          grid: {
            display: false
          },
          border: {
            display: true,
            color: "rgba(76, 101, 88, 0.16)",
            width: 1
          }
        }
      }
    }
  });
}

async function initializeDashboardData() {
  setupDashboardAdvancedPeriodFilters();
  setupDashboardRangeFilters();
  setupCategoryRangeFilters();

  try {
    updateDashboardAnalytics(getFilteredRecordsByRange(validatedWasteRecords));
  } catch (error) {
    console.error("updateDashboardAnalytics error:", error);
  }

  try {
    renderWasteTrendOverview(validatedWasteRecords);
  } catch (error) {
    console.error("renderWasteTrendOverview error:", error);
  }

  try {
    renderLatestSubmission(validatedWasteRecords);
  } catch (error) {
    console.error("renderLatestSubmission error:", error);
  }

  try {
    renderSubmissionSources(validatedWasteRecords);
  } catch (error) {
    console.error("renderSubmissionSources error:", error);
  }

  try {
    renderWebUserActivity();
  } catch (error) {
    console.error("renderWebUserActivity error:", error);
  }

  try {
    renderCategoryAnalytics(validatedWasteRecords);
  } catch (error) {
    console.error("renderCategoryAnalytics error:", error);
  }

  try {
    renderSystemRecommendations(validatedWasteRecords);
  } catch (error) {
    console.error("renderSystemRecommendations error:", error);
  }

  syncDashboardPeriodSelects();
  await loadDashboardOperationsSnapshot();
}

document.addEventListener("DOMContentLoaded", () => {
  setupDashboardAdvancedPeriodFilters();
  setupDashboardRangeFilters();
  setupCategoryRangeFilters();

  setTimeout(() => {
    syncDashboardPeriodSelects();
  }, 250);
});

/* Useful globals for testing/debugging */
window.getDashboardPeriodRange = getDashboardPeriodRange;
window.setDashboardTrendPeriod = setDashboardTrendPeriod;
window.setDashboardCategoryPeriod = setDashboardCategoryPeriod;
window.setupDashboardAdvancedPeriodFilters = setupDashboardAdvancedPeriodFilters;
/* =========================================================
   DASHBOARD CUSTOM PERIOD DROPDOWN UI - FULL INTEGRATED
   Purpose:
   - Hide native browser select dropdown
   - Render professional custom dropdown
   - Keep original select synced with existing filter logic
   - Works with dashboardTrendPeriodSelect and dashboardCategoryPeriodSelect
========================================================= */

function getDashboardSelectLabel(select) {
  if (!select) return "-";

  const selectedOption = select.options[select.selectedIndex];
  return selectedOption ? selectedOption.textContent.trim() : "-";
}

function closeAllDashboardCustomDropdowns(exceptWrapper = null) {
  document.querySelectorAll(".dashboard-custom-select.open").forEach((wrapper) => {
    if (wrapper !== exceptWrapper) {
      wrapper.classList.remove("open");

      const btn = wrapper.querySelector(".dashboard-custom-select-btn");
      if (btn) btn.setAttribute("aria-expanded", "false");
    }
  });
}

function syncDashboardCustomDropdown(select) {
  if (!select || !select.id) return;

  const wrapper = document.querySelector(
    `.dashboard-custom-select[data-for="${select.id}"]`
  );

  if (!wrapper) return;

  const label = wrapper.querySelector(".dashboard-custom-select-label");
  if (label) label.textContent = getDashboardSelectLabel(select);

  wrapper.querySelectorAll(".dashboard-custom-select-option").forEach((optionBtn) => {
    const isActive = optionBtn.dataset.value === select.value;

    optionBtn.classList.toggle("active", isActive);
    optionBtn.setAttribute("aria-selected", isActive ? "true" : "false");
  });
}

function buildDashboardCustomDropdown(select) {
  if (!select || !select.id) return;

  const existingWrapper = document.querySelector(
    `.dashboard-custom-select[data-for="${select.id}"]`
  );

  if (existingWrapper) {
    select.classList.add("dashboard-native-hidden");
    syncDashboardCustomDropdown(select);
    return;
  }

  select.classList.add("dashboard-native-hidden");

  const wrapper = document.createElement("div");
  wrapper.className = "dashboard-custom-select";
  wrapper.dataset.for = select.id;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "dashboard-custom-select-btn";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");

  button.innerHTML = `
    <span class="dashboard-custom-select-label">${getDashboardSelectLabel(select)}</span>
    <span class="dashboard-custom-select-arrow">⌄</span>
  `;

  const menu = document.createElement("div");
  menu.className = "dashboard-custom-select-menu";
  menu.setAttribute("role", "listbox");

  Array.from(select.options).forEach((option) => {
    const optionBtn = document.createElement("button");
    optionBtn.type = "button";
    optionBtn.className = "dashboard-custom-select-option";
    optionBtn.dataset.value = option.value;
    optionBtn.textContent = option.textContent;
    optionBtn.setAttribute("role", "option");
    optionBtn.setAttribute("aria-selected", option.value === select.value ? "true" : "false");

    if (option.value === select.value) {
      optionBtn.classList.add("active");
    }

    optionBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      select.value = option.value;

      select.dispatchEvent(
        new Event("change", {
          bubbles: true
        })
      );

      syncDashboardCustomDropdown(select);

      wrapper.classList.remove("open");
      button.setAttribute("aria-expanded", "false");
    });

    menu.appendChild(optionBtn);
  });

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    const willOpen = !wrapper.classList.contains("open");

    closeAllDashboardCustomDropdowns(wrapper);

    wrapper.classList.toggle("open", willOpen);
    button.setAttribute("aria-expanded", willOpen ? "true" : "false");
  });

  wrapper.appendChild(button);
  wrapper.appendChild(menu);

  select.insertAdjacentElement("afterend", wrapper);

  select.addEventListener("change", () => {
    syncDashboardCustomDropdown(select);
  });

  syncDashboardCustomDropdown(select);
}

function setupDashboardCustomPeriodDropdowns() {
  const selects = [
    document.getElementById("dashboardTrendPeriodSelect"),
    document.getElementById("dashboardCategoryPeriodSelect")
  ].filter(Boolean);

  selects.forEach(buildDashboardCustomDropdown);
}

document.addEventListener("click", () => {
  closeAllDashboardCustomDropdowns();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeAllDashboardCustomDropdowns();
  }
});

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(setupDashboardCustomPeriodDropdowns, 80);
  setTimeout(setupDashboardCustomPeriodDropdowns, 350);
  setTimeout(setupDashboardCustomPeriodDropdowns, 900);
});

/*
  Wrap period-filter setup so custom dropdowns are always created after
  the native period selects are inserted into the DOM.
*/
if (typeof setupDashboardAdvancedPeriodFilters === "function" && !window.__dashboardCustomDropdownSetupWrapped) {
  window.__dashboardCustomDropdownSetupWrapped = true;

  const originalSetupDashboardAdvancedPeriodFilters = setupDashboardAdvancedPeriodFilters;

  setupDashboardAdvancedPeriodFilters = function patchedSetupDashboardAdvancedPeriodFilters() {
    originalSetupDashboardAdvancedPeriodFilters();
    setupDashboardCustomPeriodDropdowns();
  };

  window.setupDashboardAdvancedPeriodFilters = setupDashboardAdvancedPeriodFilters;
}

/*
  Wrap select sync so custom UI always follows the real select value.
*/
if (typeof syncDashboardPeriodSelects === "function" && !window.__dashboardCustomDropdownSyncWrapped) {
  window.__dashboardCustomDropdownSyncWrapped = true;

  const originalSyncDashboardPeriodSelects = syncDashboardPeriodSelects;

  syncDashboardPeriodSelects = function patchedSyncDashboardPeriodSelects() {
    originalSyncDashboardPeriodSelects();
    setupDashboardCustomPeriodDropdowns();

    document
      .querySelectorAll(".dashboard-period-select")
      .forEach(syncDashboardCustomDropdown);
  };

  window.syncDashboardPeriodSelects = syncDashboardPeriodSelects;
}

window.setupDashboardCustomPeriodDropdowns = setupDashboardCustomPeriodDropdowns;
window.syncDashboardCustomDropdown = syncDashboardCustomDropdown;
window.closeAllDashboardCustomDropdowns = closeAllDashboardCustomDropdowns;

/* =========================================================
   DASHBOARD OPERATIONS SNAPSHOT
   Read-only aggregation of existing Fleet, Dispatch, and
   Tracking endpoints. No polling or management actions live here.
========================================================= */

const DASHBOARD_OPERATIONS_TIME_ZONE = "Asia/Manila";

function dashboardOperationsElement(id) {
  return document.getElementById(id);
}

function dashboardOperationsSetText(id, value) {
  const element = dashboardOperationsElement(id);
  if (element) element.textContent = String(value ?? "—");
}

function dashboardOperationsSetStatus(id, label, state = "neutral") {
  const element = dashboardOperationsElement(id);
  if (!element) return;
  element.textContent = String(label || "Unavailable");
  element.dataset.state = state;
}

function dashboardOperationsCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
}

function dashboardOperationsList(value) {
  return Array.isArray(value) ? value : [];
}

function dashboardOperationsCalendarDate(now = new Date(), offsetDays = 0) {
  if (typeof dispatchPlanCalendarDate === "function") {
    return dispatchPlanCalendarDate(now, offsetDays);
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DASHBOARD_OPERATIONS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts
      .filter((part) => ["year", "month", "day"].includes(part.type))
      .map((part) => [part.type, part.value])
  );
  const calendar = new Date(Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day) + Number(offsetDays || 0)
  ));
  return [
    calendar.getUTCFullYear(),
    String(calendar.getUTCMonth() + 1).padStart(2, "0"),
    String(calendar.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function dashboardOperationsPlanStatus(plan = {}) {
  return String(plan.status || "").trim().toLowerCase();
}

function dashboardOperationsPlannedForDate(plans = [], operationalDate = "") {
  return dashboardOperationsList(plans).filter((plan) =>
    String(plan.operational_date || "").slice(0, 10) === operationalDate &&
    dashboardOperationsPlanStatus(plan) === "planned"
  );
}

function dashboardOperationsTimeLabel(value) {
  const text = String(value || "").trim();
  const match = text.match(/(?:T|\s)(\d{2}):(\d{2})/);
  if (!match) return "Not set";
  const hour = Number(match[1]);
  const minute = match[2];
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return "Not set";
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
}

function dashboardOperationsNextSchedule(plans = [], today = "", tomorrow = "") {
  const candidates = dashboardOperationsList(plans)
    .filter((plan) => {
      const operationalDate = String(plan.operational_date || "").slice(0, 10);
      return dashboardOperationsPlanStatus(plan) === "planned" &&
        operationalDate >= today;
    })
    .sort((first, second) => {
      const firstDate = String(first.operational_date || "").slice(0, 10);
      const secondDate = String(second.operational_date || "").slice(0, 10);
      if (firstDate !== secondDate) return firstDate.localeCompare(secondDate);
      const firstTime = String(first.scheduled_start || "99:99");
      const secondTime = String(second.scheduled_start || "99:99");
      return firstTime.localeCompare(secondTime) || Number(first.id || 0) - Number(second.id || 0);
    });

  const plan = candidates[0];
  if (!plan) return null;
  const operationalDate = String(plan.operational_date || "").slice(0, 10);
  const dateLabel = operationalDate === today
    ? "Today"
    : operationalDate === tomorrow
      ? "Tomorrow"
      : operationalDate || "Date not set";
  const timeLabel = dashboardOperationsTimeLabel(plan.scheduled_start);
  const enforcer = String(plan.assigned_enforcer_name_snapshot || "").trim();
  return {
    truck: String(
      plan.truck_name_snapshot || plan.truck_code_snapshot || "Truck not recorded"
    ),
    meta: `${dateLabel} • ${timeLabel}${enforcer ? ` • ${enforcer}` : ""}`
  };
}

function dashboardOperationsParseDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}/.test(text)
    ? `${text.replace(" ", "T")}+08:00`
    : text;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dashboardOperationsDateTime(value) {
  const date = dashboardOperationsParseDate(value);
  if (!date) return "Time not recorded";
  return date.toLocaleString("en-PH", {
    timeZone: DASHBOARD_OPERATIONS_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function dashboardOperationsStatus(status, fallbackLabel = "") {
  const key = String(status || "").trim().toLowerCase();
  const statusMap = {
    completed: { label: "Completed", state: "completed" },
    auto_stopped: { label: "Shift Completed", state: "completed" },
    stopped: { label: "Manually Stopped", state: "warning" },
    manual_stopped: { label: "Manually Stopped", state: "warning" },
    closed_early: { label: "Closed Early", state: "warning" },
    day_end_incomplete: { label: "Day-End Incomplete", state: "warning" },
    dispatch_day_end_incomplete: { label: "Day-End Incomplete", state: "warning" },
    dispatch_forced_day_rollover: { label: "Forced Day Rollover", state: "warning" },
    cancelled: { label: "Cancelled", state: "cancelled" }
  };
  if (statusMap[key]) return statusMap[key];
  return {
    label: String(fallbackLabel || key.replace(/_/g, " ") || "Status unavailable"),
    state: "neutral"
  };
}

function dashboardOperationsDispatchModel(report = {}) {
  const status = dashboardOperationsStatus(report.status || report.stored_status);
  return {
    source: "Dispatch Report",
    truck: String(report.truck_name_snapshot || report.truck_id || "Truck not recorded"),
    enforcer: String(
      report.assigned_personnel_name || report.created_by_name || "Enforcer not recorded"
    ),
    statusLabel: status.label,
    statusState: status.state,
    endedAt: report.closed_at || report.actual_end_at || report.completed_at ||
      report.cancelled_at || report.dispatch_date || null
  };
}

function dashboardOperationsTrackingModel(reports = []) {
  const terminal = dashboardOperationsList(reports)
    .filter((report) =>
      String(report.session_status || "").trim().toLowerCase() !== "active" &&
      dashboardOperationsParseDate(report.ended_at)
    )
    .sort((first, second) =>
      dashboardOperationsParseDate(second.ended_at) - dashboardOperationsParseDate(first.ended_at)
    )[0];
  if (!terminal) return null;
  const status = dashboardOperationsStatus(
    terminal.session_status,
    terminal.report_status_label
  );
  return {
    source: "Tracking Report",
    truck: String(terminal.truck_name || terminal.truck_id || "Truck not recorded"),
    enforcer: String(terminal.enforcer_name || "Enforcer not recorded"),
    statusLabel: String(terminal.report_status_label || status.label),
    statusState: status.state,
    endedAt: terminal.ended_at
  };
}

function renderDashboardFleetSummary(summary = null) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    [
      "dashboardFleetTotal",
      "dashboardFleetAvailable",
      "dashboardFleetActive",
      "dashboardFleetMaintenance",
      "dashboardFleetOutOfService"
    ].forEach((id) => dashboardOperationsSetText(id, "—"));
    return;
  }
  const values = {
    dashboardFleetTotal: dashboardOperationsCount(summary.total),
    dashboardFleetAvailable: dashboardOperationsCount(summary.available),
    dashboardFleetActive: dashboardOperationsCount(summary.active),
    dashboardFleetMaintenance: dashboardOperationsCount(summary.for_maintenance),
    dashboardFleetOutOfService: dashboardOperationsCount(summary.out_of_service)
  };
  Object.entries(values).forEach(([id, value]) => dashboardOperationsSetText(id, value));

  // These hidden compatibility values are still consumed by the existing
  // recommendation renderer and unchanged tracking preview code.
  dashboardOperationsSetText("monitoringActiveTruckCount", values.dashboardFleetActive);
  dashboardOperationsSetText("monitoringMaintenanceCount", values.dashboardFleetMaintenance);
}

function renderDashboardDispatchSummary({
  todayPlans,
  tomorrowPlans,
  liveDispatches,
  today,
  tomorrow,
  todayAvailable = true,
  tomorrowAvailable = true,
  liveAvailable = true
} = {}) {
  const plannedToday = dashboardOperationsPlannedForDate(todayPlans, today);
  const plannedTomorrow = dashboardOperationsPlannedForDate(tomorrowPlans, tomorrow);
  dashboardOperationsSetText(
    "dashboardDispatchToday",
    todayAvailable ? plannedToday.length : "—"
  );
  dashboardOperationsSetText(
    "dashboardDispatchTomorrow",
    tomorrowAvailable ? plannedTomorrow.length : "—"
  );
  dashboardOperationsSetText(
    "dashboardDispatchActive",
    liveAvailable && liveDispatches && typeof liveDispatches === "object"
      ? Object.values(liveDispatches).filter(Boolean).length
      : "—"
  );

  if (!todayAvailable || !tomorrowAvailable) {
    dashboardOperationsSetText("dashboardDispatchNext", "Unavailable");
    dashboardOperationsSetText("dashboardDispatchNextMeta", "Schedule data could not be loaded");
    return;
  }
  const next = dashboardOperationsNextSchedule(
    [...plannedToday, ...plannedTomorrow],
    today,
    tomorrow
  );
  dashboardOperationsSetText("dashboardDispatchNext", next?.truck || "No upcoming plan");
  dashboardOperationsSetText(
    "dashboardDispatchNextMeta",
    next?.meta || "No planned dispatch found"
  );
}

function renderDashboardLatestOperation(model = null, state = "empty") {
  if (!model) {
    const unavailable = state === "unavailable";
    dashboardOperationsSetText(
      "dashboardLatestSource",
      unavailable ? "Recent reports are temporarily unavailable." : "Most recent completed field activity."
    );
    dashboardOperationsSetText(
      "dashboardLatestTruck",
      unavailable ? "Unavailable" : "No completed operations yet"
    );
    dashboardOperationsSetText(
      "dashboardLatestEnforcer",
      unavailable ? "Try again on the next Dashboard refresh" : "Dispatch and Tracking reports are empty"
    );
    dashboardOperationsSetStatus(
      "dashboardLatestStatus",
      unavailable ? "Unavailable" : "No activity",
      "neutral"
    );
    dashboardOperationsSetText("dashboardLatestTime", "—");
    return;
  }

  dashboardOperationsSetText("dashboardLatestSource", model.source);
  dashboardOperationsSetText("dashboardLatestTruck", model.truck);
  dashboardOperationsSetText("dashboardLatestEnforcer", model.enforcer);
  dashboardOperationsSetStatus(
    "dashboardLatestStatus",
    model.statusLabel,
    model.statusState
  );
  dashboardOperationsSetText(
    "dashboardLatestTime",
    dashboardOperationsDateTime(model.endedAt)
  );
}

async function dashboardOperationsRequest(url) {
  const response = await webAdminFetch(url, {
    headers: { Accept: "application/json" }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error("Dashboard operations data is temporarily unavailable.");
  }
  return Array.isArray(payload) ? payload : payload.data;
}

async function loadDashboardFleetSummary() {
  try {
    const summary = await dashboardOperationsRequest(getFleetSummaryApiUrl());
    renderDashboardFleetSummary(summary);
    return summary;
  } catch (error) {
    renderDashboardFleetSummary(null);
    throw error;
  }
}

async function loadDashboardDispatchSummary(now = new Date()) {
  const today = dashboardOperationsCalendarDate(now, 0);
  const tomorrow = dashboardOperationsCalendarDate(now, 1);
  const [todayResult, tomorrowResult, liveResult] = await Promise.allSettled([
    dashboardOperationsRequest(getDispatchPlansApiUrl({ operational_date: today })),
    dashboardOperationsRequest(getDispatchPlansApiUrl({ operational_date: tomorrow })),
    dashboardOperationsRequest(getDispatchLiveApiUrl())
  ]);
  renderDashboardDispatchSummary({
    todayPlans: todayResult.status === "fulfilled" ? todayResult.value : [],
    tomorrowPlans: tomorrowResult.status === "fulfilled" ? tomorrowResult.value : [],
    liveDispatches: liveResult.status === "fulfilled" ? liveResult.value : null,
    today,
    tomorrow,
    todayAvailable: todayResult.status === "fulfilled",
    tomorrowAvailable: tomorrowResult.status === "fulfilled",
    liveAvailable: liveResult.status === "fulfilled"
  });
  return { todayResult, tomorrowResult, liveResult };
}

async function loadDashboardLatestOperation() {
  let dispatchFailed = false;
  try {
    const dispatchReports = dashboardOperationsList(
      await dashboardOperationsRequest(getDispatchReportsApiUrl())
    );
    if (dispatchReports.length) {
      const model = dashboardOperationsDispatchModel(dispatchReports[0]);
      renderDashboardLatestOperation(model, "ready");
      return model;
    }
  } catch (error) {
    dispatchFailed = true;
  }

  try {
    const trackingModel = dashboardOperationsTrackingModel(
      await dashboardOperationsRequest(getTrackingReportsApiUrl())
    );
    renderDashboardLatestOperation(trackingModel, trackingModel ? "ready" : "empty");
    return trackingModel;
  } catch (error) {
    renderDashboardLatestOperation(null, "unavailable");
    if (dispatchFailed) throw error;
    return null;
  }
}

async function loadDashboardOperationsSnapshot() {
  const results = await Promise.allSettled([
    loadDashboardFleetSummary(),
    loadDashboardDispatchSummary(),
    loadDashboardLatestOperation()
  ]);

  try {
    renderSystemRecommendations(validatedWasteRecords);
  } catch (error) {
    console.error("renderSystemRecommendations error:", error);
  }
  return results;
}

window.loadDashboardOperationsSnapshot = loadDashboardOperationsSnapshot;

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    dashboardOperationsCalendarDate,
    dashboardOperationsPlannedForDate,
    dashboardOperationsNextSchedule,
    dashboardOperationsStatus,
    dashboardOperationsDispatchModel,
    dashboardOperationsTrackingModel,
    renderDashboardFleetSummary,
    renderDashboardDispatchSummary,
    renderDashboardLatestOperation,
    loadDashboardDispatchSummary,
    loadDashboardLatestOperation,
    loadDashboardOperationsSnapshot
  };
}
