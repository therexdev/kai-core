"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createPurchaseStatus, presentation } = require("../../ui-core/purchase-status");
const { CreditPurchases } = require("../../electron/credit-purchases");
const { purchaseProgress } = require("../../electron/credit-purchase-progress");
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const txId = "0x1220" + "a".repeat(64), oldTx = "0x1220" + "b".repeat(64);
const progress = (stage, detail = {}) => ({ stage, operationId: "c".repeat(64), startedAt: 100000, updatedAt: 100000, ...detail });
const ready = () => ({ product: "prepaid-usd-v1", activation: "ready", localPurchase: null });
function fixture() {
  let info = ready(), now = 100000, reads = 0, balances = 0, view;
  let read = async () => { reads++; return info; };
  const c = createPurchaseStatus({ read: () => read(), clock: () => now, refreshCredits: async () => { balances++; }, render(_s, v) { view = v; } });
  c.observe({ address: "wallet", unlocked: true }, "network");
  return { c, setInfo: x => info = x, setRead: x => read = x, advance: ms => now += ms, get view() { return view; }, get reads() { return reads; }, get balances() { return balances; } };
}
test("progress remains visible through submission and pending without starting another purchase", async () => {
  const f = fixture(); await f.c.enter(); assert.equal(f.view.canBuy, true);
  const token = f.c.begin("buy"); assert.ok(token); assert.equal(f.c.begin("buy"), null);
  f.c.progress(progress("wallet-approval")); assert.match(f.view.title, /approval window/);
  f.c.progress(progress("submitting", { txId, updatedAt: 101000 })); assert.match(f.view.title, /Sending/);
  f.c.result(token, { state: "pending", purchase: { txId } });
  f.setInfo({ ...ready(), localPurchase: { state: "pending", txId, submissionAttempts: 1, recovery: "retry" }, purchaseProgress: progress("awaiting-confirmation", { txId }) });
  await f.c.end(token); f.advance(65000); f.c.paint();
  assert.equal(f.view.canBuy, false); assert.equal(f.view.canRecover, true); assert.equal(f.view.txId, txId);
  assert.match(f.view.timing, /1m 5s/); assert.equal(f.view.working, false, "stale progress cannot pretend to be a live check");
  assert.equal(f.c.begin("buy"), null);
});
test("reopen restores pending status and only confirmed credit evidence reports added credits", async () => {
  const f = fixture(); f.setInfo({ ...ready(), localPurchase: { state: "pending", txId, submissionAttempts: 1, recovery: "retry" } });
  await f.c.enter(); assert.equal(f.view.canBuy, false); assert.doesNotMatch(f.view.title, /Credits added/);
  f.c.credits({ status: "ready", snapshot: { purchases: [{ id: oldTx, state: "confirmed" }] } }); assert.doesNotMatch(f.view.title, /Credits added/);
  f.c.credits({ status: "ready", snapshot: { purchases: [{ id: txId, state: "confirmed" }] } }); assert.equal(f.view.title, "Credits added");
  assert.equal(f.view.working, false);
  f.setInfo({ ...ready(), purchaseProgress: progress("complete", { txId, outcome: "credited" }) }); await f.c.refresh();
  assert.equal(f.view.canBuy, true); assert.equal(f.balances, 1); await f.c.refresh(); assert.equal(f.balances, 1);
});
test("old confirmed purchase progress cannot complete a different pending purchase", async () => {
  const f = fixture(); f.setInfo({ ...ready(), localPurchase: { state: "pending", txId, submissionAttempts: 1 }, purchaseProgress: progress("complete", { txId: oldTx, outcome: "credited" }) });
  await f.c.enter(); assert.doesNotMatch(f.view.title, /Credits added/); assert.equal(f.balances, 0); assert.equal(f.view.txId, txId);
});
test("expired or unsubmitted payments need review rather than a perpetual processing spinner", () => {
  for (const p of [{ submissionAttempts: 0 }, { submissionAttempts: 1, quoteExpired: true }, { issue: "funding_insufficient_rc" }, { cancellation: { attempts: 0 }, quoteExpired: true }]) {
    const view = presentation({ info: { localPurchase: { state: "pending", txId, recovery: "retry", ...p } } });
    assert.equal(view.working, false); assert.equal(view.canBuy, false); assert.equal(view.canRecover, true); assert.match(view.title, /attention|expired/);
  }
  const included = presentation({ info: { localPurchase: { state: "pending", txId, quoteExpired: true, recovery: null, submissionAttempts: 1 } } });
  assert.equal(included.canRecover, false); assert.doesNotMatch(included.title, /expired/);
  assert.equal(presentation({ info: { localPurchase: { state: "pending", recovery: "retry", busy: true } } }).canRecover, false);
});
test("failed confirmation checks stay visible without claiming the payment failed", async () => {
  const f = fixture(); f.setInfo({ ...ready(), localPurchase: { state: "pending", txId, submissionAttempts: 1 } }); await f.c.enter();
  f.c.progress(progress("confirmation-unavailable", { txId })); assert.match(f.view.title, /check delayed/); assert.equal(f.view.working, false); assert.equal(f.view.canBuy, false);
  const safe = purchaseProgress({ ...progress("confirmation-unavailable", { txId }), error: "private RPC data" }); assert.ok(safe); assert.equal(safe.error, undefined);
});
test("wallet and privacy changes discard late reads and old payment events", async () => {
  const f = fixture(), d = deferred(); f.setRead(() => d.promise); const read = f.c.enter();
  f.c.observe({ address: "other-wallet", unlocked: true }, "local-only");
  d.resolve({ ...ready(), localPurchase: { state: "pending", txId }, purchaseProgress: progress("complete", { txId, outcome: "credited" }) }); await read;
  f.c.progress(progress("complete", { txId, outcome: "credited" })); assert.equal(f.c.snapshot().info, null); assert.equal(f.balances, 0); assert.equal(f.view.canBuy, false);
});
test("unlocking the same wallet during purchase preparation does not discard the user's operation", async () => {
  const f = fixture(); f.c.observe({ address: "wallet", unlocked: false }, "network"); await f.c.enter(); const token = f.c.begin("buy");
  f.c.observe({ address: "wallet", unlocked: true }, "network"); assert.ok(f.c.current(token));
  f.c.observe({ address: "different", unlocked: true }, "network"); assert.equal(f.c.current(token), false);
});
test("status checks are deduplicated and off-page polling cannot trigger recovery or purchases", async () => {
  const f = fixture(); await f.c.refresh(); assert.equal(f.reads, 0);
  const d = deferred(); let reads = 0; f.setRead(() => { reads++; return d.promise; }); const read = f.c.enter(); await f.c.refresh(); assert.equal(reads, 1);
  assert.equal(f.view.visible, true); assert.equal(f.view.working, true); assert.equal(f.view.canBuy, false); assert.match(f.view.title, /Checking saved/);
  d.resolve(ready()); await read; f.c.leave(); await f.c.refresh(); assert.equal(reads, 1);
});
test("unreadable saved payment state blocks a second Buy and later valid status recovers", async () => {
  const f = fixture(); f.setRead(async () => { throw Error("Saved payment records unavailable"); }); await f.c.enter(); assert.equal(f.view.canBuy, false); assert.match(f.view.detail, /unavailable/);
  f.setRead(async () => ready()); await f.c.refresh(); assert.equal(f.view.canBuy, true);
});
test("background observation errors report a bounded status without a new write or raw RPC text", async t => {
  const values = [], c = { directory: "fixture", auth: { accountId: "account" }, config: {} };
  const p = new CreditPurchases({ dataDir: "unused", account: {}, progress: v => values.push(v), clock: () => 100000 });
  t.mock.method(p, "read", () => ({ txId })); t.mock.method(p, "use", async () => { throw Error("private RPC error"); });
  await assert.rejects(p.sync(c, new AbortController().signal), /private RPC/);
  assert.equal(values.at(-1).stage, "confirmation-unavailable"); assert.equal(JSON.stringify(values).includes("private RPC"), false);
});
test("registering an old receipt cannot complete the current pending purchase", async t => {
  const f = require("../test/helpers/koin-funding-recovery-fixture").fixture(t, { usd: true });
  const pending = { id: "pending", kind: "credits", state: "signed", txId }, old = { id: "old", kind: "credits", state: "funded", txId: oldTx };
  t.mock.method(f.journal, "list", () => [pending, old]);
  t.mock.method(f.journal.nonceCoordinator, "confirmation", () => null);
  t.mock.method(f.journal.nonceCoordinator, "reconcile", async () => {});
  t.mock.method(f.journal.nonceCoordinator, "status", () => ({ state: "signed" }));
  t.mock.method(f.journal.nonceCoordinator, "correction", () => null);
  const events = [], registered = [];
  const p = new (require("../../electron/koin-test-payments").TestPayments)({
    config: { mode: "isolated-rehearsal", owner: f.signer.getAddress() }, client: f.client, journal: f.journal,
    wallet: { address: f.signer.getAddress(), signer: f.signer }, dialog: { showMessageBox() { throw Error("No approval expected"); } },
    progress: (stage, detail) => events.push({ stage, ...detail }),
  });
  await p.syncPurchases(async id => { registered.push(id); return { purchase: { state: id === oldTx ? "confirmed" : "pending" } }; }, new AbortController().signal);
  assert.deepEqual(registered, [txId, oldTx]);
  assert.ok(events.length); assert.ok(events.every(e => e.txId === txId)); assert.ok(events.every(e => e.stage !== "complete"));
  assert.equal(f.state.signed, 0); assert.deepEqual(f.state.submissions, []);
});
test("confirmation timeouts are visible but an intentional background stop is not a payment error", async t => {
  for (const timeout of [false, true]) {
    const values = [], c = { directory: "fixture", auth: { accountId: "account" }, config: {} }, abort = new AbortController();
    const p = new CreditPurchases({ dataDir: "unused", account: {}, progress: v => values.push(v), clock: () => 100000 });
    t.mock.method(p, "read", () => ({ txId }));
    t.mock.method(p, "use", async (_context, signal) => { abort.abort(new DOMException("Fixture ended", timeout ? "TimeoutError" : "AbortError")); signal.throwIfAborted(); });
    await assert.rejects(p.sync(c, abort.signal), /Fixture ended/);
    assert.equal(values.some(v => v.stage === "confirmation-unavailable"), timeout);
  }
});
