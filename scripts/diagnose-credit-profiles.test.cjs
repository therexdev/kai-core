"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { diagnose } = require("./diagnose-credit-profiles.cjs");
const wallet = "1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK", secret = "CANARY_CREDENTIAL_MUST_NOT_APPEAR";
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const sqlite = file => process.platform === "win32" ? path.toNamespacedPath(file) : file;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-profile-diagnostic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "Koinos AI", "core", "koin-foundation-test", "journals");
  fs.mkdirSync(directory, { recursive: true });
  const files = ["funding-recovery.sqlite", "wallet-nonces.sqlite"];
  const anchorFile = directory + ".recovery-anchor.sqlite", witness = new DatabaseSync(sqlite(anchorFile));
  witness.exec("CREATE TABLE anchor(id,pair_id,directory,files,generation); CREATE TABLE ownership(id,host); CREATE TABLE attached_files(name,generation); CREATE TABLE leases(id,host,pid)");
  witness.prepare("INSERT INTO anchor VALUES(1,?,?,?,2)").run("pair", fs.realpathSync(directory), JSON.stringify(files));
  witness.prepare("INSERT INTO ownership VALUES(1,?)").run(JSON.stringify({ hostname: os.hostname(), platform: process.platform, arch: process.arch }));
  witness.prepare("INSERT INTO leases VALUES(?,?,?)").run("lease", os.hostname(), process.pid);
  for (const [i, file] of files.entries()) witness.prepare("INSERT INTO attached_files VALUES(?,?)").run(file, i + 1);
  witness.close();
  for (const [i, file] of files.entries()) {
    const db = new DatabaseSync(sqlite(path.join(directory, file))), table = i ? "reservations" : "deposits";
    db.exec(`CREATE TABLE identity(id,data,clock); CREATE TABLE recovery_generation(id,pair_id,generation); CREATE TABLE ${table}(id,owner,state,tx_id,hash,data)`);
    const identity = i ? { chainId: "chain", rpc: "https://user:" + secret + "@rpc.invalid" } : { deployment: { chainId: "chain", rpc: secret } };
    db.prepare("INSERT INTO identity VALUES(1,?,0)").run(JSON.stringify(identity));
    db.prepare("INSERT INTO recovery_generation VALUES(1,'pair',?)").run(i + 1);
    for (const [n, state] of (i ? ["finalized", "signed"] : ["funded", "unknown"]).entries()) {
      const row = { id: "record-" + n, owner: wallet, intent: { actor: wallet }, state, draft: { id: "tx-" + n }, secret };
      const data = JSON.stringify(row);
      db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?,?)`).run(row.id, wallet, state, row.draft.id, hash(data), data);
    }
    db.prepare(`INSERT INTO ${table} VALUES('other','different-wallet','signed','tx-other','bad','private-other-record')`).run();
    db.close();
  }
  const credential = path.join(path.dirname(directory), "test-access.enc");
  fs.writeFileSync(credential, secret);
  const edit = (file, sql) => { const db = new DatabaseSync(sqlite(file)); try { db.exec(sql); } finally { db.close(); } };
  return { root, directory, files, anchorFile, credential, edit, report: () => diagnose(root, wallet) };
}
test("reads wallet-specific counts and anchor generations without modifying source bytes", t => {
  const f = fixture(t), files = [f.anchorFile, f.credential, ...f.files.map(n => path.join(f.directory, n))];
  const before = files.map(file => hash(fs.readFileSync(file))), report = f.report(), p = report.profiles[0], j = p.journals[0];
  assert.equal(p.state, "inspection-complete"); assert.equal(j.anchor, "GENERATIONS_MATCH"); assert.equal(j.sameHost, true); assert.equal(j.liveLocalWriterProcesses, 1);
  assert.deepEqual(j.files.map(r => [r.walletRecords, r.pendingRecords, r.inconsistentRecords]), [[2, 1, 0], [2, 1, 0]]);
  assert.equal(j.files[0].chainFingerprint, j.files[1].chainFingerprint);
  assert.deepEqual(files.map(file => hash(fs.readFileSync(file))), before);
  assert.equal(JSON.stringify(report).includes(secret), false); assert.equal(JSON.stringify(report).includes("private-other-record"), false);
  assert.equal(report.paymentsAuthorized, false); assert.equal(report.profiles[1].exists, false);
});
test("reports missing anchors without creating them", t => {
  const f = fixture(t); fs.unlinkSync(f.anchorFile);
  const j = f.report().profiles[0].journals[0]; assert.equal(j.anchor, "MISSING"); assert.equal(j.files[0].pendingRecords, 1); assert.equal(fs.existsSync(f.anchorFile), false);
});
test("detects mismatched generation and missing paired journals", t => {
  const f = fixture(t); f.edit(path.join(f.directory, f.files[0]), "UPDATE recovery_generation SET generation=4");
  assert.equal(f.report().profiles[0].journals[0].anchor, "IDENTITY_OR_GENERATION_MISMATCH");
  fs.unlinkSync(path.join(f.directory, f.files[1]));
  const j = f.report().profiles[0].journals[0]; assert.equal(j.files[1].state, "missing"); assert.equal(j.anchor, "IDENTITY_OR_GENERATION_MISMATCH");
});
test("reports malformed records and suppresses arbitrary state text", t => {
  const f = fixture(t); f.edit(path.join(f.directory, f.files[0]), "UPDATE deposits SET state='CANARY_CREDENTIAL_MUST_NOT_APPEAR' WHERE owner='" + wallet + "'");
  const report = f.report(), j = report.profiles[0].journals[0];
  assert.equal(j.files[0].unrecognizedStates, 2); assert.equal(j.files[0].inconsistentRecords, 2); assert.equal(JSON.stringify(report).includes(secret), false);
});
test("blocked unreadable SQLite produces no raw exception or file contents", t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.directory, f.files[0]), secret);
  const report = f.report(), j = report.profiles[0].journals[0]; assert.equal(j.files[0].state, "blocked"); assert.equal(JSON.stringify(report).includes(secret), false);
});
test("does not follow linked payment journal directories", { skip: process.platform === "win32" }, t => {
  const f = fixture(t), target = path.join(f.root, "original-journals");
  fs.renameSync(f.directory, target); fs.symlinkSync(target, f.directory, "dir");
  const j = f.report().profiles[0].journals[0]; assert.equal(j.state, "blocked"); assert.equal(j.code, "LINKED_OR_INVALID_PATH");
});
test("inspects hashed account contexts and reports stable ID filenames without reading credentials", t => {
  const f = fixture(t), root = path.join(f.root, "KAI Core", "foundation-v1");
  const context = path.join(root, "credit-account-v2", "a".repeat(64), "b".repeat(64));
  fs.mkdirSync(context, { recursive: true }); fs.writeFileSync(path.join(context, "purchase-installation.enc"), secret);
  fs.mkdirSync(path.join(root, "credit-wallet-hosts")); fs.writeFileSync(path.join(root, "credit-wallet-hosts", "c".repeat(64) + ".enc"), secret);
  const report = f.report(); assert.equal(report.profiles[1].installationRecords.length, 2); assert.equal(JSON.stringify(report).includes(secret), false);
});
test("invalid input fails before searching any profile", () => {
  assert.throws(() => diagnose("relative", wallet), /ABSOLUTE_APPDATA/);
  assert.throws(() => diagnose(os.tmpdir(), "private data"), /ABSOLUTE_APPDATA/);
});
