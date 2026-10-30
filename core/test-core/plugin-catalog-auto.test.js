"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { createCatalogMonitor, CHECK_INTERVAL, RETRY_INTERVAL, WAKE_THROTTLE, BUSY_RETRY, REQUEST_TIMEOUT } = require("../../electron/core-plugin-catalog");
const tick = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function fixture({ localOnly = false, refresh } = {}) {
  let time = 100000, busy = false, nextTimer = 0;
  const timers = new Map(), calls = [], changes = [];
  const cached = { available: true, version: "0.1.1", sequence: 2 };
  const registry = { async refresh(options) { calls.push({ options, at: time }); if (refresh) return refresh(options, cached); return { ...cached }; } };
  const monitor = createCatalogMonitor({ registry, isLocalOnly: () => localOnly, isBusy: () => busy, now: () => time,
    setTimer(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimer(id) { timers.delete(id); }, onChange(value) { changes.push(value); } });
  async function advance(ms) {
    const target = time + ms;
    for (let i = 0; i < 100; i++) {
      const found = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!found) { time = target; await tick(); return; }
      time = found[1].at; timers.delete(found[0]); found[1].fn(); await tick();
    }
    throw Error("Timer loop exceeded fixture limit");
  }
  return { monitor, calls, changes, cached, timers, advance, now: () => time, setBusy(value) { busy = value; }, async privacy(value) { localOnly = value; const pending = monitor.privacyChanged(); await tick(); return pending; } };
}

test("construction is idle, startup checks signed catalog and regular polling continues without UI activity", async () => {
  const f = fixture(); assert.equal(f.calls.length, 0);
  await f.monitor.start(); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.localOnly, false); assert.ok(f.calls[0].options.signal instanceof AbortSignal);
  assert.equal(f.monitor.status().lastCheckedAt, f.now()); assert.equal(f.monitor.status().checking, false);
  assert.equal(f.monitor.status().nextCheckAt, f.now() + CHECK_INTERVAL);
  await f.advance(CHECK_INTERVAL - 1); assert.equal(f.calls.length, 1);
  await f.advance(1); assert.equal(f.calls.length, 2);
  await f.monitor.dispose(); assert.equal(f.timers.size, 0);
});

test("focus and Plugins wake checks are throttled, while an explicit refresh bypasses the throttle", async () => {
  const f = fixture(); await f.monitor.start();
  for (let i = 0; i < 3; i++) await f.monitor.wake();
  assert.equal(f.calls.length, 1); assert.equal(f.monitor.status().nextCheckAt, f.now() + CHECK_INTERVAL);
  await f.advance(WAKE_THROTTLE); await f.monitor.wake(); assert.equal(f.calls.length, 2);
  await f.monitor.refresh(); assert.equal(f.calls.length, 3);
  await f.monitor.dispose();
});

test("manual and automatic checks share one in-flight registry writer", async () => {
  const read = deferred(), f = fixture({ refresh: () => read.promise });
  const startup = f.monitor.start(); await tick();
  const manual = f.monitor.refresh(), wake = f.monitor.wake();
  assert.equal(f.monitor.status().checking, true); assert.equal(f.calls.length, 1);
  read.resolve({ available: true, sequence: 3 });
  assert.equal((await manual).sequence, 3); await startup; await wake;
  assert.deepEqual(f.changes.map(value => value.checking), [true, false]);
  await f.monitor.dispose();
});

test("failed automatic checks keep the verified cache and retry after five minutes", async () => {
  let fail = true;
  const f = fixture({ refresh: async (_options, cached) => { if (fail) throw Error("Registry signature rejected"); return { ...cached }; } });
  await f.monitor.start();
  assert.equal(f.cached.sequence, 2); assert.equal(f.monitor.status().lastCheckedAt, null); assert.match(f.monitor.status().error, /signature/);
  await f.advance(WAKE_THROTTLE); await f.monitor.wake(); assert.equal(f.calls.length, 1, "window focus must not accelerate a failed check");
  fail = false; await f.advance(RETRY_INTERVAL - WAKE_THROTTLE); assert.equal(f.calls.length, 2);
  assert.equal(f.monitor.status().error, null); assert.equal(f.monitor.status().lastCheckedAt, f.now());
  assert.equal(f.monitor.status().nextCheckAt, f.now() + CHECK_INTERVAL); await f.monitor.dispose();
});

test("manual failures propagate for the existing dismissible message without clearing catalog data", async () => {
  const f = fixture({ refresh: async () => { throw Error("Offline"); } });
  await assert.rejects(f.monitor.refresh(), /Offline/); assert.equal(f.cached.available, true);
  assert.equal(f.monitor.status().checking, false); await f.monitor.dispose();
});

test("installation pauses background checks and manual checks cannot race an install", async () => {
  const f = fixture(); f.setBusy(true); await f.monitor.start();
  assert.equal(f.calls.length, 0); assert.equal(f.monitor.status().nextCheckAt, f.now() + BUSY_RETRY);
  await assert.rejects(f.monitor.refresh(), /installation/);
  await f.advance(BUSY_RETRY); assert.equal(f.calls.length, 0);
  f.setBusy(false); await f.advance(BUSY_RETRY); assert.equal(f.calls.length, 1);
  await f.monitor.dispose();
});

test("install waitForIdle joins the active check but never starts another download", async () => {
  const read = deferred(), f = fixture({ refresh: () => read.promise });
  const check = f.monitor.start(); await tick(); f.setBusy(true);
  let ready = false; const idle = f.monitor.waitForIdle().then(() => { ready = true; });
  await tick(); assert.equal(ready, false); read.reject(Error("Offline")); await check; await idle;
  assert.equal(ready, true); assert.equal(f.calls.length, 1);
  await f.monitor.waitForIdle(); assert.equal(f.calls.length, 1); await f.monitor.dispose();
});

test("Local-Only startup never schedules or contacts registry; returning online checks immediately", async () => {
  const f = fixture({ localOnly: true }); await f.monitor.start();
  assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.monitor.status().paused, true);
  await assert.rejects(f.monitor.refresh(), /Local-Only/);
  await f.privacy(false); assert.equal(f.calls.length, 1); assert.equal(f.monitor.status().paused, false);
  await f.privacy(true); assert.equal(f.timers.size, 0); await f.advance(CHECK_INTERVAL); assert.equal(f.calls.length, 1);
  await f.monitor.dispose();
});

test("privacy cancels pending writer and quick offline/online transition queues exactly one fresh check", async () => {
  const first = deferred(); let count = 0;
  const f = fixture({ refresh: async ({ signal }) => { count++; if (count === 1) { await first.promise; signal.throwIfAborted(); } return { available: true }; } });
  const startup = f.monitor.start(); await tick();
  await f.privacy(true); assert.equal(f.calls[0].options.signal.aborted, true);
  const online = f.privacy(false); await tick(); assert.equal(f.calls.length, 1);
  first.resolve(); await startup; await online; await f.advance(0);
  assert.equal(f.calls.length, 2); assert.equal(f.monitor.status().error, null);
  await f.monitor.dispose();
});

test("thirty-second deadline aborts the registry request and permits a bounded retry", async () => {
  const f = fixture({ refresh: ({ signal }) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }) });
  const startup = f.monitor.start(); await tick(); await f.advance(REQUEST_TIMEOUT); await startup;
  assert.equal(f.calls[0].options.signal.aborted, true); assert.match(f.monitor.status().error, /timed out/);
  assert.equal(f.monitor.status().nextCheckAt, f.now() + RETRY_INTERVAL); await f.monitor.dispose();
});

test("disposal aborts and waits for a late registry writer, then prevents all future work", async () => {
  const read = deferred(), f = fixture({ refresh: async ({ signal }) => { await read.promise; signal.throwIfAborted(); return {}; } });
  const startup = f.monitor.start(); await tick(); let complete = false;
  const disposal = f.monitor.dispose().then(() => { complete = true; }); await tick();
  assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(complete, false);
  read.resolve(); await startup; await disposal; assert.equal(complete, true); assert.equal(f.timers.size, 0);
  await f.monitor.wake(); await f.monitor.start(); await assert.rejects(f.monitor.refresh(), /closing/);
  assert.equal(f.calls.length, 1); await f.monitor.dispose();
});

test("an unavailable UI callback cannot hide a successful catalog refresh", async () => {
  const monitor = createCatalogMonitor({ registry: { refresh: async () => ({ version: "1.2.3" }) }, isLocalOnly: () => false, onChange() { throw Error("Window closed"); } });
  assert.equal((await monitor.start()).version, "1.2.3"); assert.equal(monitor.status().error, null); await monitor.dispose();
});
