"use strict";
const assert = require("node:assert/strict"), path = require("node:path");
function installReleasedPackage(manager, file, expected, coreRoot) {
  const { verifyPackageFile } = require(path.join(coreRoot, "core/lib/plugins/package-file-verifier"));
  const verified = verifyPackageFile(file, { extract: false });
  try {
    assert.equal(verified.manifest.id, expected.id, "Release package ID differs");
    assert.equal(verified.manifest.version, expected.version, "Release package version differs");
    assert.equal(verified.fingerprint, expected.fingerprint, "Release publisher fingerprint differs");
    manager.install(verified.package, { trustNative: true });
    return { id: verified.manifest.id, version: verified.manifest.version, source: file, files: verified.entries.length, publisherFingerprint: verified.fingerprint, sourceSha256: verified.sourceDigest, sourceBytes: verified.sourceBytes, releaseUrl: expected.url };
  } finally { verified.dispose(); }
}
module.exports = { installReleasedPackage };
