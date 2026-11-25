"use strict";
const fs = require("node:fs"), path = require("node:path"), { isDeepStrictEqual } = require("node:util");
const { DatabaseSync } = require("node:sqlite"), { sqlitePath } = require("../core/lib/sqlite-path");
const P = require("../core/lib/koin-network/job-protocol");
const { guardOtherJournals } = require("./credit-purchase-journals");
const identity = config => P.hash(JSON.stringify([config.owner, config.schedulerUrl, config.deployment.chainId]));
function exists(file) { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
function regular(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw Error("Choose an original payment folder on this computer, without linked files");
  return stat;
}
function small(file) {
  if (regular(file).size > 16384) throw Error("Saved purchase connection is too large; its records have been preserved");
  return fs.readFileSync(file);
}
function protectedStorage(storage) {
  const { isProtectedStorage, storageState } = require("../core/lib/protected-storage");
  if (!isProtectedStorage(storage)) throw Error(storageState(storage).detail);
}
function read(file, fn) {
  regular(file); const db = new DatabaseSync(sqlitePath(file), { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; BEGIN");
    if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw Error("Recover the damaged payment journal before reconnecting");
    return fn(db);
  } finally { db.close(); }
}
function recordFile(dataDir, config) {
  const root = path.join(dataDir, "credit-purchase-recovery");
  if (exists(root)) regular(root, true);
  return path.join(root, identity(config) + ".enc");
}
function source(profile, directory, c, storage) {
  if (!path.isAbsolute(profile) || !path.isAbsolute(directory)) throw Error("An original absolute payment folder is required");
  regular(profile, true);
  const parts = path.relative(profile, directory).split(path.sep);
  if (parts.length !== 4 || parts[0] !== "credit-account-v2" || !parts.slice(1, 3).every(p => /^[a-f0-9]{64}$/.test(p)) || parts[3] !== "journals") throw Error("Select an original credit account journal");
  let cursor = profile;
  for (const part of parts) { cursor = path.join(cursor, part); regular(cursor, true); }
  const context = path.dirname(directory), saved = JSON.parse(small(path.join(context, "context.json")).toString("utf8"));
  const cfg = saved?.config;
  if (saved.accountId !== c.auth.accountId || cfg?.owner !== c.config.owner || cfg?.schedulerUrl !== c.config.schedulerUrl || cfg?.mode !== c.config.mode ||
      cfg?.maxRcPerDay !== c.config.maxRcPerDay || !isDeepStrictEqual(cfg?.deployment, c.config.deployment))
    throw Error("The selected purchase records belong to another account, wallet or payment configuration");
  const access = JSON.parse(storage.decryptString(small(path.join(context, "purchase-installation.enc"))));
  if (access.identity !== identity(c.config)) throw Error("The selected signing connection belongs to another wallet or service");
  const installation = P.digest(access.installation);
  const anchor = read(directory + ".recovery-anchor.sqlite", db => db.prepare("SELECT pair_id,directory FROM anchor WHERE id=1").get());
  if (!anchor || typeof anchor.pair_id !== "string" || anchor.directory !== fs.realpathSync(directory)) throw Error("Keep the payment journal in its original folder on its original computer");
  for (const name of ["funding-recovery.sqlite", "wallet-nonces.sqlite"]) regular(path.join(directory, name));
  return { profile, directory, installation, pairId: anchor.pair_id };
}
function resolve({ dataDir, c, storage }) {
  const file = recordFile(dataDir, c.config);
  if (!exists(file)) return null;
  protectedStorage(storage);
  const saved = JSON.parse(storage.decryptString(small(file)));
  if (saved?.schema !== 1 || saved.identity !== identity(c.config) || typeof saved.profile !== "string" || typeof saved.directory !== "string") throw Error("Saved purchase recovery connection is invalid; its records have been preserved");
  const current = source(saved.profile, saved.directory, c, storage);
  if (current.installation !== saved.installation || current.pairId !== saved.pairId) throw Error("The original purchase connection changed; keep its records for recovery");
  return current;
}
function findSource(profile, c, storage) {
  regular(profile, true); profile = fs.realpathSync(profile);
  const account = path.join(profile, "credit-account-v2", P.hash(c.auth.accountId));
  regular(path.dirname(account), true); regular(account, true);
  const entries = fs.readdirSync(account);
  if (entries.length > 256) throw Error("Too many saved credit configurations; review the selected profile first");
  const candidates = [];
  for (const entry of entries.filter(p => /^[a-f0-9]{64}$/.test(p)).sort()) {
    const dir = path.join(account, entry); regular(dir, true);
    const saved = JSON.parse(small(path.join(dir, "context.json")).toString("utf8"));
    if (saved.accountId !== c.auth.accountId || saved.config?.owner !== c.config.owner || saved.config?.schedulerUrl !== c.config.schedulerUrl ||
        saved.config?.deployment?.chainId !== c.config.deployment.chainId || !fs.existsSync(path.join(dir, "purchase-installation.enc"))) continue;
    candidates.push(source(profile, path.join(dir, "journals"), c, storage));
  }
  if (candidates.length !== 1) throw Error(candidates.length ? "More than one saved purchase connection matches; keep them for individual recovery" : "No purchase connection for this wallet and account was found in the selected profile");
  return candidates[0];
}
function guard(dataDir, selected, config) {
  guardOtherJournals(dataDir, selected.directory, config);
  if (path.resolve(dataDir) !== path.resolve(selected.profile)) guardOtherJournals(selected.profile, selected.directory, config);
}
// Use the original coordinated journal in place. Never copy an installation ID
// into a separate nonce coordinator or restore an older journal generation.
async function recover({ dataDir, c, storage, account, window, dialog, fetchImpl, clientFactory, signal }) {
  const wallet = account.wallet;
  const check = () => {
    signal?.throwIfAborted(); account.assertCreditAuthorization(c.auth, c.config.schedulerUrl); protectedStorage(storage);
    if (account.settings?.get?.("network.privacyMode", "local-only") === "local-only") throw Error("Choose an online mode before recovering the purchase connection");
    if (account.wallet !== wallet || wallet?.address !== c.config.owner || !wallet.status?.().unlocked || c.auth.sessionOnly ||
        !window || window.isDestroyed?.() || !window.isVisible?.() || window.isMinimized?.()) throw Error("Return to Core with this wallet unlocked to recover its purchase connection");
  };
  check();
  if (resolve({ dataDir, c, storage })) return { state: "connected", detail: "The original purchase connection is already selected." };
  const choice = await dialog.showOpenDialog(window, { title: "Choose the old Koinos AI profile folder", buttonLabel: "Select profile", properties: ["openDirectory"] });
  check(); if (choice.canceled || choice.filePaths.length !== 1) return { state: "cancelled" };
  const selected = findSource(choice.filePaths[0], c, storage);
  if (path.resolve(selected.profile) === path.resolve(dataDir)) throw Error("Choose the older app's profile folder");
  guard(dataDir, selected, c.config);
  const reviewed = await dialog.showMessageBox(window, { type: "question", title: "Recover purchase connection", message: "Use this wallet's original purchase connection?",
    detail: `Wallet: ${c.config.owner}\nOriginal profile: ${selected.profile}\n\nCore will use the payment history in this original folder. Keep the folder available for future purchases and payment recovery. Existing records stay in place. New purchases still require a separate approval.`,
    buttons: ["Cancel", "Use original connection"], defaultId: 0, cancelId: 0, noLink: true });
  check(); if (reviewed.response !== 1) return { state: "cancelled" };
  const verify = () => {
    check(); guard(dataDir, selected, c.config);
    if (!isDeepStrictEqual(source(selected.profile, selected.directory, c, storage), selected)) throw Error("The selected purchase records changed during recovery");
    const ids = name => read(path.join(selected.directory, name === "deposits" ? "funding-recovery.sqlite" : "wallet-nonces.sqlite"), db => {
      const rows = db.prepare(`SELECT id FROM ${name} LIMIT 10001`).all();
      if (rows.length > 10000) throw Error("Review the large payment history before reconnecting");
      return rows.map(row => row.id);
    });
    const deposits = ids("deposits"), reservations = ids("reservations");
    const journal = new (require("./koin-funding-recovery").FundingRecovery)(selected.directory, {
      mode: c.config.mode, client: clientFactory(c.config.deployment), maxRcPerDay: c.config.maxRcPerDay
    });
    try {
      for (const id of deposits) journal.saved(id);
      for (const id of reservations) journal.nonceCoordinator.status(id);
    } finally { journal.close(); }
  };
  verify();
  // The authenticated server must accept this exact saved identity. No reset,
  // alternate-ID search, signature or payment happens during reconnection.
  await require("./credit-purchase-access").claimHost({ c, account, wallet, installation: selected.installation, fetchImpl, signal });
  verify();
  const file = recordFile(dataDir, c.config);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); regular(path.dirname(file), true);
  const bytes = storage.encryptString(JSON.stringify({ schema: 1, identity: identity(c.config), ...selected }));
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { state: "connected", detail: "Original purchase connection recovered. You can review your purchase again." };
}
module.exports = { resolve, recover, guard };
