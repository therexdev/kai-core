"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { orderedIds, moveId, createOrder } = require("../../ui-core/apps");
const rows = ids => ids.map(id => ({ id, enabled: true }));
const tick = () => new Promise(resolve => setImmediate(resolve));

test("Apps order restores installed IDs, keeps disabled apps, and appends newly installed apps", () => {
  const plugins = [{ id: "brain", enabled: false }, { id: "node", enabled: true }, { id: "tools", enabled: true }];
  assert.deepEqual(orderedIds(plugins, ["removed", "node", "node", "brain"]), ["node", "brain", "tools"]);
  assert.deepEqual(orderedIds([], ["brain"]), []);
  assert.deepEqual(orderedIds(plugins, { corrupt: true }), ["brain", "node", "tools"]);
  assert.deepEqual(moveId(["brain", "node", "tools"], "node", -1), ["node", "brain", "tools"]);
  assert.deepEqual(moveId(["brain", "node", "tools"], "brain", 99), ["node", "tools", "brain"]);
});

test("rapid app reorders save in sequence and refresh cannot restore an older order", async () => {
  const saves = []; let release;
  const order = createOrder({ save: async ids => { saves.push(ids); if (saves.length === 1) await new Promise(resolve => release = resolve); return { ids }; } });
  order.sync(rows(["brain", "node", "tools"]), ["tools", "brain", "node"]);
  const first = order.set(["node", "tools", "brain"]);
  await tick();
  const second = order.set(["brain", "node", "tools"]);
  order.sync(rows(["brain", "node", "tools"]), ["tools", "brain", "node"]);
  assert.deepEqual(order.get(), ["brain", "node", "tools"]);
  assert.deepEqual(saves, [["node", "tools", "brain"]]);
  release(); await Promise.all([first, second]);
  assert.deepEqual(saves, [["node", "tools", "brain"], ["brain", "node", "tools"]]);
  order.sync(rows(["brain", "node", "tools"]), ["tools", "brain", "node"]);
  assert.deepEqual(order.get(), ["brain", "node", "tools"]);
});

test("a failed preference write restores the last saved app order and the next drag remains usable", async () => {
  let fail = true; const failures = [];
  const order = createOrder({ save: async ids => { if (fail) throw Error("Disk unavailable"); return { ids }; }, failed: error => failures.push(error.message) });
  order.sync(rows(["brain", "node"]), ["node", "brain"]);
  await order.set(["brain", "node"]);
  assert.deepEqual(order.get(), ["node", "brain"]); assert.deepEqual(failures, ["Disk unavailable"]);
  fail = false; await order.set(["brain", "node"]);
  assert.deepEqual(order.get(), ["brain", "node"]);
});

test("an earlier failed write cannot undo a later pending app order", async () => {
  let reject; const saves = [];
  const order = createOrder({ save: async ids => { saves.push(ids); if (saves.length === 1) await new Promise((resolve, no) => reject = no); return { ids }; } });
  order.sync(rows(["brain", "node", "tools"]), []);
  const first = order.set(["node", "brain", "tools"]); await tick();
  const last = order.set(["tools", "node", "brain"]);
  reject(Error("Disk temporarily unavailable")); await Promise.all([first, last]);
  assert.deepEqual(order.get(), ["tools", "node", "brain"]);
});

test("install and remove during a queued reorder preserve current installed membership", async () => {
  let release; const saves = [];
  const order = createOrder({ save: async ids => { saves.push(ids); if (saves.length === 1) await new Promise(resolve => release = resolve); return { ids }; } });
  order.sync(rows(["brain", "node", "tools"]), []);
  const first = order.set(["node", "brain", "tools"]); await tick();
  const last = order.set(["tools", "node", "brain"]);
  order.sync(rows(["node", "tools", "assistant"]), ["node", "tools", "assistant"]);
  release(); await Promise.all([first, last]);
  assert.deepEqual(saves[1], ["tools", "node", "assistant"]);
  assert.deepEqual(order.get(), ["tools", "node", "assistant"]);
});
