"use strict";
// Bundled supplements are generated offline; the original catalogs stay intact.
const fs = require("node:fs"), path = require("node:path");
const directory = path.join(__dirname, "../../ui-core/locales");
const messages = JSON.parse(fs.readFileSync(path.join(directory, "core.json"), "utf8"));
const content = "/* Offline supplemental messages. Source: core.json. */\n(function (root) { const messages = " + JSON.stringify(messages) + "; for (const [language, table] of Object.entries(messages)) Object.assign(root.KaiLocaleCatalogs[language] ||= {}, table); })(typeof window === \"object\" ? window : globalThis);\n";
fs.writeFileSync(path.join(directory, "core.js"), content);
console.log("Built offline interface message supplements");
