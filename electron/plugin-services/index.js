"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const contracts = require("../../core/lib/plugins/contracts.json");
const firstParty = require("../../core/lib/plugins/first-party.json").plugins;

// Only the matching first-party package can request its private feature scope.
// Third-party packages keep the public local-inference/storage API.
class FeatureServices {
  constructor(ctx, { definitions = contracts, publishers = firstParty } = {}) {
    this.ctx = ctx; this.definitions = definitions; this.publishers = publishers;
    this.services = new Map(); this.lifetimes = new Map(); this.pending = new Set(); this.closing = new Set(); this.closeTasks = new Map(); this.stopped = false; this.store = null;
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
  async call(record, method, input) {
    if (this.stopped || record.controller.signal.aborted || this.closing.has(record.manifest.id)) throw Error("Plugin is closing");
    const id = record.manifest.id, spec = this.definitions[id];
    const publisher = this.publishers.find(p => p.id === id);
    if (!spec || !Object.hasOwn(spec.permissions, method) || !publisher || publisher.fingerprint !== record.fingerprint || !record.manifest.permissions.includes(spec.permissions[method])) throw Error("Private feature permission denied");
    let service = this.services.get(id);
    if (!service) {
      const module = spec.factory || require("./" + spec.module);
      const lifetime = new AbortController();
      const active = () => { if (this.stopped || lifetime.signal.aborted || this.closing.has(id)) throw Error("Plugin is closing"); };
      service = module.create({ ...this.ctx,
        getCompanionStore: () => { active(); return this.getCompanionStore(); },
        getWindow: () => { active(); return record.window; },
        confirm: async (title, detail) => { active(); const result = await this.ctx.confirm(title, detail); active(); return result; },
        localInference: async (input, signal) => {
          active(); const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]); combined.throwIfAborted();
          const result = await this.ctx.localInference(input, combined); active(); combined.throwIfAborted(); return result;
        },
      });
      this.services.set(id, service);
      this.lifetimes.set(id, lifetime);
    }
    const signal = AbortSignal.any([record.controller.signal, this.lifetimes.get(id).signal]);
    const active = () => { if (this.stopped || signal.aborted || this.services.get(id) !== service || this.closing.has(id)) throw Error("Plugin is closing"); };
    const task = Promise.resolve().then(() => { active(); return service.call(method, input ?? {}, signal); });
    this.pending.add(task);
    try { const result = await task; active(); return result; } finally { this.pending.delete(task); }
  }
  close(id) {
    const service = this.services.get(id); if (!service) return this.closeTasks.get(id) || Promise.resolve();
    this.lifetimes.get(id)?.abort(); this.lifetimes.delete(id);
    this.services.delete(id); this.closing.add(id);
    const task = Promise.resolve().then(() => service.dispose?.()).catch(async error => {
      await this.ctx.onDisposeError?.(id, error); throw error;
    }).finally(() => { this.pending.delete(task); this.closing.delete(id); this.closeTasks.delete(id); });
    this.closeTasks.set(id, task); this.pending.add(task); return task;
  }
  async privacyChanged(mode) {
    const results = await Promise.allSettled([...this.services.values()].map(service => Promise.resolve().then(() => service.privacyChanged?.(mode))));
    const failed = results.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  async dispose() {
    this.stopped = true;
    await Promise.allSettled([...this.services.keys()].map(id => this.close(id)));
    await Promise.allSettled([...this.pending]); this.store = null;
  }
}
module.exports = { FeatureServices };
