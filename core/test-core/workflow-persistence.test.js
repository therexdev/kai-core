"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { FeatureServices } = require("../../electron/plugin-services");
const { CompanionWorkflows } = require("../../electron/companion-workflows");
const { CompanionError } = require("../../electron/companion-store");
const Model = require("../../ui/workflow-model");
function setup(t, runLocal) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-workflow-conflict-"));
  const features = new FeatureServices({ dataDir, electron: { safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() } } });
  const store = features.getCompanionStore(), engine = new CompanionWorkflows({ store, models: () => [{ alias: "local", status: "ready" }], runLocal, connections: { list: () => [] } });
  t.after(async () => { engine.stop(); await features.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { engine, features, store };
}
async function stopped(engine, key) { for (let i = 0; i < 200; i++) { if (!engine.active.has(key)) { await new Promise(resolve => setImmediate(resolve)); return; } await new Promise(resolve => setTimeout(resolve, 5)); } throw Error("Workflow did not stop"); }
test("guarded companion file conflict during model execution preserves disk and contains the background failure", async t => {
  let finishModel, announceStart; const started = new Promise(resolve => { announceStart = resolve; });
  const { engine, features, store } = setup(t, () => new Promise(resolve => { finishModel = resolve; announceStart(); }));
  const warnings = t.mock.method(console, "warn", () => {}), workflow = engine.save(Model.template("ask", "local"));
  const key = engine.begin(workflow.id, "private input sentinel"); await started;
  const replacement = '{"external":"private conflict sentinel"}'; fs.writeFileSync(store.file, replacement);
  finishModel("private result sentinel"); await stopped(engine, key);
  assert.equal(fs.readFileSync(store.file, "utf8"), replacement, "external file must never be overwritten by error handling");
  assert.equal(engine.active.size, 0); assert.throws(() => features.getCompanionStore(), /changed outside Core/);
  assert.equal(warnings.mock.calls.length, 1); const logged = warnings.mock.calls[0].arguments.join(" ");
  assert.match(logged, /failure status could not be saved/); assert.doesNotMatch(logged, /sentinel|private input|private result|private conflict/);
  // No synthetic completed/failed record is written when guarded persistence is
  // unavailable. The original durable in-flight outcome remains uncertain.
  assert.equal(engine.get(key).status, "running"); assert.ok(engine.get(key).inFlight);
});
test("ordinary model failures still persist their failed status and reviewable message", async t => {
  const { engine, store } = setup(t, async () => { throw new CompanionError("The selected local model is unavailable."); });
  const warnings = t.mock.method(console, "warn", () => {}), workflow = engine.save(Model.template("ask", "local"));
  const key = engine.begin(workflow.id, "request"); await stopped(engine, key);
  const run = engine.get(key); assert.equal(run.status, "failed"); assert.match(run.error, /local model is unavailable/); assert.ok(run.finishedAt);
  assert.equal(warnings.mock.calls.length, 0);
  const saved = JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(store.file, "utf8")).encrypted, "base64").toString());
  assert.equal(saved.runs.find(r => r.id === key).status, "failed"); assert.match(saved.runs.find(r => r.id === key).error, /local model is unavailable/);
});
