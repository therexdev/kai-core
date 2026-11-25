"use strict";
// Read-only, local diagnostics. Never load a wallet, decrypt credentials, invoke
// journal constructors, contact a service, or authorize recovery from this report.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const legacy = ["koin-foundation-test", "koin-prepaid-v1", "koin-prepaid-usd-v1"];
const specs = [
  ["funding-recovery.sqlite", "deposits", ["signing", "staged", "unknown", "needs_review"], ["funded", "reverted", "conflicted"]],
  ["wallet-nonces.sqlite", "reservations", ["signing", "signed"], ["finalized", "reverted", "consumed_elsewhere"]]
];
class DiagnosticError extends Error {}
function fail(code) { throw new DiagnosticError(code); }
function code(error) { return error instanceof DiagnosticError ? error.message : "UNREADABLE_OR_UNSUPPORTED"; }
function exists(file) { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } }
function regular(file, directory = false) {
  const s = fs.lstatSync(file);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) fail("LINKED_OR_INVALID_PATH");
  if (!directory && s.size > 256 * 1024 * 1024) fail("JOURNAL_TOO_LARGE");
}
function read(file, fn) {
  regular(file);
  const db = new DatabaseSync(process.platform === "win32" ? path.toNamespacedPath(file) : file, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=3000; BEGIN");
    if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") fail("SQLITE_INTEGRITY_FAILED");
    return fn(db);
  } finally { db.close(); }
}
function anchor(file) {
  return read(file, db => ({
    row: db.prepare("SELECT * FROM anchor WHERE id=1").get(),
    owner: db.prepare("SELECT host FROM ownership WHERE id=1").get(),
    attached: db.prepare("SELECT name,generation FROM attached_files ORDER BY name").all(),
    leases: db.prepare("SELECT host,pid FROM leases").all()
  }));
}
function summarize(file, spec, wallet) {
  return read(file, db => {
    const identity = db.prepare("SELECT data FROM identity WHERE id=1").get()?.data;
    if (typeof identity !== "string" || identity.length > 65536) fail("IDENTITY_MISSING_OR_INVALID");
    const parsed = JSON.parse(identity), chain = parsed.chainId || parsed.deployment?.chainId;
    if (typeof chain !== "string" || !chain || chain.length > 1024) fail("IDENTITY_MISSING_OR_INVALID");
    const allStates = [...spec[2], ...spec[3]], counts = {};
    let total = 0, pending = 0, unknown = 0, inconsistent = 0;
    const rows = db.prepare(`SELECT id,owner,state,tx_id,hash,data FROM ${spec[1]} WHERE owner=?`);
    for (const row of rows.iterate(wallet)) {
      if (++total > 10000 || typeof row.data !== "string" || row.data.length > 1024 * 1024) fail("RECORD_LIMIT_EXCEEDED");
      if (allStates.includes(row.state)) counts[row.state] = (counts[row.state] || 0) + 1;
      else unknown++;
      if (spec[2].includes(row.state)) pending++;
      try {
        const data = JSON.parse(row.data), owner = spec[1] === "deposits" ? data.intent?.actor : data.owner;
        if (row.hash !== hash(row.data) || data.id !== row.id || owner !== row.owner || data.state !== row.state || data.draft?.id !== row.tx_id) inconsistent++;
      } catch { inconsistent++; }
    }
    const generation = db.prepare("SELECT pair_id,generation FROM recovery_generation WHERE id=1").get();
    return { generation, report: {
      file: spec[0], state: "observed", chainFingerprint: hash(chain), identityFingerprint: hash(identity),
      walletRecords: total, states: counts, pendingRecords: pending, unrecognizedStates: unknown, inconsistentRecords: inconsistent
    } };
  });
}
function journal(directory, root, wallet) {
  const result = { directory: path.relative(root, directory), files: [] };
  try {
    regular(directory, true);
    const witness = directory + ".recovery-anchor.sqlite";
    let before;
    try { before = anchor(witness); } catch (e) { result.anchor = exists(witness) ? code(e) : "MISSING"; }
    const generations = new Map();
    for (const spec of specs) {
      const file = path.join(directory, spec[0]);
      if (!exists(file)) { result.files.push({ file: spec[0], state: "missing" }); continue; }
      try { const value = summarize(file, spec, wallet); result.files.push(value.report); generations.set(spec[0], value.generation); }
      catch (e) { result.files.push({ file: spec[0], state: "blocked", code: code(e) }); }
    }
    if (before) {
      const after = anchor(witness);
      if (JSON.stringify(before) !== JSON.stringify(after)) result.anchor = "CHANGED_DURING_READ";
      else {
        const row = before.row, expected = new Map(before.attached.map(r => [r.name, r.generation]));
        const valid = row && Number.isSafeInteger(row.generation) && row.generation >= 0 &&
          row.directory === fs.realpathSync(directory) && row.files === JSON.stringify(specs.map(s => s[0]).sort()) &&
          expected.size === generations.size && [...expected].every(([name, gen]) => {
            const found = generations.get(name);
            return found && found.pair_id === row.pair_id && Number.isSafeInteger(gen) && gen >= 0 && found.generation === gen;
          }) && Math.max(0, ...before.attached.map(r => r.generation)) === row.generation;
        result.anchor = valid ? "GENERATIONS_MATCH" : "IDENTITY_OR_GENERATION_MISMATCH";
        const host = { hostname: os.hostname(), platform: process.platform, arch: process.arch };
        result.sameHost = before.owner?.host === JSON.stringify(host);
        result.liveLocalWriterProcesses = before.leases.filter(r => {
          if (r.host !== os.hostname() || !Number.isSafeInteger(r.pid) || r.pid < 1) return false;
          try { process.kill(r.pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
        }).length;
      }
    }
  } catch (e) { result.state = "blocked"; result.code = code(e); }
  return result;
}
function profile(name, root, wallet) {
  const result = { profile: name, exists: exists(root), installationRecords: [], journals: [] };
  if (!result.exists) return result;
  try {
    regular(root, true);
    const contexts = [];
    for (const folder of legacy) {
      const dir = path.join(root, folder);
      if (!exists(dir)) continue;
      regular(dir, true); contexts.push(dir);
      if (exists(path.join(dir, "test-access.enc"))) result.installationRecords.push(folder + "/test-access.enc");
    }
    const accounts = path.join(root, "credit-account-v2");
    if (exists(accounts)) {
      regular(accounts, true);
      const entries = fs.readdirSync(accounts); if (entries.length > 256) fail("DIRECTORY_LIMIT_EXCEEDED");
      for (const account of entries.filter(x => /^[a-f0-9]{64}$/.test(x)).sort()) {
        const folder = path.join(accounts, account); regular(folder, true);
        const children = fs.readdirSync(folder); if (children.length > 256) fail("DIRECTORY_LIMIT_EXCEEDED");
        for (const context of children.filter(x => /^[a-f0-9]{64}$/.test(x)).sort()) {
          const dir = path.join(folder, context); regular(dir, true); contexts.push(dir);
          if (contexts.length > 256) fail("DIRECTORY_LIMIT_EXCEEDED");
          if (exists(path.join(dir, "purchase-installation.enc"))) result.installationRecords.push(path.relative(root, path.join(dir, "purchase-installation.enc")));
        }
      }
    }
    const stable = path.join(root, "credit-wallet-hosts");
    if (exists(stable)) {
      regular(stable, true); const entries = fs.readdirSync(stable);
      if (entries.length > 256) fail("DIRECTORY_LIMIT_EXCEEDED");
      for (const file of entries.filter(x => /^[a-f0-9]{64}\.enc$/.test(x)).sort()) result.installationRecords.push("credit-wallet-hosts/" + file);
    }
    for (const dir of contexts) {
      const journals = path.join(dir, "journals");
      if (exists(journals)) result.journals.push(journal(journals, root, wallet));
      else if (exists(journals + ".recovery-anchor.sqlite")) result.journals.push({ directory: path.relative(root, journals), state: "blocked", code: "JOURNAL_DIRECTORY_MISSING" });
    }
    result.state = "inspection-complete";
  } catch (e) { result.state = "blocked"; result.code = code(e); }
  return result;
}
function diagnose(appdata, wallet) {
  if (!path.isAbsolute(appdata || "") || !/^[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(wallet || "")) fail("ABSOLUTE_APPDATA_AND_PUBLIC_WALLET_REQUIRED");
  return { schema: 1, purpose: "read-only-credit-profile-diagnostic", paymentsAuthorized: false,
    profiles: [
      ["Alpha", ["Koinos AI", "core"]], ["Core", ["KAI Core", "foundation-v1"]], ["EarlierCore", ["KAI Core Beta", "foundation-v1"]]
    ].map(([name, parts]) => profile(name, path.join(appdata, ...parts), wallet)),
    limitations: ["State counts and row hashes do not verify on-chain finality or authorize a migration.", "Reports are observations only; running applications can change journals after inspection.", "Installation records are listed only; no credential or wallet file is opened."]
  };
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--wallet") fail("PUBLIC_WALLET_ARGUMENT_REQUIRED");
    process.stdout.write(JSON.stringify(diagnose(process.env.APPDATA, args[1]), null, 2) + "\n");
  } catch (e) { process.stdout.write(JSON.stringify({ state: "blocked", code: code(e) }) + "\n"); process.exitCode = 1; }
}
module.exports = { diagnose };
