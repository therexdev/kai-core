"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createCore } = require("../server");
const { WalletService } = require("../lib/wallet");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-core-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function put(dir, file, value) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), typeof value === "string" ? value : JSON.stringify(value));
}
async function open(t, dir) {
  const originalFetch = global.fetch, external = [];
  t.mock.method(global, "fetch", (url, options) => {
    if (new URL(String(url)).hostname !== "127.0.0.1") { external.push(String(url)); throw Error("Test forbids external requests"); }
    return originalFetch(url, options);
  });
  const core = await createCore({ dataDir: dir, extensions: false, port: 0, onEvent() {}, uiDirectory: path.join(__dirname, "../../ui-core") });
  t.after(() => core.stop());
  const base = `http://127.0.0.1:${await core.start()}`;
  return { core, base, external };
}

test("lean core starts with only core services, without optional routes or background jobs", async t => {
  const dir = fixture(t);
  const settings = { network: { privacyMode: "local-only" }, remote: { enabled: true }, earn: { autoStart: true }, dev: { tools: true }, code: { enabled: true }, mcp: { servers: [{ name: "must-not-run", command: "does-not-exist" }] } };
  put(dir, "settings.json", settings);
  const original = fs.readFileSync(path.join(dir, "settings.json"));
  const { core, base, external } = await open(t, dir);
  for (const name of ["memory", "mcp", "nodeRuntime", "email", "calendar", "koinos", "koinosNode", "teams", "dev", "bench", "agents", "code", "voice", "speech", "turn", "docs"]) assert.equal(core.gateway[name], null, name);
  assert.equal(core.tasks, undefined); assert.equal(core.remote, undefined);
  assert.deepEqual(core.gateway.tools.list(), []);
  for (const [route, method] of [["/core/koinos", "GET"], ["/core/remote", "POST"], ["/core/mcp/runtime", "POST"], ["/core/dev", "POST"]]) {
    const response = await fetch(base + route, { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
    assert.equal(response.status, 404, route);
  }
  const health = await (await fetch(base + "/core/health")).json();
  assert.equal(health.ok, true); assert.equal(health.modules.gateway.port, core.gateway.port);
  const ui = await fetch(base + "/"); assert.equal(ui.status, 200); assert.match(await ui.text(), /KAI Core/);
  const earning = await (await fetch(base + "/core/earn/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  assert.equal(earning.ok, false); assert.match(earning.error, /Share AI capacity/);
  assert.deepEqual(fs.readFileSync(path.join(dir, "settings.json")), original);
  assert.deepEqual(external, []);
  assert.equal(fs.existsSync(path.join(dir, "koinos-node")), false);
  assert.equal(fs.existsSync(path.join(dir, "voice")), false);
});

test("lean core reuses wallet, local chats and model paths without migrating optional saved data", async t => {
  const dir = fixture(t), password = "synthetic-test-password";
  const savedWallet = new WalletService(path.join(dir, "wallet"));
  const address = savedWallet.create({ password }).address;
  const models = [1, 2].map(i => {
    const file = path.join(dir, `external-model-${i}.gguf`), bytes = Buffer.from(`synthetic-weights-${i}`);
    fs.writeFileSync(file, bytes);
    return { alias: `custom-fixture-${i}`, label: `Fixture ${i}`, path: file, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, contextSize: 2048, minRamGb: 1 };
  });
  put(dir, "state.json", { customModels: models });
  put(dir, "settings.json", { network: { privacyMode: "local-only" } });
  put(dir, "chats/legacy-chat.json", { id: "legacy-chat", title: "Saved discussion", messages: [{ role: "user", content: "Hello" }] });
  put(dir, "companion-hub.json", "encrypted-synthetic-workflow-brain-data");
  put(dir, "agent-network.json", "encrypted-synthetic-service-data");
  put(dir, "koinos-node/settings.json", { node: { enabled: true }, schema: "synthetic" });
  put(dir, "tasks.json", { tasks: [{ id: "old-task", enabled: true }] });
  const preserved = ["wallet/wallet.json", "state.json", "chats/legacy-chat.json", "companion-hub.json", "agent-network.json", "koinos-node/settings.json", "tasks.json"];
  const before = new Map(preserved.map(name => [name, fs.readFileSync(path.join(dir, name))]));
  const { core, base, external } = await open(t, dir);
  assert.equal(core.account.wallet.address, address);
  assert.equal(core.account.wallet.status().unlocked, false);
  core.account.wallet.unlock(password);
  assert.equal(core.account.wallet.address, address);
  assert.equal(core.models.modelsDir, path.join(dir, "models"));
  for (const model of models) {
    assert.equal(core.models.aliases().find(m => m.alias === model.alias).status, "ready");
    assert.equal(await core.models.ensurePackage(`custom:${model.sha256}`), model.path);
  }
  const chats = await (await fetch(base + "/core/chats")).json();
  assert.equal(chats.chats[0].id, "legacy-chat");
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(dir, name)), bytes, name);
  assert.deepEqual(external, []);
});
