"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { RuntimeManager } = require("../lib/runtime-manager");
const catalog = require("../models/catalog.json");

function fixture({ alias = "lfm3-1.7b", preferFallback = false, failLlama = false, projectorError = null } = {}) {
  const source = catalog.packages[catalog.aliases[alias].package];
  const resolved = { ...source, packageId: catalog.aliases[alias].package, ...(projectorError ? { vision: true, mmproj: {} } : {}) };
  const starts = [], downloads = [], fallbacks = [];
  const models = { resolveAlias: () => resolved, ensurePackage: async id => { downloads.push(id); return "/fixture/model.gguf"; }, ensureMmproj: async () => { throw projectorError; } };
  const makeRuntime = () => ({ endpoint: "http://fixture", status: () => ({ kind: "llamacpp", running: true }), stop() {}, start: async options => {
    starts.push(options);
    if (failLlama) throw Error("Fixture engine unavailable");
  } });
  const runtime = new RuntimeManager({ models, makeRuntime, preferFallback, makeFallback: async () => {
    fallbacks.push(true);
    return { endpoint: "http://fallback", status: () => ({ kind: "ollama", running: true }), stop() {}, start: async () => {} };
  } });
  return { runtime, starts, downloads, fallbacks, resolved };
}

test("LFM startup uses bounded reasoning and its own sampling defaults without changing existing model defaults", async () => {
  const f = fixture(); await f.runtime.ensure("lfm3-1.7b");
  assert.equal(f.starts[0].contextSize, 4096);
  const args = f.starts[0].extraArgs;
  for (const [flag, value] of [["--reasoning", "on"], ["--reasoning-format", "deepseek"], ["--reasoning-budget", "0"], ["--temp", "0.1"], ["--top-k", "50"], ["--repeat-penalty", "1.1"]]) assert.equal(args[args.indexOf(flag) + 1], value);
  const old = fixture({ alias: "koinos-fast" }); await old.runtime.ensure("koinos-fast");
  assert.deepEqual(old.starts[0].extraArgs, []);
});

test("a forced Ollama runtime refuses LFM before downloading or importing incompatible weights", async () => {
  const f = fixture({ preferFallback: true });
  await assert.rejects(f.runtime.ensure("lfm3-1.7b"), /managed llama\.cpp engine.*forced Ollama/);
  assert.equal(f.downloads.length, 0); assert.equal(f.fallbacks.length, 0);
});

test("LFM never silently enters an unvalidated fallback, including an already-running fallback daemon", async () => {
  for (const fastSwitch of [false, true]) {
    const f = fixture({ failLlama: true });
    if (fastSwitch) {
      f.runtime._llamaDead = true;
      f.runtime.runtime = { status: () => ({ kind: "ollama", running: true }), stop() {}, start: async () => { throw Error("LFM must not use this daemon"); } };
    }
    await assert.rejects(f.runtime.ensure("lfm3-1.7b"), /Fixture engine unavailable.*Ollama fallback is unavailable/);
    assert.equal(f.fallbacks.length, 0);
  }
  const old = fixture({ alias: "koinos-fast", failLlama: true });
  assert.equal(await old.runtime.ensure("koinos-fast"), "http://fallback");
  assert.equal(old.fallbacks.length, 1);
});

test("cancelling a vision projector aborts the load instead of silently booting text-only", async () => {
  for (const error of [new DOMException("Cancelled", "AbortError"), Object.assign(Error("Cancelled"), { code: "ABORT_ERR" })]) {
    const f = fixture({ alias: "koinos-fast", projectorError: error });
    await assert.rejects(f.runtime.ensure("koinos-fast"), e => e === error);
    assert.equal(f.starts.length, 0);
  }
  const missing = fixture({ alias: "koinos-fast", projectorError: Error("Mirror unavailable") });
  await missing.runtime.ensure("koinos-fast");
  assert.equal(missing.starts.length, 1, "ordinary projector failures preserve the existing text-only fallback");
});

test("LFM remains a separate choice with an explicitly pinned network tariff", () => {
  assert.equal(catalog.aliases["lfm3-1.7b"].label, "Liquid LFM3 1.7B");
  assert.equal(catalog.aliases["koinos-fast"].package, "qwen2.5-1.5b-instruct-q4_k_m@1");
  const prices = require("../lib/koin-network/credit-model-prices.json"), config = require("../lib/koin-network/credit-service.json").config;
  const tariff = require("../../electron/credit-models").approvedTariffs(prices.tariffs,config,prices.policyHash).find(t=>t.model==="lfm3-1.7b");
  assert.equal(tariff.modelHash,catalog.packages[catalog.aliases[tariff.model].package].sha256);
});

test("a queued fallback switch keeps an active caller's served model until its lease is released", async () => {
  const f = fixture({ alias: "koinos-fast" });
  let model = "old-model", starts = 0;
  f.runtime._llamaDead = true;
  f.runtime.activeAlias = "old-model";
  f.runtime.runtime = { endpoint: "http://fallback", status: () => ({ kind: "ollama", running: true }), servedName: () => model, stop() {}, start: async options => { starts++; model = options.modelName; } };
  const lease = f.runtime.acquireCurrent("old-model");
  const switching = f.runtime.ensure("koinos-fast");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 0);
  assert.equal(f.runtime.servedModelName(), "old-model");
  lease.release();
  assert.equal(await switching, "http://fallback");
  assert.equal(starts, 1);
  assert.equal(f.runtime.servedModelName(), "koinos-koinos-fast");
});
