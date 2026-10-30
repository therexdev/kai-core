"use strict";
const path = require("node:path"), fs = require("node:fs"), Module = require("node:module");
const { AsyncLocalStorage } = require("node:async_hooks");
const MAX_CALL_BYTES = 24 * 1024 * 1024;
const validMethod = value => typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,159}$/.test(value);
const clone = value => value === undefined ? null : structuredClone(value);
function bounded(value) {
  const json = JSON.stringify(value ?? null); if (json === undefined || Buffer.byteLength(json) > MAX_CALL_BYTES) throw Error("Plugin service payload is too large");
  return clone(value);
}

// This loader enforces package dependency ownership, not security isolation.
// Native code has full Electron/Node authority and is explicitly trusted.
function loadNative(entry, root) {
  const cache = new Map(), realRoot = fs.realpathSync(root), builtins = new Set(Module.builtinModules.flatMap(name => [name, name.replace(/^node:/, ""), `node:${name.replace(/^node:/, "")}`]));
  const inRoot = filename => filename === realRoot || filename.startsWith(realRoot + path.sep);
  function load(request, parent) {
    if (request === "electron" || builtins.has(request)) return require(request);
    const filename = Module._resolveFilename(request, parent);
    const real = fs.realpathSync(filename);
    if (!inRoot(real)) throw Error(`Plugin dependency must be bundled in its signed package: ${request}`);
    if (cache.has(real)) return cache.get(real).exports;
    if (path.extname(real) === ".mjs") return require(real);
    const child = new Module(real, parent); child.filename = real; child.paths = Module._nodeModulePaths(path.dirname(real));
    child.require = specifier => load(specifier, child); cache.set(real, child);
    try {
      if (path.extname(real) === ".json") child.exports = JSON.parse(fs.readFileSync(real, "utf8"));
      else if (path.extname(real) === ".node") Module._extensions[".node"](child, real);
      else child._compile(fs.readFileSync(real, "utf8"), real);
      child.loaded = true; return child.exports;
    } catch (error) { cache.delete(real); throw error; }
  }
  const parent = new Module(path.join(realRoot, "service-entry.js")); parent.paths = Module._nodeModulePaths(realRoot);
  return { exports: load(entry, parent), dispose() { cache.clear(); for (const filename of Object.keys(require.cache)) if (inRoot(filename)) delete require.cache[filename]; } };
}

class FoundationPluginServices {
  constructor({ manager, createApi, onDisposeError = async () => {}, onError = () => {} }) {
    if (!manager || typeof createApi !== "function") throw Error("Plugin manager and public API factory are required");
    Object.assign(this, { manager, createApi, onDisposeError, onError });
    this.services = new Map(); this.records = new Map(); this.starting = new Map(); this.closeTasks = new Map(); this.backgroundErrors = new Map(); this.exports = new Map(); this.pending = new Set(); this.closing = new Set(); this.stopped = false;
    this.execution = new AsyncLocalStorage();
  }
  permission() { return null; } // Native UI method names belong to the plugin.
  active(record) { if (this.stopped || record.controller.signal.aborted || this.closing.has(record.manifest.id) || this.records.get(record.manifest.id) !== record) throw Error("Plugin is closing"); }
  serviceAPI(record) {
    const permits = permission => { this.active(record); if (!record.manifest.permissions.includes(permission)) throw Error(`Plugin permission required: ${permission}`); };
    return Object.freeze({
      provide: (name, definition) => {
        permits("services.provide");
        if (!record.manifest.provides?.includes(name) || !definition || !Array.isArray(definition.methods) || !definition.methods.length || definition.methods.length > 256 || definition.methods.some(method => !validMethod(method)) || new Set(definition.methods).size !== definition.methods.length || typeof definition.call !== "function") throw Error("Invalid or undeclared plugin service");
        if (this.exports.has(name)) throw Error(`Service already provided: ${name}`);
        const exported = { owner: record.manifest.id, record, methods: new Set(definition.methods), call: definition.call };
        this.exports.set(name, exported);
        return () => { if (this.exports.get(name) === exported) this.exports.delete(name); };
      },
      call: async (name, method, input, options = {}) => {
        permits("services.call");
        if (!record.manifest.consumes?.includes(name) || !validMethod(method)) throw Error("Plugin service use is not declared");
        if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => key !== "signal")) throw Error("Remote or delegated service contexts are not supported");
        const inherited = this.execution.getStore();
        if (inherited?.remote) throw Error("Remote jobs cannot call local plugin services");
        if ((inherited?.chain?.length || 0) >= 16 || inherited?.chain?.includes(name)) throw Error("Plugin service dependency cycle");
        const chain = [...(inherited?.chain || []), name];
        return this.execution.run({ remote: false, signal: inherited?.signal, chain, initiator: inherited?.initiator }, async () => {
          let exported = this.exports.get(name);
          if (!exported) {
            const candidates = this.manager.list().filter(row => row.enabled && row.provides?.includes(name));
            if (candidates.length > 1) throw Error(`Multiple plugins provide ${name}; enable one provider`);
            if (!candidates.length) throw Error(`Install and enable a plugin providing ${name}`);
            await this.ensure(candidates[0].id); exported = this.exports.get(name);
          }
          this.active(record);
          if (!exported || !exported.methods.has(method)) throw Error(`Service method unavailable: ${name}.${method}`);
          this.active(exported.record);
          const signal = AbortSignal.any([record.controller.signal, exported.record.controller.signal, ...(options.signal ? [options.signal] : []), ...(inherited?.signal ? [inherited.signal] : [])]); signal.throwIfAborted();
          const context = Object.freeze({ caller: record.manifest.id, remote: false, signal });
          const payload = bounded(input);
          const task = this.execution.run({ remote: false, signal, chain, initiator: inherited?.initiator }, () => Promise.resolve().then(() => exported.call(method, payload, context)));
          this.pending.add(task);
          try { const output = await task; signal.throwIfAborted(); this.active(record); this.active(exported.record); return bounded(output); } finally { this.pending.delete(task); }
        });
      },
    });
  }
  async verifiedForUI(id) {
    const row = this.manager.state.installed[id];
    // Native runtime and UI share one immutable verified package snapshot.
    // Large native assets must not be parsed into a second retained copy.
    return row?.runtime === "native" ? this.ensure(id) : this.manager.load(id);
  }
  async ensure(id) {
    if (this.stopped || this.closing.has(id)) throw Error("Plugin is closing");
    const running = this.records.get(id);
    if (running) {
      this.manager.assertActive(id, running.digest, running.fingerprint);
      const pending = this.starting.get(id); if (pending) await pending;
      this.active(running); return running;
    }
    if (this.starting.has(id)) return this.starting.get(id);
    const verified = this.manager.materialize(id);
    if (verified.manifest.runtime !== "native") throw Error("This plugin has no native service");
    const record = { ...verified, controller: new AbortController(), service: null, loader: null, cleanup: [] };
    record.invocation = () => this.execution.getStore()?.initiator || null;
    this.records.set(id, record);
    const start = Promise.resolve().then(async () => {
      this.active(record);
      const api = await this.createApi(record);
      this.active(record);
      record.api = Object.freeze({ ...api, version: 1, plugin: Object.freeze({ id, version: record.manifest.version, root: record.root, dataDir: record.dataDir }), signal: record.controller.signal, services: this.serviceAPI(record) });
      record.loader = loadNative(path.join(record.root, record.manifest.service), record.root);
      if (typeof record.loader.exports?.create !== "function") throw Error("Plugin service must export create(api)");
      record.service = await record.loader.exports.create(record.api);
      if (!record.service || typeof record.service.call !== "function") throw Error("Plugin service must implement call(method, input, signal)");
      this.active(record); this.services.set(id, record.service); this.backgroundErrors.delete(id); return record;
    }).catch(async error => {
      record.controller.abort(error); this.removeExports(record); this.services.delete(id);
      try { await this.cleanupRecord(record, "startup-error"); if (this.records.get(id) === record) this.records.delete(id); }
      catch (cleanupError) { this.onError(id, cleanupError); }
      throw error;
    }).finally(() => { if (this.starting.get(id) === start) this.starting.delete(id); });
    this.starting.set(id, start); return start;
  }
  async call(rendererRecord, method, input) {
    if (!validMethod(method)) throw Error("Invalid plugin method");
    const id = rendererRecord.manifest.id, record = await this.ensure(id);
    if (rendererRecord.manifest.version !== record.manifest.version || rendererRecord.fingerprint !== record.fingerprint) throw Error("Plugin interface is out of date; reopen it");
    const signal = AbortSignal.any([record.controller.signal, ...(rendererRecord.controller?.signal ? [rendererRecord.controller.signal] : [])]); signal.throwIfAborted();
    const wc = rendererRecord.webContents, frame = wc?.mainFrame;
    const initiator = wc && frame && frame.url === rendererRecord.entry ? Object.freeze({ id, name: record.manifest.name, fingerprint: record.fingerprint, permissions: Object.freeze([...record.manifest.permissions]), webContents: wc, frame, entry: rendererRecord.entry, signal }) : null;
    const task = this.execution.run({ remote: false, signal, chain: [], initiator }, () => Promise.resolve().then(() => record.service.call(method, bounded(input), signal))); this.pending.add(task);
    try { const output = await task; signal.throwIfAborted(); this.active(record); return bounded(output); } finally { this.pending.delete(task); }
  }
  async startInstalledBackground(manager = this.manager, onlyId = null) {
    await Promise.allSettled(manager.list().filter(row => row.enabled && row.runtime === "native" && (!onlyId || row.id === onlyId)).map(async row => {
      try { const record = await this.ensure(row.id); this.active(record); record.backgroundTask ||= Promise.resolve().then(() => { this.active(record); return record.service.startBackground?.(); }); await record.backgroundTask; this.active(record); }
      catch (error) { this.backgroundErrors.set(row.id, String(error.message).slice(0, 500)); this.onError(row.id, error); await this.close(row.id, { reason: "startup-error" }).catch(() => {}); }
    }));
  }
  removeExports(record) { for (const [name, exported] of this.exports) if (exported.record === record) this.exports.delete(name); }
  detachWindow(id) { return Promise.resolve(this.services.get(id)?.windowClosed?.()); }
  cleanupRecord(record, reason) {
    if (record.cleanupTask) return record.cleanupTask;
    const task = Promise.resolve().then(async () => {
      const errors = [];
      try { await record.service?.dispose?.({ reason }); } catch (error) { errors.push(error); }
      try { await record.api?.dispose?.(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, `Plugin ${record.manifest.id} could not completely stop`);
      record.loader?.dispose(); record.dispose?.();
    });
    record.cleanupTask = task;
    void task.catch(() => { if (record.cleanupTask === task) record.cleanupTask = null; });
    return task;
  }
  close(id, { reason = "disable" } = {}) {
    if (this.closeTasks.has(id)) return this.closeTasks.get(id);
    const record = this.records.get(id); if (!record) return Promise.resolve();
    this.closing.add(id); record.controller.abort(Error("Plugin stopped")); this.removeExports(record);
    const task = (async () => {
      await this.starting.get(id)?.catch(() => {});
      try {
        await this.cleanupRecord(record, reason); this.services.delete(id);
        if (this.records.get(id) === record) this.records.delete(id);
      } catch (error) { this.services.delete(id); await this.onDisposeError(id, error); throw error; }
    })().finally(() => { this.closing.delete(id); this.closeTasks.delete(id); });
    this.closeTasks.set(id, task); return task;
  }
  async privacyChanged(mode) {
    const results = await Promise.allSettled([...this.services.values()].map(service => service.privacyChanged?.(mode)));
    const failure = results.find(result => result.status === "rejected"); if (failure) throw failure.reason;
  }
  async dispose() {
    this.stopped = true;
    const results = await Promise.allSettled([...this.records.keys()].map(id => this.close(id, { reason: "quit" })));
    this.exports.clear();
    const failures = results.filter(result => result.status === "rejected"); if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Some plugin services could not stop");
  }
}
module.exports = { FoundationPluginServices, loadNative, MAX_CALL_BYTES };
