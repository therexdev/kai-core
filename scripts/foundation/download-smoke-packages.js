"use strict";
// CI preparation only. Download exact published packages without executing their
// native code. The app smoke runner uses a fresh, explicitly synthetic profile.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { downloadPackage } = require("../../core/lib/plugins/download");
const { verifyPackageFile } = require("../../core/lib/plugins/package-file-verifier");
const { MAX_BYTES } = require("../../core/lib/plugins/package");
const publishers = require("./apps-publishers.json");

function releaseCoordinates(expected) {
  assert.match(expected.id, /^kai\.[a-z]+(?:-[a-z]+)*$/);
  assert.equal(expected.version, "0.3.0");
  assert.match(expected.fingerprint, /^[a-f0-9]{64}$/);
  const repository = "therexdev/kai-plugin-" + expected.id.slice(4);
  const file = repository.slice("therexdev/".length) + "-" + expected.version + ".kaiplugin";
  const tag = "v" + expected.version;
  assert.equal(expected.file, file, "Unexpected release filename");
  assert.equal(expected.url, `https://github.com/${repository}/releases/download/${tag}/${file}`, "Unexpected release URL");
  return { repository, tag, api: `https://api.github.com/repos/${repository}/releases/tags/${tag}` };
}

function releaseAsset(expected, release) {
  const { tag } = releaseCoordinates(expected);
  assert.equal(release.tag_name, tag, "Unexpected release tag");
  assert.equal(release.draft, false, "A draft is not a published package");
  const assets = release.assets.filter(asset => asset.name === expected.file);
  assert.equal(assets.length, 1, "Expected one published plugin asset");
  const asset = assets[0];
  assert.equal(asset.state, "uploaded", "Plugin asset is not fully uploaded");
  assert.equal(asset.browser_download_url, expected.url, "Unexpected asset URL");
  assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= MAX_BYTES, "Invalid plugin asset size");
  assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/, "Release must provide a SHA-256 asset digest");
  return { bytes: asset.size, sha256: asset.digest.slice(7), release: release.html_url, asset: expected.url };
}

function verifyExpected(verified, expected, asset) {
  assert.equal(verified.manifest.id, expected.id, "Release plugin ID differs");
  assert.equal(verified.manifest.version, expected.version, "Release plugin version differs");
  assert.equal(verified.fingerprint, expected.fingerprint, "Release publisher differs");
  assert.equal(verified.sourceBytes, asset.bytes, "Release byte length differs");
  assert.equal(verified.sourceDigest, asset.sha256, "Release SHA-256 differs");
}

async function fetchRelease(expected) {
  const { api } = releaseCoordinates(expected);
  const headers = { accept: "application/vnd.github+json", "user-agent": "KAI-Foundation-released-apps-smoke", "x-github-api-version": "2022-11-28" };
  // Credentials, when CI supplies them, go only to the fixed GitHub API origin.
  if (process.env.GH_TOKEN) headers.authorization = "Bearer " + process.env.GH_TOKEN;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(api, { headers, redirect: "error", signal: AbortSignal.timeout(60000) });
    if (response.ok) return response.json();
    await response.body?.cancel();
    if (attempt === 2 || ![429, 500, 502, 503, 504].includes(response.status)) throw Error(`Published release metadata unavailable for ${expected.id} (${response.status})`);
    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
  }
}

async function downloadAll({ directory, manifest = publishers, getRelease = fetchRelease, download = downloadPackage } = {}) {
  assert.equal(manifest.schema, 1); assert.equal(manifest.plugins.length, 11);
  assert.equal(new Set(manifest.plugins.map(plugin => plugin.id)).size, 11, "Duplicate pinned plugin");
  for (const expected of manifest.plugins) releaseCoordinates(expected);
  directory = path.resolve(directory || process.env.KAI_SMOKE_PACKAGES_DIR || path.join(os.tmpdir(), "kai-foundation-release-packages"));
  fs.mkdirSync(directory, { recursive: true });
  assert.ok(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink(), "Expected a regular package directory");
  const report = { schema: 1, packages: [] };
  for (const expected of manifest.plugins) {
    const asset = releaseAsset(expected, await getRelease(expected)), target = path.join(directory, expected.file);
    let verified;
    try {
      if (fs.existsSync(target)) {
        verified = verifyPackageFile(target, { extract: false });
        verifyExpected(verified, expected, asset);
      } else {
        verified = await download(expected.url);
        verifyExpected(verified, expected, asset);
        // COPYFILE_EXCL preserves any concurrently supplied output. Verify the
        // copied bytes again before they become an input to the native runner.
        fs.copyFileSync(verified.sourceFile, target, fs.constants.COPYFILE_EXCL);
        const copied = verifyPackageFile(target, { extract: false });
        try { verifyExpected(copied, expected, asset); } finally { copied.dispose(); }
      }
      const row = { id: expected.id, version: expected.version, file: expected.file, publisherFingerprint: verified.fingerprint, bytes: verified.sourceBytes, sha256: verified.sourceDigest, release: asset.release, url: asset.asset };
      report.packages.push(row); console.log(`Verified published ${row.id}@${row.version}: ${row.bytes} bytes, sha256 ${row.sha256}`);
    } finally { await verified?.dispose(); }
  }
  fs.writeFileSync(path.join(directory, "download-report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

if (require.main === module) downloadAll().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { releaseCoordinates, releaseAsset, verifyExpected, downloadAll };
