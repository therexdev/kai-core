"use strict";
// The saved interface language is profile-wide. Reading it grants no access to
// accounts, user content or plugin preferences. Only Core changes the selection.
const languages = Object.freeze([
  { code: "en", name: "English" }, { code: "es", name: "Español" },
  { code: "pt-BR", name: "Português (Brasil)" }, { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
].map(Object.freeze));
function normalize(value) {
  if (typeof value !== "string" || !/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(value)) return null;
  const base = value.replace(/_/g, "-").toLowerCase().split("-")[0];
  return base === "pt" ? "pt-BR" : languages.some(row => row.code === base) ? base : null;
}
function createCoreLocale({ settings, preferredLanguages = [], onListenerError = () => {} }) {
  const listeners = new Set();
  const detected = preferredLanguages.map(normalize).find(Boolean) || "en";
  function get() {
    const saved = normalize(settings.get("interface.language", null));
    return { language: saved || detected, selected: !!saved, direction: "ltr", languages: languages.map(row => ({ ...row })) };
  }
  function set(value) {
    const language = normalize(value);
    if (!language) throw Error("Unsupported interface language");
    const before = get();
    if (before.selected && before.language === language) return before;
    // Settings rolls back on write failure. Never announce an unsaved choice.
    settings.set("interface.language", language);
    const state = get();
    for (const listener of listeners) { try { listener(structuredClone(state)); } catch (error) { onListenerError(error); } }
    return state;
  }
  function onChange(listener) {
    if (typeof listener !== "function") throw TypeError("A language callback is required");
    listeners.add(listener); return () => listeners.delete(listener);
  }
  return Object.freeze({ get, set, onChange });
}
module.exports = { createCoreLocale, languages, normalize };
