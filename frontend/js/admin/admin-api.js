// =========================
// API CONSTANTS
// =========================

function getAppApiBase() {
  if (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) {
    return window.APP_CONFIG.API_BASE_URL;
  }

  if (window.API_BASE) {
    return window.API_BASE;
  }

  console.error("API BASE URL is not defined. Check config.js / APP_CONFIG.");
  return "";
}

// USERS
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

// APPOINTMENTS
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

// ORIENTATION
function getOrientationAppointmentsApiUrl() {
  return `${getAppApiBase()}/appointments/orientation`;
}

function getGenerateOrientationQrApiUrl(id) {
  return `${getAppApiBase()}/appointments/${id}/generate-orientation-qr`;
}

// NOTIFICATIONS
function getNotificationsApiUrl() {
  return `${getAppApiBase()}/notifications`;
}

// TRACKING
function getTrackingActiveApiUrl() {
  return `${getAppApiBase()}/tracking/active`;
}

function getTrackingRouteApiUrl(sessionId) {
  return `${getAppApiBase()}/tracking/route/${sessionId}`;
}

function getTrackingForceStopApiUrl(sessionId) {
  return `${getAppApiBase()}/tracking/force-stop/${sessionId}`;
}

// COMPLAINTS
function getComplaintsApiUrl() {
  return `${getAppApiBase()}/complaints`;
}

function getRescheduleAppointmentUrl(id) {
  return `${getAppApiBase()}/appointments/${id}/reschedule`;
}

function getCancelAppointmentUrl(id) {
  return `${getAppApiBase()}/appointments/${id}/cancel`;
}