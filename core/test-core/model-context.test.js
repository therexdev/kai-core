"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { ModelManager } = require("../lib/model-manager"), { JsonStore } = require("../lib/store"), { RuntimeManager } = require("../lib/runtime-manager");
const { ggufContext } = require("../lib/model-context"), { Gateway } = require("../lib/gateway"), { OllamaRuntime } = require("../lib/runtimes/ollama");
const { chatInput } = require("../../electron/core-chat"), { conversation, createChatController } = require("../../ui-core/chat");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, "state.json");
  const reopen = () => new ModelManager({ catalogPath: path.join(__dirname, "../models/catalog.json"), modelsDir: root, state: new JsonStore(statePath) });
  const models = reopen(), starts = [], stops = [];
  models.ensurePackage = async packageId => packageId;
  const runtime = new RuntimeManager({ models, makeRuntime: () => {
    let running = false;
    return { endpoint: "http://fixture", status: () => ({ running }), async start(options) { starts.push(options); this.contextSize = options.contextSize; running = true; }, async stop() { stops.push(true); running = false; } };
  } });
  t.after(() => runtime.stop());
  return { root, models, runtime, starts, stops, reopen };
}
const u32 = number => { const b = Buffer.alloc(4); b.writeUInt32LE(number); return b; };
const u64 = number => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(number)); return b; };
const str = value => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);
function gguf(size, reverse = false) {
  const entries = [Buffer.concat([str("general.architecture"), u32(8), str("qwen2")]), Buffer.concat([str("qwen2.context_length"), u32(4), u32(size)])];
  return Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(2), ...(reverse ? entries.reverse() : entries)]);
}

test("catalog contexts follow the native configurations, including Qwen's non-YaRN 32K default", t => {
  const f = fixture(t);
  const expected = { "koinos-fast": 32768, "koinos-smart": 32768, "qwen25-14b": 32768, "qwen25-32b": 32768, "qwen-coder-7b": 32768, "qwen-coder-32b": 32768,
    "koinos-balanced": 131072, "llama31-8b": 131072, "gemma3-4b": 131072, "gemma3-12b": 131072, "gemma3-27b": 131072,
    "mistral-7b": 32768, "mistral-small-24b": 32768, "phi-4": 16384, "deepseek-r1-32b": 131072, "lfm3-1.7b": 262144, "dev-tiny": 8192 };
  for (const model of f.models.aliases()) {
    assert.equal(model.contextSize, expected[model.alias]); assert.equal(model.maxContextSize, expected[model.alias]); assert.equal(model.contextLimitKnown, true);
  }
});

test("a per-package choice survives restart, leaves other models alone and resets to the model default", t => {
  const f = fixture(t);
  f.models.setContextSize("koinos-smart", 8192);
  assert.equal(f.reopen().resolveAlias("koinos-smart").contextSize, 8192);
  assert.equal(f.models.resolveAlias("phi-4").contextSize, 16384);
  for (const value of [0, -1, 1024, 2048, 65536, 8192.1, "8192", NaN, Infinity, undefined]) assert.throws(() => f.models.setContextSize("koinos-smart", value));
  assert.equal(f.reopen().resolveAlias("koinos-smart").contextSize, 8192);
  f.models.setContextSize("koinos-smart", null);
  assert.equal(f.reopen().resolveAlias("koinos-smart").contextSize, 32768);
});

test("changing context reloads the same alias on its next request and cannot interrupt an active reply", async t => {
  const f = fixture(t);
  const hold = await f.runtime.acquireFor("koinos-smart", { contextSize: 32768 });
  assert.equal(f.starts[0].contextSize, 32768);
  assert.throws(() => f.runtime.configureContext("koinos-smart", 8192), /active model requests/);
  assert.equal(f.stops.length, 0); hold.release();
  f.runtime._networkWork = 1; // Idle provider polling must not make settings unusable.
  f.runtime.configureContext("koinos-smart", 8192);
  f.runtime._networkWork = 0;
  assert.equal(f.runtime.status().contextSize, 32768);
  const next = await f.runtime.acquireFor("koinos-smart", { contextSize: 8000 });
  assert.equal(f.stops.length, 1); assert.deepEqual(f.starts.map(start => start.contextSize), [32768, 8192]);
  assert.equal(f.runtime.status().contextSize, 8192); next.release();
  await f.runtime.ensure("koinos-smart"); assert.equal(f.starts.length, 2);
});

test("automatic tasks grow context, reuse a sufficient window and never change the saved model ceiling", async t => {
  const f = fixture(t);
  const first = await f.runtime.acquireFor("koinos-smart");
  assert.equal(first.contextSize, 4096);
  let secondReady = false;
  const second = f.runtime.acquireFor("koinos-smart", { contextSize: 12000 }).then(lease => { secondReady = true; return lease; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondReady, false);
  assert.equal(f.stops.length, 0);
  first.release();
  const larger = await second;
  assert.equal(larger.contextSize, 16384);
  larger.release();
  const smaller = await f.runtime.acquireFor("koinos-smart");
  assert.equal(smaller.contextSize, 16384);
  smaller.release();
  assert.deepEqual(f.starts.map(start => start.contextSize), [4096, 16384]);
  assert.equal(f.models.resolveAlias("koinos-smart").contextSize, 32768);
  assert.equal(f.models.resolveAlias("koinos-smart").contextOverride, null);
  await assert.rejects(f.runtime.acquireFor("koinos-smart", { contextSize: 65536 }), /32768-token limit/);
  assert.equal(f.starts.length, 2);
});

test("a reported smaller window cannot satisfy a larger plugin request", async t => {
  const f = fixture(t);
  f.runtime.makeRuntime = () => ({ contextSize: 4096, endpoint: "http://fixture", status: () => ({ running: true }), async start() {}, async stop() {} });
  await assert.rejects(f.runtime.acquireFor("koinos-smart", { contextSize: 32768 }), /could not verify/);
  assert.equal(f.runtime.status().contextVerified, false);
  assert.equal(f.runtime.status().inference.activeAlias, null);
  assert.equal(f.models.resolveAlias("koinos-smart").contextOverride, null);
});

test("Ollama verification holds the engine against concurrent model preparation", async t => {
  const f = fixture(t);
  let finishVerification, stops = 0;
  f.runtime.makeRuntime = () => ({
    endpoint: "http://fixture", status: () => ({ running: true, kind: "ollama" }),
    async start({ contextSize }) { this.contextSize = contextSize; },
    async stop() { stops++; },
    async verifyContext() { await new Promise(resolve => { finishVerification = resolve; }); },
  });
  const pending = f.runtime.acquireFor("koinos-smart");
  await new Promise(resolve => setImmediate(resolve));
  const preparing = f.runtime.ensure("koinos-smart", { contextSize: 32768 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stops, 0);
  finishVerification();
  const lease = await pending;
  assert.equal(lease.contextSize, 4096);
  assert.equal(stops, 0);
  lease.release();
  await preparing;
  assert.equal(stops, 1);
  assert.equal(f.runtime.status().contextSize, 32768);
});

test("runtime verification reads the live engine and refuses wrong slots, missing runners and undersized contexts", async t => {
  const http = require("node:http"), { LlamaCppRuntime } = require("../lib/runtimes/llamacpp");
  let size = 32768, slots = 1, runnerName = "qwen-ctx32768:latest", warmups = 0;
  const engine = http.createServer((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    if (req.url === "/props") return res.end(JSON.stringify({ total_slots: slots, default_generation_settings: { n_ctx: size } }));
    if (req.url === "/api/ps") return res.end(JSON.stringify({ models: [{ name: runnerName, context_length: size }] }));
    warmups++;
    res.end("{}");
  });
  await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
  t.after(async () => { engine.closeAllConnections(); await new Promise(resolve => engine.close(resolve)); });
  const llama = new LlamaCppRuntime({ binPath: "/fixture", port: engine.address().port });
  const ollama = new OllamaRuntime({ port: engine.address().port });
  ollama.model = "qwen-ctx32768";
  assert.equal(await llama.verifyContext(32768), 32768);
  assert.equal(await ollama.verifyContext(32768), 32768);
  assert.equal(warmups, 0);
  slots = 2;
  await assert.rejects(llama.verifyContext(32768), /verified/);
  slots = 1; size = 4096;
  await assert.rejects(llama.verifyContext(32768), /verified/);
  await assert.rejects(ollama.verifyContext(32768), /verified/);
  size = 32768; runnerName = "someone-elses-model";
  await assert.rejects(ollama.verifyContext(32768), /verified/);
  assert.equal(warmups, 1);
  assert.equal(ollama.contextSize, null);
});

test("network context requirements are checked against approved tariffs before creating spending terms", () => {
  const { request } = require("../../electron/koin-chat-flow");
  const config = { model: "qwen", maxOutput: 256 };
  const tariffs = [{ model: "qwen", contextTokens: 4096, maxOutputTokens: 256 }];
  const input = { model: "koinos-network:qwen", messages: [{ role: "user", content: "Hello" }] };
  const automatic = request(input, config, tariffs);
  assert.deepEqual(request({ ...input, context_tokens: 4096 }, config, tariffs), automatic);
  for (const context_tokens of [32768, 0, null, "4096", 4096.5])
    assert.throws(() => request({ ...input, context_tokens }, config, tariffs), /4096 context tokens/);
});

test("bounded GGUF metadata discovers a native context and rejects malformed or unsupported headers", () => {
  assert.equal(ggufContext(gguf(32768)), 32768); assert.equal(ggufContext(gguf(32768, true)), 32768);
  for (const header of [Buffer.alloc(10), gguf(32768).subarray(0, 50), gguf(0), gguf(100000000)]) assert.equal(ggufContext(header), null);
  const malicious = gguf(32768); malicious.writeBigUInt64LE(2n ** 63n, 24); assert.equal(ggufContext(malicious), null);
});

test("new and existing custom imports get their GGUF context, without losing paths or saved choices", async t => {
  const f = fixture(t), file = path.join(f.root, "custom.gguf"); fs.writeFileSync(file, gguf(32768));
  const entry = await f.models.importCustom({ path: file });
  assert.equal(f.models.resolveAlias(entry.alias).contextSize, 32768);
  f.models.setContextSize(entry.alias, 8192);
  f.models._saveCustoms([{ ...entry, contextSize: 4096, contextMetadataVersion: undefined, contextUnknown: undefined }]);
  await f.models.refreshCustomContexts();
  assert.equal(f.models.resolveAlias(entry.alias).contextSize, 8192);
  assert.equal(f.models.resolveAlias(entry.alias).defaultContextSize, 32768);
  assert.equal(f.models._customs()[0].path, file); assert.ok(fs.existsSync(file));
  const unknown = path.join(f.root, "unknown.gguf"); fs.writeFileSync(unknown, "GGUF-unknown");
  const other = await f.models.importCustom({ path: unknown });
  assert.equal(f.models.resolveAlias(other.alias).contextLimitKnown, false);
  assert.equal(f.models.setContextSize(other.alias, 32768).contextSize, 32768);
});

test("Ollama registrations carry num_ctx and use a distinct name for each context", async () => {
  const runtime = new OllamaRuntime(), calls = [];
  runtime._runningContext = async () => Number(runtime.model.split("-ctx")[1]);
  runtime._api = async (route, body) => { calls.push({ route, body }); return new Response("{}", { status: route === "/api/show" ? 404 : 200 }); };
  // A real tiny file keeps the upload-stream path exercised without large weights.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ollama-context-")), file = path.join(root, "model.gguf"); fs.writeFileSync(file, gguf(32768));
  runtime._api = async (route, body) => {
    calls.push({ route, body });
    if (route.startsWith("/api/blobs")) for await (const _chunk of body) { /* drain */ }
    return new Response("{}", { status: route === "/api/show" ? 404 : 200 });
  };
  try {
    for (const contextSize of [32768, 8192]) await runtime.start({ modelPath: file, sha256: "a".repeat(64), modelName: "qwen", contextSize });
    assert.deepEqual(calls.filter(call => call.route === "/api/create").map(call => call.body.parameters.num_ctx), [32768, 8192]);
    assert.equal(runtime.servedName(), "qwen-ctx8192");
  } finally { runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("local chat retains more than 24 KB and 15 turns when the selected window allows it", async () => {
  const history = Array.from({ length: 25 }, (_, n) => ({ prompt: `Question ${n}: ` + "x".repeat(1800), answer: "answer", state: "done" }));
  const messages = conversation(history, "Follow up", 32768);
  assert.equal(messages.length, 51); assert.ok(JSON.stringify(messages).length > 24000);
  assert.equal(chatInput({ model: "qwen", messages }, [{ alias: "qwen", status: "ready", contextSize: 32768 }]).messages.length, 51);
  assert.ok(conversation(history, "Follow up", 4096).length < 15);
  assert.ok(conversation(history, "Follow up").length <= 31, "network transport keeps its existing bound");
  const sent = [];
  const controller = createChatController({ bridge: { call: async (method, input) => { sent.push(input); return { text: "Answer" }; } } });
  controller.update({ models: [{ alias: "qwen", status: "ready", contextSize: 32768 }], network: { privacyMode: "local-only" } });
  assert.equal(await controller.send("x".repeat(30000)), true);
  assert.equal(sent[0].messages[0].content.length, 30000);
});

test("gateway accepts a prompt above 4K under 32K, enforces saved reductions and reserves requested output", async t => {
  const f = fixture(t); let forwarded = 0, forwardedBody;
  const http = require("node:http");
  const engine = http.createServer((req, res) => { let raw = ""; req.on("data", chunk => { raw += chunk; }); req.on("end", () => { forwarded++; forwardedBody = JSON.parse(raw); res.setHeader("content-type", "application/json"); res.end('{"choices":[{"message":{"content":"ok"}}]}'); }); });
  await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
  f.runtime.makeRuntime = () => ({ endpoint: `http://127.0.0.1:${engine.address().port}`, status: () => ({ running: true }), async start({ contextSize }) { this.contextSize = contextSize; }, stop: async () => {} });
  const gateway = new Gateway({ port: 0, models: f.models, runtime: f.runtime, keys: { required: () => false } }); await gateway.listen();
  t.after(async () => { await gateway.close(); engine.closeAllConnections(); await new Promise(resolve => engine.close(resolve)); });
  const post = (route, body) => fetch(`http://127.0.0.1:${gateway.port}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const request = { model: "koinos-smart", messages: [{ role: "user", content: "x".repeat(24000) }], max_tokens: 1024, kai_private_desktop: true };
  let reply = await post("/core/chat/completions", request); assert.equal(reply.status, 200); assert.equal(reply.headers.get("x-kai-context-size"), "8192"); await reply.text();
  reply = await post("/core/chat/completions", { ...request, context_tokens: 32768 });
  assert.equal(reply.status, 200); assert.equal(reply.headers.get("x-kai-context-size"), "32768"); await reply.text();
  assert.equal(forwardedBody.context_tokens, undefined);
  assert.equal(f.models.resolveAlias("koinos-smart").contextOverride, null);
  reply = await post("/core/models/context", { alias: "koinos-smart", contextSize: 4096 }); assert.equal(reply.status, 200); await reply.text();
  reply = await post("/core/chat/completions", request); assert.equal(reply.status, 400); await reply.text();
  reply = await post("/core/models/context", { alias: "koinos-smart", contextSize: 65536 }); assert.equal(reply.status, 400); await reply.text();
  reply = await post("/core/chat/completions", { ...request, messages: [{ role: "user", content: "x".repeat(8000) }], max_tokens: 3000 });
  assert.equal(reply.status, 400); await reply.text(); assert.equal(forwarded, 2);
});
