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

const FLEET_GPS_LABELS = Object.freeze({
  online: "Online",
  stale: "Stale",
  offline: "Offline"
});

const FLEET_EMPTY_SUMMARY = Object.freeze({
  total: 0,
  available: 0,
  active: 0,
  for_maintenance: 0,
  out_of_service: 0
});

let fleetTrucksCache = [];
let fleetSummaryCache = { ...FLEET_EMPTY_SUMMARY };
let fleetHasLoadedTrucks = false;
let fleetSelectedConditionTruck = null;
let fleetLastModalTrigger = null;
let fleetParentModalTrigger = null;
let fleetRefreshInProgress = false;

const FLEET_CHILD_MODAL_IDS = Object.freeze([
  "fleetAddTruckModal",
  "fleetConditionModal"
]);

function fleetEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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
  return FLEET_OPERATIONAL_LABELS[key] || String(truck.operational_state || "").trim() || "Off Duty";
}

function fleetGpsLabel(status) {
  return FLEET_GPS_LABELS[String(status || "offline").toLowerCase()] || "Offline";
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
    const condition = String(truck.fleet_condition || "").toLowerCase();
    const operationalKey = String(truck.operational_state_key || "off_duty").toLowerCase();
    const gpsKey = String(truck.gps_status || "offline").toLowerCase();
    const truckCode = String(truck.truck_code || "").trim() || "Not recorded";
    const truckName = String(truck.truck_name || "").trim() || truckCode;
    const assignable = truck.assignable === true;
    return `
      <tr>
        <td>
          <strong class="fleet-truck-code">${fleetEscape(truckCode)}</strong>
          <small class="fleet-cell-note">${fleetEscape(truckName)}</small>
        </td>
        <td>${fleetEscape(String(truck.plate_number || "").trim() || "Not recorded")}</td>
        <td>${fleetConditionBadge(truck)}</td>
        <td><span class="fleet-badge operational ${fleetEscape(operationalKey)}">${fleetEscape(fleetOperationalLabel(truck))}</span></td>
        <td><span class="fleet-badge gps ${fleetEscape(gpsKey)}">${fleetEscape(fleetGpsLabel(gpsKey))}</span></td>
        <td><span class="fleet-badge assignable ${assignable ? "yes" : "no"}">${assignable ? "Yes" : "No"}</span></td>
        <td>
          <button
            type="button"
            class="fleet-row-action"
            data-fleet-change-condition="${fleetEscape(Number.isInteger(id) && id > 0 ? id : "")}"
            aria-label="Change condition for ${fleetEscape(truckCode)}"
            ${Number.isInteger(id) && id > 0 ? "" : "disabled"}
          >Change Condition</button>
        </td>
      </tr>`;
  }).join("");
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
    const [summaryResult, trucksResult] = await Promise.allSettled([
      loadFleetSummary(),
      loadFleetTrucks()
    ]);
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

function openFleetConditionModal(truckId, trigger = null) {
  const id = Number(truckId);
  const truck = fleetTrucksCache.find((item) => Number(item.id) === id);
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
  document.getElementById("fleetTableBody")?.addEventListener("click", (event) => {
    const conditionButton = event.target.closest("[data-fleet-change-condition]");
    if (conditionButton) {
      openFleetConditionModal(conditionButton.dataset.fleetChangeCondition, conditionButton);
      return;
    }
    if (event.target.closest("[data-fleet-retry]")) void refreshFleetMonitoring();
  });

  document.getElementById("fleetInitialCondition")?.addEventListener("change", () => {
    fleetToggleReasonField("fleetInitialCondition", "fleetInitialReasonField", "fleetInitialReason");
  });
  document.getElementById("fleetConditionValue")?.addEventListener("change", () => {
    fleetToggleReasonField("fleetConditionValue", "fleetConditionReasonField", "fleetConditionReason");
  });
  document.getElementById("fleetAddTruckForm")?.addEventListener("submit", submitFleetTruck);
  document.getElementById("fleetConditionForm")?.addEventListener("submit", updateFleetCondition);

  ["fleetAddTruckOverlay", "fleetAddTruckCloseBtn"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", () => fleetCloseModal("fleetAddTruckModal"));
  });
  ["fleetConditionOverlay", "fleetConditionCloseBtn"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", () => fleetCloseModal("fleetConditionModal"));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!document.getElementById("fleetConditionModal")?.classList.contains("hidden")) {
      fleetCloseModal("fleetConditionModal");
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
  window.renderFleetSummary = renderFleetSummary;
  window.renderFleetTable = renderFleetTable;
  window.openAddTruckModal = openAddTruckModal;
  window.submitFleetTruck = submitFleetTruck;
  window.openFleetConditionModal = openFleetConditionModal;
  window.updateFleetCondition = updateFleetCondition;
  window.openFleetOverviewParentModal = openFleetOverviewParentModal;
  window.closeFleetOverviewParentModal = closeFleetOverviewParentModal;
  window.closeFleetModalsForNavigation = closeFleetModalsForNavigation;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    FLEET_CONDITION_LABELS,
    FLEET_OPERATIONAL_LABELS,
    FLEET_GPS_LABELS,
    fleetConditionLabel,
    fleetOperationalLabel,
    fleetGpsLabel,
    fleetRequiresReason,
    fleetValidateTruck,
    fleetValidateCondition,
    fleetTableRowsHtml,
    renderFleetSummary,
    renderFleetTable,
    fleetErrorMessage,
    fleetUserHasAccess,
    loadFleetSummary,
    loadFleetTrucks,
    refreshFleetMonitoring,
    submitFleetTruck,
    updateFleetCondition
  };
}
