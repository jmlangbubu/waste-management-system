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

function normalizeCurrentUser(user) {
  if (!user) return null;

  return {
    id: user.id || null,
    fullName: user.fullName || user.full_name || "",
    username: user.username || "",
    role: user.role || "",
    divisionName: user.divisionName || user.division_name || ""
  };
}

function getUserDisplayName(user) {
  return user?.fullName || user?.username || "-";
}

function getUserRoleLabel(user) {
  if (!user) return "-";
  return `${user.role || "-"}${user.divisionName ? " • " + user.divisionName : ""}`;
}

function isSuperAdmin(user) {
  return user && user.role === "super_admin";
}

function canAccessSection(user, sectionId) {
  if (!user) return false;

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