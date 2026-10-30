"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), { EventEmitter } = require("node:events");
const { verifyPackage, canonical, safeId, safeFile, MAX_BYTES } = require("../lib/plugins/package");
const { PluginManager } = require("../lib/plugins/manager");
const { downloadPackage } = require("../lib/plugins/download");
const { PluginHost, CSP } = require("../../electron/core-plugin-host");
const keys = crypto.generateKeyPairSync("ed25519");
function pkg({ key = keys.privateKey, id = "example.test", version = "1.0.0", permissions = ["models.read", "storage.read", "storage.write"], files = { "index.html": "<h1>Hello</h1>" }, ...manifest } = {}) {
  const result = { manifest: { schema: 1, apiVersion: 1, id, version, name: "Example", entry: "index.html", permissions, ...manifest }, files,
    publicKey: crypto.createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64") };
  result.signature = crypto.sign(null, Buffer.from(canonical({ manifest: result.manifest, files })), key).toString("base64"); return result;
}
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-plugin-security-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { root, manager: new PluginManager(root) }; }
test("only well-formed signed compatible packages are accepted", () => {
  assert.equal(verifyPackage(pkg()).manifest.id, "example.test");
  for (const changes of [{ apiVersion: 2 }, { schema: 2 }, { version: ["1.0.0"] }, { version: "01.0.0" }, { version: "1.0.0-rc.1" }, { permissions: ["wallet.sign"] }, { permissions: ["models.read", "models.read"] }, { entry: "missing.html" }, { unexpected: true }]) assert.throws(() => verifyPackage(pkg(changes)));
  const altered = pkg(); altered.files["index.html"] += "tampered"; assert.throws(() => verifyPackage(altered), /signature/);
  const changedManifest = pkg(); changedManifest.manifest.permissions.push("inference.local"); assert.throws(() => verifyPackage(changedManifest), /signature/);
  const unsigned = pkg(); unsigned.signature = ""; assert.throws(() => verifyPackage(unsigned), /signature/);
  assert.throws(() => verifyPackage(pkg({ files: { "index.html": "x".repeat(MAX_BYTES) } })), /5 MB/);
});
test("plugin paths reject traversal, platform device names and case collisions", () => {
  for (const id of ["../escape", "one", "a..b", "CON.plugin", "nul.package", "foo/bar", "example:", "example.test "]) assert.equal(safeId(id), false, id);
  for (const file of ["../index.html", "/index.html", "a/../index.html", "a\\index.html", "a:N.html", "a/con.html", "a./index.html", "a//index.html", "nul.txt", "data.exe"]) assert.equal(safeFile(file), false, file);
  assert.throws(() => verifyPackage(pkg({ files: { "index.html": "x", "INDEX.html": "y" } })), /duplicate/);
});
test("package signer persists across uninstall and reinstall, protecting retained data", t => {
  const { manager, root } = fixture(t); manager.install(pkg()); manager.storage("example.test", "set", "secret", "saved private data"); manager.change("example.test", "remove");
  const reopened = new PluginManager(root), other = crypto.generateKeyPairSync("ed25519");
  assert.throws(() => reopened.install(pkg({ key: other.privateKey })), /Publisher changed/);
  reopened.install(pkg()); assert.equal(reopened.storage("example.test", "get", "secret"), "saved private data");
});
test("installation revalidates signatures and loading detects disk tampering", t => {
  const { manager } = fixture(t); manager.install(pkg());
  const file = path.join(manager.pluginDir("example.test"), manager.state.installed["example.test"].file);
  const altered = JSON.parse(fs.readFileSync(file)); altered.files["index.html"] = "malicious"; fs.writeFileSync(file, JSON.stringify(altered));
  assert.throws(() => manager.load("example.test"), /signature/);
});
test("installation rejects publisher change while installed", t => { const { manager } = fixture(t); manager.install(pkg()); const other = crypto.generateKeyPairSync("ed25519"); assert.throws(() => manager.install(pkg({ key: other.privateKey })), /Publisher changed/); });
test("rollback restores prior signed permissions and preserves private data", t => {
  const { manager } = fixture(t); manager.install(pkg()); manager.storage("example.test", "set", "draft", "first draft");
  manager.install(pkg({ version: "2.0.0", permissions: ["models.read", "inference.local"] }));
  assert.equal(manager.load("example.test").manifest.version, "2.0.0"); manager.change("example.test", "rollback");
  assert.equal(manager.load("example.test").manifest.version, "1.0.0"); assert.equal(manager.load("example.test").manifest.permissions.includes("inference.local"), false);
  assert.equal(manager.storage("example.test", "get", "draft"), "first draft");
  manager.change("example.test", "disable"); assert.throws(() => manager.load("example.test"), /disabled/); manager.change("example.test", "enable"); assert.equal(manager.load("example.test").manifest.version, "1.0.0");
});
test("plugin storage is scoped, bounded and refuses prototype keys", t => {
  const { manager } = fixture(t); manager.install(pkg()); manager.install(pkg({ id: "other.test" }));
  manager.storage("example.test", "set", "draft", { text: "private" }); assert.equal(manager.storage("other.test", "get", "draft"), null);
  for (const key of ["__proto__", "constructor", "prototype", "../wallet", "a/b"]) assert.throws(() => manager.storage("example.test", "set", key, "x"), /key/);
  assert.throws(() => manager.storage("example.test", "set", "large", "x".repeat(1024 * 1024)), /limit/);
  for (let i = 0; i < 31; i++) manager.storage("example.test", "set", "item" + i, i);
  assert.throws(() => manager.storage("example.test", "set", "extra", 33), /limit/);
});
test("symlinked plugin directories cannot redirect writes outside plugin storage", t => {
  const { root, manager } = fixture(t); const outside = path.join(root, "outside"); fs.mkdirSync(outside);
  try { fs.symlinkSync(outside, path.join(manager.root, "example.test"), process.platform === "win32" ? "junction" : "dir"); } catch (e) { if (e.code === "EPERM") return t.skip("Symlink privilege unavailable"); throw e; }
  assert.throws(() => manager.install(pkg()), /symbolic link/); assert.deepEqual(fs.readdirSync(outside), []);
});
test("invalid persisted plugin state is refused rather than reset", t => {
  const { root, manager } = fixture(t); fs.writeFileSync(manager.stateFile, '{"schema":1,"installed":{},"publishers":[]}'); assert.throws(() => new PluginManager(root), /publisher/);
});
test("plugin downloads pin DNS answers and verify fetched signatures", async () => {
  const calls = [], body = JSON.stringify(pkg());
  const result = await downloadPackage("https://plugins.example/release.kaiplugin", { lookup: async () => [{ address: "8.8.8.8", family: 4 }], request: async (url, options) => { calls.push({ url, options }); return new Response(body); } });
  assert.equal(result.manifest.id, "example.test"); assert.deepEqual(calls[0].options.addresses, [{ address: "8.8.8.8", family: 4 }]);
});
test("plugin downloads reject local, credentialed, non-HTTPS and rebound targets", async () => {
  const options = { lookup: async () => [{ address: "127.0.0.1", family: 4 }], request: async () => { throw Error("Request must never execute"); } };
  for (const url of ["http://example.com/x", "https://u:p@example.com/x", "https://example.com:123/x", "https://127.0.0.1/x", "https://[::1]/x", "https://example.com/x"]) await assert.rejects(downloadPackage(url, options), /HTTPS|public|private/);
});
test("redirects cannot switch downloads to private hosts", async () => {
  let requests = 0;
  await assert.rejects(downloadPackage("https://plugins.example/p", { lookup: async () => [{ address: "8.8.8.8", family: 4 }], request: async () => { requests++; return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } }); } }), /public/);
  assert.equal(requests, 1);
});
test("download byte limits apply while streaming", async () => {
  await assert.rejects(downloadPackage("https://plugins.example/p", { lookup: async () => [{ address: "8.8.8.8", family: 4 }], request: async () => new Response("x".repeat(MAX_BYTES + 1)) }), /5 MB/);
});
function hostFixture(t, permissions) {
  const { manager } = fixture(t); manager.install(pkg({ permissions })); const handlers = new Map(), sessions = [];
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: "" }; this.webContents.setWindowOpenHandler = fn => { this.popup = fn; }; this.webContents.setWebRTCIPHandlingPolicy = policy => { this.rtc = policy; }; }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
    show() {} focus() {} destroy() { this.emit("closed"); }
  }
  const electron = { BrowserWindow: Window, ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, session: { fromPartition: partition => {
    const session = new EventEmitter(); session.partition = partition; session.setPermissionRequestHandler = fn => { session.requestPermission = fn; }; session.setPermissionCheckHandler = fn => { session.checkPermission = fn; };
    session.webRequest = { onBeforeRequest: fn => { session.filter = fn; } }; session.protocol = { handle: (_scheme, fn) => { session.handler = fn; }, unhandle() {} }; session.clearStorageData = async () => {}; sessions.push(session); return session;
  } } };
  const core = { models: { aliases: () => [{ alias: "local", label: "Local", status: "ready", path: "/private/model.gguf" }] }, gateway: { port: 41100 } };
  return { manager, host: new PluginHost({ electron, manager, core }), sessions, handlers };
}
async function opened(t, permissions) { const f = hostFixture(t, permissions); await f.host.open("example.test"); const record = f.host.windows.get("example.test"), event = { sender: record.window.webContents, senderFrame: record.window.webContents.mainFrame }; t.after(() => f.host.closeAll()); return { ...f, record, event }; }
test("plugin windows use sandboxed isolated sessions and block HTTP, file and popups", async t => {
  const { sessions, record } = await opened(t, []); const preferences = record.window.options.webPreferences;
  assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.webSecurity, true);
  assert.equal(record.window.rtc, "disable_non_proxied_udp"); assert.equal(record.window.popup().action, "deny"); assert.equal(sessions[0].checkPermission(), false);
  for (const url of ["https://example.com", "http://127.0.0.1:41100/core/health", "file:///etc/passwd", "kai-plugin://other.test/index.html"]) sessions[0].filter({ url }, result => assert.equal(result.cancel, true));
  sessions[0].filter({ url: record.entry }, result => assert.equal(result.cancel, false));
  const response = sessions[0].handler({ url: record.entry, method: "GET" }); assert.equal(response.headers.get("content-security-policy"), CSP); assert.equal(await response.text(), "<h1>Hello</h1>");
  assert.equal(sessions[0].handler({ url: "kai-plugin://example.test/%", method: "GET" }).status, 400);
});
test("IPC authorizes exact plugin sender, main frame, entry and grant", async t => {
  const { host, event, record } = await opened(t, ["models.read"]);
  assert.deepEqual(await host.call(event, "models.list"), [{ alias: "local", label: "Local", status: "ready" }]);
  await assert.rejects(host.call({ ...event, senderFrame: { url: record.entry } }, "models.list"), /caller denied/);
  await assert.rejects(host.call({ ...event, sender: {} }, "models.list"), /caller denied/);
  for (const method of ["wallet.sign", "storage.get", "__proto__", "inference.local"]) await assert.rejects(host.call(event, method), /permission/);
  record.window.webContents.mainFrame.url += "?forged"; await assert.rejects(host.call(event, "models.list"), /caller denied/);
});
test("broker refuses disabled plugins and rate limits repeated calls", async t => {
  const { host, manager, event } = await opened(t, ["models.read"]);
  for (let i = 0; i < 30; i++) await host.call(event, "models.list");
  await assert.rejects(host.call(event, "models.list"), /rate/);
  host.windows.get("example.test").calls = []; manager.change("example.test", "disable"); await assert.rejects(host.call(event, "models.list"), /disabled/);
});
test("broker storage namespace comes from the caller, never caller input", async t => {
  const { host, manager, event } = await opened(t, ["storage.read", "storage.write"]); manager.install(pkg({ id: "other.test" }));
  await host.call(event, "storage.set", { id: "other.test", key: "draft", value: "mine" });
  assert.equal(manager.storage("other.test", "get", "draft"), null); assert.equal(await host.call(event, "storage.get", { key: "draft" }), "mine");
});
test("local inference enforces installed models, bounds, no network fallback, cancellation", async t => {
  const { host, event, record } = await opened(t, ["inference.local"]);
  await assert.rejects(host.call(event, "inference.local", { model: "network", prompt: "hi" }), /installed local/);
  await assert.rejects(host.call(event, "inference.local", { model: "local", prompt: "hi", maxTokens: 4097 }), /output limit/);
  const original = global.fetch; t.after(() => { global.fetch = original; }); let request;
  global.fetch = async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] })); };
  assert.deepEqual(await host.call(event, "inference.local", { model: "local", prompt: "hi" }), { text: "answer" });
  const body = JSON.parse(request.options.body); assert.equal(body.kai_private_desktop, true); assert.equal(body.stream, false); assert.equal(body.max_tokens, 1024); assert.equal(host.active, 0);
  global.fetch = async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Error("aborted")), { once: true }));
  const pending = host.call(event, "inference.local", { model: "local", prompt: "hi" });
  await assert.rejects(host.call(event, "inference.local", { model: "local", prompt: "hi" }), /busy/);
  record.window.destroy(); await assert.rejects(pending, /aborted/); assert.equal(host.active, 0);
});
