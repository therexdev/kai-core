"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { EventEmitter } = require("node:events");
const { CreditService } = require("../../electron/credit-service"), { CreditProvider } = require("../../electron/credit-provider"), { registerTestPaymentIPC } = require("../../electron/koin-test-ipc");
function fixture(t, run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-app-payment-"));
  t.mock.method(global, "setInterval", () => ({ unref() {} })); t.mock.method(CreditProvider.prototype, "dispose", async () => {});
  t.mock.method(CreditService.prototype, "run", run);
  const contents = url => { const wc = new EventEmitter(); wc.mainFrame = { url }; wc.isDestroyed = () => false; wc.sent = []; wc.send = (...args) => wc.sent.push(args); return wc; };
  const window = new EventEmitter(); window.visible = true; window.isDestroyed = () => false; window.isVisible = () => window.visible; window.isMinimized = () => false; window.webContents = contents("http://127.0.0.1:9000/");
  const assistant = contents("kai-plugin://kai.assistant/index.html"), tools = contents("kai-plugin://kai.tools/index.html");
  const registration = registerTestPaymentIPC({ dataDir, core: { gateway: { network: { status: () => ({ privacyMode: "network" }), trackShadowRequest: () => () => {} } } }, isTest: false, dialog: {}, origin: "http://127.0.0.1:9000", getMainWindow: () => window, ipcMain: { handle() {} } });
  t.after(async () => { await registration.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { registration, window, assistant, tools };
}
test("plugin progress targets its isolated renderer and approved work survives Core tray", async t => {
  let finish, activeSignal;
  const f = fixture(t, function (_action, _input, signal) { activeSignal = signal; this.progress("working"); return new Promise(resolve => { finish = resolve; }); });
  const life = new AbortController(); let appVisible = true;
  const pending = f.registration.runForPlugin("chat-completion", {}, { window: f.window, webContents: f.assistant, signal: life.signal, isVisible: () => appVisible });
  assert.deepEqual(f.assistant.sent, [["koin:chat-progress", { text: "working" }]]); assert.deepEqual(f.window.webContents.sent, []); assert.deepEqual(f.tools.sent, []);
  appVisible = false; f.window.visible = false; f.window.emit("hide"); f.window.emit("minimize"); assert.equal(activeSignal.aborted, false);
  finish({ answer: "complete" }); assert.deepEqual(await pending, { answer: "complete" });
  assert.equal(f.assistant.listenerCount("did-start-navigation"), 0); assert.equal(f.window.listenerCount("closed"), 0);
});
test("one app cannot stop another app sharing the Core native window", async t => {
  let activeSignal;
  const f = fixture(t, (_action, _input, signal) => { activeSignal = signal; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("aborted")), { once: true })); });
  const pending = f.registration.runForPlugin("chat-completion", {}, { window: f.window, webContents: f.assistant });
  await f.registration.runForPlugin("stop", undefined, { window: f.window, webContents: f.tools }); assert.equal(activeSignal.aborted, false);
  const rejected = assert.rejects(pending, /stopped/);
  await f.registration.runForPlugin("stop", undefined, { window: f.window, webContents: f.assistant }); await rejected; assert.equal(activeSignal.aborted, true);
});
test("hidden app cannot start fresh credit spending, but existing run continuation remains possible", async t => {
  const f = fixture(t, async action => ({ action }));
  const options = { window: f.window, webContents: f.assistant, isVisible: () => false };
  await assert.rejects(f.registration.runForPlugin("run-open", {}, options), /Return to this app/);
  await assert.rejects(f.registration.runForPlugin("chat-completion", {}, options), /Return to this app/);
  f.window.visible = false;
  assert.deepEqual(await f.registration.runForPlugin("run-chat", {}, options), { action: "run-chat" });
  assert.deepEqual(await f.registration.runForPlugin("chat-ack", {}, options), { action: "chat-ack" });
  await assert.rejects(f.registration.runForPlugin("purchase-approve", {}, options), /denied/);
  await assert.rejects(f.registration.runForPlugin("chat-completion", {}, { window: f.window, webContents: f.window.webContents }), /denied/);
});
test("renderer destruction and plugin lifetime revoke in-flight network work", async t => {
  const f = fixture(t, (_action, _input, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("aborted")), { once: true })));
  let pending = f.registration.runForPlugin("chat-completion", {}, { window: f.window, webContents: f.assistant });
  let rejected = assert.rejects(pending, /stopped/); f.assistant.emit("destroyed"); await rejected;
  const life = new AbortController(); pending = f.registration.runForPlugin("chat-completion", {}, { window: f.window, webContents: f.assistant, signal: life.signal });
  rejected = assert.rejects(pending, /stopped/); life.abort(); await rejected;
});
