"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { validateNetwork, modelName } = require("../../ui-core/network");
const source = fs.readFileSync(path.join(__dirname, "../../ui-core/network.js"), "utf8");
const startTime = 1800000000000;
function overview(extra = {}) {
  return { observedAt: startTime, validUntil: startTime + 15000, state: "available", readyProviders: 2, waitingRequests: 3, completedToday: 7,
    models: [{ id: "koinos-fast", providers: 2, available: true, freeEligible: true, selectable: true }],
    providers: [{ id: "fixture-provider", model: "koinos-fast", state: "ready" }], activity: [{ model: "koinos-fast", at: startTime - 5000 }], ...extra };
}
function publicOverview(extra = {}) {
  return overview({ source: "public-scheduler", providersOnline: 2, readyProviders: null, completedToday: null, activityAvailable: false, activity: [],
    models: [{ id: "qwen2.5:7b", providers: 2, available: true, freeEligible: null, selectable: false }],
    providers: [{ id: "fixture-provider", model: "qwen2.5:7b", state: "online" }], ...extra });
}
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(initial = overview()) {
  const elements = new Map(), windowEvents = new Map(), documentEvents = new Map(), calls = [], dispatched = [], timers = new Map();
  let now = startTime, timerID = 0, response = initial;
  function element(id) {
    let markup = "", content = "";
    return { id, hidden: false, disabled: false, dataset: {}, writes: 0, textWrites: 0,
      get innerHTML() { return markup; }, set innerHTML(value) { markup = value; this.writes++; for (const [, child] of value.matchAll(/\bid="([^"]+)"/g)) if (!elements.has(child)) elements.set(child, element(child)); },
      get textContent() { return content; }, set textContent(value) { content = value; this.textWrites++; },
      classList: { names: new Set(), toggle(name, on) { if (on) this.names.add(name); else this.names.delete(name); } } };
  }
  elements.set("network-content", element("network-content"));
  const window = {
    kaiCore: { async credit(...args) { calls.push(args); const value = typeof response === "function" ? await response() : response; if (value instanceof Error) throw value; return { network: value }; } },
    addEventListener(name, fn) { if (!windowEvents.has(name)) windowEvents.set(name, []); windowEvents.get(name).push(fn); },
    dispatchEvent(event) { dispatched.push(event); for (const fn of windowEvents.get(event.type) || []) fn(event); },
  };
  const document = { hidden: false, getElementById: id => elements.get(id), addEventListener(name, fn) { documentEvents.set(name, fn); } };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({ window, document, Date: Clock, console,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    setTimeout(fn, delay) { const id = ++timerID; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(source, context, { filename: "network.js" });
  return { api: window.KaiCoreNetwork, calls, dispatched, timers, document, $: id => elements.get(`core-network-${id}`), host: elements.get("network-content"),
    setResponse(value) { response = value; }, emit(type, detail) { window.dispatchEvent({ type, detail }); },
    clickModel(id = "koinos-fast") { elements.get("core-network-models").onclick({ target: { closest() { return { dataset: { networkModel: id } }; } } }); },
    async advance(ms) { now += ms; for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= now && timers.delete(id)) timer.fn(); await flush(); },
    async hide(hidden) { document.hidden = hidden; documentEvents.get("visibilitychange")(); await flush(); },
  };
}

test("network page mounts without reading until entered and renders public presence without credit eligibility", async () => {
  const f = fixture(publicOverview()); assert.equal(f.calls.length, 0);
  await f.api.enter();
  assert.deepEqual(f.calls, [["network-overview"]]);
  assert.equal(f.$("state").textContent, "AI network status");
  assert.equal(f.$("provider-count").textContent, "2");
  assert.equal(f.$("provider-label").textContent, "providers online");
  assert.equal(f.$("waiting-label").textContent, "jobs waiting");
  assert.equal(f.$("completed").hidden, true); assert.equal(f.$("recent").hidden, true);
  assert.match(f.$("models").innerHTML, /Qwen2\.5 7b/i);
  assert.doesNotMatch(f.$("models").innerHTML, /Use model|credits eligible|Purchased credits/);
  f.clickModel("qwen2.5:7b"); assert.ok(!f.dispatched.some(event => event.type === "kai-core-use-network-model"));
});

test("unchanged observations preserve existing row DOM and never replace the mounted page", async () => {
  const f = fixture(); await f.api.enter();
  const modelWrites = f.$("models").writes, providerWrites = f.$("providers").writes, activityWrites = f.$("activity").writes, hostWrites = f.host.writes;
  await f.api.refresh(); await f.advance(10000);
  assert.equal(f.$("models").writes, modelWrites); assert.equal(f.$("providers").writes, providerWrites);
  assert.equal(f.$("activity").writes, activityWrites); assert.equal(f.host.writes, hostWrites);
  assert.equal(f.$("state").textContent, "AI network status");
  assert.doesNotMatch(f.$("time").textContent, /checks every|refreshing|loading/i);
});

test("fresh credit-backed models open chat with the exact model ID and disabled models cannot be selected", async () => {
  const f = fixture(); await f.api.enter(); f.clickModel();
  const event = f.dispatched.find(event => event.type === "kai-core-use-network-model");
  assert.equal(event.detail.model, "koinos-fast"); assert.equal(f.$("completed").hidden, false); assert.equal(f.$("completed-count").textContent, "7");
  for (const update of [{ selectable: false }, { available: false }, { providers: 0, available: false }]) {
    f.setResponse(overview({ models: [{ ...overview().models[0], ...update }] })); await f.api.refresh(); f.clickModel();
  }
  f.setResponse(overview({ state: "paused" })); await f.api.refresh(); f.clickModel();
  assert.equal(f.dispatched.filter(event => event.type === "kai-core-use-network-model").length, 1);
});

test("actual model names replace stale aliases in models, provider lists and activity without changing selection IDs", async () => {
  const models = [
    { ...overview().models[0], name: "Koinos Fast" },
    { ...overview().models[0], id: "koinos-balanced", name: "Koinos Balanced" },
    { ...overview().models[0], id: "koinos-network:koinos-smart", name: "Koinos Smart" },
  ];
  const f = fixture(overview({ models,
    providers: [{ id: "fixture-provider", model: "koinos-fast, koinos-balanced, koinos-network:koinos-smart", state: "ready" }],
    activity: [{ model: "koinos-network:koinos-fast", at: startTime - 5000 }],
  }));
  await f.api.enter();
  for (const name of ["Qwen 2.5 1.5B", "Llama 3.2 3B", "Qwen 2.5 7B"]) assert.ok(f.$("models").innerHTML.includes(`<strong>${name}</strong>`));
  assert.match(f.$("providers").innerHTML, /Qwen 2\.5 1\.5B, Llama 3\.2 3B, Qwen 2\.5 7B/);
  assert.match(f.$("activity").innerHTML, /Reply delivered · Qwen 2\.5 1\.5B/);
  for (const section of ["models", "providers", "activity"]) assert.doesNotMatch(f.$(section).innerHTML, /Koinos (?:Fast|Balanced|Smart)/);
  for (const model of models) f.clickModel(model.id);
  assert.deepEqual(f.dispatched.filter(event => event.type === "kai-core-use-network-model").map(event => event.detail.model), models.map(model => model.id));
});

test("expiry removes ready counts and disables model use even while the next read is pending", async () => {
  const f = fixture(); await f.api.enter();
  f.setResponse(() => new Promise(() => {})); await f.advance(10000);
  assert.equal(f.$("state").textContent, "AI network status");
  await f.advance(5000);
  assert.equal(f.$("state").textContent, "Network status unavailable"); assert.equal(f.$("provider-count").textContent, "—");
  assert.match(f.$("models").innerHTML, / disabled/); assert.match(f.$("providers").innerHTML, /status stale/);
  f.clickModel(); assert.ok(!f.dispatched.some(event => event.type === "kai-core-use-network-model"));
});

test("read failures immediately mark retained rows stale and explain the failure", async () => {
  const f = fixture(); await f.api.enter(); f.setResponse(Error("Cannot reach the selected network.")); await f.api.refresh();
  assert.equal(f.$("state").textContent, "Network status unavailable"); assert.equal(f.$("time").textContent, "Cannot reach the selected network.");
  assert.equal(f.$("model-count").textContent, "—"); assert.match(f.$("models").innerHTML, /Availability unconfirmed/);
  assert.match(f.$("activity-state").textContent, /Last verified/);
});

test("Local-Only clears private outputs and prevents new reads or late responses", async () => {
  const f = fixture(); await f.api.enter();
  let resolve; f.setResponse(() => new Promise(done => { resolve = done; })); const pending = f.api.refresh();
  f.emit("kai-core-privacy-changed", { mode: "local-only" });
  assert.equal(f.$("recent").hidden, true); assert.doesNotMatch(f.$("providers").innerHTML, /fixture-provider/);
  assert.doesNotMatch(f.$("activity").innerHTML, /Qwen 2\.5 1\.5B/); assert.match(f.$("time").textContent, /Local-Only/);
  const count = f.calls.length; await f.api.refresh(); await f.advance(30000); assert.equal(f.calls.length, count);
  resolve(overview()); await pending; assert.match(f.$("time").textContent, /Local-Only/); assert.equal(f.$("provider-count").textContent, "—");
  f.setResponse(publicOverview({ observedAt: startTime + 30000, validUntil: startTime + 45000 }));
  f.emit("kai-core-privacy-changed", { mode: "network" }); await flush(); assert.equal(f.$("provider-count").textContent, "2");
});

test("identity changes purge old private activity before a replacement read completes", async () => {
  const f = fixture(); await f.api.enter();
  f.setResponse(() => new Promise(() => {})); f.emit("kai-credit-identity-changed");
  assert.doesNotMatch(f.$("providers").innerHTML, /fixture-provider/); assert.doesNotMatch(f.$("activity").innerHTML, /Qwen 2\.5 1\.5B/);
  assert.equal(f.$("completed").hidden, true); assert.equal(f.$("model-count").textContent, "—");
});

test("leaving or hiding cancels polling and discards responses from a previous page visit", async () => {
  const f = fixture(); let resolve; f.setResponse(() => new Promise(done => { resolve = done; })); const pending = f.api.enter();
  f.api.leave(); resolve(overview()); await pending;
  assert.equal(f.$("provider-count").textContent, "—"); assert.equal(f.timers.size, 0);
  f.setResponse(overview()); await f.api.enter(); await f.hide(true);
  const count = f.calls.length; await f.advance(16000); assert.equal(f.calls.length, count); assert.equal(f.timers.size, 0);
  await f.hide(false); assert.equal(f.$("provider-count").textContent, "—");
});

test("untrusted model and provider metadata are escaped in every generated row and attribute", async () => {
  const attack = '<img src=x onerror="attack()">';
  const f = fixture(overview({ models: [{ id: attack, name: attack, providers: 1, available: true, freeEligible: false }],
    providers: [{ id: attack, model: attack, state: attack }], activity: [{ model: attack, at: startTime }] }));
  await f.api.enter();
  for (const id of ["models", "providers", "activity"]) { assert.match(f.$(id).innerHTML, /&lt;/); assert.doesNotMatch(f.$(id).innerHTML, /<img/i); }
  assert.match(f.$("models").innerHTML, /data-network-model="&lt;img src=x onerror=&quot;/);
});

test("snapshot validation rejects invented freshness and malformed availability", () => {
  assert.equal(validateNetwork(overview(), startTime).readyProviders, 2);
  for (const update of [{ validUntil: startTime + 15001 }, { observedAt: startTime + 5001 }, { readyProviders: -1 }, { completedToday: null }, { models: [{ ...overview().models[0], providers: 0 }] }, { models: [overview().models[0], overview().models[0]] }]) {
    assert.throws(() => validateNetwork(overview(update), startTime), /verified/);
  }
  assert.throws(() => validateNetwork(publicOverview({ models: [{ ...publicOverview().models[0], selectable: true }] }), startTime), /verified/);
  assert.throws(() => validateNetwork(publicOverview({ activity: [{ model: "private", at: startTime }] }), startTime), /verified/);
});

test("display names normalize known aliases while preserving names of unrelated models", () => {
  for (const [id, name] of [["koinos-fast", "Qwen 2.5 1.5B"], ["koinos-balanced", "Llama 3.2 3B"], ["koinos-smart", "Qwen 2.5 7B"]]) {
    assert.equal(modelName(id), name);
    assert.equal(modelName(`koinos-network:${id}`), name);
    assert.equal(modelName({ id, name: "Old display name" }), name);
  }
  assert.equal(modelName(" koinos-fast,koinos-network:koinos-balanced, koinos-smart "), "Qwen 2.5 1.5B, Llama 3.2 3B, Qwen 2.5 7B");
  assert.equal(modelName({ id: "custom-model", name: "My custom model" }), "My custom model");
  assert.equal(modelName("qwen2.5:7b"), "Qwen2.5 7b");
});
