"use strict";

// Desktop model requests live with Core, so navigating away or closing to the
// tray does not lose their order. Only one request reaches RuntimeManager at a
// time; its existing stream leases still govern when a model may be switched.
class ModelLoadQueue {
  constructor({ models, runtime, onChange = () => {} }) {
    this.models = models;
    this.runtime = runtime;
    this.onChange = onChange;
    this.entries = new Map();
    this.pending = [];
    this.current = null;
    this.closed = false;
  }

  enqueue(alias) {
    if (this.closed) throw Error("Core is stopping");
    if (this.models._alphaMigration) throw Error("Wait for Alpha model migration to finish");
    const resolved = this.models.resolveAlias(alias);
    const existing = this.entries.get(alias);
    if (existing === this.current || this.pending.includes(existing)) return { duplicate: true, job: this._snapshot(existing) };
    const job = { alias, packageId: resolved.packageId, kind: resolved.runtime || "llamacpp", state: "queued", error: null, cancelRequested: false, controller: new AbortController() };
    this.entries.set(alias, job);
    this.pending.push(job);
    this._pump();
    return { duplicate: false, job: this._snapshot(job) };
  }

  _download(job) {
    const progress = this.models.downloadProgress?.();
    return progress && (progress.packageId === job.packageId || progress.packageId === `${job.packageId}#mmproj`) ? progress : null;
  }

  _snapshot(job) {
    const active = this.current === job;
    const progress = active ? this._download(job) : null;
    const runtime = this.runtime.status?.() || {};
    const loadingAlias = runtime.loadingAlias ?? this.runtime._loading?.alias;
    const currentSetup = active && loadingAlias === job.alias ? this.runtime.provisioner?.downloadProgress?.() : null;
    const setup = currentSetup?.kind === job.kind ? currentSetup : null;
    const stage = progress ? progress.phase === "verifying" ? "verifying" : "downloading"
      : setup?.phase === "extracting" ? "extracting"
      : setup?.phase === "verifying" ? "verifying-engine"
      : setup?.phase === "downloading" ? "engine-download"
      : loadingAlias && loadingAlias !== job.alias ? "waiting"
      : runtime.loadingStage || "preparing";
    const pct = (progress || setup)?.pct;
    return {
      alias: job.alias,
      state: active ? (stage === "downloading" ? "downloading" : "preparing") : job.state,
      ...(active ? { stage, elapsedMs: Math.max(0, Date.now() - job.startedAt), cancelling: job.cancelRequested } : {}),
      pct: active && typeof pct === "number" && Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : null,
      ...(job.state === "queued" ? { position: this.pending.indexOf(job) + 1 } : {}),
      error: job.error,
      cancellable: job.state === "queued" || (active && !job.cancelRequested),
    };
  }

  snapshot() { return [...this.entries.values()].map(job => this._snapshot(job)); }

  cancel(alias) {
    const job = alias ? this.entries.get(alias) : this.current;
    if (!job) return { cancelled: false };
    const index = this.pending.indexOf(job);
    if (index !== -1) {
      this.pending.splice(index, 1);
      job.state = "cancelled";
      job.controller.abort(); this.onChange(job);
      return { cancelled: true, alias: job.alias };
    }
    if (job !== this.current || job.cancelRequested) return { cancelled: false, alias: job.alias };
    // RuntimeManager releases this request's interest in the load. Shared
    // callers keep their work; the final owner cancels download/setup/start.
    job.cancelRequested = true;
    job.controller.abort(new DOMException("Model preparation cancelled", "AbortError"));
    this.onChange(job);
    return { cancelled: true, alias: job.alias };
  }

  _pump() {
    if (this.closed || this.current || !this.pending.length) return;
    const job = this.current = this.pending.shift();
    job.state = "preparing";
    job.startedAt = Date.now();
    this.onChange(job);
    job.promise = Promise.resolve().then(async () => {
      if (this.closed) throw Error("Core is stopping");
      if (this.models._alphaMigration) throw Error("Wait for Alpha model migration to finish");
      job.controller.signal.throwIfAborted();
      this.models.resolveAlias(job.alias); // recheck revocation before its turn
      await this.runtime.preflight?.({ signal: job.controller.signal });
      job.controller.signal.throwIfAborted();
      if (this.closed) throw Error("Core is stopping");
      return this.runtime.ensure(job.alias, { signal: job.controller.signal });
    }).then(() => {
      job.state = job.cancelRequested || this.closed ? "cancelled" : "done";
    }, error => {
      job.state = job.cancelRequested || this.closed ? "cancelled" : "error";
      if (job.state === "error") job.error = String(error?.message || error);
    }).finally(() => {
      this.current = null;
      this.onChange(job);
      this._pump();
    });
  }

  close() {
    this.closed = true;
    for (const job of this.pending.splice(0)) job.state = "cancelled";
    if (this.current) this.cancel(this.current.alias);
  }
}

module.exports = { ModelLoadQueue };
