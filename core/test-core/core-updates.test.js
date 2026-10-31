"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createCoreUpdates, createWindowsUpdater, validateSignatureRecord, verifyWindowsInstaller, verifyDownloadedInstaller, validateRelease,
  assertUpdateInfo, PUBLISHER, RELEASES, CHECK_INTERVAL, CHECK_TIMEOUT } = require("../../electron/core-updates");
const tick = () => new Promise(resolve => setImmediate(resolve));
function info(version = "0.8.0") { return { version, tag: `v${version}`, files: [{ url: `KAI-Core-Beta-Setup-${version}-x64.exe`, sha512: Buffer.alloc(64, 1).toString("base64"), size: 123 }] }; }
function fixture(options = {}) {
  let localOnly = false, clock = 1000, calls = 0, installs = 0, approvals = 0, verifies = 0, opened;
  const saved = {}, timers = new Set(), updater = new EventEmitter();
  updater.installerPath = "/cache/KAI-Core-Beta-Setup-0.8.0-x64.exe";
  updater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: info() });
  updater.downloadUpdate = async () => [updater.installerPath];
  const updates = createCoreUpdates({ app: { getVersion: () => "0.7.8" }, settings: { get: (_key, fallback) => fallback, set: (key, value) => { saved[key] = value; } },
    isLocalOnly: () => localOnly, now: () => clock,
    setTimer(fn, delay) { const timer = { fn, delay, at: clock + delay, unref() {} }; timers.add(timer); return timer; }, clearTimer(timer) { timers.delete(timer); },
    adapterFactory: () => ({ updater, abortRequests() {} }), fetchRelease: async () => { calls++; return { tag_name: "v0.8.0", draft: false, prerelease: false }; },
    verifyInstaller: async () => { verifies++; }, approveInstall: async () => { approvals++; return true; }, performInstall: async () => { installs++; }, openExternal: async url => { opened = url; },
    ...options,
  });
  return { updates, updater, saved, timers, get calls() { return calls; }, get installs() { return installs; }, get approvals() { return approvals; }, get verifies() { return verifies; }, get opened() { return opened; },
    privacy(value) { localOnly = value; updates.privacyChanged(); }, async advance(ms) { clock += ms; for (const timer of [...timers]) if (timer.at <= clock) { timers.delete(timer); timer.fn(); } await tick(); } };
}
test("checks are scheduled without blocking startup, deduplicated and settings persist", async () => {
  const f = fixture(); f.updates.start(); assert.equal(f.calls, 0); assert.equal(f.updates.status().automaticCheck, true);
  await f.advance(10000); assert.equal(f.calls, 1); assert.equal(f.updates.status().state, "available");
  const checked = f.updates.status().lastCheckedAt, rev = f.updates.status().revision;
  await f.updates.wake(); await f.updates.wake(); assert.equal(f.calls, 1); assert.equal(f.updates.status().lastCheckedAt, checked);
  await f.advance(CHECK_INTERVAL); assert.equal(f.calls, 2); assert(f.updates.status().revision > rev);
  f.updates.configure({ automaticCheck: false }); assert.equal(f.saved["applicationUpdates.automaticCheck"], false); assert.equal(f.timers.size, 0);
  await f.updates.wake(); assert.equal(f.calls, 2); await f.updates.check(); assert.equal(f.calls, 3);
  assert.throws(() => f.updates.configure({ automaticCheck: true, url: "https://evil.example" }), /Choose whether/); await f.updates.dispose();
});
test("manual-only copies still check releases and always open the pinned repository", async () => {
  const f = fixture({ adapterFactory: () => ({ reason: "Portable copy" }) }); await f.updates.check();
  assert.equal(f.updates.status().manualOnly, true); assert.equal(f.updates.status().canDownload, false);
  await assert.rejects(f.updates.download(), /official download/); await f.updates.openRelease(); assert.equal(f.opened, RELEASES);
  f.privacy(true); await assert.rejects(f.updates.openRelease(), /Local-Only/); await assert.rejects(f.updates.check(), /Local-Only/); await f.updates.dispose();
});
test("available downloads require explicit action and a verified file before install", async () => {
  const f = fixture(); await f.updates.check(); assert.equal(f.verifies, 0); assert.equal(f.installs, 0);
  await f.updates.download(); assert.equal(f.updates.status().state, "downloaded"); assert.equal(f.updates.status().canInstall, true); assert.equal(f.verifies, 1);
  await Promise.all([f.updates.install(), f.updates.install()]); assert.equal(f.approvals, 1); assert.equal(f.verifies, 2); assert.equal(f.installs, 1);
  await f.updates.dispose(); assert.equal(f.installs, 1);
});
test("download deduplication, progress and cache verification failure cannot mark a file ready", async () => {
  let finish; const f = fixture({ verifyInstaller: async () => { throw Error("Unsigned cached installer"); } }); await f.updates.check();
  let downloads = 0; f.updater.downloadUpdate = () => { downloads++; return new Promise(resolve => { finish = resolve; }); };
  const one = f.updates.download(), two = f.updates.download(); assert.equal(one, two); await tick();
  f.updater.emit("download-progress", { percent: 52, transferred: 52, total: 100 }); assert.equal(f.updates.status().progress.percent, 52);
  finish([f.updater.installerPath]); await one; assert.equal(downloads, 1); assert.equal(f.updates.status().state, "error"); assert.equal(f.updates.status().canInstall, false);
  await assert.rejects(f.updates.install(), /verified/); await f.updates.dispose();
});
test("a changed cached installer is reverified before shutdown or installation", async () => {
  let checks = 0; const f = fixture({ verifyInstaller: async () => { if (++checks > 1) throw Error("Changed installer"); } });
  await f.updates.check(); await f.updates.download(); await f.updates.install(); assert.equal(f.installs, 0); assert.equal(f.updates.status().canInstall, false); assert.match(f.updates.status().error, /Changed installer/); await f.updates.dispose();
});
test("privacy and disposal release stalled checks without late success changing state", async () => {
  let finish; const f = fixture({ fetchRelease: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.updates.check(); await tick(); f.privacy(true); await pending;
  assert.equal(f.updates.status().state, "idle"); assert.equal(f.updates.status().lastCheckedAt, null);
  finish({ tag_name: "v0.8.0" }); await tick(); assert.equal(f.updates.status().availableVersion, null);
  f.privacy(false); const stalled = f.updates.check(); await tick(); await f.updates.dispose(); await stalled; assert.equal(f.timers.size, 0);
});
test("a stalled download metadata check cannot hold shutdown or allow a late installer", async () => {
  const f = fixture(); await f.updates.check(); let finish;
  f.updater.checkForUpdates = () => new Promise(resolve => { finish = resolve; });
  const pending = f.updates.download(); await tick(); await f.updates.dispose(); await pending;
  finish({ isUpdateAvailable: true, updateInfo: info() }); await tick(); assert.equal(f.verifies, 0); assert.equal(f.installs, 0); assert.equal(f.updates.status().canInstall, false);
});
test("timeout is bounded and a failure can be checked again", async () => {
  let stalled = true; const f = fixture({ fetchRelease: () => stalled ? new Promise(() => {}) : Promise.resolve({ tag_name: "v0.7.8" }) });
  const pending = f.updates.check(); await f.advance(CHECK_TIMEOUT); await pending; assert.equal(f.updates.status().state, "error"); assert.match(f.updates.status().error, /timed out/);
  stalled = false; await f.updates.check(); assert.equal(f.updates.status().state, "current"); assert.equal(f.updates.status().error, null); await f.updates.dispose();
});
test("release and feed validation rejects prereleases, wrong repositories' asset names and downgrade metadata", () => {
  assert.equal(validateRelease({ tag_name: "v0.8.0" }), "0.8.0");
  for (const release of [{ tag_name: "v0.8.0-beta.1" }, { tag_name: "v0.8.0", draft: true }, { tag_name: "v0.8.0", prerelease: true }, { tag_name: "../latest" }]) assert.throws(() => validateRelease(release));
  assert.equal(assertUpdateInfo(info(), "0.8.0").name, info().files[0].url);
  assert.throws(() => assertUpdateInfo(info("0.7.7"), "0.8.0"));
  for (const edit of [x => x.files[0].url = "https://evil.example/app.exe", x => x.files[0].sha512 = "bad", x => x.files[0].size = 0, x => x.packages = {}, x => x.tag = "v0.7.7", x => x.files.push({ ...x.files[0] })]) { const value = info(); edit(value); assert.throws(() => assertUpdateInfo(value, "0.8.0")); }
});
test("Windows native verification rejects unsigned, wrong publisher, missing timestamp and execution failure", async () => {
  const file = "C:\\Users\\Míke\\update.exe", record = { status: 0, signatureType: 1, path: file, subject: PUBLISHER, timestamp: "a".repeat(40) };
  validateSignatureRecord(record, file);
  for (const change of [{ status: 2 }, { signatureType: 2 }, { subject: "CN=Someone Else" }, { timestamp: null }, { path: "C:\\other.exe" }]) assert.throws(() => validateSignatureRecord({ ...record, ...change }, file));
  await verifyWindowsInstaller(file, { systemRoot: "C:\\Windows", execFile(exe, args, opts, done) { assert.equal(exe, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"); assert.equal(opts.shell, false); assert(args.includes("-EncodedCommand")); done(null, JSON.stringify(record), ""); } });
  await assert.rejects(verifyWindowsInstaller(file, { systemRoot: "C:\\Windows", execFile(_exe, _args, _opts, done) { done(Error("powershell absent"), "", ""); } }), /could not verify/);
  await assert.rejects(verifyWindowsInstaller(file, { systemRoot: "C:\\Windows", execFile(_exe, _args, _opts, done) { done(null, "not JSON", ""); } }), /invalid signature/);
});
test("download hash, size and native signature are all required, including cached files", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-core-update-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metadata = assertUpdateInfo(info(), "0.8.0"), file = path.join(root, metadata.name), bytes = Buffer.from("fixture installer"); fs.writeFileSync(file, bytes);
  metadata.size = bytes.length; metadata.sha512 = crypto.createHash("sha512").update(bytes).digest("base64"); let checks = 0;
  await verifyDownloadedInstaller(file, metadata, async () => { checks++; }); assert.equal(checks, 1);
  fs.writeFileSync(file, Buffer.alloc(bytes.length, 1)); await assert.rejects(verifyDownloadedInstaller(file, metadata, async () => { checks++; }), /changed/); assert.equal(checks, 1);
  fs.writeFileSync(file, bytes); await assert.rejects(verifyDownloadedInstaller(file, metadata, async () => { throw Error("Wrong publisher"); }), /Wrong publisher/);
});
test("Windows capability requires pinned publisher and disables unattended installation", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-core-updater-config-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { app: { isPackaged: true }, platform: "win32", env: {}, resourcesPath: root, canNetwork: () => true };
  assert.equal(createWindowsUpdater(options).updater, undefined);
  fs.writeFileSync(path.join(root, "app-update.yml"), `provider: github\nowner: therexdev\nrepo: kai-core\npublisherName: ${PUBLISHER}\n`);
  const updater = new EventEmitter(); updater.httpExecutor = { createRequest() { return new EventEmitter(); }, request(_options, token) { return token.createPromise(() => {}); } };
  const adapter = createWindowsUpdater({ ...options, createUpdater: () => updater, verifySignature: async () => { throw Error("Unsigned"); } });
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallOnAppQuit, false); assert.equal(updater.allowDowngrade, false);
  await assert.rejects(updater.verifyUpdateCodeSignature([], "file"), /Unsigned/);
  const controller = new AbortController(); adapter.beginRequest(controller.signal);
  const pending = updater.httpExecutor.request({ protocol: "https:", hostname: "github.com" }); controller.abort(); await assert.rejects(pending, /cancelled/); adapter.endRequest(controller.signal);
  assert.throws(() => updater.httpExecutor.createRequest({ protocol: "https:", hostname: "github.com" }, () => {}), /not permitted/);
  assert.equal(createWindowsUpdater({ ...options, env: { PORTABLE_EXECUTABLE_FILE: "kai.exe" } }).updater, undefined);
  fs.writeFileSync(path.join(root, "app-update.yml"), "provider: github\nowner: attacker\nrepo: kai-core\npublisherName: Michael Milas\n");
  assert.equal(createWindowsUpdater(options).updater, undefined);
});
