"use strict";
// Shared public-network transport. Search and research belong to plugins.
const net = require("node:net"), dns = require("node:dns").promises;

/** True when a resolved IP belongs to something that is not the public internet. */
function isPrivateAddress(addr) {
  const ip = String(addr || "").toLowerCase();
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||                        // this network
      a === 10 ||                       // RFC1918
      a === 127 ||                      // loopback
      (a === 169 && b === 254) ||       // link-local, incl. 169.254.169.254 metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 192 && b === 0) ||         // IETF protocol assignments + TEST-NET-1
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      (a === 198 && b === 51) ||        // TEST-NET-2
      (a === 203 && b === 0) ||         // TEST-NET-3
      a >= 224                          // multicast, reserved, broadcast
    );
  }
  if (net.isIPv6(ip)) {
    // Compare bytes, never spelling. ::ffff:127.0.0.1 and ::ffff:7f00:1 are
    // the same address, and the URL parser hands back whichever it likes.
    const b = ipv6Bytes(ip);
    if (!b) return true; // cannot parse it, so cannot vouch for it
    const zeros = (from, to) => b.slice(from, to).every((x) => x === 0);
    if (zeros(0, 16)) return true;                              // ::
    if (zeros(0, 15) && b[15] === 1) return true;               // ::1
    if ((b[0] & 0xfe) === 0xfc) return true;                    // fc00::/7 unique-local
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;   // fe80::/10 link-local
    if (b[0] === 0xff) return true;                             // multicast
    // Addresses that carry an IPv4 inside them are that IPv4.
    const embedded = () => isPrivateAddress(b.slice(12, 16).join("."));
    if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return embedded();     // ::ffff:0:0/96
    if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return embedded(); // NAT64
    if (b[0] === 0x20 && b[1] === 0x02) return isPrivateAddress(b.slice(2, 6).join(".")); // 6to4
    return false;
  }
  return true; // not an address we understand — refuse
}

/** An IPv6 literal as its 16 bytes, or null. Folds in a dotted-quad tail so
 *  every spelling of the same address compares equal. */
function ipv6Bytes(ip) {
  let text = String(ip);
  const dotted = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const q = dotted[1].split(".").map(Number);
    if (q.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    text =
      text.slice(0, text.length - dotted[1].length) +
      (((q[0] << 8) | q[1]) >>> 0).toString(16) + ":" + (((q[2] << 8) | q[3]) >>> 0).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  let groups;
  if (tail === null) {
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 255, n & 255);
  }
  return bytes;
}

/** Cheap syntactic gate: scheme, obviously-local names, literal IPs. Stays
 *  synchronous because callers use it to filter lists of search results. */
function isPublicHttpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  let host = u.hostname.toLowerCase();
  if (host === "" || host === "localhost") return false;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost") || host.endsWith(".home.arpa")) return false;
  // URL normalises IPv6 literals in brackets; strip them to test the address.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (net.isIP(host)) return !isPrivateAddress(host);
  return true;
}

/**
 * The check that actually decides: resolve the name and refuse if ANY answer
 * points somewhere private. Throws with the reason, so refusals are legible
 * in a trace rather than looking like a network failure.
 *
 * Return the checked addresses so the page request can pin its socket to
 * this lookup. A second DNS lookup would reintroduce DNS rebinding.
 */
async function assertPublicTarget(raw, { lookup = dns.lookup } = {}) {
  if (!isPublicHttpUrl(raw)) throw new Error("only public http(s) URLs can be fetched");
  let host = new URL(String(raw)).hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];

  let answers;
  try {
    answers = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`cannot resolve ${host}`);
  }
  if (!answers || !answers.length) throw new Error(`cannot resolve ${host}`);
  for (const a of answers) {
    if (isPrivateAddress(a.address)) {
      throw new Error(`refusing ${host}: it resolves to a private address`);
    }
  }
  return answers.map(a => ({ address: a.address, family: net.isIP(a.address) }));
}

function publicPageRequest(target, { signal, headers, addresses, requestImpl, method = "GET", body: payload } = {}) {
  const url = new URL(target), { Readable } = require("node:stream");
  const request = requestImpl || require(url.protocol === "https:" ? "node:https" : "node:http").request;
  return new Promise((resolve, reject) => {
    const req = request(url, { signal, headers, method, agent: false,
      lookup: (_hostname, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
    }, res => {
      try {
        let body = res;
        const encoding = String(res.headers["content-encoding"] || "identity").toLowerCase();
        if (encoding !== "identity") {
          const z = require("node:zlib");
          const decoders = new Map([["gzip", z.createGunzip], ["deflate", z.createInflate], ["br", z.createBrotliDecompress]]);
          const decoder = decoders.get(encoding);
          if (!decoder) { res.destroy(); reject(new Error("Unsupported page encoding")); return; }
          body = decoder();
          require("node:stream/promises").pipeline(res, body).catch(e => body.destroy(e));
        }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode,
          headers: new Headers(Object.entries(res.headers).filter(([,v]) => v !== undefined).map(([k,v]) => [k, Array.isArray(v) ? v.join(", ") : v])), body: Readable.toWeb(body) });
      } catch (e) { res.destroy(); reject(e); }
    });
    req.on("error", reject); req.end(payload);
  });
}

module.exports = { isPrivateAddress, isPublicHttpUrl, assertPublicTarget, publicPageRequest };
