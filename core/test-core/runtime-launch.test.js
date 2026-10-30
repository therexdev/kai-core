"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { LlamaCppRuntime } = require("../lib/runtimes/llamacpp");

test("a missing inference executable fails promptly instead of waiting for model loading", { timeout: 7000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-missing-engine-"));
  const events = [], runtime = new LlamaCppRuntime({ binPath: path.join(dir, "missing-engine.exe"), onEvent: e => events.push(e) });
  t.after(() => { runtime.stop(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });
  const started = Date.now();
  await assert.rejects(runtime.start({ modelPath: path.join(dir, "model.gguf") }), /ENOENT/);
  assert.ok(Date.now() - started < 5000, "spawn error must not consume the 120-second readiness timeout");
  assert.equal(runtime.status().running, false);
  assert.equal(runtime.status().model, null);
  assert.equal(events.find(e => e.type === "runtime:crashed").code, "ENOENT");
});
