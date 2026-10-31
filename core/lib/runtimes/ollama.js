"use strict";

const fs = require("fs");

/*
 * Ollama runtime adapter (spec §6 keeps runtimes swappable). When a local
 * Ollama is running (default 127.0.0.1:11434), Core can serve chat through
 * it: our hash-verified GGUF is registered into Ollama's store via the blob
 * API — the §27 package sha256 IS the blob digest, so nothing unverified
 * ever enters — and Ollama's OpenAI-compatible /v1 surface does the rest.
 *
 * Used as a fallback when the managed llama.cpp build can't run on this
 * machine (first field case: a llama-server release build that crashed on
 * hardware where Ollama demonstrably worked), or forced via KAI_RUNTIME=ollama.
 */

class OllamaRuntime {
  constructor({ host = "127.0.0.1", port = 11434, onEvent } = {}) {
    this.host = host;
    this.port = port;
    this.onEvent = onEvent || (() => {});
    this.model = null; // registered Ollama model name
    this.running = false;
  }

  get endpoint() {
    return `http://${this.host}:${this.port}`;
  }

  /** Resolves to the Ollama version string when one is running, else null. */
  static async detect({ host = "127.0.0.1", port = 11434, signal } = {}) {
    signal?.throwIfAborted();
    try {
      const r = await fetch(`http://${host}:${port}/api/version`, { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(1500)]) });
      if (!r.ok) { await r.body?.cancel(); return null; }
      return (await r.json()).version ?? "unknown";
    } catch (error) {
      signal?.throwIfAborted(); return null;
    }
  }

  /** Where an installed Ollama binary lives, or null. Async spawn — a PATH
   *  probe must never block the event loop (same rule as engine selfTest). */
  static async locate({ signal } = {}) {
    signal?.throwIfAborted();
    const { spawn } = require("child_process");
    const path = require("path");
    const probe = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(process.platform === "win32" ? "where" : "which", ["ollama"], { windowsHide: true });
      } catch (e) {
        return resolve({ error: e, status: null, stdout: "" });
      }
      let stdout = "";
      const abort = () => { try { child.kill("SIGKILL"); } catch {} };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 5000);
      child.stdout?.on("data", (d) => { stdout = (stdout + d).slice(-8192); });
      child.on("error", (e) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve({ error: e, status: null, stdout }); });
      child.on("close", (status) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve({ status, stdout }); });
    });
    signal?.throwIfAborted();
    const found = (probe.stdout || "").split("\n")[0].trim();
    if (probe.status === 0 && found) return found;
    if (process.platform === "win32" && process.env.LOCALAPPDATA) {
      const p = path.join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe");
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  /**
   * Detect a running Ollama; if none but one is installed, start the daemon
   * ourselves ("ollama serve") and wait for it — the user should never have
   * to launch it by hand. Returns the version string or null.
   */
  static async ensureRunning({ host = "127.0.0.1", port = 11434, onEvent, provision, modelsDir, signal, spawnProcess } = {}) {
    signal?.throwIfAborted();
    const emit = onEvent || (() => {});
    const up = await OllamaRuntime.detect({ host, port, signal });
    if (up) return up;
    let bin = await OllamaRuntime.locate({ signal });
    // Nothing installed: provision our own portable build — everything in
    // the app, nobody gets sent to a website (field requirement). The zip
    // is hash-pinned in the runtime catalog like every engine (§27) and
    // downloaded lazily, only on machines that actually need the fallback.
    if (!bin && provision) {
      try {
        bin = await provision({ signal });
        signal?.throwIfAborted();
      } catch (e) {
        signal?.throwIfAborted();
        emit({ type: "runtime:ollama-provision-failed", message: String(e.message) });
        return null;
      }
    }
    signal?.throwIfAborted();
    if (!bin) return null;
    emit({ type: "runtime:ollama-starting", bin });
    const { spawn } = require("child_process");
    let launchError = null;
    try {
      // Detached daemon: it outlives us, exactly like a user-launched
      // Ollama. A provisioned copy keeps its models inside our data dir so
      // storage stays governed and uninstall stays clean.
      const env = { ...process.env, OLLAMA_HOST: `${host}:${port}`, ...(modelsDir ? { OLLAMA_MODELS: modelsDir } : {}) };
      const child = (spawnProcess || spawn)(bin, ["serve"], { detached: true, stdio: "ignore", windowsHide: true, env });
      // ENOENT/EACCES are asynchronous. An unhandled spawn error here used
      // to terminate the entire desktop while falling back from llama.cpp.
      child.once("error", error => { launchError = error; });
      child.unref();
    } catch {
      return null;
    }
    const deadline = Date.now() + 30000; // first run unpacks runners — allow it
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (launchError) { emit({ type: "runtime:ollama-start-failed", message: String(launchError.message) }); return null; }
      const v = await OllamaRuntime.detect({ host, port, signal });
      if (v) return v;
      await new Promise((resolve, reject) => {
        const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(); };
        const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal.reason); };
        const timer = setTimeout(finish, 400); signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    return null;
  }

  status() {
    return {
      kind: "ollama",
      running: this.running,
      pid: null, // Ollama owns its own process lifecycle
      endpoint: this.running ? this.endpoint : null,
      model: this.model,
    };
  }

  /** Model name inside Ollama — the gateway rewrites request bodies to it. */
  servedName() {
    return this.model;
  }

  async _api(path, body, opts = {}) {
    const r = await fetch(`${this.endpoint}${path}`, {
      method: "POST",
      headers: { "content-type": opts.raw ? "application/octet-stream" : "application/json" },
      body: opts.raw ? body : JSON.stringify(body),
      // Streamed request bodies (blob uploads) need half-duplex mode.
      ...(opts.duplex ? { duplex: "half" } : {}),
      signal: AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(opts.timeoutMs || 120000)]),
    });
    return r;
  }

  /**
   * Ensure our verified GGUF is registered in Ollama under `modelName`,
   * then treat Ollama as the serving endpoint.
   */
  async start({ modelPath, sha256, modelName, signal }) {
    signal?.throwIfAborted();
    const name = modelName || "koinos-model";
    const digest = `sha256:${String(sha256).toLowerCase()}`;

    const shown = await this._api("/api/show", { model: name }, { timeoutMs: 5000, signal }).catch(error => { signal?.throwIfAborted(); return null; });
    const exists = shown?.ok; await shown?.body?.cancel();
    if (!exists) {
      // Upload the verified artifact as a blob (idempotent server-side),
      // then create the model from that exact digest.
      this.onEvent({ type: "runtime:ollama-import", model: name });
      // STREAM the upload — readFileSync capped registration at Node's
      // 2 GiB buffer limit (field finding: every model past Koinos Fast
      // failed with "File size … greater than 2 GiB") and would have put
      // a model-sized spike in memory besides. Localhost is disk-speed;
      // the generous timeout covers 20 GB models on laptop drives.
      const { Readable } = require("stream");
      const blob = await this._api(`/api/blobs/${digest}`, Readable.toWeb(fs.createReadStream(modelPath)), {
        raw: true,
        duplex: true,
        timeoutMs: 1800000,
        signal,
      });
      await blob.body?.cancel();
      if (!blob.ok && blob.status !== 201) {
        throw new Error(`Ollama rejected the model blob: HTTP ${blob.status}`);
      }
      let created = await this._api("/api/create", { model: name, files: { "model.gguf": digest } }, { signal });
      if (!created.ok) {
        await created.body?.cancel();
        // Older Ollama versions take a Modelfile that references the path.
        created = await this._api("/api/create", { name, modelfile: `FROM ${modelPath}` }, { signal });
      }
      if (!created.ok) {
        throw new Error(`Ollama could not create the model: HTTP ${created.status} ${await created.text().catch(() => "")}`);
      }
      await created.text(); // drain the progress stream
    }

    signal?.throwIfAborted();
    this.model = name;
    this.running = true;
    this.onEvent({ type: "runtime:ready", kind: "ollama", endpoint: this.endpoint });
    return { endpoint: this.endpoint };
  }

  stop() {
    // We never own the Ollama daemon — just detach.
    this.running = false;
    this.model = null;
  }
}

module.exports = { OllamaRuntime };
