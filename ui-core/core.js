"use strict";
const $ = id => document.getElementById(id), bridge = window.kaiCore;
let snapshot, page = "overview", refreshing = false, providerRunning = false, providerBusy = false, priceGeneration = 0;
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const text = (id, value) => { if ($(id).textContent !== String(value ?? "")) $(id).textContent = value ?? ""; };
function notify(message, error = false) { $("notice").textContent = String(message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""); $("notice").hidden = false; $("notice").classList.toggle("error", error); }
async function action(button, fn) { if (button) button.disabled = true; try { return await fn(); } catch (e) { notify(e.message, true); } finally { if (button) button.disabled = false; await refresh(); } }
async function api(route, body) { const r = await fetch(route, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw Error(j.error?.message || j.error || "Request failed"); return j; }
function hideBackup() { text("wallet-backup", ""); $("wallet-backup").hidden = true; $("hide-backup").hidden = true; }
window.addEventListener("blur", hideBackup);
document.addEventListener("visibilitychange", () => { if (document.hidden) hideBackup(); });
function showPage(next) { if (next !== "wallet") hideBackup(); page = next; document.querySelectorAll("[data-panel]").forEach(n => n.hidden = n.dataset.panel !== next); document.querySelectorAll("[data-page]").forEach(n => { n.classList.toggle("selected", n.dataset.page === next); n.setAttribute("aria-current", n.dataset.page === next ? "page" : "false"); }); if (next === "earning") { void provider(); void rewards(); } if (next === "wallet") void price(); }
for (const b of document.querySelectorAll("[data-page],[data-go]")) b.onclick = () => showPage(b.dataset.page || b.dataset.go);
function html(id, value) { if ($(id).innerHTML !== value) $(id).innerHTML = value; }
async function refresh() {
  if (!bridge || refreshing || document.hidden) return; refreshing = true;
  try {
    snapshot = await bridge.call("status"); const s = snapshot, ready = s.models.filter(m => m.status === "ready");
    text("version", `v${s.version}`); text("model-count", ready.length); text("plugin-count", s.plugins.length);
    const address = s.wallet.address; text("wallet-short", address ? `${address.slice(0,5)}…${address.slice(-4)}` : "Not set up");
    text("wallet-state", address ? s.wallet.unlocked ? "Unlocked on this computer" : "Saved wallet · locked" : "Create or restore your wallet");
    text("wallet-address", address || "No wallet created"); text("wallet-detail", s.wallet.unlocked ? "Wallet unlocked. Plugins never receive its private key." : "Unlock to authorize wallet actions.");
    $("create-wallet").hidden = s.wallet.exists; $("restore-wallet").hidden = s.wallet.exists; $("unlock-button").hidden = !s.wallet.exists || s.wallet.unlocked; $("lock-wallet").hidden = !s.wallet.unlocked;
    text("profile-title", s.profile.mode === "existing" ? "Your existing workspace is connected" : "Your new workspace is ready");
    text("profile-detail", s.profile.mode === "existing" ? "Your wallet and installed models are read from the same profile. Nothing needs to be moved." : "Models and settings will be saved in your KAI profile.");
    html("preserved", Object.entries(s.profile.preserved).filter(([, v]) => v).map(([k]) => `<span class="pill">${esc({wallet:"Wallet",chats:"Chat history",workflowsAndBrain:"Workflows & Brain",agentNetwork:"Agent services",node:"Node data"}[k])} preserved</span>`).join(""));
    text("profile-path", s.profile.dataDir); text("backup-path", s.profile.backup || "New profile — no previous configuration to back up");
    if (document.activeElement !== $("privacy")) $("privacy").value = s.network.privacyMode;
    text("model-message", s.ensure?.state === "error" ? s.ensure.error || "The model could not be loaded. Try another model or retry."
      : s.importError || (s.importing ? `Importing model · ${Math.round(s.importing.pct || 0)}%`
      : s.ensure?.state === "working" ? `Preparing ${s.ensure.alias}…` : ""));
    text("download", s.download ? `Downloading · ${Math.round(s.download.pct || 0)}%` : s.runtime.activeAlias ? `Loaded: ${s.runtime.activeAlias}` : "");
    html("models", s.models.map(m => `<article><div class="row"><h2>${esc(m.label || m.alias)}</h2><span class="pill">${esc(m.status)}</span></div><p>${esc(m.alias)}</p><button data-model="${esc(m.alias)}">${m.status === "ready" ? "Load model" : "Download & load"}</button></article>`).join(""));
    html("plugins", s.plugins.length ? s.plugins.map(p => `<article><div class="row"><h2>${esc(p.name)}</h2><span class="pill">${p.enabled ? "Enabled" : "Disabled"}</span></div><p>Version ${esc(p.version)}</p><p class="muted">${esc(p.permissions.join(" · ") || "No capabilities requested")}</p><div class="actions">${p.enabled ? `<button data-plugin="${esc(p.id)}" data-operation="open">Open</button>` : ""}<button data-plugin="${esc(p.id)}" data-operation="${p.enabled ? "disable" : "enable"}">${p.enabled ? "Disable" : "Enable"}</button>${p.rollbackAvailable ? `<button data-plugin="${esc(p.id)}" data-operation="rollback">Roll back</button>` : ""}<button data-plugin="${esc(p.id)}" data-operation="remove">Remove</button></div></article>`).join("") : "<article><h2>Your workspace starts here</h2><p>No plugins installed yet. Choose a signed package to add your first capability.</p></article>");
    if ($("plugin-catalog")) html("plugin-catalog", (s.catalog || []).map(p => `<article><h2>${esc(p.name)}</h2><p>Version ${esc(p.version)} · verified KAI publisher</p><button data-install-plugin="${esc(p.id)}" ${s.plugins.some(x => x.id === p.id && x.version === p.version) ? "disabled" : ""}>${s.plugins.some(x => x.id === p.id && x.version === p.version) ? "Installed" : "Install"}</button></article>`).join(""));
  } catch (e) { notify(e.message, true); } finally { refreshing = false; }
}
$("models").onclick = e => { const b = e.target.closest("[data-model]"); if (b) void action(b, () => api("/core/models/ensure", { alias: b.dataset.model })); };
$("plugins").onclick = e => { const b = e.target.closest("[data-plugin]"); if (!b) return; void action(b, () => bridge.call(b.dataset.operation === "open" ? "plugins.open" : "plugins.change", { id: b.dataset.plugin, action: b.dataset.operation })); };
if ($("plugin-catalog")) $("plugin-catalog").onclick = e => { const b = e.target.closest("[data-install-plugin]"); if (b) void action(b, () => bridge.call("plugins.install", { id: b.dataset.installPlugin })); };
$("install-file").onclick = e => action(e.currentTarget, () => bridge.call("plugins.install"));
$("install-url").onsubmit = e => { e.preventDefault(); void action(e.submitter, () => bridge.call("plugins.install", { url: $("plugin-url").value })); };
$("privacy").onchange = e => action(e.currentTarget, async () => { await bridge.call("privacy", { mode: e.target.value }); window.KaiCredits.clear(); await window.KaiCredits.refresh(); });
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
async function price() { if (!bridge || priceBusy || page !== "wallet" || snapshot?.network.privacyMode === "local-only") return; priceBusy = true; const generation = ++priceGeneration, usd = $("usd").value; try { const r = await bridge.credit("purchase-estimate", { usd }); if (generation === priceGeneration) text("price", `Estimated payment: ${r.estimate.koin} KOIN · ${r.estimate.credits} credits`); } catch (e) { if (generation === priceGeneration) text("price", e.message); } finally { priceBusy = false; } }
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
async function provider() { if (providerBusy || page !== "earning") return; providerBusy = true; try { const [info, state] = await Promise.all([bridge.credit("provider-public-info"), bridge.credit("provider-public-status")]); providerRunning = info.running || info.enabled; $("earning-toggle").setAttribute("aria-checked", String(Boolean(providerRunning))); text("earning-toggle", providerRunning ? "ON" : "OFF"); text("provider-label", state.label || state.state || "OFFLINE"); text("provider-detail", state.detail || info.detail || ""); text("provider-models", (info.offeredModels || []).join(" · ")); $("authorize-earning").hidden = !info.canAuthorize; } catch (e) { text("provider-detail", e.message); } finally { providerBusy = false; } }
let rewardsBusy = false, lastRewards = null;
const koin = atoms => { const value = BigInt(atoms), fraction = String(value % 100000000n).padStart(8, "0").replace(/0+$/, ""); return (value / 100000000n).toLocaleString() + (fraction ? "." + fraction : ""); };
async function rewards() {
  if (rewardsBusy || page !== "earning") return; rewardsBusy = true;
  try {
    const value = await bridge.credit("provider-public-earnings");
    const rows = [...(value.summary?.pending || []), ...value.payouts].sort((a, b) => Number(b.epoch) - Number(a.epoch));
    let markup = value.summary?.current?.availability != null ? `<p>Today's availability estimate: <strong>${esc(koin(value.summary.current.availability))} KOIN</strong></p>` : "";
    markup += rows.length ? rows.slice(0, 12).map(r => `<div class="row"><span>${esc(new Date(Number(r.epoch) * 86400000).toLocaleDateString())} · ${esc(r.state.replaceAll("_", " "))}</span><strong>${esc(koin((BigInt(r.availability) + BigInt(r.work)).toString()))} KOIN</strong></div>`).join("") : "<p>No reward allocations have been reported yet.</p>";
    lastRewards = value; html("rewards", markup); text("reward-status", `Checked ${new Date(value.observedAt).toLocaleTimeString()}`);
  } catch (error) {
    if (!lastRewards) html("rewards", "<p>Reward history is currently unavailable.</p>");
    text("reward-status", `${lastRewards ? "Showing the last verified reward history. " : ""}${error.message}`);
  } finally { rewardsBusy = false; }
}
$("earning-toggle").onclick = e => action(e.currentTarget, async () => { await bridge.credit(providerRunning ? "provider-public-stop" : "provider-public-start"); await provider(); });
$("authorize-earning").onclick = e => action(e.currentTarget, async () => { await bridge.credit("provider-public-authorize"); await provider(); });
$("download-provider").onclick = e => action(e.currentTarget, async () => { await bridge.credit("provider-public-download"); await provider(); });
$("check-updates").onclick = e => action(e.currentTarget, async () => text("update-state", (await bridge.call("updates.check")).message));
window.KaiCredits.subscribe(state => { const p = window.KaiCreditPresentation(state); text("credits", p.total); text("credit-breakdown", p.breakdown); text("credit-detail", p.status || p.detail); });
if (!bridge) notify("Open KAI Core desktop to use this workspace.", true); else void refresh();
setInterval(() => { if (!document.hidden) { void refresh(); if (page === "earning") void provider(); } }, 5000);
setInterval(() => { if (!document.hidden) void price(); }, 30000);
setInterval(() => { if (!document.hidden && page === "earning") void rewards(); }, 15000);
