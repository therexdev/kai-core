"use strict";
// The INSTALLER identity is new; the OS credential/profile identity is not.
process.env.KAI_CHANNEL = "core";
const path = require("node:path"), fs = require("node:fs");
const electron = require("electron");
const { app, BrowserWindow, dialog, ipcMain, protocol } = electron;
const { channelConfig, configureDesktop, configureUpdater } = require("../core/lib/release-channel");
const release = channelConfig("core"); configureDesktop(app, release);
protocol.registerSchemesAsPrivileged([{ scheme: "kai-plugin", privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } }]);
let core, win, pluginHost, payments, updater, report, shuttingDown = false, installBusy = false;
const { trustedMainDocument, protectNavigation } = require("./window-security");
async function stop() { pluginHost?.closeAll(); await payments?.dispose(); await core?.stop(); }
app.on("before-quit", event => {
  if (!core || shuttingDown) return;
  event.preventDefault(); shuttingDown = true;
  stop().catch(error => console.error("[shutdown]", error.message)).finally(() => app.quit());
});
app.on("window-all-closed", () => app.quit());
if (!app.requestSingleInstanceLock()) {
  app.whenReady().then(() => dialog.showMessageBox({ type: "info", title: "Close the other KAI app first", message: "Another KAI application is already running.",
    detail: "KAI Core, Alpha and Test use the same wallet, models and saved data. Fully quit the running app from its tray menu, then open KAI Core again.", buttons: ["OK"] })).finally(() => app.quit());
} else {
  app.on("second-instance", () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(start).catch(async error => { dialog.showErrorBox("KAI Core could not start", error.message); shuttingDown = true; await stop().catch(() => {}); app.quit(); });
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
  const port = await core.start(), origin = `http://127.0.0.1:${port}`;
  win = new BrowserWindow({ width: 1200, height: 820, minWidth: 800, minHeight: 600, title: "KAI Core", backgroundColor: "#10141d", autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "core-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  protectNavigation(win.webContents, origin, () => {});
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const manager = new (require("../core/lib/plugins/manager").PluginManager)(dataDir);
  let updateBusy = false;
  pluginHost = new (require("./core-plugin-host").PluginHost)({ electron, manager, core });
  payments = require("./koin-test-ipc").registerTestPaymentIPC({ ipcMain, dialog, core, getMainWindow: () => win, origin, dataDir, isTest: false });
  ipcMain.handle("kai-core:call", async (event, method, input) => {
    if (!trustedMainDocument(event, win, origin) || shuttingDown) throw Error("Core desktop access denied");
    switch (method) {
      case "status": return { version: app.getVersion(), profile: report, wallet: core.account.wallet.status(), network: core.gateway.network.status(),
        models: core.models.aliases(), storage: core.models.storageUsage(), runtime: core.runtime.status(), download: core.models.downloadProgress(), importing: core.models.importStatus?.() ?? null, importError: core.gateway._lastImportError ?? null, ensure: core.gateway._ensureJob ? { alias: core.gateway._ensureJob.alias, state: core.gateway._ensureJob.state, error: core.gateway._ensureJob.error } : null, plugins: manager.list() };
      case "plugins.install": {
        if (installBusy) throw Error("Finish the current plugin installation first"); installBusy = true;
        try {
          let verified;
          if (input?.url) {
            if (core.gateway.network.status().privacyMode === "local-only") throw Error("Local-Only blocks plugin downloads. Install a local package or change Privacy.");
            verified = await require("../core/lib/plugins/download").downloadPackage(input.url);
          } else {
            const chosen = await dialog.showOpenDialog(win, { title: "Install a signed KAI plugin", properties: ["openFile"], filters: [{ name: "KAI plugin package", extensions: ["kaiplugin"] }] });
            if (chosen.canceled) return null;
            const file = chosen.filePaths[0];
            if (fs.statSync(file).size > require("../core/lib/plugins/package").MAX_BYTES) throw Error("Plugin exceeds 5 MB");
            verified = require("../core/lib/plugins/package").verifyPackage(fs.readFileSync(file, "utf8"));
          }
          const m = verified.manifest;
          const review = await dialog.showMessageBox(win, { type: "question", title: "Install plugin", message: `Install ${m.name} ${m.version}?`,
            detail: `${m.description || ""}\n\nID: ${m.id}\nPublisher key: ${verified.fingerprint}\n\nPermissions: ${m.permissions.join(", ") || "None"}\n\nThis signature identifies a key; it does not mean KAI has reviewed this publisher. Plugins cannot access your wallet, Brain, private accounts or other plugin data.`,
            buttons: ["Cancel", "Install"], defaultId: 0, cancelId: 0, noLink: true });
          if (review.response !== 1 || shuttingDown || win.isDestroyed()) return null;
          pluginHost.close(m.id); return manager.install(verified.package);
        } finally { installBusy = false; }
      }
      case "plugins.open": return pluginHost.open(input.id);
      case "plugins.change": pluginHost.close(input.id); return manager.change(input.id, input.action);
      case "privacy": return core.gateway.network.configure({ privacyMode: input.mode });
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
          if (restart.response === 1) { await stop(); shuttingDown = true; updater.quitAndInstall(); }
          return { message: "Update downloaded. Check for updates again when you are ready to install." };
        } finally { updateBusy = false; }
      }
      default: throw Error("Unknown core operation");
    }
  });
  await win.loadURL(origin + "/");
}
