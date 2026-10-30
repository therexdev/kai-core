"use strict";
// The original app tools select named capabilities. This adapter is native-only:
// renderer paths never reach it, and optional features re-enter their pinned,
// installed capability broker instead of an unrestricted loopback HTTP client.
const crypto = require("node:crypto");
const CORE_READ = new Set(["/core/health", "/core/models", "/core/earn", "/core/network", "/core/network/status", "/core/account"]);
const CORE_WRITE = new Set(["/core/models/ensure", "/core/models/download/cancel", "/core/earn/start", "/core/earn/stop"]);
const NODE_READ = new Set(["dashboard:summary", "rewards:status", "fund:cryptoBalances"]);
const NODE_WRITE = new Set(["node:start", "node:stop", "node:setAutoRecover"]);
function createAppRequest(ctx, coreRequest) {
  const documentReads = new Map();
  function observedDocument(document) {
    const token = crypto.randomUUID(); documentReads.set(token, { id: document.id, revision: document.revision });
    if (documentReads.size > 4096) documentReads.delete(documentReads.keys().next().value);
    const { revision: _storedRevision, ...fields } = document;
    return { revision: token, ...fields };
  }
  const call = (id, method, input, signal) => {
    if (typeof ctx.featureCall !== "function") throw Error("This application feature is unavailable in this Core runtime");
    return ctx.featureCall(id, method, input, signal);
  };
  const featureRequest = async (id, method, path, verb, body, signal) => {
    const result = await call(id, method, { requestId: crypto.randomUUID(), path, method: verb, ...(body === undefined ? {} : { body }) }, signal);
    if (!result.ok) throw Error(result.body?.error?.message || result.body?.error || "The application feature could not complete this request");
    return result.body;
  };
  async function review(path, method, body, signal) {
    const detail = JSON.stringify({ operation: path, method, arguments: body || {} }, null, 2);
    if (detail.length > 20000) throw Error("The app action is too large to review");
    if (!await ctx.confirm("Allow this app action?", detail)) throw Error("App action cancelled");
    signal?.throwIfAborted();
  }
  return async (path, method, body, { signal } = {}) => {
    signal?.throwIfAborted();
    if (typeof path !== "string" || /[?%#\\\x00-\x20]/.test(path)) throw Error("Invalid app capability path");
    const nodeRead = path === "/core/koinos/rpc" && (NODE_READ.has(body?.channel) || body?.channel === "chain:balances");
    if (method !== "GET" && !nodeRead) await review(path, method, body, signal);
    if (method === "GET" && CORE_READ.has(path) || method === "POST" && CORE_WRITE.has(path) || method === "DELETE" && /^\/core\/models\/installed\/[a-zA-Z0-9._-]+$/.test(path)) return coreRequest(path, method, body, signal);
    if (path === "/core/network/config" && method === "POST") {
      if (!body || Object.keys(body).some(key => key !== "privacyMode") || !["local-only", "local-first", "network"].includes(body.privacyMode)) throw Error("Choose an application privacy mode");
      return { ok: true, ...await ctx.setPrivacyMode(body.privacyMode) };
    }
    if (path === "/core/koinos/rpc" && method === "POST") {
      if (!body || Object.keys(body).some(key => !["channel", "payload"].includes(key))) throw Error("Unknown app Node request");
      if (body.channel === "chain:balances") {
        if (!ctx.readCoreWalletSummary) throw Error("Core wallet balances are unavailable");
        const value = await ctx.readCoreWalletSummary(); signal?.throwIfAborted();
        return { ok: true, data: { address: value.address, formatted: { koin: value.koin, vhp: value.vhp, mana: value.mana }, network: value.network } };
      }
      const scope = NODE_READ.has(body.channel) ? "node.read" : NODE_WRITE.has(body.channel) ? "node.manage" : null;
      if (!scope) throw Error("This Node action is not an app capability");
      return { ok: true, data: await call("kai.koinos-node", scope, body, signal) };
    }
    if (path === "/core/koinos" && method === "GET") {
      try { await call("kai.koinos-node", "node.read", { channel: "app:info", payload: {} }, signal); return { enabled: true }; }
      catch (error) { signal?.throwIfAborted(); return { enabled: false, unavailable: error.message }; }
    }
    if (path === "/core/koinos/config" && method === "POST") {
      await ctx.openCoreView("plugins"); return { ok: true, opened: "plugins", note: "Enable or disable Koinos Node in Plugins to show or hide its separate workspace." };
    }
    if (path === "/core/dev") return featureRequest("kai.tools", "tools.ui.request", path, method, body, signal);
    if (path === "/core/code-switch") {
      return featureRequest("kai.code", "code.request", path, method, body, signal);
    }
    if (["/core/mcp", "/core/email", "/core/calendar"].includes(path) && method === "GET") return featureRequest("kai.tools", "tools.ui.request", path, method, undefined, signal);
    if (["/core/voice", "/core/speech"].includes(path) && method === "GET") return featureRequest("kai.assistant", "assistant.request", path, method, undefined, signal);
    const document = /^\/core\/docs(?:\/([a-zA-Z0-9_-]+))?$/.exec(path);
    if (document) {
      if (method === "GET") return document[1] ? { ok: true, doc: observedDocument(await call("kai.documents", "documents.get", { id: document[1] }, signal)) } : { ok: true, docs: (await call("kai.documents", "documents.list", {}, signal)).documents };
      const id = document[1] || body?.id, observed = id ? documentReads.get(body?.revision) : null;
      if (id && (!observed || observed.id !== id)) throw Error("Read this document first and include its exact returned revision before changing it");
      if (method === "POST" && !document[1]) {
        const saved = await call("kai.documents", "documents.save", { ...body, ...(observed ? { revision: observed.revision } : {}) }, signal);
        if (observed) documentReads.delete(body.revision); return { ok: true, ...observedDocument(saved) };
      }
      if (method === "DELETE" && document[1]) { const result = await call("kai.documents", "documents.remove", { id, revision: observed.revision }, signal); if (result.removed) documentReads.delete(body.revision); return { ok: true, ...result }; }
    }
    const chat = /^\/core\/chats(?:\/([a-zA-Z0-9_-]+))?$/.exec(path);
    if (chat && ["GET", "DELETE"].includes(method)) {
      if (method === "DELETE" && chat[1]) await featureRequest("kai.assistant", "assistant.request", path, "GET", undefined, signal);
      return featureRequest("kai.assistant", "assistant.request", path, method, body, signal);
    }
    const scheduled = /^\/core\/tasks(?:\/([a-zA-Z0-9_-]+))?$/.exec(path);
    if (scheduled) {
      const list = await call("kai.workflows", "workflows.list", {}, signal);
      const tasks = list.workflows.filter(workflow => workflow.schedule?.kind !== "manual").map(workflow => ({ id: workflow.id, name: workflow.name, enabled: workflow.enabled, schedule: workflow.schedule, model: workflow.model, nextRunAt: workflow.nextRunAt, ...workflow.legacyTask, workflowId: workflow.id }));
      if (method === "GET" && !scheduled[1]) return { ok: true, tasks };
      if (method === "POST" && !scheduled[1]) {
        const { TaskRunner } = require("../../core/lib/tasks"), validator = Object.create(TaskRunner.prototype); validator.tasks = []; validator._persist = () => {};
        const task = validator.create(body);
        const spec = require("../../ui/workflow-model").fromLegacy({ name: task.name, model: task.model, enabled: true, schedule: task.schedule, steps: [{ type: "prompt", text: task.prompt }, { type: "output", text: "{{previous}}" }] });
        spec.graph.nodes.at(-1).config.saveChat = true;
        return { ok: true, task: await call("kai.workflows", "workflows.save", spec, signal) };
      }
      const workflow = list.workflows.find(row => row.id === scheduled[1] || row.legacyTask?.id === scheduled[1]);
      if (!workflow) throw Error("Scheduled workflow no longer exists");
      if (method === "DELETE") return { ok: true, ...await call("kai.workflows", "workflows.remove", { id: workflow.id }, signal) };
      if (method === "PATCH") {
        const edited = ["name", "prompt", "model", "schedule"].some(key => body[key] !== undefined);
        let saved = workflow;
        if (edited) {
          const spec = require("../../ui/workflow-model").fromLegacy(structuredClone(workflow)), agents = spec.graph.nodes.filter(node => node.type === "agent");
          if (agents.length !== 1) throw Error("Edit this multi-step schedule in Workflows so its agent instructions remain explicit");
          const { TaskRunner } = require("../../core/lib/tasks"), validator = Object.create(TaskRunner.prototype); validator.tasks = []; validator._persist = () => {};
          const task = validator.create({ name: body.name ?? workflow.name, prompt: body.prompt ?? agents[0].config.prompt, model: body.model ?? agents[0].config.model ?? workflow.model, schedule: body.schedule ?? workflow.schedule });
          spec.name = task.name; spec.model = task.model; agents[0].config.prompt = task.prompt; agents[0].config.model = task.model;
          if (body.schedule !== undefined) { const trigger = spec.graph.nodes.find(node => node.type === "trigger"); trigger.config = { ...trigger.config, kind: "schedule", schedule: task.schedule }; spec.schedule = task.schedule; }
          spec.enabled = body.enabled === undefined ? workflow.enabled : body.enabled;
          saved = await call("kai.workflows", "workflows.save", spec, signal);
        } else if (body.enabled !== undefined) saved = await call("kai.workflows", "workflows.workflowEnabled", { id: workflow.id, enabled: body.enabled }, signal);
        return { ok: true, task: saved };
      }
    }
    throw Error("This app request is not an allowed capability");
  };
}
module.exports = { createAppRequest, CORE_READ, CORE_WRITE, NODE_READ, NODE_WRITE };
