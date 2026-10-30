"use strict";

/*
 * The web-fetch guard must judge the DESTINATION, not the spelling.
 *
 * Both of these fail on the string-only check: a name that resolves to
 * 127.0.0.1 is an ordinary DNS record, and a redirect from a public page to
 * 169.254.169.254 was followed by fetch itself, below the guard entirely.
 * Either one turns "summarise this page for me" — a sentence a model will
 * happily take from a web page it just read — into a read of the LAN.
 */

const { test } = require("node:test");
const assert = require("node:assert");

const { isPublicHttpUrl, isPrivateAddress, assertPublicTarget } = require("../lib/public-http");

/** Stand-in resolver: whatever the test says the name answers with. */
const resolver = (map) => async (host) => {
  if (!(host in map)) throw new Error("NXDOMAIN");
  return map[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

test("literal addresses everywhere private are refused", () => {
  for (const u of [
    "http://127.0.0.1/", "http://127.1/", "http://2130706433/", "http://0x7f000001/",
    "http://10.0.0.1/", "http://172.16.0.1/", "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/", // cloud metadata, the classic prize
    "http://100.64.0.1/", "http://198.18.0.1/", "http://255.255.255.255/",
    "http://[::1]/", "http://[fd00::1]/", "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/", "http://[2002:7f00:0001::]/", // v4 in a v6 hat
    "http://localhost/", "http://thing.local/", "http://box.internal/",
    "file:///etc/passwd", "gopher://x/", "http:///",
  ]) {
    assert.strictEqual(isPublicHttpUrl(u), false, `${u} should be refused`);
  }
});

test("ordinary public URLs still pass", () => {
  for (const u of ["https://example.com/a?b=c", "http://93.184.216.34/", "https://en.wikipedia.org/wiki/Mana"]) {
    assert.strictEqual(isPublicHttpUrl(u), true, `${u} should be allowed`);
  }
  assert.strictEqual(isPrivateAddress("93.184.216.34"), false);
  assert.strictEqual(isPrivateAddress("2606:2800:220:1::1"), false);
});

test("a public NAME that resolves somewhere private is refused", async () => {
  const lookup = resolver({
    "evil.example": ["127.0.0.1"],
    "metadata.example": ["169.254.169.254"],
    "split.example": ["93.184.216.34", "10.0.0.5"], // one good answer is not enough
    "fine.example": ["93.184.216.34"],
  });
  await assert.rejects(() => assertPublicTarget("http://evil.example/", { lookup }), /private address/);
  await assert.rejects(() => assertPublicTarget("http://metadata.example/", { lookup }), /private address/);
  await assert.rejects(() => assertPublicTarget("http://split.example/", { lookup }), /private address/,
    "every answer has to be public — a resolver can return both");
  await assertPublicTarget("http://fine.example/", { lookup }); // resolves clean, no throw
  await assert.rejects(() => assertPublicTarget("http://nowhere.example/", { lookup }), /cannot resolve/);
});

