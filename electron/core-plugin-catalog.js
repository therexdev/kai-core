"use strict";

const CHECK_INTERVAL = 15 * 60 * 1000;
const RETRY_INTERVAL = 5 * 60 * 1000;
const WAKE_THROTTLE = 60 * 1000;
const BUSY_RETRY = 30 * 1000;
const REQUEST_TIMEOUT = 30 * 1000;

// A repository is catalog attribution, not proof that GitHub controls a signing
// key. Never borrow it from an entry that merely reuses an installed plugin ID.
function installedCatalogMetadata(installed, entries, bundled = []) {
  const sources = [...entries, ...bundled];
  return installed.map(plugin => {
    const match = sources.find(entry => entry.id === plugin.id &&
      typeof plugin.fingerprint === "string" && /^[a-f0-9]{64}$/.test(plugin.fingerprint) && entry.fingerprint === plugin.fingerprint);
    if (!match) return plugin;
    const repository = match.repository;
    if (typeof repository !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || /\/\.{1,2}$/.test(repository)) return plugin;
    return { ...plugin, repository, description: plugin.description || match.description || "" };
  });
}

// This monitor only refreshes the signed catalog. Package downloads, permission
// reviews and installation remain separate, explicit desktop operations.
function createCatalogMonitor({ registry, isLocalOnly, isBusy = () => false, onChange = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let started = false, disposed = false, pending = null, controller = null, timer = null;
  let lastAttemptAt = null, lastCheckedAt = null, nextCheckAt = null, eligibleAt = 0, error = null, resumeRequested = false;
  const status = () => ({ checking: !!pending, lastAttemptAt, lastCheckedAt, nextCheckAt, error, paused: isLocalOnly() });
  function changed() {
    // UI delivery must not turn a verified catalog refresh into a failure.
    try { const result = onChange(status()); result?.catch?.(() => {}); } catch { /* Window may already be closed. */ }
  }
  function clearSchedule() {
    if (timer !== null) clearTimer(timer);
    timer = null; nextCheckAt = null;
  }
  function schedule(delay) {
    clearSchedule();
    if (!started || disposed || isLocalOnly()) return;
    nextCheckAt = now() + Math.max(0, delay);
    timer = setTimer(() => { timer = null; nextCheckAt = null; void wake(); }, Math.max(0, delay));
    timer?.unref?.();
  }
  function check(manual) {
    if (disposed) return manual ? Promise.reject(Error("Plugin catalog checks are closing")) : Promise.resolve(status());
    if (pending) return pending;
    if (isLocalOnly()) {
      clearSchedule();
      return manual ? Promise.reject(Error("Plugin catalog checks are unavailable in Local-Only mode")) : Promise.resolve(status());
    }
    if (!manual && now() < eligibleAt) {
      if (timer === null) schedule(eligibleAt - now());
      return Promise.resolve(status());
    }
    if (isBusy()) {
      if (!manual) schedule(BUSY_RETRY);
      return manual ? Promise.reject(Error("Finish the current plugin installation first")) : Promise.resolve(status());
    }
    clearSchedule(); lastAttemptAt = now(); eligibleAt = lastAttemptAt + WAKE_THROTTLE;
    const request = new AbortController(); controller = request;
    const timeout = setTimer(() => request.abort(Error("Plugin catalog check timed out")), REQUEST_TIMEOUT);
    timeout?.unref?.();
    let failed = false;
    // Assign pending before invoking the registry so callbacks and a simultaneous
    // manual refresh join this same request instead of starting another writer.
    const task = Promise.resolve().then(async () => {
      request.signal.throwIfAborted();
      const result = await registry.refresh({ localOnly: isLocalOnly(), signal: request.signal });
      request.signal.throwIfAborted();
      lastCheckedAt = now(); error = null;
      return result;
    }).catch(problem => {
      failed = true;
      if (!disposed && !isLocalOnly() && !resumeRequested) {
        error = String(problem?.message || "Plugin catalog check failed").slice(0, 400);
        eligibleAt = now() + RETRY_INTERVAL;
      }
      throw problem;
    }).finally(() => {
      clearTimer(timeout);
      if (controller === request) controller = null;
      if (pending === task) pending = null;
      if (resumeRequested) { resumeRequested = false; schedule(0); }
      else schedule(failed ? RETRY_INTERVAL : CHECK_INTERVAL);
      changed();
    });
    pending = task; changed();
    return task;
  }
  function wake() { return check(false).catch(() => status()); }
  return {
    status,
    start() { if (started || disposed) return Promise.resolve(status()); started = true; return wake(); },
    wake,
    refresh: () => check(true),
    waitForIdle: () => pending ? pending.catch(() => {}) : Promise.resolve(),
    privacyChanged() {
      clearSchedule();
      if (isLocalOnly()) {
        resumeRequested = false; controller?.abort(Error("Plugin catalog check paused by Local-Only mode"));
        error = null; changed(); return Promise.resolve(status());
      }
      // A transition back online may occur before an aborted download settles.
      // Queue exactly one fresh check after that writer releases its cache.
      eligibleAt = 0; error = null;
      if (pending) { resumeRequested = true; return pending.catch(() => status()); }
      return started ? wake() : Promise.resolve(status());
    },
    async dispose() {
      if (!disposed) { disposed = true; started = false; clearSchedule(); controller?.abort(Error("Plugin catalog checks are closing")); }
      await pending?.catch(() => {});
    },
  };
}

module.exports = { createCatalogMonitor, installedCatalogMetadata, CHECK_INTERVAL, RETRY_INTERVAL, WAKE_THROTTLE, BUSY_RETRY, REQUEST_TIMEOUT };
