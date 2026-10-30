"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createVoiceDownloadPolicy } = require("../../electron/plugin-services/assistant-voice-policy");
function fixture() {
  let localOnly = true, installed = false, downloads = 0, held = false, closed = false, observedSignal;
  const service = { setup: { state: "idle" }, status: () => ({ available: installed }),
    async download(_url, _path, { signal }) { downloads++; observedSignal = signal; signal?.throwIfAborted(); if (held) await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); },
    async ensure({ signal } = {}) { if (!installed) await this.download("https://example.invalid/pinned-model", "synthetic-model", { signal }); this.setup = { state: "done" }; },
    warm() { return "installed local voice"; }, close() { closed = true; } };
  const original = service.ensure, policy = createVoiceDownloadPolicy({ services: [service], isLocalOnly: () => localOnly });
  return { service, original, policy, online: () => { localOnly = false; }, local: () => { localOnly = true; }, installed: () => { installed = true; }, hold: () => { held = true; }, downloads: () => downloads, closed: () => closed, signal: () => observedSignal };
}
test("Local-Only denies automatic voice setup before any request and leaves installed speech usable", async () => {
  const f = fixture(); await assert.rejects(f.service.ensure(), /Local-Only blocks/); assert.equal(f.downloads(), 0); assert.equal(f.service.setup.state, "error");
  f.installed(); await f.service.ensure(); assert.equal(f.service.warm(), "installed local voice"); assert.equal(f.downloads(), 0); await f.policy.dispose();
});
test("switching to Local-Only aborts and drains an owned active voice download", async () => {
  const f = fixture(); f.online(); f.hold(); const task = f.service.ensure(); task.catch(() => {});
  assert.equal(f.downloads(), 1); f.local(); await f.policy.pause(); await assert.rejects(task, /abort/i); assert.equal(f.signal().aborted, true);
  await assert.rejects(f.service.ensure(), /Local-Only/); assert.equal(f.downloads(), 1); await f.policy.dispose();
});
test("disable waits for setup cancellation and restores the original service methods", async () => {
  const f = fixture(); f.online(); f.hold(); const task = f.service.ensure(); task.catch(() => {});
  await f.policy.dispose(); await assert.rejects(task, /abort/i); assert.equal(f.closed(), true); assert.equal(f.service.ensure, f.original);
});
test("voice setup passes an owned signal to managers with internal download implementations", async () => {
  let signal, called = false;
  const service = { status: () => ({ available: false }), ensure: options => { signal = options.signal; return new Promise((resolve, reject) => { called = true; signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }); } };
  const policy = createVoiceDownloadPolicy({ services: [service], isLocalOnly: () => false }), task = service.ensure(); task.catch(() => {});
  assert.equal(called, true); await policy.dispose(); await assert.rejects(task, /abort/i); assert.equal(signal.aborted, true);
});
