"use strict";

// Run with Electron, from any directory. This uses only a generated profile.
// Headless root containers need --no-sandbox --ozone-platform=headless CLI flags.
// KAI_PLUGIN_SOURCES can point at a directory containing kai-plugin-* repos.
// KAI_PLUGIN_CORE_ROOT can point at a built resources/app.asar to test packaging.
// KAI_PLUGIN_SMOKE_IDS is an optional comma-separated subset for development.
// --download fetches the exact catalog releases into a temporary staging tree.
// Signing, publisher pins, renderer isolation and broker routing are unchanged.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const electron = require("electron");
const { app, protocol, ipcMain } = electron;
const coreRoot = path.resolve(process.env.KAI_PLUGIN_CORE_ROOT || path.join(__dirname, "../.."));
const fromCore = relative => require(path.join(coreRoot, relative));
const { PluginManager } = fromCore("core/lib/plugins/manager");
const { downloadPackage } = fromCore("core/lib/plugins/download");
const { PluginHost } = fromCore("electron/core-plugin-host");
const { FeatureServices } = fromCore("electron/plugin-services");
const { ChatStore } = fromCore("core/lib/chats");
const publishers = fromCore("core/lib/plugins/first-party.json").plugins;
delete process.env.KAI_CORE_TOKEN; delete process.env.KAI_SESSION_SECRET;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-plugins-smoke-profile-"));
const profile = path.join(root, "profile"), dataDir = path.join(root, "data");
const output = path.join(os.tmpdir(), "kai-plugins-smoke");
for (const dir of [profile, dataDir, output]) fs.mkdirSync(dir, { recursive: true });
app.setName("KAI Synthetic Nine Plugin Smoke");
app.setPath("userData", profile); app.setPath("sessionData", profile);
app.disableHardwareAcceleration();
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
const nativeActions = [], blockedProcesses = [];
for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  require("node:child_process")[method] = () => { blockedProcesses.push(method); throw Error("Synthetic smoke forbids child processes"); };
}
const fixtureElectron = {
  ...electron, safeStorage,
  // Headless Linux lacks a desktop compositor. Offscreen still uses the same
  // Chromium renderer/preload/security settings and gives it a real surface.
  ...(process.platform === "linux" && !process.env.DISPLAY ? { BrowserWindow: class extends electron.BrowserWindow {
    constructor(options) { super({ ...options, webPreferences: { ...options.webPreferences, offscreen: true } }); this.webContents.on("paint", (_event, _dirty, shot) => { this.smokePaint = shot; }); }
  } } : {}),
  dialog: {
    showOpenDialog: async () => { nativeActions.push("open-dialog-cancelled"); return { canceled: true, filePaths: [] }; },
    showSaveDialog: async () => { nativeActions.push("save-dialog-cancelled"); return { canceled: true }; },
  },
  shell: { openExternal: async () => { throw Error("Synthetic smoke forbids external applications"); } },
};
let host, features, server, finished = false, localCalls = 0, activeId = null, workflowExpression = false;
const errors = new Map(), reports = [];
const downloading = process.argv.includes("--download");
const deadline = setTimeout(() => void finish(Error("Nine-plugin smoke exceeded its deadline")), downloading ? 360000 : 120000);
async function finish(error) {
  if (finished) return; finished = true; clearTimeout(deadline);
  host?.closeAll(); await features?.dispose(); ipcMain.removeHandler("kai-plugin:call");
  server?.closeAllConnections(); server?.close();
  const result = { coreRoot, workflowExpression, syntheticProfile: true, realEncryptionTested: false, captureMode: process.platform === "linux" && !process.env.DISPLAY ? "offscreen-chromium" : "desktop-chromium", localCalls, nativeActions, blockedProcesses, plugins: reports, ...(error ? { error: error.stack || String(error) } : {}) };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(result, null, 2));
  if (error) console.error(error.stack || error);
  else console.log(`PASS: ${reports.length} signed plugins rendered and exercised; ${localCalls} loopback inference calls; screenshots/report in ${output}`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
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
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (await js(win, expression)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error(`${label}: ${await js(win, "document.body.innerText.slice(-2000)")}`);
}
const click = (win, selector) => js(win, `document.querySelector(${JSON.stringify(selector)}).click(); void 0`);
async function fill(win, values) {
  await js(win, `(() => { for (const [id,value] of Object.entries(${JSON.stringify(values)})) { const e=document.getElementById(id); if (!e) throw Error('Missing input '+id); e.value=value; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
}
const submit = (win, selector) => js(win, `document.querySelector(${JSON.stringify(selector)}).requestSubmit(); void 0`);
async function capture(win, file) {
  await js(win, "window.scrollTo({top:0,left:0,behavior:'instant'}); void 0");
  win.setSize(1000, 760); win.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 250));
  const shot = win.smokePaint || await win.webContents.capturePage();
  const size = shot.getSize(); assert.ok(size.width > 500 && size.height > 500, "Screenshot is smaller than the desktop viewport");
  fs.writeFileSync(file, shot.toPNG());
}

async function exercise(win, id) {
  switch (id) {
    case "kai.assistant": {
      await until(win, "!document.getElementById('send').disabled", "Assistant model loading");
      assert.match(await js(win, "document.getElementById('history').innerText"), /Earlier synthetic chat/);
      await fill(win, { prompt: "Synthetic smoke request" }); await submit(win, "#composer");
      await until(win, "document.getElementById('messages').innerText.includes('Synthetic local response') && !document.getElementById('send').disabled", "Assistant response");
      assert.equal((await call(win, "assistant.list")).chats.length, 2);
      return "Loaded legacy chat; sent local prompt; saved reply";
    }
    case "kai.brain": {
      await until(win, "document.getElementById('list').innerText.includes('Earlier synthetic memory')", "Brain legacy data");
      await click(win, "#create"); await fill(win, { "note-title": "Smoke memory", "note-text": "Synthetic private memory." }); await submit(win, "#note-form");
      await until(win, "document.getElementById('list').innerText.includes('Smoke memory')", "Brain save");
      await click(win, "[data-tab='goals']"); await click(win, "#create"); await fill(win, { "goal-title": "Smoke goal", "goal-detail": "A test goal." }); await submit(win, "#goal-form");
      await until(win, "document.getElementById('list').innerText.includes('Smoke goal')", "Brain goal");
      await click(win, "[data-tab='sources']"); assert.equal((await call(win, "brain.sourceImport")).cancelled, true);
      await click(win, "[data-tab='memories']");
      return "Loaded legacy memory; saved memory and goal; source picker canceled";
    }
    case "kai.documents": {
      await until(win, "document.getElementById('list').innerText.includes('Earlier synthetic document')", "Documents legacy data");
      await fill(win, { title: "Smoke document", content: "Synthetic draft." }); await submit(win, "#document-form");
      await until(win, "document.getElementById('list').innerText.includes('Smoke document')", "Documents save");
      await js(win, "document.getElementById('assistant').open=true"); await fill(win, { prompt: "Improve this synthetic draft." }); await click(win, "#draft");
      await until(win, "!document.getElementById('proposal').hidden && document.getElementById('draft-text').innerText.includes('Synthetic local response')", "Documents draft");
      assert.equal((await call(win, "documents.import")).cancelled, true);
      return "Loaded legacy document; saved draft; generated reviewable local proposal";
    }
    case "kai.model-compare": {
      await until(win, "!document.getElementById('compare').disabled", "Compare model loading");
      await fill(win, { prompt: "Compare this synthetic task." }); await submit(win, "#comparison-form");
      await until(win, "document.getElementById('text-b').innerText.includes('Synthetic local response') && document.getElementById('history-count').innerText.includes('1')", "Compare responses");
      return "Compared two local models; saved paired responses";
    }
    case "kai.workflows": {
      await until(win, "document.getElementById('flow-list').innerText.includes('No workflows yet')", "Workflow initialization");
      await click(win, "[data-tab='agents']"); await click(win, "#new-agent"); await fill(win, { "agent-name": "Smoke editor", "agent-instructions": "Review this input clearly." }); await click(win, "#save-agent");
      await until(win, "document.getElementById('agent-list').innerText.includes('Smoke editor')", "Workflow agent save");
      await click(win, "[data-tab='workflows']"); await click(win, "#new-flow"); await fill(win, { "flow-name": "Smoke workflow" }); await click(win, "#save-flow");
      await until(win, "document.getElementById('flow-list').innerText.includes('Smoke workflow')", "Workflow save");
      const saved = (await call(win, "workflows.list")).workflows.find(w => w.name === "Smoke workflow");
      const run = await call(win, "workflows.run", { id: saved.id, input: "Synthetic workflow input" });
      await until(win, `window.kai.call('workflows.runGet',{id:${JSON.stringify(run.id)}}).then(r=>r.status==='completed'||r.status==='failed')`, "Workflow run");
      const result = await call(win, "workflows.runGet", { id: run.id }); assert.equal(result.status, "completed", JSON.stringify(result));
      await click(win, "[data-tab='runs']");
      return "Saved reusable agent and workflow; ran local graph to completion";
    }
    case "kai.agent-network": {
      await until(win, "!document.getElementById('session').innerText.includes('Loading')", "Network session");
      assert.equal((await call(win, "agentNetwork.status")).sessionActive, false);
      await click(win, "#load-workflows"); await click(win, "[data-tab='settings']");
      const rejected = await js(win, "window.kai.call('agentNetwork.settings',{enabled:true,endpoints:[]}).then(()=>false,e=>/Cancelled/.test(e.message))"); assert.equal(rejected, true);
      assert.equal((await call(win, "agentNetwork.status")).sessionActive, false);
      await click(win, "[data-tab='services']");
      return "Read isolated service state and workflow choices; session approval canceled";
    }
    case "kai.connections": {
      await until(win, "document.getElementById('privacy').innerText.toLowerCase().includes('local')", "Connections initialization");
      assert.equal((await call(win, "connections.status")).connections.length, 0);
      await click(win, "[data-tab='api']");
      assert.equal((await call(win, "connections.save", { name: "Synthetic API", baseUrl: "https://example.invalid", auth: "none", operations: [] })).cancelled, true);
      await click(win, "[data-tab='accounts']");
      return "Loaded provider metadata/templates; API save approval canceled";
    }
    case "kai.tools": {
      await until(win, "document.getElementById('privacy').innerText.toLowerCase().includes('local')", "Tools initialization");
      assert.equal((await call(win, "tools.status")).servers.length, 0);
      await click(win, "[data-tab='add']");
      assert.equal((await call(win, "tools.add", { name: "Synthetic MCP", transport: "http", url: "https://example.invalid/mcp" })).cancelled, true);
      await click(win, "[data-tab='servers']");
      return "Loaded MCP catalog; server save approval canceled; no process launched";
    }
    case "kai.code": {
      const projects = await call(win, "code.projects"); assert.deepEqual(projects.projects, []);
      assert.equal((await call(win, "code.choose")).cancelled, true);
      return "Loaded project workspace; native project picker canceled";
    }
    default: throw Error("Missing smoke scenario for " + id);
  }
}

app.whenReady().then(async () => {
  // Instantiate the bundled WASM runtime, not merely its JavaScript wrapper.
  // This also catches a missing dependency accidentally resolved from a nearby
  // source checkout when a packaged app is tested in the repository's dist/.
  assert.ok(require.resolve("quickjs-emscripten", { paths: [coreRoot] }).startsWith(coreRoot + path.sep), "QuickJS must resolve inside the selected Core root");
  assert.equal(await fromCore("electron/workflow-values").evaluate("input.value + 1", { input: { value: 41 }, item: {}, items: [], nodes: {}, iteration: 0 }), 42);
  workflowExpression = true;
  server = http.createServer((req, res) => {
    assert.equal(req.url, "/core/chat/completions"); assert.equal(req.method, "POST");
    let text = ""; req.on("data", chunk => { text += chunk; }); req.on("end", () => {
      const input = JSON.parse(text); assert.equal(input.kai_private_desktop, true); assert.equal(input.stream, false);
      assert.ok(["synthetic-a", "synthetic-b"].includes(input.model)); localCalls++;
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: `Synthetic local response from ${input.model}.` } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const realFetch = global.fetch, inferenceURL = `http://127.0.0.1:${server.address().port}/core/chat/completions`;
  global.fetch = (url, options) => { assert.equal(String(url), inferenceURL, "Smoke attempted non-fixture network"); return realFetch(url, options); };
  const settings = new Map();
  const chats = new ChatStore(path.join(dataDir, "chats"));
  chats.save({ id: "synthetic-legacy-chat", title: "Earlier synthetic chat", messages: [{ role: "user", content: "A preserved synthetic conversation." }] });
  fs.mkdirSync(path.join(dataDir, "docs"));
  fs.writeFileSync(path.join(dataDir, "docs", "synthetic-legacy-doc.json"), JSON.stringify({ id: "synthetic-legacy-doc", title: "Earlier synthetic document", content: "A preserved synthetic document.", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  const core = {
    models: { aliases: () => [{ alias: "synthetic-a", label: "Synthetic A", status: "ready" }, { alias: "synthetic-b", label: "Synthetic B", status: "ready" }] },
    gateway: { port: server.address().port, chats, network: { status: () => ({ privacyMode: "local-only" }) } },
    settings: { get: (key, fallback) => settings.get(key) ?? fallback, set: (key, value) => settings.set(key, value) },
    runtime: { provisioner: null }, account: { _token: () => null, origin: () => null },
  };
  features = new FeatureServices({ dataDir, core, electron: fixtureElectron,
    confirm: async title => { nativeActions.push("confirmation-cancelled: " + title); return false; },
    localInference: (input, signal) => host.runLocal(input, signal),
    fetchImpl: async () => { throw Error("Smoke forbids online connection requests"); },
  });
  features.getCompanionStore().note({ title: "Earlier synthetic memory", text: "A preserved synthetic memory.", category: "notes" });
  const manager = new PluginManager(dataDir);
  host = new PluginHost({ electron: fixtureElectron, manager, core, features });
  const sourceRoot = downloading ? path.join(root, "downloaded") : path.resolve(process.env.KAI_PLUGIN_SOURCES || path.join(__dirname, "../../.."));
  const subset = process.env.KAI_PLUGIN_SMOKE_IDS?.split(",");
  const selected = publishers.filter(p => !subset || subset.includes(p.id)); assert.ok(selected.length);
  for (const publisher of selected) {
    const repo = publisher.repository.split("/").pop(), file = path.join(sourceRoot, repo, "dist", `${repo}-${publisher.version}.kaiplugin`);
    if (downloading) {
      console.log("Downloading " + publisher.id + " " + publisher.version);
      const verified = await downloadPackage(publisher.url);
      assert.equal(verified.manifest.id, publisher.id); assert.equal(verified.manifest.version, publisher.version);
      assert.equal(verified.fingerprint, publisher.fingerprint);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(verified.package));
    }
    assert.ok(fs.existsSync(file), `Missing signed package: ${file}`);
    manager.install(JSON.parse(fs.readFileSync(file, "utf8")));
    assert.equal(manager.load(publisher.id).fingerprint, publisher.fingerprint);
    assert.equal(manager.load(publisher.id).manifest.version, publisher.version);
  }
  for (const publisher of selected) {
    const id = publisher.id; activeId = id; errors.set(id, []); console.log("Opening " + id);
    await host.open(id); const win = host.windows.get(id).window;
    await until(win, "document.readyState==='complete' && document.body.innerText.trim().length>100", id + " blank renderer");
    let transitions, failure;
    try { transitions = await exercise(win, id); } catch (error) { failure = error; }
    const page = await js(win, `({title:document.title,headings:[...document.querySelectorAll('h1,h2')].filter(e=>e.getClientRects().length).map(e=>e.innerText),bodyLength:document.body.innerText.trim().length,statuses:[...document.querySelectorAll('[role=status],[role=alert]')].filter(e=>e.getClientRects().length).map(e=>e.innerText),nodeAbsent:typeof require==='undefined'&&typeof process==='undefined'})`);
    const screenshot = path.join(output, id + ".png"); await capture(win, screenshot);
    const rendererErrors = errors.get(id); reports.push({ id, ...page, transitions, rendererErrors, screenshot, ...(failure ? { failure: failure.message } : {}) });
    assert.equal(page.nodeAbsent, true); assert.ok(page.headings.length, "No visible headings: " + id);
    assert.deepEqual(rendererErrors, [], "Renderer errors: " + id);
    if (failure) throw failure;
    console.log(`PASS ${id}: ${transitions}`); host.close(id); activeId = null;
    await features.close(id);
  }
  assert.deepEqual(blockedProcesses, [], "A plugin attempted to launch a process");
  await finish();
}).catch(error => void finish(error));
