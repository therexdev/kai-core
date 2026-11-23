"use strict";
const { setTimeout: delay } = require("node:timers/promises");

const transient = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
function interruptedDownload(error) {
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth++) {
    if (transient.has(current.code) || current.name === "TypeError" && current.message === "terminated" ||
        /^Download failed: HTTP (408|429|500|502|503|504)$/.test(current.message || "") ||
        /^Download stalled — no data from the mirror/.test(current.message || "")) return true;
  }
  return false;
}

// Release-only preparation: the normal downloader retains its .part file and
// verifies the complete pinned hash before loading. Never wrap inference calls.
async function prepareModel(prepare, { signal, onRetry = () => {}, wait = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    signal?.throwIfAborted();
    try { return await prepare(); }
    catch (error) {
      signal?.throwIfAborted();
      if (attempt === 4 || !interruptedDownload(error)) throw error;
      onRetry(attempt + 1);
      await wait(attempt * 1000, signal);
    }
  }
}
module.exports = { prepareModel };
