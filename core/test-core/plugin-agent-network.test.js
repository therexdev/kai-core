"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { create, permissions, pluginId } = require("../../electron/plugin-services/agent-network");
const { template } = require("../lib/agent-network/runtime");
const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "fixture", encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() };
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-plugin-agent-network-")), confirmations = [], inference = [];
  const ctx = { dataDir: dir, electron: { safeStorage: storage }, core: { models: { aliases: () => [{ alias: "fixture-local", label: "Fixture", status: "ready" }] }, gateway: { network: { status: () => ({ privacyMode: "local-only" }) } } },
    confirm: async (title, detail) => { confirmations.push({ title, detail }); return true; },
    localInference: async (input, signal) => { signal.throwIfAborted(); inference.push(input); return { text: "A real local result" }; },
    getCompanionStore: () => ({ requireStorage() {}, data: { workflows: [] } }), ...overrides };
  let service = create(ctx); t.after(() => { service.dispose(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });
  return { dir, ctx, confirmations, inference, get service() { return service; }, reopen() { service.dispose(); service = create(ctx); return service; }, call: (...args) => service.call(...args) };
}
async function until(f, predicate) {
  for (let i = 0; i < 60; i++) { const state = await f.call("agentNetwork.refresh"); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 15)); }
  assert.fail("Service job did not reach expected state");
}
test("broker uses exact service contract and starts without ambient connections", async t => {
  const f = fixture(t), state = await f.call("agentNetwork.status");
  assert.equal(pluginId, "kai.agent-network"); assert.equal(permissions["agentNetwork.fromWorkflow"], "agent-network.write");
  assert.equal(state.sessionActive, false); assert.equal(state.address, null); assert.equal(state.directoryAvailable, false); assert.equal(state.paid, false);
  await assert.rejects(f.call("wallet.unlock", {}), /Unknown/); await assert.rejects(f.call("agentNetwork.save", { template: "echo" }), /Start/);
  await f.call("agentNetwork.settings", { enabled: true, endpoints: [] });
  assert.equal(f.confirmations.length, 1);
  await assert.rejects(f.call("agentNetwork.discover"), /unavailable/);
  const { id } = await f.call("agentNetwork.save", { template: "echo", name: "Local connection check" });
  await assert.rejects(f.call("agentNetwork.publish", { id }), /relay/);
  const out = await f.call("agentNetwork.export", { id }); assert.equal(JSON.parse(out.text).payload.agent_id, id);
  assert.doesNotMatch(JSON.stringify(await f.call("agentNetwork.status")), /encryption_private|"wif"|"definition"/);
  f.reopen(); const resumed = await f.call("agentNetwork.status"); assert.equal(resumed.agents.length, 1); assert.equal(resumed.enabled, true); assert.equal(resumed.sessionActive, false);
});
test("real isolated local job creates a quote, runs, delivers selected input and accepts a free result", async t => {
  const f = fixture(t); await f.call("agentNetwork.settings", { enabled: true, endpoints: [] });
  const { id } = await f.call("agentNetwork.save", { template: "echo", name: "Local echo" });
  const request = await f.call("agentNetwork.quote", { id, input: "Chosen input only" });
  await until(f, s => s.jobs.some(j => j.id === request.id && j.role === "buyer" && j.status === "quoted"));
  await f.call("agentNetwork.submit", { id: request.id });
  const delivered = await until(f, s => s.jobs.some(j => j.id === request.id && j.role === "buyer" && j.status === "delivered"));
  assert.doesNotMatch(JSON.stringify(delivered), /Chosen input only/);
  const detail = await f.call("agentNetwork.jobDetail", { id: request.id, role: "buyer" }); assert.equal(detail.output, "Chosen input only"); assert.equal(typeof detail.resultHash, "string");
  await f.call("agentNetwork.job", { id: request.id, role: "buyer", action: "accept" });
  await until(f, s => s.jobs.filter(j => j.id === request.id).every(j => j.status === "accepted"));
  assert.equal(f.inference.length, 0); assert.ok(f.confirmations.some(c => c.title === "Run this free service"));
});
test("AI services use only broker local inference with explicit model and bounded output", async t => {
  const f = fixture(t); await f.call("agentNetwork.settings", { enabled: true, endpoints: [] });
  const { id } = await f.call("agentNetwork.save", { template: "summary", model: "fixture-local", name: "Text brief", instructions: "Summarize only the given text." });
  const request = await f.call("agentNetwork.quote", { id, input: "Synthetic service input" });
  await until(f, s => s.jobs.some(j => j.role === "buyer" && j.status === "quoted")); await f.call("agentNetwork.submit", { id: request.id });
  await until(f, s => s.jobs.some(j => j.role === "buyer" && j.status === "delivered"));
  assert.equal(f.inference.length, 1); assert.equal(f.inference[0].model, "fixture-local"); assert.equal(f.inference[0].maxTokens, 2048); assert.match(f.inference[0].prompt, /Synthetic service input/);
  assert.equal((await f.call("agentNetwork.jobDetail", { id: request.id })).output, "A real local result");
});
test("unsafe saved workflows and paid services are rejected; compatible copies do not expose Brain", async t => {
  const good = { ...template("echo"), id: "safe", name: "Safe flow" }, bad = { ...template("echo"), id: "unsafe", name: "Private Brain flow" };
  bad.graph.nodes[1].type = "memory";
  const f = fixture(t, { getCompanionStore: () => ({ requireStorage() {}, data: { workflows: [good, bad], notes: [{ text: "Private note not authorized" }], connections: [{ token: "private-token" }] } }) });
  await f.call("agentNetwork.settings", { enabled: true, endpoints: [] });
  assert.deepEqual(await f.call("agentNetwork.workflowChoices"), [{ id: "safe", name: "Safe flow" }]);
  await assert.rejects(f.call("agentNetwork.fromWorkflow", { workflowId: "unsafe" }));
  const saved = await f.call("agentNetwork.fromWorkflow", { workflowId: "safe" }); assert.ok(saved.id);
  assert.doesNotMatch(JSON.stringify(await f.call("agentNetwork.status")), /Private note|private-token/);
  const code = template("echo"); code.graph.nodes[1].type = "code"; code.graph.nodes[1].config = { source: "return input" };
  await assert.rejects(f.call("agentNetwork.save", { definition: code }), /code|output/i);
  await assert.rejects(f.call("agentNetwork.save", { template: "echo", amount_atoms: "1" }), /Paid rentals/);
  await assert.rejects(f.call("agentNetwork.save", { template: "summary", model: "desktop:private:key" }), /local model/);
});
test("denied native confirmation, cancelled operations and corrupt storage cannot mutate existing data", async t => {
  const f = fixture(t, { confirm: async () => false });
  await assert.rejects(f.call("agentNetwork.settings", { enabled: true, endpoints: [] }), /Cancelled/);
  assert.equal((await f.call("agentNetwork.status")).enabled, false);
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.call("agentNetwork.settings", { enabled: true }, controller.signal));
  f.service.dispose(); const file = path.join(f.dir, "agent-network.json"); fs.writeFileSync(file, "unreadable-original"); f.reopen();
  await assert.rejects(f.call("agentNetwork.status"), /keychain/); assert.equal(fs.readFileSync(file, "utf8"), "unreadable-original");
});
test("relay settings reject credentials, insecure URLs and excessive endpoints", async t => {
  const f = fixture(t);
  for (const endpoints of [["http://127.0.0.1"], ["https://user:token@example.org"], ["https://example.org/path"], Array(4).fill("https://example.org")]) await assert.rejects(f.call("agentNetwork.settings", { enabled: true, endpoints }));
  assert.equal(f.confirmations.length, 0);
});
test("external edits, malformed encrypted records, and file links are preserved", async t => {
  const f = fixture(t), file = path.join(f.dir, "agent-network.json");
  await f.call("agentNetwork.settings", { enabled: true, endpoints: [] });
  fs.writeFileSync(file, "external-edit");
  await assert.rejects(f.call("agentNetwork.save", { template: "echo" }), /changed outside/); assert.equal(fs.readFileSync(file, "utf8"), "external-edit");
  f.service.dispose();
  const malformed = JSON.stringify({ encrypted: Buffer.from(JSON.stringify({ version: 1, enabled: true, jobs: null })).toString("base64") });
  fs.writeFileSync(file, malformed); f.reopen(); await assert.rejects(f.call("agentNetwork.status"), /keychain/); assert.equal(fs.readFileSync(file, "utf8"), malformed);
  f.service.dispose(); fs.rmSync(file); const target = path.join(f.dir, "original.json"); fs.writeFileSync(target, "do-not-touch");
  try { fs.symlinkSync(target, file); } catch (error) { if (process.platform === "win32" && error.code === "EPERM") return; throw error; }
  assert.throws(() => create(f.ctx), /linked/); assert.equal(fs.readFileSync(target, "utf8"), "do-not-touch");
});
test("late model completion after disposal cannot write encrypted service state", async t => {
  let release, started; const ready = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { localInference: () => { started(); return new Promise(resolve => { release = resolve; }); } });
  await f.call("agentNetwork.settings", { enabled: true, endpoints: [] });
  const { id } = await f.call("agentNetwork.save", { template: "summary", model: "fixture-local" });
  const request = await f.call("agentNetwork.quote", { id, input: "Selected text" });
  await until(f, s => s.jobs.some(j => j.role === "buyer" && j.status === "quoted")); await f.call("agentNetwork.submit", { id: request.id }); await ready;
  f.service.dispose(); const file = path.join(f.dir, "agent-network.json"), before = fs.readFileSync(file, "utf8");
  release({ text: "Late result" }); await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(fs.readFileSync(file, "utf8"), before);
});
