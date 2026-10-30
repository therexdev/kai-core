"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { verifyPackage, safeId, MAX_BYTES, BINARY, canonical } = require("./package");
function directory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Plugin directory must be a real directory");
}
function read(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > MAX_BYTES) throw Error("Invalid plugin state file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { const opened = fs.fstatSync(fd); if (opened.dev !== st.dev || opened.ino !== st.ino || opened.size !== st.size) throw Error("Plugin state changed while reading"); return JSON.parse(fs.readFileSync(fd, "utf8")); } finally { fs.closeSync(fd); }
}
function write(file, value, packageFile = false) {
  if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw Error("Plugin state must be a regular file");
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { if (packageFile) require("./package-io").writePackageFile(temp, value); else fs.writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 }); fs.renameSync(temp, file); } finally { fs.rmSync(temp, { force: true }); }
}

function verifyCode(root, files) {
  const seen = new Set();
  function walk(dir, relative = "") {
    const stat = fs.lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Installed plugin code directory is unsafe");
    for (const name of fs.readdirSync(dir)) {
      const file = relative ? `${relative}/${name}` : name, absolute = path.join(dir, name), st = fs.lstatSync(absolute);
      if (st.isSymbolicLink()) throw Error("Installed plugin code contains a symbolic link");
      if (st.isDirectory()) { walk(absolute, file); continue; }
      if (!st.isFile() || st.nlink !== 1 || !Object.hasOwn(files, file)) throw Error("Installed plugin code contains an unverified file");
      const expected = Buffer.from(files[file], BINARY.test(file) ? "base64" : "utf8");
      if (st.size !== expected.length || !fs.readFileSync(absolute).equals(expected)) throw Error("Installed plugin code was modified; reinstall this plugin");
      seen.add(file);
    }
  }
  walk(root);
  if (seen.size !== Object.keys(files).length) throw Error("Installed plugin code is incomplete; reinstall this plugin");
}
class PluginManager {
  constructor(dataDir) {
    this.root = path.join(dataDir, "plugins-v3"); directory(this.root);
    this.stateFile = path.join(this.root, "installed.json");
    this.state = fs.existsSync(this.stateFile) ? read(this.stateFile) : { schema: 3, installed: {}, publishers: {} };
    if (this.state.schema !== 3 || !this.state.installed || typeof this.state.installed !== "object" || Array.isArray(this.state.installed) || !this.state.publishers || typeof this.state.publishers !== "object" || Array.isArray(this.state.publishers)) throw Error("Plugin state is unreadable; it was not reset");
    for (const [id, row] of Object.entries(this.state.installed)) {
      if (!safeId(id) || !row || typeof row !== "object" || !/^[a-f0-9]{64}$/.test(row.fingerprint || "") || !/^[a-f0-9]{64}$/.test(row.digest || "") || typeof row.enabled !== "boolean") throw Error("Invalid installed plugin state");
      if (this.state.publishers[id] !== row.fingerprint) throw Error("Plugin publisher identity changed");
    }
    for (const [id, fingerprint] of Object.entries(this.state.publishers)) if (!safeId(id) || !/^[a-f0-9]{64}$/.test(fingerprint)) throw Error("Invalid plugin publisher binding");
  }
  pluginDir(id) { if (!safeId(id)) throw Error("Invalid plugin ID"); directory(this.root); const dir = path.join(this.root, id); directory(dir); return dir; }
  dataDir(id) { const dir = path.join(this.pluginDir(id), "data"); directory(dir); return dir; }
  list() { return Object.entries(this.state.installed).map(([id, row]) => ({ id, name: row.name, version: row.version, enabled: row.enabled, runtime: row.runtime, provides: row.provides || [], consumes: row.consumes || [], permissions: row.permissions, fingerprint: row.fingerprint, rollbackAvailable: !!row.previous })); }
  install(input, { trustNative = false } = {}) {
    const snapshot = require("./package-file-verifier").getVerifiedPackage(input);
    const verified = snapshot || verifyPackage(input), { manifest: m, fingerprint } = verified;
    if (m.runtime === "native" && trustNative !== true) throw Error("Native plugin installation requires explicit full-computer-access approval");
    const old = this.state.installed[m.id];
    if (Object.hasOwn(this.state.publishers, m.id) && this.state.publishers[m.id] !== fingerprint) throw Error("Publisher changed. This plugin ID remains reserved to protect its saved data");
    const dir = this.pluginDir(m.id), file = `${m.version}-${crypto.randomUUID()}.json`;
    if (snapshot) require("./package-file-verifier").copyApprovedPackage(verified.package, path.join(dir, file));
    else write(path.join(dir, file), verified.package, true);
    const previousState = structuredClone(this.state);
    this.state.publishers[m.id] = fingerprint;
    this.state.installed[m.id] = { name: m.name, version: m.version, fingerprint, digest: verified.digest, permissions: m.permissions, provides: m.provides || [], consumes: m.consumes || [], runtime: m.runtime, nativeApproved: m.runtime === "native" && trustNative, enabled: true, file, previous: old ? { ...old, previous: null } : null };
    try { write(this.stateFile, this.state); } catch (error) { this.state = previousState; fs.unlinkSync(path.join(dir, file)); throw error; }
    return this.list();
  }
  assertActive(id, expectedDigest, expectedFingerprint) {
    if (!safeId(id)) throw Error("Invalid plugin ID");
    const row = this.state.installed[id];
    if (!row?.enabled) throw Error("Plugin is disabled or not installed");
    if (row.digest !== expectedDigest || row.fingerprint !== expectedFingerprint || this.state.publishers[id] !== expectedFingerprint || row.runtime === "native" && row.nativeApproved !== true) throw Error("Plugin changed; stop it before activating the update");
    return row;
  }
  load(id) {
    if (!safeId(id)) throw Error("Invalid plugin ID");
    const row = this.state.installed[id]; if (!row?.enabled) throw Error("Plugin is disabled or not installed");
    if (!/^[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9-]+\.json$/.test(row.file)) throw Error("Invalid installed package path");
    const v = require("./package-file-verifier").verifyPackageFile(path.join(this.pluginDir(id), row.file), { directory: this.pluginDir(id) });
    if (v.manifest.id !== id || v.fingerprint !== this.state.publishers[id] || v.fingerprint !== row.fingerprint || v.manifest.version !== row.version || v.digest !== row.digest || JSON.stringify(v.manifest.permissions) !== JSON.stringify(row.permissions) || v.manifest.runtime !== row.runtime || v.manifest.runtime === "native" && row.nativeApproved !== true) { v.dispose(); throw Error("Installed plugin identity, code or approval changed"); }
    return { ...v, digest: row.digest, dataDir: this.dataDir(id) };
  }
  materialize(id) {
    const verified = this.load(id), parent = path.join(this.pluginDir(id), "code"); directory(parent);
    const root = path.join(parent, verified.digest);
    if (require("./package-file-verifier").getVerifiedPackage(verified.package)) {
      try { require("./package-file-verifier").bindCodeRoot(verified.package, root); return { ...verified, root }; }
      catch (error) { verified.dispose(); throw error; }
    }
    if (!fs.existsSync(root)) {
      const staging = path.join(parent, `${verified.digest}-${crypto.randomUUID()}.tmp`); fs.mkdirSync(staging, { mode: 0o700 });
      try {
        for (const [name, content] of Object.entries(verified.package.files)) {
          const dest = path.join(staging, ...name.split("/")); fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
          fs.writeFileSync(dest, Buffer.from(content, BINARY.test(name) ? "base64" : "utf8"), { flag: "wx", mode: /\.(?:bin|exe)$/i.test(name) ? 0o500 : 0o400 });
        }
        // File modes are accidental-write protection, not an OS sandbox. Native
        // plugins have the user's authority and can deliberately change them.
        fs.renameSync(staging, root);
      } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    }
    verifyCode(root, verified.package.files);
    return { ...verified, root };
  }
  change(id, action) {
    const row = this.state.installed[id]; if (!safeId(id) || !row) throw Error("Unknown plugin");
    const previousState = structuredClone(this.state);
    if (action === "enable") row.enabled = true;
    else if (action === "disable") row.enabled = false;
    else if (action === "remove") delete this.state.installed[id];
    else if (action === "rollback" && row.previous) this.state.installed[id] = { ...row.previous, previous: null };
    else throw Error("Invalid plugin action");
    try { write(this.stateFile, this.state); } catch (error) { this.state = previousState; throw error; }
    return this.list();
  }
  storage(id, action, key, value) {
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) throw Error("Invalid storage key");
    const file = path.join(this.dataDir(id), "storage.json"), data = fs.existsSync(file) ? read(file) : {};
    if (!data || typeof data !== "object" || Array.isArray(data)) throw Error("Plugin storage is unreadable; it was not reset");
    if (action === "get") return Object.hasOwn(data, key) ? data[key] : null;
    if (action !== "set") throw Error("Unknown storage operation");
    data[key] = value;
    if (Object.keys(data).length > 1024 || Buffer.byteLength(JSON.stringify(data)) > 16 * 1024 * 1024) throw Error("Plugin storage limit reached");
    write(file, data); return true;
  }
}
module.exports = { PluginManager, verifyCode };
