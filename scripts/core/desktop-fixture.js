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
    global.__smokeSetPrivacy = mode => core.settings.set("network.privacyMode", mode);
    return core;
  };
  const originalFetch = global.fetch;
  global.fetch = (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url || String(input));
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      global.__smokeExternalCalls.push(url.origin);
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
