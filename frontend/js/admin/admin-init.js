// =========================
// ADMIN INITIALIZATION
// =========================

document.addEventListener("DOMContentLoaded", async () => {
  try {
    if (!(await initializeSession())) return;

    bindLogoutButton?.();
    bindSidebarToggle?.();
    setupProtectedNavigation?.();

    bindNotificationActions?.();

    setupWasteRecordFilters?.();
    setupWasteRecordTableClicks?.();
    setupWasteBreakdownModal?.();
    setupValidationDetailsModal?.();
    setupWasteRecordValidationButtons?.();
    setupWasteCorrectionUi?.();

    initializeAppointments?.();

    setupAccountSearch?.();
    setupAccountPlatformForm?.();
    setupCreateAccountForm?.();

    setupOrientationQrModal?.();

    setupComplaintsModule?.();
    setupComplaintResolutionModal?.();

    bindTruckAnalyticsModalActions?.();

    setupDashboardRangeFilters?.();
    setupCategoryRangeFilters?.();

    // Existing operational modules retain their super_admin/personnel scope.
    if (hasWebCapability(currentUser, "fleet.view")) {
      safeRun(initializeFleetMonitoring, "initializeFleetMonitoring");
    }
    if (hasWebCapability(currentUser, "dispatch.view")) {
      safeRun(setupDispatchModule, "setupDispatchModule");
      safeRun(setupDispatchPlansModule, "setupDispatchPlansModule");
    }
    if (hasWebCapability(currentUser, "tracking.view")) {
      safeRun(initializeTruckMap, "initializeTruckMap");
      safeRun(startTrackingAutoRefresh, "startTrackingAutoRefresh");
      await safeRun(loadTrackingReports, "loadTrackingReports");
    }

    if (hasWebCapability(currentUser, "waste.view")) {
      await safeRun(loadRecords, "loadRecords");
    }
    if (hasWebCapability(currentUser, "appointments.view")) {
      await safeRun(loadAppointments, "loadAppointments");
    }
    if (isSuperAdmin(currentUser)) {
      await safeRun(loadPersonnel, "loadPersonnel");
      await safeRun(loadWebUsers, "loadWebUsers");
    }
    if (hasWebCapability(currentUser, "orientation.view")) {
      await safeRun(loadMonitoringPreview, "loadMonitoringPreview");
    }

    if (hasWebCapability(currentUser, "notifications.view")) {
      await safeRun(() => loadNotifications(false), "loadNotifications");
      safeRun(startNotificationPolling, "startNotificationPolling");
    }

    safeRun(initializeDashboardData, "initializeDashboardData");
    safeRun(() => renderDashboardRecentRecords(validatedWasteRecords), "renderDashboardRecentRecords");

    openSection(SECTION_IDS.dashboard);
  } catch (error) {
    console.error("Admin initialization failed:", error);
  }
});

async function safeRun(fn, label) {
  try {
    if (typeof fn === "function") {
      await fn();
    }
  } catch (error) {
    console.error(`${label} failed:`, error);
  }
}
