"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Signer } = require("koilib"), P = require("../lib/koin-network/job-protocol"), { fundedResultHash } = require("../lib/koin-network/funded-protocol");
const { PrepaidChat } = require("../../electron/koin-prepaid-chat"), { CreditRuns } = require("../../electron/credit-runs");
const { consumerNetwork, consumerCatalog, wallets, providerId } = require("../../electron/credit-network-eligibility");
const { createChatController } = require("../../ui-core/chat");
const local = Signer.fromSeed("eligibility-local"), remote = Signer.fromSeed("eligibility-remote"), other = Signer.fromSeed("eligibility-other");
const model = "fixture-shared", signal = () => AbortSignal.timeout(10000);
function snapshot(providers, now = Date.now()) {
  const rows = providers.map(wallet => ({ id: providerId(wallet), model, ready: true, state: "ready", validUntil: now + 15000,
    models: [{ model, ready: true, state: "online", validUntil: now + 15000 }] }));
  return { observedAt: now, validUntil: now + 15000, state: providers.length ? "available" : "paused", readyProviders: providers.length,
    waitingRequests: 0, completedToday: 0, activity: [], providers: rows,
    models: [{ id: model, model, available: providers.length > 0, providers: providers.length, freeEligible: true }] };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-self-provider-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tariff = Object.fromEntries(Object.entries({ model, version: 1, modelHash: P.hash("model"), tokenizerHash: P.hash("tokens"), templateHash: P.hash("template"),
    inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "1000000", maxOutputTokens: 64, contextTokens: 4096, maxLatencyMs: 5000 }).sort(([a], [b]) => a.localeCompare(b)));
  const config = { owner: "account-" + P.hash("independent-free-buyer"), version: 1, model, maxOutput: 16, schedulerUrl: "https://network.invalid/scheduler",
    policyHash: P.hash(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1", tariff])), deployment: { product: "prepaid-usd-v1",
      chainId: require("../lib/koin-network/payment-network").MAINNET_CHAIN, credits: other.getAddress(), creditsHash: "0x1220" + P.hash("wasm") } };
  const state = { providers: [local.getAddress()], wallet: local.getAddress(), calls: [], offline: false, afterEstimate: null, afterCapabilities: null, result: null, answerProvider: remote };
  const storage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).map(n => n ^ 19), decryptString: value => value.map(n => n ^ 19).toString() };
  const flow = new PrepaidChat({ config, file: path.join(dir, "chat.json"), storage, providerWallets: () => [state.wallet], enforcedProviderWallets: () => state.linked === false ? [] : [local.getAddress()], access: { authorize: () => ({ owner: config.owner }) } });
  flow.call = async (action, body = {}) => {
    state.calls.push(action);
    if (action === "models") {
      if (state.offline) throw Error("Offline catalog"); const now = Date.now();
      return { catalog: { schema: 1, policyHash: config.policyHash, tariffs: [tariff], asOf: now, validUntil: now + 15000,
        models: [{ model, providers: state.providers.length, available: state.providers.length > 0 }] } };
    }
    if (action === "network") return { network: snapshot(state.providers) };
    if (action === "estimate") { state.afterEstimate?.(); return { estimate: { model, unit: "USD-1e-8", maxCharge: "21", maxFree: "21", maxPaid: "0", allowed: true } }; }
    if (action === "capabilities") { state.afterCapabilities?.(); return { capabilities: {} }; }
    if (action === "result") return { completion: state.result };
    if (action !== "chat") return {};
    const at = Date.now(), q = { schema: 2, mode: "shadow", domain: flow.target.domain, policyHash: config.policyHash, tariff,
      requestHash: P.hash(JSON.stringify(body.messages)), promptHash: P.hash("prompt"), inputIdsHash: P.hash("ids"), inputTokens: 5, maxOutput: body.max_tokens, maxCharge: "21", at, expires: at + 300000 };
    q.hash = P.hash(JSON.stringify(q));
    const id = body.requestId, session = P.hash("prepaid-account:" + config.owner), attempt = P.hash("attempt"), output = "Verified remote reply";
    const receipt = { product: "prepaid-usd-v1", job: id, owner: config.owner, provider: state.answerProvider.getAddress(), attempt,
      quoteHash: q.hash, outputHash: P.hash(output), dispatchedAt: at, completedAt: at + 1,
      signature: Buffer.from(await state.answerProvider.signHash(fundedResultHash(flow.target, { id, session, attempt, quote: q }, output))).toString("base64"),
      usage: { inputTokens: 5, outputTokens: 3, amount: "8" } };
    state.result = { id, choices: [{ message: { content: output } }], koin: { product: "prepaid-usd-v1", state: "ready", target: flow.target, session, quote: q, receipt, receiptHash: P.hash(JSON.stringify(receipt)) } };
    return { completion: state.result };
  };
  return { flow, state, config, dir, input: { model: "koinos-network:" + model, messages: [{ role: "user", content: "Hello" }], max_tokens: 16, freeOnly: true } };
}

test("only one's own qualified provider is excluded; the same model on another provider remains usable", () => {
  const own = local.getAddress(), now = Date.now();
  assert.deepEqual(wallets([own, own, "account-" + P.hash("guest"), undefined]), [own]);
  const alone = consumerNetwork(snapshot([own], now), [own], now);
  assert.equal(alone.models[0].available, false); assert.equal(alone.models[0].providers, 0); assert.equal(alone.models[0].unavailableReason, "self-only");
  assert.equal(alone.providers[0].self, true);
  const shared = consumerNetwork(snapshot([own, remote.getAddress()], now), [own], now);
  assert.equal(shared.models[0].available, true); assert.equal(shared.models[0].providers, 1); assert.equal(shared.models[0].totalProviders, 2);
  const catalog = { asOf: now, validUntil: now + 15000, models: [{ model, available: true, providers: 99 }] };
  assert.equal(consumerCatalog(catalog, snapshot([own], now), [own], now).models[0].available, false, "never combine stale global catalog counts with a newer observation");
});

test("incomplete, stale, ambiguous and inconsistent provider observations fail closed", () => {
  const now = Date.now(), own = local.getAddress();
  for (const change of [n => n.validUntil = now, n => n.observedAt = now + 6000, n => delete n.providers[0].models,
    n => n.models[0].providers = 2, n => n.providers.push(n.providers[0]), n => n.providersTruncated = true,
    n => n.providers[0].models[0].validUntil = now, n => n.providers[0].ready = false]) {
    const n = snapshot([own], now); change(n); assert.throws(() => consumerNetwork(n, [own], now), /availability/);
  }
});

test("self-only catalog blocks estimates, new chats and advanced-run admission before credits or work are reserved", async t => {
  const f = fixture(t), catalog = await f.flow.models(signal()); assert.equal(catalog.models[0].available, false);
  await assert.rejects(f.flow.estimate(f.input, signal()), /own computer or account/);
  await assert.rejects(f.flow.chat(null, f.input, signal()), /own computer or account/);
  const runs = new CreditRuns({}), c = { config: f.config, flow: f.flow, directory: f.dir };
  await assert.rejects(runs.open(c, { model, mode: "agent", budget: "1", freeOnly: true }, signal()), /unavailable/);
  assert.ok(f.state.calls.every(action => ["models", "network"].includes(action))); assert.equal(fs.existsSync(f.flow.file), false);
});

test("remote provider disappearing during price or capability reads never submits the request", async t => {
  for (const hook of ["afterEstimate", "afterCapabilities"]) {
    const f = fixture(t); f.state.providers.push(remote.getAddress()); f.state[hook] = () => { f.state.providers = [local.getAddress()]; };
    await assert.rejects(f.flow.chat(null, f.input, signal()), /own computer or account/);
    assert.equal(f.state.calls.includes("chat"), false);
  }
});

test("independent guest identity cannot reserve credits while its unlinked earning wallet serves the same model", async t => {
  const f = fixture(t); f.state.linked = false; f.state.providers.push(remote.getAddress());
  const catalog = await f.flow.models(signal());
  assert.equal(catalog.models[0].providers, 1); assert.equal(catalog.models[0].available, false);
  assert.equal(catalog.models[0].unavailableReason, "wallet-connection-required");
  await assert.rejects(f.flow.estimate(f.input, signal()), /Connect your wallet/);
  await assert.rejects(f.flow.chat(null, f.input, signal()), /Connect your wallet/);
  assert.equal(f.state.calls.includes("estimate"), false); assert.equal(f.state.calls.includes("chat"), false);
  f.state.providers = [remote.getAddress()];
  assert.equal((await f.flow.models(signal())).models[0].available, true, "guest access still works for a different remote computer");
  assert.equal((await f.flow.chat(null, f.input, signal())).choices[0].message.content, "Verified remote reply");
});

test("guest earning appearance during preflight blocks submission and linked accounts still use the other provider", async t => {
  const f = fixture(t); f.state.linked = false; f.state.providers = [remote.getAddress()];
  f.state.afterEstimate = () => f.state.providers.push(local.getAddress());
  await assert.rejects(f.flow.chat(null, f.input, signal()), /Connect your wallet/);
  assert.equal(f.state.calls.includes("chat"), false);
  f.state.linked = true; f.state.afterEstimate = null;
  assert.equal((await f.flow.chat(null, f.input, signal())).choices[0].message.content, "Verified remote reply");
});

test("completed remote replies recover without uptime checks; pending retry requires a fresh external provider", async t => {
  const f = fixture(t); f.state.providers.push(remote.getAddress());
  const answer = await f.flow.chat(null, f.input, signal()); assert.equal(answer.choices[0].message.content, "Verified remote reply");
  f.state.providers = [local.getAddress()]; f.state.offline = true; const before = f.state.calls.length;
  f.state.wallet = remote.getAddress();
  assert.equal((await f.flow.recover(null, signal())).completion.id, answer.id);
  assert.deepEqual(f.state.calls.slice(before), ["acknowledge"]);
  const historical = f.flow.read(); delete historical.excludedProviders; f.flow.save(historical);
  assert.equal((await f.flow.recover(null, signal())).completion.id, answer.id, "pre-upgrade replies keep their original owner-only verification rule");
  f.state.wallet = local.getAddress();
  const record = f.flow.read(); delete record.answer; record.state = "pending"; f.flow.save(record); f.state.result = null; f.state.offline = false;
  await assert.rejects(f.flow.recover(null, signal()), /own computer or account/);
  assert.equal(f.state.calls.filter(a => a === "chat").length, 1);
});

test("a changed local wallet invalidates cached eligibility and own-wallet receipts are rejected for independent buyer identities", async t => {
  const f = fixture(t); f.state.providers.push(remote.getAddress()); await f.flow.models(signal());
  f.state.wallet = other.getAddress(); assert.throws(() => f.flow.available(model), /identity changed/);
  f.state.wallet = local.getAddress(); f.state.answerProvider = local;
  await assert.rejects(f.flow.chat(null, f.input, signal()), /could not be verified/);
  assert.equal(f.state.calls.includes("acknowledge"), false);
});

test("chat picker omits self-only entries and a stale selection cannot silently switch models or start inference", async () => {
  let remoteAvailable = false; const calls = [];
  const c = createChatController({ bridge: { credit: async method => {
    calls.push(method); assert.equal(method, "chat-info");
    return { configured: true, enabled: true, modelAvailabilityUntil: Date.now() + 15000,
      models: [{ model, available: remoteAvailable, ...(remoteAvailable ? {} : { unavailableReason: "self-only" }) }] };
  } } });
  c.update({ models: [{ alias: model, status: "ready" }], network: { privacyMode: "network" } });
  await c.setSource("network"); assert.deepEqual(c.models(), []); assert.equal(c.state.selected.network, "");
  assert.equal(await c.send("hello"), false); assert.match(c.state.status, /(?:own|your) computer/);
  remoteAvailable = true; await c.refreshNetwork(); assert.equal(c.models()[0].available, true);
  c.setModel(model); remoteAvailable = false;
  assert.equal(await c.send("again"), false); assert.match(c.state.status, /(?:own|your) computer/);
  assert.ok(calls.every(action => action === "chat-info"));
});

test("idle catalog refresh clears a self-only selection without silently choosing another paid model", async () => {
  let onlySelf = false;
  const c = createChatController({ bridge: { credit: async () => ({ configured: true, enabled: true, modelAvailabilityUntil: Date.now() + 15000,
    models: [{ model, available: !onlySelf, ...(onlySelf ? { unavailableReason: "self-only" } : {}) }, { model: "different-price-model", available: true }] }) } });
  c.update({ models: [], network: { privacyMode: "network" } }); await c.setSource("network"); assert.equal(c.state.selected.network, model);
  onlySelf = true; await c.refreshNetwork(); assert.equal(c.state.selected.network, "");
  assert.match(c.state.status, /only shared by your computer or account.*Choose another network model or Local model/);
  await c.refreshNetwork(); assert.equal(c.state.selected.network, "", "later polling still requires the user's choice");
  c.setModel("different-price-model"); assert.equal(c.state.selected.network, "different-price-model");
});
