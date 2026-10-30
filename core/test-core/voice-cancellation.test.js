"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { VoiceManager } = require("../lib/whisper"), { RuntimeProvisioner } = require("../lib/runtime-provisioner");
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-voice-cancel-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function blockedFetch(t) {
  let opened; const started = new Promise(resolve => { opened = resolve; });
  t.mock.method(global, "fetch", async (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); opened(signal); }));
  return started;
}
test("Whisper cancellation propagates into provisioning and prevents the model download", async t => {
  const dir = temporary(t), controller = new AbortController(); let received, downloads = 0;
  t.mock.method(global, "fetch", async () => { downloads++; throw Error("Unexpected download"); });
  const voice = new VoiceManager({ catalogPath: path.join(dir, "none"), voiceDir: dir, provisioner: { ensure: async (_kind, { signal }) => { received = signal; controller.abort(Error("Voice disabled")); } } });
  voice._binPath = () => null;
  await assert.rejects(voice.ensure({ signal: controller.signal }), /Voice disabled/); assert.equal(received, controller.signal); assert.equal(downloads, 0); assert.equal(voice.status().setup.state, "error");
});
test("Whisper model downloads stop on the supplied lifecycle signal", async t => {
  const dir = temporary(t), controller = new AbortController(), started = blockedFetch(t);
  const voice = new VoiceManager({ catalogPath: path.join(dir, "none"), voiceDir: dir }); voice._binPath = () => "/already-installed"; voice._modelPath = () => null;
  voice.model = { filename: "synthetic.bin", url: "https://example.test/model", sha256: "1".repeat(64) };
  const pending = voice.ensure({ signal: controller.signal }), rejected = assert.rejects(pending, /Voice disabled/);
  const downloadSignal = await started; controller.abort(Error("Voice disabled")); await rejected; assert.equal(downloadSignal.aborted, true); assert.equal(fs.existsSync(path.join(dir, "synthetic.bin")), false);
});
test("runtime provisioning forwards cancellation to downloads and refuses extraction after cancellation", async t => {
  const dir = temporary(t), version = crypto.randomUUID(), key = `${process.platform}-${process.arch}-cpu`, catalog = path.join(dir, "catalog.json"), controller = new AbortController(), started = blockedFetch(t);
  fs.writeFileSync(catalog, JSON.stringify({ whisper: { version, builds: { [key]: { url: "https://example.test/runtime.zip", sha256: "1".repeat(64), binPath: "whisper" } } } }));
  const provisioner = new RuntimeProvisioner({ catalogPath: catalog, runtimesDir: path.join(dir, "runtimes") });
  const pending = provisioner.ensure("whisper", { signal: controller.signal }), rejected = assert.rejects(pending, /Voice disabled/);
  const downloadSignal = await started; controller.abort(Error("Voice disabled")); await rejected; assert.equal(downloadSignal.aborted, true); assert.equal(fs.existsSync(path.join(dir, "runtimes")), false);
  await assert.rejects(provisioner.ensure("whisper", { signal: controller.signal }), /Voice disabled/);
});
test("runtime setup checks cancellation between verified download and extraction", async t => {
  const dir = temporary(t), version = crypto.randomUUID(), key = `${process.platform}-${process.arch}-cpu`, catalog = path.join(dir, "catalog.json"), controller = new AbortController();
  const archive = require("../test/fixtures/make-zip").makeZip([{ name: "whisper", data: "synthetic" }]), sha256 = crypto.createHash("sha256").update(archive).digest("hex");
  fs.writeFileSync(catalog, JSON.stringify({ whisper: { version, builds: { [key]: { url: "https://example.test/runtime.zip", sha256, binPath: "whisper" } } } }));
  const cached = path.join(os.tmpdir(), `kai-runtime-whisper-${version}-${key}-0.zip`); t.after(() => fs.rmSync(cached, { force: true }));
  t.mock.method(global, "fetch", async () => new Response(archive));
  const provisioner = new RuntimeProvisioner({ catalogPath: catalog, runtimesDir: path.join(dir, "runtimes"), onEvent: event => { if (event.type === "runtime:extracting") controller.abort(Error("Voice disabled")); } });
  await assert.rejects(provisioner.ensure("whisper", { signal: controller.signal }), /Voice disabled/);
  assert.equal(fs.existsSync(cached), true, "verified download remains reusable"); assert.equal(fs.existsSync(path.join(dir, "runtimes")), false);
});
test("canceling a voice waiter does not wait for or abort another runtime setup", async t => {
  const dir = temporary(t), catalog = path.join(dir, "catalog.json"), controller = new AbortController(); fs.writeFileSync(catalog, "{}");
  const provisioner = new RuntimeProvisioner({ catalogPath: catalog, runtimesDir: dir }); let complete;
  const original = provisioner._active = new Promise(resolve => { complete = resolve; });
  const joined = provisioner.ensure("whisper", { signal: controller.signal }), rejected = assert.rejects(joined, /Voice disabled/);
  controller.abort(Error("Voice disabled")); await rejected; assert.equal(provisioner._active, original);
  complete("other-runtime"); assert.equal(await original, "other-runtime");
});
