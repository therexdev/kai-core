"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createAppOrder } = require("../../electron/core-app-order");

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-app-order-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const state = { installed: [{ id: "kai.brain", enabled: true }, { id: "kai.workflows", enabled: false }] };
  const options = { dataDir, getInstalled: () => state.installed };
  return { dataDir, state, options, order: createAppOrder(options) };
}

test("app order survives restart, retains disabled apps, removes stale IDs and appends new installs", t => {
  const { state, options, order } = fixture(t);
  assert.deepEqual(order.read(), ["kai.brain", "kai.workflows"]);
  order.save(["kai.workflows", "kai.brain"]);
  assert.deepEqual(createAppOrder(options).read(), ["kai.workflows", "kai.brain"]);
  state.installed = [{ id: "kai.workflows" }, { id: "kai.code" }];
  assert.deepEqual(order.read(), ["kai.workflows", "kai.code"]);
  state.installed = [];
  assert.deepEqual(order.read(), []);
});

test("stale or malformed reorder cannot install or inject an app", t => {
  const { order } = fixture(t);
  order.save(["kai.workflows", "kai.brain"]);
  for (const input of [null, {}, ["kai.brain", "kai.brain"], ["../../wallet"], ["kai.not-installed"], [null]]) assert.throws(() => order.save(input), /Invalid installed app order/);
  assert.deepEqual(order.read(), ["kai.workflows", "kai.brain"]);
  assert.deepEqual(order.save(["kai.workflows"]), ["kai.workflows", "kai.brain"]);
});

test("damaged display preference falls back without altering plugin installation state", t => {
  const { dataDir, order, state } = fixture(t);
  order.save(["kai.workflows", "kai.brain"]);
  fs.writeFileSync(path.join(dataDir, "plugins-v3/sidebar-order.json"), "broken");
  assert.deepEqual(order.read(), ["kai.brain", "kai.workflows"]);
  assert.equal(state.installed[1].enabled, false);
  assert.equal(fs.readFileSync(path.join(dataDir, "plugins-v3/sidebar-order.json"), "utf8"), "broken");
});

test("app order never reads or replaces a linked preference file", { skip: process.platform === "win32" }, t => {
  const { dataDir, order } = fixture(t);
  order.save(["kai.workflows", "kai.brain"]);
  const file = path.join(dataDir, "plugins-v3/sidebar-order.json"), target = path.join(dataDir, "preserved.json");
  fs.writeFileSync(target, '{"schema":1,"ids":["kai.workflows","kai.brain"]}');
  fs.unlinkSync(file); fs.symlinkSync(target, file);
  assert.deepEqual(order.read(), ["kai.brain", "kai.workflows"]);
  assert.throws(() => order.save(["kai.brain"]), /Invalid app preferences file/);
  assert.equal(fs.readFileSync(target, "utf8"), '{"schema":1,"ids":["kai.workflows","kai.brain"]}');
});
