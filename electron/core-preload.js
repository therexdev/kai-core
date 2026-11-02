"use strict";
const { contextBridge, ipcRenderer } = require("electron");
let closing = null;
const closingListeners = new Set();
ipcRenderer.on("kai-core:closing", (_event, value) => {
  if (closing) return;
  closing = Object.freeze({ reason: value?.reason === "update" ? "update" : "quit" });
  for (const callback of closingListeners) callback(closing);
});
contextBridge.exposeInMainWorld("kaiCore", Object.freeze({
  locale: Object.freeze({
    get: () => ipcRenderer.invoke("kai-core:call", "locale.get"),
    set: language => ipcRenderer.invoke("kai-core:call", "locale.set", { language }),
    onChange(callback) {
      if (typeof callback !== "function") throw TypeError("A language callback is required");
      const listener = (_event, value) => callback(value);
      ipcRenderer.on("kai:locale-changed", listener);
      return () => ipcRenderer.removeListener("kai:locale-changed", listener);
    },
  }),
  isClosing: () => closing !== null,
  onClosing: callback => {
    if (typeof callback !== "function") throw TypeError("A closing callback is required");
    closingListeners.add(callback);
    if (closing) callback(closing);
    return () => closingListeners.delete(callback);
  },
  call: (method, input) => ipcRenderer.invoke("kai-core:call", method, input),
  credit: (action, input) => ipcRenderer.invoke("koin:test-payments", action, input),
  dialogs: Object.freeze({
    confirm: (message, options) => ipcRenderer.invoke("kai-core:call", "dialog.confirm", { message, options }),
    alert: (message, options) => ipcRenderer.invoke("kai-core:call", "dialog.alert", { message, options }),
  }),
  onOpenView: callback => {
    if (typeof callback !== "function") throw TypeError("A navigation callback is required");
    const listener = (_event, view) => callback(view);
    ipcRenderer.on("kai-core:open-view", listener);
    return () => ipcRenderer.removeListener("kai-core:open-view", listener);
  },
  onPluginCatalogChange: callback => {
    if (typeof callback !== "function") throw TypeError("A catalog change callback is required");
    const listener = () => callback();
    ipcRenderer.on("kai-core:plugin-catalog-changed", listener);
    return () => ipcRenderer.removeListener("kai-core:plugin-catalog-changed", listener);
  },
  onPluginDownloadProgress: callback => {
    if (typeof callback !== "function") throw TypeError("A progress callback is required");
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("kai-core:plugin-download-progress", listener);
    return () => ipcRenderer.removeListener("kai-core:plugin-download-progress", listener);
  },
  onChatProgress: callback => {
    if (typeof callback !== "function") throw TypeError("A progress callback is required");
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("koin:chat-progress", listener);
    return () => ipcRenderer.removeListener("koin:chat-progress", listener);
  },
}));

contextBridge.exposeInMainWorld("kaiKoinTestBridge", Object.freeze({ run: (action, input) => ipcRenderer.invoke("koin:test-payments", action, input) }));
