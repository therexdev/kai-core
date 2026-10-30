"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createUi, permissionsFor, scopedStatus } = require("../../electron/plugin-services/companion-feature-ui");
function fixture(feature) {
  const calls = [], secret = 'synthetic-secret-"private"';
  const status = { available: true, locked: false, notes: [{ id: "n", title: "Private memory", text: "private notes" }], goals: [], sources: [], syncs: [], brain: { tasks: [] }, brainIndex: {}, syncing: [],
    settings: { recall: true, approvalGrants: [{ key: "connected:a:write:1", label: "Write once", at: 1 }] },
    composio: { personalConfigured: true }, templates: [], models: [{ alias: "local", label: "Local", status: "ready", secret: "hidden" }],
    connections: [{ id: "a", name: "Account", secret, project: "project-private", binding: "binding-private", operations: [{ id: "read", name: "Read", method: "GET" }] }],
    workflows: [{ id: "w", name: "Routine", graph: { private: true }, draft: false }], runs: [{ id: "r", name: "Run", status: "done", startedAt: 1, output: "private run output" }],
    conversations: [{ id: "turn", question: "A reviewed request", actions: [{ id: "receipt", name: "Write", status: "uncertain", connectionId: "a", arguments: { private: true }, data: { text: secret } }] }], privateKey: "not returned", unknown: "not returned" };
  const hub = { store: { data: { connections: status.connections, composio: { key: "synthetic-composio-key" }, sources: [{ id: "app-source", kind: "connection", connectionId: "a" }, { id: "file-source", kind: "folder" }], conversations: status.conversations } } };
  const ctx = { core: { account: { _token: () => "synthetic-account-token" } }, getCompanionStore: () => ({ requireStorage() {} }), getLegacyHub: name => { assert.equal(name, feature); return hub; },
    legacyManage: async (name, action, input, signal) => { calls.push({ name, action, input }); signal?.throwIfAborted(); return action === "status" ? status : input; }, releaseLegacyFeature: async name => calls.push({ release: name }) };
  return { ui: createUi(ctx, feature), ctx, hub, status, calls, secret };
}
test("original Brain actions include awareness, all source kinds, export and reviewed workflow delegation", () => {
  const p = permissionsFor("brain");
  for (const action of ["brainSource", "brainTask", "brainCheckpoint", "awarenessRun", "awarenessSettings", "exportBrainVault", "sourceToggle", "run"]) assert.ok(p[`brain.ui.${action}`]);
  assert.equal(p["brain.ui.run"], "brain.workflow"); assert.equal(p["brain.ui.exportBrainVault"], "brain.export");
  assert.equal(p["brain.ui.composioSettings"], undefined);
});
test("Connections keeps OAuth reopen, full action discovery, persistent grants and Brain collection behind distinct permissions", () => {
  const p = permissionsFor("connections");
  assert.equal(p["connections.ui.request"], "connections.execute");
  assert.equal(p["connections.ui.source"], "connections.brain");
  for (const action of ["composioReopen", "composioLogo", "composioTools", "approvalGrantRemove", "conversationReview"]) assert.ok(p[`connections.ui.${action}`]);
  assert.equal(p["connections.ui.note"], undefined);
});
test("Brain renders its complete state without secret account bindings or workflow definitions", async () => {
  const f = fixture("brain"), output = await f.ui.call("brain.ui.status", {});
  assert.equal(output.notes[0].text, "private notes"); assert.deepEqual(output.brain, { tasks: [] });
  assert.deepEqual(output.workflows, [{ id: "w", name: "Routine", draft: false }]);
  assert.equal(output.connections[0].secret, undefined); assert.equal(output.connections[0].binding, undefined);
  assert.equal(output.runs[0].output, undefined); assert.equal(output.settings.approvalGrants, undefined);
  assert.equal(output.privateKey, undefined);
});
test("Connections cannot read Brain notes, settings, graph definitions or saved credentials", async () => {
  const f = fixture("connections"), output = await f.ui.call("connections.ui.status", {});
  assert.deepEqual(output.notes, []); assert.equal(output.brain, undefined); assert.deepEqual(output.workflows, []);
  assert.equal(output.settings.recall, undefined); assert.equal(output.connections[0].project, undefined);
  assert.equal(output.conversations[0].actions[0].arguments, undefined);
  assert.equal(output.conversations[0].actions[0].data.text, "[credential removed]");
  assert.equal(output.settings.approvalGrants.length, 1);
});
test("writes reach the original dispatcher unchanged; unrelated and prototype actions cannot dispatch", async () => {
  const f = fixture("brain"), input = { kind: "rss", url: "https://example.test/feed", autoSync: true };
  assert.deepEqual(await f.ui.call("brain.ui.brainSource", input), input);
  assert.deepEqual(f.calls[0], { name: "brain", action: "brainSource", input });
  for (const method of ["brain.ui.composioSettings", "brain.ui.__proto__", "connections.ui.status"]) await assert.rejects(f.ui.call(method, {}), /Unknown/);
  await assert.rejects(f.ui.call("brain.ui.remove", { kind: "connections" }), /Unknown Brain/);
  assert.equal(f.calls.length, 1);
});
test("Connections collect can sync selected app sources but cannot read a private folder source", async () => {
  const f = fixture("connections");
  await f.ui.call("connections.ui.sync", { id: "app-source" });
  await assert.rejects(f.ui.call("connections.ui.sync", { id: "file-source" }), /only a selected connected-app source/);
  assert.equal(f.calls.length, 1);
});
test("close and abort revoke dispatched actions without stopping other shared features", async () => {
  const f = fixture("brain"), controller = new AbortController(); controller.abort();
  await assert.rejects(f.ui.call("brain.ui.status", {}, controller.signal), /aborted/);
  assert.equal(f.calls.length, 0);
  await f.ui.call("brain.ui.status", {}); await f.ui.dispose();
  assert.deepEqual(f.calls.at(-1), { release: "brain" });
  await assert.rejects(f.ui.call("brain.ui.status", {}), /closing/);
});
test("locked status stays locked and never supplies a fabricated empty Brain", () => {
  assert.deepEqual(scopedStatus("brain", { locked: true, available: false }), { locked: true, available: false });
});

test("a locked keyring renders the original locked workspace but cannot dispatch mutations", async () => {
  const f = fixture("brain"); f.ctx.getCompanionStore = () => { throw Error("Unlock your original OS keychain and restart KAI to open the companion data."); };
  assert.deepEqual(await f.ui.call("brain.ui.status", {}), { locked: true, available: false });
  await assert.rejects(f.ui.call("brain.ui.note", { title: "No", text: "Never written" }), /Unlock/);
  assert.equal(f.calls.length, 0);
});
