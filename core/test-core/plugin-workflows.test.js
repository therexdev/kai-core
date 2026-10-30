"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { CompanionStore } = require("../../electron/companion-store"), { CompanionWorkflows } = require("../../electron/companion-workflows"), M = require("../../ui/workflow-model");
const { create, safeSpec, permissions, workflowStatus } = require("../../electron/plugin-services/workflows");
function setup(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-workflows-parity-")), prompts = [], requests = [], savedChats = [];
  const store = new CompanionStore({ dataDir, safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() } });
  const models = () => [{ alias: "local", status: "ready" }];
  const connections = { list: () => store.data.connections.map(({ secret, ...c }) => c), prepare: (connectionId, operationId) => ({ name: "Selected request", method: operationId === "write" ? "POST" : "GET", connectionId, operationId, url: "https://example.org/api" }), execute: async request => { requests.push(request); return "selected connection result"; } };
  const workflows = new CompanionWorkflows({ store, models, connections, privacyMode: () => "local-first", chats: { save: value => { savedChats.push(value); return { id: "saved-chat" }; } }, runLocal: async ({ model, prompt, signal }) => { prompts.push(prompt); return overrides.inference ? overrides.inference({ model, prompt }, signal) : "answer " + prompts.length; } });
  const hub = { store, workflows }; let released = 0;
  const ctx = { dataDir, core: { models: { aliases: models } }, getLegacyHub: feature => { assert.equal(feature, "workflows"); return hub; }, releaseLegacyFeature: () => { released++; workflows.stop(); }, confirm: overrides.confirm || (async () => true),
    legacyManage: async (_feature, action, input, signal) => {
      signal?.throwIfAborted();
      switch (action) {
        case "status": return { ...structuredClone(store.data), available: true, locked: false, models: models(), connections: connections.list() };
        case "workflow": return workflows.save(input);
        case "workflowDraft": return workflows.save(input, { draft: true });
        case "workflowValidate": return workflows.validate(input);
        case "workflowEnabled": return workflows.setEnabled(input.id, input.enabled);
        case "run": return workflows.begin(input.id, input.input);
        case "workflowPreview": return workflows.begin(input.id, input.input, "preview", { dryRun: true });
        case "workflowReject": return workflows.decide(input.id, "rejected");
        case "cancelRun": return workflows.cancel(input.id);
        case "removeWorkflow": return workflows.remove(input.id);
        default: throw Error("Fixture action unavailable: " + action);
      }
    }
  };
  const service = create(ctx); t.after(async () => { await service.dispose(); workflows.stop(); await new Promise(resolve => setTimeout(resolve, 20)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store, workflows, service, prompts, requests, savedChats, get released() { return released; }, call: (method, input, signal) => service.call("workflows." + method, input, signal) };
}
async function settled(call, key) { for (let i = 0; i < 300; i++) { const r = await call("runGet", { id: key }); if (r.status !== "running") return r; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error("Workflow did not settle"); }
function flow(name, middle, end = {}) { const nodes = [M.node("trigger", "start"), ...middle, M.node("output", "end", undefined, end)]; return { name, model: "local", graph: { version: 2, nodes, edges: nodes.slice(1).map((n, i) => M.edge(nodes[i].id, n.id, nodes[i].type === "approval" ? "approved" : "main")) } }; }
test("original graphs execute Brain reads, selected app actions, code and saved chat output", async t => {
  const f = setup(t); f.store.note({ title: "Stars", text: "Stars are bright", category: "notes" }); f.store.change(d => d.connections.push({ id: "api", name: "Selected API", enabled: true, allowSync: true, secret: "never-return-token", operations: [{ id: "read", name: "Read", method: "GET" }] }));
  const spec = flow("Original capabilities", [M.node("memory", "memory", undefined, { operation: "search", query: "Stars" }), M.node("tool_call", "api", undefined, { connectionId: "api", operationId: "read" }), M.node("code", "code", undefined, { source: 'return [{ text: "Full graph output" }];' })], { text: "=item.text", saveChat: true });
  const saved = await f.call("workflow", spec), run = await f.call("run", { id: saved.id }); const result = await settled(f.call, run.id);
  assert.equal(result.status, "completed", result.error); assert.equal(result.previous, "Full graph output"); assert.equal(f.requests.length, 1); assert.equal(f.savedChats.length, 1);
  assert.equal(f.store.data.connections[0].secret, "never-return-token"); assert.doesNotMatch(JSON.stringify(await f.call("status")), /never-return-token/);
});
test("original schedule, retries and full graph capacity survive saving", async t => {
  const f = setup(t), spec = flow("Scheduled flow", Array.from({ length: 22 }, (_, i) => M.node("transform", "node" + i, { x: 80, y: i * 100 }, { set: { text: "value" }, retries: 2 })));
  assert.equal(f.service.startBackground().workflows, f.workflows, "Background startup activates the original workflow runtime without a window");
  spec.graph.nodes[0].config = { kind: "schedule", schedule: { kind: "interval", minutes: 15 } }; spec.enabled = true;
  const saved = await f.call("workflow", spec); assert.equal(saved.enabled, true); assert.equal(saved.graph.nodes.length, 24); assert.ok(saved.nextRunAt); assert.equal(saved.graph.nodes[1].config.retries, 2);
  await f.call("workflowEnabled", { id: saved.id, enabled: false }); assert.equal(f.store.data.workflows[0].enabled, false); assert.equal(safeSpec(spec).graph.nodes.length, 24);
});
test("historical workflow receipts remain usable without forwarding unrelated private state", async t => {
  const f = setup(t); f.store.change(d => { d.runs.push({ id: "historical", workflowId: "legacy", status: "completed", previous: "Saved result" }); d.notes.push({ id: "secret", title: "Private", text: "unrelated private note" }); d.connections.push({ id: "account", name: "Account", enabled: true, secret: "private-token", operations: [] }); });
  assert.equal((await f.call("runGet", { id: "historical" })).previous, "Saved result");
  const state = await f.call("status"); assert.equal(state.connections[0].name, "Account"); assert.doesNotMatch(JSON.stringify(state), /unrelated private note|private-token/); assert.equal(state.runs[0].id, "historical");
});
test("native review and explicit cancellation preserve original execution gates", async t => {
  let approved = false; const f = setup(t, { confirm: async () => approved });
  const saved = await f.call("workflow", flow("Review", [M.node("approval", "review", undefined, { text: "Continue?" })], { text: "approved" })), run = await f.call("run", { id: saved.id });
  assert.equal((await settled(f.call, run.id)).status, "waiting"); assert.deepEqual(await f.call("decide", { id: run.id, decision: "approved" }), { approved: false });
  approved = true; await f.call("decide", { id: run.id, decision: "approved" }); assert.equal((await settled(f.call, run.id)).status, "completed");
  let aborted = false; const running = setup(t, { inference: (_input, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true })) });
  const task = await running.call("workflow", flow("Cancel", [M.node("agent", "ask", undefined, { prompt: "Wait", model: "local" })])), started = await running.call("run", { id: task.id }); await new Promise(resolve => setTimeout(resolve, 15));
  await running.call("cancel", { id: started.id }); assert.equal(aborted, true); assert.equal((await running.call("runGet", { id: started.id })).status, "cancelled"); await running.service.dispose(); await assert.rejects(running.call("status"), /closed/); assert.equal(running.released, 1);
});
test("scoped dispatch rejects unrelated operations and a late review cannot resume after disposal", async t => {
  let resolveReview; const f = setup(t, { confirm: () => new Promise(resolve => { resolveReview = resolve; }) });
  assert.equal(permissions["workflows.workflow"], "workflows.write"); assert.equal(permissions["workflows.workflowEnabled"], "workflows.run"); assert.equal(f.service.keepAliveOnWindowClose, true);
  await assert.rejects(f.service.call("brainSearch", {}), /Unknown/); await assert.rejects(f.call("status", []), /Invalid/);
  const saved = await f.call("workflow", flow("Delayed review", [M.node("approval", "approve")], { text: "done" })), run = await f.call("run", { id: saved.id }); await settled(f.call, run.id);
  const review = f.call("decide", { id: run.id, decision: "approved" }); await f.service.dispose(); const before = JSON.stringify(f.store.data); resolveReview(true);
  await assert.rejects(review, /closed/); assert.equal(JSON.stringify(f.store.data), before); assert.deepEqual(workflowStatus({ locked: true, available: true, notes: ["secret"] }), { locked: true, available: true });
});
