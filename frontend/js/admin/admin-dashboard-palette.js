/* ===============================
   WMO DASHBOARD WASTE PALETTE
   External JS only.
   Path: backend/frontend/js/admin/admin-dashboard-palette.js

   Purpose:
   - Keep dashboard waste chart colors consistent.
   - Supports both chart types used in the dashboard:
     1. Waste Trend line chart: one dataset per waste type.
     2. Waste Category horizontal bar chart: one dataset with labels.
   - No inline script in admin-dashboard.html.
   - Safe update patch: no recursive chart update loop.
================================ */
(function enforceDashboardWastePalette() {
  const palette = {
    biodegradable: {
      solid: "#16A34A",
      soft: "rgba(22, 163, 74, 0.16)",
      hover: "#166534"
    },
    recyclable: {
      solid: "#F59E0B",
      soft: "rgba(245, 158, 11, 0.16)",
      hover: "#B45309"
    },
    residual: {
      solid: "#EAB308",
      soft: "rgba(234, 179, 8, 0.16)",
      hover: "#A16207"
    },
    special: {
      solid: "#2563EB",
      soft: "rgba(37, 99, 235, 0.16)",
      hover: "#1D4ED8"
    }
  };

  window.WMO_DASHBOARD_WASTE_PALETTE = palette;

  function normalizeText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[\s_-]+/g, " ")
      .trim();
  }

  function getWasteKey(label) {
    const text = normalizeText(label);

    if (text.includes("bio") || text.includes("biodegradable")) return "biodegradable";
    if (text.includes("recycl")) return "recyclable";
    if (text.includes("residual")) return "residual";
    if (text.includes("special") || text.includes("hazard") || text.includes("hazardous")) return "special";

    return "";
  }

  function getWastePalette(label) {
    const key = getWasteKey(label);
    return key ? palette[key] : null;
  }

  function getChartCanvas(chart) {
    return chart && (chart.canvas || chart.ctx?.canvas || null);
  }

  function isCategoryChart(chart) {
    const canvas = getChartCanvas(chart);

    if (canvas && typeof canvas.closest === "function" && canvas.closest("#wasteCategoryChart")) {
      return true;
    }

    const labels = Array.isArray(chart?.data?.labels) ? chart.data.labels : [];
    const matchedLabels = labels.filter((label) => !!getWasteKey(label));

    return matchedLabels.length >= 3;
  }

  function isTrendChart(chart) {
    const canvas = getChartCanvas(chart);

    if (canvas && canvas.id === "wasteTrendCanvas") {
      return true;
    }

    return false;
  }

  function applyLineDatasetPalette(dataset) {
    if (!dataset) return false;

    const selected = getWastePalette(dataset.label || dataset.name);
    if (!selected) return false;

    const dimmed = !!window.dashboardSelectedWasteCategory && getWasteKey(dataset.label) !== window.dashboardSelectedWasteCategory;
    dataset.borderColor = dimmed ? `${selected.solid}55` : selected.solid;
    dataset.backgroundColor = selected.soft;
    dataset.pointBorderColor = dataset.borderColor;
    dataset.pointBackgroundColor = "#FFFFFF";
    dataset.pointHoverBorderColor = selected.solid;
    dataset.pointHoverBackgroundColor = selected.solid;
    dataset.pointRadius = dataset.pointRadius || 4;
    dataset.pointHoverRadius = dataset.pointHoverRadius || 5;
    dataset.borderWidth = dimmed ? 1.5 : 3.5;
    dataset.tension = dataset.tension ?? 0.35;

    return true;
  }

  function applyCategoryDatasetPalette(chart, dataset) {
    if (!chart || !dataset) return false;

    const labels = Array.isArray(chart.data?.labels) ? chart.data.labels : [];
    if (!labels.length) return false;

    const solidColors = labels.map((label) => getWastePalette(label)?.solid || "#94A3B8");
    const softColors = labels.map((label) => getWastePalette(label)?.soft || "rgba(148, 163, 184, 0.16)");
    const hoverColors = labels.map((label) => getWastePalette(label)?.hover || "#64748B");

    dataset.backgroundColor = solidColors;
    dataset.borderColor = solidColors;
    dataset.hoverBackgroundColor = hoverColors;
    dataset.hoverBorderColor = hoverColors;
    dataset.borderWidth = 1;
    dataset.borderRadius = 12;
    dataset.borderSkipped = false;
    dataset.maxBarThickness = dataset.maxBarThickness || 28;

    return true;
  }

  function applyPaletteToChartData(chart) {
    if (!chart || !chart.data || !Array.isArray(chart.data.datasets)) {
      return false;
    }

    let changed = false;

    if (isCategoryChart(chart)) {
      chart.data.datasets.forEach((dataset) => {
        if (applyCategoryDatasetPalette(chart, dataset)) changed = true;
      });

      return changed;
    }

    if (isTrendChart(chart)) {
      chart.data.datasets.forEach((dataset) => {
        if (applyLineDatasetPalette(dataset)) changed = true;
      });

      return changed;
    }

    chart.data.datasets.forEach((dataset) => {
      if (applyLineDatasetPalette(dataset)) changed = true;
    });

    return changed;
  }

  function getChartByCanvas(canvas) {
    if (!canvas || !window.Chart) return null;

    if (typeof window.Chart.getChart === "function") {
      return window.Chart.getChart(canvas) || null;
    }

    if (window.Chart.instances) {
      const instances = Object.values(window.Chart.instances);
      for (const chart of instances) {
        if (chart && getChartCanvas(chart) === canvas) {
          return chart;
        }
      }
    }

    return null;
  }

  function getDashboardCharts() {
    if (!window.Chart) return [];

    const charts = [];
    const canvases = document.querySelectorAll("#wasteTrendCanvas, #wasteCategoryChart canvas");

    canvases.forEach((canvas) => {
      const chart = getChartByCanvas(canvas);
      if (chart && !charts.includes(chart)) {
        charts.push(chart);
      }
    });

    if (window.Chart.instances) {
      Object.values(window.Chart.instances).forEach((chart) => {
        if (!chart || charts.includes(chart)) return;

        const canvas = getChartCanvas(chart);
        if (
          canvas &&
          (canvas.id === "wasteTrendCanvas" || canvas.closest?.("#wasteCategoryChart"))
        ) {
          charts.push(chart);
        }
      });
    }

    return charts;
  }

  function applyDashboardWastePalette() {
    getDashboardCharts().forEach((chart) => {
      if (chart.__wmoPaletteUpdating) return;

      const changed = applyPaletteToChartData(chart);

      if (changed && typeof chart.update === "function") {
        chart.__wmoPaletteUpdating = true;
        try {
          chart.update("none");
        } finally {
          chart.__wmoPaletteUpdating = false;
        }
      }
    });
  }

  function installChartUpdatePatch() {
    if (!window.Chart || !window.Chart.prototype || window.Chart.__wmoWastePalettePatched) {
      return;
    }

    const originalUpdate = window.Chart.prototype.update;

    window.Chart.prototype.update = function patchedDashboardWasteUpdate(...args) {
      if (!this.__wmoPaletteUpdating) {
        applyPaletteToChartData(this);
      }

      return originalUpdate.apply(this, args);
    };

    window.Chart.__wmoWastePalettePatched = true;
  }

  function startPaletteWatcher() {
    installChartUpdatePatch();
    applyDashboardWastePalette();

    let attempts = 0;
    const watcher = window.setInterval(() => {
      installChartUpdatePatch();
      applyDashboardWastePalette();
      attempts += 1;

      if (attempts >= 35) {
        window.clearInterval(watcher);
      }
    }, 350);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startPaletteWatcher);
  } else {
    startPaletteWatcher();
  }

  window.addEventListener("load", applyDashboardWastePalette);
  window.applyDashboardWastePalette = applyDashboardWastePalette;
})();
