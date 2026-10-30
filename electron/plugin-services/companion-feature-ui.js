"use strict";
// The original UI speaks companion actions. Each action has its own reviewed
// permission and is dispatched only after the pinned feature broker approves it.
const actionPermissions = Object.freeze({
  brain: Object.freeze({
    status: "brain.read", brainSearch: "brain.read", brainChats: "brain.read",
    note: "brain.write", goal: "brain.write", remove: "brain.write", brainTask: "brain.write",
    removeBrainTask: "brain.write", brainCheckpoint: "brain.write", brainClearHistory: "brain.write",
    brainReview: "brain.write", awarenessSettings: "brain.write", awarenessTask: "brain.write",
    awarenessRun: "brain.write", awarenessStop: "brain.write", awarenessRetry: "brain.write", recall: "brain.write",
    brainSource: "brain.import", import: "brain.import", source: "brain.import", sync: "brain.import", sourceToggle: "brain.write",
    exportBrainVault: "brain.export", exportBrain: "brain.export", run: "brain.workflow",
  }),
  connections: Object.freeze({
    status: "connections.read", composioRefresh: "connections.read", composioCatalog: "connections.read",
    composioTools: "connections.read", composioLogo: "connections.read",
    composioSettings: "connections.manage", composioConnect: "connections.manage", composioReopen: "connections.manage",
    composioPermissions: "connections.manage", composioDisconnect: "connections.manage", connection: "connections.manage",
    removeConnection: "connections.manage", conversationReview: "connections.manage", approvalGrantRemove: "connections.manage",
    request: "connections.execute", source: "connections.brain", sync: "connections.brain",
  }),
});
function permissionsFor(feature) {
  if (!Object.hasOwn(actionPermissions, feature)) throw Error("Unknown companion feature");
  return Object.fromEntries(Object.entries(actionPermissions[feature]).map(([action, permission]) => [`${feature}.ui.${action}`, permission]));
}
function pick(value, fields) { return Object.fromEntries(fields.filter(key => value && Object.hasOwn(value, key)).map(key => [key, value[key]])); }
function displayConnections(connections) {
  return (connections || []).map(connection => pick(connection, ["id", "name", "provider", "toolkit", "enabled", "configured", "status", "revision", "allowAgent", "allowSync", "allowWrite", "baseUrl", "auth", "headerName", "lastCheck", "headers", "operations"]));
}
function scopedStatus(feature, value) {
  if (!value || value.locked || value.available === false) return { locked: value?.locked !== false, available: value?.available === true };
  const common = {
    locked: false, available: true, connections: displayConnections(value.connections), templates: value.templates || [],
    models: (value.models || []).map(model => pick(model, ["alias", "label", "status"])),
    runs: (value.runs || []).map(run => pick(run, ["id", "name", "status", "startedAt"])), syncing: [],
  };
  if (feature === "brain") return {
    ...common, ...pick(value, ["notes", "goals", "sources", "syncs", "brain", "brainIndex", "awarenessRunning", "memoryMigrationError", "syncing"]),
    settings: { recall: value.settings?.recall === true },
    workflows: (value.workflows || []).map(workflow => pick(workflow, ["id", "name", "draft"])),
  };
  return {
    ...common, composio: value.composio || {},
    // The unchanged companion editor eagerly builds its action table. Empty
    // collections satisfy that UI contract without exposing other feature data.
    notes: [], goals: [], workflows: [], sources: [],
    settings: { approvalGrants: value.settings?.approvalGrants || [] },
    conversations: (value.conversations || []).map(turn => ({
      ...pick(turn, ["id", "question", "at"]),
      actions: (turn.actions || []).map(action => pick(action, ["id", "name", "status", "message", "data", "ids", "runId"])),
    })),
  };
}
function cleanResult(value, hub, ctx) {
  let accountToken; try { accountToken = ctx.core.account?._token?.(); } catch { /* Locked accounts stay locked. */ }
  const secrets = [hub.store.data.composio?.key, accountToken, ...(hub.store.data.connections || []).map(connection => connection.secret)].filter(secret => typeof secret === "string" && secret.length);
  const patterns = [...new Set(secrets.flatMap(secret => {
    const variants = [secret]; for (let i = 0; i < 3; i++) variants.push(JSON.stringify(variants.at(-1)).slice(1, -1)); return variants;
  }))].sort((a, b) => b.length - a.length);
  function visit(item, depth = 0) {
    if (depth > 100) throw Error("Companion response is too deeply nested");
    if (typeof item === "string") return patterns.reduce((text, secret) => text.split(secret).join("[credential removed]"), item);
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [visit(key, depth + 1), visit(child, depth + 1)]));
    return item;
  }
  return visit(value);
}
function createUi(ctx, feature) {
  const permissions = permissionsFor(feature); let closed = false, acquired = false;
  return {
    accepts: method => Object.hasOwn(permissions, method),
    startBackground() {
      if (closed) throw Error("Plugin is closing");
      ctx.getCompanionStore().requireStorage();
      ctx.getLegacyHub(feature); acquired = true;
    },
    async call(method, input = {}, signal) {
      if (closed) throw Error("Plugin is closing");
      signal?.throwIfAborted();
      if (!Object.hasOwn(permissions, method)) throw Error("Unknown companion feature operation");
      if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid companion request");
      if (typeof ctx.getLegacyHub !== "function" || typeof ctx.legacyManage !== "function") throw Error("This plugin requires the current KAI Core feature runtime");
      const action = method.slice(`${feature}.ui.`.length);
      // Recheck the guarded shared store before dispatch, including reads.
      try { ctx.getCompanionStore().requireStorage(); } catch (error) {
        if (action === "status" && /Unlock your original OS keychain/.test(error.message)) return { locked: true, available: false };
        throw error;
      }
      const hub = ctx.getLegacyHub(feature); acquired = true;
      if (feature === "brain" && action === "remove" && !["notes", "goals", "sources"].includes(input.kind)) throw Error("Unknown Brain item");
      if (feature === "connections" && action === "sync") {
        const source = hub.store.data.sources.find(source => source.id === input.id);
        if (!source || source.kind !== "connection") throw Error("Connections may sync only a selected connected-app source");
      }
      if (feature === "connections" && action === "conversationReview") {
        const turn = hub.store.data.conversations?.find(turn => turn.id === input.turnId);
        const action = turn?.actions.find(action => action.id === input.id);
        if (!action || !(action.connectionId || action.workflowId || action.runId)) throw Error("Select a connected action receipt");
      }
      try {
        const result = await ctx.legacyManage(feature, action, input, signal);
        signal?.throwIfAborted(); if (closed) throw Error("Plugin is closing");
        return cleanResult(action === "status" ? scopedStatus(feature, result) : result, hub, ctx);
      } catch (error) {
        throw Error(cleanResult(String(error?.message || "The operation could not finish"), hub, ctx));
      }
    },
    async dispose() { closed = true; if (acquired) await ctx.releaseLegacyFeature?.(feature); },
  };
}
module.exports = { actionPermissions, permissionsFor, scopedStatus, cleanResult, createUi };
