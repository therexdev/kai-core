"use strict";

// Headers a reverse proxy adds. Their presence means the request did NOT come
// straight from this machine's loopback — used to gate the code-agent surface.
const FORWARDED_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"];

const http = require("http");
const fs = require("fs");
const nodePath = require("path");
const { ModelLoadQueue } = require("./model-load-queue");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".ico": "image/x-icon",
};

/*
 * Local OpenAI-compatible API gateway (spec §8, MAJOR SELLING POINT).
 * Serves two route families on one 127.0.0.1 port:
 *   /v1/*      OpenAI-compatible surface (models, chat/completions+streaming)
 *   /core/*    control plane for the desktop UI / CLI (health, modules, keys)
 *
 * Policy lives HERE, not in the runtime: authentication, alias resolution,
 * and (later) routing/budget enforcement — the llama-server child stays a
 * dumb inference engine behind it.
 *
 * Auth model (§5 friction vs §8 credentials): with no API keys created the
 * gateway answers localhost callers unauthenticated — chat works instantly
 * after install. The moment the first key is created, every /v1 request must
 * present one. Keys are scoped app credentials, never wallet keys.
 */

const MAX_BODY_BYTES = 10 * 1024 * 1024;

// §7 context capability: keep room for the completion so a prompt that
// technically fits still has space to be answered.
const CTX_HEADROOM_TOKENS = 512;

/** Deliberately cheap — it gates routing, it does not bill anything.
 *  Multimodal content-parts: text parts count by chars; each image counts a
 *  flat ~800 tokens (typical projector budget), NOT its base64 length —
 *  String()-ing an array would both miscount and crash the gate. */
function estimateMessageTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  let n = 0;
  let images = 0;
  for (const m of messages) {
    n += 1;
    const c = m?.content;
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part?.type === "image_url") images += 1;
        else chars += String(part?.text ?? "").length;
      }
    } else {
      chars += String(c ?? "").length;
    }
  }
  return Math.ceil(chars / 4) + n * 4 + images * 800;
}

/** True when any message carries an image content part. */
function hasImageParts(messages) {
  return Array.isArray(messages) && messages.some((m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === "image_url"));
}

class Gateway {
  constructor({ host = "127.0.0.1", port = 41100, runtime, models, keys, coreInfo, uiDir, staticAssets, earn, network, feedback, account, creditAccount, onEvent }) {
    this.account = account || null;
    this.creditAccount = creditAccount || null;
    this.feedback = feedback || null;
    this.earn = earn || null;
    this.network = network || null;
    this.host = host;
    this.port = port;
    this.runtime = runtime; // RuntimeManager
    this.models = models; // ModelManager
    this.keys = keys; // ApiKeys
    this.coreInfo = coreInfo || (() => ({}));
    this.uiDir = uiDir || null; // when set, serves the desktop UI at /
    // Large local browser runtimes stay out of ui/ and git. Only these exact
    // routes are readable; this is not a second static directory or a path
    // resolver over node_modules.
    this.staticAssets = staticAssets instanceof Map ? staticAssets : new Map(Object.entries(staticAssets || {}));
    this.onEvent = onEvent || (() => {});
    this.server = null;
    this._ensureJob = null; // background model-load kicked off by the UI
    this._modelQueue = new ModelLoadQueue({ models, runtime, onChange: job => {
      this._ensureJob = { alias: job.alias, state: job.state === "preparing" ? "working" : job.state === "done" ? "ready" : job.state, error: job.error };
    } });
    // Headless hardening (A40 field report, pre-server-edition): when
    // KAI_CORE_TOKEN is set, every /core/* call must present it as a bearer.
    // Off by default — the desktop app's loopback trust model is unchanged,
    // and the served UI does not carry the token, so this is for deployments
    // driven programmatically (proxies, fleet scripts), not the window.
    this.coreToken = process.env.KAI_CORE_TOKEN || null;
  }

  _coreAuthed(req) {
    if (!this.coreToken) return true;
    const h = String(req.headers.authorization || "");
    if (!h.startsWith("Bearer ")) return false;
    const crypto = require("crypto");
    const a = crypto.createHash("sha256").update(h.slice(7)).digest();
    const b = crypto.createHash("sha256").update(this.coreToken).digest();
    return crypto.timingSafeEqual(a, b);
  }

  listen() {
    this.server = http.createServer((req, res) => {
      this._route(req, res).catch((e) => {
        this._json(res, 500, { error: { message: String(e?.message ?? e), type: "server_error" } });
      });
    });
    // 0 = OS-assigned port (tests); the real default is 41100. A second
    // instance (or any process squatting the port) used to crash boot with
    // an unhandled 'error' event — fall back to an OS-assigned port so the
    // app still opens; the UI loads from whatever port we return.
    return new Promise((resolve, reject) => {
      this.server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && this.port !== 0) {
          this.port = 0;
          this.server.listen(0, this.host, () => {
            this.port = this.server.address().port;
            resolve(this.port);
          });
          return;
        }
        reject(err);
      });
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  close() {
    this.stopModelQueue();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      // Sever keep-alive sockets (fetch pools them), or close() waits forever.
      this.server.closeAllConnections?.();
      this.server.close(resolve);
    });
  }

  modelQueueSnapshot() { return this._modelQueue.snapshot(); }
  stopModelQueue() { this._modelQueue.close(); }

  _json(res, status, body) {
    if (res.headersSent) return res.end();
    const data = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
    res.end(data);
  }

  _authed(req, res) {
    if (!this.keys.required() && !req.headers["x-kai-remote-access"]) return true; // local free access only
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
    const info = m ? this.keys.verify(m[1].trim()) : null;
    if (info) {
      req._apiKey = info; // downstream metering attributes usage to this key
      return true;
    }
    this._json(res, 401, {
      error: {
        message: "Missing or invalid API key. Pass it as: Authorization: Bearer <key>",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    });
    return false;
  }

  async _readBody(req) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) throw new Error("Request body too large");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  /*
   * Cross-site guard for the control plane.
   *
   * /core/* has no API key by design — it IS the app talking to itself — and
   * bodies are JSON.parsed without a content-type check. That combination was
   * exploitable: `content-type: text/plain` is CORS-safelisted, so a POST from
   * ANY page the user happened to be visiting was a "simple request", sent
   * without a preflight, and parsed as JSON. The attacker cannot read the
   * reply, but the side effect already happened — including /core/tools/call,
   * whose `confirmed` flag comes straight off the request body and would have
   * walked through the confirm-before-use gate.
   *
   * The rule has to admit three legitimate callers and refuse the browser:
   *   · the renderer, which Electron loads FROM this server (main.js:110), so
   *     its Origin is our own;
   *   · the Electron main process, whose Node fetch sends no Origin at all;
   *   · local scripts and other apps on the machine — likewise no Origin.
   * A browser is the only caller that stamps a foreign Origin, and it cannot
   * lie about it. So: absent Origin passes, matching Origin passes, anything
   * else is refused. Sec-Fetch-Site is belt and braces — browsers always set
   * it, non-browsers never do.
   */
  _sameSite(req) {
    const site = String(req.headers["sec-fetch-site"] || "");
    if (site && site !== "same-origin" && site !== "none") return false;
    const origin = req.headers.origin;
    if (!origin) return true; // not a browser fetch
    const ours = new Set([`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`]);
    return ours.has(String(origin));
  }

  /* AI/account egress follows AI privacy. The separately enabled Koinos
   * node and explicit wallet actions use their own lifecycle and password
   * controls; running a blockchain node does not enable online AI. */
  _blockedByPrivacy(res, feature) {
    const mode = this.network ? this.network.status().privacyMode : "local-only";
    if (mode !== "local-only") return false;
    this._json(res, 403, {
      ok: false,
      localOnly: true,
      error: `${feature} needs network access, and AI Privacy is set to Local-Only. Switch to Local-First or Network to use it.`,
    });
    return true;
  }

  async _route(req, res) {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "SAMEORIGIN");
    res.setHeader("content-security-policy", "frame-ancestors 'self'");
    // A same-origin browser GET can omit Origin after DNS rebinding. Only
    // local Host authorities may reach this loopback server (including UI).
    const hosts = new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`]);
    if (this.port === 80) for (const h of ["127.0.0.1", "localhost", "[::1]"]) hosts.add(h);
    if (!hosts.has(String(req.headers.host || "").toLowerCase())) {
      return this._json(res, 403, { error: { message: "Refused: use the local API host and port.", code: "invalid_host" } });
    }
    let url;
    try { url = new URL(req.url, `http://127.0.0.1:${this.port}`); }
    catch { return this._json(res, 400, { error: { message: "Invalid request URL" } }); }
    if (url.origin !== new URL(`http://127.0.0.1:${this.port}`).origin) return this._json(res, 400, { error: { message: "Use a local request path" } });
    const path = url.pathname;

    // The control plane is for this app only. /v1/* is deliberately left open
    // to local callers (that is the point of an OpenAI-compatible endpoint)
    // and is guarded by an API key once one exists.
    if (path.startsWith("/core/") && !this._sameSite(req)) {
      return this._json(res, 403, {
        ok: false,
        error: "Refused: this endpoint only answers Koinos AI itself, not another site.",
      });
    }
    // _sameSite deliberately trusts header-less callers (local scripts are
    // legitimate); on a shared or proxied deployment that trust is too wide —
    // KAI_CORE_TOKEN closes it (see constructor).
    if (path.startsWith("/core/") && !this._coreAuthed(req)) {
      return this._json(res, 401, { ok: false, error: "This deployment requires a core token: Authorization: Bearer <KAI_CORE_TOKEN>." });
    }

    /*
     * The OpenAI-compatible surface is open to LOCAL callers on purpose —
     * "point any SDK at this machine" is the whole feature — and until someone
     * creates a key, _authed() lets every caller through. A web page is not a
     * local caller, and the same hole that took /core/* out applies here:
     * content-type text/plain is CORS-safelisted, so any site the user happens
     * to be visiting can POST /v1/chat/completions with no preflight. It never
     * sees the answer — nothing here sends CORS headers — but the model has
     * already run on their machine, and in Local-First or Network mode their
     * KAI has already been spent. A blind write that costs money is still an
     * attack.
     *
     * Refusing outright rather than demanding a key: with no CORS headers, no
     * browser could ever read a /v1 reply cross-origin anyway, so there is no
     * working caller to break. The app's own UI is same-origin and passes;
     * curl, SDKs and other local apps send no Origin at all and pass.
     */
    if (path.startsWith("/v1/") && !this._sameSite(req)) {
      return this._json(res, 403, {
        error: {
          message:
            "Refused: this local API does not answer other websites. Call it from this machine, or turn on Remote access for a URL that does.",
          type: "invalid_request_error",
          code: "cross_site_refused",
        },
      });
    }

    /*
     * Is this source checkout behind its remote?
     *
     * READ-ONLY on purpose. Applying an update means running git and possibly
     * npm, and this endpoint is reachable from the page — so it answers the
     * question and nothing more. The applying lives in the Electron layer,
     * behind a dialog the user has to agree to.
     *
     * Packaged builds have electron-updater and answer "packaged" here, so the
     * UI can say nothing rather than something wrong.
     */
    if (path === "/core/update" && req.method === "GET") {
      const { inspect, isGitCheckout } = require("./source-update");
      const repoDir = nodePath.join(__dirname, "..", "..");
      if (!isGitCheckout(repoDir)) {
        return this._json(res, 200, { ok: true, kind: "packaged", canCheck: false });
      }
      // `fetch` costs a network round trip, so the UI asks for it explicitly
      // rather than paying for it on every settings repaint.
      const wantFetch = /[?&]fetch=1(&|$)/.test(req.url || "");
      try {
        return this._json(res, 200, { ok: true, ...(await inspect(repoDir, { fetch: wantFetch })) });
      } catch (e) {
        return this._json(res, 200, { ok: true, kind: "error", canCheck: false, reason: String(e.message) });
      }
    }

    // ----- control plane -----
    if (path === "/core/health" && req.method === "GET") {
      return this._json(res, 200, { ok: true, ...this.coreInfo(), modules: this._modules() });
    }
    if (path === "/core/models" && req.method === "GET") {
      return this._json(res, 200, {
        ok: true,
        aliases: this.models.aliases(),
        storage: this.models.storageUsage(),
        runtime: this.runtime.status(),
        download: this.models.downloadProgress(),
        importing: this.models.importStatus?.() ?? null,
        importError: this._lastImportError ?? null,
        runtimeDownload: this.runtime.provisioner?.downloadProgress() ?? null,
        modelQueue: this.modelQueueSnapshot(),
        ensure: this._ensureJob
          ? { alias: this._ensureJob.alias, state: this._ensureJob.state, error: this._ensureJob.error }
          : null,
      });
    }
    // UI onboarding: download + load a model in the background; poll /core/models.
    if (path === "/core/models/ensure" && req.method === "POST") {
      const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      const alias = String(body.alias || "");
      try {
        this.models.resolveAlias(alias); // validate before going async
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
      // Platform preflight BEFORE the gigabyte model download: a machine
      // with no inference engine build (today: Linux without Ollama) must
      // hear that up front, not after the download completes.
      try {
        await this.runtime.preflight?.();
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
      try {
        const { duplicate, job } = this._modelQueue.enqueue(alias);
        return this._json(res, 202, { ok: true, started: !duplicate, alias, job, modelQueue: this.modelQueueSnapshot() });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }
    // The escape hatch cancelDownload() always had but never a route to (A40
    // field report): abort the in-flight model download. The ensure job then
    // rejects and frees its slot — no restart needed to un-wedge a bad mirror.
    if (path === "/core/models/download/cancel" && req.method === "POST") {
      const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      const result = this._modelQueue.cancel(body.alias ? String(body.alias) : null);
      return this._json(res, 200, { ok: true, ...result, modelQueue: this.modelQueueSnapshot(),
        ...(!result.cancelled ? { note: "The current preparation step is not cancellable, or this model is no longer queued." } : {}) });
    }
    if (this.models && path === "/core/models/import" && req.method === "POST") {
      try {
        const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
        // Hashing a 20 GB file takes minutes — run it as a job; the UI
        // polls /core/models for importStatus.
        const job = this.models.importCustom(body);
        job.catch((e) => (this._lastImportError = String(e.message)));
        this._lastImportError = null;
        const winner = await Promise.race([job.then((e) => ({ done: true, entry: e })), new Promise((r) => setTimeout(() => r({ done: false }), 800))]);
        return this._json(res, 200, { ok: true, ...winner });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: { message: String(e.message) } });
      }
    }
    /*
     * Removing an installed model. GET answers "what would this delete?" so
     * the UI can say it plainly before the user commits; DELETE does it.
     *
     * The in-use check lives HERE because the runtime is what knows which
     * model is loaded — model-manager deliberately does not reach into it.
     */
    if (this.models && path.startsWith("/core/models/installed/") && req.method === "GET") {
      try {
        const id = decodeURIComponent(path.slice("/core/models/installed/".length));
        const plan = this.models.removalPlan(id);
        const alias = this.runtime?.status().activeAlias || null;
        let inUse = false;
        try {
          // resolveAlias throws on a quarantined package; a model we cannot
          // resolve is certainly not the one currently serving.
          inUse = !!alias && this.models.resolveAlias(alias).packageId === id;
        } catch { /* not resolvable, so not in use */ }
        return this._json(res, 200, { ok: true, ...plan, inUse });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: { message: String(e.message) } });
      }
    }
    if (this.models && path.startsWith("/core/models/installed/") && req.method === "DELETE") {
      try {
        const id = decodeURIComponent(path.slice("/core/models/installed/".length));
        const alias = this.runtime?.status().activeAlias || null;
        let inUse = false;
        try {
          inUse = !!alias && this.models.resolveAlias(alias).packageId === id;
        } catch { /* the loaded alias no longer resolves; it cannot be this one */ }
        return this._json(res, 200, { ok: true, ...(await this.models.removePackage(id, { isInUse: inUse })) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: { message: String(e.message) } });
      }
    }
    if (this.models && path.startsWith("/core/models/custom/") && req.method === "DELETE") {
      try {
        return this._json(res, 200, { ok: true, ...this.models.removeCustom(decodeURIComponent(path.split("/")[4])) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: { message: String(e.message) } });
      }
    }

    // Documents (local-first writing surface).
    if (this.feedback && path === "/core/feedback" && req.method === "POST") {
      const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      try {
        return this._json(res, 200, { ok: true, ...(await this.feedback(body)) });
      } catch (e) {
        return this._json(res, 502, { ok: false, error: { message: String(e.message) } });
      }
    }

    // What the network can serve right now — feeds the chat picker's
    // network model list. Cached briefly; empty when unreachable.
    if (this.network && path === "/core/network/models" && req.method === "GET") {
      const { schedulerUrl } = this.network.status();
      if (!schedulerUrl) return this._json(res, 200, { ok: true, workersOnline: 0, models: [] });
      if (!this._netModels || Date.now() - this._netModels.at > 20000) {
        let v = { workersOnline: 0, models: [] };
        try {
          const r = await fetch(`${schedulerUrl.replace(/\/$/, "")}/network/models`, { headers: { connection: "close" }, signal: AbortSignal.timeout(4000) });
          const j = await r.json();
          if (j?.ok) v = { workersOnline: j.workersOnline, models: j.models || [] };
        } catch { /* offline — empty list */ }
        this._netModels = { at: Date.now(), v };
      }
      return this._json(res, 200, { ok: true, ...this._netModels.v });
    }

    // Public overview is independent of credit activation, wallet unlock and
    // historical payment records. Core owns privacy and the configured URL.
    if (this.network && path === "/core/network/overview" && req.method === "GET") {
      try { return this._json(res, 200, { ok: true, network: await this.network.overview() }); }
      catch (e) { return this._json(res, 503, { ok: false, error: String(e.message) }); }
    }

    // Full network status — feeds the Network tab: computers online, live
    // classes, and per-provider rows (addresses arrive pre-truncated from
    // the scheduler). Same brief cache + fail-soft shape as the picker.
    if (this.network && path === "/core/network/status" && req.method === "GET") {
      const { schedulerUrl } = this.network.status();
      if (!schedulerUrl) return this._json(res, 200, { ok: true, reachable: false, workersOnline: 0, models: [], workers: [] });
      if (!this._netStatus || Date.now() - this._netStatus.at > 10000) {
        let v = { reachable: false, workersOnline: 0, models: [], workers: [] };
        try {
          const r = await fetch(`${schedulerUrl.replace(/\/$/, "")}/network/status`, { headers: { connection: "close" }, signal: AbortSignal.timeout(4000) });
          const j = await r.json();
          if (j?.ok) {
            const { ok, ...rest } = j;
            v = { reachable: true, ...rest };
          }
        } catch { /* offline — empty shape */ }
        this._netStatus = { at: Date.now(), v };
      }
      return this._json(res, 200, { ok: true, ...this._netStatus.v });
    }

    if (this.network && path === "/core/network" && req.method === "GET") {
      return this._json(res, 200, { ok: true, ...this.network.status() });
    }
    if (this.network && path === "/core/network/config" && req.method === "POST") {
      try {
        const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
        return this._json(res, 200, { ok: true, ...this.network.configure(body) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }

    // ----- earn control plane (M2 §5.7) -----
    if (this.earn && path.startsWith("/core/earn")) {
      try {
        if (path === "/core/earn" && req.method === "GET") {
          return this._json(res, 200, { ok: true, ...(await this.earn.status()) });
        }
        const body =
          req.method === "POST" ? JSON.parse((await this._readBody(req)).toString("utf8") || "{}") : {};
        if (path === "/core/earn/config" && req.method === "POST") {
          return this._json(res, 200, { ok: true, ...(await this.earn.configure(body)) });
        }
        if (path === "/core/earn/wallet" && req.method === "POST") {
          // Returns the backup WIF exactly once — the UI shows it, Core forgets it.
          return this._json(res, 200, { ok: true, ...this.earn.createWallet(body) });
        }
        if (path === "/core/earn/wallet/restore" && req.method === "POST") {
          // Lost password + saved backup code: rebuild the keystore (§8).
          return this._json(res, 200, { ok: true, ...this.earn.restoreWallet(body) });
        }
        if (path === "/core/earn/wallet/reveal" && req.method === "POST") {
          // Backup code on demand — password required every time, even
          // while unlocked, so a walk-up can't exfiltrate the key.
          return this._json(res, 200, { ok: true, ...this.earn.revealWallet(body) });
        }
        if (path === "/core/earn/unlock" && req.method === "POST") {
          // The controller takes {password} — passing body.password here once
          // destructured a STRING into undefined and made every correct
          // password "incorrect". Caught by the earn-ui browser test.
          return this._json(res, 200, { ok: true, ...this.earn.unlock(body) });
        }
        if (path === "/core/earn/lock" && req.method === "POST") {
          return this._json(res, 200, { ok: true, ...(await this.earn.lock()) });
        }
        if (path === "/core/earn/deposit" && req.method === "POST") {
          return this._json(res, 200, { ok: true, ...(await this.earn.deposit(body)) });
        }
        if (path === "/core/earn/start" && req.method === "POST") {
          return this._json(res, 200, { ok: true, ...(await this.earn.start()) });
        }
        if (path === "/core/earn/stop" && req.method === "POST") {
          return this._json(res, 200, { ok: true, ...(await this.earn.stop()) });
        }
        // OS just woke from standby: re-register NOW, not on the next timer.
        if (path === "/core/earn/nudge" && req.method === "POST") {
          return this._json(res, 200, { ok: true, ...(await (this.earn.nudge?.() ?? {})) });
        }
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }

    // The desktop UI's own chat lane. Same proxy as /v1/chat/completions but
    // on the control plane: creating an external API key must never lock the
    // app's built-in chat out (localhost control plane is the UI's surface).
    if (path === "/core/chat/completions" && req.method === "POST") {
      return this._chat(req, res);
    }

    // ---- Koinos AI account (task #49): device link + wallet attach ----
    // All egress: refused in Local-Only before the client is touched.
    if (this.account && /^\/core\/(account|website-account)(?:\/|$)/.test(path)) {
      const website = path.startsWith("/core/website-account");
      const account = website ? this.account : this.creditAccount || this.account;
      const accountPath = website ? path.replace("/core/website-account", "/core/account") : path;
      if (this._blockedByPrivacy(res, "Your Koinos AI account")) return;
      try {
        if (accountPath === "/core/account" && req.method === "GET") {
          return this._json(res, 200, { ok: true, ...(await account.status()), scope: account === this.creditAccount ? "credits" : "website", separateCreditAccount: !!this.creditAccount });
        }
        if (accountPath === "/core/account/link/start" && req.method === "POST") {
          return this._json(res, 200, { ok: true, ...(await account.linkStart()) });
        }
        if (accountPath === "/core/account/link/poll" && req.method === "POST") {
          return this._json(res, 200, { ok: true, ...(await account.linkPoll()) });
        }
        if (accountPath === "/core/account/logout" && req.method === "POST") {
          await account.signOut();
          return this._json(res, 200, { ok: true });
        }
        if (accountPath === "/core/account/wallet" && req.method === "POST") {
          return this._json(res, 200, { ok: true, account: await account.linkWallet() });
        }
        if (accountPath === "/core/account/wallet/unlink" && req.method === "POST") {
          const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
          return this._json(res, 200, { ok: true, account: await account.unlinkWallet(body.address) });
        }
        // Spend grants: only this machine can create one (the wallet key
        // signs it here); revoking needs nothing but the session.
        if (account !== this.creditAccount && accountPath === "/core/account/grant" && req.method === "POST") {
          const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
          return this._json(res, 200, { ok: true, ...(await account.grantSpend(body)) });
        }
        if (account !== this.creditAccount && accountPath === "/core/account/grant/revoke" && req.method === "POST") {
          const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
          return this._json(res, 200, { ok: true, account: await account.revokeGrant(body.id) });
        }
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }

    // ----- OpenAI-compatible surface -----
    if (path === "/v1/models" && req.method === "GET") {
      if (!this._authed(req, res)) return;
      const data = this.models.aliases().map((a) => ({ id: a.alias, object: "model", owned_by: "koinos-ai" }));
      if (this.network) {
        const { privacyMode, schedulerUrl } = this.network.status();
        if (privacyMode !== "local-only" && schedulerUrl) {
          data.push({ id: "koinos-network", object: "model", owned_by: "koinos-network" });
        }
      }
      return this._json(res, 200, { object: "list", data });
    }

    if (path === "/v1/chat/completions" && req.method === "POST") {
      if (!this._authed(req, res)) return;
      return this._chat(req, res);
    }

    // §8 expansion: embeddings pass straight through to the local engine.
    // Engines built without embedding support answer with their own error —
    // relayed honestly rather than pretending.
    if (["/v1/embeddings", "/core/embeddings"].includes(path) && req.method === "POST") {
      if (path === "/v1/embeddings" && !this._authed(req, res)) return;
      const raw = await this._readBody(req);
      let alias = "";
      try {
        alias = String(JSON.parse(raw.toString("utf8") || "{}").model || "");
      } catch {
        return this._json(res, 400, { error: { message: "Body must be JSON", type: "invalid_request_error" } });
      }
      let endpoint;
      let releaseHold = () => {};
      try {
        if (this.runtime.acquireFor) {
          const hold = await this.runtime.acquireFor(alias);
          endpoint = hold.endpoint;
          releaseHold = hold.release;
        } else {
          endpoint = await this.runtime.ensure(alias);
        }
      } catch (e) {
        return this._json(res, 400, { error: { message: String(e.message), type: "invalid_request_error" } });
      }
      return this._proxy(endpoint, "/v1/embeddings", raw, req, res).finally(releaseHold);
    }

    if (path.startsWith("/v1/")) {
      if (!this._authed(req, res)) return;
      return this._json(res, 404, {
        error: { message: `${req.method} ${path} is not supported yet (M1 serves models + chat/completions)`, type: "invalid_request_error" },
      });
    }

    if (req.method === "GET" && this.staticAssets.has(path)) {
      return this._staticFile(this.staticAssets.get(path), res);
    }

    if (this.uiDir && req.method === "GET" && !path.startsWith("/core/")) {
      return this._static(path, res);
    }

    return this._json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
  }

  async _chat(req, res) {
    let raw = await this._readBody(req);
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return this._json(res, 400, { error: { message: "Body must be JSON", type: "invalid_request_error" } });
    }
    const alias = String(body.model || "");
    // An opt-out, never a grant of desktop authority. Private screen data must
    // not overflow to network operators when a local model fails or is full.
    const privateDesktop = body.kai_private_desktop === true;
    if (body.kai_private_desktop !== undefined) {
      delete body.kai_private_desktop; raw = Buffer.from(JSON.stringify(body));
    }
    if (privateDesktop && /^koinos-network(?:$|:)/.test(alias)) return this._json(res, 403, { error: {
      message: "Desktop observations require a local model or private desktop API connection.", type: "desktop_only",
    } });
    // Desktop provider keys never enter Core. Reject before grounding, runtime
    // loading or overflow so even a headless caller cannot route these models.
    if (alias.startsWith("desktop:")) return this._json(res, 403, { error: {
      message: "Private provider models are available only in desktop chat and KAI.", type: "desktop_only",
    } });

    if (body.koinos !== undefined) return this._json(res, 400, {error:{message:"Web research belongs to the requesting plugin. Supply the resulting model messages."}});
    // §46.5 network consume. Privacy policy is checked FIRST (§7): in
    // Local-Only mode this request never leaves the machine — the refusal
    // happens before any network code path is reached.
    if (alias === "koinos-network" || alias.startsWith("koinos-network:")) {
      if (!this.network) {
        return this._json(res, 400, { error: { message: "Network models are not configured", type: "invalid_request_error" } });
      }
      const { privacyMode } = this.network.status();
      if (privacyMode === "local-only") {
        return this._json(res, 400, {
          error: { message: "Privacy mode is Local-Only: network requests are disabled on this machine", type: "invalid_request_error" },
        });
      }
      // _chatNetwork re-serializes {messages,...} for signing — image content
      // parts would be mangled, not transported. Refuse honestly until the
      // network protocol carries them.
      if (hasImageParts(body.messages)) {
        return this._json(res, 400, {
          error: { message: "Network models can't see images yet — pick a local vision model for this chat", type: "invalid_request_error" },
        });
      }
      return this._chatNetwork(body, req, res);
    }

    // Images only reach a model that can actually see them: the package must
    // be vision-capable (its projector loads with the engine). Anything else
    // would silently describe nothing — worse than a clear refusal.
    if (hasImageParts(body.messages)) {
      let vision = false;
      try {
        vision = Boolean(this.models.resolveAlias(alias).vision);
      } catch {
        /* unknown alias — ensure() below will fail with its own message */
      }
      if (!vision) {
        return this._json(res, 400, {
          error: { message: `${alias || "This model"} can't see images — pick a vision-capable model from the picker`, type: "invalid_request_error" },
        });
      }
    }

    // §7 capability, context first: an oversized prompt would fail
    // mid-stream in the local runtime — and overflowing it blindly would
    // bill the user to fail remotely on the same class size. Estimate up
    // front; overflow only when the network's advertised class actually
    // fits; otherwise refuse cleanly before any engine or wallet is
    // touched. Unknown aliases fall through to ensure(), whose failure is
    // the plain capability-miss overflow below.
    let localCtx = null, localModel = null;
    try {
      localModel = this.models.resolveAlias(alias);
      localCtx = localModel.contextSize || 4096;
    } catch {
      /* not a local alias — ensure() decides */
    }
    // Gemma's original template enforces role alternation. Enrichment from
    // persona, memory, web and Agent/Research can legitimately add instruction
    // or user turns; preserve their content in a template-compatible local
    // request without changing persisted history or any network request.
    const localMessages = require("./local-chat-messages").localChatMessages(body.messages, localModel);
    const estTok = Math.max(estimateMessageTokens(body.messages), estimateMessageTokens(localMessages));
    if (localCtx && estTok > localCtx - CTX_HEADROOM_TOKENS) {
      const net = this.network ? this.network.status() : null;
      // A grounded request never overflows to the network: the whole promise
      // is that the fetched material and the question stay on this machine.
      const canNetwork = !privateDesktop && net && net.privacyMode !== "local-only" && net.schedulerUrl;
      const netCtx = canNetwork ? (await this._networkRates(net.schedulerUrl)).ctxTokens : 0;
      if (canNetwork && estTok <= netCtx - CTX_HEADROOM_TOKENS) {
        const reason = `prompt ~${estTok} tokens exceeds the ${localCtx}-token local context`;
        this.onEvent({ type: "gateway:overflow", from: alias, reason });
        return this._chatNetwork(body, req, res, { overflowFrom: alias, localError: reason });
      }
      return this._json(res, 400, {
        error: {
          message:
            `Prompt is ~${estTok} tokens — larger than the local model's ${localCtx}-token context` +
            (canNetwork ? ` and the network's ${netCtx}-token class` : "") +
            ". Shorten the prompt or start a new chat.",
          type: "invalid_request_error",
        },
      });
    }

    let endpoint;
    // Hold the engine for the life of this response: without the hold, a
    // network job for another model class stops the llama-server this chat
    // is still streaming from, and the answer dies mid-sentence.
    let releaseHold = () => {};
    try {
      if (this.runtime.acquireFor) {
        const hold = await this.runtime.acquireFor(alias);
        endpoint = hold.endpoint;
        releaseHold = hold.release;
      } else {
        endpoint = await this.runtime.ensure(alias);
      }
    } catch (e) {
      // §7 routing order: privacy → spending → capability. Capability just
      // failed locally; the network is used only when the privacy mode
      // permits it (Local-First and Network — never Local-Only, where the
      // request must not leave the machine even if it cannot be served).
      const net = this.network ? this.network.status() : null;
      if (!privateDesktop && net && net.privacyMode !== "local-only" && net.schedulerUrl) {
        this.onEvent({ type: "gateway:overflow", from: alias, reason: String(e.message) });
        return this._chatNetwork(body, req, res, { overflowFrom: alias, localError: String(e.message) });
      }
      return this._json(res, 400, { error: { message: String(e.message), type: "invalid_request_error" } });
    }
    if (localMessages !== body.messages) {
      body.messages = localMessages;
      raw = Buffer.from(JSON.stringify(body));
    }
    // Some runtimes (Ollama) serve the model under their own registered name
    // — rewrite the body so callers keep using the Koinos alias.
    const served = this.runtime.servedModelName?.();
    if (served && body.model !== served) {
      body.model = served;
      raw = Buffer.from(JSON.stringify(body));
    }
    // Local inference: tokens are metered per key, cost is zero (§24).
    const localKey = req._apiKey || null;
    return this._proxy(endpoint, "/v1/chat/completions", raw, req, res, {
      meter: localKey
        ? (usage) =>
            this.keys.recordUsage(localKey.id, {
              inTok: Number(usage.prompt_tokens || 0),
              outTok: Number(usage.completion_tokens || 0),
              costMicro: 0,
            })
        : null,
      // Citations ride BOTH ways: the header works for streaming and
      // non-streaming alike, the body field is the convenient one for the
      // ordinary JSON call. A caller who never asked for grounding gets
      // neither, and the response is byte-for-byte what it always was.

    }).finally(releaseHold);
  }

  /**
   * §7/§46.5: serve a chat request from the Koinos Network. Reached two
   * ways — the caller asked for "koinos-network" explicitly, or a local
   * request overflowed here after a capability miss (opts.overflowFrom).
   * The privacy gate has already passed in the caller; this method owns
   * the spending checks (§8 budget, §23 signed identity) and the relay.
   */
  async _chatNetwork(body, req, res, { overflowFrom, localError } = {}) {
    // On overflow, errors must say both truths: local couldn't serve, and
    // why the network fallback stopped — otherwise the user sees only half
    // the story and the fix (unlock wallet, raise budget) stays hidden.
    const fail = (status, message, type) => {
      // The local reason can carry an engine stderr tail — keep the chat
      // error readable; the full text lives in the status pane and log.
      const local = String(localError || "").length > 260 ? `${String(localError).slice(0, 260)}…` : localError;
      return this._json(res, status, {
        error: {
          message: overflowFrom
            ? `Local model "${overflowFrom}" is unavailable (${local}) and network fallback failed: ${message}`
            : message,
          type,
        },
      });
    };
    const { schedulerUrl } = this.network.status();
    if (!schedulerUrl) {
      return fail(400, "No scheduler URL configured for network requests", "invalid_request_error");
    }
    // Multi-class serving: "koinos-network" routes "auto" (the best class
    // online), "koinos-network:CLASS" pins an explicit class, and a §7
    // overflow asks for exactly the model that couldn't serve locally —
    // same quality, different machine, honestly refused if nobody holds it.
    const picked = String(body.model || "");
    const netModel =
      overflowFrom ||
      (picked.startsWith("koinos-network:") ? picked.slice("koinos-network:".length) : picked && picked !== "koinos-network" ? picked : "auto");
    if (this.koinFundedConsume || this.network.status().koinRehearsal) {
      return this._chatKoinRehearsal(body, req, res, { schedulerUrl, netModel, fail });
    }
    // §7 context: refuse an oversized prompt BEFORE buying tokens — the
    // provider would fail on it and the failure would still be billed.
    const netCtx = (await this._networkRates(schedulerUrl, netModel)).ctxTokens;
    const estTok = estimateMessageTokens(body.messages);
    if (estTok > netCtx - CTX_HEADROOM_TOKENS) {
      return fail(400, `Prompt is ~${estTok} tokens — larger than the network's ${netCtx}-token class. Shorten the prompt.`, "invalid_request_error");
    }
    // §8 budgets: a key whose monthly network budget is spent stops HERE,
    // before any tokens are bought. Local inference is never gated.
    const meterKey = req._apiKey || null;
    if (meterKey && this.keys.budgetRemainingMicro(meterKey.id) <= 0) {
      return fail(429, "This API key's monthly network budget is exhausted. Raise the budget in the Local API tab or wait for next month.", "insufficient_quota");
    }
    // §23: sign the request with the earning account — the network meters
    // per-address, so anonymous requests would be someone else's bill.
    const ident = this.network.signConsume ? await this.network.signConsume(body.messages) : null;
    if (!ident) {
      return fail(400, "Koinos Network requests are signed by your earning account — create or unlock it in the Earn tab first", "invalid_request_error");
    }
    let upstream;
    try {
      upstream = await fetch(`${schedulerUrl.replace(/\/$/, "")}/consume/chat/completions`, {
        method: "POST",
        // Fresh TCP: an idle-dropped pooled connection must never eat a
        // paid network request (see worker.js — same field finding).
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ messages: body.messages, model: netModel, stream: !!body.stream, ...ident }),
        signal: AbortSignal.timeout(190000), // streamed big-class answers run minutes
      });
    } catch (e) {
      return fail(502, `Network request failed: ${e.message}`, "server_error");
    }
    // Live network stream: relay scheduler SSE frames as OpenAI-style
    // chunks so the UI paints words as the provider generates them.
    if (body.stream && (upstream.headers.get("content-type") || "").includes("text/event-stream") && upstream.ok) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let servedModel = null;
      let finalUsage = null;
      let buf = "";
      const decoder = new TextDecoder();
      const emit = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      for await (const chunk of upstream.body) {
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            let f;
            try {
              f = JSON.parse(data);
            } catch {
              continue;
            }
            if (f.model && !servedModel) servedModel = f.model;
            if (f.servedModel) servedModel = f.servedModel;
            if (f.delta) {
              emit({ object: "chat.completion.chunk", model: "koinos-network", servedModel, choices: [{ index: 0, delta: { content: f.delta } }] });
            }
            if (f.error) {
              emit({ object: "chat.completion.chunk", model: "koinos-network", choices: [{ index: 0, delta: { content: `\n[network: ${f.error}]` } }] });
            }
            if (f.done) finalUsage = f.usage || null;
          }
        }
      }
      if (meterKey && finalUsage) {
        const rates = await this._networkRates(schedulerUrl, servedModel || netModel);
        const inTok = Number(finalUsage.prompt_tokens || 0);
        const outTok = Number(finalUsage.completion_tokens || 0);
        this.keys.recordUsage(meterKey.id, {
          inTok,
          outTok,
          costMicro: Math.ceil((inTok * rates.inMicroPerM + outTok * rates.outMicroPerM) / 1e6),
        });
      }
      emit({ object: "chat.completion.chunk", model: "koinos-network", servedModel, choices: [{ index: 0, delta: {} }] });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    const j = await upstream.json().catch(() => null);
    // Scheduler-side failures ("no providers online") go through fail() too —
    // relaying them raw dropped the local half of the story on overflow
    // (field finding: users saw only 'no providers serving "koinos-fast"'
    // when the actual trigger was their local model failing to load).
    if (!upstream.ok || !j) {
      return fail(upstream.status || 502, j?.error?.message || "bad upstream reply", j?.error?.type || "server_error");
    }
    if (meterKey && j.usage) {
      // Estimated at published network rates regardless of any free
      // allowance — the budget is the developer's conservative guardrail.
      const rates = await this._networkRates(schedulerUrl, j.servedModel || netModel);
      const inTok = Number(j.usage.prompt_tokens || 0);
      const outTok = Number(j.usage.completion_tokens || 0);
      this.keys.recordUsage(meterKey.id, {
        inTok,
        outTok,
        costMicro: Math.ceil((inTok * rates.inMicroPerM + outTok * rates.outMicroPerM) / 1e6),
      });
    }
    // §29 transparency: the response's model field always says
    // "koinos-network" (the scheduler sets it; the stream shim matches), so
    // a client can always tell an overflowed answer left the machine.
    if (body.stream) {
      // SSE shim so streaming clients (the app UI) work unchanged.
      res.writeHead(200, { "content-type": "text/event-stream" });
      const content = j.choices?.[0]?.message?.content ?? "";
      res.write(`data: ${JSON.stringify({ object: "chat.completion.chunk", model: "koinos-network", servedModel: j.servedModel || null, choices: [{ index: 0, delta: { content } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    return this._json(res, 200, j);
  }

  async _chatKoinRehearsal(body, req, res, { schedulerUrl, netModel, fail }) {
    const key = req._apiKey || null;
    if (key && this.keys.budgetRemainingMicro(key.id) <= 0) return fail(429, "This API key's monthly network budget is exhausted.", "insufficient_quota");
    let id;
    try { id = require("./koin-network/job-protocol").digest(body.koin_request_id ?? require("crypto").randomBytes(32).toString("hex")); }
    catch { return fail(400, "Invalid KOIN rehearsal request ID", "koin_shadow_error"); }
    const controller = new AbortController(), stop = () => controller.abort();
    const release = this.network.trackShadowRequest(controller);
    res.on("close", stop);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(190000)]);
      const authorization = this.koinFundedConsume ? null : await this.network.shadowAuthorization(signal);
      signal.throwIfAborted();
      const current = this.network.status();
      if (current.privacyMode === "local-only" || current.schedulerUrl !== schedulerUrl) throw Error("Network settings changed");
      const consume = this.koinFundedConsume || require("./koin-network/grant-chat").consume;
      const j = await consume({ schedulerUrl, authorization,
        messages: body.messages, model: netModel, maxOutput: body.max_tokens,
        requestId: id, signal });
      signal.throwIfAborted();
      if (key) this.keys.recordUsage(key.id, { inTok: j.usage.prompt_tokens, outTok: j.usage.completion_tokens, costMicro: 0 });
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.write(`data: ${JSON.stringify({ object: "chat.completion.chunk", model: "koinos-network", servedModel: j.servedModel,
          choices: [{ index: 0, delta: { content: j.choices[0].message.content } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ object: "chat.completion.chunk", model: "koinos-network", servedModel: j.servedModel,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: j.usage, koin: j.koin, requestId: id, warning: j.warning })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      return this._json(res, 200, j);
    } catch (e) {
      if (res.destroyed) return;
      // No legacy retry/fallback: that could make a separately billed job.
      return fail(502, `KOIN rehearsal stopped: ${String(e.message).slice(0, 230)}. Request ID: ${id}`, "koin_shadow_error");
    } finally {
      res.removeListener("close", stop); release();
    }
  }

  /** Published network token rates + class context, cached for an hour;
   *  safe defaults. */
  async _networkRates(schedulerUrl, model) {
    // Keyed by URL: switching schedulers must not serve the old one's rates.
    // The full per-class table is cached; the caller picks a class ("auto"
    // and unknown classes estimate at the first/Fast class).
    if (!(this._rates && this._rates.url === schedulerUrl && Date.now() - this._rates.at < 3600000)) {
      let models = null;
      try {
        const r = await fetch(`${schedulerUrl.replace(/\/$/, "")}/pricing`, { headers: { connection: "close" }, signal: AbortSignal.timeout(4000) });
        const j = await r.json();
        if (j?.models) models = j.models;
      } catch {
        /* defaults hold */
      }
      this._rates = { url: schedulerUrl, at: Date.now(), models };
    }
    let v = { inMicroPerM: 100000, outMicroPerM: 400000, ctxTokens: 4096 }; // Koinos Fast defaults
    const table = this._rates.models;
    const m = table && ((model && table[model]) || Object.values(table)[0]);
    if (m?.usdPerMInputTokens != null) {
      v = {
        inMicroPerM: Math.round(m.usdPerMInputTokens * 1e6),
        outMicroPerM: Math.round(m.usdPerMOutputTokens * 1e6),
        ctxTokens: Number(m.ctxTokens) || 4096,
      };
    }
    return v;
  }

  /** Serve the bundled desktop UI (localhost only; no traversal, no listing). */
  _static(urlPath, res) {
    const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const file = nodePath.normalize(nodePath.join(this.uiDir, rel));
    if (!file.startsWith(nodePath.normalize(this.uiDir + nodePath.sep))) {
      return this._json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
    }
    return this._staticFile(file, res);
  }

  _staticFile(file, res) {
    fs.readFile(file, (err, data) => {
      if (err) return this._json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
      res.writeHead(200, {
        "content-type": MIME[nodePath.extname(file)] || "application/octet-stream",
        "content-length": data.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(data);
    });
  }

  /**
   * Raw byte proxy to the runtime. Streaming (SSE) and non-streaming both
   * pass through untouched, so OpenAI SDK clients behave identically against
   * llama-server's already-compatible responses.
   */
  _proxy(endpoint, upstreamPath, bodyBuffer, req, res, { meter = null, extraHeaders = null, injectJson = null } = {}) {
    return new Promise((resolve) => {
      const target = new URL(upstreamPath, endpoint);
      const up = http.request(
        target,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(bodyBuffer),
            accept: req.headers.accept || "*/*",
          },
        },
        (upRes) => {
          const head = () =>
            res.writeHead(upRes.statusCode || 502, {
              "content-type": upRes.headers["content-type"] || "application/json",
              ...(extraHeaders || {}),
            });
          /*
           * Non-streaming responses can carry `koinos.citations` in the body,
           * which means holding the bytes back until they can be merged. Only
           * ever for JSON: an SSE stream is piped through untouched, because
           * buffering a stream would defeat the point of streaming. The header
           * carries the citations either way, so a streaming caller is not
           * left guessing what the answer rested on.
           */
          const buffering = Boolean(injectJson);
          const held = [];
          let heldBytes = 0;
          let flushed = false;
          const flush = () => {
            if (flushed) return;
            flushed = true;
            head();
            for (const c of held) res.write(c);
            upRes.pipe(res);
          };

          // §8 metering tee: collect a bounded copy of the response so token
          // usage can be attributed to the API key — JSON bodies directly,
          // SSE via the last chunk that carries a usage block. Best-effort;
          // the byte stream to the client is untouched.
          let tee = meter ? [] : null;
          let teeBytes = 0;
          if (meter) {
            upRes.on("data", (c) => {
              if (teeBytes > 4 * 1024 * 1024) return; // cap: pathological bodies
              tee.push(c);
              teeBytes += c.length;
            });
          }
          if (buffering) {
            upRes.on("data", (c) => {
              if (flushed) return;
              held.push(c);
              heldBytes += c.length;
              // Pathological body: stop trying to merge, start streaming.
              if (heldBytes > 4 * 1024 * 1024) flush();
            });
          } else {
            head();
            upRes.pipe(res);
          }
          upRes.on("end", () => {
            if (buffering && !flushed) {
              flushed = true;
              const ctype = String(upRes.headers["content-type"] || "application/json");
              let out = Buffer.concat(held);
              if (/json/i.test(ctype) && (upRes.statusCode || 0) < 400) {
                try {
                  const parsed = JSON.parse(out.toString("utf8"));
                  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    out = Buffer.from(JSON.stringify({ ...parsed, ...injectJson }));
                  }
                } catch {
                  /* not JSON after all — send it through exactly as received */
                }
              }
              res.writeHead(upRes.statusCode || 502, {
                "content-type": ctype,
                "content-length": Buffer.byteLength(out),
                ...(extraHeaders || {}),
              });
              res.end(out);
            }
            if (meter && (upRes.statusCode || 0) < 400) {
              try {
                const body = Buffer.concat(tee).toString("utf8");
                let usage = null;
                if (body.trimStart().startsWith("{")) {
                  usage = JSON.parse(body).usage ?? null;
                } else {
                  for (const line of body.split("\n")) {
                    if (line.startsWith("data: ") && line.includes('"usage"')) {
                      const parsed = JSON.parse(line.slice(6));
                      if (parsed.usage) usage = parsed.usage;
                    }
                  }
                }
                if (usage) meter(usage);
              } catch {
                /* metering never breaks the response */
              }
            }
            resolve();
          });
        }
      );
      up.on("error", (e) => {
        this._json(res, 502, { error: { message: `Runtime unreachable: ${e.message}`, type: "server_error" } });
        resolve();
      });
      // Client abort (e.g. user stops generation) cancels the upstream too.
      res.on("close", () => up.destroy());
      up.end(bodyBuffer);
    });
  }

  _modules() {
    return {
      gateway: { ok: true, port: this.port },
      runtime: this.runtime.status(),
      models: { ok: true, ...this.models.storageUsage() },
    };
  }
}

module.exports = { Gateway, estimateMessageTokens, hasImageParts };
