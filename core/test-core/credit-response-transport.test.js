"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Signer } = require("koilib"), P = require("../lib/koin-network/job-protocol"), F = require("../lib/koin-network/funded-protocol");
const { PrepaidChat } = require("../../electron/koin-prepaid-chat"), { protocol, MAINNET_CHAIN } = require("../lib/koin-network/payment-network");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-credit-transport-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const provider = Signer.fromSeed("credit-transport-fixture-provider"), model = "transport-fixture";
  const tariff = Object.fromEntries(Object.entries({ model, version: 1, modelHash: P.hash("model"), tokenizerHash: P.hash("tokens"), templateHash: P.hash("template"),
    inputAtomsPerMillion: "1000000", outputAtomsPerMillion: "1000000", maxOutputTokens: 64, contextTokens: 4096, maxLatencyMs: 30000 }).sort(([a], [b]) => a.localeCompare(b)));
  const config = { owner: "account-" + P.hash("transport-buyer"), version: 1, model, maxOutput: 64, schedulerUrl: "https://network.invalid/scheduler",
    policyHash: P.hash(JSON.stringify(["KAI-KOIN-SHADOW-TARIFFS-V1", tariff])), deployment: { product: "prepaid-usd-v1",
      chainId: MAINNET_CHAIN, credits: Signer.fromSeed("transport-contract").getAddress(), creditsHash: "0x1220" + P.hash("wasm") } };
  const storage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s).map(n => n ^ 19), decryptString: b => b.map(n => n ^ 19).toString() };
  const state = { calls: [], progress: [], result: null, waits: [] };
  const flow = new PrepaidChat({ config, file: path.join(dir, "chat.json"), storage, access: { authorize: () => ({ owner: config.owner, sessionToken: "fixture-only" }) },
    wait: async (ms, signal) => { signal.throwIfAborted(); state.waits.push(ms); await state.onWait?.(ms, signal); },
    progress: value => state.progress.push(value), fetchImpl: async (url, init) => {
      const action = url.endsWith("/consume/chat/completions") ? "chat" : url.split("/").at(-1), body = JSON.parse(init.body);
      state.calls.push({ action, body, headers: init.headers });
      if (state.respond) { const result = await state.respond(action, body, init.signal); if (result) return result; }
      const now = Date.now();
      const value = action === "models" ? { catalog: { schema: 1, policyHash: config.policyHash, tariffs: [tariff], asOf: now, validUntil: now + 15000, models: [{ model, providers: 1, available: true }] } }
        : action === "estimate" ? { estimate: { model, unit: "USD-1e-8", maxCharge: "69", maxFree: "69", maxPaid: "0", allowed: true } }
        : action === "capabilities" ? { capabilities: {} } : action === "result" ? { completion: state.result } : {};
      return new Response(JSON.stringify(envelope(value)), { headers: { "content-type": "application/json" } });
    } });
  const wire = protocol(flow.target), envelope = value => ({ ok: true, product: config.deployment.product, mode: wire.mode, paymentsEnabled: wire.paymentsEnabled, ...value });
  async function completion(body, output, { partial = false, charged = false, tokens = output.length } = {}) {
    const at = Date.now(), q = { schema: 2, mode: "shadow", domain: flow.target.domain, policyHash: config.policyHash, tariff,
      requestHash: P.hash(JSON.stringify(body.messages)), promptHash: P.hash("prompt"), inputIdsHash: P.hash("ids"), inputTokens: 5, maxOutput: body.max_tokens, maxCharge: "69", at, expires: at + 300000 };
    q.hash = P.hash(JSON.stringify(q));
    const id = body.requestId, session = P.hash("prepaid-account:" + config.owner), attempt = P.hash("attempt"), job = { id, session, attempt, quote: q };
    const receipt = { product: config.deployment.product, job: id, owner: config.owner, provider: provider.getAddress(), attempt, quoteHash: q.hash, outputHash: P.hash(output),
      dispatchedAt: at, completedAt: at + 1, usage: { inputTokens: 5, outputTokens: tokens, amount: String(5 + tokens) },
      ...(partial ? { sequence: 1 } : {}), signature: Buffer.from(await provider.signHash(partial ? F.fundedChunkHash(flow.target, job, output, 1) : F.fundedResultHash(flow.target, job, output))).toString("base64") };
    return { id, choices: [{ message: { content: output } }], koin: { product: config.deployment.product, state: partial && !charged ? "streaming" : "charged",
      target: flow.target, session, quote: q, receipt, receiptHash: P.hash(JSON.stringify(receipt)) } };
  }
  const frame = value => "data: " + JSON.stringify(envelope({ completion: value })) + "\n\n";
  const stream = text => new Response(text, { headers: { "content-type": "text/event-stream" } });
  const input = { model: "koinos-network:" + model, messages: [{ role: "user", content: "Research this topic" }], max_tokens: 64, stream: false };
  return { flow, state, input, completion, frame, stream, envelope, signal: () => AbortSignal.timeout(10000) };
}

test("a buffered caller streams verified receipts through the gateway but receives only the final answer", async t => {
  const f = fixture(t); let release, prefixSaved;
  const prefix = new Promise(resolve => prefixSaved = resolve);
  f.state.respond = async (action, body) => {
    if (action !== "chat") return;
    if (!body.stream) return new Response("<!DOCTYPE html><title>Gateway timeout</title>", { status: 524 });
    const first = await f.completion(body, "Research ", { partial: true }), last = await f.completion(body, "Research complete");
    return new Response(new ReadableStream({ async start(c) {
      c.enqueue(Buffer.from(f.frame(first))); prefixSaved();
      await new Promise(resolve => release = resolve);
      c.enqueue(Buffer.from(f.frame(last) + "data: [DONE]\n\n")); c.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  };
  let settled = false;
  const pending = f.flow.chat(null, f.input, f.signal()).finally(() => settled = true);
  await prefix; for (let i = 0; i < 5; i++) await new Promise(setImmediate);
  assert.equal(settled, false); assert.equal(f.flow.read().state, "answered", "verified prefix is durable before final delivery");
  assert.equal(f.state.progress.some(p => typeof p === "object"), false, "buffered callers do not receive deltas");
  release(); const answer = await pending;
  assert.equal(answer.choices[0].message.content, "Research complete"); assert.equal(answer.choices[0].finish_reason, "stop");
  assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
  assert.equal(f.state.calls.find(c => c.action === "chat").body.stream, true); assert.equal(f.input.stream, false);
  assert.equal(f.state.calls.find(c => c.action === "chat").headers["x-kai-credit-stream"], "keepalive-v1");
});

test("a lost final frame recovers the same completed job without a second generation", async t => {
  const f = fixture(t);
  f.state.respond = async (action, body) => {
    if (action !== "chat") return;
    f.state.result = await f.completion(body, "Recovered answer");
    return f.stream(f.frame(await f.completion(body, "Recovered ", { partial: true })));
  };
  const answer = await f.flow.chat(null, f.input, f.signal());
  const id = f.flow.read().id;
  assert.equal(answer.id, id); assert.equal(answer.choices[0].message.content, "Recovered answer");
  assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
  assert.equal(f.state.calls.filter(c => c.action === "result").length, 1);
  assert.equal(f.state.calls.find(c => c.action === "result").body.requestId, id);
});

test("a charged signed prefix is retained but cannot masquerade as a completed buffered answer", async t => {
  const f = fixture(t);
  f.state.respond = async (action, body) => {
    if (action !== "chat") return;
    f.state.result = await f.completion(body, "Unfinished", { partial: true, charged: true });
    return f.stream(f.frame(f.state.result) + "data: [DONE]\n\n");
  };
  const incomplete = e => e.code === "credit-response-incomplete" && e.safeToRetry === false;
  await assert.rejects(f.flow.chat(null, f.input, f.signal()), incomplete);
  const saved = f.flow.read();
  await assert.rejects(f.flow.recover(null, f.signal()), incomplete);
  assert.equal(f.flow.read().id, saved.id); assert.equal(f.flow.read().state, "answered");
  assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
  assert.equal(f.state.calls.some(c => c.action === "acknowledge"), false);
});

test("a streaming retry refreshes a saved prefix from the same job without another generation", async t => {
  for (const terminalPrefix of [false, true]) {
    const f = fixture(t), input = { ...f.input, stream: true }; let original;
    f.state.respond = async (action, body) => {
      if (action !== "chat") return;
      original = body;
      return f.stream(f.frame(await f.completion(body, "Saved", { partial: true })));
    };
    await assert.rejects(f.flow.chat(null, input, f.signal()), e => e.code === "credit-response-interrupted");
    const before = f.flow.read();
    f.state.result = await f.completion(original, terminalPrefix ? "Saved" : "Saved complete", { partial: terminalPrefix, charged: true });
    const answer = await f.flow.chat(null, input, f.signal());
    assert.equal(answer.id, before.id); assert.equal(answer.koin.state, "charged");
    assert.equal(answer.choices[0].message.content, terminalPrefix ? "Saved" : "Saved complete");
    assert.equal(answer.koin.receipt.sequence !== undefined, terminalPrefix, "terminal prefixes remain identifiable as incomplete");
    assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
    assert.equal(f.state.calls.filter(c => c.action === "result").length, 2);
    assert.ok(f.state.calls.filter(c => c.action === "result").every(c => c.body.requestId === before.id));
    assert.equal(f.state.calls.some(c => c.action === "cancel"), false);
    assert.equal(JSON.parse(f.flow.storage.decryptString(Buffer.from(f.flow.read().answer, "base64"))).koin.state, "charged");
  }
});

test("streaming recovery preserves a verified prefix on lookup failure or a changed answer", async t => {
  for (const failure of ["lookup", "changed", "active"]) {
    const f = fixture(t), input = { ...f.input, stream: true }; let original;
    f.state.respond = async (action, body) => {
      if (action !== "chat") return;
      original = body;
      return f.stream(f.frame(await f.completion(body, "Saved", { partial: true })));
    };
    await assert.rejects(f.flow.chat(null, input, f.signal()), e => e.code === "credit-response-interrupted");
    const before = f.flow.read();
    f.state.result = await f.completion(original, failure === "changed" ? "Different" : "Saved", { partial: failure === "active" });
    if (failure === "lookup") f.state.respond = async action => { if (action === "result") throw Error("Read unavailable"); };
    if (failure === "active") assert.equal((await f.flow.chat(null, input, f.signal())).koin.state, "streaming");
    else await assert.rejects(f.flow.chat(null, input, f.signal()), failure === "lookup" ? /Read unavailable/ : /recovery prefix changed/);
    assert.equal(f.flow.read().id, before.id);
    assert.equal(JSON.parse(f.flow.storage.decryptString(Buffer.from(f.flow.read().answer, "base64"))).choices[0].message.content, "Saved");
    assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
    assert.equal(f.state.calls.some(c => c.action === "cancel"), false);
  }
});

test("HTML gateway failures expose HTTP status, preserve recovery and never authorize a retry", async t => {
  for (const status of [502, 503, 504, 524]) {
    const f = fixture(t);
    f.state.respond = async (action, body) => {
      if (action !== "chat") return;
      f.state.result = await f.completion(body, "Saved before disconnect");
      return new Response("<!DOCTYPE html><title>Private gateway details</title>", { status, headers: { "content-type": "text/html" } });
    };
    await assert.rejects(f.flow.chat(null, f.input, f.signal()), e => e.code === "credit-response-invalid" && e.status === status &&
      e.safeToRetry === false && e.message.includes("HTTP " + status) && !/DOCTYPE|Private gateway|Unexpected token/.test(e.message));
    const id = f.flow.read().id;
    assert.equal(f.flow.read().state, "pending");
    assert.equal((await f.flow.recover(null, f.signal())).completion.id, id);
    assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
  }
});

test("invalid JSON and primitive responses fail clearly before credit generation", async t => {
  for (const body of ["<!DOCTYPE html>", "{broken", "null", "[]"]) {
    const f = fixture(t); f.state.respond = async action => action === "models" ? new Response(body) : undefined;
    await assert.rejects(f.flow.chat(null, f.input, f.signal()), e => e.code === "credit-response-invalid" && e.safeToRetry === false);
    assert.equal(f.flow.read(), null); assert.equal(f.state.calls.some(c => c.action === "chat"), false);
  }
});

test("invalid signed stream content cannot be saved or delivered", async t => {
  const f = fixture(t);
  f.state.respond = async (action, body) => {
    if (action !== "chat") return;
    const bad = await f.completion(body, "Signed");
    bad.choices[0].message.content = "Tampered";
    return f.stream(f.frame(bad) + "data: [DONE]\n\n");
  };
  await assert.rejects(f.flow.chat(null, f.input, f.signal()), /could not be verified/);
  assert.equal(f.flow.read().state, "pending"); assert.equal(f.flow.read().answer, undefined);
  assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
});

test("fragmented keep-alive comments never become output, receipts or completion", async t => {
  const f = fixture(t);
  f.state.respond = async (action, body) => {
    if (action !== "chat") return;
    const final = await f.completion(body, "Ready");
    const text = ": kai-keepalive\n\n".repeat(4100) + f.frame(final) + ": still-here\n: comment\n\ndata: [DONE]\n\n";
    return new Response(new ReadableStream({ start(c) {
      const bytes = Buffer.from(text);
      for (let i = 0; i < bytes.length; i += 37) c.enqueue(bytes.subarray(i, i + 37));
      c.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  };
  const answer = await f.flow.chat(null, f.input, f.signal());
  assert.equal(answer.choices[0].message.content, "Ready");
  assert.equal(f.state.progress.some(p => typeof p === "object"), false);
  assert.equal(f.state.calls.some(c => c.action === "result"), false);
});

test("a real socket cutoff gives a recoverable connection error without starting a second generation", async t => {
  const f = fixture(t), http = require("node:http"); let socketResponse;
  const server = http.createServer((req, res) => {
    req.resume(); res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": kai-keepalive\n\n"); socketResponse = res;
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  f.state.respond = async action => {
    if (action !== "chat") return;
    const response = await fetch(`http://127.0.0.1:${server.address().port}`); socketResponse.destroy(); return response;
  };
  await assert.rejects(f.flow.chat(null, f.input, f.signal()), e => e.code === "credit-response-interrupted" && e.safeToRetry === false &&
    e.requestId === f.flow.read().id && /network connection closed/.test(e.message) && e.cause?.message === "terminated");
  assert.equal(f.flow.read().state, "pending");
  assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
  assert.equal(f.state.calls.filter(c => c.action === "result").length, 1);
  assert.equal(f.state.calls.filter(c => c.action === "cancel").length, 1);
});

test("a dropped body can recover a completed signed result with its original request ID", async t => {
  const f = fixture(t);
  f.state.respond = async (action, body) => {
    if (action !== "chat") return;
    f.state.result = await f.completion(body, "Recovered");
    return new Response(new ReadableStream({ start(c) { c.error(new TypeError("terminated")); } }), { headers: { "content-type": "text/event-stream" } });
  };
  const answer = await f.flow.chat(null, f.input, f.signal());
  assert.equal(answer.choices[0].message.content, "Recovered");
  assert.equal(f.state.calls.find(c => c.action === "result").body.requestId, answer.id);
  assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
  assert.equal(f.state.calls.some(c => c.action === "cancel"), false);
});

test("a saved final receipt survives a missing DONE marker without another remote result lookup", async t => {
  const f = fixture(t);
  f.state.respond = async (action, body) => action === "chat" ? f.stream(f.frame(await f.completion(body, "Finished"))) : undefined;
  assert.equal((await f.flow.chat(null, f.input, f.signal())).choices[0].message.content, "Finished");
  assert.equal(f.state.calls.some(c => c.action === "result"), false);
  assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
});

test("a disconnected signed prefix stays saved and cannot complete a workflow or authorize a fallback", async t => {
  const f = fixture(t);
  f.state.respond = async (action, body) => {
    if (action !== "chat") return;
    f.state.result = await f.completion(body, "Partial", { partial: true, charged: true });
    return f.stream(f.frame(await f.completion(body, "Partial", { partial: true })));
  };
  await assert.rejects(f.flow.chat(null, f.input, f.signal()), e => e.code === "credit-response-interrupted" && e.safeToRetry === false);
  const saved = f.flow.read(); assert.equal(saved.state, "answered");
  assert.equal(JSON.parse(f.flow.storage.decryptString(Buffer.from(saved.answer, "base64"))).choices[0].message.content, "Partial");
  assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
  assert.equal(f.state.calls.filter(c => c.action === "result").length, 1);
  assert.equal(f.state.calls.some(c => c.action === "acknowledge"), false);
});

test("keep-alives alone and a failed recovery lookup preserve the interrupted request", async t => {
  const f = fixture(t);
  f.state.respond = async action => {
    if (action === "chat") return f.stream(": kai-keepalive\n\n");
    if (action === "result") throw Error("Read unavailable");
  };
  await assert.rejects(f.flow.chat(null, f.input, f.signal()), e => e.code === "credit-response-interrupted" && e.safeToRetry === false);
  assert.equal(f.flow.read().state, "pending");
  assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
  assert.equal(f.state.calls.filter(c => c.action === "result").length, 1);
});

test("a forged recovery answer cannot replace a verified prefix", async t => {
  const f = fixture(t);
  f.state.respond = async (action, body) => {
    if (action !== "chat") return;
    f.state.result = await f.completion(body, "Original final");
    f.state.result.choices[0].message.content = "Forged";
    return f.stream(f.frame(await f.completion(body, "Original", { partial: true })));
  };
  await assert.rejects(f.flow.chat(null, f.input, f.signal()), /could not be verified/);
  assert.equal(JSON.parse(f.flow.storage.decryptString(Buffer.from(f.flow.read().answer, "base64"))).choices[0].message.content, "Original");
  assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
});

test("cancellation retains its original reason and does not perform automatic recovery", async t => {
  const f = fixture(t), controller = new AbortController(), reason = Error("User stopped the workflow");
  f.state.respond = async action => {
    if (action !== "chat") return;
    controller.abort(reason);
    return new Response(new ReadableStream({ start(c) { c.error(new TypeError("terminated")); } }), { headers: { "content-type": "text/event-stream" } });
  };
  await assert.rejects(f.flow.chat(null, f.input, controller.signal), e => e === reason);
  assert.equal(f.state.calls.some(c => c.action === "result"), false);
  assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
});

test("comments do not permit malformed data frames or bypass signed response validation", async t => {
  const f = fixture(t);
  f.state.respond = async action => action === "chat" ? f.stream(": heartbeat\ninvalid-field\n\n") : undefined;
  await assert.rejects(f.flow.chat(null, f.input, f.signal()), /Invalid credit stream frame/);
  assert.equal(f.flow.read().answer, undefined);
  assert.equal(f.state.calls.some(c => c.action === "result"), false);
});

test("a dropped catalog body fails clearly without submitting or recovering a chat", async t => {
  const f = fixture(t);
  f.state.respond = async action => action === "models" ? new Response(new ReadableStream({ start(c) { c.error(new TypeError("terminated")); } })) : undefined;
  await assert.rejects(f.flow.chat(null, f.input, f.signal()), e => e.code === "credit-response-interrupted" && /refreshing model availability/.test(e.message));
  assert.equal(f.flow.read(), null);
  assert.equal(f.state.calls.some(c => ["chat", "result"].includes(c.action)), false);
});

test("transient model checks retry the same read and then dispatch one generation", async t => {
  const f = fixture(t); let failures = 0;
  f.state.respond = async (action, body) => {
    if (action === "models" && failures++ < 2) return new Response("Bad gateway", { status: 502 });
    if (action === "chat") return f.stream(f.frame(await f.completion(body, "Success")) + "data: [DONE]\n\n");
  };
  const answer = await f.flow.chat(null, f.input, f.signal());
  assert.equal(answer.choices[0].message.content, "Success");
  assert.deepEqual(f.state.waits, [500, 1500]);
  assert.equal(f.state.calls.filter(c => c.action === "models").length, 3);
  assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
});

test("an outline price check can recover from a 502 without repeating the completed research", async t => {
  const f = fixture(t); let failOutline = true;
  f.state.respond = async (action, body) => {
    const outlining = body.messages?.[0]?.content === "Plan headings";
    if (action === "estimate" && outlining && failOutline) { failOutline = false; return new Response("Bad gateway", { status: 502 }); }
    if (action === "chat") return f.stream(f.frame(await f.completion(body, outlining ? "Outline" : "Research")) + "data: [DONE]\n\n");
  };
  assert.equal((await f.flow.chat(null, f.input, f.signal())).choices[0].message.content, "Research");
  const outline = await f.flow.chat(null, { ...f.input, messages: [{ role: "user", content: "Plan headings" }] }, f.signal());
  assert.equal(outline.choices[0].message.content, "Outline");
  assert.equal(f.state.calls.filter(c => c.action === "chat").length, 2);
  assert.equal(f.state.calls.filter(c => c.action === "estimate" && c.body.messages[0].content === "Plan headings").length, 2);
  assert.deepEqual(f.state.waits, [500]);
});

test("persistent gateway failures stop after three reads and identify the failed operation", async t => {
  for (const action of ["models", "network", "estimate", "capabilities", "status", "result"]) {
    const f = fixture(t), body = action === "result" ? { requestId: P.hash("saved-request") } : {};
    f.state.respond = async () => new Response("Private upstream failure", { status: 502 });
    await assert.rejects(f.flow.call(action, body, f.signal()), e => e.code === "credit-response-invalid" && e.status === 502 && e.action === action &&
      e.attempts === 3 && e.safeToRetry === false && /while /.test(e.message) && !e.message.includes("Private upstream"));
    assert.equal(f.state.calls.length, 3); assert.deepEqual(f.state.waits, [500, 1500]); assert.equal(f.flow.read(), null);
    assert.ok(f.state.calls.every(c => c.action === action && (!body.requestId || c.body.requestId === body.requestId)));
  }
});

test("no write operation is replayed when the gateway fails, including an uncertain generation", async t => {
  for (const action of ["chat", "purchase", "quote", "quote-usd", "run-open", "run-stop", "cancel", "acknowledge"]) {
    const f = fixture(t);
    f.state.respond = async () => new Response("Bad gateway", { status: 502 });
    await assert.rejects(f.flow.call(action, { requestId: P.hash("write") }, f.signal()), e => e.status === 502 && e.safeToRetry === false);
    assert.equal(f.state.calls.length, 1); assert.deepEqual(f.state.waits, []);
  }
});

test("network transport failures and truncated read bodies can retry but do not authorize model fallback", async t => {
  for (const kind of ["socket", "body", "json-502"]) {
    const f = fixture(t); let count = 0;
    f.state.respond = async action => {
      if (action !== "status" || count++ > 0) return;
      if (kind === "socket") throw new TypeError("fetch failed", { cause: Object.assign(Error("closed"), { code: "ECONNRESET" }) });
      if (kind === "body") return new Response(new ReadableStream({ start(c) { c.error(new TypeError("terminated")); } }));
      return Response.json(f.envelope({ ok: false, error: "Upstream unavailable" }), { status: 502 });
    };
    assert.equal((await f.flow.call("status", {}, f.signal())).ok, true);
    assert.equal(f.state.calls.length, 2); assert.deepEqual(f.state.waits, [500]);
    assert.equal(f.state.calls.some(c => c.action === "chat"), false);
  }
});

test("authorization, invalid identity, malformed 200 responses and application errors are not retried", async t => {
  for (const kind of ["unauthorized", "identity", "malformed", "application", "invalid-url"]) {
    const f = fixture(t);
    f.state.respond = async () => {
      if (kind === "invalid-url") throw Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL" });
      if (kind === "unauthorized") return Response.json({ error: "Expired" }, { status: 401 });
      if (kind === "identity") return Response.json({ ...f.envelope({}), owner: "another-owner" });
      if (kind === "malformed") return new Response("{broken");
      return Response.json(f.envelope({ ok: false, error: "Not enough credits" }), { status: 400 });
    };
    await assert.rejects(f.flow.call("status", {}, f.signal()));
    assert.equal(f.state.calls.length, 1); assert.deepEqual(f.state.waits, []);
  }
});

test("cancellation and revoked access during retry delay prevent any further read or generation", async t => {
  for (const revoke of [false, true]) {
    const f = fixture(t), controller = new AbortController(), reason = Error("Credit access revoked");
    f.state.respond = async () => new Response("Unavailable", { status: 503 });
    f.state.onWait = async () => { if (revoke) f.flow.access.authorize = () => { throw reason; }; else controller.abort(reason); };
    await assert.rejects(f.flow.call("models", {}, controller.signal), e => e === reason);
    assert.equal(f.state.calls.length, 1); assert.equal(f.flow.read(), null);
  }
});

test("each read attempt has a short deadline while generation retains its caller's deadline", async t => {
  const f = fixture(t); f.flow.readTimeoutMs = 10;
  f.state.respond = async (action, body, signal) => {
    if (action === "status") return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      if (signal.aborted) reject(signal.reason);
    });
    if (action === "chat") {
      await new Promise(resolve => setTimeout(resolve, 30)); signal.throwIfAborted();
      return f.stream(f.frame(await f.completion(body, "Done")) + "data: [DONE]\n\n");
    }
  };
  // The abort timeout itself is unref'ed; keep the fixture alive for the probe.
  const alive = setInterval(() => {}, 1000); t.after(() => clearInterval(alive));
  await assert.rejects(f.flow.call("status", {}, f.signal()), e => e.code === "credit-read-timeout" && e.attempts === 3 && e.action === "status");
  assert.equal(f.state.calls.filter(c => c.action === "status").length, 3);
  assert.equal((await f.flow.chat(null, f.input, f.signal())).choices[0].message.content, "Done");
  assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
});

test("retry delays respect Retry-After and do not retry early when the requested wait exceeds the bound", async t => {
  for (const seconds of [2, 60]) {
    const f = fixture(t); let count = 0;
    f.state.respond = async () => count++ === 0 ? new Response("Unavailable", { status: 503, headers: { "retry-after": String(seconds) } }) : undefined;
    if (seconds === 60) {
      await assert.rejects(f.flow.call("status", {}, f.signal()), e => e.status === 503 && e.attempts === 1 && e.retryAfterMs === 60000);
      assert.equal(f.state.calls.length, 1); assert.deepEqual(f.state.waits, []);
    } else {
      assert.equal((await f.flow.call("status", {}, f.signal())).ok, true);
      assert.equal(f.state.calls.length, 2); assert.deepEqual(f.state.waits, [2000]);
    }
  }
});

test("a retried saved-result lookup keeps the original request and verifies the final signed answer", async t => {
  const f = fixture(t); let reads = 0;
  f.state.respond = async (action, body) => {
    if (action === "result" && reads++ === 0) return new Response("Gateway unavailable", { status: 502 });
    if (action !== "chat") return;
    f.state.result = await f.completion(body, "Recovered");
    return f.stream(": kai-keepalive\n\n");
  };
  const answer = await f.flow.chat(null, f.input, f.signal());
  assert.equal(answer.choices[0].message.content, "Recovered");
  assert.equal(f.state.calls.filter(c => c.action === "chat").length, 1);
  assert.equal(f.state.calls.filter(c => c.action === "result").length, 2);
  assert.ok(f.state.calls.filter(c => c.action === "result").every(c => c.body.requestId === answer.id));
});
