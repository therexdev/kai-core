"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const ui = path.join(__dirname, "../../ui-core");
function translator() {
  const context = {
    navigator: { languages: ["en"] },
    localStorage: {
      getItem() { throw Error("Core owns this preference"); },
      setItem() { throw Error("Core owns this preference"); },
    },
  };
  for (const name of ["locales/catalogs.js", "locales/core.js", "i18n.js"]) vm.runInNewContext(fs.readFileSync(path.join(ui, name), "utf8"), context);
  return context;
}
test("offline catalogs preserve every parameter and agree with their editable source", () => {
  const context = translator(), source = JSON.parse(fs.readFileSync(path.join(ui, "locales/core.json")));
  const slots = value => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  assert.deepEqual(Object.keys(source).sort(), ["de", "es", "fr", "pt-BR"]);
  for (const [language, table] of Object.entries(source)) for (const [key, value] of Object.entries(table)) {
    assert.equal(context.KaiLocaleCatalogs[language][key], value, `${language}: ${key}`);
    assert.deepEqual(slots(value), slots(key), `${language}: ${key}`);
    assert.ok(value.trim().length, key);
  }
});
test("language changes leave interpolated user values and unknown names literal", () => {
  const { KaiI18n: i18n } = translator(), userValue = '<script>Settings & {0}</script>';
  for (const language of ["en", "es", "pt-BR", "fr", "de"]) {
    i18n.setLanguage(language);
    assert.equal(i18n.t("Unknown project name"), "Unknown project name");
    assert.equal(i18n.t("{0}", [userValue]), userValue);
    const node = { textContent: "", isConnected: true }; i18n.setText(node, i18n.literal(userValue));
    assert.equal(node.textContent, userValue);
  }
  assert.throws(() => i18n.setLanguage("unsupported"), /Unsupported/);
});
test("localized wallet balances retain every atomic digit and use matching separators", () => {
  const context = translator(); context.module = { exports: {} }; context.Intl = Intl;
  vm.runInNewContext(fs.readFileSync(path.join(ui, "wallet.js"), "utf8"), context);
  const expected = {
    en: "184,467,440,737.09551615", es: "184.467.440.737,09551615",
    "pt-BR": "184.467.440.737,09551615", fr: "184\u202f467\u202f440\u202f737,09551615", de: "184.467.440.737,09551615",
  };
  for (const [language, value] of Object.entries(expected)) {
    context.KaiI18n.setLanguage(language);
    assert.equal(context.module.exports.atomAmount("18446744073709551615"), value);
    assert.equal(context.module.exports.amount("0.00000001"), language === "en" ? "0.00000001" : "0,00000001");
  }
});
