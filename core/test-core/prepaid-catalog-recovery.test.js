"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Signer } = require("koilib"), P = require("../lib/koin-network/job-protocol"), M = require("../lib/koin-network/managed-protocol");
const { PrepaidChat } = require("../../electron/koin-prepaid-chat"), { fundedResultHash } = require("../lib/koin-network/funded-protocol");
const { protocol } = require("../lib/koin-network/payment-network"), prices = require("../lib/koin-network/credit-model-prices.json");
const price = (t, input, output) => String((BigInt(input) * BigInt(t.inputAtomsPerMillion) + BigInt(output) * BigInt(t.outputAtomsPerMillion) + 999999n) / 1000000n);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-catalog-recovery-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const signer = Signer.fromSeed("catalog-recovery-test-only"), config = structuredClone(require("../lib/koin-network/credit-service.json").config);
  Object.assign(config, { owner: "account-" + P.hash("catalog-recovery-buyer"), schedulerUrl: "https://network.invalid" });
  config.deployment.verifier = signer.getAddress();
  const storage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s).map(n => n ^ 19), decryptString: b => b.map(n => n ^ 19).toString() };
  const state = { managed: false, available: true, calls: [], results: new Map() };
  const tariffs = () => [...prices.tariffs, ...(state.managed ? M.models.map(m => M.tariff(m.model)) : [])];
  function quote(body) {
    if (M.find(body.model)) return M.quote(flow.target.domain, body.model, body.messages, body.max_tokens, Date.now());
    const tariff = prices.tariffs.find(t => t.model === body.model), at = Date.now();
    const q = { schema: 2, mode: "shadow", domain: flow.target.domain, policyHash: config.policyHash, tariff,
      requestHash: P.hash(JSON.stringify(body.messages)), promptHash: P.hash("prompt"), inputIdsHash: P.hash("tokens"),
      inputTokens: 5, maxOutput: body.max_tokens, maxCharge: price(tariff, 5, body.max_tokens), at, expires: at + 300000 };
    return { ...q, hash: P.hash(JSON.stringify(q)) };
  }
  async function completion(body) {
    const q = quote(body), model = M.find(body.model), id = body.requestId, output = "Verified test reply for " + body.model;
    const session = P.hash("prepaid-account:" + config.owner), attempt = P.hash("attempt:" + id);
    const rates = model && { input: model.input, output: model.output, cache: model.cache, discountBps: 0 };
    const usage = { inputTokens: 5, outputTokens: 8, amount: model ? M.amount(body.model, 5, 8, 0, rates) : price(q.tariff, 5, 8),
      ...(model ? { cachedInputTokens: 0, rates } : {}) };
    const receipt = { product: "prepaid-usd-v1", job: id, owner: config.owner, provider: signer.getAddress(), attempt,
      quoteHash: q.hash, outputHash: P.hash(output), dispatchedAt: q.at, completedAt: q.at, usage,
      ...(model ? { managed: { schema: 1, provider: "akashml", rewardsEligible: false, model: model.upstream, finishReason: "stop" } } : {}) };
    receipt.signature = Buffer.from(await signer.signHash(model ? M.receiptHash(flow.target.domain, receipt)
      : fundedResultHash(flow.target, { id, session, attempt, quote: q }, output))).toString("base64");
    return { id, choices: [{ message: { content: output } }], usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 }, costUsd: Number(usage.amount) / 1e8,
      koin: { product: "prepaid-usd-v1", state: "charged", target: { ...flow.target, ...(model ? { policyHash: M.policyHash } : {}) },
        session, quote: q, receipt, receiptHash: P.hash(JSON.stringify(receipt)) } };
  }
  const flow = new PrepaidChat({ config, file: path.join(dir, "chat.json"), storage,
    access: { authorize: () => ({ owner: config.owner, sessionToken: "fixture-only" }) }, fetchImpl: async (url, init) => {
      const action = url.endsWith("/consume/chat/completions") ? "chat" : url.split("/").at(-1), body = JSON.parse(init.body);
      state.calls.push({ action, body });
      if (action === "models" && state.catalogError) throw state.catalogError;
      let value = {};
      if (action === "models") {
        const now = Date.now(), rows = tariffs();
        value = { catalog: { schema: 1, policyHash: prices.policyHash, tariffs: rows, asOf: now, validUntil: now + 15000,
          models: rows.map(t => ({ model: t.model, available: state.available, providers: state.available ? 1 : 0 })) } };
      } else if (action === "estimate") {
        const q = quote(body); value = { estimate: { model: body.model, unit: "USD-1e-8", maxCharge: q.maxCharge, maxFree: "0", maxPaid: q.maxCharge, allowed: true } };
      } else if (action === "chat") {
        const answer = await completion(body); state.results.set(body.requestId, answer); value = { completion: answer };
      } else if (action === "result") value = { completion: state.results.get(body.requestId) };
      else if (action === "capabilities") value = { capabilities: {} };
      const wire = protocol(flow.target), envelope = { ok: true, product: "prepaid-usd-v1", mode: wire.mode, paymentsEnabled: wire.paymentsEnabled, ...value };
      return action === "chat" ? new Response("data: " + JSON.stringify(envelope) + "\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
        : Response.json(envelope);
    } });
  const input = { model: "koinos-network:" + config.model, messages: [{ role: "user", content: "Hello" }], max_tokens: 64 };
  const signal = () => AbortSignal.timeout(10000);
  async function prior(savedState) {
    const answer = await flow.chat(null, input, signal());
    if (savedState === "delivered") flow.acknowledge(answer.id);
    else if (savedState !== "answered") {
      const { answer: ciphertext, ...record } = flow.read(); flow.save({ ...record, state: savedState });
    }
    return flow.read();
  }
  return { flow, state, input, signal, prior };
}

test("all six managed models work after an acknowledged reply saved the pre-upgrade catalog", async t => {
  for (const model of M.models) await t.test(model.model, async t => {
    const f = fixture(t), old = await f.prior("delivered"); f.state.managed = true;
    // The Assistant refreshes the picker before Send, but recovery must not
    // replace that current approval with the previous chat's older catalog.
    await f.flow.models(f.signal());
    const result = await f.flow.chat(null, { ...f.input, model: "koinos-network:" + model.model }, f.signal());
    assert.equal(result.servedModel, model.model); assert.notEqual(result.id, old.id);
    assert.equal(result.choices[0].message.content, "Verified test reply for " + model.model);
    assert.equal(f.flow.read().tariffs.length, prices.tariffs.length + M.models.length);
    assert.equal(f.state.calls.filter(c => c.action === "chat").length, 2);
    assert.equal(f.state.calls.some(c => c.action === "cancel"), false);
  });
});

test("a different approved model can replace pending or answered requests and follow cancelled records", async t => {
  for (const savedState of ["pending", "answered", "cancelled"]) await t.test(savedState, async t => {
    const f = fixture(t), old = await f.prior(savedState); f.state.managed = true;
    const result = await f.flow.chat(null, { ...f.input, model: "koinos-network:akash-gpt-oss-120b", stream: false }, f.signal());
    assert.equal(result.servedModel, "akash-gpt-oss-120b"); assert.notEqual(result.id, old.id);
    const cancellations = f.state.calls.filter(c => c.action === "cancel");
    assert.deepEqual(cancellations.map(c => c.body.requestId), savedState === "cancelled" ? [] : [old.id]);
    assert.equal(f.state.calls.filter(c => c.action === "chat").length, 2);
  });
});

test("the same pending or answered request still recovers its signed reply without live catalog access or a second generation", async t => {
  for (const savedState of ["pending", "answered"]) await t.test(savedState, async t => {
    const f = fixture(t), old = await f.prior(savedState); f.state.managed = true; f.state.catalogError = Error("Catalog offline");
    const before = f.state.calls.length, recovered = await f.flow.recover(null, f.signal());
    assert.equal(recovered.completion.id, old.id); assert.equal(recovered.completion.servedModel, f.flow.config.model);
    assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
    assert.deepEqual(f.state.calls.slice(before).map(c => c.action), savedState === "pending" ? ["result", "acknowledge"] : ["acknowledge"]);
  });
});

test("failed catalog refresh, unavailable or unknown models preserve the previous recoverable request", async t => {
  for (const failure of ["offline", "unavailable", "unknown"]) await t.test(failure, async t => {
    const f = fixture(t), old = await f.prior("answered"); f.state.managed = true;
    if (failure === "offline") f.state.catalogError = Error("Catalog offline");
    if (failure === "unavailable") f.state.available = false;
    const selected = failure === "unknown" ? "unapproved-model" : "akash-gpt-oss-120b";
    const expected = failure === "offline" ? /Catalog offline/ : failure === "unavailable" ? /is unavailable/ : /approved network model/;
    await assert.rejects(f.flow.chat(null, { ...f.input, model: "koinos-network:" + selected }, f.signal()), expected);
    assert.deepEqual(f.flow.read(), old);
    assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
    assert.equal(f.state.calls.some(c => c.action === "cancel"), false);
  });
});

test("tampered saved tariffs are still rejected and retained before any network request", async t => {
  const f = fixture(t), old = await f.prior("answered"); f.state.managed = true;
  old.tariffs[0].inputAtomsPerMillion = "1"; f.flow.save(old);
  const before = f.state.calls.length;
  await assert.rejects(f.flow.chat(null, { ...f.input, model: "koinos-network:akash-gpt-oss-120b" }, f.signal()), /approved policy/);
  assert.deepEqual(f.flow.read(), old); assert.equal(f.state.calls.length, before);
});
