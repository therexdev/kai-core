"use strict";
// Real Core UI/IPC with a disposable profile. No model downloads, live account,
// GPU-memory benchmark or Windows installer verification is implied.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const source = path.resolve(__dirname, "../.."), { _electron } = require("playwright-core");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kai-context-ui-")), profile = path.join(temp, "profile");
const output = process.env.KAI_CONTEXT_SMOKE_OUTPUT || path.join(temp, "report"); fs.mkdirSync(output, { recursive: true });
require(path.join(source, "electron/foundation-profile")).prepareFoundationProfile(profile);
fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ interface: { language: "en" }, network: { privacyMode: "local-only" }, earn: { autoStart: false } }));
fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ name: "kai-context-smoke", version: "1.0.0", main: "desktop.js" }));
fs.writeFileSync(path.join(temp, "desktop.js"), `require(${JSON.stringify(path.join(source, "scripts/foundation/apps-fixture.js"))}).install(${JSON.stringify({ appRoot: source, appData: path.join(temp, "app-data"), reportFile: path.join(output, "exit.json"), syntheticKeychain: true, realDialogs: true })});require(${JSON.stringify(path.join(source, "electron/core-main.js"))});`);
const env = { ...process.env, KAI_CORE_DATA: profile, KAI_CORE_PORT: "0", KAI_CHANNEL: "core" }; delete env.ELECTRON_RUN_AS_NODE; delete env.KAI_SESSION_SECRET; delete env.KAI_CORE_TOKEN;
const args = [...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : []), ...(process.platform === "linux" && !process.env.DISPLAY ? ["--ozone-platform=headless"] : []), temp];
let app; const errors = [], checks = [];
async function launch() {
  app = await _electron.launch({ executablePath: require("electron"), args, env, timeout: 60000 });
  const page = await app.firstWindow(); page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(20000);
  await app.evaluate(() => global.__foundationWindow.setContentSize(1280, 950));
  await page.waitForFunction(() => document.getElementById("version")?.textContent.startsWith("v"));
  await page.locator('[data-page="models"]').click();
  await page.locator('[data-context-model="koinos-smart"]').waitFor({ state: "attached" });
  return page;
}
async function quit() {
  const closing = app, process = closing.process(); app = null;
  await closing.evaluate(({ app }) => app.quit()).catch(() => {});
  await new Promise((resolve, reject) => {
    if (process.exitCode !== null) return resolve();
    const timer = setTimeout(() => { process.kill(); reject(Error("Core did not quit after context test")); }, 10000);
    process.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
async function current(page) { return page.evaluate(async () => (await window.kaiCore.call("status")).models.find(model => model.alias === "koinos-smart")); }
(async () => {
  try {
    let page = await launch();
    const card = page.locator('[data-model-card="koinos-smart"]'); await card.locator("summary").click();
    let model = await current(page); assert.equal(model.contextSize, 32768); assert.equal(model.contextOverride, null);
    const select = card.locator("select"); assert.equal(await select.inputValue(), "default");
    assert.ok(!(await select.locator("option").allTextContents()).some(text => /65,536/.test(text)));
    await select.selectOption("8192");
    await page.waitForFunction(async () => (await window.kaiCore.call("status")).models.find(model => model.alias === "koinos-smart").contextSize === 8192);
    checks.push("Qwen defaults to 32K, rejects choices above its limit, and saves an 8K override through the real UI");
    await page.screenshot({ path: path.join(output, "model-context.png") });
    for (const language of ["es", "pt-BR", "fr", "de", "en"]) {
      await page.evaluate(language => window.kaiCore.locale.set(language), language);
      await page.waitForFunction(language => document.documentElement.lang === language, language);
      const label = require("../../ui-core/locales/core.json")[language]?.["Context window"] || "Context window";
      assert.equal(await card.locator(".model-context-label span").innerText(), label);
      assert.equal(await select.inputValue(), "8192");
    }
    checks.push("Context controls translate into all five Core languages without losing the choice");
    await quit(); page = await launch(); model = await current(page); assert.equal(model.contextSize, 8192);
    checks.push("The per-model override survives a complete Core restart");
    const reopened = page.locator('[data-model-card="koinos-smart"]'); await reopened.locator("summary").click();
    await reopened.locator("select").selectOption("default");
    await page.waitForFunction(async () => (await window.kaiCore.call("status")).models.find(model => model.alias === "koinos-smart").contextSize === 32768);
    assert.equal((await current(page)).contextOverride, null);
    checks.push("Model default restores 32K without downloading weights");
    assert.deepEqual(errors, []); await quit();
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ ok: true, syntheticProfile: true, syntheticLock: process.env.KAI_SMOKE_SYNTHETIC_LOCK === "1", deviceInferenceTested: false, checks }, null, 2));
    console.log(JSON.stringify({ ok: true, output, checks }, null, 2));
  } catch (error) { if (app) await quit().catch(() => {}); console.error(error.stack); process.exitCode = 1; }
})();
