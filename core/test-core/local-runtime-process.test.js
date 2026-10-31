"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), { spawn } = require("node:child_process");
const { LlamaCppRuntime } = require("../lib/runtimes/llamacpp");
const { RuntimeManager } = require("../lib/runtime-manager");
const { OllamaRuntime } = require("../lib/runtimes/ollama");
async function until(check) { const end = Date.now() + 3000; while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check()); }

test("cancelling real engine startup stops and reaps its child before reporting completion", async t => {
  let child, closed = false;
  const runtime = new LlamaCppRuntime({ binPath: process.execPath, spawnProcess: (_bin, args, options) => {
    child = spawn(process.execPath, [path.join(__dirname, "../test/fixtures/fake-llama-server.js"), ...args], { ...options, env: { ...options.env, FAKE_LLAMA_DELAY_MS: "30000" } });
    child.once("close", () => { closed = true; }); return child;
  } });
  t.after(() => runtime.stop());
  const controller = new AbortController(), loading = runtime.start({ modelPath: "fixture.gguf", signal: controller.signal });
  const rejected = assert.rejects(loading, { name: "AbortError" });
  await until(() => child?.pid); controller.abort(); await rejected;
  assert.equal(closed, true); assert.equal(runtime.status().running, false);
});

test("engine stdout is drained so a verbose child cannot block before its health endpoint starts", async t => {
  const script = `const fs=require('node:fs'),http=require('node:http');fs.writeSync(1,Buffer.alloc(2*1024*1024,120));const p=process.argv.indexOf('--port');http.createServer((req,res)=>res.end('ok')).listen(Number(process.argv[p+1]),'127.0.0.1');`;
  const runtime = new LlamaCppRuntime({ binPath: process.execPath, spawnProcess: (_bin, args, options) => spawn(process.execPath, ["-e", script, "--", ...args], options) });
  t.after(() => runtime.stop());
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000);
  try { await runtime.start({ modelPath: "fixture.gguf", signal: controller.signal }); }
  finally { clearTimeout(timeout); }
  assert.equal(runtime.status().running, true); await runtime.stop(); assert.equal(runtime.status().running, false);
});

test("a model switch waits for the previous process to stop before allocating the next model", async () => {
  let stopOld, stopped = false; const starts = [];
  const manager = new RuntimeManager({
    models: { resolveAlias: alias => ({ packageId: alias }), ensurePackage: async alias => alias },
    makeRuntime: () => { let model, running = false; return { endpoint: "http://fixture", status: () => ({ running, kind: "llamacpp" }),
      start: async ({ modelPath }) => { model = modelPath; starts.push(model); running = true; },
      stop: () => model === "old" ? new Promise(resolve => { stopOld = () => { stopped = true; running = false; resolve(); }; }) : (running = false),
    }; },
  });
  await manager.ensure("old"); const next = manager.ensure("new"); await until(() => stopOld);
  assert.deepEqual(starts, ["old"]); stopOld(); await next; assert.equal(stopped, true); assert.deepEqual(starts, ["old", "new"]); await manager.stop();
});

test("an asynchronous fallback-engine launch error is handled without crashing Core", async t => {
  const detect = OllamaRuntime.detect, locate = OllamaRuntime.locate, events = [];
  t.after(() => { OllamaRuntime.detect = detect; OllamaRuntime.locate = locate; });
  OllamaRuntime.detect = async () => null;
  OllamaRuntime.locate = async () => path.join(__dirname, "missing-ollama-fixture-executable");
  assert.equal(await OllamaRuntime.ensureRunning({ onEvent: event => events.push(event) }), null);
  assert.ok(events.some(event => event.type === "runtime:ollama-start-failed"));
});

test("cancelling fallback provisioning never launches an orphan daemon", async t => {
  const detect = OllamaRuntime.detect, locate = OllamaRuntime.locate;
  t.after(() => { OllamaRuntime.detect = detect; OllamaRuntime.locate = locate; });
  OllamaRuntime.detect = async () => null; OllamaRuntime.locate = async () => null;
  let provisioning = false, spawned = false;
  const controller = new AbortController();
  const loading = OllamaRuntime.ensureRunning({ signal: controller.signal,
    provision: ({ signal }) => new Promise((resolve, reject) => { provisioning = true; signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }),
    spawnProcess: () => { spawned = true; throw Error("must not launch"); },
  });
  const rejected = assert.rejects(loading, { name: "AbortError" });
  await until(() => provisioning); controller.abort(); await rejected; assert.equal(spawned, false);
});

test("runtime preflight forwards cancellation to fallback setup and preserves the abort", async () => {
  let setupSignal;
  const controller = new AbortController();
  const runtime = new RuntimeManager({
    models: {}, makeRuntime: () => {},
    provisioner: { selectBuild() { throw Error("No managed engine"); } },
    makeFallback: ({ signal }) => new Promise((resolve, reject) => {
      setupSignal = signal; signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  const pending = runtime.preflight({ signal: controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  assert.equal(setupSignal, controller.signal); controller.abort(); await rejected;
});
