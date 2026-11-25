"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { spawn } = require("node:child_process");
const FLAG = "--kai-credit-source-helper";
const failure = () => Error("The original purchase connection could not be opened. Keep the Alpha profile and its original operating-system credentials.");
function regular(file, maximum) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw failure();
  return fs.readFileSync(file);
}
function access(value, expected) {
  if (value?.identity !== expected || !/^[a-f0-9]{64}$/.test(value?.installation || "")) throw failure();
  return { identity: expected, installation: value.installation };
}
// Windows OSCrypt keys belong to the Electron userData profile. Let a separate
// copy of the signed Core executable use the original protected Local State key;
// never export that key, change Core's key, or start any Alpha code/services.
async function readInstallation({ profile, ciphertext, identity, signal, runtime }) {
  if (process.platform !== "win32" || !Buffer.isBuffer(ciphertext) || ciphertext.length > 16384 || !/^[a-f0-9]{64}$/.test(identity)) throw failure();
  signal?.throwIfAborted();
  const state = JSON.parse(regular(path.join(path.dirname(profile), "Local State"), 1024 * 1024));
  const encrypted = state?.os_crypt?.encrypted_key;
  if (typeof encrypted !== "string" || encrypted.length > 16384 || Buffer.from(encrypted, "base64").toString("base64") !== encrypted ||
      Buffer.from(encrypted, "base64").subarray(0, 5).toString() !== "DPAPI") throw failure();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kai-credit-source-"));
  try {
    fs.chmodSync(temp, 0o700);
    fs.writeFileSync(path.join(temp, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: encrypted, audit_enabled: state.os_crypt.audit_enabled === true } }), { mode: 0o600, flag: "wx" });
    fs.writeFileSync(path.join(temp, "request.json"), JSON.stringify({ identity, ciphertext: ciphertext.toString("base64") }), { mode: 0o600, flag: "wx" });
    const app = runtime ? null : require("electron").app;
    const executable = runtime?.executable || process.execPath;
    const args = runtime ? [runtime.appPath, FLAG, temp] : [...(app.isPackaged ? [] : [app.getAppPath()]), FLAG, temp];
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_ENABLE_LOGGING;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      let output = Buffer.alloc(0), stopped = false;
      const stop = () => { stopped = true; child.kill(); };
      const timer = setTimeout(stop, 20000);
      signal?.addEventListener("abort", stop, { once: true });
      child.stdout.on("data", chunk => { if (output.length + chunk.length > 2048) stop(); else output = Buffer.concat([output, chunk]); });
      child.on("error", () => { stopped = true; });
      child.on("close", code => {
        clearTimeout(timer); signal?.removeEventListener("abort", stop);
        try {
          signal?.throwIfAborted();
          if (stopped || code !== 0) throw failure();
          resolve(access(JSON.parse(output.toString("utf8")), identity));
        } catch { reject(failure()); } finally { output.fill(0); }
      });
      if (signal?.aborted) stop();
    });
    signal?.throwIfAborted(); return result;
  } finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
}
function runHelper({ app, safeStorage }) {
  const finish = (value, code) => process.stdout.write(JSON.stringify(value), () => app.exit(code));
  try {
    if (process.platform !== "win32") throw failure();
    const index = process.argv.indexOf(FLAG), temp = process.argv[index + 1];
    if (index < 0 || process.argv.length !== index + 2 || !path.isAbsolute(temp || "") || !/^kai-credit-source-[A-Za-z0-9]+$/.test(path.basename(temp))) throw failure();
    const stat = fs.lstatSync(temp); if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure();
    const request = JSON.parse(regular(path.join(temp, "request.json"), 32768));
    if (typeof request.ciphertext !== "string" || !/^[a-f0-9]{64}$/.test(request.identity || "")) throw failure();
    const bytes = Buffer.from(request.ciphertext, "base64");
    if (bytes.length > 16384 || bytes.toString("base64") !== request.ciphertext) throw failure();
    regular(path.join(temp, "Local State"), 32768);
    app.setName("KAI Purchase Recovery"); app.setPath("userData", temp); app.setPath("sessionData", temp); app.disableHardwareAcceleration();
    app.whenReady().then(() => {
      try {
        if (!safeStorage.isEncryptionAvailable()) throw failure();
        finish(access(JSON.parse(safeStorage.decryptString(bytes)), request.identity), 0);
      } catch { finish({ error: "SOURCE_CONNECTION_UNAVAILABLE" }, 1); }
    }).catch(() => finish({ error: "SOURCE_CONNECTION_UNAVAILABLE" }, 1));
  } catch { finish({ error: "SOURCE_CONNECTION_UNAVAILABLE" }, 1); }
}
module.exports = { FLAG, readInstallation, runHelper };
