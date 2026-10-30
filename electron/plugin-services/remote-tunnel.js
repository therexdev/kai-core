"use strict";
const crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const RELAY = "https://koinosai.com";
const LIMIT = 96 * 1024;

async function readJson(response, maxBytes = LIMIT) {
  if (Number(response.headers.get("content-length")) > maxBytes) { await response.body?.cancel(); throw Error("Relay response exceeds the limit"); }
  let size = 0, chunks = [];
  for await (const chunk of response.body || []) { size += chunk.length; if (size > maxBytes) throw Error("Relay response exceeds the limit"); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function chatInput(value, models) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !["model", "messages", "max_tokens", "max_completion_tokens", "stream", "temperature", "top_p", "user"].includes(k))) throw Error("Use text chat without tools or attachments");
  if (typeof value.model !== "string" || !models.some(m => m.alias === value.model)) throw Error("Choose an installed local model");
  if (!Array.isArray(value.messages) || !value.messages.length || value.messages.length > 32) throw Error("Use between one and 32 text messages");
  const parts = value.messages.map(m => {
    if (!m || typeof m !== "object" || Object.keys(m).some(k => !["role", "content"].includes(k)) || !["system", "developer", "user", "assistant"].includes(m.role) || typeof m.content !== "string") throw Error("Only text messages are supported");
    return `${m.role}: ${m.content}`;
  });
  const prompt = parts.join("\n\n") + "\n\nassistant:";
  if (prompt.length > 16000) throw Error("Text exceeds 16,000 characters");
  const maxTokens = value.max_completion_tokens ?? value.max_tokens ?? 1024;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) throw Error("Output limit must be between one and 4,096 tokens");
  if (value.stream !== undefined && typeof value.stream !== "boolean") throw Error("stream must be a boolean");
  return { model: value.model, prompt, maxTokens, stream: value.stream === true };
}
function failure(status, message) { return { status, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { message, type: "remote_access_error" } }) }; }

// This relay client never forwards a URL or caller headers to the local gateway.
// The only remotely callable operations are installed-model listing and bounded
// text inference through the same private local-inference broker as plugins.
class RemoteTunnel {
  constructor({ token, verify, models, infer, allowed, fetchImpl = fetch, relayUrl = RELAY, backoffMs = 5000 }) {
    Object.assign(this, { token, verify, models, infer, allowed, fetchImpl, relayUrl, backoffMs });
    this.controller = null; this.tasks = []; this.state = "off"; this.base = null; this.tunnelId = null;
    this.served = 0; this.rejected = 0; this.seen = new Set(); this.rates = new Map(); this.inflight = new Set();
  }
  status() { return { enabled: !!this.controller, state: this.state, base: this.base, tunnelId: this.tunnelId, counts: { served: this.served, rejected: this.rejected } }; }
  active(signal) { signal?.throwIfAborted(); if (!this.allowed()) throw Error("Remote access is unavailable in the current privacy mode"); }
  async request(route, options, controller, timeout = 35000) {
    this.active(controller.signal);
    return this.fetchImpl(this.relayUrl + route, { ...options, redirect: "error", headers: { ...(options?.headers || {}), authorization: `Bearer ${this.token}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]) });
  }
  async start() {
    if (this.controller) return this.status(); this.active();
    const controller = this.controller = new AbortController(); this.state = "connecting";
    this.tasks = [this.hello(controller).catch(() => {}), ...Array.from({ length: 2 }, () => this.loop(controller))];
    return this.status();
  }
  async stop() {
    const controller = this.controller; this.controller = null; this.state = "off"; this.base = null; this.tunnelId = null;
    controller?.abort(); for (const pending of this.inflight) pending.abort();
    const tasks = this.tasks; this.tasks = []; await Promise.allSettled(tasks);
  }
  async hello(controller) {
    const response = await this.request("/relay/hello", { method: "POST" }, controller, 10000);
    const data = await readJson(response, 8192); this.active(controller.signal);
    if (!response.ok || data.ok !== true || typeof data.tunnelId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(data.tunnelId)) throw Error("Invalid relay handshake");
    const expected = `${this.relayUrl}/r/${data.tunnelId}/v1`;
    if (data.base !== expected) throw Error("Unexpected remote endpoint");
    if (this.controller === controller) { this.base = expected; this.tunnelId = data.tunnelId; this.state = "connected"; }
  }
  async loop(controller) {
    let backoff = this.backoffMs;
    while (this.controller === controller && !controller.signal.aborted) {
      try {
        this.active(controller.signal);
        const response = await this.request("/relay/poll", {}, controller);
        if (response.status === 204) { await response.body?.cancel(); this.active(controller.signal); backoff = this.backoffMs; await delay(100,undefined,{signal:controller.signal}); continue; }
        if (response.status !== 200) { await response.body?.cancel(); throw Error("Relay unavailable"); }
        const data = await readJson(response); this.active(controller.signal);
        if (!this.base) await this.hello(controller);
        if (this.controller !== controller) break; this.state = "connected"; backoff = this.backoffMs;
        if (data.job) await this.handle(data.job, controller); else await delay(100,undefined,{signal:controller.signal});
      } catch {
        if (this.controller !== controller || controller.signal.aborted) break;
        if (!this.allowed()) { controller.abort(); this.state = "off"; break; }
        this.state = "offline";
        await delay(backoff, undefined, { signal: controller.signal }).catch(() => {});
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }
  async evaluate(job, signal) {
    this.active(signal);
    if (!job || !["GET", "POST"].includes(job.method) || typeof job.path !== "string" || !((job.method === "GET" && job.path === "/v1/models") || (job.method === "POST" && job.path === "/v1/chat/completions"))) return failure(404, "This remote endpoint is not available");
    const auth = job.headers?.authorization;
    if (typeof auth !== "string" || auth.length > 256 || !/^Bearer [A-Za-z0-9_-]+$/.test(auth)) return failure(401, "A valid remote API key is required");
    const key = this.verify(auth.slice(7));
    if (!key) return failure(401, "A valid remote API key is required");
    const now = Date.now(), times = (this.rates.get(key.id) || []).filter(t => now - t < 60000);
    if (times.length >= 30) return failure(429, "Remote API key limit: 30 requests per minute");
    times.push(now); this.rates.set(key.id, times);
    const models = this.models();
    if (job.method === "GET") return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ object: "list", data: models.map(m => ({ id: m.alias, object: "model", owned_by: "local" })) }) };
    let input;
    try {
      if (typeof job.body !== "string" || job.body.length > 88000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(job.body)) throw Error("Invalid request body");
      const text = Buffer.from(job.body, "base64"); if (text.length > 65536) throw Error("Request body exceeds 64 KB");
      input = chatInput(JSON.parse(text.toString("utf8")), models);
    } catch (error) { return failure(400, error instanceof SyntaxError ? "Invalid request JSON" : error.message); }
    const pending = new AbortController(); this.inflight.add(pending);
    try {
      const combined = AbortSignal.any([signal, pending.signal, AbortSignal.timeout(180000)]);
      const result = await this.infer({ model: input.model, prompt: input.prompt, maxTokens: input.maxTokens }, combined);
      this.active(combined); if (!this.verify(auth.slice(7))) return failure(401, "Remote API key was revoked");
      if (typeof result?.text !== "string" || result.text.length > 1000000) throw Error("Invalid local response");
      const common = { id: `chatcmpl-${crypto.randomBytes(12).toString("hex")}`, created: Math.floor(Date.now() / 1000), model: input.model };
      if (input.stream) {
        const chunk = { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: result.text }, finish_reason: null }] };
        const done = { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
        return { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store" }, body: `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n` };
      }
      return { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ ...common, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }] }) };
    } catch { return failure(503, "Local inference stopped or is unavailable. Retry with an installed model."); }
    finally { this.inflight.delete(pending); }
  }
  async handle(job, controller) {
    if (typeof job?.reqId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(job.reqId) || this.seen.has(job.reqId)) return;
    this.seen.add(job.reqId); if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value);
    let answer;
    try { answer = await this.evaluate(job, controller.signal); } catch { answer = failure(503, "Remote access is unavailable"); }
    if (answer.status === 200) this.served++; else this.rejected++;
    this.active(controller.signal);
    const response = await this.request(`/relay/respond/${job.reqId}`, { method: "POST", headers: { "x-kai-status": String(answer.status), "x-kai-headers": Buffer.from(JSON.stringify(answer.headers)).toString("base64") }, body: answer.body }, controller, 15000);
    await response.body?.cancel();
    if (!response.ok) throw Error("Relay did not accept the result");
  }
}
module.exports = { RemoteTunnel, RELAY, readJson, chatInput };
