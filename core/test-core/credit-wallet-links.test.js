"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { Signer } = require("koilib"), { AccountService } = require("../lib/account");
const origin = "https://credits.koinosai.com", accountId = "acc_1111111111111111", originalId = "acc_2222222222222222";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-core-credit-link-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const signer = Signer.fromSeed("core-credit-link"), address = signer.getAddress(), requests = [];
  let session = { ok: true, account: { id: accountId, email: "signed-in@example.test", wallets: [{ address, creditAccountId: originalId, creditAccessOnly: true }] } }, beforeSign;
  const wallet = { address, status: () => ({ address: wallet.address, unlocked: true }), signHash: async h => { await beforeSign?.(); return Buffer.from(await signer.signHash(h)).toString("base64"); } };
  const account = new AccountService({ dataDir: dir, wallet, accountOrigin: origin, settings: { get: (k, fallback) => k === "network.privacyMode" ? "network" : fallback },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() },
    fetchImpl: async (url, init) => { requests.push({ url, init }); return Response.json(url.endsWith("/auth/session") ? session : { ok: true, account: session.account }); } });
  account._saveToken("sk_" + "a".repeat(43));
  return { account, wallet, requests, address, review: { accountId, address }, setSession: s => { session = s; }, beforeSign: fn => { beforeSign = fn; } };
}
test("Core signs explicit credit access for the reviewed website account and origin without exposing its key", async t => {
  const f = fixture(t); await f.account.linkWallet(f.review);
  const req = f.requests.at(-1), proof = JSON.parse(req.init.body);
  assert.equal(req.url, origin + "/account/credit-wallets");
  const hash = crypto.createHash("sha256").update(JSON.stringify(["KAI-CREDIT-WALLET-LINK-V1", origin, f.address, accountId, proof.ts])).digest();
  assert.equal(Signer.recoverAddress(hash, Buffer.from(proof.signature, "base64")), f.address);
  assert.equal(Object.keys(proof).sort().join(), "address,signature,ts");
  assert.equal(f.account._token(), "sk_" + "a".repeat(43));
});
test("linking rejects changed account, wallet, scoped login or a late wallet signature", async t => {
  const f = fixture(t);
  await assert.rejects(f.account.linkWallet({ ...f.review, accountId: originalId }), /changed/);
  await assert.rejects(f.account.linkWallet({ ...f.review, address: "other-wallet" }), /changed/);
  f.setSession({ ok: true, scope: "wallet-credits", account: { id: originalId } });
  await assert.rejects(f.account.linkWallet(f.review), /website account first/);
  f.setSession({ ok: true, account: { id: accountId } });
  f.beforeSign(() => f.account._saveToken("sk_" + "b".repeat(43)));
  await assert.rejects(f.account.linkWallet(f.review), /changed/);
  assert.equal(f.requests.some(r => r.url.endsWith("/account/credit-wallets")), false);
});
test("website login retains the original Core credit identity for financial recovery and refuses malformed identities", async t => {
  const f = fixture(t), authorization = await f.account.creditAuthorization(origin + "/scheduler");
  assert.equal(authorization.accountId, originalId); assert.equal(authorization.owner, f.address);
  assert.equal(authorization.sessionToken, f.account._token());
  f.setSession({ ok: true, account: { id: accountId, wallets: [{ address: f.address, creditAccountId: "../other" }] } });
  await assert.rejects(f.account.creditAuthorization(origin + "/scheduler"), /could not be verified/);
  assert.equal(f.account._token(), "sk_" + "a".repeat(43));
});
test("Core wallet revocation signs a separate permission without requiring or sending an account session", async t => {
  const f = fixture(t); await f.account.revokeCreditLinks({ address: f.address });
  const req = f.requests.at(-1), proof = JSON.parse(req.init.body);
  assert.equal(req.url, origin + "/auth/credit-wallets/revoke"); assert.equal(req.init.headers.authorization, undefined);
  const hash = crypto.createHash("sha256").update(JSON.stringify(["KAI-CREDIT-WALLET-REVOKE-V1", origin, f.address, proof.ts])).digest();
  assert.equal(Signer.recoverAddress(hash, Buffer.from(proof.signature, "base64")), f.address);
  assert.equal(f.account._token(), "sk_" + "a".repeat(43));
  await assert.rejects(f.account.revokeCreditLinks({ address: "other-wallet" }), /review/);
});
