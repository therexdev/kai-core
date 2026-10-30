"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kai", Object.freeze({ apiVersion: 3, call: (method, input) => ipcRenderer.invoke("kai-plugin:call", method, input),
  onEvent(channel, callback) {
    if (typeof channel !== "string" || !/^[a-zA-Z][a-zA-Z0-9:_.-]{0,179}$/.test(channel) || typeof callback !== "function") throw TypeError("Unsupported plugin event");
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
}));
