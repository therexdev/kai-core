"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../../ui-core/core.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../../ui-core/index.html"), "utf8");
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture({ state = {}, credit, call } = {}) {
  const elements = new Map(), windowEvents = new Map(), docEvents = new Map(), calls = [];
  function element(id) {
    return { id, textContent: "", innerHTML: "", value: id === "usd" ? "1" : "", hidden: false, disabled: false, dataset: {}, attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; }, classList: { toggle() {} } };
  }
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) elements.set(id, element(id));
  const snapshot = { version: "0.1.0", models: [], plugins: [], wallet: { exists: true, address: "synthetic-wallet", unlocked: false },
    profile: { mode: "existing", dataDir: "/synthetic/profile", backup: "/synthetic/backup", preserved: { wallet: true } }, runtime: {}, network: { privacyMode: "local-only" }, ...state };
  const bridge = {
    async call(method, input) { calls.push({ kind: "core", method, input }); if (method === "status") return snapshot; return call?.(method, input); },
    async credit(method, input) { calls.push({ kind: "credit", method, input }); return credit?.(method, input); },
  };
  const context = vm.createContext({ console, setInterval() { return 1; }, clearInterval() {},
    window: { kaiCore: bridge, addEventListener(event, fn) { windowEvents.set(event, fn); }, KaiCredits: { subscribe() {}, clear() {}, async refresh() {} }, KaiCreditPresentation() { return {}; } },
    document: { hidden: false, activeElement: null, getElementById(id) { assert.ok(elements.has(id), `Missing element ${id}`); return elements.get(id); }, querySelectorAll() { return []; }, addEventListener(event, fn) { docEvents.set(event, fn); } },
    async fetch(url, options) { calls.push({ kind: "fetch", url, options }); return { ok: true, async json() { return { ok: true }; } }; },
  });
  vm.runInContext(source, context, { filename: "core.js" });
  const submit = id => { const button = element("submit"); elements.get(id).onsubmit({ preventDefault() {}, submitter: button }); return flush(); };
  return { context, elements, calls, snapshot, windowEvents, docEvents, submit, $: id => elements.get(id) };
}

test("existing wallet UI does not create or restore a wallet on startup", async () => {
  const f = fixture(); await flush();
  assert.equal(f.$("create-wallet").hidden, true); assert.equal(f.$("restore-wallet").hidden, true);
  assert.equal(f.$("wallet-address").textContent, "synthetic-wallet");
  assert.ok(f.calls.every(c => c.method === "status"));
});

test("generated backup key is cleared on blur, page exit, and wallet lock", async () => {
  const f = fixture({ state: { wallet: { exists: false, unlocked: false } }, call: async method => method === "wallet.create" ? { wif: "synthetic-backup-key" } : {} });
  await flush();
  for (const clear of [() => f.windowEvents.get("blur")(), () => f.context.showPage("models"), () => f.$("lock-wallet").onclick({ currentTarget: f.$("lock-wallet") })]) {
    f.$("password").value = "synthetic-password";
    await f.$("create-wallet").onclick({ currentTarget: f.$("create-wallet") });
    assert.match(f.$("wallet-backup").textContent, /synthetic-backup-key/); assert.equal(f.$("password").value, "");
    await clear(); assert.equal(f.$("wallet-backup").textContent, ""); assert.equal(f.$("wallet-backup").hidden, true);
  }
});

test("purchase cancellation never requests a quote or payment approval", async () => {
  const f = fixture({ credit: async method => method === "purchase-connect" ? { state: "cancelled" } : {} });
  await flush(); await f.submit("buy-credits");
  assert.deepEqual(f.calls.filter(c => c.kind === "credit").map(c => c.method), ["purchase-connect"]);
  assert.match(f.$("purchase-state").textContent, /cancelled/);
});

test("purchase failures leave a retryable state and never say Preparing forever", async () => {
  const f = fixture({ credit: async method => { if (method === "purchase-connect") return { state: "ready" }; throw Error("Quote expired"); } });
  await flush(); await f.submit("buy-credits");
  assert.equal(f.$("purchase-state").textContent, "Quote expired");
  assert.match(f.$("price").textContent, /fresh quote/);
  assert.ok(!f.calls.some(c => c.method === "purchase-approve"));
});

test("successful purchase approves exactly the returned quote ID", async () => {
  const f = fixture({ credit: async method => ({ "purchase-connect": { state: "ready" }, "purchase-preview": { quote: { id: "verified-quote", koin: "4.00", credits: "1000" } }, "purchase-approve": { state: "confirmed" } })[method] });
  await flush(); await f.submit("buy-credits");
  const approval = f.calls.find(c => c.method === "purchase-approve"); assert.equal(approval.input, "verified-quote");
  assert.equal(f.$("purchase-state").textContent, "confirmed");
});

test("model import and asynchronous load errors appear in the model view", async () => {
  const f = fixture({ state: { importError: "Unsupported GGUF header" } }); await flush();
  assert.equal(f.$("model-message").textContent, "Unsupported GGUF header");
  f.snapshot.ensure = { state: "error", alias: "model", error: "Insufficient memory" }; await f.context.refresh();
  assert.equal(f.$("model-message").textContent, "Insufficient memory");
});

test("reward feed displays verified amounts and marks retained results when read fails", async () => {
  let offline = false;
  const f = fixture({ credit: async method => {
    if (method === "provider-public-earnings") { if (offline) throw Error("Connection unavailable"); return { observedAt: 1793318400000, payouts: [{ epoch: "20755", state: "paid", availability: "125000000", work: "75000000" }] }; }
    return {};
  } }); await flush(); f.context.showPage("earning"); await flush();
  assert.match(f.$("rewards").innerHTML, /2 KOIN/); assert.match(f.$("rewards").innerHTML, /paid/);
  const previous = f.$("rewards").innerHTML; offline = true; await f.context.rewards();
  assert.equal(f.$("rewards").innerHTML, previous); assert.match(f.$("reward-status").textContent, /last verified/);
});

test("plugin labels are escaped rather than interpreted as HTML", async () => {
  const f = fixture({ state: { plugins: [{ id: "example.safe", name: '<img src=x onerror="attack()">', enabled: true, version: "1.0.0", permissions: [] }] } });
  await flush(); assert.match(f.$("plugins").innerHTML, /&lt;img/); assert.doesNotMatch(f.$("plugins").innerHTML, /<img/);
});
