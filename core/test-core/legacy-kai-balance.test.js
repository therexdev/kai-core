"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { createLegacyKaiBalance, validKai } = require("../lib/legacy-kai-balance");
function fixture() {
  let address = "wallet-a", url = "https://testnet.example/scheduler", clock = 100000, value = { ok: true, address, kai: "12345.67890123" }, calls = [];
  const reader = createLegacyKaiBalance({ getAddress: () => address, getSchedulerUrl: () => url, now: () => clock,
    fetchImpl: async (target, options) => { calls.push({ target, options }); const result = typeof value === "function" ? await value() : value; if (result instanceof Error) throw result; return result instanceof Response ? result : Response.json(result); } });
  return { reader, calls, setAddress(v) { address = v; }, setUrl(v) { url = v; }, setValue(v) { value = v; }, advance(ms) { clock += ms; } };
}
test("public KAI reader uses only the saved address with no wallet key, account session or AI route", async () => {
  const f = fixture(), result = await f.reader.read();
  assert.equal(result.kai, "12345.67890123"); assert.equal(result.address, "wallet-a");
  assert.equal(f.calls[0].target, "https://testnet.example/scheduler/balance?address=wallet-a");
  assert.deepEqual(f.calls[0].options.headers, { accept: "application/json" }); assert.equal(f.calls[0].options.credentials, "omit");
  result.kai = "999"; assert.equal((await f.reader.read()).kai, "12345.67890123"); assert.equal(f.calls.length, 1);
  f.advance(30000); await f.reader.read(); assert.equal(f.calls.length, 2);
});
test("missing wallets and unavailable service never become invented zero balances", async () => {
  const f = fixture(); f.setAddress(null); assert.match((await f.reader.read()).error, /Import or create/); assert.equal(f.calls.length, 0);
  f.setAddress("wallet-a"); f.setValue(Error("private transport details")); assert.match((await f.reader.read()).error, /temporarily unreachable/);
  f.advance(2999); await f.reader.read(); assert.equal(f.calls.length, 1); f.advance(1); await f.reader.read(); assert.equal(f.calls.length, 2);
  f.setValue({ ok: true, address: "wallet-a", kai: "0" }); f.advance(3000); assert.equal((await f.reader.read()).kai, "0");
});
test("wallet identity, decimal precision and bounded responses are verified", async () => {
  const f = fixture();
  for (const value of [{ ok: true, address: "wallet-b", kai: "2" }, { ok: true, address: "wallet-a", kai: 2 }, { ok: true, address: "wallet-a", kai: "-1" }, { ok: true, address: "wallet-a", kai: "0.000000001" }, { ok: false, error: "chain read failed" }, new Response("x".repeat(131073)), new Response("no", { status: 502 }), new Response("<html>not JSON</html>")]) {
    f.reader.clear(); f.setValue(value); const result = await f.reader.read(); assert.ok(result.error); assert.equal(result.kai, undefined);
  }
  assert.equal(validKai("5e-8"), true); assert.equal(validKai("184467440737.09551615"), true); assert.equal(validKai("184467440737.09551616"), false);
});
test("concurrent reads share one request and late responses cannot replace another wallet or service", async () => {
  const f = fixture(); let finish; f.setValue(() => new Promise(resolve => { finish = resolve; }));
  const first = f.reader.read(), second = f.reader.read(); assert.equal(f.calls.length, 1);
  f.setAddress("wallet-b"); finish({ ok: true, address: "wallet-a", kai: "1" }); assert.equal(await first, null); assert.equal(await second, null);
  f.setValue({ ok: true, address: "wallet-b", kai: "2" }); assert.equal((await f.reader.read()).kai, "2");
  f.setUrl("https://other.example/scheduler"); let done; f.setValue(() => new Promise(resolve => { done = resolve; })); const pending = f.reader.read();
  f.setUrl("https://new.example/scheduler"); done({ ok: true, address: "wallet-b", kai: "3" }); assert.equal(await pending, null);
});
test("fresh Core reads locked-wallet Testnet KAI in Local-Only without activating earning", async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-legacy-balance-")));
  const { WalletService } = require("../lib/wallet"), wallet = new WalletService(path.join(directory, "wallet"));
  const created = wallet.create({ password: "synthetic balance test password" }); wallet.lock(); let requests = 0;
  const server = http.createServer((req, res) => { requests++; assert.equal(req.url, "/balance?address=" + created.address); assert.equal(req.headers.authorization, undefined); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, address: created.address, kai: "12345.67890123", pendingKai: "999" })); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify({ network: { privacyMode: "local-only" }, earn: { schedulerUrl: `http://127.0.0.1:${server.address().port}` } }));
  const core = await require("../server").createCore({ dataDir: directory, port: 0 });
  t.after(async () => { await core.stop(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const result = await core.gateway.earn.legacyBalance();
  assert.equal(result.earnings.kai, "12345.67890123"); assert.equal(result.wallet.address, created.address); assert.equal(core.account.wallet.status().unlocked, false);
  assert.equal(core.gateway.network.status().privacyMode, "local-only"); assert.equal((await core.gateway.earn.status()).worker.running, false); assert.equal(requests, 1);
  assert.deepEqual(require("../../ui-core/earning").legacySummary(result), { wallet: created.address, kai: "12,345.67890123", koin: "2,469.13578024" });
});
