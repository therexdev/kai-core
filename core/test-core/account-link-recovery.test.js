"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { AccountService } = require("../lib/account");
const origin = "https://credits.koinosai.com", token = "sk_" + "a".repeat(43);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-link-test-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const responses = [], calls = [];
  const storage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
  const account = new AccountService({ dataDir: dir, settings: { get: (_k, fallback) => fallback }, safeStorage: storage, accountOrigin: origin,
    fetchImpl: async (url, options) => { calls.push({ url, options }); const next = responses.shift(); if (next instanceof Error) throw next; const data = typeof next === "function" ? await next() : next; return { status: data.status || 200, json: async () => data }; } });
  const start = (changes = {}) => { responses.push({ ok: true, userCode: "KAI-ABCD-2345", deviceSecret: "ds_" + "b".repeat(32), verifyUrl: origin + "/link", expiresInSec: 600, ...changes }); return account.linkStart(); };
  const poll = () => { account._lastPoll = 0; return account.linkPoll(); };
  return { account, storage, responses, calls, start, poll };
}
test("the exact issuing origin and public code are kept in the link without exposing the secret", async t => {
  const f = fixture(t), value = await f.start();
  assert.equal(value.verifyUrl, origin + "/link?code=KAI-ABCD-2345"); assert.equal(value.deviceSecret, undefined);
  await assert.rejects(f.start({ verifyUrl: "https://koinosai.com/link" }), /invalid sign-in link/);
  assert.equal(f.account._pending, null);
});
test("transient failures retain the same code and concurrent polls save one session", async t => {
  const f = fixture(t); await f.start();
  f.responses.push(Error("socket lost")); assert.deepEqual(await f.poll(), { pending: true, retrying: true });
  f.responses.push({ status: 503, ok: false }); assert.deepEqual(await f.poll(), { pending: true, retrying: true });
  let finish; f.responses.push(() => new Promise(resolve => { finish = resolve; }));
  const a = f.poll(), b = f.poll();
  finish({ ok: true, pending: false, token, account: { id: "account-a" } });
  assert.deepEqual(await a, await b); assert.equal(f.account._token(), token); assert.equal(f.account._pending, null);
  assert.equal(f.calls.filter(c => c.url.endsWith("/poll")).length, 3);
});
test("a locked keyring preserves the approved reply for retry without another network poll", async t => {
  const f = fixture(t); await f.start(); f.storage.isEncryptionAvailable = () => false;
  f.responses.push({ ok: true, pending: false, token, account: { id: "account-a" } });
  await assert.rejects(f.poll(), /keyring/); assert.equal(f.account._token(), null);
  f.storage.isEncryptionAvailable = () => true;
  assert.equal((await f.poll()).account.id, "account-a"); assert.equal(f.account._token(), token);
  assert.equal(f.calls.filter(c => c.url.endsWith("/poll")).length, 1);
});
test("sign-out rejects a late approval and never recreates the signed-out session", async t => {
  const f = fixture(t); await f.start(); let finish;
  f.responses.push(() => new Promise(resolve => { finish = resolve; })); const poll = f.poll();
  f.responses.push({ ok: true }); await f.account.signOut();
  finish({ ok: true, pending: false, token, account: { id: "late-account" } });
  await assert.rejects(poll, /cancelled/); assert.equal(f.account._token(), null);
});
test("getting a fresh code rejects an older in-flight approval", async t => {
  const f = fixture(t); await f.start(); let finish;
  f.responses.push(() => new Promise(resolve => { finish = resolve; })); const old = f.poll();
  await f.start({ userCode: "KAI-EFGH-6789" });
  finish({ ok: true, pending: false, token, account: { id: "old-account" } });
  await assert.rejects(old, /cancelled/); assert.equal(f.account._token(), null); assert.equal(f.account._pending.userCode, "KAI-EFGH-6789");
});
