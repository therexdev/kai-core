"use strict";
// Launch the real Core entry with a synthetic existing profile. This does not
// read the user's normal appData, wallet, model files, credentials or accounts.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");
const { WalletService } = require("../../core/lib/wallet");

async function windowState(application) {
  return application.evaluate(() => {
    const window = global.__smokeMainWindow, destroyed = !window || window.isDestroyed();
    return { destroyed, visible: !destroyed && window.isVisible(), id: destroyed ? null : window.id, lifecycle: { ...global.__smokeLifecycle } };
  });
}
async function waitForWindow(application, predicate, description) {
  const deadline = Date.now() + 10000; let state;
  do {
    state = await windowState(application); if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw Error(`${description}: ${JSON.stringify(state)}`);
}
async function exitThrough(application, action) {
  const child = application.process(); let timer, listener;
  const exited = new Promise((resolve, reject) => {
    listener = (code, signal) => resolve({ code, signal }); child.once("exit", listener);
    timer = setTimeout(() => reject(Error(`Desktop did not exit after ${action}`)), 20000);
  });
  try {
    await application.evaluate(({ app }, action) => {
      if (action === "tray-quit") global.__smokeShutdownDelay = 250;
      setTimeout(() => {
        if (action === "tray-quit") {
          global.__smokeTrayMenu.find(item => item.label === "Quit KAI Core").click();
          setTimeout(() => app.quit(), 75); // A second Quit must not bypass asynchronous teardown.
        } else global.__smokeMainWindow.close();
      }, 0);
    }, action);
    return await exited;
  } finally { clearTimeout(timer); child.removeListener("exit", listener); }
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-desktop-smoke-")));
  const appData = path.join(root, "app-data"), dataDir = path.join(appData, "Koinos AI", "core");
  fs.mkdirSync(path.join(dataDir, "models"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "chats"));
  const settings = { network: { privacyMode: "local-only" }, earn: { autoStart: false }, fixture: "preserve-me" };
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify(settings));
  fs.writeFileSync(path.join(dataDir, "models", "preserved-model-canary.gguf"), "SYNTHETIC-NOT-A-REAL-MODEL");
  fs.writeFileSync(path.join(dataDir, "companion-hub.json"), '{"synthetic":"preserved-workflows-and-brain"}');
  fs.writeFileSync(path.join(dataDir, "chats", "smoke.json"), JSON.stringify({ id: "smoke", title: "Preserved conversation", messages: [{ role: "user", content: "Synthetic history" }] }));
  const wallet = new WalletService(path.join(dataDir, "wallet"));
  const password = "synthetic-smoke-password-42";
  const address = wallet.create({ password }).address;
  wallet.lock();
  const walletBefore = fs.readFileSync(path.join(dataDir, "wallet", "wallet.json"), "utf8");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "kai-desktop-smoke", version: require("../../package.json").version, main: "desktop.js" }));
  const wrapper = path.join(root, "desktop.js");
  const appRoot = process.env.KAI_SMOKE_SOURCE_ROOT || path.resolve(__dirname, "../..");
  // Only the fixture wraps outbound fetch. The production entry runs unchanged.
  fs.writeFileSync(wrapper, `"use strict";
const electron = require(${JSON.stringify(require.resolve("electron"))});
electron.app.setPath('appData', ${JSON.stringify(appData)});
electron.app.disableHardwareAcceleration();
electron.dialog.showErrorBox = (title, message) => console.error("SMOKE_STARTUP_ERROR", title, message);
${process.env.KAI_SMOKE_SYNTHETIC_LOCK === '1' ? 'electron.app.requestSingleInstanceLock = () => true; // Fixture only: container forbids Unix sockets.' : ''}
require(${JSON.stringify(path.join(__dirname, "desktop-fixture.js"))}).install({ appRoot: ${JSON.stringify(appRoot)} });
require(${JSON.stringify(path.join(appRoot, "electron/core-main.js"))});
`);
  // Electron's npm module resolves to the binary under Node, but in Electron
  // itself `require('electron')` is a built-in module. Avoid the npm shim path.
  fs.writeFileSync(wrapper, fs.readFileSync(wrapper, "utf8").replace(`require(${JSON.stringify(require.resolve("electron"))})`, "require('electron')"));
  const args = [];
  if (process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox");
  if (process.platform === "linux" && !process.env.DISPLAY) args.push("--ozone-platform=headless");
  args.push(root);
  const lifecycleFile = path.join(root, "lifecycle.json");
  const env = { ...process.env, KAI_CORE_DATA: dataDir, KAI_CORE_PORT: "0", KAI_CHANNEL: "core", KAI_SMOKE_LIFECYCLE_FILE: lifecycleFile, KAI_SMOKE_TRAY_MODE: "auto" };
  delete env.ELECTRON_RUN_AS_NODE; delete env.KAI_CORE_TOKEN; delete env.KAI_SESSION_SECRET;
  let application, output = "";
  const pageErrors = [];
  try {
    application = await electron.launch({ executablePath: require("electron"), args, env, timeout: 30000 });
    application.process().stdout?.on("data", chunk => { output = (output + chunk).slice(-10000); });
    application.process().stderr?.on("data", chunk => { output = (output + chunk).slice(-10000); });
    const page = await application.firstWindow({ timeout: 30000 });
    page.on("pageerror", error => pageErrors.push(error.message));
    page.setDefaultTimeout(20000);
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.waitForFunction(() => document.getElementById("wallet-address")?.textContent && document.getElementById("wallet-address").textContent !== "No wallet created", null, { timeout: 15000 });
    const status = await page.evaluate(() => window.kaiCore.call("status"));
    assert.equal(status.profile.mode, "existing");
    assert.equal(status.profile.dataDir, dataDir);
    assert.equal(status.profile.modelsReused, true);
    assert.equal(status.profile.preserved.wallet, true);
    assert.equal(status.profile.preserved.chats, true);
    assert.equal(status.profile.preserved.workflowsAndBrain, true);
    assert.equal(status.wallet.address, address);
    assert.equal(status.network.privacyMode, "local-only");
    assert.equal(await page.locator("#notice.error").count(), 0);
    assert.equal(await application.evaluate(({ app }) => app.getName()), "Koinos AI");
    assert.equal(await application.evaluate(({ app }) => app.getPath("userData")), path.join(appData, "Koinos AI"));
    assert.equal(status.desktop?.trayAvailable, true, `tray initialization failed: ${JSON.stringify(await windowState(application))}`);
    assert.equal(await page.locator('[data-panel="chat"]').isVisible(), true, "simple Chat is the default page");
    assert.equal(await page.locator('[data-page="credits"]').textContent(), "Credits and Usage");
    assert.equal(await page.locator('[data-page="wallet"]').textContent(), "Wallet");
    assert.equal(await page.locator("#sidebar .product-sidebar-credits, #sidebar [data-credit-total]").count(), 0, "sidebar must not contain the removed credit box");
    assert.equal(await page.locator("#sidebar").evaluate(node => getComputedStyle(node).backgroundColor), "rgb(255, 255, 255)");
    const settingsPosition = await page.locator('.rail-icons [data-page="settings"]').boundingBox(), networkPosition = await page.locator('.rail-icons [data-page="network"]').boundingBox();
    assert.ok(settingsPosition && networkPosition && Math.abs(settingsPosition.y - networkPosition.y) < 3, "Settings and Network must share the bottom rail");
    const screenshotDir = process.env.KAI_SMOKE_SCREENSHOT_DIR || path.join(os.tmpdir(), "kai-core-desktop-screenshots");
    fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshot = process.env.KAI_SMOKE_SCREENSHOT || path.join(screenshotDir, "chat.png");
    const capture = async name => page.screenshot({ path: path.join(screenshotDir, name + ".png"), fullPage: false });
    const open = async tab => { await page.locator(`[data-page="${tab}"]`).click(); assert.equal(await page.locator(`[data-panel="${tab}"]`).isVisible(), true, `${tab} did not open`); assert.equal(await page.locator("[data-panel]:visible").count(), 1); };
    for (const tab of ["models", "plugins", "wallet", "credits", "earning", "network", "settings", "chat"]) await open(tab);
    assert.equal(await page.locator('[data-panel="settings"]').getByText("Storage & continuity").count(), 0);
    await open("plugins");
    const catalog = (await page.evaluate(() => window.kaiCore.call("status"))).catalog;
    assert.equal(catalog.length, 11, "all eleven official plugins must be available offline");
    assert.equal(await page.locator("#plugin-catalog article").count(), 11);
    assert.equal(await page.locator("#plugin-catalog .plugin-icon svg").count(), 11, "every plugin needs an icon");
    const cards = await page.locator("#plugin-catalog article").evaluateAll(nodes => nodes.map(node => ({ name: node.querySelector("h2")?.textContent, description: node.querySelector(".plugin-heading + p")?.textContent })));
    for (const card of cards) { assert.ok(card.name && !card.name.startsWith("kai-plugin-")); assert.ok(card.description && card.description.length > 15 && card.description.length < 200, "plugin needs a short readable description"); }
    const details = page.locator("#third-party-install");
    assert.equal(await details.getAttribute("open"), null);
    assert.equal(await details.locator("summary").textContent(), "Install 3rd Party Plugins");
    assert.equal(await page.locator("#install-url").isVisible(), false);
    assert.ok(await details.evaluate(node => !!(document.getElementById("plugin-catalog").compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)), "third-party installation must follow the marketplace");
    await capture("plugins");
    await details.locator("summary").click(); assert.equal(await page.locator("#install-url").isVisible(), true);
    await page.locator("#plugin-url").fill("https://example.invalid/synthetic.kaiplugin");
    const installButton = page.locator("#install-url button");
    await installButton.scrollIntoViewIfNeeded();
    await installButton.click({ trial: true }); // Check actionability without submitting the form.
    const installVisibility = await installButton.evaluate(button => {
      const rectangle = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const viewport = { width: innerWidth, height: innerHeight, devicePixelRatio };
      const clip = { left: 0, top: 0, right: viewport.width, bottom: viewport.height }, ancestors = [];
      for (let node = button.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node), clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX), clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
        if (!clipsX && !clipsY) continue;
        const r = rectangle(node), bounds = { left: r.left + node.clientLeft, top: r.top + node.clientTop, right: r.left + node.clientLeft + node.clientWidth, bottom: r.top + node.clientTop + node.clientHeight };
        if (clipsX) { clip.left = Math.max(clip.left, bounds.left); clip.right = Math.min(clip.right, bounds.right); }
        if (clipsY) { clip.top = Math.max(clip.top, bounds.top); clip.bottom = Math.min(clip.bottom, bounds.bottom); }
        ancestors.push({ element: node.id || node.dataset.panel || node.className || node.tagName, bounds, scrollTop: node.scrollTop });
      }
      const bounds = rectangle(button), inset = Math.min(2, bounds.width / 4, bounds.height / 4);
      const centerX = (bounds.left + bounds.right) / 2, centerY = (bounds.top + bounds.bottom) / 2;
      // Sample the straight edges, avoiding non-interactive rounded corners.
      const points = [[centerX, bounds.top + inset], [centerX, bounds.bottom - inset], [bounds.left + inset, centerY], [bounds.right - inset, centerY], [centerX, centerY]];
      const receivesPointer = points.every(([x, y]) => { const target = document.elementFromPoint(x, y); return target === button || button.contains(target); });
      return { viewport, button: bounds, clip, ancestors, receivesPointer };
    });
    const { button: installPosition, clip: installClip } = installVisibility, pixelTolerance = 1;
    assert.ok(installPosition.width > 0 && installPosition.height > 0 && installVisibility.receivesPointer &&
      installPosition.left >= installClip.left - pixelTolerance && installPosition.top >= installClip.top - pixelTolerance &&
      installPosition.right <= installClip.right + pixelTolerance && installPosition.bottom <= installClip.bottom + pixelTolerance,
    `expanded installation form must scroll into view: ${JSON.stringify(installVisibility)}`);
    await page.locator('[data-panel="plugins"]').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await capture("third-party-install"); await page.locator("#plugin-url").fill(""); await details.locator("summary").click();
    const refreshBlocked = await page.evaluate(() => window.kaiCore.call("plugins.registry.refresh").then(() => false, error => /Local-Only/i.test(error.message)));
    assert.equal(refreshBlocked, true); assert.equal((await page.evaluate(() => window.kaiCore.call("status"))).catalog.length, 11);
    await open("models"); assert.ok(await page.locator("#models article").count() > 0); await capture("models");
    await open("wallet");
    assert.equal(await page.locator("#create-wallet").isVisible(), false); assert.equal(await page.locator("#restore-wallet").isVisible(), false);
    assert.equal(await page.locator('[data-panel="wallet"] h1').textContent(), "Wallet");
    assert.equal(await page.locator(".payment-wallet-stat").count(), 3, "original KOIN, VHP and Mana cards must be present");
    assert.equal(await page.locator("#wallet-koin").textContent(), "—", "Local-Only must not invent a wallet balance");
    assert.equal(await page.locator("#wallet-open-send").isDisabled(), true, "a locked wallet cannot send");
    assert.deepEqual(await application.evaluate(() => global.__smokeWalletCalls), [], "Local-Only must not read chain balances or history");
    const notice = page.locator("#notice"), dismissNotice = page.locator("#notice-close");
    const wrongPassword = async () => {
      await page.locator("#password").fill("synthetic-wrong-password"); await page.locator("#unlock-button").click();
      await page.waitForFunction(() => !document.getElementById("notice").hidden && document.getElementById("notice-message").textContent.includes("Incorrect password"));
      await page.waitForFunction(() => !document.getElementById("unlock-button").disabled);
      assert.match(await page.locator("#notice-message").textContent(), /Check Caps Lock and keyboard layout/);
      assert.equal(await page.locator("#password").inputValue(), "");
    };
    await wrongPassword();
    assert.equal(await dismissNotice.getAttribute("type"), "button");
    assert.equal(await dismissNotice.getAttribute("aria-label"), "Dismiss message");
    await page.setViewportSize({ width: 800, height: 700 });
    await dismissNotice.click({ trial: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "wallet warning must wrap within the compact viewport");
    await capture("wallet-warning");
    await dismissNotice.click(); assert.equal(await notice.isVisible(), false);
    await page.evaluate(() => refresh());
    await open("models"); await open("wallet");
    assert.equal(await notice.isVisible(), false, "dismissed wallet warning must stay hidden after refresh and navigation");
    const walletAfterDismiss = (await page.evaluate(() => window.kaiCore.call("status"))).wallet;
    assert.equal(walletAfterDismiss.address, address); assert.equal(walletAfterDismiss.unlocked, false, "dismissal must not unlock the wallet");
    assert.equal(fs.readFileSync(path.join(dataDir, "wallet", "wallet.json"), "utf8"), walletBefore, "dismissal must not alter the saved wallet");
    await wrongPassword();
    await dismissNotice.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
    assert.equal(await dismissNotice.evaluate(button => document.activeElement === button), true, "dismiss control must be reachable by keyboard");
    await page.keyboard.press("Enter"); assert.equal(await notice.isVisible(), false);
    await page.evaluate(() => notify("Synthetic notice <img src=x onerror=attack()>"));
    assert.equal(await notice.isVisible(), true); assert.equal(await notice.locator("img").count(), 0, "notice content must remain literal text");
    assert.equal(await notice.getAttribute("class").then(value => /\berror\b/.test(value || "")), false);
    await dismissNotice.click(); assert.equal(await notice.isVisible(), false);
    await wrongPassword(); // A successful explicit retry must also clear the previous warning.
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.locator("#password").fill(password); await page.locator("#unlock-button").click();
    await page.waitForFunction(() => !document.getElementById("lock-wallet").hidden, null, { timeout: 15000 });
    assert.equal((await page.evaluate(() => window.kaiCore.call("status"))).wallet.address, address);
    assert.equal(await notice.isVisible(), false, "successful wallet retry must clear the stale incorrect-password warning");
    await page.locator("#lock-wallet").click(); await page.waitForFunction(() => !document.getElementById("unlock-button").hidden, null, { timeout: 15000 });
    assert.equal(await page.locator("#password").inputValue(), ""); await capture("wallet");
    await open("credits"); await page.waitForFunction(() => document.getElementById("credits").textContent.replace(/[^0-9]/g, "") === "3000");
    assert.equal(await page.locator('[data-panel="credits"] h1').textContent(), "Your Credits");
    assert.equal(await page.locator("#credit-activity tbody tr").count(), 2);
    await page.locator("#credit-filter").selectOption("usage"); assert.equal(await page.locator("#credit-activity tbody tr").count(), 1); assert.match(await page.locator("#credit-activity").textContent(), /Synthetic network model/);
    await page.locator("#credit-filter").selectOption("all"); await capture("credits");
    const buy = page.locator('[data-panel="credits"] [data-go="buy-credits"]');
    const creditHeading = await page.locator('[data-panel="credits"] h1').boundingBox(), buyPosition = await buy.boundingBox();
    assert.ok(buyPosition.x > creditHeading.x && Math.abs(buyPosition.y - creditHeading.y) < 35, "Buy credits belongs at the top right");
    await buy.click(); assert.equal(await page.locator('[data-panel="buy-credits"]').isVisible(), true); assert.equal(await page.locator("#buy-credits").isVisible(), true); await capture("buy-credits");
    await open("earning"); await page.waitForFunction(() => document.getElementById("provider-label")?.textContent === "OFFLINE");
    assert.equal(await page.locator("#earning-toggle").getAttribute("aria-checked"), "false");
    assert.equal(await page.locator("#earn-wallet-kai").textContent(), "—"); assert.equal(await page.locator("#earn-koin-drop").textContent(), "—");
    assert.match(await page.locator("#earn-legacy-drop").textContent(), /Wallet KAI:.*KOIN Drop:/s);
    assert.equal((await application.evaluate(() => global.__smokeCreditCalls)).some(row => row.action === "provider-public-start"), false, "opening Earn must not start a provider");
    await capture("earning-off");
    await open("network"); await page.waitForFunction(() => document.getElementById("core-network-state")?.textContent); await capture("network-local-only");
    assert.deepEqual(await application.evaluate(() => global.__smokeExternalCalls), [], "Local-Only desktop attempted an external fetch");
    await open("settings"); assert.equal(await page.locator("#privacy").inputValue(), "local-only"); await capture("settings");
    await open("chat"); await page.waitForFunction(() => document.querySelector('#chat-model option[value="smoke-local"]'));
    await page.locator("#chat-model").selectOption("smoke-local"); await page.locator("#chat-input").fill("Hello from the synthetic desktop"); await page.locator("#chat-send").click();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("Synthetic local answer"));
    assert.equal(await page.locator("#chat-messages img").count(), 0, "model output must remain text");
    const requests = await application.evaluate(() => global.__smokeChatRequests);
    assert.equal(requests.length, 1); assert.equal(requests[0].kai_private_desktop, true); assert.equal(requests[0].model, "smoke-local"); assert.ok(!requests[0].tools);
    assert.equal(requests[0].messages.at(-1).content, "Hello from the synthetic desktop");
    await page.screenshot({ path: screenshot, fullPage: false });
    await application.evaluate(() => { global.__smokeLocalMode = "delay"; });
    await page.locator("#chat-input").fill("Stop this local request"); await page.locator("#chat-send").click();
    await page.waitForFunction(() => !document.getElementById("chat-stop").hidden); await page.locator("#chat-stop").click();
    await page.waitForFunction(() => !document.getElementById("chat-send").disabled);
    await application.evaluate(() => { global.__smokeLocalMode = "reply"; global.__smokeSetPrivacy("local-first"); }); await page.evaluate(() => refresh());
    await open("wallet");
    await page.waitForFunction(() => document.getElementById("wallet-koin").textContent.replaceAll(",", "") === "12345.67890123");
    assert.equal(await page.locator("#wallet-vhp").textContent(), "876.54321"); assert.equal(await page.locator("#wallet-mana").textContent(), "12.5");
    assert.equal(await page.locator("#wallet-lock-state").textContent(), "Locked", "balances and history must remain readable while locked");
    await page.waitForFunction(() => document.querySelectorAll("#wallet-history-rows tr").length === 1);
    assert.match(await page.locator("#wallet-history-rows").textContent(), /Received/); assert.match(await page.locator("#wallet-history-rows").textContent(), /\+2\.5 KOIN/);
    await capture("wallet-balances");
    await page.locator("#wallet-history-more").click(); await page.waitForFunction(() => document.querySelectorAll("#wallet-history-rows tr").length === 2);
    assert.match(await page.locator("#wallet-history-rows").textContent(), /Sent/);
    await page.locator("#wallet-history-refresh").click(); await page.waitForFunction(() => document.querySelectorAll("#wallet-history-rows tr").length === 1);
    await page.locator("#wallet-copy").click(); assert.equal(await application.evaluate(() => global.__smokeClipboard()), address);
    await page.locator("#wallet-explorer").click();
    assert.ok((await application.evaluate(() => global.__smokeWalletCalls)).some(row => row.method === "openExplorer" && row.url === `https://koinosblocks.com/address/${address}`));
    await application.evaluate(() => { global.__smokeWalletMode = "unavailable"; }); await page.evaluate(() => window.KaiCoreWallet.refresh());
    await page.waitForFunction(() => document.getElementById("wallet-balance-note").textContent.includes("Previously checked balances"));
    assert.equal((await page.locator("#wallet-koin").textContent()).replaceAll(",", ""), "12345.67890123", "last known balance must be explicitly marked as previous after a failed read");
    assert.equal(await page.locator("#wallet-open-send").isDisabled(), true, "unverified balances must not enable Send");
    const balanceError = page.locator("#wallet-balance-error"), closeBalanceError = page.locator("#wallet-balance-error-close");
    assert.equal(await balanceError.isVisible(), true); assert.match(await page.locator("#wallet-balance-error-text").textContent(), /Synthetic wallet balance unavailable/);
    const readsBeforeDismiss = (await application.evaluate(() => global.__smokeWalletCalls)).length;
    await closeBalanceError.focus(); await page.keyboard.press("Enter"); assert.equal(await balanceError.isVisible(), false);
    assert.equal((await application.evaluate(() => global.__smokeWalletCalls)).length, readsBeforeDismiss, "dismissing a read error must not perform any wallet action");
    await page.evaluate(() => refresh()); assert.equal(await balanceError.isVisible(), false, "status refresh must not reopen a dismissed read error");
    await page.evaluate(() => window.KaiCoreWallet.refresh()); assert.equal(await balanceError.isVisible(), true, "an explicit failed retry must reopen the error");
    await closeBalanceError.click(); assert.equal(await balanceError.isVisible(), false);
    await application.evaluate(() => { global.__smokeWalletMode = "ready"; }); await page.evaluate(() => window.KaiCoreWallet.refresh());
    await page.waitForFunction(() => document.getElementById("wallet-koin").textContent.replaceAll(",", "") === "12345.67890123");
    await page.locator("#password").fill(password); await page.locator("#unlock-button").click();
    await page.waitForFunction(() => !document.getElementById("wallet-open-send").disabled);
    await page.locator("#wallet-open-send").click();
    await page.locator("#wallet-send-to").fill(address); await page.locator("#wallet-send-amount").fill("0.01000000"); await page.locator("#wallet-send-password").fill(password);
    await page.locator("#wallet-send-submit").click();
    await page.waitForFunction(() => /cancelled/i.test(document.getElementById("wallet-message").textContent));
    assert.equal(await page.locator("#wallet-send-password").inputValue(), "");
    const walletReview = (await application.evaluate(() => global.__smokeWalletReviews)).find(row => row.title === "Send KOIN");
    assert.ok(walletReview, "Send must open a native review"); assert.match(walletReview.message, /0\.01 KOIN/); assert.ok(walletReview.detail.includes(`To: ${address}`));
    assert.deepEqual(walletReview.buttons, ["Cancel", "Send"]); assert.equal(walletReview.defaultId, 0); assert.equal(walletReview.cancelId, 0);
    assert.equal((await application.evaluate(() => global.__smokeWalletCalls)).filter(row => row.method === "transfer").length, 0, "cancelled review must never sign or submit a transfer");
    await page.locator("#wallet-message-close").click(); assert.equal(await page.locator("#wallet-notice").isVisible(), false);
    await page.locator("#wallet-reveal-panel summary").click(); await page.locator("#wallet-reveal-password").fill(password); await page.locator("#wallet-reveal-submit").click();
    await page.waitForFunction(() => !document.getElementById("wallet-backup").hidden && document.getElementById("wallet-backup").textContent.length > 30);
    assert.equal(await page.locator("#wallet-reveal-password").inputValue(), "");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    assert.equal(await page.locator("#wallet-backup").isVisible(), false); assert.equal(await page.locator("#wallet-backup").textContent(), "", "backup secret must be erased on blur");
    await page.locator("#lock-wallet").click(); await page.waitForFunction(() => !document.getElementById("unlock-button").hidden);
    await page.evaluate(async () => { await window.kaiCore.call("privacy", { mode: "local-only" }); await refresh(); });
    await page.waitForFunction(() => document.getElementById("wallet-koin").textContent === "—");
    assert.equal(await page.locator("#wallet-history-rows tr").count(), 0, "privacy change must clear the previous network history");
    await page.evaluate(async () => { await window.kaiCore.call("privacy", { mode: "local-first" }); await refresh(); });
    await open("earning"); await page.locator("#earning-toggle").click();
    await page.waitForFunction(() => document.getElementById("provider-label")?.textContent === "ONLINE");
    await page.waitForFunction(() => document.getElementById("earn-wallet-kai").textContent.replaceAll(",", "") === "12345.67890123");
    assert.equal((await page.locator("#earn-koin-drop").textContent()).replaceAll(",", ""), "2469.13578024", "drop estimate must be exact and exclude pending KAI");
    assert.match(await page.locator("#earn-legacy-drop").getAttribute("title"), /1 KOIN per 5 KAI/);
    for (const mode of ["unavailable", "mismatch"]) {
      await application.evaluate((_electron, mode) => { global.__smokeLegacyMode = mode; }, mode); await page.evaluate(() => window.KaiCoreEarning.refresh());
      await page.waitForFunction(() => document.getElementById("earn-wallet-kai").textContent === "—");
      assert.equal(await page.locator("#earn-koin-drop").textContent(), "—", `${mode} balance must clear both amounts`);
    }
    await application.evaluate(() => { global.__smokeLegacyMode = "ready"; }); await page.evaluate(() => window.KaiCoreEarning.refresh());
    await page.waitForFunction(() => document.getElementById("earn-wallet-kai").textContent.replaceAll(",", "") === "12345.67890123");
    assert.equal(await page.locator("#earning-toggle").getAttribute("aria-checked"), "true"); await capture("earning-online");
    await page.locator("#earning-toggle").click(); await page.waitForFunction(() => document.getElementById("provider-label")?.textContent === "OFFLINE");
    await open("network"); await page.waitForFunction(() => document.querySelectorAll("#core-network-models [data-network-model]").length || document.getElementById("core-network-models")?.textContent.includes("smoke-network")); await capture("network");
    await open("chat"); await page.locator("#chat-new").click(); await page.locator("#chat-source").selectOption("network");
    await page.waitForFunction(() => document.querySelector('#chat-model option[value="koinos-network:smoke-network"], #chat-model option[value="smoke-network"]'));
    const networkModel = await page.locator("#chat-model option").evaluateAll(options => options.find(option => option.value.includes("smoke-network"))?.value);
    await page.locator("#chat-model").selectOption(networkModel); await page.locator("#chat-input").fill("Synthetic paid/free network request"); await page.locator("#chat-send").click();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("Synthetic network answer"));
    await page.waitForFunction(() => !document.getElementById("chat-send").disabled);
    const creditCalls = await application.evaluate(() => global.__smokeCreditCalls);
    const networkSend = creditCalls.find(row => row.action === "chat-completion");
    assert.equal(networkSend.input.model, "koinos-network:smoke-network");
    assert.ok(creditCalls.some(row => row.action === "chat-ack" && row.input === "a".repeat(64)), "network delivery must be acknowledged through its existing journal");
    assert.ok(!creditCalls.some(row => /purchase-(connect|preview|approve)/.test(row.action)), "test must never create a paid purchase");
    await capture("chat-network");
    await application.evaluate(() => { global.__smokeNetworkMode = "delay"; });
    await page.locator("#chat-input").fill("Stop this network request"); await page.locator("#chat-send").click();
    await page.waitForFunction(() => document.getElementById("chat-status").textContent === "Waiting for the network model…");
    await page.locator("#chat-stop").click(); await page.waitForFunction(() => !document.getElementById("chat-send").disabled);
    assert.ok((await application.evaluate(() => global.__smokeCreditCalls)).some(row => row.action === "stop"));
    await application.evaluate(() => { global.__smokeNetworkMode = "recoverable"; });
    await page.locator("#chat-input").fill("Recover this request"); await page.locator("#chat-send").click();
    await page.waitForFunction(() => !document.getElementById("chat-recovery").hidden && !document.getElementById("chat-recover").disabled);
    assert.equal((await application.evaluate(() => global.__smokeCreditCalls)).filter(row => row.action === "chat-recover").length, 0, "saved paid requests must never recover automatically");
    await capture("chat-recovery"); await page.locator("#chat-recover").click();
    await page.waitForFunction(() => document.getElementById("chat-messages").textContent.includes("Recovered synthetic answer") && !document.getElementById("chat-send").disabled);
    assert.equal((await application.evaluate(() => global.__smokeCreditCalls)).filter(row => row.action === "chat-recover").length, 1);
    assert.equal((await application.evaluate(() => global.__smokeCreditCalls)).filter(row => row.action === "chat-ack").length, 2);
    await application.evaluate(() => { global.__smokeNetworkMode = "reply"; });
    await open("network"); await page.locator("#core-network-models button").click();
    assert.equal(await page.locator('[data-panel="chat"]').isVisible(), true, "Network model should open simple Chat");
    assert.equal(await page.locator("#chat-source").inputValue(), "network");
    assert.equal(await page.locator("#chat-model").inputValue(), "smoke-network");
    await page.setViewportSize({ width: 800, height: 700 });
    for (const tab of ["chat", "models", "plugins", "wallet", "credits", "buy-credits", "earning", "network", "settings"]) {
      if (tab === "buy-credits") await page.locator('[data-panel="credits"] [data-go="buy-credits"]').click(); else await open(tab);
      await capture(tab + "-compact");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${tab} overflowed the compact viewport`);
    }
    await page.setViewportSize({ width: 1200, height: 820 });
    await open("earning"); await page.locator("#earning-toggle").click();
    await page.waitForFunction(() => document.getElementById("provider-label")?.textContent === "ONLINE");
    const beforeHide = await windowState(application), trayMode = beforeHide.lifecycle.trayMode;
    assert.ok(["native", "synthetic"].includes(trayMode));
    assert.equal(beforeHide.lifecycle.providerEnabled, true);
    await application.evaluate(() => global.__smokeMainWindow.close());
    const hidden = await waitForWindow(application, state => !state.destroyed && !state.visible && state.lifecycle.providerTicks > beforeHide.lifecycle.providerTicks, "main window did not hide while the provider fixture continued running");
    assert.equal(hidden.id, beforeHide.id); assert.equal(hidden.lifecycle.providerEnabled, true);
    assert.equal(hidden.lifecycle.coreStops, 0); assert.equal(hidden.lifecycle.paymentDisposals, 0); assert.equal(hidden.lifecycle.beforeQuit, 0);
    assert.equal(application.process().exitCode, null);
    const gatewayWhileHidden = await fetch(hidden.lifecycle.gatewayOrigin + "/", { signal: AbortSignal.timeout(5000) });
    assert.equal(gatewayWhileHidden.status, 200); assert.match(await gatewayWhileHidden.text(), /KAI Core/);
    await application.evaluate(() => global.__smokeTrayMenu.find(item => item.label === "Open KAI Core").click());
    const reopened = await waitForWindow(application, state => state.visible, "tray Open did not restore the main window");
    assert.equal(reopened.id, beforeHide.id); assert.equal(reopened.lifecycle.providerEnabled, true);
    await application.evaluate(() => global.__smokeMainWindow.close());
    await waitForWindow(application, state => !state.destroyed && !state.visible, "second close did not hide the main window");
    await application.evaluate(({ app }) => app.emit("second-instance", {}, [], process.cwd()));
    assert.equal((await waitForWindow(application, state => state.visible, "second-instance did not restore the main window")).id, beforeHide.id);
    await application.evaluate(() => global.__smokeMainWindow.close());
    await waitForWindow(application, state => !state.destroyed && !state.visible, "third close did not hide the main window");
    assert.deepEqual(pageErrors, [], "renderer raised an uncaught error");
    assert.deepEqual(await application.evaluate(() => global.__smokeExternalCalls), [], "synthetic desktop attempted an external fetch");
    assert.deepEqual(await exitThrough(application, "tray-quit"), { code: 0, signal: null }, "tray Quit should exit successfully");
    const explicitQuit = JSON.parse(fs.readFileSync(lifecycleFile, "utf8"));
    assert.equal(explicitQuit.coreStops, 1); assert.equal(explicitQuit.coreStopped, true);
    assert.equal(explicitQuit.paymentDisposals, 1); assert.equal(explicitQuit.paymentsDisposed, true); assert.equal(explicitQuit.providerEnabled, false);
    assert.equal(explicitQuit.repeatedQuitDuringCoreStop, true, "the repeated Quit must occur while teardown is pending");
    assert.equal(explicitQuit.trayDestroyed, true); assert.equal(explicitQuit.willQuit, true); assert.equal(explicitQuit.quit, true);
    await assert.rejects(fetch(explicitQuit.gatewayOrigin + "/", { signal: AbortSignal.timeout(3000) }), "gateway must stop after explicit Quit");
    // Launch the same synthetic profile with a deliberate native Tray failure.
    // Normal close must still exit instead of stranding a hidden application.
    const fallbackSettings = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
    fallbackSettings.network.privacyMode = "local-only";
    fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify(fallbackSettings));
    application = await electron.launch({ executablePath: require("electron"), args, env: { ...env, KAI_SMOKE_TRAY_MODE: "unavailable" }, timeout: 30000 });
    output = "";
    application.process().stdout?.on("data", chunk => { output = (output + chunk).slice(-10000); });
    application.process().stderr?.on("data", chunk => { output = (output + chunk).slice(-10000); });
    const fallbackPage = await application.firstWindow({ timeout: 30000 });
    fallbackPage.on("pageerror", error => pageErrors.push(error.message));
    await fallbackPage.waitForFunction(() => window.kaiCore && document.getElementById("wallet-address")?.textContent !== "No wallet created", null, { timeout: 15000 });
    const fallbackStatus = await fallbackPage.evaluate(() => window.kaiCore.call("status"));
    assert.equal(fallbackStatus.desktop?.trayAvailable, false);
    assert.equal((await windowState(application)).lifecycle.trayMode, "unavailable");
    assert.deepEqual(await application.evaluate(() => global.__smokeExternalCalls), []);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(await exitThrough(application, "window-close"), { code: 0, signal: null }, "closing without a tray should exit successfully");
    const fallbackQuit = JSON.parse(fs.readFileSync(lifecycleFile, "utf8"));
    assert.equal(fallbackQuit.coreStops, 1); assert.equal(fallbackQuit.coreStopped, true);
    assert.equal(fallbackQuit.paymentDisposals, 1); assert.equal(fallbackQuit.paymentsDisposed, true); assert.equal(fallbackQuit.quit, true);
    await assert.rejects(fetch(fallbackQuit.gatewayOrigin + "/", { signal: AbortSignal.timeout(3000) }), "gateway must stop after close without a tray");
    assert.equal(fs.readFileSync(path.join(dataDir, "wallet", "wallet.json"), "utf8"), walletBefore, "existing wallet was modified");
    assert.equal(fs.readFileSync(path.join(dataDir, "models", "preserved-model-canary.gguf"), "utf8"), "SYNTHETIC-NOT-A-REAL-MODEL");
    assert.equal(fs.readFileSync(path.join(dataDir, "companion-hub.json"), "utf8"), '{"synthetic":"preserved-workflows-and-brain"}');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")).fixture, "preserve-me");
    assert.ok(fs.existsSync(path.join(status.profile.backup, "manifest.json")), "configuration backup was not created");
    console.log(`PASS: real Core desktop starts on a synthetic existing profile; all nine sections, original wallet balances/history/pagination, native canceled transfer with no submission, backup clearing, exact KAI/drop display and unavailable/identity clearing, marketplace presentation, separate credits/purchase flow, local chat/cancellation, explicit network recovery/cancellation/delivery acknowledgements and provider/network fixtures work; legacy styling and compact layouts checked; close-to-tray preserves the gateway/provider fixture, tray and second-instance reopen, repeated Quit awaits teardown, and unavailable-tray close exits; ${trayMode} Tray (OS icon visibility not asserted); wallet and feature data preserved; ${process.env.KAI_SMOKE_SYNTHETIC_LOCK === "1" ? "synthetic fixture lock (native locking not exercised); " : ""}no renderer errors or external fetches. Screenshot: ${screenshot}`);
  } catch (error) {
    if (output) console.error(output);
    throw error;
  } finally {
    await application?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
