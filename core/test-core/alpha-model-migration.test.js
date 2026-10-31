"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), fsp = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { JsonStore } = require("../lib/store");
const { ModelManager } = require("../lib/model-manager");
const { inspectAlphaModels, migrateAlphaModels } = require("../lib/alpha-model-migration");

const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const gguf = (value, size = 96) => { const bytes = Buffer.alloc(size, value); bytes.write("GGUF"); return bytes; };
function fixture(t, { vision = false, payload = gguf(1) } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-alpha-models-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, "alpha"), coreDir = path.join(root, "foundation");
  fs.mkdirSync(path.join(sourceDir, "models"), { recursive: true });
  fs.mkdirSync(coreDir);
  const projector = gguf(2);
  const pkg = { filename: "current-model.gguf", sha256: sha(payload), sizeBytes: payload.length, runtime: "llamacpp", ...(vision ? { vision: true, mmproj: { filename: "current-mmproj.gguf", sha256: sha(projector), sizeBytes: projector.length } } : {}) };
  const catalog = { aliases: { tiny: { label: "Tiny", package: "tiny@1" } }, packages: { "tiny@1": pkg } };
  const catalogPath = path.join(root, "catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify(catalog));
  const state = new JsonStore(path.join(coreDir, "state.json"), {});
  const models = new ModelManager({ catalogPath, modelsDir: path.join(coreDir, "models"), state });
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
  const alphaModel = (name, bytes) => write(path.join(sourceDir, "models", name), bytes);
  const alphaState = value => write(path.join(sourceDir, "state.json"), JSON.stringify(value));
  return { root, sourceDir, coreDir, catalog, models, state, payload, projector, alphaModel, alphaState, write };
}
const owned = (f, bytes) => path.join(f.models.modelsDir, `alpha-${sha(bytes)}.gguf`);
const noTemporaryCopies = f => assert.ok(!fs.existsSync(f.models.modelsDir) || fs.readdirSync(f.models.modelsDir).every(file => !file.startsWith(".alpha-model-")));

test("copies catalog weights and vision projector, canonicalizes renamed weights, and leaves Alpha untouched", async t => {
  const f = fixture(t, { vision: true });
  const original = f.alphaModel("old-catalog-name.gguf", f.payload);
  f.alphaModel("current-mmproj.gguf", f.projector);
  f.alphaState({ documents: [{ private: true }], connectedAccounts: { password: "untouched" } });
  const before = fs.readFileSync(path.join(f.sourceDir, "state.json"));
  const scan = inspectAlphaModels({ sourceDir: f.sourceDir, catalog: f.catalog });
  assert.equal(scan.count, 1);
  assert.equal(scan.bytes, f.payload.length + f.projector.length);
  const progress = [];
  const result = await migrateAlphaModels({ ...f, onProgress: event => progress.push(event) });
  assert.deepEqual({ copied: result.copied, models: result.models, failed: result.failed }, { copied: 2, models: 1, failed: 0 });
  assert.deepEqual(fs.readFileSync(f.models.packagePath("tiny@1")), f.payload);
  assert.deepEqual(fs.readFileSync(path.join(f.models.modelsDir, "current-mmproj.gguf")), f.projector);
  assert.deepEqual(fs.readFileSync(original), f.payload);
  assert.deepEqual(fs.readFileSync(path.join(f.sourceDir, "state.json")), before);
  assert.equal(fs.statSync(f.models.packagePath("tiny@1")).nlink, 1);
  assert.equal(fs.statSync(original).nlink, 1);
  assert.deepEqual(f.state.all(), {});
  assert.equal(progress.at(-1).completedBytes, scan.bytes);
  assert.equal(progress.at(-1).totalBytes, scan.bytes);
  assert.equal(f.models.storageUsage().bytes, scan.bytes);
  noTemporaryCopies(f);
});

test("copies imported files into Core and carries only sanitized custom-model metadata", async t => {
  const f = fixture(t), bytes = gguf(3), external = f.write(path.join(f.root, "external", "model.gguf"), bytes);
  f.alphaState({ documents: [{ text: "private" }], connectedAccounts: { token: "secret" }, customModels: [{ path: external, sha256: sha(bytes), label: "My\u0000 Alpha\nmodel", alias: "custom-my-model", contextSize: 8192, password: "never-copy", server: "https://example.invalid" }] });
  f.write(path.join(f.sourceDir, "plugins", "private.gguf"), gguf(9));
  f.write(path.join(f.sourceDir, "ollama-models", "blobs", "sha256-cache"), bytes);
  f.alphaModel("incomplete.gguf.part", bytes);
  f.alphaModel("credentials.gguf", Buffer.from("a secret that is not a model"));
  const result = await migrateAlphaModels(f);
  assert.equal(result.copied, 1);
  const [custom] = f.state.get("customModels");
  assert.equal(custom.alias, "custom-my-model");
  assert.equal(custom.label, "My  Alpha model");
  assert.equal(custom.contextSize, 8192);
  assert.equal(custom.path, owned(f, bytes));
  assert.deepEqual(Object.keys(custom).sort(), ["alias", "label", "path", "sha256", "sizeBytes", "contextSize", "minRamGb", "importedAt"].sort());
  assert.deepEqual(fs.readFileSync(custom.path), bytes);
  assert.deepEqual(fs.readFileSync(external), bytes);
  assert.equal(fs.statSync(custom.path).nlink, 1);
  assert.equal(f.models.storageUsage().bytes, bytes.length);
  assert.deepEqual(Object.keys(f.state.all()), ["customModels"]);
  assert.ok(result.warnings.some(message => /Not a GGUF/.test(message)));
  assert.deepEqual(fs.readdirSync(f.models.modelsDir), [path.basename(custom.path)]);
});

test("repeat migration verifies and skips existing files without requiring space for another copy", async t => {
  const f = fixture(t), custom = gguf(3);
  f.alphaModel("current-model.gguf", f.payload);
  f.alphaModel("old-extra.gguf", custom);
  await migrateAlphaModels(f);
  const before = fs.readFileSync(f.state.filePath), file = f.models.packagePath("tiny@1"), modified = fs.statSync(file).mtimeMs;
  t.mock.method(fs, "statfsSync", () => ({ bavail: 0, bsize: 4096 }));
  const result = await migrateAlphaModels(f);
  assert.equal(result.copied, 0);
  assert.equal(result.skipped, 2);
  assert.equal(result.models, 2);
  assert.equal(result.failed, 0);
  assert.equal(fs.statSync(file).mtimeMs, modified);
  assert.deepEqual(fs.readFileSync(f.state.filePath), before);
  assert.equal(f.state.get("customModels").length, 1);
  noTemporaryCopies(f);
});

test("preserves conflicting Core files and refuses catalog hash mismatches", async t => {
  const f = fixture(t);
  f.alphaModel("current-model.gguf", f.payload);
  const conflict = gguf(7);
  f.write(f.models.packagePath("tiny@1"), conflict);
  const result = await migrateAlphaModels(f);
  assert.equal(result.failed, 1);
  assert.equal(result.copied, 0);
  assert.ok(result.warnings.some(message => /differs and was preserved/.test(message)));
  assert.deepEqual(fs.readFileSync(f.models.packagePath("tiny@1")), conflict);
  fs.unlinkSync(f.models.packagePath("tiny@1"));
  f.alphaModel("current-model.gguf", gguf(8));
  const wrong = await migrateAlphaModels(f);
  assert.equal(wrong.failed, 1);
  assert.ok(wrong.warnings.some(message => /integrity/.test(message)));
  assert.equal(fs.existsSync(f.models.packagePath("tiny@1")), false);
  assert.deepEqual(f.state.all(), {});
  noTemporaryCopies(f);
});

test("does not follow symbolic links, hard links, or an unsafe destination", async t => {
  const f = fixture(t), bytes = gguf(4), external = f.write(path.join(f.root, "outside.gguf"), bytes);
  fs.linkSync(external, path.join(f.sourceDir, "models", "hard.gguf"));
  let canSymlink = true;
  try { fs.symlinkSync(external, path.join(f.sourceDir, "models", "linked.gguf")); } catch (error) { if (["EPERM", "EACCES"].includes(error.code)) canSymlink = false; else throw error; }
  await assert.rejects(migrateAlphaModels(f), error => {
    assert.match(error.message, /No supported Alpha model files/);
    assert.equal(error.partialResult.copied, 0);
    assert.ok(error.partialResult.warnings.some(message => /Unsafe/.test(message)));
    if (canSymlink) assert.ok(error.partialResult.warnings.some(message => /Linked/.test(message)));
    return true;
  });
  f.alphaModel("current-model.gguf", f.payload);
  const outside = f.write(path.join(f.root, "outside-core.gguf"), f.payload);
  fs.mkdirSync(f.models.modelsDir, { recursive: true });
  fs.linkSync(outside, f.models.packagePath("tiny@1"));
  const result = await migrateAlphaModels(f);
  assert.equal(result.failed, 1);
  assert.equal(fs.statSync(outside).nlink, 2);
  assert.deepEqual(fs.readFileSync(outside), f.payload);
  if (canSymlink) {
    fs.rmSync(f.models.modelsDir, { recursive: true });
    fs.symlinkSync(path.join(f.sourceDir, "models"), f.models.modelsDir, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(migrateAlphaModels(f), /Unsafe model destination/);
  }
});

test("detects Alpha changes during a streamed copy and discards the incomplete destination", async t => {
  const f = fixture(t, { payload: gguf(1, 3 * 1024 * 1024) });
  const source = f.alphaModel("current-model.gguf", f.payload);
  let changed = false;
  const result = await migrateAlphaModels({ ...f, onProgress: event => { if (!changed && event.completedBytes > 0) { changed = true; fs.appendFileSync(source, Buffer.from("changed")); } } });
  assert.equal(changed, true);
  assert.equal(result.failed, 1);
  assert.ok(result.warnings.some(message => /changed during/.test(message)));
  assert.equal(fs.existsSync(f.models.packagePath("tiny@1")), false);
  assert.equal(fs.statSync(source).size, f.payload.length + 7);
  noTemporaryCopies(f);
});

test("cancelling a streamed copy cleans staging and releases all model leases", async t => {
  const f = fixture(t, { payload: gguf(1, 3 * 1024 * 1024) });
  f.alphaModel("current-model.gguf", f.payload);
  const controller = new AbortController();
  await assert.rejects(migrateAlphaModels({ ...f, signal: controller.signal, onProgress: event => { if (event.completedBytes > 0) controller.abort(); } }), error => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.partialResult.copied, 0);
    return true;
  });
  assert.equal(fs.existsSync(f.models.packagePath("tiny@1")), false);
  assert.equal(f.models._active, null);
  assert.equal(f.models._importing, null);
  assert.equal(f.models._alphaMigration, null);
  noTemporaryCopies(f);
  assert.equal((await migrateAlphaModels(f)).copied, 1);
});

test("keeps Core custom names, repairs missing same-hash references, and disambiguates aliases", async t => {
  const f = fixture(t), bytes = gguf(3), other = gguf(4);
  const external = f.write(path.join(f.root, "custom.gguf"), bytes);
  f.alphaState({ customModels: [{ path: external, sha256: sha(bytes), label: "Alpha name", alias: "custom-kept" }] });
  f.state.set("customModels", [{ alias: "custom-kept", label: "Core name", sha256: sha(other), path: "/a/missing/core-model.gguf", sizeBytes: other.length }]);
  assert.equal((await migrateAlphaModels(f)).copied, 1);
  assert.equal(f.state.get("customModels")[1].alias, "custom-kept-2");
  f.state.set("customModels", [{ alias: "custom-personal", label: "My Core name", sha256: sha(bytes), path: path.join(f.root, "missing.gguf"), sizeBytes: bytes.length }]);
  assert.equal((await migrateAlphaModels(f)).skipped, 1);
  assert.equal(f.state.get("customModels").length, 1);
  assert.equal(f.state.get("customModels")[0].alias, "custom-personal");
  assert.equal(f.state.get("customModels")[0].path, owned(f, bytes));
});

test("respects existing and newly issued quarantine while copying", async t => {
  const f = fixture(t, { payload: gguf(1, 2 * 1024 * 1024) });
  f.alphaModel("renamed-weight.gguf", f.payload);
  f.state.set("quarantined", { "tiny@1": { reason: "revoked" } });
  let result = await migrateAlphaModels(f);
  assert.equal(result.failed, 1);
  assert.equal(result.copied, 0);
  f.state.set("quarantined", {});
  let issued = false;
  result = await migrateAlphaModels({ ...f, onProgress: event => { if (!issued && event.completedBytes > 0) { issued = true; f.models.quarantineBySha(sha(f.payload), "new revocation"); } } });
  assert.equal(issued, true);
  assert.equal(result.failed, 1);
  assert.ok(result.warnings.some(message => /quarantined/.test(message)));
  assert.equal(fs.existsSync(f.models.packagePath("tiny@1")), false);
  noTemporaryCopies(f);
});

test("preserves malformed or externally changed Core state instead of overwriting it", async t => {
  const f = fixture(t), bytes = gguf(3);
  f.alphaModel("custom.gguf", bytes);
  for (const contents of ["{broken json", "[]", JSON.stringify({ unrelated: "written outside the current store" })]) {
    fs.writeFileSync(f.state.filePath, contents);
    const result = await migrateAlphaModels(f);
    assert.equal(result.failed, 1);
    assert.ok(result.warnings.some(message => /Core state is unreadable or changed/.test(message)));
    assert.equal(fs.readFileSync(f.state.filePath, "utf8"), contents);
    assert.equal(fs.existsSync(owned(f, bytes)), false);
    noTemporaryCopies(f);
  }
  fs.unlinkSync(f.state.filePath);
  let updated = false;
  const result = await migrateAlphaModels({ ...f, onProgress: event => { if (!updated && event.completedBytes > 0) { updated = true; f.state.set("unrelated", "normal live update"); } } });
  assert.equal(result.copied, 1);
  assert.equal(f.state.get("unrelated"), "normal live update");
});

test("skips unsupported projector files and malformed metadata, and warns about missing vision support", t => {
  const f = fixture(t, { vision: true });
  f.alphaModel("current-model.gguf", f.payload);
  f.alphaModel("old-mmproj.gguf", gguf(5));
  f.alphaState({ customModels: "not an array", connectedAccounts: { token: "do not copy" } });
  const result = inspectAlphaModels({ sourceDir: f.sourceDir, catalog: f.catalog });
  assert.equal(result.count, 1);
  assert.equal(result.items.length, 1);
  assert.ok(result.warnings.some(message => /Unsupported vision projector/.test(message)));
  assert.ok(result.warnings.some(message => /needs its current vision projector/.test(message)));
  assert.ok(result.warnings.some(message => /metadata is invalid/.test(message)));
});

test("migration blocks conflicting model operations and waits for removals already in progress", async t => {
  const f = fixture(t);
  f.alphaModel("current-model.gguf", f.payload);
  let assertions;
  const result = await migrateAlphaModels({ ...f, onProgress: () => {
    if (assertions) return;
    assertions = Promise.all([
      assert.rejects(f.models.ensurePackage("tiny@1"), /migration/),
      assert.rejects(f.models.ensureMmproj("tiny@1"), /migration/),
      assert.rejects(f.models.importCustom({ path: f.models.packagePath("tiny@1") }), /migration/),
      assert.rejects(f.models.removePackage("tiny@1"), /migration/),
    ]);
    assert.throws(() => f.models.removeCustom("custom-missing"), /migration/);
  } });
  await assertions;
  assert.equal(result.copied, 1);
  const originalRm = fsp.rm;
  let release;
  t.mock.method(fsp, "rm", async (...args) => { await new Promise(resolve => { release = resolve; }); return originalRm(...args); });
  const removal = f.models.removePackage("tiny@1");
  assert.equal(f.models._removing.size, 1);
  await assert.rejects(migrateAlphaModels(f), /removal/);
  release();
  await removal;
  assert.equal(f.models._removing.size, 0);
  assert.equal((await migrateAlphaModels(f)).copied, 1);
});

test("separate profiles and sufficient destination space are required", async t => {
  const f = fixture(t);
  f.alphaModel("current-model.gguf", f.payload);
  await assert.rejects(migrateAlphaModels({ ...f, sourceDir: f.coreDir }), /must be separate/);
  t.mock.method(fs, "statfsSync", () => ({ bavail: 0, bsize: 4096 }));
  const result = await migrateAlphaModels(f);
  assert.equal(result.failed, 1);
  assert.ok(result.warnings.some(message => /Not enough free space/.test(message)));
  assert.equal(fs.existsSync(f.models.packagePath("tiny@1")), false);
  noTemporaryCopies(f);
});

test("retains saved custom naming for models found both in Alpha's model folder and metadata", async t => {
  const f = fixture(t), bytes = gguf(3);
  const source = f.alphaModel("machine-filename.gguf", bytes);
  f.alphaState({ customModels: [{ path: source, sha256: sha(bytes), label: "My chosen name", alias: "custom-chosen", contextSize: 8192 }] });
  assert.equal((await migrateAlphaModels(f)).models, 1);
  const [model] = f.state.get("customModels");
  assert.equal(model.label, "My chosen name");
  assert.equal(model.alias, "custom-chosen");
  assert.equal(model.contextSize, 8192);
});

test("early cancellation returns partial counts and an emptied source cannot report successful migration", async t => {
  const f = fixture(t), controller = new AbortController();
  f.alphaModel("current-model.gguf", f.payload);
  controller.abort("cancelled by user");
  await assert.rejects(migrateAlphaModels({ ...f, signal: controller.signal }), error => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.partialResult.models, 0);
    return true;
  });
  fs.unlinkSync(path.join(f.sourceDir, "models", "current-model.gguf"));
  await assert.rejects(migrateAlphaModels(f), error => {
    assert.match(error.message, /No supported Alpha model files/);
    assert.equal(error.partialResult.copied, 0);
    return true;
  });
  assert.equal(f.models._alphaMigration, null);
});

test("cancellation preserves models already committed and reports them for a safe retry", async t => {
  const f = fixture(t), controller = new AbortController(), extra = gguf(3);
  f.alphaModel("current-model.gguf", f.payload);
  const external = f.write(path.join(f.root, "next.gguf"), extra);
  f.alphaState({ customModels: [{ path: external, sha256: sha(extra), label: "Next model" }] });
  await assert.rejects(migrateAlphaModels({ ...f, signal: controller.signal, onProgress: event => { if (event.copied === 1) controller.abort(); } }), error => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.partialResult.copied, 1);
    assert.equal(error.partialResult.models, 1);
    return true;
  });
  assert.deepEqual(fs.readFileSync(f.models.packagePath("tiny@1")), f.payload);
  assert.equal(fs.existsSync(owned(f, extra)), false);
  noTemporaryCopies(f);
  const retried = await migrateAlphaModels(f);
  assert.equal(retried.copied, 1);
  assert.equal(retried.skipped, 1);
});

test("opt-in moves owned models without requiring duplicate disk space and leaves unrelated Alpha data", async t => {
  const f=fixture(t,{vision:true}), custom=gguf(3), originals=[f.alphaModel("current-model.gguf",f.payload),f.alphaModel("current-mmproj.gguf",f.projector),f.alphaModel("custom-owned.gguf",custom)];
  f.alphaState({customModels:[{path:originals[2],sha256:sha(custom),label:"Owned import",alias:"custom-owned"}],documents:["private"]});
  const privateFile=f.write(path.join(f.sourceDir,"wallet/wallet.json"),"encrypted private data"), stateBefore=fs.readFileSync(path.join(f.sourceDir,"state.json"));
  const stats=originals.map(file=>fs.statSync(file));
  t.mock.method(fs,"statfsSync",()=>{throw Error("Same-volume moves must not require extra model space");});
  const result=await migrateAlphaModels({...f,deleteOldModels:true});
  assert.deepEqual({copied:result.copied,moved:result.moved,deleted:result.deleted,failed:result.failed,cleanupFailed:result.cleanupFailed},{copied:3,moved:3,deleted:3,failed:0,cleanupFailed:0});
  const targets=[f.models.packagePath("tiny@1"),path.join(f.models.modelsDir,"current-mmproj.gguf"),owned(f,custom)];
  targets.forEach((file,index)=>{const current=fs.statSync(file);assert.equal(current.ino,stats[index].ino);assert.equal(current.dev,stats[index].dev);assert.equal(current.nlink,1);assert.equal(fs.existsSync(originals[index]),false);});
  assert.equal(result.reclaimedBytes,0);assert.equal(result.sourceBytesRemoved,stats.reduce((sum,st)=>sum+st.size,0));
  assert.equal(f.state.get("customModels")[0].path,owned(f,custom));assert.deepEqual(fs.readFileSync(path.join(f.sourceDir,"state.json")),stateBefore);assert.equal(fs.readFileSync(privateFile,"utf8"),"encrypted private data");noTemporaryCopies(f);
});

test("cross-volume fallback verifies and removes each copied original before processing the next", async t => {
  const f=fixture(t),first=f.alphaModel("first.gguf",gguf(4)),second=f.alphaModel("second.gguf",gguf(5));
  const originalStats=[first,second].map(file=>fs.statSync(file)),link=fs.linkSync,unlink=fs.unlinkSync,seen=[],attempted=[];
  t.mock.method(fs,"linkSync",(from,to)=>{if(path.dirname(from)===path.join(f.sourceDir,"models")){for(const previous of attempted)assert.equal(fs.existsSync(previous),false,"remove each verified original before starting another");attempted.push(from);throw Object.assign(Error("different device"),{code:"EXDEV"});}return link(from,to);});
  t.mock.method(fs,"statfsSync",()=>({bavail:96,bsize:1}));
  t.mock.method(fs,"unlinkSync",file=>{if([first,second].includes(file)){const bytes=fs.readFileSync(file),target=owned(f,bytes),record=f.state.get("customModels").find(entry=>entry.path===target);assert.ok(record,"register metadata before deleting source");assert.deepEqual(fs.readFileSync(target),bytes);seen.push(file);}return unlink(file);});
  const result=await migrateAlphaModels({...f,deleteOldModels:true});
  assert.equal(result.failed,0);assert.equal(result.cleanupFailed,0);assert.equal(result.deleted,2);assert.equal(result.moved,0);assert.equal(result.reclaimedBytes,192);assert.deepEqual(new Set(seen),new Set([first,second]));assert.deepEqual(seen,attempted);
  assert.notEqual(fs.statSync(owned(f,gguf(4))).ino,originalStats[0].ino);assert.notEqual(fs.statSync(owned(f,gguf(5))).ino,originalStats[1].ino);noTemporaryCopies(f);
});

test("opt-in cleanup removes verified prior copies but preserves external imported originals", async t => {
  const f=fixture(t),source=f.alphaModel("current-model.gguf",f.payload),external=f.write(path.join(f.root,"shared/model.gguf"),gguf(3));
  f.alphaState({customModels:[{path:external,sha256:sha(gguf(3)),alias:"custom-shared",label:"Shared model"}]});
  const first=await migrateAlphaModels(f);assert.equal(first.deleted,0);assert.equal(fs.existsSync(source),true);
  const target=f.models.packagePath("tiny@1"),before=fs.statSync(target);t.mock.method(fs,"statfsSync",()=>({bavail:0,bsize:4096}));
  const result=await migrateAlphaModels({...f,deleteOldModels:true});
  assert.equal(result.copied,0);assert.equal(result.skipped,2);assert.equal(result.deleted,1);assert.equal(result.moved,0);assert.equal(result.cleanupSkipped,1);assert.equal(result.cleanupFailed,0);
  assert.equal(fs.existsSync(source),false);assert.equal(fs.statSync(target).ino,before.ino);assert.deepEqual(fs.readFileSync(external),gguf(3));assert.ok(result.warnings.some(w=>w.includes(external)&&w.includes("outside Alpha")));
});

test("failed registration keeps the source and rolls back an unpublished same-volume move", async t => {
  const f=fixture(t),bytes=gguf(4),source=f.alphaModel("custom.gguf",bytes);
  fs.writeFileSync(f.state.filePath,"damaged state");
  const result=await migrateAlphaModels({...f,deleteOldModels:true});
  assert.equal(result.failed,1);assert.equal(result.deleted,0);assert.equal(result.copied,0);assert.deepEqual(fs.readFileSync(source),bytes);assert.equal(fs.statSync(source).nlink,1);assert.equal(fs.existsSync(owned(f,bytes)),false);assert.equal(fs.readFileSync(f.state.filePath,"utf8"),"damaged state");
});

test("source cleanup waits for destination file and registration to be flushed and can retry a failed flush", async t => {
  const f=fixture(t),bytes=gguf(4),source=f.alphaModel("custom.gguf",bytes),sync=fs.fsyncSync;let failFlush=true;
  t.mock.method(fs,"fsyncSync",fd=>{if(failFlush&&fs.fstatSync(fd).isFile())throw Object.assign(Error("flush failed"),{code:"EIO"});return sync(fd);});
  const first=await migrateAlphaModels({...f,deleteOldModels:true});assert.equal(first.copied,1);assert.equal(first.deleted,0);assert.equal(first.cleanupFailed,1);assert.equal(fs.existsSync(source),true);assert.equal(fs.statSync(source).nlink,2);assert.equal(f.state.get("customModels")[0].path,owned(f,bytes));
  failFlush=false;
  const scan=inspectAlphaModels({sourceDir:f.sourceDir,catalog:f.catalog,destinationDir:f.models.modelsDir});assert.equal(scan.count,1);
  const second=await migrateAlphaModels({...f,deleteOldModels:true});assert.equal(second.deleted,1);assert.equal(second.skipped,1);assert.equal(second.cleanupFailed,0);assert.equal(fs.existsSync(source),false);assert.equal(fs.statSync(owned(f,bytes)).nlink,1);
});

test("source unlink failure keeps a verified Core model and retry safely finishes the interrupted pair", async t => {
  const f=fixture(t),source=f.alphaModel("current-model.gguf",f.payload),unlink=fs.unlinkSync;let deny=true;
  t.mock.method(fs,"unlinkSync",file=>{if(deny&&file===source)throw Object.assign(Error("source is busy"),{code:"EACCES"});return unlink(file);});
  const first=await migrateAlphaModels({...f,deleteOldModels:true});assert.equal(first.cleanupFailed,1);assert.equal(first.deleted,0);assert.equal(first.copied,1);assert.equal(fs.statSync(source).nlink,2);
  deny=false;const second=await migrateAlphaModels({...f,deleteOldModels:true});assert.equal(second.failed,0);assert.equal(second.cleanupFailed,0);assert.equal(second.deleted,1);assert.equal(fs.existsSync(source),false);assert.deepEqual(fs.readFileSync(f.models.packagePath("tiny@1")),f.payload);
});

test("interrupted two-link moves recover only their canonical hashed target and keep other hardlinks blocked", async t => {
  const f=fixture(t),bytes=gguf(4),source=f.alphaModel("old.gguf",bytes),target=owned(f,bytes);fs.mkdirSync(f.models.modelsDir);fs.linkSync(source,target);
  assert.equal(inspectAlphaModels({sourceDir:f.sourceDir,catalog:f.catalog,destinationDir:f.models.modelsDir}).count,1);
  const recovered=await migrateAlphaModels({...f,deleteOldModels:true});assert.equal(recovered.skipped,1);assert.equal(recovered.deleted,1);assert.equal(f.state.get("customModels")[0].path,target);assert.equal(fs.statSync(target).nlink,1);
  const bad=f.alphaModel("wrong-pair.gguf",gguf(5)),wrong=owned(f,gguf(6));fs.linkSync(bad,wrong);
  const result=await migrateAlphaModels({...f,deleteOldModels:true});assert.equal(result.failed,1);assert.equal(result.deleted,0);assert.equal(fs.existsSync(bad),true);assert.equal(fs.statSync(bad).nlink,2);
  const third=f.write(path.join(f.root,"unrelated.gguf"),gguf(7));fs.linkSync(third,path.join(f.sourceDir,"models/third-link.gguf"));fs.linkSync(third,owned(f,gguf(7)));
  const scan=inspectAlphaModels({sourceDir:f.sourceDir,catalog:f.catalog,destinationDir:f.models.modelsDir});assert.ok(scan.warnings.some(w=>/Unsafe/.test(w)));assert.equal(fs.statSync(third).nlink,3);
});

test("source changes after verification never remove its original or register corrupted moved bytes", async t => {
  const f=fixture(t),source=f.alphaModel("current-model.gguf",f.payload);let changed=false;
  const result=await migrateAlphaModels({...f,deleteOldModels:true,onProgress:p=>{if(!changed&&p.detail.startsWith("Finishing move")){changed=true;fs.appendFileSync(source,"changed by Alpha");}}});
  assert.equal(result.failed,1);assert.equal(result.deleted,0);assert.equal(result.copied,0);assert.equal(fs.existsSync(source),true);assert.equal(fs.statSync(source).nlink,1);assert.equal(fs.existsSync(f.models.packagePath("tiny@1")),false);
});

test("cancelling before commit restores an unfinished move; completed earlier moves remain in Core", async t => {
  const f=fixture(t),source=f.alphaModel("current-model.gguf",f.payload),cancel=new AbortController();
  await assert.rejects(migrateAlphaModels({...f,deleteOldModels:true,signal:cancel.signal,onProgress:p=>{if(p.detail.startsWith("Finishing move"))cancel.abort();}}),error=>{assert.equal(error.partialResult.deleted,0);assert.equal(error.partialResult.copied,0);return error.name==="AbortError";});
  assert.equal(fs.existsSync(source),true);assert.equal(fs.statSync(source).nlink,1);assert.equal(fs.existsSync(f.models.packagePath("tiny@1")),false);
  const second=f.alphaModel("next.gguf",gguf(4)),cancelLater=new AbortController();
  await assert.rejects(migrateAlphaModels({...f,deleteOldModels:true,signal:cancelLater.signal,onProgress:p=>{if(p.detail==="Checking next.gguf")cancelLater.abort();}}),error=>{assert.equal(error.partialResult.deleted,1);assert.equal(error.partialResult.copied,1);return error.name==="AbortError";});
  assert.equal(fs.existsSync(source),false);assert.equal(fs.existsSync(second),true);assert.deepEqual(fs.readFileSync(f.models.packagePath("tiny@1")),f.payload);assert.equal(f.models._alphaMigration,null);
});

test("retry recovers only a verified interrupted Core staging pair before source cleanup", async t => {
  const f=fixture(t),source=f.alphaModel("current-model.gguf",f.payload),target=f.models.packagePath("tiny@1"),temporary=path.join(f.models.modelsDir,`.alpha-model-${crypto.randomUUID()}.tmp`);
  fs.mkdirSync(f.models.modelsDir);fs.writeFileSync(temporary,f.payload);fs.linkSync(temporary,target);
  const result=await migrateAlphaModels({...f,deleteOldModels:true});assert.equal(result.failed,0);assert.equal(result.deleted,1);assert.equal(result.skipped,1);assert.equal(fs.existsSync(temporary),false);assert.equal(fs.existsSync(source),false);assert.equal(fs.statSync(target).nlink,1);assert.deepEqual(fs.readFileSync(target),f.payload);
});

test("invalid interrupted staging bytes and unrelated linked Core files remain untouched", async t => {
  const f=fixture(t),source=f.alphaModel("current-model.gguf",f.payload),target=f.models.packagePath("tiny@1"),temporary=path.join(f.models.modelsDir,`.alpha-model-${crypto.randomUUID()}.tmp`);
  fs.mkdirSync(f.models.modelsDir);fs.writeFileSync(temporary,gguf(9));fs.linkSync(temporary,target);
  const result=await migrateAlphaModels({...f,deleteOldModels:true});assert.equal(result.failed,1);assert.equal(result.deleted,0);assert.equal(fs.existsSync(source),true);assert.equal(fs.statSync(temporary).nlink,2);assert.equal(fs.statSync(target).nlink,2);
  fs.unlinkSync(target);fs.unlinkSync(temporary);const unrelated=f.write(path.join(f.root,"other-model.gguf"),f.payload);fs.linkSync(unrelated,target);
  const second=await migrateAlphaModels({...f,deleteOldModels:true});assert.equal(second.failed,1);assert.equal(second.deleted,0);assert.equal(fs.existsSync(source),true);assert.equal(fs.statSync(unrelated).nlink,2);assert.equal(fs.statSync(target).nlink,2);
});
