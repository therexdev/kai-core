"use strict";
// Independent lifecycle tests use genuine signed installs and native service
// fixtures. There are no real publisher keys, feature profiles or OS actions.
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const {PluginManager}=require("../lib/plugins/manager"),{canonical}=require("../lib/plugins/package"),{FeatureServices}=require("../../electron/plugin-services");
const ID="fixture.background",READ="storage.read",WRITE="storage.write",deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function fixture(t,{version="0.2.0",permissions=[READ,WRITE],create,keepAlive=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"kai-background-test-")),keys=crypto.generateKeyPairSync("ed25519"),der=keys.publicKey.export({format:"der",type:"spki"}),fingerprint=crypto.createHash("sha256").update(der).digest("hex");
 const manager=new PluginManager(dir),manifest={schema:1,apiVersion:2,id:ID,version,name:"Synthetic background fixture",entry:"index.html",permissions};
 const files={"index.html":"<p>Synthetic fixture only</p>"},pkg={manifest,files,publicKey:der.toString("base64"),signature:crypto.sign(null,Buffer.from(canonical({manifest,files})),keys.privateKey).toString("base64")};
 manager.install(pkg);const events=[],contexts=[],instances=[];let verifies=0;
 const module={permissions:{"fixture.read":READ,"fixture.write":WRITE},create(ctx){contexts.push(ctx);events.push("create");const service=create?create(ctx,instances.length):{keepAliveOnWindowClose:keepAlive,startBackground(){events.push("start");},call(method){events.push(method);return method;},dispose({reason}){events.push("dispose:"+reason);}};instances.push(service);return service;}};
 const ctx={dataDir:dir,getCoreWindow:()=>({id:"core"}),getWindow:()=>({id:"core"}),loadInstalledPlugin:id=>{verifies++;if(!manager.list().some(row=>row.id===id&&row.enabled))return null;return manager.load(id);},confirm:async()=>true};
 const broker=new FeatureServices(ctx,{definitions:{[ID]:{permissions:module.permissions,factory:module}},publishers:[{id:ID,fingerprint}]});
 const tamper=fn=>{const file=path.join(manager.pluginDir(ID),manager.state.installed[ID].file),value=JSON.parse(fs.readFileSync(file));fn(value);fs.writeFileSync(file,JSON.stringify(value));};
 t.after(async()=>{await broker.dispose();fs.rmSync(dir,{recursive:true,force:true});});
 return{broker,manager,module,events,contexts,instances,tamper,get verifies(){return verifies;}};
}
test("startup verifies a real installed enabled 0.2 package before creating and starting its native service",async t=>{
 const f=fixture(t);let loads=0;const load=f.manager.load.bind(f.manager);f.manager.load=id=>{loads++;assert.equal(f.events.length,0);return load(id);};
 await f.broker.startInstalledBackground(f.manager);assert.equal(loads,1);assert.deepEqual(f.events,["create","start"]);assert.equal(f.contexts[0].manifest.id,ID);assert.deepEqual(f.contexts[0].manifest.permissions,[READ,WRITE]);assert.equal(f.contexts[0].getWindow().id,"core");
});
for(const scenario of ["uninstalled","disabled","old-version","wrong-publisher","missing-grant","altered-grants","bad-signature"])test(`background startup rejects ${scenario} without constructing a native service`,async t=>{
 const f=fixture(t,{version:scenario==="old-version"?"0.1.9":"0.2.0",permissions:scenario==="missing-grant"?[READ]:[READ,WRITE]});
 if(scenario==="uninstalled")f.manager.change(ID,"remove");if(scenario==="disabled")f.manager.change(ID,"disable");if(scenario==="wrong-publisher")f.broker.publishers[0].fingerprint="0".repeat(64);if(scenario==="altered-grants")f.manager.state.installed[ID].permissions=[READ];if(scenario==="bad-signature")f.tamper(pkg=>pkg.files["index.html"]+="tampered");
 await f.broker.startInstalledBackground(f.manager);assert.deepEqual(f.events,[]);
 if(["altered-grants","bad-signature"].includes(scenario))assert.match(f.broker.backgroundErrors.get(ID),/grants changed|signature/);
});
test("internal featureCall reloads the signed install on every call and detects subsequent tampering",async t=>{
 const f=fixture(t);assert.equal(await f.broker.featureCall(ID,"fixture.read",{}),"fixture.read");assert.equal(await f.broker.featureCall(ID,"fixture.write",{}),"fixture.write");assert.equal(f.verifies,2);f.tamper(pkg=>pkg.files["index.html"]="changed after first call");await assert.rejects(f.broker.featureCall(ID,"fixture.read",{}),/signature/);assert.equal(f.verifies,3);assert.deepEqual(f.events,["create","fixture.read","fixture.write"]);
});
test("internal featureCall enforces exact publisher, feature scope and enabled state",async t=>{
 const f=fixture(t,{permissions:[READ]});await assert.rejects(f.broker.featureCall(ID,"fixture.write",{}),/permission denied/);await assert.rejects(f.broker.featureCall(ID,"other.private",{}),/permission denied/);await assert.rejects(f.broker.featureCall("other.plugin","fixture.read",{}),/Install and enable/);assert.deepEqual(f.events,[]);
 const pin=f.broker.publishers[0].fingerprint;f.broker.publishers[0].fingerprint="wrong";await assert.rejects(f.broker.featureCall(ID,"fixture.read",{}),/permission denied/);f.broker.publishers[0].fingerprint=pin;
 await f.broker.featureCall(ID,"fixture.read",{});f.manager.change(ID,"disable");await assert.rejects(f.broker.featureCall(ID,"fixture.read",{}),/Install and enable/);assert.deepEqual(f.events,["create","fixture.read"]);
});
test("persistent window detach keeps background service, while remove and quit preserve their exact cleanup reason",async t=>{
 const f=fixture(t);await f.broker.startInstalledBackground(f.manager);await f.broker.detachWindow(ID);assert.deepEqual(f.events,["create","start"]);await f.broker.close(ID,{reason:"remove"});assert.equal(f.events.at(-1),"dispose:remove");await f.broker.featureCall(ID,"fixture.read",{});await f.broker.dispose();assert.equal(f.events.at(-1),"dispose:quit");assert.equal(f.instances.length,2);
});
test("ordinary plugin window detach disposes its native service with a window reason",async t=>{
 const f=fixture(t,{keepAlive:false});await f.broker.featureCall(ID,"fixture.read",{});await f.broker.detachWindow(ID);assert.equal(f.events.at(-1),"dispose:window");
});
test("startup and native feature calls cannot recreate a service while disable cleanup is pending",async t=>{
 const cleanup=deferred();let starts=0;const f=fixture(t,{create:()=>({startBackground(){starts++;},call(){},dispose:()=>cleanup.promise})});
 await f.broker.startInstalledBackground(f.manager);const closing=f.broker.close(ID,{reason:"disable"});
 try{const startup=f.broker.startInstalledBackground(f.manager);await assert.rejects(f.broker.featureCall(ID,"fixture.read",{}),/closing/);assert.equal(f.instances.length,1);assert.equal(starts,1);cleanup.resolve();await closing;f.manager.change(ID,"disable");await startup;assert.equal(f.instances.length,1);await f.broker.startInstalledBackground(f.manager);assert.equal(starts,1);}finally{cleanup.resolve();await closing;}
});
test("a stale startup failure cannot close a replacement created after disable and re-enable",async t=>{
 const oldStart=deferred(),disposeReasons=[];const f=fixture(t,{create:(_ctx,generation)=>({startBackground:()=>generation===0?oldStart.promise:Promise.resolve(),call:()=>generation,dispose:({reason})=>disposeReasons.push([generation,reason])})});
 const oldStartup=f.broker.startInstalledBackground(f.manager);await new Promise(r=>setImmediate(r));await f.broker.close(ID,{reason:"disable"});f.manager.change(ID,"disable");f.manager.change(ID,"enable");await f.broker.startInstalledBackground(f.manager);assert.equal(f.instances.length,2);
 oldStart.reject(Error("old startup finished too late"));await oldStartup;
 assert.equal(f.broker.services.get(ID),f.instances[1]);assert.deepEqual(disposeReasons,[[0,"disable"]]);assert.equal(f.broker.backgroundErrors.has(ID),false);
});
test("failed native cleanup blocks replacement and retries the same service before revocation",async t=>{
 let attempts=0;const f=fixture(t,{create:()=>({startBackground(){},call(){return true;},dispose(){attempts++;if(attempts===1)throw Error("synthetic managed node still running");}})});
 await f.broker.startInstalledBackground(f.manager);await assert.rejects(f.broker.close(ID,{reason:"disable"}),/still running/);
 await assert.rejects(f.broker.featureCall(ID,"fixture.read",{}),/closing|cleanup|stop/i);assert.equal(f.instances.length,1);
 await f.broker.close(ID,{reason:"disable"});assert.equal(attempts,2);f.manager.change(ID,"disable");await f.broker.startInstalledBackground(f.manager);assert.equal(f.instances.length,1);
});
