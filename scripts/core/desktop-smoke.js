"use strict";
// Launch the real Core entry with a synthetic existing profile. This does not
// read the user's normal appData, wallet, model files, credentials or accounts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { WalletService } = require("../../core/lib/wallet");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-desktop-smoke-"));
  const appData = path.join(root, "app-data"), dataDir = path.join(appData, "Koinos AI", "core");
  fs.mkdirSync(path.join(dataDir, "models"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "chats"));
  const settings = { network: { privacyMode: "local-only" }, earn: { autoStart: false }, fixture: "preserve-me" };
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify(settings));
  fs.writeFileSync(path.join(dataDir, "models", "preserved-model-canary.gguf"), "SYNTHETIC-NOT-A-REAL-MODEL");
  fs.writeFileSync(path.join(dataDir, "companion-hub.json"), '{"synthetic":"preserved-workflows-and-brain"}');
  fs.writeFileSync(path.join(dataDir, "chats", "smoke.json"), JSON.stringify({ id: "smoke", title: "Preserved conversation", messages: [{ role: "user", content: "Synthetic history" }] }));
  const wallet = new WalletService(path.join(dataDir, "wallet"));
  const password = "synthetic-smoke-password-42";
  const address = wallet.create({ password }).address;
  wallet.lock();
  const walletBefore = fs.readFileSync(path.join(dataDir, "wallet", "wallet.json"), "utf8");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "kai-desktop-smoke", version: require("../../package.json").version, main: "desktop.js" }));
  const wrapper = path.join(root, "desktop.js");
  const appRoot = process.env.KAI_SMOKE_SOURCE_ROOT || path.resolve(__dirname, "../..");
  // Only the fixture wraps outbound fetch. The production entry runs unchanged.
  fs.writeFileSync(wrapper, `"use strict";
const electron = require(${JSON.stringify(require.resolve("electron"))});
electron.app.setPath('appData', ${JSON.stringify(appData)});
electron.app.disableHardwareAcceleration();
electron.dialog.showErrorBox = (title, message) => console.error("SMOKE_STARTUP_ERROR", title, message);
${process.env.KAI_SMOKE_SYNTHETIC_LOCK === '1' ? 'electron.app.requestSingleInstanceLock = () => true; // Fixture only: container forbids Unix sockets.' : ''}
global.__smokeExternalCalls = [];
const originalFetch = global.fetch;
global.fetch = (input, ...args) => {
  const url = new URL(typeof input === 'string' ? input : input.url || String(input));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    global.__smokeExternalCalls.push(url.origin);
    return Promise.reject(Error('Smoke test forbids external requests'));
  }
  return originalFetch(input, ...args);
};
require(${JSON.stringify(path.join(appRoot, "electron/core-main.js"))});
`);
  // Electron's npm module resolves to the binary under Node, but in Electron
  // itself `require('electron')` is a built-in module. Avoid the npm shim path.
  fs.writeFileSync(wrapper, fs.readFileSync(wrapper, "utf8").replace(`require(${JSON.stringify(require.resolve("electron"))})`, "require('electron')"));
  const args = [];
  if (process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox");
  if (process.platform === "linux" && !process.env.DISPLAY) args.push("--ozone-platform=headless");
  args.push(root);
  const env = { ...process.env, KAI_CORE_DATA: dataDir, KAI_CORE_PORT: "0", KAI_CHANNEL: "core" };
  delete env.ELECTRON_RUN_AS_NODE; delete env.KAI_CORE_TOKEN; delete env.KAI_SESSION_SECRET;
  let application, output = "";
  const pageErrors = [];
  try {
    application = await electron.launch({ executablePath: require("electron"), args, env, timeout: 30000 });
    application.process().stdout?.on("data", chunk => { output = (output + chunk).slice(-10000); });
    application.process().stderr?.on("data", chunk => { output = (output + chunk).slice(-10000); });
    const page = await application.firstWindow({ timeout: 30000 });
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.waitForFunction(() => document.getElementById("profile-title")?.textContent === "Your existing workspace is connected", null, { timeout: 15000 });
    const status = await page.evaluate(() => window.kaiCore.call("status"));
    assert.equal(status.profile.mode, "existing");
    assert.equal(status.profile.dataDir, dataDir);
    assert.equal(status.profile.modelsReused, true);
    assert.equal(status.profile.preserved.wallet, true);
    assert.equal(status.profile.preserved.chats, true);
    assert.equal(status.profile.preserved.workflowsAndBrain, true);
    assert.equal(status.wallet.address, address);
    assert.equal(status.network.privacyMode, "local-only");
    assert.equal(await page.locator("#notice.error").count(), 0);
    assert.equal(await application.evaluate(({ app }) => app.getName()), "Koinos AI");
    assert.equal(await application.evaluate(({ app }) => app.getPath("userData")), path.join(appData, "Koinos AI"));
    for (const tab of ["models", "plugins", "wallet", "earning", "settings", "overview"]) {
      await page.locator(`[data-page="${tab}"]`).click();
      assert.equal(await page.locator(`[data-panel="${tab}"]`).isVisible(), true, `${tab} did not open`);
      assert.equal(await page.locator("[data-panel]:visible").count(), 1, "multiple workspace panels visible");
    }
    await page.locator('[data-page="models"]').click();
    assert.ok(await page.locator("#models article").count() > 0, "model catalog was not rendered");
    await page.locator('[data-page="wallet"]').click();
    assert.equal(await page.locator("#create-wallet").isVisible(), false, "existing wallet must not offer replacement");
    assert.equal(await page.locator("#restore-wallet").isVisible(), false);
    await page.locator("#password").fill(password);
    await page.locator("#unlock-button").click();
    await page.waitForFunction(() => !document.getElementById("lock-wallet").hidden, null, { timeout: 15000 });
    assert.equal((await page.evaluate(() => window.kaiCore.call("status"))).wallet.address, address);
    await page.locator("#lock-wallet").click();
    await page.waitForFunction(() => !document.getElementById("unlock-button").hidden, null, { timeout: 15000 });
    assert.equal(await page.locator("#password").inputValue(), "", "wallet password remained in the form");
    await page.locator('[data-page="settings"]').click();
    assert.equal(await page.locator("#privacy").inputValue(), "local-only");
    await page.locator('[data-page="overview"]').click();
    const screenshot = process.env.KAI_SMOKE_SCREENSHOT || path.join(os.tmpdir(), "kai-core-desktop.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    assert.deepEqual(pageErrors, [], "renderer raised an uncaught error");
    assert.deepEqual(await application.evaluate(() => global.__smokeExternalCalls), [], "Local-Only startup attempted an external fetch");
    assert.equal(fs.readFileSync(path.join(dataDir, "wallet", "wallet.json"), "utf8"), walletBefore, "existing wallet was modified");
    assert.equal(fs.readFileSync(path.join(dataDir, "models", "preserved-model-canary.gguf"), "utf8"), "SYNTHETIC-NOT-A-REAL-MODEL");
    assert.equal(fs.readFileSync(path.join(dataDir, "companion-hub.json"), "utf8"), '{"synthetic":"preserved-workflows-and-brain"}');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")).fixture, "preserve-me");
    assert.ok(fs.existsSync(path.join(status.profile.backup, "manifest.json")), "configuration backup was not created");
    console.log(`PASS: real Core desktop starts on a synthetic existing profile; all six sections work; wallet unlock/lock preserves its address; model and feature files remain unchanged; ${process.env.KAI_SMOKE_SYNTHETIC_LOCK === "1" ? "synthetic fixture lock (native locking not exercised); " : ""}no renderer errors or external fetches. Screenshot: ${screenshot}`);
  } catch (error) {
    if (output) console.error(output);
    throw error;
  } finally {
    await application?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
