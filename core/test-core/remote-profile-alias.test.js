"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { create } = require("../../electron/plugin-services/remote-access");
const { JsonStore } = require("../lib/store"), { ApiKeys } = require("../lib/keys");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-remote-profile-alias-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const actual = path.join(root, "actual"), alias = path.join(root, "alias");
  fs.mkdirSync(path.join(actual, "profile"), { recursive: true });
  try { fs.symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (process.platform === "win32" && error.code === "EPERM") { t.skip("Windows runner does not grant directory links"); return null; } throw error; }
  const dataDir = path.join(alias, "profile"), realDir = path.join(actual, "profile"), file = path.join(realDir, "settings.json");
  const settings = new JsonStore(path.join(dataDir, "settings.json"), { unknown: { preserve: true } });
  const keys = new ApiKeys(settings), key = keys.create({ name: "Existing original client" });
  let starts = 0, reviews = 0;
  const service = create({ dataDir, core: { settings, keys, models: { aliases: () => [] }, gateway: { port: 41100, network: { status: () => ({ privacyMode: "local-first" }) } } },
    confirm: async () => { reviews++; return true; },
    originalRemoteFactory: () => ({ start: async () => { starts++; }, stop() {}, status: () => ({ enabled: false, state: "off", base: null }) }),
  });
  t.after(() => service.dispose());
  return { root, actual, alias, dataDir, realDir, file, settings, keys, key, service, starts: () => starts, reviews: () => reviews,
    call: input => service.call("remote.api", input) };
}

test("trusted profile ancestor aliases preserve the original API keys and write budgets to the same profile", async t => {
  const f = fixture(t); if (!f) return;
  const before = fs.readFileSync(f.file), status = await f.call({ action: "status" });
  assert.equal(status.keys[0].id, f.key.id);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(f.starts(), 0);
  assert.ok(!JSON.stringify(status).includes(f.key.secret));
  await f.call({ action: "budget", id: f.key.id, budgetUsdMonthly: 7.5 });
  assert.equal(f.keys.list()[0].budgetUsdMonthly, 7.5);
  const disk = JSON.parse(fs.readFileSync(f.file));
  assert.deepEqual(disk.unknown, { preserve: true });
  assert.equal(disk.apiKeys[f.key.id].budgetUsdMonthly, 7.5);
  assert.equal(fs.realpathSync(path.join(f.dataDir, "settings.json")), f.file);
  assert.equal(f.reviews(), 0);
});

test("an approved ancestor alias does not permit symlinked or hardlinked settings below the profile", async t => {
  const f = fixture(t); if (!f) return;
  const before = fs.readFileSync(f.file), outside = path.join(f.root, "outside.json");
  fs.writeFileSync(outside, before); fs.unlinkSync(f.file);
  try { fs.symlinkSync(outside, f.file, "file"); }
  catch (error) { if (process.platform === "win32" && error.code === "EPERM") { fs.writeFileSync(f.file, before); t.skip("Windows runner does not grant file links"); return; } throw error; }
  await assert.rejects(f.call({ action: "budget", id: f.key.id, budgetUsdMonthly: 12 }), /recovery/);
  assert.deepEqual(fs.readFileSync(outside), before);
  fs.unlinkSync(f.file); fs.linkSync(outside, f.file);
  await assert.rejects(f.call({ action: "budget", id: f.key.id, budgetUsdMonthly: 12 }), /recovery/);
  assert.deepEqual(fs.readFileSync(outside), before);
  assert.equal(f.reviews(), 0);
});

test("external settings edits and retargeted approved aliases cannot redirect a Remote mutation", async t => {
  const f = fixture(t); if (!f) return;
  const before = fs.readFileSync(f.file), edited = { ...JSON.parse(before), marker: "external edit" };
  fs.writeFileSync(f.file, JSON.stringify(edited));
  await assert.rejects(f.call({ action: "budget", id: f.key.id, budgetUsdMonthly: 12 }), /changed outside/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), edited);
  fs.writeFileSync(f.file, before);
  const replacement = path.join(f.root, "replacement"), replacementFile = path.join(replacement, "profile", "settings.json");
  fs.mkdirSync(path.dirname(replacementFile), { recursive: true }); fs.writeFileSync(replacementFile, before);
  fs.unlinkSync(f.alias); fs.symlinkSync(replacement, f.alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.call({ action: "budget", id: f.key.id, budgetUsdMonthly: 12 }), /profile directory changed/);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(fs.readFileSync(replacementFile), before);
  assert.equal(f.reviews(), 0);
});
