"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { atoms, koinAmount, usdAmount, presentation, createController } = require("../../ui-core/sidebar-wallet");
const START = 1800000000000, ADDRESS = "fixture-wallet";
const balance = (extra = {}) => ({ address: ADDRESS, network: "mainnet", tokenSymbol: "KOIN", koin: "3732.80583588", observedAt: START, ...extra });
const quote = (extra = {}) => ({ estimate: { observedAt: START, expiresAt: START + 60000, priceDetails: { usdPerKoin: "0.03125" }, ...extra } });
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture() {
  let clock = START, serial = 0, summary = balance(), price = quote(); const calls = [], timers = new Map();
  const controller = createController({ now: () => clock, setTimer(fn, delay) { const id = ++serial; timers.set(id, { fn, at: clock + delay }); return id; }, clearTimer(id) { timers.delete(id); },
    call: async method => { calls.push(method); if (summary instanceof Error) throw summary; return typeof summary === "function" ? summary() : summary; },
    price: async () => { calls.push("price"); if (price instanceof Error) throw price; return typeof price === "function" ? price() : price; } });
  return { controller, calls, timers, setBalance(v) { summary = v; }, setPrice(v) { price = v; },
    view: () => presentation(controller.snapshot(), clock),
    async enter(privacy = "network") { controller.observe({ address: ADDRESS, unlocked: false }, privacy); await flush(); },
    async advance(ms) { clock += ms; for (const [id, t] of [...timers]) if (t.at <= clock && timers.delete(id)) t.fn(); await flush(); } };
}
test("sidebar amounts use exact integer arithmetic and localized display, including dust and zero", () => {
  assert.equal(atoms("3732.80583588"), 373280583588n);
  assert.equal(koinAmount("3732.80583588", "en"), "3,732.8058");
  assert.equal(koinAmount("0.00000001", "en"), "0.00000001");
  assert.equal(koinAmount("999.99999999", "en"), "1,000");
  assert.equal(usdAmount("3732.80583588", "0.03125", "en"), "$116.65");
  assert.equal(usdAmount("0", "0.03125", "en"), "$0.00");
  assert.match(usdAmount("3732.80583588", "0.03125", "de"), /^116,65/);
  for (const value of [null, "1e4", "-1", "0.000000001", "184467440737.09551616"]) assert.throws(() => atoms(value));
});
test("locked-wallet sidebar reads only liquid KOIN and a display price", async () => {
  const f = fixture(); await f.enter();
  assert.deepEqual(f.calls, ["wallet.summary", "price"]);
  assert.equal(f.view().koin, "3,732.8058"); assert.equal(f.view().usd, "$116.65");
  assert.equal(f.view().exact, "3732.80583588 KOIN"); f.controller.close();
});
test("Local-Only and testnet never fetch or display a mainnet USD estimate", async () => {
  const f = fixture(); await f.enter("local-only"); assert.deepEqual(f.calls, ["wallet.summary"]); assert.equal(f.view().usd, "—");
  f.controller.close();
  const g = fixture(); g.setBalance(balance({ network: "harbinger", tokenSymbol: "tKOIN" })); await g.enter();
  assert.deepEqual(g.calls, ["wallet.summary"]); assert.equal(g.view().symbol, "tKOIN"); assert.equal(g.view().usd, "—"); g.controller.close();
});
test("failed balance reads retain last-known KOIN, mark it stale and remove USD", async () => {
  const f = fixture(); await f.enter(); f.setBalance(Error("offline")); await f.controller.refresh();
  assert.equal(f.view().koin, "3,732.8058"); assert.equal(f.view().stale, true); assert.equal(f.view().usd, "—");
  const g = fixture(); g.setBalance(Error("offline")); await g.enter(); assert.equal(g.view().koin, "—");
  f.controller.close(); g.controller.close();
});
test("expired, malformed and unavailable quotes do not hide KOIN or invent a dollar value", async () => {
  for (const price of [Error("offline"), quote({ expiresAt: START }), quote({ observedAt: START - 1800001 }), quote({ priceDetails: { usdPerKoin: "NaN" } })]) {
    const f = fixture(); f.setPrice(price); await f.enter(); assert.equal(f.view().koin, "3,732.8058"); assert.equal(f.view().usd, "—"); f.controller.close();
  }
  const f = fixture(); f.setPrice(quote({ expiresAt: START + 1000 })); await f.enter(); await f.advance(1001);
  assert.equal(f.view().usd, "—"); f.controller.close();
});
test("wallet switches, hidden windows and shutdown fence late balance results", async () => {
  for (const stop of [f => f.controller.observe({ address: "another-wallet" }), f => f.controller.setVisible(false), f => f.controller.close()]) {
    const f = fixture(); let finish; f.setBalance(() => new Promise(resolve => { finish = resolve; })); await f.enter();
    const old = finish; stop(f); old(balance()); await flush(); assert.equal(f.controller.snapshot().balance, null);
    f.controller.close();
  }
});
test("privacy changes fence a pending USD quote and mismatched wallets cannot set balance", async () => {
  const f = fixture(); let finish; f.setPrice(() => new Promise(resolve => { finish = resolve; })); await f.enter();
  f.controller.observe({ address: ADDRESS }, "local-only"); finish(quote()); await flush(); assert.equal(f.view().usd, "—"); f.controller.close();
  const g = fixture(); g.setBalance(balance({ address: "other-wallet" })); await g.enter(); assert.equal(g.view().koin, "—"); g.controller.close();
});
