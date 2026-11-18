"use strict";
const fs = require("node:fs"), path = require("node:path");

// Only remove an exact owned child. Never follow a redirected parent; rm
// unlinks symlinks inside the child instead of traversing their targets.
async function removeOwnedDirectory(parent, name) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,127}$/.test(name) || name === "." || name === "..") throw Error("Invalid removal directory");
  let stat;
  try { stat = await fs.promises.lstat(parent); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Plugin cleanup parent must be a real directory");
  await fs.promises.rm(path.join(parent, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
}
module.exports = { removeOwnedDirectory };
