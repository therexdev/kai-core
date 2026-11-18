"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { utils, Signer } = require("koilib");
const { createLegacyKaiDrop, matchingReceipt, manifest } = require("../lib/legacy-kai-drop");
const { legacySummary } = require("../../ui-core/earning");
const address = Object.keys(manifest.allocations)[1], allocation = manifest.allocations[address];
const id = "0x1220" + "a".repeat(64), blockId = "0x1220" + "b".repeat(64), headId = "0x1220" + "c".repeat(64);
const other = Signer.fromSeed("synthetic unrelated legacy drop sender").address;
function event({ from = manifest.sender, to = address, amount = allocation.koinAtoms, source = manifest.token } = {}) {
  let n = BigInt(amount), bytes = [];
  do { let b = Number(n & 127n); n >>= 7n; if (n) b |= 128; bytes.push(b); } while (n);
  return { source, name: "token.transfer_event", data: Buffer.from([10,25,...utils.decodeBase58(from),18,25,...utils.decodeBase58(to),24,...bytes]).toString("base64url") };
}
function fixture() {
  let account = address, clock = Date.parse("2026-11-16T12:00:00Z"), chain = manifest.chainId, canonical = true, lib = 80, delay;
  const tx = { id, header: { chain_id: chain } }, receipt = { id, reverted: false, events: [event()] }, calls = [];
  const block = { id: blockId, header: { height: "42", timestamp: String(clock - 60000) }, transactions: [tx] };
  const provider = { getChainId: async () => { if (delay) await delay; return chain; }, invokeGetContractAddress: async () => ({ value: { address: manifest.token } }),
    call: async (method, params) => { calls.push({ method, params }); return { values: [{ seq_num: "5", trx: { transaction: tx, receipt } }] }; },
    getTransactionsById: async () => ({ transactions: [{ transaction: tx, containing_blocks: [blockId] }] }),
    getHeadInfo: async () => ({ head_topology: { id: headId, height: "100" }, last_irreversible_block: String(lib), head_block_time: String(clock) }),
    getBlocksById: async () => ({ block_items: [{ block_id: blockId, block_height: "42" }] }),
    getBlocks: async () => [{ block_id: canonical ? blockId : headId, block_height: "42", block, receipt: { id: blockId, height: "42", transaction_receipts: [receipt] } }] };
  const make = () => createLegacyKaiDrop({ getAddress: () => account, now: () => clock, providerFactory: () => provider });
  const reader = make();
  return { reader, make, provider, tx, receipt, block, calls, setAddress: v => { account = v; }, setChain: v => { chain = v; }, setCanonical: v => { canonical = v; }, setLib: v => { lib = v; }, setDelay: v => { delay = v; }, advance: () => { clock += 15001; } };
}
test("final snapshot reproduces all 32 exact spreadsheet allocations and totals", () => {
  const rows = Object.entries(manifest.allocations); assert.equal(rows.length, 32);
  assert.equal(rows.reduce((n, [, r]) => n + BigInt(r.kaiAtoms), 0n).toString(), manifest.totalKaiAtoms);
  assert.equal(rows.reduce((n, [, r]) => n + BigInt(r.koinAtoms), 0n).toString(), "1984702174310");
  for (const [wallet, row] of rows) { assert.equal(utils.isChecksumAddress(wallet), true); assert.equal((BigInt(row.kaiAtoms) + 2n) / 5n, BigInt(row.koinAtoms)); }
  assert.equal(allocation.koinAtoms, "282012053646"); assert.equal(BigInt(allocation.kaiAtoms) / 5n, 282012053645n, "old floor calculation differed by one atomic unit");
});
test("exact finalized payment becomes PAID, survives a fresh reader and needs no signer", async () => {
  const f = fixture(), paid = await f.reader.read();
  assert.equal(paid.state, "paid"); assert.equal(paid.payment.txId, id); assert.equal(paid.payment.blockId, blockId);
  assert.equal(f.calls[0].params.irreversible, true); assert.equal((await f.make().read()).state, "paid");
  const count = f.calls.length; f.advance(); assert.equal((await f.reader.read()).state, "paid"); assert.equal(f.calls.length, count);
  const view = legacySummary({ wallet: { address }, earnings: { error: "testnet offline" }, drop: paid });
  assert.equal(view.koin, "2,820.12053646"); assert.equal(view.drop.txUrl, "https://koinosblocks.com/tx/" + id);
});
test("wrong sender, recipient, exact amount, token, reverted or duplicate events never mark paid", async () => {
  for (const patch of [{ from: other }, { to: other }, { amount: String(BigInt(allocation.koinAtoms) - 1n) }, { amount: String(BigInt(allocation.koinAtoms) + 1n) }, { source: other }]) {
    const f = fixture(); f.receipt.events = [event(patch)]; assert.equal((await f.reader.read()).state, "awaiting");
  }
  const f = fixture(); f.receipt.reverted = true; assert.equal((await f.reader.read()).state, "awaiting");
  const g = fixture(); g.receipt.events.push(event()); assert.equal((await g.reader.read()).state, "awaiting");
  assert.equal(matchingReceipt({ id, header: { chain_id: "testnet" } }, g.receipt, address, allocation), false);
});
test("testnet, pre-snapshot, reversible, noncanonical and stale proof cannot become paid", async () => {
  const cases = [f => f.setChain("testnet"), f => { f.block.header.timestamp = String(Date.parse(manifest.snapshotAt) - 1); },
    f => f.setLib(41), f => f.setCanonical(false), f => { f.provider.getHeadInfo = async () => ({ head_topology: { id: headId, height: "100" }, last_irreversible_block: "80", head_block_time: "1" }); }];
  for (const alter of cases) { const f = fixture(); alter(f); assert.notEqual((await f.reader.read()).state, "paid"); }
});
test("canonical receipt must match even when account history claims a valid drop", async () => {
  const f = fixture(), get = f.provider.getBlocks;
  f.provider.getBlocks = async () => { const result = await get(); result[0].receipt.transaction_receipts = [{ ...f.receipt, events: [event({ from: other })] }]; return result; };
  assert.notEqual((await f.reader.read()).state, "paid");
});
test("RPC failure keeps exact allocation, retries and coalesces reads", async () => {
  const f = fixture(), original = f.provider.call; f.provider.call = async () => { throw Error("offline"); };
  const failed = await f.reader.read(); assert.equal(failed.state, "unavailable"); assert.equal(failed.koinAtoms, allocation.koinAtoms);
  f.provider.call = original; f.advance(); const [a, b] = await Promise.all([f.reader.read(), f.reader.read()]); assert.equal(a.state, "paid"); assert.deepEqual(a, b); assert.equal(f.calls.length, 1);
});
test("empty history, absent wallet and wallets outside the snapshot never invent a paid result", async () => {
  const f = fixture(); f.provider.call = async () => ({}); assert.equal((await f.reader.read()).state, "awaiting");
  f.setAddress(other); const no = await f.reader.read(); assert.equal(no.state, "not-eligible"); assert.equal(no.koinAtoms, "0");
  f.setAddress(null); assert.equal((await f.reader.read()).state, "wallet-required");
});
test("pagination searches older payments and still checks recent deposits on every poll", async () => {
  const f = fixture();
  f.provider.call = async (method, params) => {
    f.calls.push({ method, params });
    const start = params.seq_num == null ? 200 : Number(params.seq_num);
    return { values: Array.from({ length: 50 }, (_, i) => ({ seq_num: String(start - i), ...(start - i === 85 ? { trx: { transaction: f.tx, receipt: f.receipt } } : {}) })) };
  };
  assert.equal((await f.reader.read()).state, "awaiting"); f.advance(); assert.equal((await f.reader.read()).state, "paid");
  assert.deepEqual(f.calls.map(c => c.params.seq_num ?? "latest"), ["latest", "150", "latest", "100"]);
});
test("wallet changes and shutdown discard late verification", async () => {
  const f = fixture(); let release; f.setDelay(new Promise(resolve => { release = resolve; }));
  const work = f.reader.read(); f.setAddress(other); release(); assert.equal(await work, null);
  assert.equal((await f.reader.read()).state, "not-eligible");
  const g = fixture(); let finish; g.setDelay(new Promise(resolve => { finish = resolve; })); const pending = g.reader.read(); g.reader.close(); finish(); assert.equal(await pending, null);
});
test("renderer refuses mismatched identity, malformed proof and arbitrary transaction links", async () => {
  const f = fixture(), paid = await f.reader.read(), snapshot = { wallet: { address }, drop: paid };
  const valid = legacySummary(snapshot); assert.equal(valid.drop.txUrl, "https://koinosblocks.com/tx/" + id);
  paid.payment.url = "https://evil.example"; assert.equal(legacySummary(snapshot).drop.txUrl, valid.drop.txUrl);
  paid.payment.txId = 'javascript:alert(1)'; assert.equal(legacySummary(snapshot), null);
  paid.payment.txId = id; paid.address = other; assert.equal(legacySummary(snapshot), null);
});
