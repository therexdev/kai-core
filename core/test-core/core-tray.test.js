"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { createCoreTray } = require("../../electron/core-tray");

function fixture({ failure, platform = process.platform, iconDirectory = path.join(__dirname, "../../build") } = {}) {
  const calls = [], app = new EventEmitter(), win = new EventEmitter();
  let quitting = false, tray;
  app.quit = () => calls.push("quit");
  Object.assign(win, { visible: true, minimized: false, destroyed: false,
    isDestroyed() { return this.destroyed; }, isMinimized() { return this.minimized; },
    hide() { if (failure === "hide") throw Error("Hide failed"); calls.push("hide"); this.visible = false; },
    show() { calls.push("show"); this.visible = true; }, focus() { calls.push("focus"); },
    restore() { calls.push("restore"); this.minimized = false; },
    close() { let prevented = false; this.emit("close", { preventDefault() { prevented = true; } }); if (!prevented) { this.destroyed = true; this.emit("closed"); } return prevented; },
  });
  class Tray extends EventEmitter {
    constructor() { super(); if (failure === "create") throw Error("Tray unavailable"); tray = this; this.destroyed = false; }
    isDestroyed() { return this.destroyed; }
    destroy() { calls.push("destroy-tray"); this.destroyed = true; }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { if (failure === "menu") throw Error("Menu unavailable"); this.menu = value; }
  }
  const image = { isEmpty: () => failure === "image", resize(size) { calls.push(["resize", size]); return this; }, setTemplateImage(value) { calls.push(["template", value]); } };
  const control = createCoreTray({ app, win, Tray, Menu: { buildFromTemplate: value => value }, nativeImage: { createFromPath(file) { calls.push(["image", file]); return image; } },
    iconDirectory, platform, isQuitting: () => quitting, logger: { warn: (...values) => calls.push(["warning", ...values]) } });
  return { app, win, calls, tray, control, setQuitting: value => { quitting = value; }, menu: name => tray.menu.find(item => item.label === name).click };
}

test("closing the main window hides it while leaving the application running", () => {
  const f = fixture(); assert.equal(f.control.available, true);
  assert.equal(f.win.close(), true); assert.equal(f.win.destroyed, false); assert.equal(f.win.visible, false);
  assert.equal(f.tray.tooltip, "KAI Core"); assert.equal(f.calls.includes("quit"), false);
  assert.equal(f.calls.includes("destroy-tray"), false);
  f.win.close(); assert.equal(f.calls.filter(value => value === "hide").length, 2);
  f.control.dispose();
});

test("tray Open, icon clicks and app activation reopen and focus the same window", () => {
  const f = fixture();
  for (const open of [f.menu("Open KAI Core"), () => f.tray.emit("click"), () => f.tray.emit("double-click"), () => f.app.emit("activate")]) {
    f.win.close(); f.win.minimized = true;
    open(); assert.equal(f.win.visible, true); assert.equal(f.win.minimized, false);
    assert.deepEqual(f.calls.slice(-3), ["restore", "show", "focus"]);
  }
  f.control.dispose();
});

test("explicit Quit requests normal teardown once and cannot be turned into Hide", () => {
  const f = fixture(), open = f.menu("Open KAI Core"), quit = f.menu("Quit KAI Core");
  quit(); quit(); assert.equal(f.calls.filter(value => value === "quit").length, 1);
  const previous = f.calls.length; open(); f.tray.emit("click"); f.app.emit("activate"); assert.equal(f.calls.length, previous);
  assert.equal(f.win.close(), false); assert.equal(f.win.destroyed, true); assert.equal(f.control.available, false);
  assert.equal(f.calls.includes("hide"), false); assert.equal(f.calls.filter(value => value === "quit").length, 1);
});

test("updater or native shutdown state lets the real main window close", () => {
  const f = fixture(); f.setQuitting(true);
  f.control.show(); assert.equal(f.calls.includes("show"), false);
  assert.equal(f.win.close(), false); assert.equal(f.control.available, false);
  assert.equal(f.calls.includes("hide"), false); assert.equal(f.calls.includes("quit"), false);
});

test("missing icons, unavailable tray hosts and partial menu failures all keep X as Quit", () => {
  for (const failure of ["image", "create", "menu"]) {
    const f = fixture({ failure }); assert.equal(f.control.available, false, failure);
    if (f.tray) assert.equal(f.tray.destroyed, true);
    assert.equal(f.win.close(), false); assert.equal(f.win.destroyed, true);
    assert.equal(f.calls.filter(value => value === "quit").length, 1, "a main-window close must quit even if optional plugin windows still exist");
    assert.equal(f.calls.includes("hide"), false);
  }
});

test("a destroyed tray or failed Hide never traps the next window close", () => {
  const destroyed = fixture(); destroyed.tray.destroy();
  assert.equal(destroyed.control.available, false); assert.equal(destroyed.win.close(), false); assert.ok(destroyed.calls.includes("quit"));
  const failed = fixture({ failure: "hide" }); assert.equal(failed.win.close(), true);
  assert.equal(failed.control.available, false); assert.equal(failed.win.close(), false); assert.ok(failed.calls.includes("quit"));
});

test("disposal removes every hook and makes retained menu callbacks inert", () => {
  const f = fixture(), open = f.menu("Open KAI Core"), quit = f.menu("Quit KAI Core");
  f.control.dispose(); f.control.dispose();
  assert.equal(f.control.available, false); assert.equal(f.calls.filter(value => value === "destroy-tray").length, 1);
  assert.equal(f.app.listenerCount("activate"), 0);
  for (const event of ["close", "closed", "session-end"]) assert.equal(f.win.listenerCount(event), 0);
  const previous = f.calls.length; open(); quit(); f.control.show(); assert.equal(f.calls.length, previous);
});

test("a final Windows session end quits without treating a canceled shutdown query as Quit", () => {
  const f = fixture({ platform: "win32" });
  f.win.emit("query-session-end", {}); assert.equal(f.calls.includes("quit"), false);
  f.win.emit("session-end", {}); assert.equal(f.calls.filter(value => value === "quit").length, 1);
  assert.equal(f.win.close(), false); assert.equal(f.calls.includes("hide"), false);
});

test("native icons preserve Windows ICO sizes and use a small macOS template", () => {
  const windows = fixture({ platform: "win32" }); assert.match(windows.calls[0][1], /icon\.ico$/); assert.ok(!windows.calls.some(row => row[0] === "resize")); windows.control.dispose();
  const mac = fixture({ platform: "darwin" }); assert.match(mac.calls[0][1], /icon\.png$/);
  assert.deepEqual(mac.calls.slice(1, 3), [["resize", { width: 22, height: 22 }], ["template", true]]); mac.control.dispose();
});

test("packaged tray icons prefer the real unpacked file needed by Linux hosts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-tray-icon-"));
  try {
    const directory = path.join(root, "app.asar", "build"), unpacked = path.join(root, "app.asar.unpacked", "build");
    fs.mkdirSync(unpacked, { recursive: true }); fs.writeFileSync(path.join(unpacked, "icon.png"), "fixture");
    const f = fixture({ platform: "linux", iconDirectory: directory }); assert.equal(f.calls[0][1], path.join(unpacked, "icon.png")); f.control.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
