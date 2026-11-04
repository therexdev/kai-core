"use strict";

const MIN_CONTEXT = 2048, MAX_CONTEXT = 262144, FALLBACK_CONTEXT = 4096;
const valid = value => Number.isSafeInteger(value) && value >= MIN_CONTEXT && value <= MAX_CONTEXT;

function contextSettings(model, override) {
  const known = valid(model.contextSize) && !model.contextUnknown;
  const defaultContextSize = valid(model.contextSize) ? model.contextSize : FALLBACK_CONTEXT;
  const maxContextSize = known ? defaultContextSize : MAX_CONTEXT;
  // Catalog providers must retain at least the existing 4K network capacity.
  const minContextSize = Math.min(FALLBACK_CONTEXT, defaultContextSize);
  const contextOverride = valid(override) && override >= minContextSize && override <= maxContextSize ? override : null;
  return { contextSize: contextOverride ?? defaultContextSize, defaultContextSize, minContextSize, maxContextSize, contextOverride, contextLimitKnown: known };
}

// Read only a bounded header, never the weights. GGUF v2/v3 metadata normally
// places architecture/context before the tokenizer. Unknown/truncated metadata
// keeps the conservative fallback; it never invents a model's supported limit.
function ggufContext(buffer) {
  try {
    let offset = 0;
    const take = size => { if (!Number.isSafeInteger(size) || size < 0 || offset + size > buffer.length) throw Error("Incomplete GGUF header"); const start = offset; offset += size; return start; };
    const u32 = () => buffer.readUInt32LE(take(4));
    const u64 = () => { const value = buffer.readBigUInt64LE(take(8)); if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("Invalid metadata length"); return Number(value); };
    const string = () => { const length = u64(); return buffer.toString("utf8", take(length), offset); };
    if (u32() !== 0x46554747 || ![2, 3].includes(u32())) return null;
    u64(); const count = u64(); if (count > 100000) return null;
    const sizes = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
    const skip = type => {
      if (type === 8) { take(u64()); return; }
      if (type === 9) {
        const item = u32(), length = u64();
        if (item === 8) { if (length > 1000000) throw Error("Invalid metadata array"); for (let i = 0; i < length; i++) take(u64()); }
        else { if (!sizes[item]) throw Error("Invalid metadata type"); take(length * sizes[item]); }
        return;
      }
      if (!sizes[type]) throw Error("Invalid metadata type"); take(sizes[type]);
    };
    let architecture; const contexts = new Map();
    for (let i = 0; i < count; i++) {
      const key = string(), type = u32();
      if (key === "general.architecture" && type === 8) architecture = string();
      else if (key.endsWith(".context_length") && type === 4) contexts.set(key, u32());
      else skip(type);
      const value = contexts.get(`${architecture}.context_length`);
      if (valid(value)) return value;
    }
  } catch { /* malformed or metadata outside the bounded header */ }
  return null;
}

async function readGgufContext(file) {
  let handle;
  try {
    handle = await require("node:fs/promises").open(file, "r");
    const buffer = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return ggufContext(buffer.subarray(0, bytesRead));
  } catch { return null; }
  finally { await handle?.close(); }
}

module.exports = { MIN_CONTEXT, MAX_CONTEXT, FALLBACK_CONTEXT, contextSettings, ggufContext, readGgufContext };
