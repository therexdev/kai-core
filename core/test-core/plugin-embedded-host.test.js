"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { PluginHost } = require("../../electron/core-plugin-host");
function fixture(t, { delayed = false } = {}) {
  class Contents extends EventEmitter {
    constructor() { super(); this.mainFrame = { url: "" }; this.destroyed = false; this.sent = []; }
    isDestroyed() { return this.destroyed; }
    setWebRTCIPHandlingPolicy(value) { this.rtc = value; }
    setWindowOpenHandler(callback) { this.popup = callback; }
    getZoomFactor() { return this.zoom || 1; }
    focus() {}
    send(...message) { this.sent.push(message); }
    async loadURL(url) { this.mainFrame.url = url; if (delayed) await new Promise(resolve => { this.finish = resolve; }); }
    close() { this.destroyed = true; this.emit("destroyed"); }
  }
  class View {
    constructor(options) { this.options = options; this.webContents = new Contents(); }
    setBackgroundColor() {} setBounds(value) { this.bounds = value; }
    setVisible(value) { this.visible = value; } getVisible() { return this.visible; }
  }
  const window = new EventEmitter(); window.webContents = new Contents(); window.isDestroyed = () => false; window.isVisible = () => window.visible !== false;
  window.isMinimized = () => false; window.getContentSize = () => [1200, 800]; window.show = () => { window.visible = true; }; window.focus = () => {};
  window.hide = () => { window.visible = false; window.emit("hide"); };
  const views = new Set(); window.contentView = { addChildView: v => views.add(v), removeChildView: v => views.delete(v) };
  const sessions = [], calls = [], detached = [], activations = [];
  const electron = { WebContentsView: View, ipcMain: { handle() {} }, session: { fromPartition() {
    const session = new EventEmitter(); session.setPermissionRequestHandler = fn => { session.permission = fn; }; session.setPermissionCheckHandler = fn => { session.check = fn; };
    session.webRequest = { onBeforeRequest: fn => { session.filter = fn; } }; session.protocol = { handle() {}, unhandle() {} }; session.clearStorageData = async () => {}; sessions.push(session); return session;
  } } };
  const installed = { "example.one": { enabled: true }, "example.two": { enabled: true } };
  const manager = { state: { installed }, load(id) { if (!installed[id]?.enabled) throw Error("Plugin disabled"); return { manifest: { id, name: id, entry: "index.html", permissions: ["models.read", "inference.local"] }, package: { files: { "index.html": "<p>App</p>" } }, fingerprint: "fixture" }; } };
  const features = { close: async (id, reason) => { calls.push([id, reason]); }, detachWindow: async id => { detached.push(id); } };
  const host = new PluginHost({ electron, manager, core: { models: { aliases: () => [] } }, features, getContainerWindow: () => window, onActivate: value => activations.push(value) });
  t.after(() => host.closeAll());
  return { host, window, views, sessions, installed, calls, detached, activations };
}
const bounds = { x: 244, y: 96, width: 956, height: 704 };
const event = record => ({ sender: record.webContents, senderFrame: record.webContents.mainFrame });
test("embedded apps retain renderers and work across selection, Core pages and tray", async t => {
  const f = fixture(t); await f.host.open("example.one", bounds); const one = f.host.windows.get("example.one");
  assert.equal(one.window, f.window); assert.equal(one.view.visible, true); assert.equal(one.view.options.webPreferences.backgroundThrottling, false);
  let finish, stopped = false; f.host.runLocal = (_input, signal) => new Promise(resolve => { finish = resolve; signal.addEventListener("abort", () => { stopped = true; }); });
  const pending = f.host.call(event(one), "inference.local", {});
  await f.host.open("example.two", bounds); assert.equal(one.view.visible, false); assert.equal(one.webContents.isDestroyed(), false);
  f.host.hide(); f.window.hide(); assert.equal(stopped, false); assert.equal(one.controller.signal.aborted, false); assert.equal(f.detached.length, 0);
  finish({ text: "finished in tray" }); assert.deepEqual(await pending, { text: "finished in tray" });
  await f.host.open("example.one", bounds); assert.equal(f.host.windows.get("example.one"), one); assert.equal(one.view.visible, true);
});
test("embedded sender validation excludes Core, other app and subframes", async t => {
  const f = fixture(t); await f.host.open("example.one", bounds); const one = f.host.windows.get("example.one"); await f.host.open("example.two", bounds); const two = f.host.windows.get("example.two");
  assert.equal(one.view.options.webPreferences.sandbox, true); assert.equal(one.view.options.webPreferences.nodeIntegration, false); assert.equal(one.webContents.rtc, "disable_non_proxied_udp");
  assert.deepEqual(await f.host.call(event(one), "models.list"), []);
  await assert.rejects(f.host.call({ sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame }, "models.list"), /caller denied/);
  await assert.rejects(f.host.call({ sender: one.webContents, senderFrame: two.webContents.mainFrame }, "models.list"), /caller denied/);
  await assert.rejects(f.host.call({ sender: one.webContents, senderFrame: { url: one.entry } }, "models.list"), /caller denied/);
  f.sessions[0].filter({ url: "http://127.0.0.1/private" }, value => assert.equal(value.cancel, true));
});
test("disable destroys only its app and revokes calls without closing Core or peers", async t => {
  const f = fixture(t); await f.host.open("example.one", bounds); await f.host.open("example.two", bounds); const one = f.host.windows.get("example.one"), two = f.host.windows.get("example.two");
  await f.host.close("example.one", "disable");
  assert.equal(one.controller.signal.aborted, true); assert.equal(one.webContents.isDestroyed(), true); assert.equal(two.webContents.isDestroyed(), false); assert.equal(two.view.visible, true);
  assert.equal(f.views.size, 1); assert.deepEqual(f.calls, [["example.one", { reason: "disable" }]]); assert.deepEqual(f.detached, []);
  await assert.rejects(f.host.call(event(one), "models.list"), /caller denied/);
  f.installed["example.two"].enabled = false; await assert.rejects(f.host.open("example.two", bounds), /disabled/);
});
test("slow app loads cannot steal navigation after the user leaves", async t => {
  const f = fixture(t, { delayed: true }); const first = f.host.open("example.one", bounds); await new Promise(resolve => setImmediate(resolve)); const one = f.host.windows.get("example.one");
  f.host.hide(); one.webContents.finish(); assert.deepEqual(await first, { opened: false }); assert.equal(one.view.visible, false);
  const second = f.host.open("example.two", bounds); await new Promise(resolve => setImmediate(resolve)); const two = f.host.windows.get("example.two");
  await f.host.open("example.one", bounds); two.webContents.finish(); await second; assert.equal(one.view.visible, true); assert.equal(two.view.visible, false);
});
test("bounds stay within Core content, account for zoom and reject stale or malformed geometry", async t => {
  const f = fixture(t); await f.host.open("example.one", bounds); const one = f.host.windows.get("example.one");
  f.window.webContents.zoom = 1.5; f.window.emit("resize"); assert.deepEqual(one.view.bounds, { x: 366, y: 144, width: 834, height: 656 });
  assert.deepEqual(f.host.setBounds({ x: 0, y: 0, width: 5, height: 5 }, "example.two"), { updated: false });
  assert.throws(() => f.host.setBounds({ ...bounds, x: NaN }), /bounds/); assert.throws(() => f.host.setBounds({ ...bounds, width: -1 }), /bounds/);
  f.window.webContents.emit("did-start-navigation", {}, "http://127.0.0.1/", false, true); assert.equal(one.view.visible, false); assert.equal(one.controller.signal.aborted, false);
});
