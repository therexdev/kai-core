"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite"), { sqlitePath } = require("../lib/sqlite-path");
const { FundingRecovery } = require("../../electron/koin-funding-recovery"), Recovery = require("../../electron/credit-purchase-recovery");
const P = require("../lib/koin-network/job-protocol");
function fixture(t) {
  const f = require("../test/helpers/koin-funding-recovery-fixture").fixture(t, { usd: true, mainnet: true });
  const profile = path.join(f.dir, "Alpha"), dataDir = path.join(f.dir, "Core"), accountId = "original-account";
  const config = { owner: f.signer.getAddress(), mode: "mainnet-pilot", deployment: f.d, maxRcPerDay: "20000000", schedulerUrl: "https://fixture.invalid/scheduler" };
  const context = path.join(profile, "credit-account-v2", P.hash(accountId), P.hash(JSON.stringify(config))), directory = path.join(context, "journals");
  fs.mkdirSync(context, { recursive: true }); fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(context, "context.json"), JSON.stringify({ accountId, config }));
  new FundingRecovery(directory, { mode: config.mode, client: f.client, maxRcPerDay: config.maxRcPerDay }).close();
  const key = crypto.randomBytes(32), storage = { isEncryptionAvailable: () => true, encryptString(value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
  }, decryptString(bytes) {
    const cipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString();
  } };
  const installation = P.hash("original Alpha installation"), record = path.join(context, "purchase-installation.enc");
  fs.writeFileSync(record, storage.encryptString(JSON.stringify({ identity: P.hash(JSON.stringify([config.owner, config.schedulerUrl, config.deployment.chainId])), installation })));
  const c = { config, auth: { accountId, sessionToken: "private-fixture-token" }, directory: path.join(dataDir, "current-context") };
  let authorized = true, unlocked = true, approved = true, selected = true, privacy = "local-first", reply, afterReply;
  const calls = [], reviews = [], wallet = { address: config.owner, status: () => ({ unlocked }) };
  const account = { wallet, settings: { get: () => privacy }, assertCreditAuthorization() { if (!authorized) throw Error("Authorization changed"); } };
  const opts = { dataDir, c, storage, account, clientFactory: () => f.client,
    window: { isVisible: () => true, isDestroyed: () => false, isMinimized: () => false },
    dialog: { showOpenDialog: async () => ({ canceled: !selected, filePaths: [profile] }), showMessageBox: async (_w, value) => { reviews.push(value); return { response: approved ? 1 : 0 }; } },
    fetchImpl: async (_url, init) => {
      const input = JSON.parse(init.body); calls.push(input); assert.equal(input.installation, installation);
      const result = reply || Response.json({ mode: config.mode, chainId: f.d.chainId, owner: config.owner, installation, granted: true }); afterReply?.(); return result;
    }
  };
  return { ...f, profile, dataDir, context, directory, c, storage, installation, record, calls, reviews, opts,
    recover: () => Recovery.recover(opts), resolve: () => Recovery.resolve(opts),
    approve: value => approved = value, select: value => selected = value, revoke: () => authorized = false, lock: () => unlocked = false,
    privacy: value => privacy = value, reply: value => reply = value, afterReply: fn => afterReply = fn,
    edit(file, sql) { const db = new DatabaseSync(sqlitePath(file)); try { db.exec(sql); } finally { db.close(); } }
  };
}
test("explicit recovery verifies the old server ID and keeps the original coordinated journal in place", async t => {
  const f = fixture(t), before = fs.readFileSync(f.record);
  assert.equal(f.resolve(), null); const result = await f.recover(); assert.equal(result.state, "connected");
  assert.equal(f.calls.length, 1); assert.equal(f.reviews.length, 1);
  assert.equal(f.resolve().directory, fs.realpathSync(f.directory)); assert.equal(f.resolve().installation, f.installation);
  assert.deepEqual(fs.readFileSync(f.record), before); assert.equal(f.state.signed, 0); assert.deepEqual(f.state.submissions, []);
  const root = path.join(f.dataDir, "credit-purchase-recovery"), encrypted = fs.readFileSync(path.join(root, fs.readdirSync(root)[0]));
  assert.equal(encrypted.includes(f.installation), false); assert.equal(fs.existsSync(path.join(f.c.directory, "journals")), false);
  await f.recover(); assert.equal(f.calls.length, 1, "repeated recovery does not overwrite the selected connection");
});
test("cancelling folder selection or review preserves the new profile and makes no lease request", async t => {
  for (const stage of ["select", "approve"]) await t.test(stage, async t => {
    const f = fixture(t); f[stage](false); assert.equal((await f.recover()).state, "cancelled");
    assert.deepEqual(f.calls, []); assert.equal(f.resolve(), null); assert.deepEqual(fs.readdirSync(f.dataDir), []);
  });
});
test("a server binding conflict and a changed account cannot persist recovery", async t => {
  for (const kind of ["conflict", "account"]) await t.test(kind, async t => {
    const f = fixture(t);
    if (kind === "conflict") f.reply(Response.json({ error: "This Test wallet is already bound to another installation. Recover that installation or use a separately invited Test wallet" }, { status: 400 }));
    else f.afterReply(f.revoke);
    await assert.rejects(f.recover()); assert.equal(f.resolve(), null); assert.equal(f.calls.length, 1);
  });
});
test("locked wallets and Local-Only never open a folder or request a lease", async t => {
  for (const kind of ["locked", "offline"]) await t.test(kind, async t => {
    const f = fixture(t); if (kind === "locked") f.lock(); else f.privacy("local-only");
    await assert.rejects(f.recover()); assert.deepEqual(f.calls, []); assert.deepEqual(f.reviews, []);
  });
});
test("missing or rolled-back paired journals fail before server reconnection", async t => {
  for (const kind of ["missing", "generation"]) await t.test(kind, async t => {
    const f = fixture(t), file = path.join(f.directory, "wallet-nonces.sqlite");
    if (kind === "missing") fs.unlinkSync(file); else f.edit(file, "UPDATE recovery_generation SET generation=generation+1");
    await assert.rejects(f.recover()); assert.deepEqual(f.calls, []); assert.equal(f.resolve(), null);
  });
});
test("another account, wallet or deployment cannot become the recovery source", async t => {
  for (const key of ["account", "owner", "deployment"]) await t.test(key, async t => {
    const f = fixture(t), file = path.join(f.context, "context.json"), saved = JSON.parse(fs.readFileSync(file));
    if (key === "account") saved.accountId = "another-account";
    else if (key === "owner") saved.config.owner = "another-wallet";
    else saved.config.deployment.credits = saved.config.deployment.rewards;
    fs.writeFileSync(file, JSON.stringify(saved)); await assert.rejects(f.recover()); assert.deepEqual(f.calls, []);
  });
});
test("missing selected journals or changed source credentials never fall back to a fresh journal", async t => {
  const f = fixture(t); await f.recover();
  fs.unlinkSync(path.join(f.directory, "wallet-nonces.sqlite")); assert.throws(f.resolve);
  fs.writeFileSync(f.record, "damaged credential"); assert.throws(f.resolve);
  assert.equal(fs.existsSync(path.join(f.c.directory, "journals")), false);
});
test("unresolved current-profile transactions block switching to the old connection", async t => {
  const f = fixture(t), dir = path.join(f.dataDir, "koin-foundation-test", "journals"); fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(sqlitePath(path.join(dir, "wallet-nonces.sqlite")));
  db.exec("CREATE TABLE identity(id,data); CREATE TABLE reservations(owner,state)");
  db.prepare("INSERT INTO identity VALUES(1,?)").run(JSON.stringify({ chainId: f.d.chainId })); db.prepare("INSERT INTO reservations VALUES(?,'signed')").run(f.c.config.owner); db.close();
  await assert.rejects(f.recover(), /earlier wallet transaction is unresolved/); assert.deepEqual(f.calls, []); assert.equal(f.resolve(), null);
});
