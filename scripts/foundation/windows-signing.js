"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const yaml = require("js-yaml");
const { parseDn } = require("builder-util-runtime");

// Reuse the established public Azure identity, not a rotating certificate thumbprint.
const PUBLISHER = "CN=Michael Milas, O=Michael Milas, L=Bennington, S=ne, C=US";
const REQUIRED_ENV = ["AZURE_SIGNING_ACCOUNT", "AZURE_SIGNING_PROFILE", "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];
function publisherMatches(subject) {
  if (typeof subject !== "string") return false;
  const normalized = value => new Map([...parseDn(value)].map(([key, value]) => [key === "ST" ? "S" : key, value]));
  const expected = normalized(PUBLISHER), actual = normalized(subject);
  return expected.size === actual.size && [...expected].every(([key, value]) => actual.get(key) === value);
}
function configureSigning(pkg, env) {
  const missing = REQUIRED_ENV.filter(key => !String(env[key] || "").trim());
  if (missing.length) throw Error(`Windows signing is required. Add these GitHub Actions secrets to therexdev/kai-core: ${missing.join(", ")}`);
  const endpoint = env.AZURE_SIGNING_ENDPOINT || "https://eus.codesigning.azure.net";
  if (!/^https:\/\/[a-z0-9-]+\.codesigning\.azure\.net\/?$/.test(endpoint)) throw Error("AZURE_SIGNING_ENDPOINT must be an Azure signing HTTPS endpoint");
  const result = structuredClone(pkg), win = result.build.win;
  if (win.signtoolOptions) throw Error("Remove conflicting Windows signtoolOptions before enabling Azure signing");
  win.forceCodeSigning = true;
  win.signExecutable = true;
  win.signAndEditExecutable = true;
  win.verifyUpdateCodeSignature = true;
  win.azureSignOptions = {
    codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
    certificateProfileName: env.AZURE_SIGNING_PROFILE,
    endpoint, publisherName: PUBLISHER,
    fileDigest: "SHA256", timestampDigest: "SHA256", timestampRfc3161: "http://timestamp.acs.microsoft.com",
  };
  return result;
}
function assertSignature(record) {
  if (record?.status !== "Valid" || record.signatureType !== "Authenticode") throw Error(`Untrusted or missing embedded signature: ${record?.path}`);
  if (!publisherMatches(record.subject)) throw Error(`Unexpected Windows publisher: ${record.path}`);
  if (!/^[a-f0-9]{40,64}$/i.test(record.timestampThumbprint || "")) throw Error(`Missing trusted timestamp: ${record.path}`);
  if (record.signToolExitCode !== 0) throw Error(`SignTool verification failed: ${record.path}`);
}
function versionNames(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error("A stable Core release version is required");
  const setup = `KAI-Core-Beta-Setup-${version}-x64.exe`;
  return { setup, portable: `KAI-Core-Beta-Portable-${version}-x64.exe`, blockmap: `${setup}.blockmap`, feed: "latest.yml", report: `windows-signatures-${version}.json` };
}
function artifactFiles(dir, version) {
  const expected = versionNames(version);
  // The publication job merges all platform artifacts. macOS packaging can
  // supply its own blockmaps; they are not Windows update metadata and are not
  // published by releaseFiles. Keep rejecting every unexpected Windows file.
  const macBlockmaps = new Set(["x64", "arm64"].flatMap(arch => ["dmg", "zip"]
    .map(ext => `KAI-Core-Beta-${version}-mac-${arch}.${ext}.blockmap`)));
  const names = fs.readdirSync(dir).filter(name => !macBlockmaps.has(name) && (/\.(exe|blockmap)$/i.test(name) || name === "latest.yml")).sort();
  const wanted = [expected.setup, expected.portable, expected.blockmap, expected.feed].sort();
  if (JSON.stringify(names) !== JSON.stringify(wanted)) throw Error("Expected exactly the Core Windows Setup, portable, Setup blockmap and latest.yml");
  for (const name of names) if (!fs.lstatSync(path.join(dir, name)).isFile()) throw Error(`Invalid Windows artifact: ${name}`);
  return names;
}
function hash(file, algorithm = "sha256", encoding = "hex") {
  return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);
}
function readVerifiedArtifacts(dir, identity) {
  const names = artifactFiles(dir, identity.version), expected = versionNames(identity.version);
  const report = JSON.parse(fs.readFileSync(path.join(dir, expected.report), "utf8"));
  if (!/^[a-f0-9]{40}$/.test(identity.commit || "") || !/^\d+$/.test(String(identity.workflowRun || "")) ||
      report.schemaVersion !== 1 || report.version !== identity.version || report.commit !== identity.commit ||
      report.workflowRun !== String(identity.workflowRun) || report.publisher !== PUBLISHER) {
    throw Error("Windows signature report does not match this release workflow");
  }
  if (!Array.isArray(report.artifacts) || report.artifacts.length !== names.length || new Set(report.artifacts.map(a => a.name)).size !== names.length) throw Error("Windows artifact coverage mismatch");
  if (report.rejectionChecks?.unsigned !== true || report.rejectionChecks?.tampered !== true) throw Error("Windows signature rejection checks are missing");
  for (const name of names) {
    const entry = report.artifacts.find(item => item.name === name);
    if (!entry || entry.sha256 !== hash(path.join(dir, name))) throw Error(`Windows artifact changed after verification: ${name}`);
  }
  const signatures = report.signatures;
  if (!Array.isArray(signatures) || new Set(signatures.map(s => s.path)).size !== signatures.length) throw Error("Invalid Windows signature coverage");
  for (const name of [expected.setup, expected.portable, "win-unpacked/KAI Core.exe", "win-unpacked/resources/elevate.exe"]) {
    if (!signatures.some(record => record.path === name)) throw Error(`Missing signature evidence: ${name}`);
  }
  for (const record of signatures) assertSignature(record);
  const feed = yaml.load(fs.readFileSync(path.join(dir, expected.feed), "utf8"));
  if (feed?.version !== identity.version || feed.path !== expected.setup || !Array.isArray(feed.files) || feed.files.length !== 1 || feed.files[0].url !== expected.setup) throw Error("Windows update feed must identify only this release's signed Setup installer");
  const setup = path.join(dir, expected.setup), entry = feed.files[0];
  if (hash(setup, "sha512", "base64") !== entry.sha512 || fs.statSync(setup).size !== entry.size || feed.sha512 !== entry.sha512) throw Error("Windows update feed does not match the verified installer");
  return { report, names, reportFile: expected.report };
}
module.exports = { PUBLISHER, REQUIRED_ENV, publisherMatches, configureSigning, assertSignature, versionNames, artifactFiles, hash, readVerifiedArtifacts };
