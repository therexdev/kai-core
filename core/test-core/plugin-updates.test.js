"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { pluginUpdates } = require("../lib/plugins/updates");
const fingerprint = "a".repeat(64);
const plugin = (id, version, extra = {}) => ({ id, version, fingerprint, ...extra });

test("update count uses numeric versions and includes disabled installed plugins only", () => {
  const saved = [plugin("sample.active", "0.9.9"), plugin("sample.disabled", "1.0.0", { enabled: false }),
    plugin("sample.equal", "1.0.0"), plugin("sample.ahead", "2.0.0")];
  const catalog = [plugin("sample.active", "0.10.0"), plugin("sample.disabled", "1.0.1"),
    plugin("sample.equal", "1.0.0"), plugin("sample.ahead", "1.9.9"), plugin("sample.new", "3.0.0")];
  const result = pluginUpdates(saved, catalog);
  assert.equal(result.count, 2);
  assert.deepEqual(result.updates.map(row => row.id), ["sample.active", "sample.disabled"]);
  assert.equal(result.updates[0].installedVersion, "0.9.9"); assert.equal(result.updates[0].version, "0.10.0");
});

test("newer plugins requiring a newer Core remain visible with the compatibility reason", () => {
  const result = pluginUpdates([plugin("sample.blocked", "1.0.0")], [plugin("sample.blocked", "2.0.0", {
    compatible: false, minCoreVersion: "9.0.0", compatibilityReason: "Requires KAI Core 9.0.0 or newer"
  })]);
  assert.equal(result.count, 1); assert.equal(result.updates[0].compatible, false);
  assert.equal(result.updates[0].minCoreVersion, "9.0.0"); assert.match(result.updates[0].compatibilityReason, /9.0.0/);
});

test("untrusted publisher collisions and invalid versions never become update notifications", () => {
  const saved = [plugin("sample.other", "1.0.0"), plugin("sample.invalid", "broken"), plugin("sample.bad", "1.0.0")];
  const catalog = [plugin("sample.other", "2.0.0", { fingerprint: "b".repeat(64) }), plugin("sample.invalid", "2.0.0"), plugin("sample.bad", "01.0.0")];
  assert.deepEqual(pluginUpdates(saved, catalog), { count: 0, updates: [] });
});

test("completed updates and removals clear the count; duplicate IDs cannot inflate it", () => {
  const catalog = [plugin("sample.plugin", "1.0.1")], saved = [plugin("sample.plugin", "1.0.0")];
  assert.equal(pluginUpdates(saved, [...catalog, ...catalog]).count, 1);
  assert.equal(pluginUpdates([plugin("sample.plugin", "1.0.1")], catalog).count, 0);
  assert.equal(pluginUpdates([], catalog).count, 0);
  assert.equal(pluginUpdates(saved, []).count, 0);
  assert.equal(saved[0].version, "1.0.0");
});
