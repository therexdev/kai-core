"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { verifyPackage, safeId, MAX_BYTES } = require("./package");
function directory(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); if (fs.lstatSync(dir).isSymbolicLink()) throw Error("Plugin directory cannot be a symbolic link"); }
function read(file) { const st = fs.lstatSync(file); if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_BYTES) throw Error("Invalid plugin state file"); return JSON.parse(fs.readFileSync(file, "utf8")); }
function write(file, value) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error("Plugin state cannot be a symbolic link");
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 }); fs.renameSync(temp, file); } finally { fs.rmSync(temp, { force: true }); }
}
class PluginManager {
  constructor(dataDir) {
    this.root = path.join(dataDir, "plugins-v1"); directory(this.root);
    this.stateFile = path.join(this.root, "installed.json");
    this.state = fs.existsSync(this.stateFile) ? read(this.stateFile) : { schema: 1, installed: {}, publishers: {} };
    if (this.state.schema !== 1 || !this.state.installed || typeof this.state.installed !== "object" || Array.isArray(this.state.installed)) throw Error("Plugin state is unreadable; it was not reset");
    // Keep publisher ownership when a plugin is removed: its retained private
    // data must never become available to a new signer claiming the same ID.
    if (this.state.publishers === undefined) this.state.publishers = {};
    if (!this.state.publishers || typeof this.state.publishers !== "object" || Array.isArray(this.state.publishers)) throw Error("Invalid plugin publisher state");
    for (const [id, row] of Object.entries(this.state.installed)) {
      if (!safeId(id) || !row || typeof row !== "object" || !/^[a-f0-9]{64}$/.test(row.fingerprint || "")) throw Error("Invalid installed plugin state");
      if (Object.hasOwn(this.state.publishers, id) && this.state.publishers[id] !== row.fingerprint) throw Error("Plugin publisher identity changed");
      this.state.publishers[id] = row.fingerprint;
    }
    for (const [id, fingerprint] of Object.entries(this.state.publishers)) if (!safeId(id) || !/^[a-f0-9]{64}$/.test(fingerprint)) throw Error("Invalid plugin publisher binding");
  }
  pluginDir(id) { if (!safeId(id)) throw Error("Invalid plugin ID"); const dir = path.join(this.root, id); directory(dir); return dir; }
  list() { return Object.entries(this.state.installed).map(([id, row]) => ({ id, name: row.name, version: row.version, enabled: row.enabled, permissions: row.permissions, fingerprint: row.fingerprint, rollbackAvailable: !!row.previous })); }
  install(input) {
    // Native UI must approve this EXACT verified package first. Revalidate
    // here so callers cannot substitute bytes between review and commit.
    const verified = verifyPackage(input), { manifest: m, fingerprint } = verified;
    const old = this.state.installed[m.id];
    if (Object.hasOwn(this.state.publishers, m.id) && this.state.publishers[m.id] !== fingerprint) throw Error("Publisher changed. This plugin ID remains reserved to protect its saved data");
    const dir = this.pluginDir(m.id), file = `${m.version}-${crypto.randomUUID()}.json`;
    write(path.join(dir, file), verified.package);
    const previousState = structuredClone(this.state);
    this.state.publishers[m.id] = fingerprint;
    this.state.installed[m.id] = { name: m.name, version: m.version, fingerprint, permissions: m.permissions, enabled: true, file, previous: old ? { ...old, previous: null } : null };
    try { write(this.stateFile, this.state); } catch (error) { this.state = previousState; fs.unlinkSync(path.join(dir, file)); throw error; }
    return this.list();
  }
  load(id) {
    const row = this.state.installed[id]; if (!row?.enabled) throw Error("Plugin is disabled or not installed");
    if (!/^[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9-]+\.json$/.test(row.file)) throw Error("Invalid installed package path");
    const v = verifyPackage(read(path.join(this.pluginDir(id), row.file)));
    if (v.manifest.id !== id || v.fingerprint !== this.state.publishers[id] || v.fingerprint !== row.fingerprint || v.manifest.version !== row.version || JSON.stringify(v.manifest.permissions) !== JSON.stringify(row.permissions)) throw Error("Installed plugin identity or grants changed");
    return v;
  }
  change(id, action) {
    const row = this.state.installed[id]; if (!safeId(id) || !row) throw Error("Unknown plugin");
    const previousState = structuredClone(this.state);
    if (action === "enable") row.enabled = true;
    else if (action === "disable") row.enabled = false;
    else if (action === "remove") delete this.state.installed[id]; // Keep private data for reinstall.
    else if (action === "rollback" && row.previous) this.state.installed[id] = { ...row.previous, previous: null };
    else throw Error("Invalid plugin action");
    try { write(this.stateFile, this.state); } catch (error) { this.state = previousState; throw error; }
    return this.list();
  }
  storage(id, action, key, value) {
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) throw Error("Invalid storage key");
    const file = path.join(this.pluginDir(id), "data.json");
    const data = fs.existsSync(file) ? read(file) : {};
    if (action === "get") return Object.hasOwn(data, key) ? data[key] : null;
    if (action !== "set") throw Error("Unknown storage operation");
    data[key] = value;
    if (Object.keys(data).length > 32 || Buffer.byteLength(JSON.stringify(data)) > 1024 * 1024) throw Error("Plugin storage limit reached");
    write(file, data); return true;
  }
}
module.exports = { PluginManager };
