"use strict";
// CI-only diagnosis. The inspected file is the runner's public Node executable.
// No wallet, account, user profile, or environment values are read or logged.
const assert = require("node:assert/strict"), path = require("node:path");
const { execFile } = require("node:child_process");
const { verifyWindowsInstaller, publisherMatches } = require(path.resolve("electron/core-updates.js"));

async function diagnose(name, cleanModules) {
  const file = process.execPath;
  const filtered = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"));
  let observed = null, rejection = null, accepted = false;
  try {
    await verifyWindowsInstaller(file, { execFile(executable, args, options, done) {
      const childOptions = cleanModules ? { ...options, env: filtered } : options;
      return execFile(executable, args, childOptions, (error, stdout, stderr) => {
        observed = {
          exitCode: error ? error.code ?? null : 0,
          stdout: String(stdout || "").slice(0, 4096),
          stderr: String(stderr || "").slice(0, 8192),
        };
        done(error, stdout, stderr);
      });
    } });
    accepted = true;
  } catch (error) { rejection = String(error.message || error).slice(0, 1000); }
  console.log(JSON.stringify({ case: name, moduleEnvironmentVariableNames: Object.keys(cleanModules ? filtered : process.env).filter(key => key.toUpperCase() === "PSMODULEPATH"), ...observed, productionAccepted: accepted, productionRejection: rejection }, null, 2));
  assert.equal(accepted, false, "A foreign publisher must never be accepted by the production verifier");
  return { observed, rejection };
}

async function main() {
  assert.equal(process.platform, "win32", "This diagnostic requires actual Windows PowerShell 5.1");
  await diagnose("inherited environment", false);
  const { observed, rejection } = await diagnose("PSModulePath removed from child environment", true);
  assert.equal(observed?.exitCode, 0, "Windows signature command must succeed with a clean module environment");
  const record = JSON.parse(observed.stdout.replace(/^\uFEFF/, "").trim());
  assert.equal(record.status, 0, "Control executable must have a valid trusted signature");
  assert.equal(record.signatureType, 1, "Control executable must carry an Authenticode signature");
  assert.match(record.timestamp || "", /^[a-f0-9]{40,128}$/i);
  assert.equal(path.win32.normalize(record.path).toLowerCase(), path.win32.normalize(process.execPath).toLowerCase());
  assert.equal(publisherMatches(record.subject), false, "Control publisher must differ from the KAI publisher");
  assert.match(rejection, /valid, timestamped signature from Michael Milas/);
  console.log(JSON.stringify({ cleanModuleEnvironment: "passed", validForeignSignatureRejected: true }));
}
main().catch(error => { console.error(String(error.message || error)); process.exitCode = 1; });
