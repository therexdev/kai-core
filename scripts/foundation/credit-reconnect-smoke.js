"use strict";
// Real Core, native wallet proof and renderer. Network responses, the wallet,
// keychain and profiles are synthetic; no live credits or money are accessed.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const appRoot = path.resolve(process.env.KAI_SMOKE_SOURCE_ROOT || path.join(__dirname, "../.."));
function installNetworkFixture({ runtimeRoot, address }) {
  const { Signer } = require(path.join(appRoot, "node_modules/koilib"));
  const Protocol = require(path.join(runtimeRoot, "core/lib/wallet-credit-account"));
  const config = require(path.join(runtimeRoot, "core/lib/koin-network/credit-service.json")).config, origin = new URL(config.schedulerUrl).origin, pin = Protocol.pin(config, origin);
  const token = "wc_" + crypto.randomBytes(32).toString("base64url"), state = global.__creditReconnectFixture = { proofCount: 0, reviewResponse: 0, requests: [] };
  const freeOwner = "account-" + "f".repeat(64), freeAuth = { deviceFree: true, sessionOnly: true, scope: "device-free", accountId: "fixture-free-device", owner: freeOwner, sessionToken: "fixture-free", schedulerUrl: config.schedulerUrl };
  require(path.join(runtimeRoot, "core/lib/device-free-account")).DeviceFreeAccount = class { async creditAuthorization() { return freeAuth; } assertCreditAuthorization() {} clear() {} dispose() {} };
  const originalFetch = global.fetch;
  let challenge;
  global.fetch = async (url, init = {}) => {
    const u = new URL(String(url)); if (u.origin !== origin) return originalFetch(url, init);
    const body = init.body ? JSON.parse(init.body) : null; state.requests.push(u.pathname);
    const view = { id: "fixture-original-account", scope: "wallet-credits", freeOnly: false, wallets: [{ address }] };
    if (u.pathname === "/auth/wallet-credit/capabilities") return Response.json({ ok: true, capabilities: { walletCredits: 1, freeOnlySessions: 1, scope: "wallet-credits", ...pin, challengeTtlMs: 300000, sessionTtlMs: 2592000000 } });
    if (u.pathname === "/auth/wallet-credit/challenge") {
      assert.equal(body.address, address); assert.equal(body.freeOnly, false); const at = Date.now();
      challenge = { schema: 1, purpose: "wallet-credit-session", ...pin, ...body, nonce: crypto.randomBytes(32).toString("hex"), issuedAt: at, expiresAt: at + 300000, sessionExpiresAt: at + 2592000000 };
      return Response.json({ ok: true, challenge });
    }
    if (u.pathname === "/auth/wallet-credit/verify") {
      assert.equal(body.challengeId, challenge.nonce); assert.equal(Signer.recoverAddress(Protocol.challengeHash(challenge), Buffer.from(body.signature, "base64")), address); state.proofCount++;
      return Response.json({ ok: true, scope: "wallet-credits", freeOnly: false, token, expiresAt: challenge.sessionExpiresAt, account: view });
    }
    if (u.pathname === "/auth/session") { assert.equal(init.headers.authorization, "Bearer " + token); return Response.json({ ok: true, scope: "wallet-credits", freeOnly: false, account: view }); }
    if (u.pathname === new URL(config.schedulerUrl).pathname + "/koin/prepaid/status") {
      const connected = body.sessionToken === token; assert.equal(body.creditWallet, connected ? address : null);
      const purchased = connected ? "199000000" : "0", free = "1000000";
      return Response.json({ ok: true, product: "prepaid-usd-v1", mode: config.mode, paymentsEnabled: true, owner: connected ? address : freeOwner,
        credits: { available: String(BigInt(purchased) + BigInt(free)), purchased: { available: purchased }, free: { available: free, state: "available" }, unit: "USD-1e-8", version: "3" },
        purchases: connected ? [{ id: "fixture-purchase", createdAt: 1, confirmedAt: 2, state: "confirmed", credits: "200000000" }] : [],
        usage: connected ? [{ id: "fixture-usage", at: 3, credits: "1000000", model: "koinos-fast" }] : [] });
    }
    throw Error("Unexpected credit network request in fixture: " + u.pathname);
  };
  const { dialog } = require("electron"), originalReview = dialog.showMessageBox;
  dialog.showMessageBox = async (parent, options) => {
    if (options?.title !== "Connect wallet to network credits") return originalReview(parent, options);
    global.__foundationSmoke.dialogs.push({ title: options.title, message: options.message });
    return { response: state.reviewResponse };
  };
}
async function main() {
  const { _electron } = require("playwright-core"), runtimeRoot = path.resolve(process.env.KAI_SMOKE_RUNTIME_ROOT || appRoot);
  const output = path.resolve(process.env.KAI_CREDIT_RECONNECT_SMOKE_OUTPUT || path.join(os.tmpdir(), "kai-credit-reconnect-smoke")); fs.mkdirSync(output, { recursive: true });
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-credit-reconnect-"))), profile = path.join(temp, "profile"), reportFile = path.join(temp, "exit.json");
  const report = { realCore: true, syntheticNetwork: true, syntheticWallet: true, syntheticKeychain: true, syntheticLock: process.env.KAI_SMOKE_SYNTHETIC_LOCK === "1", checks: [], screenshots: [] };
  require(path.join(appRoot, "electron/foundation-profile")).prepareFoundationProfile(profile);
  fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ network: { privacyMode: "local-first" }, earn: { autoStart: false } }));
  const password = "Synthetic imported wallet password!", wallet = new (require(path.join(appRoot, "core/lib/wallet")).WalletService)(path.join(profile, "wallet"));
  const created = wallet.create({ password }); wallet.lock(); const originalWallet = fs.readFileSync(wallet.keystorePath);
  fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ name: "kai-credit-reconnect-smoke", version: "1.0.0", main: "desktop.js" }));
  fs.writeFileSync(path.join(temp, "desktop.js"), `require(${JSON.stringify(path.join(__dirname, "apps-fixture.js"))}).install(${JSON.stringify({ appRoot: runtimeRoot, appData: path.join(temp, "app-data"), reportFile, syntheticKeychain: true })});\nrequire(${JSON.stringify(__filename)}).installNetworkFixture(${JSON.stringify({ runtimeRoot, address: created.address })});\nrequire(${JSON.stringify(path.join(runtimeRoot, "electron/core-main.js"))});\n`);
  const args = []; if (process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox"); if (process.platform === "linux" && !process.env.DISPLAY) args.push("--ozone-platform=headless"); args.push(temp);
  const env = { ...process.env, KAI_CORE_DATA: profile, KAI_CORE_PORT: "0", KAI_CHANNEL: "core" }; delete env.ELECTRON_RUN_AS_NODE; delete env.KAI_SESSION_SECRET; delete env.KAI_CORE_TOKEN;
  let app, page, logs = ""; const errors = [];
  const until = async (condition, detail) => { const deadline = Date.now() + 30000; do { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline); throw Error(detail); };
  const capture = async name => { const file = path.join(output, name + ".png"); await page.screenshot({ path: file }); report.screenshots.push(file); };
  try {
    app = await _electron.launch({ executablePath: require("electron"), args, env, timeout: 60000 });
    for (const stream of [app.process().stdout, app.process().stderr]) stream?.on("data", chunk => logs = (logs + chunk).slice(-40000));
    page = await app.firstWindow(); page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(30000);
    await app.evaluate(() => global.__foundationWindow.setContentSize(1280, 900));
    await page.waitForFunction(() => document.getElementById("version")?.textContent.startsWith("v"));
    await page.locator('[data-page="credits"]').click(); await until(async () => (await page.locator("#credit-connection-action").textContent()) === "Unlock wallet", "Locked imported wallet was not offered unlock");
    assert.match(await page.locator("#credit-breakdown").textContent(), /purchased balance not connected/); await capture("locked-wallet"); report.checks.push("Imported locked wallet shows restore action and unknown purchased balance");
    await page.locator("#credit-connection-action").click(); await page.locator("#password").fill(password); await page.locator("#unlock-button").click();
    await until(async () => (await page.evaluate(() => window.kaiCore.call("status"))).wallet.unlocked, "Fixture wallet did not unlock");
    await page.locator('[data-page="credits"]').click(); await until(async () => (await page.locator("#credit-connection-action").textContent()) === "Restore wallet credits", "Restore credits button missing");
    await capture("restore-wallet-credits"); await page.locator("#credit-connection-action").click(); await until(async () => await page.locator("#credit-connection-action").isEnabled(), "Cancelled review remained busy");
    assert.equal(await app.evaluate(() => global.__creditReconnectFixture.proofCount), 0); report.checks.push("Cancelling native review signs no wallet proof and preserves the guest state");
    await app.evaluate(() => global.__creditReconnectFixture.reviewResponse = 1); await page.locator("#credit-connection-action").click();
    await until(async () => await page.locator("#credit-connection").isHidden(), "Verified credit connection did not complete");
    await until(async () => /1,990 purchased/.test(await page.locator("#credit-breakdown").textContent()), "Purchased balance did not restore");
    assert.match(await page.locator("#credit-activity").textContent(), /Purchased credits/); assert.match(await page.locator("#credit-activity").textContent(), /koinos-fast/); await capture("restored-credits-and-activity");
    const fixtureState = await app.evaluate(() => global.__creditReconnectFixture); assert.equal(fixtureState.proofCount, 1); assert.ok(!fixtureState.requests.some(route => /quote|purchase$/.test(route)));
    report.checks.push("Accepted wallet proof restores purchased balance and both remote activity types without purchase");
    assert.deepEqual(fs.readFileSync(wallet.keystorePath), originalWallet); assert.deepEqual(errors, []); assert.deepEqual((await app.evaluate(() => global.__foundationSmoke)).errors, []);
    const process = app.process(), ended = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error("Core quit timed out")), 30000); process.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error("Core exit " + code)); }); });
    await app.evaluate(() => setTimeout(() => global.__foundationTrayMenu.find(row => row.label === "Quit KAI Core Beta").click(), 0)); await ended; app = null;
    report.checks.push("Wallet file is unchanged and Core exits without renderer/native errors"); report.status = "passed";
  } catch (error) { report.status = "failed"; report.error = error.stack; if (page) await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {}); throw error; }
  finally { if (app) await app.close().catch(() => {}); report.logs = logs; report.errors = errors; fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2)); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); console.log("Report", path.join(output, "report.json")); }
}
module.exports = { installNetworkFixture };
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
