"use strict";
// The original Local API screen uses the same gateway keys, usage budgets and
// RemoteAccess implementation. This broker never returns stored key digests.
const { RemoteAccess } = require("../../core/lib/remote-access");
class OwnedRemoteAccess extends RemoteAccess {
  constructor(options) { super(options); this.pending = new Set(); }
  track(promise) { const task = Promise.resolve(promise); this.pending.add(task); task.then(() => this.pending.delete(task), () => this.pending.delete(task)); return task; }
  _hello() { return this.track(super._hello()); }
  _loop() { return this.track(super._loop()); }
  async drain() { await Promise.allSettled([...this.pending]); }
}
function create(ctx, { checkSettings, active }) {
  let remote, closed = false;
  const FEATURES = Object.freeze({
    node: { id: "kai.koinos-node", view: "koinos" },
    developer: { id: "kai.tools", view: "devtools", method: "tools.ui.request", path: "/core/dev" },
    code: { id: "kai.code", view: "code", method: "code.request", path: "/core/code-switch" },
  });
  const installed = feature => {
    const value = ctx.loadInstalledPlugin?.(feature.id);
    if (!value) return false;
    const publisher = require("../../core/lib/plugins/first-party.json").plugins.find(row => row.id === feature.id);
    if (value.manifest?.id !== feature.id || !publisher || value.fingerprint !== publisher.fingerprint) throw Error("This workspace needs the verified KAI plugin. Manage it in Plugins.");
    return true;
  };
  async function featureRequest(feature, method, body, signal) {
    if (typeof ctx.featureCall !== "function") throw Error("Update Core to manage optional workspaces");
    const result = await ctx.featureCall(feature.id, feature.method, { requestId: require("node:crypto").randomUUID(), path: feature.path, method, ...(body === undefined ? {} : { body }) }, signal);
    active(signal); if (closed) throw Error("Remote Access is closing");
    if (!result.ok) throw Error(result.body?.error?.message || result.body?.error || "The workspace could not finish this request");
    return result.body;
  }
  async function featureStatus(signal) {
    const rows = [];
    for (const [name, feature] of Object.entries(FEATURES)) {
      active(signal); if (closed) throw Error("Remote Access is closing");
      try { const available = installed(feature), status = available && feature.method ? await featureRequest(feature, "GET", undefined, signal) : null;
        rows.push({ name, available, enabled: available && (feature.method ? status.enabled === true : true) }); }
      catch (error) { active(signal); if (closed) throw error; rows.push({ name, available: false, enabled: false, error: String(error.message).slice(0, 400) }); }
    }
    return { features: rows };
  }
  const mode = () => ctx.core.gateway.network.status().privacyMode;
  const online = () => { if (mode() === "local-only") throw Error("Local-Only blocks remote access. Choose Local-First or Network first."); };
  const service = () => remote ||= (ctx.originalRemoteFactory || (options => new OwnedRemoteAccess(options)))({
    relayUrl: "https://koinosai.com", settings: { get: (...args) => { checkSettings(); return ctx.core.settings.get(...args); }, set: (...args) => { checkSettings(); return ctx.core.settings.set(...args); } }, keys: ctx.core.keys,
    localBase: () => `http://127.0.0.1:${ctx.core.gateway.port}`,
  });
  const snapshot = () => ({ ok: true, localBase: `http://127.0.0.1:${ctx.core.gateway.port}`,
    privacyMode: mode(), models: ctx.core.models.aliases().map(({ alias, label, status }) => ({ alias, label, status })),
    keys: ctx.core.keys.list(), required: ctx.core.keys.required(), remote: service().status() });
  async function stop(preserveChoice = false) {
    if (!remote) return;
    const resume = preserveChoice && ctx.core.settings.get("remote.enabled") === true;
    let error;
    try { remote.stop(); }
    catch (problem) { error = problem; remote._on = false; remote._abort?.abort(); }
    await remote.drain?.();
    if (error) throw error;
    if (resume) { checkSettings(); ctx.core.settings.set("remote.enabled", true); }
  }
  return {
    async features(input, signal) {
      active(signal); if (closed) throw Error("Remote Access is closing"); checkSettings();
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["action", "feature", "enabled"].includes(key))) throw Error("Invalid optional workspace request");
      if (input.action === "status") { if (Object.keys(input).length !== 1) throw Error("Workspace status takes no settings"); return featureStatus(signal); }
      const feature = Object.hasOwn(FEATURES, input.feature) ? FEATURES[input.feature] : null;
      if (!feature || !["toggle", "open", "manage"].includes(input.action)) throw Error("Unknown optional workspace action");
      if (input.action === "toggle" ? typeof input.enabled !== "boolean" : input.enabled !== undefined) throw Error("Choose an exact workspace switch value");
      if (input.action === "manage" || input.feature === "node" && input.action === "toggle" || !installed(feature)) {
        await ctx.openCoreView("plugins"); active(signal); return { opened: "plugins", ...await featureStatus(signal) };
      }
      if (input.action === "toggle") {
        await featureRequest(feature, "POST", { enabled: input.enabled }, signal);
        return featureStatus(signal);
      }
      if (feature.method && !(await featureRequest(feature, "GET", undefined, signal)).enabled) throw Error("Enable this workspace before opening it");
      await ctx.openCoreView(feature.view); active(signal); return { opened: feature.view };
    },
    async startBackground() {
      active(); checkSettings();
      if (ctx.core.settings.get("remote.enabled") === true && mode() !== "local-only" && ctx.core.keys.required()) await service().start();
      return snapshot();
    },
    async call(input, signal) {
      active(signal); if (closed) throw Error("Remote Access is closing"); checkSettings();
      if (!input || typeof input !== "object" || Array.isArray(input) || JSON.stringify(input).length > 4096) throw Error("Invalid Remote Access action");
      const { action, name, id, budgetUsdMonthly, privacyMode, enabled } = input;
      if (Object.keys(input).some(k => !["action", "name", "id", "budgetUsdMonthly", "privacyMode", "enabled"].includes(k))) throw Error("Invalid Remote Access action");
      if (action === "status") return snapshot();
      if (action === "privacy") {
        if (!["local-only", "local-first", "network"].includes(privacyMode)) throw Error("Choose a privacy mode");
        if (privacyMode === "local-only") await stop();
        await ctx.setPrivacyMode?.(privacyMode);
        if (!ctx.setPrivacyMode) ctx.core.gateway.network.configure({ privacyMode });
        return snapshot();
      }
      if (action === "toggle") {
        if (typeof enabled !== "boolean") throw Error("Invalid remote toggle");
        if (!enabled) { await stop(); return snapshot(); }
        online();
        if (!ctx.core.keys.required()) throw Error("Create an API key first — remote access only ever serves callers who present one");
        if (!await ctx.confirm("Enable Remote Access?", "Your API will be available through koinosai.com while KAI Core is running. Clients must present an API key. Prompts and responses pass through the relay. Your existing API-key budgets and network privacy settings apply.")) return { ...snapshot(), cancelled: true };
        active(signal); checkSettings(); online(); await service().start(); return snapshot();
      }
      if (action === "create") {
        if (typeof name !== "string" || !name.trim() || name.length > 80 || /[\r\n\0]/.test(name)) throw Error("Use a key name under 80 characters");
        if (!await ctx.confirm("Create an API key?", `Create “${name.trim()}” for your original local and remote API? The secret is displayed once. Creating the first key requires all external API clients to authenticate.`)) return { cancelled: true };
        active(signal); checkSettings(); return { ok: true, ...ctx.core.keys.create({ name: name.trim() }) };
      }
      if (!["budget", "revoke"].includes(action) || typeof id !== "string" || !/^key_[a-f0-9]{12}$/.test(id) || !ctx.core.keys.list().some(k => k.id === id)) throw Error("Unknown API key action");
      if (action === "budget") {
        if (budgetUsdMonthly !== null && (typeof budgetUsdMonthly !== "number" || !Number.isFinite(budgetUsdMonthly) || budgetUsdMonthly < 0)) throw Error("Budget must be a nonnegative number of dollars");
        ctx.core.keys.setBudget(id, budgetUsdMonthly); return snapshot();
      }
      if (!await ctx.confirm("Revoke API key?", "Clients using this key will lose access immediately. This does not change your wallet or other API keys.")) return { ...snapshot(), cancelled: true };
      active(signal); checkSettings(); ctx.core.keys.revoke(id);
      if (!ctx.core.keys.required()) await stop();
      return snapshot();
    },
    async pause() { await stop(); },
    async dispose() { closed = true; await stop(true); },
  };
}
module.exports = { create };
