"use strict";
(function (root) {
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const label = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const localOnlyMessage = "Network status is off in Local-Only. Choose Local-First or Network in Settings to view it.";

  function validateNetwork(network, now = Date.now()) {
    const n = network, publicStatus = n?.source === "public-scheduler";
    if (!n || !count(n.observedAt) || !count(n.validUntil) || n.observedAt > now + 5000 || n.validUntil <= n.observedAt || n.validUntil > n.observedAt + 15000 ||
        !["available", "paused"].includes(n.state) || !count(publicStatus ? n.providersOnline : n.readyProviders) || !count(n.waitingRequests) ||
        (publicStatus ? n.readyProviders !== null || n.completedToday !== null || n.activityAvailable !== false : !count(n.completedToday)) ||
        !Array.isArray(n.models) || n.models.length > 256 || n.models.some(m => !label(m?.id, 128) || typeof m.available !== "boolean" || !count(m.providers) ||
          (m.available && m.providers === 0) || (m.name !== undefined && !label(m.name)) ||
          (publicStatus ? m.freeEligible !== null || m.selectable !== false : typeof m.freeEligible !== "boolean" || (m.selectable !== undefined && typeof m.selectable !== "boolean"))) ||
        new Set(n.models.map(m => m.id)).size !== n.models.length ||
        !Array.isArray(n.providers) || n.providers.length > 256 || n.providers.some(p => !label(p?.id) || !label(p.model, 32768) || !label(p.state, 64)) ||
        !Array.isArray(n.activity) || n.activity.length > 50 || n.activity.some(a => !label(a?.model, 128) || !count(a.at) || a.at > now + 5000) ||
        (publicStatus && n.activity.length !== 0)) throw Error("No verified network status is available. Refresh to try again.");
    return n;
  }
  function modelName(model) {
    const id = typeof model === "string" ? model : model.id;
    if (typeof model === "object" && model.name) return model.name;
    const known = { "koinos-fast": "Koinos Fast", "koinos-balanced": "Koinos Balanced", "koinos-smart": "Koinos Smart" };
    return known[id] || id.replace(/[_:/-]+/g, " ").replace(/\b[a-z]/g, c => c.toUpperCase());
  }
  if (typeof module === "object") module.exports = { validateNetwork, modelName };
  if (!root || typeof document !== "object") return;
  const host = document.getElementById("network-content");
  if (!host) return;
  host.innerHTML = `
    <header class="product-head"><div><h1>Network overview</h1><p>Available AI and the computers providing it.</p></div><button id="core-network-refresh" type="button">Refresh</button></header>
    <section class="product-network-status" aria-label="Network status">
      <div><h2 id="core-network-state" role="status">Network status unavailable</h2><p id="core-network-time">No verified observation yet.</p></div>
      <div><strong id="core-network-model-count">—</strong><small>models available</small></div>
      <div><strong id="core-network-provider-count">—</strong><small id="core-network-provider-label">providers ready</small></div>
      <div><strong id="core-network-waiting-count">—</strong><small id="core-network-waiting-label">requests waiting</small></div>
    </section>
    <div class="product-two product-single" id="core-network-model-grid">
      <section class="product-panel"><h2>Models on the network</h2><div id="core-network-models"><p class="product-empty">No verified model availability yet.</p></div></section>
      <section class="product-panel" id="core-network-completed" hidden><p class="product-eyebrow">Work completed today</p><div class="product-balance"><span id="core-network-completed-count">—</span><small>requests</small></div><p>Requests with verified delivered replies, including saved partial replies.</p><div class="product-divider"></div><p>Your earnings are shown in Earn KOIN.</p></section>
    </div>
    <section class="product-panel"><h2>Computers providing AI</h2><div id="core-network-providers"><p class="product-empty">No verified provider status yet.</p></div></section>
    <section class="product-panel" id="core-network-recent" hidden><h2>Recent activity</h2><p id="core-network-activity-state" class="muted"></p><div id="core-network-activity"></div></section>`;
  const $ = id => document.getElementById(`core-network-${id}`);
  const text = (id, value) => { const node = $(id), next = String(value); if (node.textContent !== next) node.textContent = next; };
  const html = (id, value) => { const node = $(id); if (node.innerHTML !== value) node.innerHTML = value; };
  let snapshot = null, error = "", mode = null, active = false, generation = 0, pending = null, pollTimer, expiryTimer;
  const visible = () => active && !document.hidden;
  const fresh = () => !!snapshot && !error && mode !== "local-only" && Date.now() < snapshot.validUntil && snapshot.observedAt <= Date.now() + 5000;
  const canUse = model => fresh() && snapshot.state === "available" && snapshot.source !== "public-scheduler" && model.available && model.providers > 0 && model.selectable !== false;
  function clearTimers() { clearTimeout(pollTimer); clearTimeout(expiryTimer); pollTimer = expiryTimer = null; }
  function paint() {
    const n = snapshot, current = fresh(), publicStatus = n?.source === "public-scheduler";
    text("state", current ? n.state === "available" ? "AI network status" : "Network paused" : "Network status unavailable");
    text("time", error || (n ? `Observed ${new Date(n.observedAt).toLocaleString()}${current ? "" : " · Availability unconfirmed"}` : "No verified observation yet."));
    $("state").dataset.state = current ? n.state : "unavailable";
    text("provider-label", publicStatus ? "providers online" : "providers ready");
    text("waiting-label", publicStatus ? "jobs waiting" : "requests waiting");
    text("model-count", current ? n.models.filter(m => m.available).length : "—");
    text("provider-count", current ? publicStatus ? n.providersOnline : n.readyProviders : "—");
    text("waiting-count", current ? n.waitingRequests : "—");
    const reported = n && !publicStatus && n.completedToday !== null;
    $("completed").hidden = !reported;
    $("model-grid").classList.toggle("product-single", !reported);
    $("recent").hidden = !n || publicStatus || n.activityAvailable === false;
    text("completed-count", current && reported ? n.completedToday : "—");
    text("activity-state", n && !current ? "Last verified activity. Current network status is unavailable." : "");
    html("models", n?.models.length ? n.models.map(m => `<div class="product-model-row"><div><strong>${escape(modelName(m))}</strong>${m.freeEligible === null ? "" : `<p>${m.freeEligible ? "Free credits eligible" : "Purchased credits"}</p>`}</div><div><p>${current && m.unavailableReason === "self-only" ? "Only shared by your computer or account · use Local model" : current && m.unavailableReason === "wallet-connection-required" ? "Connect your wallet to use other providers while sharing this model" : current && m.available ? `${m.providers} provider${m.providers === 1 ? "" : "s"} ${publicStatus ? "online" : "ready"}` : "Availability unconfirmed"}</p>${publicStatus ? "" : `<button type="button" data-network-model="${escape(m.id)}"${canUse(m) ? "" : " disabled"}>Use model</button>`}</div></div>`).join("") : `<p class="product-empty">${n ? "No models are currently reported." : "No verified model availability yet."}</p>`);
    html("providers", n?.providers.length ? n.providers.map(p => `<div class="product-detail"><span>${p.self ? "Your computer or account" : `Provider ${escape(p.id)}`} · ${escape(modelName(p.model))}</span><span>${current ? escape(p.state.replace(/-/g, " ")) : "Last seen — status stale"}</span></div>`).join("") + (n.providersTruncated ? '<p class="muted">Showing the first 256 providers.</p>' : "") : `<p class="product-empty">${n ? "No recently observed providers." : "No verified provider status yet."}</p>`);
    html("activity", n?.activity.length ? n.activity.map(a => `<div class="product-detail"><span>Reply delivered · ${escape(modelName(a.model))}</span><time>${escape(new Date(a.at).toLocaleTimeString())}</time></div>`).join("") : '<p class="product-empty">No verified replies recorded today.</p>');
    clearTimeout(expiryTimer);
    if (visible() && current) expiryTimer = setTimeout(paint, Math.max(1, n.validUntil - Date.now()));
  }
  function schedule() {
    clearTimeout(pollTimer);
    if (visible() && mode !== "local-only") pollTimer = setTimeout(refresh, 10000);
  }
  async function refresh() {
    if (!visible() || pending || mode === "local-only") return;
    const token = { generation };
    pending = token;
    try {
      if (!root.kaiCore?.credit) throw Error("Network status is available in the desktop app.");
      const result = await root.kaiCore.credit("network-overview");
      if (generation !== token.generation || !visible()) return;
      snapshot = validateNetwork(result?.network); error = "";
    } catch (failure) {
      if (generation !== token.generation || !visible()) return;
      error = String(failure?.message || "Network status unavailable").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
      if (/Network status is off in Local-Only/.test(error)) { mode = "local-only"; snapshot = null; }
    } finally {
      if (pending === token) { pending = null; paint(); schedule(); }
    }
  }
  function invalidate() {
    generation++; pending = null; clearTimers(); snapshot = null; error = mode === "local-only" ? localOnlyMessage : ""; paint();
  }
  function enter() { active = true; paint(); return refresh(); }
  function leave() { active = false; generation++; pending = null; clearTimers(); }
  root.KaiCoreNetwork = Object.freeze({ enter, leave, refresh });
  $("refresh").onclick = () => refresh();
  $("models").onclick = event => {
    const button = event.target.closest?.("button[data-network-model]");
    const model = snapshot?.models.find(m => m.id === button?.dataset.networkModel);
    if (model && canUse(model)) root.dispatchEvent(new CustomEvent("kai-core-use-network-model", { detail: { model: model.id } }));
    else paint();
  };
  root.addEventListener("kai-core-privacy-changed", event => {
    const next = event.detail?.mode ?? event.detail?.privacyMode ?? event.detail;
    if (!["local-only", "local-first", "network"].includes(next) || next === mode) return;
    mode = next; invalidate(); if (visible()) refresh();
  });
  for (const event of ["kai-credit-identity-changed", "kai-account-signed-out"]) root.addEventListener(event, () => { invalidate(); if (visible()) refresh(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { generation++; pending = null; clearTimers(); }
    else if (active) { paint(); refresh(); }
  });
})(typeof window === "object" ? window : null);
