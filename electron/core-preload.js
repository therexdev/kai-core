"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("kaiCore", Object.freeze({
  call: (method, input) => ipcRenderer.invoke("kai-core:call", method, input),
  credit: (action, input) => ipcRenderer.invoke("koin:test-payments", action, input),
}));

contextBridge.exposeInMainWorld("kaiKoinTestBridge", Object.freeze({ run: (action, input) => ipcRenderer.invoke("koin:test-payments", action, input) }));
