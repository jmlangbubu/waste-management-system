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