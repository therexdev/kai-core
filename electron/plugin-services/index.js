"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const contracts = require("../../core/lib/plugins/contracts.json");
const firstParty = require("../../core/lib/plugins/first-party.json").plugins;

// Only the matching first-party package can request its private feature scope.
// Third-party packages keep the public local-inference/storage API.
class FeatureServices {
  constructor(ctx, { definitions = contracts, publishers = firstParty } = {}) {
    this.ctx = ctx; this.definitions = definitions; this.publishers = publishers;
    this.services = new Map(); this.lifetimes = new Map(); this.pending = new Set(); this.closing = new Set(); this.closeTasks = new Map(); this.failedDisposals = new Map(); this.stopped = false; this.store = null;
  }
  detachWindow(id) {
    const service = this.services.get(id);
    if (service?.keepAliveOnWindowClose) return Promise.resolve(service.windowClosed?.());
    return this.close(id, { reason: "window" });
  }
  getLegacyRuntime() {
    if (this.stopped) throw Error("Plugin services are closing");
    return this.legacyRuntime ||= require("./legacy-runtime").createLegacyRuntime({ ...this.ctx, getCompanionStore: () => this.getCompanionStore(), featureCall: (id, method, input, signal) => this.featureCall(id, method, input, signal) });
  }
  async featureCall(id, method, input, signal) {
    if (this.stopped || this.closing.has(id)) throw Error("Plugin is closing");
    signal?.throwIfAborted();
    // Native legacy app tools use this internal boundary, never a renderer IPC.
    // Re-verify installation and grants on every call, including background runs.
    const verified = this.ctx.loadInstalledPlugin?.(id);
    if (!verified) throw Error(`Install and enable ${id} to use this action`);
    const record = { ...verified, controller: { signal: signal || new AbortController().signal }, window: this.ctx.getPluginWindow?.(id) || this.ctx.getCoreWindow?.() || this.ctx.getWindow?.(), webContents: this.ctx.getPluginWebContents?.(id) };
    return this.call(record, method, input);
  }
  permission(method) {
    for (const spec of Object.values(this.definitions)) if (Object.hasOwn(spec.permissions, method)) return spec.permissions[method];
    return null;
  }
  getCompanionStore() {
    const file = path.join(this.ctx.dataDir, "companion-hub.json");
    const diskHash = () => {
      let st; try { st = fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
      if (!st.isFile() || st.isSymbolicLink() || st.size > 40 * 1024 * 1024) throw Error("Unsafe companion data; original preserved");
      return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    };
    if (!this.store) {
      for (const candidate of [this.ctx.dataDir, file]) {
        let st; try { st = fs.lstatSync(candidate); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
        if (st.isSymbolicLink() || (candidate === file && (!st.isFile() || st.size > 40 * 1024 * 1024))) throw Error("Saved companion data is unsafe; the original file was preserved");
      }
      this.store = new (require("../companion-store").CompanionStore)({ dataDir: this.ctx.dataDir, safeStorage: this.ctx.electron.safeStorage });
      this.storeDiskHash = diskHash();
      const change = this.store.change.bind(this.store);
      this.store.change = fn => {
        if (diskHash() !== this.storeDiskHash) throw Error("Companion data changed outside Core. Restart before editing; existing data was preserved");
        const result = change(fn); this.storeDiskHash = diskHash(); return result;
      };
    }
    if (diskHash() !== this.storeDiskHash) throw Error("Companion data changed outside Core. Restart to reload it safely");
    this.store.requireStorage(); return this.store;
  }
  serviceFor(record) {
    if (this.stopped || this.closing.has(record.manifest.id)) throw Error("Plugin is closing");
    const id = record.manifest.id, spec = this.definitions[id];
    let service = this.services.get(id);
    if (!service) {
      const module = spec.factory || require("./" + spec.module);
      const lifetime = new AbortController();
      const active = () => { if (this.stopped || lifetime.signal.aborted || this.closing.has(id)) throw Error("Plugin is closing"); };
      service = module.create({ ...this.ctx, manifest: record.manifest,
        featureCall: async (pluginId, method, input, signal) => {
          active(); const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
          const result = await this.featureCall(pluginId, method, input, combined); active(); combined.throwIfAborted(); return result;
        },
        getCompanionStore: () => { active(); return this.getCompanionStore(); },
        getWindow: () => { active(); return this.ctx.getPluginWindow?.(id) || this.ctx.getCoreWindow?.() || record.window; },
        // The native owner is Core for embedded apps, while plugin events and
        // caller checks must still address only that app's isolated renderer.
        getWebContents: () => { active(); return this.ctx.getPluginWebContents ? this.ctx.getPluginWebContents(id) : this.ctx.getPluginWindow?.(id)?.webContents || record.webContents || record.window?.webContents; },
        isVisible: () => { active(); if (this.ctx.isPluginVisible) return this.ctx.isPluginVisible(id); const window = this.ctx.getPluginWindow?.(id) || this.ctx.getCoreWindow?.() || record.window; return !!window && !window.isDestroyed?.() && (!window.isVisible || window.isVisible()) && !window.isMinimized?.(); },
        getLegacyHub: feature => { active(); return this.getLegacyRuntime().getHub(feature); },
        legacyEnsure: feature => { active(); return this.getLegacyRuntime().ensure(feature); },
        legacyManage: (feature, action, input, signal) => { active(); return this.getLegacyRuntime().manage(feature, action, input, signal, { window: this.ctx.getPluginWindow?.(id) || this.ctx.getCoreWindow?.() || record.window }); },
        legacyRequest: (feature, input, signal) => { active(); return this.getLegacyRuntime().request(feature, input, signal, { confirm: this.ctx.confirm }); },
        legacyPoll: (feature, streamId, signal) => { active(); return this.getLegacyRuntime().poll(feature, streamId, signal); },
        legacyCancel: (feature, streamId) => this.legacyRuntime?.cancel(feature, streamId),
        legacyRelease: feature => this.legacyRuntime?.release(feature),
        releaseLegacyFeature: feature => this.legacyRuntime?.release(feature),
        ensureLegacyFeature: feature => { active(); return this.getLegacyRuntime().ensure(feature); },
        confirm: async (title, detail) => { active(); const result = await this.ctx.confirm(title, detail); active(); return result; },
        localInference: async (input, signal) => {
          active(); const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]); combined.throwIfAborted();
          const result = await this.ctx.localInference(input, combined); active(); combined.throwIfAborted(); return result;
        },
      });
      this.services.set(id, service);
      this.lifetimes.set(id, lifetime);
    }
    return service;
  }
  async startInstalledBackground(manager, onlyId = null) {
    this.backgroundErrors ||= new Map();
    const tasks = manager.list().filter(row => row.enabled && (!onlyId || row.id === onlyId)).map(async row => {
      let service;
      try {
        const verified = manager.load(row.id), spec = this.definitions[row.id], publisher = this.publishers.find(p => p.id === row.id);
        if (!spec || !publisher || verified.fingerprint !== publisher.fingerprint || this.stopped || require("../../core/lib/plugins/registry-format").compareVersions(verified.manifest.version, "0.2.0") < 0) return;
        const module = spec.factory || require("./" + spec.module);
        const required = module.backgroundPermissions || [...new Set(Object.values(module.permissions || {}))];
        if (required.some(permission => !verified.manifest.permissions.includes(permission))) return;
        const record = { ...verified, controller: new AbortController(), window: this.ctx.getCoreWindow?.() || this.ctx.getWindow() };
        service = this.serviceFor(record);
        await service.startBackground?.();
        if (this.services.get(row.id) !== service) return;
        this.backgroundErrors.delete(row.id);
      } catch (error) {
        if (service && this.services.get(row.id) !== service) return;
        this.backgroundErrors.set(row.id, String(error.message).slice(0, 400));
        await this.close(row.id).catch(() => {});
      }
    });
    const pending = Promise.allSettled(tasks); this.pending.add(pending);
    try { await pending; } finally { this.pending.delete(pending); }
  }
  async call(record, method, input) {
    if (this.stopped || record.controller.signal.aborted || this.closing.has(record.manifest.id)) throw Error("Plugin is closing");
    const id = record.manifest.id, spec = this.definitions[id];
    const publisher = this.publishers.find(p => p.id === id);
    if (!spec || !Object.hasOwn(spec.permissions, method) || !publisher || publisher.fingerprint !== record.fingerprint || !record.manifest.permissions.includes(spec.permissions[method])) throw Error("Private feature permission denied");
    if (method.startsWith("desktop.")) return this.ctx.desktopCall(record, method, input ?? {});
    const service = this.serviceFor(record);
    const signal = AbortSignal.any([record.controller.signal, this.lifetimes.get(id).signal]);
    const active = () => { if (this.stopped || signal.aborted || this.services.get(id) !== service || this.closing.has(id)) throw Error("Plugin is closing"); };
    const task = Promise.resolve().then(() => { active(); return service.call(method, input ?? {}, signal); });
    this.pending.add(task);
    try { const result = await task; active(); return result; } finally { this.pending.delete(task); }
  }
  close(id, { reason = "disable" } = {}) {
    if (this.closeTasks.has(id)) return this.closeTasks.get(id);
    const failed = this.failedDisposals.get(id);
    const service = this.services.get(id) || failed?.service; if (!service) return Promise.resolve();
    const repeatedShutdown = !!failed && reason === "quit";
    reason = failed?.reason || reason;
    this.lifetimes.get(id)?.abort(); this.lifetimes.delete(id);
    this.services.delete(id); this.closing.add(id);
    const task = Promise.resolve().then(() => service.dispose?.({ reason })).then(() => {
      this.failedDisposals.delete(id); this.closing.delete(id);
    }).catch(async error => {
      // Keep revoked native services available for a real cleanup retry. Losing
      // this reference could let a second disable succeed while a process lives.
      this.failedDisposals.set(id, { service, reason });
      if (!repeatedShutdown) await this.ctx.onDisposeError?.(id, error); throw error;
    }).finally(() => { this.pending.delete(task); this.closeTasks.delete(id); });
    this.closeTasks.set(id, task); this.pending.add(task); return task;
  }
  async privacyChanged(mode) {
    const results = await Promise.allSettled([Promise.resolve().then(() => this.legacyRuntime?.privacyChanged(mode)), ...[...this.services.values()].map(service => Promise.resolve().then(() => service.privacyChanged?.(mode)))]);
    const failed = results.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  async dispose() {
    this.stopped = true;
    await Promise.allSettled([...new Set([...this.services.keys(), ...this.failedDisposals.keys()])].map(id => this.close(id, { reason: "quit" })));
    await Promise.allSettled([...this.pending]); await this.legacyRuntime?.dispose(); this.store = null;
  }
}
module.exports = { FeatureServices };
