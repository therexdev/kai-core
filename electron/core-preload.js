"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("kaiCore", Object.freeze({
  call: (method, input) => ipcRenderer.invoke("kai-core:call", method, input),
  credit: (action, input) => ipcRenderer.invoke("koin:test-payments", action, input),
  onChatProgress: callback => {
    if (typeof callback !== "function") throw TypeError("A progress callback is required");
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("koin:chat-progress", listener);
    return () => ipcRenderer.removeListener("koin:chat-progress", listener);
  },
}));

contextBridge.exposeInMainWorld("kaiKoinTestBridge", Object.freeze({ run: (action, input) => ipcRenderer.invoke("koin:test-payments", action, input) }));
