"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), fsp = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { ModelStorage, configuredModelsDir, verifiedCopy } = require("../lib/model-storage");
const { ModelManager } = require("../lib/model-manager"), { JsonStore } = require("../lib/store");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-storage-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = name => { const p = path.join(root, name); fs.mkdirSync(p, { recursive: true }); return fs.realpathSync(p); };
  const profile = folder("profile"), old = folder("profile/models"), target = folder("target"), custom = folder("custom"), external = folder("external");
  const state = new JsonStore(path.join(profile, "state.json"));
  const catalog = path.join(root, "catalog.json"); fs.writeFileSync(catalog, JSON.stringify({ packages: {}, aliases: {} }));
  const models = new ModelManager({ modelsDir: old, catalogPath: catalog, state });
  const runtime = { busy: () => false, stop: async () => {}, pauseNetworkWork: async () => ({ release() {} }) };
  const gateway = { modelQueueSnapshot: () => [] };
  const storage = new ModelStorage({ models, runtime, gateway, dataDir: profile });
  const write = (folder, name, data = "GGUF-fixture") => { const file = path.join(folder, name); fs.writeFileSync(file, data); return file; };
  async function move(kind, folder, options) { storage.start(storage.prepare(kind, folder), options); await storage.promise; return storage.status().job; }
  return { root, profile, old, target, custom, external, folder, state, models, runtime, gateway, storage, write, move };
}
test("downloaded weights, projectors, partials and custom references relocate and persist", async t => {
  const f = fixture(t), file = f.write(f.old, "model.gguf"); f.write(f.old, "mmproj.gguf"); f.write(f.old, "resume.gguf.part");
  f.state.set("customModels", [{ alias: "custom-saved", path: file, sha256: sha("GGUF-fixture") }]);
  const result = await f.move("models", f.target, { deleteOriginals: true }); assert.equal(result.state, "done"); assert.equal(result.removed, 3);
  assert.equal(fs.existsSync(file), false); assert.equal(f.models.modelsDir, f.target);
  assert.equal(f.models._customs()[0].path, path.join(f.target, "model.gguf"));
  assert.equal(configuredModelsDir(new JsonStore(f.state.filePath), f.old), f.target);
});
test("custom files with identical basenames retain aliases and future imports copy without deleting sources", async t => {
  const f = fixture(t), a = f.write(f.external, "model.gguf", "GGUF-first"), b = f.write(f.folder("external2"), "model.gguf", "GGUF-second");
  const first = await f.models.importCustom({ path: a, label: "One" }), second = await f.models.importCustom({ path: b, label: "Two" });
  const result = await f.move("custom", f.custom); assert.equal(result.state, "done"); assert.equal(result.originalsKept, 2);
  assert.deepEqual(f.models._customs().map(c => c.alias), [first.alias, second.alias]); assert.equal(new Set(f.models._customs().map(c => c.path)).size, 2);
  assert.ok(fs.existsSync(a) && fs.existsSync(b));
  const fresh = f.write(f.external, "new.gguf", "GGUF-third"), added = await f.models.importCustom({ path: fresh });
  assert.equal(path.dirname(added.path), f.custom); assert.equal(fs.readFileSync(added.path, "utf8"), "GGUF-third"); assert.ok(fs.existsSync(fresh));
});
test("opted-in custom cleanup only removes reviewed imported files", async t => {
  const f = fixture(t), file = f.write(f.external, "model.gguf"), other = f.write(f.external, "other.gguf"); await f.models.importCustom({ path: file });
  const result = await f.move("custom", f.custom, { deleteOriginals: true }); assert.equal(result.state, "done"); assert.equal(result.removed, 1); assert.ok(fs.existsSync(other)); assert.ok(!fs.existsSync(file));
});
test("unrelated files and subdirectories stay in the original downloaded folder", async t => {
  const f = fixture(t); f.write(f.old, "model.gguf"); const other = f.write(f.old, "notes.txt"); const nested = f.folder("profile/models/nested"); f.write(nested, "leave.gguf");
  assert.equal((await f.move("models", f.target, { deleteOriginals: true })).state, "done"); assert.ok(fs.existsSync(other)); assert.ok(fs.existsSync(path.join(nested, "leave.gguf")));
});
test("a different destination file is never overwritten or registered", async t => {
  const f = fixture(t), file = f.write(f.old, "model.gguf", "GGUF-original"), target = f.write(f.target, "model.gguf", "GGUF-other");
  const result = await f.move("models", f.target, { deleteOriginals: true }); assert.equal(result.state, "error"); assert.match(result.error, /differs/);
  assert.equal(fs.readFileSync(target, "utf8"), "GGUF-other"); assert.ok(fs.existsSync(file)); assert.equal(f.models.modelsDir, f.old);
});
test("a failed state commit keeps originals and retry reuses its verified copy", async t => {
  const f = fixture(t), file = f.write(f.old, "model.gguf"); const save = f.state.save; f.state.save = () => { throw Error("Disk full"); };
  assert.equal((await f.move("models", f.target, { deleteOriginals: true })).state, "error"); assert.ok(fs.existsSync(file)); assert.equal(f.models.modelsDir, f.old);
  f.state.save = save; t.mock.method(fs, "statfsSync", () => ({ bavail: 0, bsize: 1 }));
  assert.equal((await f.move("models", f.target, { deleteOriginals: true })).state, "done"); assert.ok(!fs.existsSync(file));
});
test("cancelling before a transfer keeps state and originals", async t => {
  const f = fixture(t), file = f.write(f.old, "model.gguf"); f.storage.start(f.storage.prepare("models", f.target), { deleteOriginals: true }); f.storage.cancel(); await f.storage.promise;
  assert.equal(f.storage.job.state, "cancelled"); assert.ok(fs.existsSync(file)); assert.equal(f.state.get("modelStorage"), undefined);
});
test("cancelling during a copy removes staging files and preserves the source", async t => {
  const f = fixture(t), file = f.write(f.old, "model.gguf", Buffer.alloc(3 * 1024 * 1024)); const plan = f.storage.prepare("models", f.target), abort = new AbortController();
  await assert.rejects(verifiedCopy(plan.items[0], plan.items[0].target, { signal: abort.signal, onBytes() { abort.abort(Error("cancelled")); } }), /cancelled/);
  assert.deepEqual(fs.readdirSync(f.target), []); assert.ok(fs.existsSync(file));
});
test("model mutations, queued loads and local inference prevent transfer", async t => {
  const f = fixture(t), plan = f.storage.prepare("models", f.target);
  for (const prop of ["_active", "_importing", "_alphaMigration", "_storageMigration"]) { f.models[prop] = {}; assert.throws(() => f.storage.start(plan), /current/); f.models[prop] = null; }
  f.models._removing.add("model"); assert.throws(() => f.storage.start(plan), /current/); f.models._removing.clear();
  f.gateway.modelQueueSnapshot = () => [{ state: "queued" }]; assert.throws(() => f.storage.start(plan), /current/); f.gateway.modelQueueSnapshot = () => [];
  f.runtime.busy = () => true; assert.equal((await f.move("models", f.target)).state, "error"); assert.equal(f.models.modelsDir, f.old);
});
test("network work drains before the exclusive model lease, then admission resumes", async t => {
  const f = fixture(t); let resume, released = false;
  f.runtime.pauseNetworkWork = () => new Promise(resolve => { resume = () => resolve({ release() { released = true; } }); });
  f.runtime.stop = async () => { assert.ok(f.models._storageMigration); await assert.rejects(f.models.importCustom({}), /transfer/); assert.throws(() => f.models.removeCustom("x"), /transfer/); };
  f.storage.start(f.storage.prepare("models", f.target)); assert.equal(f.models._storageMigration, null); resume(); await f.storage.promise;
  assert.equal(f.storage.job.state, "done"); assert.ok(released); assert.equal(f.models._storageMigration, null);
});
test("even an already-loaded runtime rejects new demand during transfer", async t => {
  const f = fixture(t), { RuntimeManager } = require("../lib/runtime-manager");
  const runtime = Object.create(RuntimeManager.prototype); Object.assign(runtime, { models: f.models, _stopEpoch: 0, activeAlias: "loaded", runtime: { status: () => ({ running: true }) } });
  f.models._storageMigration = {}; await assert.rejects(runtime.ensure("loaded"), /transfer/); await assert.rejects(runtime.preflight(), /transfer/);
});
test("source changes after review stop the transfer before metadata changes", async t => {
  const f = fixture(t), file = f.write(f.old, "model.gguf"), plan = f.storage.prepare("models", f.target); fs.appendFileSync(file, "changed");
  f.storage.start(plan, { deleteOriginals: true }); await f.storage.promise; assert.equal(f.storage.job.state, "error"); assert.equal(f.models.modelsDir, f.old); assert.ok(fs.existsSync(file));
});
test("custom metadata changes invalidate an already reviewed plan", t => {
  const f = fixture(t), plan = f.storage.prepare("custom", f.custom); f.state.set("customModels", [{ alias: "new" }]); assert.throws(() => f.storage.start(plan), /changed/);
});
test("corrupt state, disconnected drives and overlapping folders fail clearly", t => {
  const f = fixture(t); assert.throws(() => f.storage.prepare("models", f.folder("profile/models/nested")), /outside|separate/);
  f.state.set("modelStorage", { modelsDir: path.join(f.root, "offline") }); assert.throws(() => configuredModelsDir(f.state, f.old), /Reconnect/);
  fs.writeFileSync(f.state.filePath, "{broken"); const corrupt = new JsonStore(f.state.filePath); assert.throws(() => configuredModelsDir(corrupt, f.old), /unreadable/); assert.equal(fs.readFileSync(f.state.filePath, "utf8"), "{broken");
});
test("insufficient free space stops a new copy before mutation", t => {
  const f = fixture(t); f.write(f.old, "model.gguf"); t.mock.method(fs, "statfsSync", () => ({ bavail: 0, bsize: 1 })); assert.throws(() => f.storage.prepare("models", f.target), /free space/); assert.deepEqual(fs.readdirSync(f.target), []);
});
test("filesystems without hard links use an exclusive verified copy", async t => {
  const f = fixture(t), file = f.write(f.old, "model.gguf"); t.mock.method(fsp, "link", async () => { throw Object.assign(Error("No links"), { code: "ENOTSUP" }); });
  assert.equal((await f.move("models", f.target, { deleteOriginals: true })).state, "done"); assert.ok(!fs.existsSync(file)); assert.deepEqual(fs.readdirSync(f.target), ["model.gguf"]);
});
test("changed imported content cannot replace its registered hash", async t => {
  const f = fixture(t), file = f.write(f.external, "model.gguf"); await f.models.importCustom({ path: file }); fs.appendFileSync(file, "changed");
  assert.equal((await f.move("custom", f.custom, { deleteOriginals: true })).state, "error"); assert.ok(fs.existsSync(file)); assert.equal(f.models._customs()[0].path, file);
});
test("future catalog downloads use the saved folder and catalog integrity check", async t => {
  const f = fixture(t), bytes = Buffer.from("GGUF-new-download"); const http = require("node:http");
  const server = http.createServer((_req, res) => { res.writeHead(200, { "content-length": bytes.length }); res.end(bytes); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  f.models.catalog.packages.download = { filename: "new.gguf", sha256: sha(bytes), sizeBytes: bytes.length, url: `http://127.0.0.1:${server.address().port}/model` };
  assert.equal((await f.move("models", f.target)).state, "done"); await f.models.ensurePackage("download");
  assert.equal(fs.readFileSync(path.join(f.target, "new.gguf"), "utf8"), bytes.toString()); assert.ok(!fs.existsSync(path.join(f.old, "new.gguf")));
});
test("linked sources and selected directories are rejected", t => {
  const f = fixture(t), file = f.write(f.old, "model.gguf"); fs.linkSync(file, path.join(f.external, "hardlink.gguf")); assert.throws(() => f.storage.prepare("models", f.target), /Unsafe/); fs.unlinkSync(path.join(f.external, "hardlink.gguf"));
  const linked = path.join(f.root, "linked"); fs.symlinkSync(f.target, linked, process.platform === "win32" ? "junction" : "dir"); assert.throws(() => f.storage.prepare("models", linked), /Linked/);
});
