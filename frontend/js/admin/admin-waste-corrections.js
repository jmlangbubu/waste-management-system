// Waste correction controls are presentation-only. Every API action is guarded
// by the authenticated web session, server capability, and (for writes) CSRF.
const WASTE_CORRECTION_FIELDS = Object.freeze([
  ["biodegradable_subtotal", "Biodegradable"],
  ["recyclable_subtotal", "Recyclable"],
  ["residual_subtotal", "Residual"],
  ["special_subtotal", "Special Waste"]
]);
let activeWasteCorrectionRecord = null;
let selectedWasteCorrectionReview = null;
let selectedWasteCorrectionDecision = null;
let activeWasteCorrectionRequest = null;

function canUseWasteCorrection(action) {
  return hasWebCapability(currentUser, `waste.correction.${action}`);
}

function correctionEscape(value) {
  return escapeHtml(value === null || value === undefined ? "" : String(value));
}

function correctionAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

function correctionDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-PH");
}

async function wasteCorrectionApi(path, options = {}) {
  const response = await webAdminFetch(`${getWasteApiBase()}/waste/web${path}`, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : options.headers
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || `Correction request failed (${response.status}).`);
  return result.data;
}

function correctionComparison(original, proposed) {
  return `<div class="waste-correction-comparison">
    <strong>Field</strong><strong>Original</strong><strong>Proposed</strong>
    ${WASTE_CORRECTION_FIELDS.map(([key, label]) => `
      <span>${correctionEscape(label)}</span>
      <span>${correctionEscape(correctionAmount(original?.[key]))} kg</span>
      <span class="${correctionAmount(original?.[key]) !== correctionAmount(proposed?.[key]) ? "changed" : ""}">${correctionEscape(correctionAmount(proposed?.[key]))} kg</span>
    `).join("")}
    <strong>Grand Total</strong>
    <strong>${correctionEscape(correctionAmount(original?.grand_total))} kg</strong>
    <strong>${correctionEscape(correctionAmount(proposed?.grand_total))} kg</strong>
  </div>`;
}

function setWasteCorrectionError(id, error) {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = error ? error.message || String(error) : "";
  element.hidden = !error;
}

function closeWasteCorrectionModal(id) {
  document.getElementById(id)?.classList.add("hidden");
}

function renderWasteCorrectionPanel(record, data) {
  const panel = document.getElementById("wasteCorrectionPanel");
  if (!panel || !canUseWasteCorrection("view")) return;
  const active = data.requests.find((request) => ["pending", "approved"].includes(request.status));
  activeWasteCorrectionRequest = active || null;
  const canRequest = canUseWasteCorrection("request") && !active;
  const canApply = canUseWasteCorrection("apply") && active?.status === "approved";
  const canCancel = canUseWasteCorrection("request") && active &&
    (currentUser.role === "super_admin" || Number(currentUser.id) === Number(active.requested_by_user_id));
  const latestStatus = data.requests[0]?.status;
  panel.innerHTML = `
    <div class="waste-correction-panel-header"><h3>Validated Record Corrections</h3>
      <span class="waste-correction-muted">Record #${correctionEscape(record.id)}</span></div>
    <p>${active ? `Status: <strong>${correctionEscape(active.status === "pending" ? "Correction Pending Review" : "Approved Correction")}</strong>` : latestStatus === "cancelled" ? "Status: <strong>Cancelled</strong>. A new correction may be requested." : "No active correction request."}</p>
    ${active?.status === "approved" ? `<p>Exact Supervisor-approved values (read-only):</p>${correctionComparison(active.original_values, active.proposed_values)}` : ""}
    <div class="waste-correction-actions">
      ${canRequest ? '<button type="button" data-waste-correction-action="request">Request Correction</button>' : ""}
      ${canApply ? `<button type="button" data-waste-correction-action="apply" data-request-id="${correctionEscape(active.id)}">Apply Approved Correction</button>` : ""}
      ${canCancel ? `<button type="button" data-waste-correction-action="cancel" data-request-id="${correctionEscape(active.id)}">Cancel Correction</button>` : ""}
      <button type="button" data-waste-correction-action="history">Correction History</button>
    </div>
    <p id="wasteCorrectionPanelError" class="waste-correction-error" role="alert" hidden></p>`;
  panel.hidden = false;
}

async function showWasteCorrectionPanel(record) {
  const panel = document.getElementById("wasteCorrectionPanel");
  if (!panel || !canUseWasteCorrection("view") || !record?.id) return;
  activeWasteCorrectionRecord = record;
  panel.hidden = false;
  panel.textContent = "Loading correction status…";
  try {
    const data = await wasteCorrectionApi(`/validated-records/${encodeURIComponent(record.id)}/correction-history`);
    if (activeWasteCorrectionRecord?.id === record.id) renderWasteCorrectionPanel(record, data);
  } catch (error) {
    if (activeWasteCorrectionRecord?.id === record.id) {
      panel.textContent = `Correction status unavailable: ${error.message}`;
    }
  }
}

function openWasteCorrectionRequest() {
  if (!canUseWasteCorrection("request") || !activeWasteCorrectionRecord) return;
  const record = activeWasteCorrectionRecord;
  document.getElementById("wasteCorrectionOriginalValues").innerHTML =
    `<strong>Current official values for record #${correctionEscape(record.id)}</strong><p>Grand Total: ${correctionEscape(correctionAmount(record.grand_total))} kg</p>`;
  document.getElementById("wasteCorrectionInputs").innerHTML = WASTE_CORRECTION_FIELDS.map(([key, label]) => `
    <label>${correctionEscape(label)} (kg)
      <input type="number" name="${key}" min="0" max="9999999999.99" step="0.01"
        value="${correctionEscape(correctionAmount(record[key]))}" required>
    </label>`).join("");
  document.getElementById("wasteCorrectionReason").value = "";
  setWasteCorrectionError("wasteCorrectionRequestError", null);
  document.getElementById("wasteCorrectionRequestModal").classList.remove("hidden");
}

async function submitWasteCorrectionRequest(event) {
  event.preventDefault();
  if (!canUseWasteCorrection("request") || !activeWasteCorrectionRecord) return;
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const proposedChanges = Object.fromEntries(WASTE_CORRECTION_FIELDS.map(([field]) => [
    field, form.elements.namedItem(field).value
  ]));
  const reason = document.getElementById("wasteCorrectionReason").value.trim();
  setWasteCorrectionError("wasteCorrectionRequestError", null);
  submit.disabled = true;
  try {
    await wasteCorrectionApi(`/validated-records/${encodeURIComponent(activeWasteCorrectionRecord.id)}/correction-requests`, {
      method: "POST",
      body: JSON.stringify({ reason, proposedChanges })
    });
    closeWasteCorrectionModal("wasteCorrectionRequestModal");
    await showWasteCorrectionPanel(activeWasteCorrectionRecord);
    if (!document.getElementById("wasteCorrectionQueuePanel").hidden) await loadWasteCorrectionQueue();
  } catch (error) {
    setWasteCorrectionError("wasteCorrectionRequestError", error);
  } finally {
    submit.disabled = false;
  }
}

function renderWasteCorrectionQueue(requests) {
  const content = document.getElementById("wasteCorrectionQueueContent");
  if (!content) return;
  if (!requests.length) {
    content.textContent = "No correction requests yet.";
    return;
  }
  content.innerHTML = requests.map((request) => `
    <article class="waste-correction-card">
      <strong>Record #${correctionEscape(request.waste_record_id)} — ${correctionEscape(request.barangay_name || request.establishment_name || "Unknown source")}</strong>
      <p>Status: ${correctionEscape(request.status)} · Requested by ${correctionEscape(request.requested_by_name || `User #${request.requested_by_user_id}`)} on ${correctionEscape(correctionDate(request.created_at))}</p>
      <p>Reason: ${correctionEscape(request.reason)}</p>
      ${correctionComparison(request.original_values, request.proposed_values)}
      ${canUseWasteCorrection("review") && request.status === "pending" ? `
        <div class="waste-correction-actions">
          <button type="button" data-review-request-id="${correctionEscape(request.id)}" data-review-decision="approve">Approve</button>
          <button type="button" data-review-request-id="${correctionEscape(request.id)}" data-review-decision="reject">Reject</button>
        </div>` : ""}
    </article>`).join("");
}

async function loadWasteCorrectionQueue() {
  if (!canUseWasteCorrection("view")) return;
  const content = document.getElementById("wasteCorrectionQueueContent");
  content.textContent = "Loading correction requests…";
  try {
    const requests = await wasteCorrectionApi("/correction-requests");
    window.__wasteCorrectionQueue = requests;
    renderWasteCorrectionQueue(requests);
  } catch (error) {
    content.textContent = `Correction requests unavailable: ${error.message}`;
  }
}

function openWasteCorrectionReview(requestId, decision) {
  if (!canUseWasteCorrection("review")) return;
  const request = (window.__wasteCorrectionQueue || []).find((item) => Number(item.id) === Number(requestId));
  if (!request || request.status !== "pending") return;
  selectedWasteCorrectionReview = request;
  selectedWasteCorrectionDecision = decision;
  document.getElementById("wasteCorrectionReviewTitle").textContent =
    decision === "reject" ? "Reject Correction" : "Approve Correction";
  document.getElementById("wasteCorrectionReviewComparison").innerHTML = `
    <p>Record #${correctionEscape(request.waste_record_id)} · Reason: ${correctionEscape(request.reason)}</p>
    ${correctionComparison(request.original_values, request.proposed_values)}`;
  const reason = document.getElementById("wasteCorrectionDecisionReason");
  reason.value = "";
  reason.required = decision === "reject";
  document.getElementById("wasteCorrectionDecisionRequired").textContent =
    decision === "reject" ? "(required for rejection)" : "(optional)";
  setWasteCorrectionError("wasteCorrectionReviewError", null);
  document.getElementById("wasteCorrectionReviewModal").classList.remove("hidden");
}

async function submitWasteCorrectionReview(event) {
  event.preventDefault();
  if (!canUseWasteCorrection("review") || !selectedWasteCorrectionReview) return;
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  setWasteCorrectionError("wasteCorrectionReviewError", null);
  try {
    await wasteCorrectionApi(`/correction-requests/${encodeURIComponent(selectedWasteCorrectionReview.id)}/review`, {
      method: "PATCH",
      body: JSON.stringify({
        decision: selectedWasteCorrectionDecision,
        decisionReason: document.getElementById("wasteCorrectionDecisionReason").value.trim()
      })
    });
    closeWasteCorrectionModal("wasteCorrectionReviewModal");
    await loadWasteCorrectionQueue();
    if (activeWasteCorrectionRecord) await showWasteCorrectionPanel(activeWasteCorrectionRecord);
  } catch (error) {
    setWasteCorrectionError("wasteCorrectionReviewError", error);
  } finally {
    submit.disabled = false;
  }
}

async function applyApprovedWasteCorrection(requestId, button) {
  if (!canUseWasteCorrection("apply") || !activeWasteCorrectionRecord) return;
  if (!window.confirm("Apply exactly the Supervisor-approved values to this validated record?")) return;
  button.disabled = true;
  setWasteCorrectionError("wasteCorrectionPanelError", null);
  try {
    // No replacement values are sent. The server loads the stored approved payload.
    await wasteCorrectionApi(`/correction-requests/${encodeURIComponent(requestId)}/apply`, { method: "POST" });
    closeValidationDetailsModal();
    activeWasteCorrectionRecord = null;
    await loadRecords();
    if (!document.getElementById("wasteCorrectionQueuePanel").hidden) await loadWasteCorrectionQueue();
  } catch (error) {
    setWasteCorrectionError("wasteCorrectionPanelError", error);
  } finally {
    button.disabled = false;
  }
}

function openWasteCorrectionCancel(requestId) {
  const request = activeWasteCorrectionRequest;
  if (!request || Number(request.id) !== Number(requestId) ||
      !["pending", "approved"].includes(request.status) ||
      !canUseWasteCorrection("request") ||
      (currentUser.role !== "super_admin" && Number(currentUser.id) !== Number(request.requested_by_user_id))) return;
  document.getElementById("wasteCorrectionCancelSummary").textContent =
    `Cancel ${request.status} request #${request.id}? No official record values will change.`;
  document.getElementById("wasteCorrectionCancelReason").value = "";
  setWasteCorrectionError("wasteCorrectionCancelError", null);
  document.getElementById("wasteCorrectionCancelModal").classList.remove("hidden");
}

async function submitWasteCorrectionCancel(event) {
  event.preventDefault();
  const request = activeWasteCorrectionRequest;
  if (!request || !canUseWasteCorrection("request")) return;
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  setWasteCorrectionError("wasteCorrectionCancelError", null);
  try {
    await wasteCorrectionApi(`/correction-requests/${encodeURIComponent(request.id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: document.getElementById("wasteCorrectionCancelReason").value.trim() })
    });
    closeWasteCorrectionModal("wasteCorrectionCancelModal");
    if (activeWasteCorrectionRecord) await showWasteCorrectionPanel(activeWasteCorrectionRecord);
    if (!document.getElementById("wasteCorrectionQueuePanel").hidden) await loadWasteCorrectionQueue();
  } catch (error) {
    setWasteCorrectionError("wasteCorrectionCancelError", error);
  } finally {
    submit.disabled = false;
  }
}

async function openWasteCorrectionHistory() {
  if (!canUseWasteCorrection("view") || !activeWasteCorrectionRecord) return;
  const recordId = activeWasteCorrectionRecord.id;
  const content = document.getElementById("wasteCorrectionHistoryContent");
  content.textContent = "Loading correction history…";
  document.getElementById("wasteCorrectionHistoryModal").classList.remove("hidden");
  try {
    const { requests, audit } = await wasteCorrectionApi(`/validated-records/${encodeURIComponent(recordId)}/correction-history`);
    content.innerHTML = `
      <h4>Requests</h4>
      ${requests.length ? requests.map((request) => `
        <article class="waste-correction-card"><strong>${correctionEscape(request.status)}</strong>
          <p>Requested by ${correctionEscape(request.requested_by_name || `User #${request.requested_by_user_id}`)} on ${correctionEscape(correctionDate(request.created_at))}</p>
          <p>Reason: ${correctionEscape(request.reason)}</p>
          ${request.reviewed_at ? `<p>Reviewed by ${correctionEscape(request.reviewed_by_name || `User #${request.reviewed_by_user_id}`)} on ${correctionEscape(correctionDate(request.reviewed_at))}</p>` : ""}
          ${request.decision_reason ? `<p>Decision reason: ${correctionEscape(request.decision_reason)}</p>` : ""}
          ${request.cancelled_at ? `<p>Cancelled by ${correctionEscape(request.cancelled_by_name || `User #${request.cancelled_by_user_id}`)} on ${correctionEscape(correctionDate(request.cancelled_at))}</p>
            <p>Cancellation reason: ${correctionEscape(request.cancel_reason)}</p>` : ""}
          ${request.applied_at ? `<p>Applied by ${correctionEscape(request.applied_by_name || `User #${request.applied_by_user_id}`)} on ${correctionEscape(correctionDate(request.applied_at))}</p>` : ""}
          ${correctionComparison(request.original_values, request.proposed_values)}
        </article>`).join("") : "<p>No requests yet.</p>"}
      <h4>Applied audit history</h4>
      ${audit.length ? audit.map((item) => `
        <article class="waste-correction-card"><strong>Applied ${correctionEscape(correctionDate(item.created_at))}</strong>
          <p>Reason: ${correctionEscape(item.reason)}</p>
          <p>Requested by ${correctionEscape(item.requested_by_name || `User #${item.requested_by_user_id}`)} ·
          Approved by ${correctionEscape(item.approved_by_name || `User #${item.approved_by_user_id}`)} ·
          Applied by ${correctionEscape(item.applied_by_name || `User #${item.applied_by_user_id}`)}</p>
          ${correctionComparison(item.old_values, item.new_values)}
        </article>`).join("") : "<p>No applied corrections yet.</p>"}`;
  } catch (error) {
    content.textContent = `Correction history unavailable: ${error.message}`;
  }
}

function setupWasteCorrectionUi() {
  const queueButton = document.getElementById("wasteCorrectionQueueBtn");
  const queuePanel = document.getElementById("wasteCorrectionQueuePanel");
  if (!queueButton || !queuePanel) return;
  queueButton.hidden = !canUseWasteCorrection("view");
  if (!canUseWasteCorrection("view")) return;

  queueButton.addEventListener("click", () => {
    queuePanel.hidden = !queuePanel.hidden;
    if (!queuePanel.hidden) loadWasteCorrectionQueue();
  });
  document.getElementById("closeWasteCorrectionQueueBtn")?.addEventListener("click", () => { queuePanel.hidden = true; });
  document.getElementById("wasteCorrectionQueueContent")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-review-request-id]");
    if (button) openWasteCorrectionReview(button.dataset.reviewRequestId, button.dataset.reviewDecision);
  });
  document.getElementById("wasteCorrectionPanel")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-waste-correction-action]");
    if (!button) return;
    if (button.dataset.wasteCorrectionAction === "request") openWasteCorrectionRequest();
    if (button.dataset.wasteCorrectionAction === "history") openWasteCorrectionHistory();
    if (button.dataset.wasteCorrectionAction === "apply") applyApprovedWasteCorrection(button.dataset.requestId, button);
    if (button.dataset.wasteCorrectionAction === "cancel") openWasteCorrectionCancel(button.dataset.requestId);
  });
  document.getElementById("wasteCorrectionRequestForm")?.addEventListener("submit", submitWasteCorrectionRequest);
  document.getElementById("wasteCorrectionReviewForm")?.addEventListener("submit", submitWasteCorrectionReview);
  document.getElementById("wasteCorrectionCancelForm")?.addEventListener("submit", submitWasteCorrectionCancel);
  for (const [buttonId, overlayId, modalId] of [
    ["closeWasteCorrectionRequestBtn", "wasteCorrectionRequestOverlay", "wasteCorrectionRequestModal"],
    ["closeWasteCorrectionReviewBtn", "wasteCorrectionReviewOverlay", "wasteCorrectionReviewModal"],
    ["closeWasteCorrectionCancelBtn", "wasteCorrectionCancelOverlay", "wasteCorrectionCancelModal"],
    ["closeWasteCorrectionHistoryBtn", "wasteCorrectionHistoryOverlay", "wasteCorrectionHistoryModal"]
  ]) {
    document.getElementById(buttonId)?.addEventListener("click", () => closeWasteCorrectionModal(modalId));
    document.getElementById(overlayId)?.addEventListener("click", () => closeWasteCorrectionModal(modalId));
  }
}
