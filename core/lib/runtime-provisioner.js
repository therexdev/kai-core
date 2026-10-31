"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");

const { downloadFile } = require("./download");
const { extractZipAsync } = require("./zip");

/** Extract a .tar.gz via the system tar (universal on the Linux/macOS
 *  machines these archives target; Windows builds stay zips). Async spawn —
 *  never blocks the app process. */
function extractTarGzAsync(file, destDir, { signal } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    fs.mkdirSync(destDir, { recursive: true });
    // Runtime files belong to the current app user, not the archive builder's
    // numeric UID (which can be unavailable inside a Linux user namespace).
    const child = require("child_process").spawn("tar", ["--no-same-owner", "-xzf", file, "-C", destDir], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stderr.on("data", (c) => (err = (err + c).slice(-2000)));
    child.on("error", (e) => { signal?.removeEventListener("abort", abort); reject(new Error(`tar unavailable: ${e.message}`)); });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolve();
      else reject(new Error(`tar failed (${code}): ${err.slice(0, 200)}`));
    });
  });
}

/** Streaming sha256 of a file — never loads it whole. */
async function sha256File(file, signal) {
  signal?.throwIfAborted();
  const h = require("crypto").createHash("sha256");
  for await (const chunk of fs.createReadStream(file, { signal })) h.update(chunk);
  signal?.throwIfAborted();
  return h.digest("hex");
}

/*
 * Runtime provisioner: fetches the right inference-engine build for this
 * machine exactly like a model package — versioned, hash-pinned, fail-closed
 * (§27) — so onboarding's one click covers model AND engine (§5: everything
 * handled automatically). Build selection: platform-arch-capability, with a
 * CPU fallback when no matching GPU build exists.
 */

class RuntimeProvisioner {
  constructor({ catalogPath, runtimesDir, hardware, onEvent }) {
    this.catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    this.runtimesDir = runtimesDir;
    this.hardware = hardware;
    this.onEvent = onEvent || (() => {});
    this._active = null; // one identified build, with independently cancellable waiters
    this._progress = null;
  }

  downloadProgress() {
    return this._active ? this._progress : null;
  }

  /** Which build entry this machine gets, or throw with a clear reason. */
  selectBuild(kind, { cap } = {}) {
    const rt = this.catalog[kind];
    if (!rt) throw new Error(`Unknown runtime kind: ${kind}`);
    // NVIDIA → CUDA. Modern Intel/AMD GPUs (Arc, Iris Xe, Radeon) → Vulkan.
    // macOS → Metal. Conservative detection keeps unknown desktop GPUs on
    // CPU, while every supported Mac has a Metal-capable graphics device.
    if (!cap) {
      if (this.hardware?.capabilities?.cudaEligible) cap = "cuda";
      else if ((this.hardware?.gpus || []).some((g) => /\b(arc|iris xe|radeon|rx \d{3,4})\b/i.test(String(g.name || "")))) cap = "vulkan";
      else if (this.hardware?.capabilities?.metalEligible) cap = "metal";
      else cap = "cpu";
    }
    const keys = [`${process.platform}-${process.arch}-${cap}`, `${process.platform}-${process.arch}-cpu`];
    for (const key of keys) {
      if (rt.builds[key]) return { key, version: rt.version, ...rt.builds[key] };
    }
    throw new Error(
      `No ${kind} build for this machine (${keys[0]}). ` +
        "Point KAI_LLAMA_BIN at an existing llama-server binary as a workaround."
    );
  }

  installedBinPath(kind, opts) {
    const b = this.selectBuild(kind, opts);
    return path.join(this.runtimesDir, kind, b.version, b.key, ...b.binPath.split("/"));
  }

  /** Ensure the runtime binary exists locally; download + extract if not. */
  async ensure(kind, opts = {}) {
    return this._request(kind, opts, false);
  }

  async _request(kind, opts, force) {
    opts.signal?.throwIfAborted();
    const build = this.selectBuild(kind, opts), key = `${kind}/${build.version}/${build.key}`;
    while (this._active) {
      const active = this._active;
      // Only an identical engine build may share its result. Returning an
      // unrelated setup's binary used to launch the wrong executable.
      if (!force && active.key === key && !active.controller.signal.aborted) return this._join(active, opts.signal);
      await this._wait(active.promise, opts.signal).catch(() => { opts.signal?.throwIfAborted(); });
    }
    opts.signal?.throwIfAborted();
    const job = { key, controller: new AbortController(), waiters: new Set() };
    this._active = job;
    this._progress = { kind, build: build.key, phase: "preparing" };
    job.promise = Promise.resolve().then(() => this._ensure(kind, { ...opts, signal: job.controller.signal, force })).finally(() => {
      if (this._active === job) { this._active = null; this._progress = null; }
    });
    return this._join(job, opts.signal);
  }

  _wait(promise, signal, cleanup = () => {}) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, value) => {
        if (done) return; done = true;
        signal?.removeEventListener("abort", abort); cleanup();
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      promise.then(value => finish(null, value), error => finish(error));
    });
  }

  _join(job, signal) {
    const waiter = {}; job.waiters.add(waiter);
    return this._wait(job.promise, signal, () => {
      job.waiters.delete(waiter);
      if (!job.waiters.size && this._active === job) job.controller.abort(new DOMException("Engine preparation cancelled", "AbortError"));
    });
  }

  async _ensure(kind, opts) {
    opts.signal?.throwIfAborted();
    const build = this.selectBuild(kind, opts);
    const bin = path.join(this.runtimesDir, kind, build.version, build.key, ...build.binPath.split("/"));
    if (!opts.force && fs.existsSync(bin)) return bin;

    const installDir = path.dirname(path.join(this.runtimesDir, kind, build.version, build.key, "x"));
    if (opts.force) await fsp.rm(installDir, { recursive: true, force: true });
    opts.signal?.throwIfAborted();
    this.onEvent({ type: "runtime:provisioning", kind, build: build.key, version: build.version });

    // Main archive first, then companion archives (e.g. CUDA's cudart
    // runtime) — all hash-verified, all extracted into the same directory.
    const archives = [
      { url: build.url, sha256: build.sha256, sizeBytes: build.sizeBytes },
      ...(build.extras || []),
    ];
    // Big engines need room to unpack — refuse up front in plain words,
    // not halfway through with a cryptic write error.
    const needBytes = archives.reduce((s, a) => s + (a.sizeBytes || 0), 0) * 2.4;
    try {
      const free = fs.statfsSync(os.tmpdir()).bavail * fs.statfsSync(os.tmpdir()).bsize;
      if (free < needBytes) {
        throw new Error(`Setting up this engine needs ~${Math.ceil(needBytes / 1e9)} GB free disk space — free some up and try again`);
      }
    } catch (e) {
      if (String(e.message).includes("free disk space")) throw e;
      /* statfs unsupported — proceed */
    }
    await fsp.mkdir(path.dirname(installDir), { recursive: true });
    const stage = await fsp.mkdtemp(path.join(path.dirname(installDir), `.${build.key}-`));
    const cachedArchives = [];
    try {
      for (let i = 0; i < archives.length; i++) {
        opts.signal?.throwIfAborted();
        const a = archives[i];
        // llama.cpp ships Windows builds as .zip and Linux builds as .tar.gz —
        // keep the downloaded file's real extension so extraction picks the
        // right tool (the arm64/Pi support runs on tarballs).
        const isTar = /\.t(ar\.)?gz$/i.test(String(a.url));
        const zipPath = path.join(os.tmpdir(), `kai-runtime-${kind}-${build.version}-${build.key}-${i}.${isTar ? "tar.gz" : "zip"}`);
        cachedArchives.push(zipPath);
        // A finished download that never got extracted (app closed mid-setup)
        // is reused after hash verification — nobody re-downloads gigabytes.
        this._progress = { kind, build: build.key, phase: "verifying", archive: i + 1, archives: archives.length };
        const reusable = fs.existsSync(zipPath) && (await sha256File(zipPath, opts.signal)) === String(a.sha256).toLowerCase();
        opts.signal?.throwIfAborted();
        if (!reusable) {
          let lastPct = -1;
          await downloadFile(a.url, zipPath, {
            signal: opts.signal,
            sha256: a.sha256,
            sizeBytes: a.sizeBytes,
            onProgress: (p) => {
              this._progress = { kind, build: build.key, archive: i + 1, archives: archives.length, ...p };
              // Emit (and therefore log) only on whole-percent changes — the raw
              // callback fires per network chunk and would flood core.log.
              if (p.pct !== null && p.pct !== lastPct) {
                lastPct = p.pct;
                this.onEvent({ type: "runtime:download", kind, ...p });
              }
            },
          });
        }
        opts.signal?.throwIfAborted();
        // Unpacking runs off the main thread — Core shares the app's main
        // process, and a synchronous 1.4 GB extract froze the window for
        // minutes (field finding). The UI shows "Setting up engine…".
        this._progress = { kind, build: build.key, phase: "extracting", archive: i + 1, archives: archives.length };
        this.onEvent({ type: "runtime:extracting", kind, archive: i + 1, archives: archives.length });
        opts.signal?.throwIfAborted();
        if (isTar) await extractTarGzAsync(zipPath, stage, opts);
        else await extractZipAsync(zipPath, stage, opts);
        opts.signal?.throwIfAborted();
      }
      opts.signal?.throwIfAborted();
      const stagedBin = path.join(stage, ...build.binPath.split("/"));
      if (!fs.existsSync(stagedBin)) {
        throw new Error(
          `Runtime archive for ${build.key} did not contain expected binary at ${build.binPath} — catalog binPath is wrong`
        );
      }
      if (process.platform !== "win32") await fsp.chmod(stagedBin, 0o755);
      opts.signal?.throwIfAborted();
      // Never expose a half-extracted binary as an installed engine. An app
      // exit or cancelled companion archive must leave setup retryable.
      await fsp.rm(installDir, { recursive: true, force: true });
      opts.signal?.throwIfAborted();
      await fsp.rename(stage, installDir);
      for (const file of cachedArchives) await fsp.rm(file, { force: true }).catch(() => {});
      this.onEvent({ type: "runtime:provisioned", kind, bin });
      return bin;
    } finally { await fsp.rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  }

  /** Blow away an installed build and download+extract it fresh. The heal
   *  path for a corrupted extraction (§5: never strand the user). */
  async reprovision(kind, opts = {}) {
    const build = this.selectBuild(kind, opts);
    this.onEvent({ type: "runtime:reprovision", kind, build: build.key, version: build.version });
    return this._request(kind, opts, true);
  }
}

module.exports = { RuntimeProvisioner };
