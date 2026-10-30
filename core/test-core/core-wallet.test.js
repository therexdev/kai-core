"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { EventEmitter } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const { Signer } = require("koilib");
const { createCoreWallet } = require("../../electron/core-wallet");
const { ChainService } = require("../lib/koinos/chain");
const { MAINNET_CHAIN } = require("../lib/koin-network/payment-network");
const address = Signer.fromSeed("core wallet synthetic test account").getAddress();
const recipient = Signer.fromSeed("core wallet synthetic test recipient").getAddress();
const testChain = "Ei" + "A".repeat(44) + "==";
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-core-wallet-")));
  let mode = "local-first", currentAddress = address, unlocked = true, approval = 0, spendBusy = false, closing = false;
  const calls = [], window = new EventEmitter(); window.webContents = new EventEmitter();
  Object.assign(window, { visible: true, minimized: false, destroyed: false, isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; }, isMinimized() { return this.minimized; } });
  const wallet = {
    get address() { return currentAddress; }, status: () => ({ address: currentAddress, unlocked }),
    signerFor(password) { calls.push(["signer", password]); if (password !== "synthetic password") throw Error("That password does not match this wallet"); return { getAddress: () => currentAddress }; },
    revealWif(password) { calls.push(["reveal", password]); if (password !== "synthetic password") throw Error("Incorrect password"); return { address: currentAddress, wif: "synthetic backup only" }; },
  };
  const dependencies = {
    chainFactory(settings) {
      return {
        provider: () => ({ getChainId: async () => { calls.push(["chain"]); return options.chainId || MAINNET_CHAIN; } }),
        balances: async value => { calls.push(["balances", value, settings.get("network"), settings.get("customRpc.mainnet")]); return options.balanceRead ? options.balanceRead() : { koin: "123456789123456789", vhp: "100000001", mana: "250000000" }; },
        transfer: async (signer, request) => { request.assertContext(); calls.push(["transfer", signer.getAddress(), { ...request, assertContext: undefined }]); if (options.transfer) return options.transfer(request); return { txId: "0x1220" + "a".repeat(64), confirmed: false, blockNumber: null, note: "Transaction submitted; confirmation timed out. Check the explorer." }; },
      };
    },
    historyFactory: ({ chain: _chain, wallet: observedWallet }) => ({ read: async value => { calls.push(["history", value]); return options.historyRead ? options.historyRead() : { address: observedWallet.address, network: "mainnet", rows: [], available: true }; } }),
    clock: () => 1234567890000,
  };
  if (options.realChain) delete dependencies.chainFactory;
  const service = createCoreWallet({ dataDir, core: { account: { wallet }, gateway: { network: { status: () => ({ privacyMode: mode }) } } },
    electron: { dialog: { showMessageBox: async (_window, value) => { calls.push(["review", value]); return options.review ? options.review() : { response: approval }; } }, clipboard: { writeText: value => calls.push(["copy", value]) }, shell: { openExternal: async value => calls.push(["explorer", value]) } },
    getWindow: () => window, isClosing: () => closing,
    withSpend: async run => { if (spendBusy) throw Error("Payment review already open"); spendBusy = true; try { return await run(); } finally { spendBusy = false; } },
  }, dependencies);
  t.after(async () => { await service.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { service, dataDir, calls, wallet, window, setMode(value) { mode = value; service.privacyChanged(value); }, setAddress(value) { currentAddress = value; }, setUnlocked(value) { unlocked = value; }, approve(value = 1) { approval = value; }, setClosing(value) { closing = value; },
    writeSettings(value) { fs.mkdirSync(path.join(dataDir, "koinos-node"), { recursive: true }); fs.writeFileSync(path.join(dataDir, "koinos-node/settings.json"), typeof value === "string" ? value : JSON.stringify(value)); },
    send(value = {}) { return service.call("wallet.send", { to: recipient, amount: "1.00000001", token: "koin", password: "synthetic password", expectedAddress: address, expectedNetwork: "mainnet", ...value }); },
  };
}

function pendingJournal(f, { owner = address, chainId = MAINNET_CHAIN, state = "signed" } = {}) {
  const directory = path.join(f.dataDir, "koin-prepaid-usd-v1/journals"); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "wallet-nonces.sqlite"), db = new DatabaseSync(file);
  db.exec("CREATE TABLE identity(id INTEGER PRIMARY KEY, data TEXT); CREATE TABLE reservations(owner TEXT, state TEXT)");
  db.prepare("INSERT INTO identity VALUES(1,?)").run(JSON.stringify({ chainId }));
  db.prepare("INSERT INTO reservations VALUES(?,?)").run(owner, state); db.close(); return file;
}

test("wallet balance/history use the saved address and exact token units without constructing node files", async t => {
  const f = fixture(t); f.setUnlocked(false);
  const summary = await f.service.call("wallet.summary");
  assert.deepEqual(summary, { address, network: "mainnet", tokenSymbol: "KOIN", koin: "1234567891.23456789", vhp: "1.00000001", mana: "2.5", observedAt: 1234567890000 });
  assert.equal((await f.service.call("wallet.history", { cursor: "page" })).address, address);
  assert.deepEqual(fs.readdirSync(f.dataDir), []);
  assert.ok(!f.calls.some(([name]) => ["signer", "reveal", "review", "transfer"].includes(name)));
});

test("wallet reads reuse current network/RPC settings and never repair damaged data", async t => {
  const f = fixture(t); f.writeSettings({ network: "mainnet", customRpc: { mainnet: "https://saved-rpc.example" }, node: { dataDir: "untouched" } });
  const file = path.join(f.dataDir, "koinos-node/settings.json"), before = fs.readFileSync(file);
  await f.service.call("wallet.summary"); assert.equal(f.calls.find(([name]) => name === "balances")[3], "https://saved-rpc.example");
  assert.deepEqual(fs.readFileSync(file), before);
  f.writeSettings("{broken"); fs.writeFileSync(file + ".last-good", before);
  await assert.rejects(f.service.call("wallet.summary"), /unreadable/); assert.equal(fs.readFileSync(file, "utf8"), "{broken");
  fs.unlinkSync(file); await assert.rejects(f.service.call("wallet.summary"), /missing/); assert.equal(fs.existsSync(file), false);
});

test("unknown network and invalid RPC settings fail closed without changing configuration", async t => {
  const f = fixture(t);
  for (const saved of [{ network: "unknown" }, { network: "mainnet", customRpc: { mainnet: "file:///private" } }, { customRpc: { mainnet: "https://username:password@example.test" } }, { customRpc: [] }]) {
    f.writeSettings(saved); await assert.rejects(f.service.call("wallet.summary"), /settings|network/);
  }
  assert.equal(f.calls.length, 0);
});

test("network privacy prevents all chain reads and transfers while local copy and password backup still work", async t => {
  const f = fixture(t); f.setMode("local-only");
  for (const method of ["wallet.summary", "wallet.history"]) await assert.rejects(f.service.call(method), /Local-Only/);
  await assert.rejects(f.send(), /Local-Only/);
  assert.deepEqual(await f.service.call("wallet.copyAddress", { expectedAddress: address }), { copied: true, address });
  assert.deepEqual(await f.service.call("wallet.reveal", { password: "synthetic password", expectedAddress: address }), { wif: "synthetic backup only" });
  assert.deepEqual(f.calls.map(([name]) => name), ["copy", "reveal"]);
});

test("failed or noncanonical balances never become a made-up zero", async t => {
  let balances = { koin: "bad", vhp: "0", mana: "0" };
  const f = fixture(t, { balanceRead: () => balances });
  await assert.rejects(f.service.call("wallet.summary"), /could not be verified/);
  balances = { koin: "1", vhp: "-1", mana: "18446744073709551616" };
  const result = await f.service.call("wallet.summary"); assert.equal(result.koin, "0.00000001"); assert.equal(result.vhp, null); assert.equal(result.mana, null);
});

test("late balances/history are rejected after identity, network, privacy or shutdown changes", async t => {
  for (const change of [f => f.setAddress(recipient), f => f.writeSettings({ network: "harbinger" }), f => { f.setMode("local-only"); f.setMode("local-first"); }, f => f.setClosing(true)]) {
    const read = deferred(), f = fixture(t, { balanceRead: () => read.promise });
    const task = f.service.call("wallet.summary"); change(f); read.resolve({ koin: "1" });
    await assert.rejects(task, /changed|closing/);
  }
  const read = deferred(), f = fixture(t, { historyRead: () => read.promise });
  const task = f.service.call("wallet.history"); f.setAddress(recipient); read.resolve({ address });
  await assert.rejects(task, /changed/);
});

test("send cancellation proves no password, signs nothing and retains exact native review details", async t => {
  const f = fixture(t); assert.deepEqual(await f.send(), { state: "cancelled" });
  const review = f.calls.find(([name]) => name === "review")[1];
  assert.equal(review.message, "Send 1.00000001 KOIN?"); assert.ok(review.detail.includes(address) && review.detail.includes(recipient));
  assert.equal(review.defaultId, 0); assert.equal(review.cancelId, 0);
  assert.ok(!f.calls.some(([name]) => ["signer", "transfer"].includes(name)));
});

test("approved transfer requires password on this call and returns unconfirmed submission honestly", async t => {
  const f = fixture(t); f.approve();
  await assert.rejects(f.send({ password: "wrong" }), /password/);
  assert.equal(f.calls.filter(([name]) => name === "transfer").length, 0);
  const result = await f.send(); assert.equal(result.state, "submitted"); assert.equal(result.confirmed, false); assert.match(result.note, /submitted/);
  const sent = f.calls.find(([name]) => name === "transfer"); assert.equal(sent[2].amountSat, "100000001"); assert.equal(sent[2].token, "koin"); assert.equal(sent[2].to, recipient);
});

test("mismatched wallet/network/chain and out-of-range amounts never reach native approval", async t => {
  const f = fixture(t);
  for (const value of [{ expectedAddress: recipient }, { expectedNetwork: "harbinger" }, { amount: "1e3" }, { amount: "0" }, { amount: "184467440737.09551616" }, { token: "other" }, { to: "invalid" }, { arbitrary: true }]) await assert.rejects(f.send(value));
  assert.ok(!f.calls.some(([name]) => name === "review"));
  const other = fixture(t, { chainId: testChain }); await assert.rejects(other.send(), /selected network/); assert.ok(!other.calls.some(([name]) => name === "review"));
});

test("fresh providers cannot switch RPC chain identity after native approval", async t => {
  let reads = 0, transferred = false;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(JSON.parse(options.body).method, "chain.get_chain_id");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { chain_id: ++reads === 1 ? MAINNET_CHAIN : Buffer.alloc(34, 1).toString("base64url") } }), { status: 200 });
  });
  t.mock.method(ChainService.prototype, "transfer", async function (_signer, request) {
    request.assertContext(); await this.provider().getChainId(); transferred = true;
  });
  const f = fixture(t, { realChain: true }); f.approve();
  await assert.rejects(f.send(), /selected network|RPC chain/);
  assert.equal(reads, 2); assert.equal(transferred, false);
});

test("pending credit journals are read-only and block native sends before or during approval", async t => {
  const f = fixture(t), file = pendingJournal(f), bytes = fs.readFileSync(file);
  await assert.rejects(f.send(), /unresolved/); assert.ok(!f.calls.some(([name]) => name === "review")); assert.deepEqual(fs.readFileSync(file), bytes);
  const review = deferred(), g = fixture(t, { review: () => review.promise });
  const task = g.send(); await tick(); pendingJournal(g); review.resolve({ response: 1 });
  await assert.rejects(task, /unresolved/); assert.ok(!g.calls.some(([name]) => name === "signer"));
});

test("serialized payment gate rejects a second send and stays held until transfer settles", async t => {
  const transfer = deferred(), f = fixture(t, { transfer: () => transfer.promise }); f.approve();
  const task = f.send(); await tick();
  await assert.rejects(f.send(), /Payment review/); assert.equal(f.calls.filter(([name]) => name === "transfer").length, 1);
  transfer.resolve({ txId: "synthetic", confirmed: false }); await task;
  f.approve(0); assert.deepEqual(await f.send(), { state: "cancelled" });
});

test("hiding, minimizing, navigation, wallet lock or privacy changes during review stop signing", async t => {
  for (const change of [f => { f.window.visible = false; f.window.emit("hide"); }, f => { f.window.minimized = true; f.window.emit("minimize"); }, f => f.window.webContents.emit("did-start-navigation", {}, "elsewhere", false, true), f => f.window.webContents.emit("render-process-gone"), f => f.setUnlocked(false), f => f.setMode("local-only")]) {
    const review = deferred(), f = fixture(t, { review: () => review.promise });
    const task = f.send(); await tick(); change(f); review.resolve({ response: 1 }); await assert.rejects(task);
    assert.ok(!f.calls.some(([name]) => name === "signer")); assert.equal(f.window.listenerCount("hide"), 0);
  }
});

test("view lifecycle guard also runs immediately before the chain signs", async t => {
  let f;
  f = fixture(t, { transfer: async request => { f.window.emit("hide"); request.assertContext(); throw Error("unreachable"); } }); f.approve();
  await assert.rejects(f.send(), /review stopped/);
});

test("shutdown releases an unanswered native review; late approval cannot sign", async t => {
  const review = deferred(), f = fixture(t, { review: () => review.promise });
  const task = f.send(); await tick();
  const rejected = assert.rejects(task, /closing/);
  await f.service.dispose(); await rejected;
  assert.equal(f.window.listenerCount("hide"), 0);
  review.resolve({ response: 1 }); await tick();
  assert.ok(!f.calls.some(([name]) => ["signer", "transfer"].includes(name)));
});

test("copy/backups/explorer reject identity changes and explorer URLs are derived locally", async t => {
  const f = fixture(t);
  await assert.rejects(f.service.call("wallet.copyAddress", { expectedAddress: recipient }), /changed/);
  await assert.rejects(f.service.call("wallet.reveal", { expectedAddress: recipient, password: "synthetic password" }), /changed/);
  await assert.rejects(f.service.call("wallet.reveal", { expectedAddress: address, password: "wrong" }), /password/);
  await assert.rejects(f.service.call("wallet.openExplorer", { expectedAddress: address, expectedNetwork: "mainnet", txId: "https://other.test" }), /Invalid/);
  await f.service.call("wallet.openExplorer", { expectedAddress: address, expectedNetwork: "mainnet" });
  assert.equal(f.calls.find(([name]) => name === "explorer")[1], `https://koinosblocks.com/address/${address}`);
  await assert.rejects(f.service.call("wallet.remove"), /Unknown/);
});
