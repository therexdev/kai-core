"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { signingPayload, verifyPackage, BINARY } = require("../../core/lib/plugins/package");
for (const example of ["sandboxed-notes", "native-counter"]) test(`${example} is a complete valid package`, () => {
  const root = path.join(__dirname, "..", example), manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"))), files = {};
  function walk(dir, prefix = "") { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const file = prefix + item.name; if (!prefix && file === "manifest.json") continue; if (item.isDirectory()) walk(path.join(dir, item.name), file + "/"); else files[file] = fs.readFileSync(path.join(dir, item.name)).toString(BINARY.test(file) ? "base64" : "utf8"); } } walk(root);
  const key = crypto.generateKeyPairSync("ed25519");
  const pkg = { manifest, files, publicKey: key.publicKey.export({ type: "spki", format: "der" }).toString("base64"), signature: crypto.sign(null, Buffer.from(signingPayload(manifest, files)), key.privateKey).toString("base64") };
  assert.equal(verifyPackage(pkg).manifest.id, manifest.id);
  for (const [, asset] of files[manifest.entry].matchAll(/(?:src|href)="([^"]+)"/g)) assert.ok(Object.hasOwn(files, asset), asset);
  assert.doesNotMatch(files[manifest.entry], /\bon\w+\s*=|<script(?! src=)|style=/i);
});
test("native example owns state, exports only reads and revokes cleanly", () => {
  const state = new Map(), abort = new AbortController(); let provided, removed = false;
  const api = { version: 1, signal: abort.signal, settings: { get: (key, fallback) => state.has(key) ? state.get(key) : fallback, set: (key, value) => state.set(key, value) }, services: { provide: (_name, definition) => { provided = definition; return () => { removed = true; }; } } };
  const service = require("../native-counter/service").create(api);
  assert.deepEqual(service.call("counter.read"), { count: 0 }); assert.deepEqual(service.call("counter.increment"), { count: 1 });
  assert.deepEqual(provided.call("read", {}, { caller: "example.reader", remote: false, signal: abort.signal }), { count: 1 });
  assert.throws(() => provided.call("read", {}, { remote: true, signal: abort.signal }), /local/);
  abort.abort(); assert.equal(removed, true); assert.throws(() => service.call("counter.increment"), /abort/i); service.dispose();
});
test("native example preserves invalid saved data instead of resetting it", () => {
  const service = require("../native-counter/service"); const state = { count: "invalid" };
  assert.throws(() => service.create({ version: 1, signal: new AbortController().signal, settings: { get: () => state.count }, services: { provide() { throw Error("Must not register"); } } }), /preserved/);
  assert.equal(state.count, "invalid");
});
