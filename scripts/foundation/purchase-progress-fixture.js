"use strict";
// Synthetic payment lifecycle only: real Core renderer, preload, IPC validation
// and sanitized progress bridge. This fixture never signs or submits a payment.
const assert = require("node:assert/strict"), path = require("node:path");
function install(runtimeRoot) {
  const { CreditService } = require(path.join(runtimeRoot, "electron/credit-service"));
  const state = global.__purchaseProgressFixture = { actions: [], localPurchase: null, value: null, finish: null };
  const originalRun = CreditService.prototype.run;
  CreditService.prototype.purchaseInfo = async function () {
    state.service = this;
    return { product: "prepaid-usd-v1", activation: "ready", localPurchase: state.localPurchase, purchaseProgress: state.value };
  };
  state.emit = (stage, detail = {}) => {
    const now = Date.now(); state.value = { operationId: "a".repeat(64), startedAt: state.value?.startedAt || now, updatedAt: now, ...state.value, ...detail, stage };
    state.value.updatedAt = now; state.service.purchases.progress(state.value);
  };
  CreditService.prototype.run = async function (action, ...args) {
    if (action === "purchase-sync") return; // Never use real chain endpoints in this UI fixture.
    if (action === "purchase-estimate") return { estimate: { koin: "600", credits: "60,000" } };
    if (action === "purchase-preview") { state.actions.push(action); state.emit("getting-price"); return { quote: { id: "fixture-quote", koin: "600", credits: "6000000000" } }; }
    if (action === "purchase-approve") {
      state.actions.push(action); state.emit("wallet-approval");
      return new Promise(resolve => { state.finish = () => resolve({ state: "pending", purchase: { txId: state.localPurchase.txId } }); });
    }
    return originalRun.call(this, action, ...args);
  };
}
async function check({ app, page, report, capture, until }) {
  await app.evaluate(() => global.__installPurchaseProgressFixture());
  await page.evaluate(() => window.KaiPurchaseStatus.refresh());
  const card = page.locator('[data-panel="buy-credits"] [data-purchase-status]'), buy = page.locator('#buy-credits button[type=submit]');
  await until(() => buy.isEnabled(), "Buy did not become available after verified status");
  await page.locator("#usd").fill("60"); await buy.click();
  await until(async () => /approval window/.test(await card.textContent()), "Real preload did not deliver approval progress");
  assert.equal(await buy.isDisabled(), true); assert.equal(await card.locator("[data-purchase-spinner]").isVisible(), true);
  const txId = "0x1220" + "b".repeat(64);
  await app.evaluate((_electron, txId) => {
    const s = global.__purchaseProgressFixture;
    s.localPurchase = { state: "pending", txId, submissionAttempts: 1, recovery: "retry", detail: "Checking the saved payment automatically." };
    s.emit("submitting", { txId });
  }, txId);
  await until(async () => /Sending your approved payment/.test(await card.textContent()), "Submitting stage missing");
  await app.evaluate(() => { const s = global.__purchaseProgressFixture; s.emit("awaiting-confirmation"); s.finish(); });
  await until(async () => /Waiting for payment confirmation/.test(await card.textContent()), "Pending stage missing");
  assert.match(await card.textContent(), new RegExp(txId)); assert.equal(await buy.isDisabled(), true);
  await page.evaluate(() => document.getElementById("buy-credits").requestSubmit());
  assert.deepEqual(await app.evaluate(() => global.__purchaseProgressFixture.actions), ["purchase-preview", "purchase-approve"]);
  await capture("purchase-pending");
  await page.locator('[data-page="credits"]').click();
  assert.match(await page.locator('[data-panel="credits"] [data-purchase-status]').textContent(), new RegExp(txId));
  await page.reload(); await page.waitForFunction(() => document.getElementById("version")?.textContent.startsWith("v"));
  await page.locator('[data-page="credits"]').click(); await page.locator('[data-panel="credits"] [data-go="buy-credits"]').click();
  await until(async () => /Waiting for payment confirmation/.test(await card.textContent()), "Reload did not restore saved progress");
  assert.equal(await buy.isDisabled(), true);
  report.checks.push("Native progress bridge shows approval, sending, saved transaction, and pending across navigation/reload; repeated Buy sends no second request");
  await app.evaluate(() => global.__purchaseProgressFixture.emit("confirmation-unavailable"));
  await until(async () => /Confirmation check delayed/.test(await card.textContent()), "Confirmation failure was hidden");
  assert.equal(await card.locator("[data-purchase-spinner]").isHidden(), true); assert.equal(await buy.isDisabled(), true);
  await app.evaluate(() => { const s = global.__purchaseProgressFixture; s.localPurchase.quoteExpired = true; s.localPurchase.submissionAttempts = 0; s.emit("awaiting-confirmation"); });
  await card.locator("[data-purchase-check]").click();
  await until(async () => /Purchase quote expired/.test(await card.textContent()), "Expired quote did not explain recovery");
  assert.equal(await card.locator("[data-purchase-spinner]").isHidden(), true); assert.equal(await page.locator("#purchase-retry").isEnabled(), true);
  await capture("purchase-needs-recovery");
  await app.evaluate(() => { const s = global.__purchaseProgressFixture; s.localPurchase.cancellation = { attempts: 1 }; s.emit("cancellation-confirmation"); });
  await card.locator("[data-purchase-check]").click();
  await until(async () => /Waiting for cancellation confirmation/.test(await card.textContent()), "Cancellation was mislabeled as a purchase");
  assert.equal(await buy.isDisabled(), true);
  await app.evaluate(() => { const s = global.__purchaseProgressFixture; s.localPurchase = null; s.emit("complete", { outcome: "cancelled" }); });
  await card.locator("[data-purchase-check]").click();
  await until(() => buy.isEnabled(), "Confirmed cancellation did not unblock Buy");
  assert.match(await card.textContent(), /Purchase cancelled/); assert.doesNotMatch(await card.textContent(), /Credits added/);
  report.checks.push("Delayed checks and expired quotes stop the spinner; recovery remains explicit and only confirmed cancellation unblocks Buy");
}
module.exports = { install, check };
