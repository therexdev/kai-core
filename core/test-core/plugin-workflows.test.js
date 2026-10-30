"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { CompanionStore } = require("../../electron/companion-store"), M = require("../../ui/workflow-model");
const { create, safeSpec, permissions } = require("../../electron/plugin-services/workflows");
function setup(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-workflows-plugin-"));
  const store = new CompanionStore({ dataDir, safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() } });
  const prompts = [], service = create({ dataDir, core: { models: { aliases: () => [{ alias: "local", status: "ready" }] } }, getCompanionStore: () => store, confirm: async () => true, localInference: async i => { prompts.push(i.prompt); return { text: "answer " + prompts.length }; }, ...overrides });
  t.after(() => { service.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store, service, prompts, call: (method, input, signal) => service.call("workflows." + method, input, signal) };
}
async function settled(call, key, predicate = r => r.status !== "running") { for (let i = 0; i < 300; i++) { const r = await call("runGet", { id: key }); if (predicate(r)) return r; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error("Workflow did not settle"); }
const ask = (name = "Flow") => ({ name, model: "local", steps: [{ type: "agent", text: "Write about {{input}}" }, { type: "output", text: "{{previous}}" }] });
test("saved agents and sub-workflows execute through shared runtime and preserve private legacy data", async t => {
  const { call, store, prompts } = setup(t);
  store.change(d => { d.notes.push({ id: "private", title: "Private", text: "brain-secret" }); d.connections.push({ id: "account", token: "account-secret" }); d.runs.push({ id: "old-run", status: "running", previous: "private old output" }); });
  const untouched = JSON.stringify({ notes: store.data.notes, connections: store.data.connections, run: store.data.runs[0] });
  const a = await call("agentSave", { name: "Editor", model: "local", instructions: "Use clear language" });
  const child = await call("save", { name: "Edit", steps: [{ type: "saved_agent", agentId: a.id, text: "{{previous}}" }] });
  const parent = await call("save", { name: "Write and edit", model: "local", steps: [{ type: "agent", text: "Draft about {{input}}" }, { type: "sub_workflow", workflowId: child.id }, { type: "output", text: "{{previous}}" }] });
  const { id } = await call("run", { id: parent.id, input: "stars" }); const result = await settled(call, id);
  assert.equal(result.status, "completed", result.error); assert.equal(prompts.length, 2); assert.match(prompts[0], /stars/); assert.match(prompts[1], /Use clear language/); assert.match(prompts[1], /answer 1/); assert.match(result.previous, /answer 2/);
  assert.equal(untouched, JSON.stringify({ notes: store.data.notes, connections: store.data.connections, run: store.data.runs.find(r => r.id === "old-run") }));
  assert.equal((await call("runs")).length, 1); await assert.rejects(call("runGet", { id: "old-run" }), /earlier app/); assert.doesNotMatch(JSON.stringify(await call("list")), /secret|private old output/);
});
test("unsafe legacy flows remain intact and nested capabilities cannot bypass the broker", async t => {
  const { call, store } = setup(t), graph = M.template("ask", "local").graph;
  graph.nodes[1] = M.node("memory", "n1", undefined, { operation: "search", query: "hidden" });
  store.change(d => d.workflows.push({ id: "old", name: "Private recall", graph }));
  const before = JSON.stringify(store.data.workflows);
  assert.equal((await call("list")).workflows[0].runnable, false);
  await assert.rejects(call("get", { id: "old" }), /memory/); await assert.rejects(call("run", { id: "old" }), /memory/);
  await assert.rejects(call("save", { name: "Sneak", steps: [{ type: "sub_workflow", workflowId: "old" }] }), /memory/);
  const injected = M.template("ask", "local"); injected.graph.nodes[1].config.tools = [{ connectionId: "account", operationId: "read" }];
  await assert.rejects(call("save", injected), /without connected tools/);
  injected.graph.nodes[1].config.tools = []; injected.graph.nodes[1].config.connectionId = "secret";
  await assert.rejects(call("save", injected), /Unsupported settings/); assert.equal(JSON.stringify(store.data.workflows), before);
  assert.throws(() => safeSpec({ name: "script", graph: { version: 2, nodes: [M.node("trigger", "start"), M.node("code", "script")], edges: [M.edge("start", "script")] } }), /local reasoning/);
});
test("human review is native, run results persist, and explicit cancellation aborts model work", async t => {
  let approved = false; const { call } = setup(t, { confirm: async () => approved });
  const flow = await call("save", { name: "Review", steps: [{ type: "approval", text: "Review {{input}}" }, { type: "output", text: "accepted" }] });
  const { id } = await call("run", { id: flow.id, input: "draft" }); assert.equal((await settled(call, id)).status, "waiting");
  assert.deepEqual(await call("decide", { id, decision: "approved" }), { approved: false }); assert.equal((await call("runGet", { id })).status, "waiting");
  approved = true; await call("decide", { id, decision: "approved" }); assert.equal((await settled(call, id)).status, "completed");
  let aborted = false; const running = setup(t, { localInference: (_i, signal) => new Promise((_res, reject) => { signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true }); }) });
  const local = await running.call("save", ask()); const task = await running.call("run", { id: local.id, input: "go" });
  await new Promise(resolve => setTimeout(resolve, 15)); await running.call("cancel", task); assert.equal((await running.call("runGet", task)).status, "cancelled"); assert.equal(aborted, true);
});
test("permissions are declared per operation and closed plugins cannot access state", async t => {
  const { service, call } = setup(t); assert.equal(permissions["workflows.run"], "workflows.run"); assert.equal(permissions["workflows.list"], "workflows.read");
  await assert.rejects(service.call("brain.read", {}), /Unknown/); await assert.rejects(call("save", { name: "Too large", steps: Array(19).fill({ type: "output" }) }), /1–18/);
  await assert.rejects(call("agentSave", { name: "Remote", instructions: "Help", model: "desktop:openai" }), /local/);
  service.dispose(); await assert.rejects(call("list"), /closed/);
});
test("closing during a native review cannot resume a disposed runtime", async t => {
  let resolveReview; const { call, service, store } = setup(t, { confirm: () => new Promise(resolve => { resolveReview = resolve; }) });
  const flow = await call("save", { name: "Review before result", steps: [{ type: "approval", text: "Continue?" }, { type: "output", text: "done" }] });
  const run = await call("run", { id: flow.id, input: "draft" }); await settled(call, run.id);
  const decision = call("decide", { id: run.id, decision: "approved" }); service.dispose(); const before = JSON.stringify(store.data); resolveReview(true);
  await assert.rejects(decision, /closed/); assert.equal(JSON.stringify(store.data), before);
});
test("a late deadline after completed history is removed cannot throw", async t => {
  const { call } = setup(t), nativeTimeout = global.setTimeout; let deadline;
  const flow = await call("save", { name: "Pure result", steps: [{ type: "output", text: "done" }] });
  global.setTimeout = (fn, ms, ...args) => ms === 10 * 60 * 1000 ? (deadline = fn, { unref() {} }) : nativeTimeout(fn, ms, ...args);
  let run; try { run = await call("run", { id: flow.id }); } finally { global.setTimeout = nativeTimeout; }
  await settled(call, run.id); await call("remove", { id: flow.id }); assert.equal(typeof deadline, "function"); assert.doesNotThrow(deadline);
});
