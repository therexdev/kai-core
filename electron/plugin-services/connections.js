"use strict";
const { CompanionConnections, TEMPLATES } = require("../companion-connections");
const { CompanionComposio } = require("../companion-composio");
const { connectURL } = require("../../core/lib/composio-client");
const { createUi, permissionsFor } = require("./companion-feature-ui");
const pluginId = "kai.connections";
const permissions = Object.freeze({
  ...permissionsFor("connections"),
  "connections.status": "connections.read", "connections.templates": "connections.read", "connections.save": "connections.manage", "connections.remove": "connections.manage", "connections.execute": "connections.execute",
  "connections.composio.settings": "connections.manage", "connections.composio.catalog": "connections.read", "connections.composio.tools": "connections.read", "connections.composio.refresh": "connections.read", "connections.composio.connect": "connections.manage", "connections.composio.disconnect": "connections.manage", "connections.composio.permissions": "connections.manage",
});
function object(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input) || JSON.stringify(input).length > 50000 || Object.keys(input).some(k => !allowed.includes(k))) throw Error("Invalid connection input");
  return structuredClone(input);
}
function key(value) { if (typeof value !== "string" || value.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(value)) throw Error("Invalid connection ID"); return value; }
function create(ctx) {
  const ui = createUi(ctx, "connections");
  let api, composio, store, closed = false, busy = false;
  const privacyMode = () => ctx.core.gateway.network.status().privacyMode;
  function load() {
    if (closed) throw Error("Connections is closed");
    store = ctx.getCompanionStore(); store.requireStorage();
    if (!api) {
      api = new CompanionConnections({ store, privacyMode, ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}) });
      composio = new CompanionComposio({ store, privacyMode, account: ctx.core.account, ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
        openExternal: async value => {
          const url = connectURL(value), target = new URL(url);
          if (!await ctx.confirm("Open account sign-in?", `Open ${target.origin}${target.pathname} in your browser?\nThe browser handles sign-in. KAI does not read your browser passwords or cookies.`)) throw Error("Sign-in cancelled");
          if (closed) throw Error("Connections is closed");
          await ctx.electron.shell.openExternal(url);
        } });
      api.composio = composio;
    }
  }
  // Return explicit metadata only. Never serialize the shared store, its Brain
  // collections, saved bearer tokens, account bindings, or Composio API key.
  function status() {
    load(); return clean({ privacyMode: privacyMode(), composio: composio.status(), connections: api.list().slice(0, 100).map(c => ({
      id: c.id, name: c.name, provider: c.provider || "api", toolkit: c.toolkit || "", enabled: c.enabled !== false, configured: c.configured, status: c.status || "Not tested", revision: c.revision,
      allowAgent: c.allowAgent === true, allowSync: c.allowSync === true, allowWrite: c.allowWrite === true, baseUrl: c.baseUrl || "", auth: c.auth || "", headerName: c.headerName || "", lastCheck: c.lastCheck || null, headers: Object.fromEntries(Object.entries(c.headers || {}).filter(([k]) => ["accept", "notion-version", "x-github-api-version"].includes(k.toLowerCase()))),
      operations: (c.operations || []).slice(0, 30).map(o => ({ id: o.id, name: o.name, method: o.method, path: o.path, readOnly: o.readOnly, version: o.version, ...(o.schema ? { schema: o.schema } : {}) })),
    })) });
  }
  function clean(result) {
    const secrets = [store.data.composio?.key, ctx.core.account?._token?.(), ...store.data.connections.map(c => c.secret)].filter(v => typeof v === "string" && v.length);
    const patterns = secrets.flatMap(secret => { const variants = [secret]; for (let n = 0; n < 3; n++) variants.push(JSON.stringify(variants.at(-1)).slice(1, -1)); return variants; }).sort((a,b) => b.length - a.length);
    const redact = value => patterns.reduce((text, secret) => text.split(secret).join("[credential removed]"), value);
    function visit(value, depth = 0) {
      if (depth > 40) throw Error("Connection response is too deeply nested");
      if (typeof value === "string") return redact(value);
      if (Array.isArray(value)) return value.map(v => visit(v, depth + 1));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k), visit(v, depth + 1)]));
      return value;
    }
    if (JSON.stringify(result).length > 240000) throw Error("Connection result is too large; narrow the request");
    return visit(result);
  }
  async function review(title, detail, signal) {
    if (!await ctx.confirm(title, detail)) return false;
    signal?.throwIfAborted(); if (closed) throw Error("Connections is closed"); return true;
  }
  return {
    keepAliveOnWindowClose: true,
    startBackground: () => ui.startBackground(),
    async call(method, value = {}, signal) {
      if (ui.accepts(method)) return ui.call(method, value, signal);
      try {
      if (!Object.hasOwn(permissions, method)) throw Error("Unknown Connections operation"); if (closed) throw Error("Connections is closed"); signal?.throwIfAborted();
      if (method === "connections.templates") return structuredClone(TEMPLATES);
      load();
      if (method === "connections.status") return status();
      if (busy) throw Error("Finish the current connection action first"); busy = true;
      try {
        if (method === "connections.save") {
          const input = object(value, ["id", "name", "baseUrl", "auth", "headerName", "secret", "headers", "operations", "enabled", "allowAgent", "allowSync"]);
          if (!await review("Save API connection?", `${String(input.name || "API connection").slice(0, 80)}\nDestination: ${String(input.baseUrl).slice(0, 2000)}\nOperations: ${(input.operations || []).map(o => `${o.method} ${o.path}`).join("\n").slice(0, 12000)}\n\nYour token is encrypted in the existing local account store. ${input.allowAgent ? "Personal agents may use this connection with their own action controls." : "Agent access remains off."}`, signal)) return { cancelled: true };
          return clean(api.save(input));
        }
        if (method === "connections.remove") {
          const input = object(value, ["id"]), id = key(input.id), found = api.list().find(c => c.id === id);
          if (!found) throw Error("Connection no longer exists");
          if (!await review("Remove API connection?", `Remove ${found.name}? Dependent background sources will be paused.`, signal)) return { cancelled: true };
          api.remove(id); return { removed: true };
        }
        if (method === "connections.execute") {
          const input = object(value, ["id", "operationId", "variables", "body"]);
          const request = api.prepare(key(input.id), key(input.operationId), input.variables || {}, input.body);
          if (!await review("Run connection action?", `${request.name}\n${request.method} ${request.url}\n${request.body || JSON.stringify(request.arguments || {})}\n\nThe account credential stays in Core. Returned data will be shown in Connections.`, signal)) return { cancelled: true };
          return { result: clean(await api.execute(request, signal)) };
        }
        if (method === "connections.composio.settings") {
          const input = object(value, ["mode", "key", "clearKey"]);
          if (!await review("Change connection provider?", `Use ${input.mode === "personal" ? "your own Composio project" : "KAI-managed connections"}? Existing connected accounts are preserved. Provider keys are never returned to this plugin.`, signal)) return { cancelled: true };
          return clean(await composio.save(input, signal));
        }
        if (method === "connections.composio.refresh") { object(value, []); await composio.refresh(signal); return status(); }
        if (method === "connections.composio.catalog") return clean(await composio.catalog(object(value, ["search", "cursor", "category"]), signal));
        if (method === "connections.composio.tools") return clean(await composio.tools(object(value, ["toolkit", "search", "cursor"]), signal));
        if (method === "connections.composio.connect") {
          const input = object(value, ["toolkit"]); key(input.toolkit);
          if (!await review("Connect this app?", `Start a sign-in request for ${input.toolkit}? You will review the provider's permissions in your browser.`, signal)) return { cancelled: true };
          return clean(await composio.connect(input.toolkit, signal));
        }
        if (method === "connections.composio.disconnect") {
          const input = object(value, ["id"]), id = key(input.id), found = api.list().find(c => c.id === id);
          if (!found) throw Error("Connection no longer exists");
          if (!await review("Disconnect account?", `Disconnect ${found.name}? Dependent sources will be paused.`, signal)) return { cancelled: true };
          await composio.disconnect(id, signal); return { removed: true };
        }
        if (method === "connections.composio.permissions") {
          const input = object(value, ["id", "name", "tools", "allowAgent", "allowSync", "allowWrite"]); key(input.id);
          if (!await review("Update account permissions?", `Selected actions: ${JSON.stringify(input.tools || []).slice(0, 8000)}\nAllow changes: ${input.allowWrite === true}\nPersonal agent access: ${input.allowAgent === true}\nBackground source reads: ${input.allowSync === true}`, signal)) return { cancelled: true };
          await composio.permissions(input, signal); return status();
        }
      } finally { busy = false; }
      } catch (error) { let message = String(error?.message || "Connection request failed"); if (store) { try { message = clean(message); } catch { message = "Connection request failed"; } } throw Error(message); }
    },
    async dispose() { closed = true; api?.cancel(); composio?.cancel(); await ui.dispose(); },
  };
}
module.exports = { pluginId, permissions, create };
