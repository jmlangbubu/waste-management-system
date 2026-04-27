function showAccountMessage(message, type) {
  const box = document.getElementById("accountMessageBox");
  if (!box) return;

  box.textContent = message;
  box.className = `module-message ${type}`;
}

async function loadWebUsers() {
  try {
    const res = await fetch(getAccountsApiUrl(), {
      headers: {
        "Accept": "application/json"
      }
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

    if (typeof getFilteredWebUsers === "function") {
      renderWebUsers(getFilteredWebUsers());
    } else {
      renderWebUsers(accounts);
    }

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

function renderWebUsers(users) {
  const tableBody = document.getElementById("webUsersTableBody");
  if (!tableBody) return;

  if (!Array.isArray(users) || !users.length) {
    tableBody.innerHTML = `<tr><td colspan="8" class="empty-state">No accounts found</td></tr>`;
    return;
  }

  const activeUsers = users.filter((user) => {
    const status = String(user.status || "active").toLowerCase().trim();
    return status !== "deactivated" && status !== "inactive" && status !== "suspended";
  });

  if (!activeUsers.length) {
    tableBody.innerHTML = `<tr><td colspan="8" class="empty-state">No active accounts found</td></tr>`;
    return;
  }

  tableBody.innerHTML = activeUsers.map((user) => {
    const accountId = Number(user.id);
    const accountSource = user.account_source || "web";
    const status = String(user.status || "active").toLowerCase().trim();
    const isDeactivated =
      status === "deactivated" ||
      status === "inactive" ||
      status === "suspended";

    const primaryIdentity =
      user.username ||
      user.email ||
      user.contact_number ||
      "-";

    const sourceLabel = accountSource === "mobile" ? "Mobile" : "Web";

    const roleLabel =
      accountSource === "mobile"
        ? (user.mobile_role || user.role || "mobile_user")
        : (user.role || "-");

    const assignmentLabel =
      accountSource === "mobile"
        ? (user.assigned_source_name || user.barangay || user.establishment_name || "-")
        : (user.division_name || "-");

    const actionLabel = isDeactivated ? "Activate" : "Deactivate";
    const nextStatus = isDeactivated ? "active" : "suspended";

    return `
      <tr>
        <td>${escapeHtml(user.full_name || "-")}</td>
        <td>${escapeHtml(primaryIdentity)}</td>
        <td>${escapeHtml(sourceLabel)}</td>
        <td>${escapeHtml(roleLabel)}</td>
        <td>${escapeHtml(assignmentLabel)}</td>
        <td>${renderStatusBadge(status)}</td>
        <td>${formatDate(user.created_at || user.createdAt)}</td>
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

  if (!searchValue) {
    return allWebUsers;
  }

  return allWebUsers.filter((user) => {
    const fullName = String(user.full_name || "").toLowerCase();
    const username = String(user.username || "").toLowerCase();
    const email = String(user.email || "").toLowerCase();
    const source = String(user.account_source || "web").toLowerCase();
    const role = String(user.mobile_role || user.role || "").toLowerCase();
    const assignment = String(
      user.assigned_source_name ||
      user.barangay ||
      user.establishment_name ||
      user.division_name ||
      ""
    ).toLowerCase();
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
  const tableBody = document.getElementById("deactivatedAccountsTableBody");
  if (!tableBody) return;

  const users = getDeactivatedWebUsers();

  if (!users.length) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="8" class="empty-state">No deactivated accounts found.</td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = users.map((user) => {
    const accountId = Number(user.id);
    const accountSource = user.account_source || "web";

    const primaryIdentity =
      user.username ||
      user.email ||
      user.contact_number ||
      "-";

    const sourceLabel = accountSource === "mobile" ? "Mobile" : "Web";

    const roleLabel =
      accountSource === "mobile"
        ? (user.mobile_role || user.role || "mobile_user")
        : (user.role || "-");

    const assignmentLabel =
      accountSource === "mobile"
        ? (user.assigned_source_name || user.barangay || user.establishment_name || "-")
        : (user.division_name || "-");

    return `
      <tr>
        <td>${escapeHtml(user.full_name || "-")}</td>
        <td>${escapeHtml(primaryIdentity)}</td>
        <td>${escapeHtml(sourceLabel)}</td>
        <td>${escapeHtml(roleLabel)}</td>
        <td>${escapeHtml(assignmentLabel)}</td>
        <td>${renderStatusBadge(user.status || "deactivated")}</td>
        <td>${formatDate(user.created_at || user.createdAt)}</td>
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

function openEditAccountModal(source, id) {
  alert(`Edit account coming next.\nSource: ${source}\nID: ${id}`);
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

    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
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

    console.log("Deleting account:", { source, id, url });

    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        "Accept": "application/json"
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

window.handleAccountStatusUpdate = handleAccountStatusUpdate;
window.handleDeleteAccount = handleDeleteAccount;
window.openDeactivatedAccountsModal = openDeactivatedAccountsModal;
window.closeDeactivatedAccountsModal = closeDeactivatedAccountsModal;
window.openEditAccountModal = openEditAccountModal;


function setupAccountPlatformForm() {
  const platformEl = document.getElementById("accountPlatform");
  const roleEl = document.getElementById("accountRole");
  const assignmentInput = document.getElementById("assignmentName");
  const assignmentLabel = document.querySelector('label[for="assignmentName"]');

  if (!platformEl || !roleEl || !assignmentInput) return;

  const roleOptions = {
    web: [
      { value: "division_admin", label: "Division Admin" },
      { value: "personnel", label: "Personnel" }
    ],
    mobile: [
      { value: "enforcer", label: "Enforcer" },
      { value: "barangay", label: "Barangay" },
      { value: "establishment", label: "Establishment" }
    ]
  };

  function renderRoleOptions(platform) {
    const options = roleOptions[platform] || [];

    roleEl.innerHTML = `
      <option value="">Select role</option>
      ${options.map(option => `
        <option value="${option.value}">${option.label}</option>
      `).join("")}
    `;

    if (platform === "web") {
      if (assignmentLabel) assignmentLabel.textContent = "Division Name";
      assignmentInput.placeholder = "Enter division name";
    } else if (platform === "mobile") {
      if (assignmentLabel) assignmentLabel.textContent = "Assignment Area";
      assignmentInput.placeholder = "Enter barangay or establishment name";
    } else {
      if (assignmentLabel) assignmentLabel.textContent = "Division / Barangay / Assignment";
      assignmentInput.placeholder = "Enter assignment name";
    }
  }

  platformEl.onchange = function () {
    renderRoleOptions(this.value);
  };

  renderRoleOptions(platformEl.value);
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
          status: "active"
        };
      } else {
        showAccountMessage("Invalid platform selected.", "error");
        return;
      }

      console.log("Creating account:", { platform, url, payload });

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
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
