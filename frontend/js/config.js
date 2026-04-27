window.APP_CONFIG = {
  BASE_URL: "http://192.168.1.37:8081",
  API_BASE_URL: "http://192.168.1.37:8081/api",

  APPOINTMENTS_ACTIVE_URL: "http://192.168.1.37:8081/api/appointments/active",
  APPOINTMENTS_HISTORY_URL: "http://192.168.1.37:8081/api/appointments/history",

  getAppointmentDecisionUrl: function (id) {
    return `http://192.168.1.37:8081/api/appointments/${id}/decision`;
  },

  getRescheduleAppointmentUrl: function (id) {
    return `${this.API_BASE_URL}/appointments/${id}/reschedule`;
  },

  getCancelAppointmentUrl: function (id) {
    return `${this.API_BASE_URL}/appointments/${id}/cancel`;
  }
};