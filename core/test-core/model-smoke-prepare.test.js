"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { prepareModel } = require("../../scripts/foundation/model-smoke-prepare");

test("release preparation resumes a partial download and verifies its exact pinned bytes", async t => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http"), crypto = require("node:crypto");
  const { downloadFile } = require("../lib/download"), bytes = Buffer.alloc(65536, "verified-model-test");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-model-smoke-resume-")), file = path.join(directory, "model.gguf");
  const requests = [], retries = [];
  const server = http.createServer((req, res) => {
    requests.push(req.headers.range || null);
    const offset = Number((req.headers.range || "").match(/^bytes=(\d+)-$/)?.[1] || 0);
    res.writeHead(offset ? 206 : 200, { "content-length": bytes.length - offset,
      ...(offset ? { "content-range": `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}) });
    if (requests.length === 1) { res.write(bytes.subarray(0, 16384)); setTimeout(() => res.destroy(), 50); }
    else res.end(bytes.subarray(offset));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  await prepareModel(() => downloadFile(`http://127.0.0.1:${server.address().port}/model`, file,
    { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length }),
  { wait: async () => {}, onRetry: attempt => retries.push(attempt) });
  assert.deepEqual(requests, [null, "bytes=16384-"]); assert.deepEqual(retries, [2]);
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(fs.existsSync(file + ".part"), false);
});

test("release preparation bounds transport retries and propagates an exhausted failure", async () => {
  const error = Object.assign(Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
  let calls = 0; const waits = [];
  await assert.rejects(prepareModel(async () => { calls++; throw error; }, { wait: async ms => waits.push(ms) }), e => e === error);
  assert.equal(calls, 4); assert.deepEqual(waits, [1000, 2000, 3000]);
});

test("hash failures, invalid ranges, assertions and cancellation are never retried", async () => {
  for (const message of ["Downloaded file failed SHA-256 verification — discarded.", "Download returned an invalid resume range", "Assertion failed", "fetch failed"]) {
    let calls = 0; const error = Error(message);
    await assert.rejects(prepareModel(async () => { calls++; throw error; }, { wait: async () => assert.fail("Unexpected retry") }), e => e === error);
    assert.equal(calls, 1);
  }
  const stop = new AbortController(); let calls = 0;
  await assert.rejects(prepareModel(async () => { calls++; stop.abort(); throw new TypeError("terminated"); },
    { signal: stop.signal, wait: async () => assert.fail("Cancelled preparation retried") }), { name: "AbortError" });
  assert.equal(calls, 1);
});
