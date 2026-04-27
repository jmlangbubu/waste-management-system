function getDismissedNotificationIds() {
  try {
    return JSON.parse(localStorage.getItem("dismissedNotificationIds") || "[]");
  } catch {
    return [];
  }
}

function setDismissedNotificationIds(ids) {
  localStorage.setItem("dismissedNotificationIds", JSON.stringify(ids));
}

function dismissNotificationById(id) {
  const dismissed = getDismissedNotificationIds();

  if (!dismissed.includes(String(id))) {
    dismissed.push(String(id));
  }

  setDismissedNotificationIds(dismissed);
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

  const dismissedIds = getDismissedNotificationIds();

  const visibleNotifications = list.filter((notif) => {
    return !dismissedIds.includes(String(notif.id));
  });

  if (!visibleNotifications.length) {
    notificationCount.textContent = "0";
    notificationList.innerHTML = `<div class="notif-empty">No notifications</div>`;
    return;
  }

  notificationCount.textContent =
    visibleNotifications.length > 99 ? "99+" : String(visibleNotifications.length);

  notificationList.innerHTML = visibleNotifications.slice(0, 8).map((notif) => {
    const title = notif.title || "Notification";
    const message = notif.message || "";
    const type = notif.type || "system";
    const createdAt = notif.createdAt ? formatDate(notif.createdAt) : "";

    return `
      <div class="notif-item" data-id="${notif.id}" data-type="${escapeHtml(type)}">
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
          data-id="${notif.id}"
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
  const notificationCount = document.getElementById("notificationCount");

  if (!notificationBtn || !notificationDropdown) return;

  notificationBtn.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();

    notificationsOpen = !notificationsOpen;
    notificationDropdown.classList.toggle("hidden", !notificationsOpen);

    if (notificationsOpen) {
      notificationsSeen = true;
      if (notificationCount) notificationCount.textContent = "0";
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

        const id = clearBtn.getAttribute("data-id");

        if (id) {
          dismissNotificationById(id);
          notificationFeedItems = notificationFeedItems.filter(
            item => String(item.id) !== String(id)
          );
          renderNotificationsFromFeed(notificationFeedItems);
        }

        return;
      }

      const notifItem = event.target.closest(".notif-item");
      if (!notifItem) return;

      notificationsOpen = false;
      notificationDropdown.classList.add("hidden");

      if (typeof openSection === "function") {
        openSection("appointmentsSection");
      }
    };
  }
}