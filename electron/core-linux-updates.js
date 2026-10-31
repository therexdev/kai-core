"use strict";
const fs = require("node:fs"), path = require("node:path"), { EventEmitter } = require("node:events");
const semver = require("semver");
const { verifyImage, identity, stageInstall, startHelper } = require("./appimage-install");
const ORIGIN = "https://github.com/therexdev/kai-core/releases/download/";
const HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
function assetInfo(release, arch) {
  const version = typeof release?.tag_name === "string" ? semver.valid(release.tag_name) : null;
  if (!version || semver.prerelease(version) || release.tag_name !== `v${version}` || release.draft || release.prerelease) throw Error("The update service returned an invalid Core release.");
  const suffix = { x64: "x86_64", arm64: "arm64" }[arch];
  if (!suffix) throw Error("This Linux architecture needs a manual download.");
  const name = `KAI-Core-Beta-${version}-linux-${suffix}.AppImage`;
  const assets = release.assets?.filter(asset => asset.name === name);
  if (assets?.length !== 1 || assets[0].state !== "uploaded" || !/^sha256:[a-f0-9]{64}$/.test(assets[0].digest) ||
      !Number.isSafeInteger(assets[0].size) || assets[0].size < 12 || assets[0].size > 3 * 1024 ** 3 ||
      assets[0].browser_download_url !== `${ORIGIN}v${version}/${name}`) throw Error("This release has no complete, checksum-verified AppImage for this computer.");
  return { version, tag: release.tag_name, name, url: assets[0].browser_download_url, size: assets[0].size, sha256: assets[0].digest.slice(7) };
}
function assertLinuxInfo(info, expectedVersion) {
  if (info?.version !== expectedVersion || info.tag !== `v${expectedVersion}` || !/^\d+\.\d+\.\d+$/.test(expectedVersion) ||
      !["arm64", "x86_64"].some(suffix => info.name === `KAI-Core-Beta-${expectedVersion}-linux-${suffix}.AppImage`) ||
      info.url !== `${ORIGIN}${info.tag}/${info.name}` || !/^[a-f0-9]{64}$/.test(info.sha256) || !Number.isSafeInteger(info.size) || info.size < 12 || info.size > 3 * 1024 ** 3) throw Error("The available AppImage release changed. Check for updates again.");
  return { ...info };
}
async function assetResponse(url, { signal, fetchImpl = fetch, canNetwork }) {
  for (let redirects = 0; redirects < 6; redirects++) {
    signal.throwIfAborted(); const parsed = new URL(url);
    if (!canNetwork() || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port && parsed.port !== "443" || !HOSTS.has(parsed.hostname)) throw Error("The AppImage download request is not permitted.");
    const response = await fetchImpl(url, { signal, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel(); const location = response.headers.get("location"); if (!location) throw Error("Invalid update download redirect."); url = new URL(location, url).href; continue;
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw Error("Could not download the AppImage. Try again."); }
    return response;
  }
  throw Error("Too many update download redirects.");
}
function createLinuxUpdater({ app, platform, arch = process.arch, env, canNetwork, fetchRelease, fetchImpl = fetch, helperStarter = startHelper }) {
  if (platform !== "linux" || !app.isPackaged || !["arm64", "x64"].includes(arch)) return { reason: "Use the official download for this build." };
  const target = env.KAI_CORE_APPIMAGE_PATH || env.APPIMAGE;
  try {
    if (!target || !path.isAbsolute(target) || target.includes("\0")) throw Error();
    identity(target); fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK); fs.accessSync(path.dirname(target), fs.constants.W_OK);
  } catch { return { reason: "Install the Linux AppImage in a folder owned by your desktop account to enable updates here." }; }
  let signal, info, directory, downloading = false;
  const updater = new EventEmitter(); updater.installerPath = null;
  updater.checkForUpdates = async () => {
    const requestSignal = signal; requestSignal.throwIfAborted();
    const checked = assetInfo(await fetchRelease(requestSignal), arch); requestSignal.throwIfAborted();
    info = checked; return { isUpdateAvailable: semver.gt(checked.version, app.getVersion()), updateInfo: checked };
  };
  updater.downloadUpdate = async () => {
    signal.throwIfAborted(); if (!info || downloading) throw Error("Check for an AppImage update first.");
    const requestSignal = signal, downloadInfo = { ...info };
    downloading = true;
    let file, output;
    try {
      if (directory) await fs.promises.rm(directory, { recursive: true, force: true });
      const cache = path.join(app.getPath("userData"), "core-updates"); await fs.promises.mkdir(cache, { recursive: true, mode: 0o700 });
      directory = await fs.promises.mkdtemp(path.join(cache, "appimage-"));
      file = path.join(directory, downloadInfo.name); output = await fs.promises.open(file, "wx", 0o600);
      const response = await assetResponse(downloadInfo.url, { signal: requestSignal, fetchImpl, canNetwork });
      let transferred = 0;
      for await (const chunk of response.body) {
        requestSignal.throwIfAborted(); if (!canNetwork()) throw Error("Update downloads are paused in Local-Only mode.");
        transferred += chunk.byteLength; if (transferred > downloadInfo.size) throw Error("The AppImage download is larger than the official release.");
        await output.writeFile(chunk);
        updater.emit("download-progress", { transferred, total: downloadInfo.size, percent: 100 * transferred / downloadInfo.size });
      }
      await output.sync(); await output.close(); output = null; requestSignal.throwIfAborted();
      await verifyImage(file, downloadInfo); requestSignal.throwIfAborted(); updater.installerPath = file; return [file];
    } catch (error) { updater.installerPath = null; await output?.close().catch(() => {}); if (directory) await fs.promises.rm(directory, { recursive: true, force: true }); throw error; }
    finally { downloading = false; }
  };
  updater.quitAndInstall = async () => {
    const args = process.argv.filter(arg => /^--password-store=(?:gnome-libsecret|kwallet|kwallet5|kwallet6)$/.test(arg) || /^--ozone-platform=(?:auto|wayland|x11|headless)$/.test(arg));
    if (!args.some(arg => arg.startsWith("--password-store=")) && arch === "arm64") args.push("--password-store=gnome-libsecret");
    const stage = await stageInstall({ target, file: updater.installerPath, info, parentPid: process.pid, args, env });
    try { await helperStarter(stage, { env }); }
    catch (error) { await fs.promises.rm(stage.directory, { recursive: true, force: true }); throw error; }
    app.quit();
  };
  return { updater, reason: null, assertUpdateInfo: assertLinuxInfo, verifyInstaller: verifyImage,
    beginRequest(requestSignal) { signal = requestSignal; }, endRequest() {}, abortRequests() {} };
}
module.exports = { createLinuxUpdater, assetInfo, assertLinuxInfo, assetResponse };
