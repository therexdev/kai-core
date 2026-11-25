"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const Limits = require("../lib/koin-network/purchase-limits"), Q = require("../lib/koin-network/purchase-quote");
test("the USD purchase ceiling includes $1,000 with native rounding at changing prices", () => {
  for (const rate of ["1", "1999999", "3700000", "25000000", "100000000", "333333333"]) {
    for (const dollars of ["0.01", "10", "40", "999.99", "1000", "1000.00"]) {
      Limits.assertDollars(dollars);
      Limits.assertNative(Q.nativeForDollars(dollars, rate), rate);
    }
    const limit = Limits.limits(rate);
    assert.ok(BigInt(limit.maxPurchaseUsdAtoms) >= 1000n * Q.USD_ATOMS);
    assert.ok(BigInt(limit.maxPurchaseUsdAtoms) < 1000n * Q.USD_ATOMS + 4n);
    assert.throws(() => Limits.assertNative(String(BigInt(limit.maxPurchaseKoinAtoms) + 1n), rate), { code: "PURCHASE_LIMIT_EXCEEDED" });
  }
  for (const dollars of ["1000.01", "1001", "10000"]) assert.throws(() => Limits.assertDollars(dollars), { code: "PURCHASE_LIMIT_EXCEEDED" });
  for (const invalid of ["0", "-1", "1e3", "1,000", "NaN", "0.001", 1000]) assert.throws(() => Limits.assertDollars(invalid));
});
