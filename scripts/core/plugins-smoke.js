"use strict";

// Run with Electron, from any directory. This uses only a generated profile.
// Headless root containers need --no-sandbox --ozone-platform=headless CLI flags.
// KAI_PLUGIN_SOURCES can point at a directory containing kai-plugin-* repos.
// KAI_PLUGIN_CORE_ROOT can point at a built resources/app.asar to test packaging.
// KAI_PLUGIN_SMOKE_IDS is an optional comma-separated subset for development.
// --download verifies the published signed registry and fetches its exact releases
// into a temporary staging tree.
// Signing, publisher pins, renderer isolation and broker routing are unchanged.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const electron = require("electron");
const { app, protocol, ipcMain } = electron;
const coreRoot = path.resolve(process.env.KAI_PLUGIN_CORE_ROOT || path.join(__dirname, "../.."));
const packagedCore = path.basename(coreRoot) === "app.asar";
if (packagedCore) {
  assert.ok(fs.existsSync(coreRoot), "Packaged Core archive is missing");
  // The test harness is launched by Electron with an external script. Point
  // packaged runtime asset resolution at this build's actual extraResources.
  // Core modules and dependencies still load from the selected app.asar.
  Object.defineProperty(process, "resourcesPath", { value: path.dirname(coreRoot) });
}
const fromCore = relative => require(path.join(coreRoot, relative));
const { PluginManager } = fromCore("core/lib/plugins/manager");
const { downloadPackage } = fromCore("core/lib/plugins/download");
const { PluginHost } = fromCore("electron/core-plugin-host");
const { FeatureServices } = fromCore("electron/plugin-services");
const { ChatStore } = fromCore("core/lib/chats");
const publishers = fromCore("core/lib/plugins/first-party.json").plugins;
delete process.env.KAI_CORE_TOKEN; delete process.env.KAI_SESSION_SECRET;

// Resolve platform-owned aliases such as macOS /var before the profile
// reaches native storage guards; descendants remain subject to symlink checks.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-plugins-smoke-profile-")));
const profile = path.join(root, "profile"), dataDir = path.join(root, "data");
const output = process.env.KAI_PLUGIN_SMOKE_OUTPUT || path.join(os.tmpdir(), "kai-plugins-smoke");
const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-plugins-project-")));
const legacyNodeFile = path.join(dataDir, "koinos-node", "settings.json");
const legacyNodeSettings = JSON.stringify({ network: "harbinger", node: { dataDir: path.join(dataDir, "preserved-node-data") }, fixture: "preserve-me" });
for (const dir of [profile, dataDir, output]) fs.mkdirSync(dir, { recursive: true });
app.setName("KAI Synthetic Plugin Smoke");
app.setPath("userData", profile); app.setPath("sessionData", profile);
app.disableHardwareAcceleration();
// Synthetic cameras/microphones exercise Chromium's real permission flow.
// There is deliberately no use-fake-ui-for-media-stream consent bypass.
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
// Closing one plugin is part of the sequence, not the end of the fixture.
app.on("window-all-closed", () => {});
// Container-only synthetic fixture exception; production does not use this.
if (process.platform === "linux" && process.getuid?.() === 0) app.commandLine.appendSwitch("no-sandbox");
if (process.platform === "linux" && !process.env.DISPLAY) app.commandLine.appendSwitch("ozone-platform", "headless");
protocol.registerSchemesAsPrivileged([{ scheme: "kai-plugin", privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } }]);

// This is intentionally NOT OS encryption: the prefix identifies test data.
const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "synthetic-test-only",
  encryptString: text => Buffer.from("SYNTHETIC-TEST-ONLY:" + text),
  decryptString: bytes => { const text = bytes.toString(); assert.ok(text.startsWith("SYNTHETIC-TEST-ONLY:")); return text.slice(20); },
};
const nativeActions = [], blockedProcesses = [], externalCalls = [], openDialogResponses = [], messageBoxResponses = [];
const mediaPermissionChecks = [], mediaPermissionRequests = [];
const models = [{ alias: "synthetic-a", label: "Synthetic A", status: "ready" }, { alias: "synthetic-b", label: "Synthetic B", status: "ready" }];
const syntheticDisplay = process.platform === "linux" && !process.env.DISPLAY;
// Ozone's headless monitor is 1x1. Give native window placement a realistic
// synthetic work area while retaining actual BrowserWindows and their bounds.
const fixtureScreen = new (require("node:events").EventEmitter)();
const display = { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1600, height: 1000 }, workArea: { x: 0, y: 0, width: 1600, height: 1000 } };
Object.assign(fixtureScreen, { getCursorScreenPoint: () => ({ x: 800, y: 500 }), getDisplayNearestPoint: () => display,
  getDisplayMatching: () => display, getPrimaryDisplay: () => display, getAllDisplays: () => [display], screenToDipPoint: point => point, dipToScreenPoint: point => point });
// Original optional engines sometimes obtain Electron directly. This process
// owns only this synthetic profile, so their keychain calls use the same fixture.
Object.assign(electron.safeStorage, safeStorage);
for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  require("node:child_process")[method] = () => { blockedProcesses.push(method); throw Error("Synthetic smoke forbids child processes"); };
}
const fixtureElectron = {
  ...electron, safeStorage,
  ...(syntheticDisplay ? { screen: fixtureScreen } : {}),
  session: { fromPartition(...args) {
    const session = electron.session.fromPartition(...args);
    const setCheck = session.setPermissionCheckHandler.bind(session), setRequest = session.setPermissionRequestHandler.bind(session);
    session.setPermissionCheckHandler = handler => setCheck(handler ? (wc, permission, requestingOrigin, details) => {
      const allowed = handler(wc, permission, requestingOrigin, details);
      if (permission === "media") mediaPermissionChecks.push({ requestingOrigin, requestingUrl: details?.requestingUrl, isMainFrame: details?.isMainFrame, mediaType: details?.mediaType, allowed });
      return allowed;
    } : null);
    session.setPermissionRequestHandler = handler => setRequest(handler ? (wc, permission, callback, details) => {
      const record = { requestingOrigin: details?.requestingOrigin, requestingUrl: details?.requestingUrl, isMainFrame: details?.isMainFrame, mediaTypes: details?.mediaTypes };
      if (permission === "media") mediaPermissionRequests.push(record);
      return handler(wc, permission, allowed => { record.allowed = allowed; callback(allowed); }, details);
    } : null);
    return session;
  } },
  // Headless Linux lacks a desktop compositor. Offscreen still uses the same
  // Chromium renderer/preload/security settings and gives it a real surface.
  ...(process.platform === "linux" && !process.env.DISPLAY ? { BrowserWindow: class extends electron.BrowserWindow {
    constructor(options) { super({ ...options, webPreferences: { ...options.webPreferences, offscreen: true } }); this.webContents.on("paint", (_event, _dirty, shot) => { this.smokePaint = shot; }); }
  } } : {}),
  dialog: {
    showOpenDialog: async () => { const result = openDialogResponses.shift() || { canceled: true, filePaths: [] }; nativeActions.push(result.canceled ? "open-dialog-cancelled" : "synthetic-folder-selected"); return result; },
    showSaveDialog: async () => { nativeActions.push("save-dialog-cancelled"); return { canceled: true }; },
    showMessageBox: async (...args) => { const options = args.at(-1); const result = messageBoxResponses.shift() || { response: 0 }; nativeActions.push(`native-review:${options.title || options.message}:${result.response}`); return result; },
    showErrorBox: (title, message) => { nativeActions.push("error-dialog:" + title + ":" + message); },
  },
  shell: { openExternal: async () => { throw Error("Synthetic smoke forbids external applications"); } },
};
let host, features, core, finished = false, localCalls = 0, activeId = null, workflowExpression = false, registryVerified = false;
const errors = new Map(), reports = [];
const downloading = process.argv.includes("--download"), sourcePackages = process.env.KAI_PLUGIN_SMOKE_SOURCE === "1";
if (downloading && sourcePackages) throw Error("Source-package and published download smoke are separate modes");
const deadline = setTimeout(() => void finish(Error("Plugin smoke exceeded its deadline")), downloading ? 480000 : 300000);
async function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline);
  await host?.closeAll(); await features?.dispose(); ipcMain.removeHandler("kai-plugin:call");
  await core?.stop();
  const result = { coreRoot, packagedCore, resourcesPath: process.resourcesPath, coreVersion: fromCore("package.json").version, platform: process.platform, workflowExpression, registryVerified, syntheticProfile: true, syntheticDisplay, realEncryptionTested: false, captureMode: process.platform === "linux" && !process.env.DISPLAY ? "offscreen-chromium" : "desktop-chromium", sourcePackages, localCalls, nativeActions, blockedProcesses, externalCalls, mediaPermissionChecks, mediaPermissionRequests, plugins: reports, ...(error ? { error: error.stack || String(error) } : {}) };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(result, null, 2));
  if (error) console.error(error.stack || error);
  else console.log(`PASS: ${reports.length} signed plugins rendered and exercised; ${localCalls} loopback inference calls; screenshots/report in ${output}`);
  try { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
  app.exit(error ? 1 : 0);
}
process.on("uncaughtException", error => void finish(error));
process.on("unhandledRejection", error => void finish(error));
app.on("web-contents-created", (_event, wc) => {
  const id = activeId; if (!id) return;
  wc.on("console-message", (event, level, message) => {
    const detail = event.details || (typeof level === "object" ? level : null);
    const severity = detail?.level ?? level, text = detail?.message ?? message;
    if (severity === 3 || severity === "error") errors.get(id).push(String(text));
  });
  wc.on("preload-error", (_event, _file, error) => errors.get(id).push("Preload: " + error.message));
  wc.on("render-process-gone", (_event, details) => errors.get(id).push("Renderer exited: " + details.reason));
  wc.on("did-fail-load", (_event, code, description) => errors.get(id).push(`Load ${code}: ${description}`));
});

const js = (win, expression) => win.webContents.executeJavaScript(expression, true);
const call = (win, method, input = {}) => js(win, `window.kai.call(${JSON.stringify(method)},${JSON.stringify(input)})`);
async function until(win, expression, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await js(win, `Promise.resolve(${expression}).then(Boolean)`)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error(`${label}: ${await js(win, "document.body.innerText.slice(-2000)")}`);
}
const click = (win, selector) => js(win, `document.querySelector(${JSON.stringify(selector)}).click(); void 0`);
async function fill(win, values) {
  await js(win, `(() => { for (const [id,value] of Object.entries(${JSON.stringify(values)})) { const e=document.getElementById(id); if (!e) throw Error('Missing input '+id); e.value=value; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
}
const submit = (win, selector) => js(win, `document.querySelector(${JSON.stringify(selector)}).requestSubmit(); void 0`);
async function capture(win, file, { width = 1000, height = 760 } = {}) {
  await js(win, "window.scrollTo({top:0,left:0,behavior:'instant'}); void 0");
  win.setSize(width, height); win.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 250));
  const shot = win.smokePaint || await win.webContents.capturePage();
  const size = shot.getSize(); assert.ok(size.width > 500 && size.height > 500, "Screenshot is smaller than the desktop viewport");
  fs.writeFileSync(file, shot.toPNG());
}


// These checks run in the actual sandboxed plugin renderer. Restored features
// retain their original styles, including Node's slightly different palette.
async function presentation(win, id) {
  const styles = await js(win, `(() => {
    const style = getComputedStyle(document.body), root = getComputedStyle(document.documentElement);
    return { background: style.backgroundColor, text: style.color, scheme: root.colorScheme,
      originalStyle: [...document.styleSheets].some(sheet => sheet.href?.endsWith('/styles.css') || sheet.href?.endsWith('/node.css')),
      sharedNotice: typeof window.KaiPluginNotice?.attach === 'function' };
  })()`);
  assert.equal(styles.background, id === "kai.koinos-node" ? "rgb(245, 248, 253)" : "rgb(244, 247, 253)", id + " must use its original light workspace background");
  assert.equal(styles.text, id === "kai.koinos-node" ? "rgb(25, 52, 87)" : "rgb(20, 40, 78)", id + " must use its original text color");
  assert.equal(styles.scheme, "light", id + " must use light native controls");
  assert.equal(styles.originalStyle, true, id + " did not load the original workspace styles");
  const rails = {
    "kai.assistant": ["#chats-pane", ".chat-pane"], "kai.brain": [".hub-rail", ".hub-content"],
    "kai.connections": [".hub-rail", ".hub-content"], "kai.workflows": [".hub-rail", ".hub-content"], "kai.agent-network": [".hub-rail", ".hub-content"],
    "kai.documents": [".docs-side", ".docs-main"], "kai.code": [".kc-rail", ".kc-pane"], "kai.koinos-node": ["#sidebar", "#main"],
  };
  if (rails[id]) {
    const [rail, pane] = rails[id];
    await until(win, `!!document.querySelector(${JSON.stringify(rail)}) && !!document.querySelector(${JSON.stringify(pane)})`, id + " original workspace layout");
    styles.layout = await js(win, `(() => { const r=document.querySelector(${JSON.stringify(rail)}).getBoundingClientRect(),p=document.querySelector(${JSON.stringify(pane)}).getBoundingClientRect();return {railWidth:r.width,railRight:r.right,paneLeft:p.left,paneTop:p.top,paneWidth:p.width,height:innerHeight};})()`);
    const box = styles.layout;
    assert.ok(box.railWidth >= 90 && box.railWidth < 330 && box.paneLeft >= box.railRight - 1 && box.paneWidth > 400 && box.paneTop < box.height / 2, id + " original content pane is hidden or below the navigation: " + JSON.stringify(box));
  } else {
    await until(win, "[...document.querySelectorAll('h1')].some(node=>node.getClientRects().length)", id + " original heading");
    styles.layout = await js(win, "(() => { const node=[...document.querySelectorAll('h1')].find(node=>node.getClientRects().length),r=node.getBoundingClientRect();return {headingTop:r.top,headingWidth:r.width,height:innerHeight};})()");
    assert.ok(styles.layout.headingTop < styles.layout.height / 2 && styles.layout.headingWidth > 300, id + " original page heading is outside the workspace");
  }
  return styles;
}
async function dismissibleNotice(win, id) {
  const shared = await js(win, "typeof window.KaiPluginNotice?.attach==='function' && !!(document.getElementById('notice') || document.getElementById('message'))");
  if (!shared) return { mechanism: "Original feature-specific notices; covered by feature scenario where exercised", sharedNoticeTest: false };
  const before = { nativeActions: nativeActions.length, processes: blockedProcesses.length, inference: localCalls };
  const noticeId = await js(win, `(() => {
    const container = document.getElementById('notice') || document.getElementById('message');
    if (!container) throw Error('Missing shared notice container');
    const banner = window.KaiPluginNotice.attach(container);
    banner.show('Synthetic warning <img src=x onerror=attack()>', {error:true, force:true});
    return container.id;
  })()`);
  const target = `document.getElementById(${JSON.stringify(noticeId)})`;
  const bounds = await js(win, `(() => {
    const host = ${target}, button = host.querySelector('.kai-notice-close');
    button.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'});
    const r = button.getBoundingClientRect(), x = r.x + r.width/2, y = r.y + r.height/2;
    const hit = document.elementFromPoint(x,y);
    return { x, y, width:r.width, height:r.height, type:button.type, label:button.getAttribute('aria-label'),
      clickable:hit===button||button.contains(hit), images:host.querySelectorAll('img').length };
  })()`);
  assert.equal(bounds.type, "button"); assert.equal(bounds.label, "Dismiss message");
  assert.equal(bounds.images, 0, id + " notice content must be plain text");
  assert.ok(bounds.width >= 24 && bounds.height >= 24 && bounds.clickable, id + " notice close control is not reachable");
  win.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(bounds.x), y: Math.round(bounds.y), button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(bounds.x), y: Math.round(bounds.y), button: "left", clickCount: 1 });
  await until(win, `${target}.hidden`, id + " mouse notice dismissal");
  const stayedHidden = await js(win, `(() => {
    const host = ${target}, banner = window.KaiPluginNotice.attach(host);
    banner.show('Synthetic warning <img src=x onerror=attack()>', {error:true});
    return host.hidden;
  })()`);
  assert.equal(stayedHidden, true, id + " repeated background warning must stay dismissed");
  await js(win, `(() => {
    const host = ${target}; window.KaiPluginNotice.attach(host).show('Synthetic warning <img src=x onerror=attack()>', {error:true, force:true});
    const button = host.querySelector('.kai-notice-close'); button.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'}); button.focus();
  })()`);
  assert.equal(await js(win, `${target}.hidden`), false, id + " explicit retry must be able to show the same warning");
  assert.equal(await js(win, `document.activeElement===${target}.querySelector('.kai-notice-close')`), true);
  // Send the complete Enter sequence: raw key events alone omit Chromium's
  // character/keypress step and do not activate a native HTML button.
  win.focus(); win.webContents.focus();
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  await until(win, `${target}.hidden`, id + " keyboard notice dismissal");
  await js(win, `window.KaiPluginNotice.attach(${target}).clear(); void 0`);
  assert.deepEqual({ nativeActions: nativeActions.length, processes: blockedProcesses.length, inference: localCalls }, before,
    id + " notice dismissal must not invoke native actions, processes or inference");
  return { container: noticeId, mouse: true, keyboard: true, repeatSuppressed: true, explicitRetry: true };
}
async function compactLayout(win, id, file) {
  win.setSize(800, 700);
  await new Promise(resolve => setTimeout(resolve, 150));
  const result = await js(win, `(() => {
    const visible = node => node.getClientRects().length && node.checkVisibility({checkVisibilityCSS:true,contentVisibilityAuto:true}) && !node.closest('details:not([open])');
    let controls = [...document.querySelectorAll('button.primary, button[type=submit]')].filter(visible);
    if (!controls.length) controls = [...document.querySelectorAll('button')].filter(visible).slice(0,3);
    const checked = controls.map(button => {
      button.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'});
      const r = button.getBoundingClientRect(), x = r.x+r.width/2, y = r.y+r.height/2, hit = document.elementFromPoint(x,y);
      return {label:button.id || button.textContent.trim().slice(0,60), width:r.width, height:r.height,
        inViewport:r.left>=-1 && r.top>=-1 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1,
        receivesPointer:hit===button || button.contains(hit)};
    });
    return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,controls:checked};
  })()`);
  assert.ok(result.scrollWidth <= result.width + 1, `${id} has horizontal document overflow: ${JSON.stringify(result)}`);
  assert.ok(result.controls.length, id + " has no reachable action controls");
  for (const button of result.controls) assert.ok(button.width > 0 && button.height > 0 && button.inViewport && button.receivesPointer,
    `${id} compact control is clipped: ${JSON.stringify(button)}`);
  await capture(win, file, { width: 800, height: 700 });
  return result;
}

async function exercise(win, id) {
  const fixture = { root, dataDir, projectDir, models, nativeActions, blockedProcesses, externalCalls, openDialogResponses, messageBoxResponses, mediaPermissionChecks, mediaPermissionRequests, coreRoot, packagedCore, resourcesPath: process.resourcesPath, fromCore };
  const helpers = { js, call, click, fill, submit, until, capture, compactLayout, output, features, core, fixture };
  const groups = {
    "kai.workflows": ["./plugin-parity-workflows", "workflow"], "kai.agent-network": ["./plugin-parity-workflows", "agentNetwork"],
    "kai.brain": ["./plugin-parity-brain-connections", "brain"], "kai.connections": ["./plugin-parity-brain-connections", "connections"],
    "kai.code": ["./plugin-parity-code-documents", "code"], "kai.documents": ["./plugin-parity-code-documents", "documents"],
    "kai.koinos-node": ["./plugin-parity-node", "node"], "kai.assistant": ["./plugin-parity-assistant-remote", "assistant"], "kai.remote-access": ["./plugin-parity-assistant-remote", "remote"],
  };
  if (groups[id]) {
    const [file, method] = groups[id], result = await require(file)[method](win, helpers);
    if (id === "kai.remote-access") return result + "; " + await require("./plugin-parity-remote-features").remoteFeatures(win, helpers);
    return result;
  }
  if (id === "kai.model-compare") {
    await until(win, "document.getElementById('cmp-a')?.options.length>=2", "Original comparison model choices");
    await fill(win, { "cmp-a": "synthetic-a", "cmp-b": "synthetic-b", "cmp-input": "Compare this synthetic task." });
    await submit(win, "#cmp-form"); await until(win, "document.getElementById('cmp-body-0').innerText.includes('Synthetic local response') && document.getElementById('cmp-body-1').innerText.includes('Synthetic local response') && !document.getElementById('cmp-run').disabled", "Original streamed comparison");
    assert.equal(await js(win, "document.getElementById('cmp-label-0').innerText"), "Answer 1");
    await click(win, "#cmp-reveal"); await until(win, "document.getElementById('cmp-label-0').innerText.toLowerCase().includes('synthetic')", "Reveal original blind model comparison");
    await click(win, '.cmp-vote-btn[data-pick="tie"]'); await until(win, "document.getElementById('cmp-tally').innerText.includes('1')", "Original comparison voting tally");
    const tally = await call(win, "storage.get", { key: "legacy-compare-tally" }); assert.ok(tally);
    return "Original paired streaming comparison, model reveal and persisted preference tally";
  }
  if (id === "kai.tools") {
    await until(win, "document.getElementById('mcp-catalog')?.options.length>1", "Original Tools catalog");
    for (const name of ["mcp-list", "mcp-catalog", "mcp-add-catalog", "mcp-add-custom", "mcp-name", "mcp-url", "mcp-cmd", "email-panel", "calendar-panel"]) assert.equal(await js(win, `!!document.getElementById(${JSON.stringify(name)})`), true, name);
    // Record the original renderer's post-cancellation alert without leaving a
    // modal dialog open in a headless fixture. The native consent still denies.
    await js(win, "window.__smokeAlerts=[];window.alert=text=>{window.__smokeAlerts.push(String(text));};void 0");
    await fill(win, { "mcp-name": "Synthetic MCP", "mcp-url": "https://example.invalid/mcp" });
    await click(win, "#mcp-add-custom"); await until(win, "document.getElementById('mcp-list').innerText.includes('Synthetic MCP')", "Original MCP configuration save");
    assert.ok(await js(win, "window.__smokeAlerts.some(text=>text.includes('Action cancelled'))"), "Original Tools cancellation message missing");
    assert.equal(blockedProcesses.length, 0); assert.equal(externalCalls.length, 0);
    const developer = await require("./plugin-parity-tools-developer").toolsDeveloper(win, helpers);
    return "Original MCP catalog/custom server editor, email and calendar panels; synthetic server saved without launching a process; " + developer;
  }
  throw Error("Missing full-parity smoke scenario for " + id);
}

app.whenReady().then(async () => {
  // Instantiate the bundled WASM runtime, not merely its JavaScript wrapper.
  // This also catches a missing dependency accidentally resolved from a nearby
  // source checkout when a packaged app is tested in the repository's dist/.
  assert.ok(require.resolve("quickjs-emscripten", { paths: [coreRoot] }).startsWith(coreRoot + path.sep), "QuickJS must resolve inside the selected Core root");
  assert.equal(await fromCore("electron/workflow-values").evaluate("input.value + 1", { input: { value: 41 }, item: {}, items: [], nodes: {}, iteration: 0 }), 42);
  workflowExpression = true;
  const realFetch = global.fetch;
  global.fetch = (url, options) => {
    const wanted = `http://127.0.0.1:${core?.gateway?.port}/core/chat/completions`;
    if (String(url) === wanted) return realFetch(url, options);
    externalCalls.push(String(url)); throw Error("Smoke attempted non-fixture network: " + url);
  };
  fromCore("core/lib/hardware").detect = async () => ({ platform: process.platform, arch: process.arch, cpu: { model: "Synthetic CPU", cores: 4 }, ramBytes: 16 * 1024 ** 3, gpus: [], disk: { freeBytes: 100 * 1024 ** 3, totalBytes: 200 * 1024 ** 3 }, capabilities: { cpuFallback: true, cudaEligible: false, vulkanEligible: false, metalEligible: false } });
  fromCore("core/lib/git").available = async () => ({ ok: false, error: "Git unavailable in synthetic fixture" });
  fromCore("core/lib/github").GitHub.prototype.status_ = async () => ({ repo: false });
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ network: { privacyMode: "local-only" }, earn: { autoStart: false }, remote: { enabled: true, token: "b".repeat(64) }, apiKeys: { key_aabbccddeeff: { name: "Earlier synthetic gateway key", digest: "a".repeat(64) } } }));
  fs.writeFileSync(path.join(dataDir, "tasks.json"), JSON.stringify({ tasks: [{ id: "synthetic-legacy-task", name: "Earlier scheduled task", prompt: "Preserve this scheduled prompt.", model: "synthetic-a", schedule: { kind: "hourly" }, enabled: false, nextRunAt: new Date(Date.now() + 3600000).toISOString(), lastRunAt: null, lastChatId: "synthetic-legacy-chat", lastError: null }] }));
  fs.mkdirSync(path.dirname(legacyNodeFile), { recursive: true }); fs.writeFileSync(legacyNodeFile, legacyNodeSettings);
  fs.writeFileSync(path.join(projectDir, "README.md"), "Synthetic project preserved by plugin smoke.\n");
  const chats = new ChatStore(path.join(dataDir, "chats"));
  chats.save({ id: "synthetic-legacy-chat", title: "Earlier synthetic chat", messages: [{ role: "user", content: "A preserved synthetic conversation." }] });
  fs.mkdirSync(path.join(dataDir, "docs"));
  fs.writeFileSync(path.join(dataDir, "docs", "synthetic-legacy-doc.json"), JSON.stringify({ id: "synthetic-legacy-doc", title: "Earlier synthetic document", content: "A preserved synthetic document.", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  // Use the production Core shell. A legacy ../ui fallback can accidentally
  // serve companion files that a restored feature forgot to mount itself.
  core = await fromCore("core/server").createCore({ dataDir, extensions: false, uiDirectory: path.join(coreRoot, "ui-core"), port: 0, sessionSecret: "synthetic-plugin-smoke-profile-secret", onEvent() {} });
  await core.start();
  core.gateway.nodeRuntime = new (fromCore("core/lib/node-runtime").NodeRuntime)({ provisioner: null, runtimesDir: path.join(dataDir, "runtimes"), probeSystemNode: () => null });
  core.models.aliases = () => models;
  core.gateway._chat = async function(req, res) {
    const body = JSON.parse((await this._readBody(req)).toString("utf8"));
    assert.ok(models.some(model => model.alias === body.model), "Only a synthetic model may run"); localCalls++;
    const text = `Synthetic local response from ${body.model}.`;
    if (!body.stream) return this._json(res, 200, { id: "synthetic-chat", object: "chat.completion", model: body.model, choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write("data: " + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] }) + "\n\n");
    res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }) + "\n\n");
    res.end("data: [DONE]\n\n");
  };
  const nodeHelper = require("./plugin-parity-node"), nodeModule = fromCore("electron/plugin-services/koinos-node"), createNode = nodeModule.create;
  nodeModule.create = ctx => createNode(ctx, { full: { createEngine: () => nodeHelper.createEngine({ dataDir: ctx.dataDir }) } });
  const manager = new PluginManager(dataDir);
  const confirm = async title => { nativeActions.push("confirmation-cancelled: " + title); return false; };
  features = new FeatureServices({ dataDir, core, electron: fixtureElectron,
    confirm, getWindow: () => host?.windows.get(activeId)?.window, getPluginWindow: id => host?.windows.get(id)?.window,
    loadInstalledPlugin: id => manager.list().some(plugin => plugin.id === id && plugin.enabled) ? manager.load(id) : null,
    readCoreWalletSummary: async () => ({ exists: false, address: null, network: "mainnet", balances: null }),
    getCoreWindow: () => null, openPlugin: id => host.open(id),
    openCoreView: async view => { nativeActions.push("core-view:" + view); return { opened: true }; },
    desktopCall: fromCore("electron/core-plugin-desktop").createPluginDesktop({ electron: fixtureElectron, getCoreWindow: () => null, openPlugin: id => host.open(id), confirm, isClosing: () => finished }),
    localInference: (input, signal) => host.runLocal(input, signal),
    fetchImpl: async url => { externalCalls.push(String(url)); throw Error("Smoke forbids online connection requests"); },
    withWalletSpend: async fn => fn(),
    runPayment: async action => {
      if (action === "chat-info") return { configured: false, enabled: false, models: [], blocked: "Synthetic Local-Only profile" };
      if (action === "credit-status") return { product: "prepaid-usd-v1", credits: { unit: "USD-1e-8", available: "0", free: { available: "0", state: "unavailable" }, purchased: { available: "0" } }, purchases: [], usage: [] };
      throw Error("Synthetic plugin smoke forbids payments");
    },
  });
  features.getCompanionStore().note({ title: "Earlier synthetic memory", text: "A preserved synthetic memory.", category: "notes" });
  host = new PluginHost({ electron: fixtureElectron, manager, core, features });
  const sourceRoot = downloading ? path.join(root, "downloaded") : path.resolve(process.env.KAI_PLUGIN_SOURCES || path.join(__dirname, "../../.."));
  const subset = process.env.KAI_PLUGIN_SMOKE_IDS?.split(",");
  let selected = publishers.filter(p => !subset || subset.includes(p.id)); assert.ok(selected.length);
  if (sourcePackages) {
    const pair = crypto.generateKeyPairSync("ed25519"), der = pair.publicKey.export({ format: "der", type: "spki" }), publicKey = der.toString("base64"), fingerprint = crypto.createHash("sha256").update(der).digest("hex");
    const { canonical, BINARY } = fromCore("core/lib/plugins/package");
    for (const publisher of selected) {
      const repo = publisher.repository.split("/").pop(), directory = path.join(sourceRoot, repo, "plugin"), manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")), files = {};
      const read = (folder, prefix = "") => { for (const item of fs.readdirSync(folder, { withFileTypes: true })) { const name = prefix + item.name; if (item.isDirectory()) read(path.join(folder, item.name), name + "/"); else if (name !== "manifest.json") files[name] = fs.readFileSync(path.join(folder, item.name)).toString(BINARY.test(name) ? "base64" : "utf8"); } };
      read(directory); Object.assign(publisher, { fingerprint, publicKey, version: manifest.version });
      const pkg = { manifest, files, publicKey, signature: crypto.sign(null, Buffer.from(canonical({ manifest, files })), pair.privateKey).toString("base64") };
      manager.install(pkg); assert.equal(manager.load(publisher.id).fingerprint, fingerprint);
    }
  }
  let registryEntries, verifyRegistryPackage;
  if (downloading) {
    const registry = fromCore("core/lib/plugins/registry");
    console.log("Downloading signed plugin registry");
    const envelope = await registry.downloadRegistry();
    registryEntries = envelope.catalog.plugins;
    verifyRegistryPackage = registry.verifyRegistryPackage;
    selected = selected.map(publisher => {
      const entry = registryEntries.find(row => row.id === publisher.id);
      assert.ok(entry, "Official plugin missing from signed registry: " + publisher.id);
      assert.equal(entry.fingerprint, publisher.fingerprint);
      assert.equal(entry.publicKey, publisher.publicKey);
      assert.ok(registry.compareVersions(fromCore("package.json").version, entry.minCoreVersion) >= 0, "Published registry plugin requires a newer Core: " + publisher.id);
      return entry;
    });
    registryVerified = true;
  }
  for (const publisher of sourcePackages ? [] : selected) {
    const repo = publisher.repository.split("/").pop(), file = path.join(sourceRoot, repo, "dist", `${repo}-${publisher.version}.kaiplugin`);
    if (downloading) {
      console.log("Downloading " + publisher.id + " " + publisher.version);
      const verified = await downloadPackage(publisher.url);
      assert.equal(verified.manifest.id, publisher.id); assert.equal(verified.manifest.version, publisher.version);
      assert.equal(verified.fingerprint, publisher.fingerprint);
      verifyRegistryPackage(registryEntries.find(entry => entry.id === publisher.id), verified);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(verified.package));
    }
    assert.ok(fs.existsSync(file), `Missing signed package: ${file}`);
    manager.install(JSON.parse(fs.readFileSync(file, "utf8")));
    assert.equal(manager.load(publisher.id).fingerprint, publisher.fingerprint);
    assert.equal(manager.load(publisher.id).manifest.version, publisher.version);
  }
  await features.startInstalledBackground(manager);
  assert.deepEqual([...features.backgroundErrors], [], "An installed feature failed background startup before its window opened");
  for (const id of ["kai.workflows", "kai.agent-network"]) if (selected.some(plugin => plugin.id === id)) {
    assert.ok(features.services.has(id), id + " did not activate its background service at startup");
  }
  for (const publisher of selected) {
    const id = publisher.id; activeId = id; errors.set(id, []); console.log("Opening " + id);
    await host.open(id); const win = host.windows.get(id).window;
    await until(win, "document.readyState==='complete' && document.body.innerText.trim().length>100", id + " blank renderer");
    let transitions, failure, theme, notice, compact;
    const initialScreenshot = path.join(output, id + ".initial.png");
    const compactScreenshot = path.join(output, id + ".compact.png");
    await capture(win, initialScreenshot);
    try {
      theme = await presentation(win, id); transitions = await exercise(win, id);
      assert.deepEqual(blockedProcesses, [], id + " attempted to launch a process");
      assert.deepEqual(externalCalls, [], id + " attempted non-fixture external network");
    } catch (error) { failure = error; }
    const page = await js(win, `({title:document.title,headings:[...document.querySelectorAll('h1,h2')].filter(e=>e.getClientRects().length).map(e=>e.innerText),bodyLength:document.body.innerText.trim().length,statuses:[...document.querySelectorAll('[role=status],[role=alert]')].filter(e=>e.getClientRects().length).map(e=>e.innerText),nodeAbsent:typeof require==='undefined'&&typeof process==='undefined'})`);
    const screenshot = path.join(output, id + ".png"); await capture(win, screenshot);
    if (!failure) {
      try { notice = await dismissibleNotice(win, id); compact = await compactLayout(win, id, compactScreenshot); }
      catch (error) { failure = error; await capture(win, path.join(output, id + ".failure.png"), { width: 800, height: 700 }); }
    }
    const rendererErrors = errors.get(id); reports.push({ id, version: publisher.version, fingerprint: manager.load(id).fingerprint, ...page, transitions, theme, notice, compact, rendererErrors, initialScreenshot, screenshot, compactScreenshot, ...(failure ? { failure: failure.message } : {}) });
    assert.equal(page.nodeAbsent, true); assert.ok(page.bodyLength > 100, "Empty original feature: " + id);
    assert.deepEqual(rendererErrors, [], "Renderer errors: " + id);
    if (failure) throw failure;
    const service = features.services.get(id);
    win.destroy();
    if (service?.keepAliveOnWindowClose) {
      assert.equal(features.services.get(id), service, id + " background feature ended with its window");
      if (id === "kai.workflows") assert.ok((await service.call("workflows.status")).runs.some(run => run.status === "completed"));
      if (id === "kai.agent-network") assert.equal((await service.call("agentNetwork.legacyStatus")).enabled, true);
      reports.at(-1).backgroundAliveAfterWindowClose = true;
    }
    console.log(`PASS ${id}: ${transitions}`); activeId = null;
    await features.close(id);
  }
  assert.deepEqual(blockedProcesses, [], "A plugin attempted to launch a process");
  assert.deepEqual(externalCalls, [], "A plugin attempted non-fixture external network");
  assert.equal(fs.readFileSync(legacyNodeFile, "utf8"), legacyNodeSettings, "Original node settings changed");
  assert.equal(fs.readFileSync(path.join(projectDir, "README.md"), "utf8"), "Synthetic project preserved by plugin smoke.\n");
  assert.equal(chats.get("synthetic-legacy-chat").messages[0].content, "A preserved synthetic conversation.", "Earlier conversation changed");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "docs", "synthetic-legacy-doc.json"), "utf8")).content, "A preserved synthetic document.", "Earlier document changed");
  assert.ok(features.getCompanionStore().data.notes.some(note => note.title === "Earlier synthetic memory" && note.text === "A preserved synthetic memory."), "Earlier Brain memory changed");
  await finish();
}).catch(error => void finish(error));
