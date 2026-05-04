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
  closeSidebarOtherMenu();

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

  closeSidebarOtherMenu();

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
// SIDEBAR OTHER MENU CLEANUP
// =========================

let sidebarOtherOriginalParent = null;
let sidebarOtherPlaceholder = null;

function getSidebarOtherElements() {
  return {
    otherGroup: document.getElementById("sidebarOtherGroup"),
    otherTrigger: document.getElementById("sidebarOtherTrigger"),
    otherMenu: document.getElementById("sidebarOtherMenu")
  };
}

function closeSidebarOtherMenu() {
  const { otherTrigger, otherMenu } = getSidebarOtherElements();

  if (otherMenu) {
    otherMenu.classList.add("hidden");
    otherMenu.classList.remove("open", "show", "active");

    otherMenu.style.removeProperty("--other-menu-left");
    otherMenu.style.removeProperty("--other-menu-top");
    otherMenu.style.removeProperty("left");
    otherMenu.style.removeProperty("top");
  }

  if (otherTrigger) {
    otherTrigger.setAttribute("aria-expanded", "false");
  }
}

function mountSidebarOtherMenuForMode() {
  const { otherGroup, otherMenu } = getSidebarOtherElements();

  if (!otherGroup || !otherMenu) return;

  if (!sidebarOtherOriginalParent) {
    sidebarOtherOriginalParent = otherMenu.parentElement;
  }

  if (!sidebarOtherPlaceholder) {
    sidebarOtherPlaceholder = document.createComment("sidebarOtherMenu original position");
    otherMenu.parentNode.insertBefore(sidebarOtherPlaceholder, otherMenu);
  }

  /*
    Desktop:
    Move the submenu to <body> so it cannot be clipped by sidebar,
    main-content, overflow, transform, or stacking contexts.
  */
  if (!isMobileSidebarMode()) {
    if (otherMenu.parentElement !== document.body) {
      document.body.appendChild(otherMenu);
    }

    otherMenu.classList.add("sidebar-other-menu-portal");
    return;
  }

  /*
    Mobile/tablet:
    Put it back inside the sidebar so it behaves as a normal dropdown.
  */
  if (sidebarOtherPlaceholder && sidebarOtherPlaceholder.parentNode) {
    sidebarOtherPlaceholder.parentNode.insertBefore(otherMenu, sidebarOtherPlaceholder.nextSibling);
  } else if (sidebarOtherOriginalParent) {
    sidebarOtherOriginalParent.appendChild(otherMenu);
  }

  otherMenu.classList.remove("sidebar-other-menu-portal");
}

function positionSidebarOtherMenu() {
  const { otherTrigger, otherMenu } = getSidebarOtherElements();

  if (!otherTrigger || !otherMenu) return;

  mountSidebarOtherMenuForMode();

  if (isMobileSidebarMode()) {
    otherMenu.style.removeProperty("--other-menu-left");
    otherMenu.style.removeProperty("--other-menu-top");
    otherMenu.style.removeProperty("left");
    otherMenu.style.removeProperty("top");
    return;
  }

  const triggerRect = otherTrigger.getBoundingClientRect();
  const menuWidth = 260;
  const gap = 14;

  const wasHidden = otherMenu.classList.contains("hidden");

  if (wasHidden) {
    otherMenu.style.visibility = "hidden";
    otherMenu.style.display = "grid";
  }

  const menuHeight = otherMenu.offsetHeight || 116;

  if (wasHidden) {
    otherMenu.style.removeProperty("display");
    otherMenu.style.removeProperty("visibility");
  }

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = triggerRect.right + gap;
  let top = triggerRect.top + (triggerRect.height / 2) - (menuHeight / 2);

  /*
    If there is not enough room on the right, place it inside the viewport.
  */
  if (left + menuWidth > viewportWidth - 12) {
    left = Math.max(12, viewportWidth - menuWidth - 12);
  }

  top = Math.max(12, Math.min(top, viewportHeight - menuHeight - 12));

  otherMenu.style.setProperty("--other-menu-left", `${left}px`);
  otherMenu.style.setProperty("--other-menu-top", `${top}px`);
}

function isClickInsideSidebarOther(event) {
  const clickedOtherGroup = event.target.closest("#sidebarOtherGroup");
  const clickedOtherMenu = event.target.closest("#sidebarOtherMenu");

  return Boolean(clickedOtherGroup || clickedOtherMenu);
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
  closeSidebarOtherMenu();

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

    btn.addEventListener("pointerdown", () => {
      closeSidebarOtherMenu();
    });

    btn.addEventListener("click", () => {
      closeSidebarOtherMenu();

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

      closeSidebarOtherMenu();

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
      closeSidebarOtherMenu();

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
      closeSidebarOtherMenu();
      mountSidebarOtherMenuForMode();

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

  setupSidebarOtherMenu();
  updateSidebarToggleIcon();
}



// =========================
// SIDEBAR OTHER MENU
// =========================

function setupSidebarOtherMenu() {
  const { otherGroup, otherTrigger, otherMenu } = getSidebarOtherElements();

  if (!otherGroup || !otherTrigger || !otherMenu) return;

  mountSidebarOtherMenuForMode();

  if (otherTrigger.dataset.otherMenuBound !== "true") {
    otherTrigger.dataset.otherMenuBound = "true";

    otherTrigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      const willOpen = otherMenu.classList.contains("hidden");

      if (willOpen) {
        positionSidebarOtherMenu();
      }

      otherMenu.classList.toggle("hidden", !willOpen);
      otherMenu.classList.toggle("open", willOpen);

      otherTrigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
    });
  }

  if (otherMenu.dataset.otherMenuInsideClickBound !== "true") {
    otherMenu.dataset.otherMenuInsideClickBound = "true";

    otherMenu.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  }

  if (document.body.dataset.sidebarOtherOutsideBound !== "true") {
    document.body.dataset.sidebarOtherOutsideBound = "true";

    document.addEventListener("pointerdown", (event) => {
      if (isClickInsideSidebarOther(event)) return;
      closeSidebarOtherMenu();
    }, true);

    document.addEventListener("click", (event) => {
      if (isClickInsideSidebarOther(event)) return;
      closeSidebarOtherMenu();
    }, true);
  }

  if (window.__sidebarOtherPositionBound !== true) {
    window.__sidebarOtherPositionBound = true;

    window.addEventListener("resize", () => {
      mountSidebarOtherMenuForMode();

      if (!otherMenu.classList.contains("hidden")) {
        positionSidebarOtherMenu();
      }
    });

    window.addEventListener("scroll", () => {
      if (!otherMenu.classList.contains("hidden")) {
        positionSidebarOtherMenu();
      }
    }, true);
  }

  otherMenu.querySelectorAll(".sidebar-other-btn").forEach((btn) => {
    if (btn.dataset.sidebarOtherActionBound === "true") return;
    btn.dataset.sidebarOtherActionBound = "true";

    btn.addEventListener("click", () => {
      closeSidebarOtherMenu();

      if (isMobileSidebarMode()) {
        setTimeout(() => {
          closeMobileSidebar();
        }, 80);
      }
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
window.closeSidebarOtherMenu = closeSidebarOtherMenu;
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
window.positionSidebarOtherMenu = positionSidebarOtherMenu;
window.mountSidebarOtherMenuForMode = mountSidebarOtherMenuForMode;
window.bindSidebarToggle = bindSidebarToggle;
