"use strict";
// The INSTALLER identity is new; the OS credential/profile identity is not.
process.env.KAI_CHANNEL = "core";
const path = require("node:path"), fs = require("node:fs");
const electron = require("electron");
const { app, BrowserWindow, dialog, ipcMain, protocol } = electron;
const { channelConfig, configureDesktop, configureUpdater } = require("../core/lib/release-channel");
const release = channelConfig("core"); configureDesktop(app, release);
protocol.registerSchemesAsPrivileged([{ scheme: "kai-plugin", privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } }]);
let core, win, pluginHost, pluginReview, features, payments, coreChat, coreWallet, catalogMonitor, updater, report, pluginDownload, desktopTray, stopping, shuttingDown = false, shutdownComplete = false, installBusy = false;
const { trustedMainDocument, protectNavigation } = require("./window-security");
function stop() {
  if (!stopping) stopping = (async () => {
    pluginDownload?.abort(); const errors = [];
    // Finish every cleanup even if an earlier service cannot stop normally.
    for (const dispose of [() => pluginReview?.dispose(), () => catalogMonitor?.dispose(), () => coreWallet?.dispose(), () => coreChat?.dispose(), () => pluginHost?.closeAll(), () => features?.dispose(), () => payments?.dispose(), () => core?.stop()]) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    desktopTray?.dispose();
    if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join("; "));
  })();
  return stopping;
}
app.on("before-quit", event => {
  if (!core || shutdownComplete) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  stop().catch(error => console.error("[shutdown]", error.message)).finally(() => { shutdownComplete = true; app.quit(); });
});
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => desktopTray?.dispose());
if (!app.requestSingleInstanceLock()) {
  app.whenReady().then(() => dialog.showMessageBox({ type: "info", title: "Close the other KAI app first", message: "Another KAI application is already running.",
    detail: "KAI Core, Alpha and Test use the same wallet, models and saved data. Fully quit the running app from its tray menu, then open KAI Core again.", buttons: ["OK"] })).finally(() => app.quit());
} else {
  app.on("second-instance", () => desktopTray?.show());
  app.whenReady().then(start).catch(async error => { if (!shuttingDown) dialog.showErrorBox("KAI Core could not start", error.message); shuttingDown = true; await stop().catch(() => {}); shutdownComplete = true; app.quit(); });
}
async function start() {
  const dataDir = process.env.KAI_CORE_DATA || path.join(app.getPath("userData"), "core");
  report = require("../core/lib/core-profile").prepareProfile(dataDir, require("../package.json").version);
  require("./desktop-first-run").initializeDesktopProfile(dataDir);
  const service = require("./credit-service").manifest(require("../core/lib/koin-network/credit-service.json"));
  core = await require("../core/server").createCore({ dataDir, extensions: false, uiDirectory: path.join(__dirname, "../ui-core"),
    sessionSecret: require("./wallet-session-secret").machineSecret(dataDir, electron.safeStorage),
    creditAccountOrigin: service.state === "ready" ? new URL(service.config.schedulerUrl).origin : null });
  core.gateway.staticAssets.set("/credit-account.js", path.join(__dirname, "../ui/credit-account.js"));
  core.gateway.staticAssets.set("/reward-summary.js", path.join(__dirname, "../ui/reward-summary.js"));
  const port = await core.start(), origin = `http://127.0.0.1:${port}`;
  if (shuttingDown) return;
  win = new BrowserWindow({ width: 1200, height: 820, minWidth: 800, minHeight: 600, title: "KAI Core", backgroundColor: "#f4f7fd", autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "core-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  desktopTray = require("./core-tray").createCoreTray({ app, win, Tray: electron.Tray, Menu: electron.Menu, nativeImage: electron.nativeImage,
    iconDirectory: path.join(__dirname, "../build"), isQuitting: () => shuttingDown });
  protectNavigation(win.webContents, origin, () => {});
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  pluginReview = require("./core-plugin-install").createPluginInstallReview({ electron, getWindow: () => win, isClosing: () => shuttingDown,
    isTrustedParent: parent => trustedMainDocument({ sender: parent.webContents, senderFrame: parent.webContents.mainFrame }, win, origin) });
  const manager = new (require("../core/lib/plugins/manager").PluginManager)(dataDir);
  const appOrder = require("./core-app-order").createAppOrder({ dataDir, getInstalled: () => manager.list() });
  const { RegistryClient, verifyRegistryPackage } = require("../core/lib/plugins/registry");
  const registry = new RegistryClient({ dataDir, coreVersion: require("../package.json").version });
  const firstParty = require("../core/lib/plugins/first-party.json").plugins;
  function catalog() {
    const state = registry.status();
    const entries = state.available && !state.expired ? registry.list() : !state.present ? firstParty.map(p => ({ ...p, compatible: true })) : [];
    return entries.map(({ id, name, description, version, compatible, compatibilityReason, repository, minCoreVersion, fingerprint }) =>
      ({ id, name, description, version, compatible, compatibilityReason, repository, minCoreVersion, fingerprint, official: firstParty.some(p => p.id === id && p.fingerprint === fingerprint) }));
  }
  catalogMonitor = require("./core-plugin-catalog").createCatalogMonitor({ registry,
    isLocalOnly: () => core.gateway.network.status().privacyMode === "local-only",
    isBusy: () => installBusy || shuttingDown,
    onChange: () => {
      if (!shuttingDown && trustedMainDocument({ sender: win?.webContents, senderFrame: win?.webContents?.mainFrame }, win, origin))
        win.webContents.send("kai-core:plugin-catalog-changed");
    }
  });
  const wakeCatalog = () => { if (!shuttingDown) void catalogMonitor.wake(); };
  win.on("focus", wakeCatalog); win.on("show", wakeCatalog);
  electron.powerMonitor.on("resume", wakeCatalog);
  let updateBusy = false;
  async function setPrivacyMode(mode) {
    const state = core.gateway.network.configure({ privacyMode: mode });
    if (state.privacyMode === "local-only") pluginDownload?.abort();
    catalogMonitor.privacyChanged(); coreWallet?.privacyChanged(state.privacyMode);
    await features?.privacyChanged(state.privacyMode); return state;
  }
  async function openCoreView(view) {
    if (shuttingDown) throw Error("Application is closing");
    const target = require("./core-plugin-desktop").resolveView(view);
    if (target.plugin) {
      await pluginHost.open(target.plugin);
      if (target.section) pluginHost.renderer(target.plugin)?.send("kai-plugin:navigate", { section: target.section });
      return { opened: true };
    }
    pluginHost.hide(); desktopTray.show(); win.webContents.send("kai-core:open-view", target.page); return { opened: true };
  }
  features = new (require("./plugin-services").FeatureServices)({ dataDir, core, electron,
    getWindow: () => win, localInference: (input, signal) => pluginHost.runLocal(input, signal),
    getCoreWindow: () => win,
    getPluginWindow: id => pluginHost?.windows.get(id)?.window,
    getPluginWebContents: id => pluginHost?.renderer(id),
    isPluginVisible: id => pluginHost?.isVisible(id) || false,
    loadInstalledPlugin: id => { if (!manager.list().some(row => row.id === id && row.enabled)) return null; return manager.load(id); },
    readCoreWalletSummary: () => coreWallet.call("wallet.summary", {}),
    openPlugin: id => pluginHost.open(id),
    openCoreView, setPrivacyMode,
    withWalletSpend: run => payments.withWalletSpend(run),
    runPayment: (action, input, options) => payments.runForPlugin(action, input, options),
    desktopCall: require("./core-plugin-desktop").createPluginDesktop({ electron, getCoreWindow: () => win, hidePlugins: () => pluginHost.hide(), openPlugin: async (id, section) => { await pluginHost.open(id); if (section) pluginHost.renderer(id)?.send("kai-plugin:navigate", { section }); }, isClosing: () => shuttingDown,
      confirm: async (title, detail) => { const result = await dialog.showMessageBox(win, { type: "question", title, message: title, detail, buttons: ["Cancel", "Open"], defaultId: 0, cancelId: 0 }); return result.response === 1 && !shuttingDown; } }),
    onDisposeError: async id => {
      const name = firstParty.find(plugin => plugin.id === id)?.name || "Plugin";
      const options = { type: "warning", title: `${name} could not fully stop`, message: `${name} could not finish shutting down.`,
        detail: id === "kai.koinos-node" ? "Docker may still be running this node. Check Docker and stop the KAI node containers before starting another KAI application." : "Check the service before starting it again. Core has closed the plugin window and revoked its access.", buttons: ["OK"] };
      if (win && !win.isDestroyed()) await dialog.showMessageBox(win, options); else await dialog.showMessageBox(options);
    },
    confirm: async (title, detail) => {
      if (shuttingDown) return false;
      const result = await dialog.showMessageBox(win, { type: "question", title, message: title, detail: (typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)).slice(0, 12000), buttons: ["Cancel", "Allow once"], defaultId: 0, cancelId: 0, noLink: true });
      return result.response === 1 && !shuttingDown;
    }
  });
  pluginHost = new (require("./core-plugin-host").PluginHost)({ electron, manager, core, features, getContainerWindow: () => win,
    onActivate: view => { if (!shuttingDown && !win.isDestroyed()) win.webContents.send("kai-core:open-view", view); } });
  payments = require("./koin-test-ipc").registerTestPaymentIPC({ ipcMain, dialog, core, getMainWindow: () => win, origin, dataDir, isTest: false });
  coreChat = new (require("./core-chat").CoreChat)({ core });
  coreWallet = require("./core-wallet").createCoreWallet({ dataDir, core, electron, getWindow: () => win, isClosing: () => shuttingDown, withSpend: run => payments.withWalletSpend(run) });
  win.webContents.on("render-process-gone", () => { void coreChat.stop(); });
  win.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) void coreChat.stop(); });
  ipcMain.handle("kai-core:call", async (event, method, input) => {
    if (!trustedMainDocument(event, win, origin) || shuttingDown) throw Error("Core desktop access denied");
    switch (method) {
      case "chat.local": return coreChat.send(input);
      case "chat.stop": return coreChat.stop();
      case "status": {
        const installed = manager.list().map(plugin => ({ ...plugin, backgroundError: features.backgroundErrors?.get(plugin.id) || null })), entries = catalog();
        return { version: app.getVersion(), desktop: { trayAvailable: desktopTray.available }, profile: report, wallet: core.account.wallet.status(), network: core.gateway.network.status(),
          models: core.models.aliases(), storage: core.models.storageUsage(), runtime: core.runtime.status(), download: core.models.downloadProgress(), importing: core.models.importStatus?.() ?? null, importError: core.gateway._lastImportError ?? null, ensure: core.gateway._ensureJob ? { alias: core.gateway._ensureJob.alias, state: core.gateway._ensureJob.state, error: core.gateway._ensureJob.error } : null,
          plugins: installed, pluginsOrder: appOrder.read(), catalog: entries, registry: registry.status(), pluginUpdates: require("../core/lib/plugins/updates").pluginUpdates(installed, entries), catalogCheck: catalogMonitor.status() };
      }
      case "plugins.registry.refresh": {
        await catalogMonitor.refresh(); return registry.status();
      }
      case "plugins.registry.check": await catalogMonitor.wake(); return registry.status();
      case "plugins.install": {
        if (installBusy) throw Error("Finish the current plugin operation first"); installBusy = true;
        try {
          await catalogMonitor.waitForIdle();
          if (shuttingDown) throw Error("Plugin installation stopped because Core is closing");
          let verified;
          const registryState = registry.status();
          const listed = input?.id && registryState.present ? registry.entry(input.id) : null;
          const official = input?.id && !listed ? firstParty.find(p => p.id === input.id) : null;
          if (input?.id && !listed && !official) throw Error("Unknown catalog plugin");
          if (input?.url || official || listed) {
            if (core.gateway.network.status().privacyMode === "local-only") throw Error("Local-Only blocks plugin downloads. Install a local package or change Privacy.");
            pluginDownload = new AbortController();
            verified = await require("../core/lib/plugins/download").downloadPackage(listed?.url || official?.url || input.url, { signal: AbortSignal.any([pluginDownload.signal, AbortSignal.timeout(30000)]) });
            if (core.gateway.network.status().privacyMode === "local-only") throw Error("Plugin download cancelled by Local-Only privacy");
            if (listed) verifyRegistryPackage(listed, verified);
            if (official && (verified.manifest.id !== official.id || verified.manifest.version !== official.version || verified.fingerprint !== official.fingerprint)) throw Error("Downloaded plugin does not match the reviewed publisher and release");
          } else {
            const chosen = await dialog.showOpenDialog(win, { title: "Install a signed KAI plugin", properties: ["openFile"], filters: [{ name: "KAI plugin package", extensions: ["kaiplugin"] }] });
            if (chosen.canceled) return null;
            const file = chosen.filePaths[0];
            if (fs.statSync(file).size > require("../core/lib/plugins/package").MAX_BYTES) throw Error("Plugin exceeds 24 MB");
            verified = require("../core/lib/plugins/package").verifyPackage(fs.readFileSync(file, "utf8"));
          }
          const m = verified.manifest;
          const approved = await pluginReview.review(verified, manager.list().find(plugin => plugin.id === m.id)?.version || null,
            firstParty.some(plugin => plugin.id === m.id && plugin.fingerprint === verified.fingerprint));
          if (!approved || shuttingDown || win.isDestroyed() || !trustedMainDocument(event, win, origin)) return null;
          await pluginHost.close(m.id, "update");
          if (shuttingDown || !trustedMainDocument(event, win, origin)) return null;
          const installed = manager.install(verified.package);
          void features.startInstalledBackground(manager, m.id).catch(error => console.warn("[plugin-startup]", error.message)); return installed;
        } finally { installBusy = false; pluginDownload = null; }
      }
      case "plugins.open": return pluginHost.open(input?.id, input?.bounds);
      case "plugins.hide": return pluginHost.hide();
      case "plugins.bounds": { const { id, ...bounds } = input || {}; return pluginHost.setBounds(bounds, id); }
      case "plugins.order": return { ids: appOrder.save(input?.ids) };
      case "plugins.change": { await pluginHost.close(input.id, input.action); const installed = manager.change(input.id, input.action);
        if (["enable", "rollback"].includes(input.action)) void features.startInstalledBackground(manager, input.id).catch(error => console.warn("[plugin-startup]", error.message)); return installed; }
      case "privacy": {
        return setPrivacyMode(input.mode);
      }
      case "wallet.summary":
      case "wallet.history":
      case "wallet.copyAddress":
      case "wallet.openExplorer":
      case "wallet.reveal":
      case "wallet.send": return coreWallet.call(method, input);
      case "wallet.unlock": return core.gateway.earn.unlock({ password: input.password });
      case "wallet.lock": return core.gateway.earn.lock();
      case "wallet.create": {
        if (core.account.wallet.exists()) throw Error("Your existing wallet is preserved. Unlock it instead.");
        return core.gateway.earn.createWallet({ password: input.password });
      }
      case "wallet.restore": {
        if (core.account.wallet.exists()) throw Error("Your existing wallet is preserved. Use the old app's recovery controls if needed.");
        return core.gateway.earn.restoreWallet({ wif: input.wif, password: input.password });
      }
      case "models.import": {
        const choice = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "GGUF model", extensions: ["gguf"] }] });
        return choice.canceled ? null : { file: choice.filePaths[0] };
      }
      case "updates.check": {
        if (!app.isPackaged) return { message: "Source checkout: updates come from the repository." };
        if (!updater) { updater = process.platform === "linux" ? new (require("./appimage-updater").KaiAppImageUpdater)() : require("electron-updater").autoUpdater;
          configureUpdater(updater, release); updater.autoDownload = false; updater.autoInstallOnAppQuit = false;
          updater.on("error", error => console.warn("[update]", error.message)); }
        if (updateBusy) throw Error("An update check is already in progress");
        updateBusy = true;
        try {
          const r = await updater.checkForUpdates();
          const available = r?.updateInfo?.version && require("semver").gt(r.updateInfo.version, app.getVersion());
          if (!available) return { message: "You have the latest published version." };
          const answer = await dialog.showMessageBox(win, { type: "question", title: "KAI Core update", message: `Download KAI Core ${r.updateInfo.version}?`, detail: "Only this Core application will be updated. Your shared profile stays in place.", buttons: ["Later", "Download"], defaultId: 0, cancelId: 0 });
          if (answer.response !== 1) return { message: `Version ${r.updateInfo.version} is available.` };
          await updater.downloadUpdate();
          const restart = await dialog.showMessageBox(win, { type: "question", title: "Update ready", message: "Restart KAI Core to install the update?", detail: "Active work will be stopped before installation.", buttons: ["Later", "Restart"], defaultId: 0, cancelId: 0 });
          if (restart.response === 1) {
            shuttingDown = true;
            try { await stop(); } catch (error) { shutdownComplete = true; app.quit(); throw error; }
            shutdownComplete = true; require("./core-update-install").installAndQuit({ updater, app, dialog });
          }
          return { message: "Update downloaded. Check for updates again when you are ready to install." };
        } finally { updateBusy = false; }
      }
      case "desktop.openExternal": {
        if (typeof input?.url !== "string" || input.url.length > 4000) throw Error("Invalid website address");
        const url = new URL(input.url);
        if (url.protocol !== "https:" || url.username || url.password) throw Error("Use an HTTPS website address without credentials");
        const answer = await dialog.showMessageBox(win, { type: "question", title: "Open website", message: "Open this website in your browser?", detail: url.href, buttons: ["Cancel", "Open"], defaultId: 0, cancelId: 0 });
        if (answer.response !== 1 || shuttingDown) return { cancelled: true };
        await electron.shell.openExternal(url.href); return { opened: true };
      }
      default: throw Error("Unknown core operation");
    }
  });
  await win.loadURL(origin + "/");
  if (!shuttingDown) catalogMonitor.start();
  if (!shuttingDown) void features.startInstalledBackground(manager).catch(error => console.warn("[plugin-startup]", error.message));
}
