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
    notif.date ||
    notif.timestamp ||
    notif.time ||
    ""
  );
}

function getNotificationStableKey(notif = {}) {
  const directId =
    notif.id ??
    notif.notification_id ??
    notif.notificationId ??
    notif.appointment_id ??
    notif.appointmentId ??
    notif.complaint_id ??
    notif.complaintId ??
    "";

  if (directId !== null && directId !== undefined && String(directId).trim() !== "") {
    return `id:${String(directId).trim()}`;
  }

  const title = safeNotificationText(notif.title || notif.subject || "Notification");
  const message = safeNotificationText(notif.message || notif.description || "");
  const type = safeNotificationText(notif.type || notif.category || "system");
  const created = safeNotificationText(getNotificationCreatedValue(notif));

  return `content:${type}|${title}|${message}|${created}`;
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

  const closeOnPageScroll = () => {
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
    const res = await fetch(getNotificationsApiUrl(), {
      headers: {
        Accept: "application/json"
      }
    });

    const data = await res.json();

    const list = Array.isArray(data)
      ? data
      : Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.notifications)
      ? data.notifications
      : [];

    notificationFeedItems = list;
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
    const key = getNotificationStableKey(notif);
    const title = notif.title || notif.subject || "Notification";
    const message = notif.message || notif.description || "";
    const type = notif.type || notif.category || "system";
    const createdRaw = getNotificationCreatedValue(notif);
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
            <span class="notif-status pending">${escapeHtml(type)}</span>
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
  bindNotificationAutoCloseOnScroll();

  notificationBtn.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();

    notificationsOpen = !notificationsOpen;
    notificationDropdown.classList.toggle("hidden", !notificationsOpen);

    if (notificationsOpen) {
      notificationsSeen = true;
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

      notificationsOpen = false;
      notificationDropdown.classList.add("hidden");
      renderNotificationsFromFeed(notificationFeedItems);

      if (typeof openSection === "function") {
        openSection("appointmentsSection");
      }
    };
  }
}
