"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("kaiPluginInstall", Object.freeze({
  read: () => ipcRenderer.invoke("kai-plugin-install:read"),
  decide: choice => ipcRenderer.invoke("kai-plugin-install:decide", choice),
}));
