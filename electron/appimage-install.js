"use strict";
// Also copied outside app.asar and run by a detached Electron/Node helper.
// No relative imports: the old AppImage's extraction may disappear on exit.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
async function verifyImage(file, info) {
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== info.size) throw Error("The AppImage download is incomplete or changed.");
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== info.sha256) throw Error("The AppImage checksum does not match the official release.");
  const handle = await fs.promises.open(file, "r");
  try {
    const header = Buffer.alloc(12); await handle.read(header, 0, header.length, 0);
    if (!header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || !header.subarray(8, 11).equals(Buffer.from([65, 73, 2]))) throw Error("The download is not a supported AppImage.");
  } finally { await handle.close(); }
}
function identity(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error("The installed AppImage must be a regular file.");
  if (process.getuid && stat.uid !== process.getuid()) throw Error("The AppImage must be owned by your desktop account.");
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}
function sameIdentity(a, b) { return Object.keys(a).every(key => a[key] === b[key]); }
function launchEnv(env, target) {
  const clean = { ...env, APPIMAGE_EXTRACT_AND_RUN: "1", KAI_CORE_APPIMAGE_PATH: target };
  for (const name of ["ELECTRON_RUN_AS_NODE", "APPIMAGE", "APPDIR", "ARGV0", "OWD", "APPIMAGE_EXIT_AFTER_INSTALL", "APPIMAGE_SILENT_INSTALL"]) delete clean[name];
  return clean;
}
async function stageInstall({ target, file, info, parentPid, args = [], env = process.env }) {
  const before = identity(target), directory = await fs.promises.mkdtemp(path.join(path.dirname(target), ".kai-core-update-"));
  try {
    await fs.promises.chmod(directory, 0o700);
    const staged = path.join(directory, "next.AppImage");
    await fs.promises.copyFile(file, staged, fs.constants.COPYFILE_EXCL);
    await verifyImage(staged, info); await fs.promises.chmod(staged, 0o755);
    const handle = await fs.promises.open(staged, "r+"); try { await handle.sync(); } finally { await handle.close(); }
    const helper = path.join(directory, "install.cjs"), jobFile = path.join(directory, "job.json");
    await fs.promises.copyFile(__filename, helper);
    await fs.promises.writeFile(jobFile, JSON.stringify({ target, staged, before, info, parentPid, args, env: launchEnv(env, target) }), { mode: 0o600, flag: "wx" });
    return { directory, helper, jobFile };
  } catch (error) { await fs.promises.rm(directory, { recursive: true, force: true }); throw error; }
}
function startHelper(stage, { executable = process.execPath, env = process.env, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, [stage.helper, stage.jobFile], { detached: true, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let ready = false;
    const timer = setTimeout(() => finish(Error("The update helper did not start. Open KAI and try again.")), 15000);
    function finish(error) {
      clearTimeout(timer); child.removeListener("error", onError); child.removeListener("exit", onExit); child.removeListener("message", onMessage);
      if (error) { child.kill(); reject(error); }
      else { child.unref(); child.channel?.unref(); resolve(); }
    }
    const onError = error => finish(error), onExit = () => { if (!ready) finish(Error("The update helper exited before it was ready.")); };
    const onMessage = message => { if (message?.ready === true && !ready) { ready = true; finish(); } };
    child.once("error", onError); child.once("exit", onExit); child.on("message", onMessage);
  });
}
function launch(target, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(target, args, { detached: true, stdio: "ignore", env });
    child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
  });
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }
async function installStaged(job, { isAlive = alive, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), launchImpl = launch } = {}) {
  const deadline = Date.now() + 60000;
  while (isAlive(job.parentPid)) {
    if (Date.now() >= deadline) throw Error("KAI did not close. The current AppImage was kept.");
    await wait(100);
  }
  // Revalidate after shutdown, immediately before the atomic replacement.
  await verifyImage(job.staged, job.info);
  if (!sameIdentity(job.before, identity(job.target))) throw Error("The installed AppImage changed during the update. No file was replaced.");
  const backup = job.target + ".previous", link = path.join(path.dirname(job.staged), "previous.AppImage");
  await fs.promises.link(job.target, link);
  await fs.promises.rename(link, backup);
  await fs.promises.rename(job.staged, job.target);
  const directory = await fs.promises.open(path.dirname(job.target), "r"); try { await directory.sync(); } finally { await directory.close(); }
  try { await launchImpl(job.target, job.args, job.env); }
  catch (error) {
    // A process-start failure restores the old application at the same path.
    await fs.promises.copyFile(backup, job.staged);
    await fs.promises.rename(job.staged, job.target);
    throw Error(`The new app could not start; the previous app was restored. ${error.message}`);
  }
}
async function main(jobFile) {
  const job = JSON.parse(await fs.promises.readFile(jobFile, "utf8"));
  if (!Number.isSafeInteger(job.parentPid) || job.parentPid <= 1 || !path.isAbsolute(job.target)) throw Error("Invalid AppImage installation job.");
  await verifyImage(job.staged, job.info);
  if (process.send) await new Promise((resolve, reject) => process.send({ ready: true }, error => error ? reject(error) : resolve()));
  if (process.connected) process.disconnect();
  try { await installStaged(job); }
  catch (error) {
    await fs.promises.writeFile(job.target + ".update-error.txt", String(error.message), { mode: 0o600 });
    // If replacement failed, reopening the old path keeps the user on a usable app.
    if (!alive(job.parentPid)) await launch(job.target, job.args, job.env).catch(() => {});
  } finally { await fs.promises.rm(path.dirname(jobFile), { recursive: true, force: true }); }
}
if (require.main === module) main(process.argv[2]).catch(() => { process.exitCode = 1; });
module.exports = { verifyImage, identity, launchEnv, stageInstall, startHelper, installStaged };
