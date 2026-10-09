const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const html = read("frontend/admin-dashboard.html");
const css = read("frontend/css/admin/admin-waste-records.css");
const records = read("frontend/js/admin/admin-waste-records.js");

test("records uses one page heading while preserving filter and action hooks", () => {
  const section = html.slice(html.indexOf('id="recordsSection"'), html.indexOf('id="recordsSection"') + 15000);
  assert.doesNotMatch(section, /<h2[^>]*>Waste Records<\/h2>/);
  for (const id of ["wasteSearchInput", "wasteBarangayFilter", "wasteTypeFilter", "wasteValidationFilter", "wasteMonthFilter", "wasteYearFilter", "generateWasteReportBtn", "wasteCorrectionQueueBtn"]) {
    assert.ok(section.includes(`id="${id}"`), id);
  }
  assert.match(read("frontend/js/admin/admin-navigation.js"), /Validated waste records submitted by the field workflow\./);
});

test("records palette keeps semantic categories and responsive local scrolling", () => {
  for (const color of ["#166534", "#b45309", "#a16207", "#1d4ed8", "#12355b", "#2563eb"]) assert.ok(css.includes(color));
  assert.match(css, /\.table-shell[^}]*overflow-x: auto/);
  assert.match(css, /max-width: 600px/);
  assert.match(css, /grid-template-columns: minmax\(0,1fr\)/);
  assert.match(css, /\.report-header[^}]*flex-shrink: 0/);
  assert.match(css, /data-waste-correction-action="request"/);
  assert.match(css, /data-waste-correction-action="history"/);
});

test("generated summary retains print hooks and white low-ink print surface", () => {
  assert.match(records, /window\.print\(\)/);
  assert.match(records, /@media print/);
  assert.match(records, /background: #fff !important/);
  assert.match(records, /\.report-sheet \{ border: 0; border-radius: 0; \}/);
  assert.match(records, /Weight|kg/);
  assert.match(records, /#2563eb/);
});
