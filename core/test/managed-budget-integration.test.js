"use strict";
// Production desktop + scheduler + ledger + managed adapter over loopback.
// Only the supplier and account credentials are deterministic test fixtures.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { createRequire } = require("node:module"), { Signer } = require("koilib");
const { PrepaidChat } = require("../../electron/koin-prepaid-chat"), M = require("../lib/koin-network/managed-protocol"), P = require("../lib/koin-network/job-protocol");

test("all six managed defaults cross the real credit server with free-first, paid-first and one-charge recovery", { skip: !process.env.KAI_WALLET_BACKEND, timeout: 30000 }, async t => {
  const backend = createRequire(path.join(path.resolve(process.env.KAI_WALLET_BACKEND), "package.json"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-managed-budget-")), signer = Signer.fromSeed("managed-budget-verifier"), buyer = Signer.fromSeed("managed-budget-buyer");
  let router, server, provider;
  t.after(async () => {
    if (server) { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
    router?.close(); provider?.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  const tariffs = require("../lib/koin-network/credit-model-prices.json").tariffs;
  const { Meter } = backend("./lib/koin-network/metering"), { ManagedMeter, ManagedProvider } = backend("./lib/koin-network/managed-provider");
  const meter = new ManagedMeter(new Meter(tariffs.map(tariff => ({ tariff, adapter: { ...tariff, render: JSON.stringify, encode: value => [...Buffer.from(value)], input: value => Buffer.byteLength(JSON.stringify(value)), output: value => Buffer.byteLength(value) } }))));
  const config = structuredClone(require("../lib/koin-network/credit-service.json").config);
  Object.assign(config, { owner: buyer.getAddress(), schedulerUrl: "https://budget.integration.invalid/scheduler", policyHash: meter.policyHash }); delete config.catalogExtension;
  config.deployment.verifier = signer.getAddress();
  const storage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).map(n => n ^ 19), decryptString: value => value.map(n => n ^ 19).toString() };
  const calls = [], supplier = [], progress = []; let base;
  const flow = new PrepaidChat({ config, file: path.join(dir, "chat.json"), storage, progress: value => progress.push(value),
    access: { authorize: () => ({ owner: config.owner, sessionToken: "budget-test-session" }) }, fetchImpl: (url, init) => {
      calls.push({ route: new URL(url).pathname, body: JSON.parse(init.body) });
      return fetch(base + new URL(url).pathname.replace(/^\/scheduler/, ""), init);
    } });
  provider = new ManagedProvider({ key: "managed-budget-fixture-key", signer, verifier: signer.getAddress(), domain: flow.target.domain,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/models")) return Response.json({ data: M.models.map(m => ({ id: m.upstream, pricing: { input: Number(m.input) / 1e14, output: Number(m.output) / 1e14, input_cache_read: Number(m.cache) / 1e14 } })) });
      const body = JSON.parse(init.body); supplier.push(body);
      assert.ok(Number.isSafeInteger(body.max_completion_tokens) && body.max_completion_tokens >= 40);
      return Response.json({ id: "fixture-" + supplier.length, model: body.model, choices: [{ message: { content: "Verified reply from " + body.model }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_tokens_details: { cached_tokens: 50 } } });
    } });
  await provider.refresh();
  const client = new (backend("./lib/koin-network/chain").KoinChain)(config.deployment, {});
  router = backend("./lib/koin-network/prepaid-router").createPrepaidRouter({ dataDir: path.join(dir, "server"), client, meter, target: flow.target, encryptionKey: Buffer.alloc(32, 42),
    accounts: { sessionAccount: token => token === "budget-test-session" ? { id: "budget-test" } : null, accountView: () => ({ wallets: [{ address: config.owner }] }) },
    publicAccounts: true, managed: provider, qualify: () => false, accept: () => false,
    freePolicy: { version: 1, accountDaily: "1000000", networkDaily: "300000000", originDaily: "200000000", accountConcurrent: 4, eligibleModels: M.models.map(m => m.model) },
    networkOverview: () => ({ observedAt: Date.now(), validUntil: Date.now() + 15000, state: "available", providers: [provider.snapshot()], readyProviders: 1,
      models: meter.tariffs().map(t => ({ id: t.model, available: provider.ready(t.model), providers: provider.ready(t.model) ? 1 : 0, freeEligible: !!M.find(t.model) })) }) });
  const tx = "0x1220" + P.hash("budget-test-purchase");
  router.ledger.queuePurchase(tx, config.owner);
  router.ledger.confirmPurchase(tx, { state: "finalized", txId: tx, owner: config.owner, amount: "200000000", height: "3", blockId: "0x1220" + P.hash("budget-test-block") });
  server = http.createServer(async (req, res) => {
    if (req.url !== "/consume/chat/completions") return router.handle(req, res);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    return router.work.chat(req, res, JSON.parse(Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); base = "http://127.0.0.1:" + server.address().port;
  for (const paidFirst of [false, true]) for (const m of M.models) {
    const input = { model: "koinos-network:" + m.model, stream: true, paidFirst, messages: [{ role: "user", content: "What is a good diet plan for weight loss" }] };
    const answer = await flow.chat(null, input, AbortSignal.timeout(5000)), q = answer.koin.quote;
    assert.equal(answer.servedModel, m.model); assert.ok(BigInt(q.maxCharge) <= 1000000n);
    assert.equal(supplier.at(-1).model, m.upstream); assert.equal(supplier.at(-1).max_completion_tokens, q.maxOutput);
    assert.deepEqual(supplier.at(-1).messages, input.messages);
    const estimate = calls.filter(c => c.route.endsWith("/estimate")).at(-1);
    assert.equal(estimate.body.max_tokens, q.maxOutput);
    const count = supplier.length, spent = router.ledger.balance(config.owner).spent;
    const recovered = await flow.recover(null, AbortSignal.timeout(5000));
    assert.equal(recovered.completion.id, answer.id); assert.equal(supplier.length, count); assert.equal(router.ledger.balance(config.owner).spent, spent);
    assert.equal(router.ledger.job(answer.id).managed.rewardsEligible, false);
    flow.acknowledge(answer.id);
  }
  assert.equal(supplier.length, 12); assert.ok(progress.some(p => p.delta));
  assert.deepEqual(router.ledger.pendingJobs(), []); assert.deepEqual(router.ledger.pendingSponsorship(), []);
  assert.equal(config.limits.perJob, "1000000");
});
