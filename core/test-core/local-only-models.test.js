"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { ModelManager } = require("../lib/model-manager"), { JsonStore } = require("../lib/store");
const { CreditProvider } = require("../../electron/credit-provider"), { Worker } = require("../lib/worker");
const catalog = require("../models/catalog.json");
const localAliases = ["gemma4-12b", "muse-glimmer-30b", "qwen38-27b", "gemma4-31b"];
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-local-models-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const models = new ModelManager({ catalogPath: path.join(__dirname, "../models/catalog.json"), modelsDir: directory, state: new JsonStore(path.join(directory, "state.json"), {}) });
  for (const alias of ["koinos-fast", ...localAliases]) fs.writeFileSync(models.packagePath(catalog.aliases[alias].package), "GGUF-fixture");
  const core = { models, hardware: { ramBytes: 64e9 }, gateway: { network: { status: () => ({ privacyMode: "network" }) } } };
  // Deliberately include the local-only aliases in remote tariffs. The local
  // exclusion must hold even if a remote catalog starts offering them early.
  const tariffs = ["koinos-fast", ...localAliases].map(model => ({ model, modelHash: catalog.packages[catalog.aliases[model].package].sha256 }));
  const c = { directory, flow: { models: async () => ({ tariffs }) } };
  return { models, core, c, tariffs };
}
test("experimental models remain locally resolvable with immutable download pins and are absent from paid tariffs", t => {
  const { models } = fixture(t), tariffs = require("../lib/koin-network/credit-model-prices.json").tariffs;
  for (const alias of localAliases) {
    const row = models.aliases().find(m => m.alias === alias), pkg = models.resolveAlias(alias);
    assert.equal(row.localOnly, true); assert.equal(row.status, "ready");
    assert.equal(pkg.alias, alias); assert.equal(pkg.allowFallback, false);
    assert.match(pkg.sha256, /^[a-f0-9]{64}$/); assert.match(pkg.url, /\/resolve\/[a-f0-9]{40}\//);
    assert.ok(pkg.sizeBytes > 0); assert.equal(pkg.generation.jinja, true);
    assert.equal(tariffs.some(t => t.model === alias), false);
  }
  assert.equal(models.aliases().find(m => m.alias === "koinos-fast").localOnly, false);
});
test("share-all and explicit selection exclude local-only downloads even with a matching network tariff", async t => {
  const { core, c } = fixture(t), provider = new CreditProvider({ core, service: {} });
  const candidates = await provider.models(c);
  assert.deepEqual(candidates.map(m => m.id), ["koinos-fast"]);
  assert.deepEqual(Object.keys(c.offeredModelPins), ["koinos-fast"]);
  for (const alias of localAliases) {
    const row = c.modelAvailability.find(m => m.id === alias);
    assert.equal(row.compatible, false); assert.match(row.reason, /Local testing only/);
  }
  provider.preference(c, false, undefined, { mode: "selected", models: localAliases });
  await provider.models(c);
  assert.deepEqual(c.providerModelPins, {}); assert.deepEqual(c.offeredModelPins, {});
});
test("worker never advertises or accepts experimental models, with or without supplied pins", async t => {
  const { core, tariffs } = fixture(t), registrations = [];
  t.mock.method(globalThis, "fetch", async (_url, request) => {
    registrations.push(JSON.parse(request.body));
    return new Response(JSON.stringify({ ok: true, token: "fixture" }));
  });
  for (const modelPins of [null, Object.fromEntries(tariffs.map(t => [t.model, t.modelHash]))]) {
    const worker = new Worker({ schedulerUrl: "https://fixture.invalid", wallet: { address: "fixture", signHash: async () => "fixture" }, runtime: {}, hardware: core.hardware, models: core.models, modelPins });
    await worker._register();
    assert.deepEqual(registrations.at(-1).models, ["koinos-fast"]);
    for (const alias of localAliases) {
      assert.equal(worker.modelGate.find(m => m.alias === alias).advertised, false);
      assert.equal(worker._modelOffered(alias), false);
      assert.throws(() => worker._assertModelOffered({ model: alias }), /not selected/);
    }
  }
});
test("approval can retain the same downloaded file, but still requires the matching network pin", t => {
  const { models, core } = fixture(t), alias = localAliases[0], before = models.resolveAlias(alias);
  models.catalog.aliases[alias].localOnly = false;
  assert.equal(models.resolveAlias(alias).sha256, before.sha256);
  assert.equal(models.aliases().find(m => m.alias === alias).status, "ready");
  const worker = new Worker({ schedulerUrl: "https://fixture.invalid", wallet: {}, runtime: {}, models, hardware: core.hardware, modelPins: { "koinos-fast": catalog.packages[catalog.aliases["koinos-fast"].package].sha256 } });
  assert.equal(worker._modelOffered(alias), false);
});
