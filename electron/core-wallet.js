"use strict";

// The Core wallet is independent of the optional node plugin. Reading this
// service never constructs Docker, reward workers, bridge jobs or journals.
const fs = require("node:fs"), path = require("node:path");
const { utils } = require("koilib");
const { ChainService } = require("../core/lib/koinos/chain");
const { WalletHistory } = require("../core/lib/koinos/wallet-history");
const { NETWORKS } = require("../core/lib/koinos/constants");
const { createProvider, rpcUrlsForNetwork } = require("../core/lib/koinos-rpc");
const { parseAmount, formatAmount } = require("../core/lib/koinos/format");
const { MAINNET_CHAIN } = require("../core/lib/koin-network/payment-network");
const { guardOtherJournals } = require("./credit-purchase-journals");
const MAX_UINT = (1n << 64n) - 1n;
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const validAddress = value => typeof value === "string" && value.length <= 40 && utils.isChecksumAddress(value);
const integer = value => typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= MAX_UINT;

function input(value, fields) {
  if (!plain(value) || Object.keys(value).some(key => !fields.includes(key))) throw Error("Invalid wallet request");
  return { ...value };
}

async function waitForReview(promise, signal) {
  signal.throwIfAborted();
  let abort;
  const cancelled = new Promise((_resolve, reject) => { abort = () => reject(signal.reason || Error("Wallet review stopped")); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

// JsonStore can repair its primary on construction. Wallet reads deliberately
// use a read-only view: damaged/missing primaries require deliberate recovery.
function readSettings(dataDir) {
  const directory = path.join(dataDir, "koinos-node"), file = path.join(directory, "settings.json");
  function read(target) {
    let st;
    try { st = fs.lstatSync(target); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1 || st.size > 2 * 1024 * 1024) throw Error("Saved wallet network settings need recovery; original data was preserved");
    return fs.readFileSync(target, "utf8");
  }
  try {
    const st = fs.lstatSync(directory);
    if (st.isSymbolicLink() || !st.isDirectory()) throw Error("Saved wallet network settings need recovery; original data was preserved");
  } catch (error) { if (error.code === "ENOENT") return { network: "mainnet", customRpc: {} }; throw error; }
  const bytes = read(file);
  if (bytes === null && read(file + ".last-good") !== null) throw Error("Saved wallet network settings are missing. Restore the saved configuration before viewing balances");
  let saved = {};
  if (bytes !== null) {
    try { saved = JSON.parse(bytes); } catch { throw Error("Saved wallet network settings are unreadable; original data was preserved"); }
    if (!plain(saved)) throw Error("Saved wallet network settings need recovery; original data was preserved");
  }
  const network = saved.network === undefined ? "mainnet" : saved.network;
  if (typeof network !== "string" || !Object.hasOwn(NETWORKS, network)) throw Error("Saved wallet network is unrecognized; original settings were preserved");
  if (saved.customRpc !== undefined && !plain(saved.customRpc)) throw Error("Saved wallet RPC settings need recovery; original settings were preserved");
  const custom = saved.customRpc?.[network] ?? "";
  if (typeof custom !== "string" || custom.length > 4096) throw Error("Saved wallet RPC settings need recovery; original settings were preserved");
  if (custom) {
    let url;
    try { url = new URL(custom); } catch { throw Error("Saved wallet RPC URL is invalid; original settings were preserved"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || /[\r\n\0]/.test(custom)) throw Error("Saved wallet RPC URL is invalid; original settings were preserved");
  }
  return { network, customRpc: { [network]: custom } };
}

function createCoreWallet({ dataDir, core, electron, getWindow, withSpend, isClosing = () => false }, dependencies = {}) {
  const wallet = core.account.wallet, root = fs.realpathSync(dataDir);
  const clock = dependencies.clock || Date.now, read = dependencies.readSettings || (() => readSettings(root));
  let closed = false, epoch = 0, sending = false, activeReads = 0;
  const controllers = new Set(), transfers = new Set();
  const active = () => { if (closed || isClosing()) throw Error("The wallet is closing"); };
  // AI privacy never gates explicit blockchain wallet access in the original app.
  // Wallet identity, selected chain, native review and lifetime remain independent.
  function configuration() {
    const value = read(), net = NETWORKS[value.network];
    const custom = value.customRpc?.[value.network] || "";
    return { value, net, rpc: rpcUrlsForNetwork(net, custom) };
  }
  function identity(expected, requireUnlocked = false) {
    active();
    const address = wallet.address;
    if (!address || !validAddress(address)) throw Error("Set up or restore your wallet first");
    if (expected !== undefined && expected !== address) throw Error("The wallet changed. Review this action again");
    if (requireUnlocked && wallet.status().unlocked !== true) throw Error("Unlock your wallet before sending");
    return address;
  }
  function context(expectedAddress, expectedNetwork, requireUnlocked = false) {
    active();
    const address = identity(expectedAddress, requireUnlocked), config = configuration(), version = epoch;
    if (expectedNetwork !== undefined && expectedNetwork !== config.net.id) throw Error("The wallet network changed. Review this action again");
    const assert = () => {
      active(); identity(address, requireUnlocked);
      const next = configuration();
      if (version !== epoch || next.net.id !== config.net.id || JSON.stringify(next.rpc) !== JSON.stringify(config.rpc)) throw Error("The wallet or network changed. Review this action again");
    };
    return { address, ...config, assert };
  }
  function chainFor(ctx, controller) {
    const settings = { get: (key, fallback) => key === "network" ? ctx.net.id : key === `customRpc.${ctx.net.id}` ? ctx.value.customRpc?.[ctx.net.id] || "" : fallback };
    const chain = dependencies.chainFactory ? dependencies.chainFactory(settings) : new ChainService(settings);
    if (!dependencies.chainFactory) chain.provider = urls => {
      const provider = createProvider(urls || chain.rpcUrls(), {
        fetchImpl: (url, options) => {
          ctx.assert(); controller.signal.throwIfAborted();
          return fetch(url, { ...options, signal: AbortSignal.any([controller.signal, options.signal].filter(Boolean)) });
        },
      });
      const getChainId = provider.getChainId.bind(provider);
      provider.getChainId = async () => {
        const id = await getChainId(); ctx.assert();
        verifyChain(id, ctx.net.id);
        if (ctx.chainId && ctx.chainId !== id) throw Error("The wallet RPC chain changed. Review this action again");
        return id;
      };
      return provider;
    };
    return chain;
  }
  function verifyChain(id, network) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_=-]{44,48}$/.test(id) || Buffer.from(id, "base64url").length !== 34 || (network === "mainnet") !== (id === MAINNET_CHAIN)) throw Error("The wallet RPC does not match the selected network");
  }
  async function networkRead(method, value) {
    const request = input(value, method === "wallet.history" ? ["cursor"] : []);
    active();
    if (activeReads >= 2) throw Error("Wallet information is already loading");
    const config = configuration(), address = wallet.address || null;
    if (!address) return method === "wallet.history"
      ? { address: null, network: config.net.id, tokenSymbol: config.net.tokenSymbol, observedAt: clock(), rows: [], nextCursor: null, available: true }
      : { address: null, network: config.net.id, tokenSymbol: config.net.tokenSymbol, koin: null, vhp: null, mana: null, observedAt: null };
    const ctx = context(address, config.net.id), controller = new AbortController(); controllers.add(controller); activeReads++;
    try {
      const chain = chainFor(ctx, controller);
      if (method === "wallet.history") {
        const history = dependencies.historyFactory ? dependencies.historyFactory({ chain, wallet, clock }) : new WalletHistory({ chain, wallet, clock });
        const result = await history.read(request); ctx.assert(); return result;
      }
      const balances = await chain.balances(address); ctx.assert();
      if (balances?.error || !integer(balances?.koin)) throw Error("Wallet balance could not be verified. Refresh to try again");
      return { address, network: ctx.net.id, tokenSymbol: ctx.net.tokenSymbol,
        koin: formatAmount(balances.koin, { grouping: false }),
        vhp: integer(balances.vhp) ? formatAmount(balances.vhp, { grouping: false }) : null,
        mana: integer(balances.mana) ? formatAmount(balances.mana, { grouping: false }) : null,
        observedAt: clock() };
    } finally { controllers.delete(controller); activeReads--; }
  }
  async function send(value) {
    const request = input(value, ["to", "amount", "token", "password", "expectedAddress", "expectedNetwork"]);
    active();
    if (sending) throw Error("A wallet transfer is already being reviewed or sent");
    if (!validAddress(request.to) || !validAddress(request.expectedAddress) || !Object.hasOwn(NETWORKS, request.expectedNetwork || "") || !["koin", "vhp"].includes(request.token)) throw Error("Check the recipient, token and wallet network before sending");
    if (typeof request.amount !== "string" || !/^(0|[1-9]\d{0,11})(\.\d{1,8})?$/.test(request.amount)) throw Error("Enter a positive token amount with up to eight decimal places");
    const amountSat = parseAmount(request.amount);
    if (BigInt(amountSat) <= 0n || BigInt(amountSat) > MAX_UINT) throw Error("The transfer amount is out of range");
    if (typeof request.password !== "string" || !request.password || request.password.length > 4096) throw Error("Enter your wallet password to confirm this transfer");
    const ctx = context(request.expectedAddress, request.expectedNetwork, true), controller = new AbortController();
    const window = getWindow();
    const visible = () => window && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
    if (!visible()) throw Error("Return to the visible Core window to review this transfer");
    const abort = () => controller.abort(Error("Wallet review stopped. Check transaction history before trying again"));
    const navigation = (_event, _url, _inPlace, mainFrame) => { if (mainFrame) abort(); };
    const checkContext = ctx.assert;
    ctx.assert = () => { checkContext(); controller.signal.throwIfAborted(); if (!visible()) throw Error("Return to the visible Core window to review this transfer"); };
    for (const event of ["hide", "minimize", "closed"]) window.on(event, abort);
    window.webContents.on("did-start-navigation", navigation); window.webContents.on("render-process-gone", abort);
    const token = request.token === "koin" ? ctx.net.tokenSymbol : "VHP", amount = formatAmount(amountSat, { grouping: false });
    sending = true; controllers.add(controller);
    try {
      const chain = chainFor(ctx, controller);
      ctx.chainId = await chain.provider().getChainId(); ctx.assert(); verifyChain(ctx.chainId, ctx.net.id);
      const pendingGuard = () => guardOtherJournals(root, path.join(root, "core-wallet-no-journals"), { owner: ctx.address, deployment: { chainId: ctx.chainId } });
      pendingGuard();
      const review = await waitForReview(electron.dialog.showMessageBox(window, { type: "question", title: `Send ${token}`, message: `Send ${amount} ${token}?`,
        detail: `From: ${ctx.address}\nTo: ${request.to}\nNetwork: ${ctx.net.label}\n\nThis transfers tokens from your wallet. Confirm only if the recipient and exact amount are correct.`,
        buttons: ["Cancel", "Send"], defaultId: 0, cancelId: 0, noLink: true, signal: controller.signal }), controller.signal);
      ctx.assert(); controller.signal.throwIfAborted();
      if (review.response !== 1) return { state: "cancelled" };
      pendingGuard();
      const signer = wallet.signerFor(request.password); request.password = "";
      if (signer.getAddress() !== ctx.address) throw Error("The wallet changed. Review this transfer again");
      ctx.assert();
      const task = chain.transfer(signer, { to: request.to, amountSat, token: request.token, assertContext: ctx.assert });
      transfers.add(task);
      let result;
      try { result = await task; } finally { transfers.delete(task); }
      // A submission may already have reached the chain. Never retry or report
      // cancellation merely because the view changed while confirming.
      return { state: "submitted", ...result };
    } finally {
      request.password = ""; controllers.delete(controller); sending = false;
      for (const event of ["hide", "minimize", "closed"]) window.removeListener(event, abort);
      window.webContents.removeListener("did-start-navigation", navigation); window.webContents.removeListener("render-process-gone", abort);
    }
  }
  return {
    async call(method, value = {}) {
      active();
      if (method === "wallet.summary" || method === "wallet.history") return networkRead(method, value);
      if (method === "wallet.send") {
        if (typeof withSpend !== "function") throw Error("Wallet spending is unavailable until payment coordination is ready");
        return withSpend(() => send(value));
      }
      if (method === "wallet.copyAddress") {
        const request = input(value, ["expectedAddress"]), address = identity(request.expectedAddress);
        electron.clipboard.writeText(address); return { copied: true, address };
      }
      if (method === "wallet.reveal") {
        const request = input(value, ["password", "expectedAddress"]);
        const address = identity(request.expectedAddress);
        if (!validAddress(request.expectedAddress) || typeof request.password !== "string" || !request.password || request.password.length > 4096) throw Error("Enter your wallet password to display its backup code");
        const result = wallet.revealWif(request.password);
        if (result.address !== address || wallet.address !== address) throw Error("The wallet changed. Request its backup again");
        return { wif: result.wif };
      }
      if (method === "wallet.openExplorer") {
        const request = input(value, ["expectedAddress", "expectedNetwork", "txId"]), ctx = context(request.expectedAddress, request.expectedNetwork);
        if (ctx.net.id !== "mainnet") throw Error("An explorer is not configured for this wallet network");
        if (!validAddress(request.expectedAddress) || request.expectedNetwork !== "mainnet" || request.txId !== undefined && (typeof request.txId !== "string" || !/^0x1220[a-f0-9]{64}$/.test(request.txId))) throw Error("Invalid wallet explorer request");
        await electron.shell.openExternal(request.txId ? `https://koinosblocks.com/tx/${request.txId}` : `https://koinosblocks.com/address/${ctx.address}`);
        return { opened: true };
      }
      throw Error("Unknown Core wallet operation");
    },
    privacyChanged() { /* AI privacy is independent of blockchain wallet access. */ },
    async dispose() { closed = true; epoch++; for (const controller of controllers) controller.abort(Error("Wallet is closing")); await Promise.allSettled([...transfers]); },
  };
}

module.exports = { createCoreWallet };
