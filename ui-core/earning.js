(function (root) {
  "use strict";
  const POLL = 15000, MAX_ATOMS = (1n << 64n) - 1n;
  const rewardStates = {
    awaiting_review: ["Awaiting review", "pending"], reviewing: ["In 24-hour review", "pending"],
    finalizing: ["Finalizing reward", "pending"], queued: ["Queued", "pending"], signing: ["Preparing payment", "pending"],
    staged: ["Ready to submit", "pending"], unknown: ["Checking payment", "pending"], pending: ["Payment pending", "pending"],
    reversible: ["Awaiting finality", "pending"], needs_review: ["Needs attention", "attention"], paid: ["Paid", "paid"], paid_elsewhere: ["Paid", "paid"]
  };
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const message = value => {
    const text = String(value?.message || value || "Provider setup could not be reached.").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
    return /Unexpected token.*<|<!DOCTYPE/i.test(text) ? "The credit service returned a web page instead of setup data. Check the connection, then reload setup." : text;
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  const selectionKey = selection => JSON.stringify([selection?.mode, [...(selection?.models || [])].sort()]);
  const validSelection = value => value && ["all", "selected"].includes(value.mode) && Array.isArray(value.models) && value.models.length <= 64 && value.models.every(id => typeof id === "string" && /^[a-zA-Z0-9._-]{1,100}$/.test(id));
  const modelRows = info => (Array.isArray(info?.modelAvailability) ? info.modelAvailability : (info?.models || []).map(model => ({ ...model, compatible: true })))
    .filter(model => model?.installed && typeof model.id === "string" && /^[a-zA-Z0-9._-]{1,100}$/.test(model.id)).slice(0, 64);
  const selectedModels = (selection, models) => new Set(selection?.mode === "all" ? models.filter(model => model.compatible).map(model => model.id) : selection?.models || []);
  const freshRows = (status, now) => (Array.isArray(status?.models) ? status.models : status?.model ? [status] : [])
    .filter(row => Number.isSafeInteger(row.validUntil) && row.validUntil > now);
  function qualificationDetail(q) {
    if (!q) return "";
    let detail = `${q.kind === "runtime-readiness" ? "Readiness check" : "Network check"}: ${q.passed}/${q.total} passed · ${q.completed}/${q.total} completed.`;
    detail += Number.isSafeInteger(q.required) ? ` Required: ${q.required}/${q.total}.` : " Required score was not reported by this server.";
    if (q.phase === "preparing") detail += " Preparing the model before timed checks.";
    if (q.state === "failed") {
      if (q.failure?.code === "preparation_timeout") detail += " Model preparation did not finish before its deadline.";
      if (q.failure?.deadlines > 0) detail += ` ${q.failure.deadlines} checks did not finish before their deadline.`;
      if (q.failure?.wrongAnswers > 0) detail += ` ${q.failure.wrongAnswers} answers did not match the required output.`;
      if (!q.failure || q.failure.code === "unknown") detail += " The network did not report a complete failure reason.";
      if (Number.isSafeInteger(q.retryAt)) detail += ` Retry scheduled for ${new Date(q.retryAt).toLocaleTimeString()}.`;
    }
    return detail;
  }
  function providerPresentation(state, now = Date.now()) {
    const info = state.info, on = info?.enabled === true || state.action === "start";
    const enrollment = info && !info.deviceAuthorized && info.canAuthorize === true && ["authorization-required", "authorization-expired", "authorization-revoked", "secure-storage-required", "wallet-required"].includes(info.state);
    const walletSetup = info && (info.walletReady === false || enrollment && info.walletLocked === true);
    const action = on ? "stop" : walletSetup ? "wallet" : enrollment ? "authorize" : "start";
    const toggleLabel = on ? "Stop earning" : walletSetup ? info.walletReady === false ? "Set up earning" : "Unlock to enable earning" : enrollment ? info.secureStorage?.available === false ? "Enable for this session" : "Enable earning" : "Start earning";
    const models = modelRows(info), selected = selectedModels(info?.selection, models), offered = new Set(info?.offeredModels || []);
    const rows = !state.stale && info?.running ? freshRows(state.status, now).filter(row => selected.has(row.model) && offered.has(row.model)) : [];
    const ready = state.busy ? 0 : rows.filter(row => row.state === "online").length;
    let status;
    if (state.busy) status = { state: "checking", label: ({ stop: "STOPPING", start: "STARTING", download: "DOWNLOADING MODEL", authorize: "UPDATING ACCESS", revoke: "UPDATING ACCESS" })[state.action] || "UPDATING SHARING", detail: state.action === "models" ? "Finishing current work before updating the shared models." : "Waiting for the current change to finish." };
    else if (state.error || state.stale) status = { state: "stale", label: "CONNECTION UNCONFIRMED", detail: state.error || "Waiting for a fresh network confirmation." };
    else if (!info) status = { state: "checking", label: "CHECKING SETUP", detail: "Checking wallet, device authorization and installed models." };
    else if (!info.running) status = { state: "offline", label: on ? "RECONNECTING" : info.state === "ready" ? "OFFLINE" : "SETUP REQUIRED", detail: on || info.state !== "ready" ? message(info.blocked || info.detail) : "Ready to share. Start earning prepares the models and connects automatically." };
    else if (validSelection(info.selection)) status = rows.find(row => row.state === "online") || rows.find(row => ["qualifying", "preparing", "connecting"].includes(row.state)) ||
      (state.status?.state === "paused" ? state.status : !rows.length && [state.status?.validUntil, ...(state.status?.models || []).map(row => row.validUntil)].some(time => Number.isSafeInteger(time) && time <= now)
        ? { state: "stale", label: "CONNECTION UNCONFIRMED", detail: "Waiting for a fresh network confirmation." }
        : { state: "checking", label: "WAITING FOR NETWORK", detail: "Sharing is on. None of your selected models is confirmed ready for paid work yet." });
    else status = state.status?.state === "online" && !(Number.isSafeInteger(state.status.validUntil) && state.status.validUntil > now) ? { state: "stale", label: "CONNECTION UNCONFIRMED", detail: "Waiting for a fresh network confirmation." } : state.status || { state: "checking", label: "CHECKING CONNECTION", detail: "Waiting for network confirmation." };
    status = { ...status, label: status.state === "online" ? "ONLINE" : status.label || "CHECKING MODELS" };
    const chosen = models.filter(model => model.compatible && selected.has(model.id)).length;
    return { on, action, toggleLabel, disabled: on ? state.action === "stop" : state.busy || state.stale || !info || !(info.state === "ready" || walletSetup || enrollment),
      status, ready, chosen, models, rows, modelSummary: validSelection(info?.selection) ? info.selection.mode === "all" ? `All compatible installed models (${chosen})` : `${chosen} model${chosen === 1 ? "" : "s"} selected` : info?.model?.label || "Model not confirmed",
      readiness: state.busy ? "Network readiness will refresh when this change finishes." : state.stale ? "Readiness is not confirmed. Waiting for a fresh network status update." : !on ? "Earning is off. Your model selection is saved." : ready ? `${ready} of ${chosen} selected models ready for paid work.` : "No selected model is ready for paid work yet. The network checks each selected model automatically." };
  }
  function validateRewards(value, now, summaryApi) {
    const atom = n => typeof n === "string" && /^(0|[1-9]\d{0,19})$/.test(n) && BigInt(n) <= MAX_ATOMS;
    if (!value || typeof value.walletAddress !== "string" || !value.walletAddress || value.walletAddress.length > 128 || !/^[a-f0-9]{64}$/.test(value.scope || "") ||
        !Number.isSafeInteger(value.observedAt) || value.observedAt < 0 || value.observedAt > now + 5000 || now - value.observedAt > 30000 || !Array.isArray(value.payouts) || value.payouts.length > 64) throw Error("Reward history is unavailable or stale.");
    const seen = new Set();
    const payouts = value.payouts.map(row => {
      if (!row || typeof row.epoch !== "string" || !/^(0|[1-9]\d{0,9})$/.test(row.epoch) || seen.has(row.epoch) || !Object.hasOwn(rewardStates, row.state) || !atom(row.availability) || !atom(row.work) || BigInt(row.availability) + BigInt(row.work) > MAX_ATOMS) throw Error("Reward history could not be verified.");
      seen.add(row.epoch); return { ...row };
    });
    let summary = null;
    try { if (value.summary && summaryApi) summary = summaryApi.validate(value.summary, value.walletAddress, value.observedAt, payouts); } catch { /* Keep verified payouts when the daily estimate is unavailable. */ }
    return { ...value, payouts, summary };
  }
  const amount = atoms => { const value = BigInt(atoms); return `${value / 100000000n}.${String(value % 100000000n).padStart(8, "0")}`; };
  function rewardMarkup(value) {
    const rows = [...(value?.payouts || []), ...(value?.summary?.pending || [])].sort((a, b) => Number(b.epoch) - Number(a.epoch));
    return rows.length ? rows.map(row => {
      const [label, state] = rewardStates[row.state];
      const day = new Date(Number(row.epoch) * 86400000).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
      return `<li class="product-reward-item"><div class="product-reward-item-head"><strong>${esc(amount(BigInt(row.availability) + BigInt(row.work)))} KOIN</strong><span class="product-reward-badge" data-state="${state}">${label}</span></div><span class="product-reward-day">${esc(day)} · UTC</span><small>Availability ${amount(row.availability)} · Work ${amount(row.work)}</small></li>`;
    }).join("") : '<li class="product-reward-empty"><strong>Your rewards will appear here</strong><span>Recorded rewards and payment updates will appear here.</span></li>';
  }
  // Keep the original testnet drop calculation separate from paid KOIN rewards.
  // Scheduler balances may contain exponent notation; convert decimal text to
  // atoms exactly rather than multiplying floating-point token amounts.
  function legacyAtoms(value) {
    if (typeof value !== "string") throw Error("Missing testnet KAI balance");
    const match = /^(0|[1-9]\d{0,19})(?:\.(\d{1,20}))?(?:e([+-]?\d{1,2}))?$/i.exec(value);
    if (!match) throw Error("Invalid testnet KAI balance");
    let atoms = BigInt(match[1] + (match[2] || "")), shift = 8 + Number(match[3] || 0) - (match[2] || "").length;
    if (Math.abs(shift) > 28) throw Error("Invalid testnet KAI precision");
    if (shift >= 0) atoms *= 10n ** BigInt(shift);
    else { const scale = 10n ** BigInt(-shift); if (atoms % scale) throw Error("Invalid testnet KAI precision"); atoms /= scale; }
    if (atoms > MAX_ATOMS) throw Error("Invalid testnet KAI amount");
    return atoms;
  }
  function legacySummary(snapshot) {
    const wallet = snapshot?.wallet?.address, earnings = snapshot?.earnings;
    if (typeof wallet !== "string" || !wallet || wallet.length > 128 || earnings?.address !== wallet || earnings.error) return null;
    try {
      const format = atoms => { const fraction = String(atoms % 100000000n).padStart(8, "0").replace(/0+$/, ""); return (atoms / 100000000n).toLocaleString() + (fraction ? "." + fraction : ""); };
      const kai = legacyAtoms(earnings.kai);
      return { wallet, kai: format(kai), koin: format(kai / 5n) };
    } catch { return null; }
  }
  function createController({ credit, readLegacy, render, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, summaryApi, navigate = () => {} }) {
    const state = { info: null, status: null, draft: null, stale: false, error: "", busy: false, action: "", notice: "", rewards: null, rewardError: "", rewardLoading: false, legacy: null, legacyAt: 0, legacyError: "" };
    let active = false, generation = 0, readRevision = 0, rewardRevision = 0, actionRevision = 0, legacyRevision = 0, pending = false, rewardPending = false, legacyPending = false, providerTimer, rewardTimer, expiryTimer, legacyTimer, legacyExpiryTimer;
    const paint = () => render(state, providerPresentation(state, now()));
    const cancelTimer = timer => { if (timer !== undefined) clearTimer(timer); };
    const read = async (action, request = () => credit(action)) => {
      let timer;
      try { return await Promise.race([request(), new Promise((_, reject) => { timer = setTimer(() => reject(Error("Setup check timed out. Use Reload setup to try again.")), 15000); })]); }
      finally { cancelTimer(timer); }
    };
    function schedule(delay = POLL) { cancelTimer(providerTimer); if (active) providerTimer = setTimer(refreshProvider, delay); }
    function armExpiry() {
      cancelTimer(expiryTimer);
      const times = [state.status?.validUntil, ...(state.status?.models || []).map(row => row.validUntil)].filter(t => Number.isSafeInteger(t) && t > now());
      if (!times.length || !active) return;
      const remaining = Math.min(...times) - now(), g = generation, revision = readRevision;
      expiryTimer = setTimer(() => {
        if (g !== generation || revision !== readRevision || !active) return;
        // Recompute each model against its own expiry; never extend online evidence while a read is pending.
        paint(); armExpiry();
      }, remaining);
      schedule(Math.max(1000, Math.min(10000, remaining - 5000)));
    }
    async function refreshProvider() {
      if (!active || pending || state.busy) return;
      pending = true; cancelTimer(providerTimer);
      const g = generation, revision = readRevision;
      const current = () => active && g === generation && revision === readRevision;
      try {
        const info = await read("provider-public-info"); if (!current()) return;
        if (!info || typeof info.state !== "string") throw Error("Provider setup is unavailable. Check your network mode in Settings.");
        const status = info.running ? await read("provider-public-status") : null; if (!current()) return;
        if (validSelection(info.selection) && (!state.draft || !validSelection(state.info?.selection) || selectionKey(info.selection) !== selectionKey(state.info.selection))) state.draft = clone(info.selection);
        if (!validSelection(info.selection)) state.draft = null;
        state.info = info; state.status = status; state.stale = false; state.error = "";
        paint(); schedule(); armExpiry();
      } catch (error) {
        if (!current()) return;
        state.stale = true; state.error = message(error); cancelTimer(expiryTimer); paint(); schedule();
      } finally { if (g === generation && revision === readRevision) pending = false; }
    }
    async function refreshRewards() {
      if (!active || rewardPending) return;
      rewardPending = true; cancelTimer(rewardTimer);
      const g = generation, revision = rewardRevision;
      const current = () => active && g === generation && revision === rewardRevision;
      try {
        const value = await read("provider-public-earnings"); if (!current()) return;
        state.rewards = validateRewards(value, now(), summaryApi); state.rewardError = "";
      } catch (error) { if (current()) state.rewardError = message(error); }
      finally {
        if (g === generation && revision === rewardRevision) { rewardPending = false; state.rewardLoading = false; if (active) { paint(); rewardTimer = setTimer(refreshRewards, POLL); } }
      }
    }
    async function refreshLegacy() {
      if (!active || legacyPending || typeof readLegacy !== "function") return;
      legacyPending = true; cancelTimer(legacyTimer);
      const g = generation, revision = legacyRevision;
      const current = () => active && g === generation && revision === legacyRevision;
      try {
        const snapshot = await read("legacy-balance", readLegacy); if (!current()) return;
        const value = legacySummary(snapshot);
        if (!value) throw Error(snapshot?.earnings?.error || "Testnet KAI balance is unavailable.");
        state.legacy = value; state.legacyAt = now(); state.legacyError = "";
        cancelTimer(legacyExpiryTimer);
        legacyExpiryTimer = setTimer(() => {
          if (!current()) return;
          state.legacy = null; state.legacyAt = 0; state.legacyError = "Waiting for a fresh testnet KAI balance."; paint();
        }, 30000);
      } catch (error) {
        if (!current()) return;
        state.legacy = null; state.legacyAt = 0; state.legacyError = message(error); cancelTimer(legacyExpiryTimer);
      } finally {
        if (g === generation && revision === legacyRevision) { legacyPending = false; if (active) { paint(); legacyTimer = setTimer(refreshLegacy, POLL); } }
      }
    }
    async function action(name, input) {
      if (!["start", "stop", "authorize", "revoke", "download", "model", "models"].includes(name) || state.busy && name !== "stop") return;
      if (name === "models" && (!validSelection(input) || !modelRows(state.info).some(model => model.compatible && selectedModels(input, modelRows(state.info)).has(model.id)))) return;
      const g = generation, operation = ++actionRevision;
      const current = () => g === generation && operation === actionRevision;
      ++readRevision; pending = false; cancelTimer(providerTimer); cancelTimer(expiryTimer);
      state.busy = true; state.action = name; state.stale = true; state.notice = ""; state.error = ""; paint();
      try {
        const result = await credit("provider-public-" + name, input); if (!current()) return;
        if (name === "authorize" && result?.state === "authorized") {
          state.action = "start"; paint(); await credit("provider-public-start"); if (!current()) return;
        }
        if (result?.state === "cancelled") state.notice = "Device authorization was not changed.";
        if (name === "models") state.draft = null;
        if (name === "stop" && state.info) state.info = { ...state.info, enabled: false, running: false };
      } catch (error) { if (current()) state.notice = message(error); }
      finally { if (current()) { state.busy = false; state.action = ""; paint(); await refreshProvider(); } }
    }
    function toggle() {
      const view = providerPresentation(state, now()); if (view.disabled) return;
      if (view.action === "wallet") navigate("wallet");
      else return action(view.action, view.action === "authorize" ? { sessionOnly: state.info?.secureStorage?.available === false } : undefined);
    }
    function editSelection(id, checked) {
      if (state.busy || !state.info || !state.draft) return;
      if (id === null) state.draft = checked ? { mode: "all", models: [] } : { mode: "selected", models: [] };
      else {
        const models = modelRows(state.info); if (!models.some(model => model.id === id && model.compatible)) return;
        const selected = selectedModels(state.draft, models); if (checked) selected.add(id); else selected.delete(id);
        state.draft = { mode: "selected", models: [...selected] };
      }
      state.notice = ""; paint();
    }
    function leave() { active = false; ++readRevision; ++rewardRevision; ++legacyRevision; pending = false; rewardPending = false; legacyPending = false; cancelTimer(providerTimer); cancelTimer(rewardTimer); cancelTimer(expiryTimer); cancelTimer(legacyTimer); cancelTimer(legacyExpiryTimer); state.legacy = null; state.legacyAt = 0; }
    function enter() {
      if (active) return;
      active = true; state.rewardLoading = !state.rewards; paint(); armExpiry();
      void refreshProvider(); void refreshRewards(); void refreshLegacy();
    }
    function reset() {
      const wasActive = active; leave(); ++generation; ++actionRevision; rewardPending = false;
      Object.assign(state, { info: null, status: null, draft: null, stale: false, error: "", busy: false, action: "", notice: "", rewards: null, rewardError: "", rewardLoading: false, legacy: null, legacyAt: 0, legacyError: "" });
      paint(); if (wasActive) enter();
    }
    return { enter, leave, reset, refresh: () => Promise.all([refreshProvider(), refreshRewards(), refreshLegacy()]), action, toggle, editSelection,
      resetSelection() { if (!state.busy && validSelection(state.info?.selection)) { state.draft = clone(state.info.selection); state.notice = ""; paint(); } },
      applySelection() { if (state.draft) return action("models", clone(state.draft)); }, getState: () => state };
  }

  function mount(document, bridge) {
    const host = document.getElementById("earning-content"); if (!host) return;
    host.innerHTML = `<div class="product-earn"><header class="product-page-head"><h1>Share your AI. Earn KOIN.</h1><p>Contribute this computer’s spare AI capacity to the network.</p></header>
      <div class="product-two"><section class="product-panel product-provider"><div class="product-row"><span>Share AI capacity</span><button id="earning-toggle" role="switch" aria-checked="false" aria-label="Share AI capacity" aria-describedby="provider-start-hint provider-readiness" disabled>Start earning</button></div><p id="provider-start-hint" class="product-fine">Click the button to start earning.</p><div class="product-provider-state"><span id="provider-dot" class="product-live-dot" aria-hidden="true"></span><h2 id="provider-label" data-state="checking">CHECKING SETUP</h2><p id="provider-detail">Checking wallet, device authorization and installed models.</p><p id="provider-qualification" hidden></p></div><div class="product-divider"></div><strong id="provider-model">Model not confirmed</strong><p id="provider-readiness" class="product-fine">Waiting for current model and network confirmation.</p><button id="provider-models-open" hidden>Choose shared models</button></section>
      <section class="product-panel product-rewards" aria-labelledby="reward-title"><div class="product-reward-heading"><div class="product-reward-heading-copy"><h2 id="reward-title">Reward activity</h2><p class="product-reward-intro">Your KOIN rewards, as they are recorded and paid.</p></div><div id="earn-legacy-drop" class="product-legacy-drop" aria-label="Testnet KAI and estimated KOIN drop"><span>Wallet KAI: <b id="earn-wallet-kai">—</b></span><span>KOIN Drop: <b id="earn-koin-drop">—</b></span><small id="earn-legacy-status" role="status">Estimated drop · 1 KOIN per 5 KAI</small></div></div><div class="product-reward-summary"><div><span>Today’s availability</span><strong id="reward-today">—</strong><small id="reward-today-detail">Waiting for a verified estimate.</small></div><div><span>Awaiting payment</span><strong id="reward-pending">—</strong><small id="reward-pending-detail">Rewards are reviewed before payment.</small></div></div><p id="reward-status" class="product-fine" role="status">Loading reward history…</p><ol id="rewards" class="product-reward-feed" aria-label="Reward activity" tabindex="0">${rewardMarkup(null)}</ol><p id="reward-updated" class="product-fine product-reward-updated">KOIN rewards are separate from chat credits.</p></section></div>
      <section id="provider-models" class="product-panel product-provider-models" hidden><h2>Models you share</h2><label class="product-share-all"><span>Share all compatible installed models</span><input type="checkbox" id="provider-share-all" class="product-switch-input" role="switch" checked></label><p class="product-fine">Models load as needed. Each model must pass its network check and be approved before it can earn from paid work.</p><p id="provider-model-summary" role="status"></p><div id="provider-model-list"></div><p id="provider-selection-status" class="product-fine" role="status" hidden></p><div id="provider-selection-actions" class="product-actions" hidden><button id="provider-models-apply" class="primary">Apply selection</button><button id="provider-models-reset">Cancel changes</button></div></section>
      <details id="provider-advanced" class="product-panel product-provider-advanced"><summary>Connection and setup</summary><div class="product-provider-advanced-content"><div id="provider-model-choice" hidden><label for="provider-model-pick">Startup model</label><select id="provider-model-pick" disabled><option value="">Choose a provider model</option></select><p class="product-fine">Sharing prepares installed models automatically.</p></div><p id="provider-setup" role="status">Start earning to prepare the installed models and connect.</p><p id="provider-authorization" class="product-fine" hidden></p><div id="provider-action-message" class="dismissible-notice inline-notice" hidden><p id="provider-action-notice" role="status"></p><button id="provider-action-close" class="notice-close" type="button" aria-label="Dismiss message" title="Dismiss message"><span aria-hidden="true">×</span></button></div><div class="product-actions"><button id="provider-reload">Reload setup</button><button id="provider-revoke" hidden>Remove device authorization</button><button id="provider-download" hidden>Download approved model</button><button id="provider-cancel" hidden>Cancel setup</button><button id="provider-wallet">Reward wallet</button><button id="provider-open-models">Manage models</button></div></div></details></div>`;
    const $ = id => document.getElementById(id);
    const actionNotice = root.KaiCoreNotice.create({ container: $("provider-action-message"), message: $("provider-action-notice"), close: $("provider-action-close"), focusTarget: () => $("provider-reload") });
    const text = (id, value) => { const node = $(id), next = String(value ?? ""); if (node.textContent !== next) node.textContent = next; };
    const hide = (id, value) => { if ($(id).hidden !== value) $(id).hidden = value; };
    const disable = (id, value) => { if ($(id).disabled !== value) $(id).disabled = value; };
    const navigate = page => root.dispatchEvent(new root.CustomEvent("kai-core-navigate", { detail: { page } }));
    function paintModels(state, presentation) {
      const info = state.info, valid = validSelection(info?.selection) && state.draft;
      hide("provider-models", !valid); hide("provider-models-open", !valid); if (!valid) return;
      const models = presentation.models, selected = selectedModels(info.selection, models), draft = selectedModels(state.draft, models), offered = new Set(info.offeredModels || []);
      const rows = new Map(presentation.rows.map(row => [row.model, row])), dirty = selectionKey(state.draft) !== selectionKey(info.selection);
      if ($("provider-share-all").checked !== (state.draft.mode === "all")) $("provider-share-all").checked = state.draft.mode === "all"; disable("provider-share-all", state.busy);
      text("provider-model-summary", info.enabled ? `${presentation.chosen} selected · ${presentation.ready} ready for paid work.` : `${presentation.chosen} selected. Earning is off.`);
      const list = $("provider-model-list"), existing = new Map([...list.querySelectorAll("[data-shared-model]")].map(node => [node.dataset.sharedModel, node]));
      const wanted = new Set(models.map(model => model.id)); for (const [id, node] of existing) if (!wanted.has(id)) node.remove();
      if (models.length) list.querySelector(".product-provider-model-empty")?.remove();
      models.forEach((model, index) => {
        const row = rows.get(model.id); let label, detail = "", status = "off";
        if (!model.compatible) { label = "Not compatible"; detail = model.reason || "This installed model cannot be offered to this network."; status = "blocked"; }
        else if (dirty && draft.has(model.id) !== selected.has(model.id)) { label = draft.has(model.id) ? "Will share after Apply" : "Will stop sharing after Apply"; status = "checking"; }
        else if (!selected.has(model.id)) label = "Not shared";
        else if (state.busy) { label = "Updating sharing…"; status = "checking"; }
        else if (!info.enabled) label = "Selected · earning off";
        else if (!info.running || state.stale) { label = "Checking connection"; status = "checking"; }
        else if (!offered.has(model.id)) { label = "Waiting to be offered"; status = "checking"; }
        else if (row?.state === "online") { label = "Available for paid work"; status = "online"; }
        else if (["review-required", "update-required", "qualification-failed"].includes(row?.state)) { label = ({ "review-required": "Network approval needed", "update-required": "App update needed", "qualification-failed": "Network check not passed" })[row.state]; detail = row.qualification ? qualificationDetail(row.qualification) : row.detail || ""; status = "blocked"; }
        else { label = row?.state === "preparing" || row?.qualification?.phase === "preparing" ? "Preparing model" : row?.state === "qualifying" ? "Checking model" : "Waiting for network qualification"; detail = qualificationDetail(row?.qualification); status = "checking"; }
        let node = existing.get(model.id);
        if (!node) {
          node = document.createElement("div"); node.className = "product-provider-model-row"; node.dataset.sharedModel = model.id;
          node.innerHTML = '<label class="product-provider-model-name"></label><div class="product-provider-model-readiness"><span class="product-model-status"></span><small class="product-provider-model-detail" hidden></small></div><input type="checkbox" role="switch" class="product-switch-input">';
          const input = node.querySelector("input"); input.id = "provider-share-" + model.id; input.dataset.providerSharedModel = model.id; node.querySelector("label").htmlFor = input.id;
          node.querySelector(".product-model-status").id = input.id + "-status"; input.setAttribute("aria-describedby", input.id + "-status");
        }
        const name = node.querySelector("label"), input = node.querySelector("input"), badge = node.querySelector(".product-model-status"), description = node.querySelector("small");
        if (name.textContent !== (model.label || model.id)) name.textContent = model.label || model.id;
        const checked = draft.has(model.id) && !!model.compatible, disabled = state.busy || !model.compatible;
        if (input.checked !== checked) input.checked = checked; if (input.disabled !== disabled) input.disabled = disabled;
        if (badge.dataset.state !== status) badge.dataset.state = status; if (badge.textContent !== label) badge.textContent = label;
        if (description.textContent !== detail) description.textContent = detail; description.hidden = !detail;
        if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
      });
      if (!models.length && !list.querySelector(".product-provider-model-empty")) { const empty = document.createElement("p"); empty.className = "product-fine product-provider-model-empty"; empty.textContent = "No compatible installed models found. Install a supported model from Models."; list.appendChild(empty); }
      text("provider-selection-status", state.busy ? "Finishing the current change. Stop earning remains available." : dirty ? "Changes are not applied yet. Choose at least one model, then Apply selection." : "");
      hide("provider-selection-status", !$("provider-selection-status").textContent); hide("provider-selection-actions", !dirty);
      disable("provider-models-apply", state.busy || !models.some(model => model.compatible && draft.has(model.id))); disable("provider-models-reset", state.busy);
    }
    function render(state, presentation) {
      const info = state.info, toggle = $("earning-toggle");
      text("earning-toggle", presentation.toggleLabel); toggle.setAttribute("aria-checked", String(presentation.on)); toggle.dataset.action = presentation.action; toggle.disabled = presentation.disabled;
      hide("provider-start-hint", presentation.on); text("provider-label", presentation.status.label); $("provider-label").dataset.state = presentation.status.state; $("provider-dot").dataset.state = presentation.status.state;
      text("provider-detail", (presentation.status.detail || "") + (presentation.status.state === "online" && info?.deviceAuthorized && info.walletLocked && !String(presentation.status.detail).includes("Wallet locked") ? " Wallet locked — earning continues." : ""));
      text("provider-qualification", qualificationDetail(presentation.status.qualification)); hide("provider-qualification", !presentation.status.qualification);
      text("provider-model", presentation.modelSummary); text("provider-readiness", presentation.readiness); paintModels(state, presentation);
      text("provider-setup", state.error || (state.busy ? presentation.status.detail : info?.running && !info.blocked ? "Sharing is on. Installed supported models load automatically when needed." : info?.blocked || info?.detail || "Start earning to prepare the installed models and connect.") + (info?.progress && Number.isFinite(info.progress.pct) ? ` ${info.progress.pct}% downloaded.` : ""));
      hide("provider-authorization", !info?.deviceAuthorized); text("provider-authorization", info?.sessionOnly ? "This device is enabled for this session. Enable earning again after closing the app." : Number.isSafeInteger(info?.expiresAt) ? `Device authorized until ${new Date(info.expiresAt).toLocaleString()}.` : "This device is authorized to earn.");
      actionNotice.show(state.notice); hide("provider-revoke", !info?.deviceAuthorized); disable("provider-revoke", state.busy);
      hide("provider-download", info?.state !== "download-required" || state.stale && !state.busy); disable("provider-download", state.busy); hide("provider-cancel", !state.busy); disable("provider-cancel", state.action === "stop"); disable("provider-reload", state.busy);
      const picker = $("provider-model-pick"), choices = info?.models || (info?.model ? [info.model] : []);
      hide("provider-model-choice", !info || info.automatic === true || !choices.length);
      const options = (info?.model ? "" : '<option value="">Choose a provider model</option>') + choices.map(model => `<option value="${esc(model.id)}">${esc(model.label || model.id)}${model.installed ? "" : " · download required"}</option>`).join("");
      if (picker.innerHTML !== options) picker.innerHTML = options; if (picker.value !== (info?.model?.id || "")) picker.value = info?.model?.id || "";
      picker.disabled = presentation.on || state.busy || state.stale || !choices.length || !["ready", "model-required", "download-required"].includes(info?.state);
      const legacy = state.legacy;
      text("earn-wallet-kai", legacy?.kai ?? "—"); text("earn-koin-drop", legacy?.koin ?? "—");
      text("earn-legacy-status", legacy ? "Estimated drop · 1 KOIN per 5 KAI" : state.legacyError || "Checking Testnet KAI…");
      $("earn-legacy-drop").title = legacy ? `Testnet KAI in wallet ${legacy.wallet}. Expected drop: 1 KOIN per 5 KAI, rounded down to 8 decimals. Estimate until the final drop snapshot.`
        : `${state.legacyError || "Checking testnet KAI balance."} The expected KOIN drop is calculated at 1 KOIN per 5 KAI when the balance is available.`;
      const rewards = state.rewards, feed = $("rewards"), markup = rewardMarkup(rewards);
      if (feed.innerHTML !== markup) { const top = feed.scrollTop; feed.innerHTML = markup; feed.scrollTop = top; }
      text("reward-status", state.rewardError ? rewards ? "Reward updates are unavailable. Showing the last verified history." : state.rewardError : state.rewardLoading ? "Loading reward history…" : rewards?.payouts.length || rewards?.summary?.pending.length ? "Recorded rewards and payment progress." : "No recorded rewards yet.");
      const summary = rewards?.summary, totals = summary && root.KaiRewardSummary?.totals(summary, rewards.payouts);
      text("reward-today", summary?.current.availability != null ? amount(summary.current.availability) + " KOIN" : "—");
      text("reward-today-detail", summary?.current.asOf != null ? "Estimate as of " + new Date(summary.current.asOf).toLocaleTimeString() : "Waiting for a verified estimate.");
      text("reward-pending", totals ? amount(BigInt(totals.availability) + BigInt(totals.work)) + " KOIN" : "—");
      text("reward-pending-detail", totals?.attention ? "Some rewards need attention. See the activity below." : "Daily rewards enter a 24-hour review before payment.");
      text("reward-updated", rewards ? `Last verified ${new Date(rewards.observedAt).toLocaleTimeString()} · ${rewards.walletAddress.length > 18 ? rewards.walletAddress.slice(0, 9) + "…" + rewards.walletAddress.slice(-6) : rewards.walletAddress}. KOIN rewards are separate from chat credits.` : "KOIN rewards are separate from chat credits.");
    }
    const controller = createController({ credit: (action, input) => bridge?.credit ? bridge.credit(action, input) : Promise.reject(Error("Open the desktop app to check earning setup.")),
      readLegacy: async () => {
        if (!bridge?.call) throw Error("Open KAI Core to read your Testnet KAI balance.");
        return bridge.call("earn.legacyBalance");
      }, render, summaryApi: root.KaiRewardSummary, navigate });
    $("earning-toggle").addEventListener("click", () => void controller.toggle());
    $("provider-share-all").addEventListener("change", event => controller.editSelection(null, event.target.checked));
    $("provider-model-list").addEventListener("change", event => { const input = event.target.closest("[data-provider-shared-model]"); if (input) controller.editSelection(input.dataset.providerSharedModel, input.checked); });
    $("provider-models-apply").addEventListener("click", () => void controller.applySelection()); $("provider-models-reset").addEventListener("click", () => controller.resetSelection());
    $("provider-models-open").addEventListener("click", () => { $("provider-models").scrollIntoView({ block: "start" }); $("provider-share-all").focus({ preventScroll: true }); });
    $("provider-model-pick").addEventListener("change", event => void controller.action("model", event.target.value));
    $("provider-reload").addEventListener("click", () => void controller.refresh()); $("provider-revoke").addEventListener("click", () => void controller.action("revoke"));
    $("provider-download").addEventListener("click", () => void controller.action("download")); $("provider-cancel").addEventListener("click", () => void controller.action("stop"));
    $("provider-wallet").addEventListener("click", () => navigate("wallet")); $("provider-open-models").addEventListener("click", () => navigate("models"));
    let entered = false;
    const api = { enter() { entered = true; if (!document.hidden) controller.enter(); }, leave() { entered = false; controller.leave(); }, refresh: controller.refresh };
    document.addEventListener("visibilitychange", () => { if (document.hidden) controller.leave(); else if (entered) controller.enter(); });
    for (const name of ["kai-account-signed-out", "kai-credit-identity-changed", "kai-core-privacy-changed"]) root.addEventListener(name, () => controller.reset());
    return api;
  }
  const api = { createController, providerPresentation, validateRewards, rewardMarkup, legacyAtoms, legacySummary, modelRows, selectedModels, selectionKey, mount };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KaiCoreEarning = mount(root.document, root.kaiCore);
})(typeof window !== "undefined" ? window : globalThis);
