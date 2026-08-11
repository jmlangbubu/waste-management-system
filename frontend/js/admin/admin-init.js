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

    // Tracking module
    safeRun(initializeTruckMap, "initializeTruckMap");
    safeRun(setupDispatchModule, "setupDispatchModule");
    safeRun(startTrackingAutoRefresh, "startTrackingAutoRefresh");
    await safeRun(loadTrackingReports, "loadTrackingReports");

    await safeRun(loadRecords, "loadRecords");
    await safeRun(loadAppointments, "loadAppointments");
    if (isSuperAdmin(currentUser)) {
      await safeRun(loadPersonnel, "loadPersonnel");
      await safeRun(loadWebUsers, "loadWebUsers");
    }
    await safeRun(loadMonitoringPreview, "loadMonitoringPreview");

    await safeRun(() => loadNotifications(false), "loadNotifications");
    safeRun(startNotificationPolling, "startNotificationPolling");

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
