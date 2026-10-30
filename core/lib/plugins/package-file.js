"use strict";
// This reader stages untrusted package bytes. It does not authenticate a
// publisher or execute package code. Call the metadata verifier before use.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { TextDecoder } = require("node:util");
const CHUNK_BYTES = 64 * 1024, METADATA_BYTES = 64 * 1024;

class Reader {
  constructor(fd, maxBytes) {
    this.fd = fd; this.maxBytes = maxBytes; this.buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    this.cursor = 0; this.length = 0; this.offset = 0; this.bytes = 0; this.limit = Infinity;
    this.hash = crypto.createHash("sha256"); this.ended = false;
  }
  peek() {
    if (this.cursor < this.length) return this.buffer[this.cursor];
    if (this.ended) return -1;
    this.length = fs.readSync(this.fd, this.buffer, 0, this.buffer.length, null); this.cursor = 0;
    if (!this.length) { this.ended = true; return -1; }
    this.bytes += this.length;
    if (this.bytes > this.maxBytes) throw Error("Plugin package exceeds 512 MB");
    this.hash.update(this.buffer.subarray(0, this.length));
    return this.buffer[0];
  }
  consume(count = 1) {
    this.cursor += count; this.offset += count;
    if (this.offset > this.limit) throw Error("Plugin metadata exceeds 64 KiB");
  }
  take() { const value = this.peek(); if (value === -1) throw Error("Unexpected end of plugin JSON"); this.consume(); return value; }
  expect(value) { if (this.take() !== value) throw Error("Invalid plugin JSON syntax"); }
  space() { while ([32, 9, 10, 13].includes(this.peek())) this.consume(); }
  bounded(fn, bytes = METADATA_BYTES) {
    const previous = this.limit; this.limit = Math.min(previous, this.offset + bytes);
    try { return fn(); } finally { this.limit = previous; }
  }
}

// Decode a JSON string without collecting its value. Raw UTF-8 is decoded
// strictly and incrementally; escaped UTF-16 code units retain JSON semantics.
function string(reader, emit) {
  reader.expect(34);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const flush = () => { const text = decoder.decode(); if (text) emit(text); };
  for (;;) {
    const byte = reader.peek();
    if (byte === -1) throw Error("Unterminated plugin JSON string");
    if (byte === 34) { reader.consume(); flush(); return; }
    if (byte === 92) {
      flush(); reader.consume(); const escape = reader.take();
      const escapes = { 34: '"', 92: "\\", 47: "/", 98: "\b", 102: "\f", 110: "\n", 114: "\r", 116: "\t" };
      if (Object.hasOwn(escapes, escape)) emit(escapes[escape]);
      else if (escape === 117) {
        let value = 0;
        for (let i = 0; i < 4; i++) {
          const digit = reader.take(), number = digit >= 48 && digit <= 57 ? digit - 48 : digit >= 65 && digit <= 70 ? digit - 55 : digit >= 97 && digit <= 102 ? digit - 87 : -1;
          if (number < 0) throw Error("Invalid plugin JSON Unicode escape");
          value = value * 16 + number;
        }
        emit(String.fromCharCode(value));
      } else throw Error("Invalid plugin JSON escape");
      continue;
    }
    if (byte < 32) throw Error("Unescaped control character in plugin JSON string");
    const start = reader.cursor;
    let end = start;
    while (end < reader.length && reader.buffer[end] >= 32 && reader.buffer[end] !== 34 && reader.buffer[end] !== 92) end++;
    reader.consume(end - start);
    const text = decoder.decode(reader.buffer.subarray(start, end), { stream: true });
    if (text) emit(text);
  }
}
function smallString(reader) {
  const parts = []; let length = 0;
  string(reader, text => { length += text.length; if (length > METADATA_BYTES) throw Error("Plugin metadata exceeds 64 KiB"); parts.push(text); });
  return parts.join("");
}
function value(reader, depth = 0) {
  if (depth > 64) throw Error("Plugin metadata is nested too deeply");
  reader.space(); const byte = reader.peek();
  if (byte === 34) return smallString(reader);
  if (byte === 123) {
    reader.consume(); reader.space(); const result = {}, seen = new Set();
    if (reader.peek() === 125) { reader.consume(); return result; }
    for (;;) {
      const name = smallString(reader);
      if (seen.has(name)) throw Error("Duplicate plugin JSON key"); seen.add(name);
      reader.space(); reader.expect(58);
      Object.defineProperty(result, name, { value: value(reader, depth + 1), enumerable: true, writable: true, configurable: true });
      reader.space(); const separator = reader.take();
      if (separator === 125) return result;
      if (separator !== 44) throw Error("Invalid plugin JSON object");
      reader.space();
    }
  }
  if (byte === 91) {
    reader.consume(); reader.space(); const result = [];
    if (reader.peek() === 93) { reader.consume(); return result; }
    for (;;) {
      result.push(value(reader, depth + 1)); reader.space(); const separator = reader.take();
      if (separator === 93) return result;
      if (separator !== 44) throw Error("Invalid plugin JSON array");
    }
  }
  for (const [token, result] of [["true", true], ["false", false], ["null", null]]) {
    if (byte === token.charCodeAt(0)) { for (const char of token) reader.expect(char.charCodeAt(0)); return result; }
  }
  let number = "";
  while (reader.peek() !== -1 && ![32, 9, 10, 13, 44, 93, 125].includes(reader.peek())) number += String.fromCharCode(reader.take());
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(number) || !Number.isFinite(Number(number))) throw Error("Invalid plugin JSON value");
  return Number(number);
}

function outputSink(fd, encoding) {
  const hash = crypto.createHash("sha256"); let bytes = 0, pendingHigh = "", carry = "", padded = false, encoded = 0;
  const pending = fd === null ? null : Buffer.allocUnsafe(CHUNK_BYTES); let pendingBytes = 0;
  const flush = () => { let offset = 0; while (offset < pendingBytes) offset += fs.writeSync(fd, pending, offset, pendingBytes - offset); pendingBytes = 0; };
  const write = buffer => {
    if (!buffer.length) return; hash.update(buffer); bytes += buffer.length;
    if (fd !== null) {
      let offset = 0;
      while (offset < buffer.length) {
        const copied = Math.min(pending.length - pendingBytes, buffer.length - offset);
        buffer.copy(pending, pendingBytes, offset, offset + copied); offset += copied; pendingBytes += copied;
        if (pendingBytes === pending.length) flush();
      }
    }
  };
  function utf8(text) {
    text = pendingHigh + text; pendingHigh = "";
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) { pendingHigh = text.slice(-1); text = text.slice(0, -1); }
    if (text) write(Buffer.from(text, "utf8"));
  }
  function base64(text) {
    if (!text) return;
    if (padded || /[^A-Za-z0-9+/=]/.test(text)) throw Error("Binary plugin assets must use canonical base64");
    encoded += text.length; const combined = carry + text, completeLength = combined.length - combined.length % 4;
    const complete = combined.slice(0, completeLength); carry = combined.slice(completeLength);
    const firstPadding = complete.indexOf("=");
    if (firstPadding !== -1) {
      const quad = complete.slice(-4), padding = quad.endsWith("==") ? 2 : 1;
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      if (firstPadding < complete.length - 2 || carry || !/^(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(quad) || (alphabet.indexOf(quad[3 - padding]) & (padding === 2 ? 15 : 3))) throw Error("Binary plugin assets must use canonical base64");
      padded = true;
    }
    if (complete) write(Buffer.from(complete, "base64"));
  }
  return {
    push: encoding === "base64" ? base64 : utf8,
    finish() {
      if (encoding === "base64") { if (!encoded || carry) throw Error("Binary plugin assets must use canonical base64"); }
      else if (pendingHigh) write(Buffer.from(pendingHigh, "utf8"));
      if (pendingBytes) flush();
      return { encoding, bytes, sha256: hash.digest("hex") };
    }
  };
}

function readPackageFile(file, { directory = os.tmpdir(), extract = true, allowUnsigned = false } = {}) {
  const { safeFile, BINARY, MAX_BYTES, MAX_FILES } = require("./package");
  if (typeof file !== "string" || typeof directory !== "string" || typeof extract !== "boolean" || typeof allowUnsigned !== "boolean") throw Error("Invalid plugin package file options");
  const sourceFile = path.resolve(file), sourceStat = fs.lstatSync(sourceFile);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw Error("Plugin package source must be a regular file");
  if (sourceStat.size > MAX_BYTES) throw Error("Plugin package exceeds 512 MB");
  const parent = fs.realpathSync(directory);
  if (!fs.statSync(parent).isDirectory()) throw Error("Plugin staging parent must be a directory");
  let fd = null, root = null, rootStat = null, disposed = false;
  function dispose() {
    if (disposed || !root) return;
    let current;
    try { current = fs.lstatSync(root); } catch (error) { if (error.code === "ENOENT") { disposed = true; return; } throw error; }
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== rootStat.dev || current.ino !== rootStat.ino) throw Error("Plugin staging directory identity changed; refusing cleanup");
    fs.rmSync(root, { recursive: true, force: true }); disposed = true;
  }
  try {
    fd = fs.openSync(sourceFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== sourceStat.dev || opened.ino !== sourceStat.ino || opened.size !== sourceStat.size) throw Error("Plugin package source changed before reading");
    root = fs.mkdtempSync(path.join(parent, "kai-plugin-candidate-")); rootStat = fs.lstatSync(root); fs.chmodSync(root, 0o700);
    const reader = new Reader(fd, MAX_BYTES), entries = [], fields = new Set(), paths = new Set();
    let manifest, publicKey, signature;
    function acceptPath(name) {
      if (!safeFile(name)) throw Error("Invalid plugin file path");
      const lower = name.toLowerCase();
      if (paths.has(lower)) throw Error("Duplicate or aliased plugin file paths");
      paths.add(lower);
      const parts = lower.split("/"); parts.pop();
      while (parts.length) { if (paths.has(parts.join("/"))) throw Error("Conflicting plugin file paths"); parts.pop(); }
    }
    function validatePaths() {
      // Keep only complete paths in memory. Retaining every directory prefix
      // would multiply a small malicious manifest into millions of objects.
      const sorted = entries.map(entry => entry.path).sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
      let previous = [];
      for (const name of sorted) {
        const parts = name.split("/"), ancestors = name.toLowerCase().split("/"); ancestors.pop();
        while (ancestors.length) { if (paths.has(ancestors.join("/"))) throw Error("Conflicting plugin file paths"); ancestors.pop(); }
        for (let i = 0; i < Math.min(parts.length, previous.length) && parts[i].toLowerCase() === previous[i].toLowerCase(); i++) {
          if (parts[i] !== previous[i]) throw Error("Aliased plugin directory paths");
        }
        previous = parts;
      }
    }
    function files() {
      reader.space(); reader.expect(123); reader.space();
      if (reader.peek() === 125) throw Error("Plugin package has no files");
      for (;;) {
        if (entries.length >= MAX_FILES) throw Error("Plugin package has too many files");
        const name = reader.bounded(() => smallString(reader)); acceptPath(name);
        reader.space(); reader.expect(58); reader.space();
        const target = path.join(root, ...name.split("/")); let output = null;
        try {
          if (extract) {
            try { fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); output = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600); }
            catch (error) { throw Error("Cannot stage plugin file path: " + name, { cause: error }); }
          }
          const sink = outputSink(output, BINARY.test(name) ? "base64" : "utf8"); string(reader, sink.push); entries.push({ path: name, ...sink.finish() });
        } finally { if (output !== null) fs.closeSync(output); }
        reader.space(); const separator = reader.take();
        if (separator === 125) return;
        if (separator !== 44) throw Error("Invalid plugin files object");
        reader.space();
      }
    }
    reader.space(); reader.expect(123); reader.space();
    for (;;) {
      const name = reader.bounded(() => smallString(reader));
      if (!["manifest", "files", "publicKey", "signature"].includes(name)) throw Error("Unknown plugin package field");
      if (fields.has(name)) throw Error("Duplicate plugin package field"); fields.add(name);
      reader.space(); reader.expect(58); reader.space();
      if (name === "files") files();
      else {
        const parsed = reader.bounded(() => value(reader));
        if (name === "manifest") { if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error("Invalid plugin manifest object"); manifest = parsed; }
        else { if (typeof parsed !== "string") throw Error("Invalid publisher signature metadata"); if (name === "publicKey") publicKey = parsed; else signature = parsed; }
      }
      reader.space(); const separator = reader.take();
      if (separator === 125) break;
      if (separator !== 44) throw Error("Invalid plugin package object");
      reader.space();
    }
    const complete = fields.size === 4 || (allowUnsigned && fields.size === 2 && fields.has("manifest") && fields.has("files"));
    reader.space(); if (reader.peek() !== -1 || !complete) throw Error("Invalid plugin package fields or trailing data");
    validatePaths();
    const ended = fs.fstatSync(fd), named = fs.lstatSync(sourceFile);
    if (ended.size !== opened.size || ended.mtimeMs !== opened.mtimeMs || ended.ctimeMs !== opened.ctimeMs || named.dev !== opened.dev || named.ino !== opened.ino || named.isSymbolicLink()) throw Error("Plugin package source changed while reading");
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { manifest, publicKey, signature, entries, sourceFile, sourceDigest: reader.hash.digest("hex"), sourceBytes: reader.bytes, root, dispose };
  } catch (error) {
    try { dispose(); } catch (cleanup) { error.cause = cleanup; }
    throw error;
  } finally { if (fd !== null) fs.closeSync(fd); }
}

module.exports = { readPackageFile };
