"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs");
const { channelConfig, configureDesktop } = require("../lib/release-channel");
const pkg = require("../../package.json");

test("Beta display branding keeps Core's OS name, application ID and profile paths", () => {
  const release = channelConfig("core"), paths = { appData: path.resolve("fixture-app-data"), userData: path.resolve("fixture-app-data", "KAI Core Beta"), sessionData: path.resolve("fixture-app-data", "KAI Core Beta") };
  let name = pkg.productName, modelId, about;
  const app = { getName: () => name, setName: value => { name = value; }, getPath: key => paths[key], setPath: (key, value) => { paths[key] = value; }, setAppUserModelId: value => { modelId = value; }, setAboutPanelOptions: value => { about = value; } };
  assert.equal(release.productName, "KAI Core Beta"); assert.equal(release.appId, "io.koinosai.core");
  configureDesktop(app, release);
  assert.equal(app.getName(), "KAI Core", "OS credential and single-instance identity must not follow product branding");
  assert.equal(paths.userData, path.join(paths.appData, "KAI Core")); assert.equal(paths.sessionData, paths.userData);
  assert.deepEqual(about, { applicationName: "KAI Core Beta" });
  if (process.platform === "win32") assert.equal(modelId, "io.koinosai.core");
  assert.equal(release.homeDirName, ".kai-foundation"); assert.equal(release.channel, "core");
  // A later branding change must not create another wallet, model or plugin profile.
  configureDesktop(app, { ...release, productName: "A future display label" });
  assert.equal(app.getName(), "KAI Core"); assert.equal(paths.userData, path.join(paths.appData, "KAI Core")); assert.equal(paths.sessionData, paths.userData);
});

test("Beta installer metadata retains Windows upgrade identity and executable paths", () => {
  const { AppInfo } = require("app-builder-lib/out/appInfo"), { getWindowsInstallationDirName } = require("app-builder-lib/out/targets/targetUtil");
  const old = structuredClone(pkg); old.productName = old.build.productName = "KAI Core"; delete old.build.win.executableName;
  const previous = new AppInfo({ metadata: old, config: old.build }, undefined, old.build.win), beta = new AppInfo({ metadata: pkg, config: pkg.build }, undefined, pkg.build.win);
  assert.equal(pkg.name, "kai-core-desktop"); assert.equal(pkg.build.appId, "io.koinosai.core"); assert.equal(beta.id, previous.id);
  assert.equal(beta.productName, "KAI Core Beta"); assert.equal(beta.productFilename, previous.productFilename); assert.equal(beta.productFilename, "KAI Core");
  for (const assisted of [false, true]) assert.equal(getWindowsInstallationDirName(beta, assisted), getWindowsInstallationDirName(previous, assisted));
  assert.equal(pkg.build.linux.executableName, "kai-core"); assert.equal(pkg.build.linux.desktop.entry.StartupWMClass, "kai-core");
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false); assert.equal(pkg.build.nsis.shortcutName, "KAI Core Beta");
});

test("Beta branding is visible in downloads and release titles while packaging leaves publication to verified CI", () => {
  assert.equal(pkg.productName, "KAI Core Beta"); assert.equal(pkg.build.productName, "KAI Core Beta");
  for (const configuration of [pkg.build, pkg.build.nsis, pkg.build.portable, pkg.build.mac]) assert.match(configuration.artifactName, /^KAI-Core-Beta-/);
  assert.equal(pkg.build.linux.desktop.entry.Name, "KAI Core Beta");
  const workflow = fs.readFileSync(path.join(__dirname, "../../.github/workflows/core-build.yml"), "utf8"), html = fs.readFileSync(path.join(__dirname, "../../ui-core/index.html"), "utf8");
  const publication = fs.readFileSync(path.join(__dirname, "../../scripts/foundation/publish-core-release.js"), "utf8");
  assert.match(workflow, /publish-core-release\.js/); assert.match(publication, /"--title", `KAI Core Beta \$\{version\}`/); assert.doesNotMatch(workflow, /--prerelease/);
  assert.match(pkg.scripts.dist, /--publish never/); assert.match(html, /<title>KAI Core Beta<\/title>/); assert.match(html, /<span>KAI Core Beta<\/span>/);
});
