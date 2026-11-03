"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { CreditProvider } = require("../../electron/credit-provider");
const { ProviderDevice } = require("../../electron/provider-device");
const { Worker } = require("../lib/worker");

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-connection-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const hash = "a".repeat(64), tariff = { model: "small", modelHash: hash };
  let privacyMode = "network", denied = false, catalog = async () => ({ tariffs: [tariff] }), stops = 0, nudges = 0;
  const core = { gateway: { network: { status: () => ({ privacyMode }) } }, hardware: { ramBytes: 16e9 },
    models: { catalog: { aliases: { small: { package: "small", minRamGb: 1 } }, packages: { small: { sha256: hash } } },
      quarantineOf: () => false, packageStatus: () => ({ status: "ready" }) } };
  const c = { directory, config: { owner: "fixture", schedulerUrl: "https://fixture.invalid" }, auth: { sessionToken: "fixture-token" }, flow: { models: signal => catalog(signal) } };
  const device = { context: async () => ({ ...c }), cancelPending() {}, assert() { if (denied) throw Object.assign(Error("Device authorization revoked"), { code: "authorization-revoked" }); } };
  const provider = new CreditProvider({ core, service: {}, device });
  provider.context = c; provider.preference(c, true); await provider.models(c, new AbortController().signal);
  provider.registeredModelPins = { ...c.offeredModelPins };
  const worker = provider.worker = { running: true, async stop() { stops++; this.running = false; }, async nudge() { nudges++; } };
  return { provider, worker, c, stops: () => stops, nudges: () => nudges,
    setCatalog(value) { catalog = value; }, revoke() { denied = true; }, localOnly() { privacyMode = "local-only"; } };
}

for (const failure of [Object.assign(Error("Service busy"), { code: "network-unavailable" }), new DOMException("Catalog timed out", "TimeoutError"), new TypeError("fetch failed")]) {
  test(`catalog ${failure.name}: ${failure.message} preserves the approved running worker and recovers`, async t => {
    const f = await fixture(t), pins = f.provider.registeredModelPins;
    f.setCatalog(async () => { throw failure; }); await f.provider.tick(); await f.provider.tick();
    assert.equal(f.stops(), 0); assert.equal(f.provider.worker, f.worker); assert.equal(f.worker.running, true);
    assert.equal(f.provider.registeredModelPins, pins); assert.equal(f.provider.error, failure.message);
    f.setCatalog(async () => ({ tariffs: [{ model: "small", modelHash: "a".repeat(64) }] })); await f.provider.tick();
    assert.equal(f.provider.error, ""); assert.equal(f.stops(), 0);
  });
}

for (const change of ["revoke", "localOnly"]) {
  test(`${change} during a delayed catalog failure still stops earning`, async t => {
    const f = await fixture(t); let reject, started;
    const waiting = new Promise(resolve => { started = resolve; });
    f.setCatalog(() => { started(); return new Promise((_, fail) => { reject = fail; }); });
    const tick = f.provider.tick(); await waiting; f[change]();
    reject(new DOMException("Timeout", "TimeoutError")); await tick;
    assert.equal(f.stops(), 1); assert.equal(f.worker.running, false);
    assert.equal(f.provider.preference(f.c), true, "saved intent is preserved for explicit authorization or network recovery");
  });
}

test("invalid catalog policy still stops the worker", async t => {
  const f = await fixture(t); f.setCatalog(async () => { throw Error("Catalog policy mismatch"); }); await f.provider.tick();
  assert.equal(f.stops(), 1); assert.match(f.provider.error, /policy mismatch/);
});

test("Stop during a delayed catalog request cannot be undone by its late result", async t => {
  const f = await fixture(t); let finish, started;
  const waiting = new Promise(resolve => { started = resolve; });
  f.setCatalog(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  const tick = f.provider.tick(); await waiting; await f.provider.stop(true);
  finish({ tariffs: [{ model: "small", modelHash: "a".repeat(64) }] }); await tick;
  assert.equal(f.stops(), 1); assert.equal(f.worker.running, false); assert.equal(f.provider.preference(f.c), false);
});

test("wake restores an authorized worker without a catalog fetch and stops revoked authority", async t => {
  const f = await fixture(t); f.setCatalog(async () => { throw Error("Wake must not wait for catalog"); });
  await f.provider.wake(); assert.equal(f.nudges(), 1); assert.equal(f.stops(), 0);
  f.revoke(); await f.provider.wake(); assert.equal(f.nudges(), 1); assert.equal(f.stops(), 1);
});

test("wake never starts a provider whose saved preference is off", async t => {
  const f = await fixture(t); await f.provider.stop(true); let starts = 0;
  t.mock.method(f.provider, "start", async () => { starts++; }); await f.provider.wake();
  assert.equal(starts, 0); assert.equal(f.nudges(), 0);
});

test("a service 503 is retryable without treating device authorization as revoked", async () => {
  const device = new ProviderDevice({ core: {}, service: { fetchImpl: async () => new Response(JSON.stringify({ error: "Busy" }), { status: 503 }) } });
  const c = { config: { schedulerUrl: "https://fixture.invalid" }, record: { enrolled: true } };
  await assert.rejects(device.request(c, "capabilities"), error => error.code === "network-unavailable");
  assert.equal(c.record.revoked, undefined);
});

test("worker wake renews registration and signed presence, and honors deliberate backoff", async () => {
  const worker = new Worker({ schedulerUrl: "https://fixture.invalid", wallet: { address: "fixture" }, runtime: {} });
  worker.running = true; const calls = [];
  worker._register = async () => { calls.push("register"); };
  worker._koinPresence = async () => { calls.push("presence"); };
  worker._loopDone = true; worker._startLoop = () => { calls.push("loop"); worker._loopDone = false; };
  await worker.nudge(); assert.deepEqual(calls, ["register", "presence", "loop"]);
  worker._backoff = true; await worker.nudge(); assert.equal(calls.length, 3);
  worker._backoff = false; worker.running = false; await worker.nudge(); assert.equal(calls.length, 3);
});
