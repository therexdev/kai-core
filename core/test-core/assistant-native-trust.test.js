"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { create, trusted, ACTIONS, installMascotMediaConsent } = require("../../electron/plugin-services/assistant-native");
test("Assistant native disposal stays lazy when companion features were never opened", async () => {
  const native = create({ core: { gateway: { port: 39393, staticAssets: new Map() } } });
  await native.dispose(); await native.dispose();
  await assert.rejects(native.call({ action: "providers:status", args: [] }), /closing/);
});
test("closing the original mascot still destroys its window when guarded preference saving fails", async t => {
  const { EventEmitter } = require("node:events"), ipcMain = new EventEmitter(), screen = new EventEmitter();
  const handlers = new Map(); ipcMain.handle = (key, fn) => handlers.set(key, fn); ipcMain.removeHandler = key => handlers.delete(key);
  screen.getCursorScreenPoint = () => ({ x: 500, y: 500 }); screen.getDisplayNearestPoint = () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } });
  class Window extends EventEmitter {
    constructor(options) { super(); this.bounds = options; this.webContents = new EventEmitter(); this.webContents.send = () => {}; this.webContents.setWindowOpenHandler = () => {}; }
    isDestroyed() { return !!this.destroyed; } isVisible() { return false; } getBounds() { return this.bounds; } setBounds(bounds) { this.bounds = bounds; }
    setIgnoreMouseEvents() {} setShape() {} async loadURL() {} show() {} destroy() { this.destroyed = true; this.emit("closed"); }
  }
  let fail = false;
  const controller = require("../../electron/mascot").createMascotController({ BrowserWindow: Window, screen, ipcMain, shell: {}, origin: "http://localhost:39393", prefs: { get: () => undefined, set: (_key, position) => { assert.equal(typeof position.perched, "boolean"); if (fail) throw Error("Preferences changed elsewhere"); } }, getMainWindow: () => null });
  t.after(() => controller.dispose()); await controller.launch(); const window = controller.getWindow(); fail = true;
  assert.throws(() => controller.dispose(), /changed elsewhere/); assert.equal(window.isDestroyed(), true); assert.equal(handlers.size, 0); assert.equal(screen.listenerCount("display-removed"), 0);
});
test("Assistant native trust requires the exact window, main frame and signed entry", () => {
  const entry = "kai-plugin://kai.assistant/index.html", frame = { url: entry }, contents = { mainFrame: frame }, window = { isDestroyed: () => false, webContents: contents };
  assert.equal(trusted({ sender: contents, senderFrame: frame }, window, entry), true);
  assert.equal(trusted({ sender: {}, senderFrame: frame }, window, entry), false);
  assert.equal(trusted({ sender: contents, senderFrame: { url: entry } }, window, entry), false);
  frame.url = "kai-plugin://kai.assistant/other.html";
  assert.equal(trusted({ sender: contents, senderFrame: frame }, window, entry), false);
  frame.url = entry; window.isDestroyed = () => true;
  assert.equal(trusted({ sender: contents, senderFrame: frame }, window, entry), false);
});
test("companion media checks require a matching native grant and stop accepting grants after closure", async () => {
  let check, request, active = true, approve = false, dialogs = 0;
  const origin = "http://127.0.0.1:39393", wc = { mainFrame: { url: origin + "/mascot.html" }, session: { setPermissionCheckHandler: fn => { check = fn; }, setPermissionRequestHandler: fn => { request = fn; } } }, window = { webContents: wc, isDestroyed: () => false };
  installMascotMediaConsent({ window, origin, isActive: () => active, dialog: { showMessageBox: async () => { dialogs++; return { response: approve ? 1 : 0 }; } } });
  const ask = (types, details = {}) => new Promise(resolve => request(wc, "media", resolve, { mediaTypes: types, requestingUrl: origin + "/mascot.html", isMainFrame: true, ...details }));
  const details = type => ({ mediaType: type, requestingUrl: origin + "/mascot.html", isMainFrame: true });
  assert.equal(check(wc, "media", origin, details("audio")), false);
  assert.equal(await ask(["audio"]), false); assert.equal(dialogs, 1);
  approve = true; assert.equal(await ask(["audio"]), true);
  assert.equal(check(wc, "media", origin, details("audio")), true);
  assert.equal(check(wc, "media", origin + "/", details("audio")), true);
  assert.equal(check(wc, "media", origin, { ...details("audio"), isMainFrame: false }), false);
  assert.equal(check(wc, "media", origin, details("video")), false);
  assert.equal(check(wc, "media", "https://example.com", details("audio")), false);
  assert.equal(await ask(["video"], { isMainFrame: false }), false);
  assert.equal(await ask(["display"]), false);
  active = false; assert.equal(check(wc, "media", origin, details("audio")), false); assert.equal(await ask(["audio"]), false);
});
test("Assistant renderer native calls cannot invoke wallet, arbitrary shell or raw computer IPC", () => {
  for (const action of ["wallet:send", "shell:exec", "mascot:computer-call", "mascot:eyes-capture", "node:start", "providers:reveal"]) assert.equal(ACTIONS.has(action), false, action);
  for (const action of ["providers:chat", "providers:save", "companion:tool", "companion:session", "mascot:launch"]) assert.equal(ACTIONS.has(action), true, action);
});
