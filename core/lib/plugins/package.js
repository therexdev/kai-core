"use strict";
const crypto = require("node:crypto");
const MAX_BYTES = 24 * 1024 * 1024;
const BINARY = /\.(png|jpg|jpeg|webp|gif|wav|ogg|mp3|woff2?)$/i;
const contracts = require("./contracts.json");
const firstParty = require("./first-party.json").plugins;
const PUBLIC_PERMISSIONS = ["models.read", "inference.local", "storage.read", "storage.write"];
const PERMISSIONS = Object.freeze([...new Set([...PUBLIC_PERMISSIONS, ...Object.values(contracts).flatMap(s => Object.values(s.permissions))])]);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function safeId(value) { return typeof value === "string" && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(value) && value.length <= 100 && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value); }
function safeFile(value) {
  return typeof value === "string" && value.length <= 180 && value.split("/").every(p => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(p) && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)) && (/\.(html|js|css|svg|json|txt)$/.test(value) || BINARY.test(value));
}
function verifyPackage(input) {
  const raw = typeof input === "string" ? input : JSON.stringify(input);
  if (Buffer.byteLength(raw) > MAX_BYTES) throw Error("Plugin package exceeds 24 MB");
  const pkg = JSON.parse(raw), { manifest: m, files, publicKey, signature } = pkg;
  if (Object.keys(pkg).sort().join() !== "files,manifest,publicKey,signature") throw Error("Invalid plugin package fields");
  if (!m || m.schema !== 1 || ![1, 2].includes(m.apiVersion) || !safeId(m.id) || (typeof m.version !== "string" || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(m.version)) || typeof m.name !== "string" || !m.name.trim() || m.name.length > 100) throw Error("Invalid or incompatible plugin manifest");
  if (Object.keys(m).some(k => !["schema", "apiVersion", "id", "version", "name", "description", "entry", "permissions"].includes(k))) throw Error("Unknown manifest field");
  if (m.description !== undefined && (typeof m.description !== "string" || m.description.length > 1000)) throw Error("Invalid description");
  if (!Array.isArray(m.permissions) || new Set(m.permissions).size !== m.permissions.length || m.permissions.some(p => !PERMISSIONS.includes(p))) throw Error("Unsupported plugin permission");
  if (!files || Array.isArray(files) || typeof files !== "object" || Object.keys(files).length < 1 || Object.keys(files).length > 250) throw Error("Invalid plugin files");
  const lower = new Set();
  for (const [name, content] of Object.entries(files)) {
    if (!safeFile(name) || lower.has(name.toLowerCase()) || typeof content !== "string") throw Error("Invalid or duplicate plugin file");
    if (BINARY.test(name) && (!content || Buffer.from(content, "base64").toString("base64") !== content)) throw Error("Binary plugin assets must use canonical base64");
    lower.add(name.toLowerCase());
  }
  if (!safeFile(m.entry) || !m.entry.endsWith(".html") || !Object.hasOwn(files, m.entry)) throw Error("Plugin entry is missing");
  if (typeof publicKey !== "string" || publicKey.length > 200 || typeof signature !== "string" || signature.length > 200) throw Error("Invalid publisher signature");
  const key = crypto.createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519" || !crypto.verify(null, Buffer.from(canonical({ manifest: m, files })), key, Buffer.from(signature, "base64"))) throw Error("Plugin signature verification failed");
  const fingerprint = crypto.createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex");
  const owner = firstParty.find(p => p.id === m.id);
  // Reserve official namespaces even for packages requesting public scopes.
  // Otherwise an unrelated signer can permanently claim an official ID and its
  // retained storage before the genuine feature is installed.
  if (owner && owner.fingerprint !== fingerprint) throw Error("Official plugin IDs require the matching verified KAI publisher");
  const privatePermissions = m.permissions.filter(p => !PUBLIC_PERMISSIONS.includes(p));
  if (privatePermissions.length) {
    const spec = contracts[m.id];
    if (m.apiVersion !== 2 || !owner || owner.fingerprint !== fingerprint || !spec || privatePermissions.some(p => !Object.values(spec.permissions).includes(p))) throw Error("Private feature permissions require the matching verified KAI publisher");
  }
  return { package: pkg, fingerprint, manifest: m };
}
module.exports = { canonical, safeId, safeFile, verifyPackage, MAX_BYTES, PERMISSIONS, BINARY };
