"use strict";
// Explicit maintenance for a CLOSED, completely settled purchase history.
// Normal opening/signing keeps JournalSet's existing host and rollback guards.
// This operation never signs, broadcasts, deletes, or resets payment history.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite"), { isDeepStrictEqual } = require("node:util");
const { sqlitePath, filesystemPath } = require("../core/lib/sqlite-path");
const { KoinChain } = require("../core/lib/koin-network/chain");
const { FundingObserver, intent } = require("../core/lib/koin-network/funding-observer");
const { nonce } = require("../core/lib/koinos/wallet-nonce");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const json = JSON.stringify, FILES = ["funding-recovery.sqlite", "wallet-nonces.sqlite"];
const host = () => json({ hostname: os.hostname(), platform: process.platform, arch: process.arch });
const check = (ok, message) => { if (!ok) throw Error(message); };
function regular(file) { const s = fs.lstatSync(file); check(s.isFile() && !s.isSymbolicLink(), "Regular payment files required"); }
function sync(file) { const fd = fs.openSync(file, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function open(file, readOnly = true) { regular(file); const db = new DatabaseSync(sqlitePath(file), { readOnly }); db.exec("PRAGMA busy_timeout=5000"); return db; }
function checkedRow(row) {
  check(row && hash(row.data) === row.hash, "Payment record checksum changed");
  const r = JSON.parse(row.data);
  check(r.id === row.id && r.state === row.state && r.draft?.id === row.tx_id &&
    hash(json(r.draft)) === r.draftHash && r.transaction?.id === row.tx_id &&
    hash(json(r.transaction)) === r.transactionHash, "Payment record binding changed");
  check(Number.isSafeInteger(r.createdAt) && Number.isSafeInteger(r.updatedAt) && r.updatedAt >= r.createdAt, "Invalid payment timestamps");
  return r;
}
class PurchaseHostTransfer {
  #directory; #client; #owner; #authorize; #clock; #review;
  constructor({ directory, client, owner, authorize, clock = Date.now }) {
    check(client instanceof KoinChain && typeof authorize === "function", "Authorized pinned payment context required");
    const dir = path.resolve(filesystemPath(directory));
    check(!fs.lstatSync(dir).isSymbolicLink() && fs.realpathSync(dir) === dir, "Physical payment directory required");
    this.#directory = dir; this.#client = client; this.#owner = owner; this.#authorize = authorize; this.#clock = clock;
  }
  #snapshot(anchor) {
    this.#authorize();
    const a = anchor.prepare("SELECT * FROM anchor WHERE id=1").get(), ownership = anchor.prepare("SELECT host FROM ownership WHERE id=1").get();
    check(anchor.prepare("PRAGMA quick_check").get().quick_check === "ok", "Damaged payment recovery anchor");
    check(a?.directory === this.#directory && a.files === json(FILES) && Number.isSafeInteger(a.generation) && a.generation >= 0, "Payment recovery anchor changed");
    check(ownership?.host && ownership.host !== host(), "Payment history is already on this host");
    const oldHost = JSON.parse(ownership.host);
    check(typeof oldHost.hostname === "string" && oldHost.platform === process.platform && oldHost.arch === process.arch, "Cross-platform payment migration requires separate review");
    check(!anchor.prepare("SELECT 1 FROM leases LIMIT 1").get(), "Close every payment journal writer on the original host first");
    const attached = anchor.prepare("SELECT name,generation FROM attached_files ORDER BY name").all();
    check(json(attached.map(r => r.name)) === json(FILES), "Complete paired payment journals required");
    const documents = [], handles = [];
    try {
      for (const file of FILES) {
        const db = open(path.join(this.#directory, file)); handles.push(db);
        check(db.prepare("PRAGMA quick_check").get().quick_check === "ok", "Damaged payment journal");
        const generation = db.prepare("SELECT * FROM recovery_generation WHERE id=1").get();
        check(generation?.pair_id === a.pair_id && generation.generation === attached.find(r => r.name === file).generation, "Payment recovery generation mismatch");
        const identity = db.prepare("SELECT * FROM identity WHERE id=1").get();
        check(identity && Number.isSafeInteger(identity.clock) && identity.clock <= this.#clock(), "Invalid payment identity or clock");
        const table = file === FILES[0] ? "deposits" : "reservations";
        const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id LIMIT 101`).all();
        check(rows.length > 0 && rows.length <= 100, "Review one to 100 settled payments at a time");
        documents.push({ file, generation, identity, rows });
      }
      check(Math.max(...attached.map(r => r.generation)) === a.generation, "Payment anchor rollback detected");
      const fundingIdentity = JSON.parse(documents[0].identity.data), nonceIdentity = JSON.parse(documents[1].identity.data);
      check(isDeepStrictEqual(fundingIdentity.deployment, this.#client.d) && fundingIdentity.mode === nonceIdentity.mode &&
        nonceIdentity.chainId === this.#client.d.chainId && isDeepStrictEqual(nonceIdentity.rpc, this.#client.d.rpc), "Payment chain or deployment changed");
      check(documents[0].rows.length === documents[1].rows.length, "Unpaired wallet transactions require separate recovery");
      const records = documents[0].rows.map(row => {
        const f = checkedRow(row), other = documents[1].rows.find(r => r.id === row.id), n = checkedRow(other);
        check(row.owner === this.#owner && other.owner === this.#owner && f.intent?.actor === this.#owner && n.owner === this.#owner, "Payment owner changed");
        // A pre-finality Stop leaves the historical held flag intact. Funding
        // recovery also treats verified funded/finalized records as terminal;
        // preserve that flag instead of rewriting history to clear it.
        check(f.state === "funded" && n.state === "finalized" && n.purpose === "funding" &&
          (f.held === undefined || typeof f.held === "boolean") && !n.cancellation && !n.correction && !n.remote,
          "Only completely settled original purchases can transfer hosts");
        check(isDeepStrictEqual(intent(f.intent), f.intent) && isDeepStrictEqual(f.transaction, n.transaction), "Funding and nonce envelopes differ");
        check(f.finality?.state === "finalized" && f.finality.txId === row.tx_id && n.finality?.txId === row.tx_id &&
          f.finality.blockId === n.finality.blockId && f.finality.height === n.finality.height, "Finalized payment evidence differs");
        return f;
      });
      return { fingerprint: hash(json({ anchor: a, ownership, attached, documents })), anchor: a, sourceHost: ownership.host, records };
    } finally { for (const db of handles) db.close(); }
  }
  async review(signal) {
    signal?.throwIfAborted(); this.#authorize();
    const anchor = open(this.#directory + ".recovery-anchor.sqlite");
    let snapshot; try { snapshot = this.#snapshot(anchor); } finally { anchor.close(); }
    const observer = new FundingObserver(this.#client, { clock: this.#clock }), proofs = [];
    for (const r of snapshot.records) {
      signal?.throwIfAborted(); this.#authorize();
      const proof = await observer.finality(r.transaction, r.intent);
      check(proof.state === "finalized" && proof.txId === r.transaction.id && proof.blockId === r.finality.blockId && proof.height === r.finality.height,
        "Reconfirm every saved payment irreversibly before transferring hosts");
      proofs.push(proof);
    }
    const nextNonce = await this.#client.provider.getNextNonce(this.#owner);
    check(snapshot.records.every(r => nonce(nextNonce) > nonce(r.draft.header.nonce)), "Confirmed wallet nonce has not advanced");
    signal?.throwIfAborted(); this.#authorize();
    this.#review = { id: crypto.randomUUID(), fingerprint: snapshot.fingerprint, sourceHost: snapshot.sourceHost, targetHost: host(),
      directory: this.#directory, owner: this.#owner, generation: snapshot.anchor.generation, checkedAt: this.#clock(), proofs, nextNonce };
    return structuredClone(this.#review);
  }
  apply(review, { approved = false, backupDirectory } = {}) {
    this.#authorize();
    check(approved === true && this.#review && isDeepStrictEqual(review, this.#review), "Approve the exact payment host-transfer review first");
    check(this.#clock() >= review.checkedAt && this.#clock() - review.checkedAt <= 60000, "Payment host-transfer review expired");
    const target = path.resolve(filesystemPath(backupDirectory || ""));
    check(backupDirectory && !fs.existsSync(target) && path.dirname(target) === fs.realpathSync(path.dirname(target)) &&
      target !== this.#directory && !target.startsWith(this.#directory + path.sep), "New physical external backup directory required");
    const anchorPath = this.#directory + ".recovery-anchor.sqlite", anchor = open(anchorPath, false);
    let locked = false;
    try {
      anchor.exec("BEGIN IMMEDIATE"); locked = true;
      const current = this.#snapshot(anchor);
      check(current.fingerprint === review.fingerprint && review.targetHost === host(), "Payment history changed after review");
      // The anchor writer lock excludes all normal journal writers. Back up the
      // complete SQLite contents, including committed WAL pages, before rebinding.
      fs.mkdirSync(target, { mode: 0o700 });
      const files = [];
      for (const source of [anchorPath, ...FILES.map(f => path.join(this.#directory, f))]) {
        const db = open(source), output = path.join(target, path.basename(source));
        try { db.prepare("VACUUM INTO ?").run(sqlitePath(output)); } finally { db.close(); }
        fs.chmodSync(output, 0o600); sync(output); files.push({ name: path.basename(output), sha256: hash(fs.readFileSync(output)) });
      }
      const manifest = path.join(target, "host-transfer-review.json");
      fs.writeFileSync(manifest, json({ ...review, files }) + "\n", { flag: "wx", mode: 0o600 }); sync(manifest);
      if (process.platform !== "win32") sync(target);
      this.#authorize();
      check(this.#clock() - review.checkedAt <= 60000, "Payment host-transfer review expired while backing up");
      anchor.exec("CREATE TABLE IF NOT EXISTS host_transfers(id TEXT PRIMARY KEY, data TEXT NOT NULL)");
      anchor.prepare("INSERT INTO host_transfers VALUES(?,?)").run(review.id, json({ ...review, appliedAt: this.#clock(), backupDirectory: target }));
      check(anchor.prepare("UPDATE ownership SET host=? WHERE id=1 AND host=?").run(review.targetHost, review.sourceHost).changes === 1, "Payment host changed during transfer");
      anchor.exec("COMMIT"); locked = false; this.#review = null;
      return { id: review.id, transferred: true, generation: review.generation, backupDirectory: target, transactions: review.proofs.map(p => p.txId) };
    } finally { if (locked) anchor.exec("ROLLBACK"); anchor.close(); }
  }
}
module.exports = { PurchaseHostTransfer };
