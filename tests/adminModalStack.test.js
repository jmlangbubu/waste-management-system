const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const html = read("frontend/admin-dashboard.html");
const css = read("frontend/css/admin/admin-overrides.css");
const navigation = read("frontend/js/admin/admin-navigation.js");

const children = {
  validationDetailsModal: [
    "wasteCorrectionRequestModal", "wasteCorrectionHistoryModal",
    "wasteCorrectionReviewModal", "wasteCorrectionCancelModal"
  ],
  incomingInvoiceModal: ["invoiceTrackingModal"]
};

test("stacked modal roots declare one parent and share the child layer", () => {
  for (const [parent, ids] of Object.entries(children)) {
    for (const id of ids) {
      const tag = html.match(new RegExp(`<div id="${id}"[^>]*>`, "g"));
      assert.equal(tag?.length, 1, id);
      assert.match(tag[0], /class="[^"]*modal-stack-child[^"]*"/);
      assert.match(tag[0], new RegExp(`data-modal-parent="${parent}"`));
      assert.match(css, new RegExp(`#${id}`));
    }
  }
  assert.match(css, /--wmo-z-modal-stacked-child:\s*2147483001/);
  assert.match(css, /@media \(max-width: 1200px\)\s*\{[\s\S]*?\.modal-stack-child \.waste-correction-modal\s*\{[^}]*left:\s*auto !important/);
  assert.match(css, /#invoiceTrackingModal #invoiceTrackingOverlay\s*\{[^}]*z-index:\s*1 !important/s);
  assert.match(css, /#invoiceTrackingModal \.custom-modal-content\s*\{[^}]*z-index:\s*2 !important/s);
  assert.doesNotMatch(css, /z-index:\s*10050[12] !important/);
});

test("closing a parent hides only its children", () => {
  const nodes = Object.entries(children).flatMap(([parent, ids]) => ids.map((id) => ({
    id, dataset: { modalParent: parent }, hidden: false,
    classList: { add(name) { assert.equal(name, "hidden"); this.owner.hidden = true; } }
  })));
  for (const node of nodes) node.classList.owner = node;
  const document = {
    readyState: "loading", addEventListener() {},
    querySelectorAll(selector) {
      assert.equal(selector, ".modal-stack-child");
      return nodes;
    }
  };
  const context = { document, window: {} };
  vm.createContext(context);
  vm.runInContext(navigation, context);

  context.closeAdminStackedChildren("validationDetailsModal");
  for (const node of nodes) {
    assert.equal(node.hidden, node.dataset.modalParent === "validationDetailsModal", node.id);
  }
  context.closeAdminStackedChildren("incomingInvoiceModal");
  assert.ok(nodes.every((node) => node.hidden));
});

test("parent close paths clean children and invoice async opening respects a closed parent", () => {
  assert.match(read("frontend/js/admin/admin-waste-records.js"),
    /function closeValidationDetailsModal\(\)\s*\{\s*closeAdminStackedChildren\("validationDetailsModal"\)/);
  assert.match(read("frontend/js/admin/admin-other.js"),
    /function closeIncomingInvoiceModal\(\)\s*\{\s*closeAdminStackedChildren\("incomingInvoiceModal"\)/);
  assert.match(read("frontend/js/admin/admin-invoices.js"),
    /if \(openedFromParent && parent\.classList\.contains\("hidden"\)\) return/);
});
