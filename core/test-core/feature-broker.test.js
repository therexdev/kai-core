"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { FeatureServices } = require("../../electron/plugin-services");
const contracts = require("../lib/plugins/contracts.json");
test("private feature broker requires exact plugin identity, publisher and operation grant", async () => {
  let created=0, called=0;
  const broker=new FeatureServices({}, {publishers:[{id:"kai.brain",fingerprint:"trusted"}], definitions:{"kai.brain":{permissions:{"brain.list":"brain.read"},factory:{create(){created++;return{call(){called++;return "private";}};}}}}});
  const record={manifest:{id:"kai.brain",permissions:["brain.read"]},fingerprint:"trusted",controller:new AbortController()};
  for(const wrong of [{...record,fingerprint:"other"},{...record,manifest:{id:"kai.assistant",permissions:["brain.read"]}},{...record,manifest:{id:"kai.brain",permissions:[]}}])await assert.rejects(broker.call(wrong,"brain.list",{}),/denied/);
  await assert.rejects(broker.call(record,"brain.delete",{}),/denied/);assert.equal(created,0);
  assert.equal(await broker.call(record,"brain.list",{}),"private");assert.equal(called,1);
  record.controller.abort();await assert.rejects(broker.call(record,"brain.list",{}),/closing/);
  await broker.dispose();assert.equal(created,1);
});
test("feature contracts match the exact exported service operations",()=>{for(const [id,spec] of Object.entries(contracts)){const service=require('../../electron/plugin-services/'+spec.module);assert.equal(service.pluginId,id);assert.deepEqual(spec.permissions,service.permissions);}});
test("shared encrypted companion writes cannot silently overwrite external changes", t=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'kai-feature-store-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
  const broker=new FeatureServices({dataDir,electron:{safeStorage}});const store=broker.getCompanionStore();
  store.note({title:'Before',text:'Saved memory'});assert.equal(broker.getCompanionStore(),store);
  const file=path.join(dataDir,'companion-hub.json');fs.writeFileSync(file,'external-change');
  assert.throws(()=>store.note({title:'After',text:'Do not overwrite'}),/changed outside/);
  assert.throws(()=>broker.getCompanionStore(),/changed outside/);assert.equal(fs.readFileSync(file,'utf8'),'external-change');
});
test("closing a feature waits for native teardown before a replacement can start", async () => {
  let release, disposed = false;
  const broker = new FeatureServices({}, { publishers: [{ id: "kai.fixture", fingerprint: "trusted" }], definitions: { "kai.fixture": {
    permissions: { "fixture.status": "fixture.read" }, factory: { create: () => ({ call: () => true,
      dispose: async () => { await new Promise(resolve => { release = resolve; }); disposed = true; } }) }
  } } });
  const record = { manifest: { id: "kai.fixture", permissions: ["fixture.read"] }, fingerprint: "trusted", controller: new AbortController() };
  await broker.call(record, "fixture.status");
  const closing = broker.close("kai.fixture");
  assert.equal(broker.close("kai.fixture"), closing);
  await assert.rejects(broker.call(record, "fixture.status"), /closing/);
  assert.equal(disposed, false); release(); await closing; assert.equal(disposed, true);
  assert.equal(broker.closeTasks.size, 0); await broker.dispose();
});
test("privacy changes await every active native service even when one fails", async () => {
  const broker = new FeatureServices({}); const modes = [];
  broker.services.set("first", { privacyChanged: mode => { modes.push(mode); throw Error("stop failed"); } });
  broker.services.set("second", { privacyChanged: async mode => { await Promise.resolve(); modes.push(mode); } });
  await assert.rejects(broker.privacyChanged("local-only"), /stop failed/);
  assert.deepEqual(modes, ["local-only", "local-only"]);
  await broker.dispose();
});
test("native cleanup failure is reported once before shutdown completes", async () => {
  let reports = 0, release;
  const broker = new FeatureServices({ onDisposeError: async id => { assert.equal(id, "kai.fixture"); reports++; await new Promise(resolve => { release = resolve; }); } });
  broker.services.set("kai.fixture", { dispose: () => { throw Error("Native service still running"); } });
  const closing = broker.close("kai.fixture"); assert.equal(broker.close("kai.fixture"), closing);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(reports, 1); assert.equal(broker.closing.has("kai.fixture"), true);
  release(); await assert.rejects(closing, /still running/); await broker.dispose(); assert.equal(reports, 1);
});
