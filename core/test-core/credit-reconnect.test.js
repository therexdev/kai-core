"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { Signer } = require("koilib"), { WalletService } = require("../lib/wallet"), { AccountService } = require("../lib/account");
const { CreditService } = require("../../electron/credit-service"), WalletProof = require("../lib/wallet-credit-account");
const packaged = require("../lib/koin-network/credit-service.json"), config = packaged.config, origin = new URL(config.schedulerUrl).origin;
const oldPassword = "Synthetic Alpha password only!";
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-credit-reconnect-")));
  const alpha = new WalletService(path.join(root, "alpha-wallet")), signer = Signer.fromSeed("public synthetic credit migration fixture"); alpha.restore({ wif: signer.getPrivateKey("wif"), password: oldPassword }); alpha.lock();
  const coreDir = path.join(root, "fresh-core"); fs.mkdirSync(path.join(coreDir, "wallet"), { recursive: true });
  fs.copyFileSync(alpha.keystorePath, path.join(coreDir, "wallet", "wallet.json"));
  const wallet = new WalletService(path.join(coreDir, "wallet"));
  let privacy = "local-first", approved = true, capabilityError = false, authorizationError = null, challenge = null, signs = 0;
  const calls = [], reviews = [], oldBytes = fs.readFileSync(alpha.keystorePath), pin = WalletProof.pin(config, origin);
  const sessionToken = "wc_" + crypto.randomBytes(32).toString("base64url"), accountId = "original-wallet-credit-account";
  const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "test-protected", encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
  const settings = { get: (key, fallback) => key === "network.privacyMode" ? privacy : fallback };
  const accountView = () => ({ id: accountId, scope: "wallet-credits", freeOnly: false, wallets: [{ address: wallet.address }] });
  const history = { purchases: [{ id: "synthetic-purchase", createdAt: 1, confirmedAt: 2, state: "confirmed", credits: "200000000" }], usage: [{ id: "synthetic-usage", at: 3, credits: "1000000", model: "koinos-fast" }] };
  const fakeFetch = async (url, init = {}) => {
    const route = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : null; calls.push({ route, body });
    if (route === "/auth/wallet-credit/capabilities") return capabilityError ? Response.json({ ok: false, error: "Service unavailable" }, { status: 503 }) : Response.json({ ok: true, capabilities: { walletCredits: 1, freeOnlySessions: 1, scope: "wallet-credits", ...pin, challengeTtlMs: 300000, sessionTtlMs: 2592000000 } });
    if (route === "/auth/wallet-credit/challenge") {
      assert.equal(body.address, signer.getAddress()); assert.equal(body.freeOnly, false); const at = Date.now();
      challenge = { schema: 1, purpose: "wallet-credit-session", ...pin, ...body, nonce: crypto.randomBytes(32).toString("hex"), issuedAt: at, expiresAt: at + 300000, sessionExpiresAt: at + 2592000000 };
      return Response.json({ ok: true, challenge });
    }
    if (route === "/auth/wallet-credit/verify") {
      assert.equal(body.challengeId, challenge.nonce); assert.equal(Signer.recoverAddress(WalletProof.challengeHash(challenge), Buffer.from(body.signature, "base64")), signer.getAddress()); signs++;
      return Response.json({ ok: true, scope: "wallet-credits", freeOnly: false, token: sessionToken, expiresAt: challenge.sessionExpiresAt, account: accountView() });
    }
    if (route === "/auth/session") {
      if (authorizationError) throw authorizationError;
      assert.equal(init.headers.authorization, "Bearer " + sessionToken);
      return Response.json({ ok: true, scope: "wallet-credits", freeOnly: false, account: accountView() });
    }
    if (route === new URL(config.schedulerUrl).pathname + "/koin/prepaid/status") {
      const connected = body.sessionToken === sessionToken; assert.equal(body.creditWallet, connected ? signer.getAddress() : null);
      const purchased = connected ? "199000000" : "0", free = "1000000";
      return Response.json({ ok: true, product: "prepaid-usd-v1", mode: config.mode, paymentsEnabled: true, owner: connected ? signer.getAddress() : "account-" + "f".repeat(64),
        credits: { available: String(BigInt(purchased) + BigInt(free)), purchased: { available: purchased }, free: { available: free, state: "available" }, unit: "USD-1e-8", version: "3" }, ...(connected ? history : { purchases: [], usage: [] }) });
    }
    throw Error("Unexpected network operation: " + route);
  };
  const account = new AccountService({ dataDir: coreDir, settings, wallet, safeStorage: storage, accountOrigin: origin, fetchImpl: fakeFetch });
  const deviceAuth = { deviceFree: true, sessionOnly: true, scope: "device-free", accountId: "new-installation-free-account", owner: "account-" + "f".repeat(64), sessionToken: "fixture-free-token", schedulerUrl: config.schedulerUrl };
  const deviceFree = { creditAuthorization: async () => deviceAuth, assertCreditAuthorization() {}, clear() {}, dispose() {} };
  const options = { dataDir: coreDir, account, storage, service: packaged, fetchImpl: fakeFetch, deviceFreeAccount: deviceFree, dialog: { showMessageBox: async (_window, review) => { reviews.push(review); return { response: approved ? 1 : 0 }; } } };
  const service = new CreditService(options), window = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false };
  t.after(() => { service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, coreDir, wallet, account, service, window, calls, reviews, history, sessionToken, accountId, options, alpha,
    signs: () => signs, approve: value => approved = value, mode: value => privacy = value, failCapabilities: () => capabilityError = true, failAuthorization: value => authorizationError = value,
    unchanged() { assert.deepEqual(fs.readFileSync(alpha.keystorePath), oldBytes); } };
}
test("an imported wallet remains visibly disconnected from paid credits even while free access works", async t => {
  const f = fixture(t), free = await f.service.run("credit-status");
  assert.equal(free.accessKind, "device-free"); assert.equal(free.paidAccessLocked, true); assert.deepEqual(free.purchases, []);
  const locked = await f.service.walletInfo(); assert.equal(locked.state, "wallet-unlock-required"); assert.equal(locked.freeAccess, true); assert.equal(locked.canConnect, false);
  f.wallet.unlock(oldPassword); const ready = await f.service.walletInfo(); assert.equal(ready.state, "wallet-connection-required"); assert.equal(ready.canConnect, true); assert.equal(ready.connected, false);
  assert.equal(f.signs(), 0); assert.equal(f.account._token(), null); assert.deepEqual(f.reviews, []); f.unchanged();
});
test("reviewed proof from a fresh profile restores the same wallet's purchased balance and remote activity", async t => {
  const f = fixture(t); f.wallet.unlock(oldPassword);
  const result = await f.service.connectWallet(f.window, { sessionOnly: false }); assert.equal(result.state, "connected"); assert.equal(result.accountId, f.accountId); assert.equal(f.signs(), 1);
  assert.equal(f.reviews.length, 1); assert.match(f.reviews[0].detail, /does not transfer KOIN/);
  const paid = await f.service.run("credit-status"); assert.equal(paid.owner, f.wallet.address); assert.equal(paid.credits.purchased.available, "199000000"); assert.deepEqual(paid.purchases, f.history.purchases); assert.deepEqual(paid.usage, f.history.usage); assert.equal(paid.accessKind, undefined);
  f.wallet.lock(); assert.equal((await f.service.walletInfo()).connected, true); assert.equal((await f.service.run("credit-status")).credits.purchased.available, "199000000");
  const reopenedAccount = new AccountService({ dataDir: f.coreDir, settings: f.account.settings, wallet: f.wallet, safeStorage: f.options.storage, accountOrigin: origin, fetchImpl: f.options.fetchImpl });
  const reopened = new CreditService({ ...f.options, account: reopenedAccount }); try { const restored = await reopened.run("credit-status"); assert.deepEqual(restored.usage, f.history.usage); assert.equal(restored.owner, f.wallet.address); } finally { reopened.dispose(); }
  assert.ok(!f.calls.some(call => /quote|purchase|transaction/.test(call.route))); f.unchanged();
});
test("cancelled wallet proof and Local-Only never authorize or move a purchased balance", async t => {
  const f = fixture(t); f.wallet.unlock(oldPassword); f.approve(false);
  assert.equal((await f.service.connectWallet(f.window)).state, "cancelled"); assert.equal(f.signs(), 0); assert.equal(f.account._token(), null);
  assert.ok(!f.calls.some(call => /challenge|verify/.test(call.route)));
  f.mode("local-only"); const count = f.calls.length; assert.equal((await f.service.walletInfo()).state, "online-required"); assert.equal(f.calls.length, count);
});
test("a network outage or conflicting saved identity cannot be hidden by guest fallback or replaced", async t => {
  const f = fixture(t); f.wallet.unlock(oldPassword); await f.service.connectWallet(f.window);
  const saved = fs.readFileSync(f.account.file); f.failAuthorization(Object.assign(Error("Saved identity changed"), { code: "identity-changed" }));
  const info = await f.service.walletInfo(); assert.equal(info.state, "identity-changed"); assert.equal(info.canConnect, false); assert.deepEqual(fs.readFileSync(f.account.file), saved);
  await assert.rejects(f.service.run("credit-status"), /Saved identity changed/); assert.equal(f.signs(), 1);
});
test("a verified email account for another wallet remains saved and gets account-selection guidance", async t => {
  const f = fixture(t), original = f.account.creditAuthorization;
  f.account.creditAuthorization = async () => ({ owner: "account-" + "a".repeat(64), accountId: "another-account", sessionOnly: false });
  try { const info = await f.service.walletInfo(); assert.equal(info.state, "wallet-changed"); assert.equal(info.canConnect, false); assert.match(info.detail, /preserved/); assert.equal(f.signs(), 0); } finally { f.account.creditAuthorization = original; }
});
test("failed wallet capabilities leave free access identifiable but do not offer unverified paid access", async t => {
  const f = fixture(t); f.wallet.unlock(oldPassword); f.failCapabilities(); const info = await f.service.walletInfo();
  assert.equal(info.freeAccess, true); assert.equal(info.canConnect, false); assert.equal(info.connected, false); assert.match(info.detail, /unavailable/); assert.equal(f.signs(), 0);
});
