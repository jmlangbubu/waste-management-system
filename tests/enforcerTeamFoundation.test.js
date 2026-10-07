const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {createEnforcerTeamService} = require("../services/enforcerTeamService");
const root = path.join(__dirname, "..");
const tests = [];
const test = (name, run) => tests.push({name, run});

function database(options = {}) {
  let snapshot;
  const state = {users: [], members: [], committed: false, rolledBack: false, released: false, destroyed: false, queries: []};
  const team = {id:1, team_name:"Team 01", status:options.inactive ? "inactive" : "active"};
  const aors = options.empty ? [] : ["City Heights", "Conel", "San Isidro"];
  const conn = {
    beginTransaction(cb) {if (options.beginError) return cb(new Error("begin failed")); snapshot = {users:[...state.users], members:[...state.members]}; cb();},
    commit(cb) {if (options.commitError) return cb(new Error("commit failed")); state.committed = true; cb();},
    rollback(cb) {if (options.rollbackError) return cb(new Error("rollback failed")); state.users = snapshot?.users || []; state.members = snapshot?.members || []; state.rolledBack = true; cb();},
    release() {state.released = true;},
    destroy() {state.destroyed = true;},
    query(sql, values, cb) {
      state.queries.push({sql, values});
      if (/SELECT id, team_name, status FROM enforcer_teams/.test(sql)) return cb(null, values[0] === 1 ? [team] : []);
      if (/SELECT barangay_name FROM enforcer_team_aors/.test(sql)) return cb(null, aors.map(barangay_name=>({barangay_name})));
      if (/SELECT id FROM users WHERE username/.test(sql)) return cb(null, options.duplicate ? [{id:99}] : []);
      if (/INSERT INTO users/.test(sql)) {state.users.push({id:10, values}); return cb(null, {insertId:10});}
      if (/INSERT INTO enforcer_team_members/.test(sql)) {
        if (options.membershipError) return cb(Object.assign(new Error("membership failed"), {code:"ER_DUP_ENTRY"}));
        state.members.push({team_id:values[0],user_id:values[1]}); return cb(null, {insertId:1});
      }
      if (/SELECT id, role, mobile_role FROM users/.test(sql)) return cb(null, options.userMissing ? [] : [{id:10,role:options.nonEnforcer ? "citizen" : "enforcer", mobile_role:options.nonEnforcer ? "citizen" : "enforcer"}]);
      if (/SELECT team_id FROM enforcer_team_members/.test(sql)) return cb(null, options.existingTeam ? [{team_id:options.existingTeam}] : []);
      if (/UPDATE users SET assigned_source_name/.test(sql)) return cb(null, {affectedRows:1});
      if (/FROM enforcer_teams/.test(sql)) return cb(null, options.noTeams ? [] : [team]);
      if (/SELECT team_id, barangay_name/.test(sql)) return cb(null, aors.map(barangay_name=>({team_id:1,barangay_name})));
      if (/SELECT m.team_id, u.id/.test(sql)) return cb(null, [{team_id:1,id:10,full_name:"Fixture Enforcer",status:"active"}]);
      if (/SELECT m.user_id/.test(sql)) return cb(null, aors.map(barangay_name=>({user_id:10,enforcer_team_id:1,enforcer_team_name:"Team 01",barangay_name})));
      cb(new Error("Unexpected SQL: " + sql));
    }
  };
  return {state, db:{query:conn.query, getConnection(cb){if (options.acquireError) return cb(new Error("acquire failed")); cb(null,conn);}}};
}
const input = {enforcer_team_id:1, full_name:"Fixture Enforcer", username:"fixture", hashedPassword:"hash",status:"active"};
test("active team list includes ordered AOR arrays and compact members in three queries", async()=>{
  const {db,state} = database(); const result = await createEnforcerTeamService(db).listTeams();
  assert.deepEqual(result[0].aors,["City Heights","Conel","San Isidro"]);
  assert.deepEqual(result[0].members,[{id:10,full_name:"Fixture Enforcer",status:"active"}]);
  assert.equal(state.queries.length,3); assert.deepEqual(state.queries[0].values,["active"]);
  assert(state.queries.every(q=>!q.sql.includes("password")));
});
test("team detail returns one team and rejects invalid ID", async()=>{
  const {db}=database(); const service=createEnforcerTeamService(db);
  assert.equal((await service.listTeams(1))[0].team_name,"Team 01");
  await assert.rejects(service.listTeams("1 OR 1=1"),/positive integer/);
});
test("no active teams returns an empty list without followup queries",async()=>{
  const {db,state}=database({noTeams:true}); assert.deepEqual(await createEnforcerTeamService(db).listTeams(),[]); assert.equal(state.queries.length,1);
});
test("team creation atomically inserts hashed user and membership with first ordered AOR bridge",async()=>{
  const {db,state}=database(); assert.equal(await createEnforcerTeamService(db).createEnforcer(input),10);
  assert.deepEqual(state.users[0].values,["Fixture Enforcer","fixture","hash","enforcer","enforcer","City Heights","City Heights","active"]);
  assert.deepEqual(state.members,[{team_id:1,user_id:10}]); assert(state.committed && state.released);
  assert(state.queries.some(q=>/ORDER BY sort_order, id FOR UPDATE/.test(q.sql)));
});
for (const [name,options,patch,message] of [
  ["missing team ID",{}, {enforcer_team_id:undefined},/positive integer/],
  ["invalid team ID",{}, {enforcer_team_id:99},/existing active/],
  ["inactive team",{inactive:true},{},/existing active/],
  ["no AORs",{empty:true},{},/no assigned AORs/],
  ["duplicate username",{duplicate:true},{},/Username already exists/]
]) test(name + " creates no user",async()=>{
  const {db,state}=database(options); await assert.rejects(createEnforcerTeamService(db).createEnforcer({...input,...patch}),message);
  assert.equal(state.users.length,0); assert.equal(state.members.length,0); assert(!state.committed);
});
for (const option of ["membershipError","commitError"]) test(option + " rolls back user and membership and releases connection",async()=>{
  const {db,state}=database({[option]:true}); await assert.rejects(createEnforcerTeamService(db).createEnforcer(input));
  assert(state.rolledBack && state.released); assert.equal(state.users.length,0); assert.equal(state.members.length,0);
});
test("failed rollback destroys the connection instead of returning an uncertain transaction to the pool",async()=>{
  const {db,state}=database({membershipError:true,rollbackError:true});
  await assert.rejects(createEnforcerTeamService(db).createEnforcer(input),/membership failed/);
  assert(state.destroyed); assert(!state.released); assert(!state.committed);
});
test("begin failure releases the connection without inserting a user",async()=>{
  const {db,state}=database({beginError:true});
  await assert.rejects(createEnforcerTeamService(db).createEnforcer(input),/begin failed/);
  assert(state.released && state.rolledBack); assert.equal(state.users.length,0); assert.equal(state.queries.length,0);
});
test("acquisition failure makes no queries and preserves the original error",async()=>{
  const {db,state}=database({acquireError:true});
  await assert.rejects(createEnforcerTeamService(db).createEnforcer(input),/acquire failed/);
  assert.equal(state.queries.length,0); assert(!state.released && !state.destroyed);
});
test("all accounts uses one batch query and preserves Citizens, web users, and unassigned Enforcers",async()=>{
  const {db,state}=database(); const accounts=[{id:10,account_source:"mobile",mobile_role:"enforcer",barangay:"City Heights"}, {id:11,account_source:"mobile",mobile_role:"enforcer",barangay:"Bula"}, {id:12,account_source:"mobile",mobile_role:"citizen",email:"fixture@example.test",barangay:"Bula"}, {id:10,account_source:"web",role:"personnel"}];
  const result=await createEnforcerTeamService(db).enrichAccounts(accounts);
  assert.deepEqual(result[0].enforcer_aors,["City Heights","Conel","San Isidro"]);
  assert.equal(result[0].enforcer_team_name,"Team 01"); assert.equal(result[1].enforcer_team_id,null); assert.equal(result[1].barangay,"Bula");
  assert.equal(result[2],accounts[2]); assert.equal(result[3],accounts[3]); assert.equal(state.queries.length,1); assert.deepEqual(state.queries[0].values,[10,11]);
});
test("non-Enforcer account lists need no team query",async()=>{
  const {db,state}=database(); await createEnforcerTeamService(db).enrichAccounts([{id:10,account_source:"mobile",mobile_role:"citizen"}]); assert.equal(state.queries.length,0);
});
test("explicit existing Enforcer assignment uses membership and compatibility transaction",async()=>{
  const {db,state}=database(); await createEnforcerTeamService(db).assignMember(1,10);
  assert.equal(state.members.length,1); assert(state.committed); assert.deepEqual(state.queries.find(q=>/UPDATE users/.test(q.sql)).values,["City Heights","City Heights",10]);
});
for (const [name,options,message] of [["Citizen",{nonEnforcer:true},/Only Enforcer/],["another team",{existingTeam:2},/another team/],["missing user",{userMissing:true},/not found/]]) test("manual membership rejects " + name,async()=>{
  const {db,state}=database(options); await assert.rejects(createEnforcerTeamService(db).assignMember(1,10),message); assert.equal(state.members.length,0); assert(state.rolledBack);
});
test("same-team assignment is idempotent",async()=>{
  const {db,state}=database({existingTeam:1}); await createEnforcerTeamService(db).assignMember(1,10); assert.equal(state.members.length,0); assert(state.committed);
});

function routeHarness(options={}) {
  const handlers = new Map(), middleware = [], queries=[];
  const router={use(fn){middleware.push(fn);},get(url,fn){handlers.set('GET '+url,fn);},post(url,fn){handlers.set('POST '+url,fn);},put(url,fn){handlers.set('PUT '+url,fn);},delete(){}};
  const db={query(sql,params,cb){if(typeof params==='function'){cb=params;params=[];} queries.push({sql,params}); if(/SELECT id FROM users/.test(sql)) cb(null,options.duplicate?[{id:1}]:[]); else if(/INSERT INTO users/.test(sql)) cb(null,{insertId:5}); else if(/FROM web_users/.test(sql)) cb(null,[]); else cb(null,[{id:5,account_source:'mobile',mobile_role:'enforcer'}]);}};
  const service={listTeams:async()=>[{id:1,aors:['City Heights','Conel']}], assignMember:async()=>({user_id:5}), enrichAccounts:async a=>a.map(u=>({...u,enforcer_team_name:'Team 01',enforcer_aors:['City Heights','Conel']})),createEnforcer:async data=>{options.created=data;return 5;}};
  const mocks={'express':{Router:()=>router},'../config/db':db,'bcrypt':{hash:async(p,cost)=>{assert.equal(cost,10);return 'hashed:'+p;}},'../services/webSessionService':{},'../middleware/webSessionAuth':{requireWebCapability:c=>'capability:'+c,requireCsrf:'csrf'},'../services/enforcerTeamService':{createEnforcerTeamService:()=>service,EnforcerTeamError:require('../services/enforcerTeamService').EnforcerTeamError}};
  mocks['../services/enforcerAorService']={createEnforcerAorService:()=>({...service,listAors:async()=>[{id:5,barangay_name:'Bula'}]}),EnforcerAorError:require('../services/enforcerAorService').EnforcerAorError};
  vm.runInNewContext(fs.readFileSync(path.join(root,'routes/webUserRoutes.js'),'utf8'),{require:name=>mocks[name],module:{exports:{}},console:{log(){},warn(){},error(){}}});
  function invoke(key,body={}) {return new Promise((resolve,reject)=>{const res={code:200,status(c){this.code=c;return this;},json(data){resolve({code:this.code,data});}};Promise.resolve(handlers.get(key)({body,user:{id:1},params:{id:1,userId:5}},res)).catch(reject);});}
  return {invoke,middleware,queries,options};
}
test("new team routes use users.manage and existing CSRF chain",async()=>{
  const h=routeHarness(); assert.deepEqual(h.middleware,['capability:users.manage','csrf']);
  assert((await h.invoke('GET /enforcer-teams')).data.teams[0].aors.length===2);
  assert.equal((await h.invoke('GET /enforcer-teams/:id')).data.team.id,1);
  assert.equal((await h.invoke('PUT /enforcer-teams/:id/members/:userId')).data.membership.user_id,5);
  assert.equal((await h.invoke('GET /enforcer-aors')).data.aors[0].barangay_name,'Bula');
});
for(const [role,assignment,barangay] of [['barangay','Bula','Bula'],['establishment','Fixture Shop',null]]) test(role+' account flow unchanged',async()=>{
  const h=routeHarness(); const result=await h.invoke('POST /create-mobile-account',{full_name:'Fixture',username:'fixture',password:'pass',mobile_role:role,assigned_source_name:assignment});
  assert.equal(result.code,201); assert.deepEqual(Array.from(h.queries.find(q=>/INSERT INTO users/.test(q.sql)).params),['Fixture','fixture','hashed:pass',role,role,assignment,barangay,'active']);
});
test("route creates Enforcer by direct AORs without a team and with password hashing",async()=>{
  const h=routeHarness(); const result=await h.invoke('POST /create-mobile-account',{full_name:'Fixture',username:'fixture',password:'pass',mobile_role:'enforcer',enforcer_aor_ids:[5,16]});
  assert.equal(result.code,201); assert.deepEqual(Array.from(h.options.created.enforcer_aor_ids),[5,16]);assert.equal(h.options.created.enforcer_team_id,undefined); assert.equal(h.options.created.hashedPassword,'hashed:pass'); assert.equal(h.queries.length,0);
});
test("non-Enforcer team payload is rejected before creating user",async()=>{
  const h=routeHarness(); const result=await h.invoke('POST /create-mobile-account',{full_name:'Fixture',username:'fixture',password:'pass',mobile_role:'barangay',assigned_source_name:'Bula',enforcer_team_id:1}); assert.equal(result.code,400); assert.equal(h.queries.length,0);
});
test("legacy duplicate username remains 409",async()=>{
  const h=routeHarness({duplicate:true}); const result=await h.invoke('POST /create-mobile-account',{full_name:'Fixture',username:'fixture',password:'pass',mobile_role:'barangay',assigned_source_name:'Bula'}); assert.equal(result.code,409); assert.equal(h.queries.length,1);
});
test("all-accounts route exposes enrichment without changing response shape",async()=>{
  const result=await routeHarness().invoke('GET /all-accounts'); assert.equal(result.data.success,true); assert.deepEqual(Array.from(result.data.accounts[0].enforcer_aors),['City Heights','Conel']);
});
test("migration defines normalized constraints and exactly 12 official teams / 26 ordered AORs",()=>{
  const sql=fs.readFileSync(path.join(root,'database/migrations/20261007_enforcer_team_aors.sql'),'utf8');
  assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS/g)||[]).length,3);
  assert.match(sql,/UNIQUE KEY uq_enforcer_team_member_user \(user_id\)/); assert.match(sql,/REFERENCES users \(id\)/);
  assert.doesNotMatch(sql,/ALTER TABLE|INSERT INTO users|INSERT INTO enforcer_team_members|DROP TABLE/i);
  const seeds=[...sql.matchAll(/(?:SELECT|UNION ALL SELECT) 'Team (\d{2})'(?: AS team_name)?, '([^']+)'(?: AS barangay_name)?, (\d+)/g)];
  assert.equal(seeds.length,26); assert.equal(new Set(seeds.map(m=>m[1])).size,12);
  assert.equal(new Set(seeds.map(m=>m[2])).size,26);
  const expected=[['City Heights','Conel','San Isidro'],['Baluan','Buayan','Katangawan','Ligaya'],['Dadiangas East'],['Dadiangas North'],['Dadiangas South'],['Dadiangas West'],['Batomelong'],['Mabuhay','Olympog','Tinagacan','Upper Labay'],['Calumpang','Fatima','Siguel','Tambler'],['Bula'],['Lagao'],['Apopong','Labangal','San Jose','Sinawal']];
  expected.forEach((aors,index)=>{const rows=seeds.filter(m=>Number(m[1])===index+1); assert.deepEqual(rows.map(m=>m[2]),aors); assert.deepEqual(rows.map(m=>Number(m[3])),aors.map((_,i)=>i+1));});
});
(async()=>{for(const {name,run} of tests){await run();console.log('PASS '+name);}console.log(`Enforcer Team foundation: ${tests.length}/${tests.length} PASS`);})().catch(error=>{console.error(error);process.exitCode=1;});
