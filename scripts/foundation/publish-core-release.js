"use strict";
const fs = require("node:fs"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { readVerifiedArtifacts, hash } = require("./windows-signing");

const RECOVERY_078 = {
  repository: "therexdev/kai-core", repositoryId: 1439355076,
  runId: 41168191545, commit: "4a5e8863612496f153002faadc60ac7ec47b8eb8",
  workflowId: 401456796, workflowPath: ".github/workflows/core-build.yml", attempt: 1,
  version: "0.7.8", draftId: 429719462,
  jobs: [
    { id: 124440213275, name: "build (windows-latest, --win --x64)" },
    { id: 124440213416, name: "build (macos-latest, --mac --x64 --arm64)" },
    { id: 124440213449, name: "build (ubuntu-latest, --linux --x64 --arm64)" },
  ],
  artifacts: [
    { id: 13030326518, name: "kai-core-foundation-Windows", digest: "sha256:4c89feee7b53f39620cb2fba9889479b217e406f82c4e2a06bd9469162738387" },
    { id: 13030585542, name: "kai-core-foundation-macOS", digest: "sha256:269d8db92ca2caf941cb4420586bb2eac5101b8aa4fc3eeecbeaa7dc5aa091d0" },
    { id: 13029603175, name: "kai-core-foundation-Linux", digest: "sha256:70d715c5bbe9a56ec563191694d5663c1e59796efb92d78932fc342c2bf87416" },
  ],
};

function assertRecoverySource({ run, jobs, artifacts, release }) {
  const pin = RECOVERY_078;
  if (run?.id !== pin.runId || run.head_sha !== pin.commit || run.head_branch !== "main" || run.event !== "push" ||
      run.path !== pin.workflowPath || run.workflow_id !== pin.workflowId || run.run_attempt !== pin.attempt ||
      run.repository?.id !== pin.repositoryId || run.repository?.full_name !== pin.repository ||
      run.head_repository?.id !== pin.repositoryId || run.head_repository?.full_name !== pin.repository ||
      run.status !== "completed" || run.conclusion !== "failure") throw Error("Recovery source workflow does not match the pinned release run.");
  if (!Array.isArray(jobs?.jobs) || jobs.total_count !== jobs.jobs.length) throw Error("Recovery job evidence is incomplete.");
  for (const expected of pin.jobs) {
    const matching = jobs.jobs.filter(job => job.id === expected.id || job.name === expected.name);
    const job = matching[0];
    if (matching.length !== 1 || job.id !== expected.id || job.name !== expected.name || job.head_sha !== pin.commit ||
        job.run_attempt !== pin.attempt || job.status !== "completed" || job.conclusion !== "success") throw Error(`Recovery build job was not verified: ${expected.name}`);
  }
  const windows = jobs.jobs.find(job => job.id === pin.jobs[0].id);
  for (const name of ["Build signed Windows Foundation installers", "Verify Windows signatures, publisher, timestamps and update feed"]) {
    const steps = windows.steps?.filter(step => step.name === name) || [];
    if (steps.length !== 1 || steps[0].status !== "completed" || steps[0].conclusion !== "success") throw Error("Recovery requires the completed Windows signing and signature checks.");
  }
  if (!Array.isArray(artifacts?.artifacts) || artifacts.total_count !== artifacts.artifacts.length) throw Error("Recovery artifact evidence is incomplete.");
  for (const expected of pin.artifacts) {
    const matching = artifacts.artifacts.filter(artifact => artifact.id === expected.id || artifact.name === expected.name);
    const artifact = matching[0], source = artifact?.workflow_run;
    if (matching.length !== 1 || artifact.id !== expected.id || artifact.name !== expected.name || artifact.digest !== expected.digest || artifact.expired !== false ||
        source?.id !== pin.runId || source.repository_id !== pin.repositoryId || source.head_repository_id !== pin.repositoryId ||
        source.head_branch !== "main" || source.head_sha !== pin.commit) throw Error(`Recovery artifact provenance changed: ${expected.name}`);
  }
  assertReleaseIdentity(release, { version: pin.version, commit: pin.commit }, true);
  if (release.id !== pin.draftId) throw Error("Recovery draft ID does not match the existing release.");
  return pin;
}

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
module.exports = { releaseFiles, findRelease, assertReleaseIdentity, assertReleaseAssets, publish, RECOVERY_078, assertRecoverySource };
