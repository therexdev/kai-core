"use strict";
// Real Core and trusted dialog windows. This isolated fixture never sends tokens,
// opens a real wallet, connects accounts or operates a user node.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const appRoot = path.resolve(process.env.KAI_SMOKE_SOURCE_ROOT || path.join(__dirname, "../.."));
async function main() {
  const runtimeRoot = path.resolve(process.env.KAI_SMOKE_RUNTIME_ROOT || appRoot), { _electron } = require("playwright-core");
  const output = path.resolve(process.env.KAI_DIALOG_SMOKE_OUTPUT || path.join(os.tmpdir(), "kai-dialogs-smoke")); fs.mkdirSync(output, { recursive: true });
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-dialogs-"))), profile = path.join(temp, "profile"), exitReport = path.join(temp, "exit.json");
  const report = { realCore: true, realDialogs: true, syntheticProfile: true, syntheticKeychain: true, liveActions: false, runtimeRoot, checks: [], screenshots: [] };
  require(path.join(appRoot, "electron/foundation-profile")).prepareFoundationProfile(profile);
  fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ network: { privacyMode: "local-only" }, earn: { autoStart: false } }));
  const { signingPayload } = require(path.join(appRoot, "core/lib/plugins/package")), keys = crypto.generateKeyPairSync("ed25519");
  const manifest = { schema: 2, apiVersion: 3, id: "example.dialogs", name: "Dialog Test Plugin", version: "1.0.0", runtime: "native", entry: "index.html", service: "service.js", permissions: ["native.execute", "desktop.windows"], provides: [], consumes: [] };
  const files = { "index.html": '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'"><title>Dialog test</title></head><body><h1>Dialog test fixture</h1></body></html>',
    "service.js": 'exports.create=api=>({call(method){if(method==="review")return api.desktop.confirm("Review Node action","Synthetic review only. No node operation will run.");if(method==="native"){const e=require("electron");return e.dialog.showMessageBox(e.BrowserWindow.fromId(api.desktop.hostWindowId()),{type:"warning",title:"Private key review",message:"Keep this private key offline.",detail:"SYNTHETIC TEST VALUE — not a key",buttons:["Close","Copy private key"],cancelId:0,defaultId:0});}throw Error("Unknown fixture method");},dispose(){}});' };
  const pkg = { manifest, files, publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"), signature: crypto.sign(null, Buffer.from(signingPayload(manifest, files)), keys.privateKey).toString("base64") };
  new (require(path.join(appRoot, "core/lib/plugins/manager")).PluginManager)(profile).install(pkg, { trustNative: true });
  fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ name: "kai-dialog-smoke", version: "1.0.0", main: "desktop.js" }));
  fs.writeFileSync(path.join(temp, "desktop.js"), `require(${JSON.stringify(path.join(__dirname, "apps-fixture.js"))}).install(${JSON.stringify({ appRoot: runtimeRoot, appData: path.join(temp, "app-data"), reportFile: exitReport, syntheticKeychain: true, realDialogs: true })});\nrequire(${JSON.stringify(path.join(runtimeRoot, "electron/core-main.js"))});\n`);
  const args = []; if (process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox"); if (process.platform === "linux" && !process.env.DISPLAY) args.push("--ozone-platform=headless"); args.push(temp);
  const env = { ...process.env, KAI_CORE_DATA: profile, KAI_CORE_PORT: "0", KAI_CHANNEL: "core" }; delete env.ELECTRON_RUN_AS_NODE; delete env.KAI_SESSION_SECRET; delete env.KAI_CORE_TOKEN;
  let app, page, logs = ""; const pageErrors = [];
  const until = async (condition, message) => { const end = Date.now() + 30000; do { const value = await condition(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < end); throw Error(message); };
  const evaluate = async (fn, value) => { for (let n = 0; ; n++) { try { return await app.evaluate(fn, value); } catch (error) { if (n === 3 || !String(error.message).includes("Resulting promise was garbage collected")) throw error; await new Promise(resolve => setTimeout(resolve, 250)); } } };
  const pluginEval = expression => evaluate((_e, expression) => global.__foundationHost.renderer("example.dialogs").executeJavaScript(expression, true), expression);
  const dialog = async () => { const found = await until(() => app.windows().find(w => !w.isClosed() && /\/dialog\.html$/.test(w.url())), "Styled dialog did not open"); await found.locator("#dialog-loading").waitFor({ state: "hidden" }); return found; };
  const capture = async (dialog, name) => { await evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(row => /\/dialog\.html$/.test(row.webContents.getURL())); window?.setContentSize(620, 540); return true; }); const file = path.join(output, name + ".png"); await dialog.screenshot({ path: file }); report.screenshots.push(file); };
  const pluginCall = (name, expression) => pluginEval(`if(window.testCase!==${JSON.stringify(name)}){window.testCase=${JSON.stringify(name)};window.testDone=false;window.testValue=null;Promise.resolve(${expression}).then(value=>{window.testValue=value??null;window.testDone=true;},error=>{window.testError=String(error);window.testDone=true;});}true`);
  const pluginResult = async () => { await until(() => pluginEval("window.testDone===true"), "Plugin dialog did not resolve"); const value = await pluginEval("({value:window.testValue,error:window.testError||null})"); assert.equal(value.error, null); return value.value; };
  try {
    app = await _electron.launch({ executablePath: require("electron"), args, env, timeout: 60000 });
    for (const stream of [app.process().stdout, app.process().stderr]) stream?.on("data", chunk => { logs = (logs + chunk).slice(-40000); });
    page = await app.firstWindow(); page.on("pageerror", error => pageErrors.push(error.message)); page.setDefaultTimeout(30000);
    await evaluate(() => { global.__foundationWindow.setContentSize(1280, 900); return true; });
    await page.waitForFunction(() => document.getElementById("version")?.textContent.startsWith("v"));
    await page.evaluate(() => { window.coreDialogDone = false; window.kaiCore.dialogs.confirm("Send 0.10000000 KOIN?", { title: "Review token transfer", detail: "Synthetic review only. No tokens will be sent.", confirmLabel: "Send KOIN" }).then(value => { window.coreDialogValue = value; window.coreDialogDone = true; }); });
    let popup = await dialog(); await capture(popup, "core-send-review");
    assert.match(await popup.locator("body").innerText(), /Send 0\.10000000 KOIN/);
    const font = await popup.evaluate(() => getComputedStyle(document.body).fontFamily); assert.match(font, /Inter|Segoe UI/);
    await popup.locator("#dialog-close").click(); await page.waitForFunction(() => window.coreDialogDone); assert.equal(await page.evaluate(() => window.coreDialogValue), false);
    report.checks.push("Core token-review styling and X cancellation use the real trusted dialog");
    await page.locator('[data-app="example.dialogs"]').click();
    await until(() => evaluate(() => global.__foundationHost.windows.get("example.dialogs")?.ready), "Fixture plugin did not load");
    await pluginCall("confirm-approve", 'window.kai.dialogs.confirm("Allow this synthetic action?",{confirmLabel:"Allow once"})'); popup = await dialog(); await popup.getByRole("button", { name: "Allow once", exact: true }).click(); assert.equal(await pluginResult(), true);
    await pluginCall("confirm-escape", 'window.kai.dialogs.confirm("Cancel the next synthetic action?")'); popup = await dialog(); await popup.keyboard.press("Escape").catch(error => { if (!String(error.message).includes("has been closed")) throw error; }); assert.equal(await pluginResult(), false);
    report.checks.push("Plugin renderer confirmations require an explicit click and Escape never reuses earlier approval");
    await pluginCall("sdk-review", 'window.kai.call("review",{})'); popup = await dialog(); assert.match(await popup.locator("body").innerText(), /Dialog Test Plugin/); await capture(popup, "plugin-action-review"); await popup.locator("#dialog-close").click(); assert.equal(await pluginResult(), false);
    await pluginCall("native-review", 'window.kai.call("native",{})'); popup = await dialog(); assert.match(await popup.locator("body").innerText(), /SYNTHETIC TEST VALUE/); await capture(popup, "plugin-private-key-warning"); await popup.locator("#dialog-close").click(); assert.equal((await pluginResult()).response, 0);
    report.checks.push("Native SDK reviews and direct Electron plugin warnings share the same styled trusted surface");
    const literal = '<img src="https://invalid.example/pixel" onerror="window.injected=true">';
    await pluginCall("literal-alert", `window.kai.dialogs.alert(${JSON.stringify(literal)}, {detail:${JSON.stringify("Long readable detail\n".repeat(250))}})`); popup = await dialog();
    assert.match(await popup.locator("body").innerText(), /<img src=/); assert.equal(await popup.locator('img[src^="https:"]').count(), 0); await capture(popup, "long-alert"); await popup.locator("#dialog-close").click(); await pluginResult();
    report.checks.push("Alerts render literal text safely and long details scroll without losing close controls");
    await pluginCall("hidden-review", 'window.kai.dialogs.confirm("This review must cancel when its app is hidden.")'); await dialog(); await evaluate(() => { global.__foundationHost.hide(); return true; }); assert.equal(await pluginResult(), false);
    report.checks.push("Leaving the originating plugin cancels its pending review");
    await evaluate(() => { global.__foundationWindow.show(); return true; });
    await page.evaluate(() => { window.coreDialogDone = false; window.kaiCore.dialogs.confirm("This review must cancel when Core goes to the tray.").then(value => { window.coreDialogValue = value; window.coreDialogDone = true; }); });
    await dialog(); await evaluate(() => { global.__foundationWindow.hide(); return true; }); await page.waitForFunction(() => window.coreDialogDone); assert.equal(await page.evaluate(() => window.coreDialogValue), false);
    report.checks.push("Closing Core to its tray cancels pending approvals");
    assert.deepEqual(pageErrors, []); assert.deepEqual((await evaluate(() => global.__foundationSmoke)).errors, []);
    const child = app.process(), ended = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error("Core quit timed out")), 30000); child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error("Core exit " + code)); }); });
    await evaluate(() => { setTimeout(() => global.__foundationTrayMenu.find(row => row.label === "Quit KAI Core").click(), 0); return true; }); await ended; app = null;
    report.status = "passed";
  } catch (error) { report.status = "failed"; report.error = error.stack; throw error; }
  finally { if (app) await app.close().catch(() => {}); report.logs = logs; report.pageErrors = pageErrors; fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2)); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); console.log("Report", path.join(output, "report.json")); }
}
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
