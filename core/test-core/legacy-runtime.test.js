"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLegacyRuntime, normalizedRequest } = require("../../electron/plugin-services/legacy-runtime");
const { guardedJSON, guardCredentials, createLegacyCoreServices } = require("../../electron/plugin-services/legacy-core-services");
const { CompanionStore } = require("../../electron/companion-store");
const tick = () => new Promise(resolve => setImmediate(resolve));
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-legacy-parity-")); t.after(() => fs.rmSync(dir, { force: true, recursive: true })); return dir; }
function fixture(t, route) {
  const dataDir = temporary(t), features = [], safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text", encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() };
  const store = new CompanionStore({ dataDir, safeStorage: { ...safeStorage, getSelectedStorageBackend: () => "gnome_libsecret" } });
  const ctx = { dataDir, getCompanionStore: () => store, electron: { safeStorage, shell: { openExternal: () => {} }, dialog: { showMessageBox: async () => ({ response: 1 }) } },
    getWindow: () => ({ isDestroyed: () => false, isVisible: () => true }), confirm: async () => true,
    core: { account: null, models: { aliases: () => [{ alias: "local", status: "ready" }] }, ensureLegacyFeature: name => features.push(name),
      gateway: { port: 41100, network: { status: () => ({ privacyMode: "local-first" }) }, chats: { list: () => [] }, _route: route || (async (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); }) } } };
  const runtime = createLegacyRuntime(ctx); t.after(() => runtime.dispose()); return { runtime, ctx, features, store };
}
test("original feature bridge rejects other feature namespaces, alternate hosts and normalized traversal", () => {
  for (const input of [
    { path: "https://example.com/core/models" }, { path: "//example.com/core/models" }, { path: "/core/code/../keys" }, { path: "/core/code/%2e%2e/keys" }, { path: "/core/models#ignored" }, { path: "/core/models\n" }, { path: "/core/keys" }, { path: "/core/models", method: "POST" },
  ]) assert.throws(() => normalizedRequest("documents", input));
  assert.equal(normalizedRequest("tools", { path: "/core/email/message?uid=123" }).url.searchParams.get("uid"), "123");
  assert.throws(() => normalizedRequest("documents", { path: "/core/chat/completions", method: "POST", bodyBase64: "not base64" }));
  const hidden = Buffer.from('{"trusted":true}').toString("base64");
  assert.throws(() => normalizedRequest("tools", { path: "/core/mcp/selected/flags", method: "POST", body: {}, bodyBase64: hidden }), /reviewable JSON/);
  assert.throws(() => normalizedRequest("assistant", { path: "/core/tools/call", method: "POST", bodyBase64: hidden }), /reviewable JSON/);
  assert.throws(() => normalizedRequest("assistant", { path: "/core/dev", method: "POST", body: { enabled: true } }), /cannot call/);
  assert.throws(() => normalizedRequest("assistant", { path: "/core/agents/defs", method: "POST", body: {} }), /cannot call/);
  assert.equal(normalizedRequest("assistant", { path: "/core/transcribe", method: "POST", bodyBase64: "UklGRg==" }).body.toString(), "RIFF");
  assert.throws(() => normalizedRequest("assistant", { path: "/core/transcribe", method: "POST", body: {}, bodyBase64: "UklGRg==" }), /reviewable JSON/);
});
test("bridge supplies only native same-origin credentials and preserves original JSON responses", async t => {
  let request;
  const { runtime, features } = fixture(t, async (req, res) => { request = req; const chunks = []; for await (const chunk of req) chunks.push(chunk); res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ saved: JSON.parse(Buffer.concat(chunks).toString()), legacy: true })); });
  assert.deepEqual(features, []);
  const response = await runtime.request("documents", { path: "/core/chat/completions", method: "POST", headers: { host: "attacker.invalid", authorization: "not-used" }, body: { model: "local", messages: [] } });
  assert.equal(response.status, 201); assert.equal(response.body.legacy, true); assert.equal(response.body.saved.model, "local");
  assert.equal(request.headers.host, "127.0.0.1:41100"); assert.notEqual(request.headers.authorization, "not-used"); assert.deepEqual(features, ["documents"]);
});
test("SSE delivery is scoped, lossless across UTF-8 boundaries and canceled through original response close", async t => {
  let res, stop;
  const { runtime } = fixture(t, async (_req, response) => { res = response; res.writeHead(200, { "content-type": "text/event-stream" }); await new Promise(resolve => { stop = resolve; response.once("close", resolve); }); });
  const stream = await runtime.request("model-compare", { path: "/core/chat/completions", method: "POST", body: { stream: true } });
  assert.throws(() => runtime.poll("assistant", stream.streamId), /Unknown/);
  const text = Buffer.from('data: {"text":"🟢"}\n\n'), split = text.indexOf(Buffer.from("🟢")) + 2;
  res.write(text.subarray(0, split)); const one = runtime.poll("model-compare", stream.streamId);
  res.end(text.subarray(split)); await tick(); const two = runtime.poll("model-compare", stream.streamId);
  assert.equal(one.chunks.join("") + two.chunks.join(""), text.toString()); assert.equal(two.done, true); stop();
  const second = await runtime.request("model-compare", { path: "/core/chat/completions", method: "POST", body: { stream: true } });
  assert.equal(runtime.cancel("model-compare", second.streamId).stopped, true); assert.equal(res.destroyed, true);
  assert.throws(() => runtime.poll("model-compare", second.streamId), /Unknown/);
});
test("closing a feature cancels its active stream without canceling another plugin", async t => {
  const responses = [];
  const { runtime } = fixture(t, async (_req, res) => { responses.push(res); res.writeHead(200, { "content-type": "text/event-stream" }); await new Promise(resolve => res.once("close", resolve)); });
  const a = await runtime.request("documents", { path: "/core/chat/completions", method: "POST" });
  const b = await runtime.request("model-compare", { path: "/core/chat/completions", method: "POST" });
  await runtime.release("documents"); assert.equal(responses[0].destroyed, true); assert.equal(responses[1].destroyed, false);
  assert.throws(() => runtime.poll("documents", a.streamId), /Unknown/); assert.equal(runtime.poll("model-compare", b.streamId).done, false);
});
test("Developer Tools and Assistant can control only their own original group runs", async t => {
  const stopped = [], responses = [];
  const { runtime, ctx } = fixture(t, async (req, res) => {
    if (req.url === "/core/agents/run") {
      responses.push(res); res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"trace":{"type":"start","runId":"owned"}}\n\n');
      res.write('data: {"trace":{"type":"input-request","runId":"owned","inputId":"prompt"}}\n\n');
      await new Promise(resolve => res.once("close", resolve)); return;
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}');
  });
  ctx.core.gateway.agents = { runner: { stop: id => stopped.push(id) } };
  const stream = await runtime.request("tools", { path: "/core/agents/run", method: "POST", body: {} });
  await assert.rejects(runtime.request("assistant", { path: "/core/agents/stop", method: "POST", body: { runId: "owned" } }), /does not own/);
  await assert.rejects(runtime.request("assistant", { path: "/core/agents/input", method: "POST", body: { inputId: "prompt", text: "wrong owner" } }), /does not own/);
  assert.equal((await runtime.request("tools", { path: "/core/agents/input", method: "POST", body: { inputId: "prompt", text: "owner" } })).ok, true);
  await runtime.release("assistant"); assert.deepEqual(stopped, []);
  runtime.cancel("tools", stream.streamId); assert.deepEqual(stopped, ["owned"]);
  await assert.rejects(runtime.request("tools", { path: "/core/agents/stop", method: "POST", body: { runId: "owned" } }), /does not own/);
});
test("native feature activation shares original CompanionHub/store but never creates the rental identity", async t => {
  const { runtime, store, ctx } = fixture(t);
  const brain = runtime.getHub("brain"), workflows = runtime.getHub("workflows"), connections = runtime.getHub("connections");
  assert.equal(brain, workflows); assert.equal(brain, connections); assert.equal(brain.store, store); assert.equal(brain.agentNetwork, null);
  assert.equal(fs.existsSync(path.join(ctx.dataDir, "agent-network.json")), false);
  const note = await runtime.manage("brain", "note", { title: "Restored", text: "Exact legacy note" });
  assert.equal(brain.status().notes.find(item => item.id === note.id).text, "Exact legacy note");
  await assert.rejects(runtime.manage("workflows", "note", { text: "No cross-scope writes" }), /cannot manage/);
});
test("native always-allow action grants follow original review and shutdown rejects a late approval", async t => {
  const { runtime, ctx, store } = fixture(t); const hub = runtime.getHub("connections"); let reviews = 0, approve;
  hub.connections.prepare = () => ({ name: "Create task", method: "POST", operationId: "create" }); hub.connections.execute = async () => "created";
  store.data.connections = [{ id: "account", name: "Selected account", revision: 1 }];
  ctx.electron.dialog.showMessageBox = async () => { reviews++; return { response: 2 }; };
  assert.equal(await runtime.manage("connections", "request", { connectionId: "account", operationId: "create" }), "created");
  assert.equal(await runtime.manage("connections", "request", { connectionId: "account", operationId: "create" }), "created"); assert.equal(reviews, 1);
  store.data.settings.approvalGrants = [];
  ctx.electron.dialog.showMessageBox = () => new Promise(resolve => { approve = resolve; });
  const pending = runtime.manage("connections", "request", { connectionId: "account", operationId: "create" }); await tick();
  const rejected = assert.rejects(pending, /closing/); await runtime.dispose(); await rejected; approve({ response: 1 });
});
test("guarded legacy JSON refuses corrupt records and concurrent writes without replacing bytes", t => {
  const dir = temporary(t), file = path.join(dir, "code-projects.json"); fs.writeFileSync(file, "broken");
  assert.throws(() => guardedJSON(file, Array.isArray), /unreadable/); assert.equal(fs.readFileSync(file, "utf8"), "broken");
  fs.writeFileSync(file, "[]"); const guard = guardedJSON(file, Array.isArray); fs.writeFileSync(file, '[{"external":true}]');
  assert.throws(() => guard.write([]), /changed outside/); assert.equal(fs.readFileSync(file, "utf8"), '[{"external":true}]');
});
test("original account formats remain usable while locked/corrupt credentials cannot be replaced", t => {
  const dataDir = temporary(t), file = path.join(dataDir, "email.cfg"), { EmailService } = require("../lib/email");
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "gnome_libsecret", encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() };
  fs.writeFileSync(file, "ENC1broken"); let service = guardCredentials(new EmailService({ dataDir, safeStorage }));
  assert.throws(() => service.saveConfig({ email: "test@example.com", imapHost: "example.com", pass: "synthetic" }), /original OS keychain/); assert.equal(fs.readFileSync(file, "utf8"), "ENC1broken");
  fs.writeFileSync(file, 'PLN1{"email":"existing@example.com","imapHost":"example.com","pass":"synthetic"}'); service = guardCredentials(new EmailService({ dataDir, safeStorage }));
  assert.equal(service.status().email, "existing@example.com"); service.saveConfig({ email: "updated@example.com", imapHost: "example.com", pass: "synthetic-new" });
  assert.equal(service.status().email, "updated@example.com"); assert.equal(fs.readFileSync(file).subarray(0, 4).toString(), "ENC1");
  assert.ok(fs.readdirSync(dataDir).some(name => name.startsWith("email.cfg.plugin-backup-")));
});
test("lazy original engine construction has no side effects until a scoped feature is activated", async t => {
  const dataDir = temporary(t), gateway = {}, core = { gateway, settings: { get: (_key, fallback) => fallback } };
  const services = createLegacyCoreServices({ core, dataDir }); assert.deepEqual(Object.keys(gateway), []);
  services.ensure("documents"); assert.deepEqual(Object.keys(gateway), []);
  assert.throws(() => services.ensure("arbitrary"), /Unknown/); await services.dispose(); assert.throws(() => services.ensure("documents"), /closing/);
});
test("legacy scheduled prompts migrate through the original protocol without another scheduler", async t => {
  const { legacyTaskMigration } = require("../../electron/plugin-services/legacy-core-services");
  const dataDir = temporary(t), file = path.join(dataDir, "tasks.json"), original = { metadata: { retained: true }, tasks: [{ id: "old", name: "Original schedule", prompt: "Summarize", model: "local", enabled: true, schedule: { kind: "daily", hour: 9 } }] };
  fs.writeFileSync(file, JSON.stringify(original)); const migration = legacyTaskMigration(dataDir);
  assert.equal(migration.start, undefined); assert.equal(migration.list()[0].running, false);
  assert.equal(migration.migrateToWorkflow("old", "workflow"), true);
  const saved = JSON.parse(fs.readFileSync(file)); assert.deepEqual(saved.metadata, original.metadata); assert.equal(saved.tasks[0].enabled, false); assert.equal(saved.tasks[0].migratedWorkflowId, "workflow");
  const backup = fs.readdirSync(dataDir).find(name => name.startsWith("tasks.json.plugin-backup-")); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, backup))), original);
  fs.writeFileSync(file, '{"tasks":[]}'); assert.throws(() => migration.list(), /changed outside/); assert.throws(() => migration.migrateToWorkflow("old", "different"), /changed outside/);
  fs.writeFileSync(file, "corrupt"); assert.throws(() => legacyTaskMigration(dataDir), /unreadable/); assert.equal(fs.readFileSync(file, "utf8"), "corrupt");
});
test("lazy MCP startup respects Local-Only and switching privacy disconnects external transports", async t => {
  const dataDir = temporary(t), servers = [
    { id: "remote", transport: "http", url: "https://example.test/mcp", autoConnect: true },
    { id: "unsafe", transport: "stdio", command: "must-not-start", autoConnect: true },
  ];
  let privacyMode = "local-only", calls = 0;
  const gateway = { tools: new (require("../lib/tools").ToolRegistry)({ privacyMode: () => privacyMode }), network: { status: () => ({ privacyMode }) } };
  const core = { gateway, settings: { get: (key, fallback) => key === "mcp.servers" ? servers : fallback, set() {} } };
  const services = createLegacyCoreServices({ core, dataDir }); t.after(() => services.dispose()); services.ensure("tools");
  class Connection { constructor(config) { this.config = config; this.tools = []; } async connect() { calls++; return []; } close() { this.closed = true; } }
  gateway.mcp.Connection = Connection;
  await gateway.mcp.autoConnect(); assert.equal(calls, 0);
  await assert.rejects(gateway.mcp.connect("remote"), /Local-Only/);
  privacyMode = "local-first"; await gateway.mcp.connect("remote"); assert.equal(calls, 1);
  const connection = gateway.mcp._conns.get("remote"); privacyMode = "local-only";
  await gateway.mcp.closeUnavailable(); assert.equal(connection.closed, true); assert.equal(gateway.mcp._conns.size, 0);
});
test("real Core gateway supports original Code projects/sessions through lazy scoped activation", async t => {
  const dataDir = temporary(t), projectDir = path.join(dataDir, "synthetic-project"); fs.mkdirSync(projectDir);
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ network: { privacyMode: "local-only" } }));
  const core = await require("../server").createCore({ dataDir, extensions: false, onEvent() {} }); t.after(() => core.stop());
  assert.equal(core.gateway.code, null); assert.equal(core.gateway.mcp, null);
  const runtime = createLegacyRuntime({ dataDir, core, confirm: async () => true }); t.after(() => runtime.dispose());
  const models = await runtime.request("code", { path: "/core/models", method: "GET" }); assert.equal(models.ok, true); assert.ok(models.body.aliases.length);
  assert.equal(core.gateway.mcp, null); assert.equal(core.gateway.koinosNode, null); assert.equal(core.gateway.voice, null);
  const projects = await runtime.request("code", { path: "/core/code/projects", method: "POST", body: { dir: projectDir, name: "Legacy project" } });
  assert.equal(projects.ok, true); assert.equal(projects.body.project.name, "Legacy project");
  const id = projects.body.project.id;
  const session = await runtime.request("code", { path: `/core/code/projects/${id}/sessions`, method: "POST", body: { title: "Original session" } });
  assert.equal(session.ok, true); assert.equal(session.body.session.title, "Original session");
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "code-projects.json"), "utf8")); assert.equal(stored[0].sessions[0].title, "Original session");
  const tools = await runtime.request("code", { path: "/core/code/tools", method: "GET" }); assert.equal(tools.ok, true); assert.ok(Array.isArray(tools.body.tools));
  let privateRequest;
  t.mock.method(global, "fetch", async (_url, options) => { privateRequest = JSON.parse(options.body); return { ok: true, json: async () => ({ choices: [{ message: { content: "Local code answer" } }] }) }; });
  assert.equal(await core.gateway.code.chatFn({ model: "local", messages: [{ role: "user", content: "Synthetic private source" }] }), "Local code answer");
  assert.equal(privateRequest.kai_private_desktop, true, "Code source must never overflow to a network model");
  fs.writeFileSync(path.join(dataDir, "code-projects.json"), "[]");
  assert.throws(() => core.gateway.code.projects.get(id), /changed outside/);
});
test("disabled Assistant routes are removed and reactivation restores fresh voice engines and Code switch", async t => {
  const dataDir = temporary(t), core = await require("../server").createCore({ dataDir, extensions: false, onEvent() {} }); t.after(() => core.stop());
  const runtime = createLegacyRuntime({ dataDir, core }); t.after(() => runtime.dispose());
  runtime.ensure("assistant"); const previous = { voice: core.gateway.voice, speech: core.gateway.speech, turn: core.gateway.turn };
  await runtime.release("assistant"); assert.equal(core.gateway.voice, null); assert.equal(core.gateway.speech, null); assert.equal(core.gateway.turn, null);
  runtime.ensure("assistant"); for (const key of Object.keys(previous)) { assert.ok(core.gateway[key]); assert.notEqual(core.gateway[key], previous[key]); assert.notEqual(core.gateway[key].closed, true); }
  runtime.ensure("code"); core.gateway.code.switch.configure({ enabled: false }); assert.equal(core.gateway.code.switch.status().enabled, false);
  await runtime.release("code"); runtime.ensure("code"); assert.equal(core.gateway.code.switch.status().enabled, true);
});
