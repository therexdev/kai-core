"use strict";
const { CompanionWorkflows } = require("../companion-workflows");
const { CompanionError, copy, id, text } = require("../companion-store");
const Model = require("../../ui/workflow-model");
const pluginId = "kai.workflows";
const permissions = Object.freeze(Object.fromEntries([
  ...["list", "get", "runs", "runGet", "export", "agents"].map(k => ["workflows." + k, "workflows.read"]),
  ...["save", "remove", "agentSave", "agentRemove"].map(k => ["workflows." + k, "workflows.write"]),
  ...["run", "cancel", "decide"].map(k => ["workflows." + k, "workflows.run"]),
]));
const CONFIG = {
  trigger: ["kind", "schedule", "inputFields"],
  agent: ["prompt", "profile", "model", "instructions", "execution", "maxTurns", "tools"],
  sub_workflow: ["workflowId", "execution"], output: ["text", "saveChat"], approval: ["text"],
  output_parser: ["format", "field", "required"], condition: ["expression", "operator", "value"],
  transform: ["set", "keepFields"], switch: ["expression", "cases"], merge: ["mode", "key"], split_out: ["field", "keepFields"],
};
function safeSpec(input) {
  const w = Model.fromLegacy(input), g = w.graph;
  if (!g || g.version !== 2 || !Array.isArray(g.nodes) || g.nodes.length > 20 || !Array.isArray(g.edges) || g.edges.length > 40) throw new CompanionError("Use a version 2 graph with at most 20 nodes and 40 connections.");
  const report = Model.validateGraph(g); if (report.errors.length) throw new CompanionError(report.errors[0].message);
  for (const n of g.nodes) {
    if (!Object.hasOwn(CONFIG, n.type)) throw new CompanionError("This workflow uses " + n.type + ". This release supports local reasoning, data transforms, review and sub-workflows only.");
    const c = n.config;
    if (Object.keys(c).some(k => ![...CONFIG[n.type], "onError", "retries", "timeoutSeconds", "requireApproval"].includes(k))) throw new CompanionError("Unsupported settings in " + n.label + ".");
    if (n.type === "trigger" && c.kind !== "manual") throw new CompanionError("Only manual workflows run in this release. Existing schedules remain preserved.");
    if (n.type === "agent" && ((c.tools || []).length || !Array.isArray(c.tools || []) || /^(desktop:|koinos-network)/.test(c.model || w.model || ""))) throw new CompanionError("Agents use installed local models without connected tools.");
    if (n.type === "agent" && (String(c.prompt || "").length > 8000 || String(c.instructions || "").length > 4000)) throw new CompanionError("Agent prompts are limited to 8,000 characters and instructions to 4,000.");
    if (c.execution && c.execution !== "once") throw new CompanionError("Use one execution per step.");
    if (n.type === "output" && c.saveChat) throw new CompanionError("Results are saved in workflow history; conversation writes are unavailable.");
    c.retries = 0; c.timeoutSeconds = 120;
    if (n.type === "agent") { c.tools = []; c.maxTurns = 1; }
  }
  return { ...(w.id ? { id: w.id } : {}), name: text(w.name, 100, "Workflow name"), description: String(w.description || "").slice(0, 1000), model: String(w.model || "").slice(0, 200), graph: g, enabled: false };
}
function reason(w) { try { safeSpec(w); return ""; } catch (e) { return e.message; } }
function meta(w) { const unavailableReason = reason(w); return { id: w.id, name: w.name, description: w.description || "", revision: w.revision, updatedAt: w.updatedAt, draft: !!w.draft, runnable: !unavailableReason && !w.draft, unavailableReason }; }
function create(ctx) {
  let original, engine, closed = false;
  const lifetimes = new Map();
  const store = () => { if (closed) throw Error("Workflows plugin is closed"); original ||= ctx.getCompanionStore(); original.requireStorage(); return original; };
  // The runner receives workflow-only data. Hidden legacy runs and Brain/account state
  // are retained verbatim when a workflow commits; they are never sent to this plugin.
  function view(data) { return { version: 1, workflows: data.workflows.filter(w => !reason(w)), runs: data.runs.filter(r => r.pluginOwner === pluginId), connections: [], notes: [], goals: [], sources: [], settings: {} }; }
  function runner() {
    if (closed) throw Error("Workflows plugin is closed");
    if (engine) return engine;
    const source = store();
    const facade = { get data() { return view(source.data); }, get locked() { return source.locked; }, available: () => source.available(), requireStorage: () => source.requireStorage(), change(fn) {
      return source.change(root => {
        const d = view(root), oldWorkflows = new Set(d.workflows.map(w => w.id)), result = fn(d);
        root.workflows = root.workflows.filter(w => !oldWorkflows.has(w.id)).concat(d.workflows);
        root.runs = root.runs.filter(r => r.pluginOwner !== pluginId).concat(d.runs.map(r => ({ ...r, pluginOwner: pluginId })));
        return result;
      });
    } };
    engine = new CompanionWorkflows({ store: facade, models: () => ctx.core.models.aliases(),
      connections: { list: () => [], prepare: () => { throw new CompanionError("Connected actions are unavailable in this plugin."); } },
      privacyMode: () => "local-only", runLocal: async ({ model, prompt, signal }) => {
        const response = await ctx.localInference({ model, prompt, maxTokens: 1024 }, signal); return typeof response === "string" ? response : response.text;
      } });
    return engine;
  }
  function definition(key) { const w = store().data.workflows.find(w => w.id === key); if (!w) throw new CompanionError("Workflow no longer exists."); return safeSpec(w); }
  function checkTree(w, seen = [], budget = { count: 0 }) {
    if (seen.includes(w.id) || seen.length >= 4) throw new CompanionError("Sub-workflows cannot recurse or nest beyond four levels.");
    budget.count += w.graph.nodes.length; if (budget.count > 60) throw new CompanionError("A run may contain at most 60 total nodes, including sub-workflows.");
    for (const n of w.graph.nodes.filter(n => n.type === "sub_workflow")) checkTree(definition(n.config.workflowId), [...seen, w.id], budget);
  }
  function runRecord(key) { const r = store().data.runs.find(r => r.id === key && r.pluginOwner === pluginId); if (!r) throw new CompanionError("Run no longer exists or belongs to the earlier app."); return r; }
  function track(key, signal) {
    lifetimes.get(key)?.(); const abort = () => {
      cleanup();
      const r = original?.data.runs.find(r => r.id === key && r.pluginOwner === pluginId);
      if (!closed && r && ["running", "waiting", "interrupted"].includes(r.status)) {
        // A completed/deleted run may outlive its timer. A storage conflict must
        // still abort inference, but must never throw from a timer callback.
        engine?.active.get(key)?.abort();
        try { runner().cancel(key); } catch { /* The guarded store refuses stale writes. */ }
      }
    };
    const timer = setTimeout(abort, 10 * 60 * 1000); timer.unref?.();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); lifetimes.delete(key); };
    lifetimes.set(key, cleanup); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  }
  function agents() { return (store().data.workflowAgents || []).map(a => ({ id: a.id, name: a.name, model: a.model, instructions: a.instructions, updatedAt: a.updatedAt })); }
  function build(input) {
    if (input.graph) return safeSpec(input);
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 18) throw new CompanionError("Add 1–18 steps.");
    const nodes = [Model.node("trigger", "start")], edges = [];
    for (const [index, s] of input.steps.entries()) {
      let type = s.type, config;
      if (type === "saved_agent") { const a = agents().find(a => a.id === s.agentId); if (!a) throw new CompanionError("Select a saved agent."); type = "agent"; config = { model: a.model, instructions: a.instructions, profile: a.name, prompt: s.text || "{{previous}}" }; }
      else if (type === "agent") config = { model: s.model || input.model, prompt: text(s.text, 8000, "Agent prompt") };
      else if (type === "sub_workflow") { definition(s.workflowId); config = { workflowId: s.workflowId }; }
      else if (["output", "approval"].includes(type)) config = { text: String(s.text || "{{previous}}").slice(0, 8000) };
      else if (type === "output_parser") config = { format: s.format || "json", field: "=item.text", required: String(s.required || "").slice(0, 1000) };
      else throw new CompanionError("Unsupported builder step.");
      const n = Model.node(type, "step" + (index + 1), { x: 80, y: (index + 1) * 150 }, config, s.label || Model.meta(type).name);
      edges.push(Model.edge(nodes.at(-1).id, n.id, nodes.at(-1).type === "approval" ? "approved" : "main")); nodes.push(n);
    }
    return safeSpec({ ...input, graph: { version: 2, nodes, edges } });
  }
  return {
    async call(method, input = {}, signal) {
      if (!Object.hasOwn(permissions, method)) throw Error("Unknown workflow operation"); signal?.throwIfAborted();
      if (!input || typeof input !== "object" || Array.isArray(input) || JSON.stringify(input).length > 160000) throw new CompanionError("Invalid workflow input.");
      switch (method) {
        case "workflows.list": return { workflows: store().data.workflows.map(meta), runtimeVersion: 2, manualOnly: true };
        case "workflows.get": return copy(definition(input.id));
        case "workflows.export": return { schema: 1, runtimeVersion: 2, workflow: { ...definition(input.id), id: undefined } };
        case "workflows.agents": return agents();
        case "workflows.agentSave": {
          const a = { name: text(input.name, 100, "Agent name"), model: text(input.model, 200, "Local model"), instructions: text(input.instructions, 4000, "Instructions") };
          if (/^(desktop:|koinos-network)/.test(a.model) || !ctx.core.models.aliases().some(m => m.alias === a.model && m.status === "ready")) throw new CompanionError("Choose an installed local model.");
          return store().change(d => { d.workflowAgents ||= []; const old = d.workflowAgents.find(x => x.id === input.id); if (input.id && !old) throw new CompanionError("Agent no longer exists."); if (!old && d.workflowAgents.length >= 100) throw new CompanionError("Maximum 100 saved agents."); const saved = { ...a, id: old?.id || id(), updatedAt: Date.now() }; if (old) d.workflowAgents[d.workflowAgents.indexOf(old)] = saved; else d.workflowAgents.push(saved); return saved; });
        }
        case "workflows.agentRemove": store().change(d => { d.workflowAgents = (d.workflowAgents || []).filter(a => a.id !== input.id); }); return { removed: true };
        case "workflows.save": { const spec = build(input); if (spec.id) definition(spec.id); checkTree(spec); return runner().save(spec); }
        case "workflows.remove": definition(input.id); runner().remove(input.id); return { removed: true };
        case "workflows.run": { const spec = definition(input.id); checkTree(spec); const key = runner().begin(input.id, input.input ?? ""); track(key, signal); return { id: key }; }
        case "workflows.runs": return store().data.runs.filter(r => r.pluginOwner === pluginId && (!input.workflowId || r.workflowId === input.workflowId)).slice(0, 75).map(r => ({ id: r.id, workflowId: r.workflowId, name: r.name, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, error: r.error }));
        case "workflows.runGet": { const r = runRecord(input.id); if (!["running", "waiting", "interrupted"].includes(r.status)) lifetimes.get(input.id)?.(); return copy({ id: r.id, name: r.name, status: r.status, input: r.input, output: r.output, previous: r.previous, steps: r.steps, pending: r.pending, error: r.error, startedAt: r.startedAt, finishedAt: r.finishedAt }); }
        case "workflows.cancel": runRecord(input.id); runner().cancel(input.id); lifetimes.get(input.id)?.(); return { cancelled: true };
        case "workflows.decide": {
          const r = runRecord(input.id); if (r.status !== "waiting") throw new CompanionError("This run is not waiting for review.");
          if (!["approved", "rejected"].includes(input.decision)) throw new CompanionError("Choose approve or reject.");
          if (input.decision === "approved" && !await ctx.confirm("Continue workflow?", JSON.stringify(r.pending, null, 2).slice(0, 19000))) return { approved: false };
          signal?.throwIfAborted(); runner().decide(input.id, input.decision); track(input.id, signal); return { approved: input.decision === "approved" };
        }
      }
    },
    dispose() { if (closed) return; for (const cleanup of [...lifetimes.values()]) cleanup(); if (engine) { for (const key of engine.active.keys()) engine.cancel(key); engine.stop(); } closed = true; },
  };
}
module.exports = { pluginId, permissions, create, safeSpec };
