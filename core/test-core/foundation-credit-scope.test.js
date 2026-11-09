"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), { EventEmitter } = require("node:events");
const { CreditService } = require("../../electron/credit-service");
const { CreditProvider } = require("../../electron/credit-provider");
const { registerTestPaymentIPC } = require("../../electron/koin-test-ipc");

// Keep the real payment dispatcher, per-publisher service construction and
// CreditRuns persistence/lookup. The authenticated network is a deterministic
// fixture: no purchase, chain transaction, account or external model is used.
function fixture(t, powerMonitor) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-foundation-finance-"));
  const scopes = new Set();
  let accountId = "same-account", privacy = "network", onChat;
  t.mock.method(global, "setInterval", () => ({ unref() {} }));
  t.mock.method(CreditProvider.prototype, "dispose", async () => {});
  t.mock.method(CreditService.prototype, "purchaseState", async () => ({}));
  t.mock.method(CreditService.prototype, "context", async function () {
    scopes.add(this.dataDir);
    const directory = path.join(this.dataDir, "synthetic-account");
    fs.mkdirSync(directory, { recursive: true });
    const recovery = path.join(directory, "recovery.json");
    const config = { model: "network-test", owner: "same-user-account", schedulerUrl: "https://network.example.test", limits: { perJob: "100000000" } };
    const flow = {
      estimate: async input => ({ unit: "USD-1e-8", model: input.model.replace(/^koinos-network:/, ""), maxCharge: "100", maxFree: "100", maxPaid: "0", allowed: true }),
      models: async () => ({ models: [{ model: "network-test", available: true, maxOutput: 512 }] }),
      async call(action, value) {
        if (action === "run-open") return { run: { id: value.runId, model: value.model, maxTotal: value.maxTotal, freeOnly: value.freeOnly } };
        return { run: { id: value.runId, status: "open" } };
      },
      async chat(_owner, input, signal) { if (onChat) await onChat(signal); const value = { state: "answered", text: input.messages[0].content }; fs.writeFileSync(recovery, JSON.stringify(value)); return value; },
    };
    return {
      config, directory, contexts: [{ config, directory }], auth: { accountId, owner: config.owner, sessionOnly: false }, flow,
      recoverable: fs.existsSync(recovery) ? [{ record: { id: "a".repeat(64) }, flow: { recover: async () => JSON.parse(fs.readFileSync(recovery)), acknowledge: () => fs.rmSync(recovery) } }] : [],
    };
  });
  function contents(url) { const result = new EventEmitter(); result.mainFrame = { url }; result.isDestroyed = () => false; result.send = () => {}; return result; }
  const window = new EventEmitter(); window.isDestroyed = () => false; window.isVisible = () => true; window.isMinimized = () => false;
  window.webContents = contents("http://127.0.0.1:9000/");
  let handler;
  const registration = registerTestPaymentIPC({ dataDir, core: { gateway: { network: { status: () => ({ privacyMode: privacy }), trackShadowRequest: () => () => {} } } }, isTest: false,
    dialog: {}, powerMonitor, origin: "http://127.0.0.1:9000", getMainWindow: () => window, ipcMain: { handle(_channel, fn) { handler = fn; } } });
  const caller = (pluginId, fingerprint) => {
    const entry = `kai-plugin://${pluginId}/index.html`, webContents = contents(entry);
    return { pluginId, name: pluginId, fingerprint, entry, window, webContents, isVisible: () => true, lifetimeSignal: new AbortController().signal };
  };
  const plugin = (pluginId, fingerprint) => { const owner = caller(pluginId, fingerprint); return (action, input) => registration.runForPlugin(action, input, owner); };
  const core = (action, input) => handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, action, input);
  t.after(async () => { await registration.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, scopes, plugin, caller, core, registration, setAccount: id => accountId = id, setPrivacy: mode => privacy = mode, onChat: fn => onChat = fn };
}

test("Core reviewed credit completion reuses workflow consent in background and ends it per run", async t => {
  const f = fixture(t), caller = f.caller("community.writer", "1".repeat(64)), scope = { id: "run-1", name: "Article" };
  const input = { model: "koinos-network:network-test", messages: [{ role: "user", content: "write" }] }; let reviews = 0;
  const review = async () => { reviews++; return "workflow"; };
  await f.registration.completeForPlugin(input, scope, caller, review);
  caller.isVisible = () => false; caller.window.isVisible = () => false;
  await f.registration.completeForPlugin(input, scope, caller, review); assert.equal(reviews, 1);
  assert.equal((await f.registration.accessForPlugin(scope, caller)).duration, "workflow");
  assert.equal((await f.registration.accessForPlugin({ ...scope, id: "run-2" }, caller)).allowed, false);
  await assert.rejects(f.registration.runForPlugin("chat-completion", input, caller), /visible|Return/);
  f.registration.endCreditScope(caller, scope.id);
  assert.equal((await f.registration.accessForPlugin(scope, caller)).allowed, false);
});

test("credit approval does not follow an account switch or bypass Local-Only", async t => {
  const f = fixture(t), caller = f.caller("community.writer", "1".repeat(64));
  const input = { model: "koinos-network:network-test", messages: [{ role: "user", content: "write" }] };
  await assert.rejects(f.registration.completeForPlugin(input, undefined, caller, async () => { f.setAccount("different"); return "always"; }), /account changed/);
  assert.equal((await f.registration.accessForPlugin(undefined, caller)).allowed, false);
  f.setPrivacy("local-only");
  await assert.rejects(f.registration.completeForPlugin(input, undefined, caller, () => assert.fail("must not review")), /Local-Only/);
  await assert.rejects(f.registration.runForPlugin("purchase-approve", {}, caller), /denied/);
});

test("Core revocation aborts active credit dispatch and removes future access", async t => {
  const f = fixture(t), caller = f.caller("community.writer", "1".repeat(64));
  const input = { model: "koinos-network:network-test", messages: [{ role: "user", content: "write" }] };
  await f.registration.completeForPlugin(input, undefined, caller, async () => "always");
  let started; const ready = new Promise(resolve => { started = resolve; });
  f.onChat(signal => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); started(); }));
  const pending = f.registration.completeForPlugin(input, undefined, caller, () => assert.fail("already allowed"));
  await ready; f.registration.revokeCreditAccess(f.registration.listCreditAccess()[0].id);
  await assert.rejects(pending, /stopped|revoked/);
  assert.equal((await f.registration.accessForPlugin(undefined, caller)).allowed, false);
});

test("always access can run a loaded signed service before its UI opens, without trusting a forged identity", async t => {
  const f = fixture(t), caller = f.caller("community.writer", "1".repeat(64));
  const input = { model: "koinos-network:network-test", messages: [{ role: "user", content: "write" }] };
  await f.registration.completeForPlugin(input, undefined, caller, async () => "always");
  const controller = new AbortController();
  const token = f.registration.registerNativeCreditCaller({ manifest: { id: caller.pluginId, entry: "index.html" }, fingerprint: caller.fingerprint, controller });
  const background = { ...caller, nativeCreditCaller: token, webContents: null, isVisible: () => false, lifetimeSignal: controller.signal };
  assert.equal((await f.registration.accessForPlugin(undefined, background)).allowed, true);
  assert.equal((await f.registration.runForPlugin("chat-info", undefined, background)).models[0].model, "network-test");
  assert.equal((await f.registration.completeForPlugin(input, undefined, background, () => assert.fail("must reuse"))).text, "write");
  await assert.rejects(f.registration.runForPlugin("chat-completion", input, background), /Return/);
  await assert.rejects(f.registration.accessForPlugin(undefined, { ...background, nativeCreditCaller: {} }), /denied/);
  await assert.rejects(f.registration.accessForPlugin(undefined, { ...background, pluginId: "another.writer" }), /denied/);
  controller.abort(); await assert.rejects(f.registration.accessForPlugin(undefined, background), /denied/);
});

test("OS resume recovers earning once and releases its listener on shutdown", async t => {
  const powerMonitor = new EventEmitter(); let wakes = 0, release;
  t.mock.method(CreditProvider.prototype, "wake", () => { wakes++; return new Promise(resolve => { release = resolve; }); });
  const f = fixture(t, powerMonitor);
  powerMonitor.emit("resume"); powerMonitor.emit("resume"); await Promise.resolve();
  assert.equal(wakes, 1, "wake requests must not overlap or rotate tokens twice");
  release(); await new Promise(resolve => setImmediate(resolve));
  powerMonitor.emit("resume"); await Promise.resolve(); assert.equal(wakes, 2);
  let disposed = false; const disposal = f.registration.dispose().then(() => { disposed = true; });
  await Promise.resolve(); assert.equal(disposed, false, "shutdown waits for the wake operation");
  assert.equal(powerMonitor.listenerCount("resume"), 0); release(); await disposal;
  powerMonitor.emit("resume"); assert.equal(wakes, 2);
});

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
