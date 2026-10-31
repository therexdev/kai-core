"use strict";
// Real Core window, Settings, IPC sender checks and styled confirmation. Only the
// updater boundary is synthetic: no release downloads, signatures or installs.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const appRoot = path.resolve(process.env.KAI_SMOKE_SOURCE_ROOT || path.join(__dirname, "../.."));
async function main() {
  const runtimeRoot = path.resolve(process.env.KAI_SMOKE_RUNTIME_ROOT || appRoot), { _electron } = require("playwright-core");
  const output = path.resolve(process.env.KAI_UPDATES_SMOKE_OUTPUT || path.join(os.tmpdir(), "kai-updates-smoke")); fs.mkdirSync(output, { recursive: true });
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-updates-"))), profile = path.join(temp, "profile"), exitReport = path.join(temp, "exit.json");
  const report = { realCore: true, realSettings: true, realIPC: true, syntheticUpdater: true, syntheticProfile: true, syntheticKeychain: true, syntheticSingleton: true, liveActions: false, checks: [], screenshots: [] };
  require(path.join(appRoot, "electron/foundation-profile")).prepareFoundationProfile(profile);
  fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ network: { privacyMode: "local-only" }, earn: { autoStart: false } }));
  fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ name: "kai-updates-smoke", version: "1.0.0", main: "desktop.js" }));
  fs.writeFileSync(path.join(temp, "desktop.js"), `
require(${JSON.stringify(path.join(__dirname, "apps-fixture.js"))}).install(${JSON.stringify({ appRoot: runtimeRoot, appData: path.join(temp, "app-data"), reportFile: exitReport, syntheticKeychain: true, realDialogs: true })});
require(${JSON.stringify(path.join(runtimeRoot, "electron/core-updates"))}).createCoreUpdates = options => {
  const state = { state:'idle',revision:0,currentVersion:'0.7.8',availableVersion:null,automaticCheck:true,lastCheckedAt:null,nextCheckAt:null,progress:null,error:null,paused:false,canDownload:false,canInstall:false,manualOnly:false,reason:null };
  const value=()=>structuredClone(state), set=next=>{Object.assign(state,next);state.revision++;return value();};
  const fixture=global.__updatesFixture={calls:[],installs:0,set,complete(next){const out=set(next);fixture.resolve?.(out);fixture.resolve=null;return out;}};
  return {
    status:value,start(){},wake(){},dispose(){},
    privacyChanged(){set({paused:options.isLocalOnly()});},
    check(){fixture.calls.push('check');set({state:'checking',error:null});return new Promise(resolve=>{fixture.resolve=resolve;});},
    configure(input){fixture.calls.push('configure');return set({automaticCheck:input.automaticCheck});},
    download(){fixture.calls.push('download');set({state:'downloading',canDownload:false,progress:{percent:37,transferred:37,total:100}});return new Promise(resolve=>{fixture.resolve=resolve;});},
    async install(){fixture.calls.push('install');const approved=await options.approveInstall(state.availableVersion);if(approved){fixture.installs++;return set({state:'installing'});}return value();},
    openRelease(){fixture.calls.push('openRelease');return value();}
  };
};
require(${JSON.stringify(path.join(runtimeRoot, "electron/core-main.js"))});
`);
  const args = []; if (process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox"); if (process.platform === "linux" && !process.env.DISPLAY) args.push("--ozone-platform=headless"); args.push(temp);
  const env = { ...process.env, KAI_CORE_DATA: profile, KAI_CORE_PORT: "0", KAI_CHANNEL: "core", KAI_SMOKE_SYNTHETIC_LOCK: "1" }; delete env.ELECTRON_RUN_AS_NODE; delete env.KAI_SESSION_SECRET; delete env.KAI_CORE_TOKEN;
  let app, page, logs = ""; const errors = [];
  const until = async (condition, message) => { const end = Date.now() + 30000; do { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < end); throw Error(message); };
  const set = async value => { await app.evaluate((_electron, value) => global.__updatesFixture.set(value), value); await page.evaluate(() => window.KaiCoreUpdates.refresh()); };
  const capture = async name => { await page.locator("#application-updates").scrollIntoViewIfNeeded(); const file = path.join(output, name + ".png"); await page.screenshot({ path: file }); report.screenshots.push(file); };
  const dialog = async () => { let popup; await until(() => (popup = app.windows().find(w => !w.isClosed() && /\/dialog\.html$/.test(w.url()))), "Update confirmation did not open"); await popup.locator("#dialog-loading").waitFor({ state: "hidden" }); return popup; };
  try {
    app = await _electron.launch({ executablePath: require("electron"), args, env, timeout: 60000 });
    for (const stream of [app.process().stdout, app.process().stderr]) stream?.on("data", chunk => { logs = (logs + chunk).slice(-30000); });
    page = await app.firstWindow(); page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(30000);
    await app.evaluate(() => { global.__foundationWindow.setContentSize(1280, 900); return true; });
    await page.waitForFunction(() => document.getElementById("version")?.textContent.startsWith("v"));
    await page.locator("#settings-nav").click(); await page.locator("#application-updates").scrollIntoViewIfNeeded();
    assert.equal(await page.locator("#updates-automatic").isChecked(), true);
    await page.locator("#updates-automatic").uncheck(); await page.waitForFunction(() => window.KaiCoreUpdates.snapshot().info.automaticCheck === false);
    await page.locator("#updates-automatic").check(); await page.waitForFunction(() => window.KaiCoreUpdates.snapshot().info.automaticCheck === true);
    report.checks.push("Automatic check preference changes through real Settings IPC without downloading or restarting");
    await page.locator("#check-updates").click(); await page.waitForFunction(() => window.KaiCoreUpdates.snapshot().info.state === "checking");
    assert.equal(await page.locator("#check-updates").isDisabled(), true);
    await app.evaluate(() => global.__updatesFixture.complete({ state: "current", lastCheckedAt: Date.now() }));
    await page.waitForFunction(() => document.getElementById("updates-title").textContent.includes("up to date"));
    await capture("settings-up-to-date");
    report.checks.push("Manual checks show checking and up-to-date results inline, with version and last checked time");
    await set({ state: "available", availableVersion: "0.7.9", canDownload: true });
    assert.equal(await page.locator("#core-update-badge").isVisible(), true);
    await page.locator("[data-page='models']").click(); assert.equal(await page.locator("#core-update-badge").isVisible(), true);
    await app.evaluate(() => { global.__foundationWindow.hide(); return true; });
    await app.evaluate(() => { global.__foundationWindow.show(); return true; });
    await page.locator("#settings-nav").click(); await page.locator("#updates-download").click();
    await page.waitForFunction(() => document.getElementById("updates-progress-value").textContent === "37%");
    assert.equal(await page.locator("#updates-progress-row").isVisible(), true);
    await capture("settings-downloading");
    report.checks.push("Available-update badge survives navigation/tray hiding and download progress stays inside the Settings card");
    await app.evaluate(() => global.__updatesFixture.complete({ state: "downloaded", progress: null, canDownload: false, canInstall: true }));
    await page.waitForFunction(() => !document.getElementById("updates-install").hidden && !document.getElementById("updates-install").disabled);
    assert.equal(await app.evaluate(() => global.__updatesFixture.installs), 0);
    await page.locator("#updates-install").click(); let popup = await dialog();
    assert.match(await popup.locator("body").innerText(), /restart|install/i);
    await popup.locator("#dialog-close").click();
    await page.waitForFunction(() => !document.getElementById("updates-install").disabled);
    assert.equal(await app.evaluate(() => global.__updatesFixture.installs), 0);
    await page.locator("#updates-install").click(); popup = await dialog();
    assert.match(await popup.locator("body").innerText(), /Install KAI Core Beta 0\.7\.9/);
    await popup.getByRole("button", { name: "Restart and install", exact: true }).click();
    await page.waitForFunction(() => window.KaiCoreUpdates.snapshot().info.state === "installing");
    assert.equal(await app.evaluate(() => global.__updatesFixture.installs), 1);
    report.checks.push("Downloaded updates do not install automatically; the real styled confirmation requires explicit approval and supports cancellation");
    await set({ state: "error", error: "Synthetic signature mismatch. The update was not installed.", canInstall: false });
    await page.locator("#update-close").click(); await page.evaluate(() => window.KaiCoreUpdates.refresh());
    assert.equal(await page.locator("#update-notice").isVisible(), false);
    await set({ state: "available", error: null, manualOnly: true, reason: "Portable copies use a manual download.", canDownload: false });
    assert.equal(await page.locator("#updates-download").isVisible(), false); assert.equal(await page.locator("#updates-install").isVisible(), false);
    assert.equal(await page.locator("#updates-open-release").innerText(), "Download release");
    await page.locator("#updates-open-release").click();
    report.checks.push("Errors are dismissible across polls and manual-only builds offer the release download instead of in-app install");
    await set({ paused: true });
    assert.equal(await page.locator("#check-updates").isDisabled(), true); assert.equal(await page.locator("#updates-open-release").isDisabled(), true);
    assert.match(await page.locator("#updates-detail").innerText(), /Local only/);
    await set({ paused: false, state: "available", manualOnly: false, reason: null, canDownload: true });
    await app.evaluate(() => { global.__foundationWindow.setContentSize(800, 680); return true; });
    await capture("settings-minimum-width");
    const layout = await page.evaluate(() => { const c = document.getElementById("application-updates"), p = document.querySelector('[data-panel="settings"]'); return { cardFits: c.scrollWidth <= c.clientWidth + 1, pageFits: p.scrollWidth <= p.clientWidth + 1, migrationLast: p.lastElementChild.id === "alpha-migration-settings", font: getComputedStyle(c).fontFamily }; });
    assert.equal(layout.cardFits, true); assert.equal(layout.pageFits, true); assert.equal(layout.migrationLast, true); assert.match(layout.font, /Inter|Segoe UI/);
    report.checks.push("Local-only privacy state disables network actions, 800px layout fits, and Alpha migration remains last in Settings");
    assert.deepEqual(errors, []);
    report.status = "passed";
  } catch (error) { report.status = "failed"; report.error = error.stack; throw error; }
  finally { if (app) await app.close().catch(() => {}); report.logs = logs; report.pageErrors = errors; fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2)); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); console.log("Report", path.join(output, "report.json")); }
}
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
