"use strict";
// Synthetic desktop test services only. Never loaded by the application entry.
// The real native shell, Core IPC sender checks, local-chat service and profile
// remain in use. Credit IPC is synthetic: no paid requests, provider work or
// model inference leave this fixture; its native credit sender checks are not tested.
const path = require("node:path");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const REQUEST_ID = "a".repeat(64);
function install({ appRoot }) {
  const { app, ipcMain } = require("electron");
  global.__smokeExternalCalls = [];
  global.__smokeChatRequests = [];
  global.__smokeCreditCalls = [];
  global.__smokeLocalMode = "reply";
  global.__smokeNetworkMode = "reply";
  global.__smokeShutdownDelay = 0;
  global.__smokeWalletCalls = [];
  global.__smokeWalletReviews = [];
  global.__smokeWalletMode = "ready";
  global.__smokeLegacyMode = "ready";
  global.__smokeLegacyReads = 0;
  // Keep registry verification and PluginManager real while supplying only
  // ephemeral signed test packages. No published keys or packages are loaded.
  const crypto = require("node:crypto");
  const registryModule = require(path.join(appRoot, "core/lib/plugins/registry.js"));
  const packageModule = require(path.join(appRoot, "core/lib/plugins/package.js"));
  const managerModule = require(path.join(appRoot, "core/lib/plugins/manager.js"));
  const registryKey = crypto.generateKeyPairSync("ed25519"), publisherKey = crypto.generateKeyPairSync("ed25519"), otherKey = crypto.generateKeyPairSync("ed25519");
  const keyText = key => key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const fingerprint = key => registryModule.fingerprint(key.publicKey);
  const ids = ["smoke.update-enabled", "smoke.update-disabled", "smoke.update-blocked", "smoke.equal", "smoke.newer-installed", "smoke.changed-publisher", "smoke.not-installed"];
  const names = ["Synthetic Ready Plugin", "Synthetic Disabled Plugin", "Synthetic Core Upgrade", "Synthetic Current Plugin", "Synthetic Ahead Plugin", "Synthetic Other Publisher", "Synthetic New Plugin"];
  const packageFor = (id, version, key = publisherKey) => {
    const manifest = { schema: 1, apiVersion: 1, id, version, name: names[ids.indexOf(id)], description: "Synthetic catalog update fixture without runtime permissions.", entry: "index.html", permissions: [] };
    const files = { "index.html": "<!doctype html><html><body>Synthetic plugin fixture</body></html>" };
    return { manifest, files, publicKey: keyText(key), signature: crypto.sign(null, Buffer.from(packageModule.canonical({ manifest, files })), key.privateKey).toString("base64") };
  };
  let catalogSequence = 1, signedCatalog;
  const packages = new Map();
  const publishCatalog = () => {
    const plugins = ids.map((id, index) => {
      const version = catalogSequence > 1 && [0, 1, 2, 5, 6].includes(index) ? "2.0.0" : "1.0.0";
      const pkg = packageFor(id, version), repository = "synthetic-kai-tests/" + id.replaceAll(".", "-");
      const url = `https://github.com/${repository}/releases/download/v${version}/synthetic.kaiplugin`;
      packages.set(url, pkg);
      return { id, name: pkg.manifest.name, description: pkg.manifest.description, version, apiVersion: 1, minCoreVersion: index === 2 && catalogSequence > 1 ? "99.0.0" : "0.1.0", repository, url, publicKey: pkg.publicKey, fingerprint: fingerprint(publisherKey), sha256: registryModule.packageDigest(pkg), permissions: [] };
    });
    const catalog = { schema: 1, version: `1.0.${catalogSequence - 1}`, sequence: catalogSequence, generatedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), plugins };
    signedCatalog = { catalog, publicKey: keyText(registryKey), signature: crypto.sign(null, Buffer.from(registryModule.canonical(catalog)), registryKey.privateKey).toString("base64") };
  };
  publishCatalog();
  global.__smokeCatalogReads = 0; global.__smokePackageReads = 0; global.__smokeCatalogMode = "ready"; global.__smokeApprovePlugin = false;
  global.__smokePublishPluginUpdates = () => { catalogSequence++; publishCatalog(); };
  const BaseManager = managerModule.PluginManager;
  managerModule.PluginManager = class extends BaseManager {
    constructor(dataDir) {
      super(dataDir);
      if (!this.list().length) {
        for (let i = 0; i < 6; i++) this.install(packageFor(ids[i], i === 4 ? "2.0.0" : "1.0.0", i === 5 ? otherKey : publisherKey));
        this.change(ids[1], "disable");
      }
      global.__smokePluginManager = this;
    }
  };
  const BaseRegistry = registryModule.RegistryClient;
  registryModule.RegistryClient = class extends BaseRegistry {
    constructor(options) {
      super({ ...options, trustedFingerprint: fingerprint(registryKey), download: async (_source, { signal }) => {
        signal.throwIfAborted(); global.__smokeCatalogReads++;
        if (global.__smokeCatalogMode === "unavailable") throw Error("Synthetic catalog temporarily unavailable");
        return structuredClone(signedCatalog);
      } });
    }
  };
  const downloadModule = require(path.join(appRoot, "core/lib/plugins/download.js"));
  downloadModule.downloadPackage = async (url, { signal } = {}) => {
    signal?.throwIfAborted(); global.__smokePackageReads++;
    if (!packages.has(url)) throw Error("Synthetic fixture forbids unknown plugin downloads");
    return packageModule.verifyPackage(packages.get(url));
  };
  const catalogModule = require(path.join(appRoot, "electron/core-plugin-catalog.js")), createMonitor = catalogModule.createCatalogMonitor;
  catalogModule.createCatalogMonitor = options => {
    let clockOffset = 0;
    const timers = new Map();
    const monitor = createMonitor({ ...options, now: () => Date.now() + clockOffset,
      setTimer(fn, delay) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, delay); timers.set(timer, { fn, delay }); return timer; },
      clearTimer(timer) { timers.delete(timer); clearTimeout(timer); },
    });
    global.__smokePluginCatalog = monitor;
    global.__smokePluginCatalogTick = async () => {
      const next = [...timers].filter(([, entry]) => entry.delay >= 60000).sort((a, b) => a[1].delay - b[1].delay)[0];
      if (!next) throw Error("No automatic plugin catalog check was scheduled");
      clearTimeout(next[0]); timers.delete(next[0]); clockOffset += next[1].delay + 1;
      await next[1].fn();
    };
    return monitor;
  };
  // Native wallet presentation uses the production scoped broker and sender
  // checks. Only chain data and OS side effects are synthetic. A mistaken Send
  // can never reach a chain provider: all native reviews cancel and transfer
  // throws before doing any work.
  const { ChainService } = require(path.join(appRoot, "core/lib/koinos/chain.js"));
  const { WalletHistory } = require(path.join(appRoot, "core/lib/koinos/wallet-history.js"));
  ChainService.prototype.balances = async function(address) {
    global.__smokeWalletCalls.push({ method: "balances", address, network: this.network().id });
    if (global.__smokeWalletMode === "unavailable") throw Error("Synthetic wallet balance unavailable");
    return { koin: "1234567890123", vhp: "87654321000", mana: "1250000000" };
  };
  ChainService.prototype.transfer = async function() {
    global.__smokeWalletCalls.push({ method: "transfer" });
    throw Error("Synthetic fixture forbids wallet transfers");
  };
  WalletHistory.prototype.read = async function(input = {}) {
    global.__smokeWalletCalls.push({ method: "history", cursor: input.cursor || null });
    if (global.__smokeWalletMode === "unavailable") throw Error("Synthetic wallet history unavailable");
    const older = !!input.cursor, net = this.chain.network();
    return { available: true, address: this.wallet.address, network: net.id, tokenSymbol: net.tokenSymbol, observedAt: Date.now(), nextCursor: older ? null : "synthetic_older_page",
      rows: [{ kind: "transaction", id: "0x1220" + (older ? "b" : "a").repeat(64), label: older ? "Sent" : "Received", type: older ? "sent" : "received", timestamp: Date.now() - (older ? 86400000 : 60000), height: "100", counterparty: this.wallet.address,
        changes: [{ asset: net.tokenSymbol, direction: older ? "out" : "in", amount: older ? "100000000" : "250000000" }], status: "confirmed" }] };
  };
  const desktop = require("electron");
  desktop.dialog.showMessageBox = async (_parent, options) => {
    const value = options || _parent;
    global.__smokeWalletReviews.push({ title: value.title, message: value.message, detail: value.detail, buttons: value.buttons, defaultId: value.defaultId, cancelId: value.cancelId });
    return { response: value.title === "Install plugin" && global.__smokeApprovePlugin ? 1 : value.cancelId ?? 0, checkboxChecked: false };
  };
  let clipboard = "";
  desktop.clipboard.writeText = value => { clipboard = String(value); };
  desktop.clipboard.readText = () => clipboard;
  desktop.clipboard.clear = () => { clipboard = ""; };
  global.__smokeClipboard = () => clipboard;
  desktop.shell.openExternal = async url => { global.__smokeWalletCalls.push({ method: "openExplorer", url }); };
  let core, providerEnabled = false, pendingNetwork, recoveryAvailable = false;
  const lifecycle = global.__smokeLifecycle = { coreStarts: 0, coreStops: 0, coreStopped: false, paymentDisposals: 0, paymentsDisposed: false, providerEnabled: false, providerTicks: 0, beforeQuit: 0, willQuit: false, quit: false, trayMode: "pending", trayDestroyed: false };
  const record = () => { if (process.env.KAI_SMOKE_LIFECYCLE_FILE) fs.writeFileSync(process.env.KAI_SMOKE_LIFECYCLE_FILE, JSON.stringify(lifecycle)); };
  const setProvider = enabled => { providerEnabled = enabled; lifecycle.providerEnabled = enabled; record(); };
  const heartbeat = setInterval(() => { if (providerEnabled) lifecycle.providerTicks++; }, 50); heartbeat.unref();
  app.on("before-quit", () => { lifecycle.beforeQuit++; if (lifecycle.coreStopPending) lifecycle.repeatedQuitDuringCoreStop = true; record(); });
  app.on("will-quit", () => { lifecycle.willQuit = true; record(); });
  app.on("quit", () => { lifecycle.quit = true; clearInterval(heartbeat); record(); });
  const trayModule = require(path.join(appRoot, "electron/core-tray.js")), createTray = trayModule.createCoreTray;
  trayModule.createCoreTray = options => {
    global.__smokeMainWindow = options.win;
    class SyntheticTray extends EventEmitter {
      setToolTip() {}
      setContextMenu() {}
      isDestroyed() { return this.destroyed === true; }
      destroy() { this.destroyed = true; }
    }
    function ObservedTray(...args) {
      if (process.env.KAI_SMOKE_TRAY_MODE === "unavailable") { lifecycle.trayMode = "unavailable"; record(); throw Error("Synthetic unavailable tray"); }
      let tray;
      // Headless Linux has no notification area. Other platforms use the real
      // native Tray when its constructor succeeds; OS icon visibility is not asserted.
      if (!(process.platform === "linux" && !process.env.DISPLAY)) {
        try { tray = new options.Tray(...args); lifecycle.trayMode = "native"; }
        catch (error) { lifecycle.trayMode = "native-failed"; lifecycle.trayError = error.message; record(); throw error; }
      }
      if (!tray) { tray = new SyntheticTray(); lifecycle.trayMode = "synthetic"; }
      const destroy = tray.destroy.bind(tray);
      tray.destroy = () => { lifecycle.trayDestroyed = true; record(); return destroy(); };
      global.__smokeTray = tray; record(); return tray;
    }
    return createTray({ ...options, Tray: ObservedTray, Menu: { buildFromTemplate(template) {
      global.__smokeTrayMenu = template;
      return options.Menu.buildFromTemplate(template);
    } } });
  };
  // Reconciliation/provider timers bypass IPC. Keep scheduling and teardown
  // real, but never enroll this synthetic profile or provider for credits.
  const { CreditService } = require(path.join(appRoot, "electron/credit-service.js")), creditRun = CreditService.prototype.run;
  CreditService.prototype.run = async function(action, ...args) {
    if (action === "purchase-sync") return { state: "none" };
    return creditRun.call(this, action, ...args);
  };
  require(path.join(appRoot, "electron/credit-provider.js")).CreditProvider.prototype.tick = async () => {};
  const paymentModule = require(path.join(appRoot, "electron/koin-test-ipc.js")), registerPayments = paymentModule.registerTestPaymentIPC;
  paymentModule.registerTestPaymentIPC = (...args) => {
    const payments = registerPayments(...args), dispose = payments.dispose.bind(payments), isProviding = payments.isProviding?.bind(payments);
    payments.isProviding = () => providerEnabled || isProviding?.() === true;
    payments.dispose = async () => { lifecycle.paymentDisposals++; record(); await dispose(); setProvider(false); lifecycle.paymentsDisposed = true; record(); };
    return payments;
  };
  const completion = text => ({ id: REQUEST_ID, object: "chat.completion", model: "smoke-network", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
  const server = require(path.join(appRoot, "core/server.js")), createCore = server.createCore;
  server.createCore = async (...args) => {
    core = await createCore(...args);
    const start = core.start.bind(core), stop = core.stop.bind(core);
    core.start = async (...input) => { const port = await start(...input); lifecycle.coreStarts++; lifecycle.gatewayOrigin = `http://127.0.0.1:${port}`; record(); return port; };
    core.stop = async (...input) => {
      lifecycle.coreStops++; lifecycle.coreStopPending = true; record();
      if (global.__smokeShutdownDelay) await new Promise(resolve => setTimeout(resolve, global.__smokeShutdownDelay));
      await stop(...input); lifecycle.coreStopPending = false; lifecycle.coreStopped = true; record();
    };
    const aliases = core.models.aliases.bind(core.models);
    core.models.aliases = () => [{ alias: "smoke-local", label: "Synthetic local model", status: "ready" }, ...aliases()];
    core.gateway.earn.status = async () => {
      global.__smokeLegacyReads++;
      const wallet = core.account.wallet.status(), localOnly = core.gateway.network.status().privacyMode === "local-only";
      const earnings = localOnly ? null : global.__smokeLegacyMode === "unavailable" ? { error: "Synthetic testnet balance unavailable" }
        : { address: global.__smokeLegacyMode === "mismatch" ? "another-synthetic-wallet" : wallet.address, kai: "12345.67890123", pendingKai: "9999" };
      const result = { wallet, worker: { running: false }, earnings };
      if (global.__smokeLegacyMode === "delay") await new Promise(resolve => { global.__smokeResolveLegacy = resolve; });
      return result;
    };
    global.__smokeSetPrivacy = mode => core.settings.set("network.privacyMode", mode);
    return core;
  };
  const originalFetch = global.fetch;
  global.fetch = (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url || String(input));
    // Explicitly changing out of Local-Only asks for the model safety list.
    // Keep that existing transition real while answering the request in memory.
    if (url.origin === "https://koinosai.com" && url.pathname === "/scheduler/policy") {
      return Promise.resolve(new Response(JSON.stringify({ revoked: [] }), { headers: { "content-type": "application/json" } }));
    }
    if (options.method === "POST" && typeof options.body === "string") {
      let request;
      try { request = JSON.parse(options.body); } catch { /* Non-JSON bodies use the normal fixture below. */ }
      if (request?.method === "chain.get_chain_id") {
        global.__smokeWalletCalls.push({ method: "chainId" });
        const { MAINNET_CHAIN } = require(path.join(appRoot, "core/lib/koin-network/payment-network.js"));
        return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { chain_id: MAINNET_CHAIN } }), { headers: { "content-type": "application/json" } }));
      }
    }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      global.__smokeExternalCalls.push(url.origin + url.pathname);
      return Promise.reject(Error("Smoke test forbids external requests"));
    }
    if (url.pathname === "/core/chat/completions" && options.method === "POST") {
      const body = JSON.parse(options.body);
      global.__smokeChatRequests.push(body);
      if (global.__smokeLocalMode === "delay") return new Promise((_resolve, reject) => {
        if (options.signal?.aborted) reject(options.signal.reason || Error("Stopped"));
        else options.signal?.addEventListener("abort", () => reject(options.signal.reason || Error("Stopped")), { once: true });
      });
      return Promise.resolve(new Response(JSON.stringify(completion("Synthetic local answer <img src=x onerror=attack()>")), { headers: { "content-type": "application/json" } }));
    }
    return originalFetch(input, options);
  };
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => {
    if (channel !== "koin:test-payments") return handle(channel, fn);
    return handle(channel, async (event, action, input) => {
      global.__smokeCreditCalls.push({ action, input });
      const localOnly = core?.gateway.network.status().privacyMode === "local-only";
      if (action === "credit-status") return { product: "prepaid-usd-v1", owner: "synthetic-credit-owner", credits: {
        available: "300000000", purchased: { available: "200000000" }, free: { available: "100000000", state: "available", resetAt: Date.now() + 86400000 }, version: "1", unit: "USD-1e-8",
      }, purchases: [{ state: "confirmed", credits: "200000000", createdAt: Date.now() - 7200000, confirmedAt: Date.now() - 7100000 }], usage: [{ model: "Synthetic network model", credits: "125000", at: Date.now() - 60000 }] };
      if (action === "chat-info") return { configured: true, enabled: true, product: "prepaid-usd-v1", blocked: localOnly ? "Local-Only is on" : false,
        models: [{ model: "smoke-network", label: "Synthetic network model", available: !localOnly }], recoveryAvailable, modelAvailabilityUntil: Date.now() + 15000 };
      if (action === "chat-estimate") return { estimate: { credits: "10", maxCredits: "10" } };
      if (action === "chat-completion") {
        if (localOnly) throw Error("Local-Only is on");
        if (global.__smokeNetworkMode === "delay") return new Promise(resolve => { pendingNetwork = resolve; });
        if (global.__smokeNetworkMode === "recoverable") { recoveryAvailable = true; throw Error("Saved response available. Recover the previous request before sending again."); }
        return completion("Synthetic network answer");
      }
      if (action === "chat-recover") { recoveryAvailable = false; return { completion: completion("Recovered synthetic answer"), messages: [{ role: "user", content: "Recover this request" }] }; }
      if (action === "chat-ack") return { state: "delivered" };
      if (action === "stop") { pendingNetwork?.({ state: "cancelled" }); pendingNetwork = null; return { state: "stopped" }; }
      if (action === "purchase-info") return { cancelledPurchases: [] };
      if (action === "purchase-estimate") return { estimate: { koin: "1.25", credits: "1000" } };
      if (["purchase-connect", "purchase-preview", "purchase-approve", "credit-purchase-retry"].includes(action)) throw Error("Smoke fixture forbids purchases");
      if (action === "provider-public-info") return { enabled: providerEnabled, running: providerEnabled, state: "ready", walletReady: true, walletLocked: true, deviceAuthorized: true, automatic: true, secureStorage: { available: true }, selection: { mode: "all", models: [] }, modelAvailability: [{ id: "smoke-local", label: "Synthetic local model", installed: true, compatible: true }], offeredModels: ["smoke-local"], models: [{ id: "smoke-local", label: "Synthetic local model", installed: true, compatible: true, selected: true, ready: providerEnabled }], detail: "Ready to share installed models." };
      if (action === "provider-public-status") return { model: "smoke-local", validUntil: Date.now() + 15000, models: [{ model: "smoke-local", state: providerEnabled ? "online" : "offline", label: providerEnabled ? "ONLINE" : "OFFLINE", detail: "Synthetic readiness", validUntil: Date.now() + 15000 }], state: providerEnabled ? "online" : "offline", label: providerEnabled ? "ONLINE" : "OFFLINE", detail: providerEnabled ? "Available for network requests." : "Sharing is off. Turn it on when you are ready." };
      if (action === "provider-public-earnings") return { walletAddress: "synthetic-wallet", scope: "a".repeat(64), observedAt: Date.now(), summary: { pending: [], current: { availability: "5000000" } }, payouts: [{ epoch: String(Math.floor(Date.now() / 86400000) - 1), state: "paid", availability: "125000000", work: "75000000" }] };
      if (action === "provider-public-start") { setProvider(true); return { enabled: true, state: "online" }; }
      if (action === "provider-public-stop") { setProvider(false); return { enabled: false, state: "off" }; }
      if (action.startsWith("provider-public-")) throw Error("Smoke fixture forbids this provider mutation");
      if (action === "network-overview") {
        if (localOnly) throw Error("Network status is off in Local-Only. Choose Local-First or Network in Settings to view it.");
        return { network: { observedAt: Date.now(), validUntil: Date.now() + 15000, state: "available", readyProviders: 2, waitingRequests: 0, activeJobs: 0, completedToday: 1,
          models: [{ id: "smoke-network", providers: 2, available: true, freeEligible: true, selectable: true }], providers: [{ id: "synthetic-provider", model: "smoke-network", state: "online", lastSeenSecs: 1 }], activity: [{ model: "smoke-network", at: Date.now() }], activityAvailable: true } };
      }
      return fn(event, action, input);
    });
  };
}
module.exports = { install };
