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
    const job = { alias, packageId: resolved.packageId, state: "queued", error: null, cancelRequested: false };
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
    // Runtime setup can report a percentage, but it has no safe per-model
    // cancellation boundary. Do not present its global download as cancellable.
    const setup = active && this.runtime._loading?.alias === job.alias ? this.runtime.provisioner?.downloadProgress?.() : null;
    const pct = (progress || setup)?.pct;
    return {
      alias: job.alias,
      state: active ? (progress ? "downloading" : "preparing") : job.state,
      pct: active && typeof pct === "number" && Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : null,
      ...(job.state === "queued" ? { position: this.pending.indexOf(job) + 1 } : {}),
      error: job.error,
      cancellable: job.state === "queued" || (active && !!progress && !job.cancelRequested),
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
      return { cancelled: true, alias: job.alias };
    }
    if (job !== this.current || job.cancelRequested || !this._download(job)) return { cancelled: false, alias: job.alias };
    // Match this job's weights/projector rather than cancelling a voice setup,
    // Alpha migration, or an unrelated model download from another caller.
    const result = this.models.cancelDownload();
    if (result?.cancelled) job.cancelRequested = true;
    return { cancelled: !!result?.cancelled, alias: job.alias };
  }

  _pump() {
    if (this.closed || this.current || !this.pending.length) return;
    const job = this.current = this.pending.shift();
    job.state = "preparing";
    this.onChange(job);
    job.promise = Promise.resolve().then(async () => {
      if (this.closed) throw Error("Core is stopping");
      if (this.models._alphaMigration) throw Error("Wait for Alpha model migration to finish");
      this.models.resolveAlias(job.alias); // recheck revocation before its turn
      await this.runtime.preflight?.();
      // Wait here rather than leaving a request parked inside ensure(): Core
      // may quit while a warm-start or another caller is loading a model.
      // A closed queue must not start its own download when that load settles.
      while (this.runtime._loading && !this.closed) await this.runtime._loading.promise.catch(() => {});
      if (this.closed) throw Error("Core is stopping");
      return this.runtime.ensure(job.alias);
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
