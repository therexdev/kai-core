"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { FeatureServices } = require("../../electron/plugin-services");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(create, ctx = {}) {
  const broker = new FeatureServices(ctx, { publishers: [{ id: "kai.fixture", fingerprint: "trusted" }], definitions: {
    "kai.fixture": { permissions: { "fixture.run": "fixture.write" }, factory: { create } },
  } });
  const record = () => ({ manifest: { id: "kai.fixture", permissions: ["fixture.write"] }, fingerprint: "trusted", controller: new AbortController() });
  return { broker, record };
}
test("closing before a queued private call prevents its service from executing", async () => {
  let calls = 0, disposed = 0;
  const f = fixture(() => ({ call() { calls++; }, dispose() { disposed++; } }));
  const pending = f.broker.call(f.record(), "fixture.run", {}), rejected = assert.rejects(pending, /closing/);
  await f.broker.close("kai.fixture"); await rejected;
  assert.equal(calls, 0); assert.equal(disposed, 1);
});
test("broker close aborts an active service signal without relying on its window", async () => {
  const started = deferred(); let signal;
  const f = fixture(() => ({ call(_method, _input, current) { signal = current; started.resolve(); return new Promise((resolve, reject) => current.addEventListener("abort", () => reject(Error("cancelled")), { once: true })); } }));
  const pending = f.broker.call(f.record(), "fixture.run", {}), rejected = assert.rejects(pending, /cancelled/);
  await started.promise; await f.broker.close("kai.fixture"); await rejected;
  assert.equal(signal.aborted, true);
});
test("a native confirmation resolving after close cannot authorize a mutation", async () => {
  const approval = deferred(), started = deferred(); let writes = 0;
  const f = fixture(ctx => ({ async call() { started.resolve(); if (await ctx.confirm("Write?", "Reviewed change")) writes++; return writes; } }), { confirm: () => approval.promise });
  const pending = f.broker.call(f.record(), "fixture.run", {}), rejected = assert.rejects(pending, /closing/);
  await started.promise; await f.broker.close("kai.fixture"); approval.resolve(true); await rejected;
  assert.equal(writes, 0);
});
test("private service results are suppressed after the caller aborts", async () => {
  const response = deferred(), started = deferred(), f = fixture(() => ({ call() { started.resolve(); return response.promise; } })), record = f.record();
  const pending = f.broker.call(record, "fixture.run", {}), rejected = assert.rejects(pending, /closing/);
  await started.promise; record.controller.abort(); response.resolve({ private: "late output" }); await rejected;
  await f.broker.dispose();
});
test("old service calls cannot outlive closing and reopening the same plugin", async () => {
  const response = deferred(), started = deferred(); let instances = 0;
  const f = fixture(() => { const generation = ++instances; return { call() { if (generation === 1) { started.resolve(); return response.promise; } return generation; } }; });
  const pending = f.broker.call(f.record(), "fixture.run", {}), rejected = assert.rejects(pending, /closing/);
  await started.promise; await f.broker.close("kai.fixture");
  assert.equal(await f.broker.call(f.record(), "fixture.run", {}), 2);
  response.resolve(1); await rejected; await f.broker.dispose();
});
test("new calls are blocked until the previous service finishes disposal", async () => {
  const disposal = deferred(); let instances = 0;
  const f = fixture(() => { instances++; return { call() { return true; }, dispose() { return disposal.promise; } }; });
  await f.broker.call(f.record(), "fixture.run", {});
  const closing = f.broker.close("kai.fixture");
  await assert.rejects(f.broker.call(f.record(), "fixture.run", {}), /closing/); assert.equal(instances, 1);
  disposal.resolve(); await closing;
});
test("closed services cannot reopen native dialogs or shared storage through retained context", async () => {
  let context, confirmations = 0;
  const f = fixture(ctx => { context = ctx; return { call() { return true; } }; }, { confirm() { confirmations++; return true; } });
  await f.broker.call(f.record(), "fixture.run", {}); await f.broker.close("kai.fixture");
  await assert.rejects(context.confirm("Late", "Late"), /closing/);
  assert.throws(() => context.getWindow(), /closing/); assert.throws(() => context.getCompanionStore(), /closing/); assert.equal(confirmations, 0);
});
test("service-owned inference is cancelled even when its caller omits a signal", async () => {
  const started = deferred(); let signal;
  const f = fixture(ctx => ({ call() { return ctx.localInference({ model: "local", prompt: "fixture" }); } }), {
    localInference(_input, current) { signal = current; started.resolve(); return new Promise((resolve, reject) => current.addEventListener("abort", () => reject(Error("inference cancelled")), { once: true })); },
  });
  const pending = f.broker.call(f.record(), "fixture.run", {}), rejected = assert.rejects(pending, /cancelled/);
  await started.promise; await f.broker.close("kai.fixture"); await rejected; assert.equal(signal.aborted, true);
});

test("closing a persistent plugin window retains its service, while explicit disable disposes it", async () => {
  let disposals=0, instances=0, current={id:1};
  const f=fixture(ctx=>{instances++;return {keepAliveOnWindowClose:true,call(){return ctx.getWindow().id;},dispose(){disposals++;}};},{getPluginWindow:()=>current});
  assert.equal(await f.broker.call(f.record(),'fixture.run',{}),1);
  await f.broker.detachWindow('kai.fixture');assert.equal(disposals,0);
  current={id:2};assert.equal(await f.broker.call(f.record(),'fixture.run',{}),2);assert.equal(instances,1);
  await f.broker.close('kai.fixture');assert.equal(disposals,1);await f.broker.dispose();
});
