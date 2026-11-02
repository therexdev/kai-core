"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kai", Object.freeze({ apiVersion: 3, call: (method, input) => ipcRenderer.invoke("kai-plugin:call", method, input),
  locale: Object.freeze({
    get: () => ipcRenderer.invoke("kai-plugin:call", "locale.get"),
    onChange(callback) {
      if (typeof callback !== "function") throw TypeError("A language callback is required");
      const listener = (_event, value) => callback(value);
      ipcRenderer.on("kai:locale-changed", listener);
      return () => ipcRenderer.removeListener("kai:locale-changed", listener);
    },
  }),
  dialogs: Object.freeze({
    confirm: (message, options) => ipcRenderer.invoke("kai-plugin:dialog", "confirm", { message, options }),
    alert: (message, options) => ipcRenderer.invoke("kai-plugin:dialog", "alert", { message, options }),
  }),
  onEvent(channel, callback) {
    if (typeof channel !== "string" || !/^[a-zA-Z][a-zA-Z0-9:_.-]{0,179}$/.test(channel) || typeof callback !== "function") throw TypeError("Unsupported plugin event");
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
}));
