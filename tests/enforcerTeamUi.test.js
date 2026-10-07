const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "frontend/js/admin/admin-users.js"), "utf8");
const html = fs.readFileSync(path.join(root, "frontend/admin-dashboard.html"), "utf8");
const tests = [];
const test = (name, run) => tests.push({name, run});
const teams = [{id:1, team_name:"Team 01", aors:["City Heights","Conel","San Isidro"]}, {id:2,team_name:"Team 02",aors:["Baluan","Buayan","Katangawan","Ligaya"]}];
function harness() {
  const elements = new Map();
  let active, request, calls = 0, reloads = 0, ok = false;
  function element(id = "") {
    const classes = new Set(id === "createAccountModal" ? ["hidden"] : []);
    const node = {id, value:"", hidden:false, disabled:false, textContent:"", dataset:{}, parentElement:{},
      classList:{contains:x=>classes.has(x),add:x=>classes.add(x),remove:x=>classes.delete(x)},
      focus(){active=this;}, replaceWith(next){elements.set(this.id,next);}, addEventListener(type,fn){this[type]=fn;},
      reset(){for(const id of ["accountPlatform","accountRole","fullName","newUsername","newPassword","assignmentName"]) elements.get(id).value="";}
    };
    let markup="";
    Object.defineProperty(node,"innerHTML",{get:()=>markup,set:value=>{markup=value;node.value="";}});
    return node;
  }
  for(const id of ["createAccountModal","createAccountForm","accountPlatform","accountRole","fullName","newUsername","newPassword","assignmentName","createAccountBtn","accountMessageBox","accountPageMessageBox","enforcerAorPreview","accountSearchInput"]) elements.set(id,element(id));
  const label=element();
  const document={getElementById:id=>elements.get(id),querySelector:()=>label,createElement:()=>element(),querySelectorAll:()=>[],body:{style:{overflow:""}},get activeElement(){return active;},addEventListener(){},removeEventListener(){}};
  const context=vm.createContext({document,window:{},console:{error(){}}, getAppApiBase:()=>"/api", getCreateWebUserApiUrl:()=>"/web",getCreateMobileUserApiUrl:()=>"/mobile",escapeHtml:s=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"),
    webAdminFetch:async(url,options)=>{if(url.endsWith("/enforcer-teams")){calls++;return {ok:true,json:async()=>({success:true,teams})};} request={url,...options}; return {ok,text:async()=>JSON.stringify({message:ok?"Created":"Validation error"})};}
  });
  vm.runInContext(source,context);
  context.loadWebUsers=async()=>{reloads++;}; context.setupAccountPlatformForm(); context.setupCreateAccountForm();
  return {context,elements,label,get request(){return request;},get calls(){return calls;},get reloads(){return reloads;},set ok(value){ok=value;}};
}
const settle = () => new Promise(resolve=>setImmediate(resolve));
async function select(h,platform,role) {
  h.elements.get("accountPlatform").value=platform; h.elements.get("accountPlatform").onchange();
  h.elements.get("accountRole").value=role; h.elements.get("accountRole").onchange(); await settle();
}
test("merged root modal and original form IDs remain unique",()=>{
  for(const id of ["createAccountModal","createAccountForm","accountPlatform","accountRole","assignmentName","createAccountBtn","enforcerAorPreview"]) assert.equal((html.match(new RegExp('id="'+id+'"','g'))||[]).length,1);
  assert(html.indexOf('id="createAccountModal"')>html.indexOf("</main>")); assert(!html.includes("user-create-panel"));
});
test("Enforcer uses fetched team options and read-only escaped multiple AOR preview",async()=>{
  const h=harness(); await select(h,"mobile","enforcer");
  assert.equal(h.label.textContent,"Enforcer Team"); assert.equal(h.elements.get("assignmentName").name,"enforcer_team_id");
  assert(h.elements.get("assignmentName").innerHTML.includes("Team 01"));
  h.elements.get("assignmentName").value="1"; h.elements.get("assignmentName").onchange();
  assert(!h.elements.get("enforcerAorPreview").hidden);
  for(const aor of teams[0].aors) assert(h.elements.get("enforcerAorPreview").innerHTML.includes(aor));
  assert(!/<input|<select/.test(h.elements.get("enforcerAorPreview").innerHTML)); assert.equal(h.calls,1);
});
test("role switching clears team ID, chips, and stale barangay; web/Barangay/Establishment behavior preserved",async()=>{
  const h=harness(); await select(h,"mobile","enforcer"); h.elements.get("assignmentName").value="1"; h.elements.get("assignmentName").onchange();
  await select(h,"mobile","barangay"); assert.equal(h.label.textContent,"Barangay"); assert(h.elements.get("assignmentName").innerHTML.includes("Select barangay")); assert.equal(h.elements.get("assignmentName").value,""); assert(h.elements.get("enforcerAorPreview").hidden);
  await select(h,"mobile","establishment"); assert.equal(h.label.textContent,"Establishment Name"); assert.equal(h.elements.get("assignmentName").placeholder,"Enter establishment name");
  await select(h,"web","personnel"); assert.equal(h.label.textContent,"Division Name"); assert.equal(h.elements.get("assignmentName").placeholder,"Enter division name");
});
test("late team lookup cannot replace a different role's assignment control",async()=>{
  const h=harness(); let complete;
  h.context.webAdminFetch=()=>new Promise(resolve=>{complete=resolve;});
  h.elements.get("accountPlatform").value="mobile";h.elements.get("accountPlatform").onchange();h.elements.get("accountRole").value="enforcer";h.elements.get("accountRole").onchange();
  h.elements.get("accountRole").value="barangay";h.elements.get("accountRole").onchange();
  complete({ok:true,json:async()=>({success:true,teams})}); await settle();
  assert.equal(h.label.textContent,"Barangay"); assert(h.elements.get("assignmentName").innerHTML.includes("Select barangay"));
});
test("team lookup failure prevents selection and remains visible in modal",async()=>{
  const h=harness(); h.context.webAdminFetch=async()=>{throw new Error("Mock teams unavailable");};h.context.openCreateAccountModal();await select(h,"mobile","enforcer");
  assert(h.elements.get("assignmentName").disabled);assert.equal(h.elements.get("accountMessageBox").textContent,"Mock teams unavailable");assert(!h.elements.get("createAccountModal").classList.contains("hidden"));
});
for(const [platform,role,value] of [["web","personnel","WMO"],["mobile","barangay","Bula"],["mobile","establishment","Shop"],["mobile","enforcer","1"]]) test(`${platform}/${role} payload, error and success modal behavior`,async()=>{
  const h=harness();h.context.openCreateAccountModal();await select(h,platform,role);
  for(const [id,v] of Object.entries({fullName:"Fixture",newUsername:"fixture",newPassword:"pass",assignmentName:value})) h.elements.get(id).value=v;
  await h.elements.get("createAccountForm").submit({preventDefault(){}});
  const payload=JSON.parse(h.request.body);assert(!h.elements.get("createAccountModal").classList.contains("hidden"));assert.equal(h.elements.get("accountMessageBox").textContent,"Validation error");
  if(role==="enforcer"){assert.equal(payload.enforcer_team_id,1);assert(!("barangay" in payload));assert(!("assigned_source_name" in payload));assert(!("establishment_name" in payload));}
  else if(platform==="web"){assert.equal(payload.division_name,"WMO");assert.equal(payload.role,"personnel");assert(!("enforcer_team_id" in payload));}
  else {assert.equal(payload.assigned_source_name,value);assert.equal(payload.barangay,role==="barangay"?value:null);assert(!("enforcer_team_id" in payload));}
  h.ok=true;await h.elements.get("createAccountForm").submit({preventDefault(){}});assert.equal(h.reloads,1);assert(h.elements.get("createAccountModal").classList.contains("hidden"));assert.equal(h.elements.get("accountPlatform").value,"");assert(h.elements.get("enforcerAorPreview").hidden);
  h.context.openCreateAccountModal();assert.equal(h.elements.get("accountMessageBox").textContent,"");
});
test("table renders team and all AORs while legacy Enforcer/Citizen assignments retain fallbacks",()=>{
  const h=harness();const user={account_source:"mobile",mobile_role:"enforcer",enforcer_team_name:"Team 01",enforcer_aors:teams[0].aors,barangay:"City Heights"};
  const cell=h.context.renderAccountAssignmentCell(user);assert(cell.includes("<strong>Team 01</strong>"));assert(cell.includes("Conel • San Isidro"));
  assert.equal(h.context.getMobileAssignmentLabel({mobile_role:"enforcer",assigned_source_name:"Bula"}),"Bula");
  assert.equal(h.context.getMobileAssignmentLabel({mobile_role:"citizen",barangay:"Bula"}),"Bula");
  assert.equal(h.context.getAccountEmail({email:"fixture@example.test"}),"fixture@example.test");
  assert(h.context.renderAccountAssignmentCell({...user,enforcer_team_name:"<script>"}).includes("&lt;script&gt;"));
});
(async()=>{for(const {name,run} of tests){await run();console.log("PASS "+name);}console.log(`Enforcer Team UI: ${tests.length}/${tests.length} PASS`);})().catch(error=>{console.error(error);process.exitCode=1;});
