"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { fixture } = require("../test/helpers/koin-funding-recovery-fixture");
const { PurchaseHostTransfer } = require("../../electron/credit-purchase-host-transfer");
const { JournalSet } = require("../lib/koin-network/journal-set");
function db(file, fn) { const d = new DatabaseSync(file); try { return fn(d); } finally { d.close(); } }
async function setup(t, { settled = true, stoppedBeforeFinality = false } = {}) {
  const f = fixture(t, { usd: true });
  f.request.args = await require("../lib/koin-network/purchase-quote").issue({ deployment: f.d,
    signer: require("koilib").Signer.fromSeed("funding-recovery-verifier"), account: f.request.actor,
    amount: "500000000", usdPerKoin: "25000000", version: 1, now: f.state.now });
  const begun = await f.journal.begin(f.id, f.request), tx = await f.sign(begun); await f.journal.stage(f.id, tx);
  if (stoppedBeforeFinality) f.journal.hold(f.id);
  if (settled) { await f.include(tx, { irreversible: true }); assert.equal((await f.journal.advance(f.id, { allowSubmit: false })).state, "funded"); }
  f.journal.close();
  const anchor = f.dir + ".recovery-anchor.sqlite", source = JSON.stringify({ hostname: "retired-test-host", platform: process.platform, arch: process.arch });
  db(anchor, d => d.prepare("UPDATE ownership SET host=? WHERE id=1").run(source));
  let authorized = true;
  const transfer = new PurchaseHostTransfer({ directory: f.dir, client: f.client, owner: f.request.actor, clock: () => f.state.now,
    authorize: () => { assert(authorized, "authorization revoked"); } });
  const backup = f.dir + "-host-backup"; t.after(() => fs.rmSync(backup, { recursive: true, force: true }));
  return { ...f, transfer, anchor, source, backup, revoke: () => { authorized = false; }, ownership: () => db(anchor, d => d.prepare("SELECT host FROM ownership").get().host) };
}
test("reviewed closed-history transfer preserves complete journals and normal guards", async t => {
  const f = await setup(t), before = db(f.anchor, d => d.prepare("SELECT * FROM anchor").get());
  assert.throws(() => new JournalSet(f.dir), /another host/);
  const review = await f.transfer.review();
  const result = f.transfer.apply(review, { approved: true, backupDirectory: f.backup }); assert.equal(result.transferred, true);
  assert.equal(f.ownership(), JSON.stringify({ hostname: os.hostname(), platform: process.platform, arch: process.arch }));
  assert.deepEqual(db(f.anchor, d => d.prepare("SELECT * FROM anchor").get()), before);
  for (const name of ["funding-recovery.sqlite", "wallet-nonces.sqlite"]) {
    const table = name.startsWith("funding") ? "deposits" : "reservations";
    assert.deepEqual(db(path.join(f.dir, name), d => d.prepare(`SELECT * FROM ${table}`).all()), db(path.join(f.backup, name), d => d.prepare(`SELECT * FROM ${table}`).all()));
    assert.deepEqual(db(path.join(f.dir, name), d => d.prepare("SELECT * FROM recovery_generation").get()), db(path.join(f.backup, name), d => d.prepare("SELECT * FROM recovery_generation").get()));
  }
  assert.equal(db(path.join(f.backup, path.basename(f.anchor)), d => d.prepare("SELECT host FROM ownership").get().host), f.source);
  assert.equal(db(f.anchor, d => d.prepare("SELECT COUNT(*) AS n FROM host_transfers").get().n), 1);
  const guard = new JournalSet(f.dir); guard.close();
  assert.throws(() => f.transfer.apply(review, { approved: true, backupDirectory: f.backup }), /Approve the exact/);
});
test("requires exact explicit approval and refuses expired reviews", async t => {
  const f = await setup(t), review = await f.transfer.review();
  assert.throws(() => f.transfer.apply(review, { backupDirectory: f.backup }), /Approve the exact/);
  assert.throws(() => f.transfer.apply({ ...review, targetHost: "changed" }, { approved: true, backupDirectory: f.backup }), /Approve the exact/);
  f.state.now += 60001; assert.throws(() => f.transfer.apply(review, { approved: true, backupDirectory: f.backup }), /expired/);
  assert.equal(f.ownership(), f.source); assert(!fs.existsSync(f.backup));
});
test("pending original payments cannot transfer even with an empty lease table", async t => {
  const f = await setup(t, { settled: false }); await assert.rejects(f.transfer.review(), /completely settled/); assert.equal(f.ownership(), f.source);
});
test("every original-host lease blocks review and apply", async t => {
  const f = await setup(t), review = await f.transfer.review();
  db(f.anchor, d => d.prepare("INSERT INTO leases VALUES(?,?,?)").run("old", "retired-test-host", 999999));
  await assert.rejects(f.transfer.review(), /Close every/);
  assert.throws(() => f.transfer.apply(review, { approved: true, backupDirectory: f.backup }), /Close every/); assert.equal(f.ownership(), f.source);
});
test("missing live-chain evidence cannot migrate locally finalized records", async t => {
  const f = await setup(t); f.state.record = null; await assert.rejects(f.transfer.review(), /Reconfirm every/); assert.equal(f.ownership(), f.source);
});
test("nonce regression blocks migration", async t => {
  const f = await setup(t); f.state.nonce = "KAE="; await assert.rejects(f.transfer.review(), /nonce has not advanced/);
});
test("journal generation changes after approval are rejected", async t => {
  const f = await setup(t), review = await f.transfer.review();
  db(f.anchor, d => d.prepare("UPDATE anchor SET generation=generation+1").run());
  assert.throws(() => f.transfer.apply(review, { approved: true, backupDirectory: f.backup }), /rollback/); assert.equal(f.ownership(), f.source);
});
test("a changed record cannot use an earlier review", async t => {
  const f = await setup(t), review = await f.transfer.review();
  db(path.join(f.dir, "funding-recovery.sqlite"), d => d.prepare("UPDATE deposits SET hash=?").run("bad"));
  assert.throws(() => f.transfer.apply(review, { approved: true, backupDirectory: f.backup }), /checksum/); assert.equal(f.ownership(), f.source);
});
test("authorization revocation does not modify the history", async t => {
  const f = await setup(t), review = await f.transfer.review(); f.revoke();
  assert.throws(() => f.transfer.apply(review, { approved: true, backupDirectory: f.backup }), /authorization revoked/); assert.equal(f.ownership(), f.source);
});
test("existing backup destinations are preserved", async t => {
  const f = await setup(t), review = await f.transfer.review(); fs.mkdirSync(f.backup); fs.writeFileSync(path.join(f.backup, "keep"), "keep");
  assert.throws(() => f.transfer.apply(review, { approved: true, backupDirectory: f.backup }), /New physical/); assert.equal(fs.readFileSync(path.join(f.backup, "keep"), "utf8"), "keep"); assert.equal(f.ownership(), f.source);
});
test("cross-platform changes require a separate migration", async t => {
  const f = await setup(t); db(f.anchor, d => d.prepare("UPDATE ownership SET host=?").run(JSON.stringify({ hostname: "old", platform: "different", arch: process.arch })));
  await assert.rejects(f.transfer.review(), /Cross-platform/);
});
test("a historical stop flag is preserved after the exact payment becomes final", async t => {
  const f = await setup(t, { stoppedBeforeFinality: true }), review = await f.transfer.review();
  f.transfer.apply(review, { approved: true, backupDirectory: f.backup });
  const row = db(path.join(f.dir, "funding-recovery.sqlite"), d => d.prepare("SELECT data FROM deposits").get());
  assert.equal(JSON.parse(row.data).state, "funded"); assert.equal(JSON.parse(row.data).held, true);
});
