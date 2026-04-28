// =========================
// NAVIGATION
// =========================

function setActiveNavButton(sectionId) {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    const target = btn.getAttribute("data-section");
    btn.classList.toggle("active", target === sectionId);
  });
}

function setPageTitleFromSection(sectionId) {
  const pageTitle = document.getElementById("pageTitle");
  if (!pageTitle) return;

  const titleMap = {
    [SECTION_IDS.dashboard]: "Dashboard Overview",
    [SECTION_IDS.records]: "Waste Records",
    [SECTION_IDS.appointments]: "Appointments",
    [SECTION_IDS.orientation]: "Orientation",
    [SECTION_IDS.complaints]: "Complaints",
    [SECTION_IDS.tracking]: "Live Tracking",
    [SECTION_IDS.userManagement]: "User Management"
  };

  pageTitle.textContent = titleMap[sectionId] || "Admin Panel";
}

function showSection(sectionId) {
  document.querySelectorAll(".content-section").forEach((section) => {
    section.classList.toggle("active", section.id === sectionId);
  });

  setActiveNavButton(sectionId);
  setPageTitleFromSection(sectionId);
}

// =========================
// SIDEBAR HELPERS
// =========================

function showSidebarToggleButton() {
  const toggleBtn = document.getElementById("sidebarToggleBtn");
  if (!toggleBtn) return;

  if (window.innerWidth <= 992) {
    toggleBtn.classList.remove("hidden-sidebar-toggle");
    toggleBtn.style.setProperty("display", "inline-flex", "important");
  }
}

function hideSidebarToggleButton() {
  const toggleBtn = document.getElementById("sidebarToggleBtn");
  if (!toggleBtn) return;

  toggleBtn.classList.add("hidden-sidebar-toggle");
  toggleBtn.style.setProperty("display", "none", "important");
}

function openMobileSidebar() {
  const sidebar = document.getElementById("dashboardSidebar");
  const backdrop = document.getElementById("sidebarBackdrop");

  if (!sidebar || !backdrop) return;

  sidebar.classList.add("open");
  backdrop.classList.remove("hidden");
  hideSidebarToggleButton();
}

function closeMobileSidebar() {
  const sidebar = document.getElementById("dashboardSidebar");
  const backdrop = document.getElementById("sidebarBackdrop");

  if (!sidebar || !backdrop) return;

  sidebar.classList.remove("open");
  backdrop.classList.add("hidden");

  if (window.innerWidth <= 992) {
    showSidebarToggleButton();
  }
}

// =========================
// SECTION OPENING
// =========================

function openSection(sectionId) {
  if (!canAccessSection(currentUser, sectionId)) {
    showSection(SECTION_IDS.dashboard);
    closeMobileSidebar();
    return;
  }

  showSection(sectionId);

  if (sectionId === SECTION_IDS.appointments) {
    notificationsSeen = true;
    const notificationCount = document.getElementById("notificationCount");
    if (notificationCount) notificationCount.textContent = "0";
  }

  if (sectionId === SECTION_IDS.orientation) {
    if (typeof loadOrientationAppointments === "function") {
      loadOrientationAppointments();
    }
  }

  if (sectionId === SECTION_IDS.complaints) {
    if (typeof loadComplaints === "function") {
      loadComplaints();
    }
  }

  if (sectionId === SECTION_IDS.tracking) {
    if (typeof initializeTruckMap === "function") {
      initializeTruckMap();
    }

    if (typeof startTrackingAutoRefresh === "function") {
      startTrackingAutoRefresh();
    } else if (typeof loadActiveTrucks === "function") {
      loadActiveTrucks();
    }

    setTimeout(() => {
      if (typeof truckMap !== "undefined" && truckMap) {
        truckMap.invalidateSize();
      }
    }, 200);
  } else {
    if (typeof stopTrackingAutoRefresh === "function") {
      stopTrackingAutoRefresh();
    }
  }

  closeMobileSidebar();
}

function setupProtectedNavigation() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetSection = btn.getAttribute("data-section");
      openSection(targetSection);
    });
  });
}

// =========================
// SIDEBAR
// =========================

function bindSidebarToggle() {
  const sidebar = document.getElementById("dashboardSidebar");
  const toggleBtn = document.getElementById("sidebarToggleBtn");
  const backdrop = document.getElementById("sidebarBackdrop");

  if (!sidebar || !toggleBtn || !backdrop) return;

  toggleBtn.addEventListener("click", () => {
    if (sidebar.classList.contains("open")) {
      closeMobileSidebar();
    } else {
      openMobileSidebar();
    }
  });

  backdrop.addEventListener("click", closeMobileSidebar);

  window.addEventListener("resize", () => {
    if (window.innerWidth > 992) {
      sidebar.classList.remove("open");
      backdrop.classList.add("hidden");
      hideSidebarToggleButton();
      return;
    }

    if (sidebar.classList.contains("open")) {
      hideSidebarToggleButton();
    } else {
      showSidebarToggleButton();
    }
  });

  if (window.innerWidth <= 992) {
    showSidebarToggleButton();
  } else {
    hideSidebarToggleButton();
  }
}
