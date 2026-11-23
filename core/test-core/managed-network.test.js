"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const Models = require("../../electron/credit-models"), M = require("../lib/koin-network/managed-protocol");
const config = require("../lib/koin-network/credit-service.json").config, prices = require("../lib/koin-network/credit-model-prices.json");
const { request } = require("../../electron/koin-chat-flow"), { configuredModelPricing } = require("../../electron/credit-model-pricing");
test("managed catalog preserves all sixteen native tariffs and rejects injected or altered managed prices", () => {
  const full = [...prices.tariffs, ...M.models.map(m => M.tariff(m.model))];
  assert.equal(Models.approvedTariffs(full, config, prices.policyHash).length, 22);
  for (const change of [rows => rows.pop(), rows => rows[16].inputAtomsPerMillion = "1", rows => rows.push(rows[16]), rows => rows[16].modelHash = "a".repeat(64), rows => rows[0].outputAtomsPerMillion = "1"]) {
    const value = structuredClone(full); change(value); assert.throws(() => Models.approvedTariffs(value, config, prices.policyHash));
  }
  assert.throws(() => Models.approvedTariffs(full, { ...config, deployment: { ...config.deployment, product: "prepaid-v1" } }, prices.policyHash));
});
test("normal model picker gets real names, provider counts and hosted output limits", () => {
  const now = Date.now(), tariffs = [...prices.tariffs, ...M.models.map(m => M.tariff(m.model))];
  const catalog = Models.catalog({ schema: 1, policyHash: prices.policyHash, tariffs, asOf: now, validUntil: now + 15000,
    models: tariffs.map(t => ({ model: t.model, available: !!M.find(t.model), providers: M.find(t.model) ? 1 : 0 })) }, config, now);
  for (const m of M.models) { const row = catalog.models.find(r => r.model === m.model); assert.equal(row.label, m.label); assert.equal(row.providers, 1); assert.equal(row.maxOutput, 8192); }
  const args = request({ model: "koinos-network:" + M.models[0].model, messages: [{ role: "user", content: "Hello" }], max_tokens: 4096 }, config, tariffs);
  assert.equal(args.maxOutput, 4096);
  assert.throws(() => request({ model: "koinos-network:koinos-fast", messages: args.messages, max_tokens: 4096 }, config, tariffs));
});
test("configured prices show new markups without implying an online provider or changing native prices", () => {
  const table = configuredModelPricing(config, prices, 100000);
  assert.equal(table.models.length, 22); assert.equal(table.availabilityValidUntil, null);
  const expected = {
    "akash-gpt-oss-120b": ["0.04625", "0.23375"], "akash-llama33-70b": ["0.25", "0.65"],
    "akash-qwen38-27b": ["0.28125", "2.475"], "akash-glm53": ["0.2375", "5.5"],
    "akash-qwen36-35b-a3b": ["0.115", "1.035"], "akash-kimi-k31-pro": ["2.0125", "11.5"]
  };
  for (const [model, rates] of Object.entries(expected)) {
    const row = table.models.find(m => m.model === model); assert.deepEqual([row.inputUsdPerMillion, row.outputUsdPerMillion], rates);
  }
  assert.equal(table.models.find(m => m.model === "koinos-fast").inputUsdPerMillion, "0.01");
});
test("an unavailable managed provider cannot invalidate the ordinary native model catalog", () => {
  const now = Date.now(), tariffs = [...prices.tariffs, ...M.models.map(m => M.tariff(m.model))];
  const catalog = Models.catalog({ schema: 1, policyHash: prices.policyHash, tariffs, asOf: now, validUntil: now + 15000,
    models: tariffs.map(t => ({ model: t.model, available: false, providers: 0 })) }, config, now);
  const network = { observedAt: now, validUntil: now + 15000, state: "paused", providers: [],
    models: tariffs.map(t => ({ id: t.model, available: false, providers: 0 })) };
  const result = require("../../electron/credit-network-eligibility").consumerCatalog(catalog, network, [], now);
  assert.equal(result.models.length, 22); assert.ok(result.models.every(m => !m.available));
});

test("managed defaults fit the exact credit boundary across all prices, conversation sizes and saved caps", () => {
  const tariffs = [...prices.tariffs, ...M.models.map(m => M.tariff(m.model))];
  const conversations = [
    [{ role: "user", content: "What is a good diet plan for weight loss" }],
    [{ role: "system", content: "Use concise replies." }, { role: "user", content: "Compare these options: " + "漢字🙂".repeat(250) }],
    Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "A previous conversation turn. ".repeat(10) })),
  ];
  for (const m of M.models) for (const messages of conversations) for (const perJob of ["1000", "100000", "1000000", "5000000"]) {
    const value = { model: "koinos-network:" + m.model, messages }, c = { ...config, limits: { ...config.limits, perJob } };
    const quote = output => M.quote("shadow:default-budget-test", m.model, messages, output, 0);
    if (BigInt(quote(1).maxCharge) > BigInt(perJob)) {
      assert.throws(() => request(value, c, tariffs), /no reply allowance.*saved per-request credit limit/); continue;
    }
    const input = request(value, c, tariffs), q = quote(input.maxOutput);
    assert.ok(input.maxOutput > 0 && input.maxOutput <= 2048);
    assert.ok(BigInt(q.maxCharge) <= BigInt(perJob), m.model + " must fit the exact configured cap");
    if (input.maxOutput < 2048) assert.ok(BigInt(quote(input.maxOutput + 1).maxCharge) > BigInt(perJob), "no avoidable loss of reply allowance");
    M.verifyQuote(q);
    assert.deepEqual(input.messages, messages, "never trim the conversation to fit spending");
  }
});

test("explicit reply limits, native defaults and uncapped callers keep their existing behavior", () => {
  const tariffs = [...prices.tariffs, ...M.models.map(m => M.tariff(m.model))], messages = [{ role: "user", content: "Hello" }];
  for (const m of M.models) {
    const value = { model: "koinos-network:" + m.model, messages };
    assert.equal(request({ ...value, max_tokens: 4096 }, config, tariffs).maxOutput, 4096);
    for (const max_tokens of [0, 8193, 1.5, "64"]) assert.throws(() => request({ ...value, max_tokens }, config, tariffs), /Invalid integer/);
    assert.equal(request(value, { ...config, limits: undefined }, tariffs).maxOutput, 2048);
  }
  assert.equal(request({ model: "koinos-network:koinos-fast", messages }, config, tariffs).maxOutput, 256);
});
