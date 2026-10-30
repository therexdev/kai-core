"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {create,validateConfig,cleanEnv}=require("../../electron/plugin-services/tools");
const {JsonStore}=require("../lib/store");
function fixture(t){const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),"kai-tools-test-")),settings=new JsonStore(path.join(dataDir,"settings.json"),{mcp:{servers:[]},wallet:{sentinel:"never-return"}});let approval=true,privacy="local-first";const reviews=[];const service=create({dataDir,core:{settings,runtime:{},gateway:{network:{status:()=>({privacyMode:privacy})}}},confirm:async(title,detail)=>{reviews.push({title,detail});return approval;}});t.after(async()=>{await service.dispose();fs.rmSync(dataDir,{recursive:true,force:true});});return{dataDir,service,settings,reviews,setApproval:x=>approval=x,setPrivacy:x=>privacy=x};}
function server(f){const file=path.join(f.dataDir,"synthetic-server.js");fs.writeFileSync(file,`const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;let result={};if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};if(m.method==='tools/list')result={tools:[{name:'echo',description:'Synthetic echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]};if(m.method==='tools/call')result={content:[{type:'text',text:JSON.stringify({text:m.params.arguments.text,pid:process.pid,secret:process.env.KAI_SYNTHETIC_TEST_SECRET||null})}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);return{name:"Synthetic server",transport:"stdio",command:process.execPath,args:[file],localSafe:true};}
test("MCP tools require review, preserve settings, discover and invoke a real synthetic process, then stop it",async t=>{
 const f=fixture(t),config=server(f);process.env.KAI_SYNTHETIC_TEST_SECRET="must-not-reach-child";t.after(()=>delete process.env.KAI_SYNTHETIC_TEST_SECRET);
 const saved=await f.service.call("tools.add",config);assert.equal(f.settings.get("wallet.sentinel"),"never-return");assert.equal(f.settings.get("mcp.servers")[0].autoConnect,false);
 const connected=await f.service.call("tools.connect",saved);assert.equal(connected.tools[0].name,"echo");const response=await f.service.call("tools.call",{...saved,name:"echo",args:{text:"hello"}});const result=JSON.parse(response.result);assert.equal(result.text,"hello");assert.equal(result.secret,null);assert.equal(f.reviews.length,3);assert.ok(f.reviews[1].detail.includes("not a sandboxed plugin"));
 const state=await f.service.call("tools.status");assert.equal(state.servers[0].connected,true);assert.ok(!JSON.stringify(state).includes("never-return"));assert.ok(!Object.hasOwn(state.servers[0],"args"));
 await f.service.call("tools.disconnect",saved);assert.equal((await f.service.call("tools.status")).servers[0].connected,false);assert.throws(()=>process.kill(result.pid,0),{code:"ESRCH"});
});
test("declined launches never execute and Local-Only blocks unapproved egress",async t=>{
 const f=fixture(t);f.setApproval(false);assert.deepEqual(await f.service.call("tools.add",{name:"HTTP",transport:"http",url:"https://example.com/mcp"}),{cancelled:true});assert.equal(f.settings.get("mcp.servers").length,0);
 f.setApproval(true);const saved=await f.service.call("tools.add",server(f));f.setApproval(false);assert.deepEqual(await f.service.call("tools.connect",saved),{cancelled:true});assert.equal((await f.service.call("tools.status")).servers[0].connected,false);
 f.setApproval(true);const http=await f.service.call("tools.add",{transport:"http",url:"https://example.com/mcp?token=synthetic"});f.setPrivacy("local-only");await assert.rejects(f.service.call("tools.connect",http),/Local-Only/);assert.ok(!JSON.stringify(await f.service.call("tools.status")).includes("token=synthetic"));
});
test("corrupt, replaced and symlinked settings are preserved",async t=>{
 const f=fixture(t),file=path.join(f.dataDir,"settings.json");f.settings.set("sentinel",1);fs.writeFileSync(file,"broken");await assert.rejects(f.service.call("tools.add",server(f)),/unreadable/);assert.equal(fs.readFileSync(file,"utf8"),"broken");
 fs.writeFileSync(file,JSON.stringify({sentinel:2}));await assert.rejects(f.service.call("tools.status"),/changed outside/);assert.deepEqual(JSON.parse(fs.readFileSync(file)),{sentinel:2});
 fs.rmSync(file);fs.symlinkSync("missing-target",file);await assert.rejects(f.service.call("tools.status"),/recovery/);assert.equal(fs.lstatSync(file).isSymbolicLink(),true);
});
test("command and URL validation reject ambiguous or credential-bearing requests",()=>{
 for(const url of ["http://remote.example/mcp","https://user:pass@example.com/mcp","file:///tmp/mcp","https://example.com/mcp#fragment"])assert.throws(()=>validateConfig({transport:"http",url}));
 assert.throws(()=>validateConfig({transport:"stdio",command:["node","script.js"]}),/one executable/);assert.throws(()=>validateConfig({transport:"stdio",command:"node",args:[4]}),/JSON array/);
 assert.deepEqual(cleanEnv({PATH:"path",HOME:"home",AWS_SECRET_ACCESS_KEY:"never",KAI_TOKEN:"never",NODE_OPTIONS:"--inspect"}),{PATH:"path",HOME:"home"});
});
test("plugin disposal closes live children and rejects new calls",async t=>{
 const f=fixture(t);const saved=await f.service.call("tools.add",server(f));await f.service.call("tools.connect",saved);const response=await f.service.call("tools.call",{...saved,name:"echo",args:{text:"done"}});const pid=JSON.parse(response.result).pid;await f.service.dispose();assert.throws(()=>process.kill(pid,0),{code:"ESRCH"});await assert.rejects(f.service.call("tools.status"),/closed/);
});
