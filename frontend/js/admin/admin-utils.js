// =========================
// UTILITIES / HELPERS
// =========================

const SECTION_IDS = {
  dashboard: "dashboardSection",
  records: "recordsSection",
  appointments: "appointmentsSection",
  orientation: "orientationSection",
  complaints: "complaintsSection",
  tracking: "trackingSection",
  userManagement: "userManagementSection"
};

function cleanText(value, fallback = "-") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (!text || text.toLowerCase() === "null") return fallback;
  return text;
}

function formatDateTimeDisplay(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return cleanText(value, "-");
  return date.toLocaleString();
}

function getImageUrl(imagePath) {
  if (!imagePath) return "";

  const cleanPath = String(imagePath).trim();

  if (
    !cleanPath ||
    cleanPath.toLowerCase() === "null" ||
    cleanPath.toLowerCase() === "undefined"
  ) {
    return "";
  }

  if (/^https?:\/\//i.test(cleanPath)) {
    return cleanPath;
  }

  const apiBase =
    window.APP_CONFIG?.API_BASE_URL ||
    window.API_BASE ||
    "http://192.168.1.37:8081/api";

  const serverBase = apiBase.replace(/\/api\/?$/, "");
  const normalizedPath = cleanPath.startsWith("/")
    ? cleanPath
    : `/${cleanPath}`;

  return `${serverBase}${normalizedPath}`;
}

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatKg(value) {
  const num = Number(value);
  if (isNaN(num)) return "0 kg";
  return `${num} kg`;
}

function toNumber(value) {
  const num = parseFloat(value);
  return isNaN(num) ? 0 : num;
}

function formatNumber(value) {
  return toNumber(value).toLocaleString("en-PH", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  });
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatSimpleDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

function formatTrackingTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString();
}

function formatMonitoringTime(dateString) {
  if (!dateString) return "No timestamp";

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "No timestamp";

  return date.toLocaleString("en-PH", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatAlertTime(dateString) {
  if (!dateString) return "No timestamp";

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "No timestamp";

  return date.toLocaleString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatModalDateTime(value) {
  return formatAlertTime(value);
}

function formatPeriod(from, to) {
  const fromValue = from ? String(from).trim() : "";
  const toValue = to ? String(to).trim() : "";

  if (fromValue && toValue) return `${fromValue} - ${toValue}`;
  if (fromValue) return fromValue;
  if (toValue) return toValue;
  return "—";
}

function safeParseRawPayload(rawPayload) {
  if (!rawPayload) return null;

  if (typeof rawPayload === "object") {
    return rawPayload;
  }

  if (typeof rawPayload === "string") {
    const trimmed = rawPayload.trim();
    if (!trimmed) return null;

    try {
      return JSON.parse(trimmed);
    } catch (firstError) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "string") {
          return JSON.parse(parsed);
        }
        return parsed;
      } catch (secondError) {
        console.warn("Failed to parse raw_payload:", secondError);
        return null;
      }
    }
  }

  return null;
}

function formatBreakdownLabel(key) {
  if (!key) return "-";

  return String(key)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, ch => ch.toUpperCase())
    .trim();
}

function showToast(message, type = "success") {
  let container = document.getElementById("toastContainer");

  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.style.position = "fixed";
    container.style.top = "20px";
    container.style.right = "20px";
    container.style.zIndex = "99999";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.textContent = message;

  toast.style.padding = "14px 18px";
  toast.style.marginTop = "10px";
  toast.style.borderRadius = "10px";
  toast.style.color = "#fff";
  toast.style.fontSize = "14px";
  toast.style.fontWeight = "600";
  toast.style.boxShadow = "0 10px 25px rgba(0,0,0,0.25)";
  toast.style.opacity = "0";
  toast.style.transform = "translateY(-10px)";
  toast.style.transition = "all 0.25s ease";
  toast.style.background = type === "error" ? "#dc2626" : "#16a34a";

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";
  }, 50);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-10px)";

    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3000);
}

function truncateText(text, maxLength = 60) {
  if (!text) return "";

  const clean = String(text);

  return clean.length > maxLength
    ? clean.substring(0, maxLength) + "..."
    : clean;
}