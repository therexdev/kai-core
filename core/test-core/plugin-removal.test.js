"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { PluginManager } = require("../lib/plugins/manager");
const { signingPayload } = require("../lib/plugins/package");
const { changePlugin } = require("../../electron/core-plugin-change");
const { createAppOrder } = require("../../electron/core-app-order");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-remove-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new PluginManager(root), keys = crypto.generateKeyPairSync("ed25519");
  function install(id = "example.notes", version = "1.0.0") {
    const manifest = { schema: 2, apiVersion: 3, id, name: "Notes", version, runtime: "sandboxed", entry: "index.html", permissions: ["storage.read", "storage.write"] }, files = { "index.html": "<!doctype html><title>Notes</title>" };
    const pkg = { manifest, files, publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"), signature: crypto.sign(null, Buffer.from(signingPayload(manifest, files)), keys.privateKey).toString("base64") };
    manager.install(pkg); return pkg;
  }
  install(); manager.storage("example.notes", "set", "draft", "keep me");
  const appOrder = createAppOrder({ dataDir: root, getInstalled: () => manager.list() }); appOrder.save(["example.notes"]);
  const f = { root, manager, install, response: 0, visible: true, closed: [], cleanup: [],
    options: { manager, appOrder, host: { async close(id, reason) { f.closed.push(reason); assert.equal(fs.existsSync(path.join(manager.root, id)), true); } }, payments: { async removePluginData(id) { f.cleanup.push(id); } },
      features: { async startInstalledBackground() {} }, parent: {}, reviewable: () => f.visible,
      dialog: { async showMessageBox(_parent, options) { f.dialog = options; await f.onReview?.(); return { response: f.response }; } } },
    change(action = "remove") { return changePlugin(f.options, { id: "example.notes", action }); } };
  return f;
}
test("removal cancellation and hidden review leave every file and enabled state intact", async t => {
  const f = fixture(t);
  await f.change(); assert.deepEqual(f.closed, []); assert.equal(f.manager.list()[0].enabled, true);
  assert.equal(f.dialog.defaultId, 0); assert.equal(f.dialog.cancelId, 0);
  assert.deepEqual(f.dialog.buttons, ["Cancel", "Disable instead", "Remove plugin and data"]);
  assert.match(f.dialog.detail, /wallets, keys and backups/);
  f.response = 2; f.onReview = () => { f.visible = false; };
  await f.change(); assert.equal(f.manager.storage("example.notes", "get", "draft"), "keep me"); assert.deepEqual(f.cleanup, []);
});
test("Disable instead preserves files and settings through restart and enable", async t => {
  const f = fixture(t); f.response = 1; await f.change();
  assert.deepEqual(f.closed, ["disable"]); assert.deepEqual(f.cleanup, []);
  const manager = new PluginManager(f.root); assert.equal(manager.list()[0].enabled, false);
  manager.change("example.notes", "enable"); assert.equal(manager.storage("example.notes", "get", "draft"), "keep me");
});
test("removal of a disabled plugin deletes versions, code, nested data and identity; reinstall is fresh", async t => {
  const f = fixture(t), original = f.install("example.notes", "1.1.0"); f.manager.materialize("example.notes");
  f.install("example.other"); f.manager.storage("example.other", "set", "draft", "other");
  f.manager.change("example.notes", "disable");
  const dir = path.join(f.manager.root, "example.notes"); fs.mkdirSync(path.join(dir, "data", "backups")); fs.writeFileSync(path.join(dir, "data", "backups", "old.db"), "old data");
  fs.writeFileSync(path.join(f.root, "wallet.json"), "core wallet");
  f.response = 2; await f.change();
  assert.deepEqual(f.closed, ["remove"]); assert.equal(fs.existsSync(dir), false);
  const reopened = new PluginManager(f.root); assert.equal(reopened.state.publishers["example.notes"], undefined);
  assert.equal(reopened.storage("example.other", "get", "draft"), "other"); assert.equal(fs.readFileSync(path.join(f.root, "wallet.json"), "utf8"), "core wallet");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.manager.root, "sidebar-order.json"))).ids, ["example.other"]);
  reopened.install(original); assert.equal(reopened.storage("example.notes", "get", "draft"), null);
});
test("stop failure keeps files and a retryable disabled entry, including after restart", async t => {
  const f = fixture(t); f.response = 2;
  f.options.host.close = async () => { throw Error("process still running"); };
  await assert.rejects(f.change(), /incomplete.*process still running/);
  assert.deepEqual(f.cleanup, []); const restarted = new PluginManager(f.root);
  assert.equal(restarted.list()[0].removing, true); assert.equal(restarted.list()[0].enabled, false);
  assert.throws(() => restarted.change("example.notes", "enable"), /incomplete/);
  assert.throws(() => f.install(), /Finish removing/);
  await restarted.remove("example.notes", async () => {}); assert.deepEqual(restarted.list(), []);
});
test("failed deletion retains identity and partial data for retry", async t => {
  const f = fixture(t); f.response = 2;
  const rm = fs.promises.rm; const mock = t.mock.method(fs.promises, "rm", async (target, options) => { if (target === path.join(f.manager.root, "example.notes")) throw Object.assign(Error("file locked"), { code: "EPERM" }); return rm(target, options); });
  await assert.rejects(f.change(), /incomplete.*file locked/);
  assert.equal(f.manager.list()[0].removing, true); assert.ok(f.manager.state.publishers["example.notes"]);
  mock.mock.restore(); f.response = 1; await f.change(); assert.deepEqual(f.manager.list(), []);
  assert.deepEqual(f.dialog.buttons, ["Cancel", "Retry removal"]);
});
test("a failed removal checkpoint deletes nothing; failed final state write remains retryable", async t => {
  const f = fixture(t); f.response = 2;
  const rename = fs.renameSync; let writes = 0;
  const mock = t.mock.method(fs, "renameSync", (from, to) => { if (to === f.manager.stateFile && ++writes === 1) throw Error("disk full"); return rename(from, to); });
  await assert.rejects(f.change(), /disk full/); assert.deepEqual(f.closed, []); assert.equal(f.manager.list()[0].enabled, true);
  mock.mock.restore(); writes = 0;
  const finalWrite = t.mock.method(fs, "renameSync", (from, to) => { if (to === f.manager.stateFile && ++writes === 2) throw Error("disk full"); return rename(from, to); });
  await assert.rejects(f.change(), /incomplete.*disk full/); assert.equal(fs.existsSync(path.join(f.manager.root, "example.notes")), false); assert.equal(f.manager.list()[0].removing, true);
  finalWrite.mock.restore(); await new PluginManager(f.root).remove("example.notes", async () => {});
  assert.deepEqual(new PluginManager(f.root).list(), []);
});
test("removal unlinks nested and top-level symlinks without deleting their targets", { skip: process.platform === "win32" }, async t => {
  const f = fixture(t), outside = path.join(f.root, "unrelated"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "keep"), "safe");
  fs.symlinkSync(outside, path.join(f.manager.dataDir("example.notes"), "link")); f.response = 2; await f.change();
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "safe");
  f.install(); fs.rmSync(path.join(f.manager.root, "example.notes"), { recursive: true }); fs.symlinkSync(outside, path.join(f.manager.root, "example.notes")); await f.change();
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "safe");
});
test("owned-directory cleanup rejects parent symlinks and path traversal", { skip: process.platform === "win32" }, async t => {
  const f = fixture(t), parent = path.join(f.root, "redirect"), { removeOwnedDirectory } = require("../lib/plugins/remove-directory");
  fs.symlinkSync(f.manager.root, parent);
  await assert.rejects(removeOwnedDirectory(parent, "example.notes"), /real directory/);
  await assert.rejects(removeOwnedDirectory(f.manager.root, "../wallet"), /Invalid/);
  assert.equal(fs.existsSync(path.join(f.manager.root, "example.notes")), true);
});
test("a plugin changed during confirmation must be reviewed again", async t => {
  const f = fixture(t); f.response = 2; f.onReview = () => f.install("example.notes", "1.2.0");
  await assert.rejects(f.change(), /Review removal again/); assert.deepEqual(f.closed, []);
});
