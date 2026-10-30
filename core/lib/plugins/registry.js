"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { assertPublicTarget, publicPageRequest } = require("../websearch");
const { verifyPackage } = require("./package");
const format = require("./registry-format");
const { MAX_REGISTRY_BYTES, REGISTRY_URL, verifyRegistry, canonical, packageDigest, compareVersions } = format;
async function downloadRegistry(url = REGISTRY_URL, { signal = AbortSignal.timeout(30000), lookup, request = publicPageRequest, ...verifyOptions } = {}) {
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) throw Error("Registry requires a public HTTPS URL without credentials");
    const addresses = await assertPublicTarget(u.href, { ...(lookup ? { lookup } : {}) });
    const response = await request(u.href, { addresses, signal, headers: { accept: "application/json", "accept-encoding": "identity" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel(); const location = response.headers.get("location");
      if (!location) throw Error("Registry redirect has no location");
      url = new URL(location, u).href; continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw Error(`Registry download failed (${response.status})`); }
    if (!response.body) throw Error("Registry download has no body");
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > MAX_REGISTRY_BYTES) throw Error("Plugin registry exceeds 1 MB"); chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    signal.throwIfAborted();
    return verifyRegistry(Buffer.concat(chunks).toString("utf8"), verifyOptions);
  }
  throw Error("Too many registry redirects");
}
function verifyRegistryPackage(entry, input) {
  format.validateEntry(entry);
  const verified = verifyPackage(input?.package || input), m = verified.manifest;
  if (m.id !== entry.id || m.version !== entry.version || m.apiVersion !== entry.apiVersion || m.name !== entry.name || (m.description || "") !== entry.description || verified.fingerprint !== entry.fingerprint || verified.package.publicKey !== entry.publicKey || canonical([...m.permissions].sort()) !== canonical([...entry.permissions].sort()) || packageDigest(verified.package) !== entry.sha256) throw Error("Downloaded plugin does not match the signed registry entry");
  return verified;
}
class RegistryClient {
  constructor({ dataDir, coreVersion, source = REGISTRY_URL, now = () => Date.now(), download = downloadRegistry, trustedFingerprint } = {}) {
    if (typeof dataDir !== "string" || !dataDir || typeof coreVersion !== "string") throw Error("Registry requires a Core profile and version");
    compareVersions(coreVersion, coreVersion);
    this.root = path.join(dataDir, "plugins-v1"); this.file = path.join(this.root, "registry.json");
    this.coreVersion = coreVersion; this.source = source; this.now = now; this.download = download; this.trustedFingerprint = trustedFingerprint;
    this.lastError = null; this.pending = null;
  }
  options(allowExpired = false) { return { now: this.now(), allowExpired, ...(this.trustedFingerprint ? { trustedFingerprint: this.trustedFingerprint } : {}) }; }
  read() {
    for (const directory of [path.dirname(this.root), this.root]) {
      try { const st = fs.lstatSync(directory); if (!st.isDirectory() || st.isSymbolicLink()) throw Error("Unsafe registry profile directory"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    let st; try { st = fs.lstatSync(this.file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > MAX_REGISTRY_BYTES) throw Error("Unsafe plugin registry cache; original preserved");
    const text = fs.readFileSync(this.file, "utf8");
    return { envelope: verifyRegistry(text, this.options(true)), digest: crypto.createHash("sha256").update(text).digest("hex") };
  }
  status() {
    try {
      const state = this.read();
      if (!state) return { present: false, available: false, count: 0, source: this.source, error: this.lastError };
      const c = state.envelope.catalog, expired = Date.parse(c.expiresAt) <= this.now();
      return { present: true, available: !expired, count: c.plugins.length, version: c.version, sequence: c.sequence, expiresAt: c.expiresAt, generatedAt: c.generatedAt, expired, source: this.source, error: this.lastError || (expired ? "Plugin registry has expired; refresh it before installing" : null) };
    } catch (error) { return { present: true, available: false, count: 0, source: this.source, error: error.message }; }
  }
  list() {
    try {
      const state = this.read(); if (!state) return [];
      const envelope = verifyRegistry(state.envelope, this.options());
      return envelope.catalog.plugins.map(entry => {
        const compatible = compareVersions(this.coreVersion, entry.minCoreVersion) >= 0;
        return { ...entry, compatible, compatibilityReason: compatible ? null : `Requires KAI Core ${entry.minCoreVersion} or newer` };
      });
    } catch { return []; }
  }
  entry(id) {
    const state = this.read(); if (!state) throw Error("Refresh the plugin registry before installing");
    const entry = verifyRegistry(state.envelope, this.options()).catalog.plugins.find(row => row.id === id);
    if (!entry) throw Error("Plugin is not listed in the signed registry");
    if (compareVersions(this.coreVersion, entry.minCoreVersion) < 0) throw Error(`Requires KAI Core ${entry.minCoreVersion} or newer`);
    return structuredClone(entry);
  }
  async refresh({ localOnly = false, signal = AbortSignal.timeout(30000) } = {}) {
    if (localOnly) throw Error("Plugin registry refresh is unavailable in local-only mode");
    if (this.pending) return this.pending;
    const task = this.update(signal); this.pending = task;
    try { return await task; } finally { if (this.pending === task) this.pending = null; }
  }
  async update(signal) {
    try {
      const before = this.read();
      const envelope = verifyRegistry(await this.download(this.source, { signal, ...this.options() }), this.options());
      signal.throwIfAborted();
      if (before) {
        const previous = before.envelope.catalog, current = envelope.catalog;
        if (current.sequence < previous.sequence || compareVersions(current.version, previous.version) < 0 || Date.parse(current.generatedAt) < Date.parse(previous.generatedAt)) throw Error("Registry rollback refused; current catalog preserved");
        if (current.sequence === previous.sequence && canonical(current) !== canonical(previous)) throw Error("Registry changed without increasing its sequence; current catalog preserved");
      }
      if ((this.read()?.digest || null) !== (before?.digest || null)) throw Error("Registry cache changed outside Core; refresh again before writing");
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(this.root).isSymbolicLink()) throw Error("Unsafe registry profile directory");
      const temp = path.join(this.root, `.registry-${crypto.randomUUID()}.tmp`);
      try { fs.writeFileSync(temp, JSON.stringify(envelope), { flag: "wx", mode: 0o600 }); signal.throwIfAborted(); fs.renameSync(temp, this.file); }
      finally { fs.rmSync(temp, { force: true }); }
      this.lastError = null; return this.status();
    } catch (error) { this.lastError = error.message; throw error; }
  }
}
module.exports = { ...format, downloadRegistry, verifyRegistryPackage, RegistryClient };
