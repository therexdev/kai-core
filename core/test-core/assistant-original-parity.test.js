"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { create } = require("../../electron/plugin-services/assistant"), { ChatStore } = require("../lib/chats");
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-original-assistant-")), chats = new ChatStore(path.join(dataDir, "chats"));
  let approve = true; const forwarded = [];
  const api = create({ dataDir, core: { gateway: { chats } }, confirm: async () => approve,
    legacyRequest: async (feature, input) => { forwarded.push({ feature, input }); return { ok: true, status: 200, body: { text: "synthetic" } }; },
    runPayment: async action => ({ action }), getWindow: () => null });
  t.after(async () => { await api.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { api, chats, forwarded, approve: value => { approve = value; }, request: input => api.call("assistant.request", input) };
}
test("original chat requests restore images, citations, personas, regeneration and custom legacy metadata", async t => {
  const f = fixture(t), id = f.chats.save({ messages: [{ role: "user", content: "Image question", images: ["data:image/png;base64,AA=="] }, { role: "assistant", content: "First answer", citations: [{ title: "Source", url: "https://example.com/" }] }], system: "Explain simply", persona: "explainer" }).id;
  const old = f.chats.get(id); old.custom = { preserved: true }; old.messages[0].customAttachment = "keep"; fs.writeFileSync(f.chats._file(id), JSON.stringify(old));
  const opened = (await f.request({ path: "/core/chats/" + id })).body.chat;
  assert.deepEqual(opened.messages, old.messages); assert.equal(opened.persona, "explainer");
  const saved = await f.request({ path: "/core/chats", method: "POST", body: { id, system: opened.system, persona: opened.persona, messages: [opened.messages[0], { role: "assistant", content: "Regenerated answer", citations: opened.messages[1].citations }] } });
  assert.equal(saved.body.ok, true); const actual = f.chats.get(id);
  assert.equal(actual.messages[1].content, "Regenerated answer"); assert.deepEqual(actual.messages[0], old.messages[0]); assert.deepEqual(actual.custom, old.custom); assert.equal(actual.system, old.system);
});
test("a list refresh cannot authorize overwriting a conversation modified by another window", async t => {
  const f = fixture(t), id = f.chats.save({ messages: [{ role: "user", content: "Keep" }] }).id;
  const opened = (await f.request({ path: "/core/chats/" + id })).body.chat;
  f.chats.rename(id, "Changed in Core"); await f.request({ path: "/core/chats" });
  await assert.rejects(f.request({ path: "/core/chats", method: "POST", body: { ...opened, messages: [...opened.messages, { role: "assistant", content: "Stale" }] } }), /changed in another window/);
  assert.equal(f.chats.get(id).title, "Changed in Core"); assert.equal(f.chats.get(id).messages.length, 1);
});
test("original controls cannot replace corrupt chats and deletion respects native decline", async t => {
  const f = fixture(t), id = f.chats.save({ messages: [{ role: "user", content: "Keep" }] }).id;
  await f.request({ path: "/core/chats/" + id }); f.approve(false);
  assert.equal((await f.request({ path: "/core/chats/" + id, method: "DELETE" })).body.cancelled, true);
  fs.writeFileSync(f.chats._file(id), "{broken");
  await assert.rejects(f.request({ path: "/core/chats", method: "POST", body: { id, messages: [{ role: "user", content: "Overwrite" }] } }), /unreadable/);
  assert.equal(fs.readFileSync(f.chats._file(id), "utf8"), "{broken");
});
test("advanced chat is delegated to the scoped original runtime and wallet purchases stay inaccessible", async t => {
  const f = fixture(t); await f.request({ path: "/core/teams/run", method: "POST", body: { team: "research" }, stream: true });
  assert.equal(f.forwarded[0].feature, "assistant"); assert.equal(f.forwarded[0].input.path, "/core/teams/run");
  assert.equal((await f.api.call("assistant.payment", { action: "run-status" })).action, "run-status");
  await assert.rejects(f.api.call("assistant.payment", { action: "purchase" }), /unavailable/);
});
test("renderer sensitive-tool claims require an exact native review and cannot survive cancellation or reconfiguration", async t => {
  const { ToolRegistry } = require("../lib/tools"), registry = new ToolRegistry({ privacyMode: () => "local-first" });
  registry.register({ name: "write_file", description: "Write the selected workspace file", sensitive: true, egress: false, handler: () => "ok" });
  const reviews = [], forwarded = []; let approve = false, onReview;
  const original = require("../../electron/plugin-services/assistant-original").create({ core: { gateway: { tools: registry } },
    confirm: async (title, text) => { reviews.push({ title, text }); onReview?.(); return approve; }, legacyRequest: async (_feature, input) => { forwarded.push(input); return { ok: true }; } }, {});
  t.after(() => original.dispose());
  const call = (body, signal) => original.call("assistant.request", { path: "/core/tools/call", method: "POST", body }, signal);
  await call({ name: "write_file", args: { path: "notes.txt", content: "Keep" }, confirmed: false }); assert.equal(reviews.length, 0);
  await assert.rejects(call({ name: "write_file", args: { path: "notes.txt", content: "Keep" }, confirmed: true }), /cancelled/); assert.equal(forwarded.length, 1);
  assert.match(reviews[0].text, /notes.txt/); assert.match(reviews[0].text, /Keep/);
  approve = true; await call({ name: "write_file", args: { path: "notes.txt" }, confirmed: true }); assert.equal(forwarded.length, 2);
  onReview = () => registry.register({ name: "write_file", sensitive: true, egress: false, description: "Changed", handler: () => "different" });
  await assert.rejects(call({ name: "write_file", confirmed: true }), /configuration changed/); assert.equal(forwarded.length, 2);
  const controller = new AbortController(); onReview = () => controller.abort();
  await assert.rejects(call({ name: "write_file", confirmed: true }, controller.signal), /abort/i); assert.equal(forwarded.length, 2);
  await assert.rejects(original.call("assistant.request", { path: "/core/tools/call", method: "POST", bodyBase64: Buffer.from(JSON.stringify({ name: "write_file", confirmed: true })).toString("base64") }), /reviewable JSON/);
});
test("team sensitive-tool approval shows the actual bounded specification and task", async t => {
  const { ToolRegistry } = require("../lib/tools"), registry = new ToolRegistry({ privacyMode: () => "local-only" });
  registry.register({ name: "write_file", sensitive: true, egress: false, handler: () => "ok" });
  let reviewed, forwarded;
  const api = require("../../electron/plugin-services/assistant-original").create({ core: { gateway: { tools: registry, teams: { templates: () => [{ id: "research", label: "Research", tools: ["write_file"] }] } } }, confirm: async (_title, detail) => { reviewed = JSON.parse(detail); return true; }, legacyRequest: async (_feature, input) => { forwarded = input; return { ok: true }; } }, {});
  t.after(() => api.dispose());
  await api.call("assistant.request", { path: "/core/teams/run", method: "POST", body: { template: "research", question: "Prepare the report", model: "local", allowSensitive: true } });
  assert.deepEqual(reviewed.tools, ["write_file"]); assert.equal(reviewed.task, "Prepare the report"); assert.equal(forwarded.body.allowSensitive, true);
});
test("copy actions use only bounded supplied text and never read the clipboard", async t => {
  const copied = [], api = require("../../electron/plugin-services/assistant-original").create({ electron: { clipboard: { writeText: text => copied.push(text) } } }, {});
  t.after(() => api.dispose());
  assert.equal((await api.call("assistant.copyText", { text: "Original answer" })).copied, true); assert.deepEqual(copied, ["Original answer"]);
  await assert.rejects(api.call("assistant.copyText", { text: "a".repeat(800001) }), /Invalid text/);
  await assert.rejects(api.call("assistant.copyText", { text: "answer", read: true }), /Invalid text/);
});
