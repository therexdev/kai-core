"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { showRendererDialog } = require("../../electron/core-renderer-dialogs");
const { PluginHost } = require("../../electron/core-plugin-host");

function fixture() {
  let visible = true, response = 1;
  const frame = { url: "kai-plugin://community.notes/index.html" }, wc = { mainFrame: frame, isDestroyed: () => false };
  const record = { manifest: { id: "community.notes", name: "Community Notes" }, entry: frame.url, fingerprint: "publisher", digest: "package", webContents: wc,
    window: {}, controller: new AbortController(), dialogController: new AbortController(), view: { setVisible() {} } };
  const host = Object.assign(Object.create(PluginHost.prototype), { windows: new Map([[record.manifest.id, record]]), manager: { assertActive() {} },
    electron: { dialog: { showMessageBox: async (_window, options) => { f.options = options; return { response }; } } }, isVisible: () => visible });
  const event = { sender: wc, senderFrame: frame };
  const f = { host, record, event, setVisible: value => { visible = value; }, setResponse: value => { response = value; },
    show: (kind = "confirm", input = { message: "Continue?" }) => host.rendererDialog(event, kind, input) };
  return f;
}

test("visible sandboxed renderers receive a literal, named confirmation with safe defaults", async () => {
  const f = fixture(), message = '<img src=x onerror="send()">';
  assert.equal(await f.show("confirm", { message, options: { title: "Remove note", confirmLabel: "Remove" } }), true);
  assert.equal(f.options.title, "Community Notes"); assert.equal(f.options.message, "Remove note"); assert.equal(f.options.detail, message);
  assert.deepEqual(f.options.buttons, ["Cancel", "Remove"]); assert.equal(f.options.cancelId, 0); assert.equal(f.options.defaultId, 0);
  f.setResponse(0); assert.equal(await f.show(), false);
  assert.equal(await f.show("alert", { message: "Saved", options: { buttonLabel: "Close" } }), undefined);
});

test("wrong frames, changed documents and untrusted action fields cannot use dialog IPC", async () => {
  const f = fixture();
  await assert.rejects(f.host.rendererDialog({ ...f.event, senderFrame: { url: f.record.entry } }, "confirm", { message: "No" }), /caller denied/);
  f.event.senderFrame.url = "https://outside.example/"; await assert.rejects(f.show(), /caller denied/);
  f.event.senderFrame.url = f.record.entry;
  await assert.rejects(f.show("confirm", { message: "Continue?", action: "send-tokens" }), /Invalid dialog request/);
  await assert.rejects(f.show("confirm", { message: "Continue?", options: { response: 1 } }), /Invalid dialog options/);
  await assert.rejects(f.show("confirm", { message: "x".repeat(16001) }), /too long/);
  await assert.rejects(f.show("confirm", { message: "Continue?", options: { confirmLabel: "" } }), /labels/);
});

test("hidden or revoked renderers cannot open or approve a dialog", async () => {
  const f = fixture(); f.setVisible(false); assert.equal(await f.show(), false); assert.equal(f.options, undefined);
  f.setVisible(true); f.record.controller.abort(); assert.equal(await f.show(), false);
});

test("one review per plugin and hiding it cancels even if a stale result says approve", async () => {
  const f = fixture(); let finish;
  f.host.electron.dialog.showMessageBox = async (_window, options) => { f.options = options; return new Promise(resolve => { finish = resolve; }); };
  const pending = f.show(); await assert.rejects(f.show(), /Finish the current app dialog/);
  f.host.hideViews(); assert.equal(f.options.signal.aborted, true); finish({ response: 1 });
  assert.equal(await pending, false); assert.equal(f.record.dialogPending, false);
});

test("changed plugin identity is rechecked before a successful response is returned", async () => {
  const f = fixture(); let checks = 0;
  f.host.manager.assertActive = () => { if (++checks > 1) throw Error("Plugin was replaced"); };
  await assert.rejects(f.show(), /replaced/); assert.equal(f.record.dialogPending, false);
});

test("Core dialog presentation rechecks visibility after approval", async () => {
  let visible = true;
  const value = await showRendererDialog({ dialog: { async showMessageBox() { visible = false; return { response: 1 }; } }, parent: {}, name: "KAI Core", kind: "confirm", input: { message: "Continue?" }, reviewable: () => visible });
  assert.equal(value, false);
});

test("hidden plugin media requests never open a review or record a permission", async () => {
  const f = fixture(), granted = new Set(); f.host.manager.state = { installed: { "community.notes": { enabled: true } } };
  f.setVisible(false);
  const allowed = await f.host.reviewMedia(f.record, granted, f.record.webContents, "media", { isMainFrame: true, requestingUrl: f.record.entry, mediaTypes: ["audio"] });
  assert.equal(allowed, false); assert.equal(f.options, undefined); assert.equal(granted.size, 0);
});

test("a media review cannot approve after hiding and reopening its originating plugin", async () => {
  const f = fixture(), granted = new Set(); f.host.manager.state = { installed: { "community.notes": { enabled: true } } };
  const details = { isMainFrame: true, requestingUrl: f.record.entry, mediaTypes: ["audio"] }; let finish;
  f.host.electron.dialog.showMessageBox = (_window, options) => { f.options = options; return new Promise(resolve => { finish = resolve; }); };
  const pending = f.host.reviewMedia(f.record, granted, f.record.webContents, "media", details);
  f.host.hideViews(); f.setVisible(true); assert.equal(f.options.signal.aborted, true); finish({ response: 1 });
  assert.equal(await pending, false); assert.equal(granted.size, 0);
  f.host.electron.dialog.showMessageBox = async () => ({ response: 1 });
  assert.equal(await f.host.reviewMedia(f.record, granted, f.record.webContents, "media", details), true); assert.equal(granted.has("audio"), true);
});

test("media review rejects a replacement main frame even at the same entry URL", async () => {
  const f = fixture(), granted = new Set(); f.host.manager.state = { installed: { "community.notes": { enabled: true } } };
  f.host.electron.dialog.showMessageBox = async () => { f.record.webContents.mainFrame = { url: f.record.entry }; return { response: 1 }; };
  assert.equal(await f.host.reviewMedia(f.record, granted, f.record.webContents, "media", { isMainFrame: true, requestingUrl: f.record.entry, mediaTypes: ["video"] }), false);
  assert.equal(granted.size, 0);
});
