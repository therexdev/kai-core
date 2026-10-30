"use strict";
// The installed feature uses the original workflow engine and management
// actions. Only this publisher-pinned plugin receives this workflow surface.
const { CompanionError, id, text, copy } = require("../companion-store");
const Model = require("../../ui/workflow-model");
const { normalize } = require("../workflow-engine");
const pluginId = "kai.workflows";
const ACTIONS = Object.freeze({
  status: "workflows.read", workflowValidate: "workflows.read", workflowEventTypes: "workflows.read", exportWorkflow: "workflows.read",
  workflow: "workflows.write", workflowDraft: "workflows.write", importWorkflow: "workflows.write", removeWorkflow: "workflows.write",
  workflowEnabled: "workflows.run", workflowAssist: "workflows.run", workflowDiscoverySettings: "workflows.run", workflowDiscover: "workflows.run", workflowDismiss: "workflows.write",
  workflowPreview: "workflows.run", workflowReject: "workflows.run", cancelRun: "workflows.run", resume: "workflows.run"
});
const permissions = Object.freeze({ "workflows.copyText": "workflows.read", ...Object.fromEntries(Object.entries(ACTIONS).map(([key, value]) => ["workflows." + key, value])),
  ...Object.fromEntries(["list", "get", "runs", "runGet", "export", "agents"].map(key => ["workflows." + key, "workflows.read"])),
  ...Object.fromEntries(["save", "remove", "agentSave", "agentRemove"].map(key => ["workflows." + key, "workflows.write"])),
  ...Object.fromEntries(["run", "cancel", "decide"].map(key => ["workflows." + key, "workflows.run"])) });
function safeSpec(input) { return normalize(Model.fromLegacy(input)); }
function workflowStatus(state) {
  if (state.locked || state.available === false) return { locked: !!state.locked, available: state.available };
  // Connections.list() already excludes credentials. Do not forward the
  // companion hub's unrelated memories, goals, conversations, or settings.
  return copy({ available: state.available, locked: false, workflows: state.workflows || [], runs: state.runs || [],
    models: state.models || [], connections: (state.connections || []).map(c => ({ id: c.id, name: c.name, enabled: c.enabled, provider: c.provider, toolkit: c.toolkit,
      status: c.status, allowAgent: c.allowAgent, allowSync: c.allowSync, operations: c.operations || [] })),
    sources: (state.sources || []).map(s => ({ id: s.id, name: s.name, kind: s.kind, lastSync: s.lastSync, error: s.error })),
    workflowState: state.workflowState || {}, stepTypes: state.stepTypes || [], syncing: state.syncing || [] });
}
function create(ctx) {
  let closed = false;
  const active = signal => { if (closed) throw Error("Workflows plugin is closed"); signal?.throwIfAborted(); };
  const hub = () => { active(); if (!ctx.getLegacyHub || !ctx.legacyManage) throw Error("The full Workflows runtime requires the matching Core version"); return ctx.getLegacyHub("workflows"); };
  const store = () => { const value = hub().store; value.requireStorage(); return value; };
  const manage = async (action, input, signal) => { active(signal); hub(); const value = await ctx.legacyManage("workflows", action, input, signal); active(signal); return value; };
  const agents = () => copy(store().data.workflowAgents || []);
  function definition(key) { const value = store().data.workflows.find(w => w.id === key); if (!value) throw new CompanionError("Workflow no longer exists."); return copy(value); }
  function runRecord(key) { const run = store().data.runs.find(r => r.id === key); if (!run) throw new CompanionError("Run no longer exists."); return run; }
  function build(input) {
    if (input.graph || !input.steps?.some(step => ["saved_agent", "agent", "sub_workflow", "output_parser"].includes(step.type))) return input.graph ? input : Model.fromLegacy(input);
    const nodes = [Model.node("trigger", "start")], edges = [];
    for (const [index, step] of input.steps.entries()) {
      let type = step.type, config;
      if (type === "saved_agent") { const agent = agents().find(a => a.id === step.agentId); if (!agent) throw new CompanionError("Select a saved agent."); type = "agent"; config = { model: agent.model, instructions: agent.instructions, profile: agent.name, prompt: step.text || "{{previous}}" }; }
      else if (type === "agent") config = { model: step.model || input.model, prompt: step.text || step.prompt || "{{input}}" };
      else if (type === "sub_workflow") config = { workflowId: step.workflowId };
      else config = { ...(step.config || {}), ...(step.text !== undefined ? { text: step.text } : {}) };
      const node = Model.node(type, "step" + (index + 1), { x: 80, y: (index + 1) * 150 }, config, step.label || Model.meta(type)?.name || type);
      edges.push(Model.edge(nodes.at(-1).id, node.id, nodes.at(-1).type === "approval" ? "approved" : "main")); nodes.push(node);
    }
    return { ...input, graph: { version: 2, nodes, edges } };
  }
  return { keepAliveOnWindowClose: true,
    startBackground() { return hub(); },
    async call(method, input = {}, signal) {
      active(signal); if (!Object.hasOwn(permissions, method)) throw Error("Unknown workflow operation");
      if (!input || typeof input !== "object" || Array.isArray(input) || JSON.stringify(input).length > 1000000) throw new CompanionError("Invalid workflow input.");
      const action = method.slice("workflows.".length);
      if (action === "copyText") { if (typeof input.text !== "string" || input.text.length > 200000) throw Error("Invalid text to copy"); ctx.electron.clipboard.writeText(input.text); return { copied: true }; }
      if (Object.hasOwn(ACTIONS, action)) { const result = await manage(action, input, signal); return action === "status" ? workflowStatus(result) : result; }
      switch (action) {
        case "list": return { workflows: store().data.workflows.map(w => ({ ...copy(w), runnable: !w.draft })), runtimeVersion: 2, manualOnly: false };
        case "get": return definition(input.id);
        case "export": return { schema: 1, runtimeVersion: 2, workflow: { ...definition(input.id), id: undefined, enabled: false } };
        case "agents": return agents();
        case "agentSave": {
          const value = { name: text(input.name, 100, "Agent name"), model: text(input.model, 200, "Local model"), instructions: text(input.instructions, 4000, "Instructions") };
          if (/^(desktop:|koinos-network)/.test(value.model) || !ctx.core.models.aliases().some(m => m.alias === value.model && m.status === "ready")) throw new CompanionError("Choose an installed local model.");
          return store().change(d => { d.workflowAgents ||= []; const old = d.workflowAgents.find(a => a.id === input.id); if (input.id && !old) throw new CompanionError("Agent no longer exists."); const saved = { ...value, id: old?.id || id(), updatedAt: Date.now() }; if (old) d.workflowAgents[d.workflowAgents.indexOf(old)] = saved; else d.workflowAgents.push(saved); return saved; });
        }
        case "agentRemove": return store().change(d => { d.workflowAgents = (d.workflowAgents || []).filter(a => a.id !== input.id); return { removed: true }; });
        case "save": return manage("workflow", build(input), signal);
        case "remove": await manage("removeWorkflow", input, signal); return { removed: true };
        case "run": return { id: await manage("run", input, signal) };
        case "runs": return copy(store().data.runs.filter(r => !input.workflowId || r.workflowId === input.workflowId));
        case "runGet": return copy(runRecord(input.id));
        case "cancel": await manage("cancelRun", input, signal); return { cancelled: true };
        case "decide": {
          if (!["approved", "rejected"].includes(input.decision)) throw new CompanionError("Choose approve or reject.");
          if (input.decision === "rejected") { await manage("workflowReject", input, signal); return { approved: false }; }
          const run = runRecord(input.id); if (!await ctx.confirm("Continue workflow?", JSON.stringify(run.pending || { name: run.name }, null, 2))) return { approved: false };
          active(signal); hub().workflows.decide(input.id, "approved"); return { approved: true };
        }
      }
    },
    dispose() { if (closed) return; closed = true; return (ctx.legacyRelease || ctx.releaseLegacyFeature)?.("workflows"); }
  };
}
module.exports = { pluginId, permissions, create, safeSpec, workflowStatus, ACTIONS };
