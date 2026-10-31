"use strict";
const $ = id => document.getElementById(id), bridge = window.kaiCore;
let snapshot, page = "chat", activeAppId = null, refreshing = false, priceGeneration = 0, creditState, knownPrivacy, knownWalletAddress, purchaseInfoKey, purchaseInfoGeneration = 0, walletSecretGeneration = 0, cancelledPurchases = new Set();
const pageTitles = { chat: "Chat", app: "App", models: "Models", plugins: "Plugins", wallet: "Wallet", credits: "Credits and Usage", "buy-credits": "Buy credits", earning: "Earn KOIN", network: "Network", settings: "Settings" };
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const makeNotice = (container, message, close, focusTarget) => window.KaiCoreNotice.create({ container: $(container), message: $(message), close: $(close), focusTarget });
const globalNotice = makeNotice("notice", "notice-message", "notice-close", () => page === "wallet" ? $("password") : document.querySelector('[data-page][aria-current="page"]'));
const notices = {
  "model-message": makeNotice("model-notice", "model-message", "model-message-close", () => $("import-model")),
  "purchase-state": makeNotice("purchase-notice", "purchase-state", "purchase-close", () => $("usd")),
  "update-state": makeNotice("update-notice", "update-state", "update-close", () => $("check-updates")),
};
let noticeSource = "action";
const text = (id, value) => { if (notices[id]) notices[id].show(value); else if ($(id).textContent !== String(value ?? "")) $(id).textContent = value ?? ""; };
function notify(message, error = false, { background = false } = {}) {
  noticeSource = background ? "refresh" : "action";
  globalNotice.show(String(message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""), { error, force: !background });
}
async function action(button, fn) { globalNotice.clear(); if (button) button.disabled = true; try { return await fn(); } catch (e) { notify(e.message, true); } finally { if (button) button.disabled = false; await refresh(); } }
const apps = window.KaiCoreApps?.create({ document, bridge, open: plugin => { void openApp(plugin); }, manage: plugin => {
  showPage("plugins"); notify(`${window.KaiPluginPresentation.get(plugin.id, plugin).name} is disabled. Choose Enable in Your installed plugins to use it.`);
}, notify });
function appBounds() {
  const rect = $("app-content")?.getBoundingClientRect?.();
  return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
}
function syncAppBounds() {
  if (page !== "app" || !activeAppId) return;
  const bounds = appBounds();
  if (bounds?.width > 0 && bounds?.height > 0) void bridge.call("plugins.bounds", { id: activeAppId, ...bounds }).catch(() => {});
}
if (typeof ResizeObserver === "function") new ResizeObserver(syncAppBounds).observe($("app-content"));
window.addEventListener("resize", syncAppBounds);
async function openApp(plugin) {
  if (!plugin?.enabled) return;
  globalNotice.clear();
  showPage("app", { id: plugin.id, name: window.KaiPluginPresentation.get(plugin.id, plugin).name });
  try { await bridge.call("plugins.open", { id: plugin.id, bounds: appBounds() }); }
  catch (error) {
    if (page === "app" && activeAppId === plugin.id) { showPage("plugins"); notify(error.message, true); }
  } finally { await refresh(); }
}
async function api(route, body) { const r = await fetch(route, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw Error(j.error?.message || j.error || "Request failed"); return j; }
function hideBackup() { walletSecretGeneration++; text("wallet-backup", ""); $("wallet-backup").hidden = true; $("hide-backup").hidden = true; window.KaiCoreWallet?.clearSecrets(); }
window.addEventListener("blur", hideBackup);
document.addEventListener("visibilitychange", () => { if (document.hidden) hideBackup(); });
function showPage(next, app) {
  if (!Object.hasOwn(pageTitles, next)) return;
  if (next === "app" && !app?.id && !activeAppId) return;
  if (next !== "wallet") hideBackup();
  if (page !== next) {
    if (page === "chat") window.KaiCoreChat?.hide();
    if (page === "earning") window.KaiCoreEarning?.leave();
    if (page === "network") window.KaiCoreNetwork?.leave();
    if (page === "wallet") window.KaiCoreWallet?.leave();
    if (page === "credits") window.KaiCreditConnection?.leave();
    if (page === "app") void bridge.call("plugins.hide").catch(error => notify(error.message, true));
    priceGeneration++;
  }
  page = next;
  activeAppId = next === "app" ? app?.id || activeAppId : null;
  apps?.select(activeAppId);
  document.querySelectorAll("[data-panel]").forEach(n => n.hidden = n.dataset.panel !== next);
  document.querySelectorAll("[data-page]").forEach(n => {
    const selected = n.dataset.page === (next === "buy-credits" ? "credits" : next);
    n.classList.toggle("selected", selected); n.setAttribute("aria-current", selected ? "page" : "false");
  });
  const title = next === "app" ? window.KaiPluginPresentation.get(activeAppId, snapshot?.plugins?.find(plugin => plugin.id === activeAppId) || app).name : pageTitles[next];
  text("workspace-title", title);
  if (next === "app") text("app-loading", `Opening ${title}…`);
  if (next === "app") syncAppBounds();
  if (next === "chat") window.KaiCoreChat?.show();
  if (next === "earning") window.KaiCoreEarning?.enter();
  if (next === "network") window.KaiCoreNetwork?.enter();
  if (next === "wallet") window.KaiCoreWallet?.enter();
  if (next === "plugins") void checkPluginCatalog();
  if (next === "settings") window.KaiCoreAccount?.enter();
  if (next === "credits") { renderCredits(); void refreshCreditActivity(); void window.KaiCreditConnection?.enter(); }
  if (next === "buy-credits") void price();
}
for (const b of document.querySelectorAll("[data-page],[data-go]")) b.onclick = () => showPage(b.dataset.page || b.dataset.go);
window.addEventListener("kai-core-navigate", event => showPage(event.detail?.page));
bridge?.onOpenView?.(target => {
  showPage(typeof target === "string" ? target : target?.page, typeof target === "object" ? target : undefined);
  if (target?.error) notify(target.error, true);
  if (target?.section === "website-account") window.KaiCoreAccount?.openWebsite();
  if (target?.section === "credit-account") window.KaiCoreAccount?.openCredit();
});
function html(id, value) { if ($(id).innerHTML !== value) $(id).innerHTML = value; }
document.addEventListener("kai-alpha-migration-complete", () => { void refresh(); });
async function refresh() {
  if (!bridge || refreshing || document.hidden) return; refreshing = true;
  try {
    snapshot = await bridge.call("status"); const s = snapshot;
    applyPrivacy(s.network.privacyMode);
    text("version", `v${s.version}`);
    text("closing-window-detail", s.desktop?.trayAvailable ? "Closing the window keeps KAI and earning running in the system tray. Click the tray icon to reopen it, or choose Quit KAI Core Beta from its menu to stop the app." : "A system tray icon is not available on this desktop. Closing the window will quit KAI Core Beta.");
    const address = s.wallet.address;
    if (knownWalletAddress !== undefined && knownWalletAddress !== (address || null)) {
      hideBackup();
      window.dispatchEvent(new CustomEvent("kai-credit-identity-changed"));
    }
    knownWalletAddress = address || null;
    text("wallet-state", address ? s.wallet.unlocked ? "Unlocked on this computer" : "Saved wallet · locked" : "Create or restore your wallet");
    text("wallet-address", address || "No wallet created"); text("wallet-detail", s.wallet.unlocked ? "Wallet unlocked. Core’s plugin API does not share its private key." : "Unlock to authorize wallet actions.");
    $("create-wallet").hidden = s.wallet.exists; $("restore-wallet").hidden = s.wallet.exists; $("unlock-button").hidden = !s.wallet.exists || s.wallet.unlocked; $("lock-wallet").hidden = !s.wallet.unlocked;
    window.KaiCoreWallet?.observe(s.wallet, s.network.privacyMode);
    window.KaiCreditConnection?.observe(s.wallet, s.network.privacyMode);
    if (document.activeElement !== $("privacy")) $("privacy").value = s.network.privacyMode;
    const modelBusy = !!s.importing || s.ensure?.state === "working";
    const modelError = !modelBusy && (s.ensure?.state === "error" || !!s.importError);
    notices["model-message"].show(s.importing ? `Importing model · ${Math.round(s.importing.pct || 0)}%`
      : s.ensure?.state === "working" ? `Preparing ${s.ensure.alias}…`
      : s.ensure?.state === "error" ? s.ensure.error || "The model could not be loaded. Try another model or retry."
      : s.importError || "", { error: modelError, dismissible: !modelBusy });
    text("download", s.download ? `Downloading · ${Math.round(s.download.pct || 0)}%` : s.runtime.activeAlias ? `Loaded: ${s.runtime.activeAlias}` : "");
    html("models", s.models.map(m => `<article><div class="row"><h2>${esc(m.label || m.alias)}</h2><span class="pill">${esc(m.status)}</span></div><p>${esc(m.alias)}</p><button data-model="${esc(m.alias)}">${m.status === "ready" ? "Load model" : "Download & load"}</button></article>`).join(""));
    renderInstalledPlugins();
    apps?.update(s);
    if (activeAppId && !s.plugins.some(plugin => plugin.id === activeAppId && plugin.enabled)) showPage("plugins");
    window.KaiCoreChat?.update(s);
    renderCatalog();
    if (noticeSource === "refresh") globalNotice.clear();
  } catch (e) { notify(e.message, true, { background: true }); } finally { refreshing = false; }
}
// Counts and publisher matching come from the native catalog snapshot. Rendering
// additionally binds each entry to the installed and catalog versions in it.
function pluginVersionOrder(left, right) {
  const valid = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
  if (!valid.test(left) || !valid.test(right)) return null;
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
function pluginUpdates() {
  const updates = new Map();
  for (const item of snapshot?.pluginUpdates?.updates || []) {
    const installed = snapshot.plugins.find(p => p.id === item.id), listed = snapshot.catalog?.find(p => p.id === item.id);
    if (installed && listed && (!installed.fingerprint || !listed.fingerprint || installed.fingerprint === listed.fingerprint) && installed.version === item.installedVersion && listed.version === item.version && pluginVersionOrder(item.version, item.installedVersion) === 1) updates.set(item.id, item);
  }
  return updates;
}
function pluginRepository(repository) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) return null;
  const [owner, name] = repository.split("/");
  if (name === "." || name === "..") return null;
  return { owner, repository, url: `https://github.com/${repository}` };
}
function pluginDeveloper(repository) {
  const source = pluginRepository(repository);
  if (!source) return "";
  const github = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 6v-3.9a3.4 3.4 0 0 0-1-2.7c3.3-.4 6.8-1.6 6.8-7.4A5.8 5.8 0 0 0 19.2 4a5.4 5.4 0 0 0-.1-4S17.8-.4 15 1.5a14.1 14.1 0 0 0-7 0C5.2-.4 3.9 0 3.9 0A5.4 5.4 0 0 0 3.8 4a5.8 5.8 0 0 0-1.6 4c0 5.8 3.5 7 6.8 7.4a3.4 3.4 0 0 0-1 2.7V22" transform="translate(1 1) scale(.92)"/></svg>';
  return `<div class="plugin-developer"><span>by <strong>${esc(source.owner)}</strong></span><a class="plugin-repository-link" href="${esc(source.url)}" data-plugin-repository="${esc(source.repository)}" aria-label="Open ${esc(source.repository)} on GitHub" title="View ${esc(source.repository)} on GitHub">${github}</a></div>`;
}
function pluginCardDisplay(plugin) {
  const display = window.KaiPluginPresentation.get(plugin.id, plugin);
  return { ...display, description: typeof plugin.description === "string" && plugin.description.trim() ? plugin.description : display.description };
}
function renderInstalledPlugins() {
  const s = snapshot, updates = pluginUpdates(), count = updates.size;
  text("plugin-update-count", count > 99 ? "99+" : String(count)); $("plugin-update-count").hidden = !count;
  const label = count ? `Plugins, ${count} ${count === 1 ? "update" : "updates"} available` : "Plugins";
  $("plugin-nav").setAttribute("aria-label", label); $("plugin-nav").setAttribute("title", label);
  $("plugin-updates").hidden = !count; text("plugin-updates-count", count);
  text("plugin-updates-title", `${count} plugin ${count === 1 ? "update" : "updates"} available`);
  const blocked = [...updates.values()].filter(item => item.compatible === false).length;
  text("plugin-updates-detail", blocked ? `${blocked} ${blocked === 1 ? "update needs" : "updates need"} a newer Core version. Review available updates below.` : "Review and install the new versions below.");
  html("plugins", s.plugins.length ? s.plugins.map(p => {
    const display = pluginCardDisplay(p), update = updates.get(p.id), blocked = update?.compatible === false;
    const updateLabel = update ? `<span class="pill plugin-update-label">${blocked ? "Core update required" : "Update available"}</span>` : "";
    const version = update ? `Version ${esc(p.version)} <span aria-hidden="true">→</span><span class="sr-only"> to </span> <strong>${esc(update.version)}</strong>` : `Version ${esc(p.version)}`;
    const updateButton = update ? `<button class="primary" data-install-plugin="${esc(p.id)}" ${blocked ? "disabled" : ""}>${blocked ? "Requires newer Core" : "Review update"}</button>` : "";
    return `<article class="plugin-card${update ? " plugin-update-available" : ""}" data-installed-plugin="${esc(p.id)}"><div class="plugin-heading"><span class="plugin-icon" aria-hidden="true">${display.icon}</span><div class="plugin-identity"><h2>${esc(display.name)}</h2>${pluginDeveloper(p.repository)}</div></div><div class="pills plugin-status"><span class="pill">${p.enabled ? "Enabled" : "Disabled"}</span>${updateLabel}</div><p class="plugin-description">${esc(display.description)}</p>${p.backgroundError ? `<p class="plugin-card-notice error">Background service needs attention: ${esc(p.backgroundError)}</p>` : ""}${blocked ? `<p class="plugin-card-notice">${esc(update.compatibilityReason || `Requires KAI Core Beta ${update.minCoreVersion || "a newer version"}.`)}</p>` : ""}<div class="plugin-card-footer"><p class="muted plugin-version">${version}</p><div class="actions">${updateButton}${p.enabled ? `<button${update ? "" : ' class="primary"'} data-plugin="${esc(p.id)}" data-operation="open">Open</button>` : ""}<button data-plugin="${esc(p.id)}" data-operation="${p.enabled ? "disable" : "enable"}">${p.enabled ? "Disable" : "Enable"}</button>${p.rollbackAvailable ? `<button data-plugin="${esc(p.id)}" data-operation="rollback">Roll back</button>` : ""}<button data-plugin="${esc(p.id)}" data-operation="remove">Remove</button></div></div></article>`;
  }).join("") : "<article><h2>Your workspace starts here</h2><p>No plugins installed yet. Choose a plugin below to add the tools you need.</p></article>");
}
function renderCatalog() {
  if (!snapshot || !$("plugin-catalog")) return;
  const s = snapshot, updates = pluginUpdates(), query = ($("plugin-search")?.value || "").trim().toLowerCase();
  const rows = (s.catalog || []).filter(p => { const display = pluginCardDisplay(p), source = pluginRepository(p.repository); return `${display.name} ${display.description} ${p.id} ${source?.owner || ""}`.toLowerCase().includes(query); });
  html("plugin-catalog", rows.length ? rows.map(p => {
    const display = pluginCardDisplay(p), installed = s.plugins.find(x => x.id === p.id), update = updates.get(p.id), blocked = p.compatible === false;
    const differentPublisher = installed && installed.fingerprint && p.fingerprint && installed.fingerprint !== p.fingerprint;
    const label = differentPublisher ? "Different publisher" : update ? blocked ? "Requires newer Core" : "Review update" : installed ? pluginVersionOrder(installed.version, p.version) === 1 ? "Newer version installed" : "Installed" : blocked ? "Requires newer Core" : "Install";
    const unavailable = blocked || differentPublisher || installed && !update;
    return `<article class="plugin-card${update ? " plugin-update-available" : ""}"><div class="plugin-heading"><span class="plugin-icon" aria-hidden="true">${display.icon}</span><div class="plugin-identity"><h2>${esc(display.name)}</h2>${pluginDeveloper(p.repository)}</div></div><div class="pills plugin-status"><span class="pill">${p.official ? "KAI" : "Community"}</span>${update ? '<span class="pill plugin-update-label">Update available</span>' : ""}</div><p class="plugin-description">${esc(display.description)}</p>${blocked ? `<p class="plugin-card-notice">${esc(p.compatibilityReason || "Update Core to use this plugin.")}</p>` : ""}<div class="plugin-card-footer"><p class="muted plugin-version">Version ${esc(p.version)}${p.minCoreVersion ? ` · Core ${esc(p.minCoreVersion)}+` : ""}</p><div class="actions"><button${!unavailable ? ' class="primary"' : ""} data-install-plugin="${esc(p.id)}" ${unavailable ? "disabled" : ""}>${label}</button></div></div></article>`;
  }).join("") : "<p>No plugins match your search.</p>");
  const r = s.registry, check = s.catalogCheck;
  const base = r?.available && !r.expired ? `Signed catalog ${r.version} · ${r.count} plugins.` : r?.present ? "Catalog unavailable. Check again before installing." : "Showing bundled KAI releases.";
  const detail = check?.paused || s.network.privacyMode === "local-only" ? "Update checks are paused in Local-Only mode." : check?.error || r?.error ? "Could not check for new updates. Try again when connected." : check?.checking && !r?.available ? "Checking for plugin updates…" : "";
  text("registry-status", [base, detail].filter(Boolean).join(" "));
  $("refresh-registry").disabled = !!check?.checking;
}
function openPluginRepository(event) {
  const link = event.target.closest("[data-plugin-repository]");
  if (!link) return false;
  event.preventDefault();
  const source = pluginRepository(link.dataset.pluginRepository);
  if (source && link.getAttribute("aria-busy") !== "true") {
    link.setAttribute("aria-busy", "true");
    void action(null, () => bridge.call("desktop.openExternal", { url: source.url })).finally(() => link.removeAttribute("aria-busy"));
  }
  return true;
}
let pluginCheckBusy = false;
async function checkPluginCatalog() {
  if (!bridge || pluginCheckBusy || document.hidden) return;
  pluginCheckBusy = true;
  try { await bridge.call("plugins.registry.check"); }
  catch { /* Automatic check failures stay in catalog status, without a popup. */ }
  finally { pluginCheckBusy = false; await refresh(); }
}
window.addEventListener("online", () => { void checkPluginCatalog(); });
bridge?.onPluginCatalogChange?.(() => { void refresh(); });
if ($("plugin-search")) $("plugin-search").oninput = renderCatalog;
if ($("refresh-registry")) $("refresh-registry").onclick = e => action(e.currentTarget, async () => { const r = await bridge.call("plugins.registry.refresh"); notify(`Catalog ${r.version} verified · ${r.count} plugins available.`); });
$("models").onclick = e => { const b = e.target.closest("[data-model]"); if (b) void action(b, () => { notices["model-message"].clear(); return api("/core/models/ensure", { alias: b.dataset.model }); }); };
$("plugins").onclick = e => { if (openPluginRepository(e)) return; const update = e.target.closest("[data-install-plugin]"); if (update) { if (!update.disabled) void action(update, () => bridge.call("plugins.install", { id: update.dataset.installPlugin })); return; } const b = e.target.closest("[data-plugin]"); if (!b) return; if (b.dataset.operation === "open") { void openApp(snapshot.plugins.find(plugin => plugin.id === b.dataset.plugin)); return; } void action(b, () => bridge.call("plugins.change", { id: b.dataset.plugin, action: b.dataset.operation })); };
if ($("plugin-catalog")) $("plugin-catalog").onclick = e => { if (openPluginRepository(e)) return; const b = e.target.closest("[data-install-plugin]"); if (b && !b.disabled) void action(b, () => bridge.call("plugins.install", { id: b.dataset.installPlugin })); };
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
async function createWallet(restore) {
  const generation = walletSecretGeneration;
  try {
    const r = await bridge.call(restore ? "wallet.restore" : "wallet.create", { password: $("password").value, ...(restore ? { wif: $("restore-wif").value } : {}) });
    // Observe the newly created identity before displaying its one-time backup.
    // The next status poll must not mistake it for an unrelated wallet switch.
    if (r.address) {
      knownWalletAddress = r.address;
      window.KaiCoreWallet?.observe({ exists: true, unlocked: true, address: r.address }, knownPrivacy);
      window.dispatchEvent(new CustomEvent("kai-credit-identity-changed"));
    }
    if (r.wif && page === "wallet" && !document.hidden && generation === walletSecretGeneration) {
      text("wallet-backup", `Save this backup key privately:\n${r.wif}`); $("wallet-backup").hidden = false; $("hide-backup").hidden = false;
    }
    notify("Wallet ready.");
  } finally { $("password").value = ""; $("restore-wif").value = ""; }
}

$("create-wallet").onclick = e => action(e.currentTarget, () => createWallet(false));
$("restore-button").onclick = e => action(e.currentTarget, () => createWallet(true));
$("hide-backup").onclick = hideBackup;
$("lock-wallet").onclick = e => { hideBackup(); return action(e.currentTarget, () => bridge.call("wallet.lock")); };
$("connect-wallet").onclick = e => action(e.currentTarget, async () => { await bridge.credit("wallet-connect"); window.KaiCredits.clear(); await window.KaiCredits.refresh(); });
$("import-model").onclick = e => action(e.currentTarget, async () => { const r = await bridge.call("models.import"); if (r) { notices["model-message"].clear(); await api("/core/models/import", { path: r.file }); } });
$("cancel-download").onclick = e => action(e.currentTarget, () => api("/core/models/download/cancel", {}));
let priceBusy = false;
async function price() { if (!bridge || priceBusy || page !== "buy-credits" || snapshot?.network.privacyMode === "local-only") return; priceBusy = true; const generation = ++priceGeneration, usd = $("usd").value; try { const r = await bridge.credit("purchase-estimate", { usd }); if (generation === priceGeneration) text("price", `Estimated payment: ${r.estimate.koin} KOIN · ${r.estimate.credits} credits`); } catch (e) { if (generation === priceGeneration) text("price", e.message); } finally { priceBusy = false; } }
$("usd").oninput = () => { priceGeneration++; text("price", "The exact KOIN payment will be shown before approval."); };
$("buy-credits").onsubmit = e => { e.preventDefault(); const usd = $("usd").value; void action(e.submitter, async () => {
  notices["purchase-state"].show("Preparing purchase…", { dismissible: false });
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
  notices["purchase-state"].show("Checking saved purchase…", { dismissible: false });
  try { const r = await bridge.credit("credit-purchase-retry"); text("purchase-state", r.detail || r.state); await window.KaiCredits.refresh(); }
  catch (error) { text("purchase-state", error.message); throw error; }
});
$("check-updates").onclick = e => action(e.currentTarget, async () => {
  text("update-state", (await bridge.call("updates.check")).message);
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
  html("credit-activity", rows.length ? `<div class="table-scroll"><table class="activity-table"><thead><tr><th scope="col">Activity</th><th scope="col">When</th><th scope="col">Status</th><th scope="col">Credits</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.title)}</td><td>${esc(r.at ? new Date(r.at).toLocaleString() : "—")}</td><td>${esc(r.status)}</td><td>${r.amount === null ? "Unavailable" : esc(r.prefix + r.amount)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">${s.deviceFree && s.paidAccessLocked ? "Connect this wallet above to restore its purchased credits and network activity." : filter === "usage" ? "Your network chat usage will appear here." : filter === "purchase" ? "Your credit purchases will appear here." : "Your purchases and network chat usage will appear here."}</p>`);
  text("credit-activity-status", p.stale ? "Showing your last verified activity. Refresh when your connection is available." : `Checked ${new Date(s.receivedAt).toLocaleString()}`);
}
$("credit-filter").onchange = renderCredits;
window.KaiCredits.subscribe(state => {
  const key = state.snapshot?.key;
  if (!state.snapshot || purchaseInfoKey !== key) { purchaseInfoGeneration++; cancelledPurchases.clear(); purchaseInfoKey = key; }
  creditState = state; renderCredits();
});
if (!bridge) notify("Open KAI Core Beta desktop to use this workspace.", true); else void refresh().then(() => { if (page === "chat") showPage("chat"); });
setInterval(() => { if (!document.hidden) { void refresh(); renderCredits(); } }, 5000);
setInterval(() => { if (!document.hidden) void price(); }, 30000);

bridge?.onPluginDownloadProgress?.(progress => {
  if (!Number.isFinite(progress?.received)) return;
  const received = (progress.received / 1048576).toFixed(1);
  const total = Number.isFinite(progress.total) ? ` of ${(progress.total / 1048576).toFixed(1)} MB` : " MB";
  notify(progress.verifying ? "Download complete. Verifying plugin…" : `Downloading plugin: ${received}${total}`);
});
