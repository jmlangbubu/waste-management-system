"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),
 path=require("node:path"),vm=require("node:vm");

function historyFixture(rows,columns=[],columnError=null){
 const handlers={},queries=[],router=Object.fromEntries(["get","post","patch","delete"].map(method=>
  [method,(url,...chain)=>{handlers[method+" "+url]=chain.at(-1);} ]));
 const db={queryReadOnly(sql,cb){queries.push(sql);assert.match(sql,/^SHOW COLUMNS FROM scan_history$/);
  cb(columnError,columns.map(Field=>({Field})));},query(sql,cb){queries.push(sql);
  assert.match(sql,/SELECT [\s\S]*FROM scan_history/);assert.doesNotMatch(sql,/\b(?:ALTER|CREATE|UPDATE|DELETE|INSERT)\b/);
  cb(null,rows);}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../routes/wasteRoutes.js"),"utf8"),{
  module:{exports:{}},__dirname:path.join(__dirname,"../routes"),Buffer,AbortController,
  console:{log(){},warn(){},error(){}},require(id){
   if(id==="express")return {Router:()=>router};if(id==="path")return path;if(id==="qrcode")return {};
   if(id==="fs")return {existsSync:()=>true,mkdirSync(){assert.fail("No writes");}};
   if(id==="../config/db")return db;
   if(id==="../services/wasteAnalysisService")return {};
   if(id.includes("Controller"))return new Proxy({},{get:()=>()=>{}});
   if(id==="../middleware/mobileSessionAuth")return {requireMobileSession(){}};
   if(id==="../middleware/webSessionAuth")return {requireWebCapability:()=>()=>{},requireCsrf(){}};
   throw Error("Unexpected dependency: "+id);
  }
 });
 const res={statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.body=JSON.parse(JSON.stringify(v));return this;}};
 handlers["get /history"]({},res);return {res,queries,handlers};
}
test("legacy history excludes unsafe categories, preserves four genuine categories and response/order",()=>{
 const categories=["Unknown",null,undefined,"invalid","Residual","Recyclable","Biodegradable","Special Waste","residual"," Residual ",""];
 const rows=categories.map((category,id)=>({id,category,item_name:"Original name",detected_object:"Original evidence",image_url:"/synthetic.png"}));
 const saved=structuredClone(rows),{res,queries}=historyFixture(rows,["image_url"]);
 assert.equal(res.statusCode,200);assert.deepEqual(Object.keys(res.body),["success","history"]);
 assert.equal(res.body.success,true);assert.deepEqual(res.body.history.map(row=>row.id),[4,5,6,7]);
 assert.deepEqual(res.body.history.map(row=>row.category),["Residual","Recyclable","Biodegradable","Special Waste"]);
 assert.ok(res.body.history.every(row=>row.item_name==="Original name"&&row.image_url==="/synthetic.png"));
 assert.deepEqual(rows,saved);assert.equal(queries.length,3);
});
test("all unsafe history returns an empty successful list, not fabricated Residual",()=>{
 assert.deepEqual(historyFixture([{category:"Unknown"},{category:null},{}]).res.body,{success:true,history:[]});
});
test("missing optional history columns cause no startup/request DDL and retain genuine records",()=>{
 const {res,queries}=historyFixture([{id:1,category:"Residual"}]);
 assert.equal(res.body.history[0].category,"Residual");assert.equal(res.body.history[0].image_url,"");
 assert.ok(queries.every(sql=>! /\b(?:ALTER|CREATE)\b/.test(sql)));
});
test("history schema read failure remains an existing controlled error response",()=>{
 const {res}=historyFixture([],[],{code:"OFFLINE_SCHEMA_ERROR",message:"synthetic failure"});
 assert.equal(res.statusCode,500);assert.equal(res.body.success,false);assert.equal(res.body.message,"Failed to load scan history");
});
test("there is no separate history GET detail route bypassing the filtered list",()=>{
 assert.equal(historyFixture([]).handlers["get /history/:id"],undefined);
});
