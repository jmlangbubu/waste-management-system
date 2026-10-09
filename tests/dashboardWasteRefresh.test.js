const test = require('node:test');
const assert = require('node:assert/strict');
global.window = {};
let active=true;
const status={textContent:''};
global.document={visibilityState:'visible',addEventListener(){},querySelectorAll(){return[];},querySelector(){return null;},getElementById(id){return id==='dashboardSection'?{classList:{contains:()=>active}}:id==='dashboardWasteRefreshStatus'?status:null;}};
global.localStorage={getItem(){return null;},setItem(){}};
global.validatedWasteRecords=[];
global.currentUser={role:'super_admin'};
global.hasWebCapability=()=>true;
global.toNumber=(value)=>Number(value)||0;
global.getRecordType=(r)=>r.entry_type==='establishment'?'Establishment':'Barangay';
global.getRecordDisplayName=(r)=>r.barangay_name||r.establishment_name;
global.getRecordCreatedAt=(r)=>r.validated_at;
require('../frontend/js/admin/admin-dashboard-analytics.js');
test('breakdown sums real categories, ranks barangays, excludes establishments from barangay ranking',()=>{
 const rows=[{barangay_name:'Bula',biodegradable_subtotal:40,recyclable_subtotal:10,validated_at:'2026-10-09'},{barangay_name:'Lagao',biodegradable_subtotal:20,validated_at:'2026-10-08'},{entry_type:'establishment',establishment_name:'Test source',biodegradable_subtotal:30}];
 const m=window.getDashboardWasteBreakdown(rows,'biodegradable');assert.equal(m.total,90);assert.equal(m.percentage,90);assert.deepEqual(m.barangays,[['Bula',40],['Lagao',20]]);assert.equal(m.recent.length,3);
});
test('zero-total and empty category are finite and empty',()=>{
 const m=window.getDashboardWasteBreakdown([],'residual');assert.equal(m.total,0);assert.equal(m.percentage,0);assert.deepEqual(m.recent,[]);
});
test('refresh suppresses overlap, hidden/inactive polling, and reports failures',async()=>{
 let calls=0,finish;global.loadRecords=()=>{calls++;return new Promise(r=>finish=r);};
 const first=window.refreshDashboardWasteMonitoring(),second=window.refreshDashboardWasteMonitoring();assert.equal(first,second);await Promise.resolve();assert.equal(calls,1);finish(true);assert.equal(await first,true);
 document.visibilityState='hidden';assert.equal(await window.refreshDashboardWasteMonitoring(),false);assert.equal(calls,1);
 document.visibilityState='visible';active=false;assert.equal(await window.refreshDashboardWasteMonitoring(),false);assert.equal(calls,1);
 active=true;global.loadRecords=async()=>false;assert.equal(await window.refreshDashboardWasteMonitoring(),false);assert.match(status.textContent,/Showing last available data/);
 global.loadRecords=async()=>{throw new Error('test');};assert.equal(await window.refreshDashboardWasteMonitoring(),false);assert.match(status.textContent,/Showing last available data/);
});
