"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createController, formatBytes, resultDetails } = require("../../ui-core/alpha-migration");
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const inventory = () => ({ source: { label: "Koinos AI Alpha", path: "/alpha/profile" }, models: { available: true, count: 2, bytes: 4096 }, wallet: { available: true, address: "alpha-address" } });
function fixture(overrides = {}) {
  const calls = [], renders = [], completed = [], timers = new Map(); let serial = 0;
  const responses = { "migration.status": { phase: "idle" }, "migration.scan": inventory(), "migration.chooseSource": null, "migration.start": { phase: "running", progress: { completedBytes: 0, totalBytes: 4096 } }, "migration.cancel": { phase: "running" }, ...overrides };
  const controller = createController({
    async call(method, input) { calls.push({ method, input }); const response = responses[method]; if (response instanceof Error) throw response; return typeof response === "function" ? response(input) : await response; },
    render: (state, view) => renders.push({ state, view }), onComplete: result => completed.push(result),
    setTimer(fn) { const id = ++serial; timers.set(id, fn); return id; }, clearTimer(id) { timers.delete(id); }
  });
  return { controller, calls, renders, completed, timers, responses, latest: () => renders.at(-1), async tick() { const pending = [...timers]; timers.clear(); for (const [, run] of pending) run(); await flush(); } };
}

test("migration defaults to available items and sends only the selected booleans", async () => {
  for (const selection of [{ models: true, wallet: false }, { models: false, wallet: true }, { models: true, wallet: true }]) {
    const f = fixture(); await f.controller.open();
    assert.deepEqual(f.controller.snapshot().selected, { models: true, wallet: true });
    for (const key of ["models", "wallet"]) f.controller.select(key, selection[key]);
    await f.controller.start();
    assert.deepEqual(f.calls.find(c => c.method === "migration.start"), { method: "migration.start", input: selection });
    assert.equal(f.controller.view().busy, true);
    f.controller.dispose();
  }
});

test("a missing source, no selection, and an existing Core wallet cannot start a wallet migration", async () => {
  const source = inventory(); source.wallet.blocked = true;
  const f = fixture({ "migration.scan": source }); await f.controller.open();
  assert.deepEqual(f.controller.snapshot().selected, { models: true, wallet: false });
  f.controller.select("wallet", true); assert.equal(f.controller.snapshot().selected.wallet, false);
  f.controller.select("models", false); await f.controller.start(); assert.equal(f.calls.some(c => c.method === "migration.start"), false);
  f.controller.close(); f.responses["migration.scan"] = { ...inventory(), source: null }; await f.controller.open();
  assert.equal(f.controller.view().canStart, false); assert.deepEqual(f.controller.snapshot().selected, { models: false, wallet: false });
});

test("a native folder chooser cancellation preserves the detected profile and selection", async () => {
  const f = fixture(); await f.controller.open(); f.controller.select("wallet", false);
  await f.controller.chooseSource();
  assert.equal(f.controller.snapshot().inventory.source.path, "/alpha/profile");
  assert.deepEqual(f.controller.snapshot().selected, { models: true, wallet: false });
  const next = inventory(); next.source.path = "/other/alpha"; next.models.available = false;
  f.responses["migration.chooseSource"] = next; await f.controller.chooseSource();
  assert.equal(f.controller.snapshot().inventory.source.path, "/other/alpha");
  assert.deepEqual(f.controller.snapshot().selected, { models: false, wallet: true });
});

test("closing a scan fences late results and restores a fresh scan on reopening", async () => {
  const scan = deferred(), f = fixture({ "migration.scan": scan.promise });
  const opening = f.controller.open(); await flush(); assert.equal(f.controller.close(), true);
  f.responses["migration.scan"] = { ...inventory(), wallet: { available: false } }; await f.controller.open();
  scan.resolve(inventory()); await opening;
  assert.equal(f.controller.snapshot().selected.wallet, false);
});

test("a running migration prevents closing and waits for actual cancellation", async () => {
  const f = fixture(); await f.controller.open(); await f.controller.start();
  assert.equal(f.controller.close(), false);
  await f.controller.cancel();
  assert.equal(f.controller.snapshot().cancelling, true); assert.equal(f.controller.close(), false); assert.equal(f.completed.length, 0);
  f.responses["migration.status"] = { phase: "cancelled", result: { summary: "Stopped after copying one model." } }; await f.tick();
  assert.equal(f.controller.view().busy, false); assert.equal(f.controller.snapshot().lastResult, "Stopped after copying one model.");
  assert.equal(f.completed.length, 1); assert.equal(f.timers.size, 0); assert.equal(f.controller.close(), true);
});

test("start and cancel requests cannot be repeated while pending", async () => {
  const start = deferred(), cancel = deferred(), f = fixture({ "migration.start": start.promise, "migration.cancel": cancel.promise });
  await f.controller.open(); const pending = f.controller.start(); await f.controller.start(); await f.controller.cancel();
  assert.equal(f.calls.filter(c => c.method === "migration.start").length, 1);
  assert.equal(f.calls.filter(c => c.method === "migration.cancel").length, 0);
  start.resolve({ phase: "running" }); await pending; const cancelling = f.controller.cancel(); await f.controller.cancel();
  assert.equal(f.calls.filter(c => c.method === "migration.cancel").length, 1);
  cancel.resolve({ phase: "cancelled" }); await cancelling;
});

test("polling is serial, completes once, and ignores an older running response after cancellation", async () => {
  const f = fixture(); await f.controller.open(); await f.controller.start();
  const status = deferred(); f.responses["migration.status"] = status.promise; await f.tick(); assert.equal(f.timers.size, 0);
  f.responses["migration.cancel"] = { phase: "cancelled", result: { summary: "Cancelled." } }; await f.controller.cancel();
  status.resolve({ phase: "running" }); await flush();
  assert.equal(f.controller.snapshot().job.phase, "cancelled"); assert.equal(f.completed.length, 1); assert.equal(f.timers.size, 0);
});

test("reopening during a backend migration restores progress without scanning or starting another job", async () => {
  const f = fixture({ "migration.status": { phase: "running", source: { path: "/alpha/running" }, selected: { models: true, wallet: false }, progress: { completedBytes: 32, totalBytes: 100 } } });
  await f.controller.open();
  assert.deepEqual(f.calls.map(c => c.method), ["migration.status"]);
  assert.equal(f.controller.snapshot().job.source.path, "/alpha/running");
  assert.equal(f.controller.snapshot().job.progress.completedBytes, 32); assert.equal(f.controller.close(), false);
  await f.controller.start(); assert.equal(f.calls.some(c => c.method === "migration.start"), false); f.controller.dispose();
});

test("temporary status errors retain the running job and retry instead of reporting success", async () => {
  const f = fixture(); await f.controller.open(); await f.controller.start();
  f.responses["migration.status"] = Error("Disk busy"); await f.tick();
  assert.equal(f.controller.view().busy, true); assert.match(f.controller.snapshot().error, /Disk busy/); assert.equal(f.timers.size, 1); assert.equal(f.completed.length, 0);
  f.responses["migration.status"] = { phase: "complete", result: { summary: "Copied 2 models and the encrypted wallet." } }; await f.tick();
  assert.equal(f.controller.snapshot().error, ""); assert.equal(f.completed.length, 1); assert.equal(f.timers.size, 0);
});

test("a start transport error recovers the real job before allowing another migration", async () => {
  const f = fixture({ "migration.start": Error("Connection interrupted") }); await f.controller.open();
  f.responses["migration.status"] = { phase: "running" }; await f.controller.start();
  assert.equal(f.controller.view().busy, true); assert.equal(f.controller.view().canStart, false); f.controller.dispose();
  const uncertain = fixture({ "migration.start": Error("Connection interrupted") }); await uncertain.controller.open();
  uncertain.responses["migration.status"] = Error("Temporarily unavailable"); await uncertain.controller.start();
  assert.equal(uncertain.controller.view().busy, true);
  uncertain.responses["migration.status"] = { phase: "idle" }; await uncertain.tick();
  assert.equal(uncertain.controller.view().busy, false); assert.equal(uncertain.controller.view().canStart, true);
});

test("failed migrations expose the backend reason and preserve partial results", async () => {
  const f = fixture(); await f.controller.open(); await f.controller.start();
  f.responses["migration.status"] = { phase: "failed", error: "Not enough free disk space.", result: { summary: "One model was copied; wallet was not copied." } }; await f.tick();
  assert.equal(f.controller.snapshot().error, "Not enough free disk space.");
  assert.equal(f.controller.snapshot().lastResult, "One model was copied; wallet was not copied.");
  assert.equal(f.controller.view().canStart, false); assert.equal(f.controller.close(), true); assert.equal(f.completed.length, 1);
});

test("byte sizes handle model-scale files without integer overflow", () => {
  assert.equal(formatBytes(1024 ** 3 * 12.5), "12.5 GB"); assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(NaN), ""); assert.equal(formatBytes(-1), "");
});

test("outcomes explain partial model copies, skipped files, warnings, and wallet results", () => {
  const detail = resultDetails({ phase: "failed", result: { models: { copied: 2, skipped: 1, failed: 1, warnings: ["A projector was skipped.", "A projector was skipped."], error: "File changed during copying." }, wallet: { copied: true, address: "alpha-address", detail: "Unlock it using your Alpha wallet password." } } });
  assert.match(detail.models, /2 files copied · 1 skipped · 1 failed/);
  assert.match(detail.models, /File changed during copying/); assert.equal(detail.models.split("A projector was skipped.").length, 2);
  assert.match(detail.wallet, /Wallet: copied/); assert.match(detail.wallet, /Address: alpha-address/); assert.match(detail.wallet, /Alpha wallet password/);
  assert.equal(resultDetails({ phase: "failed", result: { wallet: { copied: false, detail: "Wallet already exists.", error: "Wallet already exists." } } }).wallet, "Wallet: not copied.\nWallet already exists.");
  assert.equal(resultDetails({ phase: "cancelled", selected: { models: true, wallet: false }, result: {} }).models, "Models: copying did not begin.");
  assert.match(resultDetails({ phase: "failed", result: { models: { copied: 0, skipped: 0, error: "Disk unavailable." } } }).models, /copying stopped/);
});
