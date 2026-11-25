"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const Access = require("../../electron/credit-purchase-access"), P = require("../lib/koin-network/job-protocol");
const CONFLICT = "This Test wallet is already bound to another installation. Recover that installation or use a separately invited Test wallet";
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-wallet-host-")); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const key = crypto.randomBytes(32), storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString(text) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv); return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]); },
    decryptString(bytes) { const cipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString(); } };
  const config = { owner: "fixture-wallet", schedulerUrl: "https://fixture.invalid/scheduler", mode: "mainnet-pilot", deployment: { chainId: "fixture-chain" } };
  const context = (account, cfg = config) => { const directory = path.join(dataDir, "credit-account-v2", P.hash(account), P.hash(JSON.stringify(cfg))); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "context.json"), JSON.stringify({ accountId: account, config: cfg })); return { directory, config: cfg, auth: { sessionToken: "fixture-token" } }; };
  const save = (c, installation) => { const file = path.join(c.directory, "purchase-installation.enc"); fs.writeFileSync(file, storage.encryptString(JSON.stringify({ identity: P.hash(JSON.stringify([c.config.owner, c.config.schedulerUrl, c.config.deployment.chainId])), installation }))); return file; };
  const original = P.hash("original installation"), current = P.hash("rejected new installation"), seen = [], wallet = { address: config.owner };
  let authorized = true, reply, afterReply;
  const account = { assertCreditAuthorization() { if (!authorized) throw Error("Account authorization changed"); } };
  const fetchImpl = async (_url, init) => { const input = JSON.parse(init.body); seen.push(input.installation); const result = reply ? reply(input) : input.installation === original
    ? Response.json({ mode: config.mode, chainId: config.deployment.chainId, owner: config.owner, installation: original, granted: true }) : Response.json({ error: CONFLICT }, { status: 400 }); afterReply?.(); return result; };
  const options = c => ({ c, account, wallet, dataDir, storage, fetchImpl, installation: Access.installation({ dataDir, directory: c.directory, config: c.config, storage }) });
  return { dataDir, storage, config, context, save, original, current, seen, options, setReply: fn => { reply = fn; }, revoke: () => { authorized = false; }, afterReply: fn => { afterReply = fn; } };
}
test("account and configuration changes reuse the same local wallet installation", t => {
  const f = fixture(t), old = f.context("old-account"); f.save(old, f.original);
  assert.equal(f.options(f.context("website-account")).installation, f.original);
  assert.equal(f.options(f.context("website-account", { ...f.config, version: 2 })).installation, f.original);
});
test("an already-created replacement ID recovers only the original local server-approved ID and preserves every old record", async t => {
  const f = fixture(t), old = f.context("old-account"), current = f.context("website-account");
  const oldFile = f.save(old, f.original), currentFile = f.save(current, f.current), files = [oldFile, currentFile];
  const journal = path.join(old.directory, "saved-payment.sqlite"); fs.writeFileSync(journal, "saved payment bytes"); files.push(journal);
  const bytes = files.map(file => fs.readFileSync(file));
  assert.equal((await Access.claimHost(f.options(current))).installation, f.original);
  assert.deepEqual(f.seen, [f.current, f.original]);
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), bytes[i]));
  const options = f.options(f.context("third-account")); assert.equal(options.installation, f.original);
  await Access.claimHost(options); assert.equal(f.seen.at(-1), f.original);
  const stableDir = path.join(f.dataDir, "credit-wallet-hosts"), saved = fs.readFileSync(path.join(stableDir, fs.readdirSync(stableDir)[0]));
  assert.equal(saved.includes(f.original), false);
});
test("another profile without the original record cannot take the server binding", async t => {
  const f = fixture(t), c = f.context("new-profile"); f.save(c, f.current);
  await assert.rejects(Access.claimHost(f.options(c)), /signing lease is unavailable/);
  assert.deepEqual(f.seen, [f.current]); assert.equal(fs.existsSync(path.join(f.dataDir, "credit-wallet-hosts")), false);
});
test("records for another wallet, chain or service cannot supply a signing ID", async t => {
  const f = fixture(t), c = f.context("current"); f.save(c, f.current);
  for (const config of [{ ...f.config, owner: "other-wallet" }, { ...f.config, schedulerUrl: "https://other.invalid/scheduler" }, { ...f.config, deployment: { chainId: "other-chain" } }]) f.save(f.context("other", config), f.original);
  await assert.rejects(Access.claimHost(f.options(c)), /signing lease is unavailable/); assert.deepEqual(f.seen, [f.current]);
});
test("authentication and malformed host responses cannot trigger identity recovery", async t => {
  for (const response of [() => Response.json({ error: CONFLICT }, { status: 401 }), () => Response.json({ error: "Unavailable" }, { status: 500 }), () => Response.json({ granted: true })]) await t.test("rejected response", async t => {
    const f = fixture(t), c = f.context("current"); f.save(c, f.current); f.save(f.context("old"), f.original); f.setReply(response);
    await assert.rejects(Access.claimHost(f.options(c)), /signing lease is unavailable/); assert.deepEqual(f.seen, [f.current]);
    assert.equal(fs.existsSync(path.join(f.dataDir, "credit-wallet-hosts")), false);
  });
});
test("unreadable matching records and changed authorization remain blocked without creating a stable identity", async t => {
  const f = fixture(t), c = f.context("current"), old = f.context("old"); f.save(c, f.current);
  fs.writeFileSync(path.join(old.directory, "purchase-installation.enc"), "unreadable");
  await assert.rejects(Access.claimHost(f.options(c))); assert.deepEqual(f.seen, [f.current]);
  f.save(old, f.original); f.afterReply(f.revoke);
  await assert.rejects(Access.claimHost(f.options(c)), /authorization changed/);
  assert.equal(fs.existsSync(path.join(f.dataDir, "credit-wallet-hosts")), false);
});
test("a verified stable identity is preserved when the server rejects it", async t => {
  const f = fixture(t), c = f.context("current"); f.save(c, f.original); await Access.claimHost(f.options(c));
  f.save(f.context("other-context"), f.current); f.setReply(() => Response.json({ error: CONFLICT }, { status: 400 }));
  const before = f.seen.length; await assert.rejects(Access.claimHost(f.options(c)), /signing lease is unavailable/);
  assert.equal(f.seen.length, before + 1); assert.equal(f.options(c).installation, f.original);
});
