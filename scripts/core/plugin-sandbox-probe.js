"use strict";

// Synthetic native verification only: no existing KAI profile, wallet, models,
// accounts or public network is opened. The local HTTP canary must see no calls.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const electron = require("electron");
const { app, protocol, ipcMain } = electron;
const { PluginManager } = require("../../core/lib/plugins/manager");
const { canonical } = require("../../core/lib/plugins/package");
const { PluginHost } = require("../../electron/core-plugin-host");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-plugin-probe-"));
const profile = path.join(root, "profile");
fs.mkdirSync(profile);
app.setName("KAI Synthetic Plugin Probe");
app.setPath("userData", profile);
app.setPath("sessionData", profile);
app.disableHardwareAcceleration();
// Running this dedicated fixture as root in a CI/container requires Chromium's
// sandbox override. Production core-main.js never sets this switch.
if (process.platform === "linux" && process.getuid?.() === 0) app.commandLine.appendSwitch("no-sandbox");
if (process.platform === "linux" && !process.env.DISPLAY) app.commandLine.appendSwitch("ozone-platform", "headless");
protocol.registerSchemesAsPrivileged([{ scheme: "kai-plugin", privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } }]);

let host, server, finished = false, requests = 0;
const deadline = setTimeout(() => finish(Error("Native plugin probe exceeded 45 seconds")), 45000);
function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(deadline);
  host?.closeAll(); ipcMain.removeHandler("kai-plugin:call");
  server?.closeAllConnections(); server?.close();
  if (error) console.error(error.stack || error);
  else console.log("PASS: native plugin renderer loads signed assets; permitted broker calls work; Node, wallet, file/network fetch, popups, frames and navigation are blocked; storage is isolated.");
  // Windows may hold Chromium cache handles until the process exits. These
  // files contain only generated test data and are never application data.
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  app.exit(error ? 1 : 0);
}
process.on("uncaughtException", finish);
process.on("unhandledRejection", finish);

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
function fixture(id, permissions) {
  const manifest = { schema: 1, apiVersion: 1, id, name: "Synthetic plugin probe", version: "1.0.0", entry: "index.html", permissions };
  const files = {
    "index.html": '<!doctype html><html><head><meta charset="utf-8"><title>Probe</title></head><body><h1>Plugin probe</h1><script src="app.js"></script></body></html>',
    "app.js": 'window.probeAssetLoaded = true;',
    "frame.html": '<!doctype html><html><body>Disallowed child frame<script src="frame.js"></script></body></html>',
    "frame.js": 'parent.postMessage("unexpected-frame-script", "*");',
  };
  return { manifest, files, publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), signature: crypto.sign(null, Buffer.from(canonical({ manifest, files })), privateKey).toString("base64") };
}

app.whenReady().then(async () => {
  server = http.createServer((_req, res) => { requests++; res.end("LOCAL-CANARY"); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const canary = `http://127.0.0.1:${server.address().port}/private`;
  const privateFile = path.join(root, "private-canary.txt"); fs.writeFileSync(privateFile, "PRIVATE-CANARY");
  const manager = new PluginManager(root);
  manager.install(fixture("probe.first", ["models.read", "storage.read", "storage.write"]));
  manager.install(fixture("probe.second", ["storage.read", "storage.write"]));
  const fakeCore = { models: { aliases: () => [{ alias: "synthetic", label: "Synthetic model", status: "ready", path: "/private/model.gguf", credential: "never-return" }] }, gateway: { port: server.address().port } };
  host = new PluginHost({ electron, manager, core: fakeCore });
  await host.open("probe.first");
  const first = host.windows.get("probe.first").window;
  assert.equal(await first.webContents.executeJavaScript("window.probeAssetLoaded"), true, "signed JS asset did not execute");
  const result = await first.webContents.executeJavaScript(`(async () => {
    const blocked = async fn => { try { await fn(); return false; } catch { return true; } };
    const models = await window.kai.call('models.list');
    await window.kai.call('storage.set', { key: 'private', value: 'FIRST-PLUGIN-ONLY' });
    return {
      models, stored: await window.kai.call('storage.get', { key: 'private' }),
      nodeAbsent: typeof require === 'undefined' && typeof process === 'undefined',
      walletDenied: await blocked(() => window.kai.call('wallet.reveal', {})),
      undeclaredDenied: await blocked(() => window.kai.call('inference.local', {model: 'synthetic', prompt: 'no'})),
      networkDenied: await blocked(() => fetch(${JSON.stringify(canary)})),
      fileDenied: await blocked(() => fetch(${JSON.stringify(require("node:url").pathToFileURL(privateFile).href)})),
      popupDenied: window.open(${JSON.stringify(canary)}) === null,
    };
  })()`);
  assert.deepEqual(result.models, [{ alias: "synthetic", label: "Synthetic model", status: "ready" }]);
  assert.equal(result.stored, "FIRST-PLUGIN-ONLY");
  for (const key of ["nodeAbsent", "walletDenied", "undeclaredDenied", "networkDenied", "fileDenied", "popupDenied"]) assert.equal(result[key], true, key);
  await first.webContents.executeJavaScript(`(() => { window.unexpectedFrame = false; window.addEventListener('message', e => { if (e.data === 'unexpected-frame-script') window.unexpectedFrame = true; }); const f = document.createElement('iframe'); f.src = 'kai-plugin://probe.first/frame.html'; document.body.append(f); })()`);
  // Observe the blocked frame/navigation after Chromium processes the events.
  await first.webContents.executeJavaScript(`new Promise(resolve => setTimeout(resolve, 150))`);
  assert.equal(await first.webContents.executeJavaScript("window.unexpectedFrame"), false);
  const initialURL = first.webContents.getURL();
  await first.webContents.executeJavaScript(`location.href = ${JSON.stringify(canary)}; void 0;`);
  await first.webContents.executeJavaScript(`new Promise(resolve => setTimeout(resolve, 150))`);
  assert.equal(first.webContents.getURL(), initialURL, "plugin navigated away from its reviewed entry");
  assert.equal(requests, 0, "plugin reached the local HTTP canary");
  await host.open("probe.second");
  const second = host.windows.get("probe.second").window;
  assert.equal(await second.webContents.executeJavaScript("window.kai.call('storage.get', {key:'private'})"), null, "plugin read another plugin's storage");
  assert.equal(await second.webContents.executeJavaScript("window.kai.call('models.list').then(() => false, () => true)"), true, "undeclared model-list permission worked");
  manager.change("probe.second", "disable");
  assert.equal(await second.webContents.executeJavaScript("window.kai.call('storage.get', {key:'private'}).then(() => false, () => true)"), true, "disabled plugin broker remained usable");
  finish();
}).catch(finish);
