"use strict";
// Real Windows Electron OSCrypt/DPAPI, two separate userData profiles. The
// installation identifiers are synthetic; no user wallet or service is opened.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { readInstallation } = require("../../electron/credit-purchase-native-recovery");
async function main() {
  if (process.platform !== "win32") { console.log("Windows protected-profile check is Windows-only."); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-native-source-test-"));
  const original = path.join(root, "original"), current = path.join(root, "current"), profile = path.join(original, "core");
  const fixture = { identity: "a".repeat(64), installation: "b".repeat(64) }, record = path.join(profile, "purchase-installation.enc");
  fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(current);
  const executable = require("electron"), appPath = path.resolve(__dirname, "../..");
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  async function electronScript(name, code) {
    const file = path.join(root, name + ".js"); fs.writeFileSync(file, code);
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [file], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = ""; const timer = setTimeout(() => child.kill(), 30000);
      child.stdout.on("data", b => out += b); child.stderr.on("data", b => err = (err + b).slice(-4096)); child.on("error", reject);
      child.on("close", code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(Error(name + " exited " + code + ": " + err)); });
    });
  }
  try {
    const setup = directory => `const {app,safeStorage}=require('electron'); const fs=require('node:fs'); app.setPath('userData',${JSON.stringify(directory)}); app.setPath('sessionData',${JSON.stringify(directory)}); app.disableHardwareAcceleration();`;
    await electronScript("create-original", setup(original) + `app.whenReady().then(()=>{fs.writeFileSync(${JSON.stringify(record)},safeStorage.encryptString(${JSON.stringify(JSON.stringify(fixture))}));app.quit();});`);
    assert.ok(JSON.parse(fs.readFileSync(path.join(original, "Local State"))).os_crypt.encrypted_key);
    const wrong = await electronScript("different-core-profile", setup(current) + `app.whenReady().then(()=>{let opened=false;try{safeStorage.decryptString(fs.readFileSync(${JSON.stringify(record)}));opened=true;}catch{}process.stdout.write(JSON.stringify({opened}),()=>app.quit());});`);
    assert.equal(JSON.parse(wrong).opened, false, "a fresh Core profile must not decrypt the original profile's record directly");
    const originals = [path.join(original, "Local State"), path.join(current, "Local State"), record];
    const bytes = originals.map(file => fs.readFileSync(file));
    const options = { profile, ciphertext: bytes[2], identity: fixture.identity, runtime: { executable, appPath } };
    assert.deepEqual(await readInstallation(options), fixture);
    const altered = Buffer.from(bytes[2]); altered[altered.length - 1] ^= 1;
    await assert.rejects(readInstallation({ ...options, ciphertext: altered }));
    await assert.rejects(readInstallation({ ...options, identity: "c".repeat(64) }));
    originals.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), bytes[i], "original protected profiles stay unchanged"));
    const keys = originals.slice(0, 2).map(file => JSON.parse(fs.readFileSync(file)).os_crypt.encrypted_key);
    assert.notEqual(keys[0], keys[1]);
    console.log(JSON.stringify({ status: "passed", realWindowsDpapi: true, separateProfileKeys: true, originalProfilesUnchanged: true, tamperedRecordRejected: true, wrongIdentityRejected: true, recoveredFields: ["identity", "installation"] }));
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
