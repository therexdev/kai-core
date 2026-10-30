"use strict";
const crypto = require("node:crypto");
const MAX_REGISTRY_BYTES = 1024 * 1024;
const REGISTRY_FINGERPRINT = "c0f3c78f6e5a04d9ff4a4d8702ac8e2a66a7f9f0cad3287c46a80823304be440";
const REGISTRY_URL = "https://github.com/therexdev/kai-plugin-registry/releases/latest/download/registry.json";
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function object(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function fields(value, expected) { return object(value) && Object.keys(value).sort().join() === [...expected].sort().join(); }
function safeId(value) { return typeof value === "string" && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(value) && value.length <= 100 && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value); }
function text(value, max, empty = false) { return typeof value === "string" && value.length <= max && (empty || !!value.trim()) && !/[\u0000-\u001f\u007f]/.test(value); }
function publicKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{59}=$/.test(value)) throw Error("Invalid registry publisher key");
  const key = crypto.createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519" || key.export({ format: "der", type: "spki" }).toString("base64") !== value) throw Error("Invalid registry publisher key");
  return key;
}
function fingerprint(key) { return crypto.createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex"); }
function packageDigest(pkg) { return crypto.createHash("sha256").update(canonical(pkg)).digest("hex"); }
function compareVersions(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !VERSION.test(a) || !VERSION.test(b)) throw Error("Invalid Core version");
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
function validateEntry(entry) {
  if (!fields(entry, ["id", "name", "description", "version", "apiVersion", "minCoreVersion", "repository", "url", "publicKey", "fingerprint", "sha256", "permissions"])) throw Error("Invalid registry entry fields");
  if (!safeId(entry.id) || !text(entry.name, 100) || !text(entry.description, 1000, true) || typeof entry.version !== "string" || !VERSION.test(entry.version) || typeof entry.minCoreVersion !== "string" || !VERSION.test(entry.minCoreVersion) || ![1, 2].includes(entry.apiVersion)) throw Error("Invalid registry plugin metadata");
  if (typeof entry.repository !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(entry.repository) || entry.repository.endsWith("/.") || entry.repository.endsWith("/..")) throw Error("Invalid registry repository");
  const prefix = `https://github.com/${entry.repository}/releases/download/v${entry.version}/`;
  if (typeof entry.url !== "string" || !entry.url.startsWith(prefix) || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,179}\.kaiplugin$/.test(entry.url.slice(prefix.length))) throw Error("Registry packages require an immutable GitHub release URL matching their repository and version");
  if (typeof entry.fingerprint !== "string" || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.fingerprint) || !/^[a-f0-9]{64}$/.test(entry.sha256) || fingerprint(publicKey(entry.publicKey)) !== entry.fingerprint) throw Error("Registry publisher fingerprint mismatch");
  if (!Array.isArray(entry.permissions) || entry.permissions.length > 30 || new Set(entry.permissions).size !== entry.permissions.length || entry.permissions.some(p => !text(p, 80) || !/^[a-z][a-z0-9-]*\.[a-z][a-zA-Z0-9-]*$/.test(p))) throw Error("Invalid registry permissions");
  return entry;
}
function validateCatalog(catalog, { now = Date.now(), allowExpired = false } = {}) {
  if (!fields(catalog, ["schema", "version", "sequence", "generatedAt", "expiresAt", "plugins"]) || catalog.schema !== 1 || typeof catalog.version !== "string" || !VERSION.test(catalog.version) || !Number.isSafeInteger(catalog.sequence) || catalog.sequence < 1 || !Array.isArray(catalog.plugins) || catalog.plugins.length > 500) throw Error("Invalid registry catalog");
  const created = Date.parse(catalog.generatedAt), expires = Date.parse(catalog.expiresAt);
  if (typeof catalog.generatedAt !== "string" || typeof catalog.expiresAt !== "string" || !Number.isFinite(created) || !Number.isFinite(expires) || new Date(created).toISOString() !== catalog.generatedAt || new Date(expires).toISOString() !== catalog.expiresAt || created > now + 5 * 60 * 1000 || expires <= created || expires - created > 366 * 24 * 60 * 60 * 1000) throw Error("Invalid registry validity period");
  if (!allowExpired && expires <= now) throw Error("Plugin registry has expired; refresh it before installing");
  const ids = new Set();
  for (const entry of catalog.plugins) {
    validateEntry(entry);
    if (ids.has(entry.id)) throw Error("Duplicate plugin in registry");
    ids.add(entry.id);
  }
  return catalog;
}
function verifyRegistry(input, { trustedFingerprint = REGISTRY_FINGERPRINT, ...options } = {}) {
  const raw = typeof input === "string" ? input : JSON.stringify(input);
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_REGISTRY_BYTES) throw Error("Plugin registry exceeds 1 MB");
  const envelope = JSON.parse(raw);
  if (!fields(envelope, ["catalog", "publicKey", "signature"])) throw Error("Invalid signed registry fields");
  const key = publicKey(envelope.publicKey);
  if (fingerprint(key) !== trustedFingerprint) throw Error("Plugin registry publisher is not trusted");
  if (typeof envelope.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature) || !crypto.verify(null, Buffer.from(canonical(envelope.catalog)), key, Buffer.from(envelope.signature, "base64"))) throw Error("Plugin registry signature verification failed");
  validateCatalog(envelope.catalog, options);
  return envelope;
}
module.exports = { canonical, MAX_REGISTRY_BYTES, REGISTRY_FINGERPRINT, REGISTRY_URL, VERSION, safeId, publicKey, fingerprint, packageDigest, compareVersions, validateEntry, validateCatalog, verifyRegistry };
