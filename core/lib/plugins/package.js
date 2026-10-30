"use strict";
const crypto = require("node:crypto");
const MAX_BYTES = 5 * 1024 * 1024;
const PERMISSIONS = Object.freeze(["models.read", "inference.local", "storage.read", "storage.write"]);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function safeId(value) { return typeof value === "string" && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(value) && value.length <= 100 && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value); }
function safeFile(value) {
  return typeof value === "string" && value.length <= 180 && value.split("/").every(p => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(p) && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)) && /\.(html|js|css|svg|json|txt)$/.test(value);
}
function verifyPackage(input) {
  const raw = typeof input === "string" ? input : JSON.stringify(input);
  if (Buffer.byteLength(raw) > MAX_BYTES) throw Error("Plugin package exceeds 5 MB");
  const pkg = JSON.parse(raw), { manifest: m, files, publicKey, signature } = pkg;
  if (Object.keys(pkg).sort().join() !== "files,manifest,publicKey,signature") throw Error("Invalid plugin package fields");
  if (!m || m.schema !== 1 || m.apiVersion !== 1 || !safeId(m.id) || (typeof m.version !== "string" || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(m.version)) || typeof m.name !== "string" || !m.name.trim() || m.name.length > 100) throw Error("Invalid or incompatible plugin manifest");
  if (Object.keys(m).some(k => !["schema", "apiVersion", "id", "version", "name", "description", "entry", "permissions"].includes(k))) throw Error("Unknown manifest field");
  if (m.description !== undefined && (typeof m.description !== "string" || m.description.length > 1000)) throw Error("Invalid description");
  if (!Array.isArray(m.permissions) || new Set(m.permissions).size !== m.permissions.length || m.permissions.some(p => !PERMISSIONS.includes(p))) throw Error("Unsupported plugin permission");
  if (!files || Array.isArray(files) || typeof files !== "object" || Object.keys(files).length < 1 || Object.keys(files).length > 100) throw Error("Invalid plugin files");
  const lower = new Set();
  for (const [name, content] of Object.entries(files)) {
    if (!safeFile(name) || lower.has(name.toLowerCase()) || typeof content !== "string") throw Error("Invalid or duplicate plugin file");
    lower.add(name.toLowerCase());
  }
  if (!safeFile(m.entry) || !m.entry.endsWith(".html") || !Object.hasOwn(files, m.entry)) throw Error("Plugin entry is missing");
  if (typeof publicKey !== "string" || publicKey.length > 200 || typeof signature !== "string" || signature.length > 200) throw Error("Invalid publisher signature");
  const key = crypto.createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519" || !crypto.verify(null, Buffer.from(canonical({ manifest: m, files })), key, Buffer.from(signature, "base64"))) throw Error("Plugin signature verification failed");
  const fingerprint = crypto.createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex");
  return { package: pkg, fingerprint, manifest: m };
}
module.exports = { canonical, safeId, safeFile, verifyPackage, MAX_BYTES, PERMISSIONS };
