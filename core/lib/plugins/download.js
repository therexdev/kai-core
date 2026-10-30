"use strict";
const { assertPublicTarget, publicPageRequest } = require("../websearch");
const { MAX_BYTES, verifyPackage } = require("./package");
async function downloadPackage(url, { signal = AbortSignal.timeout(30000), lookup, request = publicPageRequest } = {}) {
  for (let redirects = 0; redirects <= 5; redirects++) {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) throw Error("Plugins require a public HTTPS URL without credentials");
    const addresses = await assertPublicTarget(u.href, { ...(lookup ? { lookup } : {}) });
    const response = await request(u.href, { addresses, signal, headers: { accept: "application/json", "accept-encoding": "identity" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) { await response.body?.cancel(); url = new URL(response.headers.get("location"), u).href; continue; }
    if (!response.ok) { await response.body?.cancel(); throw Error(`Plugin download failed (${response.status})`); }
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_BYTES) throw Error("Plugin exceeds 24 MB"); chunks.push(Buffer.from(value)); } }
    finally { await reader.cancel(); }
    return verifyPackage(Buffer.concat(chunks).toString("utf8"));
  }
  throw Error("Too many plugin download redirects");
}
module.exports = { downloadPackage };
