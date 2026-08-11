(() => {
  const applicationOrigin = window.location.origin;
  const apiBaseUrl = `${applicationOrigin}/api`;

  window.APP_CONFIG = {
    BASE_URL: applicationOrigin,
    API_BASE_URL: apiBaseUrl,

    APPOINTMENTS_ACTIVE_URL: `${apiBaseUrl}/appointments/active`,
    APPOINTMENTS_HISTORY_URL: `${apiBaseUrl}/appointments/history`,

    getAppointmentDecisionUrl: function (id) {
      return `${this.API_BASE_URL}/appointments/${id}/decision`;
    },

    getRescheduleAppointmentUrl: function (id) {
      return `${this.API_BASE_URL}/appointments/${id}/reschedule`;
    },

    getCancelAppointmentUrl: function (id) {
      return `${this.API_BASE_URL}/appointments/${id}/cancel`;
    }
  };
})();
