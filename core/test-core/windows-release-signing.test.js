"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const yaml = require("js-yaml");
const { PUBLISHER, REQUIRED_ENV, publisherMatches, configureSigning, assertSignature, versionNames, hash, readVerifiedArtifacts } = require("../../scripts/foundation/windows-signing");
const { releaseFiles, publish } = require("../../scripts/foundation/publish-core-release");
const currentVersion = require("../../package.json").version;
const identity = { version: currentVersion, commit: "a".repeat(40), workflowRun: "12345" };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-release-signing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = versionNames(identity.version);
  fs.writeFileSync(path.join(dir, names.setup), "signed setup bytes");
  fs.writeFileSync(path.join(dir, names.portable), "signed portable bytes");
  fs.writeFileSync(path.join(dir, names.blockmap), "verified blockmap bytes");
  const digest = hash(path.join(dir, names.setup), "sha512", "base64");
  const feed = { version: identity.version, path: names.setup, sha512: digest, files: [{ url: names.setup, sha512: digest, size: fs.statSync(path.join(dir, names.setup)).size }] };
  fs.writeFileSync(path.join(dir, names.feed), yaml.dump(feed));
  const signature = file => ({ path: file, status: "Valid", signatureType: "Authenticode", subject: PUBLISHER, timestampThumbprint: "f".repeat(40), signToolExitCode: 0 });
  const report = { ...identity, schemaVersion: 1, publisher: PUBLISHER, rejectionChecks: { unsigned: true, tampered: true },
    signatures: [names.setup, names.portable, "win-unpacked/KAI Core.exe", "win-unpacked/resources/elevate.exe"].map(signature),
    artifacts: [names.setup, names.portable, names.blockmap, names.feed].map(name => ({ name, sha256: hash(path.join(dir, name)) })) };
  const write = () => fs.writeFileSync(path.join(dir, names.report), JSON.stringify(report));
  write();
  const extras = [`KAI-Core-Beta-${identity.version}-linux-x86_64.AppImage`, `KAI-Core-Beta-${identity.version}-linux-arm64.AppImage`,
    ...["x64", "arm64"].flatMap(arch => ["dmg", "zip"].map(ext => `KAI-Core-Beta-${identity.version}-mac-${arch}.${ext}`))];
  extras.forEach(name => fs.writeFileSync(path.join(dir, name), "manual platform installer"));
  return { dir, names, report, write, feed, signature };
}

test("Azure preflight fails with missing names and never puts credentials in build metadata", () => {
  const env = Object.fromEntries(REQUIRED_ENV.map(key => [key, `fixture-${key}`]));
  const pkg = { build: { win: {} } };
  assert.throws(() => configureSigning(pkg, {}), error => REQUIRED_ENV.every(key => error.message.includes(key)));
  const configured = configureSigning(pkg, env);
  assert.deepEqual(pkg, { build: { win: {} } });
  assert.equal(configured.build.win.forceCodeSigning, true);
  assert.equal(configured.build.win.verifyUpdateCodeSignature, true);
  assert.equal(configured.build.win.azureSignOptions.publisherName, PUBLISHER);
  assert.equal(configured.build.win.azureSignOptions.fileDigest, "SHA256");
  assert.equal(configured.build.win.azureSignOptions.timestampDigest, "SHA256");
  for (const key of ["AZURE_CLIENT_SECRET", "AZURE_CLIENT_ID", "AZURE_TENANT_ID"]) assert.ok(!JSON.stringify(configured).includes(env[key]));
  assert.throws(() => configureSigning(pkg, { ...env, AZURE_SIGNING_ENDPOINT: "https://example.com/sign" }), /Azure signing HTTPS endpoint/);
  assert.throws(() => configureSigning({ build: { win: { signtoolOptions: {} } } }, env), /conflicting/);
});

test("publisher matching requires the full established identity", () => {
  assert.equal(publisherMatches(PUBLISHER), true);
  assert.equal(publisherMatches("C=US, ST=ne, L=Bennington, O=Michael Milas, CN=Michael Milas"), true);
  for (const subject of ["Michael Milas", "CN=Michael Milas", PUBLISHER.replace("Bennington", "Other"), PUBLISHER + ", OU=Other", null]) assert.equal(publisherMatches(subject), false);
});

test("signature policy rejects unsigned, wrong publisher, expired trust and missing timestamps", t => {
  const { signature } = fixture(t), valid = signature("setup.exe");
  assert.doesNotThrow(() => assertSignature(valid));
  for (const change of [{ status: "NotSigned" }, { status: "HashMismatch" }, { status: "UnknownError" }, { signatureType: "Catalog" }, { subject: "CN=Michael Milas" }, { timestampThumbprint: "" }, { signToolExitCode: 1 }]) {
    assert.throws(() => assertSignature({ ...valid, ...change }));
  }
});

test("release gate accepts only matching Windows artifacts and complete signature evidence", t => {
  const f = fixture(t);
  assert.equal(readVerifiedArtifacts(f.dir, identity).names.length, 4);
  assert.equal(releaseFiles(f.dir, identity).length, 11);
  f.report.signatures.pop(); f.write();
  assert.throws(() => readVerifiedArtifacts(f.dir, identity), /Missing signature evidence/);
});

test("merged macOS blockmaps do not enter the Windows manifest or published release", t => {
  const f = fixture(t);
  for (const arch of ["x64", "arm64"]) for (const ext of ["dmg", "zip"]) {
    fs.writeFileSync(path.join(f.dir, `KAI-Core-Beta-${identity.version}-mac-${arch}.${ext}.blockmap`), "macOS metadata");
  }
  const windows = readVerifiedArtifacts(f.dir, identity).names;
  assert.deepEqual(windows, [f.names.setup, f.names.portable, f.names.blockmap, f.names.feed].sort());
  const published = releaseFiles(f.dir, identity);
  assert.equal(published.length, 11);
  assert.equal(new Set(published).size, 11);
  assert.deepEqual(published.filter(name => name.endsWith(".blockmap")), [f.names.blockmap]);
  fs.writeFileSync(path.join(f.dir, "unexpected.exe.blockmap"), "unreviewed Windows metadata");
  assert.throws(() => readVerifiedArtifacts(f.dir, identity), /Expected exactly/);
  fs.unlinkSync(path.join(f.dir, "unexpected.exe.blockmap"));
  fs.writeFileSync(path.join(f.dir, "unexpected.blockmap"), "unrecognized metadata");
  assert.throws(() => readVerifiedArtifacts(f.dir, identity), /Expected exactly/);
});

test("release gate rejects changed installer, feed, blockmap and wrong workflow provenance", async t => {
  for (const target of ["setup", "portable", "blockmap", "feed"]) await t.test(target, t => {
    const f = fixture(t); fs.appendFileSync(path.join(f.dir, f.names[target]), "changed");
    assert.throws(() => readVerifiedArtifacts(f.dir, identity), /changed after verification/);
  });
  for (const change of [{ version: "9.0.0" }, { commit: "b".repeat(40) }, { workflowRun: "999" }, { publisher: "Other" }, { rejectionChecks: {} }]) await t.test(JSON.stringify(change), t => {
    const f = fixture(t); Object.assign(f.report, change); f.write();
    assert.throws(() => readVerifiedArtifacts(f.dir, identity));
  });
});

test("feed may only address this signed Setup and must match SHA-512 and size", async t => {
  for (const mutate of [f => { f.path = "https://example.com/other.exe"; }, f => { f.files[0].url = "../other.exe"; }, f => { f.files[0].sha512 = "wrong"; }, f => { f.files[0].size++; }, f => { f.sha512 = "wrong"; }, f => { f.version = "9.0.0"; }]) await t.test("invalid feed", t => {
    const f = fixture(t); mutate(f.feed); fs.writeFileSync(path.join(f.dir, f.names.feed), yaml.dump(f.feed));
    f.report.artifacts.find(a => a.name === f.names.feed).sha256 = hash(path.join(f.dir, f.names.feed)); f.write();
    assert.throws(() => readVerifiedArtifacts(f.dir, identity), /update feed/);
  });
});

test("release gate rejects extra Windows executables and duplicate signature coverage", t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.dir, "unknown.exe"), "not approved");
  assert.throws(() => readVerifiedArtifacts(f.dir, identity), /Expected exactly/);
  fs.unlinkSync(path.join(f.dir, "unknown.exe"));
  f.report.signatures.push(f.report.signatures[0]); f.write();
  assert.throws(() => readVerifiedArtifacts(f.dir, identity), /coverage/);
});

function publicationFixture(t, options = {}) {
  const f = fixture(t), calls = [], names = releaseFiles(f.dir, identity);
  const draft = { id: 42, tag_name: `v${identity.version}`, target_commitish: identity.commit, name: `KAI Core Beta ${identity.version}`, draft: true, prerelease: false,
    assets: names.map(name => ({ name, state: "uploaded", size: fs.statSync(path.join(f.dir, name)).size, digest: `sha256:${hash(path.join(f.dir, name))}` })) };
  let exists = Boolean(options.existing);
  const env = { GITHUB_SHA: identity.commit, GITHUB_RUN_ID: identity.workflowRun };
  const run = args => {
    calls.push(args);
    if (args.some(arg => /releases\/tags\//.test(arg))) throw Error("404: draft has no public tag");
    if (args[0] === "release" && args[1] === "create") { exists = true; return "https://github.com/therexdev/kai-core/releases/tag/untagged-fixture"; }
    if (args.includes("--paginate")) return JSON.stringify([[{ id: 1, tag_name: "v0.1.0" }], exists ? [draft, ...(options.duplicate ? [{ ...draft, id: 43 }] : [])] : []]);
    if (args.includes("PATCH")) { assert.ok(args.includes("repos/therexdev/kai-core/releases/42")); return JSON.stringify({ ...draft, draft: false }); }
    if (args[0] === "api" && args[1] === "repos/therexdev/kai-core/releases/42") return JSON.stringify(draft);
    throw Error(`Unexpected command: ${args.join(" ")}`);
  };
  return { ...f, calls, draft, env, run };
}

test("publication discovers an untagged draft and verifies exact bytes before publishing by ID", t => {
  const f = publicationFixture(t);
  publish(f.dir, f.env, f.run);
  assert.ok(f.calls.find(args => args[1] === "create").includes("--draft"));
  assert.equal(f.calls.filter(args => args.includes("--paginate")).length, 2);
  assert.ok(f.calls.at(-1).includes("PATCH"));
  assert.ok(f.calls.at(-1).includes("draft=false"));
  assert.ok(f.calls.at(-1).includes("repos/therexdev/kai-core/releases/42"));
  assert.equal(f.calls.some(args => args[0] === "release" && args[1] === "edit"), false);
});

test("publication resumes the exact complete draft without replacing or uploading assets", t => {
  const f = publicationFixture(t, { existing: true });
  publish(f.dir, f.env, f.run);
  assert.equal(f.calls.some(args => args[0] === "release"), false);
  assert.equal(f.calls.filter(args => args.includes("PATCH")).length, 1);
});

test("publication leaves incomplete, changed or duplicate draft assets unpublished", async t => {
  const mutations = [draft => { draft.assets.pop(); }, draft => { draft.assets[0].digest = "sha256:" + "0".repeat(64); },
    draft => { draft.assets[0].size++; }, draft => { draft.assets[0].state = "starter"; },
    draft => { draft.assets[0] = draft.assets[1]; }];
  for (const mutate of mutations) await t.test("invalid draft assets", t => {
    const f = publicationFixture(t, { existing: true }); mutate(f.draft);
    assert.throws(() => publish(f.dir, f.env, f.run), /incomplete|differs/);
    assert.equal(f.calls.some(args => args.includes("PATCH") || args[0] === "release"), false);
  });
});

test("publication rejects public, foreign, ambiguous or changed-identity releases", async t => {
  const mutations = [draft => { draft.draft = false; }, draft => { draft.target_commitish = "b".repeat(40); },
    draft => { draft.name = "Other build"; }, draft => { draft.prerelease = true; }];
  for (const mutate of mutations) await t.test("wrong release identity", t => {
    const f = publicationFixture(t, { existing: true }); mutate(f.draft);
    assert.throws(() => publish(f.dir, f.env, f.run), /already exists|identity/);
    assert.equal(f.calls.some(args => args.includes("PATCH") || args[0] === "release"), false);
  });
  const f = publicationFixture(t, { existing: true, duplicate: true });
  assert.throws(() => publish(f.dir, f.env, f.run), /Multiple releases/);
  const race = publicationFixture(t, { existing: true });
  assert.throws(() => publish(race.dir, race.env, args => {
    const output = race.run(args);
    return args[0] === "api" && args[1] === "repos/therexdev/kai-core/releases/42" ? JSON.stringify({ ...race.draft, tag_name: "v9.0.0" }) : output;
  }), /identity/);
  assert.equal(race.calls.some(args => args.includes("PATCH")), false);
});

test("release discovery errors never create a replacement draft", t => {
  const f = publicationFixture(t);
  assert.throws(() => publish(f.dir, f.env, () => { throw Error("authentication failed"); }), /authentication failed/);
  assert.throws(() => publish(f.dir, f.env, () => "{}"), /Invalid release-list/);
});

test("recovery publication cannot create or substitute its pinned draft", t => {
  const f = publicationFixture(t, { existing: true });
  assert.throws(() => publish(f.dir, f.env, f.run, 99), /expected recovery draft/);
  assert.equal(f.calls.some(args => args.includes("PATCH") || args[0] === "release"), false);
  const absent = publicationFixture(t);
  assert.throws(() => publish(absent.dir, absent.env, absent.run, 42), /expected recovery draft/);
  assert.equal(absent.calls.some(args => args.includes("PATCH") || args[0] === "release"), false);
});
