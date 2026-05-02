/* =========================
   ADMIN INVOICE WORKFLOW
   Frontend workflow shell using localStorage.

   Real backend/database version should replace localStorage with API calls.
========================= */

const INVOICE_STORAGE_KEY = "wmo_incoming_invoice_workflow_v1";
let invoiceRecords = [];
let invoiceClerkAccounts = [];
let invoiceDivisionAdminAccounts = [];

function getInvoiceStoredUser() {
  try {
    const raw = localStorage.getItem("webUser");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function normalizeInvoiceRole(role) {
  return String(role || "").trim().toLowerCase().replace(/\s+/g, "_");
}


function getInvoiceApiBase() {
  if (typeof getAppApiBase === "function") {
    return getAppApiBase();
  }

  if (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) {
    return window.APP_CONFIG.API_BASE_URL;
  }

  return "";
}

function getInvoiceAccountsApiUrl() {
  if (typeof getAccountsApiUrl === "function") {
    return getAccountsApiUrl();
  }

  const base = getInvoiceApiBase();
  return base ? `${base}/web-users` : "";
}

function getInvoiceAccountFullName(account) {
  return (
    account?.full_name ||
    account?.fullName ||
    account?.name ||
    account?.username ||
    ""
  ).trim();
}

function isActiveInvoiceAccount(account) {
  const status = String(account?.status || "active").toLowerCase().trim();
  return !["deactivated", "inactive", "suspended"].includes(status);
}

function normalizeInvoiceAccountRole(account) {
  return normalizeInvoiceRole(account?.role || account?.admin_role || "");
}

function extractInvoiceAccounts(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.accounts)) return payload.accounts;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.users)) return payload.users;
  return [];
}

function getInvoiceAccountsFromExistingState() {
  try {
    if (typeof allWebUsers !== "undefined" && Array.isArray(allWebUsers)) {
      return allWebUsers;
    }
  } catch {
    // ignore unavailable lexical global
  }

  if (Array.isArray(window.allWebUsers)) {
    return window.allWebUsers;
  }

  return [];
}

async function loadInvoiceClerkAccounts() {
  const existingAccounts = getInvoiceAccountsFromExistingState();

  if (existingAccounts.length) {
    invoiceClerkAccounts = existingAccounts
      .filter((account) => normalizeInvoiceAccountRole(account) === "clerk_admin")
      .filter(isActiveInvoiceAccount)
      .map((account) => ({
        id: account.id || "",
        fullName: getInvoiceAccountFullName(account),
        username: account.username || ""
      }))
      .filter((account) => account.fullName);

    populateInvoiceAssignmentDropdowns();
    return invoiceClerkAccounts;
  }

  const accountsUrl = getInvoiceAccountsApiUrl();

  if (!accountsUrl) {
    invoiceClerkAccounts = [];
    populateInvoiceAssignmentDropdowns();
    return invoiceClerkAccounts;
  }

  try {
    const response = await fetch(accountsUrl, {
      headers: { Accept: "application/json" }
    });

    const rawText = await response.text();
    let data = {};

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      throw new Error("Accounts API did not return valid JSON.");
    }

    if (!response.ok) {
      throw new Error(data.message || "Failed to load Clerk Admin accounts.");
    }

    const accounts = extractInvoiceAccounts(data);

    invoiceClerkAccounts = accounts
      .filter((account) => normalizeInvoiceAccountRole(account) === "clerk_admin")
      .filter(isActiveInvoiceAccount)
      .map((account) => ({
        id: account.id || "",
        fullName: getInvoiceAccountFullName(account),
        username: account.username || ""
      }))
      .filter((account) => account.fullName);

    populateInvoiceAssignmentDropdowns();
    return invoiceClerkAccounts;
  } catch (error) {
    console.error("Unable to load Clerk Admin accounts:", error);
    invoiceClerkAccounts = [];
    populateInvoiceAssignmentDropdowns();
    return invoiceClerkAccounts;
  }
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
  if (!user) return { id: null, name: "Unknown User", username: "", role: "" };

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

function loadInvoiceRecords() {
  try {
    const raw = localStorage.getItem(INVOICE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    invoiceRecords = Array.isArray(parsed) ? parsed : [];
  } catch {
    invoiceRecords = [];
  }
}

function saveInvoiceRecords() {
  localStorage.setItem(INVOICE_STORAGE_KEY, JSON.stringify(invoiceRecords));
}

function generateInvoiceTrackingNo() {
  const year = new Date().getFullYear();
  return `INV-${year}-${String(invoiceRecords.length + 1).padStart(5, "0")}`;
}

function formatInvoiceDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
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
  if (isInvoiceHeadAdmin(role)) return "Create an invoice subject, assign a Clerk Admin, then send it for acceptance.";
  if (isInvoiceClerk(role)) return "Accept invoices from Head Admin, forward to Supervisor, then confirm returned validations.";
  if (isInvoiceSupervisor(role)) return "Assign a Division Admin to validate invoices sent by the Clerk Admin.";
  if (isInvoiceDivisionAdmin(role)) return "Accept assigned invoices, validate them, then return them to Clerk Admin.";
  return "You can view invoice reports, but this role has no routing action yet.";
}

function escapeInvoiceHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function addInvoiceLog(invoice, actionType, message, toUser = "", toRole = "") {
  const user = getInvoiceCurrentUser();
  invoice.logs.push({
    id: `log-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    actionType,
    message,
    fromUserId: user.id,
    fromUserName: user.name,
    fromRole: user.role,
    toUserName: toUser,
    toRole,
    createdAt: new Date().toISOString()
  });
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
      return invoice.createdByRole === normalizedRole || isInvoiceHeadAdmin(invoice.createdByRole);
    }

    return false;
  });
}

function findInvoiceById(invoiceId) {
  return invoiceRecords.find((invoice) => String(invoice.id) === String(invoiceId));
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

function setInvoiceText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function renderInvoiceWorkflow() {
  loadInvoiceRecords();

  const user = getInvoiceCurrentUser();
  const queue = getInvoiceVisibleQueue(user.role);
  const completed = invoiceRecords.filter((invoice) => invoice.status === "completed");
  const createPanel = document.getElementById("invoiceCreatePanel");

  setInvoiceText("invoiceCurrentRoleLabel", `${formatInvoiceRole(user.role)}${user.name ? " • " + user.name : ""}`);
  setInvoiceText("invoiceRoleInstruction", getInvoiceRoleInstruction(user.role));
  setInvoiceText("invoiceTotalCount", invoiceRecords.length);
  setInvoiceText("invoiceMyActionCount", queue.length);
  setInvoiceText("invoiceCompletedCount", completed.length);

  if (createPanel) createPanel.classList.toggle("hidden", !isInvoiceHeadAdmin(user.role));

  populateInvoiceAssignmentDropdowns();
  renderInvoiceQueue(queue, user.role);
  renderInvoiceHistory();
}

function renderInvoiceQueue(queue, role) {
  const tbody = document.getElementById("invoiceQueueTableBody");
  if (!tbody) return;

  if (!queue.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="invoice-empty-cell">No invoices waiting for your action.</td></tr>`;
    return;
  }

  tbody.innerHTML = queue.map((invoice) => `
    <tr>
      <td><strong>${escapeInvoiceHtml(invoice.trackingNo)}</strong></td>
      <td>${escapeInvoiceHtml(invoice.subject)}</td>
      <td><span class="invoice-status-pill">${escapeInvoiceHtml(getInvoiceStatusLabel(invoice.status))}</span></td>
      <td>${escapeInvoiceHtml(getInvoiceHandler(invoice))}</td>
      <td>${escapeInvoiceHtml(formatInvoiceDate(invoice.updatedAt))}</td>
      <td>${renderInvoiceActionButton(invoice, role)}</td>
    </tr>
  `).join("");

  tbody.querySelectorAll("[data-invoice-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleInvoiceAction(btn.dataset.invoiceAction, btn.dataset.invoiceId));
  });
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
    completed = completed.filter((invoice) => [
      invoice.trackingNo,
      invoice.subject,
      invoice.createdByName,
      invoice.assignedClerkName,
      invoice.supervisorName,
      invoice.assignedDivisionAdminName,
      invoice.confirmedByName
    ].join(" ").toLowerCase().includes(keyword));
  }

  if (!completed.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="invoice-empty-cell">No confirmed invoice reports yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = completed.map((invoice) => `
    <tr>
      <td><strong>${escapeInvoiceHtml(invoice.trackingNo)}</strong></td>
      <td>${escapeInvoiceHtml(invoice.subject)}</td>
      <td>${escapeInvoiceHtml(invoice.createdByName || "-")}</td>
      <td>${escapeInvoiceHtml(invoice.assignedClerkName || "-")}</td>
      <td>${escapeInvoiceHtml(invoice.supervisorName || "-")}</td>
      <td>${escapeInvoiceHtml(invoice.assignedDivisionAdminName || "-")}</td>
      <td>${escapeInvoiceHtml(formatInvoiceDate(invoice.completedAt))}</td>
      <td><button type="button" class="invoice-view-btn" data-invoice-action="view" data-invoice-id="${invoice.id}">View</button></td>
    </tr>
  `).join("");

  tbody.querySelectorAll("[data-invoice-action='view']").forEach((btn) => {
    btn.addEventListener("click", () => openInvoiceTrackingModal(btn.dataset.invoiceId));
  });
}

function handleInvoiceAction(action, invoiceId) {
  if (action === "view") {
    openInvoiceTrackingModal(invoiceId);
    return;
  }

  const invoice = findInvoiceById(invoiceId);
  const user = getInvoiceCurrentUser();
  if (!invoice) return;

  if (action === "accept_clerk") {
    invoice.status = "accepted_by_clerk";
    invoice.acceptedByClerkName = user.name;
    addInvoiceLog(invoice, "accept_clerk", `${user.name} accepted the invoice as Clerk Admin.`);
  }

  if (action === "send_supervisor") {
    invoice.status = "sent_to_supervisor";
    invoice.supervisorName = "Supervisor";
    addInvoiceLog(invoice, "send_supervisor", `${user.name} sent the invoice to Supervisor.`, "Supervisor", "supervisor");
  }

  if (action === "assign_division") {
    const divisionSelect = document.querySelector(`[data-division-select="${invoice.id}"]`);
    const selectedDivisionId = divisionSelect?.value?.trim();
    const selectedDivisionOption = divisionSelect?.selectedOptions?.[0];

    const divisionName =
      selectedDivisionOption?.dataset?.fullName ||
      selectedDivisionOption?.textContent?.trim() ||
      "";

    if (!selectedDivisionId || !divisionName) {
      alert("Please select a registered Division Admin account.");
      divisionSelect?.focus();
      return;
    }

    invoice.status = "assigned_to_division";
    invoice.assignedDivisionAdminId = selectedDivisionId;
    invoice.assignedDivisionAdminName = divisionName;
    invoice.supervisorName = user.name;
    addInvoiceLog(invoice, "assign_division", `${user.name} assigned the invoice to Division Admin ${divisionName}.`, divisionName, "division_admin");
  }

  if (action === "accept_division") {
    invoice.status = "accepted_by_division";
    invoice.acceptedByDivisionName = user.name;
    if (!invoice.assignedDivisionAdminName) invoice.assignedDivisionAdminName = user.name;
    addInvoiceLog(invoice, "accept_division", `${user.name} accepted the invoice as Division Admin.`);
  }

  if (action === "validate_return") {
    invoice.status = "returned_to_clerk";
    invoice.validatedByDivisionName = user.name;
    invoice.validatedAt = new Date().toISOString();
    addInvoiceLog(invoice, "validate_return", `${user.name} validated the invoice and returned it to Clerk Admin.`, invoice.assignedClerkName, "clerk_admin");
  }

  if (action === "confirm_report") {
    invoice.status = "completed";
    invoice.confirmedByName = user.name;
    invoice.completedAt = new Date().toISOString();
    addInvoiceLog(invoice, "confirm_report", `${user.name} confirmed the invoice. The record was moved to report/history.`);
  }

  invoice.updatedAt = new Date().toISOString();
  saveInvoiceRecords();
  renderInvoiceWorkflow();
}

function handleInvoiceCreate(event) {
  event.preventDefault();

  const user = getInvoiceCurrentUser();

  if (!isInvoiceHeadAdmin(user.role)) {
    alert("Only Head Admin can create invoice subjects.");
    return;
  }

  const subject = document.getElementById("invoiceSubjectInput")?.value.trim();
  const description = document.getElementById("invoiceDescriptionInput")?.value.trim();
  const clerkSelect = document.getElementById("invoiceAssignedClerkSelect");
  const selectedClerkId = clerkSelect?.value.trim();
  const selectedClerkOption = clerkSelect?.selectedOptions?.[0];

  const assignedClerkName =
    selectedClerkOption?.dataset?.fullName ||
    selectedClerkOption?.textContent?.trim() ||
    "";

  if (!subject || !description || !selectedClerkId || !assignedClerkName) {
    alert("Please complete subject, details, and select a registered Clerk Admin account.");
    return;
  }

  const now = new Date().toISOString();

  const invoice = {
    id: `invoice-${Date.now()}`,
    trackingNo: generateInvoiceTrackingNo(),
    subject,
    description,
    status: "sent_to_clerk",
    createdById: user.id,
    createdByName: user.name,
    createdByRole: user.role,
    assignedClerkId: selectedClerkId,
    assignedClerkName,
    supervisorName: "",
    assignedDivisionAdminName: "",
    confirmedByName: "",
    createdAt: now,
    updatedAt: now,
    completedAt: "",
    logs: []
  };

  addInvoiceLog(invoice, "create", `${user.name} created invoice ${invoice.trackingNo}.`);
  addInvoiceLog(invoice, "send_clerk", `${user.name} assigned and sent the invoice to Clerk Admin ${assignedClerkName}.`, assignedClerkName, "clerk_admin");

  invoiceRecords.push(invoice);
  saveInvoiceRecords();
  event.target.reset();
  renderInvoiceWorkflow();
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
          value="${escapeInvoiceHtml(account.id || account.fullName)}"
          data-full-name="${escapeInvoiceHtml(account.fullName)}"
          data-username="${escapeInvoiceHtml(account.username || "")}">
          ${escapeInvoiceHtml(account.fullName)}
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

async function loadInvoiceDivisionAdminAccounts() {
  const existingAccounts = getInvoiceAccountsFromExistingState();

  if (existingAccounts.length) {
    invoiceDivisionAdminAccounts = existingAccounts
      .filter((account) => normalizeInvoiceAccountRole(account) === "division_admin")
      .filter(isActiveInvoiceAccount)
      .map((account) => ({
        id: account.id || "",
        fullName: getInvoiceAccountFullName(account),
        username: account.username || ""
      }))
      .filter((account) => account.fullName);

    return invoiceDivisionAdminAccounts;
  }

  const accountsUrl = getInvoiceAccountsApiUrl();

  if (!accountsUrl) {
    invoiceDivisionAdminAccounts = [];
    return invoiceDivisionAdminAccounts;
  }

  try {
    const response = await fetch(accountsUrl, {
      headers: { Accept: "application/json" }
    });

    const rawText = await response.text();
    let data = {};

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      throw new Error("Accounts API did not return valid JSON.");
    }

    if (!response.ok) {
      throw new Error(data.message || "Failed to load Division Admin accounts.");
    }

    const accounts = extractInvoiceAccounts(data);

    invoiceDivisionAdminAccounts = accounts
      .filter((account) => normalizeInvoiceAccountRole(account) === "division_admin")
      .filter(isActiveInvoiceAccount)
      .map((account) => ({
        id: account.id || "",
        fullName: getInvoiceAccountFullName(account),
        username: account.username || ""
      }))
      .filter((account) => account.fullName);

    return invoiceDivisionAdminAccounts;
  } catch (error) {
    console.error("Unable to load Division Admin accounts:", error);
    invoiceDivisionAdminAccounts = [];
    return invoiceDivisionAdminAccounts;
  }
}

async function loadInvoiceAssignableAccounts() {
  await Promise.all([
    loadInvoiceClerkAccounts(),
    loadInvoiceDivisionAdminAccounts()
  ]);

  populateInvoiceAssignmentDropdowns();
}

function populateInvoiceAssignmentDropdowns() {
  const clerkSelect = document.getElementById("invoiceAssignedClerkSelect");
  if (!clerkSelect) return;

  const currentValue = clerkSelect.value;

  if (!invoiceClerkAccounts.length) {
    clerkSelect.innerHTML = `
      <option value="">No Clerk Admin account found</option>
    `;
    clerkSelect.disabled = true;
    return;
  }

  clerkSelect.disabled = false;

  clerkSelect.innerHTML = `
    <option value="">Select Clerk Admin</option>
    ${invoiceClerkAccounts
      .map((account) => `
        <option
          value="${escapeInvoiceHtml(account.id || account.fullName)}"
          data-full-name="${escapeInvoiceHtml(account.fullName)}"
          data-username="${escapeInvoiceHtml(account.username || "")}">
          ${escapeInvoiceHtml(account.fullName)}
        </option>
      `)
      .join("")}
  `;

  if (currentValue && invoiceClerkAccounts.some((account) => String(account.id || account.fullName) === String(currentValue))) {
    clerkSelect.value = currentValue;
  }
}

function openInvoiceTrackingModal(invoiceId) {
  const invoice = findInvoiceById(invoiceId);
  const modal = document.getElementById("invoiceTrackingModal");
  if (!invoice || !modal) return;

  setInvoiceText("invoiceTrackingTitle", `${invoice.trackingNo} Tracking Details`);
  setInvoiceText("invoiceTrackingSubtitle", "Full validation and routing trail.");
  setInvoiceText("invoiceViewTrackingNo", invoice.trackingNo);
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
            <span>${escapeInvoiceHtml(formatInvoiceRole(log.fromRole))} • ${escapeInvoiceHtml(log.fromUserName || "-")} • ${escapeInvoiceHtml(formatInvoiceDate(log.createdAt))}</span>
          </div>
        </div>
      `).join("")
      : `<div class="invoice-empty-cell">No tracking logs available.</div>`;
  }

  modal.classList.remove("hidden");
}

function closeInvoiceTrackingModal() {
  const modal = document.getElementById("invoiceTrackingModal");
  if (modal) modal.classList.add("hidden");
}

function setupInvoiceWorkflow() {
  document.getElementById("invoiceCreateForm")?.addEventListener("submit", handleInvoiceCreate);
  document.getElementById("refreshInvoiceWorkflowBtn")?.addEventListener("click", async () => {
    await loadInvoiceAssignableAccounts();
    renderInvoiceWorkflow();
  });
  document.getElementById("invoiceHistorySearchInput")?.addEventListener("input", renderInvoiceHistory);
  document.getElementById("closeInvoiceTrackingBtn")?.addEventListener("click", closeInvoiceTrackingModal);
  document.getElementById("invoiceTrackingOverlay")?.addEventListener("click", closeInvoiceTrackingModal);

  loadInvoiceAssignableAccounts().then(renderInvoiceWorkflow);

  document.getElementById("openIncomingInvoiceBtn")?.addEventListener("click", () => {
    setTimeout(async () => {
      await loadInvoiceAssignableAccounts();
      renderInvoiceWorkflow();
    }, 50);
  });
}

document.addEventListener("DOMContentLoaded", setupInvoiceWorkflow);

window.loadInvoiceClerkAccounts = loadInvoiceClerkAccounts;
window.loadInvoiceDivisionAdminAccounts = loadInvoiceDivisionAdminAccounts;
window.loadInvoiceAssignableAccounts = loadInvoiceAssignableAccounts;
window.renderInvoiceWorkflow = renderInvoiceWorkflow;
window.openInvoiceTrackingModal = openInvoiceTrackingModal;
window.closeInvoiceTrackingModal = closeInvoiceTrackingModal;
