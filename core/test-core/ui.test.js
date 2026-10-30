"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../../ui-core/core.js"), "utf8");
const presentation = () => fs.readFileSync(path.join(__dirname, "../../ui-core/presentation.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../../ui-core/index.html"), "utf8");
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture({ state = {}, credit, call } = {}) {
  const elements = new Map(), windowEvents = new Map(), docEvents = new Map(), calls = [];
  let creditListener, catalogListener;
  function element(id) {
    return { id, textContent: "", innerHTML: "", value: id === "usd" ? "1" : "", hidden: false, disabled: false, dataset: {}, attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; }, classList: { toggle() {} } };
  }
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) elements.set(id, element(id));
  const snapshot = { version: "0.1.0", models: [], plugins: [], wallet: { exists: true, address: "synthetic-wallet", unlocked: false },
    profile: { mode: "existing", dataDir: "/synthetic/profile", backup: "/synthetic/backup", preserved: { wallet: true } }, runtime: {}, network: { privacyMode: "local-only" }, ...state };
  const bridge = {
    onPluginCatalogChange(fn) { catalogListener = fn; },
    async call(method, input) { calls.push({ kind: "core", method, input }); if (method === "status") return snapshot; return call?.(method, input); },
    async credit(method, input) { calls.push({ kind: "credit", method, input }); return credit?.(method, input); },
  };
  const context = vm.createContext({ console, setInterval() { return 1; }, clearInterval() {},
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    window: { kaiCore: bridge, dispatchEvent(event) { windowEvents.get(event.type)?.(event); }, addEventListener(event, fn) { windowEvents.set(event, fn); }, KaiCredits: { subscribe(fn) { creditListener = fn; }, clear() {}, async refresh() {} }, KaiCreditPresentation: require("../../ui/credit-account").creditPresentation },
    document: { hidden: false, activeElement: null, getElementById(id) { assert.ok(elements.has(id), `Missing element ${id}`); return elements.get(id); }, querySelectorAll() { return []; }, addEventListener(event, fn) { docEvents.set(event, fn); } },
    async fetch(url, options) { calls.push({ kind: "fetch", url, options }); return { ok: true, async json() { return { ok: true }; } }; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../../ui-core/notices.js"), "utf8"), context, { filename: "notices.js" });
  vm.runInContext(presentation(), context, { filename: "presentation.js" });
  vm.runInContext(source, context, { filename: "core.js" });
  const submit = id => { const button = element("submit"); elements.get(id).onsubmit({ preventDefault() {}, submitter: button }); return flush(); };
  return { context, elements, calls, snapshot, windowEvents, docEvents, submit, acceptCredits: state => creditListener(state), notifyCatalog: () => catalogListener?.(), $: id => elements.get(id) };
}

test("existing wallet UI does not create or restore a wallet on startup", async () => {
  const f = fixture(); await flush();
  assert.equal(f.$("create-wallet").hidden, true); assert.equal(f.$("restore-wallet").hidden, true);
  assert.equal(f.$("wallet-address").textContent, "synthetic-wallet");
  assert.ok(f.calls.every(c => c.method === "status"));
});

test("generated backup key is cleared on blur, page exit, and wallet lock", async () => {
  const f = fixture({ state: { wallet: { exists: false, unlocked: false } }, call: async method => method === "wallet.create" ? { wif: "synthetic-backup-key" } : {} });
  await flush();
  for (const clear of [() => f.windowEvents.get("blur")(), () => f.context.showPage("models"), () => f.$("lock-wallet").onclick({ currentTarget: f.$("lock-wallet") })]) {
    f.context.showPage("wallet");
    f.$("password").value = "synthetic-password";
    await f.$("create-wallet").onclick({ currentTarget: f.$("create-wallet") });
    assert.match(f.$("wallet-backup").textContent, /synthetic-backup-key/); assert.equal(f.$("password").value, "");
    await clear(); assert.equal(f.$("wallet-backup").textContent, ""); assert.equal(f.$("wallet-backup").hidden, true);
  }
});

test("late wallet creation cannot reveal a key after blur or page exit", async () => {
  for (const leave of [f => f.windowEvents.get("blur")(), f => f.context.showPage("models")]) {
    let complete;
    const f = fixture({ state: { wallet: { exists: false, unlocked: false } }, call: method => method === "wallet.create" ? new Promise(resolve => { complete = resolve; }) : {} });
    await flush(); f.context.showPage("wallet"); f.$("password").value = "synthetic-password";
    const pending = f.$("create-wallet").onclick({ currentTarget: f.$("create-wallet") });
    await flush(); leave(f); complete({ wif: "synthetic-late-key" }); await pending;
    assert.equal(f.$("wallet-backup").textContent, ""); assert.equal(f.$("wallet-backup").hidden, true);
    assert.equal(f.$("password").value, "");
  }
});

test("purchase cancellation never requests a quote or payment approval", async () => {
  const f = fixture({ credit: async method => method === "purchase-connect" ? { state: "cancelled" } : {} });
  await flush(); await f.submit("buy-credits");
  assert.deepEqual(f.calls.filter(c => c.kind === "credit").map(c => c.method), ["purchase-connect"]);
  assert.match(f.$("purchase-state").textContent, /cancelled/);
});

test("purchase failures leave a retryable state and never say Preparing forever", async () => {
  const f = fixture({ credit: async method => { if (method === "purchase-connect") return { state: "ready" }; throw Error("Quote expired"); } });
  await flush(); await f.submit("buy-credits");
  assert.equal(f.$("purchase-state").textContent, "Quote expired");
  assert.match(f.$("price").textContent, /fresh quote/);
  assert.ok(!f.calls.some(c => c.method === "purchase-approve"));
});

test("successful purchase approves exactly the returned quote ID", async () => {
  const f = fixture({ credit: async method => ({ "purchase-connect": { state: "ready" }, "purchase-preview": { quote: { id: "verified-quote", koin: "4.00", credits: "1000" } }, "purchase-approve": { state: "confirmed" } })[method] });
  await flush(); await f.submit("buy-credits");
  const approval = f.calls.find(c => c.method === "purchase-approve"); assert.equal(approval.input, "verified-quote");
  assert.equal(f.$("purchase-state").textContent, "confirmed");
});

test("model import and asynchronous load errors appear in the model view", async () => {
  const f = fixture({ state: { importError: "Unsupported GGUF header" } }); await flush();
  assert.equal(f.$("model-message").textContent, "Unsupported GGUF header");
  f.snapshot.ensure = { state: "error", alias: "model", error: "Insufficient memory" }; await f.context.refresh();
  assert.equal(f.$("model-message").textContent, "Insufficient memory");
  f.$("model-message-close").onclick(); await f.context.refresh();
  assert.equal(f.$("model-notice").hidden, true);
  const retry = { dataset: { model: "model" } };
  f.$("models").onclick({ target: { closest() { return retry; } } }); await flush();
  assert.equal(f.$("model-notice").hidden, false, "a fast failed explicit retry must show its error again");
  f.snapshot.importing = { pct: 10 }; await f.context.refresh();
  assert.match(f.$("model-message").textContent, /Importing model/);
  assert.equal(f.$("model-message-close").hidden, true, "active progress is separate from settled errors");
});

test("plugin labels are escaped rather than interpreted as HTML", async () => {
  const f = fixture({ state: { plugins: [{ id: "example.safe", name: '<img src=x onerror="attack()">', enabled: true, version: "1.0.0", permissions: [] }] } });
  await flush(); assert.match(f.$("plugins").innerHTML, /&lt;img/); assert.doesNotMatch(f.$("plugins").innerHTML, /<img/);
});
test("catalog displays community compatibility and escapes developer metadata without auto-refresh", async () => {
  const f = fixture({ state: { catalog: [{ id: "community.demo", name: "Community demo", description: '<img src=x onerror="attack()">', version: "1.0.0", compatible: false, compatibilityReason: "Requires KAI Core 0.4.0", minCoreVersion: "0.4.0", official: false }], registry: { available: true, version: "0.1.0", count: 1 } } });
  await flush(); const markup = f.$("plugin-catalog").innerHTML;
  assert.match(markup, /Community/); assert.match(markup, /&lt;img/); assert.doesNotMatch(markup, /<img/);
  assert.match(markup, /disabled>Requires newer Core/); assert.match(f.$("registry-status").textContent, /Signed catalog/);
  assert.ok(f.calls.every(call => call.method === "status"));
  f.$("plugin-search").value = "not present"; f.$("plugin-search").oninput();
  assert.match(f.$("plugin-catalog").innerHTML, /No plugins match/);
});

function creditsState(extra = {}) {
  return { status: "ready", snapshot: { key: "synthetic-credit-account", product: "prepaid-usd-v1", receivedAt: Date.now(),
    credits: { unit: "USD-1e-8", available: "125000000", purchased: { available: "100000000" }, free: { available: "25000000", state: "available" } },
    usage: [{ model: '<img onerror="attack()">', at: Date.now(), credits: "125000" }],
    purchases: [{ state: "confirmed", confirmedAt: Date.now() - 1000, credits: "100000000" }, { state: "pending", createdAt: Date.now() - 2000, amount: "50000000" }], ...extra } };
}
test("Your Credits displays verified balances and escaped usage with separate purchase filtering", async () => {
  const f = fixture(); await flush(); f.acceptCredits(creditsState());
  assert.equal(f.$("credits").textContent, "1,250");
  let markup = f.$("credit-activity").innerHTML;
  assert.match(markup, /−1.25/); assert.match(markup, /\+1,000/); assert.match(markup, /Pending/);
  assert.match(markup, /&lt;img/); assert.doesNotMatch(markup, /<img/);
  f.$("credit-filter").value = "purchase"; f.$("credit-filter").onchange();
  markup = f.$("credit-activity").innerHTML;
  assert.doesNotMatch(markup, /Chat/); assert.match(markup, /Purchased credits/);
  f.$("credit-filter").value = "usage"; f.$("credit-filter").onchange();
  assert.doesNotMatch(f.$("credit-activity").innerHTML, /Purchased credits/);
});
test("retained credit activity is marked stale and invalid amounts never become invented credits", async () => {
  const f = fixture(); await flush();
  const state = creditsState({ usage: [{ model: "model", at: Date.now(), credits: "not-a-number" }] });
  state.status = "unavailable"; state.error = "offline"; f.acceptCredits(state);
  assert.match(f.$("credit-detail").textContent, /last verified/);
  assert.match(f.$("credit-activity-status").textContent, /last verified activity/);
  assert.match(f.$("credit-activity").innerHTML, /Unavailable/);
  f.acceptCredits({ status: "loading", snapshot: null });
  assert.doesNotMatch(f.$("credit-activity").innerHTML, /Purchased credits/);
  assert.equal(f.$("credits").textContent, "…");
});
test("Wallet and Your Credits do not request purchase estimates; the purchase screen does", async () => {
  const f = fixture({ state: { network: { privacyMode: "network" } }, credit: async method => method === "purchase-estimate" ? { estimate: { koin: "1", credits: "1000" } } : {} });
  await flush(); f.context.showPage("wallet"); f.context.showPage("credits"); await flush();
  assert.ok(!f.calls.some(c => c.method === "purchase-estimate"));
  f.context.showPage("buy-credits"); await flush();
  assert.equal(f.$("workspace-title").textContent, "Buy credits");
  assert.equal(f.calls.filter(c => c.method === "purchase-estimate").length, 1);
});

test("cancelled saved payments are shown without erasing confirmed server purchases", async () => {
  const f = fixture({ state: { network: { privacyMode: "network" } }, credit: async method => method === "purchase-info" ? { cancelledPurchases: [{ txId: "cancelled-id" }, { txId: "confirmed-id" }] } : {} });
  await flush(); f.acceptCredits(creditsState({ purchases: [
    { id: "cancelled-id", state: "pending", amount: "100000000" },
    { id: "confirmed-id", state: "confirmed", credits: "100000000" },
  ] }));
  f.context.showPage("credits"); await flush();
  assert.match(f.$("credit-activity").innerHTML, /Cancelled · no purchase/);
  assert.match(f.$("credit-activity").innerHTML, /Added to balance/);
  assert.match(f.$("credit-activity").innerHTML, /\+1,000/);
});

test("missing release metadata explains manual previews instead of claiming the app is current", async () => {
  const f = fixture({ call: async method => { if (method === "updates.check") throw Error("ERR_UPDATER_LATEST_VERSION_NOT_FOUND: please ensure a production release exists"); } });
  await flush(); await f.$("check-updates").onclick({ currentTarget: f.$("check-updates") });
  assert.match(f.$("update-state").textContent, /No automatic update has been published/);
  assert.match(f.$("update-state").textContent, /manual download/);
  assert.equal(f.$("check-updates").disabled, false);
});
test("failed update checks leave a retryable explanation", async () => {
  const f = fixture({ call: async method => { if (method === "updates.check") throw Error("Connection unavailable"); } });
  await flush(); await f.$("check-updates").onclick({ currentTarget: f.$("check-updates") });
  assert.match(f.$("update-state").textContent, /could not finish/);
  assert.equal(f.$("check-updates").disabled, false);
});

test("wallet warnings can be dismissed, retried, and cleared by a successful unlock", async () => {
  let fail = true;
  const f = fixture({ call: async method => { if (method === "wallet.unlock" && fail) throw Error("Incorrect password for synthetic wallet"); } });
  await flush(); await f.submit("unlock-wallet");
  assert.match(f.$("notice-message").textContent, /Incorrect password/);
  const beforeDismiss = f.calls.length;
  f.$("notice-close").onclick(); assert.equal(f.$("notice").hidden, true);
  assert.equal(f.calls.length, beforeDismiss, "dismissal must not call wallet or payment APIs");
  await f.context.refresh(); assert.equal(f.$("notice").hidden, true);
  await f.submit("unlock-wallet"); assert.equal(f.$("notice").hidden, false);
  fail = false; await f.submit("unlock-wallet");
  assert.equal(f.$("notice").hidden, true); assert.equal(f.$("notice-message").textContent, "");
});

test("background refresh does not resurrect a dismissed failure, but a new failure does", async () => {
  const f = fixture(); await flush();
  const original = f.context.window.kaiCore.call;
  f.context.window.kaiCore.call = async () => { throw Error("Temporarily unavailable"); };
  await f.context.refresh(); f.$("notice-close").onclick();
  await f.context.refresh(); assert.equal(f.$("notice").hidden, true);
  f.context.window.kaiCore.call = original; await f.context.refresh();
  f.context.window.kaiCore.call = async () => { throw Error("Temporarily unavailable"); };
  await f.context.refresh(); assert.equal(f.$("notice").hidden, false);
});

test("settled action messages dismiss without resubmitting and return on explicit retry", async () => {
  const f = fixture({ credit: async () => ({ state: "cancelled" }), call: async () => ({ message: "No update available" }) });
  await flush(); await f.submit("buy-credits");
  const beforeDismiss = f.calls.length;
  f.$("purchase-close").onclick(); assert.equal(f.$("purchase-notice").hidden, true);
  assert.equal(f.calls.length, beforeDismiss);
  await f.submit("buy-credits"); assert.equal(f.$("purchase-notice").hidden, false);
  await f.$("check-updates").onclick({ currentTarget: f.$("check-updates") });
  f.$("update-close").onclick(); assert.equal(f.$("update-notice").hidden, true);
  await f.$("check-updates").onclick({ currentTarget: f.$("check-updates") });
  assert.equal(f.$("update-notice").hidden, false);
});


function pluginState() {
  const fingerprint = "a".repeat(64);
  return {
    network: { privacyMode: "local-first" },
    plugins: [
      { id: "kai.brain", version: "0.1.0", fingerprint, enabled: true },
      { id: "kai.documents", version: "0.1.0", fingerprint, enabled: false },
      { id: "kai.assistant", version: "0.2.0", fingerprint, enabled: true },
      { id: "community.other", version: "0.1.0", fingerprint: "b".repeat(64), enabled: true },
    ],
    catalog: [
      { id: "kai.brain", version: "0.1.1", fingerprint, compatible: true },
      { id: "kai.documents", version: "0.1.1", fingerprint, compatible: false, minCoreVersion: "9.0.0", compatibilityReason: "Requires KAI Core 9.0.0" },
      { id: "kai.assistant", version: "0.1.1", fingerprint, compatible: true },
      { id: "community.other", version: "0.1.1", fingerprint, compatible: true },
      { id: "kai.tools", version: "0.1.1", fingerprint, compatible: true },
    ],
    pluginUpdates: { count: 2, updates: [
      { id: "kai.brain", installedVersion: "0.1.0", version: "0.1.1", compatible: true },
      { id: "kai.documents", installedVersion: "0.1.0", version: "0.1.1", compatible: false, minCoreVersion: "9.0.0", compatibilityReason: "Requires KAI Core 9.0.0" },
    ] },
    registry: { available: true, version: "0.1.1", count: 5 },
    catalogCheck: { checking: false, paused: false, error: null },
  };
}
test("plugin update bubble counts installed updates once, including disabled and Core-blocked plugins", async () => {
  const f = fixture({ state: pluginState() }); await flush();
  assert.equal(f.$("plugin-update-count").textContent, "2"); assert.equal(f.$("plugin-update-count").hidden, false);
  assert.equal(f.$("plugin-nav").attrs["aria-label"], "Plugins, 2 updates available");
  assert.equal(f.$("plugin-updates-title").textContent, "2 plugin updates available");
  assert.match(f.$("plugin-updates-detail").textContent, /1 update needs a newer Core/);
  assert.match(f.$("plugins").innerHTML, /data-install-plugin="kai.brain" >Review update/);
  assert.match(f.$("plugins").innerHTML, /disabled>Requires newer Core/);
  assert.match(f.$("plugins").innerHTML, /Version 0.1.0.*<strong>0.1.1<\/strong>/);
  assert.match(f.$("plugin-catalog").innerHTML, /disabled>Newer version installed/);
  assert.match(f.$("plugin-catalog").innerHTML, /disabled>Different publisher/);
  assert.ok(!f.calls.some(c => c.method === "plugins.install"));
  f.snapshot.pluginUpdates.updates.push(...f.snapshot.pluginUpdates.updates,
    { id: "kai.tools", installedVersion: "0.1.0", version: "0.1.1" },
    { id: "community.other", installedVersion: "0.1.0", version: "0.1.1" },
    { id: "kai.assistant", installedVersion: "0.2.0", version: "0.1.1" });
  await f.context.refresh(); assert.equal(f.$("plugin-update-count").textContent, "2");
});

test("catalog change events update and clear the badge without opening Plugins or installing", async () => {
  const state = pluginState(); state.plugins = []; state.pluginUpdates = { count: 0, updates: [] };
  const f = fixture({ state }); await flush(); assert.equal(f.$("plugin-update-count").hidden, true);
  Object.assign(f.snapshot, pluginState()); f.notifyCatalog(); await flush();
  assert.equal(f.$("plugin-update-count").textContent, "2"); assert.equal(f.$("plugin-update-count").hidden, false);
  f.snapshot.plugins[0].version = "0.1.1";
  f.snapshot.pluginUpdates.updates.shift(); f.snapshot.pluginUpdates.count = 1;
  f.notifyCatalog(); await flush(); assert.equal(f.$("plugin-update-count").textContent, "1");
  assert.equal(f.$("plugin-nav").attrs["aria-label"], "Plugins, 1 update available");
  f.snapshot.plugins[1].version = "0.1.1"; f.snapshot.pluginUpdates = { count: 0, updates: [] };
  f.notifyCatalog(); await flush();
  assert.equal(f.$("plugin-update-count").hidden, true); assert.equal(f.$("plugin-updates").hidden, true);
  assert.equal(f.$("plugin-nav").attrs["aria-label"], "Plugins");
  assert.ok(!f.calls.some(c => c.method === "plugins.install" || c.method === "plugins.registry.refresh"));
});

test("installed update review calls existing installer and canceled approval retains the badge", async () => {
  let canceled = true, f;
  f = fixture({ state: pluginState(), call: async method => {
    if (method === "plugins.install" && !canceled) { f.snapshot.plugins[0].version = "0.1.1"; f.snapshot.pluginUpdates.updates.shift(); f.snapshot.pluginUpdates.count = 1; }
    return null;
  } });
  await flush(); const button = { disabled: false, dataset: { installPlugin: "kai.brain" } };
  const click = () => f.$("plugins").onclick({ target: { closest: selector => selector === "[data-install-plugin]" ? button : null } });
  click(); await flush(); assert.equal(f.$("plugin-update-count").textContent, "2");
  canceled = false; click(); await flush(); assert.equal(f.$("plugin-update-count").textContent, "1");
  const installs = f.calls.filter(c => c.method === "plugins.install"); assert.equal(installs.length, 2); assert.equal(installs[0].input.id, "kai.brain");
  button.disabled = true; click(); await flush(); assert.equal(f.calls.filter(c => c.method === "plugins.install").length, 2);
});

test("opening Plugins and reconnecting check the catalog quietly and deduplicate pending checks", async () => {
  let finish, fail = false;
  const f = fixture({ state: pluginState(), call: method => {
    if (method === "plugins.registry.check") return new Promise((resolve, reject) => { finish = () => fail ? reject(Error("Catalog offline")) : resolve({}); });
  } });
  await flush(); f.$("notice").hidden = true; f.context.showPage("plugins"); f.windowEvents.get("online")(); f.context.showPage("plugins"); await flush();
  assert.equal(f.calls.filter(c => c.method === "plugins.registry.check").length, 1);
  finish(); await flush(); assert.equal(f.$("notice").hidden, true);
  fail = true; f.windowEvents.get("online")(); await flush(); finish(); await flush();
  assert.equal(f.$("notice").hidden, true); assert.equal(f.$("plugin-update-count").textContent, "2");
  assert.ok(!f.calls.some(c => c.method === "plugins.install"));
});

test("failed background checks retain update count and local-only explains paused checks", async () => {
  const f = fixture({ state: pluginState() }); await flush();
  f.snapshot.catalogCheck.error = "Network unavailable"; f.notifyCatalog(); await flush();
  assert.equal(f.$("plugin-update-count").textContent, "2"); assert.match(f.$("registry-status").textContent, /Could not check/);
  f.snapshot.network.privacyMode = "local-only"; f.snapshot.catalogCheck.paused = true;
  f.notifyCatalog(); await flush(); assert.equal(f.$("plugin-update-count").textContent, "2");
  assert.match(f.$("registry-status").textContent, /paused in Local-Only/);
});
