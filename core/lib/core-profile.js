"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const HASH = b => crypto.createHash("sha256").update(b).digest("hex");
const MAX_FILE = 32 * 1024 * 1024, MAX_TOTAL = 256 * 1024 * 1024, MAX_FILES = 10000;
const SKIP = new Set(["models", "runtimes", "ollama-models", "voice", "chats", "docs", "projects", "workspace", "test-profile-backups", "core-profile-backups", "plugins-v1"]);
function stat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function realDirectory(file, info = stat(file)) {
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw Error("Profile configuration directory must be a real directory");
}
function regularBytes(file, limit = MAX_FILE) {
  const info = stat(file);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > limit) throw Error("Profile configuration must be a regular file within the size limit");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) throw Error("Profile configuration changed while being read");
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== info.size) throw Error("Profile configuration changed while being read");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function jsonObject(file, label) {
  let value;
  try { value = JSON.parse(regularBytes(file).toString("utf8")); }
  catch (error) { throw Error(`Existing ${label} cannot be read. It was not replaced. ${error.message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`Existing ${label} is invalid. It was not replaced.`);
  return value;
}
// Call only after acquiring the SAME Electron profile lock as Alpha/Test.
// Preserve the profile in place; never relocate a model or node DB.
function inspectProfile(dataDir) {
  dataDir = path.resolve(dataDir);
  const info = stat(dataDir), existing = !!info;
  if (existing) realDirectory(dataDir, info); // Also rejects dangling symlinks.
  const present = name => !!stat(path.join(dataDir, name));
  if (present("wallet")) realDirectory(path.join(dataDir, "wallet"));
  if (present("wallet/wallet.json")) {
    const wallet = jsonObject(path.join(dataDir, "wallet/wallet.json"), "wallet");
    if (typeof wallet.address !== "string" || !wallet.address) throw Error("Existing wallet is invalid. It was not replaced.");
  }
  // JsonStore otherwise falls back to defaults for these files, which could
  // silently replace a corrupt installed-model index or privacy configuration.
  for (const name of ["settings.json", "state.json"]) if (present(name)) jsonObject(path.join(dataDir, name), name);
  return { mode: existing ? "existing" : "new", dataDir, modelsReused: present("models") || present("ollama-models"),
    preserved: { wallet: present("wallet/wallet.json"), chats: present("chats"), workflowsAndBrain: present("companion-hub.json"), agentNetwork: present("agent-network.json"), node: present("koinos-node") } };
}
function verifyBackup(destination, report, version) {
  realDirectory(destination);
  const saved = jsonObject(path.join(destination, "manifest.json"), "profile backup manifest");
  if (saved.version !== version || saved.source !== report.dataDir || saved.schema !== 1 || !Array.isArray(saved.files) || saved.files.length > MAX_FILES) throw Error("Invalid profile backup");
  let bytes = 0; const seen = new Set();
  for (const file of saved.files) {
    if (!file || typeof file.path !== "string" || !file.path || file.path.includes("\\") || file.path.includes(":")) throw Error("Invalid profile backup path");
    const parts = file.path.split("/");
    if (parts.some(p => !p || p === "." || p === ".." || p.includes("\0")) || seen.has(file.path)) throw Error("Invalid profile backup path");
    seen.add(file.path);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE || (bytes += file.bytes) > MAX_TOTAL || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error("Invalid profile backup record");
    let parent = destination;
    for (const component of parts.slice(0, -1)) { parent = path.join(parent, component); realDirectory(parent); }
    const content = regularBytes(path.join(destination, ...parts));
    if (content.length !== file.bytes || HASH(content) !== file.sha256) throw Error("Profile backup verification failed; existing backup was not replaced");
  }
}
function prepareProfile(dataDir, version) {
  const report = inspectProfile(dataDir); dataDir = report.dataDir;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,99}$/.test(version)) throw Error("Invalid backup version");
  if (report.mode === "new") return { ...report, backup: null };
  const root = path.join(dataDir, "core-profile-backups"), destination = path.join(root, version);
  if (!stat(root)) fs.mkdirSync(root, { mode: 0o700 });
  realDirectory(root);
  if (stat(destination)) { verifyBackup(destination, report, version); return { ...report, backup: destination }; }
  const temp = fs.mkdtempSync(path.join(root, ".pending-")); const files = []; let bytes = 0;
  try {
    function visit(relative, depth) {
      const dir = path.join(dataDir, relative); realDirectory(dir);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!relative && SKIP.has(entry.name)) continue;
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        // Node data is large and has its own recovery lifecycle. Preserve just
        // its root config; never copy databases, Docker mounts or chain state.
        if (relative === "koinos-node" && (entry.isDirectory() || !/\.(json|cfg|enc|bin)$/.test(entry.name))) continue;
        if (entry.isSymbolicLink()) throw Error(`Cannot back up symbolic link: ${name}`);
        if (entry.isDirectory()) {
          if (depth >= 5) throw Error("Profile configuration exceeds the backup directory depth limit; no data was changed");
          visit(name, depth + 1); continue;
        }
        if (!/\.(json|cfg|enc|bin)$/.test(entry.name)) continue;
        const content = regularBytes(path.join(dataDir, name));
        if ((bytes += content.length) > MAX_TOTAL || files.length >= MAX_FILES) throw Error("Profile configuration backup exceeds its size limit; no data was changed");
        const target = path.join(temp, name);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, content, { flag: "wx", mode: 0o600 });
        const sha256 = HASH(content); if (HASH(regularBytes(target)) !== sha256) throw Error("Backup verification failed");
        files.push({ path: name, bytes: content.length, sha256 });
      }
    }
    visit("", 0);
    fs.writeFileSync(path.join(temp, "manifest.json"), JSON.stringify({ schema: 1, version, source: report.dataDir, createdAt: new Date().toISOString(), files }, null, 2), { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, destination);
  } catch (error) { fs.rmSync(temp, { recursive: true, force: true }); throw error; }
  return { ...report, backup: destination };
}
module.exports = { inspectProfile, prepareProfile };
