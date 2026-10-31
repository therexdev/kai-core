"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { EventEmitter } = require("node:events"), { pathToFileURL } = require("node:url");
const { createCoreDialogs } = require("../../electron/core-dialogs");
const tick = () => new Promise(resolve => setImmediate(resolve));
const review = extra => ({ type: "question", title: "Review action", message: "Continue?", detail: "Exact reviewed details", buttons: ["Cancel", "Continue"], cancelId: 0, defaultId: 0, ...extra });
function fixture(t, { delayed = false, loadFailure = false, startup = false, ready = true } = {}) {
  const handlers = new Map(), windows = [], sessions = []; let readyNow;
  const state = { closing: false }, whenReady = ready ? Promise.resolve() : new Promise(resolve => { readyNow = resolve; });
  class Contents extends EventEmitter {
    constructor() { super(); this.mainFrame = { url: "kai://parent" }; this.destroyed = false; }
    isDestroyed() { return this.destroyed; }
    setWindowOpenHandler(fn) { this.popup = fn; }
  }
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.visible = !!options.show; this.destroyed = false; this.webContents = new Contents(); windows.push(this); }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; }
    setMenu(value) { this.menu = value; } show() { this.visible = true; } focus() { this.focused = true; }
    async loadFile(file) { this.file = file; this.webContents.mainFrame.url = pathToFileURL(file).href; this.webContents.emit("did-start-navigation", {}, this.webContents.mainFrame.url, false, true); if (loadFailure) throw Error("Synthetic failed load"); if (delayed) await new Promise((resolve, reject) => { this.finishLoad = resolve; this.failLoad = reject; }); }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; this.webContents.destroyed = true; this.failLoad?.(Error("Destroyed")); this.webContents.emit("destroyed"); this.emit("closed"); }
  }
  const parent = new EventEmitter(); parent.webContents = new Contents(); parent.visible = true; parent.destroyed = false;
  parent.isDestroyed = () => parent.destroyed; parent.isVisible = () => parent.visible; parent.getBounds = () => ({ x: 0, y: 0, width: 1200, height: 800 });
  parent.hide = () => { parent.visible = false; parent.emit("hide"); };
  const electron = { BrowserWindow: Window, app: { whenReady: () => whenReady },
    ipcMain: { handle(channel, fn) { assert.equal(handlers.has(channel), false); handlers.set(channel, fn); }, removeHandler(channel) { handlers.delete(channel); } },
    screen: { getDisplayMatching: () => ({ workArea: { width: 520, height: 580 } }), getPrimaryDisplay: () => ({ workArea: { width: 1024, height: 768 } }) },
    session: { fromPartition(partition, options) { const item = new EventEmitter(); Object.assign(item, { partition, options, clearCount: 0, setPermissionRequestHandler(fn) { this.permission = fn; }, setPermissionCheckHandler(fn) { this.check = fn; }, async clearStorageData() { this.clearCount++; }, webRequest: { onBeforeRequest(fn) { item.filter = fn; } } }); sessions.push(item); return item; } } };
  const dialogs = createCoreDialogs({ electron, getWindow: () => startup ? null : parent, isClosing: () => state.closing }); t.after(() => dialogs.dispose());
  const event = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const call = (channel, window, ...args) => handlers.get("kai-dialog:" + channel)(event(window), ...args);
  return { dialogs, handlers, windows, sessions, parent, state, event, call, readyNow };
}

test("dialog preserves exact text, button indices and checkbox in a private snapshot", async t => {
  const f = fixture(t), options = review({ title: "<img onerror=bad()> кошелёк", checkboxLabel: "Remember this", checkboxChecked: true });
  const pending = f.dialogs.showMessageBox(f.parent, options); options.buttons[1] = "Changed"; options.detail = "Changed"; await tick(); const w = f.windows[0];
  assert.throws(() => f.call("decide", w, { response: 1, checkboxChecked: false }), /Open the dialog/);
  const data = f.call("read", w); assert.equal(Object.isFrozen(data), true); assert.equal(Object.isFrozen(data.buttons), true); assert.equal(data.detail, "Exact reviewed details"); assert.deepEqual(data.buttons, ["Cancel", "Continue"]); assert.equal(data.defaultId, 0);
  f.call("checkbox", w, false); f.call("decide", w, { response: 1, checkboxChecked: false }); assert.deepEqual(await pending, { response: 1, checkboxChecked: false });
  assert.equal(w.destroyed, true); assert.equal(f.sessions[0].clearCount, 1); for (const object of [w, w.webContents, f.parent, f.parent.webContents]) assert.equal(object.eventNames().length, 0);
});

test("only the active dialog's exact main frame can read or decide", async t => {
  const f = fixture(t), pending = f.dialogs.showMessageBox(review()); await tick(); const w = f.windows[0];
  for (const event of [{ sender: f.parent.webContents, senderFrame: w.webContents.mainFrame }, { sender: w.webContents, senderFrame: { url: w.webContents.mainFrame.url } }]) {
    for (const channel of ["read", "decide", "checkbox"]) assert.throws(() => f.handlers.get("kai-dialog:" + channel)(event, { response: 1, checkboxChecked: false }), /access denied/);
  }
  const entry = w.webContents.mainFrame.url;
  for (const url of [entry + "#fragment", entry + "?query", "https://example.test", "file:///etc/passwd", "kai-plugin://example/test.html"]) { w.webContents.mainFrame.url = url; assert.throws(() => f.call("read", w), /access denied/); }
  w.webContents.mainFrame.url = entry; f.call("read", w); w.visible = false; assert.throws(() => f.call("decide", w, { response: 1, checkboxChecked: false }), /Open the dialog/); w.visible = true;
  for (const decision of [null, true, 1, { response: 99, checkboxChecked: false }, { response: -1, checkboxChecked: false }, { response: 1, checkboxChecked: "true" }, { response: 1, checkboxChecked: false, secret: 1 }, { cancel: true, response: 1, checkboxChecked: false }]) assert.throws(() => f.call("decide", w, decision), /Invalid dialog decision/);
  f.call("decide", w, { cancel: true, checkboxChecked: false }); assert.deepEqual(await pending, { response: 0, checkboxChecked: false });
});

test("close and Escape cancel using the caller's index and last checked state", async t => {
  for (const action of [w => w.destroy(), w => w.webContents.emit("before-input-event", { preventDefault() {} }, { type: "keyDown", key: "Escape" })]) {
    const f = fixture(t), pending = f.dialogs.showMessageBox(review({ buttons: ["Continue", "Cancel"], cancelId: 1, defaultId: 1, checkboxLabel: "Remember" })); await tick(); const w = f.windows[0]; f.call("read", w); f.call("checkbox", w, true); action(w);
    assert.deepEqual(await pending, { response: 1, checkboxChecked: true });
  }
});

test("missing default indices never make closing an ambiguous dialog approve", async t => {
  for (const [buttons, expected] of [[["Approve"], -1], [["Delete", "Keep"], -1], [["Yes", "No"], 1], [["OK"], 0], [["Cancel", "Proceed"], 0]]) {
    const f = fixture(t), pending = f.dialogs.showMessageBox({ buttons }); await tick(); const w = f.windows[0], data = f.call("read", w); assert.equal(data.cancelId, expected); assert.equal(data.defaultId, expected); w.destroy(); assert.equal((await pending).response, expected);
  }
});

test("queued dialogs keep their own results and cannot accept stale decisions", async t => {
  const f = fixture(t), first = f.dialogs.showMessageBox(review({ message: "First" })), second = f.dialogs.showMessageBox(review({ message: "Second" })); await tick(); assert.equal(f.windows.length, 1); const old = f.windows[0];
  f.call("read", old); f.call("decide", old, { response: 1, checkboxChecked: false }); assert.equal((await first).response, 1); await tick(); const current = f.windows[1];
  assert.throws(() => f.call("decide", old, { response: 1, checkboxChecked: false }), /access denied/); assert.equal(f.call("read", current).message, "Second"); f.call("decide", current, { cancel: true, checkboxChecked: false }); assert.equal((await second).response, 0);
  assert.notEqual(f.sessions[0].partition, f.sessions[1].partition);
});

test("parent hide, navigation, crash and close cancel both active and queued dialogs", async t => {
  const actions = [f => f.parent.hide(), f => f.parent.webContents.emit("did-start-navigation", {}, "changed", false, true), f => f.parent.webContents.emit("render-process-gone"), f => { f.parent.destroyed = true; f.parent.emit("closed"); }];
  for (const action of actions) { const f = fixture(t), first = f.dialogs.showMessageBox(review()), second = f.dialogs.showMessageBox(review()); await tick(); action(f); assert.equal((await first).response, 0); assert.equal((await second).response, 0); await tick(); assert.equal(f.windows.length, 1); }
});

test("dialog renderer loss, navigation, redirect, reload and hide cancel", async t => {
  const actions = [w => w.webContents.emit("render-process-gone"), w => w.webContents.emit("will-navigate", { preventDefault() {} }), w => w.webContents.emit("will-redirect", { preventDefault() {} }), w => w.webContents.emit("did-start-navigation", {}, w.webContents.mainFrame.url, false, true), w => w.emit("hide")];
  for (const action of actions) { const f = fixture(t), pending = f.dialogs.showMessageBox(review()); await tick(); const w = f.windows[0]; action(w); assert.equal((await pending).response, 0); assert.equal(w.destroyed, true); }
});

test("active and queued abort signals cancel only their own request", async t => {
  const f = fixture(t), a = new AbortController(), b = new AbortController();
  const first = f.dialogs.showMessageBox(review({ signal: a.signal })), second = f.dialogs.showMessageBox(review({ signal: b.signal })); await tick(); b.abort(); assert.equal((await second).response, 0); assert.equal(f.windows[0].destroyed, false); a.abort(); assert.equal((await first).response, 0); await tick(); assert.equal(f.windows.length, 1);
  assert.equal((await f.dialogs.showMessageBox(review({ signal: a.signal }))).response, 0); assert.equal(f.windows.length, 1);
});

test("disposal cancels all requests and does not resurrect dialogs", async t => {
  const f = fixture(t), a = f.dialogs.showMessageBox(review()), b = f.dialogs.showMessageBox(review()); await tick(); f.dialogs.dispose(); assert.equal((await a).response, 0); assert.equal((await b).response, 0); assert.equal(f.handlers.size, 0); assert.equal((await f.dialogs.showMessageBox(review())).response, 0); assert.equal(f.windows.length, 1); f.dialogs.dispose();
});

test("parentless startup errors wait for Electron readiness and use the same safe dialog", async t => {
  const f = fixture(t, { startup: true, ready: false }), pending = f.dialogs.showErrorBox("Could not start", "Please close the other app"); await tick(); assert.equal(f.windows.length, 0); f.readyNow(); await tick(); const w = f.windows[0];
  assert.equal(w.options.parent, undefined); assert.equal(w.options.modal, undefined); assert.equal(f.call("read", w).type, "error"); w.destroy(); assert.equal(await pending, undefined);
});

test("failed and delayed loads, hidden parents and shutdown cannot leave an actionable review", async t => {
  const fail = fixture(t, { loadFailure: true }); assert.equal((await fail.dialogs.showMessageBox(review())).response, 0); assert.equal(fail.windows[0].destroyed, true);
  const slow = fixture(t, { delayed: true }), pending = slow.dialogs.showMessageBox(review()); await tick(); const w = slow.windows[0]; slow.call("read", w); assert.throws(() => slow.call("decide", w, { response: 1, checkboxChecked: false }), /Open the dialog/); slow.parent.hide(); assert.equal((await pending).response, 0);
  const hidden = fixture(t); hidden.parent.visible = false; assert.equal((await hidden.dialogs.showMessageBox(review())).response, 0); assert.equal(hidden.windows.length, 0); hidden.parent.visible = true; hidden.state.closing = true; assert.equal((await hidden.dialogs.showMessageBox(review())).response, 0);
});

test("isolated sessions allow only fixed assets and deny permissions, popups and downloads", async t => {
  const f = fixture(t), pending = f.dialogs.showMessageBox(review()); await tick(); const w = f.windows[0], s = f.sessions[0], prefs = w.options.webPreferences, entry = w.webContents.mainFrame.url;
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.webSecurity, true); assert.equal(prefs.webviewTag, false); assert.equal(w.options.frame, false); assert.equal(w.options.modal, true); assert.equal(w.options.width, 520);
  assert.equal(s.partition.startsWith("persist:"), false); s.permission(w.webContents, "media", result => assert.equal(result, false)); assert.equal(s.check(), false);
  for (const asset of ["dialog.html", "dialog.css", "dialog.js", "assets/brand-mark.svg"]) s.filter({ url: entry.replace("dialog.html", asset) }, result => assert.deepEqual(result, { cancel: false }));
  for (const url of ["https://example.test", "http://127.0.0.1", "file:///etc/passwd", entry + "?query", entry.replace("dialog.html", "core.js")]) s.filter({ url }, result => assert.deepEqual(result, { cancel: true }));
  assert.deepEqual(w.webContents.popup(), { action: "deny" }); let prevented = 0; s.emit("will-download", { preventDefault() { prevented++; } }); w.webContents.emit("will-attach-webview", { preventDefault() { prevented++; } }); assert.equal(prevented, 2); w.destroy(); await pending;
});

test("invalid indices, oversized text and malformed options fail before creating a window", async t => {
  const f = fixture(t);
  for (const options of [null, [], { buttons: ["Yes"], cancelId: 2 }, { buttons: ["OK"], defaultId: -2 }, { buttons: [""] }, { buttons: Array(13).fill("Action") }, { title: "x".repeat(2049) }, { detail: "x".repeat(262145) }, { checkboxChecked: 1 }, { signal: {} }]) await assert.rejects(f.dialogs.showMessageBox(options), /Invalid|invalid|long/);
  assert.equal(f.windows.length, 0);
});

test("renderer and preload expose only fixed text and decision operations", () => {
  const root = path.resolve(__dirname, "../.."), html = fs.readFileSync(path.join(root, "ui-core/dialog.html"), "utf8"), renderer = fs.readFileSync(path.join(root, "ui-core/dialog.js"), "utf8"), preload = fs.readFileSync(path.join(root, "electron/core-dialogs-preload.js"), "utf8");
  assert.match(html, /connect-src 'none'/); assert.match(html, /aria-modal="true"/); assert.match(html, /aria-label="Cancel and close"/); assert.doesNotMatch(renderer, /innerHTML|insertAdjacentHTML|eval\(|fetch\(|window\.open|ipcRenderer/); assert.match(renderer, /\.textContent = data\.detail/); assert.match(renderer, /buttons\[data\.defaultId\] \|\| close/); assert.match(renderer, /event\.key !== "Tab"/); assert.doesNotMatch(renderer, /event\.key === "Enter"/); assert.match(preload, /Object\.freeze/);
  new vm.Script(renderer); new vm.Script(preload);
});

function rendererFixture(data, failRead = false) {
  const elements = new Map(), events = new Map(), decisions = [], checks = [], created = [], icons = new Map();
  const document = { activeElement: null, title: "", getElementById: id => elements.get(id), addEventListener: (name, fn) => events.set(name, fn) };
  class Element {
    constructor(id, tag = "div") { this.id = id; this.tag = tag; this.hidden = false; this.disabled = false; this.checked = false; this.dataset = {}; this.attributes = {}; this.children = []; this.events = new Map(); this.classList = { add() {} }; this.textContent = ""; }
    set innerHTML(_value) { throw Error("Renderer attempted HTML insertion"); }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(name, fn) { this.events.set(name, fn); }
    focus() { document.activeElement = this; }
    append(child) { child.parent = this; this.children.push(child); }
    getClientRects() { for (let node = this; node; node = node.parent) if (node.hidden) return []; return [{}]; }
  }
  for (const id of ["dialog-close", "dialog-checkbox", "dialog-loading", "dialog-content", "dialog-error", "dialog-title", "dialog-message", "dialog-detail", "dialog-icon", "dialog-checkbox-text", "dialog-checkbox-label", "dialog-actions", "dialog-ready"]) elements.set(id, new Element(id, id === "dialog-close" ? "button" : id === "dialog-checkbox" ? "input" : "div"));
  elements.get("dialog-ready").hidden = true; elements.get("dialog-checkbox-label").hidden = true; elements.get("dialog-checkbox-label").append(elements.get("dialog-checkbox"));
  document.createElement = tag => { const value = new Element("", tag); created.push(value); return value; };
  // SVGElement has no reflected .hidden property: only removing the attribute
  // makes it visible under the real stylesheet's [hidden] rule.
  for (const type of ["info", "question", "warning", "error"]) { const icon = new Element("icon-" + type, "svg"); icon.attributes.hidden = ""; icons.set(type, icon); }
  document.querySelector = selector => icons.get(/^svg\[data-type="([^"]+)"\]$/.exec(selector)?.[1]);
  document.querySelectorAll = () => [elements.get("dialog-close"), elements.get("dialog-content"), elements.get("dialog-checkbox"), ...created].filter(item => !item.disabled);
  const window = { kaiDialog: { read: async () => { if (failRead) throw Error("Not available"); return data; }, decide: async decision => { decisions.push(JSON.parse(JSON.stringify(decision))); }, setCheckbox: async checked => { checks.push(checked); } } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../../ui-core/dialog.js"), "utf8"), { document, window });
  return { document, elements, decisions, checks, created, icons, click: element => element.events.get("click")(), key(key, shiftKey = false) { const event = { key, shiftKey, prevented: false, preventDefault() { this.prevented = true; } }; events.get("keydown")(event); return event; } };
}

test("renderer displays hostile strings literally and preserves checkbox and exact action index", async () => {
  const value = '<img src="https://bad.invalid" onerror="bad()"><script>bad()</script>';
  const f = rendererFixture({ ...review(), title: value, message: value, detail: value, checkboxLabel: value, checkboxChecked: true }); await tick();
  for (const id of ["dialog-title", "dialog-message", "dialog-detail", "dialog-checkbox-text"]) assert.equal(f.elements.get(id).textContent, value);
  assert.equal(f.created.length, 2); assert.ok(f.created.every(element => element.tag === "button")); assert.equal(f.document.activeElement, f.created[0]);
  assert.equal(Object.hasOwn(f.icons.get("question").attributes, "hidden"), false);
  for (const type of ["info", "warning", "error"]) assert.equal(Object.hasOwn(f.icons.get(type).attributes, "hidden"), true);
  const checkbox = f.elements.get("dialog-checkbox"); checkbox.checked = false; checkbox.events.get("change")(); await tick(); assert.deepEqual(f.checks, [false]);
  f.click(f.created[1]); await tick(); assert.deepEqual(f.decisions, [{ response: 1, checkboxChecked: false }]); assert.ok(f.created.every(button => button.disabled));
});

test("renderer traps Tab and never maps Enter on content to approval", async () => {
  const f = rendererFixture({ ...review(), defaultId: -1, checkboxLabel: "", checkboxChecked: false }); await tick(); const close = f.elements.get("dialog-close"), content = f.elements.get("dialog-content");
  assert.equal(f.document.activeElement, close); assert.equal(f.key("Tab", true).prevented, true); assert.equal(f.document.activeElement, f.created[1]);
  assert.equal(f.key("Tab").prevented, true); assert.equal(f.document.activeElement, close); content.focus(); assert.equal(f.key("Enter").prevented, false); assert.deepEqual(f.decisions, []);
  assert.equal(f.key("Escape").prevented, true); await tick(); assert.deepEqual(f.decisions, [{ cancel: true, checkboxChecked: false }]);
});

test("renderer loading failure leaves only cancellation available", async () => {
  const f = rendererFixture(review(), true); await tick(); assert.equal(f.document.activeElement, f.elements.get("dialog-close")); assert.equal(f.elements.get("dialog-error").hidden, false); assert.equal(f.created.length, 0);
  f.click(f.elements.get("dialog-close")); await tick(); assert.deepEqual(f.decisions, [{ cancel: true, checkboxChecked: false }]);
});
