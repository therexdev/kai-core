"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { signingPayload, verifyPackage, safeFile, BINARY } = require("../lib/plugins/package");
const { PluginManager } = require("../lib/plugins/manager");
const { FoundationPluginServices, loadNative } = require("../../electron/foundation-plugin-services");
function key() { return crypto.generateKeyPairSync("ed25519"); }
function pkg({ id = "example.test", runtime = "native", source = "exports.create = api => ({call: async (method, input) => ({method,input,id:api.plugin.id})});", manifest = {}, files = {}, keys = key() } = {}) {
  const m = { schema: 2, apiVersion: 3, id, version: "1.0.0", name: "Test plugin", entry: "index.html", runtime, permissions: runtime === "native" ? ["native.execute"] : [], provides: [], consumes: [], ...(runtime === "native" ? { service: "service/index.js" } : {}), ...manifest };
  const contents = { "index.html": "<!doctype html><title>Test</title>", ...(runtime === "native" ? { "service/index.js": source } : {}), ...files };
  return { manifest: m, files: contents, publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), signature: crypto.sign(null, Buffer.from(signingPayload(m, contents)), keys.privateKey).toString("base64") };
}
function workspace(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-foundation-plugins-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function fixture(t, definitions, createApi = () => ({})) {
  const manager = new PluginManager(workspace(t)); for (const item of definitions) manager.install(item, { trustNative: true });
  const services = new FoundationPluginServices({ manager, createApi }); t.after(() => services.dispose().catch(() => {}));
  const renderer = id => ({ ...manager.load(id), controller: new AbortController() });
  return { manager, services, renderer };
}

test("every publisher can declare the same native runtime and public capabilities", () => {
  for (const id of ["community.tools", "kai.brain"]) assert.equal(verifyPackage(pkg({ id, manifest: { permissions: ["native.execute", "services.call", "models.read"] } })).manifest.id, id);
  assert.equal(verifyPackage(pkg({ runtime: "sandboxed" })).manifest.runtime, "sandboxed");
});
test("old package manifests and undeclared runtime trust are rejected", () => {
  assert.throws(() => verifyPackage(pkg({ manifest: { schema: 1, apiVersion: 2 } })), /schema 2/);
  assert.throws(() => verifyPackage(pkg({ manifest: { permissions: [] } })), /native.execute/);
  assert.throws(() => verifyPackage(pkg({ runtime: "sandboxed", manifest: { service: "service/index.js" } })), /cannot load/);
  assert.throws(() => verifyPackage(pkg({ manifest: { permissions: ["native.execute", "brain.read"] } })), /permissions/);
});
test("native files, scoped dependencies and canonical binary data are signed", () => {
  assert(safeFile("service/node_modules/@scope/lib/index.cjs")); assert(safeFile("service/native/lib.so.1.2.3")); assert(BINARY.test("service/engine.wasm"));
  const signed = pkg({ files: { "service/engine.wasm": "YWJj", "service/node_modules/@scope/lib/index.cjs": "module.exports=1" } });
  verifyPackage(signed); signed.files["service/engine.wasm"] = "YWJk"; assert.throws(() => verifyPackage(signed), /signature/);
  assert.throws(() => verifyPackage(pkg({ files: { "service/engine.wasm": "abc" } })), /base64/);
});
test("unsafe, colliding and missing package files are rejected", () => {
  for (const file of ["../x.js", "service/../x.js", "C:/x.js", "service/CON.js", "service/file.js ", "service/a\\b.js"]) assert(!safeFile(file), file);
  assert.throws(() => verifyPackage(pkg({ files: { "INDEX.html": "collision" } })), /duplicate/);
  assert.throws(() => verifyPackage(pkg({ files: { "service/folder.js": "x", "service/folder.js/a.js": "y" } })), /Conflicting/);
  assert.throws(() => verifyPackage(pkg({ manifest: { service: "missing.js" } })), /missing/);
});
test("native install requires review and remembers exact bytes, approval and signer", t => {
  const manager = new PluginManager(workspace(t)), signed = pkg();
  assert.throws(() => manager.install(signed), /approval/); manager.install(signed, { trustNative: true });
  assert.equal(manager.load("example.test").manifest.runtime, "native");
  assert.throws(() => manager.install(pkg(), { trustNative: true }), /Publisher changed/);
  manager.state.installed["example.test"].nativeApproved = false; assert.throws(() => manager.load("example.test"), /approval changed/);
});
test("exact approved package digest prevents same-key same-version substitutions", t => {
  const manager = new PluginManager(workspace(t)), keys = key(), signed = pkg({ keys }); manager.install(signed, { trustNative: true });
  const record = manager.state.installed["example.test"];
  fs.writeFileSync(path.join(manager.pluginDir("example.test"), record.file), JSON.stringify(pkg({ keys, source: "exports.create=()=>({call:()=> 'changed'})" })));
  assert.throws(() => manager.load("example.test"), /code or approval changed/);
});
test("extraction verifies every byte and rejects extra files or symlinks", t => {
  const manager = new PluginManager(workspace(t)); manager.install(pkg(), { trustNative: true });
  const installed = manager.materialize("example.test"), source = path.join(installed.root, "service/index.js");
  assert.equal(fs.readFileSync(source, "utf8"), installed.package.files["service/index.js"]);
  fs.chmodSync(source, 0o600); fs.writeFileSync(source, "changed"); assert.throws(() => manager.materialize("example.test"), /modified/);
  fs.writeFileSync(source, installed.package.files["service/index.js"]); fs.writeFileSync(path.join(installed.root, "extra.js"), "x"); assert.throws(() => manager.materialize("example.test"), /unverified/);
});
test("plugin state is scoped and retained on remove without publisher takeover", t => {
  const manager = new PluginManager(workspace(t)), first = pkg(), second = pkg({ id: "example.other" });
  manager.install(first, { trustNative: true }); manager.install(second, { trustNative: true }); manager.storage("example.test", "set", "item", "private");
  assert.equal(manager.storage("example.other", "get", "item"), null); manager.change("example.test", "remove");
  assert.throws(() => manager.install(pkg(), { trustNative: true }), /Publisher changed/); manager.install(first, { trustNative: true }); assert.equal(manager.storage("example.test", "get", "item"), "private");
});
test("native dependencies resolve inside the signed package, plus platform builtins", t => {
  const root = workspace(t), outside = path.join(root, "outside.js"), plugin = path.join(root, "plugin"); fs.mkdirSync(plugin); fs.writeFileSync(outside, "module.exports=42");
  const entry = path.join(plugin, "index.js"); fs.writeFileSync(entry, "module.exports={path:require('node:path').sep, child:require('./child.js')}"); fs.writeFileSync(path.join(plugin, "child.js"), "module.exports=12");
  const loaded = loadNative(entry, plugin); assert.equal(loaded.exports.child, 12); loaded.dispose();
  fs.writeFileSync(entry, "module.exports=require('../outside.js')"); assert.throws(() => loadNative(entry, plugin), /must be bundled/);
});
test("one service instance survives view detachment and stops on disable", async t => {
  let created = 0, disposed = 0;
  const { manager, services, renderer } = fixture(t, [pkg({ source: "exports.create=api=>{api.mark('create');return{call:()=>api.plugin.id,dispose:()=>api.mark('dispose')}}" })], () => ({ mark(event) { event === "create" ? created++ : disposed++; } }));
  assert.equal(await services.call(renderer("example.test"), "test.run", {}), "example.test");
  await services.detachWindow("example.test"); await services.call(renderer("example.test"), "test.run", {}); assert.equal(created, 1);
  await services.close("example.test"); manager.change("example.test", "disable"); assert.equal(disposed, 1); await assert.rejects(services.ensure("example.test"), /disabled/);
});
test("cross-plugin services require declared consumers and providers, and carry caller identity", async t => {
  const provider = pkg({ id: "example.provider", manifest: { permissions: ["native.execute", "services.provide"], provides: ["example.service"] }, source: "exports.create=api=>{api.services.provide('example.service',{methods:['echo'],call:(method,input,context)=>({input,caller:context.caller,remote:context.remote})});return{call:()=>null}}" });
  const consumer = pkg({ id: "example.consumer", manifest: { permissions: ["native.execute", "services.call"], consumes: ["example.service"] }, source: "exports.create=api=>({call:(method,input)=>api.services.call('example.service','echo',input)})" });
  const { services, renderer } = fixture(t, [provider, consumer]);
  assert.deepEqual(await services.call(renderer("example.consumer"), "test.call", { value: 7 }), { input: { value: 7 }, caller: "example.consumer", remote: false });
});
test("remote or forged service contexts are rejected and revocation removes exports", async t => {
  const consumer = pkg({ manifest: { permissions: ["native.execute", "services.call"], consumes: ["example.service"] }, source: "exports.create=api=>({call:()=>api.services.call('example.service','echo',{}, {remote:true})})" });
  const { services, renderer } = fixture(t, [consumer]); await assert.rejects(services.call(renderer("example.test"), "test.call", {}), /Remote or delegated/);
});
test("startup failure revokes exports and cleans created resources", async t => {
  let cleaned = 0;
  const { services } = fixture(t, [pkg({ source: "exports.create=()=>{throw Error('factory failed')}" })], () => ({ dispose() { cleaned++; } }));
  await assert.rejects(services.ensure("example.test"), /factory failed/); assert.equal(cleaned, 1); assert.equal(services.records.size, 0);
});
test("failed stop remains revoked and blocks a replacement until cleanup succeeds", async t => {
  let stopCount = 0;
  const { services } = fixture(t, [pkg({ source: "exports.create=api=>({call:()=>1,dispose:()=>api.stop()})" })], () => ({ stop() { if (++stopCount === 1) throw Error("child still running"); } }));
  await services.ensure("example.test"); await assert.rejects(services.close("example.test"), /could not completely stop/);
  await assert.rejects(services.ensure("example.test"), /closing/); await services.close("example.test"); assert.equal(services.records.size, 0); assert.equal(stopCount, 2);
});

test("verified snapshots cannot be mutated through the review input",()=>{
  const source=pkg(),verified=verifyPackage(source);source.manifest.permissions.push("wallet.authorize");source.files["service/index.js"]="tampered";
  assert.deepEqual(verified.manifest.permissions,["native.execute"]);assert.notEqual(verified.package.files["service/index.js"],"tampered");assert.throws(()=>verified.manifest.permissions.push("wallet.authorize"),TypeError);
});
test("digest-table signature binds decoded bytes, lengths, encoding and manifest",()=>{
  const signed=pkg({files:{"service/payload.bin":"YQ=="}});verifyPackage(signed);
  assert.throws(()=>verifyPackage(pkg({files:{"service/payload.bin":"YR=="}})),/base64/);
  signed.manifest.name="Changed";assert.throws(()=>verifyPackage(signed),/signature/);
});
test("streamed package serialization preserves Unicode and refuses overwriting existing files",t=>{
  const {writePackageFile}=require("../lib/plugins/package-io"),file=path.join(workspace(t),"package.json"),signed=pkg({files:{"unicode.txt":"a".repeat(262143)+"🦊\n\"\\","service/payload.bin":"YWJj"}});
  const verified=verifyPackage(signed);writePackageFile(file,verified.package);assert.equal(verifyPackage(fs.readFileSync(file,"utf8")).digest,verified.digest);
  assert.throws(()=>writePackageFile(file,verified.package),/EEXIST/);assert.equal(verifyPackage(fs.readFileSync(file,"utf8")).digest,verified.digest);
});

test("background activation and verified snapshots are reused within one lifetime",async t=>{
  let starts=0;const {manager,services,renderer}=fixture(t,[pkg({source:"exports.create=api=>({call:()=>true,startBackground:()=>api.started()})"})],()=>({started(){starts++;}}));
  const view=renderer("example.test");let loads=0;const original=manager.load.bind(manager);manager.load=id=>{loads++;return original(id);};
  await Promise.all([services.startInstalledBackground(),services.startInstalledBackground()]);assert.equal(starts,1);assert.equal(loads,1);
  for(let i=0;i<5;i++)assert.equal(await services.call(view,"example.call",{}),true);assert.equal(loads,1);
  const verified=await services.verifiedForUI("example.test");assert.equal(verified,services.records.get("example.test"));
  await services.close("example.test");await services.ensure("example.test");assert.equal(loads,2);
});


test("updates and rollback keep one data directory while code snapshots remain immutable", t => {
  const manager = new PluginManager(workspace(t)), keys = key();
  manager.install(pkg({ keys }), { trustNative: true });
  const first = manager.materialize("example.test"), data = manager.dataDir("example.test");
  manager.storage("example.test", "set", "saved", { keep: "existing feature data" });
  manager.install(pkg({ keys, manifest: { version: "1.0.1" }, source: "exports.create=()=>({call:()=> 'updated'});" }), { trustNative: true });
  const next = manager.materialize("example.test");
  assert.equal(next.dataDir, data); assert.notEqual(next.root, first.root);
  assert.equal(fs.statSync(path.join(first.root, "service/index.js")).mode & 0o200, 0);
  assert.equal(fs.statSync(path.join(next.root, "service/index.js")).mode & 0o200, 0);
  assert.deepEqual(manager.storage("example.test", "get", "saved"), { keep: "existing feature data" });
  manager.change("example.test", "rollback");
  const restored = manager.materialize("example.test");
  assert.equal(restored.root, first.root); assert.equal(restored.dataDir, data);
  assert.deepEqual(manager.storage("example.test", "get", "saved"), { keep: "existing feature data" });
});
