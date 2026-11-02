"use strict";
(() => {
  const i18n = window.KaiI18n, bridge = window.kaiCore?.locale;
  const $ = id => document.getElementById(id), dialog = $("language-dialog");
  const first = $("first-language"), setting = $("interface-language"), save = $("language-save"), next = $("language-continue");
  let saved, pending = false, revision = 0;
  for (const select of [first, setting]) for (const language of i18n.languages) {
    const option = document.createElement("option"); option.value = language.code;
    option.lang = language.code; option.translate = false; option.textContent = language.name; select.appendChild(option);
  }
  function apply(state) {
    saved = state; i18n.setLanguage(state.language);
    first.value = state.language; setting.value = state.language; save.disabled = true;
    if (state.selected && dialog.open) dialog.close();
  }
  async function commit(language, initial) {
    if (pending) return;
    pending = true; save.disabled = next.disabled = first.disabled = setting.disabled = true;
    const status = $(initial ? "language-error" : "language-setting-status"); i18n.setText(status, "");
    try {
      if (!bridge) throw Error("Language preferences require the desktop app");
      apply(await bridge.set(language));
      i18n.setText(status, "Language saved.");
      if (initial) { dialog.close(); document.querySelector('[data-page="chat"]')?.focus(); }
    } catch {
      i18n.setText(status, "Could not save the language. Please try again.");
    } finally {
      pending = false; next.disabled = first.disabled = setting.disabled = false;
      save.disabled = setting.value === saved?.language && saved?.selected;
    }
  }
  first.addEventListener("change", () => i18n.setLanguage(first.value));
  setting.addEventListener("change", () => { save.disabled = setting.value === saved?.language && saved?.selected; i18n.setText($("language-setting-status"), ""); });
  save.addEventListener("click", () => void commit(setting.value, false));
  next.addEventListener("click", () => void commit(first.value, true));
  function dismiss() { if (pending) return; if (saved) apply(saved); dialog.close(); }
  $("language-close").addEventListener("click", dismiss);
  dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
  const unsubscribe = bridge?.onChange(state => { revision++; apply(state); });
  window.addEventListener("pagehide", () => unsubscribe?.(), { once: true });
  window.kaiLanguageReady = (async () => {
    const requestRevision = revision;
    try {
      const state = bridge ? await bridge.get() : { language: i18n.language, selected: true };
      if (revision !== requestRevision) return;
      apply(state);
      if (!state.selected) { dialog.showModal(); first.focus(); }
    } catch {
      first.value = setting.value = i18n.language;
      dialog.showModal(); i18n.setText($("language-error"), "Could not load the language setting. Choose a language and try again.");
    }
  })();
})();
