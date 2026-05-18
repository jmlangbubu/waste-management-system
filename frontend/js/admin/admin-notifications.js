// =========================
// ADMIN NOTIFICATIONS
// Safe notification read/clear persistence fix
// =========================

/*
  What this fixes:
  1. Clicking the notification bell marks current notifications as seen.
     The red badge becomes 0 and stays 0 after polling/refresh.
  2. Clearing a notification saves it locally using a stable key.
     It will not come back after refresh unless it is a truly new notification.
  3. If the backend does not provide a stable notification id, this file
     creates a stable key from the notification title/message/type/date.
  4. Adds a safe "Clear All" button inside the notification header without
     requiring HTML changes.
  5. Automatically closes the notification dropdown when the page/main content
     scrolls, so it does not stay floating on mobile/tablet view.
  6. Plays a soft bell chime only when a truly new notification arrives
     after the admin has interacted with the page.
*/

const NOTIF_DISMISSED_STORAGE_KEY = "wmoDismissedNotificationKeys";
const NOTIF_SEEN_STORAGE_KEY = "wmoSeenNotificationKeys";

let notificationRealtimeSocket = null;
let notificationRealtimeStarted = false;
let notificationRealtimeRefreshTimer = null;
let notificationInitialLoadStarted = false;

let notificationSoundContext = null;
let notificationSoundUnlocked = false;
let notificationSoundUnlockBound = false;
let notificationSoundKnownKeysInitialized = false;
let notificationSoundKnownKeys = new Set();
let notificationLastSoundAt = 0;

const NOTIFICATION_SOUND_MIN_INTERVAL_MS = 1200;


function getNotificationAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    return null;
  }

  if (!notificationSoundContext) {
    notificationSoundContext = new AudioContextClass();
  }

  return notificationSoundContext;
}

function unlockNotificationSound() {
  try {
    const audioContext = getNotificationAudioContext();

    if (!audioContext) {
      return;
    }

    const markUnlocked = () => {
      notificationSoundUnlocked = true;
    };

    if (audioContext.state === "suspended" && typeof audioContext.resume === "function") {
      audioContext.resume().then(markUnlocked).catch((error) => {
        console.warn("Notification sound unlock failed:", error);
      });
    } else {
      markUnlocked();
    }
  } catch (error) {
    console.warn("Notification sound is unavailable:", error);
  }
}

function bindNotificationSoundUnlock() {
  if (notificationSoundUnlockBound) return;
  notificationSoundUnlockBound = true;

  const unlockOnce = () => {
    unlockNotificationSound();
  };

  ["pointerdown", "mousedown", "touchstart", "keydown", "click"].forEach((eventName) => {
    document.addEventListener(eventName, unlockOnce, {
      passive: true,
      once: false
    });
  });
}

function playSoftNotificationBell() {
  if (!notificationSoundUnlocked) return;

  try {
    const audioContext = getNotificationAudioContext();
    if (!audioContext) return;

    const scheduleBell = () => {
      const startTime = audioContext.currentTime + 0.02;
      const masterGain = audioContext.createGain();

      masterGain.gain.setValueAtTime(0.0001, startTime);
      masterGain.gain.exponentialRampToValueAtTime(0.42, startTime + 0.03);
      masterGain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.95);
      masterGain.connect(audioContext.destination);

      const bellTones = [
        { frequency: 880, delay: 0, peak: 0.055, duration: 0.55 },
        { frequency: 1320, delay: 0.12, peak: 0.032, duration: 0.45 }
      ];

      bellTones.forEach((tone) => {
        const oscillator = audioContext.createOscillator();
        const toneGain = audioContext.createGain();
        const toneStart = startTime + tone.delay;
        const toneEnd = toneStart + tone.duration;

        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(tone.frequency, toneStart);

        toneGain.gain.setValueAtTime(0.0001, toneStart);
        toneGain.gain.exponentialRampToValueAtTime(tone.peak, toneStart + 0.025);
        toneGain.gain.exponentialRampToValueAtTime(0.0001, toneEnd);

        oscillator.connect(toneGain);
        toneGain.connect(masterGain);

        oscillator.start(toneStart);
        oscillator.stop(toneEnd + 0.04);
      });
    };

    if (audioContext.state === "suspended" && typeof audioContext.resume === "function") {
      audioContext.resume().then(() => {
        notificationSoundUnlocked = true;
        scheduleBell();
      }).catch((error) => {
        console.warn("Notification sound play failed:", error);
      });
      return;
    }

    scheduleBell();
  } catch (error) {
    console.warn("Notification sound play failed:", error);
  }
}

function updateNotificationSoundKnownKeys(list = []) {
  const dismissedKeys = getDismissedNotificationIds();
  const visibleNotifications = (Array.isArray(list) ? list : []).filter((notif) => {
    const key = getNotificationStableKey(notif);
    return key && !dismissedKeys.includes(key);
  });

  const nextKeys = new Set(
    visibleNotifications
      .map((notif) => getNotificationStableKey(notif))
      .filter(Boolean)
  );

  if (!notificationSoundKnownKeysInitialized) {
    notificationSoundKnownKeysInitialized = true;
    notificationSoundKnownKeys = nextKeys;
    return [];
  }

  const newNotifications = visibleNotifications.filter((notif) => {
    const key = getNotificationStableKey(notif);
    return key && !notificationSoundKnownKeys.has(key);
  });

  notificationSoundKnownKeys = nextKeys;
  return newNotifications;
}

function maybePlayNotificationSound(newNotifications = []) {
  if (!Array.isArray(newNotifications) || newNotifications.length === 0) return;

  const now = Date.now();
  if (now - notificationLastSoundAt < NOTIFICATION_SOUND_MIN_INTERVAL_MS) return;

  notificationLastSoundAt = now;
  playSoftNotificationBell();
}

function safeNotificationText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function getNotificationCreatedValue(notif = {}) {
  return (
    notif.createdAt ||
    notif.created_at ||
    notif.notification_created_at ||
    notif.created ||
    notif.date ||
    notif.timestamp ||
    notif.time ||
    notif.resolved_at ||
    notif.validated_at ||
    notif.updated_at ||
    ""
  );
}

function parseNotificationTimeMs(value) {
  const raw = safeNotificationText(value);

  if (!raw) return 0;

  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    return raw.length <= 10 ? numeric * 1000 : numeric;
  }

  const normalized = raw
    .replace("T", " ")
    .replace(/\.\d+Z$/, "Z")
    .trim();

  const directTime = Date.parse(raw);
  if (!Number.isNaN(directTime)) {
    return directTime;
  }

  /*
    MySQL DATETIME format sometimes arrives as:
    2026-05-15 18:46:56
    Convert it to a local ISO-like date for reliable sorting.
  */
  const mysqlDateMatch = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/
  );

  if (mysqlDateMatch) {
    const [, year, month, day, hour, minute, second = "00"] = mysqlDateMatch;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    ).getTime();
  }

  return 0;
}

function getNotificationTimeMs(notif = {}) {
  return parseNotificationTimeMs(getNotificationCreatedValue(notif));
}

function sortNotificationsNewestFirst(list = []) {
  return (Array.isArray(list) ? list : [])
    .map((notif, index) => ({
      notif,
      index,
      timeMs: getNotificationTimeMs(notif)
    }))
    .sort((a, b) => {
      /*
        New/current notifications must stay at the top.
        Older/past notifications go below.
        If date is missing/same, keep original order to avoid UI jumping.
      */
      if (b.timeMs !== a.timeMs) {
        return b.timeMs - a.timeMs;
      }

      return a.index - b.index;
    })
    .map((item) => item.notif);
}

function getNotificationType(notif = {}) {
  const rawType = safeNotificationText(
    notif.notification_type ||
    notif.type ||
    notif.category ||
    notif.target_type ||
    notif.source ||
    notif._source ||
    ""
  );

  const normalizedRawType = rawType
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .trim();

  const combined = [
    normalizedRawType,
    rawType,
    notif.title,
    notif.subject,
    notif.message,
    notif.description,
    notif.status,
    notif.action,
    notif.event
  ]
    .map(safeNotificationText)
    .join(" ")
    .toLowerCase();

  /*
    Important ordering:
    Waste validation notifications use backend type "waste_report".
    The old logic checked the generic word "report" before checking "waste",
    so "New Validated Waste Record" was wrongly displayed as Complaint.
  */
  if (
    normalizedRawType === "waste report" ||
    normalizedRawType === "waste record" ||
    normalizedRawType === "validated waste record" ||
    combined.includes("validated waste") ||
    combined.includes("waste record") ||
    combined.includes("waste submission") ||
    combined.includes("waste validation") ||
    combined.includes("validated waste submission") ||
    (
      combined.includes("waste") &&
      (
        combined.includes("validated") ||
        combined.includes("validation") ||
        combined.includes("qr") ||
        combined.includes("record") ||
        combined.includes("submission") ||
        combined.includes("report")
      )
    )
  ) {
    return "waste record";
  }

  if (
    combined.includes("resolution") ||
    combined.includes("resolved") ||
    combined.includes("resolve")
  ) {
    return "complaint resolution";
  }

  if (
    combined.includes("complaint") ||
    combined.includes("concern") ||
    combined.includes("citizen report") ||
    combined.includes("complaint report")
  ) {
    return "complaint";
  }

  if (
    combined.includes("tracking") ||
    combined.includes("gps") ||
    combined.includes("truck") ||
    combined.includes("route") ||
    combined.includes("location sync")
  ) {
    return "tracking";
  }

  if (
    combined.includes("appointment") ||
    combined.includes("orientation") ||
    combined.includes("clearance")
  ) {
    return "appointment";
  }

  if (
    combined.includes("waste") ||
    combined.includes("validation") ||
    combined.includes("validated") ||
    combined.includes("qr")
  ) {
    return "waste record";
  }

  return rawType || "system";
}

function getNotificationTitle(notif = {}) {
  const directTitle = safeNotificationText(
    notif.title ||
    notif.notification_title ||
    notif.subject ||
    notif.header ||
    ""
  );

  if (directTitle) return directTitle;

  const type = getNotificationType(notif);
  const status = safeNotificationText(notif.status).toLowerCase();

  if (type.includes("complaint resolution") || status === "resolved") {
    return "Resolved complaint submitted";
  }

  if (type.includes("complaint")) {
    return "New complaint received";
  }

  return "Notification";
}

function getNotificationMessage(notif = {}) {
  const directMessage = safeNotificationText(
    notif.message ||
    notif.notification_message ||
    notif.description ||
    notif.body ||
    notif.details ||
    ""
  );

  if (directMessage) return directMessage;

  const type = getNotificationType(notif);
  const subject = safeNotificationText(notif.subject || notif.complaint_subject || "");
  const barangay = safeNotificationText(
    notif.barangay ||
    notif.reporter_barangay ||
    notif.assigned_barangay ||
    notif.handled_by_barangay_name ||
    ""
  );

  if (type.includes("complaint resolution")) {
    return barangay
      ? `${barangay} submitted a resolved complaint report to WMO.`
      : "A barangay submitted a resolved complaint report to WMO.";
  }

  if (type.includes("complaint")) {
    if (subject && barangay) {
      return `New citizen complaint from ${barangay}: ${subject}`;
    }

    if (subject) {
      return `New citizen complaint: ${subject}`;
    }

    return "A new citizen complaint was submitted for WMO review.";
  }

  return "";
}

function getNotificationReferenceId(notif = {}) {
  return safeNotificationText(
    notif.reference_id ||
    notif.referenceId ||
    notif.complaint_id ||
    notif.complaintId ||
    notif.appointment_id ||
    notif.appointmentId ||
    notif.record_id ||
    notif.recordId ||
    ""
  );
}

function getNotificationStatusClass(notif = {}) {
  const type = getNotificationType(notif).toLowerCase();
  const status = safeNotificationText(notif.status).toLowerCase();
  const title = getNotificationTitle(notif).toLowerCase();

  if (
    type.includes("resolution") ||
    status.includes("resolved") ||
    title.includes("resolved")
  ) {
    return "resolved";
  }

  if (title.includes("overdue") || status.includes("overdue")) {
    return "rejected";
  }

  if (type.includes("complaint")) {
    return "pending";
  }

  if (type.includes("appointment")) {
    return "pending";
  }

  if (type.includes("waste")) {
    return "validated";
  }

  if (
    type.includes("tracking") ||
    type.includes("gps") ||
    type.includes("truck") ||
    title.includes("gps")
  ) {
    return "validated";
  }


  return "pending";
}

function getNotificationDisplayTitle(notif = {}) {
  const rawTitle = getNotificationTitle(notif);
  const lowerTitle = rawTitle.toLowerCase();
  const message = getNotificationMessage(notif).toLowerCase();
  const type = getNotificationType(notif).toLowerCase();

  if (
    lowerTitle.includes("barangay explanation") ||
    message.includes("replied to wmo") ||
    message.includes("explanation received") ||
    type.includes("explanation")
  ) {
    return "Barangay Explanation Received";
  }

  if (
    lowerTitle.includes("accepted complaint overdue") ||
    message.includes("did not submit a resolution within 24 hours")
  ) {
    return "Accepted Complaint Overdue";
  }

  if (
    lowerTitle.includes("gps tracking turned on") ||
    message.includes("gps tracking was turned on")
  ) {
    return "GPS Tracking Turned On";
  }

  if (
    lowerTitle.includes("gps tracking turned off") ||
    message.includes("gps tracking was turned off")
  ) {
    return "GPS Tracking Turned Off";
  }

  return rawTitle;
}

function getNotificationDisplayIcon(notif = {}) {
  const combined = [
    getNotificationType(notif),
    getNotificationDisplayTitle(notif),
    getNotificationMessage(notif),
    safeNotificationText(notif.status)
  ].join(" ").toLowerCase();

  if (combined.includes("explanation") || combined.includes("replied to wmo")) {
    return "💬";
  }

  if (combined.includes("resolution") || combined.includes("resolved")) {
    return "✅";
  }

  if (combined.includes("complaint") || combined.includes("concern")) {
    return "⚠️";
  }

  if (combined.includes("gps") || combined.includes("tracking") || combined.includes("truck")) {
    return "🚛";
  }

  if (combined.includes("waste") || combined.includes("validation") || combined.includes("qr")) {
    return "♻️";
  }

  if (combined.includes("appointment") || combined.includes("orientation")) {
    return "📅";
  }

  return "🔔";
}

function getNotificationToneClass(notif = {}) {
  const combined = [
    getNotificationType(notif),
    getNotificationDisplayTitle(notif),
    getNotificationMessage(notif),
    safeNotificationText(notif.status)
  ].join(" ").toLowerCase();

  if (combined.includes("explanation") || combined.includes("replied to wmo")) {
    return "info";
  }

  if (combined.includes("resolution") || combined.includes("resolved")) {
    return "success";
  }

  if (combined.includes("gps") || combined.includes("tracking") || combined.includes("truck")) {
    return "tracking";
  }

  if (combined.includes("overdue") || combined.includes("rejected")) {
    return "danger";
  }

  if (
    combined.includes("waste") ||
    combined.includes("validation") ||
    combined.includes("validated") ||
    combined.includes("qr")
  ) {
    return "success";
  }

  if (combined.includes("complaint") || combined.includes("concern")) {
    return "warning";
  }

  return "default";
}

function getNotificationDisplayMessage(notif = {}) {
  const message = getNotificationMessage(notif);
  const title = getNotificationDisplayTitle(notif).toLowerCase();

  if (
    title.includes("barangay explanation received") &&
    message.toLowerCase().includes("replied to wmo")
  ) {
    return message;
  }

  return message || "Open the related module for more details.";
}


function getNotificationSource(notif = {}) {
  return safeNotificationText(notif.source || notif._source || notif.target_type || "");
}

function getNotificationsApiBase() {
  if (typeof getAppApiBase === "function") {
    return String(getAppApiBase()).replace(/\/$/, "");
  }

  if (window.APP_CONFIG?.API_BASE_URL) {
    return String(window.APP_CONFIG.API_BASE_URL).replace(/\/$/, "");
  }

  if (window.APP_CONFIG?.BASE_URL) {
    return `${String(window.APP_CONFIG.BASE_URL).replace(/\/$/, "")}/api`;
  }

  return "/api";
}

function getWmoComplaintNotificationsApiUrl() {
  return `${getNotificationsApiBase()}/complaints/notifications/wmo`;
}

function extractNotificationArrayFromResponse(data) {
  if (Array.isArray(data)) return data;

  if (!data || typeof data !== "object") return [];

  const keys = [
    "data",
    "notifications",
    "items",
    "records",
    "results",
    "rows"
  ];

  for (const key of keys) {
    if (Array.isArray(data[key])) {
      return data[key];
    }
  }

  return [];
}

function normalizeAdminNotification(notif = {}, source = "") {
  return {
    ...notif,
    _source: source || notif._source || notif.source || "",
    type: getNotificationType({ ...notif, _source: source || notif._source || notif.source || "" }),
    title: getNotificationTitle({ ...notif, _source: source || notif._source || notif.source || "" }),
    message: getNotificationMessage({ ...notif, _source: source || notif._source || notif.source || "" }),
    createdAt: getNotificationCreatedValue(notif)
  };
}

function uniqueNotificationsByStableKey(list = []) {
  const seen = new Set();
  const unique = [];

  (Array.isArray(list) ? list : []).forEach((notif) => {
    const key = getNotificationStableKey(notif);

    if (!key || seen.has(key)) return;

    seen.add(key);
    unique.push(notif);
  });

  return unique;
}

async function fetchNotificationListFromUrl(url, source = "") {
  if (!url) return [];

  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json"
      }
    });

    if (!res.ok) {
      console.warn(`Notification endpoint returned ${res.status}:`, url);
      return [];
    }

    const data = await res.json();
    return extractNotificationArrayFromResponse(data)
      .map((notif) => normalizeAdminNotification(notif, source));
  } catch (error) {
    console.warn("Failed loading notification endpoint:", url, error);
    return [];
  }
}

function tryOpenAdminSection(sectionIds = []) {
  if (typeof openSection !== "function") return false;

  for (const sectionId of sectionIds) {
    if (document.getElementById(sectionId)) {
      openSection(sectionId);
      return true;
    }
  }

  if (sectionIds[0]) {
    openSection(sectionIds[0]);
    return true;
  }

  return false;
}

function openNotificationTarget(notif = {}) {
  const type = getNotificationType(notif).toLowerCase();
  const title = getNotificationTitle(notif).toLowerCase();
  const message = getNotificationMessage(notif).toLowerCase();
  const combined = `${type} ${title} ${message}`;

  if (
    combined.includes("complaint") ||
    combined.includes("concern") ||
    combined.includes("resolution") ||
    combined.includes("resolved")
  ) {
    tryOpenAdminSection([
      "complaintsSection",
      "complaintSection",
      "complaintsManagementSection",
      "complaintManagementSection"
    ]);

    setTimeout(() => {
      if (typeof loadComplaints === "function") {
        loadComplaints();
      }

      if (
        (combined.includes("resolved") || combined.includes("resolution")) &&
        typeof loadComplaintHistory === "function"
      ) {
        loadComplaintHistory();
      }
    }, 100);

    return;
  }

  if (
    combined.includes("appointment") ||
    combined.includes("orientation") ||
    combined.includes("clearance")
  ) {
    tryOpenAdminSection([
      "appointmentsSection",
      "appointmentSection",
      "orientationSection"
    ]);

    return;
  }

  if (
    combined.includes("tracking") ||
    combined.includes("gps") ||
    combined.includes("truck") ||
    combined.includes("route")
  ) {
    tryOpenAdminSection([
      "trackingSection",
      "dashboardSection"
    ]);

    setTimeout(() => {
      if (typeof initializeTruckMap === "function") {
        initializeTruckMap();
      }

      if (typeof loadActiveTrucks === "function") {
        loadActiveTrucks();
      }

      if (typeof startTrackingAutoRefresh === "function") {
        startTrackingAutoRefresh();
      }
    }, 150);

    return;
  }

  if (
    combined.includes("waste") ||
    combined.includes("validation") ||
    combined.includes("validated") ||
    combined.includes("qr")
  ) {
    tryOpenAdminSection([
      "wasteRecordsSection",
      "wasteSection",
      "dashboardSection"
    ]);

    return;
  }

  tryOpenAdminSection(["dashboardSection"]);
}

function getNotificationStableKey(notif = {}) {
  const type = safeNotificationText(getNotificationType(notif));
  const source = getNotificationSource(notif);
  const referenceId = getNotificationReferenceId(notif);

  const directId =
    notif.notification_id ??
    notif.notificationId ??
    notif.id ??
    "";

  if (directId !== null && directId !== undefined && String(directId).trim() !== "") {
    return `id:${source}|${type}|${String(directId).trim()}|ref:${referenceId}`;
  }

  const title = safeNotificationText(getNotificationTitle(notif));
  const message = safeNotificationText(getNotificationMessage(notif));
  const created = safeNotificationText(getNotificationCreatedValue(notif));

  return `content:${source}|${type}|${referenceId}|${title}|${message}|${created}`;
}

function getStoredNotificationKeys(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey) || "[]";
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item) => String(item))
      .filter(Boolean);
  } catch (error) {
    console.warn("Failed reading notification storage:", storageKey, error);
    return [];
  }
}

function setStoredNotificationKeys(storageKey, keys) {
  const uniqueKeys = [...new Set((Array.isArray(keys) ? keys : []).map(String).filter(Boolean))];

  /*
    Avoid unlimited localStorage growth.
    Keeping the newest 500 keys is enough for this admin notification UI.
  */
  const trimmedKeys = uniqueKeys.slice(-500);

  localStorage.setItem(storageKey, JSON.stringify(trimmedKeys));
}

function getDismissedNotificationIds() {
  /*
    Backward-compatible function name.
    Existing code may still call this.
  */
  return getStoredNotificationKeys(NOTIF_DISMISSED_STORAGE_KEY);
}

function setDismissedNotificationIds(ids) {
  /*
    Backward-compatible function name.
    Existing code may still call this.
  */
  setStoredNotificationKeys(NOTIF_DISMISSED_STORAGE_KEY, ids);
}

function getSeenNotificationKeys() {
  return getStoredNotificationKeys(NOTIF_SEEN_STORAGE_KEY);
}

function setSeenNotificationKeys(keys) {
  setStoredNotificationKeys(NOTIF_SEEN_STORAGE_KEY, keys);
}

function dismissNotificationById(idOrKey) {
  const dismissed = getDismissedNotificationIds();
  const key = String(idOrKey || "").trim();

  if (!key) return;

  if (!dismissed.includes(key)) {
    dismissed.push(key);
  }

  setDismissedNotificationIds(dismissed);
}

function dismissNotification(notif) {
  dismissNotificationById(getNotificationStableKey(notif));
}

function markNotificationSeen(notif) {
  const seen = getSeenNotificationKeys();
  const key = getNotificationStableKey(notif);

  if (!key) return;

  if (!seen.includes(key)) {
    seen.push(key);
  }

  setSeenNotificationKeys(seen);
}

function markVisibleNotificationsAsSeen() {
  const dismissed = getDismissedNotificationIds();

  const visibleNotifications = (Array.isArray(notificationFeedItems) ? notificationFeedItems : [])
    .filter((notif) => !dismissed.includes(getNotificationStableKey(notif)));

  const seen = getSeenNotificationKeys();

  visibleNotifications.forEach((notif) => {
    const key = getNotificationStableKey(notif);
    if (key && !seen.includes(key)) {
      seen.push(key);
    }
  });

  setSeenNotificationKeys(seen);
  renderNotificationsFromFeed(notificationFeedItems);
}

function clearAllVisibleNotifications() {
  const list = Array.isArray(notificationFeedItems) ? notificationFeedItems : [];
  const dismissed = getDismissedNotificationIds();

  list.forEach((notif) => {
    const key = getNotificationStableKey(notif);
    if (key && !dismissed.includes(key)) {
      dismissed.push(key);
    }
  });

  setDismissedNotificationIds(dismissed);
  notificationFeedItems = [];
  renderNotificationsFromFeed([]);
}

function ensureNotificationHeaderActions() {
  const dropdown = document.getElementById("notificationDropdown");
  if (!dropdown) return;

  const header = dropdown.querySelector(".notif-header");
  if (!header) return;

  if (header.dataset.enhanced === "true") return;
  header.dataset.enhanced = "true";

  const existingText = header.textContent.trim() || "Notifications";

  header.innerHTML = `
    <span>${escapeHtml(existingText)}</span>
    <button type="button" id="clearAllNotificationsBtn" class="notif-clear-all-btn">
      Clear All
    </button>
  `;

  const clearAllBtn = document.getElementById("clearAllNotificationsBtn");

  if (clearAllBtn) {
    clearAllBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearAllVisibleNotifications();
    });
  }
}

function ensureNotificationDropdownScrollStyles() {
  /*
    Styles are now handled by external CSS files:
    - css/admin/admin-topbar.css
    - css/admin/admin-overrides.css

    Kept as a safe no-op because existing notification code calls this function.
  */
  return;
}

function isNotificationEventInsideDropdown(event) {
  const dropdown = document.getElementById("notificationDropdown");

  if (!dropdown || !event) return false;

  const target = event.target;

  if (target && dropdown.contains(target)) {
    return true;
  }

  if (typeof event.composedPath === "function") {
    return event.composedPath().includes(dropdown);
  }

  return false;
}

function bindNotificationDropdownInnerScrollProtection() {
  const dropdown = document.getElementById("notificationDropdown");
  const list = document.getElementById("notificationList");

  if (!dropdown || dropdown.dataset.scrollProtected === "true") return;

  dropdown.dataset.scrollProtected = "true";

  /*
    Keep the dropdown open while the user scrolls inside it.
    This fixes mobile/tablet behavior where touchmove/wheel events were
    treated as page movement and closed the notification panel.
  */
  ["wheel", "touchmove"].forEach((eventName) => {
    dropdown.addEventListener(eventName, (event) => {
      event.stopPropagation();
    }, {
      passive: true
    });
  });

  if (list) {
    ["wheel", "touchmove"].forEach((eventName) => {
      list.addEventListener(eventName, (event) => {
        event.stopPropagation();
      }, {
        passive: true
      });
    });
  }
}


function closeNotificationDropdownOnPageMove() {
  const notificationDropdown = document.getElementById("notificationDropdown");

  if (!notificationDropdown || !notificationsOpen) return;

  notificationsOpen = false;
  notificationDropdown.classList.add("hidden");
}

/*
  Bind scroll/touch/wheel close once only.
  This prevents duplicated listeners if setupComplaintsModule/admin init runs again.
*/
function bindNotificationAutoCloseOnScroll() {
  if (window.__wmoNotificationScrollCloseBound === true) return;
  window.__wmoNotificationScrollCloseBound = true;

  const closeOnPageScroll = (event) => {
    if (isNotificationEventInsideDropdown(event)) return;
    closeNotificationDropdownOnPageMove();
  };

  window.addEventListener("scroll", closeOnPageScroll, {
    passive: true
  });

  document.addEventListener("scroll", closeOnPageScroll, {
    passive: true,
    capture: true
  });

  document.querySelector(".main-content")?.addEventListener("scroll", closeOnPageScroll, {
    passive: true
  });

  document.querySelector(".admin-layout")?.addEventListener("scroll", closeOnPageScroll, {
    passive: true
  });

  /*
    Some mobile browsers do not fire scroll immediately while the finger is moving.
    This closes the dropdown as soon as the user starts moving the page.
    It does not block scrolling because passive is true.
  */
  document.querySelector(".main-content")?.addEventListener("touchmove", closeOnPageScroll, {
    passive: true
  });

  document.querySelector(".admin-layout")?.addEventListener("touchmove", closeOnPageScroll, {
    passive: true
  });

  /*
    Desktop mouse wheel scroll also closes the dropdown.
    This improves behavior when the page area is scrollable.
  */
  document.querySelector(".main-content")?.addEventListener("wheel", closeOnPageScroll, {
    passive: true
  });

  document.querySelector(".admin-layout")?.addEventListener("wheel", closeOnPageScroll, {
    passive: true
  });
}

function escapeNotificationDetailHtml(value) {
  const text = safeNotificationText(value);

  if (typeof escapeHtml === "function") {
    return escapeHtml(text);
  }

  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getNotificationByStableKey(key = "") {
  const targetKey = safeNotificationText(key);

  if (!targetKey) return null;

  return (Array.isArray(notificationFeedItems) ? notificationFeedItems : []).find(
    (item) => getNotificationStableKey(item) === targetKey
  ) || null;
}

function formatNotificationDetailDate(value) {
  if (!value) return "";

  if (typeof formatDate === "function") {
    return formatDate(value);
  }

  return safeNotificationText(value);
}

function ensureNotificationDetailModal() {
  let modal = document.getElementById("notificationDetailModal");

  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "notificationDetailModal";
  modal.className = "notification-detail-modal hidden";
  modal.setAttribute("aria-hidden", "true");

  modal.innerHTML = `
    <div class="notification-detail-backdrop" data-notification-detail-close="true"></div>

    <section class="notification-detail-card" role="dialog" aria-modal="true" aria-labelledby="notificationDetailTitle">
      <header class="notification-detail-header">
        <div class="notification-detail-icon" id="notificationDetailIcon">💬</div>

        <div class="notification-detail-heading">
          <p class="notification-detail-eyebrow" id="notificationDetailType">Notification</p>
          <h3 id="notificationDetailTitle">Notification Details</h3>
          <span id="notificationDetailDate" class="notification-detail-date"></span>
        </div>

        <button type="button" class="notification-detail-close" data-notification-detail-close="true" aria-label="Close notification detail">×</button>
      </header>

      <div class="notification-detail-body">
        <div class="notification-detail-message" id="notificationDetailMessage"></div>
      </div>

      <footer class="notification-detail-footer">
        <button type="button" class="notification-detail-secondary" data-notification-detail-close="true">Close</button>
        <button type="button" class="notification-detail-primary" id="notificationDetailOpenTargetBtn">Open Related Module</button>
      </footer>
    </section>
  `;

  document.body.appendChild(modal);

  modal.addEventListener("click", (event) => {
    if (event.target.closest("[data-notification-detail-close='true']")) {
      closeNotificationDetailModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.classList.contains("hidden")) {
      closeNotificationDetailModal();
    }
  });

  return modal;
}

function openNotificationDetailModal(notif = {}) {
  const modal = ensureNotificationDetailModal();
  const normalizedNotif = normalizeAdminNotification(notif, getNotificationSource(notif));
  const icon = getNotificationDisplayIcon(normalizedNotif);
  const title = getNotificationDisplayTitle(normalizedNotif);
  const message = getNotificationDisplayMessage(normalizedNotif);
  const type = getNotificationType(normalizedNotif);
  const dateValue = getNotificationCreatedValue(normalizedNotif);
  const dateText = formatNotificationDetailDate(dateValue);
  const toneClass = getNotificationToneClass(normalizedNotif);

  const iconEl = modal.querySelector("#notificationDetailIcon");
  const typeEl = modal.querySelector("#notificationDetailType");
  const titleEl = modal.querySelector("#notificationDetailTitle");
  const dateEl = modal.querySelector("#notificationDetailDate");
  const messageEl = modal.querySelector("#notificationDetailMessage");
  const openBtn = modal.querySelector("#notificationDetailOpenTargetBtn");

  modal.className = `notification-detail-modal notif-detail-tone-${toneClass}`;

  if (iconEl) iconEl.textContent = icon || "🔔";
  if (typeEl) typeEl.textContent = type || "Notification";
  if (titleEl) titleEl.textContent = title || "Notification Details";
  if (dateEl) {
    dateEl.textContent = dateText || "";
    dateEl.style.display = dateText ? "inline-flex" : "none";
  }

  if (messageEl) {
    messageEl.innerHTML = escapeNotificationDetailHtml(
      message || "No message content available."
    ).replace(/\n/g, "<br>");
  }

  if (openBtn) {
    openBtn.onclick = () => {
      closeNotificationDetailModal();
      notificationsOpen = false;

      const dropdown = document.getElementById("notificationDropdown");
      if (dropdown) {
        dropdown.classList.add("hidden");
      }

      openNotificationTarget(normalizedNotif);
    };
  }

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function closeNotificationDetailModal() {
  const modal = document.getElementById("notificationDetailModal");
  if (!modal) return;

  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}


function getNotificationRealtimeBaseUrl() {
  if (window.APP_CONFIG?.BASE_URL) {
    return String(window.APP_CONFIG.BASE_URL).replace(/\/$/, "");
  }

  if (window.APP_CONFIG?.API_BASE_URL) {
    return String(window.APP_CONFIG.API_BASE_URL)
      .replace(/\/api\/?$/, "")
      .replace(/\/$/, "");
  }

  if (typeof getAppApiBase === "function") {
    return String(getAppApiBase())
      .replace(/\/api\/?$/, "")
      .replace(/\/$/, "");
  }

  return window.location.origin;
}

function loadSocketIoClientForNotifications() {
  return new Promise((resolve, reject) => {
    if (window.io) {
      resolve(window.io);
      return;
    }

    const existingScript = document.querySelector("script[data-wmo-socket-client='true']");

    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(window.io));
      existingScript.addEventListener("error", () => reject(new Error("Socket.IO client failed to load.")));
      return;
    }

    const script = document.createElement("script");
    script.dataset.wmoSocketClient = "true";
    script.async = true;
    script.src = `${getNotificationRealtimeBaseUrl()}/socket.io/socket.io.js`;

    script.onload = () => {
      if (window.io) {
        resolve(window.io);
      } else {
        reject(new Error("Socket.IO client loaded but window.io is unavailable."));
      }
    };

    script.onerror = () => {
      reject(new Error("Socket.IO client script request failed."));
    };

    document.head.appendChild(script);
  });
}

function scheduleRealtimeNotificationRefresh(reason = "realtime") {
  if (notificationRealtimeRefreshTimer) {
    clearTimeout(notificationRealtimeRefreshTimer);
  }

  notificationRealtimeRefreshTimer = setTimeout(() => {
    loadNotifications(true).catch((error) => {
      console.warn("Realtime notification refresh failed:", reason, error);
    });
  }, 250);
}

function setupAdminNotificationRealtime() {
  if (notificationRealtimeStarted) {
    return;
  }

  notificationRealtimeStarted = true;

  loadSocketIoClientForNotifications()
    .then((ioClient) => {
      const realtimeBaseUrl = getNotificationRealtimeBaseUrl();

      notificationRealtimeSocket = ioClient(realtimeBaseUrl, {
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        timeout: 10000
      });

      notificationRealtimeSocket.on("connect", () => {
        notificationRealtimeSocket.emit("join:wmo");
        scheduleRealtimeNotificationRefresh("socket-connected");
        console.log("[WMO Notifications] Realtime connected.");
      });

      notificationRealtimeSocket.on("disconnect", (reason) => {
        console.log("[WMO Notifications] Realtime disconnected:", reason);
      });

      notificationRealtimeSocket.on("connect_error", (error) => {
        console.warn("[WMO Notifications] Realtime connection error:", error?.message || error);
      });

      const refreshEvents = [
        "wmo:barangay-explanation-received",
        "wmo:complaint-accepted-overdue",
        "wmo:complaint-auto-rejected-overdue",
        "wmo:complaint-created",
        "wmo:complaint-submitted",
        "wmo:complaint-notification",
        "wmo:complaint-forwarded",
        "wmo:complaint-resolved",
        "wmo:complaint-rejected",
        "wmo:tracking-notification",
        "wmo:gps-tracking-notification",
        "notification:new",
        "notifications:new",
        "wmo:notification"
      ];

      refreshEvents.forEach((eventName) => {
        notificationRealtimeSocket.on(eventName, () => {
          scheduleRealtimeNotificationRefresh(eventName);
        });
      });

      /*
        Safe catch-all:
        Any future WMO event should refresh the bell/list immediately.
        This avoids needing to update the frontend every time a new WMO event
        name is added in the backend.
      */
      if (typeof notificationRealtimeSocket.onAny === "function") {
        notificationRealtimeSocket.onAny((eventName) => {
          const eventText = safeNotificationText(eventName).toLowerCase();

          if (
            eventText.startsWith("wmo:") ||
            eventText.includes("notification") ||
            eventText.includes("complaint")
          ) {
            scheduleRealtimeNotificationRefresh(eventName);
          }
        });
      }
    })
    .catch((error) => {
      /*
        If realtime client cannot load, polling still works.
        The polling interval is also shortened below for a safer fallback.
      */
      console.warn("[WMO Notifications] Realtime unavailable. Polling fallback remains active.", error);
    });
}


function renderNotificationsFromFeed(list = []) {
  notificationFeedItems = sortNotificationsNewestFirst(Array.isArray(list) ? list : []);
  renderNotifications(notificationFeedItems);
}

async function loadNotifications(playSound = true) {
  try {
    const genericNotificationsUrl =
      typeof getNotificationsApiUrl === "function" ? getNotificationsApiUrl() : "";

    const [genericNotifications, complaintNotifications] = await Promise.all([
      fetchNotificationListFromUrl(genericNotificationsUrl, "admin_notifications"),
      fetchNotificationListFromUrl(getWmoComplaintNotificationsApiUrl(), "wmo_complaints")
    ]);

    notificationFeedItems = sortNotificationsNewestFirst(uniqueNotificationsByStableKey([
      ...genericNotifications,
      ...complaintNotifications
    ]));

    const newSoundNotifications = updateNotificationSoundKnownKeys(notificationFeedItems);

    if (playSound) {
      maybePlayNotificationSound(newSoundNotifications);
    }

    renderNotificationsFromFeed(notificationFeedItems);
  } catch (error) {
    console.error("loadNotifications error:", error);
    renderNotificationsFromFeed([]);
  }
}

function startNotificationPolling() {
  if (notificationPollingInterval) {
    clearInterval(notificationPollingInterval);
  }

  if (!notificationInitialLoadStarted) {
    notificationInitialLoadStarted = true;
    loadNotifications(false);
  }

  notificationPollingInterval = setInterval(() => {
    loadNotifications(true);
  }, 3000);
}

function renderNotifications(list = []) {
  const notificationCount = document.getElementById("notificationCount");
  const notificationList = document.getElementById("notificationList");

  if (!notificationCount || !notificationList) return;

  ensureNotificationHeaderActions();
  ensureNotificationDropdownScrollStyles();
  bindNotificationDropdownInnerScrollProtection();

  const safeList = sortNotificationsNewestFirst(Array.isArray(list) ? list : []);
  const dismissedKeys = getDismissedNotificationIds();
  const seenKeys = getSeenNotificationKeys();

  const visibleNotifications = sortNotificationsNewestFirst(safeList.filter((notif) => {
    const key = getNotificationStableKey(notif);
    return !dismissedKeys.includes(key);
  }));

  const unseenNotifications = visibleNotifications.filter((notif) => {
    const key = getNotificationStableKey(notif);
    return !seenKeys.includes(key);
  });

  notificationCount.textContent =
    unseenNotifications.length > 99 ? "99+" : String(unseenNotifications.length);

  if (!visibleNotifications.length) {
    notificationList.innerHTML = `<div class="notif-empty">No notifications</div>`;
    return;
  }

  notificationList.innerHTML = visibleNotifications.slice(0, 20).map((notif) => {
    const normalizedNotif = normalizeAdminNotification(notif, getNotificationSource(notif));
    const key = getNotificationStableKey(normalizedNotif);
    const title = getNotificationDisplayTitle(normalizedNotif);
    const message = getNotificationDisplayMessage(normalizedNotif);
    const type = getNotificationType(normalizedNotif);
    const statusClass = getNotificationStatusClass(normalizedNotif);
    const toneClass = getNotificationToneClass(normalizedNotif);
    const icon = getNotificationDisplayIcon(normalizedNotif);
    const createdRaw = getNotificationCreatedValue(normalizedNotif);
    const createdAt = createdRaw ? formatDate(createdRaw) : "";
    const isSeen = seenKeys.includes(key);

    return `
      <article
        class="notif-item notif-tone-${escapeHtml(toneClass)} ${isSeen ? "seen" : "unseen"}"
        data-key="${escapeHtml(key)}"
        data-type="${escapeHtml(type)}"
        role="button"
        tabindex="0"
        aria-label="${escapeHtml(title)}"
      >
        <div class="notif-main">
          <div class="notif-icon" aria-hidden="true">${escapeHtml(icon)}</div>

          <div class="notif-content">
            <div class="notif-title-row">
              <div class="notif-title">${escapeHtml(title)}</div>
              ${isSeen ? "" : `<span class="notif-unread-dot" aria-label="Unread"></span>`}
            </div>

            <p class="notif-message">${escapeHtml(message)}</p>

            <div class="notif-status-row">
              <span class="notif-status ${escapeHtml(statusClass)}">${escapeHtml(type)}</span>
              ${createdAt ? `<span class="notif-date">${escapeHtml(createdAt)}</span>` : ""}
            </div>
          </div>
        </div>

        <div class="notif-actions">
          <button
            type="button"
            class="view-notification-btn btn-view-notif"
            data-key="${escapeHtml(key)}"
            aria-label="View full notification message"
            title="View full message"
          >
            View
          </button>

          <button
            type="button"
            class="clear-notification-btn btn-clear-notif"
            data-key="${escapeHtml(key)}"
            aria-label="Clear notification"
            title="Clear notification"
          >
            Clear
          </button>
        </div>
      </article>
    `;
  }).join("");
}

function bindNotificationActions() {
  const notificationBtn = document.getElementById("notificationBtn");
  const notificationDropdown = document.getElementById("notificationDropdown");
  const notificationList = document.getElementById("notificationList");

  if (!notificationBtn || !notificationDropdown) return;

  bindNotificationSoundUnlock();
  setupAdminNotificationRealtime();
  startNotificationPolling();

  ensureNotificationHeaderActions();
  ensureNotificationDropdownScrollStyles();
  bindNotificationDropdownInnerScrollProtection();
  bindNotificationAutoCloseOnScroll();

  notificationBtn.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();

    notificationsOpen = !notificationsOpen;
    notificationDropdown.classList.toggle("hidden", !notificationsOpen);

    if (notificationsOpen) {
      notificationsSeen = true;
      ensureNotificationDropdownScrollStyles();
      bindNotificationDropdownInnerScrollProtection();
      markVisibleNotificationsAsSeen();
    }
  };

  document.onclick = (event) => {
    if (
      notificationsOpen &&
      !notificationDropdown.contains(event.target) &&
      !notificationBtn.contains(event.target)
    ) {
      notificationsOpen = false;
      notificationDropdown.classList.add("hidden");
    }
  };

  if (notificationList) {
    notificationList.onclick = (event) => {
      const viewBtn = event.target.closest(".btn-view-notif");

      if (viewBtn) {
        event.preventDefault();
        event.stopPropagation();

        const key = viewBtn.getAttribute("data-key");
        const selectedNotification = getNotificationByStableKey(key);

        if (key) {
          const seen = getSeenNotificationKeys();
          if (!seen.includes(key)) {
            seen.push(key);
            setSeenNotificationKeys(seen);
          }
        }

        openNotificationDetailModal(selectedNotification || {
          title: "Notification Details",
          message: viewBtn.closest(".notif-item")?.querySelector(".notif-message")?.textContent || ""
        });

        renderNotificationsFromFeed(notificationFeedItems);
        return;
      }

      const clearBtn = event.target.closest(".btn-clear-notif");

      if (clearBtn) {
        event.preventDefault();
        event.stopPropagation();

        const key = clearBtn.getAttribute("data-key");

        if (key) {
          dismissNotificationById(key);
          notificationFeedItems = notificationFeedItems.filter(
            item => getNotificationStableKey(item) !== key
          );
          renderNotificationsFromFeed(notificationFeedItems);
        }

        return;
      }

      const notifItem = event.target.closest(".notif-item");
      if (!notifItem) return;

      const key = notifItem.getAttribute("data-key");

      if (key) {
        const seen = getSeenNotificationKeys();
        if (!seen.includes(key)) {
          seen.push(key);
          setSeenNotificationKeys(seen);
        }
      }

      const selectedNotification = notificationFeedItems.find(
        item => getNotificationStableKey(item) === key
      );

      notificationsOpen = false;
      notificationDropdown.classList.add("hidden");
      renderNotificationsFromFeed(notificationFeedItems);

      openNotificationTarget(selectedNotification || {
        type: notifItem.getAttribute("data-type") || "",
        title: notifItem.querySelector(".notif-title")?.textContent || "",
        message: notifItem.querySelector(".notif-message")?.textContent || notifItem.querySelector(".notif-meta")?.textContent || ""
      });
    };
  }
}


/*
  Fallback initializer:
  If admin-init.js does not call bindNotificationActions for any reason,
  this keeps the WMO notification bell/list live.
*/
document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => {
    bindNotificationActions();
    setupAdminNotificationRealtime();
    startNotificationPolling();
  }, 300);
});

