"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const P = require("../core/lib/koin-network/job-protocol");
const HOST_CONFLICT = "This Test wallet is already bound to another installation. Recover that installation or use a separately invited Test wallet";
const UNAVAILABLE = "This wallet's signing lease is unavailable. Keep the saved payment for recovery on its original computer.";
const identity = config => P.hash(JSON.stringify([config.owner, config.schedulerUrl, config.deployment.chainId]));
function protectedStorage(storage) {
  const { isProtectedStorage, storageState } = require("../core/lib/protected-storage");
  if (!isProtectedStorage(storage)) throw Error(storageState(storage).detail);
}
function regular(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.size > 16384)) throw Error("Review saved payment installation records before signing");
}
function read(file, storage) {
  regular(file);
  return JSON.parse(storage.decryptString(fs.readFileSync(file)));
}
function checked(file, config, storage) {
  const saved = read(file, storage);
  if (saved.identity !== identity(config)) throw Error("Payment installation identity changed");
  return P.digest(saved.installation);
}
function stableFile(dataDir, config) {
  const root = path.join(dataDir, "credit-wallet-hosts");
  if (fs.existsSync(root)) regular(root, true);
  return path.join(root, identity(config) + ".enc");
}
function remember(dataDir, config, storage, id) {
  const file = stableFile(dataDir, config);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); regular(path.dirname(file), true);
  if (fs.existsSync(file)) {
    if (checked(file, config, storage) !== id) throw Error("The saved wallet signing identity changed; keep its records for recovery");
    return;
  }
  const bytes = storage.encryptString(JSON.stringify({ identity: identity(config), installation: id }));
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function localCandidates({ dataDir, directory, config, storage }) {
  const candidates = new Set(), add = id => {
    candidates.add(P.digest(id));
    if (candidates.size > 64) throw Error("Too many saved wallet signing identities; review before payment");
  };
  // Read only this Foundation profile. Never search another computer or adopt
  // an Alpha profile. Context metadata selects the wallet before decryption.
  const root = path.join(dataDir, "credit-account-v2");
  if (fs.existsSync(root)) {
    regular(root, true);
    const accounts = fs.readdirSync(root); if (accounts.length > 256) throw Error("Too many saved credit accounts; review before payment");
    for (const account of accounts.filter(name => /^[a-f0-9]{64}$/.test(name)).sort()) {
      const accountDir = path.join(root, account); regular(accountDir, true);
      const contexts = fs.readdirSync(accountDir); if (contexts.length > 256) throw Error("Too many saved credit configurations; review before payment");
      for (const context of contexts.filter(name => /^[a-f0-9]{64}$/.test(name)).sort()) {
        const dir = path.join(accountDir, context); regular(dir, true);
        if (dir === directory) continue;
        const file = path.join(dir, "purchase-installation.enc"); if (!fs.existsSync(file)) continue;
        const metadata = path.join(dir, "context.json"); regular(metadata);
        const saved = JSON.parse(fs.readFileSync(metadata, "utf8"));
        if (saved.config?.owner !== config.owner || saved.config?.schedulerUrl !== config.schedulerUrl || saved.config?.deployment?.chainId !== config.deployment.chainId) continue;
        add(checked(file, config, storage));
      }
    }
  }
  for (const name of ["koin-foundation-test", "koin-prepaid-v1", "koin-prepaid-usd-v1"]) {
    const old = path.join(dataDir, name, "test-access.enc"); if (!fs.existsSync(old)) continue;
    regular(path.dirname(old), true); const saved = read(old, storage);
    if (saved.credential?.owner === config.owner && saved.credential?.schedulerUrl === config.schedulerUrl) add(saved.installation);
  }
  return [...candidates];
}
// Reuses an authenticated public account session; creates no account credential.
// The local installation identifier only coordinates the existing signing lease.
function installation({ dataDir, directory, config, storage }) {
  protectedStorage(storage);
  const stable = stableFile(dataDir, config);
  if (fs.existsSync(stable)) return checked(stable, config, storage);
  const file = path.join(directory, "purchase-installation.enc");
  if (fs.existsSync(file)) return checked(file, config, storage);
  const id = localCandidates({ dataDir, directory, config, storage })[0] || crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, storage.encryptString(JSON.stringify({ identity: identity(config), installation: id })), { mode: 0o600, flag: "wx" });
  return id;
}
async function claimHost({ c, account, wallet, installation: id, dataDir, storage, fetchImpl = fetch, signal }) {
  const guard = () => { signal?.throwIfAborted(); account.assertCreditAuthorization(c.auth, c.config.schedulerUrl); if (wallet.address !== c.config.owner) throw Error("Unlock the payment wallet linked to this account"); };
  const request = async candidate => {
    guard();
    const response = await fetchImpl(c.config.schedulerUrl + "/koin/test/lease", { method: "POST", redirect: "error", signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(10000)]),
      headers: { "content-type": "application/json", authorization: "Bearer " + c.auth.sessionToken }, body: JSON.stringify({ installation: candidate, creditWallet: c.config.owner }) });
    const parts = []; let size = 0;
    for await (const part of response.body) { guard(); size += part.length; if (size > 4096) throw Error("Invalid payment host response"); parts.push(part); }
    guard(); const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (response.status === 400 && value.error === HOST_CONFLICT) return null;
    if (!response.ok || value.mode !== c.config.mode || value.chainId !== c.config.deployment.chainId || value.owner !== c.config.owner || value.installation !== candidate || value.granted !== true)
      throw Error(UNAVAILABLE);
    return value;
  };
  let granted = await request(P.digest(id));
  if (!granted && dataDir && storage) {
    protectedStorage(storage);
    // Only an explicit binding conflict permits trying identities already saved
    // for this wallet in this profile. Authentication/network failures do not.
    const stable = stableFile(dataDir, c.config);
    if (!fs.existsSync(stable)) for (const candidate of localCandidates({ dataDir, directory: c.directory, config: c.config, storage })) {
      if (candidate === id) continue;
      granted = await request(candidate); if (granted) break;
    }
  }
  if (!granted) throw Error(UNAVAILABLE);
  guard();
  if (dataDir && storage) { protectedStorage(storage); remember(dataDir, c.config, storage, granted.installation); }
  return granted;
}
module.exports = { installation, claimHost };
