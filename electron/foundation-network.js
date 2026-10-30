"use strict";
const { Readable } = require("node:stream");
const REQUEST_LIMIT = 16 * 1024 * 1024, RESPONSE_LIMIT = 32 * 1024 * 1024;
function checkedHeaders(input) {
  const headers = new Headers(input || {});
  for (const name of ["host", "connection", "content-length", "transfer-encoding", "upgrade", "proxy-authorization"]) if (headers.has(name)) throw Error(`Plugin request cannot set ${name}`);
  return Object.fromEntries(headers);
}
async function* requestChunks(body, signal, limit = REQUEST_LIMIT) {
  if (body === undefined || body === null) return;
  let source;
  if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array || body instanceof ArrayBuffer) source = [body instanceof ArrayBuffer ? new Uint8Array(body) : body];
  else if (typeof body?.[Symbol.asyncIterator] === "function") source = body;
  else if (typeof body?.getReader === "function") source = Readable.fromWeb(body);
  else throw Error("Request body must be text, bytes or a byte stream");
  let size = 0;
  for await (const chunk of source) {
    signal.throwIfAborted();
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw Error("Request stream must contain text or bytes");
    const bytes = Buffer.from(chunk); size += bytes.length; if (size > limit) throw Error("Network request exceeds 16 MB"); yield bytes;
  }
}
function pinnedRequest(url, { addresses, method = "GET", headers, body, signal, requestImpl } = {}) {
  signal.throwIfAborted();
  const request = requestImpl || require("node:https").request;
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: checkedHeaders(headers), signal, agent: false,
      lookup: (_hostname, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family) }, res => {
      try {
        let stream = res;
        const encoding = String(res.headers["content-encoding"] || "identity").toLowerCase();
        const outputHeaders = new Headers(Object.entries(res.headers).filter(([,v]) => v !== undefined).map(([k,v]) => [k, Array.isArray(v) ? v.join(", ") : v]));
        if (encoding !== "identity") {
          const zlib = require("node:zlib"), decoder = { gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress }[encoding];
          if (!decoder) throw Error("Unsupported response compression");
          stream = decoder(); require("node:stream/promises").pipeline(res, stream).catch(error => stream.destroy(error));
          outputHeaders.delete("content-encoding"); outputHeaders.delete("content-length");
        }
        resolve({ status: res.statusCode, headers: outputHeaders, body: Readable.toWeb(stream) });
      } catch (error) { res.destroy(); reject(error); }
    });
    req.on("error", reject);
    void (async () => {
      for await (const bytes of requestChunks(body, signal)) {
        if (!req.write(bytes)) await new Promise((done, fail) => {
          const cleanup = () => { req.removeListener("drain", drained); req.removeListener("error", failed); req.removeListener("close", closed); };
          const drained = () => { cleanup(); done(); }, failed = error => { cleanup(); fail(error); }, closed = () => { cleanup(); fail(Error("Request closed during upload")); };
          req.once("drain", drained); req.once("error", failed); req.once("close", closed);
        });
      }
      signal.throwIfAborted(); req.end();
    })().catch(error => { req.destroy(error); reject(error); });
  });
}
function boundedResponse(response, { signal, active = () => {}, release = () => {}, limit = RESPONSE_LIMIT } = {}) {
  signal.throwIfAborted(); active();
  let released = false, reader, controller, bytes = 0;
  const finish = () => { if (released) return; released = true; signal.removeEventListener("abort", abort); release(); };
  const abort = () => { void reader?.cancel(signal.reason).catch(() => {}); try { controller?.error(signal.reason || Error("Network request stopped")); } catch {} finish(); };
  if (!response.body || [204, 205, 304].includes(response.status)) { void response.body?.cancel().catch(() => {}); finish(); return new Response(null, { status: response.status, headers: response.headers }); }
  reader = response.body.getReader();
  const stream = new ReadableStream({
    start(target) { controller = target; signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); },
    async pull(target) {
      try {
        signal.throwIfAborted(); active(); const value = await reader.read(); signal.throwIfAborted(); active();
        if (value.done) { target.close(); finish(); return; }
        bytes += value.value.byteLength; if (bytes > limit) throw Error("Network response exceeds its byte limit"); target.enqueue(value.value);
      } catch (error) { await reader.cancel(error).catch(() => {}); finish(); try { target.error(error); } catch {} }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { finish(); } },
  });
  return new Response(stream, { status: response.status, headers: response.headers });
}
module.exports = { pinnedRequest, boundedResponse, requestChunks, checkedHeaders, REQUEST_LIMIT, RESPONSE_LIMIT };
