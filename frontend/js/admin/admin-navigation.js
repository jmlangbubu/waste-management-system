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
// GLOBAL MODAL CLEANUP
// =========================

function closeAllAdminModalsOnNavigation() {
  const modalSelectors = [
    ".custom-modal",
    ".modal",
    ".admin-modal",
    ".other-modal",

    "#appointmentHistoryModal",
    "#appointmentDetailsModal",
    "#appointmentRescheduleModal",
    "#appointmentRejectModal",

    "#complaintDetailsModal",
    "#complaintMapModal",
    "#complaintHistoryModal",
    "#complaintResolutionModal",

    "#incomingInvoiceModal",
    "#invoiceTrackingModal",

    "#calendarActivitiesModal",
    "#calendarAddActivityModal",

    "#orientationQrModal",
    "#orientationReportModal",
    "#orientationExamModal",

    "#deactivatedAccountsModal",
    "#userHistoryModal"
  ];

  document.querySelectorAll(modalSelectors.join(",")).forEach((modal) => {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  });

  /*
    Remove temporary image preview modal if open.
  */
  document.querySelectorAll(".image-preview-modal").forEach((preview) => {
    preview.remove();
  });

  /*
    Close Other dropdown/submenu if it is open.
    Safe kahit iba-iba ang class name na gamit mo.
  */
  document.querySelectorAll(
    ".sidebar-other-menu, .other-submenu, .other-dropdown, #sidebarOtherMenu"
  ).forEach((menu) => {
    menu.classList.add("hidden");
    menu.classList.remove("open", "show", "active");
  });

  const otherTrigger = document.getElementById("sidebarOtherTrigger");
  if (otherTrigger) {
    otherTrigger.setAttribute("aria-expanded", "false");
  }

  /*
    Reset complaint/map selected state safely if variables exist.
    Wrapped in try blocks para hindi masira if wala yung module sa page.
  */
  try {
    if (typeof selectedBarangayCandidate !== "undefined") {
      selectedBarangayCandidate = null;
    }
  } catch (error) {
    console.warn("selectedBarangayCandidate cleanup skipped:", error);
  }

  try {
    if (typeof currentComplaint !== "undefined") {
      currentComplaint = null;
    }
  } catch (error) {
    console.warn("currentComplaint cleanup skipped:", error);
  }

  try {
    if (typeof currentComplaintResolution !== "undefined") {
      currentComplaintResolution = null;
    }
  } catch (error) {
    console.warn("currentComplaintResolution cleanup skipped:", error);
  }
}

// =========================
// SIDEBAR HELPERS
// =========================

function isMobileSidebarMode() {
  return window.innerWidth <= 992;
}

function getAdminLayout() {
  return document.getElementById("adminLayout") || document.querySelector(".admin-layout");
}

function getSidebarToggleButtons() {
  return {
    logoToggle: document.getElementById("sidebarLogoToggleBtn"),
    mobileToggle: document.getElementById("mobileSidebarToggleBtn")
      || document.getElementById("sidebarToggleBtn")
  };
}

function updateSidebarToggleIcon() {
  const layout = getAdminLayout();
  const sidebar = document.getElementById("dashboardSidebar");
  const { logoToggle, mobileToggle } = getSidebarToggleButtons();

  const isMobile = isMobileSidebarMode();
  const isCollapsed = layout?.classList.contains("sidebar-collapsed");
  const isOpen = sidebar?.classList.contains("open");

  if (logoToggle) {
    logoToggle.setAttribute(
      "aria-label",
      isCollapsed ? "Expand sidebar" : "Collapse sidebar"
    );

    logoToggle.setAttribute(
      "title",
      isCollapsed ? "Expand sidebar" : "Collapse sidebar"
    );
  }

  if (mobileToggle) {
    mobileToggle.textContent = isOpen ? "×" : "☰";
    mobileToggle.setAttribute("aria-label", isOpen ? "Close sidebar" : "Open sidebar");
    mobileToggle.setAttribute("title", isOpen ? "Close sidebar" : "Open sidebar");

    /*
      Desktop topbar hamburger must stay hidden.
      Mobile/tablet only uses the topbar button.
    */
    if (isMobile) {
      mobileToggle.classList.remove("hidden-sidebar-toggle");
      mobileToggle.style.setProperty("display", "inline-flex", "important");
    } else {
      mobileToggle.classList.add("hidden-sidebar-toggle");
      mobileToggle.style.setProperty("display", "none", "important");
    }
  }
}

function showSidebarToggleButton() {
  setupSidebarOtherMenu();
  updateSidebarToggleIcon();
}

function hideSidebarToggleButton() {
  const { mobileToggle } = getSidebarToggleButtons();

  if (!mobileToggle) return;

  /*
    Hide only the mobile/topbar toggle when the mobile drawer is open.
    The sidebar logo toggle remains available inside the drawer.
  */
  if (isMobileSidebarMode()) {
    mobileToggle.classList.add("hidden-sidebar-toggle");
    mobileToggle.style.setProperty("display", "none", "important");
  }

  updateSidebarToggleIcon();
}

function saveSidebarCollapsedState(isCollapsed) {
  try {
    localStorage.setItem("adminSidebarCollapsed", isCollapsed ? "true" : "false");
  } catch (error) {
    console.warn("Sidebar state save skipped:", error);
  }
}

function applySavedSidebarCollapsedState() {
  const layout = getAdminLayout();
  if (!layout || isMobileSidebarMode()) return;

  try {
    const savedState = localStorage.getItem("adminSidebarCollapsed");

    if (savedState === "true") {
      layout.classList.add("sidebar-collapsed");
    } else {
      layout.classList.remove("sidebar-collapsed");
    }
  } catch (error) {
    console.warn("Sidebar state restore skipped:", error);
  }

  updateSidebarToggleIcon();
}

function resizeAdminMapsAfterSidebarChange() {
  setTimeout(() => {
    try {
      if (typeof truckMap !== "undefined" && truckMap) {
        truckMap.invalidateSize();
      }
    } catch (error) {
      console.warn("Truck map resize after sidebar collapse skipped:", error);
    }

    try {
      if (typeof complaintLeafletMap !== "undefined" && complaintLeafletMap) {
        complaintLeafletMap.invalidateSize();
      }
    } catch (error) {
      console.warn("Complaint map resize after sidebar collapse skipped:", error);
    }
  }, 320);
}

function toggleDesktopSidebarCollapse() {
  const layout = getAdminLayout();
  if (!layout) return;

  layout.classList.toggle("sidebar-collapsed");

  const isCollapsed = layout.classList.contains("sidebar-collapsed");
  saveSidebarCollapsedState(isCollapsed);
  updateSidebarToggleIcon();
  resizeAdminMapsAfterSidebarChange();
}

function expandDesktopSidebar() {
  const layout = getAdminLayout();
  if (!layout || isMobileSidebarMode()) return;

  if (layout.classList.contains("sidebar-collapsed")) {
    layout.classList.remove("sidebar-collapsed");
    saveSidebarCollapsedState(false);
    updateSidebarToggleIcon();
    resizeAdminMapsAfterSidebarChange();
  }
}

function openMobileSidebar() {
  const sidebar = document.getElementById("dashboardSidebar");
  const backdrop = document.getElementById("sidebarBackdrop");

  if (!sidebar || !backdrop) return;

  sidebar.classList.add("open");
  backdrop.classList.remove("hidden");
  hideSidebarToggleButton();
  updateSidebarToggleIcon();
}

function closeMobileSidebar() {
  const sidebar = document.getElementById("dashboardSidebar");
  const backdrop = document.getElementById("sidebarBackdrop");

  if (!sidebar || !backdrop) return;

  sidebar.classList.remove("open");
  backdrop.classList.add("hidden");

  if (isMobileSidebarMode()) {
    showSidebarToggleButton();
  }

  updateSidebarToggleIcon();
}

// =========================
// SECTION OPENING
// =========================

function openSection(sectionId) {
  if (!canAccessSection(currentUser, sectionId)) {
    closeAllAdminModalsOnNavigation();
    showSection(SECTION_IDS.dashboard);
    closeMobileSidebar();
    return;
  }

  closeAllAdminModalsOnNavigation();
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

  if (sectionId === SECTION_IDS.records) {
    if (typeof loadRecords === "function") {
      loadRecords();
    } else if (typeof loadWasteRecords === "function") {
      loadWasteRecords();
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
    }, 220);
  } else {
    if (typeof stopTrackingAutoRefresh === "function") {
      stopTrackingAutoRefresh();
    }
  }

  closeMobileSidebar();
}

function setupProtectedNavigation() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    if (btn.dataset.navBound === "true") return;

    btn.dataset.navBound = "true";
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
  const backdrop = document.getElementById("sidebarBackdrop");
  const layout = getAdminLayout();
  const { logoToggle, mobileToggle } = getSidebarToggleButtons();

  if (!sidebar || !backdrop || !layout) return;

  /*
    Sidebar logo controls desktop collapse/expand.
    On mobile, logo closes/opens the drawer only if drawer is already reachable.
  */
  if (logoToggle && logoToggle.dataset.sidebarLogoToggleBound !== "true") {
    logoToggle.dataset.sidebarLogoToggleBound = "true";

    logoToggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (isMobileSidebarMode()) {
        if (sidebar.classList.contains("open")) {
          closeMobileSidebar();
        } else {
          openMobileSidebar();
        }

        return;
      }

      toggleDesktopSidebarCollapse();
    });
  }

  /*
    Topbar hamburger is mobile/tablet only.
    It is hidden on desktop by CSS and JS.
  */
  if (mobileToggle && mobileToggle.dataset.sidebarToggleBound !== "true") {
    mobileToggle.dataset.sidebarToggleBound = "true";

    mobileToggle.addEventListener("click", () => {
      if (sidebar.classList.contains("open")) {
        closeMobileSidebar();
      } else {
        openMobileSidebar();
      }
    });
  }

  /*
    Clicking empty sidebar space while collapsed expands it.
    Nav icons still navigate normally, so we do not hijack nav button clicks.
  */
  if (sidebar.dataset.sidebarExpandClickBound !== "true") {
    sidebar.dataset.sidebarExpandClickBound = "true";

    sidebar.addEventListener("click", (event) => {
      if (isMobileSidebarMode()) return;
      if (!layout.classList.contains("sidebar-collapsed")) return;

      const ignoredClick = event.target.closest(
        ".nav-btn, .sidebar-logo-toggle, .sidebar-other-trigger, .sidebar-other-btn, .logout-btn, button, a"
      );

      if (ignoredClick) return;

      expandDesktopSidebar();
    });
  }

  if (backdrop.dataset.sidebarBackdropBound !== "true") {
    backdrop.dataset.sidebarBackdropBound = "true";
    backdrop.addEventListener("click", closeMobileSidebar);
  }

  if (window.__sidebarResizeBound !== true) {
    window.__sidebarResizeBound = true;

    window.addEventListener("resize", () => {
      if (!isMobileSidebarMode()) {
        sidebar.classList.remove("open");
        backdrop.classList.add("hidden");
        applySavedSidebarCollapsedState();
        updateSidebarToggleIcon();
        return;
      }

      /*
        Mobile/tablet keeps drawer behavior.
        Do not visually collapse labels on mobile.
      */
      sidebar.classList.remove("open");
      backdrop.classList.add("hidden");
      updateSidebarToggleIcon();
    });
  }

  if (isMobileSidebarMode()) {
    sidebar.classList.remove("open");
    backdrop.classList.add("hidden");
  } else {
    sidebar.classList.remove("open");
    backdrop.classList.add("hidden");
    applySavedSidebarCollapsedState();
  }

  updateSidebarToggleIcon();
}



// =========================
// SIDEBAR OTHER MENU
// =========================

function setupSidebarOtherMenu() {
  const otherTrigger = document.getElementById("sidebarOtherTrigger");
  const otherMenu = document.getElementById("sidebarOtherMenu");

  if (!otherTrigger || !otherMenu) return;

  if (otherTrigger.dataset.otherMenuBound === "true") return;
  otherTrigger.dataset.otherMenuBound = "true";

  otherTrigger.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    const isHidden = otherMenu.classList.contains("hidden");

    otherMenu.classList.toggle("hidden", !isHidden);
    otherMenu.classList.toggle("open", isHidden);

    otherTrigger.setAttribute("aria-expanded", isHidden ? "true" : "false");
  });

  /*
    Do not close immediately when clicking inside submenu.
  */
  otherMenu.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  /*
    Close when clicking outside.
  */
  document.addEventListener("click", (event) => {
    const clickedInsideOther = event.target.closest("#sidebarOtherGroup");

    if (clickedInsideOther) return;

    otherMenu.classList.add("hidden");
    otherMenu.classList.remove("open");
    otherTrigger.setAttribute("aria-expanded", "false");
  });

  /*
    Close after choosing a submenu action.
  */
  otherMenu.querySelectorAll(".sidebar-other-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      otherMenu.classList.add("hidden");
      otherMenu.classList.remove("open");
      otherTrigger.setAttribute("aria-expanded", "false");
    });
  });
}



/* =========================
   AUTO INIT SIDEBAR OTHER MENU
   Fallback so Other submenu still works even if bindSidebarToggle()
   is not called by admin-init.js for any reason.
========================= */
(function initSidebarOtherMenuWhenReady() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      if (typeof setupSidebarOtherMenu === "function") {
        setupSidebarOtherMenu();
      }
    });
    return;
  }

  if (typeof setupSidebarOtherMenu === "function") {
    setupSidebarOtherMenu();
  }
})();

// =========================
// GLOBAL EXPORTS
// =========================

window.setActiveNavButton = setActiveNavButton;
window.setPageTitleFromSection = setPageTitleFromSection;
window.showSection = showSection;
window.closeAllAdminModalsOnNavigation = closeAllAdminModalsOnNavigation;
window.isMobileSidebarMode = isMobileSidebarMode;
window.getAdminLayout = getAdminLayout;
window.updateSidebarToggleIcon = updateSidebarToggleIcon;
window.showSidebarToggleButton = showSidebarToggleButton;
window.hideSidebarToggleButton = hideSidebarToggleButton;
window.saveSidebarCollapsedState = saveSidebarCollapsedState;
window.applySavedSidebarCollapsedState = applySavedSidebarCollapsedState;
window.toggleDesktopSidebarCollapse = toggleDesktopSidebarCollapse;
window.expandDesktopSidebar = expandDesktopSidebar;
window.openMobileSidebar = openMobileSidebar;
window.closeMobileSidebar = closeMobileSidebar;
window.openSection = openSection;
window.setupProtectedNavigation = setupProtectedNavigation;
window.setupSidebarOtherMenu = setupSidebarOtherMenu;
window.bindSidebarToggle = bindSidebarToggle;
