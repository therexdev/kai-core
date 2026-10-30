"use strict";
// Reviewed main-process broker. The plugin receives service records, never signing keys.
const path = require("node:path"), fs = require("node:fs"), crypto = require("node:crypto");
const { AgentNetwork } = require("../../core/lib/agent-network/network");
const { Store } = require("../../core/lib/agent-network/store");
const { Transport } = require("../../core/lib/agent-network/transport");
const { packageDefinition, template } = require("../../core/lib/agent-network/runtime");
const P = require("../../core/lib/agent-network/protocol");
const pluginId = "kai.agent-network";
const permissions = Object.freeze({
  "agentNetwork.status": "agent-network.read", "agentNetwork.export": "agent-network.read",
  "agentNetwork.jobDetail": "agent-network.read", "agentNetwork.workflowChoices": "agent-network.write",
  "agentNetwork.save": "agent-network.write", "agentNetwork.fromWorkflow": "agent-network.write", "agentNetwork.import": "agent-network.write",
  "agentNetwork.settings": "agent-network.manage", "agentNetwork.accepting": "agent-network.manage", "agentNetwork.job": "agent-network.manage",
  "agentNetwork.discover": "agent-network.network", "agentNetwork.publish": "agent-network.network", "agentNetwork.retire": "agent-network.network",
  "agentNetwork.quote": "agent-network.network", "agentNetwork.submit": "agent-network.network", "agentNetwork.refresh": "agent-network.network"
});
const SAFE_NODES = new Set(["trigger", "agent", "condition", "switch", "merge", "split_out", "transform", "output_parser", "dedup", "loop", "output", "approval"]);
function safeDefinition(value) {
  const definition = packageDefinition(value);
  for (const node of definition.graph.nodes) if (!SAFE_NODES.has(node.type)) throw Error("Service packages cannot execute code or native actions. Use local reasoning and data steps only.");
  return definition;
}
function create(ctx) {
  let active = false, disposed = false, busy = false, operationSignal = null;
  const lifecycle = new AbortController();
  const file = path.join(ctx.dataDir, "agent-network.json");
  const fingerprint = () => {
    try { const directory = fs.lstatSync(ctx.dataDir); if (directory.isSymbolicLink() || !directory.isDirectory()) throw Error("Agent Network requires the original profile directory, not a link."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 48 * 1024 * 1024) throw Error("Agent Network data is linked, invalid, or exceeds the storage limit. The original file was preserved.");
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  };
  let expectedFingerprint = fingerprint();
  const store = new Store(file, ctx.electron.safeStorage);
  if (fingerprint() !== expectedFingerprint) throw Error("Agent Network data changed while opening. Close other applications and reopen the plugin.");
  if (!store.locked) {
    const d = store.data, arrays = ["agents", "cards", "jobs", "quotes", "inbox", "outbox", "activity", "endpoints"];
    if (!d || d.version !== 1 || typeof d.enabled !== "boolean" || !arrays.every(key => Array.isArray(d[key])) ||
        !arrays.filter(key => key !== "endpoints").every(key => d[key].every(value => value && typeof value === "object" && !Array.isArray(value))) ||
        !d.endpoints.every(value => typeof value === "string") || d.endpoints.length > 3) store.locked = true;
  }
  const change = store.change.bind(store);
  store.change = fn => {
    lifecycle.signal.throwIfAborted(); operationSignal?.throwIfAborted();
    if (fingerprint() !== expectedFingerprint) throw Error("Agent Network data changed outside this session. Close other applications and reopen the plugin; no data was overwritten.");
    const result = change(fn); expectedFingerprint = fingerprint(); return result;
  };
  const transport = new Transport({ privacyMode: () => ctx.core.gateway.network.status().privacyMode });
  const baseRequest = transport.request.bind(transport);
  transport.request = (...args) => { lifecycle.signal.throwIfAborted(); operationSignal?.throwIfAborted(); return baseRequest(...args); };
  const network = new AgentNetwork({ store, transport,
    models: () => ctx.core.models.aliases().filter(m => m.status === "ready" && !/^(desktop:|koinos-network)/.test(m.alias)).map(({ alias, label, status }) => ({ alias, label, status })),
    runLocal: async input => {
      const result = await ctx.localInference({ model: input.model, prompt: input.prompt, maxTokens: 2048 }, AbortSignal.any([input.signal, lifecycle.signal]));
      return result.text;
    }
  });
  // The legacy engine reports failures asynchronously. Keep a failed persistence
  // attempt from becoming an unhandled rejection after shutdown or a file conflict.
  const engines = new WeakSet(), getEngine = network.runtime.engine.bind(network.runtime);
  network.runtime.engine = id => {
    const engine = getEngine(id); if (engines.has(engine)) return engine; engines.add(engine);
    engine.launch = (key, approved = false) => {
      if (engine.active.has(key) || engine.active.size >= 2) throw Error("Service execution slots are busy.");
      const controller = new AbortController(); engine.active.set(key, controller);
      engine.drive(key, controller.signal, approved).catch(error => {
        if (disposed || engine.get(key)?.status === "cancelled") return;
        try { engine.patch(key, run => { run.status = "failed"; run.error = error.name === "AbortError" ? "Run stopped." : String(error.message || "Service step failed.").slice(0, 500); run.finishedAt = Date.now(); }); }
        catch { /* Preserve conflicting or closed state for review on next open. */ }
      }).finally(() => engine.active.delete(key));
    };
    return engine;
  };
  // Validate persisted packages as well as newly authored ones before any job starts.
  const start = network.runtime.start.bind(network.runtime);
  network.runtime.start = id => { safeDefinition(network.runtime.get(id)?.workflow?.workflows?.[0]); return start(id); };
  const requireActive = () => { if (!active || !store.data.enabled) throw Error("Start an Agent Network session first. Saved services remain on this device."); };
  const findAgent = id => { const a = store.data.agents.find(a => a.id === id); if (!a) throw Error("Choose a saved service."); return a; };
  const cardFor = id => store.data.cards.find(c => c.payload.agent_id === id) || findAgent(id).card;
  const approved = async (title, detail) => { if (!await ctx.confirm(title, detail)) throw Error("Cancelled. No change was made."); lifecycle.signal.throwIfAborted(); operationSignal?.throwIfAborted(); };
  const summary = () => {
    const state = network.status();
    return { enabled: state.enabled, sessionActive: active, address: state.address, endpoints: state.endpoints,
      paid: false, deployment: state.deployment, privacyMode: ctx.core.gateway.network.status().privacyMode,
      directoryAvailable: state.endpoints.length > 0, models: state.models,
      agents: store.data.agents.map(a => { let safe = true; try { safeDefinition(a.definition); } catch { safe = false; }
        return { id: a.id, name: a.card.payload.name, description: a.card.payload.description, model: a.definition.model,
          accepting: a.accepting, published: a.published, safe, createdAt: a.createdAt, sequence: a.card.payload.sequence }; }),
      cards: state.cards.filter(c => c.payload.amount_atoms === "0").map(c => ({ id: c.payload.agent_id, name: c.payload.name, description: c.payload.description, owner: c.payload.owner, endpoints: c.payload.endpoints, expiresAt: Number(c.payload.expires_at), amountAtoms: c.payload.amount_atoms })),
      jobs: state.jobs.map(({ input, quote, pending, output, ...job }) => ({ ...job, hasOutput: output !== null && output !== undefined })),
      pendingMessages: state.pendingMessages, lastError: state.lastError,
      notice: state.endpoints.length ? "Private free services. Relay availability is checked when connecting; no paid marketplace is configured." : "No relay configured. Create services, export signed invitations, and test them locally. Public discovery and external jobs need a relay."
    };
  };
  const save = async input => {
    requireActive();
    if (input.amount_atoms && input.amount_atoms !== "0") throw Error("Paid rentals are unavailable. This release supports free private services only.");
    const old = input.id ? findAgent(input.id) : null;
    const source = structuredClone(input.definition || (old && !input.template ? old.definition : template(input.template || "summary", input.model || "")));
    if (input.instructions !== undefined) {
      if (typeof input.instructions !== "string" || !input.instructions.trim() || input.instructions.length > 8000) throw Error("Instructions must be 1–8,000 characters.");
      const agent = source.graph.nodes.find(n => n.type === "agent"); if (agent) agent.config.prompt = input.instructions.trim() + "\n{{input}}";
    }
    const definition = safeDefinition(source);
    return network.save({ id: input.id, name: input.name || old?.card.payload.name || definition.name, description: input.description || old?.card.payload.description || definition.description,
      definition, amount_atoms: "0", limits: { input_bytes: 12000, output_bytes: 64000, steps: 40, model_calls: 12, seconds: 180 },
      input_schema: { type: "string", maxLength: 12000 }, output_schema: { type: "string", maxLength: 64000 } });
  };
  async function execute(method, input) {
    switch (method) {
      case "agentNetwork.status": return summary();
      case "agentNetwork.settings": {
        if (typeof input.enabled !== "boolean") throw Error("Choose whether to start the service session.");
        const endpoints = input.endpoints ?? store.data.endpoints;
        if (!Array.isArray(endpoints) || endpoints.length > 3 || endpoints.some(e => typeof e !== "string" || e.length > 500)) throw Error("Choose at most three HTTPS relay origins.");
        for (const endpoint of endpoints) { const u = new URL(endpoint); if (u.protocol !== "https:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash) throw Error("Use HTTPS relay origins without paths or credentials."); }
        if (input.enabled) {
          for (const a of store.data.agents.filter(a => a.accepting)) safeDefinition(a.definition);
          await approved("Start private agent services", { relays: endpoints, scope: "Use a separate encrypted service identity. Accepting services may use local models while this plugin is open. No wallet, Brain, connected accounts, payments, or contracts are available." });
        }
        network.settings({ enabled: input.enabled, endpoints }); active = input.enabled; return summary();
      }
      case "agentNetwork.save": { const card = await save(input); return { id: card.payload.agent_id }; }
      case "agentNetwork.workflowChoices": {
        const companion = ctx.getCompanionStore(); companion.requireStorage();
        return companion.data.workflows.filter(w => !w.draft).flatMap(w => { try { safeDefinition(w); return [{ id: w.id, name: w.name }]; } catch { return []; } });
      }
      case "agentNetwork.fromWorkflow": {
        const companion = ctx.getCompanionStore(); companion.requireStorage();
        const workflow = companion.data.workflows.find(w => w.id === input.workflowId && !w.draft);
        if (!workflow) throw Error("Choose a saved workflow.");
        const definition = safeDefinition(workflow);
        await approved("Create a service from this workflow", { name: definition.name, steps: definition.graph.nodes.map(n => n.label), scope: "Copies the reviewed local graph into a separate service package. No Brain, account access, schedules, code, or sub-workflows are included. The package stays local until you explicitly publish it." });
        const card = await save({ name: input.name || definition.name, description: input.description || definition.description, definition }); return { id: card.payload.agent_id };
      }
      case "agentNetwork.export": {
        const agent = findAgent(input.id); safeDefinition(agent.definition);
        return { name: agent.card.payload.name, text: JSON.stringify(input.kind === "definition" ? { format: "kai-agent-service", version: 1, definition: agent.definition } : agent.card, null, 2) };
      }
      case "agentNetwork.import": {
        requireActive(); if (typeof input.text !== "string" || input.text.length > 200000) throw Error("Paste a signed service invitation under 200 KB.");
        const signed = P.parse(input.text, 200000);
        if (P.validateCard(signed).amount_atoms !== "0") throw Error("Paid services are unavailable in this release.");
        const card = network.importCard(signed); return { id: card.payload.agent_id };
      }
      case "agentNetwork.accepting": {
        const agent = findAgent(input.id);
        if (input.enabled === true) { requireActive(); safeDefinition(agent.definition); await approved("Accept jobs on this device", { name: agent.card.payload.name, limits: agent.card.payload.limits, scope: "Other people can send input to this service through your configured relays. Only this service's local model and isolated graph can run while the plugin is open." }); }
        network.accepting(input.id, input.enabled === true); return summary();
      }
      case "agentNetwork.publish": {
        requireActive(); const agent = findAgent(input.id); safeDefinition(agent.definition);
        if (!store.data.endpoints.length) throw Error("Configure a relay before publishing. You can export a signed invitation for private sharing now.");
        await approved("Publish this service card", { card: agent.card.payload, scope: "Makes the service description, public service address, schemas, limits, and relay endpoints discoverable. Workflow instructions remain on your device. No listing fee or payment is made." });
        return network.publish(input.id);
      }
      case "agentNetwork.retire": requireActive(); await network.retire(input.id); return summary();
      case "agentNetwork.discover": {
        requireActive(); if (!store.data.endpoints.length) throw Error("Discovery is unavailable until you configure a compatible HTTPS relay.");
        if (typeof (input.query ?? "") !== "string") throw Error("Search text is invalid.");
        await network.discover((input.query || "").slice(0, 100)); return summary();
      }
      case "agentNetwork.quote": {
        requireActive(); if (typeof input.input !== "string" || Buffer.byteLength(input.input) > 12000) throw Error("Service input must be text under 12 KB.");
        const card = cardFor(input.id); P.validateCard(card);
        if (card.payload.amount_atoms !== "0") throw Error("Paid services are unavailable in this release.");
        if (card.payload.owner !== network.identity().address) await approved("Request a private service quote", { service: card.payload.name, operator: card.payload.owner, relays: card.payload.endpoints, scope: "Sends the input commitment and your public service address. The actual input is held locally until you approve submission. This service is free." });
        return { id: await network.quote(card, input.input) };
      }
      case "agentNetwork.submit": {
        requireActive(); const job = store.data.jobs.find(j => j.id === input.id && j.role === "buyer");
        if (!job) throw Error("Choose a quoted job.");
        await approved("Run this free service", { name: job.name, input: job.input, quote: job.quote?.payload, scope: job.card.owner === network.identity().address ? "Runs on this device using the isolated service graph and local model. No payment is made." : "The selected operator can read this input. Only this input is sent; your Brain, wallet, and account tokens are not shared. No payment is made." });
        await network.submit(input.id); return summary();
      }
      case "agentNetwork.jobDetail": {
        const job = network.status().jobs.find(j => j.id === input.id && j.role === (input.role || "buyer"));
        if (!job) throw Error("Choose a service job.");
        return { id: job.id, name: job.name, role: job.role, status: job.status, output: job.output, error: job.error, steps: job.steps, resultHash: job.resultHash };
      }
      case "agentNetwork.job": {
        requireActive(); if (!["cancel", "accept", "reject", "remove", "approve", "resume"].includes(input.action) || !["buyer", "host"].includes(input.role || "buyer")) throw Error("Unsupported job action.");
        if (["remove", "approve", "resume"].includes(input.action)) await approved("Review service job action", { id: input.id, role: input.role || "buyer", action: input.action });
        await network.jobAction(input.id, input.action, input.role || "buyer"); return summary();
      }
      case "agentNetwork.refresh": if (active) await network.tick(); return summary();
      default: throw Error("Unknown Agent Network operation.");
    }
  }
  return {
    async call(method, input = {}, signal) {
      if (disposed) throw Error("Agent Network session is closed.");
      if (!Object.hasOwn(permissions, method)) throw Error("Unknown Agent Network operation.");
      if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid service input.");
      signal?.throwIfAborted();
      if (busy && !["agentNetwork.status", "agentNetwork.jobDetail"].includes(method)) throw Error("Agent Network is busy. Try again after the current request.");
      const readonly = ["agentNetwork.status", "agentNetwork.jobDetail"].includes(method);
      if (!readonly) { busy = true; operationSignal = AbortSignal.any([lifecycle.signal, ...(signal ? [signal] : []), AbortSignal.timeout(60000)]); }
      const currentSignal = readonly ? signal : operationSignal;
      const abort = () => transport.stop(); currentSignal?.addEventListener("abort", abort, { once: true });
      try { const result = await execute(method, input); currentSignal?.throwIfAborted(); return result; }
      finally { if (!readonly) { busy = false; operationSignal = null; } currentSignal?.removeEventListener("abort", abort); }
    },
    dispose() { disposed = true; active = false; lifecycle.abort(); network.stop(); }
  };
}
module.exports = { pluginId, permissions, create, safeDefinition };
