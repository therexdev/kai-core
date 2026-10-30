"use strict";

// Real Core shell, signed packages, PluginHost and native WebContentsViews.
// Only the profile, chain/provider responses, tray in headless Linux, and the
// delayed inference are synthetic. No user accounts, money or models are used.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { _electron: electron } = require("playwright-core");
const { canonical } = require("../../core/lib/plugins/package");

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-apps-smoke-")));
  const appRoot = process.env.KAI_SMOKE_SOURCE_ROOT || path.resolve(__dirname, "../..");
  const output = process.env.KAI_APPS_SMOKE_OUTPUT || path.join(os.tmpdir(), "kai-apps-smoke");
  const appData = path.join(root, "app-data"), dataDir = path.join(appData, "Koinos AI", "core");
  fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ network: { privacyMode: "local-only" }, earn: { autoStart: false }, fixture: "apps-smoke" }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "kai-apps-smoke", version: require("../../package.json").version, main: "desktop.js" }));
  const key = crypto.generateKeyPairSync("ed25519");
  const fixtures = [
    { id: "smoke.notes", name: "Synthetic Notes" },
    { id: "smoke.tasks", name: "Synthetic Tasks" },
    { id: "smoke.disabled", name: "Synthetic Disabled" },
  ];
  const overflowFixtures = Array.from({ length: 8 }, (_, index) => ({ id: `smoke.extra-${index + 1}`, name: `Synthetic App ${index + 1}` }));
  for (const fixture of [...fixtures, ...overflowFixtures]) {
    const manifest = { schema: 1, apiVersion: 1, ...fixture, version: "1.0.0", description: "Synthetic persistent app fixture. No real model or account is used.", entry: "index.html", permissions: ["models.read", "inference.local", "storage.read", "storage.write"] };
    const files = {
      "index.html": '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"></head><body><h1>' + fixture.name + '</h1><p>This isolated test app keeps its draft and running work while you switch KAI pages.</p><label>Draft<textarea id="draft"></textarea></label><p id="work">Ready</p><script src="app.js"></script></body></html>',
      "app.css": 'body{font:15px system-ui;margin:0;padding:32px;background:#f4f7fd;color:#14284e}h1{margin-top:0}label{display:grid;gap:12px;max-width:600px}textarea{font:inherit;background:white;border:1px solid #dbe6f6;border-radius:12px;min-height:180px;padding:16px;color:inherit}',
      "app.js": 'window.smokeTicks=0;setInterval(()=>window.smokeTicks++,40);window.runSmoke=()=>{document.getElementById("work").textContent="Running";window.kai.call("inference.local",{model:"smoke-local",prompt:"Persistent app request",maxTokens:128}).then(result=>{document.getElementById("work").textContent=result.text},error=>{document.getElementById("work").textContent="Stopped: "+error.message});};',
    };
    const pkg = { manifest, files, publicKey: key.publicKey.export({ format: "der", type: "spki" }).toString("base64"), signature: crypto.sign(null, Buffer.from(canonical({ manifest, files })), key.privateKey).toString("base64") };
    fixture.file = path.join(root, fixture.id + ".kaiplugin"); fs.writeFileSync(fixture.file, JSON.stringify(pkg));
  }
  const wrapper = `"use strict";
const electron=require('electron');
electron.app.setPath('appData',${JSON.stringify(appData)});electron.app.disableHardwareAcceleration();
${process.env.KAI_SMOKE_SYNTHETIC_LOCK === "1" ? "electron.app.requestSingleInstanceLock=()=>true; // Fixture only: container blocks Unix sockets." : ""}
electron.dialog.showErrorBox=(title,message)=>console.error('APPS_STARTUP_ERROR',title,message);
require(${JSON.stringify(path.join(__dirname, "desktop-fixture.js"))}).install({appRoot:${JSON.stringify(appRoot)}});
const managerModule=require(${JSON.stringify(path.join(appRoot, "core/lib/plugins/manager.js"))});
const FixtureManager=managerModule.PluginManager;
managerModule.PluginManager=class extends FixtureManager{constructor(...args){super(...args);if(process.env.KAI_APPS_EMPTY==='1')for(const row of this.list())this.change(row.id,'remove');}};
const hostModule=require(${JSON.stringify(path.join(appRoot, "electron/core-plugin-host.js"))});const BaseHost=hostModule.PluginHost;
hostModule.PluginHost=class extends BaseHost{constructor(...args){super(...args);global.__appsHost=this;}};
global.__appsCapture=async(file,id)=>{const image=await global.__appsHost.renderer(id).capturePage();require('node:fs').writeFileSync(file,image.toPNG());};
global.__appsOpenFile=null;electron.dialog.showOpenDialog=async()=>({canceled:!global.__appsOpenFile,filePaths:global.__appsOpenFile?[global.__appsOpenFile]:[]});
global.__smokeApprovePlugin=true;
global.__appsInference={started:0,aborted:0,completed:0};
electron.app.on('quit',()=>require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "apps-quit.json"))},JSON.stringify({inference:global.__appsInference,openApps:global.__appsHost?.windows.size})));
const fixtureFetch=global.fetch;global.fetch=(url,options={})=>{
 let body;try{body=JSON.parse(options.body||'null')}catch{}
 if(String(url).endsWith('/core/chat/completions')&&body?.messages?.[0]?.content==='Persistent app request'){
  global.__appsInference.started++;return new Promise((resolve,reject)=>{
   const abort=()=>{global.__appsInference.aborted++;reject(options.signal.reason||Error('Stopped'));};options.signal?.addEventListener('abort',abort,{once:true});
   global.__appsComplete=()=>{options.signal?.removeEventListener('abort',abort);global.__appsInference.completed++;resolve(new Response(JSON.stringify({choices:[{message:{content:'Completed while KAI was in the tray'}}]}),{headers:{'content-type':'application/json'}}));};
  });
 }
 return fixtureFetch(url,options);
};
require(${JSON.stringify(path.join(appRoot, "electron/core-main.js"))});
`;
  fs.writeFileSync(path.join(root, "desktop.js"), wrapper);
  const args = [];
  if (process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox");
  if (process.platform === "linux" && !process.env.DISPLAY) args.push("--ozone-platform=headless");
  args.push(root);
  const env = { ...process.env, KAI_CORE_DATA: dataDir, KAI_CORE_PORT: "0", KAI_CHANNEL: "core", KAI_SMOKE_TRAY_MODE: "auto", KAI_SMOKE_LIFECYCLE_FILE: path.join(root, "lifecycle.json") };
  delete env.ELECTRON_RUN_AS_NODE; delete env.KAI_CORE_TOKEN; delete env.KAI_SESSION_SECRET;
  let application, page, logs = "", savedOrder;
  const report = { syntheticProfile: true, platform: process.platform, appRoot, checks: [], screenshots: [] };
  const errors = [];
  const check = (name, callback) => Promise.resolve().then(callback).then(() => { report.checks.push(name); });
  const evaluateApp = (id, expression) => application.evaluate(async (_electron, { id, expression }) => {
    const wc = global.__appsHost.renderer(id); if (!wc) throw Error("Missing app renderer " + id);
    return wc.executeJavaScript(expression, true);
  }, { id, expression });
  const state = () => application.evaluate(({ BrowserWindow }) => ({
    windowCount: BrowserWindow.getAllWindows().length,
    mainId: global.__smokeMainWindow.id, visible: global.__smokeMainWindow.isVisible(), selected: global.__appsHost.selected,
    records: [...global.__appsHost.windows].map(([id, record]) => ({ id, wcId: record.webContents.id, ownerId: record.window.id, embedded: !!record.view, visible: record.view?.getVisible(), bounds: record.view?.getBounds(), aborted: record.controller.signal.aborted, destroyed: record.webContents.isDestroyed() })),
    inference: { ...global.__appsInference }, lifecycle: { ...global.__smokeLifecycle },
  }));
  async function until(predicate, message) {
    const end = Date.now() + 15000; let value;
    do { value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < end);
    throw Error(message);
  }
  const ids = () => page.locator("#apps-list .app-nav-row").evaluateAll(rows => rows.map(row => row.dataset.appId));
  async function resize(width, height) {
    const actual = await application.evaluate((_electron, size) => { global.__smokeMainWindow.setContentSize(size.width, size.height); return global.__smokeMainWindow.getContentSize(); }, { width, height });
    await page.setViewportSize({ width: actual[0], height: actual[1] });
  }
  async function launch(empty) {
    application = await electron.launch({ executablePath: require("electron"), args, env: { ...env, KAI_APPS_EMPTY: empty ? "1" : "0" }, timeout: 30000 });
    for (const stream of [application.process().stdout, application.process().stderr]) stream?.on("data", chunk => { logs = (logs + chunk).slice(-30000); });
    page = await application.firstWindow({ timeout: 30000 }); page.setDefaultTimeout(20000); page.on("pageerror", error => errors.push(error.message));
    await resize(1200, 820);
    await page.waitForFunction(() => document.getElementById("version")?.textContent?.startsWith("v"));
  }
  async function quit() {
    const process = application.process();
    const done = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error("Core did not quit")), 20000); process.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error("Core exited " + code)); }); });
    await application.evaluate(() => { setTimeout(() => global.__smokeTrayMenu.find(item => item.label === "Quit KAI Core").click(), 0); });
    await done; application = null;
  }
  async function install(file) {
    await application.evaluate((_electron, file) => { global.__appsOpenFile = file; }, file);
    await page.evaluate(() => window.kaiCore.call("plugins.install", {}));
    await page.evaluate(() => refresh());
  }
  try {
    await launch(true);
    await check("Apps section is absent without installed plugins", async () => {
      assert.equal(await page.locator("#apps-section").isVisible(), false);
      assert.equal((await page.evaluate(() => window.kaiCore.call("status"))).plugins.length, 0);
    });
    for (const fixture of fixtures) await install(fixture.file);
    await page.evaluate(() => window.kaiCore.call("plugins.change", { id: "smoke.disabled", action: "disable" })); await page.evaluate(() => refresh());
    await check("Every installed plugin has an icon, name and draggable handle", async () => {
      assert.equal(await page.locator("#apps-section").isVisible(), true); assert.deepEqual(await ids(), fixtures.map(item => item.id));
      assert.equal(await page.locator("#apps-list .app-nav-item svg").count(), 3);
      assert.equal(await page.locator('#apps-list .app-reorder-handle[draggable="true"]').count(), 3);
      for (const fixture of fixtures) assert.ok((await page.locator(`[data-app="${fixture.id}"]`).textContent()).includes(fixture.name));
    });
    await check("Disabled apps route to management without silently enabling", async () => {
      await page.locator('[data-app="smoke.disabled"]').click();
      assert.equal(await page.locator('[data-panel="plugins"]').isVisible(), true);
      assert.equal((await page.evaluate(() => window.kaiCore.call("status"))).plugins.find(item => item.id === "smoke.disabled").enabled, false);
      assert.equal((await state()).records.length, 0);
    });
    await check("Keyboard and pointer drag reorder apps and persist native preference", async () => {
      await page.locator('[data-reorder-app="smoke.tasks"]').focus(); await page.keyboard.press("Home");
      await until(async () => (await page.evaluate(() => window.kaiCore.call("status"))).pluginsOrder[0] === "smoke.tasks", "Keyboard reorder did not save");
      assert.deepEqual(await ids(), ["smoke.tasks", "smoke.notes", "smoke.disabled"]);
      const source = page.locator('[data-reorder-app="smoke.disabled"]'), destination = page.locator('[data-app-id="smoke.tasks"]');
      await source.dragTo(destination, { targetPosition: { x: 40, y: 3 } });
      await until(async () => (await page.evaluate(() => window.kaiCore.call("status"))).pluginsOrder[0] === "smoke.disabled", "Pointer reorder did not save");
      savedOrder = await ids(); assert.deepEqual(savedOrder, ["smoke.disabled", "smoke.tasks", "smoke.notes"]);
    });
    await check("App menu activates a sandboxed view inside the existing Core window", async () => {
      await page.locator('[data-app="smoke.notes"]').click();
      await until(async () => (await state()).records.some(item => item.id === "smoke.notes" && item.visible), "App view did not appear");
      const snapshot = await state(), record = snapshot.records[0];
      assert.equal(snapshot.windowCount, 1); assert.equal(record.ownerId, snapshot.mainId); assert.equal(record.embedded, true);
      assert.equal(await page.locator('[data-app="smoke.notes"]').getAttribute("aria-current"), "page");
      const isolation = await evaluateApp("smoke.notes", "({node:typeof require,process:typeof process,core:typeof window.kaiCore,plugin:typeof window.kai?.call})");
      assert.deepEqual(isolation, { node: "undefined", process: "undefined", core: "undefined", plugin: "function" });
      assert.equal(await evaluateApp("smoke.notes", "window.kai.call('wallet.reveal',{}).then(()=>false,()=>true)"), true);
      const panel = await page.locator("#app-content").boundingBox();
      assert.ok(Math.abs(record.bounds.x - panel.x) <= 1 && Math.abs(record.bounds.y - panel.y) <= 1 && record.bounds.width === Math.round(panel.width) && record.bounds.height === Math.round(panel.height), `App must fit content below Core header beside sidebar: ${JSON.stringify({ native: record.bounds, panel })}`);
    });
    await check("Switching pages and apps keeps draft, renderer and running request alive", async () => {
      const initial = (await state()).records.find(item => item.id === "smoke.notes");
      await evaluateApp("smoke.notes", 'document.getElementById("draft").value="Draft survives navigation";window.runSmoke();void 0');
      await until(async () => (await state()).inference.started === 1, "App request did not start");
      await page.locator('[data-page="chat"]').click();
      assert.equal((await state()).records.find(item => item.id === "smoke.notes").visible, false);
      await page.locator('[data-app="smoke.tasks"]').click();
      await until(async () => (await state()).records.some(item => item.id === "smoke.tasks" && item.visible), "Second app did not appear");
      await page.locator('[data-app="smoke.notes"]').click();
      await until(async () => (await state()).records.some(item => item.id === "smoke.notes" && item.visible), "First app did not reactivate");
      const current = (await state()).records.find(item => item.id === "smoke.notes");
      assert.equal(current.wcId, initial.wcId); assert.equal(current.aborted, false);
      assert.equal(await evaluateApp("smoke.notes", 'document.getElementById("draft").value'), "Draft survives navigation");
      assert.equal((await state()).inference.aborted, 0);
    });
    await check("Closing Core to tray keeps app timers and in-flight work alive", async () => {
      const ticks = await evaluateApp("smoke.notes", "window.smokeTicks"), before = await state();
      await application.evaluate(() => global.__smokeMainWindow.close());
      await until(async () => !(await state()).visible, "Core did not enter the tray");
      await until(async () => await evaluateApp("smoke.notes", "window.smokeTicks") >= ticks + 3, "Hidden app timer stopped");
      assert.equal((await state()).inference.aborted, 0);
      await application.evaluate(() => global.__appsComplete());
      await until(async () => await evaluateApp("smoke.notes", 'document.getElementById("work").textContent') === "Completed while KAI was in the tray", "Hidden request did not finish");
      assert.equal((await state()).lifecycle.coreStops, 0);
      await application.evaluate(() => global.__smokeTrayMenu.find(item => item.label === "Open KAI Core").click());
      await until(async () => (await state()).visible, "Tray Show did not restore Core");
      assert.equal((await state()).mainId, before.mainId);
    });
    await check("Disabling an app destroys its view and aborts its request", async () => {
      await evaluateApp("smoke.notes", "window.runSmoke();void 0");
      await until(async () => (await state()).inference.started === 2, "Second app request did not start");
      await application.evaluate(() => { global.__appsDisabledRecord = global.__appsHost.windows.get("smoke.notes"); });
      await page.evaluate(() => window.kaiCore.call("plugins.change", { id: "smoke.notes", action: "disable" })); await page.evaluate(() => refresh());
      await until(async () => (await state()).inference.aborted === 1, "Disable did not abort request");
      assert.equal((await state()).records.some(item => item.id === "smoke.notes"), false);
      await until(async () => application.evaluate(() => global.__appsDisabledRecord.webContents.isDestroyed()), "Disabled renderer survived");
      assert.equal(await application.evaluate(() => global.__appsDisabledRecord.controller.signal.aborted), true);
      assert.equal(await page.locator('[data-panel="plugins"]').isVisible(), true);
      assert.match(await page.locator('[data-app="smoke.notes"]').textContent(), /Disabled/);
    });
    await check("Re-enable creates a fresh sandbox without losing installed app order", async () => {
      await page.evaluate(() => window.kaiCore.call("plugins.change", { id: "smoke.notes", action: "enable" })); await page.evaluate(() => refresh());
      await page.locator('[data-app="smoke.notes"]').click();
      await until(async () => (await state()).records.some(item => item.id === "smoke.notes" && item.visible), "Re-enabled app did not open");
      assert.deepEqual(await ids(), savedOrder);
      assert.equal(await evaluateApp("smoke.notes", 'document.getElementById("draft").value'), "");
    });
    await check("Resize preserves the content boundary and sidebar remains usable", async () => {
      await resize(900, 700);
      await until(async () => { const panel = await page.locator("#app-content").boundingBox(), record = (await state()).records.find(item => item.id === "smoke.notes"); return record.bounds.width === Math.round(panel.width) && record.bounds.height === Math.round(panel.height); }, "App view did not resize");
      await page.locator('[data-page="wallet"]').click(); assert.equal(await page.locator('[data-panel="wallet"]').isVisible(), true);
      await resize(1200, 820);
    });
    await check("Quit from tray aborts remaining app work and tears down app views", async () => {
      await evaluateApp("smoke.notes", "window.runSmoke();void 0");
      await until(async () => (await state()).inference.started === 3, "Quit fixture request did not start");
      await quit();
      const stopped = JSON.parse(fs.readFileSync(path.join(root, "apps-quit.json"), "utf8"));
      assert.equal(stopped.inference.aborted, 2); assert.equal(stopped.openApps, 0);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, "lifecycle.json"), "utf8")).coreStopped, true);
    });
    await launch(false);
    await check("App order survives a full Core restart", async () => {
      assert.deepEqual(await ids(), savedOrder);
      assert.deepEqual((await page.evaluate(() => window.kaiCore.call("status"))).pluginsOrder, savedOrder);
      assert.equal((await state()).records.length, 0, "third-party app renderer should not run before the user opens it");
    });
    for (const fixture of overflowFixtures) await install(fixture.file);
    await check("Eleven app rows scroll without moving Settings or Network off screen", async () => {
      assert.equal(await page.locator("#apps-list .app-nav-item").count(), 11);
      assert.equal(await page.locator("#apps-list .app-nav-item svg").count(), 11);
      const before = await page.locator(".rail-icons").boundingBox();
      assert.ok(before && before.y + before.height <= await page.evaluate(() => innerHeight));
      const scrollable = await page.locator("#nav").evaluate(nav => nav.scrollHeight > nav.clientHeight);
      assert.equal(scrollable, true);
      await page.locator('[data-reorder-app="smoke.extra-8"]').scrollIntoViewIfNeeded();
      assert.ok(await page.locator("#nav").evaluate(nav => nav.scrollTop > 0));
      const after = await page.locator(".rail-icons").boundingBox(); assert.deepEqual(after, before);
      await page.locator('.rail-icons [data-page="settings"]').click();
      assert.equal(await page.locator('[data-panel="settings"]').isVisible(), true);
      await page.locator('.rail-icons [data-page="network"]').click();
      assert.equal(await page.locator('[data-panel="network"]').isVisible(), true);
      await page.locator("#nav").evaluate(nav => { nav.scrollTop = 0; });
    });
    const compare = path.resolve(process.env.KAI_PLUGIN_SOURCES || path.join(appRoot, ".."), "kai-plugin-model-compare/dist/kai-plugin-model-compare-0.2.0.kaiplugin");
    if (fs.existsSync(compare)) {
      await install(compare); await page.locator('[data-app="kai.model-compare"]').click();
      await until(async () => (await state()).records.some(item => item.id === "kai.model-compare" && item.visible), "Original Compare app did not appear");
      await until(async () => await evaluateApp("kai.model-compare", "document.body.innerText.includes('Compare')"), "Original Compare interface did not load");
      const screenshot = path.join(output, "apps-compare.png"); await page.screenshot({ path: screenshot, fullPage: false }); report.screenshots.push(screenshot);
      const pluginScreenshot = path.join(output, "compare-view.png");
      await application.evaluate((_electron, file) => global.__appsCapture(file, "kai.model-compare"), pluginScreenshot);
      report.screenshots.push(pluginScreenshot);
      report.checks.push("Original signed Compare app opens as an embedded sidebar page");
    }
    await check("Removing the final installed app hides the Apps section", async () => {
      const installed = (await page.evaluate(() => window.kaiCore.call("status"))).plugins;
      for (const row of installed) await page.evaluate(id => window.kaiCore.call("plugins.change", { id, action: "remove" }), row.id);
      await page.evaluate(() => refresh()); assert.equal(await page.locator("#apps-section").isVisible(), false);
      assert.deepEqual((await page.evaluate(() => window.kaiCore.call("status"))).pluginsOrder, []);
      assert.equal((await state()).records.length, 0);
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(await application.evaluate(() => global.__smokeExternalCalls), []);
    await quit();
    report.success = true;
    console.log(`PASS: ${report.checks.length} native app navigation/lifecycle checks; ${output}`);
  } catch (error) {
    report.error = error.stack || String(error); report.logs = logs; report.pageErrors = errors;
    if (application) { try { report.state = await state(); } catch {} }
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    if (application) await application.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
