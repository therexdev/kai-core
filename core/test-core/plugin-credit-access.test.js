"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { PluginCreditAccess, creditBinding } = require("../../electron/plugin-credit-access");
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-access-")), controller = new AbortController();
  const owner = { pluginId: "community.writer", name: "Writer", fingerprint: "a".repeat(64), accountBinding: "b".repeat(64), lifetimeSignal: controller.signal };
  const store = new PluginCreditAccess({ dataDir }), scope = { id: "run-1", name: "Research article" };
  t.after(() => { store.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store, dataDir, owner, scope, controller };
}
test("once and cancellation never grant future credit access", async t => {
  const f = fixture(t);
  const lease = await f.store.acquire(f.owner, f.scope, async () => "once");
  assert.equal(f.store.valid(lease), true); lease.release(); assert.equal(f.store.valid(lease), false);
  assert.equal(f.store.status(f.owner, f.scope).allowed, false);
  await assert.rejects(f.store.acquire(f.owner, f.scope, async () => "cancel"), /cancelled/);
  assert.deepEqual(f.store.list(), []); assert.equal(fs.existsSync(f.store.file), false);
});
test("workflow consent spans steps but is isolated by run, plugin, publisher and account", async t => {
  const f = fixture(t); let reviews = 0;
  const review = async () => { reviews++; return "workflow"; };
  (await f.store.acquire(f.owner, f.scope, review)).release();
  (await f.store.acquire(f.owner, f.scope, review)).release(); assert.equal(reviews, 1);
  for (const owner of [{ ...f.owner, pluginId: "another.writer" }, { ...f.owner, fingerprint: "c".repeat(64) }, { ...f.owner, accountBinding: "d".repeat(64) }]) assert.equal(f.store.status(owner, f.scope).allowed, false);
  assert.equal(f.store.status(f.owner, { ...f.scope, id: "run-2" }).allowed, false);
  f.store.end(f.owner, f.scope.id); assert.equal(f.store.status(f.owner, f.scope).allowed, false);
  (await f.store.acquire(f.owner, f.scope, review)).release(); f.controller.abort();
  assert.equal(f.store.status(f.owner, f.scope).allowed, false);
  assert.equal(new PluginCreditAccess({ dataDir: f.dataDir }).status(f.owner, f.scope).allowed, false);
});
test("always survives restart, stays account-bound, and revokes active requests and queued decisions", async t => {
  const f = fixture(t);
  (await f.store.acquire(f.owner, f.scope, async () => "always")).release();
  const reopened = new PluginCreditAccess({ dataDir: f.dataDir }); t.after(() => reopened.dispose());
  assert.equal(reopened.status(f.owner).duration, "always");
  assert.equal(reopened.status({ ...f.owner, accountBinding: "c".repeat(64) }).allowed, false);
  const lease = await reopened.acquire(f.owner, undefined, async () => assert.fail("must reuse approval"));
  const queued = reopened.acquire(f.owner, f.scope, async () => assert.fail("revoked queue must not reapprove"));
  reopened.revoke(reopened.list()[0].id);
  assert.equal(lease.signal.aborted, true); assert.equal(reopened.valid(lease), false);
  await assert.rejects(queued, /revoked/);
  assert.equal(reopened.status(f.owner).allowed, false);
  assert.deepEqual(new PluginCreditAccess({ dataDir: f.dataDir }).list(), []);
});
test("revocation while the dialog is open cannot save stale approval", async t => {
  const f = fixture(t); let decide;
  (await f.store.acquire(f.owner, undefined, async () => "always")).release(); const id = f.store.list()[0].id; f.store.revoke(id);
  const pending = f.store.acquire(f.owner, f.scope, () => new Promise(resolve => { decide = resolve; }));
  await new Promise(setImmediate); f.store.revoke(id); decide("always");
  await assert.rejects(pending, /revoked/); assert.deepEqual(f.store.list(), []);
});
test("corrupt storage is preserved, and a failed write never grants always access", async t => {
  const f = fixture(t); fs.writeFileSync(f.store.file, "not json");
  assert.throws(() => new PluginCreditAccess({ dataDir: f.dataDir }), /preserved/);
  assert.equal(fs.readFileSync(f.store.file, "utf8"), "not json");
  t.mock.method(f.store, "save", () => { throw Error("disk full"); });
  await assert.rejects(f.store.acquire(f.owner, f.scope, async () => "always"), /disk full/);
  assert.equal(f.store.status(f.owner, f.scope).allowed, false);
});
test("credit binding survives token refresh but changes with account, deployment or access kind", () => {
  const c = { auth: { accountId: "a", owner: "wallet", sessionToken: "secret" }, config: { schedulerUrl: "https://example.test", deployment: { id: "usd" } } };
  const id = creditBinding(c);
  assert.equal(creditBinding({ ...c, auth: { ...c.auth, sessionToken: "new" } }), id);
  for (const changed of [{ ...c, auth: { ...c.auth, accountId: "b" } }, { ...c, auth: { ...c.auth, sessionOnly: true } }, { ...c, config: { ...c.config, deployment: { id: "other" } } }]) assert.notEqual(creditBinding(changed), id);
});
