const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "frontend/js/admin/admin-users.js"), "utf8");
const html = fs.readFileSync(path.join(root, "frontend/admin-dashboard.html"), "utf8");
const tests = [];
const test = (name, run) => tests.push({name, run});
const teams = [['City Heights','Conel','San Isidro'],['Baluan','Buayan','Katangawan','Ligaya'],['Dadiangas East'],['Dadiangas North'],['Dadiangas South'],['Dadiangas West'],['Batomelong'],['Mabuhay','Olympog','Tinagacan','Upper Labay'],['Calumpang','Fatima','Siguel','Tambler'],['Bula'],['Lagao'],['Apopong','Labangal','San Jose','Sinawal']].map((aors,i)=>({id:i+1,team_name:'Team '+String(i+1).padStart(2,'0'),aors}));
const aors=teams.flatMap(team=>team.aors).sort().map((barangay_name,i)=>({id:i+1,barangay_name}));
function harness() {
  const elements = new Map();
  let active, request, calls = 0, reloads = 0, ok = false;
  function element(id = "") {
    const classes = new Set(id === "createAccountModal" ? ["hidden"] : []);
    const node = {id, value:"", hidden:false, disabled:false, textContent:"", dataset:{}, parentElement:{},
      classList:{contains:x=>classes.has(x),add:x=>classes.add(x),remove:x=>classes.delete(x)},
      children:[],setAttribute(name,value){this[name]=value;},contains(node){return this.children.includes(node);},append(...nodes){this.children.push(...nodes);nodes.forEach(node=>{if(node.id)elements.set(node.id,node);});},
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
    webAdminFetch:async(url,options)=>{if(url.endsWith("/enforcer-aors")){calls++;return {ok:true,json:async()=>({success:true,aors})};} request={url,...options}; return {ok,text:async()=>JSON.stringify({message:ok?"Created":"Validation error"})};}
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
function choose(h,id,checked=true) {h.elements.get('enforcerAorOptions').onchange({target:{type:'checkbox',value:String(id),checked}});}
test("Enforcer shows all 26 individual checkbox AORs and preserves selected ID order",async()=>{
  const h=harness(); await select(h,"mobile","enforcer");
  assert.equal(h.label.textContent,"Assigned AORs");
  const options=h.elements.get("enforcerAorOptions").innerHTML;
  assert.doesNotMatch(options,/Team \d{2}/);assert.equal((options.match(/type="checkbox"/g)||[]).length,26);
  aors.forEach(aor=>assert(options.includes(`<span>${aor.barangay_name}</span>`)));
  choose(h,5);choose(h,16);choose(h,18);
  assert.equal(h.elements.get('assignmentName').value,'5,16,18');
  assert(!h.elements.get("enforcerAorPreview").hidden);
  for(const aor of ['Bula','Lagao','Mabuhay']) assert(h.elements.get("enforcerAorPreview").innerHTML.includes(aor));
  assert(!/<input|<select/.test(h.elements.get("enforcerAorPreview").innerHTML)); assert.equal(h.calls,1);
});
test("role switching clears team ID, chips, and stale barangay; web/Barangay/Establishment behavior preserved",async()=>{
  const h=harness(); await select(h,"mobile","enforcer"); choose(h,5);
  await select(h,"mobile","barangay"); assert.equal(h.label.textContent,"Barangay"); assert(h.elements.get("assignmentName").innerHTML.includes("Select barangay")); assert.equal(h.elements.get("assignmentName").value,""); assert(h.elements.get("enforcerAorPreview").hidden);
  await select(h,"mobile","establishment"); assert.equal(h.label.textContent,"Establishment Name"); assert.equal(h.elements.get("assignmentName").placeholder,"Enter establishment name");
  await select(h,"web","personnel"); assert.equal(h.label.textContent,"Division Name"); assert.equal(h.elements.get("assignmentName").placeholder,"Enter division name");
});
test("late team lookup cannot replace a different role's assignment control",async()=>{
  const h=harness(); let complete;
  h.context.webAdminFetch=()=>new Promise(resolve=>{complete=resolve;});
  h.elements.get("accountPlatform").value="mobile";h.elements.get("accountPlatform").onchange();h.elements.get("accountRole").value="enforcer";h.elements.get("accountRole").onchange();
  h.elements.get("accountRole").value="barangay";h.elements.get("accountRole").onchange();
  complete({ok:true,json:async()=>({success:true,aors})}); await settle();
  assert.equal(h.label.textContent,"Barangay"); assert(h.elements.get("assignmentName").innerHTML.includes("Select barangay"));
});
test("team lookup failure prevents selection and remains visible in modal",async()=>{
  const h=harness(); h.context.webAdminFetch=async()=>{throw new Error("Mock teams unavailable");};h.context.openCreateAccountModal();await select(h,"mobile","enforcer");
  assert(h.elements.get("assignmentName").children[0].disabled);assert.equal(h.elements.get("accountMessageBox").textContent,"Mock teams unavailable");assert(!h.elements.get("createAccountModal").classList.contains("hidden"));
});
for(const [platform,role,value] of [["web","personnel","WMO"],["mobile","barangay","Bula"],["mobile","establishment","Shop"],["mobile","enforcer","1"]]) test(`${platform}/${role} payload, error and success modal behavior`,async()=>{
  const h=harness();h.context.openCreateAccountModal();await select(h,platform,role);
  for(const [id,v] of Object.entries({fullName:"Fixture",newUsername:"fixture",newPassword:"pass",assignmentName:value})) h.elements.get(id).value=v;
  if(role==='enforcer'){choose(h,5);choose(h,16);}
  await h.elements.get("createAccountForm").submit({preventDefault(){}});
  const payload=JSON.parse(h.request.body);assert(!h.elements.get("createAccountModal").classList.contains("hidden"));assert.equal(h.elements.get("accountMessageBox").textContent,"Validation error");
  if(role==="enforcer"){assert.deepEqual(payload.enforcer_aor_ids,[5,16]);assert(!('enforcer_team_id' in payload));assert(!("barangay" in payload));assert(!("assigned_source_name" in payload));assert(!("establishment_name" in payload));}
  else if(platform==="web"){assert.equal(payload.division_name,"WMO");assert.equal(payload.role,"personnel");assert(!("enforcer_team_id" in payload));}
  else {assert.equal(payload.assigned_source_name,value);assert.equal(payload.barangay,role==="barangay"?value:null);assert(!("enforcer_team_id" in payload));}
  h.ok=true;await h.elements.get("createAccountForm").submit({preventDefault(){}});assert.equal(h.reloads,1);assert(h.elements.get("createAccountModal").classList.contains("hidden"));assert.equal(h.elements.get("accountPlatform").value,"");assert(h.elements.get("enforcerAorPreview").hidden);
  h.context.openCreateAccountModal();assert.equal(h.elements.get("accountMessageBox").textContent,"");
});
test("Enforcer requires at least one selection before making an API request",async()=>{
  const h=harness();h.context.openCreateAccountModal();await select(h,'mobile','enforcer');
  for(const id of ['fullName','newUsername','newPassword'])h.elements.get(id).value='fixture';
  await h.elements.get('createAccountForm').submit({preventDefault(){}});
  assert.equal(h.request,undefined);assert.equal(h.elements.get('accountMessageBox').textContent,'Select at least one AOR.');
});
test("table and assignment search labels show only AORs while legacy fallbacks remain unchanged",()=>{
  const h=harness();const user={account_source:"mobile",mobile_role:"enforcer",enforcer_team_name:"Team 01",enforcer_aors:teams[0].aors,barangay:"City Heights"};
  const cell=h.context.renderAccountAssignmentCell(user);assert.equal(cell,'City Heights • Conel • San Isidro');assert(!cell.includes('Team 01'));
  assert.equal(h.context.getMobileAssignmentLabel(user),'City Heights • Conel • San Isidro');
  assert.equal(h.context.getMobileAssignmentLabel({...user,enforcer_aors:[]}), 'City Heights');
  assert.equal(h.context.getMobileAssignmentLabel({mobile_role:"enforcer",assigned_source_name:"Bula"}),"Bula");
  assert.equal(h.context.getMobileAssignmentLabel({mobile_role:"citizen",barangay:"Bula"}),"Bula");
  assert.equal(h.context.getAccountEmail({email:"fixture@example.test"}),"fixture@example.test");
  assert.equal(h.context.renderAccountAssignmentCell({...user,enforcer_aors:['<script>']}),'&lt;script&gt;');
});
(async()=>{for(const {name,run} of tests){await run();console.log("PASS "+name);}console.log(`Enforcer Team UI: ${tests.length}/${tests.length} PASS`);})().catch(error=>{console.error(error);process.exitCode=1;});
