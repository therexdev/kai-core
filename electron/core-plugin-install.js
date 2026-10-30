"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");

// This is trusted Core UI, never a page or icon supplied by the plugin. A review
// can approve only the package held by its caller; IPC accepts no package data.
function createPluginInstallReview({ electron, getWindow, isClosing, isTrustedParent }) {
  const { BrowserWindow, ipcMain, session, screen } = electron;
  const directory = path.join(__dirname, "../ui-core");
  const entry = pathToFileURL(path.join(directory, "plugin-install.html")).href;
  const allowed = new Set(["plugin-install.html", "plugin-install.css", "plugin-install.js", "presentation.js", "assets/brand-mark.svg"]
    .map(file => pathToFileURL(path.join(directory, file)).href));
  let pending = null, disposed = false;

  function validParent(record) {
    return !disposed && !isClosing() && !record.parent.isDestroyed() && isTrustedParent(record.parent);
  }
  function requireReview(event) {
    const record = pending;
    if (!record || !validParent(record) || record.window.isDestroyed() || event.sender !== record.window.webContents ||
      event.senderFrame !== record.window.webContents.mainFrame || event.senderFrame.url !== entry) throw Error("Plugin review access denied");
    return record;
  }
  ipcMain.handle("kai-plugin-install:read", event => {
    const record = requireReview(event); record.read = true;
    return record.details;
  });
  ipcMain.handle("kai-plugin-install:decide", (event, choice) => {
    const record = requireReview(event);
    if (!["approve", "cancel"].includes(choice)) throw Error("Invalid plugin review decision");
    if (choice === "approve" && (!record.read || !record.window.isVisible() || !record.parent.isVisible())) throw Error("Open the plugin review before approving");
    record.finish(choice === "approve");
    return true;
  });

  async function review(verified, installedVersion = null, official = false) {
    if (disposed || isClosing()) return false;
    if (pending) throw Error("Finish the current plugin review first");
    const parent = getWindow();
    if (!parent || parent.isDestroyed() || !isTrustedParent(parent)) return false;
    const manifest = verified.manifest;
    const details = Object.freeze({ id: manifest.id, name: manifest.name, version: manifest.version,
      description: manifest.description || "", fingerprint: verified.fingerprint,
      permissions: Object.freeze([...manifest.permissions]), runtime: manifest.runtime, installedVersion, official });
    const isolated = session.fromPartition(`kai-plugin-review-${randomUUID()}`, { cache: false });
    isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !allowed.has(request.url) }));
    const area = screen.getDisplayMatching(parent.getBounds()).workArea;
    const width = Math.min(620, area.width), height = Math.min(740, area.height);
    const window = new BrowserWindow({ parent, modal: true, show: false, width, height,
      minWidth: Math.min(420, width), minHeight: Math.min(440, height), frame: false,
      minimizable: false, maximizable: false, fullscreenable: false, resizable: true,
      title: installedVersion ? "Update plugin · KAI Core" : "Install plugin · KAI Core", backgroundColor: "#f4f7fd",
      webPreferences: { preload: path.join(__dirname, "core-plugin-install-preload.js"), contextIsolation: true,
        sandbox: true, nodeIntegration: false, webSecurity: true, session: isolated, spellcheck: false } });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    let resolve;
    const result = new Promise(done => { resolve = done; });
    const listeners = [];
    const listen = (target, name, fn) => { target.on(name, fn); listeners.push(() => target.removeListener(name, fn)); };
    const record = { parent, window, details, read: false, finish(approved = false) {
      if (pending !== record) return;
      pending = null;
      for (const remove of listeners) remove();
      if (!window.isDestroyed()) window.destroy();
      void isolated.clearStorageData().catch(() => {});
      resolve(approved);
    } };
    pending = record;
    const cancel = () => record.finish(false);
    // Closing to tray, reloading Core, or losing either renderer invalidates the
    // review. A future request must open a fresh review of its own exact package.
    listen(parent, "closed", cancel); listen(parent, "hide", cancel);
    listen(parent.webContents, "render-process-gone", cancel);
    listen(parent.webContents, "did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) cancel(); });
    listen(window, "closed", cancel);
    listen(window.webContents, "render-process-gone", cancel);
    listen(window.webContents, "destroyed", cancel);
    listen(window.webContents, "will-navigate", event => { event.preventDefault(); cancel(); });
    listen(window.webContents, "will-redirect", event => { event.preventDefault(); cancel(); });
    listen(window.webContents, "will-attach-webview", event => event.preventDefault());
    listen(window.webContents, "before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") { event.preventDefault(); cancel(); }
    });
    let loaded = false;
    listen(window.webContents, "did-start-navigation", (_event, url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace && (loaded || url !== entry)) cancel();
    });
    try {
      await window.loadFile(path.join(directory, "plugin-install.html"));
      loaded = true;
      if (pending === record && validParent(record) && parent.isVisible()) { window.show(); window.focus(); }
      else cancel();
    } catch { cancel(); }
    return result;
  }

  function dispose() {
    disposed = true; pending?.finish(false);
    ipcMain.removeHandler("kai-plugin-install:read");
    ipcMain.removeHandler("kai-plugin-install:decide");
  }
  return { review, dispose };
}
module.exports = { createPluginInstallReview };
