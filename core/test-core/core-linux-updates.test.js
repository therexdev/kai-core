"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createLinuxUpdater, assetInfo, assertLinuxInfo, assetResponse } = require("../../electron/core-linux-updates");
const { verifyImage, stageInstall, installStaged, launchEnv, startHelper } = require("../../electron/appimage-install");
const { createCoreUpdates } = require("../../electron/core-updates");
const image = payload => Buffer.concat([Buffer.from([127,69,76,70,2,1,1,0,65,73,2,0]), Buffer.from(payload)]);
const checksum = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function release(bytes, arch = "arm64", version = "0.8.0") {
  const name = `KAI-Core-Beta-${version}-linux-${arch}.AppImage`;
  return { tag_name: `v${version}`, draft: false, prerelease: false, assets: [{ name, state: "uploaded", size: bytes.length, digest: `sha256:${checksum(bytes)}`, browser_download_url: `https://github.com/therexdev/kai-core/releases/download/v${version}/${name}` }] };
}
function root(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-linux-update-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function fixture(t, extra = {}) {
  const dir = root(t), target = path.join(dir, "Pi's KAI Core.AppImage"), bytes = image("new app"); fs.writeFileSync(target, image("previous app"));
  let quits = 0, helper = null, requests = 0;
  const app = { isPackaged: true, getVersion: () => "0.7.14", getPath: () => dir, quit() { quits++; } };
  const adapter = createLinuxUpdater({ app, platform: "linux", arch: "arm64", env: { APPIMAGE: target, DBUS_SESSION_BUS_ADDRESS: "session-bus" }, canNetwork: () => true,
    fetchRelease: async () => release(bytes), fetchImpl: async () => { requests++; return new Response(bytes); },
    helperStarter: async stage => { helper = stage; }, ...extra });
  return { adapter, app, bytes, target, dir, get quits() { return quits; }, get helper() { return helper; }, get requests() { return requests; } };
}
test("Linux release selection pins architecture, version, repository, exact size and GitHub checksum", () => {
  const bytes = image("app"), value = release(bytes);
  assert.equal(assetInfo(value, "arm64").sha256, checksum(bytes));
  assert.equal(assetInfo(release(bytes, "x86_64"), "x64").name, "KAI-Core-Beta-0.8.0-linux-x86_64.AppImage");
  for (const edit of [r => r.draft = true, r => r.prerelease = true, r => r.tag_name = "v0.8.0-beta.1", r => r.assets[0].digest = null,
    r => r.assets[0].browser_download_url = "https://evil.example/update", r => r.assets[0].size = 4 * 1024 ** 3, r => r.assets.push(r.assets[0])]) {
    const changed = structuredClone(value); edit(changed); assert.throws(() => assetInfo(changed, "arm64"));
  }
  assert.throws(() => assetInfo(value, "x64")); assert.throws(() => assetInfo(value, "arm"));
  const info = assetInfo(value, "arm64"); assertLinuxInfo(info, "0.8.0");
  assert.throws(() => assertLinuxInfo(info, "0.7.14"));
  assert.throws(() => assertLinuxInfo({ ...info, name: info.name.replace("0.8.0", "0.7.0") }, "0.8.0"));
});
test("AppImage request redirects remain HTTPS, allowlisted and privacy/cancellation aware", async () => {
  const signal = new AbortController().signal, first = "https://github.com/therexdev/kai-core/releases/download/v0.8.0/a.AppImage";
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://evil.example/app" } }); };
  await assert.rejects(assetResponse(first, { signal, fetchImpl, canNetwork: () => true }), /not permitted/); assert.equal(calls, 1);
  await assert.rejects(assetResponse(first, { signal, fetchImpl, canNetwork: () => false }), /not permitted/); assert.equal(calls, 1);
  const abort = new AbortController(); abort.abort(); await assert.rejects(assetResponse(first, { signal: abort.signal, fetchImpl, canNetwork: () => true }));
  for (const location of ["http://github.com/app", "https://user:password@github.com/app", "https://github.com:8443/app"]) {
    await assert.rejects(assetResponse(first, { signal, canNetwork: () => true, fetchImpl: async () => new Response(null, { status: 302, headers: { location } }) }), /not permitted/);
  }
});
test("real Linux adapter runs through Core check/download/reverify/approval without an automatic restart", async t => {
  const f = fixture(t); let approvals = 0;
  const updates = createCoreUpdates({ app: f.app, settings: { get: (_key, fallback) => fallback }, isLocalOnly: () => false,
    adapterFactory: () => f.adapter, fetchRelease: async () => release(f.bytes), approveInstall: async () => { approvals++; return true; }, performInstall: updater => updater.quitAndInstall() });
  await updates.check(); assert.equal(updates.status().manualOnly, false); assert.equal(f.requests, 0); assert.equal(f.quits, 0);
  await updates.download(); assert.equal(updates.status().canInstall, true); assert.equal(f.quits, 0); assert.equal(approvals, 0);
  await updates.install(); assert.equal(approvals, 1); assert.equal(f.quits, 1);
  const job = JSON.parse(fs.readFileSync(f.helper.jobFile, "utf8"));
  assert.deepEqual(job.args, ["--password-store=gnome-libsecret"]); assert.equal(job.env.DBUS_SESSION_BUS_ADDRESS, "session-bus");
  assert.equal(job.env.APPIMAGE_EXTRACT_AND_RUN, "1"); assert.equal(job.env.KAI_CORE_APPIMAGE_PATH, f.target); assert.equal(job.env.APPIMAGE, undefined);
  assert.deepEqual(fs.readFileSync(f.target), image("previous app")); // helper waits until Core exits
  await updates.dispose();
});
test("truncated, oversized and corrupted Linux downloads never become installable", async t => {
  for (const payload of [image("x"), Buffer.alloc(500), image("bad app")]) {
    const f = fixture(t, { fetchImpl: async () => new Response(payload) }); const controller = new AbortController(); f.adapter.beginRequest(controller.signal);
    await f.adapter.updater.checkForUpdates(); await assert.rejects(f.adapter.updater.downloadUpdate()); assert.equal(f.adapter.updater.installerPath, null); assert.equal(f.quits, 0);
    assert.deepEqual(fs.readFileSync(f.target), image("previous app"));
  }
});
test("privacy cancellation during body streaming cannot turn into a ready update", async t => {
  const controller = new AbortController();
  const f = fixture(t, { fetchImpl: async () => ({ ok: true, body: (async function* () { yield image("new app").subarray(0, 12); controller.abort(); yield Buffer.from("new app"); })() }) });
  f.adapter.beginRequest(controller.signal); await f.adapter.updater.checkForUpdates();
  await assert.rejects(f.adapter.updater.downloadUpdate()); assert.equal(f.adapter.updater.installerPath, null);
});
test("failed helper preparation keeps the old app in place and does not quit", async t => {
  const f = fixture(t, { helperStarter: async () => { throw Error("helper unavailable"); } });
  f.adapter.beginRequest(new AbortController().signal); await f.adapter.updater.checkForUpdates(); await f.adapter.updater.downloadUpdate();
  await assert.rejects(f.adapter.updater.quitAndInstall(), /helper unavailable/); assert.equal(f.quits, 0); assert.deepEqual(fs.readFileSync(f.target), image("previous app"));
});
test("missing or unwritable installations and development/unsupported builds keep manual downloads", t => {
  const f = fixture(t);
  const options = { app: f.app, platform: "linux", arch: "arm64", env: {}, canNetwork: () => true };
  assert.equal(createLinuxUpdater(options).updater, undefined);
  assert.equal(createLinuxUpdater({ ...options, env: { APPIMAGE: "relative.AppImage" } }).updater, undefined);
  assert.equal(createLinuxUpdater({ ...options, env: { APPIMAGE: f.target }, app: { ...f.app, isPackaged: false } }).updater, undefined);
  assert.equal(createLinuxUpdater({ ...options, env: { APPIMAGE: f.target }, arch: "arm" }).updater, undefined);
});
test("atomic installation waits for shutdown, preserves a backup and keeps the launch path", { skip: process.platform !== "linux" }, async t => {
  const f = fixture(t), file = path.join(f.dir, "new.AppImage"); fs.writeFileSync(file, f.bytes);
  const stage = await stageInstall({ target: f.target, file, info: assetInfo(release(f.bytes), "arm64"), parentPid: 12345, args: ["--password-store=gnome-libsecret"] });
  const job = JSON.parse(fs.readFileSync(stage.jobFile, "utf8")); let alive = true, waits = 0, launches = 0;
  await installStaged(job, { isAlive: () => alive, wait: async () => { waits++; assert.deepEqual(fs.readFileSync(f.target), image("previous app")); alive = false; },
    launchImpl: async (target, args) => { launches++; assert.equal(target, f.target); assert.deepEqual(args, job.args); } });
  assert.equal(waits, 1); assert.equal(launches, 1); assert.deepEqual(fs.readFileSync(f.target), f.bytes);
  assert.deepEqual(fs.readFileSync(f.target + ".previous"), image("previous app"));
});
test("changed cache/target, invalid images and failed relaunch cannot erase the previous application", { skip: process.platform !== "linux" }, async t => {
  for (const failure of ["staged", "target", "launch"]) {
    const f = fixture(t), file = path.join(f.dir, "new.AppImage"); fs.writeFileSync(file, f.bytes);
    const info = assetInfo(release(f.bytes), "arm64"); const stage = await stageInstall({ target: f.target, file, info, parentPid: 12345 });
    const job = JSON.parse(fs.readFileSync(stage.jobFile, "utf8"));
    if (failure === "staged") fs.writeFileSync(job.staged, image("bad app"));
    if (failure === "target") fs.writeFileSync(f.target, image("user replaced their app"));
    await assert.rejects(installStaged(job, { isAlive: () => false, launchImpl: async () => { throw Error("spawn failed"); } }));
    assert.deepEqual(fs.readFileSync(f.target), image(failure === "target" ? "user replaced their app" : "previous app"));
  }
  const dir = root(t), fake = path.join(dir, "app"); const bytes = Buffer.from("not an AppImage"); fs.writeFileSync(fake, bytes);
  await assert.rejects(verifyImage(fake, { size: bytes.length, sha256: checksum(bytes) }), /supported AppImage/);
});
test("helper handshake happens in a real detached Node process before parent exit", { skip: process.platform !== "linux" }, async t => {
  const dir = root(t), helper = path.join(dir, "helper.cjs");
  fs.writeFileSync(helper, "process.send({ready:true},()=>{process.disconnect();});");
  await startHelper({ helper, jobFile: path.join(dir, "job.json") });
  const env = launchEnv({ ELECTRON_RUN_AS_NODE: "1", APPIMAGE: "old", APPDIR: "temp", DBUS_SESSION_BUS_ADDRESS: "bus" }, "/apps/KAI.AppImage");
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined); assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "bus");
});
