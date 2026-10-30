"use strict";
const crypto = require("node:crypto");
const CHAT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PAYMENT_ACTIONS = new Set("credit-status chat-info chat-completion chat-ack chat-recover stop run-open run-chat run-execute run-input run-list run-status run-stop".split(" "));
function create(ctx, files) {
  const revisions = new Map(); let native, disposed = false;
  const response = body => ({ ok: true, status: 200, headers: { "content-type": "application/json" }, body });
  const body = input => {
    const value = typeof input.body === "string" ? JSON.parse(input.body) : input.body || {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid conversation request"); return value;
  };
  function current(id) {
    if (typeof id !== "string" || !CHAT_ID.test(id)) throw Error("Invalid conversation id");
    const row = files.read(id);
    if (!revisions.has(id) || revisions.get(id) !== row.revision) throw Error("Conversation changed in another window. Reopen it before saving.");
    return row;
  }
  function commit(id, doc, revision) {
    const result = files.write(id, doc, revision); revisions.set(id, result.revision); return result;
  }
  async function reviewRuntimeRequest(input, signal) {
    const route = input.path.split("?")[0];
    if (String(input.method || "GET").toUpperCase() !== "POST" || !["/core/tools/call", "/core/teams/run", "/core/agents/run"].includes(route)) return input;
    if (input.bodyBase64 !== undefined) throw Error("Sensitive Assistant actions require a reviewable JSON body");
    const value = structuredClone(body(input));
    const requested = route === "/core/tools/call" ? !!value.confirmed : value.allowSensitive === true;
    if (!requested) return { ...input, body: value };
    await ctx.legacyEnsure?.("assistant"); signal?.throwIfAborted();
    if (disposed) throw Error("Assistant is closing");
    const registry = ctx.core.gateway.tools;
    const available = registry?.list() || [], known = available.map(tool => tool.name);
    let names, detail;
    if (route === "/core/tools/call") {
      const tool = available.find(tool => tool.name === value.name);
      if (!tool) throw Error("This tool is unavailable in the current privacy mode");
      if (!tool.sensitive) return { ...input, body: value };
      names = [tool.name]; detail = { tool: tool.name, description: tool.description, arguments: value.args || {} };
    } else if (route === "/core/teams/run") {
      const spec = value.spec !== undefined && value.spec !== null ? require("../../core/lib/teams").normalizeSpec(value.spec, known) : ctx.core.gateway.teams?.templates().find(item => item.id === value.template);
      if (!spec) throw Error("Choose an available team");
      names = spec.tools; detail = { team: spec.label, task: value.question, model: value.model, tools: names, specification: spec };
    } else {
      const raw = value.spec || ctx.core.gateway.agents?.defs.get(value.defId)?.spec;
      const spec = require("../../core/lib/groupchat").normalizeGroupSpec(raw, known);
      // Freeze the exact reviewed saved definition into this request, so an
      // edit made while the native dialog is open cannot change the run.
      value.spec = spec; delete value.defId;
      names = [...new Set(spec.agents.flatMap(agent => agent.tools))]; detail = { team: spec.label, task: value.task, model: value.model, tools: names, specification: spec };
    }
    const snapshots = names.map(name => ({ name, tool: registry?._tools.get(name), metadata: JSON.stringify(available.find(tool => tool.name === name)) }));
    if (snapshots.some(item => !item.tool)) throw Error("A requested tool is unavailable");
    const review = JSON.stringify(detail, null, 2);
    if (review.length > 24000) throw Error("This action is too large to review. Use a smaller task or tool input.");
    if (!await ctx.confirm(route === "/core/tools/call" ? "Run this Assistant tool?" : "Allow sensitive tools for this team run?", review)) throw Error("Action cancelled; no sensitive tools were run");
    signal?.throwIfAborted(); if (disposed) throw Error("Assistant is closing");
    const latest = registry.list();
    if (ctx.core.gateway.tools !== registry || snapshots.some(item => registry._tools.get(item.name) !== item.tool || JSON.stringify(latest.find(tool => tool.name === item.name)) !== item.metadata)) throw Error("Tool configuration changed while approval was open. Review the action again.");
    return { ...input, body: value };
  }
  async function request(input, signal) {
    if (!input || typeof input.path !== "string") throw Error("Invalid Assistant request");
    const method = String(input.method || "GET").toUpperCase();
    if (method === "POST" && /^\/core\/(?:voice|speech)\/setup(?:\?|$)/.test(input.path)) await (native ||= require("./assistant-native").create(ctx)).startBackground();
    const match = /^\/core\/chats(?:\/([a-z0-9][a-z0-9-]{0,63}))?$/.exec(input.path);
    if (!match) return ctx.legacyRequest("assistant", await reviewRuntimeRequest(input, signal), signal);
    if (input.bodyBase64 !== undefined) throw Error("Conversation requests require a JSON body");
    const id = match[1];
    if (method === "GET" && !id) {
      const rows = await files.list(signal), chats = [];
      for (const item of rows.chats) {
        const row = files.read(item.id); if (!revisions.has(item.id)) revisions.set(item.id, row.revision);
        chats.push({ ...item, searchText: row.doc.messages.map(m => m.content).join(" ").slice(0, 1200) });
      }
      return response({ ok: true, chats, warnings: rows.warnings });
    }
    if (method === "GET" && id) {
      const row = files.read(id); revisions.set(id, row.revision); return response({ ok: true, chat: row.doc });
    }
    if (method === "POST" && !id) {
      const input = body(arguments[0]), messages = input.messages;
      if (!Array.isArray(messages) || !messages.length || messages.length > 10000 || JSON.stringify(messages).length > 16 * 1024 * 1024) throw Error("Conversation is too large to save");
      const safe = messages.map(m => {
        if (!m || typeof m !== "object" || !["user", "assistant", "system", "tool"].includes(m.role) || typeof m.content !== "string") throw Error("Invalid conversation message");
        const citations = Array.isArray(m.citations) ? m.citations.slice(0, 8).map(c => ({ title: String(c?.title || "").slice(0, 120), url: String(c?.url || "").slice(0, 500) })).filter(c => /^https?:\/\//i.test(c.url)) : [];
        const images = Array.isArray(m.images) ? m.images.filter(u => typeof u === "string" && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(u) && u.length <= 2500000).slice(0, 3) : [];
        return { role: m.role, content: m.content, ...(citations.length ? { citations } : {}), ...(images.length ? { images } : {}) };
      });
      const previous = input.id ? current(input.id) : null;
      const key = previous?.doc.id || `c${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`, now = new Date().toISOString();
      const old = previous?.doc || {}, doc = { ...old, id: key, title: old.renamed ? old.title : String(input.title || safe.find(m => m.role === "user")?.content || "Untitled chat").slice(0, 80), createdAt: old.createdAt || now, updatedAt: now,
        messages: safe.map((message, i) => old.messages?.[i]?.role === message.role && old.messages[i].content === message.content ? { ...old.messages[i], ...message } : message) };
      if (input.system) doc.system = String(input.system).slice(0, 4000); else delete doc.system;
      if (input.persona) doc.persona = String(input.persona).slice(0, 40); else delete doc.persona;
      return response({ ok: true, ...commit(key, doc, previous?.revision) });
    }
    if (method === "PATCH" && id) {
      const input = body(arguments[0]), previous = current(id), doc = { ...previous.doc };
      if (Object.keys(input).some(k => !["title", "pinned"].includes(k))) throw Error("Unsupported conversation edit");
      if (input.title !== undefined) { if (typeof input.title !== "string" || !input.title.trim()) throw Error("Use a conversation title"); doc.title = input.title.trim().slice(0, 80); doc.renamed = true; doc.updatedAt = new Date().toISOString(); }
      if (input.pinned !== undefined) { if (typeof input.pinned !== "boolean") throw Error("Invalid favorite value"); doc.pinned = input.pinned; }
      return response({ ok: true, ...commit(id, doc, previous.revision) });
    }
    if (method === "DELETE" && id) {
      const previous = current(id);
      if (!await ctx.confirm("Delete conversation?", `Delete “${previous.doc.title || "Untitled chat"}” from this device?`)) return response({ ok: true, cancelled: true });
      signal?.throwIfAborted(); current(id); await files.remove(id, previous.revision, signal); revisions.delete(id); return response({ ok: true });
    }
    throw Error("Unsupported conversation request");
  }
  return {
    startBackground: () => (native ||= require("./assistant-native").create(ctx)).startBackground(),
    async call(method, input = {}, signal) {
      signal?.throwIfAborted(); if (disposed) throw Error("Assistant is closing");
      if (method === "assistant.request") return request(input, signal);
      if (method === "assistant.poll") return ctx.legacyPoll("assistant", input.streamId, signal);
      if (method === "assistant.cancel") return ctx.legacyCancel("assistant", input.streamId);
      if (method === "assistant.native") return (native ||= require("./assistant-native").create(ctx)).call(input, signal);
      if (method === "assistant.payment") {
        if (!PAYMENT_ACTIONS.has(input.action)) throw Error("This payment action is unavailable to Assistant");
        if (!ctx.runPayment) throw Error("Network chat is unavailable");
        return ctx.runPayment(input.action, input.input, { window: ctx.getWindow(), webContents: ctx.getWebContents?.(), isVisible: ctx.isVisible, signal });
      }
      if (method === "assistant.navigate") { if (typeof input.view !== "string") throw Error("Choose a destination"); return ctx.openCoreView(input.view); }
      if (method === "assistant.copyText") { if (typeof input.text !== "string" || input.text.length > 800000 || Object.keys(input).some(key => key !== "text")) throw Error("Invalid text to copy"); ctx.electron.clipboard.writeText(input.text); return { copied: true }; }
      if (method === "assistant.external") {
        const url = new URL(input.url); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw Error("Only public web links can be opened");
        return ctx.electron.shell.openExternal(url.href);
      }
      if (method === "assistant.privacy") {
        if (!["local-only", "local-first", "network"].includes(input.privacyMode)) throw Error("Choose a privacy mode");
        return ctx.setPrivacyMode(input.privacyMode);
      }
      if (method === "assistant.media") return { available: true };
      throw Error("Unknown Assistant operation");
    },
    privacyChanged: mode => native?.privacyChanged(mode),
    async dispose() { disposed = true; try { await native?.dispose(); } finally { await ctx.legacyRelease?.("assistant"); } },
  };
}
module.exports = { create, PAYMENT_ACTIONS };
