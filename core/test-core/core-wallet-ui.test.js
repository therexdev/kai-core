"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { amount, atomAmount, validateSummary, validateHistory, createController } = require("../../ui-core/wallet");
const NOW = 1800000000000, ADDRESS = "1SyntheticWallet";
const summary = (extra = {}) => ({ address: ADDRESS, network: "mainnet", tokenSymbol: "KOIN", koin: "12345.67890123", vhp: "0", mana: "12.5", observedAt: NOW, ...extra });
const row = (id = "a") => ({ id: "0x1220" + id.repeat(64), kind: "transaction", label: "Received", status: "confirmed", timestamp: NOW - 10000, height: "100", counterparty: "sender", changes: [{ asset: "KOIN", direction: "in", amount: "250000000" }] });
const history = (extra = {}) => ({ address: ADDRESS, network: "mainnet", tokenSymbol: "KOIN", available: true, observedAt: NOW, rows: [row()], nextCursor: null, ...extra });
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; };
function fixture() {
  let clock = NOW, summaryValue = summary(), historyValue = history(), actionHandler = async () => ({}), serial = 0, clears = 0;
  const calls = [], timers = new Map(), renders = [];
  const controller = createController({ now: () => clock, setTimer(fn, delay) { const id = ++serial; timers.set(id, { fn, at: clock + delay }); return id; }, clearTimer(id) { timers.delete(id); }, clearSecrets() { clears++; }, render(state, view) { renders.push({ state: structuredClone(state), view }); },
    async call(method, input) { calls.push({ method, input }); const value = method === "wallet.summary" ? summaryValue : method === "wallet.history" ? historyValue : actionHandler(method, input); if (value instanceof Error) throw value; return await value; }
  });
  return { controller, calls, timers, renders, latest: () => renders.at(-1), clears: () => clears,
    setSummary(v) { summaryValue = v; }, setHistory(v) { historyValue = v; }, action(v) { actionHandler = v; },
    async enter(wallet = { exists: true, address: ADDRESS, unlocked: false }, privacy = "online") { controller.observe(wallet, privacy); controller.enter(); await flush(); },
    async advance(ms) { clock += ms; for (const [id, task] of [...timers]) if (task.at <= clock && timers.delete(id)) task.fn(); await flush(); }
  };
}

test("wallet values preserve all eight decimals and large atomic amounts", () => {
  assert.equal(amount("12345.67890123"), "12,345.67890123");
  assert.equal(amount("0.00000001"), "0.00000001");
  assert.equal(atomAmount("18446744073709551615"), "184,467,440,737.09551615");
  for (const value of [null, undefined, "-1", "1e8", "0.000000001", 1]) assert.equal(amount(value), "—");
  assert.equal(amount("0"), "0");
});

test("locked wallet reads balances and history without unlock, signing, or backups", async () => {
  const f = fixture(); await f.enter();
  assert.deepEqual(f.calls.map(c => c.method), ["wallet.summary", "wallet.history"]);
  assert.equal(f.latest().state.summary.koin, "12345.67890123");
  assert.equal(f.latest().state.rows.length, 1); assert.equal(f.latest().view.canSend, false);
  f.controller.leave(); assert.equal(f.timers.size, 0);
});

test("AI Local-Only leaves wallet reads, verified values and unlocked send controls available", async () => {
  const f = fixture(); await f.enter(undefined, "local-only");
  assert.deepEqual(f.calls.map(c => c.method), ["wallet.summary", "wallet.history"]); assert.equal(f.latest().view.canSend, false);
  f.controller.observe({ exists: true, address: ADDRESS, unlocked: true }, "online"); await flush();
  const count = f.calls.length; f.controller.observe({ exists: true, address: ADDRESS, unlocked: true }, "local-only"); await flush();
  assert.equal(f.calls.length, count); assert.equal(f.latest().state.summary.koin, "12345.67890123"); assert.equal(f.latest().state.rows.length, 1); assert.equal(f.latest().view.canSend, true);
  f.action(async () => ({ state: "cancelled" }));
  await f.controller.perform("wallet.send", { token: "koin", to: "recipient", amount: "1", password: "fixture-password" });
  assert.equal(f.calls.at(-1).method, "wallet.send"); assert.equal(f.controller.snapshot().privacyMode, "local-only");
});

test("late summary cannot replace a different wallet or resurrect hidden data", async () => {
  const f = fixture(), slow = deferred(); f.setSummary(slow.promise); await f.enter();
  f.setSummary(summary({ address: "next-wallet" })); f.setHistory(history({ address: "next-wallet" }));
  f.controller.observe({ exists: true, address: "next-wallet", unlocked: false }, "online"); await flush();
  slow.resolve(summary()); await flush(); assert.equal(f.latest().state.summary.address, "next-wallet");
  const later = deferred(); f.setSummary(later.promise); void f.controller.refresh(); await flush(); f.controller.leave();
  later.resolve(summary({ address: "next-wallet", koin: "999" })); await flush();
  assert.equal(f.controller.snapshot().summary.koin, "12345.67890123"); assert.equal(f.timers.size, 0);
});

test("summary failure keeps labeled prior values but disables send; first failure is unknown", async () => {
  const f = fixture(); await f.enter({ exists: true, address: ADDRESS, unlocked: true });
  f.setSummary(Error("RPC unavailable")); await f.controller.refresh();
  assert.equal(f.latest().state.summary.koin, "12345.67890123"); assert.match(f.latest().state.balanceError, /RPC unavailable/); assert.equal(f.latest().view.canSend, false);
  const first = fixture(); first.setSummary(Error("RPC unavailable")); await first.enter();
  assert.equal(first.latest().state.summary, null); assert.equal(first.calls.length, 1);
});

test("wallet/network mismatches and invalid financial values are rejected", () => {
  for (const patch of [{ address: "other" }, { network: "harbinger" }, { tokenSymbol: "tKOIN" }, { observedAt: NOW - 60001 }, { observedAt: NOW + 5001 }, { koin: "-1" }, { koin: "184467440737.09551616" }, { mana: "unknown" }]) assert.throws(() => validateSummary(summary(patch), ADDRESS, NOW));
  for (const patch of [{ network: "harbinger" }, { tokenSymbol: "VHP" }, { address: "other" }, { observedAt: NOW - 60001 }, { rows: [{ ...row(), changes: [{ asset: "KOIN", direction: "in", amount: "18446744073709551616" }] }] }]) assert.throws(() => validateHistory(history(patch), summary(), NOW));
});

test("older history deduplicates transactions; automatic balance polling preserves expanded history", async () => {
  const f = fixture(); f.setHistory(history({ nextCursor: "older" })); await f.enter();
  f.setHistory(history({ rows: [row(), row("b")], nextCursor: "even-older" })); await f.controller.refresh(true);
  assert.deepEqual(f.calls.at(-1).input, { cursor: "older" }); assert.equal(f.latest().state.rows.length, 2); assert.equal(f.latest().state.expanded, true);
  const historyCalls = f.calls.filter(c => c.method === "wallet.history").length;
  await f.controller.refresh(false, true); assert.equal(f.calls.filter(c => c.method === "wallet.history").length, historyCalls);
  f.setHistory(history()); await f.controller.refresh(); assert.equal(f.latest().state.rows.length, 1); assert.equal(f.latest().state.expanded, false);
});

test("network change clears older rows before replacement history and secrets", async () => {
  const f = fixture(); await f.enter(); const before = f.clears();
  f.setSummary(summary({ network: "harbinger", tokenSymbol: "tKOIN" })); f.setHistory(Error("History offline")); await f.controller.refresh();
  assert.equal(f.latest().state.summary.network, "harbinger"); assert.deepEqual(f.latest().state.rows, []); assert.ok(f.clears() > before);
});

test("send uses exact reviewed amount, wallet and network and reports native cancellation", async () => {
  const f = fixture(); await f.enter({ exists: true, address: ADDRESS, unlocked: true });
  f.action(async () => ({ state: "cancelled" }));
  await f.controller.perform("wallet.send", { token: "koin", to: "recipient", amount: "0.01000000", password: "fixture-password" });
  assert.deepEqual(f.calls.at(-1), { method: "wallet.send", input: { token: "koin", to: "recipient", amount: "0.01000000", password: "fixture-password", expectedAddress: ADDRESS, expectedNetwork: "mainnet" } });
  assert.match(f.latest().state.notice, /cancelled/); assert.equal(f.latest().state.busy, false);
});

test("blur fences late backup reveal without cancelling an approved native send", async () => {
  const f = fixture(); await f.enter({ exists: true, address: ADDRESS, unlocked: true });
  const reveal = deferred(); f.action(() => reveal.promise); const pending = f.controller.perform("wallet.reveal", { password: "fixture-password" });
  f.controller.clearSecrets(); reveal.resolve({ wif: "synthetic-key" }); assert.equal(await pending, null);
  const send = deferred(); f.action(() => send.promise); const sending = f.controller.perform("wallet.send", { token: "koin", to: "recipient", amount: "1", password: "fixture-password" });
  f.controller.clearSecrets(); send.resolve({ state: "cancelled" }); assert.equal((await sending).state, "cancelled");
  assert.ok(!JSON.stringify(f.controller.snapshot()).includes("fixture-password"));
});

test("leaving or relocking fences late backup reveal and no repeated action races", async () => {
  for (const exit of [f => f.controller.leave(), f => f.controller.observe({ exists: true, address: ADDRESS, unlocked: false }, "online")]) {
    const f = fixture(); await f.enter({ exists: true, address: ADDRESS, unlocked: true });
    const value = deferred(); f.action(() => value.promise); const pending = f.controller.perform("wallet.reveal", { password: "fixture-password" });
    assert.equal(await f.controller.perform("wallet.reveal", { password: "fixture-password" }), null);
    exit(f); value.resolve({ wif: "synthetic-key" }); assert.equal(await pending, null);
  }
});

test("timed out read releases loading state and cannot overwrite a newer refresh", async () => {
  const f = fixture(), slow = deferred(); f.setSummary(slow.promise); await f.enter();
  await f.advance(20001); assert.equal(f.latest().state.loading, false); assert.match(f.latest().state.balanceError, /timed out/);
  f.setSummary(summary({ koin: "7", observedAt: NOW + 20001 })); f.setHistory(history({ observedAt: NOW + 20001 })); await f.controller.refresh();
  slow.resolve(summary({ koin: "999" })); await flush(); assert.equal(f.latest().state.summary.koin, "7");
});

test("Send All binds the filled amount to the selected token, wallet and network", async () => {
  const f = fixture(); await f.enter({ exists: true, address: ADDRESS, unlocked: true });
  f.action(async () => ({ address: ADDRESS, network: "mainnet", token: "vhp", amount: "184467440737.09551615", observedAt: NOW }));
  assert.equal((await f.controller.perform("wallet.maxSend", { token: "vhp" })).amount, "184467440737.09551615");
  assert.deepEqual(f.calls.at(-1).input, { token: "vhp", expectedAddress: ADDRESS, expectedNetwork: "mainnet" });
  for (const patch of [{ token: "koin" }, { network: "harbinger" }, { observedAt: NOW - 30001 }, { amount: "1e10" }, { address: "other" }]) {
    f.action(async () => ({ address: ADDRESS, network: "mainnet", token: "vhp", amount: "1", observedAt: NOW, ...patch }));
    assert.equal(await f.controller.perform("wallet.maxSend", { token: "vhp" }), null);
  }
  assert.equal(f.calls.filter(c => c.method === "wallet.send").length, 0);
});
