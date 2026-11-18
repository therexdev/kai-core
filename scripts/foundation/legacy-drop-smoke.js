"use strict";
// Actual sandboxed Electron renderer; synthetic receipts only, no live RPC or funds.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { _electron } = require("playwright-core");
const source = path.resolve(__dirname, "../.."), temp = fs.mkdtempSync(path.join(os.tmpdir(), "kai-drop-smoke-"));
const output = process.env.KAI_DROP_SMOKE_OUTPUT || path.join(os.tmpdir(), "kai-drop-smoke-results");
fs.mkdirSync(output, { recursive: true });
const manifest = require("../../core/lib/legacy-kai-drop.json"), address = Object.keys(manifest.allocations)[1], allocation = manifest.allocations[address];
const drop = { campaign: manifest.id, address, sender: manifest.sender, network: "mainnet", token: "KOIN", snapshotAt: manifest.snapshotAt, ...allocation, eligible: true, state: "awaiting", payment: null };
const url = file => pathToFileURL(path.join(source, "ui-core", file)).href;
fs.writeFileSync(path.join(temp, "index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="${url("core.css")}"><link rel="stylesheet" href="${url("earning.css")}"></head><body><main style="max-width:1060px;padding:32px;margin:auto"><div id="earning-content"></div></main><script src="${url("locales/catalogs.js")}"></script><script src="${url("locales/core.js")}"></script><script src="${url("i18n.js")}"></script><script>
window.fixtureDrop=${JSON.stringify(drop)};window.calls=[];window.KaiCoreNotice={create:()=>({show(){}})};
window.kaiCore={call:async(method,input)=>{window.calls.push({method,input});if(method==='earn.legacyBalance')return{wallet:{address:window.fixtureDrop.address},earnings:{error:'testnet offline'},drop:window.fixtureDrop};return{opened:true};},credit:async(action)=>{window.calls.push({action});if(action==='provider-public-info')return{state:'ready',enabled:false,running:false,models:[],modelAvailability:[]};return{walletAddress:window.fixtureDrop.address,scope:'a'.repeat(64),observedAt:Date.now(),payouts:[]};}};
</script><script src="${url("earning.js")}"></script></body></html>`);
fs.writeFileSync(path.join(temp, "desktop.cjs"), `const {app,BrowserWindow,session}=require('electron');app.disableHardwareAcceleration();app.whenReady().then(async()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,done)=>done({cancel:true}));const w=new BrowserWindow({width:1150,height:950,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.setContentSize(1150,950);await w.loadFile(${JSON.stringify(path.join(temp,"index.html"))});});`);
(async () => {
  let app; const errors = [], report = { syntheticReceipts: true, liveNetwork: false, checks: [] };
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const args = [...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : []), ...(process.platform === "linux" && !process.env.DISPLAY ? ["--ozone-platform=headless"] : []), path.join(temp, "desktop.cjs")];
    app = await _electron.launch({ executablePath: require("electron"), args, env, timeout: 30000 });
    const page = await app.firstWindow(); page.on("pageerror", e => errors.push(e.message));
    await page.waitForFunction(() => !!window.KaiCoreEarning);
    await page.evaluate(() => { window.KaiCoreEarning.observe({}, "local-only"); window.KaiCoreEarning.enter(); });
    await page.waitForFunction(() => document.getElementById("earn-koin-drop").textContent === "2,820.12053646");
    assert.equal(await page.locator("#earn-drop-paid").isVisible(), false); assert.equal(await page.locator("#earn-drop-tx").isVisible(), false);
    report.checks.push("Exact snapshot entitlement is shown even when testnet balance is unavailable");
    await page.evaluate(() => { window.fixtureDrop.state = "paid"; window.fixtureDrop.payment = { txId: "0x1220" + "a".repeat(64), blockId: "0x1220" + "b".repeat(64), blockHeight: "42", verifiedAt: Date.now() }; return window.KaiCoreEarning.refresh(); });
    assert.equal(await page.locator("#earn-drop-paid").innerText(), "PAID"); assert.equal(await page.locator("#earn-drop-paid").isVisible(), true);
    assert.equal(await page.locator("#earn-drop-paid").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(18, 59, 40)");
    await page.locator("#earn-drop-tx").click();
    assert.equal(await page.evaluate(() => window.calls.find(c => c.method === "desktop.openExternal").input.url), "https://koinosblocks.com/tx/0x1220" + "a".repeat(64));
    report.checks.push("Green PAID badge and TX link use the verified receipt ID through native external navigation");
    await page.screenshot({ path: path.join(output, "paid-en.png"), fullPage: true });
    await page.evaluate(() => window.KaiI18n.setLanguage("de"));
    assert.equal(await page.locator("#earn-drop-paid").innerText(), "BEZAHLT");
    report.checks.push("Paid badge follows shared language changes");
    await page.evaluate(() => { window.fixtureDrop = { ...window.fixtureDrop, address: "synthetic-new-wallet", kaiAtoms: "0", koinAtoms: "0", eligible: false, state: "not-eligible", payment: null }; window.dispatchEvent(new Event("kai-credit-identity-changed")); });
    await page.waitForFunction(() => document.getElementById("earn-koin-drop").textContent === "0");
    assert.equal(await page.locator("#earn-drop-paid").isVisible(), false); assert.equal(await page.locator("#earn-drop-tx").getAttribute("href"), null);
    assert.equal(await page.evaluate(() => window.calls.some(c => /start|authorize|send|sign/.test(c.action || c.method))), false);
    assert.deepEqual(errors, []); report.checks.push("Wallet switch removes prior receipt; monitoring never starts earning or signs"); report.status = "passed";
  } catch (error) { report.status = "failed"; report.error = error.stack; throw error; }
  finally { fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2)); if (app) await app.close(); fs.rmSync(temp, { recursive: true, force: true }); }
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
