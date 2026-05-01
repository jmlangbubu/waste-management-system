/* =========================
   ADMIN OTHER MODULE
   Calendar-first activity manager
========================= */

const CALENDAR_STORAGE_KEY = "wmo_calendar_activities_v1";

const calendarState = {
  currentDate: new Date(),
  selectedDateKey: "",
  activities: []
};

/* =========================
   SIDEBAR OTHER MENU
========================= */

function setupAdminOtherMenu() {
  const group = document.getElementById("sidebarOtherGroup");
  const trigger = document.getElementById("sidebarOtherTrigger");
  const menu = document.getElementById("sidebarOtherMenu");

  if (!group || !trigger || !menu) return;

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();

    const isOpen = group.classList.toggle("open");
    menu.classList.toggle("hidden", !isOpen);
    trigger.setAttribute("aria-expanded", String(isOpen));

    if (window.lucide) lucide.createIcons();
  });

  menu.addEventListener("click", (event) => event.stopPropagation());

  document.addEventListener("click", (event) => {
    if (!group.contains(event.target)) closeAdminOtherMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAdminOtherMenu();
      closeCalendarActivitiesModal();
      closeCalendarAddActivityModal();
      closeIncomingInvoiceModal();
      closeCalendarMonthlyReportModal();
    }
  });
}

function closeAdminOtherMenu() {
  const group = document.getElementById("sidebarOtherGroup");
  const trigger = document.getElementById("sidebarOtherTrigger");
  const menu = document.getElementById("sidebarOtherMenu");

  if (!group || !trigger || !menu) return;

  group.classList.remove("open");
  menu.classList.add("hidden");
  trigger.setAttribute("aria-expanded", "false");
}

/* =========================
   STORAGE
========================= */

function loadCalendarActivities() {
  try {
    const saved = localStorage.getItem(CALENDAR_STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    calendarState.activities = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Failed to load calendar activities:", error);
    calendarState.activities = [];
  }
}

function saveCalendarActivities() {
  try {
    localStorage.setItem(CALENDAR_STORAGE_KEY, JSON.stringify(calendarState.activities));
  } catch (error) {
    console.error("Failed to save calendar activities:", error);
  }
}

/* =========================
   DATE HELPERS
========================= */

function getDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getMonthKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");

  return `${year}-${month}`;
}

function parseDateKey(dateKey) {
  return new Date(`${dateKey}T00:00:00`);
}

function getTodayKey() {
  return getDateKey(new Date());
}

function formatMonthYear(date) {
  return date.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric"
  });
}

function formatFullDate(dateKey) {
  const parsed = parseDateKey(dateKey);

  if (Number.isNaN(parsed.getTime())) return dateKey;

  return parsed.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  });
}

function formatShortDate(dateKey) {
  const parsed = parseDateKey(dateKey);

  if (Number.isNaN(parsed.getTime())) return dateKey;

  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric"
  });
}

function getMonthStatus(monthKey) {
  const currentMonthKey = getMonthKey(new Date());

  if (monthKey < currentMonthKey) return "Report Ready";
  if (monthKey === currentMonthKey) return "Ongoing";
  return "Upcoming";
}

function getActivitiesByDate(dateKey) {
  return calendarState.activities
    .filter((item) => item.date === dateKey)
    .sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));
}

function getActivitiesByMonth(monthKey) {
  return calendarState.activities
    .filter((item) => item.date && item.date.startsWith(monthKey))
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return String(a.time || "").localeCompare(String(b.time || ""));
    });
}

function ensureSelectedDate() {
  if (!calendarState.selectedDateKey) {
    calendarState.selectedDateKey = getTodayKey();
  }
}

/* =========================
   MAIN CALENDAR RENDER
========================= */

function renderCalendar() {
  ensureSelectedDate();

  const label = document.getElementById("calendarCurrentLabel");
  const subLabel = document.getElementById("calendarMonthSubLabel");
  const grid = document.getElementById("calendarGrid");

  if (!label || !grid) return;

  const current = calendarState.currentDate;
  const year = current.getFullYear();
  const month = current.getMonth();
  const monthKey = getMonthKey(current);
  const monthActivities = getActivitiesByMonth(monthKey);
  const activeDays = new Set(monthActivities.map((item) => item.date)).size;

  label.textContent = `${formatMonthYear(current)} Activity Calendar`;

  if (subLabel) {
    subLabel.textContent = `${monthActivities.length} activit${monthActivities.length === 1 ? "y" : "ies"} saved this month.`;
  }

  setTextContent("calendarMainTotal", monthActivities.length);
  setTextContent("calendarMainActiveDays", activeDays);
  setTextContent("calendarMainStatus", getMonthStatus(monthKey));

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startWeekday = firstDay.getDay();
  const totalDays = lastDay.getDate();
  const prevMonthLastDay = new Date(year, month, 0).getDate();

  const cells = [];

  for (let i = startWeekday - 1; i >= 0; i--) {
    const cellDate = new Date(year, month - 1, prevMonthLastDay - i);
    cells.push(createCalendarDayCell(cellDate, true));
  }

  for (let day = 1; day <= totalDays; day++) {
    const cellDate = new Date(year, month, day);
    cells.push(createCalendarDayCell(cellDate, false));
  }

  while (cells.length < 42) {
    const day = cells.length - (startWeekday + totalDays) + 1;
    const cellDate = new Date(year, month + 1, day);
    cells.push(createCalendarDayCell(cellDate, true));
  }

  grid.innerHTML = cells.join("");

  grid.querySelectorAll(".calendar-report-cell").forEach((button) => {
    button.addEventListener("click", () => {
      const dateKey = button.dataset.date;
      if (!dateKey) return;

      selectCalendarDate(dateKey);
    });

    button.addEventListener("dblclick", () => {
      const dateKey = button.dataset.date;
      if (!dateKey) return;

      selectCalendarDate(dateKey);
      openCalendarAddForm();
    });
  });

  renderSelectedDatePanel();
  renderMonthlyReports();
}

function createCalendarDayCell(date, muted) {
  const dateKey = getDateKey(date);
  const activities = getActivitiesByDate(dateKey);
  const todayKey = getTodayKey();

  return `
    <button type="button"
      class="calendar-report-cell calendar-clickable-date ${muted ? "is-muted" : ""} ${activities.length ? "has-activities" : ""} ${dateKey === todayKey ? "is-today" : ""} ${dateKey === calendarState.selectedDateKey ? "is-selected" : ""}"
      data-date="${dateKey}">
      <strong>${date.getDate()}</strong>
      ${activities.slice(0, 3).map((item) => `<span>${escapeOtherHtml(item.title)}</span>`).join("")}
      ${activities.length > 3 ? `<small>+${activities.length - 3} more</small>` : ""}
    </button>
  `;
}

function selectCalendarDate(dateKey) {
  const parsed = parseDateKey(dateKey);

  if (Number.isNaN(parsed.getTime())) return;

  calendarState.selectedDateKey = dateKey;
  calendarState.currentDate = new Date(parsed.getFullYear(), parsed.getMonth(), 1);

  renderCalendar();
}

function setTextContent(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

/* =========================
   SELECTED DATE PANEL
========================= */

function renderSelectedDatePanel() {
  const selectedLabel = document.getElementById("calendarSelectedDateLabel");
  const addSelectedLabel = document.getElementById("calendarAddSelectedDateLabel");
  const addSubtitle = document.getElementById("calendarAddActivitySubtitle");
  const list = document.getElementById("calendarActivityList");
  const count = document.getElementById("calendarActivityCount");

  ensureSelectedDate();

  const activities = getActivitiesByDate(calendarState.selectedDateKey);
  const selectedLabelText = formatFullDate(calendarState.selectedDateKey);

  if (selectedLabel) selectedLabel.textContent = selectedLabelText;
  if (addSelectedLabel) addSelectedLabel.textContent = selectedLabelText;
  if (addSubtitle) addSubtitle.textContent = `Create an activity for ${selectedLabelText}.`;
  if (count) count.textContent = activities.length;

  if (!list) return;

  if (!activities.length) {
    list.innerHTML = `
      <div class="calendar-empty-day">
        <strong>No activities yet</strong>
        <p>Click Add Activity or double-click the date cell to create a schedule.</p>
      </div>
    `;
    return;
  }

  list.innerHTML = activities.map((item) => `
    <div class="calendar-pro-activity-card">
      <div class="calendar-pro-activity-head">
        <div>
          <h5>${escapeOtherHtml(item.title)}</h5>
          <span>${escapeOtherHtml(item.category || "General")}</span>
        </div>

        <button type="button" class="calendar-delete-activity-btn" data-id="${item.id}">
          Delete
        </button>
      </div>

      <div class="calendar-pro-activity-meta">
        <strong>${item.time ? escapeOtherHtml(item.time) : "No time"}</strong>
        <small>${formatShortDate(item.date)}</small>
      </div>

      ${item.notes ? `<p>${escapeOtherHtml(item.notes)}</p>` : ""}
    </div>
  `).join("");

  list.querySelectorAll(".calendar-delete-activity-btn").forEach((button) => {
    button.addEventListener("click", () => {
      deleteCalendarActivity(button.dataset.id);
    });
  });
}

/* =========================
   ADD ACTIVITY MODAL
========================= */

function openCalendarAddForm() {
  ensureSelectedDate();
  renderSelectedDatePanel();

  const modal = document.getElementById("calendarAddActivityModal");
  const title = document.getElementById("calendarActivityTitle");

  if (!modal) return;

  modal.classList.remove("hidden");

  setTimeout(() => {
    title?.focus();
  }, 80);
}

function closeCalendarAddActivityModal() {
  const modal = document.getElementById("calendarAddActivityModal");
  const form = document.getElementById("calendarActivityForm");

  if (modal) modal.classList.add("hidden");
  if (form) form.reset();
}

function addCalendarActivity(event) {
  event.preventDefault();

  ensureSelectedDate();

  const titleInput = document.getElementById("calendarActivityTitle");
  const timeInput = document.getElementById("calendarActivityTime");
  const categoryInput = document.getElementById("calendarActivityTag");
  const notesInput = document.getElementById("calendarActivityNotes");

  const title = titleInput?.value.trim();

  if (!title) {
    titleInput?.focus();
    return;
  }

  calendarState.activities.push({
    id: `activity-${Date.now()}`,
    date: calendarState.selectedDateKey,
    title,
    time: timeInput?.value || "",
    category: categoryInput?.value || "General",
    notes: notesInput?.value.trim() || ""
  });

  saveCalendarActivities();
  closeCalendarAddActivityModal();
  renderCalendar();
}

function deleteCalendarActivity(activityId) {
  calendarState.activities = calendarState.activities.filter((item) => item.id !== activityId);

  saveCalendarActivities();
  renderCalendar();
}

/* =========================
   MONTHLY REPORTS
========================= */

function renderMonthlyReports() {
  const container = document.getElementById("calendarMonthlyReportList");
  if (!container) return;

  const groups = new Map();

  calendarState.activities.forEach((item) => {
    if (!item.date) return;

    const monthKey = item.date.slice(0, 7);
    if (!groups.has(monthKey)) groups.set(monthKey, []);
    groups.get(monthKey).push(item);
  });

  const monthRows = Array.from(groups.entries()).sort(([a], [b]) => b.localeCompare(a));

  if (!monthRows.length) {
    container.innerHTML = `<div class="calendar-empty-report">No monthly reports yet.</div>`;
    return;
  }

  container.innerHTML = monthRows.map(([monthKey, items]) => {
    const date = new Date(`${monthKey}-01T00:00:00`);
    const activeDays = new Set(items.map((item) => item.date)).size;

    return `
      <div class="calendar-month-report-row">
        <div>
          <strong>${formatMonthYear(date)}</strong>
          <span>${items.length} activit${items.length === 1 ? "y" : "ies"} • ${activeDays} active day${activeDays === 1 ? "" : "s"}</span>
        </div>

        <div class="calendar-month-report-actions">
          <span class="calendar-month-status">${getMonthStatus(monthKey)}</span>
          <button type="button" class="calendar-view-report-btn" data-month="${monthKey}">
            View
          </button>
        </div>
      </div>
    `;
  }).join("");

  container.querySelectorAll(".calendar-view-report-btn").forEach((button) => {
    button.addEventListener("click", () => {
      openCalendarMonthlyReportModal(button.dataset.month);
    });
  });
}

function openCalendarMonthlyReportModal(monthKey) {
  const modal = document.getElementById("calendarMonthlyReportModal");
  if (!modal || !monthKey) return;

  renderCalendarMonthlyReport(monthKey);
  modal.classList.remove("hidden");
}

function closeCalendarMonthlyReportModal() {
  const modal = document.getElementById("calendarMonthlyReportModal");
  if (modal) modal.classList.add("hidden");
}

function renderCalendarMonthlyReport(monthKey) {
  const reportTitle = document.getElementById("calendarReportTitle");
  const reportSubtitle = document.getElementById("calendarReportSubtitle");
  const reportTotal = document.getElementById("calendarReportTotal");
  const reportActiveDays = document.getElementById("calendarReportActiveDays");
  const reportStatus = document.getElementById("calendarReportStatus");
  const reportGrid = document.getElementById("calendarReportGrid");
  const reportList = document.getElementById("calendarReportList");

  const [yearValue, monthValue] = monthKey.split("-").map(Number);
  const date = new Date(yearValue, monthValue - 1, 1);
  const activities = getActivitiesByMonth(monthKey);
  const activeDays = new Set(activities.map((item) => item.date)).size;

  if (reportTitle) reportTitle.textContent = `${formatMonthYear(date)} Activity Report`;
  if (reportSubtitle) reportSubtitle.textContent = "Whole-month record of saved activities.";
  if (reportTotal) reportTotal.textContent = activities.length;
  if (reportActiveDays) reportActiveDays.textContent = activeDays;
  if (reportStatus) reportStatus.textContent = getMonthStatus(monthKey);

  if (reportGrid) reportGrid.innerHTML = createReportMonthGrid(date);

  if (!reportList) return;

  if (!activities.length) {
    reportList.innerHTML = `<div class="calendar-empty-report">No activities found for this month.</div>`;
    return;
  }

  const grouped = new Map();

  activities.forEach((item) => {
    if (!grouped.has(item.date)) grouped.set(item.date, []);
    grouped.get(item.date).push(item);
  });

  reportList.innerHTML = Array.from(grouped.entries()).map(([dateKey, items]) => `
    <div class="calendar-report-day-group">
      <h5>${formatFullDate(dateKey)}</h5>

      <div class="calendar-report-activity-stack">
        ${items.map((item) => `
          <div class="calendar-report-activity-item">
            <strong>${escapeOtherHtml(item.title)}</strong>
            <span>${item.time ? escapeOtherHtml(item.time) : "No time"} • ${escapeOtherHtml(item.category || "General")}</span>
            ${item.notes ? `<p>${escapeOtherHtml(item.notes)}</p>` : ""}
          </div>
        `).join("")}
      </div>
    </div>
  `).join("");
}

function createReportMonthGrid(monthDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startWeekday = firstDay.getDay();
  const totalDays = lastDay.getDate();
  const prevMonthLastDay = new Date(year, month, 0).getDate();

  const cells = [];

  for (let i = startWeekday - 1; i >= 0; i--) {
    const date = new Date(year, month - 1, prevMonthLastDay - i);
    cells.push(createReportCell(date, true));
  }

  for (let day = 1; day <= totalDays; day++) {
    const date = new Date(year, month, day);
    cells.push(createReportCell(date, false));
  }

  while (cells.length < 42) {
    const day = cells.length - (startWeekday + totalDays) + 1;
    const date = new Date(year, month + 1, day);
    cells.push(createReportCell(date, true));
  }

  return cells.join("");
}

function createReportCell(date, muted) {
  const dateKey = getDateKey(date);
  const activities = getActivitiesByDate(dateKey);

  return `
    <div class="calendar-report-cell ${muted ? "is-muted" : ""} ${activities.length ? "has-activities" : ""}">
      <strong>${date.getDate()}</strong>
      ${activities.slice(0, 3).map((item) => `<span>${escapeOtherHtml(item.title)}</span>`).join("")}
      ${activities.length > 3 ? `<small>+${activities.length - 3} more</small>` : ""}
    </div>
  `;
}

/* =========================
   MAIN MODALS
========================= */

function openCalendarActivitiesModal() {
  const modal = document.getElementById("calendarActivitiesModal");
  if (!modal) return;

  closeAdminOtherMenu();

  if (!calendarState.selectedDateKey) {
    calendarState.selectedDateKey = getTodayKey();
  }

  const selected = parseDateKey(calendarState.selectedDateKey);
  calendarState.currentDate = new Date(selected.getFullYear(), selected.getMonth(), 1);

  modal.classList.remove("hidden");
  renderCalendar();
}

function closeCalendarActivitiesModal() {
  const modal = document.getElementById("calendarActivitiesModal");
  if (modal) modal.classList.add("hidden");
}

function openIncomingInvoiceModal() {
  const modal = document.getElementById("incomingInvoiceModal");
  if (!modal) return;

  closeAdminOtherMenu();
  modal.classList.remove("hidden");
}

function closeIncomingInvoiceModal() {
  const modal = document.getElementById("incomingInvoiceModal");
  if (modal) modal.classList.add("hidden");
}

/* =========================
   SETUP
========================= */

function setupCalendarActions() {
  document.querySelector("#calendarAddActivityModal .calendar-add-activity-content")?.addEventListener("click", (event) => event.stopPropagation());
  document.getElementById("calendarPrevMonthBtn")?.addEventListener("click", () => {
    calendarState.currentDate = new Date(
      calendarState.currentDate.getFullYear(),
      calendarState.currentDate.getMonth() - 1,
      1
    );

    calendarState.selectedDateKey = getDateKey(calendarState.currentDate);
    renderCalendar();
  });

  document.getElementById("calendarNextMonthBtn")?.addEventListener("click", () => {
    calendarState.currentDate = new Date(
      calendarState.currentDate.getFullYear(),
      calendarState.currentDate.getMonth() + 1,
      1
    );

    calendarState.selectedDateKey = getDateKey(calendarState.currentDate);
    renderCalendar();
  });

  document.getElementById("calendarTodayBtn")?.addEventListener("click", () => {
    const today = new Date();

    calendarState.currentDate = new Date(today.getFullYear(), today.getMonth(), 1);
    calendarState.selectedDateKey = getDateKey(today);

    renderCalendar();
  });

  document.getElementById("calendarOpenAddBtn")?.addEventListener("click", openCalendarAddForm);
  document.querySelectorAll("#calendarCloseAddFormBtn").forEach((btn) => {
    btn.addEventListener("click", closeCalendarAddActivityModal);
  });
  document.getElementById("calendarAddActivityOverlay")?.addEventListener("click", closeCalendarAddActivityModal);
  document.getElementById("calendarActivityForm")?.addEventListener("submit", addCalendarActivity);
}

function setupAdminOtherModals() {
  document.getElementById("openCalendarActivitiesBtn")?.addEventListener("click", openCalendarActivitiesModal);
  document.getElementById("closeCalendarActivitiesBtn")?.addEventListener("click", closeCalendarActivitiesModal);
  document.getElementById("calendarActivitiesOverlay")?.addEventListener("click", closeCalendarActivitiesModal);

  document.getElementById("openIncomingInvoiceBtn")?.addEventListener("click", openIncomingInvoiceModal);
  document.getElementById("closeIncomingInvoiceBtn")?.addEventListener("click", closeIncomingInvoiceModal);
  document.getElementById("incomingInvoiceOverlay")?.addEventListener("click", closeIncomingInvoiceModal);

  document.getElementById("closeCalendarMonthlyReportBtn")?.addEventListener("click", closeCalendarMonthlyReportModal);
  document.getElementById("calendarMonthlyReportOverlay")?.addEventListener("click", closeCalendarMonthlyReportModal);
}

function escapeOtherHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

document.addEventListener("DOMContentLoaded", () => {
  loadCalendarActivities();
  setupAdminOtherMenu();
  setupAdminOtherModals();
  setupCalendarActions();

  if (window.lucide) lucide.createIcons();
});

window.openCalendarActivitiesModal = openCalendarActivitiesModal;
window.closeCalendarActivitiesModal = closeCalendarActivitiesModal;
window.openIncomingInvoiceModal = openIncomingInvoiceModal;
window.closeIncomingInvoiceModal = closeIncomingInvoiceModal;
window.openCalendarMonthlyReportModal = openCalendarMonthlyReportModal;
window.closeCalendarMonthlyReportModal = closeCalendarMonthlyReportModal;
window.closeCalendarAddActivityModal = closeCalendarAddActivityModal;
window.closeAdminOtherMenu = closeAdminOtherMenu;
