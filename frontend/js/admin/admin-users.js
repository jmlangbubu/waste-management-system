function showAccountMessage(message, type) {
  const box = document.getElementById("accountMessageBox");
  if (!box) return;

  box.textContent = message;
  box.className = `module-message ${type}`;
}

async function loadWebUsers() {
  ensureUserManagementLayoutStyles();

  try {
    const res = await webAdminFetch(getAccountsApiUrl(), {
      headers: { Accept: "application/json" }
    });

    const rawText = await res.text();
    let data = {};

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch (parseError) {
      console.error("Accounts raw response:", rawText);
      throw new Error("Accounts API did not return valid JSON.");
    }

    if (!res.ok) {
      throw new Error(data.message || "Failed to load accounts.");
    }

    const accounts = Array.isArray(data)
      ? data
      : Array.isArray(data.accounts)
      ? data.accounts
      : Array.isArray(data.data)
      ? data.data
      : [];

    allWebUsers = accounts;

    renderWebUsers(typeof getFilteredWebUsers === "function" ? getFilteredWebUsers() : accounts);

    if (typeof renderWebUserActivity === "function") {
      renderWebUserActivity();
    }
  } catch (error) {
    console.error("Error loading accounts:", error);
    allWebUsers = [];
    renderWebUsers([]);

    if (typeof renderWebUserActivity === "function") {
      renderWebUserActivity();
    }
  }
}

function formatAccountRoleLabel(role) {
  const value = String(role || "").toLowerCase().trim();

  const labels = {
    division_admin: "Division Admin",
    personnel: "Personnel",
    supervisor: "Supervisor",
    clerk_admin: "Clerk Admin",
    enforcer: "Enforcer",
    barangay: "Barangay",
    establishment: "Establishment",
    mobile_user: "Mobile User"
  };

  return labels[value] || role || "-";
}


function ensureUserManagementLayoutStyles() {
  if (document.getElementById("userManagementRuntimeStyles")) return;

  const style = document.createElement("style");
  style.id = "userManagementRuntimeStyles";
  style.textContent = `
    /*
      FIX:
      The previous two-column User Management layout squeezed the accounts table.
      This full-width vertical layout keeps Create Account on top and gives
      All Accounts the full page width, so columns no longer break into letters.
    */
    #userManagementSection #superAdminContent.users-layout {
      display: flex !important;
      flex-direction: column !important;
      gap: 18px !important;
      align-items: stretch !important;
      width: 100% !important;
    }

    #userManagementSection #superAdminContent.users-layout > .page-card {
      width: 100% !important;
      max-width: 100% !important;
    }

    #userManagementSection .account-form .form-grid {
      display: grid !important;
      grid-template-columns: repeat(3, minmax(180px, 1fr)) !important;
      gap: 14px 18px !important;
      align-items: end !important;
    }

    #userManagementSection .account-form .form-actions {
      display: flex !important;
      justify-content: flex-end !important;
      margin-top: 14px !important;
    }

    #userManagementSection .account-form .create-btn {
      min-width: 190px !important;
    }

    #userManagementSection .accounts-toolbar {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      gap: 14px !important;
      flex-wrap: wrap !important;
      margin-bottom: 14px !important;
    }

    #userManagementSection .account-search-input {
      width: min(100%, 560px) !important;
      min-height: 42px !important;
      font-size: 14px !important;
    }

    #userManagementSection .accounts-table-shell {
      width: 100% !important;
      overflow-x: auto !important;
      border-radius: 18px !important;
    }

    #userManagementSection .accounts-table {
      width: 100% !important;
      min-width: 1180px !important;
      table-layout: auto !important;
      border-collapse: collapse !important;
    }

    #userManagementSection .accounts-table th,
    #userManagementSection .accounts-table td {
      vertical-align: middle !important;
      padding: 13px 12px !important;
      font-size: 13px !important;
      line-height: 1.35 !important;
      white-space: normal !important;
      word-break: normal !important;
      overflow-wrap: anywhere !important;
    }

    #userManagementSection .accounts-table th {
      font-size: 13px !important;
      font-weight: 900 !important;
      letter-spacing: .01em !important;
      white-space: nowrap !important;
      word-break: normal !important;
      overflow-wrap: normal !important;
    }

    #userManagementSection .accounts-table th:nth-child(1),
    #userManagementSection .accounts-table td:nth-child(1) {
      min-width: 155px !important;
      font-weight: 800 !important;
    }

    #userManagementSection .accounts-table th:nth-child(2),
    #userManagementSection .accounts-table td:nth-child(2) {
      min-width: 135px !important;
    }

    #userManagementSection .accounts-table th:nth-child(3),
    #userManagementSection .accounts-table td:nth-child(3) {
      min-width: 180px !important;
    }

    #userManagementSection .accounts-table th:nth-child(4),
    #userManagementSection .accounts-table td:nth-child(4) {
      min-width: 86px !important;
      text-align: center !important;
    }

    #userManagementSection .accounts-table th:nth-child(5),
    #userManagementSection .accounts-table td:nth-child(5) {
      min-width: 125px !important;
    }

    #userManagementSection .accounts-table th:nth-child(6),
    #userManagementSection .accounts-table td:nth-child(6) {
      min-width: 165px !important;
    }

    #userManagementSection .accounts-table th:nth-child(7),
    #userManagementSection .accounts-table td:nth-child(7) {
      min-width: 120px !important;
      text-align: center !important;
    }

    #userManagementSection .accounts-table th:nth-child(8),
    #userManagementSection .accounts-table td:nth-child(8) {
      min-width: 150px !important;
      white-space: normal !important;
      overflow-wrap: normal !important;
    }

    #userManagementSection .accounts-table th:nth-child(9),
    #userManagementSection .accounts-table td:nth-child(9) {
      min-width: 170px !important;
      text-align: center !important;
    }

    #userManagementSection .account-subtle-text {
      display: block !important;
      margin-top: 3px !important;
      color: #64748b !important;
      font-size: 11px !important;
      font-weight: 600 !important;
      white-space: nowrap !important;
    }

    #userManagementSection .account-source-chip {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      min-width: 72px !important;
      min-height: 28px !important;
      padding: 0 11px !important;
      border-radius: 999px !important;
      font-size: 12px !important;
      font-weight: 900 !important;
      white-space: nowrap !important;
    }

    #userManagementSection .account-source-chip.web {
      background: #eff6ff !important;
      color: #1d4ed8 !important;
      border: 1px solid #bfdbfe !important;
    }

    #userManagementSection .account-source-chip.mobile {
      background: #ecfdf5 !important;
      color: #047857 !important;
      border: 1px solid #a7f3d0 !important;
    }

    #userManagementSection .account-action-buttons {
      display: flex !important;
      gap: 8px !important;
      justify-content: center !important;
      flex-wrap: nowrap !important;
    }

    #userManagementSection .account-action-buttons .inline-action-btn {
      min-width: 78px !important;
      min-height: 36px !important;
      padding: 7px 10px !important;
      border-radius: 10px !important;
      font-size: 12px !important;
      white-space: nowrap !important;
    }

    @media (max-width: 980px) {
      #userManagementSection .account-form .form-grid {
        grid-template-columns: 1fr !important;
      }

      #userManagementSection .account-form .form-actions {
        justify-content: stretch !important;
      }

      #userManagementSection .account-form .create-btn {
        width: 100% !important;
      }

      #userManagementSection .accounts-table {
        min-width: 1120px !important;
      }
    }
  `;

  document.head.appendChild(style);
}

function cleanAccountValue(value) {
  const text = String(value ?? "").trim();

  if (
    !text ||
    text.toLowerCase() === "null" ||
    text.toLowerCase() === "undefined" ||
    text === "-"
  ) {
    return "";
  }

  return text;
}

function getAccountSource(user = {}) {
  return String(user.account_source || user.source || "web").toLowerCase().trim() === "mobile"
    ? "mobile"
    : "web";
}

function getAccountUsername(user = {}) {
  return (
    cleanAccountValue(user.username) ||
    cleanAccountValue(user.user_name) ||
    cleanAccountValue(user.login_username) ||
    cleanAccountValue(user.email) ||
    cleanAccountValue(user.contact_number) ||
    "-"
  );
}

function getAccountEmail(user = {}) {
  return (
    cleanAccountValue(user.email) ||
    cleanAccountValue(user.email_address) ||
    cleanAccountValue(user.emailAddress) ||
    cleanAccountValue(user.user_email) ||
    cleanAccountValue(user.contact_email) ||
    "-"
  );
}

function getMobileAssignmentLabel(user = {}) {
  const role = String(user.mobile_role || user.role || "").toLowerCase().trim();

  const barangay = (
    cleanAccountValue(user.assigned_source_name) ||
    cleanAccountValue(user.assigned_barangay) ||
    cleanAccountValue(user.barangay) ||
    cleanAccountValue(user.barangay_name) ||
    cleanAccountValue(user.user_barangay) ||
    cleanAccountValue(user.address_barangay) ||
    cleanAccountValue(user.location_barangay) ||
    cleanAccountValue(user.division_barangay) ||
    cleanAccountValue(user.area_barangay) ||
    cleanAccountValue(user.assigned_area)
  );

  const establishment = (
    cleanAccountValue(user.establishment_name) ||
    cleanAccountValue(user.business_name) ||
    cleanAccountValue(user.company_name) ||
    cleanAccountValue(user.assigned_source_name)
  );

  if (role === "establishment") {
    return establishment || barangay || "-";
  }

  if (role === "citizen" || role === "barangay" || role === "enforcer" || role === "mobile_user") {
    return barangay || "Barangay not set";
  }

  return barangay || establishment || "-";
}

function getAccountAssignmentLabel(user = {}) {
  const source = getAccountSource(user);

  if (source === "mobile") {
    return getMobileAssignmentLabel(user);
  }

  return (
    cleanAccountValue(user.division_name) ||
    cleanAccountValue(user.division) ||
    cleanAccountValue(user.office_division) ||
    "-"
  );
}

function renderAccountMutedValue(value) {
  const text = cleanAccountValue(value);

  if (!text) {
    return `<span class="account-subtle-text">Not provided</span>`;
  }

  return escapeHtml(text);
}

function renderAccountSourceChip(source) {
  const safeSource = source === "mobile" ? "mobile" : "web";
  const label = safeSource === "mobile" ? "Mobile" : "Web";

  return `<span class="account-source-chip ${safeSource}">${label}</span>`;
}

function renderAccountNameCell(user = {}) {
  const fullName = cleanAccountValue(user.full_name) || cleanAccountValue(user.name) || "-";
  const id = cleanAccountValue(user.id);

  return `
    <strong>${escapeHtml(fullName)}</strong>
    ${id ? `<span class="account-subtle-text">ID: ${escapeHtml(id)}</span>` : ""}
  `;
}


function renderWebUsers(users) {
  ensureUserManagementLayoutStyles();

  const tableBody = document.getElementById("webUsersTableBody");
  if (!tableBody) return;

  if (!Array.isArray(users) || !users.length) {
    tableBody.innerHTML = `<tr><td colspan="9" class="empty-state">No accounts found</td></tr>`;
    return;
  }

  const activeUsers = users.filter((user) => {
    const status = String(user.status || "active").toLowerCase().trim();
    return status !== "deactivated" && status !== "inactive" && status !== "suspended";
  });

  if (!activeUsers.length) {
    tableBody.innerHTML = `<tr><td colspan="9" class="empty-state">No active accounts found</td></tr>`;
    return;
  }

  tableBody.innerHTML = activeUsers.map((user) => {
    const accountId = Number(user.id);
    const accountSource = getAccountSource(user);
    const status = String(user.status || "active").toLowerCase().trim();

    const isDeactivated =
      status === "deactivated" ||
      status === "inactive" ||
      status === "suspended";

    const usernameLabel = getAccountUsername(user);
    const emailLabel = getAccountEmail(user);

    const roleLabel =
      accountSource === "mobile"
        ? formatAccountRoleLabel(user.mobile_role || user.role || "mobile_user")
        : formatAccountRoleLabel(user.role || "-");

    const assignmentLabel = getAccountAssignmentLabel(user);

    const actionLabel = isDeactivated ? "Activate" : "Deactivate";
    const nextStatus = isDeactivated ? "active" : "suspended";

    return `
      <tr>
        <td>${renderAccountNameCell(user)}</td>
        <td>${escapeHtml(usernameLabel)}</td>
        <td>${renderAccountMutedValue(emailLabel)}</td>
        <td>${renderAccountSourceChip(accountSource)}</td>
        <td>${escapeHtml(roleLabel)}</td>
        <td>${escapeHtml(assignmentLabel)}</td>
        <td>${renderStatusBadge(status)}</td>
        <td>${formatDate(user.created_at || user.createdAt || user.date_created)}</td>
        <td>
          <div class="account-action-buttons">
            <button
              class="inline-action-btn ${isDeactivated ? "activate-btn" : "suspend-btn"}"
              type="button"
              onclick="handleAccountStatusUpdate('${accountSource}', ${accountId}, '${nextStatus}')">
              ${actionLabel}
            </button>

            <button
              class="inline-action-btn edit-btn"
              type="button"
              onclick="openEditAccountModal('${accountSource}', ${accountId})">
              Edit
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

function getFilteredWebUsers() {
  const searchValue = (document.getElementById("accountSearchInput")?.value || "")
    .trim()
    .toLowerCase();

  if (!searchValue) return allWebUsers;

  return allWebUsers.filter((user) => {
    const fullName = String(user.full_name || user.name || "").toLowerCase();
    const username = String(getAccountUsername(user)).toLowerCase();
    const email = String(getAccountEmail(user)).toLowerCase();
    const source = String(getAccountSource(user)).toLowerCase();
    const role = String(user.mobile_role || user.role || "").toLowerCase();
    const assignment = String(getAccountAssignmentLabel(user)).toLowerCase();
    const status = String(user.status || "active").toLowerCase();

    return (
      fullName.includes(searchValue) ||
      username.includes(searchValue) ||
      email.includes(searchValue) ||
      source.includes(searchValue) ||
      role.includes(searchValue) ||
      assignment.includes(searchValue) ||
      status.includes(searchValue)
    );
  });
}

function getDeactivatedWebUsers() {
  return (Array.isArray(allWebUsers) ? allWebUsers : []).filter((user) => {
    const status = String(user.status || "").toLowerCase().trim();
    return status === "deactivated" || status === "inactive" || status === "suspended";
  });
}

function renderDeactivatedAccountsHistory() {
  ensureUserManagementLayoutStyles();

  const tableBody = document.getElementById("deactivatedAccountsTableBody");
  if (!tableBody) return;

  const users = getDeactivatedWebUsers();

  if (!users.length) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="9" class="empty-state">No deactivated accounts found.</td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = users.map((user) => {
    const accountId = Number(user.id);
    const accountSource = getAccountSource(user);

    const usernameLabel = getAccountUsername(user);
    const emailLabel = getAccountEmail(user);

    const roleLabel =
      accountSource === "mobile"
        ? formatAccountRoleLabel(user.mobile_role || user.role || "mobile_user")
        : formatAccountRoleLabel(user.role || "-");

    const assignmentLabel = getAccountAssignmentLabel(user);

    return `
      <tr>
        <td>${renderAccountNameCell(user)}</td>
        <td>${escapeHtml(usernameLabel)}</td>
        <td>${renderAccountMutedValue(emailLabel)}</td>
        <td>${renderAccountSourceChip(accountSource)}</td>
        <td>${escapeHtml(roleLabel)}</td>
        <td>${escapeHtml(assignmentLabel)}</td>
        <td>${renderStatusBadge(user.status || "deactivated")}</td>
        <td>${formatDate(user.created_at || user.createdAt || user.date_created)}</td>
        <td>
          <div class="account-action-buttons">
            <button
              class="inline-action-btn activate-btn"
              type="button"
              onclick="handleAccountStatusUpdate('${accountSource}', ${accountId}, 'active')">
              Activate
            </button>

            <button
              class="inline-action-btn delete-btn"
              type="button"
              onclick="handleDeleteAccount('${accountSource}', ${accountId})">
              Delete
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

function openDeactivatedAccountsModal() {
  const modal = document.getElementById("deactivatedAccountsModal");
  if (!modal) {
    console.error("deactivatedAccountsModal not found.");
    return;
  }

  renderDeactivatedAccountsHistory();
  modal.classList.remove("hidden");
}

function closeDeactivatedAccountsModal() {
  const modal = document.getElementById("deactivatedAccountsModal");
  if (!modal) return;
  modal.classList.add("hidden");
}

/* =========================
   EDIT ACCOUNT
========================= */

function openEditAccountModal(source, id) {
  const user = allWebUsers.find((u) => Number(u.id) === Number(id));

  if (!user) {
    showAccountMessage("User not found.", "error");
    return;
  }

  currentEditUser = {
    ...user,
    source
  };

  const modal = document.getElementById("editUserModal");
  const idInput = document.getElementById("editUserId");
  const usernameInput = document.getElementById("editUsername");
  const passwordInput = document.getElementById("editPassword");
  const confirmInput = document.getElementById("editConfirmPassword");

  if (!modal || !idInput || !usernameInput || !passwordInput || !confirmInput) {
    showAccountMessage("Edit account modal is missing in HTML.", "error");
    return;
  }

  idInput.value = id;
  usernameInput.value = user.username || user.email || user.contact_number || "";
  passwordInput.value = "";
  confirmInput.value = "";

  modal.classList.remove("hidden");
}

function closeEditUserModal() {
  const modal = document.getElementById("editUserModal");
  if (modal) modal.classList.add("hidden");
}

async function submitEditUser() {
  const id = document.getElementById("editUserId")?.value;
  const username = document.getElementById("editUsername")?.value.trim();
  const password = document.getElementById("editPassword")?.value.trim();
  const confirmPassword = document.getElementById("editConfirmPassword")?.value.trim();

  if (!currentEditUser) {
    showToast?.("No selected account to edit.", "error");
    return;
  }

  if (!id || !username) {
    showToast?.("Username is required.", "error");
    return;
  }

  if (password && password.length < 4) {
    showToast?.("Password must be at least 4 characters.", "error");
    return;
  }

  if (password && password !== confirmPassword) {
    showToast?.("Passwords do not match.", "error");
    return;
  }

  const saveBtn = document.querySelector("#editUserModal .edit-save-btn");

  try {
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving...";
    }

    const url =
      currentEditUser.source === "mobile"
        ? `${getAppApiBase()}/web-users/update-mobile/${id}`
        : `${getAppApiBase()}/web-users/update/${id}`;

    const res = await webAdminFetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        username,
        password: password || null
      })
    });

    const rawText = await res.text();
    let data = {};

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = {};
    }

    if (!res.ok) {
      const message = data.message || "Failed to update account.";
      if (typeof showToast === "function") showToast(message, "error");
      else showAccountMessage(message, "error");
      return;
    }

    closeEditUserModal();

    if (typeof showToast === "function") {
      showToast(data.message || "Account updated successfully.", "success");
    } else {
      showAccountMessage(data.message || "Account updated successfully.", "success");
    }

    await loadWebUsers();

  } catch (error) {
    console.error("Edit account error:", error);

    if (typeof showToast === "function") {
      showToast("Unable to update account.", "error");
    } else {
      showAccountMessage("Unable to update account.", "error");
    }
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Changes";
    }
  }
}

function setupAccountSearch() {
  const searchInput = document.getElementById("accountSearchInput");
  if (!searchInput) return;

  searchInput.addEventListener("input", () => {
    const filteredUsers = getFilteredWebUsers();
    renderWebUsers(filteredUsers);
  });
}

async function handleAccountStatusUpdate(source, id, newStatus) {
  const actionText = newStatus === "suspended" ? "deactivate" : "activate";

  if (!confirm(`Are you sure you want to ${actionText} this account?`)) {
    return;
  }

  try {
    const url =
      source === "mobile"
        ? `${getAppApiBase()}/web-users/update-mobile-status/${id}`
        : `${getAppApiBase()}/web-users/update-status/${id}`;

    const res = await webAdminFetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ status: newStatus })
    });

    const rawText = await res.text();
    let data = {};

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch (parseError) {
      console.error("Status update raw response:", rawText);
      throw new Error("Status update API did not return valid JSON.");
    }

    if (!res.ok) {
      showAccountMessage(data.message || "Failed to update account status.", "error");
      return;
    }

    showAccountMessage(data.message || "Account status updated successfully.", "success");
    await loadWebUsers();
    renderDeactivatedAccountsHistory();
  } catch (error) {
    console.error("Error updating account status:", error);
    showAccountMessage("Unable to update account status.", "error");
  }
}

async function handleDeleteAccount(source, id) {
  if (!confirm("Are you sure you want to delete this account? This cannot be undone.")) {
    return;
  }

  try {
    const url =
      source === "mobile"
        ? `${getAppApiBase()}/web-users/delete-mobile/${id}`
        : `${getAppApiBase()}/web-users/delete/${id}`;

    const res = await webAdminFetch(url, {
      method: "DELETE",
      headers: {
        Accept: "application/json"
      }
    });

    const rawText = await res.text();
    let data = {};

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch (parseError) {
      console.error("Delete raw response:", rawText);
      throw new Error("Delete API did not return valid JSON.");
    }

    if (!res.ok) {
      showAccountMessage(data.message || "Failed to delete account.", "error");
      return;
    }

    showAccountMessage(data.message || "Account deleted successfully.", "success");
    await loadWebUsers();
    renderDeactivatedAccountsHistory();
  } catch (error) {
    console.error("Error deleting account:", error);
    showAccountMessage("Unable to delete account.", "error");
  }
}

function setupAccountPlatformForm() {
  const platformEl = document.getElementById("accountPlatform");
  const roleEl = document.getElementById("accountRole");
  const assignmentLabel = document.querySelector('label[for="assignmentName"]');

  if (!platformEl || !roleEl) return;

  const roleOptions = {
    web: [
      { value: "division_admin", label: "Division Admin" },
      { value: "personnel", label: "Personnel" },
      { value: "supervisor", label: "Supervisor" },
      { value: "clerk_admin", label: "Clerk Admin" }
    ],
    mobile: [
      { value: "enforcer", label: "Enforcer" },
      { value: "barangay", label: "Barangay" },
      { value: "establishment", label: "Establishment" }
    ]
  };

  const barangayOptions = [
    "Apopong",
    "Baluan",
    "Batomelong",
    "Buayan",
    "Bula",
    "Calumpang",
    "City Heights",
    "Conel",
    "Dadiangas East",
    "Dadiangas North",
    "Dadiangas South",
    "Dadiangas West",
    "Fatima",
    "Katangawan",
    "Labangal",
    "Lagao",
    "Ligaya",
    "Mabuhay",
    "Olympog",
    "San Isidro",
    "San Jose",
    "Siguel",
    "Sinawal",
    "Tambler",
    "Tinagacan",
    "Upper Labay"
  ];

  function getAssignmentField() {
    return document.getElementById("assignmentName");
  }

  function replaceAssignmentField(nextField) {
    const currentField = getAssignmentField();

    if (!currentField || !currentField.parentElement) return;

    currentField.replaceWith(nextField);
  }

  function createAssignmentSelect() {
    const select = document.createElement("select");

    select.id = "assignmentName";
    select.name = "assignmentName";
    select.required = true;

    select.innerHTML = `
      <option value="">Select barangay</option>
      ${barangayOptions.map((barangay) => `
        <option value="${barangay}">${barangay}</option>
      `).join("")}
    `;

    return select;
  }

  function createAssignmentInput(placeholder) {
    const input = document.createElement("input");

    input.type = "text";
    input.id = "assignmentName";
    input.name = "assignmentName";
    input.placeholder = placeholder;
    input.required = true;

    return input;
  }

  function renderRoleOptions(platform) {
    const options = roleOptions[platform] || [];
    const previousValue = roleEl.value;

    roleEl.innerHTML = `
      <option value="">Select role</option>
      ${options.map((option) => `
        <option value="${option.value}">${option.label}</option>
      `).join("")}
    `;

    if (options.some((option) => option.value === previousValue)) {
      roleEl.value = previousValue;
    }
  }

  function renderAssignmentField() {
    const platform = platformEl.value;
    const role = roleEl.value;

    if (platform === "web") {
      if (assignmentLabel) assignmentLabel.textContent = "Division Name";
      replaceAssignmentField(createAssignmentInput("Enter division name"));
      return;
    }

    if (platform === "mobile" && (role === "enforcer" || role === "barangay")) {
      if (assignmentLabel) assignmentLabel.textContent = "Barangay";
      replaceAssignmentField(createAssignmentSelect());
      return;
    }

    if (platform === "mobile" && role === "establishment") {
      if (assignmentLabel) assignmentLabel.textContent = "Establishment Name";
      replaceAssignmentField(createAssignmentInput("Enter establishment name"));
      return;
    }

    if (platform === "mobile") {
      if (assignmentLabel) assignmentLabel.textContent = "Assignment Area";
      replaceAssignmentField(createAssignmentInput("Select a role first"));
      return;
    }

    if (assignmentLabel) assignmentLabel.textContent = "Division / Barangay / Assignment";
    replaceAssignmentField(createAssignmentInput("Enter assignment name"));
  }

  function syncAccountPlatformForm() {
    renderRoleOptions(platformEl.value);
    renderAssignmentField();
  }

  platformEl.onchange = function () {
    renderRoleOptions(this.value);
    renderAssignmentField();
  };

  roleEl.onchange = function () {
    renderAssignmentField();
  };

  syncAccountPlatformForm();
}

function setupCreateAccountForm() {
  const form = document.getElementById("createAccountForm");
  const submitBtn = document.getElementById("createAccountBtn");

  if (!form) return;
  if (form.dataset.bound === "true") return;

  form.dataset.bound = "true";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const platform = document.getElementById("accountPlatform")?.value || "";
    const fullName = document.getElementById("fullName")?.value.trim() || "";
    const username = document.getElementById("newUsername")?.value.trim() || "";
    const password = document.getElementById("newPassword")?.value.trim() || "";
    const role = document.getElementById("accountRole")?.value || "";
    const assignmentName = document.getElementById("assignmentName")?.value.trim() || "";

    if (!platform || !fullName || !username || !password || !role || !assignmentName) {
      showAccountMessage("Missing required fields.", "error");
      return;
    }

    if (password.length < 4) {
      showAccountMessage("Password must be at least 4 characters.", "error");
      return;
    }

    try {
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Creating...";
      }

      let url = "";
      let payload = {};

      if (platform === "web") {
        url = getCreateWebUserApiUrl();
        payload = {
          full_name: fullName,
          username,
          password,
          role,
          division_name: assignmentName,
          status: "active"
        };
      } else if (platform === "mobile") {
        url = getCreateMobileUserApiUrl();
        payload = {
          full_name: fullName,
          username,
          password,
          mobile_role: role,
          assigned_source_name: assignmentName,
          barangay: role === "barangay" || role === "enforcer" ? assignmentName : null,
          establishment_name: role === "establishment" ? assignmentName : null,
          status: "active"
        };
      } else {
        showAccountMessage("Invalid platform selected.", "error");
        return;
      }

      const res = await webAdminFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(payload)
      });

      const rawText = await res.text();
      let data = {};

      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch (parseError) {
        console.error("Create account raw response:", rawText);
        throw new Error("Create account API did not return valid JSON.");
      }

      if (!res.ok) {
        showAccountMessage(data.message || "Failed to create account.", "error");
        return;
      }

      showAccountMessage(data.message || "Account created successfully.", "success");

      form.reset();
      setupAccountPlatformForm();

      await loadWebUsers();
    } catch (error) {
      console.error("Error creating account:", error);
      showAccountMessage("Unable to create account.", "error");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Create Account";
      }
    }
  });
}

/* =========================
   GLOBAL EXPORTS
========================= */

window.handleAccountStatusUpdate = handleAccountStatusUpdate;
window.handleDeleteAccount = handleDeleteAccount;
window.openDeactivatedAccountsModal = openDeactivatedAccountsModal;
window.closeDeactivatedAccountsModal = closeDeactivatedAccountsModal;
window.openEditAccountModal = openEditAccountModal;
window.closeEditUserModal = closeEditUserModal;
window.submitEditUser = submitEditUser;
window.formatAccountRoleLabel = formatAccountRoleLabel;
