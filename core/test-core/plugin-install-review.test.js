"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");
const { createPluginInstallReview } = require("../../electron/core-plugin-install");

const tick = () => new Promise(resolve => setImmediate(resolve));
const verified = () => ({ manifest: { id: "example.notes", name: "Notes <script>bad()</script>", version: "2.0.0",
  description: "Write notes", permissions: ["models.read", "storage.write"] }, fingerprint: "a".repeat(64), package: { secretPayload: "not sent to the renderer" } });
function fixture(t, { delayed = false, loadFailure = false, workArea = { width: 1920, height: 1080 } } = {}) {
  const handlers = new Map(), windows = [], sessions = [];
  const state = { closing: false, trusted: true };
  class Contents extends EventEmitter {
    constructor() { super(); this.mainFrame = { url: "" }; this.destroyed = false; }
    setWindowOpenHandler(callback) { this.popup = callback; }
    isDestroyed() { return this.destroyed; }
  }
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new Contents(); this.destroyed = false; this.visible = options.show; windows.push(this); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    show() { this.visible = true; this.emit("show"); }
    focus() { this.focused = true; }
    setMenu(menu) { this.menu = menu; }
    async loadFile(file) {
      this.file = file; this.webContents.mainFrame.url = pathToFileURL(file).href;
      this.webContents.emit("did-start-navigation", {}, this.webContents.mainFrame.url, false, true);
      if (loadFailure) throw Error("Synthetic failed load");
      if (delayed) await new Promise((resolve, reject) => { this.finishLoad = resolve; this.failLoad = reject; });
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true; this.visible = false; this.webContents.destroyed = true;
      this.failLoad?.(Error("Window destroyed"));
      this.webContents.emit("destroyed"); this.emit("closed");
    }
  }
  const parent = new EventEmitter(); parent.webContents = new Contents(); parent.destroyed = false; parent.visible = true;
  parent.isDestroyed = () => parent.destroyed; parent.isVisible = () => parent.visible;
  parent.getBounds = () => ({ x: 0, y: 0, width: 1200, height: 800 });
  parent.hide = () => { parent.visible = false; parent.emit("hide"); };
  const electron = { BrowserWindow: Window, ipcMain: { handle(channel, fn) { assert.equal(handlers.has(channel), false); handlers.set(channel, fn); }, removeHandler(channel) { handlers.delete(channel); } },
    screen: { getDisplayMatching: () => ({ workArea }) }, session: { fromPartition(partition, options) {
      const item = { partition, options, clearCount: 0,
        setPermissionRequestHandler(fn) { this.permission = fn; }, setPermissionCheckHandler(fn) { this.check = fn; },
        async clearStorageData() { this.clearCount++; }, webRequest: { onBeforeRequest(fn) { item.filter = fn; } } };
      sessions.push(item); return item;
    } } };
  const reviewer = createPluginInstallReview({ electron, getWindow: () => parent, isClosing: () => state.closing, isTrustedParent: value => value === parent && state.trusted });
  t.after(() => reviewer.dispose());
  const event = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const call = (channel, window, ...args) => handlers.get("kai-plugin-install:" + channel)(event(window), ...args);
  return { reviewer, handlers, windows, sessions, state, parent, event, call };
}

test("review exposes an immutable metadata snapshot and approves only after explicit reading", async t => {
  const f = fixture(t), pkg = verified(); const pending = f.reviewer.review(pkg, "1.0.0", true); await tick();
  const window = f.windows[0];
  assert.throws(() => f.call("decide", window, "approve"), /Open the plugin review/);
  const details = f.call("read", window);
  assert.deepEqual(details, { ...pkg.manifest, fingerprint: pkg.fingerprint, runtime: undefined, installedVersion: "1.0.0", official: true });
  assert.equal(Object.hasOwn(details, "package"), false); assert.equal(Object.isFrozen(details), true); assert.equal(Object.isFrozen(details.permissions), true);
  pkg.manifest.name = "Changed later"; pkg.manifest.permissions.push("inference.local");
  assert.equal(details.name, "Notes <script>bad()</script>"); assert.deepEqual(details.permissions, ["models.read", "storage.write"]);
  assert.equal(window.options.title, "Update plugin · KAI Core Beta");
  assert.equal(f.call("decide", window, "approve"), true); assert.equal(await pending, true);
  assert.equal(window.destroyed, true); assert.equal(f.sessions[0].clearCount, 1);
  assert.throws(() => f.call("decide", window, "approve"), /access denied/);
  for (const target of [f.parent, f.parent.webContents, window, window.webContents]) assert.equal(target.eventNames().length, 0, "completed review removes lifecycle listeners");
});

test("Core, plugin renderers, subframes and alternate files cannot read or approve a review", async t => {
  const f = fixture(t); const pending = f.reviewer.review(verified()); await tick(); const window = f.windows[0];
  for (const event of [
    { sender: f.parent.webContents, senderFrame: f.parent.webContents.mainFrame },
    { sender: new EventEmitter(), senderFrame: window.webContents.mainFrame },
    { sender: window.webContents, senderFrame: { url: window.webContents.mainFrame.url } },
  ]) {
    assert.throws(() => f.handlers.get("kai-plugin-install:read")(event), /access denied/);
    assert.throws(() => f.handlers.get("kai-plugin-install:decide")(event, "approve"), /access denied/);
  }
  const entry = window.webContents.mainFrame.url;
  for (const url of [entry + "#changed", entry + "?changed", entry.replace("plugin-install.html", "index.html"), "kai-plugin://example.notes/index.html", "https://example.test/"]) {
    window.webContents.mainFrame.url = url;
    assert.throws(() => f.call("read", window), /access denied/);
    assert.throws(() => f.call("decide", window, "approve"), /access denied/);
  }
  window.webContents.mainFrame.url = entry; f.call("decide", window, "cancel"); assert.equal(await pending, false);
});

test("invalid decisions and hidden or invalid owners cannot grant approval", async t => {
  const f = fixture(t); const pending = f.reviewer.review(verified()); await tick(); const window = f.windows[0]; f.call("read", window);
  for (const choice of [true, 1, { approve: true }, "Install", null, undefined]) assert.throws(() => f.call("decide", window, choice), /Invalid plugin review decision/);
  window.visible = false; assert.throws(() => f.call("decide", window, "approve"), /Open the plugin review/); window.visible = true;
  f.parent.visible = false; assert.throws(() => f.call("decide", window, "approve"), /Open the plugin review/); f.parent.visible = true;
  f.state.trusted = false; assert.throws(() => f.call("decide", window, "approve"), /access denied/); f.state.trusted = true;
  f.state.closing = true; assert.throws(() => f.call("decide", window, "approve"), /access denied/); f.state.closing = false;
  f.call("decide", window, "cancel"); assert.equal(await pending, false);
});

test("concurrent reviews are rejected and old decisions cannot approve the next package", async t => {
  const f = fixture(t); const first = f.reviewer.review(verified()); await tick(); const old = f.windows[0]; f.call("read", old);
  await assert.rejects(f.reviewer.review(verified()), /Finish the current plugin review/);
  f.call("decide", old, "cancel"); assert.equal(await first, false);
  const pkg = verified(); pkg.manifest.id = "example.other";
  const next = f.reviewer.review(pkg); await tick(); const current = f.windows[1];
  assert.throws(() => f.call("decide", old, "approve"), /access denied/);
  assert.equal(f.call("read", current).id, "example.other");
  f.call("decide", current, "approve"); assert.equal(await next, true);
  assert.notEqual(f.sessions[0].partition, f.sessions[1].partition);
});

test("parent disappearance, reload and renderer loss cancel pending approval", async t => {
  const actions = {
    hide: f => f.parent.hide(), closed: f => { f.parent.destroyed = true; f.parent.emit("closed"); },
    reload: f => f.parent.webContents.emit("did-start-navigation", {}, "http://127.0.0.1/", false, true),
    crash: f => f.parent.webContents.emit("render-process-gone"),
  };
  for (const [name, action] of Object.entries(actions)) await t.test(name, async t => {
    const f = fixture(t); const pending = f.reviewer.review(verified()); await tick(); const window = f.windows[0]; f.call("read", window);
    action(f); assert.equal(await pending, false); assert.equal(window.destroyed, true);
    assert.throws(() => f.call("decide", window, "approve"), /access denied/);
  });
});

test("dialog close, crash, Escape, navigation and reload cancel pending approval", async t => {
  const preventable = callback => { let prevented = false; callback({ preventDefault() { prevented = true; } }); assert.equal(prevented, true); };
  const actions = {
    close: window => window.destroy(), crash: window => window.webContents.emit("render-process-gone"),
    escape: window => preventable(event => window.webContents.emit("before-input-event", event, { type: "keyDown", key: "Escape" })),
    navigate: window => preventable(event => window.webContents.emit("will-navigate", event, "https://example.test")),
    redirect: window => preventable(event => window.webContents.emit("will-redirect", event, "https://example.test")),
    reload: window => window.webContents.emit("did-start-navigation", {}, window.webContents.mainFrame.url, false, true),
  };
  for (const [name, action] of Object.entries(actions)) await t.test(name, async t => {
    const f = fixture(t); const pending = f.reviewer.review(verified()); await tick(); const window = f.windows[0]; f.call("read", window);
    action(window); assert.equal(await pending, false); assert.equal(window.destroyed, true);
  });
});

test("subframe and in-place parent navigation do not end an unchanged review", async t => {
  const f = fixture(t); const pending = f.reviewer.review(verified()); await tick(); const window = f.windows[0];
  f.parent.webContents.emit("did-start-navigation", {}, "http://127.0.0.1/#anchor", true, true);
  f.parent.webContents.emit("did-start-navigation", {}, "http://127.0.0.1/frame", false, false);
  assert.equal(window.destroyed, false); f.call("read", window); f.call("decide", window, "approve"); assert.equal(await pending, true);
});

test("shutdown cancels the review, unregisters handlers, and disallows future reviews", async t => {
  const f = fixture(t); const pending = f.reviewer.review(verified()); await tick();
  f.state.closing = true; f.reviewer.dispose();
  assert.equal(await pending, false); assert.equal(f.windows[0].destroyed, true); assert.equal(f.handlers.size, 0);
  assert.equal(await f.reviewer.review(verified()), false); f.reviewer.dispose(); assert.equal(f.sessions[0].clearCount, 1);
});

test("failed loads and closing during a slow load leave no actionable window", async t => {
  await t.test("failed load", async t => {
    const f = fixture(t, { loadFailure: true }); assert.equal(await f.reviewer.review(verified()), false);
    assert.equal(f.windows[0].destroyed, true); assert.equal(f.windows[0].focused, undefined);
  });
  await t.test("parent hides before load", async t => {
    const f = fixture(t, { delayed: true }); const pending = f.reviewer.review(verified()); await tick(); const window = f.windows[0];
    f.call("read", window); assert.throws(() => f.call("decide", window, "approve"), /Open the plugin review/);
    f.parent.hide(); assert.equal(await pending, false); assert.equal(window.focused, undefined);
  });
});

test("closing, absent trust and destroyed owner never open an approval", async t => {
  const f = fixture(t);
  f.state.closing = true; assert.equal(await f.reviewer.review(verified()), false); f.state.closing = false;
  f.state.trusted = false; assert.equal(await f.reviewer.review(verified()), false); f.state.trusted = true;
  f.parent.destroyed = true; assert.equal(await f.reviewer.review(verified()), false);
  assert.equal(f.windows.length, 0); assert.equal(f.sessions.length, 0);
});

test("review session denies browser permissions, remote requests, arbitrary files and popups", async t => {
  const f = fixture(t, { workArea: { width: 520, height: 580 } }); const pending = f.reviewer.review(verified()); await tick();
  const window = f.windows[0], session = f.sessions[0], prefs = window.options.webPreferences;
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.session, session); assert.equal(window.options.parent, f.parent); assert.equal(window.options.modal, true);
  assert.equal(window.options.width, 520); assert.equal(window.options.height, 580);
  assert.equal(session.partition.startsWith("persist:"), false); assert.equal(session.options.cache, false);
  session.permission(window.webContents, "media", granted => assert.equal(granted, false)); assert.equal(session.check(window.webContents, "clipboard-read"), false);
  const entry = window.webContents.mainFrame.url;
  for (const url of [entry, entry.replace("plugin-install.html", "plugin-install.css"), entry.replace("plugin-install.html", "plugin-install.js"), entry.replace("plugin-install.html", "presentation.js"), entry.replace("plugin-install.html", "assets/brand-mark.svg")]) session.filter({ url }, result => assert.deepEqual(result, { cancel: false }));
  for (const url of ["https://example.test/", "http://127.0.0.1/private", "file:///etc/passwd", entry + "?other", entry.replace("plugin-install.html", "core.js"), "data:text/html,bad", "kai-plugin://example.notes/index.html"]) session.filter({ url }, result => assert.deepEqual(result, { cancel: true }));
  assert.deepEqual(window.webContents.popup({ url: "https://example.test/" }), { action: "deny" });
  let prevented = false; window.webContents.emit("will-attach-webview", { preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  f.call("decide", window, "cancel"); assert.equal(await pending, false);
});
