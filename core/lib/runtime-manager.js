"use strict";

/*
 * Runtime manager (spec §4/§6): owns which model is loaded on which runtime.
 * M1 scope: one active runtime + one loaded model at a time; the gateway
 * asks ensure(alias) before proxying. Switching models stops the current
 * runtime and starts the requested one.
 */

// Package-specific defaults affect only the selected model, never other catalog
// models or user-selected GPU/memory flags. A zero reasoning budget ensures the
// lightweight chat model returns an answer within Core's output-token limit.
// Its reasoning parser stays enabled so the forced end-of-thinking token is
// separated from visible answer text, rather than leaking into the chat.
function generationArgs(options) {
  if (!options) return [];
  const args = [];
  const number = (key, flag, min, max, integer = false) => {
    if (options[key] === undefined) return;
    const value = options[key];
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`Invalid model generation setting: ${key}`);
    args.push(flag, String(value));
  };
  number("temperature", "--temp", 0, 2);
  number("topK", "--top-k", 0, 1000, true);
  number("repeatPenalty", "--repeat-penalty", 0, 3);
  number("reasoningBudget", "--reasoning-budget", -1, 32768, true);
  if (options.reasoning !== undefined) {
    if (!["on", "off", "auto"].includes(options.reasoning)) throw new Error("Invalid model reasoning setting");
    args.push("--reasoning", options.reasoning);
  }
  if (options.reasoningFormat !== undefined) {
    if (!["none", "deepseek", "deepseek-legacy"].includes(options.reasoningFormat)) throw new Error("Invalid model reasoning format");
    args.push("--reasoning-format", options.reasoningFormat);
  }
  return args;
}

// Waiting for one consumer must not cancel work still owned by another.
function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const clean = () => signal.removeEventListener("abort", abort);
    const abort = () => { clean(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(value => { clean(); resolve(value); }, error => { clean(); reject(error); });
    if (signal.aborted) abort();
  });
}

class RuntimeManager {
  constructor({ models, makeRuntime, hardware, provisioner, makeFallback, preferFallback, onEvent, state }) {
    this.models = models; // ModelManager
    this.makeRuntime = makeRuntime; // (binPath|null) => runtime adapter instance
    this.hardware = hardware; // detection snapshot (may be null in tests)
    this.provisioner = provisioner || null; // RuntimeProvisioner (null when a bin is forced)
    this.makeFallback = makeFallback || null; // async () => alt runtime (e.g. Ollama) or null
    this.preferFallback = !!preferFallback; // KAI_RUNTIME override: skip llama.cpp entirely
    this.onEvent = onEvent || (() => {});
    this.state = state || null; // JsonStore: remembers builds that crash on THIS machine
    this.appVersion = arguments[0]?.appVersion || null; // scopes that memory to one app version
    this.runtime = null;
    this.activeAlias = null;
    this._loading = null; // in-flight ensure() promise
    this._stopped = false; // stop() raced against an in-flight load
    this._testedBins = new Set(); // self-test once per binary per session
    this._failedTests = new Map(); // binPath -> error message: a crash is remembered, never re-run
    this._llamaDead = false; // full ladder failure this session: go straight to the fallback
    this._inflight = 0; // generations currently streaming from the active runtime
    this._drainWaiters = []; // switches parked until the count reaches zero
    this.drainMaxMs = 120000; // a switch never waits longer than this on a stream
    this._networkWork = 0;
    this._localCheckRequests = 0;
    this._localCheckActive = false;
    this._admissionWaiters = new Set();
    this._networkPauseListeners = new Set();
    this._generationQueue = [];
    this._generationActive = null;
    this._stopEpoch = 0;
  }

  /** Name the active runtime serves the model under (null = passthrough). */
  servedModelName() {
    return this.runtime?.servedName?.() ?? null;
  }

  /** True while anything is streaming from the engine or a model is
   *  mid-load. The load guard reads this for attribution: GPU activity
   *  during our own work is ours, and never a reason to back off. */
  busy() {
    return this._inflight > 0 || !!this._loading;
  }

  networkWorkPaused() { return this._localCheckRequests > 0; }

  onNetworkWorkPause(listener) {
    this._networkPauseListeners.add(listener);
    return () => this._networkPauseListeners.delete(listener);
  }

  _notifyNetworkPause() {
    for (const listener of this._networkPauseListeners) { try { listener(); } catch {} }
  }

  _wakeAdmissions() { for (const wake of [...this._admissionWaiters]) wake(); }

  async _waitAdmission(ready, signal) {
    signal?.throwIfAborted();
    while (!ready()) {
      await new Promise((resolve, reject) => {
        const clean = () => { this._admissionWaiters.delete(wake); signal?.removeEventListener("abort", aborted); };
        const wake = () => { clean(); resolve(); };
        const aborted = () => { clean(); reject(signal.reason); };
        this._admissionWaiters.add(wake);
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) aborted();
      });
      signal?.throwIfAborted();
    }
  }

  // Admission covers the poll AND any assigned job through its signed result.
  // A diagnostic must not abort a poll whose response may already contain work.
  async acquireNetworkWork(signal) {
    do {
      await this._waitAdmission(() => !this.networkWorkPaused(), signal);
      signal?.throwIfAborted();
    } while (this.networkWorkPaused());
    this._networkWork++;
    let released = false;
    return { release: () => {
      if (released) return;
      released = true; this._networkWork--; this._wakeAdmissions();
    } };
  }

  async pauseNetworkWork(signal) {
    signal?.throwIfAborted();
    this._localCheckRequests++;
    if (this._localCheckRequests === 1) this._notifyNetworkPause();
    const finished = () => {
      this._localCheckRequests--; this._wakeAdmissions();
      if (!this._localCheckRequests) this._notifyNetworkPause();
    };
    try {
      do {
        await this._waitAdmission(() => !this._networkWork && !this._localCheckActive, signal);
        signal?.throwIfAborted();
      } while (this._networkWork || this._localCheckActive);
      this._localCheckActive = true;
    } catch (error) { finished(); throw error; }
    let released = false;
    return { release: () => {
      if (released) return;
      released = true; this._localCheckActive = false; finished();
    } };
  }

  status() {
    return {
      activeAlias: this.activeAlias,
      loading: !!this._loading,
      loadingAlias: this._loading?.alias || null,
      loadingStage: this._loading?.stage || null,
      inference: { activeAlias: this._generationActive?.alias || null, queued: this._generationQueue.length },
      runtime: this.runtime ? this.runtime.status() : null,
      // Why the last load failed (null after a success) — the UI shows
      // this instead of a bare "Model load failed" nobody can act on.
      lastLoadError: this.lastLoadError || null,
    };
  }

  /** Endpoint of the healthy runtime serving `alias`, starting it if needed. */
  /** Can ANY engine run on this machine? Called before big downloads so a
   *  platform with no managed build (today: Linux without Ollama) fails in
   *  plain language up front instead of after a gigabyte. A forced binary
   *  or a working fallback engine counts as viable. */
  async preflight({ signal } = {}) {
    signal?.throwIfAborted();
    if (!this.provisioner) return; // forced binary (KAI_LLAMA_BIN) — viable
    try {
      this.provisioner.selectBuild("llamacpp");
      return;
    } catch {
      /* no managed build — check the fallback before refusing */
    }
    if (this.makeFallback) {
      const fallback = await Promise.resolve(this.makeFallback({ signal })).catch(() => {
        signal?.throwIfAborted();
        return null;
      });
      signal?.throwIfAborted();
      if (fallback) return;
    }
    throw new Error(
      process.platform === "linux"
        ? "Koinos AI on Linux currently needs Ollama installed (free, from ollama.com) — install it and relaunch, and Koinos AI will use it as the engine."
        : "No AI engine build is available for this machine yet — check for an app update, or install Ollama (ollama.com) as a fallback engine."
    );
  }

  async ensure(alias, { signal } = {}) {
    const epoch = this._stopEpoch;
    this._assertDemand(epoch, signal);
    this._stopped = false; // new demand revives the manager
    try { this.models.resolveAlias(alias); }
    catch (error) {
      if (this.activeAlias === alias && this.runtime?.status().running) this.stop();
      throw error;
    }
    // A cancelled caller can leave the queue immediately. It must not start
    // an orphan model load when the preceding model eventually becomes ready.
    for (;;) {
      this._assertDemand(epoch, signal);
      const loading = this._loading;
      if (!loading) break;
      if (loading.alias === alias && !loading.controller.signal.aborted) return this._joinLoad(loading, signal);
      await waitWithSignal(loading.promise.catch(() => {}), signal);
    }
    this._assertDemand(epoch, signal);
    if (this.activeAlias === alias && this.runtime?.status().running) return this.runtime.endpoint;
    const loading = { alias, stage: "waiting", controller: new AbortController(), waiters: new Set(), settled: false };
    this._loading = loading;
    loading.promise = Promise.resolve().then(() => this._load(alias, loading.controller.signal)).finally(() => {
      loading.settled = true;
      if (this._loading === loading) this._loading = null;
    });
    return this._joinLoad(loading, signal);
  }

  _assertDemand(epoch, signal) {
    signal?.throwIfAborted();
    if (epoch !== this._stopEpoch) throw new DOMException("Local model request stopped", "AbortError");
  }

  _joinLoad(loading, signal) {
    const owner = {};
    loading.waiters.add(owner);
    return waitWithSignal(loading.promise, signal).finally(() => {
      loading.waiters.delete(owner);
      if (!loading.settled && !loading.waiters.size) loading.controller.abort(new DOMException("Model preparation cancelled", "AbortError"));
    });
  }

  _loadStage(signal, stage) {
    signal?.throwIfAborted();
    if (this._loading?.controller.signal === signal) this._loading.stage = stage;
  }

  _pumpGenerations() {
    if (this._generationActive || this._inflight || !this._generationQueue.length) return;
    const next = this._generationQueue.shift();
    next.signal?.removeEventListener("abort", next.abort);
    this._generationActive = next;
    next.resolve(() => {
      if (this._generationActive !== next) return;
      this._generationActive = null;
      this._pumpGenerations();
    });
  }

  _generationSlot(alias, signal) {
    signal?.throwIfAborted();
    if (this._generationQueue.length >= 64) throw Object.assign(Error("The local model queue is full. Stop an existing request or try again shortly."), { code: "runtime_busy" });
    return new Promise((resolve, reject) => {
      const entry = { alias, signal, resolve, reject, abort: null };
      entry.abort = () => {
        const index = this._generationQueue.indexOf(entry);
        if (index < 0) return;
        this._generationQueue.splice(index, 1);
        signal.removeEventListener("abort", entry.abort);
        reject(signal.reason);
        this._pumpGenerations();
      };
      this._generationQueue.push(entry);
      signal?.addEventListener("abort", entry.abort, { once: true });
      if (signal?.aborted) entry.abort();
      this._pumpGenerations();
    });
  }

  /** One local generation at a time, in request order. A second plugin cannot
   * consume the first request's memory/compute or repeatedly switch its model. */
  async acquireFor(alias, { signal } = {}) {
    const epoch = this._stopEpoch;
    const releaseSlot = await this._generationSlot(alias, signal);
    try {
      for (;;) {
        this._assertDemand(epoch, signal);
        const endpoint = await this.ensure(alias, { signal });
        this._assertDemand(epoch, signal);
        if (this.activeAlias !== alias || !this.runtime?.status().running) continue;
        this._inflight += 1;
        let done = false;
        return { endpoint, release: () => {
          if (done) return;
          done = true;
          this._inflight = Math.max(0, this._inflight - 1);
          if (!this._inflight) for (const wake of this._drainWaiters.splice(0)) wake();
          releaseSlot();
        } };
      }
    } catch (error) { releaseSlot(); throw error; }
  }

  // Local evidence collection observes the existing process only. It must not
  // download, reload or switch models after a stale status observation.
  acquireCurrent(alias) {
    this.models.resolveAlias(alias);
    if (this._loading || this._generationActive || this._generationQueue.length || this._inflight || this.activeAlias !== alias || !this.runtime?.status().running) throw new Error("The current model changed before the local check started");
    this._inflight += 1;
    let released = false;
    return { endpoint: this.runtime.endpoint, release: () => {
      if (released) return;
      released = true;
      this._inflight = Math.max(0, this._inflight - 1);
      if (!this._inflight) for (const waiter of this._drainWaiters.splice(0)) waiter();
      this._pumpGenerations();
    } };
  }

  /** A slow answer keeps its engine. A waiting model switch can be cancelled
   * or fail clearly; it must never kill someone else's active generation. */
  async _drain(signal) {
    signal?.throwIfAborted();
    if (this._inflight <= 0) return;
    this.onEvent({ type: "runtime:draining", inflight: this._inflight });
    await new Promise((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        const index = this._drainWaiters.indexOf(done);
        if (index >= 0) this._drainWaiters.splice(index, 1);
      };
      const done = () => { clean(); resolve(); };
      const abort = () => { clean(); reject(signal.reason); };
      const timer = setTimeout(() => {
        clean(); reject(Object.assign(Error("Another local model request is still running. Let it finish or stop it before loading a different model."), { code: "runtime_busy" }));
      }, this.drainMaxMs);
      this._drainWaiters.push(done);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  async _load(alias, signal) {
    signal?.throwIfAborted();
    await this._runtimeStopPromise;
    signal?.throwIfAborted();
    const resolved = this.models.resolveAlias(alias);
    const fallbackAllowed = resolved.allowFallback !== false;
    if (this.preferFallback && !fallbackAllowed) {
      throw new Error("This model requires KAI’s managed llama.cpp engine. Turn off the forced Ollama runtime to load it.");
    }
    this._loadStage(signal, "downloading");
    const modelPath = await this.models.ensurePackage(resolved.packageId, { signal });
    signal?.throwIfAborted();
    const kind = resolved.runtime || "llamacpp";
    const wantGpu = !!this.hardware?.capabilities?.cudaEligible;

    // Fast switch on a llama-dead machine: the fallback daemon hosts every
    // model — register the next one with it and serve. Without this, EVERY
    // model switch re-ran the full crash-test ladder (field log: switches
    // every few seconds, each one a blocking multi-second freeze that
    // starved the worker's own presence signals while jobs kept serving).
    if (fallbackAllowed && this._llamaDead && this.runtime?.status().kind === "ollama" && this.runtime.status().running) {
      const rt = this.runtime;
      let switching = false;
      try {
        // A queued switch must preserve the model name held by an active
        // caller, just as switching the managed engine waits for its leases.
        this._loadStage(signal, "waiting");
        await this._drain(signal);
        signal?.throwIfAborted();
        this.onEvent({ type: "runtime:fast-switch", from: this.activeAlias, to: alias, via: "ollama" });
        const modelName = `koinos-${alias}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
        this._loadStage(signal, "starting");
        switching = true;
        await rt.start({ modelPath, sha256: resolved.sha256, modelName, signal });
        signal?.throwIfAborted();
        if (this._stopped) {
          this.stop();
          throw new Error("Core is stopping");
        }
        this.activeAlias = alias;
        this.lastLoadError = null;
        return rt.endpoint;
      } catch (e) {
        if (signal?.aborted && switching) { await rt.stop(); if (this.runtime === rt) { this.runtime = null; this.activeAlias = null; } }
        signal?.throwIfAborted();
        if (this._stopped || e.code === "runtime_busy") throw e;
        // The daemon died under us: fall through to the full path, which
        // rebuilds the fallback from scratch. That path is instant now —
        // every crashing binary is cached, nothing re-tests.
        this.onEvent({ type: "runtime:fast-switch-failed", reason: String(e.message) });
      }
    }

    if (this.runtime) {
      // Let whatever is still streaming from this engine finish first —
      // stopping it here is what cut answers off mid-sentence.
      this._loadStage(signal, "waiting");
      await this._drain(signal);
      signal?.throwIfAborted();
      this.onEvent({ type: "runtime:switching", from: this.activeAlias, to: alias });
      await this.runtime.stop();
      signal?.throwIfAborted();
      this.runtime = null;
      this.activeAlias = null;
    }

    // Escalation ladder (§5: never strand the user): CUDA/Vulkan/Metal when
    // eligible -> CPU build -> external fallback runtime (Ollama) when one
    // is present. Every provisioned binary passes a self-test before boot,
    // so a build this machine can't run fails fast and quietly moves on.
    const { selfTest, stripCpuVariants, dirSnapshot } = require("./runtimes/llamacpp");
    // Self-test with an escalating heal ladder: the plain test (which
    // internally heals a stale CRT), then a fresh re-extract of the build
    // (corrupted extraction), then stripping exotic ggml-cpu variant DLLs
    // (dispatch crashes on very new CPUs). Whatever still fails reports
    // with a directory snapshot — remote debugging needs to see the disk.
    this._healed = this._healed || new Set();
    const testHard = async (binPath, cap) => {
      // A binary that crashed its self-test crashes it again 10 seconds
      // later — the test can burn 15s per attempt, and field log showed it
      // re-running on EVERY model switch, several times a minute. Cache the
      // verdict; the test itself is async so even a slow probe no longer
      // starves polls, heartbeats, or timers.
      if (this._failedTests.has(binPath)) {
        throw new Error(`${this._failedTests.get(binPath)} (cached — not re-tested this session)`);
      }
      try {
        try {
          return await selfTest(binPath, { signal });
        } catch (e1) {
          signal?.throwIfAborted();
          if (typeof this.provisioner?.reprovision !== "function" || this._healed.has(binPath)) {
            throw new Error(`${e1.message} [beside: ${dirSnapshot(binPath)}]`);
          }
          this._healed.add(binPath);
          this.onEvent({ type: "runtime:heal", step: "reprovision", binPath, reason: String(e1.message) });
          await this.provisioner.reprovision(kind, { cap, signal });
          try {
            return await selfTest(binPath, { signal });
          } catch (e2) {
            signal?.throwIfAborted();
            if (stripCpuVariants(binPath)) {
              this.onEvent({ type: "runtime:heal", step: "strip-cpu-variants", binPath });
              try {
                return await selfTest(binPath, { signal });
              } catch (e3) {
                signal?.throwIfAborted();
                throw new Error(`${e3.message} [after reprovision + variant strip; beside: ${dirSnapshot(binPath)}]`);
              }
            }
            throw new Error(`${e2.message} [after reprovision; beside: ${dirSnapshot(binPath)}]`);
          }
        }
      } catch (terminal) {
        signal?.throwIfAborted();
        this._failedTests.set(binPath, String(terminal.message).slice(0, 600));
        throw terminal;
      }
    };
    // Vision packages ship a projector file; llama-server takes it as
    // --mmproj and then accepts OpenAI-style image_url content parts.
    // Projector trouble (unpinned, download failed) must never take TEXT
    // serving down with it — degrade to text-only and say so.
    let mmprojPath = null;
    if (resolved.vision && resolved.mmproj) {
      try {
        mmprojPath = await this.models.ensureMmproj(resolved.packageId, { signal });
      } catch (e) {
        // Cancelling a projector download cancels the requested load too.
        if (e?.name === "AbortError" || e?.code === "ABORT_ERR") throw e;
        this.onEvent?.({ type: "runtime:vision-degraded", alias, message: String(e.message).slice(0, 200) });
      }
    }
    const boot = async (binPath, gpuLayers, cap) => {
      this._loadStage(signal, "testing");
      if (binPath && !this._testedBins.has(binPath)) {
        await testHard(binPath, cap);
        this._testedBins.add(binPath);
      }
      const runtime = this.makeRuntime(binPath);
      this._loadStage(signal, "starting");
      try { await runtime.start({
        modelPath,
        contextSize: resolved.contextSize || 4096,
        gpuLayers,
        sizeBytes: resolved.sizeBytes || 0,
        signal,
        extraArgs: [...(mmprojPath ? ["--mmproj", mmprojPath] : []), ...generationArgs(resolved.generation)],
      }); signal?.throwIfAborted(); }
      catch (error) { await runtime.stop(); throw error; }
      return runtime;
    };

    const bootLlama = async () => {
      if (!this.provisioner) return boot(null, wantGpu ? 999 : 0);
      // Engine ladder by capability: CUDA (NVIDIA), Vulkan (supported Linux/
      // Windows GPUs), Metal (macOS), then CPU. Each rung self-tests first.
      const caps = [];
      if (wantGpu) caps.push("cuda");
      if (this.hardware?.capabilities?.vulkanEligible) caps.push("vulkan");
      if (this.hardware?.capabilities?.metalEligible) caps.push("metal");
      caps.push("cpu");
      const rungErrors = [];
      const badBuilds = this.state?.get("badBuilds", {}) || {};
      for (let i = 0; i < caps.length; i++) {
        const cap = caps[i];
        try {
          this._loadStage(signal, "provisioning");
          const binPath = await this.provisioner.ensure(kind, { cap, signal });
          // A build that crashed its self-test on this machine stays
          // skipped for the rest of THIS app version — each app update
          // retries once, because updates ship loader fixes (the v0.22.1
          // CRT heal) that can revive a build without changing its bits.
          const bad = badBuilds[binPath];
          const badReason = typeof bad === "string" ? bad : bad?.reason; // pre-0.22.1 entries were plain strings
          const badVersion = typeof bad === "string" ? null : bad?.appVersion;
          if (badReason && badVersion === (this.appVersion || null)) {
            rungErrors.push(`[${cap}] skipped — crashed on this machine before (${badReason})`);
            continue;
          }
          return await boot(binPath, cap === "cpu" ? 0 : 999, cap);
        } catch (e) {
          signal?.throwIfAborted();
          rungErrors.push(`[${cap}] ${String(e.message)}`);
          // Two machine-stable signatures are worth remembering: a crashed
          // self-test, and a HARD crash at real startup (Windows access
          // violations arrive as 32212xxxxx exit codes; POSIX as SIGSEGV/
          // SIGILL). Field log: the Vulkan build passed its self-test and
          // then died with 0xC0000005 on EVERY model switch, riding the
          // crash-then-fallback ladder several times a minute. A plain
          // "exited during startup" without those codes stays retryable —
          // port conflicts and OOM are transient.
          const hardCrash = /exit code 32212\d+|SIGSEGV|SIGILL/i.test(String(e.message));
          if (this.state && (hardCrash || /self-test failed/i.test(String(e.message))) && cap !== "cpu") {
            const bad = this.state.get("badBuilds", {});
            try {
              bad[await this.provisioner.ensure(kind, { cap, signal })] = {
                reason: String(e.message).slice(0, 160),
                appVersion: this.appVersion || null,
              };
              this.state.set("badBuilds", bad);
            } catch { /* provisioning itself failed — nothing to remember */ }
          }
          if (i < caps.length - 1) {
            this.onEvent({ type: "runtime:fallback", from: cap, to: caps[i + 1], reason: String(e.message) });
          }
        }
      }
      // Every rung's reason survives — reporting only the last one hid
      // the GPU failure that started the slide (field finding).
      throw new Error(rungErrors.join(" · "));
    };

    const bootFallback = async (why) => {
      if (!fallbackAllowed) throw new Error(`${why ? why + " · " : ""}This model requires KAI’s managed llama.cpp engine; Ollama fallback is unavailable for this model.`);
      signal?.throwIfAborted();
      const fb = this.makeFallback ? await this.makeFallback({ signal }) : null;
      signal?.throwIfAborted();
      if (!fb) return null;
      if (why) this.onEvent({ type: "runtime:fallback", from: "llamacpp", to: fb.status().kind, reason: why });
      const modelName = `koinos-${alias}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
      this._loadStage(signal, "starting");
      try { await fb.start({ modelPath, sha256: resolved.sha256, modelName, signal }); signal?.throwIfAborted(); }
      catch (error) { await fb.stop(); throw error; }
      return fb;
    };

    let runtime;
    try {
      if (this.preferFallback) {
        runtime = await bootFallback(null);
        if (!runtime) throw new Error("KAI_RUNTIME requested the fallback runtime, but none is available");
      } else {
        try {
          runtime = await bootLlama();
        } catch (e) {
          signal?.throwIfAborted();
          // A machine-incompatibility signature (crashing self-tests) is a
          // session-stable fact: stop paying the ladder on every switch and
          // go straight to the fallback from here on. Transient failures
          // (a download blip) don't set it — the ladder retries next load.
          if (/self-test failed/i.test(String(e.message))) this._llamaDead = true;
          runtime = await bootFallback(String(e.message));
          if (!runtime) throw e;
        }
      }
      this.lastLoadError = null;
    } catch (e) {
      signal?.throwIfAborted();
      this.lastLoadError = { alias, message: String(e.message), at: new Date().toISOString() };
      throw e;
    }

    if (signal?.aborted) { await runtime.stop(); signal.throwIfAborted(); }
    this.runtime = runtime;
    this.activeAlias = alias;
    // stop() may have run while this load was in flight (quick app quit
    // during the warm start): the child it never saw must not outlive us.
    if (this._stopped) {
      this.stop();
      throw new Error("Core is stopping");
    }
    return runtime.endpoint;
  }

  stop() {
    const loading = this._loading;
    this._stopEpoch++;
    this._stopped = true;
    this._loading?.controller.abort(new DOMException("Model preparation stopped", "AbortError"));
    for (const entry of this._generationQueue.splice(0)) {
      entry.signal?.removeEventListener("abort", entry.abort);
      entry.reject(new DOMException("Local model request stopped", "AbortError"));
    }
    if (this.runtime) this._runtimeStopPromise = Promise.resolve(this.runtime.stop());
    this.runtime = null;
    this.activeAlias = null;
    return Promise.all([this._runtimeStopPromise, loading?.promise.catch(() => {})]).then(() => undefined);
  }
}

module.exports = { RuntimeManager };
