"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createController, providerPresentation, validateRewards, rewardMarkup, legacyAtoms, legacySummary } = require("../../ui-core/earning");
const summaryApi = require("../../ui-core/reward-summary");
const start = 1800000000000;
const models = ["small", "large"].map(id => ({ id, label: id + " model", installed: true, compatible: true }));
const info = (extra = {}) => ({ state: "ready", enabled: false, running: false, deviceAuthorized: true, walletReady: true,
  selection: { mode: "all", models: [] }, models, modelAvailability: models, offeredModels: ["small", "large"], ...extra });
const rewards = (extra = {}) => ({ walletAddress: "fixture-wallet", scope: "a".repeat(64), observedAt: start, payouts: [], ...extra });
const online = (extra = {}) => ({ state: "online", label: "ONLINE", model: "small", detail: "Confirmed by network", validUntil: start + 15000,
  models: [{ state: "online", label: "ONLINE", model: "small", detail: "Confirmed by network", validUntil: start + 15000 }], ...extra });
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(initial = info(), { legacy = false } = {}) {
  let now = start, next = 0, currentInfo = initial, currentStatus = online(), currentRewards = rewards(), currentLegacy = { wallet: { address: "fixture-wallet", unlocked: false }, earnings: { address: "fixture-wallet", kai: "12345.67890123", pendingKai: "9999" } }, actionHandler;
  const calls = [], paints = [], timers = new Map(), navigations = [];
  const controller = createController({ summaryApi, now: () => now, render: (state, presentation) => paints.push({ state: structuredClone(state), presentation }),
    setTimer(fn, delay) { const id = ++next; timers.set(id, { fn, at: now + delay }); return id; }, clearTimer(id) { timers.delete(id); },
    navigate: page => navigations.push(page),
    ...(legacy ? { async readLegacy() {
      calls.push({ action: "legacy-balance" }); const value = typeof currentLegacy === "function" ? await currentLegacy() : currentLegacy;
      if (value instanceof Error) throw value; return structuredClone(value);
    } } : {}),
    async credit(action, input) {
      calls.push({ action, input }); let value;
      if (action === "provider-public-info") value = currentInfo;
      else if (action === "provider-public-status") value = currentStatus;
      else if (action === "provider-public-earnings") value = currentRewards;
      else return actionHandler?.(action, input) || { state: "ok" };
      if (typeof value === "function") value = await value(); if (value instanceof Error) throw value; return structuredClone(value);
    }
  });
  return { controller, calls, paints, timers, navigations, latest: () => paints.at(-1),
    setInfo(value) { currentInfo = value; }, setStatus(value) { currentStatus = value; }, setRewards(value) { currentRewards = value; }, setLegacy(value) { currentLegacy = value; }, setAction(fn) { actionHandler = fn; },
    async enter() { controller.enter(); await flush(); },
    async advance(ms) { now += ms; for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= now && timers.delete(id)) timer.fn(); await flush(); }
  };
}

test("enter checks setup and reward history without starting earning; leaving never stops earning", async () => {
  const f = fixture(); assert.equal(f.calls.length, 0); await f.enter();
  assert.deepEqual(f.calls.map(c => c.action).sort(), ["provider-public-earnings", "provider-public-info"]);
  assert.equal(f.latest().presentation.status.label, "OFFLINE"); assert.equal(f.latest().presentation.on, false);
  f.controller.leave(); assert.equal(f.timers.size, 0); assert.ok(!f.calls.some(c => c.action === "provider-public-stop"));
});

test("online evidence expires during a delayed refresh and no model remains falsely ready", async () => {
  const f = fixture(info({ enabled: true, running: true })); await f.enter();
  assert.equal(f.latest().presentation.ready, 1); assert.equal(f.latest().presentation.status.label, "ONLINE");
  let release; f.setInfo(() => new Promise(resolve => { release = resolve; }));
  await f.advance(10000); await f.advance(5000);
  assert.equal(f.latest().presentation.ready, 0); assert.equal(f.latest().presentation.status.label, "CONNECTION UNCONFIRMED");
  assert.equal(f.latest().presentation.action, "stop"); assert.equal(f.latest().presentation.disabled, false);
  release(info({ enabled: true, running: true })); await flush();
  assert.equal(f.latest().presentation.ready, 0); f.controller.leave();
});

test("an online status without expiring evidence cannot claim readiness", () => {
  const state = { info: info({ enabled: true, running: true }), status: online({ validUntil: undefined, models: [{ state: "online", model: "small" }] }), stale: false, busy: false };
  const view = providerPresentation(state, start); assert.equal(view.ready, 0); assert.notEqual(view.status.label, "ONLINE");
});

test("background reads preserve an unapplied individual model selection", async () => {
  const f = fixture(); await f.enter(); f.controller.editSelection("large", false);
  assert.deepEqual(f.controller.getState().draft, { mode: "selected", models: ["small"] });
  await f.controller.refresh(); assert.deepEqual(f.controller.getState().draft, { mode: "selected", models: ["small"] });
  assert.ok(!f.calls.some(c => c.action === "provider-public-models"));
  f.controller.resetSelection(); assert.deepEqual(f.controller.getState().draft, { mode: "all", models: [] }); f.controller.leave();
});

test("Apply uses the native model-selection action and accepts the saved selection", async () => {
  const f = fixture(); await f.enter(); f.controller.editSelection("large", false);
  f.setAction((action, selection) => { assert.equal(action, "provider-public-models"); f.setInfo(info({ selection })); return { state: "models-selected", selection }; });
  await f.controller.applySelection(); assert.deepEqual(f.calls.find(c => c.action === "provider-public-models").input, { mode: "selected", models: ["small"] });
  assert.deepEqual(f.controller.getState().draft, { mode: "selected", models: ["small"] });
  f.controller.editSelection(null, false); await f.controller.applySelection();
  assert.equal(f.calls.filter(c => c.action === "provider-public-models").length, 1); f.controller.leave();
});

test("Stop remains available during startup and discards its later result", async () => {
  const f = fixture(); await f.enter(); let finishStart;
  f.setAction(action => { if (action === "provider-public-start") return new Promise(resolve => { finishStart = resolve; }); return { state: "offline" }; });
  const pendingStart = f.controller.toggle(); await flush();
  assert.equal(f.latest().presentation.status.label, "STARTING"); assert.equal(f.latest().presentation.on, true); assert.equal(f.latest().presentation.disabled, false);
  await f.controller.toggle(); assert.equal(f.latest().presentation.status.label, "OFFLINE");
  finishStart({ state: "online" }); await pendingStart; assert.equal(f.latest().presentation.status.label, "OFFLINE");
  assert.deepEqual(f.calls.filter(c => /provider-public-(start|stop)$/.test(c.action)).map(c => c.action), ["provider-public-start", "provider-public-stop"]); f.controller.leave();
});

test("wallet setup navigates to Wallet without attempting authorization", async () => {
  const f = fixture(info({ state: "wallet-required", walletReady: false, deviceAuthorized: false, canAuthorize: true })); await f.enter();
  assert.equal(f.latest().presentation.toggleLabel, "Set up earning"); await f.controller.toggle();
  assert.deepEqual(f.navigations, ["wallet"]); assert.ok(!f.calls.some(c => /authorize|start/.test(c.action))); f.controller.leave();
});

test("device authorization uses native approval before start, and cancellation never starts sharing", async () => {
  const initial = info({ state: "authorization-required", deviceAuthorized: false, canAuthorize: true, secureStorage: { available: false } });
  const f = fixture(initial); await f.enter(); f.setAction(() => ({ state: "cancelled" })); await f.controller.toggle();
  assert.deepEqual(f.calls.find(c => c.action === "provider-public-authorize").input, { sessionOnly: true });
  assert.ok(!f.calls.some(c => c.action === "provider-public-start")); assert.match(f.controller.getState().notice, /not changed/);
  f.setAction(action => { if (action === "provider-public-authorize") return { state: "authorized" }; f.setInfo(info({ enabled: true, running: true })); return { state: "online" }; });
  await f.controller.toggle(); assert.equal(f.calls.filter(c => c.action === "provider-public-start").length, 1);
  assert.equal(f.latest().presentation.status.label, "ONLINE"); f.controller.leave();
});

test("read failure removes readiness but preserves a working Stop control", async () => {
  const f = fixture(info({ enabled: true, running: true })); await f.enter(); f.setInfo(Error("Connection unavailable")); await f.controller.refresh();
  assert.equal(f.latest().presentation.ready, 0); assert.equal(f.latest().presentation.status.label, "CONNECTION UNCONFIRMED");
  assert.equal(f.latest().presentation.on, true); assert.equal(f.latest().presentation.disabled, false); f.controller.leave();
});

test("leaving or changing identity discards late provider and reward reads", async () => {
  const f = fixture(); let providerResolve, rewardResolve;
  f.setInfo(() => new Promise(resolve => { providerResolve = resolve; })); f.setRewards(() => new Promise(resolve => { rewardResolve = resolve; }));
  await f.enter(); f.controller.leave(); f.controller.reset();
  providerResolve(info({ enabled: true, running: true })); rewardResolve(rewards()); await flush();
  assert.equal(f.controller.getState().info, null); assert.equal(f.controller.getState().rewards, null); assert.equal(f.timers.size, 0);
});

test("reward history retains verified rows on failure and invalidates them on identity change", async () => {
  const f = fixture(); f.setRewards(rewards({ payouts: [{ epoch: "20000", state: "paid", availability: "120000000", work: "30000000" }] })); await f.enter();
  assert.match(rewardMarkup(f.controller.getState().rewards), /1\.50000000 KOIN/);
  f.setRewards(Error("Network unavailable")); await f.controller.refresh();
  assert.equal(f.controller.getState().rewards.payouts.length, 1); assert.equal(f.controller.getState().rewardError, "Network unavailable");
  f.controller.leave(); f.controller.reset(); assert.equal(f.controller.getState().rewards, null);
});

test("reward validation rejects malformed, duplicate, stale and overflowing amounts", () => {
  const row = { epoch: "20000", state: "paid", availability: "100", work: "200" };
  for (const value of [rewards({ observedAt: start - 30001 }), rewards({ payouts: [row, row] }), rewards({ payouts: [{ ...row, work: "<img>" }] }),
    rewards({ payouts: [{ ...row, work: "18446744073709551615" }] }), rewards({ payouts: [{ ...row, state: "constructor" }] })]) {
    assert.throws(() => validateRewards(value, start, summaryApi));
  }
  const valid = validateRewards(rewards({ payouts: [row], summary: { unverified: true } }), start, summaryApi);
  assert.equal(valid.summary, null); assert.equal(valid.payouts.length, 1);
});


test("testnet drop keeps the original exact 1 KOIN per 5 wallet KAI estimate, excluding pending KAI", () => {
  const value = kai => ({ wallet: { address: "wallet-a", unlocked: false }, earnings: { address: "wallet-a", kai, pendingKai: "9999" } });
  assert.deepEqual(legacySummary(value("12345.67890123")), { wallet: "wallet-a", kai: "12,345.67890123", koin: "2,469.13578024" });
  assert.equal(legacySummary(value("0")).koin, "0");
  assert.equal(legacySummary(value("5e-8")).koin, "0.00000001");
  assert.equal(legacySummary(value("0.00000004")).koin, "0");
  assert.equal(legacyAtoms("184467440737.09551615"), 18446744073709551615n);
  for (const kai of [undefined, null, 1, "-1", "NaN", "Infinity", "0.000000001", "184467440738", "1e99", "<img src=x>"]) assert.equal(legacySummary(value(kai)), null);
  const mismatch = value("123"); mismatch.earnings.address = "wallet-b"; assert.equal(legacySummary(mismatch), null);
  const failed = value("123"); failed.earnings.error = "Unavailable"; assert.equal(legacySummary(failed), null);
  assert.equal(legacySummary({ wallet: { address: "wallet-a" }, earnings: null }), null);
});

test("Earn reads locked-wallet KAI without starting, signing or changing wallet state; failed reads retain the last verified amounts", async () => {
  const f = fixture(info(), { legacy: true }); assert.equal(f.calls.length, 0); await f.enter();
  assert.deepEqual(f.controller.getState().legacy, { wallet: "fixture-wallet", kai: "12,345.67890123", koin: "2,469.13578024" });
  assert.deepEqual(f.calls.map(call => call.action).sort(), ["legacy-balance", "provider-public-earnings", "provider-public-info"]);
  f.setLegacy(Error("Balance unavailable")); await f.controller.refresh();
  assert.equal(f.controller.getState().legacy.kai, "12,345.67890123"); assert.equal(f.controller.getState().legacyError, "Balance unavailable");
  f.setLegacy({ wallet: { address: "fixture-wallet" }, earnings: { address: "fixture-wallet", kai: "0" } }); await f.controller.refresh();
  assert.equal(f.controller.getState().legacy.kai, "0"); assert.equal(f.controller.getState().legacyError, ""); f.controller.leave();
  assert.equal(f.controller.getState().legacy.kai, "0"); assert.equal(f.timers.size, 0);
});

test("a delayed KAI refresh retains an explicitly stale amount and leaving discards its response", async () => {
  const f = fixture(info(), { legacy: true }); await f.enter();
  let release; f.setLegacy(() => new Promise(resolve => { release = resolve; }));
  await f.advance(20000); assert.ok(f.controller.getState().legacy);
  await f.advance(10000); assert.equal(f.controller.getState().legacy.kai, "12,345.67890123"); assert.match(f.controller.getState().legacyError, /fresh/);
  f.controller.leave(); release({ wallet: { address: "fixture-wallet" }, earnings: { address: "fixture-wallet", kai: "999" } }); await flush();
  assert.equal(f.controller.getState().legacy.kai, "12,345.67890123"); assert.equal(f.timers.size, 0);
});

test("privacy or identity reset clears KAI and rejects an earlier account's delayed read", async () => {
  const f = fixture(info(), { legacy: true }); await f.enter();
  let release; f.setLegacy(() => new Promise(resolve => { release = resolve; })); const oldRead = f.controller.refresh(); await flush();
  f.setLegacy({ wallet: { address: "fixture-wallet" }, earnings: null }); f.controller.reset(); await flush();
  assert.equal(f.controller.getState().legacy, null);
  release({ wallet: { address: "old-wallet" }, earnings: { address: "old-wallet", kai: "999" } }); await oldRead;
  assert.equal(f.controller.getState().legacy, null); f.controller.leave();
});


test("reopening Earn retains KAI and reward totals until a fresh read arrives", async () => {
 const f=fixture(info(),{legacy:true});await f.enter();f.controller.leave();
 const saved=f.controller.getState().legacy;let done;f.setLegacy(()=>new Promise(resolve=>{done=resolve;}));
 await f.enter();assert.deepEqual(f.controller.getState().legacy,saved);
 done({wallet:{address:"fixture-wallet"},earnings:{address:"fixture-wallet",kai:"25"}});await flush();
 assert.equal(f.controller.getState().legacy.kai,"25");f.controller.leave();
});

test("Earn's mounted page warms without navigation, pauses hidden, and purges data on identity/privacy changes", async()=>{
 const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path"),events=new Map(),documentEvents=new Map(),nodes=new Map(),calls=[],timers=new Map();let timer=0,now=start;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,disabled:false,dataset:{},textContent:"",innerHTML:"",value:"",addEventListener(){},setAttribute(){},querySelector(){return null;},querySelectorAll(){return [];}});return nodes.get(id);};
 const document={hidden:false,getElementById:node,addEventListener:(name,fn)=>documentEvents.set(name,fn)};
 const window={document,KaiRewardSummary:summaryApi,KaiCoreNotice:{create:()=>({show(){}})},addEventListener:(name,fn)=>events.set(name,fn),dispatchEvent(){},
  kaiCore:{credit:async action=>{calls.push(action);return action==="provider-public-info"?{state:"ready",enabled:false,running:false,models:[]}:rewards();},call:async()=>({wallet:{address:"fixture-wallet"},earnings:{address:"fixture-wallet",kai:"125"}})}};
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../../ui-core/earning.js"),"utf8"),{window,Date:Clock,console,setTimeout(fn,delay){const id=++timer;timers.set(id,{fn,at:now+delay});return id;},clearTimeout:id=>timers.delete(id)});
 const api=window.KaiCoreEarning;api.observe({address:"fixture-wallet"},"network");await flush();
 assert.equal(node("earn-wallet-kai").textContent,"125");assert.equal(calls.length,2);
 api.leave();now+=15000;for(const[id,t]of[...timers])if(t.at<=now&&timers.delete(id))t.fn();await flush();assert.equal(calls.length,4);
 document.hidden=true;documentEvents.get("visibilitychange")();assert.equal(timers.size,0);assert.equal(node("earn-wallet-kai").textContent,"125");
 document.hidden=false;documentEvents.get("visibilitychange")();await flush();assert.equal(calls.length,6);
 events.get("kai-core-privacy-changed")({detail:{mode:"local-only"}});assert.equal(node("earn-wallet-kai").textContent,"—");
 api.enter();await flush();assert.equal(calls.length,8);assert.equal(node("earn-wallet-kai").textContent,"125","Public KAI wallet balances remain available in Local-Only");
 events.get("kai-core-privacy-changed")({detail:{mode:"network"}});await flush();assert.equal(node("earn-wallet-kai").textContent,"125");
 window.kaiCore.call=()=>new Promise(()=>{});events.get("kai-credit-identity-changed")();assert.equal(node("earn-wallet-kai").textContent,"—");
 document.hidden=true;documentEvents.get("visibilitychange")();
});

test("visible Earn checks verified increments every five seconds; other pages use fifteen", async () => {
  const f = fixture(); f.controller.setForeground(true); await f.enter();
  const count = () => f.calls.filter(c => c.action === "provider-public-earnings").length;
  assert.equal(count(), 1); await f.advance(4999); assert.equal(count(), 1);
  await f.advance(1); assert.equal(count(), 2);
  f.controller.setForeground(false); await flush(); const before = count();
  await f.advance(5000); assert.equal(count(), before); await f.advance(10000); assert.equal(count(), before + 1);
  let done; f.setRewards(() => new Promise(resolve => done = resolve));
  f.controller.setForeground(true); await flush(); const waiting = count();
  await f.advance(5000); assert.equal(count(), waiting, "No overlapping reward read");
  f.controller.leave(); done(rewards({ observedAt: start + 25000 })); await flush(); assert.equal(f.timers.size, 0);
});
