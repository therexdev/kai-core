"use strict";
const fs = require("node:fs"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { readVerifiedArtifacts, hash } = require("./windows-signing");

function releaseFiles(dir, identity) {
  const verified = readVerifiedArtifacts(dir, identity), { version } = identity;
  const names = [...verified.names, verified.reportFile,
    `KAI-Core-Beta-${version}-linux-x86_64.AppImage`, `KAI-Core-Beta-${version}-linux-arm64.AppImage`,
    ...["x64", "arm64"].flatMap(arch => ["dmg", "zip"].map(ext => `KAI-Core-Beta-${version}-mac-${arch}.${ext}`))];
  for (const name of names) if (!fs.lstatSync(path.join(dir, name)).isFile()) throw Error(`Missing release artifact: ${name}`);
  return names;
}

function findRelease(run, repo, tag) {
  // Drafts need not have a public Git tag yet. The authenticated releases API
  // includes them; /releases/tags/:tag can return 404 for a complete draft.
  const pages = JSON.parse(run(["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`]));
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw Error("Invalid release-list response; no release was changed.");
  const matching = pages.flat().filter(release => release.tag_name === tag);
  if (matching.length > 1) throw Error(`Multiple releases use ${tag}; refusing ambiguous publication.`);
  return matching[0] || null;
}

function assertReleaseIdentity(release, identity, draft) {
  if (!Number.isSafeInteger(release?.id) || release.id <= 0 || release.tag_name !== `v${identity.version}` ||
      release.target_commitish !== identity.commit || release.name !== `KAI Core Beta ${identity.version}` ||
      release.draft !== draft || release.prerelease !== false) {
    throw Error("Release identity does not match this verified Core version and source commit; no assets were overwritten.");
  }
}

function assertReleaseAssets(release, dir, names) {
  if (!Array.isArray(release.assets) || release.assets.length !== names.length || new Set(release.assets.map(asset => asset.name)).size !== names.length) {
    throw Error("Release upload is incomplete or has unexpected assets; exact artifact validation failed.");
  }
  for (const name of names) {
    const asset = release.assets.find(asset => asset.name === name), file = path.join(dir, name);
    if (!asset || asset.state !== "uploaded" || asset.size !== fs.statSync(file).size || asset.digest !== `sha256:${hash(file)}`) throw Error(`Release upload differs from the verified artifact: ${name}`);
  }
}

function publish(dir, env = process.env, run = (args, options) => execFileSync("gh", args, { encoding: "utf8", ...options }), expectedDraftId = null) {
  const version = require("../../package.json").version;
  const identity = { version, commit: env.GITHUB_SHA, workflowRun: env.GITHUB_RUN_ID };
  const names = releaseFiles(dir, identity), tag = `v${version}`;
  const repo = "therexdev/kai-core";
  // A failed API request is a failure, not evidence that an immutable release is absent.
  let found = findRelease(run, repo, tag);
  if (expectedDraftId !== null && (!Number.isSafeInteger(expectedDraftId) || expectedDraftId <= 0 || found?.id !== expectedDraftId)) throw Error("The expected recovery draft is absent or has changed; no release was created.");
  if (found && !found.draft) throw Error(`Version ${tag} already exists; refusing to replace immutable installers.`);
  if (found) assertReleaseIdentity(found, identity, true);
  else {
    run(["release", "create", tag, ...names.map(name => path.join(dir, name)), "--repo", repo, "--draft", "--target", identity.commit,
      "--title", `KAI Core Beta ${version}`, "--notes-file", "RELEASE_NOTES.md"], { stdio: "inherit" });
    found = findRelease(run, repo, tag);
  }
  assertReleaseIdentity(found, identity, true);
  // Retry a completed draft after a failed publication check without uploading
  // again. A partial, changed or foreign draft stays private for investigation.
  const releasePath = `repos/${repo}/releases/${found.id}`;
  const release = JSON.parse(run(["api", releasePath]));
  assertReleaseIdentity(release, identity, true);
  if (release.id !== found.id) throw Error("Draft release ID changed during verification.");
  assertReleaseAssets(release, dir, names);
  const published = JSON.parse(run(["api", "--method", "PATCH", releasePath, "-F", "draft=false", "-f", "make_latest=true"]));
  assertReleaseIdentity(published, identity, false);
  if (published.id !== found.id) throw Error("Publication returned an unexpected release ID.");
  assertReleaseAssets(published, dir, names);
  console.log(`Published ${tag} from verified release ${found.id}.`);
}
if (require.main === module) publish(path.resolve(process.argv[2] || "release-assets/dist"));
module.exports = { releaseFiles, findRelease, assertReleaseIdentity, assertReleaseAssets, publish };
