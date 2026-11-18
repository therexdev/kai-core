"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createProvider } = require("../lib/koinos-rpc");
const { WalletHistory } = require("../lib/koinos/wallet-history");
const { createLegacyKaiDrop, manifest } = require("../lib/legacy-kai-drop");
const { NETWORKS } = require("../lib/koinos/constants");
const urls = ["https://primary.invalid", "https://secondary.invalid", "https://indexed.invalid"];
const address = "1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK";
const id = "0x1220" + "a".repeat(64), blockId = "0x1220" + "b".repeat(64), headId = "0x1220" + "c".repeat(64);
const now = Date.parse("2026-11-06T20:00:00Z");
// Public transfer-event wire data from the reported 3,732.80583588 KOIN
// receipt. All transaction/block IDs and finality below are synthetic.
const event = { sequence: 3, source: manifest.token, name: "token.transfer_event",
  data: "ChkALgXlGiZPXmLVKU2JhRk0zi_7zIxUv-vaEhkAsLh6lvGrVczOkDF124PaT_xXTz96UEtsGKTfhsruCg==" };
const transaction = { id, header: { chain_id: manifest.chainId, payer: manifest.sender } };
const receipt = { id, events: [event] };
const entry = { seq_num: "1278", trx: { transaction, receipt } };
function rpc(handler) {
  const calls = [];
  const provider = createProvider(urls, { fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body); calls.push({ url, ...request });
    return { ok: true, json: async () => handler(url, request) };
  } });
  return { provider, calls };
}
function fixture() {
  const f = rpc(url => ({ result: url === urls[0] ? {} : url === urls[1] ? { values: [] } : { values: [entry] } }));
  Object.assign(f.provider, {
    getChainId: async () => manifest.chainId,
    invokeGetContractAddress: async name => ({ value: { address: name === "koin" ? manifest.token : NETWORKS.mainnet.contracts.vhp } }),
    getTransactionsById: async () => ({ transactions: [{ transaction, containing_blocks: [blockId] }] }),
    getHeadInfo: async () => ({ head_topology: { id: headId, height: "100" }, last_irreversible_block: "80", head_block_time: String(now) }),
    getBlocksById: async () => ({ block_items: [{ block_id: blockId, block_height: "42" }] }),
    getBlocks: async () => [{ block_id: blockId, block_height: "42",
      block: { id: blockId, header: { height: "42", timestamp: String(now - 60000) }, transactions: [transaction] },
      receipt: { id: blockId, height: "42", transaction_receipts: [receipt] } }],
  });
  return f;
}
test("wallet history finds the reported incoming KOIN after successful empty indexes", async () => {
  const f = fixture();
  const history = new WalletHistory({ wallet: { address }, clock: () => now,
    chain: { network: () => NETWORKS.mainnet, rpcUrls: () => urls, provider: () => f.provider } });
  const result = await history.read();
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].id, id);
  assert.equal(result.rows[0].status, "confirmed"); assert.equal(result.rows[0].type, "received");
  assert.equal(result.rows[0].counterparty, manifest.sender);
  assert.deepEqual(result.rows[0].changes, [{ asset: "KOIN", direction: "in", amount: "373280583588", formatted: "3732.80583588" }]);
  for (const irreversible of [false, true]) {
    assert.deepEqual(f.calls.filter(c => c.params.irreversible === irreversible).map(c => c.url), urls);
  }
});
test("Earn discovers an exact drop through fallback and still verifies its canonical receipt", async () => {
  const f = fixture(), reader = createLegacyKaiDrop({ getAddress: () => address, now: () => now, providerFactory: () => f.provider });
  const result = await reader.read(); reader.close();
  assert.equal(result.state, "paid"); assert.equal(result.payment.txId, id);
  assert.equal(result.koinAtoms, "373280583588"); assert.deepEqual(f.calls.map(c => c.url), urls);
  const g = fixture(); g.provider.getBlocks = async () => [];
  const unverified = createLegacyKaiDrop({ getAddress: () => address, now: () => now, providerFactory: () => g.provider });
  assert.notEqual((await unverified.read()).state, "paid"); unverified.close();
});
test("history fallback keeps the exact account, cursor, page limit and finality request", async () => {
  const f = rpc(url => ({ result: url === urls[2] ? { values: [{ seq_num: "0" }] } : {} }));
  const params = { address, limit: 20, ascending: false, irreversible: true, seq_num: "0" };
  const result = await f.provider.call("account_history.get_account_history", params);
  assert.equal(result.values[0].seq_num, "0");
  assert.deepEqual(f.calls.map(c => c.params), urls.map(() => params));
});
test("genuinely empty history remains empty after all configured indexes are checked", async () => {
  const f = rpc(() => ({ result: {} }));
  assert.deepEqual(await f.provider.call("account_history.get_account_history", { address }), {});
  assert.deepEqual(f.calls.map(c => c.url), urls);
});
test("a nonempty primary history is used without combining sequences from different indexes", async () => {
  const f = rpc(() => ({ result: { values: [entry] } }));
  assert.deepEqual(await f.provider.call("account_history.get_account_history", { address }), { values: [entry] });
  assert.equal(f.calls.length, 1);
});
test("empty history can recover past an unavailable history service", async () => {
  for (const unavailable of [() => ({ error: { code: -32601, message: "Method not found" } }), () => { throw Error("offline"); }]) {
    const f = rpc(url => url === urls[0] ? { result: {} } : url === urls[1] ? unavailable() : { result: { values: [entry] } });
    assert.deepEqual(await f.provider.call("account_history.get_account_history", { address }), { values: [entry] });
  }
});
test("history failures and invalid responses are not turned into successful movement", async () => {
  const f = rpc(() => { throw Error("offline"); });
  await assert.rejects(f.provider.call("account_history.get_account_history", { address }), /offline/);
  const g = rpc(() => ({ result: { values: "invalid" } }));
  const history = new WalletHistory({ wallet: { address },
    chain: { network: () => NETWORKS.mainnet, rpcUrls: () => urls, provider: () => Object.assign(g.provider, {
      getChainId: async () => manifest.chainId,
      invokeGetContractAddress: async name => ({ value: { address: NETWORKS.mainnet.contracts[name] } }),
    }) } });
  await assert.rejects(history.read(), /history is unavailable/);
});
test("empty contract reads, zero balances and signed submissions retain their original RPC semantics", async () => {
  for (const method of ["chain.read_contract", "chain.get_account_rc", "chain.submit_transaction"]) {
    const f = rpc(() => ({ result: {} }));
    assert.deepEqual(await f.provider.call(method, {}), {}); assert.equal(f.calls.length, 1);
  }
  const f = rpc(() => ({ error: { code: -32000, message: "insufficient mana" } }));
  await assert.rejects(f.provider.call("chain.submit_transaction", {}), /insufficient mana/);
  assert.equal(f.calls.length, 1);
});
