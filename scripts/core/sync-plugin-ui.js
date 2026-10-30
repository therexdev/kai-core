"use strict";
// Copy reviewed presentation primitives into each independently signed package.
const fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, "../.."), parent = path.resolve(process.argv[2] || path.join(root, ".."));
const plugins = require(path.join(root, "core/lib/plugins/first-party.json")).plugins;
for (const plugin of plugins) {
  const directory = path.join(parent, plugin.repository.split("/")[1], "plugin");
  if (!fs.statSync(directory).isDirectory()) throw Error("Missing plugin source: " + plugin.id);
  for (const file of ["kai-theme.css", "kai-notices.js"]) fs.copyFileSync(path.join(__dirname, "plugin-ui", file), path.join(directory, file));
  fs.copyFileSync(path.join(root, "ui-core/assets/brand-mark.svg"), path.join(directory, "brand-mark.svg"));
}
console.log(`Synchronized presentation files for ${plugins.length} plugins.`);
