// =========================
// API CONSTANTS
// =========================

function getAppApiBase() {
  if (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) {
    return window.APP_CONFIG.API_BASE_URL.replace(/\/$/, "");
  }

  if (window.API_BASE) {
    return window.API_BASE.replace(/\/$/, "");
  }

  console.error("API BASE URL is not defined. Check config.js / APP_CONFIG.");
  return "";
}

// =========================
// USERS
// =========================

function getWebUsersApiUrl() {
  return `${getAppApiBase()}/web-users/all`;
}

function getAccountsApiUrl() {
  return `${getAppApiBase()}/web-users/all-accounts`;
}

function getCreateWebUserApiUrl() {
  return `${getAppApiBase()}/web-users/create`;
}

function getCreateMobileUserApiUrl() {
  return `${getAppApiBase()}/web-users/create-mobile-account`;
}

// =========================
// APPOINTMENTS
// =========================

function getAppointmentsApiUrl() {
  return `${getAppApiBase()}/appointments`;
}

function getActiveAppointmentsApiUrl() {
  return `${getAppApiBase()}/appointments/active`;
}

function getAppointmentHistoryApiUrl() {
  return `${getAppApiBase()}/appointments/history`;
}

function getAppointmentDecisionApiUrl(id) {
  return `${getAppApiBase()}/appointments/${id}/decision`;
}

function getRescheduleAppointmentUrl(id) {
  return `${getAppApiBase()}/appointments/${id}/reschedule`;
}

function getCancelAppointmentUrl(id) {
  return `${getAppApiBase()}/appointments/${id}/cancel`;
}

// =========================
// ORIENTATION
// =========================

function getOrientationAppointmentsApiUrl() {
  return `${getAppApiBase()}/appointments/orientation`;
}

function getGenerateOrientationQrApiUrl(id) {
  return `${getAppApiBase()}/appointments/${id}/generate-orientation-qr`;
}

// =========================
// NOTIFICATIONS
// =========================

function getNotificationsApiUrl() {
  return `${getAppApiBase()}/notifications`;
}

// =========================
// TRACKING
// =========================

function getTrackingActiveApiUrl() {
  return `${getAppApiBase()}/tracking/active`;
}

function getTrackingRouteApiUrl(sessionId) {
  return `${getAppApiBase()}/tracking/route/${encodeURIComponent(sessionId)}`;
}

function getTrackingForceStopApiUrl(sessionId) {
  return `${getAppApiBase()}/tracking/force-stop/${encodeURIComponent(sessionId)}`;
}

function getTrackingReportsApiUrl() {
  return `${getAppApiBase()}/tracking/reports`;
}

function getTrackingReportDetailsApiUrl(sessionId) {
  return `${getAppApiBase()}/tracking/reports/${encodeURIComponent(sessionId)}`;
}

// =========================
// DISPATCH
// =========================

function getDispatchTicketsApiUrl() {
  return `${getAppApiBase()}/dispatch/tickets`;
}

function getDispatchTicketApiUrl(ticketId) {
  return `${getDispatchTicketsApiUrl()}/${encodeURIComponent(ticketId)}`;
}

function getDispatchLiveApiUrl() {
  return `${getAppApiBase()}/dispatch/live`;
}

function getDispatchTrackingSessionApiUrl(sessionId) {
  return `${getAppApiBase()}/dispatch/tracking-sessions/${encodeURIComponent(sessionId)}`;
}

function getDispatchReportsApiUrl() {
  return `${getAppApiBase()}/dispatch/reports`;
}

function getDispatchDestinationsApiUrl(filters = {}) {
  const parameters = new URLSearchParams();
  if (filters.q) parameters.set("q", filters.q);
  if (filters.barangay) parameters.set("barangay", filters.barangay);
  if (filters.type) parameters.set("type", filters.type);
  parameters.set("limit", String(filters.limit || 10));
  return `${getAppApiBase()}/dispatch/destinations?${parameters}`;
}

function getDispatchDestinationApiUrl(destinationId) {
  return `${getAppApiBase()}/dispatch/destinations/${encodeURIComponent(destinationId)}`;
}

function getDispatchLocationLabelApiUrl(latitude, longitude) {
  const parameters = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude)
  });
  return `${getAppApiBase()}/complaints/detect-barangay?${parameters}`;
}

// =========================
// COMPLAINTS
// =========================

function getComplaintsApiUrl() {
  return `${getAppApiBase()}/complaints`;
}

function getComplaintDetailsApiUrl(id) {
  return `${getAppApiBase()}/complaints/${encodeURIComponent(id)}`;
}

function getComplaintValidateApiUrl(id) {
  return `${getAppApiBase()}/complaints/${encodeURIComponent(id)}/validate`;
}

function getComplaintRejectApiUrl(id) {
  return `${getAppApiBase()}/complaints/${encodeURIComponent(id)}/reject`;
}

function getComplaintHistoryApiUrl() {
  return `${getAppApiBase()}/complaints/history`;
}

function getComplaintResolutionApiUrl(id) {
  return `${getAppApiBase()}/complaints/${encodeURIComponent(id)}/resolution`;
}

function getBarangayComplaintsApiUrl() {
  return `${getAppApiBase()}/complaints/barangay`;
}

function getBarangayComplaintResolveApiUrl(id) {
  return `${getAppApiBase()}/complaints/${encodeURIComponent(id)}/resolve`;
}
