"use strict";
// Real Core main process, sandboxed renderer and migration IPC. All profiles,
// encrypted keys and GGUF files are synthetic; no user's profile is accessed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const http = require("node:http");
const { _electron } = require("playwright-core");

const appRoot = path.resolve(process.env.KAI_SMOKE_SOURCE_ROOT || path.join(__dirname, "../.."));
const runtimeRoot = path.resolve(process.env.KAI_SMOKE_RUNTIME_ROOT || appRoot);
const output = path.resolve(process.env.KAI_ALPHA_MIGRATION_SMOKE_OUTPUT || path.join(os.tmpdir(), "kai-alpha-migration-smoke"));
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value, { mode: 0o600 }); };

function snapshot(directory) {
  const result = {};
  function walk(folder) {
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name), relative = path.relative(directory, file);
      assert.equal(item.isSymbolicLink(), false, "Synthetic fixture unexpectedly contains a link");
      if (item.isDirectory()) walk(file);
      else {
        const stat = fs.statSync(file);
        result[relative] = { sha256: hash(fs.readFileSync(file)), size: stat.size, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
      }
    }
  }
  walk(directory);
  return result;
}

function ggufFixture(label) {
  // A complete empty GGUF v3 header plus fixture identity. It is copied only;
  // this smoke intentionally never asks a model runtime to load fake weights.
  const header = Buffer.alloc(24);
  header.write("GGUF"); header.writeUInt32LE(3, 4);
  return Buffer.concat([header, Buffer.from(label)]);
}

async function main() {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-alpha-migration-")));
  const appData = path.join(temp, "app-data"), source = path.join(appData, "Koinos AI", "core"), profile = path.join(appData, "KAI Core", "foundation-v1");
  const external = path.join(temp, "alpha-imports"), exitReport = path.join(temp, "exit.json");
  const syntheticKeychain = process.argv.includes("--synthetic-keychain");
  fs.mkdirSync(output, { recursive: true });
  const report = { platform: process.platform, realCore: true, runtimeRoot, syntheticProfile: true, syntheticKeychain, syntheticLock: process.env.KAI_SMOKE_SYNTHETIC_LOCK === "1", actualModelsLoaded: false, checks: [], screenshots: [] };
  const password = "Alpha synthetic smoke password 2026!";
  const { Signer } = require(path.join(appRoot, "node_modules/koilib"));
  const { encryptKeystore, decryptKeystore } = require(path.join(appRoot, "core/lib/keystore"));
  const signer = new Signer({ privateKey: crypto.randomBytes(32).toString("hex"), compressed: false });
  const balanceRequests = [], balanceServer = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1"); response.setHeader("content-type", "application/json");
    if (url.pathname !== "/balance") { response.writeHead(404); response.end(JSON.stringify({ ok: false })); return; }
    balanceRequests.push({ address: url.searchParams.get("address"), authorization: request.headers.authorization, cookie: request.headers.cookie });
    response.end(JSON.stringify({ ok: true, address: signer.getAddress(), kai: "12345.67890123", pendingKai: "999" }));
  });
  await new Promise((resolve, reject) => { balanceServer.once("error", reject); balanceServer.listen(0, "127.0.0.1", resolve); }); balanceServer.unref();
  const balanceOrigin = `http://127.0.0.1:${balanceServer.address().port}`;
  report.syntheticLegacyBalance = { server: "loopback-only", kai: "12345.67890123", pendingKai: "999", realFundsRead: false };
  const keystore = encryptKeystore({ privateKeyHex: signer.getPrivateKey("hex"), address: signer.getAddress(), password });
  keystore.compressed = false;
  keystore.ethAddress = require(path.join(appRoot, "core/lib/koinos/eth")).deriveEthAddress(signer.getPrivateKey("hex"));
  keystore.pwHint = "legacy-synthetic-hint-must-not-be-copied";
  write(path.join(source, "wallet/wallet.json"), JSON.stringify(keystore, null, 2));
  const folderModel = path.join(source, "models/alpha-folder-fixture.gguf"), externalModel = path.join(external, "alpha-imported-fixture.gguf");
  write(folderModel, ggufFixture("folder-model")); write(externalModel, ggufFixture("external-import"));
  const sentinel = "ALPHA_ONLY_DATA_MUST_NEVER_ENTER_FOUNDATION";
  write(path.join(source, "state.json"), JSON.stringify({ customModels: [{ alias: "custom-alpha-imported", label: "Alpha imported fixture", path: externalModel, sha256: hash(fs.readFileSync(externalModel)), contextSize: 8192 }], brain: sentinel, connectedAccounts: sentinel, selectedModel: "custom-alpha-imported" }));
  write(path.join(source, "settings.json"), JSON.stringify({ network: { privacyMode: "public" }, connectedAccounts: sentinel, alphaOnlySetting: sentinel }));
  for (const name of ["wallet/session.bin", "machine-secret.bin", "account.cfg", "credit-account-fixture.cfg", "documents/private-document.txt", "plugins/data/private-plugin.txt", "brain/private-memory.txt", "models/partial.gguf.part"]) write(path.join(source, name), sentinel + ":" + name);
  const sourceBefore = snapshot(source), externalBefore = snapshot(external);
  require(path.join(appRoot, "electron/foundation-profile")).prepareFoundationProfile(profile);
  write(path.join(profile, "settings.json"), JSON.stringify({ network: { privacyMode: "local-only" }, earn: { autoStart: false, schedulerUrl: balanceOrigin } }));
  write(path.join(temp, "package.json"), JSON.stringify({ name: "kai-alpha-migration-smoke", version: require(path.join(appRoot, "package.json")).version, main: "desktop.js" }));
  write(path.join(temp, "desktop.js"), `"use strict";\nrequire(${JSON.stringify(path.join(__dirname, "apps-fixture.js"))}).install(${JSON.stringify({ appRoot: runtimeRoot, appData, reportFile: exitReport, syntheticKeychain })});\nrequire(${JSON.stringify(path.join(runtimeRoot, "electron/core-main.js"))});\n`);
  const args = [];
  if (process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox");
  if (process.platform === "linux" && !process.env.DISPLAY) args.push("--ozone-platform=headless");
  args.push(temp);
  const env = { ...process.env, KAI_CORE_DATA: profile, KAI_CORE_PORT: "0", KAI_CHANNEL: "core" };
  delete env.ELECTRON_RUN_AS_NODE; delete env.KAI_CORE_TOKEN; delete env.KAI_SESSION_SECRET;
  let application, page, logs = "";
  const pageErrors = [];
  const until = async (predicate, message, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    do { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
    throw Error(message);
  };
  const call = (method, input) => page.evaluate(({ method, input }) => window.kaiCore.call(method, input), { method, input });
  const check = async (name, run) => { await run(); report.checks.push(name); console.log("PASS", name); };
  const capture = async filename => { await page.screenshot({ path: path.join(output, filename) }); report.screenshots.push(filename); };
  const waitForJob = () => until(async () => { const job = await call("migration.status"); return ["complete", "failed", "cancelled"].includes(job.phase) ? job : null; }, "Migration did not reach a terminal state");
  try {
    application = await _electron.launch({ executablePath: require("electron"), args, env, timeout: 60000 });
    for (const stream of [application.process().stdout, application.process().stderr]) stream?.on("data", chunk => { logs = (logs + chunk).slice(-60000); });
    page = await application.firstWindow({ timeout: 60000 }); page.setDefaultTimeout(30000); page.on("pageerror", error => pageErrors.push(error.message));
    await application.evaluate(() => global.__foundationWindow?.setContentSize(1280, 900));
    await page.waitForFunction(() => document.getElementById("version")?.textContent.startsWith("v"), { timeout: 60000 });
    await check("Real Core uses a separate empty Foundation profile", async () => {
      const status = await call("status"); assert.equal(status.profile.mode, "foundation"); assert.equal(status.network.privacyMode, "local-only"); assert.equal(status.wallet.exists, false); assert.deepEqual(status.plugins, []);
      const actual = await application.evaluate(({ app }) => ({ appData: app.getPath("appData"), userData: app.getPath("userData"), sessionData: app.getPath("sessionData"), name: app.getName() }));
      assert.equal(actual.appData, appData); assert.equal(actual.userData, path.join(appData, "KAI Core"));
      assert.equal(actual.sessionData, actual.userData); assert.equal(actual.name, "KAI Core");
    });
    await check("Settings ends with the migration box and opens its styled dialog", async () => {
      await page.locator('[data-page="settings"]').click();
      assert.equal(await page.locator("#alpha-migration-settings").evaluate(element => element.parentElement.lastElementChild === element), true);
      await page.locator("#alpha-migration-settings").scrollIntoViewIfNeeded(); await capture("settings-bottom.png");
      await page.locator("#alpha-migration-open").click();
      await until(() => page.locator("#alpha-migration-submit").isEnabled(), "Migration inventory did not enable the submit button");
      assert.equal(await page.locator("#alpha-migration-dialog").getAttribute("open"), "");
      assert.equal(await page.locator("#alpha-migration-source-path").textContent(), source);
      assert.equal(await page.locator("#alpha-migration-models").isChecked(), true); assert.equal(await page.locator("#alpha-migration-wallet").isChecked(), true);
      assert.equal(await page.locator('#alpha-migration-dialog input[type="checkbox"]').count(), 3);
      assert.equal(await page.locator("#alpha-migration-delete-old-models").isChecked(), false); assert.equal(await page.locator("#alpha-migration-delete-old-models").isEnabled(), true);
      const inventory = await call("migration.scan"); assert.equal(inventory.models.count, 2); assert.equal(inventory.wallet.address, signer.getAddress());
      assert.equal(/ciphertext|pwHint|privateKey|session\.bin/.test(JSON.stringify(inventory)), false, "Scan exposes only public wallet metadata");
      await capture("migration-dialog.png");
    });
    await check("Models and Wallet can be independently selected or selected together", async () => {
      await page.locator("#alpha-migration-delete-old-models").check();
      await page.locator("#alpha-migration-models").uncheck(); assert.equal(await page.locator("#alpha-migration-submit").isEnabled(), true);
      assert.equal(await page.locator("#alpha-migration-delete-old-models").isDisabled(), true); assert.equal(await page.locator("#alpha-migration-delete-old-models").isChecked(), false);
      await page.locator("#alpha-migration-wallet").uncheck(); assert.equal(await page.locator("#alpha-migration-submit").isDisabled(), true);
      await page.locator("#alpha-migration-models").check(); assert.equal(await page.locator("#alpha-migration-submit").isEnabled(), true);
      assert.equal(await page.locator("#alpha-migration-delete-old-models").isChecked(), false);
      await page.locator("#alpha-migration-wallet").check();
      await page.locator("#alpha-migration-submit").click();
      const job = await waitForJob(); assert.equal(job.phase, "complete", JSON.stringify(job)); report.firstMigration = job;
      await until(() => page.locator("#alpha-migration-outcome").isVisible(), "Dialog did not show completion"); await capture("migration-complete.png");
    });
    const targetWallet = path.join(profile, "wallet/wallet.json");
    await check("Encrypted wallet preserves its address, compression and existing password", async () => {
      const copied = readJson(targetWallet); assert.equal(copied.address, keystore.address); assert.equal(copied.compressed, false); assert.equal(copied.ethAddress, keystore.ethAddress); assert.deepEqual(copied.crypto, keystore.crypto); assert.equal(Object.hasOwn(copied, "pwHint"), false);
      assert.equal(decryptKeystore(copied, password), signer.getPrivateKey("hex"));
      const status = await call("status"); assert.equal(status.wallet.exists, true); assert.equal(status.wallet.unlocked, false); assert.equal(status.wallet.address, signer.getAddress());
      assert.equal(fs.existsSync(path.join(profile, "wallet/session.bin")), false);
      if (process.platform !== "win32") assert.equal(fs.statSync(targetWallet).mode & 0o777, 0o600);
    });
    await check("Only verified model copies and selected encrypted wallet enter Core", async () => {
      const imported = readJson(path.join(profile, "state.json")).customModels; assert.equal(imported.length, 2);
      const hashes = [folderModel, externalModel].map(file => hash(fs.readFileSync(file))).sort(); assert.deepEqual(imported.map(model => model.sha256).sort(), hashes);
      for (const model of imported) { assert.equal(model.path, path.join(profile, "models", "alpha-" + model.sha256 + ".gguf")); assert.equal(hash(fs.readFileSync(model.path)), model.sha256); assert.equal(fs.statSync(model.path).nlink, 1); }
      for (const name of ["account.cfg", "credit-account-fixture.cfg", "documents/private-document.txt", "plugins/data/private-plugin.txt", "brain/private-memory.txt", "models/partial.gguf.part"]) assert.equal(fs.existsSync(path.join(profile, name)), false, "Excluded data was copied: " + name);
      for (const [relative] of Object.entries(snapshot(profile))) { const bytes = fs.readFileSync(path.join(profile, relative)); assert.equal(bytes.includes(Buffer.from(sentinel)), false, "Alpha account/plugin/session metadata leaked into " + relative); }
      assert.equal(readJson(path.join(profile, "settings.json")).network.privacyMode, "local-only"); assert.deepEqual(snapshot(source), sourceBefore); assert.deepEqual(snapshot(external), externalBefore);
    });
    const savedWalletBytes = fs.readFileSync(targetWallet), savedModelState = readJson(path.join(profile, "state.json")).customModels;
    await check("Existing Core wallet is blocked and repeating model migration is idempotent", async () => {
      await page.locator("#alpha-migration-cancel").click(); await page.locator("#alpha-migration-open").click();
      await until(() => page.locator("#alpha-migration-models").isEnabled(), "Rerun inventory did not load");
      assert.equal(await page.locator("#alpha-migration-wallet").isDisabled(), true); assert.equal(await page.locator("#alpha-migration-wallet").isChecked(), false);
      const inventory = await call("migration.scan"); assert.equal(inventory.wallet.blocked, true);
      await assert.rejects(() => call("migration.start", { models: false, wallet: true }), /wallet/i);
      await capture("existing-wallet-preserved.png"); await page.locator("#alpha-migration-submit").click();
      const job = await waitForJob(); assert.equal(job.phase, "complete", JSON.stringify(job)); report.repeatMigration = job;
      await until(() => page.locator("#alpha-migration-outcome").isVisible(), "Rerun dialog did not show completion");
      assert.deepEqual(fs.readFileSync(targetWallet), savedWalletBytes); assert.deepEqual(readJson(path.join(profile, "state.json")).customModels, savedModelState);
      assert.deepEqual(snapshot(source), sourceBefore); assert.deepEqual(snapshot(external), externalBefore);
    });
    await check("Normal wallet UI unlocks the imported wallet using its Alpha password", async () => {
      await until(() => page.locator("#alpha-migration-cancel").isEnabled(), "Migration dialog did not finish"); await page.locator("#alpha-migration-cancel").click();
      await page.locator('[data-page="wallet"]').click(); await page.locator("#password").fill(password); await page.locator("#unlock-button").click();
      await until(async () => (await call("status")).wallet.unlocked === true, "Wallet did not unlock using the Alpha password");
      assert.equal((await call("status")).wallet.address, signer.getAddress()); await page.locator("#lock-wallet").click();
      await until(async () => (await call("status")).wallet.unlocked === false, "Wallet did not lock"); assert.equal(fs.existsSync(path.join(profile, "wallet/session.bin")), false);
      assert.deepEqual(fs.readFileSync(targetWallet), savedWalletBytes); assert.deepEqual(snapshot(source), sourceBefore);
    });
    await check("Earn shows the locked imported wallet's synthetic KAI balance and 1:5 drop in Local-Only", async () => {
      const readEarn = () => page.evaluate(async () => { const response = await fetch("/core/earn"); return { status: response.status, body: await response.json() }; });
      const before = await readEarn(); assert.equal(before.status, 200); assert.equal(before.body.worker.running, false); assert.equal(before.body.wallet.unlocked, false);
      await page.locator('[data-page="earning"]').click();
      await until(async () => await page.locator("#earn-wallet-kai").textContent() === "12,345.67890123", "Earn did not show the synthetic wallet KAI balance");
      assert.equal(await page.locator("#earn-koin-drop").textContent(), "2,469.13578024");
      const after = await readEarn(); assert.equal(after.status, 200); assert.equal(after.body.worker.running, false); assert.equal(after.body.wallet.unlocked, false);
      assert.equal((await call("status")).network.privacyMode, "local-only"); assert.equal(readJson(path.join(profile, "settings.json")).earn.autoStart, false);
      assert.ok(balanceRequests.length > 0); for (const request of balanceRequests) { assert.equal(request.address, signer.getAddress()); assert.equal(request.authorization, undefined); assert.equal(request.cookie, undefined); }
      await page.locator("#earn-legacy-drop").scrollIntoViewIfNeeded(); await capture("earn-imported-wallet-balance.png");
    });
    await check("Opt-in cleanup removes only verified Alpha model originals and moves new same-drive files", async () => {
      const freshModel = path.join(source, "models/alpha-move-fixture.gguf"), freshBytes = ggufFixture("fresh-same-drive-model"), freshHash = hash(freshBytes);
      write(freshModel, freshBytes); const beforeMove = fs.statSync(freshModel);
      await page.locator('[data-page="settings"]').click(); await page.locator("#alpha-migration-open").click();
      await until(() => page.locator("#alpha-migration-models").isEnabled(), "Cleanup inventory did not load");
      assert.equal(await page.locator("#alpha-migration-delete-old-models").isChecked(), false);
      await page.locator("#alpha-migration-delete-old-models").check(); await capture("delete-old-models-review.png");
      await page.locator("#alpha-migration-submit").click();
      const job = await waitForJob(); assert.equal(job.phase, "complete", JSON.stringify(job)); report.cleanupMigration = job;
      assert.equal(job.selected.deleteOldModels, true); assert.equal(job.result.models.deleted, 2); assert.equal(job.result.models.moved, 1); assert.equal(job.result.models.cleanupSkipped, 1);
      assert.equal(fs.existsSync(folderModel), false); assert.equal(fs.existsSync(freshModel), false); assert.deepEqual(snapshot(external), externalBefore);
      const expectedSource = { ...sourceBefore }; delete expectedSource[path.relative(source, folderModel)]; assert.deepEqual(snapshot(source), expectedSource);
      const target = path.join(profile, "models", `alpha-${freshHash}.gguf`); assert.deepEqual(fs.readFileSync(target), freshBytes); assert.equal(fs.statSync(target).nlink, 1);
      assert.equal(fs.statSync(target).ino, beforeMove.ino); assert.equal(fs.statSync(target).dev, beforeMove.dev);
      assert.deepEqual(fs.readFileSync(targetWallet), savedWalletBytes); assert.equal(readJson(path.join(profile, "state.json")).customModels.length, 3);
      await until(() => page.locator("#alpha-migration-outcome").isVisible(), "Cleanup outcome did not appear");
      assert.match(await page.locator("#alpha-migration-outcome-models").textContent(), /2 removed/);
      assert.doesNotMatch(await page.locator("#alpha-migration-selection-note").textContent(), /Alpha files are unchanged/); await capture("delete-old-models-complete.png");
    });
    await check("No renderer or native startup errors occur", async () => {
      assert.deepEqual(pageErrors, []); const state = await application.evaluate(() => global.__foundationSmoke); assert.deepEqual(state.errors, []); report.blockedPublicNetwork = state.blockedNetwork;
      assert.equal(/No handler registered for/.test(logs), false);
    });
    const child = application.process();
    const exited = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error("Core did not quit after 30 seconds")), 30000); child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error("Core exited " + code)); }); });
    await application.evaluate(() => setTimeout(() => global.__foundationTrayMenu.find(item => item.label === "Quit KAI Core Beta").click(), 0)); await exited; application = null;
    report.exit = readJson(exitReport); assert.deepEqual(report.exit.errors, []); assert.equal(report.exit.remainingServices, 0); assert.equal(report.exit.remainingViews, 0);
    report.status = "passed"; report.checks.push("Core quits cleanly after copying or selectively moving Alpha models");
  } catch (error) {
    report.status = "failed"; report.error = error.stack || String(error);
    if (page) await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
    throw error;
  } finally {
    if (application) {
      const child = application.process();
      await application.evaluate(({ app }) => setTimeout(() => app.quit(), 0)).catch(() => {});
      await until(() => child.exitCode !== null || child.signalCode !== null, "Fixture shutdown timed out", 5000).catch(() => { report.cleanupForced = true; child.kill("SIGKILL"); });
    }
    balanceServer.closeAllConnections(); await new Promise(resolve => balanceServer.close(resolve));
    report.logs = logs; report.pageErrors = pageErrors;
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2)); fs.writeFileSync(path.join(output, "electron.log"), logs);
    if (!process.argv.includes("--keep-profile")) fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    console.log("Report", path.join(output, "report.json"));
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
