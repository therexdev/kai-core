"use strict";

// Electron's inspector can collect its evaluation promise even when a
// synchronous observation ran successfully. Only repeat read-only observations;
// an action may already have happened before its result was lost.
const collected = error => /^(?:electronApplication\.evaluate: )?Resulting promise was garbage collected\.$/.test(String(error?.message || ""));

async function waitForInspectorObservation(read, { message, timeoutMs = 30000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const expired = () => Error(message || "Inspector observation did not become ready");
  let deadlineTimer, delayTimer, wakeDelay;
  let finished = false;
  const deadlineReached = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => reject(expired()), timeoutMs);
  });
  const polling = (async () => {
    while (!finished && Date.now() < deadline) {
      try {
        const ready = await read();
        if (finished || Date.now() >= deadline) throw expired();
        if (ready) return ready;
      } catch (error) {
        if (!collected(error)) throw error;
      }
      const remaining = deadline - Date.now();
      if (finished || remaining <= 0) break;
      await new Promise(resolve => { wakeDelay = resolve; delayTimer = setTimeout(resolve, Math.min(intervalMs, remaining)); });
    }
    throw expired();
  })();
  try { return await Promise.race([polling, deadlineReached]); }
  finally {
    finished = true;
    clearTimeout(deadlineTimer); clearTimeout(delayTimer); wakeDelay?.();
  }
}

module.exports = { waitForInspectorObservation };
