"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");

// This preference contains IDs only. Plugin grants and package state stay owned
// by PluginManager, and a stale UI cannot add an uninstalled app to the sidebar.
function createAppOrder({ dataDir, getInstalled }) {
  const directory = path.join(dataDir, "plugins-v3"), file = path.join(directory, "sidebar-order.json");
  const installedIds = () => getInstalled().map(row => typeof row === "string" ? row : row.id);
  const normalize = (ids, installed) => [...new Set([...ids.filter(id => installed.includes(id)), ...installed])];
  function read() {
    const installed = installedIds();
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 65536) return installed;
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      return value?.schema === 1 && Array.isArray(value.ids) ? normalize(value.ids, installed) : installed;
    } catch { return installed; }
  }
  function save(ids) {
    const installed = installedIds();
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !installed.includes(id)) || new Set(ids).size !== ids.length || Buffer.byteLength(JSON.stringify(ids)) > 65500) throw Error("Invalid installed app order");
    const ordered = normalize(ids, installed);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw Error("App preferences directory cannot be a symbolic link");
    try { const st = fs.lstatSync(file); if (!st.isFile() || st.isSymbolicLink()) throw Error("Invalid app preferences file"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ schema: 1, ids: ordered }), { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
    return ordered;
  }
  return { read, save };
}

module.exports = { createAppOrder };
