// =========================
// AUTH / SESSION
// =========================

function redirectToLogin() {
  localStorage.removeItem("webUser");
  window.location.href = "web-login.html";
}

function bindLogoutButton() {
  const logoutBtn = document.getElementById("logoutBtn");
  if (!logoutBtn) return;

  logoutBtn.addEventListener("click", () => {
    const confirmed = window.confirm("Are you sure you want to log out?");
    if (!confirmed) return;

    redirectToLogin();
  });
}

function getStoredUser() {
  try {
    const raw = localStorage.getItem("webUser");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (error) {
    console.error("Invalid webUser session:", error);
    return null;
  }
}

function normalizeRole(role) {
  return String(role || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function normalizeCurrentUser(user) {
  if (!user) return null;

  return {
    id: user.id || null,
    fullName: user.fullName || user.full_name || "",
    username: user.username || "",
    role: normalizeRole(user.role || ""),
    divisionName: user.divisionName || user.division_name || ""
  };
}

function getUserDisplayName(user) {
  return user?.fullName || user?.username || "-";
}

function getRoleDisplayName(role) {
  const normalizedRole = normalizeRole(role);

  const roleLabels = {
    super_admin: "Super Admin",
    head_admin: "Head Admin",
    admin: "Admin",
    division_admin: "Division Admin",
    personnel: "Personnel",
    supervisor: "Supervisor",
    clerk_admin: "Clerk Admin"
  };

  return roleLabels[normalizedRole] || role || "-";
}

function getUserRoleLabel(user) {
  if (!user) return "-";

  const roleLabel = getRoleDisplayName(user.role);
  return `${roleLabel}${user.divisionName ? " • " + user.divisionName : ""}`;
}

function getSidebarBrandByRole(role) {
  const normalizedRole = normalizeRole(role);

  const brandMap = {
    super_admin: {
      title: "WMO Admin",
      subtitle: "Management Panel"
    },
    head_admin: {
      title: "WMO Admin",
      subtitle: "Management Panel"
    },
    admin: {
      title: "WMO Admin",
      subtitle: "Management Panel"
    },
    clerk_admin: {
      title: "WMO Admin",
      subtitle: "Clerk Admin Panel"
    },
    division_admin: {
      title: "Division Admin",
      subtitle: "Division Management Panel"
    },
    personnel: {
      title: "WMO Personnel",
      subtitle: "Personnel Panel"
    },
    supervisor: {
      title: "WMO Supervisor",
      subtitle: "Supervisor Panel"
    }
  };

  return brandMap[normalizedRole] || {
    title: "WMO Admin",
    subtitle: "Management Panel"
  };
}

function setSidebarBrand(user) {
  const brand = getSidebarBrandByRole(user?.role);

  /*
    Works even if your HTML has no custom IDs.
    It targets:
    <div class="brand-text">
      <h2>WMO Admin</h2>
      <p>Management Panel</p>
    </div>
  */
  const brandTitle =
    document.getElementById("sidebarBrandTitle") ||
    document.querySelector(".sidebar-brand .brand-text h2");

  const brandSubtitle =
    document.getElementById("sidebarBrandSubtitle") ||
    document.querySelector(".sidebar-brand .brand-text p");

  if (brandTitle) brandTitle.textContent = brand.title;
  if (brandSubtitle) brandSubtitle.textContent = brand.subtitle;
}

function isSuperAdmin(user) {
  return user && normalizeRole(user.role) === "super_admin";
}

function isAdminRole(user) {
  if (!user) return false;

  return [
    "super_admin",
    "head_admin",
    "admin",
    "division_admin",
    "personnel",
    "supervisor",
    "clerk_admin"
  ].includes(normalizeRole(user.role));
}

function canAccessSection(user, sectionId) {
  if (!user) return false;

  /*
    User Management should stay restricted to super admin only.
    Do not allow personnel/supervisor/clerk admin to create accounts unless intended.
  */
  if (sectionId === SECTION_IDS.userManagement) {
    return isSuperAdmin(user);
  }

  return Object.values(SECTION_IDS).includes(sectionId);
}

function initializeSession() {
  const storedUser = getStoredUser();
  currentUser = normalizeCurrentUser(storedUser);

  if (!currentUser || !currentUser.role || !currentUser.username) {
    redirectToLogin();
    return false;
  }

  setUserHeaderInfo(currentUser);
  setUserManagementVisibility(currentUser);
  return true;
}

// =========================
// USER HEADER / ROLE UI
// =========================

function setUserHeaderInfo(user) {
  const sidebarName = document.getElementById("sidebarName");
  const sidebarRole = document.getElementById("sidebarRole");
  const loggedInName = document.getElementById("loggedInName");
  const loggedInRole = document.getElementById("loggedInRole");
  const sessionRoleMirror = document.getElementById("sessionRoleMirror");

  const displayName = getUserDisplayName(user);
  const roleLabel = getUserRoleLabel(user);

  setSidebarBrand(user);

  if (sidebarName) sidebarName.textContent = displayName;
  if (sidebarRole) sidebarRole.textContent = roleLabel;
  if (loggedInName) loggedInName.textContent = displayName;
  if (loggedInRole) loggedInRole.textContent = roleLabel;
  if (sessionRoleMirror) sessionRoleMirror.textContent = roleLabel;
}

function setUserManagementVisibility(user) {
  const navUserManagement = document.getElementById("navUserManagement");
  const restrictedUserMessage = document.getElementById("restrictedUserMessage");
  const superAdminContent = document.getElementById("superAdminContent");

  if (isSuperAdmin(user)) {
    if (navUserManagement) navUserManagement.style.display = "";
    if (restrictedUserMessage) restrictedUserMessage.classList.add("hidden");
    if (superAdminContent) superAdminContent.classList.remove("hidden");
  } else {
    if (navUserManagement) navUserManagement.style.display = "none";
    if (restrictedUserMessage) restrictedUserMessage.classList.remove("hidden");
    if (superAdminContent) superAdminContent.classList.add("hidden");
  }
}

// =========================
// GLOBAL EXPORTS
// =========================

window.redirectToLogin = redirectToLogin;
window.bindLogoutButton = bindLogoutButton;
window.getStoredUser = getStoredUser;
window.normalizeCurrentUser = normalizeCurrentUser;
window.getUserDisplayName = getUserDisplayName;
window.getRoleDisplayName = getRoleDisplayName;
window.getUserRoleLabel = getUserRoleLabel;
window.getSidebarBrandByRole = getSidebarBrandByRole;
window.setSidebarBrand = setSidebarBrand;
window.isSuperAdmin = isSuperAdmin;
window.isAdminRole = isAdminRole;
window.canAccessSection = canAccessSection;
window.initializeSession = initializeSession;
window.setUserHeaderInfo = setUserHeaderInfo;
window.setUserManagementVisibility = setUserManagementVisibility;
