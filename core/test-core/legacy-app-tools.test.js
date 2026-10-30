"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLegacyRuntime } = require("../../electron/plugin-services/legacy-runtime");
async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-app-tools-")); t.after(() => fs.rmSync(dataDir, { force: true, recursive: true }));
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ network: { privacyMode: "local-first" } }));
  const core = await require("../server").createCore({ dataDir, extensions: false, onEvent() {} }); t.after(() => core.stop());
  let approved = true, reviews = 0, stopped = 0;
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "gnome_libsecret", encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
  const store = new (require("../../electron/companion-store").CompanionStore)({ dataDir, safeStorage });
  const calls = [], ctx = { dataDir, core, getCompanionStore: () => store, getWindow: () => ({ isDestroyed: () => false, isVisible: () => true }), electron: { safeStorage, shell: {}, dialog: {} }, confirm: async () => { reviews++; return approved; }, readCoreWalletSummary: async () => ({ address: "synthetic", koin: "12.5", vhp: "3", mana: "1" }) };
  const documents = require("../../electron/plugin-services/documents").create(ctx);
  let workflows;
  ctx.featureCall = async (id, method, input, signal) => {
    calls.push({ id, method, input });
    if (id === "kai.documents") return documents.call(method, input, signal);
    if (id === "kai.workflows") { workflows ||= require("../../electron/plugin-services/workflows").create({ ...ctx, getLegacyHub: feature => runtime.getHub(feature), legacyManage: (...args) => runtime.manage(...args), releaseLegacyFeature: feature => runtime.release(feature) }); return workflows.call(method, input, signal); }
    throw Error("Install or enable this feature");
  };
  core.gateway.earn.stop = async () => { stopped++; return { running: false }; };
  const runtime = createLegacyRuntime(ctx); t.after(async () => { await workflows?.dispose(); await documents.dispose(); await runtime.dispose(); }); runtime.ensure("assistant");
  return { core, runtime, dataDir, calls, approved: value => { approved = value; }, reviews: () => reviews, stopped: () => stopped };
}
test("original app tools are registered lazily and read Core facts without optional Node services", async t => {
  const f = await fixture(t), tools = f.core.gateway.tools;
  for (const name of ["app_capabilities", "app_read", "app_action"]) assert.ok(tools.list().some(tool => tool.name === name));
  const capabilities = JSON.parse(await tools.call("app_capabilities", {})); assert.ok(capabilities.actions.stop_earning); assert.ok(capabilities.reads.includes("documents"));
  const models = JSON.parse(await tools.call("app_read", { subject: "models" })); assert.equal(models.subject, "models"); assert.ok(models.data.models.length);
  const wallet = JSON.parse(await tools.call("app_read", { subject: "wallet" })); assert.equal(wallet.data.balances.koin, "12.5"); assert.deepEqual(f.calls, []); assert.equal(f.reviews(), 0);
  assert.equal(f.core.gateway.koinosNode, null);
});
test("original scheduled app actions create saved Workflows with chat output and no legacy timer", async t => {
  const f = await fixture(t); f.core.models.aliases = () => [{ alias: "local", status: "ready" }, { alias: "other-local", status: "ready" }];
  const tools = f.core.gateway.tools;
  const saved = JSON.parse(await tools.call("app_action", { action: "create_task", args: { name: "Daily summary", prompt: "Summarize synthetic input", model: "local", schedule: { kind: "daily", hour: 9 } } }, { confirmed: true }));
  const workflow = f.runtime.getHub("workflows").store.data.workflows.find(item => item.id === saved.result.task.id);
  assert.equal(workflow.enabled, true); assert.equal(workflow.graph.nodes.at(-1).config.saveChat, true); assert.equal(f.core.tasks, undefined);
  const tasks = JSON.parse(await tools.call("app_read", { subject: "tasks" })); assert.equal(tasks.data.tasks[0].name, "Daily summary");
  await tools.call("app_action", { action: "update_task", args: { id: workflow.id, name: "Weekly review", prompt: "Changed prompt", model: "other-local", schedule: { kind: "weekly", day: 3, hour: 11 } } }, { confirmed: true });
  const changed = f.runtime.getHub("workflows").store.data.workflows[0]; assert.equal(changed.name, "Weekly review"); assert.equal(changed.model, "other-local"); assert.equal(changed.graph.nodes.find(node => node.type === "agent").config.prompt, "Changed prompt"); assert.deepEqual(changed.schedule, { kind: "weekly", day: 3, hour: 11 }); assert.equal(changed.graph.nodes.at(-1).config.saveChat, true); assert.deepEqual(changed.graph.edges, workflow.graph.edges); assert.equal(changed.enabled, true);
  await tools.call("app_action", { action: "update_task", args: { id: workflow.id, enabled: false } }, { confirmed: true });
  assert.equal(f.runtime.getHub("workflows").store.data.workflows[0].enabled, false);
  await tools.call("app_action", { action: "delete_task", args: { id: workflow.id } }, { confirmed: true });
  assert.equal(f.runtime.getHub("workflows").store.data.workflows.length, 0);
});
test("app actions retain exact native approval and guarded Documents capability writes", async t => {
  const f = await fixture(t), tools = f.core.gateway.tools;
  await assert.rejects(tools.call("app_action", { action: "stop_earning", args: {} }), error => error.needsConfirmation);
  f.approved(false); await assert.rejects(tools.call("app_action", { action: "stop_earning", args: {} }, { confirmed: true }), /cancelled/); assert.equal(f.stopped(), 0);
  f.approved(true); await tools.call("app_action", { action: "stop_earning", args: {} }, { confirmed: true }); assert.equal(f.stopped(), 1);
  const saved = JSON.parse(await tools.call("app_action", { action: "save_document", args: { title: "Original app tool", content: "Original document behavior" } }, { confirmed: true }));
  assert.equal(saved.result.title, "Original app tool"); assert.equal(f.calls.at(-1).method, "documents.save");
  const opened = JSON.parse(await tools.call("app_read", { subject: "documents", id: saved.result.id })); assert.equal(opened.data.doc.content, "Original document behavior");
  const file = path.join(f.dataDir, "docs", saved.result.id + ".json"); fs.writeFileSync(file, "corrupt");
  await assert.rejects(tools.call("app_action", { action: "save_document", args: { id: saved.result.id, revision: opened.data.doc.revision, title: "Overwrite", content: "No" } }, { confirmed: true }), /unreadable/); assert.equal(fs.readFileSync(file, "utf8"), "corrupt");
  await assert.rejects(tools.call("app_action", { action: "wallet:revealWif", args: {} }, { confirmed: true }), /Unknown app action/);
});
test("document app actions bind each caller's observed revision even after another read", async t => {
  const f = await fixture(t), tools = f.core.gateway.tools;
  const created = JSON.parse(await tools.call("app_action", { action: "save_document", args: { title: "Observed", content: "Version one" } }, { confirmed: true })).result;
  const first = JSON.parse(await tools.call("app_read", { subject: "documents", id: created.id })).data.doc;
  const file = path.join(f.dataDir, "docs", created.id + ".json"), changed = JSON.parse(fs.readFileSync(file)); changed.content = "Version changed elsewhere"; fs.writeFileSync(file, JSON.stringify(changed));
  const second = JSON.parse(await tools.call("app_read", { subject: "documents", id: created.id })).data.doc;
  assert.notEqual(first.revision, second.revision);
  await assert.rejects(tools.call("app_action", { action: "save_document", args: { id: created.id, revision: first.revision, title: "Stale", content: "Overwrite" } }, { confirmed: true }), /changed/);
  assert.equal(JSON.parse(fs.readFileSync(file)).content, "Version changed elsewhere");
  await assert.rejects(tools.call("app_action", { action: "delete_document", args: { id: created.id } }, { confirmed: true }), /Read this document/);
  await tools.call("app_action", { action: "save_document", args: { id: created.id, revision: second.revision, title: "Current", content: "Reviewed current version" } }, { confirmed: true });
  assert.equal(JSON.parse(fs.readFileSync(file)).content, "Reviewed current version");
  const long = JSON.parse(fs.readFileSync(file)); long.content = "Long source material. ".repeat(1000); fs.writeFileSync(file, JSON.stringify(long));
  const excerpt = await tools.call("app_read", { subject: "documents", id: created.id });
  assert.match(excerpt.slice(0, 200), /"revision":"[0-9a-f-]{36}"/); assert.match(excerpt, /\[truncated\]$/);
});
