"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createConnection, presentation } = require("../../ui-core/credit-connection");
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const calls = [], views = [];
  let info = { connected: false, address: "reviewed-wallet", walletUnlocked: true, state: "wallet-connection-required", canConnect: true, capabilityAvailable: true, freeAccess: true, detail: "Restore existing network credits" };
  let read = async () => info, result = async () => ({ state: "connected", address: info.address, sessionOnly: false });
  const c = createConnection({ read: () => { calls.push("read"); return read(); }, connect: () => { calls.push("connect"); return result(); }, refreshCredits: async () => { calls.push("refresh-credits"); info = { ...info, connected: true, state: "ready" }; }, navigate: page => calls.push(["navigate", page]), render: (state, view) => views.push({ state, view }) });
  return { c, calls, views, setInfo(value) { info = value; }, readWith(fn) { read = fn; }, connectWith(fn) { result = fn; } };
}
test("credit reconnect stays idle off-page and restores through explicit wallet proof only", async () => {
  const f = fixture(); assert.deepEqual(f.calls, []); f.c.observe({ address: "reviewed-wallet", unlocked: true }, "local-first"); assert.deepEqual(f.calls, []);
  await f.c.enter(); assert.deepEqual(f.calls, ["read"]); assert.equal(f.views.at(-1).view.label, "Restore wallet credits");
  await f.c.act(); assert.deepEqual(f.calls, ["read", "connect", "refresh-credits", "read"]); assert.equal(f.views.at(-1).view.visible, false);
});
test("a locked imported wallet goes to Wallet without creating a credit session", async () => {
  const f = fixture(); f.setInfo({ connected: false, address: "locked-wallet", state: "wallet-unlock-required", walletUnlocked: false, detail: "Unlock first" });
  await f.c.enter(); assert.equal(f.views.at(-1).view.label, "Unlock wallet"); await f.c.act(); assert.deepEqual(f.calls, ["read", ["navigate", "wallet"]]);
});
test("cancelling native connection review does not report restored credits or fetch a paid balance", async () => {
  const f = fixture(); f.connectWith(async () => ({ state: "cancelled" })); await f.c.enter(); await f.c.act();
  assert.ok(!f.calls.includes("refresh-credits")); assert.equal(f.c.snapshot().error, ""); assert.equal(f.views.at(-1).view.visible, true);
});
test("a mismatched wallet/session reply cannot refresh or claim another credit balance", async () => {
  for (const result of [{ state: "connected", address: "other", sessionOnly: false }, { state: "connected", address: "reviewed-wallet", sessionOnly: true }]) {
    const f = fixture(); f.connectWith(async () => result); await f.c.enter(); await f.c.act(); assert.ok(!f.calls.includes("refresh-credits")); assert.match(f.c.snapshot().error, /not confirmed/);
  }
});
test("wallet/lock changes invalidate late reads and refresh readiness for the new wallet", async () => {
  const f = fixture(), gate = deferred(); f.readWith(() => gate.promise); const first = f.c.enter();
  f.readWith(async () => ({ connected: false, address: "new-wallet", walletUnlocked: false, state: "wallet-unlock-required" }));
  f.c.observe({ address: "new-wallet", unlocked: false }, "local-first"); await tick(); gate.resolve({ connected: true, address: "old-wallet", state: "ready" }); await first;
  assert.equal(f.c.snapshot().info.address, "new-wallet"); assert.equal(f.views.at(-1).view.action, "wallet");
});
test("concurrent clicks and refreshes cannot create overlapping wallet reviews", async () => {
  const f = fixture(), gate = deferred(); f.connectWith(() => gate.promise); await f.c.enter(); const first = f.c.act(); await tick();
  await f.c.act(); await f.c.refresh(); assert.equal(f.calls.filter(c => c === "connect").length, 1); assert.equal(f.calls.filter(c => c === "read").length, 1);
  gate.resolve({ state: "connected", address: "reviewed-wallet", sessionOnly: false }); await first; assert.equal(f.c.snapshot().busy, false);
});
test("leaving a page rejects stale read output and approved restoration still refreshes shared credit state", async () => {
  const f = fixture(), read = deferred(); f.readWith(() => read.promise); const pending = f.c.enter(); f.c.leave(); read.resolve({ connected: true, address: "old-wallet", state: "ready" }); await pending; assert.equal(f.c.snapshot().info, null);
  f.readWith(async () => ({ connected: false, address: "reviewed-wallet", canConnect: true, state: "wallet-connection-required" })); await f.c.enter(); const connect = deferred(); f.connectWith(() => connect.promise); const connection = f.c.act(); f.c.leave();
  connect.resolve({ state: "connected", address: "reviewed-wallet", sessionOnly: false }); await connection; assert.ok(f.calls.includes("refresh-credits")); assert.equal(f.c.snapshot().active, false);
});
test("identity conflicts point to existing account settings, while free-only guests need no extra setup", () => {
  assert.equal(presentation({ info: { connected: true, address: "wallet", state: "wallet-changed", detail: "Saved account preserved" } }).action, "account");
  assert.equal(presentation({ info: { connected: false, address: null, state: "free-ready" } }).visible, false);
  assert.equal(presentation({ info: { connected: false, address: "wallet", state: "online-required" } }).action, "settings");
  assert.equal(presentation({ info: { connected: true, address: "wallet", state: "ready", canConnect: true, capabilityAvailable: false, sessionOnly: true, walletUnlocked: true } }).action, "connect");
});
test("network failures are visible and do not erase or replace saved credit authority", async () => {
  const f = fixture(); f.readWith(async () => { throw Error("Credit service unavailable"); }); await f.c.enter(); assert.match(f.c.snapshot().error, /unavailable/); assert.equal(f.views.at(-1).view.action, "refresh"); assert.ok(!f.calls.includes("connect"));
});
