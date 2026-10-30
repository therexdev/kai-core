"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const events = new Set(["providers:delta", "providers:changed", "koin:chat-progress", "mascot:open-view", "companion:changed", "mascot:settings", "shell:language-changed", "kai-plugin:navigate"]);
contextBridge.exposeInMainWorld("kai", Object.freeze({ apiVersion: 2, call: (method, input) => ipcRenderer.invoke("kai-plugin:call", method, input),
  onEvent(channel, callback) {
    if (!events.has(channel) || typeof callback !== "function") throw TypeError("Unsupported plugin event");
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
}));
