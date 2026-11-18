"use strict";
// Temporary, read-only legacy campaign. Remove this module, its allocation
// manifest and the Earn legacy panel together after the drop is retired.
const manifest = require("./legacy-kai-drop.json");
const { tokenEvent } = require("./koinos/wallet-history");
const { createProvider, MAINNET_RPC_URLS } = require("./koinos-rpc");
const PAGE = 50, MAX_UINT = (1n << 64n) - 1n;
const txId = value => typeof value === "string" && /^0x1220[a-f0-9]{64}$/.test(value);
const uint = value => typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= MAX_UINT;
function matchingReceipt(tx, receipt, address, allocation) {
  if (!txId(tx?.id) || tx.header?.chain_id !== manifest.chainId || receipt?.id !== tx.id ||
      ![undefined, false].includes(receipt.reverted) || receipt.rpc_error || !Array.isArray(receipt.events) || receipt.events.length > 1024) return false;
  let count = 0;
  for (const event of receipt.events) {
    if (event.source !== manifest.token || !["token.transfer_event", "koinos.standards.kcs4.transfer_event"].includes(event.name)) continue;
    const transfer = tokenEvent(event.data, true);
    if (transfer.from === manifest.sender && transfer.to === address && transfer.amount === allocation.koinAtoms) count++;
  }
  return count === 1;
}
async function verifyPayment(provider, id, address, allocation, now, signal) {
  const active = () => signal?.throwIfAborted();
  const lookup = await provider.getTransactionsById([id]); active();
  const matches = lookup?.transactions?.filter(row => row.transaction?.id === id);
  if (matches?.length !== 1) throw Error("Drop transaction is not indexed yet.");
  const blocks = matches[0].containing_blocks;
  if (!Array.isArray(blocks) || blocks.length > 20 || blocks.some(b => !txId(b))) throw Error("Invalid drop block lookup.");
  if (!blocks.length) return null;
  const [head, found] = await Promise.all([provider.getHeadInfo(), provider.getBlocksById(blocks, { returnBlock: false, returnReceipt: false })]); active();
  const lib = Number(head.last_irreversible_block), height = Number(head.head_topology?.height), headTime = Number(head.head_block_time);
  if (!Number.isSafeInteger(lib) || lib <= 0 || !Number.isSafeInteger(height) || lib > height || !txId(head.head_topology?.id) ||
      !Number.isSafeInteger(headTime) || headTime > now() + 60000 || headTime < now() - 120000) throw Error("Drop verification needs a current mainnet head.");
  if (!Array.isArray(found?.block_items) || found.block_items.length > 20) throw Error("Invalid drop block response.");
  for (const item of found.block_items) {
    active(); const h = Number(item.block_height);
    if (!blocks.includes(item.block_id) || !Number.isSafeInteger(h) || h <= 0 || h > lib) continue;
    const [canonical] = await provider.getBlocks(h, 1, head.head_topology.id, { returnBlock: true, returnReceipt: true }); active();
    if (canonical?.block_id !== item.block_id) continue;
    const block = canonical.block, receipt = canonical.receipt;
    if (block?.id !== item.block_id || receipt?.id !== item.block_id || Number(block.header?.height) !== h ||
        Number(receipt.height) !== h || Number(canonical.block_height) !== h) throw Error("Drop block identity mismatch.");
    const time = Number(block.header.timestamp);
    if (!Number.isSafeInteger(time) || time > headTime || time < Date.parse(manifest.snapshotAt)) continue;
    const txs = block.transactions?.filter(tx => tx.id === id), receipts = receipt.transaction_receipts?.filter(tx => tx.id === id);
    if (txs?.length !== 1 || receipts?.length !== 1) throw Error("Drop payment receipt is unavailable.");
    // Verify the canonical receipt itself, not just the account-history hint.
    if (!matchingReceipt(txs[0], receipts[0], address, allocation)) continue;
    if (await provider.getChainId() !== manifest.chainId) throw Error("Drop verification chain changed."); active();
    return { txId: id, blockId: item.block_id, blockHeight: String(h), timestamp: time, verifiedAt: now() };
  }
  return null;
}
function createLegacyKaiDrop({ getAddress, now = Date.now, providerFactory, timeoutMs = 30000 } = {}) {
  const states = new Map(), lifetime = new AbortController();
  const providerFor = providerFactory || (signal => createProvider(MAINNET_RPC_URLS, { timeoutMs: 5000,
    fetchImpl: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([signal, options.signal]) }) }));
  function allocationFor(address) { return Object.hasOwn(manifest.allocations, address || "") ? manifest.allocations[address] : null; }
  function snapshot(address, record) {
    const allocation = allocationFor(address);
    return { campaign: manifest.id, address, sender: manifest.sender, network: "mainnet", token: "KOIN", snapshotAt: manifest.snapshotAt,
      kaiAtoms: allocation?.kaiAtoms ?? "0", koinAtoms: allocation?.koinAtoms ?? "0", eligible: !!allocation,
      state: !address ? "wallet-required" : !allocation ? "not-eligible" : record?.payment ? "paid" : record?.error ? "unavailable" : record?.pending ? "checking" : "awaiting",
      payment: record?.payment ?? null, error: record?.error ?? null, observedAt: now() };
  }
  async function scan(address, allocation, record, signal) {
    const provider = providerFor(signal), active = () => { signal.throwIfAborted(); if (getAddress() !== address) throw Error("Wallet changed."); };
    const [chainId, contract] = await Promise.all([provider.getChainId(), provider.invokeGetContractAddress("koin")]); active();
    if (chainId !== manifest.chainId) throw Error("Mainnet is required for drop verification.");
    if (contract?.value?.address !== manifest.token) throw Error("KOIN contract could not be verified.");
    const readPage = async cursor => {
      active();
      const result = await provider.call("account_history.get_account_history", { address, limit: PAGE, ascending: false, irreversible: true, ...(cursor != null ? { seq_num: cursor } : {}) }); active();
      if (!result || result.error || result.rpc_error || result.values !== undefined && !Array.isArray(result.values) || (result.values || []).length > PAGE || JSON.stringify(result).length > 4 * 1024 * 1024) throw Error("Drop history is unavailable.");
      const values = result.values || [];
      let previous = null;
      for (const row of values) {
        if (!uint(row.seq_num) || cursor != null && BigInt(row.seq_num) > BigInt(cursor) || previous !== null && BigInt(row.seq_num) >= previous) throw Error("Invalid drop history order.");
        previous = BigInt(row.seq_num);
        if (!matchingReceipt(row.trx?.transaction, row.trx?.receipt, address, allocation)) continue;
        const proof = await verifyPayment(provider, row.trx.transaction.id, address, allocation, now, signal); active();
        if (proof) { record.payment = proof; return null; }
      }
      if (await provider.getChainId() !== manifest.chainId) throw Error("Drop history chain changed."); active();
      return values.length === PAGE && previous > 0n ? String(previous - 1n) : null;
    };
    // Always inspect the newest page, even while catching up on old history.
    // A wallet that was closed during the drop still discovers its payment.
    const newestNext = await readPage(null);
    if (record.payment) return;
    const cursor = record.cursor ?? newestNext;
    if (cursor != null) record.cursor = await readPage(cursor);
    else record.cursor = null;
  }
  async function read() {
    const address = getAddress(), allocation = allocationFor(address);
    if (!allocation || lifetime.signal.aborted) return snapshot(address);
    let record = states.get(address);
    if (!record) { record = { at: -Infinity, cursor: null, payment: null, error: null, pending: null }; states.set(address, record); }
    if (record.payment || now() - record.at < 15000 && !record.pending) return snapshot(address, record);
    if (!record.pending) {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)]);
      record.pending = scan(address, allocation, record, signal).then(() => { record.error = null; }, () => { record.error = "Payment check unavailable. Retrying automatically."; })
        .finally(() => { record.at = now(); record.pending = null; });
    }
    await record.pending;
    if (getAddress() !== address || lifetime.signal.aborted) return null;
    return snapshot(address, record);
  }
  return { read, clear() { states.clear(); }, close() { lifetime.abort(); states.clear(); } };
}
module.exports = { createLegacyKaiDrop, verifyPayment, matchingReceipt, manifest };
