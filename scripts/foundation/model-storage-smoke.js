"use strict";
// Real Core views, trusted review and model I/O with an isolated synthetic
// profile. This does not verify physical external drives or Windows installers.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const source = path.resolve(__dirname, "../.."), { _electron } = require(path.join(source, "node_modules/playwright-core"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kai-storage-ui-"));
const output = process.env.KAI_STORAGE_SMOKE_OUTPUT || path.join(temp, "report"); fs.mkdirSync(output, { recursive: true });
const folder = name => { const file = path.join(temp, name); fs.mkdirSync(file, { recursive: true }); return fs.realpathSync(file); };
const profile = folder("profile"), downloaded = folder("downloaded"), custom = folder("custom"), external = folder("external");
require(path.join(source, "electron/foundation-profile")).prepareFoundationProfile(profile);
fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ interface: { language: "en" }, network: { privacyMode: "local-only" }, earn: { autoStart: false } }));
const old = folder("profile/models"), original = path.join(external, "original.gguf"), fresh = path.join(external, "new.gguf");
fs.writeFileSync(path.join(old, "storage-fixture.gguf"), "GGUF-downloaded-fixture"); fs.writeFileSync(original, "GGUF-imported-fixture"); fs.writeFileSync(fresh, "GGUF-new-fixture");
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(original)).digest("hex");
fs.writeFileSync(path.join(profile, "state.json"), JSON.stringify({ customModels: [{ alias: "custom-existing", label: "Existing", path: original, sha256, sizeBytes: fs.statSync(original).size, contextSize: 4096, minRamGb: 4 }] }));
fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ name: "kai-storage-smoke", version: "1.0.0", main: "desktop.js" }));
fs.writeFileSync(path.join(temp, "desktop.js"), `require(${JSON.stringify(path.join(source, "scripts/foundation/apps-fixture.js"))}).install(${JSON.stringify({ appRoot: source, appData: path.join(temp, "app-data"), reportFile: path.join(output, "exit.json"), syntheticKeychain: true, realDialogs: true })});require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[global.__storagePick]});require(${JSON.stringify(path.join(source, "electron/core-main.js"))});`);
const env = { ...process.env, KAI_CORE_DATA: profile, KAI_CORE_PORT: "0", KAI_CHANNEL: "core" }; delete env.ELECTRON_RUN_AS_NODE; delete env.KAI_SESSION_SECRET; delete env.KAI_CORE_TOKEN;
const args = [...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : []), ...(process.platform === "linux" && !process.env.DISPLAY ? ["--ozone-platform=headless"] : []), temp];
let app, errors = []; const checks = [];
async function launch() {
  app = await _electron.launch({ executablePath: require(path.join(source, "node_modules/electron")), args, env, timeout: 60000 });
  const page = await app.firstWindow(); page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(20000);
  await app.evaluate(() => global.__foundationWindow.setContentSize(1280, 950));
  await page.waitForFunction(() => document.getElementById("version")?.textContent.startsWith("v"));
  await page.locator('[data-page="settings"]').click(); await page.locator("#model-storage-settings").scrollIntoViewIfNeeded(); return page;
}
async function quit() {
  const closing = app, process = closing.process(); app = null;
  await closing.evaluate(({ app }) => app.quit()).catch(() => {});
  await new Promise((resolve, reject) => {
    if (process.exitCode !== null) return resolve();
    const timer = setTimeout(() => { process.kill(); reject(Error("Core did not quit after storage test")); }, 10000);
    process.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
async function choose(page, kind, folder, { cancel = false, remove = false } = {}) {
  await app.evaluate((_electron, folder) => { global.__storagePick = folder; }, folder);
  const opened = app.waitForEvent("window"); await page.locator(`#model-storage-${kind}-choose`).click(); const review = await opened;
  await review.waitForURL(/\/dialog\.html$/); await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().endsWith("/dialog.html")) w.setContentSize(620, 600); });
  await review.locator("#dialog-ready").waitFor({ state: "visible" }); assert.equal(await review.locator("#dialog-checkbox").isChecked(), false);
  assert.ok((await review.locator("#dialog-detail").innerText()).includes(folder));
  if (remove) await review.locator("#dialog-checkbox").check();
  await review.screenshot({ path: path.join(output, `${kind}-review.png`) }); await review.locator("#dialog-actions button").nth(cancel ? 0 : 1).click();
  await page.waitForFunction(() => !document.getElementById("model-storage-models-choose").disabled);
  const status = await page.evaluate(() => window.kaiCore.call("storage.status"));
  if (!cancel) assert.equal(status.job?.state, "done", status.job?.error); return status;
}
(async () => {
  try {
    let page = await launch();
    let status = await choose(page, "models", downloaded, { cancel: true }); assert.equal(status.modelsDir, old);
    checks.push("Settings exposes two model folders and cancellation keeps the current location");
    status = await choose(page, "models", downloaded, { remove: true }); assert.equal(status.modelsDir, downloaded); assert.ok(!fs.existsSync(path.join(old, "storage-fixture.gguf"))); assert.ok(fs.existsSync(path.join(downloaded, "storage-fixture.gguf")));
    checks.push("Trusted review moves downloaded models and deletes originals only when checked");
    status = await choose(page, "custom", custom); assert.equal(status.customDir, custom); assert.ok(fs.existsSync(original));
    const saved = JSON.parse(fs.readFileSync(path.join(profile, "state.json"))); assert.equal(saved.customModels[0].alias, "custom-existing"); assert.equal(path.dirname(saved.customModels[0].path), custom);
    checks.push("Custom relocation retains original files and updates live model references");
    await app.evaluate((_electron, file) => { global.__storagePick = file; }, fresh);
    await page.locator('[data-page="models"]').click(); await page.locator('#import-model').click();
    await page.locator('[data-model-card="custom-new"]').waitFor({ state: "visible" });
    const imported = JSON.parse(fs.readFileSync(path.join(profile, "state.json"))).customModels.find(model => model.alias === "custom-new");
    assert.equal(path.dirname(imported.path), custom); assert.ok(fs.existsSync(fresh));
    checks.push("Future Import GGUF copies to the chosen custom folder through the normal UI");
    await page.locator('[data-page="settings"]').click(); await page.locator("#model-storage-settings").scrollIntoViewIfNeeded();
    const translations = require(path.join(source, "ui-core/locales/core.json"));
    for (const language of ["en", "es", "pt-BR", "fr", "de"]) {
      await page.evaluate(language => window.kaiCore.locale.set(language), language); await page.waitForFunction(language => document.documentElement.lang === language, language);
      assert.equal(await page.locator("#model-storage-settings h2").innerText(), translations[language]?.["Model storage"] || "Model storage");
      assert.equal(await page.locator("#model-storage-models-path").innerText(), downloaded); assert.equal(await page.locator("#model-storage-custom-path").innerText(), custom);
    }
    await page.evaluate(() => window.kaiCore.locale.set("en")); await page.waitForFunction(() => document.documentElement.lang === "en");
    await page.screenshot({ path: path.join(output, "model-storage-settings.png") }); checks.push("Storage labels follow the saved Core language and paths remain literal");
    await quit(); page = await launch(); status = await page.evaluate(() => window.kaiCore.call("storage.status")); assert.equal(status.modelsDir, downloaded); assert.equal(status.customDir, custom); assert.equal(status.customCount, 2);
    checks.push("A fresh Core process uses both saved locations and keeps imported models available");
    assert.deepEqual(errors, []); await quit();
    const report = { passed: true, checks, syntheticProfile: true, realExternalDriveTested: false, output }; fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } finally { if (app) await quit(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
