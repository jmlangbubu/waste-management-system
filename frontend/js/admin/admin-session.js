// =========================
// AUTH / SESSION
// =========================

function redirectToLogin() {
  clearCachedWebUser?.();
  window.location.replace("web-login.html");
}

function bindLogoutButton() {
  const logoutBtn = document.getElementById("logoutBtn");
  if (!logoutBtn) return;

  if (logoutBtn.dataset.webLogoutBound === "true") return;
  logoutBtn.dataset.webLogoutBound = "true";

  logoutBtn.addEventListener("click", async () => {
    const confirmed = window.confirm("Are you sure you want to log out?");
    if (!confirmed) return;

    logoutBtn.disabled = true;
    try {
      await webAdminFetch(getWebAuthLogoutApiUrl(), { method: "POST" });
    } catch (error) {
      console.warn("Web logout request did not complete:", error.code || error.name);
    } finally {
      redirectToLogin();
    }
  });
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
      title: "Clerk Admin",
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

  if (sectionId === SECTION_IDS.userManagement) {
    return isSuperAdmin(user);
  }

  return Object.values(SECTION_IDS).includes(sectionId);
}

function forceHideElement(element) {
  if (!element) return;

  element.hidden = true;
  element.classList.add("hidden");
  element.classList.add("role-hidden");
  element.setAttribute("aria-hidden", "true");
  element.style.setProperty("display", "none", "important");
}

function forceShowElement(element, displayValue = "") {
  if (!element) return;

  element.hidden = false;
  element.classList.remove("hidden");
  element.classList.remove("role-hidden");
  element.removeAttribute("aria-hidden");

  if (displayValue) {
    element.style.setProperty("display", displayValue, "important");
  } else {
    element.style.removeProperty("display");
  }
}

async function initializeSession() {
  try {
    const response = await webAdminFetch(getWebAuthSessionApiUrl(), {
      headers: { Accept: "application/json" }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.success || !payload.user) {
      redirectToLogin();
      return false;
    }

    currentUser = normalizeCurrentUser(payload.user);
  } catch (error) {
    console.warn("Web Admin session validation failed:", error.code || error.name);
    redirectToLogin();
    return false;
  }

  if (!currentUser || !currentUser.role || !currentUser.username) {
    redirectToLogin();
    return false;
  }

  localStorage.setItem("webUser", JSON.stringify(currentUser));

  setUserHeaderInfo(currentUser);
  setUserManagementVisibility(currentUser);
  guardRestrictedActiveSection(currentUser);
  window.__webAdminSessionReady = true;
  document.documentElement.classList.remove("web-session-pending");
  document.dispatchEvent(new CustomEvent("web-admin-session-ready"));

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
    /*
      Super Admin only:
      show User Management nav and content.
    */
    forceShowElement(navUserManagement, "grid");
    if (restrictedUserMessage) restrictedUserMessage.classList.add("hidden");
    if (superAdminContent) superAdminContent.classList.remove("hidden");
    return;
  }

  /*
    Important:
    Some CSS patches use display:grid !important on .nav-btn.
    Normal style.display = "none" can be overridden.
    This uses display none !important + hidden attribute.
  */
  forceHideElement(navUserManagement);

  if (restrictedUserMessage) restrictedUserMessage.classList.remove("hidden");
  if (superAdminContent) superAdminContent.classList.add("hidden");
}

function guardRestrictedActiveSection(user) {
  const userManagementSection = document.getElementById("userManagementSection");
  const dashboardSection = document.getElementById("dashboardSection");

  if (!userManagementSection || isSuperAdmin(user)) return;

  if (userManagementSection.classList.contains("active")) {
    userManagementSection.classList.remove("active");

    if (dashboardSection) {
      dashboardSection.classList.add("active");
    }

    if (typeof openSection === "function") {
      openSection("dashboardSection");
    }
  }
}

// =========================
// GLOBAL EXPORTS
// =========================

window.redirectToLogin = redirectToLogin;
window.bindLogoutButton = bindLogoutButton;
window.normalizeCurrentUser = normalizeCurrentUser;
window.getUserDisplayName = getUserDisplayName;
window.getRoleDisplayName = getRoleDisplayName;
window.getUserRoleLabel = getUserRoleLabel;
window.getSidebarBrandByRole = getSidebarBrandByRole;
window.setSidebarBrand = setSidebarBrand;
window.isSuperAdmin = isSuperAdmin;
window.isAdminRole = isAdminRole;
window.canAccessSection = canAccessSection;
window.forceHideElement = forceHideElement;
window.forceShowElement = forceShowElement;
window.initializeSession = initializeSession;
window.setUserHeaderInfo = setUserHeaderInfo;
window.setUserManagementVisibility = setUserManagementVisibility;
window.guardRestrictedActiveSection = guardRestrictedActiveSection;
