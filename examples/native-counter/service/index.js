"use strict";
// Native extensions run with full Electron/Node authority. This example uses
// only documented APIs and has no dependencies beyond Foundation.
function create(api) {
  if (api.version !== 1) throw Error("Example Counter requires Foundation API v1");
  let closed = false, removeService;
  const active = signal => { api.signal.throwIfAborted(); signal?.throwIfAborted(); if (closed) throw Error("Counter is closed"); };
  const read = () => {
    const count = api.settings.get("count", 0);
    if (!Number.isSafeInteger(count) || count < 0) throw Error("Saved counter is invalid; it was preserved");
    return { count };
  };
  function dispose() { if (closed) return; closed = true; removeService?.(); api.signal.removeEventListener("abort", dispose); }
  try {
    active(); read();
    removeService = api.services.provide("example.counter", {
      methods: ["read"],
      call(method, _input, context) {
        active(context.signal);
        if (context.remote || method !== "read") throw Error("Only local counter reads are available");
        return read();
      }
    });
    api.signal.addEventListener("abort", dispose, { once: true });
    return {
      call(method, _input, signal) {
        active(signal);
        if (method === "counter.read") return read();
        if (method === "counter.increment") {
          const next = read().count + 1;
          if (!Number.isSafeInteger(next)) throw Error("Counter limit reached");
          active(signal); api.settings.set("count", next); return { count: next };
        }
        throw Error("Unknown counter operation");
      },
      // Optional background work must resume only an explicit user opt-in.
      startBackground() { active(); },
      dispose
    };
  } catch (error) { dispose(); throw error; }
}
module.exports = { create };
