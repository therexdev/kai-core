"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http"), crypto = require("node:crypto");
const { aliases, verifyModel, prepareSmokeModels } = require("../../scripts/foundation/prepare-smoke-models");

test("release model cache downloads pinned bytes once and verifies them again without network access", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-smoke-cache-")), bytes = Buffer.alloc(4096, "model-cache-fixture");
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.end(bytes); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const catalog = { aliases: {}, packages: {} };
  for (const alias of aliases) {
    catalog.aliases[alias] = { package: alias };
    catalog.packages[alias] = { filename: alias + ".gguf", sizeBytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), url: `http://127.0.0.1:${server.address().port}/${alias}` };
  }
  await prepareSmokeModels(dir, { catalog, log() {} }); assert.equal(requests, aliases.length);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await prepareSmokeModels(dir, { catalog, log() {} }); assert.equal(requests, aliases.length);
  const file = path.join(dir, catalog.packages[aliases[0]].filename), tampered = Buffer.from(bytes); tampered[0] ^= 1; fs.writeFileSync(file, tampered);
  await assert.rejects(prepareSmokeModels(dir, { catalog, log() {} }), /hash mismatch/);
  assert.deepEqual(fs.readFileSync(file), tampered, "corrupt cache bytes are retained for diagnosis, never loaded or silently replaced");
});

test("cached model verification rejects changed size, non-files and cancellation", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-smoke-verify-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "model.gguf"), bytes = Buffer.from("verified bytes"), model = { sizeBytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  fs.writeFileSync(file, bytes.subarray(1)); await assert.rejects(verifyModel(file, model), /size mismatch/);
  await assert.rejects(verifyModel(dir, model), /regular file/);
  fs.writeFileSync(file, bytes); await assert.rejects(verifyModel(file, model, AbortSignal.abort()), { name: "AbortError" });
});
