"use strict";
// Cross-repository HTTP/SDK/runtime test. Only the engine process is a fixture;
// no real model, GPU, account, payment or Google action is exercised.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { ModelManager } = require("../../core/lib/model-manager");
const { JsonStore } = require("../../core/lib/store");
const { RuntimeManager } = require("../../core/lib/runtime-manager");
const { LlamaCppRuntime } = require("../../core/lib/runtimes/llamacpp");
const { Gateway } = require("../../core/lib/gateway");
const { createFoundationApi } = require("../../electron/foundation-api");
const remote = path.resolve(process.argv[2] || "../kai-plugin-remote-access");
const { createLocalApi } = require(path.join(remote, "plugin/service/local-api"));
const { ApiKeys } = require(path.join(remote, "plugin/service/lib/keys"));

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-remote-context-"));
  const models = new ModelManager({ catalogPath: path.resolve(__dirname, "../../core/models/catalog.json"), modelsDir: root, state: new JsonStore(path.join(root, "models.json")) });
  const fixture = path.resolve(__dirname, "../../core/test/fixtures/fake-llama-server.js"), allocations = [];
  models.ensurePackage = async () => path.join(root, "fixture.gguf");
  const runtime = new RuntimeManager({ models, makeRuntime: () => new LlamaCppRuntime({ binPath: process.execPath,
    spawnProcess: (_bin, args, options) => {
      const index = args.indexOf("--ctx-size"); if (index >= 0) allocations.push(Number(args[index + 1]));
      return spawn(process.execPath, [fixture, ...args], options);
    } }) });
  const gateway = new Gateway({ port: 0, models, runtime, keys: { required: () => false } });
  let local;
  try {
    await gateway.listen();
    const controller = new AbortController();
    const record = { manifest: { id: "context.fixture", version: "1.0.0", permissions: ["models.read", "inference.local", "storage.read", "storage.write"] }, dataDir: root, root, controller };
    const api = createFoundationApi({ core: { gateway, runtime, models: { aliases: () => models.aliases().filter(m => m.alias === "koinos-smart").map(m => ({ ...m, status: "ready" })) } }, electron: {} }, record);
    const keys = new ApiKeys(api.settings), key = keys.create({ name: "Disposable fixture" });
    local = createLocalApi({ api, keys }); await local.start();
    const headers = { authorization: `Bearer ${key.secret}`, "content-type": "application/json" };
    const catalog = async () => (await (await fetch(local.base + "/v1/models", { headers })).json()).data[0];
    assert.equal((await catalog()).context_window, 32768); assert.equal((await catalog()).context_mode, "auto");
    const post = input => fetch(local.base + "/v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "koinos-smart", max_tokens: 1024, messages: [{ role: "user", content: "hello" }], ...input }) });
    let response = await post({}); assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).kai_context, { contextSize: 4096, verified: true });
    response = await post({ messages: [{ role: "user", content: "x".repeat(24000) }], context_tokens: 12000, stream: true });
    assert.equal(response.status, 200); assert.equal(response.headers.get("x-kai-context-size"), "16384");
    assert.match(await response.text(), /\[DONE\]/);
    assert.deepEqual(allocations, [4096, 16384]);
    assert.equal(models.resolveAlias("koinos-smart").contextOverride, null);
    runtime.configureContext("koinos-smart", 4096);
    assert.equal((await catalog()).context_window, 4096);
    response = await post({ context_tokens: 12000 }); assert.equal(response.status, 400); await response.text();
    assert.deepEqual(allocations, [4096, 16384]);
    console.log(JSON.stringify({ ok: true, engine: "synthetic child process", liveModelTested: false, checks: ["Authenticated discovery reports the permitted ceiling", "Core SDK preserves verified allocation", "Long streaming request grows 4K to 16K through Remote Access", "Per-request sizing leaves saved preferences intact", "A reduced owner cap is immediately advertised and enforced"] }, null, 2));
  } finally { await local?.stop(); await gateway.close(); await runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
