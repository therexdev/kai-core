"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { create } = require("../../electron/plugin-services/remote-access"), { JsonStore } = require("../lib/store"), { ApiKeys } = require("../lib/keys");
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-original-remote-"));
  const settings = new JsonStore(path.join(dataDir, "settings.json"), { marker: "retain" }), keys = new ApiKeys(settings);
  let mode = "local-first", approval = true, enabled = false, starts = 0;
  const ctx = { dataDir, core: { settings, keys, models: { aliases: () => [{ alias: "local", status: "ready" }] }, gateway: { port: 41100, network: { status: () => ({ privacyMode: mode }) } } },
    confirm: async () => approval, setPrivacyMode: value => { mode = value; },
    originalRemoteFactory: options => ({ start: async () => { assert.equal(options.keys, keys); assert.equal(options.localBase(), "http://127.0.0.1:41100"); starts++; enabled = true; }, stop: () => { enabled = false; }, status: () => ({ enabled, state: enabled ? "connected" : "off", base: enabled ? "https://koinosai.com/r/synthetic/v1" : null }) }) };
  const api = create(ctx); t.after(async () => { await api.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { api, keys, settings, dataDir, starts: () => starts, approve: value => { approval = value; }, call: input => api.call("remote.api", input) };
}
test("Remote original UI uses the original API keys, usage counters and monthly budgets", async t => {
  const f = fixture(t), existing = f.keys.create({ name: "Original client" });
  f.keys.recordUsage(existing.id, { inTok: 12, outTok: 3, costMicro: 1500 });
  const before = await f.call({ action: "status" }); assert.equal(f.starts(), 0);
  assert.equal(before.keys[0].usage.requests, 1); assert.equal(before.keys[0].usage.inTok, 12);
  assert.ok(!JSON.stringify(before).includes(existing.secret)); assert.ok(!JSON.stringify(before).includes("digest"));
  await f.call({ action: "budget", id: existing.id, budgetUsdMonthly: 2.5 });
  assert.equal(f.keys.list()[0].budgetUsdMonthly, 2.5); assert.equal(f.settings.get("marker"), "retain");
  const created = await f.call({ action: "create", name: "New client" }); assert.equal(f.keys.verify(created.secret).id, created.id);
  assert.ok(!JSON.stringify(await f.call({ action: "status" })).includes(created.secret));
});
test("Remote original toggle retains approvals, key requirement, privacy and stop behavior", async t => {
  const f = fixture(t); await assert.rejects(f.call({ action: "toggle", enabled: true }), /Create an API key/);
  const key = f.keys.create({ name: "Phone" }); f.approve(false);
  assert.equal((await f.call({ action: "toggle", enabled: true })).cancelled, true); assert.equal(f.starts(), 0);
  f.approve(true); assert.equal((await f.call({ action: "toggle", enabled: true })).remote.enabled, true);
  await f.call({ action: "privacy", privacyMode: "local-only" }); assert.equal((await f.call({ action: "status" })).remote.enabled, false);
  await assert.rejects(f.call({ action: "toggle", enabled: true }), /Local-Only/);
  await f.call({ action: "revoke", id: key.id }); assert.equal(f.keys.required(), false);
});
test("Remote original requests reject arbitrary routes, malformed fields and corrupt settings", async t => {
  const f = fixture(t), file = path.join(f.dataDir, "settings.json");
  await assert.rejects(f.call({ action: "request", path: "/core/wallet" }), /Invalid/);
  await assert.rejects(f.call({ action: "wallet" }), /Unknown/);
  await assert.rejects(f.call({ action: "create", name: "bad\nname" }), /name/);
  const key = f.keys.create({ name: "Client" });
  await assert.rejects(f.call({ action: "budget", id: key.id, budgetUsdMonthly: -1 }), /nonnegative/);
  assert.equal(f.starts(), 0); fs.writeFileSync(file, "{broken");
  await assert.rejects(f.call({ action: "status" }), /unreadable/); assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});
test("saved enabled Remote Access resumes only with keys and online privacy, and stops on disposal", async t => {
  const f = fixture(t);
  await f.api.startBackground(); assert.equal(f.starts(), 0);
  f.settings.set("remote.enabled", true); await f.api.startBackground(); assert.equal(f.starts(), 0);
  f.keys.create({ name: "Existing client" }); await f.api.startBackground(); assert.equal(f.starts(), 1);
  assert.equal((await f.call({ action: "status" })).remote.enabled, true);
  await f.api.dispose(); assert.equal(f.settings.get("remote.enabled"), true, "The saved explicit choice survives shutdown");
  await assert.rejects(f.call({ action: "status" }), /closed/);
});
