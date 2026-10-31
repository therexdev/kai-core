"use strict";
const fs = require("node:fs"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const { readVerifiedArtifacts, versionNames, hash } = require("./windows-signing");

function releaseFiles(dir, identity) {
  const verified = readVerifiedArtifacts(dir, identity), { version } = identity;
  const names = [...verified.names, verified.reportFile,
    `KAI-Core-Beta-${version}-linux-x86_64.AppImage`, `KAI-Core-Beta-${version}-linux-arm64.AppImage`,
    ...["x64", "arm64"].flatMap(arch => ["dmg", "zip"].map(ext => `KAI-Core-Beta-${version}-mac-${arch}.${ext}`))];
  for (const name of names) if (!fs.lstatSync(path.join(dir, name)).isFile()) throw Error(`Missing release artifact: ${name}`);
  return names;
}

function publish(dir, env = process.env, run = (args, options) => execFileSync("gh", args, { encoding: "utf8", ...options })) {
  const version = require("../../package.json").version;
  const identity = { version, commit: env.GITHUB_SHA, workflowRun: env.GITHUB_RUN_ID };
  const names = releaseFiles(dir, identity), tag = `v${version}`;
  const repo = "therexdev/kai-core";
  // A failed API request is a failure, not evidence that an immutable release is absent.
  const releases = JSON.parse(run(["release", "list", "--repo", repo, "--limit", "10000", "--json", "tagName"]));
  if (!Array.isArray(releases) || releases.some(release => release.tagName === tag)) throw Error(`Version ${tag} already exists; refusing to replace immutable installers.`);
  run(["release", "create", tag, ...names.map(name => path.join(dir, name)), "--repo", repo, "--draft", "--target", identity.commit,
    "--title", `KAI Core Beta ${version}`, "--notes-file", "RELEASE_NOTES.md"], { stdio: "inherit" });
  // Publish only after every uploaded asset is present with its exact verified bytes.
  const release = JSON.parse(run(["api", `repos/${repo}/releases/tags/${tag}`]));
  if (!release.draft || release.assets?.length !== names.length) throw Error("Draft release upload is incomplete; it has not been published.");
  for (const name of names) {
    const asset = release.assets.find(asset => asset.name === name), file = path.join(dir, name);
    if (!asset || asset.state !== "uploaded" || asset.size !== fs.statSync(file).size || asset.digest !== `sha256:${hash(file)}`) throw Error(`Draft upload differs from the verified artifact: ${name}`);
  }
  run(["release", "edit", tag, "--repo", repo, "--draft=false", "--latest"], { stdio: "inherit" });
}
if (require.main === module) publish(path.resolve(process.argv[2] || "release-assets/dist"));
module.exports = { releaseFiles, publish };
