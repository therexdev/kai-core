"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createCoreLocale, normalize } = require("../../electron/core-locale");
function fixture(initial = {}) {
  const values = { ...initial }, writes = [];
  const settings = { get: (key, fallback) => values[key] ?? fallback, set(key, value) { writes.push([key, value]); values[key] = value; } };
  return { values, writes, settings, locale: createCoreLocale({ settings, preferredLanguages: ["unsupported", "pt_PT", "en-US"] }) };
}
test("first launch suggests a supported system language without saving until the user chooses", () => {
  const f = fixture(); assert.equal(f.locale.get().language, "pt-BR"); assert.equal(f.locale.get().selected, false); assert.equal(f.writes.length, 0);
  assert.equal(f.locale.set("de-DE").language, "de"); assert.equal(f.locale.get().selected, true);
  const reopened = createCoreLocale({ settings: f.settings, preferredLanguages: ["fr"] }); assert.equal(reopened.get().language, "de");
  assert.deepEqual(f.writes, [["interface.language", "de"]]);
});
test("saved language is shared and normalized; unsupported values cannot overwrite it", () => {
  const f = fixture({ "interface.language": "es-MX" }); assert.equal(f.locale.get().language, "es"); assert.equal(f.locale.get().selected, true);
  for (const input of [null, {}, "", "xx", "en<script>", "__proto__"]) assert.throws(() => f.locale.set(input), /Unsupported/);
  assert.equal(f.writes.length, 0); assert.equal(normalize("PT_br"), "pt-BR"); assert.equal(normalize("fr-CA"), "fr");
});
test("a failed save is never announced and listeners receive separate data", () => {
  const f = fixture({ "interface.language": "en" }), seen = [];
  f.locale.onChange(value => { value.language = "corrupted"; value.languages.length = 0; });
  const off = f.locale.onChange(value => seen.push(value)); f.locale.set("es");
  assert.equal(seen[0].language, "es"); assert.equal(seen[0].languages.length, 5);
  f.settings.set = () => { throw Error("Disk full"); }; assert.throws(() => f.locale.set("fr"), /Disk full/);
  assert.equal(seen.length, 1); assert.equal(f.locale.get().language, "es"); off();
});
test("sandboxed locale reads retain sender, main-frame and installed-content checks", async () => {
  const { PluginHost } = require("../../electron/core-plugin-host"), f = fixture(); let active = true;
  const host = new PluginHost({ electron: { ipcMain: { handle() {} } }, core: { locale: f.locale }, manager: { assertActive() { if (!active) throw Error("Plugin disabled"); } } });
  const wc = { mainFrame: { url: "kai-plugin://example.locale/index.html" }, isDestroyed: () => false, send() {} };
  host.windows.set("example.locale", { webContents: wc, entry: wc.mainFrame.url, manifest: { id: "example.locale", runtime: "sandboxed", permissions: [] }, calls: [], controller: new AbortController() });
  const event = { sender: wc, senderFrame: wc.mainFrame };
  assert.equal((await host.call(event, "locale.get")).language, "pt-BR");
  await assert.rejects(host.call({ ...event, senderFrame: { url: wc.mainFrame.url } }, "locale.get"), /caller denied/);
  await assert.rejects(host.call(event, "locale.set", { language: "de" }), /permission denied/);
  active = false; await assert.rejects(host.call(event, "locale.get"), /disabled/);
});
test("native services read shared language without another grant and stop receiving events on disposal", t => {
  const f = fixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-locale-api-")), controller = new AbortController();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const api = require("../../electron/foundation-api").createFoundationApi({ core: { locale: f.locale }, electron: {} }, {
    manifest: { id: "example.locale", version: "1.0.0", permissions: [] }, controller, dataDir: dir,
  });
  const seen = []; api.locale.onChange(value => seen.push(value.language)); assert.equal(api.locale.get().language, "pt-BR");
  f.locale.set("fr"); controller.abort(); f.locale.set("de"); assert.deepEqual(seen, ["fr"]); assert.throws(() => api.locale.get(), /aborted/i);
});
