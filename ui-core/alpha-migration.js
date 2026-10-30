"use strict";
(function (root) {
  const terminal = phase => ["complete", "failed", "cancelled"].includes(phase);
  const issue = error => String(error?.message || error || "Migration is unavailable.").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "").slice(0, 800);
  function formatBytes(value) {
    let n = Number(value);
    if (!Number.isFinite(n) || n < 0) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let unit = 0;
    while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit++; }
    return `${n.toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
  }
  function resultSummary(job) {
    if (typeof job?.result?.summary === "string") return job.result.summary;
    const preserved = job?.selected?.deleteOldModels ? "Completed transfers remain in Core; only verified model originals were removed." : "Your Alpha files are unchanged.";
    return { complete: "Your selected items have been migrated into KAI Core.", cancelled: `Migration stopped. ${preserved}`, failed: `Migration could not finish. ${preserved}` }[job?.phase] || "";
  }
  function resultDetails(job) {
    const models = job?.result?.models, wallet = job?.result?.wallet;
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const failed = Number.isSafeInteger(models?.failed) && models.failed >= 0 ? ` · ${models.failed} failed` : models?.error ? " · copying stopped" : "";
    const moved = count(models?.moved) > 0 ? ` (${count(models.moved)} moved without duplicating)` : "";
    const cleanup = models && (job?.selected?.deleteOldModels || models.deleted || models.cleanupSkipped || models.cleanupFailed) ? `Alpha originals: ${count(models.deleted)} removed${models.cleanupSkipped ? ` · ${count(models.cleanupSkipped)} kept outside the Alpha model folder` : ""}${models.cleanupFailed ? ` · ${count(models.cleanupFailed)} kept because cleanup could not finish` : ""}.` : "";
    const modelLines = models ? [`Models: ${count(models.copied)} file${count(models.copied) === 1 ? "" : "s"} ${moved ? "migrated" : "copied"}${moved} · ${count(models.skipped)} skipped${failed}.`, cleanup, models.error, ...(Array.isArray(models.warnings) ? models.warnings : [])] : job?.selected?.models && terminal(job.phase) ? ["Models: copying did not begin."] : [];
    const walletLines = wallet ? [`Wallet: ${wallet.copied ? "copied" : "not copied"}.`, wallet.copied && wallet.address ? `Address: ${wallet.address}` : "", wallet.detail, wallet.error, wallet.warning] : job?.selected?.wallet && terminal(job.phase) ? ["Wallet: copying did not begin."] : [];
    const lines = values => [...new Set(values.filter(value => typeof value === "string" && value.trim()))].join("\n");
    return { models: lines(modelLines), wallet: lines(walletLines) };
  }
  function createController({ call, render = () => {}, onComplete = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const state = { open: false, loading: false, choosing: false, starting: false, cancelling: false, inventory: null, selected: { models: false, wallet: false, deleteOldModels: false }, job: null, error: "", lastResult: "" };
    let epoch = 0, readSerial = 0, timer = null, notified = false;
    const busy = () => state.starting || state.cancelling || state.job?.phase === "running";
    const available = key => !!state.inventory?.source && state.inventory?.[key]?.available === true && !state.inventory[key].blocked;
    const snapshot = () => structuredClone(state);
    const view = () => ({ busy: busy(), terminal: terminal(state.job?.phase), canStart: !!state.inventory?.source && !busy() && !state.loading && !state.choosing && !terminal(state.job?.phase) && ["models", "wallet"].some(key => state.selected[key] && available(key)), canChoose: !busy() && !state.loading && !state.choosing && !terminal(state.job?.phase), canSelect: !busy() && !state.loading && !state.choosing && !terminal(state.job?.phase) });
    const emit = () => render(snapshot(), view());
    const stopTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
    const current = expected => state.open && epoch === expected;
    function schedule() {
      stopTimer();
      if (state.open && state.job?.phase === "running") timer = setTimer(() => { timer = null; void poll(); }, 750);
    }
    function acceptJob(job) {
      if (!job || !["idle", "running", "complete", "failed", "cancelled"].includes(job.phase)) throw Error("The migration status could not be read. Try again.");
      state.job = job;
      if (job.selected) state.selected = { models: job.selected.models === true, wallet: job.selected.wallet === true, deleteOldModels: job.selected.models === true && job.selected.deleteOldModels === true };
      if (terminal(job.phase)) {
        state.starting = false; state.cancelling = false; stopTimer();
        state.lastResult = resultSummary(job);
        if (job.error) state.error = issue(job.error);
        if (!notified) { notified = true; onComplete(job.result || {}); }
      }
    }
    function acceptInventory(inventory) {
      state.inventory = inventory;
      state.selected = { models: available("models"), wallet: available("wallet"), deleteOldModels: false };
    }
    async function poll() {
      if (!state.open || state.job?.phase !== "running") return;
      const expected = epoch, serial = ++readSerial;
      try {
        const job = await call("migration.status");
        if (!current(expected) || serial !== readSerial) return;
        if (job?.phase === "idle" && !state.job.unconfirmed) throw Error("Migration status is temporarily unavailable. Checking again…");
        state.error = job?.phase === "idle" ? "Migration did not start. Please try again." : ""; acceptJob(job);
      } catch (error) { if (current(expected) && serial === readSerial) state.error = issue(error); }
      if (current(expected) && serial === readSerial) { emit(); schedule(); }
    }
    async function open() {
      if (state.open) return;
      const expected = ++epoch;
      notified = false; state.open = true; state.loading = true; state.choosing = false; state.starting = false; state.cancelling = false; state.inventory = null; state.job = null; state.error = ""; state.selected = { models: false, wallet: false, deleteOldModels: false }; emit();
      try {
        const job = await call("migration.status");
        if (!current(expected)) return;
        if (job?.phase === "running") { acceptJob(job); schedule(); }
        else {
          const inventory = await call("migration.scan");
          if (!current(expected)) return;
          acceptInventory(inventory);
        }
      } catch (error) { if (current(expected)) state.error = issue(error); }
      finally { if (current(expected)) { state.loading = false; emit(); } }
    }
    function close() {
      if (busy()) return false;
      state.open = false; state.loading = false; state.choosing = false; epoch++; readSerial++; stopTimer(); emit(); return true;
    }
    async function chooseSource() {
      if (!view().canChoose) return;
      const expected = epoch;
      state.choosing = true; state.error = ""; emit();
      try {
        const inventory = await call("migration.chooseSource");
        if (current(expected) && inventory) acceptInventory(inventory);
      } catch (error) { if (current(expected)) state.error = issue(error); }
      finally { if (current(expected)) { state.choosing = false; emit(); } }
    }
    function select(key, value) {
      if (!["models", "wallet", "deleteOldModels"].includes(key) || !view().canSelect) return;
      state.selected[key] = value === true && (key === "deleteOldModels" ? state.selected.models && available("models") : available(key));
      if (!state.selected.models) state.selected.deleteOldModels = false;
      emit();
    }
    async function start() {
      if (!state.open || !view().canStart) return;
      const expected = epoch;
      const selected = { models: state.selected.models && available("models"), wallet: state.selected.wallet && available("wallet"), deleteOldModels: state.selected.models && available("models") && state.selected.deleteOldModels };
      state.starting = true; state.error = ""; notified = false; emit();
      try {
        const job = await call("migration.start", selected);
        if (!current(expected)) return;
        if (job?.phase === "idle") throw Error("Migration did not start. Please try again.");
        acceptJob(job);
      } catch (error) {
        if (!current(expected)) return;
        state.error = issue(error);
        // A transport error can arrive after the job started. Recover its actual
        // state before enabling another start or allowing the dialog to close.
        try {
          const job = await call("migration.status");
          if (!current(expected)) return;
          acceptJob(job);
        } catch (statusError) {
          if (!current(expected)) return;
          state.job = { phase: "running", selected, unconfirmed: true };
          state.error = `${state.error} Checking whether migration started… ${issue(statusError)}`;
        }
      } finally {
        if (current(expected)) { state.starting = false; emit(); schedule(); }
      }
    }
    async function cancel() {
      if (!state.open) return;
      if (!busy()) { close(); return; }
      if (state.starting || state.cancelling) return;
      const expected = epoch, serial = ++readSerial;
      stopTimer(); state.cancelling = true; state.error = ""; emit();
      try {
        const job = await call("migration.cancel");
        if (!current(expected) || serial !== readSerial) return;
        if (job?.phase === "idle") acceptJob({ ...job, phase: "cancelled" });
        else acceptJob(job);
      } catch (error) { if (current(expected) && serial === readSerial) { state.cancelling = false; state.error = issue(error); } }
      finally { if (current(expected) && serial === readSerial) { emit(); schedule(); } }
    }
    return { open, close, chooseSource, select, start, cancel, snapshot, view, dispose() { epoch++; readSerial++; stopTimer(); state.open = false; } };
  }
  function mount(document, bridge) {
    const $ = id => document.getElementById(`alpha-migration-${id}`), dialog = $("dialog");
    if (!dialog || !bridge?.call) return null;
    const text = (id, value) => { const node = $(id), next = String(value || ""); if (node.textContent !== next) node.textContent = next; };
    const controller = createController({ call: (method, input) => bridge.call(method, input),
      onComplete: result => document.dispatchEvent(new root.CustomEvent("kai-alpha-migration-complete", { detail: result })),
      render(state, view) {
        if (state.open && !dialog.open) dialog.showModal();
        if (!state.open && dialog.open) { dialog.close(); $("open").focus(); }
        text("last-result", state.lastResult); $("last-result").hidden = !state.lastResult;
        if (!state.open) return;
        $("choices").hidden = view.terminal; $("copy-note").hidden = view.terminal; $("browse").hidden = view.terminal;
        text("description", view.terminal ? "Review the completed items and any files that were kept." : "Choose what to migrate into KAI Core. Close Koinos AI Alpha, including its tray icon, before migrating.");
        const source = state.inventory?.source || state.job?.source, inventory = state.inventory;
        text("source-path", source?.path || (state.loading ? "Looking for your Alpha profile…" : view.busy ? "Migration in progress" : "No Alpha profile found. Choose its data folder to continue."));
        text("browse", state.choosing ? "Choosing folder…" : source ? "Choose another folder" : "Choose folder");
        $("browse").disabled = !view.canChoose;
        for (const key of ["models", "wallet"]) {
          $(key).checked = state.selected[key];
          $(key).disabled = !view.canSelect || !inventory?.[key]?.available || !!inventory[key].blocked;
        }
        $("delete-old-models").checked = state.selected.deleteOldModels;
        $("delete-old-models").disabled = !view.canSelect || !state.selected.models || !inventory?.models?.available;
        const modelInfo = inventory?.models, walletInfo = inventory?.wallet;
        let modelDetail = modelInfo?.detail;
        if (!modelDetail && modelInfo?.available) modelDetail = `${modelInfo.count || 0} downloaded model${modelInfo.count === 1 ? "" : "s"}. Includes vision projectors when present.`;
        text("models-detail", modelDetail || (state.loading ? "Checking downloaded models…" : view.busy && state.selected.models ? "Copying your selected models." : "No downloaded GGUF models found."));
        text("models-size", modelInfo?.bytes ? `${formatBytes(modelInfo.bytes)} of model files` : ""); $("models-size").hidden = !modelInfo?.bytes;
        text("wallet-detail", walletInfo?.detail || (state.loading ? "Checking your saved wallet…" : view.busy && state.selected.wallet ? "Copying your encrypted wallet." : walletInfo?.blocked ? "A wallet already exists in Core and will be kept." : walletInfo?.available ? "Encrypted wallet ready to copy." : "No encrypted Alpha wallet found."));
        text("wallet-address", walletInfo?.address); $("wallet-address").hidden = !walletInfo?.address;
        $("wallet-note").hidden = !!walletInfo?.blocked || (!walletInfo?.available && !state.selected.wallet);
        $("close").disabled = view.busy;
        $("cancel").disabled = state.starting || state.cancelling;
        text("cancel", state.cancelling ? "Cancelling…" : view.terminal ? "Close" : view.busy ? "Cancel migration" : "Cancel");
        $("submit").disabled = !view.canStart; $("submit").hidden = view.terminal;
        text("submit", state.starting ? "Starting…" : view.busy ? "Migrating…" : "Migrate");
        text("selection-note", view.terminal ? state.selected.deleteOldModels ? "Completed model transfers remain in Core." : "Your Alpha files are unchanged." : view.busy ? "Keep KAI Core running while migrating." : state.loading ? "Checking your Alpha profile…" : state.selected.deleteOldModels ? "Verified model originals will be removed from Alpha." : "Select Models, Wallet, or both.");
        $("progress-section").hidden = !view.busy;
        const progress = state.job?.progress, total = Math.max(0, Number(progress?.totalBytes) || 0), completed = Math.max(0, Number(progress?.completedBytes) || 0);
        text("progress-detail", state.cancelling ? "Stopping safely. Finishing cleanup…" : progress?.detail || (state.starting ? "Preparing your migration…" : "Copying selected items…"));
        if (total > 0) { $("progress").max = total; $("progress").value = Math.min(total, completed); text("progress-value", `${Math.min(100, Math.floor(completed / total * 100))}%`); }
        else { $("progress").removeAttribute("value"); text("progress-value", ""); }
        $("outcome").hidden = !view.terminal; $("outcome").dataset.phase = state.job?.phase || "";
        text("outcome-title", { complete: "Migration complete", cancelled: "Migration cancelled", failed: "Migration could not finish" }[state.job?.phase]);
        text("outcome-detail", resultSummary(state.job));
        const details = resultDetails(state.job);
        for (const key of ["models", "wallet"]) { text(`outcome-${key}`, details[key]); $(`outcome-${key}`).hidden = !details[key]; }
        text("error", state.error); $("error").hidden = !state.error;
      }
    });
    $("open").addEventListener("click", () => void controller.open());
    $("browse").addEventListener("click", () => void controller.chooseSource());
    $("form").addEventListener("submit", event => { event.preventDefault(); void controller.start(); });
    for (const key of ["models", "wallet"]) $(key).addEventListener("change", event => controller.select(key, event.target.checked));
    $("delete-old-models").addEventListener("change", event => controller.select("deleteOldModels", event.target.checked));
    $("close").addEventListener("click", () => controller.close());
    $("cancel").addEventListener("click", () => void controller.cancel());
    dialog.addEventListener("cancel", event => { event.preventDefault(); controller.close(); });
    // Native dialog close events can also occur through accessibility tools.
    dialog.addEventListener("close", () => { if (controller.snapshot().open && !controller.close()) dialog.showModal(); });
    return controller;
  }
  const api = { createController, formatBytes, resultSummary, resultDetails, mount };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else { root.KaiAlphaMigration = api; mount(root.document, root.kaiCore); }
})(typeof window !== "undefined" ? window : globalThis);
