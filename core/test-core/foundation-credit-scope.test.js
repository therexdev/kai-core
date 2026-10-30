"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), { EventEmitter } = require("node:events");
const { CreditService } = require("../../electron/credit-service");
const { CreditProvider } = require("../../electron/credit-provider");
const { registerTestPaymentIPC } = require("../../electron/koin-test-ipc");

// Keep the real payment dispatcher, per-publisher service construction and
// CreditRuns persistence/lookup. The authenticated network is a deterministic
// fixture: no purchase, chain transaction, account or external model is used.
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-foundation-finance-"));
  const scopes = new Set();
  t.mock.method(global, "setInterval", () => ({ unref() {} }));
  t.mock.method(CreditProvider.prototype, "dispose", async () => {});
  t.mock.method(CreditService.prototype, "context", async function () {
    scopes.add(this.dataDir);
    const directory = path.join(this.dataDir, "synthetic-account");
    fs.mkdirSync(directory, { recursive: true });
    const recovery = path.join(directory, "recovery.json");
    const config = { model: "network-test", owner: "same-user-account", schedulerUrl: "https://network.example.test" };
    const flow = {
      models: async () => ({ models: [{ model: "network-test", available: true, maxOutput: 512 }] }),
      async call(action, value) {
        if (action === "run-open") return { run: { id: value.runId, model: value.model, maxTotal: value.maxTotal, freeOnly: value.freeOnly } };
        return { run: { id: value.runId, status: "open" } };
      },
      async chat(_owner, input) { const value = { state: "answered", text: input.messages[0].content }; fs.writeFileSync(recovery, JSON.stringify(value)); return value; },
    };
    return {
      config, directory, contexts: [{ config, directory }], auth: { accountId: "same-account", owner: config.owner, sessionOnly: false }, flow,
      recoverable: fs.existsSync(recovery) ? [{ record: { id: "a".repeat(64) }, flow: { recover: async () => JSON.parse(fs.readFileSync(recovery)), acknowledge: () => fs.rmSync(recovery) } }] : [],
    };
  });
  function contents(url) { const result = new EventEmitter(); result.mainFrame = { url }; result.isDestroyed = () => false; result.send = () => {}; return result; }
  const window = new EventEmitter(); window.isDestroyed = () => false; window.isVisible = () => true; window.isMinimized = () => false;
  window.webContents = contents("http://127.0.0.1:9000/");
  let handler;
  const registration = registerTestPaymentIPC({ dataDir, core: { gateway: { network: { status: () => ({ privacyMode: "network" }), trackShadowRequest: () => () => {} } } }, isTest: false,
    dialog: {}, origin: "http://127.0.0.1:9000", getMainWindow: () => window, ipcMain: { handle(_channel, fn) { handler = fn; } } });
  const plugin = (pluginId, fingerprint) => {
    const entry = `kai-plugin://${pluginId}/index.html`, webContents = contents(entry);
    return (action, input) => registration.runForPlugin(action, input, { pluginId, fingerprint, entry, window, webContents, isVisible: () => true });
  };
  const core = (action, input) => handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, action, input);
  t.after(async () => { await registration.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, scopes, plugin, core };
}

test("Core and two unrelated publishers cannot read each other's recoveries or saved credit runs", async t => {
  const f = fixture(t), first = f.plugin("community.writer", "1".repeat(64)), second = f.plugin("another.researcher", "2".repeat(64));
  const request = text => ({ model: "koinos-network:network-test", messages: [{ role: "user", content: text }] });
  const options = { mode: "agent", budget: "1", freeOnly: true, model: "network-test" };
  await first("chat-completion", request("first publisher private prompt"));
  assert.equal((await first("chat-recover")).text, "first publisher private prompt");
  assert.deepEqual(await second("chat-recover"), { state: "none" });
  assert.deepEqual(await f.core("chat-recover"), { state: "none" });
  await f.core("chat-completion", request("Core private prompt"));
  await second("chat-completion", request("second publisher private prompt"));
  assert.equal((await first("chat-recover")).text, "first publisher private prompt");
  assert.equal((await second("chat-recover")).text, "second publisher private prompt");
  assert.equal((await f.core("chat-recover")).text, "Core private prompt");
  const a = await first("run-open", options), b = await second("run-open", options), c = await f.core("run-open", options);
  assert.deepEqual((await first("run-list")).runs.map(r => r.id), [a.run.id]);
  assert.deepEqual((await second("run-list")).runs.map(r => r.id), [b.run.id]);
  assert.deepEqual((await f.core("run-list")).runs.map(r => r.id), [c.run.id]);
  await assert.rejects(second("run-status", a.run.id), /unavailable/);
  await assert.rejects(f.core("run-status", a.run.id), /unavailable/);
  await assert.rejects(first("run-status", c.run.id), /unavailable/);
  assert.equal((await first("run-status", a.run.id)).run.id, a.run.id);
  assert.equal(f.scopes.size, 3);
  assert.ok(f.scopes.has(f.dataDir));
  for (const [id, fingerprint] of [["community.writer", "1".repeat(64)], ["another.researcher", "2".repeat(64)]]) {
    const scope = crypto.createHash("sha256").update(id + "|" + fingerprint).digest("hex");
    assert.ok(f.scopes.has(path.join(f.dataDir, "plugin-finance", scope)));
  }
});

test("publisher replacement receives a fresh finance scope while any valid publisher gets the same API", async t => {
  const f = fixture(t), oldPublisher = f.plugin("community.writer", "a".repeat(64)), newPublisher = f.plugin("community.writer", "b".repeat(64));
  const run = await oldPublisher("run-open", { mode: "research", budget: "2", freeOnly: true, model: "network-test" });
  assert.deepEqual(await newPublisher("run-list"), { runs: [] });
  await assert.rejects(newPublisher("run-status", run.run.id), /unavailable/);
  const fresh = await newPublisher("run-open", { mode: "research", budget: "2", freeOnly: true, model: "network-test" });
  assert.notEqual(fresh.run.id, run.run.id);
  assert.equal((await newPublisher("run-status", fresh.run.id)).run.id, fresh.run.id);
  assert.equal(f.scopes.size, 2);
});
