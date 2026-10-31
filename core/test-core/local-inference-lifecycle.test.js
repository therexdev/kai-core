"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http");
const { RuntimeManager } = require("../lib/runtime-manager");
const { Gateway } = require("../lib/gateway");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check, message = "condition not reached") {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), message);
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
function manager({ download, endpoint = "http://127.0.0.1:1", start } = {}) {
  const loads = [], starts = [], stops = [];
  const models = {
    resolveAlias: alias => ({ packageId: alias, contextSize: 4096, runtime: "llamacpp" }),
    ensurePackage: async (alias, options) => { loads.push(alias); if (download) await download(alias, options); return alias; },
  };
  const runtime = new RuntimeManager({ models, makeRuntime: () => {
    let running = false, alias;
    return { endpoint, status: () => ({ running, kind: "llamacpp" }),
      start: async options => { alias = options.modelPath; starts.push(alias); if (start) await start(options); running = true; },
      stop: () => { if (running) stops.push(alias); running = false; },
    };
  } });
  return { runtime, models, loads, starts, stops };
}

test("local requests are FIFO across plugins and models, including repeated requests for the active model", async () => {
  const f = manager(), first = await f.runtime.acquireFor("model-a");
  let secondReady = false, thirdReady = false;
  const second = f.runtime.acquireFor("model-b").then(lease => { secondReady = true; return lease; });
  const third = f.runtime.acquireFor("model-a").then(lease => { thirdReady = true; return lease; });
  await tick();
  assert.deepEqual(f.loads, ["model-a"]); assert.equal(f.runtime.status().inference.queued, 2);
  first.release(); const secondLease = await second;
  assert.equal(secondReady, true); assert.equal(thirdReady, false); assert.equal(f.runtime.activeAlias, "model-b");
  secondLease.release(); const thirdLease = await third;
  assert.deepEqual(f.starts, ["model-a", "model-b", "model-a"]);
  thirdLease.release(); assert.equal(f.runtime._inflight, 0); assert.equal(f.runtime.status().inference.queued, 0);
  await f.runtime.stop();
});

test("cancelling a queued request removes it without preparing or switching that model", async () => {
  const f = manager(), first = await f.runtime.acquireFor("model-a"), controller = new AbortController();
  const second = f.runtime.acquireFor("cancelled-model", { signal: controller.signal });
  const rejected = assert.rejects(second, { name: "AbortError" });
  controller.abort(); await rejected;
  const next = f.runtime.acquireFor("model-c"); first.release(); (await next).release();
  assert.deepEqual(f.starts, ["model-a", "model-c"]); await f.runtime.stop();
});

test("one caller cancelling a shared load preserves another caller and the last cancellation stops preparation", async () => {
  const gate = deferred(); let preparation;
  const f = manager({ download: (_alias, { signal }) => { preparation = signal; return abortable(gate.promise, signal); } });
  const a = new AbortController(), b = new AbortController();
  const first = f.runtime.ensure("model-a", { signal: a.signal }), second = f.runtime.ensure("model-a", { signal: b.signal });
  const firstRejected = assert.rejects(first, { name: "AbortError" });
  await until(() => preparation);
  a.abort(); await firstRejected; assert.equal(preparation.aborted, false);
  const secondRejected = assert.rejects(second, { name: "AbortError" });
  b.abort(); await secondRejected; await until(() => !f.runtime.status().loading);
  assert.equal(preparation.aborted, true); assert.equal(f.starts.length, 0);
  gate.resolve(); await f.runtime.ensure("model-a"); assert.deepEqual(f.starts, ["model-a"]);
  await f.runtime.stop();
});

test("a cancelled waiter for a different loading model never starts later", async () => {
  const gate = deferred(); const f = manager({ download: (alias, { signal }) => alias === "model-a" ? abortable(gate.promise, signal) : undefined });
  const first = f.runtime.ensure("model-a"), controller = new AbortController();
  const second = f.runtime.ensure("cancelled-model", { signal: controller.signal });
  const rejected = assert.rejects(second, { name: "AbortError" }); controller.abort(); await rejected;
  gate.resolve(); await first; await tick(); assert.deepEqual(f.loads, ["model-a"]); await f.runtime.stop();
});

test("a model switch timeout leaves the active answer running instead of killing its engine", async () => {
  const f = manager(), lease = await f.runtime.acquireFor("model-a"); f.runtime.drainMaxMs = 20;
  await assert.rejects(f.runtime.ensure("model-b"), error => error.code === "runtime_busy");
  assert.equal(f.runtime.activeAlias, "model-a"); assert.equal(f.runtime.runtime.status().running, true); assert.deepEqual(f.stops, []);
  assert.equal(f.runtime._drainWaiters.length, 0); lease.release(); await f.runtime.stop();
});

test("stopping during preparation aborts the load and does not let a later request revive it", async () => {
  const gate = deferred(); let signal;
  const f = manager({ download: (alias, options) => { if (alias === "old") { signal = options.signal; return abortable(gate.promise, signal); } } });
  const old = f.runtime.ensure("old"), rejected = assert.rejects(old, { name: "AbortError" });
  await until(() => signal); await f.runtime.stop();
  const fresh = f.runtime.ensure("new"); await rejected; gate.resolve(); await fresh;
  assert.deepEqual(f.starts, ["new"]); await f.runtime.stop();
});

test("stop fences a slot granted before acquireFor's first continuation, while fresh demand still works", async () => {
  const f = manager(), stale = f.runtime.acquireFor("old");
  const rejected = assert.rejects(stale, { name: "AbortError" });
  await f.runtime.stop(); await rejected;
  assert.deepEqual(f.starts, []); assert.equal(f.runtime.status().inference.activeAlias, null);
  const fresh = await f.runtime.acquireFor("new"); assert.deepEqual(f.starts, ["new"]); fresh.release(); await f.runtime.stop();
});

test("stop fences ensure waiting behind another load rather than reviving the stale requested model", async () => {
  const gate = deferred(); let loading;
  const f = manager({ download: (_alias, { signal }) => { loading = signal; return abortable(gate.promise, signal); } });
  const first = f.runtime.ensure("first"), firstRejected = assert.rejects(first, { name: "AbortError" });
  await until(() => loading);
  const stale = f.runtime.ensure("stale"), staleRejected = assert.rejects(stale, { name: "AbortError" });
  await f.runtime.stop(); await firstRejected; await staleRejected;
  assert.deepEqual(f.loads, ["first"]); assert.deepEqual(f.starts, []);
});

async function stack(t, { download } = {}) {
  const seen = [], held = [];
  const engine = http.createServer((req, res) => {
    let raw = ""; req.on("data", part => { raw += part; }); req.on("end", () => {
      const body = JSON.parse(raw); seen.push(body);
      if (body.messages?.[0]?.content === "hold") {
        held.push(res); res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
      } else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "complete" } }] })); }
    });
  });
  await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
  const f = manager({ endpoint: `http://127.0.0.1:${engine.address().port}`, download });
  const gateway = new Gateway({ port: 0, runtime: f.runtime, models: f.models, keys: { required: () => false } });
  await gateway.listen(); const url = `http://127.0.0.1:${gateway.port}/core/chat/completions`;
  t.after(async () => { await gateway.close(); await f.runtime.stop(); engine.closeAllConnections(); await new Promise(resolve => engine.close(resolve)); });
  const request = (model, content, signal) => fetch(url, { method: "POST", signal, headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify({ model, messages: [{ role: "user", content }], stream: true, kai_private_desktop: true }) });
  return { ...f, seen, held, request };
}

test("stopping a live SSE reply releases its model hold and lets the next plugin run", async t => {
  const f = await stack(t), response = await f.request("model-a", "hold"), reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
  const next = f.request("model-b", "next"); await until(() => f.runtime.status().inference.queued === 1);
  await reader.cancel(); reader.releaseLock();
  assert.equal((await (await next).json()).choices[0].message.content, "complete");
  await until(() => f.runtime._inflight === 0); assert.deepEqual(f.seen.map(x => x.model), ["model-a", "model-b"]);
});

test("a runtime disappearing mid-stream rejects the reply and releases the lease for a retry", async t => {
  const f = await stack(t), response = await f.request("model-a", "hold");
  const body = response.text(), rejected = assert.rejects(body);
  f.held[0].destroy(); await rejected; await until(() => f.runtime._inflight === 0);
  assert.equal((await (await f.request("model-a", "retry")).json()).choices[0].message.content, "complete");
});

test("disconnect before response headers cancels preparation and never sends an orphan completion", async t => {
  const gate = deferred(); let signal;
  const f = await stack(t, { download: (_alias, options) => { signal = options.signal; return abortable(gate.promise, signal); } });
  const controller = new AbortController(), pending = f.request("model-a", "cancel", controller.signal), rejected = assert.rejects(pending);
  await until(() => signal); controller.abort(); await rejected;
  await until(() => signal.aborted && !f.runtime.status().loading);
  gate.resolve(); await tick(); assert.equal(f.seen.length, 0); assert.equal(f.starts.length, 0);
  assert.equal(f.runtime._inflight, 0); assert.equal(f.runtime.status().inference.activeAlias, null);
});

test("disconnect while queued removes only that request, without running it after the active answer", async t => {
  const f = await stack(t), response = await f.request("model-a", "hold"), controller = new AbortController();
  const pending = f.request("model-b", "cancel", controller.signal), rejected = assert.rejects(pending);
  await until(() => f.runtime.status().inference.queued === 1); controller.abort(); await rejected;
  await until(() => f.runtime.status().inference.queued === 0); await response.body.cancel();
  await until(() => f.runtime._inflight === 0); assert.deepEqual(f.seen.map(x => x.model), ["model-a"]);
});
