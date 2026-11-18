"use strict";
// Real Core renderer with an isolated local-only profile. No model inference,
// paid jobs, live wallets or hardware performance claims are exercised here.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { _electron } = require("playwright-core");
const source = path.resolve(__dirname, "../.."), temp = fs.mkdtempSync(path.join(os.tmpdir(), "kai-local-models-ui-"));
const output = process.env.KAI_LOCAL_MODELS_SMOKE_OUTPUT || path.join(temp, "report"); fs.mkdirSync(output, { recursive: true });
const profile = path.join(temp, "profile");
require("../../electron/foundation-profile").prepareFoundationProfile(profile);
fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ interface: { language: "en" }, network: { privacyMode: "local-only" }, earn: { autoStart: false } }));
fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ name: "kai-local-models-smoke", version: "1.0.0", main: "desktop.js" }));
fs.writeFileSync(path.join(temp, "desktop.js"), `require(${JSON.stringify(path.join(__dirname, "apps-fixture.js"))}).install(${JSON.stringify({ appRoot: source, appData: path.join(temp, "app-data"), reportFile: path.join(output, "exit.json"), syntheticKeychain: true })});require(${JSON.stringify(path.join(source, "electron/core-main.js"))});`);
const env = { ...process.env, KAI_CORE_DATA: profile, KAI_CORE_PORT: "0", KAI_CHANNEL: "core" };
delete env.ELECTRON_RUN_AS_NODE; delete env.KAI_SESSION_SECRET; delete env.KAI_CORE_TOKEN;
const args = [...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : []), ...(process.platform === "linux" && !process.env.DISPLAY ? ["--ozone-platform=headless"] : []), temp];
(async () => {
  let app; const errors = [], checks = [];
  try {
    app = await _electron.launch({ executablePath: require("electron"), args, env, timeout: 60000 });
    const page = await app.firstWindow(); page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(20000);
    await app.evaluate(() => global.__foundationWindow.setContentSize(1280, 950));
    await page.waitForFunction(() => document.getElementById("version")?.textContent.startsWith("v"));
    await page.locator('[data-page="models"]').click();
    const section = page.locator("#unsupported-models-section"); await section.scrollIntoViewIfNeeded();
    assert.equal(await section.isVisible(), true);
    assert.equal(await section.locator("[data-model-card]").count(), 4);
    assert.equal(await page.locator('#models [data-local-only="true"]').count(), 0);
    const sizes = { "gemma4-12b": "7.7 GB", "muse-glimmer-30b": "16.8 GB", "qwen38-27b": "17.4 GB", "gemma4-31b": "19.6 GB" };
    for (const [alias, size] of Object.entries(sizes)) {
      const card = section.locator(`[data-model-card="${alias}"]`);
      assert.match(await card.innerText(), /Local use only · Not supported for Earn/);
      assert.ok((await card.innerText()).includes(size));
      assert.equal(await card.locator(".model-action").isEnabled(), true);
      assert.equal(await card.locator(".model-feedback").isVisible(), true);
    }
    checks.push("Four experimental downloads render in a separate section with accurate sizes and local-only labels");
    // The fixture cancels website confirmation, so this exercises the actual
    // button/IPC path without opening a browser or submitting a report.
    await section.locator('[data-model-card="gemma4-12b"] .model-feedback').click();
    await page.waitForFunction(() => !document.querySelector('[data-model-card="gemma4-12b"] .model-feedback').disabled);
    assert.ok(await app.evaluate(() => global.__foundationSmoke.dialogs.some(dialog => dialog.title === "Open website")));
    const reportUrl = await page.evaluate(() => window.KaiCoreModels.feedbackUrl({ alias: "gemma4-12b", label: "Gemma 4 12B", package: "gemma4-12b-q4_k_m@1" }));
    assert.equal(new URL(reportUrl).pathname, "/therexdev/kai-core/issues/new");
    checks.push("Feedback reaches website confirmation with a report template and cancellation submits nothing");
    await page.screenshot({ path: path.join(output, "local-models-wide.png") });
    await app.evaluate(() => global.__foundationWindow.setContentSize(960, 850));
    await section.scrollIntoViewIfNeeded();
    const overflow = await section.evaluate(node => node.scrollWidth > node.clientWidth);
    assert.equal(overflow, false);
    await page.screenshot({ path: path.join(output, "local-models-compact.png") });
    checks.push("Model cards remain usable in a compact desktop window");
    assert.deepEqual(errors, []);
    const report = { platform: process.platform, realCore: true, realInference: false, syntheticInstanceLock: process.env.KAI_SMOKE_SYNTHETIC_LOCK === "1", checks, errors };
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, output }, null, 2));
  } finally { await app?.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
