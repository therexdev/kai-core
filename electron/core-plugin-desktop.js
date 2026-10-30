"use strict";

const PLUGIN_VIEWS = Object.freeze({ brain: "kai.brain", connections: "kai.connections", tools: "kai.tools", devtools: "kai.tools", workflows: "kai.workflows", tasks: "kai.workflows", agents: "kai.agent-network", docs: "kai.documents", code: "kai.code", compare: "kai.model-compare", koinos: "kai.koinos-node", "koinos-node": "kai.koinos-node", "koinos-wallet": "kai.koinos-node", "koinos-fund": "kai.koinos-node", "koinos-burn": "kai.koinos-node", "koinos-returns": "kai.koinos-node", "koinos-settings": "kai.koinos-node", assistant: "kai.assistant", remote: "kai.remote-access", api: "kai.remote-access" });
const CORE_VIEWS = Object.freeze({ chat: "chat", models: "models", settings: "settings", privacy: "settings", account: "settings", wallet: "wallet", "payment-wallet": "wallet", credits: "credits", "buy-credits": "buy-credits", earn: "earning", network: "network", "network-overview": "network", plugins: "plugins" });
const VIEW_SECTIONS = Object.freeze({ devtools: "devtools", "koinos-wallet": "wallet", "koinos-fund": "fund", "koinos-burn": "burn", "koinos-node": "node", "koinos-returns": "returns", "koinos-settings": "settings" });
function resolveView(view, section) {
  if (typeof view !== "string") throw Error("Invalid view");
  const plugin = Object.hasOwn(PLUGIN_VIEWS, view) ? PLUGIN_VIEWS[view] : null;
  const page = Object.hasOwn(CORE_VIEWS, view) ? CORE_VIEWS[view] : null;
  if (!plugin && !page) throw Error("Unknown application view");
  const allowed = plugin === "kai.koinos-node" ? ["dashboard", "wallet", "fund", "burn", "node", "returns", "settings"] : plugin === "kai.tools" ? ["tools", "devtools"] : plugin === "kai.assistant" ? ["providers"] : page === "settings" ? ["website-account", "credit-account", "providers"] : [];
  if (section !== undefined && !allowed.includes(section)) throw Error("Invalid view section");
  return { plugin, page, section: section || VIEW_SECTIONS[view] };
}
const PREFERENCE_KEYS = Object.freeze({
  "kai.model-compare": ["kai-compare-tally", "kai-interface-language"],
  "kai.assistant": ["kai-chat-mode", "kai-chat-source", "kai-chat-model-openai", "kai-chat-model-anthropic", "kai-web-search", "kai-credit-model", "kai-credit-paid-first", "kai-interface-language"],
  "kai.code": ["kai-code-tools", "kai-code-dir", "kai-interface-language"],
});
function createPluginDesktop({ electron, getCoreWindow, openPlugin, hidePlugins, confirm, isClosing }) {
  return async (record, method, input) => {
    const signal = record.controller.signal;
    const active = () => { signal.throwIfAborted(); if (isClosing() || record.window.isDestroyed()) throw Error("Plugin is closing"); };
    active();
    if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid desktop request");
    if (method === "desktop.openView") {
      if (Object.keys(input).some(k => !["view", "section"].includes(k))) throw Error("Invalid view");
      const target = resolveView(input.view, input.section);
      if (target.plugin) return openPlugin(target.plugin, target.section);
      const window = getCoreWindow(); if (!window || window.isDestroyed()) throw Error("Core window is unavailable");
      hidePlugins?.(); window.show(); window.focus(); window.webContents.send("kai-core:open-view", target.section ? { page: target.page, section: target.section } : target.page);
      return { opened: true };
    }
    if (method === "desktop.openExternal") {
      if (Object.keys(input).some(k => k !== "url") || typeof input.url !== "string" || input.url.length > 4000) throw Error("Invalid external URL");
      const url = new URL(input.url);
      if (url.protocol !== "https:" || url.username || url.password) throw Error("Use a complete HTTPS link without credentials");
      if (!await confirm("Open website?", `${record.manifest.name}\n\n${url.href}`)) return { cancelled: true };
      active(); await electron.shell.openExternal(url.href); return { opened: true };
    }
    if (method === "desktop.preferencesRead") {
      const allowed = PREFERENCE_KEYS[record.manifest.id] || ["kai-interface-language"];
      if (!Array.isArray(input.keys) || input.keys.length > 20 || input.keys.some(k => !allowed.includes(k))) throw Error("Unsupported interface preference");
      const window = getCoreWindow(); if (!window || window.isDestroyed()) return {};
      // Only fixed non-secret interface settings from the preserved original
      // origin can cross this boundary. No arbitrary expression or key access.
      const keys = JSON.stringify(input.keys);
      const result = await window.webContents.executeJavaScript(`Object.fromEntries(${keys}.map(key => [key, localStorage.getItem(key)]))`);
      active(); return result;
    }
    throw Error("Unknown desktop operation");
  };
}
module.exports = { createPluginDesktop, resolveView, PLUGIN_VIEWS, CORE_VIEWS, PREFERENCE_KEYS };
