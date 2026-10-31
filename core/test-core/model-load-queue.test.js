"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { ModelLoadQueue } = require("../lib/model-load-queue");
const { ModelManager } = require("../lib/model-manager");
const { JsonStore } = require("../lib/store");
const { Gateway } = require("../lib/gateway");

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function fixture() {
  const calls = [], work = new Map(), changes = [];
  const models = {
    progress: null, cancelled: 0,
    resolveAlias(alias) { if (!["a", "b", "c"].includes(alias)) throw Error("Unknown model"); return { packageId: `${alias}@1` }; },
    downloadProgress() { return this.progress; },
    cancelDownload() { this.cancelled++; const alias = this.progress.packageId.split("@")[0]; this.progress = null; work.get(alias).reject(new DOMException("Cancelled", "AbortError")); return { cancelled: true }; },
    aliases: () => [], storageUsage: () => ({}),
  };
  const runtime = { preflight: async () => {}, status: () => ({}), ensure: alias => { calls.push(alias); const d = deferred(); work.set(alias, d); return d.promise; } };
  const queue = new ModelLoadQueue({ models, runtime, onChange: job => changes.push({ alias: job.alias, state: job.state }) });
  const row = alias => queue.snapshot().find(job => job.alias === alias);
  return { models, runtime, queue, calls, work, changes, row };
}

test("model requests run FIFO, deduplicate clicks and expose per-model stages", async () => {
  const f = fixture();
  f.queue.enqueue("a"); f.queue.enqueue("b"); f.queue.enqueue("c");
  assert.equal(f.queue.enqueue("a").duplicate, true);
  assert.equal(f.queue.enqueue("b").duplicate, true);
  assert.equal(f.row("b").position, 1); assert.equal(f.row("c").position, 2);
  await tick(); assert.deepEqual(f.calls, ["a"]);
  f.models.progress = { packageId: "a@1", pct: 37 };
  assert.deepEqual(f.row("a"), { alias: "a", state: "downloading", pct: 37, error: null, cancellable: true });
  f.models.progress = null;
  assert.equal(f.row("a").state, "preparing"); assert.equal(f.row("a").cancellable, false);
  f.work.get("a").resolve(); await tick();
  assert.deepEqual(f.calls, ["a", "b"]); assert.equal(f.row("a").state, "done"); assert.equal(f.row("c").position, 1);
  f.work.get("b").resolve(); await tick(); f.work.get("c").resolve(); await tick();
  assert.deepEqual(f.calls, ["a", "b", "c"]); assert.ok(f.queue.snapshot().every(job => job.state === "done" && !job.cancellable && job.pct === null));
});

test("cancelling queued and active downloads advances remaining work without cancelling unrelated setup", async () => {
  const f = fixture(); f.queue.enqueue("a"); f.queue.enqueue("b"); f.queue.enqueue("c"); await tick();
  assert.equal(f.queue.cancel("b").cancelled, true); assert.equal(f.row("b").state, "cancelled"); assert.equal(f.row("c").position, 1);
  f.models.progress = { packageId: "different@1", pct: 70 };
  assert.equal(f.row("a").state, "preparing"); assert.equal(f.row("a").pct, null);
  assert.equal(f.queue.cancel("a").cancelled, false); assert.equal(f.models.cancelled, 0);
  f.models.progress = { packageId: "a@1#mmproj", pct: 20 };
  assert.equal(f.queue.cancel("a").cancelled, true);
  await tick(); assert.equal(f.row("a").state, "cancelled"); assert.deepEqual(f.calls, ["a", "c"]);
  assert.equal(f.row("c").pct, null); assert.equal(f.row("c").cancellable, false);
  f.work.get("c").resolve(); await tick();
  assert.equal(f.queue.cancel("c").cancelled, false); assert.equal(f.models.cancelled, 1);
});

test("a failed model does not strand the queue and can be retried once", async () => {
  const f = fixture(); f.queue.enqueue("a"); f.queue.enqueue("b"); await tick();
  f.work.get("a").reject(Error("Mirror unavailable")); await tick();
  assert.equal(f.row("a").state, "error"); assert.equal(f.row("a").error, "Mirror unavailable");
  assert.deepEqual(f.calls, ["a", "b"]);
  f.queue.enqueue("a"); assert.equal(f.row("a").state, "queued"); assert.equal(f.row("a").error, null);
  f.work.get("b").resolve(); await tick(); f.work.get("a").resolve(); await tick();
  assert.deepEqual(f.calls, ["a", "b", "a"]); assert.equal(f.row("a").state, "done");
});

test("shutdown cancels pending work before a finishing load can start another engine", async () => {
  const f = fixture(); f.queue.enqueue("a"); f.queue.enqueue("b"); await tick();
  f.queue.close(); f.work.get("a").resolve(); await tick();
  assert.deepEqual(f.calls, ["a"]); assert.equal(f.row("a").state, "cancelled"); assert.equal(f.row("b").state, "cancelled");
  assert.throws(() => f.queue.enqueue("c"), /stopping/);
  const g = fixture(); g.queue.enqueue("a"); g.queue.close(); await tick(); assert.deepEqual(g.calls, []);
  const h = fixture(), otherLoad = deferred();
  h.runtime._loading = { alias: "other", promise: otherLoad.promise };
  h.queue.enqueue("a"); await tick(); h.queue.close();
  h.runtime._loading = null; otherLoad.resolve(); await tick();
  assert.deepEqual(h.calls, [], "a job waiting for another caller must not begin after shutdown");
});

test("queued models are revalidated and migration is never mistaken for their download", async () => {
  const f = fixture(); f.queue.enqueue("a"); f.queue.enqueue("b"); await tick();
  f.models._alphaMigration = {}; f.models.progress = { phase: "copying", pct: 40 };
  assert.equal(f.queue.cancel("a").cancelled, false);
  assert.throws(() => f.queue.enqueue("c"), /migration/);
  f.work.get("a").resolve(); await tick();
  assert.deepEqual(f.calls, ["a"]); assert.equal(f.row("b").state, "error"); assert.match(f.row("b").error, /migration/);
});

test("gateway accepts multiple jobs, returns the queue and scopes cancellation by alias", async () => {
  const f = fixture(), gateway = new Gateway({ models: f.models, runtime: f.runtime });
  gateway.coreToken = null;
  async function request(url, body, method = "POST") {
    const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]); Object.assign(req, { url, method, headers: { host: `127.0.0.1:${gateway.port}` } });
    let status, result; const res = { setHeader() {}, writeHead(code) { status = code; }, end(data) { result = JSON.parse(data); } };
    await gateway._route(req, res); return { status, body: result };
  }
  assert.equal((await request("/core/models/ensure", { alias: "a" })).status, 202);
  assert.equal((await request("/core/models/ensure", { alias: "b" })).status, 202);
  const duplicate = await request("/core/models/ensure", { alias: "b" }); assert.equal(duplicate.body.started, false);
  const status = await request("/core/models", {}, "GET"); assert.equal(status.body.modelQueue.length, 2); assert.equal(status.body.ensure.state, "working");
  const cancelled = await request("/core/models/download/cancel", { alias: "b" }); assert.equal(cancelled.body.cancelled, true); assert.equal(cancelled.body.modelQueue.find(job => job.alias === "b").state, "cancelled");
  assert.equal((await request("/core/models/download/cancel", { alias: "unknown" })).body.cancelled, false); assert.equal(f.models.cancelled, 0);
  f.work.get("a").resolve(); await tick(); await gateway.close();
  assert.deepEqual(f.calls, ["a"]);
});

function realModels(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-queue-progress-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = Buffer.from("test model bytes"), sha256 = crypto.createHash("sha256").update(payload).digest("hex");
  const artifact = name => ({ filename: `${name}.gguf`, url: `https://models.test/${name}`, sha256, sizeBytes: payload.length });
  const catalogPath = path.join(root, "catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({ aliases: { a: { package: "a@1" }, b: { package: "b@1" } }, packages: { "a@1": { ...artifact("a"), mmproj: artifact("projector") }, "b@1": artifact("b") } }));
  const models = new ModelManager({ catalogPath, modelsDir: path.join(root, "models"), state: new JsonStore(path.join(root, "state.json"), {}) });
  return { models, payload, root };
}

test("real model and projector downloads reset stale progress at start and clear it after success or failure", async t => {
  const { models, payload } = realModels(t), starts = [];
  t.mock.method(global, "fetch", async url => { starts.push({ url, ...models.downloadProgress() }); return new Response(payload); });
  await models.ensurePackage("a@1"); assert.equal(models.downloadProgress(), null); assert.equal(models._progress, null);
  await models.ensureMmproj("a@1"); assert.equal(models.downloadProgress(), null);
  await models.ensurePackage("b@1"); assert.ok(starts.every(p => p.pct === 0 && p.done === 0));
  assert.deepEqual(starts.map(p => p.packageId), ["a@1", "a@1#mmproj", "b@1"]);
  fs.unlinkSync(models.packagePath("b@1"));
  t.mock.method(global, "fetch", async () => { throw Error("Offline"); });
  await assert.rejects(models.ensurePackage("b@1"), /Offline/); assert.equal(models.downloadProgress(), null); assert.equal(models._progress, null);
});

test("cancellation after verified download still stops the subsequent model load", async t => {
  const { models, payload } = realModels(t), originalRename = fs.renameSync;
  t.mock.method(global, "fetch", async () => new Response(payload));
  t.mock.method(fs, "renameSync", function (source, target) {
    originalRename(source, target);
    if (String(target).endsWith(".gguf")) models.cancelDownload();
  });
  await assert.rejects(models.ensurePackage("a@1"), { name: "AbortError" });
  assert.equal(models.packageStatus("a@1").status, "ready", "verified bytes can remain available without loading the cancelled model");
  assert.equal(models.downloadProgress(), null);
  await assert.rejects(models.ensureMmproj("a@1"), { name: "AbortError" });
  assert.equal(models.downloadProgress(), null);
});
