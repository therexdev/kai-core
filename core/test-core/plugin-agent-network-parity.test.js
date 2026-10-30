"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { create, safeDefinition } = require("../../electron/plugin-services/agent-network"), M = require("../../ui/workflow-model"), { template } = require("../lib/agent-network/runtime");
function fixture(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-network-parity-")), safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
  const ctx = { dataDir, electron: { safeStorage }, core: { models: { aliases: () => [] }, gateway: { network: { status: () => ({ privacyMode: "local-only" }) } } }, confirm: async () => true,
    getCompanionStore: () => ({ requireStorage() {}, data: { workflows: [], notes: [{ text: "private brain" }], connections: [{ secret: "private token" }] } }), ...extra };
  let service = create(ctx); t.after(async () => { service.dispose(); await new Promise(resolve => setTimeout(resolve, 10)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { ctx, get service() { return service; }, reopen() { service.dispose(); service = create(ctx); }, call: (method, input = {}) => service.call("agentNetwork." + method, input) };
}
test("original renderer receives complete own definitions, receipts and activity with no private service key", async t => {
  const f = fixture(t); await f.call("settings", { enabled: true, endpoints: [] }); const card = await f.call("legacySave", { name: "Full original echo", template: "echo", capabilities: ["text", "echo"] });
  const state = await f.call("legacyStatus"); assert.equal(state.agents[0].card.payload.agent_id, card.payload.agent_id); assert.ok(state.agents[0].definition.graph); assert.equal(state.activity[0].type, "saved"); assert.deepEqual(state.agents[0].card.payload.capabilities, ["text", "echo"]);
  assert.doesNotMatch(JSON.stringify(state), /encryption_private|signing_private|private brain|private token/); assert.equal(f.service.keepAliveOnWindowClose, true);
  f.reopen(); const resumed = f.service.startBackground(); assert.equal(resumed.enabled, true); assert.equal((await f.call("status")).sessionActive, true);
  await f.call("settings", { enabled: false, endpoints: [] }); f.reopen(); f.service.startBackground();
  assert.equal((await f.call("status")).sessionActive, false, "Startup must preserve a disabled provider");
});
test("original structured service inputs and outputs run through the isolated rental engine", async t => {
  const f = fixture(t); await f.call("settings", { enabled: true, endpoints: [] });
  const schema = { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false };
  const card = await f.call("legacySave", { name: "Typed echo", template: "echo", input_schema: schema, output_schema: schema });
  const quote = await f.call("quote", { id: card.payload.agent_id, input: { count: 7 } });
  for (let i = 0; i < 100; i++) { const quoted = await f.call("legacyRefresh"); if (quoted.jobs.some(j => j.id === quote.id && j.status === "quoted")) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  await f.call("submit", { id: quote.id });
  let state; for (let i = 0; i < 100; i++) { state = await f.call("legacyRefresh"); if (state.jobs.some(j => j.role === "buyer" && j.status === "delivered")) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  const job = state.jobs.find(j => j.role === "buyer"); assert.equal(job.status, "delivered", job.error); assert.deepEqual(job.input, { count: 7 }); assert.deepEqual(job.output, { count: 7 }); assert.ok(job.quote.payload); assert.ok(job.steps);
});
test("the original bounded code node is allowed while rented private capabilities stay rejected", () => {
  const spec = template("echo"), code = M.node("code", "calculate", undefined, { source: "return [{answer: 42}];" }); spec.graph.nodes.splice(1, 0, code); spec.graph.edges = [M.edge("input", "calculate"), M.edge("calculate", "result")];
  assert.ok(safeDefinition(spec).graph.nodes.some(n => n.type === "code"));
  for (const type of ["memory", "tool_call", "http_request", "sub_workflow"]) { const copy = structuredClone(spec); copy.graph.nodes[1] = M.node(type, "calculate"); assert.throws(() => safeDefinition(copy), /personal accounts|Brain|Unsupported|Choose|HTTP|workflow/i); }
});
test("native save exports and cross-plugin workflow navigation remain explicit actions", async t => {
  const destinations = [], opened = [], f = fixture(t, { getWindow: () => ({}), electron: { safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() }, dialog: { showSaveDialog: async (_win, options) => { destinations.push(options.defaultPath); return { canceled: true }; } } }, openPlugin: async id => opened.push(id) });
  assert.deepEqual(await f.call("saveFile", { name: "kai-agent-abcdef01.json", text: "{}" }), { saved: false }); assert.deepEqual(destinations, ["kai-agent-abcdef01.json"]);
  await assert.rejects(f.call("saveFile", { name: "../../secret.json", text: "{}" }), /Invalid/); await f.call("openBuilder"); assert.deepEqual(opened, ["kai.workflows"]);
});
