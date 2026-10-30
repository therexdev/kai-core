"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { signingPayload, verifyPackage, safeFile, BINARY } = require("../../core/lib/plugins/package");
const [source, privateKeyFile, output] = process.argv.slice(2);
if (!source || !privateKeyFile || !output) throw Error("Usage: npm run plugin:pack -- <source-directory> <ed25519-private-key.pem> <output.kaiplugin>");
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8")), files = {};
function walk(dir, relative = "") {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = relative ? relative + "/" + entry.name : entry.name;
    if (!relative && file === "manifest.json") continue;
    if (entry.isSymbolicLink()) throw Error("Symlinks are not supported in plugin packages");
    if (entry.isDirectory()) walk(path.join(dir, entry.name), file);
    else { if (!entry.isFile()) throw Error(`Only regular files may be packaged: ${file}`); if (!safeFile(file)) throw Error(`Unsupported plugin file: ${file}`); files[file] = fs.readFileSync(path.join(dir, entry.name)).toString(BINARY.test(file) ? "base64" : "utf8"); }
  }
}
walk(source);
const key = crypto.createPrivateKey(fs.readFileSync(privateKeyFile));
if (key.asymmetricKeyType !== "ed25519") throw Error("An Ed25519 publisher key is required");
const pkg = { manifest, files, publicKey: crypto.createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64"), signature: crypto.sign(null, Buffer.from(signingPayload(manifest, files)), key).toString("base64") };
const verified = verifyPackage(pkg); require("../../core/lib/plugins/package-io").writePackageFile(output, verified.package);
console.log(`Packaged ${manifest.id}@${manifest.version}. Publisher: ${verified.fingerprint}`);
