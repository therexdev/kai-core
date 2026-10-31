"use strict";
(() => {
  const byId = id => document.getElementById(id), close = byId("dialog-close"), checkbox = byId("dialog-checkbox");
  let ready = false, pending = false, buttons = [];
  function error(message) {
    ready = false;
    for (const button of buttons) button.disabled = true;
    checkbox.disabled = true;
    byId("dialog-loading").hidden = true;
    byId("dialog-content").setAttribute("aria-busy", "false");
    byId("dialog-error").textContent = message;
    byId("dialog-error").hidden = false;
    close.focus();
  }
  async function decide(response) {
    if (pending || (response !== null && !ready)) return;
    pending = true;
    for (const button of buttons) button.disabled = true;
    checkbox.disabled = true;
    try {
      await window.kaiDialog.decide(response === null ? { cancel: true, checkboxChecked: checkbox.checked } : { response, checkboxChecked: checkbox.checked });
    } catch {
      pending = false;
      error("This dialog could not be completed. Close it and try again.");
    }
  }
  close.addEventListener("click", () => void decide(null));
  checkbox.addEventListener("change", () => {
    if (ready && !pending && typeof window.kaiDialog.setCheckbox === "function") void window.kaiDialog.setCheckbox(checkbox.checked).catch(() => {});
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); void decide(null); return; }
    if (event.key !== "Tab") return;
    const focusable = [...document.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter(element => element.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1), active = document.activeElement;
    if (event.shiftKey && (active === first || !focusable.includes(active))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (active === last || !focusable.includes(active))) { event.preventDefault(); first?.focus(); }
  });
  close.focus();
  async function load() {
    try {
      const data = await window.kaiDialog.read();
      if (!data || typeof data.title !== "string" || typeof data.message !== "string" || typeof data.detail !== "string" || !Array.isArray(data.buttons) || !data.buttons.length || data.buttons.some(label => typeof label !== "string") || !Number.isInteger(data.defaultId) || data.defaultId < -1 || data.defaultId >= data.buttons.length || !Number.isInteger(data.cancelId)) throw Error("Invalid dialog");
      if (pending) return;
      document.title = data.title || "KAI";
      byId("dialog-title").textContent = data.title || "KAI";
      byId("dialog-message").textContent = data.message;
      byId("dialog-detail").textContent = data.detail;
      byId("dialog-detail").hidden = !data.detail;
      const type = ["info", "question", "warning", "error"].includes(data.type) ? data.type : "info";
      byId("dialog-icon").classList.add(type);
      const icon = document.querySelector(`svg[data-type="${type}"]`); if (icon) icon.removeAttribute("hidden");
      if (data.type === "none") byId("dialog-icon").hidden = true;
      byId("dialog-checkbox-text").textContent = data.checkboxLabel || "";
      byId("dialog-checkbox-label").hidden = !data.checkboxLabel;
      checkbox.checked = !!data.checkboxChecked;
      checkbox.disabled = !data.checkboxLabel;
      buttons = data.buttons.map((label, index) => {
        const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.dataset.response = String(index);
        if (data.buttons.length === 1 || (data.buttons.length === 2 && data.cancelId >= 0 && index !== data.cancelId) || (index === data.defaultId && index !== data.cancelId)) button.classList.add("primary");
        button.addEventListener("click", () => void decide(index)); byId("dialog-actions").append(button); return button;
      });
      byId("dialog-loading").hidden = true;
      byId("dialog-ready").hidden = false;
      byId("dialog-content").setAttribute("aria-busy", "false");
      ready = true;
      (buttons[data.defaultId] || close).focus();
    } catch { error("Dialog details could not be loaded. Close this window and try again."); }
  }
  void load();
})();
