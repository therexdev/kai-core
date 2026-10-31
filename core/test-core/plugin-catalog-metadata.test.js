"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { installedCatalogMetadata } = require("../../electron/core-plugin-catalog");
const fingerprint = "a".repeat(64);
const plugin = { id: "community.notes", name: "Notes", fingerprint, version: "1.0.0", enabled: true };
const entry = { id: plugin.id, fingerprint, repository: "some-dev/notes.plugin", description: "Private notes", version: "1.1.0" };

test("installed cards use catalog attribution only for the same publisher and plugin", () => {
  const result = installedCatalogMetadata([plugin], [entry]);
  assert.deepEqual(result, [{ ...plugin, repository: entry.repository, description: entry.description }]);
  assert.equal(result[0].version, "1.0.0", "catalog attribution must not replace installed version");
  assert.equal(Object.hasOwn(plugin, "repository"), false, "display metadata must not mutate installation state");
  for (const changed of [{ ...entry, fingerprint: "b".repeat(64) }, { ...entry, id: "other.notes" }])
    assert.deepEqual(installedCatalogMetadata([plugin], [changed]), [plugin]);
  for (const value of [undefined, "", "invalid"])
    assert.deepEqual(installedCatalogMetadata([{ ...plugin, fingerprint: value }], [{ ...entry, fingerprint: value }]), [{ ...plugin, fingerprint: value }]);
});

test("bundled attribution works offline, without inventing a developer for unlisted packages", () => {
  assert.equal(installedCatalogMetadata([plugin], [], [entry])[0].repository, entry.repository);
  assert.deepEqual(installedCatalogMetadata([plugin], [], [{ ...entry, fingerprint: "b".repeat(64) }]), [plugin]);
  assert.deepEqual(installedCatalogMetadata([plugin], []), [plugin]);
  assert.equal(installedCatalogMetadata([plugin], [{ ...entry, repository: "new-owner/notes" }], [entry])[0].repository, "new-owner/notes");
});

test("repository metadata cannot introduce arbitrary URLs, credentials or traversal", () => {
  for (const repository of ["https://github.com/dev/repo", "https://evil.test", "dev/repo?next=evil", "dev/repo#fragment", "dev/repo/extra", "dev/..", "dev/.", "dev\\repo", "dev/repo\n", "dev@github.com/repo", "dev/%2e%2e", "dev/<img>", null]) {
    assert.deepEqual(installedCatalogMetadata([plugin], [{ ...entry, repository }]), [plugin], String(repository));
  }
});
