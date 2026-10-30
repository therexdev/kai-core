"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("kai", Object.freeze({ apiVersion: 1, call: (method, input) => ipcRenderer.invoke("kai-plugin:call", method, input) }));
