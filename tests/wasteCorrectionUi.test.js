const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { getWebCapabilities } = require("../config/webRoleCapabilities");

const source = fs.readFileSync(path.join(__dirname, "../frontend/js/admin/admin-waste-corrections.js"), "utf8");
const record = { id: 11, biodegradable_subtotal: "100.00", recyclable_subtotal: "120.00",
  residual_subtotal: "80.00", special_subtotal: "20.00", grand_total: "320.00" };
const approved = { id: 7, waste_record_id: 11, requested_by_user_id: 2,
  status: "approved", reason: "Weighing transcription",
  original_values: { ...record },
  proposed_values: { ...record, biodegradable_subtotal: "110.00", grand_total: "330.00" } };

function fixture(role) {
  const nodes = {
    wasteCorrectionPanel: { hidden: true, innerHTML: "" },
    wasteCorrectionQueueContent: { innerHTML: "", textContent: "" }
  };
  const context = {
    window: {}, document: { getElementById(id) { return nodes[id] || null; } },
    currentUser: { id: role === "super_admin" ? 1 : role === "clerk_admin" ? 2 : 4,
      role, capabilities: getWebCapabilities(role) },
    hasWebCapability(user, capability) { return user.capabilities.includes(capability); },
    escapeHtml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, nodes };
}

test("Clerk and Super Admin can request only when no active proposal exists", () => {
  for (const role of ["super_admin", "clerk_admin", "division_admin", "supervisor", "personnel"]) {
    const { context, nodes } = fixture(role);
    context.renderWasteCorrectionPanel(record, { requests: [], audit: [] });
    assert.equal(nodes.wasteCorrectionPanel.innerHTML.includes("Request Correction"),
      ["super_admin", "clerk_admin"].includes(role), role);
    assert.equal(nodes.wasteCorrectionPanel.hidden, role === "personnel", role);
    context.renderWasteCorrectionPanel(record, { requests: [{ ...approved, status: "pending" }], audit: [] });
    assert.equal(nodes.wasteCorrectionPanel.innerHTML.includes("Request Correction"), false, role);
  }
});

test("correction subtotal inputs use the DECIMAL(10,2) maximum", () => {
  assert.match(source, /<input type="number" name="\$\{key\}" min="0" max="99999999\.99" step="0\.01"/);
  assert.doesNotMatch(source, /max="9999999999\.99"/);
});

test("approved payload is read-only and only Clerk or Super Admin sees Apply", () => {
  for (const role of ["super_admin", "clerk_admin", "division_admin", "supervisor", "personnel"]) {
    const { context, nodes } = fixture(role);
    context.renderWasteCorrectionPanel(record, { requests: [approved], audit: [] });
    assert.equal(nodes.wasteCorrectionPanel.innerHTML.includes("Apply Approved Correction"),
      ["super_admin", "clerk_admin"].includes(role), role);
    assert.equal(nodes.wasteCorrectionPanel.innerHTML.includes("<input"), false, role);
    assert.equal(nodes.wasteCorrectionPanel.innerHTML.includes("Correction History"), role !== "personnel", role);
  }
});

test("pending review controls appear only for Supervisor and Super Admin", () => {
  for (const role of ["super_admin", "clerk_admin", "division_admin", "supervisor", "personnel"]) {
    const { context, nodes } = fixture(role);
    context.renderWasteCorrectionQueue([{ ...approved, status: "pending" }]);
    assert.equal(nodes.wasteCorrectionQueueContent.innerHTML.includes('data-review-decision="approve"'),
      ["super_admin", "supervisor"].includes(role), role);
    assert.equal(nodes.wasteCorrectionQueueContent.innerHTML.includes('data-review-decision="reject"'),
      ["super_admin", "supervisor"].includes(role), role);
  }
});

test("cancel control appears only for the original Clerk requester or Super Admin on active requests", () => {
  for (const status of ["pending", "approved"]) {
    for (const role of ["super_admin", "clerk_admin", "division_admin", "supervisor", "personnel"]) {
      const { context, nodes } = fixture(role);
      context.renderWasteCorrectionPanel(record, { requests: [{ ...approved, status }], audit: [] });
      assert.equal(nodes.wasteCorrectionPanel.innerHTML.includes("Cancel Correction"),
        ["super_admin", "clerk_admin"].includes(role), `${role}/${status}`);
    }
    const otherClerk = fixture("clerk_admin");
    otherClerk.context.currentUser.id = 22;
    otherClerk.context.renderWasteCorrectionPanel(record, { requests: [{ ...approved, status }], audit: [] });
    assert.equal(otherClerk.nodes.wasteCorrectionPanel.innerHTML.includes("Cancel Correction"), false);
  }
});

test("cancelled status is visible, allows a new request, and has no apply or cancel control", () => {
  const { context, nodes } = fixture("clerk_admin");
  context.renderWasteCorrectionPanel(record, { requests: [{ ...approved, status: "cancelled" }], audit: [] });
  assert.match(nodes.wasteCorrectionPanel.innerHTML, /Status: <strong>Cancelled<\/strong>/);
  assert.match(nodes.wasteCorrectionPanel.innerHTML, /Request Correction/);
  assert.doesNotMatch(nodes.wasteCorrectionPanel.innerHTML, /Apply Approved Correction|Cancel Correction/);
});

test("cancellation modal requires a reason and history renders cancellation metadata", () => {
  const html = fs.readFileSync(path.join(__dirname, "../frontend/admin-dashboard.html"), "utf8");
  assert.match(html, /id="wasteCorrectionCancelReason"[^>]*required/);
  assert.match(source, /Cancellation reason:.*request\.cancel_reason/);
  assert.match(source, /Cancelled by.*request\.cancelled_by_name/);
  assert.match(source, /\/cancel`, \{\s*method: "POST",\s*body: JSON\.stringify\(\{ reason:/);
});

test("UI uses webAdminFetch and sends no replacement values on apply", () => {
  assert.match(source, /webAdminFetch\(/);
  assert.match(source, /\/apply`, \{ method: "POST" \}/);
  assert.doesNotMatch(source, /Edit Validated Record/);
  const html = fs.readFileSync(path.join(__dirname, "../frontend/admin-dashboard.html"), "utf8");
  const recordsUi = fs.readFileSync(path.join(__dirname, "../frontend/js/admin/admin-waste-records.js"), "utf8");
  assert.match(recordsUi, /Original submitted detail; corrected official subtotals/);
  assert.match(recordsUi, /subtotalValue\.textContent = formatKg\(record\[`\$\{categoryKey\}_subtotal`\]\)/);
  for (const id of ["wasteCorrectionQueueBtn", "wasteCorrectionQueuePanel", "wasteCorrectionPanel",
    "wasteCorrectionRequestModal", "wasteCorrectionReviewModal", "wasteCorrectionCancelModal",
    "wasteCorrectionHistoryModal"]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, id);
  }
});

test("Correction Requests opens as a modal, closes cleanly, and reopens", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../frontend/admin-dashboard.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "../frontend/css/admin/admin-waste-corrections.css"), "utf8");
  assert.match(html, /id="wasteCorrectionQueuePanel" class="custom-modal waste-correction-queue-modal hidden"/);
  assert.match(html, /id="wasteCorrectionQueueOverlay" class="custom-modal-overlay"/);
  assert.match(html, /id="wasteCorrectionQueueContent" role="status">No correction requests yet\./);
  assert.ok(html.indexOf('id="wasteCorrectionQueuePanel"') > html.indexOf('id="validationDetailsModal"'));
  assert.match(html, /id="wasteCorrectionReviewModal"[^>]*data-modal-parent="wasteCorrectionQueuePanel"/);
  assert.match(css, /body:has\(#wasteCorrectionQueuePanel:not\(\.hidden\)\) \{ overflow: hidden; \}/);

  const handlers = {};
  const hiddenClasses = new Set(["hidden"]);
  const attributes = {};
  const button = { hidden: true, addEventListener(type, handler) { handlers.open = handler; } };
  const queue = {
    classList: {
      contains(name) { return hiddenClasses.has(name); },
      add(name) { hiddenClasses.add(name); },
      remove(name) { hiddenClasses.delete(name); }
    },
    setAttribute(name, value) { attributes[name] = value; }
  };
  const closeButton = { addEventListener(type, handler) { handlers.close = handler; } };
  const overlay = { addEventListener(type, handler) { handlers.backdrop = handler; } };
  const content = { textContent: "", addEventListener() {} };
  const nodes = {
    wasteCorrectionQueueBtn: button,
    wasteCorrectionQueuePanel: queue,
    closeWasteCorrectionQueueBtn: closeButton,
    wasteCorrectionQueueOverlay: overlay,
    wasteCorrectionQueueContent: content
  };
  const closedChildren = [];
  const context = {
    window: {}, document: { getElementById(id) { return nodes[id] || null; } },
    currentUser: { id: 1, role: "super_admin", capabilities: getWebCapabilities("super_admin") },
    hasWebCapability(user, capability) { return user.capabilities.includes(capability); },
    closeAdminStackedChildren(id) { closedChildren.push(id); },
    getWasteApiBase() { return "/api"; },
    async webAdminFetch() { return { ok: true, async json() { return { data: [] }; } }; }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.setupWasteCorrectionUi();
  assert.equal(button.hidden, false);

  handlers.open();
  assert.equal(hiddenClasses.has("hidden"), false);
  assert.equal(attributes["aria-hidden"], "false");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(content.textContent, "No correction requests yet.");

  handlers.close();
  assert.equal(hiddenClasses.has("hidden"), true);
  assert.equal(attributes["aria-hidden"], "true");
  assert.deepEqual(closedChildren, ["wasteCorrectionQueuePanel"]);

  handlers.open();
  assert.equal(hiddenClasses.has("hidden"), false);
  handlers.backdrop();
  assert.equal(hiddenClasses.has("hidden"), true);
});
