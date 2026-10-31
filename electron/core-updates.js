"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const semver = require("semver"), { CancellationToken, parseDn } = require("builder-util-runtime");
const PUBLISHER = "CN=Michael Milas, O=Michael Milas, L=Bennington, S=ne, C=US";
const RELEASES = "https://github.com/therexdev/kai-core/releases/latest";
const RELEASE_API = "https://api.github.com/repos/therexdev/kai-core/releases/latest";
const CHECK_INTERVAL = 6 * 60 * 60 * 1000, RETRY_INTERVAL = 15 * 60 * 1000, CHECK_TIMEOUT = 30 * 1000;
const DOWNLOAD_TIMEOUT = 45 * 60 * 1000, START_DELAY = 10 * 1000;

function publisherMatches(subject) {
  if (typeof subject !== "string") return false;
  const normalize = value => new Map([...parseDn(value)].map(([key, value]) => [key === "ST" ? "S" : key, value]));
  const actual = normalize(subject), expected = normalize(PUBLISHER);
  return actual.size === expected.size && [...expected].every(([key, value]) => actual.get(key) === value);
}
function validateSignatureRecord(record, file) {
  if (!record || record.status !== 0 || record.signatureType !== 1 || !publisherMatches(record.subject) ||
      typeof record.timestamp !== "string" || !/^[a-f0-9]{40,128}$/i.test(record.timestamp) || typeof record.path !== "string" || path.win32.normalize(record.path).toLowerCase() !== path.win32.normalize(file).toLowerCase()) {
    throw Error("The update does not have a valid, timestamped signature from Michael Milas.");
  }
}
// Unlike electron-updater's compatibility fallback, unavailable PowerShell or
// malformed output must never count as successful publisher verification.
async function verifyWindowsInstaller(file, { execFile = require("node:child_process").execFile, systemRoot = process.env.SystemRoot } = {}) {
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw Error("Windows signature verification is unavailable.");
  // Windows PowerShell can serialize first-use module progress to stderr even
  // after a successful command. Suppress progress at its source; stderr alone
  // is not a signature decision. A zero exit and the complete pinned signature
  // record below are both required before this installer is trusted.
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $s=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; [pscustomobject]@{status=[int]$s.Status;signatureType=[int]$s.SignatureType;path=$s.Path;subject=$s.SignerCertificate.Subject;timestamp=$s.TimeStamperCertificate.Thumbprint}|ConvertTo-Json -Compress`;
  const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const record = await new Promise((resolve, reject) => {
    execFile(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { windowsHide: true, shell: false, timeout: 30000, maxBuffer: 65536, encoding: "utf8" }, (error, stdout) => {
        if (error) {
          if (error.killed || error.code === "ETIMEDOUT") return reject(Error("Windows signature verification timed out. Check your connection and try again, or use the official download."));
          if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) return reject(Error("Windows could not start its signature checker. Use the official download, or check whether Windows PowerShell is blocked on this computer."));
          return reject(Error("Windows could not complete signature verification. Try again or use the official download."));
        }
        try { resolve(JSON.parse(String(stdout).replace(/^\uFEFF/, "").trim())); }
        catch { reject(Error("Windows returned an invalid signature verification result.")); }
      });
  });
  validateSignatureRecord(record, file);
}
function stableVersion(value) {
  const version = typeof value === "string" ? semver.valid(value) : null;
  return version && !semver.prerelease(version) && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}
function validateRelease(release) {
  const version = stableVersion(release?.tag_name);
  if (!version || release.draft === true || release.prerelease === true || release.tag_name !== `v${version}`) throw Error("The update service returned an invalid Core release.");
  return version;
}
function assertUpdateInfo(info, expectedVersion) {
  const version = stableVersion(info?.version);
  const name = `KAI-Core-Beta-Setup-${version}-x64.exe`;
  if (!version || version !== expectedVersion || info.tag !== `v${version}` || !Array.isArray(info.files)) throw Error("The available release changed. Check for updates again.");
  const files = info.files.filter(file => file.url === name);
  if (files.length !== 1 || info.files.length !== 1 || typeof files[0].sha512 !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/.test(files[0].sha512) || !Number.isSafeInteger(files[0].size) || files[0].size <= 0 || files[0].size > 3 * 1024 ** 3 || info.packages) {
    throw Error("The update does not contain the expected complete Core installer.");
  }
  return { version, name, sha512: files[0].sha512, size: files[0].size };
}
async function verifyDownloadedInstaller(file, info, verifySignature = verifyWindowsInstaller) {
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== info.size || path.basename(file) !== info.name) throw Error("The downloaded update is incomplete. Download it again.");
  const hash = crypto.createHash("sha512");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (hash.digest("base64") !== info.sha512) throw Error("The downloaded update changed. Download it again.");
  await verifySignature(file);
}
async function fetchLatestRelease(signal, fetchImpl = fetch) {
  const response = await fetchImpl(RELEASE_API, { signal, redirect: "error", headers: { Accept: "application/vnd.github+json", "User-Agent": "KAI-Core-Updates", "X-GitHub-Api-Version": "2022-11-28" } });
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw Error(response.status === 403 || response.status === 429 ? "Update checks are temporarily limited. Try again later." : "Could not check for Core updates. Check your connection and try again."); }
  const reader = response.body.getReader(); let bytes = 0; const chunks = [];
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 1024 * 1024) throw Error("The update response is too large."); chunks.push(Buffer.from(value)); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}
function createWindowsUpdater({ app, platform, env, resourcesPath, canNetwork, createUpdater, verifySignature = verifyWindowsInstaller }) {
  if (platform !== "win32") return { reason: "This build checks for updates here; use the official download to install them." };
  if (!app.isPackaged) return { reason: "Development builds check for releases; install the Windows Setup version for in-app updates." };
  if (env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR) return { reason: "Portable copies check for updates here. Download the new portable version, or use Windows Setup for in-app updates." };
  let config;
  try { config = require("js-yaml").load(fs.readFileSync(path.join(resourcesPath, "app-update.yml"), "utf8")); }
  catch { return { reason: "This copy has no verified update configuration. Install the latest Windows Setup version to enable in-app updates." }; }
  const names = Array.isArray(config?.publisherName) ? config.publisherName : [config?.publisherName];
  if (config?.provider !== "github" || config.owner !== "therexdev" || config.repo !== "kai-core" || names.length !== 1 || !publisherMatches(names[0])) {
    return { reason: "This copy has no verified update configuration. Install the latest Windows Setup version to enable in-app updates." };
  }
  const updater = createUpdater ? createUpdater() : new (require("electron-updater").NsisUpdater)({ provider: "github", owner: "therexdev", repo: "kai-core", private: false, releaseType: "release" });
  updater.autoDownload = false; updater.autoInstallOnAppQuit = false; updater.allowPrerelease = false; updater.allowDowngrade = false;
  updater.disableDifferentialDownload = true; updater.disableWebInstaller = true; updater.autoRunAppAfterInstall = true;
  updater.verifyUpdateCodeSignature = async (_publishers, file) => { await verifySignature(file); return null; };
  // Every metadata/download request, including redirects, obeys privacy changes.
  const requests = new Set(), executor = updater.httpExecutor, original = executor.createRequest.bind(executor), originalRequest = executor.request.bind(executor);
  let scope = null;
  executor.request = (options, suppliedToken, data) => {
    if (!scope || scope.token.cancelled || !canNetwork()) return Promise.reject(Error("The update check was cancelled."));
    const token = new CancellationToken(scope.token), cancel = () => token.cancel();
    suppliedToken?.onCancel(cancel);
    return originalRequest(options, token, data).finally(() => { suppliedToken?.removeListener("cancel", cancel); token.dispose(); });
  };
  executor.createRequest = (options, callback) => {
    const host = String(options.hostname || options.host || "").toLowerCase();
    if (!scope || scope.token.cancelled || !canNetwork() || options.protocol !== "https:" || !["github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(host)) throw Error("The update network request is not permitted.");
    const request = original(options, callback); requests.add(request); request.once("close", () => requests.delete(request)); return request;
  };
  return { updater, reason: null,
    beginRequest(signal) { const token = new CancellationToken(), cancel = () => token.cancel(); scope = { signal, token, cancel }; signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel(); },
    endRequest(signal) { if (scope?.signal !== signal) return; scope.signal.removeEventListener("abort", scope.cancel); scope.token.dispose(); scope = null; },
    abortRequests() { scope?.token.cancel(); for (const request of requests) request.abort(); requests.clear(); },
  };
}

function createCoreUpdates({ app, settings, isLocalOnly, approveInstall = async () => false, performInstall, openExternal, onChange = () => {},
  platform = process.platform, env = process.env, resourcesPath = process.resourcesPath, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  fetchRelease = fetchLatestRelease, adapterFactory = createWindowsUpdater, verifyInstaller = verifyDownloadedInstaller }) {
  const currentVersion = app.getVersion();
  let automaticCheck = settings.get("applicationUpdates.automaticCheck", true) !== false;
  let state = "idle", revision = 0, availableVersion = null, error = null, progress = null, lastCheckedAt = null, nextCheckAt = null;
  let started = false, disposed = false, timer = null, pending = null, controller = null, cancellation = null, eligibleAt = 0, installPromise = null;
  let downloaded = null, metadata = null;
  const adapter = adapterFactory({ app, platform, env, resourcesPath, canNetwork: () => !disposed && !isLocalOnly() });
  const updater = adapter.updater;
  const status = () => ({ state, revision, currentVersion, availableVersion, automaticCheck, lastCheckedAt, nextCheckAt, progress: progress ? { ...progress } : null, error,
    paused: isLocalOnly(), manualOnly: !updater, reason: adapter.reason || null,
    canDownload: !!updater && !!availableVersion && !isLocalOnly() && !disposed && ["available", "error"].includes(state),
    canInstall: !!updater && !!downloaded && !disposed && state === "downloaded" });
  function changed() { revision++; try { onChange(status()); } catch { /* Closing renderers are optional observers. */ } }
  function clearSchedule() { if (timer !== null) clearTimer(timer); timer = null; nextCheckAt = null; }
  function schedule(delay) {
    clearSchedule();
    if (!started || disposed || !automaticCheck || isLocalOnly() || state === "installing") return;
    eligibleAt = now() + delay; nextCheckAt = eligibleAt;
    timer = setTimer(() => { timer = null; nextCheckAt = null; void wake(); }, delay); timer?.unref?.();
  }
  function abortNetwork() { controller?.abort(); cancellation?.cancel(); adapter.abortRequests?.(); }
  const progressListener = value => { if (state !== "downloading" || disposed || isLocalOnly()) return; progress = { percent: Math.max(0, Math.min(100, Number(value.percent) || 0)), transferred: Math.max(0, Number(value.transferred) || 0), total: Math.max(0, Number(value.total) || 0) }; changed(); };
  // All operation errors are handled by awaited promises. An EventEmitter error
  // listener is still necessary after disposal, including installer startup.
  const errorListener = () => {};
  updater?.on("error", errorListener); updater?.on("download-progress", progressListener);
  function operation(kind, run, timeoutMs) {
    clearSchedule(); const request = new AbortController(); controller = request;
    adapter.beginRequest?.(request.signal);
    let timeout = false;
    const timeoutId = setTimer(() => { timeout = true; abortNetwork(); }, timeoutMs); timeoutId?.unref?.();
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => { rejectAbort = () => reject(Error("The update request was cancelled.")); request.signal.addEventListener("abort", rejectAbort, { once: true }); });
    const task = Promise.race([Promise.resolve().then(() => { request.signal.throwIfAborted(); return run(request.signal); }), aborted]).catch(problem => {
      if (!disposed) {
        state = availableVersion ? "available" : "idle"; progress = null;
        if (!isLocalOnly()) { state = "error"; error = timeout ? "The update request timed out. Try again." : String(problem?.message || "The update request failed.").slice(0, 500); }
      }
    }).finally(() => {
      clearTimer(timeoutId); if (controller === request) controller = null;
      request.signal.removeEventListener("abort", rejectAbort); adapter.endRequest?.(request.signal);
      if (pending?.promise === task) pending = null; cancellation = null;
      schedule(error ? RETRY_INTERVAL : CHECK_INTERVAL); changed();
    }).then(status);
    pending = { kind, promise: task }; return task;
  }
  function check() {
    if (disposed) return Promise.reject(Error("Core is closing."));
    if (isLocalOnly()) return Promise.reject(Error("Update checks are paused in Local-Only mode."));
    if (pending) return pending.kind === "check" ? pending.promise : Promise.resolve(status());
    if (["downloaded", "installing"].includes(state)) return Promise.resolve(status());
    state = "checking"; error = null; changed();
    return operation("check", async signal => {
      const release = await fetchRelease(signal); signal.throwIfAborted();
      const version = validateRelease(release);
      lastCheckedAt = now(); availableVersion = semver.gt(version, currentVersion) ? version : null;
      state = availableVersion ? "available" : "current"; error = null;
    }, CHECK_TIMEOUT);
  }
  function wake() {
    if (!started || disposed || !automaticCheck || isLocalOnly() || pending || ["downloaded", "installing"].includes(state) || now() < eligibleAt) return Promise.resolve(status());
    return check().catch(() => status());
  }
  function download() {
    if (disposed) return Promise.reject(Error("Core is closing."));
    if (isLocalOnly()) return Promise.reject(Error("Update downloads are paused in Local-Only mode."));
    if (!updater) return Promise.reject(Error("Use the official download for this build."));
    if (pending) return pending.kind === "download" ? pending.promise : pending.promise.then(download);
    if (!availableVersion || !["available", "error"].includes(state)) return Promise.resolve(status());
    state = "downloading"; error = null; progress = { percent: 0, transferred: 0, total: 0 }; downloaded = null; metadata = null; changed();
    return operation("download", async signal => {
      const result = await updater.checkForUpdates(); signal.throwIfAborted();
      if (!result?.isUpdateAvailable) throw Error("The release is no longer available. Check for updates again.");
      metadata = assertUpdateInfo(result.updateInfo, availableVersion);
      cancellation = new CancellationToken(); if (signal.aborted) cancellation.cancel();
      signal.addEventListener("abort", () => cancellation?.cancel(), { once: true });
      const files = await updater.downloadUpdate(cancellation); signal.throwIfAborted();
      if (!Array.isArray(files) || files.length !== 1 || updater.installerPath !== files[0]) throw Error("The update download did not return the expected installer.");
      await verifyInstaller(files[0], metadata); signal.throwIfAborted();
      downloaded = files[0]; progress = { percent: 100, transferred: metadata.size, total: metadata.size }; state = "downloaded"; error = null;
    }, DOWNLOAD_TIMEOUT);
  }
  function install() {
    if (installPromise) return installPromise;
    if (disposed || state !== "downloaded" || !downloaded || !metadata || !updater) return Promise.reject(Error("Download a verified Core update first."));
    const task = (async () => {
      if (!await approveInstall(availableVersion) || disposed) return status();
      try {
        if (updater.installerPath !== downloaded) throw Error("The downloaded installer changed. Download it again.");
        await verifyInstaller(downloaded, metadata);
        if (disposed) return status();
        state = "installing"; error = null; clearSchedule(); changed();
        await performInstall(updater); return status();
      } catch (problem) {
        downloaded = null; state = "error"; error = String(problem?.message || "The update could not be installed.").slice(0, 500); changed(); return status();
      }
    })().finally(() => { if (installPromise === task) installPromise = null; });
    installPromise = task; return task;
  }
  return {
    status, check, wake, download, install,
    start() { if (!started && !disposed) { started = true; schedule(START_DELAY); changed(); } return status(); },
    configure(input) {
      if (!input || typeof input.automaticCheck !== "boolean" || Object.keys(input).some(key => key !== "automaticCheck")) throw Error("Choose whether to check for updates automatically.");
      settings.set("applicationUpdates.automaticCheck", input.automaticCheck); automaticCheck = input.automaticCheck;
      if (automaticCheck) schedule(START_DELAY); else clearSchedule(); changed(); return status();
    },
    async openRelease() { if (disposed) throw Error("Core is closing."); if (isLocalOnly()) throw Error("Update downloads are paused in Local-Only mode."); await openExternal(RELEASES); return status(); },
    privacyChanged() { clearSchedule(); if (isLocalOnly()) { abortNetwork(); error = null; } else if (!pending) schedule(START_DELAY); changed(); return status(); },
    async dispose() { if (!disposed) { disposed = true; started = false; clearSchedule(); abortNetwork(); updater?.removeListener("download-progress", progressListener); } await pending?.promise; },
  };
}
module.exports = { createCoreUpdates, createWindowsUpdater, validateSignatureRecord, verifyWindowsInstaller, verifyDownloadedInstaller,
  validateRelease, assertUpdateInfo, publisherMatches, fetchLatestRelease, PUBLISHER, RELEASES, CHECK_INTERVAL, RETRY_INTERVAL, CHECK_TIMEOUT };
