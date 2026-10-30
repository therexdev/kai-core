"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { inspectProfile, prepareProfile } = require("../lib/core-profile");
const { channelConfig, configureDesktop, configureUpdater } = require("../lib/release-channel");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-core-profile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, content) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content)); };
  return { root, put };
}
function symlink(t, target, link, type) { try { fs.symlinkSync(target, link, type); return true; } catch (e) { if (["EPERM", "EACCES"].includes(e.code)) { t.skip("OS does not permit test symlinks"); return false; } throw e; } }
test("new profile inspection has no writes or invented wallet", t => {
  const f = fixture(t), data = path.join(f.root, "new-profile");
  const result = prepareProfile(data, "0.1.0");
  assert.equal(result.mode, "new"); assert.equal(result.backup, null); assert.equal(result.preserved.wallet, false); assert.equal(fs.existsSync(data), false);
});
test("backup preserves encrypted identity and config, reuses model and node paths without moving files", t => {
  const f = fixture(t);
  f.put("wallet/wallet.json", { address: "saved-wallet", encrypted: "ciphertext" }); f.put("wallet/session.bin", Buffer.from([1, 2, 3, 4]));
  f.put("machine-secret.bin", Buffer.from([5, 6, 7])); f.put("settings.json", { network: { privacyMode: "local-only" } });
  f.put("state.json", { models: { external: "/existing/model.gguf" } }); f.put("companion-hub.json", { encrypted: "brain-and-workflows" });
  f.put("agent-network.json", { encrypted: "service-identity" }); f.put("credit-account-test.cfg", "encrypted-account");
  f.put("koin-prepaid-usd-v1/journals/pending.json", { pending: true }); f.put("koinos-node/settings.json", { nodeDataPath: "/existing/node" });
  f.put("models/large.gguf", "weights"); f.put("runtimes/llama-server", "binary"); f.put("ollama-models/model.bin", "weights2");
  f.put("chats/saved.json", { title: "untouched" }); f.put("docs/doc.json", { text: "untouched" }); f.put("koinos-node/node/mainnet/state.json", { large: true });
  const before = fs.statSync(path.join(f.root, "models/large.gguf"));
  const r = prepareProfile(f.root, "0.1.0");
  assert.equal(r.mode, "existing"); assert.equal(r.dataDir, f.root); assert.equal(r.modelsReused, true);
  assert.deepEqual(r.preserved, { wallet: true, chats: true, workflowsAndBrain: true, agentNetwork: true, node: true });
  const m = JSON.parse(fs.readFileSync(path.join(r.backup, "manifest.json")));
  for (const file of ["wallet/wallet.json", "wallet/session.bin", "machine-secret.bin", "companion-hub.json", "agent-network.json", "settings.json", "state.json", "credit-account-test.cfg", "koin-prepaid-usd-v1/journals/pending.json", "koinos-node/settings.json"]) {
    assert.ok(m.files.some(row => row.path === file), file);
    assert.deepEqual(fs.readFileSync(path.join(f.root, file)), fs.readFileSync(path.join(r.backup, file)));
  }
  assert.ok(m.files.every(row => !/^(models|runtimes|ollama-models|chats|docs)\//.test(row.path) && !row.path.startsWith("koinos-node/node/")));
  assert.equal(fs.statSync(path.join(f.root, "models/large.gguf")).ino, before.ino);
  assert.equal(fs.readFileSync(path.join(f.root, "models/large.gguf"), "utf8"), "weights");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(r.backup, "wallet/session.bin")).mode & 0o777, 0o600);
});
test("same-version backup is verified and reused without overwriting older bytes", t => {
  const f = fixture(t); f.put("settings.json", { original: true });
  const a = prepareProfile(f.root, "0.1.0"); f.put("settings.json", { later: true });
  const b = prepareProfile(f.root, "0.1.0");
  assert.equal(a.backup, b.backup);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.backup, "settings.json"))), { original: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, "settings.json"))), { later: true });
});
test("tampered or incomplete backup blocks opening instead of creating false assurance", t => {
  const f = fixture(t); f.put("settings.json", { original: true }); const a = prepareProfile(f.root, "0.1.0");
  fs.writeFileSync(path.join(a.backup, "settings.json"), "{\"original\":false}");
  assert.throws(() => prepareProfile(f.root, "0.1.0"), /verification failed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, "settings.json"))), { original: true });
});
for (const file of ["settings.json", "state.json", "wallet/wallet.json"]) test(`corrupt ${file} is never reset`, t => {
  const f = fixture(t); f.put(file, "{broken");
  assert.throws(() => prepareProfile(f.root, "0.1.0"), /cannot be read/);
  assert.equal(fs.readFileSync(path.join(f.root, file), "utf8"), "{broken");
  assert.equal(fs.existsSync(path.join(f.root, "core-profile-backups")), false);
});
test("unrecognized wallet and non-object critical configuration are rejected", t => {
  const f = fixture(t); f.put("wallet/wallet.json", { value: "no address" });
  assert.throws(() => inspectProfile(f.root), /wallet is invalid/);
  f.put("wallet/wallet.json", { address: "known" }); f.put("state.json", []);
  assert.throws(() => inspectProfile(f.root), /state.json is invalid/);
});
test("invalid backup version cannot escape the profile", t => {
  const f = fixture(t);
  for (const v of ["../escape", "./0", "a/b", "a\\b", "", "."]) assert.throws(() => prepareProfile(f.root, v), /Invalid backup version/);
});
test("profile symlinks including dangling links are not treated as new profiles", t => {
  const f = fixture(t), target = path.join(f.root, "missing"), link = path.join(f.root, "linked");
  if (!symlink(t, target, link, "dir")) return;
  assert.throws(() => inspectProfile(link), /real directory/); assert.equal(fs.existsSync(target), false);
});
test("wallet directory symlink cannot read or migrate another wallet", t => {
  const f = fixture(t); f.put("other/wallet.json", { address: "another" });
  if (!symlink(t, path.join(f.root, "other"), path.join(f.root, "wallet"), "dir")) return;
  assert.throws(() => prepareProfile(f.root, "0.1.0"), /real directory/);
});
test("a wallet file symlink is rejected before creating a backup", t => {
  const f = fixture(t); f.put("outside.json", { address: "another" }); fs.mkdirSync(path.join(f.root, "wallet"));
  if (!symlink(t, path.join(f.root, "outside.json"), path.join(f.root, "wallet/wallet.json"), "file")) return;
  assert.throws(() => prepareProfile(f.root, "0.1.0"), /regular file/);
  assert.equal(fs.existsSync(path.join(f.root, "core-profile-backups")), false);
});
test("backup directory and manifest symlinks cannot bypass verification", t => {
  const f = fixture(t); f.put("settings.json", {}); fs.mkdirSync(path.join(f.root, "other"));
  if (!symlink(t, path.join(f.root, "other"), path.join(f.root, "core-profile-backups"), "dir")) return;
  assert.throws(() => prepareProfile(f.root, "0.1.0"), /real directory/);
  assert.deepEqual(fs.readdirSync(path.join(f.root, "other")), []);
});
test("configuration symlinks fail with temporary backup cleanup", t => {
  const f = fixture(t); f.put("settings.json", {}); f.put("original.cfg", "secret");
  if (!symlink(t, path.join(f.root, "original.cfg"), path.join(f.root, "linked.cfg"), "file")) return;
  assert.throws(() => prepareProfile(f.root, "0.1.0"), /symbolic link/);
  assert.deepEqual(fs.readdirSync(path.join(f.root, "core-profile-backups")), []);
});
test("models and node database links remain in place and are not traversed", t => {
  const f = fixture(t); f.put("settings.json", {}); f.put("koinos-node/settings.json", {});
  const missing = path.join(f.root, "missing-large-data");
  if (!symlink(t, missing, path.join(f.root, "models"), "dir")) return;
  if (!symlink(t, missing, path.join(f.root, "koinos-node/node"), "dir")) return;
  const r = prepareProfile(f.root, "0.1.0"); assert.equal(r.modelsReused, true);
  assert.equal(fs.lstatSync(path.join(f.root, "models")).isSymbolicLink(), true);
  assert.equal(fs.existsSync(missing), false);
});
test("malformed backup file entries cannot traverse out of a backup", t => {
  const f = fixture(t); f.put("settings.json", {}); const r = prepareProfile(f.root, "0.1.0");
  const manifest = path.join(r.backup, "manifest.json"), m = JSON.parse(fs.readFileSync(manifest));
  m.files[0].path = "../../../settings.json"; fs.writeFileSync(manifest, JSON.stringify(m));
  assert.throws(() => prepareProfile(f.root, "0.1.0"), /Invalid profile backup path/);
});
test("oversized config stops backup without touching source", t => {
  const f = fixture(t); const file = path.join(f.root, "oversized.bin"); const fd = fs.openSync(file, "w"); fs.ftruncateSync(fd, 32 * 1024 * 1024 + 1); fs.closeSync(fd);
  assert.throws(() => prepareProfile(f.root, "0.1.0"), /size limit/);
  assert.equal(fs.statSync(file).size, 32 * 1024 * 1024 + 1); assert.deepEqual(fs.readdirSync(path.join(f.root, "core-profile-backups")), []);
});
test("Core keeps credential/profile/port identity while installer identity is distinct", () => {
  const core = channelConfig("core"), live = channelConfig("stable"), test = channelConfig("test");
  assert.notEqual(core.appId, live.appId); assert.notEqual(core.appId, test.appId); assert.equal(core.productName, "KAI Core");
  for (const k of ["port", "ollamaPort", "homeDirName"]) { assert.equal(core[k], live[k]); assert.equal(core[k], test[k]); }
  const paths = { appData: path.join(os.tmpdir(), "platform-profile"), userData: "new-default", sessionData: "new-default" }; let name, appId;
  configureDesktop({ setName: n => name = n, getPath: k => paths[k], setPath: (k, v) => paths[k] = v, setAppUserModelId: id => appId = id }, core);
  assert.equal(name, "Koinos AI"); assert.equal(paths.userData, path.join(paths.appData, "Koinos AI")); assert.equal(paths.sessionData, paths.userData);
  if (process.platform === "win32") assert.equal(appId, core.appId);
});
test("Core updater cannot use Alpha or Test feeds or enable downgrades", () => {
  const updater = { setFeedURL(value) { this.feed = value; }, set channel(value) { this._channel = value; this.allowDowngrade = true; } };
  configureUpdater(updater, channelConfig("core"));
  assert.equal(updater.feed.repo, "kai-core"); assert.equal(updater.feed.owner, "therexdev"); assert.equal(updater._channel, "latest");
  assert.equal(updater.allowPrerelease, false); assert.equal(updater.allowDowngrade, false);
});
test("reused backup rejects a symlinked manifest", t => {
  const f = fixture(t); f.put("settings.json", {}); const r = prepareProfile(f.root, "0.1.0");
  const manifest = path.join(r.backup, "manifest.json"), original = fs.readFileSync(manifest);
  f.put("external.cfg", original); fs.unlinkSync(manifest);
  if (!symlink(t, path.join(f.root, "external.cfg"), manifest, "file")) return;
  assert.throws(() => prepareProfile(f.root, "0.1.0"), /regular file/);
});
test("coding workspace files are retained rather than included in config backups", t => {
  const f = fixture(t); f.put("workspace/project/node_modules/deep/package/structure/test/package.json", { name: "dependency" }); f.put("settings.json", {});
  const r = prepareProfile(f.root, "0.1.0");
  assert.equal(fs.existsSync(path.join(r.backup, "workspace")), false);
  assert.equal(fs.existsSync(path.join(f.root, "workspace/project/node_modules/deep/package/structure/test/package.json")), true);
});
