window.APP_CONFIG = {
  BASE_URL: "https://waste-management-system-1-qon2.onrender.com",
  API_BASE_URL: "https://waste-management-system-1-qon2.onrender.com/api",

  APPOINTMENTS_ACTIVE_URL: "https://waste-management-system-1-qon2.onrender.com/api/appointments/active",
  APPOINTMENTS_HISTORY_URL: "https://waste-management-system-1-qon2.onrender.com/api/appointments/history",

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
