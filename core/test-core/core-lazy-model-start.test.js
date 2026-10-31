"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { createCore } = require("../server");

test("Core opens with one installed model without starting it; explicit load and first chat still prepare it", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-lazy-model-")));
  const requests = [], starts = [];
  const engine = http.createServer((req, res) => {
    let raw = ""; req.on("data", bytes => { raw += bytes; }); req.on("end", () => {
      requests.push(JSON.parse(raw)); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: "ready" } }] }));
    });
  });
  await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
  const core = await createCore({ dataDir: root, port: 0, llamaBin: process.execPath, onEvent() {} });
  t.after(async () => { await core.stop(); engine.closeAllConnections(); await new Promise(resolve => engine.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  core.models.aliases = () => [{ alias: "tiny", label: "Tiny", status: "ready" }];
  core.models.resolveAlias = alias => { assert.equal(alias, "tiny"); return { packageId: alias, contextSize: 4096 }; };
  core.models.ensurePackage = async alias => alias;
  core.runtime.makeRuntime = () => {
    let running = false;
    return { endpoint: `http://127.0.0.1:${engine.address().port}`, status: () => ({ kind: "llamacpp", running }),
      start: async ({ modelPath }) => { starts.push(modelPath); running = true; }, stop: () => { running = false; } };
  };
  await core.start(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, []); assert.equal(core.runtime.status().loading, false); assert.equal(core.runtime.status().runtime, null);
  await core.runtime.ensure("tiny"); assert.deepEqual(starts, ["tiny"]);
  await core.runtime.stop();
  const response = await fetch(`http://127.0.0.1:${core.gateway.port}/core/chat/completions`, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify({ model: "tiny", kai_private_desktop: true, messages: [{ role: "user", content: "hello" }] }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).choices[0].message.content, "ready");
  assert.deepEqual(starts, ["tiny", "tiny"]); assert.equal(requests.length, 1);
});
