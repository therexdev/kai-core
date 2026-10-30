"use strict";
// Explicit, local-only, one-way import. Never adopt an entire Alpha profile.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { utils } = require("koilib");
const { inspectAlphaModels, migrateAlphaModels } = require("../core/lib/alpha-model-migration");
const missing = error => error?.code === "ENOENT";
function stat(file) { try { return fs.lstatSync(file); } catch (error) { if (missing(error)) return null; throw error; } }
function identity(st) { return [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(":"); }
function realDirectory(directory) {
  let cursor = path.parse(path.resolve(directory)).root;
  for (const part of path.resolve(directory).slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part); const entry = fs.lstatSync(cursor);
    const systemAlias = process.platform === "darwin" && ["/var", "/tmp", "/etc"].includes(cursor);
    if ((!entry.isDirectory() && !systemAlias) || (entry.isSymbolicLink() && !systemAlias)) throw Error("Choose a real Alpha profile folder, not a linked folder.");
  }
  return fs.realpathSync(directory);
}
function overlaps(a, b) {
  if (process.platform === "win32") { a = a.toLowerCase(); b = b.toLowerCase(); }
  const inside = (x, y) => { const relative = path.relative(x, y); return !relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)); };
  return inside(a, b) || inside(b, a);
}
function readWallet(sourceDir) {
  const directory = path.join(sourceDir, "wallet"), file = path.join(directory, "wallet.json");
  if (!stat(directory)) return null;
  realDirectory(directory); const before = stat(file); if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 65536) throw Error("Alpha wallet file is linked, unreadable, or too large.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); let bytes;
  try {
    if (identity(fs.fstatSync(fd)) !== identity(before)) throw Error("Alpha wallet changed. Close Alpha and reopen migration.");
    const buffer = Buffer.alloc(65537); let length = 0;
    while (length < buffer.length) { const read = fs.readSync(fd, buffer, length, buffer.length - length, length); if (!read) break; length += read; }
    if (length !== before.size || length > 65536) throw Error("Alpha wallet changed or exceeds the size limit. Close Alpha and reopen migration.");
    bytes = buffer.subarray(0, length);
    if (identity(fs.fstatSync(fd)) !== identity(before) || identity(fs.lstatSync(file)) !== identity(before)) throw Error("Alpha wallet changed. Close Alpha and reopen migration.");
  } finally { fs.closeSync(fd); }
  let value; try { value = JSON.parse(bytes.toString("utf8")); } catch { throw Error("Alpha wallet is unreadable; its original file was preserved."); }
  const c = value?.crypto, k = c?.kdfparams, hex = (v, n) => typeof v === "string" && new RegExp(`^[a-f0-9]{${n}}$`, "i").test(v);
  if (value?.type !== "koinos-ai-keystore" || value.version !== 1 || typeof value.address !== "string" || !utils.isChecksumAddress(value.address) ||
      c?.kdf !== "scrypt" || c.cipher !== "aes-256-gcm" || k?.n !== 16384 || k.r !== 8 || k.p !== 1 || k.dklen !== 32 ||
      !hex(k.salt, 64) || !hex(c.cipherparams?.iv, 24) || !hex(c.ciphertext, 64) || !hex(c.mac, 32) ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
      (value.compressed !== undefined && typeof value.compressed !== "boolean") ||
      (value.ethAddress !== undefined && !/^0x[a-f0-9]{40}$/i.test(value.ethAddress))) throw Error("Alpha wallet has an unsupported or damaged encrypted format; it was preserved.");
  // Whitelist the encrypted keystore, dropping old password hints and all metadata.
  const keystore = { type: value.type, version: 1, address: value.address, createdAt: value.createdAt,
    crypto: { kdf: "scrypt", kdfparams: { n: 16384, r: 8, p: 1, dklen: 32, salt: k.salt }, cipher: "aes-256-gcm", cipherparams: { iv: c.cipherparams.iv }, ciphertext: c.ciphertext, mac: c.mac } };
  if (value.compressed !== undefined) keystore.compressed = value.compressed;
  if (value.ethAddress !== undefined) keystore.ethAddress = value.ethAddress;
  return { keystore, fingerprint: crypto.createHash("sha256").update(bytes).digest("hex"), identity: identity(before) };
}
function createAlphaMigration({ dataDir, appData, homeDir = os.homedir(), models, wallet, withWalletSpend = run => run(), chooseDirectory }, dependencies = {}) {
  const destination = realDirectory(dataDir), inspect = dependencies.inspectModels || inspectAlphaModels, copyModels = dependencies.copyModels || migrateAlphaModels;
  let source = null, reviewed = null, state = { phase: "idle", progress: { completedBytes: 0, totalBytes: 0, detail: "" } }, job = null, controller = null, disposed = false;
  const status = () => structuredClone(state);
  function idle() { if (disposed) throw Error("KAI Core is closing."); if (job) throw Error("Wait for the current migration to finish."); }
  function walletBlocked() {
    const directory = path.join(destination, "wallet");
    if (stat(directory)) realDirectory(directory);
    return !!stat(path.join(directory, "wallet.json")) || !!stat(path.join(directory, "session.bin")) || !!wallet.status().unlocked;
  }
  function select(directory) {
    let root = realDirectory(directory);
    if (stat(path.join(root, "core"))) root = realDirectory(path.join(root, "core"));
    if (overlaps(root, destination)) throw Error("Select the separate Koinos AI Alpha profile, outside the current KAI Core profile.");
    return { path: root, label: "Koinos AI Alpha", identity: [fs.statSync(root).dev, fs.statSync(root).ino].join(":") };
  }
  function inventory() {
    if (!source) return { source: null, models: { available: false, count: 0, bytes: 0, detail: "No Alpha profile was found. Choose its folder to continue." }, wallet: { available: false, blocked: false, detail: "No Alpha wallet found." } };
    let modelInfo, savedWallet, walletError;
    try { modelInfo = inspect({ sourceDir: source.path, catalog: models.catalog }); } catch (error) { modelInfo = { count: 0, bytes: 0, warnings: [error.message] }; }
    try { savedWallet = readWallet(source.path); } catch (error) { walletError = error.message; }
    let blocked; try { blocked = walletBlocked(); } catch (error) { blocked = true; walletError = error.message; }
    reviewed = { wallet: savedWallet ? { fingerprint: savedWallet.fingerprint, identity: savedWallet.identity } : null };
    return { source: { path: source.path, label: source.label }, models: { available: modelInfo.count > 0, count: modelInfo.count, bytes: modelInfo.bytes,
      detail: [modelInfo.count ? `${modelInfo.count} model${modelInfo.count === 1 ? "" : "s"} found. Files are copied into Core; Alpha keeps its originals.` : "No supported model files found.", ...(modelInfo.warnings || [])].join(" ") },
      wallet: { available: !!savedWallet && !blocked, address: savedWallet?.keystore.address || null, blocked,
        detail: blocked ? "Core already has wallet data. It will be preserved and cannot be replaced by migration." : walletError || (savedWallet ? "Copies the encrypted wallet. Use your Alpha wallet password to unlock it in Core." : "No Alpha wallet found.") } };
  }
  function scan() {
    idle();
    if (!source) for (const directory of [appData && path.join(appData, "Koinos AI", "core"), path.join(homeDir, ".koinos-ai")].filter(Boolean)) {
      if (!stat(directory)) continue;
      try { source = select(directory); break; } catch { /* An unsafe automatic candidate is never adopted. */ }
    }
    return inventory();
  }
  async function chooseSource() {
    idle(); const directory = await chooseDirectory(); if (!directory) return null; idle(); source = select(directory); return inventory();
  }
  function copyWallet() {
    controller.signal.throwIfAborted();
    if (walletBlocked()) throw Error("Core already has wallet data. Its wallet was preserved.");
    const saved = readWallet(source.path);
    if (!saved || saved.fingerprint !== reviewed?.wallet?.fingerprint || saved.identity !== reviewed.wallet.identity) throw Error("Alpha wallet changed since review. Close Alpha and reopen migration.");
    const directory = path.join(destination, "wallet"); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); realDirectory(directory);
    const file = path.join(directory, "wallet.json"), temporary = path.join(directory, `.alpha-wallet-${crypto.randomUUID()}.tmp`);
    let published = false, warning;
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(saved.keystore, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // link is an atomic no-replace publication. Source and destination are separate copies.
      fs.linkSync(temporary, file);
      published = true;
    } finally {
      try { fs.rmSync(temporary, { force: true }); }
      catch (error) { if (!published) throw error; warning = "The wallet was copied, but its temporary encrypted copy could not be removed."; }
    }
    return { copied: true, address: saved.keystore.address, detail: "Wallet copied and locked. Unlock it using your Alpha wallet password.", ...(warning ? { warning } : {}) };
  }
  function start(selection) {
    idle();
    if (!selection || typeof selection.models !== "boolean" || typeof selection.wallet !== "boolean" || (!selection.models && !selection.wallet) || Object.keys(selection).some(key => !["models", "wallet"].includes(key))) throw Error("Select Models, Wallet, or both.");
    if (!source || !reviewed) throw Error("Review the Alpha migration first.");
    const current = realDirectory(source.path), st = fs.statSync(current);
    if (current !== source.path || [st.dev, st.ino].join(":") !== source.identity) throw Error("Alpha profile changed. Reopen migration.");
    if (selection.wallet && (!reviewed.wallet || walletBlocked())) throw Error("The Alpha wallet is unavailable or Core already has wallet data. Core data was preserved.");
    if (selection.models && (models._active || models._importing || models._removing?.size)) throw Error("Finish the current model download, import or removal before migrating.");
    controller = new AbortController();
    state = { phase: "running", selected: { ...selection }, source: { path: source.path, label: source.label }, progress: { completedBytes: 0, totalBytes: 0, detail: "Starting migration…" } };
    job = Promise.resolve().then(async () => {
      const result = {}; let failed = false;
      try {
        if (selection.wallet) {
          try { result.wallet = await withWalletSpend(copyWallet); } catch (error) { if (controller.signal.aborted) throw error; failed = true; result.wallet = { copied: false, error: error.message, detail: error.message }; }
        }
        controller.signal.throwIfAborted();
        if (selection.models) {
          try { result.models = await copyModels({ sourceDir: source.path, models, signal: controller.signal, onProgress: progress => { state.progress = progress; } }); if (result.models.failed) failed = true; }
          catch (error) { result.models = error.partialResult || { copied: 0, skipped: 0, warnings: [] }; if (controller.signal.aborted) throw error; failed = true; result.models.error = error.message; }
        }
        state.phase = failed ? "failed" : "complete";
        result.summary = failed ? "Migration finished with some items not copied. Review the details below." : "Migration complete. Your Alpha files are unchanged.";
      } catch (error) {
        state.phase = controller.signal.aborted ? "cancelled" : "failed";
        result.summary = state.phase === "cancelled" ? "Migration cancelled. Completed copies were kept; Alpha files are unchanged." : "Migration stopped. Completed copies were kept; Alpha files are unchanged.";
        if (state.phase === "failed") state.error = error.message;
      } finally { state.result = result; job = null; }
    });
    return status();
  }
  return { scan, chooseSource, start, status,
    cancel() { controller?.abort(); return status(); },
    async dispose() { disposed = true; controller?.abort(); await job; },
    get running() { return !!job; } };
}
module.exports = { createAlphaMigration };
