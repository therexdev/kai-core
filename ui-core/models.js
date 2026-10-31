"use strict";
(function (root) {
  function description(model) {
    return String(model.blurb || "").replace(/\s*·\s*\d+(?:\.\d+)?\s*GB\s*$/i, "").trim();
  }
  function sizeLabel(model) {
    const known = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
    const gb = bytes => bytes > 0 && bytes < 10000000 ? "<0.01 GB" : `${Number((bytes / 1e9).toFixed(bytes < 1e9 ? 2 : 1))} GB`;
    const actual = known(model.diskBytes) ? model.diskBytes : null;
    const total = known(model.downloadSizeBytes) && model.downloadSizeBytes > 0 ? model.downloadSizeBytes : null;
    const expected = total ?? (!Object.hasOwn(model, "downloadSizeBytes") && known(model.sizeBytes) && model.sizeBytes > 0 ? model.sizeBytes : null);
    if (model.status === "ready") return actual !== null ? `${gb(actual)} on disk` : expected !== null ? `${gb(expected)} model size` : "Size unavailable";
    if (actual !== null && actual > 0) return total !== null ? `${gb(actual)} on disk · ${gb(total)} total` : `${gb(actual)} on disk`;
    return expected !== null ? `${gb(expected)} ${model.custom || total === null ? "model size" : "download"}` : "Size unavailable";
  }
  function presentation(model, job, pending, error, activeAlias) {
    const state = pending === "enqueue" ? "queued" : job?.state;
    const busy = ["queued", "downloading", "preparing"].includes(state) || !!pending;
    const pct = state === "downloading" && typeof job?.pct === "number" && Number.isFinite(job.pct) ? Math.max(0, Math.min(100, Math.round(job.pct))) : null;
    const queued = state === "queued";
    const jobError = state === "error" ? job.error || "The model could not be loaded. Try again." : "";
    const failure = error || jobError;
    const label = pending === "cancel" ? "Cancelling…" : queued ? "Queued"
      : state === "downloading" ? pct === null ? "Downloading…" : `Downloading ${pct}%`
      : state === "preparing" ? "Preparing…"
      : failure ? model.status === "ready" ? "Retry load" : "Retry download"
      : model.status === "ready" ? "Load model" : "Download & load";
    return { label, busy, pct, state: busy ? state : "idle", error: pending ? "" : failure,
      status: activeAlias === model.alias && model.status === "ready" ? "Loaded" : model.status,
      cancel: busy && !pending && job?.cancellable === true,
      cancelLabel: `${queued ? "Remove from queue" : state === "downloading" ? "Cancel download" : "Cancel preparation"} · ${model.label || model.alias}`,
      cancelTitle: queued ? "Remove from queue" : state === "downloading" ? "Cancel download" : "Cancel preparation",
      detail: queued && Number.isInteger(job?.position) && job.position > 0 ? `Queue position ${job.position}` : "",
    };
  }
  function create({ document, container, request, refresh }) {
    const cards = new Map(), pending = new Map(), errors = new Map();
    let snapshot = { models: [] };
    const putText = (node, value) => { const text = String(value ?? ""); if (node.textContent !== text) node.textContent = text; };
    function element(tag, className, parent) {
      const node = document.createElement(tag); if (className) node.className = className; parent?.appendChild(node); return node;
    }
    function cardFor(model) {
      let card = cards.get(model.alias);
      if (card) return card;
      const article = element("article", "model-card"); article.dataset.modelCard = model.alias;
      const heading = element("div", "model-card-heading", article);
      const title = element("h2", "", heading), status = element("span", "pill", heading);
      const blurb = element("p", "model-description", article);
      const footer = element("div", "model-card-footer", article), size = element("span", "model-size", footer);
      const controls = element("div", "model-card-controls", footer);
      const button = element("button", "model-action", controls); button.type = "button"; button.dataset.model = model.alias;
      const label = element("span", "model-action-label", button); label.setAttribute("role", "status"); label.setAttribute("aria-live", "polite");
      const cancel = element("button", "model-cancel", controls); cancel.type = "button"; cancel.dataset.cancelModel = model.alias; cancel.hidden = true;
      const close = element("span", "", cancel); close.setAttribute("aria-hidden", "true"); close.textContent = "×";
      const error = element("p", "model-card-error", article); error.setAttribute("role", "alert"); error.hidden = true;
      button.onclick = () => { if (!button.disabled) void perform(model.alias, "enqueue"); };
      cancel.onclick = () => { if (!cancel.disabled && !cancel.hidden) void perform(model.alias, "cancel"); };
      card = { article, title, status, blurb, size, controls, button, label, cancel, error };
      cards.set(model.alias, card); return card;
    }
    function paint() {
      const jobs = new Map((snapshot.modelQueue || []).map(job => [job.alias, job]));
      const current = new Set();
      for (const [index, model] of (snapshot.models || []).entries()) {
        current.add(model.alias);
        const card = cardFor(model), job = jobs.get(model.alias);
        const view = presentation(model, job, pending.get(model.alias), errors.get(model.alias), snapshot.runtime?.activeAlias);
        // Keep the actual controls in place when percentages change, preserving
        // keyboard focus and clicks while other cards continue to be selectable.
        if (container.children[index] !== card.article) container.insertBefore(card.article, container.children[index] || null);
        putText(card.title, model.label || model.alias); putText(card.status, view.status);
        putText(card.blurb, description(model)); card.blurb.hidden = !card.blurb.textContent;
        putText(card.size, sizeLabel(model)); putText(card.label, view.label);
        card.button.disabled = view.busy; card.button.dataset.state = view.state;
        card.button.title = view.detail;
        card.button.style.setProperty("--model-progress", `${view.pct ?? 0}%`);
        card.controls.setAttribute("aria-busy", String(view.busy));
        card.cancel.setAttribute("aria-label", view.cancelLabel); card.cancel.title = view.cancelTitle;
        // Completion returns focus to the load button if Cancel was focused.
        if (!view.cancel && document.activeElement === card.cancel && !view.busy) card.button.focus();
        card.cancel.hidden = !view.cancel; card.cancel.disabled = !view.cancel;
        putText(card.error, view.error); card.error.hidden = !view.error;
      }
      for (const [alias, card] of cards) if (!current.has(alias)) { card.article.remove(); cards.delete(alias); errors.delete(alias); }
    }
    async function perform(alias, operation) {
      if (pending.has(alias)) return;
      const model = snapshot.models?.find(item => item.alias === alias);
      if (!model) return;
      const job = snapshot.modelQueue?.find(item => item.alias === alias);
      const view = presentation(model, job, null, errors.get(alias), snapshot.runtime?.activeAlias);
      if (operation === "enqueue" && view.busy || operation === "cancel" && !view.cancel) return;
      pending.set(alias, operation); errors.delete(alias); paint();
      try {
        const result = await request(operation === "cancel" ? "/core/models/download/cancel" : "/core/models/ensure", { alias });
        if (Array.isArray(result?.modelQueue)) snapshot = { ...snapshot, modelQueue: result.modelQueue };
        await refresh();
      } catch (error) { errors.set(alias, String(error.message || error)); }
      finally { pending.delete(alias); paint(); }
    }
    return { update(value) { snapshot = value || { models: [] }; paint(); }, perform };
  }
  const api = { create, presentation, description, sizeLabel };
  if (typeof module === "object") module.exports = api;
  if (root) root.KaiCoreModels = api;
})(typeof window === "object" ? window : null);
