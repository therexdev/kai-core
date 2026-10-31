"use strict";
const fs = require("node:fs");
const { configureSigning } = require("./windows-signing");
const pkg = configureSigning(JSON.parse(fs.readFileSync("package.json", "utf8")), process.env);
if (!process.argv.includes("--preflight")) fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
console.log("Azure signing configuration is present; the established Windows publisher and trusted timestamps are required.");
