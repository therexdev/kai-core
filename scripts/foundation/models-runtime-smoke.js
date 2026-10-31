"use strict";

// Release gate using real, hash-pinned GGUF weights and the managed engine.
// No wallet, account, provider, GPU claim or synthetic model response is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { JsonStore } = require("../../core/lib/store");
const { ApiKeys } = require("../../core/lib/keys");
const { ModelManager } = require("../../core/lib/model-manager");
const { RuntimeProvisioner } = require("../../core/lib/runtime-provisioner");
const { RuntimeManager } = require("../../core/lib/runtime-manager");
const { LlamaCppRuntime } = require("../../core/lib/runtimes/llamacpp");
const { Gateway } = require("../../core/lib/gateway");
const { CoreChat } = require("../../electron/core-chat");

const source = path.resolve(__dirname, "../..");
const aliases = ["lfm3-1.7b", "koinos-fast"];
const maxReplyBytes = 1024 * 1024;
async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function visibleReply(text, expected) {
  assert.equal(typeof text, "string", "The model must produce visible text");
  assert(text.trim(), "The model produced only reasoning or an empty answer");
  assert.doesNotMatch(text, /<\/?think>|<\|(?:im_start|im_end|endoftext)\|>/i, "Reasoning or chat-template tokens leaked into the answer");
  assert.match(text, expected, "The real model did not answer the basic smoke prompt");
}
async function streamReply(response, signal) {
  assert.equal(response.status, 200, `Streaming chat failed: ${await (response.ok ? Promise.resolve("") : response.text())}`);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = "", text = "", bytes = 0, doneMarker = false, contentChunks = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      assert(bytes <= maxReplyBytes, "Streaming response exceeded the bounded smoke limit");
      pending += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { doneMarker = true; continue; }
        const event = JSON.parse(data);
        assert(!event.error, `Streaming error: ${JSON.stringify(event.error)}`);
        const content = event.choices?.[0]?.delta?.content;
        if (typeof content === "string" && content) { text += content; contentChunks++; }
      }
    }
    assert(doneMarker, "The gateway did not deliver the SSE completion marker");
    assert(contentChunks > 0, "The gateway did not deliver any visible answer chunks");
    return { text, contentChunks };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "kai-real-model-smoke-"));
  const output = path.resolve(process.env.KAI_MODEL_SMOKE_OUTPUT || path.join(os.tmpdir(), "kai-models-runtime-smoke"));
  const cache = path.resolve(process.env.KAI_MODEL_SMOKE_CACHE || path.join(profile, "cache"));
  const modelsDir = path.resolve(process.env.KAI_MODEL_SMOKE_MODELS_DIR || path.join(cache, "models"));
  fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(modelsDir, { recursive: true });
  const report = { platform: process.platform, arch: process.arch, appVersion: require("../../package.json").version,
    realInference: true, syntheticResponses: false, backend: "cpu", gpuPerformanceTested: false, checks: [], models: [] };
  const events = [], children = new Set(), adapters = new Set(), stop = new AbortController();
  const originalFetch = globalThis.fetch;
  // One bounded lifetime covers downloads, gateway calls and engine responses.
  globalThis.fetch = (input, init = {}) => originalFetch(input, { ...init,
    signal: init.signal ? AbortSignal.any([init.signal, stop.signal]) : stop.signal });
  const state = new JsonStore(path.join(profile, "state.json"), {});
  const settings = new JsonStore(path.join(profile, "settings.json"), {});
  const event = value => {
    events.push({ at: Date.now(), ...value }); if (events.length > 1000) events.shift();
    if (!["model:download", "runtime:download"].includes(value.type)) console.log(`[models-runtime] ${value.type}`);
  };
  const models = new ModelManager({ catalogPath: path.join(source, "core/models/catalog.json"), modelsDir, state, onEvent: event });
  const hardware = { capabilities: { cudaEligible: false, vulkanEligible: false, metalEligible: false }, gpus: [] };
  const provisioner = new RuntimeProvisioner({ catalogPath: path.join(source, "core/runtimes/catalog.json"), runtimesDir: path.join(cache, "runtimes"), hardware, onEvent: event });
  const build = provisioner.selectBuild("llamacpp", { cap: "cpu" });
  report.engine = { version: build.version, build: build.key, archiveSha256: build.sha256 };
  const runtime = new RuntimeManager({ models, hardware, provisioner, state, appVersion: report.appVersion, onEvent: event,
    makeRuntime(binPath) {
      const adapter = new LlamaCppRuntime({ binPath, onEvent: event, spawnProcess(binary, args, options) {
        const child = spawn(binary, args, options); children.add(child); return child;
      } }); adapters.add(adapter); return adapter;
    } });
  const gateway = new Gateway({ port: 0, runtime, models, keys: new ApiKeys(settings), onEvent: event });
  const chat = new CoreChat({ core: { models, runtime, gateway } });
  let timer;
  const shutdownEngines = () => { runtime.stop(); for (const adapter of adapters) adapter.stop(); };
  try {
    await Promise.race([(async () => {
      await gateway.listen();
      for (const alias of aliases) {
        const resolved = models.resolveAlias(alias), filename = path.join(modelsDir, resolved.filename);
        assert(/^[0-9a-f]{64}$/i.test(resolved.sha256), `${alias} has no verified hash`);
        // A supplied/shared cache must meet the same exact identity as a download.
        if (fs.existsSync(filename)) {
          assert.equal(fs.statSync(filename).size, resolved.sizeBytes, `${alias} cached size mismatch`);
          assert.equal(await hashFile(filename), resolved.sha256, `${alias} cached hash mismatch`);
        }
        console.log(`Downloading/verifying and preparing ${alias} with ${build.version} (${build.key})`);
        const began = Date.now();
        await runtime.ensure(alias);
        assert.equal(runtime.status().activeAlias, alias);
        assert.equal(runtime.status().runtime?.running, true);
        const result = { alias, packageId: resolved.packageId, sha256: resolved.sha256, sizeBytes: resolved.sizeBytes,
          prepareMs: Date.now() - began };
        report.models.push(result);
        const firstAt = Date.now();
        const first = await chat.send({ model: alias, messages: [{ role: "user", content: "What is the capital of France? Reply in one short sentence." }], maxTokens: 256 });
        result.desktopChat = { text: first.text, elapsedMs: Date.now() - firstAt };
        visibleReply(first.text, /\bParis\b/i);
        const streamAt = Date.now();
        const response = await fetch(`http://127.0.0.1:${gateway.port}/core/chat/completions`, {
          method: "POST", signal: AbortSignal.timeout(180000),
          headers: { "content-type": "application/json", ...(process.env.KAI_CORE_TOKEN ? { authorization: `Bearer ${process.env.KAI_CORE_TOKEN}` } : {}) },
          body: JSON.stringify({ model: alias, messages: [{ role: "user", content: "What is 2 + 2? Reply with only the answer." }], max_tokens: 256, stream: true, kai_private_desktop: true }),
        });
        const streamed = await streamReply(response, stop.signal);
        result.streamingChat = { ...streamed, elapsedMs: Date.now() - streamAt };
        visibleReply(streamed.text, /\b(?:4|four)\b/i);
        report.checks.push(`${alias}: verified model, managed CPU load, CoreChat answer and gateway SSE answer`);
      }
      // Switching an existing model back to LFM catches stale model/template state.
      await runtime.ensure(aliases[0]);
      const switched = await chat.send({ model: aliases[0], messages: [{ role: "user", content: "What is the capital of France? Reply in one short sentence." }], maxTokens: 256 });
      visibleReply(switched.text, /\bParis\b/i);
      report.checks.push("Existing Qwen model switches back to LFM3 with a usable visible answer");
      report.switchBack = switched;
      report.status = "passed";
    })(), new Promise((_, reject) => {
      timer = setTimeout(() => { stop.abort(Error("Real model smoke exceeded 20 minutes")); models.cancelDownload(); shutdownEngines(); reject(stop.signal.reason); }, 20 * 60000);
    })]);
  } catch (error) { report.status = "failed"; report.error = error.stack || String(error); throw error; }
  finally {
    clearTimeout(timer); stop.abort(); await chat.dispose(); shutdownEngines(); await gateway.close();
    await Promise.all([...children].map(async child => {
      const exited = () => child.exitCode !== null || child.signalCode !== null;
      if (exited()) return;
      let waitTimer;
      const exit = new Promise(resolve => child.once("exit", resolve));
      try { await Promise.race([exit, new Promise(resolve => { waitTimer = setTimeout(resolve, 5000); })]); }
      finally { clearTimeout(waitTimer); }
      if (!exited()) child.kill("SIGKILL");
    }));
    report.processesStopped = [...children].every(child => child.exitCode !== null || child.signalCode !== null);
    if (!report.processesStopped && report.status === "passed") { report.status = "failed"; report.error = "An owned inference process did not stop"; process.exitCode = 1; }
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(output, "events.json"), JSON.stringify(events, null, 2));
    globalThis.fetch = originalFetch;
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
