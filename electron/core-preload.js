"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("kaiCore", Object.freeze({
  call: (method, input) => ipcRenderer.invoke("kai-core:call", method, input),
  credit: (action, input) => ipcRenderer.invoke("koin:test-payments", action, input),
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
