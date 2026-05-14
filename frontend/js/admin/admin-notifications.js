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
*/

const NOTIF_DISMISSED_STORAGE_KEY = "wmoDismissedNotificationKeys";
const NOTIF_SEEN_STORAGE_KEY = "wmoSeenNotificationKeys";

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

  const combined = [
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
    combined.includes("report")
  ) {
    return "complaint";
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
    return "waste";
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

  if (type.includes("complaint")) {
    return "pending";
  }

  if (type.includes("appointment")) {
    return "pending";
  }

  if (type.includes("waste")) {
    return "validated";
  }

  return "pending";
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
  if (document.getElementById("wmo-notification-scroll-style")) return;

  const style = document.createElement("style");
  style.id = "wmo-notification-scroll-style";
  style.textContent = `
    #notificationDropdown {
      max-height: min(74vh, 560px) !important;
      overflow: hidden !important;
      display: flex !important;
      flex-direction: column !important;
    }

    #notificationDropdown.hidden {
      display: none !important;
    }

    #notificationDropdown .notif-header {
      flex: 0 0 auto !important;
    }

    #notificationList {
      flex: 1 1 auto !important;
      min-height: 0 !important;
      max-height: min(62vh, 455px) !important;
      overflow-y: auto !important;
      overflow-x: hidden !important;
      overscroll-behavior: contain !important;
      -webkit-overflow-scrolling: touch !important;
      padding-right: 6px !important;
    }

    #notificationList::-webkit-scrollbar {
      width: 8px !important;
    }

    #notificationList::-webkit-scrollbar-thumb {
      background: #cbd5e1 !important;
      border-radius: 999px !important;
    }

    #notificationList::-webkit-scrollbar-track {
      background: transparent !important;
    }

    @media (max-width: 640px) {
      #notificationDropdown {
        width: min(94vw, 420px) !important;
        max-height: 76vh !important;
      }

      #notificationList {
        max-height: 58vh !important;
      }
    }
  `;

  document.head.appendChild(style);
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

function renderNotificationsFromFeed(list = []) {
  notificationFeedItems = Array.isArray(list) ? list : [];
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

    notificationFeedItems = uniqueNotificationsByStableKey([
      ...genericNotifications,
      ...complaintNotifications
    ]);

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

  notificationPollingInterval = setInterval(() => {
    loadNotifications(false);
  }, 10000);
}

function renderNotifications(list = []) {
  const notificationCount = document.getElementById("notificationCount");
  const notificationList = document.getElementById("notificationList");

  if (!notificationCount || !notificationList) return;

  ensureNotificationHeaderActions();
  ensureNotificationDropdownScrollStyles();
  bindNotificationDropdownInnerScrollProtection();

  const safeList = Array.isArray(list) ? list : [];
  const dismissedKeys = getDismissedNotificationIds();
  const seenKeys = getSeenNotificationKeys();

  const visibleNotifications = safeList.filter((notif) => {
    const key = getNotificationStableKey(notif);
    return !dismissedKeys.includes(key);
  });

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
    const title = getNotificationTitle(normalizedNotif);
    const message = getNotificationMessage(normalizedNotif);
    const type = getNotificationType(normalizedNotif);
    const statusClass = getNotificationStatusClass(normalizedNotif);
    const createdRaw = getNotificationCreatedValue(normalizedNotif);
    const createdAt = createdRaw ? formatDate(createdRaw) : "";
    const isSeen = seenKeys.includes(key);

    return `
      <div
        class="notif-item ${isSeen ? "seen" : "unseen"}"
        data-key="${escapeHtml(key)}"
        data-type="${escapeHtml(type)}"
      >
        <div class="notif-content">
          <div class="notif-title">${escapeHtml(title)}</div>
          <div class="notif-meta">
            <span>${escapeHtml(message)}</span>
          </div>
          <div class="notif-status-row">
            <span class="notif-status ${escapeHtml(statusClass)}">${escapeHtml(type)}</span>
            <span class="notif-assigned">${escapeHtml(createdAt)}</span>
          </div>
        </div>

        <button
          type="button"
          class="clear-notification-btn btn-clear-notif"
          data-key="${escapeHtml(key)}"
        >
          Clear
        </button>
      </div>
    `;
  }).join("");
}

function bindNotificationActions() {
  const notificationBtn = document.getElementById("notificationBtn");
  const notificationDropdown = document.getElementById("notificationDropdown");
  const notificationList = document.getElementById("notificationList");

  if (!notificationBtn || !notificationDropdown) return;

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
        message: notifItem.querySelector(".notif-meta")?.textContent || ""
      });
    };
  }
}
