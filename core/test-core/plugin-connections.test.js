"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { create, permissions } = require("../../electron/plugin-services/connections");
const { CompanionStore } = require("../../electron/companion-store");
const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "test", encryptString: x => Buffer.from(x), decryptString: x => x.toString() };
function fixture(t, options = {}) {
 const dataDir = fs.mkdtempSync(path.join(os.tmpdir(),"kai-connections-test-")); let privacy = "local-first", approval = true; const reviews = [], requests = [];
 const store = new CompanionStore({dataDir,safeStorage});
 const service = create({dataDir,getCompanionStore:()=>store,core:{gateway:{network:{status:()=>({privacyMode:privacy})}},account:{_token:()=>"synthetic-account-token",origin:()=>"https://account.example"}},electron:{shell:{openExternal:async()=>{throw Error("No real browser in tests");}}},confirm:async(title,detail)=>{reviews.push({title,detail});return approval;},fetchImpl:async(url,input)=>{requests.push({url,input});return options.fetch ? options.fetch(url,input) : new Response(JSON.stringify({ok:true,echo:input.headers.Authorization}),{headers:{"content-type":"application/json"}});}});
 t.after(()=>{service.dispose();fs.rmSync(dataDir,{recursive:true,force:true});});
 return {service,store,reviews,requests,dataDir,setPrivacy:x=>privacy=x,setApproval:x=>approval=x};
}
const api = () => ({name:"Synthetic API",baseUrl:"https://example.com",auth:"bearer",secret:'test-credential-"quoted"',headers:{Accept:"application/json"},operations:[{id:"read",name:"Read",method:"GET",path:"/items/{id}"}],allowAgent:false});
test("Connections preserves Brain and encrypted legacy account records while returning metadata only",async t=>{
 const f=fixture(t);f.store.change(d=>{d.notes.push({id:"private-note",title:"Private",text:"synthetic brain content"});});
 const saved=await f.service.call("connections.save",api());assert.ok(saved.id);assert.equal(f.reviews.length,1);
 const status=await f.service.call("connections.status");assert.equal(status.connections[0].headers.Accept,"application/json");assert.equal(status.connections[0].configured,true);
 const text=JSON.stringify(status);assert.ok(!text.includes(api().secret));assert.ok(!text.includes("brain content"));assert.ok(!Object.hasOwn(status.connections[0],"secret"));
 assert.equal(f.store.data.connections[0].secret,api().secret);assert.equal(f.store.data.notes[0].id,"private-note");
 const disk=JSON.parse(fs.readFileSync(path.join(f.dataDir,"companion-hub.json")));assert.equal(typeof disk.encrypted,"string");
});
test("Connections declines saves and operations without writing or sending",async t=>{
 const f=fixture(t);f.setApproval(false);assert.deepEqual(await f.service.call("connections.save",api()),{cancelled:true});assert.equal(fs.existsSync(path.join(f.dataDir,"companion-hub.json")),false);
 f.setApproval(true);const saved=await f.service.call("connections.save",api());f.setApproval(false);assert.deepEqual(await f.service.call("connections.execute",{id:saved.id,operationId:"read",variables:{id:7}}),{cancelled:true});assert.equal(f.requests.length,0);
});
test("API execution is reviewed, uses host credentials, and removes credentials from nested responses",async t=>{
 const f=fixture(t);const saved=await f.service.call("connections.save",api());const response=await f.service.call("connections.execute",{id:saved.id,operationId:"read",variables:{id:7}});
 assert.equal(f.requests[0].url,"https://example.com/items/7");assert.equal(f.requests[0].input.headers.Authorization,"Bearer "+api().secret);assert.ok(JSON.stringify(response).includes("credential removed"));assert.ok(!JSON.stringify(response).includes("quoted"));assert.ok(f.reviews[1].detail.includes("GET https://example.com/items/7"));
});
test("Local-Only, unknown operations, closed services and locked storage fail closed",async t=>{
 const f=fixture(t);const saved=await f.service.call("connections.save",api());f.setPrivacy("local-only");await assert.rejects(f.service.call("connections.execute",{id:saved.id,operationId:"read",variables:{id:7}}),/Local-Only/);assert.equal(f.requests.length,0);
 await assert.rejects(f.service.call("connections.execute",{id:saved.id,operationId:"invented"}),/saved API operation/);await assert.rejects(f.service.call("brain.list"),/Unknown/);
 f.store.locked=true;await assert.rejects(f.service.call("connections.status"),/keychain/);f.service.dispose();await assert.rejects(f.service.call("connections.templates"),/closed/);
});
test("Connections removes accounts without overwriting other areas and pauses their sources",async t=>{
 const f=fixture(t);const saved=await f.service.call("connections.save",api());f.store.change(d=>{d.sources.push({connectionId:saved.id,autoSync:true});d.workflows.push({id:"keep"});});
 await f.service.call("connections.remove",{id:saved.id});assert.equal(f.store.data.connections.length,0);assert.equal(f.store.data.sources[0].autoSync,false);assert.equal(f.store.data.workflows[0].id,"keep");
 assert.equal(permissions["connections.execute"],"connections.execute");
});
test("provider error messages cannot return host tokens or JSON-escaped saved credentials",async t=>{
 const f=fixture(t,{fetch:async url=>url.endsWith("/connections/status")?new Response(JSON.stringify({available:true,protocol:1,generation:"fixture"})):new Response(JSON.stringify({ok:false,error:"Rejected synthetic-account-token and "+JSON.stringify(api().secret)}),{status:400})});
 await f.service.call("connections.save",api());await assert.rejects(f.service.call("connections.composio.refresh"),error=>{assert.ok(!error.message.includes("synthetic-account-token"));assert.ok(!error.message.includes("quoted"));assert.ok(error.message.includes("credential removed"));return true;});
});
