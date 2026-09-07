(function dispatchPlansModule(globalScope) {
  "use strict";

  const MANILA_TIME_ZONE = "Asia/Manila";
  const PLAN_STATUSES = new Set(["planned", "activated", "cancelled"]);
  const AUTHORIZED_ROLES = new Set(["super_admin", "personnel"]);
  const DESTINATION_TYPES = Object.freeze(["road_segment", "barangay_hall"]);
  const DESTINATION_LIMIT = 1000;

  const dispatchPlanState = {
    plans: [],
    options: { fleet_trucks: [], enforcers: [] },
    destinations: [],
    stops: [],
    mode: "create",
    editingPlan: null,
    cancellingPlan: null,
    loadingOptions: false,
    loadingDestinations: false,
    submitting: false,
    optionsGeneration: 0,
    destinationPromise: null,
    returnFocus: null,
    parentReturnFocus: null
  };

  const DISPATCH_PLAN_CHILD_MODAL_IDS = Object.freeze([
    "dispatchPlanFormModal",
    "dispatchPlanDetailModal",
    "dispatchPlanCancelModal"
  ]);

  function dispatchPlanElement(id) {
    if (typeof document === "undefined") return null;
    return document.getElementById(id);
  }

  function dispatchPlanEscape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function dispatchPlanPositiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  function dispatchPlanCalendarDate(now = new Date(), offsetDays = 0) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: MANILA_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(now);
    const values = Object.fromEntries(
      parts
        .filter((part) => ["year", "month", "day"].includes(part.type))
        .map((part) => [part.type, part.value])
    );
    const calendar = new Date(Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day) + Number(offsetDays || 0)
    ));
    return [
      calendar.getUTCFullYear(),
      String(calendar.getUTCMonth() + 1).padStart(2, "0"),
      String(calendar.getUTCDate()).padStart(2, "0")
    ].join("-");
  }

  function dispatchPlanTodayInManila(now = new Date()) {
    return dispatchPlanCalendarDate(now, 0);
  }

  function dispatchPlanTomorrowInManila(now = new Date()) {
    return dispatchPlanCalendarDate(now, 1);
  }

  function dispatchPlanValidCalendarDate(value) {
    const text = String(value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
    const [year, month, day] = text.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day;
  }

  function dispatchPlanValidateOperationalDate(value, now = new Date()) {
    const date = String(value || "").trim();
    if (!dispatchPlanValidCalendarDate(date)) {
      return { valid: false, message: "Choose a valid operational date." };
    }
    if (date < dispatchPlanTodayInManila(now)) {
      return {
        valid: false,
        message: "Operational Date cannot be in the past in Asia/Manila."
      };
    }
    return { valid: true, value: date, message: "" };
  }

  function dispatchPlanNormalizeRole(role) {
    return String(role || "").trim().toLowerCase().replace(/\s+/g, "_");
  }

  function dispatchPlanUserHasAccess(user) {
    return AUTHORIZED_ROLES.has(dispatchPlanNormalizeRole(user?.role));
  }

  function dispatchPlanCurrentUser() {
    try {
      return typeof currentUser !== "undefined" ? currentUser : globalScope.currentUser;
    } catch (error) {
      return globalScope.currentUser || null;
    }
  }

  function dispatchPlanStatusLabel(status) {
    const normalized = String(status || "").trim().toLowerCase();
    return {
      planned: "Planned",
      activated: "Activated",
      cancelled: "Cancelled"
    }[normalized] || "Unknown";
  }

  function dispatchPlanViewPermissions(status) {
    const planned = String(status || "").trim().toLowerCase() === "planned";
    return { canView: true, canEdit: planned, canCancel: planned };
  }

  function dispatchPlanTruckPrimary(truck = {}) {
    return String(truck.truck_name || truck.truck_name_snapshot || truck.truck_code || "Truck").trim();
  }

  function dispatchPlanTruckSecondary(truck = {}) {
    return [truck.truck_code || truck.truck_code_snapshot, truck.plate_number]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" · ");
  }

  function dispatchPlanDestinationLabel(destination = {}) {
    return String(
      destination.display_label ||
      destination.location_name_snapshot ||
      destination.name ||
      "Destination"
    ).trim();
  }

  function dispatchPlanDestinationSecondary(destination = {}) {
    const barangay = destination.barangay || destination.address_reference_snapshot;
    const type = String(destination.destination_type || "") === "barangay_hall"
      ? "Barangay Hall"
      : "Road / Street";
    return [barangay, type]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" · ");
  }

  function dispatchPlanTruckOptionsHtml(trucks = [], selectedId = null) {
    const selected = dispatchPlanPositiveId(selectedId);
    return [
      '<option value="">Choose an eligible truck</option>',
      ...trucks.map((truck) => {
        const id = dispatchPlanPositiveId(truck.id);
        const primary = dispatchPlanTruckPrimary(truck);
        const secondary = dispatchPlanTruckSecondary(truck);
        const suffix = truck.current_assignment ? " · Current assignment" : "";
        return `<option value="${id || ""}"${id === selected ? " selected" : ""}>${dispatchPlanEscape(primary)}${secondary ? ` — ${dispatchPlanEscape(secondary)}` : ""}${suffix}</option>`;
      })
    ].join("");
  }

  function dispatchPlanEnforcerOptionsHtml(enforcers = [], selectedId = null) {
    const selected = dispatchPlanPositiveId(selectedId);
    return [
      '<option value="">Choose an eligible enforcer</option>',
      ...enforcers.map((enforcer) => {
        const id = dispatchPlanPositiveId(enforcer.id);
        const label = String(
          enforcer.display_name || enforcer.assigned_enforcer_name_snapshot || "Enforcer"
        ).trim();
        const suffix = enforcer.current_assignment ? " · Current assignment" : "";
        return `<option value="${id || ""}"${id === selected ? " selected" : ""}>${dispatchPlanEscape(label)}${suffix}</option>`;
      })
    ].join("");
  }

  function dispatchPlanDestinationOptionsHtml(destinations = [], selectedIds = []) {
    const used = new Set((selectedIds || []).map(Number));
    return [
      '<option value="">Choose a destination</option>',
      ...destinations.map((destination) => {
        const id = dispatchPlanPositiveId(destination.id);
        const primary = dispatchPlanDestinationLabel(destination);
        const secondary = dispatchPlanDestinationSecondary(destination);
        return `<option value="${id || ""}"${used.has(id) ? " disabled" : ""}>${dispatchPlanEscape(primary)}${secondary ? ` — ${dispatchPlanEscape(secondary)}` : ""}</option>`;
      })
    ].join("");
  }

  function dispatchPlanRenumberStops(stops = []) {
    return stops.map((stop, index) => ({ ...stop, stop_order: index + 1 }));
  }

  function dispatchPlanAddStopToList(stops = [], destination = {}) {
    const destinationId = dispatchPlanPositiveId(destination.id || destination.destination_id);
    if (!destinationId) {
      return { stops: dispatchPlanRenumberStops(stops), error: "Choose a verified destination." };
    }
    if (stops.some((stop) => Number(stop.destination_id) === destinationId)) {
      return {
        stops: dispatchPlanRenumberStops(stops),
        error: "That destination is already included in this plan."
      };
    }
    return {
      stops: dispatchPlanRenumberStops([
        ...stops,
        {
          destination_id: destinationId,
          destination_type: destination.destination_type || null,
          display_label: dispatchPlanDestinationLabel(destination),
          barangay: destination.barangay || destination.address_reference_snapshot || null,
          expected_arrival: ""
        }
      ]),
      error: ""
    };
  }

  function dispatchPlanRemoveStopFromList(stops = [], index) {
    if (!Number.isInteger(index) || index < 0 || index >= stops.length) {
      return dispatchPlanRenumberStops(stops);
    }
    return dispatchPlanRenumberStops(stops.filter((stop, position) => position !== index));
  }

  function dispatchPlanMoveStopInList(stops = [], index, direction) {
    const next = stops.map((stop) => ({ ...stop }));
    const target = direction === "up" ? index - 1 : index + 1;
    if (
      !Number.isInteger(index) || index < 0 || index >= next.length ||
      target < 0 || target >= next.length
    ) {
      return dispatchPlanRenumberStops(next);
    }
    [next[index], next[target]] = [next[target], next[index]];
    return dispatchPlanRenumberStops(next);
  }

  function dispatchPlanBuildPayload(values = {}, stops = []) {
    return {
      operational_date: String(values.operational_date || "").trim(),
      fleet_truck_id: dispatchPlanPositiveId(values.fleet_truck_id),
      assigned_enforcer_user_id: dispatchPlanPositiveId(values.assigned_enforcer_user_id),
      route_name: String(values.route_name || "").trim(),
      description: String(values.description || "").trim() || null,
      scheduled_start: String(values.scheduled_start || "").trim() || null,
      expected_return: String(values.expected_return || "").trim() || null,
      notes: String(values.notes || "").trim() || null,
      stops: dispatchPlanRenumberStops(stops).map((stop) => ({
        destination_id: dispatchPlanPositiveId(stop.destination_id),
        stop_order: Number(stop.stop_order),
        expected_arrival: String(stop.expected_arrival || "").trim() || null
      }))
    };
  }

  function dispatchPlanValidatePayload(payload, now = new Date()) {
    const dateResult = dispatchPlanValidateOperationalDate(payload.operational_date, now);
    if (!dateResult.valid) return dateResult;
    if (!dispatchPlanPositiveId(payload.fleet_truck_id)) {
      return { valid: false, message: "Choose an eligible fleet truck." };
    }
    if (!dispatchPlanPositiveId(payload.assigned_enforcer_user_id)) {
      return { valid: false, message: "Choose an eligible active enforcer." };
    }
    if (!Array.isArray(payload.stops) || !payload.stops.length) {
      return { valid: false, message: "Add at least one ordered destination." };
    }
    const uniqueDestinations = new Set(payload.stops.map((stop) => stop.destination_id));
    if (uniqueDestinations.size !== payload.stops.length) {
      return { valid: false, message: "A destination can appear only once in a plan." };
    }
    return { valid: true, message: "" };
  }

  function dispatchPlanValidateCancellation(reason) {
    const value = String(reason || "").trim();
    return value
      ? { valid: true, value, message: "" }
      : { valid: false, value: "", message: "Cancellation Reason is required." };
  }

  function dispatchPlanErrorMessage(error = {}) {
    const code = String(error.code || "");
    if (Number(error.status) === 401) return "Your Web Admin session has expired.";
    if (Number(error.status) === 403) return "You do not have permission to manage dispatch plans.";
    if (code === "DISPATCH_PLAN_TRUCK_CONFLICT") {
      return "This truck is already assigned for the selected operational date.";
    }
    if (code === "DISPATCH_PLAN_ENFORCER_CONFLICT") {
      return "This enforcer is already assigned for the selected operational date.";
    }
    if (code === "DISPATCH_PLAN_IMMUTABLE") {
      return "This plan is no longer editable. The latest plan data has been reloaded.";
    }
    if (Number(error.status) === 409) {
      return "The plan conflicts with newer operational data. Review the refreshed options and try again.";
    }
    if (Number(error.status) >= 500) {
      return "Dispatch planning is temporarily unavailable. Please try again.";
    }
    return String(error.message || "Unable to complete the dispatch planning request.");
  }

  async function dispatchPlanRunMutation({
    request,
    url,
    method,
    payload,
    refreshPlans,
    refreshOptions
  }) {
    try {
      const result = await request(url, { method, body: JSON.stringify(payload) });
      await Promise.allSettled([refreshPlans(), refreshOptions()]);
      return result;
    } catch (error) {
      if (Number(error.status) === 409) {
        await Promise.allSettled([refreshPlans(), refreshOptions()]);
      }
      throw error;
    }
  }

  function dispatchPlanDateTimeDisplay(value) {
    const text = String(value || "").trim();
    if (!text) return "Not set";
    return text.replace("T", " ").replace(/\.\d{1,3}$/, "").slice(0, 16);
  }

  function dispatchPlanToInputDateTime(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    return text.replace(" ", "T").slice(0, 16);
  }

  function dispatchPlanRowsHtml(plans = []) {
    if (!plans.length) {
      return '<tr><td colspan="8" class="dispatch-plans-table-state"><strong>No planned dispatches found.</strong><span>Adjust the filters or create a plan for this operational date.</span></td></tr>';
    }
    return plans.map((plan) => {
      const status = String(plan.status || "").toLowerCase();
      const permissions = dispatchPlanViewPermissions(status);
      const schedule = [
        dispatchPlanDateTimeDisplay(plan.scheduled_start),
        dispatchPlanDateTimeDisplay(plan.expected_return)
      ];
      const actions = [
        `<button type="button" class="dispatch-plan-row-action" data-dispatch-plan-action="view" data-plan-id="${Number(plan.id)}">View</button>`,
        permissions.canEdit
          ? `<button type="button" class="dispatch-plan-row-action" data-dispatch-plan-action="edit" data-plan-id="${Number(plan.id)}">Edit</button>`
          : "",
        permissions.canCancel
          ? `<button type="button" class="dispatch-plan-row-action danger" data-dispatch-plan-action="cancel" data-plan-id="${Number(plan.id)}">Cancel</button>`
          : ""
      ].join("");
      return `
        <tr>
          <td><span class="dispatch-plan-cell-primary">${dispatchPlanEscape(plan.operational_date)}</span></td>
          <td><span class="dispatch-plan-cell-primary">${dispatchPlanEscape(plan.truck_name_snapshot || plan.truck_code_snapshot || "Truck")}</span><span class="dispatch-plan-cell-secondary">${dispatchPlanEscape(plan.truck_code_snapshot || "")}</span></td>
          <td>${dispatchPlanEscape(plan.assigned_enforcer_name_snapshot || "Not recorded")}</td>
          <td><span class="dispatch-plan-cell-primary">${dispatchPlanEscape(plan.route_name || "Planned Route")}</span><span class="dispatch-plan-cell-secondary">Revision ${Number(plan.revision || 1)}</span></td>
          <td>${Number(plan.stop_count || 0)}</td>
          <td><span class="dispatch-plan-cell-primary">${dispatchPlanEscape(schedule[0])}</span><span class="dispatch-plan-cell-secondary">Return: ${dispatchPlanEscape(schedule[1])}</span></td>
          <td><span class="dispatch-plan-status-badge ${dispatchPlanEscape(status)}">${dispatchPlanEscape(dispatchPlanStatusLabel(status))}</span></td>
          <td><div class="dispatch-plan-row-actions">${actions}</div></td>
        </tr>`;
    }).join("");
  }

  function dispatchPlanDetailHtml(plan = {}) {
    const stops = [...(plan.stops || [])].sort(
      (left, right) => Number(left.stop_order) - Number(right.stop_order)
    );
    const stopMarkup = stops.length
      ? stops.map((stop, index) => `
          <div class="dispatch-plan-detail-stop">
            <span class="dispatch-plan-stop-number">${index + 1}</span>
            <div class="dispatch-plan-stop-copy">
              <strong>${dispatchPlanEscape(stop.location_name_snapshot || "Destination")}</strong>
              <span>${dispatchPlanEscape(stop.address_reference_snapshot || "Address not recorded")}${stop.expected_arrival ? ` · Expected ${dispatchPlanEscape(dispatchPlanDateTimeDisplay(stop.expected_arrival))}` : ""}</span>
            </div>
          </div>`).join("")
      : '<p>No ordered destinations were recorded.</p>';
    return `
      <div class="dispatch-plan-detail-grid">
        <div class="dispatch-plan-detail-item"><span>Status</span><strong><span class="dispatch-plan-status-badge ${dispatchPlanEscape(plan.status)}">${dispatchPlanEscape(dispatchPlanStatusLabel(plan.status))}</span></strong></div>
        <div class="dispatch-plan-detail-item"><span>Operational Date</span><strong>${dispatchPlanEscape(plan.operational_date || "Not recorded")}</strong></div>
        <div class="dispatch-plan-detail-item"><span>Truck</span><strong>${dispatchPlanEscape(plan.truck_name_snapshot || "Not recorded")} · ${dispatchPlanEscape(plan.truck_code_snapshot || "No code")}</strong></div>
        <div class="dispatch-plan-detail-item"><span>Enforcer</span><strong>${dispatchPlanEscape(plan.assigned_enforcer_name_snapshot || "Not recorded")}</strong></div>
        <div class="dispatch-plan-detail-item"><span>Route Name</span><strong>${dispatchPlanEscape(plan.route_name || "Planned Route")}</strong></div>
        <div class="dispatch-plan-detail-item"><span>Revision</span><strong>${Number(plan.revision || 1)}</strong></div>
        <div class="dispatch-plan-detail-item"><span>Scheduled Start</span><strong>${dispatchPlanEscape(dispatchPlanDateTimeDisplay(plan.scheduled_start))}</strong></div>
        <div class="dispatch-plan-detail-item"><span>Expected Return</span><strong>${dispatchPlanEscape(dispatchPlanDateTimeDisplay(plan.expected_return))}</strong></div>
        <section class="dispatch-plan-detail-section"><h4>Description</h4><p>${dispatchPlanEscape(plan.description || "Not provided")}</p></section>
        <section class="dispatch-plan-detail-section"><h4>Notes</h4><p>${dispatchPlanEscape(plan.notes || "Not provided")}</p></section>
        <section class="dispatch-plan-detail-section"><h4>Ordered Stops</h4><div class="dispatch-plan-detail-stops">${stopMarkup}</div></section>
        ${plan.cancellation_reason ? `<section class="dispatch-plan-detail-section"><h4>Cancellation Reason</h4><p>${dispatchPlanEscape(plan.cancellation_reason)}</p></section>` : ""}
      </div>`;
  }

  function dispatchPlanSetFeedback(id, message = "", type = "error") {
    const element = dispatchPlanElement(id);
    if (!element) return;
    element.textContent = message;
    element.classList.toggle("hidden", !message);
    element.classList.toggle("error", Boolean(message) && type === "error");
  }

  function dispatchPlanNotify(message, type = "success") {
    if (typeof globalScope.showToast === "function") {
      globalScope.showToast(message, type);
    }
  }

  async function dispatchPlanRequest(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await globalScope.webAdminFetch(url, { ...options, headers });
    let payload = {};
    try {
      payload = await response.json();
    } catch (error) {
      payload = {};
    }
    if (!response.ok) {
      const requestError = new Error(
        response.status >= 500
          ? "Dispatch planning is temporarily unavailable."
          : payload.message || `Dispatch planning request failed (${response.status}).`
      );
      requestError.status = response.status;
      requestError.code = payload.code || "DISPATCH_PLAN_REQUEST_FAILED";
      throw requestError;
    }
    return payload.data;
  }

  function dispatchPlanFilters() {
    return {
      operational_date: dispatchPlanElement("dispatchPlansDateFilter")?.value || "",
      status: dispatchPlanElement("dispatchPlansStatusFilter")?.value || ""
    };
  }

  function renderDispatchPlans(plans = dispatchPlanState.plans) {
    const body = dispatchPlanElement("dispatchPlansTableBody");
    if (body) body.innerHTML = dispatchPlanRowsHtml(plans);
  }

  async function loadDispatchPlans() {
    const body = dispatchPlanElement("dispatchPlansTableBody");
    if (body) {
      body.innerHTML = '<tr><td colspan="8" class="dispatch-plans-table-state">Loading planned dispatches...</td></tr>';
    }
    dispatchPlanSetFeedback("dispatchPlansStatusMessage");
    try {
      dispatchPlanState.plans = await dispatchPlanRequest(
        globalScope.getDispatchPlansApiUrl(dispatchPlanFilters())
      );
      renderDispatchPlans();
      return dispatchPlanState.plans;
    } catch (error) {
      dispatchPlanState.plans = [];
      if (body) {
        body.innerHTML = '<tr><td colspan="8" class="dispatch-plans-table-state"><strong>Dispatch plans could not be loaded.</strong><span>Use Refresh to try again.</span></td></tr>';
      }
      dispatchPlanSetFeedback(
        "dispatchPlansStatusMessage",
        dispatchPlanErrorMessage(error),
        "error"
      );
      return [];
    }
  }

  function dispatchPlanSelectedAssignmentFallback(kind, date) {
    const current = dispatchPlanState.editingPlan;
    if (!current || current.operational_date !== date) return null;
    if (kind === "truck") {
      return {
        id: current.fleet_truck_id,
        truck_code: current.truck_code_snapshot,
        truck_name: current.truck_name_snapshot,
        current_assignment: true
      };
    }
    return {
      id: current.assigned_enforcer_user_id,
      display_name: current.assigned_enforcer_name_snapshot,
      current_assignment: true
    };
  }

  function dispatchPlanWithFallback(options, fallback, selectedId) {
    const rows = Array.isArray(options) ? [...options] : [];
    const id = dispatchPlanPositiveId(selectedId);
    if (fallback && id && !rows.some((item) => Number(item.id) === id)) {
      rows.unshift(fallback);
    }
    return rows;
  }

  function dispatchPlanRenderOptions(preserved = {}) {
    const date = dispatchPlanElement("dispatchPlanOperationalDate")?.value || "";
    const truckSelect = dispatchPlanElement("dispatchPlanFleetTruck");
    const enforcerSelect = dispatchPlanElement("dispatchPlanEnforcer");
    const selectedTruckId = dispatchPlanPositiveId(
      preserved.truckId ?? truckSelect?.value ?? dispatchPlanState.editingPlan?.fleet_truck_id
    );
    const selectedEnforcerId = dispatchPlanPositiveId(
      preserved.enforcerId ?? enforcerSelect?.value ?? dispatchPlanState.editingPlan?.assigned_enforcer_user_id
    );
    const trucks = dispatchPlanWithFallback(
      dispatchPlanState.options.fleet_trucks,
      dispatchPlanSelectedAssignmentFallback("truck", date),
      selectedTruckId
    );
    const enforcers = dispatchPlanWithFallback(
      dispatchPlanState.options.enforcers,
      dispatchPlanSelectedAssignmentFallback("enforcer", date),
      selectedEnforcerId
    );
    if (truckSelect) {
      truckSelect.innerHTML = dispatchPlanTruckOptionsHtml(trucks, selectedTruckId);
      truckSelect.disabled = dispatchPlanState.loadingOptions || trucks.length === 0;
    }
    if (enforcerSelect) {
      enforcerSelect.innerHTML = dispatchPlanEnforcerOptionsHtml(enforcers, selectedEnforcerId);
      enforcerSelect.disabled = dispatchPlanState.loadingOptions || enforcers.length === 0;
    }
    dispatchPlanSetFeedback(
      "dispatchPlanTruckGuidance",
      !dispatchPlanState.loadingOptions && trucks.length === 0
        ? "No eligible fleet trucks are available for this date. Register and verify the WMO fleet roster in Fleet Monitoring before creating a dispatch plan."
        : "",
      "error"
    );
    dispatchPlanSetFeedback(
      "dispatchPlanEnforcerGuidance",
      !dispatchPlanState.loadingOptions && enforcers.length === 0
        ? "No eligible active mobile enforcers are available for this date."
        : "",
      "error"
    );
    dispatchPlanUpdateSaveState();
  }

  async function loadDispatchPlanOptions(operationalDate, preserved = {}) {
    const selected = {
      truckId: preserved.truckId ?? dispatchPlanElement("dispatchPlanFleetTruck")?.value,
      enforcerId: preserved.enforcerId ?? dispatchPlanElement("dispatchPlanEnforcer")?.value
    };
    const dateValidation = dispatchPlanValidateOperationalDate(operationalDate);
    if (!dateValidation.valid) {
      dispatchPlanState.options = { fleet_trucks: [], enforcers: [] };
      dispatchPlanRenderOptions(selected);
      dispatchPlanSetFeedback("dispatchPlanFormFeedback", dateValidation.message, "error");
      return dispatchPlanState.options;
    }
    const generation = ++dispatchPlanState.optionsGeneration;
    dispatchPlanState.loadingOptions = true;
    dispatchPlanRenderOptions(selected);
    try {
      const options = await dispatchPlanRequest(
        globalScope.getDispatchPlanOptionsApiUrl(dateValidation.value)
      );
      if (generation !== dispatchPlanState.optionsGeneration) return dispatchPlanState.options;
      dispatchPlanState.options = {
        fleet_trucks: Array.isArray(options?.fleet_trucks) ? options.fleet_trucks : [],
        enforcers: Array.isArray(options?.enforcers) ? options.enforcers : [],
        operational_date: options?.operational_date || dateValidation.value,
        destination_catalog: options?.destination_catalog || null
      };
      dispatchPlanSetFeedback("dispatchPlanFormFeedback");
      return dispatchPlanState.options;
    } catch (error) {
      if (generation === dispatchPlanState.optionsGeneration) {
        dispatchPlanState.options = { fleet_trucks: [], enforcers: [] };
        dispatchPlanSetFeedback(
          "dispatchPlanFormFeedback",
          dispatchPlanErrorMessage(error),
          "error"
        );
      }
      return dispatchPlanState.options;
    } finally {
      if (generation === dispatchPlanState.optionsGeneration) {
        dispatchPlanState.loadingOptions = false;
        dispatchPlanRenderOptions(selected);
      }
    }
  }

  function dispatchPlanRenderDestinationOptions() {
    const select = dispatchPlanElement("dispatchPlanDestinationSelect");
    if (!select) return;
    select.innerHTML = dispatchPlanDestinationOptionsHtml(
      dispatchPlanState.destinations,
      dispatchPlanState.stops.map((stop) => stop.destination_id)
    );
    select.disabled = dispatchPlanState.loadingDestinations || !dispatchPlanState.destinations.length;
    dispatchPlanSetFeedback(
      "dispatchPlanDestinationGuidance",
      !dispatchPlanState.loadingDestinations && !dispatchPlanState.destinations.length
        ? "No verified active destinations are currently available."
        : "",
      "error"
    );
  }

  async function loadDispatchPlanDestinations(options = {}) {
    if (dispatchPlanState.destinations.length && !options.force) {
      dispatchPlanRenderDestinationOptions();
      return dispatchPlanState.destinations;
    }
    if (dispatchPlanState.destinationPromise && !options.force) {
      return dispatchPlanState.destinationPromise;
    }
    dispatchPlanState.loadingDestinations = true;
    dispatchPlanRenderDestinationOptions();
    dispatchPlanState.destinationPromise = Promise.all(
      DESTINATION_TYPES.map((type) => dispatchPlanRequest(
        globalScope.getDispatchDestinationsApiUrl({ type, limit: DESTINATION_LIMIT })
      ))
    ).then((groups) => {
      const byId = new Map();
      groups.flat().forEach((destination) => {
        const id = dispatchPlanPositiveId(destination.id);
        if (id) byId.set(id, destination);
      });
      dispatchPlanState.destinations = [...byId.values()].sort((left, right) =>
        dispatchPlanDestinationLabel(left).localeCompare(
          dispatchPlanDestinationLabel(right),
          "en",
          { sensitivity: "base" }
        )
      );
      dispatchPlanSetFeedback("dispatchPlanDestinationGuidance");
      return dispatchPlanState.destinations;
    }).catch((error) => {
      dispatchPlanState.destinations = [];
      dispatchPlanSetFeedback(
        "dispatchPlanDestinationGuidance",
        dispatchPlanErrorMessage(error),
        "error"
      );
      return [];
    }).finally(() => {
      dispatchPlanState.loadingDestinations = false;
      dispatchPlanState.destinationPromise = null;
      dispatchPlanRenderDestinationOptions();
    });
    return dispatchPlanState.destinationPromise;
  }

  function dispatchPlanStopRowsHtml(stops = []) {
    if (!stops.length) {
      return '<div class="dispatch-plan-stops-empty"><strong>No destinations selected.</strong><span>Add verified destinations in the exact order they should be visited.</span></div>';
    }
    return stops.map((stop, index) => `
      <article class="dispatch-plan-stop-row" data-plan-stop-index="${index}">
        <span class="dispatch-plan-stop-number">${index + 1}</span>
        <div class="dispatch-plan-stop-copy">
          <strong>${dispatchPlanEscape(stop.display_label || stop.location_name_snapshot || "Destination")}</strong>
          <span>${dispatchPlanEscape(stop.barangay || stop.address_reference_snapshot || "Verified destination")}</span>
        </div>
        <label class="dispatch-plan-field dispatch-plan-stop-arrival">
          <span>Expected Arrival</span>
          <input type="datetime-local" data-plan-stop-arrival value="${dispatchPlanEscape(dispatchPlanToInputDateTime(stop.expected_arrival))}">
        </label>
        <div class="dispatch-plan-stop-controls" aria-label="Stop ${index + 1} ordering controls">
          <button type="button" class="dispatch-plan-stop-action" data-plan-stop-move="up" aria-label="Move ${dispatchPlanEscape(stop.display_label || "destination")} up"${index === 0 ? " disabled" : ""}>&uarr;</button>
          <button type="button" class="dispatch-plan-stop-action" data-plan-stop-move="down" aria-label="Move ${dispatchPlanEscape(stop.display_label || "destination")} down"${index === stops.length - 1 ? " disabled" : ""}>&darr;</button>
          <button type="button" class="dispatch-plan-stop-action remove" data-plan-stop-remove aria-label="Remove ${dispatchPlanEscape(stop.display_label || "destination")}">&times;</button>
        </div>
      </article>`).join("");
  }

  function renderPlanStops() {
    const container = dispatchPlanElement("dispatchPlanStops");
    if (container) container.innerHTML = dispatchPlanStopRowsHtml(dispatchPlanState.stops);
    dispatchPlanRenderDestinationOptions();
    dispatchPlanRenderReview();
  }

  function addPlanStop(destinationId) {
    const id = dispatchPlanPositiveId(destinationId);
    const destination = dispatchPlanState.destinations.find((item) => Number(item.id) === id);
    if (!destination) {
      dispatchPlanSetFeedback(
        "dispatchPlanDestinationGuidance",
        "Choose a verified destination.",
        "error"
      );
      return false;
    }
    const result = dispatchPlanAddStopToList(dispatchPlanState.stops, destination);
    if (result.error) {
      dispatchPlanSetFeedback("dispatchPlanDestinationGuidance", result.error, "error");
      return false;
    }
    dispatchPlanState.stops = result.stops;
    dispatchPlanSetFeedback("dispatchPlanDestinationGuidance");
    const select = dispatchPlanElement("dispatchPlanDestinationSelect");
    if (select) select.value = "";
    renderPlanStops();
    return true;
  }

  function removePlanStop(index) {
    dispatchPlanState.stops = dispatchPlanRemoveStopFromList(dispatchPlanState.stops, index);
    renderPlanStops();
  }

  function movePlanStop(index, direction) {
    dispatchPlanState.stops = dispatchPlanMoveStopInList(
      dispatchPlanState.stops,
      index,
      direction
    );
    renderPlanStops();
  }

  function dispatchPlanFormValues() {
    return {
      operational_date: dispatchPlanElement("dispatchPlanOperationalDate")?.value,
      fleet_truck_id: dispatchPlanElement("dispatchPlanFleetTruck")?.value,
      assigned_enforcer_user_id: dispatchPlanElement("dispatchPlanEnforcer")?.value,
      route_name: dispatchPlanElement("dispatchPlanRouteName")?.value,
      description: dispatchPlanElement("dispatchPlanDescription")?.value,
      scheduled_start: dispatchPlanElement("dispatchPlanScheduledStart")?.value,
      expected_return: dispatchPlanElement("dispatchPlanExpectedReturn")?.value,
      notes: dispatchPlanElement("dispatchPlanNotes")?.value
    };
  }

  function dispatchPlanRenderReview() {
    const payload = dispatchPlanBuildPayload(dispatchPlanFormValues(), dispatchPlanState.stops);
    const summary = dispatchPlanElement("dispatchPlanReviewSummary");
    if (summary) {
      const truck = dispatchPlanElement("dispatchPlanFleetTruck")?.selectedOptions?.[0]?.textContent;
      const enforcer = dispatchPlanElement("dispatchPlanEnforcer")?.selectedOptions?.[0]?.textContent;
      summary.textContent = payload.fleet_truck_id && payload.assigned_enforcer_user_id && payload.stops.length
        ? `${payload.operational_date}: ${truck} with ${enforcer}; ${payload.stops.length} ordered stop${payload.stops.length === 1 ? "" : "s"}.`
        : "Choose an eligible truck, enforcer, and at least one ordered destination.";
    }
    dispatchPlanUpdateSaveState();
  }

  function dispatchPlanUpdateSaveState() {
    const button = dispatchPlanElement("dispatchPlanSaveBtn");
    if (!button) return;
    const payload = dispatchPlanBuildPayload(dispatchPlanFormValues(), dispatchPlanState.stops);
    const valid = dispatchPlanValidatePayload(payload).valid;
    button.disabled = dispatchPlanState.submitting || dispatchPlanState.loadingOptions || !valid;
    button.textContent = dispatchPlanState.submitting
      ? "Saving..."
      : dispatchPlanState.mode === "edit" ? "Save Changes" : "Save Plan";
  }

  function dispatchPlanOpenModal(id, returnFocus = null) {
    const modal = dispatchPlanElement(id);
    if (!modal) return;
    dispatchPlanState.returnFocus = returnFocus || (typeof document !== "undefined" ? document.activeElement : null);
    modal.classList.remove("hidden");
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    dispatchPlanSyncModalScrollLock();
    modal.querySelector("button, input, select, textarea")?.focus();
  }

  function dispatchPlanCloseModal(id) {
    const modal = dispatchPlanElement(id);
    if (!modal) return;
    modal.classList.add("hidden");
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    const anotherOpen = document.querySelector(".dispatch-plan-modal:not(.hidden)");
    dispatchPlanSyncModalScrollLock();
    if (!anotherOpen && dispatchPlanState.returnFocus?.focus) {
      dispatchPlanState.returnFocus.focus();
      dispatchPlanState.returnFocus = null;
    }
  }

  function dispatchPlanModalIsOpen(id) {
    const modal = dispatchPlanElement(id);
    return Boolean(modal && !modal.classList.contains("hidden"));
  }

  function dispatchPlanHasOpenChildModal() {
    return DISPATCH_PLAN_CHILD_MODAL_IDS.some(dispatchPlanModalIsOpen);
  }

  function dispatchPlanSyncModalScrollLock() {
    const shouldLock = dispatchPlanModalIsOpen("dispatchPlanningModal") || dispatchPlanHasOpenChildModal();
    document.documentElement.classList.toggle("dispatch-plan-modal-open", shouldLock);
    document.body.classList.toggle("dispatch-plan-modal-open", shouldLock);
  }

  function openDispatchPlanningParentModal(triggerOrEvent = null) {
    const modal = dispatchPlanElement("dispatchPlanningModal");
    if (!modal) return false;
    const trigger = triggerOrEvent?.currentTarget || triggerOrEvent;
    dispatchPlanState.parentReturnFocus = trigger?.focus ? trigger : document.activeElement;
    modal.classList.remove("hidden");
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    dispatchPlanSyncModalScrollLock();
    dispatchPlanElement("dispatchPlanningParentCloseBtn")?.focus();
    void loadDispatchPlans();
    return true;
  }

  function closeDispatchPlanningParentModal() {
    if (dispatchPlanHasOpenChildModal()) return false;
    const modal = dispatchPlanElement("dispatchPlanningModal");
    if (!modal) return false;
    modal.classList.add("hidden");
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    dispatchPlanSyncModalScrollLock();
    dispatchPlanState.parentReturnFocus?.focus?.();
    dispatchPlanState.parentReturnFocus = null;
    return true;
  }

  function closeDispatchPlanningModalsForNavigation() {
    ["dispatchPlanningModal", ...DISPATCH_PLAN_CHILD_MODAL_IDS].forEach((id) => {
      const modal = dispatchPlanElement(id);
      if (!modal) return;
      modal.classList.add("hidden");
      modal.hidden = true;
      modal.setAttribute("aria-hidden", "true");
    });
    dispatchPlanState.returnFocus = null;
    dispatchPlanState.parentReturnFocus = null;
    dispatchPlanSyncModalScrollLock();
  }

  function dispatchPlanSetTriggerAccess(hasAccess) {
    const trigger = dispatchPlanElement("openDispatchPlanningBtn");
    if (!trigger) return;
    trigger.hidden = !hasAccess;
    trigger.disabled = !hasAccess;
    trigger.setAttribute("aria-hidden", String(!hasAccess));
  }

  function dispatchPlanResetForm() {
    dispatchPlanElement("dispatchPlanForm")?.reset();
    dispatchPlanState.mode = "create";
    dispatchPlanState.editingPlan = null;
    dispatchPlanState.stops = [];
    const idInput = dispatchPlanElement("dispatchPlanEditingId");
    if (idInput) idInput.value = "";
    const revision = dispatchPlanElement("dispatchPlanFormRevision");
    if (revision) {
      revision.textContent = "";
      revision.classList.add("hidden");
    }
    dispatchPlanSetFeedback("dispatchPlanFormFeedback");
    dispatchPlanSetFeedback("dispatchPlanTruckGuidance");
    dispatchPlanSetFeedback("dispatchPlanEnforcerGuidance");
    dispatchPlanSetFeedback("dispatchPlanDestinationGuidance");
  }

  function dispatchPlanSetFormValue(id, value) {
    const input = dispatchPlanElement(id);
    if (input) input.value = value ?? "";
  }

  async function openCreateDispatchPlan(event) {
    dispatchPlanResetForm();
    const today = dispatchPlanTodayInManila();
    const tomorrow = dispatchPlanTomorrowInManila();
    const dateInput = dispatchPlanElement("dispatchPlanOperationalDate");
    if (dateInput) {
      dateInput.min = today;
      dateInput.value = tomorrow;
    }
    const title = dispatchPlanElement("dispatchPlanFormTitle");
    if (title) title.textContent = "Create Dispatch Plan";
    const subtitle = dispatchPlanElement("dispatchPlanFormSubtitle");
    if (subtitle) subtitle.textContent = "Select the operational date, assigned team, and ordered destinations.";
    renderPlanStops();
    dispatchPlanOpenModal("dispatchPlanFormModal", event?.currentTarget || null);
    await Promise.all([
      loadDispatchPlanOptions(tomorrow),
      loadDispatchPlanDestinations()
    ]);
    dispatchPlanRenderReview();
  }

  async function openDispatchPlanDetail(planId, returnFocus = null) {
    const body = dispatchPlanElement("dispatchPlanDetailBody");
    if (body) body.innerHTML = '<div class="dispatch-plans-table-state">Loading dispatch plan...</div>';
    dispatchPlanOpenModal("dispatchPlanDetailModal", returnFocus);
    try {
      const plan = await dispatchPlanRequest(globalScope.getDispatchPlanApiUrl(planId));
      if (body) body.innerHTML = dispatchPlanDetailHtml(plan);
      return plan;
    } catch (error) {
      if (body) {
        body.innerHTML = `<div class="dispatch-plan-feedback error">${dispatchPlanEscape(dispatchPlanErrorMessage(error))}</div>`;
      }
      return null;
    }
  }

  async function openEditDispatchPlan(planId, returnFocus = null) {
    try {
      const plan = await dispatchPlanRequest(globalScope.getDispatchPlanApiUrl(planId));
      if (String(plan.status).toLowerCase() !== "planned") {
        dispatchPlanNotify("Only a Planned dispatch plan can be edited.", "error");
        await loadDispatchPlans();
        return null;
      }
      dispatchPlanResetForm();
      dispatchPlanState.mode = "edit";
      dispatchPlanState.editingPlan = plan;
      dispatchPlanState.stops = dispatchPlanRenumberStops(
        [...(plan.stops || [])]
          .sort((left, right) => Number(left.stop_order) - Number(right.stop_order))
          .map((stop) => ({
            destination_id: stop.destination_id,
            display_label: stop.location_name_snapshot,
            barangay: stop.address_reference_snapshot,
            expected_arrival: dispatchPlanToInputDateTime(stop.expected_arrival)
          }))
      );
      dispatchPlanSetFormValue("dispatchPlanEditingId", plan.id);
      dispatchPlanSetFormValue("dispatchPlanOperationalDate", plan.operational_date);
      const dateInput = dispatchPlanElement("dispatchPlanOperationalDate");
      if (dateInput) dateInput.min = dispatchPlanTodayInManila();
      dispatchPlanSetFormValue("dispatchPlanRouteName", plan.route_name);
      dispatchPlanSetFormValue("dispatchPlanDescription", plan.description);
      dispatchPlanSetFormValue("dispatchPlanScheduledStart", dispatchPlanToInputDateTime(plan.scheduled_start));
      dispatchPlanSetFormValue("dispatchPlanExpectedReturn", dispatchPlanToInputDateTime(plan.expected_return));
      dispatchPlanSetFormValue("dispatchPlanNotes", plan.notes);
      const title = dispatchPlanElement("dispatchPlanFormTitle");
      if (title) title.textContent = "Edit Dispatch Plan";
      const subtitle = dispatchPlanElement("dispatchPlanFormSubtitle");
      if (subtitle) subtitle.textContent = "Only Planned assignments can be changed.";
      const revision = dispatchPlanElement("dispatchPlanFormRevision");
      if (revision) {
        revision.textContent = `Current server revision: ${Number(plan.revision || 1)}`;
        revision.classList.remove("hidden");
      }
      renderPlanStops();
      dispatchPlanOpenModal("dispatchPlanFormModal", returnFocus);
      await Promise.all([
        loadDispatchPlanOptions(plan.operational_date, {
          truckId: plan.fleet_truck_id,
          enforcerId: plan.assigned_enforcer_user_id
        }),
        loadDispatchPlanDestinations()
      ]);
      dispatchPlanSetFormValue("dispatchPlanFleetTruck", plan.fleet_truck_id);
      dispatchPlanSetFormValue("dispatchPlanEnforcer", plan.assigned_enforcer_user_id);
      dispatchPlanRenderReview();
      return plan;
    } catch (error) {
      dispatchPlanNotify(dispatchPlanErrorMessage(error), "error");
      await loadDispatchPlans();
      return null;
    }
  }

  async function submitDispatchPlan(event) {
    event?.preventDefault?.();
    if (dispatchPlanState.submitting) return;
    const payload = dispatchPlanBuildPayload(dispatchPlanFormValues(), dispatchPlanState.stops);
    const validation = dispatchPlanValidatePayload(payload);
    if (!validation.valid) {
      dispatchPlanSetFeedback("dispatchPlanFormFeedback", validation.message, "error");
      dispatchPlanUpdateSaveState();
      return;
    }
    const editingId = dispatchPlanPositiveId(dispatchPlanElement("dispatchPlanEditingId")?.value);
    const method = editingId ? "PATCH" : "POST";
    const url = editingId
      ? globalScope.getDispatchPlanApiUrl(editingId)
      : globalScope.getDispatchPlansApiUrl();
    dispatchPlanSetFormValue("dispatchPlansDateFilter", payload.operational_date);
    dispatchPlanState.submitting = true;
    dispatchPlanSetFeedback("dispatchPlanFormFeedback");
    dispatchPlanUpdateSaveState();
    try {
      await dispatchPlanRunMutation({
        request: dispatchPlanRequest,
        url,
        method,
        payload,
        refreshPlans: loadDispatchPlans,
        refreshOptions: () => loadDispatchPlanOptions(payload.operational_date)
      });
      dispatchPlanCloseModal("dispatchPlanFormModal");
      dispatchPlanResetForm();
      dispatchPlanNotify(editingId ? "Dispatch plan updated successfully." : "Dispatch plan created successfully.");
    } catch (error) {
      const message = dispatchPlanErrorMessage(error);
      let latest = null;
      if (editingId && Number(error.status) === 409) {
        try {
          latest = await dispatchPlanRequest(globalScope.getDispatchPlanApiUrl(editingId));
          dispatchPlanState.editingPlan = latest;
          const revision = dispatchPlanElement("dispatchPlanFormRevision");
          if (revision) {
            revision.textContent = `Latest server revision: ${Number(latest.revision || 1)}`;
            revision.classList.remove("hidden");
          }
        } catch (reloadError) {
          latest = null;
        }
      }
      if (latest && String(latest.status).toLowerCase() !== "planned") {
        dispatchPlanCloseModal("dispatchPlanFormModal");
        const body = dispatchPlanElement("dispatchPlanDetailBody");
        if (body) body.innerHTML = dispatchPlanDetailHtml(latest);
        dispatchPlanOpenModal("dispatchPlanDetailModal");
        dispatchPlanNotify(message, "error");
      } else {
        dispatchPlanSetFeedback("dispatchPlanFormFeedback", message, "error");
      }
    } finally {
      dispatchPlanState.submitting = false;
      dispatchPlanUpdateSaveState();
    }
  }

  function openCancelDispatchPlan(plan, returnFocus = null) {
    if (String(plan?.status || "").toLowerCase() !== "planned") {
      dispatchPlanNotify("Only a Planned dispatch plan can be cancelled.", "error");
      return false;
    }
    dispatchPlanState.cancellingPlan = plan;
    dispatchPlanSetFormValue("dispatchPlanCancelId", plan.id);
    dispatchPlanSetFormValue("dispatchPlanCancellationReason", "");
    dispatchPlanSetFeedback("dispatchPlanCancelFeedback");
    dispatchPlanOpenModal("dispatchPlanCancelModal", returnFocus);
    return true;
  }

  async function cancelDispatchPlan(event) {
    event?.preventDefault?.();
    if (dispatchPlanState.submitting) return;
    const id = dispatchPlanPositiveId(dispatchPlanElement("dispatchPlanCancelId")?.value);
    const reason = dispatchPlanValidateCancellation(
      dispatchPlanElement("dispatchPlanCancellationReason")?.value
    );
    if (!id || !reason.valid) {
      dispatchPlanSetFeedback(
        "dispatchPlanCancelFeedback",
        reason.message || "Choose a valid dispatch plan.",
        "error"
      );
      return;
    }
    const date = dispatchPlanState.cancellingPlan?.operational_date || dispatchPlanFilters().operational_date;
    dispatchPlanState.submitting = true;
    const button = dispatchPlanElement("dispatchPlanCancelConfirmBtn");
    if (button) {
      button.disabled = true;
      button.textContent = "Cancelling...";
    }
    try {
      await dispatchPlanRunMutation({
        request: dispatchPlanRequest,
        url: globalScope.getDispatchPlanCancelApiUrl(id),
        method: "POST",
        payload: { cancellation_reason: reason.value },
        refreshPlans: loadDispatchPlans,
        refreshOptions: () => loadDispatchPlanOptions(date)
      });
      dispatchPlanCloseModal("dispatchPlanCancelModal");
      dispatchPlanState.cancellingPlan = null;
      dispatchPlanNotify("Dispatch plan cancelled successfully.");
    } catch (error) {
      const message = dispatchPlanErrorMessage(error);
      if (Number(error.status) === 409) {
        let latest = null;
        try {
          latest = await dispatchPlanRequest(globalScope.getDispatchPlanApiUrl(id));
        } catch (reloadError) {
          latest = null;
        }
        if (latest) {
          dispatchPlanCloseModal("dispatchPlanCancelModal");
          const body = dispatchPlanElement("dispatchPlanDetailBody");
          if (body) body.innerHTML = dispatchPlanDetailHtml(latest);
          dispatchPlanOpenModal("dispatchPlanDetailModal");
          dispatchPlanNotify(message, "error");
        } else {
          dispatchPlanSetFeedback("dispatchPlanCancelFeedback", message, "error");
        }
      } else {
        dispatchPlanSetFeedback("dispatchPlanCancelFeedback", message, "error");
      }
    } finally {
      dispatchPlanState.submitting = false;
      if (button) {
        button.disabled = false;
        button.textContent = "Cancel Plan";
      }
    }
  }

  async function dispatchPlanHandleTableAction(event) {
    const button = event.target.closest("[data-dispatch-plan-action]");
    if (!button) return;
    const id = dispatchPlanPositiveId(button.dataset.planId);
    if (!id) return;
    const action = button.dataset.dispatchPlanAction;
    if (action === "view") {
      await openDispatchPlanDetail(id, button);
      return;
    }
    if (action === "edit") {
      await openEditDispatchPlan(id, button);
      return;
    }
    if (action === "cancel") {
      const summary = dispatchPlanState.plans.find((plan) => Number(plan.id) === id);
      if (summary) openCancelDispatchPlan(summary, button);
    }
  }

  function dispatchPlanHandleStopClick(event) {
    const row = event.target.closest("[data-plan-stop-index]");
    if (!row) return;
    const index = Number(row.dataset.planStopIndex);
    const moveButton = event.target.closest("[data-plan-stop-move]");
    if (moveButton) {
      movePlanStop(index, moveButton.dataset.planStopMove);
      return;
    }
    if (event.target.closest("[data-plan-stop-remove]")) removePlanStop(index);
  }

  function dispatchPlanHandleStopInput(event) {
    const input = event.target.closest("[data-plan-stop-arrival]");
    const row = event.target.closest("[data-plan-stop-index]");
    if (!input || !row) return;
    const index = Number(row.dataset.planStopIndex);
    if (!dispatchPlanState.stops[index]) return;
    dispatchPlanState.stops[index].expected_arrival = input.value;
    dispatchPlanRenderReview();
  }

  function dispatchPlanMountModals() {
    DISPATCH_PLAN_CHILD_MODAL_IDS.forEach((id) => {
        const modal = dispatchPlanElement(id);
        if (modal && modal.parentElement !== document.body) document.body.appendChild(modal);
      });
  }

  function dispatchPlanBindActions(workspace) {
    dispatchPlanElement("openDispatchPlanningBtn")?.addEventListener("click", openDispatchPlanningParentModal);
    ["dispatchPlanningParentOverlay", "dispatchPlanningParentCloseBtn"].forEach((id) => {
      dispatchPlanElement(id)?.addEventListener("click", closeDispatchPlanningParentModal);
    });
    dispatchPlanElement("dispatchPlanCreateBtn")?.addEventListener("click", openCreateDispatchPlan);
    dispatchPlanElement("dispatchPlansRefreshBtn")?.addEventListener("click", loadDispatchPlans);
    dispatchPlanElement("dispatchPlansDateFilter")?.addEventListener("change", loadDispatchPlans);
    dispatchPlanElement("dispatchPlansStatusFilter")?.addEventListener("change", loadDispatchPlans);
    dispatchPlanElement("dispatchPlansTableBody")?.addEventListener("click", dispatchPlanHandleTableAction);
    dispatchPlanElement("dispatchPlanForm")?.addEventListener("submit", submitDispatchPlan);
    dispatchPlanElement("dispatchPlanCancelForm")?.addEventListener("submit", cancelDispatchPlan);
    dispatchPlanElement("dispatchPlanOperationalDate")?.addEventListener("change", (event) => {
      const validation = dispatchPlanValidateOperationalDate(event.target.value);
      if (!validation.valid) {
        dispatchPlanSetFeedback("dispatchPlanFormFeedback", validation.message, "error");
        dispatchPlanState.options = { fleet_trucks: [], enforcers: [] };
        dispatchPlanRenderOptions();
        return;
      }
      dispatchPlanSetFeedback("dispatchPlanFormFeedback");
      void loadDispatchPlanOptions(event.target.value);
      dispatchPlanRenderReview();
    });
    ["dispatchPlanFleetTruck", "dispatchPlanEnforcer"].forEach((id) => {
      dispatchPlanElement(id)?.addEventListener("change", dispatchPlanRenderReview);
    });
    dispatchPlanElement("dispatchPlanAddDestinationBtn")?.addEventListener("click", () => {
      addPlanStop(dispatchPlanElement("dispatchPlanDestinationSelect")?.value);
    });
    dispatchPlanElement("dispatchPlanStops")?.addEventListener("click", dispatchPlanHandleStopClick);
    dispatchPlanElement("dispatchPlanStops")?.addEventListener("input", dispatchPlanHandleStopInput);
    [
      ["dispatchPlanFormOverlay", "dispatchPlanFormModal"],
      ["dispatchPlanFormCloseBtn", "dispatchPlanFormModal"],
      ["dispatchPlanFormCancelBtn", "dispatchPlanFormModal"],
      ["dispatchPlanDetailOverlay", "dispatchPlanDetailModal"],
      ["dispatchPlanDetailCloseBtn", "dispatchPlanDetailModal"],
      ["dispatchPlanCancelOverlay", "dispatchPlanCancelModal"],
      ["dispatchPlanCancelCloseBtn", "dispatchPlanCancelModal"],
      ["dispatchPlanCancelBackBtn", "dispatchPlanCancelModal"]
    ].forEach(([controlId, modalId]) => {
      dispatchPlanElement(controlId)?.addEventListener("click", () => dispatchPlanCloseModal(modalId));
    });
    dispatchPlanElement("dispatchPlanForm")?.addEventListener("input", dispatchPlanRenderReview);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const openModal = document.querySelector(".dispatch-plan-modal:not(.hidden)");
      if (openModal) {
        dispatchPlanCloseModal(openModal.id);
      } else if (dispatchPlanModalIsOpen("dispatchPlanningModal")) {
        closeDispatchPlanningParentModal();
      }
    });
  }

  async function setupDispatchPlansModule() {
    const workspace = dispatchPlanElement("dispatchPlansWorkspace");
    if (!workspace || workspace.dataset.bound === "true") return;
    const hasAccess = dispatchPlanUserHasAccess(dispatchPlanCurrentUser());
    dispatchPlanSetTriggerAccess(hasAccess);
    if (!hasAccess) {
      workspace.hidden = true;
      workspace.setAttribute("aria-hidden", "true");
      return;
    }
    workspace.dataset.bound = "true";
    workspace.hidden = false;
    workspace.removeAttribute("aria-hidden");
    dispatchPlanMountModals();
    dispatchPlanBindActions(workspace);
    const tomorrow = dispatchPlanTomorrowInManila();
    dispatchPlanSetFormValue("dispatchPlansDateFilter", tomorrow);
    await loadDispatchPlans();
  }

  const exported = {
    MANILA_TIME_ZONE,
    dispatchPlanState,
    dispatchPlanCalendarDate,
    dispatchPlanTodayInManila,
    dispatchPlanTomorrowInManila,
    dispatchPlanValidateOperationalDate,
    dispatchPlanUserHasAccess,
    dispatchPlanStatusLabel,
    dispatchPlanViewPermissions,
    dispatchPlanTruckOptionsHtml,
    dispatchPlanEnforcerOptionsHtml,
    dispatchPlanDestinationOptionsHtml,
    dispatchPlanAddStopToList,
    dispatchPlanRemoveStopFromList,
    dispatchPlanMoveStopInList,
    dispatchPlanBuildPayload,
    dispatchPlanValidatePayload,
    dispatchPlanValidateCancellation,
    dispatchPlanErrorMessage,
    dispatchPlanRunMutation,
    dispatchPlanRowsHtml,
    dispatchPlanDetailHtml,
    loadDispatchPlans,
    loadDispatchPlanOptions,
    renderDispatchPlans,
    openCreateDispatchPlan,
    openDispatchPlanDetail,
    openEditDispatchPlan,
    submitDispatchPlan,
    openCancelDispatchPlan,
    cancelDispatchPlan,
    addPlanStop,
    removePlanStop,
    movePlanStop,
    renderPlanStops,
    setupDispatchPlansModule,
    openDispatchPlanningParentModal,
    closeDispatchPlanningParentModal,
    closeDispatchPlanningModalsForNavigation
  };

  Object.assign(globalScope, exported);
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
})(typeof window !== "undefined" ? window : globalThis);
