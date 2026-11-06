"use strict";
// Real sandboxed Electron layout; balances/prices are synthetic and all
// external network requests are blocked. No wallet keys or funds are used.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url"), { _electron } = require("playwright-core");
const source = path.resolve(__dirname, "../.."), temp = fs.mkdtempSync(path.join(os.tmpdir(), "kai-sidebar-wallet-"));
const output = process.env.KAI_SIDEBAR_WALLET_OUTPUT || path.join(os.tmpdir(), "kai-sidebar-wallet-smoke");
const url = file => pathToFileURL(path.join(source, "ui-core", file)).href;
fs.mkdirSync(output, { recursive: true });
const sidebar = fs.readFileSync(path.join(source, "ui-core/index.html"), "utf8").match(/<aside id="sidebar">[\s\S]*?<\/aside>/)[0]
  .replace('src="assets/brand-mark.svg"', `src="${url("assets/brand-mark.svg")}"`);
fs.writeFileSync(path.join(temp, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${url("core.css")}"></head><body>${sidebar}<main id="main"><header class="workspace-header"><h1>Wallet</h1><span class="workspace-badge">CORE</span></header><section class="page"><div class="page-head"><div><h1>Your wallet, at a glance</h1><p>Desktop layout verification with synthetic balances.</p></div></div></section></main><script src="${url("locales/catalogs.js")}"></script><script src="${url("locales/core.js")}"></script><script src="${url("i18n.js")}"></script><script>
window.fixtureAmount='3732.80583588';window.calls=[];window.kaiCore={call:async method=>{window.calls.push(method);return{address:'fixture-wallet',network:'mainnet',tokenSymbol:'KOIN',koin:window.fixtureAmount,observedAt:Date.now()}},credit:async(action,input)=>{window.calls.push(action);return{estimate:{priceDetails:{usdPerKoin:'0.03125'},observedAt:Date.now(),expiresAt:Date.now()+60000}}}};window.addEventListener('kai-core-navigate',event=>window.destination=event.detail.page);
</script><script src="${url("sidebar-wallet.js")}"></script></body></html>`);
fs.writeFileSync(path.join(temp, "desktop.cjs"), `const {app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(path.join(temp, "profile"))});app.disableHardwareAcceleration();app.whenReady().then(async()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,done)=>done({cancel:true}));const w=new BrowserWindow({width:1150,height:850,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.setContentSize(1150,850);await w.loadFile(${JSON.stringify(path.join(temp, "index.html"))});});`);
(async () => {
  let app; const errors = [], report = { syntheticBalances: true, liveNetwork: false, checks: [] };
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: require("electron"), args: [...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : []), ...(process.platform === "linux" && !process.env.DISPLAY ? ["--ozone-platform=headless"] : []), path.join(temp, "desktop.cjs")], env });
    const page = await app.firstWindow(); page.on("pageerror", e => errors.push(e.message));
    await page.waitForFunction(() => !!window.KaiSidebarWallet);
    await page.evaluate(() => window.KaiSidebarWallet.observe({ address: "fixture-wallet", unlocked: false }, "network"));
    await page.waitForFunction(() => document.getElementById("sidebar-wallet-usd").textContent === "$116.65 USD");
    assert.equal(await page.locator("#sidebar-wallet-amount").innerText(), "3,732.8058");
    assert.match(await page.locator("#sidebar-wallet").getAttribute("title"), /3732\.80583588 KOIN/);
    for (const width of [1150, 800, 520]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 850), width);
      await page.waitForFunction(w => innerWidth === w, width);
      const geometry = await page.evaluate(() => {
        const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, width: r.width, height: r.height }; };
        return { card: rect("sidebar-wallet"), menu: rect("plugin-nav"), rail: rect("sidebar"), amount: rect("sidebar-wallet-amount"), usd: rect("sidebar-wallet-usd"), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.ok(geometry.card.y >= geometry.menu.bottom && geometry.card.y - geometry.menu.bottom <= 24);
      assert.ok(geometry.card.right < geometry.rail.right && geometry.card.height <= 80); assert.equal(geometry.overflow, false);
      if (width > 600) assert.ok(geometry.usd.y > geometry.amount.y);
      else assert.equal(await page.locator(".sidebar-wallet-icon").isVisible(), true);
      await page.screenshot({ path: path.join(output, `sidebar-${width}.png`) });
    }
    report.checks.push("Compact two-line KOIN/USD card fits below the upper menu at desktop, narrow and collapsed widths");
    await page.locator("#sidebar-wallet").click(); assert.equal(await page.evaluate(() => window.destination), "wallet");
    report.checks.push("Clicking the card opens Wallet");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1150, 850));
    await page.evaluate(() => window.KaiI18n.setLanguage("de"));
    await page.waitForFunction(() => document.getElementById("sidebar-wallet-amount").textContent === "3.732,8058");
    assert.match(await page.locator("#sidebar-wallet-usd").innerText(), /116,65/);
    await page.evaluate(() => { window.fixtureAmount = "184467440737.09551615"; return window.KaiSidebarWallet.refresh(); });
    assert.match(await page.locator("#sidebar-wallet").getAttribute("title"), /184467440737\.09551615 KOIN/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    report.checks.push("Shared language changes and maximum token amounts keep a bounded layout with exact hover text");
    await page.evaluate(() => window.KaiSidebarWallet.observe({ address: "fixture-wallet" }, "local-only"));
    await page.waitForFunction(() => document.getElementById("sidebar-wallet-usd").textContent === "— USD");
    assert.deepEqual(await page.evaluate(() => [...new Set(window.calls)].sort()), ["purchase-estimate", "wallet.summary"]);
    assert.deepEqual(errors, []); report.checks.push("Read-only card needs no wallet unlock and hides the USD estimate in Local-Only"); report.status = "passed";
  } catch (error) { report.status = "failed"; report.error = error.stack; throw error; }
  finally { fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2)); if (app) await app.close(); fs.rmSync(temp, { recursive: true, force: true }); }
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
