"use strict";
const P = require("../core/lib/koin-network/job-protocol"), { utils } = require("koilib");

function wallets(values) {
  return [...new Set((values || []).filter(value => {
    try { return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(value) && utils.isChecksumAddress(value); }
    catch { return false; }
  }))].sort();
}
const providerId = wallet => P.hash("public-provider:" + wallet).slice(0, 12);

// The pricing catalog reports network-wide counts. The readiness endpoint
// supplies the exact provider/model observations used to compute those counts.
// Recompute eligibility from one observation, rather than subtracting a local
// installed model or combining counts sampled at different times.
function consumerNetwork(network, excludedWallets, now = Date.now(), enforcedWallets = excludedWallets) {
  const n = network, fail = () => { throw Error("Network provider availability could not be verified. Refresh models and try again."); };
  if (!n || !Number.isSafeInteger(n.observedAt) || !Number.isSafeInteger(n.validUntil) || n.observedAt > now + 5000 ||
      n.observedAt < now - 15000 || n.validUntil <= now || n.validUntil <= n.observedAt || n.validUntil > n.observedAt + 15000 ||
      !["available", "paused"].includes(n.state) || !Array.isArray(n.providers) || n.providers.length > 256 ||
      !Array.isArray(n.models) || n.models.length > 64 || n.providersTruncated === true) fail();
  const ids = new Set(), aliases = new Set(), excluded = new Set(wallets(excludedWallets).map(providerId)), enforced = new Set(wallets(enforcedWallets).map(providerId));
  for (const p of n.providers) {
    if (!p || typeof p.id !== "string" || !/^[a-f0-9]{12}$/.test(p.id) || ids.has(p.id) || typeof p.ready !== "boolean" ||
        !Array.isArray(p.models) || !p.models.length || p.models.length > 64) fail();
    ids.add(p.id); const models = new Set();
    for (const m of p.models) {
      if (!m || typeof m.model !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(m.model) || models.has(m.model) || typeof m.ready !== "boolean" ||
          (m.ready && (!Number.isSafeInteger(m.validUntil) || m.validUntil < n.validUntil || m.state !== "online"))) fail();
      models.add(m.model);
    }
    if (p.ready !== p.models.some(m => m.ready)) fail();
  }
  const models = n.models.map(m => {
    if (!m || typeof m.id !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(m.id) || aliases.has(m.id) || typeof m.available !== "boolean" ||
        !Number.isSafeInteger(m.providers) || m.providers < 0 || m.providers > 256) fail();
    aliases.add(m.id);
    const ready = n.providers.filter(p => p.models.some(row => row.model === m.id && row.ready));
    if (ready.length !== m.providers || (m.available && (!ready.length || n.state !== "available"))) fail();
    const remote = ready.filter(p => !excluded.has(p.id)), unlinkedSelf = ready.some(p => excluded.has(p.id) && !enforced.has(p.id));
    // The current scheduler enforces owner/linked-account exclusions, but a
    // guest identity does not establish ownership of the local earning wallet.
    // Do not reserve credits when it could still dispatch to that same device.
    const available = m.available && remote.length > 0 && !unlinkedSelf;
    return { ...m, providers: remote.length, totalProviders: ready.length, available, selectable: available && m.selectable !== false,
      ...(ready.length && !remote.length ? { unavailableReason: "self-only" } : unlinkedSelf ? { unavailableReason: "wallet-connection-required" } : {}) };
  });
  return { ...n, models, providers: n.providers.map(p => ({ ...p, self: excluded.has(p.id) })) };
}
function consumerCatalog(catalog, network, excludedWallets, now = Date.now(), enforcedWallets = excludedWallets) {
  const eligible = consumerNetwork(network, excludedWallets, now, enforcedWallets);
  const models = catalog.models.map(m => {
    const row = eligible.models.find(row => row.id === m.model);
    if (!row) throw Error("Network provider availability is incomplete. Refresh models and try again.");
    return { ...m, providers: row.providers, totalProviders: row.totalProviders, available: row.available,
      ...(row.unavailableReason ? { unavailableReason: row.unavailableReason } : {}) };
  });
  return { ...catalog, asOf: Math.max(catalog.asOf, eligible.observedAt), validUntil: Math.min(catalog.validUntil, eligible.validUntil), models };
}
module.exports = { wallets, providerId, consumerNetwork, consumerCatalog };
