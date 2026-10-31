"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { execFileSync } = require("node:child_process");
const yaml = require("js-yaml");
const { PUBLISHER, assertSignature, hash, artifactFiles, versionNames, readVerifiedArtifacts } = require("./windows-signing");

function inspectFiles(files) {
  if (process.platform !== "win32") throw Error("Authenticode release verification must run on Windows");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kai-core-signatures-"));
  try {
    const manifest = path.join(temp, "files.json"), output = path.join(temp, "signatures.json");
    fs.writeFileSync(manifest, JSON.stringify(files));
    execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(__dirname, "inspect-windows-signatures.ps1"), "-ManifestPath", manifest, "-OutputPath", output],
    { stdio: "inherit", windowsHide: true, timeout: 300000 });
    const result = JSON.parse(fs.readFileSync(output, "utf8").replace(/^\uFEFF/, ""));
    if (!Array.isArray(result) || result.length !== files.length || result.some((record, i) => record.path !== files[i])) throw Error("Windows signature verification returned incomplete or mismatched results");
    return result;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function verifyRejection(signedFile) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kai-core-signature-rejection-"));
  try {
    const unsigned = path.join(temp, "unsigned.exe"), tampered = path.join(temp, "tampered.exe");
    fs.writeFileSync(unsigned, "This is not an Authenticode-signed executable.");
    fs.copyFileSync(signedFile, tampered);
    const size = fs.statSync(tampered).size;
    if (size < 2048) throw Error("Signed installer is unexpectedly small");
    fs.truncateSync(tampered, size - 1024);
    const results = inspectFiles([unsigned, tampered]);
    for (const record of results) {
      let rejected = false;
      try { assertSignature(record); } catch { rejected = true; }
      if (!rejected) throw Error(`Signature verifier accepted an invalid executable: ${record.path}`);
    }
    return { unsigned: true, tampered: true };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function verify(dir) {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  if (!pkg.build.win.forceCodeSigning || pkg.build.win.verifyUpdateCodeSignature !== true ||
      pkg.build.win.azureSignOptions?.publisherName !== PUBLISHER) throw Error("Mandatory Windows signing was not configured");
  const names = artifactFiles(dir, pkg.version), appDir = path.join(dir, "win-unpacked");
  for (const name of ["KAI Core.exe", "resources/elevate.exe"]) {
    if (!fs.lstatSync(path.join(appDir, name)).isFile()) throw Error(`Missing packaged executable: ${name}`);
  }
  const updater = yaml.load(fs.readFileSync(path.join(appDir, "resources/app-update.yml"), "utf8"));
  if (JSON.stringify(updater.publisherName) !== JSON.stringify([PUBLISHER]) || updater.provider !== "github" || updater.owner !== "therexdev" || updater.repo !== "kai-core") throw Error("Packaged updater has no pinned Core publisher and release source");
  const walk = root => fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw Error("Unexpected symlink in the packaged Windows application");
    return entry.isDirectory() ? walk(path.join(root, entry.name)) : entry.isFile() && /\.exe$/i.test(entry.name) ? [path.join(root, entry.name)] : [];
  });
  const files = [...names.filter(name => name.endsWith(".exe")).map(name => path.join(dir, name)), ...walk(appDir)];
  const signatures = inspectFiles(files);
  signatures.forEach(record => {
    assertSignature(record);
    record.path = path.relative(dir, record.path).split(path.sep).join("/");
  });
  const report = {
    schemaVersion: 1, version: pkg.version, publisher: PUBLISHER,
    commit: process.env.GITHUB_SHA, workflowRun: process.env.GITHUB_RUN_ID,
    verifiedAt: new Date().toISOString(), signatures,
    rejectionChecks: verifyRejection(path.join(dir, versionNames(pkg.version).setup)),
    artifacts: names.map(name => ({ name, sha256: hash(path.join(dir, name)) })),
  };
  fs.writeFileSync(path.join(dir, versionNames(pkg.version).report), JSON.stringify(report, null, 2) + "\n");
  readVerifiedArtifacts(dir, report);
  console.log(`Verified ${signatures.length} Windows signatures, timestamps, publisher, rejection checks and update hashes.`);
}
if (require.main === module) verify(path.resolve(process.argv[2] || "dist"));
module.exports = { inspectFiles, verifyRejection, verify };
