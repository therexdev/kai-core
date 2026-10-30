"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { readPackageFile } = require("../lib/plugins/package-file");
const { MAX_BYTES, MAX_FILES, BINARY, canonical, signingPayload } = require("../lib/plugins/package");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function setup(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-package-file-test-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function fixture(files = { "index.html": "<h1>Plugin</h1>" }) { return { manifest: { schema: 2, apiVersion: 3, runtime: "sandboxed", id: "example.reader", name: "Reader", version: "1.0.0", entry: "index.html", permissions: [] }, files, publicKey: "unverified", signature: "unverified" }; }
function put(dir, source) { const file = path.join(dir, "test.kaiplugin"); fs.writeFileSync(file, typeof source === "object" && !Buffer.isBuffer(source) ? JSON.stringify(source) : source); return file; }
function rejected(dir, source, pattern) {
  assert.throws(() => readPackageFile(put(dir, source), { directory: dir }), pattern);
  assert.deepEqual(fs.readdirSync(dir), ["test.kaiplugin"], "A failed parse must remove its owned staging directory");
}

test("file reader stages exact text/binary bytes and metadata without authenticating or executing them", t => {
  const dir = setup(t), bytes = crypto.randomBytes(220001), pkg = fixture({ "z.js": "throw Error('Untrusted code must not execute')", "@scope/module/runtime.wasm": bytes.toString("base64"), "index.html": "\ufeffHello 🌎\r\n\t\"quoted\"\\\u0000 end" });
  const ordered = { signature: pkg.signature, files: pkg.files, publicKey: pkg.publicKey, manifest: pkg.manifest }, source = "\r\n" + JSON.stringify(ordered, null, 2) + "\t\n", file = put(dir, source);
  const result = readPackageFile(file, { directory: dir }); t.after(result.dispose);
  assert.deepEqual(result.manifest, pkg.manifest); assert.equal(result.publicKey, "unverified"); assert.equal(result.signature, "unverified");
  assert.equal(result.sourceFile, file); assert.equal(result.sourceBytes, Buffer.byteLength(source)); assert.equal(result.sourceDigest, hash(source));
  assert.equal(canonical({ domain: "kai-plugin-package-v3", manifest: result.manifest, files: result.entries }), signingPayload(pkg.manifest, pkg.files));
  for (const entry of result.entries) { const expected = Buffer.from(pkg.files[entry.path], BINARY.test(entry.path) ? "base64" : "utf8"); assert.deepEqual(fs.readFileSync(path.join(result.root, entry.path)), expected); assert.equal(entry.sha256, hash(expected)); assert.equal(entry.bytes, expected.length); }
  result.dispose(); result.dispose(); assert.equal(fs.existsSync(result.root), false); assert.equal(fs.existsSync(file), true);
});

test("UTF-8, escaped Unicode and surrogate pairs survive every input chunk boundary", t => {
  const dir = setup(t), prefix = '{"files":{"index.html":"';
  for (const tail of ["🌎é", "\\ud83c\\udf0e", "\\ud83c🌎\\udf0e", "\\ud83c\\udf0e\\ud800x\\udc00", "\\n\\t\\\\\\\"\\/\\b\\f\\r"]) {
    for (let delta = -8; delta <= 2; delta++) {
      const value = "a".repeat(65536 - Buffer.byteLength(prefix) + delta) + tail;
      const source = prefix + value + '","extra.txt":"done"},"manifest":' + JSON.stringify(fixture().manifest) + ',"publicKey":"key","signature":"sig"}';
      const expected = JSON.parse(source), result = readPackageFile(put(dir, source), { directory: dir });
      assert.deepEqual(fs.readFileSync(path.join(result.root, "index.html")), Buffer.from(expected.files["index.html"], "utf8")); result.dispose();
    }
  }
});

test("base64 streaming handles chunk boundaries and rejects noncanonical encodings", t => {
  const dir = setup(t);
  for (const count of [1, 2, 3, 65535, 65536, 65537, 2 * 1024 * 1024 + 1]) {
    const bytes = Buffer.alloc(count, 0xad), pkg = fixture({ "index.html": "", "data.bin": bytes.toString("base64") });
    const result = readPackageFile(put(dir, pkg), { directory: dir }); assert.deepEqual(fs.readFileSync(path.join(result.root, "data.bin")), bytes); result.dispose();
  }
  const escaped = JSON.stringify(fixture({ "index.html": "", "data.bin": "YQ==" })).replace('"YQ=="', '"\\u0059Q=="');
  const valid = readPackageFile(put(dir, escaped), { directory: dir }); assert.equal(fs.readFileSync(path.join(valid.root, "data.bin"), "utf8"), "a"); valid.dispose();
  for (const encoded of ["", "YQ", "YQ=", "YQ===", "YQ==AA==", "Y Q==", "YQ==\n", "YR==", "YWJ=", "====", "=AAA", "AA=A", "AAA=AAAA", "éAAA", "A".repeat(65532) + "AA==" + "AAAA"]) rejected(dir, fixture({ "index.html": "", "data.bin": encoded }), /canonical base64/);
});

test("metadata-only reads hash decoded bytes without writing payload files", t => {
  const dir = setup(t), pkg = fixture({ "index.html": "Hello", "nested/data.bin": crypto.randomBytes(128000).toString("base64") });
  const result = readPackageFile(put(dir, pkg), { directory: dir, extract: false });
  assert.deepEqual(fs.readdirSync(result.root), []); assert.equal(result.entries.length, 2);
  assert.equal(canonical({ domain: "kai-plugin-package-v3", manifest: result.manifest, files: result.entries }), signingPayload(pkg.manifest, pkg.files)); result.dispose();
});

test("publisher review can explicitly read unsigned input but default and partial signature fields fail", t => {
  const dir = setup(t), pkg = fixture(), unsigned = { manifest: pkg.manifest, files: pkg.files }, file = put(dir, unsigned);
  assert.throws(() => readPackageFile(file, { directory: dir, extract: false }), /fields/);
  const result = readPackageFile(file, { directory: dir, extract: false, allowUnsigned: true });
  assert.equal(result.publicKey, undefined); assert.equal(result.signature, undefined); assert.deepEqual(result.manifest, pkg.manifest); result.dispose();
  assert.throws(() => readPackageFile(put(dir, { ...unsigned, signature: "partial" }), { directory: dir, extract: false, allowUnsigned: true }), /fields/);
});

test("strict JSON rejects duplicate keys, invalid encodings, missing fields and trailing data", t => {
  const dir = setup(t), valid = JSON.stringify(fixture());
  for (const source of [valid + "{}", valid.replace('"signature":"unverified"', '"signature":"unverified","signature":"other"'), valid.replace('"signature":"unverified"', '"signature":"unverified","\\u0073ignature":"other"'), valid.replace('"schema":2', '"schema":2,"schema":2'), valid.replace('"permissions":[]', '"permissions":[],"extra":{"x":1,"x":2}'), valid.replace('"files":{', '"extra":true,"files":{'), valid.replace(',"signature":"unverified"', ''), valid.replace('"index.html":', '"index.html":"first","index.html":'), valid.replace('"index.html":', '"\\u0069ndex.html":"first","index.html":'), valid.replace('"schema":2', '"schema":02'), valid.replace('"schema":2', '"schema":1e999'), valid.replace('"schema":2', '"schema":+2'), valid.replace('"files":{"index.html":"<h1>Plugin</h1>"}', '"files":{}'), valid.replace('"files":{"index.html":"<h1>Plugin</h1>"}', '"files":{"index.html":5}'), valid.slice(0, -1), valid.replace('"Reader"', '"bad\ntext"'), valid.replace('"Reader"', '"bad\\x"'), valid.replace('"Reader"', '"bad\\uZZZZ"')]) rejected(dir, source, /JSON|plugin|Plugin|field|files|metadata/);
  rejected(dir, Buffer.concat([Buffer.from(valid.replace("<h1>Plugin</h1>", "MARKER").split("MARKER")[0]), Buffer.from([0xc0, 0xaf]), Buffer.from(valid.replace("<h1>Plugin</h1>", "MARKER").split("MARKER")[1])]), /encoded data|UTF-8/);
});

test("invalid, case-aliased and ancestor file paths fail with complete staging cleanup", t => {
  const dir = setup(t);
  for (const files of [{ "../escape.js": "" }, { "/absolute.js": "" }, { "CON.js": "" }, { "a\\b.js": "" }, { "index.html": "", "INDEX.html": "" }, { "folder/A.js": "", "Folder/b.js": "" }, { "a.js": "", "a.js/b.js": "" }, { "a.js/b.js": "", "a.js": "" }]) rejected(dir, fixture(files), /path/);
  rejected(dir, fixture({ ["x".repeat(241) + ".js"]: "" }), /path/);
});

test("source, metadata, nesting and file-count limits reject before unbounded allocation", t => {
  const dir = setup(t);
  rejected(dir, { ...fixture(), manifest: { ...fixture().manifest, description: "a".repeat(65536) } }, /64 KiB/);
  const source = JSON.stringify(fixture()).replace('"permissions":[]', '"permissions":' + "[".repeat(66) + "0" + "]".repeat(66)); rejected(dir, source, /nested/);
  const files = {}; for (let i = 0; i <= MAX_FILES; i++) files[`f${i}.txt`] = ""; rejected(dir, fixture(files), /too many files/);
  const file = put(dir, ""); fs.truncateSync(file, MAX_BYTES + 1); assert.throws(() => readPackageFile(file, { directory: dir }), /512 MB/); assert.deepEqual(fs.readdirSync(dir), ["test.kaiplugin"]);
});

test("cleanup refuses a replaced staging root and never deletes outside data", t => {
  const dir = setup(t), result = readPackageFile(put(dir, fixture()), { directory: dir });
  const renamed = result.root + "-moved"; fs.renameSync(result.root, renamed); fs.mkdirSync(result.root); fs.writeFileSync(path.join(result.root, "other-user-data"), "keep");
  assert.throws(result.dispose, /identity changed/); assert.equal(fs.readFileSync(path.join(result.root, "other-user-data"), "utf8"), "keep");
  fs.rmSync(result.root, { recursive: true }); fs.renameSync(renamed, result.root); result.dispose();
});

test("a staging permission failure still removes the newly owned directory", t => {
  const dir = setup(t), file = put(dir, fixture()), original = fs.chmodSync;
  fs.chmodSync = () => { throw Error("Simulated staging chmod failure"); };
  try { assert.throws(() => readPackageFile(file, { directory: dir }), /chmod failure/); }
  finally { fs.chmodSync = original; }
  assert.deepEqual(fs.readdirSync(dir), ["test.kaiplugin"]);
});

test("maximum deep file paths remain bounded without retaining every directory prefix", t => {
  const dir = setup(t), files = {};
  for (let i = 0; i < MAX_FILES; i++) files[`n${String(i).padStart(5, "0")}/${"ab/".repeat(74)}file.txt`] = "";
  const file = put(dir, fixture(files));
  const output = require("node:child_process").execFileSync(process.execPath, ["--max-old-space-size=64", "-e", 'const {readPackageFile}=require(process.argv[1]);const p=readPackageFile(process.argv[2],{extract:false,directory:process.argv[3]});console.log(p.entries.length);p.dispose();', require.resolve("../lib/plugins/package-file"), file, dir], { encoding: "utf8", timeout: 30000 });
  assert.equal(Number(output.trim()), MAX_FILES);
});
