// =========================
// NAVIGATION
// =========================

function setActiveNavButton(sectionId) {
  const navButtons = document.querySelectorAll(".nav-btn");

  navButtons.forEach((btn) => {
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
  const sections = document.querySelectorAll(".content-section");

  sections.forEach((section) => {
    section.classList.toggle("active", section.id === sectionId);
  });

  setActiveNavButton(sectionId);
  setPageTitleFromSection(sectionId);
}

function closeMobileSidebar() {
  const sidebar = document.getElementById("dashboardSidebar");
  const backdrop = document.getElementById("sidebarBackdrop");

  if (window.innerWidth <= 992) {
    sidebar?.classList.remove("open");
    backdrop?.classList.add("hidden");
  }
}

function openSection(sectionId) {
  if (!canAccessSection(currentUser, sectionId)) {
    showSection(SECTION_IDS.dashboard);
    closeMobileSidebar();
    return;
  }

  showSection(sectionId);

  // SECTION-BASED LOGIC

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
      if (truckMap) truckMap.invalidateSize();
    }, 200);
  } else {
    if (typeof stopTrackingAutoRefresh === "function") {
      stopTrackingAutoRefresh();
    }
  }

  closeMobileSidebar();
}

function setupProtectedNavigation() {
  const navButtons = document.querySelectorAll(".nav-btn");

  navButtons.forEach((btn) => {
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
    sidebar.classList.toggle("open");
    backdrop.classList.toggle("hidden");
  });

  backdrop.addEventListener("click", () => {
    sidebar.classList.remove("open");
    backdrop.classList.add("hidden");
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 992) {
      sidebar.classList.remove("open");
      backdrop.classList.add("hidden");
    }
  });
}