"use strict";
// Folder transfers are explicit: copy, verify, publish, save references, then
// optionally remove reviewed sources. No wallet, plugin or runtime data moves.
const fs = require("node:fs"), fsp = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const CHUNK = 1024 * 1024, MAX_FILES = 4096;
const key = file => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
const inside = (root, file) => key(file) === key(root) || key(file).startsWith(key(root) + path.sep);
const snapshot = st => ({ dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
const same = (a, b) => isDeepStrictEqual(a, b);
function realPath(file) {
  if (typeof file !== "string" || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) throw Error("Choose an absolute model folder path");
  const absolute = path.resolve(file), root = path.parse(absolute).root; let cursor = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const systemAlias = process.platform === "darwin" && ["/tmp", "/var", "/etc"].includes(cursor);
    if (fs.lstatSync(cursor).isSymbolicLink() && !systemAlias) throw Error("Linked model paths are not supported");
  }
  return fs.realpathSync(absolute);
}
function directory(file) {
  const resolved = realPath(file);
  if (!fs.statSync(resolved).isDirectory()) throw Error("Choose a model folder");
  return resolved;
}
function source(file) {
  const resolved = realPath(file), st = fs.lstatSync(resolved);
  if (!st.isFile() || st.nlink !== 1 || !Number.isSafeInteger(st.size)) throw Error(`Unsafe model file: ${path.basename(file)}`);
  return { source: resolved, snapshot: snapshot(st), bytes: st.size };
}
function config(state) {
  const value = state.get("modelStorage", {});
  if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).some(k => !["modelsDir", "customDir"].includes(k)) ||
      Object.values(value).some(v => v !== null && (typeof v !== "string" || !path.isAbsolute(v) || /[\0\r\n]/.test(v)))) throw Error("Saved model folders are invalid; existing state was preserved");
  return value;
}
function assertState(state) {
  if (!state.filePath) return;
  try {
    const data = JSON.parse(fs.readFileSync(realPath(state.filePath), "utf8"));
    if (!same(data, state.all())) throw Error("Core state changed on disk");
  } catch (error) {
    if (error.code === "ENOENT" && same(state.all(), {})) return;
    throw Error("Core state is unreadable or changed on disk; restart or repair it before changing model folders. Existing state was preserved.");
  }
}
function configuredModelsDir(state, fallback) {
  assertState(state);
  const saved = config(state).modelsDir;
  if (!saved) return fallback;
  try { return directory(saved); }
  catch (error) { throw Error(`The saved model folder is unavailable: ${saved}. Reconnect its drive before opening Core. ${error.message}`); }
}
function syncDirectory(folder) {
  let fd;
  try { fd = fs.openSync(folder, "r"); fs.fsyncSync(fd); }
  catch (error) { if (process.platform !== "win32" || !["EPERM", "EACCES", "EINVAL", "EISDIR", "ENOTSUP"].includes(error.code)) throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function flushFile(file) { const fd = fs.openSync(file, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function space(folder, bytes) {
  fs.accessSync(folder, fs.constants.W_OK);
  const disk = fs.statfsSync(folder);
  if (disk.bavail * disk.bsize < bytes + Math.min(bytes, 16 * CHUNK)) throw Error("The selected model folder does not have enough free space");
}
async function digest(file, signal, onBytes = () => {}) {
  signal?.throwIfAborted();
  const before = source(file), handle = await fsp.open(before.source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!same(before.snapshot, snapshot(await handle.stat()))) throw Error("Model changed while opening");
    const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(CHUNK); let offset = 0;
    while (offset < before.bytes) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.bytes - offset), offset);
      if (!bytesRead) throw Error("Model became shorter during verification");
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead; onBytes(bytesRead);
    }
    if (!same(before.snapshot, snapshot(await handle.stat())) || !same(before.snapshot, source(file).snapshot)) throw Error("Model changed during verification");
    signal?.throwIfAborted(); return { ...before, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}
async function verifiedCopy(item, target, { signal, onBytes = () => {} } = {}) {
  signal?.throwIfAborted();
  if (!same(item.snapshot, source(item.source).snapshot)) throw Error("Model changed since folder review; choose the folder again");
  const folder = directory(path.dirname(target)); target = path.join(folder, path.basename(target));
  if (fs.existsSync(target)) {
    const original = await digest(item.source, signal, onBytes), copied = await digest(target, signal, onBytes);
    if (!same(item.snapshot, original.snapshot) || original.sha256 !== copied.sha256 || original.bytes !== copied.bytes || (item.expectedSha && original.sha256 !== item.expectedSha)) throw Error(`Existing destination differs and was preserved: ${path.basename(target)}`);
    flushFile(target); syncDirectory(folder);
    return { ...item, target, targetSnapshot: copied.snapshot, sha256: copied.sha256 };
  }
  const temporary = path.join(folder, `.kai-model-${crypto.randomUUID()}.tmp`);
  let input, output, created = false;
  try {
    input = await fsp.open(item.source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (!same(item.snapshot, snapshot(await input.stat()))) throw Error("Model changed while opening");
    output = await fsp.open(temporary, "wx", 0o600); created = true;
    const buffer = Buffer.allocUnsafe(CHUNK), hash = crypto.createHash("sha256"); let position = 0;
    while (position < item.bytes) {
      signal?.throwIfAborted();
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, item.bytes - position), position);
      if (!bytesRead) throw Error("Model became shorter during transfer");
      hash.update(buffer.subarray(0, bytesRead)); let written = 0;
      while (written < bytesRead) {
        signal?.throwIfAborted();
        const result = await output.write(buffer, written, bytesRead - written, position + written);
        if (!result.bytesWritten) throw Error("Model copy stopped"); written += result.bytesWritten;
      }
      position += bytesRead; onBytes(bytesRead);
    }
    await output.sync(); await output.close(); output = null;
    if (!same(item.snapshot, snapshot(await input.stat())) || !same(item.snapshot, source(item.source).snapshot)) throw Error("Model changed during transfer");
    const sha256 = hash.digest("hex");
    if (item.expectedSha && sha256 !== item.expectedSha) throw Error("Imported model no longer matches its saved hash");
    const copied = await digest(temporary, signal, onBytes);
    if (copied.sha256 !== sha256 || copied.bytes !== item.bytes) throw Error("Copied model failed verification");
    signal?.throwIfAborted();
    try { await fsp.link(temporary, target); await fsp.unlink(temporary); created = false; }
    catch (error) {
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(error.code)) {
        // FAT/exFAT cannot publish via a hard link. Exclusive copy still never
        // overwrites another file; read back and flush it before saving state.
        await fsp.copyFile(temporary, target, fs.constants.COPYFILE_EXCL);
        const published = await digest(target, signal);
        if (published.sha256 !== sha256 || published.bytes !== item.bytes) throw Error("Published model failed verification");
        flushFile(target);
      } else if (error.code === "EEXIST") {
        const existing = await digest(target, signal);
        if (existing.sha256 !== sha256 || existing.bytes !== item.bytes) throw Error(`Existing destination differs and was preserved: ${path.basename(target)}`);
        flushFile(target);
      } else throw error;
    }
    syncDirectory(folder);
    return { ...item, target, targetSnapshot: source(target).snapshot, sha256 };
  } finally {
    if (output) await output.close().catch(() => {});
    if (input) await input.close();
    if (created) await fsp.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}
function commit(state, next) {
  assertState(state); const before = state.data; state.data = next;
  try { state.save(); } catch (error) { state.data = before; throw error; }
  if (state.filePath) { flushFile(state.filePath); syncDirectory(path.dirname(state.filePath)); assertState(state); }
}
class ModelStorage {
  constructor({ models, runtime, gateway, dataDir }) {
    Object.assign(this, { models, runtime, gateway, dataDir });
    this.job = null; this.promise = null; this.controller = null; this.closed = false;
  }
  status() { return { modelsDir: this.models.modelsDir, customDir: config(this.models.state).customDir || null, customCount: this.models._customs().length, job: structuredClone(this.job) }; }
  modelFile(name) {
    return /\.gguf(?:\.part)?$/i.test(name) || Object.values(this.models.catalog.packages || {}).some(p => [p.filename, p.mmproj?.filename].some(f => f && (name === f || name === f + ".part")));
  }
  downloaded(folder) {
    let names;
    try { names = fs.readdirSync(directory(folder)); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    if (names.length > MAX_FILES) throw Error("Too many files in the model folder");
    return names.filter(name => this.modelFile(name)).sort().map(name => source(path.join(folder, name)));
  }
  prepare(kind, selected) {
    if (!["models", "custom"].includes(kind)) throw Error("Unknown model folder");
    if (this.closed || this.promise) throw Error("Wait for the current model transfer to finish");
    assertState(this.models.state);
    const target = directory(selected), currentConfig = structuredClone(config(this.models.state)), customs = structuredClone(this.models._customs());
    if (!Array.isArray(customs) || customs.length > MAX_FILES) throw Error("Saved custom models need attention");
    const profile = realPath(this.dataDir);
    if (inside(profile, target) && !["models", "custom-models"].some(name => key(target) === key(path.join(profile, name)))) throw Error("Choose a folder outside Core's other application data");
    const from = kind === "models" ? this.models.modelsDir : currentConfig.customDir;
    if (from && (inside(from, target) || inside(target, from))) throw Error("Choose a separate folder, outside the current model folder");
    const other = kind === "models" ? currentConfig.customDir : this.models.modelsDir;
    if (other && (inside(other, target) || inside(target, other))) throw Error("Downloaded and custom model folders must be separate");
    let items;
    if (kind === "models") items = this.downloaded(from).map(item => ({ ...item, target: path.join(target, path.basename(item.source)) }));
    else {
      const seen = new Map();
      for (const custom of customs) {
        if (!custom || !/^[a-f0-9]{64}$/i.test(custom.sha256 || "")) throw Error("An imported model has no valid saved hash");
        const item = source(custom.path), dest = path.join(target, `custom-${custom.sha256.toLowerCase()}.gguf`);
        if (key(item.source) === key(dest)) continue;
        const prior = seen.get(key(item.source));
        if (prior && prior.expectedSha !== custom.sha256.toLowerCase()) throw Error("Conflicting imported model hashes");
        seen.set(key(item.source), { ...item, target: dest, expectedSha: custom.sha256.toLowerCase() });
      }
      items = [...seen.values()];
    }
    const bytes = items.reduce((n, item) => n + item.bytes, 0);
    if (!Number.isSafeInteger(bytes)) throw Error("Model transfer is too large");
    space(target, items.filter(item => !fs.existsSync(item.target)).reduce((n, item) => n + item.bytes, 0));
    return { kind, target, from, items, bytes, currentConfig, customs };
  }
  assertIdle() {
    const models = this.models;
    if (models._storageMigration || models._alphaMigration || models._active || models._importing || models._removing?.size ||
      this.gateway?.modelQueueSnapshot?.().some(job => ["queued", "preparing", "downloading"].includes(job.state))) throw Error("Finish or cancel current model downloads, imports and queued loads before changing folders");
  }
  assertReviewed(plan) {
    assertState(this.models.state);
    if (!same(config(this.models.state), plan.currentConfig) || !same(this.models._customs(), plan.customs)) throw Error("Model settings changed; choose the folder again");
  }
  start(plan, { deleteOriginals = false } = {}) {
    if (this.closed || this.promise) throw Error("Wait for the current model transfer to finish");
    this.assertIdle(); this.assertReviewed(plan);
    this.controller = new AbortController();
    this.job = { state: "running", phase: "waiting", completedBytes: 0, totalBytes: plan.bytes * 2, file: "", warnings: [] };
    this.promise = this.run(plan, deleteOriginals === true, this.controller.signal).then(result => {
      Object.assign(this.job, result, { state: "done", phase: "done" });
    }, error => { this.job.state = this.controller.signal.aborted ? "cancelled" : "error"; this.job.error = error.message; }).finally(() => {
      if (this.models._storageMigration === this.controller) this.models._storageMigration = null;
      this.controller = null; this.promise = null;
    });
    return this.status();
  }
  async run(plan, deleteOriginals, signal) {
    let hold;
    try {
      // Let assigned network work finish before claiming the file lease.
      hold = await this.runtime?.pauseNetworkWork(AbortSignal.any([signal, AbortSignal.timeout(120000)]));
      signal.throwIfAborted(); this.assertIdle(); this.assertReviewed(plan);
      if (this.runtime?.busy?.() || this.runtime?._generationActive || this.runtime?._generationQueue?.length) throw Error("Finish or cancel current local model requests before changing folders");
      this.models._storageMigration = this.controller;
      await this.runtime?.stop(); signal.throwIfAborted();
      directory(plan.target);
      const reviewed = plan.items.map(({ source, snapshot, bytes }) => ({ source, snapshot, bytes }));
      const current = plan.kind === "models" ? this.downloaded(plan.from) : plan.items.map(item => source(item.source));
      if (!same(reviewed, current)) throw Error("Model files changed since folder review; choose the folder again");
      const copied = []; this.job.phase = "copying";
      for (const item of plan.items) {
        this.job.file = path.basename(item.source);
        copied.push(await verifiedCopy(item, item.target, { signal, onBytes: n => { this.job.completedBytes += n; } }));
      }
      signal.throwIfAborted(); this.assertReviewed(plan);
      for (const item of copied) if (!same(item.snapshot, source(item.source).snapshot) || !same(item.targetSnapshot, source(item.target).snapshot)) throw Error("Model changed before saving its new location");
      const moved = new Map(copied.map(item => [key(item.source), item.target])), next = structuredClone(this.models.state.all());
      next.customModels = plan.customs.map(item => ({ ...item, path: moved.get(key(item.path)) || item.path }));
      next.modelStorage = { ...plan.currentConfig, [plan.kind === "models" ? "modelsDir" : "customDir"]: plan.target };
      this.job.phase = "saving";
      // A flush failure leaves originals intact. If state was already saved,
      // live downloads must nevertheless agree with its committed folder.
      try { commit(this.models.state, next); }
      finally { this.models.modelsDir = config(this.models.state).modelsDir || this.models.modelsDir; }
      this.job.phase = "cleaning"; let removed = 0;
      if (deleteOriginals) for (const item of copied) {
        if (signal.aborted) break;
        let deleted = false;
        try {
          assertState(this.models.state);
          if (!same(item.snapshot, source(item.source).snapshot) || !same(item.targetSnapshot, source(item.target).snapshot)) throw Error("Model changed after transfer");
          const proof = await digest(item.target, signal);
          if (proof.sha256 !== item.sha256 || !same(item.snapshot, source(item.source).snapshot)) throw Error("Model changed before source removal");
          await fsp.unlink(item.source); deleted = true; removed++; syncDirectory(path.dirname(item.source));
        } catch (error) { this.job.warnings.push(`${deleted ? "Model moved, but its old folder could not be flushed" : "Original retained"}: ${path.basename(item.source)}. ${error.message}`); }
      }
      return { copied: copied.length, removed, originalsKept: copied.length - removed, folder: plan.target };
    } finally { hold?.release(); }
  }
  cancel() {
    if (this.job?.state === "running" && !["saving", "cleaning"].includes(this.job.phase)) this.controller.abort(Error("Model transfer cancelled; original files were kept"));
    return this.status();
  }
  async dispose() { this.closed = true; this.controller?.abort(Error("Core is closing; unfinished transfers keep their original files")); await this.promise; }
}
async function storeCustomImport(models, file, sha256) {
  const selected = config(models.state).customDir;
  if (!selected) return file;
  assertState(models.state);
  const folder = directory(selected), target = path.join(folder, `custom-${sha256}.gguf`);
  if (key(file) === key(target)) return file;
  const item = source(file); space(folder, fs.existsSync(target) ? 0 : item.bytes);
  await verifiedCopy({ ...item, expectedSha: sha256 }, target); return target;
}
module.exports = { ModelStorage, configuredModelsDir, storeCustomImport, verifiedCopy };
