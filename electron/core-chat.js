"use strict";

const MAX_INPUT_BYTES = 24000, MAX_OUTPUT_BYTES = 1024 * 1024;

function chatInput(input, models) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["model", "messages", "maxTokens"].includes(key))) throw Error("Invalid chat request");
  if (typeof input.model !== "string" || !models.some(model => model.alias === input.model && model.status === "ready") || /^(?:koinos-network|desktop:)/.test(input.model)) throw Error("Choose an installed local model in Models");
  const maxTokens = input.maxTokens ?? 1024;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) throw Error("Invalid chat output limit");
  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 32 || input.messages.length % 2 !== 1) throw Error("Invalid chat history");
  const messages = input.messages.map((message, index) => {
    if (!message || typeof message !== "object" || Array.isArray(message) || Object.keys(message).some(key => !["role", "content"].includes(key)) || message.role !== (index % 2 ? "assistant" : "user") || typeof message.content !== "string" || !message.content.trim()) throw Error("Chat accepts only user and assistant text");
    return { role: message.role, content: message.content };
  });
  if (Buffer.byteLength(JSON.stringify(messages)) > MAX_INPUT_BYTES) throw Error("Chat history is too long. Start a new chat or send a shorter message.");
  return { model: input.model, messages, maxTokens };
}

async function readResult(response, signal) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_OUTPUT_BYTES) { await response.body?.cancel(); throw Error("Local model reply is too large"); }
  if (!response.body) throw Error("Local model returned no reply");
  const reader = response.body.getReader();
  let bytes = 0; const chunks = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) throw Error("Local model reply is too large");
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Error("Local model returned an invalid reply"); }
}

class CoreChat {
  constructor({ core, fetchImpl = globalThis.fetch }) { this.core = core; this.fetch = fetchImpl; this.active = null; this.disposed = false; }
  send(input) {
    if (this.disposed) return Promise.reject(Error("Chat is closing"));
    if (this.active) return Promise.reject(Error("Wait for this reply or stop it before sending another message"));
    let request;
    try { request = chatInput(input, this.core.models.aliases()); }
    catch (error) { return Promise.reject(error); }
    const controller = new AbortController(), active = { controller };
    this.active = active;
    active.promise = this.run(request, controller.signal).finally(() => { if (this.active === active) this.active = null; });
    return active.promise;
  }
  async run(request, cancellation) {
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(180000)]);
    try {
      const response = await this.fetch(`http://127.0.0.1:${this.core.gateway.port}/core/chat/completions`, {
        method: "POST", redirect: "error", signal, headers: { "content-type": "application/json", ...(process.env.KAI_CORE_TOKEN ? { authorization: `Bearer ${process.env.KAI_CORE_TOKEN}` } : {}) },
        // This gateway flag forbids network overflow even if the local model fails.
        body: JSON.stringify({ model: request.model, messages: request.messages, max_tokens: request.maxTokens, stream: false, kai_private_desktop: true }),
      });
      signal.throwIfAborted();
      const result = await readResult(response, signal);
      signal.throwIfAborted();
      if (!response.ok) throw Error(typeof result?.error?.message === "string" ? result.error.message.slice(0, 1000) : "Local model could not reply");
      const text = result?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) throw Error("Local model returned no text");
      return { text };
    } catch (error) {
      if (cancellation.aborted) throw Error("Chat stopped");
      if (signal.aborted) throw Error("The local model took too long. Try a smaller model or a shorter message.");
      throw error;
    }
  }
  async stop() {
    const active = this.active;
    active?.controller.abort();
    await active?.promise.catch(() => {});
    return { stopped: !!active };
  }
  async dispose() { this.disposed = true; await this.stop(); }
}

module.exports = { CoreChat, chatInput, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES };
