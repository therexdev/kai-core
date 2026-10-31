"use strict";

/*
 * Koinos AI Core (spec §4) — the persistent service everything else talks to.
 * The desktop UI is a client; the headless Koinos AI Server (§9) reuses this
 * entrypoint unchanged. M1 modules: hardware detection, model manager,
 * llama.cpp runtime manager, local OpenAI-compatible gateway.
 *
 * Environment:
 *   KAI_CORE_DATA   data directory   (default ~/.koinos-ai)
 *   KAI_CORE_PORT   gateway port     (default 41100, always 127.0.0.1)
 *   KAI_LLAMA_BIN   path to llama-server (default <data>/runtimes/llamacpp/llama-server)
 */

const os = require("os");
const path = require("path");

const { JsonStore } = require("./lib/store");
const hardware = require("./lib/hardware");
const { ApiKeys } = require("./lib/keys");
const { ModelManager } = require("./lib/model-manager");
const { RuntimeProvisioner } = require("./lib/runtime-provisioner");
const { LlamaCppRuntime } = require("./lib/runtimes/llamacpp");
const { RuntimeManager } = require("./lib/runtime-manager");
const { Gateway } = require("./lib/gateway");

const { channelConfig } = require("./lib/release-channel");

const VERSION = require("./package.json").version;
// The project-operated scheduler (§12): baked in so Start Earning and
// network mode work out of the box. KAI_SCHEDULER_URL overrides for
// self-hosters; the Earn tab field overrides per machine.
const DEFAULT_SCHEDULER_URL = process.env.KAI_SCHEDULER_URL || "https://koinosai.com/scheduler";

async function createCore({ dataDir, port, llamaBin, sessionSecret, onEvent, creditAccountOrigin = null, uiDirectory = null } = {}) {
  const release = channelConfig();
  dataDir = dataDir || process.env.KAI_CORE_DATA || path.join(os.homedir(), release.homeDirName);
  // Every event also lands in <dataDir>/core.log so packaged-app failures
  // in the field are diagnosable ("Model load failed" has a paper trail).
  const fsl = require("fs");
  fsl.mkdirSync(dataDir, { recursive: true });
  const logFile = path.join(dataDir, "core.log");
  const sink = onEvent || ((e) => console.log(`[core] ${e.type}`, e.message ?? ""));
  const events = (e) => {
    try {
      const detail = e.message ?? e.reason ?? e.error ?? e.endpoint ?? e.code ?? e.pct ?? "";
      fsl.appendFileSync(logFile, `${new Date().toISOString()} ${e.type} ${detail}\n`);
    } catch {
      /* logging must never break the app */
    }
    sink(e);
  };

  const settings = new JsonStore(path.join(dataDir, "settings.json"), {});
  const state = new JsonStore(path.join(dataDir, "state.json"), {});
  const hw = await hardware.detect({ dataDir });

  const keys = new ApiKeys(settings);
  const models = new ModelManager({
    catalogPath: path.join(__dirname, "models", "catalog.json"),
    modelsDir: path.join(dataDir, "models"),
    state,
    onEvent: events,
  });

  // KAI_LLAMA_BIN (or the llamaBin option) forces a specific binary and skips
  // provisioning; otherwise the right build is fetched on first need.
  const forcedBin = llamaBin || process.env.KAI_LLAMA_BIN || null;
  const provisioner = forcedBin
    ? null
    : new RuntimeProvisioner({
        catalogPath: path.join(__dirname, "runtimes", "catalog.json"),
        runtimesDir: path.join(dataDir, "runtimes"),
        hardware: hw,
        onEvent: events,
      });

  const { OllamaRuntime } = require("./lib/runtimes/ollama");
  const ollamaAddr = {
    host: process.env.KAI_OLLAMA_HOST || "127.0.0.1",
    port: Number(process.env.KAI_OLLAMA_PORT || release.ollamaPort),
  };
  const runtime = new RuntimeManager({
    models,
    hardware: hw,
    provisioner,
    state,
    appVersion: VERSION,
    onEvent: events,
    makeRuntime: (binPath) => new LlamaCppRuntime({ binPath: binPath || forcedBin, onEvent: events }),
    // Ollama is the deep-fallback engine (§6): a system install if present,
    // otherwise Core provisions its own portable build (hash-pinned like
    // every engine) — used when the managed llama.cpp build can't run here,
    // or forced via KAI_RUNTIME. Nobody is ever sent to a website.
    makeFallback: async () =>
      (await OllamaRuntime.ensureRunning({
        ...ollamaAddr,
        onEvent: events,
        provision: () => provisioner.ensure("ollama", { cap: "cpu" }),
        modelsDir: path.join(dataDir, "ollama-models"),
      }))
        ? new OllamaRuntime({ ...ollamaAddr, onEvent: events })
        : null,
    preferFallback: process.env.KAI_RUNTIME === "ollama",
  });

  // Earn controller (M2 §5.7): wallet + worker behind the control plane.
  // Wallet keys stay in Core (§8); the worker only starts on explicit opt-in
  // and stops immediately on request (§10).
  const { WalletService } = require("./lib/wallet");
  const wallet = new WalletService(path.join(dataDir, "wallet"));
  let worker = null;
  let loadGuard = null; // lives exactly as long as the worker does
  // Machine session (§8-compatible): the Electron shell passes a secret held
  // by the OS (safeStorage/DPAPI); with it, an unlocked wallet survives app
  // restarts — no password re-typing — until the user presses Lock.
  sessionSecret = sessionSecret || process.env.KAI_SESSION_SECRET || null;
  if (sessionSecret && wallet.exists() && wallet.tryResumeSession(sessionSecret)) {
    events({ type: "wallet:session-resumed", message: wallet.address });
  }
  // Like Core's KOIN balance, public Testnet KAI is readable while the wallet
  // is locked and AI privacy is Local-Only. No account, signer or worker needed.
  const legacyBalance = require("./lib/legacy-kai-balance").createLegacyKaiBalance({
    getAddress: () => wallet.address,
    getSchedulerUrl: () => settings.get("earn.schedulerUrl", DEFAULT_SCHEDULER_URL),
  });
  const fetchEarnings = () => legacyBalance.read();
  const { inactiveStatus, shadowStatus } = require("./lib/koin-network/status");
  let koinCache = { key: "", at: 0, data: null };
  const fetchKoinStatus = async () => {
    if (!worker?.running && settings.get("network.privacyMode", "local-only") === "local-only") return inactiveStatus("local-only");
    if (!worker?._koinAvailable && !legacyBalance.last?.koinShadow) return inactiveStatus("unavailable");
    const url = settings.get("earn.schedulerUrl", DEFAULT_SCHEDULER_URL).replace(/\/$/, "");
    const address = wallet.address, key = `${url}|${address}`;
    if (!address) return inactiveStatus();
    if (koinCache.key === key && Date.now() - koinCache.at < 30000) return koinCache.data;
    let data = inactiveStatus("unavailable");
    try {
      const response = await fetch(`${url}/koin/status?address=${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(4000) });
      if (response.ok) data = shadowStatus(await response.json());
    } catch { /* old masters do not expose shadow telemetry */ }
    koinCache = { key, at: Date.now(), data };
    return data;
  };
  const earn = {
    legacyBalance: async () => ({ wallet: { address: wallet.address }, earnings: await fetchEarnings() }),
    status: async () => ({
      wallet: wallet.status(),
      worker: worker ? worker.status() : { running: false, jobsDone: 0, receiptsAccepted: 0 },
      guard: loadGuard ? loadGuard.status() : null,
      schedulerUrl: settings.get("earn.schedulerUrl", DEFAULT_SCHEDULER_URL),
      earnings: await fetchEarnings(),
      koin: await fetchKoinStatus(),
      // Node reporting belongs to the separately installed Node plugin.
      producerReport: { enabled: false, state: "plugin-managed" },
    }),
    configure: ({ schedulerUrl }) => {
      let u = String(schedulerUrl || "").trim();
      if (u) {
        // A pasted bare host is the common case — repair it rather than
        // letting the worker's fetch throw a cryptic parse error later.
        if (!/^https?:\/\//i.test(u)) u = "https://" + u;
        try {
          new URL(u);
        } catch {
          throw new Error(`That doesn't look like a scheduler URL: "${schedulerUrl}"`);
        }
      } else {
        // Clearing the field means "back to the network default", not
        // "no scheduler" — a stored empty string would shadow the default.
        u = DEFAULT_SCHEDULER_URL;
      }
      settings.set("earn.schedulerUrl", u);
      legacyBalance.clear();
      syncKillSwitch().catch(() => {}); // §32: check the new scheduler's list promptly
      return earn.status();
    },
    createWallet: ({ password }) => {
      const r = wallet.create({ password });
      if (sessionSecret) wallet.saveSession(sessionSecret);
      events({ type: "wallet:created", message: r.address });
      return r;
    },
    restoreWallet: ({ wif, password }) => {
      const r = wallet.restore({ wif, password });
      if (sessionSecret) wallet.saveSession(sessionSecret);
      events({ type: "wallet:restored", message: r.address });
      return r;
    },
    revealWallet: ({ password }) => {
      const r = wallet.revealWif(password);
      events({ type: "wallet:backup-revealed", message: r.address });
      return r;
    },
    unlock: ({ password }) => {
      // Every attempt lands in core.log — locked-out users need a paper trail.
      try {
        const r = wallet.unlock(password);
        if (sessionSecret) wallet.saveSession(sessionSecret);
        events({ type: "wallet:unlocked", message: r.address });
        return r;
      } catch (e) {
        events({ type: "wallet:unlock-failed", message: String(e.message) });
        throw e;
      }
    },
    lock: async () => {
      loadGuard?.stop();
      loadGuard = null;
      if (worker) await worker.stop();
      wallet.lock(); // also ends the machine session
      settings.set("earn.autoStart", false);
      events({ type: "wallet:locked" });
      return earn.status();
    },
    // Legacy test-token deposits must never become a native KOIN signing path.
    deposit: async () => {
      throw new Error("Credit purchases are unavailable during the KOIN transition. No funds were moved.");
    },
    start: async () => {
      throw new Error("Use Share AI capacity to participate in the network.");
    },
    stop: async ({ userIntent = true } = {}) => {
      loadGuard?.stop();
      loadGuard = null;
      if (worker) await worker.stop();
      if (userIntent) settings.set("earn.autoStart", false);
      return earn.status();
    },
  };

  // §7 routing policy (M3): privacy mode gates all network consumption.
  // local-only is the default — nothing leaves the machine unless chosen.
  // §32 kill switch: poll the scheduler's revocation list. Earning or not,
  // compromised weights must stop serving — chat included. When the ACTIVE
  // model is hit, the engine stops immediately and §7 routing turns the
  // next request into a capability miss, so Local-First machines fail over
  // to the network instead of going dark. Quarantine persists locally;
  // recovery ships as a catalog update with a clean package, never by
  // un-forgetting.
  const syncKillSwitch = async () => {
    // §29 strict: a Local-Only machine emits NOTHING — not even safety
    // polls. Its kill-switch coverage rides app/catalog updates instead;
    // the moment the mode allows network participation, the live list is
    // fetched (network.configure triggers a sync on that transition).
    // EXCEPTION: an actively earning worker is already talking to the
    // scheduler — it must not escape the kill switch on a privacy label.
    const earning = worker && worker.status().running;
    if (!earning && settings.get("network.privacyMode", "local-only") === "local-only") return;
    const base = settings.get("earn.schedulerUrl", DEFAULT_SCHEDULER_URL);
    if (!base) return;
    let revoked;
    try {
      const r = await fetch(`${base.replace(/\/$/, "")}/policy`, { headers: { connection: "close" }, signal: AbortSignal.timeout(8000) });
      revoked = (await r.json())?.revoked;
    } catch {
      return; // unreachable — next tick retries
    }
    if (!Array.isArray(revoked)) return;
    for (const entry of revoked) {
      const hit = models.quarantineBySha(entry.sha256, entry.reason);
      if (!hit.length) continue;
      events({ type: "core:kill-switch", packages: hit, reason: entry.reason });
      const activePkg = runtime.activeAlias ? models.catalog.aliases[runtime.activeAlias]?.package : null;
      if (activePkg && hit.includes(activePkg)) {
        if (worker && worker.status().running) {
          await earn.stop({ userIntent: false }).catch(() => {});
        }
        runtime.stop();
        events({ type: "core:kill-switch-stopped-engine", package: activePkg });
      }
    }
  };

  const koinShadowConsumerUrl = process.env.KAI_KOIN_SHADOW_CONSUMER_URL || "";
  const shadowRequests = new Set();
  const network = {
    status: () => ({
      privacyMode: settings.get("network.privacyMode", "local-only"),
      schedulerUrl: settings.get("earn.schedulerUrl", DEFAULT_SCHEDULER_URL),
      walletUnlocked: wallet.status().unlocked,
      koinRehearsal: Boolean(koinShadowConsumerUrl),
    }),
    shadowAuthorization: signal => account.shadowAuthorization(koinShadowConsumerUrl, signal),
    trackShadowRequest: controller => { shadowRequests.add(controller); return () => shadowRequests.delete(controller); },
    overview: signal => require("./lib/network-overview").readPublicNetworkOverview({ network, signal }),
    // §23: network requests are signed by the earning account — identity and
    // metering in one. Null when there's no unlocked wallet to sign with.
    signConsume: async (messages) => {
      const s = wallet.status();
      if (!s.unlocked || !s.address) return null;
      const ts = Date.now();
      const cryptoNode = require("crypto");
      const hash = cryptoNode
        .createHash("sha256")
        .update(`consume|${s.address}|${ts}|${JSON.stringify(messages)}`)
        .digest();
      return { address: s.address, ts, signature: await wallet.signHash(hash) };
    },
    configure: ({ privacyMode }) => {
      const m = String(privacyMode || "");
      if (!["local-only", "local-first", "network"].includes(m)) {
        throw new Error("privacyMode must be local-only, local-first, or network");
      }
      settings.set("network.privacyMode", m);
      if (m === "local-only") for (const controller of shadowRequests) controller.abort();
      // §32: the moment network participation is allowed, fetch the
      // safety list — don't wait out the poll interval.
      if (m !== "local-only") syncKillSwitch().catch(() => {});
      return network.status();
    },
  };

  // Shared foundation services only. Optional engines are installed packages.
  const uiDir = uiDirectory || path.join(__dirname, "..", "ui-core");
  let safeStorage = null;
  try { safeStorage = require("electron").safeStorage; } catch {}
  const { AccountService } = require("./lib/account");
  const account = new AccountService({ dataDir, settings, wallet, safeStorage, onEvent: events });
  const creditAccount = creditAccountOrigin ? new AccountService({ dataDir, settings, wallet,
    safeStorage: wallet.creditStorage(safeStorage, creditAccountOrigin), onEvent: events, accountOrigin: creditAccountOrigin }) : null;
  const gateway = new Gateway({
    port: port ?? Number(process.env.KAI_CORE_PORT || release.port),
    runtime,
    models,
    keys,
    onEvent: events,
    uiDir: require("fs").existsSync(uiDir) ? uiDir : null,
    staticAssets: new Map(),
    earn, network, account, creditAccount,
    coreInfo: () => ({ version: VERSION, channel: release.channel, productName: release.productName, dataDir, hardware: hw }),
    // Feedback relay: one honest box in the app, straight to the project's
    // inbox. The diagnostic tail is core.log — events only, no chat
    // content and no keys ever land there.
    feedback: async ({ message, email, includeLog }) => {
      const text = String(message || "").trim().slice(0, 4000);
      if (!text) throw new Error("Feedback needs a message");
      let logTail = null;
      if (includeLog) {
        try {
          const raw = fsl.readFileSync(logFile, "utf8");
          logTail = raw.split("\n").slice(-120).join("\n").slice(-16000);
        } catch { /* no log yet */ }
      }
      const target = process.env.KAI_FEEDBACK_URL || "https://koinosai.com/api/feedback";
      const r = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: text,
          email: email ? String(email).slice(0, 200) : null,
          appVersion: VERSION,
          platform: `${process.platform}-${process.arch}`,
          logTail,
        }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => {
        throw new Error("Could not reach the feedback server — check your connection and try again");
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error || `Feedback server answered ${r.status}`);
      events({ type: "feedback:sent" });
      return {};
    },
  });

  return {
    settings, account, creditAccount, state, hardware: hw, keys, models, runtime, gateway,
    async start() {
      const p = await gateway.listen();
      events({ type: "core:ready", message: `gateway on http://127.0.0.1:${p}` });
      const ready = models.aliases().filter(a => a.status === "ready");
      if (ready.length === 1) runtime.ensure(ready[0].alias).catch(error => events({type:"runtime:warmstart-failed",message:error.message}));
      syncKillSwitch().catch(() => {});
      this._policyTimer = setInterval(() => syncKillSwitch().catch(() => {}), 5 * 60 * 1000);
      this._policyTimer.unref?.();
      return p;
    },
    async stop() {
      gateway.stopModelQueue();
      for (const controller of shadowRequests) controller.abort();
      wallet.disposeCreditStorage();
      if (this._policyTimer) clearInterval(this._policyTimer);
      await earn.stop({userIntent:false}).catch(() => {});
      runtime.stop();
      await gateway.close();
    },
  };
}
module.exports = { createCore, VERSION };
