"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { ChatStore } = require("../lib/chats"), service = require("../../electron/plugin-services/assistant");
function fixture(t, confirm = async () => true) { const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-assistant-")), chats = new ChatStore(path.join(dataDir, "chats")); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true })); return { dataDir, chats, api: service.create({ dataDir, core: { gateway: { chats } }, confirm }) }; }
test("Assistant saves into the shared ChatStore and reopens the same messages", async t => {
  const { api, chats } = fixture(t); const messages = [{ role: "user", content: "Hello" }];
  const saved = await api.call("assistant.save", { messages }); assert.equal(chats.get(saved.id).messages[0].content, "Hello");
  const loaded = await api.call("assistant.get", saved); assert.equal(loaded.revision, saved.revision);
  messages.push({ role: "assistant", content: "Local reply" }); await api.call("assistant.save", { ...saved, messages });
  const list = await api.call("assistant.list"); assert.equal(list.chats[0].messages, 2); assert.deepEqual(list.warnings, []);
});
test("legacy citations, images, flags and unknown metadata survive append and rename", async t => {
  const { api, chats } = fixture(t); const { id } = chats.save({ messages: [{ role: "user", content: "Existing", images: ["data:image/png;base64,AA=="], citations: [{ title: "Example", url: "https://example.com" }] }], system: "Speak clearly", persona: "writer" });
  const target = chats._file(id), legacy = chats.get(id); legacy.future = { retained: true }; legacy.pinned = true; fs.writeFileSync(target, JSON.stringify(legacy));
  const opened = await api.call("assistant.get", { id }); assert.equal(opened.messages[0].attachments, 1); assert.equal(opened.messages[0].images, undefined);
  const next = await api.call("assistant.save", { id, revision: opened.revision, messages: [...opened.messages, { role: "assistant", content: "Added" }] });
  const renamed = await api.call("assistant.rename", { ...next, title: "My title" }); await api.call("assistant.pin", { ...renamed, pinned: false });
  const actual = chats.get(id); assert.deepEqual(actual.messages[0], legacy.messages[0]); assert.deepEqual(actual.future, legacy.future); assert.equal(actual.system, legacy.system); assert.equal(actual.title, "My title"); assert.equal(actual.renamed, true); assert.equal(actual.pinned, false);
});
test("stale revisions and modified history cannot overwrite an existing conversation", async t => {
  const { api, chats } = fixture(t); const messages = [{ role: "user", content: "Original" }], first = await api.call("assistant.save", { messages });
  const second = await api.call("assistant.rename", { ...first, title: "Renamed" });
  await assert.rejects(api.call("assistant.save", { ...first, messages }), /changed elsewhere/);
  await assert.rejects(api.call("assistant.save", { ...second, messages: [{ role: "user", content: "Altered" }] }), /cannot be replaced/);
  assert.equal(chats.get(first.id).messages[0].content, "Original");
});
test("corrupt history is reported and cannot be silently replaced", async t => {
  const { api, chats } = fixture(t); fs.mkdirSync(chats.dir); fs.writeFileSync(chats._file("broken"), "{broken");
  const result = await api.call("assistant.list"); assert.equal(result.chats.length, 0); assert.match(result.warnings[0], /preserved/);
  await assert.rejects(api.call("assistant.save", { id: "broken", revision: "x", messages: [{ role: "user", content: "Replacement" }] }), /unreadable/);
  assert.equal(fs.readFileSync(chats._file("broken"), "utf8"), "{broken");
});
test("symlinked chat directories and files cannot expose other local files", async t => {
  const { api, chats, dataDir } = fixture(t); const outside = path.join(dataDir, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "private.json"), JSON.stringify({ id: "private", messages: [{ role: "user", content: "SECRET" }] }));
  try { fs.symlinkSync(outside, chats.dir, process.platform === "win32" ? "junction" : "dir"); } catch (error) { if (error.code === "EPERM") return t.skip("Symlink privilege unavailable"); throw error; }
  await assert.rejects(api.call("assistant.list"), /symbolic link/); fs.unlinkSync(chats.dir); fs.mkdirSync(chats.dir);
  try { fs.symlinkSync(path.join(outside, "private.json"), chats._file("private")); } catch (error) { if (error.code === "EPERM") return t.skip("File symlink privilege unavailable"); throw error; }
  await assert.rejects(api.call("assistant.get", { id: "private" }), /regular file/); assert.equal((await api.call("assistant.list")).chats.length, 0);
  await assert.rejects(api.call("assistant.get", { id: "../outside/private" }), /Invalid conversation id/);
});
test("delete honors cancellation and checks concurrent edits after native confirmation", async t => {
  let allow = false, during; const { api, chats } = fixture(t, async () => { during?.(); return allow; });
  const saved = await api.call("assistant.save", { messages: [{ role: "user", content: "Keep me" }] });
  assert.deepEqual(await api.call("assistant.delete", saved), { deleted: false }); assert.equal(chats.get(saved.id).messages.length, 1);
  allow = true; during = () => chats.rename(saved.id, "Changed while waiting"); await assert.rejects(api.call("assistant.delete", saved), /changed while confirmation/);
  during = null; const latest = await api.call("assistant.get", saved); assert.deepEqual(await api.call("assistant.delete", latest), { deleted: true });
  assert.equal(fs.existsSync(chats._file(saved.id)), false);
});
test("unrecognized methods, unsafe requests and aborted work are denied", async t => {
  const { api } = fixture(t); await assert.rejects(api.call("wallet.read", {}), /Unknown/); await assert.rejects(api.call("assistant.save", { messages: [{ role: "user", content: {} }] }), /bounded text/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(api.call("assistant.list", {}, controller.signal), /abort/i);
});
