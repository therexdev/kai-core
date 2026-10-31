"use strict";
// Native Linux AppImage install/relaunch check. Uses a disposable Electron app,
// synthetic release metadata/profile and the production install helper. No live
// wallets, accounts, downloads from a release, or ARM hardware are involved.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const assert = require("node:assert/strict"), { spawn } = require("node:child_process");
async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") { console.log("Native AppImage check requires Linux x64."); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-appimage-native-"));
  const appDir = path.join(root, "fixture"), output = path.join(root, "result.json"), profile = path.join(root, "profile");
  fs.mkdirSync(appDir); fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, "retained.txt"), "saved wallet/model settings fixture");
  const report = { nativeAppImage: true, realInstallHelper: true, syntheticApplication: true, syntheticProfile: true, liveActions: false, checks: [] };
  const reportDir = path.resolve(process.env.KAI_LINUX_UPDATES_SMOKE_OUTPUT || path.join(os.tmpdir(), "kai-linux-updates-smoke")); fs.mkdirSync(reportDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "kai-update-fixture", version: "99.0.0", main: "main.js", description: "Disposable native AppImage update fixture", author: "KAI tests" }));
    fs.writeFileSync(path.join(appDir, "main.js"), `
const {app}=require('electron'),fs=require('node:fs'),path=require('node:path');
// Test-only sandbox flag for a root CI/container account. Never added by the updater.
if(process.getuid?.()===0)app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('ozone-platform','headless');
app.disableHardwareAcceleration();
app.whenReady().then(()=>{const data={args:process.argv.slice(1),target:process.env.KAI_CORE_APPIMAGE_PATH,
extract:process.env.APPIMAGE_EXTRACT_AND_RUN,retained:fs.readFileSync(path.join(process.env.KAI_UPDATE_TEST_PROFILE,'retained.txt'),'utf8')};
fs.writeFileSync(process.env.KAI_UPDATE_TEST_OUTPUT,JSON.stringify(data));app.quit();});
`);
    const builder = require("electron-builder");
    await builder.build({ projectDir: appDir, targets: builder.Platform.LINUX.createTarget(["AppImage"], builder.Arch.x64),
      config: { appId: "io.koinosai.update-fixture", productName: "KAI Update Fixture", electronVersion: require("electron/package.json").version,
        electronDist: path.dirname(require("electron")), npmRebuild: false, directories: { output: path.join(root, "dist") }, files: ["main.js", "package.json"],
        linux: { executableName: "kai-update-fixture", category: "Utility" }, artifactName: "KAI-Core-Beta-99.0.0-linux-x86_64.AppImage", publish: null } });
    const downloaded = path.join(root, "dist/KAI-Core-Beta-99.0.0-linux-x86_64.AppImage"), target = path.join(root, "Installed KAI.AppImage");
    fs.copyFileSync(downloaded, target); fs.chmodSync(target, 0o755); const inode = fs.statSync(target).ino;
    const info = { size: fs.statSync(downloaded).size, sha256: crypto.createHash("sha256").update(fs.readFileSync(downloaded)).digest("hex") };
    const bootstrap = path.join(root, "old-app.cjs");
    fs.writeFileSync(bootstrap, `
const fs=require('node:fs');const {stageInstall,startHelper}=require(${JSON.stringify(path.resolve(__dirname, "../../electron/appimage-install.js"))});
(async()=>{const stage=await stageInstall({target:${JSON.stringify(target)},file:${JSON.stringify(downloaded)},info:${JSON.stringify(info)},parentPid:process.pid,
args:['--password-store=gnome-libsecret','--ozone-platform=headless',...(process.getuid?.()===0?['--no-sandbox']:[])],env:{...process.env,KAI_UPDATE_TEST_OUTPUT:${JSON.stringify(output)},KAI_UPDATE_TEST_PROFILE:${JSON.stringify(profile)}}});
await startHelper(stage);if(fs.existsSync(${JSON.stringify(output)}))throw Error('Update launched before old app shutdown');process.exit(0);})().catch(e=>{console.error(e);process.exit(1);});
`);
    await new Promise((resolve, reject) => {
      const child = spawn(require("electron"), [bootstrap], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit" });
      child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(Error(`Old application/helper failed (${code})`)));
    });
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(output) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert(fs.existsSync(output), fs.existsSync(target + ".update-error.txt") ? fs.readFileSync(target + ".update-error.txt", "utf8") : "Updated AppImage did not start");
    const value = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.equal(value.target, target); assert.equal(value.extract, "1"); assert(value.args.includes("--password-store=gnome-libsecret"));
    assert.equal(value.retained, "saved wallet/model settings fixture"); assert.notEqual(fs.statSync(target).ino, inode);
    assert(fs.existsSync(target + ".previous"));
    report.checks.push("Packaged x64 AppImage starts without FUSE after the original Electron process exits", "Real detached helper verifies and replaces at the same path, preserving the previous image", "Keyring launch flag, stable path and disposable profile survive relaunch");
    report.status = "passed";
  } catch (error) { report.status = "failed"; report.error = error.stack; throw error; }
  finally {
    fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2));
    if (report.status === "passed") fs.rmSync(root, { recursive: true, force: true });
    else console.error("AppImage verification workspace:", root);
    console.log("AppImage verification report:", path.join(reportDir, "report.json"));
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
