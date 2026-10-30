"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { canonical, fingerprint, packageDigest, verifyRegistry, validateCatalog, validateEntry, compareVersions, verifyRegistryPackage, downloadRegistry, RegistryClient, MAX_REGISTRY_BYTES } = require("../lib/plugins/registry");
const { signingPayload } = require("../lib/plugins/package");
const keys = crypto.generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), trust = fingerprint(keys.publicKey);
const now = Date.parse("2026-10-30T00:00:00.000Z"), options = { now, trustedFingerprint: trust };
function plugin({ id = "example.test", permissions = ["models.read"], version = "1.0.0", name = "Example" } = {}) {
  const manifest = { schema: 2, apiVersion: 3, runtime: "sandboxed", id, name, version, description: "Example plugin", entry: "index.html", permissions }, files = { "index.html": "<h1>Example</h1>" };
  return { manifest, files, publicKey, signature: crypto.sign(null, Buffer.from(signingPayload(manifest, files)), keys.privateKey).toString("base64") };
}
function entry(pkg = plugin()) { const m = pkg.manifest; return { id: m.id, name: m.name, description: m.description, version: m.version, apiVersion: m.apiVersion, minCoreVersion: "0.7.0", repository: "example/plugin", url: `https://github.com/example/plugin/releases/download/v${m.version}/example.kaiplugin`, publicKey, fingerprint: trust, sha256: packageDigest(pkg), permissions: m.permissions }; }
function catalog(changes = {}) { return { schema: 1, version: "0.1.0", sequence: 1, generatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 86400000).toISOString(), plugins: [entry()], ...changes }; }
function signed(c = catalog(), key = keys.privateKey) { return { catalog: c, publicKey: crypto.createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64"), signature: crypto.sign(null, Buffer.from(canonical(c)), key).toString("base64") }; }
function fixture(t, download, settings = {}) { const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-registry-")); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true })); return new RegistryClient({ dataDir, coreVersion: "0.7.0", now: () => now, trustedFingerprint: trust, download: download || (async () => signed()), ...settings }); }
test("registry pins the catalog publisher and rejects signed data tampering", () => {
  assert.equal(verifyRegistry(signed(), options).catalog.plugins.length, 1);
  assert.throws(() => verifyRegistry(signed()), /not trusted/);
  const tampered = signed(); tampered.catalog.plugins[0].url = "https://github.com/example/plugin/releases/download/v1.0.0/tampered.kaiplugin";
  assert.throws(() => verifyRegistry(tampered, options), /signature/);
  assert.throws(() => verifyRegistry(signed(catalog(), crypto.generateKeyPairSync("ed25519").privateKey), options), /not trusted/);
  assert.throws(() => verifyRegistry({ ...signed(), unknown: true }, options), /fields/);
  assert.throws(() => verifyRegistry({ ...signed(), signature: "" }, options), /signature/);
  assert.throws(() => verifyRegistry("x".repeat(MAX_REGISTRY_BYTES + 1), options), /1 MB/);
});
test("registry metadata rejects duplicate IDs, invalid types, publisher confusion and mutable URLs", () => {
  for (const changes of [{ schema: 2 }, { sequence: 0 }, { sequence: 1.5 }, { version: ["0.1.0"] }, { plugins: [entry(), entry()] }, { plugins: new Array(501).fill(entry()) }, { plugins: {} }]) assert.throws(() => validateCatalog(catalog(changes), options));
  for (const changes of [{ id: "../escape" }, { version: ["1.0.0"] }, { minCoreVersion: "01.0.0" }, { name: "bad\nname" }, { apiVersion: 4 }, { fingerprint: "0".repeat(64) }, { sha256: ["a".repeat(64)] }, { permissions: ["models.read", "models.read"] }, { permissions: ["../escape"] }, { repository: "x/../../y" }, { url: "http://github.com/example/plugin/releases/download/v1.0.0/x.kaiplugin" }, { url: "https://github.com@example.com/example/plugin/releases/download/v1.0.0/x.kaiplugin" }, { url: "https://github.com/example/plugin/releases/latest/download/x.kaiplugin" }, { url: "https://github.com/example/other/releases/download/v1.0.0/x.kaiplugin" }, { url: "https://github.com/example/plugin/releases/download/v1.0.0/../x.kaiplugin" }, { url: "https://github.com/example/plugin/releases/download/v1.0.0/x.kaiplugin?token=secret" }, { unexpected: true }]) assert.throws(() => validateEntry({ ...entry(), ...changes }), JSON.stringify(changes));
});
test("registry validity bounds and compatibility compare numeric version components", () => {
  assert.equal(compareVersions("0.10.0", "0.3.0"), 1); assert.equal(compareVersions("0.3.0", "0.3.0"), 0); assert.equal(compareVersions("1.0.0", "2.0.0"), -1);
  assert.throws(() => compareVersions(["1.0.0"], "1.0.0"));
  for (const changes of [{ generatedAt: new Date(now + 3600000).toISOString() }, { expiresAt: new Date(now).toISOString() }, { expiresAt: new Date(now + 367 * 86400000).toISOString() }, { generatedAt: "bad" }]) assert.throws(() => verifyRegistry(signed(catalog(changes)), options));
  const expired = signed(catalog({ generatedAt: new Date(now - 86400000).toISOString(), expiresAt: new Date(now - 1).toISOString() }));
  assert.throws(() => verifyRegistry(expired, options), /expired/); assert.equal(verifyRegistry(expired, { ...options, allowExpired: true }).catalog.sequence, 1);
});
test("registry package pin binds verified content, metadata, publisher and grants", () => {
  const pkg = plugin(), row = entry(pkg); assert.equal(verifyRegistryPackage(row, pkg).manifest.id, "example.test");
  assert.equal(packageDigest(pkg), packageDigest(JSON.parse(JSON.stringify(pkg, null, 2))));
  for (const changes of [{ name: "Misleading" }, { description: "Changed" }, { version: "2.0.0", url: "https://github.com/example/plugin/releases/download/v2.0.0/x.kaiplugin" }, { permissions: ["inference.local"] }, { sha256: "0".repeat(64) }, { apiVersion: 1 }]) assert.throws(() => verifyRegistryPackage({ ...row, ...changes }, pkg), /does not match/);
  assert.equal(verifyRegistryPackage(entry(plugin({ id: "kai.brain" })), plugin({ id: "kai.brain" })).manifest.id, "kai.brain");
  assert.throws(() => verifyRegistryPackage(entry(plugin({ permissions: ["brain.read"] })), plugin({ permissions: ["brain.read"] })), /permissions/);
  const altered = structuredClone(pkg); altered.files["index.html"] += "tamper"; assert.throws(() => verifyRegistryPackage(row, altered), /signature/);
});
test("registry cache starts empty, refreshes explicitly and survives restart", async t => {
  let downloads = 0; const client = fixture(t, async () => { downloads++; return signed(); });
  assert.equal(client.status().present, false); assert.equal(client.status().available, false); assert.deepEqual(client.list(), []); assert.equal(downloads, 0);
  await client.refresh(); assert.equal(downloads, 1); assert.equal(client.status().present, true); assert.equal(client.status().available, true); assert.equal(client.list()[0].compatible, true);
  assert.equal(client.entry("example.test").sha256, entry().sha256);
  const reopened = new RegistryClient({ dataDir: path.dirname(client.root), coreVersion: "0.1.0", now: () => now, trustedFingerprint: trust });
  assert.equal(reopened.list()[0].compatible, false); assert.match(reopened.list()[0].compatibilityReason, /0.7.0/); assert.throws(() => reopened.entry("example.test"), /0.7.0/);
  assert.throws(() => client.entry("absent.plugin"), /not listed/);
});
test("registry cache rejects rollback and same-sequence equivocation without discarding good data", async t => {
  let next = signed(catalog({ sequence: 2, version: "0.2.0" })); const client = fixture(t, async () => next);
  await client.refresh(); const saved = fs.readFileSync(client.file, "utf8");
  for (const changes of [{ sequence: 1 }, { sequence: 3, version: "0.1.0" }, { sequence: 2, plugins: [] }, { sequence: 3, generatedAt: new Date(now - 1000).toISOString() }]) {
    next = signed(catalog({ sequence: 2, version: "0.2.0", ...changes })); await assert.rejects(client.refresh(), /rollback|sequence/); assert.equal(fs.readFileSync(client.file, "utf8"), saved);
  }
  next = signed(catalog({ sequence: 3, version: "0.3.0", plugins: [] })); await client.refresh(); assert.deepEqual(client.list(), []); assert.throws(() => client.entry("example.test"), /not listed/);
});
test("expired registry remains inspectable but cannot install until a fresh signed refresh", async t => {
  let clock = now; const client = fixture(t, undefined, { now: () => clock }); await client.refresh(); clock += 31 * 86400000;
  assert.equal(client.status().present, true); assert.equal(client.status().expired, true); assert.equal(client.status().available, false); assert.deepEqual(client.list(), []); assert.throws(() => client.entry("example.test"), /expired/);
});
test("failed, local-only and cancelled refreshes preserve cache", async t => {
  let bad = false; const client = fixture(t, async (_url, { signal }) => { if (bad) throw Error("offline"); signal.throwIfAborted(); return signed(); });
  await client.refresh(); const saved = fs.readFileSync(client.file, "utf8");
  await assert.rejects(client.refresh({ localOnly: true }), /local-only/); bad = true; await assert.rejects(client.refresh(), /offline/);
  assert.equal(client.status().available, true); assert.equal(client.status().error, "offline"); assert.equal(fs.readFileSync(client.file, "utf8"), saved);
  bad = false; const controller = new AbortController(); controller.abort(); await assert.rejects(client.refresh({ signal: controller.signal })); assert.equal(fs.readFileSync(client.file, "utf8"), saved);
});
test("invalid or externally changed cache is never silently replaced", async t => {
  const client = fixture(t); await client.refresh(); fs.writeFileSync(client.file, "broken");
  assert.equal(client.status().present, true); assert.equal(client.status().available, false); assert.deepEqual(client.list(), []); await assert.rejects(client.refresh()); assert.equal(fs.readFileSync(client.file, "utf8"), "broken");
  fs.rmSync(client.file); client.download = async () => { fs.writeFileSync(client.file, JSON.stringify(signed(catalog({ sequence: 2 })))); return signed(); };
  await assert.rejects(client.refresh(), /changed outside/); assert.equal(JSON.parse(fs.readFileSync(client.file)).catalog.sequence, 2);
});
test("registry cache refuses symlink and hardlink targets", async t => {
  const client = fixture(t); fs.mkdirSync(client.root); const external = path.join(path.dirname(client.root), "external.json"); fs.writeFileSync(external, JSON.stringify(signed()));
  fs.linkSync(external, client.file); await assert.rejects(client.refresh(), /Unsafe/); fs.unlinkSync(client.file);
  try { fs.symlinkSync(external, client.file); } catch (error) { if (error.code === "EPERM") return t.skip("Symlink privilege unavailable"); throw error; }
  await assert.rejects(client.refresh(), /Unsafe/); assert.equal(JSON.parse(fs.readFileSync(external)).catalog.sequence, 1);
});
test("registry downloads pin public DNS per redirect and verify signed body", async () => {
  const requests = []; const envelope = await downloadRegistry("https://github.com/example/registry", { ...options, lookup: async () => [{ address: "8.8.8.8", family: 4 }], request: async (url, settings) => { requests.push({ url, settings }); if (requests.length === 1) return new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/asset" } }); return new Response(JSON.stringify(signed())); } });
  assert.equal(envelope.catalog.plugins.length, 1); assert.equal(requests.length, 2); assert.deepEqual(requests[1].settings.addresses, [{ address: "8.8.8.8", family: 4 }]);
});
test("registry downloads refuse private targets, redirects, oversized bodies and unsigned catalogs", async () => {
  const publicOptions = { ...options, lookup: async () => [{ address: "8.8.8.8", family: 4 }] };
  for (const url of ["http://example.com/x", "https://u:p@example.com/x", "https://example.com:123/x", "https://127.0.0.1/x"]) await assert.rejects(downloadRegistry(url, { ...publicOptions, request: async () => { throw Error("Should not request"); } }), /HTTPS|public|private/);
  await assert.rejects(downloadRegistry("https://example.com/x", { ...publicOptions, request: async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/x" } }) }), /public|private/);
  await assert.rejects(downloadRegistry("https://example.com/x", { ...publicOptions, request: async () => new Response("x".repeat(MAX_REGISTRY_BYTES + 1)) }), /1 MB/);
  await assert.rejects(downloadRegistry("https://example.com/x", { ...publicOptions, request: async () => new Response(JSON.stringify(catalog())) }), /fields/);
});

test("legacy API catalogs remain readable but cannot offer incompatible packages", async t => {
 const c=catalog(); c.plugins[0].apiVersion=2; const client=fixture(t,async()=>signed(c)); await client.refresh(); assert.equal(client.list()[0].compatible,false); assert.match(client.list()[0].compatibilityReason,/API 3/); assert.throws(()=>client.entry("example.test"),/API 3/);
});
