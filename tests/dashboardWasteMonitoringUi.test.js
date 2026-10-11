const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const html = read('frontend/admin-dashboard.html');
const css = read('frontend/css/admin/admin-dashboard.css');
const source = read('frontend/js/admin/admin-dashboard-analytics.js');
test('KPI controls retain totals, accessible selection, shares and custom artwork', () => {
  for (const key of ['biodegradable','recyclable','residual','special']) {
    assert.match(html, new RegExp('<button[^>]+data-waste-category="'+key+'"[^>]+aria-pressed="false"'));
  }
  for (const id of ['totalBiodegradable','totalRecyclable','totalResidual','totalHazardous']) assert.ok(html.includes('id="'+id+'"'));
  for (const icon of ['biodegradable','recyclable','residual-waste','special-waste','clipboard','truck-status','dispatch-route','recommendation']) assert.ok(html.includes('/images/dashboard/wmo-icon-'+icon+'.png'));
  assert.match(css, /dashboard-primary-band \{[^}]*grid-template-columns: 1fr !important/);
  assert.match(source, /dialog\.showModal\(\)/);
  assert.match(source, /aria-labelledby/);
});
test('GenSan palette is shared, consistent, and respects dataset selection', () => {
  const context = { window: {addEventListener(){}}, document:{readyState:'loading',addEventListener(){} } };
  vm.runInNewContext(read('frontend/js/admin/admin-dashboard-palette.js'),context);
  const p=context.window.WMO_DASHBOARD_WASTE_PALETTE;
  assert.equal(p.biodegradable.solid,'#16A34A');assert.equal(p.recyclable.solid,'#F59E0B');assert.equal(p.residual.solid,'#EAB308');assert.equal(p.special.solid,'#2563EB');
  assert.match(read('frontend/js/admin/admin-dashboard-palette.js'), /dashboardSelectedWasteCategory/);
});
test('period filtering and live refresh keep legacy operations functionality', () => {
  assert.match(source, /getFilteredRecordsByRange\(validatedWasteRecords\)/);
  assert.match(source, /loadRecords\(\{ dashboardOnly: true \}\)/);
  assert.match(source, /wmo:waste-records-loaded/);
  assert.match(source, /attributeFilter: \["class"\]/);
  assert.match(source, /60000/);
  assert.match(source, /document.visibilityState === "visible"/);
  assert.match(source, /wasteTrendChartInstance\.update\(\)/);
  assert.match(source, /No waste records for this period/);
});
