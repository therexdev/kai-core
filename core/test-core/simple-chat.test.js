"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http");
const { CoreChat, MAX_OUTPUT_BYTES } = require("../../electron/core-chat");
const { createChatController, conversation } = require("../../ui-core/chat");
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const request = { model: "installed", messages: [{ role: "user", content: "Hello" }] };
const models = [{ alias: "installed", label: "Installed model", status: "ready" }, { alias: "missing", status: "missing" }];
const core = port => ({ gateway: { port }, models: { aliases: () => models } });
const completion = (text = "Network answer", id = "a".repeat(64)) => ({ id, choices: [{ message: { role: "assistant", content: text } }] });
const chatInfo = extra => ({ configured: true, enabled: true, product: "prepaid-usd-v1", activation: "ready", blocked: "", recoveryAvailable: false,
  models: [{ model: "network-model", label: "Network model", available: true }], modelAvailabilityUntil: Date.now() + 60000, ...extra });

async function gateway(t, handler) {
  const calls = [], server = http.createServer(async (req, res) => {
    let data = ""; for await (const chunk of req) data += chunk;
    const call = { path: req.url, headers: req.headers, body: JSON.parse(data) }; calls.push(call);
    handler(call, res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { calls, chat: new CoreChat({ core: core(server.address().port) }) };
}
function fixture({ credit, local, onChange } = {}) {
  const calls = [];
  const controller = createChatController({
    bridge: {
      async call(method, input) { calls.push({ method, input }); return local ? local(method, input) : { text: "Local answer" }; },
      async credit(method, input) { calls.push({ method, input }); return credit ? credit(method, input) : method === "chat-info" ? chatInfo() : method === "chat-ack" ? { state: "delivered" } : completion(); },
    }, onChange,
  });
  controller.update({ models, network: { privacyMode: "local-first" }, runtime: {} });
  return { controller, calls };
}

test("local chat sends ordinary role history to the private loopback route without tools or network overflow", async t => {
  const f = await gateway(t, (_call, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(completion("Local synthetic answer"))); });
  const messages = [{ role: "user", content: "A private question" }, { role: "assistant", content: "A private answer" }, { role: "user", content: "Follow up" }];
  assert.deepEqual(await f.chat.send({ model: "installed", messages }), { text: "Local synthetic answer" });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, "/core/chat/completions");
  assert.deepEqual(f.calls[0].body, { model: "installed", messages, max_tokens: 1024, stream: false, kai_private_desktop: true });
  await f.chat.dispose();
});

test("local failure and redirect never try a second route", async t => {
  for (const status of [503, 307]) {
    const f = await gateway(t, (_call, res) => { res.statusCode = status; if (status === 307) res.setHeader("location", "/network"); res.end(JSON.stringify({ error: { message: "Model unavailable" } })); });
    await assert.rejects(f.chat.send(request)); assert.equal(f.calls.length, 1);
    await f.chat.dispose();
  }
});

test("local boundary rejects unavailable models, tool payloads, invented roles and oversized history before fetch", async () => {
  let fetched = 0; const chat = new CoreChat({ core: core(1), fetchImpl: async () => { fetched++; throw Error("must not fetch"); } });
  for (const input of [
    { ...request, model: "missing" }, { ...request, model: "koinos-network:paid" }, { ...request, tools: [] },
    { ...request, messages: [{ role: "system", content: "Secret Brain" }] },
    { ...request, messages: [{ role: "user", content: "hello", tool_calls: [] }] },
    { ...request, messages: [{ role: "user", content: "界".repeat(9000) }] },
    { ...request, maxTokens: 100000 },
  ]) await assert.rejects(chat.send(input));
  assert.equal(fetched, 0); await chat.dispose();
});

test("local response has a byte limit even without content-length", async () => {
  const chat = new CoreChat({ core: core(1), fetchImpl: async () => new Response("x".repeat(MAX_OUTPUT_BYTES + 1)) });
  await assert.rejects(chat.send(request), /too large/); await chat.dispose();
});

test("local Stop drains the request, rejects late replies and prevents overlapping sends", async () => {
  const pending = deferred(); let signal;
  const chat = new CoreChat({ core: core(1), fetchImpl: async (_url, options) => { signal = options.signal; return pending.promise; } });
  const sending = chat.send(request), rejected = assert.rejects(sending, /stopped/);
  await assert.rejects(chat.send(request), /Wait for/);
  const stopping = chat.stop(); assert.equal(signal.aborted, true);
  pending.resolve(new Response(JSON.stringify(completion("Too late"))));
  await rejected; assert.deepEqual(await stopping, { stopped: true });
  await chat.dispose(); await assert.rejects(chat.send(request), /closing/);
});

test("local conversation preserves roles and never makes a credit call on local-only startup or send", async () => {
  const { controller: c, calls } = fixture();
  c.update({ models, network: { privacyMode: "local-only" } });
  assert.equal(await c.send("First"), true); assert.equal(await c.send("Second"), true);
  assert.deepEqual(calls.map(c => c.method), ["chat.local", "chat.local"]);
  assert.deepEqual(calls[1].input.messages, [{ role: "user", content: "First" }, { role: "assistant", content: "Local answer" }, { role: "user", content: "Second" }]);
});

test("network send uses only the credit flow and acknowledges after the complete reply is displayed", async () => {
  const displayed = []; let c;
  const f = fixture({ onChange: state => displayed.push(state.turns.network.at(-1)?.answer), credit: async (method, input) => {
    if (method === "chat-info") return chatInfo();
    if (method === "chat-completion") { c.progress({ requestId: "a".repeat(64), delta: "Network " }); return completion(); }
    if (method === "chat-ack") { assert.equal(input, "a".repeat(64)); assert.equal(displayed.at(-1), "Network answer"); return { state: "delivered" }; }
    throw Error(`Unexpected operation ${method}`);
  } }); c = f.controller;
  await c.setSource("network"); assert.equal(await c.send("Public question"), true);
  assert.deepEqual(f.calls.find(call => call.method === "chat-completion").input, { model: "koinos-network:network-model", messages: [{ role: "user", content: "Public question" }], stream: true, freeOnly: false, paidFirst: false });
  assert.ok(displayed.includes("Network ")); assert.equal(c.state.turns.network[0].state, "done");
  assert.ok(!f.calls.some(call => /purchase|chat\.local/.test(call.method)));
});

test("switching to a network model never sends the local conversation or local draft", async () => {
  const { controller: c, calls } = fixture(); await c.send("Private local question"); c.setDraft("Private draft");
  await c.setSource("network"); assert.equal(c.state.draft.network, ""); await c.send("Network question");
  assert.deepEqual(calls.find(call => call.method === "chat-completion").input.messages, [{ role: "user", content: "Network question" }]);
  await c.setSource("local"); assert.equal(c.state.draft.local, "Private draft"); assert.equal(c.state.turns.local[0].prompt, "Private local question");
});

test("network failures retain retryable draft and require an explicit send without duplicating the failed turn", async () => {
  let sends = 0;
  const { controller: c, calls } = fixture({ credit: async method => {
    if (method === "chat-info") return chatInfo({ recoveryAvailable: sends > 0 });
    if (method === "chat-completion") { if (++sends === 1) throw Error("Connection interrupted"); return completion(); }
    if (method === "chat-ack") return { state: "delivered" };
  } });
  await c.setSource("network"); assert.equal(await c.send("Retry this"), false); await tick();
  assert.equal(sends, 1); assert.equal(c.state.draft.network, "Retry this"); assert.match(c.state.status, /interrupted/);
  assert.equal(calls.filter(c => c.method === "chat-recover").length, 0);
  assert.equal(await c.send(), true); assert.equal(sends, 2); assert.equal(c.state.turns.network.length, 1);
});

test("explicit recovery can display an already saved answer during catalog outage and acknowledges only afterward", async () => {
  const { controller: c, calls } = fixture({ credit: async method => {
    if (method === "chat-info") return chatInfo({ recoveryAvailable: true, blocked: "Model catalog offline", models: [], modelAvailabilityUntil: null });
    if (method === "chat-recover") return { completion: completion("Saved answer"), messages: [{ role: "system", content: "Old advanced instruction" }, { role: "user", content: "Saved question" }] };
    if (method === "chat-ack") return { state: "delivered" };
  } });
  await c.setSource("network"); assert.ok(!calls.some(c => c.method === "chat-recover"));
  assert.equal(await c.recover(), true); assert.deepEqual(c.state.turns.network, [{ prompt: "Saved question", answer: "Saved answer", state: "done" }]);
  assert.equal(calls.filter(c => c.method === "chat-recover").length, 1); assert.equal(calls.filter(c => c.method === "chat-ack").length, 1);
});

test("network progress mismatch and missing delivery acknowledgment keep a recoverable failure", async () => {
  let c;
  const f = fixture({ credit: async method => {
    if (method === "chat-info") return chatInfo({ recoveryAvailable: true });
    if (method === "chat-completion") { c.progress({ requestId: "a".repeat(64), delta: "Different prefix" }); return completion(); }
  } }); c = f.controller; await c.setSource("network");
  assert.equal(await c.send("Question"), false); assert.match(c.state.status, /changed during delivery/); assert.ok(!f.calls.some(c => c.method === "chat-ack"));
  const g = fixture({ credit: async method => method === "chat-info" ? chatInfo() : method === "chat-completion" ? completion() : Promise.reject(Error("Unavailable")) });
  await g.controller.setSource("network"); assert.equal(await g.controller.send("Question"), true);
  assert.equal(g.controller.state.turns.network[0].state, "done"); assert.match(g.controller.state.status, /Delivery confirmation failed/);
});

test("network Stop ignores late completion, keeps partial verified text and never acknowledges or retries", async () => {
  const pending = deferred(); let c;
  const f = fixture({ credit: async method => {
    if (method === "chat-info") return chatInfo({ recoveryAvailable: true });
    if (method === "chat-completion") { c.progress({ requestId: "a".repeat(64), delta: "Partial " }); return pending.promise; }
    if (method === "stop") return { state: "stopped" };
  } }); c = f.controller; await c.setSource("network"); const sending = c.send("Question"); await tick();
  await c.stop(); pending.resolve(completion("Partial reply")); assert.equal(await sending, false); await tick();
  assert.equal(c.state.turns.network[0].answer, "Partial "); assert.equal(c.state.turns.network[0].state, "failed");
  assert.equal(f.calls.filter(c => c.method === "stop").length, 1); assert.equal(f.calls.filter(c => c.method === "chat-completion").length, 1);
  assert.ok(!f.calls.some(c => ["chat-ack", "chat-recover"].includes(c.method)));
});

test("stop during preflight does not submit a model request or stop an unrelated credit operation", async () => {
  const check = deferred(); let first = true;
  const { controller: c, calls } = fixture({ credit: async method => { if (method === "chat-info") { if (first) { first = false; return chatInfo(); } return check.promise; } } });
  await c.setSource("network"); const sending = c.send("Question"); await tick(); await c.stop(); check.resolve(chatInfo());
  assert.equal(await sending, false); assert.ok(calls.every(c => c.method === "chat-info"));
});

test("privacy invalidation discards late network metadata and identity change clears only network history", async () => {
  const info = deferred(); const { controller: c, calls } = fixture({ credit: async () => info.promise });
  await c.send("Private local question"); const loading = c.setSource("network");
  c.invalidate({ privacyMode: "local-only" }); info.resolve(chatInfo()); await loading;
  assert.equal(c.state.info, null); assert.equal(await c.send("Must stay local"), false); assert.ok(!calls.some(c => c.method === "chat-completion"));
  c.invalidate({ identity: true }); assert.equal(c.state.turns.network.length, 0); assert.equal(c.state.turns.local.length, 1);
});

test("identity change during a network request never restores the prior account's prompt or late reply", async () => {
  const pending = deferred();
  const { controller: c, calls } = fixture({ credit: async method => method === "chat-info" ? chatInfo() : method === "chat-completion" ? pending.promise : { state: "stopped" } });
  await c.setSource("network"); const sending = c.send("Prior account's private prompt"); await tick();
  c.invalidate({ identity: true }); pending.resolve(completion("Prior account's late reply"));
  assert.equal(await sending, false); await tick();
  assert.deepEqual(c.state.turns.network, []); assert.equal(c.state.draft.network, ""); assert.equal(c.state.status, "Network account changed.");
  assert.equal(c.state.error, false); assert.ok(!calls.some(call => call.method === "chat-ack"));
});

test("unavailable, stale and disabled network models never start inference", async () => {
  for (const info of [chatInfo({ models: [{ model: "network-model", available: false }] }), chatInfo({ modelAvailabilityUntil: 1 }), chatInfo({ enabled: false })]) {
    const { controller: c, calls } = fixture({ credit: async () => info }); await c.setSource("network"); c.setModel("network-model");
    assert.equal(await c.send("Question"), false); assert.ok(calls.every(c => c.method === "chat-info"));
  }
});

test("free-only network session preserves the credit restriction", async () => {
  const { controller: c, calls } = fixture({ credit: async method => method === "chat-info" ? chatInfo({ freeOnlySession: true }) : method === "chat-ack" ? { state: "delivered" } : completion() });
  await c.setSource("network"); await c.send("Question");
  assert.equal(calls.find(c => c.method === "chat-completion").input.freeOnly, true); assert.equal(calls.find(c => c.method === "chat-completion").input.paidFirst, false);
});

test("escaped prompts fail visibly and bounded context retains the newest complete pairs", async () => {
  const { controller: c, calls } = fixture(); assert.equal(await c.send('"'.repeat(15000)), false); assert.match(c.state.status, /shorter/); assert.equal(calls.length, 0); assert.equal(c.state.busy, false);
  const turns = Array.from({ length: 40 }, (_v, index) => ({ prompt: `User ${index}`, answer: `Answer ${index}`, state: "done" }));
  const messages = conversation(turns, "Next"); assert.equal(messages.length, 31); assert.equal(messages[0].content, "User 25"); assert.deepEqual(messages.at(-1), { role: "user", content: "Next" });
  assert.ok(Buffer.byteLength(JSON.stringify(conversation([{ prompt: "Huge", answer: "x".repeat(30000), state: "done" }], "Next"))) < 24000);
});
