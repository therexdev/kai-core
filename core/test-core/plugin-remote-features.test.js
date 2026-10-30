"use strict";
// Synthetic publisher only: exercise the production verifier/manager with a
// fixture publisher pin. No maintainer private key or user profile is loaded.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), vm = require("node:vm");
const { createRequire } = require("node:module");
const { FeatureServices } = require("../../electron/plugin-services"), { JsonStore } = require("../lib/store"), { ApiKeys } = require("../lib/keys");
const root = path.resolve(__dirname, "../.."), ID = "kai.remote-access", retired = "remote-access.features";
const grants = ["remote-access.read", "remote-access.control", "remote-access.keys", "desktop.preferences"];
function fixture(t) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-retired-remote-")));
  const key = crypto.generateKeyPairSync("ed25519"), der = key.publicKey.export({ format: "der", type: "spki" }), fingerprint = crypto.createHash("sha256").update(der).digest("hex");
  const publisher = { id: ID, fingerprint };
  function load(file, replacements) {
    const filename = path.join(root, file), nativeRequire = createRequire(filename), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, exports: module.exports, Buffer, structuredClone, require: name => replacements[name] || nativeRequire(name) }, { filename });
    return module.exports;
  }
  const verifier = load("core/lib/plugins/package.js", { "./first-party.json": { plugins: [publisher] } });
  const { PluginManager } = load("core/lib/plugins/manager.js", { "./package": verifier });
  const manager = new PluginManager(dataDir);
  function pkg(version, permissions = grants, id = ID, privateKey = key.privateKey) {
    const manifest = { schema: 1, apiVersion: 2, id, name: "Synthetic Remote Access", version, entry: "index.html", permissions };
    const files = { "index.html": "<p>Synthetic fixture</p>" };
    return { manifest, files, publicKey: crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64"), signature: crypto.sign(null, Buffer.from(verifier.canonical({ manifest, files })), privateKey).toString("base64") };
  }
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, publisher, manager, verifier, pkg };
}

test("retired Remote grant keeps old signed installs and rollback readable without restoring its operation", async t => {
  const f = fixture(t), old = f.pkg("0.2.0", [...grants, retired]);
  f.manager.install(old); f.manager.storage(ID, "set", "preserved", "saved settings");
  assert.equal(f.manager.load(ID).manifest.version, "0.2.0");
  f.manager.install(f.pkg("0.2.1")); f.manager.change(ID, "rollback");
  assert.equal(f.manager.load(ID).manifest.version, "0.2.0");
  assert.equal(f.manager.storage(ID, "get", "preserved"), "saved settings");
  const broker = new FeatureServices({}, { publishers: [f.publisher] });
  assert.equal(broker.permission("remote.features"), null);
  await assert.rejects(broker.call({ ...f.manager.load(ID), controller: new AbortController() }, "remote.features", { action: "toggle", feature: "code", enabled: true }), /permission denied/);
  assert.equal(broker.services.size, 0); await broker.dispose();
});

test("retired grant cannot be requested by newer releases, another plugin, or an untrusted publisher", t => {
  const f = fixture(t);
  assert.equal(f.verifier.verifyPackage(f.pkg("0.2.1")).manifest.version, "0.2.1");
  assert.throws(() => f.verifier.verifyPackage(f.pkg("0.2.1", [...grants, retired])), /Private feature permissions/);
  assert.throws(() => f.verifier.verifyPackage(f.pkg("0.2.0", [retired], "community.remote")), /Private feature permissions/);
  assert.throws(() => f.verifier.verifyPackage(f.pkg("0.2.0", [retired], ID, crypto.generateKeyPairSync("ed25519").privateKey)), /matching verified KAI publisher/);
});

test("narrow Remote grant resumes the saved relay at startup and never enters another app broker", async t => {
  const f = fixture(t), settings = new JsonStore(path.join(f.dataDir, "settings.json"), { remote: { enabled: true }, code: { enabled: true }, developer: { enabled: true }, koinosNode: { keep: "original data" } });
  const keys = new ApiKeys(settings); keys.create({ name: "Existing client" });
  let starts = 0, stops = 0, crossAppCalls = 0, enabled = false;
  const broker = new FeatureServices({ dataDir: f.dataDir, core: { settings, keys, models: { aliases: () => [] }, gateway: { port: 41100, network: { status: () => ({ privacyMode: "local-first" }) } } }, getWindow: () => ({}),
    featureCall: () => { crossAppCalls++; throw Error("Unexpected cross-app call"); }, openCoreView: () => { crossAppCalls++; },
    originalRemoteFactory: () => ({ start: async () => { starts++; enabled = true; }, stop: () => { stops++; enabled = false; settings.set("remote.enabled", false); }, status: () => ({ enabled, state: enabled ? "connected" : "off" }), drain: async () => {} }),
  }, { publishers: [f.publisher] });
  f.manager.install(f.pkg("0.2.1"));
  await broker.startInstalledBackground(f.manager);
  assert.equal(starts, 1); assert.equal(broker.backgroundErrors.has(ID), false);
  const record = { ...f.manager.load(ID), controller: new AbortController() };
  const state = await broker.call(record, "remote.api", { action: "status" });
  assert.equal(state.remote.enabled, true); assert.equal(state.keys.length, 1);
  for (const feature of ["node", "developer", "code"]) await assert.rejects(broker.call(record, "remote.features", { action: "open", feature }), /permission denied/);
  assert.equal(crossAppCalls, 0); await broker.dispose(); assert.equal(stops, 1);
  assert.equal(settings.get("remote.enabled"), true, "shutdown preserves saved relay intent");
  assert.equal(settings.get("code.enabled"), true); assert.equal(settings.get("developer.enabled"), true); assert.equal(settings.get("koinosNode.keep"), "original data");
});
