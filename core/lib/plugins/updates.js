"use strict";
const { compareVersions, safeId } = require("./registry-format");

// Call only with the verified current catalog (or the reviewed bundled list).
// A matching ID alone must never advertise another publisher's package as an
// update to an installed plugin and its retained private data.
function pluginUpdates(installed, catalog) {
  const saved = new Map(installed.map(plugin => [plugin.id, plugin]));
  const seen = new Set(), updates = [];
  for (const entry of catalog) {
    const previous = saved.get(entry.id);
    if (!previous || seen.has(entry.id) || !safeId(entry.id) ||
        !/^[a-f0-9]{64}$/.test(entry.fingerprint || "") || previous.fingerprint !== entry.fingerprint) continue;
    try { if (compareVersions(entry.version, previous.version) <= 0) continue; }
    catch { continue; } // Preserve unreadable installed records; do not guess.
    seen.add(entry.id);
    updates.push({ id: entry.id, installedVersion: previous.version, version: entry.version,
      compatible: entry.compatible !== false, compatibilityReason: entry.compatibilityReason || null,
      minCoreVersion: entry.minCoreVersion || null });
  }
  return { count: updates.length, updates };
}

module.exports = { pluginUpdates };
