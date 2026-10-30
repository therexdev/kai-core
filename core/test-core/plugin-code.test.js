"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { create, relativePath } = require("../../electron/plugin-services/code");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-code-plugin-")), dataDir = path.join(root, "profile", "core"), project = path.join(root, "project"), confirms = [];
  fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(project); fs.writeFileSync(path.join(project, "app.js"), 'const answer = 1;\n');
  const ctx = { dataDir, core: {}, electron: { dialog: { async showOpenDialog() { return { canceled: false, filePaths: [project] }; } } }, getWindow: () => ({}),
    async confirm(title, detail) { confirms.push({ title, detail }); return true; }, async localInference() { return { text: JSON.stringify({ summary: "Update answer", content: 'const answer = 2;\n' }) }; } };
  const service = create(ctx); t.after(() => { service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dataDir, project, ctx, service, confirms, call: (method, input, signal) => service.call(method, input, signal) };
}
async function opened(t) { const f = fixture(t), grant = await f.call("code.choose"), file = await f.call("code.read", { handle: grant.handle, path: "app.js" }); return { ...f, grant, file }; }
async function staged(t) { const f = await opened(t); const proposal = await f.call("code.stage", { handle: f.grant.handle, path: "app.js", hash: f.file.hash, content: 'const answer = 2;\n' }); return { ...f, proposal }; }
test("saved projects and sessions survive without file access grants", async t => {
  const f = fixture(t); f.service.dispose(); const legacy = [{ id: "old", name: "Old project", path: f.project, sessions: [{ id: "session", title: "Prior work", turns: [{ role: "user", content: "Keep this" }] }] }];
  const registry = path.join(f.dataDir, "code-projects.json"); fs.writeFileSync(registry, JSON.stringify(legacy)); const before = fs.readFileSync(registry, "utf8"), service = create(f.ctx); t.after(() => service.dispose());
  assert.equal((await service.call("code.projects")).projects[0].sessions, 1); assert.equal(fs.readFileSync(registry, "utf8"), before);
  await assert.rejects(service.call("code.read", { projectId: "old", path: "app.js" }), /grant access/);
  const grant = await service.call("code.open", { projectId: "old" }); assert.equal(f.confirms.length, 1);
  assert.equal((await service.call("code.session", { handle: grant.handle, sessionId: "session" })).turns[0].content, "Keep this");
});
test("unreadable legacy registry is never reset", t => { const f = fixture(t); fs.writeFileSync(path.join(f.dataDir, "code-projects.json"), "not json"); assert.throws(() => create(f.ctx), /preserved/); assert.equal(fs.readFileSync(path.join(f.dataDir, "code-projects.json"), "utf8"), "not json"); });
test("external registry edits are preserved and block stale project mutations", async t => {
  const f = await opened(t), registry = path.join(f.dataDir, "code-projects.json"), external = JSON.stringify([{ id: "external", path: f.project, name: "External change", sessions: [] }]);
  fs.writeFileSync(registry, external);
  await assert.rejects(f.call("code.choose"), /changed outside/); assert.equal(fs.readFileSync(registry, "utf8"), external);
});
test("profile or registry links cannot redirect coding data", t => {
  const f = fixture(t), linkedProfile = path.join(f.root, "linked-profile"), outside = path.join(f.root, "outside-registry.json"); fs.writeFileSync(outside, "[]");
  try { fs.symlinkSync(f.dataDir, linkedProfile, process.platform === "win32" ? "junction" : "dir"); } catch (e) { if (e.code === "EPERM") return t.skip("Symlink privilege unavailable"); throw e; }
  assert.throws(() => create({ ...f.ctx, dataDir: linkedProfile }), /real directory/);
  fs.symlinkSync(outside, path.join(f.dataDir, "code-projects.json")); assert.throws(() => create(f.ctx), /preserved/); assert.equal(fs.readFileSync(outside, "utf8"), "[]");
});
test("native selection is the only way to grant a new path", async t => {
  const f = await opened(t); assert.match(f.grant.handle, /^[a-f0-9-]+$/); assert.equal(f.file.content, 'const answer = 1;\n');
  await assert.rejects(f.call("code.read", { handle: "forged", path: "app.js" }), /grant access/);
  f.ctx.electron.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); assert.equal((await f.call("code.choose", { path: f.root })).cancelled, true);
});
test("traversal, absolute paths and credential names are denied", async t => {
  const f = await opened(t);
  for (const p of ["../app.js", "/etc/passwd", "C:\\private", "a/../../app.js", ".env", ".git/config", ".ssh/id_rsa", "wallet.json", "key.pem", "a\\b"]) {
    assert.throws(() => relativePath(p), /permitted/); await assert.rejects(f.call("code.read", { handle: f.grant.handle, path: p }));
  }
});
test("KAI private storage cannot be selected as a project", async t => {
  const f = fixture(t);
  for (const target of [f.dataDir, path.dirname(f.dataDir), f.root, os.homedir(), path.parse(f.root).root]) {
    f.ctx.electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); await assert.rejects(f.call("code.choose"), /private|specific/);
  }
});
test("selecting a credential directory directly does not bypass path protection", async t => {
  const f = fixture(t), privateFolder = path.join(f.root, ".aws"); fs.mkdirSync(privateFolder); fs.writeFileSync(path.join(privateFolder, "credentials"), "private");
  f.ctx.electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [privateFolder] }); await assert.rejects(f.call("code.choose"), /credential folders/);
});
test("browse and read refuse symlinks and hard-linked files", async t => {
  const f = await opened(t); fs.writeFileSync(path.join(f.root, "private.txt"), "private");
  try { fs.symlinkSync(f.root, path.join(f.project, "escape"), process.platform === "win32" ? "junction" : "dir"); } catch (e) { if (e.code === "EPERM") return t.skip("Symlink privilege unavailable"); throw e; }
  fs.linkSync(path.join(f.root, "private.txt"), path.join(f.project, "hard.txt"));
  const listing = await f.call("code.browse", { handle: f.grant.handle }); assert.ok(!listing.entries.some(e => e.name === "escape"));
  await assert.rejects(f.call("code.read", { handle: f.grant.handle, path: "escape/private.txt" }), /Symbolic/);
  await assert.rejects(f.call("code.read", { handle: f.grant.handle, path: "hard.txt" }), /Hard-linked/);
});
test("text reads refuse oversized or binary files", async t => { const f = await opened(t); for (const [name, bytes] of [["big.txt", Buffer.alloc(256 * 1024 + 1, 65)], ["binary.bin", Buffer.from([0, 1, 2])], ["invalid.txt", Buffer.from([255, 254])]]) { fs.writeFileSync(path.join(f.project, name), bytes); await assert.rejects(f.call("code.read", { handle: f.grant.handle, path: name })); } });
test("AI suggestions use only selected file and do not write without review", async t => {
  const f = await opened(t); let inference; f.ctx.localInference = async (input, signal) => { inference = input; return { text: '{"summary":"Update answer","content":"const answer = 2;\\n"}' }; };
  const proposal = await f.call("code.propose", { handle: f.grant.handle, path: "app.js", hash: f.file.hash, instruction: "Change answer to 2", model: "local" });
  assert.equal(inference.model, "local"); assert.match(inference.prompt, /Change answer to 2/); assert.match(proposal.diff, /-const answer = 1;/); assert.match(proposal.diff, /\+const answer = 2;/);
  assert.equal(fs.readFileSync(path.join(f.project, "app.js"), "utf8"), f.file.content); assert.equal(f.confirms.length, 0);
  assert.equal((await f.call("code.sessions", { handle: f.grant.handle })).sessions.length, 1);
});
test("applying reviews exact diff and saves only the selected file", async t => {
  const f = await staged(t), result = await f.call("code.apply", { proposalId: f.proposal.id, content: "ignored injection" });
  assert.equal(result.applied, true); assert.equal(fs.readFileSync(path.join(f.project, "app.js"), "utf8"), 'const answer = 2;\n');
  assert.equal(f.confirms.length, 1); assert.match(f.confirms[0].detail, /-const answer = 1;/); assert.match(f.confirms[0].detail, /\+const answer = 2;/);
  await assert.rejects(f.call("code.apply", { proposalId: f.proposal.id }), /expired/);
});
test("declining native approval leaves disk unchanged", async t => { const f = await staged(t); f.ctx.confirm = async () => false; assert.equal((await f.call("code.apply", { proposalId: f.proposal.id })).applied, false); assert.equal(fs.readFileSync(path.join(f.project, "app.js"), "utf8"), f.file.content); });
test("edits made after staging or during native review are preserved", async t => {
  const f = await staged(t); fs.writeFileSync(path.join(f.project, "app.js"), "another editor\n"); await assert.rejects(f.call("code.apply", { proposalId: f.proposal.id }), /File changed/); assert.equal(f.confirms.length, 0);
  const current = await f.call("code.read", { handle: f.grant.handle, path: "app.js" }), second = await f.call("code.stage", { handle: f.grant.handle, path: "app.js", hash: current.hash, content: "proposal\n" });
  f.ctx.confirm = async () => { fs.writeFileSync(path.join(f.project, "app.js"), "changed during review\n"); return true; };
  await assert.rejects(f.call("code.apply", { proposalId: second.id }), /File changed/); assert.equal(fs.readFileSync(path.join(f.project, "app.js"), "utf8"), "changed during review\n");
});
test("revocation during native review prevents writing", async t => { const f = await staged(t); f.ctx.confirm = async () => { await f.call("code.revoke", { handle: f.grant.handle }); return true; }; await assert.rejects(f.call("code.apply", { proposalId: f.proposal.id }), /grant access/); assert.equal(fs.readFileSync(path.join(f.project, "app.js"), "utf8"), f.file.content); });
test("registry replacement during native review prevents applying an obsolete session", async t => {
  const f = await staged(t); f.ctx.confirm = async () => { fs.writeFileSync(path.join(f.dataDir, "code-projects.json"), "[]"); return true; };
  await assert.rejects(f.call("code.apply", { proposalId: f.proposal.id }), /changed outside/); assert.equal(fs.readFileSync(path.join(f.project, "app.js"), "utf8"), f.file.content);
});
test("abort or closing the plugin during review prevents writing", async t => {
  const f = await staged(t), controller = new AbortController(); f.ctx.confirm = async () => { controller.abort(); return true; };
  await assert.rejects(f.call("code.apply", { proposalId: f.proposal.id }, controller.signal)); assert.equal(fs.readFileSync(path.join(f.project, "app.js"), "utf8"), f.file.content);
  f.ctx.confirm = async () => { f.service.dispose(); return true; }; await assert.rejects(f.call("code.apply", { proposalId: f.proposal.id }), /closed/);
});
test("project replacement invalidates its existing grant", async t => { const f = await opened(t); fs.renameSync(f.project, f.project + "-old"); fs.mkdirSync(f.project); fs.writeFileSync(path.join(f.project, "app.js"), "replacement"); await assert.rejects(f.call("code.read", { handle: f.grant.handle, path: "app.js" }), /folder changed/); });
