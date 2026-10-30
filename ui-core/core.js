"use strict";
const $ = id => document.getElementById(id), bridge = window.kaiCore;
let snapshot, page = "chat", refreshing = false, priceGeneration = 0, creditState, knownPrivacy, purchaseInfoKey, purchaseInfoGeneration = 0, cancelledPurchases = new Set();
const pageTitles = { chat: "Chat", models: "Models", plugins: "Plugins", wallet: "Wallet", credits: "Credits and Usage", "buy-credits": "Buy credits", earning: "Earn KOIN", network: "Network", settings: "Settings" };
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const text = (id, value) => { if ($(id).textContent !== String(value ?? "")) $(id).textContent = value ?? ""; };
function notify(message, error = false) { $("notice").textContent = String(message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""); $("notice").hidden = false; $("notice").classList.toggle("error", error); }
async function action(button, fn) { if (button) button.disabled = true; try { return await fn(); } catch (e) { notify(e.message, true); } finally { if (button) button.disabled = false; await refresh(); } }
async function api(route, body) { const r = await fetch(route, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw Error(j.error?.message || j.error || "Request failed"); return j; }
function hideBackup() { text("wallet-backup", ""); $("wallet-backup").hidden = true; $("hide-backup").hidden = true; }
window.addEventListener("blur", hideBackup);
document.addEventListener("visibilitychange", () => { if (document.hidden) hideBackup(); });
function showPage(next) {
  if (!Object.hasOwn(pageTitles, next)) return;
  if (next !== "wallet") hideBackup();
  if (page !== next) {
    if (page === "chat") window.KaiCoreChat?.hide();
    if (page === "earning") window.KaiCoreEarning?.leave();
    if (page === "network") window.KaiCoreNetwork?.leave();
    priceGeneration++;
  }
  page = next;
  document.querySelectorAll("[data-panel]").forEach(n => n.hidden = n.dataset.panel !== next);
  document.querySelectorAll("[data-page]").forEach(n => {
    const selected = n.dataset.page === (next === "buy-credits" ? "credits" : next);
    n.classList.toggle("selected", selected); n.setAttribute("aria-current", selected ? "page" : "false");
  });
  text("workspace-title", pageTitles[next]);
  if (next === "chat") window.KaiCoreChat?.show();
  if (next === "earning") window.KaiCoreEarning?.enter();
  if (next === "network") window.KaiCoreNetwork?.enter();
  if (next === "credits") { renderCredits(); void refreshCreditActivity(); }
  if (next === "buy-credits") void price();
}
for (const b of document.querySelectorAll("[data-page],[data-go]")) b.onclick = () => showPage(b.dataset.page || b.dataset.go);
window.addEventListener("kai-core-navigate", event => showPage(event.detail?.page));
function html(id, value) { if ($(id).innerHTML !== value) $(id).innerHTML = value; }
async function refresh() {
  if (!bridge || refreshing || document.hidden) return; refreshing = true;
  try {
    snapshot = await bridge.call("status"); const s = snapshot;
    applyPrivacy(s.network.privacyMode);
    text("version", `v${s.version}`);
    text("closing-window-detail", s.desktop?.trayAvailable ? "Closing the window keeps KAI and earning running in the system tray. Click the tray icon to reopen it, or choose Quit KAI Core from its menu to stop the app." : "A system tray icon is not available on this desktop. Closing the window will quit KAI Core.");
    const address = s.wallet.address;
    text("wallet-state", address ? s.wallet.unlocked ? "Unlocked on this computer" : "Saved wallet · locked" : "Create or restore your wallet");
    text("wallet-address", address || "No wallet created"); text("wallet-detail", s.wallet.unlocked ? "Wallet unlocked. Plugins never receive its private key." : "Unlock to authorize wallet actions.");
    $("create-wallet").hidden = s.wallet.exists; $("restore-wallet").hidden = s.wallet.exists; $("unlock-button").hidden = !s.wallet.exists || s.wallet.unlocked; $("lock-wallet").hidden = !s.wallet.unlocked;
    if (document.activeElement !== $("privacy")) $("privacy").value = s.network.privacyMode;
    text("model-message", s.ensure?.state === "error" ? s.ensure.error || "The model could not be loaded. Try another model or retry."
      : s.importError || (s.importing ? `Importing model · ${Math.round(s.importing.pct || 0)}%`
      : s.ensure?.state === "working" ? `Preparing ${s.ensure.alias}…` : ""));
    text("download", s.download ? `Downloading · ${Math.round(s.download.pct || 0)}%` : s.runtime.activeAlias ? `Loaded: ${s.runtime.activeAlias}` : "");
    html("models", s.models.map(m => `<article><div class="row"><h2>${esc(m.label || m.alias)}</h2><span class="pill">${esc(m.status)}</span></div><p>${esc(m.alias)}</p><button data-model="${esc(m.alias)}">${m.status === "ready" ? "Load model" : "Download & load"}</button></article>`).join(""));
    html("plugins", s.plugins.length ? s.plugins.map(p => {
      const display = window.KaiPluginPresentation.get(p.id, p);
      return `<article class="plugin-card"><div class="plugin-heading"><span class="plugin-icon" aria-hidden="true">${display.icon}</span><div><h2>${esc(display.name)}</h2><span class="pill">${p.enabled ? "Enabled" : "Disabled"}</span></div></div><p class="plugin-description">${esc(display.description)}</p><p class="muted">Version ${esc(p.version)}</p><div class="actions">${p.enabled ? `<button data-plugin="${esc(p.id)}" data-operation="open">Open</button>` : ""}<button data-plugin="${esc(p.id)}" data-operation="${p.enabled ? "disable" : "enable"}">${p.enabled ? "Disable" : "Enable"}</button>${p.rollbackAvailable ? `<button data-plugin="${esc(p.id)}" data-operation="rollback">Roll back</button>` : ""}<button data-plugin="${esc(p.id)}" data-operation="remove">Remove</button></div></article>`;
    }).join("") : "<article><h2>Your workspace starts here</h2><p>No plugins installed yet. Choose a plugin below to add the tools you need.</p></article>");
    window.KaiCoreChat?.update(s);
    renderCatalog();
  } catch (e) { notify(e.message, true); } finally { refreshing = false; }
}
function renderCatalog() {
  if (!snapshot || !$("plugin-catalog")) return;
  const s = snapshot, query = ($("plugin-search")?.value || "").trim().toLowerCase();
  const rows = (s.catalog || []).filter(p => { const display = window.KaiPluginPresentation.get(p.id, p); return `${display.name} ${display.description} ${p.id}`.toLowerCase().includes(query); });
  html("plugin-catalog", rows.length ? rows.map(p => {
    const display = window.KaiPluginPresentation.get(p.id, p);
    const installed = s.plugins.some(x => x.id === p.id && x.version === p.version), blocked = p.compatible === false;
    const older = s.plugins.some(x => x.id === p.id);
    return `<article class="plugin-card"><div class="plugin-heading"><span class="plugin-icon" aria-hidden="true">${display.icon}</span><div><h2>${esc(display.name)}</h2><span class="pill">${p.official ? "KAI" : "Community"}</span></div></div><p class="plugin-description">${esc(display.description)}</p><p class="muted">Version ${esc(p.version)}${p.minCoreVersion ? ` · Core ${esc(p.minCoreVersion)}+` : ""}</p>${blocked ? `<p>${esc(p.compatibilityReason || "Update Core to use this plugin.")}</p>` : ""}<button data-install-plugin="${esc(p.id)}" ${installed || blocked ? "disabled" : ""}>${installed ? "Installed" : blocked ? "Requires newer Core" : older ? "Review update" : "Install"}</button></article>`;
  }).join("") : "<p>No plugins match your search.</p>");
  const r = s.registry;
  text("registry-status", r?.available && !r.expired ? `Signed catalog ${r.version} · ${r.count} plugins. Refresh to check for new releases.` : r?.present ? `Catalog unavailable: ${r.error || "Refresh the catalog to continue."} You can still open installed plugins or install a signed package directly.` : r?.error ? `Catalog refresh failed: ${r.error}. Showing bundled KAI releases.` : "Showing bundled KAI releases. Refresh to load the signed public catalog.");
}
if ($("plugin-search")) $("plugin-search").oninput = renderCatalog;
if ($("refresh-registry")) $("refresh-registry").onclick = e => action(e.currentTarget, async () => { const r = await bridge.call("plugins.registry.refresh"); notify(`Catalog ${r.version} verified · ${r.count} plugins available.`); });
$("models").onclick = e => { const b = e.target.closest("[data-model]"); if (b) void action(b, () => api("/core/models/ensure", { alias: b.dataset.model })); };
$("plugins").onclick = e => { const b = e.target.closest("[data-plugin]"); if (!b) return; void action(b, () => bridge.call(b.dataset.operation === "open" ? "plugins.open" : "plugins.change", { id: b.dataset.plugin, action: b.dataset.operation })); };
if ($("plugin-catalog")) $("plugin-catalog").onclick = e => { const b = e.target.closest("[data-install-plugin]"); if (b) void action(b, () => bridge.call("plugins.install", { id: b.dataset.installPlugin })); };
$("install-file").onclick = e => action(e.currentTarget, () => bridge.call("plugins.install"));
$("install-url").onsubmit = e => { e.preventDefault(); void action(e.submitter, () => bridge.call("plugins.install", { url: $("plugin-url").value })); };
function applyPrivacy(mode) {
  if (mode === knownPrivacy) return;
  knownPrivacy = mode; priceGeneration++; purchaseInfoGeneration++; cancelledPurchases.clear();
  window.dispatchEvent(new CustomEvent("kai-core-privacy-changed", { detail: { mode } }));
  if (mode === "local-only") text("price", "Choose an online mode in Settings to buy credits.");
}
$("privacy").onchange = e => action(e.currentTarget, async () => {
  const mode = e.target.value; await bridge.call("privacy", { mode }); applyPrivacy(mode);
  window.KaiCredits.clear(); await window.KaiCredits.refresh();
});
$("unlock-wallet").onsubmit = e => { e.preventDefault(); void action(e.submitter, async () => { try { await bridge.call("wallet.unlock", { password: $("password").value }); } finally { $("password").value = ""; } }); };
async function createWallet(restore) { try { const r = await bridge.call(restore ? "wallet.restore" : "wallet.create", { password: $("password").value, ...(restore ? { wif: $("restore-wif").value } : {}) }); if (r.wif) { text("wallet-backup", `Save this backup key privately:\n${r.wif}`); $("wallet-backup").hidden = false; $("hide-backup").hidden = false; } notify("Wallet ready."); } finally { $("password").value = ""; $("restore-wif").value = ""; } }
$("create-wallet").onclick = e => action(e.currentTarget, () => createWallet(false));
$("restore-button").onclick = e => action(e.currentTarget, () => createWallet(true));
$("hide-backup").onclick = hideBackup;
$("lock-wallet").onclick = e => { hideBackup(); return action(e.currentTarget, () => bridge.call("wallet.lock")); };
$("connect-wallet").onclick = e => action(e.currentTarget, async () => { await bridge.credit("wallet-connect"); window.KaiCredits.clear(); await window.KaiCredits.refresh(); });
$("import-model").onclick = e => action(e.currentTarget, async () => { const r = await bridge.call("models.import"); if (r) await api("/core/models/import", { path: r.file }); });
$("cancel-download").onclick = e => action(e.currentTarget, () => api("/core/models/download/cancel", {}));
let priceBusy = false;
async function price() { if (!bridge || priceBusy || page !== "buy-credits" || snapshot?.network.privacyMode === "local-only") return; priceBusy = true; const generation = ++priceGeneration, usd = $("usd").value; try { const r = await bridge.credit("purchase-estimate", { usd }); if (generation === priceGeneration) text("price", `Estimated payment: ${r.estimate.koin} KOIN · ${r.estimate.credits} credits`); } catch (e) { if (generation === priceGeneration) text("price", e.message); } finally { priceBusy = false; } }
$("usd").oninput = () => { priceGeneration++; text("price", "The exact KOIN payment will be shown before approval."); };
$("buy-credits").onsubmit = e => { e.preventDefault(); const usd = $("usd").value; void action(e.submitter, async () => {
  text("purchase-state", "Preparing purchase…");
  try {
    const connected = await bridge.credit("purchase-connect");
    if (connected.state === "cancelled") { text("purchase-state", "Purchase cancelled. No payment was approved."); return; }
    if (connected.state && !["ready", "connected"].includes(connected.state)) throw Error(connected.detail || "Unlock and connect your wallet to continue");
    const r = await bridge.credit("purchase-preview", { usd });
    if ($("usd").value !== usd) throw Error("Amount changed. Review a new quote.");
    text("price", `${r.quote.koin} KOIN · ${r.quote.credits} credits`);
    const done = await bridge.credit("purchase-approve", r.quote.id);
    text("purchase-state", done.detail || (done.state === "cancelled" ? "Purchase cancelled." : done.state) || "Purchase submitted; confirmation may take a moment.");
    await window.KaiCredits.refresh();
  } catch (error) {
    text("purchase-state", error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
    text("price", "Review a fresh quote before trying again."); throw error;
  }
}); };
$("purchase-retry").onclick = e => action(e.currentTarget, async () => {
  text("purchase-state", "Checking saved purchase…");
  try { const r = await bridge.credit("credit-purchase-retry"); text("purchase-state", r.detail || r.state); await window.KaiCredits.refresh(); }
  catch (error) { text("purchase-state", error.message); throw error; }
});
$("check-updates").onclick = e => action(e.currentTarget, async () => {
  text("update-state", "Checking for a published update…");
  try { text("update-state", (await bridge.call("updates.check")).message); }
  catch (error) {
    const unavailable = /ERR_UPDATER_(?:NO_PUBLISHED_VERSIONS|LATEST_VERSION_NOT_FOUND|CHANNEL_FILE_NOT_FOUND)|No published versions on GitHub|please ensure a production release exists/.test(error.message);
    text("update-state", unavailable ? "No automatic update has been published for KAI Core yet. Preview builds currently require the manual download link." : "The update check could not finish. Try again when your connection is available.");
    if (!unavailable) throw error;
  }
});
async function refreshCreditActivity() {
  await window.KaiCredits.refresh();
  if (!bridge || !window.KaiCreditPresentation(creditState || {}).usd || knownPrivacy === "local-only") return;
  const key = creditState.snapshot.key, generation = ++purchaseInfoGeneration;
  try {
    const info = await bridge.credit("purchase-info");
    if (generation !== purchaseInfoGeneration || key !== creditState?.snapshot?.key) return;
    cancelledPurchases = new Set((Array.isArray(info?.cancelledPurchases) ? info.cancelledPurchases : []).map(p => p?.txId).filter(id => typeof id === "string"));
    renderCredits();
  } catch { /* The verified server activity remains available if local payment history cannot be read. */ }
}
// Activity amounts use the same integer credit units as the verified balance.
function creditAmount(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > (1n << 64n) - 1n) return null;
  const n = BigInt(value), fraction = String(n % 100000n).padStart(5, "0").replace(/0+$/, "");
  return (n / 100000n).toLocaleString() + (fraction ? "." + fraction : "");
}
function renderCredits() {
  if (!creditState) return;
  const p = window.KaiCreditPresentation(creditState), s = creditState.snapshot;
  text("credits", p.total); text("credit-breakdown", p.breakdown); text("credit-detail", [p.status, p.detail].filter(Boolean).join(" "));
  if (!p.usd) {
    html("credit-activity", `<p class="muted">${esc(s ? "Activity for USD credits will appear here when connected." : creditState.status === "loading" ? "Loading your credit activity…" : "Credit activity is unavailable. Try refreshing your credits.")}</p>`);
    text("credit-activity-status", ""); return;
  }
  const filter = $("credit-filter").value || "all";
  const when = value => { const stamp = Number(value); return Number.isFinite(stamp) && stamp > 0 && Number.isFinite(new Date(stamp).getTime()) ? stamp : 0; };
  const rows = [
    ...(Array.isArray(s.usage) ? s.usage : []).slice(0, 500).filter(u => u && typeof u === "object").map(u => ({ kind: "usage", title: `Chat${u.model ? " · " + String(u.model).slice(0, 120) : ""}`, at: when(u.at), status: "Delivered", amount: creditAmount(u.credits), prefix: "−" })),
    ...(Array.isArray(s.purchases) ? s.purchases : []).slice(0, 500).filter(u => u && typeof u === "object").map(u => {
      const confirmed = u.state === "confirmed", cancelled = !confirmed && (u.state === "cancelled" || cancelledPurchases.has(u.id));
      return { kind: "purchase", title: "Purchased credits", at: when(u.confirmedAt || u.createdAt), status: confirmed ? "Added to balance" : cancelled ? "Cancelled · no purchase" : String(u.state || "Pending").replaceAll("_", " ").slice(0, 100), amount: confirmed ? creditAmount(u.credits ?? u.amount) : cancelled ? "0" : "Pending", prefix: confirmed ? "+" : "" };
    }),
  ].filter(r => filter === "all" || r.kind === filter).sort((a, b) => b.at - a.at);
  html("credit-activity", rows.length ? `<div class="table-scroll"><table class="activity-table"><thead><tr><th scope="col">Activity</th><th scope="col">When</th><th scope="col">Status</th><th scope="col">Credits</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.title)}</td><td>${esc(r.at ? new Date(r.at).toLocaleString() : "—")}</td><td>${esc(r.status)}</td><td>${r.amount === null ? "Unavailable" : esc(r.prefix + r.amount)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">${filter === "usage" ? "Your network chat usage will appear here." : filter === "purchase" ? "Your credit purchases will appear here." : "Your purchases and network chat usage will appear here."}</p>`);
  text("credit-activity-status", p.stale ? "Showing your last verified activity. Refresh when your connection is available." : `Checked ${new Date(s.receivedAt).toLocaleString()}`);
}
$("credit-filter").onchange = renderCredits;
window.KaiCredits.subscribe(state => {
  const key = state.snapshot?.key;
  if (!state.snapshot || purchaseInfoKey !== key) { purchaseInfoGeneration++; cancelledPurchases.clear(); purchaseInfoKey = key; }
  creditState = state; renderCredits();
});
if (!bridge) notify("Open KAI Core desktop to use this workspace.", true); else void refresh().then(() => { if (page === "chat") showPage("chat"); });
setInterval(() => { if (!document.hidden) { void refresh(); renderCredits(); } }, 5000);
setInterval(() => { if (!document.hidden) void price(); }, 30000);
