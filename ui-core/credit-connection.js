"use strict";
(function (root) {
  const message = error => String(error?.message || error || "Your credit connection could not be checked.").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  function presentation(state) {
    const info = state.info;
    if (!info) return { visible: !!state.error, title: "Check wallet credits", detail: "Your saved balance remains on the network.", action: "refresh", label: "Try again" };
    if (info.connected && !info.sessionOnly && info.state === "ready") return { visible: false };
    if (!info.address && info.state === "free-ready") return { visible: false };
    if (info.state === "wallet-changed" || ["identity-changed", "saved-account-unavailable", "identity-unverified"].includes(info.state))
      return { visible: true, title: "Choose your credit account", detail: info.detail, action: "account", label: "Credit account settings" };
    if (info.state === "wallet-unlock-required" || info.sessionOnly && !info.walletUnlocked)
      return { visible: true, title: "Restore wallet credits", detail: info.detail, action: "wallet", label: "Unlock wallet" };
    if (info.state === "online-required") return { visible: true, title: "Connect to network credits", detail: info.detail, action: "settings", label: "Network settings" };
    if (info.canConnect && info.capabilityAvailable !== false)
      return { visible: true, title: "Restore wallet credits", detail: info.detail, action: "connect", label: "Restore wallet credits" };
    if (info.connected && info.sessionOnly && info.canConnect)
      return { visible: true, title: "Restore wallet credits", detail: info.detail, action: "connect", label: "Restore wallet credits" };
    return { visible: !!info.address, title: "Restore wallet credits", detail: info.detail, action: "refresh", label: "Check again" };
  }
  function createConnection({ read, connect, refreshCredits, navigate, render = () => {} }) {
    const state = { active: false, loading: false, busy: false, info: null, error: "" };
    let generation = 0, pending = null, observed = null;
    const snapshot = () => structuredClone(state);
    const paint = () => render(snapshot(), presentation(state));
    async function refresh() {
      if (!state.active || pending || state.busy) return;
      const epoch = generation, token = {}; pending = token; state.loading = true; paint();
      try { const info = await read(); if (epoch === generation && state.active) { if (!info || typeof info.connected !== "boolean") throw Error("Your wallet connection could not be verified."); state.info = info; state.error = ""; } }
      catch (error) { if (epoch === generation && state.active) state.error = message(error); }
      finally { if (pending === token) pending = null; if (epoch === generation && state.active) { state.loading = false; paint(); } }
    }
    function observe(wallet, privacy) {
      const key = JSON.stringify([wallet?.address || null, !!wallet?.unlocked, privacy]);
      if (key === observed) return; observed = key; generation++; pending = null; state.info = null; state.error = ""; state.loading = false; paint();
      if (state.active) void refresh();
    }
    async function act() {
      if (!state.active || state.busy || state.loading) return;
      const view = presentation(state);
      if (view.action === "refresh") return refresh();
      if (view.action !== "connect") { navigate(view.action); return; }
      const epoch = generation, address = state.info?.address;
      state.busy = true; state.error = ""; paint();
      try {
        const result = await connect();
        if (result?.state === "cancelled") return;
        if (result?.state !== "connected" || result.address !== address || result.sessionOnly === true) throw Error("Wallet connection was not confirmed. Your previous account remains unchanged.");
        // The main process guards the reviewed identity. Refresh the shared
        // remote balance/history even if the user left this page meanwhile.
        await refreshCredits();
      } catch (error) { if (epoch === generation && state.active) state.error = message(error); }
      finally {
        state.busy = false; paint();
        if (state.active && !state.error) await refresh();
      }
    }
    return { refresh, observe, act, snapshot,
      enter() { state.active = true; paint(); return refresh(); },
      leave() { state.active = false; generation++; pending = null; state.loading = false; paint(); },
      identityChanged() { generation++; pending = null; state.info = null; state.error = ""; state.loading = false; paint(); if (state.active) void refresh(); } };
  }
  if (typeof module === "object") module.exports = { createConnection, presentation };
  if (!root?.document || !root.kaiCore?.credit) return;
  const $ = id => root.document.getElementById("credit-connection" + (id ? "-" + id : "")), card = $(""); if (!card) return;
  const text = (id, value) => { const node = $(id), next = String(value || ""); if (node.textContent !== next) node.textContent = next; };
  const controller = createConnection({ read: () => root.kaiCore.credit("wallet-info"), connect: () => root.kaiCore.credit("wallet-connect", { sessionOnly: false }),
    refreshCredits: async () => { root.KaiCredits.clear(); await root.KaiCredits.refresh(); },
    navigate: action => {
      root.dispatchEvent(new root.CustomEvent("kai-core-navigate", { detail: { page: action === "wallet" ? "wallet" : "settings" } }));
      if (action === "account") root.KaiCoreAccount?.openCredit();
    },
    render(state, view) {
      card.hidden = !view.visible; text("title", view.title); text("detail", view.detail); text("address", state.info?.address);
      $("address").hidden = !state.info?.address; text("error", state.error); $("error").hidden = !state.error;
      text("action", state.busy ? "Connecting…" : state.loading ? "Checking…" : view.label); $("action").disabled = state.busy || state.loading;
    } });
  $("action").addEventListener("click", () => void controller.act());
  root.KaiCreditConnection = controller;
  root.addEventListener("kai-credit-identity-changed", () => controller.identityChanged());
  root.addEventListener("kai-account-signed-out", () => controller.identityChanged());
  root.document.addEventListener("visibilitychange", () => { if (!root.document.hidden) void controller.refresh(); });
  setInterval(() => { if (!root.document.hidden) void controller.refresh(); }, 15000);
})(typeof window === "undefined" ? null : window);
