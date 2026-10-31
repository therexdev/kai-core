"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("kaiDialog", Object.freeze({
  read: () => ipcRenderer.invoke("kai-dialog:read"),
  decide: decision => ipcRenderer.invoke("kai-dialog:decide", decision),
  setCheckbox: checked => ipcRenderer.invoke("kai-dialog:checkbox", checked),
}));
