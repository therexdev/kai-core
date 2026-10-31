"use strict";
(function (root) {
  const busyStates = new Set(["checking", "downloading", "installing"]);
  const cleanError = error => String(error?.message || error || "The update could not be completed.").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  function presentation(info, pending = null) {
    const state = info?.state || "idle", version = info?.availableVersion;
    const busy = busyStates.has(state) || !!pending;
    let title = "Ready to check for updates", detail = "You choose when to download and restart.";
    if (state === "checking" || pending === "check") { title = "Checking for updates…"; detail = "Looking for the latest KAI Core Beta release."; }
    else if (state === "installing" || pending === "install") { title = "Preparing to restart…"; detail = "KAI will close its running services before installing the update."; }
    else if (state === "downloaded") { title = "Your update is ready"; detail = `Version ${version} is downloaded and verified. Restart when you’re ready to install it.`; }
    else if (state === "downloading" || pending === "download") { title = "Downloading your update…"; detail = "You can keep using KAI. It will not restart on its own."; }
    else if (state === "available") { title = `Version ${version} is available`; detail = info.manualOnly ? "Download the release for this computer, then close KAI and run the installer or replace the app." : "Download the update now and choose when to restart KAI."; }
    else if (state === "current") { title = "You’re up to date"; detail = "You have the latest available KAI Core Beta release."; }
    else if (state === "error") { title = "Update needs attention"; detail = "Your current version is still available to use. Try again when you’re ready."; }
    if (info?.paused && !["installing", "downloaded"].includes(state) && pending !== "install") {
      title = "Update checks are paused";
      detail = "Local only is on. Choose Local first or Network above to check for updates and download them.";
    } else if (info?.manualOnly && info.reason && !busyStates.has(state) && state !== "error") detail = info.reason;
    const downloading = state === "downloading" || pending === "download";
    const hasUpdate = !!version && ["available", "downloading", "downloaded", "installing", "error"].includes(state);
    return {
      title, detail, busy, state, hasUpdate, downloading,
      checkDisabled: busy || !!info?.paused || !info,
      checkLabel: state === "checking" || pending === "check" ? "Checking…" : state === "error" ? "Check again" : "Check for updates",
      downloadVisible: !!info?.canDownload && !info?.manualOnly,
      downloadDisabled: busy || !!info?.paused,
      installVisible: !!info?.canInstall,
      installDisabled: busy,
      automaticDisabled: pending === "configure" || state === "installing" || !info,
      releaseVisible: !["downloading", "installing"].includes(state),
      releaseLabel: info?.manualOnly && hasUpdate ? "Download release" : "View downloads",
      releasePrimary: !!info?.manualOnly && hasUpdate,
      releaseDisabled: busy || !!info?.paused || !info,
      percent: Number.isFinite(info?.progress?.percent) ? Math.max(0, Math.min(100, info.progress.percent)) : 0,
    };
  }
  function createUpdates({ call, render = () => {} }) {
    let info = null, pending = null, refreshing = false, active = false, localError = "", dismissedError = "";
    const snapshot = () => ({ info: info && structuredClone(info), pending, active, error: localError || info?.error || "" });
    const paint = () => { const state = snapshot(); render(state, { ...presentation(info, pending), error: state.error === dismissedError ? "" : state.error }); };
    function observe(value) {
      if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || info && value.revision < info.revision) return;
      info = structuredClone(value); paint();
    }
    async function refresh() {
      if (refreshing) return;
      refreshing = true;
      try { observe(await call("updates.status")); }
      catch (error) { if (active) { localError = cleanError(error); paint(); } }
      finally { refreshing = false; }
    }
    async function act(action, value) {
      if (pending) return;
      const view = presentation(info);
      if (action === "check" && view.checkDisabled || action === "download" && (!view.downloadVisible || view.downloadDisabled) || action === "install" && (!view.installVisible || view.installDisabled) || action === "configure" && view.automaticDisabled || action === "openRelease" && view.releaseDisabled) return;
      if (!["check", "download", "install", "configure", "openRelease"].includes(action)) return;
      pending = action; localError = ""; dismissedError = ""; paint();
      try { observe(await call(`updates.${action}`, action === "configure" ? { automaticCheck: value === true } : undefined)); }
      catch (error) { localError = cleanError(error); }
      finally { pending = null; paint(); await refresh(); }
    }
    return { observe, refresh, act, snapshot, enter() { active = true; return refresh(); }, leave() { active = false; },
      dismissError() { dismissedError = localError || info?.error || ""; paint(); } };
  }
  if (typeof module === "object") module.exports = { createUpdates, presentation };
  if (!root?.document || !root.kaiCore?.call) return;
  const $ = id => root.document.getElementById(id), card = $("application-updates"); if (!card) return;
  const text = (id, value) => { const node = $(id), next = String(value ?? ""); if (node.textContent !== next) node.textContent = next; };
  const controller = createUpdates({ call: (method, input) => root.kaiCore.call(method, input), render(state, view) {
    const info = state.info;
    card.dataset.state = view.state;
    text("updates-version", info?.currentVersion ? `KAI Core Beta · Version ${info.currentVersion}` : "KAI Core Beta");
    text("updates-title", view.title); text("updates-detail", view.detail);
    text("updates-badge", view.hasUpdate ? info.state === "downloaded" ? "Ready to install" : "Update available" : ""); $("updates-badge").hidden = !view.hasUpdate;
    $("core-update-badge").hidden = !view.hasUpdate;
    $("settings-nav").setAttribute("aria-label", view.hasUpdate ? "Settings, Core update available" : "Settings");
    $("settings-nav").title = view.hasUpdate ? "Settings · Core update available" : "Settings";
    $("updates-automatic").checked = info?.automaticCheck !== false; $("updates-automatic").disabled = view.automaticDisabled;
    $("check-updates").disabled = view.checkDisabled; text("check-updates", view.checkLabel);
    $("updates-download").hidden = !view.downloadVisible; $("updates-download").disabled = view.downloadDisabled;
    $("updates-install").hidden = !view.installVisible; $("updates-install").disabled = view.installDisabled;
    $("updates-open-release").hidden = !view.releaseVisible; $("updates-open-release").disabled = view.releaseDisabled;
    text("updates-open-release", view.releaseLabel); $("updates-open-release").classList.toggle("primary", view.releasePrimary); $("updates-open-release").classList.toggle("text-button", !view.releasePrimary);
    $("updates-progress-row").hidden = !view.downloading; $("updates-progress").value = view.percent; text("updates-progress-value", `${Math.floor(view.percent)}%`);
    const checked = info?.lastCheckedAt && new Date(info.lastCheckedAt);
    text("updates-last-checked", checked && !Number.isNaN(checked.valueOf()) ? `Last checked ${checked.toLocaleString()}` : "Not checked yet");
    text("update-state", view.error); $("update-notice").hidden = !view.error;
  } });
  $("check-updates").addEventListener("click", () => void controller.act("check"));
  $("updates-download").addEventListener("click", () => void controller.act("download"));
  $("updates-install").addEventListener("click", () => void controller.act("install"));
  $("updates-open-release").addEventListener("click", () => void controller.act("openRelease"));
  $("updates-automatic").addEventListener("change", event => void controller.act("configure", event.target.checked));
  $("update-close").addEventListener("click", () => { controller.dismissError(); $("check-updates").focus(); });
  root.KaiCoreUpdates = controller;
  root.document.addEventListener("visibilitychange", () => { if (!root.document.hidden && controller.snapshot().active) void controller.refresh(); });
  setInterval(() => { if (!root.document.hidden && controller.snapshot().active) void controller.refresh(); }, 1000);
})(typeof window === "undefined" ? null : window);
