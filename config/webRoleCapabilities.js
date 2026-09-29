// Web Admin capabilities are resolved from the authenticated session role only.
// Keep this policy server-side; the browser receives a presentation copy.
// Monitoring-only access to the combined Appointments/Orientation workspace is
// deferred until its shared mobile API and mutation controls can be separated.
const ROLE_CAPABILITIES = Object.freeze({
  super_admin: Object.freeze([
    "dashboard.view", "waste.view", "complaints.view", "appointments.view",
    "orientation.view", "tracking.view", "fleet.view", "dispatch.view",
    "calendar.view", "incoming_documents.view",
    "notifications.view", "notifications.manage", "users.manage"
  ]),
  clerk_admin: Object.freeze([
    "dashboard.view", "waste.view", "complaints.view", "appointments.view",
    "orientation.view", "calendar.view", "incoming_documents.view",
    "notifications.view", "notifications.manage"
  ]),
  division_admin: Object.freeze([
    "dashboard.view", "waste.view", "complaints.view",
    "notifications.view"
  ]),
  supervisor: Object.freeze([
    "dashboard.view", "waste.view", "complaints.view",
    "notifications.view"
  ]),
  personnel: Object.freeze([
    "dashboard.view", "tracking.view", "fleet.view", "dispatch.view",
    "notifications.view"
  ])
});

function getWebCapabilities(role) {
  const normalizedRole = String(role || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return [...(ROLE_CAPABILITIES[normalizedRole] || [])];
}

function hasWebCapability(role, capability) {
  return getWebCapabilities(role).includes(capability);
}

module.exports = { ROLE_CAPABILITIES, getWebCapabilities, hasWebCapability };
