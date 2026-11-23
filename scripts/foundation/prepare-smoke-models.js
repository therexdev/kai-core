"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { downloadFile } = require("../../core/lib/download"), { prepareModel } = require("./model-smoke-prepare");
const aliases = Object.freeze(["lfm3-1.7b", "koinos-fast"]);

async function verifyModel(file, model, signal) {
  signal?.throwIfAborted();
  assert(fs.lstatSync(file).isFile(), "Cached model must be a regular file");
  assert.equal(fs.statSync(file).size, model.sizeBytes, "Cached model size mismatch");
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
  assert.equal(hash.digest("hex"), model.sha256, "Cached model hash mismatch");
}

// Share only immutable GGUF bytes. Every platform still verifies the pins,
// provisions its own native engine and runs the complete real-inference gate.
async function prepareSmokeModels(directory, { catalog = require("../../core/models/catalog.json"), signal, log = console.log } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  for (const alias of aliases) {
    const model = catalog.packages[catalog.aliases[alias]?.package];
    assert(model && /^[a-f0-9]{64}$/.test(model.sha256) && Number.isSafeInteger(model.sizeBytes) && model.sizeBytes > 0, "Verified model identity required");
    assert.equal(path.basename(model.filename), model.filename, "Model filename must stay inside the cache");
    const file = path.join(directory, model.filename);
    if (!fs.existsSync(file)) {
      log(`Preparing verified model bytes for ${alias}`);
      await prepareModel(() => downloadFile(model.url, file, { sha256: model.sha256, sizeBytes: model.sizeBytes, signal }),
        { signal, onRetry: attempt => log(`Resuming ${alias} model download (attempt ${attempt}/4)`) });
    }
    await verifyModel(file, model, signal);
    log(`Verified ${alias}: ${model.sha256}`);
  }
}
if (require.main === module) {
  prepareSmokeModels(path.resolve(process.argv[2] || ".smoke/models"), { signal: AbortSignal.timeout(20 * 60000) })
    .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
module.exports = { aliases, verifyModel, prepareSmokeModels };
