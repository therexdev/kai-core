"use strict";
(function (root) {
  const phases = {
    "checking-payment": "Checking saved payment", "checking-network": "Checking the network", "getting-price": "Getting your purchase price",
    "preparing-payment": "Preparing payment", "wallet-approval": "Review the payment in the approval window", "rechecking-payment": "Rechecking the approved payment",
    signing: "Signing your approved payment", "checking-mana": "Checking available Mana", submitting: "Sending your approved payment",
    "awaiting-confirmation": "Waiting for payment confirmation", "updating-credits": "Updating your credit balance",
    "confirmation-unavailable": "Confirmation check delayed", "cancellation-approval": "Review the cancellation", "cancellation-signing": "Signing the cancellation",
    "cancellation-submitting": "Sending the cancellation", "cancellation-confirmation": "Waiting for cancellation confirmation",
    complete: "Payment checked", stopped: "Payment processing paused", failed: "Payment needs attention",
  };
  const clean = error => String(error?.message || error || "").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  function presentation(s, now = Date.now()) {
    const p = s.info?.localPurchase, progress = s.progress, pending = p?.state === "pending" || s.result?.state === "pending";
    const unknown = p?.state === "unavailable", reviewing = p?.busy || p?.state === "reviewing";
    const needsReview = pending && !s.busy && (!!p?.recovery && (p.cancellation ? p.cancellation.attempts === 0 : p.submissionAttempts === 0 || p.quoteExpired) || ["funding_insufficient_rc", "funding_simulation_failed"].includes(p?.issue));
    const target = p?.txId || progress?.txId;
    const credited = !!target && (s.confirmedTxId === target || progress?.stage === "complete" && progress.outcome === "credited" && progress.txId === target);
    const age = progress ? Math.max(0, now - progress.updatedAt) : null;
    let title = s.busy ? "Preparing your purchase" : pending ? "Waiting for payment confirmation" : "Payment status";
    let detail = s.busy ? "Keep this window open. You will review the exact payment before it is sent." : p?.detail || "";
    if (progress) title = phases[progress.stage] || title;
    if (pending && !detail) detail = "The saved payment is checked automatically. Do not click Buy again.";
    if (needsReview) title = "Saved payment needs attention";
    if (needsReview && p?.quoteExpired && !p.cancellation) title = "Purchase quote expired — review the saved payment";
    if (needsReview && p?.cancellation) title = "Saved cancellation needs attention";
    if (progress?.stage === "confirmation-unavailable") detail = "The last confirmation check could not finish. KAI will check the same saved payment again automatically. This does not start another purchase.";
    if (credited) { title = "Credits added"; detail = "Your payment was confirmed and the credits were added to your account."; }
    else if (progress?.stage === "complete" && progress.outcome === "cancelled") { title = "Purchase cancelled"; detail = "The saved cancellation was confirmed."; }
    else if (s.result?.state === "cancelled") { title = "Purchase cancelled"; detail = "The payment review was cancelled. Any earlier saved transaction remains available for recovery."; }
    if (unknown) { title = "Payment status unavailable"; detail = p.detail; }
    if (s.info?.blocked && !pending && !s.busy && !credited) { title = "Purchase connection needs attention"; detail = s.info.blocked; }
    if (s.error) { title = "Payment status needs attention"; detail = s.error; }
    const initialCheck = s.loading && !s.info;
    if (initialCheck && !s.error) { title = "Checking saved purchases"; detail = "Checking for an unfinished payment before starting another purchase."; }
    if (s.offline) { title = "Payment checks paused"; detail = "Local only is on. Choose an online mode to check your saved payment. Its records are kept."; }
    const terminal = ["complete", "failed", "stopped", "confirmation-unavailable"].includes(progress?.stage);
    const working = !credited && !s.offline && !s.error && !unknown && !needsReview && !terminal && (initialCheck || s.busy || pending) && (age === null || age < 45000);
    const txId = progress?.txId || p?.txId || s.result?.purchase?.txId || "";
    const elapsed = progress?.startedAt || s.startedAt;
    const seconds = elapsed ? Math.floor(Math.max(0, now - elapsed) / 1000) : null;
    const time = seconds === null || terminal ? "" : `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed`;
    const checked = age === null ? "" : `Last update ${Math.floor(age / 1000)}s ago`;
    const confirmation = p?.confirmation;
    const heights = confirmation?.blockHeight && confirmation?.irreversibleHeight ? `Payment block ${confirmation.blockHeight} · confirmed through block ${confirmation.irreversibleHeight}` : "";
    return { visible: !!(initialCheck || s.busy || pending || reviewing || unknown || progress || s.error || s.result || s.info?.blocked), title, detail, working, txId,
      timing: [time, checked, heights].filter(Boolean).join(" · "),
      canBuy: !!s.info && !s.busy && !pending && !reviewing && !unknown && !s.error && !s.offline,
      canRecover: !!p?.recovery && pending && !s.busy && !reviewing && !s.offline,
      buyLabel: s.busy ? "Processing…" : pending || reviewing ? "Purchase in progress" : "Buy credits" };
  }
  function createPurchaseStatus({ read, render = () => {}, refreshCredits = async () => {}, clock = Date.now }) {
    const s = { active: false, busy: false, loading: false, info: null, progress: null, result: null, error: "", offline: false, startedAt: null, confirmedTxId: null };
    let generation = 0, pending = null, observed, action = null, completed = null;
    const snapshot = () => structuredClone(s), paint = () => render(snapshot(), presentation(s, clock()));
    function acceptProgress(value) {
      if (!value || !Object.hasOwn(phases, value.stage) || typeof value.operationId !== "string" ||
          !Number.isSafeInteger(value.startedAt) || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.startedAt) return;
      if (s.progress?.operationId === value.operationId && s.progress.updatedAt > value.updatedAt) return;
      s.progress = structuredClone(value);
      if (value.stage === "complete" && value.outcome === "credited" && completed !== value.operationId) {
        completed = value.operationId; void refreshCredits().catch(() => {});
      }
    }
    async function refresh(force = false) {
      if ((!s.active && !force) || s.offline || s.busy || pending) return;
      const epoch = generation, token = {}; pending = token; s.loading = true; paint();
      try {
        const info = await read();
        if (epoch !== generation) return;
        if (!info || info.product !== "prepaid-usd-v1") throw Error("The purchase status could not be verified.");
        s.info = info; s.result = null; s.error = "";
        if (info.purchaseProgress) {
          const tx = info.localPurchase?.txId, value = info.purchaseProgress;
          if (!tx || !value.txId || value.txId === tx || value.operationId === s.progress?.operationId || value.txId === info.localPurchase?.cancellation?.txId) acceptProgress(value);
          else s.progress = null;
        }
        else if (!info.localPurchase) s.progress = null;
      } catch (error) { if (epoch === generation) s.error = clean(error); }
      finally { if (pending === token) pending = null; if (epoch === generation) { s.loading = false; paint(); } }
    }
    function reset() {
      generation++; pending = null; action = null; completed = null;
      Object.assign(s, { busy: false, loading: false, info: null, progress: null, result: null, error: "", startedAt: null, confirmedTxId: null }); paint();
      if (s.active && !s.offline) void refresh();
    }
    return { snapshot, refresh, paint,
      enter() { s.active = true; paint(); return refresh(); },
      leave() { s.active = false; },
      observe(wallet, privacy) {
        const next = [wallet?.address || null, !!wallet?.unlocked, privacy];
        const key = JSON.stringify(next), prior = observed && JSON.parse(observed);
        s.offline = privacy === "local-only";
        const expectedUnlock = s.busy && prior && prior[0] === next[0] && !prior[1] && next[1] && prior[2] === next[2];
        if (key !== observed) { observed = key; if (!expectedUnlock) reset(); else paint(); } else paint();
      },
      identityChanged: reset,
      begin(kind) {
        const view = presentation(s, clock());
        if (s.busy || (kind === "buy" ? !view.canBuy : !view.canRecover)) return null;
        generation++; pending = null; action = {}; Object.assign(s, { busy: true, loading: false, error: "", progress: null, result: null, startedAt: clock(), confirmedTxId: null }); paint(); return action;
      },
      current: token => token && action === token,
      result(token, result) { if (action === token) { s.result = structuredClone(result); paint(); } },
      fail(token, error) { if (action === token) { s.error = clean(error); paint(); } },
      async end(token) { if (action !== token) return; action = null; s.busy = false; paint(); await refresh(true); },
      progress(value) {
        if (s.offline || !value) return;
        const matches = s.progress?.operationId === value.operationId || value.txId && s.info?.localPurchase?.txId === value.txId;
        if (!(s.busy && value.startedAt >= s.startedAt) && !matches) return;
        acceptProgress(value); paint();
      },
      credits(value) {
        const txId = s.info?.localPurchase?.txId || s.progress?.txId;
        if (txId && value?.status === "ready" && value.snapshot?.purchases?.some(p => p.id === txId && p.state === "confirmed")) { s.confirmedTxId = txId; paint(); }
      },
    };
  }
  if (typeof module === "object") module.exports = { createPurchaseStatus, presentation };
  if (!root?.document || !root.kaiCore?.credit) return;
  const doc = root.document, text = (node, value) => { if (!node) return; if (root.KaiI18n?.setText) root.KaiI18n.setText(node, value || ""); else if (node.textContent !== String(value || "")) node.textContent = value || ""; };
  const controller = createPurchaseStatus({ read: () => root.kaiCore.credit("purchase-info"), refreshCredits: () => root.KaiCredits.refresh(),
    render(state, view) {
      for (const card of doc.querySelectorAll("[data-purchase-status]")) {
        card.hidden = !view.visible;
        text(card.querySelector("[data-purchase-title]"), view.title); text(card.querySelector("[data-purchase-detail]"), view.detail);
        card.querySelector("[data-purchase-spinner]").hidden = !view.working;
        text(card.querySelector("[data-purchase-time]"), view.timing);
        const tx = card.querySelector("[data-purchase-tx]"); text(tx, view.txId ? "Transaction: " + view.txId : ""); tx.hidden = !view.txId;
        card.querySelector("[data-purchase-check]").disabled = state.busy || state.loading || state.offline;
      }
      const buy = doc.querySelector("#buy-credits button[type=submit]"); if (buy) { buy.disabled = !view.canBuy; text(buy, view.buyLabel); }
      const retry = doc.getElementById("purchase-retry"); if (retry) { retry.disabled = !view.canRecover; retry.hidden = !state.info?.localPurchase?.recovery; }
      const amount = doc.getElementById("usd"); if (amount) amount.disabled = state.busy || state.info?.localPurchase?.state === "pending";
    } });
  root.KaiPurchaseStatus = controller;
  root.KaiCredits.subscribe(value => controller.credits(value));
  root.kaiCore.onPurchaseProgress?.(value => controller.progress(value));
  for (const button of doc.querySelectorAll("[data-purchase-check]")) button.addEventListener("click", () => void controller.refresh());
  root.addEventListener("kai-credit-identity-changed", () => controller.identityChanged());
  root.addEventListener("kai-account-signed-out", () => controller.identityChanged());
  doc.addEventListener("visibilitychange", () => { if (!doc.hidden) void controller.refresh(); });
  setInterval(() => { if (!doc.hidden) controller.paint(); }, 1000);
  setInterval(() => { if (!doc.hidden) void controller.refresh(); }, 10000);
})(typeof window === "undefined" ? null : window);
