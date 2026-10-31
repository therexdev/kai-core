"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { RuntimeProvisioner } = require("../lib/runtime-provisioner");
const { extractZipAsync } = require("../lib/zip");
const { makeZip } = require("../test/fixtures/make-zip");
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-preparation-"))), version = crypto.randomUUID();
  const payloads = { main: makeZip([{ name: "engine", data: "verified engine", mode: 0o755 }]), extra: makeZip([{ name: "companion", data: "required companion" }]) };
  const archive = name => ({ url: `https://runtime.test/${name}.zip`, sha256: crypto.createHash("sha256").update(payloads[name]).digest("hex"), sizeBytes: payloads[name].length });
  const builds = Object.fromEntries(["cpu", "vulkan"].map(cap => [`${process.platform}-${process.arch}-${cap}`, { ...archive("main"), binPath: "engine", extras: [archive("extra")] }]));
  const catalogPath = path.join(root, "catalog.json"); fs.writeFileSync(catalogPath, JSON.stringify({ llama: { version, builds }, voice: { version, builds } }));
  const events = [], provisioner = new RuntimeProvisioner({ catalogPath, runtimesDir: path.join(root, "runtimes"), hardware: {}, onEvent: event => events.push(event) });
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); for (const kind of ["llama", "voice"]) for (const cap of ["cpu", "vulkan"]) for (const i of [0, 1]) for (const suffix of ["", ".part"]) fs.rmSync(path.join(os.tmpdir(), `kai-runtime-${kind}-${version}-${process.platform}-${process.arch}-${cap}-${i}.zip${suffix}`), { force: true }); });
  return { root, provisioner, payloads, events };
}

test("different runtime kinds and capabilities never receive another setup's binary", async t => {
  const f = fixture(t), calls = [], waits = [];
  f.provisioner._ensure = async (kind, { cap }) => { calls.push(`${kind}/${cap}`); const d = deferred(); waits.push(d); await d.promise; return `${kind}-${cap}`; };
  const first = f.provisioner.ensure("llama", { cap: "cpu" });
  const voice = f.provisioner.ensure("voice", { cap: "cpu" });
  const gpu = f.provisioner.ensure("llama", { cap: "vulkan" });
  await tick(); assert.deepEqual(calls, ["llama/cpu"]);
  waits[0].resolve(); assert.equal(await first, "llama-cpu"); await tick();
  assert.deepEqual(calls, ["llama/cpu", "voice/cpu"]);
  waits[1].resolve(); assert.equal(await voice, "voice-cpu"); await tick();
  waits[2].resolve(); assert.equal(await gpu, "llama-vulkan");
  assert.deepEqual(calls, ["llama/cpu", "voice/cpu", "llama/vulkan"]);
  assert.equal(f.provisioner.downloadProgress(), null);
});

test("one cancelled waiter cannot abort an identical setup still needed by another caller", async t => {
  const f = fixture(t), work = deferred(), one = new AbortController(); let started = 0, shared;
  f.provisioner._ensure = async (_kind, { signal }) => { started++; shared = signal; return work.promise; };
  const first = f.provisioner.ensure("llama", { signal: one.signal }), second = f.provisioner.ensure("llama");
  const rejected = assert.rejects(first, { name: "AbortError" }); await tick(); one.abort(); await rejected;
  assert.equal(started, 1); assert.equal(shared.aborted, false);
  work.resolve("correct-engine"); assert.equal(await second, "correct-engine");
});

test("the last cancelled waiter aborts preparation and releases the next build", async t => {
  const f = fixture(t), cancel = new AbortController(); let shared;
  f.provisioner._ensure = async (kind, { signal }) => kind === "voice" ? "voice-engine" : new Promise((_resolve, reject) => {
    shared = signal; signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const first = f.provisioner.ensure("llama", { signal: cancel.signal }), other = f.provisioner.ensure("voice");
  const rejected = assert.rejects(first, { name: "AbortError" }); await tick(); cancel.abort(); await rejected;
  assert.equal(shared.aborted, true); assert.equal(await other, "voice-engine");
});

test("a failed companion archive cannot leave a partial engine marked installed and retry reuses verified bytes", async t => {
  const f = fixture(t), binary = f.provisioner.installedBinPath("llama"), downloads = []; let failExtra = true;
  t.mock.method(global, "fetch", async url => {
    downloads.push(String(url));
    assert.equal(fs.existsSync(binary), false, "the final engine must remain unavailable until all archives are complete");
    if (String(url).endsWith("extra.zip") && failExtra) throw Error("Companion mirror unavailable");
    return new Response(f.payloads[String(url).endsWith("extra.zip") ? "extra" : "main"]);
  });
  await assert.rejects(f.provisioner.ensure("llama"), /Companion mirror unavailable/);
  assert.equal(fs.existsSync(binary), false); assert.equal(f.provisioner.downloadProgress(), null);
  failExtra = false;
  assert.equal(await f.provisioner.ensure("llama"), binary);
  assert.equal(fs.readFileSync(binary, "utf8"), "verified engine");
  assert.equal(fs.readFileSync(path.join(path.dirname(binary), "companion"), "utf8"), "required companion");
  assert.equal(downloads.filter(url => url.endsWith("main.zip")).length, 1);
  assert.equal(f.provisioner.downloadProgress(), null);
});

test("cancelled extraction stops its worker before staging cleanup and can be retried", async t => {
  const f = fixture(t), archive = path.join(f.root, "archive.zip"), target = path.join(f.root, "stage"), cancel = new AbortController();
  fs.writeFileSync(archive, makeZip([{ name: "large", data: Buffer.alloc(8 * 1024 * 1024, 1), deflate: true }]));
  const extracting = extractZipAsync(archive, target, { signal: cancel.signal }); cancel.abort();
  await assert.rejects(extracting, { name: "AbortError" });
  fs.rmSync(target, { recursive: true, force: true }); await tick(); assert.equal(fs.existsSync(target), false);
  await extractZipAsync(archive, target); assert.equal(fs.statSync(path.join(target, "large")).size, 8 * 1024 * 1024);
});

test("a completed download interrupted during verification resumes locally instead of requesting past EOF", async t => {
  const { downloadFile } = require("../lib/download"), f = fixture(t), file = path.join(f.root, "model.gguf"), bytes = Buffer.from("complete verified model");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex"), phases = [];
  fs.writeFileSync(file + ".part", bytes);
  t.mock.method(global, "fetch", async () => { throw Error("Completed files must not need the mirror again"); });
  assert.equal(await downloadFile("https://runtime.test/model", file, { sha256, sizeBytes: bytes.length, onProgress: p => phases.push(p.phase) }), file);
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(fs.existsSync(file + ".part"), false); assert.ok(phases.every(p => p === "verifying"));
});

test("cancelling verification leaves resumable bytes and never promotes unverified weights", async t => {
  const { downloadFile } = require("../lib/download"), f = fixture(t), file = path.join(f.root, "model.gguf"), bytes = Buffer.alloc(256 * 1024, 2);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex"), cancel = new AbortController(); fs.writeFileSync(file + ".part", bytes);
  t.mock.method(global, "fetch", async () => { throw Error("No mirror access needed"); });
  await assert.rejects(downloadFile("https://runtime.test/model", file, { sha256, sizeBytes: bytes.length, signal: cancel.signal,
    onProgress(p) { if (p.phase === "verifying" && p.done > 0) cancel.abort(); } }), { name: "AbortError" });
  assert.equal(fs.existsSync(file), false); assert.equal(fs.statSync(file + ".part").size, bytes.length);
  await downloadFile("https://runtime.test/model", file, { sha256, sizeBytes: bytes.length }); assert.deepEqual(fs.readFileSync(file), bytes);
});

test("an EOF resume response is accepted only after the saved bytes match the pinned hash", async t => {
  const { downloadFile } = require("../lib/download"), f = fixture(t), file = path.join(f.root, "model.gguf"), bytes = Buffer.from("verified bytes"), sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  t.mock.method(global, "fetch", async () => new Response(null, { status: 416 })); fs.writeFileSync(file + ".part", bytes);
  await downloadFile("https://runtime.test/model", file, { sha256 }); assert.deepEqual(fs.readFileSync(file), bytes);
  fs.unlinkSync(file); fs.writeFileSync(file + ".part", "corrupt bytes");
  await assert.rejects(downloadFile("https://runtime.test/model", file, { sha256 }), /SHA-256/);
  assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(file + ".part"), false);
});
