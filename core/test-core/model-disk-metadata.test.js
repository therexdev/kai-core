"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { ModelManager } = require("../lib/model-manager");
const { JsonStore } = require("../lib/store");

function fixture(t, vision = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-model-sizes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const catalogPath = path.join(root, "catalog.json"), modelsDir = path.join(root, "models");
  fs.mkdirSync(modelsDir);
  fs.writeFileSync(catalogPath, JSON.stringify({ aliases: { tiny: { label: "Tiny", blurb: "Small local model · 1 GB", package: "tiny@1" } }, packages: { "tiny@1": { filename: "tiny.gguf", sizeBytes: 1000, ...(vision ? { vision: true, mmproj: { filename: "vision.gguf", sizeBytes: 200 } } : {}) } } }));
  const state = new JsonStore(path.join(root, "state.json"), {});
  const manager = new ModelManager({ catalogPath, modelsDir, state });
  return { root, state, manager, file: name => path.join(modelsDir, name), row: () => manager.aliases()[0] };
}

test("model cards distinguish expected download size from actual files on disk", t => {
  const f = fixture(t);
  assert.equal(f.row().diskBytes, 0);
  assert.equal(f.row().downloadSizeBytes, 1000);
  fs.writeFileSync(f.file("tiny.gguf.part"), Buffer.alloc(120));
  assert.equal(f.row().status, "partial"); assert.equal(f.row().diskBytes, 120);
  fs.renameSync(f.file("tiny.gguf.part"), f.file("tiny.gguf"));
  assert.equal(f.row().status, "ready"); assert.equal(f.row().diskBytes, 120, "installed size must be measured rather than copied from the catalog");
  assert.equal(f.row().sizeBytes, 1000, "existing expected weights-size API remains unchanged");
  fs.unlinkSync(f.file("tiny.gguf")); assert.equal(f.row().diskBytes, 0);
});

test("vision model disk usage includes projector and partial files", t => {
  const f = fixture(t, true);
  assert.equal(f.row().downloadSizeBytes, 1200);
  fs.writeFileSync(f.file("tiny.gguf"), Buffer.alloc(1000));
  fs.writeFileSync(f.file("vision.gguf.part"), Buffer.alloc(70));
  assert.equal(f.row().diskBytes, 1070);
  fs.unlinkSync(f.file("vision.gguf.part")); fs.writeFileSync(f.file("vision.gguf"), Buffer.alloc(200));
  assert.equal(f.row().diskBytes, 1200);
  fs.writeFileSync(f.file("tiny.gguf.part"), Buffer.alloc(30));
  assert.equal(f.row().diskBytes, 1230, "leftover partial data still uses disk space");
  f.manager.catalog.packages["tiny@1"].mmproj.sizeBytes = null;
  assert.equal(f.row().downloadSizeBytes, null, "unknown projector size must not understate the total");
  assert.equal(f.row().diskBytes, 1230);
});

test("imported model sizes follow the referenced file without copying or exposing its path", t => {
  const f = fixture(t), file = path.join(f.root, "imported.gguf");
  fs.writeFileSync(file, Buffer.alloc(75));
  f.state.set("customModels", [{ alias: "custom-imported", label: "Imported", path: file, sha256: "a".repeat(64), sizeBytes: 999 }]);
  const imported = () => f.manager.aliases().find(row => row.custom);
  assert.equal(imported().diskBytes, 75); assert.equal(imported().downloadSizeBytes, 999);
  assert.equal(Object.hasOwn(imported(), "path"), false);
  fs.appendFileSync(file, Buffer.alloc(25)); assert.equal(imported().diskBytes, 100);
  fs.unlinkSync(file); assert.equal(imported().status, "missing"); assert.equal(imported().diskBytes, 0);
});

test("non-file model paths and unknown catalog sizes do not become misleading zero-sized models", t => {
  const f = fixture(t); fs.mkdirSync(f.file("tiny.gguf"));
  assert.equal(f.row().diskBytes, null);
  delete f.manager.catalog.packages["tiny@1"].sizeBytes;
  assert.equal(f.row().downloadSizeBytes, null);
  assert.equal(f.row().sizeBytes, null);
});
