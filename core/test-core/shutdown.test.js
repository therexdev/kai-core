"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { EventEmitter } = require("node:events");
const { CreditService } = require("../../electron/credit-service"), { CreditProvider } = require("../../electron/credit-provider"), { registerTestPaymentIPC } = require("../../electron/koin-test-ipc");
test("payment disposal waits for in-flight handlers and provider stop before profile handoff", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-shutdown-")); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const win = new EventEmitter(); win.isDestroyed = () => false; win.isVisible = () => true; win.isMinimized = () => false;
  win.webContents = new EventEmitter(); win.webContents.mainFrame = { url: "http://127.0.0.1:9000/" };
  t.mock.method(global, "setInterval", () => ({ unref() {} }));
  let finishRead, finishStop, handler;
  t.mock.method(CreditService.prototype, "walletInfo", () => new Promise(resolve => { finishRead = resolve; }));
  t.mock.method(CreditProvider.prototype, "dispose", () => new Promise(resolve => { finishStop = resolve; }));
  const registration = registerTestPaymentIPC({ dataDir, core: { gateway: { network: {} } }, isTest: false, dialog: {}, origin: "http://127.0.0.1:9000", getMainWindow: () => win, ipcMain: { handle: (_name, fn) => { handler = fn; } } });
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const read = handler(event, "wallet-info");
  let closed = false; const disposal = registration.dispose().then(() => { closed = true; });
  await assert.rejects(handler(event, "wallet-info"), /closing/);
  finishStop(); await Promise.resolve(); assert.equal(closed, false);
  finishRead({ state: "ready" }); await read; await disposal; assert.equal(closed, true);
});
