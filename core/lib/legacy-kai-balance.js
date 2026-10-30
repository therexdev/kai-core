"use strict";
// Public wallet balance, independent of AI routing, earning and wallet unlock.
// The old testnet scheduler remains distinct from the mainnet credit service.
const MAX_BYTES = 128 * 1024, MAX_ATOMS = (1n << 64n) - 1n;
function validKai(value) {
  if (typeof value !== "string") return false;
  const match = /^(0|[1-9]\d{0,19})(?:\.(\d{1,20}))?(?:e([+-]?\d{1,2}))?$/i.exec(value);
  if (!match) return false;
  let atoms = BigInt(match[1] + (match[2] || "")); const shift = 8 + Number(match[3] || 0) - (match[2] || "").length;
  if (Math.abs(shift) > 28) return false;
  if (shift >= 0) atoms *= 10n ** BigInt(shift);
  else { const scale = 10n ** BigInt(-shift); if (atoms % scale) return false; atoms /= scale; }
  return atoms <= MAX_ATOMS;
}
function createLegacyKaiBalance({ getAddress, getSchedulerUrl, fetchImpl = (...args) => fetch(...args), now = Date.now, timeoutMs = 8000 }) {
  let cache = null, pending = null;
  const context = () => ({ address: getAddress(), url: getSchedulerUrl() });
  const same = (a, b) => a.address === b.address && a.url === b.url;
  async function read() {
    const current = context();
    if (!current.address) { cache = null; return { error: "Import or create your wallet to see its Testnet KAI and estimated KOIN drop." }; }
    if (cache && same(cache, current) && now() - cache.at < (cache.data.error ? 3000 : 30000)) return structuredClone(cache.data);
    if (pending && same(pending, current)) return structuredClone(await pending.promise);
    const request = { ...current };
    request.promise = (async () => {
      let data;
      try {
        const base = new URL(current.url);
        if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw Error("Invalid Testnet KAI service address.");
        const response = await fetchImpl(base.href.replace(/\/$/, "") + "/balance?address=" + encodeURIComponent(current.address), {
          method: "GET", headers: { accept: "application/json" }, credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw Error(`Testnet KAI service returned HTTP ${response.status}.`);
        if (Number(response.headers.get("content-length")) > MAX_BYTES) throw Error("Testnet KAI response is too large.");
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > MAX_BYTES) throw Error("Testnet KAI response is too large."); chunks.push(chunk); }
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (value?.ok !== true) throw Error("The Testnet KAI service could not read the wallet balance.");
        if (value.address !== current.address || !validKai(value.kai)) throw Error("The Testnet KAI balance could not be verified for this wallet.");
        data = { address: current.address, kai: value.kai, observedAt: now(), koinShadow: value.koinShadow === true,
          pendingReceipts: value.pendingReceipts ?? 0, tokensProcessed: value.tokensProcessed ?? null, pendingKai: value.pendingKai ?? null,
          usage: value.usage ?? null, freeTokensRemaining: value.freeTokensRemaining ?? null, balanceUsd: value.balanceUsd ?? null, spentThisEpochKai: value.spentThisEpochKai ?? null };
      } catch (error) {
        const detail = /^(Testnet KAI|The Testnet KAI|Invalid Testnet KAI)/.test(error.message) ? error.message : "Testnet KAI service is temporarily unreachable.";
        data = { error: `${detail} Retrying automatically.` };
      }
      if (!same(current, context())) return null;
      cache = { ...current, at: now(), data }; return data;
    })();
    pending = request;
    try { return structuredClone(await request.promise); }
    finally { if (pending === request) pending = null; }
  }
  return { read, clear() { cache = null; }, get last() { return cache?.data || null; } };
}
module.exports = { createLegacyKaiBalance, validKai };
