"use strict";
// Foundation has its own profile; legacy installations remain untouched.
process.env.KAI_CHANNEL = "core";
const path = require("node:path"), fs = require("node:fs");
const electron = require("electron");
const { app, BrowserWindow, dialog, ipcMain, protocol } = electron;
const { channelConfig, configureDesktop } = require("../core/lib/release-channel");
const release = channelConfig("core"); configureDesktop(app, release);
protocol.registerSchemesAsPrivileged([{ scheme: "kai-plugin", privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } }]);
let core, win, pluginHost, pluginReview, features, payments, coreChat, coreWallet, catalogMonitor, alphaMigration, report, pluginDownload, desktopTray, stopping, shuttingDown = false, shutdownComplete = false, installBusy = false;
const { trustedMainDocument, protectNavigation } = require("./window-security");
function stop() {
  if (!stopping) stopping = (async () => {
    pluginDownload?.abort(); const errors = [];
    // Finish every cleanup even if an earlier service cannot stop normally.
    for (const dispose of [() => alphaMigration?.dispose(), () => pluginReview?.dispose(), () => catalogMonitor?.dispose(), () => coreWallet?.dispose(), () => coreChat?.dispose(), () => pluginHost?.closeAll(), () => features?.dispose(), () => payments?.dispose(), () => core?.stop()]) {
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
    detail: "KAI Core is already running. Open it from its tray icon.", buttons: ["OK"] })).finally(() => app.quit());
} else {
  app.on("second-instance", () => desktopTray?.show());
  app.whenReady().then(start).catch(async error => { if (!shuttingDown) dialog.showErrorBox("KAI Core could not start", error.message); shuttingDown = true; await stop().catch(() => {}); shutdownComplete = true; app.quit(); });
}
async function start() {
  const dataDir = process.env.KAI_CORE_DATA || path.join(app.getPath("userData"), "foundation-v1");
  report = require("./foundation-profile").prepareFoundationProfile(dataDir);
  const service = require("./credit-service").manifest(require("../core/lib/koin-network/credit-service.json"));
  core = await require("../core/server").createCore({ dataDir, uiDirectory: path.join(__dirname, "../ui-core"),
    sessionSecret: require("./wallet-session-secret").machineSecret(dataDir, electron.safeStorage),
    creditAccountOrigin: service.state === "ready" ? new URL(service.config.schedulerUrl).origin : null });
  core.gateway.staticAssets.set("/credit-account.js", path.join(__dirname, "../ui-core/credit-account.js"));
  core.gateway.staticAssets.set("/reward-summary.js", path.join(__dirname, "../ui-core/reward-summary.js"));
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
  async function setPrivacyMode(mode) {
    const state = core.gateway.network.configure({ privacyMode: mode });
    if (state.privacyMode === "local-only") pluginDownload?.abort();
    catalogMonitor.privacyChanged(); coreWallet?.privacyChanged(state.privacyMode);
    await features?.privacyChanged(state.privacyMode); return state;
  }
  async function openCoreView(view, section) {
    if (shuttingDown) throw Error("Application is closing");
    if (!require("./foundation-api").CORE_VIEWS.has(view)) throw Error("Unknown Core page");
    if (section !== undefined && (view !== "settings" || !["website-account", "credit-account"].includes(section))) throw Error("Unknown Core section");
    pluginHost.hide(); desktopTray.show(); win.webContents.send("kai-core:open-view", section ? {page:view,section} : view); return { opened: true };
  }
  const openPlugin = async (id, section) => { await pluginHost.open(id); if (typeof section === "string") pluginHost.renderer(id)?.send("kai-plugin:navigate", { section }); return {opened:true}; };
  features = new (require("./foundation-plugin-services").FoundationPluginServices)({manager,
    createApi: record => require("./foundation-api").createFoundationApi({core,electron,getWindow:()=>win,
      getWebContents:id=>pluginHost?.renderer(id),isVisible:id=>pluginHost?.isVisible(id)||false,
      openPlugin,openCoreView,setPrivacyMode,isClosing:()=>shuttingDown,payments:()=>payments,wallet:()=>coreWallet},record),
    onDisposeError: async (id,error) => { if(!shuttingDown) await dialog.showMessageBox(win,{type:"warning",title:"Plugin could not fully stop",message:`${id} could not fully stop.`,detail:String(error?.message||"Check its running services before restarting."),buttons:["OK"]}); }
  });
  pluginHost = new (require("./core-plugin-host").PluginHost)({ electron, manager, core, features, getContainerWindow: () => win,
    onActivate: view => { if (!shuttingDown && !win.isDestroyed()) win.webContents.send("kai-core:open-view", view); } });
  payments = require("./koin-test-ipc").registerTestPaymentIPC({ ipcMain, dialog, core, getMainWindow: () => win, origin, dataDir, isTest: false });
  coreChat = new (require("./core-chat").CoreChat)({ core });
  coreWallet = require("./core-wallet").createCoreWallet({ dataDir, core, electron, getWindow: () => win, isClosing: () => shuttingDown, withSpend: run => payments.withWalletSpend(run) });
  alphaMigration = require("./alpha-migration").createAlphaMigration({ dataDir, appData: app.getPath("appData"), models: core.models, wallet: core.account.wallet,
    withWalletSpend: run => payments.withWalletSpend(run), chooseDirectory: async () => {
      const chosen = await dialog.showOpenDialog(win, { title: "Choose the Koinos AI Alpha profile folder", properties: ["openDirectory"] });
      return chosen.canceled ? null : chosen.filePaths[0];
    } });
  win.webContents.on("render-process-gone", () => { void coreChat.stop(); });
  win.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) void coreChat.stop(); });
  ipcMain.handle("kai-core:call", async (event, method, input) => {
    if (!trustedMainDocument(event, win, origin) || shuttingDown) throw Error("Core desktop access denied");
    switch (method) {
      case "migration.scan": return alphaMigration.scan();
      case "migration.chooseSource": return alphaMigration.chooseSource();
      case "migration.start": return alphaMigration.start(input);
      case "migration.status": return alphaMigration.status();
      case "migration.cancel": return alphaMigration.cancel();
      case "earn.legacyBalance": return core.gateway.earn.legacyBalance();
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
        let verified;
        try {
          await catalogMonitor.waitForIdle();
          if (shuttingDown) throw Error("Plugin installation stopped because Core is closing");
          const registryState = registry.status();
          const listed = input?.id && registryState.present ? registry.entry(input.id) : null;
          const official = input?.id && !listed ? firstParty.find(p => p.id === input.id) : null;
          if (input?.id && !listed && !official) throw Error("Unknown catalog plugin");
          if (input?.url || official || listed) {
            if (core.gateway.network.status().privacyMode === "local-only") throw Error("Local-Only blocks plugin downloads. Install a local package or change Privacy.");
            pluginDownload = new AbortController();
            verified = await require("../core/lib/plugins/download").downloadPackage(listed?.url || official?.url || input.url, { signal: AbortSignal.any([pluginDownload.signal, AbortSignal.timeout(900000)]), onProgress: progress => { if(!shuttingDown && !win.isDestroyed()) win.webContents.send("kai-core:plugin-download-progress", progress); } });
            if (core.gateway.network.status().privacyMode === "local-only") throw Error("Plugin download cancelled by Local-Only privacy");
            if (listed) verifyRegistryPackage(listed, verified);
            if (official && (verified.manifest.id !== official.id || verified.manifest.version !== official.version || verified.fingerprint !== official.fingerprint)) throw Error("Downloaded plugin does not match the reviewed publisher and release");
          } else {
            const chosen = await dialog.showOpenDialog(win, { title: "Install a signed KAI plugin", properties: ["openFile"], filters: [{ name: "KAI plugin package", extensions: ["kaiplugin"] }] });
            if (chosen.canceled) return null;
            const file = chosen.filePaths[0];
            if (fs.statSync(file).size > require("../core/lib/plugins/package").MAX_BYTES) throw Error("Plugin exceeds the package size limit");
            verified = await require("../core/lib/plugins/package-file-verifier").verifyPackageFile(file, {extract:false});
          }
          const m = verified.manifest;
          const approved = await pluginReview.review(verified, manager.list().find(plugin => plugin.id === m.id)?.version || null,
            firstParty.some(plugin => plugin.id === m.id && plugin.fingerprint === verified.fingerprint));
          if (!approved || shuttingDown || win.isDestroyed() || !trustedMainDocument(event, win, origin)) return null;
          await pluginHost.close(m.id, "update");
          if (shuttingDown || !trustedMainDocument(event, win, origin)) return null;
          const installed = manager.install(verified.package, {trustNative: m.runtime === "native"});
          void features.startInstalledBackground(manager, m.id).catch(error => console.warn("[plugin-startup]", error.message)); return installed;
        } finally { try { await verified?.dispose?.(); } finally { installBusy = false; pluginDownload = null; } }
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
        if (alphaMigration.running) throw Error("Finish migration before creating a wallet.");
        if (core.account.wallet.exists()) throw Error("Your existing wallet is preserved. Unlock it instead.");
        return core.gateway.earn.createWallet({ password: input.password });
      }
      case "wallet.restore": {
        if (alphaMigration.running) throw Error("Finish migration before restoring a wallet.");
        if (core.account.wallet.exists()) throw Error("Your existing wallet is preserved. Unlock it or use its backup controls.");
        return core.gateway.earn.restoreWallet({ wif: input.wif, password: input.password });
      }
      case "models.import": {
        const choice = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "GGUF model", extensions: ["gguf"] }] });
        return choice.canceled ? null : { file: choice.filePaths[0] };
      }
      case "updates.check": {
        await electron.shell.openExternal("https://github.com/therexdev/kai-core/releases/latest");
        return { message: "Downloads opened in your browser. Choose the installer for your computer; Core updates are installed manually." };
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
