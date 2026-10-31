"use strict";
const path = require("node:path"), { pathToFileURL } = require("node:url"), { randomUUID } = require("node:crypto");
const CHANNELS = { read: "kai-dialog:read", decide: "kai-dialog:decide", checkbox: "kai-dialog:checkbox" };
function normalize(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw Error("Invalid dialog options");
  const text = (value, fallback, max) => { if (value === undefined) return fallback; if (typeof value !== "string" || Buffer.byteLength(value) > max) throw Error("Dialog text is invalid or too long"); return value; };
  const buttons = options.buttons === undefined || Array.isArray(options.buttons) && !options.buttons.length ? ["OK"] : options.buttons;
  if (!Array.isArray(buttons) || buttons.length > 12 || buttons.some(button => typeof button !== "string" || !button.trim() || Buffer.byteLength(button) > 256)) throw Error("Invalid dialog buttons");
  const inferred = buttons.findIndex(button => /^(cancel|no|close)$/i.test(button.replace(/&/g, "").trim()));
  const cancelId = options.cancelId ?? (inferred >= 0 ? inferred : buttons.length === 1 && /^ok$/i.test(buttons[0]) ? 0 : -1);
  const defaultId = options.defaultId ?? cancelId;
  if (![cancelId, defaultId].every(id => Number.isInteger(id) && id >= -1 && id < buttons.length)) throw Error("Invalid dialog button index");
  const type = options.type ?? "none";
  if (!["none", "info", "error", "question", "warning"].includes(type)) throw Error("Invalid dialog type");
  if (options.checkboxChecked !== undefined && typeof options.checkboxChecked !== "boolean") throw Error("Invalid dialog checkbox");
  return Object.freeze({ type, title: text(options.title, "KAI Core", 2048), message: text(options.message, "", 32768), detail: text(options.detail, "", 262144),
    buttons: Object.freeze([...buttons]), defaultId, cancelId, noLink: options.noLink !== false,
    checkboxLabel: text(options.checkboxLabel, "", 2048), checkboxChecked: !!options.checkboxChecked });
}

// All dialog content comes from trusted main-process callers. Untrusted renderers
// cannot open this surface or choose which pending request receives a decision.
function createCoreDialogs({ electron, getWindow = () => null, isClosing = () => false }) {
  const { BrowserWindow, ipcMain, session, screen, app } = electron;
  const directory = path.join(__dirname, "../ui-core"), file = path.join(directory, "dialog.html"), entry = pathToFileURL(file).href;
  const allowed = new Set(["dialog.html", "dialog.css", "dialog.js", "assets/brand-mark.svg"].map(name => pathToFileURL(path.join(directory, name)).href));
  const queue = []; let active = null, disposed = false;
  const closing = () => disposed || isClosing();
  const parentValid = record => !record.parent || (!record.parent.isDestroyed() && record.parent.isVisible() && !record.parent.webContents.isDestroyed() && record.parent.webContents.mainFrame === record.parentFrame && record.parentFrame.url === record.parentUrl);
  function requireRecord(event) {
    const record = active;
    if (!record || record.finished || closing() || !parentValid(record) || !record.window || record.window.isDestroyed() ||
      event.sender !== record.window.webContents || event.senderFrame !== record.window.webContents.mainFrame || event.senderFrame.url !== entry) throw Error("Dialog access denied");
    return record;
  }
  ipcMain.handle(CHANNELS.read, event => { const record = requireRecord(event); record.read = true; return record.details; });
  ipcMain.handle(CHANNELS.checkbox, (event, checked) => {
    const record = requireRecord(event);
    if (!record.read || !record.window.isVisible() || !record.details.checkboxLabel || typeof checked !== "boolean") throw Error("Invalid dialog checkbox");
    record.checkboxChecked = checked; return true;
  });
  ipcMain.handle(CHANNELS.decide, (event, decision) => {
    const record = requireRecord(event);
    if (!decision || typeof decision !== "object" || Array.isArray(decision) || Object.keys(decision).some(key => !["response", "cancel", "checkboxChecked"].includes(key)) ||
      typeof decision.checkboxChecked !== "boolean" || (decision.cancel !== true && (!Number.isInteger(decision.response) || decision.response < 0 || decision.response >= record.details.buttons.length)) ||
      (decision.cancel !== undefined && decision.cancel !== true) || (decision.cancel === true && decision.response !== undefined)) throw Error("Invalid dialog decision");
    const response = decision.cancel === true ? record.details.cancelId : decision.response;
    if (response !== record.details.cancelId && (!record.read || !record.window.isVisible())) throw Error("Open the dialog before choosing an action");
    record.checkboxChecked = record.details.checkboxLabel && record.read ? decision.checkboxChecked : record.checkboxChecked;
    record.finish(response); return true;
  });
  function listen(record, target, name, callback) { target.on(name, callback); record.listeners.push(() => target.removeListener(name, callback)); }
  async function display(record) {
    try {
      if (app?.whenReady) await app.whenReady();
      if (record.finished || closing() || !parentValid(record)) { record.finish(); return; }
      const isolated = record.session = session.fromPartition("kai-dialog-" + randomUUID(), { cache: false });
      isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false)); isolated.setPermissionCheckHandler(() => false);
      isolated.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !allowed.has(request.url) }));
      if (isolated.on) listen(record, isolated, "will-download", event => event.preventDefault());
      const area = (record.parent ? screen.getDisplayMatching(record.parent.getBounds()) : screen.getPrimaryDisplay()).workArea;
      const width = Math.min(620, area.width), height = Math.min(record.details.detail.length > 1200 ? 660 : record.details.detail || record.details.checkboxLabel ? 490 : 340, area.height);
      const window = record.window = new BrowserWindow({ ...(record.parent ? { parent: record.parent, modal: true } : {}), show: false, frame: false,
        width, height, minWidth: Math.min(360, width), minHeight: Math.min(280, height), resizable: true, minimizable: false, maximizable: false, fullscreenable: false,
        title: record.details.title || "KAI Core", backgroundColor: "#f4f7fd", webPreferences: { preload: path.join(__dirname, "core-dialogs-preload.js"),
          sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, session: isolated, spellcheck: false } });
      window.setMenu(null); window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const cancel = () => record.finish();
      listen(record, window, "closed", cancel); listen(record, window, "hide", cancel);
      listen(record, window.webContents, "destroyed", cancel); listen(record, window.webContents, "render-process-gone", cancel);
      for (const name of ["will-navigate", "will-redirect"]) listen(record, window.webContents, name, event => { event.preventDefault(); cancel(); });
      listen(record, window.webContents, "will-attach-webview", event => event.preventDefault());
      listen(record, window.webContents, "before-input-event", (event, input) => { if (input.type === "keyDown" && input.key === "Escape") { event.preventDefault(); cancel(); } });
      let loaded = false;
      listen(record, window.webContents, "did-start-navigation", (_event, url, _inPlace, mainFrame) => { if (mainFrame && (loaded || url !== entry)) cancel(); });
      await window.loadFile(file); loaded = true;
      if (!record.finished && !closing() && parentValid(record)) { window.show(); window.focus(); } else cancel();
    } catch { record.finish(); }
  }
  function pump() {
    if (active || closing()) return;
    const record = queue.shift(); if (!record) return;
    active = record; void display(record);
  }
  async function showMessageBox(parentOrOptions, suppliedOptions) {
    const options = suppliedOptions === undefined ? parentOrOptions : suppliedOptions;
    const details = normalize(options), parent = suppliedOptions === undefined ? getWindow() : parentOrOptions || null, signal = options.signal;
    if (signal !== undefined && (!signal || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function" || typeof signal.aborted !== "boolean")) throw Error("Invalid dialog cancellation signal");
    if (closing() || signal?.aborted) return { response: details.cancelId, checkboxChecked: details.checkboxChecked };
    if (parent && (typeof parent.isDestroyed !== "function" || typeof parent.isVisible !== "function" || !parent.webContents || typeof parent.webContents.isDestroyed !== "function")) throw Error("Invalid dialog parent");
    if (parent && (parent.isDestroyed() || !parent.isVisible() || parent.webContents.isDestroyed())) return { response: details.cancelId, checkboxChecked: details.checkboxChecked };
    if (queue.length >= 64) throw Error("Too many pending dialogs");
    return new Promise(resolve => {
      const record = { parent, parentFrame: parent?.webContents.mainFrame, parentUrl: parent?.webContents.mainFrame?.url, details, checkboxChecked: details.checkboxChecked,
        listeners: [], read: false, finished: false, window: null, finish(response = details.cancelId) {
          if (record.finished) return; record.finished = true;
          for (const remove of record.listeners) remove(); record.listeners.length = 0;
          const index = queue.indexOf(record); if (index !== -1) queue.splice(index, 1); if (active === record) active = null;
          if (record.window && !record.window.isDestroyed()) record.window.destroy();
          if (record.session) void record.session.clearStorageData().catch(() => {});
          resolve({ response, checkboxChecked: record.checkboxChecked }); queueMicrotask(pump);
        } };
      if (parent) {
        const cancel = () => record.finish();
        for (const name of ["closed", "hide"]) listen(record, parent, name, cancel);
        for (const name of ["destroyed", "render-process-gone"]) listen(record, parent.webContents, name, cancel);
        listen(record, parent.webContents, "did-start-navigation", (_event, _url, _inPlace, mainFrame) => { if (mainFrame) cancel(); });
      }
      if (signal) { const cancel = () => record.finish(); signal.addEventListener("abort", cancel, { once: true }); record.listeners.push(() => signal.removeEventListener("abort", cancel)); }
      if (!parentValid(record) || signal?.aborted) { record.finish(); return; }
      queue.push(record); pump();
    });
  }
  async function showErrorBox(title, message) { await showMessageBox({ type: "error", title, message, buttons: ["Close"], cancelId: 0, defaultId: 0 }); }
  function dispose() {
    if (disposed) return; disposed = true;
    active?.finish(); for (const record of [...queue]) record.finish();
    for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler(channel);
  }
  return { showMessageBox, showErrorBox, dispose };
}
module.exports = { createCoreDialogs };
