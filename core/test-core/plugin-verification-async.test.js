"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { signingPayload } = require("../lib/plugins/package");
const { writePackageFile } = require("../lib/plugins/package-io");
const { verifyPackageFileAsync, getVerifiedPackage } = require("../lib/plugins/package-file-verifier");
const { PluginManager } = require("../lib/plugins/manager");
const { FoundationPluginServices } = require("../../electron/foundation-plugin-services");
function fixture(t, { bytes = 0, id = "example.async", native = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-async-plugin-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const manifest = { schema: 2, apiVersion: 3, id, name: "Async fixture", version: "1.0.0", entry: "index.html", runtime: native ? "native" : "sandboxed", ...(native ? { service: "service/index.js" } : {}), permissions: native ? ["native.execute"] : [], provides: [], consumes: [] };
  const files = { "index.html": "<!doctype html><title>Fixture</title>", "service/index.js": "exports.create=api=>{api.started?.();return{call:()=>true}};" };
  if (bytes) files["service/payload.bin"] = Buffer.alloc(bytes, 37).toString("base64");
  const keys = crypto.generateKeyPairSync("ed25519"), pkg = { manifest, files, publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), signature: crypto.sign(null, Buffer.from(signingPayload(manifest, files)), keys.privateKey).toString("base64") };
  const file = path.join(root, "fixture.kaiplugin"); writePackageFile(file, pkg);
  return { root, file, pkg };
}
function operations(root) { return fs.readdirSync(root).filter(name => name.startsWith("kai-plugin-operation-")); }
async function until(check) { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw Error("Worker did not start"); await new Promise(resolve => setTimeout(resolve, 5)); } }

test("large package verification keeps the main event loop responsive and transfers only a lazy snapshot", async t => {
  const f = fixture(t, { bytes: 16 * 1024 * 1024 }); let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  let v; try { v = await verifyPackageFileAsync(f.file, { directory: f.root, extract: false }); } finally { clearInterval(timer); }
  assert(ticks >= 3, `Main loop only advanced ${ticks} times while verifying a large package`);
  assert.equal(getVerifiedPackage(v.package), v); assert(Object.isFrozen(v.manifest));
  assert.equal(v.entries.find(entry => entry.path.endsWith(".bin")).bytes, 16 * 1024 * 1024);
  assert.throws(() => v.package.files["service/payload.bin"], /not extracted/);
  await v.dispose(); assert.deepEqual(operations(f.root), []);
});

test("simultaneous verifications use one worker and queued cancellation starts no worker", async t => {
  const f = fixture(t, { bytes: 1024 * 1024 }), workers = require("node:worker_threads"), Original = workers.Worker;
  let active = 0, peak = 0, starts = 0;
  workers.Worker = class extends Original { constructor(...args) { super(...args); starts++; peak = Math.max(peak, ++active); this.once("exit", () => active--); } };
  t.after(() => { workers.Worker = Original; });
  const first = verifyPackageFileAsync(f.file, { directory: f.root, extract: false });
  const abort = new AbortController(), second = verifyPackageFileAsync(f.file, { directory: f.root, extract: false, signal: abort.signal });
  const rejected = assert.rejects(second, /cancel queued/); abort.abort(Error("cancel queued"));
  const third = verifyPackageFileAsync(f.file, { directory: f.root, extract: false });
  const results = await Promise.all([first, third]); await rejected;
  assert.equal(starts, 2); assert.equal(peak, 1); assert.equal(active, 0);
  await Promise.all(results.map(v => v.dispose())); assert.deepEqual(operations(f.root), []);
});

test("active worker cancellation waits for termination and removes only its staging directory", async t => {
  const f = fixture(t, { bytes: 16 * 1024 * 1024 }), abort = new AbortController();
  fs.writeFileSync(path.join(f.root, "keep.txt"), "keep");
  const pending = verifyPackageFileAsync(f.file, { directory: f.root, signal: abort.signal });
  const rejected = assert.rejects(pending, /cancel active/);
  await until(() => operations(f.root).some(name => fs.readdirSync(path.join(f.root, name)).some(child => child.startsWith("kai-plugin-candidate-"))));
  abort.abort(Error("cancel active")); await rejected;
  assert.deepEqual(operations(f.root), []); assert.equal(fs.readFileSync(path.join(f.root, "keep.txt"), "utf8"), "keep");
});

test("worker rejects corrupt signatures and cleans its untrusted extraction", async t => {
  const f = fixture(t); f.pkg.files["service/index.js"] = "changed"; fs.writeFileSync(f.file, JSON.stringify(f.pkg));
  await assert.rejects(verifyPackageFileAsync(f.file, { directory: f.root }), /signature/); assert.deepEqual(operations(f.root), []);
});

test("asynchronous reviewed installation rejects changed bytes without changing installed state", async t => {
  const f = fixture(t), v = await verifyPackageFileAsync(f.file, { directory: f.root, extract: false });
  const manager = new PluginManager(path.join(f.root, "profile")); fs.appendFileSync(f.file, " ");
  await assert.rejects(manager.installAsync(v.package, { trustNative: true }), /changed after review/);
  assert.deepEqual(manager.list(), []); assert(!fs.readdirSync(manager.pluginDir(f.pkg.manifest.id)).some(name => name.endsWith(".json")));
  await v.dispose();
});

test("cold asynchronous launch verifies existing code and rejects tampering or extra files", async t => {
  const f = fixture(t), manager = new PluginManager(path.join(f.root, "profile")); manager.install(f.pkg, { trustNative: true });
  const first = await manager.materializeAsync(f.pkg.manifest.id), source = path.join(first.root, "service/index.js");
  const next = await manager.materializeAsync(f.pkg.manifest.id); assert.equal(next.root, first.root);
  assert.equal(next.package.files["service/index.js"], f.pkg.files["service/index.js"]);
  assert.deepEqual(operations(manager.pluginDir(f.pkg.manifest.id)), []);
  fs.chmodSync(source, 0o600); fs.writeFileSync(source, "changed");
  await assert.rejects(manager.materializeAsync(f.pkg.manifest.id), /modified/);
  fs.writeFileSync(source, f.pkg.files["service/index.js"]); fs.writeFileSync(path.join(first.root, "unexpected.txt"), "untrusted");
  await assert.rejects(manager.materializeAsync(f.pkg.manifest.id), /unverified/);
  await first.dispose(); await next.dispose();
});

test("a disabled or replaced installed record cannot activate after asynchronous verification", async t => {
  const f = fixture(t), manager = new PluginManager(path.join(f.root, "profile")); manager.install(f.pkg, { trustNative: true });
  const pending = manager.materializeAsync(f.pkg.manifest.id); manager.change(f.pkg.manifest.id, "disable");
  await assert.rejects(pending, /approval changed/); assert.deepEqual(operations(manager.pluginDir(f.pkg.manifest.id)), []);
});

test("closing a service during verification prevents native activation and releases its worker", async t => {
  const f = fixture(t, { bytes: 16 * 1024 * 1024 }), manager = new PluginManager(path.join(f.root, "profile")); manager.install(f.pkg, { trustNative: true });
  let started = 0; const services = new FoundationPluginServices({ manager, createApi: () => ({ started() { started++; } }) });
  const pending = services.ensure(f.pkg.manifest.id), rejected = assert.rejects(pending, /Plugin stopped/);
  await until(() => operations(manager.pluginDir(f.pkg.manifest.id)).length > 0);
  await services.close(f.pkg.manifest.id); await rejected;
  assert.equal(started, 0); assert.equal(services.records.size, 0); assert.equal(services.starting.size, 0); assert.equal(services.startControllers.size, 0);
  assert.deepEqual(operations(manager.pluginDir(f.pkg.manifest.id)), []); await services.dispose();
});

test("closing a sandboxed app cancels pending verification and waits for staging cleanup", async t => {
  const f = fixture(t, { bytes: 16 * 1024 * 1024, native: false }), manager = new PluginManager(path.join(f.root, "profile")); manager.install(f.pkg);
  const services = new FoundationPluginServices({ manager, createApi: () => ({}) });
  const pending = services.verifiedForUI(f.pkg.manifest.id), rejected = assert.rejects(pending, /Plugin stopped/);
  await until(() => operations(manager.pluginDir(f.pkg.manifest.id)).length > 0);
  await services.close(f.pkg.manifest.id); await rejected;
  assert.equal(services.uiLoads.size, 0); assert.deepEqual(operations(manager.pluginDir(f.pkg.manifest.id)), []);
  await services.dispose();
});

test("closing an app before verification finishes cannot create its view afterwards", async () => {
  const { PluginHost } = require("../../electron/core-plugin-host");
  let release, entered = false, disposed = 0, created = 0;
  const verified = { manifest: { runtime: "sandboxed" }, dispose: () => { disposed++; } };
  const features = { verifiedForUI: () => { entered = true; return new Promise(resolve => { release = resolve; }); }, close: async () => {} };
  const host = new PluginHost({ electron: { ipcMain: { handle() {} } }, manager: {}, features });
  host.create = async () => { created++; };
  const pending = host.open("example.async"); await until(() => entered);
  await host.close("example.async"); release(verified);
  assert.deepEqual(await pending, { opened: false }); assert.equal(disposed, 1); assert.equal(created, 0);
});
