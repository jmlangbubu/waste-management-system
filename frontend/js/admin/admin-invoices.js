/* =========================
   ADMIN INVOICE WORKFLOW
   DATABASE/API VERSION

   Flow:
   Head Admin -> Clerk Admin -> Supervisor -> Division Admin -> Clerk Admin -> Report
========================= */

let invoiceRecords = [];
let invoiceClerkAccounts = [];
let invoiceDivisionAdminAccounts = [];

function getInvoiceApiBase() {
  if (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) {
    return window.APP_CONFIG.API_BASE_URL;
  }

  return "";
}

function getInvoiceApiUrl(path = "") {
  return `${getInvoiceApiBase()}/invoices${path}`;
}

function getInvoiceStoredUser() {
  try {
    const raw = localStorage.getItem("webUser");
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error("Invalid webUser for invoice workflow:", error);
    return null;
  }
}

function normalizeInvoiceRole(role) {
  return String(role || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function formatInvoiceRole(role) {
  const labels = {
    super_admin: "Head Admin",
    head_admin: "Head Admin",
    admin: "Head Admin",
    clerk_admin: "Clerk Admin",
    supervisor: "Supervisor",
    division_admin: "Division Admin",
    personnel: "Personnel"
  };

  return labels[normalizeInvoiceRole(role)] || role || "-";
}

function getInvoiceCurrentUser() {
  const user = getInvoiceStoredUser();

  if (!user) {
    return {
      id: null,
      name: "Unknown User",
      username: "",
      role: ""
    };
  }

  return {
    id: user.id || null,
    name: user.fullName || user.full_name || user.username || "Unknown User",
    username: user.username || "",
    role: normalizeInvoiceRole(user.role || ""),
    divisionName: user.divisionName || user.division_name || ""
  };
}

function isInvoiceHeadAdmin(role) {
  return ["super_admin", "head_admin", "admin"].includes(normalizeInvoiceRole(role));
}

function isInvoiceClerk(role) {
  return normalizeInvoiceRole(role) === "clerk_admin";
}

function isInvoiceSupervisor(role) {
  return normalizeInvoiceRole(role) === "supervisor";
}

function isInvoiceDivisionAdmin(role) {
  return normalizeInvoiceRole(role) === "division_admin";
}

function escapeInvoiceHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setInvoiceText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function formatInvoiceDate(value) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return date.toLocaleString();
}

function getInvoiceStatusLabel(status) {
  const labels = {
    sent_to_clerk: "Sent to Clerk Admin",
    accepted_by_clerk: "Accepted by Clerk Admin",
    sent_to_supervisor: "Sent to Supervisor",
    assigned_to_division: "Assigned to Division Admin",
    accepted_by_division: "Accepted by Division Admin",
    returned_to_clerk: "Returned to Clerk Admin",
    completed: "Completed Report"
  };

  return labels[status] || status || "-";
}

function getInvoiceRoleInstruction(role) {
  const normalizedRole = normalizeInvoiceRole(role);

  if (isInvoiceHeadAdmin(normalizedRole)) {
    return "Create an invoice subject, assign a Clerk Admin, then send it for acceptance.";
  }

  if (isInvoiceClerk(normalizedRole)) {
    return "Accept invoices from Head Admin, forward to Supervisor, then confirm returned validations.";
  }

  if (isInvoiceSupervisor(normalizedRole)) {
    return "Assign a Division Admin to validate invoices sent by the Clerk Admin.";
  }

  if (isInvoiceDivisionAdmin(normalizedRole)) {
    return "Accept assigned invoices, validate them, then return them to Clerk Admin.";
  }

  return "You can view invoice reports, but this role has no routing action yet.";
}

async function invoiceFetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers || {})
    }
  });

  const rawText = await response.text();
  let data = {};

  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch (error) {
    console.error("Invoice API raw response:", rawText);
    throw new Error("Invoice API did not return valid JSON.");
  }

  if (!response.ok || data.success === false) {
    throw new Error(data.message || "Invoice request failed.");
  }

  return data;
}

async function loadInvoiceAssignableAccounts() {
  try {
    const [clerksData, divisionData] = await Promise.all([
      invoiceFetchJson(getInvoiceApiUrl("/users/clerk-admins")),
      invoiceFetchJson(getInvoiceApiUrl("/users/division-admins"))
    ]);

    invoiceClerkAccounts = Array.isArray(clerksData.users) ? clerksData.users : [];
    invoiceDivisionAdminAccounts = Array.isArray(divisionData.users) ? divisionData.users : [];

    populateInvoiceAssignmentDropdowns();
  } catch (error) {
    console.error("Failed to load invoice assignable accounts:", error);
    invoiceClerkAccounts = [];
    invoiceDivisionAdminAccounts = [];
    populateInvoiceAssignmentDropdowns();
  }
}

async function loadInvoiceRecords() {
  const user = getInvoiceCurrentUser();

  if (!user.id || !user.role) {
    invoiceRecords = [];
    return;
  }

  try {
    const data = await invoiceFetchJson(
      getInvoiceApiUrl(`?user_id=${encodeURIComponent(user.id)}&role=${encodeURIComponent(user.role)}`)
    );

    invoiceRecords = Array.isArray(data.invoices) ? data.invoices : [];
  } catch (error) {
    console.error("Failed to load invoices:", error);
    invoiceRecords = [];
  }
}

async function reloadInvoiceWorkflow() {
  await loadInvoiceAssignableAccounts();
  await loadInvoiceRecords();
  renderInvoiceWorkflow();
}

function getInvoiceVisibleQueue(role) {
  const normalizedRole = normalizeInvoiceRole(role);

  return invoiceRecords.filter((invoice) => {
    if (invoice.status === "completed") return false;

    if (isInvoiceClerk(normalizedRole)) {
      return ["sent_to_clerk", "accepted_by_clerk", "returned_to_clerk"].includes(invoice.status);
    }

    if (isInvoiceSupervisor(normalizedRole)) {
      return invoice.status === "sent_to_supervisor";
    }

    if (isInvoiceDivisionAdmin(normalizedRole)) {
      return ["assigned_to_division", "accepted_by_division"].includes(invoice.status);
    }

    if (isInvoiceHeadAdmin(normalizedRole)) {
      return true;
    }

    return false;
  });
}

function getInvoiceHandler(invoice) {
  if (!invoice) return "-";

  if (invoice.status === "sent_to_clerk") return invoice.assignedClerkName || "Clerk Admin";
  if (invoice.status === "accepted_by_clerk") return invoice.assignedClerkName || "Clerk Admin";
  if (invoice.status === "sent_to_supervisor") return "Supervisor";
  if (invoice.status === "assigned_to_division") return invoice.assignedDivisionAdminName || "Division Admin";
  if (invoice.status === "accepted_by_division") return invoice.assignedDivisionAdminName || "Division Admin";
  if (invoice.status === "returned_to_clerk") return invoice.assignedClerkName || "Clerk Admin";
  if (invoice.status === "completed") return invoice.confirmedByName || invoice.assignedClerkName || "Clerk Admin";

  return "-";
}

function renderInvoiceWorkflow() {
  const user = getInvoiceCurrentUser();
  const roleLabel = formatInvoiceRole(user.role);
  const completed = invoiceRecords.filter((invoice) => invoice.status === "completed");
  const queue = getInvoiceVisibleQueue(user.role);

  const roleLabelEl = document.getElementById("invoiceCurrentRoleLabel");
  const instructionEl = document.getElementById("invoiceRoleInstruction");
  const createPanel = document.getElementById("invoiceCreatePanel");

  if (roleLabelEl) {
    roleLabelEl.textContent = `${roleLabel}${user.name ? " • " + user.name : ""}`;
  }

  if (instructionEl) {
    instructionEl.textContent = getInvoiceRoleInstruction(user.role);
  }

  if (createPanel) {
    createPanel.classList.toggle("hidden", !isInvoiceHeadAdmin(user.role));
  }

  setInvoiceText("invoiceTotalCount", invoiceRecords.length);
  setInvoiceText("invoiceMyActionCount", queue.length);
  setInvoiceText("invoiceCompletedCount", completed.length);

  renderInvoiceQueue(queue, user.role);
  renderInvoiceHistory();
  populateInvoiceAssignmentDropdowns();
}

function renderInvoiceQueue(queue, role) {
  const tbody = document.getElementById("invoiceQueueTableBody");
  if (!tbody) return;

  if (!queue.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="invoice-empty-cell">No invoices waiting for your action.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = queue.map((invoice) => `
    <tr>
      <td><strong>${escapeInvoiceHtml(invoice.trackingNo || invoice.tracking_no)}</strong></td>
      <td>${escapeInvoiceHtml(invoice.subject)}</td>
      <td><span class="invoice-status-pill">${escapeInvoiceHtml(getInvoiceStatusLabel(invoice.status))}</span></td>
      <td>${escapeInvoiceHtml(getInvoiceHandler(invoice))}</td>
      <td>${escapeInvoiceHtml(formatInvoiceDate(invoice.updatedAt || invoice.updated_at))}</td>
      <td>${renderInvoiceActionButton(invoice, role)}</td>
    </tr>
  `).join("");

  tbody.querySelectorAll("[data-invoice-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      handleInvoiceAction(btn.dataset.invoiceAction, btn.dataset.invoiceId);
    });
  });
}

function buildInvoiceAccountOptions(accounts, placeholder) {
  if (!accounts.length) {
    return `<option value="">No account found</option>`;
  }

  return `
    <option value="">${placeholder}</option>
    ${accounts
      .map((account) => `
        <option
          value="${escapeInvoiceHtml(account.id)}"
          data-full-name="${escapeInvoiceHtml(account.full_name || account.fullName || account.username)}">
          ${escapeInvoiceHtml(account.full_name || account.fullName || account.username)}
        </option>
      `)
      .join("")}
  `;
}

function buildDivisionAdminSelect(invoiceId) {
  const disabled = invoiceDivisionAdminAccounts.length ? "" : "disabled";

  return `
    <select class="invoice-inline-select" data-division-select="${invoiceId}" ${disabled}>
      ${buildInvoiceAccountOptions(invoiceDivisionAdminAccounts, "Select Division Admin")}
    </select>
  `;
}

function renderInvoiceActionButton(invoice, role) {
  const normalizedRole = normalizeInvoiceRole(role);

  if (isInvoiceClerk(normalizedRole) && invoice.status === "sent_to_clerk") {
    return `<button type="button" class="invoice-action-btn" data-invoice-action="accept_clerk" data-invoice-id="${invoice.id}">Accept</button>`;
  }

  if (isInvoiceClerk(normalizedRole) && invoice.status === "accepted_by_clerk") {
    return `<button type="button" class="invoice-action-btn" data-invoice-action="send_supervisor" data-invoice-id="${invoice.id}">Send to Supervisor</button>`;
  }

  if (isInvoiceSupervisor(normalizedRole) && invoice.status === "sent_to_supervisor") {
    return `
      <div class="invoice-inline-assign">
        ${buildDivisionAdminSelect(invoice.id)}
        <button type="button" class="invoice-action-btn" data-invoice-action="assign_division" data-invoice-id="${invoice.id}">
          Assign
        </button>
      </div>
    `;
  }

  if (isInvoiceDivisionAdmin(normalizedRole) && invoice.status === "assigned_to_division") {
    return `<button type="button" class="invoice-action-btn" data-invoice-action="accept_division" data-invoice-id="${invoice.id}">Accept</button>`;
  }

  if (isInvoiceDivisionAdmin(normalizedRole) && invoice.status === "accepted_by_division") {
    return `<button type="button" class="invoice-action-btn" data-invoice-action="validate_return" data-invoice-id="${invoice.id}">Validate & Return</button>`;
  }

  if (isInvoiceClerk(normalizedRole) && invoice.status === "returned_to_clerk") {
    return `<button type="button" class="invoice-action-btn" data-invoice-action="confirm_report" data-invoice-id="${invoice.id}">Confirm Report</button>`;
  }

  return `<button type="button" class="invoice-view-btn" data-invoice-action="view" data-invoice-id="${invoice.id}">View</button>`;
}

function renderInvoiceHistory() {
  const tbody = document.getElementById("invoiceHistoryTableBody");
  const searchInput = document.getElementById("invoiceHistorySearchInput");

  if (!tbody) return;

  const keyword = String(searchInput?.value || "").toLowerCase().trim();

  let completed = invoiceRecords.filter((invoice) => invoice.status === "completed");

  if (keyword) {
    completed = completed.filter((invoice) => {
      const haystack = [
        invoice.trackingNo,
        invoice.tracking_no,
        invoice.subject,
        invoice.createdByName,
        invoice.assignedClerkName,
        invoice.supervisorName,
        invoice.assignedDivisionAdminName,
        invoice.confirmedByName
      ].join(" ").toLowerCase();

      return haystack.includes(keyword);
    });
  }

  if (!completed.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="invoice-empty-cell">No confirmed invoice reports yet.</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = completed.map((invoice) => `
    <tr>
      <td><strong>${escapeInvoiceHtml(invoice.trackingNo || invoice.tracking_no)}</strong></td>
      <td>${escapeInvoiceHtml(invoice.subject)}</td>
      <td>${escapeInvoiceHtml(invoice.createdByName || "-")}</td>
      <td>${escapeInvoiceHtml(invoice.assignedClerkName || "-")}</td>
      <td>${escapeInvoiceHtml(invoice.supervisorName || "-")}</td>
      <td>${escapeInvoiceHtml(invoice.assignedDivisionAdminName || "-")}</td>
      <td>${escapeInvoiceHtml(formatInvoiceDate(invoice.completedAt || invoice.completed_at))}</td>
      <td>
        <button type="button" class="invoice-view-btn" data-invoice-action="view" data-invoice-id="${invoice.id}">
          View
        </button>
      </td>
    </tr>
  `).join("");

  tbody.querySelectorAll("[data-invoice-action='view']").forEach((btn) => {
    btn.addEventListener("click", () => openInvoiceTrackingModal(btn.dataset.invoiceId));
  });
}

async function handleInvoiceAction(action, invoiceId) {
  if (action === "view") {
    openInvoiceTrackingModal(invoiceId);
    return;
  }

  const user = getInvoiceCurrentUser();

  if (!user.id) {
    alert("User session missing. Please log in again.");
    return;
  }

  let url = "";
  let body = { user_id: user.id };

  if (action === "accept_clerk") {
    url = getInvoiceApiUrl(`/${invoiceId}/accept-clerk`);
  }

  if (action === "send_supervisor") {
    url = getInvoiceApiUrl(`/${invoiceId}/send-supervisor`);
  }

  if (action === "assign_division") {
    const divisionSelect = document.querySelector(`[data-division-select="${invoiceId}"]`);
    const selectedDivisionId = divisionSelect?.value?.trim();

    if (!selectedDivisionId) {
      alert("Please select a registered Division Admin account.");
      divisionSelect?.focus();
      return;
    }

    url = getInvoiceApiUrl(`/${invoiceId}/assign-division`);
    body.assigned_division_admin_id = selectedDivisionId;
  }

  if (action === "accept_division") {
    url = getInvoiceApiUrl(`/${invoiceId}/accept-division`);
  }

  if (action === "validate_return") {
    url = getInvoiceApiUrl(`/${invoiceId}/validate-return`);
  }

  if (action === "confirm_report") {
    url = getInvoiceApiUrl(`/${invoiceId}/confirm`);
  }

  if (!url) return;

  try {
    await invoiceFetchJson(url, {
      method: "POST",
      body: JSON.stringify(body)
    });

    await reloadInvoiceWorkflow();
  } catch (error) {
    console.error("Invoice action failed:", error);
    alert(error.message || "Invoice action failed.");
  }
}

async function handleInvoiceCreate(event) {
  event.preventDefault();

  const user = getInvoiceCurrentUser();

  if (!isInvoiceHeadAdmin(user.role)) {
    alert("Only Head Admin can create invoice subjects.");
    return;
  }

  const subject = document.getElementById("invoiceSubjectInput")?.value.trim();
  const description = document.getElementById("invoiceDescriptionInput")?.value.trim();
  const clerkSelect = document.getElementById("invoiceAssignedClerkSelect");
  const assignedClerkId = clerkSelect?.value.trim();

  if (!subject || !description || !assignedClerkId) {
    alert("Please complete subject, details, and select a registered Clerk Admin account.");
    return;
  }

  try {
    await invoiceFetchJson(getInvoiceApiUrl(""), {
      method: "POST",
      body: JSON.stringify({
        subject,
        description,
        assigned_clerk_id: assignedClerkId,
        created_by: user.id
      })
    });

    event.target.reset();
    await reloadInvoiceWorkflow();
  } catch (error) {
    console.error("Create invoice failed:", error);
    alert(error.message || "Failed to create invoice.");
  }
}

function populateInvoiceAssignmentDropdowns() {
  const clerkSelect = document.getElementById("invoiceAssignedClerkSelect");
  if (!clerkSelect) return;

  const currentValue = clerkSelect.value;

  if (!invoiceClerkAccounts.length) {
    clerkSelect.innerHTML = `<option value="">No Clerk Admin account found</option>`;
    clerkSelect.disabled = true;
    return;
  }

  clerkSelect.disabled = false;

  clerkSelect.innerHTML = buildInvoiceAccountOptions(invoiceClerkAccounts, "Select Clerk Admin");

  if (currentValue && invoiceClerkAccounts.some((account) => String(account.id) === String(currentValue))) {
    clerkSelect.value = currentValue;
  }
}

async function openInvoiceTrackingModal(invoiceId) {
  const modal = document.getElementById("invoiceTrackingModal");

  if (!modal) return;

  try {
    const data = await invoiceFetchJson(getInvoiceApiUrl(`/${invoiceId}`));
    const invoice = data.invoice;

    if (!invoice) return;

    setInvoiceText("invoiceTrackingTitle", `${invoice.trackingNo || invoice.tracking_no} Tracking Details`);
    setInvoiceText("invoiceTrackingSubtitle", "Full validation and routing trail.");
    setInvoiceText("invoiceViewTrackingNo", invoice.trackingNo || invoice.tracking_no);
    setInvoiceText("invoiceViewStatus", getInvoiceStatusLabel(invoice.status));
    setInvoiceText("invoiceViewHandler", getInvoiceHandler(invoice));
    setInvoiceText("invoiceViewSubject", invoice.subject);
    setInvoiceText("invoiceViewDescription", invoice.description);

    const timeline = document.getElementById("invoiceTrackingTimeline");

    if (timeline) {
      timeline.innerHTML = invoice.logs?.length
        ? invoice.logs.map((log) => `
          <div class="invoice-timeline-item">
            <div class="invoice-timeline-dot"></div>
            <div>
              <strong>${escapeInvoiceHtml(log.message)}</strong>
              <span>${escapeInvoiceHtml(formatInvoiceRole(log.action_by_role))} • ${escapeInvoiceHtml(log.actionByName || "-")} • ${escapeInvoiceHtml(formatInvoiceDate(log.createdAt || log.created_at))}</span>
            </div>
          </div>
        `).join("")
        : `<div class="invoice-empty-cell">No tracking logs available.</div>`;
    }

    modal.classList.remove("hidden");
  } catch (error) {
    console.error("Open invoice tracking failed:", error);
    alert(error.message || "Failed to load invoice tracking.");
  }
}

function closeInvoiceTrackingModal() {
  const modal = document.getElementById("invoiceTrackingModal");
  if (modal) modal.classList.add("hidden");
}

function setupInvoiceWorkflow() {
  document.getElementById("invoiceCreateForm")?.addEventListener("submit", handleInvoiceCreate);

  document.getElementById("refreshInvoiceWorkflowBtn")?.addEventListener("click", async () => {
    await reloadInvoiceWorkflow();
  });

  document.getElementById("invoiceHistorySearchInput")?.addEventListener("input", renderInvoiceHistory);
  document.getElementById("closeInvoiceTrackingBtn")?.addEventListener("click", closeInvoiceTrackingModal);
  document.getElementById("invoiceTrackingOverlay")?.addEventListener("click", closeInvoiceTrackingModal);

  reloadInvoiceWorkflow();

  document.getElementById("openIncomingInvoiceBtn")?.addEventListener("click", () => {
    setTimeout(reloadInvoiceWorkflow, 80);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  if (window.__webAdminSessionReady) {
    setupInvoiceWorkflow();
    return;
  }
  document.addEventListener("web-admin-session-ready", setupInvoiceWorkflow, {
    once: true
  });
});

window.reloadInvoiceWorkflow = reloadInvoiceWorkflow;
window.renderInvoiceWorkflow = renderInvoiceWorkflow;
window.openInvoiceTrackingModal = openInvoiceTrackingModal;
window.closeInvoiceTrackingModal = closeInvoiceTrackingModal;
/* =========================================================
   INVOICE WORKFLOW CUSTOM DROPDOWN UI - FULL INTEGRATED
   Added for:
   - Assign Clerk Admin dropdown
   - Assign Division Admin dropdown
   - Any future invoice workflow select inside invoice modals

   Notes:
   - Original native <select> remains active behind the custom UI.
   - Existing invoice logic still reads the real select value.
   - Dropdown menu is rendered as a portal to avoid being clipped by modal/table scroll.
========================================================= */

let activeInvoiceCustomSelect = null;
let activeInvoicePortalMenu = null;

function isInvoiceSelectTarget(select) {
  if (!select || select.tagName !== "SELECT") return false;

  return Boolean(
    select.closest("#incomingInvoiceModal") ||
    select.closest("#invoiceTrackingModal") ||
    select.closest(".invoice-workflow-modal") ||
    select.closest(".invoice-modal") ||
    select.classList.contains("invoice-inline-select") ||
    select.id === "invoiceAssignedClerkSelect"
  );
}

function getInvoiceSelectLabel(select) {
  if (!select) return "-";

  const selectedOption = select.options[select.selectedIndex];
  return selectedOption ? selectedOption.textContent.trim() : "-";
}

function closeInvoiceCustomDropdown() {
  if (activeInvoicePortalMenu) {
    activeInvoicePortalMenu.remove();
    activeInvoicePortalMenu = null;
  }

  if (activeInvoiceCustomSelect) {
    activeInvoiceCustomSelect.classList.remove("open");

    const btn = activeInvoiceCustomSelect.querySelector(".invoice-custom-select-btn");
    if (btn) btn.setAttribute("aria-expanded", "false");

    activeInvoiceCustomSelect = null;
  }
}

function syncInvoiceCustomDropdown(select) {
  if (!select || !select.id) return;

  const wrapper = document.querySelector(
    `.invoice-custom-select[data-for="${select.id}"]`
  );

  if (!wrapper) return;

  const label = wrapper.querySelector(".invoice-custom-select-label");
  if (label) label.textContent = getInvoiceSelectLabel(select);

  const btn = wrapper.querySelector(".invoice-custom-select-btn");
  if (btn) {
    btn.disabled = !!select.disabled;
    btn.classList.toggle("is-disabled", !!select.disabled);
  }
}

function positionInvoicePortalMenu(wrapper, portal) {
  if (!wrapper || !portal) return;

  const button = wrapper.querySelector(".invoice-custom-select-btn");
  if (!button) return;

  const rect = button.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;

  const menuWidth = Math.max(rect.width, 230);
  const estimatedHeight = Math.min(portal.scrollHeight || 280, 280);

  let left = rect.left;
  let top = rect.bottom + 8;

  if (left + menuWidth > viewportWidth - 12) {
    left = viewportWidth - menuWidth - 12;
  }

  if (top + estimatedHeight > viewportHeight - 12) {
    top = Math.max(12, rect.top - estimatedHeight - 8);
  }

  portal.style.left = `${Math.max(12, left)}px`;
  portal.style.top = `${Math.max(12, top)}px`;
  portal.style.width = `${menuWidth}px`;
}

function openInvoiceCustomDropdown(select, wrapper) {
  closeInvoiceCustomDropdown();

  if (!select || !wrapper || select.disabled) return;

  wrapper.classList.add("open");

  const btn = wrapper.querySelector(".invoice-custom-select-btn");
  if (btn) btn.setAttribute("aria-expanded", "true");

  const portal = document.createElement("div");
  portal.className = "invoice-custom-select-portal-menu";
  portal.setAttribute("role", "listbox");
  portal.dataset.for = select.id;

  Array.from(select.options).forEach((option) => {
    const optionBtn = document.createElement("button");
    optionBtn.type = "button";
    optionBtn.className = "invoice-custom-select-option";
    optionBtn.dataset.value = option.value;
    optionBtn.textContent = option.textContent;
    optionBtn.setAttribute("role", "option");

    const isActive = option.value === select.value;
    optionBtn.classList.toggle("active", isActive);
    optionBtn.setAttribute("aria-selected", isActive ? "true" : "false");

    if (option.disabled) {
      optionBtn.disabled = true;
      optionBtn.classList.add("is-disabled");
    }

    optionBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (option.disabled) return;

      select.value = option.value;

      select.dispatchEvent(
        new Event("change", {
          bubbles: true
        })
      );

      syncInvoiceCustomDropdown(select);
      closeInvoiceCustomDropdown();
    });

    portal.appendChild(optionBtn);
  });

  document.body.appendChild(portal);

  activeInvoiceCustomSelect = wrapper;
  activeInvoicePortalMenu = portal;

  positionInvoicePortalMenu(wrapper, portal);

  requestAnimationFrame(() => {
    positionInvoicePortalMenu(wrapper, portal);
  });
}

function buildInvoiceCustomDropdown(select) {
  if (!isInvoiceSelectTarget(select)) return;

  if (!select.id) {
    select.id = `invoiceSelect_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  const existingWrapper = document.querySelector(
    `.invoice-custom-select[data-for="${select.id}"]`
  );

  if (existingWrapper) {
    select.classList.add("invoice-native-select-hidden");
    syncInvoiceCustomDropdown(select);
    return;
  }

  select.classList.add("invoice-native-select-hidden");

  const wrapper = document.createElement("div");
  wrapper.className = "invoice-custom-select";
  wrapper.dataset.for = select.id;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "invoice-custom-select-btn";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");

  button.innerHTML = `
    <span class="invoice-custom-select-label">${getInvoiceSelectLabel(select)}</span>
    <span class="invoice-custom-select-arrow">⌄</span>
  `;

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (select.disabled) return;

    if (wrapper.classList.contains("open")) {
      closeInvoiceCustomDropdown();
      return;
    }

    openInvoiceCustomDropdown(select, wrapper);
  });

  wrapper.appendChild(button);
  select.insertAdjacentElement("afterend", wrapper);

  select.addEventListener("change", () => {
    syncInvoiceCustomDropdown(select);
  });

  syncInvoiceCustomDropdown(select);
}

function setupInvoiceCustomDropdowns(root = document) {
  root.querySelectorAll("select").forEach((select) => {
    if (isInvoiceSelectTarget(select)) {
      buildInvoiceCustomDropdown(select);
    }
  });
}

function observeInvoiceCustomDropdowns() {
  if (window.__invoiceCustomDropdownObserverBound === true) return;
  window.__invoiceCustomDropdownObserverBound = true;

  const observer = new MutationObserver((mutations) => {
    let shouldSetup = false;

    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;

        if (
          node.matches?.("select") ||
          node.querySelector?.("select") ||
          node.id === "incomingInvoiceModal" ||
          node.closest?.("#incomingInvoiceModal")
        ) {
          shouldSetup = true;
        }
      });
    });

    if (shouldSetup) {
      setTimeout(() => setupInvoiceCustomDropdowns(), 40);
      setTimeout(() => setupInvoiceCustomDropdowns(), 160);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  window.invoiceCustomDropdownObserver = observer;
}

/*
  After invoice dropdown options are repopulated, refresh the custom UI.
*/
if (typeof populateInvoiceAssignmentDropdowns === "function" && !window.__populateInvoiceAssignmentDropdownsCustomWrapped) {
  window.__populateInvoiceAssignmentDropdownsCustomWrapped = true;

  const originalPopulateInvoiceAssignmentDropdowns = populateInvoiceAssignmentDropdowns;

  populateInvoiceAssignmentDropdowns = function patchedPopulateInvoiceAssignmentDropdowns(...args) {
    const result = originalPopulateInvoiceAssignmentDropdowns.apply(this, args);

    setTimeout(() => setupInvoiceCustomDropdowns(), 20);
    setTimeout(() => {
      document.querySelectorAll("#incomingInvoiceModal select, .invoice-inline-select, #invoiceAssignedClerkSelect")
        .forEach(syncInvoiceCustomDropdown);
    }, 60);

    return result;
  };

  window.populateInvoiceAssignmentDropdowns = populateInvoiceAssignmentDropdowns;
}

/*
  After queue is rendered, convert dynamically generated Division Admin selects.
*/
if (typeof renderInvoiceQueue === "function" && !window.__renderInvoiceQueueCustomDropdownWrapped) {
  window.__renderInvoiceQueueCustomDropdownWrapped = true;

  const originalRenderInvoiceQueue = renderInvoiceQueue;

  renderInvoiceQueue = function patchedRenderInvoiceQueue(...args) {
    const result = originalRenderInvoiceQueue.apply(this, args);

    setTimeout(() => setupInvoiceCustomDropdowns(), 20);
    setTimeout(() => setupInvoiceCustomDropdowns(), 120);

    return result;
  };

  window.renderInvoiceQueue = renderInvoiceQueue;
}

/*
  After workflow render/reload, refresh custom selects.
*/
if (typeof renderInvoiceWorkflow === "function" && !window.__renderInvoiceWorkflowCustomDropdownWrapped) {
  window.__renderInvoiceWorkflowCustomDropdownWrapped = true;

  const originalRenderInvoiceWorkflow = renderInvoiceWorkflow;

  renderInvoiceWorkflow = function patchedRenderInvoiceWorkflow(...args) {
    const result = originalRenderInvoiceWorkflow.apply(this, args);

    setTimeout(() => setupInvoiceCustomDropdowns(), 30);
    setTimeout(() => setupInvoiceCustomDropdowns(), 150);

    return result;
  };

  window.renderInvoiceWorkflow = renderInvoiceWorkflow;
}

if (typeof reloadInvoiceWorkflow === "function" && !window.__reloadInvoiceWorkflowCustomDropdownWrapped) {
  window.__reloadInvoiceWorkflowCustomDropdownWrapped = true;

  const originalReloadInvoiceWorkflow = reloadInvoiceWorkflow;

  reloadInvoiceWorkflow = async function patchedReloadInvoiceWorkflow(...args) {
    const result = await originalReloadInvoiceWorkflow.apply(this, args);

    setTimeout(() => setupInvoiceCustomDropdowns(), 40);
    setTimeout(() => setupInvoiceCustomDropdowns(), 180);

    return result;
  };

  window.reloadInvoiceWorkflow = reloadInvoiceWorkflow;
}

document.addEventListener("click", (event) => {
  const clickedCustomSelect = event.target.closest(".invoice-custom-select");
  const clickedPortal = event.target.closest(".invoice-custom-select-portal-menu");

  if (!clickedCustomSelect && !clickedPortal) {
    closeInvoiceCustomDropdown();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeInvoiceCustomDropdown();
  }
});

window.addEventListener("resize", () => {
  if (activeInvoiceCustomSelect && activeInvoicePortalMenu) {
    positionInvoicePortalMenu(activeInvoiceCustomSelect, activeInvoicePortalMenu);
  }
});

window.addEventListener("scroll", () => {
  if (activeInvoiceCustomSelect && activeInvoicePortalMenu) {
    positionInvoicePortalMenu(activeInvoiceCustomSelect, activeInvoicePortalMenu);
  }
}, true);

document.addEventListener("DOMContentLoaded", () => {
  setupInvoiceCustomDropdowns();
  observeInvoiceCustomDropdowns();

  setTimeout(setupInvoiceCustomDropdowns, 250);
  setTimeout(setupInvoiceCustomDropdowns, 800);
  setTimeout(setupInvoiceCustomDropdowns, 1400);
});

window.setupInvoiceCustomDropdowns = setupInvoiceCustomDropdowns;
window.closeInvoiceCustomDropdown = closeInvoiceCustomDropdown;
window.syncInvoiceCustomDropdown = syncInvoiceCustomDropdown;
