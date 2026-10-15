// =========================
// FLEET MONITORING
// =========================

const FLEET_CONDITION_LABELS = Object.freeze({
  available: "Available",
  for_maintenance: "For Maintenance",
  out_of_service: "Out of Service"
});

const FLEET_OPERATIONAL_LABELS = Object.freeze({
  returning_to_wmo: "Returning to WMO",
  active_dispatch: "Active / On Dispatch",
  tracking_awaiting_dispatch: "Tracking Active / Awaiting Dispatch",
  planned: "Planned",
  off_duty: "Off Duty"
});

const FLEET_TRACKING_LABELS = Object.freeze({
  not_tracking: "Not Tracking",
  online: "GPS Online",
  sync_pending: "Sync Pending",
  offline: "GPS Offline"
});

const FLEET_ASSIGNMENT_LABELS = Object.freeze({
  available: "Available",
  reserved: "Reserved",
  on_dispatch: "On Dispatch",
  returning_to_wmo: "Returning to WMO",
  tracking_active: "Tracking Active",
  unavailable: "Unavailable"
});

// Backward-compatible export name used by older tests/code.
const FLEET_GPS_LABELS = Object.freeze({
  online: "GPS Online",
  stale: "Sync Pending",
  sync_pending: "Sync Pending",
  offline: "GPS Offline",
  not_tracking: "Not Tracking"
});

const FLEET_EMPTY_SUMMARY = Object.freeze({
  total: 0,
  available: 0,
  active: 0,
  for_maintenance: 0,
  out_of_service: 0
});

const VEHICLE_ISSUE_SEVERITY_LABELS = Object.freeze({
  low: "Low",
  moderate: "Moderate",
  critical: "Critical"
});

const VEHICLE_ISSUE_STATUS_LABELS = Object.freeze({
  submitted: "Submitted",
  under_review: "Under Review",
  resolved: "Resolved"
});

const VEHICLE_ISSUE_CATEGORY_LABELS = Object.freeze({
  engine_overheating: "Engine / Overheating",
  brakes: "Brakes",
  tires: "Tires",
  steering: "Steering",
  electrical_battery: "Electrical / Battery",
  lights: "Lights",
  noise_vibration: "Unusual Noise / Vibration",
  other: "Other"
});

const VEHICLE_ISSUE_RESOLUTION_LABELS = Object.freeze({
  continue_operation: "Continue Operation",
  set_for_maintenance: "Set For Maintenance",
  set_out_of_service: "Set Out of Service"
});

const VEHICLE_ISSUE_OPEN_STATUSES = new Set(["submitted", "under_review"]);
const VEHICLE_ISSUE_CONDITION_ACTIONS = new Set([
  "set_for_maintenance",
  "set_out_of_service"
]);
const FLEET_ACTIVE_OPERATION_KEYS = new Set([
  "active_dispatch",
  "returning_to_wmo",
  "tracking_awaiting_dispatch"
]);

let fleetTrucksCache = [];
let fleetSummaryCache = { ...FLEET_EMPTY_SUMMARY };
let fleetHasLoadedTrucks = false;
let fleetSelectedConditionTruck = null;
let fleetSelectedManageTruck = null;
let fleetSelectedEditTruck = null;
let fleetLastModalTrigger = null;
let fleetParentModalTrigger = null;
let fleetRefreshInProgress = false;
let fleetVehicleIssuesCache = [];
let fleetVehicleIssuesLoaded = false;
let fleetVehicleIssueSelected = null;
let fleetVehicleIssuesTrigger = null;
let fleetVehicleIssueDetailTrigger = null;

const FLEET_CHILD_MODAL_IDS = Object.freeze([
  "fleetAddTruckModal",
  "fleetManageModal",
  "fleetEditTruckModal",
  "fleetConditionModal",
  "fleetVehicleIssuesModal",
  "fleetVehicleIssueDetailModal"
]);

function fleetEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function fleetVehicleIssueSeverityLabel(severity) {
  const key = String(severity || "").trim().toLowerCase();
  return VEHICLE_ISSUE_SEVERITY_LABELS[key] || "Not recorded";
}

function fleetVehicleIssueStatusLabel(status) {
  const key = String(status || "").trim().toLowerCase();
  return VEHICLE_ISSUE_STATUS_LABELS[key] || "Not recorded";
}

function fleetVehicleIssueCategoryLabel(category) {
  const key = String(category || "").trim().toLowerCase();
  return VEHICLE_ISSUE_CATEGORY_LABELS[key] || "Other";
}

function fleetVehicleIssueResolutionLabel(action) {
  const key = String(action || "").trim().toLowerCase();
  return VEHICLE_ISSUE_RESOLUTION_LABELS[key] || "Not recorded";
}

function fleetVehicleIssueIsOpen(report = {}) {
  return VEHICLE_ISSUE_OPEN_STATUSES.has(
    String(report.report_status || "").trim().toLowerCase()
  );
}

function fleetVehicleIssueResolutionRequiresNotes(action) {
  return VEHICLE_ISSUE_CONDITION_ACTIONS.has(
    String(action || "").trim().toLowerCase()
  );
}

function fleetValidateVehicleIssueResolution(payload = {}) {
  const action = String(payload.resolution_action || "").trim().toLowerCase();
  const notes = String(payload.resolution_notes || "").trim();
  if (!Object.prototype.hasOwnProperty.call(VEHICLE_ISSUE_RESOLUTION_LABELS, action)) {
    return { valid: false, message: "Select a valid resolution action." };
  }
  if (fleetVehicleIssueResolutionRequiresNotes(action) && !notes) {
    return { valid: false, message: "Resolution notes are required for this Fleet condition change." };
  }
  return { valid: true, message: "" };
}

function fleetVehicleIssueDate(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("en-PH", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function fleetVehicleIssueSafeImageUrl(value) {
  const url = String(value || "").trim();
  return /^(https?:\/\/|\/(?!\/))/i.test(url) ? url : "";
}

function fleetCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.trunc(count) : 0;
}

function fleetConditionLabel(condition) {
  return FLEET_CONDITION_LABELS[String(condition || "").toLowerCase()] || "Not recorded";
}

function fleetOperationalLabel(truck = {}) {
  const key = String(truck.operational_state_key || "").toLowerCase();
  if (key === "planned" && truck.operational_date) {
    return `Planned for ${truck.operational_date}`;
  }
  return FLEET_OPERATIONAL_LABELS[key] ||
    String(truck.operational_state || "").trim() ||
    "Off Duty";
}

function fleetTrackingKey(truck = {}) {
  const semanticKey = String(truck.tracking_status_key || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(FLEET_TRACKING_LABELS, semanticKey)) {
    return semanticKey;
  }

  const hasActiveTrackingSession =
    Number.isFinite(Number(truck.active_tracking_session_id)) &&
    Number(truck.active_tracking_session_id) > 0;

  if (!hasActiveTrackingSession) return "not_tracking";

  const legacy = String(truck.gps_status || "").trim().toLowerCase();
  if (["online", "active", "live", "synced"].includes(legacy)) return "online";
  if (["stale", "sync_pending", "weak_signal", "pending"].includes(legacy)) {
    return "sync_pending";
  }
  if (["offline", "gps_off", "tracking_off", "permission_missing"].includes(legacy)) {
    return "offline";
  }

  // An authoritative active session with unknown/late sync is not the same
  // as GPS being explicitly disabled.
  return "sync_pending";
}

function fleetTrackingLabel(truck = {}) {
  const key = fleetTrackingKey(truck);
  return FLEET_TRACKING_LABELS[key] || "Not Tracking";
}

function fleetTrackingBadgeClass(truck = {}) {
  const key = fleetTrackingKey(truck);
  if (key === "sync_pending") return "stale";
  return key;
}

// Compatibility helper retained for older callers/tests.
function fleetGpsLabel(status) {
  const key = String(status || "").toLowerCase();
  if (!key) return "Not Tracking";
  if (key === "stale") return "Sync Pending";
  return FLEET_GPS_LABELS[key] || "Not Tracking";
}

function fleetAssignmentKey(truck = {}) {
  const semanticKey = String(truck.assignment_state_key || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(FLEET_ASSIGNMENT_LABELS, semanticKey)) {
    return semanticKey;
  }

  const operationalKey = String(truck.operational_state_key || "").trim().toLowerCase();

  if (operationalKey === "returning_to_wmo") return "returning_to_wmo";
  if (operationalKey === "active_dispatch") return "on_dispatch";
  if (operationalKey === "tracking_awaiting_dispatch") return "tracking_active";
  if (operationalKey === "planned") return "reserved";
  if (truck.assignable === true) return "available";

  return "unavailable";
}

function fleetAssignmentLabel(truck = {}) {
  const key = fleetAssignmentKey(truck);
  return FLEET_ASSIGNMENT_LABELS[key] || "Unavailable";
}

function fleetAssignmentBadgeClass(truck = {}) {
  const key = fleetAssignmentKey(truck);

  // Preserve the existing green "yes" visual for truly available trucks.
  if (key === "available") return "yes";

  // New semantic classes keep reserved/active states from looking like an
  // error/red "No". They safely fall back to the neutral base badge until
  // admin-fleet.css is updated in the next step.
  return key;
}

function fleetRequiresReason(condition) {
  return ["for_maintenance", "out_of_service"].includes(
    String(condition || "").toLowerCase()
  );
}

function fleetValidateTruck(payload = {}) {
  if (!String(payload.truck_code || "").trim()) {
    return { valid: false, message: "Truck Code is required." };
  }
  if (!String(payload.truck_name || "").trim()) {
    return { valid: false, message: "Truck Name is required." };
  }
  if (!Object.prototype.hasOwnProperty.call(FLEET_CONDITION_LABELS, payload.fleet_condition)) {
    return { valid: false, message: "Select a valid fleet condition." };
  }
  if (fleetRequiresReason(payload.fleet_condition) && !String(payload.condition_reason || "").trim()) {
    return { valid: false, message: "Condition Reason is required for this fleet condition." };
  }
  return { valid: true, message: "" };
}

function fleetValidateTruckDetails(payload = {}) {
  if (!String(payload.truck_code || "").trim()) {
    return { valid: false, message: "Truck Code is required." };
  }

  if (!String(payload.truck_name || "").trim()) {
    return { valid: false, message: "Truck Name is required." };
  }

  return { valid: true, message: "" };
}

function fleetValidateCondition(payload = {}) {
  if (!Object.prototype.hasOwnProperty.call(FLEET_CONDITION_LABELS, payload.fleet_condition)) {
    return { valid: false, message: "Select a valid fleet condition." };
  }
  if (fleetRequiresReason(payload.fleet_condition) && !String(payload.condition_reason || "").trim()) {
    return { valid: false, message: "Condition Reason is required for this fleet condition." };
  }
  return { valid: true, message: "" };
}

function fleetConditionBadge(truck = {}) {
  const condition = String(truck.fleet_condition || "").toLowerCase();
  const reason = String(truck.condition_reason || "").trim();
  return `
    <span class="fleet-badge condition ${fleetEscape(condition || "unknown")}">${fleetEscape(fleetConditionLabel(condition))}</span>
    ${reason ? `<small class="fleet-cell-note">${fleetEscape(reason)}</small>` : ""}`;
}

function fleetTrackingNote(truck = {}) {
  const key = fleetTrackingKey(truck);
  const lastSync = String(truck.tracking_last_sync_at || "").trim();

  if (key === "not_tracking") {
    return "Dispatch tracking has not started.";
  }

  if (key === "sync_pending") {
    return lastSync
      ? `Last synced ${lastSync}`
      : "Waiting for the mobile device to sync.";
  }

  if (key === "offline") {
    return lastSync
      ? `Last synced ${lastSync}`
      : "GPS is unavailable for the active operation.";
  }

  return lastSync ? `Last synced ${lastSync}` : "";
}

function fleetTableRowsHtml(trucks = []) {
  if (!Array.isArray(trucks) || trucks.length === 0) {
    return `
      <tr>
        <td colspan="7" class="fleet-table-state fleet-empty-state">
          <strong>No fleet trucks are registered yet.</strong>
          <span>Add the official WMO truck roster once it has been verified.</span>
        </td>
      </tr>`;
  }

  return trucks.map((truck) => {
    const id = Number(truck.id);
    const operationalKey = String(truck.operational_state_key || "off_duty").toLowerCase();
    const trackingKey = fleetTrackingKey(truck);
    const trackingClass = fleetTrackingBadgeClass(truck);
    const assignmentKey = fleetAssignmentKey(truck);
    const assignmentClass = fleetAssignmentBadgeClass(truck);
    const trackingNote = fleetTrackingNote(truck);
    const truckCode = String(truck.truck_code || "").trim() || "Not recorded";
    const truckName = String(truck.truck_name || "").trim() || truckCode;

    return `
      <tr>
        <td>
          <strong class="fleet-truck-code">${fleetEscape(truckCode)}</strong>
          <small class="fleet-cell-note">${fleetEscape(truckName)}</small>
        </td>
        <td>${fleetEscape(String(truck.plate_number || "").trim() || "Not recorded")}</td>
        <td>${fleetConditionBadge(truck)}</td>
        <td>
          <span class="fleet-badge operational ${fleetEscape(operationalKey)}">${fleetEscape(fleetOperationalLabel(truck))}</span>
        </td>
        <td>
          <span class="fleet-badge gps ${fleetEscape(trackingClass)}" data-tracking-state="${fleetEscape(trackingKey)}">${fleetEscape(fleetTrackingLabel(truck))}</span>
          ${trackingNote ? `<small class="fleet-cell-note">${fleetEscape(trackingNote)}</small>` : ""}
        </td>
        <td>
          <span class="fleet-badge assignable ${fleetEscape(assignmentClass)}" data-assignment-state="${fleetEscape(assignmentKey)}">${fleetEscape(fleetAssignmentLabel(truck))}</span>
        </td>
        <td>
          <button
            type="button"
            class="fleet-row-action"
            data-fleet-manage="${fleetEscape(Number.isInteger(id) && id > 0 ? id : "")}"
            aria-label="Manage ${fleetEscape(truckCode)}"
            ${Number.isInteger(id) && id > 0 ? "" : "disabled"}
          >Manage</button>
        </td>
      </tr>`;
  }).join("");
}

function fleetVehicleIssueFilteredReports(reports = [], filters = {}) {
  const status = String(filters.status || "open").trim().toLowerCase();
  const severity = String(filters.severity || "all").trim().toLowerCase();
  return (Array.isArray(reports) ? reports : []).filter((report) => {
    const reportStatus = String(report.report_status || "").trim().toLowerCase();
    const reportSeverity = String(report.severity || "").trim().toLowerCase();
    const statusMatches = status === "all"
      || (status === "open" && VEHICLE_ISSUE_OPEN_STATUSES.has(reportStatus))
      || reportStatus === status;
    const severityMatches = severity === "all" || reportSeverity === severity;
    return statusMatches && severityMatches;
  });
}

function fleetLatestOpenIssueForTruck(truckId, reports = fleetVehicleIssuesCache) {
  const id = Number(truckId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return (Array.isArray(reports) ? reports : []).find((report) => (
    Number(report.fleet_truck_id) === id && fleetVehicleIssueIsOpen(report)
  )) || null;
}

function fleetVehicleIssueRowsHtml(reports = [], filters = {}) {
  const filtered = fleetVehicleIssueFilteredReports(reports, filters);
  if (!filtered.length) {
    return `
      <tr>
        <td colspan="7" class="fleet-table-state fleet-empty-state">
          <strong>No vehicle issues match these filters.</strong>
          <span>Try another status or severity.</span>
        </td>
      </tr>`;
  }

  return filtered.map((report) => {
    const reportId = Number(report.id);
    const severity = String(report.severity || "").trim().toLowerCase();
    const status = String(report.report_status || "").trim().toLowerCase();
    const truckCode = String(report.truck_code_snapshot || "").trim() || "Not recorded";
    const truckName = String(report.truck_name_snapshot || "").trim();
    const reporter = String(report.reported_by_name_snapshot || "").trim() || "Not recorded";
    const description = String(report.description || "").trim() || "No description provided";
    return `
      <tr>
        <td><span class="fleet-issue-badge severity ${fleetEscape(severity)}">${fleetEscape(fleetVehicleIssueSeverityLabel(severity))}</span></td>
        <td>
          <strong class="fleet-truck-code">${fleetEscape(truckCode)}</strong>
          ${truckName ? `<small class="fleet-cell-note">${fleetEscape(truckName)}</small>` : ""}
        </td>
        <td>
          <strong>${fleetEscape(fleetVehicleIssueCategoryLabel(report.issue_category))}</strong>
          <small class="fleet-cell-note fleet-issue-description">${fleetEscape(description)}</small>
        </td>
        <td>${fleetEscape(reporter)}</td>
        <td>${fleetEscape(fleetVehicleIssueDate(report.created_at))}</td>
        <td><span class="fleet-issue-badge status ${fleetEscape(status)}">${fleetEscape(fleetVehicleIssueStatusLabel(status))}</span></td>
        <td>
          <button type="button" class="fleet-row-action" data-vehicle-issue-view="${fleetEscape(Number.isInteger(reportId) && reportId > 0 ? reportId : "")}" ${Number.isInteger(reportId) && reportId > 0 ? "" : "disabled"}>View</button>
        </td>
      </tr>`;
  }).join("");
}

function fleetVehicleIssueHasActiveOperation(report = {}) {
  const truck = fleetFindTruckById(report.fleet_truck_id);
  const key = String(truck?.operational_state_key || "").trim().toLowerCase();
  return FLEET_ACTIVE_OPERATION_KEYS.has(key);
}

function fleetVehicleIssueDetailHtml(report = {}) {
  const severity = String(report.severity || "").trim().toLowerCase();
  const status = String(report.report_status || "").trim().toLowerCase();
  const condition = String(report.current_fleet_condition || "").trim().toLowerCase();
  const description = String(report.description || "").trim() || "Not provided";
  const possibleConcern = String(report.possible_concern || "").trim() || "Not recorded";
  const recommendedAction = String(report.recommended_action || "").trim() || "Not recorded";
  const imageUrl = fleetVehicleIssueSafeImageUrl(report.image_url);
  const latitude = Number(report.latitude);
  const longitude = Number(report.longitude);
  const accuracy = Number(report.accuracy_meters);
  const hasCoordinates = report.latitude !== null
    && report.latitude !== undefined
    && report.longitude !== null
    && report.longitude !== undefined
    && Number.isFinite(latitude)
    && Number.isFinite(longitude);
  const hasAccuracy = report.accuracy_meters !== null
    && report.accuracy_meters !== undefined
    && Number.isFinite(accuracy);
  const isResolved = status === "resolved";
  const currentTruck = fleetFindTruckById(report.fleet_truck_id);
  const activeWarning = fleetVehicleIssueHasActiveOperation(report)
    ? `<div class="fleet-issue-operation-warning" role="note">Updating the Fleet condition does not automatically end the current active operation.</div>`
    : "";

  return `
    ${activeWarning}
    <section class="fleet-issue-detail-section">
      <div class="fleet-issue-section-heading"><span>01</span><div><h4>Truck Information</h4><p>Current Fleet information is shown separately from this report's status.</p></div></div>
      <dl class="fleet-issue-detail-grid">
        <div><dt>Truck Code</dt><dd>${fleetEscape(String(report.truck_code_snapshot || "").trim() || "Not recorded")}</dd></div>
        <div><dt>Truck Name</dt><dd>${fleetEscape(String(report.truck_name_snapshot || "").trim() || "Not recorded")}</dd></div>
        <div><dt>Current Fleet Condition</dt><dd><span class="fleet-badge condition ${fleetEscape(condition || "unknown")}">${fleetEscape(fleetConditionLabel(condition))}</span></dd></div>
        <div><dt>Current Operational State</dt><dd>${fleetEscape(currentTruck ? fleetOperationalLabel(currentTruck) : "Not available")}</dd></div>
        <div><dt>Condition Reason</dt><dd>${fleetEscape(String(report.current_condition_reason || "").trim() || "Not recorded")}</dd></div>
      </dl>
    </section>

    <section class="fleet-issue-detail-section">
      <div class="fleet-issue-section-heading"><span>02</span><div><h4>Report Information</h4><p>Submission and review lifecycle.</p></div></div>
      <dl class="fleet-issue-detail-grid">
        <div><dt>Report ID</dt><dd>#${fleetEscape(report.id || "Not recorded")}</dd></div>
        <div><dt>Reported By</dt><dd>${fleetEscape(String(report.reported_by_name_snapshot || "").trim() || "Not recorded")}</dd></div>
        <div><dt>Reported At</dt><dd>${fleetEscape(fleetVehicleIssueDate(report.created_at))}</dd></div>
        <div><dt>Vehicle Issue Status</dt><dd><span class="fleet-issue-badge status ${fleetEscape(status)}">${fleetEscape(fleetVehicleIssueStatusLabel(status))}</span></dd></div>
        <div><dt>Reviewed By</dt><dd>${fleetEscape(String(report.reviewed_by_name || "").trim() || "Not recorded")}</dd></div>
        <div><dt>Reviewed At</dt><dd>${fleetEscape(fleetVehicleIssueDate(report.reviewed_at))}</dd></div>
      </dl>
    </section>

    <section class="fleet-issue-detail-section">
      <div class="fleet-issue-section-heading"><span>03</span><div><h4>Issue</h4><p>Driver-provided concern and rules-based severity.</p></div></div>
      <dl class="fleet-issue-detail-grid">
        <div><dt>Category</dt><dd>${fleetEscape(fleetVehicleIssueCategoryLabel(report.issue_category))}</dd></div>
        <div><dt>Severity</dt><dd><span class="fleet-issue-badge severity ${fleetEscape(severity)}">${fleetEscape(fleetVehicleIssueSeverityLabel(severity))}</span></dd></div>
        <div class="fleet-issue-detail-wide"><dt>Description</dt><dd>${fleetEscape(description)}</dd></div>
      </dl>
    </section>

    <section class="fleet-issue-detail-section">
      <div class="fleet-issue-section-heading"><span>04</span><div><h4>Vehicle Assistant Assessment</h4><p>Deterministic safety guidance recorded with the report.</p></div></div>
      <dl class="fleet-issue-detail-grid">
        <div class="fleet-issue-detail-wide"><dt>Possible Concern</dt><dd>${fleetEscape(possibleConcern)}</dd></div>
        <div class="fleet-issue-detail-wide"><dt>Recommended Action</dt><dd>${fleetEscape(recommendedAction)}</dd></div>
        <div><dt>Ruleset Version</dt><dd>${fleetEscape(String(report.assistant_ruleset_version || "").trim() || "Not recorded")}</dd></div>
      </dl>
    </section>

    <section class="fleet-issue-detail-section">
      <div class="fleet-issue-section-heading"><span>05</span><div><h4>Evidence</h4><p>Optional photo and GPS evidence captured by the reporting device.</p></div></div>
      <div class="fleet-issue-evidence">
        ${imageUrl ? `<a href="${fleetEscape(imageUrl)}" target="_blank" rel="noopener noreferrer" class="fleet-issue-photo-link"><img src="${fleetEscape(imageUrl)}" alt="Vehicle issue report evidence"><span>Open full photo</span></a>` : `<div class="fleet-issue-no-photo">No photo was attached.</div>`}
        <dl class="fleet-issue-detail-grid">
          <div class="fleet-issue-detail-wide"><dt>GPS Coordinates</dt><dd>${hasCoordinates ? `${fleetEscape(latitude.toFixed(6))}, ${fleetEscape(longitude.toFixed(6))}` : "Not recorded"}</dd></div>
          <div><dt>Accuracy</dt><dd>${hasAccuracy ? `${fleetEscape(accuracy.toFixed(1))} m` : "Not recorded"}</dd></div>
          <div><dt>Location Recorded At</dt><dd>${fleetEscape(fleetVehicleIssueDate(report.location_recorded_at))}</dd></div>
        </dl>
      </div>
    </section>

    <section class="fleet-issue-detail-section">
      <div class="fleet-issue-section-heading"><span>06</span><div><h4>Operation References</h4><p>References are evidence links only and do not change dispatch or tracking state.</p></div></div>
      <dl class="fleet-issue-detail-grid fleet-issue-reference-grid">
        <div><dt>Dispatch Plan</dt><dd>${report.dispatch_plan_id ? `#${fleetEscape(report.dispatch_plan_id)}` : "Not recorded"}</dd></div>
        <div><dt>Dispatch Ticket</dt><dd>${report.dispatch_ticket_id ? `#${fleetEscape(report.dispatch_ticket_id)}` : "Not recorded"}</dd></div>
        <div><dt>Tracking Session</dt><dd>${report.tracking_session_id ? `#${fleetEscape(report.tracking_session_id)}` : "Not recorded"}</dd></div>
      </dl>
    </section>

    ${isResolved ? `
      <section class="fleet-issue-detail-section fleet-issue-resolution-summary">
        <div class="fleet-issue-section-heading"><span>07</span><div><h4>Resolution</h4><p>This resolved report is read-only.</p></div></div>
        <dl class="fleet-issue-detail-grid">
          <div><dt>Action</dt><dd>${fleetEscape(fleetVehicleIssueResolutionLabel(report.resolution_action))}</dd></div>
          <div><dt>Resolved By</dt><dd>${fleetEscape(String(report.resolved_by_name || "").trim() || "Not recorded")}</dd></div>
          <div><dt>Resolved At</dt><dd>${fleetEscape(fleetVehicleIssueDate(report.resolved_at))}</dd></div>
          <div class="fleet-issue-detail-wide"><dt>Resolution Notes</dt><dd>${fleetEscape(String(report.resolution_notes || "").trim() || "No resolution notes recorded")}</dd></div>
        </dl>
      </section>` : ""}
  `;
}

function renderFleetSummary(summary = {}) {
  fleetSummaryCache = {
    total: fleetCount(summary.total),
    available: fleetCount(summary.available),
    active: fleetCount(summary.active),
    for_maintenance: fleetCount(summary.for_maintenance),
    out_of_service: fleetCount(summary.out_of_service)
  };
  const values = {
    fleetSummaryTotal: fleetSummaryCache.total,
    fleetSummaryAvailable: fleetSummaryCache.available,
    fleetSummaryActive: fleetSummaryCache.active,
    fleetSummaryMaintenance: fleetSummaryCache.for_maintenance,
    fleetSummaryOutOfService: fleetSummaryCache.out_of_service
  };
  Object.entries(values).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value);
  });
}

function renderFleetTable(trucks = []) {
  const tbody = document.getElementById("fleetTableBody");
  if (!tbody) return;
  tbody.innerHTML = fleetTableRowsHtml(trucks);
}

function fleetVehicleIssueCurrentFilters() {
  return {
    status: document.getElementById("fleetVehicleIssueStatusFilter")?.value || "open",
    severity: document.getElementById("fleetVehicleIssueSeverityFilter")?.value || "all"
  };
}

function renderFleetVehicleIssueCount(reports = fleetVehicleIssuesCache) {
  const count = (Array.isArray(reports) ? reports : []).filter(fleetVehicleIssueIsOpen).length;
  const element = document.getElementById("fleetVehicleIssuesCount");
  if (!element) return count;
  element.textContent = String(count);
  element.setAttribute("aria-label", `${count} open vehicle ${count === 1 ? "issue" : "issues"}`);
  element.classList.toggle("has-open-issues", count > 0);
  return count;
}

function renderFleetVehicleIssueTable() {
  const tbody = document.getElementById("fleetVehicleIssuesTableBody");
  if (!tbody) return;
  tbody.innerHTML = fleetVehicleIssueRowsHtml(
    fleetVehicleIssuesCache,
    fleetVehicleIssueCurrentFilters()
  );
}

function fleetSetVehicleIssueStatus(message = "", type = "status") {
  const element = document.getElementById("fleetVehicleIssuesStatus");
  if (!element) return;
  const text = String(message || "").trim();
  element.textContent = text;
  element.classList.toggle("hidden", !text);
  element.classList.toggle("error", type === "error");
}

function renderFleetManageLatestIssue(truck = fleetSelectedManageTruck) {
  const panel = document.getElementById("fleetManageVehicleIssue");
  if (!panel) return null;
  const report = truck ? fleetLatestOpenIssueForTruck(truck.id) : null;
  panel.classList.toggle("hidden", !report);
  if (!report) {
    panel.removeAttribute("data-report-id");
    return null;
  }

  panel.dataset.reportId = String(report.id);
  const summary = document.getElementById("fleetManageVehicleIssueSummary");
  const severity = document.getElementById("fleetManageVehicleIssueSeverity");
  const status = document.getElementById("fleetManageVehicleIssueStatus");
  if (summary) {
    summary.textContent = `${fleetVehicleIssueCategoryLabel(report.issue_category)} · ${fleetVehicleIssueDate(report.created_at)}`;
  }
  if (severity) {
    const key = String(report.severity || "").trim().toLowerCase();
    severity.className = `fleet-issue-badge severity ${key}`;
    severity.textContent = fleetVehicleIssueSeverityLabel(key);
  }
  if (status) {
    const key = String(report.report_status || "").trim().toLowerCase();
    status.className = `fleet-issue-badge status ${key}`;
    status.textContent = fleetVehicleIssueStatusLabel(key);
  }
  return report;
}

function fleetSetStatus(message = "", type = "status") {
  const element = document.getElementById("fleetStatusMessage");
  if (!element) return;
  const text = String(message || "").trim();
  element.textContent = text;
  element.classList.toggle("hidden", !text);
  element.classList.toggle("error", type === "error");
}

function fleetSetFormFeedback(id, message = "") {
  const element = document.getElementById(id);
  if (!element) return;
  const text = String(message || "").trim();
  element.textContent = text;
  element.classList.toggle("hidden", !text);
}

function fleetNotify(message, type = "success") {
  if (typeof showToast === "function") {
    showToast(message, type);
  } else if (type === "error") {
    console.error(message);
  } else {
    console.log(message);
  }
}

function fleetErrorMessage(error, fallback = "Fleet data is temporarily unavailable.") {
  if (Number(error?.status) === 401) return "Your Web Admin session has expired.";
  if (Number(error?.status) === 403) return "You do not have permission to manage fleet records.";
  return String(error?.message || fallback);
}

async function fleetRequest(url, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {})
  };
  const response = await webAdminFetch(url, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      payload.message || `Fleet request failed (${response.status})`
    );
    error.status = response.status;
    error.code = payload.code || "FLEET_REQUEST_FAILED";
    throw error;
  }
  return payload.data;
}

async function loadFleetSummary() {
  const summary = await fleetRequest(getFleetSummaryApiUrl());
  renderFleetSummary(summary || FLEET_EMPTY_SUMMARY);
  return fleetSummaryCache;
}

async function loadFleetTrucks() {
  const trucks = await fleetRequest(getFleetTrucksApiUrl());
  fleetTrucksCache = Array.isArray(trucks) ? trucks : [];
  fleetHasLoadedTrucks = true;
  renderFleetTable(fleetTrucksCache);
  return fleetTrucksCache;
}

async function loadVehicleIssues() {
  const reports = await fleetRequest(getVehicleIssuesApiUrl({ limit: 200 }));
  fleetVehicleIssuesCache = Array.isArray(reports) ? reports : [];
  fleetVehicleIssuesLoaded = true;
  renderFleetVehicleIssueCount();
  renderFleetVehicleIssueTable();
  if (fleetSelectedManageTruck) renderFleetManageLatestIssue(fleetSelectedManageTruck);
  fleetSetVehicleIssueStatus("");
  return fleetVehicleIssuesCache;
}

async function refreshFleetMonitoring(options = {}) {
  if (fleetRefreshInProgress) return;
  fleetRefreshInProgress = true;
  const refreshButton = document.getElementById("fleetRefreshBtn");
  if (refreshButton) refreshButton.disabled = true;
  if (!fleetHasLoadedTrucks) {
    const tbody = document.getElementById("fleetTableBody");
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="7" class="fleet-table-state">Loading registered fleet...</td></tr>';
    }
  }
  fleetSetStatus(options.announce === false ? "" : "Refreshing fleet overview...");

  try {
    const vehicleIssuesPromise = loadVehicleIssues().catch((error) => {
      renderFleetVehicleIssueCount([]);
      if (fleetModalIsOpen("fleetVehicleIssuesModal")) {
        fleetSetVehicleIssueStatus(
          fleetErrorMessage(error, "Vehicle issues could not be loaded."),
          "error"
        );
      }
      return null;
    });
    const [summaryResult, trucksResult] = await Promise.allSettled([
      loadFleetSummary(),
      loadFleetTrucks()
    ]);
    await vehicleIssuesPromise;
    const failures = [summaryResult, trucksResult].filter((result) => result.status === "rejected");
    if (!failures.length) {
      fleetSetStatus("");
      return;
    }

    if (trucksResult.status === "rejected" && !fleetHasLoadedTrucks) {
      const tbody = document.getElementById("fleetTableBody");
      if (tbody) {
        tbody.innerHTML = `
          <tr><td colspan="7" class="fleet-table-state fleet-error-state">
            <strong>Fleet records could not be loaded.</strong>
            <button type="button" class="fleet-row-action" data-fleet-retry>Retry</button>
          </td></tr>`;
      }
    }
    const reason = failures[0].reason;
    fleetSetStatus(fleetErrorMessage(reason), "error");
  } finally {
    fleetRefreshInProgress = false;
    if (refreshButton) refreshButton.disabled = false;
  }
}

function fleetSetVehicleIssueDetailStatus(message = "", type = "status") {
  const element = document.getElementById("fleetVehicleIssueDetailStatus");
  if (!element) return;
  const text = String(message || "").trim();
  element.textContent = text;
  element.classList.toggle("hidden", !text);
  element.classList.toggle("error", type === "error");
}

function fleetUpdateVehicleIssueResolutionGuidance() {
  const action = document.getElementById("fleetVehicleIssueResolutionAction")?.value || "";
  const notes = document.getElementById("fleetVehicleIssueResolutionNotes");
  const requiredMark = document.getElementById("fleetVehicleIssueResolutionNotesRequired");
  const impact = document.getElementById("fleetVehicleIssueResolutionImpact");
  const requiresNotes = fleetVehicleIssueResolutionRequiresNotes(action);
  if (notes) {
    notes.required = requiresNotes;
    notes.setAttribute("aria-required", String(requiresNotes));
  }
  requiredMark?.classList.toggle("hidden", !requiresNotes);
  if (!impact) return;
  const messages = {
    continue_operation: "The report will be resolved without changing the current Fleet condition.",
    set_for_maintenance: "The backend will resolve the report and set the Fleet condition to For Maintenance.",
    set_out_of_service: "The backend will resolve the report and set the Fleet condition to Out of Service."
  };
  impact.textContent = messages[action] || "Choose a resolution action to review its effect.";
}

function renderFleetVehicleIssueDetail(report = {}) {
  fleetVehicleIssueSelected = report;
  const body = document.getElementById("fleetVehicleIssueDetailBody");
  const subtitle = document.getElementById("fleetVehicleIssueDetailSubtitle");
  const controls = document.getElementById("fleetVehicleIssueMutationControls");
  const reviewAction = document.querySelector("#fleetVehicleIssueMutationControls .fleet-issue-review-action");
  const resolutionForm = document.getElementById("fleetVehicleIssueResolutionForm");
  const status = String(report.report_status || "").trim().toLowerCase();
  const unresolved = VEHICLE_ISSUE_OPEN_STATUSES.has(status);

  if (body) body.innerHTML = fleetVehicleIssueDetailHtml(report);
  if (subtitle) {
    subtitle.textContent = `Report #${report.id || "-"} · ${String(report.truck_code_snapshot || "Not recorded")}`;
  }
  controls?.classList.toggle("hidden", !unresolved);
  reviewAction?.classList.toggle("hidden", status !== "submitted");
  if (resolutionForm && unresolved) resolutionForm.reset();
  fleetUpdateVehicleIssueResolutionGuidance();
  fleetSetFormFeedback("fleetVehicleIssueResolutionFeedback", "");
  fleetSetVehicleIssueDetailStatus("");
}

async function openFleetVehicleIssuesModal(trigger = null) {
  fleetVehicleIssuesTrigger = trigger?.currentTarget || trigger || document.activeElement;
  fleetOpenModal("fleetVehicleIssuesModal", "fleetVehicleIssueStatusFilter", fleetVehicleIssuesTrigger);
  if (!fleetVehicleIssuesLoaded) {
    const tbody = document.getElementById("fleetVehicleIssuesTableBody");
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="fleet-table-state">Loading vehicle issues...</td></tr>';
  } else {
    renderFleetVehicleIssueTable();
  }
  fleetSetVehicleIssueStatus("Refreshing vehicle issues...");
  try {
    await loadVehicleIssues();
  } catch (error) {
    fleetSetVehicleIssueStatus(
      fleetErrorMessage(error, "Vehicle issues could not be loaded."),
      "error"
    );
  }
}

function closeFleetVehicleIssuesModal() {
  if (fleetModalIsOpen("fleetVehicleIssueDetailModal")) return false;
  fleetCloseModal("fleetVehicleIssuesModal");
  fleetVehicleIssuesTrigger?.focus?.();
  fleetVehicleIssuesTrigger = null;
  return true;
}

async function openFleetVehicleIssueDetail(reportId, trigger = null) {
  const id = Number(reportId);
  if (!Number.isInteger(id) || id <= 0) return false;
  fleetVehicleIssueDetailTrigger = trigger || document.activeElement;
  fleetOpenModal("fleetVehicleIssueDetailModal", "fleetVehicleIssueDetailCloseBtn", fleetVehicleIssueDetailTrigger);
  fleetVehicleIssueSelected = null;
  const body = document.getElementById("fleetVehicleIssueDetailBody");
  const controls = document.getElementById("fleetVehicleIssueMutationControls");
  const subtitle = document.getElementById("fleetVehicleIssueDetailSubtitle");
  if (body) body.innerHTML = '<div class="fleet-issue-loading">Loading vehicle issue details...</div>';
  if (subtitle) subtitle.textContent = `Report #${id}`;
  controls?.classList.add("hidden");
  fleetSetVehicleIssueDetailStatus("");
  try {
    const report = await fleetRequest(getVehicleIssueApiUrl(id));
    renderFleetVehicleIssueDetail(report || {});
    return true;
  } catch (error) {
    fleetSetVehicleIssueDetailStatus(
      fleetErrorMessage(error, "Vehicle issue details could not be loaded."),
      "error"
    );
    if (body) body.innerHTML = '<div class="fleet-issue-loading">Unable to display this vehicle issue.</div>';
    return false;
  }
}

function closeFleetVehicleIssueDetailModal() {
  fleetCloseModal("fleetVehicleIssueDetailModal");
  fleetVehicleIssueSelected = null;
  fleetVehicleIssueDetailTrigger?.focus?.();
  fleetVehicleIssueDetailTrigger = null;
}

async function markFleetVehicleIssueUnderReview() {
  if (!fleetVehicleIssueSelected) return false;
  if (String(fleetVehicleIssueSelected.report_status || "").toLowerCase() !== "submitted") {
    fleetSetVehicleIssueDetailStatus("Only submitted reports can be marked under review.", "error");
    return false;
  }
  const button = document.getElementById("fleetVehicleIssueReviewBtn");
  if (button) button.disabled = true;
  fleetSetVehicleIssueDetailStatus("");
  let report;
  try {
    report = await fleetRequest(getVehicleIssueReviewApiUrl(fleetVehicleIssueSelected.id), {
      method: "PATCH"
    });
  } catch (error) {
    const message = fleetErrorMessage(error, "Unable to mark the vehicle issue under review.");
    fleetSetVehicleIssueDetailStatus(message, "error");
    fleetNotify(message, "error");
    if (button) button.disabled = false;
    return false;
  }

  renderFleetVehicleIssueDetail(report || fleetVehicleIssueSelected);
  fleetNotify("Vehicle issue marked under review.");
  try {
    await loadVehicleIssues();
  } catch (error) {
    fleetSetVehicleIssueDetailStatus(
      "Review saved, but the Vehicle Issues list could not be refreshed. Refresh the queue to retry.",
      "error"
    );
  } finally {
    if (button) button.disabled = false;
  }
  return true;
}

async function resolveFleetVehicleIssue(event) {
  event?.preventDefault?.();
  if (!fleetVehicleIssueSelected || !fleetVehicleIssueIsOpen(fleetVehicleIssueSelected)) {
    fleetSetFormFeedback("fleetVehicleIssueResolutionFeedback", "This report is already resolved.");
    return false;
  }
  const payload = {
    resolution_action: document.getElementById("fleetVehicleIssueResolutionAction")?.value || "",
    resolution_notes: document.getElementById("fleetVehicleIssueResolutionNotes")?.value.trim() || null
  };
  const validation = fleetValidateVehicleIssueResolution(payload);
  if (!validation.valid) {
    fleetSetFormFeedback("fleetVehicleIssueResolutionFeedback", validation.message);
    return false;
  }

  const label = fleetVehicleIssueResolutionLabel(payload.resolution_action);
  const confirmation = payload.resolution_action === "continue_operation"
    ? "Resolve this report and continue the operation without changing the Fleet condition?"
    : `Resolve this report and apply the Fleet condition action: ${label}?`;
  if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(confirmation)) {
    return false;
  }

  const button = document.getElementById("fleetVehicleIssueResolveBtn");
  if (button) button.disabled = true;
  fleetSetFormFeedback("fleetVehicleIssueResolutionFeedback", "");
  try {
    const report = await fleetRequest(getVehicleIssueResolveApiUrl(fleetVehicleIssueSelected.id), {
      method: "POST",
      body: JSON.stringify(payload)
    });
    await refreshFleetMonitoring({ announce: false });
    renderFleetVehicleIssueDetail(report || fleetVehicleIssueSelected);
    fleetNotify("Vehicle issue resolved successfully.");
    return true;
  } catch (error) {
    const message = fleetErrorMessage(error, "Unable to resolve the vehicle issue.");
    fleetSetFormFeedback("fleetVehicleIssueResolutionFeedback", message);
    fleetNotify(message, "error");
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

function fleetToggleReasonField(conditionId, fieldId, textareaId) {
  const condition = document.getElementById(conditionId)?.value;
  const field = document.getElementById(fieldId);
  const textarea = document.getElementById(textareaId);
  const required = fleetRequiresReason(condition);
  field?.classList.toggle("hidden", !required);
  if (textarea) {
    textarea.required = required;
    textarea.setAttribute("aria-required", String(required));
    if (!required) textarea.value = "";
  }
}

function fleetMountModalsToBody() {
  FLEET_CHILD_MODAL_IDS.forEach((id) => {
    const modal = document.getElementById(id);
    if (modal && modal.parentElement !== document.body) document.body.appendChild(modal);
  });
}

function fleetModalIsOpen(id) {
  const modal = document.getElementById(id);
  return Boolean(modal && !modal.classList.contains("hidden"));
}

function fleetHasOpenChildModal() {
  return FLEET_CHILD_MODAL_IDS.some(fleetModalIsOpen);
}

function fleetSyncModalScrollLock() {
  const shouldLock = fleetModalIsOpen("fleetOverviewModal") || fleetHasOpenChildModal();
  document.documentElement.classList.toggle("fleet-modal-open", shouldLock);
  document.body.classList.toggle("fleet-modal-open", shouldLock);
}

function fleetOpenModal(id, focusId, trigger = null) {
  fleetMountModalsToBody();
  const modal = document.getElementById(id);
  if (!modal) return;
  fleetLastModalTrigger = trigger || document.activeElement;
  modal.classList.remove("hidden");
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  fleetSyncModalScrollLock();
  setTimeout(() => document.getElementById(focusId)?.focus(), 0);
}

function fleetCloseModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add("hidden");
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  fleetSyncModalScrollLock();
  fleetLastModalTrigger?.focus?.();
  fleetLastModalTrigger = null;
}

function openFleetOverviewParentModal(triggerOrEvent = null) {
  const modal = document.getElementById("fleetOverviewModal");
  if (!modal) return false;
  const trigger = triggerOrEvent?.currentTarget || triggerOrEvent;
  fleetParentModalTrigger = trigger?.focus ? trigger : document.activeElement;
  modal.classList.remove("hidden");
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  fleetSyncModalScrollLock();
  setTimeout(() => document.getElementById("fleetOverviewParentCloseBtn")?.focus(), 0);
  void refreshFleetMonitoring();
  return true;
}

function closeFleetOverviewParentModal() {
  if (fleetHasOpenChildModal()) return false;
  const modal = document.getElementById("fleetOverviewModal");
  if (!modal) return false;
  modal.classList.add("hidden");
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  fleetSyncModalScrollLock();
  fleetParentModalTrigger?.focus?.();
  fleetParentModalTrigger = null;
  return true;
}

function closeFleetModalsForNavigation() {
  ["fleetOverviewModal", ...FLEET_CHILD_MODAL_IDS].forEach((id) => {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add("hidden");
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  });
  fleetSelectedManageTruck = null;
  fleetSelectedEditTruck = null;
  fleetSelectedConditionTruck = null;
  fleetVehicleIssueSelected = null;
  fleetVehicleIssuesTrigger = null;
  fleetVehicleIssueDetailTrigger = null;
  fleetLastModalTrigger = null;
  fleetParentModalTrigger = null;
  fleetSyncModalScrollLock();
}

function fleetSetTriggerAccess(hasAccess) {
  const trigger = document.getElementById("openFleetOverviewBtn");
  if (!trigger) return;
  trigger.hidden = !hasAccess;
  trigger.disabled = !hasAccess;
  trigger.setAttribute("aria-hidden", String(!hasAccess));
}

function openAddTruckModal(trigger = null) {
  const form = document.getElementById("fleetAddTruckForm");
  form?.reset();
  const condition = document.getElementById("fleetInitialCondition");
  if (condition) condition.value = "available";
  fleetToggleReasonField("fleetInitialCondition", "fleetInitialReasonField", "fleetInitialReason");
  fleetSetFormFeedback("fleetAddTruckFeedback", "");
  fleetOpenModal("fleetAddTruckModal", "fleetTruckCode", trigger);
}

async function submitFleetTruck(event) {
  event?.preventDefault?.();
  const payload = {
    truck_code: document.getElementById("fleetTruckCode")?.value.trim() || "",
    truck_name: document.getElementById("fleetTruckName")?.value.trim() || "",
    plate_number: document.getElementById("fleetPlateNumber")?.value.trim() || null,
    fleet_condition: document.getElementById("fleetInitialCondition")?.value || "available",
    condition_reason: document.getElementById("fleetInitialReason")?.value.trim() || null
  };
  const validation = fleetValidateTruck(payload);
  if (!validation.valid) {
    fleetSetFormFeedback("fleetAddTruckFeedback", validation.message);
    return false;
  }

  const submitButton = document.getElementById("fleetAddTruckSubmitBtn");
  if (submitButton) submitButton.disabled = true;
  fleetSetFormFeedback("fleetAddTruckFeedback", "");
  try {
    await fleetRequest(getFleetTrucksApiUrl(), {
      method: "POST",
      body: JSON.stringify(payload)
    });
    fleetCloseModal("fleetAddTruckModal");
    await refreshFleetMonitoring({ announce: false });
    fleetNotify("Fleet truck added successfully.");
    return true;
  } catch (error) {
    const message = fleetErrorMessage(error, "Unable to add the fleet truck.");
    fleetSetFormFeedback("fleetAddTruckFeedback", message);
    fleetNotify(message, "error");
    return false;
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

function fleetFindTruckById(truckId) {
  const id = Number(truckId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return fleetTrucksCache.find((item) => Number(item.id) === id) || null;
}

function openFleetManageModal(truckId, trigger = null) {
  const truck = fleetFindTruckById(truckId);

  if (!truck) {
    fleetNotify("The selected fleet truck is no longer available. Refresh and try again.", "error");
    return false;
  }

  fleetSelectedManageTruck = truck;

  const condition = String(truck.fleet_condition || "").toLowerCase();
  const conditionBadge = document.getElementById("fleetManageCondition");
  const reasonWrap = document.getElementById("fleetManageConditionReasonWrap");
  const reason = String(truck.condition_reason || "").trim();

  const values = {
    fleetManageTruckCode: String(truck.truck_code || "").trim() || "Not recorded",
    fleetManageTruckName: String(truck.truck_name || "").trim() || "Not recorded",
    fleetManagePlateNumber: String(truck.plate_number || "").trim() || "Not recorded",
    fleetManageOperationalState: fleetOperationalLabel(truck),
    fleetManageGps: fleetTrackingLabel(truck),
    fleetManageAssignable: fleetAssignmentLabel(truck),
    fleetManageConditionReason: reason || "Not recorded"
  };

  Object.entries(values).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  });

  if (conditionBadge) {
    conditionBadge.className = `fleet-badge condition ${condition || "unknown"}`;
    conditionBadge.textContent = fleetConditionLabel(condition);
  }

  if (reasonWrap) {
    reasonWrap.classList.toggle("hidden", !reason);
  }

  renderFleetManageLatestIssue(truck);

  fleetOpenModal("fleetManageModal", "fleetManageEditBtn", trigger);
  return true;
}

function openFleetEditTruckModal(truckId, trigger = null) {
  const truck = fleetFindTruckById(truckId);

  if (!truck) {
    fleetNotify("The selected fleet truck is no longer available. Refresh and try again.", "error");
    return false;
  }

  fleetSelectedEditTruck = truck;

  const truckCode = document.getElementById("fleetEditTruckCode");
  const truckName = document.getElementById("fleetEditTruckName");
  const plateNumber = document.getElementById("fleetEditPlateNumber");

  if (truckCode) truckCode.value = String(truck.truck_code || "").trim();
  if (truckName) truckName.value = String(truck.truck_name || "").trim();
  if (plateNumber) plateNumber.value = String(truck.plate_number || "").trim();

  fleetSetFormFeedback("fleetEditTruckFeedback", "");
  fleetOpenModal("fleetEditTruckModal", "fleetEditTruckCode", trigger);
  return true;
}

async function updateFleetTruckDetails(event) {
  event?.preventDefault?.();

  if (!fleetSelectedEditTruck) {
    fleetSetFormFeedback("fleetEditTruckFeedback", "Select a fleet truck first.");
    return false;
  }

  const payload = {
    truck_code: document.getElementById("fleetEditTruckCode")?.value.trim() || "",
    truck_name: document.getElementById("fleetEditTruckName")?.value.trim() || "",
    plate_number: document.getElementById("fleetEditPlateNumber")?.value.trim() || null
  };

  const validation = fleetValidateTruckDetails(payload);
  if (!validation.valid) {
    fleetSetFormFeedback("fleetEditTruckFeedback", validation.message);
    return false;
  }

  const submitButton = document.getElementById("fleetEditTruckSubmitBtn");
  if (submitButton) submitButton.disabled = true;
  fleetSetFormFeedback("fleetEditTruckFeedback", "");

  try {
    await fleetRequest(getFleetTruckApiUrl(fleetSelectedEditTruck.id), {
      method: "PATCH",
      body: JSON.stringify(payload)
    });

    fleetCloseModal("fleetEditTruckModal");
    fleetCloseModal("fleetManageModal");
    fleetSelectedEditTruck = null;
    fleetSelectedManageTruck = null;

    await refreshFleetMonitoring({ announce: false });
    fleetNotify("Fleet truck details updated successfully.");
    return true;
  } catch (error) {
    const message = fleetErrorMessage(error, "Unable to update the fleet truck details.");
    fleetSetFormFeedback("fleetEditTruckFeedback", message);
    fleetNotify(message, "error");
    return false;
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

function openFleetConditionModal(truckId, trigger = null) {
  const truck = fleetFindTruckById(truckId);
  if (!truck) {
    fleetNotify("The selected fleet truck is no longer available. Refresh and try again.", "error");
    return false;
  }
  fleetSelectedConditionTruck = truck;
  const condition = document.getElementById("fleetConditionValue");
  const reason = document.getElementById("fleetConditionReason");
  const label = document.getElementById("fleetConditionTruckLabel");
  if (condition) condition.value = truck.fleet_condition || "available";
  if (reason) reason.value = truck.condition_reason || "";
  if (label) {
    label.textContent = `${truck.truck_code} · ${truck.truck_name} · ${fleetOperationalLabel(truck)}`;
  }
  fleetToggleReasonField("fleetConditionValue", "fleetConditionReasonField", "fleetConditionReason");
  if (reason && fleetRequiresReason(condition?.value)) reason.value = truck.condition_reason || "";
  fleetSetFormFeedback("fleetConditionFeedback", "");
  fleetOpenModal("fleetConditionModal", "fleetConditionValue", trigger);
  return true;
}

async function updateFleetCondition(event) {
  event?.preventDefault?.();
  if (!fleetSelectedConditionTruck) {
    fleetSetFormFeedback("fleetConditionFeedback", "Select a fleet truck first.");
    return false;
  }
  const payload = {
    fleet_condition: document.getElementById("fleetConditionValue")?.value || "",
    condition_reason: document.getElementById("fleetConditionReason")?.value.trim() || null
  };
  const validation = fleetValidateCondition(payload);
  if (!validation.valid) {
    fleetSetFormFeedback("fleetConditionFeedback", validation.message);
    return false;
  }

  const submitButton = document.getElementById("fleetConditionSubmitBtn");
  if (submitButton) submitButton.disabled = true;
  fleetSetFormFeedback("fleetConditionFeedback", "");
  try {
    await fleetRequest(getFleetTruckConditionApiUrl(fleetSelectedConditionTruck.id), {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
    fleetCloseModal("fleetConditionModal");
    fleetSelectedConditionTruck = null;
    await refreshFleetMonitoring({ announce: false });
    fleetNotify("Fleet condition updated successfully.");
    return true;
  } catch (error) {
    const message = fleetErrorMessage(error, "Unable to update the fleet condition.");
    fleetSetFormFeedback("fleetConditionFeedback", message);
    fleetNotify(message, "error");
    return false;
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

function fleetUserHasAccess(user) {
  const role = String(user?.role || "").trim().toLowerCase().replace(/\s+/g, "_");
  return role === "super_admin" || role === "personnel";
}

function bindFleetMonitoringActions() {
  const card = document.querySelector(".fleet-overview-card");
  if (!card || card.dataset.fleetBound === "true") return;
  card.dataset.fleetBound = "true";

  document.getElementById("openFleetOverviewBtn")?.addEventListener("click", openFleetOverviewParentModal);
  ["fleetOverviewParentOverlay", "fleetOverviewParentCloseBtn"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", closeFleetOverviewParentModal);
  });
  document.getElementById("fleetRefreshBtn")?.addEventListener("click", () => {
    void refreshFleetMonitoring();
  });
  document.getElementById("fleetAddTruckBtn")?.addEventListener("click", (event) => {
    openAddTruckModal(event.currentTarget);
  });
  document.getElementById("fleetVehicleIssuesBtn")?.addEventListener("click", (event) => {
    void openFleetVehicleIssuesModal(event.currentTarget);
  });
  document.getElementById("fleetVehicleIssuesRefreshBtn")?.addEventListener("click", async () => {
    fleetSetVehicleIssueStatus("Refreshing vehicle issues...");
    try {
      await loadVehicleIssues();
    } catch (error) {
      fleetSetVehicleIssueStatus(
        fleetErrorMessage(error, "Vehicle issues could not be loaded."),
        "error"
      );
    }
  });
  ["fleetVehicleIssueStatusFilter", "fleetVehicleIssueSeverityFilter"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", renderFleetVehicleIssueTable);
  });
  document.getElementById("fleetVehicleIssuesTableBody")?.addEventListener("click", (event) => {
    const viewButton = event.target.closest("[data-vehicle-issue-view]");
    if (viewButton) void openFleetVehicleIssueDetail(viewButton.dataset.vehicleIssueView, viewButton);
  });
  document.getElementById("fleetTableBody")?.addEventListener("click", (event) => {
    const manageButton = event.target.closest("[data-fleet-manage]");
    if (manageButton) {
      openFleetManageModal(manageButton.dataset.fleetManage, manageButton);
      return;
    }

    if (event.target.closest("[data-fleet-retry]")) void refreshFleetMonitoring();
  });

  document.getElementById("fleetManageEditBtn")?.addEventListener("click", () => {
    if (!fleetSelectedManageTruck) return;
    const truckId = fleetSelectedManageTruck.id;
    const returnFocus = fleetLastModalTrigger;
    fleetCloseModal("fleetManageModal");
    fleetSelectedManageTruck = null;
    openFleetEditTruckModal(truckId, returnFocus);
  });

  document.getElementById("fleetManageConditionBtn")?.addEventListener("click", () => {
    if (!fleetSelectedManageTruck) return;
    const truckId = fleetSelectedManageTruck.id;
    const returnFocus = fleetLastModalTrigger;
    fleetCloseModal("fleetManageModal");
    fleetSelectedManageTruck = null;
    openFleetConditionModal(truckId, returnFocus);
  });

  document.getElementById("fleetManageVehicleIssueBtn")?.addEventListener("click", (event) => {
    const reportId = document.getElementById("fleetManageVehicleIssue")?.dataset.reportId;
    if (!reportId) return;
    const returnFocus = fleetLastModalTrigger;
    fleetCloseModal("fleetManageModal");
    fleetSelectedManageTruck = null;
    void openFleetVehicleIssueDetail(reportId, returnFocus || event.currentTarget);
  });

  document.getElementById("fleetVehicleIssueReviewBtn")?.addEventListener("click", () => {
    void markFleetVehicleIssueUnderReview();
  });
  document.getElementById("fleetVehicleIssueResolutionAction")?.addEventListener(
    "change",
    fleetUpdateVehicleIssueResolutionGuidance
  );
  document.getElementById("fleetVehicleIssueResolutionForm")?.addEventListener(
    "submit",
    resolveFleetVehicleIssue
  );

  document.getElementById("fleetEditTruckForm")?.addEventListener("submit", updateFleetTruckDetails);

  document.getElementById("fleetInitialCondition")?.addEventListener("change", () => {
    fleetToggleReasonField("fleetInitialCondition", "fleetInitialReasonField", "fleetInitialReason");
  });
  document.getElementById("fleetConditionValue")?.addEventListener("change", () => {
    fleetToggleReasonField("fleetConditionValue", "fleetConditionReasonField", "fleetConditionReason");
  });
  document.getElementById("fleetAddTruckForm")?.addEventListener("submit", submitFleetTruck);
  document.getElementById("fleetConditionForm")?.addEventListener("submit", updateFleetCondition);

  ["fleetManageOverlay", "fleetManageCloseBtn"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", () => {
      fleetCloseModal("fleetManageModal");
      fleetSelectedManageTruck = null;
    });
  });

  ["fleetVehicleIssuesOverlay", "fleetVehicleIssuesCloseBtn"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", closeFleetVehicleIssuesModal);
  });
  ["fleetVehicleIssueDetailOverlay", "fleetVehicleIssueDetailCloseBtn"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", closeFleetVehicleIssueDetailModal);
  });

  ["fleetEditTruckOverlay", "fleetEditTruckCloseBtn", "fleetEditTruckCancelBtn"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", () => {
      fleetCloseModal("fleetEditTruckModal");
      fleetSelectedEditTruck = null;
    });
  });

  ["fleetAddTruckOverlay", "fleetAddTruckCloseBtn"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", () => fleetCloseModal("fleetAddTruckModal"));
  });
  ["fleetConditionOverlay", "fleetConditionCloseBtn"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", () => fleetCloseModal("fleetConditionModal"));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;

    if (!document.getElementById("fleetVehicleIssueDetailModal")?.classList.contains("hidden")) {
      closeFleetVehicleIssueDetailModal();
    } else if (!document.getElementById("fleetVehicleIssuesModal")?.classList.contains("hidden")) {
      closeFleetVehicleIssuesModal();
    } else if (!document.getElementById("fleetEditTruckModal")?.classList.contains("hidden")) {
      fleetCloseModal("fleetEditTruckModal");
      fleetSelectedEditTruck = null;
    } else if (!document.getElementById("fleetConditionModal")?.classList.contains("hidden")) {
      fleetCloseModal("fleetConditionModal");
      fleetSelectedConditionTruck = null;
    } else if (!document.getElementById("fleetManageModal")?.classList.contains("hidden")) {
      fleetCloseModal("fleetManageModal");
      fleetSelectedManageTruck = null;
    } else if (!document.getElementById("fleetAddTruckModal")?.classList.contains("hidden")) {
      fleetCloseModal("fleetAddTruckModal");
    } else if (fleetModalIsOpen("fleetOverviewModal")) {
      closeFleetOverviewParentModal();
    }
  });
}

async function initializeFleetMonitoring() {
  const card = document.querySelector(".fleet-overview-card");
  if (!card) return;
  const user = typeof currentUser !== "undefined" ? currentUser : null;
  const hasAccess = fleetUserHasAccess(user);
  fleetSetTriggerAccess(hasAccess);
  if (!hasAccess) {
    card.hidden = true;
    return;
  }
  fleetMountModalsToBody();
  bindFleetMonitoringActions();
  renderFleetSummary(FLEET_EMPTY_SUMMARY);
  await refreshFleetMonitoring({ announce: false });
}

if (typeof window !== "undefined") {
  window.initializeFleetMonitoring = initializeFleetMonitoring;
  window.loadFleetSummary = loadFleetSummary;
  window.loadFleetTrucks = loadFleetTrucks;
  window.loadVehicleIssues = loadVehicleIssues;
  window.renderFleetSummary = renderFleetSummary;
  window.renderFleetTable = renderFleetTable;
  window.openAddTruckModal = openAddTruckModal;
  window.submitFleetTruck = submitFleetTruck;
  window.openFleetManageModal = openFleetManageModal;
  window.openFleetEditTruckModal = openFleetEditTruckModal;
  window.updateFleetTruckDetails = updateFleetTruckDetails;
  window.openFleetConditionModal = openFleetConditionModal;
  window.updateFleetCondition = updateFleetCondition;
  window.openFleetVehicleIssuesModal = openFleetVehicleIssuesModal;
  window.openFleetVehicleIssueDetail = openFleetVehicleIssueDetail;
  window.markFleetVehicleIssueUnderReview = markFleetVehicleIssueUnderReview;
  window.resolveFleetVehicleIssue = resolveFleetVehicleIssue;
  window.openFleetOverviewParentModal = openFleetOverviewParentModal;
  window.closeFleetOverviewParentModal = closeFleetOverviewParentModal;
  window.closeFleetModalsForNavigation = closeFleetModalsForNavigation;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    FLEET_CONDITION_LABELS,
    FLEET_OPERATIONAL_LABELS,
    FLEET_GPS_LABELS,
    FLEET_TRACKING_LABELS,
    FLEET_ASSIGNMENT_LABELS,
    VEHICLE_ISSUE_SEVERITY_LABELS,
    VEHICLE_ISSUE_STATUS_LABELS,
    VEHICLE_ISSUE_RESOLUTION_LABELS,
    fleetConditionLabel,
    fleetOperationalLabel,
    fleetGpsLabel,
    fleetTrackingKey,
    fleetTrackingLabel,
    fleetAssignmentKey,
    fleetAssignmentLabel,
    fleetRequiresReason,
    fleetValidateTruck,
    fleetValidateTruckDetails,
    fleetValidateCondition,
    fleetVehicleIssueSeverityLabel,
    fleetVehicleIssueStatusLabel,
    fleetVehicleIssueCategoryLabel,
    fleetVehicleIssueResolutionLabel,
    fleetVehicleIssueIsOpen,
    fleetVehicleIssueResolutionRequiresNotes,
    fleetValidateVehicleIssueResolution,
    fleetVehicleIssueFilteredReports,
    fleetLatestOpenIssueForTruck,
    fleetVehicleIssueRowsHtml,
    fleetVehicleIssueDetailHtml,
    fleetTableRowsHtml,
    renderFleetSummary,
    renderFleetTable,
    fleetErrorMessage,
    fleetUserHasAccess,
    loadFleetSummary,
    loadFleetTrucks,
    refreshFleetMonitoring,
    submitFleetTruck,
    updateFleetTruckDetails,
    updateFleetCondition
  };
}
