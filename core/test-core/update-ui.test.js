"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createUpdates, presentation } = require("../../ui-core/updates");
const initial = overrides => ({ revision: 1, state: "idle", currentVersion: "0.7.8", availableVersion: null, automaticCheck: true, lastCheckedAt: null,
  paused: false, canDownload: false, canInstall: false, manualOnly: false, reason: null, error: null, ...overrides });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("downloaded updates require an explicit install action; background observation never acts", async () => {
  const calls = [], info = initial({ state: "downloaded", availableVersion: "0.7.9", canInstall: true });
  const controller = createUpdates({ call: async method => { calls.push(method); return info; } });
  controller.observe(info); assert.deepEqual(calls, []);
  assert.equal(presentation(info).installVisible, true);
  await controller.act("install"); assert.deepEqual(calls, ["updates.install", "updates.status"]);
});

test("an older poll cannot replace newer download progress or ready state", async () => {
  const read = deferred(), controller = createUpdates({ call: () => read.promise });
  controller.observe(initial()); const polling = controller.refresh();
  controller.observe(initial({ revision: 4, state: "downloaded", availableVersion: "0.7.9", canInstall: true }));
  read.resolve(initial({ revision: 2, state: "downloading", progress: { percent: 12 } })); await polling;
  assert.equal(controller.snapshot().info.state, "downloaded");
  assert.equal(controller.snapshot().info.revision, 4);
});

test("the UI serializes repeated clicks while an update request is in progress", async () => {
  const work = deferred(), calls = []; let info = initial();
  const controller = createUpdates({ call: async method => { calls.push(method); return method === "updates.check" ? work.promise : info; } });
  controller.observe(info); const check = controller.act("check");
  await controller.act("check"); await controller.act("openRelease");
  assert.equal(controller.snapshot().pending, "check");
  info = initial({ revision: 2, state: "current" }); work.resolve(info); await check;
  assert.deepEqual(calls, ["updates.check", "updates.status"]);
});

test("manual-only packages show download fallback, never in-app installation", () => {
  const view = presentation(initial({ state: "available", availableVersion: "0.7.9", manualOnly: true, reason: "Portable copies use a manual download." }));
  assert.equal(view.downloadVisible, false); assert.equal(view.installVisible, false);
  assert.equal(view.releaseLabel, "Download release"); assert.equal(view.releasePrimary, true); assert.match(view.detail, /Portable/);
});

test("Local only blocks network actions while a verified downloaded update remains installable", async () => {
  const calls = [], controller = createUpdates({ call: async method => { calls.push(method); return initial(); } });
  const paused = initial({ paused: true, state: "available", availableVersion: "0.7.9", canDownload: true });
  controller.observe(paused);
  await controller.act("check"); await controller.act("download"); await controller.act("openRelease");
  assert.deepEqual(calls, []); assert.match(presentation(paused).detail, /Local only/);
  const ready = initial({ paused: true, state: "downloaded", availableVersion: "0.7.9", canInstall: true });
  assert.equal(presentation(ready).installDisabled, false);
});

test("errors can be dismissed across polls and shown again on a new failed action", async () => {
  let rendered; const info = initial({ state: "error", error: "Cannot reach update service." });
  const controller = createUpdates({ call: async () => info, render: (_state, view) => { rendered = view; } });
  controller.observe(info); assert.equal(rendered.error, info.error);
  controller.dismissError(); controller.observe(info); assert.equal(rendered.error, "");
  await controller.act("check"); assert.equal(rendered.error, info.error);
});

test("changing automatic checks persists the explicit value without starting an install", async () => {
  let info = initial(); const calls = [];
  const controller = createUpdates({ call: async (method, input) => { calls.push({ method, input }); if (method === "updates.configure") info = { ...info, revision: 2, automaticCheck: input.automaticCheck }; return info; } });
  controller.observe(info); await controller.act("configure", false);
  assert.equal(controller.snapshot().info.automaticCheck, false);
  assert.deepEqual(calls[0], { method: "updates.configure", input: { automaticCheck: false } });
  assert.equal(calls.some(c => /download|install/.test(c.method)), false);
});
