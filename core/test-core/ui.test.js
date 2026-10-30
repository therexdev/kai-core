"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../../ui-core/core.js"), "utf8");
const presentation = () => fs.readFileSync(path.join(__dirname, "../../ui-core/presentation.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../../ui-core/index.html"), "utf8");
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture({ state = {}, credit, call } = {}) {
  const elements = new Map(), windowEvents = new Map(), docEvents = new Map(), calls = [];
  let creditListener;
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
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    window: { kaiCore: bridge, dispatchEvent(event) { windowEvents.get(event.type)?.(event); }, addEventListener(event, fn) { windowEvents.set(event, fn); }, KaiCredits: { subscribe(fn) { creditListener = fn; }, clear() {}, async refresh() {} }, KaiCreditPresentation: require("../../ui/credit-account").creditPresentation },
    document: { hidden: false, activeElement: null, getElementById(id) { assert.ok(elements.has(id), `Missing element ${id}`); return elements.get(id); }, querySelectorAll() { return []; }, addEventListener(event, fn) { docEvents.set(event, fn); } },
    async fetch(url, options) { calls.push({ kind: "fetch", url, options }); return { ok: true, async json() { return { ok: true }; } }; },
  });
  vm.runInContext(presentation(), context, { filename: "presentation.js" });
  vm.runInContext(source, context, { filename: "core.js" });
  const submit = id => { const button = element("submit"); elements.get(id).onsubmit({ preventDefault() {}, submitter: button }); return flush(); };
  return { context, elements, calls, snapshot, windowEvents, docEvents, submit, acceptCredits: state => creditListener(state), $: id => elements.get(id) };
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

test("plugin labels are escaped rather than interpreted as HTML", async () => {
  const f = fixture({ state: { plugins: [{ id: "example.safe", name: '<img src=x onerror="attack()">', enabled: true, version: "1.0.0", permissions: [] }] } });
  await flush(); assert.match(f.$("plugins").innerHTML, /&lt;img/); assert.doesNotMatch(f.$("plugins").innerHTML, /<img/);
});
test("catalog displays community compatibility and escapes developer metadata without auto-refresh", async () => {
  const f = fixture({ state: { catalog: [{ id: "community.demo", name: "Community demo", description: '<img src=x onerror="attack()">', version: "1.0.0", compatible: false, compatibilityReason: "Requires KAI Core 0.4.0", minCoreVersion: "0.4.0", official: false }], registry: { available: true, version: "0.1.0", count: 1 } } });
  await flush(); const markup = f.$("plugin-catalog").innerHTML;
  assert.match(markup, /Community/); assert.match(markup, /&lt;img/); assert.doesNotMatch(markup, /<img/);
  assert.match(markup, /disabled>Requires newer Core/); assert.match(f.$("registry-status").textContent, /Signed catalog/);
  assert.ok(f.calls.every(call => call.method === "status"));
  f.$("plugin-search").value = "not present"; f.$("plugin-search").oninput();
  assert.match(f.$("plugin-catalog").innerHTML, /No plugins match/);
});

function creditsState(extra = {}) {
  return { status: "ready", snapshot: { key: "synthetic-credit-account", product: "prepaid-usd-v1", receivedAt: Date.now(),
    credits: { unit: "USD-1e-8", available: "125000000", purchased: { available: "100000000" }, free: { available: "25000000", state: "available" } },
    usage: [{ model: '<img onerror="attack()">', at: Date.now(), credits: "125000" }],
    purchases: [{ state: "confirmed", confirmedAt: Date.now() - 1000, credits: "100000000" }, { state: "pending", createdAt: Date.now() - 2000, amount: "50000000" }], ...extra } };
}
test("Your Credits displays verified balances and escaped usage with separate purchase filtering", async () => {
  const f = fixture(); await flush(); f.acceptCredits(creditsState());
  assert.equal(f.$("credits").textContent, "1,250");
  let markup = f.$("credit-activity").innerHTML;
  assert.match(markup, /−1.25/); assert.match(markup, /\+1,000/); assert.match(markup, /Pending/);
  assert.match(markup, /&lt;img/); assert.doesNotMatch(markup, /<img/);
  f.$("credit-filter").value = "purchase"; f.$("credit-filter").onchange();
  markup = f.$("credit-activity").innerHTML;
  assert.doesNotMatch(markup, /Chat/); assert.match(markup, /Purchased credits/);
  f.$("credit-filter").value = "usage"; f.$("credit-filter").onchange();
  assert.doesNotMatch(f.$("credit-activity").innerHTML, /Purchased credits/);
});
test("retained credit activity is marked stale and invalid amounts never become invented credits", async () => {
  const f = fixture(); await flush();
  const state = creditsState({ usage: [{ model: "model", at: Date.now(), credits: "not-a-number" }] });
  state.status = "unavailable"; state.error = "offline"; f.acceptCredits(state);
  assert.match(f.$("credit-detail").textContent, /last verified/);
  assert.match(f.$("credit-activity-status").textContent, /last verified activity/);
  assert.match(f.$("credit-activity").innerHTML, /Unavailable/);
  f.acceptCredits({ status: "loading", snapshot: null });
  assert.doesNotMatch(f.$("credit-activity").innerHTML, /Purchased credits/);
  assert.equal(f.$("credits").textContent, "…");
});
test("Wallet and Your Credits do not request purchase estimates; the purchase screen does", async () => {
  const f = fixture({ state: { network: { privacyMode: "network" } }, credit: async method => method === "purchase-estimate" ? { estimate: { koin: "1", credits: "1000" } } : {} });
  await flush(); f.context.showPage("wallet"); f.context.showPage("credits"); await flush();
  assert.ok(!f.calls.some(c => c.method === "purchase-estimate"));
  f.context.showPage("buy-credits"); await flush();
  assert.equal(f.$("workspace-title").textContent, "Buy credits");
  assert.equal(f.calls.filter(c => c.method === "purchase-estimate").length, 1);
});

test("cancelled saved payments are shown without erasing confirmed server purchases", async () => {
  const f = fixture({ state: { network: { privacyMode: "network" } }, credit: async method => method === "purchase-info" ? { cancelledPurchases: [{ txId: "cancelled-id" }, { txId: "confirmed-id" }] } : {} });
  await flush(); f.acceptCredits(creditsState({ purchases: [
    { id: "cancelled-id", state: "pending", amount: "100000000" },
    { id: "confirmed-id", state: "confirmed", credits: "100000000" },
  ] }));
  f.context.showPage("credits"); await flush();
  assert.match(f.$("credit-activity").innerHTML, /Cancelled · no purchase/);
  assert.match(f.$("credit-activity").innerHTML, /Added to balance/);
  assert.match(f.$("credit-activity").innerHTML, /\+1,000/);
});
