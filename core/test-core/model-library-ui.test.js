"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { create, presentation, sizeLabel } = require("../../ui-core/models");
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
class Element {
  constructor(document, tag) { this.document = document; this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.hidden = false; this.disabled = false; this.style = { setProperty: (name, value) => { this.attributes[name] = value; } }; this._text = ""; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  set textContent(value) { this._text = value; this.children = []; }
  set innerHTML(_) { throw Error("Model metadata must be inserted as text, not HTML"); }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(child) { this.insertBefore(child, null); }
  insertBefore(child, before) { child.remove(); const index = before ? this.children.indexOf(before) : this.children.length; this.children.splice(index, 0, child); child.parent = this; }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  focus() { this.document.activeElement = this; }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const models = ["small", "medium", "large"].map(alias => ({ alias, label: `${alias} model`, status: "absent", blurb: "A useful description · 1 GB", downloadSizeBytes: 1e9, diskBytes: 0 }));
function fixture() {
  const document = { createElement(tag) { return new Element(this, tag); }, activeElement: null }, container = document.createElement("div");
  let state = { models: structuredClone(models), modelQueue: [], runtime: {} }, handle;
  const calls = [];
  const controller = create({ document, container,
    async request(route, body) { calls.push({ route, body }); return handle?.(route, body); },
    async refresh() { controller.update(state); },
  });
  controller.update(state);
  return { controller, document, container, calls,
    button(alias) { return walk(container).find(node => node.dataset.model === alias); },
    cancel(alias) { return walk(container).find(node => node.dataset.cancelModel === alias); },
    card(alias) { return container.children.find(node => node.dataset.modelCard === alias); },
    update(changes) { state = { ...state, ...changes }; controller.update(state); },
    request(fn) { handle = fn; },
  };
}
test("progress stays in its card with stable controls and focus while unrelated models remain selectable", () => {
  const f = fixture(), first = f.card("small"), button = f.button("small"), cancel = f.cancel("small"), other = f.button("medium");
  f.update({ modelQueue: [{ alias: "small", state: "downloading", pct: 5, cancellable: true }, { alias: "medium", state: "queued", position: 1, cancellable: true }] });
  cancel.focus();
  f.update({ modelQueue: [{ alias: "small", state: "downloading", pct: 48.6, cancellable: true }, { alias: "medium", state: "queued", position: 1, cancellable: true }] });
  assert.equal(f.card("small"), first); assert.equal(f.button("small"), button); assert.equal(f.cancel("small"), cancel); assert.equal(f.document.activeElement, cancel);
  assert.equal(button.textContent, "Downloading 49%"); assert.equal(button.disabled, true); assert.equal(cancel.hidden, false);
  assert.equal(f.button("medium"), other); assert.equal(other.textContent, "Queued"); assert.equal(other.title, "Queue position 1");
  assert.equal(f.button("large").disabled, false); assert.equal(f.button("large").textContent, "Download & load");
});
test("preparation and completion clear download percentages and all finished cancel controls", () => {
  const f = fixture();
  f.update({ modelQueue: [{ alias: "small", state: "downloading", pct: 100, cancellable: true }] }); f.cancel("small").focus();
  f.update({ modelQueue: [{ alias: "small", state: "preparing", pct: 100, cancellable: false }] });
  assert.equal(f.button("small").textContent, "Preparing…"); assert.equal(f.cancel("small").hidden, true);
  f.update({ models: models.map(model => ({ ...model, status: "ready", diskBytes: 1e9 })), runtime: { activeAlias: "small" }, modelQueue: [{ alias: "small", state: "done", cancellable: false }] });
  assert.equal(f.button("small").textContent, "Load model"); assert.equal(f.button("small").disabled, false);
  for (const model of models) assert.equal(f.cancel(model.alias).hidden, true);
  assert.match(f.card("small").textContent, /Loaded/); assert.equal(f.document.activeElement, f.button("small"));
});
test("rapid clicks queue different models independently and suppress duplicate requests for the same card", async () => {
  const f = fixture(), a = deferred(), b = deferred(); f.request((_, { alias }) => alias === "small" ? a.promise : b.promise);
  f.button("small").onclick(); f.button("small").onclick(); f.button("medium").onclick();
  assert.deepEqual(f.calls.map(call => call.body.alias), ["small", "medium"]);
  assert.equal(f.button("small").textContent, "Queued"); assert.equal(f.button("medium").textContent, "Queued"); assert.equal(f.button("large").disabled, false);
  f.update({ modelQueue: [{ alias: "small", state: "downloading", pct: 1, cancellable: true }, { alias: "medium", state: "queued", position: 1, cancellable: true }] });
  a.resolve(); b.resolve(); await flush();
  assert.equal(f.button("small").textContent, "Downloading 1%"); assert.equal(f.button("medium").textContent, "Queued");
});
test("queued and active cancellations send only the selected alias and can be retried after cancellation", async () => {
  const f = fixture();
  f.update({ modelQueue: [{ alias: "small", state: "downloading", pct: 7, cancellable: true }, { alias: "medium", state: "queued", position: 1, cancellable: true }] });
  assert.match(f.cancel("medium").attributes["aria-label"], /Remove from queue · medium model/);
  await f.controller.perform("medium", "cancel");
  assert.deepEqual(f.calls[0], { route: "/core/models/download/cancel", body: { alias: "medium" } });
  f.update({ modelQueue: [{ alias: "small", state: "downloading", pct: 7, cancellable: true }, { alias: "medium", state: "cancelled", cancellable: false }] });
  assert.equal(f.cancel("medium").hidden, true); assert.equal(f.button("medium").disabled, false);
  await f.controller.perform("small", "cancel"); assert.equal(f.calls[1].body.alias, "small");
  await f.controller.perform("medium", "enqueue"); assert.equal(f.calls[2].route, "/core/models/ensure");
});
test("errors and retry controls belong to the affected card without blocking other downloads", async () => {
  const f = fixture(); f.request(() => { throw Error("Not enough disk space"); });
  await f.controller.perform("small", "enqueue");
  assert.match(f.card("small").textContent, /Not enough disk space/); assert.equal(f.button("small").textContent, "Retry download");
  assert.doesNotMatch(f.card("medium").textContent, /Not enough/); assert.equal(f.button("medium").disabled, false);
  f.request(() => {}); await f.controller.perform("small", "enqueue"); assert.doesNotMatch(f.card("small").textContent, /Not enough/);
  f.update({ models: models.map(model => ({ ...model, status: "ready" })), modelQueue: [{ alias: "medium", state: "error", error: "Engine unavailable" }] });
  assert.equal(f.button("medium").textContent, "Retry load"); assert.equal(f.cancel("medium").hidden, true); assert.match(f.card("medium").textContent, /Engine unavailable/);
});
test("unknown progress is not displayed as zero and progress from old terminal jobs stays hidden", () => {
  assert.equal(presentation(models[0], { state: "downloading", pct: null }).label, "Downloading…");
  assert.equal(presentation(models[0], { state: "downloading", pct: Number.NaN }).pct, null);
  assert.equal(presentation(models[0], { state: "downloading", pct: 201 }).pct, 100);
  const done = presentation({ ...models[0], status: "ready" }, { state: "done", pct: 100, cancellable: true });
  assert.equal(done.label, "Load model"); assert.equal(done.cancel, false); assert.equal(done.pct, null);
});
test("model metadata stays literal text and card updates retain size and full descriptions", () => {
  const f = fixture(); f.update({ models: [{ ...models[0], label: "<img onerror=alert(1)>", blurb: "<script> · 1 GB", status: "ready", diskBytes: 1.1e9 }] });
  assert.equal(f.container.children.length, 1); assert.match(f.card("small").textContent, /<img onerror=alert\(1\)>/);
  assert.match(f.card("small").textContent, /<script>/); assert.match(f.card("small").textContent, /1\.1 GB on disk/);
  assert.equal(sizeLabel({ status: "absent", downloadSizeBytes: 1.1e9, diskBytes: 0 }), "1.1 GB download");
  assert.equal(sizeLabel({ status: "ready", downloadSizeBytes: null, diskBytes: null }), "Size unavailable");
});

test("preparation shows the actual engine stage and offers cancellation without a stale completed progress bar", () => {
  const f = fixture();
  for (const [stage, expected] of [["waiting", "Waiting for model…"], ["engine-download", "Engine 42%"], ["verifying", "Checking 42%"], ["verifying-engine", "Checking engine…"], ["extracting", "Setting up engine…"], ["testing", "Checking engine…"], ["starting", "Loading model…"]]) {
    f.update({ modelQueue: [{ alias: "small", state: "preparing", stage, pct: 42, cancellable: true }] });
    assert.equal(f.button("small").textContent, expected); assert.equal(f.cancel("small").hidden, false);
  }
  assert.match(f.card("small").textContent, /Loading weights into memory/);
  f.update({ modelQueue: [{ alias: "small", state: "preparing", stage: "waiting", cancellable: true }] });
  assert.match(f.card("small").textContent, /current local task/);
  f.update({ modelQueue: [{ alias: "small", state: "preparing", stage: "waiting", cancelling: true, cancellable: false }] });
  assert.equal(f.button("small").textContent, "Cancelling…"); assert.equal(f.cancel("small").hidden, true);
  f.update({ modelQueue: [{ alias: "small", state: "cancelled", stage: "engine-download", pct: 42, cancellable: false }] });
  assert.equal(f.button("small").disabled, false); assert.equal(f.button("small").textContent, "Download & load");
  assert.equal(presentation(models[0], { state: "done", stage: "engine-download", pct: 42 }).pct, null);
});
