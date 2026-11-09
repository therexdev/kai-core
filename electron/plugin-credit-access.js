"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function creditBinding(context) {
  const { auth, config } = context;
  if (!auth?.accountId || !auth.owner || !config?.schedulerUrl) throw Error("Credit account is unavailable");
  return hash(["plugin-credits-v1", auth.accountId, auth.owner, config.schedulerUrl, config.deployment, !!auth.sessionOnly, !!auth.deviceFree]);
}
function identity(owner) {
  if (!require("../core/lib/plugins/package").safeId(owner?.pluginId) || !digest(owner.fingerprint) || !digest(owner.accountBinding)) throw Error("Invalid plugin credit identity");
  return hash([owner.pluginId, owner.fingerprint, owner.accountBinding]);
}
function workflow(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !["id", "name"].includes(k)) ||
      typeof value.id !== "string" || !/^[a-zA-Z0-9:._-]{1,180}$/.test(value.id) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 180) throw Error("Supply a workflow run ID and name");
  return { id: value.id, name: value.name };
}
// Core-owned consent, independent of a plugin's preferences. Native code is
// fully trusted; this is the shared SDK's consent/revocation service, not a sandbox.
class PluginCreditAccess {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, "plugin-credit-access.json");
    this.saved = []; this.sessions = new Map(); this.leases = new Set(); this.epochs = new Map(); this.queues = new Map();
    if (fs.existsSync(this.file)) {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error("Invalid credit access file; file preserved");
      let data;
      try { data = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { throw Error("Unreadable credit access file; file preserved"); }
      if (data?.schema !== 1 || !Array.isArray(data.grants) || data.grants.length > 1000 || data.grants.some(row =>
        !row || identity(row) !== row.id || typeof row.name !== "string" || !row.name || row.name.length > 180 || !Number.isSafeInteger(row.grantedAt)) || new Set(data.grants.map(row => row.id)).size !== data.grants.length) throw Error("Invalid credit access file; file preserved");
      this.saved = data.grants;
    }
  }
  save(next) {
    if (next.length > 1000) throw Error("Too many saved credit permissions; revoke unused access in Settings");
    const temp = this.file + "." + crypto.randomUUID() + ".tmp";
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const fd = fs.openSync(temp, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ schema: 1, grants: next }, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.file); this.saved = next;
    } finally { fs.rmSync(temp, { force: true }); }
  }
  list() { return structuredClone(this.saved); }
  status(owner, scope) {
    const id = identity(owner), run = workflow(scope);
    const duration = this.saved.some(row => row.id === id) ? "always" : run && this.sessions.has(id + ":" + run.id) ? "workflow" : null;
    return { allowed: !!duration, duration };
  }
  async acquire(owner, scope, review, signal) {
    const id = identity(owner), run = workflow(scope), epoch = this.epochs.get(id) || 0;
    const prior = this.queues.get(id) || Promise.resolve();
    const task = prior.catch(() => {}).then(async () => {
      const check = () => { signal?.throwIfAborted(); owner.lifetimeSignal?.throwIfAborted(); if ((this.epochs.get(id) || 0) !== epoch) throw Error("Credit access was revoked. Review the next request to continue."); };
      check(); let duration = this.status(owner, run || undefined).duration;
      if (!duration) {
        duration = await review(); check();
        if (!["once", "workflow", "always"].includes(duration) || duration === "workflow" && !run) throw Error("Network request cancelled. No generation was started.");
        if (duration === "always") {
          const row = { id, pluginId: owner.pluginId, fingerprint: owner.fingerprint, accountBinding: owner.accountBinding, name: String(owner.name || owner.pluginId).slice(0, 180), grantedAt: Date.now() };
          this.save([...this.saved.filter(item => item.id !== id), row]);
        } else if (duration === "workflow") {
          const key = id + ":" + run.id;
          const remove = () => { this.sessions.delete(key); owner.lifetimeSignal?.removeEventListener("abort", remove); };
          this.sessions.set(key, { owner, id, runId: run.id, remove });
          owner.lifetimeSignal?.addEventListener("abort", remove, { once: true });
        }
      }
      check();
      const controller = new AbortController();
      const lease = { id, owner, runId: run?.id, duration, signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : []), ...(owner.lifetimeSignal ? [owner.lifetimeSignal] : [])]),
        abort: () => controller.abort(Error("Credit access revoked")), release: () => this.leases.delete(lease) };
      this.leases.add(lease); return lease;
    });
    this.queues.set(id, task);
    try { return await task; } finally { if (this.queues.get(id) === task) this.queues.delete(id); }
  }
  valid(lease) { return this.leases.has(lease) && !lease.signal.aborted; }
  end(owner, runId) {
    for (const session of this.sessions.values()) if (session.owner.pluginId === owner.pluginId && session.owner.fingerprint === owner.fingerprint && session.runId === runId) session.remove();
    for (const lease of this.leases) if (lease.owner.pluginId === owner.pluginId && lease.owner.fingerprint === owner.fingerprint && lease.runId === runId) lease.abort();
    return { ended: true };
  }
  revoke(id) {
    if (!digest(id)) throw Error("Invalid access ID");
    this.save(this.saved.filter(row => row.id !== id));
    this.epochs.set(id, (this.epochs.get(id) || 0) + 1);
    for (const session of this.sessions.values()) if (session.id === id) session.remove();
    for (const lease of this.leases) if (lease.id === id) lease.abort();
    return { revoked: true };
  }
  dispose() { for (const session of this.sessions.values()) session.remove(); for (const lease of this.leases) lease.abort(); this.leases.clear(); }
}
module.exports = { PluginCreditAccess, creditBinding, workflow };
