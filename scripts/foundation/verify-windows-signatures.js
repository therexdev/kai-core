"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { execFile, execFileSync } = require("node:child_process");
const yaml = require("js-yaml");
const { PUBLISHER, publisherMatches, assertSignature, hash, artifactFiles, versionNames, readVerifiedArtifacts } = require("./windows-signing");
const { verifyWindowsInstaller, verifyDownloadedInstaller, assertUpdateInfo } = require("../../electron/core-updates");

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

async function verifyRejection(signedFile, { inspect = inspectFiles, verifySignature = verifyWindowsInstaller } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kai-core-signature-rejection-"));
  try {
    const unsigned = path.join(temp, "unsigned.exe"), tampered = path.join(temp, "tampered.exe");
    fs.writeFileSync(unsigned, "This is not an Authenticode-signed executable.");
    fs.copyFileSync(signedFile, tampered);
    const size = fs.statSync(tampered).size;
    if (size < 2048) throw Error("Signed installer is unexpectedly small");
    fs.truncateSync(tampered, size - 1024);
    const results = inspect([unsigned, tampered]);
    for (const record of results) {
      let rejected = false;
      try { assertSignature(record); } catch { rejected = true; }
      if (!rejected) throw Error(`Signature verifier accepted an invalid executable: ${record.path}`);
    }
    for (const file of [unsigned, tampered]) {
      let rejected = false;
      try { await verifySignature(file); } catch { rejected = true; }
      if (!rejected) throw Error(`Production updater accepted an invalid executable: ${file}`);
    }
    return { unsigned: true, tampered: true };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

async function verifyUpdater(dir, version, { inspect = inspectFiles, verifySignature = verifyWindowsInstaller, otherPublisherFile = process.execPath } = {}) {
  // CI's pwsh/SignTool checks cannot stand in for the Windows PowerShell 5.1
  // verifier shipped to users. Run that exact verifier before publication.
  const names = versionNames(version), setup = path.join(dir, names.setup), portable = path.join(dir, names.portable);
  const feed = yaml.load(fs.readFileSync(path.join(dir, names.feed), "utf8"));
  const metadata = assertUpdateInfo({ ...feed, tag: `v${version}` }, version);
  await verifySignature(setup);
  await verifySignature(portable);
  await verifyDownloadedInstaller(setup, metadata, verifySignature);

  // Exercise a cache-like path, including apostrophes and Unicode, and repeat
  // the complete hash/signature check used immediately before installation.
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "kai-update-Míke's-用户-"));
  try {
    const file = path.join(cache, names.setup);
    fs.copyFileSync(setup, file);
    await verifyDownloadedInstaller(file, metadata, verifySignature);
    await verifyDownloadedInstaller(file, metadata, verifySignature);
  } finally { fs.rmSync(cache, { recursive: true, force: true }); }

  // A valid signature remains valid when PowerShell writes informational
  // progress to stderr. Only the real command's stderr is supplemented;
  // its exit code and signed-file result are never replaced.
  await verifySignature(setup, { execFile(executable, args, options, done) {
    return execFile(executable, args, options, (error, stdout, stderr) => done(error, stdout,
      String(stderr || "") + '\r\n#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><MS><S N="Activity">Preparing modules for first use.</S></MS></Obj></Objs>'));
  } });

  // The official CI Node executable supplies a genuinely signed foreign
  // publisher without creating certificates or changing the machine's trust.
  const [foreign] = inspect([otherPublisherFile]);
  if (foreign?.status !== "Valid" || foreign.signatureType !== "Authenticode" || foreign.signToolExitCode !== 0 ||
      !/^[a-f0-9]{40,64}$/i.test(foreign.timestampThumbprint || "") || publisherMatches(foreign.subject)) {
    throw Error("A valid timestamped executable from another publisher is required for the updater rejection check");
  }
  let rejected = false;
  try { await verifySignature(otherPublisherFile); } catch { rejected = true; }
  if (!rejected) throw Error("Production updater accepted an executable from another publisher");
  return { setup: true, portable: true, downloadedSetup: true, cachedSetup: true, informationalStderr: true, otherPublisher: true };
}

async function verify(dir) {
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
  const updaterChecks = await verifyUpdater(dir, pkg.version);
  const rejectionChecks = await verifyRejection(path.join(dir, versionNames(pkg.version).setup));
  const report = {
    schemaVersion: 1, version: pkg.version, publisher: PUBLISHER,
    commit: process.env.GITHUB_SHA, workflowRun: process.env.GITHUB_RUN_ID,
    verifiedAt: new Date().toISOString(), signatures,
    rejectionChecks, updaterChecks: { ...updaterChecks, ...rejectionChecks },
    artifacts: names.map(name => ({ name, sha256: hash(path.join(dir, name)) })),
  };
  fs.writeFileSync(path.join(dir, versionNames(pkg.version).report), JSON.stringify(report, null, 2) + "\n");
  readVerifiedArtifacts(dir, report);
  console.log(`Verified ${signatures.length} Windows signatures, timestamps, publisher, rejection checks, update hashes and the production Windows PowerShell updater.`);
}
if (require.main === module) verify(path.resolve(process.argv[2] || "dist")).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { inspectFiles, verifyRejection, verifyUpdater, verify };
