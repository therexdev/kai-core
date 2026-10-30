"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { Signer } = require("koilib");
const { encryptKeystore } = require("../lib/keystore");
const { WalletService } = require("../lib/wallet");
const { createAlphaMigration } = require("../../electron/alpha-migration");

const password = "synthetic Alpha password", privateKeyHex = "19".repeat(32);
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); }
function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-alpha-migration-")));
  const dataDir = path.join(root, "foundation"), appData = path.join(root, "appData"), homeDir = path.join(root, "home");
  const sourceDir = path.join(appData, "Koinos AI", "core"), sourceFile = path.join(sourceDir, "wallet", "wallet.json");
  fs.mkdirSync(dataDir); fs.mkdirSync(homeDir); fs.mkdirSync(sourceDir, { recursive: true });
  const signer = new Signer({ privateKey: privateKeyHex, compressed: options.compressed !== false });
  const keystore = encryptKeystore({ privateKeyHex, address: signer.getAddress(), password });
  keystore.compressed = options.compressed !== false;
  keystore.ethAddress = "0x" + "ab".repeat(20);
  if (!options.noWallet) write(sourceFile, { ...keystore, pwHint: "obsolete-private-hint", arbitraryMetadata: "not imported" });
  const wallet = new WalletService(path.join(dataDir, "wallet"));
  const calls = [], models = { catalog: { packages: {} } };
  let chosen = options.chosen ?? sourceDir;
  const service = createAlphaMigration({ dataDir, appData, homeDir, models, wallet,
    withWalletSpend: options.withWalletSpend || (run => run()), chooseDirectory: async () => chosen }, {
    inspectModels: options.inspectModels || (() => ({ count: 1, bytes: 12, warnings: [] })),
    copyModels: options.copyModels || (async input => { calls.push(input); input.onProgress({ completedBytes: 12, totalBytes: 12, detail: "Copied synthetic model" }); return { copied: 1, skipped: 0, failed: 0, bytes: 12, models: [], warnings: [] }; }),
  });
  t.after(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dataDir, appData, homeDir, sourceDir, sourceFile, keystore, wallet, models, service, calls,
    destinationFile: path.join(dataDir, "wallet", "wallet.json"), choose(value) { chosen = value; } };
}
async function finished(service) {
  const deadline = Date.now() + 5000;
  while (service.running && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.running, false, "migration must settle"); return service.status();
}
function assertNoSecrets(value, f) {
  const serialized = JSON.stringify(value);
  for (const secret of [privateKeyHex, password, f.keystore.crypto.ciphertext, f.keystore.crypto.kdfparams.salt, "obsolete-private-hint"]) assert.ok(!serialized.includes(secret), "IPC must not expose wallet secrets or encrypted key material");
}

test("wallet-only migration preserves address, encryption and old password without copying profile data", async t => {
  const f = fixture(t), sourceBefore = fs.readFileSync(f.sourceFile);
  for (const name of ["wallet/session.bin", "machine-secret.bin", "settings.json", "state.json", "plugins/private.json", "documents/private.txt", "account/token.json"]) write(path.join(f.sourceDir, name), "Alpha only");
  const inventory = f.service.scan();
  assert.equal(inventory.source.path, f.sourceDir); assert.equal(inventory.wallet.address, f.keystore.address); assert.equal(inventory.wallet.available, true); assertNoSecrets(inventory, f);
  assert.equal(f.service.start({ models: false, wallet: true }).phase, "running");
  const result = await finished(f.service);
  assert.equal(result.phase, "complete"); assert.equal(result.result.wallet.copied, true); assert.equal(result.result.models, undefined); assertNoSecrets(result, f);
  assert.deepEqual(fs.readFileSync(f.sourceFile), sourceBefore);
  const copied = JSON.parse(fs.readFileSync(f.destinationFile, "utf8")); assert.deepEqual(copied, f.keystore);
  assert.equal(fs.statSync(f.destinationFile).nlink, 1); assert.notEqual(fs.statSync(f.destinationFile).ino, fs.statSync(f.sourceFile).ino);
  if (process.platform !== "win32") assert.equal(fs.statSync(f.destinationFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(f.dataDir), ["wallet"]); assert.deepEqual(fs.readdirSync(path.join(f.dataDir, "wallet")), ["wallet.json"]);
  assert.equal(f.wallet.status().unlocked, false); assert.equal(f.wallet.status().address, f.keystore.address);
  assert.equal(f.wallet.unlock(password).address, f.keystore.address); assert.equal(f.calls.length, 0);
});

test("legacy uncompressed wallets retain their address and unlock with the Alpha password", async t => {
  const f = fixture(t, { compressed: false }); f.service.scan(); f.service.start({ models: false, wallet: true });
  assert.equal((await finished(f.service)).phase, "complete");
  assert.equal(JSON.parse(fs.readFileSync(f.destinationFile, "utf8")).compressed, false);
  assert.equal(f.wallet.unlock(password).address, f.keystore.address);
});

test("a temporary-file cleanup failure reports the wallet that was already copied", async t => {
  const f = fixture(t), remove = fs.rmSync;
  const mocked = t.mock.method(fs, "rmSync", (file, options) => {
    if (path.dirname(file) === path.dirname(f.destinationFile) && path.basename(file).startsWith(".alpha-wallet-")) throw Error("Synthetic cleanup failure");
    return remove(file, options);
  });
  f.service.scan(); f.service.start({ models: false, wallet: true });
  const result = await finished(f.service); mocked.mock.restore();
  assert.equal(result.phase, "complete"); assert.equal(result.result.wallet.copied, true);
  assert.match(result.result.wallet.warning, /temporary encrypted copy/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.destinationFile, "utf8")), f.keystore);
  assert.equal(f.wallet.status().unlocked, false); assert.equal(f.service.scan().wallet.blocked, true);
});

test("models-only migration never imports the wallet; both selections run independently", async t => {
  const f = fixture(t); f.service.scan(); f.service.start({ models: true, wallet: false });
  let result = await finished(f.service); assert.equal(result.phase, "complete"); assert.equal(fs.existsSync(f.destinationFile), false); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].sourceDir, f.sourceDir); assert.equal(f.calls[0].models, f.models); assert.equal(result.result.wallet, undefined);
  f.service.scan(); f.service.start({ models: true, wallet: true }); result = await finished(f.service);
  assert.equal(result.phase, "complete"); assert.equal(result.result.wallet.copied, true); assert.equal(result.result.models.copied, 1);
  assert.deepEqual(result.selected, { models: true, wallet: true }); assert.equal(result.source.path, f.sourceDir);
});

test("existing, malformed, same-address and session wallet data cannot be replaced", async t => {
  for (const kind of ["malformed", "same-address", "session"]) await t.test(kind, async t => {
    const f = fixture(t), file = kind === "session" ? path.join(f.dataDir, "wallet", "session.bin") : f.destinationFile;
    const content = kind === "same-address" ? encryptKeystore({ privateKeyHex, address: f.keystore.address, password: "different Core password" }) : "preserve these original bytes";
    write(file, content); const before = fs.readFileSync(file);
    const inventory = f.service.scan(); assert.equal(inventory.wallet.blocked, true); assert.equal(inventory.wallet.available, false);
    assert.throws(() => f.service.start({ models: false, wallet: true }), /unavailable|already has wallet/);
    f.service.start({ models: true, wallet: false }); assert.equal((await finished(f.service)).phase, "complete");
    assert.deepEqual(fs.readFileSync(file), before);
  });
});

test("a wallet created after review or during the payment gate is preserved", async t => {
  let f; f = fixture(t, { withWalletSpend: run => { write(f.destinationFile, "created while waiting"); return run(); } });
  f.service.scan(); f.service.start({ models: false, wallet: true });
  const result = await finished(f.service); assert.equal(result.phase, "failed"); assert.equal(result.result.wallet.copied, false);
  assert.equal(fs.readFileSync(f.destinationFile, "utf8"), "created while waiting");
});

test("wallet failure from an active payment review still allows selected model copying", async t => {
  const f = fixture(t, { withWalletSpend: () => { throw Error("Payment review is active"); } });
  f.service.scan(); f.service.start({ models: true, wallet: true });
  const result = await finished(f.service); assert.equal(result.phase, "failed"); assert.match(result.result.wallet.error, /Payment review/);
  assert.equal(result.result.models.copied, 1); assert.equal(fs.existsSync(f.destinationFile), false);
});

test("wallet content or identity changing after review is rejected without source edits", async t => {
  for (const kind of ["content", "identity"]) await t.test(kind, async t => {
    const f = fixture(t); f.service.scan();
    if (kind === "content") write(f.sourceFile, { ...f.keystore, createdAt: "2020-01-01T00:00:00.000Z" });
    else { const bytes = fs.readFileSync(f.sourceFile); fs.renameSync(f.sourceFile, f.sourceFile + ".old"); fs.writeFileSync(f.sourceFile, bytes); }
    const before = fs.readFileSync(f.sourceFile); f.service.start({ models: false, wallet: true });
    const result = await finished(f.service); assert.equal(result.phase, "failed"); assert.match(result.result.wallet.error, /changed since review/);
    assert.equal(fs.existsSync(f.destinationFile), false); assert.deepEqual(fs.readFileSync(f.sourceFile), before);
  });
});

test("replacing the reviewed profile directory is rejected before starting", async t => {
  const f = fixture(t); f.service.scan(); fs.renameSync(f.sourceDir, f.sourceDir + "-old"); fs.mkdirSync(f.sourceDir);
  assert.throws(() => f.service.start({ models: true, wallet: true }), /profile changed/); assert.equal(f.service.running, false);
});

test("damaged and unsupported keystores are unavailable and never copied", async t => {
  for (const kind of ["json", "kdf", "address", "ciphertext", "too-large"]) await t.test(kind, async t => {
    const f = fixture(t), value = structuredClone(f.keystore);
    if (kind === "kdf") value.crypto.kdfparams.n = 1073741824;
    if (kind === "address") value.address = "invalid address";
    if (kind === "ciphertext") value.crypto.ciphertext = "invalid";
    write(f.sourceFile, kind === "json" ? "{broken" : kind === "too-large" ? " ".repeat(65537) : value);
    const before = fs.readFileSync(f.sourceFile), inventory = f.service.scan(); assert.equal(inventory.wallet.available, false);
    assert.throws(() => f.service.start({ models: false, wallet: true }), /unavailable/);
    assert.deepEqual(fs.readFileSync(f.sourceFile), before); assert.equal(fs.existsSync(f.destinationFile), false);
  });
});

test("hard-linked Alpha wallet files are refused", async t => {
  const f = fixture(t); fs.linkSync(f.sourceFile, path.join(f.root, "wallet-hardlink.json"));
  const inventory = f.service.scan(); assert.equal(inventory.wallet.available, false); assert.match(inventory.wallet.detail, /linked/);
  assert.equal(fs.existsSync(f.destinationFile), false);
});

test("linked source and destination wallet folders are refused", async t => {
  for (const side of ["source", "destination"]) await t.test(side, async t => {
    const f = fixture(t), directory = path.join(side === "source" ? f.sourceDir : f.dataDir, "wallet"), target = path.join(f.root, side + "-wallet");
    if (side === "source") fs.renameSync(directory, target); else fs.mkdirSync(target);
    try { fs.symlinkSync(target, directory, process.platform === "win32" ? "junction" : "dir"); } catch (error) { if (error.code === "EPERM") { t.skip("OS does not permit creating a directory link"); return; } throw error; }
    const inventory = f.service.scan(); assert.equal(inventory.wallet.available, false);
    assert.throws(() => f.service.start({ models: false, wallet: true }), /unavailable|linked folder/);
    assert.deepEqual(fs.readdirSync(target), side === "source" ? ["wallet.json"] : []);
  });
});

test("native folder selection accepts an Alpha parent and rejects Core overlap", async t => {
  const f = fixture(t); f.choose(path.dirname(f.sourceDir));
  assert.equal((await f.service.chooseSource()).source.path, f.sourceDir);
  for (const directory of [f.dataDir, f.root]) { f.choose(directory); await assert.rejects(f.service.chooseSource(), /separate.*Alpha profile/); }
  const child = path.join(f.dataDir, "nested"); fs.mkdirSync(child); f.choose(child); await assert.rejects(f.service.chooseSource(), /separate.*Alpha profile/);
  f.choose(null); assert.equal(await f.service.chooseSource(), null);
});

test("headless profile discovery works and absent data remains unavailable", async t => {
  const f = fixture(t); fs.renameSync(f.sourceDir, path.join(f.homeDir, ".koinos-ai"));
  assert.equal(f.service.scan().source.path, path.join(f.homeDir, ".koinos-ai"));
  const empty = fixture(t, { noWallet: true, inspectModels: () => ({ count: 0, bytes: 0, warnings: [] }) });
  fs.rmSync(empty.sourceDir, { recursive: true });
  const inventory = empty.service.scan(); assert.equal(inventory.source, null); assert.equal(inventory.models.available, false); assert.equal(inventory.wallet.available, false);
});

test("selection validation prevents arbitrary renderer paths and requires review", async t => {
  const f = fixture(t); assert.throws(() => f.service.start({ models: true, wallet: false }), /Review/); f.service.scan();
  for (const selection of [null, {}, { models: false, wallet: false }, { models: "true", wallet: false }, { models: true }, { models: true, wallet: false, source: f.sourceDir }, { models: true, wallet: false, plugins: true }]) assert.throws(() => f.service.start(selection), /Select Models/);
  for (const [field, busy] of [["_active", { working: true }], ["_importing", { working: true }], ["_removing", new Set(["existing-model"]) ]]) {
    f.models[field] = busy;
    assert.throws(() => f.service.start({ models: true, wallet: false }), /current model/);
    delete f.models[field];
  }
});

test("cancellation retains completed wallet and partial model results, blocks concurrent source changes", async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { copyModels: ({ signal, onProgress }) => new Promise((_resolve, reject) => {
    onProgress({ completedBytes: 6, totalBytes: 12, detail: "Copying synthetic model" }); entered();
    signal.addEventListener("abort", () => { const error = Error("cancelled"); error.partialResult = { copied: 1, skipped: 0, failed: 0, models: [], bytes: 6, warnings: [] }; reject(error); }, { once: true });
  }) });
  f.service.scan(); f.service.start({ models: true, wallet: true }); await started;
  assert.equal(f.service.status().progress.completedBytes, 6); assert.throws(() => f.service.scan(), /current migration/);
  await assert.rejects(f.service.chooseSource(), /current migration/); assert.throws(() => f.service.start({ models: false, wallet: true }), /current migration/);
  f.service.cancel(); const result = await finished(f.service);
  assert.equal(result.phase, "cancelled"); assert.equal(result.result.wallet.copied, true); assert.equal(result.result.models.copied, 1);
  assert.equal(f.wallet.status().address, f.keystore.address); assert.equal(f.wallet.status().unlocked, false);
  assert.equal(f.service.scan().wallet.blocked, true);
});

test("dispose aborts active copying and waits for cleanup; returned status is detached", async t => {
  let entered, cleaned = false; const started = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { copyModels: ({ signal }) => new Promise((_resolve, reject) => {
    entered(); signal.addEventListener("abort", () => setImmediate(() => { cleaned = true; reject(Error("cancelled")); }), { once: true });
  }) });
  f.service.scan(); const snapshot = f.service.start({ models: true, wallet: false }); snapshot.selected.wallet = true; snapshot.phase = "complete";
  assert.equal(f.service.status().selected.wallet, false); assert.equal(f.service.status().phase, "running");
  await started; await f.service.dispose(); assert.equal(cleaned, true); assert.equal(f.service.status().phase, "cancelled");
  assert.throws(() => f.service.scan(), /closing/);
});
