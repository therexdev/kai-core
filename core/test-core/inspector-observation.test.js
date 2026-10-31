"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { waitForInspectorObservation } = require("../../scripts/foundation/inspector-observation");
const collected = () => Error("electronApplication.evaluate: Resulting promise was garbage collected.");

test("readiness survives only the inspector's lost evaluation result and still requires a true observation", async () => {
  const results = [collected(), false, collected(), true]; let calls = 0;
  assert.equal(await waitForInspectorObservation(() => {
    const result = results[calls++]; if (result instanceof Error) throw result; return result;
  }, { timeoutMs: 1000, intervalMs: 1 }), true);
  assert.equal(calls, 4);
});

test("real plugin and inspector errors are propagated without retries", async () => {
  for (const error of [Error("Plugin service failed"), Error("electronApplication.evaluate: Execution context was destroyed"), Error("Plugin error: Resulting promise was garbage collected.")]) {
    let calls = 0;
    await assert.rejects(waitForInspectorObservation(() => { calls++; throw error; }, { timeoutMs: 1000, intervalMs: 1 }), value => value === error);
    assert.equal(calls, 1);
  }
});

test("repeated collected evaluations exhaust the original readiness deadline", async () => {
  let calls = 0;
  await assert.rejects(waitForInspectorObservation(() => { calls++; throw collected(); }, { message: "Node did not become ready", timeoutMs: 25, intervalMs: 2 }), /Node did not become ready/);
  assert.ok(calls > 1);
  const settledCalls = calls;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, settledCalls, "observations stop when the deadline expires");
});

test("an observation that never returns is also bounded by the readiness deadline", async () => {
  let calls = 0;
  await assert.rejects(waitForInspectorObservation(() => { calls++; return new Promise(() => {}); }, { message: "Node did not become ready", timeoutMs: 25 }), /Node did not become ready/);
  assert.equal(calls, 1);
});
